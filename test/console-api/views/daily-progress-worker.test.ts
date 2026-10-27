import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { test } from "node:test";
import { fixedClock, systemClock } from "#src/lib/clock.js";
import { dailyDateAt, dailyWindow, shiftDailyDate } from "#src/lib/daily-progress-calendar.js";
import { createBoardSnapshotCache } from "#src/lib/board-snapshot-cache.js";
import { collectDailyProgress } from "#src/lib/daily-progress-collector.js";
import { dailyProgressDayKey, prepareDailyProgressPublication, readDailyProgressManifest, readDailyProgressRevision } from "#src/lib/daily-progress-store.js";
import { acquireLease, flushReadModelTransactions, openReadModel, readModelLeaseEpoch, releaseLease } from "#src/lib/read-model-db.js";
import { LEDGER_PROJECTOR_SCHEMA_VERSION } from "#src/lib/ledger-projector.js";
import { withTempDir } from "#src/lib/tmp.js";
import { createReadModelTicker, createReadModelWorker, readModelSwitchesPath } from "#src/lib/read-model-worker.js";
import { createRepositoriesSourcePublisher } from "#src/lib/repositories-view.js";
import { runSlowLaneWorker, type SlowLaneMessage } from "#src/lib/read-model-slow-lane.js";
import { INBOX_CLASSIFY_INTERVAL_MS } from "#src/lib/inbox-view.js";
import { readModelInstances } from "#src/lib/serve.js";
import { mapBoardPr, type BoardPrRest } from "#src/lib/open-prs-rest.js";

test("daily progress uses server board roots instead of guessing from ledger locations", async () => {
  await withTempDir("daily-roots", async root => {
    const core = readModelInstances({ ledgerPath: join(root, "independent-ledger", "ledger.ndjson"), questionsRoot: join(root, "operator-root"), assistantRepository: "acme/app" })[0]!;
    assert.equal(core.boardRoot, join(root, "operator-root"));
    assert.notEqual(core.boardRoot, root, "a separately configured ledger parent is not the board snapshot root");
    assert.equal(core.ledgerDir, join(root, "independent-ledger"));
  });
});

test("daily default projector publishes through the real parent and slow-lane threads with all page views off", { timeout: 150_000 }, async () => {
  await withTempDir("daily-default-threads", async root => {
    const stateDir = join(root, "ledger"), boardRoot = join(root, "snapshot-owner");
    mkdirSync(stateDir); mkdirSync(boardRoot); writeFileSync(join(stateDir, "ledger.ndjson"), "");
    const now = systemClock.now(), date = shiftDailyDate(dailyDateAt(now), -1), window = dailyWindow(date);
    const cache = createBoardSnapshotCache(boardRoot, "acme", "app", { clock: fixedClock(now) });
    const occurredAt = fixedClock(Date.parse(window.windowStart) + 3_600_000).iso();
    cache.recordClosedAttempt!({ ok: true, persisted: cache.commitClosed([{ number: 7, url: "https://github.com/acme/app/pull/7", state: "MERGED",
      headRefName: "run-W1-T7-1234567890123", headRefOid: "a".repeat(40), body: "Remudero-Task: W1-T7", title: "Repair", autoMergeRequest: null,
      updatedAt: fixedClock(now).iso(), mergedAt: occurredAt }]) });
    createRepositoriesSourcePublisher({ stateDir, instances: () => [{ instanceId: "core", options: { root: boardRoot, instanceRepository: { owner: "acme", repo: "app" } } }] })();
    writeFileSync(readModelSwitchesPath(stateDir), JSON.stringify({ views: { analytics: "off", "daily-progress": "off" } }));
    let committed = false, onCommitted = (): void => {}; const failures: string[] = [];
    const committedSeen = new Promise<void>(resolve => { onCommitted = resolve; });
    const worker = createReadModelWorker({ stateDir, instances: [{ name: "core", repo: "acme/app", ledgerDir: stateDir, boardRoot }], tickMs: 50,
      log(step, extra) {
        if (step === "read_model.daily_committed") { committed = true; onCommitted(); }
        if (/daily.*(?:failed|refused)|worker_error/.test(step)) failures.push(`${step}: ${String(extra?.reason ?? extra?.error ?? "unknown")}`);
      } });
    worker.start();
    try {
      // Wait for the actual parent persistence receipt, never a staged worker verdict. Like the refusal
      // test below, real thread startup plus the first collection outgrew a fixed 15 s poll on a CI runner,
      // so the BACKSTOP sits past two slow-lane intervals rather than at a guess of runner speed.
      let backstop: NodeJS.Timeout | undefined;
      await Promise.race([committedSeen, new Promise<void>(resolve => { backstop = setTimeout(resolve, 2 * INBOX_CLASSIFY_INTERVAL_MS); })]);
      clearTimeout(backstop);
      assert.ok(committed, `default thread wiring did not commit: ${failures.slice(-5).join("; ")}`);
      const day = readDailyProgressManifest(stateDir).days[dailyProgressDayKey("acme/app", "America/New_York", date)]; assert.ok(day);
      const report = readDailyProgressRevision(stateDir, day);
      assert.deepEqual(report.report.totals.mergedChanges, { value: 1, precision: "exact" });
      assert.equal(report.events[0]!.repository, "acme/app");
      assert.equal(worker.switches().views.analytics, "off"); assert.equal(worker.switches().views["daily-progress"], "off");
    } finally {
      assert.equal(worker.stop(), true, "the real worker confirms shutdown and releases its own leases");
      await flushReadModelTransactions();
    }
  });
});

