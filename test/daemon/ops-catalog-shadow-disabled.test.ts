import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
// The daemon and the live analytics cache import each other; the cache loads first (see the W1-T11769 tests).
import "#src/lib/live-analytics-snapshot-cache.js";
import { runDaemon, type DaemonDeps } from "#src/lib/daemon.js";
import { createDaemonMemoryGovernor } from "#src/lib/daemon-memory-policy.js";
import type { OpsCatalogApi } from "#src/lib/ops-catalog-source.js";
import type { Plan } from "#src/lib/plan.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { ghShim } from "#test/helpers/gh-shim.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { daemonCommand } from "#test/helpers/run-task-daemon.js";

// W1-T11770 criterion 1: without --shadow-ops-catalog the daemon command builds no ops source, makes no ops read
// and passes neither W1-T11769 seam. An invalid slug exits 2 before anything spawns.

type CommandDeps = NonNullable<Parameters<typeof daemonCommand>[1]>;
const SLUG = "fixture-private/ops";
const SHADOW_SEAMS = ["secondaryCatalogShadowSource", "primaryPlanCommit"];
const PLAN_YAML = ["PUB-A", "PUB-B", "PUB-C"].map((id) =>
  `- id: ${id}\n  title: public ${id}\n  repo: remudero\n  type: implement\n  verify: auto\n  depends_on: []\n  status: queued\n`).join("");

interface Outcome {
  code: number;
  deps: DaemonDeps | undefined;
  booted: number;
  opsReads: string[];
  ghCalls: string[];
  ledgerSteps: string[];
  shadowRows: number;
  ran: string[];
}

/** Drive the real `runDaemon` loop with the seams the command wired, so a wired seam would be read. */
async function driveLoop(plan: Plan, wired: DaemonDeps): Promise<{ ran: string[]; shadowRows: number }> {
  const merged = new Set<string>();
  const ran: string[] = [];
  let shadowRows = 0;
  await runDaemon(plan, {
    refreshMerged: () => (id) => merged.has(id), targetRepo: "remudero",
    runOne: async (id) => {
      ran.push(id);
      merged.add(id);
      await delay(5);
      return { taskId: id, runId: `${id}-run`, merged: true, costUsd: 0, verdict: "merged" };
    },
    sleep: async () => {},
    log: (step) => { if (step === "dispatch.secondary_catalog_shadow") shadowRows++; },
    memoryGovernor: createDaemonMemoryGovernor({ read: () => ({ rss_bytes: 1 }), setFlags: () => {}, heapUsed: () => 1 }),
    heapStatistics: () => ({ used_heap_size: 1, heap_size_limit: 1_000_000_000 }),
    now: () => new Date(Date.UTC(2026, 0, 1)),
    bootCheckoutBlocked: "",
    ...(wired.secondaryCatalogShadowSource ? { secondaryCatalogShadowSource: wired.secondaryCatalogShadowSource } : {}),
    ...(wired.primaryPlanCommit ? { primaryPlanCommit: wired.primaryPlanCommit } : {}),
  }, { max: 3 });
  return { ran, shadowRows };
}

