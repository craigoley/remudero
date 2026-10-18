import { repoRoot } from "#test/helpers/repo-root.js";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";
import { rmSync } from "node:fs";
import { AUTHORITY_TABLE } from "#src/lib/authority.js";
import { createHeadRehomePorts, headRehomePlan, identityCommitMessage, type HeadRehomeObservation } from "#src/lib/head-rehome.js";
import { DECISION_RELEVANT_LEDGER_STEPS } from "#src/lib/ledger.js";
import { checkCommitMessage } from "#src/lib/commit-message.js";
import { extractTaskTrailerId } from "#src/lib/review.js";
import { ghShim } from "#test/helpers/gh-shim.js";
import { buildSweepEffects, DEFAULT_SWEEP_POLICY, dedupeRollupByLatestAttempt, runSweep, type OpenPrView, type SweepDeps } from "#src/lib/sweep.js";
const { hasValidTaskTrailer } = (await import(pathToFileURL(`${repoRoot()}/scripts/head-identity-gate.mjs`).href)) as {
  hasValidTaskTrailer: (message: string) => boolean;
};

const NOW = Date.now();
const SHA = "a".repeat(40);
const NEW_SHA = "c".repeat(40);
const MOVED = "b".repeat(40);
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
  const writes: { pr: number; ref?: string; observedSha: string; message: string }[] = [];
  const reads: string[] = [];
  const deps: SweepDeps = {
    arm: () => {}, close: () => { reads.push("close"); }, escalate: () => {},
    dispatchFix: () => { reads.push("fix"); },
    runId: "trailer-test", ledgerPath: "/dev/null/trailer.ndjson", now: () => NOW,
    readLedger: () => [...rows], appendLine: (_path, row) => { rows.push(row); },
    headRehome: {
      observe: async (original) => {
        reads.push("observe");
        return { ...original, state: "open", title: "fix(flow): repair mount", body: "Acceptance:\n- original proof",
          changedFiles: ["test/mount.test.ts"], commitMessages: ["fix(flow): repair mount"],
          activity: [{ committedAt: new Date(NOW).toISOString() }] };
      },
      judgeQuiet: async () => ({ quiet: true, reason: "session has handed off this red head" }),
      readHead: async () => SHA,
      appendIdentityCommit: async (original, observedSha, message) => {
        writes.push({ pr: original.prNumber, ref: original.headRefName, observedSha, message });
        return NEW_SHA;
      },
    },
  };
  return { rows, writes, reads, deps, sweep: (original = pr()) => runSweep([original], deps, DEFAULT_SWEEP_POLICY) };
}

async function observation(): Promise<HeadRehomeObservation> {
  return harness().deps.headRehome!.observe(pr());
}

const QUIET = { quiet: true, reason: "handed off" };

