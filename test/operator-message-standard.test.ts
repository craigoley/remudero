/**
 * W1-T2279 — THE CONSOLE HAS NO WRITTEN STANDARD FOR WHAT A MESSAGE MUST TELL AN OPERATOR.
 *
 * This task writes exactly two files: docs/operator-message-standard.md (the normative doc) and
 * this test, which enforces the nine acceptance claims. Each claim below gets its own exported
 * `check*` function (a small requirements list of regexes over prose, mirroring the pattern in
 * test/reap-cadence.test.ts) plus a positive test against the real doc and a falsifier test that
 * proves the check can actually go RED against a blob that omits the requirement. A handful of
 * claims are additionally grounded against the real source files the doc cites, so a stale
 * citation (a field renamed, a line reworded) fails loudly rather than the doc quietly drifting
 * from the code it describes.
 *
 * WHAT THIS TEST DOES NOT DO: it never asserts that any operator message is TRUE, and it never
 * computes or gates on a readability score. That is the whole point of the standard it enforces
 * — see claim 4 and claim 5 below.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const DOC_PATH = join(REPO_ROOT, "docs", "operator-message-standard.md");
const doc = readFileSync(DOC_PATH, "utf8");
const statusBoardSrc = readFileSync(join(REPO_ROOT, "src", "lib", "status-board.ts"), "utf8");
const escalateSrc = readFileSync(join(REPO_ROOT, "src", "lib", "escalate.ts"), "utf8");
const containmentSrc = readFileSync(join(REPO_ROOT, "src", "lib", "containment.ts"), "utf8");
const fleetControlSrc = readFileSync(join(REPO_ROOT, "src", "lib", "fleet-control.ts"), "utf8");

type Requirement = [label: string, re: RegExp];

// Markdown hard-wraps prose at ~100 columns, so a phrase a requirement is looking for can have a
// line break (and reflowed indentation) in the middle of it. Collapse all whitespace runs to a
// single space before matching so requirements can be written as plain, wrap-agnostic phrases.
function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ");
}

function runRequirements(text: string, requirements: Requirement[]): { ok: boolean; missing: string[] } {
  const normalized = normalizeWhitespace(text);
  const missing = requirements.filter(([, re]) => !re.test(normalized)).map(([label]) => label);
  return { ok: missing.length === 0, missing };
}

// ── CLAIM 1: names the four reader-first principles verbatim, cites no clause number ──────────

export function checkFourPrinciplesNoClauseNumber(text: string): { ok: boolean; missing: string[] } {
  const requirements: Requirement[] = [
    ["cites the standard by number and edition", /ISO 24495-1:2023/],
    ["names the relevant principle", /readers get what they need.{0,15}relevant/is],
    ["names the findable principle", /readers can easily find what they need.{0,15}findable/is],
    ["names the understandable principle", /readers can easily understand what they find.{0,20}understandable/is],
    ["names the usable principle", /readers can easily use the information.{0,15}usable/is],
    ["explicitly disclaims citing a clause number", /cites no clause number|no clause number.{0,40}(read|seen)/is],
  ];
  const result = runRequirements(text, requirements);
  // Belt-and-braces: the doc must not itself contain an ISO clause citation (e.g. "clause 5",
  // "clause 6.2") anywhere — the disclaimer above would be a lie if one slipped in.
  const clauseNumberPresent = /\bclause\s+\d/i.test(normalizeWhitespace(text));
  return { ok: result.ok && !clauseNumberPresent, missing: clauseNumberPresent ? [...result.missing, "no literal ISO clause number citation"] : result.missing };
}

test("operator-message-standard: names the four ISO 24495-1:2023 principles and cites no clause number", () => {
  const result = checkFourPrinciplesNoClauseNumber(doc);
  assert.ok(result.ok, `doc is missing: ${result.missing.join(", ")}`);
});

test("operator-message-standard falsifier: prose naming the standard without the four principles turns claim 1 RED", () => {
  const result = checkFourPrinciplesNoClauseNumber("This document adopts ISO 24495-1:2023. See clause 5.2 for details.");
  assert.equal(result.ok, false);
  assert.ok(result.missing.length > 0);
});

// ── CLAIM 2: opening states the misleading messages were WRONG not unclear, polish makes it worse ─

export function checkWrongNotUnclearOpening(text: string): { ok: boolean; missing: string[] } {
  const requirements: Requirement[] = [
    ["states the messages were wrong rather than unclear", /wrong rather than unclear/i],
    ["states a plain-language pass makes a wrong message worse", /(makes (it|them) worse|polishing a false statement makes it worse)/i],
    ["appears near the top of the document, not buried", /^[\s\S]{0,2200}wrong rather than unclear/i],
  ];
  return runRequirements(text, requirements);
}

test("operator-message-standard: opening states the misleading messages were wrong, not unclear, and that polish makes a false statement worse", () => {
  const result = checkWrongNotUnclearOpening(doc);
  assert.ok(result.ok, `doc is missing: ${result.missing.join(", ")}`);
});

test("operator-message-standard falsifier: a doc that only calls the messages 'unclear' turns claim 2 RED", () => {
  const result = checkWrongNotUnclearOpening("These messages were unclear. We will make them clearer with better wording.");
  assert.equal(result.ok, false);
});

// ── CLAIM 3: governed set is unstructured messages only; containment strings excluded by name ──

export function checkUnstructuredScopeExcludesContainment(text: string): { ok: boolean; missing: string[] } {
  const requirements: Requirement[] = [
    ["defines the governed set as unstructured messages", /governs only.{0,15}\*?\*?unstructured\*?\*?.{0,15}messages/is],
    ["names W1-T238 by id", /W1-T238/],
    ["names W1-T1281 by id", /W1-T1281/],
    ["names the containment verdict strings as excluded", /containment verdict strings.{0,200}(W1-T238|excluded)/is],
  ];
  return runRequirements(text, requirements);
}

test("operator-message-standard: governed set is unstructured messages only, and the containment verdict strings are excluded by name", () => {
  const result = checkUnstructuredScopeExcludesContainment(doc);
  assert.ok(result.ok, `doc is missing: ${result.missing.join(", ")}`);
});

test("operator-message-standard falsifier: a scope statement with no named exclusion turns claim 3 RED", () => {
  const result = checkUnstructuredScopeExcludesContainment("This standard applies to all operator messages, everywhere.");
  assert.equal(result.ok, false);
});

test("operator-message-standard: the containment verdict string the doc quotes still exists verbatim in containment.ts", () => {
  // Grounds the exclusion in real source rather than a doc that quotes a sentence nobody can find.
  assert.match(
    containmentSrc,
    /this is NOT the same fact as an unattempted write and containment stays UNPROVEN/,
    "containment.ts's turns-exhausted verdict string must still exist as quoted by the doc",
  );
});

// ── CLAIM 4: separates machine-checkable from reader-judged; claims no readability score ───────

export function checkMachineVsReaderSplit(text: string): { ok: boolean; missing: string[] } {
  const requirements: Requirement[] = [
    ["marks something as mechanically checkable", /mechanically checkable/i],
    ["marks something as reviewer-judged / reader-judged", /(reviewer-judged|reader-judged)/i],
    ["disclaims any readability score", /no readability score|not a readability score|defines no readability score/i],
    ["disclaims a word-count or sentence-length gate", /(word.count|sentence.length).{0,40}(gate|threshold|none)/i],
  ];
  return runRequirements(text, requirements);
}

test("operator-message-standard: separates the machine-checkable part from the reader-judged part, and claims no readability score", () => {
  const result = checkMachineVsReaderSplit(doc);
  assert.ok(result.ok, `doc is missing: ${result.missing.join(", ")}`);
});

test("operator-message-standard falsifier: a doc proposing a readability score turns claim 4 RED", () => {
  const result = checkMachineVsReaderSplit("We will compute a readability score and gate merges on a word-count threshold.");
  assert.equal(result.ok, false);
});

// ── CLAIM 5: the check tests for a populated-or-null action slot, never asserts truth ──────────

export function checkActionSlotNeverAssertsTruth(text: string): { ok: boolean; missing: string[] } {
  const requirements: Requirement[] = [
    ["describes the slot check as populated or explicitly null", /populated,?\s*(or is explicitly null|or explicitly null)/i],
    ["names NextActionRule by name", /NextActionRule/],
    ["names the action field as required/non-optional", /action.{0,40}(REQUIRED|non-optional)/is],
    ["states the check never proves the message true", /(cannot|must not|never).{0,60}(certif|prove).{0,40}(true|right)/is],
  ];
  return runRequirements(text, requirements);
}

test("operator-message-standard: the check tests for a populated-or-null action slot and never asserts a message is true", () => {
  const result = checkActionSlotNeverAssertsTruth(doc);
  assert.ok(result.ok, `doc is missing: ${result.missing.join(", ")}`);
});

test("operator-message-standard falsifier: a doc that claims the check certifies correctness turns claim 5 RED", () => {
  const result = checkActionSlotNeverAssertsTruth("The linter checks that NextActionRule.action is present and certifies the message is correct.");
  assert.equal(result.ok, false);
});

test("operator-message-standard: NextActionRule.action is still a REQUIRED (non-optional) field in status-board.ts, as the doc claims", () => {
  // Grounds claim 5's mechanical-check description in the actual type — if `action` ever became
  // optional (`action?:`), the doc's claim that this slot is type-enforced would go stale.
  assert.match(
    statusBoardSrc,
    /interface NextActionRule<TCtx>\s*\{\s*applies:\s*\(ctx:\s*TCtx\)\s*=>\s*boolean;\s*action:\s*\(ctx:\s*TCtx\)\s*=>\s*string;\s*\}/,
    "NextActionRule must still declare both `applies` and `action` as required (non-optional) fields",
  );
  assert.doesNotMatch(statusBoardSrc, /action\?:\s*\(ctx: TCtx\)/, "action must not have become optional");
});

test("operator-message-standard: Escalation.options is still REQUIRED (non-optional) in escalate.ts, as the doc claims", () => {
  assert.match(
    escalateSrc,
    /options:\s*EscalationOption\[\];/,
    "Escalation.options must still be a required (non-optional) field",
  );
  assert.doesNotMatch(escalateSrc, /options\?:\s*EscalationOption\[\]/, "options must not have become optional");
});

// ── CLAIM 6: absence must distinguish "observed absent" from "not observed" ────────────────────

export function checkAbsenceMustDistinguish(text: string): { ok: boolean; missing: string[] } {
  const requirements: Requirement[] = [
    ["requires distinguishing observed absent from not observed", /observed absent.{0,200}not observed/is],
    ["ties the requirement to asserting a negative or absence", /asserts? (a )?negative or (an )?absence/i],
    ["cites the empty-latches exhibit as the failure mode", /renderLatchesBlock|no active latches/],
  ];
  return runRequirements(text, requirements);
}

test('operator-message-standard: a message asserting an absence must distinguish "observed absent" from "not observed"', () => {
  const result = checkAbsenceMustDistinguish(doc);
  assert.ok(result.ok, `doc is missing: ${result.missing.join(", ")}`);
});

test("operator-message-standard falsifier: a doc silent on the observed-absent distinction turns claim 6 RED", () => {
  const result = checkAbsenceMustDistinguish("Messages should be clear and concise.");
  assert.equal(result.ok, false);
});

test('operator-message-standard: renderLatchesBlock\'s "no active latches" line the doc cites still exists verbatim', () => {
  assert.match(statusBoardSrc, /if \(!latches\.rows\.length\) \{\s*out\.push\("no active latches"\);/, "the exhibit quoted by the doc must still match the real source");
});

// ── CLAIM 7: surfaces in scope named alongside the daemon-stdout exclusion and its reason ──────

export function checkSurfacesInScopeAndStdoutExclusion(text: string): { ok: boolean; missing: string[] } {
  const requirements: Requirement[] = [
    ["names renderStatusBoardText / rmd status as in scope", /renderStatusBoardText/],
    ["names the escalation summary/detail as in scope", /summary.{0,20}detail|`summary`.{0,60}`detail`/is],
    ["excludes the daemon's stdout by name", /daemon('s)? (own )?stdout/i],
    // W1-T2817. This requirement USED to be /(forensic record|retro greps)/i — two phrases, not a
    // reason. It therefore passed on a doc asserting the OPPOSITE of the reason it was checking for,
    // which is exactly what happened when the false premise was retired: the corrected paragraph
    // QUOTES the retired phrase, so the old regex stayed green through a correction that reversed
    // the claim under it. It now anchors on the code the reason cites.
    ["gives a reason for the stdout exclusion, grounded in what the code does", /ROTATED_LOG_FILES|NEVER_ROTATE_FILENAME/],
    ["marks the retired premise as corrected rather than silently dropping it", /used to give|is corrected here/i],
  ];
  return runRequirements(text, requirements);
}

test("operator-message-standard: the surfaces in scope are named alongside the daemon stdout exclusion and its reason", () => {
  const result = checkSurfacesInScopeAndStdoutExclusion(doc);
  assert.ok(result.ok, `doc is missing: ${result.missing.join(", ")}`);
});

test("operator-message-standard falsifier: the retired phrase ALONE no longer satisfies claim 7 — the case that used to pass", () => {
  // The exact shape the old requirement accepted: the exclusion named, both phrases present, and no
  // code-grounded reason anywhere. This must now be RED, or the correction is undone the moment
  // someone reinstates the premise.
  const result = checkSurfacesInScopeAndStdoutExclusion(
    "This standard covers renderStatusBoardText and the escalation `summary` and `detail` fields. " +
      "The daemon's stdout is out of scope: its lines are the forensic record that every retro greps.",
  );
  assert.equal(result.ok, false, "a doc offering only the retired premise must not satisfy claim 7");
  assert.ok(
    result.missing.some((m) => m.includes("grounded in what the code does")),
    `the missing list should name the code-grounded requirement, got: ${result.missing.join(", ")}`,
  );
});

test("operator-message-standard falsifier: a doc naming surfaces with no stdout exclusion turns claim 7 RED", () => {
  const result = checkSurfacesInScopeAndStdoutExclusion("This standard covers renderStatusBoardText and the escalation summary/detail fields.");
  assert.equal(result.ok, false);
});

// ── CLAIM 8: a filled action slot did not stop the daemon-liveness message from being false ────

export function checkFilledSlotStillFalse(text: string): { ok: boolean; missing: string[] } {
  const requirements: Requirement[] = [
    ["quotes the daemon-liveness message", /the daemon is not running/i],
    ["states it already satisfies the action slot", /(already )?satisf(y|ies).{0,20}(part )?\(?iii\)?/is],
    ["states it is still false", /(is )?(still|nonetheless) FALSE/i],
    ["names NextActionRule as the type that already enforces the slot", /NextActionRule.{0,5}already type-enforces/is],
  ];
  return runRequirements(text, requirements);
}

test("operator-message-standard: records that a filled action slot did not stop the daemon liveness message from being false", () => {
  const result = checkFilledSlotStillFalse(doc);
  assert.ok(result.ok, `doc is missing: ${result.missing.join(", ")}`);
});

test("operator-message-standard falsifier: a doc that omits the filled-but-false exhibit turns claim 8 RED", () => {
  const result = checkFilledSlotStillFalse("NextActionRule requires an action field, which is a good structural guarantee.");
  assert.equal(result.ok, false);
});

test("operator-message-standard: the daemon-liveness rule the doc quotes still exists verbatim in status-board.ts", () => {
  // W1-T2450 legitimately split this rule in two (an "unknown" — no launchd sensor — rule now
  // sits ahead of it, so a sensor-absent host is never told "rmd up" for a process it never
  // actually asked about) — but the MESSAGE this doc quotes, and the "stopped" predicate that
  // still guards it, are byte-for-byte the ones asserted here; only the now-excluded "unknown"
  // case is new. No existing operator message is reworded (see CLAIM 9, below).
  assert.match(
    statusBoardSrc,
    /applies: \(ctx\) => \{\s*const row = ctx\.services\.find\(\(s\) => s\.service === "daemon"\);\s*return row !== undefined && livenessState\(row\) === "stopped";\s*\},\s*action: \(\) => "the daemon is not running — `rmd up` \(or `rmd daemon \.\.\.`\) to resume the fleet",/,
    "the daemon-liveness NextActionRule the doc cites must still match the real source, unrewritten",
  );
});

// ── CLAIM 9: no existing operator message is reworded by this task ─────────────────────────────

export function checkNoRewordClaim(text: string): { ok: boolean; missing: string[] } {
  const requirements: Requirement[] = [
    ["states no existing operator message is reworded by this task", /no existing operator message is reworded/i],
    ["states a rewrite is separate, later work", /(separate,?\s*later work|later,?\s*per-surface (rewrite|job))/i],
  ];
  return runRequirements(text, requirements);
}

test("operator-message-standard: the doc states no existing operator message is reworded by this task", () => {
  const result = checkNoRewordClaim(doc);
  assert.ok(result.ok, `doc is missing: ${result.missing.join(", ")}`);
});

test("operator-message-standard falsifier: a doc silent on the no-reword constraint turns claim 9 RED", () => {
  const result = checkNoRewordClaim("This document defines a standard for operator messages.");
  assert.equal(result.ok, false);
});

test("operator-message-standard: every operator-message exhibit the doc quotes is unchanged in its real source file (no rewording happened)", () => {
  // Direct proof, not just a doc self-assertion: every exhibit string this doc cites still
  // exists byte-for-byte in the source file it came from. If this task had rewritten any of
  // them, one of these matches would fail.
  assert.match(fleetControlSrc, /PAUSE held on \$\{sharedPauseRef\(\)\}/, "fleet-control.ts's PAUSE line must be unchanged");
  assert.match(statusBoardSrc, /"no active latches"/, "status-board.ts's empty-latches line must be unchanged");
  assert.match(statusBoardSrc, /"the daemon is not running — `rmd up` \(or `rmd daemon \.\.\.`\) to resume the fleet"/, "status-board.ts's daemon-liveness line must be unchanged");
  assert.match(
    containmentSrc,
    /"turns-exhausted — the probe ran out of its turn budget before an OS-denial for the outside-cwd " \+/,
    "containment.ts's turns-exhausted verdict must be unchanged",
  );
});
