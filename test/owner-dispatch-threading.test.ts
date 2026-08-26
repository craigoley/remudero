import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { daemonCommand, runTask } from "../src/run-task.js";
import type { DaemonDeps, DaemonSummary } from "../src/lib/daemon.js";
import type { Config } from "../src/lib/config.js";
import type { ProbeExecResult } from "../src/lib/containment.js";
import type { ProbeExecResult as IsolationProbeExecResult } from "../src/lib/isolation.js";
import type { GitHub } from "../src/lib/status.js";
import type { SpawnWorkerArgs, WorkerResult, spawnWorker } from "../src/lib/worker.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";

/**
 * W1-T1062 ACCEPTANCE (2 of 2 claims proved by this file — the task record's own proof list
 * names this same path for both):
 *
 *   (a) "the resolved owner reaches the dispatch path, so a run clones and opens its pull
 *        request against the same owner the target named"
 *   (b) "a slice that resolves the owner at the daemon without threading it to the run is
 *        refused, so a partial fix cannot ship as an improvement"
 *
 * THE PARTIAL-FIX HAZARD, measured by the task record: `resolveDaemonTarget` resolving an
 * owner-qualified `--repo owner/name` correctly is NOT enough on its own — `daemonCommand`'s
 * `runOne` closure must ALSO thread `target.owner` into `runTask`'s new `owner` option, and
 * `runTask` must ACTUALLY consume it (never silently falling back to `resolveOwner()`, this
 * checkout's own owner). Any one of those three links missing reproduces the hazard: a clone
 * under one owner and a PR under another. This file proves BOTH ends of the chain:
 *   (1) STRUCTURALLY — `daemonCommand`'s `runOne` closure literally passes `owner: target.owner`
 *       to `runTask` (so a future edit that drops just that one field is caught here, not only
 *       by inspection).
 *   (2) BEHAVIORALLY — `runTask` given `opts.owner` actually clones against THAT owner, not the
 *       checkout's own (mirrors test/run-task.test.ts's own W1-T105 follow-up harness: a real
 *       local git origin, a PATH-stubbed `gh`, zero network, zero real Claude spawn).
 */

const runTaskSrc = readFileSync(fileURLToPath(new URL("../src/run-task.ts", import.meta.url)), "utf8");

function extractFunctionBody(src: string, signature: string): string {
  const start = src.indexOf(signature);
  assert.ok(start >= 0, `expected to find '${signature}' in run-task.ts`);
  const nextFn = src.indexOf("\nfunction ", start + 1);
  const nextAsyncFn = src.indexOf("\nasync function ", start + 1);
  const nextExportAsyncFn = src.indexOf("\nexport async function ", start + 1);
  const boundaries = [nextFn, nextAsyncFn, nextExportAsyncFn].filter((i) => i > start);
  const end = boundaries.length ? Math.min(...boundaries) : src.length;
  return src.slice(start, end);
}

