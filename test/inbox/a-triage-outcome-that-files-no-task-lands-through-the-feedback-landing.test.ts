/**
 * W1-T12198: a triage outcome that files no task (`no_task`, `grill`) lands its one status change
 * through the shared feedback landing pull request, and opens no pull request of its own.
 * W1-T12790: that landing awaits its plan-PR preflight, so the daemon loop keeps running meanwhile.
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
import { LANDING_BRANCH, landFeedbackStatusContent } from "#src/lib/feedback-landing.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
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

const TASK_FIELDS = ["  repo: remudero", "  depends_on: []", "  type: implement", "  design: |", "    NO-INVARIANTS: synthetic lint fixture with no inherited behavior to preserve", "  verify: auto", "  status: queued", "  attempts: 0"].join("\n");

const NO_TASK_VERDICT = "ALREADY_DECIDED: W1-T4 already covers this request";
const GRILL_VERDICT = [
  "GROUND: no existing task covers this.",
  "OPTION: cli-flag|add a --foo flag to the relevant command",
  "OPTION: config-default|add a config default instead, no new flag",
  "RECOMMENDATION: cli-flag",
  "AMBIGUOUS: does this want a CLI flag or a config default?",
].join("\n");

/** W1-T12790: an in-tree task id check that takes 2 s, as the real one does under load. Each run appends
 *  `<start ms> <end ms>` to `marker`, so a test can read the window in which the check ran. */
function slowTaskIdCheck(dir: string, marker: string): void {
  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeFileSync(join(dir, "scripts", "task-id-existence-check.mjs"), [
    'import { appendFileSync } from "node:fs";',
    "const start = Date.now();",
    `setTimeout(() => { appendFileSync(${JSON.stringify(marker)}, \`\${start} \${Date.now()}\\n\`); process.exit(0); }, 2000);`, "",
  ].join("\n"));
}

/** A bare origin with one plan task (W1-T4) and one `status: new` feedback entry (none when `entry` is false). */
function makeOrigin(feedbackId: string, o: { entry?: boolean; tasks?: string; slowCheckMarker?: string } = {}): string {
  const bare = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t12198-origin-`));
  execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", bare], { encoding: "utf8", env: GIT_ENV });
  const seed = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t12198-seed-`));
  execFileSync("git", ["init", "--quiet", "-b", "main", seed], { encoding: "utf8", env: GIT_ENV });
  mkdirSync(join(seed, "plan", "tasks.d"), { recursive: true });
  mkdirSync(join(seed, "plan", "feedback"), { recursive: true });
  writeFileSync(join(seed, "plan", "tasks.yaml"), o.tasks ?? `- id: W1-T4\n  title: "seed"\n${TASK_FIELDS}\n`);
  writeFileSync(join(seed, "MASTER-PLAN.md"), "# MASTER-PLAN (fixture)\n");
  if (o.entry !== false) {
    writeFileSync(join(seed, "plan", "feedback", `${feedbackId}.yaml`),
      [`id: ${feedbackId}`, "ts: '2026-11-10T00:00:00.000Z'", "raw: fixture entry for W1-T12198", "attachments: []",
        "origin: cli", "status: new", "proposal_pr: null", ""].join("\n"));
  }
  if (o.slowCheckMarker !== undefined) slowTaskIdCheck(seed, o.slowCheckMarker);
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
  /** The bare origin that holds the entry: the private one for a private-home fixture, else `bare`. */
  homeBare: string;
  repoDir: string;
  run: (worker: (cwd: string) => string) => Promise<{ code: number | undefined; error: unknown }>;
  /** Run `fn` with this fixture's HOME and gh shim, as `run` does. */
  inEnv: <T>(fn: () => T) => T;
  ledger: () => Array<Record<string, unknown>>;
  ghCalls: () => string[];
  slowCheckRuns: () => Array<{ start: number; end: number }>;
  cleanup: () => void;
}

/** W1-T12790: `slowCheck` puts a 2 s task id check in the tree; `privateHome` keeps the entry in a private plan
 *  destination checkout (the landPrivateTriageStatus path), not in the public origin. */
