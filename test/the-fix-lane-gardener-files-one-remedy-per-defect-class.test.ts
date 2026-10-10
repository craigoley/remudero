import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fixedClock } from "../src/lib/clock.js";
import { ciFrictionRecordVerdict } from "../src/lib/ci-friction-gardener.js";
import {
  defectEventsOf, FIXLANE_REPORT_FILE, FIXLANE_REPORT_STEP, fixLaneGardenSpec, interventionsFromPullRequest, OPERATOR_INTERVENTION_HOURS,
  type FixLaneSources, type InterventionRead, type OperatorIntervention,
} from "../src/lib/fix-lane-gardener.js";
import { gardenSchedule, REGISTERED_GARDEN_NAMES } from "../src/lib/garden-registry.js";
import type { GardenerDeps } from "../src/lib/gardener.js";
import type { LedgerRecord } from "../src/lib/retro.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { GARDEN_BRANCH_RE, GARDEN_NAMES } from "../src/run-task.js";

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 9, 10, 12);
const iso = (hours: number) => fixedClock(NOW + hours * HOUR).iso();
const url = (pr: number) => `https://github.com/acme/remudero/pull/${pr}`;
const BRANCH_MOVED = "branch moved during fix round";

const sweep = (pr: number, hours: number, owner: string, blocker = "own-red", head = `head${pr}`): LedgerRecord =>
  ({ step: "sweep.disposed", pr_number: pr, ts: iso(hours), blocker, reason: "ci red", blocker_owner: owner, head_sha: head });
const refused = (pr: number, hours: number, reason = BRANCH_MOVED, extra: Record<string, unknown> = {}): LedgerRecord =>
  ({ step: "fix.commit_refused", pr_url: url(pr), ts: iso(hours), reason, ...extra });
const push = (pr: number, hours: number): OperatorIntervention =>
  ({ pr, at: iso(hours), kind: "push", actor: "craigoley", detail: "commit abc123def pushed to a fleet PR" });

/** PR 10 was held by the fix lane for 2h on a moved branch; PR 12 had one unstated round; PRs 11 and 13 saw operator pushes. */
const LEDGER: LedgerRecord[] = [
  sweep(10, -10.5, "fix-lane"), refused(10, -10), sweep(10, -9, "fix-lane"), sweep(10, -8, "ci", "awaiting-ci"),
  sweep(12, -6, "fix-lane"), { step: "fix.done", pr_url: url(12), ts: iso(-6), fix_outcome: "unstated", round_id: "r12", elapsed_ms: 1_800_000 },
];
const OPERATOR: InterventionRead = { ok: true, interventions: [push(11, -3), push(11, -2), push(13, -1)] };

function fixture(root: string, over: Partial<FixLaneSources> = {}, records: LedgerRecord[] = LEDGER) {
  const logs: Array<{ step: string; fields?: Record<string, unknown> }> = [];
  const deps: GardenerDeps = {
    repoRoot: root, stateDir: root, clock: fixedClock(NOW), log: (step, fields) => logs.push({ step, fields }),
    openWorkspace: () => { throw new Error("unexpected workspace"); },
  };
  let minted = 0;
  const sources: FixLaneSources = {
    owner: "acme", repo: "remudero", mintTaskId: () => { minted++; return "W1-T9101"; },
    ledgerRecords: () => records, planState: () => ({ tasks: [] }), prOutcomes: () => new Map(), interventions: () => OPERATOR,
    ownerSearch: { filesContaining: () => [{ file: "src/lib/sweep.ts", hits: 1 }], fileExists: () => true },
    ...over,
  };
  return { spec: fixLaneGardenSpec(deps, sources), logs, minted: () => minted };
}
const workspace = (root: string) => ({ root, branch: "fix-lane-garden-123", land: () => { throw new Error("unexpected landing"); }, dispose: () => {} });
const openRemedy = (cause: string) => ({ id: "W1-T9100", origin: `fix-lane:${cause}`, status: "queued", retired: false, files: ["src/lib/sweep.ts"] });

