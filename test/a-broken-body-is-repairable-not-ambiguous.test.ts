import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  RUN_BRANCH_RE,
  diagnoseBodyDefects,
  emDashSeparatedProof,
  refusesToAuthorAClaim,
  renderBodyDefects,
  taskIdFromHeadRef,
  unwrapGrepPattern,
  type BodyCriterion,
} from "../src/lib/body-repair.js";
import { DEFAULT_SWEEP_POLICY, deriveDisposition, type OpenPrView } from "../src/lib/sweep.js";

/**
 * W1-T2541 — every fix-rung remedy is "push a commit", so a PR blocked by its own BODY is
 * unreachable by automation and routes to blocked-ambiguous to wait for a human.
 *
 * MEASURED over one operator session, 2026-08-31: six PRs repaired BY HAND, five of them blocked
 * by their body rather than their code, every one diagnosable by a verb this repo already ships.
 */

const CRIT = (proof: string, claim = "c"): BodyCriterion => ({ claim, proof });
const WITH_TRAILER = "Body prose.\n\nRemudero-Task: W1-T2480\n";

test("W1-T2541 criterion 1: a body with no trailer is diagnosed as repairable, with the repair DERIVED", () => {
  const d = diagnoseBodyDefects("Body prose with no trailer.", [], { headRef: "run-W1-T2480-1788150533485" });
  assert.equal(d.length, 1);
  assert.equal(d[0].kind, "no-trailer");
  // Derived from the head ref the way projectPlan already attributes an open PR — inventing nothing.
  assert.equal(d[0].repair, "Remudero-Task: W1-T2480");
});

test("W1-T2541 criterion 2: the diagnosis names the specific defect, never a generic failure", () => {
  const d = diagnoseBodyDefects("no trailer", [], { headRef: "run-W1-T2480-1" });
  assert.match(d[0].why, /resolvePlanCriteriaAtHead is never consulted/);
  assert.match(d[0].why, /automerge\.ledger_refused/, "names the SECOND consequence, which is what stranded #3400/#3403");
  assert.match(renderBodyDefects(d), /^- no-trailer: .*repair: Remudero-Task: W1-T2480$/);
  // ...and a defect whose repair is NOT derivable says so rather than guessing one.
  const undecidable = diagnoseBodyDefects("no trailer", [], { headRef: "chore/hand-named" });
  assert.equal(undecidable[0].repair, undefined);
  assert.match(undecidable[0].why, /the head ref names no task, so the trailer cannot be derived/);
});

test("W1-T2541 criterion 3: a wrapped grep proof is identified by EXECUTING it, not by its shape", () => {
  // THE DISTINCTION FROM W1-T2544. The author-time gate is pure and can only WARN, because a
  // wholly-wrapped pattern CAN be correct. The fix rung runs in a worktree, so here the question is
  // SETTLED: wrapped reads 0 AND bare reads > 0.
  const hits: Record<string, number> = {
    'grep: "FOLDED BY R39" in MASTER-PLAN.md': 0,
    "grep: FOLDED BY R39 in MASTER-PLAN.md": 1,
  };
  const execProof = (p: string) => ({ hits: hits[p] ?? 0 });
  const d = diagnoseBodyDefects(WITH_TRAILER, [CRIT('grep: "FOLDED BY R39" in MASTER-PLAN.md')], { execProof });
  assert.equal(d.length, 1);
  assert.equal(d[0].kind, "wrapped-proof");
  assert.equal(d[0].criterion, 1);
  assert.equal(d[0].repair, "grep: FOLDED BY R39 in MASTER-PLAN.md");

  // A WRAPPED PATTERN THAT REALLY MATCHES IS CORRECT and must NOT be reported — this is exactly
  // what a shape test would get wrong, and why execution is the discriminator.
  const legit = (p: string) => ({ hits: p.includes('"') ? 3 : 3 });
  assert.deepEqual(diagnoseBodyDefects(WITH_TRAILER, [CRIT('grep: "key" in a.json')], { execProof: legit }), []);

  // AND UNWRAPPING MUST ACTUALLY HELP. A pattern that reads 0 BOTH ways is simply wrong, and
  // stripping its delimiters fixes nothing — proposing that as a repair would send the author to
  // re-push a proof that still fails. Reported only when the bare form genuinely matches.
  const bothZero = () => ({ hits: 0 });
  assert.deepEqual(
    diagnoseBodyDefects(WITH_TRAILER, [CRIT(`grep: "NOWHERE" in f.md`)], { execProof: bothZero }),
    [],
    "unwrapping must be a real remedy, not merely a different failing proof",
  );

  // With NO executor the wrapped case is not diagnosed at all — silence, never a guess.
  assert.deepEqual(diagnoseBodyDefects(WITH_TRAILER, [CRIT('grep: "x" in y')], {}), []);
});

