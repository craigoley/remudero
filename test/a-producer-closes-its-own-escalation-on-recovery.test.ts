import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { fixedClock, type Clock } from "#src/lib/clock.js";
import type { IssueGateway } from "#src/lib/escalate.js";
import { gardenStatePath } from "#src/lib/gardener.js";
import { productionGardenerOverseerPorts, runGardenerOverseer, type GardenerOverseerPorts } from "#src/lib/gardener-overseer.js";
import { createLedgerProjector, openProjectorReadModel } from "#src/lib/ledger-projector.js";
import { ORACLE_AGREE_RUNS_TO_CLEAR, READ_MODEL_CONSISTENCY_CLEARED_STEP, runConsistencyCheck, type ConsistencyCheckOptions } from "#src/lib/read-model-consistency.js";
import { acquireLease, type ReadModelDb, type ReadModelLease } from "#src/lib/read-model-db.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { ghShim } from "#test/helpers/gh-shim.js";

const HOUR = 3_600_000;
const T0 = Date.parse("2026-09-20T00:00:00Z");

function makeClock(start: number): Clock & { set(ms: number): void } {
  let t = start;
  return { now: () => t, date: () => new Date(t), iso: () => new Date(t).toISOString(), set: (ms) => { t = ms; } };
}

function row(step: string, at: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { step, ts: new Date(at).toISOString(), ...extra };
}

type Logged = { step: string; extra?: Record<string, unknown> };

interface Overseen {
  dir: string;
  clock: ReturnType<typeof makeClock>;
  rows: Record<string, unknown>[];
  logs: Logged[];
  closes: Array<{ url: string; comment: string }>;
  deps: GardenerOverseerPorts;
}

/** An overseer whose ledger is whatever it logged, so the close can only learn its URL from a durable row. */
function overseen(now: number, over: Partial<GardenerOverseerPorts> = {}): Overseen {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}producer-closes-`));
  const clock = makeClock(now);
  const o: Overseen = { dir, clock, rows: [], logs: [], closes: [], deps: undefined as unknown as GardenerOverseerPorts };
  let issues = 0;
  o.deps = {
    stateDir: dir,
    clock,
    readRows: () => o.rows,
    log: (step, extra) => o.logs.push({ step, extra: { ts: clock.iso(), step, ...extra } }),
    escalate: () => `https://github.com/o/r/issues/${++issues}`,
    stateMtime: () => undefined,
    closeIssue: (url, comment) => { o.closes.push({ url, comment }); },
    readEscalationRows: () => o.logs.map((l) => l.extra as Record<string, unknown>).filter((r) => String(r.step).startsWith("gardener_overseer.")),
    ...over,
  };
  return o;
}

/** Drives `alpha` through notice, heal and escalation; returns the clock time the escalation fired at. */
function escalateAlpha(o: Overseen, T: number): void {
  writeFileSync(gardenStatePath(o.dir, "alpha"), JSON.stringify({ classes: {}, lastCheap: "c", lastPass: { fingerprint: "f" } }));
  for (let i = 0; i < 5; i++) o.rows.push(row("alpha.scorecard", T0 + i * HOUR));
  o.rows.push(row("alpha.gardener_failed", T - 2 * HOUR, { error: "boom" }), row("alpha.gardener_failed", T - HOUR, { error: "boom" }));
  runGardenerOverseer(o.deps);
  runGardenerOverseer(o.deps);
  o.rows.push(row("alpha.gardener_failed", T, { error: "boom again" }));
  runGardenerOverseer(o.deps);
}

const steps = (o: Overseen, step: string): Array<Record<string, unknown> | undefined> => o.logs.filter((l) => l.step === step).map((l) => l.extra);

