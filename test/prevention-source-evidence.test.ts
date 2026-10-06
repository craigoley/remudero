import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { captureImportedModule, importedModuleOf, preventionRegistrationsOf, preventionAdoption,
  type ImportedModuleEvidence, type PreventionSourceRegistration } from "../src/lib/prevention-source-evidence.js";
import { executingHarnessRevision, benchmarkRunAssignmentReceipt } from "../src/lib/benchmark-run.js";
import { ciFrictionGardenSpec, readCiFrictionPlanTasks } from "../src/lib/ci-friction-gardener.js";
import { gitRepo, GIT_REPO_FIXTURE_IDENTITY } from "./helpers/git-repo.js";

const SHA = "a".repeat(40), BLOB = "b".repeat(40);
const T = (day: number) => `2026-10-${String(day).padStart(2, "0")}T00:00:00.000Z`;
const source: PreventionSourceRegistration = { id: "ci-friction:check:gate", taskId: "W1-T8001", causeKey: "check:gate",
  path: "src/run-task.ts", blob: BLOB, mergeRevision: SHA, mergedAt: T(2), workScope: "fix-worker-attempt" };
const imported: ImportedModuleEvidence = { state: "observed", source: "module-import-git", path: source.path, blob: BLOB,
  revision: SHA, capturedAt: T(3) };
const repair = { repo: "acme/core", number: 10, roundId: "round-1", workerRunId: "worker-1", rung: "fix", assignmentObserved: true };
const row = (step: string, extra: Record<string, unknown> = {}) => ({ step, ts: T(4), host: "host-1", assignmentId: "asg-1",
  success: null as boolean | null, repair, ...extra });
const card = () => row("ci-friction.scorecard", { ts: T(2), preventions: [source] });
const assignment = () => row("worker.assignment", { importedModule: imported });
const terminal = () => row("worker.attempt", { ts: T(5), success: true });

test("prevention source adoption requires an exact imported file and a later joined fix attempt", () => {
  const report = preventionAdoption([card(), assignment(), terminal(), terminal()], T(6));
  assert.equal(report.state, "observed-partial");
  assert.equal(report.records.length, 1);
  const actual = report.records[0]!;
  assert.deepEqual(actual.expectedSource, source); assert.deepEqual(actual.loadedSource, imported);
  assert.deepEqual(actual.laterWork, { state: "observed", at: T(5), host: "host-1", workerRunId: "worker-1", assignmentId: "asg-1", success: true });
  assert.equal(actual.efficacyClaim, "none"); assert.equal(actual.history, "unavailable-retention-uncertified");
});

test("a proposal merge image boot or new checkout cannot prove prevention adoption", () => {
  for (const alternative of [row("daemon.boot", { headSha: SHA }), row("deployment", { revision: SHA }),
    row("worker.assignment", { importedModule: { ...imported, blob: "c".repeat(40) } }),
    row("worker.assignment", { importedModule: { ...imported, capturedAt: T(1) } }),
    row("worker.assignment", { importedModule: { ...imported, capturedAt: T(5) } })]) {
    const record = preventionAdoption([card(), alternative, terminal()], T(6)).records[0]!;
    assert.equal(record.loadedSource.state, "unavailable"); assert.equal(record.laterWork.state, "unavailable");
  }
  assert.equal(preventionAdoption([assignment(), terminal()], T(6)).state, "unavailable");
  assert.equal(preventionAdoption([card(), assignment()], T(6)).records[0]!.loadedSource.state, "observed");
  assert.equal(preventionAdoption([card(), assignment()], T(6)).records[0]!.laterWork.state, "unavailable");
});

