/**
 * W1-T9602 — A PUSH-GATE VERDICT ON A TREE IS REUSED, NOT RE-RUN, AND ONLY A VERDICT THE HARNESS OBSERVED ITSELF COUNTS.
 *
 * Real run worktrees (cut by the real `worktreeAdd`, so their pinned config enables the harness gate), a counting
 * fake harness pre-push under RMD_HARNESS_HOOKS_DIR, and a bare remote whose pre-receive can refuse a push after the
 * gate passed: the shape in which the identical key reaches the gate twice. The verdict store is a scratch dir
 * outside every worktree, and every ledger row is captured.
 *
 * FIXTURES ONLY: every repository, hook and store below is under this suite's own mkdtemp root.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";

import {
  auditThisReuse, dropPushGatePass, gateVerdictsDir, harnessRecipe, pushGateKeyDigest, recordPushGatePass, reusablePushGatePass, type PushGateKey,
} from "#src/lib/gate-verdict-record.js";
import {
  defaultPushGateVerdicts, gitPushRunBranchAsync, PUSH_GATE_AUDITED_STEP, PUSH_GATE_RAN_STEP, PUSH_GATE_REUSED_STEP,
  PUSH_GATE_UNRECORDED_STEP, PushFailedError, runPushGate, worktreePushExec, worktreePushExecAsync, gitPushRunBranch, type PushGateVerdicts,
} from "#src/lib/git-push.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import { preopenGateLedgerFields, renderPreopenGatePrompt, runPreopenGate } from "#src/lib/preopen-gate.js";
import { makeTempDir } from "#src/lib/tmp.js";
import { worktreeAdd } from "#src/lib/worker.js";
import { gitRepo, GIT_REPO_FIXTURE_IDENTITY } from "#test/helpers/git-repo.js";

let root: string;
let harnessHooks: string;
const savedHooksDir = process.env.RMD_HARNESS_HOOKS_DIR;
let counter = 0;

function script(path: string, body: string): void {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

before(() => {
  root = makeTempDir("w1-t9602");
  harnessHooks = join(root, "harness-hooks");
  mkdirSync(harnessHooks);
  process.env.RMD_HARNESS_HOOKS_DIR = harnessHooks;
});

after(() => {
  if (savedHooksDir === undefined) delete process.env.RMD_HARNESS_HOOKS_DIR;
  else process.env.RMD_HARNESS_HOOKS_DIR = savedHooksDir;
  rmSync(root, { recursive: true, force: true });
});

const fixtureGit = (wt: string, ...args: string[]) => {
  const r = spawnSync("git", ["-C", wt, "-c", "core.hooksPath=/dev/null", "-c", `user.email=${GIT_REPO_FIXTURE_IDENTITY.email}`,
    "-c", `user.name=${GIT_REPO_FIXTURE_IDENTITY.name}`, ...args], { encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

interface Lane {
  wt: string;
  remote: string;
  /** Counts each run of the harness hook. */
  runs: () => number;
  /** Lets the remote accept pushes again (each lane's remote starts refusing them, after the gate). */
  openRemote: () => void;
}

/** A run worktree with one commit, its remote refusing pushes in pre-receive, and a counting pre-push that exits `hookExit`. */
function lane(hookExit = 0): Lane {
  const n = ++counter;
  const remote = gitRepo({ bare: true, kind: `w1-t9602-remote-${n}` }).dir;
  const seed = gitRepo({ kind: `w1-t9602-seed-${n}` });
  seed.git("config", "user.email", GIT_REPO_FIXTURE_IDENTITY.email);
  seed.git("config", "user.name", GIT_REPO_FIXTURE_IDENTITY.name);
  writeFileSync(join(seed.dir, "README.md"), "seed\n");
  seed.git("add", "README.md");
  seed.git("commit", "-q", "-m", "chore: seed");
  seed.addRemote("origin", remote);
  seed.git("push", "-q", "origin", "main");
  const wt = join(root, `wt-${n}`);
  worktreeAdd(seed.dir, wt, `run-W1-T9602-${n}-1`, "origin/main", { readRemoteHead: () => seed.git("rev-parse", "HEAD"), warn: () => {} });
  writeFileSync(join(wt, "a.txt"), `${n}\n`);
  fixtureGit(wt, "add", "a.txt");
  fixtureGit(wt, "commit", "-q", "-m", "feat: a");
  script(join(remote, "hooks", "pre-receive"), "exit 1");
  const count = join(root, `hook-runs-${n}`);
  script(join(harnessHooks, "pre-push"), `cat >/dev/null; echo run >> "${count}"; exit ${hookExit}`);
  return {
    wt, remote,
    runs: () => (existsSync(count) ? readFileSync(count, "utf8").trim().split("\n").length : 0),
    openRemote: () => rmSync(join(remote, "hooks", "pre-receive")),
  };
}

