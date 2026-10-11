/** Production entrypoint controls also fail explicitly when transplanted onto pre-feature main. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const suite = existsSync(new URL("../src/lib/model-canary-suite.ts", import.meta.url))
  ? await import("../src/lib/model-canary-suite.js") : null;
const runner = existsSync(new URL("../src/lib/model-canary-runner.ts", import.meta.url))
  ? await import("../src/lib/model-canary-runner.js") : null;
const metrics = existsSync(new URL("../src/lib/model-canary-metrics.ts", import.meta.url))
  ? await import("../src/lib/model-canary-metrics.js") : null;
const command = existsSync(new URL("../src/lib/model-canary-command.ts", import.meta.url))
  ? await import("../src/lib/model-canary-command.js") : null;
const schedule = existsSync(new URL("../src/lib/model-canary-schedule.ts", import.meta.url))
  ? await import("../src/lib/model-canary-schedule.js") : null;
const retention = existsSync(new URL("../src/lib/model-canary-retention.ts", import.meta.url))
  ? await import("../src/lib/model-canary-retention.js") : null;
const transport = existsSync(new URL("../src/lib/model-canary-transport.ts", import.meta.url))
  ? await import("../src/lib/model-canary-transport.js") : null;

test("canary production runner retains actual tool authority and unavailable attempt cost", async () => {
  assert.ok(suite && runner && metrics, "production canary modules are absent at this head");
  const item = suite.commonCanarySuite().find(c => c.tools === "approval")!, pin = { model: "model", route: "subscription",
    effort: "low", suiteHash: suite.canarySuiteDigest([item]), billing: "subscription" as const };
  let saved: Parameters<typeof metrics.projectCanaryRuns>[0] = [];
  const result = await runner.executeCanary(item, pin, { monotonicMs: () => 0,
    admit: async () => ({ state: "admitted" }), save: async r => { saved = [r]; }, request: async () => ({ text: "",
      toolCalls: [{ name: "paid_lookup", args: {} }], resources: { durationMs: 1, firstTextMs: null, generationMs: null,
        inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null,
        usageRatedUsd: null, billing: "subscription", servedModel: null, terminal: "complete" } }) });
  assert.equal(result.reason, "tool-or-authority-violation"); assert.equal(result.run.verified, false);
  assert.equal(result.trace[0]!.denied, true);
  const group = metrics.projectCanaryRuns(saved).groups[0]!;
  assert.equal(group.subscriptionNotional.totalUsd, null); assert.equal(group.identityComparable, false);
});

test("canary production command prepares an inert private suite and failure aware metric report", () => {
  assert.ok(command, "production canary command is absent at this head");
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}canary-adoption-`));
  try {
    command.canaryCommand(["prepare", dir]);
    const m = JSON.parse(readFileSync(join(dir, "model-canary-manifest.json"), "utf8"));
    assert.equal(m.dailyCases, 12); assert.equal(m.cash.experimentDailyCapUsd, 0); assert.equal(m.retentionProtocols.length, 2);
    assert.ok(m.tasks.every((t: object) => !Object.hasOwn(t, "expected")));
    const input = join(dir, "runs.json"); writeFileSync(input, "[]");
    command.canaryCommand(["project", join(dir, "report"), input]);
    assert.equal(JSON.parse(readFileSync(join(dir, "report/model-canary-metrics.json"), "utf8")).uniqueRuns, 0);
    assert.ok(readFileSync(join(dir, "report/model-canary-report.html"), "utf8").includes('id="detail"'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("canary production allocation pins A A and native retention as whole conversation work", () => {
  assert.ok(schedule && retention && suite, "production canary allocation modules are absent at this head");
  const cases = suite.commonCanarySuite().slice(0, 1), suiteHash = suite.canarySuiteDigest(cases);
  const plan = schedule.buildCanarySchedule("2026-10-11", "seed", cases, [{ model: "model", route: "subscription",
    effort: "low", billing: "subscription", suiteHash }], true);
  assert.equal(plan.slots.length, 2); assert.deepEqual(new Set(plan.slots.map(s => s.aaLabel)), new Set(["A", "B"]));
  assert.deepEqual(plan.slots[0]!.pin, plan.slots[1]!.pin); assert.equal(plan.concurrency, 1);
  for (const turns of [25, 50] as const) {
    const p = retention.retentionCanaryProtocol(turns); assert.equal(p.cases.length, turns);
    assert.match(p.instruction, /Never call any tool/); assert.ok(p.cases.some(c => c.prompt.includes("Untrusted note")));
  }
});

test("canary production raw stream refuses cumulative double counts and model attribution conflicts", () => {
  assert.ok(transport, "production canary transport module is absent at this head");
  const c = transport.canaryTransportCapture("anthropic-messages", 0);
  c.event({ type: "message_start", message: { model: "one", usage: { input_tokens: 10, output_tokens: 1 } } }, 1);
  c.event({ type: "message_delta", usage: { output_tokens: 5 } }, 2);
  c.event({ type: "message_delta", usage: { output_tokens: 8 } }, 3);
  c.event({ type: "message_stop" }, 4);
  assert.equal(c.finish(5, "complete").outputTokens, 8);
  c.event({ type: "content_block_start", content_block: { type: "fallback" } }, 5);
  assert.equal(c.finish(6, "complete").servedModel, null); assert.equal(c.finish(6, "complete").terminal, "error");
});
