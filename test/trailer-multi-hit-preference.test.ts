import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildBatchedGithub,
  classifyGhFailure,
  ghGateway,
  isBookkeepingOnlyChangeset,
  preferImplementingPr,
  TRAILER_ALL_LIMIT,
  type GitHub,
  type PrRef,
} from "../src/lib/status.js";
import { resolveAlreadySatisfied, type AlreadySatisfiedClaim } from "../src/run-task.js";

/**
 * W1-T441: `findMergedByTrailer` returns AT MOST ONE merged PR and takes the NEWEST, but the
 * already-satisfied close path manufactures newer trailer-bearing PRs that displace the
 * implementation in every later lookup.
 *
 * MEASURED over all 1,172 merged PR bodies (anchored `^Remudero-Task: <id>$`, parse proven with a
 * positive control on #1602): 496 distinct ids carry a trailer and SIXTEEN are carried by more
 * than one. The fixtures below are the two real shapes:
 *   W1-T254 — #720 implements (`fix(sweep)…`, src/), then five `chore(plan): close … as
 *             already-satisfied` PRs change `DECISIONS.md` alone.
 *   W1-T7   — #48 implements (src/), #772 closes it ten days later (`DECISIONS.md`).
 *
 * THE RULE WAS CHOSEN BY MEASUREMENT, NOT PREFERENCE. Over those 16 sets, `ownsOwnRunBranch`
 * isolates 0 (every candidate is on a `run-<id>-*` branch) and `isPlanOnlyChangeset` isolates 3
 * and ZERO of the five generator sets — because a close writes `DECISIONS.md`, which is not in
 * plan scope. Bookkeeping-then-src isolates 9, including 5/5 of the generator sets.
 */

const T254 = "W1-T254";
const ref = (number: number): PrRef => ({
  number,
  url: `https://github.com/craigoley/remudero/pull/${number}`,
  state: "MERGED",
});

/** The real W1-T254 candidate set, newest-first exactly as the gateway orders it. */
const T254_CANDIDATES = [1016, 1015, 1013, 1012, 1007, 720].map(ref);
const T254_FILES: Record<number, string[]> = {
  720: ["src/lib/daemon.ts", "src/lib/ledger.ts", "src/lib/sweep.ts", "src/run-task.ts"],
  1007: ["DECISIONS.md"],
  1012: ["DECISIONS.md"],
  1013: ["DECISIONS.md"],
  1015: ["DECISIONS.md"],
  1016: ["DECISIONS.md"],
};
const filesFor = (map: Record<number, string[]>) => (url: string) => map[Number(url.split("/").pop())];

/** A gateway serving a whole candidate set through the wider method. */
function multiHitGithub(candidates: PrRef[], files: Record<number, string[]>): GitHub {
  return {
    prByRef: () => null,
    findMergedByTrailer: () => candidates[0] ?? null, // the OLD single answer: newest
    findMergedByTrailerAll: () => candidates,
    changedFiles: (url) => files[Number(url.split("/").pop())],
    headRefName: () => undefined,
    prBody: () => undefined,
    readFailed: () => false,
    readFailureReason: () => undefined,
  };
}

const claimOf = (ref: string): AlreadySatisfiedClaim => ({ raw: "", ref });

// ── Direction 1: the rule picks the IMPLEMENTATION over the bookkeeping closes ──

test("W1-T254's real shape: the implementation (#720) wins over five newer DECISIONS.md closes", () => {
  // THE FIXTURE MUST ACTUALLY HAVE RIVALS — a rule that never sees a second hit proves nothing.
  assert.equal(T254_CANDIDATES.length, 6, "six real candidates, as measured");
  assert.equal(T254_CANDIDATES[0].number, 1016, "and the newest is a bookkeeping close, as measured");

  const picked = preferImplementingPr(T254_CANDIDATES, filesFor(T254_FILES));
  assert.equal(picked?.number, 720, "the PR that built the task, not the newest close");
});

test("W1-T7's real shape: #48 implements, #772 closes ten days later — #48 wins", () => {
  const cands = [772, 48].map(ref);
  const files = { 48: ["src/lib/classify.ts", "test/classify.test.ts"], 772: ["DECISIONS.md"] };
  assert.equal(cands.length, 2, "two real candidates");
  assert.equal(preferImplementingPr(cands, filesFor(files))?.number, 48);
});

test("the rule the shard preferred does NOT discriminate here — this is why it was not used", () => {
  // `isPlanOnlyChangeset` reads a DECISIONS.md-only close as real work: DECISIONS.md is not in
  // plan scope. Recorded as a test so a future simplification back to it fails loudly.
  assert.equal(isBookkeepingOnlyChangeset(["DECISIONS.md"]), true, "a close IS bookkeeping");
  assert.equal(isBookkeepingOnlyChangeset(["plan/tasks.d/x.yaml"]), true);
  assert.equal(isBookkeepingOnlyChangeset(["src/lib/daemon.ts"]), false, "an implementation is not");
  assert.equal(isBookkeepingOnlyChangeset([]), false, "an empty changeset is not evidence of anything");
});