test("daily progress collector reuses complete snapshots with truthful attribution and source clocks", async () => {
  await withTempDir("daily-collector", async root => {
    const stateDir = join(root, "state"); mkdirSync(stateDir, { recursive: true });
    let now = Date.parse("2026-11-02T06:00:00Z");
    const clock = { now: () => now, iso: () => fixedClock(now).iso(), date: () => fixedClock(now).date() };
    const cache = createBoardSnapshotCache(root, "acme", "app", { clock });
    const rows: BoardPrRest[] = Array.from({ length: 207 }, (_, index) => ({ number: index + 1, url: `https://github.com/acme/app/pull/${index + 1}`,
      state: index === 206 ? "CLOSED" : "MERGED", headRefName: index < 205 ? `run-W1-T${index + 1}-1234567890123` : "manual-change", headRefOid: "a".repeat(40),
      body: index < 205 ? `Remudero-Task: W1-T${index + 1}` : "", autoMergeRequest: null, title: `Repair ${index + 1}`,
      updatedAt: "2026-11-02T05:30:00.000Z", mergedAt: index === 206 ? undefined : "2026-11-01T15:00:00.000Z" }));
    rows.push({ ...rows[0]!, number: 209, url: "https://github.com/acme/app/pull/209", headRefName: "run-unfiled-1234567890123", body: "Remudero-Task: not-a-plan-task" });
    rows.push(mapBoardPr({ number: 210, html_url: "https://github.com/acme/app/pull/210", state: "closed", title: "Dependency update", body: "",
      head: { ref: "dependabot/npm/example-2", sha: "b".repeat(40) }, user: { login: "dependabot[bot]", type: "Bot" },
      updated_at: "2026-11-02T05:30:00Z", merged_at: "2026-11-01T15:00:00Z" }));
    cache.recordClosedAttempt!({ ok: true, persisted: cache.commitClosed(rows) }); cache.commitOpen!([], now);
    assert.equal(Reflect.get(cache.closedSeed()!.get(210)!, "authorLogin"), "dependabot[bot]", "the existing REST adapter and durable snapshot retain verified author evidence");
    const line = (step: string, run: string) => JSON.stringify({ ts: "2026-11-01T16:00:00.000Z", task_id: "W1-T7", run_id: run, step, private: "/secret/path" }) + "\n";
    writeFileSync(join(stateDir, "ledger.2026-11-01.ndjson.gz"), gzipSync(line("worker.spawn", "one")));
    writeFileSync(join(stateDir, "ledger.2026-11-02.ndjson"), line("worker.finished", "two"));
    writeFileSync(join(stateDir, "ledger.ndjson"), line("verdict", "three"));
    const config = { stateDir, expectedRepositories: ["acme/app"], instances: [{ name: "core", root, stateDir, repository: "acme/app" }], timeZone: "America/New_York" };
    const db = openReadModel({ stateDir, instance: "proof", schemaVersion: 1 });
    try {
      const got = acquireLease(db, { clock }); assert.ok(got.ok); if (!got.ok) return;
      const first = await collectDailyProgress(config, clock); assert.ok(first); first.commit(db, got.lease);
      let manifest = readDailyProgressManifest(stateDir);
      const key = dailyProgressDayKey("acme/app", config.timeZone, "2026-11-01");
      const yesterday = readDailyProgressRevision(stateDir, manifest.days[key]!);
      assert.equal(yesterday.report.totals.mergedChanges.value, 206);
      assert.equal(yesterday.report.totals.mergedChanges.precision, "at_least", "unattributed merges are outside confirmed totals");
      assert.equal(yesterday.report.totals.completedTasks.value, 205);
      assert.deepEqual(yesterday.events.find(e => e.id === "merged:acme/app:209")!.taskIds, [], "an unfiled change is not a completed plan task");
      assert.equal(yesterday.events.filter(e => e.fleetAttribution === "unknown" && e.kind === "merged").length, 1);
      assert.ok(!yesterday.events.some(e => e.id === "merged:acme/app:210"), "known dependency-service work is outside fleet activity; a manual merge remains unknown");
      assert.equal(yesterday.events.filter(e => e.kind === "activity").length, 3, "gzip, plain rotation and live ledger positive controls");
      assert.equal(yesterday.report.coverage.state, "partial");
      assert.equal(yesterday.report.coverage.sources.find(s => s.kind === "deployments")!.state, "not_collected");
      assert.ok(!JSON.stringify(yesterday).includes("/secret/path"));
      const today = readDailyProgressRevision(stateDir, manifest.days[dailyProgressDayKey("acme/app", config.timeZone, "2026-11-02")]!);
      assert.deepEqual(today.report.totals.mergedChanges, { value: 0, precision: "exact" }, "a measured zero needs the complete-corpus control");
      assert.equal(await collectDailyProgress(config, clock), undefined, "no page demand or repeated call makes an early hourly job");
      now += 3_600_000;
      rows.push({ ...rows[0]!, number: 208, url: "https://github.com/acme/app/pull/208", headRefName: "run-W1-T208-1234567890123", body: "Remudero-Task: W1-T208" });
      cache.recordClosedAttempt!({ ok: true, persisted: cache.commitClosed(rows) });
      const late = await collectDailyProgress(config, clock); assert.ok(late); late.commit(db, got.lease);
      manifest = readDailyProgressManifest(stateDir);
      assert.equal(readDailyProgressRevision(stateDir, manifest.days[key]!, 1).report.totals.mergedChanges.value, 206);
      assert.equal(readDailyProgressRevision(stateDir, manifest.days[key]!).report.totals.mergedChanges.value, 207);
      assert.equal(readDailyProgressRevision(stateDir, manifest.days[key]!).events.find(e => e.id === yesterday.events.find(e => e.kind === "merged")!.id)!.observedAt, yesterday.events.find(e => e.kind === "merged")!.observedAt);
      now += 3_600_000; cache.recordClosedAttempt!({ ok: false });
      const failed = await collectDailyProgress(config, clock); assert.ok(failed); failed.commit(db, got.lease);
      const retained = readDailyProgressRevision(stateDir, readDailyProgressManifest(stateDir).days[key]!);
      assert.equal(retained.report.totals.mergedChanges.value, 207);
      assert.equal(retained.report.coverage.sources.find(s => s.kind === "pull_requests")!.state, "unavailable");
    } finally { db.close(); await flushReadModelTransactions(); }
  });
});

