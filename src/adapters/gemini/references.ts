import type { AssistantReferencePolicy } from '../../core/contracts.js';
import type { Destination } from '../browseros/assistant.js';

// Gemini's reference format is its canonical URL with the Google account index in the path: a new chat is https://gemini.google.com/u/<N>/app and a
// conversation is https://gemini.google.com/u/<N>/app/<id> (observed live: a 16-character hex id, assigned once the first reply starts streaming).
// A conversation ref of ANY account is valid, so saved state stays loadable after the configured account changes; whether it may be opened is the
// adapter's decision (see accountOf). Gemini has no project concept the app drives, so no project reference is valid.
const origin = 'https://gemini.google.com';
const accountPrefix = '/u/(\\d{1,2})';
const conversationPath = new RegExp(`^${accountPrefix}/app/([A-Za-z0-9_-]{8,64})/?$`);
const newChatPath = new RegExp(`^${accountPrefix}/app/?$`);

function geminiUrl(value: string, label: string): URL {
  const text = value.trim();
  if (/[\s\u0000-\u001f\u007f]/.test(text)) throw new Error(`${label} must be a single https://gemini.google.com URL.`);
  let url: URL;
  try { url = new URL(text); } catch { throw new Error(`${label} must be an https://gemini.google.com URL.`); }
  if (url.protocol !== 'https:' || url.hostname !== 'gemini.google.com' || url.port || url.username || url.password) throw new Error(`${label} must be an https://gemini.google.com URL without credentials.`);
  return url;
}

/** The account index in a Gemini URL's /u/<N>/ path as a canonical decimal string, or null when the value is not a Gemini URL with one. */
export function accountOf(value: string): string | null {
  try {
    const url = new URL(value.trim());
    const match = url.origin === origin ? /^\/u\/(\d{1,2})(?:\/|$)/.exec(url.pathname) : null;
    return match?.[1] === undefined ? null : String(Number(match[1]));
  } catch { return null; }
}

/** The new-chat page of account `account` (the index as entered in the settings). */
export function newChatUrl(account: string): string { return `${origin}/u/${Number(account)}/app`; }

/** Gemini has no projects. */
export function normalizeProjectUrl(): never { throw new Error('Gemini has no projects.'); }

/** Canonicalizes a Gemini conversation URL to https://gemini.google.com/u/<N>/app/<id> (query and hash dropped); throws on anything else. */
export function normalizeConversationUrl(value: string, projectUrl: string | null): string {
  if (projectUrl !== null) normalizeProjectUrl();
  const match = conversationPath.exec(geminiUrl(value, 'Conversation URL').pathname);
  if (!match?.[1] || !match[2]) throw new Error('Conversation URL must look like https://gemini.google.com/u/<N>/app/<id>.');
  return `${origin}/u/${Number(match[1])}/app/${match[2]}`;
}

/** Pathname regex source a page must satisfy to count as the destination of a normalized target while account `account` is configured. */
export function destinationPathPattern(destination: Destination, account: string): string {
  const prefix = `^/u/${Number(account)}/app`;
  if (!destination.conversationUrl) return `${prefix}/?$`;
  const match = conversationPath.exec(new URL(destination.conversationUrl).pathname);
  if (!match?.[2]) throw new Error('Invalid Gemini conversation URL.');
  return `${prefix}/${match[2]}/?$`;
}

/** True when `url` is the saved conversation or the new-chat page, per `destination`, on account `account`. */
export function isDestination(url: string, destination: Destination, account: string): boolean {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return false; }
  return parsed.origin === origin && new RegExp(destinationPathPattern(destination, account)).test(parsed.pathname);
}

/** True when `url` is a Gemini conversation page of any account. */
export function isConversationPage(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.origin === origin && conversationPath.test(parsed.pathname);
  } catch { return false; }
}

/**
 * The user-readable reason a prompt was not sent when the tab is not on a page of account `account`: Google opened another account or sent the tab to its
 * sign-in. Null when the page is on the right account (the caller then has a more generic message).
 */
export function misplacedReason(url: string, account: string): string | null {
  const wanted = String(Number(account));
  const actual = accountOf(url);
  if (actual === wanted) return null;
  if (actual !== null) return `Gemini opened account /u/${actual} instead of /u/${wanted} (or is signed out). Pick another account in the Gemini settings or sign in. No prompt submitted.`;
  let host = 'an unknown page';
  try { host = new URL(url).host; } catch { /* keep the generic description */ }
  return `Gemini did not open account /u/${wanted}: the tab is on ${host} (signed out, or the account does not exist). Sign in in BrowserOS or pick another account in the Gemini settings. No prompt submitted.`;
}

/** Reference validation the core applies to persisted and user-supplied conversation and project references. */
export const geminiReferences: AssistantReferencePolicy = {
  normalizeProject: normalizeProjectUrl,
  normalizeConversation: normalizeConversationUrl,
};
