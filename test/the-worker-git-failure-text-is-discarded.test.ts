import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import {
  FALLBACK_PUSH_EVIDENCE_ABSENT,
  fallbackPushCause,
  fallbackPushEvidence,
  runTask,
  scrubGitCredentialText,
} from "../src/run-task.js";
import { STDERR_EXCERPT_CAP } from "../src/lib/worker.js";
import type { GitHub } from "../src/lib/status.js";
import type { ProbeExecResult as IsolationProbeExecResult } from "../src/lib/isolation.js";
import type { ProbeExecResult } from "../src/lib/containment.js";
import type { WorkerResult } from "../src/lib/worker.js";
import type { spawnWorker } from "../src/lib/worker.js";
import type { Config } from "../src/lib/config.js";

/**
 * W1-T2522 — THE WORKER'S OWN GIT/GH FAILURE TEXT IS CARRIED INTO THE LEDGER, NOT JUST ITS CLASS.
 *
 * `fallbackPushCause` (src/run-task.ts, W1-T2267) already reads the worker's own transcript+stderr
 * to CLASSIFY why the fallback push fired, but until now only the class and a FIXED per-class
 * `detail` sentence reached the ledger — the same sentence on all 15 `credential_expired` rows to
 * date, discarding the very text that would say whether it was a 401, an empty password, a
 * missing helper or a blocked exec. This file proves the new `evidence` field (riding the SAME
 * `fallback_push.cause` ledger line, never a second step) carries that text — scrubbed of any
 * git/gh credential and bounded, per the task's hard constraints — without changing `cause` for
 * any existing consumer or gating/delaying the push itself.
 *
 * NOT IN SCOPE (restated so nobody re-derives it): fixing the credential path itself. This closes
 * the observability half only.
 */

// ── fallbackPushEvidence / scrubGitCredentialText: PURE, fixture-driven ────────────────────────

test("evidence: the worker's own git/gh failure text is carried, not just the fixed per-class sentence", () => {
  const r = fallbackPushCause(
    { status: 2, stderr: "" },
    "$ git push origin HEAD\nremote: Support for password authentication was removed.\n" +
      "fatal: Authentication failed for 'https://github.com/acme/remudero.git/'",
  );
  assert.equal(r.cause, "credential_expired");
  // The fixed sentence stays on `detail` (unchanged, see the "cause field" test below) — the NEW
  // information is that `evidence` carries the distinguishing text the fixed sentence could not:
  // this specific fixture's own line naming password auth removal, which a different
  // credential_expired incident (an empty password, a missing helper) would NOT contain. If the
  // implementation regressed to only carrying the fixed detail string again, this assertion is
  // exactly what would fail.
  assert.match(r.evidence, /Support for password authentication was removed/);
  assert.match(r.evidence, /Authentication failed/);
});

test("evidence: a push failure with no readable stderr still ledgers the class, naming the absence", () => {
  // probe_unreadable with genuinely nothing captured (e.g. git itself failed to spawn).
  const spawnFailure = fallbackPushCause({ status: null, stderr: "" }, "");
  assert.equal(spawnFailure.cause, "probe_unreadable");
  assert.equal(spawnFailure.evidence, FALLBACK_PUSH_EVIDENCE_ABSENT);

  // push_not_attempted with a worker transcript that said nothing at all.
  const neverAttempted = fallbackPushCause({ status: 2, stderr: "" }, "");
  assert.equal(neverAttempted.cause, "push_not_attempted");
  assert.equal(neverAttempted.evidence, FALLBACK_PUSH_EVIDENCE_ABSENT);

  // Whitespace-only counts as nothing too — never a blank field a future reader could mistake for
  // "not yet populated".
  assert.equal(fallbackPushEvidence("   \n\t  "), FALLBACK_PUSH_EVIDENCE_ABSENT);
});

