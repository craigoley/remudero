import assert from "node:assert/strict";
import test from "node:test";
import { rmSync } from "node:fs";
import { createHeadRehomePorts, headRehomePlan, rehomeBody, type HeadRehomeObservation } from "../src/lib/head-rehome.js";
import { ghShim } from "./helpers/gh-shim.js";
import { buildSweepEffects, DEFAULT_SWEEP_POLICY, dedupeRollupByLatestAttempt, runSweep, type OpenPrView, type SweepDeps } from "../src/lib/sweep.js";

const NOW = Date.now();
const SHA = "a".repeat(40);
type Row = Record<string, unknown>;

function pr(overrides: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 50, prUrl: "https://github.com/acme/repo/pull/50", headSha: SHA,
    headRefName: "codex/scratch", checksState: "red", reviewState: "none",
    unmetCriteria: [], priorStrikes: 0, autoMergeArmed: false,
    lastActivityAt: new Date(NOW).toISOString(),
    ciFailures: [{ name: "head-identity-gate", logTail: "unidentified head" }, { name: "ci-gate", logTail: "aggregate" }],
    ...overrides,
  };
}

function harness() {
  const rows: Row[] = [];
  const writes: string[] = [];
  const reads: string[] = [];
  const deps: SweepDeps = {
    arm: () => {}, close: () => {}, escalate: () => {},
    dispatchFix: () => { writes.push("fix"); },
    runId: "rehome-test", ledgerPath: "/dev/null/rehome.ndjson", now: () => NOW,
    readLedger: () => [...rows], appendLine: (_path, row) => { rows.push(row); },
    headRehome: {
      observe: async (original) => {
        reads.push("observe");
        return { ...original, state: "open", title: "fix(flow): repair mount", body: "Acceptance:\n- original proof",
          changedFiles: ["test/mount.test.ts"], commitMessages: ["fix(flow): repair mount"],
          activity: [{ committedAt: new Date(NOW).toISOString() }] };
      },
      judgeQuiet: async () => ({ quiet: true, reason: "session has handed off this red head" }),
      ensureBranch: async (head, sha) => { assert.equal(sha, SHA); writes.push(`branch:${head}`); },
      findReplacement: async () => undefined,
      openReplacement: async (_original, plan, body) => {
        assert.match(body, /Acceptance:\n- original proof/);
        assert.match(body, /Rehomed from https:\/\/github.com\/acme\/repo\/pull\/50/);
        writes.push(`open:${plan.headName}`);
        return { prNumber: 51, prUrl: "https://github.com/acme/repo/pull/51", headSha: SHA };
      },
      readHead: async () => SHA,
      closeOriginal: async (_original, replacement) => { writes.push(`close:${replacement.prUrl}`); },
    },
  };
  return { rows, writes, reads, deps, sweep: (original = pr()) => runSweep([original], deps, DEFAULT_SWEEP_POLICY) };
}

test("test/a-head-identity-red-is-rehomed-onto-a-conforming-branch.test.ts: one re-home for a codex head, none for a conforming head", async () => {
  const h = harness();
  const summary = await h.sweep();
  const completed = h.rows.filter(row => row.step === "pr.rehomed");
  assert.equal(completed.length, 1);
  assert.equal(summary.actionsTaken, 1);
  assert.equal(summary.byDisposition.wait, 1);
  assert.equal(summary.actions[0].spent, false);
  assert.deepEqual(h.writes, [`branch:run-unfiled-${NOW}`, `open:run-unfiled-${NOW}`, "close:https://github.com/acme/repo/pull/51"]);
  assert.deepEqual([completed[0].from_pr, completed[0].to_pr, completed[0].from_head, completed[0].to_head],
    [50, 51, "codex/scratch", `run-unfiled-${NOW}`]);
  assert.equal(completed[0].head_sha, SHA);
  assert.match(String(completed[0].reason), /session has handed off/);
  await h.sweep();
  assert.equal(h.writes.length, 3);
  const conforming = harness();
  await conforming.sweep(pr({ headRefName: `run-unfiled-${NOW}` }));
  assert.deepEqual(conforming.reads, []);
  assert.equal(conforming.rows.some(row => row.step === "pr.rehomed"), false);
});

async function observation(): Promise<HeadRehomeObservation> {
  return harness().deps.headRehome!.observe(pr());
}

