// W1-T3680 — EVERY DEPENDABOT PR WAS STRUCTURALLY UNMERGEABLE.
//
// `evaluateHeadIdentityGate` admitted exactly three heads: a filing-shaped subject (W1-T1004), an
// anchored `Remudero-Task` trailer, or a run-shaped head ref. A dependency bump can carry NONE of
// them — its head is `dependabot/...`, its subject is `chore(deps): bump ...`, and it builds no
// task, so a trailer would be a false credit and a run-shaped branch a lie about its origin.
// Measured 2026-09-16 on #5757/#5758/#5759: 47 checks each, one failure each, the same one.
//
// This suite pins the FOURTH admitted form and, just as hard, the two ways it must not become a
// hole: a `dependabot/`-named head carrying a src/ change is still refused, and an UNREADABLE diff
// refuses rather than admitting on the strength of a forgeable branch name.
import assert from "node:assert/strict";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, "..", "scripts", "head-identity-gate.mjs");

// `scripts/**` sits OUTSIDE tsconfig's `include`, so a static import is a TS7016 — reached by
// dynamic import, exactly as test/the-branch-name-contract-has-no-form-for-unfiled-work.test.ts does.
const mod = (await import(pathToFileURL(SCRIPT).href)) as {
  evaluateHeadIdentityGate: (input: {
    headCommitMessage: string;
    headRef: string | undefined;
    changedPaths?: readonly string[];
  }) => { ok: boolean; defect?: string; message: string };
  isDependencyBumpHead: (input: {
    headRef: string | undefined;
    subject: string;
    changedPaths: readonly string[] | undefined;
  }) => boolean;
  isDependencyManifestPath: (path: string) => boolean;
  changedPathsAtHead: (
    worktreePath: string,
    baseRef: string | undefined,
    run?: (args: string[], opts: { cwd: string }) => { error?: unknown; status: number; stdout: string },
  ) => string[] | undefined;
};
const { evaluateHeadIdentityGate, isDependencyBumpHead, isDependencyManifestPath, changedPathsAtHead } = mod;

/** A git runner that replays canned results in order, recording the argv it was asked for. */
function fakeGit(results: { error?: unknown; status: number; stdout: string }[]) {
  const calls: string[][] = [];
  const run = (args: string[]) => {
    calls.push(args);
    return results[calls.length - 1] ?? { status: 1, stdout: "" };
  };
  return { run, calls };
}
const OK = (stdout: string) => ({ status: 0, stdout });

const BUMP_SUBJECT = "chore(deps): bump the npm-minor-and-patch group with 6 updates";
const BUMP_REF = "dependabot/npm_and_yarn/npm-minor-and-patch-4616289c19";
const MANIFESTS = ["package.json", "package-lock.json"];

// ── Criterion 1: a manifest-only dependabot head is admitted ────────────────────────────────────

test("a manifest-only dependabot head is admitted", () => {
  const result = evaluateHeadIdentityGate({
    headCommitMessage: `${BUMP_SUBJECT}\n`,
    headRef: BUMP_REF,
    changedPaths: MANIFESTS,
  });
  assert.equal(result.ok, true, "a bump that touches only manifests must reach the merge queue");
  assert.equal(result.defect, undefined);
  // The message must say WHY it was admitted, so the exemption is auditable in a log — a bare OK
  // would be indistinguishable from the run-shaped-ref arm.
  assert.match(result.message, /dependency-bump head/);
  assert.match(result.message, /without a task credit/);
});

test("a workflow-manifest dependabot head is admitted — the github_actions ecosystem", () => {
  const result = evaluateHeadIdentityGate({
    headCommitMessage: "chore(deps): bump the actions-minor-and-patch group with 4 updates\n",
    headRef: "dependabot/github_actions/actions-minor-and-patch-df37b28052",
    changedPaths: [".github/workflows/ci.yml", ".github/workflows/head-identity-gate.yml"],
  });
  assert.equal(result.ok, true);
});

