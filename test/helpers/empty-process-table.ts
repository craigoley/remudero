import fs, { type Dir } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { after, mock } from "node:test";

/**
 * W1-T15026: the worktree reaper asks the host's `/proc` who works in a tree before removing it, so a reap fixture
 * decides alike on every host only when it owns that table. For the calling test file, `/proc` enumerates as a table
 * that was read and holds no process; every other directory opens as usual. For suites that reach the reaper through
 * a rung with no census seam; a direct caller passes `cwdCensus` instead. It patches a builtin, so only a file that
 * runs in its own process may call it.
 */
export function emptyHostProcessTable(): void {
  const real = fs.opendirSync;
  const empty = { readSync: () => null, closeSync: () => {} } as unknown as Dir;
  const patch = mock.method(fs, "opendirSync", (...args: Parameters<typeof fs.opendirSync>) =>
    args[0] === "/proc" ? empty : real(...args));
  syncBuiltinESMExports();
  after(() => {
    patch.mock.restore();
    syncBuiltinESMExports();
  });
}
