// W1-T6034. MEASURED 2026-10-06 15:28Z: one 248 s `rmd check-proof`, spawned synchronously by the
// checked PR opener inside the daemon, froze its loop for 400 s (daemon.loop_lag, 6 missed pulse
// ticks). The daemon's PR-open seam now builds through ghPrCreateFillCommandAsync, which awaits
// openPullRequestCheckedAsync. These tests drive that seam with a fixture check-proof and assert
// that the loop keeps ticking and that the outcomes match the synchronous opener's.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
// Namespace imports: the async exports are absent at the merge base, so each test fails alone
// there instead of the whole file failing at link time.
import * as prOpen from "../src/lib/pr-open.js";
import * as runTask from "../src/run-task.js";
import { gitRepo } from "./helpers/git-repo.js";

/** A fixture `rmd`: sleeps 2 s on SLOW, exits 3 on FAIL, kills itself with SIGTERM on SIGNAL, passes otherwise. */
function fixtureRmd(dir: string): string {
  const bin = join(dir, "fixture-rmd");
  writeFileSync(
    bin,
    [
      "#!/usr/bin/env node",
      "const proof = process.argv[3];",
      "if (proof.includes('SIGNAL')) process.kill(process.pid, 'SIGTERM');",
      "setTimeout(() => {",
      "  process.stdout.write('verdict: ' + (proof.includes('FAIL') ? 'fail' : 'pass') + '\\n');",
      "  process.exit(proof.includes('FAIL') ? 3 : 0);",
      "}, proof.includes('SLOW') ? 2000 : proof.includes('SIGNAL') ? 5000 : 0);",
    ].join("\n"),
  );
  chmodSync(bin, 0o755);
  return bin;
}

/** A checkout on run branch run-W1-T9-1 whose plan files `proof`, with origin/main a commit behind. */
function filedRunBranch(proof: string): { dir: string; bin: string } {
  const repo = gitRepo({ kind: "proof-never-blocks" });
  mkdirSync(join(repo.dir, "plan"));
  const plan = ["- id: W1-T9", "  title: fixture", "  repo: remudero", "  type: implement", "  acceptance:"];
  plan.push("    - claim: the fixture claim", `      proof: ${JSON.stringify(proof)}`);
  writeFileSync(join(repo.dir, "plan", "tasks.yaml"), `${plan.join("\n")}\n`);
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "chore: seed");
  repo.git("update-ref", "refs/remotes/origin/main", repo.git("rev-parse", "HEAD"));
  writeFileSync(join(repo.dir, "note.md"), "change\n");
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "feat: change");
  return { dir: repo.dir, bin: fixtureRmd(repo.dir) };
}

const BRANCH = "run-W1-T9-1";
const awaitedRunner =
  (bin: string): prOpen.AsyncOpenPullRequestProofRunner =>
  (proof, mergeBase, root, target) =>
    prOpen.defaultProofRunnerAsync(proof, mergeBase, root, target, { bin });
const syncRunner =
  (bin: string): prOpen.OpenPullRequestProofRunner =>
  (proof, mergeBase, root, target) =>
    prOpen.defaultProofRunner(proof, mergeBase, root, target, bin);

/** The refusal a call throws or rejects with, as `{class, message}`; "opened" when it does not refuse. */
async function refusalOf(open: () => unknown): Promise<{ refusalClass: string; message: string } | "opened"> {
  try {
    await open();
    return "opened";
  } catch (err) {
    assert.ok(err instanceof prOpen.PrOpenRefusedError, `expected a PR-open refusal, got ${String(err)}`);
    return { refusalClass: err.refusalClass, message: err.message };
  }
}

test("a slow check-proof lets the event loop keep ticking while the daemon's PR open awaits it", async () => {
  const { dir, bin } = filedRunBranch("grep: SLOW in note.md");
  try {
    let ticks = 0;
    const timer = setInterval(() => ticks++, 50);
    let built: Awaited<ReturnType<typeof runTask.ghPrCreateFillCommandAsync>>;
    let ticksWhilePending = -1;
    try {
      const pending = withLiveWritesAllowed(() =>
        runTask.ghPrCreateFillCommandAsync(dir, "o", "r", BRANCH, "feat(x): a subject", awaitedRunner(bin)),
      );
      built = await pending.then((value) => {
        ticksWhilePending = ticks;
        return value;
      });
    } finally {
      clearInterval(timer);
    }
    // A synchronous spawn of this 2 s proof lands zero ticks; an awaited one lands about forty.
    assert.ok(ticksWhilePending >= 10, `the loop serviced only ${ticksWhilePending} ticks during a 2 s proof run`);
    const body = built.args.find((arg) => arg.startsWith("body=")) ?? "";
    assert.match(body, /^Remudero-Task: W1-T9$/m, "the awaited proof passed, so the checked body reaches the create argv");
    assert.deepEqual(built.args.slice(0, 4), ["api", "--method", "POST", "repos/o/r/pulls"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a proof's exit and signal outcomes reach the awaited opener exactly as the synchronous opener reports them", async () => {
  for (const proof of ["grep: FAIL in note.md", "grep: SIGNAL in note.md", "grep: PASS in note.md"]) {
    const { dir, bin } = filedRunBranch(proof);
    try {
      const sync = await refusalOf(() => prOpen.openPullRequestChecked("", BRANCH, dir, "origin/main", syncRunner(bin)));
      const awaited = await refusalOf(() => prOpen.openPullRequestCheckedAsync("", BRANCH, dir, "origin/main", awaitedRunner(bin)));
      assert.deepEqual(awaited, sync, proof);
      if (proof.includes("FAIL")) assert.match(JSON.stringify(awaited), /proof did not pass against merge base.*verdict: fail/);
      if (proof.includes("SIGNAL")) assert.match(JSON.stringify(awaited), /proof did not pass against merge base \(grep: SIGNAL in note\.md\): exit SIGTERM/);
      if (proof.includes("PASS")) assert.equal(awaited, "opened");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("a proof child that cannot spawn refuses the awaited open as a branch gap, as the synchronous open does", async () => {
  const { dir } = filedRunBranch("grep: PASS in note.md");
  try {
    const missing = join(dir, "no-such-rmd");
    const sync = await refusalOf(() => prOpen.openPullRequestChecked("", BRANCH, dir, "origin/main", syncRunner(missing)));
    const awaited = await refusalOf(() => prOpen.openPullRequestCheckedAsync("", BRANCH, dir, "origin/main", awaitedRunner(missing)));
    for (const refusal of [sync, awaited]) {
      assert.notEqual(refusal, "opened");
      if (refusal === "opened") continue;
      assert.equal(refusal.refusalClass, "branch-gap");
      assert.match(refusal.message, /proof did not pass against merge base \(grep: PASS in note\.md\): .*ENOENT/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