test("daily progress collects hourly and closes local days without page demand", { timeout: 15_000 }, async () => {
  await withTempDir("daily-worker", async root => {
    const stateDir = join(root, "state"); mkdirSync(stateDir, { recursive: true }); writeFileSync(join(stateDir, "ledger.ndjson"), "");
    let now = Date.parse("2026-11-01T04:25:00Z");
    const clock = { now: () => now, iso: () => fixedClock(now).iso(), date: () => fixedClock(now).date() };
    const cache = createBoardSnapshotCache(root, "acme", "app", { clock });
    cache.recordClosedAttempt!({ ok: true, persisted: cache.commitClosed([]) }); cache.commitOpen!([], now);
    const ticker = createReadModelTicker({ stateDir, instances: [{ name: "core", ledgerDir: stateDir }], views: [], oracle: "off", holder: "daily-worker-proof", clock, post: () => {} });
    ticker.start();
    let receive: (msg: { type: string; held?: boolean; instances?: string[]; ownershipEpoch?: number; modes?: Record<string, string> }) => void = () => { throw new Error("worker port not attached"); };
    let scheduled: (() => void) | undefined;
    let notify: () => void = () => {}, cancelled: () => void = () => {};
    let rejection: (error: Error) => void = () => {};
    const nextCommit = () => new Promise<void>((resolve, reject) => { notify = resolve; rejection = reject; });
    let commits = 0;
    const lane = runSlowLaneWorker({ on(_event, listener) { receive = listener; }, postMessage(value) {
      const message = value as SlowLaneMessage;
      if (message.type === "daily_progress") {
        try { assert.equal(message.ownershipEpoch, 1); ticker.publishDailyProgress(structuredClone(message.publication), ticker.homeLeaseIdentity()!); commits++; notify(); }
        catch (error) { rejection(error as Error); }
      }
      if (message.type === "log" && message.step === "read_model.daily_failed") rejection(new Error(String(message.extra.reason)));
      if (message.type === "log" && message.step === "read_model.daily_cancelled") cancelled();
    } }, { dailyProgress: { stateDir, expectedRepositories: ["acme/app"], instances: [{ name: "core", repository: "acme/app", stateDir, root }] } }, {
      clock, schedule(run) { scheduled = run; return () => { if (scheduled === run) scheduled = undefined; }; },
    });
    try {
      receive({ type: "views", modes: { analytics: "off", "daily-progress": "off" } });
      const first = nextCommit(); receive({ type: "lease", held: true, instances: ["core"], ownershipEpoch: 1 }); await first;
      assert.equal(commits, 1);
      assert.ok(readDailyProgressManifest(stateDir).days[dailyProgressDayKey("acme/app", "America/New_York", "2026-11-01")]);
      now = Date.parse("2026-11-01T05:00:00Z"); ticker.tick();
      const hourly = nextCommit(); assert.ok(scheduled); scheduled(); await hourly;
      assert.equal(commits, 2, "the repeated local hour remains a distinct hourly collection slot");
      now = Date.parse("2026-11-02T05:00:00Z"); ticker.tick();
      cache.recordClosedAttempt!({ ok: true, persisted: cache.commitClosed([]) });
      const midnight = nextCommit(); assert.ok(scheduled); scheduled(); await midnight;
      const manifest = readDailyProgressManifest(stateDir);
      const closed = readDailyProgressRevision(stateDir, manifest.days[dailyProgressDayKey("acme/app", "America/New_York", "2026-11-01")]!);
      assert.equal(closed.report.windowEnd, "2026-11-02T05:00:00.000Z");
      assert.ok(["complete", "corrected"].includes(closed.report.phase));
      assert.ok(manifest.days[dailyProgressDayKey("acme/app", "America/New_York", "2026-11-02")]);
      now += 3_600_000; ticker.tick();
      const aborted = new Promise<void>(resolve => { cancelled = resolve; });
      assert.ok(scheduled); scheduled(); receive({ type: "lease", held: false, instances: [], ownershipEpoch: 2 }); await aborted;
      assert.equal(readDailyProgressManifest(stateDir).generation, manifest.generation, "lost ownership cannot advance durable jobs or reports");
      const oldIdentity = ticker.homeLeaseIdentity(); assert.ok(oldIdentity);
      const staged = prepareDailyProgressPublication(stateDir, [], []);
      const peer = openReadModel({ stateDir, instance: "core", schemaVersion: LEDGER_PROJECTOR_SCHEMA_VERSION });
      try {
        const originalAcquisition = Number(peer.prepare("SELECT acquired_ms FROM lease WHERE name = 'projector'").get()!.acquired_ms);
        now += 60_000;
        const other = acquireLease(peer, { holder: "other-proof-owner", clock }); assert.ok(other.ok); if (!other.ok) return;
        releaseLease(peer, other.lease);
        now = originalAcquisition; // Same owner and repeated clock must still get a different epoch.
        const regained = acquireLease(peer, { holder: "daily-worker-proof", clock }); assert.ok(regained.ok); if (!regained.ok) return;
        const epoch = readModelLeaseEpoch(peer, regained.lease); assert.ok(epoch);
        const renewal = acquireLease(peer, { holder: "daily-worker-proof", clock }); assert.ok(renewal.ok);
        if (renewal.ok) assert.equal(readModelLeaseEpoch(peer, renewal.lease), epoch, "heartbeat renewal preserves ownership identity");
        assert.notEqual(ticker.homeLeaseIdentity(), oldIdentity);
        assert.throws(() => ticker.publishDailyProgress(staged.publication, oldIdentity), /ownership epoch/);
        assert.equal(readDailyProgressManifest(stateDir).generation, manifest.generation);
        now += 60_000;
        const afterExpiry = acquireLease(peer, { holder: "daily-worker-proof", clock }); assert.ok(afterExpiry.ok);
        if (afterExpiry.ok) assert.notEqual(readModelLeaseEpoch(peer, afterExpiry.lease), epoch, "an expired lease starts a new ownership epoch even without an intervening holder");
      } finally { peer.close(); }
    } finally { lane.stop(); ticker.release(); await flushReadModelTransactions(); }
  });
});


