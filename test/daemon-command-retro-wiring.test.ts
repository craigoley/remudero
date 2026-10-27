import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { makeTempDir } from "#src/lib/tmp.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { resolveOwnerRepoAt } from "#src/lib/owner-repo.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { daemonCommand, ledgerPathFor } from "../src/run-task.js";
import type { DaemonDeps, DaemonSummary } from "../src/lib/daemon.js";
import { CLAUDE_BIN_ENV_OVERRIDE, claudeExecutableCache } from "../src/lib/worker.js";

// ── W1-T160: daemonCommand wires the retro cadence hooks into runDaemon (self-target) ──
//
// retroTriggerCheck (test/retro-trigger-check.test.ts) and the daemon LOOP's handling of
// a fired trigger (test/daemon-retro-trigger.test.ts) are covered independently. This
// file pins the SEAM between them: that `daemonCommand`, on a SELF-TARGET non-dry-run
// boot, actually builds and hands `checkRetroTrigger`/`runRetroTrigger` to `runDaemon`
// (and withholds them for a non-self target). It drives the REAL daemonCommand past its
// dry-run early return to the runDaemon call, injecting a stub `runDaemon` that captures
// the wired DaemonDeps and returns immediately — so the loop never actually spawns.

function fixtureHome(): { home: string; planPath: string } {
  const home = mkdtempSync(join(tmpdir(), "rmd-daemon-retro-wiring-"));
  const root = join(home, "Remudero");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(
    join(home, ".config", "remudero", "config.json"),
    JSON.stringify({ claudeBin: "/bin/true", root }),
  );
  mkdirSync(join(root, "state"), { recursive: true });
  const planPath = join(home, "tasks.yaml");
  writeFileSync(planPath, "[]\n"); // an explicit --plan skips the git self-sync entirely
  return { home, planPath };
}

test("daemonCommand: a SELF-TARGET non-dry-run boot wires checkRetroTrigger + runRetroTrigger into runDaemon", async () => {
  const { home, planPath } = fixtureHome();
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  let captured: DaemonDeps | undefined;
  try {
    const code = await daemonCommand(["--allow-self-target", "--plan", planPath, "--max", "0"], {
      runDaemon: async (_plan, deps): Promise<DaemonSummary> => {
        captured = deps;
        return { attempted: [], merged: [], stopReason: "stopped", costUsd: 0, ticks: 0 };
      },
    });
    assert.equal(code, 0, "the injected runDaemon returns a clean 'stopped' summary -> exit 0");
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }

  assert.ok(captured, "runDaemon was reached and its DaemonDeps captured");
  assert.equal(
    typeof captured.checkRetroTrigger,
    "function",
    "a self-target daemon wires the retro cadence check (retroTriggerCheck)",
  );
  assert.equal(
    typeof captured.runRetroTrigger,
    "function",
    "a self-target daemon wires the automated-retro runner",
  );
  const source = readFileSync(fileURLToPath(new URL("../src/cli/commands/daemon.ts", import.meta.url)), "utf8");
  // `buildRetroDaemonHooks()` itself stays a bare, zero-arg construction call (byte-identical
  // to before W1-T2870) so test/owner-self-host-gating.test.ts's isSelf source-grep still
  // matches; the daemon's per-boot ledger sink is instead handed to `runRetroTrigger` at
  // INVOCATION time, in the wiring line below.
  assert.ok(
    /const retroHooks = target\.isSelf \? buildRetroDaemonHooks\(\) : undefined;/.test(source),
    "buildRetroDaemonHooks's construction call stays gated on target.isSelf and takes no deps",
  );
  assert.ok(
    /runRetroTrigger: retroHooks \? \(decision\) => retroHooks\.runRetroTrigger\(decision, log\) : undefined,/.test(
      source,
    ),
    "the production wiring hands its ledger sink to runRetroTrigger at call time",
  );
  // The default subprocess arm and attempt-before-spawn order are exercised with an injected
  // subprocess runner in retro-trigger-check.test.ts; this test pins the daemon wiring above.
});