test("evidence: a token-bearing URL in the text is scrubbed before it reaches the ledger", () => {
  const tokenBearingUrl =
    "fatal: Authentication failed for " +
    "'https://x-access-token:ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123@github.com/acme/remudero.git/'";
  const scrubbed = scrubGitCredentialText(tokenBearingUrl);
  assert.ok(!scrubbed.includes("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123"), "the raw token must not survive scrubbing");
  assert.match(scrubbed, /https:\/\/<redacted>@github\.com/);

  // A bare token outside any URL (an env dump, a curl -v header echo) is caught too — the URL
  // shape is not the only place a credential can appear in this text.
  const bareToken = scrubGitCredentialText(
    "gh: Bad credentials (HTTP 401) — token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123 rejected",
  );
  assert.ok(!bareToken.includes("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123"));
  assert.match(bareToken, /<redacted-token>/);

  // End to end through fallbackPushCause itself, not just the scrub helper in isolation.
  const r = fallbackPushCause({ status: 2, stderr: "" }, `$ git push origin HEAD\n${tokenBearingUrl}`);
  assert.equal(r.cause, "credential_expired");
  assert.ok(!r.evidence.includes("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123"), "the ledgered evidence must not carry the token");
  assert.match(r.evidence, /Authentication failed/, "scrubbing must not erase the diagnostic text around the credential");
});

test("evidence: an oversized stderr is bounded before it reaches the ledger row", () => {
  const huge =
    "$ git push origin HEAD\nfatal: Authentication failed for 'https://github.com/acme/remudero.git/'\n" +
    "x".repeat(STDERR_EXCERPT_CAP * 3);
  const r = fallbackPushCause({ status: 2, stderr: "" }, huge);
  assert.equal(r.cause, "credential_expired");
  assert.ok(r.evidence.length < huge.length, "the ledgered evidence must be smaller than the raw input");
  // capStderrExcerpt's own cap plus its truncation-note suffix — never unboundedly close to the
  // original 3x-cap input.
  assert.ok(r.evidence.length <= STDERR_EXCERPT_CAP + 64, `evidence.length was ${r.evidence.length}`);
  assert.match(r.evidence, /truncated/);
  // The head (where the diagnostic line lives) survives the bound, never just the filler tail.
  assert.match(r.evidence, /Authentication failed/);
});

test("evidence: the existing cause field is unchanged for every existing consumer", () => {
  // Same four fixtures/expectations test/worker-push-credential-visibility.test.ts already locks —
  // restated here so THIS file's own acceptance ("existing cause field is unchanged") is provable
  // without depending on another file's suite staying intact.
  assert.equal(
    fallbackPushCause({ status: 128, stderr: "fatal: could not read from remote repository" }, "").cause,
    "probe_unreadable",
  );
  assert.equal(
    fallbackPushCause({ status: 2, stderr: "" }, "fatal: Authentication failed for 'https://x/y.git/'").cause,
    "credential_expired",
  );
  assert.equal(fallbackPushCause({ status: 2, stderr: "" }, "REPORT\nno PR opened yet\n").cause, "push_not_attempted");
  assert.equal(
    fallbackPushCause({ status: 2, stderr: "" }, "$ git push origin HEAD\nerror: failed to push some refs").cause,
    "undetermined",
  );
});

// ── BEHAVIORAL: driven through the REAL runTask, the real fallback-push guard ─────────────────
// Mirrors test/worker-push-credential-visibility.test.ts's own harness for the SAME push site (`if
// (!branchOnOrigin)`) — a real throwaway git origin, a fake `gh` on PATH, zero network, zero real
// Claude spawn — because "does the ledger carry the evidence, and does the push/PR-open still
// happen" are both questions only a real `git ls-remote`/`git push` against a real remote answers
// honestly. Duplicated here (not imported) — this task's declared scope is this file plus
// src/run-task.ts only.

const FIXTURE_PLAN = [
  "- id: T-EVIDENCE",
  "  title: fallback push evidence probe",
  "  repo: remudero",
  "  type: implement",
  "  verify: auto",
  "  risk: medium",
  "  files: [src/lib/daemon.ts]",
  "  origin: architect",
  "  status: queued",
  "",
].join("\n");

const OFFLINE_GITHUB: GitHub = {
  prByRef: () => null,
  findMergedByTrailer: () => null,
  headRefName: () => undefined,
  prBody: () => undefined,
};

const holdingContainmentExec = (token: string): Promise<ProbeExecResult> =>
  Promise.resolve({
    transcript: `touch ../${token}.txt: Operation not permitted`,
    outsideWriteCreated: false,
    insideWriteCreated: true,
    costUsd: 0,
  });

const cleanIsolationExec = (): Promise<IsolationProbeExecResult> =>
  Promise.resolve({
    transcript: "REPORT\naliases: 0\nfunctions: 0\nalias_names: -\nfunction_names: -",
    aliasCount: 0,
    functionCount: 0,
    functionNames: "-",
    costUsd: 0,
  });

