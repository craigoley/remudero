import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { spawnDetachedGroup } from "#src/lib/worker-containment.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { laneDeliveryFailure } from "#src/lib/drain.js";
import { GhJsonUnreadableResponseError } from "#src/lib/github-transport.js";
import { defaultGeneration } from "#src/lib/host-memory-ledger.js";
import { isSpawnInfraBlockedError } from "#src/lib/ledger.js";
import { TaskAdmissionError } from "#src/lib/plan.js";
import {
  RUN_CHILD_SCHEMA,
  RUN_CHILD_FAILURE_TEXT_BOUND,
  censusRunDirs,
  childIdentity,
  classifyRunChildError,
  classifyRunDir,
  contractMismatchFailure,
  fromRunChildFailure,
  readSpec,
  readStatus,
  runDir,
  toRunChildFailure,
  writeSpec,
  writeStatus,
  type RunChildFailure,
  type RunChildProbe,
  type RunChildSpec,
  type RunChildStatus,
} from "#src/lib/run-child-contract.js";

const GENERATION = { containerId: "box-a", initStart: "proc:1" };

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "rmd-run-child-"));
}

function spec(runId = "W1-T9070-1"): RunChildSpec {
  return {
    schema: { ...RUN_CHILD_SCHEMA },
    taskId: "W1-T9070",
    runId,
    instance: "core",
    engine: { sourceHash: "abc123", sha: "deadbeef" },
    planSnapshotPath: "/state/plan.snapshot.json",
    reservationId: "res-1",
    options: { planPath: "plan", owner: "craigoley", allowStale: true, skipGitSync: false, handOffAtPrOpen: true, pairedTrialHost: "daemon" },
  };
}

function status(over: Partial<RunChildStatus> = {}): RunChildStatus {
  return {
    schema: { ...RUN_CHILD_SCHEMA },
    runId: "W1-T9070-1",
    identity: { pid: 4242, startTicks: "proc:100", containerGeneration: GENERATION },
    engineSha: "deadbeef",
    entryKind: "bundle",
    phase: "implementing",
    heartbeatAt: 1_700_000_000_000,
    state: "running",
    ...over,
  };
}

function probe(process: RunChildProbe["process"], generation = GENERATION): RunChildProbe {
  return { process, generation: () => generation };
}

