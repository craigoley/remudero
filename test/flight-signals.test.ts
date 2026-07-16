import assert from "node:assert/strict";
import { test } from "node:test";
import {
  burnRatePredicate,
  diffGrowthPredicate,
  errorSignatureLoopPredicate,
  evaluateFlightSignals,
  extractTurnSnapshots,
  repeatedToolCallPredicate,
  scopeDriftPredicate,
  stallTimeoutPredicate,
  type FlightSignalConfig,
  type TurnSnapshot,
} from "../src/lib/flight-signals.js";

const BASE_CONFIG: FlightSignalConfig = { burnRateBaselineUsdPerTurn: 1.0 };

function snap(partial: Partial<TurnSnapshot> & { turn: number }): TurnSnapshot {
  return {
    toolCalls: [],
    cumulativeDiffLines: 0,
    filesTouched: [],
    errorSignatures: [],
    cumulativeCostUsd: 0,
    elapsedMs: 0,
    ...partial,
  };
}

// ── Acceptance criterion 1: 5 identical tool calls trip repetition ────────

test("repeatedToolCallPredicate: 5 identical tool-call payloads trip; a healthy varied transcript does not", () => {
  const identicalCall = { name: "Bash", input: { command: "npm test" } };
  const repeated: TurnSnapshot[] = Array.from({ length: 5 }, (_, i) =>
    snap({ turn: i + 1, toolCalls: [identicalCall] }),
  );
  const verdict = repeatedToolCallPredicate(repeated, BASE_CONFIG);
  assert.equal(verdict.tripped, true);
  assert.match(verdict.evidence, /5×/);

  // Same call count just under the threshold does NOT trip (threshold is inclusive N>=3, so 2 is safe).
  const under = repeatedToolCallPredicate(repeated.slice(0, 2), BASE_CONFIG);
  assert.equal(under.tripped, false);

  // Varied tool calls never accumulate a repeated hash.
  const varied: TurnSnapshot[] = Array.from({ length: 5 }, (_, i) =>
    snap({ turn: i + 1, toolCalls: [{ name: "Bash", input: { command: `echo ${i}` } }] }),
  );
  assert.equal(repeatedToolCallPredicate(varied, BASE_CONFIG).tripped, false);
});

test("repeatedToolCallPredicate: key ordering does not defeat dedup (stable hash)", () => {
  const a = { name: "Edit", input: { file_path: "a.ts", old_string: "x", new_string: "y" } };
  const b = { name: "Edit", input: { new_string: "y", old_string: "x", file_path: "a.ts" } };
  const c = { name: "Edit", input: { old_string: "x", file_path: "a.ts", new_string: "y" } };
  const snaps = [snap({ turn: 1, toolCalls: [a] }), snap({ turn: 2, toolCalls: [b] }), snap({ turn: 3, toolCalls: [c] })];
  assert.equal(repeatedToolCallPredicate(snaps, BASE_CONFIG).tripped, true);
});

// ── Acceptance criterion 2: 12-turn zero-diff transcript trips stall ──────

test("stallTimeoutPredicate: a 12-turn zero-diff transcript trips the no-progress predicate", () => {
  const snaps: TurnSnapshot[] = Array.from({ length: 12 }, (_, i) =>
    snap({ turn: i + 1, cumulativeDiffLines: 0, elapsedMs: (i + 1) * 60_000 }),
  );
  const verdict = stallTimeoutPredicate(snaps, BASE_CONFIG);
  assert.equal(verdict.tripped, true);
  assert.match(verdict.evidence, /12 turn/);
});

test("stallTimeoutPredicate: a transcript that keeps growing the diff every turn does not trip", () => {
  const snaps: TurnSnapshot[] = Array.from({ length: 12 }, (_, i) =>
    snap({ turn: i + 1, cumulativeDiffLines: (i + 1) * 10, elapsedMs: (i + 1) * 60_000 }),
  );
  assert.equal(stallTimeoutPredicate(snaps, BASE_CONFIG).tripped, false);
});

test("stallTimeoutPredicate: wall-clock alone trips even with few turns", () => {
  const snaps: TurnSnapshot[] = [
    snap({ turn: 1, cumulativeDiffLines: 10, elapsedMs: 0 }),
    snap({ turn: 2, cumulativeDiffLines: 10, elapsedMs: 20 * 60_000 }), // 20 min, no growth
  ];
  const verdict = stallTimeoutPredicate(snaps, { ...BASE_CONFIG, stallTurns: 50 });
  assert.equal(verdict.tripped, true); // stallTurns raised out of reach; wall-clock still fires
});

// ── Acceptance criterion 3: a healthy transcript trips NOTHING ───────────

test("evaluateFlightSignals: a healthy transcript (growing diff, varied calls, no error loop) trips nothing", () => {
  const declaredFiles = ["src/lib/foo.ts", "src/lib/bar.ts"];
  const snaps: TurnSnapshot[] = Array.from({ length: 10 }, (_, i) => {
    const turn = i + 1;
    return snap({
      turn,
      toolCalls: [{ name: "Edit", input: { file_path: declaredFiles[i % 2], marker: turn } }],
      cumulativeDiffLines: turn * 20, // steady, well under the per-turn cap
      filesTouched: declaredFiles,
      errorSignatures: [],
      cumulativeCostUsd: turn * 0.5, // well under baseline(1.0) * tolerance(3) = 3/turn
      elapsedMs: turn * 60_000, // 1 turn/minute — nowhere near the 15-minute stall bound
    });
  });
  const config: FlightSignalConfig = { ...BASE_CONFIG, declaredFiles };
  const verdict = evaluateFlightSignals(snaps, config);
  assert.equal(verdict.tripped, false);
  assert.equal(verdict.predicates.length, 6);
  for (const p of verdict.predicates) {
    assert.equal(p.tripped, false, `expected ${p.predicate} not tripped: ${p.evidence}`);
  }
});

