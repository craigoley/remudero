/**
 * W1-T4112: the test suite tends itself. A test gardener (a gardener.ts spec) adopts a material
 * duration proposal, retiers a repeat flaker to the slow tier, and shrinks a stale one-way
 * baseline downward — every value read from scripts/test-tier-manifest.mjs's own functions or the
 * fleet's own ledger. All three are `review` classes: each is judged by whether its PR merges.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { gardenStatePath, readGardenState, runGarden, type GardenCheckout } from "../src/lib/gardener.js";
import {
  RETIER_THRESHOLD,
  TEST_GARDEN_CLASSES,
  loadTestManifestProbe,
  testGardenInventory,
  testGardenSpec,
  testManifestProposalPath,
} from "../src/lib/test-gardener.js";
import type { DaemonDeps, DaemonSummary } from "../src/lib/daemon.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { daemonCommand } from "../src/run-task.js";
import { gitRepo } from "./helpers/git-repo.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const probesPromise = loadTestManifestProbe(REPO_ROOT);

/** A fixture repo carrying a small, real test/ directory (so `listTestFiles` finds it on disk)
 *  and a committed test-tier-manifest.json — one file unmeasured, matching the real manifest's
 *  own `0`-placeholder shape. */
function seededSuite(): string {
  const repo = gitRepo({ kind: "w1t4112" });
  const root = repo.dir;
  const put = (rel: string, text: string) => {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), text);
  };
  put("test/a.test.ts", "export {};\n");
  put("test/b.test.ts", "export {};\n");
  put("test/c.test.ts", "export {};\n");
  put("test/d.test.ts", "export {};\n");
  put(
    "scripts/test-tier-manifest.json",
    JSON.stringify(
      { thresholdMs: 5000, files: { "test/a.test.ts": 100, "test/b.test.ts": 0, "test/c.test.ts": 50, "test/d.test.ts": 50 } },
      null,
      2,
    ) + "\n",
  );
  mkdirSync(join(root, "state"), { recursive: true });
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "seed");
  return root;
}

/** Two well-separated, already-MEASURED files on their own shards — no unmeasured placeholder to
 *  drag the median weighting around, so a small downward nudge to the lighter file is provably a
 *  sub-shard-boundary change: `proposalIsMaterial` sees no shard reassignment, and SHRINK-BASELINE
 *  (never materiality-gated) is the only class left with a row to claim. */
function seededMeasuredPair(): string {
  const repo = gitRepo({ kind: "w1t4112-pair" });
  const root = repo.dir;
  const put = (rel: string, text: string) => {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), text);
  };
  put("test/a.test.ts", "export {};\n");
  put("test/b.test.ts", "export {};\n");
  put("scripts/test-tier-manifest.json", JSON.stringify({ thresholdMs: 5000, files: { "test/a.test.ts": 1000, "test/b.test.ts": 10 } }, null, 2) + "\n");
  mkdirSync(join(root, "state"), { recursive: true });
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "seed");
  return root;
}

function writeProposal(root: string, files: Record<string, number>, thresholdMs = 5000): void {
  writeFileSync(testManifestProposalPath(join(root, "state")), JSON.stringify({ thresholdMs, files }, null, 2) + "\n");
}

type Landed = { paths: string[]; title: string; body: string };
function checkout(root: string, landed: Landed[]): () => GardenCheckout {
  return () => ({ root, land: (opts) => (landed.push(opts), "https://github.com/acme/remudero/pull/99"), dispose: () => {} });
}
const deps = (root: string, landed: Landed[], prState?: () => "open" | "merged" | "closed") => ({
  stateDir: join(root, "state"),
  repoRoot: root,
  openWorkspace: checkout(root, landed),
  log: () => {},
  seed: 1,
  ...(prState ? { prState } : {}),
});
const off = (root: string, ...classes: string[]) => classes.forEach((c) => writeFileSync(join(root, "state", `TEST_OFF-${c}`), ""));

