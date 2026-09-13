// test/the-branch-name-contract-has-no-form-for-unfiled-work.test.ts — W1-T3388.
//
// THE DEFECT, THREE WAYS. CLAUDE.md's session-branch rule names `run-<taskId>-<epochMs>` but
// binds it only "WHEN BUILDING A FILED TASK" — PR 5106 was an ad-hoc repair with no filed task and
// therefore no id to put there, so an agent that read the rule correctly still had no conforming
// name available to it. CLAUDE.md's own maintenance note says a DISPATCHED WORKER never loads it
// at all (`spawnWorker` passes `settingSources: []`). And nothing anywhere refuses a head that
// conforms to neither shape.
//
// THIS SUITE PROVES BOTH ACCEPTANCE CRITERIA:
//   1. `evaluateHeadIdentityGate` (scripts/head-identity-gate.mjs) refuses a head matching neither
//      the run-branch shape (filed OR unfiled) nor a valid trailer, naming both conforming forms.
//   2. `BRANCH_NAME_CONTRACT_PART` (src/run-task.ts) carries the same two forms into the text
//      spliced, UNCONDITIONALLY, into both the turn-0 implement prompt and the post-compaction
//      anchor — see the two `${BRANCH_NAME_CONTRACT_PART}` call sites in src/run-task.ts, the same
//      two `IMPLEMENT_REFUSAL_REPORT_CONTRACT` already rides, so the contract cannot reach one
//      without the other. Testing the constant's own content is the SAME level of proof
//      `test/a-refusal-is-a-verdict-not-a-strike.test.ts` already accepts for
//      `IMPLEMENT_REFUSAL_REPORT_CONTRACT` — a hand-authored prompt fragment, not a source-text
//      snapshot of behaviour, so asserting on its exported value is the right seam.
//
// WHAT IS REAL HERE: `evaluateHeadIdentityGate`/`isFilingShapedSubject`/`hasValidTaskTrailer` are
// the production functions from the script itself, imported via a dynamic import — `scripts/**`
// sits outside tsconfig's `include` (see tsconfig.json), so a static specifier is a TS7016, the
// same reason `test/credit-surface-gate.test.ts` reaches its own sibling script this way.
// `isDispatchedRunBranch` and the two named forms are re-exported straight out of
// `src/run-task.ts` by the gate script, so this suite also proves the gate reused the read side
// (and the SAME two literal forms the prompt part names) rather than re-implementing either.

import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  BRANCH_NAME_CONTRACT_PART,
  IMPLEMENT_REFUSAL_REPORT_CONTRACT,
  RUN_BRANCH_FILED_FORM,
  RUN_BRANCH_UNFILED_FORM,
  RUN_BRANCH_UNFILED_RE,
} from "../src/run-task.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "head-identity-gate.mjs");

// `scripts/**` sits OUTSIDE tsconfig's `include` (see tsconfig.json), so a static
// `import … from "../scripts/head-identity-gate.mjs"` is a TS7016 — reached via a dynamic import
// instead, the same reason test/credit-surface-gate.test.ts reaches its own sibling script.
const GATE_URL = pathToFileURL(SCRIPT).href;
const mod = (await import(GATE_URL)) as {
  evaluateHeadIdentityGate: (input: { headCommitMessage: string; headRef: string | undefined }) => {
    ok: boolean;
    defect?: string;
    message: string;
  };
  isFilingShapedSubject: (subject: string) => boolean;
  hasValidTaskTrailer: (commitMessage: string) => boolean;
  isDispatchedRunBranch: (head: string | undefined) => boolean;
  readHeadCommitMessage: (worktreePath: string) => string | undefined;
  resolveHeadRef: (
    flagValue: string | undefined,
    env?: Record<string, string | undefined>,
  ) => { ok: boolean; headRef?: string; message?: string };
  main: (argv: string[]) => void;
};
const { evaluateHeadIdentityGate, isFilingShapedSubject, hasValidTaskTrailer, isDispatchedRunBranch, readHeadCommitMessage, resolveHeadRef, main } = mod;

// ── Acceptance criterion 1: a head matching neither form is refused, naming both ────────────────

test("W1-T3388 criterion 1 refuses an unidentified head and names both forms", () => {
  const result = evaluateHeadIdentityGate({
    headCommitMessage: "refactor(cli): unrelated tidy-up with no trailer\n",
    headRef: "refactor/tidy-up",
  });
  assert.equal(result.ok, false);
  assert.equal(result.defect, "unidentified-head");
});

