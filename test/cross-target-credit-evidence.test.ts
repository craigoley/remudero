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
import { mkdirSync, mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { buildCreditCandidates, buildEscalationReconcileCandidates, creditEvidenceRootFor } from "../src/run-task.js";
import { repoRoot, resolveOwnerRepo } from "../src/lib/repo-location.js";
import type { Plan, Task } from "../src/lib/plan.js";
import { gitRepo } from "./helpers/git-repo.js";

interface EvidenceOptions {
  prNumber: number;
  relPath: string;
  subjectVerb: string;
  originSlug?: string;
}

/** Build a real checkout fixture from the shared Git helper; this file's own census stays flat. */
function buildEvidence(dir: string | undefined, opts: EvidenceOptions): string {
  const repo = gitRepo({ kind: "credit-evidence" });
  if (opts.originSlug) repo.addRemote("origin", `git@github.com:${opts.originSlug}.git`);
  const full = join(repo.dir, opts.relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, "x\n");
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", `${opts.subjectVerb} (#${opts.prNumber})`);
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  if (dir === undefined) return repo.dir;
  mkdirSync(dirname(dir), { recursive: true });
  renameSync(repo.dir, dir);
  return dir;
}

function freshEvidence(opts: EvidenceOptions): string {
  return buildEvidence(undefined, opts);
}

function targetEvidence(configRoot: string, repoName: string, opts: EvidenceOptions): string {
  return buildEvidence(join(configRoot, "repos", repoName), opts);
}

function makeGateway(taskId: string, prNumber: number, urlSlug: string) {
  const url = `https://github.com/${urlSlug}/pull/${prNumber}`;
  return {
    prByRef: () => null,
    findMergedByTrailer: (id: string) => (id === taskId ? { number: prNumber, url, state: "MERGED" } : null),
    headRefName: () => `claude/hand-named-${taskId}`,
    prBody: () => `Remudero-Task: ${taskId}\n`,
  };
}

function listIssues(rows: Array<{ number: number; url: string; title: string; body: string }>) {
  return { listOpen: () => rows.map((row) => ({ ...row, state: "open" })) } as never;
}

// ── FIXTURE PLUMBING ────────────────────────────────────────────────────────────────────────────

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

// ── CRITERION 1 — a target plan-only filing does not credit a task with no run ───────────────────

test("W1-T3873 criterion 1: a target plan-only filing stays uncredited when no run exists — target-repo evidence is rooted in ITS OWN checkout", () => {
  const taskId = "PORTAL-T19";
  const prNumber = 107;
  const configRoot = mkdtempSync(join(tmpdir(), "rmd-cte-config-"));
  const targetRepo = targetEvidence(configRoot, "target", {
    prNumber,
    relPath: "plan/tasks.d/PORTAL-T19-x.yaml",
    subjectVerb: "chore(plan): file PORTAL-T19",
    originSlug: "o/target",
  });
  const plan = planOf(taskId);
  const gh = makeGateway(taskId, prNumber, "o/target");
  const rows = [{ number: 1, url: "u1", title: "t", body: `**Task:** ${taskId}\n` }];

  const candidates = buildEscalationReconcileCandidates("o", "target", plan, ledgerFile(), undefined, {
    issues: listIssues(rows),
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
  const targetRepo = targetEvidence(configRoot, "target", {
    prNumber,
    relPath: "plan/tasks.d/PORTAL-T19-x.yaml",
    subjectVerb: "chore(plan): file PORTAL-T19",
    originSlug: "o/target",
  });
  // THE ENGINE'S OWN #107, unrelated, touching `src/` — the pre-W1-T3873 shape: `readMergedPathsByPr`/
  // `readMergeSubjectsByPr` always scanned exactly this kind of checkout regardless of the target.
  const engineRepo = freshEvidence({ prNumber, relPath: "src/console/unrelated.ts", subjectVerb: "feat(console): land it", originSlug: "o/engine" });
  const plan = planOf(taskId);
  const gh = makeGateway(taskId, prNumber, "o/target");
  const rows = [{ number: 1, url: "u1", title: "t", body: `**Task:** ${taskId}\n` }];

  const rooted = buildEscalationReconcileCandidates("o", "target", plan, ledgerFile(), undefined, {
    issues: listIssues(rows),
    github: gh,
    evidenceRootFor: () => targetRepo,
  });
  assert.equal(rooted[0].derived.merged, false, "control: correctly rooted, the filing stays uncredited");

  const misrooted = buildEscalationReconcileCandidates("o", "target", plan, ledgerFile(), undefined, {
    issues: listIssues(rows),
    github: gh,
    // THE ONLY DIFFERENCE from the line above: the resolved root. Nothing else in this fixture moves.
    evidenceRootFor: () => engineRepo,
  });
  assert.equal(misrooted[0].derived.merged, true, "an engine-rooted read reproduces the exact defect this task closes — the resolution is load-bearing");
  assert.notEqual(rooted[0].derived.merged, misrooted[0].derived.merged, "only the evidence root moved, and the verdict moved with it");
});

// ── CRITERION 2 — a target implementation merge still earns credit ───────────────────────────────

test("W1-T3873 criterion 2: a target implementation merge still earns credit — target-repo evidence is rooted in its own checkout", () => {
  const taskId = "PORTAL-T12";
  const prNumber = 108;
  const configRoot = mkdtempSync(join(tmpdir(), "rmd-cte-config-"));
  const targetRepo = targetEvidence(configRoot, "target", {
    prNumber,
    relPath: "src/console/real-change.ts",
    subjectVerb: "feat(console): implement PORTAL-T12",
    originSlug: "o/target",
  });
  const plan = planOf(taskId);
  const gh = makeGateway(taskId, prNumber, "o/target");
  const rows = [{ number: 2, url: "u2", title: "t", body: `**Task:** ${taskId}\n` }];

  const candidates = buildEscalationReconcileCandidates("o", "target", plan, ledgerFile(), undefined, {
    issues: listIssues(rows),
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
  targetEvidence(configRoot, "target", { prNumber: 1, relPath: "plan/x.yaml", subjectVerb: "chore", originSlug: "o/someone-elses-fork" });
  const root = creditEvidenceRootFor("o", "target", { selfOwnerRepo: { owner: "o", repo: "engine" }, configRoot });
  assert.equal(root, undefined, "an unproven checkout must never be trusted, however plausible its path");
});

test("W1-T3873 criterion 3: a checkout PROVEN to belong to the target resolves to its path", () => {
  const configRoot = mkdtempSync(join(tmpdir(), "rmd-cte-config-"));
  const targetRepo = targetEvidence(configRoot, "target", { prNumber: 1, relPath: "plan/x.yaml", subjectVerb: "chore", originSlug: "o/target" });
  const root = creditEvidenceRootFor("o", "target", { selfOwnerRepo: { owner: "o", repo: "engine" }, configRoot });
  assert.equal(root, targetRepo, "an origin-proven checkout is trusted, and only that one");
});

test("W1-T3873 criterion 3: origin proof accepts URL-shaped remotes only for the requested target", () => {
  const configRoot = mkdtempSync(join(tmpdir(), "rmd-cte-config-"));
  const candidate = join(configRoot, "repos", "target");
  const calls: Array<{ args: string[]; cwd: string }> = [];
  const root = creditEvidenceRootFor("o", "target", {
    selfOwnerRepo: { owner: "o", repo: "engine" },
    configRoot,
    exec: (args, cwd) => {
      calls.push({ args, cwd });
      return "https://github.com/o/target.git\n";
    },
  });
  assert.equal(root, candidate, "a proven HTTPS origin resolves to the target checkout");
  assert.deepEqual(calls, [{ args: ["config", "--get", "remote.origin.url"], cwd: candidate }]);

  assert.equal(
    creditEvidenceRootFor("o", "other", {
      selfOwnerRepo: { owner: "o", repo: "engine" },
      configRoot,
      exec: () => "https://github.com/o/target.git\n",
    }),
    undefined,
    "the same checkout is rejected when its origin names a different target",
  );
});

test("W1-T3873 criterion 3: foreign target evidence stays empty and fail-closed — missing evidence never manufactures a refusal", () => {
  // THE SAME plan-only fixture as criterion 1, but this time the resolved root is undefined
  // (foreign/missing). Both readers then answer with an EMPTY map, which is exactly the pre-
  // W1-T3067 shortcut's own behaviour: nothing contradicts the trailer credit, so it stands. An
  // absent checkout must never manufacture a NEW refusal of its own — only a PROVEN one may.
  const taskId = "PORTAL-T19";
  const prNumber = 107;
  const plan = planOf(taskId);
  const gh = makeGateway(taskId, prNumber, "o/target");
  const rows = [{ number: 1, url: "u1", title: "t", body: `**Task:** ${taskId}\n` }];

  const candidates = buildEscalationReconcileCandidates("o", "target", plan, ledgerFile(), undefined, {
    issues: listIssues(rows),
    github: gh,
    evidenceRootFor: () => undefined,
  });
  assert.equal(candidates[0].derived.merged, true, "no local opinion is available, so today's trailer-only answer stands — never a manufactured refusal");
});

test("W1-T3873 criterion 3: an unreadable engine origin also degrades to no evidence, not a throw", () => {
  // The real failure arm in creditEvidenceRootFor's self-identity read: `resolveOwnerRepo()`
  // throwing (a checkout with no readable `origin` remote) must fall through to the SAME
  // fail-closed answer as any other unproven checkout, never bubble up and take out a credit
  // pass over one broken git config. Driven in-process via the injected `resolveOwnerRepo` seam
  // (mirroring the injected `exec` seam already used above) so this needs no real broken repo.
  const configRoot = mkdtempSync(join(tmpdir(), "rmd-cte-config-"));
  // `configRoot/repos/target` was never created either, so a wrongly-resolved self would be the
  // only way this could produce anything other than `undefined`.
  const root = creditEvidenceRootFor("o", "target", {
    configRoot,
    resolveOwnerRepo: () => {
      throw new Error("no readable origin");
    },
  });
  assert.equal(root, undefined, "an unreadable engine origin is a safe no-evidence answer, not a throw");
});

// ── CRITERION 4 — the credit pass reads evidence ONCE per pass, never once per task ──────────────

test("W1-T3873 criterion 4: target credit evidence is read once per pass — buildEscalationReconcileCandidates resolves the root once, not once per open issue", () => {
  const configRoot = mkdtempSync(join(tmpdir(), "rmd-cte-config-"));
  const targetRepo = targetEvidence(configRoot, "target", { prNumber: 1, relPath: "src/x.ts", subjectVerb: "feat", originSlug: "o/target" });
  const plan = planOf("PORTAL-A", "PORTAL-B", "PORTAL-C");
  const rows = ["PORTAL-A", "PORTAL-B", "PORTAL-C"].map((id, i) => ({ number: i, url: `u${i}`, title: "t", body: `**Task:** ${id}\n` }));
  const gh = {
    prByRef: () => null,
    findMergedByTrailer: () => ({ number: 1, url: `https://github.com/o/target/pull/1`, state: "MERGED" }),
    headRefName: () => "claude/hand-named",
    prBody: () => "Remudero-Task: PORTAL-A\nRemudero-Task: PORTAL-B\nRemudero-Task: PORTAL-C\n",
  };

  let calls = 0;
  const candidates = buildEscalationReconcileCandidates("o", "target", plan, ledgerFile(), undefined, {
    issues: listIssues(rows),
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
  const targetRepo = targetEvidence(configRoot, "target", { prNumber: 1, relPath: "src/x.ts", subjectVerb: "feat", originSlug: "o/target" });
  const plan = planOf("PORTAL-A", "PORTAL-B", "PORTAL-C", "PORTAL-D", "PORTAL-E");
  const gh = {
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
