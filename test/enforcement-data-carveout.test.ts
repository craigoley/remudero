import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { AcceptanceCriterion } from "../src/lib/plan.js";
import {
  ENFORCEMENT_DATA,
  ENFORCEMENT_DATA_EXCLUSIONS,
  decideAutoMergeArm,
  enforcementDataInDiff,
  judgeReview,
} from "../src/lib/review.js";

/**
 * W1-T427 — THE PLAN-ONLY CARVE-OUT SPANNED THE ENFORCEMENT DATA IT EXEMPTS. `isInPlanScope` is
 * `MASTER-PLAN.md || ORIENTATION || plan/**`, and a plan-scope-only diff is exempt from the proof
 * floor. But four files under `plan/` are not paperwork — they are what the gates OBEY — so a PR
 * blunting an assertion in `plan/claims.yaml` rode the carve-out that skips the very floor which
 * would catch it, and the claims gate then certified the blunted assertion green ever after.
 *
 * NO INCIDENT EXISTS, deliberately: this is the one mapped guard gap that QUIETS ITS OWN ALARM,
 * so it is closed before rather than after. Every other complement fails loudly eventually.
 *
 * TWO HALVES, and the second is why they ship together: ENFORCEMENT_DATA is a HAND LIST, which is
 * exactly the shape W1-T402 was filed against (INSTRUMENT_SURFACE was enumerated once and the
 * only thing asking anyone to re-check membership was a comment). So the completeness ALARM here
 * follows W1-T402's mechanism rather than inventing a second one — same three parts, same
 * contract: derive candidates from the LIVE TREE, excuse only via a REASONED exclusion, and never
 * let the derivation itself decide a verdict.
 */

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" });
}

// A criterion the KEYWORD FLOOR can meet (free-prose proof echoed by the report), so every
// verdict below is a capped SUCCESS — the only shape the carve-out actually governs. The
// PRECONDITION test right after the helpers is what proves that, rather than this comment.
const CRITERIA: AcceptanceCriterion[] = [
  { claim: "the threshold is corrected", proof: "policy threshold corrected and verified" },
];
const RESPONSIVE_REPORT =
  "REPORT\n- policy threshold corrected and verified.\nPR_URL: https://github.com/o/r/pull/7";

/** A one-file diff in the shape `walkDiff`/`changedFiles` actually parse (`+++ b/<path>`). */
function diffTouching(...paths: string[]): string {
  return paths
    .map(
      (p) => `diff --git a/${p} b/${p}
+++ b/${p}
@@
-  someKey: 1
+  someKey: 2`,
    )
    .join("\n");
}

/** The exact text {@link judgeReview} posts for a capped plan-only success, pinned as a LITERAL
 *  rather than imported: "byte-identical to today" is the claim, and re-deriving it from the
 *  function under test would assert only that a formatter is self-consistent. */
const PLAN_ONLY_SUMMARY_TODAY =
  "remudero-review: PASS — plan-only PR (1 criteria), gated deterministically " +
  "(lint-plan + the plan-PR emitter + plan-index checks); no proof execution attempted, " +
  "by design (W1-T205)";

// ── THE FIXTURE REACHES THE DECISION — asserted before any direction is read ─────────────────
//
// Several fixtures this week were inverted by never reaching the branch they asserted. The
// carve-out is only consequential for a CAPPED SUCCESS (see ReviewVerdict.planOnly's own doc: a
// failing review refuses to arm regardless, and an uncapped one needs no exemption), so a fixture
// whose verdict is a failure would "prove" the denial while testing nothing.

test("PRECONDITION: the shard fixture really lands on the capped-success branch the carve-out governs", () => {
  const v = judgeReview(CRITERIA, { diff: diffTouching("plan/tasks.d/W1-T999-some-shard.yaml"), report: RESPONSIVE_REPORT });
  assert.equal(v.state, "success", "the keyword floor must be MET, or nothing below exercises the arm path");
  assert.equal(v.capped, true, "and CAPPED (no headCheckoutDir ⇒ zero proofs executed) — the branch under test");
});

// ── DIRECTION 1: enforcement data LOSES the carve-out, and the status says why ────────────────

