import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fixedClock } from "../src/lib/clock.js";
import { COST_ANOMALY_STEP } from "../src/lib/cost-anomaly.js";
import { deployAutoPath, deployImageManualPath, deployMarkerPath } from "../src/lib/deployer.js";
import { TOKEN_REFRESHED_STEP, TOKEN_REFRESH_FAILED_STEP } from "../src/lib/github-app.js";
import {
  consumeHumanGateCounts, OPERATOR_ITEM_CLASSIFICATION, projectHumanGates, projectOperatorItemGates, type OperatorItemGateInput,
} from "../src/lib/human-gate.js";
import { IMAGE_DRIFT_STEP } from "../src/lib/image-drift.js";
import { createLedgerProjector, openProjectorReadModel } from "../src/lib/ledger-projector.js";
import { createNowView, NOW_DAEMON_SILENT_MS, type NowViewData } from "../src/lib/now-view.js";
import { acquireLease } from "../src/lib/read-model-db.js";
import type { GitHub, StatusProjection } from "../src/lib/status.js";
import { costAnomalyUsd, deriveOperatorItems } from "../src/lib/status-board.js";
import { makeTempDir } from "../src/lib/tmp.js";

const AT = "2026-10-04T12:00:00.000Z";
const NOW = Date.parse(AT);
const BUILD = "a".repeat(40);
const BAKED = "b".repeat(40);
const PR_URL = "https://github.com/example/repo/pull/7";
const DRIFT_SUBJECT = `image-drift:${BUILD}`;
const at = (ms: number): string => new Date(NOW + ms).toISOString();
type Line = Record<string, unknown>;
const boot = (ms: number): Line => ({ ts: at(ms), step: "daemon.boot", head_sha: BUILD });
const drift = (ms: number): Line => ({ ts: at(ms), step: IMAGE_DRIFT_STEP, task_id: "DAEMON", build_sha: BUILD, baked_sha: BAKED });
const anomaly = (ms: number, runId: string, over: Line = {}): Line => ({ ts: at(ms), step: COST_ANOMALY_STEP, run_id: runId,
  task_id: "W1-T1", task_class: "implement", cost_usd: 12.5, median_cost_usd: 2, multiplier: 3, sample_size: 9, ...over });
const tokenFailed = (ms: number): Line => ({ ts: at(ms), step: TOKEN_REFRESH_FAILED_STEP, reason: "exchange timed out" });
const tokenOk = (ms: number): Line => ({ ts: at(ms), step: TOKEN_REFRESHED_STEP });
const uncredited = new Map<string, StatusProjection>([["W1-T9",
  { taskId: "W1-T9", uncreditedBuild: { prNumber: 7, prUrl: PR_URL, namedIn: "body" } } as unknown as StatusProjection]]);
/** The operator's opt-out alone: image recycles wait for rmd deploy and nobody has asked for one yet. */
const HELD = { imageRecycleManual: true, autoMode: false, requested: false } as const;
const DEFAULT = { imageRecycleManual: false, autoMode: false, requested: false } as const;

function project(lines: Line[], over: Partial<OperatorItemGateInput> = {}, projections = uncredited) {
  return projectOperatorItemGates({ instance: "core", state: "complete", items: deriveOperatorItems(lines, projections),
    bootTimes: lines.filter((l) => l.step === "daemon.boot").map((l) => String(l.ts)), deploy: HELD,
    nowMs: NOW + 10, freshnessBudgetMs: NOW_DAEMON_SILENT_MS, ...over });
}