function fixture(o: { feedbackId?: string; slowCheck?: boolean; privateHome?: boolean } = {}): Fixture {
  const feedbackId = o.feedbackId ?? `fb-t12198-${Date.now()}-${Math.floor(process.hrtime()[1] / 1000)}`;
  const shimDir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t12198-gh-`));
  const marker = join(shimDir, "slow-check-runs.txt");
  const slowCheckMarker = o.slowCheck ? marker : undefined;
  const bare = makeOrigin(feedbackId, o.privateHome ? { entry: false } : { slowCheckMarker });
  const privateBare = o.privateHome ? makeOrigin(feedbackId, { tasks: "[]\n", slowCheckMarker }) : undefined;
  const home = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t12198-home-`));
  const configRoot = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t12198-root-`));
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
  if (privateBare !== undefined) {
    mkdirSync(join(configRoot, "state"), { recursive: true });
    writeFileSync(join(configRoot, "state", "plan-destination.json"), JSON.stringify({ repository: "fixture/private-ops", kinds: ["feedback"] }));
    const privateDir = join(configRoot, "repos", "private-ops");
    execFileSync("git", ["clone", "--quiet", privateBare, privateDir], { encoding: "utf8", env: GIT_ENV });
    git(privateDir, "config", "user.name", "t");
    git(privateDir, "config", "user.email", "t@t");
  }
  writeFileSync(join(shimDir, "gh"), [
    "#!/bin/sh",
    `printf '%s\\n' "$*" >> ${JSON.stringify(argvLog)}`,
    'case "$*" in',
    '  *"pr list"*) echo "[]" ;;',
    '  *"pulls"*) echo "[]" ;;',
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
    homeBare: privateBare ?? bare,
    repoDir,
    inEnv: (fn) => {
      process.env.HOME = home;
      process.env.PATH = `${shimDir}:${savedPath}`;
      try {
        return fn();
      } finally {
        process.env.PATH = savedPath;
        if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
      }
    },
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
    slowCheckRuns: () => (existsSync(marker) ? readFileSync(marker, "utf8").split("\n").filter(Boolean) : [])
      .map((line) => line.split(" ").map(Number)).map(([start, end]) => ({ start: start!, end: end! })),
    cleanup: () => {
      for (const d of [shimDir, home, configRoot, bare, ...(privateBare ? [privateBare] : [])]) rmSync(d, { recursive: true, force: true });
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
        "  depends_on: []", "  type: implement", "  design: |", "    NO-INVARIANTS: synthetic lint fixture with no inherited behavior to preserve", "  verify: auto", "  status: queued", "  attempts: 0",
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
  const clone = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t12198-clone-`));
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

/** W1-T12790: when a 50 ms timer started before `call` fired, in epoch ms. A synchronous spawn holds it back.
 *  The firings are read on the host clock, as the slow check's child stamps its window: a child's clock does not
 *  follow a shifted test clock, and the two windows then never overlap (W1-T14786). */
async function timerFirings<T>(call: () => Promise<T>): Promise<{ result: T; firings: number[] }> {
  const firings: number[] = [];
  const timer = setInterval(() => firings.push(Math.floor(performance.timeOrigin + performance.now())), 50);
  try {
    return { result: await call(), firings };
  } finally {
    clearInterval(timer);
  }
}

/** The longest wait between two timer firings inside `window` (its ends count as firings). */
function longestGapIn(window: { start: number; end: number }, firings: readonly number[]): number {
  const points = [window.start, ...firings.filter((t) => t > window.start && t < window.end), window.end];
  return Math.max(...points.slice(1).map((t, k) => t - points[k]!));
}

/** The status, the slow check and the timer, for one fixture run whose tree carries the 2 s check. */
async function assertLandsWhileTheLoopRuns(f: Fixture, verdict: string, status: string): Promise<void> {
  const { result: r, firings } = await timerFirings(() => f.run(() => verdict));
  assert.equal(r.error, undefined, `triage must not throw: ${String(r.error)}`);
  assert.equal(r.code, 0);
  assert.equal(statusAt(f.homeBare, LANDING_BRANCH, f.feedbackId), status, "the landing branch carries the status change");
  const runs = f.slowCheckRuns();
  assert.ok(runs.length >= 1, "positive control: the landing preflight ran the 2 s in-tree task id check");
  for (const run of runs) {
    assert.ok(run.end - run.start >= 2000, "positive control: the check took its 2 s");
    const gapMs = longestGapIn(run, firings);
    assert.ok(gapMs < 500, `while the 2 s check ran, the 50 ms timer waited ${gapMs} ms in one gap: the landing blocked the loop`);
  }
}

test("W1-T12790 criterion 1: a no_task landing awaits its 2 s preflight check, and a 50 ms timer keeps firing", async () => {
  const f = fixture({ slowCheck: true });
  try {
    await assertLandsWhileTheLoopRuns(f, NO_TASK_VERDICT, "rejected");
  } finally {
    f.cleanup();
  }
});