test("a diff touching only plan/claims.yaml is NOT plan-only, and the reason names the file and the category", () => {
  const v = judgeReview(CRITERIA, { diff: diffTouching("plan/claims.yaml"), report: RESPONSIVE_REPORT });

  assert.equal(v.planOnly, false, "THE FIX: plan scope alone no longer earns the carve-out");
  assert.equal(v.state, "success", "the DENIAL is not a failure — the review still passes, it just is not exempt");
  assert.equal(v.capped, true);
  assert.match(v.summary, /ENFORCEMENT_DATA/, "the category is named, not just implied by a missing exemption");
  assert.match(v.summary, /plan\/claims\.yaml/, "and so is the file that cost it — an unexplained red gets overridden");
  assert.doesNotMatch(v.summary, /plan-only PR/, "it must NOT still render as the plan-only carve-out");
});

test("the denial has TEETH: the arm decision refuses without an override, which is the whole point", () => {
  const v = judgeReview(CRITERIA, { diff: diffTouching("plan/claims.yaml"), report: RESPONSIVE_REPORT });
  const decision = decideAutoMergeArm({ state: v.state, capped: v.capped, planOnly: v.planOnly }, false);
  assert.equal(decision.arm, false, "a blunted self-check must not reach an unattended auto-merge");
  assert.match(decision.reason, /CAPPED/);

  // THE PAIRED CONTROL, same shape, only the path differs — proving the PATH decides and the
  // branch is genuinely reached, not that these two diffs differ in some other way.
  const shard = judgeReview(CRITERIA, {
    diff: diffTouching("plan/tasks.d/W1-T999-some-shard.yaml"),
    report: RESPONSIVE_REPORT,
  });
  const armed = decideAutoMergeArm({ state: shard.state, capped: shard.capped, planOnly: shard.planOnly }, false);
  assert.equal(armed.arm, true, "an ordinary filing still arms — the carve-out is intact where it belongs");
});

test("every declared enforcement-data path loses the carve-out, not just the one the fixture names", () => {
  for (const path of Object.keys(ENFORCEMENT_DATA)) {
    const v = judgeReview(CRITERIA, { diff: diffTouching(path), report: RESPONSIVE_REPORT });
    assert.equal(v.planOnly, false, `${path}: declared enforcement data must never be plan-only`);
    assert.match(v.summary, new RegExp(path.replace(/[.]/g, "\\.")), `${path}: named in the reason`);
  }
});

// ── DIRECTION 2: ordinary plan work is UNTOUCHED, byte-identically ────────────────────────────
//
// A change that denied the carve-out to all of `plan/` would pass direction 1 and tax every shard
// filing — the cost W1-T427's design explicitly refused. This is the half that catches it.

test("a diff touching only a plan/tasks.d/ shard KEEPS the carve-out, with the summary byte-identical to today", () => {
  const v = judgeReview(CRITERIA, { diff: diffTouching("plan/tasks.d/W1-T999-some-shard.yaml"), report: RESPONSIVE_REPORT });

  assert.equal(v.planOnly, true, "filing a task is exactly what the carve-out is for");
  assert.equal(v.summary, PLAN_ONLY_SUMMARY_TODAY, "and its rendering is unchanged, to the byte");
  assert.doesNotMatch(v.summary, /ENFORCEMENT_DATA/, "no new clause leaks onto an ordinary plan PR");
});

test("the plan monolith, MASTER-PLAN.md and the excused record stores all keep the carve-out too", () => {
  for (const path of ["plan/tasks.yaml", "MASTER-PLAN.md", "plan/feedback/fb-1.yaml", "plan/plan-index.json"]) {
    const v = judgeReview(CRITERIA, { diff: diffTouching(path), report: RESPONSIVE_REPORT });
    assert.equal(v.planOnly, true, `${path}: not enforcement data, so the carve-out is untouched`);
  }
});

// ── DIRECTION 3: mixing does not launder it ───────────────────────────────────────────────────

test("a diff touching a shard AND plan/policy.yaml pays the floor — enforcement data is not laundered by paperwork", () => {
  const v = judgeReview(CRITERIA, {
    diff: diffTouching("plan/tasks.d/W1-T999-some-shard.yaml", "plan/policy.yaml"),
    report: RESPONSIVE_REPORT,
  });
  assert.equal(v.planOnly, false);
  assert.match(v.summary, /plan\/policy\.yaml/, "the enforcement half is named…");
  assert.doesNotMatch(v.summary, /W1-T999/, "…and the innocent half is not blamed");
});

