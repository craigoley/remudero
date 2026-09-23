/**
 * W1-T4116: the gates tend themselves. A gate gardener (a gardener.ts spec) tightens a slack one-way
 * baseline, refreshes a stale one, and proposes demoting a required gate that never fires — the
 * last only for a person to decide. Every value comes from the ratchet's own measurement.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { gardenStatePath, readGardenState, runGarden, type GardenCheckout } from "../src/lib/gardener.js";
import {
  CI_GATE_YML,
  demoteInCiGate,
  demotionCandidate,
  editBaselineRow,
  GATE_GARDEN_CLASSES,
  gateGardenSpec,
  gateInventory,
  loadGateProbes,
  updateTally,
  type GateProbes,
} from "../src/lib/gate-gardener.js";
import type { GateFireRateReport } from "../src/lib/gate-fire-rate.js";
import type { DaemonDeps, DaemonSummary } from "../src/lib/daemon.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { daemonCommand } from "../src/run-task.js";
import { gitRepo } from "./helpers/git-repo.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const probesPromise = loadGateProbes(REPO_ROOT);

const CI_GATE = (rationale?: string) =>
  [
    "jobs:",
    "  ci-gate:",
    "    runs-on: ubuntu-latest",
    "    env:",
    "      REQUIRED: >-",
    "        [",
    '        "ci",',
    '        "quiet-gate",',
    '        "busy-gate"',
    "        ]",
    ...(rationale ? [`      GATE_RATIONALE: ${JSON.stringify(rationale)}`] : []),
    "      ADVISORY: >-",
    "        [",
    '        "dashboard"',
    "        ]",
    "",
  ].join("\n");

const gate = (name: string, over: Partial<GateFireRateReport["gates"][number]> = {}) => ({
  gate: name, prs: 10, runs: 20, redRuns: 0, refusals: 0, repaired: 0, overridden: 0, minutes: 30, ...over,
});

const REPORT = {
  measuredAt: "2026-09-23T00:00:00.000Z",
  status: "measured" as const,
  prsScanned: 10,
  gates: [gate("ci", { redRuns: 4, refusals: 3, repaired: 2, overridden: 1 }), gate("quiet-gate", { minutes: 90 }), gate("busy-gate", { redRuns: 20, refusals: 10, repaired: 10 })],
  neverFired: ["quiet-gate"],
  alwaysFired: ["busy-gate"],
};

/** The shared fixture repo, seeded with every surface the gardener measures, each holding one piece of work. */
function seededGates(opts: { ciGate?: string } = {}): string {
  const repo = gitRepo({ kind: "w1t4116" });
  const root = repo.dir;
  const put = (rel: string, text: string) => {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), text);
  };
  put("src/lib/a.ts", "export const a = 1;\n");
  put("scripts/source-size-baseline.json", JSON.stringify({ "src/lib/a.ts": 1000, "src/lib/gone.ts": 500 }, null, 2) + "\n");
  put("scripts/comment-load-baseline.json", JSON.stringify({ _comment: "ceilings", "src/lib/a.ts": 250 }, null, 2) + "\n");
  put("scripts/contract-coverage-baseline.json", '{\n  "_comment": "ceiling \\u2014 may fall",\n  "uncoveredCeiling": 5\n}\n');
  put("openapi/daemon.yaml", "paths:\n  /v1/status:\n    get: {}\n");
  put("learnings/core.yaml", "- id: one\n  fact: A fact.\n");
  put("scripts/learnings-budget-baseline.json", '{\n  "_comment": "cap \\u00a78A",\n  "measuredChars": 1,\n  "measuredActiveEntries": 9,\n  "capChars": 42000\n}\n');
  put(CI_GATE_YML, opts.ciGate ?? CI_GATE());
  mkdirSync(join(root, "state"));
  writeFileSync(join(root, "state", "gate-fire-rates.json"), JSON.stringify(REPORT, null, 2) + "\n");
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "seed");
  return root;
}

type Landed = { paths: string[]; title: string; body: string; review?: "operator" };
function checkout(root: string, landed: Landed[]): () => GardenCheckout {
  return () => ({ root, land: (opts) => (landed.push(opts), "https://github.com/acme/remudero/pull/88"), dispose: () => {} });
}
const deps = (root: string, landed: Landed[], prState?: () => "open" | "merged" | "closed") => ({
  stateDir: join(root, "state"),
  repoRoot: root,
  openWorkspace: checkout(root, landed),
  log: () => {},
  seed: 1,
  ...(prState ? { prState } : {}),
});
const off = (root: string, ...classes: string[]) => classes.forEach((c) => writeFileSync(join(root, "state", `GATE_OFF-${c}`), ""));

