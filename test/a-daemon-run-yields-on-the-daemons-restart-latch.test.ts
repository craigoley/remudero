import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { DaemonFreshness } from "../src/lib/daemon.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import type { WorkerResult } from "../src/lib/worker.js";
import { ciWaitFreshness, runTask } from "../src/run-task.js";
import { gitRepo } from "./helpers/git-repo.js";
import { ghShim } from "./helpers/gh-shim.js";

const PR = "https://github.com/acme/remudero/pull/1";
const HEAD = "c".repeat(40);
type Stale = Extract<DaemonFreshness, { stale: true }>;
const OWN: Stale = { stale: true, oldSha: "a".repeat(40), newSha: "b".repeat(40),
  changes: [{ sha: "b".repeat(40), subject: "fix: refresh daemon", files: ["src/lib/daemon.ts"] }] };
const LATCH: Stale = { ...OWN, oldSha: "d".repeat(40), newSha: "e".repeat(40) };
const RECYCLE = "PAUSE requested: container recycle (deploy/recycle-container.sh)";

function worker(text: string, isError = false): WorkerResult {
  return { sessionId: "fixture", costUsd: 0, numTurns: 0, text, blocks: [], stderr: "",
    subtype: isError ? "error_max_turns" : "success", isError, apiError: false, permissionDenials: [],
    childEnvKeys: [], model: "test", effort: "test", tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {}, compactionEvents: [], qualitySuspect: false };
}

async function fixture(t: TestContext, options: {
  ci?: boolean;
  latch?: () => Stale | undefined;
  atGate?: () => void;
  recycle?: () => string | undefined;
}) {
  const root = mkdtempSync(join(tmpdir(), "rmd-t8198-"));
  const origin = gitRepo({ bare: true });
  const seed = gitRepo();
  seed.addRemote("origin", origin.dir);
  seed.git("push", "origin", "main");
  const repo = gitRepo({ cloneFrom: origin.dir });
  repo.git("config", "user.name", "fixture");
  repo.git("config", "user.email", "fixture@remudero.invalid");
  mkdirSync(join(root, "repos"));
  renameSync(repo.dir, join(root, "repos", "remudero"));
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, "- id: D\n  title: restart latch fixture\n  repo: remudero\n  type: implement\n  verify: auto\n  risk: medium\n  origin: test\n  status: queued\n  files: [src/D.ts]\n");
  const now = Date.now();
  t.mock.method(Date, "now", () => now);
  const branch = `run-D-${now}`;
  const gh = ghShim([
    { when: "pr view", stdout: JSON.stringify({ headRefName: branch, body: "Remudero-Task: D" }) },
    { when: "/pulls/1", stdout: JSON.stringify({ number: 1, state: "open", merged: false, merged_at: null, head: { sha: HEAD } }) },
    { when: "/check-runs", stdout: JSON.stringify({ check_runs: [{ name: "ci", status: "queued" }] }) },
    { when: "/status", stdout: JSON.stringify({ statuses: [] }) },
  ]);
  const priorPath = process.env.PATH;
  process.env.PATH = `${gh.dir}:${priorPath}`;
  t.after(() => {
    process.env.PATH = priorPath;
    rmSync(gh.dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
    origin.cleanup();
    seed.cleanup();
  });
  let calls = 0;
  let gates = 0;
  let ownReads = 0;
  const ownRead = ciWaitFreshness(() => { ownReads++; return OWN; });
  assert.equal(ownRead(), OWN, "the positive control is an advance that independently triggers a restart");
  ownReads = 0;
  const outcome = await withLiveWritesAllowed(() => runTask("D", {
    config: { claudeBin: "/bin/true", root, installRoot: process.cwd(), workerProviders: { harnessCommitsImplement: true } },
    skipGitSync: true, planPath,
    github: { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined },
    claimReserver: { mintAnchor: () => "latch-anchor", attempt: () => "created", holder: () => undefined, drop: () => true },
    containmentExec: async (token) => ({ transcript: `touch ../${token}: Operation not permitted`, outsideWriteCreated: false, insideWriteCreated: true, costUsd: 0 }),
    isolationExec: async () => ({ transcript: "REPORT\naliases: 0\nfunctions: 0\nalias_names: -\nfunction_names: -", aliasCount: 0, functionCount: 0, functionNames: "-", costUsd: 0 }),
    restartAtWorkerBoundary: options.latch,
    externalWaitFreshness: ownRead,
    externalWaitRecycle: options.recycle,
    readHeadShaForProvenance: () => HEAD,
    spawn: async (args) => {
      if (++calls === 1) return worker("RECON REPORT\nOBSERVED: fixture\n");
      if (options.ci) return worker(`REPORT\nPR_URL: ${PR}\n`);
      if (calls > 2) return worker("fixture stops after reaching the preopen gate", true);
      mkdirSync(join(args.cwd, "src"), { recursive: true });
      writeFileSync(join(args.cwd, "src/D.ts"), "export const value = 42;\n");
      return worker("REPORT\nCOMMIT_MESSAGE: fix(test): retain boundary work\n");
    },
    preopenGate: async () => {
      gates++;
      options.atGate?.();
      return { kind: "fail", failedSteps: ["fixture"], durationMs: 1 };
    },
  }));
  const rows = readFileSync(join(root, "state", "ledger.ndjson"), "utf8").trim().split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  return { outcome, rows, calls, gates, ownReads };
}

