import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import {
  bootSweepDispatchClaims, dispatchClaimRef, gitDispatchClaimReserver,
  type DispatchClaimReserver, type GitAnswer,
} from "#src/lib/dispatch-claim.js";
import { appendLedger } from "#src/lib/ledger.js";
import { makeTempDir } from "#src/lib/tmp.js";
import { gitRepo, GIT_REPO_FIXTURE_IDENTITY } from "#test/helpers/git-repo.js";

export const TASK = "W1-T10838";
export const RUN_ID = `${TASK}-946684799000`;
export const BRANCH = `run-${RUN_ID}`;
export const HEAD = `4cefc7ba3${"0".repeat(31)}`;
/** Minted long before any namespace this test can run in booted. */
export const MINT_ISO = "2000-01-01T00:00:00.000Z";
/** No Linux pid reaches this (pid_max is at most 2^22). */
export const DEAD_PID = 2_147_483_646;
export const LOCAL = hostname();
export const OTHER_HOST = "0123456789ab";

export function anchorMessage(pid: number, host: string, iso: string): string {
  return `rmd-dispatch claim ${pid}@${host} ${iso}`;
}

/** The orphaned run's own rows: its start, the claim it minted, and the work it finished. */
export function orphanRunRows(taskId = TASK, runId = RUN_ID, host = LOCAL): Array<Record<string, unknown>> {
  return [
    { ts: "1999-12-31T23:59:59.000Z", run_id: runId, task_id: taskId, step: "run.start", host },
    { ts: "2000-01-01T00:00:00.500Z", run_id: runId, task_id: taskId, step: "dispatch.claim", host, actor: "run_child",
      ref: dispatchClaimRef(taskId), outcome: "created" },
    { ts: "2000-01-01T00:30:00.000Z", run_id: runId, task_id: taskId, step: "implement.done", host },
  ];
}

export function fakeReserver(
  claims: Record<string, string>,
  opts: { keepOnDrop?: boolean; heads?: Record<string, string> } = {},
): DispatchClaimReserver & { dropped: string[]; askedHeads: string[] } {
  const dropped: string[] = [];
  const askedHeads: string[] = [];
  return {
    dropped,
    askedHeads,
    mintAnchor: () => "anchor",
    attempt: () => "taken",
    holder: (taskId) => (claims[taskId] !== undefined ? `sha-${taskId}` : undefined),
    drop: (taskId) => {
      dropped.push(taskId);
      if (!opts.keepOnDrop) delete claims[taskId];
      return true;
    },
    anchorMessage: (taskId) => claims[taskId],
    list: () => Object.keys(claims),
    branchHead: (branch) => {
      askedHeads.push(branch);
      return opts.heads?.[branch];
    },
  };
}

interface Instance {
  stateDir: string;
  boot: (reserver: DispatchClaimReserver) => void;
  rawLines: () => string[];
  rows: () => Array<Record<string, unknown>>;
}

/** One instance's state directory, booted the way `rmd daemon` boots: its log stamps the daemon's run id and
 *  lets a row's own `run_id`/`task_id` override them. */
export function instance(t: TestContext, seed: Array<Record<string, unknown>>): Instance {
  const stateDir = makeTempDir("restart-orphan");
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const ledger = join(stateDir, "ledger.ndjson");
  writeFileSync(ledger, seed.map((row) => `${JSON.stringify(row)}\n`).join(""));
  const rawLines = () => readFileSync(ledger, "utf8").split("\n").filter(Boolean);
  let boots = 0;
  return {
    stateDir,
    rawLines,
    rows: () => rawLines().map((line) => JSON.parse(line) as Record<string, unknown>),
    boot: (reserver) => {
      const runId = `DAEMON-${++boots}`;
      const lockIso = new Date().toISOString();
      bootSweepDispatchClaims(reserver, {
        localHost: LOCAL,
        lockHeldSinceMs: Date.parse(lockIso),
        lockHeldSinceIso: lockIso,
        stateDir,
        log: (step, fields) => appendLedger(ledger, { run_id: runId, task_id: "DAEMON", step, lane: "daemon", ...fields }),
      });
    },
  };
}

/** A real bare remote holding the orphan's claim and its pushed run branch, read through the real git reserver. */
export function gitRemote(t: TestContext): { reserver: DispatchClaimReserver; head: string; claimTip: () => string } {
  const remote = gitRepo({ bare: true, scope: t });
  const client = gitRepo({ scope: t });
  client.addRemote("origin", remote.dir);
  const tree = client.git("rev-parse", "HEAD^{tree}");
  const anchor = client.git("commit-tree", tree, "-m", anchorMessage(DEAD_PID, LOCAL, MINT_ISO));
  client.git("push", "origin", `${anchor}:${dispatchClaimRef(TASK)}`);
  const head = client.git("commit-tree", tree, "-p", "HEAD", "-m", "the orphan's finished work");
  client.git("push", "origin", `${head}:refs/heads/${BRANCH}`);
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: GIT_REPO_FIXTURE_IDENTITY.name, GIT_COMMITTER_NAME: GIT_REPO_FIXTURE_IDENTITY.name,
    GIT_AUTHOR_EMAIL: GIT_REPO_FIXTURE_IDENTITY.email, GIT_COMMITTER_EMAIL: GIT_REPO_FIXTURE_IDENTITY.email,
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
  };
  const run = (args: string[]): GitAnswer => {
    const r = spawnSync("git", args, { cwd: client.dir, env, encoding: "utf8", timeout: 10_000 });
    return { status: r.status ?? 128, stdout: r.stdout, stderr: r.stderr };
  };
  return { reserver: gitDispatchClaimReserver({ run }), head, claimTip: () => client.git("ls-remote", "origin", dispatchClaimRef(TASK)) };
}

export const sweepRows = (rows: Array<Record<string, unknown>>) =>
  rows.filter((r) => r.step === "dispatch.claim_released" && r.surface === "boot-sweep");
export const orphanVerdicts = (rows: Array<Record<string, unknown>>) =>
  rows.filter((r) => r.step === "verdict" && r.reason === "orphaned-by-restart");