test("W1-T4116: a slack baseline is tightened to its measured value", async () => {
  const probes = await probesPromise;
  const root = seededGates();
  off(root, "refresh", "demote");
  const landed: Landed[] = [];
  const pass = runGarden(gateGardenSpec(deps(root, landed), probes), deps(root, landed));
  assert.deepEqual(pass.plan?.acting, ["tighten"]);
  const targets = pass.plan!.actions.map((a) => a.target).sort();
  assert.deepEqual(targets, ["scripts/contract-coverage-baseline.json#uncoveredCeiling", "scripts/source-size-baseline.json#src/lib/a.ts"]);
  // Each value is the one the ratchet itself records: a one-line file's source-size bucket, and
  // today's count of uncovered routes (the fixture's client sources call none).
  assert.equal(JSON.parse(readFileSync(join(root, "scripts/source-size-baseline.json"), "utf8"))["src/lib/a.ts"], 500);
  assert.match(readFileSync(join(root, "scripts/contract-coverage-baseline.json"), "utf8"), /"_comment": "ceiling \\u2014 may fall",\n {2}"uncoveredCeiling": 0\n/);
  assert.equal(landed[0]!.review, undefined, "a tightening lands for the fleet like any other change");
  assert.match(landed[0]!.body, /proof: grep: "src\/lib\/a\.ts": 500 in scripts\/source-size-baseline\.json/);
  assert.match(landed[0]!.body, /proof: grep: \^## Pass .*\$ in docs\/gate-garden-log\.md/);
  assert.ok(landed[0]!.paths.includes("docs/gate-garden-log.md"));
});

test("W1-T4116: a demotion is only proposed for operator review", async () => {
  const probes = await probesPromise;
  const root = seededGates();
  off(root, "tighten", "refresh");
  const landed: Landed[] = [];
  const spec = gateGardenSpec(deps(root, landed), probes);
  assert.deepEqual(Object.keys(spec.review ?? {}), ["demote"], "only demotion is a person's call");
  const base = readFileSync(join(root, CI_GATE_YML), "utf8");
  const pass = runGarden(spec, deps(root, landed));
  assert.deepEqual(pass.plan?.actions.map((a) => a.target), ["quiet-gate"]);
  assert.equal(landed[0]!.review, "operator", "a demotion opens for a person, never for auto-merge");
  assert.match(landed[0]!.body, /^\*\*Held for operator review\.\*\*/);
  const head = readFileSync(join(root, CI_GATE_YML), "utf8");
  const lists = (t: string) => probes.gm.readGateLists(t) as unknown as { required: Set<string> };
  assert.deepEqual([...lists(head).required].sort(), ["busy-gate", "ci"]);
  assert.match(head, /"dashboard",\n {8}"quiet-gate"\n {8}\]/);
  // The repo's own gate-monotonic check reads it as a REVIEWED demotion.
  assert.equal(probes.gm.evaluateGateMonotonic(probes.gm.readGateLists(base), probes.gm.readGateLists(head)).ok, true);
  // Judged by the decision alone: a closed PR debits the class.
  writeFileSync(join(root, "src/lib/a.ts"), "export const a = 2;\n");
  execFileSync("git", ["-C", root, "-c", "user.email=g@example.invalid", "-c", "user.name=g", "commit", "-qam", "move"], { stdio: "pipe" });
  runGarden(spec, deps(root, landed, () => "closed"));
  assert.deepEqual(readGardenState(gardenStatePath(join(root, "state"), "gate"), GATE_GARDEN_CLASSES).classes.demote, { alpha: 3, beta: 2 });
});

test("W1-T4116: a stale row is refreshed and the learnings headroom is left alone", async () => {
  const probes = await probesPromise;
  const root = seededGates();
  const inv = gateInventory(root, join(root, "state"), probes);
  const refresh = inv.candidates.filter((a) => a.class === "refresh").map((a) => a.target).sort();
  assert.deepEqual(refresh, [
    "scripts/learnings-budget-baseline.json#measuredActiveEntries",
    "scripts/learnings-budget-baseline.json#measuredChars",
    "scripts/source-size-baseline.json#src/lib/gone.ts",
  ]);
  off(root, "tighten", "demote");
  const landed: Landed[] = [];
  runGarden(gateGardenSpec(deps(root, landed), probes), deps(root, landed));
  assert.equal(JSON.parse(readFileSync(join(root, "scripts/source-size-baseline.json"), "utf8"))["src/lib/gone.ts"], undefined);
  const learnings = readFileSync(join(root, "scripts/learnings-budget-baseline.json"), "utf8");
  assert.match(learnings, /"measuredActiveEntries": 1,/);
  assert.match(learnings, /"capChars": 42000/, "the cap's headroom is deliberate");
});

