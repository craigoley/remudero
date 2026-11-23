import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { originWithClone } from "#test/helpers/git-repo.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { paidPilotArmFor } from "#src/lib/benchmark-paid-pilot.js";
import { loadMounts, mountsPath } from "#src/lib/mounts.js";
import type { Task } from "#src/lib/plan.js";
import { modelReplayCommand, readGoldenReplayResults, REPLAY_CORPUS_BOUND, sealedModelReplayDispatcher,
  type ModelReplayInput } from "#src/lib/replay-harness.js";
import { REPLAY_RESULT_STEP, replayResultLine } from "#src/lib/replay.js";
import { withTempDir } from "#src/lib/tmp.js";

const models = ["gpt-6.1-sol", "gpt-6.2-sol"] as const;
const argv = ["--confirm-spend", "--ledger", "unused.ndjson", "--models", models.join(",")];
const mounts = loadMounts(mountsPath(REPO_ROOT));
const proof = "grep: ^ready$ in src/result.txt";
const tokens = { input: 1_000_000, output: 100_000, cacheRead: 200_000, cacheCreation: 0 };

function fixture(dispatcherFor: ModelReplayInput["dispatcherFor"], count = 1) {
  const tasks: Task[] = Array.from({ length: count }, (_, i) => ({ id: `T-GOLD-${i}`, title: `Build fixture ${i}`,
    repo: "remudero", depends_on: [], type: "implement", risk: "medium", verify: "auto", status: "queued",
    attempts: 0, files: ["src/result.txt"], acceptance: [{ claim: "Present", proof, holdout: true }] }));
  const corpus = tasks.flatMap(({ id, acceptance }, i) => {
    const day = String(i + 1).padStart(2, "0");
    return [{ step: "review.posted", task_id: id, ts: `2026-11-${day}T00:00:00Z`,
      merge_base_sha: String(i + 1).repeat(40), decision_verdict: { criteria: acceptance!.map((criterion) => ({
        ...criterion, proof_exec: "executed_pass", reason: "executed against its recorded base",
      })) } }, { step: "verdict.merged", task_id: id, ts: `2026-11-${day}T01:00:00Z` }];
  });
  const lines: Record<string, unknown>[] = [];
  const messages: string[] = [];
  const input: ModelReplayInput = {
    loadMounts: () => mounts,
    readIdle: async () => ({ liveness: { state: "up", quiet: true },
      headroom: { billingMode: "subscription", session: { percentUsed: 20 }, weekly: [{ label: "all models", percentUsed: 30 }] } }),
    loadPlanTasks: () => tasks,
    readCorpusRows: async () => corpus,
    dispatcherFor,
    readResults: async () => lines,
    writeLedger: (path, row) => { assert.equal(path, "unused.ndjson"); lines.push(row); },
    runId: () => "test-replay",
    log: (line) => messages.push(line),
  };
  return { input, lines, messages, tasks };
}

test("W1-T13449 criterion 1: each sampled implement task gets both Codex pins at its recorded merge base", async () => {
  const requests: unknown[] = [];
  const count = REPLAY_CORPUS_BOUND + 2;
  const { input, lines } = fixture((task, item) => async (request) => {
    requests.push({ ...request, id: task.id, base: item.baseSha });
    return { headDir: null, headSha: null, servedModel: null, billingMode: null, costUsd: null };
  }, count);
  assert.equal(await modelReplayCommand([...argv, "--limit", "99"], input), 1);
  assert.equal(lines.length, 2 * REPLAY_CORPUS_BOUND);
  const firstOrder = [...requests];
  requests.length = 0;
  await modelReplayCommand([...argv, "--limit", "99"], input);
  assert.deepEqual(requests, firstOrder, "seeded order is repeatable for the same run and task IDs");
  const dispatched = requests as { id: string; base: string; model: string; effort: string; provider: string; position: number }[];
  for (let i = 0; i < REPLAY_CORPUS_BOUND; i += 1) {
    const pair = dispatched.slice(2 * i, 2 * i + 2);
    const id = `T-GOLD-${count - i - 1}`;
    assert.deepEqual(pair.map((request) => request.id), Array(2).fill(id));
    assert.deepEqual(pair.map((request) => request.base), Array(2).fill(String(count - i).repeat(40)));
    const order = paidPilotArmFor("test-replay", id) === "paid" ? models : [models[1], models[0]];
    assert.deepEqual(pair.map((request) => request.model), order);
    assert.deepEqual(pair.map((request) => request.provider), ["codex", "codex"]);
    assert.deepEqual(pair.map((request) => request.effort), Array(2).fill(mounts.routes.implement!.medium!.src!.effort));
    assert.deepEqual(pair.map((request) => request.position), [0, 1]);
  }

  const noDispatch = fixture(() => { assert.fail("refusal must precede dispatch"); });
  for (const args of [argv.slice(1), argv.slice(0, 1).concat(argv.slice(3)),
    [...argv.slice(0, -1), `${models[0]},${models[0]}`], [...argv.slice(0, -1), `${models[0]},gpt-5-nano`],
    [...argv, "--limit", "-1"]]) {
    assert.equal(await modelReplayCommand(args, noDispatch.input), 2);
  }
  assert.equal(await modelReplayCommand(argv, { ...noDispatch.input, readIdle: async () => ({}) }), 2);
  assert.equal(await modelReplayCommand([...argv, "--limit", "0"], noDispatch.input), 0);
  assert.deepEqual(noDispatch.lines, []);
});

