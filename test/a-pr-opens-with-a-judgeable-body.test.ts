import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { acceptanceGateBodyRepair, ghPrCreateFillCommand } from "../src/run-task.js";
import { bodyNeedsAcceptanceRepair, renderAcceptanceBlock } from "../src/lib/plan-pr-emitter.js";
import { loadPlan } from "../src/lib/plan.js";
import { parseAcceptanceBlock } from "../src/lib/review.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { defaultProofRunner, openPullRequestChecked } from "../src/lib/pr-open.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GATE_URL = pathToFileURL(join(REPO_ROOT, "scripts", "acceptance-author-gate.mjs")).href;
const { evaluateGate } = (await import(GATE_URL)) as {
  evaluateGate: (input: { body: string; authorLogin?: string }) => { ok: boolean; defect?: string; message: string };
};

/**
 * test/a-pr-opens-with-a-judgeable-body.test.ts — W1-T3066.
 *
 * `fillDerivedBody` derives a PR body from the commit, and a commit carries no Acceptance block, so
 * every PR opened through this seam reached `acceptance-author-gate` with nothing to judge and
 * failed closed. MEASURED 2026-09-07: six PRs (#4447, #4449, #4461, #4465, #4471, #4472) each paid a
 * full CI cycle for it before being repaired. The repair already existed — it just ran after the red.
 */

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t.invalid",
};

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: GIT_ENV });
}

/** A real repo with `origin/main` seeded — never a mock of git's own output. */
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}pr-open-body-`));
  git(dir, "init", "--quiet", "-b", "main");
  git(dir, "config", "user.email", "t@t.invalid");
  git(dir, "config", "user.name", "t");
  writeFileSync(join(dir, "README.md"), "seed\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "chore: seed");
  git(dir, "update-ref", "refs/remotes/origin/main", git(dir, "rev-parse", "HEAD").trim());
  return dir;
}

function commit(dir: string, subject: string, body?: string): void {
  writeFileSync(join(dir, `f${Date.now()}.txt`), "x\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", body ? `${subject}\n\n${body}` : subject);
}

/** The `body=` value the REST create call would actually send. */
function bodyOf(dir: string): string {
  // The builder refuses a live write under the test runner by design; this is the same opt-in
  // every other test of this seam uses, and it wraps ONLY the argv construction — nothing spawns.
  const built = withLiveWritesAllowed(() => ghPrCreateFillCommand(dir, "o", "r", "run-T1-1", "feat(x): a subject"));
  const at = built.args.findIndex((a) => a.startsWith("body="));
  assert.notEqual(at, -1, "the create argv must carry a body");
  return built.args[at].slice("body=".length);
}

test("a commit-derived body opens the PR with a block the gate can judge, not with nothing", () => {
  const dir = fixture();
  commit(dir, "feat(x): a subject", "A perfectly ordinary commit message. It carries no Acceptance block,\nbecause commit messages do not.");
  const body = bodyOf(dir);
  assert.equal(
    bodyNeedsAcceptanceRepair(body),
    false,
    `the opened PR must already parse judgeably; got:\n${body}`,
  );
  // The renderer emits the BARE `Acceptance:` header, which is one of the two shapes
  // ACCEPTANCE_HEADER_RE accepts — asserting the `##` spelling would pin a format the parser
  // never required and redden on a cosmetic change.
  assert.match(body, /^\s*#{0,6}\s*Acceptance\b/mi, "a judgeable body carries a header the parser resolves");
});

test("W1-T3508 open-time fallback: the rendered body passes the production author-time proof-shape gate", () => {
  const dir = fixture();
  commit(dir, "feat(x): a subject", "no Acceptance block in this commit message");
  const result = evaluateGate({ body: bodyOf(dir), authorLogin: "a-human" });
  assert.equal(result.ok, true, result.message);
});

