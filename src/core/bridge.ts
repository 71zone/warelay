import { setTimeout as sleep } from 'node:timers/promises';
import { AllProvidersLimitedError, NotSentError, type Assistant, type IncomingMessage, type Logger, type MessagingAdapter, type ProviderId } from './contracts.js';
import { providerName } from './providers.js';
import type { RoutingState } from './state.js';

/** User-facing name of the messaging provider used in log lines and route errors; assistant names come from the provider that handled the message. */
export interface ProviderNames { channelName: string }

/** How long one message keeps being retried while its provider provably has not received it (ChatGPT not ready, WhatsApp offline). */
const RETRY_WINDOW_MS = 30 * 60_000;
const MAX_RETRY_DELAY_MS = 30_000;

function describe(error: unknown): string { return error instanceof Error ? error.message : String(error); }

/** One short line for the contact: internal advice after the first sentence ("Inspect the saved conversation...") means nothing to them. */
function failureNotice(assistantName: string, replied: boolean, detail: string): string {
  const reason = (detail.match(/^.*?[.!?](?=\s|$)/s)?.[0] ?? detail).replace(/\s+/g, ' ').trim().replace(/[.!?]+$/, '').slice(0, 160);
  return replied
    ? `${assistantName} replied, but I could not deliver it: ${reason}. Please ask again.`
    : `${assistantName} did not return a reply: ${reason}. Please ask again.`;
}