test("daily repository inventory refuses a named pipe without blocking the admitted collector", async () => {
  const { spawn, spawnSync } = await import("node:child_process"), { unlinkSync } = await import("node:fs");
  const { pathToFileURL } = await import("node:url"), { repoRoot } = await import("#test/helpers/repo-root.js");
  const { readDailyProgressRepositories } = await import("#src/lib/daily-progress-collector.js");
  await withTempDir("daily-inventory-pipe", async root => {
    const directory = join(root, "read-model"), path = join(directory, "repositories-sources.json"); mkdirSync(directory);
    const { buildRepositoryEvidenceInventory } = await import("#src/lib/daily-progress-contract.js");
    writeFileSync(path, JSON.stringify({ improvementEvidence: buildRepositoryEvidenceInventory([{ instanceId: "core", options: { instanceRepository: { owner: "acme", repo: "app" } } }]) }));
    assert.deepEqual(readDailyProgressRepositories(root), ["acme/app"], "the real regular-file source is the positive control");
    unlinkSync(path); const fifo = spawnSync("mkfifo", [path], { encoding: "utf8" }); assert.equal(fifo.status, 0, fifo.stderr);
    const moduleUrl = pathToFileURL(join(repoRoot(), "src", "lib", "daily-progress-collector.ts")).href;
    const code = `import { readDailyProgressRepositories } from ${JSON.stringify(moduleUrl)}; process.send("ready"); try { readDailyProgressRepositories(process.argv[1]); process.exitCode = 2; } catch (error) { if (!String(error).includes("inventory is unavailable")) throw error; } finally { process.disconnect(); }`;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", code, root], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
    let stderr = "", timedOut = "";
    child.stderr!.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
    const stop = (reason: string) => { timedOut = reason; child.kill("SIGKILL"); };
    // BACKSTOP: cold module loading has its own deadline; the read still gets only five seconds.
    let timer = setTimeout(() => stop("collector module did not finish loading"), 60_000);
    child.once("message", message => {
      assert.equal(message, "ready");
      clearTimeout(timer);
      timer = setTimeout(() => stop("the inventory read must refuse before waiting for a pipe writer"), 5000);
    });
    try {
      const status = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
      assert.equal(timedOut, "", timedOut);
      assert.equal(status, 0, stderr);
    } finally { clearTimeout(timer); child.kill("SIGKILL"); }
  });
});