type Row = { step: string; extra: Record<string, unknown> };
function store(recipe = "commit:recipe-1"): { verdicts: PushGateVerdicts; rows: Row[]; dir: string } {
  const rows: Row[] = [];
  const dir = join(root, `store-${++counter}`);
  let t = 1_000;
  const clock = { now: () => (t += 250), date: () => new Date(t), iso: () => new Date(t).toISOString() };
  return { dir, rows, verdicts: { dir, log: (step, extra) => rows.push({ step, extra }), recipe: () => recipe, audit: () => false, clock } };
}
const steps = (rows: Row[]) => rows.map((r) => r.step);

/** One push through the async leaf; resolves "pushed" or the refusal's message. */
async function push(wt: string, verdicts: PushGateVerdicts): Promise<string> {
  try {
    await withLiveWritesAllowed(() => gitPushRunBranchAsync(wt, { stdio: "ignore", exec: worktreePushExecAsync(wt, { verdicts }) }));
    return "pushed";
  } catch (error) {
    return String((error as Error).message);
  }
}

test("W1-T9602: a push of a tree the push gate already passed skips the hook", async () => {
  const l = lane();
  const s = store();
  // The gate passes; the remote then refuses the push itself, so the identical key comes back.
  assert.match(await push(l.wt, s.verdicts), /pre-receive hook declined/);
  assert.equal(l.runs(), 1);
  assert.deepEqual(steps(s.rows), [PUSH_GATE_RAN_STEP]);
  assert.equal(s.rows[0]!.extra.result, "pass");
  assert.equal(readdirSync(s.dir).filter((f) => f.endsWith(".json")).length, 1, "the pass is recorded");
  l.openRemote();
  assert.equal(await push(l.wt, s.verdicts), "pushed");
  assert.equal(l.runs(), 1, "the second push of the identical key ran no hook");
  const reused = s.rows.find((r) => r.step === PUSH_GATE_REUSED_STEP)!;
  assert.ok(reused, JSON.stringify(s.rows));
  assert.equal(reused.extra.tree, s.rows[0]!.extra.tree);
  assert.equal(reused.extra.observed_by, "worktreePushExecAsync", "the reuse names the harness function that observed the pass");
  assert.equal(reused.extra.saved_ms, s.rows[0]!.extra.duration_ms, "the reuse ledgers the seconds it saved");
  assert.equal(typeof reused.extra.record_ts, "string");
  // The sync leaf reads the same store.
  const sync = lane();
  const s2 = store();
  assert.throws(() => withLiveWritesAllowed(() => gitPushRunBranch(sync.wt, { stdio: "ignore", exec: worktreePushExec(sync.wt, { verdicts: s2.verdicts }) })), PushFailedError);
  sync.openRemote();
  withLiveWritesAllowed(() => gitPushRunBranch(sync.wt, { stdio: "ignore", exec: worktreePushExec(sync.wt, { verdicts: s2.verdicts }) }));
  assert.equal(sync.runs(), 1);
  assert.deepEqual(steps(s2.rows), [PUSH_GATE_RAN_STEP, PUSH_GATE_REUSED_STEP]);
});