test("enforcementDataInDiff: exact paths only — a lookalike prefix and an inherited key are both refused", () => {
  assert.deepEqual(enforcementDataInDiff(["plan/claims.yaml", "src/lib/review.ts"]), ["plan/claims.yaml"]);
  assert.deepEqual(enforcementDataInDiff(["plan/claims.yaml.bak", "plan/claims/extra.yaml"]), []);
  assert.deepEqual(enforcementDataInDiff(["constructor", "toString"]), [], "Object.hasOwn, never `in`");
});

// ── SURVIVABILITY: what the denial actually COSTS a legitimate edit ───────────────────────────
//
// A fix that makes routine enforcement-data maintenance impossible gets reverted the first time
// someone hits it. MEASURED over local history at a7b88cd: 27 commits touch these four files and
// exactly THREE are plan-scope-only (single-file `chore(policy)` edits) — those three trade an
// unattended arm for a human merge. The other 24 already carried a src/ or test/ file and were
// never plan-only. What must NOT happen is a legitimate edit being FAILED.

test("a legitimate enforcement-data edit still PASSES — it loses an exemption, it does not acquire a failure", () => {
  const v = judgeReview(CRITERIA, { diff: diffTouching("plan/policy.yaml"), report: RESPONSIVE_REPORT });
  assert.equal(v.state, "success", "the review still passes on its own merits");
  assert.equal(v.criteriaTampered, false, "and `!planOnly` must not drag a pure policy edit into the rule-15 guard");
  assert.equal(v.instrumentEntangled, false, "nor into instrument isolation — it touches no src/ product path");
});

test("the rule-15 interaction is REAL but empty here: criteriaTampered needs a criterion-field edit, which this is not", () => {
  // `criteriaTampered = !planOnly && criterionFieldTampered(diff)`, and losing planOnly does open
  // that gate. It only bites a diff that ALSO edits `claim:`/`proof:` lines in tasks.yaml or a
  // shard — a shape zero of the 27 historical enforcement-data commits have. Pinned in both
  // directions so the interaction is a measured fact rather than an assumption.
  const criterionEdit = `diff --git a/plan/tasks.d/W1-T999-some-shard.yaml b/plan/tasks.d/W1-T999-some-shard.yaml
+++ b/plan/tasks.d/W1-T999-some-shard.yaml
@@
-      proof: "the old proof"
+      proof: "the new proof"`;

  const alone = judgeReview(CRITERIA, { diff: criterionEdit, report: RESPONSIVE_REPORT });
  assert.equal(alone.criteriaTampered, false, "an Architect's plan-only criterion repair is still exempt");

  const withEnforcement = judgeReview(CRITERIA, {
    diff: `${criterionEdit}\n${diffTouching("plan/claims.yaml")}`,
    report: RESPONSIVE_REPORT,
  });
  assert.equal(
    withEnforcement.criteriaTampered,
    true,
    "but editing a self-check AND its own criteria in one PR is exactly the shape rule 15 refuses",
  );
});

// ── THE COMPLETENESS ALARM (the W1-T402 mechanism, followed rather than reinvented) ───────────

/**
 * THE DERIVATION, and its rule stated rather than implied: a candidate is a tracked `.yaml`/
 * `.yml`/`.json` file under `plan/` whose full path or basename appears verbatim in the source
 * text of `src/` or `scripts/` — i.e. plan data the PRODUCT reads by name. `test/` is excluded
 * on purpose: a fixture path is not a read.
 *
 * NAMED LIMIT, since an alarm that overstates its reach is worse than none: a file wired through
 * a COMPUTED path (`join(planDir, name + ".yaml")`) leaves no literal to find and would not be
 * derived. This catches the shape every one of today's four takes, not every shape possible —
 * the same bounded honesty W1-T402's own derivation records about its one-level follow.
 */
