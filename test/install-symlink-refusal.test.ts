/**
 * test/install-symlink-refusal.test.ts — the class fix for the shared-node_modules destroyer.
 *
 * THE MECHANISM, measured forensically 2026-08-11 (and the 2026-07-29 daemon outage before it):
 * `ensureInstallFresh` (src/run-task.ts) runs a real `npm ci` when the lockfile hash moved — and
 * `npm ci`'s CLEAR PHASE follows a worktree's `node_modules` SYMLINK, emptying the SHARED
 * canonical tree through the link before reifying a private real directory. The symlink itself is
 * the NORMAL worktree state (`linkWorktreeNodeModules`, src/lib/worker.ts, wires every worker
 * that way ON PURPOSE — "by SYMLINK — never by installing"), so the refusal under test here
 * refuses the INSTALL, never the symlink: a matching marker still no-ops, and a worktree that
 * genuinely needs newer deps is served by refreshing the CANONICAL checkout, after which the
 * symlink serves the fresh tree with no install in the worktree at all.
 *
 * ITS OWN FILE on purpose (the run-task.test.ts file-level-crash lesson), and the only file
 * besides test/serve-service-boot.test.ts / test/serve-orphan-teardown.test.ts that spawns the
 * real CLI: the two child tests at the bottom are the BEHAVIORAL proof the guarded early return
 * exists — an env var's presence proves nothing about what the child did with it, so the pair
 * asserts on what each child DID (one visibly reaches the install path and is refused; its
 * guarded twin visibly does not).
 *
 * NO TEST HERE EVER RUNS AN INSTALLER. The destructive shape is constructed in mkdtemp fixtures
 * and driven against the refusal predicate with a recording `install` seam; the child tests rely
 * on the refusal itself to stop short of npm. A sentinel file inside each symlink's TARGET is
 * asserted intact afterward — the exact thing the defect destroyed.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  ensureInstallFresh,
  hashInstallInputs,
  installHashMarkerPath,
  serviceFreshnessGate,
  SymlinkInstallRefusal,
} from "../src/run-task.js";
import { killProcessGroup } from "../src/lib/worker-containment.js";

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

/** A port nobody holds right now — asked of the OS rather than guessed (the siblings' shape). */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as { port: number };
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

/** A repoDir fixture with real package files and a chosen node_modules shape. */
function fixtureRepoDir(nodeModules: "symlink" | "dir" | "absent"): { repo: string; target: string } {
  const repo = mkdtempSync(join(tmpdir(), "rmd-install-refusal-"));
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "fixture", private: true }));
  writeFileSync(join(repo, "package-lock.json"), JSON.stringify({ name: "fixture", lockfileVersion: 3, packages: {} }));
  const target = mkdtempSync(join(tmpdir(), "rmd-shared-target-"));
  writeFileSync(join(target, "sentinel.txt"), "the shared tree the defect used to empty");
  if (nodeModules === "symlink") symlinkSync(target, join(repo, "node_modules"), "dir");
  if (nodeModules === "dir") mkdirSync(join(repo, "node_modules"));
  return { repo, target };
}

// ── the refusal FIRES on the destructive shape ──────────────────────────────────────────────

