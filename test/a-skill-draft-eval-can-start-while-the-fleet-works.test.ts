import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fixedClock } from "#src/lib/clock.js";
import { replayIdleGate, type ReplayIdleSignal } from "#src/lib/golden-corpus.js";
import { HEADROOM_LIMIT_PCT } from "#src/lib/headroom.js";
import { loadProposalRegistry, type Proposal, type SkillEvalRecord } from "#src/lib/inbox.js";
import type { LedgerLine } from "#src/lib/ledger.js";
import { runSkillEval, skillEvalCapacityGate, SKILL_EVAL_MAX_SPEND_USD, SKILL_EVAL_STANDING_APPROVAL,
  type HeldOutSelected } from "#src/lib/skill-eval.js";
import { autoEvaluateSkillDrafts, SKILL_EVAL_AUTO_STEPS, type SkillEvalSpendFit } from "#src/lib/skill-eval-auto.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";

// W1-T14496: a staged skill draft's held-out eval can start while the fleet works. The skill eval gate asks for an
// up fleet with measured headroom, not quiet mode.

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
const ID = "skill-draft:capacity-gate";
const MARKDOWN = "---\nname: types-first\ndescription: run the type checker first\napplies-to: implement\n---\n\n"
  + "## Procedure\n\n- Run the type checker before the tests.\n";
const HEADROOM = { billingMode: "subscription" as const, session: { percentUsed: 20 }, weekly: [{ label: "all models", percentUsed: 40 }] };
const OVER = { ...HEADROOM, weekly: [{ label: "all models", percentUsed: 99 }] };
const UP: ReplayIdleSignal = { liveness: { state: "up" }, headroom: HEADROOM };
const UP_QUIET: ReplayIdleSignal = { liveness: { state: "up", quiet: true }, headroom: HEADROOM };
const OPEN_FIT: SkillEvalSpendFit = { dayCostUsd: 10, unpricedRows: 0, ceilingUsd: 500 };
const STACK = {
  pin: { provider: "claude", model: "model-under-test", effort: "high", billing: "subscription" as const, stackHash: "stack-1" },
  revisions: { harnessRevision: "h1", promptRevision: "p1", toolRevision: "t1", scorerRevision: "s1", environmentRevision: "e1" },
  stackEvidence: {},
};

/** The inputs criterion 1 names, with the answer skillEvalCapacityGate gives each. */
const CASES: { name: string; signal: ReplayIdleSignal; enabled: boolean; reason?: RegExp }[] = [
  { name: "up, no quiet flag", signal: UP, enabled: true },
  { name: "up and quiet", signal: UP_QUIET, enabled: true },
  { name: "no liveness", signal: { headroom: HEADROOM }, enabled: false, reason: /^refusing a skill eval: fleet liveness was not measured$/ },
  { name: "down", signal: { liveness: { state: "down" }, headroom: HEADROOM }, enabled: false, reason: /^refusing a skill eval: the fleet is down$/ },
  { name: "held", signal: { liveness: { state: "held" }, headroom: HEADROOM }, enabled: false, reason: /^refusing a skill eval: the fleet is held$/ },
  { name: "no headroom", signal: { liveness: { state: "up" } }, enabled: false, reason: /^refusing a skill eval: headroom was not measured$/ },
  { name: "weekly at 99%", signal: { liveness: { state: "up" }, headroom: OVER }, enabled: false,
    reason: /^refusing a skill eval: weekly \(all models\) is at 99% \(limit 95%\)$/ },
  { name: "session at the limit", signal: { liveness: { state: "up" }, headroom: { ...HEADROOM, session: { percentUsed: HEADROOM_LIMIT_PCT } } },
    enabled: false, reason: /^refusing a skill eval: session \(5h\) is at 95% \(limit 95%\)$/ },
];

