// W1-T6022 — a READY PR (checks green with review success, not an arm alone) that is at least one
// commit behind takes W1-T5696's overlap and baseline arms WITHOUT the 10-commit distance gate, with
// update reason `ready-overlap`. #9539/#9542 is the reach rule's shape: #9539's test reads
// test/fixtures/golden-verdicts/ and #9542 rewrote test/fixtures/golden-verdicts/knowledge-retire/*.
// Every import below exists at the base commit, so this file loads there and fails on behaviour.
import assert from "node:assert/strict";
import { test } from "node:test";

import type { Config } from "../src/lib/config.js";
import {
  buildSweepEffects,
  DEFAULT_SWEEP_POLICY,
  openPrsBehindMain,
  runSweep,
  selectUpdateBranchTarget,
  type ArmedStalledPr,
  type BaseChangedFiles,
  type OpenPrView,
  type SweepDeps,
  type SweepPolicy,
} from "./helpers/sweep-test.js";

// Every age below is read against this frozen NOW, never the wall clock.
const NOW = 1_800_000_000_000;
const POLICY: SweepPolicy = {
  ...DEFAULT_SWEEP_POLICY,
  reviewWaitingBranchRefreshEnabled: true,
  reviewWaitingBranchRefreshThreshold: 10,
};
const GOLDEN_TEST = "test/golden-verdicts-read.test.ts";
const GOLDEN_FIXTURE = "test/fixtures/golden-verdicts/knowledge-retire/golden.yaml";

function pr(prNumber: number, over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber,
    prUrl: `https://github.com/craigoley/remudero/pull/${prNumber}`,
    taskId: `W1-T${prNumber}`,
    reviewState: "success",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: new Date(NOW - 3_600_000).toISOString(),
    headSha: `head${prNumber}`,
    autoMergeArmed: false,
    mergeState: "clean",
    changedFiles: ["src/mine.ts", "test/mine.test.ts"],
    ...over,
  };
}

const base = (files: string[], truncated = false): BaseChangedFiles => ({ files, truncated });
const one = <T,>(prNumber: number, value: T) => new Map<number, T>([[prNumber, value]]);

function harness(over: Partial<SweepDeps> & Record<string, unknown> = {}) {
  const rows: Array<Record<string, unknown>> = [];
  const updated: ArmedStalledPr[] = [];
  const deps = {
    arm: () => {},
    close: () => {},
    dispatchFix: () => {},
    escalate: () => {},
    ledgerPath: "/tmp/rmd-w1-t6022-ledger.ndjson",
    runId: "SWEEP-W1-T6022",
    now: () => NOW,
    readLedger: () => [],
    appendLine: (_path: string, row: Record<string, unknown>) => {
      rows.push(row);
    },
    updateBranch: (candidate: ArmedStalledPr) => {
      updated.push(candidate);
      return "updated" as const;
    },
    ...over,
  } as SweepDeps;
  return { deps, rows, updated };
}

test("a ready PR 2 commits behind whose own file main changed is selected with reason ready-overlap", async () => {
  const picked = openPrsBehindMain([pr(6001)], one(6001, 2), POLICY, new Set(), one(6001, base(["src/other.ts", "src/mine.ts"])));
  assert.equal(picked[0]?.updateReason, "ready-overlap");
  assert.deepEqual(picked[0]?.matchingBaseFiles, ["src/mine.ts"]);
  assert.equal(picked[0]?.behindBy, 2);

  // #10000: an arm alone survives new heads; pending gates must finish before a ready refresh.
  const armed = pr(6002, { autoMergeArmed: true, checksState: "pending", reviewState: "pending" });
  const armedPick = openPrsBehindMain([armed], one(6002, 1), POLICY, new Set(), one(6002, base(["src/mine.ts"])));
  assert.deepEqual(armedPick, []);

  // the baseline arm also applies without the distance gate
  const baseline = openPrsBehindMain([pr(6003)], one(6003, 3), POLICY, new Set(), one(6003, base(["package-lock.json"])));
  assert.equal(baseline[0]?.updateReason, "ready-overlap");
  assert.deepEqual(baseline[0]?.matchingBaseFiles, ["package-lock.json"]);

  // and the sweep spends its one update on it, naming the reason in the ledger row
  const h = harness({ behindMainByPr: one(6001, 2), baseChangedFilesByPr: one(6001, base(["src/mine.ts"])) });
  await runSweep([pr(6001)], h.deps, POLICY);
  assert.deepEqual(h.updated.map((c) => c.prNumber), [6001]);
  const row = h.rows.find((r) => r.step === "sweep.update_branch.updated");
  assert.equal(row?.update_reason, "ready-overlap");
  assert.deepEqual(row?.matching_base_files, ["src/mine.ts"]);
});