test("prevention work refuses foreign missing future invalid and conflicting identities", () => {
  for (const bad of [row("worker.attempt", { success: true, repair: { ...repair, roundId: "foreign" } }),
    row("worker.attempt", { success: true, repair: { ...repair, repo: "acme/other" } }),
    row("worker.attempt", { success: true, repair: { ...repair, number: 11 } }),
    row("worker.attempt", { success: true, repair: { ...repair, assignmentObserved: false } }),
    row("worker.attempt", { success: true, repair: { ...repair, workerRunId: null } }),
    row("worker.attempt", { success: true, assignmentId: null }), row("worker.attempt", { success: true, host: null }),
    row("worker.attempt", { success: true, ts: "invalid" }), row("worker.attempt", { success: true, ts: T(7) }),
    row("worker.attempt", { success: true, ts: T(3) }), row("worker.attempt", { success: null })]) {
    assert.equal(preventionAdoption([card(), assignment(), bad], T(6)).records[0]!.laterWork.state, "unavailable");
  }
  const conflict = preventionAdoption([card(), assignment(), terminal(), row("worker.attempt", { ts: T(5), success: false })], T(6)).records[0]!;
  assert.deepEqual(conflict.laterWork, { state: "unavailable", reason: "conflicting-terminal-work-receipts" });
  assert.equal(preventionAdoption([card()], "invalid").reason, "invalid-observation-time");
  assert.equal(preventionAdoption([row("ci-friction.scorecard", { ts: T(1), preventions: [source] })], T(6)).state, "unavailable");
});

test("prevention registrations are bounded and missing or malformed history stays unavailable", () => {
  assert.deepEqual(preventionRegistrationsOf(null), []); assert.deepEqual(preventionRegistrationsOf([{}]), []);
  assert.deepEqual(importedModuleOf({ ...imported, path: "src/../secrets.ts" }), { state: "unavailable", reason: "qualifying-imported-module-not-recorded" });
  assert.equal(importedModuleOf({ ...imported, blob: "invalid" }).state, "unavailable");
  assert.equal(importedModuleOf({ ...imported, capturedAt: "invalid" }).state, "unavailable");
  const cards = Array.from({ length: 40 }, (_, n) => row("ci-friction.scorecard", { preventions: [{ ...source, taskId: `W1-T${n}` }] }));
  const report = preventionAdoption([card(), card(), ...cards], T(6));
  assert.equal(report.records.length, 32); assert.equal(report.omittedRegistrations, 9);
  assert.equal(preventionRegistrationsOf(Array.from({ length: 40 }, () => source)).length, 32);
});

test("the real imported module capture shells Git and refuses physical source drift", (t) => {
  const repo = gitRepo({ kind: "prevention-import-capture" }); t.after(() => repo.cleanup());
  mkdirSync(join(repo.dir, "src")); const path = join(repo.dir, "src", "owner.mjs"); writeFileSync(path, "export const value = 1;\n");
  repo.git("add", "."); repo.git("commit", "-qm", "source");
  const physical = realpathSync(path);
  const pin = executingHarnessRevision(physical);
  const receipt = captureImportedModule(physical, pin);
  assert.equal(receipt.state, "observed");
  if (receipt.state === "observed") {
    assert.equal(receipt.path, "src/owner.mjs"); assert.equal(receipt.blob, repo.git("rev-parse", "HEAD:src/owner.mjs"));
  }
  writeFileSync(path, "export const value = 2;\n");
  assert.equal(captureImportedModule(path, pin).state, "unavailable");
  assert.equal(captureImportedModule(join(repo.dir, "src", "absent.mjs"), pin).state, "unavailable");
});

