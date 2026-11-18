/**
 * W1-T11075 — the ci judge and the fix-progress judge resolve their own mount rows, which may name a provider,
 * and a DeepSeek-V4-Flash cash arm declared on those rows shadows each judgement. Both verdicts and whether they
 * agree are ledgered; the verdict the sweep acts on stays the primary judge's; a shadow call refused for capacity
 * or budget is ledgered and changes nothing. Every spawn here is a fake: no network and no paid call runs.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";
import { CI_JUDGE_HEADS_FILE, judgeCiEscalation, productionCiJudgePorts } from "#src/lib/ci-escalation-judge.js";
import { buildFixProgressInput } from "#src/lib/fix-progress-judge.js";
import { loadMounts, mountsPath, MountsError, validateMounts } from "#src/lib/mounts.js";
import { resolveCiJudgeMount, resolveFixProgressJudgeMount, resolveRiskJudgeMount } from "#src/lib/risk-judge.js";
import { productionFixProgressJudge } from "#src/lib/sweep.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { JUDGE_SHADOW_TRIAL_ID, type SpawnWorkerArgs, type WorkerResult } from "#src/lib/worker.js";
import { OpenWeightAllowanceExhaustedError, OpenWeightRequestTooLargeError } from "#src/lib/worker-provider.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const DEEPSEEK = "DeepSeek-V4-Flash";
const JUDGE_ROWS = `
ci_judge:
  model: haiku
  effort: low
  max_turns: 400
  context_budget: 60000
  provider: claude
  shadow:
    deployment: ${DEEPSEEK}
fix_progress_judge:
  model: haiku
  effort: low
  max_turns: 400
  context_budget: 60000
  provider: claude
  shadow:
    deployment: ${DEEPSEEK}
`;
const KNOWN = ["test/a.test.ts", "test/b.test.ts", "test/c.test.ts"];

/** The real file without its own ci_judge and fix_progress_judge rows (W1-T13364 added them). */
function realMountsWithoutJudgeRows(): string {
  return readFileSync(mountsPath(REPO_ROOT), "utf8").replace(/^(?:ci_judge|fix_progress_judge):.*\n(?:[ \t]+.*\n)*/gm, "");
}

function tmpRoot(t: { after: (fn: () => void) => void }, rows: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}judge-shadow-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, ".remudero"), { recursive: true });
  mkdirSync(join(dir, "state"), { recursive: true });
  writeFileSync(mountsPath(dir), `${realMountsWithoutJudgeRows()}\n${rows}`);
  return dir;
}

function worker(text: string, extra: Partial<WorkerResult> = {}): WorkerResult {
  return { sessionId: "s", costUsd: 0.0001, numTurns: 1, text, ...extra } as unknown as WorkerResult;
}

type Shadow = (args: SpawnWorkerArgs) => Promise<WorkerResult>;
const isShadow = (args: SpawnWorkerArgs) => args.routingTrial?.id === JUDGE_SHADOW_TRIAL_ID;

function ledger() {
  const out: Array<{ step: string; extra: Record<string, unknown> }> = [];
  return { out, log: (step: string, extra: Record<string, unknown> = {}) => void out.push({ step, extra }),
    shadowRows: () => out.filter((row) => row.step.startsWith("judge_shadow.")) };
}

async function ciPass(root: string, primary: string, shadow: Shadow) {
  const rows = ledger();
  const spawned: SpawnWorkerArgs[] = [];
  const posted: string[] = [];
  // Each pass judges the same head afresh: the judged-heads file would otherwise skip it.
  rmSync(join(root, "state", CI_JUDGE_HEADS_FILE), { force: true });
  const result = await judgeCiEscalation(productionCiJudgePorts({
    owner: "o", repo: "r", repoRoot: root, stateDir: join(root, "state"), log: rows.log,
    ghJson: async () => [{ number: 7, head: { sha: "abc1234" } }],
    ghText: async (args) => {
      if (args.includes("POST")) posted.push(args.find((a) => a.startsWith("description="))!);
      return args.includes("--name-only") ? "src/a.ts\n" : "diff text";
    },
    suiteIds: () => KNOWN,
    floor: () => ({ suites: ["test/a.test.ts"], fullRun: false }),
    spawn: async (args) => { spawned.push(args); return isShadow(args) ? shadow(args) : worker(primary); },
  }));
  return { result, rows, spawned, posted };
}