test("daily collector keeps every configured PR source visible before counting exact totals", async () => {
  await withTempDir("daily-configured-coverage", async root => {
    const now = fixedClock(Date.parse("2026-11-02T12:00:00.000Z")), repository = "acme/app";
    const first = join(root, "first"), second = join(root, "second");
    for (const dir of [first, second]) { mkdirSync(dir); mkdirSync(join(dir, "state")); writeFileSync(join(dir, "state", "ledger.ndjson"), ""); }
    const complete = (boardRoot: string) => {
      const cache = createBoardSnapshotCache(boardRoot, "acme", "app", { clock: now });
      cache.recordClosedAttempt!({ ok: true, persisted: cache.commitClosed([]) }); cache.commitOpen!([], now.now());
    };
    complete(first);
    for (const both of [false, true]) {
      if (both) complete(second);
      const stateDir = join(root, both ? "all-sources" : "missing-source");
      const collected = await collectDailyProgress({ stateDir, expectedRepositories: [repository], instances: [first, second].map((path, index) => ({ name: `instance${index}`, root: path, stateDir: join(path, "state"), repository })) }, now); assert(collected);
      const db = openReadModel({ stateDir, instance: "source-coverage", schemaVersion: 1 });
      try {
        const held = acquireLease(db, { holder: "source-coverage", clock: now }); assert(held.ok); collected.commit(db, held.lease);
        const key = dailyProgressDayKey(repository, "America/New_York", dailyDateAt(now.now())), report = readDailyProgressRevision(stateDir, collected.manifest.days[key]!).report;
        assert.equal(report.coverage.expectedSources.filter(source => source.kind === "pull_requests" && source.required).length, 2);
        assert.equal(report.coverage.sources.filter(source => source.kind === "pull_requests" && source.required).length, 2);
        assert.equal(report.totals.mergedChanges.precision, both ? "exact" : "unavailable", "one complete sibling cannot erase a missing required source");
        if (both) assert.equal(report.totals.mergedChanges.value, 0, "complete persisted source receipts support the measured zero");
      } finally {
        db.close();
        // The transaction recorder writes and removes its sidecar asynchronously; settle it before the temp root goes.
        await flushReadModelTransactions();
      }
    }
  });
});

