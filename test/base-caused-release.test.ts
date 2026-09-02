import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  DEFAULT_SWEEP_POLICY,
  classifyRedCause,
  runSweep,
  type CiFailure,
  type OpenPrView,
} from "../src/lib/sweep.js";
import { buildSweepEffects } from "../src/run-task.js";

/**
 * W1-T2620 — THE BASE-CAUSED STAND-DOWN'S EXIT CONDITION.
 *
 * `redCauseStandsDown` (src/lib/sweep.ts) carries no state, so a base-caused stand-down never
 * ends on its own: the pass before a base fix merges and the pass after read the SAME unchanged
 * `ciFailures` and stand down identically. This suite drives the REAL `runSweep` disposition path
 * (never a hand-called classifier alone) so a regression in the fold, the selection, the ledger
 * fields, or the wire-in all fail here — the SAME discipline test/sweep-blocked-routing.test.ts's
 * own W1-T527 suite uses for the classifier this task extends.
 */

const NOW = Date.parse("2026-09-01T12:00:00Z");
const OLDER = "2026-08-30T09:00:00Z";
const RECENT = "2026-08-31T09:00:00Z";
const TIP_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TIP_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function ciFailure(over: Partial<CiFailure> = {}): CiFailure {
  return { name: "ci-gate", logTail: "AssertionError: expected 1 to equal 2", ...over };
}

function redPr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 9001,
    prUrl: "https://github.com/craigoley/remudero/pull/9001",
    taskId: "W1-TZ",
    reviewState: "success",
    checksState: "red",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: RECENT,
    headSha: "deadbeef",
    headRefName: "run-W1-TZ-0",
    autoMergeArmed: false,
    ciFailures: [ciFailure()],
    ...over,
  };
}

/** A `sweep.disposed` row a prior pass would have written, base-caused, at a given main tip. */
function priorDisposedRow(prNumber: number, mainTipSha: string): Record<string, unknown> {
  return {
    step: "sweep.disposed",
    pr_number: prNumber,
    disposition: "blocked-fixable",
    acted: false,
    reason: "required checks red — ci-log fix, strike 1/2",
    stand_down_reason: "red cause: base-caused — ci-gate is failing on all 2 open PRs this pass, so it is not this diff; no strike spent",
    main_tip_sha: mainTipSha,
  };
}

/** Drives one whole pass and records what the sweep actually DID — never what it merely derived. */
async function sweepOnce(
  prs: OpenPrView[],
  opts: {
    priorLines?: Array<Record<string, unknown>>;
    readMainTip?: () => string | undefined;
    releaseBaseCausedStandDown?: (pr: OpenPrView, mainTipSha: string) => void | Promise<void>;
  } = {},
) {
  const appended: Array<Record<string, unknown>> = [];
  const dispatched: number[] = [];
  const released: Array<{ prNumber: number; mainTipSha: string }> = [];
  const summary = await runSweep(
    prs,
    {
      arm: () => {},
      close: () => {},
      dispatchFix: (pr) => {
        dispatched.push(pr.prNumber);
      },
      escalate: () => {},
      ledgerPath: "/dev/null/ledger.ndjson",
      runId: "t2620-run",
      readLedger: () => opts.priorLines ?? [],
      appendLine: (_p, line) => {
        appended.push(line);
      },
      now: () => NOW,
      log: () => {},
      readMainTip: opts.readMainTip,
      releaseBaseCausedStandDown: opts.releaseBaseCausedStandDown
        ? async (pr, mainTipSha) => {
            released.push({ prNumber: pr.prNumber, mainTipSha });
            await opts.releaseBaseCausedStandDown!(pr, mainTipSha);
          }
        : opts.readMainTip
          ? async (pr, mainTipSha) => {
              released.push({ prNumber: pr.prNumber, mainTipSha });
            }
          : undefined,
    },
    DEFAULT_SWEEP_POLICY,
  );
  const disposed = appended.filter((l) => l.step === "sweep.disposed");
  const actedRows = disposed.filter((l) => l.acted === true);
  return { summary, appended, disposed, dispatched, released, actedRows };
}

