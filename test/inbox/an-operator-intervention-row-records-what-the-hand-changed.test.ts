import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { fixedClock } from "#src/lib/clock.js";
import { listFeedback } from "#src/lib/feedback.js";
import {
  fixLaneGardenSpec, fixLaneInventoryOf, handBuildsFromPullRequests, interventionsFromPullRequest, OPERATOR_INTERVENTION_HOURS,
  readOperatorInterventions, withHandCommitFiles, type FixLaneSources, type InterventionRead, type ListedPullRequest, type OperatorIntervention,
} from "#src/lib/fix-lane-gardener.js";
import {
  HAND_BUILD_ACTION, interventionFingerprint, interventionFromLedgerRow, interventionIncidentEvent, interventionLedgerFields,
  interventionLedgerLine, MAX_EVIDENCE_FILES, type OperatorInterventionRow,
} from "#src/lib/operator-interventions.js";
import type { LedgerRecord } from "#src/lib/retro.js";
import { incidentFeedbackId, interventionCountDoubled, runSreLanePass, type IncidentLedgerEvent } from "#src/lib/sre-lane.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { ghShim, type GhShimRoute } from "#test/helpers/gh-shim.js";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-11-15T12:00:00.000Z");
const T = (hhmm: string) => `2026-11-15T${hhmm}:00.000Z`;
const SHA = (c: string) => c.repeat(40);

function tmp(t: TestContext, stem: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}${stem}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Runs `fn` with a PATH-stubbed `gh` answering from `routes`; any call no route scripted fails loudly. */
async function withGh<T>(t: TestContext, routes: GhShimRoute[], fn: (calls: () => string[]) => T | Promise<T>): Promise<T> {
  const shim = ghShim([...routes, { when: "", stderr: "hand-evidence test: unexpected gh call", exit: 1 }], { kind: "hand-evidence-gh" });
  t.after(() => rmSync(shim.dir, { recursive: true, force: true }));
  const saved = process.env.PATH;
  process.env.PATH = `${shim.dir}:${saved}`;
  try { return await fn(() => shim.calls()); } finally { process.env.PATH = saved; }
}

const commit = (oid: string, committedDate: string, login: string, extra: Record<string, unknown> = {}) =>
  ({ commit: { oid, committedDate, message: "fix(ci): hand fix", parents: { totalCount: 1, nodes: [{ oid: SHA("f") }] }, author: { name: login, user: { login } }, ...extra } });

/** A fleet PR the operator pushed one commit to, on top of the fleet's own head `ffff…`. */
const FLEET_NODE = {
  author: { login: "remudero-fleet[bot]" }, state: "OPEN",
  commits: { nodes: [
    commit(SHA("f"), T("09:00"), "remudero-fleet[bot]"),
    commit(SHA("a"), T("10:00"), "craigoley", { additions: 12, deletions: 3 }),
  ] },
};

const churnFiles = (n: number) => Array.from({ length: n }, (_, i) => ({ path: `src/lib/f${String(i).padStart(2, "0")}.ts`, additions: i, deletions: 1 }));

