/**
 * W1-T12198: a triage outcome that files no task (`no_task`, `grill`) lands its one status change
 * through the shared feedback landing pull request, and opens no pull request of its own.
 *
 * Each run test drives the real `rmd triage` command (`triageCommand`) against a local bare
 * origin. Only the paid worker (`spawn`) and the `gh` binary (a shim on PATH) are replaced. The
 * landing itself runs for real: real git pushes the landing branch to the bare origin.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { triageCommand } from "#src/run-task.js";
import { claimTriage, type TriageClaimReserverAsync } from "#src/lib/auto-triage.js";
import { readLandedFeedbackEntry } from "#src/lib/feedback.js";
import { LANDING_BRANCH } from "#src/lib/feedback-landing.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import type { WorkerResult } from "#src/lib/worker.js";
import { repoRoot } from "#test/helpers/repo-root.js";

const REPO_ROOT = repoRoot();
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const LANDING_PR = "https://github.com/craigoley/remudero/pull/4242";
const ISSUE_URL = "https://github.com/craigoley/remudero/issues/4243";

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: GIT_ENV });
}

function fakeWorker(text: string): WorkerResult {
  return {
    sessionId: "T12198", costUsd: 0, numTurns: 1, text, blocks: [], stderr: "",
    subtype: "success", isError: false, apiError: false, model: "claude-opus-5", effort: "high",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    totalCostUsd: 0, billingMode: "subscription", verdict: "success", qualitySuspect: false,
    compactionEvents: [], childEnvKeys: [],
  } as unknown as WorkerResult;
}

const TASK_FIELDS = ["  repo: remudero", "  depends_on: []", "  type: implement", "  verify: auto", "  status: queued", "  attempts: 0"].join("\n");

const NO_TASK_VERDICT = "ALREADY_DECIDED: W1-T4 already covers this request";
const GRILL_VERDICT = [
  "GROUND: no existing task covers this.",
  "OPTION: cli-flag|add a --foo flag to the relevant command",
  "OPTION: config-default|add a config default instead, no new flag",
  "RECOMMENDATION: cli-flag",
  "AMBIGUOUS: does this want a CLI flag or a config default?",
].join("\n");

/** A bare origin with one plan task (W1-T4) and one `status: new` feedback entry. */
function makeOrigin(feedbackId: string): string {
  const bare = mkdtempSync(join(tmpdir(), "t12198-origin-"));
  execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", bare], { encoding: "utf8", env: GIT_ENV });
  const seed = mkdtempSync(join(tmpdir(), "t12198-seed-"));
  execFileSync("git", ["init", "--quiet", "-b", "main", seed], { encoding: "utf8", env: GIT_ENV });
  mkdirSync(join(seed, "plan", "tasks.d"), { recursive: true });
  mkdirSync(join(seed, "plan", "feedback"), { recursive: true });
  writeFileSync(join(seed, "plan", "tasks.yaml"), `- id: W1-T4\n  title: "seed"\n${TASK_FIELDS}\n`);
  writeFileSync(join(seed, "MASTER-PLAN.md"), "# MASTER-PLAN (fixture)\n");
  writeFileSync(join(seed, "plan", "feedback", `${feedbackId}.yaml`),
    [`id: ${feedbackId}`, "ts: '2026-11-10T00:00:00.000Z'", "raw: fixture entry for W1-T12198", "attachments: []",
      "origin: cli", "status: new", "proposal_pr: null", ""].join("\n"));
  git(seed, "add", "-A");
  git(seed, "commit", "--quiet", "-m", "chore: seed plan");
  git(seed, "remote", "add", "origin", bare);
  git(seed, "push", "--quiet", "origin", "main");
  rmSync(seed, { recursive: true, force: true });
  return bare;
}

/** Make the bare origin refuse every push to a feedback landing branch, so the landing is refused. */
function refuseLandingPushes(bare: string): void {
  writeFileSync(join(bare, "hooks", "pre-receive"), [
    "#!/bin/sh",
    "while read old new ref; do",
    '  case "$ref" in refs/heads/feedback-landing*) echo "fixture refuses $ref" >&2; exit 1 ;; esac',
    "done", "",
  ].join("\n"), { mode: 0o755 });
}

interface Fixture {
  feedbackId: string;
  bare: string;
  run: (worker: (cwd: string) => string) => Promise<{ code: number | undefined; error: unknown }>;
  ledger: () => Array<Record<string, unknown>>;
  ghCalls: () => string[];
  cleanup: () => void;
}