// ── acceptance 1 — unchanged main tip: stand down again, no release ────────────────────────────

test("W1-T2620 acceptance 1: a base-caused red whose main tip is unchanged since its last stand-down stands down again with no release, no push and no strike spent", async () => {
  const a = redPr({ prNumber: 9001, ciFailures: [ciFailure({ name: "ci-gate" })] });
  const b = redPr({ prNumber: 9002, ciFailures: [ciFailure({ name: "ci-gate" })] });
  assert.equal(classifyRedCause(a, [a, b]), "base-caused", "sanity: the fixture must actually classify base-caused");

  const r = await sweepOnce([a, b], {
    priorLines: [priorDisposedRow(9001, TIP_A), priorDisposedRow(9002, TIP_A)],
    readMainTip: () => TIP_A, // unchanged
  });

  assert.deepEqual(r.released, [], "no release may fire when main has not moved since the last stand-down");
  assert.deepEqual(r.dispatched, [], "no fix worker may be dispatched for a base-caused red");
  assert.equal(r.actedRows.length, 0, "no acted:true row — a stand-down never spends a strike");
  for (const line of r.disposed) {
    assert.match(String(line.stand_down_reason), /base-caused/, `every disposed line must name the cause; got ${JSON.stringify(line)}`);
    assert.doesNotMatch(String(line.stand_down_reason), /released/, "an unchanged tip must never read as released");
    assert.equal(line.main_tip_sha, TIP_A, "the current tip still rides the disposed line so the next pass has a baseline");
  }
});

// ── acceptance 2 — main tip advanced: released exactly once, not stood down a second time ──────

test("W1-T2620 acceptance 2: a base-caused red whose main tip has advanced is released exactly once through the existing redrive leaf rather than standing down a second time", async () => {
  const a = redPr({ prNumber: 9001, ciFailures: [ciFailure({ name: "ci-gate" })] });
  const b = redPr({ prNumber: 9002, ciFailures: [ciFailure({ name: "ci-gate" })] });

  // Pass 1: main has advanced from TIP_A (this PR's last-recorded stand-down tip) to TIP_B.
  const pass1 = await sweepOnce([a, b], {
    priorLines: [priorDisposedRow(9001, TIP_A), priorDisposedRow(9002, TIP_A)],
    readMainTip: () => TIP_B,
  });
  assert.equal(pass1.released.length, 1, "exactly one release this pass");
  assert.equal(pass1.released[0].mainTipSha, TIP_B);
  assert.deepEqual(pass1.dispatched, [], "a release is never a fix-rung dispatch");
  assert.equal(pass1.actedRows.length, 0, "a release spends no strike — acted stays false");
  const releasedRow = pass1.disposed.find((l) => l.pr_number === pass1.released[0].prNumber)!;
  assert.match(String(releasedRow.stand_down_reason), /released/);
  assert.equal(releasedRow.main_tip_sha, TIP_B);

  // Pass 2: main has NOT moved again since pass 1's own release recorded TIP_B — must never
  // release a second time for the same advance, even though the redrive minted a fresh head
  // (simulated by a changed headSha on the SAME pr_number's fixture below, acceptance 3's own
  // falsifier) and the PR is still observed base-caused (the redrive has not settled yet).
  const releasedPrNumber = pass1.released[0].prNumber;
  const stillRed = [a, b].map((pr) => (pr.prNumber === releasedPrNumber ? redPr({ ...pr, headSha: "freshhead1" }) : pr));
  const pass2 = await sweepOnce(stillRed, {
    priorLines: [...pass1.disposed],
    readMainTip: () => TIP_B, // unchanged since pass 1's own release
  });
  assert.deepEqual(pass2.released, [], "the SAME main advance must never release this PR a second time");
});

// ── acceptance 3 — dedup keyed on (pr, main tip), never head sha ───────────────────────────────

