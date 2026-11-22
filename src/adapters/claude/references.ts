import type { AssistantReferencePolicy } from '../../core/contracts.js';
import type { Destination } from '../browseros/assistant.js';

// Claude's reference format is its canonical URL: a project ref is https://claude.ai/project/<uuid>, a conversation ref is https://claude.ai/chat/<uuid>.
// A chat inside a project lives at /chat/<uuid> like any other (observed live: the project page lists its chats as /chat/<uuid> links), so the URL carries
// no project scope and a conversation is accepted with or without a project.
const origin = 'https://claude.ai';
const uuid = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const projectPath = new RegExp(`^/project/(${uuid})/?$`);
const conversationPath = new RegExp(`^/chat/(${uuid})/?$`);

function claudeUrl(value: string, label: string): URL {
  const text = value.trim();
  if (/[\s\u0000-\u001f\u007f]/.test(text)) throw new Error(`${label} must be a single https://claude.ai URL.`);
  let url: URL;
  try { url = new URL(text); } catch { throw new Error(`${label} must be an https://claude.ai URL.`); }
  if (url.protocol !== 'https:' || url.hostname !== 'claude.ai' || url.port || url.username || url.password) throw new Error(`${label} must be an https://claude.ai URL without credentials.`);
  return url;
}

/** Canonicalizes a Claude project URL to https://claude.ai/project/<uuid>; throws on anything else. */
export function normalizeProjectUrl(value: string): string {
  const match = projectPath.exec(claudeUrl(value, 'Project URL').pathname);
  if (!match?.[1]) throw new Error('Project URL must look like https://claude.ai/project/<uuid>.');
  return `${origin}/project/${match[1].toLowerCase()}`;
}

/** Canonicalizes a Claude conversation URL to https://claude.ai/chat/<uuid> (query and hash dropped). `projectUrl`, when given, must itself be a valid project URL. */
export function normalizeConversationUrl(value: string, projectUrl: string | null): string {
  if (projectUrl !== null) normalizeProjectUrl(projectUrl);
  const match = conversationPath.exec(claudeUrl(value, 'Conversation URL').pathname);
  if (!match?.[1]) throw new Error('Conversation URL must look like https://claude.ai/chat/<uuid>.');
  return `${origin}/chat/${match[1].toLowerCase()}`;
}

/** Pathname regex source a page must satisfy to count as the destination of a normalized target. */
export function destinationPathPattern(destination: Destination): string {
  const { conversationUrl, projectUrl } = destination;
  const id = (url: string, path: RegExp): string => {
    const match = path.exec(new URL(url).pathname);
    if (!match?.[1]) throw new Error('Invalid Claude URL.');
    return match[1].toLowerCase();
  };
  if (conversationUrl) return `^/chat/${id(conversationUrl, conversationPath)}/?$`;
  if (projectUrl) return `^/project/${id(projectUrl, projectPath)}/?$`;
  return '^/new/?$';
}

/** True when `url` is the saved conversation, the project page, or Claude's new-chat page, per `destination`. */
export function isDestination(url: string, destination: Destination): boolean {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return false; }
  return parsed.origin === origin && new RegExp(destinationPathPattern(destination), 'i').test(parsed.pathname);
}

/** True when `url` is a Claude conversation page. */
export function isConversationPage(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.origin === origin && conversationPath.test(parsed.pathname);
  } catch { return false; }
}

/** Reference validation the core applies to persisted and user-supplied project and conversation references. */
export const claudeReferences: AssistantReferencePolicy = {
  normalizeProject: normalizeProjectUrl,
  normalizeConversation: normalizeConversationUrl,
};