export class Bridge {
  private queue: Promise<void> = Promise.resolve();
  private armed = false;
  private readonly pendingReceipts = new Set<Promise<void>>();
  constructor(private readonly store: RoutingState, private readonly assistant: Assistant, private readonly channel: MessagingAdapter, private readonly logger: Logger, private readonly names: ProviderNames) {}
  arm(): void { this.armed = true; }
  disarm(): void { this.armed = false; }
  isArmed(): boolean { return this.armed; }
  async idle(): Promise<void> {
    await this.queue;
    await Promise.allSettled([...this.pendingReceipts]);
  }
  receive(message: IncomingMessage): void {
    if (!this.armed || !this.store.route(message.contact.id)?.enabled) return;
    if (!message.text.trim() && message.attachments.length === 0) return;
    this.queue = this.queue.then(() => this.forward(message)).catch(error => {
      this.disarm();
      this.logger(`Bridge stopped forwarding: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
  private async forward(message: IncomingMessage): Promise<void> {
    const { channelName } = this.names;
    const contactId = message.contact.id;
    if (!this.armed || !this.store.route(contactId)?.enabled) return;
    const key = `${contactId}:${message.id}`;
    if (!await this.store.claim(key, contactId)) return;
    const route = await this.store.refreshConversation(contactId);
    if (!this.armed || !route?.enabled) { await this.store.finish(key, contactId, 'failed'); return; }
    const started = performance.now();
    let accepted = false;
    let replied = false;
    // The assistant that most recently took the message; until one does, the primary.
    let provider: ProviderId | null = null;
    const nameOf = (): string => providerName(provider ?? this.store.settings().providers[0] ?? '');
    try {
      this.logger(`Forwarding a message from ${route.name}.`);
      const response = await this.retryUnsent(route.name, () => nameOf(), () => this.assistant.reply({
        refs: route.refs,
        history: this.store.turns(contactId),
        text: message.text,
        attachments: message.attachments,
        onProvider: next => { provider = next; },
        onConversation: (next, ref) => this.store.conversation(contactId, next, ref),
        onSubmitted: async submittedBy => {
          accepted = true;
          provider = submittedBy;
          await this.remember(contactId, { role: 'user', provider: submittedBy, text: message.text || '[attachment]' });
          const receiptStarted = performance.now();
          this.logger(`${nameOf()} accepted the message from ${route.name} after ${Math.round(receiptStarted - started)}ms; sending ${channelName} read receipt.`);
          const receipt = (async () => {
            try {
              await message.acknowledge();
              this.logger(`${channelName} read receipt sent for ${route.name} in ${Math.round(performance.now() - receiptStarted)}ms.`);
            } catch (error) {
              this.logger(`${channelName} read receipt failed for ${route.name}: ${error instanceof Error ? error.message : String(error)}`);
            }
          })();
          this.pendingReceipts.add(receipt);
          void receipt.then(() => this.pendingReceipts.delete(receipt), () => this.pendingReceipts.delete(receipt));
        },
      }), () => this.assistant.start());
      replied = true;
      provider = response.provider;
      const assistantName = nameOf();
      this.logger(`${assistantName} reply ready for ${route.name} after ${Math.round(performance.now() - started)}ms.`);
      await this.store.conversation(contactId, response.provider, response.conversationRef);
      const blocks = response.blocks ?? [{ type: 'markdown' as const, text: response.text }];
      if (!response.text.trim() && !blocks.some(block => block.type === 'attachment')) throw new Error(`${assistantName} returned an empty response.`);
      await this.remember(contactId, { role: 'assistant', provider: response.provider, text: response.text });
      if (!this.armed || !this.store.route(contactId)?.enabled) throw new Error(`Forwarding paused before reply delivery. Response remains in ${assistantName}.`);
      const sendStarted = performance.now();
      this.logger(`Sending ${channelName} reply to ${route.name}.`);
      await this.retryUnsent(route.name, () => channelName, () => this.channel.sendReply(contactId, blocks));
      await this.store.finish(key, contactId, 'done');
      this.logger(`Reply sent to ${route.name}; ${channelName} send ${Math.round(performance.now() - sendStarted)}ms, total ${Math.round(performance.now() - started)}ms.`);
    } catch (error) {
      const detail = describe(error);
      const assistantName = nameOf();
      await this.store.finish(key, contactId, 'failed');
      if (error instanceof AllProvidersLimitedError) {
        // Nothing was sent anywhere, but the session itself is healthy: tell the contact once, never replay, keep it enabled.
        this.logger(`${detail} The message from ${route.name} was not sent and will not be replayed; ${route.name} stays enabled.`);
        await this.tellContact(contactId, route.name, detail);
        return;
      }
      if (accepted) {
        // The prompt is already in the assistant, so replaying it could duplicate it, but the session itself is healthy: later messages still flow.
        this.logger(`No reply was delivered to ${route.name}: ${detail} The ${assistantName} conversation may still hold the answer; the message was not replayed and ${route.name} stays enabled.`);
        await this.tellContact(contactId, route.name, failureNotice(assistantName, replied, detail));
        return;
      }
      await this.store.pause(contactId, detail);
      this.logger(`Paused ${route.name}: ${detail} Inspect ${channelName} and ${assistantName} before enabling again. No automatic replay.`);
    }
  }
  /** Keeps a turn for provider handoff. A log that cannot be written never fails a message. */
  private async remember(contactId: string, turn: Parameters<RoutingState['recordTurn']>[1]): Promise<void> {
    try { await this.store.recordTurn(contactId, turn); }
    catch (error) { this.logger(`Could not save the recent conversation for handoff: ${describe(error)}`); }
  }
  /**
   * Tells the contact, once, that their message got no answer. Not retried (a retry loop would repeat the notice) and never for a deliberate pause. Its own failure
   * is only logged: the original failure is already recorded and later messages must still flow.
   */
  private async tellContact(contactId: string, name: string, text: string): Promise<void> {
    if (!this.armed || !this.store.route(contactId)?.enabled) return;
    try { await this.channel.sendReply(contactId, [{ type: 'markdown', text }]); }
    catch (error) { this.logger(`Could not tell ${name} that no reply is coming: ${describe(error)}`); }
  }
  /**
   * Runs `operation`, repeating it while it fails with NotSentError (the provider provably never got the message), backing off up to 30s and
   * running `repair` between attempts. Any other failure, a disarmed bridge or an expired retry window ends the loop with the last error.
   */
  private async retryUnsent<T>(contact: string, provider: () => string, operation: () => Promise<T>, repair?: () => Promise<void>): Promise<T> {
    const began = Date.now();
    for (let attempt = 1; ; attempt++) {
      try { return await operation(); }
      catch (error) {
        if (!(error instanceof NotSentError) || !this.armed || Date.now() - began >= RETRY_WINDOW_MS) throw error;
        if (attempt === 1 || attempt % 5 === 0) this.logger(`${provider()} is not ready (${describe(error)}); retrying the message for ${contact} on its own. Nothing was sent yet.`);
        await sleep(Math.min(2000 * 2 ** (attempt - 1), MAX_RETRY_DELAY_MS));
        if (repair) {
          try { await repair(); }
          catch (repairError) { if (attempt === 1 || attempt % 5 === 0) this.logger(`${provider()} repair attempt failed: ${describe(repairError)}`); }
        }
      }
    }
  }
}