test("import-time source identity survives a later checkout advance in a real Node child", (t) => {
  const repo = gitRepo({ kind: "prevention-import-once" }); t.after(() => repo.cleanup()); mkdirSync(join(repo.dir, "src"));
  const path = join(repo.dir, "src", "owner.mjs");
  const evidenceUrl = pathToFileURL(fileURLToPath(new URL("../src/lib/prevention-source-evidence.ts", import.meta.url))).href;
  const benchmarkUrl = pathToFileURL(fileURLToPath(new URL("../src/lib/benchmark-run.ts", import.meta.url))).href;
  writeFileSync(path, `import {captureImportedModule} from ${JSON.stringify(evidenceUrl)};\nimport {executingHarnessRevision} from ${JSON.stringify(benchmarkUrl)};\nimport {fileURLToPath} from 'node:url';\nconst file=fileURLToPath(import.meta.url);\nexport const captured=captureImportedModule(file,executingHarnessRevision(file));\n`);
  repo.git("add", "."); repo.git("commit", "-qm", "module before loading"); const before = repo.git("rev-parse", "HEAD");
  const script = `import {execFileSync} from 'node:child_process';import{readFileSync,writeFileSync}from'node:fs';\nconst path=${JSON.stringify(path)};const url=${JSON.stringify(pathToFileURL(path).href)};const root=${JSON.stringify(repo.dir)};\nconst first=await import(url);writeFileSync(path,readFileSync(path,'utf8')+'// later checkout\\n');\nexecFileSync('git',['-C',root,'add','.']);execFileSync('git',['-C',root,'commit','-qm','later checkout']);\nconst second=await import(url);console.log(JSON.stringify({same:first===second,captured:second.captured,head:execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim()}));`;
  const output = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { encoding: "utf8", timeout: 30_000,
    env: { ...process.env, GIT_AUTHOR_NAME: GIT_REPO_FIXTURE_IDENTITY.name, GIT_AUTHOR_EMAIL: GIT_REPO_FIXTURE_IDENTITY.email,
      GIT_COMMITTER_NAME: GIT_REPO_FIXTURE_IDENTITY.name, GIT_COMMITTER_EMAIL: GIT_REPO_FIXTURE_IDENTITY.email } });
  const actual = JSON.parse(output); assert.equal(actual.same, true); assert.equal(actual.captured.state, "observed");
  assert.equal(actual.captured.revision, before); assert.notEqual(actual.head, before);
});

test("module capture names each unavailable boundary and assignment receipts preserve qualified identity", () => {
  assert.equal(captureImportedModule("/x/src/a.ts", null).state, "unavailable");
  const pin = { source: "executing-module-git", revision: SHA };
  assert.equal(captureImportedModule("/x/src/a.ts", pin, () => { throw new Error("read failed"); }).state, "unavailable");
  assert.equal(captureImportedModule("/outside/a.ts", pin, () => "/x").state, "unavailable");
  const answers = ["/x", BLOB, BLOB];
  assert.equal(captureImportedModule("/x/src/a.ts", pin, () => answers.shift()!, () => "invalid").state, "unavailable");
  const assigned = benchmarkRunAssignmentReceipt({ id: "a", requested: { model: "test", effort: "low" }, selected: { provider: "test", model: "test", effort: "low" } }, {}, { loadedModule: imported });
  assert.deepEqual(assigned.loadedModule, imported);
  assert.equal(benchmarkRunAssignmentReceipt({ id: "a", requested: { model: "test", effort: "low" }, selected: { provider: "test", model: "test", effort: "low" } }, {}).loadedModule.state, "unavailable");
});

function shard(status = "queued") {
  return `- id: W1-T8001\n  title: "t"\n  repo: remudero\n  depends_on: []\n  type: implement\n  verify: auto\n  risk: low\n  status: ${status}\n  attempts: 0\n  origin: "ci-friction:check:gate"\n  files:\n    - src/run-task.ts\n  acceptance:\n    - claim: "c"\n      proof: "unit test: t"\n`;
}

