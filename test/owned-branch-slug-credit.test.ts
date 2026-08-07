/**
 * THE OWNED-SLUG-BRANCH CREDIT (impl-EA) — a merged PR on the task's OWN run-branch, under a
 * descriptive name rather than an `-<epochMs>` stamp, vetoed its own credit forever.
 *
 * THE MEASURED CASTS (re-derived against the live GitHub API this session, and end-to-end through
 * the REAL `deriveStatus` rather than through transcribed predicates): PR #1386, head
 * `run-W1-T377-open-pr-corroboration`, merged 2026-08-05T23:06:20Z with the anchored trailer
 * `Remudero-Task: W1-T377`, derived `merged=false status=queued`. Holding EVERYTHING else constant
 * and changing ONLY the head ref: the `-<epochMs>` form credits, the bare `run-W1-T377` form
 * credits, a `fix/*` head credits (it encodes no task claim, so it vetoes nothing), and a genuinely
 * foreign `run-W1-T999-*` correctly does not. Three of five arms crediting is what proves these
 * fixtures REACH the branch — an all-silent table would have been consistent with a broken fixture.
 *
 * THE CAUSE. `branchClaimsOtherTask` accepted two claim forms — `ownsBranch` (`run-<id>-<digits>$`)
 * and `isBareRunBranch` (`run-<id>`) — and read every other `run-*` head as a claim on a DIFFERENT
 * task. A descriptive suffix matches neither, so the task's own branch was judged foreign and
 * `creditsByAnchoredTrailer` vetoed. The head ref of a merged PR never changes, so the refusal is
 * permanent: the task is re-selected every drain, re-dispatched, and can never earn the credit that
 * would stop it.
 *
 * WHAT THESE TESTS DRIVE, stated rather than implied: `deriveStatus` is the real production
 * function and the rung-(c) accept decision runs for real. The GitHub gateway is an injected
 * `DeriveDeps.github` fixture, and the ledger reader is stubbed to `() => []` — deliberately, so no
 * test reads machine-local state and none can reach anything that spends money or merges code.
 * `branchClaimsOtherTask`, `creditsByAnchoredTrailer`, `ownsBranch` and `isOwnedSlugBranch` are all
 * module-private, so observing the projection they feed is the only form that proves the
 * consequence rather than an intermediate value.
 *
 * LEFT UNPROVEN, named: whether the two stranded tasks re-credit on the next real projection. That
 * is `rmd correct` / the next cycle's work per the shard's clause (vi), not this task's, and it
 * needs live fleet state this session does not have.
 *
 * Its own file per CLAUDE.md's coverage rule — never appended to test/run-task.test.ts.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveStatus, type GitHub, type PrRef, type DeriveDeps } from "../src/lib/status.js";
import type { Task } from "../src/lib/plan.js";

const TASK_ID = "W1-T377";
/** PR #1386's real head ref, copied from the live API rather than typed from memory. */
const SLUG_HEAD = `run-${TASK_ID}-open-pr-corroboration`;

function task(id: string = TASK_ID): Task {
  return {
    id, title: "t", repo: "remudero", type: "implement",
    depends_on: [], status: "queued", verify: "auto", risk: "low", attempts: 0,
  } as unknown as Task;
}

/**
 * A gateway whose ONLY evidence is one trailer-matched PR. `state` and `head` are the two
 * variables every test below moves; everything else is held constant so a verdict change is
 * attributable to them alone.
 */
function trailerGithub(opts: { head: string; state?: string; taskId?: string; body?: string }): GitHub {
  const owner = opts.taskId ?? TASK_ID;
  const pr: PrRef = { number: 1386, url: "u/1386", state: opts.state ?? "MERGED", headRefName: opts.head };
  return {
    prByRef: () => null,
    findMergedByTrailer: (id: string) => (id === owner ? pr : null),
    findMergedByHeadBranch: () => [],
    listMergedHeadBranches: () => [],
    listOpenHeadBranches: () => [],
    headRefName: () => opts.head,
    prBody: () => opts.body ?? `Remudero-Task: ${owner}\n`,
    autoMergeArmed: () => false,
    issueByUrl: () => null,
    readFailed: () => false,
  };
}

function deps(github: GitHub, over: Partial<DeriveDeps> = {}): DeriveDeps {
  return {
    ledgerPath: "/nonexistent/ledger.ndjson",
    github,
    readLedger: () => [],
    mergedHeadBranches: () => [],
    ...over,
  };
}

const creditsFor = (id: string, g: GitHub): boolean => deriveStatus(task(id), deps(g)).merged;

// ── THE DEFECT, AND THE CONTROL THAT MAKES IT ATTRIBUTABLE ──────────────────────────────

test("a merged PR on the task's own run-branch with a descriptive suffix and an anchored trailer credits the task", () => {
  const proj = deriveStatus(task(), deps(trailerGithub({ head: SLUG_HEAD })));

  assert.equal(proj.merged, true, "the task's OWN branch must not be read as a foreign claim");
  assert.equal(proj.prNumber, 1386);
  assert.equal(proj.source, "trailer", "credit arrives by the anchored trailer, not by the branch name");
});

test("CONTROL: the same PR on the timestamped form still credits, so the fixture shape is not what carries the result", () => {
  assert.equal(creditsFor(TASK_ID, trailerGithub({ head: `run-${TASK_ID}-1786028670354` })), true);
});

