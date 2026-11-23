import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { fixedClock } from "#src/lib/clock.js";
import { gardenStatePath, readGardenState, runGardenAsync, type GardenerDeps, type GardenLandOpts } from "#src/lib/gardener.js";
import { parseTasksFromYaml } from "#src/lib/plan.js";
import { PR_OPEN_SATISFIED_BY_MAIN_STEP } from "#src/lib/pr-open.js";
import { REDESIGN_JUDGED_STEP, REDESIGN_MARKER_RE, redesignGardenSpec } from "#src/lib/redesign-gardener.js";

const ID = "W1-T100";
const SHARD = `plan/tasks.d/${ID}-example.yaml`;
const SOURCE = "src/lib/example.ts";
const TEST = "test/example.test.ts";
const FOCUSED_TEST = "test/gardeners/example.test.ts";
const NOW = fixedClock(Date.parse("2026-11-23T12:00:00Z"));
const REASON = "The replacement already implements both acceptance claims.";
const answer = (value: object) => `REDESIGN: ${JSON.stringify(value)}`;
const retire = (retirement = "closed") => answer({ verdict: "retire", retirement, reason: REASON });

const RECORD = [
  `- id: ${ID}`,
  "  title: implement both replacement paths",
  "  repo: remudero",
  "  type: implement",
  "  verify: auto",
  "  risk: low",
  "  priority: 1.3",
  "  depends_on: [W1-T99]",
  `  # refusal-amendment (${ID}, run run-example, 2026-11-23T08:00:00.000Z): the worker refused criterion 1 [premise-rotted] — proposed close-unbuilt`,
  "  status: queued",
  "  attempts: 1",
  "  files:",
  `    - ${SOURCE}`,
  `    - ${TEST}`,
  "  acceptance:",
  "    - claim: the first replacement path works",
  `      proof: "grep: function first in ${SOURCE}"`,
  "    - claim: the second replacement path works",
  `      proof: "grep: function second in ${SOURCE}"`,
  "",
].join("\n");

function fixture(t: TestContext, response = retire(), beforeCheckout?: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "rmd-redesign-retire-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, "state");
  for (const dir of ["plan/tasks.d", "src/lib", "test", "state"]) mkdirSync(join(root, dir), { recursive: true });
  const write = (path: string, text: string) => writeFileSync(join(root, path), text);
  const shard = () => readFileSync(join(root, SHARD), "utf8");
  const task = () => parseTasksFromYaml(shard(), SHARD)[0]!;
  const git = (...args: string[]) => execFileSync("git", [
    "-c", "user.name=redesign fixture", "-c", "user.email=redesign@example.test", "-c", "commit.gpgsign=false", ...args,
  ], { cwd: root, stdio: "pipe", env: {
    ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_COMMITTER_DATE: NOW.iso(),
  } });
  const commit = (subject: string, onMain = true) => {
    git("add", "plan", "src", "test");
    git("commit", "--quiet", "--date", NOW.iso(), "-m", subject);
    if (onMain) git("update-ref", "refs/remotes/origin/main", "HEAD");
  };
  write(SHARD, RECORD);
  write(SOURCE, "export {};\n");
  write(TEST, "export {};\n");
  git("init", "--quiet");
  commit("file the task");
  const landed: GardenLandOpts[] = [];
  const rows: Array<Record<string, unknown>> = [];
  const prompts: string[] = [];
  const deps: GardenerDeps = {
    repoRoot: root, stateDir, clock: NOW, seed: 1,
    log: (step, fields) => { rows.push({ step, ...fields }); },
    mergedPlanLint: () => undefined,
    openWorkspace: () => {
      beforeCheckout?.(root);
      return { root, land: (opts) => { landed.push(opts); return "https://example.test/pull/100"; }, dispose: () => {} };
    },
  };
  const filed = task();
  const spec = redesignGardenSpec(deps, {
    plan: () => ({ open: [filed], all: [filed], shards: new Map([[ID, SHARD]]) }),
    judgeText: async (prompt) => { prompts.push(prompt); return response; },
  });
  const satisfy = (taskId = ID) => write("state/ledger.ndjson", JSON.stringify({
    step: PR_OPEN_SATISFIED_BY_MAIN_STEP, ts: NOW.iso(), task_id: taskId,
    branch: `run-${taskId}-100`, head_sha: "a".repeat(40), changed_files: [TEST],
  }) + "\n");
  const proofs = () => write(SOURCE, "export function first() {}\nexport function second() {}\n");
  return { write, shard, task, commit, landed, rows, prompts, stateDir, run: () => runGardenAsync(spec, deps), satisfy, proofs };
}

