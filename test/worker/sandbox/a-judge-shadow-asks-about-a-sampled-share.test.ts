/**
 * A judge row's `shadow_rate` asks its shadow about a stable share of judgements. Without a rate, or at 1, every
 * judgement is shadowed as before; at 0 none is, and a judgement sampled out spends nothing and writes no row.
 * Every spawn here is a fake: no network and no paid call runs.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";

import { runJudgeShadow, shadowJudgeCall, shadowSampledIn } from "#src/lib/judge-shadow.js";
import { mountsPath, MountsError, validateMounts, type JudgeMount } from "#src/lib/mounts.js";
import type { SpawnWorkerArgs, WorkerResult } from "#src/lib/worker.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const TABLE = parseYaml(readFileSync(mountsPath(REPO_ROOT), "utf8")) as Record<string, unknown>;
const CASH: JudgeMount = { model: "haiku", effort: "low", maxTurns: 400, contextBudget: 60000, shadow: { provider: "cash", deployment: "DeepSeek-V4-Flash" } };
const PRIMARY = { cwd: REPO_ROOT, prompt: "judge this" } as SpawnWorkerArgs;

function counting() {
  const calls: SpawnWorkerArgs[] = [];
  const rows: Array<Record<string, unknown>> = [];
  const spawn = async (args: SpawnWorkerArgs): Promise<WorkerResult> => {
    calls.push(args);
    return { sessionId: "s", costUsd: 0.0001, numTurns: 1, text: "low" } as unknown as WorkerResult;
  };
  return { calls, rows, spawn, log: (step: string, fields: Record<string, unknown> = {}) => { rows.push({ step, ...fields }); } };
}

function shadowOnce(mount: JudgeMount, key: string, book: ReturnType<typeof counting>) {
  return runJudgeShadow({ surface: "fix-progress", key, mount, primaryArgs: PRIMARY, primaryVerdict: "low",
    parse: (text) => (text === "" ? undefined : text), agreementKey: (verdict) => verdict, spawn: book.spawn, log: book.log });
}

test("a shadow rate of 1, or no rate, shadows every judgement and 0 shadows none", () => {
  for (let i = 0; i < 200; i += 1) {
    assert.equal(shadowSampledIn("ci-judge", `PR${i}@abc`, undefined), true);
    assert.equal(shadowSampledIn("ci-judge", `PR${i}@abc`, 1), true);
    assert.equal(shadowSampledIn("ci-judge", `PR${i}@abc`, 0), false);
  }
});

test("a shadow rate samples the same judgements every time and about its share of 1,000 keys", () => {
  const keys = Array.from({ length: 1000 }, (_, i) => `PR${i}@${(i * 7919).toString(16)}`);
  const first = keys.filter((key) => shadowSampledIn("risk-judge", key, 0.2));
  const again = keys.filter((key) => shadowSampledIn("risk-judge", key, 0.2));
  assert.deepEqual(again, first);
  assert.ok(first.length >= 160 && first.length <= 240, `sampled ${first.length} of 1000 at 0.2`);
  const wider = new Set(keys.filter((key) => shadowSampledIn("risk-judge", key, 0.5)));
  assert.ok(first.every((key) => wider.has(key)), "a higher rate keeps every judgement a lower rate kept");
});

test("a judgement sampled out spends no shadow call and writes no shadow row", async () => {
  const book = counting();
  const outcome = await shadowOnce({ ...CASH, shadowRate: 0 }, "PR9@def5678", book);
  assert.deepEqual(outcome, { kind: "skipped" });
  assert.equal(book.calls.length, 0);
  assert.deepEqual(book.rows, []);
  await shadowJudgeCall({ role: "risk-judge", key: "PR9@def5678", mount: { ...CASH, shadow: undefined, shadowRate: 0 }, primaryArgs: PRIMARY,
    primary: {}, primaryAnswer: "low", parse: (text) => text, spawn: book.spawn, log: book.log });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(book.calls.length, 0);
  assert.deepEqual(book.rows, []);
});

test("a shadow rate of 1 asks the shadow exactly as a row with no rate does", async () => {
  const plain = counting();
  const rated = counting();
  const a = await shadowOnce(CASH, "PR9@def5678", plain);
  const b = await shadowOnce({ ...CASH, shadowRate: 1 }, "PR9@def5678", rated);
  assert.deepEqual(a, { kind: "paired", agreement: true });
  assert.deepEqual(b, a);
  assert.equal(plain.calls.length, 1);
  assert.equal(rated.calls.length, 1);
  assert.deepEqual(rated.rows.map((row) => row.step), plain.rows.map((row) => row.step));
});

test("the mounts table reads shadow_rate beside a shadow and refuses it out of range or alone", () => {
  const row = { model: "haiku", effort: "low", max_turns: 400, context_budget: 60000 };
  const read = validateMounts({ ...TABLE, fix_progress_judge: { ...row, shadow: "DeepSeek-V4-Flash", shadow_rate: 0.2 } });
  assert.equal(read.fix_progress_judge?.shadowRate, 0.2);
  assert.equal(validateMounts({ ...TABLE, fix_progress_judge: { ...row, shadow: "DeepSeek-V4-Flash" } }).fix_progress_judge?.shadowRate, undefined);
  for (const bad of [-0.1, 1.5, "0.2", Number.NaN]) {
    assert.throws(() => validateMounts({ ...TABLE, fix_progress_judge: { ...row, shadow: "DeepSeek-V4-Flash", shadow_rate: bad } }), MountsError);
  }
  assert.throws(() => validateMounts({ ...TABLE, fix_progress_judge: { ...row, shadow_rate: 0.5 } }), MountsError);
});
