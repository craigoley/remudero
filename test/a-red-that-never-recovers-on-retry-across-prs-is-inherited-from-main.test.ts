// W1-T9551: the flake-incident gardener filed W1-T9532 (#11790) for a test that failed on #11705, #11735
// and #11769 with 0 of 3 retries recovered, after main-repair had already fixed it in #11782; and on
// 2026-10-15 W1-T9668 (#12057) for one main itself failed on 9 PRs, 0 of 9 recovered. Neither was a flake.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { fixedClock } from "#src/lib/clock.js";
import type { IssueGateway } from "#src/lib/escalate.js";
import {
  FLAKE_INCIDENT_MAIN_INHERITED_STEP as GARDENER_STEP, flakeIncidentOrigin, runFlakeIncidentGardener, type FlakeIncidentSources,
} from "#src/lib/flake-incident-gardener.js";
import { selectorShadowGardenPass } from "#src/lib/garden-registry.js";
import {
  buildMainHealthRung, MAIN_INHERITED_HINT_SOURCE_STEP, mainInheritedHintReader, type MainHealthRungDeps,
} from "#src/lib/main-health-rung.js";
import type { GhApiFetcher } from "#src/lib/open-prs-rest.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const TEST_FILE = "test/the-core-fleet-fills-the-child-entry-store.test.ts";
const TITLE = "the store-fill fixture carries every child entry";
const NOW = Date.parse("2026-10-14T20:54:00Z");
const W1_T9532_PRS = [11705, 11735, 11769];
// Literal step names: the test pins what each module spells, not only that the two agree.
const FLAKE_INCIDENT_MAIN_INHERITED_STEP = "flake_incident.main_inherited";
const MAIN_INHERITED_HINT_STEPS = {
  covered: "main.health.inherited_hint_covered",
  resolved: "main.health.inherited_hint_resolved",
  confirmed: "main.health.inherited_hint_confirmed",
};

type Row = Record<string, unknown>;

