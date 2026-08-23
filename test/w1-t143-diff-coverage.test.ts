/**
 * test/w1-t143-diff-coverage.test.ts — W1-T143 round 2 (ci-log).
 *
 * The `ledgerPathFor(config)` mechanical rename (every `join(config.root, "state",
 * "ledger.ndjson")` call site → the one named function, W1-T143's "deterministic +
 * documented ledger" half) rewrote ~30 lines' TEXT even though every site's runtime
 * behavior is byte-identical — and `scripts/diff-coverage.mjs` (W1-T212) polices the
 * DIFF, not the semantics: an unchanged-behavior line that nonetheless reads as newly
 * ADDED text, in a CLI command no existing test suite ever drives all the way to that
 * statement, blocks the merge exactly like a genuine untested regression would.
 *
 * Each test below reaches exactly one of those previously-0-hit call sites (plus two
 * of `daemonCommand`'s own new `writeSyncLine` branches, same shape) by the CHEAPEST
 * deterministic path that command supports — never a real network mutation (no PR
 * merged, no GitHub issue filed, no iMessage sent, no worker spawned) — and tolerates
 * (or explicitly expects) whatever THAT path's own downstream refusal/throw is. What
 * each test asserts on is a real, named behavior of the reached branch; none of them
 * exist ONLY to satisfy the coverage gate.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { SELF_SYNC_GUARD_ENV } from "../src/lib/self-sync.js";
import { daemonCommand, depReviewCommand, main } from "../src/run-task.js";

/** A throwaway HOME + `config.json` pointing `config.root` at a fresh temp dir — the
 *  SAME shape test/daemon-observability.test.ts and test/serve-command-boot.test.ts
 *  already use, duplicated locally per this suite's own file-scoping convention. */
function instance(prefix: string): { home: string; root: string } {
  const home = mkdtempSync(join(tmpdir(), prefix));
  const root = join(home, "Remudero");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root }));
  return { home, root };
}

/** A minimal executable script on a throwaway PATH-prepended bin dir. */
function fakeBin(name: string, script: string): string {
  const dir = mkdtempSync(join(tmpdir(), `rmd-fakebin-${name}-`));
  const path = join(dir, name);
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return dir;
}