test("planner derives one task from earlier trailers or commit subjects and keeps ambiguous work unfiled", async () => {
  const live = await observation();
  for (const [messages, expected] of [
    [["fix(flow): build W1-T42", "fix(flow): repair"], "W1-T42"],
    [["fix(flow): build\n\nRemudero-Task: W1-T43", "fix(flow): repair W1-T99"], "W1-T43"],
    [["fix(flow): build W1-T42 and W1-T43", "fix(flow): repair"], "unfiled"],
    [["fix(flow): build\n\nRemudero-Task: W1-T42", "fix(flow): build\n\nRemudero-Task: W1-T43", "fix(flow): repair"], "unfiled"],
  ] as const) {
    assert.deepEqual(headRehomePlan(pr(), { conformingHead: false, observation: { ...live, commitMessages: messages },
      quiet: { quiet: true, reason: "handed off" }, nowMs: NOW }),
    { action: "rehome", headName: `run-${expected}-${NOW}`, headSha: SHA, reason: "head-identity-only red; handed off" });
  }
});

test("planner names each unsafe observation and never emits a branch action", async () => {
  const live = await observation();
  const cases: [Partial<HeadRehomeObservation>, RegExp][] = [
    [{ headSha: "b".repeat(40) }, /head moved/],
    [{ headRefName: "codex/another" }, /head moved/],
    [{ state: "closed" }, /closed/], [{ isDraft: true }, /draft/],
    [{ mergeState: "dirty" }, /conflicted/], [{ sameRepository: false }, /fork/],
    [{ changedFiles: undefined }, /diff unreadable/], [{ changedFiles: [] }, /empty/],
    [{ commitMessages: [] }, /commits unreadable/],
    [{ ciFailures: [{ name: "ci", sha: SHA }] }, /other reds/],
    [{ ciFailures: [{ name: "head-identity-gate", sha: "b".repeat(40) }] }, /at this head/],
    [{ redRequiredChecks: ["ci" ] }, /other reds/], [{ reviewState: "failure" }, /other reds/],
    [{ pendingChecks: ["coverage"] }, /unfinished/],
    [{ commitMessages: ["fix(flow): repair\n\nRemudero-Task: bad/id", "fix(flow): repair"] }, /cannot form a branch/],
  ];
  for (const [patch, reason] of cases) {
    const result = headRehomePlan(pr(), { conformingHead: false, observation: { ...live, ...patch },
      quiet: { quiet: true, reason: "handed off" }, nowMs: NOW });
    assert.equal(result.action, "refused");
    assert.match(result.reason, reason);
  }
  assert.equal(headRehomePlan(pr(), { conformingHead: true, observation: live, nowMs: NOW }).action, "none");
  assert.equal(headRehomePlan(pr({ ciFailures: [] }), { conformingHead: false, observation: live, nowMs: NOW }).action, "none");
  assert.equal(headRehomePlan(pr(), { conformingHead: false, observation: { ...live,
    commitMessages: ["fix(flow): repair\n\nRemudero-Task: PR-50"] }, nowMs: NOW }).action, "none");
  assert.match(headRehomePlan(pr(), { conformingHead: false, observation: live, nowMs: NOW }).reason, /no judgment/);
});

test("the quietness judgment can re-home a just-pushed head and hold an old active session", async () => {
  const recent = harness();
  await recent.sweep();
  assert.equal(recent.rows.filter(row => row.step === "pr.rehomed").length, 1);
  const active = harness();
  active.deps.headRehome!.judgeQuiet = async () => ({ quiet: false, reason: "author session is still working" });
  await active.sweep(pr({ lastActivityAt: new Date(NOW - 24 * 60 * 60_000).toISOString() }));
  assert.deepEqual(active.writes, []);
  assert.match(String(active.rows.find(row => row.step === "pr.rehome.refused")?.reason), /author session is still working/);
});

test("unreadable diff, head moves and unavailable judgment are ledgered without a fix round", async () => {
  for (const variant of ["diff", "move", "judge", "unwired"] as const) {
    const h = harness();
    if (variant === "diff") {
      const observe = h.deps.headRehome!.observe;
      h.deps.headRehome!.observe = async original => ({ ...await observe(original), changedFiles: undefined });
    }
    if (variant === "move") h.deps.headRehome!.readHead = async () => "b".repeat(40);
    if (variant === "judge") h.deps.headRehome!.judgeQuiet = async () => { throw new Error("judge unavailable"); };
    if (variant === "unwired") h.deps.headRehome = undefined;
    await h.sweep();
    assert.deepEqual(h.writes, []);
    assert.equal(h.rows.filter(row => row.step === "pr.rehome.refused").length, 1);
    assert.equal(h.rows.some(row => row.step === "pr.rehomed"), false);
  }
});

