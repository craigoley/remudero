import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { Config } from "../src/lib/config.js";
import { validateConfig } from "../src/lib/config.js";
import { openWeightCommittedUsd, openWeightReservationUsd, reserveOpenWeightBudget, type OpenWeightAllowanceState } from "../src/lib/worker-provider.js";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const ISO = "2026-09-27T12:00:00.000Z";

function config(root: string, shared: string, cap = 25): Config {
  return { root, claudeBin: "/unused", dailyCapUsd: cap, workerProviders: { enabled: ["cash"], fleetCashAllowancePath: shared } } as Config;
}

async function until(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for " + label);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function child(shared: string, root: string, id: string, marker: string, release?: string): ChildProcess {
  const code = [
    'import { writeFileSync, existsSync } from "node:fs";',
    'import { reserveOpenWeightBudget } from ' + JSON.stringify(join(REPO, "src/lib/worker-provider.ts")) + ';',
    'const [shared, root, id, marker, release] = process.argv.slice(1);',
    'writeFileSync(marker + ".started", "started");',
    'try { reserveOpenWeightBudget({ root, claudeBin: "/unused", dailyCapUsd: 25, workerProviders: { enabled: ["cash"], fleetCashAllowancePath: shared } },',
    '  { requestId: id, deployment: "gpt-oss-120b", requestBodyBytes: 10, atIso: "2026-09-27T12:00:00.000Z", beforeCommit: () => {',
    '    writeFileSync(marker, "entered");',
    '    if (release !== "-") { const pause = new Int32Array(new SharedArrayBuffer(4));',
    '      while (!existsSync(release)) Atomics.wait(pause, 0, 0, 20); }',
    '  } }); process.stdout.write("reserved");',
    '} catch (error) { process.stderr.write(String(error)); process.exitCode = 1; }',
  ].join("\n");
  return spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code, shared, root, id, marker, release ?? "-"], {
    cwd: REPO, stdio: ["ignore", "pipe", "pipe"],
  });
}

function finished(process: ChildProcess): Promise<{ code: number | null; stderr: string }> {
  let stderr = "";
  process.stderr?.on("data", (part: Buffer) => { stderr += String(part); });
  return new Promise((resolve, reject) => {
    process.once("error", reject);
    process.once("close", (code) => resolve({ code, stderr }));
  });
}

test("two cash processes serialize the whole reservation against one pre-migrated fleet file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-fleet-cash-"));
  const shared = join(dir, "shared", "allowance.json");
  const entered1 = join(dir, "entered1");
  const entered2 = join(dir, "entered2");
  const release = join(dir, "release");
  mkdirSync(join(dir, "shared"));
  writeFileSync(shared, JSON.stringify({ utcDay: "2026-09-27", fleetCapUsd: 25, reservations: {} }));
  let first: ChildProcess | undefined;
  let second: ChildProcess | undefined;
  try {
    first = child(shared, join(dir, "core"), "core-1", entered1, release);
    const firstDone = finished(first);
    await until(() => existsSync(entered1), "first reservation entering commit");
    second = child(shared, join(dir, "site"), "site-1", entered2);
    const secondDone = finished(second);
    await until(() => existsSync(entered2 + ".started"), "second process starting its reservation");
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(existsSync(entered2), false, "second process may not enter while first holds the lock");
    writeFileSync(release, "go");
    assert.deepEqual([await firstDone, await secondDone].map((r) => r.code), [0, 0]);
    assert.equal(existsSync(entered2), true);
    const state = JSON.parse(readFileSync(shared, "utf8")) as OpenWeightAllowanceState;
    assert.deepEqual(Object.keys(state.reservations).sort(), ["core-1", "site-1"]);
  } finally {
    first?.kill(); second?.kill(); rmSync(dir, { recursive: true, force: true });
  }
});

