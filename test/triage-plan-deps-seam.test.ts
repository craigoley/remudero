import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { planCommand, triageCommand } from "#src/run-task.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import type { WorkerResult } from "#src/lib/worker.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { ghShim } from "#test/helpers/gh-shim.js";
import { stringify } from "yaml";
import { appendThreadMessage, appendThreadReplyOnce, deriveThreadId, readThread } from "#src/lib/inbox-thread.js";
import { escalationReplySubmissionKey } from "#src/lib/escalation-correspondence.js";
import { feedbackEntryRepoPath, type FeedbackEntry } from "#src/lib/feedback.js";

// ── WHAT THIS FILE PROVES ────────────────────────────────────────────────────────────
// `triageCommand` and `planCommand` took no deps parameter, so no offline test could get
// past their `spawnWorker` call: reaching the code after it required a real, paid worker.
// That is why PR #954 sat blocked on coverage-ratchet through three rounds — every line
// it added inside these functions was uncovered whatever it contained, and TWO successive
// refactors moved those lines around without changing that fact.
//
// The seam (impl-BB) mirrors runTask's existing `opts: { spawn?, config? }` shape. These
// tests are the proof that the seam actually WORKS — not that it exists. Each injects a
// fake spawn returning a plausible WorkerResult and then asserts on a LEDGER LINE that is
// written AFTER the spawn point:
//
//   triageCommand -> log("triage.synthesized", …)  is the first statement after `await spawn`
//   planCommand   -> log("plan.synthesized",   …)  likewise
//
// A ledger line is an observable side effect on disk, not "the test passed" — which is the
// distinction that matters here, because a test that never enters the function would also
// pass. If these two ledger lines are absent, the seam bought nothing.

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

/** A plausible worker envelope — the shape the post-spawn code reads (`sessionId`,
 *  `costUsd`, `subtype`, `text`, `blocks`). Deliberately carries NO valid verdict: the run
 *  is expected to end at the "inconsistent" branch, which is fine — reaching that branch
 *  means we got past the spawn, which is the whole point. */
function fakeWorkerResult(text: string): WorkerResult {
  return {
    sessionId: "SEAM-SESSION-1",
    costUsd: 0,
    numTurns: 1,
    text,
    blocks: [text],
    stderr: "",
    subtype: "success",
    isError: false,
    apiError: false,
    model: "claude-opus-5",
    effort: "high",
    // `workerLedgerFields` reads every one of these on the post-spawn ledger line, so an
    // incomplete envelope throws there rather than returning — which is itself evidence the
    // post-spawn code runs, but makes for a confusing test. Full shape, zeroed.
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    totalCostUsd: 0,
    billingMode: "subscription",
    verdict: "success",
    qualitySuspect: false,
    compactionEvents: [],
    childEnvKeys: [],
  } as unknown as WorkerResult;
}

/** A bare origin carrying a plan and one `status: new` feedback entry, mirroring
 *  test/triage-id-mint.test.ts's fixture — entirely offline, no network, no real worker. */
