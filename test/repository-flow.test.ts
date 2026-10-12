import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { makeTempDir } from "../src/lib/tmp.js";
import { fixedClock } from "../src/lib/clock.js";
import { createBoardSnapshotCache, createBoardSnapshotReader, boardSnapshotPath, boardOpenSnapshotPath, readOpenBoardSnapshot } from "../src/lib/board-snapshot-cache.js";
import { mergeAnalytics, analyticsConsoleSource } from "../src/lib/analytics-view.js";
import { deriveAnalyticsSnapshot } from "../src/lib/analytics-route.js";
import { mapBoardPr, type BoardPrRest } from "../src/lib/open-prs-rest.js";

const now = Date.parse("2026-10-12T12:00:00.000Z");
const iso = (n: number) => new Date(n).toISOString();
const day = 86400000;
const repository = "fixture/repo";
const pr = (n: number, extra: Partial<BoardPrRest> = {}): BoardPrRest => ({ number: n,
  url: `https://github.com/${repository}/pull/${n}`, state: "MERGED", headRefName: "run-W1-T12-123",
  headRefOid: "a".repeat(40), body: "Remudero-Task: W1-T12", title: "delivered", autoMergeRequest: null,
  updatedAt: iso(now), createdAt: iso(now - day), mergedAt: iso(now - 1000), ...extra });
const load = () => import("../src/lib/repository-flow.js");
function world(t: {after(fn: () => void): void}, rows: BoardPrRest[] = [pr(1)], ledger: unknown[] = []) {
  const root = makeTempDir("repo-flow");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const state = join(root, "state");
  mkdirSync(state, { recursive: true });
  const cache = createBoardSnapshotCache(root, "fixture", "repo", { clock: fixedClock(now) });
  assert.equal(cache.commitClosed(rows.filter(p => p.state !== "OPEN")), true);
  assert.equal(cache.commitOpen!(rows.filter(p => p.state === "OPEN"), now), true);
  writeFileSync(join(state, "ledger.ndjson"), ledger.map(r => JSON.stringify(r)).join("\n") + "\n");
  return { root, state, cache };
}

test("W1-T8684: repository throughput preserves PR event clocks and unique delivery credit", async t => {
  const { captureRepositoryFlow } = await load();
  const rows = [pr(1), pr(2), pr(3, { headRefName: "codex/plan", body: "names W1-T42 only" }),
    pr(4, { state: "OPEN", mergedAt: undefined }), pr(5, { createdAt: iso(now - 41 * day), mergedAt: iso(now - 40 * day) })];
  const { root, state } = world(t, rows, [{ ts: iso(now), step: "verdict", verdict: "merged", task_id: "W1-T99" }]);
  const result = await captureRepositoryFlow(root, state, repository, fixedClock(now));
  assert.ok(result);
  const window = result.windows[0]!;
  assert.equal(window.days, 7);
  assert.equal(window.summary.merged, 3);
  assert.equal(window.summary.opened, 4);
  assert.equal(window.summary.deliveredTasks, 1);
  assert.equal(window.buckets.at(-1)!.merged, 3);
  assert.equal(window.buckets.at(-2)!.opened, 4);
  assert.equal(window.summary.mergeLatency.samples, 3);
  assert.equal(window.summary.mergeLatency.p50Ms, day - 1000);
  const restored = createBoardSnapshotReader()(root, "fixture", "repo").closed!;
  assert.equal(restored.get(1)!.createdAt, rows[0]!.createdAt);
  assert.equal(restored.get(1)!.mergedAt, rows[0]!.mergedAt);
  const mapped = mapBoardPr({ number: 7, html_url: pr(7).url, state: "closed", created_at: iso(now - day),
    updated_at: iso(now), merged_at: iso(now), head: { ref: "branch", sha: "a".repeat(40) } });
  assert.equal(mapped.createdAt, iso(now - day));
  const bodyOnly = world(t, [pr(8, { headRefName: "codex/repair", body: "Remudero-Task: W1-T44" }),
    pr(9, { body: "", headRefName: "run-W1-T45-123" }),
    pr(10, { headRefName: "run-W1-T46-build-123", body: "" })]);
  const bodyFlow = await captureRepositoryFlow(bodyOnly.root, bodyOnly.state, repository, fixedClock(now));
  assert.equal(bodyFlow!.windows[0]!.summary.deliveredTasks, 2, "native body credit union structured branch credit rejects phantom ids");
});

