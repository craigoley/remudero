// test/the-per-poll-landing-awaits-its-local-git-verbs.test.ts — W1-T9638.
//
// W1-T5672 awaited only the per-poll landing's network verbs. Every LOCAL git verb in its reach — the dirty scan,
// both acknowledgements, the carried-forward staging (2-4 children per path the landing branch carries), the
// scratch-index build, the commit — still ran as execFileSync on the daemon loop: up to 727 children and 24.6 s
// in one 98 s lag window on 2026-10-15. `sweepFeedbackLandingAsync` now yields every git verb to its driver, which
// awaits each child, and the sync driver (boot sweep, CLI) runs the same steps inline.
//
// THE OBSERVATION is event-loop turns, never a wall-clock bound: a `git` on PATH marks itself in flight and waits for a
// 10 ms interval in the daemon's process to acknowledge it (giving up after about half a second) before it runs the
// real git. A child the loop waits on synchronously is never acknowledged — the timer cannot run until it has exited.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";

import { LANDING_BRANCH, landFeedbackStatusContent, sweepFeedbackLanding, sweepFeedbackLandingAsync } from "#src/lib/feedback-landing.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import type { PlanPrPreflightResult } from "#src/lib/plan-pr-emitter.js";
import { gitRepo } from "#test/helpers/git-repo.js";

const GREEN: PlanPrPreflightResult = { ok: true, failures: [], unreadable: [] };
const PR_URL = "https://github.com/o/r/pull/9638";
const FB = "plan/feedback";

type Row = { step: string } & Record<string, unknown>;

/**
 * A bare origin whose main holds three records (one carrying lineage), a landing branch that already carries two
 * pending records and that lineage record advanced to `grilling`, and a clone of it holding a dirty local record,
 * an untracked copy of a record main gained after the clone, and one record queued under the daemon state root.
 */
function fixture(nonce: string) {
  const seed = gitRepo({ kind: `w9638-${nonce}-seed` });
  const origin = gitRepo({ bare: true, kind: `w9638-${nonce}-origin` });
  seed.addRemote("origin", origin.dir);
  mkdirSync(join(seed.dir, FB), { recursive: true });
  writeFileSync(join(seed.dir, FB, "fb-main-0.yaml"), "id: fb-main-0\nstatus: new\ncontribution:\n  kind: test\nraw: zero\n");
  writeFileSync(join(seed.dir, FB, "fb-main-1.yaml"), "id: fb-main-1\nstatus: new\nraw: one\n");
  seed.git("add", "-A");
  seed.git("commit", "--quiet", "-m", "main records");
  seed.git("push", "--quiet", "origin", "HEAD:main");

  seed.git("checkout", "--quiet", "-b", "pending");
  for (const id of ["fb-pend-0", "fb-pend-1"]) writeFileSync(join(seed.dir, FB, `${id}.yaml`), `id: ${id}\nstatus: new\nraw: ${id}\n`);
  writeFileSync(join(seed.dir, FB, "fb-main-0.yaml"), "id: fb-main-0\nstatus: grilling\ncontribution:\n  kind: test\nraw: zero\n");
  seed.git("add", "-A");
  seed.git("commit", "--quiet", "-m", "pending records");
  seed.git("push", "--quiet", "origin", `HEAD:refs/heads/${LANDING_BRANCH}`);

  const clone = gitRepo({ cloneFrom: origin.dir, kind: `w9638-${nonce}-clone` });

  seed.git("checkout", "--quiet", "main");
  const lateRecord = "id: fb-main-2\nstatus: new\nraw: two\n";
  writeFileSync(join(seed.dir, FB, "fb-main-2.yaml"), lateRecord);
  seed.git("add", "-A");
  seed.git("commit", "--quiet", "-m", "a record main gained after the clone");
  seed.git("push", "--quiet", "origin", "HEAD:main");

  writeFileSync(join(clone.dir, FB, "fb-main-2.yaml"), lateRecord);
  writeFileSync(join(clone.dir, FB, "fb-local.yaml"), "id: fb-local\nstatus: new\nraw: local\n");
  const stateRoot = mkdtempSync(join(tmpdir(), `rmd-w9638-${nonce}-state-`));
  const queued = landFeedbackStatusContent(clone.dir, `${FB}/fb-queued.yaml`, "id: fb-queued\nstatus: new\nraw: queued\n", { stateRoot });
  assert.deepEqual(queued.queued, [`${FB}/fb-queued.yaml`], JSON.stringify(queued));

  const ghCalls: string[][] = [];
  const gh = (args: string[]): string => {
    ghCalls.push(args);
    if (args[0] === "pr" && args[1] === "list") return "[]";
    if (args[0] === "pr" && args[1] === "create") return `${PR_URL}\n`;
    throw new Error(`unexpected gh call: ${JSON.stringify(args)}`);
  };
  const rows: Row[] = [];
  const log = (step: string, extra: Record<string, unknown> = {}): void => {
    rows.push({ step, ...extra });
  };
  const landedTree = (): string => origin.git("rev-parse", `refs/heads/${LANDING_BRANCH}^{tree}`);
  const landedFiles = (): string[] =>
    origin.git("ls-tree", "-r", "--name-only", `refs/heads/${LANDING_BRANCH}`).split("\n").filter((p) => p.startsWith(`${FB}/`));
  return { clone, origin, stateRoot, gh, ghCalls, log, rows, landedTree, landedFiles };
}