test("W1-T9602: a changed key runs the push gate again", async () => {
  const l = lane();
  const s = store();
  await push(l.wt, s.verdicts);
  assert.equal(l.runs(), 1);
  // Same tree, new head: a reworded commit.
  fixtureGit(l.wt, "commit", "-q", "--amend", "-m", "feat: a, reworded");
  await push(l.wt, s.verdicts);
  assert.equal(l.runs(), 2, "a new head runs the gate");
  // A new tree.
  writeFileSync(join(l.wt, "b.txt"), "b\n");
  fixtureGit(l.wt, "add", "b.txt");
  fixtureGit(l.wt, "commit", "-q", "-m", "feat: b");
  await push(l.wt, s.verdicts);
  assert.equal(l.runs(), 3, "a new tree runs the gate");
  // The same tree and head under a moved base.
  await push(l.wt, s.verdicts);
  assert.equal(l.runs(), 3, "control: unchanged, it is reused");
  fixtureGit(l.wt, "update-ref", "refs/remotes/origin/main", fixtureGit(l.wt, "rev-parse", "HEAD~1"));
  await push(l.wt, s.verdicts);
  assert.equal(l.runs(), 4, "a moved base runs the gate");
  // A changed harness recipe.
  await push(l.wt, { ...s.verdicts, recipe: () => "commit:recipe-2" });
  assert.equal(l.runs(), 5, "a changed hook or script runs the gate");
  // Every key field, one at a time, misses the record (the remote sha included).
  const dir = join(root, `keys-${++counter}`);
  const key: PushGateKey = { tree: "t", head: "h", base: "b", localRef: "refs/heads/x", localSha: "h", remoteRef: "refs/heads/x", remoteSha: "0", recipe: "r" };
  recordPushGatePass(dir, key, l.wt, { durationMs: 5, observedBy: "test", liveTrees: undefined, ts: "2026-10-15T00:00:00.000Z" });
  assert.equal(reusablePushGatePass(dir, key, l.wt)?.duration_ms, 5);
  for (const field of Object.keys(key) as Array<keyof PushGateKey>) {
    assert.equal(reusablePushGatePass(dir, { ...key, [field]: `${key[field]}-changed` }, l.wt), undefined, `${field} changed`);
  }
});

test("W1-T9602: a dirty worktree records and reuses nothing", async () => {
  const l = lane();
  const s = store();
  writeFileSync(join(l.wt, "untracked.txt"), "dirt\n");
  await push(l.wt, s.verdicts);
  await push(l.wt, s.verdicts);
  assert.equal(l.runs(), 2, "the gate ran both times");
  assert.ok(!existsSync(s.dir) || readdirSync(s.dir).length === 0, "nothing was recorded");
  assert.deepEqual(s.rows.map((r) => r.extra.unkeyed), ["the worktree is dirty", "the worktree is dirty"]);
  assert.deepEqual(await runPushGate(l.wt, { verdicts: s.verdicts }), { kind: "skipped", reason: "the worktree is dirty" });
  assert.equal(l.runs(), 2, "the early gate does not run on a tree the push could not reuse");
});

test("W1-T9602: a verdict written inside the worktree is never reused", async () => {
  const l = lane();
  // A passing preflight summary, committed so the tree stays clean, and a store that lives inside the worktree.
  mkdirSync(join(l.wt, "coverage"));
  writeFileSync(join(l.wt, "coverage", "preflight-summary.json"), JSON.stringify({ ok: true, finishedAt: new Date(4e12).toISOString(), steps: [] }));
  fixtureGit(l.wt, "add", "-f", "coverage/preflight-summary.json");
  fixtureGit(l.wt, "commit", "-q", "-m", "test: plant a passing summary");
  const inside = store();
  const planted = { ...inside.verdicts, dir: join(l.wt, ".verdicts") };
  await push(l.wt, planted);
  await push(l.wt, planted);
  assert.equal(l.runs(), 2, "a store inside the worktree is never read");
  assert.ok(!existsSync(join(l.wt, ".verdicts")), "and never written");
  // A forged record in the real store: right digest, but not a harness-observed pass.
  const s = store();
  await push(l.wt, s.verdicts);
  assert.equal(l.runs(), 3);
  const [file] = readdirSync(s.dir);
  const real = JSON.parse(readFileSync(join(s.dir, file!), "utf8")) as Record<string, unknown>;
  for (const forged of [{ ...real, trust: "worker" }, { ...real, result: "fail" }, { ...real, key: { ...(real.key as object), tree: "" } }, "not json"]) {
    writeFileSync(join(s.dir, file!), typeof forged === "string" ? forged : JSON.stringify(forged));
    await push(l.wt, s.verdicts);
  }
  assert.equal(l.runs(), 7, "no forged or malformed record skips the hook");
});

