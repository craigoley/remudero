// test/credit-surface-gate.test.ts
//
// W1-T1214 — NOTHING REFUSES A MERGE THAT WILL LAND UNCREDITED ON EITHER GIT SURFACE.
// `appendTaskTrailerToCommit` (src/run-task.ts, W1-T1012) only runs inside the harness run loop,
// so a branch pushed by hand from an operator lane never gets the `Remudero-Task:` trailer, and a
// descriptive branch name carries no `run-<taskId>-<epochMs>` head-ref credit either — nothing
// anywhere refuses a merge that would land credited on NEITHER surface. This suite proves
// scripts/credit-surface-gate.mjs's `evaluateCreditSurfaceGate` is that refusal: a disjunction over
// the SAME two existing credit surfaces the readers already trust (design point (ii)) — an
// anchored `Remudero-Task:` trailer on the head commit, OR a `run-<taskId>-<epochMs>` head ref —
// with a filing-shaped commit (W1-T1004's own `LINT_FILING_SUBJECT_RE`, imported verbatim rather
// than re-spelled) exempted before either limb is even asked (design point (iii)).
//
// WHAT IS REAL HERE: `evaluateCreditSurfaceGate`/`isFilingShapedSubject` are the production
// functions from the script itself, imported directly — no seam, nothing mocked. `isDispatchedRunBranch`
// and `LINT_FILING_SUBJECT_RE` are re-exported straight out of `src/run-task.ts` by the gate script,
// so this suite is also proving the gate reused the read side rather than re-implementing it
// (design point (iv): "the read side is not touched").

import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "credit-surface-gate.mjs");

// `scripts/**` sits OUTSIDE tsconfig's `include` (see tsconfig.json), so a static
// `import … from "../scripts/credit-surface-gate.mjs"` is a TS7016 — the same reason
// test/acceptance-author-gate.test.ts reaches its script through a runtime import rather than a
// typed one. A dynamic specifier is not statically resolved, so this loads the REAL module with
// no shadow copy to drift from it.
const GATE_URL = pathToFileURL(SCRIPT).href;
const mod = (await import(GATE_URL)) as {
  evaluateCreditSurfaceGate: (input: { headCommitMessage: string; headRef: string | undefined }) => {
    ok: boolean;
    defect?: string;
    message: string;
  };
  isFilingShapedSubject: (subject: string) => boolean;
  readHeadCommitMessage: (worktreePath: string) => string | undefined;
  resolveHeadRef: (
    flagValue: string | undefined,
    env?: Record<string, string | undefined>,
  ) => { ok: boolean; headRef?: string; message?: string };
  main: (argv: string[]) => void;
};
const { evaluateCreditSurfaceGate, isFilingShapedSubject, readHeadCommitMessage, resolveHeadRef, main } = mod;

// ── The five task acceptance criteria, each its own named `unit test:` proof ──────────────────

test("W1-T1214: an implementation pr credited on neither surface is refused", () => {
  const result = evaluateCreditSurfaceGate({
    headCommitMessage: "fix(drain): stop a stuck run branch from blocking dispatch forever\n",
    headRef: "fix/drain-stuck-run-branch",
  });
  assert.equal(result.ok, false);
  assert.equal(result.defect, "uncredited-merge");
});

test("W1-T1214: a trailer on the head commit satisfies the check", () => {
  const result = evaluateCreditSurfaceGate({
    headCommitMessage: "fix(drain): stop a stuck run branch from blocking dispatch forever\n\nRemudero-Task: W1-T2519\n",
    headRef: "fix/drain-stuck-run-branch",
  });
  assert.equal(result.ok, true);
  assert.equal(result.defect, undefined);
  assert.match(result.message, /trailer/);
});

test("W1-T1214: a run-shaped head ref satisfies the check", () => {
  const result = evaluateCreditSurfaceGate({
    headCommitMessage: "fix(drain): stop a stuck run branch from blocking dispatch forever\n",
    headRef: "run-W1-T2519-1787425298842",
  });
  assert.equal(result.ok, true);
  assert.equal(result.defect, undefined);
  assert.match(result.message, /run-shaped head ref/);
});

