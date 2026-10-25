import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fixedClock } from "#src/lib/clock.js";
import type { Config } from "#src/lib/config.js";
import {
  FOUNDRY_CLAUDE_DAILY_CAP_USD,
  OpenWeightAllowanceExhaustedError,
  openWeightAllowancePath,
  openWeightCommittedUsd,
  reserveOpenWeightBudget,
  spawnOpenWeightWorker,
  type OpenWeightAllowanceState,
  type OpenWeightWorkerResult,
} from "#src/lib/worker-provider.js";
import { spawnWorker, type WorkerSelectionAssignment } from "#src/lib/worker.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

function fixture(t: TestContext) {
  const { dir: root } = ownedFixtureDir(t, "sonnet-cap-luna");
  const clock = fixedClock(Date.now());
  const config = {
    root, claudeBin: "/unused", dailyCapUsd: { normal: 10, squeezed: 25 },
    workerProviders: { enabled: ["cash"], cashEndpoint: "https://cash.example.test/" },
  } as Config;
  const reserve = (requestId: string, deployment: string, requestBodyBytes: number, squeezed = true) =>
    reserveOpenWeightBudget(config, { requestId, deployment, requestBodyBytes, squeezed, atIso: clock.iso() });
  const state = () => JSON.parse(readFileSync(openWeightAllowancePath(config), "utf8")) as OpenWeightAllowanceState;
  return { root, clock, config, reserve, state };
}

async function runRefusedSonnet(t: TestContext, limit: "foundry-claude" | "fleet", midRun: boolean,
  fallbackRefused = false) {
  const f = fixture(t);
  if (limit === "foundry-claude") f.reserve("prior", "claude-sonnet-5-5", midRun ? 2_430_000 : 2_479_000);
  else f.reserve("prior", "gpt-6-luna", midRun ? 123_970_000 : 124_965_000);
  writeFileSync(join(f.root, "large.txt"), "x".repeat(100_000));
  const assignments: WorkerSelectionAssignment[] = [];
  const attempts: OpenWeightWorkerResult[] = [];
  const selections: string[] = [];
  let anthropicRequests = 0;
  let lunaRequests = 0;
  const result = await spawnWorker({
    cwd: f.root, config: f.config, prompt: "read large.txt and finish", model: "sonnet", effort: "medium",
    permissionMode: "bypassPermissions", settingsFile: join(REPO_ROOT, "settings", "worker.json"),
    mountProvider: "cash", cashSonnetEmergency: true, cashSqueezed: true, maxTurns: 3, tools: ["Read"],
    routingFallback: { rule: "cash-sonnet-fallback", capacities: [] },
    onSelectionAssignment: assignment => assignments.push(assignment),
    providerRouting: {
      now: () => f.clock.now(),
      spawnOpenWeight: async (args, config, selection) => {
        selections.push(selection.model);
        const attempt = await spawnOpenWeightWorker({
          ...args, clock: f.clock,
          env: { RMD_OPENWEIGHT_API_KEY: "fixture-key", RMD_FOUNDRY_CLAUDE_API_KEY: "fixture-key",
            RMD_FOUNDRY_CLAUDE_ENDPOINT: "https://foundry.example.test/anthropic" },
          fetchImpl: async url => {
            if (String(url).includes("/anthropic")) {
              anthropicRequests++;
              return Response.json({ id: "sonnet-billed", model: "claude-sonnet-5-5", stop_reason: "tool_use",
                content: [{ type: "tool_use", id: "read-once", name: "read_file", input: { path: "large.txt" } }],
                usage: { input_tokens: 100, output_tokens: 20 } });
            }
            lunaRequests++;
            return fallbackRefused ? new Response(null, { status: 401 }) : Response.json({
              id: "luna-finished", model: selection.model,
              choices: [{ message: { content: "luna carried the work" }, finish_reason: "stop" }],
              usage: { prompt_tokens: 30, completion_tokens: 10 },
            });
          },
        }, config, selection);
        attempts.push(attempt);
        return attempt;
      },
    },
  });
  return { ...f, result, assignments, attempts, selections, anthropicRequests, lunaRequests };
}

