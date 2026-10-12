/**
 * W1-T5894 — one plan change is one git read for every thread. `publishThreadPlan` broadcast only the pin, so each
 * subscribed thread ran its own `readServePlanAtRef` of the same commit: five threads cost ~50 s of git per merge on
 * the host. Main now reads once and every thread parses the blobs it was handed. A `git` on PATH that records each
 * invocation counts the plan reads across main, the reload worker and every thread.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { threadId, Worker } from "node:worker_threads";

import { loadPlan, type Plan } from "../src/lib/plan.js";
import { packPlanBlobs, reloadServePlan } from "../src/lib/serve-plan-reload.js";
import { adoptThreadPlan, PLAN_PIN_ADOPTED_STEP, publishThreadPlan, threadPlanPin, threadStrictPlan } from "../src/lib/thread-plan.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { gitRepo } from "./helpers/git-repo.js";

type Row = [string, Record<string, unknown>];
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const record = (id: string): string => [
  `- id: ${id}`, "  title: one read fixture", "  repo: remudero", "  depends_on: []",
  "  type: implement", "  verify: auto", "  status: queued", "  attempts: 0", "",
].join("\n");

/** A generation slot: the working tree stays at the first commit while a later plan-only commit exists. */
function planSlot(): { dir: string; planPath: string; shas: string[] } {
  const repo = gitRepo();
  mkdirSync(join(repo.dir, "plan", "tasks.d"), { recursive: true });
  const planPath = join(repo.dir, "plan", "tasks.yaml");
  const shas: string[] = [];
  for (const ids of [["W1-T1"], ["W1-T1", "W1-T2"]]) {
    writeFileSync(planPath, ids.map(record).join(""));
    writeFileSync(join(repo.dir, "plan", "tasks.d", "W1-T9.yaml"), record("W1-T9"));
    repo.git("add", "plan");
    repo.git("commit", "-q", "-m", `plan ${ids.length}`);
    shas.push(repo.git("rev-parse", "HEAD"));
  }
  repo.git("reset", "-q", "--hard", shas[0]!);
  return { dir: repo.dir, planPath, shas };
}

