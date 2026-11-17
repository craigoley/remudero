import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  runMeasurementCadenceReport,
  runMeasurementCadenceReportAsync,
  type MeasurementCadenceReportOpts,
} from "#src/lib/measurement-cadence.js";
import { gitRepo } from "#test/helpers/git-repo.js";

const FIRST = "2026-01-02T03:04:05+00:00";
const SECOND = "2026-02-03T04:05:06+00:00";
const runners = { sync: runMeasurementCadenceReport, async: runMeasurementCadenceReportAsync };

function fixture(t: TestContext) {
  const repo = gitRepo({ kind: "adoption-ship-dates" });
  t.after(() => repo.cleanup());
  const put = (file: string, text: string) => {
    mkdirSync(dirname(join(repo.dir, file)), { recursive: true });
    writeFileSync(join(repo.dir, file), text);
  };
  put("src/lib/lonely.ts", "export function first() { return 1; }\n");
  put("src/lib/plan.ts", "export interface Task {\n  unused?: string;\n}\n");
  put("scripts/orphan.mjs", "console.log('orphan');\n");
  repo.git("add", "src", "scripts");
  repo.git("commit", "--quiet", "-m", "ship first mechanisms", "--date", FIRST);
  put("src/lib/lonely.ts", "export function first() { return 1; }\nexport function second() { return 2; }\n");
  put("src/lib/other.ts", "export function first() { return 2; }\n");
  repo.git("add", "src");
  repo.git("commit", "--quiet", "-m", "ship second mechanism", "--date", SECOND);
  const stateDir = join(repo.dir, "state");
  const store = join(stateDir, "adoption-ship-dates.json");
  const rows: Record<string, unknown>[] = [];
  const opts: MeasurementCadenceReportOpts = {
    stateDir, cwd: repo.dir, checkoutDir: repo.dir, escalate: false,
    gitLog: () => ({ dump: "", ref: "fixture" }),
    writeLedgerLine: (row) => rows.push(row),
  };
  const metrics = () => rows.filter((row) => row.step === "measurement_cadence.ship_dates");
  const readStore = () => JSON.parse(readFileSync(store, "utf8"));
  return { repo, put, opts, store, rows, metrics, readStore };
}