test("a ready PR whose changed test names a path prefix main changed is selected", async () => {
  const golden = pr(6010, { changedFiles: ["src/lib/review.ts", GOLDEN_TEST, "docs/note.md"] });
  const reads: string[] = [];
  const sources: Record<string, string> = {
    [GOLDEN_TEST]: "// each case under test/fixtures/golden-verdicts/<case>/ holds the judge's inputs\n",
  };
  const h = harness({
    behindMainByPr: one(6010, 2),
    baseChangedFilesByPr: one(6010, base(["src/other.ts", GOLDEN_FIXTURE])),
    readPrFileSource: (p: OpenPrView, path: string) => {
      reads.push(`${p.headSha}:${path}`);
      return sources[path];
    },
  });
  await runSweep([golden], h.deps, POLICY);
  assert.deepEqual(h.updated.map((c) => c.prNumber), [6010]);
  assert.equal(h.updated[0]?.updateReason, "ready-overlap");
  assert.deepEqual(h.updated[0]?.matchingBaseFiles, [GOLDEN_FIXTURE]);
  assert.ok(reads.length > 0 && reads.every((r) => r === `head6010:${GOLDEN_TEST}`), "only the changed test file is read");

  // a literal names a directory only at a segment boundary, and a bare-word mention is no literal
  for (const text of ["const root = 'test/fixtures/golden';", "golden-verdicts knowledge-retire"]) {
    const miss = harness({
      behindMainByPr: one(6010, 2),
      baseChangedFilesByPr: one(6010, base([GOLDEN_FIXTURE])),
      readPrFileSource: () => text,
    });
    await runSweep([golden], miss.deps, POLICY);
    assert.deepEqual(miss.updated, [], text);
  }

  // the exact file named as a literal reaches too
  const exact = harness({
    behindMainByPr: one(6010, 2),
    baseChangedFilesByPr: one(6010, base([GOLDEN_FIXTURE])),
    readPrFileSource: () => `readFileSync("${GOLDEN_FIXTURE}")`,
  });
  await runSweep([golden], exact.deps, POLICY);
  assert.deepEqual(exact.updated[0]?.matchingBaseFiles, [GOLDEN_FIXTURE]);
});

test("a ready PR with no overlap is not selected, and neither is an unready or draft one", async () => {
  assert.deepEqual(openPrsBehindMain([pr(6020)], one(6020, 2), POLICY, new Set(), one(6020, base(["src/other.ts"]))), []);
  const h = harness({
    behindMainByPr: one(6020, 2),
    baseChangedFilesByPr: one(6020, base(["src/other.ts", "test/fixtures/x/y.json"])),
    readPrFileSource: () => "nothing path-shaped here",
  });
  await runSweep([pr(6020)], h.deps, POLICY);
  assert.deepEqual(h.updated, []);

  const overlap = one(6021, base(["src/mine.ts"]));
  const unready = pr(6021, { reviewState: "pending" });
  assert.deepEqual(openPrsBehindMain([unready], one(6021, 2), POLICY, new Set(), overlap), []);
  const draft = pr(6021, { isDraft: true });
  assert.deepEqual(openPrsBehindMain([draft], one(6021, 2), POLICY, new Set(), overlap), []);
  // not behind at all: nothing to merge
  assert.deepEqual(openPrsBehindMain([pr(6021)], one(6021, 0), POLICY, new Set(), overlap), []);
  // a caller that never read the base files keeps today's behaviour below the gate
  assert.deepEqual(openPrsBehindMain([pr(6021)], one(6021, 2), POLICY), []);
});

test("a truncated base list is ready-unknown and not selected", async () => {
  const truncated = one(6030, base(["src/other.ts"], true));
  const rows = openPrsBehindMain([pr(6030)], one(6030, 2), POLICY, new Set(), truncated);
  assert.equal(rows[0]?.updateReason, "ready-unknown", "named in the row, never read as no overlap");
  assert.equal(
    selectUpdateBranchTarget([pr(6030)], NOW, new Set(), new Map(), new Set(), one(6030, 2), POLICY, new Set(), truncated),
    undefined,
  );
  // an unread base list (no entry for this PR) is unknown too
  assert.equal(openPrsBehindMain([pr(6030)], one(6030, 2), POLICY, new Set(), new Map())[0]?.updateReason, "ready-unknown");

  // an unreadable changed test source with no other overlap is unknown, not "no overlap"
  const h = harness({
    behindMainByPr: one(6030, 2),
    baseChangedFilesByPr: one(6030, base(["src/other.ts"])),
    readPrFileSource: () => undefined,
  });
  await runSweep([pr(6030)], h.deps, POLICY);
  assert.deepEqual(h.updated, []);

  const viaSweep = harness({ behindMainByPr: one(6030, 2), baseChangedFilesByPr: truncated });
  await runSweep([pr(6030)], viaSweep.deps, POLICY);
  assert.deepEqual(viaSweep.updated, []);
  assert.equal(viaSweep.rows.some((r) => String(r.step).startsWith("sweep.update_branch.")), false);
});

