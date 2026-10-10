import assert from "node:assert/strict";
import crypto, { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { readRoutingQuarantineResolutions, resolveRoutingQuarantineRow } from "../src/lib/routing-quarantine-resolution.js";

const { dailyRoutingReview } = await import(pathToFileURL(join(import.meta.dirname, "../scripts/private-routing-daily-review.mjs")).href);
const asOf = "2026-10-08T12:00:00.000Z";
const cli = { ts: "2027-10-14T10:00:00.000Z", step: "cli.invoked", argv: ["status"] };
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const entry = (row: Record<string, unknown> = cli, sourceLabel = "core") => ({ sourceLabel, rowHash: hash(JSON.stringify(row)),
  kind: "future-timestamp", scope: "routing-trials", disposition: "irrelevant-cli-invocation",
  reason: "historical-test-clock", resolvedAt: "2026-10-08T11:00:00.000Z" });
const manifest = (entries: unknown[]) => ({ version: "routing-quarantine-resolutions-v1", entries });
function fixture(rows: unknown[] = [cli], extra = "") {
  const dir = mkdtempSync(join(tmpdir(), "rmd-quarantine-resolution-"));
  const stateDir = join(dir, "state"); mkdirSync(stateDir);
  const raw = rows.map(row => JSON.stringify(row)).join("\n") + "\n" + extra;
  const ledger = join(stateDir, "ledger.ndjson"); writeFileSync(ledger, raw);
  return { dir, sources: [{ label: "core", stateDir }], outDir: join(dir, "out"), ledger, raw,
    close: () => rmSync(dir, { recursive: true, force: true }) };
}

test("quarantine eligibility rejects unrelated rows before real hashing and still hashes an exact future CLI row", () => {
  const resolution = entry();
  const resolutions = readRoutingQuarantineResolutions(manifest([resolution]), asOf, ["core"]);
  const original = crypto.createHash;
  let hashes = 0;
  crypto.createHash = (...args: Parameters<typeof original>) => { hashes++; return original(...args); };
  syncBuiltinESMExports();
  try {
    const excluded: Record<string, unknown>[] = [
      { ...cli, step: "worker.attempt" }, { ...cli, ts: asOf }, { ...cli, ts: "invalid" },
      { ...cli, ts: 0 },
      ...["selection_assignment_id", "worker_assignment", "tokens", "total_cost_usd", "cost_usd",
        "notional_cost_usd", "billing_mode", "success", "served_model"].map(key => ({ ...cli, [key]: null })),
    ];
    for (const row of excluded) assert.equal(resolveRoutingQuarantineRow(resolutions, "core", row, JSON.stringify(row), asOf), undefined);
    assert.equal(hashes, 0, "ineligible rows must not allocate a real hash");
    assert.deepEqual(resolveRoutingQuarantineRow(resolutions, "core", cli, JSON.stringify(cli), asOf), resolution);
    assert.equal(hashes, 1, "eligible resolution still requires the native exact-byte hash");
    assert.equal(resolveRoutingQuarantineRow(resolutions, "site", cli, JSON.stringify(cli), asOf), undefined);
    assert.equal(hashes, 2, "a different source cannot borrow an identical row's resolution");
    assert.equal(resolveRoutingQuarantineRow(resolutions, "core", cli, JSON.stringify({ ...cli, argv: ["changed"] }), asOf), undefined);
    assert.equal(hashes, 3, "changed raw bytes cannot qualify by decoded metadata alone");
  } finally { crypto.createHash = original; syncBuiltinESMExports(); }
});

test("an exact CLI quarantine resolution qualifies only trial inputs and retains the raw warning", async () => {
  const f = fixture();
  try {
    const { snapshot } = await dailyRoutingReview({ ...f, asOf, quarantineResolutions: manifest([entry()]) });
    const source = snapshot.sources[0];
    assert.equal(snapshot.state, "observed-partial"); assert.equal(snapshot.comparativeClaims, "none");
    assert.deepEqual(source.reasons, ["ledger-source-future-dated"]);
    assert.equal(source.futureRows, 1); assert.equal(source.routingResolvedFutureRows, 1);
    assert.equal(source.selfImprovement.sourceComplete, false);
    for (const report of source.reports) {
      assert.equal(report.sourceQuality.state, "observed"); assert.equal(report.sourceQuality.scope, "routing-trials");
      assert.equal(report.sourceQuality.rawSourceState, "observed-partial");
      assert.equal(report.reviewState, "provisional"); assert.equal(report.nextAction, "collect-more-tasks");
      assert.equal(report.sufficient, false);
    }
    assert.equal(readFileSync(f.ledger, "utf8"), f.raw);
    const quarantine = JSON.parse(readFileSync(join(f.outDir, "2026-10-08.quarantine.json"), "utf8"));
    assert.equal(quarantine.rawReceiptsRetained, true);
    assert.equal(quarantine.sources[0].findings[0].rowHash, entry().rowHash);
    assert.equal(quarantine.sources[0].findings[0].resolutionScope, "routing-trials");
  } finally { f.close(); }
});

test("a quarantine hash from another source or changed raw row never qualifies a trial", async () => {
  const f = fixture();
  try {
    const site = { label: "site", stateDir: f.sources[0]!.stateDir };
    const wrongSource = await dailyRoutingReview({ ...f, sources: [...f.sources, site], asOf,
      quarantineResolutions: manifest([entry(cli, "site")]) });
    assert.equal(wrongSource.snapshot.sources[0].reports[0].reviewState, "source-incomplete");
    writeFileSync(f.ledger, JSON.stringify({ ...cli, argv: ["different"] }) + "\n");
    const changed = await dailyRoutingReview({ ...f, asOf, quarantineResolutions: manifest([entry()]) });
    assert.equal(changed.snapshot.sources[0].routingResolvedFutureRows, 0);
    assert.equal(changed.snapshot.sources[0].reports[0].nextAction, "repair-source-evidence");
  } finally { f.close(); }
});

test("a trial assignment or a CLI row carrying outcome and billing evidence remains quarantined", async () => {
  const f = fixture([cli, { ...cli, success: true }]);
  try {
    const { snapshot } = await dailyRoutingReview({ ...f, asOf,
      quarantineResolutions: manifest([entry(), entry({ ...cli, success: true })]) });
    assert.equal(snapshot.sources[0].routingResolvedFutureRows, 1);
    assert.equal(snapshot.sources[0].futureRows, 2);
    assert.equal(snapshot.sources[0].reports[0].reviewState, "source-incomplete");
  } finally { f.close(); }
  const { readRoutingQuarantineResolutions, resolveRoutingQuarantineRow } = await import("../src/lib/routing-quarantine-resolution.js");
  for (const row of [{ ...cli, step: "worker.assignment" }, ...["selection_assignment_id", "worker_assignment", "tokens",
    "total_cost_usd", "cost_usd", "notional_cost_usd", "billing_mode", "success", "served_model"].map(key => ({ ...cli, [key]: null }))]) {
    const raw = JSON.stringify(row);
    const rules = readRoutingQuarantineResolutions(manifest([entry(row)]), asOf, ["core"]);
    assert.equal(resolveRoutingQuarantineRow(rules, "core", row, raw, asOf), undefined);
  }
});

test("resolving an irrelevant future row never clears malformed or invalid timestamp evidence", async () => {
  const f = fixture([cli, { ts: "bad-date", step: "worker.assignment" }], "bad-json\n");
  try {
    const { snapshot } = await dailyRoutingReview({ ...f, asOf, quarantineResolutions: manifest([entry()]) });
    const source = snapshot.sources[0];
    assert.equal(source.routingResolvedFutureRows, 1);
    assert.deepEqual(source.reports[0].sourceQuality.reasons, ["ledger-source-malformed", "ledger-source-invalid-timestamp"]);
    assert.equal(source.reports[0].reviewState, "source-incomplete");
  } finally { f.close(); }
});

test("resolution manifests refuse unknown scopes, repetitions, oversized input and later decisions", async () => {
  const { readRoutingQuarantineResolutions, resolveRoutingQuarantineRow } = await import("../src/lib/routing-quarantine-resolution.js");
  for (const input of [null, {}, manifest(Array(201).fill(entry())), manifest([entry(), entry()]),
    manifest([{ ...entry(), sourceLabel: "unknown" }]), manifest([{ ...entry(), rowHash: "bad" }]),
    manifest([{ ...entry(), scope: "all-ledger" }]), manifest([{ ...entry(), reason: "assumed" }]),
    manifest([{ ...entry(), disposition: "delete" }]), manifest([{ ...entry(), kind: "malformed" }]),
    manifest([{ ...entry(), resolvedAt: "2026-10-09T12:00:00Z" }]), manifest([{ ...entry(), resolvedAt: "bad" }])]) {
    assert.throws(() => readRoutingQuarantineResolutions(input, asOf, ["core"]), /resolution/);
  }
  assert.equal(readRoutingQuarantineResolutions(undefined, asOf, ["core"]).size, 0);
  const row = { ...cli, ts: "2026-10-08T11:59:00Z" };
  assert.equal(resolveRoutingQuarantineRow(readRoutingQuarantineResolutions(manifest([entry(row)]), asOf, ["core"]),
    "core", row, JSON.stringify(row), asOf), undefined);
  const invalid = { ...cli, ts: "bad" };
  assert.equal(resolveRoutingQuarantineRow(readRoutingQuarantineResolutions(manifest([entry(invalid)]), asOf, ["core"]),
    "core", invalid, JSON.stringify(invalid), asOf), undefined);
});

test("the real daily CLI reads its default private resolution file and preserves unreadable refusal", () => {
  const f = fixture();
  try {
    mkdirSync(f.outDir); const file = join(f.outDir, "quarantine-resolutions.json");
    writeFileSync(file, JSON.stringify(manifest([entry()])), { mode: 0o600 });
    const script = join(import.meta.dirname, "../scripts/private-routing-daily-review.mjs");
    const command = ["--import", "tsx", script, "--source", `core=${f.sources[0]!.stateDir}`, "--out-dir", f.outDir];
    const positive = spawnSync(process.execPath, command, { cwd: join(import.meta.dirname, ".."), encoding: "utf8" });
    assert.equal(positive.status, 0, positive.stderr);
    const saved = JSON.parse(readFileSync(join(f.outDir, "latest.json"), "utf8"));
    assert.equal(saved.sources[0].reports[0].sourceQuality.state, "observed");
    chmodSync(file, 0o644);
    assert.notEqual(spawnSync(process.execPath, command, { encoding: "utf8" }).status, 0);
    assert.notEqual(spawnSync(process.execPath, [...command, "--quarantine-resolutions", join(f.dir, "absent.json")], { encoding: "utf8" }).status, 0);
    rmSync(file); symlinkSync(f.ledger, file);
    assert.notEqual(spawnSync(process.execPath, command, { encoding: "utf8" }).status, 0);
  } finally { f.close(); }
});

test("the private resolution reader uses the checked descriptor when its pathname becomes a symlink", () => {
  const f = fixture();
  try {
    mkdirSync(f.outDir);
    const file = join(f.outDir, "quarantine-resolutions.json");
    const replaced = join(f.dir, "replacement.json");
    writeFileSync(file, JSON.stringify(manifest([entry()])), { mode: 0o600 });
    writeFileSync(replaced, JSON.stringify(manifest([])), { mode: 0o600 });
    const preload = join(f.dir, "swap-after-stat.mjs");
    writeFileSync(preload, `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
const target=${JSON.stringify(file)}, replacement=${JSON.stringify(replaced)};
const original=fs.lstatSync(target), realLstat=fs.lstatSync, realFstat=fs.fstatSync;
let swapped=false;
const swap=(s)=>{if(!swapped&&s.ino===original.ino&&s.dev===original.dev){swapped=true;fs.unlinkSync(target);fs.symlinkSync(replacement,target);}return s;};
fs.lstatSync=(path,...args)=>swap(realLstat(path,...args));
fs.fstatSync=(fd,...args)=>swap(realFstat(fd,...args));
syncBuiltinESMExports();process.on('exit',()=>{if(!swapped)process.exitCode=99;});`);
    const script = join(import.meta.dirname, "../scripts/private-routing-daily-review.mjs");
    const child = spawnSync(process.execPath, ["--import", "tsx", "--import", preload, script,
      "--source", `core=${f.sources[0]!.stateDir}`, "--out-dir", f.outDir],
    { cwd: join(import.meta.dirname, ".."), encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr);
    const saved = JSON.parse(readFileSync(join(f.outDir, "latest.json"), "utf8"));
    assert.equal(saved.sources[0].routingResolvedFutureRows, 1, "the opened original supplies the resolution");
    assert.equal(saved.sources[0].reports[0].sourceQuality.state, "observed");
  } finally { f.close(); }
});

test("a private resolution file growing after descriptor inspection still hits the real byte bound", () => {
  const f = fixture();
  try {
    mkdirSync(f.outDir);
    const file = join(f.outDir, "quarantine-resolutions.json");
    writeFileSync(file, JSON.stringify(manifest([])), { mode: 0o600 });
    const preload = join(f.dir, "grow-after-stat.mjs");
    writeFileSync(preload, `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
const target=${JSON.stringify(file)}, original=fs.lstatSync(target), real=fs.fstatSync;
let grown=false;fs.fstatSync=(fd,...args)=>{const s=real(fd,...args);if(!grown&&s.ino===original.ino&&s.dev===original.dev){grown=true;fs.appendFileSync(target,' '.repeat(65537));}return s;};
syncBuiltinESMExports();process.on('exit',()=>{if(!grown)process.exitCode=99;});`);
    const script = join(import.meta.dirname, "../scripts/private-routing-daily-review.mjs");
    const child = spawnSync(process.execPath, ["--import", "tsx", "--import", preload, script,
      "--source", `core=${f.sources[0]!.stateDir}`, "--out-dir", f.outDir],
    { cwd: join(import.meta.dirname, ".."), encoding: "utf8" });
    assert.notEqual(child.status, 0);
    assert.match(child.stderr, /exceed the private input byte bound/);
  } finally { f.close(); }
});

test("the private resolution reader refuses directories, oversized files and nonblocking FIFOs", () => {
  const f = fixture();
  try {
    mkdirSync(f.outDir);
    const file = join(f.outDir, "quarantine-resolutions.json");
    const script = join(import.meta.dirname, "../scripts/private-routing-daily-review.mjs");
    const command = ["--import", "tsx", script, "--source", `core=${f.sources[0]!.stateDir}`, "--out-dir", f.outDir];
    const run = () => spawnSync(process.execPath, command,
      { cwd: join(import.meta.dirname, ".."), encoding: "utf8", timeout: 10_000 });
    mkdirSync(file);
    assert.notEqual(run().status, 0);
    rmSync(file, { recursive: true });
    writeFileSync(file, " ".repeat(65_537), { mode: 0o600 });
    assert.notEqual(run().status, 0);
    rmSync(file);
    const created = spawnSync("mkfifo", [file], { encoding: "utf8" });
    assert.equal(created.status, 0, created.stderr);
    const fifo = run();
    assert.equal(fifo.error, undefined, "opening a FIFO must refuse without waiting for a writer");
    assert.notEqual(fifo.status, 0);
  } finally { f.close(); }
});
