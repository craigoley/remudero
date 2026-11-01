// test/an-armed-stale-held-branch-is-archived-and-deleted-in-one-leased-push.test.ts
//
// Operator ruling 2026-11-01: "Build act mode, flag off". The repo-hygiene shadow names stale held run
// branches; act mode, armed only by `sweep.armStaleBranchArchive`, archives each tip under
// refs/rmd-recovery/reaped/<name>/<sha> and deletes the branch in ONE atomic push leased on that sha, so
// both happen or neither does, and nothing happens if the branch moved.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  archiveStaleHoldsSteps, STALE_HOLD_ARCHIVE_CAP, staleHoldRestoreCommand, type StaleHoldCandidate,
} from "#src/lib/branch-reaper.js";
import { runStepsSync } from "#src/lib/git-push.js";
import { gitRepo } from "./helpers/git-repo.js";
import { REPO_ROOT } from "./helpers/repo-root.js";
import { loadPolicy } from "#src/lib/policy.js";
import { reapBranchesCommand } from "#src/run-task.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const NOW = Date.parse("2026-11-01T13:00:00Z");
const DAY = 86_400_000;
const BRANCH = "run-W1-T5-1700000000000";
const SHA = "b2b2b2";
const ATOMIC_PUSH = ["git", "push", "--atomic", `--force-with-lease=refs/heads/${BRANCH}:${SHA}`, "origin",
  `${SHA}:refs/rmd-recovery/reaped/${BRANCH}/${SHA}`, `:refs/heads/${BRANCH}`];

