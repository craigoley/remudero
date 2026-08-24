// W1-T1280 — the quota fallback's REST merge (W1-T1255) treated EVERY refusal as final, including
// GitHub's HTTP 405 for a `mergeable: null` payload it has not finished computing ("recomputing,
// ask again" — GitHub's own contract, never a conflict). `mergeFactsFromRest` (W1-T1095) already
// draws that distinction and was never consulted on this path. These tests pin the retry `attemptArm`
// now runs: re-read `mergeFactsFromRest` (never sleep-and-hope), bounded, and refuse unchanged the
// moment the predicate itself says CONFLICTING.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  attemptArm,
  mergeDirectRefusalMayBeUnsettled,
  realArmDeps,
  REST_MERGE_UNSETTLED_MAX_READS,
  REST_MERGE_UNSETTLED_RETRY_INTERVAL_MS,
  type FixRebaseMergeFacts,
} from "../src/run-task.js";

const PR = "https://github.com/craigoley/remudero/pull/2605";
const RATE_LIMIT = "GraphQL: API rate limit already exceeded for user ID 4397075.";
const HTTP_405_CONFLICT_WORDED = "Pull Request has merge conflicts (HTTP 405)";
const HTTP_405_PLAIN = "HTTP 405: Pull Request is not mergeable";

const throwing = (msg: string) => () => {
  throw Object.assign(new Error("boom"), { stderr: msg });
};

/** A `readMergeFacts` fake that returns each entry of `sequence` in order, one per call, and
 *  throws if consulted more times than the sequence provides (proving the bound is exact). */
function factsQueue(sequence: FixRebaseMergeFacts[]): { fn: (prUrl: string) => FixRebaseMergeFacts; calls: string[] } {
  const calls: string[] = [];
  let i = 0;
  return {
    calls,
    fn: (prUrl: string) => {
      calls.push(prUrl);
      if (i >= sequence.length) throw new Error(`readMergeFacts called more times than expected (${i + 1})`);
      return sequence[i++];
    },
  };
}

function deps(over: Partial<Parameters<typeof attemptArm>[1]> = {}) {
  const said: string[] = [];
  const calls: string[] = [];
  const base = {
    armAuto: throwing(RATE_LIMIT),
    mergeDirect: () => {
      calls.push("mergeDirect");
    },
    say: (m: string) => {
      said.push(m);
    },
  };
  return { d: { ...base, ...over } as Parameters<typeof attemptArm>[1], said, calls };
}

// ── the pure predicate ───────────────────────────────────────────────────────────────────────
test("mergeDirectRefusalMayBeUnsettled: true only for the HTTP 405 status, never guessed from wording", () => {
  assert.equal(mergeDirectRefusalMayBeUnsettled(HTTP_405_CONFLICT_WORDED), true);
  assert.equal(mergeDirectRefusalMayBeUnsettled(HTTP_405_PLAIN), true);
  assert.equal(mergeDirectRefusalMayBeUnsettled("merge conflict"), false, "the WORDING alone is not the trigger");
  assert.equal(mergeDirectRefusalMayBeUnsettled("HTTP 403: Resource not accessible"), false);
  assert.equal(mergeDirectRefusalMayBeUnsettled("ETIMEDOUT"), false);
});

// ── acceptance 1: a refusal on a head whose mergeability has not settled is re-read, not final ──
test("an UNKNOWN read is re-read, and a later MERGEABLE read is merged (acceptance 1 + 5)", () => {
  let mergeAttempts = 0;
  const facts = factsQueue([{ mergeable: "UNKNOWN" }, { mergeable: "MERGEABLE" }]);
  const { d, said } = deps({
    mergeDirect: () => {
      mergeAttempts++;
      if (mergeAttempts === 1) throw Object.assign(new Error("boom"), { stderr: HTTP_405_PLAIN });
      // second attempt (the retry) succeeds
    },
    readMergeFacts: facts.fn,
    sleepSync: () => {},
  });
  const r = attemptArm(PR, d);
  assert.equal(r.outcome, "direct-merged");
  assert.equal(mergeAttempts, 2, "the retry issued exactly one more mergeDirect after settling");
  assert.equal(facts.calls.length, 2, "one UNKNOWN read, then the settling read");
  assert.ok(
    said.some((s) => s.includes("automerge.rate_limited_rest_merge_retry (W1-T1280)")),
    `expected the retry row, got ${JSON.stringify(said)}`,
  );
});