/** Where the real `git` lives on this PATH — the shim below runs it after marking itself in flight. */
function realGit(): string {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir && existsSync(join(dir, "git"))) return join(dir, "git");
  }
  throw new Error("no git on PATH");
}

/**
 * A `git` that marks itself in flight (a file named for its pid) and polls for an acknowledgement for up to 50 x 10 ms,
 * then logs whether it got one and runs the real git. Put first on PATH, every child the landing spawns by name runs
 * through it; {@link acknowledge}, called from a timer, answers each child it finds in flight.
 */
function slowGitShim(): { binDir: string; acknowledge: () => void; outcomes: () => string[] } {
  const root = mkdtempSync(join(tmpdir(), "rmd-w9638-shim-"));
  const binDir = join(root, "bin");
  const marks = join(root, "marks");
  mkdirSync(binDir);
  mkdirSync(marks);
  const done = join(root, "done.log");
  writeFileSync(
    join(binDir, "git"),
    [
      "#!/bin/sh",
      `: > "${marks}/$$"`,
      "i=0",
      `while [ ! -e "${marks}/$$.seen" ] && [ "$i" -lt 50 ]; do sleep 0.01; i=$((i + 1)); done`,
      `if [ -e "${marks}/$$.seen" ]; then echo "$$ seen $1 $2 $3" >> "${done}"; else echo "$$ held $1 $2 $3" >> "${done}"; fi`,
      `rm -f "${marks}/$$"`,
      `exec "${realGit()}" "$@"`,
      "",
    ].join("\n"),
  );
  chmodSync(join(binDir, "git"), 0o755);
  return {
    binDir,
    acknowledge: () => {
      for (const name of readdirSync(marks)) if (!name.endsWith(".seen")) writeFileSync(join(marks, `${name}.seen`), "");
    },
    outcomes: () => (existsSync(done) ? readFileSync(done, "utf8").split("\n").filter(Boolean) : []),
  };
}

const EXPECTED_FILES = [
  `${FB}/fb-local.yaml`,
  `${FB}/fb-main-0.yaml`,
  `${FB}/fb-main-1.yaml`,
  `${FB}/fb-main-2.yaml`,
  `${FB}/fb-pend-0.yaml`,
  `${FB}/fb-pend-1.yaml`,
  `${FB}/fb-queued.yaml`,
];