test("W1-T9055: a head-identity-only red gains one trailer commit on its own head and no replacement PR", async () => {
  // Replay #11194: a same-repo codex/ head, every check green but head-identity-gate, the author quiet.
  const h = harness();
  const original = pr({ prNumber: 11194, prUrl: "https://github.com/acme/repo/pull/11194",
    headRefName: "codex/heavy-ready-core-config-1791849000000" });
  const summary = await h.sweep(original);
  assert.equal(h.writes.length, 1);
  assert.deepEqual([h.writes[0].pr, h.writes[0].ref, h.writes[0].observedSha],
    [11194, "codex/heavy-ready-core-config-1791849000000", SHA]);
  assert.equal(extractTaskTrailerId(h.writes[0].message), "PR-11194");
  assert.equal(hasValidTaskTrailer(h.writes[0].message), true);
  assert.equal(summary.actionsTaken, 1);
  assert.equal(summary.byDisposition.wait, 1);
  assert.deepEqual(h.reads, ["observe"]);
  const steps = h.rows.map(row => row.step).filter(step => String(step).startsWith("pr."));
  assert.deepEqual(steps, ["pr.identity_trailer.started", "pr.identity_trailered"]);
  const done = h.rows.find(row => row.step === "pr.identity_trailered")!;
  assert.deepEqual([done.from_pr, done.from_head, done.head_sha, done.trailer, done.to_sha],
    [11194, "codex/heavy-ready-core-config-1791849000000", SHA, "PR-11194", NEW_SHA]);
  assert.equal(Object.keys(done).some(key => key === "to_pr"), false);
  assert.match(String(done.reason), /session has handed off/);
  assert.equal(h.rows.some(row => /rehome/.test(String(row.step))), false);
  // The same observed head is never trailered twice.
  await h.sweep(original);
  assert.equal(h.writes.length, 1);
  // A conforming run-<id>-<ms> head is not touched at all.
  const conforming = harness();
  await conforming.sweep(pr({ headRefName: `run-unfiled-${NOW}` }));
  assert.equal(conforming.reads.includes("observe"), false);
  assert.deepEqual(conforming.writes, []);
  // The plan itself is a trailer, never a branch or a replacement.
  const plan = headRehomePlan(original, { ...await observation(), ...original }, QUIET);
  assert.equal(plan.action, "trailer");
  assert.equal(Object.keys(plan).some(key => /head(Name)?$/.test(key) && key !== "headSha"), false);
  // The ports a sweep is handed can no longer open or close a pull request.
  const ports = createHeadRehomePorts({ owner: "acme", repo: "repo", judgeQuiet: async () => QUIET, readJson: () => ({}) });
  assert.deepEqual(Object.keys(ports).sort(), ["appendIdentityCommit", "judgeQuiet", "observe", "readHead"]);
  const authority = AUTHORITY_TABLE.filter(row => row.module === "src/lib/head-rehome.ts");
  assert.deepEqual(authority.map(row => [row.symbol, row.boundary]), [["createHeadRehomePorts(...).appendIdentityCommit", "git-push"]]);
  assert.deepEqual(authority[0].ledgerSteps, ["pr.identity_trailer.started", "pr.identity_trailered", "pr.identity_trailer.refused"]);
  for (const step of ["pr.identity_trailer.started", "pr.identity_trailered"]) assert.ok(DECISION_RELEVANT_LEDGER_STEPS.has(step), step);
});

