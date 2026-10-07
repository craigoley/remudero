import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  completeTriageHandoff,
  listTriageHandoffs,
  recoverTriageHandoffs,
  triageClaimRef,
  triageHandoffPath,
  triageLockPath,
  writeTriageHandoff,
  type TriageClaimReserverAsync,
  type TriageHandoffDeps,
  type TriageHandoffRecord,
} from "../src/lib/auto-triage.js";
import { triageCommand } from "../src/run-task.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import type { WorkerResult } from "../src/lib/worker.js";

// ── WHAT THIS FILE PROVES (W1-T6117) ─────────────────────────────────────────────────────────
// OBSERVED: triage pushed its branch and opened core PR #5494, then its holder PID vanished before
// `pr.opened` / `run.awaiting_external` were ledgered; state/triage.lock stayed wedged. The fix is a
// WRITE-AHEAD handoff record (state/triage-handoff/<feedback>.json) written before the push and
// upgraded when the create returns; the next triage start — which reclaims a dead lock — finishes
// the ledger steps by looking the PR up BY BRANCH, and keeps the remote claim while CI is pending.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const PR_URL = "https://github.com/craigoley/remudero/pull/998";

function tmp(p: string): string {
  return mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}${p}`));
}

/** A pid that provably does not exist: a child that has already exited and been reaped. */
function deadPid(): number {
  const r = spawnSync(process.execPath, ["-e", "0"]);
  assert.ok(r.pid && r.status === 0);
  return r.pid;
}

function plantDeadLock(root: string): number {
  const pid = deadPid();
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(triageLockPath(root), JSON.stringify({ pid, host: hostname(), startedAt: new Date(Date.now() - 3_600_000).toISOString() }));
  return pid;
}

function readLedger(root: string): Array<Record<string, unknown>> {
  const f = join(root, "state", "ledger.ndjson");
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
}

function record(over: Partial<TriageHandoffRecord> = {}): TriageHandoffRecord {
  return {
    runId: "TRIAGE-fb-1-100",
    taskId: "TRIAGE-fb-1",
    feedbackId: "fb-1",
    branch: "run-TRIAGE-fb-1-100",
    action: "propose",
    pid: 4242,
    host: hostname(),
    writtenAt: "2026-10-07T00:00:00.000Z",
    state: "pr_created",
    prUrl: PR_URL,
    prNumber: 998,
    ...over,
  };
}

/** An in-memory origin ref store: create-if-absent, drop honours `expect`. */
function fakeClaims(held: string[]): { refs: Map<string, string>; reserver: TriageClaimReserverAsync } {
  const refs = new Map<string, string>(held.map((id) => [triageClaimRef(id), "anchor-" + id]));
  return {
    refs,
    reserver: {
      mintAnchor: () => "anchor-new",
      attempt: (id, a) => (refs.has(triageClaimRef(id)) ? "taken" : (refs.set(triageClaimRef(id), a), "created")),
      holder: (id) => refs.get(triageClaimRef(id)),
      drop: (id, o = {}) => (o.expect !== undefined && refs.get(triageClaimRef(id)) !== o.expect ? false : refs.delete(triageClaimRef(id))),
    },
  };
}

function unitDeps(rows: Array<Record<string, unknown>>, over: Partial<TriageHandoffDeps> = {}): TriageHandoffDeps {
  return {
    findOpenPr: () => ({ prUrl: PR_URL, prNumber: 998 }),
    recordedSteps: (runId) => new Set(rows.filter((r) => r.run_id === runId).map((r) => String(r.step))),
    log: (rec, step, extra = {}) => rows.push({ run_id: rec.runId, task_id: rec.taskId, step, ...extra }),
    awaitingStep: "run.awaiting_external",
    ...over,
  };
}

// ── THE ACCEPTANCE PROOF: a real interruption, then two concurrent restarts ───────────────────

function makeOrigin(feedbackId: string): string {
  const bare = tmp("t6117-origin-");
  const seed = tmp("t6117-seed-");
  execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", bare], { encoding: "utf8", env: GIT_ENV });
  execFileSync("git", ["init", "--quiet", "-b", "main", seed], { encoding: "utf8", env: GIT_ENV });
  mkdirSync(join(seed, "plan", "tasks.d"), { recursive: true });
  mkdirSync(join(seed, "plan", "feedback"), { recursive: true });
  writeFileSync(join(seed, "MASTER-PLAN.md"), "# MASTER-PLAN\n", "utf8");
  writeFileSync(join(seed, "plan", "alert-policy.yaml"), "act_severities: []\n", "utf8");
  writeFileSync(
    join(seed, "plan", "tasks.yaml"),
    ["- id: W1-T4", '  title: "a seed task the plan loader accepts"', "  repo: remudero", "  depends_on: []", "  type: implement", "  verify: auto", "  status: queued", "  attempts: 0", ""].join("\n"),
  );
  writeFileSync(
    join(seed, "plan", "feedback", `${feedbackId}.yaml`),
    [`id: ${feedbackId}`, "ts: '2026-08-17T00:00:00.000Z'", "raw: fixture entry for the W1-T6117 handoff", "attachments: []", "origin: cli", "status: new", "proposal_pr: null", ""].join("\n"),
  );
  execFileSync("git", ["-C", seed, "add", "-A"], { encoding: "utf8" });
  execFileSync("git", ["-C", seed, "commit", "--quiet", "-m", "chore: seed plan"], { encoding: "utf8", env: GIT_ENV });
  execFileSync("git", ["-C", seed, "remote", "add", "origin", bare], { encoding: "utf8" });
  execFileSync("git", ["-C", seed, "push", "--quiet", "origin", "main"], { encoding: "utf8", env: GIT_ENV });
  rmSync(seed, { recursive: true, force: true });
  return bare;
}

function fakeWorker(text: string): WorkerResult {
  return {
    sessionId: "T6117-SESSION",
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
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    totalCostUsd: 0,
    billingMode: "subscription",
    verdict: "success",
    qualitySuspect: false,
    compactionEvents: [],
    childEnvKeys: [],
  } as unknown as WorkerResult;
}

test("two concurrent restarts after a holder died right after remote PR creation recover once, open no second PR, keep the claim", async () => {
  const feedbackId = `fb-t6117-${Date.now()}`;
  const bare = makeOrigin(feedbackId);
  const home = tmp("t6117-home-");
  const configRoot = tmp("t6117-root-");
  const shimDir = tmp("t6117-ghshim-");
  const argvLog = join(shimDir, "argv.txt");
  const savedHome = process.env.HOME;
  const savedPath = process.env.PATH;
  try {
    mkdirSync(join(home, ".config", "remudero"), { recursive: true });
    writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/usr/bin/true", root: configRoot, installRoot: REPO_ROOT }, null, 2));
    process.env.HOME = home;
    const originUrl = execFileSync("git", ["-C", REPO_ROOT, "config", "--get", "remote.origin.url"], { encoding: "utf8" }).trim();
    const repoName = originUrl.match(/[/:]([^/:]+)\/([^/]+?)(?:\.git)?$/)![2];
    const repoDir = join(configRoot, "repos", repoName);
    mkdirSync(dirname(repoDir), { recursive: true });
    execFileSync("git", ["clone", "--quiet", bare, repoDir], { encoding: "utf8", env: GIT_ENV });
    execFileSync("git", ["-C", repoDir, "config", "user.name", "remudero-test"], { encoding: "utf8" });
    execFileSync("git", ["-C", repoDir, "config", "user.email", "test@remudero.invalid"], { encoding: "utf8" });

    // `fail-diff` is the INTERRUPTION: the first run reaches `gh pr diff` only AFTER the PR exists,
    // and dies there — between PR creation and every ledger step that names the PR. `open-pr` is
    // GitHub's answer to "which open PR has this head?" once a restart asks.
    writeFileSync(
      join(shimDir, "gh"),
      [
        "#!/bin/sh",
        `printf '%s\\n' "$*" >> ${JSON.stringify(argvLog)}`,
        'case "$*" in',
        '  *"pr list"*) echo "[]" ;;',
        `  *"pulls?head="*) if [ -f ${JSON.stringify(join(shimDir, "open-pr"))} ]; then echo '[{"html_url":"${PR_URL}","number":998}]'; else echo '[]'; fi ;;`,
        `  *"api --method POST"*) echo '{"html_url":"${PR_URL}","number":998}' ;;`,
        `  *"--json headRefName"*) git -C ${JSON.stringify(bare)} for-each-ref --format='{"headRefName":"%(refname:short)"}' refs/heads/run-* | tail -1 ;;`,
        "  *\"--json body\"*) echo '{\"body\":\"\"}' ;;",
        `  *"pr diff"*) if [ -f ${JSON.stringify(join(shimDir, "fail-diff"))} ]; then echo 'interrupted' >&2; exit 1; fi; echo "" ;;`,
        "  *) exit 0 ;;",
        "esac",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    process.env.PATH = `${shimDir}:${savedPath}`;
    writeFileSync(join(shimDir, "fail-diff"), "");

    const worker = [
      "GROUND: grepped plan/feedback and MASTER-PLAN.md — this exact alert class is already dispositioned.",
      "ALREADY_DECIDED: plan/alert-policy.yaml act_severities — this class is already rejected, no task needed",
    ].join("\n");

    // ── RUN 1: dies after the PR exists ──
    let died: unknown;
    await withLiveWritesAllowed(() => triageCommand([feedbackId], { spawn: async () => fakeWorker(worker) })).catch((e) => (died = e));
    assert.ok(died, "the interrupted run threw after creating the PR");
    const handoffs = listTriageHandoffs(configRoot).records;
    assert.equal(handoffs.length, 1, "the write-ahead record survived the interruption");
    assert.equal(handoffs[0].state, "pr_created");
    assert.equal(handoffs[0].prUrl, PR_URL, "and it already names the PR the create returned");
    const runId = handoffs[0].runId;
    const rowsFor = (step: string) => readLedger(configRoot).filter((r) => r.step === step && r.run_id === runId);
    assert.equal(rowsFor("pr.opened").length, 0, "the interruption left the PR unledgered — the defect");
    assert.equal(rowsFor("run.awaiting_external").length, 0);

    // ── the holder's lock is left behind, its pid provably absent ──
    const gone = plantDeadLock(configRoot);
    rmSync(join(shimDir, "fail-diff"));
    writeFileSync(join(shimDir, "open-pr"), "");

    // ── TWO CONCURRENT RESTARTS ──
    let spawned = 0;
    // The dead lane's remote claim, still on origin: the PR is awaiting CI, so it must survive.
    const claims = fakeClaims([feedbackId]);
    const restart = () =>
      withLiveWritesAllowed(() =>
        triageCommand([feedbackId], {
          handoff: { claimReserver: claims.reserver, mergedSubjects: () => [] },
          spawn: async () => {
            spawned += 1;
            return fakeWorker(worker);
          },
        }),
      );
    const codes = (await Promise.all([restart(), restart()])).sort();
    assert.deepEqual(codes, [0, 2], "exactly one restart took the lock and recovered; the other was refused");
    assert.equal(spawned, 0, "no new Architect lane was started for an entry that already has its PR");

    const reclaimed = readLedger(configRoot).filter((r) => r.step === "triage.lock_reclaimed");
    assert.equal(reclaimed.length, 1, "exactly ONE local-lock recovery");
    assert.equal(reclaimed[0].prior_pid, gone);
    assert.equal(reclaimed[0].pid_absent, true);
    assert.equal(rowsFor("pr.opened").length, 1, "pr.opened recorded exactly once");
    assert.equal(rowsFor("pr.opened")[0].pr_url, PR_URL);
    assert.equal(rowsFor("pr.opened")[0].recovered, true);
    assert.equal(rowsFor("run.awaiting_external").length, 1, "run.awaiting_external recorded exactly once");
    assert.equal(listTriageHandoffs(configRoot).records.length, 0, "the handoff is complete");
    assert.equal(existsSync(triageLockPath(configRoot)), false, "and the local lock was released");
    const creates = readFileSync(argvLog, "utf8").split("\n").filter((l) => l.includes("api --method POST"));
    assert.equal(creates.length, 1, "NO second PR was opened — the restart looked the PR up by branch");
    assert.equal(claims.refs.has(triageClaimRef(feedbackId)), true, "the remote claim is RETAINED while the PR awaits CI");
    assert.equal(readLedger(configRoot).filter((r) => r.step === "triage.claim_retained" && r.run_id === runId).length, 1);

    // ── a recoverer killed after the ledger writes but before deleting the record is simply re-run ──
    writeTriageHandoff(configRoot, handoffs[0]);
    assert.equal(await withLiveWritesAllowed(() => triageCommand([feedbackId], { spawn: async () => fakeWorker(worker) })), 0);
    assert.equal(rowsFor("pr.opened").length, 1, "idempotent: no duplicate pr.opened");
    assert.equal(rowsFor("run.awaiting_external").length, 1, "idempotent: no duplicate run.awaiting_external");
    assert.equal(listTriageHandoffs(configRoot).records.length, 0);
  } finally {
    process.env.HOME = savedHome;
    process.env.PATH = savedPath;
    for (const d of [bare, home, configRoot, shimDir]) rmSync(d, { recursive: true, force: true });
  }
});

// ── THE REMOTE CLAIM ──────────────────────────────────────────────────────────────────────────

test("recovery keeps the remote claim while the PR awaits CI, and releases it only on the evidence arm", async () => {
  const root = tmp("t6117-claim-");
  try {
    for (const merged of [false, true]) {
      const { refs, reserver } = fakeClaims(["fb-1"]);
      const rows: Array<Record<string, unknown>> = [];
      writeTriageHandoff(root, record());
      const out = await recoverTriageHandoffs(root, unitDeps(rows, { claimReserver: reserver, mergedSubjects: () => (merged ? ["chore(triage): feedback#fb-1 (#9)"] : []) }));
      assert.equal(out[0].outcome, "recovered");
      assert.equal(refs.has(triageClaimRef("fb-1")), !merged, merged ? "a merged outcome releases the claim" : "a pending PR keeps the claim");
      const verdicts = rows.filter((r) => r.step === "triage.claim_released" || r.step === "triage.claim_retained");
      assert.equal(verdicts.length, 1);
      assert.equal(verdicts[0].step, merged ? "triage.claim_released" : "triage.claim_retained");
      assert.equal(verdicts[0].arm, merged ? "evidence" : "operator", "decideTriageClaimRelease decided, not the recoverer");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── THE OTHER ARMS ────────────────────────────────────────────────────────────────────────────

test("a lookup that FAILS is not read as 'no PR': the record stays and nothing is ledgered as opened", async () => {
  const root = tmp("t6117-lookup-");
  try {
    const rows: Array<Record<string, unknown>> = [];
    writeTriageHandoff(root, record({ state: "pending", prUrl: undefined, prNumber: undefined }));
    const out = await recoverTriageHandoffs(
      root,
      unitDeps(rows, {
        findOpenPr: () => {
          throw new Error("gh: HTTP 502");
        },
      }),
    );
    assert.equal(out[0].outcome, "unresolved");
    assert.equal(existsSync(triageHandoffPath(root, "fb-1")), true, "kept for the next start");
    assert.equal(rows.filter((r) => r.step === "pr.opened").length, 0);
    assert.match(String(rows[0].reason), /HTTP 502/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a record written before the create, whose branch never got a PR, is abandoned — and nothing is opened", async () => {
  const root = tmp("t6117-nopr-");
  try {
    const rows: Array<Record<string, unknown>> = [];
    writeTriageHandoff(root, record({ state: "pending", prUrl: undefined, prNumber: undefined }));
    const out = await recoverTriageHandoffs(root, unitDeps(rows, { findOpenPr: () => undefined }));
    assert.equal(out[0].outcome, "no_pr");
    assert.deepEqual(
      rows.map((r) => r.step),
      ["triage.handoff_abandoned"],
    );
    assert.equal(listTriageHandoffs(root).records.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a recovered PR that touches non-plan files is not ledgered as opened plan-only", async () => {
  const root = tmp("t6117-stray-");
  try {
    const rows: Array<Record<string, unknown>> = [];
    writeTriageHandoff(root, record());
    const out = await recoverTriageHandoffs(root, unitDeps(rows, { strayFiles: () => ["src/x.ts"] }));
    assert.equal(out[0].outcome, "stray");
    assert.equal(rows.filter((r) => r.step === "pr.opened").length, 0);
    assert.deepEqual(rows[0].stray_files, ["src/x.ts"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unreadable diff records pr.opened without claiming plan_only, and a record from another host is left alone", async () => {
  const root = tmp("t6117-hosts-");
  try {
    const rows: Array<Record<string, unknown>> = [];
    writeTriageHandoff(root, record());
    writeTriageHandoff(root, record({ feedbackId: "fb-2", runId: "TRIAGE-fb-2-1", taskId: "TRIAGE-fb-2", host: "some-other-host" }));
    const out = await recoverTriageHandoffs(root, unitDeps(rows, { strayFiles: () => undefined }));
    assert.deepEqual(out.map((o) => o.outcome), ["recovered", "foreign_host"]);
    assert.equal(rows.find((r) => r.step === "pr.opened")!.plan_only, null);
    assert.equal(existsSync(triageHandoffPath(root, "fb-2")), true);
    completeTriageHandoff(root, "fb-2");
    completeTriageHandoff(root, "fb-2"); // idempotent
    assert.equal(listTriageHandoffs(root).records.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
