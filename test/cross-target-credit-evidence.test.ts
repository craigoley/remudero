// test/cross-target-credit-evidence.test.ts — W1-T3873.
//
// `buildCreditCandidates`/`buildEscalationReconcileCandidates` used to hand both git-evidence
// readers (`readMergedPathsByPr`, `readMergeSubjectsByPr`) the bare `repoRoot` module constant —
// the ENGINE checkout this process runs from — no matter which `owner`/`repo` the credit pass was
// actually for. Both readers key on a BARE pull request number, so a target repository's PR was
// answered by the engine repo's merge of the same number, or by nothing at all. That is exactly
// how remudero-site PR 107 (a plan-only filing for PORTAL-T19) kept its merge credit: the engine
// checkout's own history was consulted instead of remudero-site's.
//
// `creditEvidenceRootFor` (src/run-task.ts) is the fix: it resolves the engine `repoRoot` for a
// self target, and a NON-self target's own already-synced checkout otherwise — proving the
// checkout's `git remote.origin.url` actually names that target before trusting its history, the
// same way `buildCommitTrailerIndex` (lib/status.ts, W1-T3779) proves a foreign checkout. A
// missing, foreign or unreadable checkout answers `undefined`, which both readers turn into an
// EMPTY map — today's existing "no local opinion" answer, never a new refusal of its own.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { buildCreditCandidates, buildEscalationReconcileCandidates, creditEvidenceRootFor } from "../src/run-task.js";
import { repoRoot, resolveOwnerRepo } from "../src/lib/repo-location.js";
import type { GitHub } from "../src/lib/status.js";
import type { Plan, Task } from "../src/lib/plan.js";

// ── FIXTURE PLUMBING ────────────────────────────────────────────────────────────────────────────

/**
 * A REAL git checkout whose ONE commit puts `(#prNumber)` in its subject and changes exactly
 * `relPath` — the shape both `readMergedPathsByPr`/`readMergeSubjectsByPr` walk with
 * `git log origin/main`. `refs/remotes/origin/main` is set directly to HEAD (no real remote
 * fetch needed); an `origin` REMOTE is also added when `originSlug` is given, so
 * {@link creditEvidenceRootFor}'s own `git remote.origin.url` check has something real to read.
 */
function gitCheckoutWithMerge(dir: string, opts: { prNumber: number; relPath: string; subjectVerb: string; originSlug?: string }): string {
  mkdirSync(dir, { recursive: true });
  const git = (args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git(["init", "-q"]);
  git(["config", "user.email", "t@example.com"]);
  git(["config", "user.name", "Test"]);
  if (opts.originSlug) git(["remote", "add", "origin", `git@github.com:${opts.originSlug}.git`]);
  const full = join(dir, opts.relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, "x\n");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", `${opts.subjectVerb} (#${opts.prNumber})`]);
  git(["update-ref", "refs/remotes/origin/main", "HEAD"]);
  return dir;
}

/** A fresh, standalone checkout (used for the engine-shaped fixture, which lives nowhere under
 *  any `configRoot/repos/`). */
function freshCheckout(opts: { prNumber: number; relPath: string; subjectVerb: string; originSlug?: string }): string {
  return gitCheckoutWithMerge(mkdtempSync(join(tmpdir(), "rmd-cte-")), opts);
}

/** A target checkout planted exactly where `creditEvidenceRootFor` looks for it:
 *  `<configRoot>/repos/<repo>` — the SAME `join(configRoot, "repos", repo)` `daemonCommand`'s
 *  `targetCheckoutRoot` already resolves for cross-target commit-trailer credit (W1-T3779). */
function targetCheckoutUnder(configRoot: string, repo: string, opts: { prNumber: number; relPath: string; subjectVerb: string; originSlug: string }): string {
  return gitCheckoutWithMerge(join(configRoot, "repos", repo), opts);
}

function ledgerFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-cte-ledger-"));
  const p = join(dir, "ledger.ndjson");
  writeFileSync(p, "");
  return p;
}

function task(id: string): Task {
  return { id, title: id, repo: "target", depends_on: [], type: "implement", verify: "auto", risk: "medium", status: "queued", attempts: 0 };
}

function planOf(...ids: string[]): Plan {
  const tasks = ids.map(task);
  return { tasks, byId: new Map(tasks.map((t) => [t.id, t])) };
}

/**
 * A gateway that credits `taskId` by anchored trailer on a HAND-NAMED branch — never
 * `run-<taskId>-<digits>` — so `ownsOwnRunBranch` cannot decide and `deriveStatus`'s plan-only
 * DIFF refusal must consult LOCAL evidence (`deps.mergedPathsByPr`) to answer at all. Deliberately
 * carries NO `changedFiles`: if the refusal ever fired off a GitHub fallback instead of the local
 * map these fixtures plant, that would be a false pass, not a proof.
 */
