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
  // W1-T9089: an image input, the one advance a busy run judges worth a restart once the self-path list is retired.
  changes: [{ sha: "b".repeat(40), subject: "fix(deploy): rebuild the image", files: ["deploy/Dockerfile"] }] };
const RECYCLE = "PAUSE requested: container recycle (deploy/recycle-container.sh)";

function worker(text: string, isError = false): WorkerResult {
  return { sessionId: "fixture", costUsd: 0, numTurns: 0, text, blocks: [], stderr: "",
    subtype: isError ? "error_max_turns" : "success", isError, apiError: false, permissionDenials: [],
    childEnvKeys: [], model: "test", effort: "test", tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {}, compactionEvents: [], qualitySuspect: false };
}

async function fixture(t: TestContext, options: {
  ci?: boolean;
  /** W1-T9089: false runs with no freshness read at all, as a run with nothing to judge advances by. */
  own?: boolean;
  recycle?: () => string | undefined;
  gateSuccess?: boolean;
  checkpoint?: boolean;
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
    { when: "pulls?", stdout: "[]" },
    { when: "api --method POST repos/", stdout: JSON.stringify({ html_url: PR, number: 1 }) },
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
  let repairPhase: unknown;
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
    externalWaitFreshness: options.own === false ? undefined : ownRead,
    externalWaitRecycle: options.recycle,
    handOffAtPrOpen: options.gateSuccess,
    readHeadShaForProvenance: () => HEAD,
    spawn: async (args) => {
      if (++calls === 1) return worker("RECON REPORT\nOBSERVED: fixture\n");
      if (options.ci) return worker(`REPORT\nPR_URL: ${PR}\n`);
      if (calls > 2) {
        const phases = readFileSync(join(root, "state", "ledger.ndjson"), "utf8").trim().split("\n")
          .map((line) => JSON.parse(line) as Record<string, unknown>);
        repairPhase = phases.findLast((row) => row.step === "run.phase")?.waiting_on;
        return worker("fixture stops after reaching the preopen gate", true);
      }
      mkdirSync(join(args.cwd, "src"), { recursive: true });
      writeFileSync(join(args.cwd, "src/D.ts"), "export const value = 42;\n");
      if (options.checkpoint) {
        seed.git("-C", args.cwd, "add", "src/D.ts");
        seed.git("-C", args.cwd, "commit", "--quiet", "-m",
          "chore(checkpoint): retain partial work\n\n[remudero-context]\nremaining: finish implementation");
      }
      return worker("REPORT\nCOMMIT_MESSAGE: fix(test): retain boundary work\n");
    },
    preopenGate: async () => {
      gates++;
      return options.gateSuccess ? { kind: "pass", durationMs: 1 }
        : { kind: "fail", failedSteps: ["fixture"], durationMs: 1 };
    },
  }));
  const rows = readFileSync(join(root, "state", "ledger.ndjson"), "utf8").trim().split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  return { outcome, rows, calls, gates, ownReads, repairPhase };
}

// W1-T9089: the daemon's restart latch is retired (no run reads it at a worker boundary any more); what stays is the
// run's own freshness judgement and the recycle PAUSE checkpoint, which a run child takes inside its own process.
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

test("W1-T8198: a worker boundary yields to recycle PAUSE", async (t) => {
  const h = await fixture(t, { own: false, recycle: () => RECYCLE });
  assert.equal(h.outcome.verdict, "handed_off");
  assert.equal(h.gates, 0);
  assert.equal(h.rows.find(({ step }) => step === "verdict")?.reason, "freshness_yield");
  assert.equal(h.rows.find(({ step }) => step === "run.freshness_handoff")?.trigger, "recycle");
  assert.equal(h.rows.find(({ step }) => step === "run.freshness_handoff")?.detail, RECYCLE);
  assert.equal(h.ownReads, 0);
});

test("W1-T8198: the CI-wait handoff still takes the recycle PAUSE", async (t) => {
  const h = await fixture(t, { ci: true, own: false, recycle: () => RECYCLE });
  assert.equal(h.outcome.verdict, "handed_off");
  assert.equal(h.outcome.prUrl, PR);
  const handoff = h.rows.find(({ step }) => step === "run.freshness_handoff");
  assert.equal(handoff?.trigger, "recycle");
  assert.equal(handoff?.detail, RECYCLE);
  assert.equal(handoff?.head_sha, HEAD);
  assert.equal(h.rows.find(({ step }) => step === "verdict")?.reason, "recycle_yield");
  assert.equal(h.ownReads, 0);
});

test("W1-T8927: a gate repair reports implementing before the worker resumes", async (t) => {
  const h = await fixture(t, { own: false });
  assert.equal(h.gates, 1);
  assert.equal(h.calls, 3);
  assert.equal(h.outcome.verdict, "failed");
  assert.equal(h.repairPhase, "implementing");
  assert.deepEqual(h.rows.filter((row) => row.step === "run.phase").map((row) => row.waiting_on),
    ["recon", "implementing", "implementing", "preopen_gate", "implementing", "implementing", "implementing"]);
  assert.equal(h.rows.some((row) => row.step === "run.freshness_handoff"), false);
});

test("W1-T8927: a checkpoint continuation reports implementing before the worker resumes", async (t) => {
  const h = await fixture(t, { own: false, checkpoint: true });
  assert.equal(h.calls, 3, "the checkpoint reaches its continuation worker");
  assert.equal(h.gates, 0);
  assert.equal(h.outcome.verdict, "failed");
  assert.equal(h.repairPhase, "implementing");
  assert.equal(h.rows.findLast((row) => row.step === "run.phase")?.waiting_on, "implementing");
  assert.equal(h.rows.some((row) => row.step === "run.freshness_handoff"), false);
});
