import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { defaultExecutor, probeTurnBudget } from "../src/lib/containment.js";
import type { Config } from "../src/lib/config.js";
import { parseIsolationReport } from "../src/lib/isolation.js";
import { parseCodexJsonl } from "../src/lib/worker-provider.js";
import type { SpawnWorkerArgs, WorkerResult } from "../src/lib/worker.js";

const CAPTURE = readFileSync(
  new URL("./fixtures/codex-0.152.0-isolation-probe.jsonl", import.meta.url),
  "utf8",
);

function successfulWorker(text: string): WorkerResult {
  return {
    sessionId: "captured",
    costUsd: 0,
    numTurns: 1,
    text,
    blocks: [text],
    stderr: "",
    subtype: "success",
    isError: false,
    apiError: false,
    permissionDenials: [],
  } as unknown as WorkerResult;
}

test("the captured Codex 0.152.0 isolation transcript satisfies the provider-neutral report contract", () => {
  const worker = parseCodexJsonl(CAPTURE);
  const transcript = [worker.text, worker.blocks.join("\n"), ""].join("\n");
  const report = parseIsolationReport(transcript);

  assert.equal(worker.isError, false);
  assert.equal(worker.numTurns, 1);
  assert.equal(worker.tokens.input, 110855);
  assert.deepEqual(report, { aliasCount: 0, functionCount: 0 });
  assert.equal(Number.isInteger(report?.aliasCount), true);
  assert.equal(Number.isInteger(report?.functionCount), true);
});

test("the containment provider sees a Git repository in only its disposable cwd before spawn", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-codex-preflight-repo-"));
  const config = { root } as Config;
  let spawnedCwd = "";
  const spawn = async (args: SpawnWorkerArgs): Promise<WorkerResult> => {
    spawnedCwd = args.cwd;
    assert.equal(existsSync(join(args.cwd, ".git")), true, "Git identity must exist before provider selection");
    assert.equal(existsSync(join(args.cwd, "..", ".git")), false, "the probe base must not become a repository");
    assert.equal(existsSync(join(root, ".git")), false, "the configured root must not become a repository");
    assert.equal(args.permissionMode, "bypassPermissions");
    assert.equal(args.settingsFile, "settings.json");
    assert.equal(args.maxBudgetUsd, 7.5);
    assert.equal(args.config, config);
    assert.match(args.prompt, /contracttok/);
    assert.equal(args.maxTurns, probeTurnBudget(args.prompt));
    writeFileSync(join(args.cwd, "probe-ok.txt"), "inside");
    return successfulWorker("touch: ../contracttok.txt: Read-only file system");
  };

  const result = await defaultExecutor("settings.json", config, 7.5, spawn)("contracttok");

  assert.equal(result.outsideWriteCreated, false);
  assert.equal(result.insideWriteCreated, true);
  assert.equal(existsSync(spawnedCwd), false, "the disposable repository must be removed after the probe");
});

test("a containment Git initialization failure aborts before worker spawn and cleans the scratch tree", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-codex-preflight-init-failure-"));
  const config = { root } as Config;
  let spawned = false;
  let initializedCwd = "";
  const spawn = async (): Promise<WorkerResult> => {
    spawned = true;
    return successfulWorker("must not run");
  };
  const failInitialization = (cwd: string): void => {
    initializedCwd = cwd;
    throw new Error("synthetic git init failure");
  };

  await assert.rejects(
    () => defaultExecutor("settings.json", config, undefined, spawn, failInitialization)("initfailtok"),
    /synthetic git init failure/,
  );
  assert.equal(spawned, false);
  assert.equal(existsSync(initializedCwd), false, "a failed initialization must not leak its scratch tree");
});

test("a containment worker failure still removes the disposable Git repository", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-codex-preflight-worker-failure-"));
  const config = { root } as Config;
  let spawnedCwd = "";
  const spawn = async (args: SpawnWorkerArgs): Promise<WorkerResult> => {
    spawnedCwd = args.cwd;
    assert.equal(existsSync(join(args.cwd, ".git")), true);
    throw new Error("synthetic worker failure");
  };

  await assert.rejects(
    () => defaultExecutor("settings.json", config, undefined, spawn)("workerfailtok"),
    /synthetic worker failure/,
  );
  assert.equal(existsSync(spawnedCwd), false, "worker failure must not leak the disposable repository");
});
