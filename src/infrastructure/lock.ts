import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

/** True only when the lock file names a process ID that provably no longer exists on this host. */
async function ownerIsGone(path: string): Promise<boolean> {
  let pid: number;
  try { pid = Number((await readFile(path, 'utf8')).trim()); }
  catch (error) { return hasCode(error, 'ENOENT'); }
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return false; }
  catch (error) { return hasCode(error, 'ESRCH'); }
}

/**
 * Exclusive single-writer lock for a data directory. A lock whose recorded owner process
 * no longer exists is reclaimed; any lock that may still be held (live, unreadable or
 * unparseable owner) is never removed automatically.
 */
export async function acquireLock(directory: string): Promise<() => Promise<void>> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'bridge.lock');
  let handle: FileHandle | undefined;
  for (let attempt = 0; !handle; attempt++) {
    try { handle = await open(path, 'wx', 0o600); }
    catch (error) {
      if (!hasCode(error, 'EEXIST')) throw error;
      if (attempt === 0 && await ownerIsGone(path)) {
        await unlink(path).catch((e: unknown) => { if (!hasCode(e, 'ENOENT')) throw e; });
        continue;
      }
      throw new Error(`Another bridge may be running. If it crashed, verify that it stopped, then remove ${path}.`);
    }
  }
  const owned = handle;
  await owned.writeFile(String(process.pid));
  let released: Promise<void> | undefined;
  return () => released ??= (async () => { await owned.close(); await unlink(path); })();
}