async function fixPass(root: string, primary: string, shadow: Shadow) {
  const rows = ledger();
  const spawned: SpawnWorkerArgs[] = [];
  const judge = productionFixProgressJudge({ cwd: root, settingsFile: join(root, "settings", "worker.json"), log: rows.log,
    spawn: async (args) => { spawned.push(args); return isShadow(args) ? shadow(args) : worker(primary); } });
  const verdict = await judge(buildFixProgressInput({ taskId: "W1-T1", prNumber: 9, headSha: "def5678", currentRed: ["ci"], ledger: [] }));
  return { verdict, rows, spawned };
}

const CI_PRIMARY = '{"add":["test/b.test.ts"],"escalateFull":false,"reason":"b reads a"}';
const FIX_PRIMARY = 'FIX_PROGRESS: {"verdict":"continue","reason":"the red shrank"}';

test("W1-T11075 criterion 1: the ci and fix-progress judges resolve their own mount rows, a DeepSeek-V4-Flash cash shadow is ledgered beside each judgement, and the verdict acted on is still the primary's", async (t) => {
  // Each judge resolves its OWN row, which names a provider; with no row, the risk judge's provider-less cell.
  const root = tmpRoot(t, JUDGE_ROWS);
  const mounts = loadMounts(mountsPath(root));
  assert.equal(resolveCiJudgeMount(mounts).provider, "claude");
  assert.deepEqual(resolveCiJudgeMount(mounts).shadow, { provider: "cash", deployment: DEEPSEEK });
  assert.equal(resolveFixProgressJudgeMount(mounts).provider, "claude");
  const plain = loadMounts(mountsPath(tmpRoot(t, "")));
  assert.equal(plain.ci_judge, undefined);
  assert.equal(plain.fix_progress_judge, undefined);
  assert.equal(resolveCiJudgeMount(plain).model, resolveRiskJudgeMount(plain).model);
  assert.equal(resolveCiJudgeMount(plain).provider, undefined);
  assert.equal(resolveFixProgressJudgeMount(plain).shadow, undefined);

  // The ci judge: the primary rides its row's provider; the shadow asks the pinned cash deployment with the same
  // prompt and no tools; a disagreement is ledgered with both verdicts; the posted status is the primary's.
  const ci = await ciPass(root, CI_PRIMARY, async () => worker('{"add":[],"escalateFull":true,"reason":"too wide"}', { routedModel: DEEPSEEK }));
  assert.deepEqual(ci.result.judged, [7]);
  const [primaryArgs, shadowArgs] = ci.spawned;
  assert.equal(primaryArgs!.mountProvider, "claude");
  assert.equal(shadowArgs!.mountProvider, "cash");
  assert.deepEqual(shadowArgs!.routingTrial?.models, [DEEPSEEK]);
  assert.equal(shadowArgs!.routingTrial?.arm, "cash");
  assert.deepEqual(shadowArgs!.tools, []);
  assert.equal(shadowArgs!.prompt, primaryArgs!.prompt);
  const paired = ci.rows.shadowRows();
  assert.equal(paired.length, 1);
  assert.equal(paired[0]!.step, "judge_shadow.paired");
  assert.equal(paired[0]!.extra.surface, "ci-judge");
  assert.equal(paired[0]!.extra.decision_key, "PR7@abc1234");
  assert.equal(paired[0]!.extra.agreement, false);
  assert.deepEqual((paired[0]!.extra.primary_verdict as { add: string[] }).add, ["test/b.test.ts"]);
  assert.equal((paired[0]!.extra.shadow_verdict as { escalateFull: boolean }).escalateFull, true);
  assert.equal(paired[0]!.extra.shadow_deployment, DEEPSEEK);
  assert.deepEqual(ci.posted, ['description=ci-judge {"add":["test/b.test.ts"],"escalateFull":false}']);
  const agreeing = await ciPass(root, CI_PRIMARY, async () => worker('{"add":["test/b.test.ts"],"escalateFull":false,"reason":"same"}'));
  assert.equal(agreeing.rows.shadowRows()[0]!.extra.agreement, true);

  // The fix-progress judge: the same contract; the verdict returned to the sweep is the primary's.
  const fix = await fixPass(root, FIX_PRIMARY, async () => worker('FIX_PROGRESS: {"verdict":"escalate","reason":"loop","loop":"oscillation"}'));
  assert.deepEqual(fix.verdict, { verdict: "continue", reason: "the red shrank" });
  assert.equal(fix.spawned[0]!.mountProvider, "claude");
  assert.deepEqual(fix.spawned[1]!.routingTrial?.models, [DEEPSEEK]);
  const fixRow = fix.rows.shadowRows();
  assert.equal(fixRow.length, 1);
  assert.equal(fixRow[0]!.step, "judge_shadow.paired");
  assert.equal(fixRow[0]!.extra.surface, "fix-progress");
  assert.equal(fixRow[0]!.extra.decision_key, "PR9@def5678");
  assert.equal(fixRow[0]!.extra.agreement, false);
  assert.equal((fixRow[0]!.extra.primary_verdict as { verdict: string }).verdict, "continue");
  assert.equal((fixRow[0]!.extra.shadow_verdict as { verdict: string }).verdict, "escalate");

  // A shadow refused for capacity or budget, returned or thrown, is ledgered and changes nothing.
  const refusals: Array<[string, Shadow]> = [
    ["capacity", async () => worker("", { isError: true, openWeightCapacityShortfall: {
      reason: "capacity_shortfall", deployment: DEEPSEEK, estimatedTokens: 30_000, limitTokens: 20_000 } })],
    ["capacity", async () => { throw new OpenWeightRequestTooLargeError({ estimatedTokens: 30_000, capability: "economy", considered: [DEEPSEEK] }); }],
    ["budget", async () => worker("", { isError: true, budgetRefused: true, cashAllowanceLimit: "fleet" })],
    ["budget", async () => { throw new OpenWeightAllowanceExhaustedError({ committedUsd: 10, capUsd: 10, wantUsd: 0.001, utcDay: "2026-11-16" }); }],
  ];
  for (const [refusal, shadow] of refusals) {
    const ciRefused = await ciPass(root, CI_PRIMARY, shadow);
    assert.deepEqual(ciRefused.posted, ci.posted, `ci ${refusal}: the posted status is unchanged`);
    assert.deepEqual(ciRefused.result, ci.result);
    assert.deepEqual(ciRefused.rows.shadowRows().map((row) => [row.step, row.extra.refusal]), [["judge_shadow.refused", refusal]]);
    const fixRefused = await fixPass(root, FIX_PRIMARY, shadow);
    assert.deepEqual(fixRefused.verdict, fix.verdict, `fix-progress ${refusal}: the verdict is unchanged`);
    assert.deepEqual(fixRefused.rows.shadowRows().map((row) => [row.step, row.extra.refusal]), [["judge_shadow.refused", refusal]]);
  }

  // Without a shadow arm on the row, no shadow call is made and nothing is ledgered.
  const bare = tmpRoot(t, JUDGE_ROWS.replace(/\n {2}shadow:\n {4}deployment: .*/g, ""));
  const unshadowed = await ciPass(bare, CI_PRIMARY, async () => assert.fail("no shadow arm is declared"));
  assert.equal(unshadowed.spawned.length, 1);
  assert.deepEqual(unshadowed.rows.shadowRows(), []);
});

