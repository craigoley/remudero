import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { triageCommand } from "#test/helpers/run-task-test.js";
import { lintFiledTasks } from "#src/lib/relint.js";
import { parseTriageVerdict } from "#src/lib/triage.js";
import type { WorkerResult } from "#src/lib/worker.js";
import { ghShim } from "#test/helpers/gh-shim.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const FEEDBACK_ID = "fb-triage-relint-verdict";
const CORE_PROOF = "unit test: test/relint-loop.test.ts";

function taskYaml(id: string, status: string, proof = CORE_PROOF): string {
  return [
    `- id: ${id}`,
    "  title: repair the triage filing",
    "  repo: remudero",
    `  origin: feedback#${FEEDBACK_ID}`,
    "  depends_on: []",
    "  type: implement",
    "  verify: auto",
    `  status: ${status}`,
    "  attempts: 0",
    "  files: [src/lib/triage.ts]",
    "  acceptance:",
    "    - claim: the triage filing remains executable",
    `      proof: ${JSON.stringify(proof)}`,
    "",
  ].join("\n");
}

function worker(text: string): WorkerResult {
  return {
    sessionId: "triage-relint-verdict", costUsd: 0, numTurns: 1, text, blocks: [text],
    stderr: "", subtype: "success", isError: false, apiError: false,
    model: "claude-opus-5", effort: "high",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    totalCostUsd: 0, billingMode: "subscription", verdict: "success",
    qualitySuspect: false, compactionEvents: [], childEnvKeys: [],
  } as unknown as WorkerResult;
}

type Round = { status: string; proof?: string; text?: string; extraFile?: string; replaceFiled?: boolean };

async function runRepair(t: TestContext, rounds: Round[]) {
  const origin = gitRepo({ bare: true, scope: t });
  const seed = gitRepo({ scope: t });
  const root = ownedFixtureDir(t, "triage-relint-verdict").dir;
  mkdirSync(join(seed.dir, "plan", "tasks.d"), { recursive: true });
  mkdirSync(join(seed.dir, "plan", "feedback"), { recursive: true });
  writeFileSync(join(seed.dir, "plan", "tasks.yaml"), taskYaml("W1-T4", "queued"));
  writeFileSync(join(seed.dir, "MASTER-PLAN.md"), "# Fixture plan\n");
  writeFileSync(join(seed.dir, "plan", "feedback", `${FEEDBACK_ID}.yaml`), [
    `id: ${FEEDBACK_ID}`, `ts: ${new Date().toISOString()}`,
    "raw: repair the filed scope without repeating the verdict",
    "origin: human", "attachments: []", "status: new", "",
  ].join("\n"));
  seed.git("add", "-A");
  seed.git("commit", "--quiet", "-m", "chore: seed triage repair");
  seed.addRemote("origin", origin.dir);
  seed.git("push", "--quiet", "origin", "main");
  const clone = gitRepo({ cloneFrom: origin.dir, scope: t });
  clone.git("config", "user.name", "fixture");
  clone.git("config", "user.email", "fixture@remudero.invalid");
  const repoDir = join(root, "repos", "remudero");
  mkdirSync(join(root, "repos"), { recursive: true });
  clone.git("worktree", "add", "--detach", repoDir, "main");

  const shim = ghShim([{ when: "pr list", stdout: "[]" }]);
  const savedPath = process.env.PATH;
  t.after(() => rmSync(shim.dir, { recursive: true, force: true }));
  const prompts: string[] = [];
  const transcripts: string[] = [];
  const findings: ReturnType<typeof lintFiledTasks>[] = [];
  let thrown: unknown;
  try {
    process.env.PATH = `${shim.dir}:${savedPath ?? ""}`;
    await triageCommand([FEEDBACK_ID], {
      config: { root, installRoot: REPO_ROOT, claudeBin: "/usr/bin/true" },
      spawn: async (args) => {
        const round = rounds[prompts.length];
        assert.ok(round, "the relint loop must respect the expected attempt bound");
        prompts.push(args.prompt);
        const id = /USE EXACTLY `(W\d+-T\d+)`/.exec(args.prompt)?.[1];
        assert.ok(id, "every repair retains the originally reserved task id");
        mkdirSync(join(args.cwd, "plan", "tasks.d"), { recursive: true });
        writeFileSync(join(args.cwd, "plan", "tasks.d", `${id}-repair.yaml`),
          taskYaml(id, round.status, round.proof));
        if (round.replaceFiled) {
          rmSync(join(args.cwd, "plan", "tasks.d", `${id}-repair.yaml`));
          writeFileSync(join(args.cwd, "plan", "tasks.d", `${id}-replacement.yaml`),
            taskYaml(id, round.status, round.proof));
        }
        if (round.extraFile) writeFileSync(join(args.cwd, round.extraFile), "unexpected scope\n");
        findings.push(lintFiledTasks(args.cwd, [id]));
        const text = round.text ?? (prompts.length === 1 ? `PROPOSED: file ${id}` : "The YAML is repaired.");
        transcripts.push(text);
        return worker(text);
      },
    });
  } catch (error) {
    thrown = error;
  } finally {
    if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath;
  }
  const ledger = readFileSync(join(root, "state", "ledger.ndjson"), "utf8")
    .trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
  assert.equal(prompts.length, rounds.length, `unexpected lane exit: ${String(thrown)}`);
  return { prompts, transcripts, findings, ledger, thrown };
}

