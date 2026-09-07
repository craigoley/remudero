import assert from "node:assert/strict";
import { test } from "node:test";
import { lintTask, proofGrepSelfCertifyingViolations, proofGrepUnmatchableViolations } from "../src/lib/task-linter.js";
import type { Task } from "../src/lib/plan.js";

// ── W1-T2990: WARN when a `grep:` proof aimed at the task's OWN plan record matches nothing there
//    except the criterion carrying it — and stop that same self-match hiding the sibling check.
//
// A grep proof's pattern is everything before the trailing " in <path>" (parseDialectGrep,
// review.ts), so when the target is the record the proof LIVES IN, the pattern is a literal
// substring of its own `proof:` line and matches itself before it matches anything it was written
// to pin. W1-T2983 measured 168 such proofs plan-wide, 167 still matching with the acceptance block
// deleted. The operator ruled advisory — "lean into automation and not block unless required" — so
// both halves here are WARN with no override.

/** A minimal, otherwise-clean Task fixture — mirrors test/lint-grep-unmatchable.test.ts's helper. */
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

function reader(files: Record<string, string>): (rel: string) => string | undefined {
  return (rel) => files[rel];
}

const SHARD_PATH = "plan/tasks.d/W1-T4242-a-record.yaml";

/** A record whose rationale prose does NOT contain the anchor — so the only line the pattern finds
 *  is the proof that carries it. `prose` lets a test put the anchor outside the block instead. */
function record(id: string, anchor: string, prose: string): string {
  return (
    `- id: ${id}\n` +
    `  title: "a record"\n` +
    `  rationale: |\n` +
    `    ${prose}\n` +
    `  acceptance:\n` +
    `    - claim: "the shard records the thing"\n` +
    `      proof: "grep: ${anchor} in ${SHARD_PATH}"\n` +
    `  files: [${SHARD_PATH}]\n` +
    `  status: queued\n`
  );
}

const ANCHOR = "THE SHARD RECORDS THE THING";

// ── CLAIM 1: a self-targeting proof pinning nothing but its own criterion is WARNed ──

