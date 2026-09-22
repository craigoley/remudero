/**
 * THE VERIFY-HUMAN JUDGE'S CONTINUE ARM (operator ruling 2026-09-22).
 *
 * An `automate` verdict used to end as an inbox proposal, so a shard the judge read as safe still
 * waited for the operator to ratify it — the outcome the judge exists to remove. Now a filing-time
 * risk judge reads the record: PROCEED releases it through W1-T3206's `ratify.approved` row (a
 * machine author riding the row), ESCALATE puts it in front of the operator with the risk judge's
 * reason, and NO DECISION changes nothing.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { verifyHumanCadence } from "../src/lib/measurement-cadence.js";
import { RELEASE_LEDGER_STEP, releasedTaskIds } from "../src/lib/plan.js";
import type { RiskJudgeVerdict } from "../src/lib/risk-judge.js";
import { approveParkedTask } from "../src/run-task.js";
import {
  VERIFY_HUMAN_RELEASE_ESCALATED_STEP,
  VERIFY_HUMAN_RELEASE_UNAVAILABLE_STEP,
  applyAutomateVerdict,
  awaitingRelease,
  observedStateKey,
  releaseEscalatedKeys,
  type ShardUnderJudgement,
  type VerifyHumanReleaseOutcome,
  type VerifyHumanVerdict,
} from "../src/lib/verify-human-judge.js";
import { releaseAutomatedShard, type MachineReleaseProvenance } from "../src/lib/verify-human-release.js";

const SHARD: ShardUnderJudgement = {
  id: "W1-T9101",
  title: "wire the ratchet the CI-learning loop found",
  rationale: "",
  acceptance: ["the ratchet refuses growth | unit test: refuses growth"],
  ageDays: 9,
  depsAllMerged: true,
  citedInSrc: false,
};
const AUTOMATE: VerifyHumanVerdict = { decision: "automate", reason: "a bounded gate fix the fleet can build" };

const task = (over: Record<string, unknown> = {}) =>
  ({
    id: SHARD.id,
    title: SHARD.title,
    repo: "remudero",
    type: "implement",
    verify: "human",
    status: "queued",
    depends_on: [],
    files: ["src/lib/some-gate.ts"],
    acceptance: [{ claim: "refuses growth", proof: "unit test: refuses growth" }],
    ...over,
  }) as never;

const risk = (over: Partial<RiskJudgeVerdict> = {}): RiskJudgeVerdict => ({
  verdict: "low",
  reasons: ["touches one gate module with a declared test"],
  confidence: 0.92,
  ...over,
});

function releaseDeps(opts: { verdict?: RiskJudgeVerdict | Error; taskOver?: Record<string, unknown> | null; writeCode?: number } = {}) {
  const calls = { judged: 0, written: [] as [string, MachineReleaseProvenance][] };
  return {
    calls,
    deps: {
      task: () => (opts.taskOver === null ? undefined : task(opts.taskOver ?? {})),
      riskJudge: async () => {
        calls.judged += 1;
        if (opts.verdict instanceof Error) throw opts.verdict;
        return opts.verdict ?? risk();
      },
      writeRelease: (taskId: string, provenance: MachineReleaseProvenance) => {
        calls.written.push([taskId, provenance]);
        return { code: opts.writeCode ?? 0, message: opts.writeCode ? "refused" : "released" };
      },
    },
  };
}

// ── releaseAutomatedShard: the decision itself ───────────────────────────────────────────────────

test("PROCEED releases the task, and the row names a MACHINE author with both judges' reasons", async () => {
  const { calls, deps } = releaseDeps();
  const out = await releaseAutomatedShard(SHARD, AUTOMATE, deps);
  assert.equal(out.kind, "released");
  assert.equal(calls.written.length, 1);
  const [id, provenance] = calls.written[0]!;
  assert.equal(id, SHARD.id);
  // Law 5: `ratify.approved` was only ever an operator's row, so a machine-written one says so.
  assert.equal(provenance.author_class, "machine");
  assert.equal(provenance.released_by, "verify-human-judge");
  assert.equal(provenance.judge_reason, AUTOMATE.reason);
  assert.equal(provenance.risk_verdict, "low");
  assert.equal(provenance.risk_confidence, 0.92);
  assert.deepEqual(provenance.risk_reasons, ["touches one gate module with a declared test"]);
});

test("a HIGH risk verdict ESCALATES and releases nothing", async () => {
  const { calls, deps } = releaseDeps({ verdict: risk({ verdict: "high" }) });
  const out = await releaseAutomatedShard(SHARD, AUTOMATE, deps);
  assert.equal(out.kind, "escalated");
  assert.equal(calls.written.length, 0);
});

test("a LOW-CONFIDENCE verdict escalates too — a judge that is unsure never releases", async () => {
  const { calls, deps } = releaseDeps({ verdict: risk({ confidence: 0.1 }) });
  const out = await releaseAutomatedShard(SHARD, AUTOMATE, deps);
  assert.equal(out.kind, "escalated");
  assert.equal(calls.written.length, 0);
});

test("an UNAVAILABLE risk judge releases nothing — an outage means more review, never an unjudged dispatch", async () => {
  const { calls, deps } = releaseDeps({ verdict: risk({ availability: "unavailable" }) });
  const out = await releaseAutomatedShard(SHARD, AUTOMATE, deps);
  assert.equal(out.kind, "unavailable");
  assert.equal(calls.written.length, 0);
});

test("availability 'available' is NOT the unavailable signal — only the explicit marker withholds", async () => {
  const { calls, deps } = releaseDeps({ verdict: risk({ availability: "available" }) });
  const out = await releaseAutomatedShard(SHARD, AUTOMATE, deps);
  assert.equal(out.kind, "released");
  assert.equal(calls.written.length, 1);
});

test("a risk judge that THROWS releases nothing", async () => {
  const { calls, deps } = releaseDeps({ verdict: new Error("spawn died") });
  const out = await releaseAutomatedShard(SHARD, AUTOMATE, deps);
  assert.equal(out.kind, "unavailable");
  assert.match(out.reason, /spawn died/);
  assert.equal(calls.written.length, 0);
});

test("a shard that resolves to no record, or is no longer parked, spends NOTHING on the risk judge", async () => {
  for (const taskOver of [null, { verify: "auto" }, { status: "merged" }]) {
    const { calls, deps } = releaseDeps({ taskOver });
    const out = await releaseAutomatedShard(SHARD, AUTOMATE, deps);
    assert.equal(out.kind, "unavailable");
    assert.equal(calls.judged, 0, `no judge spend for ${JSON.stringify(taskOver)}`);
  }
});

test("a release row that did not land is not reported as a release", async () => {
  const { deps } = releaseDeps({ writeCode: 2 });
  const out = await releaseAutomatedShard(SHARD, AUTOMATE, deps);
  assert.equal(out.kind, "unavailable");
});

// ── applyAutomateVerdict: continue or escalate ────────────────────────────────────────────────────

function hooks(outcome?: VerifyHumanReleaseOutcome) {
  const staged: { id: string; summary: string }[] = [];
  const rows: Record<string, unknown>[] = [];
  return {
    staged,
    rows,
    hooks: {
      release: outcome === undefined ? undefined : async () => outcome,
      stageProposal: (p: { id: string; summary: string }) => void staged.push(p),
      appendRow: (r: Record<string, unknown>) => void rows.push(r),
      runId: "RUN",
    },
  };
}

test("WITH NO RELEASE HOOK the automate arm is exactly the prior behaviour: an automation proposal", async () => {
  const h = hooks();
  assert.equal(await applyAutomateVerdict(SHARD, AUTOMATE, h.hooks as never), "automated");
  assert.deepEqual(h.staged.map((p) => p.id), [`verify-human-automate:${SHARD.id}`]);
});

test("A RELEASED shard stages nothing — nothing is waiting on anyone", async () => {
  const h = hooks({ kind: "released", reason: "low risk" });
  assert.equal(await applyAutomateVerdict(SHARD, AUTOMATE, h.hooks as never), "released");
  assert.equal(h.staged.length, 0);
});

test("AN ESCALATED release goes to the operator WITH the risk judge's reason, and is ledgered once per state", async () => {
  const h = hooks({ kind: "escalated", reason: "high-risk verdict at confidence 0.90 — touches CI" });
  assert.equal(await applyAutomateVerdict(SHARD, AUTOMATE, h.hooks as never), "needsOperator");
  assert.deepEqual(h.staged.map((p) => p.id), [`verify-human:${SHARD.id}`]);
  assert.match(h.staged[0]!.summary, /the risk judge escalated this release: high-risk verdict/);
  assert.equal(h.rows.length, 1);
  assert.equal(h.rows[0]!.step, VERIFY_HUMAN_RELEASE_ESCALATED_STEP);
  assert.equal(h.rows[0]!.observed_state, observedStateKey(SHARD));
});

test("NO DECISION keeps the prior proposal AND records why, so it is retried rather than lost", async () => {
  const h = hooks({ kind: "unavailable", reason: "the risk judge reached no decision" });
  assert.equal(await applyAutomateVerdict(SHARD, AUTOMATE, h.hooks as never), "automated");
  assert.deepEqual(h.staged.map((p) => p.id), [`verify-human-automate:${SHARD.id}`]);
  assert.equal(h.rows[0]!.step, VERIFY_HUMAN_RELEASE_UNAVAILABLE_STEP);
});

// ── awaitingRelease: the backfill population ─────────────────────────────────────────────────────

test("THE BACKFILL admits only a settled automate verdict that was neither released nor escalated", () => {
  const other: ShardUnderJudgement = { ...SHARD, id: "W1-T9102" };
  const key = observedStateKey(SHARD);
  const verdicts = new Map<string, VerifyHumanVerdict>([
    [key, AUTOMATE],
    [observedStateKey(other), { decision: "needs_operator", reason: "a real ask" }],
  ]);
  assert.deepEqual(awaitingRelease([SHARD, other], verdicts, new Set(), new Set()).map((s) => s.id), [SHARD.id]);
  assert.deepEqual(awaitingRelease([SHARD], verdicts, new Set([SHARD.id]), new Set()), [], "already released");
  assert.deepEqual(awaitingRelease([SHARD], verdicts, new Set(), new Set([key])), [], "already escalated for this state");
  const failed = new Map([[key, { ...AUTOMATE, judgeFailed: true as const }]]);
  assert.deepEqual(awaitingRelease([SHARD], failed, new Set(), new Set()), [], "a failed verdict is not a decision");
});

test("releaseEscalatedKeys reads the observed states the risk judge already escalated", () => {
  const keys = releaseEscalatedKeys([
    { step: VERIFY_HUMAN_RELEASE_ESCALATED_STEP, observed_state: "s1" },
    { step: "verify_human.judged", observed_state: "s2" },
  ]);
  assert.deepEqual([...keys], ["s1"]);
});

// ── verifyHumanCadence: the daemon's loop, end to end over fakes ─────────────────────────────────

function cadenceOpts(over: Record<string, unknown> = {}) {
  const staged: string[] = [];
  const judged: string[] = [];
  const released: string[] = [];
  return {
    staged,
    judged,
    released,
    opts: {
      shards: [SHARD],
      priorVerdicts: new Map<string, VerifyHumanVerdict>(),
      judge: async (s: ShardUnderJudgement) => {
        judged.push(s.id);
        return AUTOMATE;
      },
      stageProposal: (p: { id: string }) => void staged.push(p.id),
      appendRow: () => {},
      runId: "CADENCE",
      release: async (s: ShardUnderJudgement): Promise<VerifyHumanReleaseOutcome> => {
        released.push(s.id);
        return { kind: "released", reason: "low risk" };
      },
      ...over,
    },
  };
}

test("THE CADENCE releases an automate verdict it judges this tick, and stages no proposal for it", async () => {
  const c = cadenceOpts();
  const result = await verifyHumanCadence(c.opts as never);
  assert.deepEqual(result.released, [SHARD.id]);
  assert.deepEqual(result.automated, []);
  assert.deepEqual(c.staged, []);
});

test("THE CADENCE backfills an EARLIER automate verdict without re-judging it", async () => {
  const c = cadenceOpts({ priorVerdicts: new Map([[observedStateKey(SHARD), AUTOMATE]]) });
  const result = await verifyHumanCadence(c.opts as never);
  assert.deepEqual(c.judged, [], "the verdict is settled — no second judge spend");
  assert.deepEqual(c.released, [SHARD.id]);
  assert.deepEqual(result.released, [SHARD.id]);
});

test("THE CADENCE never re-judges or re-releases a task that is already released", async () => {
  const c = cadenceOpts({ releasedIds: new Set([SHARD.id]) });
  const result = await verifyHumanCadence(c.opts as never);
  assert.deepEqual(c.judged, []);
  assert.deepEqual(c.released, []);
  assert.deepEqual(result.released, []);
});

// ── approveParkedTask: the row, and the dispatcher reading it ─────────────────────────────────────

const parked = { id: SHARD.id, title: "t", repo: "remudero", type: "implement", verify: "human", status: "queued", depends_on: [] };
const planOf = (t: Record<string, unknown>) => ({ tasks: [t], byId: new Map([[t.id as string, t]]) }) as never;

test("THE OPERATOR'S OWN RELEASE ROW is byte-identical when no provenance is supplied", () => {
  const rows: Record<string, unknown>[] = [];
  approveParkedTask(SHARD.id, {
    plan: planOf(parked),
    ledgerPath: "/nonexistent",
    runId: "APPROVE",
    ledgerLines: [],
    append: ((_: string, r: Record<string, unknown>) => void rows.push(r)) as never,
  });
  assert.deepEqual(rows[0], { run_id: "APPROVE", task_id: SHARD.id, step: RELEASE_LEDGER_STEP, released: "verify-human" });
});

test("A MACHINE release row carries its author, and the dispatcher's own reader still honours it", () => {
  const rows: Record<string, unknown>[] = [];
  approveParkedTask(SHARD.id, {
    plan: planOf(parked),
    ledgerPath: "/nonexistent",
    runId: "VH",
    ledgerLines: [],
    append: ((_: string, r: Record<string, unknown>) => void rows.push(r)) as never,
    provenance: { author_class: "machine", released_by: "verify-human-judge" },
  });
  assert.equal(rows[0]!.author_class, "machine");
  assert.equal(rows[0]!.released_by, "verify-human-judge");
  // isDispatchEligible admits a verify:human task whose id this reader returns.
  assert.ok(releasedTaskIds([JSON.stringify(rows[0])]).has(SHARD.id));
});

// ── productionVerifyHumanRelease: the real ledger write, end to end ───────────────────────────────

test("PRODUCTION WIRING writes a real ratify.approved row the dispatcher reads, carrying the machine author", async () => {
  const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { productionVerifyHumanRelease } = await import("../src/run-task.js");
  const { RMD_TMP_PREFIX } = await import("../src/lib/tmp.js");
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}vh-release-`));
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    const plan = { tasks: [task()], byId: new Map([[SHARD.id, task()]]) } as never;
    const hook = productionVerifyHumanRelease(plan, dir, ledgerPath, "RUN-PROD", { riskJudge: async () => risk() });
    const out = await hook(SHARD, AUTOMATE);
    assert.equal(out.kind, "released");
    const lines = readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean);
    assert.ok(releasedTaskIds(lines).has(SHARD.id), "the dispatcher's own reader sees the release");
    const row = JSON.parse(lines.find((l) => l.includes(RELEASE_LEDGER_STEP))!);
    assert.equal(row.author_class, "machine");
    assert.equal(row.released_by, "verify-human-judge");
    // A second pass is idempotent: approveParkedTask refuses to write a second row.
    await hook(SHARD, AUTOMATE);
    const again = readFileSync(ledgerPath, "utf8").split("\n").filter((l) => l.includes(RELEASE_LEDGER_STEP));
    assert.equal(again.length, 1, "exactly one release row, however many passes");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PRODUCTION WIRING, REAL JUDGE CONSTRUCTION: this repo's mounts resolve and the reply is parsed, with no model call", async () => {
  const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { dirname, join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { RMD_TMP_PREFIX } = await import("../src/lib/tmp.js");
  const { productionVerifyHumanRelease } = await import("../src/run-task.js");
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}vh-release-real-`));
  let spawned = 0;
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    const plan = { tasks: [task()], byId: new Map([[SHARD.id, task()]]) } as never;
    const spawn = (async () => {
      spawned += 1;
      return { text: "RISK_VERDICT: low\nRISK_CONFIDENCE: 0.9\nRISK_REASON: one gate module, declared test", costUsd: 0, numTurns: 1 };
    }) as never;
    const hook = productionVerifyHumanRelease(plan, repoRoot, ledgerPath, "RUN-REAL", { spawn });
    const out = await hook(SHARD, AUTOMATE);
    assert.equal(out.kind, "released", JSON.stringify(out));
    assert.equal(spawned, 1, "exactly one judge spawn");
    assert.ok(releasedTaskIds(readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean)).has(SHARD.id));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