test("W1-T13449 criterion 2: the recorded proof grades each head and each row carries its own usage and verdict", async () => {
  await withTempDir("golden-replay-test", async (dir) => {
    const pass = join(dir, "pass");
    const fail = join(dir, "fail");
    for (const [head, text] of [[pass, "ready"], [fail, "wrong"]] as const) {
      mkdirSync(join(head, "src"), { recursive: true });
      writeFileSync(join(head, "src/result.txt"), `${text}\n`);
    }
    const cleaned: string[] = [];
    const { input, lines } = fixture((_task, item) => async ({ model }) => {
      if (item.taskId === "T-GOLD-0" && model === models[0]) throw new Error("worker unavailable");
      return { headDir: model === models[0] ? pass : fail, headSha: "local", servedModel: model,
        billingMode: "subscription", costUsd: 0, tokens: model === models[0] ? tokens : { ...tokens, output: 200_000 },
        cleanup: () => {
          cleaned.push(`${item.taskId}:${model}`);
          if (item.taskId === "T-GOLD-1" && model === models[0]) throw new Error("cleanup unavailable");
        },
        ...(item.taskId === "T-GOLD-0" ? { pushedRef: "refs/heads/escaped" } : {}),
        ...(item.taskId === "T-GOLD-1" && model === models[1] ? { prUrl: "https://github.com/o/r/pull/1" } : {}),
      };
    }, 3);
    assert.equal(await modelReplayCommand(argv, input), 1);
    const row = (id: string, model: string) => lines.find((line) => line.golden_id === `golden-merged-${id}` && line.model === model)!;
    assert.equal(row("T-GOLD-2", models[0]).verdict, "pass");
    assert.equal(row("T-GOLD-2", models[1]).verdict, "fail");
    assert.equal(row("T-GOLD-1", models[0]).verdict, "unmeasurable");
    assert.deepEqual(row("T-GOLD-1", models[0]).mismatches, ["cleanup-failed:Error"]);
    assert.equal(row("T-GOLD-1", models[1]).verdict, "unmeasurable");
    assert.equal(row("T-GOLD-0", models[1]).verdict, "unmeasurable");
    assert.equal(row("T-GOLD-0", models[0]).verdict, "unmeasurable");
    assert.deepEqual(row("T-GOLD-2", models[0]).tokens, tokens);
    assert.equal(row("T-GOLD-2", models[0]).notional_cost_usd, 2.62);
    assert.equal(row("T-GOLD-2", models[1]).notional_cost_usd, 3.62);
    assert.equal(row("T-GOLD-0", models[0]).notional_cost_usd, undefined);
    assert.equal(Object.hasOwn(row("T-GOLD-0", models[0]), "passed"), false);
    assert.equal(lines.every((line) => line.step === REPLAY_RESULT_STEP), true);
    assert.equal(cleaned.length, 5);
  });
});

test("the production adapter pins the actual Codex transport from a detached historical base", async (t) => {
  await withTempDir("golden-replay-transport", async (root) => {
    const { clone, origin } = originWithClone(join(root, "clone"), { scope: t, seed: { "src/result.txt": "base\n" } });
    const base = clone.git("rev-parse", "HEAD");
    clone.git("commit", "--allow-empty", "-m", "advance main past the historical base");
    clone.git("update-ref", "refs/remotes/origin/main", "HEAD");
    const refs = origin.git("show-ref");
    const worktrees: string[] = [];
    const { input, lines } = fixture((task, item) => {
      const revision = "a".repeat(40);
      const revisions = { harnessRevision: revision, promptRevision: revision, toolRevision: revision,
        scorerRevision: revision, environmentRevision: revision };
      return sealedModelReplayDispatcher({ task, repoDir: clone.dir,
        config: { root, installRoot: REPO_ROOT, claudeBin: "/bin/false", workerProviders: { enabled: ["codex"], codexModel: "gpt-6-sol" } },
        removeTree: (_repoDir, dir) => { clone.git("worktree", "remove", "--force", dir); },
      }, item, (model, effort) => ({ pin: { provider: "codex", model, effort, billing: "subscription", stackHash: revision },
        revisions, stackEvidence: {} }), async (args, config, selection) => {
        assert.ok(selection);
        assert.equal(config.workerProviders?.codexModel, selection.model);
        assert.equal(selection.effort, mounts.routes.implement!.medium!.src!.effort);
        assert.match(clone.git("worktree", "list", "--porcelain"), new RegExp(`HEAD ${base}\\ndetached`));
        assert.doesNotMatch(args.prompt, /grep: \^ready\$/);
        assert.equal(args.env?.GIT_CONFIG_VALUE_0, "sealed-paired-attempt://push-refused");
        assert.deepEqual([args.env?.GH_TOKEN, args.env?.GITHUB_TOKEN, args.env?.SSH_AUTH_SOCK], ["", "", ""]);
        worktrees.push(args.cwd);
        writeFileSync(join(args.cwd, "src/result.txt"), "ready\n");
        return { sessionId: "sealed", costUsd: 0, numTurns: 1, text: "REPORT", blocks: [], stderr: "", subtype: "success",
          isError: false, apiError: false, provider: "codex", permissionDenials: [], childEnvKeys: [], model: selection.model!,
          effort: selection.effort!, tokens, tokenUsageState: "observed", modelUsage: {}, compactionEvents: [], compactionFailures: [],
          compactionConfigured: false, qualitySuspect: false, workerDurationMs: 1, exit: { kind: "exit", code: 0 } };
      });
    });
    const rows = await input.readCorpusRows();
    rows.find((row) => row.step === "review.posted")!.merge_base_sha = base;
    assert.equal(await modelReplayCommand(argv, input), 0);
    assert.deepEqual(lines.map((line) => line.model).sort(), [...models]);
    assert.ok(lines.every((line) => line.verdict === "pass" && line.notional_cost_usd === 2.62));
    assert.equal(new Set(worktrees).size, 2);
    assert.equal(clone.git("worktree", "list").split("\n").length, 1);
    assert.equal(origin.git("show-ref"), refs);
  });
});