test("W1-T9070: a spec and status round-trip through the run directory", () => {
  const state = tmp();
  try {
    const dir = runDir(state, "W1-T9070-1");
    const result = { taskId: "W1-T9070", runId: "W1-T9070-1", merged: true, costUsd: 1.5, verdict: "merged" as const, prUrl: "https://example.test/pr/1" };
    writeSpec(dir, spec());
    writeStatus(dir, status({ state: "done", result }));
    // Another PROCESS reads the same directory through the same module: nothing is shared but the files.
    const modulePath = resolve("src/lib/run-child-contract.ts");
    const script = `import(${JSON.stringify(modulePath)}).then((m) => { process.stdout.write(JSON.stringify({ spec: m.readSpec(${JSON.stringify(dir)}), status: m.readStatus(${JSON.stringify(dir)}) })); });`;
    const out = JSON.parse(execFileSync(process.execPath, ["--import", "tsx", "-e", script], { encoding: "utf8" })) as {
      spec: unknown; status: unknown;
    };
    assert.deepEqual(out.spec, { ok: true, value: spec() });
    assert.deepEqual(out.status, { ok: true, value: status({ state: "done", result }) });
    assert.deepEqual(readSpec(dir), { ok: true, value: spec() });
    assert.deepEqual(readStatus(dir), { ok: true, value: status({ state: "done", result }) });
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});

test("W1-T9070: a run id that could leave the runs directory is refused", () => {
  assert.throws(() => runDir("/state", "../escape"), RangeError);
  assert.throws(() => runDir("/state", "a/b"), RangeError);
  assert.equal(runDir("/state", "W1-T9070-1"), join("/state", "runs", "W1-T9070-1"));
});

test("W1-T9070: a reused pid is lost, never live", () => {
  const state = tmp();
  try {
    const dir = runDir(state, "W1-T9070-1");
    writeStatus(dir, status());
    const alive = (start: string) => probe(() => ({ state: "alive", start }));
    assert.equal(classifyRunDir(dir, alive("proc:100")).kind, "live");
    // The pid is alive — but it is another process, started at another time.
    const reused = classifyRunDir(dir, alive("proc:999"));
    assert.equal(reused.kind, "lost");
    assert.match(reused.detail ?? "", /reused/);
    assert.equal(classifyRunDir(dir, probe(() => ({ state: "gone" }))).kind, "lost");
    // Alive but unreadable is never live: the caller decides, and the reason rides.
    const unknown = classifyRunDir(dir, probe(() => ({ state: "unknown", reason: "no /proc" })));
    assert.equal(unknown.kind, "unreadable");
    assert.match(unknown.detail ?? "", /no \/proc/);
    // Another container generation: the pid means nothing here.
    assert.equal(classifyRunDir(dir, probe(() => ({ state: "alive", start: "proc:100" }), { containerId: "box-b", initStart: "proc:1" })).kind, "dead");
    assert.equal(classifyRunDir(dir, probe(() => ({ state: "alive", start: "proc:100" }), { containerId: "box-a", initStart: "proc:77" })).kind, "dead");
    // A terminal state is settled from the file, whatever the pid is doing.
    for (const state of ["done", "failed", "aborted"] as const) {
      writeStatus(dir, status({ state }));
      assert.equal(classifyRunDir(dir, alive("proc:999")).kind, "terminal");
    }
    writeStatus(dir, status({ identity: { pid: 4242, startTicks: "unknown", containerGeneration: GENERATION } }));
    assert.equal(classifyRunDir(dir, alive("unknown")).kind, "unreadable");
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});

test("W1-T9070: the real /proc probe identifies this process and refuses another start time", () => {
  const state = tmp();
  try {
    const dir = runDir(state, "W1-T9070-self");
    const identity = childIdentity(process.pid);
    assert.ok(identity, "this process is alive and its start time is readable");
    assert.deepEqual(identity.containerGeneration, defaultGeneration());
    writeStatus(dir, status({ runId: "W1-T9070-self", identity }));
    assert.equal(classifyRunDir(dir).kind, "live");
    writeStatus(dir, status({ runId: "W1-T9070-self", identity: { ...identity, startTicks: "proc:1" } }));
    assert.equal(classifyRunDir(dir).kind, "lost");
    assert.equal(childIdentity(2 ** 22 + 12345), undefined, "a pid that is not running has no identity");
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});

test("W1-T9070: a torn or missing file reads as unreadable, never as a state", () => {
  const state = tmp();
  try {
    const dir = runDir(state, "W1-T9070-1");
    assert.equal(classifyRunDir(dir).kind, "unreadable");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "status.json"), '{"schema":{"major":1,"minor":0},"runId":"W1-T9');
    const torn = classifyRunDir(dir);
    assert.equal(torn.kind, "unreadable");
    assert.match(torn.detail ?? "", /torn or unparseable/);
    writeFileSync(join(dir, "status.json"), "[1,2]");
    assert.equal(classifyRunDir(dir).kind, "unreadable");
    writeFileSync(join(dir, "status.json"), JSON.stringify({ ...status(), state: "exploded" }));
    assert.equal(classifyRunDir(dir).kind, "unreadable");
    writeFileSync(join(dir, "status.json"), JSON.stringify({ ...status(), result: { verdict: 3 } }));
    assert.equal(classifyRunDir(dir).kind, "unreadable");
    writeFileSync(join(dir, "status.json"), JSON.stringify({ ...status(), failure: { class: "unknown" } }));
    assert.equal(classifyRunDir(dir).kind, "unreadable");
    writeFileSync(join(dir, "spec.json"), JSON.stringify({ ...spec(), options: { allowStale: "yes" } }));
    assert.equal(readSpec(dir).ok, false);
    writeFileSync(join(dir, "spec.json"), JSON.stringify({ ...spec(), engine: { sha: "x" } }));
    assert.equal(readSpec(dir).ok, false);
    writeFileSync(join(dir, "spec.json"), "null");
    assert.equal(readSpec(dir).ok, false);
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});

function ghError(message: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(message), extra);
}

class PrOpenRefusedError extends Error {
  readonly refusalClass = "merge_base_proof";
  constructor(message: string) {
    super(message);
    this.name = "PrOpenRefusedError";
  }
}

/** One error per settle-loop class, built the way the daemon's predicates read it. */
const SETTLE_LOOP_ERRORS: Array<[string, Error, string]> = [
  ["task_admission", new TaskAdmissionError("W1-T1 is merged; no longer runnable"), "task_admission"],
  ["unreadable gh body", new GhJsonUnreadableResponseError("api", new SyntaxError("x")), "transient_gh_dispatch"],
  ["transient gh", ghError("gh pr view failed", { stderr: "HTTP 502 Bad Gateway", code: "1" }), "transient_gh_dispatch"],
  ["spawn infra", ghError("claude binary missing", { reasonClass: "blocked_toolchain" }), "spawn_infra_blocked"],
  ["gh lane read", ghError("gh api repos/o/r/commits/abc123/check-runs failed", { stderr: "boom", code: "1" }), "gh_lane_read"],
  ["pr open refused", new PrOpenRefusedError("PR open refused: merge base\nsecond line"), "lane_delivery"],
  ["command failed", ghError("Command failed: git push origin HEAD\nremote: hook declined", { stderr: "remote: hook declined" }), "lane_delivery"],
  ["abort", Object.assign(new Error("aborted"), { name: "AbortError" }), "aborted"],
];

test("W1-T9070: every settle-loop error class round-trips and an unknown one is lost", () => {
  const state = tmp();
  try {
    for (const [label, original, expected] of SETTLE_LOOP_ERRORS) {
      assert.equal(classifyRunChildError(original), expected, `${label}: classified at the source`);
      // Through the file, as a daemon that did not run the child would read it.
      const dir = runDir(state, `W1-T9070-${expected}-${label.replace(/\W+/g, "-")}`);
      writeStatus(dir, status({ state: "failed", failure: toRunChildFailure(original) }));
      const read = readStatus(dir);
      assert.ok(read.ok, label);
      assert.ok(read.value.failure, label);
      const settled = fromRunChildFailure(read.value.failure);
      assert.equal(settled.kind, "error", label);
      if (settled.kind !== "error") continue;
      const rebuilt = settled.error;
      assert.equal(classifyRunChildError(rebuilt), expected, `${label}: classified after the round trip`);
      assert.equal(rebuilt.message, original.message, label);
      assert.equal(rebuilt.name, original.name, label);
      assert.equal(rebuilt instanceof TaskAdmissionError, original instanceof TaskAdmissionError, label);
      assert.equal(rebuilt instanceof GhJsonUnreadableResponseError, original instanceof GhJsonUnreadableResponseError, label);
      assert.equal(isSpawnInfraBlockedError(rebuilt), isSpawnInfraBlockedError(original), label);
      assert.deepEqual(laneDeliveryFailure(rebuilt), laneDeliveryFailure(original), label);
      for (const field of ["stderr", "code", "refusalClass", "reasonClass"] as const) {
        assert.equal((rebuilt as unknown as Record<string, unknown>)[field], (original as unknown as Record<string, unknown>)[field], `${label}.${field}`);
      }
    }
    // A credential refusal is the fleet's failure, not the lane's: it stays unclassified, as the daemon keeps it fatal.
    const credential = ghError("Command failed: git push\nremote: Permission denied (publickey)");
    assert.equal(classifyRunChildError(credential), "unknown");
    // A non-Error value is still unknown/lost. Actual terminal Errors are represented
    // separately, without turning a credential refusal or programmer defect into lane delivery.
    for (const stray of ["a string", undefined]) {
      const failure = toRunChildFailure(stray);
      assert.equal(failure.class, "unknown");
      assert.equal(fromRunChildFailure(failure).kind, "lost");
    }
    // A class a newer minor invented reads as unknown, so it too settles as lost.
    const dir = runDir(state, "W1-T9070-newer");
    writeFileSync(join(state, "newer.json"), "");
    writeStatus(dir, status({ state: "failed", failure: { ...toRunChildFailure(new Error("x")), class: "from_the_future" as RunChildFailure["class"] } }));
    const newer = readStatus(dir);
    assert.ok(newer.ok && newer.value.failure);
    assert.equal(newer.value.failure.class, "unknown");
    assert.equal(fromRunChildFailure(newer.value.failure).kind, "lost");
    // The text a predicate matches survives the bound.
    const huge = ghError(`gh api repos/o/r/commits/abc/status ${"x".repeat(RUN_CHILD_FAILURE_TEXT_BOUND * 2)}`);
    const bounded = toRunChildFailure(huge);
    assert.equal(bounded.class, "gh_lane_read");
    assert.equal(bounded.message.length, RUN_CHILD_FAILURE_TEXT_BOUND);
    const mismatch = fromRunChildFailure(contractMismatchFailure("unknown spec major 9"));
    assert.equal(mismatch.kind, "error");
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});

function terminalRoundTrip(original: unknown) {
  const state = tmp();
  try {
    const dir = runDir(state, "terminal-representation");
    writeStatus(dir, status({ state: "failed", failure: toRunChildFailure(original) }));
    const read = readStatus(dir);
    assert.ok(read.ok && read.value.failure);
    return fromRunChildFailure(read.value.failure);
  } finally { rmSync(state, { recursive: true, force: true }); }
}

test("a terminal Git output overflow remains a failed error through the run-child status file", () => {
  const repo = gitRepo();
  try {
    let original: unknown;
    try { execFileSync("git", ["-C", repo.dir, "log", "-1", "--format=%H"], { maxBuffer: 8, encoding: "utf8" }); }
    catch (error) { original = error; }
    assert.ok(original instanceof Error);
    assert.equal((original as NodeJS.ErrnoException).code, "ENOBUFS");
    assert.equal(toRunChildFailure(original).class, "terminal_error");
    const settled = terminalRoundTrip(original);
    assert.equal(settled.kind, "error");
    assert.ok(settled.kind === "error");
    assert.equal(settled.error.name, original.name);
    assert.equal(settled.error.message, original.message);
    assert.equal((settled.error as NodeJS.ErrnoException).code, "ENOBUFS");
    assert.equal(classifyRunChildError(settled.error), classifyRunChildError(original));
    assert.deepEqual(laneDeliveryFailure(settled.error), laneDeliveryFailure(original));
  } finally { rmSync(repo.dir, { recursive: true, force: true }); }
});

test("a no-pid spawn failure remains a failed terminal error rather than an absent child", async () => {
  const state = tmp();
  try {
    let original: unknown;
    try { spawnDetachedGroup({ command: process.execPath, args: ["-e", ""], cwd: join(state, "missing"), env: {} }); }
    catch (error) { original = error; }
    assert.ok(original instanceof Error);
    assert.match(original.message, /no pid/i);
    const settled = terminalRoundTrip(original);
    assert.ok(settled.kind === "error");
    assert.equal(settled.error.name, original.name);
    assert.equal(settled.error.message, original.message);
    // Let the already-handled asynchronous ENOENT event finish before retiring the fixture.
    await new Promise<void>(resolve => setImmediate(resolve));
  } finally { rmSync(state, { recursive: true, force: true }); }
});

test("terminal error representation preserves the original daemon failure consequences", () => {
  const credential = ghError("Command failed: git push\nremote: Permission denied (publickey)");
  const programmer = Object.assign(new TypeError("rmd's own defect"), { reasonClass: "programmer_failure" });
  for (const original of [...SETTLE_LOOP_ERRORS.map(([, error]) => error), credential, programmer]) {
    const settled = terminalRoundTrip(original);
    assert.ok(settled.kind === "error");
    assert.equal(classifyRunChildError(settled.error), classifyRunChildError(original));
    assert.deepEqual(laneDeliveryFailure(settled.error), laneDeliveryFailure(original));
    assert.equal(isSpawnInfraBlockedError(settled.error), isSpawnInfraBlockedError(original));
    assert.equal(settled.error instanceof TaskAdmissionError, original instanceof TaskAdmissionError);
  }
  const rebuilt = terminalRoundTrip(programmer);
  assert.ok(rebuilt.kind === "error");
  assert.equal(rebuilt.error.name, "TypeError");
  assert.equal((rebuilt.error as Error & { reasonClass?: string }).reasonClass, "programmer_failure");
  assert.equal(laneDeliveryFailure(rebuilt.error), undefined, "a programmer defect remains fatal, not lane-local");
  const bounded = toRunChildFailure(new Error("x".repeat(RUN_CHILD_FAILURE_TEXT_BOUND + 1)));
  assert.equal(bounded.message.length, RUN_CHILD_FAILURE_TEXT_BOUND);
});

test("genuine lost and unknown run-child contracts are not rescued by terminal error representation", () => {
  for (const value of [undefined, "not an Error", { message: "not an Error instance" }]) {
    assert.equal(terminalRoundTrip(value).kind, "lost");
  }
  const state = tmp();
  try {
    const dir = runDir(state, "legacy-and-future");
    for (const failureClass of ["unknown", "a_future_class"]) {
      writeStatus(dir, status({ schema: { major: 1, minor: 0 }, state: "failed", failure: {
        class: failureClass as RunChildFailure["class"], reasonClass: "unknown", name: "Error", message: "not rescued by name",
      } }));
      const read = readStatus(dir);
      assert.ok(read.ok && read.value.failure);
      assert.equal(fromRunChildFailure(read.value.failure).kind, "lost");
    }
    writeStatus(dir, status({ identity: { ...status().identity, startTicks: "other" } }));
    assert.equal(classifyRunDir(dir, probe(() => ({ state: "alive", start: "proc:100" }))).kind, "lost");
    writeFileSync(join(dir, "status.json"), JSON.stringify({ ...status(), schema: { major: 2, minor: 0 } }));
    assert.equal(readStatus(dir).ok, false);
    writeFileSync(join(dir, "status.json"), "{torn");
    assert.equal(readStatus(dir).ok, false);
    assert.equal(readStatus(join(state, "missing")).ok, false);
  } finally { rmSync(state, { recursive: true, force: true }); }
});

test("W1-T9070: an unknown contract major is refused as contract_mismatch", () => {
  const state = tmp();
  try {
    const dir = runDir(state, "W1-T9070-1");
    // A newer MINOR adds fields; this reader ignores them.
    writeFileSync(join(state, "x"), "");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "spec.json"), JSON.stringify({ ...spec(), schema: { major: 1, minor: 9 }, futureField: { a: 1 }, engine: { sourceHash: "h", sha: "s", extra: true } }));
    const minor = readSpec(dir);
    assert.ok(minor.ok);
    assert.deepEqual(minor.value, { ...spec(), schema: { major: 1, minor: 9 }, engine: { sourceHash: "h", sha: "s" } });
    assert.equal("futureField" in minor.value, false);
    writeFileSync(join(dir, "status.json"), JSON.stringify({ ...status(), schema: { major: 1, minor: 4 }, novel: true }));
    const read = readStatus(dir);
    assert.ok(read.ok);
    assert.equal("novel" in read.value, false);
    // An unknown MAJOR is refused, by name — not parsed, not guessed at.
    writeFileSync(join(dir, "spec.json"), JSON.stringify({ ...spec(), schema: { major: 2, minor: 0 } }));
    const major = readSpec(dir);
    assert.equal(major.ok, false);
    assert.ok(!major.ok);
    assert.equal(major.reason, "contract_mismatch");
    writeFileSync(join(dir, "status.json"), JSON.stringify({ ...status(), schema: { major: 2, minor: 0 } }));
    const classified = classifyRunDir(dir, probe(() => ({ state: "alive", start: "proc:100" })));
    assert.equal(classified.kind, "unreadable", "an unknown major is never live");
    assert.match(classified.detail ?? "", /contract_mismatch/);
    writeFileSync(join(dir, "spec.json"), JSON.stringify({ ...spec(), schema: { major: "1", minor: 0 } }));
    const malformed = readSpec(dir);
    assert.ok(!malformed.ok);
    assert.equal(malformed.reason, "unreadable");
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});

test("W1-T9070: the boot census counts run directories by kind and ignores worker tails", () => {
  const state = tmp();
  try {
    assert.deepEqual(censusRunDirs(state), { live: 0, terminal: 0, lost: 0, dead: 0, unreadable: 0 }, "no runs directory is a census of zero");
    writeFileSync(join(state, "stray"), "");
    writeStatus(runDir(state, "r-live"), status({ runId: "r-live" }));
    writeStatus(runDir(state, "r-done"), status({ runId: "r-done", state: "done" }));
    writeStatus(runDir(state, "r-lost"), status({ runId: "r-lost", identity: { pid: 7, startTicks: "proc:1", containerGeneration: GENERATION } }));
    writeStatus(runDir(state, "r-dead"), status({ runId: "r-dead", identity: { pid: 8, startTicks: "proc:1", containerGeneration: { containerId: "old", initStart: "proc:1" } } }));
    mkdirSync(runDir(state, "r-empty"), { recursive: true });
    writeFileSync(join(state, "runs", "worker-1.tail"), "tail");
    const byPid = probe((pid) => (pid === 4242 ? { state: "alive", start: "proc:100" } : { state: "gone" }));
    assert.deepEqual(censusRunDirs(state, byPid), { live: 1, terminal: 1, lost: 1, dead: 1, unreadable: 1 });
    // A read failure other than "absent" is thrown, not read as zeros.
    const blocked = tmp();
    try {
      writeFileSync(join(blocked, "runs"), "not a directory");
      assert.throws(() => censusRunDirs(blocked), /ENOTDIR/);
    } finally {
      rmSync(blocked, { recursive: true, force: true });
    }
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});