test("W1-T12836 criterion 1: a hand push row carries its commit, the fleet head it followed, its files and its line counts", async () => {
  const [push] = interventionsFromPullRequest(18000, FLEET_NODE, Date.parse(T("00:00")));
  assert.equal(push!.kind, "push");
  assert.deepEqual(push!.evidence, { commit: SHA("a"), prior_head: SHA("f"), insertions: 12, deletions: 3 },
    "the full hand sha, the fleet head it followed, and the commit's own line counts, read from the commits the pass already fetches");

  // The files come from the hand commit itself, most-changed first and bounded.
  const read: InterventionRead = { ok: true, interventions: [push!] };
  const asked: string[] = [];
  const enriched = await withHandCommitFiles({ owner: "acme", repo: "remudero", commitFiles: async (oid) => { asked.push(oid); return churnFiles(25); } }, read, []);
  assert.deepEqual(asked, [SHA("a")]);
  const evidence = enriched.ok ? enriched.interventions[0]!.evidence! : undefined;
  assert.equal(evidence!.files!.length, MAX_EVIDENCE_FILES, "the file list is bounded");
  assert.equal(evidence!.files_total, 25, "and says how many files the commit really changed");
  assert.equal(evidence!.files![0], "src/lib/f24.ts", "most-changed first");
  assert.equal(evidence!.commit, SHA("a"));
  assert.equal(evidence!.insertions, 12, "the commit's own counts survive the file read");

  // The row the fix-lane pass writes carries the evidence, and it round-trips through the ledger.
  const inv = fixLaneInventoryOf([], [], new Map(), enriched, NOW);
  const row = inv.interventions.fresh[0]!;
  assert.deepEqual(row.evidence, evidence);
  assert.deepEqual(interventionLedgerFields(row).evidence, evidence);
  assert.deepEqual(interventionFromLedgerRow(interventionLedgerLine(row) as Record<string, unknown>)!.evidence, evidence);

  // A push the ledger already holds is never re-read; a failed read keeps the row and says why.
  const recorded = [interventionLedgerLine(row) as unknown as LedgerRecord];
  const again = await withHandCommitFiles({ owner: "acme", repo: "remudero", commitFiles: async () => { throw new Error("must not read"); } }, read, recorded);
  assert.equal(again.ok && again.interventions[0]!.evidence!.files, undefined);
  const failed = await withHandCommitFiles({ owner: "acme", repo: "remudero", commitFiles: async () => { throw new Error("HTTP 502"); } }, read, []);
  assert.equal(failed.ok && failed.interventions[0]!.evidence!.files_unread, "HTTP 502");
  assert.equal(failed.ok && failed.interventions[0]!.evidence!.commit, SHA("a"));
  const unknown: InterventionRead = { ok: false, reason: "graphql down" };
  assert.equal(await withHandCommitFiles({ owner: "acme", repo: "remudero" }, unknown, []), unknown);
});

test("W1-T12836 criterion 1: the default commit-file reader really asks GitHub for the hand commit, and names a bad answer", async (t) => {
  const read: InterventionRead = { ok: true, interventions: [
    { pr: 1, at: T("10:00"), kind: "push", actor: "craigoley", ref: "aaaaaaaaa", detail: "x", evidence: { commit: SHA("a") } },
    { pr: 2, at: T("10:05"), kind: "push", actor: "craigoley", ref: "bbbbbbbbb", detail: "x", evidence: { commit: SHA("b") } },
    { pr: 3, at: T("10:10"), kind: "push", actor: "craigoley", ref: "ccccccccc", detail: "x", evidence: { commit: SHA("c") } },
  ] };
  const out = await withGh(t, [
    { when: `repos/acme/remudero/commits/${SHA("a")}`, stdout: JSON.stringify({ files: [{ filename: "README.md", additions: 1, deletions: 0 }, { filename: "src/lib/sweep.ts", additions: 9, deletions: 4 }] }) },
    { when: `repos/acme/remudero/commits/${SHA("b")}`, stdout: JSON.stringify({ sha: SHA("b") }) },
  ], () => withHandCommitFiles({ owner: "acme", repo: "remudero" }, read, []));
  assert.ok(out.ok);
  assert.deepEqual(out.interventions[0]!.evidence!.files, ["src/lib/sweep.ts", "README.md"]);
  assert.equal(out.interventions[1]!.evidence!.files_unread, `commit ${SHA("b")} answered no file list`);
  assert.ok(out.interventions[2]!.evidence!.files_unread, "a failed gh read is named, never an empty file list");
  assert.equal(out.interventions[2]!.evidence!.files, undefined);
});