test("CLAIM 1: a grep proof matching nothing outside its own acceptance block is WARNed, exactly once", () => {
  const t = task({
    id: "W1-T4242",
    acceptance: [{ claim: "the shard records the thing", proof: `grep: ${ANCHOR} in ${SHARD_PATH}` }],
  });
  const text = record("W1-T4242", ANCHOR, "unrelated prose that never repeats the anchor");
  const violations = proofGrepSelfCertifyingViolations(t, { readGrepProofFile: reader({ [SHARD_PATH]: text }) });
  assert.equal(violations.length, 1);
  assert.equal(violations[0]!.check, "proof-grep-self-certifying");
  assert.equal(violations[0]!.severity, "warn");
  assert.match(violations[0]!.message, /matches NOTHING/);
  assert.match(violations[0]!.message, /W1-T4242's own/);
});

// ── CLAIM 2: silence when the anchor is real evidence, and when the target is ordinary source ──

test("CLAIM 2: a self-targeting proof whose anchor ALSO appears in the prose is silent", () => {
  const t = task({
    id: "W1-T4242",
    acceptance: [{ claim: "the shard records the thing", proof: `grep: ${ANCHOR} in ${SHARD_PATH}` }],
  });
  const text = record("W1-T4242", ANCHOR, `prose that does say ${ANCHOR} out loud`);
  assert.deepEqual(proofGrepSelfCertifyingViolations(t, { readGrepProofFile: reader({ [SHARD_PATH]: text }) }), []);
});

test("CLAIM 2: a proof naming an ordinary source file is silent even when it matches only once", () => {
  const t = task({
    id: "W1-T4242",
    acceptance: [{ claim: "c", proof: "grep: someSymbol in src/lib/example.ts" }],
  });
  const violations = proofGrepSelfCertifyingViolations(t, {
    readGrepProofFile: reader({ "src/lib/example.ts": "export const someSymbol = 1;\n" }),
  });
  assert.deepEqual(violations, []);
});

test("CLAIM 2: silent with no reader, on a non-grep proof, and on an unparseable proof", () => {
  const t = task({
    id: "W1-T4242",
    acceptance: [{ claim: "the shard records the thing", proof: `grep: ${ANCHOR} in ${SHARD_PATH}` }],
  });
  assert.deepEqual(proofGrepSelfCertifyingViolations(t), []);
  const text = record("W1-T4242", ANCHOR, "unrelated prose");
  const files = reader({ [SHARD_PATH]: text });
  assert.deepEqual(
    proofGrepSelfCertifyingViolations(task({ id: "W1-T4242", acceptance: [{ claim: "c", proof: "unit test: test/x.test.ts" }] }), { readGrepProofFile: files }),
    [],
  );
  assert.deepEqual(
    proofGrepSelfCertifyingViolations(task({ id: "W1-T4242", acceptance: [{ claim: "c", proof: "just prose" }] }), { readGrepProofFile: files }),
    [],
  );
  assert.deepEqual(
    proofGrepSelfCertifyingViolations(task({ id: "W1-T4242", acceptance: [{ claim: "c", proof: `grep: ${ANCHOR} in ${SHARD_PATH}`, satisfied_by: "architect" }] }), { readGrepProofFile: files }),
    [],
  );
});

// ── CLAIM 3: ownership comes from the record's own list-item id line ──

test("CLAIM 3: a proof naming ANOTHER task's shard is silent — ownership is the id line, not the path", () => {
  const t = task({
    id: "W1-T9999",
    acceptance: [{ claim: "the shard records the thing", proof: `grep: ${ANCHOR} in ${SHARD_PATH}` }],
  });
  const text = record("W1-T4242", ANCHOR, "unrelated prose");
  assert.deepEqual(proofGrepSelfCertifyingViolations(t, { readGrepProofFile: reader({ [SHARD_PATH]: text }) }), []);
});

test("CLAIM 3: in the monolith, only the task's OWN acceptance block is stripped", () => {
  const MONO = "plan/tasks.yaml";
  const anchor = "ONLY IN THE SIBLING BLOCK";
  // The anchor appears in a DIFFERENT record's acceptance block, which must count as outside
  // evidence for this task: stripping every block would wrongly warn here.
  const text =
    `- id: W1-T1111\n  acceptance:\n    - claim: "x"\n      proof: "grep: ${anchor} in ${MONO}"\n` +
    `- id: W1-T2222\n  rationale: |\n    nothing relevant here\n` +
    `  acceptance:\n    - claim: "y"\n      proof: "grep: ${anchor} in ${MONO}"\n`;
  const own = task({ id: "W1-T2222", acceptance: [{ claim: "y", proof: `grep: ${anchor} in ${MONO}` }] });
  assert.deepEqual(proofGrepSelfCertifyingViolations(own, { readGrepProofFile: reader({ [MONO]: text }) }), []);
});

// ── CLAIM 4: the suppression carve-out, and that ordinary targets are untouched ──

test("CLAIM 4: a line-seam hidden by its own proof line is now reported by the sibling check", () => {
  const anchor = "a phrase that wraps across the seam";
  const text =
    `- id: W1-T4242\n` +
    `  rationale: |\n` +
    `    a phrase that wraps across\n` +
    `    the seam and so can never match\n` +
    `  acceptance:\n` +
    `    - claim: "c"\n` +
    `      proof: "grep: ${anchor} in ${SHARD_PATH}"\n`;
  const t = task({ id: "W1-T4242", acceptance: [{ claim: "c", proof: `grep: ${anchor} in ${SHARD_PATH}` }] });
  const violations = proofGrepUnmatchableViolations(t, { readGrepProofFile: reader({ [SHARD_PATH]: text }) });
  assert.equal(violations.length, 1);
  assert.equal(violations[0]!.check, "proof-grep-unmatchable");
  assert.match(violations[0]!.message, /line break/);
  // And the new check CEDES it — the two never both report one criterion.
  assert.deepEqual(proofGrepSelfCertifyingViolations(t, { readGrepProofFile: reader({ [SHARD_PATH]: text }) }), []);
});

test("CLAIM 4: a non-plan target still behaves exactly as before the carve-out", () => {
  const t = task({
    id: "W1-T4242",
    acceptance: [{ claim: "c", proof: "grep: a phrase that wraps across the seam in docs/x.md" }],
  });
  const text = "a phrase that wraps across\nthe seam and so can never match\n";
  const violations = proofGrepUnmatchableViolations(t, { readGrepProofFile: reader({ "docs/x.md": text }) });
  assert.equal(violations.length, 1);
  assert.equal(violations[0]!.check, "proof-grep-unmatchable");
});

// ── CLAIM 5: it never blocks, and lintTask does not carry it ──

test("CLAIM 5: the check is advisory — lintTask stays ok and never returns this check", () => {
  const t = task({
    id: "W1-T4242",
    acceptance: [{ claim: "the shard records the thing", proof: `grep: ${ANCHOR} in ${SHARD_PATH}` }],
    files: [SHARD_PATH],
    verify: "human",
  });
  const text = record("W1-T4242", ANCHOR, "unrelated prose");
  const opts = { readGrepProofFile: reader({ [SHARD_PATH]: text }), moduleExists: () => true };
  const violations = proofGrepSelfCertifyingViolations(t, opts);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]!.severity, "warn");
  assert.equal(
    violations.filter((v) => v.severity === "block").length,
    0,
    "the operator ruled advisory: this check must never emit a blocking severity",
  );
  const lint = lintTask(t, opts);
  assert.equal(lint.ok, true);
  assert.equal(
    lint.violations.some((v) => v.check === "proof-grep-self-certifying"),
    false,
    "deliberately NOT folded into lintTask's aggregate — it rides the one changed-tasks call site",
  );
});