test("W1-T3508 fallback proof target: both fallbacks retain the single-line grep proof for acceptanceAuthorTimeCheck", () => {
  const dir = fixture();
  commit(dir, "feat(x): a subject", "no Acceptance block in this commit message");
  const repaired = acceptanceGateBodyRepair("no Acceptance block in this live PR body");
  assert.ok(repaired, "the no-header fixture must take the fallback path");
  for (const body of [bodyOf(dir), repaired.repairedBody]) {
    assert.match(
      body,
      /grep: \^export function acceptanceAuthorTimeCheck in src\/lib\/review\.ts/,
      "both renderers must carry the same executable, single-line proof",
    );
  }
});

test("the auto-authored block says WHEN it was authored, and does not borrow the fix rung's story", () => {
  const dir = fixture();
  commit(dir, "feat(x): a subject", "no block here");
  const body = bodyOf(dir);
  assert.match(body, /auto-authored when the PR was opened/, "it must say what actually happened");
  assert.doesNotMatch(
    body,
    /after acceptance-author-gate refused it/,
    "the gate has refused nothing at open time — a body that misreports its own provenance is the defect, not the fix",
  );
});

test("the block never claims the diff is correct — it claims only that the body parses", () => {
  const dir = fixture();
  commit(dir, "feat(x): a subject", "no block here");
  assert.match(
    bodyOf(dir),
    /not a claim that the underlying diff is correct/,
    "an auto-authored criterion that implied review had happened would be worse than no block at all",
  );
});