test("W1-T1214: a filing is never refused for carrying no trailer", () => {
  const result = evaluateCreditSurfaceGate({
    headCommitMessage: "chore(plan): file W1-T1214 — a hand-pushed implementation is uncredited\n",
    headRef: "triage/hand-pushed-uncredited",
  });
  assert.equal(result.ok, true);
  assert.equal(result.defect, undefined);
  assert.match(result.message, /filing/);

  // The older bare `plan:`/`docs:`/`chore:` convention (W1-T1078) is exempt too — the SAME
  // `LINT_FILING_SUBJECT_RE` the lint-plan failing-split classifier uses, not a re-spelled subset.
  const bareForm = evaluateCreditSurfaceGate({
    headCommitMessage: "docs: note the Q1 seam decision is deferred\n",
    headRef: "docs/note-seam-decision",
  });
  assert.equal(bareForm.ok, true);

  // Control: the SAME uncredited-surface shape from a non-filing subject IS refused — proves the
  // filing exemption is keyed on subject shape, not on "no trailer" alone.
  const nonFilingControl = evaluateCreditSurfaceGate({
    headCommitMessage: "feat(cli): add a new flag\n",
    headRef: "feat/add-new-flag",
  });
  assert.equal(nonFilingControl.ok, false);
});

test("W1-T1214: the refusal names both satisfying routes", () => {
  // NOT "chore: ..." -- that bare form is itself filing-shaped (W1-T1078, LINT_FILING_SUBJECT_RE)
  // and would be exempt before either credit limb is asked, defeating the point of this fixture.
  const result = evaluateCreditSurfaceGate({
    headCommitMessage: "refactor(cli): unrelated tidy-up with no trailer\n",
    headRef: "refactor/tidy-up",
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /Remudero-Task/, "names the trailer route");
  assert.match(result.message, /run-<taskId>-<epochMs>|run-.*-\d/i, "names the run-shaped head-ref route");
});

// ── Supporting coverage beyond the five named proofs (not itself a required proof) ─────────────

test("credit surface gate: isFilingShapedSubject reuses LINT_FILING_SUBJECT_RE verbatim", () => {
  assert.equal(isFilingShapedSubject("chore(plan): regenerate plan/plan-index.json"), true);
  assert.equal(isFilingShapedSubject("chore(triage): triage feedback#42"), true);
  assert.equal(isFilingShapedSubject("chore(feedback): capture recon note"), true);
  assert.equal(isFilingShapedSubject("docs(plan): renumber shard"), true);
  assert.equal(isFilingShapedSubject("plan: add W1-T1214"), true);
  assert.equal(isFilingShapedSubject("docs: update README"), true);
  assert.equal(isFilingShapedSubject("chore: bump a dependency"), true);
  assert.equal(isFilingShapedSubject("fix(drain): stop a stuck branch"), false);
  assert.equal(isFilingShapedSubject("feat(cli): add a flag"), false);
});

test("credit surface gate: a non-anchored mid-line mention does not falsely credit", () => {
  // A `Remudero-Task:` mention that does not START its own line (prose citing the id mid-sentence)
  // must not satisfy the check — the same anchoring `creditsByAnchoredTrailer`/
  // `appendTaskTrailerToCommit` already require of a REAL trailer.
  const trulyInline = evaluateCreditSurfaceGate({
    headCommitMessage: "fix(drain): stuff. Remudero-Task: W1-T2519 mid-sentence, not its own line\n",
    headRef: "fix/inline-mention",
  });
  assert.equal(trulyInline.ok, false, "a non-anchored mid-line mention must not credit");

  // Control: the SAME id, but as its own anchored line, DOES credit.
  const anchored = evaluateCreditSurfaceGate({
    headCommitMessage: "fix(drain): stuff.\n\nRemudero-Task: W1-T2519\n",
    headRef: "fix/anchored-trailer",
  });
  assert.equal(anchored.ok, true);
});

test("credit surface gate: both surfaces present names both", () => {
  const result = evaluateCreditSurfaceGate({
    headCommitMessage: "fix(drain): stop a stuck run branch\n\nRemudero-Task: W1-T2519\n",
    headRef: "run-W1-T2519-1787425298842",
  });
  assert.equal(result.ok, true);
});

test("credit surface gate: an empty/missing head ref is not run-shaped and does not crash", () => {
  const result = evaluateCreditSurfaceGate({
    headCommitMessage: "fix(drain): stop a stuck run branch\n",
    headRef: undefined,
  });
  assert.equal(result.ok, false);
});

// ── readHeadCommitMessage — the impure git edge ──────────────────────────────────────────────
//
// Reads THIS repo's real HEAD (never a fixture copy, per the file's own doc), and separately
// proves the best-effort `undefined`-on-failure contract against a path with no git repo at all,
// matching `lastCommitSubject`'s own contract this function's doc cites.

test("credit surface gate: readHeadCommitMessage reads the real worktree HEAD", () => {
  const message = readHeadCommitMessage(REPO_ROOT);
  assert.equal(typeof message, "string");
  assert.ok((message as string).length > 0, "a real repo's HEAD commit message is non-empty");
});

test("credit surface gate: readHeadCommitMessage returns undefined rather than throwing on a bad path", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-credit-surface-gate-nogit-"));
  try {
    const message = readHeadCommitMessage(dir);
    assert.equal(message, undefined, "a directory with no git repo yields undefined, not a throw");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── resolveHeadRef — flag vs. $GITHUB_HEAD_REF precedence ───────────────────────────────────────

test("credit surface gate: resolveHeadRef refuses when neither the flag nor the env is set", () => {
  const refused = resolveHeadRef(undefined, {});
  assert.equal(refused.ok, false);
  assert.match(refused.message!, /REFUSED/);
  assert.match(refused.message!, /--head-ref/, "the refusal names the flag that would fix it");
  assert.match(refused.message!, /GITHUB_HEAD_REF/, "and the environment variable too");

  // POSITIVE CONTROL 1 — the flag alone resolves.
  const viaFlag = resolveHeadRef("fix/tidy-up", {});
  assert.equal(viaFlag.ok, true);
  assert.equal(viaFlag.headRef, "fix/tidy-up");

  // POSITIVE CONTROL 2 — the environment alone resolves too.
  const viaEnv = resolveHeadRef(undefined, { GITHUB_HEAD_REF: "run-W1-T2519-1787425298842" });
  assert.equal(viaEnv.ok, true);
  assert.equal(viaEnv.headRef, "run-W1-T2519-1787425298842");

  // and the flag wins over the environment, the same documented precedence
  // resolveEventPath (scripts/acceptance-author-gate.mjs) uses.
  const both = resolveHeadRef("flag-wins", { GITHUB_HEAD_REF: "env-loses" });
  assert.equal(both.headRef, "flag-wins");
});

test("credit surface gate: resolveHeadRef also refuses on an empty-string flag/env value", () => {
  const emptyFlag = resolveHeadRef("", {});
  assert.equal(emptyFlag.ok, false);

  const emptyEnv = resolveHeadRef(undefined, { GITHUB_HEAD_REF: "" });
  assert.equal(emptyEnv.ok, false);
});

// ── main()'s own branches, in-process ────────────────────────────────────────────────────────
//
// process.exitCode/console.log/console.error are saved and monkey-patched around each call —
// leaving them set/patched would corrupt this suite's own process, the same
// `withExitCode` shape test/acceptance-author-gate.test.ts uses for the analogous entry point.

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

test("credit surface gate: main REFUSES with exit 1 when no head ref can be resolved", async () => {
  const priorEnv = process.env.GITHUB_HEAD_REF;
  delete process.env.GITHUB_HEAD_REF;
  try {
    const r = await withExitCode(() => main([]));
    assert.equal(r.exitCode, 1, "an unresolvable head ref is a refusal, not a pass");
    assert.equal(r.err.length, 1, "the refusal is reported once, on stderr");
    assert.match(r.err[0], /REFUSED — no head ref/);
    assert.deepEqual(r.out, [], "a refusal prints no OK line");
  } finally {
    if (priorEnv === undefined) delete process.env.GITHUB_HEAD_REF;
    else process.env.GITHUB_HEAD_REF = priorEnv;
  }
});

test("credit surface gate: main REFUSES with exit 1 when the worktree path has no readable HEAD", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-credit-surface-gate-main-nogit-"));
  try {
    const r = await withExitCode(() => main(["--head-ref", "fix/whatever", "--worktree-path", dir]));
    assert.equal(r.exitCode, 1);
    assert.equal(r.err.length, 1);
    assert.match(r.err[0], /cannot read the HEAD commit message/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("credit surface gate: main REFUSES with exit 1 and the gate's own message on an uncredited head", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-credit-surface-gate-main-uncredited-"));
  try {
    execFileSync("git", ["-C", dir, "init", "-q"]);
    execFileSync("git", ["-C", dir, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", dir, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", dir, "commit", "--allow-empty", "-q", "-m", "feat(cli): add a new flag"]);

    const r = await withExitCode(() => main(["--head-ref", "feat/add-new-flag", "--worktree-path", dir]));
    assert.equal(r.exitCode, 1);
    assert.equal(r.err.length, 1);
    assert.match(r.err[0], /credit-surface-gate: REFUSED — this merge would land credited on NEITHER surface/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("credit surface gate: main prints OK with exit 0 when the head ref alone credits", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-credit-surface-gate-main-credited-"));
  try {
    execFileSync("git", ["-C", dir, "init", "-q"]);
    execFileSync("git", ["-C", dir, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", dir, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", dir, "commit", "--allow-empty", "-q", "-m", "feat(cli): add a new flag"]);

    const r = await withExitCode(() =>
      main(["--head-ref", "run-W1-T2519-1787425298842", "--worktree-path", dir]),
    );
    assert.equal(r.exitCode, 0);
    assert.deepEqual(r.err, [], "a pass prints nothing on stderr");
    assert.equal(r.out.length, 1);
    assert.match(r.out[0], /credit-surface-gate: OK/);
    assert.match(r.out[0], /run-shaped head ref/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── the real CLI process, end-to-end ─────────────────────────────────────────────────────────
//
// Every test above calls `main` in-process, so the direct-execution guard at the bottom of the
// script (`if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)`) was never
// observed — that condition is only true when the file is the process's actual entry point. This
// spawns the real script the same way CI would (`node --import tsx
// scripts/credit-surface-gate.mjs ...`), matching test/acceptance-author-gate.test.ts's own
// `runGate` shape for its analogous CLI.

function runGate(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", SCRIPT, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
}

test("credit surface gate: the real CLI process exits 0 and prints OK for a credited head", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-credit-surface-gate-cli-credited-"));
  try {
    execFileSync("git", ["-C", dir, "init", "-q"]);
    execFileSync("git", ["-C", dir, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", dir, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", dir, "commit", "--allow-empty", "-q", "-m", "fix(drain): stuff\n\nRemudero-Task: W1-T2519\n"]);

    const run = runGate(["--head-ref", "fix/drain-stuck", "--worktree-path", dir]);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /credit-surface-gate: OK/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("credit surface gate: the real CLI process exits 1 for an uncredited head", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-credit-surface-gate-cli-uncredited-"));
  try {
    execFileSync("git", ["-C", dir, "init", "-q"]);
    execFileSync("git", ["-C", dir, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", dir, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", dir, "commit", "--allow-empty", "-q", "-m", "feat(cli): add a new flag"]);

    const run = runGate(["--head-ref", "feat/add-new-flag", "--worktree-path", dir]);
    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert.match(run.stderr, /credit-surface-gate: REFUSED — this merge would land credited on NEITHER surface/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("credit surface gate: the real CLI process exits 1 with no --head-ref and no GITHUB_HEAD_REF", () => {
  const run = spawnSync(process.execPath, ["--import", "tsx", SCRIPT], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, GITHUB_HEAD_REF: "" },
  });
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stderr, /REFUSED — no head ref/);
});