function fixture(t: TestContext, opts: { idle: ReplayIdleSignal; fit?: SkillEvalSpendFit; proposal?: Partial<Proposal> }) {
  const stateDir = writeLedger([], { scope: t }).dir;
  const registryPath = join(stateDir, "inbox-proposals.json");
  writeFileSync(registryPath, JSON.stringify({ proposals: [{ id: ID, summary: "a staged draft", evidenceAnchors: [],
    skillFile: { name: "types-first", markdown: MARKDOWN }, skillFileStagedAt: "2026-10-01T00:00:00.000Z", ...opts.proposal }] }));
  const rows: LedgerLine[] = [];
  const evaluated: string[] = [];
  const input = { registryPath: () => registryPath, stateDir: () => stateDir, readIdle: async () => opts.idle,
    readSpendFit: () => opts.fit ?? OPEN_FIT, log: (row: LedgerLine) => { rows.push(row); }, clock: fixedClock(Date.parse("2026-10-13T12:00:00.000Z")) };
  const pass = () => autoEvaluateSkillDrafts(input, async (proposalId) => {
    evaluated.push(proposalId);
    return { code: 0, refusedBeforeDispatch: false };
  });
  const proposal = (): Proposal => loadProposalRegistry(registryPath).find((p) => p.id === ID)!;
  const stepRows = (step: string): LedgerLine[] => rows.filter((row) => row.step === step);
  return { pass, evaluated, proposal, stepRows };
}

const runBase = () => {
  const selection: HeldOutSelected = { ok: true, items: [], draftSha256: sha256(MARKDOWN), heldOutSetHash: "h", eligibleCount: 0 };
  const dispatched: string[] = [];
  return {
    dispatched,
    input: { selection, draftMarkdown: MARKDOWN, argv: [] as string[], stack: STACK, log: () => {},
      dispatcherFor: () => async () => { dispatched.push("attempt"); throw new Error("no dispatch"); } },
  };
};

test("W1-T14496 criterion 1: skillEvalCapacityGate opens for an up fleet with measured headroom below the limit, quiet or not, and refuses otherwise", () => {
  for (const { name, signal, enabled, reason } of CASES) {
    const gate = skillEvalCapacityGate(signal);
    assert.equal(gate.enabled, enabled, name);
    if (reason === undefined) assert.ok(gate.reason.length > 0, name);
    else assert.match(gate.reason, reason, name);
  }
  assert.match(replayIdleGate(UP).reason, /not in quiet mode/, "the replay gate refuses the first input");
});

test("W1-T14496 criterion 2: the auto pass with an up fleet and no quiet flag claims and dispatches the eval", async (t) => {
  const fx = fixture(t, { idle: UP });
  const result = await fx.pass();
  assert.deepEqual(fx.evaluated, [ID]);
  assert.equal(fx.stepRows(SKILL_EVAL_AUTO_STEPS.claimed).length, 1);
  assert.equal(fx.stepRows(SKILL_EVAL_AUTO_STEPS.waiting).length, 0);
  assert.equal(fx.proposal().skillEvalAuto?.state, "claimed");
  assert.equal(fx.proposal().skillEvalAuto?.draftSha256, sha256(MARKDOWN));
  assert.match(result.reason, /claim stays/);
});

test("W1-T14496 criterion 2: the auto pass with one headroom window at 99% waits and names that window", async (t) => {
  const fx = fixture(t, { idle: { liveness: { state: "up" }, headroom: OVER } });
  await fx.pass();
  assert.equal(fx.evaluated.length, 0);
  assert.equal(fx.stepRows(SKILL_EVAL_AUTO_STEPS.claimed).length, 0);
  const waiting = fx.stepRows(SKILL_EVAL_AUTO_STEPS.waiting);
  assert.equal(waiting.length, 1);
  assert.match(String(waiting[0]!.reason), /weekly \(all models\) is at 99%/);
  assert.equal(fx.proposal().skillEvalAuto?.state, "waiting");
});

