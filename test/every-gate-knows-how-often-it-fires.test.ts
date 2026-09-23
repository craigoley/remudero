/**
 * W1-T4115: every gate knows how often it fires. The CI-learning cadence already reads a paced
 * window of pull requests with each commit's gate rollup; from that same window it now ledgers,
 * per gate, how often it ran, refused, was repaired, was overridden and what it cost in minutes,
 * and the digest names the gates that never fire and the ones that always do.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { renderGateFireRates, summarizeGateFireRates, measureGateFireRates, gateFireRatesPath, type GateWindowPr } from "../src/lib/gate-fire-rate.js";
import { renderDigest, summarize } from "../src/lib/digest.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { buildCiLearningCadenceRunner } from "../src/run-task.js";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";

const SCRIPT = join(fileURLToPath(new URL("..", import.meta.url)), "scripts", "unwired-gate-check.mjs");
const { collectExecutingStrings, collectWiringText, isWired } = (await import(pathToFileURL(SCRIPT).href)) as {
  collectExecutingStrings: (doc: unknown) => string[];
  collectWiringText: (repoRoot: string) => string;
  isWired: (relPath: string, wiringText: string) => boolean;
};

const run = (name: string, conclusion: string, minutes = 1) => ({
  name,
  conclusion,
  startedAt: "2026-09-23T10:00:00Z",
  completedAt: new Date(Date.parse("2026-09-23T10:00:00Z") + minutes * 60_000).toISOString(),
});

/** Four gates with four different lives: repaired, overridden, never fired, always fired. */
function window(): { prs: GateWindowPr[] } {
  return {
    prs: [
      {
        number: 1,
        merged: true,
        commits: [
          { sha: "a1", rollup: [run("lint", "FAILURE"), run("quiet", "SUCCESS", 3), run("noisy", "FAILURE")] },
          { sha: "a2", rollup: [run("lint", "SUCCESS"), run("quiet", "SUCCESS", 3), run("noisy", "FAILURE")] },
        ],
      },
      {
        number: 2,
        merged: true,
        commits: [{ sha: "b1", rollup: [run("tests", "FAILURE", 10), run("quiet", "SUCCESS", 3), run("noisy", "FAILURE")] }],
      },
      {
        number: 3,
        merged: false,
        // A status context has no minutes of its own to charge.
        commits: [{ sha: "c1", rollup: [{ context: "remudero-review", state: "SUCCESS" }, run("quiet", "SUCCESS", 3)] }],
      },
    ],
  };
}

