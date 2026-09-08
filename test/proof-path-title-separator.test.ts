// test/proof-path-title-separator.test.ts — W1-T3073.
//
// `unit test:` has exactly TWO forms: a whole test-file path, or a bare test TITLE. A body written
// as `test/foo.test.ts::some title` is neither, and until this task it was not refused — it failed
// the exact-path regex, fell through to the bare-title arm, and the WHOLE string was escaped into
// one `--test-name-pattern`. No test is named that, so it matched zero, and the criterion degraded
// to the keyword floor without saying so. MEASURED at origin/main 36c36000: W1-T3071's four proofs
// all resolved `not_executable` while its plan-only filing still merged green.
//
// THE SURFACE UNDER TEST IS `TEST_PATH_TITLE_SEPARATOR_RE` (src/lib/review.ts). This file is its
// falsifier: the cases below exercise BOTH arms — a body it matches (refused) and bodies it must
// NOT match (the whole-file form, the bare-title form, and a non-path `::`). Note this does NOT
// make it 'exercised' for test/negative-reachability-ratchet.test.ts, whose whole `_RE`
// population reads fixture-less by that detector's definition; its per-file row is raised by one
// instead, which is how that census records a new surface.
//
// The refusal lives in the SHARED parser so every consumer inherits it from one decision:
// `rmd check-proof`, the reviewer, and the changed-task lint path. There is deliberately no second
// interpretation in the linter.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  PROOF_DIALECT,
  explainUnitTestProofRefusal,
  parseWhitelistedProof,
  resolveNameFilteredCandidates,
} from "../src/lib/review.js";
import { proofDialectViolations } from "../src/lib/task-linter.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

// W1-T3071's REAL shape, not invented punctuation — the design says so explicitly.
const REAL_PATH = "test/cli-verbs-mint-the-app-token.test.ts";
const REAL_TITLE = "every help arm carries the token";
const BAD = `unit test: ${REAL_PATH}::${REAL_TITLE}`;

// ── acceptance 1: the grammar is refused, not compiled as one literal name ────────────────────────

test("W1-T3073: a `unit test: <path>::<title>` proof is REFUSED as unsupported grammar", () => {
  assert.equal(parseWhitelistedProof(BAD), null, "the shared parser must refuse it outright");
  const why = explainUnitTestProofRefusal(BAD);
  assert.ok(why, "and must be able to say why");
  assert.match(why, /not a supported/, "the sentence names the grammar as unsupported");
  assert.ok(why.includes(`unit test: ${REAL_PATH}`), "it offers the whole-file form as one remedy");
  assert.ok(why.includes(`unit test: ${REAL_TITLE}`), "and the bare-title form as the other");
});

// ── acceptance 6 (the mutant): what the refusal PREVENTS, measured ────────────────────────────────

test("W1-T3073: MUTANT — without the refusal this body reaches the bare-title arm and resolves to ZERO real tests", () => {
  // The refusal's whole value is the harm it stops, so that harm is measured here rather than
  // asserted. Reaching the bare-title arm is exactly what main does; the label it would carry is the
  // WHOLE string, and `resolveNameFilteredCandidates` — the same resolver review uses — finds no
  // test file containing it. That zero is the silent degrade.
  const wholeString = `${REAL_PATH}::${REAL_TITLE}`;
  const resolved = resolveNameFilteredCandidates(REPO_ROOT, wholeString);
  assert.equal(resolved.status, "absent", "a readable corpus was searched and NO file names path-and-title-together");

  // POSITIVE CONTROL on the resolver itself: it is not simply blind, and `absent` above is a real
  // measurement rather than an unreadable corpus. A title this repo really has resolves through the
  // identical call — and it is this very test's own title, so the control cannot go stale silently.
  const control = resolveNameFilteredCandidates(
    REPO_ROOT,
    "MUTANT — without the refusal this body reaches the bare-title arm",
  );
  assert.equal(control.status, "resolved", "control: a real title in this very file resolves");
  assert.ok(control.status === "resolved" && control.files.length > 0, "control names at least one file");
});

// ── acceptance 4: both supported forms keep their contracts byte-for-byte ─────────────────────────