test("another red keeps its fix route and records the re-home refusal", async () => {
  const h = harness();
  await h.sweep(pr({ ciFailures: [...pr().ciFailures!, { name: "ci", logTail: "typecheck failed" }] }));
  assert.deepEqual(h.reads, []);
  assert.deepEqual(h.writes, ["fix"]);
  assert.equal(h.rows.find(row => row.step === "pr.rehome.refused")?.reason, "other reds present");
});

test("dry runs and light sweeps perform no re-home reads or writes", async () => {
  for (const mode of ["dry", "light", "restricted"] as const) {
    const h = harness();
    if (mode === "dry") h.deps.dryRun = true;
    if (mode === "light") h.deps.repairAdmissionSurface = "light";
    if (mode === "restricted") h.deps.actionable = () => false;
    await h.sweep();
    assert.deepEqual(h.reads, []);
    assert.deepEqual(h.writes, []);
  }
});

test("a partial close failure resumes the same branch and replacement rather than opening another", async () => {
  const h = harness();
  const replacement = { prNumber: 51, prUrl: "https://github.com/acme/repo/pull/51", headSha: SHA };
  h.deps.headRehome!.closeOriginal = async () => { throw new Error("close API unavailable"); };
  await h.sweep();
  assert.equal(h.rows.some(row => row.step === "pr.rehomed"), false);
  const started = h.rows.find(row => row.step === "pr.rehome.started")!;
  h.deps.now = () => NOW + 1000;
  h.deps.headRehome!.findReplacement = async () => replacement;
  h.deps.headRehome!.closeOriginal = async () => { h.writes.push("closed on retry"); };
  await h.sweep();
  assert.deepEqual(h.writes, [`branch:run-unfiled-${NOW}`, `open:run-unfiled-${NOW}`, `branch:run-unfiled-${NOW}`, "closed on retry"]);
  assert.equal(h.rows.find(row => row.step === "pr.rehomed")?.to_head, started.to_head);
});

test("a head moving after replacement creation leaves the source open and records the refusal", async () => {
  const h = harness();
  let reads = 0;
  h.deps.headRehome!.readHead = async () => ++reads === 3 ? "b".repeat(40) : SHA;
  await h.sweep();
  assert.deepEqual(h.writes, [`branch:run-unfiled-${NOW}`, `open:run-unfiled-${NOW}`]);
  assert.match(String(h.rows.find(row => row.step === "pr.rehome.refused")?.reason), /head moved/);
  assert.equal(h.rows.some(row => row.step === "pr.rehomed"), false);
});

test("an unexpected replacement SHA refuses the original close", async () => {
  const h = harness();
  h.deps.headRehome!.findReplacement = async () => ({ prNumber: 51, prUrl: "https://github.com/acme/repo/pull/51", headSha: "b".repeat(40) });
  await h.sweep();
  assert.deepEqual(h.writes, [`branch:run-unfiled-${NOW}`]);
  assert.match(String(h.rows.find(row => row.step === "pr.rehome.refused")?.reason), /differs from source/);
});

test("simultaneous sweep passes claim the re-home once", async () => {
  const h = harness();
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  h.deps.headRehome!.judgeQuiet = async () => { await blocked; return { quiet: true, reason: "handoff" }; };
  const first = h.sweep();
  await new Promise(resolve => setImmediate(resolve));
  await h.sweep();
  release();
  await first;
  assert.equal(h.rows.filter(row => row.step === "pr.rehomed").length, 1);
  assert.equal(h.writes.filter(write => write.startsWith("open:")).length, 1);
});