function deriveEnforcementDataCandidates(): string[] {
  const tracked = git(["ls-files"]).split("\n").filter(Boolean);
  const readers = tracked.filter((f) => /^(src|scripts)\//.test(f) && /\.(ts|mjs|cjs|js|sh)$/.test(f));
  const corpus = readers.map((f) => readFileSync(join(REPO_ROOT, f), "utf8")).join("\n");
  return tracked
    .filter((f) => f.startsWith("plan/") && /\.(ya?ml|json)$/.test(f))
    .filter((f) => corpus.includes(f) || corpus.includes(basename(f)))
    .sort();
}

/**
 * THE ALARM ITSELF, pure: a derived candidate is unexplained when it is neither DECLARED nor
 * carries a non-blank reason in `exclusions` (an exclusion key ending in `/` excuses a whole
 * record store). Consults nothing but its three arguments, so the mechanism is proven against
 * fabricated fixtures AND the real tree without duplicating the check between them.
 */
function findUnexplainedGaps(
  candidates: string[],
  declared: Readonly<Record<string, string>>,
  exclusions: Readonly<Record<string, string>>,
): string[] {
  return candidates.filter((c) => {
    if (Object.hasOwn(declared, c)) return false;
    return !Object.entries(exclusions).some(
      ([key, reason]) =>
        (key.endsWith("/") ? c.startsWith(key) : c === key) &&
        typeof reason === "string" &&
        reason.trim().length > 0,
    );
  });
}

test("findUnexplainedGaps: a plan data file that is neither declared nor excused is REPORTED, not silently passed", () => {
  assert.deepEqual(findUnexplainedGaps(["plan/new-gate.yaml"], ENFORCEMENT_DATA, ENFORCEMENT_DATA_EXCLUSIONS), [
    "plan/new-gate.yaml",
  ]);
});

test("findUnexplainedGaps: a declared path, and a member of an excused record store, are never reported", () => {
  assert.deepEqual(
    findUnexplainedGaps(
      ["plan/claims.yaml", "plan/tasks.d/W1-T427-enforcement-data-loses-the-carveout.yaml"],
      ENFORCEMENT_DATA,
      ENFORCEMENT_DATA_EXCLUSIONS,
    ),
    [],
  );
});

test("findUnexplainedGaps: a BARE exclusion (empty or whitespace-only reason) does not silence the alarm", () => {
  assert.deepEqual(findUnexplainedGaps(["plan/x.yaml"], {}, { "plan/x.yaml": "" }), ["plan/x.yaml"]);
  assert.deepEqual(findUnexplainedGaps(["plan/x.yaml"], {}, { "plan/x.yaml": "   " }), ["plan/x.yaml"]);
  assert.deepEqual(findUnexplainedGaps(["plan/store/x.yaml"], {}, { "plan/store/": "  " }), ["plan/store/x.yaml"]);
  assert.deepEqual(findUnexplainedGaps(["plan/x.yaml"], {}, { "plan/x.yaml": "a recorded, real reason" }), []);
});

test("both maps carry substantive reasons — the thing that makes them readable rather than a bare list", () => {
  for (const [label, map] of [
    ["ENFORCEMENT_DATA", ENFORCEMENT_DATA],
    ["ENFORCEMENT_DATA_EXCLUSIONS", ENFORCEMENT_DATA_EXCLUSIONS],
  ] as const) {
    const entries = Object.entries(map);
    assert.ok(entries.length >= 4, `${label}: sanity — the map is not empty or trivial`);
    for (const [path, reason] of entries) {
      assert.equal(typeof reason, "string", `${label}[${path}]: reason must be a string`);
      assert.ok(reason.trim().length >= 20, `${label}[${path}]: reason "${reason}" is too short to explain anything`);
    }
  }
});

test("enforcement-data completeness: every plan data file this tree's own src/ or scripts/ reads by name is declared or reasoned-away", () => {
  const candidates = deriveEnforcementDataCandidates();
  assert.ok(candidates.length >= 6, "sanity: the derivation is finding real candidates, not running vacuously");
  for (const declared of Object.keys(ENFORCEMENT_DATA)) {
    assert.ok(candidates.includes(declared), `sanity: the derivation can see ${declared}, so a MISS would be visible`);
  }

  const gaps = findUnexplainedGaps(candidates, ENFORCEMENT_DATA, ENFORCEMENT_DATA_EXCLUSIONS);
  assert.deepEqual(
    gaps,
    [],
    `plan data file(s) neither in ENFORCEMENT_DATA nor excused in ENFORCEMENT_DATA_EXCLUSIONS ` +
      `(src/lib/review.ts): ${gaps.join(", ")} — a PR could edit these AND ride the plan-only ` +
      `carve-out past the proof floor with nothing flagging it`,
  );
});