test("W1-T9055: a head that moved after observation is refused, never overwritten", async () => {
  // Planner: the live head is no longer the listed one.
  const live = await observation();
  assert.deepEqual(headRehomePlan(pr(), { ...live, headSha: MOVED }, QUIET), { action: "refused", reason: "head moved" });
  // Sweep: the head moves between observation and the write — no commit is appended.
  const sweepMoved = harness();
  sweepMoved.deps.headRehome!.readHead = async () => MOVED;
  await sweepMoved.sweep();
  assert.deepEqual(sweepMoved.writes, []);
  assert.match(String(sweepMoved.rows.find(row => row.step === "pr.identity_trailer.refused")?.reason), /head moved/);
  assert.equal(sweepMoved.rows.some(row => row.step === "pr.identity_trailered"), false);
  // Transport: the fresh ref read sees another sha — the ref is never PATCHed.
  const calls: string[][] = [];
  let refSha = MOVED;
  let patched = NEW_SHA;
  let prHead = NEW_SHA;
  const ports = createHeadRehomePorts({ owner: "acme", repo: "repo", judgeQuiet: async () => QUIET, readJson: args => {
    calls.push(args);
    const path = args.find(arg => arg.startsWith("repos/")) ?? "";
    if (path.endsWith(`/git/commits/${SHA}`)) return { sha: SHA, tree: { sha: "t".repeat(40) } };
    if (path.endsWith("/git/commits")) return { sha: NEW_SHA };
    if (path.includes("/git/ref/heads/")) return { object: { sha: refSha } };
    if (path.includes("/git/refs/heads/")) return { object: { sha: patched } };
    return { state: "open", draft: false, head: { sha: prHead, ref: "codex/scratch" } };
  } });
  await assert.rejects(ports.appendIdentityCommit(pr(), SHA, "chore(identity): x"), /head moved before identity commit push/);
  assert.equal(calls.some(args => args.includes("PATCH")), false);
  // A push that is not a fast-forward is GitHub's refusal; it surfaces, the commit is not claimed.
  refSha = SHA;
  const refused = createHeadRehomePorts({ owner: "acme", repo: "repo", judgeQuiet: async () => QUIET, readJson: args => {
    if (args.includes("PATCH")) throw new Error("HTTP 422: Update is not a fast forward");
    const path = args.find(arg => arg.startsWith("repos/")) ?? "";
    if (path.endsWith(`/git/commits/${SHA}`)) return { sha: SHA, tree: { sha: "t".repeat(40) } };
    if (path.endsWith("/git/commits")) return { sha: NEW_SHA };
    return { object: { sha: SHA } };
  } });
  await assert.rejects(refused.appendIdentityCommit(pr(), SHA, "chore(identity): x"), /not a fast forward/);
  // The ref or the PR head ends somewhere other than the new commit — refused, not reported as done.
  patched = MOVED;
  await assert.rejects(ports.appendIdentityCommit(pr(), SHA, "chore(identity): x"), /did not advance/);
  patched = NEW_SHA;
  prHead = MOVED;
  await assert.rejects(ports.appendIdentityCommit(pr(), SHA, "chore(identity): x"), /not identity commit/);
  prHead = NEW_SHA;
  assert.equal(await ports.appendIdentityCommit(pr(), SHA, "chore(identity): x"), NEW_SHA);
  await assert.rejects(ports.appendIdentityCommit(pr({ headRefName: undefined }), SHA, "chore(identity): x"), /head ref unknown/);
  await assert.rejects(ports.appendIdentityCommit(pr(), MOVED, "chore(identity): x"), /unreadable/);
  // A failed sweep write is ledgered as refused, and no trailered row claims it.
  const sweepFailed = harness();
  sweepFailed.deps.headRehome!.appendIdentityCommit = async () => { throw new Error("head moved before identity commit push"); };
  await sweepFailed.sweep();
  assert.equal(sweepFailed.rows.some(row => row.step === "pr.identity_trailered"), false);
  assert.match(String(sweepFailed.rows.find(row => row.step === "pr.identity_trailer.refused")?.reason), /head moved/);
});

test("the trailer is PR-<n> unless an earlier commit's own trailer names a filed, unmerged task", async () => {
  const live = await observation();
  const filed = (id: string) => id === "W1-T43";
  for (const [messages, filedUnmerged, expected] of [
    [["fix(flow): repair"], filed, "PR-50"],
    [["fix(flow): build\n\nRemudero-Task: W1-T43", "fix(flow): repair"], filed, "W1-T43"],
    [["fix(flow): build\n\nRemudero-Task: W1-T43", "fix(flow): repair"], () => false, "PR-50"],
    [["fix(flow): build\n\nRemudero-Task: W1-T43", "fix(flow): repair"], undefined, "PR-50"],
    [["fix(flow): build W1-T43", "fix(flow): repair"], filed, "PR-50"],
    [["fix(flow): build\n\nRemudero-Task: W1-T43", "fix(flow): build\n\nRemudero-Task: W1-T44", "fix(flow): repair"], () => true, "PR-50"],
    [["fix(flow): build\n\nRemudero-Task: PR-49", "fix(flow): repair"], () => true, "PR-50"],
    [["fix(flow): build\n\nRemudero-Task: bad/id", "fix(flow): repair"], () => true, "PR-50"],
  ] as const) {
    const plan = headRehomePlan(pr(), { ...live, commitMessages: messages }, QUIET, { filedUnmerged });
    assert.equal(plan.action, "trailer");
    if (plan.action !== "trailer") continue;
    assert.equal(plan.trailer, expected);
    assert.equal(extractTaskTrailerId(plan.message), expected);
    assert.equal(plan.headSha, SHA);
    assert.equal(plan.reason, "head-identity-only red; handed off");
  }
  // The sweep forwards the ports' filed-and-unmerged reader to the planner.
  const h = harness();
  h.deps.headRehome!.filedUnmerged = filed;
  const observe = h.deps.headRehome!.observe;
  h.deps.headRehome!.observe = async original => ({ ...await observe(original),
    commitMessages: ["fix(flow): build\n\nRemudero-Task: W1-T43", "fix(flow): repair"] });
  await h.sweep();
  assert.equal(extractTaskTrailerId(h.writes[0].message), "W1-T43");
});