test("daily collector keeps a source that is no longer configured as optional retained history", async () => {
  await withTempDir("daily-historical-source", async root => {
    let now = Date.parse("2026-11-02T12:00:00.000Z");
    const clock = { now: () => now, iso: () => fixedClock(now).iso(), date: () => fixedClock(now).date() };
    const repository = "acme/app", zone = "America/New_York", stateDir = join(root, "state"); mkdirSync(stateDir);
    const instance = (name: string) => {
      const boardRoot = join(root, name), ledgerDir = join(boardRoot, "state");
      mkdirSync(ledgerDir, { recursive: true }); writeFileSync(join(ledgerDir, "ledger.ndjson"), "");
      return { name, root: boardRoot, stateDir: ledgerDir, repository };
    };
    const core = instance("core"), extra = instance("extra");
    const cache = createBoardSnapshotCache(core.root, "acme", "app", { clock });
    const db = openReadModel({ stateDir, instance: "historical-source", schemaVersion: 1 });
    const collect = async (instances: Array<typeof core>) => {
      cache.recordClosedAttempt!({ ok: true, persisted: cache.commitClosed([]) }); cache.commitOpen!([], now);
      const collected = await collectDailyProgress({ stateDir, expectedRepositories: [repository], instances, timeZone: zone }, clock);
      assert(collected, "the hourly collection job is due");
      const held = acquireLease(db, { holder: "historical-source", clock }); assert(held.ok); collected.commit(db, held.lease);
      return readDailyProgressRevision(stateDir, readDailyProgressManifest(stateDir).days[dailyProgressDayKey(repository, zone, dailyDateAt(now, zone))]!).report;
    };
    try {
      const before = await collect([core, extra]);
      assert.deepEqual(before.coverage.expectedSources.find(s => s.id === "acme/app:prs:extra"),
        { id: "acme/app:prs:extra", repository, kind: "pull_requests", instanceId: "extra", required: true }, "positive control: the configured sibling is required");
      assert.equal(before.totals.mergedChanges.precision, "unavailable", "the uncollected required sibling withholds exact totals");
      now += 3_600_000;
      const after = await collect([core]);
      assert.equal(after.revision, 2, "the same reporting day is collected again over its retained report");
      for (const [id, kind] of [["acme/app:prs:extra", "pull_requests"], ["acme/app:ledger:extra", "ledger_activity"]] as const) {
        assert.deepEqual(after.coverage.expectedSources.find(s => s.id === id), { id, repository, kind, instanceId: "extra", required: false }, `${id} stays expected, as optional history`);
        const retained = after.coverage.sources.find(s => s.id === id); assert(retained, `${id} keeps its retained evidence`);
        assert.equal(retained.required, false); assert.equal(retained.state, "unavailable");
        assert.equal(retained.reason, "This historical source is no longer configured; retained evidence remains available.");
      }
      assert.deepEqual(after.coverage.expectedSources.filter(s => s.required).map(s => s.id), ["acme/app:prs:core"], "only the still-configured PR source is required");
      assert.deepEqual(after.totals.mergedChanges, { value: 0, precision: "exact" }, "a retired source no longer withholds the measured zero");
    } finally { db.close(); await flushReadModelTransactions(); }
  });
});

