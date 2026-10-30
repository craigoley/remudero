import assert from "node:assert/strict";
import { appendFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { boardOracleSliceOf, createBoardProjection, type Row } from "#src/lib/board-projection.js";
import { createLedgerProjector, openProjectorReadModel } from "#src/lib/ledger-projector.js";
import { acquireLease, type ReadModelDb } from "#src/lib/read-model-db.js";
import type { GitHub } from "#src/lib/status.js";
import { makeTempDir } from "#src/lib/tmp.js";

const STEPS = Array.from({ length: 24 }, (_, i) => `panel.cache.step.${i}`);
// Even an empty plan asks this empty bucket while projecting; count it in audit telemetry separately.
const CACHED_STEPS = [...STEPS, "escalation.issue_opened"];
const FILING = "https://github.com/o/r/pull/1";

interface Audit {
  steps: number;
  rows: number;
  audited: number;
  held_back: number;
  slice: { index: number; of: number };
  mismatches: string[];
}

function rig(t: { after(fn: () => void): void }, slices: number, planOnly = true) {
  const dir = makeTempDir("step-audit-rotation");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ms = Date.now();
  const clock = { now: () => ms, date: () => new Date(ms), iso: () => new Date(ms).toISOString() };
  const raw = openProjectorReadModel(dir, "core", clock);
  t.after(() => raw.close());
  const got = acquireLease(raw, { clock, ttlMs: 1e12 });
  assert.ok(got.ok);
  const rows = STEPS.flatMap((step) => [0, 1, 2].map((n) => ({ ts: clock.iso(), step, n })));
  appendFileSync(join(dir, "ledger.ndjson"), [...rows,
    { ts: clock.iso(), step: "pr.opened", plan_only: true, pr_url: FILING },
    { ts: clock.iso(), step: "review.posted", plan_only: true, pr_url: FILING, head_sha: "h1" },
  ].map((row) => JSON.stringify(row) + "\n").join(""));
  createLedgerProjector({ ledgerDir: dir, db: raw, lease: got.lease, clock }).tick();
  let asked: string[] = [];
  let bodyRows = 0;
  let bodyBytes = 0;
  const db: ReadModelDb = {
    ...raw,
    prepare: (sql, opts) => {
      const statement = raw.prepare(sql, opts);
      const step = sql.includes("FROM fact WHERE step = ?");
      const planOnly = sql.includes("json_type(body, '$.plan_only') = 'true'") && sql.includes("SELECT step, body");
      if (!step && !planOnly) return statement;
      return {
        ...statement,
        all: (...params) => {
          const result = statement.all(...params);
          asked.push(String(params[0]));
          bodyRows += result.length;
          for (const row of result) bodyBytes += String(row.body).length;
          return result;
        },
        iterate: function* (...params) {
          asked.push("plan_only");
          for (const row of statement.iterate(...params)) { bodyRows++; bodyBytes += String(row.body).length; yield row; }
        },
      };
    },
  };
  let logged: Record<string, unknown>;
  const board = createBoardProjection({
    db, clock, oracleSlices: slices, ledgerPath: join(dir, "ledger.ndjson"),
    readPlan: () => ({ tasks: [], byId: new Map() }), github: {} as GitHub,
    readCreditStore: () => ({}), readCreditOverrideFile: () => "",
    log: (step, extra) => { if (step === "read_model.board_oracle") logged = extra; },
  });
  board.update();
  const warm = () => {
    const index = board.index(board.rows());
    for (const step of CACHED_STEPS) assert.equal(index.byStep.get(step)?.length, step === "escalation.issue_opened" ? 0 : 3);
    if (planOnly) {
      assert.ok(index.planOnlyFilingPrUrls.has(FILING));
      assert.ok(index.planOnlyReviewedHeads.get(FILING)?.has("h1"));
    }
  };
  warm();
  const pass = () => {
    asked = [];
    bodyRows = 0;
    bodyBytes = 0;
    assert.equal(board.oracle().outcome, "agree");
    const cache = logged!.step_cache as { audit: Audit; held: { steps: number }; resets: { audit: number } };
    const read = logged!.read as { rows: number; bytes: number };
    assert.equal(read.rows, bodyRows, "the oracle's read includes every audit fact row");
    assert.equal(read.bytes, bodyBytes, "the oracle's read includes every audit body byte");
    return { ...cache, asked: asked.filter((step) => step !== "escalation.issue_opened").sort(), read };
  };
  return { board, warm, pass };
}

test("W1-T9992: N oracle passes audit every cached step once and each reads only its slice", (t) => {
  for (const n of [6, 12]) {
    const r = rig(t, n);
    const first = r.pass();
    assert.deepEqual(first.asked, [...STEPS, "plan_only"].sort(), "newly cached members are audited immediately");
    assert.equal(first.audit.audited, CACHED_STEPS.length);
    const seen: string[] = [];
    for (let pass = 0; pass < n; pass++) {
      const index = (pass + 1) % n;
      const want = STEPS.filter((step) => boardOracleSliceOf(step, n) === index);
      const audited = CACHED_STEPS.filter((step) => boardOracleSliceOf(step, n) === index).length;
      const planOnly = boardOracleSliceOf("plan_only", n) === index;
      const result = r.pass();
      assert.deepEqual(result.asked, [...want, ...(planOnly ? ["plan_only"] : [])].sort());
      assert.deepEqual(result.audit.slice, { index, of: n });
      assert.equal(result.audit.audited, audited);
      assert.equal(result.audit.held_back, CACHED_STEPS.length - audited);
      assert.equal(result.audit.steps, CACHED_STEPS.length);
      assert.equal(result.audit.rows, want.length * 3);
      assert.equal(result.read.rows, want.length * 3 + (planOnly ? 2 : 0));
      assert.ok(result.read.bytes < first.read.bytes, "each warm pass reads less than a full audit");
      seen.push(...result.asked);
    }
    assert.deepEqual(seen.sort(), [...STEPS, "plan_only"].sort(), "one rotation audits every member exactly once");
    const freshStep = Array.from({ length: 20 }, (_, i) => `new.${i}`).find((step) => boardOracleSliceOf(step, n) !== 1)!;
    r.board.index(r.board.rows()).byStep.get(freshStep);
    const next = r.pass();
    assert.ok(next.asked.includes(freshStep), "a later newly cached step bypasses its slice");
    assert.equal(next.audit.audited, CACHED_STEPS.filter((step) => boardOracleSliceOf(step, n) === 1).length + 1);
  }
});

test("newly cached plan-only sets bypass their slice on their first audit", (t) => {
  const n = 6;
  const r = rig(t, n, false);
  const result = r.pass();
  assert.ok(!result.asked.includes("plan_only"), "no sets held yet");
  if (boardOracleSliceOf("plan_only", n) === 1) r.pass();
  const index = r.board.index(r.board.rows());
  assert.ok(index.planOnlyFilingPrUrls.has(FILING));
  assert.ok(index.planOnlyReviewedHeads.get(FILING)?.has("h1"));
  const next = r.pass();
  assert.notEqual(next.audit.slice.index, boardOracleSliceOf("plan_only", n));
  assert.ok(next.asked.includes("plan_only"));
  assert.equal(next.read.rows - next.audit.rows, 2);
});

test("W1-T9992: a corrupted cached step is found within N passes and one slice audits every step", (t) => {
  for (const n of [1, 6]) {
    const r = rig(t, n);
    r.pass();
    const victim = STEPS.find((step) => boardOracleSliceOf(step, n) === 0)!;
    const index = r.board.index(r.board.rows());
    (index.byStep.get(victim)![0] as Row).n = "corrupt";
    let found = false;
    for (let pass = 0; pass < n; pass++) {
      const result = r.pass();
      if (n === 1) {
        assert.deepEqual(result.asked, [...STEPS, "plan_only"].sort());
        assert.equal(result.audit.audited, CACHED_STEPS.length);
        assert.equal(result.audit.held_back, 0);
      }
      if (result.audit.mismatches.includes(victim)) {
        assert.equal(result.resets.audit, 1);
        assert.equal(result.held.steps, 0, "a mismatch drops the entire cache");
        found = true;
        break;
      }
      assert.equal(result.resets.audit, 0);
    }
    assert.ok(found, "corruption is detected within one rotation");
    assert.equal(r.board.index(r.board.rows()).byStep.get(victim)![0]!.n, 0, "the next read reloads the store");
    r.warm();
    assert.equal(r.pass().audit.audited, CACHED_STEPS.length, "a cache reset makes every reloaded step new again");
    const sets = r.board.index(r.board.rows());
    (sets.planOnlyFilingPrUrls as Set<string>).add("corrupt");
    (sets.planOnlyReviewedHeads.get(FILING)! as Set<string>).add("corrupt");
    let planFound = false;
    for (let pass = 0; pass < n; pass++) {
      const result = r.pass();
      if (result.audit.mismatches.includes("plan_only")) {
        assert.equal(result.resets.audit, 1);
        planFound = true;
        break;
      }
    }
    assert.ok(planFound, "both plan-only sets participate in the rotation");
    assert.equal(r.board.index(r.board.rows()).planOnlyFilingPrUrls.has("corrupt"), false);
    assert.equal(r.board.index(r.board.rows()).planOnlyReviewedHeads.get(FILING)!.has("corrupt"), false);
  }
});