test("W1-T10384: a sonnet run stopped by the foundry claude cap continues on the luna ladder", async t => {
  const f = await runRefusedSonnet(t, "foundry-claude", true);
  const sonnet = f.attempts[0]!;
  assert.equal(f.anthropicRequests, 1, "Sonnet billed one request before its next reservation was refused");
  assert.equal(sonnet.budgetSettledUsd, 0.0004);
  assert.equal(sonnet.budgetRefused, true);
  assert.equal(sonnet.subtype, "cash_allowance_exhausted");
  assert.equal(f.result.isError, false, f.result.stderr);
  assert.equal(sonnet.cashAllowanceLimit, "foundry-claude");
  assert.equal(f.result.text, "luna carried the work");
  assert.deepEqual(f.selections, ["claude-sonnet-5-5", "gpt-6-luna"]);
  assert.equal(f.lunaRequests, 1);
  assert.deepEqual(f.assignments.map(a => a.routing.decision?.rule), ["cash-sonnet-fallback", "cash-fallback"]);
  const rows = Object.values(f.state().reservations);
  assert.equal(rows.length, 3, "prior spend, one Sonnet request and one Luna request are counted once each");
  assert.deepEqual(rows.filter(row => row.deployment === "claude-sonnet-5-5" && row.settledUsd !== null)
    .map(row => row.settledUsd), [sonnet.budgetSettledUsd]);
  assert.equal(openWeightCommittedUsd(f.state()), 9.8 + sonnet.budgetSettledUsd + f.attempts[1]!.budgetSettledUsd);

  await t.test("a refused Luna attempt does not re-enter Sonnet or cash again", async child => {
    const refused = await runRefusedSonnet(child, "foundry-claude", true, true);
    assert.equal(refused.result.isError, true);
    assert.deepEqual(refused.selections, ["claude-sonnet-5-5", "gpt-6-luna"]);
    assert.equal(refused.assignments.length, 2);
  });
  await t.test("a Foundry refusal before billing still enters Luna", async child => {
    const before = await runRefusedSonnet(child, "foundry-claude", false);
    assert.equal(before.anthropicRequests, 0);
    assert.equal(before.attempts[0]!.budgetSettledUsd, 0);
    assert.equal(before.result.isError, false, before.result.stderr);
    assert.deepEqual(before.selections, ["claude-sonnet-5-5", "gpt-6-luna"]);
  });
});

test("W1-T10384: a fleet cap refusal does not re-enter cash", async t => {
  for (const midRun of [false, true]) {
    await t.test(midRun ? "after billing" : "before transport", async child => {
      const f = await runRefusedSonnet(child, "fleet", midRun);
      assert.equal(f.result.isError, true);
      assert.equal(f.result.budgetRefused, true);
      assert.equal(f.result.cashAllowanceLimit, "fleet");
      assert.equal(f.attempts[0]!.cashAllowanceLimit, "fleet");
      assert.equal(f.anthropicRequests, midRun ? 1 : 0);
      assert.equal(f.result.budgetSettledUsd, midRun ? 0.0004 : 0);
      assert.equal(f.lunaRequests, 0);
      assert.deepEqual(f.selections, ["claude-sonnet-5-5"]);
      assert.equal(f.assignments.length, 1);
    });
  }
});

test("W1-T10384: the allowance refusal names the foundry claude cap", t => {
  assert.deepEqual(FOUNDRY_CLAUDE_DAILY_CAP_USD, { normal: 5, squeezed: 10 });
  for (const squeezed of [false, true]) {
    const foundry = fixture(t);
    foundry.reserve("prior", "claude-sonnet-5-5", squeezed ? 2_479_000 : 1_229_000, squeezed);
    assert.throws(() => foundry.reserve(`refused-${squeezed}`, "claude-sonnet-5-5", 10, squeezed), error => {
      assert.ok(error instanceof OpenWeightAllowanceExhaustedError);
      assert.equal(error.limit, "foundry-claude");
      assert.equal(error.posture, squeezed ? "squeezed" : "normal");
      assert.equal(error.capUsd, squeezed ? 10 : 5);
      assert.match(error.message, /foundry-claude/);
      assert.ok(error.message.includes(squeezed ? "squeezed" : "normal"));
      assert.match(error.message, /FOUNDRY_CLAUDE_DAILY_CAP_USD/);
      assert.doesNotMatch(error.message, /dailyCapUsd/);
      assert.equal(error.resetAt, new Date(Date.parse(`${foundry.clock.iso().slice(0, 10)}T00:00:00Z`) + 86_400_000).toISOString());
      return true;
    });
  }
  const fleet = fixture(t);
  fleet.reserve("prior", "gpt-6-luna", 124_965_000);
  for (const squeezed of [false, true]) {
    assert.throws(() => fleet.reserve(`refused-${squeezed}`, "claude-sonnet-5-5", 10, squeezed), error => {
      assert.ok(error instanceof OpenWeightAllowanceExhaustedError);
      assert.equal(error.limit, "fleet");
      assert.equal(error.posture, squeezed ? "squeezed" : "normal");
      assert.equal(error.capUsd, squeezed ? 25 : 10);
      assert.match(error.message, /fleet/);
      assert.ok(error.message.includes(squeezed ? "squeezed" : "normal"));
      assert.match(error.message, /dailyCapUsd/);
      return true;
    });
  }
});