/** The task's fleet run failed at 08:00; the operator's session PR on the task's run branch merged at 11:00. */
const SESSION_PR: ListedPullRequest = {
  number: 18001, headRefName: "run-W1-T900-1794000000000", author: { login: "craigoley" }, createdAt: T("09:00"),
  state: "MERGED", mergedAt: T("11:00"), mergeCommit: { oid: SHA("d") },
  files: [{ path: "src/lib/sweep.ts", additions: 40, deletions: 10 }, { path: "test/sweep.test.ts", additions: 5, deletions: 0 }],
};
const FLEET_FAILED: LedgerRecord = { step: "verdict", task_id: "W1-T900", run_id: "RUN-1", ts: T("08:00"), verdict: "failed" };

test("W1-T12836 criterion 2: a merged session PR on a run branch of a task the fleet failed is one hand-build row", async (t) => {
  const found = handBuildsFromPullRequests([SESSION_PR], [FLEET_FAILED], Date.parse(T("00:00")));
  assert.equal(found.length, 1);
  const [build] = found;
  assert.equal(build!.kind, HAND_BUILD_ACTION);
  assert.equal(build!.kind, "hand-build");
  assert.equal(build!.actor, "craigoley");
  assert.equal(build!.cause_class, "fleet-run:failed", "the fleet run's last recorded outcome is the cause");
  assert.deepEqual(build!.evidence, { task: "W1-T900", commit: SHA("d"), files: ["src/lib/sweep.ts", "test/sweep.test.ts"], files_total: 2, insertions: 45, deletions: 10 });

  const blocked = { ...FLEET_FAILED, ts: T("09:30"), verdict: "blocked_ci" };
  assert.equal(handBuildsFromPullRequests([SESSION_PR], [FLEET_FAILED, blocked], 0)[0]!.cause_class, "fleet-run:blocked_ci", "the LAST run before the merge names the cause");

  const none = (listed: ListedPullRequest[], records: LedgerRecord[], why: string) => assert.deepEqual(handBuildsFromPullRequests(listed, records, 0), [], why);
  none([{ ...SESSION_PR, author: { login: "remudero-fleet[bot]" } }], [FLEET_FAILED], "a fleet-authored PR is the fleet's own build");
  none([{ ...SESSION_PR, headRefName: "run-unfiled-1794000000000" }], [FLEET_FAILED], "an unfiled branch names no task");
  none([{ ...SESSION_PR, state: "OPEN", mergedAt: null }], [FLEET_FAILED], "an unmerged PR finished nothing");
  none([SESSION_PR], [], "a task the fleet never ran is not a hand build");
  none([SESSION_PR], [{ ...FLEET_FAILED, ts: T("11:30") }], "a fleet run after the merge did not precede it");
  none([SESSION_PR], [FLEET_FAILED, { ...FLEET_FAILED, ts: T("09:00"), verdict: "merged" }], "a task a fleet run merged has a merged fleet PR");
  none([SESSION_PR], [FLEET_FAILED, { step: "verdict.merged", task_id: "W1-T900", ts: T("09:00") }], "verdict.merged is a merged fleet PR");
  none([SESSION_PR], [{ ...FLEET_FAILED, verdict: "awaiting_merge" }], "a run still awaiting its merge has not ended");
  none([{ ...SESSION_PR, author: {} }], [FLEET_FAILED], "an unreadable author is not a hand");
  assert.deepEqual(handBuildsFromPullRequests([SESSION_PR], [FLEET_FAILED], Date.parse(T("11:30"))), [], "a merge before the window is out of it");

  // The pass writes it as one row: action hand-build, the task in its target and evidence, the merged change's files.
  const inv = fixLaneInventoryOf([FLEET_FAILED], [], new Map(), { ok: true, interventions: found }, NOW);
  assert.equal(inv.interventions.fresh.length, 1);
  const row = inv.interventions.fresh[0]!;
  assert.deepEqual({ ...row, evidence: undefined }, { at: T("11:00"), surface: "pr", action: "hand-build", target: "pr#18001@W1-T900",
    actor: "craigoley", cause_class: "fleet-run:failed", source: "github", evidence: undefined });
  assert.deepEqual(row.evidence!.files, ["src/lib/sweep.ts", "test/sweep.test.ts"]);

  // The real reader derives it from the PR list it already reads, with the ledger handed in.
  const read = await withGh(t, [
    { when: "api graphql", stdout: JSON.stringify({ data: { repository: { p7: { ...FLEET_NODE, commits: { nodes: [] } } } } }) },
    { when: "pr list", stdout: JSON.stringify([SESSION_PR]) },
  ], (calls) => {
    const r = readOperatorInterventions({ owner: "acme", repo: "remudero" }, [7], 0, [FLEET_FAILED]);
    assert.match(calls().find((c) => c.includes("api graphql"))!, /additions deletions parents\(first:1\) \{ totalCount nodes \{ oid \} \}/);
    assert.match(calls().find((c) => c.includes("pr list"))!, /number,headRefName,author,createdAt,files,state,mergedAt,mergeCommit/);
    return r;
  });
  assert.deepEqual(read.ok && read.interventions.map((i) => [i.pr, i.kind, i.cause_class]), [[18001, "hand-build", "fleet-run:failed"]]);
});

