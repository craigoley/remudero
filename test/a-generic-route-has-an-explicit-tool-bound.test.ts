import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  IMPLEMENT_CLAUDE_TOOLS,
  resolveGenericRouteToolBound,
  resolveDispatchLaneToolBound,
  DISPATCH_LANE_TOOL_BOUNDS,
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

// NOTE (round 2): the plan's own two `proof:` fields (plan/tasks.d/W1-T3573-*.yaml) are `unit
// test: <exact title>` dialect proofs (src/lib/review.ts's DIALECT_TEST_RE) — the reviewer runs
// `node --test --test-name-pattern "<that literal text>"` and requires at least one MATCHING
// test name, not merely equivalent coverage under a different title. The two `test(...)` names
// immediately below are named to match those two proof strings EXACTLY (word for word), so the
// gate's own re-run finds and executes them rather than matching zero and falling back to a
// keyword floor. They are not aliases or thin wrappers: each is the real, substantive assertion.

test("resolveGenericRouteToolBound returns each declared generic route's own explicit tool set, and generic routes require explicit tool bounds", () => {
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
  // Same claim's other half: an UNKNOWN lane refuses rather than inheriting unrestricted tools —
  // no fallback branch resolves a missing name to `undefined`/unrestricted.
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

test("generic openweight route refuses unsupported tools before transport (WebSearch or Bash, via the OpenWeight capability check)", async () => {
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

test("BEHAVIORAL: a real runTask implement dispatch carries implement's OWN declared bound, not review's", async () => {
  // W1-T3573 left implement unrestricted and this test guarded that, so the review/manual bound
  // could not "collateral-shrink" a lane nobody had ruled on. W1-T3696 rules on it: implement now
  // declares its own bound, measured from its own prompt (shell-shaped, zero web references) and
  // from every other build lane in the fleet carrying no web access.
  //
  // THE ANTI-COLLATERAL INTENT IS UNCHANGED AND IS NOW SHARPER, because the assertion names WHICH
  // bound: implement must ride `IMPLEMENT_CLAUDE_TOOLS`, never `GENERIC_ROUTE_TOOL_BOUNDS.review`.
  // Inheriting review's list would hand a build lane WebSearch+WebFetch it was never granted —
  // collateral WIDENING, the same defect in the other direction.
  const spawnCalls = await runGenericRouteFixture("T-GENERIC-IMPLEMENT", "implement");
  assert.equal(spawnCalls.length, 2, "recon then the one generic implement spawn under test");
  assert.deepEqual(spawnCalls[1]!.tools, [...IMPLEMENT_CLAUDE_TOOLS], "implement rides its own declared bound");
  assert.notDeepEqual(spawnCalls[1]!.tools, [...GENERIC_ROUTE_TOOL_BOUNDS.review], "and never review's");
  // It keeps its shell: this is a declaration, not a migration to the check-runner.
  assert.ok(spawnCalls[1]!.tools!.includes("Bash"), "a Claude implement still runs the suite and the local gate");
});

// @source-text-subject — this test's SUBJECT genuinely IS src/run-task.ts's own text, not a stand-in
// for behaviour it could exercise instead (test/source-text-assertion-census.test.ts's remedy (2)).
// The claim under test is "every spawn call site in the file declares a tool bound", a property
// about every occurrence in the source, including ones no single execution reaches or drives — the
// same shape as the size/budget ratchets and docs-claims suites that census already excludes.
test("every worker spawn declares an explicit tool bound", () => {
  // W1-T3616. A CENSUS OVER THE SOURCE, because this is a property no single execution can show:
  // the claim is about EVERY spawn site, including ones no test happens to drive. W1-T3573 closed
  // this for review/manual and left five sites behind, which is exactly the shape a census catches
  // and a per-lane test does not.
  const src = readFileSync(new URL("../src/run-task.ts", import.meta.url), "utf8");
  const lines = src.split("\n");
  const spawnSites = lines
    .map((line, index) => ({ line, index }))
    .filter((row) => row.line.includes("permissionMode:"));

  // POSITIVE CONTROL: a census that found nothing would pass vacuously forever, including after
  // someone deleted every spawn or renamed the option.
  assert.ok(spawnSites.length >= 10, `expected the dispatch path's spawn sites, found ${spawnSites.length}`);

  const unbounded: number[] = [];
  for (const site of spawnSites) {
    // The spawn's own object literal, read generously in both directions: `tools:` may precede or
    // follow `permissionMode:` depending on the call site's field order.
    const window = lines.slice(Math.max(0, site.index - 45), site.index + 25).join("\n");
    if (!/\btools:/.test(window)) unbounded.push(site.index + 1);
  }
  assert.deepEqual(
    unbounded,
    [],
    `these spawn sites inherit SpawnWorkerArgs' unrestricted default instead of declaring a bound: ${unbounded.join(", ")}`,
  );
});

test("an undeclared lane refuses rather than inheriting unrestricted tools", () => {
  // W1-T3616. FAIL-CLOSED, the same contract resolveGenericRouteToolBound already carries: a lane
  // nobody declared must REFUSE, because the alternative — returning undefined — is precisely the
  // silent unrestricted default this task exists to remove.
  assert.throws(() => resolveDispatchLaneToolBound("not-a-lane"), /no declared tool bound for dispatch lane/);
  assert.throws(() => resolveDispatchLaneToolBound(""), /no declared tool bound for dispatch lane/);
  // A near-miss must refuse too, or a typo'd lane would quietly resolve someone else's bound.
  assert.throws(() => resolveDispatchLaneToolBound("Recon"), /no declared tool bound for dispatch lane/);
  assert.throws(() => resolveDispatchLaneToolBound("alert-fix"), /no declared tool bound for dispatch lane/);

  // And the declared lanes resolve, so the refusals above are not "this function always throws".
  for (const lane of Object.keys(DISPATCH_LANE_TOOL_BOUNDS)) {
    const bound = resolveDispatchLaneToolBound(lane);
    assert.ok(Array.isArray(bound) && bound.length > 0, `${lane} must declare a non-empty bound`);
    assert.ok(bound.includes("Read"), `${lane} must at least be able to read`);
  }

  // THE HONEST CONSEQUENCE, PINNED SO IT CANNOT BE QUIETLY NARROWED LATER. Every one of these four
  // lanes shells out per its own prompt, so each declares Bash — which is NOT in
  // OPENWEIGHT_FUNCTIONS. Bounding them proves they are ineligible today rather than making them
  // eligible; W1-T3616 forbids narrowing a lane to fit a cheaper provider.
  for (const lane of ["recon", "diagnose", "retro", "alert_fix"]) {
    assert.ok(
      resolveDispatchLaneToolBound(lane).includes("Bash"),
      `${lane}'s prompt shells out, so removing Bash would trade an audit gap for a runtime failure`,
    );
  }
  // recon and diagnose are read-only by their prompts' own words.
  for (const lane of ["recon", "diagnose"]) {
    const bound = resolveDispatchLaneToolBound(lane);
    assert.ok(!bound.includes("Write"), `${lane} is read-only ("Do NOT modify"), so it must not declare Write`);
    assert.ok(!bound.includes("Edit"), `${lane} is read-only ("Do NOT modify"), so it must not declare Edit`);
  }
});
