import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runTask } from "../src/run-task.js";
import type { Config } from "../src/lib/config.js";
import type { GitHub } from "../src/lib/status.js";
import type { spawnWorker } from "../src/lib/worker.js";
import type { ProbeExecResult as ContainmentProbeExecResult } from "../src/lib/containment.js";
import type { ProbeExecResult as IsolationProbeExecResult } from "../src/lib/isolation.js";

const runTaskSrc = readFileSync(fileURLToPath(new URL("../src/run-task.ts", import.meta.url)), "utf8");

// ── The isolation preflight is WIRED into the run path, before any task work ─

test("the run path INVOKES probeIsolation (the preflight probe is wired, not just implemented)", () => {
  assert.match(runTaskSrc, /probeIsolation\(/, "run-task.ts must call probeIsolation");
  assert.match(runTaskSrc, /IsolationError/, "run-task.ts must convert a failed probe into a terminal verdict");
});

test("the isolation preflight runs BEFORE any task worker (recon/implement) or worktree work", () => {
  const isoCallIdx = runTaskSrc.indexOf("probeIsolation(");
  const worktreeAddIdx = runTaskSrc.indexOf("worktreeAdd(");
  const reconIdx = runTaskSrc.indexOf('"recon worker"');
  const implPromptIdx = runTaskSrc.indexOf("renderImplementPrompt(task,");
  assert.ok(isoCallIdx >= 0, "probeIsolation must be called somewhere in run-task.ts");
  assert.ok(isoCallIdx < worktreeAddIdx, "preflight must precede worktreeAdd (repo/worktree setup)");
  assert.ok(isoCallIdx < reconIdx, "preflight must precede the recon worker spawn");
  assert.ok(isoCallIdx < implPromptIdx, "preflight must precede the implement prompt/spawn");
});

test("a failed isolation preflight returns BEFORE the worktree add — no implement.done can ever log", () => {
  const failBlockMatch = /IsolationError[\s\S]*?return \{ taskId, runId, merged: false, costUsd, verdict: "blocked_isolation" \};/;
  assert.match(runTaskSrc, failBlockMatch, "the IsolationError catch must return a terminal blocked_isolation verdict");
  const returnIdx = runTaskSrc.search(failBlockMatch);
  const worktreeAddIdx = runTaskSrc.indexOf("worktreeAdd(");
  assert.ok(returnIdx >= 0 && returnIdx < worktreeAddIdx, "the fail-closed return must be BEFORE worktreeAdd");
});

test("blocked_isolation is a recognized terminal verdict on RunResult", () => {
  assert.match(runTaskSrc, /"blocked_isolation"/);
});

// ── W1-T91/P23: the ledger verdict line carries the structured guard-cause ──

test("the blocked_isolation ledger verdict line forwards guard/check/observed off the caught IsolationError", () => {
  const isoCatchIdx = runTaskSrc.indexOf("if (e instanceof IsolationError)");
  assert.ok(isoCatchIdx >= 0, "run-task.ts must catch IsolationError");
  const block = runTaskSrc.slice(isoCatchIdx, isoCatchIdx + 400);
  assert.match(block, /guard:\s*e\.guard/, "the ledger verdict line must carry the structured guard field");
  assert.match(block, /check:\s*e\.check/, "the ledger verdict line must carry the structured check field");
  assert.match(block, /observed:\s*e\.observed/, "the ledger verdict line must carry the structured observed field");
});

// ── W1-T91/P23 BEHAVIORAL: the REAL runTask dispatch path, driven through the
// injected `isolationExec` seam (mirrors `defaultReconRunLens`'s own injected
// `deps.probeExec`, same pattern test/containment-wiring.test.ts's own
// behavioral test uses for the containment sibling) — proves the
// guard/check/observed fields land on the ACTUAL ledgered verdict line, not
// merely on the source text next to the catch. ─────────────────────────────

const FIXTURE_PLAN = [
  "- id: TST-ISOLATION",
  "  title: isolation-preflight wiring probe",
  "  repo: remudero",
  "  type: implement",
  "  verify: auto",
  "  risk: medium",
  "  files: [src/lib/daemon.ts]",
  "  origin: architect",
  "  status: queued",
  "",
].join("\n");

/** An offline GitHub gateway: projectPlan runs with zero network round-trips. */
const OFFLINE_GITHUB: GitHub = {
  prByRef: () => null,
  findMergedByTrailer: () => null,
  headRefName: () => undefined,
  prBody: () => undefined,
};

/** A containmentExec that reports the outside-cwd write OS-DENIED — containment
 *  PASSES, so the run actually reaches the isolation preflight below it (mirrors
 *  test/containment.test.ts's own `denyingExec` fixture). */
const holdingContainmentExec = (token: string): Promise<ContainmentProbeExecResult> =>
  Promise.resolve({
    transcript: `touch ../${token}.txt: Operation not permitted`,
    outsideWriteCreated: false,
    insideWriteCreated: true,
    costUsd: 0,
  });

/** An isolationExec that reports an inherited operator function — isolation FAILS,
 *  so probeIsolation throws an IsolationError. */
const leakyIsolationExec = (): Promise<IsolationProbeExecResult> =>
  Promise.resolve({
    transcript: "REPORT\naliases: 0\nfunctions: 1\nalias_names: -\nfunction_names: my_operator_fn",
    aliasCount: 0,
    functionCount: 1,
    functionNames: "my_operator_fn",
    costUsd: 0,
  });

test("BEHAVIORAL: a leaky isolation probe drives the REAL runTask to a blocked_isolation verdict whose ledgered line carries guard/check/observed", async () => {
  const root = mkdtempSync(join(tmpdir(), "runtask-isolation-"));
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, FIXTURE_PLAN);
  const config: Config = { claudeBin: "/bin/true", root };

  const spawn = (async () => {
    throw new Error("spawn must never run — the isolation preflight must refuse first");
  }) as typeof spawnWorker;

  const res = await runTask("TST-ISOLATION", {
    skipGitSync: true,
    planPath,
    config,
    github: OFFLINE_GITHUB,
    spawn,
    containmentExec: holdingContainmentExec,
    isolationExec: leakyIsolationExec,
  });

  assert.equal(res.verdict, "blocked_isolation", "an inherited operator function is a terminal blocked_isolation verdict");

  const ledger = readFileSync(join(root, "state", "ledger.ndjson"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const verdictLine = ledger.find((l) => l.step === "verdict" && l.verdict === "blocked_isolation");
  assert.ok(verdictLine, "a blocked_isolation verdict line was ledgered");
  assert.equal(verdictLine.guard, "isolation", "the ledgered verdict carries the structured guard field");
  assert.equal(verdictLine.check, "inherited-functions", "the ledgered verdict carries the structured check field");
  assert.match(verdictLine.observed, /1 function/, "the ledgered verdict carries the structured observed field");

  rmSync(root, { recursive: true, force: true });
});