test("the identity commit message passes the conventional-commit checks and the head-identity gate", () => {
  const message = identityCommitMessage(11194, "PR-11194");
  assert.deepEqual(checkCommitMessage(message), []);
  assert.match(message, /^chore\(identity\): [a-z]/);
  const lines = message.split("\n");
  assert.equal(lines[1], "");
  assert.ok(lines.every(line => line.length <= 100));
  assert.deepEqual(lines.slice(-2), ["", "Remudero-Task: PR-11194"]);
  assert.equal(hasValidTaskTrailer(message), true);
});

test("planner names each unsafe observation and never emits a write", async () => {
  const live = await observation();
  const cases: [Partial<HeadRehomeObservation>, RegExp][] = [
    [{ headRefName: "codex/another" }, /head moved/],
    [{ state: "closed" }, /closed/], [{ isDraft: true }, /draft/],
    [{ mergeState: "dirty" }, /conflicted/], [{ sameRepository: false }, /fork/],
    [{ changedFiles: undefined }, /diff unreadable/], [{ changedFiles: [] }, /empty/],
    [{ commitMessages: [] }, /commits unreadable/],
    [{ ciFailures: [{ name: "ci", sha: SHA }] }, /other reds/],
    [{ ciFailures: [{ name: "head-identity-gate", sha: MOVED }] }, /at this head/],
    [{ redRequiredChecks: ["ci"] }, /other reds/], [{ reviewState: "failure" }, /other reds/],
    [{ pendingChecks: ["coverage"] }, /unfinished/],
  ];
  for (const [patch, reason] of cases) {
    const result = headRehomePlan(pr(), { ...live, ...patch }, QUIET);
    assert.equal(result.action, "refused");
    assert.match(result.reason, reason);
  }
  assert.equal(headRehomePlan(pr(), live, undefined, { conformingHead: true }).action, "none");
  assert.equal(headRehomePlan(pr({ ciFailures: [] }), live).action, "none");
  assert.equal(headRehomePlan(pr(), { ...live, commitMessages: ["fix(flow): repair\n\nRemudero-Task: PR-50"] }).action, "none");
  assert.match(headRehomePlan(pr(), live).reason, /no judgment/);
  assert.match(headRehomePlan(pr(), live, { quiet: false, reason: "still typing" }).reason, /still typing/);
});

test("the quietness judgment can trailer a just-pushed head and hold an old active session", async () => {
  const recent = harness();
  await recent.sweep();
  assert.equal(recent.rows.filter(row => row.step === "pr.identity_trailered").length, 1);
  const active = harness();
  active.deps.headRehome!.judgeQuiet = async () => ({ quiet: false, reason: "author session is still working" });
  await active.sweep(pr({ lastActivityAt: new Date(NOW - 24 * 60 * 60_000).toISOString() }));
  assert.deepEqual(active.writes, []);
  assert.match(String(active.rows.find(row => row.step === "pr.identity_trailer.refused")?.reason), /author session is still working/);
});

