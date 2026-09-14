import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Config } from "../src/lib/config.js";
import type { ProbeExecResult } from "../src/lib/containment.js";
import type { ProbeExecResult as IsolationProbeExecResult } from "../src/lib/isolation.js";
import type { GitHub } from "../src/lib/status.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import {
  GENERIC_ROUTE_TOOL_BOUNDS,
  resolveGenericRouteToolBound,
  type SpawnWorkerArgs,
  type WorkerResult,
  type spawnWorker,
} from "../src/lib/worker.js";
import { spawnOpenWeightWorker } from "../src/lib/worker-provider.js";
import { runTask } from "../src/run-task.js";
import { gitRepo } from "./helpers/git-repo.js";

// ── W1-T3573: routes.review and routes.manual (`.remudero/mounts.yaml`) dispatch through the
// SAME generic implement spawn as routes.implement — before this task, that spawn passed no
// `tools`/`disallowedTools` at all, so a review or manual task inherited SpawnWorkerArgs'
// documented UNRESTRICTED default with no declared boundary. These tests prove: (1) the two
// named lanes resolve an explicit, testable bound and an undeclared lane REFUSES rather than
// falling back to unrestricted; (2) the REAL production spawn (run-task.ts's runTask) actually
// wires that bound in for review/manual while leaving implement's own spawn untouched; and (3)
// a route declaring the Bash/WebSearch this bound legitimately needs cannot reach OpenWeight
// transport as if its capability set were complete — the existing OPENWEIGHT_FUNCTIONS map
// (worker-provider.ts) refuses BEFORE any network call. ─────────────────────────────────────

test("resolveGenericRouteToolBound returns each declared generic route's own explicit tool set", () => {
  assert.deepEqual(resolveGenericRouteToolBound("review"), GENERIC_ROUTE_TOOL_BOUNDS.review);
  assert.deepEqual(resolveGenericRouteToolBound("manual"), GENERIC_ROUTE_TOOL_BOUNDS.manual);
  // The declared set is the standard coding toolkit (git/gh via Bash, research via
  // WebSearch/WebFetch) MINUS the three unattended-unsafe SDK built-ins — never the SDK's
  // full surface re-typed under a new name.
  for (const lane of ["review", "manual"] as const) {
    const bound = resolveGenericRouteToolBound(lane);
    for (const unsafe of ["AskUserQuestion", "Agent", "Monitor"]) {
      assert.equal(bound.includes(unsafe), false, `${lane} must not declare the unattended-unsafe tool ${unsafe}`);
    }
  }
});

test("resolveGenericRouteToolBound REFUSES an unknown lane rather than defaulting to unrestricted tools", () => {
  assert.throws(() => resolveGenericRouteToolBound("bogus-lane"), /no declared tool bound for generic route 'bogus-lane'/);
  // Falsifier (task record): restoring an OMITTED default must not pass — an unknown name never
  // resolves to `undefined`/unrestricted, it throws every time.
  assert.throws(() => resolveGenericRouteToolBound(""));
  // `implement`/`diagnose`/`recon` are NOT generic routes this table declares (they keep their
  // own dedicated mount/spawn path, untouched by this task) — the resolver must not silently
  // widen to cover them either.
  for (const other of ["implement", "diagnose", "recon"]) {
    assert.throws(() => resolveGenericRouteToolBound(other), /no declared tool bound for generic route/);
  }
});

test("a generic openweight route requiring WebSearch or Bash is rejected by the OpenWeight capability check BEFORE transport", async () => {
  let fetches = 0;
  const result = await spawnOpenWeightWorker(
    {
      cwd: process.cwd(),
      workerHome: join(tmpdir(), "rmd-generic-route-openweight-test"),
      prompt: "review this change",
      // The REAL declared review bound — includes Bash and WebSearch, which
      // OPENWEIGHT_FUNCTIONS (worker-provider.ts) does not implement.
      tools: [...resolveGenericRouteToolBound("review")],
      maxTurns: 2,
      env: { RMD_OPENWEIGHT_API_KEY: "test-only-daemon-secret" },
      fetchImpl: async () => {
        fetches += 1;
        throw new Error("a generic route declaring Bash/WebSearch must refuse before any Azure request");
      },
    },
    { claudeBin: "/unused/claude", root: tmpdir(), dailyCapUsd: 1, workerProviders: { enabled: ["openweight"], openweightEndpoint: "https://example.test/" } },
    { model: "gpt-oss-120b", effort: "low" },
  );
  assert.equal(result.isError, true);
  assert.match(result.stderr, /does not implement declared tool\(s\):.*Bash/);
  assert.match(result.stderr, /does not implement declared tool\(s\):.*WebSearch/);
  assert.equal(fetches, 0, "the capability check refuses before any transport call");
});

// ── Behavioral: drive the REAL runTask() dispatch (no real Claude/gh spawn — the injected
// `spawn` stands in, exactly like test/run-task.test.ts's own W1-T105 harness) and read the
// `tools` field the production spawn actually built. ─────────────────────────────────────

function genericRouteFixturePlan(taskId: string, type: string): string {
  return [
    `- id: ${taskId}`,
    `  title: generic route tool bound probe (${type})`,
    "  repo: remudero",
    `  type: ${type}`,
    "  verify: auto",
    "  risk: medium",
    "  files: [src/lib/daemon.ts]",
    "  origin: architect",
    "  status: queued",
    "",
  ].join("\n");
}

