import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { buildRegisteredGarden, type GardenBuildContext } from "../src/run-task.js";

function fixture(t: { after(fn: () => void): void }, fail: boolean | "heap") {
  const root = mkdtempSync(join(tmpdir(), "rmd-config-mount-boundary-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ["state", "scripts", "plan/tasks.d"]) mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, "plan/tasks.yaml"), "[]\n");
  const receipt = join(root, "state", "sweep-thread.json");
  // Only the measurement input is synthetic. The registered caller, real Worker,
  // cache, error reply and filtered inventory all run their production defaults.
  writeFileSync(join(root, "scripts", "mount-headroom-sweep.mjs"), `
    import { isMainThread, threadId } from "node:worker_threads";
    import { writeFileSync } from "node:fs";
    export function buildMountHeadroomSweep() {
      writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ isMainThread, threadId }));
      ${fail === "heap" ? `
        const retained = [];
        for (let i = 0; i < 1200; i++) retained.push(new Array(65536).fill(i));
        throw new Error("fixture did not exhaust the configured heap: " + retained.length);
      ` : fail ? 'throw new Error("fixture recommendation read failed");' : "return { cells: [] };"}
    }
  `);
  const events: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const ctx: GardenBuildContext = {
    config: { root, claudeBin: "/bin/true", overflow: "none" } as GardenBuildContext["config"],
    repoRoot: root, owner: "fixture", repo: "remudero",
    log: (step, extra) => void events.push({ step, extra }), raiseDuplicate: () => "",
  };
  return { ctx, events, receipt, root };
}

test("the registered config garden builds mount evidence in a real measurement worker", async (t) => {
  const f = fixture(t, false);
  const pass = await buildRegisteredGarden("config", f.ctx);
  await pass();
  const observed = JSON.parse(readFileSync(f.receipt, "utf8"));
  assert.equal(observed.isMainThread, false, "the production caller must not supply an inline build");
  assert.ok(observed.threadId > 0);
  assert.ok(f.events.some((e) => e.step === "config.scorecard"), "the inventory still completes");
  assert.equal(f.events.some((e) => e.step === "config.gardener_failed"), false);
});

test("a registered config mount-worker read failure is explicit and does not abort the other classes", async (t) => {
  const f = fixture(t, true);
  const pass = await buildRegisteredGarden("config", f.ctx);
  await pass();
  assert.equal(JSON.parse(readFileSync(f.receipt, "utf8")).isMainThread, false);
  assert.ok(f.events.some((e) => e.step === "config.mount_recommendations_unread" &&
    e.extra?.error === "fixture recommendation read failed"));
  assert.ok(f.events.some((e) => e.step === "config.scorecard"));
  assert.equal(f.events.some((e) => e.step === "config.gardener_failed"), false);
});

test("a registered config mount-worker heap exhaustion leaves the garden process alive", async (t) => {
  const f = fixture(t, "heap");
  const repo = resolve(import.meta.dirname, "..");
  const entry = join(f.root, "garden-child.mjs");
  const context = { ...f.ctx, log: undefined, raiseDuplicate: undefined };
  writeFileSync(entry, `
    import { buildRegisteredGarden } from ${JSON.stringify(pathToFileURL(join(repo, "src/run-task.ts")).href)};
    const events = [];
    const ctx = { ...${JSON.stringify(context)}, log: (step, extra) => events.push({ step, extra }), raiseDuplicate: () => "" };
    const pass = await buildRegisteredGarden("config", ctx);
    await pass();
    console.log(JSON.stringify(events));
  `);
  const { stdout } = await promisify(execFile)(process.execPath, ["--max-old-space-size=256", "--import", "tsx", entry], {
    cwd: repo, timeout: 30_000, maxBuffer: 64 * 1024,
    env: { ...process.env, NODE_TEST_CONTEXT: undefined, NODE_V8_COVERAGE: "" },
  });
  const events = JSON.parse(stdout.trim()) as typeof f.events;
  assert.equal(JSON.parse(readFileSync(f.receipt, "utf8")).isMainThread, false);
  assert.ok(events.some((e) => e.step === "config.mount_recommendations_unread" && /memory limit|out of memory/i.test(String(e.extra?.error))),
    "the real worker heap refusal is reported, not manufactured by a fake");
  assert.ok(events.some((e) => e.step === "config.scorecard"), "the process completes its other classes after worker termination");
  assert.equal(events.some((e) => e.step === "config.gardener_failed"), false);
});