test("a fixture ledger with operator pushes on fleet PRs and a refusal class yields exactly one remedy draft for the top-priced class and none for a class whose remedy is still open", (t) => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}fix-lane-filing-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const refusalCause = `commit-refused:${BRANCH_MOVED}`;
  const f = fixture(root, { planState: () => ({ tasks: [openRemedy(refusalCause)] }) });
  const inv = f.spec.inventory();
  assert.equal(inv.priced[0]!.key, "operator-intervention:push", "three operator pushes outprice a 2 h refusal and a 0.5 h unstated round");
  assert.equal(inv.priced[0]!.hours > 3 * OPERATOR_INTERVENTION_HOURS * 0.9, true, "each intervention is priced");
  assert.deepEqual(inv.priced.map(p => p.key).sort(), ["fix-outcome:unstated", refusalCause, "operator-intervention:push"].sort());
  assert.equal(inv.ladder.find(l => l.cause === refusalCause)!.state, "in_progress", "the refusal class's remedy is open");
  const actions = f.spec.candidates(inv, () => 0);
  assert.equal(actions.length, 1, "exactly one draft per pass");
  assert.equal(actions[0]!.origin, "fix-lane:operator-intervention:push");
  const scorecard = f.spec.scorecard(inv, { actions, acting: ["draft"] });
  const landing = f.spec.apply(workspace(root), { actions: [...actions, ...actions], acting: ["draft"] }, scorecard)!;
  assert.equal(f.minted(), 1, "one task id minted for one draft");
  assert.equal(landing.paths.length, 1);
  const text = readFileSync(join(root, landing.paths[0]!), "utf8");
  assert.equal(ciFrictionRecordVerdict(text, "fix-lane fixture").ok, true);
  assert.match(text, /origin: "fix-lane:operator-intervention:push"/);
  assert.doesNotMatch(text, /commit-refused/, "no draft is filed for the class whose remedy is open");
  assert.equal(readdirSync(join(root, "plan", "tasks.d")).length, 1);
  assert.match(landing.title, /^chore\(plan\): draft a fix-lane remedy for /);
  // with the top class's remedy open too, the next-priced class is the one drafted, still exactly one.
  const both = fixture(root, { planState: () => ({ tasks: [openRemedy(refusalCause), openRemedy("operator-intervention:push")] }) });
  const next = both.spec.candidates(both.spec.inventory(), () => 0);
  assert.deepEqual(next.map(a => a.origin), ["fix-lane:fix-outcome:unstated"]);
  // every class open: nothing is drafted.
  const all = fixture(root, { planState: () => ({ tasks: ["operator-intervention:push", refusalCause, "fix-outcome:unstated"].map(openRemedy) }) });
  assert.deepEqual(all.spec.candidates(all.spec.inventory(), () => 0), []);
});

test("dropping the operator-intervention reader leaves the intervention-only class undrafted, and an unreadable source is unknown, never zero", (t) => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}fix-lane-unknown-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const only: LedgerRecord[] = [];
  const none = fixture(root, { interventions: () => ({ ok: true, interventions: [] }) }, only);
  assert.deepEqual(none.spec.candidates(none.spec.inventory(), () => 0), []);
  const withPushes = fixture(root, {}, only);
  assert.deepEqual(withPushes.spec.candidates(withPushes.spec.inventory(), () => 0).map(a => a.origin), ["fix-lane:operator-intervention:push"]);
  const unreadable = fixture(root, { interventions: () => ({ ok: false, reason: "graphql: rate limited" }) });
  const inv = unreadable.spec.inventory();
  unreadable.spec.scorecard(inv, { actions: [], acting: [] });
  const rows = unreadable.logs.filter(l => l.step === FIXLANE_REPORT_STEP);
  assert.ok(rows.length > 0);
  for (const row of rows) {
    assert.equal(row.fields!.interventions, null, "unknown is reported as null, not 0");
    assert.equal(row.fields!.interventions_unknown, "graphql: rate limited");
  }
  assert.match(readFileSync(join(root, FIXLANE_REPORT_FILE), "utf8"), /Operator interventions: UNKNOWN — graphql: rate limited/);
});