function assertProposed(result: Awaited<ReturnType<typeof runRepair>>) {
  assert.equal(result.ledger.filter(row => row.step === "triage.id_minted").length, 1,
    "the production lane reaches its propose-only branch after the repair");
  assert.deepEqual(result.ledger.filter(row => row.step === "triage.relint_refused"), []);
  assert.match(String(result.thrown), /live-write-guard: REFUSED git-push/,
    "a clean proposal reaches the existing push boundary under test containment");
}

test("a repaired attempt with no fresh verdict line still proposes", async t => {
  const result = await runRepair(t, [{ status: "open" }, { status: "queued" }]);
  assert.equal(result.prompts.length, 2);
  assert.equal(parseTriageVerdict(result.transcripts[1]), null);
  assert.equal(result.findings[0][0].check, "plan-load");
  assert.match(result.findings[0][0].message, /invalid status 'open'/);
  assert.deepEqual(result.findings[1], []);
  assert.match(result.prompts[1], /\[plan-load\]/);
  assertProposed(result);
});

test("a repaired attempt's files are relinted, not skipped as not-filed", async t => {
  const result = await runRepair(t, [
    { status: "open" },
    { status: "queued", proof: "the console should work" },
    { status: "queued" },
  ]);
  assert.equal(result.prompts.length, 3, "the verdictless second round is still linted");
  assert.equal(parseTriageVerdict(result.transcripts[1]), null);
  assert.match(result.prompts[2], /\[proof-dialect\]/,
    "the next prompt carries the real finding from the repaired second attempt");
  assert.deepEqual(result.ledger.filter(row => row.step === "triage.relint").map(row => row.attempt), [1, 2]);
  assertProposed(result);
});

test("a verdictless repair cannot retain a proposal after expanding its file scope", async t => {
  const result = await runRepair(t, [
    { status: "open" }, { status: "queued", extraFile: "MASTER-PLAN.md" },
  ]);
  assert.equal(result.prompts.length, 2);
  assert.equal(result.ledger.filter(row => row.step === "triage.id_minted").length, 0);
  assert.match(String(result.ledger.find(row => row.step === "triage.error")?.error), /no .*verdict line found/);
});

test("a verdictless repair cannot replace the proposed file with another file", async t => {
  const result = await runRepair(t, [
    { status: "open" }, { status: "queued", replaceFiled: true },
  ]);
  assert.deepEqual(result.findings[1], [], "the replacement is valid but changes the proposed file set");
  assert.equal(result.ledger.filter(row => row.step === "triage.id_minted").length, 0);
  assert.match(String(result.ledger.find(row => row.step === "triage.error")?.error), /no .*verdict line found/);
});

test("a verdictless repair with invalid schema is refused when relint attempts run out", async t => {
  const result = await runRepair(t, [
    { status: "open" }, { status: "open" }, { status: "open" },
  ]);
  assert.equal(parseTriageVerdict(result.transcripts[1]), null);
  assert.equal(parseTriageVerdict(result.transcripts[2]), null);
  const refused = result.ledger.filter(row => row.step === "triage.relint_refused");
  assert.equal(refused.length, 1);
  assert.equal(refused[0].stop, "exhausted");
  assert.equal(refused[0].attempts, 3);
  assert.deepEqual(refused[0].checks, ["plan-load"]);
  assert.equal(result.ledger.filter(row => row.step === "triage.id_minted").length, 0);
  assert.equal(result.ledger.filter(row => row.step === "pr.opened").length, 0);
});

test("a fresh conflicting verdict is not replaced by the preceding proposal", async t => {
  const result = await runRepair(t, [
    { status: "open" }, { status: "queued", text: "ALREADY_DECIDED: Rule 7" },
  ]);
  assert.equal(result.ledger.filter(row => row.step === "triage.id_minted").length, 0);
  assert.match(String(result.ledger.find(row => row.step === "triage.error")?.error), /ALREADY_DECIDED but files were changed/);
});

test("an initial verdictless filing still fails without a preceding proposal", async t => {
  const result = await runRepair(t, [{ status: "queued", text: "The YAML is repaired." }]);
  assert.equal(result.ledger.filter(row => row.step === "triage.id_minted").length, 0);
  assert.match(String(result.ledger.find(row => row.step === "triage.error")?.error), /no .*verdict line found/);
});