test("W1-T12790 criterion 2: a grill landing awaits its 2 s preflight check, and a 50 ms timer keeps firing", async () => {
  const f = fixture({ slowCheck: true });
  try {
    await assertLandsWhileTheLoopRuns(f, GRILL_VERDICT, "grilling");
    assert.ok(f.ghCalls().some((c) => c.startsWith("issue create")), "the grill escalation was opened");
  } finally {
    f.cleanup();
  }
});

test("W1-T12790 criterion 2: a private-home entry lands in its own repository through the async landing, and the timer keeps firing", async () => {
  const f = fixture({ slowCheck: true, privateHome: true });
  try {
    await assertLandsWhileTheLoopRuns(f, NO_TASK_VERDICT, "rejected");
    assert.ok(!headsOn(f.bare).includes(LANDING_BRANCH), "the public origin gets no feedback landing");
  } finally {
    f.cleanup();
  }
});

test("W1-T12790 criterion 3: the async landing lands what the synchronous landing lands, with the same rows, cleanup and exit codes", async () => {
  const feedbackId = `fb-t12790-same-${Date.now()}`;
  const viaTriage = fixture({ feedbackId });
  const viaSync = fixture({ feedbackId });
  const viaRefused = fixture({ feedbackId });
  try {
    const r = await viaTriage.run(() => NO_TASK_VERDICT);
    assert.equal(r.error, undefined, `triage must not throw: ${String(r.error)}`);
    assert.equal(r.code, 0);
    const rel = `plan/feedback/${feedbackId}.yaml`;
    const landed = git(viaTriage.bare, "show", `${LANDING_BRANCH}:${rel}`);
    assert.match(landed, /^status: rejected$/m);

    // The synchronous landing, given the same bytes in a twin origin, writes the same branch content and pull request.
    const sync = viaSync.inEnv(() => withLiveWritesAllowed(() => landFeedbackStatusContent(viaSync.repoDir, rel, landed, {})));
    assert.equal(sync.landed, true, `the synchronous landing lands: ${String(sync.error)}`);
    assert.equal(git(viaSync.bare, "show", `${LANDING_BRANCH}:${rel}`), landed, "the same file content");
    const changed = (bare: string) => git(bare, "diff", "--name-only", "main", LANDING_BRANCH).split("\n").filter(Boolean);
    assert.deepEqual(changed(viaTriage.bare), changed(viaSync.bare), "the same paths on the landing branch");
    const subject = (bare: string) => git(bare, "log", "-1", "--format=%s", LANDING_BRANCH).trim();
    assert.equal(subject(viaTriage.bare), subject(viaSync.bare), "the same landing commit subject");

    const rows = viaTriage.ledger();
    const opened = rows.filter((l) => l.step === "pr.opened");
    assert.equal(opened.length, 1, "one pr.opened row");
    assert.equal(opened[0]!.pr_url, sync.prUrl, "the pr.opened row names the pull request the synchronous landing returns");
    assert.equal(opened[0]!.landing, true);
    assert.equal(opened[0]!.action, "no_task");
    const response = rows.filter((l) => l.step === "triage.escalation_response");
    assert.equal(response.length, 1, "one triage.escalation_response row");
    assert.equal(response[0]!.feedback_id, feedbackId);
    assert.ok(rows.findIndex((l) => l.step === "pr.opened") < rows.findIndex((l) => l.step === "triage.escalation_response"),
      "pr.opened comes before triage.escalation_response");
    const worktrees = git(viaTriage.repoDir, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree "));
    assert.equal(worktrees.length, 1, `the triage worktree is removed: ${worktrees.join(" | ")}`);

    // A refused async landing still writes triage.error, leaves the entry at new, removes the worktree and exits 1.
    refuseLandingPushes(viaRefused.bare);
    const refused = await viaRefused.run(() => NO_TASK_VERDICT);
    assert.equal(refused.error, undefined, `triage must not throw: ${String(refused.error)}`);
    assert.equal(refused.code, 1);
    const errors = viaRefused.ledger().filter((l) => l.step === "triage.error");
    assert.equal(errors.length, 1);
    assert.match(String(errors[0]!.error), /^feedback landing refused: \S/);
    assert.equal(statusAt(viaRefused.bare, "main", feedbackId), "new");
    assert.equal(viaRefused.ledger().filter((l) => l.step === "pr.opened").length, 0);
    const left = git(viaRefused.repoDir, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree "));
    assert.equal(left.length, 1, `the refused run removes its worktree too: ${left.join(" | ")}`);
  } finally {
    viaTriage.cleanup();
    viaSync.cleanup();
    viaRefused.cleanup();
  }
});