test("W1-T8198: a stale own read with no latch does not yield at a boundary", async (t) => {
  const h = await fixture(t, { latch: () => undefined });
  assert.equal(h.gates, 1, "the clear daemon latch lets the completed worker reach the gate");
  assert.equal(h.calls, 3, "the run continues to the gate repair worker");
  assert.equal(h.outcome.verdict, "failed", "the injected repair worker stops the fixture");
  assert.equal(h.rows.some(({ step }) => step === "run.freshness_handoff"), false);
  assert.equal(h.ownReads, 0);
});

test("W1-T8198: a set latch yields at the next boundary", async (t) => {
  let latched = false;
  const h = await fixture(t, { latch: () => latched ? LATCH : undefined, atGate: () => { latched = true; } });
  assert.equal(h.gates, 1, "the first boundary sees a clear latch");
  assert.equal(h.calls, 2, "the next boundary yields before the gate repair worker");
  assert.equal(h.outcome.verdict, "handed_off");
  assert.equal(h.outcome.prUrl, undefined);
  const handoff = h.rows.find(({ step }) => step === "run.freshness_handoff");
  assert.equal(handoff?.waiting_on, "preopen_gate");
  assert.equal(handoff?.old_sha, LATCH.oldSha);
  assert.equal(handoff?.new_sha, LATCH.newSha);
  assert.equal(h.rows.find(({ step }) => step === "verdict")?.reason, "freshness_yield");
  assert.equal(h.ownReads, 0);
});

test("W1-T8198: the CI-wait handoff follows the latch", async (t) => {
  await t.test("clear latch preserves the recycle PAUSE handoff", async (t) => {
    const h = await fixture(t, { ci: true, latch: () => undefined, recycle: () => RECYCLE });
    assert.equal(h.outcome.verdict, "handed_off");
    assert.equal(h.outcome.prUrl, PR);
    const handoff = h.rows.find(({ step }) => step === "run.freshness_handoff");
    assert.equal(handoff?.trigger, "recycle");
    assert.equal(handoff?.detail, RECYCLE);
    assert.equal(handoff?.head_sha, HEAD);
    assert.equal(h.rows.find(({ step }) => step === "verdict")?.reason, "recycle_yield");
    assert.equal(h.ownReads, 0);
  });
  await t.test("set latch carries the daemon revisions", async (t) => {
    const h = await fixture(t, { ci: true, latch: () => LATCH });
    assert.equal(h.outcome.verdict, "handed_off");
    assert.equal(h.outcome.prUrl, PR);
    const awaiting = h.rows.findIndex(({ step }) => step === "run.awaiting_external");
    const handoff = h.rows.findIndex(({ step }) => step === "run.freshness_handoff");
    assert.ok(awaiting >= 0 && handoff > awaiting);
    assert.equal(h.rows[handoff].old_sha, LATCH.oldSha);
    assert.equal(h.rows[handoff].new_sha, LATCH.newSha);
    assert.equal(h.rows[handoff].head_sha, HEAD);
    assert.equal(h.rows.find(({ step }) => step === "verdict")?.reason, "freshness_yield");
    assert.equal(h.ownReads, 0);
  });
});

test("W1-T8198: a run with no daemon keeps its own judgement", async (t) => {
  for (const ci of [false, true]) {
    await t.test(ci ? "CI wait" : "worker boundary", async (t) => {
      const h = await fixture(t, { ci });
      assert.equal(h.outcome.verdict, "handed_off");
      assert.equal(h.ownReads, 1);
      assert.equal(h.gates, 0);
      const handoff = h.rows.find(({ step }) => step === "run.freshness_handoff");
      assert.equal(handoff?.old_sha, OWN.oldSha);
      assert.equal(handoff?.new_sha, OWN.newSha);
    });
  }
});

test("W1-T8198: a clear latch still yields a worker boundary to recycle PAUSE", async (t) => {
  const h = await fixture(t, { latch: () => undefined, recycle: () => RECYCLE });
  assert.equal(h.outcome.verdict, "handed_off");
  assert.equal(h.gates, 0);
  assert.equal(h.rows.find(({ step }) => step === "verdict")?.reason, "freshness_yield");
  assert.equal(h.rows.find(({ step }) => step === "run.freshness_handoff")?.trigger, "recycle");
  assert.equal(h.rows.find(({ step }) => step === "run.freshness_handoff")?.detail, RECYCLE);
  assert.equal(h.ownReads, 0);
});
