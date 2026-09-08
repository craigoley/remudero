import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { execWhitelistedProof, judgeReview, parseWhitelistedProof } from "../src/lib/review.js";
import { proofGrepSafetyViolations } from "../src/lib/task-linter.js";
import type { Task } from "../src/lib/plan.js";

// ── W1-T3208 ──────────────────────────────────────────────────────────────
//
// W1-T2983 measured it: `parseDialectGrep` (review.ts) takes a `grep:` proof's PATTERN as
// everything before the trailing " in <path>", so the pattern is, BY CONSTRUCTION, a literal
// substring of the proof line that carries it. When a proof's TARGET is the file holding that
// declaration (a plan shard grepping itself), the pattern's first match is always its own
// criterion line — 167 of 168 such proofs measured self-certifying, 23 pinning nothing else.
//
// THE FIX BELONGS IN THE MATCHER (execWhitelistedProof), not the pattern: `proof-grep-safety`
// (task-linter.ts) refuses every regex anchor a pattern could use to exclude itself, and that
// refusal must survive untouched. This suite proves: (1) a self-only proof now grades UNMET, (2)
// the SAME proof with a genuine match elsewhere still PASSES — the exclusion removes one line, not
// the proof, (3) a proof targeting any OTHER file is unaffected, and (4) proof-grep-safety is
// unchanged.

const SHARD_PATH = "plan/tasks.d/W1-T9001-fixture.yaml";

/** A fixture that mirrors a real plan shard: TWO grep proofs pointed at their OWN carrying file.
 *  The first (`SELF_ONLY`) pattern appears NOWHERE else in the file — a proof pinning nothing but
 *  its own text. The second (`WITH_REAL_MATCH`) pattern ALSO appears once more, in the rationale
 *  prose below — a genuine match that must survive the exclusion of its own criterion line. Both
 *  criteria live in the SAME target file on purpose (the falsifier's positive control): a suite
 *  that only had the self-only case could not distinguish "excluded the right line" from "broke
 *  grep entirely".
 */
function writeFixtureShard(dir: string): void {
  const text =
    `- id: W1-T9001\n` +
    `  title: "fixture"\n` +
    `  rationale: |\n` +
    `    FIXTURE_WITH_REAL_MATCH_TOKEN is genuinely discussed here too, a second occurrence.\n` +
    `  acceptance:\n` +
    `    - claim: "self-only pins nothing but its own text"\n` +
    `      proof: "grep: FIXTURE_SELF_ONLY_TOKEN in ${SHARD_PATH}"\n` +
    `    - claim: "the real-match sibling pins genuine evidence too"\n` +
    `      proof: "grep: FIXTURE_WITH_REAL_MATCH_TOKEN in ${SHARD_PATH}"\n` +
    `  files: [${SHARD_PATH}]\n` +
    `  status: queued\n`;
  mkdirSync(join(dir, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(dir, SHARD_PATH), text);
}

function fixtureDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-w3208-self-line-"));
  writeFixtureShard(dir);
  return dir;
}

// ── CLAIM 1: a grep proof whose only match is its own criterion line grades UNMET ──────────────

test("CLAIM 1: a proof pinning nothing but its own criterion line now FAILS (was 'pass' by construction)", () => {
  const dir = fixtureDir();
  const proofText = `grep: FIXTURE_SELF_ONLY_TOKEN in ${SHARD_PATH}`;
  const whitelisted = parseWhitelistedProof(proofText);
  assert.ok(whitelisted, "the dialect grep body must still parse");
  assert.equal(whitelisted!.kind, "grep");
  // The compiled argv is untouched — no anchor, no new metacharacter (bears on claim 4 too).
  assert.deepEqual(whitelisted!.args, ["-arn", "--", "FIXTURE_SELF_ONLY_TOKEN", SHARD_PATH]);
  assert.equal(
    execWhitelistedProof(whitelisted!, dir),
    "fail",
    "the proof's ONLY match in the target file is the criterion line that carries it — unmet",
  );
});

test("CLAIM 1 (end-to-end, naming the proof): judgeReview grades a self-only proof executed_fail/unmet, naming the proof in the reason", () => {
  const dir = fixtureDir();
  const proofText = `grep: FIXTURE_SELF_ONLY_TOKEN in ${SHARD_PATH}`;
  const verdict = judgeReview([{ claim: "self-only pins nothing but its own text", proof: proofText }], {
    diff: "",
    report: "an unrelated report that never substantiates anything",
    headCheckoutDir: dir,
  });
  assert.equal(verdict.criteria[0].proof_exec, "executed_fail");
  assert.equal(verdict.criteria[0].met, false);
  assert.match(
    verdict.criteria[0].reason,
    /FIXTURE_SELF_ONLY_TOKEN in plan\/tasks\.d\/W1-T9001-fixture\.yaml/,
    "the FAIL reason must name the proof that failed, not just say 'unmet'",
  );
  assert.equal(verdict.state, "failure");
});

