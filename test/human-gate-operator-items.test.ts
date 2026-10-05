import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fixedClock } from "../src/lib/clock.js";
import { COST_ANOMALY_STEP } from "../src/lib/cost-anomaly.js";
import { deployImageManualPath } from "../src/lib/deployer.js";
import { TOKEN_REFRESHED_STEP, TOKEN_REFRESH_FAILED_STEP } from "../src/lib/github-app.js";
import {
  OPERATOR_ITEM_CLASSIFICATION, projectHumanGates, projectOperatorItemGates, type OperatorItemGateInput,
} from "../src/lib/human-gate.js";
import { IMAGE_DRIFT_STEP } from "../src/lib/image-drift.js";
import { createLedgerProjector, openProjectorReadModel } from "../src/lib/ledger-projector.js";
import { createNowView, NOW_DAEMON_SILENT_MS, type NowViewData } from "../src/lib/now-view.js";
import { acquireLease } from "../src/lib/read-model-db.js";
import type { StatusProjection } from "../src/lib/status.js";
import type { GitHub } from "../src/lib/status.js";
import { deriveOperatorItems } from "../src/lib/status-board.js";
import { makeTempDir } from "../src/lib/tmp.js";

const AT = "2026-10-04T12:00:00.000Z";
const NOW = Date.parse(AT);
const BUILD = "a".repeat(40);
const BAKED = "b".repeat(40);
const PR_URL = "https://github.com/example/repo/pull/7";
const at = (ms: number): string => new Date(NOW + ms).toISOString();
type Line = Record<string, unknown>;
const boot = (ms: number): Line => ({ ts: at(ms), step: "daemon.boot", head_sha: BUILD });
const drift = (ms: number, build = BUILD): Line => ({ ts: at(ms), step: IMAGE_DRIFT_STEP, build_sha: build, baked_sha: BAKED });
const anomaly = (ms: number, runId: string, over: Line = {}): Line => ({ ts: at(ms), step: COST_ANOMALY_STEP, run_id: runId,
  task_id: "W1-T1", task_class: "implement", cost_usd: 12.5, median_cost_usd: 2, multiplier: 3, sample_size: 9, ...over });
const tokenFailed = (ms: number): Line => ({ ts: at(ms), step: TOKEN_REFRESH_FAILED_STEP, reason: "exchange timed out" });
const uncredited = new Map<string, StatusProjection>([["W1-T9",
  { taskId: "W1-T9", uncreditedBuild: { prNumber: 7, prUrl: PR_URL, namedIn: "body" } } as unknown as StatusProjection]]);
const RECORD_KINDS = ["costAnomaly", "tokenFallback", "uncreditedBuilds"] as const;

function project(lines: Line[], over: Partial<OperatorItemGateInput> = {}) {
  return projectOperatorItemGates({ instance: "core", state: "complete", items: deriveOperatorItems(lines, uncredited),
    bootTimes: lines.filter((l) => l.step === "daemon.boot").map((l) => String(l.ts)), imageRecycleManual: true,
    nowMs: NOW + 10, freshnessBudgetMs: NOW_DAEMON_SILENT_MS, ...over });
}

