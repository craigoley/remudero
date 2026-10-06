// MEASURED 2026-10-06: the daemon opens a filed task's PR inside runTask, and the checked opener ran
// each acceptance proof through a synchronous `rmd check-proof` spawn. Over 17 h that held the
// daemon loop 1039 s across 36 daemon.loop_lag rows, up to 248 s at once. These tests pin the
// awaited runner, its bound, its result parity with the sync one, and the pre-run the opener reads.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  defaultProofRunner,
  defaultProofRunnerAsync,
  openPullRequestChecked,
  prerunPullRequestProofs,
  PrOpenRefusedError,
  type AsyncOpenPullRequestProofRunner,
} from "../src/lib/pr-open.js";
import { gitRepo } from "./helpers/git-repo.js";

/** A fake `rmd`: echoes its argv, writes to stderr, sleeps `RMD_FAKE_SLEEP_MS`, and exits 3 when
 *  the proof names FAIL. With RMD_FAKE_IGNORE_TERM it survives SIGTERM, so only SIGKILL ends it. */
function fakeRmd(dir: string): string {
  const bin = join(dir, "fake-rmd");
  writeFileSync(
    bin,
    [
      "#!/usr/bin/env node",
      "if (process.env.RMD_FAKE_IGNORE_TERM) process.on('SIGTERM', () => {});",
      "const ms = Number(process.env.RMD_FAKE_SLEEP_MS || 0);",
      "setTimeout(() => {",
      "  process.stdout.write('argv: ' + JSON.stringify(process.argv.slice(2)) + '\\n');",
      "  process.stderr.write('guard: ' + process.env.RMD_SELF_SYNC_GUARD + '\\n');",
      "  process.exit(process.argv[3].includes('FAIL') ? 3 : 0);",
      "}, ms);",
    ].join("\n"),
  );
  chmodSync(bin, 0o755);
  return bin;
}

function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  return fn().finally(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

/** A checkout with a filed plan and an origin/main a commit behind HEAD. */
function filedPlanFixture(proofs: string[]): { dir: string; base: string } {
  const repo = gitRepo({ kind: "proof-off-loop" });
  mkdirSync(join(repo.dir, "plan"));
  const plan = [
    "- id: W1-T9",
    "  title: fixture",
    "  repo: remudero",
    "  type: implement",
    "  acceptance:",
    ...proofs.flatMap((proof, i) => [`    - claim: claim ${i}`, `      proof: ${JSON.stringify(proof)}`]),
  ].join("\n");
  writeFileSync(join(repo.dir, "plan", "tasks.yaml"), `${plan}\n`);
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "chore: seed");
  const base = repo.git("rev-parse", "HEAD");
  repo.git("update-ref", "refs/remotes/origin/main", base);
  writeFileSync(join(repo.dir, "note.md"), "change\n");
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "feat: change");
  return { dir: repo.dir, base };
}