// ── CLAIM 2: the SAME shape of proof, with a genuine match elsewhere, still PASSES ──────────────

test("CLAIM 2: a sibling proof in the SAME target file, whose pattern ALSO appears as real evidence, still PASSES", () => {
  const dir = fixtureDir();
  const proofText = `grep: FIXTURE_WITH_REAL_MATCH_TOKEN in ${SHARD_PATH}`;
  const whitelisted = parseWhitelistedProof(proofText);
  assert.ok(whitelisted);
  assert.equal(
    execWhitelistedProof(whitelisted!, dir),
    "pass",
    "excluding the criterion line removes ONE line, not the proof — the rationale's genuine mention still counts",
  );
});

// ── CLAIM 3: a proof targeting any OTHER file grades byte-identically to today ──────────────────

test("CLAIM 3: a proof targeting an ORDINARY (non-self) file still PASSES on a genuine match", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-w3208-other-file-"));
  writeFileSync(join(dir, "other.ts"), "export const REAL_TOKEN = 1; // REAL_TOKEN lives here\n");
  const whitelisted = parseWhitelistedProof("grep: REAL_TOKEN in other.ts");
  assert.ok(whitelisted);
  assert.equal(execWhitelistedProof(whitelisted!, dir), "pass");
});

test("CLAIM 3: a proof targeting an ORDINARY (non-self) file still FAILS on a genuine zero-match", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-w3208-other-file-"));
  writeFileSync(join(dir, "other.ts"), "nothing relevant in here\n");
  const whitelisted = parseWhitelistedProof("grep: ABSENT_TOKEN in other.ts");
  assert.ok(whitelisted);
  assert.equal(execWhitelistedProof(whitelisted!, dir), "fail");
});

test("CLAIM 3: the legacy monolith plan path keeps direct-executor grep behavior", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-w3208-monolith-plan-"));
  mkdirSync(join(dir, "plan"), { recursive: true });
  writeFileSync(join(dir, "plan", "tasks.yaml"), '      proof: "grep: MONOLITH_SELF_TOKEN in plan/tasks.yaml"\n');
  const whitelisted = parseWhitelistedProof("grep: MONOLITH_SELF_TOKEN in plan/tasks.yaml");
  assert.ok(whitelisted);
  assert.equal(execWhitelistedProof(whitelisted!, dir), "pass");
});

test("CLAIM 3: text that reads like 'pattern in path' inside an UNRELATED file's genuine content is not mistaken for a self-declaration and still PASSES", () => {
  // A control against over-matching: the exclusion regex is anchored to THIS proof's own compiled
  // pattern+path, so ordinary prose that happens to contain "<pattern> in <path>" for a DIFFERENT
  // pair is never touched — only checked here for the identical pair, which is legitimately what
  // a self-declaring line looks like, on a file that is NOT the proof's own declaration source.
  const dir = mkdtempSync(join(tmpdir(), "rmd-w3208-lookalike-"));
  writeFileSync(join(dir, "notes.md"), "REAL_TOKEN in other.ts is documented here, and only here.\n");
  const whitelisted = parseWhitelistedProof("grep: REAL_TOKEN in notes.md");
  assert.ok(whitelisted);
  assert.equal(
    execWhitelistedProof(whitelisted!, dir),
    "pass",
    "the reconstructed self-text checked is THIS proof's own pattern+path ('REAL_TOKEN in notes.md'), " +
      "which never occurs verbatim here — the coincidental 'REAL_TOKEN in other.ts' names a different path, " +
      "so the line is a genuine match, not a self-declaration, and must not be excluded",
  );
});

// ── CLAIM 4: proof-grep-safety is unchanged — no metacharacter becomes newly permitted ──────────

function task(over: Partial<Task> & { id: string }): Task {
  return {
    title: over.id,
    repo: "remudero",
    depends_on: [],
    type: "implement",
    verify: "auto",
    risk: "medium",
    status: "queued",
    attempts: 0,
    origin: "architect",
    files: ["src/lib/example.ts"],
    acceptance: [{ claim: "does the thing", proof: "unit test: test/foo.test.ts" }],
    ...over,
  };
}

test("CLAIM 4: an unescaped BRE metacharacter in a grep: pattern is STILL blocked by proof-grep-safety", () => {
  const t = task({
    id: "W1-T9002",
    acceptance: [{ claim: "c", proof: "grep: foo[bar in src/lib/example.ts" }],
  });
  const violations = proofGrepSafetyViolations(t);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]!.check, "proof-grep-safety");
  assert.equal(violations[0]!.severity, "block");
  assert.match(violations[0]!.message, /\[/, "the offending metacharacter is still named in the refusal");
});

test("CLAIM 4: an ordinary, metacharacter-free grep: proof is still permitted (no new restriction added)", () => {
  const t = task({
    id: "W1-T9003",
    acceptance: [{ claim: "c", proof: "grep: ordinaryPattern in src/lib/example.ts" }],
  });
  assert.deepEqual(proofGrepSafetyViolations(t), []);
});
