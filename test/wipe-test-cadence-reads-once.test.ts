import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { loadPlan } from "../src/lib/plan.js";
import type { Config } from "../src/lib/config.js";
import type { LearningsIndex } from "../src/lib/learnings.js";
import type { Policy } from "../src/lib/policy.js";
// A namespace import, so a test of one export fails alone where that export is missing rather than the file.
import * as cadence from "../src/lib/measurement-cadence.js";
import { runDaemon } from "../src/lib/daemon.js";
import { buildWipeTestCadenceDaemonHooks } from "../src/run-task.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const NOW = new Date("2026-09-06T12:00:00Z");
const ON = { enabled: true, minIntervalMinutes: 1440, maxPerDay: 1, baseShare: 1, settledHalfWidthTurns: 2 };

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}${prefix}`));
}

function policy(wipeTestCadence = ON): Policy {
  return { values: { wipeTestCadence } } as unknown as Policy;
}

function pairLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    step: "wipetest.pair",
    task_id: "wt-sbx",
    factor: "learnings",
    arm_a_run_id: "A",
    arm_b_run_id: "B",
    verdict_a: "merged",
    verdict_b: "merged",
    turns_delta: 1,
    cost_delta: 0.5,
    strikes_delta: 0,
    proof_exec_pass_a: 1,
    proof_exec_pass_b: 2,
    ...overrides,
  });
}

function index(): LearningsIndex {
  return {
    files: {
      "a.yaml": { entries: ["a"], globs: ["src/a.ts"] },
      "b.yaml": { entries: ["b"], globs: ["src/b.ts"] },
    },
    bySubsystem: {},
  };
}

// ── The check re-read every rotation on every pulse of an unablated slot (2026-10-16) ─────────────
// OBSERVED on the fleet host: `wipetest.cadence.skipped` fired 66 times in ~85 min, each time after a
// synchronous union read of 290 of 377 rotations (260.6 MB), always to reach the same "slot draw ≥ share".

/** Whole seconds, so a rotation's mtime survives a round trip through utimes exactly. */
const ROTATION_MTIME_S = 1_790_000_000;

/** A state dir of `count` gzipped rotations, each holding filler, one `learnings.used` row and (in the
 *  first) one learnings pair, plus a live ledger. */
function seedRotations(stateDir: string, count: number): string[] {
  mkdirSync(stateDir, { recursive: true });
  const paths: string[] = [];
  for (let i = 0; i < count; i++) {
    const day = String(i + 1).padStart(2, "0");
    const ts = `2026-09-${day}T00:00:00.000Z`;
    const rows = [
      ...Array.from({ length: 50 }, (_, n) => JSON.stringify({ ts, step: "tick", run_id: `filler-${i}-${n}`, pad: "x".repeat(200) })),
      JSON.stringify({ ts, step: "learnings.used", run_id: `W1-T${i}-1`, injected_ids: ["a"], used_ids: i % 2 === 0 ? ["a"] : [] }),
      ...(i === 0 ? [JSON.parse(pairLine({ task_id: "wt-sbx-1", factor: "learnings", turns_delta: -1 })) as Record<string, unknown>].map((r) => JSON.stringify({ ts, ...r })) : []),
    ];
    const path = join(stateDir, `ledger.2026-09-${day}T00-00-00-000Z.ndjson.gz`);
    writeFileSync(path, gzipSync(`${rows.join("\n")}\n`));
    utimesSync(path, ROTATION_MTIME_S, ROTATION_MTIME_S);
    paths.push(path);
  }
  writeFileSync(join(stateDir, "ledger.ndjson"), `${JSON.stringify({ ts: "2026-10-16T00:00:00.000Z", step: "tick" })}\n`);
  return paths;
}

/** Overwrite a rotation with bytes no gunzip accepts, keeping its size and mtime: a reader that re-opens it
 *  refuses the union, and one that kept what it read never notices. */
function scrambleInPlace(path: string): void {
  const size = statSync(path).size;
  writeFileSync(path, Buffer.alloc(size, 0x5a));
  utimesSync(path, ROTATION_MTIME_S, ROTATION_MTIME_S);
}

const SKIPPING = { ...ON, baseShare: 0.05 };

test("wipe-test cadence: a repeat check never re-reads a rotation it has already read", () => {
  const root = tmp("rmd-wipe-cadence-reread-");
  try {
    const rotations = seedRotations(join(root, "state"), 6);
    const hooks = buildWipeTestCadenceDaemonHooks({
      config: { root } as Config,
      policy: policy(SKIPPING),
      learningsIndex: index,
      now: () => NOW,
      draw: () => 0.99,
    });

    const first = hooks.checkWipeTestCadence();
    assert.equal(first.fire, false);
    assert.match(first.reason, /slot draw 0\.990/, "the first check reads the evidence and skips on the draw");

    for (const path of rotations) scrambleInPlace(path);
    appendFileSync(join(root, "state", "ledger.ndjson"), `${JSON.stringify({ ts: "2026-10-16T00:00:01.000Z", step: "tick" })}\n`);

    const second = hooks.checkWipeTestCadence();
    assert.equal(second.fire, false);
    assert.doesNotMatch(second.reason, /unreadable/, "a repeat check must not re-open a rotation it already read");
    assert.equal(second.reason, first.reason);
    assert.equal(second.evidence?.rotationsRead, 0, "the repeat read decompressed no rotation");
    assert.equal(second.evidence?.rotations, 6);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("wipe-test cadence: a slot's skip is reused until the slot or its evidence changes", () => {
  const root = tmp("rmd-wipe-cadence-slot-");
  try {
    seedRotations(join(root, "state"), 2);
    let now = NOW;
    let indexLoads = 0;
    const hooks = buildWipeTestCadenceDaemonHooks({
      config: { root } as Config,
      policy: policy(SKIPPING),
      learningsIndex: () => {
        indexLoads++;
        return index();
      },
      now: () => now,
      draw: () => 0.99,
    });

    const first = hooks.checkWipeTestCadence();
    assert.equal(first.fire, false);
    assert.equal(indexLoads, 1);

    const second = hooks.checkWipeTestCadence();
    assert.equal(indexLoads, 1, "the same slot over the same evidence is not re-derived");
    assert.equal(second.reason, first.reason);
    assert.equal(first.evidence?.reused, false);
    assert.equal(second.evidence?.reused, true);

    appendFileSync(
      join(root, "state", "ledger.ndjson"),
      `${JSON.stringify({ ts: "2026-10-16T00:00:02.000Z", ...(JSON.parse(pairLine({ task_id: "wt-sbx-2" })) as object) })}\n`,
    );
    const third = hooks.checkWipeTestCadence();
    assert.equal(indexLoads, 2, "a new pair is new evidence, so the slot is re-derived");
    assert.equal(third.evidence?.reused, false);

    now = new Date(NOW.getTime() + SKIPPING.minIntervalMinutes * 60_000);
    hooks.checkWipeTestCadence();
    assert.equal(indexLoads, 3, "the next slot is re-derived");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("wipe-test cadence: each check reports the bytes and rotations its evidence read cost", () => {
  const root = tmp("rmd-wipe-cadence-cost-");
  try {
    const stateDir = join(root, "state");
    const rotations = seedRotations(stateDir, 4);
    const rotationBytes = rotations.reduce((sum, path) => sum + statSync(path).size, 0);
    const read = cadence.createWipeTestEvidenceReader();

    const cold = read(stateDir);
    assert.equal(cold.evidence.ok, true);
    if (cold.evidence.ok) {
      assert.equal(cold.evidence.pairs.length, 1);
      assert.deepEqual(cold.evidence.claimedUse, { learnings: 0.5 });
    }
    assert.equal(cold.cost.rotations, 4);
    assert.equal(cold.cost.rotationsRead, 4, "a cold read decompresses every rotation once");
    assert.ok(cold.cost.bytesRead >= rotationBytes, `cold bytes ${cold.cost.bytesRead} cover the ${rotationBytes} rotation bytes`);

    const unchanged = read(stateDir);
    assert.deepEqual(unchanged.cost, { bytesRead: 0, rotationsRead: 0, rotations: 4 }, "an unchanged ledger reads nothing");

    const tail = `${JSON.stringify({ ts: "2026-10-16T00:00:03.000Z", step: "tick" })}\n`;
    appendFileSync(join(stateDir, "ledger.ndjson"), tail);
    const grown = read(stateDir);
    assert.equal(grown.cost.rotationsRead, 0);
    assert.ok(grown.cost.bytesRead > 0 && grown.cost.bytesRead < rotationBytes, `a grown live file reads only its tail (${grown.cost.bytesRead} bytes)`);

    const restarted = cadence.createWipeTestEvidenceReader()(stateDir);
    assert.equal(restarted.cost.rotationsRead, 0, "a new reader answers every rotation from its durable digest");
    assert.deepEqual(restarted.evidence, cold.evidence);

    const empty = cadence.createWipeTestEvidenceReader()(join(root, "no-state"));
    assert.equal(empty.evidence.ok, false);
    if (!empty.evidence.ok) assert.match(empty.evidence.reason, /no rotation corpus/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("wipe-test cadence: an unavailable or empty learnings index skips with the evidence cost", () => {
  const root = tmp("rmd-wipe-cadence-index-");
  try {
    seedRotations(join(root, "state"), 1);
    const build = (learningsIndex: () => LearningsIndex | null) =>
      buildWipeTestCadenceDaemonHooks({ config: { root } as Config, policy: policy(SKIPPING), learningsIndex, now: () => NOW, draw: () => 0.99 });
    const unavailable = build(() => null).checkWipeTestCadence();
    assert.match(unavailable.reason, /learnings index unavailable/);
    assert.equal(unavailable.evidence?.rotations, 1);
    const empty = build(() => ({ files: {}, bySubsystem: {} })).checkWipeTestCadence();
    assert.match(empty.reason, /learnings index has no shards/);
    assert.equal(empty.evidence?.reused, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runDaemon puts the wipe-test evidence cost on the cadence rows", async () => {
  const root = tmp("rmd-wipe-daemon-cost-");
  try {
    const planPath = join(root, "tasks.yaml");
    writeFileSync(planPath, "- id: T1\n  title: t\n  repo: remudero\n  depends_on: []\n  type: implement\n  verify: auto\n");
    const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
    const evidence = { bytesRead: 1234, rotationsRead: 0, rotations: 377, reused: true };
    let tick = 0;
    await runDaemon(loadPlan(planPath), {
      refreshMerged: () => () => true,
      runOne: async () => {
        throw new Error("never");
      },
      checkStop: () => (++tick > 2 ? "bound" : undefined),
      sleep: async () => {},
      log: (step, extra = {}) => lines.push({ step, extra }),
      checkWipeTestCadence: () =>
        tick === 1
          ? { fire: true, reason: "first run", seq: 1, subject: { id: "wt-sbx-1" }, factor: "learnings", evidence }
          : { fire: false, reason: "slot draw 0.990", evidence },
      runWipeTestCadence: async (decision) => ({ status: "measured", seq: decision.seq, subject: decision.subject, factor: decision.factor }),
    });
    const expected = { evidence_bytes_read: 1234, evidence_rotations_read: 0, evidence_rotations: 377, decision_reused: true };
    for (const step of ["wipetest.cadence.fired", "wipetest.cadence.skipped"]) {
      const row = lines.find((l) => l.step === step);
      assert.ok(row, `${step} was written`);
      for (const [field, value] of Object.entries(expected)) assert.equal(row.extra[field], value, `${step}.${field}`);
    }
    assert.deepEqual(cadence.wipeTestCadenceEvidenceFields({ fire: false, reason: "paced" }), {}, "a paced skip read no evidence");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
