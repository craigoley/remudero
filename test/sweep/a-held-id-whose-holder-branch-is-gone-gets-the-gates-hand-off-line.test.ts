/**
 * A HELD ID WHOSE HOLDER BRANCH IS GONE GETS THE GATE'S HAND-OFF LINE (W1-T13829).
 *
 * #19604 (head run-unfiled-1795065953000) added three shards whose ids were reserved for run-unfiled-1795065820000,
 * a branch that never reached origin. task-id-existence refused them as "HELD by a different reservation holder" and
 * printed the cure, `reservation hand-off: <holder> -> <filer>`, for each one. The sweep's only held-id rung renumbers
 * fleet heads, so the PR sat red about 5 h until a hand commit added the three lines. The sweep now adds the printed
 * line itself, once per head, when W1-T6026's proof of abandonment holds for every holder.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { parse as parseYaml } from "yaml";

import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import { loadPlanAtRef } from "#src/lib/plan.js";
import { formatReservationAnchorMessage, RESERVATION_PUSH_GRACE_MS, taskIdReservationRef } from "#src/lib/task-id-reservation.js";
import { ciFailureRegionReducer } from "#src/lib/tick-read-worker.js";
import { hostWorktreeGitAsync } from "#src/lib/worktree-git.js";
import { ghShim } from "#test/helpers/gh-shim.js";
import { gitRepo, type GitRepo } from "#test/helpers/git-repo.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import * as sweep from "#test/helpers/sweep-test.js";
import { DEFAULT_SWEEP_POLICY, runSweep, type CiFailure, type OpenPrView, type SweepDeps } from "#test/helpers/sweep-test.js";

// The gate's own matcher, read from the script the check runs (it ships no type declarations).
const GATE: string = "#scripts/task-id-existence-check.mjs";
const { shardNoteRecordsReservationHandoff } = (await import(GATE)) as { shardNoteRecordsReservationHandoff(text: string, holder: string, filer: string): boolean };

const NOW = Date.parse("2026-11-19T07:30:00Z");
const HOLDER = "run-unfiled-1795065820000";
const FILER = "run-unfiled-1795065953000";
const IDS = ["W1-T13787", "W1-T13788", "W1-T13789"];
const SHARDS = IDS.map((id) => `plan/tasks.d/${id}-fixture.yaml`);
const HEAD = "b".repeat(40);

/** The gate's own HELD block, as scripts/task-id-existence-check.mjs prints it, with the Actions timestamp prefix. */
function heldLog(entries: Array<{ id: string; file: string; handoff?: string; holder?: string }>): string {
  const stamp = "2026-11-19T05:33:01.1234567Z ";
  const lines = ["task-id-existence: FAILED -- the following added id(s) are HELD by a different reservation holder:", ""];
  for (const e of entries) {
    lines.push(`  ${e.id} -- reserved by ${e.holder ?? HOLDER}, while this filing is ${FILER}`, `    ${e.file}:1`);
    if (e.handoff !== undefined) {
      lines.push("    remedy: add this as a NEW line in the shard's note -- do not merge it into any existing note text on the same line, or the check that requires it will not see it:",
        "        note: |", `          ${e.handoff}`);
    }
  }
  lines.push("", "Renumber to a fresh reserved id, or record the operator hand-off in the shard note as `reservation hand-off: <holder> -> <filer>`.");
  return lines.map((l) => stamp + l).join("\n");
}

const handoffLine = `reservation hand-off: ${HOLDER} -> ${FILER}`;
const fullLog = heldLog(IDS.map((id, i) => ({ id, file: SHARDS[i]!, handoff: handoffLine })));

function gateStepLog(output: string): string {
  return [
    '##[group]Run if [ "${GITHUB_EVENT_NAME}" = "merge_group" ]; then # W1-T5522: a queued PR is open and would match itself',
    "##[endgroup]",
    output,
    "##[error]Process completed with exit code 1.",
  ].join("\n");
}

function failure(logTail: string, wrap = true): CiFailure {
  if (wrap) logTail = gateStepLog(logTail);
  return { name: "task-id-existence", logTail, conclusion: "FAILURE" };
}

function planPr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 19604,
    prUrl: "https://github.com/acme/remudero/pull/19604",
    reviewState: "pending",
    checksState: "red",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: new Date(NOW - 60_000).toISOString(),
    headSha: HEAD,
    headRefName: FILER,
    autoMergeArmed: false,
    isPlanFiling: true,
    planFilingSource: "github-files",
    ciFailures: [failure(fullLog)],
    body: `Files ${IDS.join(", ")}.`,
    ...over,
  };
}

test("W1-T13829 criterion 1: only the gate's printed hand-off line for this head as filer gives a hand-off decision", () => {
  const decision = sweep.decidePlanRepair(planPr(), {}, undefined, new Set());
  assert.deepEqual(decision, {
    signature: "held-task-id-handoff", action: "handoff", check: "task-id-existence",
    handoffs: IDS.map((id, i) => ({ id, holder: HOLDER, filer: FILER, files: [SHARDS[i]!] })),
  });
  const spaced = `plan/tasks.d/${IDS[0]}-hand filing.yaml`;
  const fromSpacedPath = sweep.decidePlanRepair(planPr({ ciFailures: [failure(fullLog.replace(SHARDS[0]!, spaced))] }), {}, undefined, new Set());
  assert.equal(fromSpacedPath?.action, "handoff");
  assert.deepEqual(fromSpacedPath.handoffs[0]?.files, [spaced]);
  const none = (logTail: string, over: Partial<OpenPrView> = {}) =>
    assert.notEqual(sweep.decidePlanRepair(planPr({ ciFailures: [failure(logTail)], ...over }), {}, undefined, new Set())?.action, "handoff");
  // A held id with no printed line: the gate gave no cure for it, so nothing is handed off.
  none(heldLog([{ id: IDS[0]!, file: SHARDS[0]!, handoff: handoffLine }, { id: IDS[1]!, file: SHARDS[1]! }]));
  const firstJob = heldLog([{ id: IDS[0]!, file: SHARDS[0]! }]).split("\n").slice(0, 4).join("\n");
  none(firstJob, { ciFailures: [failure(firstJob), { ...failure(`          ${handoffLine}`), name: "another-job" }] });
  none(firstJob, { ciFailures: [failure(firstJob.split("\n")[0]!), { ...failure(fullLog), name: "another-job" }] });
  none(`${firstJob}\n##[error]Process completed with exit code 1.\n          ${handoffLine}`);
  // A printed line whose filer is another branch is not this PR's cure.
  none(heldLog([{ id: IDS[0]!, file: SHARDS[0]!, handoff: `reservation hand-off: ${HOLDER} -> run-unfiled-1` }]));
  // A collision or an open-PR claim has no hand-off cure.
  for (const header of ["ALREADY DECLARED", "ALREADY CLAIMED by another OPEN PR"]) {
    none(`${fullLog}\ntask-id-existence: FAILED -- the following added id(s) are ${header}:\n  W1-T13789 -- declared at base\n    plan/tasks.d/W1-T13789-x.yaml:1`);
  }
  // Not a plan filing, or the attempt at this head is spent.
  none(fullLog, { isPlanFiling: false });
  assert.equal(sweep.decidePlanRepair(planPr(), {}, undefined, new Set([`19604@${HEAD}@held-task-id-handoff`])), undefined);
});

