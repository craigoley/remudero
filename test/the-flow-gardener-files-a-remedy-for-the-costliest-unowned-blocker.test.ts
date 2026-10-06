import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { fixedClock } from "../src/lib/clock.js";
import { flowGardenSpec, type FlowGardenSources } from "../src/lib/flow-remedy-gardener.js";
import { ciFrictionRecordVerdict } from "../src/lib/ci-friction-gardener.js";
import { gardenSchedule, REGISTERED_GARDEN_NAMES } from "../src/lib/garden-registry.js";
import type { GardenerDeps } from "../src/lib/gardener.js";
import type { LedgerRecord } from "../src/lib/retro.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { buildRegisteredGarden, GARDEN_BRANCH_RE, GARDEN_NAMES } from "../src/run-task.js";
import { GIT_REPO_FIXTURE_IDENTITY, gitRepo } from "./helpers/git-repo.js";
import { ghShim } from "./helpers/gh-shim.js";
import { writeLedger } from "./helpers/ledger-fixture.js";

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 9, 6, 12);
const iso = (hours: number) => fixedClock(NOW + hours * HOUR).iso();
function row(pr: number, hours: number, blocker = "escalated", reason = "metadata-only body red", owner = "NONE"): LedgerRecord {
  return { step: "sweep.disposed", pr_number: pr, ts: iso(hours), blocker, reason, blocker_owner: owner };
}
function fixture(root: string, records: LedgerRecord[], overrides: Partial<FlowGardenSources> = {}) {
  const logs: Array<{ step: string; fields?: Record<string, unknown> }> = [];
  const deps: GardenerDeps = {
    repoRoot: root, stateDir: root, clock: fixedClock(NOW), log: (step, fields) => logs.push({ step, fields }),
    openWorkspace: () => { throw new Error("unexpected workspace"); },
  };
  const sources: FlowGardenSources = {
    owner: "acme", repo: "remudero", mintTaskId: () => "W1-T9001",
    ledgerRecords: () => records, planState: () => ({ tasks: [] }), prOutcomes: () => new Map(),
    ownerSearch: { filesContaining: () => [{ file: "src/lib/sweep.ts", hits: 1 }], fileExists: () => true },
    ...overrides,
  };
  return { spec: flowGardenSpec(deps, sources), deps, sources, logs };
}
function workspace(root: string) {
  return { root, branch: "flow-garden-123", land: () => { throw new Error("unexpected landing"); }, dispose: () => {} };
}

test("W1-T5538: pass gaps are charged to the blocker the PR was waiting on", () => {
  const { spec } = fixture("/unused", [
    row(1, -1, "armed-idle", "armed", "armed-idle-merge"),
    row(1, -2, "awaiting-review", "review withheld", "review-lane"),
    row(2, -3), row(1, 0, "armed-idle", "armed", "armed-idle-merge"), row(2, -2),
    row(3, -100), row(1, -2, "awaiting-review", "review withheld", "review-lane"),
    { ...row(4, -3), ts: "invalid" }, { ...row(4, -2), blocker: "invented" },
  ]);
  const inv = spec.inventory();
  assert.deepEqual(inv.charges.map(c => [c.pr, c.key, c.hours]), [
    [1, "awaiting-review:review withheld", 1], [1, "armed-idle:armed", 1],
    [2, "escalated:metadata-only body red", 1],
  ]);
  assert.equal(inv.charges.some(c => c.pr === 3), false, "the lone last observation charges nothing");
  const normalised = fixture("/unused", [
    row(9, -2, "escalated", "body red #123 at abcdef123456 — detail 77"),
    row(9, -1, "escalated", "body red #456 at fedcba987654 — other detail"),
    row(9, 0, "escalated", "body red #789 at abcdef987654"),
  ]).spec.inventory();
  assert.equal(normalised.episodes.length, 1);
  assert.equal(normalised.priced[0]!.key, "escalated:body red #<n> at <sha>");
});

