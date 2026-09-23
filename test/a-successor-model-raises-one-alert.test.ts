import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Config } from "../src/lib/config.js";
import { classifySuccessors, watchSuccessorModels, type SuccessorAlert } from "../src/lib/model-availability.js";

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