test("STRUCTURAL: daemonCommand's runOne closure threads target.owner into runTask's opts — dropping just this line reproduces the partial-fix hazard", () => {
  const body = extractFunctionBody(runTaskSrc, "export async function daemonCommand(");
  const runOneIdx = body.indexOf("runOne: (taskId) =>");
  assert.ok(runOneIdx >= 0, "daemonCommand must still wire a runOne closure for DaemonDeps");
  const runOneBlock = body.slice(runOneIdx, body.indexOf("readUsage:", runOneIdx));
  assert.match(
    runOneBlock,
    /runTask\(taskId,\s*\{[^}]*owner:\s*target\.owner/s,
    "the runOne closure must pass owner: target.owner to runTask — without it the daemon's " +
      "resolved (possibly foreign) owner never reaches the dispatched run",
  );
});

/** Build a minimal WorkerResult (mirrors test/run-task.test.ts's own `result` helper). */
function result(over: Partial<WorkerResult>): WorkerResult {
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

const OWNER_THREADING_PLAN = [
  "- id: T-OWNER-THREAD",
  "  title: owner threading probe",
  "  repo: widgets",
  "  type: implement",
  "  verify: auto",
  "  risk: medium",
  "  files: [src/lib/daemon.ts]",
  "  origin: architect",
  "  status: queued",
  "",
].join("\n");

/** An offline GitHub gateway: projectPlan runs with zero network round-trips. */
const OWNER_THREADING_OFFLINE_GITHUB: GitHub = {
  prByRef: () => null,
  findMergedByTrailer: () => null,
  headRefName: () => undefined,
  prBody: () => undefined,
};

const holdingContainmentExec = (token: string): Promise<ProbeExecResult> =>
  Promise.resolve({
    transcript: `touch ../${token}.txt: Operation not permitted`,
    outsideWriteCreated: false,
    insideWriteCreated: true,
    costUsd: 0,
  });

const cleanIsolationExec = (): Promise<IsolationProbeExecResult> =>
  Promise.resolve({
    transcript: "REPORT\naliases: 0\nfunctions: 0\nalias_names: -\nfunction_names: -",
    aliasCount: 0,
    functionCount: 0,
    functionNames: "-",
    costUsd: 0,
  });

/** A real, throwaway bare "origin" — never cloned into config.root/repos ahead of time, so
 *  runTask's OWN `gh repo clone <owner>/<repo>` call is the thing that populates it. */
function ownerThreadingOriginFixture(): { originBare: string } {
  const originBare = mkdtempSync(join(tmpdir(), "owner-threading-origin-"));
  execFileSync("git", ["init", "-q", "--bare", "--initial-branch=main", originBare]);
  const seed = mkdtempSync(join(tmpdir(), "owner-threading-seed-"));
  execFileSync("git", ["clone", "-q", originBare, seed]);
  execFileSync("git", ["-C", seed, "config", "user.email", "owner-threading-test@example.invalid"]);
  execFileSync("git", ["-C", seed, "config", "user.name", "owner-threading-test"]);
  writeFileSync(join(seed, "README.md"), "seed\n");
  execFileSync("git", ["-C", seed, "add", "-A"]);
  execFileSync("git", ["-C", seed, "commit", "-q", "-m", "seed"]);
  execFileSync("git", ["-C", seed, "push", "-q", "origin", "main"]);
  return { originBare };
}

/** A fake `gh` on PATH that (a) answers `repo clone <arg> <dir>` for REAL against the local
 *  bare origin — logging the exact `<owner>/<repo>` argument it was given — and (b) answers
 *  the same handful of read-only subcommands test/run-task.test.ts's own `followupFakeGh`
 *  answers (`pr view --json headRefName/body/statusCheckRollup`, `pr edit`), red-CI on the
 *  first poll so the run reaches its terminal verdict with no review spawn and no sleep. */
function ownerThreadingFakeGh(branch: string, originBare: string, cloneLogPath: string): string {
  const fakeBinDir = mkdtempSync(join(tmpdir(), "owner-threading-bin-"));
  const fakeGhPath = join(fakeBinDir, "gh");
  writeFileSync(
    fakeGhPath,
    [
      "#!/bin/bash",
      "set -e",
      "if [[ \"$1\" == 'repo' && \"$2\" == 'clone' ]]; then",
      `  echo "$3" >> "${cloneLogPath}"`,
      `  git clone -q "${originBare}" "$4"`,
      "  exit 0",
      "fi",
      "if [[ \"$1\" == 'pr' && \"$2\" == 'view' ]]; then",
      `  if [[ "$5" == 'headRefName' ]]; then echo '{"headRefName":"${branch}"}'; exit 0; fi`,
      "  if [[ \"$5\" == 'body' ]]; then echo '{\"body\":\"\"}'; exit 0; fi",
      "  if [[ \"$5\" == 'statusCheckRollup' ]]; then echo '{\"statusCheckRollup\":[{\"name\":\"ci\",\"conclusion\":\"FAILURE\"}]}'; exit 0; fi",
      "fi",
      "if [[ \"$1\" == 'pr' && \"$2\" == 'edit' ]]; then exit 0; fi",
      // W1-T2268 moved both poll loops off `gh pr view --json state,statusCheckRollup` onto REST,
      // so the three argv shapes below are what production now asks for. Answering them keeps this
      // fixture's ORIGINAL contract intact -- red CI on the first poll, terminal verdict, no review
      // spawn -- rather than changing what the test asserts.
      "if [[ \"$1\" == 'api' ]]; then",
      "  case \"$2\" in",
      "    */check-runs*) echo '{\"check_runs\":[{\"name\":\"ci\",\"status\":\"completed\",\"conclusion\":\"failure\"}]}'; exit 0 ;;",
      "    */status) echo '{\"state\":\"failure\",\"statuses\":[]}'; exit 0 ;;",
      `    */pulls/*) echo '{"number":1,"state":"open","merged":false,"head":{"sha":"deadbee","ref":"${branch}"}}'; exit 0 ;;`,
      "  esac",
      "fi",
      "exit 1",
      "",
    ].join("\n"),
  );
  chmodSync(fakeGhPath, 0o755);
  return fakeBinDir;
}

test(
  "BEHAVIORAL: a real runTask() given opts.owner clones against THAT owner, not this checkout's own -- " +
    "the run-task options type + owner derivation half of the four-part dispatch-path fix",
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), "owner-threading-root-"));
    const planPath = join(root, "tasks.yaml");
    writeFileSync(planPath, OWNER_THREADING_PLAN);
    const config: Config = { claudeBin: "/bin/true", root };

    const { originBare } = ownerThreadingOriginFixture();
    const cloneLogPath = join(root, "clone.log");

    const FIXED_TS = 1786000000000;
    const branch = `run-T-OWNER-THREAD-${FIXED_TS}`;
    const fakeBinDir = ownerThreadingFakeGh(branch, originBare, cloneLogPath);
    const savedPath = process.env.PATH;
    process.env.PATH = `${fakeBinDir}:${savedPath}`;
    const dateNowSpy = t.mock.method(Date, "now", () => FIXED_TS);

    const spawnCalls: SpawnWorkerArgs[] = [];
    const spawn: typeof spawnWorker = async (args) => {
      spawnCalls.push(args);
      if (spawnCalls.length === 1) {
        return result({
          sessionId: "s-recon",
          text: "RECON REPORT\nOBSERVED: nothing notable\nINFERRED: nothing\nCOULDN'T-VERIFY: nothing\n",
        });
      }
      return result({
        sessionId: "s-implement",
        text: "REPORT\nPR_URL: https://github.com/foreign-owner/widgets/pull/1\n",
      });
    };

    try {
      const res = await withLiveWritesAllowed(() =>
        runTask("T-OWNER-THREAD", {
          skipGitSync: true,
          planPath,
          config,
          github: OWNER_THREADING_OFFLINE_GITHUB,
          spawn,
          containmentExec: holdingContainmentExec,
          isolationExec: cleanIsolationExec,
          owner: "foreign-owner",
        }),
      );

      // ci is answered RED on the first poll -- the run reaches blocked_ci right after the
      // implement harvest, with no review spawn (so no dependency on reviewBase's own owner use).
      assert.equal(res.verdict, "blocked_ci");
      assert.equal(spawnCalls.length, 2, "exactly recon then implement -- proves the run actually dispatched");

      const cloneArgs = readFileSync(cloneLogPath, "utf8").trim().split("\n");
      assert.deepEqual(
        cloneArgs,
        ["foreign-owner/widgets"],
        "runTask's `gh repo clone` must target opts.owner's repo, never this checkout's own owner",
      );
    } finally {
      dateNowSpy.mock.restore();
      process.env.PATH = savedPath;
      rmSync(root, { recursive: true, force: true });
      rmSync(originBare, { recursive: true, force: true });
    }
  },
);