function fixture(): Fixture {
  const feedbackId = `fb-t12198-${Date.now()}-${Math.floor(process.hrtime()[1] / 1000)}`;
  const bare = makeOrigin(feedbackId);
  const home = mkdtempSync(join(tmpdir(), "t12198-home-"));
  const configRoot = mkdtempSync(join(tmpdir(), "t12198-root-"));
  const shimDir = mkdtempSync(join(tmpdir(), "t12198-gh-"));
  const argvLog = join(shimDir, "argv.txt");
  writeFileSync(argvLog, "");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"),
    JSON.stringify({ claudeBin: "/usr/bin/true", root: configRoot, installRoot: REPO_ROOT }));
  const originUrl = execFileSync("git", ["-C", REPO_ROOT, "config", "--get", "remote.origin.url"], { encoding: "utf8" }).trim();
  const repoDir = join(configRoot, "repos", originUrl.match(/[/:]([^/:]+)\/([^/]+?)(?:\.git)?$/)![2]);
  mkdirSync(dirname(repoDir), { recursive: true });
  execFileSync("git", ["clone", "--quiet", bare, repoDir], { encoding: "utf8", env: GIT_ENV });
  git(repoDir, "config", "user.name", "t");
  git(repoDir, "config", "user.email", "t@t");
  writeFileSync(join(shimDir, "gh"), [
    "#!/bin/sh",
    `printf '%s\\n' "$*" >> ${JSON.stringify(argvLog)}`,
    'case "$*" in',
    '  *"pr list"*) echo "[]" ;;',
    `  *"pr create"*"--head ${LANDING_BRANCH}"*) echo "${LANDING_PR}" ;;`,
    '  *"pr create"*) echo "https://github.com/craigoley/remudero/pull/999" ;;',
    `  *"issue create"*) echo "${ISSUE_URL}" ;;`,
    '  *"issue list"*) echo "[]" ;;',
    `  *"--json headRefName"*) git -C ${bare} for-each-ref --format='{"headRefName":"%(refname:short)"}' refs/heads/run-* | tail -1 ;;`,
    "  *\"--json body\"*) echo '{\"body\":\"\"}' ;;",
    '  *"pr diff"*) echo "" ;;',
    "  *) exit 0 ;;",
    "esac", "",
  ].join("\n"), { mode: 0o755 });

  const savedHome = process.env.HOME;
  const savedPath = process.env.PATH;
  const ledgerPath = join(configRoot, "state", "ledger.ndjson");
  return {
    feedbackId,
    bare,
    run: async (worker) => {
      process.env.HOME = home;
      process.env.PATH = `${shimDir}:${savedPath}`;
      try {
        const code = await withLiveWritesAllowed(() => triageCommand([feedbackId], {
          spawn: async (args: { cwd: string; prompt: string; tools?: string[] }) =>
            (args.tools ?? []).length === 0 ? fakeWorker("{}") : fakeWorker(worker(args.cwd)),
        }));
        return { code, error: undefined };
      } catch (error) {
        return { code: undefined, error };
      } finally {
        process.env.PATH = savedPath;
        if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
      }
    },
    ledger: () => existsSync(ledgerPath)
      ? readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)
      : [],
    ghCalls: () => readFileSync(argvLog, "utf8").split("\n").filter(Boolean),
    cleanup: () => {
      for (const d of [shimDir, home, configRoot, bare]) rmSync(d, { recursive: true, force: true });
    },
  };
}

function statusAt(bare: string, ref: string, feedbackId: string): string | undefined {
  try {
    return /^status:\s*(\S+)\s*$/m.exec(git(bare, "show", `${ref}:plan/feedback/${feedbackId}.yaml`))?.[1];
  } catch {
    return undefined;
  }
}

function headsOn(bare: string): string[] {
  return git(bare, "for-each-ref", "--format=%(refname:short)", "refs/heads/").split("\n").filter(Boolean);
}

