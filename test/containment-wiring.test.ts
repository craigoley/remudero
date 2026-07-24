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
import type { ProbeExecResult } from "../src/lib/containment.js";

const runTaskSrc = readFileSync(fileURLToPath(new URL("../src/run-task.ts", import.meta.url)), "utf8");

// ── The containment preflight is WIRED into the run path (mirrors
// test/isolation-wiring.test.ts's checks for the isolation preflight) ───────

test("the run path INVOKES probeContainment and converts a failed probe into a terminal verdict", () => {
  assert.match(runTaskSrc, /probeContainment\(/, "run-task.ts must call probeContainment");
  assert.match(runTaskSrc, /ContainmentError/, "run-task.ts must convert a failed probe into a terminal verdict");
});

test("a failed containment preflight returns a terminal blocked_containment verdict BEFORE the worktree add", () => {
  const failBlockMatch = /ContainmentError[\s\S]*?return \{ taskId, runId, merged: false, costUsd, verdict: "blocked_containment" \};/;
  assert.match(runTaskSrc, failBlockMatch, "the ContainmentError catch must return a terminal blocked_containment verdict");
  const returnIdx = runTaskSrc.search(failBlockMatch);
  const worktreeAddIdx = runTaskSrc.indexOf("worktreeAdd(");
  assert.ok(returnIdx >= 0 && returnIdx < worktreeAddIdx, "the fail-closed return must be BEFORE worktreeAdd");
});

// ── W1-T91/P23: the ledger verdict line carries the structured guard-cause ──

test("the blocked_containment ledger verdict line forwards guard/check/observed off the caught ContainmentError", () => {
  const containmentCatchIdx = runTaskSrc.indexOf("if (e instanceof ContainmentError)");
  assert.ok(containmentCatchIdx >= 0, "run-task.ts must catch ContainmentError");
  const block = runTaskSrc.slice(containmentCatchIdx, containmentCatchIdx + 500);
  assert.match(block, /guard:\s*e\.guard/, "the ledger verdict line must carry the structured guard field");
  assert.match(block, /check:\s*e\.check/, "the ledger verdict line must carry the structured check field");
  assert.match(block, /observed:\s*e\.observed/, "the ledger verdict line must carry the structured observed field");
});

// ── W1-T91/P23 BEHAVIORAL: the REAL runTask dispatch path, driven through the
// injected `containmentExec` seam (mirrors `defaultReconRunLens`'s own injected
// `deps.probeExec`) — proves the guard/check/observed fields land on the ACTUAL
// ledgered verdict line, not merely on the source text next to the catch. ────

const FIXTURE_PLAN = [
  "- id: TST-CONTAINMENT",
  "  title: containment-preflight wiring probe",
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

/** A containmentExec that reports the outside-cwd write SUCCEEDED — the sandbox did
 *  not engage, so probeContainment throws a ContainmentError (mirrors
 *  test/containment.test.ts's own `outsideWriteCreated: true` fixtures). */
const droppedContainmentExec = (token: string): Promise<ProbeExecResult> =>
  Promise.resolve({
    transcript: `touch ../${token}.txt`,
    outsideWriteCreated: true,
    insideWriteCreated: true,
    costUsd: 0,
  });

test("BEHAVIORAL: a dropped containment probe drives the REAL runTask to a blocked_containment verdict whose ledgered line carries guard/check/observed", async () => {
  const root = mkdtempSync(join(tmpdir(), "runtask-containment-"));
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, FIXTURE_PLAN);
  const config: Config = { claudeBin: "/bin/true", root };

  const spawn = (async () => {
    throw new Error("spawn must never run — the containment preflight must refuse first");
  }) as typeof spawnWorker;

  const res = await runTask("TST-CONTAINMENT", {
    skipGitSync: true,
    planPath,
    config,
    github: OFFLINE_GITHUB,
    spawn,
    containmentExec: droppedContainmentExec,
  });

  assert.equal(res.verdict, "blocked_containment", "a dropped sandbox is a terminal blocked_containment verdict");

  const ledger = readFileSync(join(root, "state", "ledger.ndjson"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const verdictLine = ledger.find((l) => l.step === "verdict" && l.verdict === "blocked_containment");
  assert.ok(verdictLine, "a blocked_containment verdict line was ledgered");
  assert.equal(verdictLine.guard, "containment", "the ledgered verdict carries the structured guard field");
  assert.equal(verdictLine.check, "outside-cwd-denial", "the ledgered verdict carries the structured check field");
  assert.match(verdictLine.observed, /sandbox did not engage/, "the ledgered verdict carries the structured observed field");

  rmSync(root, { recursive: true, force: true });
});