function makeOrigin(feedbackId: string): string {
  const bare = mkdtempSync(join(tmpdir(), "seam-origin-"));
  execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", bare], { encoding: "utf8", env: GIT_ENV });
  const seed = mkdtempSync(join(tmpdir(), "seam-seed-"));
  execFileSync("git", ["init", "--quiet", "-b", "main", seed], { encoding: "utf8", env: GIT_ENV });
  mkdirSync(join(seed, "plan", "tasks.d"), { recursive: true });
  mkdirSync(join(seed, "plan", "feedback"), { recursive: true });
  // W1-T1089: applyPlanProposalCommit's `git add -A -- plan/ MASTER-PLAN.md` fails LOUD (fatal
  // pathspec error) when the file is entirely absent — true of every real triage worktree (a
  // full clone), so this fixture needs one too now that triage's propose-path commit routes
  // through the same shared function `rmd plan` does.
  writeFileSync(join(seed, "MASTER-PLAN.md"), "# MASTER-PLAN\n", "utf8");
  writeFileSync(
    join(seed, "plan", "tasks.yaml"),
    [
      "- id: W1-T4",
      '  title: "a seed task the plan loader accepts"',
      "  repo: remudero",
      "  depends_on: []",
      "  type: implement",
      "  verify: auto",
      "  status: queued",
      "  attempts: 0",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(seed, "plan", "feedback", `${feedbackId}.yaml`),
    [
      `id: ${feedbackId}`,
      "ts: '2026-07-30T00:00:00.000Z'",
      "raw: fixture entry for the deps-seam reachability proof",
      "attachments: []",
      "origin: cli",
      "status: new",
      "proposal_pr: null",
      "",
    ].join("\n"),
  );
  git(seed, "add", "-A");
  git(seed, "commit", "--quiet", "-m", "chore: seed plan");
  git(seed, "remote", "add", "origin", bare);
  git(seed, "push", "--quiet", "origin", "main");
  rmSync(seed, { recursive: true, force: true });
  return bare;
}

/** Sets up HOME/config/repo/gh-shim exactly as the id-mint fixture does, runs `body`, and
 *  returns every ledger line the run wrote. */
async function withOfflineHarness(
  feedbackId: string,
  body: (configRoot: string) => Promise<void>,
): Promise<Array<Record<string, unknown>>> {
  const bare = makeOrigin(feedbackId);
  const home = mkdtempSync(join(tmpdir(), "seam-home-"));
  const configRoot = mkdtempSync(join(tmpdir(), "seam-root-"));
  const shimDir = mkdtempSync(join(tmpdir(), "seam-ghshim-"));
  const savedHome = process.env.HOME;
  const savedPath = process.env.PATH;
  try {
    mkdirSync(join(home, ".config", "remudero"), { recursive: true });
    writeFileSync(
      join(home, ".config", "remudero", "config.json"),
      JSON.stringify({ claudeBin: "/usr/bin/true", root: configRoot, installRoot: REPO_ROOT }, null, 2),
    );
    process.env.HOME = home;

    const originUrl = execFileSync("git", ["-C", REPO_ROOT, "config", "--get", "remote.origin.url"], {
      encoding: "utf8",
    }).trim();
    const repoName = originUrl.match(/[/:]([^/:]+)\/([^/]+?)(?:\.git)?$/)![2];
    const repoDir = join(configRoot, "repos", repoName);
    mkdirSync(dirname(repoDir), { recursive: true });
    execFileSync("git", ["clone", "--quiet", bare, repoDir], { encoding: "utf8", env: GIT_ENV });
    // A REPO-LOCAL identity, inherited by every worktree `triageCommand` adds from this repo.
    // Without it the run dies at its own `git commit` (run-task.ts:8380) before ever reaching
    // the push — that commit runs with the AMBIENT environment, not this fixture's GIT_ENV, so
    // a developer machine with a global user.email passes while a bare CI runner does not.
    // That exact gap made this test pass locally and fail on the runner.
    execFileSync("git", ["-C", repoDir, "config", "user.name", "remudero-test"], { encoding: "utf8" });
    execFileSync("git", ["-C", repoDir, "config", "user.email", "test@remudero.invalid"], { encoding: "utf8" });

    // Every gh subcommand either returns an empty PR list or fails — nothing reaches GitHub.
    writeFileSync(
      join(shimDir, "gh"),
      ["#!/bin/sh", 'case "$*" in', '  *"pr list"*) echo "[]" ;;', "  *) exit 1 ;;", "esac", ""].join("\n"),
      { mode: 0o755 },
    );
    process.env.PATH = `${shimDir}:${savedPath}`;

    await body(configRoot);

    const raw = readFileSync(join(configRoot, "state", "ledger.ndjson"), "utf8");
    return raw.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  } finally {
    process.env.HOME = savedHome;
    process.env.PATH = savedPath;
    for (const d of [bare, home, configRoot, shimDir]) rmSync(d, { recursive: true, force: true });
  }
}

// ── REACHABILITY PROOF 1: triageCommand ──────────────────────────────────────────────
test("SEAM REACHABILITY: an injected spawn carries triageCommand PAST the worker to its post-spawn code", async () => {
  const feedbackId = `fb-seam-triage-${Date.now()}`;
  let spawnCalls = 0;

  const ledger = await withOfflineHarness(feedbackId, async () => {
    await triageCommand([feedbackId], {
      spawn: async () => {
        spawnCalls += 1;
        return fakeWorkerResult("no structured verdict — the run may end inconsistent, which is fine");
      },
    }).catch(() => undefined);
  });

  assert.equal(spawnCalls, 1, "the INJECTED spawn ran — the real spawnWorker was not used");

  // THE PROOF: `log("triage.synthesized", …)` is the first statement after `await spawn`.
  // Its presence on disk means execution continued past the spawn point, which is exactly
  // what no offline test could do before this seam existed.
  const synthesized = ledger.filter((l) => l.step === "triage.synthesized");
  assert.equal(synthesized.length, 1, "the post-spawn ledger line was written — execution got past the spawn");
  assert.equal(synthesized[0].session_id, "SEAM-SESSION-1", "and it carries the INJECTED worker's session id");
  assert.equal(synthesized[0].subtype, "success");
});

// ── REACHABILITY PROOF 2: planCommand ────────────────────────────────────────────────
test("SEAM REACHABILITY: an injected spawn carries planCommand PAST the worker to its post-spawn code", async () => {
  let spawnCalls = 0;

  const ledger = await withOfflineHarness(`fb-seam-plan-${Date.now()}`, async () => {
    await planCommand(["--mode=create", "a", "fixture", "brief", "for", "the", "deps-seam", "reachability", "proof"], {
      spawn: async () => {
        spawnCalls += 1;
        return fakeWorkerResult("no structured plan verdict — reaching this point is the assertion");
      },
    }).catch(() => undefined);
  });

  assert.equal(spawnCalls, 1, "the INJECTED spawn ran — the real spawnWorker was not used");

  const synthesized = ledger.filter((l) => l.step === "plan.synthesized");
  assert.equal(synthesized.length, 1, "the post-spawn ledger line was written — execution got past the spawn");
  assert.equal(synthesized[0].session_id, "SEAM-SESSION-1", "and it carries the INJECTED worker's session id");
});

// ── REACHABILITY PROOF 3: PAST the spawn AND all the way to the push ─────────────────
// Proofs 1 and 2 show execution reaches the first post-spawn statement. This one goes the
// whole distance to the `git push` — the specific line PR #954 could not cover — by making
// the fake spawn behave like a REAL triage worker: it writes a plan/ file into the worktree
// it was handed (`args.cwd`) and returns a `PROPOSED:` verdict, which is what `decideTriage`
// needs to take the propose branch instead of bailing "inconsistent".
//
// The push is REAL and lands in the throwaway bare origin this fixture created — offline,
// no network, no live repo. The REST create (`gh api --method POST repos/.../pulls`,
// W1-T1202) fails on the shim immediately afterwards, which is fine: the push has already
// happened by then, and that is what is being proven.
test("SEAM REACHABILITY: a worker-shaped fake spawn drives triageCommand all the way to its git push", async () => {
  const feedbackId = `fb-seam-push-${Date.now()}`;

  const ledger = await withOfflineHarness(feedbackId, async () => {
    // PR #954 adds a live-write guard that refuses the push this test exists to reach, so the
    // drive is exempted — the push is real but lands in this fixture's throwaway bare origin,
    // never the live repo. The guard's own refusal is proven in
    // test/live-write-guard-leaves.test.ts; exempting here proves REACHABILITY, not absence.
    await withLiveWritesAllowed(() => triageCommand([feedbackId], {
      spawn: async (args: { cwd: string }) => {
        // Behave like the real triage worker: edit a plan file in the run worktree.
        appendFileSync(
          join(args.cwd, "plan", "tasks.yaml"),
          [
            "- id: W1-T99",
            '  title: "seam fixture task filed by the fake worker"',
            "  repo: remudero",
            "  depends_on: []",
            "  type: implement",
            "  verify: auto",
            "  status: queued",
            "  attempts: 0",
            "",
          ].join("\n"),
        );
        return fakeWorkerResult("PROPOSED: file W1-T99 for the deps-seam reachability proof");
      },
    })).catch(() => undefined);
  });

  // Got past the spawn…
  assert.equal(ledger.filter((l) => l.step === "triage.synthesized").length, 1, "reached the post-spawn ledger line");
  // …and did NOT bail at the inconsistent branch, which is what stopped every earlier attempt.
  // …and did NOT bail at the "inconsistent" branch, which is where every earlier attempt
  // stopped. The run now reaches the git push (run-task.ts:8381, measured DA=1) and only
  // then fails at the REST create (`gh api --method POST repos/.../pulls`, W1-T1202),
  // which the shim refuses — so the failure NAMES the step AFTER the push, which is the
  // observable proof the push line executed.
  const errs = ledger.filter((l) => l.step === "triage.error");
  assert.equal(errs.length, 1, "exactly one terminal error");
  assert.match(
    String(errs[0].error),
    /gh api.*pulls/,
    "the run got past the git push and died at the REST create — NOT at the inconsistent branch",
  );
});

test("the real intake publication writes an agent response on its original escalation thread", { timeout: 60_000 }, t => {
  const root = mkdtempSync(join(tmpdir(), "rmd-escalation-real-intake-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const origin = gitRepo({ bare: true, kind: "escalation-intake-origin" }), seed = gitRepo({ seedCommit: false, kind: "escalation-intake-seed" });
  t.after(() => { seed.cleanup(); origin.cleanup(); });
  const stateRoot = join(root, "state-root"), threadStorePath = join(stateRoot, "state", "inbox-threads.jsonl"), feedbackId = "fb-native-intake";
  const identity = { taskId: "W1-T42", class: "MANUAL", cause: "stage-stall", prRef: "15520" }, issueUrl = "https://github.com/craigoley/remudero/issues/16183";
  appendThreadMessage(identity, "escalation", "Which system should I investigate?", { threadStorePath });
  appendThreadReplyOnce(identity, "Investigate Linux.", "real-intake-answer-01", { threadStorePath }, { escalation: { issueUrl, revision: "a".repeat(64), inputVersion: 1 } });
  const entry: FeedbackEntry = { id: feedbackId, ts: "2026-11-02T12:10:00Z", raw: "Investigate Linux.", attachments: [], origin: "ui", status: "new", proposal_pr: null,
    thread_id: deriveThreadId(identity), submission_key: escalationReplySubmissionKey(deriveThreadId(identity), "real-intake-answer-01", issueUrl) };
  mkdirSync(join(seed.dir, "plan", "feedback"), { recursive: true });
  writeFileSync(join(seed.dir, "MASTER-PLAN.md"), "# Fixture master plan\n");
  writeFileSync(join(seed.dir, "plan", "tasks.yaml"), "- id: W1-T4\n  title: Fixture task\n  repo: remudero\n  depends_on: []\n  type: implement\n  verify: auto\n  status: queued\n  attempts: 0\n");
  writeFileSync(join(seed.dir, feedbackEntryRepoPath(feedbackId)), stringify(entry));
  seed.git("add", "-A"); seed.git("commit", "--quiet", "-m", "seed fixture"); seed.addRemote("origin", origin.dir); seed.git("push", "--quiet", "origin", "main");
  const repo = join(stateRoot, "repos", "remudero"); mkdirSync(join(stateRoot, "repos"), { recursive: true });
  execFileSync("git", ["clone", "--quiet", origin.dir, repo]);
  execFileSync("git", ["-C", repo, "config", "user.name", "remudero fixture"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "fixture@remudero.invalid"]);
  const home = join(root, "fixture-home"); mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ root: stateRoot, installRoot: REPO_ROOT, claudeBin: "/usr/bin/true" }));
  const shim = ghShim([
    { when: "pr list", stdout: "[]" }, { when: "issue list", stdout: "[]" },
    { when: "issue create", stdout: "https://github.com/craigoley/remudero/issues/16231" },
    { when: "/issues?", stdout: "[]" },
    { when: "/pulls?state=open", stdout: "HTTP/2.0 200 OK\r\n\r\n[]" },
    { when: "api --method POST", stdout: JSON.stringify({ html_url: "https://github.com/craigoley/remudero/pull/999", number: 999 }) },
    { when: "--json headRefName", stdoutEnv: "FIXTURE_PR_HEAD" }, { when: "--json body", stdout: '{"body":""}' },
    { when: "pr diff", stdout: `diff --git a/plan/feedback/${feedbackId}.yaml b/plan/feedback/${feedbackId}.yaml\n--- a/plan/feedback/${feedbackId}.yaml\n+++ b/plan/feedback/${feedbackId}.yaml\n@@ -1 +1 @@\n-status: new\n+status: grilling\n` },
    { when: "/pulls/999", stdoutEnv: "FIXTURE_PR_INFO" },
    { when: "/check-runs", stdout: JSON.stringify({ total_count: 1, check_runs: [{ id: 1, name: "ci-gate", status: "completed", conclusion: "failure" }] }) },
    { when: "/statuses", stdout: "[]" }, { when: "/status", stdout: '{"statuses":[]}' },
    { when: "/actions/runs", stdout: '{"workflow_runs":[]}' },
    { when: "required_status_checks", stdout: '{"contexts":["ci-gate"],"checks":[]}' },
  ], { kind: "escalation-real-intake" });
  t.after(() => rmSync(shim.dir, { recursive: true, force: true }));
  const code = `
    import {triageCommand} from '#src/run-task.js';
    import {withLiveWritesAllowed} from '#src/lib/live-write-guard.js';
    import {execFileSync} from 'node:child_process';
    let calls=0;
    const fake=(text)=>({sessionId:'fixture',costUsd:0,numTurns:1,text,blocks:[],stderr:'',subtype:'success',isError:false,apiError:false,model:'claude-opus-5',effort:'high',tokens:{input:0,output:0,cacheRead:0,cacheCreation:0},totalCostUsd:0,billingMode:'subscription',verdict:'success',qualitySuspect:false,compactionEvents:[],childEnvKeys:[]});
    try {
      const result=await withLiveWritesAllowed(()=>triageCommand(${JSON.stringify([feedbackId])},{spawn:async(args)=>{
        calls++;
        const branch=execFileSync('git',['-C',args.cwd,'symbolic-ref','--short','HEAD'],{encoding:'utf8'}).trim();
        process.env.FIXTURE_PR_HEAD=JSON.stringify({headRefName:branch});
        process.env.FIXTURE_PR_INFO=JSON.stringify({number:999,state:'open',title:'Fixture intake',body:'',head:{sha:'f'.repeat(40),ref:branch},base:{sha:'e'.repeat(40),ref:'main'},mergeable:true,mergeable_state:'clean'});
        return fake((args.tools??[]).length===0?JSON.stringify({headline:'Choose a Linux version',what_happened:'The agent needs a version to compare.',decision:'Which Linux version?',options:[{label:'Ubuntu',consequence:'Compare Ubuntu.'},{label:'Debian',consequence:'Compare Debian.'}]}):'GROUND: the system version is not specified.\\nOPTION: Ubuntu|Compare Ubuntu.\\nOPTION: Debian|Compare Debian.\\nRECOMMENDATION: Ubuntu\\nAMBIGUOUS: Which Linux version should I compare?');
      }}));
      console.log('FIXTURE_RESULT '+JSON.stringify({result,calls}));
    } catch(error) {console.log('FIXTURE_RESULT '+JSON.stringify({error:String(error),calls}));}
  `;
  const output = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { cwd: REPO_ROOT, encoding: "utf8", timeout: 45_000,
    env: { PATH: `${shim.dir}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, TMPDIR: root, GH_TOKEN: "offline-fixture-only", NODE_TEST_CONTEXT: "fixture", RMD_GH_CACHE_HOME: join(root, "gh-cache"), RMD_GH_SHARED_READ_GAP_MS: "0",
      GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", ...(process.env.NODE_V8_COVERAGE ? { NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE } : {}) } });
  const result = readThread(entry.thread_id!, { threadStorePath }); assert.equal(result.status, "ok"); assert.ok(result.status === "ok");
  const response = result.messages.find(message => message.extra?.intake?.feedbackId === feedbackId);
  assert.ok(response, `${output}\nFixture GH calls:\n${shim.calls().join("\n").slice(-12000)}`); assert.equal(response.threadId, entry.thread_id); assert.equal(response.extra?.question, true);
  assert.match(response.body, /Which Linux version/);
  const ledger = readFileSync(join(stateRoot, "state", "ledger.ndjson"), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
  assert.ok(ledger.some(row => row.step === "pr.opened"));
  assert.ok(ledger.some(row => row.step === "triage.escalation_response" && row.state === "recorded"));
});