test("W1-T12198 criterion 1: a no_task outcome lands its status through the feedback landing and opens no pull request of its own", async () => {
  const f = fixture();
  try {
    const r = await f.run(() => NO_TASK_VERDICT);
    assert.equal(r.error, undefined, `triage must not throw: ${String(r.error)}`);
    assert.equal(r.code, 0);
    assert.equal(statusAt(f.bare, LANDING_BRANCH, f.feedbackId), "rejected", "the landing branch carries the status change");
    assert.equal(statusAt(f.bare, "main", f.feedbackId), "new", "main changes only when the landing pull request merges");
    assert.deepEqual(headsOn(f.bare).filter((h) => h.startsWith("run-")), [], "no triage run branch was pushed");
    const creates = f.ghCalls().filter((c) => c.includes("pr create"));
    assert.equal(creates.length, 1, `one pull request create, the landing's: ${creates.join(" | ")}`);
    assert.match(creates[0]!, new RegExp(`--head ${LANDING_BRANCH}`));
    const opened = f.ledger().filter((l) => l.step === "pr.opened");
    assert.equal(opened.length, 1);
    assert.equal(opened[0]!.pr_url, LANDING_PR);
    assert.equal(opened[0]!.landing, true);
    assert.equal(opened[0]!.task_id, `TRIAGE-${f.feedbackId}`, "the daemon's in-flight guard keys on this task id");
  } finally {
    f.cleanup();
  }
});

test("W1-T12198 criterion 2: a propose outcome still opens its own pull request and does not use the landing", async () => {
  const f = fixture();
  try {
    const r = await f.run((cwd) => {
      const id = "W1-T5";
      mkdirSync(join(cwd, "plan", "tasks.d"), { recursive: true });
      writeFileSync(join(cwd, "plan", "tasks.d", `${id}-fixture.yaml`), [
        `- id: ${id}`, `  title: "a task filed for feedback#${f.feedbackId}"`, "  repo: remudero", "  origin: architect",
        "  depends_on: []", "  type: implement", "  verify: auto", "  status: queued", "  attempts: 0",
        "  files: [test/inbox/a-triage-outcome-that-files-no-task-lands-through-the-feedback-landing.test.ts]",
        "  acceptance:", '    - claim: "the thing holds"',
        '      proof: "unit test: test/inbox/a-triage-outcome-that-files-no-task-lands-through-the-feedback-landing.test.ts"', "",
      ].join("\n"));
      return `PROPOSED: file ${id} for feedback#${f.feedbackId}`;
    });
    const heads = headsOn(f.bare);
    const steps = f.ledger().map((l) => `${String(l.step)}${l.error ? `: ${String(l.error)}` : ""}`).join("\n");
    assert.ok(heads.some((h) => h.startsWith(`run-TRIAGE-${f.feedbackId}-`)), `the triage run branch was pushed (${String(r.error)}):\n${steps}`);
    assert.ok(!heads.includes(LANDING_BRANCH), "a proposal never rides the feedback landing");
    const calls = f.ghCalls().join("\n");
    assert.ok(calls.includes(`-f head=run-TRIAGE-${f.feedbackId}-`), `the run asked GitHub for its own pull request:\n${calls}`);
    assert.ok(!calls.includes(`--head ${LANDING_BRANCH}`), "no landing pull request was asked for");
    assert.equal(f.ledger().filter((l) => l.step === "triage.id_minted").length, 1, "the proposal path ran");
  } finally {
    f.cleanup();
  }
});

/** A claim held by another lane: every attempt reads `taken`, and `drop` records what it was asked. */
function heldElsewhere(): { reserver: TriageClaimReserverAsync; dropped: string[] } {
  const dropped: string[] = [];
  return {
    dropped,
    reserver: {
      mintAnchor: () => "a".repeat(40),
      attempt: () => "taken",
      holder: () => "b".repeat(40),
      drop: (id) => {
        dropped.push(id);
        return true;
      },
    },
  };
}

