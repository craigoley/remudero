// #10872 guards a PR's body for closing references when the fleet arms or merges it. It left two
// paths open: GitHub merges an armed PR with whatever body it holds at that moment, so an edit after
// the arm was never re-checked; and `ghPrMergeSquash` merged with no guard at all. These pin both.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { armedBodyNeedsGuard, rememberCleanArmedBody, type ClosingReferenceGuardResult } from "../src/lib/closing-reference-guard.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { ghPrMergeSquash } from "../src/lib/worker.js";
import { ghShim } from "./helpers/gh-shim.js";
import { buildSweepEffects, runSweep, type OpenPrView, type SweepDeps } from "./helpers/sweep-test.js";

const NOW = Date.parse("2026-10-12T03:00:00Z");

function pr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 2035,
    prUrl: "https://github.com/craigoley/remudero-console/pull/2035",
    taskId: "CONSOLE-T99",
    reviewState: "pending",
    checksState: "pending",
    unmetCriteria: [],
    priorStrikes: 0,
    // expiring-fixture: exempt -- aged against the frozen NOW above, never Date.now()
    lastActivityAt: "2026-10-12T02:50:00Z",
    headSha: "a1b2c3d4",
    headRefName: "run-CONSOLE-T99-1791700000000",
    autoMergeArmed: true,
    mergeState: "clean",
    ...over,
  };
}

function deps(over: Partial<SweepDeps> = {}): SweepDeps {
  return {
    arm: () => {},
    close: () => {},
    dispatchFix: () => {},
    escalate: () => {},
    ledgerPath: join(tmpdir(), `${RMD_TMP_PREFIX}armed-body-guard-ledger.ndjson`),
    runId: "SWEEP-ARMED-BODY",
    now: () => NOW,
    readLedger: () => [],
    appendLine: () => {},
    ...over,
  };
}

const EDITED_BODY = "Repair notes added after the arm.\n\n(root cause and fix: craigoley/remudero#10856)\n";

test("the sweep re-guards an armed PR whose body, edited after the arm, names another PR with a closing keyword", async () => {
  const guarded: string[] = [];
  const logged: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const guardArmedBody = (p: OpenPrView): ClosingReferenceGuardResult => {
    guarded.push(p.prUrl);
    return { state: "defused", defused: [{ reference: "fix: craigoley/remudero#10856", url: "https://github.com/craigoley/remudero/pull/10856", resolution: "open-pr" }] };
  };
  await runSweep([pr({ body: EDITED_BODY })], deps({ guardArmedBody, log: (step, extra) => void logged.push({ step, extra }) }));
  assert.deepEqual(guarded, ["https://github.com/craigoley/remudero-console/pull/2035"]);
  const row = logged.find((r) => r.step === "sweep.armed_body_guarded");
  assert.ok(row, "the rewrite is logged");
  assert.equal(row.extra?.state, "defused");
  assert.deepEqual(row.extra?.defused, ["https://github.com/craigoley/remudero/pull/10856"]);
});

test("the sweep spends no read on an unarmed PR or an armed body with no closing reference", async () => {
  const guarded: number[] = [];
  const guardArmedBody = (p: OpenPrView): ClosingReferenceGuardResult => {
    guarded.push(p.prNumber);
    return { state: "clean", defused: [] };
  };
  await runSweep(
    [
      pr({ prNumber: 1, prUrl: "https://github.com/craigoley/remudero-console/pull/1", body: EDITED_BODY, autoMergeArmed: false }),
      pr({ prNumber: 2, prUrl: "https://github.com/craigoley/remudero-console/pull/2", body: "No references here; see PR 10856." }),
    ],
    deps({ guardArmedBody }),
  );
  assert.deepEqual(guarded, []);
});

test("an armed body the guard found clean is not read again on the next pass, and an edit to it is", async () => {
  const guarded: string[] = [];
  const guardArmedBody = (p: OpenPrView): ClosingReferenceGuardResult => {
    guarded.push(p.body ?? "");
    return { state: "clean", defused: [] };
  };
  const url = "https://github.com/craigoley/remudero-console/pull/3";
  const issueOnly = "Fixes craigoley/remudero-console#3001\n";
  await runSweep([pr({ prNumber: 3, prUrl: url, body: issueOnly })], deps({ guardArmedBody }));
  await runSweep([pr({ prNumber: 3, prUrl: url, body: issueOnly })], deps({ guardArmedBody }));
  await runSweep([pr({ prNumber: 3, prUrl: url, body: issueOnly + EDITED_BODY })], deps({ guardArmedBody }));
  assert.deepEqual(guarded, [issueOnly, issueOnly + EDITED_BODY]);
});

test("a guard that throws on an armed PR is logged as failed and does not stop the pass", async () => {
  const logged: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const summary = await runSweep(
    [pr({ body: EDITED_BODY })],
    deps({ guardArmedBody: () => { throw new Error("rate limited"); }, log: (step, extra) => void logged.push({ step, extra }) }),
  );
  assert.ok(summary, "the pass completed");
  const row = logged.find((r) => r.step === "sweep.armed_body_guarded");
  assert.equal(row?.extra?.state, "failed");
  assert.match(String(row?.extra?.detail), /rate limited/);
});

