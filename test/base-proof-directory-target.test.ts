/**
 * test/base-proof-directory-target.test.ts — recon 2026-09-05, finding R-12.
 *
 * THE DEFECT. `parseDialectGrep` (src/lib/review.ts) accepted a DIRECTORY as a `grep:` target —
 * its `-r` flag made one "work" at the head — and the base-side check then ran
 * `git show <merge-base>:src/lib`, which exits 0 with a TREE LISTING, and wrote that listing as a
 * FILE at `src/lib`. The base grep over the listing found nothing, so the proof graded
 * "discriminates" → `executed_pass` even when the pattern already existed at the base (the
 * control, the same pattern against `src/lib/plan.ts`, read `executed_stale`); a sibling proof
 * under that directory then hit `mkdirSync` ENOTDIR → `base_unreadable`. One such proof exists in
 * the plan today (W1-T289's `grep: reclaimStaleLock( in src/lib`).
 *
 * WHAT CLOSES IT, in three places sharing one sentence ({@link GREP_PROOF_FILE_TARGET_REQUIREMENT}):
 * the parser refuses the directory SHAPE (no extension on the final segment) so no such proof ever
 * compiles; `rmd check-proof` names that reason on its `parse: REFUSED` line; the filing-time linter
 * (`proofGrepSafetyViolations`) blocks it where the author is. A dotted directory (`plan/tasks.d`)
 * passes the shape rule and is refused by the executor against the real checkout instead.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { checkProofCommand, CHECK_PROOF_EXIT } from "../src/run-task.js";
import {
  execWhitelistedProof,
  explainGrepProofRefusal,
  GREP_PROOF_FILE_TARGET_REQUIREMENT,
  grepProofTargetNamesNoFile,
  judgeCriterion,
  parseWhitelistedProof,
  ProofTargetIsDirectoryError,
} from "../src/lib/review.js";
import { proofGrepSafetyViolations } from "../src/lib/task-linter.js";
import type { Task } from "../src/lib/plan.js";

const DIRECTORY_PROOF = "grep: reclaimStaleLock( in src/lib";
const FILE_PROOF = "grep: reclaimStaleLock( in src/lib/plan.ts";

function taskWithProof(proof: string): Task {
  return {
    id: "W1-TTEST",
    title: "t",
    status: "todo",
    depends_on: [],
    verify: "auto",
    acceptance: [{ claim: "the lock is reclaimed", proof }],
  } as unknown as Task;
}

// ── the parser ───────────────────────────────────────────────────────────────────────────────────

test("R-12: `grep: X in src/lib` is REFUSED at parse, and the same pattern against a file under it still compiles", () => {
  assert.equal(parseWhitelistedProof(DIRECTORY_PROOF), null, "a directory-shaped target never compiles to a runnable proof");
  const control = parseWhitelistedProof(FILE_PROOF);
  assert.ok(control && control.kind === "grep");
  assert.deepEqual(control!.args, ["-arn", "--", "reclaimStaleLock(", "src/lib/plan.ts"], "the file form's argv is byte-identical to before");
});

test("R-12: the refusal names the FILE-target requirement, in the same sentence every surface quotes", () => {
  const reason = explainGrepProofRefusal(DIRECTORY_PROOF);
  assert.ok(reason, "a refused grep: proof has a stated reason");
  assert.match(reason!, /names no file/);
  assert.match(reason!, /src\/lib/, "the offending target is quoted");
  assert.ok(reason!.includes(GREP_PROOF_FILE_TARGET_REQUIREMENT), "the shared requirement sentence is in it verbatim");
  assert.match(GREP_PROOF_FILE_TARGET_REQUIREMENT, /must name a FILE/);

  assert.equal(explainGrepProofRefusal(FILE_PROOF), undefined, "a proof that parses has nothing to explain");
  assert.equal(explainGrepProofRefusal("unit test: test/x.test.ts"), undefined, "not a grep: proof at all");
  // The other textual refusals are explained too — the parser returns null for all of them alike.
  assert.match(explainGrepProofRefusal("grep:")!, /empty `grep:` body/);
  assert.match(explainGrepProofRefusal("grep: foo")!, /no `in <path>` clause/);
  assert.match(explainGrepProofRefusal("grep: foo in ../etc/passwd.txt")!, /traverses out/);
  assert.match(explainGrepProofRefusal("grep: foo in /etc/passwd.txt")!, /absolute path/);
  assert.match(explainGrepProofRefusal("grep: foo in src/*.ts")!, /glob/);
});

test("R-12: the shape rule — the final segment must carry an extension; a dotted directory name passes it (and is caught at run time instead)", () => {
  assert.ok(grepProofTargetNamesNoFile("src/lib"));
  assert.ok(grepProofTargetNamesNoFile("src"));
  assert.ok(grepProofTargetNamesNoFile(".github/workflows"), "a dot in an EARLIER segment does not make the last one a file");
  assert.ok(grepProofTargetNamesNoFile("src/lib/"), "a trailing slash names a directory as plainly as it can");
  assert.equal(grepProofTargetNamesNoFile("src/lib/plan.ts"), undefined);
  assert.equal(grepProofTargetNamesNoFile(".nvmrc"), undefined);
  assert.equal(grepProofTargetNamesNoFile("plan/tasks.d"), undefined, "dotted directory: textually a file — the executor's stat decides");
});

// ── the linter ───────────────────────────────────────────────────────────────────────────────────

test("R-12: proofGrepSafetyViolations BLOCKS a directory-shaped target at filing time, with the same sentence", () => {
  const v = proofGrepSafetyViolations(taskWithProof(DIRECTORY_PROOF));
  const blocking = v.filter((x) => x.severity === "block");
  assert.equal(blocking.length, 1, JSON.stringify(v));
  assert.equal(blocking[0].check, "proof-grep-safety");
  assert.match(blocking[0].message, /criterion 1/);
  assert.match(blocking[0].message, /names no file/);
  assert.ok(blocking[0].message.includes(GREP_PROOF_FILE_TARGET_REQUIREMENT));
  assert.match(blocking[0].message, /never execute/, "the message says what the reviewer would do with it");

  assert.deepEqual(
    proofGrepSafetyViolations(taskWithProof(FILE_PROOF)).filter((x) => x.severity === "block"),
    [],
    "control: the file form is not blocked (`(` is not a BRE metacharacter)",
  );
});

// ── the executor, against the real filesystem ────────────────────────────────────────────────────

test("R-12: a DOTTED directory that survives the shape rule is refused by the executor against the checkout — a throw, never a verdict", () => {
  const checkout = mkdtempSync(join(tmpdir(), "rmd-r12-checkout-"));
  try {
    mkdirSync(join(checkout, "plan", "tasks.d"), { recursive: true });
    writeFileSync(join(checkout, "plan", "tasks.d", "a.yaml"), "needle-r12 lives here\n");

    const dirProof = parseWhitelistedProof("grep: needle-r12 in plan/tasks.d");
    assert.ok(dirProof, "textually a file, so it parses");
    assert.throws(
      () => execWhitelistedProof(dirProof!, checkout),
      (e: unknown) => e instanceof ProofTargetIsDirectoryError && /plan\/tasks\.d/.test((e as Error).message) && /FILE/.test((e as Error).message),
      "the executor refuses the directory by name, quoting the requirement",
    );
    // And through the judge: exec_error (the keyword floor), never executed_pass on `-r` finding a
    // line somewhere beneath the directory.
    const v = judgeCriterion({ claim: "the needle is present", proof: "grep: needle-r12 in plan/tasks.d" }, new Set(), undefined, {
      cwd: checkout,
      exec: execWhitelistedProof,
    });
    assert.equal(v.proof_exec, "exec_error");
    assert.notEqual(v.met, true, "nothing was certified");

    // CONTROL: the file beneath it is an ordinary, passing proof.
    const fileProof = parseWhitelistedProof("grep: needle-r12 in plan/tasks.d/a.yaml")!;
    assert.equal(execWhitelistedProof(fileProof, checkout), "pass");
    // And an ABSENT target is still grep's own exit 2 (exec_error), untouched by the stat.
    assert.throws(() => execWhitelistedProof(parseWhitelistedProof("grep: needle-r12 in plan/missing.yaml")!, checkout), (e: unknown) => !(e instanceof ProofTargetIsDirectoryError));
  } finally {
    rmSync(checkout, { recursive: true, force: true });
  }
});

// ── rmd check-proof ──────────────────────────────────────────────────────────────────────────────

test("R-12: `rmd check-proof` refuses the directory proof and prints the reason beside its REFUSED line", () => {
  const lines: string[] = [];
  const realLog = console.log;
  console.log = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  let code: number;
  try {
    code = checkProofCommand(DIRECTORY_PROOF.split(" "));
  } finally {
    console.log = realLog;
  }
  const out = lines.join("\n");
  assert.equal(code, CHECK_PROOF_EXIT.refused);
  assert.match(out, /^parse:\s+REFUSED/m);
  assert.match(out, /reason: .*names no file/m, out);
  assert.match(out, /must name a FILE/);
});