/** Puts a `git` first on PATH that appends its argv to a file, then runs the real git; returns the plan-read count. */
function countGitPlanReads(t: { after(fn: () => void): void }): () => number {
  const bin = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}one-plan-read-bin-`));
  const calls = join(bin, "calls.log");
  writeFileSync(calls, "");
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  writeFileSync(join(bin, "git"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\nexec '${realGit}' "$@"\n`);
  chmodSync(join(bin, "git"), 0o755);
  const priorPath = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${priorPath ?? ""}`;
  t.after(() => void (process.env.PATH = priorPath));
  return () => readFileSync(calls, "utf8").split("\n").filter((line) => / show \S+:plan\/tasks\.yaml$/.test(line)).length;
}

function viewThread(t: { after(fn: () => void): void }, fixture: ReturnType<typeof planSlot>): () => Promise<string[]> {
  const view = new Worker(new URL("./helpers/plan-pin-view-thread.ts", import.meta.url), { workerData: { planPath: fixture.planPath, ledgerDir: fixture.dir, ids: ["W1-T1", "W1-T2", "W1-T9"] } });
  t.after(() => void view.terminate());
  return async () => {
    const answer = new Promise<string[]>((resolve) => view.once("message", resolve));
    view.postMessage("build");
    return answer;
  };
}

async function until<T>(read: () => T | Promise<T>, done: (value: T) => boolean, label: string): Promise<T> {
  const deadline = Date.now() + 15_000;
  let value = await read();
  while (!done(value)) {
    if (Date.now() > deadline) assert.fail(`${label}: last read ${JSON.stringify(value)}`);
    await sleep(25);
    value = await read();
  }
  return value;
}

const adoptions = (rows: Row[]): Array<Record<string, unknown>> => rows.filter(([step]) => step === PLAN_PIN_ADOPTED_STEP).map(([, row]) => row);

test("one plan change published to N subscribed worker threads performs exactly one git read of the plan at that ref", async (t) => {
  const reads = countGitPlanReads(t);
  const fixture = planSlot();
  const threads = [viewThread(t, fixture), viewThread(t, fixture), viewThread(t, fixture)];
  for (const ids of threads) assert.deepEqual(await ids(), ["W1-T1", "W1-T9"], "each thread reads the working tree's plan before any reload");
  assert.equal(reads(), 0, "no thread read the plan from git before the reload");

  const board: { plan: Plan } = { plan: loadPlan(fixture.planPath) };
  const rows: Row[] = [];
  const log = (step: string, extra: Record<string, unknown> = {}): void => void rows.push([step, extra]);
  const ref = fixture.shas[1]!;
  assert.equal(await reloadServePlan(board, fixture.dir, ref, { log, onReloaded: (at, read) => publishThreadPlan({ path: fixture.planPath, repoDir: fixture.dir, ref: at }, read, log) }), true);
  const answer = board.plan.tasks.map((task) => task.id).sort();
  assert.deepEqual(answer, ["W1-T1", "W1-T2", "W1-T9"], "the main thread installed the commit's plan");

  for (const ids of threads) assert.deepEqual(await until(ids, (now) => now.includes("W1-T2"), "each thread adopts the ref"), answer, "each thread answers the task ids main answers");
  const adopted = await until(() => adoptions(rows), (found) => found.length === threads.length, "one adoption row per thread");
  assert.equal(reads(), 1, "one git read of the plan across main, the reload worker and every thread");

  const gitMs = rows.find(([step]) => step === "serve.plan_reloaded")![1].gitMs;
  assert.equal(typeof gitMs, "number");
  assert.equal(new Set(adopted.map((row) => row.threadId)).size, threads.length, "one row per thread");
  for (const row of adopted) {
    assert.equal(row.ref, ref, "the thread adopted the ref main read");
    assert.equal(row.tasks, answer.length);
    assert.notEqual(row.threadId, threadId);
    assert.equal(typeof row.parseMs, "number", "each row carries that thread's parseMs");
    assert.equal(row.gitMs, gitMs, "each row carries main's one gitMs, not a git read of its own");
  }
  assert.equal(threadPlanPin(fixture.planPath), `ref:${fixture.dir}@${ref}`);

  const late = viewThread(t, fixture);
  assert.deepEqual(await until(late, (now) => now.includes("W1-T2"), "a thread started after the publish adopts through ask"), answer);
  await until(() => adoptions(rows), (found) => found.length === threads.length + 1, "the late thread's adoption row");
  assert.equal(reads(), 1, "the late thread adopted with no further git read");
});

test("a thread adopts a pin's blobs by parsing them, and a pin with no blobs or unparseable blobs keeps its previous plan", () => {
  const fixture = planSlot();
  const plan = loadPlan(fixture.planPath);
  publishThreadPlan({ path: fixture.planPath, repoDir: fixture.dir, ref: fixture.shas[0]! }, { plan, quarantined: [] });
  adoptThreadPlan({ pin: { path: fixture.planPath, repoDir: fixture.dir, ref: "no-text" } });
  adoptThreadPlan({ pin: { path: fixture.planPath, repoDir: fixture.dir, ref: "unparseable" }, text: packPlanBlobs([{ label: "unparseable:plan/tasks.yaml", text: "- id: [unclosed\n  title: {" }]) });
  assert.equal(threadStrictPlan(fixture.planPath), plan, "neither failed pin replaced the held plan");
  assert.equal(threadPlanPin(fixture.planPath), `ref:${fixture.dir}@${fixture.shas[0]}`);

  const blobs = [{ label: "ref:plan/tasks.yaml", text: record("W1-T1") + record("W1-T2") }, { label: "ref:plan/tasks.d/W1-T9.yaml", text: record("W1-T9").replace("fixture", "fixtüre") }];
  adoptThreadPlan({ pin: { path: fixture.planPath, repoDir: fixture.dir, ref: "parsed" }, text: packPlanBlobs(blobs), gitMs: 7 });
  assert.equal(threadPlanPin(fixture.planPath), `ref:${fixture.dir}@parsed`);
  const adopted = threadStrictPlan(fixture.planPath);
  assert.deepEqual(adopted.tasks.map((task) => task.id), ["W1-T1", "W1-T2", "W1-T9"]);
  assert.equal(adopted.tasks.find((task) => task.id === "W1-T9")!.title, "one read fixtüre", "multi-byte text survives the shared buffer");
  adoptThreadPlan({ pin: { path: fixture.planPath, repoDir: fixture.dir, ref: "parsed" } });
  assert.equal(threadStrictPlan(fixture.planPath), adopted, "a pin already held is not re-parsed");
});
