/**
 * test/setup/tmp-hygiene.ts — automatic per-process temp-dir sweep for the test suite
 * (W1-T131).
 *
 * INCIDENT: every fixture across the suite creates its own throwaway temp dir via
 * `mkdtempSync(join(tmpdir(), "<prefix>-"))` (~60 call sites across ~32 files) and none
 * of them remove it — the same shape of leak `src/lib/tmp.ts` (W1-T115) fixed for rmd's
 * own production runtime, just never applied to the test suite itself. Left unchecked,
 * mutation testing (Stryker) re-runs the suite once per mutant and multiplies the leak
 * into hundreds of thousands of dirs (202,830 dirs / 14G measured in one run).
 *
 * Fix: rather than touching every one of those ~60 call sites, wrap `fs.mkdtempSync`
 * once (propagated to every fixture's own `import { mkdtempSync } from "node:fs"` via
 * `syncBuiltinESMExports()` — see the comment below), record every dir it creates during
 * this process, and remove all of them from a `process.on("exit", ...)` handler.
 * `node --test` runs each matched test file in its own child process by default, and
 * `--import` modules load fresh in every one of those child processes (verified
 * empirically against this repo's actual `node --test --import tsx ...` invocation), so
 * this sweep is naturally scoped to exactly the dirs one test file's fixtures created
 * during its own run — no cross-file collision risk under parallel execution, and no
 * per-fixture cleanup discipline required, now or for any fixture added later.
 *
 * Loaded via a second `--import` flag on the `test` npm script, after `--import tsx` —
 * so this file, and the fixtures it instruments, both run through tsx's loader.
 */
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const created: Array<string | Buffer> = [];
const originalMkdtempSync = fs.mkdtempSync;

fs.mkdtempSync = ((...args: Parameters<typeof fs.mkdtempSync>) => {
  const dir = (originalMkdtempSync as (...a: Parameters<typeof fs.mkdtempSync>) => string | Buffer)(...args);
  created.push(dir);
  return dir;
}) as typeof fs.mkdtempSync;

// Every fixture imports the NAMED binding (`import { mkdtempSync } from "node:fs"`), not
// the default-export object patched above — and Node bakes named ESM exports of core
// modules in at first-import time, so reassigning the property on the default object
// alone is invisible to that binding (verified empirically: without this call, a sibling
// process's `import { mkdtempSync } from "node:fs"` call never reaches the wrap above).
// `syncBuiltinESMExports()` is Node's own documented mechanism for propagating a builtin
// monkeypatch to its already-bound named ESM exports — the same trick fs-mocking
// libraries (e.g. mock-fs) rely on.
syncBuiltinESMExports();

process.on("exit", () => {
  for (const dir of created) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort — a fixture may already have removed its own dir
    }
  }
});