test("W1-T12198 criterion 3: the claim release takes a decided status on origin/main as evidence, with no merged subject that names the id", async () => {
  const feedbackId = `fb-t12198-c3-${Date.now()}`;
  const bare = makeOrigin(feedbackId);
  const clone = mkdtempSync(join(tmpdir(), "t12198-clone-"));
  try {
    execFileSync("git", ["clone", "--quiet", bare, clone], { encoding: "utf8", env: GIT_ENV });
    const subjects = () => ["chore(feedback): land pending filings"];
    const landedStatus = (id: string) => readLandedFeedbackEntry(clone, id)?.status;

    // Control: main still holds `status: new`, and no subject names the id, so the claim stays.
    const held = heldElsewhere();
    const kept = await claimTriage(feedbackId, held.reserver, { mergedSubjects: subjects, landedStatus });
    assert.equal(kept.proceed, false);
    assert.equal(kept.staleReleased, false, "an undecided entry keeps its claim");
    assert.deepEqual(held.dropped, []);

    // The batched landing merges: main now holds `status: rejected` under a subject without the id.
    const entry = join(clone, "plan", "feedback", `${feedbackId}.yaml`);
    writeFileSync(entry, readFileSync(entry, "utf8").replace("status: new", "status: rejected"));
    git(clone, "commit", "--quiet", "-am", "chore(feedback): land pending filings");
    git(clone, "push", "--quiet", "origin", "main");
    git(clone, "fetch", "--quiet", "origin");
    const stale = heldElsewhere();
    const released = await claimTriage(feedbackId, stale.reserver, { mergedSubjects: subjects, landedStatus });
    assert.equal(released.staleReleased, true, "a decided status on main releases the stale claim");
    assert.deepEqual(stale.dropped, [feedbackId]);
  } finally {
    for (const d of [bare, clone]) rmSync(d, { recursive: true, force: true });
  }
});

test("W1-T12198 criterion 4: a grill outcome still opens its escalation, and the recorded outcome names the landing pull request", async () => {
  const f = fixture();
  try {
    const r = await f.run(() => GRILL_VERDICT);
    assert.equal(r.error, undefined, `triage must not throw: ${String(r.error)}`);
    assert.equal(r.code, 0);
    assert.ok(f.ghCalls().some((c) => c.startsWith("issue create")), "the grill escalation was opened");
    const rows = f.ledger();
    const grill = rows.filter((l) => l.step === "triage.grill_opened");
    assert.equal(grill.length, 1);
    assert.equal(grill[0]!.issue_url, ISSUE_URL);
    assert.equal(statusAt(f.bare, LANDING_BRANCH, f.feedbackId), "grilling");
    const opened = rows.filter((l) => l.step === "pr.opened");
    assert.equal(opened.length, 1);
    assert.equal(opened[0]!.pr_url, LANDING_PR, "the recorded outcome names the landing pull request");
    assert.equal(opened[0]!.action, "grill");
  } finally {
    f.cleanup();
  }
});

test("W1-T12198 criterion 5: a refused landing writes an error row with its cause, and the entry stays new for a later pass", async () => {
  const f = fixture();
  try {
    refuseLandingPushes(f.bare);
    const refused = await f.run(() => NO_TASK_VERDICT);
    assert.equal(refused.error, undefined, `triage must not throw: ${String(refused.error)}`);
    assert.equal(refused.code, 1);
    const errors = f.ledger().filter((l) => l.step === "triage.error");
    assert.equal(errors.length, 1);
    assert.match(String(errors[0]!.error), /^feedback landing refused: \S/, "the row names the cause");
    assert.equal(statusAt(f.bare, "main", f.feedbackId), "new");
    assert.ok(!headsOn(f.bare).includes(LANDING_BRANCH));
    assert.equal(f.ledger().filter((l) => l.step === "pr.opened").length, 0);

    // A later pass triages the same entry again, and this time the landing takes it.
    rmSync(join(f.bare, "hooks", "pre-receive"));
    const again = await f.run(() => NO_TASK_VERDICT);
    assert.equal(again.code, 0);
    assert.equal(statusAt(f.bare, LANDING_BRANCH, f.feedbackId), "rejected");
  } finally {
    f.cleanup();
  }
});

test("W1-T12198 criterion 6: the test goes through the rmd triage command, and the real landing writes the landing branch", async () => {
  const f = fixture();
  try {
    const r = await f.run(() => NO_TASK_VERDICT);
    assert.equal(r.code, 0);
    const rows = f.ledger();
    const start = rows.find((l) => l.step === "triage.start");
    assert.ok(start, "the triage command wrote its start row");
    assert.ok(rows.some((l) => l.step === "pr.opened" && l.run_id === start!.run_id), "the landing row belongs to the same triage run");
    // The landing branch was written by real git, not by a stand-in: its tip changes only the entry.
    const changed = git(f.bare, "diff", "--name-only", "main", LANDING_BRANCH).split("\n").filter(Boolean);
    assert.deepEqual(changed, [`plan/feedback/${f.feedbackId}.yaml`]);
    assert.ok(f.ghCalls().some((c) => c.includes("pr create") && c.includes("chore(feedback): land pending filings")),
      "the landing opened its shared pull request");
  } finally {
    f.cleanup();
  }
});