test("W1-T2620 acceptance 3: the release dedup is keyed on the pull request and the main tip and never on the head sha which the release itself replaces", async () => {
  const a = redPr({ prNumber: 9001, headSha: "oldhead", ciFailures: [ciFailure({ name: "ci-gate" })] });
  const b = redPr({ prNumber: 9002, headSha: "oldhead2", ciFailures: [ciFailure({ name: "ci-gate" })] });

  // A prior release already recorded TIP_B for PR 9001 — even though 9001's OWN head sha in
  // THIS pass's snapshot has since changed (the release's own effect), the dedup must still key
  // on (prNumber, mainTipSha), not headSha, and refuse a second release for the same tip.
  const freshHead = redPr({ prNumber: 9001, headSha: "brandnewhead", ciFailures: [ciFailure({ name: "ci-gate" })] });
  const r = await sweepOnce([freshHead, b], {
    priorLines: [priorDisposedRow(9001, TIP_B), priorDisposedRow(9002, TIP_A)],
    readMainTip: () => TIP_B,
  });

  assert.ok(
    !r.released.some((x) => x.prNumber === 9001),
    "9001 must not be released again for TIP_B despite its head sha changing since the last record",
  );
  // 9002's own last-recorded tip (TIP_A) DOES differ from the current tip (TIP_B) — it remains
  // release-eligible on its own (prNumber, tip) key, proving the dedup discriminates per PR.
  assert.deepEqual(r.released, [{ prNumber: 9002, mainTipSha: TIP_B }]);
});

// ── acceptance 4 — at most one PR per pass, oldest head first ──────────────────────────────────

test("W1-T2620 acceptance 4: at most one pull request is released per pass and the oldest head goes first so no sha pinned verdict set is discarded wholesale", async () => {
  const older = redPr({
    prNumber: 9001,
    lastActivityAt: OLDER,
    ciFailures: [ciFailure({ name: "ci-gate" })],
  });
  const newer = redPr({
    prNumber: 9002,
    lastActivityAt: RECENT,
    ciFailures: [ciFailure({ name: "ci-gate" })],
  });

  const r = await sweepOnce([newer, older], {
    priorLines: [priorDisposedRow(9001, TIP_A), priorDisposedRow(9002, TIP_A)],
    readMainTip: () => TIP_B,
  });

  assert.equal(r.released.length, 1, "at most one release this pass, regardless of how many PRs are eligible");
  assert.equal(r.released[0].prNumber, 9001, "the OLDER head (by lastActivityAt) must win, never the newer one");

  const newerRow = r.disposed.find((l) => l.pr_number === 9002)!;
  assert.doesNotMatch(
    String(newerRow.stand_down_reason),
    /released/,
    "the loser this pass must still stand down normally — it is strictly older next pass and cannot starve",
  );
});

// ── acceptance 5 — in-diff/gate-conflict untouched; a failed release never launders a red ──────

test("W1-T2620 acceptance 5a: an in-diff red is untouched by the release lane even with a main tip reader wired", async () => {
  const x = redPr({ prNumber: 9101, ciFailures: [ciFailure({ name: "ci" })] });
  const y = redPr({ prNumber: 9102, ciFailures: [ciFailure({ name: "commitlint" })] });
  assert.equal(classifyRedCause(x, [x, y]), "in-diff");

  const r = await sweepOnce([x, y], { readMainTip: () => TIP_B });
  assert.deepEqual(r.released, [], "an in-diff red must never be routed through the release lane");
  assert.ok(r.dispatched.includes(9101), "the fix rung's own territory must be untouched by this task");
});

test("W1-T2620 acceptance 5b: a gate conflict still escalates rather than being released", async () => {
  const gate = redPr({
    prNumber: 9301,
    checksState: "green",
    reviewState: "failure",
    ciFailures: undefined,
    unmetCriteria: [
      {
        claim: "instrument and product paths are split",
        proof: "unit test: it works",
        met: false,
        reason:
          "remudero-review: FAIL — entangled: instrument path(s) .github/workflows/ci.yml changed alongside src/ path(s) src/lib/sweep.ts in the same PR",
        proof_exec: "executed_fail",
      },
    ],
  });
  const sibling = redPr({ prNumber: 9302, ciFailures: [ciFailure({ name: "ci" })] });
  assert.equal(classifyRedCause(gate, [gate, sibling]), "gate-conflict");

  const r = await sweepOnce([gate, sibling], { readMainTip: () => TIP_B });
  assert.deepEqual(r.released, [], "a gate conflict must never be released — it is not base-caused");
  const disposed = r.disposed.find((l) => l.pr_number === 9301)!;
  assert.equal(disposed.stand_down_reason, undefined, "an unsatisfiable gate must never be stood down");
});