test("the pass writes one fixlane.report row per class and the markdown beside it", (t) => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}fix-lane-report-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const f = fixture(root, { planState: () => ({ tasks: [openRemedy(`commit-refused:${BRANCH_MOVED}`)] }) });
  const inv = f.spec.inventory();
  f.spec.scorecard(inv, { actions: [], acting: [] });
  const rows = f.logs.filter(l => l.step === "fixlane.report").map(l => l.fields!);
  const refusal = rows.find(r => r.class === `commit-refused:${BRANCH_MOVED}`)!;
  assert.equal(refusal.count, 1);
  assert.equal(refusal.open_remedy, "in_progress");
  assert.equal(Number(refusal.hours) > 1.5, true);
  assert.equal(rows.find(r => r.class === "operator-intervention:push")!.interventions, 3);
  assert.equal(rows.find(r => r.class === null)!.interventions, 3, "the summary row carries the headline count");
  const md = readFileSync(join(root, FIXLANE_REPORT_FILE), "utf8");
  assert.match(md, /Operator interventions in the window: 3 \(target 0\)/);
  assert.match(md, new RegExp(`\\| commit-refused:${BRANCH_MOVED} \\|`));
});

test("an operator intervention is attributed to the defect class of its PR and adds its weight there", (t) => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}fix-lane-attr-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const f = fixture(root, { interventions: () => ({ ok: true, interventions: [push(10, -7)] }) });
  const inv = f.spec.inventory();
  assert.equal(inv.priced.some(p => p.key === "operator-intervention:push"), false, "a push on a PR with a defect event is not its own class");
  const refusal = inv.priced.find(p => p.key === `commit-refused:${BRANCH_MOVED}`)!;
  const base = fixture(root, { interventions: () => ({ ok: true, interventions: [] }) }).spec.inventory().priced.find(p => p.key === refusal.key)!;
  assert.equal(refusal.hours - base.hours > 0.9 * OPERATOR_INTERVENTION_HOURS, true, "the attributed intervention adds its weight to the class");
  assert.equal(inv.priced.reduce((n, p) => n + p.hours, 0) - fixture(root, { interventions: () => ({ ok: true, interventions: [] }) }).spec.inventory().priced.reduce((n, p) => n + p.hours, 0) < 1.01 * OPERATOR_INTERVENTION_HOURS, true, "and nothing else");
});

test("the defect classes are normalised from the fix lane's ledger rows", () => {
  const rows: LedgerRecord[] = [
    sweep(20, -30, "fix-lane", "own-red", "aaaaaaaa1"),
    { step: "fix.dispatch", pr_url: url(20), ts: iso(-29), round_id: "a", ci_failures: [{ check: "coverage (2/8)", signature: "s" }] },
    { step: "fix.done", pr_url: url(20), ts: iso(-28.9), round_id: "a", fix_outcome: "FLAKE", worker_tail: "state/runs/a.tail" },
    { step: "fix.dispatch", pr_url: url(20), ts: iso(-27), round_id: "b", ci_failures: [{ check: "coverage (4/8)", signature: "s" }] },
    { step: "fix.done", pr_url: url(20), ts: iso(-26.9), round_id: "b", fix_outcome: "FLAKE" },
    { step: "fix.done", pr_url: url(21), ts: iso(-20), round_id: "c", fix_outcome: "FIXED", pushed_head_sha: "bbbbbbbb2", worker_tail: "state/runs/c.tail" },
    sweep(21, -19, "fix-lane", "own-red", "bbbbbbbb2"),
    refused(22, -18, "the worker changed nothing", { round_id: "d" }),
    { step: "fix.done", pr_url: url(22), ts: iso(-18), round_id: "d", fix_outcome: "FIXED", selected_model: "sonnet", effort: "low", elapsed_ms: 40_000 },
    refused(23, -17, "files outside the declared set", { undeclared: ["src/lib/other.ts"] }),
    { step: "fix.stood_down", pr_url: url(24), ts: iso(-16), site: "rung.empty_ci_failures", reason: "no failing test extractable" },
    { step: "fix.stood_down", pr_url: url(24), ts: iso(-15), site: "rung.ci_handoff", outcome: "handed_off", reason: "freshness_yield" },
    { step: "fix.stood_down", pr_url: url(25), ts: iso(-14), site: "rung.strike", reason: "strike cap 3 reached at abcdef123456" },
    { step: "sweep.disposed", pr_number: 26, ts: iso(-13), blocker: "awaiting-arm", disposition: "mergeable", acted: true, reason: "arming auto-merge", blocker_owner: "arm", head_sha: "h26" },
    { step: "automerge.arm_skipped", pr_url: url(26), ts: iso(-12.95), reason: "operator merge hold" },
  ];
  const keys = defectEventsOf(rows, NOW).map(e => e.key).sort();
  assert.deepEqual(keys, [
    "commit-refused:outside declared files", "commit-refused:the worker changed nothing", "disposition-disagrees-with-arm", "flake-repeated",
    "fixed-still-red", "red-no-actionable-test", "stood-down:rung.strike:strike cap <n> reached at <sha>",
  ].sort(), "a handoff is not a defect; a repeated FLAKE on a changing set is");
  const weak = defectEventsOf(rows, NOW).find(e => e.key === "commit-refused:the worker changed nothing")!;
  assert.match(weak.evidence, /selected_model sonnet, effort low, 40s/, "a no-change round cites its model, effort and duration");
  const still = defectEventsOf(rows, NOW).find(e => e.key === "fixed-still-red")!;
  assert.match(still.evidence, /worker saw: state\/runs\/c\.tail/, "evidence cites the worker tail");
});

