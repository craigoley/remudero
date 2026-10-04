/**
 * W1-T5284 — DAEMON LANE WORKTREES, RUN-BRANCH PUSHES AND AUTO-MERGE ARMS NEVER BLOCK THE LOOP.
 *
 * MEASURED 2026-10-02/04: live CPU profiles of the core daemon caught the event loop inside
 * `execFileSync` for a lane worktree's `git fetch`, the fix rung's `git fetch`, the run-branch
 * `git push` (14.7 s) and the at-open arm's `gh pr merge` / merge-queue read (10.4 + 3.5 s).
 *
 * Every "lets a timer fire" test below runs the REAL subprocess off a fixture that holds it open
 * (a slow upload-pack / receive-pack on a local origin, or a delayed `gh` shim) and counts the
 * interval ticks the loop ran while that subprocess was in flight. A synchronous implementation
 * cannot pass: it holds the loop until the child exits, so no tick runs while it is in flight.
 * No wall clock is read; the only number asserted is a count of ticks that observed the child.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  ArmSeamRequiredError,
  armAutoMergeAtOpenAsync,
  attemptArm,
  attemptArmAsync,
  baseBranchRequiresMergeQueue,
  baseBranchRequiresMergeQueueAsync,
  disarmAutoMerge,
  disarmAutoMergeAsync,
  mergeDirectViaRestAsync,
  realArmDepsAsync,
  type ArmAttemptResult,
  type AsyncArmDeps,
} from "../src/lib/arm-auto-merge.js";
import {
  defaultGitCaptureAsync,
  defaultPushExecAsync,
  gitPushRunBranch,
  gitPushRunBranchAsync,
  LanePushForeignHeadError,
  PushFailedError,
  runStepsAsync,
  runStepsSync,
  step,
  type PushRunBranchOpts,
} from "../src/lib/git-push.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { addLaneWorktree, createDaemonLaneWorktree, createFixRungWorktree, pushFixRound } from "../src/run-task.js";
import { ghShim } from "./helpers/gh-shim.js";
import { GIT_REPO_FIXTURE_IDENTITY } from "./helpers/git-repo.js";

type Log = (step: string, extra?: Record<string, unknown>) => void;

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** Counts the interval ticks the loop ran while `inFlight()` read true, across `call`. */
async function ticksWhileInFlight<T>(inFlight: () => boolean, call: () => Promise<T>): Promise<{ inFlightTicks: number; value: T }> {
  let inFlightTicks = 0;
  const interval = setInterval(() => {
    if (inFlight()) inFlightTicks += 1;
  }, 5);
  try {
    const value = await call();
    return { inFlightTicks, value };
  } finally {
    clearInterval(interval);
  }
}

/** A bare origin with `main` (and `extra` branches), a clone of it, and a transport script that
 *  holds every fetch/ls-remote (upload-pack) and push (receive-pack) open while it is logged. */