test("CONTROL: the same PR on the bare run-branch form still credits, so no accepted form was withdrawn", () => {
  assert.equal(creditsFor(TASK_ID, trailerGithub({ head: `run-${TASK_ID}` })), true);
});

test("CONTROL: a head encoding no task claim at all still credits, so the 2026-07-30 relaxation is intact", () => {
  assert.equal(creditsFor(TASK_ID, trailerGithub({ head: "fix/hand-named-branch" })), true);
});

// ── TRAP 1: PREFIX COLLISION, BOTH DIRECTIONS ───────────────────────────────────────────
// The boundary `-` is the whole guard. Each veto is PAIRED with the positive that proves the
// gateway was wired and the trailer matched — an unpaired "did not credit" is satisfied by
// absence for any reason, including a fixture that never reached the predicate.

test("the prefix-collision pair still vetoes in both directions, so a shorter id never credits from a longer one", () => {
  // Forward: the SHORTER id must not be credited by the LONGER id's branch.
  assert.equal(
    creditsFor("W1-T15", trailerGithub({ head: "run-W1-T152-1785348476091", taskId: "W1-T15" })),
    false,
    "W1-T15 must not credit from W1-T152's branch",
  );
  // Reverse: and the longer must not be credited by the shorter's.
  assert.equal(
    creditsFor("W1-T152", trailerGithub({ head: "run-W1-T15-1785348476091", taskId: "W1-T152" })),
    false,
    "W1-T152 must not credit from W1-T15's branch",
  );
  // PAIRED POSITIVES — one variable moved (the head ref), same ids, same trailer, same gateway.
  assert.equal(
    creditsFor("W1-T15", trailerGithub({ head: "run-W1-T15-a-descriptive-slug", taskId: "W1-T15" })),
    true,
    "W1-T15 DOES credit from its own slug branch — so the vetoes above are the boundary, not the wiring",
  );
  assert.equal(
    creditsFor("W1-T152", trailerGithub({ head: "run-W1-T152-a-descriptive-slug", taskId: "W1-T152" })),
    true,
  );
});

test("a genuinely foreign run-branch and every non-merged state still refuse credit", () => {
  assert.equal(
    creditsFor(TASK_ID, trailerGithub({ head: "run-W1-T999-reaper-activity-gate" })),
    false,
    "another task's slug branch is still a foreign claim",
  );
  // TRAP 2 — the widened path is gated on MERGED and nothing else.
  for (const state of ["OPEN", "CLOSED"]) {
    assert.equal(
      creditsFor(TASK_ID, trailerGithub({ head: SLUG_HEAD, state })),
      false,
      `a ${state} PR on a slug branch must never earn merge credit`,
    );
  }
  // An unreadable head still fails closed, unchanged.
  const noHead = trailerGithub({ head: SLUG_HEAD });
  noHead.headRefName = () => undefined;
  assert.equal(creditsFor(TASK_ID, noHead), false, "an unreadable head ref is a failed read, not a free pass");
  // PAIRED POSITIVE: the identical fixture at MERGED with a readable head DOES credit.
  assert.equal(creditsFor(TASK_ID, trailerGithub({ head: SLUG_HEAD, state: "MERGED" })), true);
});

test("a PR with no anchored trailer credits nothing, before or after — the branch name was never the evidence", () => {
  const untrailered = trailerGithub({ head: SLUG_HEAD, body: "no trailer here\n" });
  assert.equal(creditsFor(TASK_ID, untrailered), false);
  // PAIRED POSITIVE: same head, same state, trailer restored.
  assert.equal(creditsFor(TASK_ID, trailerGithub({ head: SLUG_HEAD })), true);
});

// ── THE STRICT ASSERTS THAT MUST NOT HAVE MOVED ─────────────────────────────────────────

test("rung c2 corroboration and the non-merged path keep the strict ownsBranch assert unchanged", () => {
  // Rung (c2) credits BY BRANCH with no trailer, and re-asserts `ownsBranch` on every candidate.
  // A slug branch must NOT be corroborated there — that rung's own doc says it must stay strict.
  const c2Slug: GitHub = {
    ...trailerGithub({ head: SLUG_HEAD }),
    findMergedByTrailer: () => null,
    findMergedByHeadBranch: () => [{ number: 1386, url: "u/1386", state: "MERGED", headRefName: SLUG_HEAD }],
  };
  assert.equal(
    deriveStatus(task(), deps(c2Slug, { mergedHeadBranches: undefined })).merged,
    false,
    "(c2) must not corroborate a slug branch — widening belongs to the trailer path only",
  );

  // PAIRED POSITIVE: the identical rung WITH a timestamped head does corroborate, so the assertion
  // above is `ownsBranch` staying strict rather than the (c2) fixture failing to arrive.
  const stamped = `run-${TASK_ID}-1786028670354`;
  const c2Stamped: GitHub = {
    ...trailerGithub({ head: stamped }),
    findMergedByTrailer: () => null,
    findMergedByHeadBranch: () => [{ number: 1386, url: "u/1386", state: "MERGED", headRefName: stamped }],
  };
  assert.equal(
    deriveStatus(task(), deps(c2Stamped, { mergedHeadBranches: undefined })).merged,
    true,
    "(c2) still corroborates the strict form",
  );
});