test("an intervention is read from a fleet PR's non-fleet pushes and closes only", () => {
  const fleet = { author: { login: "remudero-fleet" }, state: "CLOSED",
    commits: { nodes: [
      { commit: { oid: "1111111111", committedDate: iso(-5), author: { name: "remudero-fleet[bot]", user: null } } },
      { commit: { oid: "2222222222", committedDate: iso(-4), author: { name: "Craig", user: { login: "craigoley" } } } },
      { commit: { oid: "3333333333", committedDate: iso(-24 * 30), author: { name: "Craig", user: { login: "craigoley" } } } },
    ] },
    timelineItems: { nodes: [{ createdAt: iso(-3), actor: { login: "craigoley" } }, { createdAt: iso(-2), actor: { login: "remudero-fleet" } }] } };
  const found = interventionsFromPullRequest(30, fleet, NOW - 14 * 24 * HOUR);
  assert.deepEqual(found.map(i => [i.kind, i.actor]), [["push", "craigoley"], ["close", "craigoley"]]);
  assert.deepEqual(interventionsFromPullRequest(31, { ...fleet, author: { login: "craigoley" } }, 0), [], "an operator's own PR is not a fleet PR");
  assert.deepEqual(interventionsFromPullRequest(32, { ...fleet, state: "MERGED", timelineItems: fleet.timelineItems }, 0).map(i => i.kind), ["push", "push"],
    "a merge's closed event is not an operator close");
});

test("a merged remedy that did not lower the class's share reopens one rung up", (t) => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}fix-lane-rung-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cause = `commit-refused:${BRANCH_MOVED}`;
  const records = [sweep(10, -30, "fix-lane"), refused(10, -29), sweep(10, -26, "ci", "awaiting-ci"),
    sweep(14, -10, "fix-lane"), refused(14, -9), sweep(14, -5, "ci", "awaiting-ci")];
  const merged = { ...openRemedy(cause), mergedAt: iso(-20) };
  const f = fixture(root, { planState: () => ({ tasks: [merged] }), interventions: () => ({ ok: true, interventions: [] }) }, records);
  const next = f.spec.candidates(f.spec.inventory(), () => 0);
  assert.equal(next[0]!.origin, `fix-lane:${cause}#r2`);
  assert.equal(next[0]!.prior!.effect!.verdict, "debit");
});

test("the fix-lane garden is registered, scheduled daily and branch-named like every garden", () => {
  assert.ok(REGISTERED_GARDEN_NAMES.includes("fix-lane"));
  assert.ok(GARDEN_NAMES.includes("fix-lane"));
  assert.equal(GARDEN_BRANCH_RE.test("fix-lane-garden-123"), true);
  assert.equal(GARDEN_BRANCH_RE.test("fix-lane-garden-x"), false);
  assert.equal(gardenSchedule("fix-lane").intervalFor(60_000), 60 * 60_000, "an hourly due probe finds the new UTC day");
});