// ── Direction 2: SECOND TRAP — the single-candidate case is untouched ──

test("SECOND TRAP: one trailered PR resolves exactly as before — 480 of 496 ids must not move", () => {
  const only = [ref(42)];
  assert.equal(preferImplementingPr(only, () => ["src/lib/x.ts"])?.number, 42);
  assert.equal(preferImplementingPr(only, () => ["DECISIONS.md"])?.number, 42, "even a bookkeeping-only lone PR is still the answer — narrowing may never empty the set");
  assert.equal(preferImplementingPr(only, () => undefined)?.number, 42, "and an unreadable changeset never drops it");
  assert.equal(preferImplementingPr([], () => undefined), undefined);
});

test("SECOND TRAP: newest-wins still stands when nothing discriminates — the fallback is not repealed", () => {
  // Both are genuine implementations (the W1-T119/W1-T159/W1-T67 shape, 7 of the 16 sets).
  const cands = [391, 382].map(ref);
  const files = { 382: ["src/lib/status.ts"], 391: ["src/lib/status.ts"] };
  assert.equal(preferImplementingPr(cands, filesFor(files))?.number, 391, "newest-first order survives untouched");
});

// ── Direction 3: the already-satisfied claim is verified, not refused ──

test("a worker citing the IMPLEMENTATION is VERIFIED, where the old single answer refused it", () => {
  const github = multiHitGithub(T254_CANDIDATES, T254_FILES);
  // The OLD behaviour, still observable on the same gateway: the single answer is the close.
  assert.equal(github.findMergedByTrailer(T254)?.number, 1016, "the pre-fix answer was the bookkeeping close");

  const r = resolveAlreadySatisfied(claimOf("#720"), github, T254);
  assert.deepEqual(r, {
    outcome: "verified",
    number: 720,
    url: "https://github.com/craigoley/remudero/pull/720",
  });
});

test("a claim naming a PR that carries no trailer at all is STILL refused, and names the implementation", () => {
  const github = multiHitGithub(T254_CANDIDATES, T254_FILES);
  const r = resolveAlreadySatisfied(claimOf("#9999"), github, T254);
  assert.equal(r.outcome, "refuted");
  assert.equal(r.outcome === "refuted" && r.reason, "different_pr");
  assert.equal(
    r.outcome === "refuted" && r.creditedNumber,
    720,
    "the rival named is the implementation, not the newest close — the row is the forensic record",
  );
});

// ── THIRD TRAP: #1631's failure/absence distinction must not collapse ──

test("THIRD TRAP: an unreadable gateway still reads UNVERIFIABLE, never absent", () => {
  let failed = false;
  let reason: ReturnType<typeof classifyGhFailure> | undefined;
  const unreadable: GitHub = {
    prByRef: () => null,
    findMergedByTrailer: () => null,
    findMergedByTrailerAll: () => {
      failed = true;
      reason = classifyGhFailure(1, "dial tcp: connect: network is unreachable", undefined);
      return null; // null = the read FAILED, never [] = genuinely absent
    },
    headRefName: () => undefined,
    prBody: () => undefined,
    readFailed: () => failed,
    readFailureReason: () => reason,
  };
  const r = resolveAlreadySatisfied(claimOf("#720"), unreadable, T254);
  assert.equal(r.outcome, "unverifiable", "#1631's distinction survives the wider read");
  assert.equal(r.outcome === "unverifiable" && r.reason, "transport");
});

test("an EMPTY set from a healthy gateway is absent, not unverifiable — [] and null stay distinct", () => {
  const empty: GitHub = {
    prByRef: () => null,
    findMergedByTrailer: () => null,
    findMergedByTrailerAll: () => [],
    headRefName: () => undefined,
    prBody: () => undefined,
    readFailed: () => false,
    readFailureReason: () => undefined,
  };
  assert.deepEqual(resolveAlreadySatisfied(claimOf("#720"), empty, T254), {
    outcome: "refuted",
    reason: "not_found",
  });
});

test("a gateway that predates findMergedByTrailerAll falls back to the single answer, unchanged", () => {
  const legacy: GitHub = {
    prByRef: () => null,
    findMergedByTrailer: () => ref(1016),
    headRefName: () => undefined,
    prBody: () => undefined,
  };
  // #720 is not the single answer, so it is refused exactly as before this change.
  const r = resolveAlreadySatisfied(claimOf("#720"), legacy, T254);
  assert.equal(r.outcome, "refuted");
  assert.equal(r.outcome === "refuted" && r.creditedNumber, 1016);
  // and the single answer itself still verifies
  assert.equal(resolveAlreadySatisfied(claimOf("#1016"), legacy, T254).outcome, "verified");
});