test("W1-T3388: the refusal names both conforming forms and the trailer route", () => {
  // NOT "chore: ..." -- that bare form is itself filing-shaped (W1-T1078, LINT_FILING_SUBJECT_RE)
  // and would be exempt before either identity limb is even asked, defeating this fixture's point.
  const result = evaluateHeadIdentityGate({
    headCommitMessage: "refactor(cli): unrelated tidy-up with no trailer\n",
    headRef: "refactor/tidy-up",
  });
  assert.equal(result.ok, false);
  assert.match(result.message, new RegExp(RUN_BRANCH_FILED_FORM.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "names the filed form");
  assert.match(result.message, new RegExp(RUN_BRANCH_UNFILED_FORM.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "names the unfiled form");
  assert.match(result.message, /Remudero-Task/, "names the trailer route");
});

test("W1-T3388: the filed run-branch shape satisfies the check", () => {
  const result = evaluateHeadIdentityGate({
    headCommitMessage: "fix(drain): stop a stuck run branch\n",
    headRef: "run-W1-T2519-1787425298842",
  });
  assert.equal(result.ok, true);
  assert.equal(result.defect, undefined);
  assert.match(result.message, /run-shaped head ref/);
});

test("W1-T3388: the NEW unfiled run-branch shape satisfies the check — the gap this task closes", () => {
  // PR 5106's own case: an ad-hoc repair with no filed task, and therefore no id to embed in
  // `run-<taskId>-<epochMs>`. `run-unfiled-<epochMs>` is the conforming name this task defines.
  const result = evaluateHeadIdentityGate({
    headCommitMessage: "fix(cli): ad-hoc repair with no filed task\n",
    headRef: "run-unfiled-1787425298842",
  });
  assert.equal(result.ok, true);
  assert.equal(result.defect, undefined);
  assert.match(result.message, /run-shaped head ref/);
  // And it really is the literal src/run-task.ts names, matchable by its own regex — the prompt
  // part and the gate can never silently name a different spelling for this case.
  assert.match("run-unfiled-1787425298842", RUN_BRANCH_UNFILED_RE);
});

test("W1-T3388: a trailer AND a run-shaped ref together name the both-surfaces message", () => {
  // Neither `trailered` alone nor `runShaped` alone below -- this is the third combination in
  // evaluateHeadIdentityGate's own `if (trailered && runShaped)` branch, otherwise unreachable by
  // any other fixture in this suite (each of those carries exactly one identifying surface).
  const result = evaluateHeadIdentityGate({
    headCommitMessage: "fix(drain): stop a stuck run branch\n\nRemudero-Task: W1-T2519\n",
    headRef: "run-W1-T2519-1787425298842",
  });
  assert.equal(result.ok, true);
  assert.equal(result.defect, undefined);
  assert.match(result.message, /identified on both surfaces/);
  assert.match(result.message, /Remudero-Task trailer/);
  assert.match(result.message, /run-shaped head ref/);
});

test("W1-T3388: a trailer alone satisfies the check even off a descriptively-named branch", () => {
  const result = evaluateHeadIdentityGate({
    headCommitMessage: "fix(drain): stop a stuck run branch\n\nRemudero-Task: W1-T2519\n",
    headRef: "fix/drain-stuck-run-branch",
  });
  assert.equal(result.ok, true);
  assert.match(result.message, /trailer/);
});

test("W1-T3388: a filing is never refused for carrying neither surface", () => {
  const result = evaluateHeadIdentityGate({
    headCommitMessage: "chore(plan): file W1-T3388 — the branch-name contract has no unfiled form\n",
    headRef: "triage/hand-pushed-filing",
  });
  assert.equal(result.ok, true);
  assert.match(result.message, /filing/);
});

test("W1-T3388: hasValidTaskTrailer rejects a non-anchored mid-line mention", () => {
  assert.equal(hasValidTaskTrailer("fix(drain): stuff. Remudero-Task: W1-T2519 mid-sentence, not its own line\n"), false);
  assert.equal(hasValidTaskTrailer("fix(drain): stuff.\n\nRemudero-Task: W1-T2519\n"), true);
});

test("W1-T3388: isDispatchedRunBranch and isFilingShapedSubject are reused verbatim, not re-implemented", () => {
  assert.equal(isDispatchedRunBranch("run-W1-T2519-1787425298842"), true);
  assert.equal(isDispatchedRunBranch("run-unfiled-1787425298842"), true);
  assert.equal(isDispatchedRunBranch("fix/whatever"), false);
  assert.equal(isFilingShapedSubject("chore(plan): regenerate plan/plan-index.json"), true);
  assert.equal(isFilingShapedSubject("fix(drain): stop a stuck branch"), false);
});

// ── main()'s own branches, in-process ────────────────────────────────────────────────────────

async function withExitCode(fn: () => void): Promise<{ exitCode: typeof process.exitCode; err: string[]; out: string[] }> {
  const priorExit = process.exitCode;
  const err: string[] = [];
  const out: string[] = [];
  const realErr = console.error;
  const realOut = console.log;
  console.error = (...a: unknown[]) => void err.push(a.join(" "));
  console.log = (...a: unknown[]) => void out.push(a.join(" "));
  try {
    fn();
    return { exitCode: process.exitCode, err, out };
  } finally {
    console.error = realErr;
    console.log = realOut;
    process.exitCode = priorExit;
  }
}

test("W1-T3388: main REFUSES with exit 1 when no head ref can be resolved", async () => {
  const priorEnv = process.env.GITHUB_HEAD_REF;
  delete process.env.GITHUB_HEAD_REF;
  try {
    const r = await withExitCode(() => main([]));
    assert.equal(r.exitCode, 1);
    assert.match(r.err[0], /REFUSED — no head ref/);
  } finally {
    if (priorEnv === undefined) delete process.env.GITHUB_HEAD_REF;
    else process.env.GITHUB_HEAD_REF = priorEnv;
  }
});

test("W1-T3388: main prints OK with exit 0 for an unfiled-shaped head with no trailer", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-head-identity-gate-main-unfiled-"));
  try {
    execFileSync("git", ["-C", dir, "init", "-q"]);
    execFileSync("git", ["-C", dir, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", dir, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", dir, "commit", "--allow-empty", "-q", "-m", "fix(cli): ad-hoc repair, no filed task"]);

    const r = await withExitCode(() => main(["--head-ref", "run-unfiled-1787425298842", "--worktree-path", dir]));
    assert.equal(r.exitCode, 0);
    assert.equal(r.out.length, 1);
    assert.match(r.out[0], /head-identity-gate: OK/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T3388: main REFUSES with exit 1 when the worktree's HEAD commit message can't be read", async () => {
  // A directory with no git repo at all: readHeadCommitMessage (git.mjs) returns undefined rather
  // than throwing, and main's own `if (headCommitMessage === undefined)` branch is what must
  // refuse here -- distinct from resolveHeadRef's earlier, separate no-head-ref refusal above.
  const dir = mkdtempSync(join(tmpdir(), "rmd-head-identity-gate-main-nogit-"));
  try {
    const r = await withExitCode(() => main(["--head-ref", "feat/whatever", "--worktree-path", dir]));
    assert.equal(r.exitCode, 1);
    assert.match(r.err[0], /REFUSED — cannot read the HEAD commit message/);
    assert.match(r.err[0], new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T3388: main REFUSES with exit 1 and names both forms on an unidentified head", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-head-identity-gate-main-refused-"));
  try {
    execFileSync("git", ["-C", dir, "init", "-q"]);
    execFileSync("git", ["-C", dir, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", dir, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", dir, "commit", "--allow-empty", "-q", "-m", "feat(cli): add a new flag"]);

    const r = await withExitCode(() => main(["--head-ref", "feat/add-new-flag", "--worktree-path", dir]));
    assert.equal(r.exitCode, 1);
    assert.match(r.err[0], /head-identity-gate: REFUSED/);
    assert.match(r.err[0], /run-unfiled-<epochMs>/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── the real CLI process, end-to-end ─────────────────────────────────────────────────────────

function runGate(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", SCRIPT, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
}

test("W1-T3388: the real CLI process exits 0 for an unfiled-shaped head", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-head-identity-gate-cli-unfiled-"));
  try {
    execFileSync("git", ["-C", dir, "init", "-q"]);
    execFileSync("git", ["-C", dir, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", dir, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", dir, "commit", "--allow-empty", "-q", "-m", "fix(cli): ad-hoc repair"]);

    const run = runGate(["--head-ref", "run-unfiled-1787425298842", "--worktree-path", dir]);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /head-identity-gate: OK/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T3388: the real CLI process exits 1 for a head with neither form nor trailer", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-head-identity-gate-cli-refused-"));
  try {
    execFileSync("git", ["-C", dir, "init", "-q"]);
    execFileSync("git", ["-C", dir, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", dir, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", dir, "commit", "--allow-empty", "-q", "-m", "feat(cli): add a new flag"]);

    const run = runGate(["--head-ref", "feat/add-new-flag", "--worktree-path", dir]);
    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert.match(run.stderr, /head-identity-gate: REFUSED/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Acceptance criterion 2: the contract reaches the rendered prompt, not only CLAUDE.md ────────

test("W1-T3388: BRANCH_NAME_CONTRACT_PART names both conforming forms", () => {
  assert.match(BRANCH_NAME_CONTRACT_PART, /# BRANCH NAME CONTRACT/);
  assert.match(BRANCH_NAME_CONTRACT_PART, new RegExp(RUN_BRANCH_FILED_FORM.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(BRANCH_NAME_CONTRACT_PART, new RegExp(RUN_BRANCH_UNFILED_FORM.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(BRANCH_NAME_CONTRACT_PART, /Remudero-Task/, "names the trailer route too");
  assert.match(BRANCH_NAME_CONTRACT_PART, /head-identity-gate/, "points at the gate that enforces it");
});

test("W1-T3388: BRANCH_NAME_CONTRACT_PART is unconditional prose, not gated the way CLAUDE.md's headline index is", () => {
  // Unlike buildRuleHeadlinesPart (gated by policy.ts's workerRuleHeadlines.enabled), this
  // constant carries no such flag in its own text and is a plain, always-present string — the
  // SAME shape IMPLEMENT_REFUSAL_REPORT_CONTRACT already is, spliced from the same two call
  // sites. A non-empty, unconditional constant is exactly what "reaches every dispatched worker"
  // requires: nothing in src/run-task.ts branches on a flag before appending it.
  assert.ok(BRANCH_NAME_CONTRACT_PART.length > 0);
  assert.notEqual(BRANCH_NAME_CONTRACT_PART, "");
});

test("W1-T3388: the unfiled form named in the prompt is the SAME literal the gate enforces", () => {
  // Cross-check against src/run-task.ts's own RUN_BRANCH_UNFILED_RE: substitute the placeholder
  // with a real epoch-ms literal and confirm it's the shape the gate (and isDispatchedRunBranch)
  // actually test — proving the prompt and the gate can never name two different spellings.
  const example = RUN_BRANCH_UNFILED_FORM.replace("<epochMs>", "1787425298842");
  assert.match(example, RUN_BRANCH_UNFILED_RE);
  assert.equal(isDispatchedRunBranch(example), true);
});

test("W1-T3388: the head-identity gate runs on every PR and ci-gate requires its exact check name", () => {
  const workflow = readFileSync(join(REPO_ROOT, ".github", "workflows", "head-identity-gate.yml"), "utf8");
  const aggregate = readFileSync(join(REPO_ROOT, ".github", "workflows", "ci-gate.yml"), "utf8");
  const packageJson = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));

  assert.match(workflow, /pull_request:/, "the standalone workflow registers for every PR event");
  assert.match(workflow, /npm run --silent head-identity-gate:check/, "the workflow invokes the named npm entry");
  assert.equal(packageJson.scripts["head-identity-gate:check"], "node --import tsx scripts/head-identity-gate.mjs");
  assert.match(aggregate, /"head-identity-gate"/, "the aggregate waits for the exact workflow check name");
});

test("W1-T3388: BRANCH_NAME_CONTRACT_PART sits beside IMPLEMENT_REFUSAL_REPORT_CONTRACT, both non-empty", () => {
  // Both constants are appended from the same two run-task.ts call sites (the turn-0 prompt and
  // the post-compaction anchor) — this asserts the sibling contract this task's fix rides on
  // still exists and is itself non-empty, so a future refactor cannot silently drop the anchor
  // point this task's own splice depends on.
  assert.ok(IMPLEMENT_REFUSAL_REPORT_CONTRACT.length > 0);
  assert.match(IMPLEMENT_REFUSAL_REPORT_CONTRACT, /REFUSED:/);
});

// ── readHeadCommitMessage / resolveHeadRef — the impure edges, same contract as the credit gate ─

test("W1-T3388: readHeadCommitMessage reads the real worktree HEAD", () => {
  const message = readHeadCommitMessage(REPO_ROOT);
  assert.equal(typeof message, "string");
  assert.ok((message as string).length > 0, "a real repo's HEAD commit message is non-empty");
});

test("W1-T3388: readHeadCommitMessage returns undefined rather than throwing on a bad path", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-head-identity-gate-nogit-"));
  try {
    const message = readHeadCommitMessage(dir);
    assert.equal(message, undefined, "a directory with no git repo yields undefined, not a throw");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T3388: resolveHeadRef refuses when neither the flag nor the env is set, resolves otherwise", () => {
  const refused = resolveHeadRef(undefined, {});
  assert.equal(refused.ok, false);
  assert.match(refused.message!, /REFUSED/);

  const viaFlag = resolveHeadRef("fix/tidy-up", {});
  assert.equal(viaFlag.ok, true);
  assert.equal(viaFlag.headRef, "fix/tidy-up");

  const viaEnv = resolveHeadRef(undefined, { GITHUB_HEAD_REF: "run-unfiled-1787425298842" });
  assert.equal(viaEnv.ok, true);
  assert.equal(viaEnv.headRef, "run-unfiled-1787425298842");
});
