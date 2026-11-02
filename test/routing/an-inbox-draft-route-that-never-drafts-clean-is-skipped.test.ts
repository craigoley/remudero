import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { Config } from "#src/lib/config.js";
import { chooseDraftDeployment, type DraftStats } from "#src/lib/draft-routing.js";
import { seededRandom } from "#src/lib/knowledge-value.js";
import { withTempDir } from "#src/lib/tmp.js";
import { spawnWorker, type WorkerResult } from "#src/lib/worker.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const bad = "gpt-5-nano", good = "gpt-oss-120b";
const candidates = [{ deployment: bad, estimatedCostUsd: 0.000001 },
  { deployment: good, estimatedCostUsd: 1 }];
const measured = (attempts: number, clean: number, costUsd = 0.000001) =>
  ({ attempts, clean, contractFailures: attempts - clean, costUsd });

test("test/routing/an-inbox-draft-route-that-never-drafts-clean-is-skipped.test.ts", async (t) => {
  await t.test("skips sub-five-percent routes after fifty attempts despite their low cost", () => {
    for (const [attempts, clean] of [[50, 0], [50, 2], [476, 2]]) {
      const stats = { [bad]: measured(attempts, clean), [good]: measured(100, 60, 100) };
      const choice = chooseDraftDeployment(stats, candidates, seededRandom(73));
      assert.equal(choice.deployment, good);
      assert.deepEqual(choice.arms.map((arm) => arm.deployment), [good]);
    }
  });

  await t.test("still samples fewer than fifty attempts and exactly five percent clean", () => {
    for (const [attempts, clean] of [[0, 0], [49, 0], [100, 5]]) {
      const stats = { [bad]: measured(attempts, clean, 1), [good]: measured(100, 60, 1) };
      const choice = chooseDraftDeployment(stats, candidates, seededRandom(73));
      assert.deepEqual(choice.arms.map((arm) => arm.deployment), [bad, good]);
      assert.equal(choice.arms[0].alpha, 1 + clean);
      assert.equal(choice.arms[0].beta, 1 + attempts - clean);
      assert.ok(choice.arms[0].sampledCleanRate > 0);
    }
  });

  await t.test("does not empty the eligible set or resurrect a deployment outside it", () => {
    const stats = { [bad]: measured(100, 0), [good]: measured(100, 0), outside: measured(100, 100) };
    assert.equal(chooseDraftDeployment(stats, [candidates[0]], seededRandom(73)).deployment, bad);
    assert.deepEqual(chooseDraftDeployment(stats, candidates, seededRandom(73)).arms.map((arm) => arm.deployment), [bad, good]);
    const unknown = { deployment: "untried", estimatedCostUsd: 1 };
    assert.equal(chooseDraftDeployment(stats, [candidates[0], unknown], seededRandom(73)).deployment, "untried");
  });

  await t.test("the production choice ledgers each skip with its measured rate and count", async () => {
    await withTempDir("inbox-route-floor-", async (root) => {
      const settingsFile = join(root, "settings.json");
      writeFileSync(settingsFile, JSON.stringify({ sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false } }));
      const config = { root, workerHomeRoot: join(root, "worker-homes"), claudeBin: "/unused",
        dailyCapUsd: { normal: 10, squeezed: 10 },
        workerProviders: { enabled: ["cash"], cashEndpoint: "https://fixture.invalid/" } } as Config;
      const rows: Record<string, unknown>[] = [], invoked: string[] = [];
      const stats: DraftStats = { [bad]: measured(476, 2), [good]: measured(100, 60, 100) };
      const savedHome = process.env.HOME;
      process.env.HOME = root;
      try {
        await spawnWorker({ cwd: REPO_ROOT, permissionMode: "bypassPermissions", settingsFile, config,
          prompt: "Draft fixture only.", model: "haiku", effort: "low", mountProvider: "cash", maxTurns: 1, tools: [],
          onSelectionAssignment: () => {},
          routingTrial: { id: "clean-rate-floor", arm: "cash", reason: "fixture", models: [bad, good] },
          draftRouting: { lane: "inbox-draft", proposalId: "P1", readStats: () => stats, random: seededRandom(73),
            log: (step, extra = {}) => rows.push({ step, ...extra }),
            evaluate: () => ({ clean: true, contractFailed: false }) },
          providerRouting: { spawnOpenWeight: async (_args, _config, selection) => {
            invoked.push(selection.model);
            return { provider: "cash", model: selection.model, routedModel: selection.model, text: "fixture", blocks: [],
              isError: false, apiError: false, subtype: "success", stderr: "", costUsd: 0.01, sessionId: "fixture", numTurns: 1,
              tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 }, permissionDenials: [], childEnvKeys: [],
              effort: "low", modelUsage: {}, compactionEvents: [], compactionFailures: [], compactionConfigured: false,
              qualitySuspect: false } satisfies WorkerResult;
          } },
        });
      } finally {
        if (savedHome === undefined) delete process.env.HOME;
        else process.env.HOME = savedHome;
      }
      assert.deepEqual(invoked, [good]);
      const choice = JSON.parse(JSON.stringify(rows.find((row) => row.step === "draft.routing.choice")));
      assert.deepEqual(choice.posterior.skipped, [{ deployment: bad, attempts: 476, cleanRate: 2 / 476 }]);
    });
  });
});