test("W1-T2541 criterion 4: a repair that would author or alter a CLAIM is refused", () => {
  // Standing rule 15's criterionFieldTampered refuses a non-plan-only diff that edits claim:/proof:.
  // This is that boundary made testable rather than asserted in prose.
  const criteria = [CRIT("grep: x in y", "the claim text")];
  const honest = diagnoseBodyDefects("no trailer", criteria, { headRef: "run-W1-T1-1" });
  assert.equal(refusesToAuthorAClaim(honest, criteria), true, "a derived trailer touches no claim");
  // A hypothetical writer proposing a claim as its repair must be refused.
  const rogue = [{ kind: "no-trailer" as const, repair: "the claim text", why: "w" }];
  assert.equal(refusesToAuthorAClaim(rogue, criteria), false, "authoring a claim must be refused");
});

test("W1-T2541 criterion 5: a body with no derivable defect yields NO repair — silence is the default", () => {
  const clean = diagnoseBodyDefects(WITH_TRAILER, [CRIT("grep: REAL in f.md"), CRIT("unit test: test/x.test.ts")], {
    execProof: () => ({ hits: 2 }),
  });
  assert.deepEqual(clean, [], "the overwhelming majority of bodies must produce nothing to act on");
  assert.equal(renderBodyDefects(clean), "");
});

test("W1-T2541: an inert proof is reported with its consequence, since it caps the verdict", () => {
  const d = diagnoseBodyDefects(WITH_TRAILER, [CRIT("demonstration: the operator observes it")], {});
  assert.equal(d.length, 1);
  assert.equal(d[0].kind, "inert-proof");
  assert.equal(d[0].criterion, 1);
  assert.match(d[0].why, /cannot arm auto-merge/);
  assert.equal(d[0].repair, undefined, "there is no derivable repair — a human decides what to prove");
});

test("W1-T2541: the derived task id comes from the run-branch shape the fleet already attributes by", () => {
  assert.equal(taskIdFromHeadRef("run-W1-T2480-1788150533485"), "W1-T2480");
  assert.equal(taskIdFromHeadRef("run-RETRO-1788193081371-1"), "RETRO-1788193081371");
  assert.equal(taskIdFromHeadRef("chore/hand-named"), undefined);
  assert.equal(taskIdFromHeadRef(undefined), undefined);
  assert.equal(unwrapGrepPattern("grep: plain in f.md"), undefined, "an unwrapped pattern is not a defect");
  assert.equal(unwrapGrepPattern("grep: `a` and `b` in f.md"), undefined, "a surviving delimiter is not a simple wrap");
});

test("W1-T2541 criterion 6: the diagnosis reaches the escalation an operator reads", () => {
  // The call site, exercised through the REAL disposition table rather than asserted by grep — a
  // module reached only by its own tests is dead code, which lint-plan's call-site check refuses.
  const pr = {
    prNumber: 1, prUrl: "u", reviewState: "failure", checksState: "green", unmetCriteria: [], priorStrikes: 0,
    strikeHistory: [], lastActivityAt: new Date().toISOString(), headSha: "a", autoMergeArmed: false,
    isDependabot: false, criteriaRecoverable: false, headRefName: "run-W1-T2480-1788150533485",
  } as unknown as OpenPrView;
  const d = deriveDisposition(pr, DEFAULT_SWEEP_POLICY, Date.now());
  assert.equal(d.disposition, "blocked-ambiguous");
  assert.match(d.reason, /derived repair: add `Remudero-Task: W1-T2480` to the PR body/);
  // and it stays silent rather than guessing when the ref names nothing
  const noRef = deriveDisposition({ ...pr, headRefName: "chore/hand-named" } as OpenPrView, DEFAULT_SWEEP_POLICY, Date.now());
  assert.doesNotMatch(noRef.reason, /derived repair/);
  assert.match(noRef.reason, /criteria unrecoverable/, "the pre-existing reason is unchanged beneath the addition");
});

// W1-T2541: the branch-shape regex gets its own two-arm fixture. Every repair this module proposes
// must be DERIVABLE FROM OBSERVED STATE, and for the trailer defect the entire derivation is this
// pattern — so its refusing arm is as load-bearing as its accepting one: a head ref that does not
// name a task must yield NO addition rather than a guess. `taskIdFromHeadRef` above exercises it
// only through the extraction; naming it here pins the shape itself, which is also what
// `negative-reachability-ratchet` requires of a module-scope `_RE` validator entering the tree.