test("W1-T5538: the costliest unowned or uncleared blocker ranks first", () => {
  const records = [
    row(1, -100, "own-red", "ci red", "fix-lane"), row(1, -10, "awaiting-review", "ready", "review-lane"),
    row(2, -20), row(2, -10), row(3, -10, "escalated", "plan-only red"), row(3, -5, "escalated", "plan-only red"),
    row(4, -10, "awaiting-ci", "pending", "ci"), row(4, -8, "awaiting-review", "ready", "review-lane"),
    row(5, -7, "awaiting-ci", "pending", "ci"), row(5, -4, "awaiting-ci", "pending", "ci"),
    row(6, -1, "awaiting-ci", "pending", "ci"), row(6, -0.5, "awaiting-ci", "pending", "ci"),
    row(7, -4, "own-red", "ci red", "fix-lane"), row(7, -2, "own-red", "ci red", "fix-lane"),
    row(8, -4, "conflict", "dirty", "conflict-rebase"), row(8, -2, "conflict", "dirty", "conflict-rebase"),
  ];
  const { spec } = fixture("/unused", records, { prOutcomes: () => new Map([
    [7, { state: "closed", at: iso(-1) }], [8, { state: "merged", at: iso(-1), mergedBy: "operator" }],
  ]) });
  const inv = spec.inventory();
  assert.equal(inv.priced[0]!.key, "own-red:ci red", "all causes retain their cost for effect measurement");
  assert.equal(inv.next!.price.key, "escalated:metadata-only body red", "the expensive owner-cleared cause is skipped");
  assert.deepEqual(inv.candidates.map(p => p.key), [
    "escalated:metadata-only body red", "escalated:plan-only red", "awaiting-ci:pending", "conflict:dirty", "own-red:ci red",
  ]);
  assert.equal(inv.episodes.find(e => e.pr === 5)!.outcome, "open");
  assert.equal(inv.candidates.find(p => p.key === "awaiting-ci:pending")!.thresholdHours, 2);
  assert.equal(inv.episodes.find(e => e.pr === 6)!.eligible, false);
  const cold = fixture("/unused", [row(10, -1100), row(10, -1000), row(11, -3, "escalated", "plan-only red"), row(11, 0, "escalated", "plan-only red")]).spec.inventory();
  assert.equal(cold.next!.price.key, "escalated:plan-only red", "recency can outrank a larger old wait");
  const noControl = fixture("/unused", [row(12, -200, "awaiting-ci", "pending", "ci"), row(12, -1, "awaiting-ci", "pending", "ci")]).spec.inventory();
  assert.equal(noControl.next, undefined, "no cleared episode means no invented age bar");
});

test("W1-T5538: the top cause is filed once and a debited remedy reopens one rung up", (t) => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}flow-filing-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const records = [row(1, -4), row(1, -2), row(2, -2), row(2, 0), row(3, -1, "escalated", "plan-only red"), row(3, 0, "escalated", "plan-only red")];
  let minted = 0;
  const f = fixture(root, records, { mintTaskId: branch => { assert.equal(branch, "flow-garden-123"); minted++; return "W1-T9001"; } });
  const inv = f.spec.inventory();
  const actions = f.spec.candidates(inv, () => 0);
  const plan = { actions: [...actions, ...actions], acting: ["draft" as const] };
  const scorecard = f.spec.scorecard(inv, plan);
  const landing = f.spec.apply(workspace(root), plan, scorecard)!;
  assert.equal(minted, 1);
  assert.equal(landing.paths.length, 1);
  const text = readFileSync(join(root, landing.paths[0]!), "utf8");
  assert.equal(ciFrictionRecordVerdict(text, "flow fixture").ok, true);
  assert.match(text, /origin: "flow-blocker:escalated:metadata-only body red"/);
  assert.match(text, /PR-hours/);
  assert.match(text, /PR #1.*metadata-only body red/);
  assert.match(text, /owner NONE/);
  assert.equal(readdirSync(join(root, "plan", "tasks.d")).length, 1);
  assert.equal(scorecard.total_pr_hours, inv.priced.reduce((n, p) => n + p.hours, 0));
  const receipt = { step: "flow.scorecard", pr_url: "https://github.com/acme/remudero/pull/900", next: scorecard.next };
  const held = fixture(root, [...records, receipt]).spec.inventory();
  assert.equal(held.next!.price.key, "escalated:plan-only red", "a filing receipt holds the cause until main sees it");
  const remedy = { id: "W1-T9001", origin: actions[0]!.origin, files: ["src/lib/sweep.ts"], status: "queued", retired: false, mergedAt: iso(-2) };
  const reopened = fixture(root, records, { planState: () => ({ tasks: [remedy] }) }).spec.inventory();
  assert.equal(reopened.next!.origin, "flow-blocker:escalated:metadata-only body red#r2");
  assert.equal(reopened.next!.prior!.effect!.verdict, "debit");
  const malformedProof = text.replaceAll("W1-T9001", "W1-T9002").replace(/proof: .+/, 'proof: "grep: [ in src/lib/sweep.ts"');
  assert.equal(ciFrictionRecordVerdict(malformedProof, "malformed proof").ok, false);
  const invalid = fixture(root, records, { mintTaskId: () => "W1-T9002", draftShard: () => malformedProof });
  assert.throws(() => invalid.spec.apply(workspace(root), { actions: invalid.spec.candidates(invalid.spec.inventory(), () => 0), acting: ["draft"] }, {}), /failed lint/);
  assert.equal(readdirSync(join(root, "plan", "tasks.d")).length, 1, "admission failure writes nothing");
});