test("daily production slow lane retains required unowned siblings before counting exact totals", { timeout: 15_000 }, async () => {
  await withTempDir("daily-partial-ownership", async root => {
    const clock = fixedClock(Date.parse("2026-11-02T12:00:00.000Z")), repository = "acme/app";
    const instances = ["core", "sibling"].map((name, index) => {
      const boardRoot = join(root, name), stateDir = join(boardRoot, "state");
      mkdirSync(stateDir, { recursive: true }); writeFileSync(join(stateDir, "ledger.ndjson"), "");
      const cache = createBoardSnapshotCache(boardRoot, "acme", "app", { clock });
      cache.recordClosedAttempt!({ ok: true, persisted: cache.commitClosed([{
        number: index + 1, url: `https://github.com/acme/app/pull/${index + 1}`, state: "MERGED",
        headRefName: `run-W1-T${index + 1}-1234567890123`, headRefOid: "a".repeat(40),
        body: `Remudero-Task: W1-T${index + 1}`, title: `Repair ${index + 1}`, autoMergeRequest: null,
        updatedAt: clock.iso(), mergedAt: "2026-11-02T10:00:00.000Z",
      }]) });
      return { name, root: boardRoot, stateDir, repository };
    });
    for (const owned of [["core"], ["sibling"], ["core", "sibling"], []]) {
      const stateDir = join(root, `owner-${owned.join("-") || "none"}`);
      createRepositoriesSourcePublisher({ stateDir, instances: () => instances.map(instance => ({
        instanceId: instance.name, options: { root: instance.root, instanceRepository: { owner: "acme", repo: "app" } },
      })) })();
      const ticker = createReadModelTicker({ stateDir, instances: [{ name: "core", ledgerDir: stateDir }],
        views: [], oracle: "off", holder: "partial-ownership-proof", clock, post: () => {} });
      ticker.start();
      let receive: (message: { type: string; held: boolean; instances: string[]; ownershipEpoch: number }) => void = () => { throw new Error("port not attached"); };
      let resolveCommit: () => void = () => {}, rejectCommit: (error: Error) => void = () => {};
      const committed = new Promise<void>((resolve, reject) => { resolveCommit = resolve; rejectCommit = reject; });
      const lane = runSlowLaneWorker({ on(_event, listener) { receive = listener; }, postMessage(value) {
        const message = value as SlowLaneMessage;
        if (message.type === "daily_progress") {
          try { ticker.publishDailyProgress(structuredClone(message.publication), ticker.homeLeaseIdentity()!); resolveCommit(); }
          catch (error) { rejectCommit(error as Error); }
        }
        if (message.type === "log" && message.step === "read_model.daily_failed") rejectCommit(new Error(String(message.extra.reason)));
      } }, { dailyProgress: { stateDir, instances } }, { clock, schedule: () => () => {} });
      try {
        receive({ type: "lease", held: true, instances: owned, ownershipEpoch: 1 }); await committed;
        const day = readDailyProgressManifest(stateDir).days[dailyProgressDayKey(repository, "America/New_York", dailyDateAt(clock.now()))]; assert(day);
        const { report, events } = readDailyProgressRevision(stateDir, day);
        assert.deepEqual(report.coverage.expectedSources.filter(source => source.required).map(source => source.id).sort(),
          ["acme/app:prs:core", "acme/app:prs:sibling"], "lease filtering must preserve the configured inventory");
        assert.equal(report.coverage.sources.filter(source => source.required).length, 2);
        assert.deepEqual(report.totals.mergedChanges, owned.length === 2 ? { value: 2, precision: "exact" }
          : owned.length === 1 ? { value: 1, precision: "at_least" } : { value: null, precision: "unavailable" });
        assert.equal(events.length, owned.length, "complete cached receipts from an unowned source must not be read");
        for (const instance of instances.filter(instance => !owned.includes(instance.name))) {
          const source = report.coverage.sources.find(source => source.id === `acme/app:prs:${instance.name}`); assert(source);
          assert.equal(source.state, "not_collected"); assert.equal(source.required, true);
          assert.equal(source.lastSuccessAt, null); assert.match(source.reason!, /not owned/);
          const activity = report.coverage.sources.find(source => source.id === `acme/app:ledger:${instance.name}`); assert(activity);
          assert.equal(activity.state, "not_collected"); assert.equal(activity.required, false);
          assert.equal(activity.lastAttemptAt, null); assert.equal(activity.lastSuccessAt, null);
        }
        const job = Object.values(readDailyProgressManifest(stateDir).jobs)[0]!;
        assert.equal(job.lastSuccessAt, owned.length === 2 ? clock.iso() : null);
        assert.equal(job.error === null, owned.length === 2, "partial ownership cannot certify a successful collection job");
      } finally { lane.stop(); ticker.release(); await flushReadModelTransactions(); }
    }
  });
});

test("daily projector refuses a publication it cannot commit and keeps durable history unchanged", { timeout: 150_000 }, async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { dailyProgressStorePath } = await import("#src/lib/daily-progress-store.js");
  await withTempDir("daily-refused-threads", async root => {
    const stateDir = join(root, "ledger"), boardRoot = join(root, "snapshot-owner");
    mkdirSync(stateDir); mkdirSync(boardRoot); writeFileSync(join(stateDir, "ledger.ndjson"), "");
    const now = systemClock.now();
    const cache = createBoardSnapshotCache(boardRoot, "acme", "app", { clock: fixedClock(now) });
    cache.recordClosedAttempt!({ ok: true, persisted: cache.commitClosed([]) }); cache.commitOpen!([], now);
    createRepositoriesSourcePublisher({ stateDir, instances: () => [{ instanceId: "core", options: { root: boardRoot, instanceRepository: { owner: "acme", repo: "app" } } }] })();
    writeFileSync(readModelSwitchesPath(stateDir), JSON.stringify({ views: { analytics: "off", "daily-progress": "off" } }));
    // Hold the real publication lock, so the owning projector's commit fails on its non-waiting writer lock.
    const store = dailyProgressStorePath(stateDir); mkdirSync(store, { recursive: true });
    const lock = new DatabaseSync(join(store, "publication-lock.sqlite"), { timeout: 0 });
    lock.exec("BEGIN IMMEDIATE");
    let refused: string | undefined, committed = false, onRefused = (): void => {};
    const refusedSeen = new Promise<void>(resolve => { onRefused = resolve; });
    const worker = createReadModelWorker({ stateDir, instances: [{ name: "core", repo: "acme/app", ledgerDir: stateDir, boardRoot }], tickMs: 50,
      log(step, extra) {
        if (step === "read_model.daily_publication_refused") { refused = String(extra?.reason ?? ""); onRefused(); }
        if (step === "read_model.daily_committed") committed = true;
      } });
    worker.start();
    try {
      // Wait for the parent's refusal receipt, never a staged worker verdict. Thread startup and the first
      // collection took ~5 s idle and ~9 s under load, and a fixed 15 s poll timed out once on a CI runner.
      // An ownership-epoch change cancels a collection and the next pass is a full slow-lane interval away,
      // so the BACKSTOP sits past two intervals rather than at a guess of runner speed.
      let backstop: NodeJS.Timeout | undefined;
      await Promise.race([refusedSeen, new Promise<void>(resolve => { backstop = setTimeout(resolve, 2 * INBOX_CLASSIFY_INTERVAL_MS); })]);
      clearTimeout(backstop);
      assert.ok(refused, "the projector reports the publication it could not commit");
      assert.match(refused, /locked|busy/i, "the refusal names the held publication lock");
      assert.equal(committed, false, "a refused publication is never reported as committed");
      assert.equal(readDailyProgressManifest(stateDir).generation, 0, "a refused publication leaves durable history unchanged");
    } finally {
      lock.exec("ROLLBACK"); lock.close();
      assert.equal(worker.stop(), true, "the real worker confirms shutdown and releases its own leases");
      await flushReadModelTransactions();
    }
  });
});