/** One `daemonCommand` run over a disposable root, with a recording ops api and a recording `gh`. */
async function run(extraArgs: string[]): Promise<Outcome> {
  const home = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}ops-shadow-off-`));
  const root = join(home, "Remudero");
  mkdirSync(join(root, "state"), { recursive: true });
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ root, claudeBin: "/bin/true" }));
  const planPath = join(home, "tasks.yaml");
  writeFileSync(planPath, PLAN_YAML);
  const shim = ghShim([{ when: "", exit: 1, stderr: "fixture: GitHub is unavailable" }], { kind: "ops-shadow-off-gh" });
  const oldHome = process.env.HOME;
  const oldPath = process.env.PATH;
  process.env.HOME = home;
  process.env.PATH = `${shim.dir}:${oldPath ?? ""}`;
  const opsReads: string[] = [];
  const opsCatalogApi: OpsCatalogApi = async (path) => { opsReads.push(path); throw new Error("fixture: no ops repository"); };
  let booted = 0;
  let captured: DaemonDeps | undefined;
  let loop: { ran: string[]; shadowRows: number } = { ran: [], shadowRows: 0 };
  const deps: CommandDeps = {
    config: { root, claudeBin: "/bin/true" }, repoRoot: REPO_ROOT, opsCatalogApi,
    githubFactory: () => ({}) as never,
    startGithubAppRefresh: () => ({ armed: false }),
    applyMemoryPolicy: () => ({ heap_growing_percent: 10 }),
    daemonBoot: async () => {
      booted++;
      return { env_clean: true, billing_mode: "subscription", node_path: process.execPath, node_version: process.version };
    },
    checkPause: () => undefined, checkStop: () => undefined, readRunChildMode: () => "off",
    bootClaimReserver: { mintAnchor: () => "fixture", attempt: () => "unreachable", holder: () => undefined, drop: () => false, list: () => [] },
    buildSweepHook: () => async () => {}, buildSweepLightHook: () => async () => {},
    runDaemon: async (plan, wired) => {
      captured = wired;
      await delay(5);
      loop = await driveLoop(plan, wired);
      await delay(5);
      return { attempted: [], merged: [], stopReason: "stopped", costUsd: 0, ticks: 0 };
    },
  };
  try {
    const code = await daemonCommand(["--allow-self-target", "--plan", planPath, "--max", "0", ...extraArgs], deps);
    let ledgerSteps: string[] = [];
    try {
      ledgerSteps = readFileSync(join(root, "state", "ledger.ndjson"), "utf8").trim().split("\n")
        .filter((line) => line.length > 0).map((line) => String(JSON.parse(line).step));
    } catch (error) {
      // An exit before the first ledger row leaves no ledger; the case asserts on the empty list.
      void error;
    }
    return { code, deps: captured, booted, opsReads, ghCalls: shim.calls(), ledgerSteps, ...loop };
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    rmSync(shim.dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}

test("W1-T11770 criterion 1: without the flag no ops source is built or read and neither seam is passed", async () => {
  const off = await run([]);
  assert.equal(off.code, 0);
  assert.ok(off.deps, "positive control: the command reached its runDaemon call");
  assert.equal(off.opsReads.length, 0, "no ops read is made without the flag");
  for (const seam of SHADOW_SEAMS) assert.equal(seam in off.deps!, false, `${seam} is not passed without the flag`);
  assert.equal(off.shadowRows, 0, "the real loop writes no shadow row");
  assert.deepEqual(off.ran, ["PUB-A", "PUB-B", "PUB-C"]);
  assert.equal(off.ghCalls.some((call) => call.includes(SLUG)), false);

  // The flag adds exactly the two seams and nothing else; every other key, row and gh call is the same.
  const on = await run(["--shadow-ops-catalog", SLUG]);
  assert.equal(on.code, 0);
  assert.ok(on.opsReads.length > 0, "positive control: with the flag the command reads the ops source");
  const keysOff = Object.keys(off.deps!).sort();
  const keysOn = Object.keys(on.deps!).filter((key) => !SHADOW_SEAMS.includes(key)).sort();
  assert.deepEqual(keysOn, keysOff, "the runDaemon deps keys are the same apart from the two seams");
  assert.deepEqual(on.ledgerSteps, off.ledgerSteps, "the command writes the same ledger rows");
  assert.deepEqual(on.ghCalls, off.ghCalls, "the command makes the same gh calls");
  assert.deepEqual(on.ran, off.ran, "dispatch is the same");
});

test("W1-T11770 criterion 1: an invalid --shadow-ops-catalog slug exits 2 before any spawn", async () => {
  const invalid: string[][] = [
    ["--shadow-ops-catalog"], ["--shadow-ops-catalog", ""], ["--shadow-ops-catalog", "owner"],
    ["--shadow-ops-catalog", "a/b/c"], ["--shadow-ops-catalog", "../ops"], ["--shadow-ops-catalog", "owner/.."],
    ["--shadow-ops-catalog", "owner/."], ["--shadow-ops-catalog", "owner/a..b"], ["--shadow-ops-catalog", "-owner/ops"],
    ["--shadow-ops-catalog", "https://github.com/owner/ops"], ["--shadow-ops-catalog", "owner/ops?ref=x"],
    ["--shadow-ops-catalog", "owner/ops name"], ["--shadow-ops-catalog", "--max"],
  ];
  for (const args of invalid) {
    const outcome = await run(args);
    const label = JSON.stringify(args);
    assert.equal(outcome.code, 2, `${label} exits 2`);
    assert.equal(outcome.deps, undefined, `${label} never reaches runDaemon`);
    assert.equal(outcome.booted, 0, `${label} never boots`);
    assert.equal(outcome.opsReads.length, 0, `${label} makes no ops read`);
    assert.deepEqual(outcome.ghCalls, [], `${label} makes no gh call`);
  }
  const valid = await run(["--shadow-ops-catalog", "Owner-1/ops.catalog_2"]);
  assert.equal(valid.code, 0, "positive control: a valid slug runs");
  assert.ok(valid.deps);
});
