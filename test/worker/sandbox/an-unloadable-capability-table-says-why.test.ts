import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test, { type TestContext } from "node:test";
import { loadMounts, mountsPath } from "#src/lib/mounts.js";
import { clearCodexCapacityCache, readCodexCapacity, type CodexModelInfo } from "#src/lib/worker-provider.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const SOL: CodexModelInfo = { id: "gpt-6.2-sol", displayName: "GPT-6.2-Sol", defaultReasoningEffort: "low",
  supportedReasoningEfforts: [{ reasoningEffort: "low" }] };
const RATE_LIMITS = { rateLimitsByLimitId: { codex: { limitId: "codex", primary: { usedPercent: 40, windowDurationMins: 10080 } } } };

/** A stdio app-server stand-in answering initialize, rateLimits and model/list. */
function fakeAppServer() {
  const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
  const proc = Object.assign(new EventEmitter(), { stdin, stdout, stderr, kill: () => true });
  stdin.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").trim().split("\n")) {
      if (!line) continue;
      const request = JSON.parse(line) as { id?: number };
      const result = request.id === 1 ? {} : request.id === 2 ? RATE_LIMITS : request.id === 3 ? { data: [SOL], nextCursor: null } : undefined;
      if (result !== undefined) stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
    }
  });
  return proc;
}

/** Read Codex capacity with `root` as the Config root, returning the capacity and every unloadable-table row. */
async function readWith(t: TestContext, root: string, capabilities?: ReturnType<typeof loadMounts>["capabilities"]) {
  const home = mkdtempSync(join(tmpdir(), "rmd-w1-t14880-"));
  t.after(() => { clearCodexCapacityCache(); rmSync(home, { recursive: true, force: true }); });
  clearCodexCapacityCache();
  const rows: Array<Record<string, unknown>> = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    const text = String(args[0]);
    if (text.includes("capability_table_unloadable")) rows.push(JSON.parse(text) as Record<string, unknown>);
  };
  try {
    const capacity = await readCodexCapacity({ claudeBin: "/unused", root,
      workerProviders: { enabled: ["claude", "codex"], reservePercent: 5, codexBin: process.execPath, codexHome: join(home, "codex") },
    } as never, {
      ...(capabilities ? { capabilities } : {}), forceRefresh: true, requestedModel: "sonnet", requestedEffort: "low",
      spawn: () => fakeAppServer() as never,
    });
    return { capacity, rows };
  } finally {
    console.error = original;
  }
}

test("W1-T14880 criterion 1: an unloadable capability table writes one row naming the mounts path and the load error", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1-t14880-root-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { capacity, rows } = await readWith(t, root);
  assert.equal(capacity.modelDecision?.capabilityFallbackReason, "capability-table-unavailable", "the fallback still routes");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].event, "worker.provider.capability_table_unloadable");
  assert.equal(rows[0].path, mountsPath(root));
  assert.equal(typeof rows[0].reason, "string");
  assert.ok((rows[0].reason as string).length > 0, "the load error is carried");
});

test("W1-T14880 criterion 2: invariant:fallback-unchanged — a loadable or injected table writes no row and routes as before", async (t) => {
  const loadable = await readWith(t, REPO_ROOT);
  assert.deepEqual(loadable.rows, []);
  assert.equal(loadable.capacity.modelDecision?.capabilityFallbackReason, undefined);
  const scratch = mkdtempSync(join(tmpdir(), "rmd-w1-t14880-root-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const injected = await readWith(t, scratch, loadMounts(mountsPath(REPO_ROOT)).capabilities);
  assert.deepEqual(injected.rows, [], "an injected table never reads the root's");
  assert.equal(injected.capacity.modelDecision?.capabilityFallbackReason, undefined);
  assert.equal(injected.capacity.model, loadable.capacity.model);
  assert.equal(injected.capacity.modelDecision?.requestedCapability, loadable.capacity.modelDecision?.requestedCapability);
});
