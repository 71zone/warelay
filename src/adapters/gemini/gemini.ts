import type { AssistantAdapter, Logger, ProviderOptions } from '../../core/contracts.js';
import { providerOption } from '../../core/providers.js';
import type { MediaStore } from '../../infrastructure/media.js';
import { createBrowserAssistant, type AssistantDriver } from '../browseros/assistant.js';
import { composerAttachmentsScript, composerReady, geminiInspectionScript, identityScript, revealLatestTurnScript, settleScript, submitScript, uploadScript } from './dom.js';
import { geminiExtractionScript } from './extract.js';
import { accountOf, destinationPathPattern, geminiReferences, isConversationPage, isDestination, misplacedReason, newChatUrl } from './references.js';

/**
 * Gemini (gemini.google.com) through BrowserOS Neo. Every reference carries the Google account index in its path (/u/<N>/app[/<id>]), and the account in use is
 * the `account` provider option, read on every use because it can change while the app runs. Gemini has no projects the app drives, so the project catalog is
 * always an empty, complete list.
 *
 * A saved conversation that belongs to another account than the configured one is never opened or failed on: the message starts a new chat in the configured
 * account and the new reference replaces the saved one. Before anything is sent the page must be on the configured account; otherwise (Google opened another
 * account or its sign-in) the prompt is not sent and the error says so. The signed-in email is read from the page and logged.
 */
export function createGemini(options: { endpoint: string; logger: Logger; media: MediaStore; options: () => ProviderOptions }): AssistantAdapter {
  const account = (): string => providerOption(options.options(), 'gemini', 'account');
  const driver: AssistantDriver = {
    id: 'gemini',
    name: 'Gemini',
    home: () => newChatUrl(account()),
    references: geminiReferences,
    composerReady,
    settle: settleScript,
    destinationPathPattern: destination => destinationPathPattern(destination, account()),
    isDestination: (url, destination) => isDestination(url, destination, account()),
    isConversationPage,
    inspectionScript: geminiInspectionScript,
    revealScript: revealLatestTurnScript,
    extractionScript: geminiExtractionScript,
    composerAttachmentsScript,
    uploadScript,
    submitScript,
    misplaced: url => misplacedReason(url, account()),
    identityScript,
    readProjects: async () => [],
  };
  const adapter = createBrowserAssistant(driver, options);
  return {
    ...adapter,
    // No browser is needed to answer: Gemini's Gems are not part of this app, and an empty catalog is a complete one.
    listProjects: async () => [],
    reply(input) {
      const saved = input.conversationRef === null ? null : accountOf(input.conversationRef);
      const configured = String(Number(account()));
      if (saved !== null && saved !== configured) {
        options.logger(`The saved Gemini conversation belongs to account /u/${saved}, but account /u/${configured} is configured; starting a new chat.`);
        return adapter.reply({ ...input, conversationRef: null, projectRef: null });
      }
      return adapter.reply({ ...input, projectRef: null });
    },
  };
}