// ── acceptance 2 + 7: a head the predicate calls CONFLICTING refuses AT ONCE, never merges ──────
test("a read that settles CONFLICTING refuses immediately — one read, no sleep, no second mergeDirect (acceptance 2 + 5 + 7)", () => {
  const facts = factsQueue([{ mergeable: "CONFLICTING" }]);
  let slept: number[] = [];
  const { d, said, calls } = deps({
    mergeDirect: () => {
      calls.push("mergeDirect");
      throw Object.assign(new Error("boom"), { stderr: HTTP_405_PLAIN });
    },
    isMerged: () => false,
    readMergeFacts: facts.fn,
    sleepSync: (ms: number) => {
      slept.push(ms);
    },
  });
  const r = attemptArm(PR, d);
  assert.equal(r.outcome, "arm-error-ignored");
  assert.equal(facts.calls.length, 1, "settled CONFLICTING on the FIRST read — no further reads");
  assert.deepEqual(calls, ["mergeDirect"], "only the initial REST attempt ran — CONFLICTING never retries the write");
  assert.deepEqual(slept, [], "a head that settles immediately never sleeps");
  assert.ok(
    said.some((s) => s.includes("automerge.rate_limited_rest_merge_conflict (W1-T1280)")),
    `expected the settled-conflict row, got ${JSON.stringify(said)}`,
  );
  assert.ok(said.some((s) => s.includes("automerge.rate_limited_rest_merge_refused (W1-T1255)")));
});

// ── acceptance 3: the decision reads the facts, never the wording of the error message ─────────
test("a refusal WORDED like a conflict still merges when the predicate reads MERGEABLE (acceptance 3)", () => {
  let mergeAttempts = 0;
  const facts = factsQueue([{ mergeable: "MERGEABLE" }]);
  const { d } = deps({
    mergeDirect: () => {
      mergeAttempts++;
      // the FIRST attempt's own refusal text names a conflict, but the predicate below disagrees
      if (mergeAttempts === 1) throw Object.assign(new Error("boom"), { stderr: HTTP_405_CONFLICT_WORDED });
    },
    readMergeFacts: facts.fn,
    sleepSync: () => {},
  });
  const r = attemptArm(PR, d);
  assert.equal(r.outcome, "direct-merged", "the FACTS say mergeable — the wording must not override them");
  assert.equal(mergeAttempts, 2);
});

test("a refusal WORDED like a conflict still refuses when the predicate ALSO reads CONFLICTING (acceptance 3, negative control)", () => {
  const facts = factsQueue([{ mergeable: "CONFLICTING" }]);
  const { d, calls } = deps({
    mergeDirect: () => {
      calls.push("mergeDirect");
      throw Object.assign(new Error("boom"), { stderr: HTTP_405_CONFLICT_WORDED });
    },
    isMerged: () => false,
    readMergeFacts: facts.fn,
    sleepSync: () => {},
  });
  const r = attemptArm(PR, d);
  assert.equal(r.outcome, "arm-error-ignored");
  assert.deepEqual(calls, ["mergeDirect"]);
});

// ── acceptance 4: the retry stops at its bound and returns TODAY'S outcome, unchanged ──────────
test("a read that stays UNKNOWN forever refuses at the bound with the same outcome W1-T1255 already returns (acceptance 4)", () => {
  const sequence: FixRebaseMergeFacts[] = Array.from({ length: REST_MERGE_UNSETTLED_MAX_READS }, () => ({
    mergeable: "UNKNOWN",
  }));
  const facts = factsQueue(sequence);
  const slept: number[] = [];
  const { d, said, calls } = deps({
    mergeDirect: () => {
      calls.push("mergeDirect");
      throw Object.assign(new Error("boom"), { stderr: HTTP_405_PLAIN });
    },
    isMerged: () => false,
    readMergeFacts: facts.fn,
    sleepSync: (ms: number) => {
      slept.push(ms);
    },
  });
  const r = attemptArm(PR, d);
  assert.equal(r.outcome, "arm-error-ignored", "the SAME outcome the pre-W1-T1280 path already returned");
  assert.equal(facts.calls.length, REST_MERGE_UNSETTLED_MAX_READS, "exactly the bound, never more");
  assert.deepEqual(calls, ["mergeDirect"], "an UNKNOWN-forever head never earns a second mergeDirect attempt");
  assert.deepEqual(
    slept,
    Array(REST_MERGE_UNSETTLED_MAX_READS - 1).fill(REST_MERGE_UNSETTLED_RETRY_INTERVAL_MS),
    "one sleep between each read except after the last — the bound is exact",
  );
  assert.ok(said.some((s) => s.includes("automerge.rate_limited_rest_merge_refused (W1-T1255)")));
  assert.ok(r.rateLimit, "the W1-T1235 rate-limit reading still rides the result unchanged");
});

// ── acceptance 6: the fallback (and therefore the retry) only runs after arming was refused on quota ──
test("a NON-rate-limited arm failure never reaches readMergeFacts at all (acceptance 6)", () => {
  const facts = factsQueue([{ mergeable: "UNKNOWN" }]);
  const { d, calls } = deps({
    armAuto: throwing("ETIMEDOUT"),
    readMergeFacts: facts.fn,
  });
  const r = attemptArm(PR, d);
  assert.equal(r.outcome, "arm-error-ignored");
  assert.deepEqual(calls, [], "mergeDirect never runs — no quota refusal, no fallback, no retry");
  assert.equal(facts.calls.length, 0, "the retry's own read never fires without the quota trigger first");
});

