import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { triageCommand } from "../src/run-task.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import * as triage from "../src/lib/triage.js";
import type { WorkerResult } from "../src/lib/worker.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { ghShim } from "./helpers/gh-shim.js";
import { gitRepo } from "./helpers/git-repo.js";

// W1-T4936: a well-formed ALREADY_DECIDED verdict used to close the feedback as `rejected` without
// anyone asking whether the task id, path or PR it cites exists. The resolver below checks the
// existence half; a citation that resolves to nothing is demoted to the grill the AMBIGUOUS verdict
// already opens, so the entry parks with a human instead of being silently dropped.

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: GIT_ENV });
}

const PLAN_IDS = new Set(["W1-T10", "W1-T11"]);
const EVIDENCE: triage.CitationEvidence = {
  planIds: PLAN_IDS,
  pathExists: (p) => p === "plan/tasks.yaml" || p === "DECISIONS.md",
};

function decide(citation: string, evidence: triage.CitationEvidence | null = EVIDENCE, changedFiles: string[] = []) {
  const verdict = { kind: "already_decided" as const, citation };
  return triage.decideTriage({
    verdict,
    changedFiles,
    citation: evidence ? triage.unresolvedCitationReferents(citation, evidence) : undefined,
  });
}

test("W1-T4936: an already-decided verdict citing a task id absent from the plan is routed to a grill", () => {
  const d = decide("W1-T9999 already covers this request");
  assert.equal(d.action, "grill");
  if (d.action !== "grill") return;
  assert.equal(d.status, "grilling");
  assert.equal(d.cause, "unresolved_citation");
  assert.deepEqual(d.unresolved, ["W1-T9999"]);
  assert.match(d.detail, /W1-T9999/);
  assert.ok(d.options.length >= 2, "a grill is never opened without two actionable choices");
  assert.ok(d.options.some((o) => o.label === d.recommendation), "the recommendation names one of the options");

  const partial = decide("W1-T10 and W1-T9999 cover it");
  assert.equal(partial.action, "grill", "one real id does not launder an unresolved one beside it");

  const path = decide("W1-T10 per plan/tasks.d/W1-T2404-gone.yaml");
  assert.equal(path.action, "grill", "an unresolved path refuses too");
  if (path.action === "grill") assert.ok(path.unresolved?.includes("plan/tasks.d/W1-T2404-gone.yaml"));

  const resolution = triage.unresolvedCitationReferents("W1-T9999 covers it, see plan/tasks.yaml", EVIDENCE);
  assert.deepEqual(resolution.resolved, ["plan/tasks.yaml"]);
  assert.deepEqual(resolution.unresolved, ["W1-T9999"]);
});

test("W1-T4936: an already-decided verdict citing a task id in the plan still closes the feedback", () => {
  const d = decide("W1-T10 already covers this request");
  assert.deepEqual(d, { action: "no_task", status: "rejected", detail: "W1-T10 already covers this request" });

  const both = decide("`W1-T11`, see `plan/tasks.yaml`, and DECISIONS.md.");
  assert.equal(both.action, "no_task", "ids and existing paths, however punctuated, resolve");

  const noEvidence = decide("W1-T9999 already covers this", null);
  assert.equal(noEvidence.action, "no_task", "with no evidence supplied the decision is what it always was");

  const withFiles = decide("W1-T10 covers it", EVIDENCE, ["plan/feedback/x.yaml"]);
  assert.equal(withFiles.action, "error", "the changed-files guard still runs first");
});

test("W1-T4936: an already-decided citation naming nothing checkable is routed to a grill", () => {
  for (const citation of ["yes", "already answered in the design discussion", "see #4242", "it is fine and/or done"]) {
    const d = decide(citation);
    assert.equal(d.action, "grill", citation);
    if (d.action === "grill") {
      assert.equal(d.cause, "unresolved_citation");
      assert.deepEqual(d.unresolved, []);
      assert.match(d.detail, /names no task id or path/);
    }
  }
});

test("W1-T4936: a cited PR number that matches no merged PR never refuses on its own", () => {
  const d = decide("W1-T10 covers it, shipped in #999999");
  assert.equal(d.action, "no_task");

  const r = triage.unresolvedCitationReferents("W1-T10 shipped in #999999 and #12, not feedback#5 or a&#7", EVIDENCE);
  assert.deepEqual(r.advisoryPrs, ["#999999", "#12"]);
  assert.deepEqual(r.resolved, ["W1-T10"]);
  assert.deepEqual(r.unresolved, []);
});