test("W1-T5538: the flow gardener is registered and builds", async (t) => {
  assert.ok(REGISTERED_GARDEN_NAMES.includes("flow-remedy"));
  assert.ok(GARDEN_NAMES.includes("flow-remedy"));
  assert.equal(GARDEN_BRANCH_RE.test("flow-remedy-garden-123"), true);
  assert.equal(GARDEN_BRANCH_RE.test("flow-remedy-garden-invalid"), false);
  assert.equal(gardenSchedule("flow-remedy").intervalFor(60_000), 60_000);
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}flow-builder-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "state"));
  const failures: string[] = [];
  const pass = await buildRegisteredGarden("flow-remedy", {
    config: { root, claudeBin: "/bin/true" }, repoRoot: root, owner: "acme", repo: "remudero",
    raiseDuplicate: () => "", log: step => failures.push(step),
  });
  assert.equal(typeof pass, "function");
  await pass();
  assert.ok(failures.includes("flow-remedy.gardener_failed"), "the built flow-remedy spec reports its own unreadable corpus");
});

test("flow measures equal PR-hour windows, distinguishes pending and credit, and escalates rung three", (t) => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}flow-effect-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const key = "escalated:metadata-only body red";
  const remedy = { id: "W1-T9001", origin: `flow-blocker:${key}`, files: ["src/lib/sweep.ts"], status: "queued", retired: false, mergedAt: iso(-24) };
  const before = [row(1, -48), row(1, -24)];
  const credit = fixture(root, [...before, row(2, -24, "escalated", "plan-only red"), row(2, 0, "escalated", "plan-only red")], { planState: () => ({ tasks: [remedy] }) }).spec.inventory();
  assert.equal(credit.ladder.find(l => l.cause === key)!.state, "resolved");
  assert.equal(credit.ladder.find(l => l.cause === key)!.effect!.verdict, "credit");
  const pending = fixture(root, [...before, row(2, -1), row(2, 0)], { planState: () => ({ tasks: [remedy] }) }).spec.inventory();
  assert.equal(pending.ladder[0]!.state, "measuring");
  assert.equal(pending.ladder[0]!.effect!.verdict, "pending");
  const absentBefore = fixture(root, [row(2, -1), row(2, 0)], { planState: () => ({ tasks: [remedy] }) }).spec.inventory();
  assert.equal(absentBefore.ladder[0]!.effect!.verdict, "unmeasurable");
  const spanning = fixture(root, [row(2, -48), row(2, 0)], { planState: () => ({ tasks: [remedy] }) }).spec.inventory();
  assert.deepEqual(spanning.ladder[0]!.effect!.before, { k: 24, n: 24 });
  assert.deepEqual(spanning.ladder[0]!.effect!.after, { k: 24, n: 24 });
  let escalations = 0;
  const f = fixture(root, [...before, row(2, -24), row(2, 0)], {
    planState: () => ({ tasks: [{ ...remedy, origin: `${remedy.origin}#r2` }] }),
    escalate: e => { escalations++; assert.match(e.detail, /debit: share of PR-hours/); return "https://github.com/acme/remudero/issues/1"; },
    mintTaskId: () => { throw new Error("escalation must not mint"); },
  });
  const inv = f.spec.inventory();
  assert.equal(inv.next!.rung, 3);
  assert.equal(f.spec.apply(workspace(root), { actions: f.spec.candidates(inv, () => 0), acting: ["draft"] }, {}), undefined);
  assert.equal(escalations, 1);
  assert.equal(readdirSync(root).length, 0);
  const receipt = { step: "flow.remedy_escalated", origin: inv.next!.origin, issue_url: "issue/1" };
  assert.equal(fixture(root, [...before, row(2, -24), row(2, 0), receipt], { planState: f.sources.planState }).spec.inventory().next, undefined);
  const retry = fixture(root, [...before, row(2, -24), row(2, 0), { ...receipt, issue_url: null }], { planState: f.sources.planState });
  assert.equal(retry.spec.inventory().next!.rung, 3, "a failed escalation is retried");
});