test("W1-T8866: a producer closes its own escalation on recovery", async (t) => {
  await t.test("a healed gardener's liveness issue is closed from the ledger URL and logged cleared", () => {
    const T = T0 + 10 * HOUR;
    const o = overseen(T);
    try {
      escalateAlpha(o, T);
      assert.equal(steps(o, "gardener_overseer.escalated").length, 1);
      assert.equal(o.closes.length, 0, "an unhealed episode closes nothing");

      // A restart: the overseer's state file is gone memory-wise, but the ledger row still names the issue.
      o.clock.set(T + 2 * HOUR);
      o.rows.push(row("alpha.scorecard", T + 2 * HOUR));
      runGardenerOverseer(o.deps);
      assert.deepEqual(o.closes.map((c) => c.url), ["https://github.com/o/r/issues/1"]);
      assert.match(o.closes[0]!.comment, /first passing scorecard at 2026-09-20T12:00:00.000Z/);
      const cleared = steps(o, "gardener_overseer.cleared");
      assert.equal(cleared.length, 1);
      assert.equal(cleared[0]?.issue_url, "https://github.com/o/r/issues/1");

      runGardenerOverseer(o.deps);
      assert.equal(o.closes.length, 1, "a cleared episode is closed once");
    } finally {
      rmSync(o.dir, { recursive: true, force: true });
    }
  });

  await t.test("an unreadable ledger or a failing close leaves the issue open and the episode for the next pass", () => {
    const T = T0 + 10 * HOUR;
    let readable = false;
    let closable = false;
    const o = overseen(T, {});
    const rowsOf = o.deps.readEscalationRows!;
    o.deps.readEscalationRows = () => {
      if (!readable) throw new Error("ledger unreadable");
      return rowsOf();
    };
    o.deps.closeIssue = (url, comment) => {
      if (!closable) throw new Error("gh down");
      o.closes.push({ url, comment });
    };
    try {
      escalateAlpha(o, T);
      o.clock.set(T + 2 * HOUR);
      o.rows.push(row("alpha.scorecard", T + 2 * HOUR));
      runGardenerOverseer(o.deps);
      assert.equal(steps(o, "gardener_overseer.clear_unreadable").length, 1);
      assert.equal(o.closes.length, 0, "an unreadable read means no close");
      readable = true;
      runGardenerOverseer(o.deps);
      assert.equal(steps(o, "gardener_overseer.clear_failed").length, 1);
      assert.equal(steps(o, "gardener_overseer.cleared").length, 0);
      closable = true;
      runGardenerOverseer(o.deps);
      assert.equal(o.closes.length, 1, "the kept episode is retried and closes once the read and the close work");
      assert.equal(steps(o, "gardener_overseer.cleared").length, 1);
    } finally {
      rmSync(o.dir, { recursive: true, force: true });
    }
  });

  await t.test("at most one close per pass", () => {
    const T = T0 + 10 * HOUR;
    const o = overseen(T);
    try {
      for (const name of ["alpha", "beta"]) {
        writeFileSync(gardenStatePath(o.dir, name), JSON.stringify({ classes: {}, lastCheap: "c", lastPass: { fingerprint: "f" } }));
        for (let i = 0; i < 5; i++) o.rows.push(row(`${name}.scorecard`, T0 + i * HOUR));
        o.rows.push(row(`${name}.gardener_failed`, T - 2 * HOUR, { error: "boom" }), row(`${name}.gardener_failed`, T - HOUR, { error: "boom" }));
      }
      runGardenerOverseer(o.deps);
      runGardenerOverseer(o.deps);
      for (const name of ["alpha", "beta"]) o.rows.push(row(`${name}.gardener_failed`, T, { error: "again" }));
      runGardenerOverseer(o.deps);
      assert.equal(steps(o, "gardener_overseer.escalated").length, 2);
      o.clock.set(T + 2 * HOUR);
      for (const name of ["alpha", "beta"]) o.rows.push(row(`${name}.scorecard`, T + 2 * HOUR));
      runGardenerOverseer(o.deps);
      assert.equal(o.closes.length, 1, "the second close waits for the next pass");
      runGardenerOverseer(o.deps);
      assert.equal(o.closes.length, 2);
    } finally {
      rmSync(o.dir, { recursive: true, force: true });
    }
  });

  await t.test("the production ports read the URL from the real ledger and close through the gateway", () => {
    const T = T0 + 10 * HOUR;
    const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}producer-closes-prod-`));
    try {
      const ports = productionGardenerOverseerPorts({ stateDir: dir, repoRoot: dir, owner: "o", repo: "r", fetch: () => ({}), log: () => {}, clock: makeClock(T) });
      assert.equal(typeof ports.closeIssue, "function");
      assert.deepEqual(ports.readEscalationRows!(), [], "an empty ledger reads as no rows");
      writeFileSync(join(dir, "ledger.ndjson"), [
        JSON.stringify({ ts: new Date(T - HOUR).toISOString(), step: "gardener_overseer.escalated", gardener: "alpha", issue_url: "https://github.com/o/r/issues/7" }),
        JSON.stringify({ ts: new Date(T - HOUR).toISOString(), step: "gardener.pass", gardener: "alpha" }),
      ].join("\n") + "\n");
      assert.deepEqual(ports.readEscalationRows!().map((r) => r.issue_url), ["https://github.com/o/r/issues/7"]);
      const viaPorts = productionGardenerOverseerPorts({ stateDir: dir, repoRoot: dir, owner: "o", repo: "r", fetch: () => ({}), log: () => {}, closeIssue: () => { throw new Error("injected"); } });
      assert.throws(() => viaPorts.closeIssue!("https://github.com/o/r/issues/7", "x"), /injected/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test("the default closeIssue port runs the real gh issue gateway: `gh issue close <url> --comment`", () => {
    const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}producer-closes-default-`));
    const shim = ghShim([], { kind: "producer-closes-default-gh" });
    const savedPath = process.env.PATH;
    try {
      const ports = productionGardenerOverseerPorts({ stateDir: dir, repoRoot: dir, owner: "o", repo: "r", fetch: () => ({}), log: () => {} });
      process.env.PATH = `${shim.dir}:${savedPath}`;
      ports.closeIssue!("https://github.com/o/r/issues/7", "the gardener recovered");
      assert.deepEqual(shim.calls(), ["issue close https://github.com/o/r/issues/7 --repo o/r --comment the gardener recovered"]);
    } finally {
      process.env.PATH = savedPath;
      rmSync(dir, { recursive: true, force: true });
      rmSync(shim.dir, { recursive: true, force: true });
    }
  });

  await t.test("the default closeIssue port surfaces a gh failure instead of reporting a phantom close", () => {
    const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}producer-closes-default-fail-`));
    const shim = ghShim([{ when: "issue close", stderr: "gh: HTTP 502 (fixture)", exit: 1 }], { kind: "producer-closes-default-fail-gh" });
    const savedPath = process.env.PATH;
    try {
      const ports = productionGardenerOverseerPorts({ stateDir: dir, repoRoot: dir, owner: "o", repo: "r", fetch: () => ({}), log: () => {} });
      process.env.PATH = `${shim.dir}:${savedPath}`;
      assert.throws(() => ports.closeIssue!("https://github.com/o/r/issues/7", "x"));
      assert.equal(shim.calls().length, 1, "gh was invoked once and its failure propagated");
    } finally {
      process.env.PATH = savedPath;
      rmSync(dir, { recursive: true, force: true });
      rmSync(shim.dir, { recursive: true, force: true });
    }
  });

  await t.test("a read-model issue followed by N agreeing runs is closed with the URL from its ledger row", (c) => {
    const f = readModel(c);
    f.corrupt();
    const issues = fakeIssues();
    const escalation = { issues, ledgerPath: f.metricPath, runId: "oracle" };
    f.db.exec("CREATE TRIGGER undo_heal AFTER DELETE ON fact BEGIN INSERT INTO fact(ts, ts_ms, step, task_id, run_id, body) VALUES(old.ts, old.ts_ms, old.step, old.task_id, old.run_id, old.body); END");
    assert.equal(f.check({ escalation }).outcome, "escalated");
    assert.equal(issues.created.length, 1);
    f.db.exec("DROP TRIGGER undo_heal");
    assert.equal(f.check({ escalation }, DAY_MIN).outcome, "healed");
    for (let i = 0; i < ORACLE_AGREE_RUNS_TO_CLEAR - 1; i++) {
      assert.equal(f.check({ escalation }, DAY_MIN + 1 + i).outcome, "agree");
      assert.equal(issues.closed.length, 0, "fewer than N agreeing runs close nothing");
    }
    assert.equal(f.check({ escalation }, DAY_MIN + 9).outcome, "agree");
    assert.deepEqual(issues.closed.map((x) => x.url), [issues.created[0]]);
    assert.match(issues.closed[0]!.comment, /3 consecutive runs/);
    const cleared = f.metrics().filter((m) => m.step === READ_MODEL_CONSISTENCY_CLEARED_STEP);
    assert.equal(cleared.length, 1);
    assert.equal(cleared[0]?.issue_url, issues.created[0]);
    assert.equal(f.check({ escalation }, DAY_MIN + 10).outcome, "agree");
    assert.equal(issues.closed.length, 1, "a closed escalation is not closed again");
  });

  await t.test("a ledgerLost mismatch stays open however many runs agree after it", (c) => {
    const f = readModel(c);
    const issues = fakeIssues();
    const escalation = { issues, ledgerPath: f.metricPath, runId: "oracle" };
    f.dropLastRow();
    const lost = f.check({ escalation });
    assert.equal(lost.outcome, "escalated");
    assert.ok(lost.mismatches.ledgerLost > 0, "the fixture lost a ledger row");
    const elsewhere = { t0: R0 - 1, t1: R0 + 5_500 };
    for (let i = 0; i < ORACLE_AGREE_RUNS_TO_CLEAR + 2; i++) {
      assert.equal(f.check({ escalation, window: elsewhere }, DAY_MIN + i).outcome, "agree");
    }
    assert.equal(issues.closed.length, 0);
  });

  await t.test("a failing gateway or an unreadable ledger leaves a read-model issue open", (c) => {
    const f = readModel(c);
    f.corrupt();
    const issues = fakeIssues();
    const escalation = { issues, ledgerPath: f.metricPath, runId: "oracle" };
    f.db.exec("CREATE TRIGGER undo_heal AFTER DELETE ON fact BEGIN INSERT INTO fact(ts, ts_ms, step, task_id, run_id, body) VALUES(old.ts, old.ts_ms, old.step, old.task_id, old.run_id, old.body); END");
    assert.equal(f.check({ escalation }).outcome, "escalated");
    f.db.exec("DROP TRIGGER undo_heal");
    assert.equal(f.check({ escalation }, DAY_MIN).outcome, "healed");
    issues.failClose = true;
    for (let i = 0; i < ORACLE_AGREE_RUNS_TO_CLEAR; i++) assert.equal(f.check({ escalation }, DAY_MIN + 1 + i).outcome, "agree");
    assert.equal(issues.closed.length, 0);
    assert.ok(f.metrics().some((m) => m.step === "read_model.consistency_clear_failed" && m.reason === "close_failed"));
    // A ledger rotation that cannot be decompressed is an incomplete read: no close, and the row names why.
    const g = readModel(c);
    g.corrupt();
    const gi = fakeIssues();
    const gEsc = { issues: gi, ledgerPath: g.metricPath, runId: "oracle" };
    g.db.exec("CREATE TRIGGER undo_heal AFTER DELETE ON fact BEGIN INSERT INTO fact(ts, ts_ms, step, task_id, run_id, body) VALUES(old.ts, old.ts_ms, old.step, old.task_id, old.run_id, old.body); END");
    assert.equal(g.check({ escalation: gEsc }).outcome, "escalated");
    g.db.exec("DROP TRIGGER undo_heal");
    assert.equal(g.check({ escalation: gEsc }, DAY_MIN).outcome, "healed");
    writeFileSync(join(dirname(g.metricPath), "ledger.2026-10-30T00-00-00-000Z.ndjson.gz"), "not gzip");
    for (let i = 0; i < ORACLE_AGREE_RUNS_TO_CLEAR; i++) assert.equal(g.check({ escalation: gEsc }, DAY_MIN + 1 + i).outcome, "agree");
    assert.equal(gi.closed.length, 0, "an unreadable ledger means no close");
    assert.ok(g.metrics().some((m) => m.step === "read_model.consistency_clear_failed" && m.reason === "ledger_unreadable"));
  });
});

// ---- read-model fixture -------------------------------------------------------------------------------------

function fakeIssues(): IssueGateway & { created: string[]; closed: Array<{ url: string; comment: string }>; failClose: boolean } {
  const g = {
    created: [] as string[],
    closed: [] as Array<{ url: string; comment: string }>,
    failClose: false,
    create(): string {
      const url = `https://github.com/craigoley/remudero/issues/${9000 + g.created.length + 1}`;
      g.created.push(url);
      return url;
    },
    closeWithComment(url: string, comment: string): void {
      if (g.failClose) throw new Error("gh down");
      g.closed.push({ url, comment });
    },
  };
  return g;
}