test("W1-T2620 acceptance 5c: a failed release leaves the pull request standing down with no strike spent", async () => {
  const a = redPr({ prNumber: 9001, ciFailures: [ciFailure({ name: "ci-gate" })] });
  const b = redPr({ prNumber: 9002, ciFailures: [ciFailure({ name: "ci-gate" })] });

  const r = await sweepOnce([a, b], {
    priorLines: [priorDisposedRow(9001, TIP_A), priorDisposedRow(9002, TIP_A)],
    readMainTip: () => TIP_B,
    releaseBaseCausedStandDown: async () => {
      throw new Error("push refused: the branch is no longer at the believed head (a concurrent writer moved it)");
    },
  });

  assert.equal(r.released.length, 1, "the release was attempted");
  assert.equal(r.actedRows.length, 0, "a failed release must still spend no strike");
  assert.deepEqual(r.dispatched, [], "a failed release must never fall through to the fix rung");
  const row = r.disposed.find((l) => l.pr_number === r.released[0].prNumber)!;
  assert.doesNotMatch(
    String(row.stand_down_reason),
    /released/,
    "a failed release must never launder the red into a false 'released' ledger line",
  );
  assert.match(String(row.stand_down_reason), /base-caused/, "it still stands down with the ordinary base-caused sentence");
});

// ── acceptance 6 — omitting the reader leaves the pass byte-identical to today ──────────────────

test("W1-T2620 acceptance 6: omitting the injected main tip reader leaves the pass byte identical to today so every existing caller and fixture is untouched", async () => {
  const a = redPr({ prNumber: 9001, ciFailures: [ciFailure({ name: "ci-gate" })] });
  const b = redPr({ prNumber: 9002, ciFailures: [ciFailure({ name: "ci-gate" })] });

  // No `readMainTip` supplied at all — the exact pre-existing fixture shape.
  const r = await sweepOnce([a, b]);

  assert.deepEqual(r.dispatched, [], "byte-identical: still no fix worker for a base-caused red");
  assert.equal(r.actedRows.length, 0, "byte-identical: still no strike spent");
  for (const line of r.disposed) {
    assert.match(String(line.stand_down_reason), /base-caused/);
    assert.doesNotMatch(String(line.stand_down_reason), /released/, "the release lane must never fire with no reader wired");
    assert.equal(line.main_tip_sha, undefined, "no main_tip_sha field at all — the disposed line shape is untouched");
  }
});

// ── GUARDED SITE — the REAL buildSweepEffects wiring, never the hand-rolled harness above ───────
// Every acceptance test above drives `sweepOnce`'s own fake `readMainTip`/`releaseBaseCausedStandDown`
// closures, proving `runSweep`'s fold and dedup. It proves nothing about `buildSweepEffects`
// (src/run-task.ts) — the ONE place production actually builds those two closures. The tests below
// drive THAT real wiring, the same discipline test/stale-ci-gate-wiring.test.ts's own GUARDED SITE
// suite uses for `readCiGateRollup`/`reaggregateCiGate`: a stubbed async JSON reader (never a real
// `gh`) and a recorder in place of the real `pushEmptyCommit` (never a real git push).

function releasePr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 9501,
    prUrl: "https://github.com/craigoley/remudero/pull/9501",
    taskId: "W1-TZ",
    reviewState: "success",
    checksState: "red",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: RECENT,
    headSha: "realwiringhead",
    headRefName: "run-W1-TZ-9501",
    autoMergeArmed: false,
    ...over,
  };
}

/** `buildSweepEffects` with every optional dep left at its default EXCEPT `pushEmptyCommit`
 *  (param 11) and `readJsonImpl` (param 22, the newest) — the exact positional gap
 *  `test/stale-ci-gate-wiring.test.ts`'s own `buildEffects` helper already establishes for
 *  `ghRunImpl`/`readJsonImpl`. */