test("flow effect fixtures retain credit, pending and debit as wall time advances", (t) => {
  const key = "escalated:metadata-only body red";
  const remedy = { id: "W1-T9001", origin: `flow-blocker:${key}`, files: ["src/lib/sweep.ts"], status: "queued", retired: false, mergedAt: iso(-24) };
  const before = [row(1, -48), row(1, -24)];
  const specs = [
    [row(2, -24, "escalated", "plan-only red"), row(2, 0, "escalated", "plan-only red")],
    [row(2, -1), row(2, 0)],
    [row(2, -24), row(2, 0)],
  ].map(after => fixture("/unused", [...before, ...after], { planState: () => ({ tasks: [remedy] }) }).spec);
  t.mock.method(Date, "now", () => NOW);
  const expected = specs.map(spec => spec.inventory());
  assert.deepEqual(expected.map(inv => inv.ladder.find(l => l.cause === key)!.effect!.verdict), ["credit", "pending", "debit"]);
  t.mock.method(Date, "now", () => NOW + 366 * 24 * HOUR);
  assert.deepEqual(specs.map(spec => spec.inventory()), expected);
});

test("flow ownership calibrates the percentile per cause and ties by distinct PRs", () => {
  const records: LedgerRecord[] = [];
  for (let pr = 1; pr <= 10; pr++) records.push(
    row(pr, -100, "awaiting-ci", "pending", "ci"),
    row(pr, -100 + pr, "awaiting-review", "done", "review-lane"),
  );
  records.push(row(11, -9.5, "awaiting-ci", "pending", "ci"), row(11, -1, "awaiting-ci", "pending", "ci"));
  const inv = fixture("/unused", records).spec.inventory();
  assert.equal(inv.candidates[0]!.thresholdHours, 9);
  assert.equal(inv.next!.price.key, "awaiting-ci:pending");
  const tied = fixture("/unused", [row(20, -1), row(20, 0), row(21, -0.5, "escalated", "plan-only red"), row(21, 0, "escalated", "plan-only red"),
    row(22, -0.5, "escalated", "plan-only red"), row(22, 0, "escalated", "plan-only red")]).spec.inventory();
  assert.equal(tied.next!.price.key, "escalated:plan-only red");
  assert.equal(tied.next!.price.prs, 2);
  for (const actor of ["remudero-fleet[bot]", "app/remudero-fleet", undefined]) {
    const owned = fixture("/unused", [row(30, -3, "own-red", "red", "fix-lane"), row(30, -1, "own-red", "red", "fix-lane")], {
      prOutcomes: () => new Map([[30, { state: "merged", at: iso(0), mergedBy: actor }]]),
    }).spec.inventory();
    assert.equal(owned.next, undefined);
    assert.equal(owned.episodes[0]!.outcome, actor ? "cleared" : "unknown");
  }
});

