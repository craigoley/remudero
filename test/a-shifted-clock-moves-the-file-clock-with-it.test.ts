import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

// W1-T6035 — scripts/clock-shift.mjs moves the FILE clock with the process clock. Since W1-T5407 the
// ledger flags a row stamped more than 10 minutes past its file's fstat mtime, so a preload that moved
// Date.now() alone added a ledger.future_stamp row to every append under a shift of more than 10 min.
//
// EVERY ASSERTION RUNS IN A REAL CHILD PROCESS WITH THE REAL PRELOAD, as test/clock-shift-probe.test.ts
// does: a re-implemented copy would prove nothing about the file `--import` actually loads.

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const PRELOAD = join(REPO, "scripts", "clock-shift.mjs");
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** Run an ES-module `body` in a child with tsx and the preload at `days`; return its JSON stdout. */
function underShift(days: number, dir: string, body: string): Record<string, unknown> {
  const src = [
    `import * as fs from "node:fs";`,
    `import { statSync, lstatSync, fstatSync, openSync, closeSync, writeFileSync, utimesSync } from "node:fs";`,
    `import * as fsp from "node:fs/promises";`,
    `const DIR = ${JSON.stringify(dir)};`,
    `const out = {};`,
    body,
    `process.stdout.write(JSON.stringify(out));`,
  ].join("\n");
  const stdout = execFileSync(process.execPath, ["--import", "tsx", "--import", PRELOAD, "--input-type=module", "-e", src], {
    cwd: REPO,
    encoding: "utf8",
    env: { ...process.env, FK_SHIFT_DAYS: String(days) },
  });
  return JSON.parse(stdout) as Record<string, unknown>;
}

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "rmd-shifted-file-clock-"));
}

/** `value` sits `days` ahead of the real clock, read either side of the child run. */
function assertAhead(label: string, value: unknown, before: number, after: number, days: number): void {
  assert.equal(typeof value, "number", `${label}: expected a number, got ${String(value)}`);
  const v = value as number;
  const lo = before + days * DAY_MS - HOUR_MS;
  const hi = after + days * DAY_MS + HOUR_MS;
  assert.ok(v >= lo && v <= hi, `${label}: ${new Date(v).toISOString()} is not ${days}d ahead of the real clock`);
}

