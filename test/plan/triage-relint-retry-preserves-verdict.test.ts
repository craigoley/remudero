import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { triageCommand } from "#src/run-task.js";
import { lintFiledTasks, runRelintLoop } from "#src/lib/relint.js";
import type { WorkerResult } from "#src/lib/worker.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const feedbackId = "fb-relint-retry";
const taskPath = (id: string) => `plan/tasks.d/${id}-retry.yaml`;
const taskYaml = (id: string, status: string, proof = "unit test: test/retry.test.ts") => [
  `- id: ${id}`,
  "  title: preserve the proposed scope across repair",
  "  repo: remudero",
  `  origin: feedback#${feedbackId}`,
  "  depends_on: []",
  "  type: implement",
  "  verify: auto",
  `  status: ${status}`,
  "  attempts: 0",
  "  files: [test/retry.test.ts]",
  "  acceptance:",
  "    - claim: the repaired proposal survives",
  `      proof: ${JSON.stringify(proof)}`,
  "",
].join("\n");

function worker(text: string): WorkerResult {
  return {
    sessionId: "relint-retry", text, blocks: [text], costUsd: 0, numTurns: 1,
    stderr: "", subtype: "success", isError: false, apiError: false,
    model: "sonnet", effort: "high", tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    qualitySuspect: false,
    compactionEvents: [], childEnvKeys: [], permissionDenials: [], modelUsage: {},
  };
}

async function repairRun(repair: (root: string, id: string, attempt: number) => string) {
  const origin = gitRepo({ bare: true });
  const seed = gitRepo({ seedCommit: false });
  const root = mkdtempSync(join(tmpdir(), "rmd-triage-relint-retry-"));
  const savedHome = process.env.HOME;
  const savedPath = process.env.PATH;
  try {
    mkdirSync(join(seed.dir, "plan", "tasks.d"), { recursive: true });
    mkdirSync(join(seed.dir, "plan", "feedback"), { recursive: true });
    writeFileSync(join(seed.dir, "plan", "tasks.yaml"), "[]\n");
    writeFileSync(join(seed.dir, "MASTER-PLAN.md"), "# fixture\n");
    writeFileSync(join(seed.dir, "plan", "feedback", `${feedbackId}.yaml`), [
      `id: ${feedbackId}`, "ts: 2026-08-02T00:00:00.000Z", "raw: repair the proposed scope",
      "origin: human", "attachments: []", "status: new", "",
    ].join("\n"));
    seed.git("add", "-A");
    seed.git("commit", "-qm", "chore: seed relint fixture");
    seed.addRemote("origin", origin.dir);
    seed.git("push", "-q", "origin", "main");
    const home = join(root, "home");
    const configRoot = join(root, "config");
    const shims = join(root, "bin");
    mkdirSync(join(home, ".config", "remudero"), { recursive: true });
    writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({
      claudeBin: "/usr/bin/true", root: configRoot, installRoot: REPO_ROOT,
    }));
    const repoDir = join(configRoot, "repos", "remudero");
    mkdirSync(dirname(repoDir), { recursive: true });
    seed.git("clone", "-q", origin.dir, repoDir);
    seed.git("-C", repoDir, "config", "user.name", "relint fixture");
    seed.git("-C", repoDir, "config", "user.email", "relint@fixture.invalid");
    mkdirSync(shims);
    writeFileSync(join(shims, "gh"), "#!/bin/sh\nprintf '[]\\n'\n", { mode: 0o755 });
    process.env.HOME = home;
    process.env.PATH = `${shims}:${savedPath}`;
    const prompts: string[] = [];
    const findings: ReturnType<typeof lintFiledTasks>[] = [];
    let filedId = "";
    await triageCommand([feedbackId], {
      spawn: async args => {
        prompts.push(args.prompt);
        const id = /USE EXACTLY `(W\d+-T\d+)`/.exec(args.prompt)?.[1];
        assert.ok(id, "each worker keeps the original reserved task id");
        filedId = id;
        mkdirSync(join(args.cwd, "plan", "tasks.d"), { recursive: true });
        writeFileSync(join(args.cwd, taskPath(id)), taskYaml(id, prompts.length === 1 ? "open" : "queued"));
        const text = prompts.length === 1 ? `PROPOSED: file ${id}` : repair(args.cwd, id, prompts.length);
        findings.push(lintFiledTasks(args.cwd, [id]));
        return worker(text);
      },
    }).catch(error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /^live-write-guard: REFUSED git-push/);
    });
    const ledger = readFileSync(join(configRoot, "state", "ledger.ndjson"), "utf8")
      .trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
    const proposed = ledger.some(row => row.step === "triage.id_minted");
    const commits = seed.git("-C", repoDir, "log", "--all", "--format=%B");
    return { ledger, prompts, findings, proposed, commits, filedId };
  } finally {
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath;
    rmSync(root, { recursive: true, force: true });
    seed.cleanup();
    origin.cleanup();
  }
}

test("a repaired attempt with no fresh verdict line still proposes", async () => {
  const result = await repairRun(() => "The YAML is now fixed.");
  assert.equal(result.prompts.length, 2);
  assert.deepEqual(result.findings[0].map(v => v.check), ["plan-load"]);
  assert.match(result.findings[0][0].message, /invalid status 'open'/);
  assert.deepEqual(result.findings[1], []);
  assert.equal(result.proposed, true, "the real triage caller retains the propose decision");
  assert.ok(result.commits.includes(`file ${result.filedId}`), "the original proposal detail survives");
  assert.match(String(result.ledger.find(row => row.step === "triage.error")?.error), /^live-write-guard: REFUSED git-push/);
});

test("a repaired attempt's files are relinted, not skipped as not-filed", async () => {
  const result = await repairRun((root, id, attempt) => {
    if (attempt === 2) writeFileSync(join(root, taskPath(id)), taskYaml(id, "queued", "trust me"));
    return "Fixed the flagged files.";
  });
  assert.equal(result.prompts.length, 3, "a second blocking finding must buy a third lint round");
  assert.match(result.prompts[1], /\[plan-load\]/);
  assert.match(result.prompts[2], /\[proof-dialect\]/);
  assert.equal(result.ledger.filter(row => row.step === "triage.relint").length, 2);
  assert.equal(result.proposed, true);
});

test("a verdictless repair cannot expand the original proposed files", async () => {
  const result = await repairRun(root => {
    writeFileSync(join(root, "plan", "tasks.d", "W1-T999-extra.yaml"), taskYaml("W1-T999", "queued"));
    return "The YAML is now fixed.";
  });
  assert.equal(result.proposed, false);
  assert.match(String(result.ledger.find(row => row.step === "triage.error")?.error), /no ALREADY_DECIDED/);
});

test("a fresh inconsistent verdict is never replaced by the original proposal", async () => {
  const result = await repairRun(() => "ALREADY_DECIDED: DECISIONS.md");
  assert.equal(result.proposed, false);
  assert.match(String(result.ledger.find(row => row.step === "triage.error")?.error), /ALREADY_DECIDED but files were changed/);
});

test("the relint callback receives the preceding attempt's decision", async () => {
  const previous: Array<number | undefined> = [];
  await runRelintLoop<number>({
    lane: "triage", filedIds: ["W1-T1"], initialPrompt: "file the task",
    run: async (_prompt, attempt, prior) => { previous.push(prior); return attempt; },
    filed: () => true,
    lint: () => previous.length < 3 ? [{ check: "plan-load", severity: "block", message: "repair" }] : [],
    log: () => {},
  });
  assert.deepEqual(previous, [undefined, 1, 2]);
});