test("flow refuses malformed proofs and unavailable owners before writing, and honours plan decisions", (t) => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}flow-admission-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const records = [row(1, -2), row(1, 0)];
  const f = fixture(root, records);
  const inv = f.spec.inventory();
  const plan = { actions: f.spec.candidates(inv, () => 0), acting: ["draft" as const] };
  assert.equal(f.spec.unfinished!(inv), true);
  assert.match(f.spec.fingerprint(inv), /flow-blocker:escalated/);
  assert.equal(f.spec.apply(workspace(root), { actions: [], acting: [] }, {}), undefined);
  assert.throws(() => f.spec.apply({ ...workspace(root), branch: undefined }, plan, {}), /reservation branch/);
  const noOwner = fixture(root, records, { ownerSearch: { filesContaining: () => [], fileExists: () => false } });
  assert.throws(() => noOwner.spec.apply(workspace(root), plan, {}), /no source owner/);
  const first = f.spec.apply(workspace(root), plan, {})!;
  const valid = readFileSync(join(root, first.paths[0]!), "utf8");
  const broken = valid.replace(/proof: .+/, 'proof: "grep: [ in src/lib/sweep.ts"');
  assert.equal(ciFrictionRecordVerdict(broken, "invalid proof").ok, false);
  const invalid = fixture(root, records, { mintTaskId: () => "W1-T9002", draftShard: () => broken.replaceAll("W1-T9001", "W1-T9002") });
  assert.throws(() => invalid.spec.apply(workspace(root), plan, {}), /failed lint/);
  assert.equal(readdirSync(join(root, "plan", "tasks.d")).length, 1);
  const task = { id: "W1-T9001", origin: plan.actions[0]!.origin, status: "queued", retired: false, files: ["src/lib/sweep.ts"] };
  for (const update of [{}, { retired: true }, { mergedAt: "invalid" }, { status: "merged" }]) {
    assert.equal(fixture(root, records, { planState: () => ({ tasks: [{ ...task, ...update }] }) }).spec.inventory().next, undefined);
  }
  const degraded = fixture(root, records, { planState: () => ({ tasks: [], degraded: "fetch unavailable" }) });
  assert.ok(degraded.spec.inventory().next);
  assert.deepEqual(degraded.logs[0], { step: "flow.origins_degraded", fields: { reason: "fetch unavailable" } });
  const unreadable = fixture(root, records, { planState: () => ({ tasks: [], unreadable: ["shard.yaml: invalid"] }) });
  assert.throws(() => unreadable.spec.inventory(), /flow plan shards unreadable/);
  const punctuation = fixture(root, [row(2, -1, "escalated", 'body red [check] "quoted"'), row(2, 0, "escalated", 'body red [check] "quoted"')]);
  const punctuated = punctuation.spec.apply(workspace(root), { actions: punctuation.spec.candidates(punctuation.spec.inventory(), () => 0), acting: ["draft"] }, {})!;
  assert.equal(ciFrictionRecordVerdict(readFileSync(join(root, punctuated.paths[0]!), "utf8"), "punctuated cause").ok, true);
  const pattern = punctuated.body.split("| grep: ")[1]!.split(" in ")[0]!;
  assert.ok(execFileSync("grep", ["-arn", "--", pattern, join(root, punctuated.paths[0]!)], { encoding: "utf8" }).includes("origin:"));
  const empty = fixture(root, []).spec;
  assert.equal(empty.unfinished!(empty.inventory()), false);
  assert.deepEqual(empty.candidates(empty.inventory(), () => 0), []);
});