function harness() {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t9551-`));
  mkdirSync(join(root, "state"), { recursive: true });
  mkdirSync(join(root, "plan", "tasks.d"), { recursive: true });
  mkdirSync(join(root, "test"), { recursive: true });
  writeFileSync(join(root, TEST_FILE), "");
  const ledger = join(root, "state", "ledger.ndjson");
  const log = (step: string, extra: Record<string, unknown> = {}) => {
    appendFileSync(ledger, JSON.stringify({ ts: new Date(NOW).toISOString(), step, ...extra }) + "\n");
  };
  const landed: Array<{ paths: string[]; title: string; body: string }> = [];
  const deps = {
    stateDir: join(root, "state"),
    repoRoot: root,
    clock: fixedClock(NOW),
    openWorkspace: () => ({
      root, branch: "selector-shadow-garden-1",
      land: (opts: { paths: string[]; title: string; body: string }) => (landed.push(opts), `https://github.com/acme/remudero/pull/${20000 + landed.length}`),
      dispose: () => {},
    }),
    log,
  };
  const evidence = (pr: number, outcome: "recovered" | "also_failed", title = TITLE) => log("test.flake_retry", {
    file: TEST_FILE, headline: outcome === "recovered" ? "recovered on retry" : "retry also failed", ci_run_id: pr * 10, shard: 5,
    source: "selector-shadow", retry_outcome: outcome, head_sha: `head-${pr}`, base_sha: `base-${pr}`, pr_numbers: [pr], titles: [title],
  });
  const rows = (step: string): Row[] => readFileSync(ledger, "utf8").split("\n").filter(Boolean)
    .map((l) => JSON.parse(l) as Row).filter((r) => r.step === step);
  let minted = 0;
  const sources = (extra: Partial<FlakeIncidentSources> = {}): FlakeIncidentSources => ({
    mintTaskId: () => `W1-T95${String(++minted).padStart(2, "0")}`,
    readChangedPaths: () => ["src/lib/unrelated.ts"],
    planTasks: () => [],
    readSource: () => "",
    ...extra,
  });
  return { root, ledger, log, deps, landed, evidence, rows, sources, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

test("W1-T9551: a red that never recovers on retry across PRs files no flake incident", async () => {
  const h = harness();
  for (const pr of W1_T9532_PRS) h.evidence(pr, "also_failed");
  await runFlakeIncidentGardener(h.deps, h.sources());
  assert.equal(h.landed.length, 0, "0 of 3 retries recovered: W1-T9532's evidence files nothing");
  assert.deepEqual(h.rows("flake_incident.filed"), []);
  const routed = h.rows(FLAKE_INCIDENT_MAIN_INHERITED_STEP);
  assert.equal(routed.length, 1, "one main-inherited row names the red");
  assert.deepEqual([routed[0]!.origin, routed[0]!.prs, routed[0]!.route, routed[0]!.main_red, routed[0]!.base_shas],
    [flakeIncidentOrigin(TEST_FILE, TITLE), W1_T9532_PRS, "main-health", "unread", W1_T9532_PRS.map((pr) => `base-${pr}`)]);

  await runFlakeIncidentGardener(h.deps, h.sources());
  assert.equal(h.rows(FLAKE_INCIDENT_MAIN_INHERITED_STEP).length, 1, "an unchanged PR set is not re-written");
  h.evidence(11801, "also_failed");
  await runFlakeIncidentGardener(h.deps, h.sources());
  assert.equal(h.rows(FLAKE_INCIDENT_MAIN_INHERITED_STEP).length, 2, "a grown PR set is re-written");
  assert.equal(h.landed.length, 0);

  // A later recovered retry makes the group a flake candidate again, but its origin is already handled.
  h.evidence(11802, "recovered");
  await runFlakeIncidentGardener(h.deps, h.sources());
  assert.equal(h.landed.length, 0, "a main-inherited origin counts as handled");
  assert.deepEqual(h.rows("flake_incident.skipped").map((r) => r.reason), ["main-inherited"]);
  h.dispose();
});

test("W1-T9551: a red main also fails at the base files no flake incident", async () => {
  // W1-T9668's shape: nine PRs, every retry also failed, and main's own CI failed the test at their base.
  const prs = [12020, 12021, 12022, 12023, 12024, 12025, 12026, 12027, 12028];
  const read: string[] = [];
  const judged = async (main: (sha: string) => readonly string[] | undefined) => {
    const h = harness();
    for (const pr of prs) h.evidence(pr, "also_failed");
    await runFlakeIncidentGardener(h.deps, h.sources({ mainFailures: (sha) => (read.push(sha), main(sha)) }));
    const routed = h.rows(FLAKE_INCIDENT_MAIN_INHERITED_STEP);
    const out = { landed: h.landed.length, routed, unreadRows: h.rows("flake_incident.main_unread").length };
    h.dispose();
    return out;
  };
  const red = await judged((sha) => (sha === "base-12020" ? [TEST_FILE] : []));
  assert.equal(red.landed, 0, "main red at the base: no flake incident");
  assert.equal(red.routed.length, 1);
  assert.equal(red.routed[0]!.main_red, true);
  assert.equal(red.routed[0]!.main_red_base_sha, "base-12020");
  assert.deepEqual(read, ["base-12020"], "the first red base answers; no further main read");

  const green = await judged(() => []);
  assert.equal(green.landed, 0, "no recovery on nine PRs is main-inherited by the PR count alone");
  assert.equal(green.routed[0]!.main_red, false, "main green at every base reads false");
  const unread = await judged(() => undefined);
  assert.equal(unread.routed[0]!.main_red, "unread", "an unread or cancelled main run is no evidence either way");
  const thrown = await judged(() => { throw new Error("main run list unreadable"); });
  assert.equal(thrown.routed[0]!.main_red, "unread", "a failed main read is unread, never green");
  assert.equal(thrown.unreadRows, prs.length, "each failed read is ledgered");
});

test("W1-T9551: the garden pass hands the flake classifier one memoized main read per base sha", async () => {
  const h = harness();
  for (const pr of W1_T9532_PRS) { h.evidence(pr, "also_failed"); h.evidence(pr, "also_failed", "a second title on the same runs"); }
  const mainReads: string[] = [];
  const readJson = async (args: string[]): Promise<unknown> => {
    if (args[1]!.includes("/compare/")) return { files: [{ filename: "src/lib/unrelated.ts" }] };
    if (args[1]!.includes("actions/workflows/ci.yml/runs?branch=main&head_sha=")) mainReads.push(args[1]!.split("head_sha=")[1]!.split("&")[0]!);
    return { workflow_runs: [] };
  };
  await selectorShadowGardenPass(h.deps, "acme", "remudero", () => "W1-T9599", { readJson, readText: async () => "" })();
  const routed = h.rows(FLAKE_INCIDENT_MAIN_INHERITED_STEP);
  assert.equal(routed.length, 2, "both titles are main-inherited");
  assert.deepEqual(routed.map((r) => r.main_red), ["unread", "unread"], "no completed main run is no evidence");
  assert.deepEqual(mainReads.sort(), W1_T9532_PRS.map((pr) => `base-${pr}`), "two groups, one read per base sha");
  assert.equal(h.landed.length, 0);
  h.dispose();
});

test("W1-T9551: the rung's hint reader reads appended bytes only, counts a torn line, and re-reads a shrunk ledger", () => {
  const h = harness();
  const hint = (title: string, prsCount: number) => JSON.stringify({
    ts: new Date(NOW).toISOString(), step: FLAKE_INCIDENT_MAIN_INHERITED_STEP, origin: flakeIncidentOrigin(TEST_FILE, title),
    file: TEST_FILE, title, prs: W1_T9532_PRS.slice(0, prsCount), prs_count: prsCount,
  }) + "\n";
  assert.deepEqual([GARDENER_STEP, MAIN_INHERITED_HINT_SOURCE_STEP], [FLAKE_INCIDENT_MAIN_INHERITED_STEP, FLAKE_INCIDENT_MAIN_INHERITED_STEP],
    "the gardener writes the step the rung reads");
  const read = mainInheritedHintReader(h.ledger);
  assert.deepEqual(read(), { pending: [], torn: 0 }, "an absent ledger has no hints");
  writeFileSync(h.ledger, hint(TITLE, 2));
  assert.deepEqual(read().pending.map((p) => [p.title, p.prsCount]), [[TITLE, 2]]);
  appendFileSync(h.ledger, `{"step":"${FLAKE_INCIDENT_MAIN_INHERITED_STEP}", torn\n` + hint(TITLE, 1));
  const after = read();
  assert.equal(after.torn, 1, "a torn hint line is counted, not read as absent");
  assert.deepEqual(after.pending.map((p) => p.prsCount), [2], "an older, smaller row never replaces a newer one");
  appendFileSync(h.ledger, JSON.stringify({ step: MAIN_INHERITED_HINT_STEPS.resolved, origin: flakeIncidentOrigin(TEST_FILE, TITLE), prs_count: 2 }) + "\n");
  assert.deepEqual(read().pending, [], "an answered hint is no longer pending");
  writeFileSync(h.ledger, hint("after compaction", 3));
  assert.deepEqual(read().pending.map((p) => p.title), ["after compaction"], "a shrunk ledger is re-read from its start");
  h.dispose();
});

type CheckRun = { name: string; status: "completed"; conclusion: "success" | "failure" };

function rungOver(ledgerPath: string, checkRuns: CheckRun[], overrides: Partial<MainHealthRungDeps> = {}) {
  const sha = "9551".padEnd(40, "0");
  const fetch = ((args: string[]) => {
    const path = args[1] ?? "";
    if (path === "repos/o/r") return { default_branch: "main" };
    if (path === "repos/o/r/commits/main") return { sha };
    if (path === `repos/o/r/commits/${sha}/check-runs?per_page=100`) return { check_runs: checkRuns };
    if (path === `repos/o/r/commits/${sha}/status`) return { statuses: [] };
    if (path.startsWith("repos/o/r/actions/runs?")) return { workflow_runs: [] };
    if (path.startsWith("repos/o/r/commits/") && path.endsWith("/pulls")) return [];
    throw new Error(`unrouted gh api path: ${path}`);
  }) as GhApiFetcher;
  const issues: IssueGateway = { create: () => "https://github.com/o/r/issues/1", listOpen: () => [], comment: () => {}, closeWithComment: () => {} };
  const logs: Array<{ step: string; extra: Row }> = [];
  const rung = buildMainHealthRung("o", "r", {
    fetch, issues, ledgerPath, runId: "DAEMON-T9551", readRequiredChecks: () => ["ci"],
    log: (step, extra = {}) => {
      logs.push({ step, extra });
      appendFileSync(ledgerPath, JSON.stringify({ ts: new Date(NOW).toISOString(), step, ...extra }) + "\n");
    },
    ...overrides,
  });
  return { rung, logs, answers: () => logs.filter((l) => l.step.startsWith("main.health.inherited_hint_")) };
}

test("W1-T9551: a main-inherited red is routed to the main-health rung", async () => {
  const h = harness();
  const OTHER = "a second red no repair names";
  for (const pr of W1_T9532_PRS) h.evidence(pr, "also_failed");
  for (const pr of W1_T9532_PRS) h.evidence(pr, "also_failed", OTHER);
  await runFlakeIncidentGardener(h.deps, h.sources());
  assert.equal(h.rows(FLAKE_INCIDENT_MAIN_INHERITED_STEP).length, 2);
  // The repair main-repair already opened for TITLE (#11782's shape): its red names the test.
  h.log("main.repair.located", {
    offending_sha: "c0a435a51c28".padEnd(40, "0"), failing_checks: ["ci"], red_checks: ["ci", "ci-shard"],
    red_detail: [`not ok ${TITLE}`],
  });
  h.log("main.repair.fix_dispatched", { offending_sha: "c0a435a51c28".padEnd(40, "0"), head_sha: "x" });
  h.log("main.repair.fix_opened", { offending_sha: "c0a435a51c28".padEnd(40, "0"), pr_url: "https://github.com/o/r/pull/11782" });

  const green = rungOver(h.ledger, [{ name: "ci", status: "completed", conclusion: "success" }]);
  await green.rung();
  const answered = green.answers();
  assert.equal(answered.length, 2, "each hint is answered");
  const covered = answered.find((a) => a.step === MAIN_INHERITED_HINT_STEPS.covered)!;
  assert.equal(covered.extra.title, TITLE);
  assert.equal(covered.extra.offending_sha, "c0a435a51c28".padEnd(40, "0"));
  assert.equal(covered.extra.fix_pr_url, "https://github.com/o/r/pull/11782", "it names the repair that covers it");
  const resolved = answered.find((a) => a.step === MAIN_INHERITED_HINT_STEPS.resolved)!;
  assert.equal(resolved.extra.title, OTHER, "a hint no repair names is resolved by a green main");
  await rungOver(h.ledger, [{ name: "ci", status: "completed", conclusion: "success" }]).rung();
  assert.equal(h.rows(MAIN_INHERITED_HINT_STEPS.covered).length + h.rows(MAIN_INHERITED_HINT_STEPS.resolved).length, 2,
    "a hint is answered once, not every pass");

  // A grown hint on a red main that still fails it is confirmed for the repair path.
  h.evidence(11801, "also_failed", OTHER);
  await runFlakeIncidentGardener(h.deps, h.sources());
  const red = rungOver(h.ledger, [{ name: "ci", status: "completed", conclusion: "failure" }], {
    readCiFailures: () => [{ name: "ci", logTail: `not ok 4 - ${OTHER}\n# fail 1\n` }],
  });
  await red.rung();
  const confirmed = red.answers();
  assert.deepEqual(confirmed.map((a) => [a.step, a.extra.title, a.extra.prs_count]), [[MAIN_INHERITED_HINT_STEPS.confirmed, OTHER, 4]]);
  assert.equal(h.landed.length, 0, "the rung never files a flake task");
  h.dispose();
});

test("W1-T9551: a red that recovers on retry is still a flake incident", async () => {
  const h = harness();
  h.evidence(11705, "also_failed");
  h.evidence(11735, "recovered");
  h.evidence(11769, "also_failed");
  await runFlakeIncidentGardener(h.deps, h.sources({ mainFailures: () => [TEST_FILE] }));
  assert.equal(h.landed.length, 1, "a test that passes on retry is a flake, whatever main says");
  assert.deepEqual(h.rows(FLAKE_INCIDENT_MAIN_INHERITED_STEP), []);
  assert.equal(h.rows("flake_incident.filed")[0]!.recovered, 1);
  h.dispose();
});
