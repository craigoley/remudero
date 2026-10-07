import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseCodexJsonl, spawnCodexWorker } from "../src/lib/worker-provider.js";

const completed = (usage?: Record<string, unknown>) => ({ type: "turn.completed", ...(usage ? { usage } : {}) });
const zero = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 };
const used = { input_tokens: 100, cached_input_tokens: 25, output_tokens: 10 };
const jsonl = (events: unknown[]) => events.map((event) => JSON.stringify(event)).join("\n") + "\n";

test("Codex token usage distinguishes absent, partial and explicitly reported zero", () => {
  for (const events of [[], [{ type: "turn.failed", error: { message: "quota refused" } }], [completed()], [completed({})]]) {
    assert.equal(parseCodexJsonl(jsonl(events)).tokenUsageState, "unavailable");
  }
  assert.equal(parseCodexJsonl(jsonl([completed(zero)])).tokenUsageState, "observed");
  assert.equal(parseCodexJsonl(jsonl([completed(used), completed()])).tokenUsageState, "partial");
  assert.equal(parseCodexJsonl(jsonl([completed(used), { type: "turn.started" }])).tokenUsageState, "partial");
  assert.equal(parseCodexJsonl(jsonl([completed(used), { type: "turn.failed", error: { message: "failed next turn" } }])).tokenUsageState, "partial");
  const all = parseCodexJsonl(jsonl([completed(used), completed(used)]));
  assert.equal(all.tokenUsageState, "observed");
  assert.deepEqual(all.tokens, { input: 200, output: 20, cacheRead: 50, cacheCreation: 0 });
});

test("Codex malformed token counts and overflow cannot become a notional observation", () => {
  for (const field of Object.keys(zero)) {
    for (const value of [undefined, null, "0", -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      assert.equal(parseCodexJsonl(jsonl([completed({ ...zero, [field]: value })])).tokenUsageState, "unavailable", `${field}:${String(value)}`);
    }
  }
  assert.equal(parseCodexJsonl(jsonl([completed({ ...zero, cached_input_tokens: 1 })])).tokenUsageState, "unavailable");
  assert.equal(parseCodexJsonl(jsonl([completed({ ...zero, input_tokens: Number.MAX_SAFE_INTEGER }), completed(used)])).tokenUsageState, "partial");
  assert.equal(parseCodexJsonl(jsonl([completed(used)]) + "not-json\n").tokenUsageState, "partial");
});

async function realWorker(events: unknown[]) {
  const root = mkdtempSync(join(tmpdir(), "rmd-codex-usage-evidence-"));
  try {
    const script = join(root, "emit.mjs");
    writeFileSync(script, `process.stdin.resume(); process.stdin.once('end', () => process.stdout.write(${JSON.stringify(jsonl(events))}));\n`);
    const bin = join(root, "codex-fixture");
    // This launches the real containment default and a real pinned Node child.
    writeFileSync(bin, `#!/bin/sh\nexec '${process.execPath}' '${script}'\n`);
    chmodSync(bin, 0o700);
    return await spawnCodexWorker({ workerHome: mkdtempSync(join(root, "home-")), cwd: root, prompt: "synthetic usage only",
      settingsFile: join(process.cwd(), "settings/worker.json"), tools: [] },
    { claudeBin: "/unused/claude", root, workerProviders: { enabled: ["codex"], codexBin: bin,
      codexModel: "gpt-6.1-sol", codexHome: join(root, "empty-auth") } });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("a real Codex worker with no reported usage has no notional price", async () => {
  for (const events of [[{ type: "turn.failed", error: { message: "synthetic refusal" } }], [completed()],
    [completed(used), completed()], [completed(used), { type: "turn.started" }]]) {
    const result = await realWorker(events);
    assert.equal(result.notionalCostUsd, undefined);
    assert.equal(result.costUsd, 0);
  }
});

test("a real Codex worker prices complete usage, including an explicitly reported zero", async () => {
  const noTokens = await realWorker([completed(zero)]);
  assert.equal(noTokens.notionalCostUsd, 0);
  assert.equal(noTokens.costUsd, 0);
  const withTokens = await realWorker([completed(used)]);
  assert.ok(withTokens.notionalCostUsd !== undefined && withTokens.notionalCostUsd > 0);
  assert.equal(withTokens.costUsd, 0);
});