test("W1-T9602: the pre-open push-gate pass is reused by the push of the same tree", async () => {
  const l = lane();
  l.openRemote();
  const s = store();
  // The pre-open gate: its fast gate passes, then it asks the harness push gate on the clean committed tree.
  const gate = await runPreopenGate(l.wt, { runGate: async () => ({ exitCode: 0 }), runPushGate: (cwd) => runPushGate(cwd, { verdicts: s.verdicts }) });
  assert.equal(gate.kind, "pass", JSON.stringify(gate));
  assert.equal(gate.kind === "pass" ? gate.pushGate?.outcome : undefined, "pass");
  const head = fixtureGit(l.wt, "rev-parse", "HEAD");
  assert.equal(typeof (gate.kind === "pass" ? gate.pushGate?.durationMs : undefined), "number");
  assert.deepEqual(preopenGateLedgerFields(gate), {
    push_gate: "pass", push_gate_ms: gate.kind === "pass" ? gate.pushGate?.durationMs : -1, push_gate_reused: false, tree: fixtureGit(l.wt, "rev-parse", "HEAD^{tree}"), head,
    base: fixtureGit(l.wt, "rev-parse", "origin/main"), recipe: "commit:recipe-1",
  }, "implement.preopen_gate names the tree, head, base and recipe it keyed");
  assert.equal(l.runs(), 1);
  assert.equal(s.rows[0]!.extra.observed_by, "runPushGate");
  assert.equal(await push(l.wt, s.verdicts), "pushed");
  assert.equal(l.runs(), 1, "the push reused the early pass");
  assert.equal(s.rows.at(-1)!.step, PUSH_GATE_REUSED_STEP);
  // A refusing push gate is handed to the worker as push-gate, with the hook's own words, and nothing is recorded.
  const red = lane(3);
  script(join(harnessHooks, "pre-push"), `cat >/dev/null; echo "census-precheck: grows clock-signature" >&2; exit 3`);
  const s2 = store();
  const refused = await runPreopenGate(red.wt, { runGate: async () => ({ exitCode: 1, summary: { failedSteps: ["jscpd"] } }), runPushGate: (cwd) => runPushGate(cwd, { verdicts: s2.verdicts }) });
  assert.equal(refused.kind, "fail");
  const steps = refused.kind === "fail" ? refused.failedSteps : [];
  assert.equal(steps[0], "jscpd");
  assert.match(steps[1] ?? "", /^push-gate: exit 3: census-precheck: grows clock-signature/);
  assert.match(renderPreopenGatePrompt(steps, true), /- push-gate: exit 3/);
  assert.ok(!existsSync(s2.dir) || readdirSync(s2.dir).length === 0);
  // An unmeasured fast gate asks no push gate.
  let asked = 0;
  const unmeasured = await runPreopenGate(red.wt, { runGate: async () => ({ exitCode: null, error: "fast gate exceeded its backstop" }), runPushGate: async () => { asked += 1; return { kind: "skipped", reason: "x" }; } });
  assert.equal(unmeasured.kind, "unmeasured");
  assert.equal(asked, 0);
  // The default runner, for real: outside the daemon there is no store, so it is skipped and says why.
  const byDefault = await runPreopenGate(red.wt, { runGate: async () => ({ exitCode: 0 }) });
  const skippedGate = byDefault.kind === "pass" ? byDefault.pushGate : undefined;
  assert.deepEqual(skippedGate && { ...skippedGate, durationMs: 0 }, { outcome: "skipped", durationMs: 0, reason: "no verdict store outside the daemon" });
  assert.deepEqual(preopenGateLedgerFields(byDefault), { push_gate: "skipped", push_gate_ms: skippedGate?.durationMs, push_gate_reason: "no verdict store outside the daemon" });
});