test("W1-T3491 criterion 3: pre-existing fleet controls fence mutable daemon boot callbacks", async () => {
  for (const control of ["STOP", "PAUSE", undefined] as const) {
    const { home, planPath } = fixtureHome();
    const root = join(home, "Remudero");
    const oldHome = process.env.HOME;
    let bootCalls = 0;
    let observedHold: string | undefined;
    process.env.HOME = home;
    try {
      const code = await daemonCommand(["--allow-self-target", "--plan", planPath, "--max", "0"], {
        daemonBoot: () => {
          bootCalls++;
          return undefined as never;
        },
        checkStop: () => (control === "STOP" ? "test pre-existing STOP" : undefined),
        checkPause: () => (control === "PAUSE" ? "test pre-existing PAUSE" : undefined),
        runDaemon: async (_plan, daemonDeps): Promise<DaemonSummary> => {
          observedHold = daemonDeps.checkStop?.() ?? daemonDeps.checkPause?.();
          return { attempted: [], merged: [], stopReason: "stopped", costUsd: 0, ticks: 0 };
        },
      });
      assert.equal(code, 0);
    } finally {
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
      rmSync(home, { recursive: true, force: true });
    }
    assert.equal(bootCalls, control === undefined ? 1 : 0, `${control ?? "clear"}: mutable boot callbacks are correctly fenced`);
    if (control === undefined) assert.equal(observedHold, undefined, "an unheld boot keeps existing daemon wiring");
    else assert.match(observedHold ?? "", new RegExp(control, "i"), `${control}: the loop receives the same pre-existing control`);
  }
});

// W1-T9333 — BEHAVIOUR, not source text: the boot rung that moved to src/cli/commands/daemon.ts still
// reaps a stale Claude scratchpad and ledgers `daemon.scratch_sweep`. Drives the REAL `daemonCommand`
// (through run-task.ts's delegating wrapper) and the REAL `daemonBoot`; the only injection is the
// `runDaemon` loop stub. The scratch root is redirected through `CLAUDE_CODE_TMPDIR`, the env seam
// `claudeScratchRoot` reads, so the real host root is never touched. It lives here, beside this
// file's other real-daemonCommand boots, so the module's own suite keeps no import of src/run-task.ts.
test(
  "W1-T9333: the moved boot rung reaps a stale scratchpad and ledgers daemon.scratch_sweep with its count and sample",
  { skip: typeof process.getuid !== "function" ? "claudeScratchRoot needs a POSIX uid" : false },
  async () => {
    const { home, planPath } = fixtureHome();
    const root = join(home, "Remudero");

    const scratchBase = join(home, "claude-tmp");
    const scratchRoot = join(scratchBase, `claude-${process.getuid!()}`);
    const stale = join(scratchRoot, "-stale-worker-cwd");
    const fresh = join(scratchRoot, "-fresh-worker-cwd");
    mkdirSync(stale, { recursive: true });
    mkdirSync(fresh, { recursive: true });
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000); // past the 24h boot ceiling
    utimesSync(stale, twoDaysAgo, twoDaysAgo);

    const oldHome = process.env.HOME;
    const oldScratch = process.env.CLAUDE_CODE_TMPDIR;
    const oldOverride = process.env[CLAUDE_BIN_ENV_OVERRIDE];
    const priorResolved = claudeExecutableCache.resolved;
    process.env.HOME = home;
    process.env.CLAUDE_CODE_TMPDIR = scratchBase;
    process.env[CLAUDE_BIN_ENV_OVERRIDE] = process.execPath; // deterministic claude resolution on any host
    claudeExecutableCache.resolved = undefined;
    try {
      const loopStub = async (): Promise<DaemonSummary> =>
        ({ attempted: [], merged: [], stopReason: "stopped", costUsd: 0, ticks: 0 });
      const code = await daemonCommand(["--allow-self-target", "--plan", planPath, "--max", "0"], { runDaemon: loopStub });
      assert.equal(code, 0);

      const lines = readFileSync(ledgerPathFor({ root } as never), "utf8")
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      const swept = lines.filter((l) => l.step === "daemon.scratch_sweep");
      assert.equal(swept.length, 1, "the boot rung ledgers exactly one daemon.scratch_sweep row when it reaped something");
      assert.equal(swept[0]!.removed, 1, "the row carries the removed COUNT");
      assert.deepEqual(swept[0]!.sample, ["-stale-worker-cwd"], "and names what it reaped");
      assert.equal(existsSync(stale), false, "the stale scratchpad is gone");
      assert.equal(existsSync(fresh), true, "a recent scratchpad (a live session may own it) survives");
    } finally {
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
      if (oldScratch === undefined) delete process.env.CLAUDE_CODE_TMPDIR;
      else process.env.CLAUDE_CODE_TMPDIR = oldScratch;
      if (oldOverride === undefined) delete process.env[CLAUDE_BIN_ENV_OVERRIDE];
      else process.env[CLAUDE_BIN_ENV_OVERRIDE] = oldOverride;
      claudeExecutableCache.resolved = priorResolved;
      rmSync(home, { recursive: true, force: true });
    }
  },
);