test("W1-T4112: a material duration proposal is adopted and judged by shard skew", async () => {
  const probe = await probesPromise;
  const root = seededSuite();
  // A first real measurement for "test/b.test.ts" (was the `0` placeholder) is material on its
  // own, regardless of shard movement — test-tier-manifest.mjs's own `proposalIsMaterial` rule.
  writeProposal(root, { "test/a.test.ts": 100, "test/b.test.ts": 6000, "test/c.test.ts": 50, "test/d.test.ts": 50 });
  off(root, "retier-flaker", "shrink-baseline");
  const landed: Landed[] = [];
  const pass = runGarden(testGardenSpec(deps(root, landed), probe), deps(root, landed));
  assert.deepEqual(pass.plan?.acting, ["adopt-durations"]);
  assert.deepEqual(pass.plan!.actions.map((a) => a.target), ["scripts/test-tier-manifest.json#test/b.test.ts"]);
  assert.equal(pass.plan!.actions[0]!.edit.to, 6000);
  // Judged by SHARD SKEW: the reason names the slowest-shard skew before and after adopting.
  assert.match(pass.plan!.actions[0]!.reason, /narrows the slowest shard's skew from \d+ms to \d+ms/);
  assert.equal(JSON.parse(readFileSync(join(root, "scripts/test-tier-manifest.json"), "utf8")).files["test/b.test.ts"], 6000);
  assert.equal(landed.length, 1);
  assert.match(
    landed[0]!.body,
    /^\*\*Judged by its outcome\.\*\* The test gardener's `adopt-durations` changes are judged by whether this PR merges: adopting a fresh measurement over the committed one is judged by shard skew/,
  );
  assert.match(landed[0]!.body, /proof: grep: "test\/b\.test\.ts": 6000 in scripts\/test-tier-manifest\.json/);
});

test("W1-T4112: a non-material proposal shrinks a stale row downward instead", async () => {
  const probe = await probesPromise;
  const root = seededMeasuredPair();
  // A tiny downward nudge to the lighter, already well-separated file: no shard reassignment, so
  // ADOPT-DURATIONS (materiality-gated) sees nothing, and SHRINK-BASELINE claims the row instead.
  writeProposal(root, { "test/a.test.ts": 1000, "test/b.test.ts": 5 });
  off(root, "retier-flaker", "adopt-durations");
  const landed: Landed[] = [];
  const pass = runGarden(testGardenSpec(deps(root, landed), probe), deps(root, landed));
  assert.deepEqual(pass.plan?.acting, ["shrink-baseline"]);
  assert.deepEqual(pass.plan!.actions.map((a) => a.target), ["scripts/test-tier-manifest.json#test/b.test.ts"]);
  assert.equal(pass.plan!.actions[0]!.edit.to, 5);
  assert.match(pass.plan!.actions[0]!.reason, /Recorded 10ms; freshly measured 5ms — shrinking the manifest's total baseline size from \d+ms/);
  assert.equal(JSON.parse(readFileSync(join(root, "scripts/test-tier-manifest.json"), "utf8")).files["test/b.test.ts"], 5);
});

test("W1-T4112: a repeat flaker is retiered to the slow tier, judged by retry count", async () => {
  const probe = await probesPromise;
  const root = seededSuite();
  off(root, "adopt-durations", "shrink-baseline");
  const ledgerPath = join(root, "state", "ledger.ndjson");
  const row = (test: string) => JSON.stringify({ ts: "2026-09-24T00:00:00.000Z", step: "test.flake_retry", file: "test/c.test.ts", test, headline: "first attempt failed" });
  writeFileSync(ledgerPath, [row("one"), row("two"), row("three")].join("\n") + "\n");
  const inv = testGardenInventory(root, join(root, "state"), probe);
  assert.deepEqual(inv.candidates.map((a) => a.target), ["scripts/test-tier-manifest.json#test/c.test.ts"]);
  assert.equal(inv.candidates[0]!.edit.to, 5000, "retiered to the manifest's own slow threshold");
  assert.match(inv.candidates[0]!.reason, /Retried 3 time\(s\) so far/);
  const landed: Landed[] = [];
  runGarden(testGardenSpec(deps(root, landed), probe), deps(root, landed));
  assert.equal(JSON.parse(readFileSync(join(root, "scripts/test-tier-manifest.json"), "utf8")).files["test/c.test.ts"], 5000);
});

test("W1-T4112: fewer than the retry threshold, or already slow, retiers nothing", async () => {
  const probe = await probesPromise;
  const root = seededSuite();
  const stateDir = join(root, "state");
  const row = (file: string, test: string) => JSON.stringify({ step: "test.flake_retry", file, test });
  // Below RETIER_THRESHOLD.
  writeFileSync(join(stateDir, "ledger.ndjson"), Array.from({ length: RETIER_THRESHOLD - 1 }, (_, i) => row("test/c.test.ts", `t${i}`)).join("\n") + "\n");
  assert.deepEqual(testGardenInventory(root, stateDir, probe).candidates, []);
  // At the threshold, but the file is already committed at/above the slow threshold.
  writeFileSync(
    join(root, "scripts/test-tier-manifest.json"),
    JSON.stringify({ thresholdMs: 5000, files: { "test/a.test.ts": 100, "test/b.test.ts": 0, "test/c.test.ts": 9000, "test/d.test.ts": 50 } }, null, 2) + "\n",
  );
  writeFileSync(join(stateDir, "ledger.ndjson"), Array.from({ length: RETIER_THRESHOLD + 2 }, (_, i) => row("test/c.test.ts", `t${i}`)).join("\n") + "\n");
  assert.deepEqual(testGardenInventory(root, stateDir, probe).candidates, []);
});

test("W1-T4112: every class is a person's judgement call", async () => {
  const probe = await probesPromise;
  const root = seededSuite();
  const spec = testGardenSpec(deps(root, []), probe);
  assert.deepEqual(Object.keys(spec.review ?? {}).sort(), [...TEST_GARDEN_CLASSES].sort());
});

test("W1-T4112: a flake is ledgered, not only printed", () => {
  const SCRIPT = join(REPO_ROOT, "scripts", "test-with-retry.mjs");
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t4112-flake-ledger-`));
  const ledgerPath = join(dir, "ledger.ndjson");
  const marker = join(dir, "seen");
  const file = join(dir, "flaky.test.mjs");
  writeFileSync(
    file,
    [
      'import test from "node:test";',
      'import assert from "node:assert/strict";',
      'import { existsSync, writeFileSync } from "node:fs";',
      `test("ledgered flaky test", () => {`,
      `  if (!existsSync(${JSON.stringify(marker)})) {`,
      `    writeFileSync(${JSON.stringify(marker)}, "1");`,
      `    assert.fail("first pass");`,
      `  }`,
      `});`,
      "",
    ].join("\n"),
  );
  const result = spawnSync(process.execPath, [SCRIPT, process.execPath, "--test", "flaky.test.mjs"], {
    cwd: dir,
    encoding: "utf8",
    // NODE_TEST_CONTEXT (set by the outer `node --test` harness this file itself runs under)
    // otherwise leaks into the nested `--test` invocation below and suppresses its TAP output —
    // same fix test-with-retry.test.ts's own nested-real-test case already applies.
    env: { ...process.env, RMD_TEST_FLAKE_LEDGER: ledgerPath, NODE_TEST_CONTEXT: undefined },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /FLAKE-RETRY: first attempt failed — .*ledgered flaky test/, "the console line still prints");
  assert.ok(existsSync(ledgerPath), "a ledger row must exist -- not only the console line");
  const rows = readFileSync(ledgerPath, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.step, "test.flake_retry");
  assert.equal(rows[0]!.file, "flaky.test.mjs");
  assert.equal(rows[0]!.test, "ledgered flaky test");
  assert.equal(rows[0]!.headline, "first attempt failed");
  assert.equal(typeof rows[0]!.ts, "string");
});

test("W1-T4112: a self-hosting daemon wires the test gardener", async () => {
  const home = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t4112-home-`));
  const root = join(home, "Remudero");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root }));
  mkdirSync(join(root, "state"), { recursive: true });
  // Every class off: the wired garden measures this repo's real manifest but never opens a worktree.
  for (const c of TEST_GARDEN_CLASSES) writeFileSync(join(root, "state", `TEST_OFF-${c}`), "");
  const planPath = join(home, "tasks.yaml");
  writeFileSync(planPath, "[]\n");
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  let captured: DaemonDeps | undefined;
  try {
    await daemonCommand(["--allow-self-target", "--plan", planPath, "--max", "0"], {
      runDaemon: async (_plan, d): Promise<DaemonSummary> => {
        captured = d;
        return { attempted: [], merged: [], stopReason: "stopped", costUsd: 0, ticks: 0 };
      },
    });
    const start = captured?.gardens?.[2];
    assert.ok(start, "a third garden is wired after the plan and gate gardens");
    const stateFile = gardenStatePath(join(root, "state"), "test");
    const garden = start!(60_000);
    for (let waited = 0; !existsSync(stateFile) && waited < 20_000; waited += 100) await new Promise((r) => setTimeout(r, 100));
    garden.stop();
    assert.ok(readGardenState(stateFile, TEST_GARDEN_CLASSES).lastPass, "the wired garden ran a pass over this repo's real manifest");
    // Stopped before its probe loads, it never starts.
    const early = start!(60_000);
    early.stop();
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
  }
});
