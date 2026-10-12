/**
 * W1-T5432 — calibration gaps reach the EXISTING opportunity intake, and recording is not filing.
 *
 * Every fixture drives the real chain: the readiness driver's own sidecar writer, the typed reader, the
 * production intake ports (over a disposable git checkout), the existing risk judge seam and feedback landing,
 * and a stand-in for the governed triage lane that writes the resulting task shard the real plan loader reads.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { READINESS_FOLLOW_UPS_FILE, recordReadinessGap, type ReadinessGap } from "../src/lib/benchmark-aa-readiness.js";
import { collectBenchmarkReadinessCandidates, readinessGapOutcome, readReadinessGapSidecar } from "../src/lib/benchmark-readiness-intake.js";
import { fixedClock } from "../src/lib/clock.js";
import { listFeedback } from "../src/lib/feedback.js";
import { openOpportunityIntakePorts, runOpportunityIntake, type OpportunityIntakePorts } from "../src/lib/opportunity-intake.js";
import type { GardenCheckoutAsync } from "../src/lib/gardener.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { gitRepo } from "./helpers/git-repo.js";

const clock = fixedClock(Date.parse("2026-10-12T12:00:00Z"));
const REPO = "acme/app";
const GAP: ReadinessGap = { kind: "untriggered-eligible-tasks", machineRepairable: true, detail: "untriggered-eligible-tasks:2" };
const KEY = "benchmark-readiness:trial-1:untriggered-eligible-tasks";
const MARKER = `Opportunity-Key: ${REPO}/${KEY}`;
const DEBT = `**(j) THE STANDING DEBT LINE — EACH ENTRY WITH ITS AGE IN CYCLES (R51-5's arm).**
**(1)** struck by R69 (retired).
**Zero entries are open, with a combined dwell of 0 cycles** (**P71**).
`;

interface Fixture {
  root: string;
  stateDir: string;
  landed: string[][];
  judged: string[];
  ports: () => Promise<OpportunityIntakePorts>;
  triage: (taskId: string) => void;
  cleanup: () => void;
}

function fixture(riskJudge?: Parameters<typeof openOpportunityIntakePorts>[1] extends infer D ? NonNullable<D>["riskJudge"] : never): Fixture {
  const repo = gitRepo({ kind: "t5432-readiness-intake" });
  const root = repo.dir;
  const stateDir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t5432-state-`));
  mkdirSync(join(root, "plan", "tasks.d"), { recursive: true });
  repo.addRemote("origin", `https://github.com/${REPO}.git`);
  writeFileSync(join(root, "plan", "tasks.yaml"), "[]\n");
  writeFileSync(join(root, "plan", "policy.yaml"), "{}\n");
  writeFileSync(join(root, "MASTER-PLAN.md"), DEBT);
  const landed: string[][] = [];
  const judged: string[] = [];
  const ws: GardenCheckoutAsync = {
    root, dispose: async () => {},
    land: async ({ paths }) => { landed.push(paths); return `https://github.com/${REPO}/pull/${70 + landed.length}`; },
  };
  return {
    root, stateDir, landed, judged,
    ports: () => openOpportunityIntakePorts({ stateDir, repoRoot: root, clock, log: () => {}, openWorkspace: async () => ws }, {
      readCodeql: () => ({ ok: true, alerts: [] }),
      readFriction: () => ({ records: [] }),
      readPulls: () => [[]],
      riskJudge: riskJudge ?? (async (input) => { judged.push(input.change.description); return { verdict: "low", confidence: 1, reasons: ["bounded gap repair"] }; }),
    }),
    // The governed triage lane's product: a machine-authored task whose origin and note carry the source receipt.
    triage: (taskId) => writeFileSync(join(root, "plan", "tasks.d", `${taskId}-calibration-gap.yaml`), [
      `- id: ${taskId}`, "  title: repair the untriggered eligible tasks gap", "  repo: app", "  depends_on: []", "  type: implement",
      "  verify: human", "  risk: low", "  status: queued", "  attempts: 0", "  author_class: machine", `  origin: ${KEY}`,
      "  note: |", `    ${MARKER}`, "",
    ].join("\n")),
    cleanup: () => { rmSync(root, { recursive: true, force: true }); rmSync(stateDir, { recursive: true, force: true }); },
  };
}

test("calibration gaps reach governed task triage", async () => {
  const fx = fixture();
  try {
    // The readiness driver's own writer records the gap against this checkout's identity.
    assert.deepEqual(recordReadinessGap(fx.stateDir, "trial-1", GAP, clock.iso(), REPO), { key: "trial-1:untriggered-eligible-tasks", state: "recorded" });
    const read = readReadinessGapSidecar(fx.stateDir, REPO);
    assert.equal(read.records.length, 1);
    const collected = collectBenchmarkReadinessCandidates({ repo: REPO, clock, readReadinessGaps: () => read });
    assert.equal(collected.candidates[0]?.source, "benchmark-readiness");
    assert.equal(collected.candidates[0]?.anchor, `${READINESS_FOLLOW_UPS_FILE}#trial-1:untriggered-eligible-tasks`);

    // One production pass: the existing collector reads the sidecar, the existing judge rules, the existing landing opens the feedback PR.
    const first = await runOpportunityIntake(await fx.ports());
    assert.equal(first.status, "promoted");
    assert.equal(first.destination, "plan-pr");
    assert.equal(first.candidate?.key, KEY);
    assert.equal(first.candidate?.repo, REPO);
    assert.equal(first.candidate?.authority, "machine");
    assert.equal(fx.judged.length, 1);
    assert.equal(fx.landed.length, 1);
    assert.equal(listFeedback(fx.root).filter((entry) => entry.submission_key === `${REPO}/${KEY}`).length, 1);
    assert.equal(first.readiness?.state, "pending-triage", "a feedback PR is pending triage, not a filed task");
    assert.equal(first.readiness?.taskId, undefined);

    // The governed triage lane then files the task; only now is a task id plus its source receipt reported.
    fx.triage("W1-T9001");
    const outcome = readinessGapOutcome(first.candidate!, (await (await fx.ports()).readWork()));
    assert.deepEqual({ state: outcome.state, taskId: outcome.taskId, receipt: outcome.receipt }, { state: "filed", taskId: "W1-T9001", receipt: MARKER });
  } finally { fx.cleanup(); }
});

test("calibration gap recording is not task filing", async () => {
  const fx = fixture();
  try {
    recordReadinessGap(fx.stateDir, "trial-1", GAP, clock.iso(), REPO);
    const candidate = { repo: REPO, key: KEY };
    const empty = { proposals: [], tasks: [], mergedKeys: [], prs: [], feedback: [] };
    // A sidecar line alone is recorded, never filed.
    assert.equal(readinessGapOutcome(candidate, empty).state, "recorded");
    assert.equal(readinessGapOutcome(candidate, empty).taskId, undefined);
    // A pending feedback entry, an open plan PR and a rejected entry are each reported as what they are.
    const feedback = { id: "fb-1", submission_key: `${REPO}/${KEY}`, status: "new", raw: "" } as never;
    assert.equal(readinessGapOutcome(candidate, { ...empty, feedback: [feedback] }).state, "pending-triage");
    assert.equal(readinessGapOutcome(candidate, { ...empty, prs: [{ body: MARKER }] }).state, "pending-triage");
    assert.equal(readinessGapOutcome(candidate, { ...empty, feedback: [{ ...(feedback as object), status: "rejected" } as never] }).state, "rejected");
    // A task without the source receipt is not a filing of this gap.
    const foreignTask = { id: "W1-T1", repo: "app", origin: "benchmark-readiness:trial-2:other" } as never;
    assert.equal(readinessGapOutcome(candidate, { ...empty, tasks: [foreignTask] }).state, "recorded");

    // An unavailable judgement leaves the evidence, lands nothing and files nothing.
    const offline = fixture(async () => { throw new Error("judge offline"); });
    try {
      recordReadinessGap(offline.stateDir, "trial-1", GAP, clock.iso(), REPO);
      const result = await runOpportunityIntake(await offline.ports());
      assert.equal(result.status, "unavailable");
      assert.deepEqual(offline.landed, []);
      assert.equal(listFeedback(offline.root).length, 0);
      assert.equal(readReadinessGapSidecar(offline.stateDir, REPO).records.length, 1, "the recorded evidence is still there to resume from");
      assert.equal(readinessGapOutcome(candidate, (await (await offline.ports()).readWork()), result).state, "unavailable");
    } finally { offline.cleanup(); }

    // The driver's own result names the sidecar write "recorded", the word that makes no claim about a task.
    assert.equal(recordReadinessGap(fx.stateDir, "trial-1", GAP, clock.iso(), REPO)?.state, "already-recorded");
  } finally { fx.cleanup(); }
});

test("calibration gap intake resumes without duplicate or foreign work", async () => {
  const fx = fixture();
  try {
    recordReadinessGap(fx.stateDir, "trial-1", GAP, clock.iso(), REPO);
    // Another repository's gap, an unattributed legacy line and a malformed line share the sidecar.
    recordReadinessGap(fx.stateDir, "trial-9", { ...GAP, kind: "report-stale", detail: "report-stale" }, clock.iso(), "other/elsewhere");
    recordReadinessGap(fx.stateDir, "trial-2", { ...GAP, kind: "orphaned-admitted-pairs", detail: "orphaned-admitted-pairs:1" }, clock.iso());
    appendFileSync(join(fx.stateDir, READINESS_FOLLOW_UPS_FILE), "{not json\n");
    const read = readReadinessGapSidecar(fx.stateDir, REPO);
    assert.deepEqual(read.records.map((record) => record.key), ["trial-1:untriggered-eligible-tasks"]);
    assert.deepEqual(read.foreign, ["trial-9:report-stale"], "a foreign repository's gap is never consumed under this identity");
    assert.equal(read.unavailable.length, 2, "an unattributed record and a malformed line are reported, not read as empty");
    assert.match(read.unavailable.join(" "), /trial-2:orphaned-admitted-pairs names no repository/);

    const first = await runOpportunityIntake(await fx.ports());
    assert.equal(first.candidate?.key, KEY);
    assert.equal(fx.landed.length, 1);

    // Restart: a fresh set of ports finds the pending feedback and routes nothing twice.
    const resumed = await runOpportunityIntake(await fx.ports());
    assert.ok(resumed.deduped.includes(KEY), "the pending feedback is existing work for the same key");
    assert.equal(resumed.candidate, undefined);
    assert.equal(fx.landed.length, 1, "no second feedback PR is landed");
    assert.equal(fx.judged.length, 1, "no second paid judgement is made");

    // Restart after triage filed the task: the stable key is still found and nothing is duplicated.
    fx.triage("W1-T9001");
    for (const entry of readdirSync(join(fx.root, "plan", "feedback"))) rmSync(join(fx.root, "plan", "feedback", entry));
    const afterTriage = await runOpportunityIntake(await fx.ports());
    assert.ok(afterTriage.deduped.includes(KEY), "an existing stable-key task is reused after a restart");
    assert.equal(fx.landed.length, 1);

    // An unreadable sidecar is unavailable evidence, never an empty source.
    rmSync(join(fx.stateDir, READINESS_FOLLOW_UPS_FILE));
    mkdirSync(join(fx.stateDir, READINESS_FOLLOW_UPS_FILE));
    const unreadable = readReadinessGapSidecar(fx.stateDir, REPO);
    assert.deepEqual(unreadable.records, []);
    assert.match(unreadable.unavailable.join(" "), /unreadable/);
    const absent = readReadinessGapSidecar(join(fx.stateDir, "nowhere"), REPO);
    assert.deepEqual(absent, { records: [], foreign: [], unavailable: [] }, "a sidecar that was never written is an observed absence");
    const thrown = collectBenchmarkReadinessCandidates({ repo: REPO, clock, readReadinessGaps: () => { throw new Error("disk gone"); } });
    assert.deepEqual(thrown.candidates, []);
    assert.match(thrown.unavailable.join(" "), /disk gone/);
  } finally { fx.cleanup(); }
});
