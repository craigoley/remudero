import assert from "node:assert/strict";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Config } from "../src/lib/config.js";
import {
  classifySuccessors,
  readCashModelCatalog,
  readCodexModelCatalog,
  watchSuccessorModels,
  type SuccessorAlert,
} from "../src/lib/model-availability.js";

test("W1-T4080: a higher generation in a routed family is a successor", () => {
  const successors = classifySuccessors(
    ["gpt-5.6-luna", "gpt-5.6-terra"],
    [{ source: "codex", models: ["gpt-6-luna", "gpt-5.6-luna", "gpt-6-unrelated"] }],
  );
  assert.deepEqual(successors.map((successor) => successor.model), ["gpt-6-luna"]);
  assert.equal(successors[0]?.state, "announced");
  assert.equal(successors[0]?.nextStep, "deploy gpt-6-luna on the Azure cash lane");
});

test("W1-T4080: one alert per successor state, naming the next step", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-model-successor-"));
  const alerts: SuccessorAlert[] = [];
  const ledger: Record<string, unknown>[] = [];
  const config = { claudeBin: "/unused", root, workerProviders: { enabled: ["cash", "codex"] } } as Config;
  const base = {
    config,
    routedModels: ["gpt-5.6-luna"],
    statePath: join(root, "state", "successors.json"),
    readCash: async () => ["gpt-6-luna"],
    readCodex: async () => ["gpt-6-luna"],
    ledger: (row: Record<string, unknown>) => ledger.push(row),
    alert: async (alert: SuccessorAlert) => {
      alerts.push(alert);
      return `https://github.test/issues/${alerts.length}`;
    },
  };
  try {
    const first = await watchSuccessorModels(base);
    const second = await watchSuccessorModels(base);
    assert.equal(first.alerted.length, 1);
    assert.equal(second.alerted.length, 0, "an unchanged state is deduplicated from durable state");
    assert.equal(alerts[0]?.state, "deployed-unpriced");
    assert.match(alerts[0]?.nextStep ?? "", /add gpt-6-luna/);
    assert.ok(ledger.some((row) => row.step === "model.successor.read"));
    assert.ok(ledger.some((row) => row.step === "model.successor.alerted"));

    const changed = await watchSuccessorModels({
      ...base,
      readCash: async () => [],
      readCodex: async () => ["gpt-6-luna"],
    });
    assert.equal(changed.alerted.length, 1, "a state transition is a new alert key");
    assert.equal(alerts[1]?.state, "announced");
    assert.match(alerts[1]?.nextStep ?? "", /deploy gpt-6-luna/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T4080: a gated family is reported but never proposed", () => {
  const successors = classifySuccessors(
    ["gpt-5-astra"],
    [{ source: "codex", models: ["gpt-6-astra"] }],
  );
  assert.equal(successors.length, 1);
  assert.equal(successors[0]?.gated, true);
  assert.equal(successors[0]?.actionable, false);
  assert.match(successors[0]?.nextStep ?? "", /operator approval/);
});

test("W1-T4080: provider catalog readers and checkout routing remain bounded", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-model-catalog-"));
  const mountsDir = join(root, ".remudero");
  mkdirSync(mountsDir, { recursive: true });
  copyFileSync(join(process.cwd(), ".remudero", "mounts.yaml"), join(mountsDir, "mounts.yaml"));
  const codexBin = join(root, "codex-fixture");
  writeFileSync(
    codexBin,
    `#!/bin/sh
printf '%s\\n' '{"id":1,"result":{}}' '{"id":2,"result":{}}' '{"id":3,"result":{"data":[{"id":"gpt-6-luna"},{"model":"gpt-5.6-luna"}]}}'
sleep 2
`,
    { mode: 0o700 },
  );
  chmodSync(codexBin, 0o700);
  const config = {
    claudeBin: "/unused",
    root,
    workerProviders: {
      enabled: ["cash", "codex"],
      cashEndpoint: "https://cash.example.test/",
      codexBin,
    },
  } as Config;
  try {
    const cash = await readCashModelCatalog(
      config,
      async (url, init) => {
        assert.equal(url, "https://cash.example.test/openai/models?api-version=2024-10-21");
        assert.equal((init?.headers as Record<string, string>)["api-key"], "cash-key");
        return new Response(JSON.stringify({ data: [{ id: "gpt-6-luna" }, { model: "gpt-5.6-luna" }] }), { status: 200 });
      },
      { RMD_OPENWEIGHT_API_KEY: "cash-key" },
    );
    assert.deepEqual(cash, ["gpt-5.6-luna", "gpt-6-luna"]);
    await assert.rejects(
      () => readCashModelCatalog({ claudeBin: "/unused", root } as Config, async () => new Response()),
      /cash model catalog requires workerProviders\.cashEndpoint/,
    );
    await assert.rejects(
      () => readCashModelCatalog(config, async () => new Response(), {}),
      /cash model catalog requires RMD_OPENWEIGHT_API_KEY/,
    );

    const codex = await readCodexModelCatalog(config);
    assert.deepEqual(codex, ["gpt-5.6-luna", "gpt-6-luna"]);

    const reading = await watchSuccessorModels({
      config,
      statePath: join(root, "successors.json"),
      readCash: async () => [],
      readCodex: async () => ["gpt-7-luna"],
    });
    assert.equal(reading.status, "measured");
    assert.equal(reading.successors[0]?.model, "gpt-7-luna");
    assert.deepEqual(reading.successors[0]?.sources, ["codex"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
