import type { AssistantAdapter, Logger } from '../../core/contracts.js';
import type { MediaStore } from '../../infrastructure/media.js';
import { createBrowserAssistant, type AssistantDriver } from '../browseros/assistant.js';
import { chatgptInspectionScript, composerAttachmentsScript, composerReady, revealLatestTurnScript, settleScript, submitScript, uploadScript } from './dom.js';
import { chatgptExtractionScript } from './extract.js';
import { readProjectCatalog } from './projects.js';
import { chatgptReferences, destinationPathPattern, isConversationPage, isDestination } from './references.js';

const driver: AssistantDriver = {
  id: 'chatgpt',
  name: 'ChatGPT',
  home: () => 'https://chatgpt.com/',
  references: chatgptReferences,
  composerReady,
  settle: settleScript,
  destinationPathPattern,
  isDestination,
  isConversationPage,
  inspectionScript: chatgptInspectionScript,
  revealScript: revealLatestTurnScript,
  extractionScript: chatgptExtractionScript,
  composerAttachmentsScript,
  uploadScript,
  submitScript,
  readProjects: readProjectCatalog,
};

/**
 * ChatGPT through BrowserOS Neo. A conversation or project reference is its canonical https://chatgpt.com URL, so refs map to the pages the tab visits without translation.
 * One delivery tab lives in one app-owned tab group; project listing uses its own MCP client and scratch tab and never touches delivery state.
 */
export function createChatGPT(options: { endpoint: string; logger: Logger; media: MediaStore }): AssistantAdapter {
  return createBrowserAssistant(driver, options);
}