test("arming is attempted FIRST even on a settleable head — the retry never replaces the arm (acceptance 6)", () => {
  const facts = factsQueue([{ mergeable: "MERGEABLE" }]);
  const armAutoCalls: string[] = [];
  const { d } = deps({
    armAuto: () => {
      armAutoCalls.push("armAuto");
      throw Object.assign(new Error("boom"), { stderr: RATE_LIMIT });
    },
    readMergeFacts: facts.fn,
  });
  attemptArm(PR, d);
  assert.deepEqual(armAutoCalls, ["armAuto"], "armAuto still runs, and runs before any REST attempt");
});

// ── acceptance 7: no conflict is ever resolved, and nothing merges without the verdict gate above ──
test("an operator hold still refuses before either transport — including the retry's own read (acceptance 7)", () => {
  const facts = factsQueue([{ mergeable: "MERGEABLE" }]);
  const { d, calls } = deps({
    ledgerLines: () => [{ step: "automerge.hold_engaged", pr_number: 2605, by: "craig", reason: "held for review" }],
    readMergeFacts: facts.fn,
  });
  const r = attemptArm(PR, d);
  assert.notEqual(r.outcome, "armed");
  assert.notEqual(r.outcome, "direct-merged");
  assert.deepEqual(calls, [], "neither armAuto nor mergeDirect may run under a hold");
  assert.equal(facts.calls.length, 0, "the retry's read never fires either — the hold refuses before attemptArm tries anything");
});

// ── backward compatibility: omitting `readMergeFacts` reproduces W1-T1255's exact pre-existing behavior ──
test("omitting readMergeFacts skips the retry entirely — a 405 refuses exactly as it did before this task", () => {
  const { d, said, calls } = deps({
    mergeDirect: () => {
      calls.push("mergeDirect");
      throw Object.assign(new Error("boom"), { stderr: HTTP_405_PLAIN });
    },
    isMerged: () => false,
    // readMergeFacts deliberately omitted
  });
  const r = attemptArm(PR, d);
  assert.equal(r.outcome, "arm-error-ignored");
  assert.deepEqual(calls, ["mergeDirect"]);
  assert.ok(said.some((s) => s.includes(`automerge.rate_limited_rest_merge_refused (W1-T1255): ${HTTP_405_PLAIN}`)));
});

// ── realArmDeps: the REAL wiring this task added, not the fixture above ────────────────────────
// `readMergeFacts`/`sleepSync` are OPTIONAL on `ArmDeps` and every test above injects a fake for
// each — none of them ever runs the real closure `realArmDeps()` builds. These two probes drive
// those closures directly (a PATH-stubbed `gh`, never the live repo), the same discipline
// `test/run-task.test.ts`'s own `realArmDeps` probe already applies to this file's siblings.
test("realArmDeps: readMergeFacts (W1-T1280) reaches fixRebaseMergeFactsFromRest for a resolvable PR URL, and returns {} for one it cannot address", () => {
  const bin = mkdtempSync(join(tmpdir(), "gh-stub-readmergefacts-"));
  writeFileSync(
    join(bin, "gh"),
    // `readMergeFacts` -> `fixRebaseMergeFactsFromRest` -> two `gh api` reads (pulls/{n}, then
    // compare/{base}...{head}), both routed through `ghJson`'s `-i` REST convention — this stub
    // answers plain JSON with no `HTTP/` prefix, which `splitGhHeaderBlock` reads as body-only.
    '#!/bin/sh\ncase "$2" in\n  repos/*/pulls/*) echo \'{"base":{"ref":"main"},"head":{"sha":"deadbeef"},"mergeable":true,"mergeable_state":"clean"}\';;\n  repos/*/compare/*) echo \'{"behind_by":0}\';;\n  *) exit 1;;\nesac\n',
    { mode: 0o755 },
  );
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  try {
    const d = realArmDeps();
    assert.deepEqual(
      d.readMergeFacts?.(PR),
      { mergeable: "MERGEABLE", behindBy: 0 },
      "a resolvable PR URL reaches the stubbed gh api reads and maps their payload",
    );
    assert.deepEqual(
      d.readMergeFacts?.("not-a-pr-url"),
      {},
      "an unresolvable PR URL never reaches gh at all — mergeTargetFromPrUrl undefined short-circuits to {}",
    );
  } finally {
    process.env.PATH = oldPath;
    rmSync(bin, { recursive: true, force: true });
  }
});

test("realArmDeps: sleepSync (W1-T1280) short-circuits for ms<=0, and actually blocks via Atomics.wait for ms>0", () => {
  const d = realArmDeps();
  assert.doesNotThrow(() => d.sleepSync?.(0), "ms<=0 returns before reaching Atomics.wait");
  assert.doesNotThrow(() => d.sleepSync?.(-5), "a negative ms is also treated as <=0");
  // A tiny positive ms keeps this probe fast while still exercising the real `Atomics.wait` line
  // — the assertion is that the call returns normally (rather than hangs or throws), proving the
  // wait line actually ran rather than being skipped by the ms<=0 short-circuit above.
  assert.doesNotThrow(() => d.sleepSync?.(5), "sleepSync(5) returns normally after the real Atomics.wait");
});
