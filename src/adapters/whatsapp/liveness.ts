import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const watermarkSchema = z.object({ aliveAt: z.number().positive().finite() });

const FILE = "liveness.json";
/** Covers the write interval plus clock skew between this machine and WhatsApp's timestamps. */
export const CATCH_UP_MARGIN_SECONDS = 60;
/** Messages older than this are never treated as missed, however long warelay was off. */
export const MAX_CATCH_UP_SECONDS = 24 * 60 * 60;
export const WATERMARK_INTERVAL_MS = 30_000;

/** Unix second at which the WhatsApp link was last known alive, or undefined when none was saved (first run, new pairing). */
export function readWatermark(authDir: string): number | undefined {
  try {
    return Math.floor(watermarkSchema.parse(JSON.parse(readFileSync(join(authDir, FILE), "utf8"))).aliveAt);
  } catch {
    return undefined;
  }
}

/** Atomically replaces the watermark file; throws when the directory cannot be written. */
export function writeWatermark(authDir: string, seconds: number): void {
  const temporary = join(authDir, `${FILE}.tmp`);
  writeFileSync(temporary, `${JSON.stringify({ aliveAt: Math.floor(seconds) })}\n`, { mode: 0o600 });
  renameSync(temporary, join(authDir, FILE));
}

export interface CutoffInput {
  now: number;
  watermark: number | undefined;
  /** Caller-imposed floor kept for restarts; never allowed to hide messages the watermark says were missed. */
  notBefore: number | undefined;
}

/**
 * First Unix second whose messages are forwarded. Without a watermark nothing earlier than the start (or `notBefore`) is
 * forwarded, so a fresh pairing never replays history. With one, everything since the link was last alive (minus a margin,
 * at most 24 hours back) is caught up.
 */
export function catchUpCutoff({ now, watermark, notBefore }: CutoffInput): number {
  if (watermark === undefined) return notBefore ?? now;
  const fromWatermark = Math.min(watermark, now) - CATCH_UP_MARGIN_SECONDS;
  return Math.max(Math.min(notBefore ?? now, fromWatermark), now - MAX_CATCH_UP_SECONDS);
}
