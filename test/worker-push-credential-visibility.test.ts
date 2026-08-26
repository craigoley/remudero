import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { fallbackPushCause, runTask, type FallbackPushCause } from "../src/run-task.js";
import type { GitHub } from "../src/lib/status.js";
import type { ProbeExecResult as IsolationProbeExecResult } from "../src/lib/isolation.js";
import type { ProbeExecResult } from "../src/lib/containment.js";
import type { WorkerResult } from "../src/lib/worker.js";
import type { spawnWorker } from "../src/lib/worker.js";
import type { Config } from "../src/lib/config.js";

/**
 * W1-T2267 — THE ORCHESTRATOR'S FALLBACK PUSH RECORDS WHY IT FIRED.
 *
 * `runTask`'s fallback push (`if (!branchOnOrigin)`, guarding `gitPushRunBranch(worktreePath)`)
 * used to trigger off a bare `git ls-remote --exit-code` probe run with `stdio: "ignore"` inside a
 * `catch` that bound no error. A worker whose copied `GH_TOKEN` expired mid-run, a worker that
 * simply never pushed, and a probe that itself could not read the remote all collapsed onto the
 * identical observable — `branchOnOrigin === false` — and NOTHING recorded which of the three it
 * was. `fallbackPushCause` (src/run-task.ts, beside `scopeGuardOutOfScopeFiles`) tells them apart
 * from evidence the orchestrator already holds: the probe's own captured exit status/stderr, and
 * the implement worker's own transcript+stderr. It is PURE — no git/network calls — so most of
 * this file drives it directly with fixtures; the last section drives the real `runTask` (the
 * SAME real-git/fake-`gh` harness `test/scope-guard-overrun.test.ts` uses for this identical push
 * site) to prove the classifier is actually WIRED to the ledger and that the push it explains
 * still reaches origin on every path.
 *
 * NOT IN SCOPE (design note iv, restated here so nobody re-derives it while reading this file):
 * preventing the expiry, refreshing the worker's copy, or retrying the push. This closes the
 * OBSERVABILITY half only — the branch must still reach origin on every path, unconditionally.
 */

// ── fallbackPushCause: PURE, fixture-driven ─────────────────────────────────────────────────

test("fallbackPushCause: a probe that could not read the remote is 'probe_unreadable', never a bare ref-absence", () => {
  // status !== 2 means git ls-remote's `--exit-code` never got to answer "no matching ref" at
  // all — some other failure (auth, transport, a killed process) intervened. Design (iii): this
  // must not read identically to a genuinely missing branch.
  const authFailure = fallbackPushCause(
    { status: 128, stderr: "fatal: Authentication failed for 'https://github.com/acme/remudero.git/'" },
    "",
  );
  assert.equal(authFailure.cause, "probe_unreadable");
  assert.match(authFailure.detail, /status 128/);

  const transportFailure = fallbackPushCause(
    { status: 128, stderr: "fatal: unable to access '...': Could not resolve host: github.com" },
    "",
  );
  assert.equal(transportFailure.cause, "probe_unreadable");

  // No status at all (e.g. git itself failed to spawn) is the SAME shape, not a fourth case.
  const spawnFailure = fallbackPushCause({ status: null, stderr: "" }, "");
  assert.equal(spawnFailure.cause, "probe_unreadable");
  assert.match(spawnFailure.detail, /status none/);

  // No probe evidence at all (defensive — the caller only omits this when branchOnOrigin was
  // true, so this function should never actually be reached that way) is also probe_unreadable,
  // not a guess.
  assert.equal(fallbackPushCause(undefined, "").cause, "probe_unreadable");
});

test("fallbackPushCause: exit code 2 — the remote WAS read and the ref really is absent — is not, by itself, probe_unreadable", () => {
  // status === 2 is `--exit-code`'s own documented meaning for "queried successfully, no
  // matching ref". Paired with no worker evidence at all this still can't assert a positive
  // cause, so it must land on `undetermined`, never silently reuse `probe_unreadable`.
  const confirmedAbsent = fallbackPushCause({ status: 2, stderr: "" }, "");
  assert.notEqual(confirmedAbsent.cause, "probe_unreadable");
});

