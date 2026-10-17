import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { parse, stringify } from "yaml";
import type { Config } from "../src/lib/config.js";
import { inboxDraftExampleFragmentYaml, runDraftRung, type Proposal } from "../src/lib/inbox.js";
import { seededRandom } from "../src/lib/knowledge-value.js";
import { loadMounts, mountsPath } from "../src/lib/mounts.js";
import { withTempDir } from "../src/lib/tmp.js";
import { spawnWorker, type SpawnWorkerArgs, type WorkerResult } from "../src/lib/worker.js";
import { buildInboxDraftSpawnArgs } from "../src/run-task.js";

const ladder = ["gpt-oss-120b", "gpt-5-nano"];
const mount = { model: "haiku", effort: "high", provider: "cash", maxTurns: 400, contextBudget: 180000 } as const;
const clean = `=== FRAGMENT START ===\n${inboxDraftExampleFragmentYaml()}\n=== FRAGMENT END ===\nSTAMP: - P9 (proposal) — RATIFIED 2026-01-01 -> NEW-1.`;
const dirty = '=== FRAGMENT START ===\n- id: NEW-1\n  title: "x"\n  acceptance: not a list\n=== FRAGMENT END ===\nSTAMP: - P9 (proposal) — RATIFIED 2026-01-01 -> NEW-1.';

function result(model: string, text = clean): WorkerResult {
  return { model, routedModel: model, text, blocks: [], provider: "cash", effort: "high",
    sessionId: model, costUsd: 0.01, numTurns: 1, stderr: "", subtype: "success", isError: false,
    apiError: false, permissionDenials: [], childEnvKeys: [],
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, modelUsage: {},
    compactionEvents: [], compactionFailures: [], compactionConfigured: false, qualitySuspect: false };
}

async function fixture(run: (f: {
  spawn: (avoidModels: readonly string[], prompt?: string, contractFailure?: boolean) => Promise<WorkerResult>;
  attempts: string[];
  rows: Array<{ step: string; extra: Record<string, unknown> }>;
}) => Promise<void>) {
  await withTempDir("rmd-redraft-", async (root) => {
    const table = parse(readFileSync(mountsPath(process.cwd()), "utf8"));
    table.capabilities.cash.economy.high = ladder;
    mkdirSync(dirname(mountsPath(root)), { recursive: true });
    writeFileSync(mountsPath(root), stringify(table));
    assert.deepEqual(loadMounts(mountsPath(root)).capabilities!.cash!.economy.high, ladder);
    const settingsFile = join(root, "settings.json");
    writeFileSync(settingsFile, JSON.stringify({ sandbox: {
      enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false,
    } }));
    const config = { root, workerHomeRoot: join(root, "worker-home"), claudeBin: "/unused",
      workerProviders: { enabled: ["cash"] } } as Config;
    const rows: Array<{ step: string; extra: Record<string, unknown> }> = [];
    const attempts: string[] = [];
    const savedHome = process.env.HOME;
    process.env.HOME = root;
    try {
      await run({ attempts, rows, spawn: async (avoidModels, prompt = "draft P9", contractFailure = false) => {
        const args = buildInboxDraftSpawnArgs({ cwd: root, settingsFile, config, prompt, mount,
          disallowedTools: [], proposalId: "P9", avoidModels,
          draftRoutingLog: (step, extra = {}) => rows.push({ step, extra }) });
        args.draftRouting!.readStats = () => ({
          "gpt-oss-120b": { attempts: 10000, clean: 10000, contractFailures: 0, costUsd: 1 },
          "gpt-5-nano": { attempts: 10000, clean: 0, contractFailures: 10000, costUsd: 100 },
        });
        args.draftRouting!.random = seededRandom(9067);
        args.draftRouting!.evaluate = () => ({ clean: !contractFailure, contractFailed: contractFailure });
        return spawnWorker({ ...args, providerRouting: { spawnOpenWeight: async (_args, _config, selection) => {
          attempts.push(selection.model);
          return result(selection.model, selection.model === ladder[0] ? dirty : clean);
        } } });
      } });
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
    }
  });
}

test("W1-T9067: the draft spawn passes avoidModels to the worker", async () => {
  const ctx = { attempt: 2, avoidModels: ["gpt-oss-120b"] };
  const args = buildInboxDraftSpawnArgs({ cwd: process.cwd(), settingsFile: "/unused", prompt: "draft P9",
    mount, config: { root: "/unused" } as Config, disallowedTools: [], avoidModels: ctx.avoidModels });
  const recorded: SpawnWorkerArgs[] = [];
  const rawSpawn: typeof spawnWorker = async (request) => { recorded.push(request); return result("gpt-5-nano"); };
  await rawSpawn(args);
  assert.deepEqual(recorded[0].avoidModels, ["gpt-oss-120b"]);
});

test("W1-T9067: a fell-through draft retries on a different model", async () => {
  await fixture(async ({ spawn, attempts, rows }) => {
    const proposal = { id: "P9", summary: "proposal", evidenceAnchors: [] } as unknown as Proposal;
    const [outcome] = await runDraftRung([proposal], "- id: W1-T1\n", {
      spawn: (_proposal, prompt, ctx) => spawn(ctx!.avoidModels, prompt),
      log: (step, extra = {}) => rows.push({ step, extra }),
    }, "run-redraft");
    assert.deepEqual(attempts, ladder);
    assert.equal(outcome.ok, true);
    const fell = rows.filter((row) => row.step === "inbox.draft_fellthrough");
    assert.equal(fell.length, 1);
    assert.equal(fell[0].extra.from, ladder[0]);
    assert.equal(fell[0].extra.to, ladder[1]);
  });
});

test("W1-T9067: an exhausted avoid list keeps the ladder and names it", async () => {
  await fixture(async ({ spawn, attempts, rows }) => {
    await spawn(ladder, "draft P9", true);
    assert.deepEqual(attempts, ladder);
    assert.equal(rows.find((row) => row.step === "draft.routing.choice")!.extra.reason, "avoid-exhausted");
  });
});

test("W1-T9067: avoidance never restores a candidate excluded by context fit", async () => {
  await fixture(async ({ spawn, attempts, rows }) => {
    await spawn(["gpt-5-nano"], "x".repeat(800000));
    assert.deepEqual(attempts, ["gpt-5-nano"]);
    assert.equal(rows.find((row) => row.step === "draft.routing.choice")!.extra.reason, "avoid-exhausted");
  });
});

test("W1-T9067: the walking ladder cannot return to an avoided model", async () => {
  await fixture(async ({ spawn, attempts }) => {
    await spawn(["gpt-oss-120b"], "draft P9", true);
    assert.deepEqual(attempts, ["gpt-5-nano"]);
  });
});