test("W1-T12836 criterion 2: the daemon's async inventory hands the ledger to the reader and fills new hand pushes' files", async () => {
  const records: LedgerRecord[] = [FLEET_FAILED];
  const [push] = interventionsFromPullRequest(18000, FLEET_NODE, 0);
  let seen: readonly LedgerRecord[] | undefined;
  const sources: FixLaneSources = {
    owner: "acme", repo: "remudero", mintTaskId: () => "W1-T1", ledgerRecords: () => records, planState: () => ({ tasks: [] }),
    prOutcomes: () => new Map(),
    interventions: (_prs, sinceMs, ledger) => { seen = ledger; return { ok: true, interventions: [push!, ...handBuildsFromPullRequests([SESSION_PR], ledger, sinceMs)] }; },
    commitFiles: async () => [{ path: "src/lib/sweep.ts", additions: 2, deletions: 1 }],
  };
  const spec = fixLaneGardenSpec({ repoRoot: ".", stateDir: ".", clock: fixedClock(NOW), log: () => {},
    openWorkspace: () => { throw new Error("unexpected workspace"); } }, sources);
  const inv = await spec.inventoryAsync!() as ReturnType<typeof fixLaneInventoryOf>;
  assert.equal(seen, records);
  assert.deepEqual(inv.interventions.fresh.map((r) => [r.action, r.evidence?.files]),
    [["push", ["src/lib/sweep.ts"]], ["hand-build", ["src/lib/sweep.ts", "test/sweep.test.ts"]]]);
  const sync = spec.inventory() as ReturnType<typeof fixLaneInventoryOf>;
  assert.equal(sync.interventions.fresh[0]!.evidence!.files, undefined, "the synchronous inventory never spawns a commit read");
});