test("W1-T9638: a slow git child in a per-poll landing does not delay a concurrent timer", async () => {
  const f = fixture("timer");
  const shim = slowGitShim();
  const priorPath = process.env.PATH;
  process.env.PATH = `${shim.binDir}${delimiter}${priorPath ?? ""}`;
  const timer = setInterval(shim.acknowledge, 10);
  let result;
  try {
    result = await withLiveWritesAllowed(() =>
      sweepFeedbackLandingAsync(f.clone.dir, { gh: f.gh, stateRoot: f.stateRoot, log: f.log, planPrPreflight: async () => GREEN }),
    );
  } finally {
    clearInterval(timer);
    if (priorPath === undefined) delete process.env.PATH;
    else process.env.PATH = priorPath;
  }

  assert.equal(result.landed, true, JSON.stringify(result));
  assert.equal(result.pushed, true);
  assert.deepEqual(f.landedFiles(), EXPECTED_FILES, "the carried, local and queued records all landed");
  const children = shim.outcomes();
  assert.ok(children.length >= 20, `the landing's git children ran through the slow git: ${children.length}`);
  const held = children.filter((line) => line.split(" ")[1] !== "seen");
  assert.deepEqual(held, [], `${held.length} of ${children.length} git children ran while the loop waited on them`);
});

test("W1-T9638: the sync and async landings build the same tree from the same pending files", async () => {
  const sync = fixture("same-sync");
  const awaited = fixture("same-async");

  const r1 = withLiveWritesAllowed(() =>
    sweepFeedbackLanding(sync.clone.dir, { gh: sync.gh, stateRoot: sync.stateRoot, log: sync.log, planPrPreflight: () => GREEN }),
  );
  const r2 = await withLiveWritesAllowed(() =>
    sweepFeedbackLandingAsync(awaited.clone.dir, { gh: awaited.gh, stateRoot: awaited.stateRoot, log: awaited.log, planPrPreflight: async () => GREEN }),
  );

  assert.equal(r1.landed, true, JSON.stringify(r1));
  assert.deepEqual(r2, r1, "the same LandFeedbackResult: files, acknowledgement, kept count and PR");
  assert.deepEqual(r1.files, [`${FB}/fb-local.yaml`, `${FB}/fb-queued.yaml`]);
  assert.deepEqual(r1.acknowledgement?.paths, [`${FB}/fb-main-2.yaml`], "the untracked copy of main's record was acknowledged");
  assert.equal(awaited.landedTree(), sync.landedTree(), "the same tree on the landing branch");
  assert.deepEqual(sync.landedFiles(), EXPECTED_FILES);
  assert.match(
    sync.origin.git("show", `refs/heads/${LANDING_BRANCH}:${FB}/fb-main-0.yaml`),
    /^status: grilling$/m,
    "the carried lineage record keeps its advance over main",
  );
  assert.deepEqual(awaited.ghCalls, sync.ghCalls, "the same PR calls, bodies included");

  const syncRow = sync.rows.find((r) => r.step === "feedback.landing_sweep");
  const asyncRow = awaited.rows.find((r) => r.step === "feedback.landing_sweep");
  assert.ok(syncRow && asyncRow, JSON.stringify({ sync: sync.rows, async: awaited.rows }));
  assert.equal(asyncRow.git_calls, syncRow.git_calls, "both drivers ran the same git verbs");
});