test("under a one-day shift a ledger append reads back exactly the one row written, with no future_stamp", () => {
  const dir = freshDir();
  const ledger = join(dir, "ledger.ndjson");
  const ledgerUrl = pathToFileURL(join(REPO, "src", "lib", "ledger.ts")).href;
  const before = Date.now();
  const out = underShift(
    1,
    dir,
    [
      `const { appendLedger } = await import(${JSON.stringify(ledgerUrl)});`,
      `writeFileSync(DIR + "/probe.txt", "x");`,
      `out.mtimeMs = statSync(DIR + "/probe.txt").mtimeMs;`,
      `out.now = Date.now();`,
      `appendLedger(${JSON.stringify(ledger)}, { step: "clock_shift.probe", task_id: "W1-T6035" });`,
    ].join("\n"),
  );
  const after = Date.now();
  const rows = readFileSync(ledger, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  assert.deepEqual(
    rows.map((r) => r.step),
    ["clock_shift.probe"],
    `one append must read back as one row, not a ledger.future_stamp beside it: ${JSON.stringify(rows)}`,
  );
  assertAhead("a file written now", out.mtimeMs, before, after, 1);
  assertAhead("the shifted Date.now()", out.now, before, after, 1);
});

test("every stat form a fixture can reach — named, namespace, callback, promises, FileHandle — reads the shifted mtime", () => {
  const dir = freshDir();
  const before = Date.now();
  const out = underShift(
    1,
    dir,
    [
      `const f = DIR + "/probe.txt";`,
      `writeFileSync(f, "x");`,
      `out.statSync = statSync(f).mtimeMs;`,
      `out.lstatSync = lstatSync(f).mtime.getTime();`,
      `const fd = openSync(f, "r"); out.fstatSync = fstatSync(fd).ctimeMs; closeSync(fd);`,
      `out.nsStatSync = fs.statSync(f).atimeMs;`,
      `out.birthtime = statSync(f).birthtime.getTime();`,
      `out.stat = await new Promise((res, rej) => fs.stat(f, (e, s) => (e ? rej(e) : res(s.mtimeMs))));`,
      `out.lstat = await new Promise((res, rej) => fs.lstat(f, {}, (e, s) => (e ? rej(e) : res(s.mtimeMs))));`,
      `const fd2 = openSync(f, "r");`,
      `out.fstat = await new Promise((res, rej) => fs.fstat(fd2, (e, s) => (e ? rej(e) : res(s.mtimeMs))));`,
      `closeSync(fd2);`,
      `out.promisesStat = (await fsp.stat(f)).mtimeMs;`,
      `out.promisesLstat = (await fsp.lstat(f)).mtimeMs;`,
      `out.fsPromisesStat = (await fs.promises.stat(f)).mtimeMs;`,
      `const h = await fsp.open(f, "r"); out.fileHandleStat = (await h.stat()).mtimeMs; await h.close();`,
    ].join("\n"),
  );
  const after = Date.now();
  for (const [label, value] of Object.entries(out)) assertAhead(label, value, before, after, 1);
});

test("a time WRITTEN with the shifted clock reads back as that same instant, not shifted twice", () => {
  const dir = freshDir();
  const out = underShift(
    1,
    dir,
    [
      `const f = DIR + "/probe.txt";`,
      `writeFileSync(f, "x");`,
      `const back = async (write) => { const t = new Date(); await write(t); return statSync(f).mtimeMs - t.getTime(); };`,
      `out.utimesSync = await back((t) => utimesSync(f, t, t));`,
      `out.utimesSeconds = await back((t) => fs.utimesSync(f, t.getTime() / 1000, t.getTime() / 1000));`,
      `out.utimes = await back((t) => new Promise((res, rej) => fs.utimes(f, t, t, (e) => (e ? rej(e) : res()))));`,
      `out.lutimesSync = await back((t) => fs.lutimesSync(f, t, t));`,
      `out.lutimes = await back((t) => new Promise((res, rej) => fs.lutimes(f, t, t, (e) => (e ? rej(e) : res()))));`,
      `out.promisesUtimes = await back((t) => fsp.utimes(f, t, t));`,
      `out.promisesLutimes = await back((t) => fsp.lutimes(f, t, t));`,
      `const fd = openSync(f, "r+");`,
      `out.futimesSync = await back((t) => fs.futimesSync(fd, t, t));`,
      `out.futimes = await back((t) => new Promise((res, rej) => fs.futimes(fd, t, t, (e) => (e ? rej(e) : res()))));`,
      `closeSync(fd);`,
      `const h = await fsp.open(f, "r+"); out.fileHandleUtimes = await back((t) => h.utimes(t, t)); await h.close();`,
    ].join("\n"),
  );
  for (const [label, drift] of Object.entries(out)) {
    assert.equal(typeof drift, "number", `${label}: no reading`);
    assert.ok(Math.abs(drift as number) < 5_000, `${label}: a written time read back ${String(drift)}ms away from itself`);
  }
});

test("bigint stats are left alone on the real clock, and a missing path still reads undefined", () => {
  const dir = freshDir();
  const before = Date.now();
  const out = underShift(
    1,
    dir,
    [
      `const f = DIR + "/probe.txt";`,
      `writeFileSync(f, "x");`,
      `out.bigint = Number(statSync(f, { bigint: true }).mtimeMs);`,
      `out.missing = statSync(DIR + "/absent", { throwIfNoEntry: false }) === undefined;`,
    ].join("\n"),
  );
  const after = Date.now();
  assertAhead("a bigint stat", out.bigint, before, after, 0);
  assert.equal(out.missing, true, "throwIfNoEntry: false must still return undefined through the wrapper");
});

test("at +0 a file written now reads the real clock — the file clock moves only under a shift", () => {
  const before = Date.now();
  const out = underShift(0, freshDir(), `writeFileSync(DIR + "/probe.txt", "x"); out.mtimeMs = statSync(DIR + "/probe.txt").mtimeMs;`);
  assertAhead("an unshifted file", out.mtimeMs, before, Date.now(), 0);
});