test(
  "BEHAVIORAL: omitting opts.owner (every non-daemon caller) still clones against THIS checkout's " +
    "own resolveOwner() -- the new option changes nothing for a caller that never sets it",
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), "owner-threading-default-root-"));
    const planPath = join(root, "tasks.yaml");
    writeFileSync(planPath, OWNER_THREADING_PLAN);
    const config: Config = { claudeBin: "/bin/true", root };

    const { originBare } = ownerThreadingOriginFixture();
    const cloneLogPath = join(root, "clone.log");

    const FIXED_TS = 1786000000001;
    const branch = `run-T-OWNER-THREAD-${FIXED_TS}`;
    const fakeBinDir = ownerThreadingFakeGh(branch, originBare, cloneLogPath);
    const savedPath = process.env.PATH;
    process.env.PATH = `${fakeBinDir}:${savedPath}`;
    const dateNowSpy = t.mock.method(Date, "now", () => FIXED_TS);

    const spawnCalls: SpawnWorkerArgs[] = [];
    const spawn: typeof spawnWorker = async (args) => {
      spawnCalls.push(args);
      if (spawnCalls.length === 1) {
        return result({
          sessionId: "s-recon",
          text: "RECON REPORT\nOBSERVED: nothing notable\nINFERRED: nothing\nCOULDN'T-VERIFY: nothing\n",
        });
      }
      return result({
        sessionId: "s-implement",
        text: "REPORT\nPR_URL: https://github.com/acme/widgets/pull/1\n",
      });
    };

    try {
      const res = await withLiveWritesAllowed(() =>
        runTask("T-OWNER-THREAD", {
          skipGitSync: true,
          planPath,
          config,
          github: OWNER_THREADING_OFFLINE_GITHUB,
          spawn,
          containmentExec: holdingContainmentExec,
          isolationExec: cleanIsolationExec,
          // no `owner` -- the default caller shape (manual `rmd run-task`, `rmd drain`).
        }),
      );

      assert.equal(res.verdict, "blocked_ci");
      const cloneArgs = readFileSync(cloneLogPath, "utf8").trim().split("\n");
      assert.equal(cloneArgs.length, 1);
      assert.match(
        cloneArgs[0],
        /\/widgets$/,
        "still clones <this checkout's own owner>/widgets -- byte-identical to before opts.owner existed",
      );
      assert.doesNotMatch(cloneArgs[0], /^foreign-owner\//, "no owner override leaks in when none is given");
    } finally {
      dateNowSpy.mock.restore();
      process.env.PATH = savedPath;
      rmSync(root, { recursive: true, force: true });
      rmSync(originBare, { recursive: true, force: true });
    }
  },
);

