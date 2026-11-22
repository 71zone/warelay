import type { AssistantAdapter, Logger } from '../../core/contracts.js';
import type { MediaStore } from '../../infrastructure/media.js';
import { createBrowserAssistant, type AssistantDriver } from '../browseros/assistant.js';
import { claudeInspectionScript, composerAttachmentsScript, composerReady, revealLatestTurnScript, settleScript, submitScript, uploadScript } from './dom.js';
import { claudeExtractionScript } from './extract.js';
import { readProjectCatalog } from './projects.js';
import { claudeReferences, destinationPathPattern, isConversationPage, isDestination } from './references.js';

const driver: AssistantDriver = {
  id: 'claude',
  name: 'Claude',
  home: () => 'https://claude.ai/new',
  references: claudeReferences,
  composerReady,
  settle: settleScript,
  destinationPathPattern,
  isDestination,
  isConversationPage,
  inspectionScript: claudeInspectionScript,
  revealScript: revealLatestTurnScript,
  extractionScript: claudeExtractionScript,
  composerAttachmentsScript,
  uploadScript,
  submitScript,
  readProjects: readProjectCatalog,
};

/**
 * Claude (claude.ai) through BrowserOS Neo. A conversation or project reference is its canonical https://claude.ai URL (/chat/<uuid>, /project/<uuid>), so refs
 * map to the pages the tab visits without translation. One delivery tab lives in the app-owned tab group; project listing uses its own MCP client and scratch tab.
 */
export function createClaude(options: { endpoint: string; logger: Logger; media: MediaStore }): AssistantAdapter {
  return createBrowserAssistant(driver, options);
}