test("chore(deps-dev) is admitted alongside chore(deps)", () => {
  assert.equal(
    isDependencyBumpHead({
      headRef: "dependabot/npm_and_yarn/typescript-5.9.0",
      subject: "chore(deps-dev): bump typescript from 5.8.0 to 5.9.0",
      changedPaths: MANIFESTS,
    }),
    true,
  );
});

// ── Criterion 2: the exemption cannot become a credit hole ──────────────────────────────────────

test("a dependabot-named head touching src is still refused", () => {
  // THE GATE ARM ALONE CANNOT FAIL BEFORE THE FIX — every dependabot head was refused then, so an
  // assertion that this one is refused passes on both trees and discriminates nothing. The
  // load-bearing assertion is on the new predicate itself: it must SEE this input and say no.
  assert.equal(
    isDependencyBumpHead({
      headRef: BUMP_REF,
      subject: BUMP_SUBJECT,
      changedPaths: ["package.json", "src/run-task.ts"],
    }),
    false,
    "one source path must sink the whole exemption",
  );
  const result = evaluateHeadIdentityGate({
    headCommitMessage: `${BUMP_SUBJECT}\n`,
    headRef: BUMP_REF,
    changedPaths: ["package.json", "src/run-task.ts"],
  });
  assert.equal(result.ok, false);
  assert.equal(result.defect, "unidentified-head");
});

test("an UNREADABLE diff refuses rather than admitting on the branch name alone", () => {
  // `changedPathsAtHead` returns undefined on any git failure. That must refuse: a forgeable
  // branch name plus a forgeable subject is not evidence of anything.
  for (const changedPaths of [undefined, []]) {
    // Same reasoning as the src/ case above: assert on the predicate, which only exists once the
    // fix does, so this reddens when the fix is removed instead of passing on both trees.
    assert.equal(
      isDependencyBumpHead({ headRef: BUMP_REF, subject: BUMP_SUBJECT, changedPaths }),
      false,
      `changedPaths=${JSON.stringify(changedPaths)} must fail closed`,
    );
    const result = evaluateHeadIdentityGate({
      headCommitMessage: `${BUMP_SUBJECT}\n`,
      headRef: BUMP_REF,
      changedPaths,
    });
    assert.equal(result.ok, false);
  }
});

test("a dependabot-shaped SUBJECT on a non-dependabot branch is refused", () => {
  assert.equal(
    isDependencyBumpHead({ headRef: "feature/sneaky", subject: BUMP_SUBJECT, changedPaths: MANIFESTS }),
    false,
  );
});

test("a dependabot branch with a non-bump subject is refused", () => {
  assert.equal(
    isDependencyBumpHead({
      headRef: BUMP_REF,
      subject: "feat(cli): add a verb while nobody is looking",
      changedPaths: MANIFESTS,
    }),
    false,
  );
});

test("the manifest predicate admits workspace manifests and rejects everything else", () => {
  for (const ok of ["package.json", "package-lock.json", "apps/web/package.json", ".github/workflows/ci.yml"]) {
    assert.equal(isDependencyManifestPath(ok), true, `${ok} is a manifest`);
  }
  for (const no of ["src/run-task.ts", "package.json.bak", ".github/dependabot.yml", "deploy/Dockerfile", ""]) {
    assert.equal(isDependencyManifestPath(no), false, `${no} is NOT a manifest`);
  }
});

// ── Criterion 3: nothing that was refused before is admitted now ────────────────────────────────

test("an ordinary unidentified head is refused with its text unchanged", () => {
  const result = evaluateHeadIdentityGate({
    headCommitMessage: "refactor(cli): unrelated tidy-up with no trailer\n",
    headRef: "refactor/tidy-up",
    changedPaths: MANIFESTS,
  });
  assert.equal(result.ok, false);
  assert.equal(result.defect, "unidentified-head");
  assert.match(result.message, /matches neither conforming form/);
});