test("comparison reads rotated and live replay results through the requested ledger", async () => {
  await withTempDir("golden-replay-ledger", async (dir) => {
    const serialize = (model: string) => JSON.stringify({ step: REPLAY_RESULT_STEP, model }) + "\n";
    const path = join(dir, "ledger.ndjson");
    writeFileSync(join(dir, "ledger.2026-11-19T00-00-00-000Z.ndjson.gz"), gzipSync(serialize(models[0])));
    writeFileSync(path, serialize(models[1]));
    assert.deepEqual((await readGoldenReplayResults(path)).map((row) => row.model), [...models]);
    const standalone = join(dir, "experiment.ndjson");
    writeFileSync(standalone, serialize(models[1]));
    assert.deepEqual((await readGoldenReplayResults(standalone)).map((row) => row.model), [models[1]]);
  });
});

test("W1-T13449 criterion 3: comparison uses complete within-run pairs and prints the pair count and exact test", async () => {
  const { input, lines, messages } = fixture(() => { assert.fail("zero limit cannot dispatch"); });
  const row = (run: string, golden: string, model: string, verdict: string, cost: number) => ({
    step: REPLAY_RESULT_STEP, run_id: run, golden_id: golden, model, verdict, notional_cost_usd: cost,
  });
  for (const run of ["one", "two", "three"]) {
    lines.push(row(run, "same-golden", models[0], "pass", 2), row(run, "same-golden", models[1], "fail", 4));
  }
  lines.push(row("four", "another-golden", models[0], "pass", 6), row("four", "another-golden", models[1], "pass", 8),
    row("one", "incomplete", models[0], "pass", 400), row("two", "incomplete", models[1], "fail", 400),
    row("one", "unmeasured", models[0], "unmeasurable", 30), row("one", "unmeasured", models[1], "pass", 40));
  assert.equal(await modelReplayCommand([...argv, "--limit", "0"], input), 0);
  const summary = messages.join("\n");
  assert.match(summary, /4 paired grades/);
  assert.match(summary, /gpt-6\.1-sol: 4 passes.*\$3\.00 per pass/);
  assert.match(summary, /gpt-6\.2-sol: 1 pass.*\$20\.00 per pass/);
  assert.match(summary, /3 discordant.*3 vs 0.*exact McNemar p=0\.25/);
});

test("W1-T13449 criterion 4: dispatch receives a sealed request and the legacy ledger shape stays exact", async () => {
  const { input, tasks, lines } = fixture((task) => async ({ isolation }) => {
    assert.equal(task.acceptance, undefined);
    assert.deepEqual(isolation, { worktree: "fresh-detached", push: false, openPr: false, merge: false });
    return { headDir: null, headSha: null, servedModel: null, costUsd: null, billingMode: null };
  });
  assert.equal(await modelReplayCommand(argv, input), 1);
  assert.equal(lines.length, 2);
  tasks[0]!.prompt = `Quoted scorer: ${proof}`;
  assert.equal(await modelReplayCommand(argv, { ...input, dispatcherFor: () => assert.fail("proof leaked to dispatcher") }), 1);
  assert.equal(lines.length, 4);
  assert.deepEqual(lines.slice(-2).map((line) => line.verdict), ["unmeasurable", "unmeasurable"]);
  assert.deepEqual(replayResultLine("legacy", "task", { goldenId: "golden", class: "src-fix", passed: true, mismatches: [] }), {
    run_id: "legacy", task_id: "task", step: REPLAY_RESULT_STEP, golden_id: "golden", class: "src-fix", passed: true,
  });
});