test("W1-T3073: the whole-file form and the bare-title form are unchanged", () => {
  const whole = parseWhitelistedProof(`unit test: ${REAL_PATH}`);
  assert.ok(whole, "a whole-file proof still parses");
  assert.equal(whole.kind, "test");
  assert.notEqual(whole.nameFiltered, true, "a whole-file proof is not name-filtered");
  assert.equal(whole.args.at(-1), REAL_PATH, "and runs that file");

  const title = parseWhitelistedProof(`unit test: ${REAL_TITLE}`);
  assert.ok(title, "a bare-title proof still parses");
  assert.equal(title.nameFiltered, true, "and is still name-filtered");
  assert.ok(title.args.includes("--test-name-pattern"), "through --test-name-pattern");
  assert.equal(title.label, REAL_TITLE);

  // A `::` that is NOT preceded by a test-file path is out of scope for this task and must still
  // take the bare-title arm — the refusal is the path-plus-title grammar, not the two characters.
  const notAPath = parseWhitelistedProof("unit test: someHelper::someMethod records its call");
  assert.ok(notAPath, "a non-path `::` body is untouched by this refusal");
  assert.equal(notAPath.nameFiltered, true);
});

// ── acceptance 2: the changed-task lint path BLOCKS it, with the parser's own sentence ────────────

test("W1-T3073: the changed-task lint path blocks the shape before a plan-only filing can merge", () => {
  const task = {
    id: "W1-T3071",
    verify: "auto" as const,
    acceptance: [{ claim: "every help arm carries the token", proof: BAD }],
  };
  const violations = proofDialectViolations(task as never);
  assert.equal(violations.length, 1, "exactly one violation");
  assert.equal(violations[0].check, "proof-dialect");
  assert.equal(violations[0].severity, "block", "BLOCKING — a warn would let the filing merge again");
  assert.match(violations[0].message, /not a supported/, "and it carries the parser's own reason, not a catch-all");

  // CONTROL: the supported whole-file form on the identical task shape raises nothing.
  const ok = proofDialectViolations({
    ...task,
    acceptance: [{ claim: "c", proof: `unit test: ${REAL_PATH}` }],
  } as never);
  assert.deepEqual(ok, [], "control: the supported form is not blocked");
});

// ── acceptance 3: `rmd check-proof` reports it and never launches the executor ────────────────────

test("W1-T3073: `rmd check-proof` refuses the shape, names the reason, and spawns no test run", () => {
  const run = (proof: string) =>
    execFileSync(process.execPath, ["--import", "tsx", "src/run-task.ts", "check-proof", proof], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: { ...process.env, RMD_SELF_SYNC_DONE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
  let out = "";
  let code = 0;
  try {
    out = run(BAD);
  } catch (e) {
    const err = e as { status?: number; stdout?: string };
    code = err.status ?? -1;
    out = err.stdout ?? "";
  }
  assert.notEqual(code, 0, "a refused proof exits non-zero");
  assert.match(out, /parse:\s+REFUSED/, "it says REFUSED");
  assert.match(out, /reason:.*not a supported/, "and names THIS cause, not the generic hint alone");
  assert.doesNotMatch(out, /^exit:/m, "no executor line — the test runner was never launched");
  assert.doesNotMatch(out, /TAP version/, "and no TAP output leaked from a run that should not exist");
});

// ── acceptance 5: the generated page names the form and both alternatives ─────────────────────────

test("W1-T3073: the generated proof-dialect page names the unsupported separator and both valid forms", () => {
  const page = readFileSync(new URL("../docs/proof-dialect.md", import.meta.url), "utf8");
  assert.match(page, /a test-file path and a title joined by/, "the page names the shape");
  assert.match(page, /not a supported/, "and quotes the refusal");

  // The row is DERIVED, not hand-typed: PROOF_DIALECT builds it by running the real explainer, so
  // the page and the parser cannot drift. Assert the page carries that same sentence verbatim.
  const row = PROOF_DIALECT.unitTest.refusals.find((r) => "proof" in r && r.proof.includes("::"));
  assert.ok(row, "PROOF_DIALECT carries the separator refusal");
  assert.ok(page.includes(row.message.slice(0, 60)), "and the page quotes the parser's own sentence");
});
