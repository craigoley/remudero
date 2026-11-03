import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { childOracle, createReadModelWorker, oracleChildExecArgv, READ_MODEL_ORACLE_CHILD_STEP, type OracleSliceRequest, type OracleSliceResult } from "#src/lib/read-model-worker.js";
import { childHeapPolicyArgs, readDaemonMemoryPolicy, recordChildHeapGrowingPercent } from "#src/lib/daemon-memory-policy.js";
import { makeTempDir } from "#src/lib/tmp.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

type TestCtx = { after: (fn: () => void) => void };
type Row = { step: string; extra: Record<string, unknown> };

const GROWTH = "--heap-growing-percent=50";

function scratch(t: TestCtx, kind: string): string {
  const dir = makeTempDir(kind);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function until(done: () => boolean, ms = 60_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done() && Date.now() < deadline) await sleep(20);
}

const request = (): OracleSliceRequest => ({
  instance: "core", stateDir: "/nonexistent", ledgerDir: "/nonexistent", dbPath: "/nonexistent.sqlite", lease: { name: "projector", holder: "h", ttlMs: 20_000 },
  window: { t0: 0, t1: 1 }, mark: { atMs: 0, files: [] },
});

test("W1-T10290: the oracle child starts under the heap growth percent and its row names it", async (t) => {
  // A real child that answers with the execArgv it was started with, read from its own process.
  const path = join(scratch(t, "rmo-growth-module"), "oracle.mjs");
  writeFileSync(path, `process.send({ type: "ready" });\nprocess.on("message", (m) => process.send({ type: "done", id: m.id, maxRssBytes: 1, result: { ok: false, error: JSON.stringify(process.execArgv), leaseLost: false } }, () => process.exit(0)));\n`);
  const rows: Row[] = [];
  const oracle = childOracle({ workerUrl: pathToFileURL(path), heapArgs: [GROWTH], log: (step, extra) => rows.push({ step, extra }) });
  t.after(() => oracle.close());
  const results: OracleSliceResult[] = [];
  oracle.run(request(), (result) => results.push(result));
  await until(() => rows.some((r) => r.step === READ_MODEL_ORACLE_CHILD_STEP));
  const startedWith = JSON.parse(String(!results[0]?.ok ? results[0]?.error : "[]")) as string[];
  assert.ok(startedWith.includes(GROWTH), `the child's own process.execArgv carries the growth flag: ${startedWith.join(" ")}`);
  const nodeArgs = rows.find((r) => r.step === READ_MODEL_ORACLE_CHILD_STEP)?.extra.node_args as string[];
  assert.ok(nodeArgs.includes(GROWTH), "the exit row names the flags the child was started with");
  assert.deepEqual(nodeArgs, startedWith, "the row names exactly what the child ran under");
  assert.deepEqual(oracleChildExecArgv(["--heap-growing-percent=200", "--max-old-space-size=9000", "--x"], [GROWTH]).filter((f) => /heap-growing|--x/.test(f)), ["--x", GROWTH], "a growth flag the parent carries is replaced, not doubled");
  assert.deepEqual(oracleChildExecArgv(["--heap-growing-percent=200"]), ["--heap-growing-percent=200", oracleChildExecArgv([]).at(-1)], "no heap args given: the parent's flag is left alone");
});

test("W1-T10290: the read-model worker thread receives the children's heap flags in its data", async (t) => {
  const stateDir = scratch(t, "rmo-growth-state");
  const thread = new URL(`data:text/javascript,${encodeURIComponent(
    `import { parentPort, workerData } from "node:worker_threads";\nsetInterval(() => parentPort.postMessage({ type: "log", step: "probe", extra: { data: workerData.childHeapArgs ?? null } }), 10);`)}`);
  const seen: unknown[] = [];
  const handle = createReadModelWorker({ stateDir, instances: [{ name: "core", ledgerDir: stateDir }], stopWaitMs: 20, workerUrl: thread, childHeapArgs: [GROWTH],
    log: (step, extra) => void (step === "probe" && seen.push(extra?.data)) });
  handle.start();
  t.after(() => void handle.stop());
  await until(() => seen.length > 0, 20_000);
  assert.deepEqual(seen[0], [GROWTH], "the thread read the flags from its workerData, not from a module variable of its own isolate");
});

test("W1-T10290: serve sets its children's growth percent and leaves its own unchanged", () => {
  const optionsBefore = process.env.NODE_OPTIONS;
  const execArgvBefore = [...process.execArgv];
  assert.deepEqual(childHeapPolicyArgs(), [], "nothing recorded yet");
  const { policy } = readDaemonMemoryPolicy(join(REPO_ROOT, "plan", "policy.yaml"));
  assert.deepEqual(recordChildHeapGrowingPercent(policy), [`--heap-growing-percent=${Math.round(policy.heapGrowingPercent)}`]);
  assert.deepEqual(childHeapPolicyArgs(), recordChildHeapGrowingPercent(policy), "the record is what childHeapPolicyArgs now answers");
  assert.equal(process.env.NODE_OPTIONS, optionsBefore, "no environment edit: only the daemon rewrites NODE_OPTIONS");
  assert.deepEqual(process.execArgv, execArgvBefore, "this process's own command line is unchanged");
});