test("W1-T4936: the worktree evidence reads the real plan and stays inside the worktree", () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t4936-wt-`));
  try {
    mkdirSync(join(root, "plan"), { recursive: true });
    writeFileSync(
      join(root, "plan", "tasks.yaml"),
      ["- id: W1-T4", '  title: "seed"', "  repo: remudero", "  depends_on: []", "  type: implement", "  verify: auto", "  status: queued", "  attempts: 0", ""].join("\n"),
    );
    const ev = triage.worktreeCitationEvidence(root);
    assert.ok(ev.planIds.has("W1-T4"));
    assert.ok(!ev.planIds.has("W1-T5"));
    assert.equal(ev.pathExists("plan/tasks.yaml"), true);
    assert.equal(ev.pathExists("plan/nope.yaml"), false);
    assert.equal(ev.pathExists("../../etc/passwd"), false, "a path escaping the worktree never resolves");
    assert.equal(ev.pathExists("/etc/passwd"), false, "an absolute path never resolves");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── THE LANE: real worktree, real loadPlan, real push into a throwaway bare origin ───────────

function fakeWorker(text: string): WorkerResult {
  return {
    sessionId: "T4936", costUsd: 0, numTurns: 1, text, blocks: [text], stderr: "",
    subtype: "success", isError: false, apiError: false, model: "claude-opus-5", effort: "high",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    totalCostUsd: 0, billingMode: "subscription", verdict: "success", qualitySuspect: false,
    compactionEvents: [], childEnvKeys: [],
  } as unknown as WorkerResult;
}

function makeOrigin(feedbackId: string): string {
  const bare = gitRepo({ bare: true, kind: "t4936-origin" }).dir;
  const seed = gitRepo({ kind: "t4936-seed" }).dir;
  mkdirSync(join(seed, "plan", "tasks.d"), { recursive: true });
  mkdirSync(join(seed, "plan", "feedback"), { recursive: true });
  writeFileSync(join(seed, "MASTER-PLAN.md"), "# MASTER-PLAN\n");
  writeFileSync(
    join(seed, "plan", "tasks.yaml"),
    ["- id: W1-T9", '  title: "seed"', "  repo: remudero", "  depends_on: []", "  type: implement", "  verify: auto", "  status: queued", "  attempts: 0", ""].join("\n"),
  );
  writeFileSync(
    join(seed, "plan", "feedback", `${feedbackId}.yaml`),
    [`id: ${feedbackId}`, "ts: '2026-09-30T00:00:00.000Z'", "raw: fixture entry for W1-T4936", "attachments: []", "origin: cli", "status: new", "proposal_pr: null", ""].join("\n"),
  );
  git(seed, "add", "-A");
  git(seed, "commit", "--quiet", "-m", "chore: seed plan");
  git(seed, "remote", "add", "origin", bare);
  git(seed, "push", "--quiet", "origin", "main");
  rmSync(seed, { recursive: true, force: true });
  return bare;
}

interface LaneRun {
  ledger: Array<Record<string, unknown>>;
  pushedStatus: string | undefined;
}

async function runLane(tag: string, verdictLine: string): Promise<LaneRun> {
  const feedbackId = `fb-t4936-${tag}-${process.hrtime()[1]}`;
  const bare = makeOrigin(feedbackId);
  const home = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t4936-home-`));
  const configRoot = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t4936-root-`));
  const shim = ghShim(
    [
      { when: "pr list", stdout: "[]" },
      { when: "issue create", stdout: "https://github.com/craigoley/remudero/issues/4936" },
      { when: "pr create", stdout: "https://github.com/craigoley/remudero/pull/4936" },
    ],
    { kind: "t4936-gh" },
  );
  const savedHome = process.env.HOME;
  const savedPath = process.env.PATH;
  try {
    mkdirSync(join(home, ".config", "remudero"), { recursive: true });
    writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/usr/bin/true", root: configRoot, installRoot: REPO_ROOT }));
    process.env.HOME = home;
    const originUrl = execFileSync("git", ["-C", REPO_ROOT, "config", "--get", "remote.origin.url"], { encoding: "utf8" }).trim();
    const repoName = originUrl.match(/[/:]([^/:]+)\/([^/]+?)(?:\.git)?$/)![2];
    const repoDir = join(configRoot, "repos", repoName);
    mkdirSync(dirname(repoDir), { recursive: true });
    execFileSync("git", ["clone", "--quiet", bare, repoDir], { encoding: "utf8", env: GIT_ENV });
    execFileSync("git", ["-C", repoDir, "config", "user.name", "t"], { encoding: "utf8" });
    execFileSync("git", ["-C", repoDir, "config", "user.email", "t@t"], { encoding: "utf8" });
    process.env.PATH = `${shim.dir}:${savedPath}`;

    await withLiveWritesAllowed(() =>
      triageCommand([feedbackId], {
        spawn: async (args: { tools?: string[] }) => fakeWorker((args.tools ?? []).length === 0 ? "{}" : verdictLine),
      }),
    ).catch(() => undefined);

    const path = join(configRoot, "state", "ledger.ndjson");
    const ledger = existsSync(path)
      ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)
      : [];
    const refs = git(bare, "for-each-ref", "--format=%(refname)", "refs/heads/run-*").split("\n").filter(Boolean);
    const branch = refs[refs.length - 1];
    const body = branch ? git(bare, "show", `${branch}:plan/feedback/${feedbackId}.yaml`) : "";
    return { ledger, pushedStatus: /^status: (\S+)$/m.exec(body)?.[1] };
  } finally {
    process.env.PATH = savedPath;
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    for (const d of [bare, home, configRoot, shim.dir]) rmSync(d, { recursive: true, force: true });
  }
}

test("W1-T4936: the lane resolves a cited id against the worktree plan", async () => {
  const absent = await runLane("absent", "ALREADY_DECIDED: W1-T9999 already covers this");
  const grills = absent.ledger.filter((l) => l.step === "triage.grill_opened");
  assert.equal(grills.length, 1, "an id absent from the worktree plan opens a grill");
  assert.equal(grills[0]!.cause, "unresolved_citation");
  assert.deepEqual(grills[0]!.unresolved, ["W1-T9999"]);
  assert.equal(absent.pushedStatus, "grilling", "the entry is parked, never flipped to rejected");

  const real = await runLane("real", "ALREADY_DECIDED: W1-T9 already covers this");
  assert.equal(real.ledger.filter((l) => l.step === "triage.grill_opened").length, 0, "an id in the worktree plan opens no grill");
  assert.equal(real.pushedStatus, "rejected", "a resolved citation still closes the feedback");
});