test("W1-T13829 criterion 1: only output inside the failed task-id-existence step supplies remedies", () => {
  const unrelated = [
    "##[group]Run node --import tsx scripts/list-rule-suites.mjs --run",
    "##[endgroup]",
    fullLog,
  ].join("\n");
  const noRemedy = heldLog([{ id: IDS[0]!, file: SHARDS[0]! }]);
  const decide = (log: string) => sweep.decidePlanRepair(planPr({ ciFailures: [failure(log, false)] }), {}, undefined, new Set());
  assert.equal(decide(`${unrelated}\n${gateStepLog("Could not read the base plan.")}`), undefined);
  assert.equal(decide(fullLog), undefined, "an excerpt without a step boundary has no provenance");
  assert.equal(decide(`${gateStepLog(noRemedy)}\n${unrelated}`), undefined);
  assert.equal(decide(gateStepLog("Could not read the base plan.").replace("##[endgroup]", `${fullLog}\n##[endgroup]`)), undefined);
  assert.deepEqual(decide(`${unrelated}\n${gateStepLog(fullLog)}`)?.action, "handoff");
});

interface Fixture {
  remote: GitRepo;
  host: GitRepo;
  headSha: string;
  readJson: (args: string[]) => Promise<unknown>;
  hooksDir: string;
}

const SHARD_TEXTS = [
  `- id: ${IDS[0]}\n  title: "a fixture shard — no note"\n  repo: remudero\n  depends_on: []\n  type: implement\n  verify: auto\n  risk: low # a comment\n  status: queued\n`,
  `- id: ${IDS[1]}\n  title: a fixture shard with a note\n  repo: remudero\n  note: filed by hand\n  depends_on: []\n  type: implement\n  verify: auto\n  status: queued\n`,
  `- id: ${IDS[2]}\n  title: another fixture shard\n  repo: remudero\n  type: implement\n  status: queued\n`,
];