test("every operator item has a source-owned action or remains a record", () => {
  // The table is explicit and total over NeedsMeSection's four operator-item kinds, each naming its producer.
  assert.deepEqual(Object.keys(OPERATOR_ITEM_CLASSIFICATION).sort(), ["costAnomaly", "imageDrift", "tokenFallback", "uncreditedBuilds"]);
  for (const entry of Object.values(OPERATOR_ITEM_CLASSIFICATION)) {
    assert.match(entry.producer, /src\/lib\/[a-z-]+\.ts/);
    assert.ok(entry.why.length > 20);
  }
  for (const kind of RECORD_KINDS) assert.equal(OPERATOR_ITEM_CLASSIFICATION[kind].route, "record");
  assert.equal(OPERATOR_ITEM_CLASSIFICATION.imageDrift.route, "gate-when-source-holds");

  // Diagnostics and still-active automated recovery are records: present and current, yet no decision.
  const quiet = project([anomaly(0, "run-1"), tokenFailed(1)], { imageRecycleManual: true });
  assert.deepEqual(quiet.source.gates, []);
  assert.deepEqual(quiet.records.map((r) => [r.kind, r.disposition, r.freshness]).sort(),
    [["costAnomaly", "record", "current"], ["tokenFallback", "record", "current"], ["uncreditedBuilds", "record", "current"]]);
  // A record carries no resolution verb: acknowledging one is a read, never a grant to spend, release or deploy.
  for (const record of quiet.records) assert.equal("resolutionVerb" in record, false);

  // The deployer recycles a drifted image itself by default, so drift under automatic recycle stays a record.
  const automatic = project([drift(0), boot(1)], { imageRecycleManual: false });
  assert.deepEqual(automatic.source.gates, []);
  assert.equal(automatic.records.find((r) => r.kind === "imageDrift")!.disposition, "record");
  assert.match(automatic.records.find((r) => r.kind === "imageDrift")!.why, /recycles/);

  // The operator's DEPLOY_IMAGE_MANUAL opt-out puts the recycle behind `rmd deploy`: one real decision.
  const held = project([drift(0), boot(1)], { imageRecycleManual: true });
  assert.equal(held.source.gates.length, 1);
  const gate = held.source.gates[0]!;
  assert.equal(gate.kind, "operator_item");
  assert.equal(gate.subject, `image-drift:${BUILD}`);
  assert.equal(gate.ownerSurface, "inbox");
  assert.equal(gate.resolutionVerb, "restart");
  assert.equal(gate.openedAt, at(0));
  assert.match(gate.reason, new RegExp(`${BUILD}.*${BAKED}.*DEPLOY_IMAGE_MANUAL.*rmd deploy`));
  assert.equal(held.records.find((r) => r.kind === "imageDrift")!.disposition, "gate");
  for (const verb of ["approve", "release_hold", "acknowledge", "ratify"]) assert.notEqual(gate.resolutionVerb, verb);

  // An unreadable recycle mode is not evidence that a person must act, nor that automation will.
  const unread = project([drift(0), boot(1)], { imageRecycleManual: undefined });
  assert.deepEqual(unread.source.gates, []);
  assert.equal(unread.source.state, "partial");
  assert.match(unread.source.reason!, /recycle mode/);
});

test("healthy boards have no gates and stale operator evidence stays explicit", () => {
  const healthy = project([boot(0), { ts: at(1), step: TOKEN_REFRESHED_STEP }], { items: deriveOperatorItems([boot(0)], new Map()) });
  assert.deepEqual(healthy.source.gates, []);
  assert.deepEqual(healthy.records, []);
  assert.equal(healthy.source.state, "complete");
  assert.deepEqual(projectHumanGates([healthy.source]).count.inbox, { count: 0 });
  // A refresh that succeeded after the failure is the system working: no fallback row, no record.
  assert.deepEqual(project([tokenFailed(0), { ts: at(1), step: TOKEN_REFRESHED_STEP }],
    { items: deriveOperatorItems([tokenFailed(0), { ts: at(1), step: TOKEN_REFRESHED_STEP }], new Map()) }).records, []);

  // A later boot that re-ran the image check without re-observing drift supersedes it: stale, never a fresh decision.
  const superseded = project([drift(0), boot(1), boot(2)]);
  assert.deepEqual(superseded.source.gates, []);
  assert.equal(superseded.source.state, "complete");
  const old = superseded.records.find((r) => r.kind === "imageDrift")!;
  assert.equal(old.freshness, "stale");
  assert.equal(old.disposition, "record");
  assert.equal(old.observedAt, at(0));
  assert.match(old.evidence, /later boot/);

  // A drift row without a timestamp cannot be placed against any boot: unknown, no gate, and the count says so.
  const untimed = project([{ step: IMAGE_DRIFT_STEP, build_sha: BUILD, baked_sha: BAKED }]);
  assert.deepEqual(untimed.source.gates, []);
  assert.equal(untimed.records.find((r) => r.kind === "imageDrift")!.freshness, "unknown");
  assert.deepEqual(projectHumanGates([untimed.source]).count.inbox, { atLeast: 0 });

  // A token failure no newer retry followed is stale: the refresh loop is not observed, and it is still not a decision.
  const lapsed = project([tokenFailed(0)], { nowMs: NOW + NOW_DAEMON_SILENT_MS + 1 });
  const token = lapsed.records.find((r) => r.kind === "tokenFallback")!;
  assert.equal(token.freshness, "stale");
  assert.equal(token.disposition, "record");
  assert.deepEqual(lapsed.source.gates, []);

  // An anomaly row without a readable cost reports the cost unknown, never a verified $0.00.
  const unknownCost = project([anomaly(0, "run-2", { cost_usd: undefined })]).records.find((r) => r.kind === "costAnomaly")!;
  assert.match(unknownCost.evidence, /cost unknown/);
  assert.doesNotMatch(unknownCost.evidence, /\$0\.00/);
  const old2 = project([anomaly(0, "run-3")], { nowMs: NOW + NOW_DAEMON_SILENT_MS + 1 }).records.find((r) => r.kind === "costAnomaly")!;
  assert.equal(old2.freshness, "stale");

  // An unobserved kind is named, never reported as an empty healthy list.
  const blind = project([], { items: { ...deriveOperatorItems([], new Map()), uncreditedBuilds: undefined },
    uncreditedReason: "board projection skips uncredited-build reads" });
  assert.deepEqual(blind.unobserved, [{ kind: "uncreditedBuilds", reason: "board projection skips uncredited-build reads" }]);
});

