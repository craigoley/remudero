// OBSERVED 2026-10-09 on the fleet host, per hour: selector-shadow passed 42 times (about 35 s each) and 5 of those
// passes saw a new CI run; machine-judge passed 43 times and ledgered nothing; evidence-coverage passed 48 times
// against one measuring pass every six hours. None of them had a due probe, so every 60 s poll booted a child.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { clockFromMillisFn } from "../src/lib/clock.js";
import { EVIDENCE_COVERAGE_PASS_INTERVAL_MS, evidenceCoveragePassDue, evidenceCoverageStatePath } from "../src/lib/evidence-coverage-gardener.js";
import {
  GARDEN_QUIET_BACKOFF_DIVISOR, gardenPacingDue, gardenPacingPath, readGardenPacing, recordGardenPacing, selectorShadowGardenPass,
} from "../src/lib/garden-registry.js";
import { machineJudgeFoundWork, machineJudgeInputs } from "../src/lib/machine-filing-judge.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { gitRepo } from "./helpers/git-repo.js";

const MINUTE = 60_000;

function scratch(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}garden-pacing-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("a paced garden that finds nothing new waits a growing share of its quiet span and snaps back when a pass finds something", (t) => {
  const dir = scratch(t);
  let now = Date.parse("2026-10-09T12:00:00Z");
  const clock = clockFromMillisFn(() => now);
  const due = () => gardenPacingDue(dir, "selector-shadow", { clock });
  assert.equal(due(), true, "a garden never paced is due");

  // Poll every minute, as the daemon does, and count the passes an idle hour costs.
  recordGardenPacing(dir, "selector-shadow", true, { clock });
  let passes = 0;
  const waits: number[] = [];
  let lastPass = now;
  for (let minute = 1; minute <= 60; minute++) {
    now += MINUTE;
    if (!due()) continue;
    passes += 1;
    waits.push(now - lastPass);
    lastPass = now;
    recordGardenPacing(dir, "selector-shadow", false, { clock });
  }
  assert.ok(passes < 20, `an idle hour costs ${passes} passes, not 60`);
  assert.ok(waits.at(-1)! > waits[0]!, "the wait grows while nothing is found");
  const pacing = readGardenPacing(dir, "selector-shadow")!;
  const quiet = Date.parse(pacing.lastPassAt) - Date.parse(pacing.lastNewAt);
  assert.ok(now - Date.parse(pacing.lastPassAt) < quiet / GARDEN_QUIET_BACKOFF_DIVISOR || due(), "the wait is a share of the quiet span");

  // A pass that finds something snaps the garden back to every poll.
  now = Date.parse(pacing.lastPassAt) + quiet / GARDEN_QUIET_BACKOFF_DIVISOR;
  assert.equal(due(), true);
  recordGardenPacing(dir, "selector-shadow", true, { clock });
  now += MINUTE;
  assert.equal(due(), true, "after a find the next poll runs a pass");

  // Changed inputs are due at once, however long the quiet.
  recordGardenPacing(dir, "machine-judge", true, { clock, inputs: "tree-a" });
  now += 60 * MINUTE;
  recordGardenPacing(dir, "machine-judge", false, { clock, inputs: "tree-a" });
  now += MINUTE;
  assert.equal(gardenPacingDue(dir, "machine-judge", { clock, inputs: () => "tree-a" }), false, "an hour quiet waits thirty minutes");
  assert.equal(gardenPacingDue(dir, "machine-judge", { clock, inputs: () => "tree-b" }), true, "a new plan tree is due now");

  writeFileSync(gardenPacingPath(dir, "machine-judge"), "{ damaged");
  assert.equal(readGardenPacing(dir, "machine-judge"), undefined);
  assert.equal(gardenPacingDue(dir, "machine-judge", { clock }), true, "a damaged record never slows a garden");
  writeFileSync(gardenPacingPath(dir, "machine-judge"), JSON.stringify({ lastPassAt: pacing.lastPassAt, lastNewAt: pacing.lastNewAt, inputs: 7 }));
  assert.equal(readGardenPacing(dir, "machine-judge"), undefined, "a malformed inputs stamp is no record");
});

