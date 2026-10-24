import assert from "node:assert/strict";
import { fstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os, { tmpdir } from "node:os";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { daemonCommand, drainCommand } from "#src/run-task.js";
import type { Config } from "#src/lib/config.js";
import { createIndexedLifetimeAccounting, LIFETIME_INDEX_MAX_PAGES, LIFETIME_INDEX_PAGE_BYTES } from "#src/lib/lifetime-identity-index.js";
import { auditedLifetimeTalliesFromArchives, MAX_LIFETIME_ARCHIVE_START_IDENTITIES } from "#test/helpers/run-task-test.js";

test("W1-T10228: dispatch.lifetime_history_unavailable no longer recurs", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rmd-lifetime-history-"));
  try {
    // The live ledger had 5134 distinct run starts over 470 archives; the old 4096 ceiling fired on it.
    const count = 5_134;
    assert.equal(MAX_LIFETIME_ARCHIVE_START_IDENTITIES, 4_096);
    const rows = Array.from({ length: count }, (_, n) => ({
      ts: "2026-09-17T00:00:00.000Z", task_id: `W1-T${n % 50}`, run_id: `run-${n}`, step: "run.start",
    }));
    writeFileSync(join(stateDir, "ledger.2026-09-17T00-00-00-000Z.ndjson"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const result = await auditedLifetimeTalliesFromArchives(stateDir);
    assert.equal(result.archiveCount, 1);
    assert.equal(result.records, count);
    assert.equal(result.unavailableReason, undefined);
    assert.ok(result.history);
    for (let task = 0; task < 50; task++) {
      assert.deepEqual(result.history.tallyFor(`W1-T${task}`), {
        starts: Math.floor(count / 50) + Number(task < count % 50), capacityBlocked: 0,
      });
    }
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("W1-T10228: lifetime history still refuses identity overflow", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rmd-lifetime-overflow-"));
  try {
    const rows = Array.from({ length: MAX_LIFETIME_ARCHIVE_START_IDENTITIES + 1 }, (_, n) => ({
      task_id: "W1-T10228", run_id: `run-${n}`, step: "run.start",
    }));
    writeFileSync(join(stateDir, "ledger.2026-09-17T00-00-00-000Z.ndjson"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const result = await auditedLifetimeTalliesFromArchives(stateDir);
    assert.equal(result.archiveCount, 1);
    assert.equal(result.records, rows.length);
    assert.equal(result.unavailableReason, "start_identity_ceiling");
    assert.equal(result.history, undefined);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

function record(index: ReturnType<typeof createIndexedLifetimeAccounting>, task: string, run: string, step = "run.start", excluded = false) {
  index.record({ task_id: task, run_id: run, step }, `${task}\u0000${run}`, excluded);
}

test("the real temporary identity index retains exact identities beyond one page cache", () => {
  const index = createIndexedLifetimeAccounting(4_096);
  try {
    for (let n = 0; n < 5_134; n++) record(index, `task-${n % 50}`, `run-${n}-${"x".repeat(100)}`);
    assert.equal(index.unavailableReason(), undefined);
    for (let n = 0; n < 50; n++) assert.deepEqual(index.tallyFor(`task-${n}`, new Set(), new Set()), {
      starts: Math.floor(5_134 / 50) + Number(n < 5_134 % 50), capacityBlocked: 0,
    });
    const resources = index.resources();
    assert.ok(resources);
    assert.equal(resources.pageBytes, LIFETIME_INDEX_PAGE_BYTES);
    assert.equal(resources.maxPages, LIFETIME_INDEX_MAX_PAGES);
    assert.equal(resources.cacheKiBHint, 256);
    assert.ok(resources.pages * resources.pageBytes > resources.cacheKiBHint * 1024, "the actual corpus exceeds the advisory cache target");
    assert.ok(resources.pages <= resources.maxPages);
  } finally { assert.equal(index.close(), true); }
  assert.equal(index.resources(), undefined);
  assert.equal(index.tallyFor("task-0", new Set(), new Set()), undefined);
});

test("the exact index joins early terminal decisions and ignores distant start replays", () => {
  const index = createIndexedLifetimeAccounting(4_096);
  try {
    record(index, "task", "later", "verdict", false);
    record(index, "task", "later", "verdict", true);
    record(index, "task", "later");
    record(index, "task", "later", "verdict", false);
    record(index, "task", "outage");
    record(index, "task", "outage", "verdict", true);
    for (let n = 0; n < 500; n++) record(index, "noise", `run-${n}`);
    record(index, "task", "outage");
    index.record({ step: "daemon.spawn_infra_blocked", task: "task" }, undefined, false);
    assert.deepEqual(index.tallyFor("task", new Set(), new Set()), { starts: 0, capacityBlocked: 1 });
  } finally { index.close(); }
});

test("the exact index updates visible orphan attribution once and conserves rotated-out state", () => {
  const index = createIndexedLifetimeAccounting(4_096);
  try {
    record(index, "task", "active"); record(index, "task", "orphan");
    const visible = new Set(["active", "orphan"]);
    assert.deepEqual(index.tallyFor("task", visible, new Set(["orphan"])), { starts: 1, capacityBlocked: 0 });
    assert.deepEqual(index.tallyFor("task", visible, new Set(["orphan"])), { starts: 1, capacityBlocked: 0 });
    assert.deepEqual(index.tallyFor("task", new Set(), new Set(["active", "orphan"])), { starts: 1, capacityBlocked: 0 });
    assert.deepEqual(index.tallyFor("task", visible, new Set()), { starts: 2, capacityBlocked: 0 });
    record(index, "task", "active", "verdict", true);
    assert.deepEqual(index.tallyFor("task", visible, new Set()), { starts: 1, capacityBlocked: 0 });
  } finally { index.close(); }
});

test("a real SQLite page overflow refuses the entire index instead of returning a partial tally", () => {
  const index = createIndexedLifetimeAccounting(4_096, { maxPages: 8 });
  try {
    record(index, "task", "small");
    assert.deepEqual(index.tallyFor("task", new Set(), new Set()), { starts: 1, capacityBlocked: 0 });
    for (let n = 0; n < 30 && !index.unavailableReason(); n++) record(index, "task", `run-${n}-${"x".repeat(8_000)}`);
    assert.equal(index.unavailableReason(), "identity_index_unavailable");
    assert.match(index.error()!, /full/i);
    assert.equal(index.tallyFor("task", new Set(), new Set()), undefined);
    assert.equal(index.resources(), undefined);
  } finally { index.close(); }
});

test("an unavailable temporary database refuses history before recording a successful zero", () => {
  const index = createIndexedLifetimeAccounting(4_096, { database: () => { throw new Error("injected temporary storage failure"); } });
  assert.equal(index.unavailableReason(), "identity_index_unavailable");
  assert.match(index.error()!, /temporary storage failure/);
  record(index, "task", "run");
  assert.equal(index.tallyFor("task", new Set(), new Set()), undefined);
  assert.equal(index.close(), true);
});

test("the page policy cannot be raised through the internal qualification option", () => {
  let opened = false;
  const index = createIndexedLifetimeAccounting(4_096, { maxPages: LIFETIME_INDEX_MAX_PAGES + 1, database: () => { opened = true; return new DatabaseSync(""); } });
  assert.equal(opened, false);
  assert.equal(index.unavailableReason(), "identity_index_unavailable");
  assert.equal(index.tallyFor("task", new Set(), new Set()), undefined);
});

test("an index whose connection fails during recording invalidates its old complete tally", () => {
  const db = new DatabaseSync("");
  const index = createIndexedLifetimeAccounting(4_096, { database: () => db });
  record(index, "task", "old");
  assert.deepEqual(index.tallyFor("task", new Set(), new Set()), { starts: 1, capacityBlocked: 0 });
  db.close();
  record(index, "task", "new");
  assert.equal(index.unavailableReason(), "identity_index_unavailable");
  assert.equal(index.tallyFor("task", new Set(), new Set()), undefined);
});

test("a failed index close is observable and cannot leave readable success-shaped state", () => {
  const db = new DatabaseSync("");
  const close = db.close.bind(db);
  const index = createIndexedLifetimeAccounting(4_096, { database: () => db });
  try {
    db.close = () => { throw new Error("injected close failure"); };
    assert.equal(index.close(), false);
    assert.equal(index.unavailableReason(), "identity_index_unavailable");
    assert.match(index.error()!, /close failure/);
    assert.equal(index.tallyFor("task", new Set(), new Set()), undefined);
  } finally { close(); }
});


test("resident task tallies and deferred terminal joins share the unchanged key budget", () => {
  const index = createIndexedLifetimeAccounting(2);
  index.record({ step: "daemon.spawn_infra_blocked", task: "first" }, undefined, false);
  record(index, "second", "deferred", "verdict", true);
  assert.equal(index.resources()?.residentKeys, 2);
  assert.equal(index.resources()?.residentLimit, 2);
  assert.deepEqual(index.tallyFor("first", new Set(), new Set()), { starts: 0, capacityBlocked: 1 });
  index.record({ step: "daemon.spawn_infra_blocked", task: "third" }, undefined, false);
  assert.equal(index.unavailableReason(), "start_identity_ceiling");
  assert.equal(index.tallyFor("first", new Set(), new Set()), undefined);
});

test("a silently ignored SQLite resource policy refuses before creating a usable index", () => {
  const db = new DatabaseSync("");
  const exec = db.exec.bind(db);
  db.exec = sql => exec(sql.replace("PRAGMA max_page_count=8;", ""));
  const index = createIndexedLifetimeAccounting(4_096, { maxPages: 8, database: () => db });
  assert.equal(index.unavailableReason(), "identity_index_unavailable");
  assert.match(index.error()!, /policy was not applied/);
  assert.equal(index.tallyFor("task", new Set(), new Set()), undefined);
});

test("a failed resource read invalidates the old complete tally", () => {
  const db = new DatabaseSync("");
  const index = createIndexedLifetimeAccounting(4_096, { database: () => db });
  record(index, "task", "start");
  db.close();
  assert.equal(index.resources(), undefined);
  assert.equal(index.unavailableReason(), "identity_index_unavailable");
  assert.equal(index.tallyFor("task", new Set(), new Set()), undefined);
});

test("a failed pending-attribution query refuses instead of serving its resident tally", () => {
  const db = new DatabaseSync("");
  const index = createIndexedLifetimeAccounting(4_096, { database: () => db });
  record(index, "task", "start");
  db.close();
  assert.equal(index.tallyFor("task", new Set(["start"]), new Set()), undefined);
  assert.equal(index.unavailableReason(), "identity_index_unavailable");
});

test("a missing start identity remains unknown and cannot be revived by a later valid row", () => {
  const index = createIndexedLifetimeAccounting(4_096);
  index.record({ step: "run.start", task_id: "task" }, undefined, false);
  record(index, "task", "later");
  assert.equal(index.unavailableReason(), "start_identity_missing");
  assert.equal(index.tallyFor("task", new Set(), new Set()), undefined);
});

test("the index preserves the existing embedded-NUL identity interpretation", () => {
  const index = createIndexedLifetimeAccounting(4_096);
  try {
    const task = "task\u0000suffix";
    record(index, task, "run");
    assert.deepEqual(index.tallyFor(task, new Set(["run"]), new Set(["run"])), { starts: 1, capacityBlocked: 0 });
  } finally { index.close(); }
});


test("the real temporary index spills beyond its cache hint and closes its anonymous file", (t) => {
  const regularFiles = () => {
    const files: Array<{ fd: number; dev: number; ino: number; bytes: number; links: number }> = [];
    for (const name of readdirSync("/dev/fd")) {
      const fd = Number(name);
      try {
        const st = fstatSync(fd);
        if (st.isFile()) files.push({ fd, dev: st.dev, ino: st.ino, bytes: st.size, links: st.nlink });
      } catch { /* The descriptor used to list /dev/fd has already closed. */ }
    }
    return files;
  };
  const before = new Set(regularFiles().map(file => `${file.dev}:${file.ino}`));
  const index = createIndexedLifetimeAccounting(4_096);
  let owned: ReturnType<typeof regularFiles> = [];
  try {
    for (let n = 0; n < 5_134; n++) record(index, `task-${n % 50}`, `run-${n}-${"x".repeat(128)}`);
    assert.equal(index.unavailableReason(), undefined);
    const resources = index.resources();
    assert.ok(resources);
    assert.equal(resources.residentKeys, 50);
    owned = regularFiles().filter(file => !before.has(`${file.dev}:${file.ino}`) && file.links === 0 && file.bytes > resources.cacheKiBHint * 1024);
    assert.ok(owned.length > 0, "positive native file-descriptor evidence of an anonymous on-disk spill");
    assert.ok(owned.every(file => file.bytes <= resources.maxPages * resources.pageBytes));
    t.diagnostic(JSON.stringify({ resources, anonymousFiles: owned.map(({ bytes, links }) => ({ bytes, links })) }));
  } finally { assert.equal(index.close(), true); }
  const after = new Set(regularFiles().map(file => `${file.dev}:${file.ino}`));
  assert.ok(owned.every(file => !after.has(`${file.dev}:${file.ino}`)), "the observed anonymous file is no longer open after close");
});


test("a failed failure-observer cannot make the invalid index usable or repeat its notification", () => {
  const failures: Array<{ reason: string; detail?: string }> = [];
  const index = createIndexedLifetimeAccounting(1, { onUnavailable: failure => {
    failures.push(failure);
    throw new Error("injected observer failure");
  } });
  record(index, "task", "first");
  record(index, "task", "second");
  assert.equal(index.unavailableReason(), "start_identity_ceiling");
  assert.equal(index.tallyFor("task", new Set(), new Set()), undefined);
  assert.equal(index.close(), true);
  assert.equal(failures.length, 1);
  assert.match(failures[0]?.detail ?? "", /per-task start identity budget reached/);
});

test("a live index overflow is reported after archive ownership transfers and remains unknown", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-lifetime-index-live-"));
  const failures: Array<{ reason: string; detail?: string }> = [];
  let close: (() => boolean) | undefined;
  try {
    writeFileSync(join(root, "ledger.2026-09-17T00-00-00-000Z.ndjson"), JSON.stringify({ step: "run.start", task_id: "control", run_id: "control" }) + "\n");
    const audit = await auditedLifetimeTalliesFromArchives(root, undefined, failure => failures.push(failure));
    assert.ok(audit.history);
    close = audit.history.close;
    assert.equal(failures.length, 0, "the initial archive was read successfully");
    writeFileSync(join(root, "ledger.ndjson"), Array.from({ length: 4_097 }, (_, n) => JSON.stringify({ step: "run.start", task_id: "task", run_id: `new-${n}` })).join("\n") + "\n");
    assert.equal(audit.history.tallyFor("task"), undefined);
    assert.equal(failures.length, 1);
    assert.equal(failures[0]?.reason, "start_identity_ceiling");
    assert.match(failures[0]?.detail ?? "", /per-task start identity budget reached/);
    assert.equal(audit.history.tallyFor("task"), undefined);
    assert.equal(failures.length, 1, "the same failed index is not repeatedly reported");
  } finally { close?.(); rmSync(root, { recursive: true, force: true }); }
});


for (const loop of ["drain", "daemon"] as const) for (const outcome of ["stopped", "throw"] as const) {
  test(`${loop} releases its real archive index after ${outcome}`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), "rmd-lifetime-owner-"));
    t.mock.method(os, "homedir", () => root);
    syncBuiltinESMExports();
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
    mkdirSync(join(root, ".config", "remudero"), { recursive: true });
    writeFileSync(join(root, ".config", "remudero", "config.json"), JSON.stringify({ root, claudeBin: "/bin/true" }));
    const state = join(root, "state");
    mkdirSync(state);
    writeFileSync(join(state, "ledger.2026-09-17T00-00-00-000Z.ndjson"), JSON.stringify({ step: "run.start", task_id: "control", run_id: "control" }) + "\n");
    const plan = join(root, "tasks.yaml");
    writeFileSync(plan, "[]\n");
    let index: DatabaseSync | undefined;
    const original = DatabaseSync.prototype.exec;
    t.mock.method(DatabaseSync.prototype, "exec", function(this: DatabaseSync, sql: string) {
      if (sql.includes("CREATE TABLE identities")) index = this;
      return original.call(this, sql);
    });
    let entered = false;
    const run = async () => {
      entered = true;
      assert.ok(index, "the actual archive reader opened the real index");
      assert.ok(index.prepare("PRAGMA page_count").get(), "the index is still open while the loop owns it");
      if (outcome === "throw") throw new Error("injected owned-loop failure");
      return { attempted: [], merged: [], stopReason: "stopped" as const, costUsd: 0, ticks: 0, resumeCommand: "rmd drain" };
    };
    const args = loop === "daemon" ? ["--plan", plan, "--max", "0", "--allow-self-target"] : ["--max", "0"];
    const config = { root, claudeBin: "/bin/true" } as Config;
    const command = () => loop === "daemon" ? daemonCommand(args, { runDaemon: run }) : drainCommand(args, {
      config, planPath: plan, skipGitSync: true,
      githubFactory: () => ({ prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined }),
      notifyChannel: { send: () => true } as never, runDrain: run,
    });
    try {
      if (outcome === "throw") await assert.rejects(command, /injected owned-loop failure/);
      else assert.equal(await command(), 0);
      assert.equal(entered, true);
      assert.ok(index);
      assert.throws(() => index!.prepare("SELECT 1"), /not open|closed/i, "the consumer releases the index on its own exit path");
    } finally {
      try { index?.close(); } catch { /* Already closed by the owner, as asserted above. */ }
      rmSync(root, { recursive: true, force: true });
    }
  });
}
