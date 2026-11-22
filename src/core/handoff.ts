import type { ProviderId, Turn } from './contracts.js';

/** Most turns, most characters and oldest age that a handoff carries into the next provider's prompt. */
export const HANDOFF_MAX_TURNS = 8;
export const HANDOFF_MAX_CHARS = 6000;
export const HANDOFF_FRESH_MS = 24 * 60 * 60_000;

function line(turn: Turn, budget: number): string {
  const text = turn.text.length > budget ? `${turn.text.slice(0, Math.max(0, budget - 1))}…` : turn.text;
  return `${turn.role === 'user' ? 'User' : 'Assistant'}: ${text}`;
}

/**
 * The prompt to send to `provider`. When another provider's conversation with this contact is under way, the turns `provider` has not seen (all recent turns when it
 * starts a new conversation, only those after its own last turn when it continues one) go first as a clearly framed transcript, then the new message. Otherwise just `text`.
 * `history` is oldest first; `conversations` says whether any provider currently holds a saved conversation for the contact (a finished or expired chat hands nothing over).
 */
export function handoffPrompt(input: { provider: ProviderId; history: readonly Turn[]; continuing: boolean; conversations: boolean; text: string; now: number }): string {
  const { provider, history, continuing, conversations, text, now } = input;
  const fresh = history.filter(turn => now - turn.at <= HANDOFF_FRESH_MS);
  const lastOwn = fresh.findLastIndex(turn => turn.provider === provider);
  const unseen = continuing && lastOwn >= 0 ? fresh.slice(lastOwn + 1) : fresh;
  if (!conversations || unseen.length === 0) return text;
  const lines: string[] = [];
  let used = 0;
  for (const turn of unseen.slice(-HANDOFF_MAX_TURNS).reverse()) {
    const next = line(turn, HANDOFF_MAX_CHARS - used);
    if (lines.length > 0 && used + next.length > HANDOFF_MAX_CHARS) break;
    lines.push(next); used += next.length;
  }
  const transcript = lines.reverse().join('\n');
  return `Earlier conversation, continue from it (context only; do not repeat or mention it):\n${transcript}\n\nNew message from the user:\n${text || '(an attachment, no text)'}`;
}