const R0 = Date.parse("2026-09-30T12:00:00.000Z");
const CHECK_AT = R0 + HOUR;
/** Past the 24 h in which a second heal would count as a recurrence of the first. */
const DAY_MIN = 25 * 60;

interface RmFixture {
  db: ReadModelDb;
  lease: ReadModelLease;
  metricPath: string;
  t1: number;
  check: (extra?: Partial<ConsistencyCheckOptions>, minutes?: number) => ReturnType<typeof runConsistencyCheck>;
  metrics: () => Array<Record<string, unknown>>;
  corrupt: () => void;
  dropLastRow: () => void;
}

function readModel(t: { after: (fn: () => void) => void }): RmFixture {
  const rowsDir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}producer-closes-rows-`));
  const stateDir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}producer-closes-state-`));
  const metricDir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}producer-closes-metric-`));
  t.after(() => { for (const d of [rowsDir, stateDir, metricDir]) rmSync(d, { recursive: true, force: true }); });
  const lines = Array.from({ length: 12 }, (_, i) => JSON.stringify({ ts: new Date(R0 + i * 1_000).toISOString(), host: "h1", step: i % 3 === 0 ? "worker.activity" : "run.start", task_id: `W1-T${i}`, run_id: `r${i}` }));
  writeFileSync(join(rowsDir, "ledger.ndjson"), `${lines.join("\n")}\n`);
  const clock = fixedClock(R0 + 60_000);
  const db = openProjectorReadModel(stateDir, "core", clock);
  t.after(() => db.close());
  const got = acquireLease(db, { clock });
  if (!got.ok) throw new Error("lease");
  createLedgerProjector({ ledgerDir: rowsDir, db, lease: got.lease, clock }).tick();
  const metricPath = join(metricDir, "ledger.ndjson");
  return {
    db, lease: got.lease, metricPath, t1: CHECK_AT - 600_000,
    check: (extra = {}, minutes = 0) => runConsistencyCheck({ db, ledgerDir: rowsDir, instance: "core", metricLedgerPath: metricPath, lease: got.lease, clock: fixedClock(CHECK_AT + minutes * 60_000), ...extra }),
    metrics: () => (existsSync(metricPath) ? readFileSync(metricPath, "utf8").trim().split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as Record<string, unknown>) : []),
    dropLastRow: () => writeFileSync(join(rowsDir, "ledger.ndjson"), `${lines.slice(0, -1).join("\n")}\n`),
    corrupt: () => db.exec("UPDATE fact SET task_id = 'W9-T9' WHERE seq = (SELECT min(seq) FROM fact)"),
  };
}