test("the actual Git producer registers an owning source build but refuses a filing and status flip", (t) => {
  const repo = gitRepo({ kind: "prevention-source-build" }); t.after(() => repo.cleanup());
  mkdirSync(join(repo.dir, "plan", "tasks.d"), { recursive: true }); mkdirSync(join(repo.dir, "src"));
  const record = join(repo.dir, "plan", "tasks.d", "W1-T8001.yaml"); writeFileSync(record, shard());
  repo.git("add", "."); repo.git("commit", "-qm", "filing\n\nRemudero-Task: W1-T8001");
  const git = (args: string[]) => repo.git(...args) + "\n";
  assert.equal("state" in readCiFrictionPlanTasks(git, "plan/tasks.d", "HEAD")[0]!.preventionSource!, true);
  writeFileSync(record, shard("merged")); repo.git("commit", "-qam", "status flip");
  assert.equal("state" in readCiFrictionPlanTasks(git, "plan/tasks.d", "HEAD")[0]!.preventionSource!, true);
  writeFileSync(join(repo.dir, "src", "run-task.ts"), "export const prevention = true;\n");
  repo.git("add", "."); repo.git("commit", "-qm", "source build\n\nRemudero-Task: W1-T8001");
  const registered = readCiFrictionPlanTasks(git, "plan/tasks.d", "HEAD")[0]!.preventionSource!;
  assert.equal("state" in registered, false);
  if (!("state" in registered)) {
    assert.equal(registered.mergeRevision, repo.git("rev-parse", "HEAD"));
    assert.equal(registered.blob, repo.git("rev-parse", "HEAD:src/run-task.ts"));
    assert.equal(registered.workScope, "fix-worker-attempt");
  }
  const tasks = readCiFrictionPlanTasks(git, "plan/tasks.d", "HEAD");
  const spec = ciFrictionGardenSpec({ stateDir: repo.dir, repoRoot: repo.dir, seed: 1,
    log: () => {}, openWorkspace: () => { throw new Error("a scorecard opens no workspace"); } }, {
    ledgerRecords: () => [], planState: () => ({ tasks }),
    ownerSearch: { filesContaining: () => [], fileExists: () => false },
    mintTaskId: () => { throw new Error("a scorecard mints no task"); },
  });
  const inventory = spec.inventory();
  assert.deepEqual(spec.scorecard(inventory, { actions: [], acting: [] }).prevention_sources, [registered]);
  assert.equal(spec.scorecard(inventory, { actions: [], acting: [] }).prevention_source_scope, "owning-file-build-not-runtime-or-efficacy");
  assert.deepEqual(spec.scorecard({ ...inventory, preventionSources: undefined }, { actions: [], acting: [] }).prevention_sources, []);
});

test("the Git registration reader bounds blob reads and preserves unreadable and invalid results", () => {
  const ids = Array.from({ length: 35 }, (_, n) => `W1-T${8001 + n}`);
  const run = (mode: string) => {
    let reads = 0;
    const git = (args: string[]) => {
      if (args[0] === "grep") return ids.map((id) => `HEAD:plan/tasks.d/${id}.yaml`).join("\n");
      if (args[0] === "show") return shard().replace(/W1-T8001/g, args[1]!.split("/").at(-1)!.replace(".yaml", ""));
      if (args[0] === "log") return `${T(2)}\t${ids.join(",")}\t${SHA}\n\nsrc/run-task.ts\n`;
      if (args[0] === "rev-parse") { reads += 1; if (mode === "throw") throw new Error("missing blob"); return mode === "invalid" ? "bad" : BLOB; }
      throw new Error(`unexpected Git operation ${args[0]}`);
    };
    return { tasks: readCiFrictionPlanTasks(git, "plan/tasks.d", "HEAD"), reads: () => reads };
  };
  const observed = run("valid"); assert.equal(observed.reads(), 32);
  assert.equal(observed.tasks.filter((task) => task.preventionSource && !("state" in task.preventionSource)).length, 32);
  assert.deepEqual(observed.tasks.at(-1)!.preventionSource, { state: "unavailable", reason: "source-registration-read-cap" });
  for (const [mode, reason] of [["throw", "owning-source-blob-unreadable"], ["invalid", "owning-source-blob-invalid"]]) {
    assert.deepEqual(run(mode!).tasks[0]!.preventionSource, { state: "unavailable", reason });
  }
});