test("W1-T14496 criterion 3: runSkillEval with an up fleet and no quiet flag passes the capacity check; a down fleet still refuses", async () => {
  for (const consent of [{ standingApproval: SKILL_EVAL_STANDING_APPROVAL }, { argv: ["--confirm-spend"] }]) {
    const up = runBase();
    const run = await runSkillEval({ ...up.input, ...consent, idle: UP });
    assert.equal(run.state === "refused" && run.reason, "too-few-held-out-tasks", JSON.stringify(Object.keys(consent)));
    assert.equal(up.dispatched.length, 0);
  }
  const down = runBase();
  const refused = await runSkillEval({ ...down.input, standingApproval: SKILL_EVAL_STANDING_APPROVAL,
    idle: { liveness: { state: "down" }, headroom: HEADROOM } });
  assert.equal(refused.state === "refused" && refused.reason, "fleet-not-idle");
  assert.equal(refused.state === "refused" && refused.dispatched, 0);
  assert.equal(down.dispatched.length, 0);
});

test("W1-T14496 criterion 4: invariant:replay-gate-unchanged replayIdleGate gives the same answer for every input in criterion 1", () => {
  const expected: Record<string, { enabled: boolean; reason: string }> = {
    "up, no quiet flag": { enabled: false,
      reason: "refusing to replay: the fleet is up and not in quiet mode, so a replay would compete with dispatch" },
    "up and quiet": { enabled: true, reason: "the fleet is idle in quiet mode and measured headroom is below the limit" },
    "no liveness": { enabled: false, reason: "refusing to replay: fleet idleness was not measured" },
    down: { enabled: false, reason: "refusing to replay: the fleet is down and not in quiet mode, so a replay would compete with dispatch" },
    held: { enabled: false, reason: "refusing to replay: the fleet is held and not in quiet mode, so a replay would compete with dispatch" },
    "no headroom": { enabled: false,
      reason: "refusing to replay: the fleet is up and not in quiet mode, so a replay would compete with dispatch" },
    "weekly at 99%": { enabled: false,
      reason: "refusing to replay: the fleet is up and not in quiet mode, so a replay would compete with dispatch" },
    "session at the limit": { enabled: false,
      reason: "refusing to replay: the fleet is up and not in quiet mode, so a replay would compete with dispatch" },
  };
  for (const { name, signal } of CASES) assert.deepEqual(replayIdleGate(signal), expected[name], name);
  assert.deepEqual(replayIdleGate({ liveness: { state: "up", quiet: true }, headroom: OVER }),
    { enabled: false, reason: "refusing to replay: weekly (all models) is at 99% (limit 95%)" });
});

test("W1-T14496 criterion 5: invariant:spend-gates-unchanged with an up fleet the spend fit, the standing approval and one eval per text still hold", async (t) => {
  const overDay = fixture(t, { idle: UP, fit: { dayCostUsd: 500 - SKILL_EVAL_MAX_SPEND_USD + 0.01, unpricedRows: 0, ceilingUsd: 500 } });
  await overDay.pass();
  assert.equal(overDay.evaluated.length, 0);
  assert.match(String(overDay.stepRows(SKILL_EVAL_AUTO_STEPS.waiting)[0]!.reason), /^daily-cost-ceiling/);

  const copy = runBase();
  const copied = await runSkillEval({ ...copy.input, idle: UP,
    standingApproval: JSON.parse(JSON.stringify(SKILL_EVAL_STANDING_APPROVAL)) as typeof SKILL_EVAL_STANDING_APPROVAL });
  assert.equal(copied.state === "refused" && copied.reason, "spend-not-confirmed");
  assert.equal(copy.dispatched.length, 0);

  const verdict: SkillEvalRecord = { draftSha256: sha256(MARKDOWN), heldOutSetHash: "h", taskIds: [], verdict: "refuse",
    reason: "no-benefit", detail: "d", delta: 0, measurableTasks: 3, totalCostUsd: 1, evaluatedAt: "2026-10-02T00:00:00.000Z" };
  const judged = fixture(t, { idle: UP, proposal: { skillEval: verdict } });
  await judged.pass();
  assert.equal(judged.evaluated.length, 0);
  assert.equal(judged.stepRows(SKILL_EVAL_AUTO_STEPS.claimed).length, 0);
});