test("a body that ALREADY parses judgeably is passed through untouched", () => {
  const dir = fixture();
  const authored = [
    "## Acceptance",
    "- the sweep reads the legacy prefix | grep: LEGACY in src/lib/tmp.ts",
  ].join("\n");
  commit(dir, "feat(x): a subject", authored);
  const body = bodyOf(dir);
  assert.match(body, /grep: LEGACY in src\/lib\/tmp\.ts/, "the author's own criterion must survive");
  assert.doesNotMatch(body, /auto-authored when the PR was opened/, "a healthy block must not be supplemented");
  assert.equal((body.match(/^\s*#{0,6}\s*Acceptance\b/gim) ?? []).length, 1, "exactly one Acceptance block");
});

test("an author's RECOVERABLE criteria beat the generic fallback rather than being discarded", () => {
  const dir = fixture();
  // A block defective in the way this repo keeps producing: an em dash where a pipe belongs, so the
  // bullet parses with NO proof. The claim is still real and must not be thrown away for boilerplate.
  commit(dir, "feat(x): a subject", ["## Acceptance", "- the reaper withholds an active branch — grep: withhold in src/lib/branch-reaper.ts"].join("\n"));
  const body = bodyOf(dir);
  assert.equal(bodyNeedsAcceptanceRepair(body), false, "the repaired body must parse");
  assert.match(body, /the reaper withholds an active branch/, "the author's own claim must be carried into the repair");
});

test("run branches receive the Remudero-Task body trailer before REST pull creation in test/a-pr-opens-with-a-judgeable-body.test.ts", () => {
  const task = loadPlan(join(REPO_ROOT, "plan", "tasks.yaml")).tasks.find((candidate) => candidate.id === "W1-T4420");
  const criteria = task?.acceptance ?? [];
  assert.ok(criteria.length, "W1-T4420 must carry its filed acceptance criteria");
  const checkedProofs: string[] = [];
  const branch = `run-W1-T4420-${Date.now()}`;
  const built = withLiveWritesAllowed(() =>
    ghPrCreateFillCommand(
      REPO_ROOT,
      "o",
      "r",
      branch,
      "feat(pr): open checked pull requests",
      undefined,
      (proof) => {
        checkedProofs.push(proof);
        return { status: 0 };
      },
    ),
  );
  const bodyArg = built.args.find((arg) => arg.startsWith("body="));
  assert.ok(bodyArg, "the REST create must carry the checked body");
  const body = bodyArg.slice("body=".length);
  assert.match(body, /^Remudero-Task: W1-T4420$/m, "the branch's task trailer must be in the body before POST");
  assert.deepEqual(parseAcceptanceBlock(body), criteria.map(({ claim, proof }) => ({ claim, proof })));
  assert.deepEqual(checkedProofs, criteria.map((criterion) => criterion.proof));
  assert.deepEqual(built.args.slice(0, 4), ["api", "--method", "POST", "repos/o/r/pulls"]);
});

test("the shared PR opener refuses a stale or plan-divergent acceptance block before POST in test/a-pr-opens-with-a-judgeable-body.test.ts", () => {
  const task = loadPlan(join(REPO_ROOT, "plan", "tasks.yaml")).tasks.find((candidate) => candidate.id === "W1-T4420");
  const criteria = task?.acceptance ?? [];
  assert.ok(criteria.length, "W1-T4420 must carry its filed acceptance criteria");
  const branch = `run-W1-T4420-${Date.now()}`;
  let proofCalls = 0;
  assert.throws(
    () =>
      withLiveWritesAllowed(() =>
        ghPrCreateFillCommand(
          REPO_ROOT,
          "o",
          "r",
          branch,
          "feat(pr): open checked pull requests",
          "Acceptance:\n- unrelated claim | grep: unrelated in src/lib/review.ts",
          () => {
            proofCalls += 1;
            return { status: 0 };
          },
        ),
      ),
    /Acceptance block does not match W1-T4420's filed criteria/,
  );
  assert.equal(proofCalls, 0, "a divergent block is refused before proof execution and before a REST argv exists");

  assert.throws(
    () =>
      withLiveWritesAllowed(() =>
        ghPrCreateFillCommand(
          REPO_ROOT,
          "o",
          "r",
          branch,
          "feat(pr): open checked pull requests",
          renderAcceptanceBlock(criteria),
          () => {
            proofCalls += 1;
            return { status: 5, stdout: "the proof passes at the merge base" };
          },
        ),
      ),
    /proof did not pass against merge base/,
  );
  assert.equal(proofCalls, 1, "the first stale proof stops the opener before REST creation");
});

function filedTaskFixture(proof = "grep: marker in README.md"): string {
  const dir = fixture();
  mkdirSync(join(dir, "plan"));
  writeFileSync(join(dir, "plan", "tasks.yaml"), [
    "- id: W1-T4420",
    "  title: checked PR fixture",
    "  repo: remudero",
    "  type: implement",
    "  acceptance:",
    "    - claim: the marker is present",
    `      proof: ${JSON.stringify(proof)}`,
  ].join("\n"));
  return dir;
}

test("a feature-branch PR proof runner reaches check-proof without self-sync refusing the branch", () => {
  const result = defaultProofRunner(
    "grep: W1_T4420_ABSENT_PROOF_MARKER in src/lib/pr-open.ts",
    "origin/main",
    REPO_ROOT,
  );
  assert.equal(result.error, undefined, result.error);
  assert.equal(result.signal, null);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout ?? "", /verdict:\s+fail/);
});

test("the shared PR opener refuses an unavailable merge base before running a proof", () => {
  const dir = filedTaskFixture();
  let ran = false;
  assert.throws(
    () => openPullRequestChecked("", "run-W1-T4420-1", dir, "missing/base", () => {
      ran = true;
      return { status: 0 };
    }),
    /cannot resolve merge base missing\/base/,
  );
  assert.equal(ran, false);
});

test("the shared PR opener rejects a conflicting task trailer and malformed block before proof execution", () => {
  const dir = filedTaskFixture();
  let ran = false;
  const runProof = () => {
    ran = true;
    return { status: 0 };
  };
  assert.throws(
    () => openPullRequestChecked("Remudero-Task: W1-T9999", "run-W1-T4420-1", dir, "origin/main", runProof),
    /body trailer names W1-T9999/,
  );
  assert.throws(
    () => openPullRequestChecked("Acceptance:\n- claim without proof", "run-W1-T4420-1", dir, "origin/main", runProof),
    /Acceptance block is malformed/,
  );
  assert.equal(ran, false);
});

test("the shared PR opener refuses a filed proof that check-proof cannot execute", () => {
  const dir = filedTaskFixture("a prose-only proof");
  let ran = false;
  assert.throws(
    () => openPullRequestChecked("", "run-W1-T4420-1", dir, "origin/main", () => {
      ran = true;
      return { status: 0 };
    }),
    /proof the local check-proof command cannot execute/,
  );
  assert.equal(ran, false);
});