function buildRealEffects(
  pushEmptyCommit: (repoDir: string, branch: string, head: string, message: string) => string,
  readJsonImpl: (args: string[]) => Promise<unknown>,
) {
  return buildSweepEffects(
    "craigoley",
    "remudero",
    { claudeBin: "/usr/bin/true", root: mkdtempSync(join(tmpdir(), "w1t2620-real-wiring-root-")) } as never,
    join(mkdtempSync(join(tmpdir(), "w1t2620-real-wiring-")), "ledger.ndjson"),
    "SWEEP-T2620-REAL-1",
    { tasks: [], byId: new Map() } as never,
    () => {},
    DEFAULT_SWEEP_POLICY,
    undefined,
    undefined,
    pushEmptyCommit,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    readJsonImpl,
  );
}

test("W1-T2620 GUARDED SITE: buildSweepEffects wires readMainTip and releaseBaseCausedStandDown — both callable, not undefined", () => {
  const effects = buildRealEffects(
    () => "unused",
    async () => ({ sha: TIP_B }),
  );
  assert.equal(typeof effects.readMainTip, "function", "readMainTip must be reachable from the real gateway builder");
  assert.equal(typeof effects.releaseBaseCausedStandDown, "function", "releaseBaseCausedStandDown must be reachable from the real gateway builder");
});

test("W1-T2620 GUARDED SITE: readMainTip's real implementation returns the sha the REST commit read carries", async () => {
  const effects = buildRealEffects(() => "unused", async (args) => {
    assert.deepEqual(args, ["api", "repos/craigoley/remudero/commits/main"], "reads main's own tip, never a branch or a local git ref");
    return { sha: TIP_B };
  });
  assert.equal(await effects.readMainTip!(), TIP_B);
});

test("W1-T2620 GUARDED SITE: readMainTip's real implementation returns undefined on a shapeless response, never a thrown crash", async () => {
  const effects = buildRealEffects(
    () => "unused",
    async () => ({}) as unknown, // no `sha` field at all
  );
  assert.equal(await effects.readMainTip!(), undefined);
});

test("W1-T2620 GUARDED SITE: readMainTip's real implementation returns undefined when the underlying read throws, never propagating", async () => {
  const effects = buildRealEffects(
    () => "unused",
    async () => {
      throw new Error("gh api: rate limited");
    },
  );
  assert.equal(await effects.readMainTip!(), undefined);
});

test("W1-T2620 GUARDED SITE: releaseBaseCausedStandDown's real implementation pushes an empty commit to the PR's own branch and head, naming the PR and the main tip", async () => {
  const calls: Array<{ repoDir: string; branch: string; head: string; message: string }> = [];
  const effects = buildRealEffects((repoDir, branch, head, message) => {
    calls.push({ repoDir, branch, head, message });
    return "mintedsha";
  }, async () => ({ sha: TIP_B }));

  await effects.releaseBaseCausedStandDown!(releasePr(), TIP_B);

  assert.equal(calls.length, 1, "exactly one push for one release");
  assert.equal(calls[0]!.branch, "run-W1-TZ-9501", "pushes to the PR's OWN branch, never a fresh one");
  assert.equal(calls[0]!.head, "realwiringhead", "parented on the CURRENT head — a fast-forward, never a stale one");
  assert.match(calls[0]!.message, /#9501/, "the commit message names the PR it re-triggers");
  assert.match(calls[0]!.message, new RegExp(TIP_B), "the commit message names the main tip that justified the release");
});

test("W1-T2620 GUARDED SITE: releaseBaseCausedStandDown's real implementation is a named no-op when the PR carries no head branch, never a guessed target", async () => {
  let pushes = 0;
  const effects = buildRealEffects(() => {
    pushes++;
    return "never";
  }, async () => ({ sha: TIP_B }));

  await effects.releaseBaseCausedStandDown!(releasePr({ headRefName: undefined as unknown as string }), TIP_B);

  assert.equal(pushes, 0, "no head branch means no push — never a guessed target");
});