test("unreadable diff, unavailable judgment and unwired effects are ledgered without a fix round", async () => {
  for (const variant of ["diff", "judge", "unwired"] as const) {
    const h = harness();
    if (variant === "diff") {
      const observe = h.deps.headRehome!.observe;
      h.deps.headRehome!.observe = async original => ({ ...await observe(original), changedFiles: undefined });
    }
    if (variant === "judge") h.deps.headRehome!.judgeQuiet = async () => { throw new Error("judge unavailable"); };
    if (variant === "unwired") h.deps.headRehome = undefined;
    await h.sweep();
    assert.deepEqual(h.writes, []);
    assert.equal(h.reads.includes("fix"), false);
    assert.equal(h.rows.filter(row => row.step === "pr.identity_trailer.refused").length, 1);
    assert.equal(h.rows.some(row => row.step === "pr.identity_trailered"), false);
  }
});

test("another red keeps its fix route and records the trailer refusal", async () => {
  const h = harness();
  await h.sweep(pr({ ciFailures: [...pr().ciFailures!, { name: "ci", logTail: "typecheck failed" }] }));
  assert.deepEqual(h.reads, ["fix"]);
  assert.deepEqual(h.writes, []);
  assert.equal(h.rows.find(row => row.step === "pr.identity_trailer.refused")?.reason, "other reds present");
});

