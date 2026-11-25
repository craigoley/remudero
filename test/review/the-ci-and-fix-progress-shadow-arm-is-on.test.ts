/**
 * W1-T13364 — the repo's real .remudero/mounts.yaml turns the cash shadow arm of the ci judge and the fix-progress
 * judge on. The primary judge stays the risk judge's cell with no provider, and the sweep acts only on its verdict.
 * Every spawn here is a fake: no network and no paid call runs.
 */
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";
import { CI_JUDGE_HEADS_FILE, judgeCiEscalation, productionCiJudgePorts } from "#src/lib/ci-escalation-judge.js";
import { buildFixProgressInput } from "#src/lib/fix-progress-judge.js";
import { loadMounts, mountsPath, validateMounts, type Mounts } from "#src/lib/mounts.js";
import { resolveCiJudgeMount, resolveFixProgressJudgeMount, resolveRiskJudgeMount } from "#src/lib/risk-judge.js";
import { productionFixProgressJudge } from "#src/lib/sweep.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { JUDGE_SHADOW_TRIAL_ID, type SpawnWorkerArgs, type WorkerResult } from "#src/lib/worker.js";
import { OPENWEIGHT_CONTEXT_WINDOWS, OPENWEIGHT_RESPONSE_FORMATS, openWeightPriceFor } from "#src/lib/worker-provider.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const DEEPSEEK = "DeepSeek-V4-Flash";
const FIELDS = ["model", "effort", "maxTurns", "contextBudget"] as const;

/** Each way a judge's resolved mount differs from the risk judge's cell; empty when the copy is true. */
function splitsFromRiskCell(mounts: Mounts): string[] {
  const cell = resolveRiskJudgeMount(mounts);
  const out: string[] = [];
  for (const [name, mount] of [["ci_judge", resolveCiJudgeMount(mounts)], ["fix_progress_judge", resolveFixProgressJudgeMount(mounts)]] as const) {
    for (const field of FIELDS) if (mount[field] !== cell[field]) out.push(`${name}.${field}: ${mount[field]} is not ${cell[field]}`);
    if (mount.provider !== undefined) out.push(`${name} names the provider ${mount.provider}`);
  }
  return out;
}

/** A temporary root that holds an unchanged copy of the real mounts file. */
function realRoot(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}shadow-arm-on-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, ".remudero"), { recursive: true });
  mkdirSync(join(dir, "state"), { recursive: true });
  copyFileSync(mountsPath(REPO_ROOT), mountsPath(dir));
  return dir;
}

function worker(text: string): WorkerResult {
  return { sessionId: "s", costUsd: 0.0001, numTurns: 1, text, routedModel: DEEPSEEK } as unknown as WorkerResult;
}

const isShadow = (args: SpawnWorkerArgs) => args.routingTrial?.id === JUDGE_SHADOW_TRIAL_ID;

function ledger() {
  const out: Array<{ step: string; extra: Record<string, unknown> }> = [];
  return { log: (step: string, extra: Record<string, unknown> = {}) => void out.push({ step, extra }),
    shadowRows: () => out.filter((row) => row.step.startsWith("judge_shadow.")) };
}

test("W1-T13364 criterion 1: invariant:the-primary-judge-is-unchanged — each judge's row equals the risk judge's cell and names no provider, and a changed cell turns the guard red", () => {
  const real = loadMounts(mountsPath(REPO_ROOT));
  assert.notEqual(real.ci_judge, undefined);
  assert.notEqual(real.fix_progress_judge, undefined);
  assert.deepEqual(splitsFromRiskCell(real), []);

  // The guard guards: in a copy, raise the effort of every routed cell that ties the cheapest one (the real file
  // has two equal cells, docs and plan-lint), so the risk judge's cell moves and the rows no longer equal it.
  const cell = resolveRiskJudgeMount(real);
  const otherEffort = Object.keys(real.efforts).sort((x, y) => real.efforts[y]! - real.efforts[x]!).find((effort) => effort !== cell.effort)!;
  const copy = parseYaml(readFileSync(mountsPath(REPO_ROOT), "utf8")) as { routes: Record<string, Record<string, Record<string, Record<string, unknown>>>> };
  let changed = 0;
  for (const byRisk of Object.values(copy.routes)) for (const byClass of Object.values(byRisk)) for (const row of Object.values(byClass)) {
    if (row.model !== cell.model || row.effort !== cell.effort) continue;
    row.effort = otherEffort;
    changed += 1;
  }
  assert.ok(changed > 0);
  assert.notEqual(splitsFromRiskCell(validateMounts(copy)).length, 0);
});

