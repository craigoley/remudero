/**
 * W1-T15163 — a fix-progress judgment whose worker ends without a result (a non-success subtype such as codex's
 * error_exit_1, or a throw) is re-asked at once with the failed provider excluded, so one provider that exits early
 * never leaves a fix round unjudged. A worker that returned a success subtype is never re-asked in the same call.
 * Every spawn here is a fake: no network and no paid call runs.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { judgeCappedRepair } from "#src/lib/classify.js";
import { buildFixProgressInput, judgeFixProgress } from "#src/lib/fix-progress-judge.js";
import { mountsPath } from "#src/lib/mounts.js";
import { productionFixProgressJudge } from "#src/lib/sweep.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import type { SpawnWorkerArgs, WorkerResult } from "#src/lib/worker.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

/** A provider-less row, as production's: the headroom auction routes it, so an exclusion can route elsewhere. */
const JUDGE_ROW = "fix_progress_judge: { model: haiku, effort: low, max_turns: 400, context_budget: 60000 }\n";
const VERDICT = 'FIX_PROGRESS: {"verdict":"continue","reason":"the red shrank"}';

function tmpRoot(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}fix-progress-reask-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, ".remudero"), { recursive: true });
  mkdirSync(join(dir, "state"), { recursive: true });
  const real = readFileSync(mountsPath(REPO_ROOT), "utf8").replace(/^fix_progress_judge:.*\n(?:[ \t]+.*\n)*/gm, "");
  writeFileSync(mountsPath(dir), `${real}\n${JUDGE_ROW}`);
  return dir;
}

function worker(text: string, extra: Partial<WorkerResult> = {}): WorkerResult {
  return { sessionId: "s", costUsd: 0.0001, numTurns: 1, text, subtype: "success", provider: "claude",
    model: "claude-haiku-5-5", ...extra } as unknown as WorkerResult;
}
const codexExit = () => worker("", { subtype: "error_exit_1", provider: "codex", model: "gpt-6-luna", isError: true });

function judgeWith(root: string, answer: (args: SpawnWorkerArgs, n: number) => Promise<WorkerResult>) {
  const spawned: SpawnWorkerArgs[] = [];
  const judge = productionFixProgressJudge({ cwd: root, settingsFile: join(root, "settings", "worker.json"),
    spawn: async (args) => { spawned.push(args); return answer(args, spawned.length); } });
  return { judge, spawned };
}

const input = () => buildFixProgressInput({ taskId: "W1-T1", prNumber: 9, headSha: "def5678", currentRed: ["ci"], ledger: [],
  strikesSpent: 2, parkedReason: "capped-body: 2 prior repairs" });

test("W1-T15163 criterion 1: a judge worker that ends with error_exit_1 or throws is re-asked once with its provider excluded, and that answer is returned", async (t) => {
  const root = tmpRoot(t);
  // The auction routes to codex unless codex is excluded, as the risk-judge lane did from 03:00Z on 2026-11-27.
  const routed = async (args: SpawnWorkerArgs) => args.excludeProviders?.includes("codex") ? worker(VERDICT) : codexExit();
  const exited = judgeWith(root, routed);
  const verdict = await exited.judge(input());
  assert.equal(verdict?.verdict, "continue");
  assert.equal(verdict?.reason, "the red shrank");
  assert.equal(exited.spawned.length, 2);
  assert.equal(exited.spawned[0]!.excludeProviders, undefined);
  assert.deepEqual(exited.spawned[1]!.excludeProviders, ["codex"]);
  // A spawn that throws before any result is re-asked too; with no failed provider known, nothing is excluded.
  const thrown = judgeWith(root, async (_args, n) => { if (n === 1) throw new Error("spawn failed"); return worker(VERDICT); });
  assert.equal((await thrown.judge(input()))?.verdict, "continue");
  assert.equal(thrown.spawned.length, 2);
});

test("W1-T15163 criterion 2: a success subtype is never re-asked, and a re-ask that also fails gives no verdict exactly as before", async (t) => {
  const root = tmpRoot(t);
  // A success subtype, parseable or not, is asked once.
  const parseable = judgeWith(root, async () => worker(VERDICT));
  assert.equal((await parseable.judge(input()))?.verdict, "continue");
  assert.equal(parseable.spawned.length, 1);
  const unparseable = judgeWith(root, async () => worker("no verdict here"));
  assert.equal(await unparseable.judge(input()), undefined);
  assert.equal(unparseable.spawned.length, 1);
  // Two failures in one call: exactly one re-ask, then no verdict; the pass's own re-ask and the round still run.
  const twice = judgeWith(root, async () => codexExit());
  assert.equal(await twice.judge(input()), undefined);
  assert.equal(twice.spawned.length, 2);
  const pass = judgeWith(root, async () => codexExit());
  const decision = await judgeFixProgress(input(), pass.judge, { reask: true });
  assert.equal(decision.verdict, "continue");
  assert.equal("judge_skipped" in decision ? decision.judge_skipped : undefined, "unparseable-twice");
  assert.equal(pass.spawned.length, 4);
  assert.ok(!("reasked_from" in decision));
});

test("W1-T15163 criterion 3: the fix.progress_judged row of a re-asked judgment names the failed provider, model and subtype", async (t) => {
  const root = tmpRoot(t);
  const { judge } = judgeWith(root, async (args) => args.excludeProviders?.includes("codex") ? worker(VERDICT) : codexExit());
  const rows: Array<{ step: string; fields: Record<string, unknown> }> = [];
  const out = await judgeCappedRepair({ bodyStrikes: 2, planRepairStrikes: 0 }, 2, { planRepairCapable: false, input: input(), judge,
    log: (step, fields) => void rows.push({ step, fields }) });
  assert.equal(out.kind, "repair_body");
  const judged = rows.find((row) => row.step === "fix.progress_judged");
  assert.ok(judged, "a fix.progress_judged row is written");
  assert.equal(judged.fields.verdict, "continue");
  assert.deepEqual(judged.fields.reasked_from, { provider: "codex", model: "gpt-6-luna", subtype: "error_exit_1" });
  // A judgment answered at the first ask carries no reasked_from.
  const first = judgeWith(root, async () => worker(VERDICT));
  const plain: Array<{ step: string; fields: Record<string, unknown> }> = [];
  await judgeCappedRepair({ bodyStrikes: 2, planRepairStrikes: 0 }, 2, { planRepairCapable: false, input: input(), judge: first.judge,
    log: (step, fields) => void plain.push({ step, fields }) });
  assert.equal(plain.find((row) => row.step === "fix.progress_judged")?.fields.reasked_from, undefined);
});