test("daily progress preserves contiguous closing progress across a long restart", async () => {
  await withTempDir("daily-long-restart-audit", async root => {
    const stateDir = join(root, "state"); mkdirSync(stateDir); writeFileSync(join(stateDir, "ledger.ndjson"), "");
    let now = systemClock.now();
    const clock = { now: () => now, iso: () => fixedClock(now).iso(), date: () => fixedClock(now).date() };
    const startDate = dailyDateAt(now), repository = "acme/app", zone = "America/New_York";
    const cache = createBoardSnapshotCache(root, "acme", "app", { clock });
    const config = { stateDir, expectedRepositories: [repository], instances: [{ name: "core", root, stateDir, repository }], timeZone: zone };
    const pass = async () => {
      cache.recordClosedAttempt!({ ok: true, persisted: cache.commitClosed([]) }); cache.commitOpen!([], now);
      const db = openReadModel({ stateDir, instance: "audit", schemaVersion: 1 });
      try {
        const lease = acquireLease(db, { clock }); assert(lease.ok);
        const publication = await collectDailyProgress(config, clock);
        if (publication) { publication.commit(db, lease.lease); await flushReadModelTransactions(); }
        releaseLease(db, lease.lease);
        return publication !== undefined;
      } finally { await flushReadModelTransactions(); db.close(); }
    };
    assert.equal(await pass(), true);
    let manifest = readDailyProgressManifest(stateDir);
    const initial = manifest.days[dailyProgressDayKey(repository, zone, shiftDailyDate(startDate, -1))]; assert(initial);
    assert.equal(readDailyProgressRevision(stateDir, initial).report.phase, "complete", "positive control: the real source receipt covers the closed day");
    assert.equal(Object.values(manifest.jobs)[0]!.closedThrough, shiftDailyDate(startDate, -1));
    now = Date.parse(dailyWindow(shiftDailyDate(startDate, 32), zone).windowStart) + 12 * 3_600_000;
    const today = dailyDateAt(now, zone);
    assert.equal(await pass(), true);
    manifest = readDailyProgressManifest(stateDir);
    const firstClosedThrough = Object.values(manifest.jobs)[0]!.closedThrough;
    for (let batch = 0; batch < 4; batch++) await pass();
    manifest = readDailyProgressManifest(stateDir);
    const missing: string[] = [];
    for (let date = startDate; date < today; date = shiftDailyDate(date, 1)) if (!manifest.days[dailyProgressDayKey(repository, zone, date)]) missing.push(date);
    assert.deepEqual(missing, [], "every missed closing date must be published after bounded catch-up passes");
    assert.equal(firstClosedThrough, shiftDailyDate(startDate, 13), "recent corrections cannot advance the first closing batch beyond its contiguous boundary");
    for (let date = startDate; date < today; date = shiftDailyDate(date, 1)) {
      const day = manifest.days[dailyProgressDayKey(repository, zone, date)];
      assert(day, `missed closing date ${date} must survive the restart backlog`);
      assert.equal(readDailyProgressRevision(stateDir, day).report.phase, "complete");
    }
    assert.equal(Object.values(manifest.jobs)[0]!.closedThrough, shiftDailyDate(today, -1));
  });
});