test("every operator item has a source-owned action or remains a record", () => {
  // The table is explicit and total over NeedsMeSection's four operator-item kinds, each naming its producer and evidence.
  assert.deepEqual(Object.keys(OPERATOR_ITEM_CLASSIFICATION).sort(), ["costAnomaly", "imageDrift", "tokenFallback", "uncreditedBuilds"]);
  assert.deepEqual(Object.fromEntries(Object.entries(OPERATOR_ITEM_CLASSIFICATION).map(([kind, c]) => [kind, [c.route, c.producer]])), {
    costAnomaly: ["record", "src/lib/cost-anomaly.ts"],
    imageDrift: ["gate-when-source-holds", "src/lib/deployer.ts"],
    tokenFallback: ["record", "src/lib/github-app.ts"],
    uncreditedBuilds: ["record", "src/lib/status.ts"],
  });
  assert.match(OPERATOR_ITEM_CLASSIFICATION.costAnomaly.evidence, /never defers, stops or blocks/);
  assert.match(OPERATOR_ITEM_CLASSIFICATION.tokenFallback.evidence, /REFRESH_FAILURE_RETRY_MS/);
  assert.match(OPERATOR_ITEM_CLASSIFICATION.uncreditedBuilds.evidence, /never credits/);
  assert.match(OPERATOR_ITEM_CLASSIFICATION.imageDrift.evidence, /DEPLOY_IMAGE_MANUAL/);

  // A diagnostic report and a still-retrying automated recovery are records: present and current, yet no decision.
  const quiet = project([anomaly(0, "run-1"), tokenFailed(1)]);
  assert.deepEqual(quiet.source.gates, []);
  assert.equal(quiet.source.state, "complete");
  assert.deepEqual(quiet.records.map((r) => [r.kind, r.disposition, r.freshness]),
    [["costAnomaly", "record", "current"], ["tokenFallback", "record", "current"], ["uncreditedBuilds", "record", "current"]]);
  // A record carries no resolution verb: acknowledging one is a read, never a grant to spend, release or deploy.
  for (const record of quiet.records) assert.equal("resolutionVerb" in record, false);

  // The deployer recycles a drifted image itself by default, under DEPLOY_AUTO, and once an rmd deploy request stands.
  for (const deploy of [DEFAULT, { ...HELD, autoMode: true }, { ...HELD, requested: true }]) {
    const automatic = project([drift(0), boot(1)], { deploy });
    assert.deepEqual(automatic.source.gates, [], JSON.stringify(deploy));
    assert.equal(automatic.source.state, "complete");
    assert.equal(automatic.records.find((r) => r.kind === "imageDrift")!.disposition, "record");
  }
  assert.match(project([drift(0), boot(1)], { deploy: { ...HELD, requested: true } }).records[0]!.why, /request already stands/);

  // The operator's DEPLOY_IMAGE_MANUAL opt-out alone leaves the recycle waiting for rmd deploy: one real decision.
  const held = project([drift(0), boot(1)]);
  assert.equal(held.source.gates.length, 1);
  const gate = held.source.gates[0]!;
  assert.deepEqual({ kind: gate.kind, subject: gate.subject, ownerSurface: gate.ownerSurface, openedAt: gate.openedAt, verb: gate.resolutionVerb },
    { kind: "operator_item", subject: DRIFT_SUBJECT, ownerSurface: "inbox", openedAt: at(0), verb: "restart" });
  assert.match(gate.reason, new RegExp(`${BUILD}.*${BAKED}.*DEPLOY_IMAGE_MANUAL.*rmd deploy`));
  assert.equal(held.records.find((r) => r.kind === "imageDrift")!.disposition, "gate");

  // An unreadable marker is evidence of neither a person's decision nor automation's: no gate, and the source says so.
  const unread = project([drift(0), boot(1)], { deploy: { ...HELD, autoMode: undefined, reason: "DEPLOY_AUTO: EACCES" } });
  assert.deepEqual(unread.source.gates, []);
  assert.equal(unread.source.state, "partial");
  assert.match(unread.source.reason!, /deploy markers are unreadable \(DEPLOY_AUTO: EACCES\)/);
});

