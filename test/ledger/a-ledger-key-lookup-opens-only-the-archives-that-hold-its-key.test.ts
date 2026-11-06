/**
 * W1-T11423 — a keyed ledger question opens only the archives that hold its key.
 *
 * Differential: every query is answered twice, by `ledgerRowsFor` and by a FULL union read filtered with the
 * same predicate, and the two must be identical (rows, order, replay dedupe). Then the archives it opened are
 * asserted to be exactly the ones holding a requested key.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test, type TestContext } from "node:test";
import { ledgerRowsFor, ledgerRowsForSync, readLedgerUnionRecords } from "#src/lib/ledger-union.js";
import {
  LEDGER_KEY_MANIFEST_VERSION,
  ledgerKeyManifestDirectory,
  pruneLedgerKeyManifests,
  realLedgerKeyManifestFs,
  ledgerRowMatchesKeys,
  type LedgerKeyQuery,
} from "#src/lib/ledger-key-manifest.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const TIMEOUT = { timeout: 120_000 };
const day = (d: number, h = 0) => `2026-10-${String(d).padStart(2, "0")}T${String(h).padStart(2, "0")}:00:00.000Z`;
const filler = (d: number, i: number) => ({ ts: day(d, 1), run_id: `run-W1-T90${i}`, task_id: `W1-T90${i}`, step: "run.start" });

// The task's own row in archive 3, replayed verbatim by the next rotation (retained-row carry-over): the
// union must yield it once.
const replayed = { ts: day(3, 5), run_id: "run-W1-T7-a", task_id: "W1-T7", step: "dispatch" };

function corpus(scope: TestContext) {
  return writeLedger(
    [ // live
      { ts: day(9, 2), run_id: "run-W1-T7-b", task_id: "W1-T7", step: "verdict", verdict: "pass" },
      { ts: day(9, 3), run_id: "run-W1-T95", task_id: "W1-T95", step: "review.posted", pr_url: "https://github.com/o/r/pull/41" },
      filler(9, 1),
    ],
    {
      scope,
      rotations: [
        { at: day(2), gz: true, rows: [filler(1, 1), filler(1, 2)] },
        { at: day(4), gz: true, rows: [filler(3, 3), replayed, { ts: day(3, 6), run_id: "run-W1-T7-a", task_id: "W1-T7", step: "pr.opened", pr_number: 41 }] },
        { at: day(5), gz: true, rows: [replayed, filler(4, 4)] },
        { at: day(6), gz: true, rows: [filler(5, 5), { ts: day(5, 2), task_id: "W1-T95", step: "review.posted", pr: "41" }] },
        { at: day(7), gz: true, rows: [filler(6, 6), filler(6, 7)] },
        // A late row: stamped BEFORE rows an earlier archive holds, so order must stay file order.
        { at: day(8), gz: true, rows: [{ ts: day(2, 9), run_id: "run-W1-T7-a", task_id: "W1-T7", step: "late.note" }, filler(7, 8)] },
        { at: day(8, 12), gz: true, rows: [filler(8, 9)] },
      ],
    },
  );
}

const archiveNames = (paths: string[]) => paths.map((p) => p.slice(p.lastIndexOf("/") + 1));

async function fullFiltered(dir: string, query: LedgerKeyQuery): Promise<Array<Record<string, unknown>>> {
  const rows = await readLedgerUnionRecords(dir, {
    ...(query.since !== undefined ? { since: query.since } : {}),
    ...(query.steps?.length ? { step: [...query.steps] } : {}),
  });
  return rows.filter((row) => ledgerRowMatchesKeys(row, query));
}

test("W1-T11423 criterion 1: a task lookup returns the full union's rows and opens only the archives that hold the task", TIMEOUT, async (t) => {
  const { dir } = corpus(t);
  const query = { taskIds: ["W1-T7"] };
  const got = await ledgerRowsFor(dir, query);
  const want = await fullFiltered(dir, query);
  assert.ok(want.length >= 4, "positive control: the full read finds the task's rows");
  assert.deepEqual(got.rows, want);
  assert.equal(got.rows.filter((r) => r.step === "dispatch").length, 1, "the replayed row is deduped once");
  assert.deepEqual(archiveNames(got.archivesOpened), [
    "ledger.2026-10-04T00-00-00-000Z.ndjson.gz",
    "ledger.2026-10-05T00-00-00-000Z.ndjson.gz",
    "ledger.2026-10-08T00-00-00-000Z.ndjson.gz",
  ]);
  assert.equal(got.archivesSkipped, 4);
  assert.deepEqual(got.unindexed, []);
  assert.equal(got.ok, true);
});

test("W1-T11423 criterion 1: PR, run, step and since queries match the filtered full read, every alias form included", TIMEOUT, async (t) => {
  const { dir } = corpus(t);
  const queries: LedgerKeyQuery[] = [
    { prNumbers: [41] },
    { runIds: ["run-W1-T7-a"] },
    { steps: ["review.posted"] },
    { taskIds: ["W1-T7"], steps: ["dispatch", "late.note"] },
    { taskIds: ["W1-T7"], since: day(5) },
    { prNumbers: [41], taskIds: ["W1-T906"] },
    { taskIds: ["W1-T-absent"] },
  ];
  for (const query of queries) {
    const got = await ledgerRowsFor(dir, query);
    assert.deepEqual(got.rows, await fullFiltered(dir, query), JSON.stringify(query));
    assert.deepEqual(ledgerRowsForSync(dir, query).rows, got.rows, `sync agrees: ${JSON.stringify(query)}`);
  }
  const pr = await ledgerRowsFor(dir, { prNumbers: [41] });
  assert.equal(pr.rows.length, 3, "pr_number, pr and pr_url all name PR 41");
  assert.deepEqual(archiveNames(pr.archivesOpened), ["ledger.2026-10-04T00-00-00-000Z.ndjson.gz", "ledger.2026-10-06T00-00-00-000Z.ndjson.gz"]);
  const absent = await ledgerRowsFor(dir, { taskIds: ["W1-T-absent"] });
  assert.deepEqual(absent.archivesOpened, [], "a key no archive holds opens none");
  const since = await ledgerRowsFor(dir, { taskIds: ["W1-T7"], since: day(5) });
  assert.ok(!archiveNames(since.archivesOpened).includes("ledger.2026-10-04T00-00-00-000Z.ndjson.gz"), "an archive wholly before since is never opened");
});

test("W1-T11423 criterion 2: each archive's manifest is built once, reused, and a stale, damaged, foreign or old-version one is rebuilt", TIMEOUT, async (t) => {
  const { dir } = corpus(t);
  const manifests = ledgerKeyManifestDirectory(dir);
  const first = await ledgerRowsFor(dir, { taskIds: ["W1-T7"] });
  assert.equal(first.manifestsBuilt, 7, "first sight builds one manifest per archive");
  assert.equal(readdirSync(manifests).filter((n) => n.endsWith(".json")).length, 7);
  const second = await ledgerRowsFor(dir, { prNumbers: [41] });
  assert.equal(second.manifestsBuilt, 0, "an unchanged archive's manifest is reused");
  assert.equal(ledgerRowsForSync(dir, { taskIds: ["W1-T7"] }).manifestsBuilt, 0, "the sync reader shares the store");

  const name = "ledger.2026-10-05T00-00-00-000Z.ndjson.gz";
  const manifestPath = join(manifests, `${name}.json`);
  const stored = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.equal(stored.reducerVersion, LEDGER_KEY_MANIFEST_VERSION);
  assert.ok(stored.manifest.taskIds.includes("W1-T7"));

  // stale: the archive's mtime moved
  utimesSync(join(dir, name), new Date(), new Date(Date.now() + 5_000));
  assert.equal((await ledgerRowsFor(dir, { taskIds: ["W1-T7"] })).manifestsBuilt, 1, "a touched archive is re-manifested");
  // damaged
  writeFileSync(manifestPath, "{not json");
  assert.equal((await ledgerRowsFor(dir, { taskIds: ["W1-T7"] })).manifestsBuilt, 1, "a damaged manifest is rebuilt");
  // foreign: another archive's manifest copied in
  writeFileSync(manifestPath, readFileSync(join(manifests, "ledger.2026-10-02T00-00-00-000Z.ndjson.gz.json")));
  const afterForeign = await ledgerRowsFor(dir, { taskIds: ["W1-T7"] });
  assert.equal(afterForeign.manifestsBuilt, 1, "a foreign manifest is rebuilt, not trusted");
  assert.ok(archiveNames(afterForeign.archivesOpened).includes(name), "the rebuilt manifest still finds the key");
  // old version
  const current = JSON.parse(readFileSync(manifestPath, "utf8"));
  writeFileSync(manifestPath, JSON.stringify({ ...current, reducerVersion: "0" }));
  assert.equal((await ledgerRowsFor(dir, { taskIds: ["W1-T7"] })).manifestsBuilt, 1, "an old-version manifest is rebuilt");
  // and the rebuilt manifest is current again
  assert.equal((await ledgerRowsFor(dir, { taskIds: ["W1-T7"] })).manifestsBuilt, 0);
});

test("W1-T11423: an archive whose manifest cannot be built is read in full and reported, never skipped", TIMEOUT, async (t) => {
  const { dir } = corpus(t);
  const name = "ledger.2026-10-07T00-00-00-000Z.ndjson.gz";
  writeFileSync(join(dir, name), Buffer.from("not gzip"));
  const got = await ledgerRowsFor(dir, { taskIds: ["W1-T7"] });
  assert.deepEqual(archiveNames(got.unindexed), [name]);
  assert.ok(got.unread.some((p) => p.endsWith(name)), "the unreadable archive is reported unread");
  assert.equal((await ledgerRowsFor(dir, { taskIds: ["W1-T7"] }, { refuseIncomplete: true })).ok, false);
});

test("W1-T11423: the sync lookup also reads an archive whose manifest cannot be built in full and reports it", TIMEOUT, (t) => {
  const { dir } = corpus(t);
  const name = "ledger.2026-10-07T00-00-00-000Z.ndjson.gz";
  writeFileSync(join(dir, name), Buffer.from("not gzip"));
  const got = ledgerRowsForSync(dir, { taskIds: ["W1-T7"] });
  assert.deepEqual(archiveNames(got.unindexed), [name]);
  assert.ok(got.unread.some((p) => p.endsWith(name)), "the unreadable archive is reported unread");
  assert.equal(ledgerRowsForSync(dir, { taskIds: ["W1-T7"] }, { refuseIncomplete: true }).ok, false);
});

test("W1-T11423: a manifest whose archive is gone is pruned, and one already removed by another process is not an error", TIMEOUT, async (t) => {
  const { dir } = corpus(t);
  const manifests = ledgerKeyManifestDirectory(dir);
  await ledgerRowsFor(dir, { taskIds: ["W1-T7"] });
  const gone = "ledger.2026-10-07T00-00-00-000Z.ndjson.gz";
  assert.ok(readdirSync(manifests).includes(`${gone}.json`));
  unlinkSync(join(dir, gone));
  await ledgerRowsFor(dir, { taskIds: ["W1-T7"] });
  assert.ok(!readdirSync(manifests).includes(`${gone}.json`), "the next lookup prunes the orphaned manifest");
  assert.equal(readdirSync(manifests).filter((n) => n.endsWith(".json")).length, 6);

  const racing = { ...realLedgerKeyManifestFs, readdirSync: () => ["orphan.ndjson.gz.json"],
    unlinkSync: () => { throw Object.assign(new Error("gone"), { code: "ENOENT" }); } };
  assert.equal(pruneLedgerKeyManifests(dir, new Set(), racing), 0, "a manifest another process removed counts as nothing pruned");
});

test("W1-T11423: a lookup retains only its own rows, where the full union read exhausts the same heap", { timeout: 300_000 }, (t) => {
  // Heap-capped child: the full read must abort (positive control) and the keyed read must pass.
  const { dir } = writeLedger([], {
    scope: t,
    rotations: Array.from({ length: 8 }, (_, a) => ({
      at: day(10 + a), gz: true,
      rows: Array.from({ length: 40_000 }, (_, i) => ({ ts: day(10 + a, 1), task_id: `W1-T${a}${i}`, run_id: `r${a}-${i}`, step: "noise", pad: "x".repeat(160) })),
    })).concat([{ at: day(19), gz: true, rows: [{ ts: day(18, 1), task_id: "W1-T7", run_id: "r", step: "wanted", pad: "" }] }]),
  });
  const run = (body: string) => spawnSync(process.execPath, ["--max-old-space-size=96", "--import", "tsx", "--input-type=module", "-e", body],
    { cwd: REPO_ROOT, encoding: "utf8", timeout: 240_000 });
  const lib = JSON.stringify(join(REPO_ROOT, "src/lib/ledger-union.ts"));
  const full = run(`const u = await import(${lib}); const rows = await u.readLedgerUnionRecords(${JSON.stringify(dir)}, {}); console.log(rows.length);`);
  assert.notEqual(full.status, 0, `positive control: the full read must exhaust a 96 MB heap (stdout ${full.stdout})`);
  const keyed = run(`const u = await import(${lib}); const r = await u.ledgerRowsFor(${JSON.stringify(dir)}, { taskIds: ["W1-T7"] }); console.log(JSON.stringify({ rows: r.rows.length, opened: r.archivesOpened.length }));`);
  assert.equal(keyed.status, 0, keyed.stderr.slice(-2000));
  assert.deepEqual(JSON.parse(keyed.stdout.trim().split("\n").at(-1)!), { rows: 1, opened: 1 });
});