// ── The THIRD leg: the wired closure is actually INVOKED ──
//
// The two tests above prove the line EXISTS (structural, a source grep) and that `runTask`
// CONSUMES `opts.owner` (behavioral, calling `runTask` directly with it). NEITHER ever calls
// the closure `daemonCommand` actually wires, so `runOne`'s body — the
// `runTask(taskId, { ... owner: target.owner })` object literal itself — was executed by no
// suite at all, and `diff-coverage` blocked the added `owner: target.owner` line as having zero
// covering tests.
//
// This closes that leg from BOTH ends, in-process, with no network, no clone and no spawn:
//   (a) the DAEMON end — the `daemon.target` ledger line records the gateway the target
//       resolved to, so the FOREIGN owner the closure captures is pinned to disk. Point
//       `--repo` at this checkout's own owner instead and this assertion fails.
//   (b) the DISPATCH end — invoking `captured.runOne(...)` evaluates the opts literal (the
//       covered line) and delegates into `runTask`, which refuses from the target's OWN plan
//       and names the id it was handed. A closure that is unwired, uninvocable, or reading a
//       different plan fails this.
// The owner VALUE's journey through `runTask` is the sibling BEHAVIORAL test's job, above;
// this one exists because that test bypasses the closure entirely.
test(
  "INVOCATION: the daemon's wired runOne closure is actually callable and delegates into runTask " +
    "against the resolved target — the leg the structural and behavioral tests both step over",
  async () => {
    const home = mkdtempSync(join(tmpdir(), "owner-threading-daemon-home-"));
    const root = join(home, "Remudero");
    mkdirSync(join(home, ".config", "remudero"), { recursive: true });
    writeFileSync(
      join(home, ".config", "remudero", "config.json"),
      JSON.stringify({ claudeBin: "/bin/true", root }),
    );
    mkdirSync(join(root, "state"), { recursive: true });
    const planPath = join(home, "tasks.yaml");
    writeFileSync(planPath, OWNER_THREADING_PLAN);

    const savedHome = process.env.HOME;
    process.env.HOME = home;
    let captured: DaemonDeps | undefined;
    let refusal = "";
    let ledger = "";
    try {
      const code = await daemonCommand(
        ["--repo", "foreign-owner/widgets", "--plan", planPath, "--max", "0"],
        {
          runDaemon: async (_plan, deps): Promise<DaemonSummary> => {
            captured = deps;
            return { attempted: [], merged: [], stopReason: "stopped", costUsd: 0, ticks: 0 };
          },
        },
      );
      assert.equal(code, 0, "the injected runDaemon returns a clean 'stopped' summary -> exit 0");
      assert.ok(captured, "runDaemon was reached and its DaemonDeps captured");
      assert.equal(typeof captured.runOne, "function", "the daemon wires a runOne dispatch closure");

      // THE POINT: actually call it. Everything above is just acquiring the handle.
      await assert.rejects(
        () => captured!.runOne("T-NOT-IN-THIS-PLAN"),
        (e: Error) => {
          refusal = e.message;
          return true;
        },
        "the wired closure is invocable and its rejection comes from runTask, not from the closure",
      );
      ledger = readFileSync(join(root, "state", "ledger.ndjson"), "utf8");
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      rmSync(home, { recursive: true, force: true });
    }

    // (a) THE DAEMON END: the resolved target — the very `target.owner` the closure closes over —
    // is the FOREIGN owner, recorded on the daemon's own ledger line rather than inferred.
    const targetLine = ledger
      .split("\n")
      .find((l) => l.includes('"step":"daemon.target"'));
    assert.ok(targetLine, "the daemon ledgered its resolved target");
    assert.match(
      targetLine,
      /"gateway":"foreign-owner\/widgets"/,
      `the daemon resolved the owner-qualified target, not this checkout's own (line: ${targetLine})`,
    );

    // (b) THE DISPATCH END: control reached runTask's own plan lookup, carrying the id the
    // closure was handed, resolved against the TARGET's plan path.
    assert.match(
      refusal,
      /no task with id 'T-NOT-IN-THIS-PLAN' in plan/,
      `runOne delegated into runTask with the id it was given (got: ${refusal})`,
    );
  },
);