test("fallbackPushCause: a credential failure on the worker's OWN push is distinguishable from one never attempted", () => {
  // The two shapes design (ii) names as collapsing today. Both start from the SAME confirmed-
  // absent probe (status 2) — what differs is the worker's own transcript+stderr evidence.
  const credentialExpired = fallbackPushCause(
    { status: 2, stderr: "" },
    "$ git push origin HEAD\nremote: Support for password authentication was removed.\n" +
      "fatal: Authentication failed for 'https://github.com/acme/remudero.git/'",
  );
  assert.equal(credentialExpired.cause, "credential_expired");
  assert.ok(credentialExpired.detail.length > 0, "a cause is never reported bare");

  const neverAttempted = fallbackPushCause(
    { status: 2, stderr: "" },
    "REPORT\nran out of turns before committing\nno PR opened yet\n",
  );
  assert.equal(neverAttempted.cause, "push_not_attempted");
  assert.notEqual(neverAttempted.cause, credentialExpired.cause, "the two shapes must not collapse");
});

test("fallbackPushCause: 'bad credentials' (the gh API's own phrasing for an expired token) also classifies credential_expired", () => {
  const r = fallbackPushCause({ status: 2, stderr: "" }, "gh: Bad credentials (HTTP 401)");
  assert.equal(r.cause, "credential_expired");
});

test("fallbackPushCause: a confirmed-absent branch with a push attempt that failed for an UNRECOGNIZED reason is 'undetermined', not left out", () => {
  // Acceptance #5: a cause the run cannot determine is NAMED as undetermined rather than
  // omitted, or worse, mis-asserted as one of the two positive causes above.
  const r = fallbackPushCause(
    { status: 2, stderr: "" },
    "$ git push origin HEAD\nerror: failed to push some refs to 'origin'\nhint: Updates were rejected",
  );
  assert.equal(r.cause, "undetermined");
  assert.ok(r.detail.length > 0, "undetermined still carries a reason, never a bare label");
});

test("fallbackPushCause: every cause carries a non-empty detail — the reason is always recorded, never just that it fired", () => {
  const fixtures: FallbackPushCause[] = [
    fallbackPushCause({ status: 128, stderr: "fatal: could not read from remote repository" }, ""),
    fallbackPushCause({ status: 2, stderr: "" }, "fatal: Authentication failed for 'https://x/y.git/'"),
    fallbackPushCause({ status: 2, stderr: "" }, "REPORT\nno PR opened yet\n"),
    fallbackPushCause({ status: 2, stderr: "" }, "$ git push origin HEAD\nerror: failed to push some refs"),
  ];
  const causes = new Set(fixtures.map((f) => f.cause));
  assert.equal(causes.size, 4, "all four distinguishable shapes are actually reachable");
  for (const f of fixtures) {
    assert.equal(typeof f.detail, "string");
    assert.ok(f.detail.trim().length > 0, `${f.cause} must record WHY, not just THAT`);
  }
});

// ── BEHAVIORAL: driven through the REAL runTask, the real fallback-push guard ─────────────────
// Mirrors test/scope-guard-overrun.test.ts's harness for the SAME push site (`if
// (!branchOnOrigin)`) — a real throwaway git origin, a fake `gh` on PATH, zero network, zero real
// Claude spawn — because "did the branch reach origin, and does the ledger carry a cause" are
// both questions only a real `git ls-remote` against a real remote can answer honestly.

const FIXTURE_PLAN = [
  "- id: T-PUSHVIS",
  "  title: fallback push cause probe",
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
  const originGit = mkdtempSync(join(tmpdir(), "pushvis-origin-"));
  execFileSync("git", ["init", "-q", "--bare", "--initial-branch=main", originGit]);
  const seed = mkdtempSync(join(tmpdir(), "pushvis-seed-"));
  execFileSync("git", ["clone", "-q", originGit, seed]);
  execFileSync("git", ["-C", seed, "config", "user.email", "pushvis-test@example.invalid"]);
  execFileSync("git", ["-C", seed, "config", "user.name", "pushvis-test"]);
  writeFileSync(join(seed, "README.md"), "seed\n");
  execFileSync("git", ["-C", seed, "add", "-A"]);
  execFileSync("git", ["-C", seed, "commit", "-q", "-m", "seed"]);
  execFileSync("git", ["-C", seed, "push", "-q", "origin", "main"]);

  const repoDir = join(root, "repos", "remudero");
  mkdirSync(join(root, "repos"), { recursive: true });
  execFileSync("git", ["clone", "-q", originGit, repoDir]);
  execFileSync("git", ["-C", repoDir, "config", "user.email", "pushvis-test@example.invalid"]);
  execFileSync("git", ["-C", repoDir, "config", "user.name", "pushvis-test"]);
  return { repoDir };
}