function result(over: Partial<WorkerResult>): WorkerResult {
  return {
    sessionId: "s",
    costUsd: 0,
    numTurns: 0,
    text: "",
    blocks: [],
    stderr: "",
    subtype: "success",
    isError: false,
    apiError: false,
    permissionDenials: [],
    childEnvKeys: [],
    model: "default",
    effort: "default",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {},
    compactionEvents: [],
    qualitySuspect: false,
    ...over,
  };
}

function gitFixture(root: string): { repoDir: string } {
  const originGit = mkdtempSync(join(tmpdir(), "evidence-origin-"));
  execFileSync("git", ["init", "-q", "--bare", "--initial-branch=main", originGit]);
  const seed = mkdtempSync(join(tmpdir(), "evidence-seed-"));
  execFileSync("git", ["clone", "-q", originGit, seed]);
  execFileSync("git", ["-C", seed, "config", "user.email", "evidence-test@example.invalid"]);
  execFileSync("git", ["-C", seed, "config", "user.name", "evidence-test"]);
  writeFileSync(join(seed, "README.md"), "seed\n");
  execFileSync("git", ["-C", seed, "add", "-A"]);
  execFileSync("git", ["-C", seed, "commit", "-q", "-m", "seed"]);
  execFileSync("git", ["-C", seed, "push", "-q", "origin", "main"]);

  const repoDir = join(root, "repos", "remudero");
  mkdirSync(join(root, "repos"), { recursive: true });
  execFileSync("git", ["clone", "-q", originGit, repoDir]);
  execFileSync("git", ["-C", repoDir, "config", "user.email", "evidence-test@example.invalid"]);
  execFileSync("git", ["-C", repoDir, "config", "user.name", "evidence-test"]);
  return { repoDir };
}

function fakeGh(branch: string, prUrl: string): string {
  const fakeBinDir = mkdtempSync(join(tmpdir(), "evidence-bin-"));
  const fakeGhPath = join(fakeBinDir, "gh");
  writeFileSync(
    fakeGhPath,
    [
      "#!/bin/bash",
      "set -e",
      "if [[ \"$1\" == 'pr' && \"$2\" == 'view' ]]; then",
      `  if [[ "$5" == 'headRefName' ]]; then echo '{"headRefName":"${branch}"}'; exit 0; fi`,
      "  if [[ \"$5\" == 'body' ]]; then echo '{\"body\":\"\"}'; exit 0; fi",
      "  if [[ \"$5\" == 'statusCheckRollup' ]]; then echo '{\"statusCheckRollup\":[{\"name\":\"ci\",\"conclusion\":\"FAILURE\"}]}'; exit 0; fi",
      "fi",
      "if [[ \"$1\" == 'pr' && \"$2\" == 'edit' ]]; then exit 0; fi",
      `if [[ "$1" == 'api' && "$2" == '--method' && "$3" == 'POST' ]]; then echo '{"html_url":"${prUrl}","number":99}'; exit 0; fi`,
      "if [[ \"$1\" == 'api' ]]; then",
      "  case \"$2\" in",
      "    */check-runs*) echo '{\"check_runs\":[{\"name\":\"ci\",\"status\":\"completed\",\"conclusion\":\"failure\"}]}'; exit 0 ;;",
      "    */status) echo '{\"state\":\"failure\",\"statuses\":[]}'; exit 0 ;;",
      `    */pulls/*) echo '{"number":99,"state":"open","merged":false,"head":{"sha":"deadbee","ref":"${branch}"}}'; exit 0 ;;`,
      "  esac",
      "fi",
      "exit 1",
      "",
    ].join("\n"),
  );
  chmodSync(fakeGhPath, 0o755);
  return fakeBinDir;
}

type LedgerLine = { step: string; [k: string]: unknown };