test("W1-T4115: each gate's fire and repair rate is ledgered", async () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t4115-`));
  const runner = buildCiLearningCadenceRunner({
    root,
    checkoutRoot: root,
    loadWindow: () => window() as never,
    fileShards: (() => ({ filed: [], skipped: [], refused: [] })) as never,
    planOrigins: [],
    pendingOrigins: () => [],
    mergedOrigins: () => [],
    loadLessons: () => ({ status: "measured", lessons: [] }) as never,
    recordFire: () => {},
  });
  const result = await runner();
  assert.equal(result.gateFireRates?.status, "measured");

  const rows = readFileSync(join(root, "state", "ledger.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
  const byGate = new Map(rows.filter((r) => r.step === "gate.fire_rate").map((r) => [r.gate as string, r]));
  assert.deepEqual([...byGate.keys()].sort(), ["lint", "noisy", "quiet", "remudero-review", "tests"]);
  assert.deepEqual(
    { runs: byGate.get("lint")!.runs, red: byGate.get("lint")!.red_runs, refusals: byGate.get("lint")!.refusals, repaired: byGate.get("lint")!.repaired },
    { runs: 2, red: 1, refusals: 1, repaired: 1 },
    "lint refused once and the same pull request repaired it",
  );
  assert.equal(byGate.get("tests")!.overridden, 1, "a red that merged unrepaired is an override");
  assert.equal(byGate.get("tests")!.minutes, 10);
  assert.equal(byGate.get("quiet")!.minutes, 12, "minutes add up across every observed run");
  assert.equal(byGate.get("remudero-review")!.minutes, 0, "a status context charges no minutes");
  const summary = rows.find((r) => r.step === "gate.fire_rates")!;
  // A gate seen on one pull request is measured but not named: one decision is not a rate.
  assert.deepEqual(summary.never_fired, ["quiet"]);
  assert.deepEqual(summary.always_fired, ["noisy"]);
  // The same measurement is kept whole for the gate gardener (W1-T4116) to read.
  const snapshot = JSON.parse(readFileSync(gateFireRatesPath(join(root, "state")), "utf8")) as { gates: Array<{ gate: string }> };
  assert.equal(snapshot.gates.length, 5);
});

test("W1-T4115: a window it could not read is never reported as gates that never fire", () => {
  const unread = measureGateFireRates({ prs: [{ number: 9, commits: [{ sha: "x" }] }] });
  assert.equal(unread.status, "unreadable");
  assert.deepEqual(unread.gates, []);
  const empty = measureGateFireRates({ prs: [] });
  assert.equal(empty.status, "empty");
  // Positive control: the same shape with one readable rollup is measured.
  assert.equal(measureGateFireRates({ prs: [{ number: 9, commits: [{ sha: "x", rollup: [run("g", "SUCCESS")] }] }] }).status, "measured");
});

test("W1-T4115: the digest names the gates that never fire and the ones that always do", () => {
  const report = measureGateFireRates(window());
  const at = "2026-09-23T11:00:00.000Z";
  const lines = report.gates.map((g) => ({ step: "gate.fire_rate", measured_at: at, ...g }));
  const summary = summarizeGateFireRates([...lines, { step: "gate.fire_rates", measured_at: at, status: "measured", never_fired: report.neverFired, always_fired: report.alwaysFired, gates: report.gates.length }]);
  assert.ok(summary);
  const text = renderGateFireRates(summary!);
  assert.match(text, /never refused.*quiet/);
  assert.match(text, /refused every run.*noisy/);
  assert.match(text, /most CI minutes: quiet 12m, tests 10m/);
  assert.equal(summarizeGateFireRates([]), undefined, "no measurement, no section");
  // Through the real digest: the section appears when the window holds a measurement, and not otherwise.
  const ts = "2026-09-23T11:00:01.000Z";
  const digest = renderDigest(summarize([...lines, { step: "gate.fire_rates", measured_at: at, status: "measured", never_fired: ["quiet"], always_fired: ["noisy"], gates: 5 }].map((l) => ({ ts, ...l })), "2026-09-23T00:00:00.000Z"));
  assert.match(digest, /## Gates \(5 measured\)/);
  assert.doesNotMatch(renderDigest(summarize([], "2026-09-23T00:00:00.000Z")), /## Gates/);
});

test("W1-T4115: a step behind if false is not counted as wired", () => {
  const doc = parseYaml(`
jobs:
  off:
    if: false
    steps:
      - run: node scripts/job-off-check.mjs
  on:
    runs-on: ubuntu-latest
    steps:
      - if: \${{ false }}
        run: node scripts/step-off-check.mjs
      - if: false
        run: node scripts/bare-false-check.mjs
      - if: github.event_name == 'push'
        run: node scripts/conditional-check.mjs
      - run: node scripts/plain-check.mjs
`);
  const wiring = collectExecutingStrings(doc).join("\n");
  assert.equal(isWired("scripts/job-off-check.mjs", wiring), false, "a job behind if: false runs nothing");
  assert.equal(isWired("scripts/step-off-check.mjs", wiring), false, "${{ false }} is false too");
  assert.equal(isWired("scripts/bare-false-check.mjs", wiring), false);
  assert.equal(isWired("scripts/conditional-check.mjs", wiring), true, "a real condition can run, so it stays wired");
  assert.equal(isWired("scripts/plain-check.mjs", wiring), true);
  // End to end through the file reader the gate itself uses.
  const repo = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t4115-wf-`));
  mkdirSync(join(repo, ".github", "workflows"), { recursive: true });
  writeFileSync(join(repo, ".github", "workflows", "x.yml"), "jobs:\n  a:\n    steps:\n      - if: false\n        run: node scripts/dead-check.mjs\n");
  writeFileSync(join(repo, "package.json"), "{}");
  assert.equal(isWired("scripts/dead-check.mjs", collectWiringText(repo)), false);
});