test("W1-T8684: repair load distinguishes unique PRs rounds reasons and unknown recovery", async t => {
  const { captureRepositoryFlow } = await load();
  const repair = (n: number, round: string, reason_class?: string) => ({ ts: iso(now - 1000), step: "fix.dispatch",
    pr_url: pr(n).url, pr_number: n, head_sha: "b".repeat(40), round_id: round,
    run_id: "shared-daemon", reason_class });
  const rows = [repair(1, "one", "code"), repair(1, "two", "flake"), repair(2, "one", "infrastructure"),
    { ...repair(1, "three"), pr_url: "https://github.com/other/repo/pull/1" },
    { ...repair(1, "four"), head_sha: undefined },
    { ...repair(1, "one"), step: "fix.done", verdict: "FIXED" }];
  const { root, state } = world(t, [pr(1), pr(2)], rows);
  const replay = rows.map(r => JSON.stringify(r)).join("\n") + "\n";
  const archive = `ledger.${iso(now).replace(/[:.]/g, "-")}.ndjson`;
  writeFileSync(join(state, archive), replay);
  writeFileSync(join(state, archive + ".gz"), gzipSync(replay));
  const result = await captureRepositoryFlow(root, state, repository, fixedClock(now));
  assert.ok(result);
  const summary = result.windows[0]!.summary;
  assert.equal(summary.repairedPrs, 2);
  assert.equal(summary.repairRounds, 3);
  assert.deepEqual(summary.repairReasons, { code: 1, flake: 1, infrastructure: 1, conflict: 0, unknown: 0 });
  assert.equal(result.notCollected.repairLatency, "required-current-head recovery evidence not collected");
  assert.ok(result.gaps.includes("repair rows without exact repository PR head and round were excluded"));
  writeFileSync(join(state, "ledger.ndjson"), replay + JSON.stringify({ ...rows[0], ts: iso(now - 2000), reason_class: "conflict" }) + "\n");
  const conflicting = (await captureRepositoryFlow(root, state, repository, fixedClock(now)))!;
  assert.equal(conflicting.windows[0]!.summary.repairRounds, 3);
  assert.equal(conflicting.windows[0]!.summary.repairReasons.unknown, 1);
  assert.ok(conflicting.gaps.includes("conflicting repair identity observations retain unknown classification"));
  const localLabel = world(t, [pr(1)], [{ ...repair(1, "local-label"), repo: "repo" }]);
  assert.equal((await captureRepositoryFlow(localLabel.root, localLabel.state, repository, fixedClock(now)))!
    .windows[0]!.summary.repairRounds, 1, "the exact PR URL scopes a legacy local label without guessing a repo from it");
});

test("W1-T8684: repository flow preserves latency samples censoring and coverage gaps", async t => {
  const { captureRepositoryFlow } = await load();
  const { root, state } = world(t, [pr(1), pr(2, { createdAt: undefined }),
    pr(3, { state: "OPEN", mergedAt: undefined, createdAt: iso(now - 2 * day) })]);
  const result = await captureRepositoryFlow(root, state, repository, fixedClock(now));
  assert.ok(result);
  const summary = result.windows[0]!.summary;
  assert.equal(summary.mergeLatency.samples, 1);
  assert.equal(summary.mergeLatency.missingCreatedAt, 1);
  assert.equal(summary.openAge.samples, 1);
  assert.equal(summary.openAge.oldestMs, 2 * day);
  assert.equal(result.state, "partial");
  assert.equal(result.notCollected.firstPass, "initial-head and required-check policy evidence not collected");
  rmSync(join(state, "ledger.ndjson"));
  const unavailable = await captureRepositoryFlow(root, state, repository, fixedClock(now));
  assert.ok(unavailable);
  assert.equal(unavailable.windows[0]!.summary.repairRounds, null);
  assert.equal(unavailable.windows[0]!.summary.merged, 2, "missing repairs cannot erase independently measured PRs");
});