test("W1-T13397 criterion 1: a confirmed retirement lands through the redesign plan PR", async (t) => {
  const w = fixture(t);
  const before = w.task();
  w.proofs();
  w.commit("implement both paths");
  await w.run();

  assert.equal(w.prompts.length, 1);
  assert.match(w.prompts[0]!, /"verdict":"retire"/);
  assert.deepEqual(w.task(), { ...before, status: "blocked", retirement: "closed" });
  assert.ok(w.shard().includes(REASON));
  const marker = w.shard().split("\n").map((line) => REDESIGN_MARKER_RE.exec(line)).find(Boolean);
  assert.ok(marker);
  assert.equal(w.landed.length, 1);
  assert.deepEqual(w.landed[0]!.paths, [SHARD]);
  assert.match(w.landed[0]!.title, /the Architect retires W1-T100/);
  assert.ok(w.landed[0]!.body.includes(REASON));
  assert.ok(w.landed[0]!.body.includes(`proof: "grep: # redesign: signature=${marker[1]} in ${SHARD}"`));
  const pending = readGardenState(gardenStatePath(w.stateDir, "redesign"), ["amend", "retire"]).pending;
  assert.deepEqual(pending?.targets?.[0], { class: "retire", target: marker[1] });
});

test("W1-T13397 criterion 2: a recorded build satisfied by main confirms retirement", async (t) => {
  const w = fixture(t);
  w.satisfy();
  await w.run();
  assert.equal(w.task().retirement, "closed");
  assert.match(w.landed[0]!.body, /run-W1-T100-100/);
});

test("W1-T13397 criterion 2: a merged replacement covers the surface and satisfies every proof", async (t) => {
  const w = fixture(t, retire("withdrawn"));
  w.proofs();
  w.write(TEST, "export const passed = true;\n");
  w.commit("merge the replacement (#123)");
  await w.run();
  assert.equal(w.task().retirement, "withdrawn");
  assert.match(w.landed[0]!.body, /Merged commit [a-f0-9]{40} covered its declared surface/);
});

test("W1-T13397 criterion 2: merged paths, another task's build and unmerged proofs cannot retire a task", async (t) => {
  const w = fixture(t);
  w.write(SOURCE, "export function first() {}\n");
  w.write(TEST, "export const passed = true;\n");
  w.commit("merge unrelated work on the same paths (#123)");
  w.proofs();
  w.commit("finish the other path on a local branch", false);
  w.satisfy("W1-T101");
  await w.run();

  assert.equal(w.shard(), RECORD);
  assert.deepEqual(w.landed, []);
  const verdict = w.rows.find((row) => row.step === REDESIGN_JUDGED_STEP);
  assert.equal(verdict?.outcome, "refused");
  assert.match(String(verdict?.reason), /origin\/main does not confirm/);
});

test("a malformed retirement answer is unparseable and a changed contract cannot land", async (t) => {
  const malformed = fixture(t, retire("merged"));
  malformed.satisfy();
  await malformed.run();
  assert.equal(malformed.shard(), RECORD);
  assert.equal(malformed.rows.find((row) => row.step === REDESIGN_JUDGED_STEP)?.outcome, "unparseable");

  const updated = RECORD.replace("the second replacement path works", "a new claim applies");
  const stale = fixture(t, retire(), (root) => writeFileSync(join(root, SHARD), updated));
  stale.satisfy();
  await stale.run();
  assert.equal(stale.shard(), updated);
  assert.deepEqual(stale.landed, []);
  const refusal = stale.rows.find((row) => row.step === REDESIGN_JUDGED_STEP);
  assert.match(String(refusal?.reason), /shard changed/);
  assert.equal(refusal?.retryable, true);
});

test("a stale inventory cannot retire an already blocked shard again", async (t) => {
  const w = fixture(t);
  const retired = RECORD.replace("  status: queued", "  status: blocked\n  retirement: closed");
  w.write(SHARD, retired);
  w.satisfy();
  await w.run();

  assert.equal(w.shard(), retired);
  assert.deepEqual(w.landed, []);
  const verdict = w.rows.find((row) => row.step === REDESIGN_JUDGED_STEP);
  assert.equal(verdict?.outcome, "refused");
  assert.match(String(verdict?.reason), /needs one queued task/);
});

test("W1-T13397 criterion 3: an amendment retains ordered claims and can only grow its files", async (t) => {
  const w = fixture(t, answer({
    verdict: "amend", reason: "Use the focused test", amendment: "Build both paths.\nstatus: blocked",
    status: "blocked", priority: 9, verify: "human", depends_on: [], claims: ["replace both claims"],
    files_add: [FOCUSED_TEST],
    proofs: [{ criterion: 2, proof: "unit test: the focused test checks the second path", claim: "replace the second claim" }],
  }));
  const before = w.task();
  await w.run();

  const after = w.task();
  assert.equal(w.landed.length, 1, JSON.stringify(w.rows));
  assert.deepEqual(after.acceptance?.map((item) => item.claim), before.acceptance?.map((item) => item.claim));
  assert.deepEqual(after.files, [...before.files!, FOCUSED_TEST]);
  assert.equal(after.acceptance?.[1]?.proof, "unit test: the focused test checks the second path");
  assert.equal(after.status, before.status);
  assert.equal(after.priority, before.priority);
  assert.equal(after.verify, before.verify);
  assert.deepEqual(after.depends_on, before.depends_on);
});