test("W1-T12836 criterion 3: push, update-branch, merge and close rows and prices are unchanged", () => {
  const node = {
    author: { login: "remudero-fleet[bot]" }, state: "MERGED", mergedAt: T("11:00"), mergedBy: { login: "craigoley" },
    commits: { nodes: [
      commit(SHA("1"), T("08:00"), "remudero-fleet[bot]"),
      commit(SHA("2"), T("09:00"), "craigoley", { message: "Merge branch 'main' into run-W1-T1-1", parents: { totalCount: 2, nodes: [{ oid: SHA("1") }] } }),
      commit(SHA("3"), T("10:00"), "craigoley", { additions: 4, deletions: 1 }),
    ] },
  };
  const closed = { author: { login: "remudero-fleet[bot]" }, state: "CLOSED", commits: { nodes: [] },
    timelineItems: { nodes: [{ createdAt: T("10:30"), actor: { login: "codex" } }] } };
  const found = [...interventionsFromPullRequest(500, node, 0), ...interventionsFromPullRequest(501, closed, 0)];
  const records: LedgerRecord[] = [
    { step: "sweep.disposed", pr_number: 500, ts: T("07:00"), blocker: "own-red", blocker_owner: "fix-lane", reason: "required checks red" },
    { step: "pr.terminal", pr_number: 500, ts: T("11:00") },
  ];
  const base = fixLaneInventoryOf(records, [], new Map(), { ok: true, interventions: found }, NOW);
  const fields = (r: OperatorInterventionRow) => [r.at, r.surface, r.action, r.target, r.actor, r.cause_class, r.source];
  assert.deepEqual(base.interventions.fresh.map(fields), [
    [T("09:00"), "pr", "update-branch", "pr#500@222222222", "craigoley", "own-red:fix-lane:required-checks-red", "github"],
    [T("10:00"), "pr", "push", "pr#500@333333333", "craigoley", "own-red:fix-lane:required-checks-red", "github"],
    [T("10:30"), "pr", "close", `pr#501@${T("10:30")}`, "codex", "undisposed:none", "github"],
    [T("11:00"), "pr", "merge", "pr#500@merge", "craigoley", "own-red:fix-lane:required-checks-red", "github"],
  ], "every field origin/main records keeps its value");
  assert.equal(base.interventions.fresh.find((r) => r.action === "update-branch")!.evidence, undefined, "an update-branch carries main's diff, not the hand's");
  assert.equal(base.interventions.fresh.find((r) => r.action === "merge")!.evidence, undefined);
  assert.equal(base.interventions.fresh.find((r) => r.action === "close")!.evidence, undefined);

  // Each standalone intervention is priced its blocked span plus OPERATOR_INTERVENTION_HOURS, exactly as before.
  const hours = (inv: typeof base) => inv.episodes.flatMap((e) => e.charges.map((c) => [c.pr, c.key, Number(c.hours.toFixed(4))]));
  assert.deepEqual(hours(base), [
    [500, "own-red:fix-lane:required-checks-red", 2 + OPERATOR_INTERVENTION_HOURS],
    [500, "own-red:fix-lane:required-checks-red", 1 + OPERATOR_INTERVENTION_HOURS],
    [501, "undisposed:none", OPERATOR_INTERVENTION_HOURS],
    [500, "own-red:fix-lane:required-checks-red", OPERATOR_INTERVENTION_HOURS],
  ]);
  assert.equal(base.interventions.total, 4);
  assert.deepEqual([...base.interventions.byClass], [["own-red:fix-lane:required-checks-red", 3], ["undisposed:none", 1]]);

  // A hand build rides along as a row of its own and never moves the fix lane's prices or counts.
  const build: OperatorIntervention = handBuildsFromPullRequests([SESSION_PR], [FLEET_FAILED], 0)[0]!;
  const withBuild = fixLaneInventoryOf([...records, FLEET_FAILED], [], new Map(), { ok: true, interventions: [...found, build] }, NOW);
  assert.deepEqual(hours(withBuild), hours(base));
  assert.equal(withBuild.interventions.total, base.interventions.total);
  assert.deepEqual([...withBuild.interventions.byClass], [...base.interventions.byClass]);
  assert.deepEqual(withBuild.priced, base.priced);
  assert.deepEqual(withBuild.interventions.fresh.map(fields).filter((f) => f[2] !== "hand-build"), base.interventions.fresh.map(fields));
  assert.equal(withBuild.interventions.fresh.filter((r) => r.action === "hand-build").length, 1);
  assert.ok(HOUR > 0);
});

const pushRow = (file: string | undefined, at = T("10:00")): OperatorInterventionRow => ({
  at, surface: "pr", action: "push", target: `pr#1@${at}`, actor: "craigoley", cause_class: "own-red:fix-lane:required-checks-red", source: "github",
  ...(file === undefined ? {} : { evidence: { commit: SHA("a"), files: [file, "README.md"] } }),
});