// W1-T10873: the recommendation writer's evidence and seed ports read the SELECTED target's checkout, never the
// daemon's own code checkout. The real daemonCommand boots with explicit isolated fixture config, so this
// process's environment is untouched; its runDaemon stub captures the wired ports, which are then driven for real.
test("inbox recommendation wiring reads the selected target repository", async (t) => {
  const execFileAsync = promisify(execFile);
  const home = makeTempDir("rmd-recommendation-wiring");
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const root = join(home, "Remudero");
  mkdirSync(join(root, "state"), { recursive: true });
  const planPath = join(home, "tasks.yaml");
  writeFileSync(planPath, "[]\n");

  const checkout = join(root, "repos", "console-fixture");
  mkdirSync(join(root, "repos"), { recursive: true });
  const console_ = gitRepo({ kind: "recommendation-console" });
  const seedText = JSON.stringify({ version: 1, recommendations: { "machine-judge:W1-T1": { marker: "console seed" } } });
  mkdirSync(join(console_.dir, "plan", "tasks.d"), { recursive: true });
  mkdirSync(join(console_.dir, "plan", "seeds"), { recursive: true });
  writeFileSync(join(console_.dir, "plan", "tasks.d", "W1-T1-console.yaml"), "- id: W1-T1\n  title: console task\n");
  writeFileSync(join(console_.dir, "plan", "seeds", "inbox-recommendations-2026-10-13.json"), seedText);
  console_.git("config", "remote.origin.url", "https://github.com/" + resolveOwnerRepoAt(REPO_ROOT).owner + "/console-fixture.git");
  console_.git("add", "plan");
  console_.git("commit", "--quiet", "-m", "feat: console task (W1-T1)");
  console_.git("update-ref", "refs/remotes/origin/main", console_.git("rev-parse", "HEAD"));
  renameSync(console_.dir, checkout);
  t.after(() => rmSync(checkout, { recursive: true, force: true }));

  const child = `
    const { pathToFileURL } = await import("node:url");
    const { daemonCommand } = await import(pathToFileURL(process.env.RMD_WIRING_MODULE).href);
    let wired;
    const code = await daemonCommand(process.argv.slice(1).filter((a) => a !== "--"), { config: { claudeBin: "/bin/true", root: process.env.RMD_WIRING_ROOT }, runDaemon: async (_plan, deps) => { wired = deps.recommendationBackfill; return { attempted: [], merged: [], stopReason: "stopped", costUsd: 0, ticks: 0 }; } });
    const seed = wired.readSeed();
    let evidence = null;
    try { const pinned = await wired.evidence.pin(); evidence = { repository: pinned.repository, tasks: Object.keys((await pinned.qualification()).tasks), taskBlobs: (await pinned.qualification()).tasks }; } catch (e) { evidence = { error: String(e.message) }; }
    console.log("RESULT " + JSON.stringify({ code, seed, evidence }));
  `;
  const boot = async (args: string[]) => {
    const out = await execFileAsync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", child, "--", ...args],
      { cwd: REPO_ROOT, env: { ...process.env, RMD_WIRING_ROOT: root, RMD_WIRING_MODULE: join(REPO_ROOT, "src", "run-task.ts") }, encoding: "utf8", maxBuffer: 1 << 24 });
    const line = out.stdout.split("\n").find((l) => l.startsWith("RESULT "));
    assert.ok(line, `the child reported its wiring: ${out.stdout}${out.stderr}`);
    return JSON.parse(line.slice("RESULT ".length)) as { code: number; seed?: string; evidence: { repository?: string; tasks?: string[]; taskBlobs?: Record<string, string>; error?: string } };
  };

  const selected = await boot(["--repo", "console-fixture", "--plan", planPath, "--max", "0"]);
  assert.equal(selected.code, 0);
  assert.equal(selected.seed, seedText, "the seed is the selected target's, not the code checkout's");
  assert.deepEqual(selected.evidence.tasks, ["W1-T1"], "real git evidence lists only the selected target's tasks, never Core's");
  assert.match(selected.evidence.repository ?? "", /\/console-fixture$/, "and names the selected repository");

  // Positive self-target control: the code checkout's own seed and its own repository identity are kept.
  const self = await boot(["--allow-self-target", "--plan", planPath, "--max", "0"]);
  assert.equal(self.code, 0);
  assert.equal(self.seed, readFileSync(join(REPO_ROOT, "plan", "seeds", "inbox-recommendations-2026-10-13.json"), "utf8"), "a self-target keeps reading its own seed");
  assert.equal(self.evidence.error, undefined, "the real self-target source must qualify successfully");
  assert.ok(self.evidence.tasks!.includes("W1-T10873") && self.evidence.tasks!.length > 1, "a self-target reads its actual Core plan");
  assert.notEqual(self.evidence.taskBlobs?.["W1-T1"], selected.evidence.taskBlobs?.["W1-T1"], "the same task ID in both repositories keeps its own source blob");
  assert.notEqual(self.evidence.repository, selected.evidence.repository);
});
