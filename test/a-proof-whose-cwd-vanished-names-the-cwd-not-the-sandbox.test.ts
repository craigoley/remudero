import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { test, afterEach } from "node:test";
import { join } from "node:path";
// A NAMESPACE import, deliberately: at the merge base `ProofCwdMissingError` does not exist, and a named import would
// fail the whole file at load — read as "never ran", not as a red. Through the namespace each test fails at its assertion.
import * as review from "../src/lib/review.js";
const {
  defaultAsyncProofSpawner,
  defaultProofSpawner,
  execWhitelistedProof,
  judgeCriterion,
  judgeReview,
  ProofCwdMissingError,
  ProofSandboxUnavailableError,
  setProofSandboxForTests,
} = review;
import { discriminateReviewReuse } from "../src/lib/sweep.js";
import { makeTempDir } from "../src/lib/tmp.js";

afterEach(() => setProofSandboxForTests());

function vanishedDir(label: string): string {
  const dir = makeTempDir(label);
  rmSync(dir, { recursive: true, force: true });
  return dir;
}

const namesCwd = (cwd: string) => (e: unknown) =>
  e instanceof ProofCwdMissingError && e.message === `proof cwd no longer exists: ${cwd}` && !/bwrap/.test(e.message);

test("W1-T7822: the sync proof spawner names a vanished cwd, not a missing sandbox", () => {
  const cwd = vanishedDir("t7822-sync");
  setProofSandboxForTests({ mode: "bwrap", binary: "bwrap" });
  assert.throws(() => defaultProofSpawner("grep", ["needle", "x.txt"], cwd, 30_000), namesCwd(cwd));
});

test("W1-T7822: the async proof spawner names a vanished cwd, not a missing sandbox", async () => {
  const cwd = vanishedDir("t7822-async");
  setProofSandboxForTests({ mode: "bwrap", binary: "bwrap" });
  await assert.rejects(defaultAsyncProofSpawner("grep", ["needle", "x.txt"], cwd, 30_000), namesCwd(cwd));
});

test("W1-T7822: judgeCriterion grades a vanished cwd as cwd-missing", () => {
  const cwd = vanishedDir("t7822-judge");
  setProofSandboxForTests({ mode: "bwrap", binary: "bwrap" });
  const verdict = judgeCriterion({ claim: "the needle is present", proof: "grep: needle in x.txt" },
    new Set(["needle", "present"]), undefined, { cwd, exec: execWhitelistedProof });
  assert.equal(verdict.proof_exec, "not_executable");
  assert.equal(verdict.proof_skip, "cwd-missing");
  assert.match(verdict.reason, /proof cwd no longer exists/);
  assert.match(verdict.reason, /not executed, keyword floor applied/);
});

test("W1-T7822: an absent sandbox binary with a live cwd still reads as not installed", () => {
  const dir = makeTempDir("t7822-live");
  writeFileSync(join(dir, "x.txt"), "needle\n");
  setProofSandboxForTests({ mode: "bwrap", binary: join(dir, "no-such-bwrap") });
  assert.throws(() => defaultProofSpawner("grep", ["needle", "x.txt"], dir, 30_000),
    (e: unknown) => e instanceof ProofSandboxUnavailableError && /not installed/.test(e.sandboxReason));
});

test("W1-T7822: review reuse refuses a verdict with a cwd-missing proof", () => {
  const criterion = { claim: "W1-T7822 a vanished cwd is named", proof: "grep: W1-T7822 in src/x.ts" };
  const diff = "diff --git a/src/x.ts b/src/x.ts\n+W1-T7822\n";
  const report = "W1-T7822 a vanished cwd is named.";
  const prior = judgeReview([criterion], { diff, report, headCheckoutDir: "/head", execProof: () => "pass" });
  const result = discriminateReviewReuse({
    prior,
    diff,
    report,
    headCheckoutDir: "/head",
    baseCheckoutDir: "/base",
    baseIsCheckout: true,
    execProof: () => {
      throw new ProofCwdMissingError("/head");
    },
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /proof evidence unreadable/);
  assert.match(result.reason, /cwd-missing/);
});