test("W1-T11075: a shadow that fails for another reason, or answers unparseably, is ledgered unavailable and changes nothing", async (t) => {
  const root = tmpRoot(t, JUDGE_ROWS);
  const thrown = await fixPass(root, FIX_PRIMARY, async () => { throw new Error("endpoint reset"); });
  assert.deepEqual(thrown.verdict, { verdict: "continue", reason: "the red shrank" });
  assert.deepEqual(thrown.rows.shadowRows().map((row) => [row.step, row.extra.reason]), [["judge_shadow.unavailable", "endpoint reset"]]);
  const garbled = await ciPass(root, CI_PRIMARY, async () => worker("no json here"));
  assert.deepEqual(garbled.rows.shadowRows().map((row) => [row.step, row.extra.reason]), [["judge_shadow.unavailable", "unparseable shadow verdict"]]);
  const failed = await ciPass(root, CI_PRIMARY, async () => worker("", { isError: true, subtype: "error_during_execution" } as never));
  assert.equal(failed.rows.shadowRows()[0]!.step, "judge_shadow.unavailable");
  assert.deepEqual(failed.posted, garbled.posted);
});

test("W1-T11075: an unreadable suite list ledgers the ci shadow unavailable, asks no shadow, and posts the primary's verdict", async (t) => {
  const root = tmpRoot(t, JUDGE_ROWS);
  for (const failure of [new Error("git ls-files exploded"), "plain string failure"]) {
    const rows = ledger();
    const spawned: SpawnWorkerArgs[] = [];
    const posted: string[] = [];
    rmSync(join(root, "state", CI_JUDGE_HEADS_FILE), { force: true });
    const result = await judgeCiEscalation(productionCiJudgePorts({
      owner: "o", repo: "r", repoRoot: root, stateDir: join(root, "state"), log: rows.log,
      ghJson: async () => [{ number: 7, head: { sha: "abc1234" } }],
      ghText: async (args) => {
        if (args.includes("POST")) posted.push(args.find((a) => a.startsWith("description="))!);
        return args.includes("--name-only") ? "src/a.ts\n" : "diff text";
      },
      // The shadow reads the list first (inside `judge`), then the pass reads it to parse the primary: only
      // the shadow's read fails, so the primary's verdict is still parsed and posted.
      suiteIds: (() => { let calls = 0; return async () => { if (++calls === 1) throw failure; return KNOWN; }; })(),
      floor: () => ({ suites: ["test/a.test.ts"], fullRun: false }),
      spawn: async (args) => { spawned.push(args); return worker(CI_PRIMARY); },
    }));
    assert.deepEqual(result.judged, [7]);
    assert.equal(spawned.length, 1,"no shadow call is made without a suite list");
    assert.deepEqual(rows.shadowRows().map((row) => [row.step, row.extra.surface, row.extra.reason]),
      [["judge_shadow.unavailable", "ci-judge", `suite list unreadable: ${failure instanceof Error ? failure.message : failure}`]]);
    assert.deepEqual(posted, ['description=ci-judge {"add":["test/b.test.ts"],"escalateFull":false}']);
  }
});