test("an awaited proof run leaves the event loop free to service a timer while it is pending", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-proof-async-"));
  try {
    const bin = fakeRmd(dir);
    let ticks = 0;
    const timer = setInterval(() => ticks++, 20);
    const result = await withEnv({ RMD_FAKE_SLEEP_MS: "600" }, () =>
      defaultProofRunnerAsync("grep: X in a.ts", "abc123", dir, undefined, { bin }),
    );
    clearInterval(timer);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.ok(ticks >= 10, `the loop serviced only ${ticks} timer ticks during a 600 ms proof run`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a proof run past its bound is killed and the PR open is refused naming the timeout", async () => {
  const { dir } = filedPlanFixture(["grep: SLOW in note.md"]);
  try {
    const bin = fakeRmd(dir);
    const started = Date.now();
    const runner = await withEnv({ RMD_FAKE_SLEEP_MS: "10000" }, () =>
      prerunPullRequestProofs("run-W1-T9-1", dir, "origin/main", undefined, (proof, base, root, target) =>
        defaultProofRunnerAsync(proof, base, root, target, { bin, timeoutMs: 200, graceMs: 100 }),
      ),
    );
    assert.ok(Date.now() - started < 5000, "the bound ended the run, not the child");
    assert.throws(
      () => openPullRequestChecked("", "run-W1-T9-1", dir, "origin/main", runner),
      (err: unknown) =>
        err instanceof PrOpenRefusedError &&
        err.refusalClass === "branch-gap" &&
        /rmd check-proof timed out after 200ms and was killed/.test(err.message),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a proof child that ignores SIGTERM at its bound is ended by SIGKILL", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-proof-kill-"));
  try {
    const bin = fakeRmd(dir);
    const result = await withEnv({ RMD_FAKE_SLEEP_MS: "10000", RMD_FAKE_IGNORE_TERM: "1" }, () =>
      defaultProofRunnerAsync("grep: X in a.ts", "abc123", dir, undefined, { bin, timeoutMs: 300, graceMs: 100 }),
    );
    assert.equal(result.status, null);
    assert.equal(result.signal, "SIGKILL");
    assert.match(result.error ?? "", /timed out after 300ms/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the awaited proof runner returns what the sync runner returns on the same inputs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-proof-parity-"));
  try {
    const bin = fakeRmd(dir);
    const target = { owner: "craigoley", repo: "remudero-console" };
    for (const proof of ["grep: PASS in a.ts", "grep: FAIL in a.ts"]) {
      const sync = defaultProofRunner(proof, "abc123", dir, target, bin);
      const awaited = await defaultProofRunnerAsync(proof, "abc123", dir, target, { bin });
      assert.deepEqual(awaited, sync, proof);
    }
    assert.equal(defaultProofRunner("grep: FAIL in a.ts", "abc123", dir, undefined, bin).status, 3, "control: the fail arm exits 3");
    const missing = join(dir, "no-such-rmd");
    const syncMissing = defaultProofRunner("grep: X in a.ts", "abc123", dir, undefined, missing);
    const awaitedMissing = await defaultProofRunnerAsync("grep: X in a.ts", "abc123", dir, undefined, { bin: missing });
    assert.equal(awaitedMissing.status, syncMissing.status);
    assert.match(syncMissing.error ?? "", /ENOENT/);
    assert.match(awaitedMissing.error ?? "", /ENOENT/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the proof pre-run stops at the first failing proof exactly where the sync open stops", async () => {
  const proofs = ["grep: ONE in note.md", "grep: FAIL in note.md", "grep: THREE in note.md"];
  const { dir, base } = filedPlanFixture(proofs);
  try {
    const ran: string[] = [];
    const recorder: AsyncOpenPullRequestProofRunner = async (proof, mergeBase) => {
      ran.push(proof);
      assert.equal(mergeBase, base);
      return proof.includes("FAIL") ? { status: 1, stdout: "verdict: fail", stderr: "" } : { status: 0, stdout: "verdict: pass", stderr: "" };
    };
    const runner = await prerunPullRequestProofs("run-W1-T9-1", dir, "origin/main", undefined, recorder);
    assert.deepEqual(ran, proofs.slice(0, 2), "the third proof is never run");
    const syncRan: string[] = [];
    const syncMessage = (() => {
      try {
        openPullRequestChecked("", "run-W1-T9-1", dir, "origin/main", (proof, mergeBase, root, target) => {
          syncRan.push(proof);
          return runner(proof, mergeBase, root, target);
        });
      } catch (err) {
        return (err as Error).message;
      }
      return "no refusal";
    })();
    assert.deepEqual(syncRan, ran, "the sync open asks for exactly the proofs the pre-run ran");
    assert.match(syncMessage, /proof did not pass against merge base \(grep: FAIL in note\.md\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the proof pre-run runs every proof of a passing branch and the open then passes", async () => {
  const { dir } = filedPlanFixture(["grep: ONE in note.md", "grep: TWO in note.md"]);
  try {
    const ran: string[] = [];
    const runner = await prerunPullRequestProofs("run-W1-T9-1", dir, "origin/main", undefined, async (proof) => {
      ran.push(proof);
      return { status: 0, stdout: "verdict: pass", stderr: "" };
    });
    assert.equal(ran.length, 2);
    assert.match(openPullRequestChecked("", "run-W1-T9-1", dir, "origin/main", runner), /^Remudero-Task: W1-T9$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the proof pre-run stops at an unrunnable proof and leaves the sync open to refuse it", async () => {
  const { dir } = filedPlanFixture(["grep: ONE in note.md", "a bare prose title", "grep: THREE in note.md"]);
  try {
    const ran: string[] = [];
    const runner = await prerunPullRequestProofs("run-W1-T9-1", dir, "origin/main", undefined, async (proof) => {
      ran.push(proof);
      return { status: 0, stdout: "", stderr: "" };
    });
    assert.deepEqual(ran, ["grep: ONE in note.md"]);
    assert.throws(() => openPullRequestChecked("", "run-W1-T9-1", dir, "origin/main", runner), /cannot execute: a bare prose title/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a proof the pre-run never ran is refused by name rather than run on the loop", async () => {
  const { dir } = filedPlanFixture(["grep: ONE in note.md"]);
  try {
    const runner = await prerunPullRequestProofs("not-a-run-branch", dir, "origin/main", undefined, async () => {
      throw new Error("a non-run branch must run no proofs");
    });
    assert.throws(
      () => openPullRequestChecked("", "run-W1-T9-1", dir, "origin/main", runner),
      /proof was not pre-run off the daemon loop \(grep: ONE in note\.md\)/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a plan refusal during the proof pre-run is left to the sync open and any other error propagates", async () => {
  const { dir } = filedPlanFixture(["grep: ONE in note.md"]);
  try {
    const never: AsyncOpenPullRequestProofRunner = async () => {
      throw new Error("no proof may run for an absent task");
    };
    const runner = await prerunPullRequestProofs("run-W1-T77-1", dir, "origin/main", undefined, never);
    assert.throws(() => openPullRequestChecked("", "run-W1-T77-1", dir, "origin/main", runner), /W1-T77, but that task is absent/);
    rmSync(join(dir, "plan"), { recursive: true, force: true });
    await assert.rejects(prerunPullRequestProofs("run-W1-T9-1", dir, "origin/main", undefined, never), (err: unknown) => !(err instanceof PrOpenRefusedError));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
