import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { world } from "./helpers/why-me-world.js";
import { mintProofDebtProposals } from "../src/lib/measurement-cadence.js";
import { receiptIdentity } from "../src/lib/benchmark-run.js";
import { runInboxGardener } from "../src/lib/inbox-gardener.js";
import { buildRegisteredGarden, defaultProofDebtCadenceInput, inboxGardenerRunTaskPorts, type GardenBuildContext } from "../src/run-task.js";

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


test("the actual registered Inbox garden defaults off and supplies a governed bounded residual judge", async t => {
  const f = fixture(t, false), old = process.env.RMD_INBOX_GARDENER_MODE;
  delete process.env.RMD_INBOX_GARDENER_MODE;
  t.after(() => { if (old === undefined) delete process.env.RMD_INBOX_GARDENER_MODE; else process.env.RMD_INBOX_GARDENER_MODE = old; });
  const pass = await buildRegisteredGarden("inbox", f.ctx);
  assert.equal(await pass.due?.(), false);
  await pass();
  assert.equal(f.events.some(e => e.step === "inbox.gardener_pass" && e.extra?.state === "disabled"), true);
  const w = await world(t);
  writeFileSync(w.planPath, readFileSync(w.planPath, "utf8") + "- id: W1-T1200\n  title: Mechanical repair\n  repo: core\n  depends_on: []\n  type: implement\n  verify: auto\n  status: queued\n  acceptance:\n    - claim: missing proof\n      proof: 'grep: missing in src/missing.ts'\n");
  const input = defaultProofDebtCadenceInput(w.root, { readMergeEvidenceLog: () => ({ dump: "", ref: "fixture" }) })!;
  mintProofDebtProposals([{ taskId: "W1-T1200", criterionIndex: 0, cause: "grep-path-absent", claim: "missing", proof: "grep: missing in src/missing.ts" }], () => "plan/tasks.yaml", w.registry, { sourcePermit: input.sourcePermit });
  await w.refresh();
  const instanceBefore = process.env.RMD_INSTANCE_NAME; process.env.RMD_INSTANCE_NAME = "core";
  t.after(() => { if (instanceBefore === undefined) delete process.env.RMD_INSTANCE_NAME; else process.env.RMD_INSTANCE_NAME = instanceBefore; });
  const calls: any[] = [];
  const wired = await inboxGardenerRunTaskPorts({ ...f.ctx, config: { ...f.ctx.config, root: w.root }, repoRoot: w.root, owner: "owner", repo: "core" }, { mount: () => ({ model: "fixture-model", effort: "low", provider: "fixture-provider" } as any),
    githubJson: async () => [], spawn: async options => { calls.push(options); return { text: JSON.stringify({ decision: "mechanical_followup", reason: "normal fleet repair" }) } as any; } });
  await runInboxGardener({ stateDir: join(f.root, "state"), scope: wired.scope, ports: wired.ports, mode: "off" });
  assert.equal(calls.length, 0, "the actual production provider wrapper is never invoked while off");
  const result = await runInboxGardener({ stateDir: w.state, scope: wired.scope, ports: wired.ports, mode: "shadow" });
  assert.equal(result.state, "complete"); assert.equal("judged" in result && result.judged, 1); assert.equal(calls.length, 1);
  await runInboxGardener({ stateDir: w.state, scope: wired.scope, ports: wired.ports, mode: "shadow" });
  assert.equal(calls.length, 1, "unchanged production input cannot spend again");
  assert.equal(calls[0].maxTurns, 1); assert.deepEqual(calls[0].tools, []);
  assert.equal(calls[0].model, "fixture-model"); assert.equal(calls[0].effort, "low"); assert.equal(calls[0].mountProvider, "fixture-provider");
  assert.equal(receiptIdentity(calls[0]).taskId, "INBOX-GARDENER");
  assert.match(calls[0].prompt, /no approval|untrusted/i);
  const missingPin = await inboxGardenerRunTaskPorts({ ...f.ctx, config: { ...f.ctx.config, root: w.root }, repoRoot: w.root, owner: "owner", repo: "core" },
    { readCodeSha: async () => { throw new Error("loaded source unavailable"); }, githubJson: async () => [], spawn: async () => assert.fail("unqualified code cannot spend") });
  const unknown = await runInboxGardener({ stateDir: w.state, scope: missingPin.scope, ports: missingPin.ports, mode: "shadow" });
  assert.equal(unknown.state, "source_partial");
  assert.equal(f.events.some(e => e.step === "inbox.gardener_source_unavailable"), true);

});