test("a ready PR under a merge-queue base or an incident hold is not selected", async () => {
  const facts = { behindMainByPr: one(6040, 2), baseChangedFilesByPr: one(6040, base(["src/mine.ts"])) };
  const queued = harness({ ...facts, mergeQueue: () => true });
  await runSweep([pr(6040)], queued.deps, POLICY);
  assert.deepEqual(queued.updated, [], "W1-T5903: the queue tests the merged result");
  assert.equal(queued.rows.filter((r) => r.step === "sweep.update_branch.skipped_queue").length, 1);

  const status = (s: string) => async () => ({ components: [{ name: "Actions", status: s }], incidents: [] });
  const held = harness({ ...facts, readActionsStatusSummary: status("major_outage") });
  await runSweep([pr(6040)], held.deps, POLICY);
  assert.deepEqual(held.updated, [], "W1-T5939: no CI run is spent during an Actions incident");

  const clear = harness({ ...facts, readActionsStatusSummary: status("operational") });
  await runSweep([pr(6040)], clear.deps, POLICY);
  assert.deepEqual(clear.updated.map((c) => c.updateReason), ["ready-overlap"], "control: no incident, refreshed");

  // the hold binds the ready arm only; the distance arms above the gate are unchanged
  const far = harness({
    behindMainByPr: one(6040, 17),
    baseChangedFilesByPr: one(6040, base(["src/mine.ts"])),
    readActionsStatusSummary: status("major_outage"),
  });
  await runSweep([pr(6040)], far.deps, POLICY);
  assert.deepEqual(far.updated.map((c) => c.updateReason), ["distance-overlap"]);
});

test("the ready refresh spends the one update per PR and head", async () => {
  const facts = { behindMainByPr: one(6050, 2), baseChangedFilesByPr: one(6050, base(["src/mine.ts"])) };
  for (const step of ["sweep.update_branch.attempted", "sweep.ci_timeout_refresh.attempted"]) {
    const spent = harness({ ...facts, readLedger: () => [{ step, pr_number: 6050, head_sha: "head6050" }] });
    await runSweep([pr(6050)], spent.deps, POLICY);
    assert.deepEqual(spent.updated, [], step);
  }
  const otherHead = harness({
    ...facts,
    readLedger: () => [{ step: "sweep.update_branch.attempted", pr_number: 6050, head_sha: "older-head" }],
  });
  await runSweep([pr(6050)], otherHead.deps, POLICY);
  assert.deepEqual(otherHead.updated.map((c) => c.prNumber), [6050], "a new head re-earns its update");
});

test("the sweep effects read a changed test file's source at the PR head", () => {
  const calls: string[][] = [];
  let fail = false;
  const effects = buildSweepEffects({
    owner: "acme", repo: "remudero", config: { root: "/nonexistent-rmd-w1-t6022" } as Config, repoRoot: "/nonexistent-rmd-w1-t6022",
    ledgerPath: "/tmp/rmd-w1-t6022-ledger.ndjson", runId: "SWEEP-W1-T6022",
    plan: { tasks: [], byId: new Map() }, log: () => {}, policy: DEFAULT_SWEEP_POLICY,
    ghJsonImpl: (args: string[]) => {
      calls.push(args);
      if (fail) throw new Error("HTTP 502");
      if (args[1]?.includes("binary")) return { encoding: "none", content: "" };
      return { encoding: "base64", content: Buffer.from("see test/fixtures/a/").toString("base64") };
    },
  } as Parameters<typeof buildSweepEffects>[0]) as Record<string, unknown>;
  const read = effects.readPrFileSource as (p: OpenPrView, path: string) => string | undefined;
  assert.equal(typeof read, "function");
  const target = pr(6060, { headSha: "sha6060" });
  assert.equal(read(target, "test/a b.test.ts"), "see test/fixtures/a/");
  assert.deepEqual(calls[0], ["api", "repos/acme/remudero/contents/test/a%20b.test.ts?ref=sha6060"]);
  assert.equal(read(target, "test/a b.test.ts"), "see test/fixtures/a/");
  assert.equal(calls.length, 1, "a source at one head is read once");
  assert.equal(read(target, "test/binary.test.ts"), undefined, "a non-base64 body is unread");
  fail = true;
  assert.equal(read(target, "test/other.test.ts"), undefined, "a failed read is unread, never empty");
  fail = false;
  assert.equal(read(target, "test/other.test.ts"), "see test/fixtures/a/", "a failed read is not cached");
});
