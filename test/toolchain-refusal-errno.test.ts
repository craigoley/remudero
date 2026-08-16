import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ClaudeToolchainBlockedError, createClaudeExecutableCache, resolveClaudeExecutable } from "../src/lib/worker.js";

// W1-T901 — the 2026-07-23 incident (feedback fb-1784830299772-26248a): the
// npm-global `claude` symlink was rewritten mid-swap to an ASCII launcher
// with NO exec bit. `defaultCanExecute` was `catch { return false }`, so
// that non-executable husk and a wrong-architecture/crashing binary both
// rendered as the SAME bare "exists, --version failed" string, and the
// operator spent the incident chasing an architecture mismatch that never
// existed. These tests drive the REAL (uninjected) `defaultCanExecute`
// probe against REAL files — a stubbed `canExecute: () => false` cannot
// distinguish the fix from the defect, which is the whole point (design (v)).

test("toolchain refusal: a candidate that exists but won't run records the real errno from the version probe", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-toolchain-husk-"));
  const husk = join(dir, "claude");
  // A real ASCII husk with NO exec bit — the exact 2026-07-23 shape (an
  // installer launcher frozen mid-swap), never a stubbed failure.
  writeFileSync(husk, "#!/bin/sh\n# frozen mid-swap launcher, never finished writing\n".repeat(10));
  chmodSync(husk, 0o644); // explicit: no exec bit, regardless of umask

  assert.throws(
    () =>
      resolveClaudeExecutable(createClaudeExecutableCache(), {
        env: {},
        home: dir,
        which: () => undefined,
        locations: [{ label: "husk", resolve: () => husk }],
        // No `canExecute` override — the REAL defaultCanExecute probes the
        // real file via a real subprocess, so the errno is the OS's, never
        // a constant the test also invents (design (v)).
      }),
    (err: unknown) => {
      assert.ok(err instanceof ClaudeToolchainBlockedError);
      const entry = err.searched.find((s) => s.path === husk)!;
      assert.equal(entry.existed, true);
      assert.equal(entry.ran, false);
      assert.equal(entry.cause?.code, "EACCES", "the OS's real errno for a non-executable file");
      assert.match(err.message, /exists, --version failed \(EACCES/, "the refusal message names the cause, not just the bare W1-T113 string");
      return true;
    },
    "a real non-executable file names EACCES in the refusal, distinguishing it from a bare probe failure",
  );
});

test("toolchain refusal: the non-executable husk is distinguishable from a binary that runs and crashes", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-toolchain-distinguish-"));
  const husk = join(dir, "husk");
  writeFileSync(husk, "not executable\n");
  chmodSync(husk, 0o644);

  const crasher = join(dir, "crasher");
  writeFileSync(crasher, "#!/bin/sh\necho 'boom: unsupported architecture' >&2\nexit 1\n");
  chmodSync(crasher, 0o755);

  /** Resolve a single real candidate and pull its recorded cause back out
   * of the thrown refusal — one call per candidate so each failure is
   * captured independently, over the REAL defaultCanExecute. */
  function causeFor(path: string): { code?: string; message?: string } | undefined {
    let cause: { code?: string; message?: string } | undefined;
    assert.throws(
      () =>
        resolveClaudeExecutable(createClaudeExecutableCache(), {
          env: {},
          home: dir,
          which: () => undefined,
          locations: [{ label: "candidate", resolve: () => path }],
        }),
      (err: unknown) => {
        assert.ok(err instanceof ClaudeToolchainBlockedError);
        cause = err.searched[0]?.cause;
        return true;
      },
    );
    return cause;
  }

  const huskCause = causeFor(husk);
  const crasherCause = causeFor(crasher);

  assert.equal(huskCause?.code, "EACCES", "the non-executable husk is a real EACCES");
  assert.notEqual(crasherCause?.code, "EACCES", "a runnable-but-crashing binary is never misreported as EACCES");
  assert.ok(crasherCause?.message?.includes("boom"), "the crashing binary's own diagnostic reaches the cause instead");
  assert.notDeepEqual(huskCause, crasherCause, "a 500-byte husk and a crashing binary are no longer the same refusal string");
});

test("toolchain refusal: a missing candidate is still reported as missing and is never probed", () => {
  let probeCalls = 0;
  const missing = "/nonexistent/rmd-toolchain-missing/claude";
  const deps = {
    env: {},
    home: "/home/op",
    exists: (_p: string) => false,
    which: () => undefined,
    canExecute: (_p: string) => {
      probeCalls++;
      return true;
    },
    locations: [{ label: "missing", resolve: () => missing }],
  };

  assert.throws(
    () => resolveClaudeExecutable(createClaudeExecutableCache(), deps),
    (err: unknown) => {
      assert.ok(err instanceof ClaudeToolchainBlockedError);
      const entry = err.searched.find((s) => s.path === missing)!;
      assert.equal(entry.existed, false);
      assert.equal(entry.ran, false);
      assert.equal(entry.cause, undefined, "a missing candidate carries no cause — it was never probed to have one");
      assert.match(err.message, /missing/);
      return true;
    },
  );
  assert.equal(probeCalls, 0, "canExecute is never invoked for a candidate that doesn't exist on disk");
});

test("toolchain refusal: the cause is bounded — never the child environment, never an unbounded stderr dump", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-toolchain-bounded-"));
  const noisy = join(dir, "noisy");
  const hugeLine = "x".repeat(5000);
  writeFileSync(noisy, `#!/bin/sh\nprintf '%s' '${hugeLine}' 1>&2\nexit 1\n`);
  chmodSync(noisy, 0o755);

  let cause: { code?: string; message?: string } | undefined;
  assert.throws(
    () =>
      resolveClaudeExecutable(createClaudeExecutableCache(), {
        // A marker that would be visible if the child's ENVIRONMENT were
        // ever folded into the cause — it must never appear.
        env: { REMUDERO_TEST_SECRET_MARKER: "should-never-appear-in-a-refusal" },
        home: dir,
        which: () => undefined,
        locations: [{ label: "noisy", resolve: () => noisy }],
      }),
    (err: unknown) => {
      assert.ok(err instanceof ClaudeToolchainBlockedError);
      cause = err.searched.find((s) => s.path === noisy)?.cause;
      return true;
    },
  );

  assert.ok(cause, "a probed, existing candidate that failed records a cause");
  assert.ok(
    (cause!.message?.length ?? 0) < hugeLine.length,
    "the captured message is a bounded excerpt, never the full stderr",
  );
  assert.ok(
    !cause!.message?.includes("should-never-appear-in-a-refusal"),
    "the deps.env used for resolution never reaches the cause message",
  );
  assert.deepEqual(
    Object.keys(cause!).sort(),
    Object.keys(cause!).filter((k) => k === "code" || k === "message").sort(),
    "the cause carries only code/message fields — structurally no env field exists to leak",
  );
});