test("W1-T2541: RUN_BRANCH_RE accepts the fleet's own head shape and refuses every other branch", () => {
  // The accepting arm — the shape `projectPlan` attributes an open PR by.
  assert.equal(RUN_BRANCH_RE.test("run-W1-T2480-1788150533485"), true);
  assert.equal(RUN_BRANCH_RE.exec("run-W1-T2480-1788150533485")?.[1], "W1-T2480");
  // The refusing arm. A hand-authored branch names no task, and the trailing digits are REQUIRED —
  // without them there is no epoch suffix and the capture would swallow the id's own tail.
  assert.equal(RUN_BRANCH_RE.test("fix/acceptance-block"), false);
  assert.equal(RUN_BRANCH_RE.test("claude/remudero-codebase-review-jswd3f"), false);
  assert.equal(RUN_BRANCH_RE.test("plan-2539-2543"), false);
  assert.equal(RUN_BRANCH_RE.test("run-W1-T2480"), false, "no epoch suffix is not this shape");
  assert.equal(RUN_BRANCH_RE.exec("main"), null);
});

// ── W1-T3028: the em-dash separator, recovered rather than discarded ─────────────────────────────

/*
 * CLAUDE.md records this shape shipping three times — #2534, #2535, #2555 — each landing on
 * `acceptanceAuthorTimeCheck`'s `empty-proofs` refusal. An em dash is not a separator, so
 * `- <claim> — unit test: <title>` parses as ONE claim with NO proof; that empty proof makes the
 * body defective, and `ensureJudgeableBody` then demotes the author's header and appends a
 * fallback block — discarding criteria that were one character from correct.
 *
 * NOT the #4420 case, which is what sent me looking: its bullets read `**claim** — explanatory
 * prose`, no dialect after the dash, so nothing was recoverable there and its fallback was right.
 * The two shapes are one character apart in the source and entirely different in what can be done,
 * which is why the DIALECT test decides this and not the dash.
 *
 * The criteria were one character from correct the whole time, which is why this carries a REPAIR
 * rather than a bare report: both halves are already the author's own words, and this only moves
 * the boundary between them.
 */

test("W1-T3028: an em-dash bullet is diagnosed with the exact repaired line, not reported as merely inert", () => {
  const defects = diagnoseBodyDefects("Remudero-Task: W1-T1\n", [
    { claim: "the gate refuses a failed diff — unit test: a FAILED `git diff` produces a NOT-OK step", proof: "" },
  ]);
  const d = defects.find((x) => x.kind === "em-dash-separator");
  assert.ok(d, "the em-dash shape must be its own diagnosis");
  assert.equal(d!.criterion, 1);
  assert.equal(
    d!.repair,
    "- the gate refuses a failed diff | unit test: a FAILED `git diff` produces a NOT-OK step",
    "the repair is the author's own two halves with the separator corrected",
  );
  assert.match(d!.why, /DISCARDS/, "the why must name what happens if it is left alone");
  assert.equal(defects.some((x) => x.kind === "inert-proof"), false, "and it must not double-report as inert");
});

test("W1-T3028: an em dash used as ordinary punctuation is left alone, so no proof is invented", () => {
  const defects = diagnoseBodyDefects("Remudero-Task: W1-T1\n", [
    { claim: "the reaper deletes nothing — that is the deliverable, not a staging step", proof: "" },
  ]);
  assert.equal(defects.some((x) => x.kind === "em-dash-separator"), false);
  assert.ok(defects.some((x) => x.kind === "inert-proof"), "it is still reported, just with no derived repair");
});

test("W1-T3028: a claim carrying its own em dash keeps it — the proof is the tail, not the first split", () => {
  const out = emDashSeparatedProof(
    "a bound that fires on a healthy condition — this repo's own recurring defect — grep: WAIT_CAP_SECONDS in ci-gate.yml",
  );
  assert.ok(out);
  assert.equal(out!.claim, "a bound that fires on a healthy condition — this repo's own recurring defect");
  assert.equal(out!.proof, "grep: WAIT_CAP_SECONDS in ci-gate.yml");
});

test("W1-T3028: a bullet with no claim left, or no dialect at all, is not repaired", () => {
  assert.equal(emDashSeparatedProof("— unit test: something"), undefined, "nothing would remain as a claim");
  assert.equal(emDashSeparatedProof("a claim with no dialect after it — just prose"), undefined);
});

test("W1-T3028: a bullet that already carries a real proof is never rewritten", () => {
  const defects = diagnoseBodyDefects("Remudero-Task: W1-T1\n", [
    { claim: "a claim — with an em dash in it", proof: "unit test: some title" },
  ]);
  assert.equal(defects.some((x) => x.kind === "em-dash-separator"), false);
});