// ── Criterion 4: the batched gateway pays NO extra fetch ──

test("the batched gateway returns every anchored match from the index it already holds, with no extra fetch", () => {
  let fetches = 0;
  const bodies = [
    { number: 1016, url: "u/1016", state: "MERGED", headRefName: "run-W1-T254-3", body: "close\nRemudero-Task: W1-T254\n" },
    { number: 720, url: "u/720", state: "MERGED", headRefName: "run-W1-T254-1", body: "impl\nRemudero-Task: W1-T254\n" },
    { number: 999, url: "u/999", state: "MERGED", headRefName: "run-W1-T999-1", body: "other\nRemudero-Task: W1-T999\n" },
  ];
  const gw = buildBatchedGithub("acme", "remudero", {
    fetchAll: () => {
      fetches++;
      return bodies as never;
    },
  });

  const all = gw.findMergedByTrailerAll?.("W1-T254");
  assert.deepEqual(all?.map((p) => p.number), [1016, 720], "both anchored matches, newest-first");
  const before = fetches;
  gw.findMergedByTrailerAll?.("W1-T254");
  gw.findMergedByTrailerAll?.("W1-T999");
  assert.equal(fetches, before, "no additional fetch — the bodies were already in the one batched read");
  assert.equal(gw.findMergedByTrailerAll?.("W1-T404")?.length, 0, "a genuine miss is [], never null");
});

test("W1-T386's real shape: a WORKFLOW implementation beats a plan-only close — the bookkeeping layer alone carries this", () => {
  // Measured: #1441 changes .github/workflows/* (a real implementation that touches no src/),
  // #1472 is `plan/tasks.d/W1-T386-*.yaml` alone. The src/ layer cannot separate these — neither
  // touches src/ — so ONLY the bookkeeping layer does. Without this case a change deleting that
  // layer still passes, because W1-T254's implementation happens to touch src/ as well.
  const cands = [1472, 1441].map(ref);
  const files = {
    1441: [".github/workflows/ci-gate.yml", ".github/workflows/ci.yml", ".gitignore"],
    1472: ["plan/tasks.d/W1-T386-retire-the-refactor-campaign.yaml"],
  };
  assert.equal(preferImplementingPr(cands, filesFor(files))?.number, 1441, "newest (#1472) is the plan-only close and must lose");
});

test("a candidate whose changeset cannot be READ is kept, never dropped — missing information is not evidence", () => {
  // The fail-soft direction. #1016 is a known bookkeeping close; #720's files are unreadable
  // (a failed `pulls/{n}/files` read). Dropping the unreadable one would hand the answer back to
  // the bookkeeping close — turning a read failure into a wrong attribution, the W1-T119 family.
  const cands = [1016, 720].map(ref);
  const partial = (url: string) => (url.endsWith("/1016") ? ["DECISIONS.md"] : undefined);
  assert.equal(preferImplementingPr(cands, partial)?.number, 720, "the unreadable candidate survives and wins over a known close");
});

test("ghGateway widens past --limit 1 and returns every hit, leaving findMergedByTrailer's single answer untouched", () => {
  // The expensive half: unlike the batched twin this DOES pay a wider fetch, which is why it is a
  // separate method — existing callers keep the one-hit answer and pay nothing new.
  const calls: string[][] = [];
  const rows = [
    { number: 1016, url: "u/1016", state: "MERGED" },
    { number: 720, url: "u/720", state: "MERGED" },
  ];
  const gw = ghGateway("acme", "remudero", {
    exec: (args) => {
      calls.push(args);
      return JSON.stringify(args.includes(String(TRAILER_ALL_LIMIT)) ? rows : rows.slice(0, 1));
    },
  });

  assert.equal(gw.findMergedByTrailer("W1-T254")?.number, 1016, "the single answer is unchanged: newest only");
  const one = calls.at(-1)!;
  assert.equal(one[one.indexOf("--limit") + 1], "1", "and it still asks for exactly one");

  assert.deepEqual(gw.findMergedByTrailerAll?.("W1-T254")?.map((p) => p.number), [1016, 720], "the wider read returns both");
  const all = calls.at(-1)!;
  assert.equal(all[all.indexOf("--limit") + 1], String(TRAILER_ALL_LIMIT), "asking for the bounded set, not unbounded");
  assert.ok(all.includes("--state") && all[all.indexOf("--state") + 1] === "merged", "still merged-only");
});

test("ghGateway: a FAILED wider read returns null, never [] — failure and absence stay distinguishable", () => {
  const gw = ghGateway("acme", "remudero", {
    exec: () => {
      throw Object.assign(new Error("boom"), { status: 1, stderr: "dial tcp: network is unreachable" });
    },
  });
  assert.equal(gw.findMergedByTrailerAll?.("W1-T254"), null, "null = the read failed");
  assert.equal(gw.readFailed?.(), true);
  assert.equal(gw.readFailureReason?.(), "transport");
});
