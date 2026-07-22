/**
 * test/setup/reapable-prefix.ts — normalize a test fixture's temp-dir prefix so the
 * PRODUCTION boot sweep can reclaim it after a SIGKILL (W1-T131 follow-up).
 *
 * test/setup/tmp-hygiene.ts already reaps every fixture temp dir on
 * `process.on("exit")` — but a worker killed mid-`npm test` (the daemon's max_turns
 * kill / headroom idle / kill-9 + launchd restart) SKIPS that handler, orphaning the
 * dir under `os.tmpdir()`. The only backstop then is `src/lib/tmp.ts`'s boot sweep
 * (`sweepStaleTempDirs`), which reaps ONLY names starting with `rmd-` (RMD_TMP_PREFIX)
 * — and ~62 fixture call sites use bare prefixes ("drain-", "learnings-index-roundtrip-",
 * "daemon-", …) it never matches.
 *
 * Rather than edit all 62 call sites, the single `mkdtempSync` wrapper the hygiene
 * module already installs routes each prefix through this pure function, which
 * prepends the reapable `rmd-test-` marker (itself matched by the existing `rmd-`
 * sweep — NO production sweep change needed) so a killed-process orphan is reaped on
 * the next boot. Scoped narrowly: it touches ONLY a prefix whose directory is the OS
 * temp root itself (the sweep's exact scan surface) and that does not already carry
 * the `rmd-` prefix — so `rmd-`-prefixed fixtures and dirs created elsewhere are
 * untouched. The original prefix survives as a substring (`rmd-test-<original>-…`), so
 * any test that greps its own path for the original token still matches.
 */
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

/** The reapable marker prepended to a bare fixture prefix. Starts with `rmd-`, so the
 * existing {@link sweepStaleTempDirs} boot sweep reaps it with no changes. */
export const REAPABLE_TEST_PREFIX = "rmd-test-";

/** The prefix {@link sweepStaleTempDirs} keys on — kept in sync literally rather than
 * imported so this test-setup helper has no production import at load time. */
const RMD_TMP_PREFIX = "rmd-";

/**
 * Return a `mkdtempSync` prefix guaranteed to produce a boot-sweep-reapable dir name.
 * A no-op unless `requested` names a dir DIRECTLY under `tmpRoot` (the OS temp root,
 * i.e. the sweep's scan surface) whose basename does not already start with `rmd-`.
 */
export function reapableTmpPrefix(requested: string, tmpRoot: string = tmpdir()): string {
  const dir = dirname(requested);
  if (resolve(dir) !== resolve(tmpRoot)) return requested; // not a direct child of the temp root
  const base = basename(requested);
  if (base.startsWith(RMD_TMP_PREFIX)) return requested; // already reapable
  return join(dir, REAPABLE_TEST_PREFIX + base);
}