test("W1-T11075: the fix-progress judge asks no shadow when it has no ledger to write it to", async (t) => {
  const root = tmpRoot(t, JUDGE_ROWS);
  const spawned: SpawnWorkerArgs[] = [];
  const judge = productionFixProgressJudge({ cwd: root, settingsFile: join(root, "settings", "worker.json"),
    spawn: async (args) => { spawned.push(args); return worker(FIX_PRIMARY); } });
  await judge(buildFixProgressInput({ prNumber: 9, headSha: "def5678", currentRed: ["ci"], ledger: [] }));
  assert.equal(spawned.length, 1);
});

test("W1-T11075: a judge row's shadow arm must be a cash deployment", () => {
  const base = parseYaml(readFileSync(mountsPath(REPO_ROOT), "utf8")) as Record<string, unknown>;
  const row = (shadow: unknown) => ({ ...base, ci_judge: { model: "haiku", effort: "low", max_turns: 400, context_budget: 60000, shadow } });
  assert.deepEqual(validateMounts(row({ deployment: DEEPSEEK, effort: "low", provider: "openweight" })).ci_judge?.shadow,
    { provider: "cash", deployment: DEEPSEEK, effort: "low" });
  // W1-T12417: a bare name is a decision_models row or a cash deployment id; a name that is neither is refused.
  assert.deepEqual(validateMounts(row(DEEPSEEK)).ci_judge?.shadow, { provider: "cash", deployment: DEEPSEEK });
  assert.throws(() => validateMounts(row("not a deployment")), MountsError);
  assert.throws(() => validateMounts(row({ deployment: DEEPSEEK, provider: "claude" })), /shadow.provider' must be cash/);
  assert.throws(() => validateMounts(row({ deployment: "bad id!" })), /shadow.deployment/);
  assert.throws(() => validateMounts(row({ deployment: DEEPSEEK, effort: "" })), /shadow.effort/);
});