const GENERIC_ROUTE_OFFLINE_GITHUB: GitHub = {
  prByRef: () => null,
  findMergedByTrailer: () => null,
  headRefName: () => undefined,
  prBody: () => undefined,
};

const GENERIC_ROUTE_HOLDING_CONTAINMENT_EXEC = (token: string): Promise<ProbeExecResult> =>
  Promise.resolve({
    transcript: `touch ../${token}.txt: Operation not permitted`,
    outsideWriteCreated: false,
    insideWriteCreated: true,
    costUsd: 0,
  });

const GENERIC_ROUTE_CLEAN_ISOLATION_EXEC = (): Promise<IsolationProbeExecResult> =>
  Promise.resolve({
    transcript: "REPORT\naliases: 0\nfunctions: 0\nalias_names: -\nfunction_names: -",
    aliasCount: 0,
    functionCount: 0,
    functionNames: "-",
    costUsd: 0,
  });

function genericRouteGitFixture(root: string): void {
  // W1-T3573 census note: built on the shared `gitRepo()` fixture (test/helpers/git-repo.ts,
  // W1-T2903) rather than a hand-rolled `git init`, so this new test file adds no fresh raw
  // `git init` call site for test/fixture-copy-census.test.ts's `gitInitFiles` signature to count.
  const origin = gitRepo({ bare: true, kind: "runtask-generic-route-origin" });
  const seed = gitRepo({ cloneFrom: origin.dir, kind: "runtask-generic-route-seed" });
  writeFileSync(join(seed.dir, "README.md"), "seed\n");
  seed.git("add", "-A");
  seed.git("commit", "-q", "-m", "seed");
  seed.git("push", "-q", "origin", "main");

  const repoDir = join(root, "repos", "remudero");
  mkdirSync(join(root, "repos"), { recursive: true });
  execFileSync("git", ["clone", "-q", origin.dir, repoDir]);
  execFileSync("git", ["-C", repoDir, "config", "user.email", "generic-route-test@example.invalid"]);
  execFileSync("git", ["-C", repoDir, "config", "user.name", "generic-route-test"]);
}

function workerResult(over: Partial<WorkerResult>): WorkerResult {
  return {
    sessionId: "s",
    costUsd: 0,
    numTurns: 0,
    text: "",
    blocks: [],
    stderr: "",
    subtype: "success",
    isError: false,
    apiError: false,
    permissionDenials: [],
    childEnvKeys: [],
    model: "default",
    effort: "default",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {},
    compactionEvents: [],
    qualitySuspect: false,
    ...over,
  };
}

async function runGenericRouteFixture(taskId: string, type: string): Promise<SpawnWorkerArgs[]> {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}runtask-generic-route-root-`));
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, genericRouteFixturePlan(taskId, type));
  const config: Config = { claudeBin: "/bin/true", root };
  genericRouteGitFixture(root);

  const spawnCalls: SpawnWorkerArgs[] = [];
  const spawn: typeof spawnWorker = async (args) => {
    spawnCalls.push(args);
    if (spawnCalls.length === 1) {
      // Recon — every dispatch runs it first, regardless of the task's own type.
      return workerResult({
        sessionId: "s-recon",
        text: "RECON REPORT\nOBSERVED: nothing\nINFERRED: nothing\nCOULDN'T-VERIFY: nothing\n",
      });
    }
    // The generic implement-style spawn under test — fail deterministically (no PR opened)
    // so the run reaches a terminal verdict with no further spawn.
    return workerResult({ sessionId: "s-worker", text: "REPORT\nno PR opened yet\n" });
  };

  try {
    await withLiveWritesAllowed(() =>
      runTask(taskId, {
        skipGitSync: true,
        planPath,
        config,
        github: GENERIC_ROUTE_OFFLINE_GITHUB,
        spawn,
        containmentExec: GENERIC_ROUTE_HOLDING_CONTAINMENT_EXEC,
        isolationExec: GENERIC_ROUTE_CLEAN_ISOLATION_EXEC,
      }),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  return spawnCalls;
}

test("BEHAVIORAL: a real runTask review dispatch's generic spawn carries the declared review tool bound", async () => {
  const spawnCalls = await runGenericRouteFixture("T-GENERIC-REVIEW", "review");
  assert.equal(spawnCalls.length, 2, "recon then the one generic implement-style spawn under test");
  assert.deepEqual(spawnCalls[1]!.tools, [...GENERIC_ROUTE_TOOL_BOUNDS.review]);
});

test("BEHAVIORAL: a real runTask manual dispatch's generic spawn carries the declared manual tool bound", async () => {
  const spawnCalls = await runGenericRouteFixture("T-GENERIC-MANUAL", "manual");
  assert.equal(spawnCalls.length, 2, "recon then the one generic implement-style spawn under test");
  assert.deepEqual(spawnCalls[1]!.tools, [...GENERIC_ROUTE_TOOL_BOUNDS.manual]);
});

test("BEHAVIORAL: a real runTask implement dispatch's generic spawn is untouched — no tools bound, same as before this task", async () => {
  const spawnCalls = await runGenericRouteFixture("T-GENERIC-IMPLEMENT", "implement");
  assert.equal(spawnCalls.length, 2, "recon then the one generic implement spawn under test");
  assert.equal(spawnCalls[1]!.tools, undefined, "implement keeps the unrestricted default — never collateral-shrunk by this task");
});