test("the selector-shadow pass exposes its paced due probe", (t) => {
  const dir = scratch(t);
  let now = Date.parse("2026-10-09T12:00:00Z");
  const clock = clockFromMillisFn(() => now);
  const pass = selectorShadowGardenPass({ stateDir: dir, repoRoot: dir, clock, openWorkspace: () => { throw new Error("unused"); }, log: () => {} },
    "o", "r", () => "W1-T1");
  assert.equal(pass.due(), true);
  recordGardenPacing(dir, "selector-shadow", true, { clock });
  now += 40 * MINUTE;
  recordGardenPacing(dir, "selector-shadow", false, { clock });
  now += MINUTE;
  assert.equal(pass.due(), false, "forty quiet minutes wait twenty");
});

test("evidence-coverage is due only once its six-hour interval has passed", (t) => {
  const dir = scratch(t);
  const now = Date.parse("2026-10-09T12:00:00Z");
  const clock = clockFromMillisFn(() => now);
  assert.equal(evidenceCoveragePassDue(dir, clock), true, "no state yet");
  const write = (lastPassAt: unknown) => writeFileSync(evidenceCoverageStatePath(dir), JSON.stringify({ version: 1, cells: {}, lastPassAt }));
  write(new Date(now - MINUTE).toISOString());
  assert.equal(evidenceCoveragePassDue(dir, clock), false, "measured a minute ago");
  write(new Date(now - EVIDENCE_COVERAGE_PASS_INTERVAL_MS).toISOString());
  assert.equal(evidenceCoveragePassDue(dir, clock), true, "the interval has passed");
  write("not a timestamp");
  assert.equal(evidenceCoveragePassDue(dir, clock), true, "an unparseable stamp runs, as the pass itself would");
  writeFileSync(evidenceCoverageStatePath(dir), "{ damaged");
  assert.equal(evidenceCoveragePassDue(dir, clock), true, "an unreadable state runs, and the pass logs it");
});

test("the machine judge's inputs stamp follows its plan tree and operator releases, and only judged work is new", (t) => {
  const repo = gitRepo({ kind: "machine-judge-inputs" });
  t.after(() => repo.cleanup());
  mkdirSync(join(repo.dir, "plan"), { recursive: true });
  writeFileSync(join(repo.dir, "plan", "policy.yaml"), "rules: []\n");
  repo.git("add", "plan/policy.yaml");
  repo.git("commit", "--quiet", "-m", "seed the plan tree");
  const stateDir = scratch(t);
  const stamp = machineJudgeInputs(repo.dir, stateDir);
  assert.match(stamp, /^[0-9a-f]{40}:absent$/, "the plan tree's id and no releases yet");
  writeFileSync(join(stateDir, "operator-releases.json"), JSON.stringify({ releases: { "W1-T1": "2026-10-09T12:00:00Z" } }));
  assert.notEqual(machineJudgeInputs(repo.dir, stateDir), stamp, "an operator release changes the stamp");
  assert.equal(machineJudgeInputs(join(stateDir, "no-such-checkout"), stateDir).startsWith("unreadable:"), true);

  const empty = { proceeded: [], escalated: [], unavailable: [], refused: [], failed: [], settled: [] };
  assert.equal(machineJudgeFoundWork(empty), false);
  assert.equal(machineJudgeFoundWork({ ...empty, unavailable: ["W1-T1"], failed: ["W1-T2"] }), false, "an unavailable judge is not new work");
  assert.equal(machineJudgeFoundWork({ ...empty, proceeded: ["W1-T1"] }), true);
  assert.equal(machineJudgeFoundWork({ ...empty, prUrl: "https://github.com/o/r/pull/1" }), true);
});

test("a selector-shadow pass whose pacing cannot be recorded logs it and still finishes", async (t) => {
  const dir = scratch(t);
  const blocker = join(dir, "not-a-directory");
  writeFileSync(blocker, "");
  const steps: string[] = [];
  const pass = selectorShadowGardenPass({ stateDir: join(blocker, "state"), repoRoot: dir, openWorkspace: () => { throw new Error("unused"); }, log: (step) => void steps.push(step) },
    "o", "r", () => "W1-T1", { readJson: async () => { throw new Error("GitHub is unreachable"); }, readText: async () => "" });
  await pass();
  assert.ok(steps.includes("selector-shadow.gardener_failed"), "the unreadable runs are reported");
  assert.ok(steps.includes("selector-shadow.pacing_failed"), "an unwritable pacing record is reported, not thrown");
});