test("a symlinked node_modules with a stale marker REFUSES: SymlinkInstallRefusal, install never invoked, shared target untouched", () => {
  const { repo, target } = fixtureRepoDir("symlink");
  try {
    const installs: string[] = [];
    assert.throws(
      () => ensureInstallFresh(repo, { install: () => { installs.push("ran"); } }),
      (err: unknown) => err instanceof SymlinkInstallRefusal && /node_modules is a symlink/.test((err as Error).message),
      "the destructive shape must be refused with the NAMED type, so callers can tell refusal from install failure",
    );
    assert.deepEqual(installs, [], "the install seam must never be reached — refusal precedes it");
    assert.ok(existsSync(join(target, "sentinel.txt")), "the shared target must be untouched");
    assert.equal(existsSync(join(target, ".rmd-install-hash")), false, "no marker may be written on refusal");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

// ── …and DOES NOT fire on the legitimate shapes ─────────────────────────────────────────────

test("a REAL-directory node_modules with a stale marker installs exactly as before — the canonical checkout's legitimate path", () => {
  const { repo, target } = fixtureRepoDir("dir");
  try {
    const installs: string[] = [];
    const ran = ensureInstallFresh(repo, { install: () => { installs.push("ran"); } });
    assert.equal(ran, true);
    assert.deepEqual(installs, ["ran"], "a real directory is the legitimate install site — the refusal must not block it");
    assert.equal(readFileSync(installHashMarkerPath(repo), "utf8"), hashInstallInputs(repo), "the marker records the installed hash");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test("an ABSENT node_modules (a fresh clone) installs — refusing that would break every first boot", () => {
  const { repo, target } = fixtureRepoDir("absent");
  try {
    const installs: string[] = [];
    assert.equal(ensureInstallFresh(repo, { install: () => { installs.push("ran"); } }), true);
    assert.deepEqual(installs, ["ran"]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test("a symlinked node_modules whose marker MATCHES no-ops exactly as before — the refusal is of the install, not the symlink", () => {
  // The ordering under test: the no-op check runs BEFORE the refusal, so a worktree whose
  // SHARED tree is already fresh boots untouched — refusing here would take down every
  // healthy worker serve/daemon boot, the one-sided-test trap this file exists to avoid.
  const { repo, target } = fixtureRepoDir("symlink");
  try {
    writeFileSync(join(target, ".rmd-install-hash"), hashInstallInputs(repo));
    const installs: string[] = [];
    assert.equal(ensureInstallFresh(repo, { install: () => { installs.push("ran"); } }), false);
    assert.deepEqual(installs, [], "a matching hash is a total no-op — no install, no refusal");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

// ── the service gate: refusal is ledgered and survivable; a FAILED install stays loud ───────

test("serviceFreshnessGate ledgers daemon.install_refused and PROCEEDS on the refusal — the W1-T255 doctrine — while a real install failure still throws", () => {
  const { repo, target } = fixtureRepoDir("symlink");
  const stateDir = mkdtempSync(join(tmpdir(), "rmd-refusal-ledger-"));
  const ledgerPath = join(stateDir, "ledger.ndjson");
  const stderr: string[] = [];
  const origError = console.error;
  console.error = (m: unknown) => stderr.push(String(m));
  try {
    const assessed = { checkServiceFreshness: () => ({ status: "assessed", dirty: false, behind: null }) as const };
    // Direction 1: the REAL ensureInstallFresh against the destructive fixture — the gate
    // must catch the typed refusal, ledger it, say it, and RETURN (a service never dies on
    // tree state).
    serviceFreshnessGate("serve", repo, {}, { ...assessed, ledgerPath });
    const ledger = readFileSync(ledgerPath, "utf8");
    assert.match(ledger, /"step":"daemon\.install_refused"/, "the refusal must be ledgered, not swallowed");
    assert.match(ledger, /node_modules is a symlink/, "the ledger line carries the reason from the decision that produced it");
    assert.ok(stderr.some((l) => l.includes("install refused")), "the refusal must reach stderr — loud, not silent");
    assert.ok(existsSync(join(target, "sentinel.txt")), "the shared target must be untouched");
    // Direction 2: an install that RAN and failed is NOT a refusal — the W1-T151 loud-failure
    // contract holds, so the gate rethrows anything untyped.
    assert.throws(
      () => serviceFreshnessGate("serve", repo, {}, { ...assessed, ledgerPath, ensureInstallFresh: () => { throw new Error("npm ci exited 1"); } }),
      /npm ci exited 1/,
      "only the NAMED refusal is survivable — a genuine install failure must stay loud",
    );
  } finally {
    console.error = origError;
    rmSync(repo, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// ── the BEHAVIORAL pair: what a real child DOES with and without the guard ──────────────────

function childEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  // Deterministic in every environment: `checkServiceFreshness` short-circuits on CI env vars
  // exactly like the guard, so a CI runner would take the guarded branch in BOTH directions
  // and the pair would stop discriminating. Strip them so the ONLY difference between the two
  // children is RMD_SELF_SYNC_DONE.
  delete env.CI;
  delete env.GITHUB_ACTIONS;
  delete env.RMD_SELF_SYNC_DONE;
  return env;
}

/** A git-complete serve fixture: local bare origin (no network), package files committed,
 * node_modules symlinked at a sentinel-carrying target — the destructive shape, jailed. */
function serveFixture(): { home: string; repo: string; target: string } {
  const home = mkdtempSync(join(tmpdir(), "rmd-refusal-home-"));
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  // The deliberately NONEXISTENT claudeBin and the seeded config are the sibling files'
  // hard-won CI lesson (see test/serve-orphan-teardown.test.ts): nothing executes claudeBin,
  // the field only needs to exist so loadConfig takes its READ path.
  writeFileSync(
    join(home, ".config", "remudero", "config.json"),
    JSON.stringify({ claudeBin: "/nonexistent/claude-not-installed", root: join(home, "Remudero") }),
  );
  const repo = mkdtempSync(join(tmpdir(), "rmd-refusal-repo-"));
  const bare = mkdtempSync(join(tmpdir(), "rmd-refusal-origin-"));
  const git = (args: string[]): void => {
    execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { stdio: "pipe" });
  };
  execFileSync("git", ["init", "--bare", "--quiet", bare], { stdio: "pipe" });
  execFileSync("git", ["-C", repo, "init", "--quiet", "-b", "main"], { stdio: "pipe" });
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "fixture", private: true }));
  writeFileSync(join(repo, "package-lock.json"), JSON.stringify({ name: "fixture", lockfileVersion: 3, packages: {} }));
  // serveCommand loads the plan at boot — a plan-less cwd dies in loadPlan before binding,
  // so the fixture carries one minimal record (the repo-root-identity fixture's shape).
  mkdirSync(join(repo, "plan"), { recursive: true });
  writeFileSync(
    join(repo, "plan", "tasks.yaml"),
    "- id: FIX-T1\n  title: fixture\n  repo: remudero\n  type: implement\n  origin: architect\n  risk: medium\n",
  );
  git(["add", "."]);
  git(["commit", "--quiet", "-m", "fixture"]);
  git(["remote", "add", "origin", bare]);
  git(["push", "--quiet", "origin", "main"]);
  const target = mkdtempSync(join(tmpdir(), "rmd-refusal-target-"));
  writeFileSync(join(target, "sentinel.txt"), "the shared tree the defect used to empty");
  symlinkSync(target, join(repo, "node_modules"), "dir");
  return { home, repo, target };
}

async function runServeChild(guarded: boolean): Promise<{ log: string; target: string; marker: boolean; sentinel: boolean }> {
  const { home, repo, target } = serveFixture();
  const logPath = join(home, "serve.out.log");
  const out = openSync(logPath, "a", 0o600);
  const env = childEnv(home);
  if (guarded) env.RMD_SELF_SYNC_DONE = "1";
  const port = await freePort();
  const child = spawn(join(REPO_ROOT, "bin", "rmd"), ["serve", "--port", String(port), "--host", "127.0.0.1"], {
    cwd: repo, // resolveRepoRoot reads cwd -> git show-toplevel -> the FIXTURE, never this checkout
    stdio: ["ignore", out, out],
    env,
    detached: true,
  });
  try {
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      const text = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
      if (text.includes("listening on")) break;
      if (child.exitCode !== null) break; // a dead child's log is complete — stop waiting
      await new Promise((r) => setTimeout(r, 200));
    }
    const log = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
    return {
      log,
      target,
      marker: existsSync(join(target, ".rmd-install-hash")),
      sentinel: existsSync(join(target, "sentinel.txt")),
    };
  } finally {
    killProcessGroup(child.pid!);
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
}

test("an UNGUARDED serve child on the destructive shape reaches the install path and is REFUSED — loudly, survivably, destroying nothing", async () => {
  const r = await runServeChild(false);
  assert.match(r.log, /install refused/, "the child must visibly reach the refusal — this is the arm the guard exists to stop");
  assert.match(r.log, /listening on/, "…and still boot: a service never dies on tree state (W1-T255)");
  assert.equal(r.sentinel, true, "the shared target must be untouched — before this fix, this assertion is what the defect violated");
  assert.equal(r.marker, false, "no install ran, so no marker may exist");
});

test("the GUARDED twin never reaches the install path at all — the early return asserted by the child's behaviour, not by the env var", async () => {
  const r = await runServeChild(true);
  assert.match(r.log, /listening on/, "the guarded child must boot normally");
  assert.doesNotMatch(r.log, /install refused/, "no refusal: the gate returned before ensureInstallFresh — the sibling test proves the same child WOULD have been refused without the guard");
  assert.equal(r.sentinel, true);
  assert.equal(r.marker, false);
});