test("W1-T8684: bounded flow refuses incompatible sources without losing Analytics", async t => {
  const { captureRepositoryFlow, publicRepositoryFlow } = await load();
  const { root, state } = world(t, []);
  const result = await captureRepositoryFlow(root, state, repository, fixedClock(now));
  assert.ok(result);
  assert.equal(result.windows[0]!.summary.merged, 0, "complete cached empty PR source is a measured zero");
  assert.equal(result.windows[0]!.summary.repairRounds, null, "empty retained ledger is not proof of historical absence");
  assert.equal(publicRepositoryFlow(result, "another/repo", iso(now)).state, "not_collected");
  assert.equal(publicRepositoryFlow({ ...result, version: "future" }, repository, iso(now)).state, "not_collected");
  assert.equal(publicRepositoryFlow({ ...result, unexpected: "private" }, repository, iso(now)).state, "not_collected");
  assert.equal(publicRepositoryFlow({ ...result, gaps: ["x".repeat(65537)] }, repository, iso(now)).state, "not_collected");
  const missing = await captureRepositoryFlow(root, state, "another/repo", fixedClock(now));
  assert.ok(missing);
  assert.equal(missing.state, "not_collected");
  assert.equal(missing.windows[0]!.summary.merged, null);
  const snapshot = deriveAnalyticsSnapshot([], iso(now));
  const console = { ...analyticsConsoleSource(snapshot, repository), repositoryFlow: { ...result, version: "future" } as unknown as typeof result };
  const independent = mergeAnalytics([{ instanceId: "core", snapshot: { asOf: iso(now), console } }], now).data;
  assert.deepEqual(independent.coverage, { counted: 1, of: 1, missing: [] });
  assert.equal(independent.instances[0]!.repositoryFlow!.reason, "invalid_source");
  assert.ok(independent.instances[0]!.metrics);
  const circular: Record<string, unknown> = {}; circular.self = circular;
  assert.equal(publicRepositoryFlow(circular, repository, iso(now)).reason, "invalid_source");
  assert.equal(await captureRepositoryFlow(root, state, undefined, fixedClock(now)), undefined);
  assert.equal(await captureRepositoryFlow(root, state, "invalid", fixedClock(now)), undefined);
  const badPath = await captureRepositoryFlow(root, null as unknown as string, repository, fixedClock(now));
  assert.equal(badPath!.sources.ledgerCorpus, "unavailable");
  assert.ok(badPath!.gaps.includes("ledger collection failed; repair totals are unavailable"));
});

test("repository flow bounds evidence not counts and preserves incomplete source clocks", async t => {
  const { captureRepositoryFlow } = await load();
  const { root, state, cache } = world(t, Array.from({ length: 500 }, (_, i) => pr(i + 1)));
  const large = (await captureRepositoryFlow(root, state, repository, fixedClock(now)))!;
  assert.equal(large.windows[0]!.summary.merged, 500);
  assert.equal(large.windows[0]!.evidence.length, 64);
  assert.equal(large.windows[0]!.evidenceTruncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(large)) < 65536);
  const amended = pr(1, { createdAt: iso(now - 2 * day) });
  assert.equal(cache.commitClosed([amended]), true);
  assert.equal(createBoardSnapshotReader()(root, "fixture", "repo").closed!.get(1)!.createdAt, amended.createdAt);
  writeFileSync(boardOpenSnapshotPath(root, "fixture", "repo"), JSON.stringify({ type: "board-open-snapshot",
    schema: 1, repository, savedAt: iso(now) }));
  assert.equal(readOpenBoardSnapshot(root, "fixture", "repo").ok, false, "missing rows cannot become a complete empty page");
  const partial = (await captureRepositoryFlow(root, state, repository, fixedClock(now)))!;
  assert.equal(partial.windows[0]!.summary.merged, 1);
  assert.equal(partial.windows[0]!.coverage.merged, "observed");
  assert.ok(partial.windows[0]!.buckets.some(b => b.merged === null));
  assert.equal(partial.sources.closedObservedAt, iso(now));
  writeFileSync(boardSnapshotPath(root, "fixture", "repo"), "truncated\n");
  assert.equal((await captureRepositoryFlow(root, state, repository, fixedClock(now)))!.state, "not_collected");
});

test("repository flow refuses real identity and snapshot input overflow without inventing historical zero", async t => {
  const { captureRepositoryFlow } = await load();
  const { root, state } = world(t, []);
  writeFileSync(join(state, "ledger.ndjson"), Array.from({ length: 65537 }, (_, i) => JSON.stringify({
    ts: iso(now - 1000), step: "fix.dispatch", pr_number: 1, pr_url: pr(1).url,
    head_sha: "b".repeat(40), round_id: `round-${i}` })).join("\n") + "\n");
  const refused = (await captureRepositoryFlow(root, state, repository, fixedClock(now)))!;
  assert.equal(refused.reason, "over_budget");
  assert.equal(refused.windows[0]!.summary.repairRounds, null);
  assert.ok(Buffer.byteLength(JSON.stringify(refused)) < 65536);
  writeFileSync(join(state, "ledger.ndjson"), JSON.stringify({ ts: iso(now - 29 * day), step: "daemon.tick" }) + "\n");
  const oldCorpus = (await captureRepositoryFlow(root, state, repository, fixedClock(now)))!;
  assert.equal(oldCorpus.windows[1]!.summary.repairRounds, null, "an old positive corpus row cannot prove current historical absence");
  writeFileSync(boardOpenSnapshotPath(root, "fixture", "repo"), JSON.stringify({ type: "board-open-snapshot",
    schema: 1, repository, savedAt: iso(now), rows: Array(100001).fill({}) }));
  assert.equal((await captureRepositoryFlow(root, state, repository, fixedClock(now)))!.reason, "over_budget");
});