test("operator records remain visible without multiplying the human decision count", () => {
  // The daemon and serve each re-observe the same drifted image; two anomalies, a fallback and an uncredited build ride along.
  const lines = [drift(0), boot(1), drift(2), anomaly(3, "run-1"), anomaly(4, "run-2"), tokenFailed(5)];
  const core = project(lines);
  const projection = projectHumanGates([core.source]);
  assert.deepEqual(projection.count.inbox, { count: 1 });
  assert.deepEqual(projection.count.byKind, { operator_item: 1 });
  assert.equal(projection.gates[0]!.key, `operator_item:core:${encodeURIComponent(`image-drift:${BUILD}`)}`);
  assert.deepEqual(core.records.map((r) => r.kind).sort(), ["costAnomaly", "costAnomaly", "imageDrift", "tokenFallback", "uncreditedBuilds"]);
  for (const record of core.records) {
    assert.equal(record.instance, "core");
    assert.ok(record.subject.length > 0);
  }
  const build = core.records.find((r) => r.kind === "uncreditedBuilds")!;
  assert.equal(build.url, PR_URL);
  assert.equal(build.subject, "W1-T9");
  assert.equal(core.records.find((r) => r.subject === "run-2")!.observedAt, at(4));

  // The same condition on two instances is two decisions, each keyed by its own instance.
  const site = project(lines, { instance: "site" });
  const both = projectHumanGates([core.source, site.source]);
  assert.deepEqual(both.gates.map((g) => g.key).sort(),
    [`operator_item:core:${encodeURIComponent(`image-drift:${BUILD}`)}`, `operator_item:site:${encodeURIComponent(`image-drift:${BUILD}`)}`]);
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

test("production now view classifies operator items from the ledger and the recycle-mode marker", (t) => {
  const { root, append, read } = nowFixture(t);
  append(drift(0), boot(0), anomaly(0, "run-1"));
  const operatorSource = (data: NowViewData) => data.humanGates!.sources.find((s) => s.name === "operator-items")!;
  const automatic = read();
  assert.deepEqual(automatic.humanGates!.gates.filter((g) => g.kind === "operator_item"), []);
  assert.equal(operatorSource(automatic).state, "complete");
  writeFileSync(deployImageManualPath(root), "");
  append(anomaly(0, "run-2"));
  const held = read();
  const heldGates = held.humanGates!.gates.filter((g) => g.kind === "operator_item");
  assert.deepEqual(heldGates.map((g) => g.key), [`operator_item:core:${encodeURIComponent(`image-drift:${BUILD}`)}`]);
  assert.equal(heldGates[0]!.resolutionVerb, "restart");
  // Two cost anomalies ride the same ledger and add nothing to the decision count.
  assert.equal(held.humanGates!.count.byKind.operator_item, 1);
  // Two later boots re-ran the image check and saw no drift: the stale row is no longer a decision.
  append(boot(0), boot(0));
  const recycled = read();
  assert.deepEqual(recycled.humanGates!.gates.filter((g) => g.kind === "operator_item"), []);
  assert.equal(operatorSource(recycled).state, "complete");
});