test("W1-T9638: the landing row meters its git children, and only the sync driver holds the loop for their whole run", async () => {
  const sync = fixture("meter-sync");
  const awaited = fixture("meter-async");
  withLiveWritesAllowed(() =>
    sweepFeedbackLanding(sync.clone.dir, { gh: sync.gh, stateRoot: sync.stateRoot, log: sync.log, planPrPreflight: () => GREEN }),
  );
  await withLiveWritesAllowed(() =>
    sweepFeedbackLandingAsync(awaited.clone.dir, { gh: awaited.gh, stateRoot: awaited.stateRoot, log: awaited.log, planPrPreflight: async () => GREEN }),
  );

  const syncRow = sync.rows.find((r) => r.step === "feedback.landing_sweep")!;
  const asyncRow = awaited.rows.find((r) => r.step === "feedback.landing_sweep")!;
  assert.equal(syncRow.pushed, true, JSON.stringify(syncRow));
  assert.equal(syncRow.git_driver, "sync");
  assert.equal(asyncRow.git_driver, "async");
  assert.ok(Number(syncRow.git_calls) >= 20, JSON.stringify(syncRow));
  assert.equal(syncRow.git_loop_ms, syncRow.git_wall_ms, "the sync driver holds the loop for every child's whole run");
  assert.ok(Number(asyncRow.git_wall_ms) > 0, JSON.stringify(asyncRow));
  assert.ok(Number(asyncRow.git_loop_ms) <= Number(asyncRow.git_wall_ms), JSON.stringify(asyncRow));

  // An idle pass rides the quiet row with its own (smaller) count: the dirty scan only.
  const idle = gitRepo({ kind: "w9638-idle" });
  const rows: Row[] = [];
  await sweepFeedbackLandingAsync(idle.dir, { log: (step, extra = {}) => rows.push({ step, ...extra }), planPrPreflight: async () => GREEN });
  assert.deepEqual(
    rows.map((r) => [r.step, r.pushed, r.git_driver, r.git_calls]),
    [["feedback.landing_sweep", false, "async", 2]],
    "an idle poll spawns only the two dirty-scan reads, not the identity reads",
  );
});

test("W1-T9638: a checkout outside any repository still lands, through the awaited identity read's own failure", async () => {
  const f = fixture("no-cwd-repo");
  const outside = mkdtempSync(join(tmpdir(), "rmd-w9638-outside-"));
  const prior = process.cwd();
  process.chdir(outside);
  let awaitedResult;
  let syncResult;
  try {
    awaitedResult = await withLiveWritesAllowed(() =>
      sweepFeedbackLandingAsync(f.clone.dir, { gh: f.gh, stateRoot: f.stateRoot, planPrPreflight: async () => GREEN }),
    );
    syncResult = withLiveWritesAllowed(() => sweepFeedbackLanding(f.clone.dir, { gh: f.gh, stateRoot: f.stateRoot, planPrPreflight: () => GREEN }));
  } finally {
    process.chdir(prior);
  }
  assert.equal(awaitedResult.landed, true, JSON.stringify(awaitedResult));
  assert.equal(awaitedResult.pushed, true);
  assert.deepEqual(f.landedFiles(), EXPECTED_FILES, "the unscoped landing branch carries every record");
  assert.equal(syncResult.landed, true, JSON.stringify(syncResult));
  assert.equal(syncResult.pushed, false, "the second pass finds its tree already on the branch");
});

test("W1-T9638: a content landing that loses its push lease re-derives its tree through the yielded rebuild", () => {
  const f = fixture("content-lease");
  let pushes = 0;
  const git = (args: string[], opts?: { env?: NodeJS.ProcessEnv }): string => {
    if (args[0] === "push" && ++pushes === 1) throw new Error(`! [rejected] refs/heads/${LANDING_BRANCH} (stale info)`);
    return execFileSync("git", ["-C", f.clone.dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: opts?.env ?? process.env });
  };
  const result = withLiveWritesAllowed(() =>
    landFeedbackStatusContent(f.clone.dir, `${FB}/fb-flip.yaml`, "id: fb-flip\nstatus: new\nraw: flip\n", { gh: f.gh, git, planPrPreflight: () => GREEN }),
  );
  assert.equal(pushes, 2, "the lost lease was retried once");
  assert.equal(result.landed, true, JSON.stringify(result));
  assert.deepEqual(result.files, [`${FB}/fb-flip.yaml`]);
  assert.ok(result.leaseMoved, "the retry names the lease it lost");
  assert.ok(f.landedFiles().includes(`${FB}/fb-flip.yaml`) && f.landedFiles().includes(`${FB}/fb-pend-0.yaml`), "the rebuilt tree carries the branch's records too");
});