test("W1-T12836 criterion 4: a PR intervention incident keys on cause class and most-changed file, and an open incident re-files when its count doubles", async (t) => {
  const sweep = interventionIncidentEvent(pushRow("src/lib/sweep.ts"), NOW);
  const sweepLater = interventionIncidentEvent(pushRow("src/lib/sweep.ts", T("11:00")), NOW);
  const review = interventionIncidentEvent(pushRow("src/lib/review.ts"), NOW);
  assert.equal(sweep.fingerprint, sweepLater.fingerprint, "one class on one file is one incident");
  assert.notEqual(sweep.fingerprint, review.fingerprint, "one class on two files is two incidents");
  assert.equal(sweep.fingerprint, interventionFingerprint("own-red:fix-lane:required-checks-red", "src/lib/sweep.ts"));
  assert.notEqual(sweep.fingerprint, interventionFingerprint("own-red:fix-lane:required-checks-red"), "the class alone is no longer the key");
  assert.equal(sweep.name, "own-red:fix-lane:required-checks-red");
  assert.match(String(sweep.subject), /file=src\/lib\/sweep\.ts$/);
  // A row with no recorded file, and every control row, keeps the class-only key.
  assert.equal(interventionIncidentEvent(pushRow(undefined), NOW).fingerprint, interventionFingerprint("own-red:fix-lane:required-checks-red"));
  const control: OperatorInterventionRow = { at: T("10:00"), surface: "control", action: "fleet.resume", target: "core", actor: "operator_human",
    cause_class: "hold-ended:unrecorded-hold", source: "ledger", evidence: { files: ["src/x.ts"] } };
  assert.equal(interventionIncidentEvent(control, NOW).fingerprint, interventionFingerprint("hold-ended:unrecorded-hold"));

  // The doubling rule.
  assert.equal(interventionCountDoubled({ kind: "intervention", count: 7 }, { ts: T("00:00"), count: 4 }), false);
  assert.equal(interventionCountDoubled({ kind: "intervention", count: 8 }, { ts: T("00:00"), count: 4 }), true);
  assert.equal(interventionCountDoubled({ kind: "exception", count: 80 }, { ts: T("00:00"), count: 4 }), false, "only intervention incidents re-file on count");
  assert.equal(interventionCountDoubled({ kind: "intervention", count: 80 }, { ts: T("00:00") }), false, "a filing with no recorded count has no base");
  assert.equal(interventionCountDoubled({ kind: "intervention", count: 80 }, undefined), false);

  // End to end: file at 4, an open/accepted incident holds at 7, files again at 8 under its own id.
  const root = tmp(t, "hand-evidence-sre");
  mkdirSync(join(root, "state"), { recursive: true });
  const fp = sweep.fingerprint;
  const events = (n: number): IncidentLedgerEvent[] => Array.from({ length: n }, (_, i) =>
    ({ fingerprint: fp, ts: Date.parse(T("06:00")) + i * 60_000, kind: "intervention", name: sweep.name as string,
      // Each synthetic event is a distinct intervention, so each names its own (a real routing message names its row).
      message: `m${i}`, instance: "core" }));
  let count = 4;
  let accepted = false;
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const pass = () => runSreLanePass({
    stateDir: join(root, "state"), root, mergedLastDay: () => 10, clock: fixedClock(NOW), detectors: [],
    readFlowRows: () => [], writeFlowEvent: () => {}, readEvents: () => events(count), hasOpenTask: () => accepted,
    framesFor: () => [], mergedPrsSince: () => [], readLandedEntry: () => null, log: (step, extra) => logs.push({ step, extra }),
  });
  assert.equal((await pass()).filed, fp);
  assert.deepEqual(listFeedback(root).map((e) => e.id), [incidentFeedbackId(fp)]);
  accepted = true;
  count = 7;
  assert.equal((await pass()).filed, undefined, "below double, the open and accepted incident is already in hand");
  count = 8;
  assert.equal((await pass()).filed, fp, "at double, it is filed again");
  assert.deepEqual(listFeedback(root).map((e) => e.id).sort(), [incidentFeedbackId(fp), `${incidentFeedbackId(fp)}-n8`].sort());
  const refiled = logs.filter((l) => l.step === "sre_lane.filed").at(-1)!.extra!;
  assert.equal(refiled.refiled, true);
  assert.equal(refiled.prior_count, 4);
  count = 15;
  assert.equal((await pass()).filed, undefined, "the re-filing is the new base: 15 is under twice 8");
});