for (const [mode, run] of Object.entries(runners)) {
  test(`W1-T12884 criterion 1: ${mode} persists dates across runs without another git process`, async (t) => {
    const f = fixture(t);
    const cold = await run(f.opts);
    assert.equal(f.readStore().dates.length, 5);
    // With history unavailable, any repeated production lookup returns unknown.
    renameSync(join(f.repo.dir, ".git"), join(f.repo.dir, "history-away"));
    const warm = await run(f.opts);
    assert.deepEqual(warm.adoptionReport, cold.adoptionReport);
    assert.equal(f.metrics().length, 2);
    assert.equal(f.metrics()[1].kept_dates_read, 5);
    assert.equal(f.metrics()[1].git_lookups, 0);
    assert.deepEqual(readdirSync(f.opts.stateDir), ["adoption-ship-dates.json"]);
  });

  test(`W1-T12884 criterion 2: ${mode} keeps exact file and needle dates, retries unknown and drops absent files`, async (t) => {
    const f = fixture(t);
    const cold = await run(f.opts);
    const findings = cold.adoptionReport!.findings.filter((finding) => finding.shape !== "gate-no-subject");
    assert.equal(findings.length, 5);
    for (const finding of findings) {
      const needle = finding.shape === "field-no-writer" ? "unused?:" : finding.mechanism;
      const args = finding.shape === "script-no-invoker" ? ["--diff-filter=A", "--follow"] : ["-S", needle];
      const dates = f.repo.git("log", ...args, "--format=%aI", "--", finding.definedIn).split("\n");
      assert.equal(finding.shippedAt, dates.at(-1));
    }
    assert.equal(findings.find((finding) => finding.mechanism === "second")!.shippedAt, SECOND);
    f.put("src/lib/uncommitted.ts", "export function pending() { return 3; }\n");
    const unknown = await run(f.opts);
    assert.equal(unknown.adoptionReport!.findings.find((finding) => finding.mechanism === "pending")!.shippedAt, "unknown");
    assert.equal(f.readStore().dates.length, 5, "unknown is never persisted");
    f.repo.git("add", "src/lib/uncommitted.ts");
    f.repo.git("commit", "--quiet", "-m", "ship pending mechanism", "--date", SECOND);
    const retried = await run(f.opts);
    assert.equal(retried.adoptionReport!.findings.find((finding) => finding.mechanism === "pending")!.shippedAt, SECOND);
    rmSync(join(f.repo.dir, "src/lib/other.ts"));
    const pruned = await run(f.opts);
    assert.ok(f.readStore().dates.every(([file]: string[]) => file !== "src/lib/other.ts"));
    const warmDates = f.readStore().dates.sort();
    rmSync(f.store);
    const fresh = await run(f.opts);
    assert.equal(JSON.stringify(pruned.adoptionReport), JSON.stringify(fresh.adoptionReport));
    assert.deepEqual(f.readStore().dates.sort(), warmDates);
  });

  test(`W1-T12884 criterion 3: ${mode} rebuilds a missing, unreadable or corrupt store and tolerates write failure`, async (t) => {
    const f = fixture(t);
    const cold = await run(f.opts);
    assert.equal(f.readStore().dates.length, 5, "missing store is rebuilt");
    const valid = f.readStore();
    for (const content of ["{broken", "null", JSON.stringify({ ...valid, dates: [...valid.dates, ["src/lib/lonely.ts", "first", "unknown"]] })]) {
      writeFileSync(f.store, content);
      assert.deepEqual((await run(f.opts)).adoptionReport, cold.adoptionReport);
      assert.equal(f.readStore().dates.length, 5);
      assert.equal(f.metrics().at(-1)!.git_lookups, 5);
      assert.equal(typeof f.metrics().at(-1)!.store_read_error, "string");
    }
    rmSync(f.store);
    mkdirSync(f.store); // EISDIR denies a read even when the suite runs as root.
    assert.deepEqual((await run(f.opts)).adoptionReport, cold.adoptionReport);
    const failed = f.metrics().at(-1)!;
    assert.equal(failed.git_lookups, 5);
    assert.equal(typeof failed.store_read_error, "string");
    assert.equal(typeof failed.store_write_error, "string");
    assert.deepEqual(readdirSync(f.opts.stateDir), ["adoption-ship-dates.json"], "failed atomic writes leave no staging file");
    rmSync(f.store, { recursive: true });
    await run(f.opts);
    assert.equal(f.readStore().dates.length, 5, "a writable store recovers");
  });

  test(`W1-T12884 criterion 4: ${mode} emits one row counting kept dates, git resolutions and lookup time`, async (t) => {
    const f = fixture(t);
    await run(f.opts);
    assert.equal(f.metrics().length, 1);
    assert.equal(f.metrics()[0].kept_dates_read, 0);
    assert.equal(f.metrics()[0].git_lookups, 5);
    assert.ok(Number(f.metrics()[0].git_lookup_ms) > 0);
    await run(f.opts);
    assert.equal(f.metrics().length, 2);
    assert.equal(f.metrics()[1].kept_dates_read, 5);
    assert.equal(f.metrics()[1].git_lookups, 0);
    assert.equal(f.metrics()[1].git_lookup_ms, 0);
    await run({ ...f.opts, writeLedgerLine: undefined });
    const persisted = readFileSync(join(f.opts.stateDir, "ledger.ndjson"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(persisted.filter((row) => row.step === "measurement_cadence.ship_dates").length, 1);
  });

  test(`${mode} leaves an injected ship-date resolver independent of the production store`, async (t) => {
    const f = fixture(t);
    await run(f.opts);
    const store = readFileSync(f.store, "utf8");
    const injected = await run({ ...f.opts, shipDateFor: () => "fixture-date", shipDateForAsync: async () => "fixture-date" });
    assert.ok(injected.adoptionReport!.findings.filter((finding) => finding.shape !== "gate-no-subject").every((finding) => finding.shippedAt === "fixture-date"));
    assert.equal(readFileSync(f.store, "utf8"), store);
  });

  test(`W1-T12884 criterion 3: ${mode} still returns a report if both store and ledger writes fail`, async (t) => {
    const f = fixture(t);
    const cold = await run(f.opts);
    const errors: string[] = [];
    t.mock.method(process.stderr, "write", (line: string) => { errors.push(line); return true; });
    rmSync(f.opts.stateDir, { recursive: true });
    writeFileSync(f.opts.stateDir, "state directory unavailable");
    assert.deepEqual((await run({ ...f.opts, writeLedgerLine: undefined })).adoptionReport, cold.adoptionReport);
    assert.equal(errors.length, 1);
    const row = JSON.parse(errors[0]);
    assert.equal(row.step, "measurement_cadence.ship_dates");
    assert.equal(row.git_lookups, 5);
    assert.equal(typeof row.store_write_error, "string");
    assert.equal(typeof row.ledger_write_error, "string");
  });
}