test("the three pre-existing admitted forms are untouched", () => {
  const runShaped = evaluateHeadIdentityGate({
    headCommitMessage: "fix(drain): stop a stuck run branch\n",
    headRef: "run-W1-T2519-1787425298842",
    changedPaths: undefined,
  });
  assert.equal(runShaped.ok, true);
  assert.match(runShaped.message, /run-shaped head ref/);

  const filing = evaluateHeadIdentityGate({
    headCommitMessage: "chore(plan): file something\n",
    headRef: "plan/whatever",
    changedPaths: undefined,
  });
  assert.equal(filing.ok, true);
  assert.match(filing.message, /filing-shaped subject/);
});

// ── changedPathsAtHead: the impure reader, whose every failure arm must return undefined ───────
//
// undefined is the SAFE answer — isDependencyBumpHead treats it as "not a manifest-only diff" and
// refuses — so each arm below is the exemption failing closed, not a cosmetic early return.

test("changedPathsAtHead reads the merge-base diff and de-duplicates it", () => {
  const { run, calls } = fakeGit([OK("abc123\n"), OK("package.json\0package-lock.json\0package.json\0")]);
  const paths = changedPathsAtHead("/w", "main", run);
  assert.deepEqual(paths, ["package.json", "package-lock.json"], "duplicates collapse");
  assert.deepEqual(calls[0], ["merge-base", "origin/main", "HEAD"]);
  assert.deepEqual(calls[1], ["diff", "--name-only", "-z", "--no-renames", "abc123...HEAD"]);
});

test("changedPathsAtHead returns undefined with no base ref, without running git", () => {
  for (const baseRef of [undefined, ""]) {
    const { run, calls } = fakeGit([]);
    assert.equal(changedPathsAtHead("/w", baseRef, run), undefined);
    assert.equal(calls.length, 0, "a missing base ref must not spawn git at all");
  }
});

test("changedPathsAtHead returns undefined when merge-base fails", () => {
  const nonZero = fakeGit([{ status: 128, stdout: "" }]);
  assert.equal(changedPathsAtHead("/w", "main", nonZero.run), undefined);

  const threw = fakeGit([{ error: new Error("spawn ENOENT"), status: 0, stdout: "" }]);
  assert.equal(changedPathsAtHead("/w", "main", threw.run), undefined);
});

test("changedPathsAtHead returns undefined when the merge-base is empty", () => {
  const { run, calls } = fakeGit([OK("   \n")]);
  assert.equal(changedPathsAtHead("/w", "main", run), undefined);
  assert.equal(calls.length, 1, "an empty base must not reach the diff");
});

test("changedPathsAtHead returns undefined when the diff fails", () => {
  const nonZero = fakeGit([OK("abc123"), { status: 1, stdout: "" }]);
  assert.equal(changedPathsAtHead("/w", "main", nonZero.run), undefined);

  const threw = fakeGit([OK("abc123"), { error: new Error("boom"), status: 0, stdout: "" }]);
  assert.equal(changedPathsAtHead("/w", "main", threw.run), undefined);
});

test("an unreadable diff and a manifest diff reach OPPOSITE gate verdicts", () => {
  // The two halves joined: what the reader returns is what the exemption consumes.
  const unreadable = fakeGit([{ status: 128, stdout: "" }]);
  const refused = evaluateHeadIdentityGate({
    headCommitMessage: `${BUMP_SUBJECT}\n`,
    headRef: BUMP_REF,
    changedPaths: changedPathsAtHead("/w", "main", unreadable.run),
  });
  assert.equal(refused.ok, false, "an unreadable diff must refuse");

  const readable = fakeGit([OK("abc123"), OK("package.json\0package-lock.json\0")]);
  const admitted = evaluateHeadIdentityGate({
    headCommitMessage: `${BUMP_SUBJECT}\n`,
    headRef: BUMP_REF,
    changedPaths: changedPathsAtHead("/w", "main", readable.run),
  });
  assert.equal(admitted.ok, true, "a manifest-only diff must be admitted");
});