function fakeGh(branch: string, prUrl: string): string {
  const fakeBinDir = mkdtempSync(join(tmpdir(), "pushvis-bin-"));
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
      // W1-T2268: `pollToGate`/`waitForCiGreen` no longer spend `gh pr view --json state,
      // statusCheckRollup` (GraphQL) — they read the rollup over REST — so the three argv shapes
      // below are what production now asks for. Answering them keeps this fixture's ORIGINAL
      // contract intact -- red CI on the first poll -- rather than changing what the test asserts.
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
  /** The implement worker's REPORT text — this is the evidence `fallbackPushCause` reads to
   *  distinguish a credential failure from a push that was never attempted. */
  report: string;
}): Promise<{ root: string; branch: string; verdict: string; ledger: LedgerLine[] }> {
  const root = mkdtempSync(join(tmpdir(), opts.prefix));
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, FIXTURE_PLAN);
  const config: Config = { claudeBin: "/bin/true", root };
  gitFixture(root);

  const branch = `run-T-PUSHVIS-${opts.ts}`;
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
    // In-scope commit, made in the worktree but never pushed by the "worker" — this is what
    // makes the run fall through to the orchestrator's own fallback push, the ONE site
    // `fallbackPushCause` is wired at. NO PR_URL in the report, same as the guard's own suite.
    commitFile(args.cwd, "src/lib/daemon.ts", `edit ${opts.ts}\n`);
    return result({ sessionId: "s-implement", text: opts.report });
  };

  try {
    const res = await withLiveWritesAllowed(() =>
      runTask("T-PUSHVIS", {
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

test("BEHAVIORAL: a credential failure in the worker's own transcript is ledgered as credential_expired — and the branch STILL reaches origin", async () => {
  const r = await runFixture({
    ts: 1785000200001,
    prefix: "pushvis-credential-",
    report:
      "REPORT\n$ git push origin HEAD\nremote: Support for password authentication was removed.\n" +
      "fatal: Authentication failed for 'https://github.com/acme/remudero.git/'\nno PR opened yet\n",
  });
  try {
    const line = r.ledger.find((l) => l.step === "fallback_push.cause");
    assert.ok(line, "the fallback push's cause is ledgered — its presence proves the run reached the guarded site");
    assert.equal(line.cause, "credential_expired");
    assert.equal(typeof line.detail, "string");
    assert.ok(String(line.detail).length > 0, "the reason is recorded, not just that the fallback fired");

    // Acceptance #4: the branch reaches origin on this path exactly as it always did — a
    // credential failure the run can now NAME must never become a reason to withhold the push.
    assert.equal(branchOnOrigin(r.root, r.branch), true, "the branch still reached origin");
    assert.equal(r.verdict, "blocked_ci", "the run still proceeds past the push to its own terminal verdict");
  } finally {
    rmSync(r.root, { recursive: true, force: true });
  }
});

test("BEHAVIORAL: no push evidence at all in the worker's transcript is ledgered as push_not_attempted — distinct from credential_expired — and STILL reaches origin", async () => {
  const r = await runFixture({
    ts: 1785000200002,
    prefix: "pushvis-neverattempted-",
    report: "REPORT\nno PR opened yet\n",
  });
  try {
    const line = r.ledger.find((l) => l.step === "fallback_push.cause");
    assert.ok(line, "the fallback push's cause is ledgered");
    assert.equal(line.cause, "push_not_attempted");
    assert.notEqual(line.cause, "credential_expired", "the two shapes design (ii) names must not collapse");

    assert.equal(branchOnOrigin(r.root, r.branch), true, "the branch still reached origin");
    assert.equal(r.verdict, "blocked_ci");
  } finally {
    rmSync(r.root, { recursive: true, force: true });
  }
});