function slowOriginFixture(kind: string, extra: string[] = []) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t5284-${kind}-`));
  const origin = join(root, "origin.git");
  execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", origin]);
  const seed = join(root, "seed");
  execFileSync("git", ["init", "--quiet", "-b", "main", seed]);
  git(seed, "config", "user.name", GIT_REPO_FIXTURE_IDENTITY.name);
  git(seed, "config", "user.email", GIT_REPO_FIXTURE_IDENTITY.email);
  writeFileSync(join(seed, "seed.txt"), "seed\n");
  git(seed, "add", "-A");
  git(seed, "commit", "--no-verify", "--quiet", "-m", "chore: seed");
  git(seed, "push", "--quiet", origin, "main");
  for (const branch of extra) git(seed, "push", "--quiet", origin, `main:refs/heads/${branch}`);
  const clone = join(root, "clone");
  execFileSync("git", ["clone", "--quiet", origin, clone]);
  git(clone, "config", "user.name", GIT_REPO_FIXTURE_IDENTITY.name);
  git(clone, "config", "user.email", GIT_REPO_FIXTURE_IDENTITY.email);
  const transportLog = join(root, "transport.log");
  for (const [service, key] of [["upload-pack", "uploadpack"], ["receive-pack", "receivepack"]] as const) {
    const script = join(root, `slow-${service}.sh`);
    writeFileSync(
      script,
      `#!/bin/sh\necho "start ${service}" >> '${transportLog}'\nsleep 0.3\ngit ${service} "$@"\nrc=$?\necho "end ${service}" >> '${transportLog}'\nexit $rc\n`,
      { mode: 0o755 },
    );
    git(clone, "config", `remote.origin.${key}`, script);
  }
  const lines = (): string[] => (existsSync(transportLog) ? readFileSync(transportLog, "utf8").split("\n").filter(Boolean) : []);
  return {
    root,
    clone,
    origin,
    worktreesRoot: join(root, "worktrees"),
    /** True while the FIRST transport child of `service` since `reset()` has started and not ended. */
    firstInFlight: (service: "upload-pack" | "receive-pack") => {
      const own = lines().filter((line) => line.endsWith(service));
      return own[0] === `start ${service}` && !own.includes(`end ${service}`);
    },
    reset: () => rmSync(transportLog, { force: true }),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function recordingLog(): { log: Log; steps: string[] } {
  const steps: string[] = [];
  return { log: (step) => void steps.push(step), steps };
}

test("W1-T5284: a daemon lane worktree add lets a timer fire while git fetch is in flight", async (t) => {
  for (const [name, add] of [
    ["addLaneWorktree", addLaneWorktree],
    ["createDaemonLaneWorktree", createDaemonLaneWorktree],
  ] as const) {
    const fx = slowOriginFixture(`lane-${name}`);
    try {
      const { log, steps } = recordingLog();
      fx.reset();
      const { inFlightTicks, value } = await ticksWhileInFlight(
        () => fx.firstInFlight("upload-pack"),
        async () => add(fx.clone, fx.worktreesRoot, `W1-T5284-${name}`, log),
      );
      t.diagnostic(`${name}: ${inFlightTicks} loop tick(s) ran while git fetch was in flight`);
      assert.ok(inFlightTicks > 0, `${name}: a timer must run while the lane's git fetch is in flight`);
      assert.equal(value.branch, `run-W1-T5284-${name}`);
      assert.equal(git(value.worktreePath, "rev-parse", "HEAD"), git(fx.clone, "rev-parse", "origin/main"));
      assert.ok(steps.includes("worktree.add"), `${name} still ledgers its worktree.add row`);
      assert.ok(!steps.includes("worktree.add_failed"));
    } finally {
      fx.cleanup();
    }
  }
});

test("W1-T5284: a failed daemon lane worktree add still ledgers worktree.add_failed and rejects", async () => {
  for (const add of [addLaneWorktree, createDaemonLaneWorktree]) {
    const fx = slowOriginFixture("lane-fail");
    try {
      git(fx.clone, "remote", "set-url", "origin", join(fx.root, "no-such-origin.git"));
      const { log, steps } = recordingLog();
      await assert.rejects(add(fx.clone, fx.worktreesRoot, "W1-T5284-FAIL", log));
      assert.ok(steps.includes("worktree.add_failed"));
    } finally {
      fx.cleanup();
    }
  }
});

test("W1-T5284: two daemon lane adds from one run id in flight together never mint the same branch", async () => {
  const fx = slowOriginFixture("lane-concurrent");
  try {
    const { log } = recordingLog();
    const [first, second] = await Promise.all([
      createDaemonLaneWorktree(fx.clone, fx.worktreesRoot, "W1-T5284-SAME", log),
      createDaemonLaneWorktree(fx.clone, fx.worktreesRoot, "W1-T5284-SAME", log),
    ]);
    assert.notEqual(first.branch, second.branch, "the branch a pending add reserved is never handed out twice");
    assert.ok(existsSync(join(first.worktreePath, ".git")) && existsSync(join(second.worktreePath, ".git")));
    // The reservation is released once each add settles: a third call after both finished takes the next free name.
    const third = await createDaemonLaneWorktree(fx.clone, fx.worktreesRoot, "W1-T5284-SAME", log);
    assert.equal(third.branch, "run-W1-T5284-SAME-3");
  } finally {
    fx.cleanup();
  }
});

test("W1-T5284: the fix rung worktree lets a timer fire while git fetch is in flight", async (t) => {
  const fx = slowOriginFixture("fix-rung", ["run-W1-T5284-fix"]);
  try {
    fx.reset();
    const worktreePath = join(fx.worktreesRoot, "sweep-W1-T5284");
    mkdirSync(fx.worktreesRoot, { recursive: true });
    const { inFlightTicks, value } = await ticksWhileInFlight(
      () => fx.firstInFlight("upload-pack"),
      () => createFixRungWorktree(fx.clone, worktreePath, "run-W1-T5284-fix"),
    );
    t.diagnostic(`createFixRungWorktree: ${inFlightTicks} loop tick(s) ran while git fetch was in flight`);
    assert.ok(inFlightTicks > 0, "a timer must run while the fix rung's git fetch is in flight");
    assert.equal(value, undefined, "an absent local branch is created fresh, with no recovery evidence");
    assert.equal(git(worktreePath, "rev-parse", "--abbrev-ref", "HEAD"), "run-W1-T5284-fix");
    assert.equal(git(worktreePath, "rev-parse", "HEAD"), git(fx.clone, "rev-parse", "origin/run-W1-T5284-fix"));
  } finally {
    fx.cleanup();
  }
});

test("W1-T5284: a fix rung worktree whose add fails rejects with git's refusal", async () => {
  const fx = slowOriginFixture("fix-rung-fail");
  try {
    await assert.rejects(createFixRungWorktree(fx.clone, join(fx.worktreesRoot, "wt"), "run-no-such-branch"), /origin\/run-no-such-branch|invalid reference/);
  } finally {
    fx.cleanup();
  }
});

/** A worktree on `run-W1-T5284-push` with one commit not yet on origin. */
function pushFixture(kind: string) {
  const fx = slowOriginFixture(kind, ["run-W1-T5284-push"]);
  const wt = join(fx.root, "wt");
  git(fx.clone, "worktree", "add", "--quiet", "-b", "run-W1-T5284-push", "--no-track", wt, "origin/run-W1-T5284-push");
  writeFileSync(join(wt, "work.txt"), "work\n");
  git(wt, "add", "-A");
  git(wt, "commit", "--no-verify", "--quiet", "-m", "feat: work");
  return { ...fx, wt, head: git(wt, "rev-parse", "HEAD") };
}

test("W1-T5284: a run branch push lets a timer fire while git push is in flight and refuses what the sync push refuses", async (t) => {
  const fx = pushFixture("push");
  try {
    fx.reset();
    const { inFlightTicks } = await ticksWhileInFlight(
      () => fx.firstInFlight("receive-pack"),
      () => withLiveWritesAllowed(() => gitPushRunBranchAsync(fx.wt, { expectedHeadSha: fx.head })),
    );
    t.diagnostic(`gitPushRunBranchAsync: ${inFlightTicks} loop tick(s) ran while git push was in flight`);
    assert.ok(inFlightTicks > 0, "a timer must run while the run branch's git push is in flight");
    assert.equal(git(fx.origin, "rev-parse", "refs/heads/run-W1-T5284-push"), fx.head, "the push landed the head");
  } finally {
    fx.cleanup();
  }

  // REFUSES WHAT THE SYNC PUSH REFUSES: the same scripted reads drive both forms, which must make
  // the same calls, print the same refusals and throw the same errors.
  const NEW = "a".repeat(40);
  const PUBLISHED = "b".repeat(40);
  const FOREIGN = "c".repeat(40);
  type Script = { capture: (args: string[]) => string; exec?: (args: string[]) => void };
  const cases: Array<[string, PushRunBranchOpts, () => Script]> = [
    ["a moved head is refused before any push", { expectedHeadSha: NEW }, () => ({ capture: () => `${FOREIGN}\n` })],
    ["a plain push", { setUpstream: true, stdio: "ignore" }, () => ({ capture: () => "" })],
    ["a detached head has no lease", { force: true }, () => ({ capture: (a) => (a.includes("--abbrev-ref") ? "HEAD\n" : "") })],
    ["no tracking ref has no lease", { force: true }, () => ({
      capture: (a) => {
        if (a.includes("--abbrev-ref")) return "run-x\n";
        if (a.includes("refs/remotes/origin/run-x")) throw new Error("unknown ref");
        return "";
      },
    })],
    ["an unreadable head has no lease", { force: true }, () => ({
      capture: (a) => (a.includes("--abbrev-ref") ? "run-x\n" : a.includes("refs/remotes/origin/run-x") ? `${PUBLISHED}\n` : ""),
    })],
    ["a push that would discard a foreign commit", { force: true }, () => ({
      capture: (a) => {
        const joined = a.join(" ");
        if (joined.includes("--abbrev-ref")) return "run-x\n";
        if (joined.includes("refs/remotes/origin/run-x")) return `${PUBLISHED}\n`;
        if (joined.endsWith("rev-parse HEAD")) return `${NEW}\n`;
        if (joined.includes("ls-remote")) return `${FOREIGN}\trefs/heads/run-x\n`;
        if (joined.includes("rev-list --parents -1")) return `${NEW} p1\n`;
        if (joined.includes("rev-list --parents")) return `${FOREIGN} ${PUBLISHED}\n`;
        return "";
      },
    })],
    ["an unreadable walk", { force: true }, () => ({
      capture: (a) => {
        const joined = a.join(" ");
        if (joined.includes("--abbrev-ref")) return "run-x\n";
        if (joined.includes("refs/remotes/origin/run-x")) return `${PUBLISHED}\n`;
        if (joined.endsWith("rev-parse HEAD")) return `${NEW}\n`;
        if (joined.includes("ls-remote")) return `${FOREIGN}\trefs/heads/run-x\n`;
        throw new Error("walk failed");
      },
    })],
    ["a rejected lease names the foreign head", { force: true }, () => ({
      capture: (a) => {
        const joined = a.join(" ");
        if (joined.includes("--abbrev-ref")) return "run-x\n";
        if (joined.includes("refs/remotes/origin/run-x")) return `${PUBLISHED}\n`;
        if (joined.endsWith("rev-parse HEAD")) return `${NEW}\n`;
        if (joined.includes("ls-remote")) return `${NEW}\trefs/heads/run-x\n`;
        return "";
      },
      exec: () => {
        throw new Error("stale info");
      },
    })],
    ["an elided lease reads back a foreign head", { force: true, setUpstream: true }, () => ({
      capture: (() => {
        let reads = 0;
        return (a: string[]) => {
          const joined = a.join(" ");
          if (joined.includes("--abbrev-ref")) return "run-x\n";
          if (joined.includes("refs/remotes/origin/run-x")) return `${PUBLISHED}\n`;
          if (joined.endsWith("rev-parse HEAD")) return `${NEW}\n`;
          if (joined.includes("ls-remote")) return (reads++ === 0 ? `${NEW}` : `${FOREIGN}`) + "\trefs/heads/run-x\n";
          return "";
        };
      })(),
    })],
  ];
  for (const [name, opts, makeScript] of cases) {
    const run = async (mode: "sync" | "async") => {
      const script = makeScript();
      const calls: string[] = [];
      const printed: string[] = [];
      const capture = (_file: string, args: string[]) => {
        calls.push(`capture ${args.join(" ")}`);
        return script.capture(args);
      };
      const exec = (_file: string, args: string[], o: { stdio: string }) => {
        calls.push(`exec ${o.stdio} ${args.join(" ")}`);
        script.exec?.(args);
      };
      const originalError = console.error;
      console.error = (line: unknown) => void printed.push(String(line));
      let thrown: unknown;
      try {
        if (mode === "sync") withLiveWritesAllowed(() => gitPushRunBranch("/wt", { ...opts, capture, exec }));
        else {
          await withLiveWritesAllowed(() =>
            gitPushRunBranchAsync("/wt", {
              ...opts,
              capture: async (file, args) => capture(file, args),
              exec: async (file, args, o) => exec(file, args, o),
            }),
          );
        }
      } catch (error) {
        thrown = error;
      } finally {
        console.error = originalError;
      }
      return { calls, printed, thrown: thrown === undefined ? undefined : `${(thrown as Error).name}: ${(thrown as Error).message}` };
    };
    const sync = await run("sync");
    const viaAsync = await run("async");
    assert.ok(sync.calls.length > 0, `${name}: the scripted push ran`);
    assert.deepEqual(viaAsync, sync, name);
  }
  const refused = await withLiveWritesAllowed(() =>
    gitPushRunBranchAsync("/wt", { expectedHeadSha: NEW, capture: async () => FOREIGN }),
  ).catch((error: unknown) => error);
  assert.ok(refused instanceof LanePushForeignHeadError, "a moved head is the same foreign-head refusal");
});

test("W1-T5284: the async push's real transport re-emits a refusal's stderr and names it on the error", async () => {
  const fx = pushFixture("push-refused");
  try {
    // The origin refuses every ref update, the shape of a pre-receive / pre-push gate refusal.
    writeFileSync(join(fx.origin, "hooks", "pre-receive"), "#!/bin/sh\necho 'census refused this head' >&2\nexit 1\n", { mode: 0o755 });
    const written: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    let error: unknown;
    try {
      await defaultPushExecAsync("git", ["-C", fx.wt, "push", "origin", "HEAD"], { stdio: "inherit" });
    } catch (caught) {
      error = caught;
    } finally {
      process.stderr.write = originalWrite;
    }
    assert.ok(error instanceof PushFailedError, "a failed push is a PushFailedError, as in the sync leaf");
    assert.match(error.stderrText, /census refused this head/);
    assert.ok(written.join("").includes("census refused this head"), "the refusal is re-emitted to stderr");
    await assert.rejects(defaultPushExecAsync("git", ["-C", fx.wt, "push", "origin", "HEAD"], { stdio: "ignore" }));
    assert.equal((await defaultGitCaptureAsync("git", ["-C", fx.wt, "rev-parse", "HEAD"])).trim(), fx.head);
  } finally {
    fx.cleanup();
  }
});

test("W1-T5284: a push the gate refuses without stderr still fails as a PushFailedError", async () => {
  const fx = pushFixture("push-silent");
  try {
    writeFileSync(join(fx.origin, "hooks", "pre-receive"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      // receive-pack still reports the declined ref on stderr, so assert the class, not silence.
      await assert.rejects(defaultPushExecAsync("git", ["-C", fx.wt, "push", "origin", "HEAD"], { stdio: "inherit" }), PushFailedError);
      await assert.rejects(
        defaultPushExecAsync("git", ["-C", join(fx.root, "no-such-dir"), "push"], { stdio: "inherit" }),
        PushFailedError,
      );
    } finally {
      process.stderr.write = originalWrite;
    }
  } finally {
    fx.cleanup();
  }
});

test("W1-T5284: the fix round push awaits its push and keeps the sync round's refusals", async (t) => {
  const fx = pushFixture("fix-round");
  try {
    fx.reset();
    const { inFlightTicks } = await ticksWhileInFlight(
      () => fx.firstInFlight("receive-pack"),
      () => withLiveWritesAllowed(() => pushFixRound(fx.wt, "run-W1-T5284-push", fx.head)),
    );
    t.diagnostic(`pushFixRound: ${inFlightTicks} loop tick(s) ran while git push was in flight`);
    assert.ok(inFlightTicks > 0, "a timer must run while the fix round's git push is in flight");
    assert.equal(git(fx.origin, "rev-parse", "refs/heads/run-W1-T5284-push"), fx.head);
    // The remote already holds this exact head: a repeat is the one silent no-op.
    await withLiveWritesAllowed(() => pushFixRound(fx.wt, "run-W1-T5284-push", fx.head, undefined, {
      exec: () => {
        throw new Error("rejected: already there");
      },
    }));
    await assert.rejects(withLiveWritesAllowed(() => pushFixRound(fx.wt, "run-W1-T5284-push", "0".repeat(40))), LanePushForeignHeadError);
    await assert.rejects(
      withLiveWritesAllowed(() => pushFixRound(fx.wt, "run-W1-T5284-push", undefined, fx.head)),
      /refusing a leased fix push without the committed head sha/,
    );
  } finally {
    fx.cleanup();
  }
});

test("W1-T5284: the step drivers resume a step with its value and throw a step's failure into it", async () => {
  function* steps(fail: boolean) {
    const first = yield* step(() => (fail ? Promise.reject(new Error("boom")) : Promise.resolve(2)));
    return first * 10;
  }
  function* caught() {
    try {
      yield* step(() => {
        throw new Error("sync boom");
      });
      return "unreached";
    } catch (error) {
      return `caught ${(error as Error).message}`;
    }
  }
  assert.equal(await runStepsAsync(steps(false)), 20);
  await assert.rejects(runStepsAsync(steps(true)), /boom/);
  assert.equal(runStepsSync(caught()), "caught sync boom");
  assert.equal(await runStepsAsync(caught()), "caught sync boom");
});

// ── ARMING ───────────────────────────────────────────────────────────────────────────────────

const PR = "https://github.com/craigoley/remudero/pull/5284";

/** Runs `attemptArm` and `attemptArmAsync` over the same scripted deps; the async form's writes
 *  and merge-queue read return promises. */
type ArmScript = Omit<Parameters<typeof attemptArm>[1], "say">;

async function armBothWays(
  script: ArmScript,
  isDraft?: boolean,
): Promise<{ sync: { result: ArmAttemptResult; said: string[] }; viaAsync: { result: ArmAttemptResult; said: string[] } }> {
  const syncSaid: string[] = [];
  const result = attemptArm(PR, { ...script, say: (m) => void syncSaid.push(m) }, undefined, isDraft);
  const asyncSaid: string[] = [];
  const deps: Parameters<typeof attemptArmAsync>[1] = {
    ...script,
    armAuto: async (url) => script.armAuto(url),
    mergeDirect: async (url) => script.mergeDirect(url),
    ...(script.enqueue ? { enqueue: async (url: string) => script.enqueue!(url) } : {}),
    ...(script.mergeQueue ? { mergeQueue: async (url: string) => script.mergeQueue!(url) } : {}),
    say: (m) => void asyncSaid.push(m),
  };
  const viaAsync = await attemptArmAsync(PR, deps, undefined, isDraft);
  return { sync: { result, said: syncSaid }, viaAsync: { result: viaAsync, said: asyncSaid } };
}

function ghError(stderr: string): Error {
  return Object.assign(new Error("Command failed: gh pr merge"), { stderr });
}

test("W1-T5284: arming auto merge lets a timer fire while gh is in flight and returns the same outcome", async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t5284-arm-`));
  const done = join(scratch, "merge.done");
  const shim = ghShim(
    [
      { when: "rules/branches", stdout: "[]" },
      { when: "pulls/5284", stdout: JSON.stringify({ base: { ref: "main" } }) },
      { when: "pr merge", delaySeconds: 0.3, doneFile: done },
    ],
    { kind: "t5284-arm-gh" },
  );
  const savedPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${savedPath}`;
  try {
    const real = realArmDepsAsync();
    const said: string[] = [];
    const { inFlightTicks, value } = await ticksWhileInFlight(
      () => shim.calls().some((call) => call.startsWith("pr merge")) && !existsSync(done),
      () =>
        withLiveWritesAllowed(() =>
          attemptArmAsync(PR, {
            armAuto: real.armAuto,
            mergeDirect: real.mergeDirect,
            mergeQueue: real.mergeQueue,
            isMerged: () => false,
            say: (m) => void said.push(m),
          }),
        ),
    );
    t.diagnostic(`attemptArmAsync: ${inFlightTicks} loop tick(s) ran while gh pr merge was in flight`);
    assert.ok(inFlightTicks > 0, "a timer must run while the arm's gh call is in flight");
    assert.deepEqual(value, { outcome: "armed" });
    assert.ok(shim.calls().includes(`pr merge ${PR} --auto --squash`), "the arm is the same gh argv");
    assert.ok(shim.calls().some((call) => call.includes("rules/branches/main")), "the merge-queue read went through gh");
  } finally {
    process.env.PATH = savedPath;
    rmSync(scratch, { recursive: true, force: true });
  }

  // THE SAME OUTCOME: every arm class, through both drivers.
  const ok = () => {};
  const scenarios: Array<[string, ArmScript, boolean?]> = [
    ["armed", { armAuto: ok, mergeDirect: ok, isMerged: () => false }],
    ["draft", { armAuto: ok, mergeDirect: ok, isMerged: () => false }, true],
    ["clean status merges directly", { armAuto: () => { throw ghError("Pull request is in clean status"); }, mergeDirect: ok, isMerged: () => false }],
    ["a failed direct merge", { armAuto: () => { throw ghError("Pull request is in clean status"); }, mergeDirect: () => { throw ghError("HTTP 409"); }, isMerged: () => false }],
    ["a direct merge that landed anyway", { armAuto: () => { throw ghError("Pull request is in clean status"); }, mergeDirect: () => { throw ghError("HTTP 502"); }, isMerged: () => true }],
    ["an unknown arm error", { armAuto: () => { throw ghError("something odd"); }, mergeDirect: ok, isMerged: () => false }],
    ["a stacked parent", { armAuto: ok, mergeDirect: ok, isMerged: () => false, stackPrerequisite: () => ({ state: "blocked", parentNumbers: [1], detail: "parent #1 open" }) }],
    ["a merge-queue arm", { armAuto: ok, mergeDirect: ok, isMerged: () => false, mergeQueue: () => true }],
    ["already queued", { armAuto: () => { throw ghError("already queued"); }, mergeDirect: ok, isMerged: () => false, mergeQueue: () => true }],
    ["enqueued when green", { armAuto: () => { throw ghError("clean status"); }, mergeDirect: ok, isMerged: () => false, mergeQueue: () => true, enqueue: ok }],
    ["an enqueue that failed", { armAuto: () => { throw ghError("clean status"); }, mergeDirect: ok, isMerged: () => false, mergeQueue: () => true, enqueue: () => { throw ghError("boom"); } }],
    ["an enqueue the queue already holds", { armAuto: () => { throw ghError("clean status"); }, mergeDirect: ok, isMerged: () => false, mergeQueue: () => true, enqueue: () => { throw ghError("already in the merge queue"); } }],
    ["a queue arm error", { armAuto: () => { throw ghError("nope"); }, mergeDirect: ok, isMerged: () => false, mergeQueue: () => true }],
    ["the quota fallback merges", { armAuto: () => { throw ghError("secondary rate limit"); }, mergeDirect: ok, isMerged: () => false }],
    ["the quota fallback refused", { armAuto: () => { throw ghError("secondary rate limit"); }, mergeDirect: () => { throw ghError("HTTP 409"); }, isMerged: () => false }],
    ["the quota fallback landed anyway", { armAuto: () => { throw ghError("secondary rate limit"); }, mergeDirect: () => { throw ghError("HTTP 409"); }, isMerged: () => true }],
    ["the quota fallback retries a settled 405", quotaRetryScenario("retry-lands")],
    ["the quota retry that fails again", quotaRetryScenario("fails-again")],
    ["the quota retry whose merge landed", quotaRetryScenario("landed")],
    ["the quota retry settles conflicting", quotaRetryScenario("conflicting")],
    ["a plan PR merges directly", { armAuto: ok, mergeDirect: ok, isMerged: () => false, readPlanTouch: () => "touched", readMergeFacts: () => ({ mergeable: "MERGEABLE", behindBy: 0, mergeableState: "clean" }), updateBranch: () => ({ ok: true }) }],
    ["a plan PR held", { armAuto: ok, mergeDirect: ok, isMerged: () => false, readPlanTouch: () => "unreadable" }],
  ];
  for (const [name, script, isDraft] of scenarios) {
    const { sync, viaAsync } = await armBothWays(script, isDraft);
    assert.deepEqual(viaAsync, sync, name);
  }
});

/** The quota fallback's settled-405 retry (W1-T1280). One scenario serves both forms in turn, so
 *  its state advances by a full sync run before the async run: every counter is read modulo the
 *  calls one run makes (two merges, two merge-facts reads). */
function quotaRetryScenario(kind: "retry-lands" | "fails-again" | "landed" | "conflicting"): ArmScript {
  let merges = 0;
  let reads = 0;
  const facts = { mergeable: "MERGEABLE", behindBy: 0 };
  return {
    armAuto: () => {
      throw ghError("secondary rate limit");
    },
    mergeDirect: () => {
      merges += 1;
      if (kind === "retry-lands" && merges % 2 === 0) return;
      throw ghError("HTTP 405");
    },
    isMerged: () => kind === "landed" && merges % 2 === 0,
    readMergeFacts: () => (kind === "conflicting" && reads++ % 2 === 1 ? { mergeable: "CONFLICTING" } : facts),
    updateBranch: () => ({ ok: true }),
    sleepSync: () => {},
  };
}

test("W1-T5284: the async arm's real transport carries each gh write and the cached merge-queue read", async () => {
  const shim = ghShim(
    [
      { when: "rules/branches/queued", stdout: JSON.stringify([{ type: "merge_queue" }]) },
      { when: "pulls/7001", stdout: JSON.stringify({ base: { ref: "queued" } }) },
      { when: "pulls/7002", stdout: JSON.stringify({}) },
      { when: "pulls/7003", stdout: "not json" },
      { when: "--disable-auto", stderr: "can't disable auto-merge", exit: 1 },
    ],
    { kind: "t5284-arm-real" },
  );
  const savedPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${savedPath}`;
  try {
    const real = realArmDepsAsync(() => {
      throw new Error("no config");
    });
    const url = (n: number) => `https://github.com/craigoley/remudero/pull/${n}`;
    assert.equal(await real.mergeQueue!(url(7001)), true);
    assert.equal(await real.mergeQueue!(url(7001)), true, "a second read inside the TTL is served from the cache");
    assert.equal(shim.calls().filter((call) => call.includes("pulls/7001")).length, 1);
    assert.equal(await baseBranchRequiresMergeQueueAsync(url(7002)), false, "no base ref reads as no queue");
    assert.equal(await baseBranchRequiresMergeQueueAsync(url(7003)), false, "an unreadable read keeps the pre-queue path");
    assert.equal(await baseBranchRequiresMergeQueueAsync("not a pr url"), false);
    assert.equal(
      await baseBranchRequiresMergeQueueAsync(url(1), async (args) => (args[1]?.includes("rules") ? [{ type: "merge_queue" }] : { base: { ref: "main" } })),
      baseBranchRequiresMergeQueue(url(1), (args) => (args[1]?.includes("rules") ? [{ type: "merge_queue" }] : { base: { ref: "main" } })),
    );
    assert.deepEqual(real.ledgerLines(), [], "the async deps keep the sync deps' reads");
    await withLiveWritesAllowed(async () => {
      await real.armAuto(url(7004));
      await real.enqueue!(url(7004));
      await real.mergeDirect(url(7004));
      await assert.rejects(Promise.resolve(real.disableAuto(url(7004))), /can't disable auto-merge/);
    });
    const calls = shim.calls();
    assert.ok(calls.includes(`pr merge ${url(7004)} --auto --squash`));
    assert.ok(calls.includes(`pr merge ${url(7004)}`));
    assert.ok(calls.includes("api --method PUT repos/craigoley/remudero/pulls/7004/merge -f merge_method=squash"));
    assert.ok(calls.includes(`pr merge ${url(7004)} --disable-auto`));
    await assert.rejects(mergeDirectViaRestAsync("not a pr url"), /refusing to merge blind/);
  } finally {
    process.env.PATH = savedPath;
  }
});

test("W1-T5284: the async at-open arm and disarm keep their sync outcomes", async () => {
  const said: string[] = [];
  const deps: AsyncArmDeps = {
    headSha: () => "h",
    ledgerLines: () => [],
    armAuto: async () => {},
    mergeDirect: async () => {},
    disableAuto: async () => {},
    isMerged: () => false,
    say: (m) => void said.push(m),
  };
  assert.equal(await armAutoMergeAtOpenAsync(PR, deps, true), "irreversible-refused");
  assert.equal(await armAutoMergeAtOpenAsync(PR, deps), "armed");
  assert.equal(await armAutoMergeAtOpenAsync(PR, deps, false, true), "draft-refused");
  await assert.rejects(armAutoMergeAtOpenAsync(PR), ArmSeamRequiredError, "the real deps stay opt-in under the test runner");

  const syncDeps = { disableAuto: () => {}, say: () => {} };
  assert.equal(await disarmAutoMergeAsync(PR, deps), disarmAutoMerge(PR, syncDeps));
  for (const merged of [true, false]) {
    const refusing = { disableAuto: () => { throw ghError("can't disable auto-merge"); }, isMerged: () => merged, say: () => {} };
    assert.equal(
      await disarmAutoMergeAsync(PR, { ...refusing, disableAuto: async () => refusing.disableAuto() }),
      disarmAutoMerge(PR, refusing),
    );
  }
  await assert.rejects(disarmAutoMergeAsync(PR), ArmSeamRequiredError);
});