test("healthy boards have no gates and stale operator evidence stays explicit", () => {
  const healthy = project([boot(0), tokenOk(1)], {}, new Map());
  assert.deepEqual(healthy.source, { name: "operator-items", instance: "core", state: "complete", gates: [] });
  assert.deepEqual(healthy.records, []);
  assert.deepEqual(projectHumanGates([healthy.source]).count.inbox, { count: 0 });
  // A refresh that succeeded after the failure is the system working: no fallback row, no record.
  assert.deepEqual(project([tokenFailed(0), tokenOk(1)], {}, new Map()).records, []);

  // A second later boot re-ran the image check without re-observing drift: stale, never a fresh decision.
  const superseded = project([drift(0), boot(1), boot(2)]);
  assert.deepEqual(superseded.source.gates, []);
  assert.equal(superseded.source.state, "complete");
  const old = superseded.records.find((r) => r.kind === "imageDrift")!;
  assert.deepEqual([old.freshness, old.disposition, old.observedAt], ["stale", "record", at(0)]);
  assert.match(old.evidence, /later boot re-ran the image check without re-observing drift/);

  // A drift row without a timestamp cannot be placed against any boot: unknown, no gate, and the count is a lower bound.
  const untimed = project([{ step: IMAGE_DRIFT_STEP, build_sha: BUILD, baked_sha: BAKED }]);
  assert.deepEqual(untimed.source.gates, []);
  assert.equal(untimed.records.find((r) => r.kind === "imageDrift")!.freshness, "unknown");
  assert.deepEqual(projectHumanGates([untimed.source]).count.inbox, { atLeast: 0 });

  // A token failure no newer retry followed is stale: the refresh loop is not observed, and it is still not a decision.
  const lapsed = project([tokenFailed(0)], { nowMs: NOW + NOW_DAEMON_SILENT_MS + 1 });
  const token = lapsed.records.find((r) => r.kind === "tokenFallback")!;
  assert.deepEqual([token.freshness, token.disposition], ["stale", "record"]);
  assert.match(token.evidence, /no retry of the refresh loop has been observed since/);
  assert.deepEqual(lapsed.source.gates, []);

  // An old anomaly is reported stale, never as a live one.
  const oldAnomaly = project([anomaly(0, "run-3")], { nowMs: NOW + NOW_DAEMON_SILENT_MS + 1 }).records.find((r) => r.kind === "costAnomaly")!;
  assert.deepEqual([oldAnomaly.freshness, oldAnomaly.observedAt], ["stale", at(0)]);

  // An anomaly row without a readable cost reports it unknown, never a verified $0.00, here and on the board.
  const items = deriveOperatorItems([anomaly(0, "run-2", { cost_usd: undefined })], new Map());
  assert.deepEqual(items.costAnomaly[0]!.unknown, ["cost_usd"]);
  assert.equal(costAnomalyUsd(items.costAnomaly[0]!, "cost_usd"), "unknown");
  assert.equal(costAnomalyUsd(items.costAnomaly[0]!, "median_cost_usd"), "$2.00");
  const unknownCost = project([anomaly(0, "run-2", { cost_usd: undefined })]).records.find((r) => r.kind === "costAnomaly")!;
  assert.match(unknownCost.evidence, /cost unknown vs class median \$2\.00/);
  assert.doesNotMatch(unknownCost.evidence, /\$0\.00/);

  // An unobserved kind is named with its reason, never reported as an empty healthy list.
  const blind = project([], { items: { ...deriveOperatorItems([], new Map()), uncreditedBuilds: undefined },
    uncreditedReason: "board snapshot skips uncredited-build reads" });
  assert.deepEqual(blind.unobserved, [{ kind: "uncreditedBuilds", reason: "board snapshot skips uncredited-build reads" }]);
});

test("operator records remain visible without multiplying the human decision count", () => {
  // The daemon re-observes the same drifted image on a later boot; two anomalies, a fallback and an uncredited build ride along.
  const lines = [drift(0), boot(1), drift(2), boot(3), anomaly(4, "run-1"), anomaly(5, "run-2"), tokenFailed(6)];
  const core = project(lines);
  const projection = projectHumanGates([core.source]);
  assert.deepEqual(projection.count.inbox, { count: 1 });
  assert.deepEqual(projection.count.byKind, { operator_item: 1 });
  assert.equal(projection.gates[0]!.key, `operator_item:core:${encodeURIComponent(DRIFT_SUBJECT)}`);
  assert.equal(projection.gates[0]!.openedAt, at(2));
  assert.deepEqual(consumeHumanGateCounts(projection).kinds.missing.includes("operator_item"), false);

  // Every row stays visible with its instance, identity, timestamp and evidence link, records and gate alike.
  assert.deepEqual(core.records.map((r) => [r.kind, r.subject, r.observedAt, r.url, r.disposition]), [
    ["costAnomaly", "run-1", at(4), null, "record"],
    ["costAnomaly", "run-2", at(5), null, "record"],
    ["imageDrift", DRIFT_SUBJECT, at(2), null, "gate"],
    ["tokenFallback", "github-app-installation-token", at(6), null, "record"],
    ["uncreditedBuilds", "W1-T9", null, PR_URL, "record"],
  ]);
  assert.ok(core.records.every((r) => r.instance === "core" && r.evidence.length > 0));

  // The same condition on two instances is two decisions, each keyed by its own instance.
  const site = project(lines, { instance: "site" });
  const both = projectHumanGates([core.source, site.source]);
  assert.deepEqual(both.gates.map((g) => g.key).sort(),
    [`operator_item:core:${encodeURIComponent(DRIFT_SUBJECT)}`, `operator_item:site:${encodeURIComponent(DRIFT_SUBJECT)}`]);
  assert.deepEqual(both.count.inbox, { count: 2 });
  assert.ok(site.records.every((r) => r.instance === "site"));
});