test("W1-T13364 criterion 2: the real file loads and each row carries the DeepSeek-V4-Flash cash shadow arm, a deployment with a context, a price and a request shape", () => {
  const real = loadMounts(mountsPath(REPO_ROOT));
  // W1-T14841 (Craig, 2026-11-25): both rows draw from the auto pool; DeepSeek-V4-Flash answers while it is empty.
  const arm = { provider: "auto", deployment: "auto", fallback: { provider: "cash", deployment: DEEPSEEK } };
  assert.deepEqual(resolveCiJudgeMount(real).shadow, arm);
  assert.deepEqual(resolveFixProgressJudgeMount(real).shadow, arm);
  assert.ok(OPENWEIGHT_CONTEXT_WINDOWS[DEEPSEEK]!.totalTokens > 0);
  assert.ok(openWeightPriceFor(DEEPSEEK).inputUsdPerMillion > 0);
  assert.ok(OPENWEIGHT_RESPONSE_FORMATS[DEEPSEEK]!.length > 0);
});

test("W1-T13364 criterion 3: invariant:the-shadow-is-advisory — with the real file each judgement ledgers one judge_shadow.paired row and acts on the primary verdict", async (t) => {
  const root = realRoot(t);

  const ciRows = ledger();
  const ciSpawned: SpawnWorkerArgs[] = [];
  const posted: string[] = [];
  rmSync(join(root, "state", CI_JUDGE_HEADS_FILE), { force: true });
  const result = await judgeCiEscalation(productionCiJudgePorts({
    owner: "o", repo: "r", repoRoot: root, stateDir: join(root, "state"), log: ciRows.log,
    ghJson: async () => [{ number: 7, head: { sha: "abc1234" } }],
    ghText: async (args) => {
      if (args.includes("POST")) posted.push(args.find((a) => a.startsWith("description="))!);
      return args.includes("--name-only") ? "src/a.ts\n" : "diff text";
    },
    suiteIds: () => ["test/a.test.ts", "test/b.test.ts", "test/c.test.ts"],
    floor: () => ({ suites: ["test/a.test.ts"], fullRun: false }),
    spawn: async (args) => {
      ciSpawned.push(args);
      return worker(isShadow(args) ? '{"add":[],"escalateFull":true,"reason":"too wide"}' : '{"add":["test/b.test.ts"],"escalateFull":false,"reason":"b reads a"}');
    },
  }));
  assert.deepEqual(result.judged, [7]);
  assert.equal(ciSpawned.length, 2);
  assert.equal(ciSpawned[0]!.mountProvider, undefined);
  assert.equal(ciSpawned[0]!.model, resolveRiskJudgeMount(loadMounts(mountsPath(root))).model);
  assert.deepEqual(ciSpawned[1]!.routingTrial?.models, [DEEPSEEK]);
  assert.deepEqual(ciRows.shadowRows().map((row) => [row.step, row.extra.surface, row.extra.shadow_deployment, row.extra.agreement]),
    [["judge_shadow.paired", "ci-judge", DEEPSEEK, false]]);
  assert.deepEqual(posted, ['description=ci-judge {"add":["test/b.test.ts"],"escalateFull":false}']);

  const fixRows = ledger();
  const fixSpawned: SpawnWorkerArgs[] = [];
  const judge = productionFixProgressJudge({ cwd: root, settingsFile: join(root, "settings", "worker.json"), log: fixRows.log,
    spawn: async (args) => {
      fixSpawned.push(args);
      return worker(isShadow(args) ? 'FIX_PROGRESS: {"verdict":"escalate","reason":"loop","loop":"oscillation"}' : 'FIX_PROGRESS: {"verdict":"continue","reason":"the red shrank"}');
    } });
  const verdict = await judge(buildFixProgressInput({ taskId: "W1-T1", prNumber: 9, headSha: "def5678", currentRed: ["ci"], ledger: [] }));
  assert.deepEqual(verdict, { verdict: "continue", reason: "the red shrank" });
  assert.equal(fixSpawned.length, 2);
  assert.equal(fixSpawned[0]!.mountProvider, undefined);
  assert.deepEqual(fixSpawned[1]!.routingTrial?.models, [DEEPSEEK]);
  assert.deepEqual(fixRows.shadowRows().map((row) => [row.step, row.extra.surface, row.extra.shadow_deployment, row.extra.agreement]),
    [["judge_shadow.paired", "fix-progress", DEEPSEEK, false]]);
});

test("W1-T13364 criterion 4: the operator guide names the two rows, how to turn an arm off and the three ledger steps", () => {
  const guide = readFileSync(join(REPO_ROOT, "docs", "operator-guide.md"), "utf8");
  for (const text of ["`ci_judge`", "`fix_progress_judge`", "`shadow:`", "judge_shadow.paired", "judge_shadow.refused", "judge_shadow.unavailable"]) {
    assert.ok(guide.includes(text), `docs/operator-guide.md names ${text}`);
  }
  assert.match(guide, /remove the\s+`shadow:` mapping/);
});