test("shared cash allowance rewrites retain owner-only mode", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-fleet-cash-mode-"));
  const shared = join(dir, "allowance.json");
  try {
    writeFileSync(shared, JSON.stringify({ utcDay: "2026-09-27", fleetCapUsd: 25, reservations: {} }), { mode: 0o600 });
    reserveOpenWeightBudget(config(join(dir, "core"), shared), {
      requestId: "mode-test", deployment: "gpt-oss-120b", requestBodyBytes: 10, atIso: ISO,
    });
    assert.equal(statSync(shared).mode & 0o777, 0o600);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("shared mode refuses missing and corrupt files, then applies one cap across distinct instance roots", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-fleet-cash-"));
  const shared = join(dir, "allowance.json");
  try {
    const core = config(join(dir, "core"), shared);
    const site = config(join(dir, "site"), shared);
    assert.throws(() => reserveOpenWeightBudget(core, { requestId: "a", deployment: "gpt-oss-120b", requestBodyBytes: 10, atIso: ISO }), /shared cash allowance is missing/);
    writeFileSync(shared, "{broken");
    assert.throws(() => reserveOpenWeightBudget(core, { requestId: "a", deployment: "gpt-oss-120b", requestBodyBytes: 10, atIso: ISO }), /unreadable/);
    writeFileSync(shared, JSON.stringify({ utcDay: "2026-09-27", reservations: {} }));
    assert.throws(() => reserveOpenWeightBudget(core, { requestId: "a", deployment: "gpt-oss-120b", requestBodyBytes: 10, atIso: ISO }), /no valid fleet cap/);
    writeFileSync(shared, JSON.stringify({ utcDay: "2026-09-27", fleetCapUsd: 25, reservations: { bad: { reservedUsd: "unknown", settledUsd: null } } }));
    assert.throws(() => reserveOpenWeightBudget(core, { requestId: "a", deployment: "gpt-oss-120b", requestBodyBytes: 10, atIso: ISO }), /unreadable reservation/);
    writeFileSync(shared, JSON.stringify({ utcDay: "2026-09-27", fleetCapUsd: 25, reservations: {} }));
    const want = openWeightReservationUsd("gpt-oss-120b", 10);
    core.dailyCapUsd = want * 1.5;
    site.dailyCapUsd = want * 1.5;
    reserveOpenWeightBudget(core, { requestId: "a", deployment: "gpt-oss-120b", requestBodyBytes: 10, atIso: ISO });
    assert.throws(() => reserveOpenWeightBudget(core, { requestId: "a", deployment: "gpt-oss-120b", requestBodyBytes: 10, atIso: ISO }), /already reserved/);
    assert.throws(() => reserveOpenWeightBudget(site, { requestId: "b", deployment: "gpt-oss-120b", requestBodyBytes: 10, atIso: ISO }), /daily allowance exhausted/);
    const state = JSON.parse(readFileSync(shared, "utf8")) as OpenWeightAllowanceState;
    assert.equal(Object.keys(state.reservations).length, 1);
    assert.equal(openWeightCommittedUsd(state), want);
    writeFileSync(shared, JSON.stringify({ ...state, utcDay: "2026-09-28" }));
    assert.throws(() => reserveOpenWeightBudget(core, { requestId: "old-day", deployment: "gpt-oss-120b", requestBodyBytes: 10, atIso: ISO }), /refusing an older/);
    assert.equal(JSON.parse(readFileSync(shared, "utf8")).utcDay, "2026-09-28");
    writeFileSync(shared, JSON.stringify(state));
    const wider = config(join(dir, "console"), shared, 50);
    assert.throws(() => reserveOpenWeightBudget(wider, { requestId: "huge", deployment: "gpt-6-luna", requestBodyBytes: 125_100_000, atIso: ISO }), /\$25\.00 dailyCapUsd/);
    assert.throws(() => reserveOpenWeightBudget(config(join(dir, "site"), shared), { requestId: "deleted", deployment: "gpt-oss-120b", requestBodyBytes: 10, atIso: ISO,
      beforeCommit: () => rmSync(shared) }), /shared cash allowance is missing/);
    assert.equal(existsSync(shared), false, "a vanished shared file never gets recreated from zero");
    assert.throws(() => validateConfig(config(dir, "relative.json")), /absolute JSON file path/);
    assert.throws(() => reserveOpenWeightBudget(config(dir, "relative.json"), { requestId: "bad-path", deployment: "gpt-oss-120b", requestBodyBytes: 10, atIso: ISO }), /absolute JSON file path/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("fleet migration preserves three source sets, refuses conflicting identities, and publishes only on apply", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-fleet-migrate-"));
  const script = join(REPO, "deploy/migrate-fleet-cash-allowance.sh");
  const dest = join(dir, "shared.json");
  const source = ["core", "site", "console"].map((name) => join(dir, name + ".json"));
  const state = (day: string, rows: Record<string, unknown>) => JSON.stringify({ utcDay: day, reservations: rows });
  const row = (usd: number) => ({ reservedUsd: usd, settledUsd: null, deployment: "gpt-oss-120b" });
  const run = (mode: string) => spawnSync("bash", [script, mode, dest, "2026-09-27", "25", ...source], { encoding: "utf8" });
  try {
    writeFileSync(source[0]!, state("2026-09-27", { a: row(5) }));
    writeFileSync(source[1]!, state("2026-09-26", { old: row(20) }));
    writeFileSync(source[2]!, state("2026-09-27", { b: row(4) }));
    const dry = run("--dry-run");
    assert.equal(dry.status, 0, dry.stderr);
    assert.equal(existsSync(dest), false);
    assert.equal(JSON.parse(dry.stdout).committedUsd, 9);
    writeFileSync(source[2]!, state("2026-09-27", { a: row(7) }));
    const conflict = run("--apply");
    assert.notEqual(conflict.status, 0);
    assert.match(conflict.stderr, /conflicting request identity/);
    assert.equal(existsSync(dest), false);
    writeFileSync(source[2]!, state("2026-09-27", { b: row(4) }));
    const applied = run("--apply");
    assert.equal(applied.status, 0, applied.stderr);
    const migrated = JSON.parse(readFileSync(dest, "utf8")) as OpenWeightAllowanceState;
    assert.deepEqual(Object.keys(migrated.reservations).sort(), ["a", "b"]);
    assert.notEqual(run("--apply").status, 0, "destination cannot be overwritten");
    const report = spawnSync("bash", [script, "--report", dest, "2026-09-27", "25"], { encoding: "utf8" });
    assert.equal(report.status, 0, report.stderr);
    assert.equal(JSON.parse(report.stdout).committedUsd, 9);
    assert.equal(JSON.parse(report.stdout).sources[0].ino, Number(statSync(dest).ino));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