test("ghPrMergeSquash withholds the merge when the closing-reference guard fails, and gh is never invoked", () => {
  const shim = ghShim([], { kind: "merge-squash-guard-gh" });
  const savedPath = process.env.PATH;
  try {
    process.env.PATH = `${shim.dir}:${savedPath}`;
    assert.throws(
      () => withLiveWritesAllowed(() =>
        ghPrMergeSquash("https://github.com/acme/sandboxrepo/pull/9", () => ({ state: "failed", defused: [], detail: "could not read this PR's body" }))),
      /merge withheld: could not read this PR's body/,
    );
    assert.deepEqual(shim.calls(), [], "gh was never invoked");
  } finally {
    process.env.PATH = savedPath;
  }
});

test("ghPrMergeSquash runs the closing-reference guard before it merges", () => {
  const shim = ghShim([], { kind: "merge-squash-guard-gh" });
  const savedPath = process.env.PATH;
  const order: string[] = [];
  try {
    process.env.PATH = `${shim.dir}:${savedPath}`;
    withLiveWritesAllowed(() =>
      ghPrMergeSquash("https://github.com/acme/sandboxrepo/pull/10", (url) => {
        order.push(`guard ${url}`);
        assert.deepEqual(shim.calls(), [], "nothing merged before the guard ran");
        return { state: "defused", defused: [] };
      }));
    order.push(...shim.calls());
    assert.deepEqual(order, ["guard https://github.com/acme/sandboxrepo/pull/10", "pr merge https://github.com/acme/sandboxrepo/pull/10 --squash"]);
  } finally {
    process.env.PATH = savedPath;
  }
});

test("armedBodyNeedsGuard reads an unlisted body, an unresolvable URL, and never a self-reference", () => {
  const url = "https://github.com/acme/widgets/pull/41";
  assert.equal(armedBodyNeedsGuard(url, undefined), true, "an unlisted body is unknown, so it is read");
  assert.equal(armedBodyNeedsGuard("not a pull request url", "fixes #1"), true, "an unresolvable URL is read");
  assert.equal(armedBodyNeedsGuard(url, "Fixes #41 and fixes acme/widgets#41"), false, "a self-reference closes nothing else");
  assert.equal(armedBodyNeedsGuard(url, "Fixes acme/widgets#42"), true);
});

test("the clean-body memo is bounded, so a forgotten body is simply read again", () => {
  const first = "https://github.com/acme/widgets/pull/1000";
  rememberCleanArmedBody(first, "Fixes #1");
  assert.equal(armedBodyNeedsGuard(first, "Fixes #1"), false);
  for (let n = 1001; n < 1001 + 256; n++) rememberCleanArmedBody(`https://github.com/acme/widgets/pull/${n}`, "Fixes #1");
  assert.equal(armedBodyNeedsGuard(first, "Fixes #1"), true, "past the bound the memo was cleared");
});

test("an armed PR the sweep did not list a body for is guarded on every pass", async () => {
  let reads = 0;
  const guardArmedBody = (): ClosingReferenceGuardResult => {
    reads++;
    return { state: "clean", defused: [] };
  };
  const unlisted = pr({ prNumber: 4, prUrl: "https://github.com/craigoley/remudero-console/pull/4" });
  delete unlisted.body;
  await runSweep([unlisted], deps({ guardArmedBody }));
  await runSweep([unlisted], deps({ guardArmedBody }));
  assert.equal(reads, 2);
});

test("the production sweep effect re-guards an armed body through gh and rewrites a reference to an open PR", async () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}armed-body-effect-root-`));
  const shim = ghShim([
    { when: "--method PATCH", stdout: "{}" },
    { when: "pulls/2035", stdout: JSON.stringify({ body: EDITED_BODY }) },
    { when: "issues/10856", stdout: '{"pull_request":{},"state":"open"}' },
  ], { kind: "armed-body-effect-gh" });
  const savedPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${savedPath}`;
  try {
    const effects = buildSweepEffects({
      owner: "craigoley",
      repo: "remudero-console",
      config: { claudeBin: "/usr/bin/true", root } as never,
      ledgerPath: join(root, "ledger.ndjson"),
      runId: "SWEEP-ARMED-BODY",
      plan: { tasks: [] } as never,
      log: () => {},
      policy: undefined,
      reviewRunner: undefined,
      spawnImpl: undefined,
      pushEmptyCommit: undefined,
      issuesImpl: undefined,
      stallNotice: undefined,
      armImpl: undefined,
      armSessionPrsOverride: undefined,
      updateBranchImpl: undefined,
      captureRepairFeedbackImpl: undefined,
    });
    const result = await withLiveWritesAllowed(() => effects.guardArmedBody!(pr({ body: EDITED_BODY })));
    assert.equal(result.state, "defused");
    assert.deepEqual(result.defused.map((d) => d.url), ["https://github.com/craigoley/remudero/pull/10856"]);
    const calls = shim.calls().join("\n");
    assert.match(calls, /--method PATCH repos\/craigoley\/remudero-console\/pulls\/2035/);
    assert.ok(calls.includes("fix: PR craigoley/remudero#10856"), `the body was rewritten: ${calls}`);
  } finally {
    process.env.PATH = savedPath;
    rmSync(root, { recursive: true, force: true });
  }
});
