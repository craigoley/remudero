import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ghPrMergeSquash } from "../src/lib/worker.js";
import { ghPrCreateFillCommand } from "../src/run-task.js";
import { ghIssueGateway } from "../src/lib/escalate.js";
import { LiveWriteBlockedError, withLiveWritesAllowed } from "../src/lib/live-write-guard.js";

// ── LEAF-LEVEL GUARD PROOFS ──────────────────────────────────────────────────────────
// PR #954 guards 18 outward-effect sites. A structural test asserts each site EXISTS; until
// this file, nothing asserted that a LEAF actually FIRES. A guard that is present but unproven
// is a guard nobody has shown works.
//
// impl-AX's leaf inventory found that three of the four outward operations already guard at a
// shared leaf, and `git-push` has NO leaf at all (nine inlined execFileSync calls across seven
// top-level functions). These tests cover the leaves that exist and lacked a refusal proof.
//
// EACH test asserts the OBSERVABLE REFUSAL, never merely that the line executed:
//   1. the error is thrown AND names its own boundary;
//   2. the outward command is NOT run — proven by a PATH-shimmed binary that appends every
//      invocation to a log, so "no call happened" is evidence on disk, not an assumption;
//   3. a WOULD-HAVE-FIRED control re-runs the same call inside `withLiveWritesAllowed` and
//      shows the command DOES reach the shim. Without (3), an empty log could equally mean the
//      test never reached the call site — which is the coverage theatre impl-AW demonstrated.
//
// Its own file, never appended to test/run-task.test.ts: that file crashes at the FILE level
// under --experimental-test-coverage often enough to zero a coverage-load-bearing record.

/** A shimmed executable on PATH that appends each invocation's argv to `log`, then exits 0. */
function shimBin(dir: string, name: string, log: string): void {
  writeFileSync(
    join(dir, name),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\nexit 0\n`,
    { mode: 0o755 },
  );
}

function callsIn(log: string): string[] {
  return existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
}

function withShimmedPath<T>(name: string, fn: (log: string) => T): T {
  const bin = mkdtempSync(join(tmpdir(), `rmd-leaf-${name}-`));
  const log = join(bin, "calls.log");
  shimBin(bin, name, log);
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  try {
    return fn(log);
  } finally {
    process.env.PATH = oldPath;
    rmSync(bin, { recursive: true, force: true });
  }
}

// ── LEAF: worker.ts ghPrMergeSquash — boundary "gh-pr-merge" ──────────────────────────
test("LEAF GUARD gh-pr-merge: ghPrMergeSquash REFUSES under the test runner and gh is never invoked", () => {
  withShimmedPath("gh", (log) => {
    let caught: unknown;
    try {
      ghPrMergeSquash("https://github.com/acme/remudero/pull/7");
    } catch (e) {
      caught = e;
    }
    assert.ok(caught instanceof LiveWriteBlockedError, "the leaf refused with LiveWriteBlockedError");
    assert.match(String((caught as Error).message), /gh-pr-merge/, "the error names its own boundary");
    assert.deepEqual(callsIn(log), [], "gh was never invoked — the merge did not happen");

    // WOULD-HAVE-FIRED control: exempted, the identical call DOES reach gh.
    withLiveWritesAllowed(() => ghPrMergeSquash("https://github.com/acme/remudero/pull/7"));
    const calls = callsIn(log);
    assert.equal(calls.length, 1, "exempted, the same call reaches gh exactly once");
    assert.match(calls[0], /pr merge .*--squash/, "and it is the squash-merge that was refused");
  });
});

// ── LEAF: run-task.ts ghPrCreateFillCommand — boundary "gh-pr-create" ─────────────────
// This leaf is a BUILDER: it returns an argv rather than executing it, and four executors
// route through it (run-task.ts:3545/:5147/:8390/:8601), so refusing here covers all four.
// The observable refusal is therefore the throw plus the ABSENCE of a returned command —
// a caller that cannot get an argv cannot open a PR.
test("LEAF GUARD gh-pr-create: the ghPrCreateFillCommand builder REFUSES, so its four executors get no argv to run", () => {
  let caught: unknown;
  let built: unknown;
  try {
    built = ghPrCreateFillCommand("/tmp/wt", "acme", "remudero", "run-T1-123");
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof LiveWriteBlockedError, "the builder refused with LiveWriteBlockedError");
  assert.match(String((caught as Error).message), /gh-pr-create/, "the error names its own boundary");
  assert.equal(built, undefined, "no argv was produced — an executor has nothing to run");

  // WOULD-HAVE-FIRED control: exempted, the builder yields the real `gh pr create` argv.
  const ok = withLiveWritesAllowed(() => ghPrCreateFillCommand("/tmp/wt", "acme", "remudero", "run-T1-123"));
  assert.equal(ok.command, "gh");
  assert.deepEqual(ok.args.slice(0, 4), ["pr", "create", "--repo", "acme/remudero"]);
});

// ── LEAF: escalate.ts ghIssueGateway().create — boundary "gh-issue-create" ────────────
// This leaf takes an injectable `exec`, so the un-made call is observable directly: the
// injected exec records every invocation and must record none.
test("LEAF GUARD gh-issue-create: ghIssueGateway create REFUSES and its injected exec is never called", () => {
  const seen: string[][] = [];
  const gateway = ghIssueGateway("acme", "remudero", {
    exec: (args) => {
      seen.push(args);
      return "https://github.com/acme/remudero/issues/1\n";
    },
  });

  let caught: unknown;
  try {
    gateway.create("[BLOCKED] leaf guard probe", "body", []);
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof LiveWriteBlockedError, "the leaf refused with LiveWriteBlockedError");
  assert.match(String((caught as Error).message), /gh-issue-create/, "the error names its own boundary");
  assert.deepEqual(seen, [], "the injected exec was never reached — no issue was filed");

  // WOULD-HAVE-FIRED control: exempted, the identical call reaches the exec exactly once.
  withLiveWritesAllowed(() => gateway.create("[BLOCKED] leaf guard probe", "body", []));
  assert.equal(seen.length, 1, "exempted, the same call reaches the exec exactly once");
  assert.deepEqual(seen[0].slice(0, 4), ["issue", "create", "--repo", "acme/remudero"]);
});

// ── THE OPERATION WITH NO LEAF: git-push ─────────────────────────────────────────────
// Documented as an executable assertion rather than a comment, so it FAILS THE BUILD if
// someone later extracts a push helper without moving the guard into it — at which point
// this test should be replaced by a real leaf-refusal test like the three above.
test("git-push has NO shared leaf — every push is inlined, which is why its guard cannot be relocated", () => {
  const src = readFileSync(new URL("../src/run-task.ts", import.meta.url), "utf8");
  const inlinedPushes = src
    .split("\n")
    .filter((l) => l.includes('"push"') && l.includes('execFileSync("git"'));
  assert.ok(
    inlinedPushes.length >= 8,
    `expected the inlined git-push call sites to still be inlined, found ${inlinedPushes.length} — ` +
      "if a shared push leaf has been extracted, move the guard into it and replace this test",
  );
});