test("W1-T4116: a demotion needs a readable window, a typical sample, and names the costliest quiet gate", () => {
  const required = new Set(["ci", "quiet-gate", "busy-gate", "cheap-quiet"]);
  assert.equal(demotionCandidate({ ...REPORT, status: "unreadable" }, required), undefined);
  assert.equal(demotionCandidate({ ...REPORT, gates: [...REPORT.gates, gate("cheap-quiet", { minutes: 5 })], neverFired: ["quiet-gate", "cheap-quiet"] }, required)?.target, "quiet-gate");
  // Seen on fewer pull requests than a typical gate: not enough to call it quiet.
  assert.equal(demotionCandidate({ ...REPORT, gates: [gate("ci"), gate("busy-gate"), gate("quiet-gate", { prs: 2 })] }, required), undefined);
  assert.equal(demotionCandidate(REPORT, new Set(["ci"])), undefined, "an advisory gate is never demoted again");
});

test("W1-T4116: the refusal tally only grows, once per measurement", () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t4116-tally-`));
  assert.deepEqual(updateTally(dir, undefined), { trials: 0, successes: 0 });
  assert.deepEqual(updateTally(dir, REPORT), { trials: 13, successes: 12 });
  assert.deepEqual(updateTally(dir, REPORT), { trials: 13, successes: 12 }, "the same measurement is folded once");
  assert.deepEqual(updateTally(dir, { ...REPORT, measuredAt: "2026-09-24T00:00:00.000Z" }), { trials: 26, successes: 24 });
});

test("W1-T4116: edits refuse what they cannot do exactly", async () => {
  const probes: GateProbes = await probesPromise;
  const roundTrip = JSON.stringify({ x: 1 }, null, 2) + "\n";
  assert.equal(editBaselineRow(roundTrip, "x", null), "{}\n");
  const escaped = '{\n  "_comment": "\\u2014",\n  "n": 3\n}\n';
  assert.throws(() => editBaselineRow(escaped, "missing", 1), /no numeric row/);
  assert.throws(() => editBaselineRow(escaped, "n", null), /cannot remove/);
  assert.throws(() => demoteInCiGate(CI_GATE(), "dashboard", "W1-T4116 x"), /not in a readable REQUIRED list/);
  // A rationale identical to the one already on main would be refused by gate-monotonic, so the pass fails.
  const rationale = demotionCandidate(REPORT, new Set(["quiet-gate"]))!.edit;
  assert.equal(rationale.kind, "demote");
  const root = seededGates({ ciGate: CI_GATE(rationale.kind === "demote" ? rationale.rationale : "") });
  off(root, "tighten", "refresh");
  assert.throws(() => runGarden(gateGardenSpec(deps(root, []), probes), deps(root, [])), /gate-monotonic would refuse/);
  assert.ok(!existsSync(join(root, "docs/gate-garden-log.md")));
});

test("W1-T4116: a self-hosting daemon wires the gate gardener", async () => {
  const home = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t4116-home-`));
  const root = join(home, "Remudero");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root }));
  mkdirSync(join(root, "state"), { recursive: true });
  // Every class off: the wired garden measures this repo's real gates but never opens a worktree.
  for (const c of GATE_GARDEN_CLASSES) writeFileSync(join(root, "state", `GATE_OFF-${c}`), "");
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
    const start = captured?.gardens?.[1];
    assert.ok(start, "a second garden is wired after the plan gardener");
    const stateFile = gardenStatePath(join(root, "state"), "gate");
    const garden = start!(60_000);
    for (let waited = 0; !existsSync(stateFile) && waited < 20_000; waited += 100) await new Promise((r) => setTimeout(r, 100));
    garden.stop();
    assert.ok(readGardenState(stateFile, GATE_GARDEN_CLASSES).lastPass, "the wired garden ran a pass over this repo's gates");
    // Stopped before its probes load, it never starts.
    const early = start!(60_000);
    early.stop();
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
  }
});