test("two unfiled PRs in the same pass receive distinct conforming branch names", async () => {
  const h = harness();
  h.deps.headRehome!.openReplacement = async (original, plan, body) => {
    assert.ok(body.includes(original.prUrl));
    h.writes.push(`open:${plan.headName}`);
    return { prNumber: original.prNumber + 100, prUrl: `${original.prUrl}-replacement`, headSha: SHA };
  };
  await runSweep([pr(), pr({ prNumber: 60, prUrl: "https://github.com/acme/repo/pull/60" })], h.deps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(h.writes.filter(write => write.startsWith("branch:")), [`branch:run-unfiled-${NOW}`, `branch:run-unfiled-${NOW + 1}`]);
  assert.equal(h.rows.filter(row => row.step === "pr.rehomed").length, 2);
});

test("the backlink preserves the original final task trailer", async () => {
  const live = { ...await observation(), body: "Acceptance:\n- proof\n\nRemudero-Task: W1-T42" };
  const body = rehomeBody(live);
  assert.match(body, /^Acceptance:\n- proof/);
  assert.match(body, /Rehomed from .*\n\nRemudero-Task: W1-T42$/);
});

test("the default GitHub transport creates the exact ref and replacement, then comments and closes without deleting a branch", async () => {
  const head = `run-unfiled-${NOW}`;
  const shim = ghShim([
    { when: "git/matching-refs", stdout: "[]" },
    { when: "pulls?state=all", stdout: "[]" },
    { when: `head=${head}`, stdout: JSON.stringify({ number: 51, html_url: "https://github.com/acme/repo/pull/51", head: { sha: SHA } }) },
    { when: "", stdout: "{}" },
  ]);
  const oldPath = process.env.PATH;
  try {
    process.env.PATH = `${shim.dir}:${oldPath}`;
    const ports = createHeadRehomePorts({ owner: "acme", repo: "repo", judgeQuiet: async () => ({ quiet: true, reason: "handoff" }) });
    await ports.ensureBranch(head, SHA);
    assert.equal(await ports.findReplacement(pr(), head), undefined);
    const live = await observation();
    const replacement = await ports.openReplacement(live, { action: "rehome", headName: head, headSha: SHA, reason: "handoff" }, rehomeBody(live));
    await ports.closeOriginal(pr(), replacement);
    const calls = shim.calls().filter(call => call.includes("repos/acme/repo/"));
    assert.equal(calls.length, 6);
    assert.ok(calls[1].includes(`ref=refs/heads/${head}`) && calls[1].includes(`sha=${SHA}`));
    assert.match(calls[3], /POST repos\/acme\/repo\/pulls/);
    assert.match(calls[4], /issues\/50\/comments.*pull\/51/);
    assert.match(calls[5], /PATCH repos\/acme\/repo\/pulls\/50.*state=closed/);
    assert.equal(calls.some(call => /delete-branch|DELETE/.test(call)), false);
  } finally {
    process.env.PATH = oldPath;
    rmSync(shim.dir, { recursive: true, force: true });
  }
});

test("the GitHub observer reads complete commit and diff pages and the newest required verdicts", async () => {
  const live = {
    state: "open", draft: false, title: "fix(flow): repair", body: null, updated_at: new Date(NOW).toISOString(),
    changed_files: 2, commits: 2, mergeable_state: "blocked",
    head: { sha: SHA, ref: "codex/scratch", repo: { full_name: "acme/repo" } }, base: { ref: "main" },
  };
  const rollup = { headRefOid: SHA, statusCheckRollup: [
    { name: "head-identity-gate", conclusion: "FAILURE" }, { name: "ci-gate", conclusion: "FAILURE" },
    { name: "ci", conclusion: "FAILURE", startedAt: "2026-10-09T00:00:00Z" },
    { name: "ci", conclusion: "SUCCESS", startedAt: "2026-10-09T00:01:00Z" },
    { name: "informational", conclusion: "FAILURE" },
    { context: "required-status", state: "SUCCESS" }, { name: "remudero-review", status: "PENDING" },
  ] };
  const calls: string[][] = [];
  const ports = createHeadRehomePorts({ owner: "acme", repo: "repo", latestChecks: dedupeRollupByLatestAttempt,
    requiredChecks: ["ci", "coverage"], judgeQuiet: async () => ({ quiet: false, reason: "active" }),
    readJson: args => {
      calls.push(args);
      if (args.includes("headRefOid,statusCheckRollup")) return rollup;
      if (args.some(arg => arg.includes("required_status_checks"))) return { contexts: ["ci-gate", "remudero-review"], checks: [{ context: "required-status" }] };
      if (args.some(arg => arg.includes("/commits?"))) return [[{ commit: { message: "fix(flow): W1-T42", committer: { date: live.updated_at } }, author: { login: "author" } }],
        [{ commit: { message: "fix(flow): follow up", committer: { date: live.updated_at } }, author: null }]];
      if (args.some(arg => arg.includes("/files?"))) return [[{ filename: "src/a.ts" }], [{ filename: "test/a.test.ts" }]];
      return live;
    },
  });
  const observed = await ports.observe(pr());
  assert.deepEqual(observed.changedFiles, ["src/a.ts", "test/a.test.ts"]);
  assert.deepEqual(observed.commitMessages, ["fix(flow): W1-T42", "fix(flow): follow up"]);
  assert.deepEqual(observed.activity.map(commit => commit.author), ["author", undefined]);
  assert.deepEqual(observed.ciFailures?.map(failure => failure.name), ["head-identity-gate", "ci-gate"]);
  assert.deepEqual(observed.pendingChecks, ["coverage"]);
  assert.equal(observed.sameRepository, true);
  assert.equal(observed.body, "");
  assert.equal(calls.filter(args => args.includes("--paginate") && args.includes("--slurp")).length, 2);
  live.changed_files = 3;
  live.commits = 3;
  const incomplete = await ports.observe(pr());
  assert.equal(incomplete.changedFiles, undefined);
  assert.deepEqual(incomplete.commitMessages, []);
  rollup.headRefOid = "b".repeat(40);
  await assert.rejects(ports.observe(pr()), /head moved while reading checks/);
  rollup.headRefOid = SHA;
  assert.equal(await ports.readHead(pr()), SHA);
  live.state = "closed";
  await assert.rejects(ports.readHead(pr()), /no longer open/);
});

test("existing ref and replacement are reused only when they identify the same open head", async () => {
  const head = `run-unfiled-${NOW}`;
  const ref = { ref: `refs/heads/${head}`, object: { sha: SHA } };
  const existing = { number: 51, html_url: "https://github.com/acme/repo/pull/51", state: "open",
    body: `Rehomed from ${pr().prUrl} (head-identity-gate).`, head: { sha: SHA } };
  const ports = createHeadRehomePorts({ owner: "acme", repo: "repo", judgeQuiet: async () => ({ quiet: true, reason: "handoff" }),
    readJson: args => args.some(arg => arg.includes("matching-refs")) ? [ref, { ref: `${ref.ref}-extra`, object: { sha: "b".repeat(40) } }] : [existing] });
  await ports.ensureBranch(head, SHA);
  assert.deepEqual(await ports.findReplacement(pr(), head), { prNumber: 51, prUrl: existing.html_url, headSha: SHA });
  ref.object.sha = "b".repeat(40);
  await assert.rejects(ports.ensureBranch(head, SHA), /another head/);
  existing.head.sha = "b".repeat(40);
  await assert.rejects(ports.findReplacement(pr(), head), /does not match/);
  existing.head.sha = SHA;
  existing.state = "closed";
  await assert.rejects(ports.findReplacement(pr(), head), /does not match/);
  existing.state = "open";
  existing.body = "unrelated work";
  await assert.rejects(ports.findReplacement(pr(), head), /does not match/);
});

test("the production sweep effects wire a quietness judge with no time threshold and reject unavailable answers", async () => {
  await import("../src/run-task.js");
  let response = 'TYPED_JUDGMENT: {"wait":0.1,"rehome":0.9}';
  const effects = buildSweepEffects({ owner: "acme", repo: "repo", config: { root: process.cwd() } as never,
    ledgerPath: "/dev/null/rehome-judge.ndjson", runId: "rehome-judge", plan: { tasks: [], byId: new Map() } as never,
    log: () => {}, nowMsImpl: () => NOW, spawnImpl: async args => {
      assert.deepEqual(args.tools, []);
      assert.match(args.prompt, /do not use a fixed number of minutes/);
      assert.match(args.prompt, /commit cadence/);
      assert.ok(args.prompt.includes(SHA));
      return { text: response } as never;
    } });
  const observed = await observation();
  assert.equal((await effects.headRehome!.judgeQuiet(observed)).quiet, true);
  response = 'TYPED_JUDGMENT: {"wait":0.5,"rehome":0.5}';
  assert.equal((await effects.headRehome!.judgeQuiet(observed)).quiet, false);
  response = "unparseable";
  const unavailable = await effects.headRehome!.judgeQuiet(observed);
  assert.equal(unavailable.quiet, false);
  assert.match(unavailable.reason, /unavailable/);
  const shadow = buildSweepEffects({ owner: "acme", repo: "repo", repoMode: "shadow", config: { root: process.cwd() } as never,
    ledgerPath: "/dev/null/rehome-shadow.ndjson", runId: "rehome-shadow", plan: { tasks: [], byId: new Map() } as never, log: () => {} });
  assert.deepEqual(await shadow.headRehome!.judgeQuiet(observed), { quiet: false, reason: "shadow repository" });
});
