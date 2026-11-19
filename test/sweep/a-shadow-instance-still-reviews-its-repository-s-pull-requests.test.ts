// W1-T13733 — a shadow instance's sweep reviews its repository's open pull requests and posts remudero-review
// exactly as a live instance does; only arming and merging stay refused. The private catalog's review gate depends
// on it: a shadow instance must post the verdict that gate reads.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { buildSweepEffects, runSweep, type OpenPrView, type SweepDeps } from "#test/helpers/sweep-test.js";
import { ghShim } from "#test/helpers/gh-shim.js";
import { readLedgerLines } from "#src/lib/status.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import type { Config } from "#src/lib/config.js";

const HEAD = "1373313733137331373313733137331373313733";
const PR = 13733;
const TASK = "W1-T13733";
const PR_URL = `https://github.com/craigoley/remudero-ops/pull/${PR}`;

function view(overrides: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: PR, prUrl: PR_URL, taskId: TASK, headSha: HEAD,
    headRefName: `run-${TASK}-1795038804000`,
    autoMergeArmed: false, reviewState: "none", checksState: "green",
    unmetCriteria: [], priorStrikes: 0, lastActivityAt: new Date().toISOString(),
    ...overrides,
  };
}

/** One sweep pass through the production effects for `repoMode`, with a recording reviewer and a recording `gh`. */
async function pass(t: TestContext, repoMode: "shadow" | "live", pr: OpenPrView) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t13733-${repoMode}-`));
  const ledgerPath = join(root, "state", "ledger.ndjson");
  const shim = ghShim([{ when: "", stdout: "{}" }], { kind: `t13733-${repoMode}-gh` });
  const previousPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${previousPath}`;
  t.after(() => {
    process.env.PATH = previousPath;
    rmSync(root, { recursive: true, force: true });
    rmSync(shim.dir, { recursive: true, force: true });
  });
  const reviewed: number[] = [];
  const logs: Array<{ step: string; fields: Record<string, unknown> }> = [];
  const effects = buildSweepEffects({
    owner: "craigoley", repo: "remudero-ops", repoMode,
    config: { root, claudeBin: "/bin/true" } as Config,
    ledgerPath, runId: `t13733-${repoMode}`, plan: { tasks: [], byId: new Map() },
    log: (step, fields = {}) => { logs.push({ step, fields }); },
    reviewRunner: async (prNumber) => { reviewed.push(prNumber); return 0; },
  });
  const deps: SweepDeps = {
    arm: effects.arm, postReview: effects.postReview, close: () => {}, dispatchFix: () => {}, escalate: () => {},
    ledgerPath, runId: `t13733-${repoMode}`, readLedgerUnion: () => ({ complete: false, lines: [] }),
  };
  await withLiveWritesAllowed(() => runSweep([pr], deps));
  const attempts = logs.filter((row) => row.step === "sweep.post_review.attempt").map((row) => row.fields);
  const merges = shim.calls().filter((call) => /\/merge\b|pr merge/.test(call));
  return { reviewed, attempts, logs, merges, effects, rows: () => readLedgerLines(ledgerPath) };
}

test("W1-T13733 criterion 1: with repoMode shadow a reviewable open pull request is reviewed on its exact head, as with repoMode live", async (t) => {
  const live = await pass(t, "live", view());
  assert.deepEqual(live.reviewed, [PR], "positive control: the live instance reviews the pull request");
  const shadow = await pass(t, "shadow", view());
  assert.deepEqual(shadow.reviewed, live.reviewed, "the shadow instance runs the same review");
  assert.equal(shadow.attempts.length, 1);
  assert.equal(shadow.attempts[0].head_sha, HEAD, "the review is posted against the pull request's exact head");
  assert.equal(shadow.attempts[0].pr_number, PR);
  assert.deepEqual(shadow.attempts.map((row) => [row.pr_number, row.head_sha, row.review_mode]),
    live.attempts.map((row) => [row.pr_number, row.head_sha, row.review_mode]));
});

test("W1-T13733 criterion 2: invariant:shadow-never-merges — with repoMode shadow arm still returns shadow-refused and no merge is attempted", async (t) => {
  const reviewed = view({ reviewState: "success" });
  const shadow = await pass(t, "shadow", reviewed);
  assert.equal(await shadow.effects.arm(reviewed), "shadow-refused");
  assert.ok(shadow.logs.some((row) => row.step === "automerge.shadow_refused" && row.fields.pr_url === PR_URL));
  assert.deepEqual(shadow.merges, [], "a shadow instance never asks GitHub to merge");
  assert.deepEqual(shadow.reviewed, [], "an already-reviewed head is not reviewed again");
});