function trailerGithub(taskId: string, prNumber: number, urlSlug: string): GitHub {
  const url = `https://github.com/${urlSlug}/pull/${prNumber}`;
  return {
    prByRef: () => null,
    findMergedByTrailer: (id: string) => (id === taskId ? { number: prNumber, url, state: "MERGED" } : null),
    headRefName: () => `claude/hand-named-${taskId}`,
    prBody: () => `Remudero-Task: ${taskId}\n`,
  } as unknown as GitHub;
}

function issueGatewayOf(rows: Array<{ number: number; url: string; title: string; body: string }>) {
  return { listOpen: () => rows.map((r) => ({ ...r, state: "open" })) } as never;
}

// ── CRITERION 1 — a target plan-only filing does not credit a task with no run ───────────────────

test("W1-T3873 criterion 1: a target-repo plan-only filing pull request does not earn credit once evidence is rooted in ITS OWN checkout", () => {
  const taskId = "PORTAL-T19";
  const prNumber = 107;
  const configRoot = mkdtempSync(join(tmpdir(), "rmd-cte-config-"));
  const targetRepo = targetCheckoutUnder(configRoot, "target", {
    prNumber,
    relPath: "plan/tasks.d/PORTAL-T19-x.yaml",
    subjectVerb: "chore(plan): file PORTAL-T19",
    originSlug: "o/target",
  });
  const plan = planOf(taskId);
  const gh = trailerGithub(taskId, prNumber, "o/target");
  const rows = [{ number: 1, url: "u1", title: "t", body: `**Task:** ${taskId}\n` }];

  const candidates = buildEscalationReconcileCandidates("o", "target", plan, ledgerFile(), undefined, {
    issues: issueGatewayOf(rows),
    github: gh,
    evidenceRootFor: () => targetRepo,
  });
  assert.equal(candidates.length, 1, "the fixture reaches the candidate loop");
  assert.equal(candidates[0].derived.merged, false, "remudero-site's own plan-only merge must not credit PORTAL-T19");

  // buildCreditCandidates is the OTHER destructive consumer (closes a PR rather than an issue) —
  // wired identically, so it must abstain on the same fixture.
  const credits = buildCreditCandidates("o", "target", plan, ledgerFile(), undefined, gh, () => targetRepo);
  assert.equal(credits.length, 0, "buildCreditCandidates never proposes a merged candidate for the plan-only filing");
});

// ── FALSIFIER — PROVE IT LOAD-BEARING: only the root differs, and the answer must flip ───────────

test("W1-T3873 falsifier: the SAME plan-only fixture reads CREDITED when the root is the engine checkout instead — proving the resolution decides, not merely exists", () => {
  const taskId = "PORTAL-T19";
  const prNumber = 107;
  const configRoot = mkdtempSync(join(tmpdir(), "rmd-cte-config-"));
  const targetRepo = targetCheckoutUnder(configRoot, "target", {
    prNumber,
    relPath: "plan/tasks.d/PORTAL-T19-x.yaml",
    subjectVerb: "chore(plan): file PORTAL-T19",
    originSlug: "o/target",
  });
  // THE ENGINE'S OWN #107, unrelated, touching `src/` — the pre-W1-T3873 shape: `readMergedPathsByPr`/
  // `readMergeSubjectsByPr` always scanned exactly this kind of checkout regardless of the target.
  const engineRepo = freshCheckout({ prNumber, relPath: "src/console/unrelated.ts", subjectVerb: "feat(console): land it", originSlug: "o/engine" });
  const plan = planOf(taskId);
  const gh = trailerGithub(taskId, prNumber, "o/target");
  const rows = [{ number: 1, url: "u1", title: "t", body: `**Task:** ${taskId}\n` }];

  const rooted = buildEscalationReconcileCandidates("o", "target", plan, ledgerFile(), undefined, {
    issues: issueGatewayOf(rows),
    github: gh,
    evidenceRootFor: () => targetRepo,
  });
  assert.equal(rooted[0].derived.merged, false, "control: correctly rooted, the filing stays uncredited");

  const misrooted = buildEscalationReconcileCandidates("o", "target", plan, ledgerFile(), undefined, {
    issues: issueGatewayOf(rows),
    github: gh,
    // THE ONLY DIFFERENCE from the line above: the resolved root. Nothing else in this fixture moves.
    evidenceRootFor: () => engineRepo,
  });
  assert.equal(misrooted[0].derived.merged, true, "an engine-rooted read reproduces the exact defect this task closes — the resolution is load-bearing");
  assert.notEqual(rooted[0].derived.merged, misrooted[0].derived.merged, "only the evidence root moved, and the verdict moved with it");
});