/** A bare origin holding main, the filing branch and the two reservations; the daemon's checkout of it. */
function fixture(t: TestContext, opts: {
  startedAgoMs: number;
  holderOnOrigin?: boolean;
  openPrOnHolder?: boolean;
  unreadableOpenPr?: boolean;
  texts?: string[];
  holders?: readonly string[];
}): Fixture {
  const remote = gitRepo({ bare: true, scope: t, kind: "t13829-remote" });
  const seed = gitRepo({ cloneFrom: remote.dir, scope: t, kind: "t13829-seed" });
  mkdirSync(join(seed.dir, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(seed.dir, "plan", "tasks.yaml"), "[]\n");
  seed.git("add", "plan");
  seed.git("commit", "-m", "chore: seed the plan");
  seed.git("push", "--quiet", "origin", "HEAD:main");
  const startedAt = new Date(NOW - opts.startedAgoMs).toISOString();
  const tree = seed.git("rev-parse", "HEAD^{tree}");
  for (const [i, id] of IDS.entries()) {
    const claim = seed.git("commit-tree", tree, "-m", formatReservationAnchorMessage({ branch: opts.holders?.[i] ?? HOLDER, startedAt }));
    seed.git("push", "--quiet", "origin", `${claim}:refs/rmd-id/${id}`);
  }
  if (opts.holderOnOrigin) seed.git("push", "--quiet", "origin", `HEAD:refs/heads/${HOLDER}`);
  seed.git("checkout", "--quiet", "-b", FILER);
  const texts = opts.texts ?? SHARD_TEXTS;
  texts.forEach((text, i) => writeFileSync(join(seed.dir, SHARDS[i]!), text));
  seed.git("add", "plan");
  seed.git("commit", "-m", "chore(plan): file three tasks");
  seed.git("push", "--quiet", "origin", FILER);
  const headSha = seed.git("rev-parse", "HEAD");
  const host = gitRepo({ cloneFrom: remote.dir, scope: t, kind: "t13829-host" });
  host.git("config", "user.name", "remudero test fixture");
  host.git("config", "user.email", "fixture@remudero.invalid");
  const rows = opts.openPrOnHolder || opts.unreadableOpenPr
    ? [{ number: 19600, html_url: "https://github.com/acme/remudero/pull/19600", state: "open", title: "x", body: "", updated_at: "2026-11-19T05:00:00Z", head: { ref: opts.unreadableOpenPr ? undefined : HOLDER, sha: "c".repeat(40) } }]
    : [];
  const hooksDir = join(ownedFixtureDir(t, "t13829-effects").dir, "hooks");
  mkdirSync(hooksDir);
  return { remote, host, headSha, readJson: async () => rows, hooksDir };
}

let cuts = 0;
async function withFixtureHooks<T>(f: Fixture, run: () => Promise<T>): Promise<T> {
  const saved = process.env.RMD_HARNESS_HOOKS_DIR;
  process.env.RMD_HARNESS_HOOKS_DIR = f.hooksDir;
  try {
    return await withLiveWritesAllowed(run);
  } finally {
    if (saved === undefined) delete process.env.RMD_HARNESS_HOOKS_DIR;
    else process.env.RMD_HARNESS_HOOKS_DIR = saved;
  }
}

function handOff(f: Fixture, pr: OpenPrView, git?: typeof hostWorktreeGitAsync, log: (step: string) => void = () => {}) {
  const decision = sweep.decidePlanRepair(pr, {}, undefined, new Set());
  assert.equal(decision?.action, "handoff");
  const { handoffs } = decision;
  return withFixtureHooks(f, () => sweep.handOffHeldPlanPrIds(pr, handoffs, f.host.dir, join(dirname(f.hooksDir), `wt-${++cuts}`), {
    owner: "acme", repo: "remudero", log, readJson: f.readJson, nowMs: () => NOW, git,
  }));
}

test("W1-T13829 criterion 2: no hand-off while the holder branch exists, heads an open PR, or its reservation is young", async (t) => {
  const cases: Array<[string, Parameters<typeof fixture>[1], RegExp]> = [
    ["a 30-minute-old reservation", { startedAgoMs: 30 * 60_000 }, /reservation of W1-T13787 started at .* older than 2 h/],
    ["a reservation exactly at the grace period", { startedAgoMs: RESERVATION_PUSH_GRACE_MS }, /reservation of W1-T13787 started at .* older than 2 h/],
    ["a holder branch on origin", { startedAgoMs: RESERVATION_PUSH_GRACE_MS + 60_000, holderOnOrigin: true }, new RegExp(`holder branch ${HOLDER} of W1-T13787 is on origin`)],
    ["an open PR on the holder branch", { startedAgoMs: RESERVATION_PUSH_GRACE_MS + 60_000, openPrOnHolder: true }, /open PR #19600 has holder branch/],
    ["an unreadable open PR head", { startedAgoMs: RESERVATION_PUSH_GRACE_MS + 60_000, unreadableOpenPr: true }, /open PR #19600 has an unreadable head ref/],
  ];
  for (const [name, opts, reason] of cases) {
    const f = fixture(t, opts);
    const out = await handOff(f, planPr({ headSha: f.headSha }));
    assert.equal(out.outcome, "stood-down", `${name}: ${JSON.stringify(out)}`);
    assert.match(out.reason ?? "", reason, name);
    assert.equal(f.remote.git("rev-parse", `refs/heads/${FILER}`), f.headSha, `${name}: nothing was pushed`);
  }
});

test("W1-T13829 criterion 2: a reservation moved during fetch cannot be proved old from a cached anchor", async (t) => {
  const f = fixture(t, { startedAgoMs: RESERVATION_PUSH_GRACE_MS + 60_000 });
  const ref = taskIdReservationRef(IDS[0]!);
  f.host.git("fetch", "--no-write-fetch-head", "origin", ref);
  const tree = f.remote.git("rev-parse", "refs/heads/main^{tree}");
  const recent = f.remote.git("commit-tree", tree, "-m", formatReservationAnchorMessage({ branch: HOLDER, startedAt: new Date(NOW).toISOString() }));
  let moved = false;
  const out = await handOff(f, planPr({ headSha: f.headSha }), async (cwd, args) => {
    if (args[0] === "fetch" && args.at(-1) === ref) {
      f.remote.git("update-ref", ref, recent);
      moved = true;
    }
    return hostWorktreeGitAsync(cwd, args);
  });
  assert.equal(moved, true);
  assert.equal(out.outcome, "stood-down", JSON.stringify(out));
  assert.match(out.reason ?? "", /reservation of W1-T13787 changed while it was being read/);
  assert.equal(f.remote.git("rev-parse", `refs/heads/${FILER}`), f.headSha);
});

for (const phase of ["before worktree setup", "before push"]) {
  test(`W1-T13829 criterion 2: a holder published during reservation fetch ${phase} stops the hand-off`, async (t) => {
    const otherHolder = "run-unfiled-1795065830000";
    const f = fixture(t, {
      startedAgoMs: RESERVATION_PUSH_GRACE_MS + 60_000,
      holders: [HOLDER, HOLDER, otherHolder],
    });
    const lastRef = taskIdReservationRef(IDS[2]!);
    const logTail = heldLog(IDS.map((id, i) => {
      const holder = id === IDS[2] ? otherHolder : HOLDER;
      return { id, file: SHARDS[i]!, holder, handoff: `reservation hand-off: ${holder} -> ${FILER}` };
    }));
    let cut = false;
    let committed = false;
    let published = false;
    const pr = planPr({ headSha: f.headSha, ciFailures: [failure(logTail)] });
    const out = await handOff(f, pr, async (cwd, args) => {
      const result = await hostWorktreeGitAsync(cwd, args);
      if (args[0] === "commit") committed = true;
      if (args[0] === "fetch" && args.at(-1) === lastRef && committed === (phase === "before push") && !published) {
        f.remote.git("update-ref", `refs/heads/${HOLDER}`, "refs/heads/main");
        published = true;
      }
      return result;
    }, (step) => { if (step === "worktree.add") cut = true; });
    assert.equal(published, true, "the first holder appeared while reading a different holder's reservation");
    assert.deepEqual(out, { outcome: "stood-down", reason: `holder branch ${HOLDER} of ${IDS[0]} is on origin` });
    assert.equal(cut, phase === "before push");
    assert.equal(committed, phase === "before push");
    assert.equal(f.remote.git("rev-parse", `refs/heads/${FILER}`), f.headSha);
  });
}

test("W1-T13829 criterion 2: a holder published during worktree setup stops the hand-off before commit", async (t) => {
  const f = fixture(t, { startedAgoMs: RESERVATION_PUSH_GRACE_MS + 60_000 });
  const writes: string[] = [];
  const out = await handOff(f, planPr({ headSha: f.headSha }), async (cwd, args) => {
    if (args[0] === "commit" || args[0] === "push") writes.push(args[0]);
    return hostWorktreeGitAsync(cwd, args);
  }, (step) => {
    if (step === "worktree.add") f.remote.git("update-ref", `refs/heads/${HOLDER}`, "refs/heads/main");
  });
  assert.equal(f.remote.git("rev-parse", `refs/heads/${HOLDER}`), f.remote.git("rev-parse", "refs/heads/main"));
  assert.deepEqual(out, { outcome: "stood-down", reason: `holder branch ${HOLDER} of ${IDS[0]} is on origin` });
  assert.deepEqual(writes, []);
  assert.equal(f.remote.git("rev-parse", `refs/heads/${FILER}`), f.headSha);
});

test("W1-T13829 criterion 2: a holder published after the local commit stops the hand-off before push", async (t) => {
  const f = fixture(t, { startedAgoMs: RESERVATION_PUSH_GRACE_MS + 60_000 });
  const writes: string[] = [];
  const out = await handOff(f, planPr({ headSha: f.headSha }), async (cwd, args) => {
    const result = await hostWorktreeGitAsync(cwd, args);
    if (args[0] === "commit" || args[0] === "push") writes.push(args[0]);
    if (args[0] === "commit") f.remote.git("update-ref", `refs/heads/${HOLDER}`, "refs/heads/main");
    return result;
  });
  assert.equal(f.remote.git("rev-parse", `refs/heads/${HOLDER}`), f.remote.git("rev-parse", "refs/heads/main"));
  assert.deepEqual(out, { outcome: "stood-down", reason: `holder branch ${HOLDER} of ${IDS[0]} is on origin` });
  assert.deepEqual(writes, ["commit"]);
  assert.equal(f.remote.git("rev-parse", `refs/heads/${FILER}`), f.headSha);
});

test("W1-T13829 criterion 2: a holder published during another holder's last branch lookup stops the push", async (t) => {
  const otherHolder = "run-unfiled-1795065830000";
  const f = fixture(t, { startedAgoMs: RESERVATION_PUSH_GRACE_MS + 60_000, holders: [HOLDER, otherHolder, otherHolder] });
  const logTail = heldLog(IDS.map((id, i) => {
    const holder = i === 0 ? HOLDER : otherHolder;
    return { id, file: SHARDS[i]!, holder, handoff: `reservation hand-off: ${holder} -> ${FILER}` };
  }));
  let committed = false;
  let published = false;
  const out = await handOff(f, planPr({ headSha: f.headSha, ciFailures: [failure(logTail)] }), async (cwd, args) => {
    if (args[0] === "commit") committed = true;
    if (committed && !published && args[0] === "ls-remote" && args[1] === "--heads" && args[3] === `refs/heads/${otherHolder}`) {
      f.remote.git("update-ref", `refs/heads/${HOLDER}`, "refs/heads/main");
      published = true;
    }
    return hostWorktreeGitAsync(cwd, args);
  });
  assert.equal(published, true);
  assert.deepEqual(out, { outcome: "stood-down", reason: `holder branch ${HOLDER} of ${IDS[0]} is on origin` });
  assert.equal(f.remote.git("rev-parse", `refs/heads/${FILER}`), f.headSha);
});

test("W1-T13829 criterion 2: a fork PR opened during the final ref lookup stops the push", async (t) => {
  const f = fixture(t, { startedAgoMs: RESERVATION_PUSH_GRACE_MS + 60_000 });
  let committed = false;
  let opened = false;
  const writes: string[] = [];
  f.readJson = async () => opened ? [{
    number: 19600, html_url: "https://github.com/acme/remudero/pull/19600", state: "open", title: "holder filing", body: "",
    updated_at: "2026-11-19T05:00:00Z", head: { ref: HOLDER, sha: f.headSha, repo: { full_name: "fork/remudero" } },
  }] : [];
  const out = await handOff(f, planPr({ headSha: f.headSha }), async (cwd, args) => {
    const result = await hostWorktreeGitAsync(cwd, args);
    if (args[0] === "commit") committed = true;
    if (args[0] === "commit" || args[0] === "push") writes.push(args[0]);
    if (committed && args[0] === "ls-remote" && args[1] === "--refs" && args.includes(`refs/heads/${HOLDER}`)) opened = true;
    return result;
  });
  assert.equal(opened, true);
  assert.deepEqual(out, { outcome: "stood-down", reason: `open PR #19600 has holder branch ${HOLDER} of ${IDS[0]} as its head` });
  assert.deepEqual(writes, ["commit"]);
  assert.equal(f.host.git("ls-remote", "--heads", "origin", `refs/heads/${HOLDER}`), "");
  assert.equal(f.remote.git("rev-parse", `refs/heads/${FILER}`), f.headSha);
});

test("W1-T13829 criterion 3: the line is added as its own note line per named shard, in one commit pushed with a lease", async (t) => {
  const f = fixture(t, { startedAgoMs: RESERVATION_PUSH_GRACE_MS + 60_000 });
  const out = await handOff(f, planPr({ headSha: f.headSha }));
  assert.equal(out.outcome, "handed-off", JSON.stringify(out));
  const head = f.remote.git("rev-parse", `refs/heads/${FILER}`);
  assert.equal(head, out.newHeadSha, "the commit landed on the PR head");
  assert.equal(f.remote.git("rev-parse", `${head}^`), f.headSha, "one commit on the observed head");
  assert.equal(f.remote.git("diff", "--name-only", f.headSha, head), SHARDS.join("\n"), "only the named shards changed");
  const after = SHARDS.map((path) => f.remote.git("show", `${head}:${path}`) + "\n");
  assert.equal(after[0], `${SHARD_TEXTS[0]}  note: |\n    ${handoffLine}\n`, "a shard with no note gets a block-scalar note");
  assert.equal(after[1], SHARD_TEXTS[1]!.replace("  note: filed by hand\n", `  note: |\n    filed by hand\n    ${handoffLine}\n`), "existing note text is kept");
  for (const [i, text] of after.entries()) {
    const [task] = parseYaml(text) as Array<Record<string, unknown>>;
    assert.equal(task!.id, IDS[i], "the shard still parses");
    assert.equal(shardNoteRecordsReservationHandoff(text, HOLDER, FILER), true, "the gate's matcher accepts the line");
  }
  // The lease is on the head the sweep observed: a moved head is not written.
  const moved = await handOff(f, planPr({ headSha: f.headSha }));
  assert.equal(moved.outcome, "lease-mismatch", JSON.stringify(moved));
  assert.equal(f.remote.git("rev-parse", `refs/heads/${FILER}`), head);
});

for (const { name, original, prior, replacement } of [
  { name: "an empty note", original: "note:", prior: null, replacement: "note: |\n" },
  { name: "an empty note with a comment", original: "note: # keep this comment", prior: null, replacement: "note: | # keep this comment\n" },
  { name: "a quoted note with leading spaces", original: 'note: "  filed by hand" # keep this comment', prior: "  filed by hand", replacement: "note: |2 # keep this comment\n      filed by hand\n" },
]) {
  test(`W1-T13829 criterion 3: ${name} survives appending the remedy`, async (t) => {
    const texts = SHARD_TEXTS.map((text) => text.replace("note: filed by hand", original));
    const f = fixture(t, { startedAgoMs: RESERVATION_PUSH_GRACE_MS + 60_000, texts });
    const id = IDS[1]!;
    const file = SHARDS[1]!;
    const loadAt = (sha: string) => loadPlanAtRef(f.remote.dir, "plan/tasks.yaml", sha).byId.get(id);
    assert.equal(loadAt(f.headSha)?.note, prior, "the plan loader accepts the original note");
    const logTail = heldLog([{ id, file, handoff: handoffLine }]);
    const out = await handOff(f, planPr({ headSha: f.headSha, ciFailures: [failure(logTail)] }));
    assert.equal(out.outcome, "handed-off", JSON.stringify(out));
    const head = f.remote.git("rev-parse", `refs/heads/${FILER}`);
    assert.equal(f.remote.git("diff", "--name-only", f.headSha, head), file);
    const after = f.remote.git("show", `${head}:${file}`) + "\n";
    assert.equal(after, texts[1]!.replace(`${original}\n`, `${replacement}    ${handoffLine}\n`));
    assert.equal(loadAt(head)?.note, `${prior ? `${prior}\n` : ""}${handoffLine}\n`);
    assert.equal(shardNoteRecordsReservationHandoff(after, HOLDER, FILER), true);
  });
}

test("W1-T13829 criterion 3: a literal note keeps its header, indentation and trailing blank lines", async (t) => {
  const header = "  note: |4+ # keep these blank lines\n";
  const prior = `${header}      filed by hand\n\n\n`;
  const texts = SHARD_TEXTS.map((text) => text.replace("  note: filed by hand\n", prior));
  const f = fixture(t, { startedAgoMs: RESERVATION_PUSH_GRACE_MS + 60_000, texts });
  const out = await handOff(f, planPr({ headSha: f.headSha }));
  assert.equal(out.outcome, "handed-off", JSON.stringify(out));
  const after = f.remote.git("show", `${out.newHeadSha}:${SHARDS[1]}`) + "\n";
  assert.equal(after, texts[1]!.replace(prior, `${prior}      ${handoffLine}\n`));
  const [task] = parseYaml(after) as Array<Record<string, unknown>>;
  assert.equal(task!.note, `filed by hand\n\n\n${handoffLine}\n`);
  assert.equal(shardNoteRecordsReservationHandoff(after, HOLDER, FILER), true);
});

test("W1-T13829 criterion 3: empty block scalar notes keep the blank lines after their headers", async (t) => {
  const notes = [
    { header: "  note: |\n", blank: "\n", indent: "    ", suffix: "\n" },
    { header: "  note: |4- # keep this comment\n", blank: "      \n\n", indent: "      ", suffix: "" },
    { header: "  note: > # keep this comment\n", blank: "\n\n", indent: "    ", suffix: "\n" },
  ];
  const texts = SHARD_TEXTS.map((text, i) => {
    const { header, blank } = notes[i]!;
    return text.replace("  note: filed by hand\n", "").replace("  status: queued", `${header}${blank}  status: queued`);
  });
  const f = fixture(t, { startedAgoMs: RESERVATION_PUSH_GRACE_MS + 60_000, texts });
  const out = await handOff(f, planPr({ headSha: f.headSha }));
  assert.equal(out.outcome, "handed-off", JSON.stringify(out));
  const loadAt = (sha: string) => loadPlanAtRef(f.remote.dir, "plan/tasks.yaml", sha).byId;
  const before = loadAt(f.headSha);
  const after = loadAt(out.newHeadSha!);
  for (const [i, { header, blank, indent, suffix }] of notes.entries()) {
    const id = IDS[i]!;
    const edited = f.remote.git("show", `${out.newHeadSha}:${SHARDS[i]}`) + "\n";
    assert.equal(before.get(id)?.note, "", "the original block scalar is valid and empty");
    assert.equal(edited, texts[i]!.replace(header + blank, `${header}${indent}${handoffLine}\n${blank}`));
    assert.equal(after.get(id)?.note, handoffLine + suffix);
    assert.equal(shardNoteRecordsReservationHandoff(edited, HOLDER, FILER), true);
  }
});

test("W1-T13829 criterion 3: folded notes keep their headers and wrapping when the remedy gets its own line", async (t) => {
  const notes = [
    { header: ">- # keep this comment", indent: "    ", trailing: "", finalNewline: false },
    { header: ">4+ # keep these blank lines", indent: "      ", trailing: "\n\n", finalNewline: true },
    { header: ">", indent: "     ", trailing: "", finalNewline: true },
  ].map(({ header, indent, trailing, finalNewline }, i) => {
    const wrapped = `- id: ${IDS[i]}\n  note: ${header}\n${indent}filed by hand with a long note\n${indent}that wraps onto another line\n${trailing}`;
    const rest = "  status: queued # leave the rest alone\n";
    return { before: wrapped + rest, after: `${wrapped}${indent} ${handoffLine}\n${rest}`, finalNewline };
  });
  const f = fixture(t, { startedAgoMs: RESERVATION_PUSH_GRACE_MS + 60_000, texts: notes.map((note) => note.before) });
  const out = await handOff(f, planPr({ headSha: f.headSha }));
  assert.equal(out.outcome, "handed-off", JSON.stringify(out));
  for (const [i, note] of notes.entries()) {
    const after = f.remote.git("show", `${out.newHeadSha}:${SHARDS[i]}`) + "\n";
    assert.equal(after, note.after, "the remedy line is the only source edit");
    const [beforeTask] = parseYaml(note.before) as Array<{ note: string }>;
    const [afterTask] = parseYaml(after) as Array<{ note: string }>;
    const prior = beforeTask!.note;
    const actual = afterTask!.note;
    assert.ok(actual.startsWith(prior.endsWith("\n") ? prior : `${prior}\n`));
    assert.equal(actual.split("\n").findLast((line) => line !== "")?.trim(), handoffLine);
    assert.equal(actual.endsWith("\n"), note.finalNewline, "the header still controls chomping");
    assert.equal(shardNoteRecordsReservationHandoff(after, HOLDER, FILER), true);
  }
});

test("W1-T13829 criterion 3: two held ids in one shard share one copy of the same printed remedy", async (t) => {
  const prior = SHARD_TEXTS[1]!.replace("note: filed by hand", "note: |\n    filed by hand") + SHARD_TEXTS[0];
  const unrelated = SHARD_TEXTS[0]!.replace(IDS[0]!, "W1-T13786");
  const f = fixture(t, { startedAgoMs: RESERVATION_PUSH_GRACE_MS + 60_000, texts: [unrelated, prior, SHARD_TEXTS[2]!] });
  const logTail = heldLog([IDS[1]!, IDS[0]!].map((id) => ({ id, file: SHARDS[1]!, handoff: handoffLine })));
  const out = await handOff(f, planPr({ headSha: f.headSha, ciFailures: [failure(logTail)] }));
  assert.equal(out.outcome, "handed-off", JSON.stringify(out));
  assert.equal(f.remote.git("diff", "--name-only", f.headSha, out.newHeadSha!), SHARDS[1]);
  const after = f.remote.git("show", `${out.newHeadSha}:${SHARDS[1]}`) + "\n";
  assert.equal(after, prior.replace("    filed by hand\n", `    filed by hand\n    ${handoffLine}\n`));
  const tasks = parseYaml(after) as Array<Record<string, unknown>>;
  assert.deepEqual(tasks.map((task) => task.id), [IDS[1], IDS[0]]);
  assert.equal(shardNoteRecordsReservationHandoff(after, HOLDER, FILER), true);
});

test("W1-T13829 criterion 3: a remedy already in the shard is left in place", async (t) => {
  const prior = SHARD_TEXTS[0]! + `  note: >-\n    ${handoffLine}\n`;
  const f = fixture(t, { startedAgoMs: RESERVATION_PUSH_GRACE_MS + 60_000, texts: [prior] });
  const logTail = heldLog([{ id: IDS[0]!, file: SHARDS[0]!, handoff: handoffLine }]);
  const out = await handOff(f, planPr({ headSha: f.headSha, ciFailures: [failure(logTail)] }));
  assert.deepEqual(out, { outcome: "stood-down", reason: "the named shards already contain the printed hand-offs" });
  assert.equal(f.remote.git("rev-parse", `refs/heads/${FILER}`), f.headSha);
});

test("W1-T13829 criterion 3: a note anchor used elsewhere stands down without rewriting aliases", async (t) => {
  const original = `- id: ${IDS[0]}\n  note: &shared | # keep the note comment\n    filed by hand\n  title: *shared # keep the title comment\n`;
  const second = `- id: ${IDS[1]}\n  title: *shared\n  note: &shared for the second task\n  status: queued\n`;
  const third = `- id: ${IDS[2]}\n  title: *shared\n  status: queued\n`;
  const prior = original + second + third;
  const f = fixture(t, { startedAgoMs: RESERVATION_PUSH_GRACE_MS + 60_000, texts: [prior] });
  const logTail = heldLog([{ id: IDS[0]!, file: SHARDS[0]!, handoff: handoffLine }]);
  const out = await handOff(f, planPr({ headSha: f.headSha, ciFailures: [failure(logTail)] }));
  assert.deepEqual(out, { outcome: "stood-down", reason: `${SHARDS[0]}: adding the hand-off to the note of ${IDS[0]} would change other text` });
  const head = f.remote.git("rev-parse", `refs/heads/${FILER}`);
  assert.equal(head, f.headSha);
  assert.equal(f.remote.git("show", `${head}:${SHARDS[0]}`) + "\n", prior);
});

test("W1-T13829 criterion 3: an unshared note anchor is preserved", async (t) => {
  const prior = `- id: ${IDS[0]}\n  note: &kept | # keep the note comment\n    filed by hand\n  title: a fixture shard\n`;
  const f = fixture(t, { startedAgoMs: RESERVATION_PUSH_GRACE_MS + 60_000, texts: [prior] });
  const logTail = heldLog([{ id: IDS[0]!, file: SHARDS[0]!, handoff: handoffLine }]);
  const out = await handOff(f, planPr({ headSha: f.headSha, ciFailures: [failure(logTail)] }));
  assert.equal(out.outcome, "handed-off", JSON.stringify(out));
  const after = f.remote.git("show", `${out.newHeadSha}:${SHARDS[0]}`) + "\n";
  assert.equal(after, prior.replace("    filed by hand\n", `    filed by hand\n    ${handoffLine}\n`));
  const expected = parseYaml(prior) as Array<Record<string, unknown>>;
  expected[0]!.note = `filed by hand\n${handoffLine}\n`;
  assert.deepEqual(parseYaml(after), expected);
  assert.equal(shardNoteRecordsReservationHandoff(after, HOLDER, FILER), true);
});

test("W1-T13829 criterion 3: two different remedies for one shard stand down", async (t) => {
  const otherHolder = "run-unfiled-1795065830000";
  const f = fixture(t, {
    startedAgoMs: RESERVATION_PUSH_GRACE_MS + 60_000,
    holders: [HOLDER, otherHolder],
    texts: [SHARD_TEXTS[0]! + SHARD_TEXTS[1]!],
  });
  const logTail = heldLog([
    { id: IDS[0]!, file: SHARDS[0]!, handoff: handoffLine },
    { id: IDS[1]!, file: SHARDS[0]!, holder: otherHolder, handoff: `reservation hand-off: ${otherHolder} -> ${FILER}` },
  ]);
  const out = await handOff(f, planPr({ headSha: f.headSha, ciFailures: [failure(logTail)] }));
  assert.equal(out.outcome, "stood-down", JSON.stringify(out));
  assert.match(out.reason ?? "", /the gate printed different hand-offs for the same shard/);
  assert.equal(f.remote.git("rev-parse", `refs/heads/${FILER}`), f.headSha);
});

test("W1-T13829 criterion 5: the real sweep clears the gate when the CI excerpt drops the HELD header", async (t) => {
  const f = fixture(t, { startedAgoMs: RESERVATION_PUSH_GRACE_MS + 60_000 });
  const root = dirname(f.hooksDir);
  const baseline = join(root, "task-id-existence-baseline.json");
  writeFileSync(baseline, "[]\n");
  const openPrs = "repos/acme/remudero/pulls?state=open&per_page=100";
  const gh = ghShim([{ when: openPrs, stdout: "[]" }], { parent: root, kind: "t13829-gate" });
  const gateAt = (sha: string) => {
    f.host.git("checkout", "--quiet", "--detach", sha);
    const args = [join(REPO_ROOT, "scripts/task-id-existence-check.mjs"),
      "--cwd", f.host.dir, "--dir", "plan", "--base", "origin/main", "--baseline", baseline,
      "--head-ref", FILER, "--owner", "acme", "--repo", "remudero", "--require-open-prs"];
    return spawnSync(process.execPath, args, { encoding: "utf8", env: { ...process.env, PATH: `${gh.dir}:${process.env.PATH ?? ""}` } });
  };
  const refused = gateAt(f.headSha);
  assert.equal(refused.status, 1, refused.stderr);
  assert.match(refused.stderr, /HELD by a different reservation holder/);
  const stamp = "2026-11-19T05:33:01.1234567Z ";
  const lines = gateStepLog(refused.stderr.trimEnd()).split("\n").map((line) => stamp + line);
  const reducer = ciFailureRegionReducer(60);
  for (const line of lines) reducer.push(line);
  const logTail = reducer.finish();
  assert.doesNotMatch(logTail, /HELD by a different reservation holder/);
  assert.doesNotMatch(logTail, /W1-T13787/);
  assert.match(logTail, /W1-T13789/);
  const pr = planPr({ headSha: f.headSha, ciFailures: [{ ...failure(logTail, false), jobId: "12345" }] });
  const ledger: Record<string, unknown>[] = [];
  const readErrors: unknown[] = [];
  let logUnavailable = true;
  let jobLines = lines;
  const effects = sweep.buildSweepEffects({
    owner: "acme", repo: "remudero", repoRoot: f.host.dir, config: { root, claudeBin: "/bin/true" },
    ledgerPath: join(root, "ledger.ndjson"), runId: "W1-T13829-test", plan: { tasks: [], byId: new Map() },
    log: (step, fields) => { if (step === `${sweep.PLAN_REPAIR_STEP}.read_error`) readErrors.push(fields?.error); },
    nowMsImpl: () => NOW, ciGateRequired: [],
    readPlanRepairLogImpl: async (args, onLine) => {
      assert.deepEqual(args, ["api", "repos/acme/remudero/actions/jobs/12345/logs"]);
      jobLines.forEach(onLine);
      if (logUnavailable) throw new Error("connection closed before the job log completed");
    },
    readJsonImpl: async (args, opts) => {
      assert.match(args[1]!, /pulls\?state=open/);
      assert.equal(opts?.fresh, true);
      return f.readJson(args);
    },
  } as Parameters<typeof sweep.buildSweepEffects>[0]);
  const deps = {
    arm: () => {}, close: () => {}, dispatchFix: () => {}, escalate: () => {}, postReview: async () => {},
    readPlanRepairFacts: effects.readPlanRepairFacts, repairPlanPr: effects.repairPlanPr,
    ledgerPath: join(root, "ledger.ndjson"), runId: "W1-T13829-test",
    readLedger: () => ledger, appendLine: (_path: string, line: Record<string, unknown>) => { ledger.push(line); },
    now: () => NOW,
  } as unknown as SweepDeps;
  const incomplete = await effects.readPlanRepairFacts!(pr, "12345");
  assert.deepEqual(readErrors, ["Error: connection closed before the job log completed"]);
  assert.equal(sweep.decidePlanRepair(pr, incomplete, undefined, new Set()), undefined);
  logUnavailable = false;
  jobLines = [
    "##[group]Run node --import tsx scripts/list-rule-suites.mjs --run",
    "##[endgroup]",
    ...refused.stderr.trimEnd().split("\n"),
    ...gateStepLog("Could not read the base plan.").split("\n"),
  ].map((line) => stamp + line);
  const unrelated = await effects.readPlanRepairFacts!(pr, "12345");
  assert.equal(sweep.decidePlanRepair(pr, unrelated, undefined, new Set()), undefined);
  jobLines = lines;
  await withFixtureHooks(f, () => runSweep([pr], deps, DEFAULT_SWEEP_POLICY));
  const head = f.remote.git("rev-parse", `refs/heads/${FILER}`);
  assert.equal(f.remote.git("rev-parse", `${head}^`), f.headSha);
  assert.equal(f.remote.git("diff", "--name-only", f.headSha, head), SHARDS.join("\n"));
  assert.equal(ledger.find((row) => row.step === sweep.PLAN_REPAIR_STEP)?.outcome, "handed-off");
  const accepted = gateAt(head);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.match(accepted.stdout, /task-id-existence: OK/);
  assert.deepEqual(gh.calls(), [`api ${openPrs}`, `api ${openPrs}`]);
});

test("W1-T13829 criterion 4: a failed push and a stand-down each spend one attempt at their head", async (t) => {
  const ledger: Record<string, unknown>[] = [];
  const calls: Array<Record<string, unknown>> = [];
  let answer: { outcome: string; reason?: string } = { outcome: "error", reason: "the push was refused" };
  const deps = {
    arm: () => {}, close: () => {}, dispatchFix: () => {}, escalate: () => {}, postReview: async () => {},
    readPlanRepairFacts: () => ({}),
    repairPlanPr: (_pr: OpenPrView, decision: Record<string, unknown>) => { calls.push(decision); return answer; },
    ledgerPath: join(ownedFixtureDir(t, "t13829-ledger").dir, "ledger.ndjson"), runId: "W1-T13829-test",
    readLedger: () => ledger, appendLine: (_path: string, line: Record<string, unknown>) => { ledger.push(line); },
    now: () => NOW,
  } as unknown as SweepDeps;
  const rows = () => ledger.filter((l) => l.step === sweep.PLAN_REPAIR_STEP && l.signature === "held-task-id-handoff");
  await runSweep([planPr()], deps, DEFAULT_SWEEP_POLICY);
  assert.equal(calls.length, 1, "the hand-off was attempted");
  assert.equal(calls[0]!.action, "handoff");
  assert.equal(rows().length, 1);
  assert.equal(rows()[0]!.outcome, "error", "the failed push is ledgered");
  await runSweep([planPr()], deps, DEFAULT_SWEEP_POLICY);
  assert.equal(calls.length, 1, "a failed push is not retried at the same head");
  assert.equal(rows().length, 1, "and ledgered once");
  answer = { outcome: "stood-down", reason: "the reservation of W1-T13787 started at 2026-11-19T07:00:00.000Z, less than 2 h ago" };
  const other = planPr({ headSha: "d".repeat(40) });
  await runSweep([other], deps, DEFAULT_SWEEP_POLICY);
  await runSweep([other], deps, DEFAULT_SWEEP_POLICY);
  assert.equal(calls.length, 2, "the stand-down is not retried at the same head");
  assert.equal(rows().find((r) => r.head_sha === other.headSha)?.outcome, "stood-down");
  assert.equal(rows().filter((r) => r.head_sha === other.headSha).length, 1, "the stand-down is ledgered once");
  assert.equal(sweep.planRepairHistoryFromLedger(ledger).has(`19604@${other.headSha}@held-task-id-handoff`), true);
  assert.equal(sweep.planRepairHistoryFromLedger(ledger).has(`19604@${HEAD}@held-task-id-handoff`), true);
});

for (const phase of ["before worktree setup", "before push"]) {
  test(`W1-T13829 criterion 2: an earlier reservation replaced while a later one is fetched ${phase} stops the hand-off`, async (t) => {
    const f = fixture(t, { startedAgoMs: RESERVATION_PUSH_GRACE_MS + 60_000 });
    const firstRef = taskIdReservationRef(IDS[0]!);
    const secondRef = taskIdReservationRef(IDS[1]!);
    const tree = f.remote.git("rev-parse", "refs/heads/main^{tree}");
    // A new holder's reservation, 1 ms old, replaces the first one after it was already proved abandoned.
    const fresh = f.remote.git("commit-tree", tree, "-m",
      formatReservationAnchorMessage({ branch: HOLDER, startedAt: new Date(NOW - 1).toISOString() }));
    let committed = false;
    let replaced = false;
    const out = await handOff(f, planPr({ headSha: f.headSha }), async (cwd, args) => {
      const result = await hostWorktreeGitAsync(cwd, args);
      if (args[0] === "commit") committed = true;
      if (args[0] === "fetch" && args.at(-1) === secondRef && committed === (phase === "before push") && !replaced) {
        f.remote.git("update-ref", firstRef, fresh);
        replaced = true;
      }
      return result;
    });
    assert.equal(replaced, true);
    assert.deepEqual(out, { outcome: "stood-down", reason: `the reservation of ${IDS[0]} changed while the hand-off was being checked` });
    assert.equal(f.remote.git("rev-parse", `refs/heads/${FILER}`), f.headSha, "nothing was pushed");
  });
}

test("W1-T13829 criterion 3: a note that aliases a string gets the printed line after the aliased text", async (t) => {
  const texts = SHARD_TEXTS.map((text) => text
    .replace("  title: a fixture shard with a note\n", "  title: &filed a fixture shard with a note\n")
    .replace("  note: filed by hand\n", "  note: *filed # keep this comment\n"));
  const f = fixture(t, { startedAgoMs: RESERVATION_PUSH_GRACE_MS + 60_000, texts });
  const id = IDS[1]!;
  const file = SHARDS[1]!;
  const loadAt = (sha: string) => loadPlanAtRef(f.remote.dir, "plan/tasks.yaml", sha).byId.get(id);
  assert.equal(loadAt(f.headSha)?.note, "a fixture shard with a note", "the plan loader accepts the aliased note");
  const out = await handOff(f, planPr({ headSha: f.headSha, ciFailures: [failure(heldLog([{ id, file, handoff: handoffLine }]))] }));
  assert.equal(out.outcome, "handed-off", JSON.stringify(out));
  const head = f.remote.git("rev-parse", `refs/heads/${FILER}`);
  assert.equal(f.remote.git("diff", "--name-only", f.headSha, head), file);
  const after = f.remote.git("show", `${head}:${file}`) + "\n";
  assert.equal(after, texts[1]!.replace("  note: *filed # keep this comment\n",
    `  note: | # keep this comment\n    a fixture shard with a note\n    ${handoffLine}\n`));
  assert.equal(loadAt(head)?.title, "a fixture shard with a note", "the anchor's own text is unchanged");
  assert.equal(loadAt(head)?.note, `a fixture shard with a note\n${handoffLine}\n`);
  assert.equal(shardNoteRecordsReservationHandoff(after, HOLDER, FILER), true);
});

function overlappingSweepDeps(ledgerPath: string, ledger: Record<string, unknown>[], repairPlanPr: SweepDeps["repairPlanPr"],
  readPlanRepairFacts: SweepDeps["readPlanRepairFacts"] = () => ({})): SweepDeps {
  return {
    arm: () => {}, close: () => {}, dispatchFix: () => {}, escalate: () => {}, postReview: async () => {},
    readPlanRepairFacts, repairPlanPr, ledgerPath, runId: "W1-T13829-overlap",
    readLedger: () => ledger, appendLine: (_path: string, line: Record<string, unknown>) => { ledger.push(line); },
    now: () => NOW,
  } as unknown as SweepDeps;
}

test("W1-T13829 criterion 4: two independent overlapping sweeps make one hand-off attempt at a head", async (t) => {
  const otherModule: string = `${import.meta.resolve("#src/lib/sweep.js")}?t13829-independent`;
  const { runSweep: runOtherSweep } = (await import(otherModule)) as { runSweep: typeof runSweep };
  assert.notEqual(runOtherSweep, sweep.runSweep);
  const ledger: Record<string, unknown>[] = [];
  let calls = 0;
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const inside = new Promise<void>((resolve) => { entered = resolve; });
  const deps = overlappingSweepDeps(join(ownedFixtureDir(t, "t13829-overlap").dir, "ledger.ndjson"), ledger, async () => {
    // Only the first attempt waits, so a second one would finish rather than deadlock the test.
    if (++calls === 1) {
      entered();
      await released;
    }
    return { outcome: "error", reason: "the push was refused" };
  });
  const first = runSweep([planPr()], deps, DEFAULT_SWEEP_POLICY);
  try {
    await Promise.race([inside, first.then(() => assert.fail("the first sweep never reached the effect"))]);
    await runOtherSweep([planPr()], { ...deps, runId: "second-sweep" }, DEFAULT_SWEEP_POLICY);
  } finally {
    release();
    await first;
  }
  const rows = ledger.filter((l) => l.step === sweep.PLAN_REPAIR_STEP && l.signature === "held-task-id-handoff");
  assert.equal(calls, 1, "the second sweep began while the first attempt was in flight and did not attempt again");
  assert.deepEqual(rows.map((r) => r.outcome), ["error"], "one failure is ledgered for the head");
});

test("W1-T13829 criterion 4: a sweep whose snapshot predates another process's attempt reads the ledger again", async (t) => {
  // Another sweep process recorded its failed attempt after this pass read its ledger snapshot.
  const ledger: Record<string, unknown>[] = [{ step: sweep.PLAN_REPAIR_STEP, run_id: "other-process", pr_number: 19604, head_sha: HEAD,
    signature: "held-task-id-handoff", action: "handoff", outcome: "error", reason: "the push was refused" }];
  let calls = 0;
  let reads = 0;
  const deps = overlappingSweepDeps(join(ownedFixtureDir(t, "t13829-before-outcome").dir, "ledger.ndjson"), ledger, async () => {
    calls++;
    return { outcome: "error", reason: "the push was refused" };
  });
  deps.readLedger = () => (reads++ === 0 ? [] : ledger);
  await runSweep([planPr()], deps, DEFAULT_SWEEP_POLICY);
  const rows = ledger.filter((l) => l.step === sweep.PLAN_REPAIR_STEP && l.signature === "held-task-id-handoff");
  assert.ok(reads > 1, "the pass read the ledger again before the attempt");
  assert.equal(calls, 0, "the other process's attempt already spent this head");
  assert.deepEqual(rows.map((r) => r.run_id), ["other-process"], "no second failure is ledgered");
});

test("W1-T13829 criterion 5: dry-run previews a hand-off without taking or spending the attempt", async (t) => {
  const dir = ownedFixtureDir(t, "t13829-preview").dir;
  const ledger: Record<string, unknown>[] = [];
  let calls = 0;
  const deps = overlappingSweepDeps(join(dir, "ledger.ndjson"), ledger, async () => {
    calls++;
    return { outcome: "error", reason: "the push was refused" };
  });
  const preview = await runSweep([planPr()], { ...deps, dryRun: true }, DEFAULT_SWEEP_POLICY);
  assert.equal(calls, 0);
  assert.equal(ledger.length, 0);
  assert.equal(existsSync(join(dir, "plan-handoff-attempts")), false);
  assert.match(preview.actions[0]?.reason ?? "", /would handoff on task-id-existence/);
  await runSweep([planPr()], deps, DEFAULT_SWEEP_POLICY);
  assert.equal(calls, 1, "the live sweep can still attempt the same head");
  assert.deepEqual(ledger.filter((row) => row.step === sweep.PLAN_REPAIR_STEP).map((row) => row.outcome), ["error"]);
});