test("W1-T9602: an audited reuse runs the hook and ledgers agreement; a disagreement drops the record", async () => {
  const l = lane();
  const s = store();
  await push(l.wt, s.verdicts);
  await push(l.wt, { ...s.verdicts, audit: () => true });
  assert.equal(l.runs(), 2, "the audit re-ran the hook");
  assert.equal(s.rows.find((r) => r.step === PUSH_GATE_AUDITED_STEP)?.extra.agreement, "agree");
  script(join(harnessHooks, "pre-push"), "cat >/dev/null; exit 5");
  assert.match(await push(l.wt, { ...s.verdicts, audit: () => true }), /refused this push \(exit 5\)/);
  assert.equal(s.rows.filter((r) => r.step === PUSH_GATE_AUDITED_STEP).at(-1)?.extra.agreement, "disagree");
  assert.equal(readdirSync(s.dir).filter((f) => f.endsWith(".json")).length, 0, "the disagreed record is gone");
  assert.match(await push(l.wt, s.verdicts), /exit 5/, "so the next push runs the hook, and its refusal stands");
  // The default sampler: one in N, and N = 0 audits nothing (the operator's off switch).
  assert.equal(auditThisReuse(0, () => 0), false);
  assert.equal(auditThisReuse(10, () => 0), true);
  assert.equal(auditThisReuse(10, () => 3), false);
  assert.equal(typeof auditThisReuse(), "boolean");
});

test("W1-T9602: retention keeps only records whose tree a registered worktree holds", async () => {
  const a = lane();
  const b = lane();
  const s = store();
  await push(a.wt, s.verdicts);
  const dir = s.dir;
  const stale: PushGateKey = { tree: "0".repeat(40), head: "h", base: "b", localRef: "l", localSha: "h", remoteRef: "r", remoteSha: "0", recipe: "x" };
  recordPushGatePass(dir, stale, a.wt, { durationMs: 1, observedBy: "test", liveTrees: undefined, ts: "2026-10-15T00:00:00.000Z" });
  writeFileSync(join(dir, "garbage.json"), "{");
  assert.equal(readdirSync(dir).length, 3);
  await push(a.wt, { ...s.verdicts, recipe: () => "commit:recipe-3" });
  const kept = readdirSync(dir).sort();
  assert.equal(kept.length, 2, `the stale and unreadable records are dropped: ${kept.join(",")}`);
  assert.ok(!kept.includes(`${pushGateKeyDigest(stale)}.json`) && !kept.includes("garbage.json"));
  // A store that cannot be written costs only the record, never the push's verdict.
  const blocked = store();
  writeFileSync(blocked.dir, "a file where the store's directory belongs");
  await push(b.wt, blocked.verdicts);
  assert.equal(blocked.rows.at(-1)!.step, PUSH_GATE_UNRECORDED_STEP);
  assert.equal(blocked.rows.at(-2)!.extra.result, "pass");
  dropPushGatePass(dir, stale);
});