// ── CRITERION 2 — a target implementation merge still earns credit ───────────────────────────────

test("W1-T3873 criterion 2: a target-repo IMPLEMENTATION merge still earns credit once rooted in its own checkout", () => {
  const taskId = "PORTAL-T12";
  const prNumber = 108;
  const configRoot = mkdtempSync(join(tmpdir(), "rmd-cte-config-"));
  const targetRepo = targetCheckoutUnder(configRoot, "target", {
    prNumber,
    relPath: "src/console/real-change.ts",
    subjectVerb: "feat(console): implement PORTAL-T12",
    originSlug: "o/target",
  });
  const plan = planOf(taskId);
  const gh = trailerGithub(taskId, prNumber, "o/target");
  const rows = [{ number: 2, url: "u2", title: "t", body: `**Task:** ${taskId}\n` }];

  const candidates = buildEscalationReconcileCandidates("o", "target", plan, ledgerFile(), undefined, {
    issues: issueGatewayOf(rows),
    github: gh,
    evidenceRootFor: () => targetRepo,
  });
  assert.equal(candidates[0].derived.merged, true, "a genuine target implementation must still credit — the fix is subtract-only");

  const credits = buildCreditCandidates("o", "target", plan, ledgerFile(), undefined, gh, () => targetRepo);
  assert.equal(credits.length, 1, "buildCreditCandidates proposes exactly one merged candidate");
  assert.equal(credits[0].taskId, taskId);
  assert.equal(credits[0].creditIsImplementation, true, "the target's own subject reads as an implementation, not a filing");
});

// ── CRITERION 3 — a missing, foreign or unreadable checkout yields empty evidence, fail-closed ───

test("W1-T3873 criterion 3: creditEvidenceRootFor resolves a self target to repoRoot, never a config lookup", () => {
  const self = resolveOwnerRepo();
  assert.equal(creditEvidenceRootFor(self.owner, self.repo), repoRoot, "self resolves to the engine's own checkout by default");
  // Injected self identity, so this does not depend on THIS checkout's real origin remote.
  assert.equal(
    creditEvidenceRootFor("o", "engine", { selfOwnerRepo: { owner: "o", repo: "engine" }, configRoot: "/does/not/exist/anywhere" }),
    repoRoot,
    "a self match is decided before any config lookup is attempted",
  );
});

test("W1-T3873 criterion 3: a MISSING target checkout resolves to undefined, never the engine's own history", () => {
  const configRoot = mkdtempSync(join(tmpdir(), "rmd-cte-config-"));
  // `configRoot/repos/target` was never created.
  const root = creditEvidenceRootFor("o", "target", { selfOwnerRepo: { owner: "o", repo: "engine" }, configRoot });
  assert.equal(root, undefined, "a checkout that does not exist yields undefined, a genuine absence");
});

test("W1-T3873 criterion 3: a FOREIGN checkout (origin names a different repo) resolves to undefined", () => {
  const configRoot = mkdtempSync(join(tmpdir(), "rmd-cte-config-"));
  // Planted at `repos/target`, but its own origin names a DIFFERENT repository — the shape a stale
  // or misconfigured checkout on disk would take.
  targetCheckoutUnder(configRoot, "target", { prNumber: 1, relPath: "plan/x.yaml", subjectVerb: "chore", originSlug: "o/someone-elses-fork" });
  const root = creditEvidenceRootFor("o", "target", { selfOwnerRepo: { owner: "o", repo: "engine" }, configRoot });
  assert.equal(root, undefined, "an unproven checkout must never be trusted, however plausible its path");
});

test("W1-T3873 criterion 3: a checkout PROVEN to belong to the target resolves to its path", () => {
  const configRoot = mkdtempSync(join(tmpdir(), "rmd-cte-config-"));
  const targetRepo = targetCheckoutUnder(configRoot, "target", { prNumber: 1, relPath: "plan/x.yaml", subjectVerb: "chore", originSlug: "o/target" });
  const root = creditEvidenceRootFor("o", "target", { selfOwnerRepo: { owner: "o", repo: "engine" }, configRoot });
  assert.equal(root, targetRepo, "an origin-proven checkout is trusted, and only that one");
});