/** One reap pass over a corpus holding one stale unshipped run branch (30 days, no PR, tip not in main). */
function pass(rest: string[], opts: { armed?: boolean; root?: string; pushFails?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}reap-act-`));
  const ledgerPath = join(dir, "ledger.ndjson");
  const calls: string[][] = [];
  const exec = (cmd: string, args: string[]): string => {
    calls.push([cmd, ...args]);
    if (args[0] === "ls-remote") return args.includes("refs/rmd-dispatch/*") ? "" : `a1\trefs/heads/main\n${SHA}\trefs/heads/${BRANCH}\n`;
    if (args[0] === "for-each-ref") return args.includes("--merged=origin/main") ? "origin/main\n" : `origin/main\ta1\t1\norigin/${BRANCH}\t${SHA}\t${Math.floor((NOW - 30 * DAY) / 1000)}\n`;
    if (args[0] === "merge-base") throw new Error("not an ancestor");
    if (args[0] === "rev-parse") return `${SHA}\n`;
    if (args[0] === "grep") throw Object.assign(new Error("exit 1"), { status: 1 });
    if (args[0] === "push" && opts.pushFails) throw new Error("! [rejected] (stale info)");
    return "";
  };
  const out: string[] = [];
  const realLog = console.log;
  const realErr = console.error;
  console.log = (...a: unknown[]) => { out.push(a.join(" ")); };
  console.error = (...a: unknown[]) => { out.push(a.join(" ")); };
  try {
    reapBranchesCommand(rest, { exec, ledgerPath, clock: { now: () => NOW }, loadPlan: () => ({ tasks: [{ id: "W1-T5" }] }) as never,
      ...(opts.root ? { root: opts.root } : {}), ...(opts.armed !== undefined ? { armStaleBranchArchive: opts.armed } : {}) });
  } finally {
    console.log = realLog;
    console.error = realErr;
  }
  const rows = readFileSync(ledgerPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  rmSync(dir, { recursive: true, force: true });
  return {
    archived: rows.find((r) => r.step === "branch_reap.hygiene_archived"),
    shadow: rows.find((r) => r.step === "branch_reap.hygiene_shadow"),
    pushes: calls.filter((c) => c[1] === "push"),
    out,
  };
}

test("armed, a stale held branch is archived and deleted in ONE atomic push leased on its sha", () => {
  const { archived, shadow, pushes, out } = pass(["--archive-stale"], { armed: true });
  assert.deepEqual(pushes, [ATOMIC_PUSH]);
  assert.equal(archived?.mode, "act");
  assert.deepEqual(archived.archived, [{ name: BRANCH, sha: SHA, reason: "orphan_unshipped_stale",
    archive_ref: `refs/rmd-recovery/reaped/${BRANCH}/${SHA}` }]);
  assert.deepEqual(archived.failed, []);
  assert.equal(archived.capped, 0);
  assert.equal(archived.restore, "git fetch origin refs/rmd-recovery/reaped/<name>/<sha>:refs/rmd-recovery/reaped/<name>/<sha> && git push origin refs/rmd-recovery/reaped/<name>/<sha>:refs/heads/<name>");
  assert.equal(shadow, undefined, "act mode replaces the shadow row");
  const ref = `refs/rmd-recovery/reaped/${BRANCH}/${SHA}`;
  assert.ok(out.includes(`  restore: git fetch origin ${ref}:${ref} && git push origin ${ref}:refs/heads/${BRANCH}`));
});

test("unarmed, the stale held branch is only ledgered in shadow and nothing is pushed", () => {
  for (const run of [pass(["--archive-stale"], { armed: false }), pass([], { armed: true })]) {
    assert.deepEqual(run.pushes, []);
    assert.equal(run.archived, undefined);
    assert.equal(run.shadow?.mode, "shadow");
    assert.equal(run.shadow.would_reap, 1);
  }
});

test("a failed archive push is ledgered as failed and its branch is kept", () => {
  const { archived, pushes } = pass(["--archive-stale"], { armed: true, pushFails: true });
  assert.deepEqual(pushes, [ATOMIC_PUSH]);
  assert.deepEqual(archived.archived, []);
  assert.equal(archived.failed.length, 1);
  assert.equal(archived.failed[0].name, BRANCH);
  assert.match(archived.failed[0].error, /rejected/);
});

test("the stale-hold archive cap holds: 25 pushes per pass and the rest counted as capped", () => {
  assert.equal(STALE_HOLD_ARCHIVE_CAP, 25);
  const candidates: StaleHoldCandidate[] = Array.from({ length: 30 }, (_, i) =>
    ({ name: `run-W1-T${i}-1`, sha: `s${i}`, reason: "credited_sibling_stale", ageMs: 8 * DAY, taskId: `W1-T${i}` }));
  const pushes: string[][] = [];
  const outcome = runStepsSync(archiveStaleHoldsSteps(candidates, (_cmd, args) => { pushes.push(args); return ""; }));
  assert.equal(pushes.length, 25);
  assert.equal(outcome.archived.length, 25);
  assert.equal(outcome.capped, 5);
  assert.deepEqual(outcome.archived.map((a) => a.name), candidates.slice(0, 25).map((c) => c.name));
});

test("the policy default for sweep.armStaleBranchArchive is false, read from the checkout's policy", () => {
  const policy = loadPolicy(join(REPO_ROOT, "plan", "policy.yaml"));
  assert.equal(policy.values.sweep.armStaleBranchArchive, false);
  assert.equal(policy.origin["sweep.armStaleBranchArchive"]?.kind, "net-new");
  // The REAL default seam: no override, so the arm is read from <root>/plan/policy.yaml.
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}reap-act-policy-`));
  try {
    mkdirSync(join(root, "plan"));
    const yaml = readFileSync(join(REPO_ROOT, "plan", "policy.yaml"), "utf8");
    writeFileSync(join(root, "plan", "policy.yaml"), yaml);
    assert.deepEqual(pass(["--archive-stale"], { root }).pushes, [], "the committed row (false) leaves it in shadow");
    const armedYaml = yaml.replace(/(armStaleBranchArchive:\n\s+value: )false/, "$1true");
    assert.notEqual(armedYaml, yaml);
    writeFileSync(join(root, "plan", "policy.yaml"), armedYaml);
    assert.deepEqual(pass(["--archive-stale"], { root }).pushes, [ATOMIC_PUSH], "flipping the row arms it");
    rmSync(join(root, "plan", "policy.yaml"));
    const unreadable = pass(["--archive-stale"], { root });
    assert.deepEqual(unreadable.pushes, [], "an unreadable policy fails closed to shadow");
    assert.ok(unreadable.out.some((l) => l.includes("plan/policy.yaml could not be read")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("against a real remote, the leased atomic push archives and deletes together, refuses a moved branch, and restores", () => {
  const origin = gitRepo({ bare: true, kind: "reap-act-origin" });
  const work = gitRepo({ kind: "reap-act-work" });
  try {
    work.addRemote("origin", origin.dir);
    work.git("push", "-q", "origin", "HEAD:refs/heads/main");
    for (const b of ["run-W1-T1-1", "run-W1-T2-2"]) {
      work.git("commit", "-q", "--allow-empty", "-m", b);
      work.git("push", "-q", "origin", `HEAD:refs/heads/${b}`);
    }
    const sha1 = origin.git("rev-parse", "refs/heads/run-W1-T1-1");
    const staleSha2 = origin.git("rev-parse", "refs/heads/run-W1-T2-2");
    // run-W1-T2-2 gains a commit after the planner read it: the lease must refuse it.
    work.git("commit", "-q", "--allow-empty", "-m", "new work");
    work.git("push", "-q", "origin", "HEAD:refs/heads/run-W1-T2-2");
    const movedSha2 = origin.git("rev-parse", "refs/heads/run-W1-T2-2");
    work.git("fetch", "-q", "origin");
    const exec = (cmd: string, args: string[]) => {
      assert.equal(cmd, "git");
      return work.git(...args);
    };
    const c = (name: string, sha: string): StaleHoldCandidate => ({ name, sha, reason: "credited_sibling_stale", ageMs: 8 * DAY, taskId: "W1-T1" });
    const outcome = runStepsSync(archiveStaleHoldsSteps([c("run-W1-T1-1", sha1), c("run-W1-T2-2", staleSha2)], exec));
    assert.deepEqual(outcome.archived.map((a) => a.name), ["run-W1-T1-1"]);
    assert.deepEqual(outcome.failed.map((f) => f.name), ["run-W1-T2-2"]);
    const refs = origin.git("for-each-ref", "--format=%(refname) %(objectname)");
    assert.ok(!refs.includes("refs/heads/run-W1-T1-1 "), "the archived branch is deleted");
    assert.ok(refs.includes(`refs/rmd-recovery/reaped/run-W1-T1-1/${sha1} ${sha1}`), "its tip is archived");
    assert.ok(refs.includes(`refs/heads/run-W1-T2-2 ${movedSha2}`), "the moved branch is untouched");
    assert.ok(!refs.includes("refs/rmd-recovery/reaped/run-W1-T2-2/"), "and nothing of it is archived");
    // The documented restore line, run as written from the reaping clone (which never had the archive ref).
    const restore = staleHoldRestoreCommand("run-W1-T1-1", sha1).split(" && ").map((cmd) => cmd.split(" "));
    assert.deepEqual(restore.map((argv) => argv.slice(0, 2)), [["git", "fetch"], ["git", "push"]]);
    for (const argv of restore) work.git(...argv.slice(1));
    assert.equal(origin.git("rev-parse", "refs/heads/run-W1-T1-1"), sha1);
  } finally {
    work.cleanup();
    origin.cleanup();
  }
});