function nowFixture(t: TestContext) {
  const root = makeTempDir("human-gate-operator-items");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ledgerDir = join(root, "state");
  const planDir = join(root, "plan");
  mkdirSync(ledgerDir, { recursive: true });
  mkdirSync(planDir, { recursive: true });
  const clock = fixedClock(NOW);
  const db = openProjectorReadModel(join(root, "read-model"), "core", clock);
  t.after(() => db.close());
  const lease = acquireLease(db, { clock });
  assert.ok(lease.ok);
  const projector = createLedgerProjector({ ledgerDir, db, lease: lease.lease, clock });
  const github = { readFailed: () => false, prByRef: () => null, findMergedByTrailer: () => null,
    findMergedByHeadBranch: () => [], listMergedHeadBranches: () => [], listOpenHeadBranches: () => [],
    headRefName: () => undefined, prBody: () => undefined, issueByUrl: () => null } as unknown as GitHub;
  const view = createNowView({ instances: [{ name: "core", ledgerDir, planPath: join(planDir, "tasks.yaml") }], clock,
    readPlan: () => ({ tasks: [], byId: new Map() }), planBehind: () => ({ commits: 0 }),
    github: () => ({ github, generation: "known", source: { asOf: AT, state: "fresh" } }),
    hostProbe: { readLive: () => [], diskFree: () => 1000, rateLimit: () => 5000 } });
  let sequence = 0;
  const append = (...rows: Line[]) => {
    appendFileSync(join(ledgerDir, "ledger.ndjson"), rows.map((r) => JSON.stringify({ ...r,
      ts: new Date(NOW + sequence++).toISOString() }) + "\n").join(""));
    projector.tick();
  };
  const read = (): NowViewData => view.materialize({ now: NOW + sequence,
    switches: { views: { now: "serve" } }, instances: [{ db, state: { instance: "core",
      generation: Number(db.meta("generation")), lease: "held", failures: 0, tickedAt: NOW, newestTs: null } }] })[0]!.data;
  return { root, append, read };
}

test("production now view classifies operator items from the ledger and the deployer's markers", (t) => {
  const { root, append, read } = nowFixture(t);
  const operatorSource = (data: NowViewData) => data.humanGates!.sources.find((s) => s.name === "operator-items")!;
  const operatorGates = (data: NowViewData) => data.humanGates!.gates.filter((g) => g.kind === "operator_item");
  append(drift(0), boot(0), anomaly(0, "run-1"), tokenFailed(0));
  const automatic = read();
  assert.deepEqual(operatorGates(automatic), []);
  assert.equal(operatorSource(automatic).state, "complete");

  writeFileSync(deployImageManualPath(root), "");
  append(anomaly(0, "run-2"));
  const held = read();
  assert.deepEqual(operatorGates(held).map((g) => [g.key, g.resolutionVerb]),
    [[`operator_item:core:${encodeURIComponent(DRIFT_SUBJECT)}`, "restart"]]);
  // Two cost anomalies and a token fallback ride the same ledger and add nothing to the decision count.
  assert.equal(held.humanGates!.count.byKind.operator_item, 1);
  assert.equal(held.needsYou!.byKind.operator_item, 1);

  // An operator deploy request now stands: the deployer acts at the next idle gap, so no decision remains.
  writeFileSync(deployMarkerPath(root), "");
  append(anomaly(0, "run-3"));
  assert.deepEqual(operatorGates(read()), []);
  rmSync(deployMarkerPath(root));
  writeFileSync(deployAutoPath(root), "");
  append(anomaly(0, "run-4"));
  assert.deepEqual(operatorGates(read()), []);
  rmSync(deployAutoPath(root));
  append(anomaly(0, "run-5"));
  assert.equal(operatorGates(read()).length, 1);

  // A later boot re-ran the image check and saw no drift: the stale row is no longer a decision.
  append(boot(0));
  const recycled = read();
  assert.deepEqual(operatorGates(recycled), []);
  assert.equal(operatorSource(recycled).state, "complete");
});

test("production now view names an unreadable deploy marker instead of reading it as absent", (t) => {
  const { root, append, read } = nowFixture(t);
  // DEPLOY_AUTO only decides who recycles while DEPLOY_IMAGE_MANUAL holds image recycles.
  writeFileSync(deployImageManualPath(root), "");
  // A self-referencing symlink makes stat fail with ELOOP: a real failure that is not the marker's absence.
  symlinkSync("DEPLOY_AUTO", deployAutoPath(root));
  append(drift(0), boot(0));
  const data = read();
  const source = data.humanGates!.sources.find((s) => s.name === "operator-items")!;
  assert.deepEqual(data.humanGates!.gates.filter((g) => g.kind === "operator_item"), []);
  assert.equal(source.state, "partial");
  assert.match(source.reason!, /deploy markers are unreadable \(DEPLOY_AUTO: .*ELOOP/);
});