function readLedger(root: string): LedgerLine[] {
  return readFileSync(join(root, "state", "ledger.ndjson"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as LedgerLine);
}

function branchOnOrigin(root: string, branch: string): boolean {
  try {
    execFileSync("git", ["-C", join(root, "repos", "remudero"), "ls-remote", "--exit-code", "origin", branch], {
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

function commitFile(cwd: string, relPath: string, body: string): void {
  const g = (a: string[]) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8" });
  mkdirSync(join(cwd, relPath.split("/").slice(0, -1).join("/")), { recursive: true });
  writeFileSync(join(cwd, relPath), body);
  g(["add", "."]);
  g(["commit", "--quiet", "-m", `change ${relPath}`]);
}

async function runFixture(opts: {
  ts: number;
  prefix: string;
  /** The implement worker's REPORT text — this is the evidence `fallbackPushCause` reads. */
  report: string;
  /** When true, the fake worker pushes its own branch to origin before returning — the
   *  "worker pushed for itself" path, where `fallbackPushCause` must never even be invoked. */
  selfPush?: boolean;
}): Promise<{ root: string; branch: string; verdict: string; ledger: LedgerLine[] }> {
  const root = mkdtempSync(join(tmpdir(), opts.prefix));
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, FIXTURE_PLAN);
  const config: Config = { claudeBin: "/bin/true", root };
  gitFixture(root);

  const branch = `run-T-EVIDENCE-${opts.ts}`;
  const fakeBinDir = fakeGh(branch, "https://github.com/acme/remudero/pull/99");
  const savedPath = process.env.PATH;
  process.env.PATH = `${fakeBinDir}:${savedPath}`;
  const savedNow = Date.now;
  Date.now = () => opts.ts;

  let spawnCalls = 0;
  const spawn: typeof spawnWorker = async (args) => {
    spawnCalls++;
    if (spawnCalls === 1) {
      return result({
        sessionId: "s-recon",
        text: "RECON REPORT\nOBSERVED: nothing\nINFERRED: nothing\nCOULDN'T-VERIFY: nothing\n",
      });
    }
    commitFile(args.cwd, "src/lib/daemon.ts", `edit ${opts.ts}\n`);
    if (opts.selfPush) {
      execFileSync("git", ["-C", args.cwd, "push", "-q", "origin", "HEAD"]);
    }
    return result({ sessionId: "s-implement", text: opts.report });
  };

  try {
    const res = await withLiveWritesAllowed(() =>
      runTask("T-EVIDENCE", {
        skipGitSync: true,
        planPath,
        config,
        github: OFFLINE_GITHUB,
        spawn,
        containmentExec: holdingContainmentExec,
        isolationExec: cleanIsolationExec,
      }),
    );
    return { root, branch, verdict: res.verdict, ledger: readLedger(root) };
  } finally {
    Date.now = savedNow;
    process.env.PATH = savedPath;
  }
}

test("BEHAVIORAL: the fallback still pushes and still opens the PR — evidence only adds information, never a refusal", async () => {
  const r = await runFixture({
    ts: 1785000300001,
    prefix: "evidence-fallback-",
    report:
      "REPORT\n$ git push origin HEAD\nremote: Support for password authentication was removed.\n" +
      "fatal: Authentication failed for " +
      "'https://x-access-token:ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123@github.com/acme/remudero.git/'\n" +
      "no PR opened yet\n",
  });
  try {
    const line = r.ledger.find((l) => l.step === "fallback_push.cause");
    assert.ok(line, "the fallback push's cause is ledgered");
    assert.equal(line.cause, "credential_expired");
    assert.equal(typeof line.evidence, "string");
    assert.match(String(line.evidence), /Support for password authentication was removed/);
    assert.ok(
      !String(line.evidence).includes("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123"),
      "the token must not reach the ledger, even end-to-end through the real run",
    );

    // Acceptance: this adds evidence, never a refusal — the branch still reaches origin and the
    // run still proceeds to its own terminal verdict, unchanged from the pre-W1-T2522 behavior.
    assert.equal(branchOnOrigin(r.root, r.branch), true, "the branch still reached origin");
    // "blocked_ci" is only reachable once a PR exists AND its CI rollup was polled — a run that
    // could not open the PR (a refusal instead of the "adds evidence, never a refusal" contract)
    // would instead end at "failed" ("no PR opened"), never here.
    assert.equal(r.verdict, "blocked_ci", "the run still proceeds past the push to its own terminal verdict");
  } finally {
    rmSync(r.root, { recursive: true, force: true });
  }
});

test("BEHAVIORAL: a run whose worker pushed for itself ledgers nothing new — fallbackPushCause never even fires", async () => {
  const r = await runFixture({
    ts: 1785000300002,
    prefix: "evidence-selfpush-",
    report: "REPORT\nno PR opened yet\n",
    selfPush: true,
  });
  try {
    assert.equal(branchOnOrigin(r.root, r.branch), true, "the worker's own push reached origin");
    const line = r.ledger.find((l) => l.step === "fallback_push.cause");
    assert.equal(line, undefined, "a branch already on origin never reaches fallbackPushCause at all");
  } finally {
    rmSync(r.root, { recursive: true, force: true });
  }
});