test("W1-T9602: the store is the daemon's alone, and an unreadable recipe or key reuses nothing", async () => {
  assert.equal(defaultPushGateVerdicts({ daemon: false }), undefined, "outside the daemon there is no store");
  assert.equal(defaultPushGateVerdicts(), undefined, "a test process is never the daemon");
  const cfgRoot = join(root, "cfg");
  const daemon = defaultPushGateVerdicts({ daemon: true, config: () => ({ root: cfgRoot }) })!;
  assert.equal(daemon.dir, gateVerdictsDir(join(cfgRoot, "state")));
  assert.equal(daemon.recipe(), undefined, "a hooks dir outside any checkout has no recipe, so nothing is reused");
  delete process.env.RMD_HARNESS_HOOKS_DIR;
  try {
    assert.match(daemon.recipe() ?? "", /^commit:[0-9a-f]{40}/, "the recipe is this checkout's own HEAD commit");
  } finally {
    process.env.RMD_HARNESS_HOOKS_DIR = harnessHooks;
  }
  mkdirSync(join(cfgRoot, "state"), { recursive: true });
  daemon.log("push_gate.test", { ok: 1 });
  assert.match(readFileSync(join(cfgRoot, "state", "ledger.ndjson"), "utf8"), /"step":"push_gate\.test"/);
  rmSync(join(cfgRoot, "state"), { recursive: true });
  writeFileSync(join(cfgRoot, "state"), "not a dir");
  daemon.log("push_gate.test", { ok: 2 }); // an unwritable ledger is noted, never thrown
  assert.equal(defaultPushGateVerdicts({ daemon: true, config: () => { throw new Error("no config"); } }), undefined);
  assert.deepEqual(await runPushGate(join(root, "not-a-worktree")), { kind: "skipped", reason: "no verdict store outside the daemon" });
  const s = store();
  assert.match((await runPushGate(join(root, "not-a-worktree"), { verdicts: s.verdicts })).kind, /^skipped$/);
  const l = lane();
  const noRecipe = store();
  await push(l.wt, { ...noRecipe.verdicts, recipe: () => undefined });
  await push(l.wt, { ...noRecipe.verdicts, recipe: () => undefined });
  assert.equal(l.runs(), 2);
  assert.equal(noRecipe.rows[0]!.extra.unkeyed, "the harness recipe is unreadable");
  assert.deepEqual(await runPushGate(l.wt, { verdicts: { ...noRecipe.verdicts, recipe: () => undefined } }), { kind: "skipped", reason: "the harness recipe is unreadable" });
});

test("W1-T9602: the recipe reader follows a git dir, a linked worktree's pointer, loose and packed refs", () => {
  const files = new Map<string, string>();
  const read = (p: string) => {
    if (p === "/h/.git") throw Object.assign(new Error("EISDIR"), { code: "EISDIR" });
    const v = files.get(p);
    if (v === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return v;
  };
  const sha = "a".repeat(40);
  files.set("/h/.git/HEAD", `${sha}\n`);
  assert.equal(harnessRecipe("/h", read), `commit:${sha}`);
  files.set("/h/.git/HEAD", "ref: refs/heads/main\n");
  files.set("/h/.git/refs/heads/main", `${"b".repeat(40)}\n`);
  assert.equal(harnessRecipe("/h", read), `commit:${"b".repeat(40)}`);
  files.delete("/h/.git/refs/heads/main");
  files.set("/h/.git/packed-refs", `# pack-refs\n${"c".repeat(40)} refs/heads/main\n`);
  assert.equal(harnessRecipe("/h", read), `commit:${"c".repeat(40)}`);
  files.set("/w/.git", "gitdir: /repo/.git/worktrees/w\n");
  files.set("/repo/.git/worktrees/w/HEAD", "ref: refs/heads/run\n");
  files.set("/repo/.git/worktrees/w/commondir", "../..\n");
  files.set("/repo/.git/refs/heads/run", `${"d".repeat(40)}\n`);
  assert.equal(harnessRecipe("/w", read), `commit:${"d".repeat(40)}`);
  files.set("/x/.git", "not a pointer\n");
  assert.equal(harnessRecipe("/x", read), undefined);
  assert.equal(harnessRecipe("/absent", read), undefined);
  files.set("/y/.git", "gitdir: /nowhere\n");
  assert.equal(harnessRecipe("/y", read), undefined, "a pointer whose HEAD cannot be read");
  files.set("/h/.git/HEAD", "garbage\n");
  assert.equal(harnessRecipe("/h", read), undefined);
  files.set("/h/.git/HEAD", "ref: refs/heads/gone\n");
  assert.equal(harnessRecipe("/h", read), undefined);
  assert.equal(harnessRecipe("/h", () => { throw Object.assign(new Error("EACCES"), { code: "EACCES" }); }), undefined);
});