// process.exit is mocked to THROW (never merely record-and-return) — same rationale
// wipe-test.test.ts's callMain() gives: a no-op mock would let main()'s flat if-ladder
// fall through and evaluate every remaining `cmd === "<sibling>"` check after ours.
class ProcessExitCalled extends Error {
  constructor(public code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

/** Run `main()` against a fake argv, process.exit mocked to throw (never a real exit),
 *  console.log/error silenced. Returns the FIRST exit code main() reaches. Mirrors
 *  test/wipe-test.test.ts's callMain() (duplicated locally, same file-scoping
 *  convention every other test file here already follows). */
async function callMain(t: import("node:test").TestContext, argv: string[]): Promise<number | undefined> {
  const exitMock = ((code?: number): never => {
    throw new ProcessExitCalled(code);
  }) as typeof process.exit;
  t.mock.method(process, "exit", exitMock);
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "warn", () => {});

  const originalArgv = process.argv;
  process.argv = argv;
  const originalGuardEnv = process.env[SELF_SYNC_GUARD_ENV];
  process.env[SELF_SYNC_GUARD_ENV] = "1";
  try {
    let caught: unknown;
    await main().catch((e) => {
      caught = e;
    });
    assert.ok(caught instanceof ProcessExitCalled, `main() must reach process.exit, not some other throw: ${String(caught)}`);
    return (caught as ProcessExitCalled).code;
  } finally {
    process.argv = originalArgv;
    if (originalGuardEnv === undefined) delete process.env[SELF_SYNC_GUARD_ENV];
    else process.env[SELF_SYNC_GUARD_ENV] = originalGuardEnv;
  }
}

// ── rmd stop / pause / resume — plain fleet-control flag flips, no network at all ──

test("main(): `rmd stop` with nothing running is a warned no-op (ledgers fleet.stop.noop, exits 0)", async (t) => {
  const { home, root } = instance("rmd-t143-stop-");
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const code = await callMain(t, ["node", "run-task.js", "stop"]);
    assert.equal(code, 0);
    const ledger = readFileSync(join(root, "state", "ledger.ndjson"), "utf8");
    assert.match(ledger, /"step":"fleet\.stop\.noop"/);
  } finally {
    process.env.HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("main(): `rmd pause` writes the PAUSE flag + ledgers fleet.pause, exits 0", async (t) => {
  const { home, root } = instance("rmd-t143-pause-");
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const code = await callMain(t, ["node", "run-task.js", "pause"]);
    assert.equal(code, 0);
    const ledger = readFileSync(join(root, "state", "ledger.ndjson"), "utf8");
    assert.match(ledger, /"step":"fleet\.pause"/);
  } finally {
    process.env.HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("main(): `rmd resume` clears stop+pause + ledgers fleet.resume, exits 0", async (t) => {
  const { home, root } = instance("rmd-t143-resume-");
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const code = await callMain(t, ["node", "run-task.js", "resume"]);
    assert.equal(code, 0);
    const ledger = readFileSync(join(root, "state", "ledger.ndjson"), "utf8");
    assert.match(ledger, /"step":"fleet\.resume"/);
  } finally {
    process.env.HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
});

// ── rmd notify — a PATH-stubbed osascript (never the real Messages.app) ──────────

test("main(): `rmd notify <msg>` sends over the (stubbed) imessage channel + ledgers notify.sent, exits 0", async (t) => {
  const { home, root } = instance("rmd-t143-notify-");
  const oldHome = process.env.HOME;
  const oldPath = process.env.PATH;
  const binDir = fakeBin("osascript", "#!/bin/sh\nexit 0\n");
  process.env.HOME = home;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const code = await callMain(t, ["node", "run-task.js", "notify", "hello", "from", "w1-t143"]);
    assert.equal(code, 0);
    const ledger = readFileSync(join(root, "state", "ledger.ndjson"), "utf8");
    assert.match(ledger, /"step":"notify\.sent"/);
  } finally {
    process.env.HOME = oldHome;
    process.env.PATH = oldPath;
    rmSync(home, { recursive: true, force: true });
    rmSync(dirname(join(binDir, "osascript")), { recursive: true, force: true });
  }
});

// ── rmd dep-review — a PATH-stubbed gh (never a real GitHub round-trip) ──────────

test("depReviewCommand: a non-Dependabot author REFUSES immediately (no gates polled, no merge attempted)", async (t) => {
  const { home, root } = instance("rmd-t143-depreview-");
  const oldHome = process.env.HOME;
  const oldPath = process.env.PATH;
  const binDir = fakeBin(
    "gh",
    [
      "#!/bin/sh",
      "if [ \"$1\" = 'pr' ] && [ \"$2\" = 'view' ]; then",
      '  echo \'{"number":1,"url":"https://github.com/craigoley/remudero/pull/1","title":"chore: bump","body":"","headRefOid":"deadbeef","author":{"login":"not-dependabot"},"statusCheckRollup":[]}\'',
      "  exit 0",
      "fi",
      "if [ \"$1\" = 'pr' ] && [ \"$2\" = 'diff' ]; then",
      "  echo 'diff --git a/package.json b/package.json'",
      "  exit 0",
      "fi",
      "exit 1",
      "",
    ].join("\n"),
  );
  process.env.HOME = home;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const code = await depReviewCommand("1");
    assert.equal(code, 2, "REFUSE decisions exit 2, no remudero-review posted");
    const ledger = readFileSync(join(root, "state", "ledger.ndjson"), "utf8");
    assert.match(ledger, /"step":"dep-review\.decided"/);
    assert.match(ledger, /"decision":"refuse"/);
  } finally {
    process.env.HOME = oldHome;
    process.env.PATH = oldPath;
    rmSync(home, { recursive: true, force: true });
    rmSync(dirname(join(binDir, "gh")), { recursive: true, force: true });
  }
});

// ── rmd deploy-run --dry-run — a real (read-only) fetch against THIS checkout's own
// origin, exactly what runDeployCycle always does first; with no DEPLOY_REQUESTED
// marker under the throwaway config.root, decideDeployTrigger always resolves
// deploy:false — no pull, no reset --hard, no launchctl kickstart, ever reachable. ──

test("main(): `rmd deploy-run --dry-run` with no deploy marker present is a clean no-op (never pulls/kickstarts)", async (t) => {
  const { home } = instance("rmd-t143-deployrun-");
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const code = await callMain(t, ["node", "run-task.js", "deploy-run", "--dry-run"]);
    assert.equal(code, 0, "no marker present -> decideDeployTrigger always resolves deploy:false -> no-op exit 0");
  } finally {
    process.env.HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
});

// ── rmd deploy — writes state/DEPLOY_REQUESTED and prints the operator confirmation
// (W1-T1239 round 1): only a write + a console.log, no network, no launchctl call. ──

test("main(): `rmd deploy` writes state/DEPLOY_REQUESTED and names the already-current case in its confirmation", async (t) => {
  const { home, root } = instance("rmd-t143-deploy-");
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const code = await callMain(t, ["node", "run-task.js", "deploy", "--reason", "w1-t143"]);
    assert.equal(code, 0);
    const marker = readFileSync(join(root, "state", "DEPLOY_REQUESTED"), "utf8");
    assert.match(marker, /"reason":\s*"w1-t143"/, "the CLI's own --reason flag reaches the marker file");
    const printed = (console.log as unknown as { mock: { calls: Array<{ arguments: unknown[] }> } }).mock.calls
      .map((c) => String(c.arguments[0]))
      .join("\n");
    assert.match(
      printed,
      /already on origin\/main.*consumes the request without a deploy/s,
      "the confirmation must tell the operator an already-current fleet still consumes their request",
    );
  } finally {
    process.env.HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
});

// ── rmd ops / rmd issues --dry-run — real (read-only, fail-soft) gh reads against
// THIS repo; --dry-run guarantees neither ever files a real GitHub issue. issues'
// managed-repo list is THIS checkout's real (empty) .remudero/managed-repos.json, so
// pollIssues does zero gh calls of its own. ──

test("main(): `rmd ops --dry-run` polls alerts read-only and previews without escalating/capturing anything, exits 0", async (t) => {
  const { home } = instance("rmd-t143-ops-");
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    // --dry-run's own gate (src/lib/ops.ts's pollAlerts) skips escalate()/captureFeedback()
    // entirely -- ledgerPathFor(config) is still reached (this test's real target) to build
    // pollAlerts' deps, but nothing is WRITTEN under --dry-run, so no ledger file exists yet.
    const code = await callMain(t, ["node", "run-task.js", "ops", "--dry-run"]);
    assert.equal(code, 0);
  } finally {
    process.env.HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("main(): `rmd issues --dry-run` against this checkout's empty managed-repos.json reviews zero issues, exits 0", async (t) => {
  const { home } = instance("rmd-t143-issues-");
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const code = await callMain(t, ["node", "run-task.js", "issues", "--dry-run"]);
    assert.equal(code, 0);
  } finally {
    process.env.HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
});

// ── rmd correct / rmd trace — a REAL plan/tasks.yaml task id (this repo's own W1-T143),
// PATH stripped of `gh` entirely so both gateways' `gh` calls fail closed, fast,
// deterministically (ENOENT), independent of live GitHub/auth state. ──

test("main(): `rmd correct W1-T143 --pr 999999` with no gh on PATH cannot resolve the PR — writes nothing, exits 1", async (t) => {
  const { home } = instance("rmd-t143-correct-");
  const oldHome = process.env.HOME;
  const oldPath = process.env.PATH;
  process.env.HOME = home;
  // Deliberately NO gh anywhere on PATH — ghGateway's execFileSync("gh", ...) fails
  // closed (ENOENT) exactly like an unresolvable PR reference; applyCorrection
  // degrades to written:false either way (never a network dependency for this test).
  process.env.PATH = "/usr/bin:/bin";
  try {
    const code = await callMain(t, ["node", "run-task.js", "correct", "W1-T143", "--pr", "999999"]);
    assert.equal(code, 1, "an unresolvable PR reference writes nothing and exits 1");
  } finally {
    process.env.HOME = oldHome;
    process.env.PATH = oldPath;
    rmSync(home, { recursive: true, force: true });
  }
});

test("main(): `rmd trace W1-T143` with no gh on PATH still renders the reverse provenance chain, exits 0", async (t) => {
  const { home } = instance("rmd-t143-trace-");
  const oldHome = process.env.HOME;
  const oldPath = process.env.PATH;
  process.env.HOME = home;
  process.env.PATH = "/usr/bin:/bin";
  try {
    const code = await callMain(t, ["node", "run-task.js", "trace", "W1-T143"]);
    assert.equal(code, 0, "a known task id always renders SOME chain, gh failures degrade gracefully");
  } finally {
    process.env.HOME = oldHome;
    process.env.PATH = oldPath;
    rmSync(home, { recursive: true, force: true });
  }
});

// ── rmd plan — reaches its own ledgerPath line, then fails fast (no gh clone, no
// worker spawn) at `worktreeAdd`'s first `git fetch`: repoDir exists (so the clone
// branch is skipped) but is NOT a git repository at all. ──

test("main(): `rmd plan --mode=clarify` reaches its own ledger + worktree setup, then fails fast on a non-git repo dir (no worker ever spawned)", async (t) => {
  const { home, root } = instance("rmd-t143-plan-");
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  // A plain, empty, non-git directory at the derived repoDir -- existsSync short-
  // circuits the `gh repo clone` branch, and the very next git call (worktreeAdd's
  // OWN `git fetch`) fails immediately ("not a git repository"), well before any
  // worker spawn or PR/gate machinery.
  mkdirSync(join(root, "repos", "remudero"), { recursive: true });
  const exitMock = ((code?: number): never => {
    throw new ProcessExitCalled(code);
  }) as typeof process.exit;
  t.mock.method(process, "exit", exitMock);
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "warn", () => {});
  const originalArgv = process.argv;
  process.argv = ["node", "run-task.js", "plan", "--mode=clarify", "a throwaway coverage-only brief"];
  const originalGuardEnv = process.env[SELF_SYNC_GUARD_ENV];
  process.env[SELF_SYNC_GUARD_ENV] = "1";
  try {
    let caught: unknown;
    await main().catch((e) => {
      caught = e;
    });
    // Neither a clean process.exit NOR a silent success: worktreeAdd's git fetch on a
    // non-git dir throws, and planCommand has no catch around it -- main() rejects with
    // the REAL git error, never a mocked process.exit.
    assert.ok(caught, "planCommand propagates worktreeAdd's git failure -- it never silently succeeds");
    assert.ok(!(caught instanceof ProcessExitCalled), "the failure is a real throw, not a clean CLI exit");
    const ledger = readFileSync(join(root, "state", "ledger.ndjson"), "utf8");
    assert.match(ledger, /"step":"plan\.start"/, "the ledger line just after ledgerPathFor's own line was reached");
  } finally {
    process.argv = originalArgv;
    if (originalGuardEnv === undefined) delete process.env[SELF_SYNC_GUARD_ENV];
    else process.env[SELF_SYNC_GUARD_ENV] = originalGuardEnv;
    process.env.HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
});

// ── daemonCommand's own three new writeSyncLine branches (W1-T143) — every one of
// these calls daemonCommand DIRECTLY (it is already exported + injectable), never
// through main()'s process.exit dance. ──

test("daemonCommand: a self-target with neither --allow-self-target nor --dry-run REFUSES via writeSyncLine, exits 2", async () => {
  const { home } = instance("rmd-t143-daemon-selfrefuse-");
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const code = await daemonCommand([]);
    assert.equal(code, 2, "resolveDaemonTarget's self-target guard refuses before any spawn/lock");
  } finally {
    process.env.HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("daemonCommand: an ALREADY-HELD drain lock (this process's own live pid) REFUSES via writeSyncLine, exits 1", async () => {
  const { home, root } = instance("rmd-t143-daemon-lock-");
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  const planPath = join(home, "tasks.yaml");
  writeFileSync(planPath, "[]\n");
  const lockPath = join(root, "state", "drain.lock");
  mkdirSync(dirname(lockPath), { recursive: true });
  // This TEST process's own pid is, by definition, alive -- acquireDrainLock must
  // see a live holder and throw DrainLockError, never silently reclaim it as stale.
  writeFileSync(
    lockPath,
    JSON.stringify({ pid: process.pid, host: "w1-t143-test-host", startedAt: new Date().toISOString() }),
  );
  try {
    const code = await daemonCommand(["--allow-self-target", "--plan", planPath]);
    assert.equal(code, 1, "an already-held live lock refuses the second daemon/drain, exits 1");
  } finally {
    process.env.HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("daemonCommand: a self-target with no --plan and a broken origin remote REFUSES the git self-sync via writeSyncLine, exits 1", async () => {
  const { home } = instance("rmd-t143-daemon-syncrefuse-");
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  // A real, throwaway git repo with plan/tasks.yaml committed but an ORIGIN remote
  // that cannot resolve -- `git fetch origin` fails instantly (no real network
  // attempt at all, exactly test/run-task.test.ts's own syncPlanFromOrigin fixture
  // shape), so syncPlanOrRefuse's REFUSED branch (its `say` callback IS daemonCommand's
  // own writeSyncLine(2, ...) arrow function, W1-T143) fires deterministically.
  const fixtureRoot = mkdtempSync(join(tmpdir(), "rmd-t143-daemon-syncrefuse-fixture-"));
  mkdirSync(join(fixtureRoot, "plan"), { recursive: true });
  writeFileSync(join(fixtureRoot, "plan", "tasks.yaml"), "- id: T1\n  title: t\n  repo: remudero\n  type: implement\n", "utf8");
  const git = (args: string[]) => execFileSync("git", args, { cwd: fixtureRoot, encoding: "utf8" });
  git(["init", "--quiet", "-b", "main"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);
  git(["add", "."]);
  git(["commit", "--quiet", "-m", "init"]);
  git(["remote", "add", "origin", "/no/such/path"]);
  try {
    // --dry-run alone (no --allow-self-target needed): the self-target guard's own
    // condition is `isSelf && !allowSelf && !dryRun`, so a dry-run always bypasses it
    // -- and the git self-sync this test targets runs BEFORE the dry-run early return.
    const code = await daemonCommand(["--dry-run"], { repoRoot: fixtureRoot });
    assert.equal(code, 1, "a hard fetch failure refuses (no plan, no spawn) -- FAILS CLOSED, never silently stale");
  } finally {
    process.env.HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
