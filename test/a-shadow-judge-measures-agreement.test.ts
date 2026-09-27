import assert from "node:assert/strict";
import { test } from "node:test";
import { measureShadowJudgeAgreement, runShadowJudge, shadowJudgeSampled, shadowJudgeMount } from "../src/lib/shadow-judge.js";
import type { Mount } from "../src/lib/mounts.js";

const primary: Mount = { model: "sonnet", effort: "high", maxTurns: 400, contextBudget: 120000 };
const other: Mount = { model: "haiku", effort: "low", maxTurns: 400, contextBudget: 60000 };

test("a sampled read-only judge decision is re-run by a different model in shadow and both decisions are recorded without gating anything", async () => {
  const rows: Array<{ step: string; fields: Record<string, unknown> }> = [];
  const key = Array.from({ length: 100 }, (_, i) => String(i)).find((value) => shadowJudgeSampled(`review:${value}`))!;
  let asked = 0;
  const result = await runShadowJudge({
    surface: "review", key, primaryMount: primary, primaryDecision: [true, false],
    mounts: [primary, other],
    judge: async (mount) => { asked++; assert.equal(mount.model, "haiku"); return { decision: [true, true], servedModel: "haiku-actual" }; },
    log: (step, fields) => rows.push({ step, fields }),
  });
  assert.equal(result, undefined);
  assert.equal(asked, 1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.step, "shadow_judge.paired");
  assert.deepEqual(rows[0]?.fields.primary_decision, [true, false]);
  assert.deepEqual(rows[0]?.fields.shadow_decision, [true, true]);
  assert.equal(rows[0]?.fields.primary_model, "sonnet");
  assert.equal(rows[0]?.fields.shadow_model, "haiku");
  assert.equal(rows[0]?.fields.shadow_served_model, "haiku-actual");
  assert.equal(rows[0]?.fields.agreement, false);
  assert.deepEqual(measureShadowJudgeAgreement(rows.map((row) => ({ step: row.step, ...row.fields })), "review"),
    { sampled: 1, paired: 1, agreed: 0, agreementRate: 0, unavailable: 0 });
});

test("sampling and unavailable shadow models cannot change the primary decision", async () => {
  const rows: Array<{ step: string; fields: Record<string, unknown> }> = [];
  const unsampled = Array.from({ length: 100 }, (_, i) => String(i)).find((value) => !shadowJudgeSampled(`risk:${value}`))!;
  const log = (step: string, fields: Record<string, unknown>) => rows.push({ step, fields });
  await runShadowJudge({ surface: "risk", key: unsampled, primaryMount: primary,
    primaryDecision: "low", mounts: [primary, other], judge: async () => { throw new Error("should not run"); }, log });
  assert.equal(rows.length, 0);
  const sampled = Array.from({ length: 100 }, (_, i) => String(i)).find((value) => shadowJudgeSampled(`risk:${value}`))!;
  await runShadowJudge({ surface: "risk", key: sampled, primaryMount: primary,
    primaryDecision: "low", mounts: [primary, other], judge: async () => { throw new Error("offline"); }, log });
  assert.equal(rows[0]?.step, "shadow_judge.unavailable");
  assert.equal(rows[0]?.fields.reason, "offline");
  assert.equal(rows[0]?.fields.primary_decision, "low");
  assert.deepEqual(measureShadowJudgeAgreement(rows.map((row) => ({ step: row.step, ...row.fields })), "risk"),
    { sampled: 1, paired: 0, agreed: 0, agreementRate: null, unavailable: 1 });
});

test("shadow mount resolution requires a different configured model", () => {
  assert.equal(shadowJudgeMount([primary, other], "sonnet")?.model, "haiku");
  assert.equal(shadowJudgeMount([primary], "sonnet"), undefined);
});

test("a provider routing both requests to the same served model is a coverage gap", async () => {
  const key = Array.from({ length: 100 }, (_, i) => String(i)).find((value) => shadowJudgeSampled(`risk:${value}`))!;
  const rows: Array<{ step: string; fields: Record<string, unknown> }> = [];
  await runShadowJudge({ surface: "risk", key, primaryMount: primary, primaryServedModel: "same",
    primaryDecision: "low", mounts: [primary, other],
    judge: async () => ({ decision: "low", servedModel: "same" }),
    log: (step, fields) => rows.push({ step, fields }),
  });
  assert.equal(rows[0]?.step, "shadow_judge.unavailable");
  assert.equal(rows[0]?.fields.reason, "same-served-model");
});

test("a sampled shadow configuration failure records a coverage gap without asking a judge", async () => {
  const key = Array.from({ length: 100 }, (_, i) => String(i)).find((value) => shadowJudgeSampled(`verify-human:${value}`))!;
  const rows: Array<{ step: string; fields: Record<string, unknown> }> = [];
  await runShadowJudge({ surface: "verify-human", key, primaryMount: primary,
    primaryDecision: "needs_operator", mounts: () => { throw new Error("routing unavailable"); },
    judge: async () => { throw new Error("should not run"); },
    log: (step, fields) => rows.push({ step, fields }),
  });
  assert.equal(rows[0]?.step, "shadow_judge.unavailable");
  assert.match(String(rows[0]?.fields.reason), /mount-resolution-failed: routing unavailable/);
});

test("no alternate mount is recorded as unavailable even when ledgering also fails", async (t) => {
  const key = Array.from({ length: 100 }, (_, i) => String(i)).find((value) => shadowJudgeSampled(`review:${value}`))!;
  let stderr = "";
  t.mock.method(process.stderr, "write", ((chunk: string | Uint8Array) => {
    stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stderr.write);

  await runShadowJudge({
    surface: "review", key, primaryMount: primary, primaryDecision: [true], mounts: [primary],
    judge: async () => { throw new Error("must not run without another model"); },
    log: () => { throw new Error("ledger unavailable"); },
  });

  assert.match(stderr, /shadow judge ledger unavailable: ledger unavailable/);
});