test("dry runs and light sweeps perform no trailer reads or writes", async () => {
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

test("a failed push retries on the next pass under its one started row", async () => {
  const h = harness();
  const append = h.deps.headRehome!.appendIdentityCommit;
  h.deps.headRehome!.appendIdentityCommit = async () => { throw new Error("HTTP 502"); };
  await h.sweep();
  assert.equal(h.rows.some(row => row.step === "pr.identity_trailered"), false);
  h.deps.headRehome!.appendIdentityCommit = append;
  await h.sweep();
  assert.equal(h.rows.filter(row => row.step === "pr.identity_trailer.started").length, 1);
  assert.equal(h.rows.filter(row => row.step === "pr.identity_trailered").length, 1);
  assert.equal(h.writes.length, 1);
});

test("simultaneous sweep passes write the trailer commit once", async () => {
  const h = harness();
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  h.deps.headRehome!.judgeQuiet = async () => { await blocked; return { quiet: true, reason: "handoff" }; };
  const first = h.sweep();
  await new Promise(resolve => setImmediate(resolve));
  await h.sweep();
  release();
  await first;
  assert.equal(h.rows.filter(row => row.step === "pr.identity_trailered").length, 1);
  assert.equal(h.writes.length, 1);
});

test("two PRs in the same pass each gain their own PR trailer", async () => {
  const h = harness();
  await runSweep([pr(), pr({ prNumber: 60, prUrl: "https://github.com/acme/repo/pull/60" })], h.deps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(h.writes.map(write => extractTaskTrailerId(write.message)), ["PR-50", "PR-60"]);
  assert.equal(h.rows.filter(row => row.step === "pr.identity_trailered").length, 2);
});

test("the default GitHub transport commits the observed tree onto the PR's own ref and opens or closes no PR", async () => {
  const ref = "codex/heavy-ready-core-config-1791849000000";
  const shim = ghShim([
    { when: `git/commits/${SHA}`, stdout: JSON.stringify({ sha: SHA, tree: { sha: "d".repeat(40) } }) },
    { when: "-X POST repos/acme/repo/git/commits", stdout: JSON.stringify({ sha: NEW_SHA }) },
    { when: `git/ref/heads/${ref}`, stdout: JSON.stringify({ object: { sha: SHA } }) },
    { when: `git/refs/heads/${ref}`, stdout: JSON.stringify({ object: { sha: NEW_SHA } }) },
    { when: "pulls/11194", stdout: JSON.stringify({ state: "open", draft: false, head: { sha: NEW_SHA, ref } }) },
    { when: "", stdout: "{}" },
  ]);
  const oldPath = process.env.PATH;
  try {
    process.env.PATH = `${shim.dir}:${oldPath}`;
    const ports = createHeadRehomePorts({ owner: "acme", repo: "repo", judgeQuiet: async () => QUIET });
    const message = identityCommitMessage(11194, "PR-11194");
    assert.equal(await ports.appendIdentityCommit(pr({ prNumber: 11194, headRefName: ref }), SHA, message), NEW_SHA);
    const calls = shim.calls().filter(call => call.startsWith("api ") && call.includes("repos/acme/repo/"));
    assert.equal(calls.length, 5);
    assert.match(calls[0], new RegExp(`^api repos/acme/repo/git/commits/${SHA}`));
    // The message spans lines, so the POST's tree and parent are read from the whole recorded argv.
    const all = shim.calls().join("\n");
    assert.match(calls[1], /^api -X POST repos\/acme\/repo\/git\/commits -f message=chore\(identity\): credit pr 11194's head to PR-11194/);
    assert.ok(all.includes("Remudero-Task: PR-11194") && all.includes(`tree=${"d".repeat(40)}`) && all.includes(`parents[]=${SHA}`));
    assert.match(calls[2], new RegExp(`^api repos/acme/repo/git/ref/heads/${ref}`));
    assert.match(calls[3], new RegExp(`^api -X PATCH repos/acme/repo/git/refs/heads/${ref} -f sha=${NEW_SHA} -F force=false`));
    assert.match(calls[4], /^api repos\/acme\/repo\/pulls\/11194/);
    assert.equal(/-X POST repos\/acme\/repo\/pulls|state=closed|issues\/|DELETE|force=true/.test(all), false);
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
  rollup.headRefOid = MOVED;
  await assert.rejects(ports.observe(pr()), /head moved while reading checks/);
  rollup.headRefOid = SHA;
  assert.equal(await ports.readHead(pr()), SHA);
  live.state = "closed";
  await assert.rejects(ports.readHead(pr()), /no longer open/);
});

test("the production sweep effects wire a quietness judge with no time threshold and reject unavailable answers", async () => {
  let response = 'TYPED_JUDGMENT: {"wait":0.1,"trailer":0.9}';
  const effects = buildSweepEffects({ owner: "acme", repo: "repo", config: { root: process.cwd() } as never,
    ledgerPath: "/dev/null/trailer-judge.ndjson", runId: "trailer-judge", plan: { tasks: [], byId: new Map() } as never,
    log: () => {}, nowMsImpl: () => NOW, spawnImpl: async args => {
      assert.deepEqual(args.tools, []);
      assert.match(args.prompt, /do not use a fixed number of minutes/);
      assert.match(args.prompt, /commit cadence/);
      assert.match(args.prompt, /ONE empty commit carrying a Remudero-Task trailer onto the PR's own branch/);
      assert.doesNotMatch(args.prompt, /replacement|closes the original/);
      assert.ok(args.prompt.includes(SHA));
      return { text: response } as never;
    } });
  const observed = await observation();
  assert.equal((await effects.headRehome!.judgeQuiet(observed)).quiet, true);
  response = 'TYPED_JUDGMENT: {"wait":0.5,"trailer":0.5}';
  assert.equal((await effects.headRehome!.judgeQuiet(observed)).quiet, false);
  response = "unparseable";
  const unavailable = await effects.headRehome!.judgeQuiet(observed);
  assert.equal(unavailable.quiet, false);
  assert.match(unavailable.reason, /unavailable/);
  const shadow = buildSweepEffects({ owner: "acme", repo: "repo", repoMode: "shadow", config: { root: process.cwd() } as never,
    ledgerPath: "/dev/null/trailer-shadow.ndjson", runId: "trailer-shadow", plan: { tasks: [], byId: new Map() } as never, log: () => {} });
  assert.deepEqual(await shadow.headRehome!.judgeQuiet(observed), { quiet: false, reason: "shadow repository" });
});