// ── burn rate ───────────────────────────────────────────────────────────

test("burnRatePredicate: a turn spending well over baseline*tolerance trips; a normal turn does not", () => {
  const normal = [snap({ turn: 1, cumulativeCostUsd: 0.4 }), snap({ turn: 2, cumulativeCostUsd: 0.8 })];
  assert.equal(burnRatePredicate(normal, BASE_CONFIG).tripped, false);

  const spike = [snap({ turn: 1, cumulativeCostUsd: 0.4 }), snap({ turn: 2, cumulativeCostUsd: 10 })];
  assert.equal(burnRatePredicate(spike, BASE_CONFIG).tripped, true);
});

test("burnRatePredicate: no turns observed is a safe non-trip", () => {
  assert.equal(burnRatePredicate([], BASE_CONFIG).tripped, false);
});

// ── diff growth ─────────────────────────────────────────────────────────

test("diffGrowthPredicate: a turn ballooning the diff past the cap trips; steady growth does not", () => {
  const steady = [snap({ turn: 1, cumulativeDiffLines: 50 }), snap({ turn: 2, cumulativeDiffLines: 100 })];
  assert.equal(diffGrowthPredicate(steady, BASE_CONFIG).tripped, false);

  const balloon = [snap({ turn: 1, cumulativeDiffLines: 50 }), snap({ turn: 2, cumulativeDiffLines: 5000 })];
  assert.equal(diffGrowthPredicate(balloon, BASE_CONFIG).tripped, true);
});

// ── error-signature loop ───────────────────────────────────────────────

test("errorSignatureLoopPredicate: the same fingerprinted error 3x trips (occurrence N>=3, not N=1)", () => {
  const onceIsNoise = [
    snap({ turn: 1, errorSignatures: ["TypeError: x is not a function"] }),
    snap({ turn: 2, errorSignatures: [] }),
  ];
  assert.equal(errorSignatureLoopPredicate(onceIsNoise, BASE_CONFIG).tripped, false);

  const thriceIsALoop = [
    snap({ turn: 1, errorSignatures: ["TypeError: x is not a function"] }),
    snap({ turn: 2, errorSignatures: ["TypeError: x is not a function"] }),
    snap({ turn: 3, errorSignatures: ["TypeError: x is not a function"] }),
  ];
  const verdict = errorSignatureLoopPredicate(thriceIsALoop, BASE_CONFIG);
  assert.equal(verdict.tripped, true);
  assert.match(verdict.evidence, /3×/);
});

// ── scope drift ─────────────────────────────────────────────────────────

test("scopeDriftPredicate: a touched file outside the declared set trips; declared-only stays clean", () => {
  const declaredFiles = ["src/lib/foo.ts"];
  const inScope = [snap({ turn: 1, filesTouched: ["src/lib/foo.ts"] })];
  assert.equal(scopeDriftPredicate(inScope, { ...BASE_CONFIG, declaredFiles }).tripped, false);

  const drifted = [snap({ turn: 1, filesTouched: ["src/lib/foo.ts", ".github/workflows/ci.yml"] })];
  const verdict = scopeDriftPredicate(drifted, { ...BASE_CONFIG, declaredFiles });
  assert.equal(verdict.tripped, true);
  assert.match(verdict.evidence, /ci\.yml/);
});

test("scopeDriftPredicate: no declared scope never trips (no false positive on an unwired caller)", () => {
  const snaps = [snap({ turn: 1, filesTouched: ["anything.ts"] })];
  assert.equal(scopeDriftPredicate(snaps, BASE_CONFIG).tripped, false);
});

// ── stream-json reducer ─────────────────────────────────────────────────

test("extractTurnSnapshots: reduces raw SDK-shaped messages into turns, tool calls, files, and error fingerprints", () => {
  const raw = [
    {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "starting" },
          { type: "tool_use", name: "Bash", input: { command: "npm test" } },
        ],
      },
    },
    {
      type: "user",
      message: {
        content: [{ type: "tool_result", is_error: true, content: "FAIL test/foo.test.ts line 12" }],
      },
    },
    {
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", name: "Edit", input: { file_path: "src/a.ts", old_string: "x", new_string: "y\nz" } },
        ],
      },
    },
  ];
  const snaps = extractTurnSnapshots(raw);
  assert.equal(snaps.length, 2);
  assert.equal(snaps[0].toolCalls[0].name, "Bash");
  assert.equal(snaps[0].errorSignatures.length, 1);
  assert.match(snaps[0].errorSignatures[0], /FAIL test\/foo\.test\.ts line #/);
  assert.deepEqual(snaps[1].filesTouched, ["src/a.ts"]);
  assert.ok(snaps[1].cumulativeDiffLines > 0);
});

test("extractTurnSnapshots: an empty stream yields no turns", () => {
  assert.deepEqual(extractTurnSnapshots([]), []);
});