test("W1-T3873 criterion 3: a FOREIGN or missing target checkout leaves the existing fail-closed outcome unchanged — never a NEW refusal", () => {
  // THE SAME plan-only fixture as criterion 1, but this time the resolved root is undefined
  // (foreign/missing). Both readers then answer with an EMPTY map, which is exactly the pre-
  // W1-T3067 shortcut's own behaviour: nothing contradicts the trailer credit, so it stands. An
  // absent checkout must never manufacture a NEW refusal of its own — only a PROVEN one may.
  const taskId = "PORTAL-T19";
  const prNumber = 107;
  const plan = planOf(taskId);
  const gh = trailerGithub(taskId, prNumber, "o/target");
  const rows = [{ number: 1, url: "u1", title: "t", body: `**Task:** ${taskId}\n` }];

  const candidates = buildEscalationReconcileCandidates("o", "target", plan, ledgerFile(), undefined, {
    issues: issueGatewayOf(rows),
    github: gh,
    evidenceRootFor: () => undefined,
  });
  assert.equal(candidates[0].derived.merged, true, "no local opinion is available, so today's trailer-only answer stands — never a manufactured refusal");
});

test("W1-T3873 criterion 3: an unreadable engine origin also degrades to no evidence", () => {
  // Exercise the default self-identity read in a fresh process whose explicit repo root is not
  // a checkout. This is the real failure arm in creditEvidenceRootFor, not the injected foreign-
  // checkout path above: a broken engine origin must never turn a credit pass into a throw.
  const moduleUrl = pathToFileURL(join(repoRoot, "src", "run-task.ts")).href;
  const probe = `import { creditEvidenceRootFor } from ${JSON.stringify(moduleUrl)};\nprocess.stdout.write(String(creditEvidenceRootFor("o", "target")));`;
  const output = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", probe, "--", "--repo-root", "/definitely/not/a/checkout"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(output, "undefined", "an unreadable engine origin is a safe no-evidence answer");
});

// ── CRITERION 4 — the credit pass reads evidence ONCE per pass, never once per task ──────────────

test("W1-T3873 criterion 4: buildEscalationReconcileCandidates resolves the evidence root ONCE, not once per open issue", () => {
  const configRoot = mkdtempSync(join(tmpdir(), "rmd-cte-config-"));
  const targetRepo = targetCheckoutUnder(configRoot, "target", { prNumber: 1, relPath: "src/x.ts", subjectVerb: "feat", originSlug: "o/target" });
  const plan = planOf("PORTAL-A", "PORTAL-B", "PORTAL-C");
  const rows = ["PORTAL-A", "PORTAL-B", "PORTAL-C"].map((id, i) => ({ number: i, url: `u${i}`, title: "t", body: `**Task:** ${id}\n` }));
  const gh: GitHub = {
    prByRef: () => null,
    findMergedByTrailer: () => ({ number: 1, url: `https://github.com/o/target/pull/1`, state: "MERGED" }),
    headRefName: () => "claude/hand-named",
    prBody: () => "Remudero-Task: PORTAL-A\nRemudero-Task: PORTAL-B\nRemudero-Task: PORTAL-C\n",
  };

  let calls = 0;
  const candidates = buildEscalationReconcileCandidates("o", "target", plan, ledgerFile(), undefined, {
    issues: issueGatewayOf(rows),
    github: gh,
    evidenceRootFor: (owner, repo) => {
      calls++;
      return repo === "target" ? targetRepo : undefined;
    },
  });
  assert.equal(candidates.length, 3, "the fixture reaches all three candidates");
  assert.equal(calls, 1, "the evidence root is resolved once for the whole pass, never once per open issue");
});

test("W1-T3873 criterion 4: buildCreditCandidates resolves the evidence root ONCE, not once per plan task", () => {
  const configRoot = mkdtempSync(join(tmpdir(), "rmd-cte-config-"));
  const targetRepo = targetCheckoutUnder(configRoot, "target", { prNumber: 1, relPath: "src/x.ts", subjectVerb: "feat", originSlug: "o/target" });
  const plan = planOf("PORTAL-A", "PORTAL-B", "PORTAL-C", "PORTAL-D", "PORTAL-E");
  const gh: GitHub = {
    prByRef: () => null,
    findMergedByTrailer: () => null, // no candidate need actually credit for this count to matter
    headRefName: () => undefined,
    prBody: () => undefined,
  };

  let calls = 0;
  buildCreditCandidates("o", "target", plan, ledgerFile(), undefined, gh, (owner, repo) => {
    calls++;
    return repo === "target" ? targetRepo : undefined;
  });
  assert.equal(calls, 1, "one plan of five tasks resolves the evidence root exactly once, never five times");
});