test("flow production sources read all archive forms, main trailers and merge actors through real process seams", (t) => {
  const repo = gitRepo({ kind: "flow-sources" });
  t.after(() => repo.cleanup());
  mkdirSync(join(repo.dir, "plan", "tasks.d"), { recursive: true });
  mkdirSync(join(repo.dir, "src", "lib"), { recursive: true });
  writeFileSync(join(repo.dir, "src", "lib", "sweep.ts"), 'export const reason = "red";\n');
  writeFileSync(join(repo.dir, "plan", "tasks.d", "remedy.yaml"), `- id: W1-T9001
  title: remedy
  repo: remudero
  depends_on: []
  type: implement
  verify: auto
  risk: low
  status: queued
  attempts: 0
  origin: "flow-blocker:escalated:metadata-only body red"
  files: [src/lib/sweep.ts]
  acceptance: [{claim: fixed, proof: "unit test: fixed"}]
`);
  repo.git("add", ".");
  execFileSync("git", ["-C", repo.dir, "-c", `user.name=${GIT_REPO_FIXTURE_IDENTITY.name}`,
    "-c", `user.email=${GIT_REPO_FIXTURE_IDENTITY.email}`, "commit", "-qm", "fix: fixture remedy\n\nRemudero-Task: W1-T9001"], {
    env: { ...process.env, GIT_AUTHOR_DATE: iso(-4), GIT_COMMITTER_DATE: iso(-4) }, stdio: "ignore",
  });
  repo.addRemote("origin", repo.dir);
  repo.git("fetch", "origin");
  const ledger = writeLedger([row(1, 0), row(2, 0, "own-red", "red", "fix-lane")], { dir: join(repo.dir, "state"), rotations: [
    { at: iso(-2), rows: [row(1, -2), row(2, -2, "own-red", "red", "fix-lane")] },
    { at: iso(-1), gz: true, rows: [row(1, -1)] },
  ] });
  writeFileSync(join(ledger.dir, "ledger.legacy.ndjson.gz"), gzipSync(JSON.stringify(row(3, -2)) + "\n" + JSON.stringify(row(3, 0)) + "\n"));
  const shim = ghShim([{ when: "api graphql", stdout: JSON.stringify({ data: { repository: {
    p2: { state: "MERGED", mergedAt: iso(0), closedAt: iso(0), mergedBy: { login: "operator" } },
  } } }) }]);
  t.after(() => rmSync(shim.dir, { recursive: true, force: true }));
  const oldPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${oldPath}`;
  t.after(() => { process.env.PATH = oldPath; });
  const deps: GardenerDeps = { repoRoot: repo.dir, stateDir: ledger.dir, clock: fixedClock(NOW), log: () => {}, openWorkspace: () => workspace(repo.dir) };
  const spec = flowGardenSpec(deps, { owner: "acme", repo: "remudero", mintTaskId: () => "W1-T9002" });
  assert.match(spec.cheapFingerprint(), /ledger\.legacy/);
  const inv = spec.inventory();
  assert.equal(inv.charges.length, 4);
  assert.deepEqual([...new Set(inv.charges.map(c => c.pr))].sort(), [1, 2, 3]);
  assert.equal(inv.episodes.find(e => e.pr === 2)!.outcome, "failed");
  assert.equal(inv.ladder.find(l => l.cause === "escalated:metadata-only body red")!.state, "resolved", "a build trailer, not queued status, supplies the merge time");
  assert.equal(shim.calls().length, 1);
  const landing = spec.apply(workspace(repo.dir), { actions: spec.candidates(inv, () => 0), acting: ["draft"] }, {})!;
  assert.equal(ciFrictionRecordVerdict(readFileSync(join(repo.dir, landing.paths[0]!), "utf8"), "default owner search").ok, true);
  shim.addRoute({ when: "api graphql", stdout: JSON.stringify({ errors: [{ message: "unavailable" }] }) });
  assert.throws(() => spec.inventory(), /outcomes unreadable: GraphQL errors/);
  for (const data of [undefined, null]) {
    shim.addRoute({ when: "api graphql", stdout: JSON.stringify({ data }) });
    assert.throws(() => spec.inventory(), /outcomes unreadable: data missing/);
  }
  for (const repository of [undefined, null]) {
    shim.addRoute({ when: "api graphql", stdout: JSON.stringify({ data: { repository } }) });
    assert.throws(() => spec.inventory(), /outcomes unreadable: repository missing/);
  }
  shim.addRoute({ when: "api graphql", stdout: JSON.stringify({ data: { repository: {} } }) });
  assert.throws(() => spec.inventory(), /outcome missing/);
  writeFileSync(join(ledger.dir, "ledger.bad.ndjson.gz"), "not gzip");
  assert.throws(() => spec.inventory(), /ledger union unreadable/);
});

test("flow's default plan reader carries fetch failure, treats an empty plan as empty, and refuses corrupt shards", (t) => {
  const repo = gitRepo({ kind: "flow-plan-failures" });
  t.after(() => repo.cleanup());
  repo.addRemote("origin", repo.dir);
  repo.git("fetch", "origin");
  repo.git("remote", "set-url", "origin", join(repo.dir, "missing-origin"));
  const f = fixture(repo.dir, [row(1, -1), row(1, 0)], { planState: undefined });
  const inv = f.spec.inventory();
  assert.ok(inv.next, "a fetched empty plan still permits a filing when fetch is unavailable");
  assert.equal(f.logs[0]!.step, "flow.origins_degraded");
  assert.match(String(f.logs[0]!.fields!.reason), /fetch failed.*last fetched origin\/main/s);
  mkdirSync(join(repo.dir, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(repo.dir, "plan", "tasks.d", "broken.yaml"), '- id: W1-T9001\n  origin: "flow-blocker:escalated:metadata-only body red"\n  files: [\n');
  repo.git("add", "."); repo.git("commit", "-qm", "chore: corrupt fixture");
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  assert.throws(() => f.spec.inventory(), /flow plan shards unreadable.*broken.yaml/s);
  repo.git("update-ref", "-d", "refs/remotes/origin/main");
  assert.throws(() => f.spec.inventory(), /origin\/main/, "a real grep error is not an empty plan");
  const noClock = flowGardenSpec({ ...f.deps, clock: undefined }, { ...f.sources, ledgerRecords: () => [], planState: () => ({ tasks: [] }) });
  assert.equal(noClock.inventory().next, undefined);
});
