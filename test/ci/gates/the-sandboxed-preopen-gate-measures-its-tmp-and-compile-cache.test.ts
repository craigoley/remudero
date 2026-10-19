import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { defaultRunGate, preopenGateLedgerFields, runPreopenGate } from "#src/lib/preopen-gate.js";
import { compileCacheSize, createGateSandboxMetrics, parseGateSandboxMeasurement, privateTmpBytes } from "#src/lib/gate-sandbox-metrics.js";
import { preflightCommand, preflightSummaryTarget } from "#src/run-task.js";
import { repoRoot } from "#test/helpers/repo-root.js";

const cost = {
  tmp_peak_bytes: 5 * 1024 * 1024,
  tmp_peak_scope: "boundary-sampled",
  compile_cache: { files_start: 2, files_end: 8, bytes_start: 100, bytes_end: 900, start_scope: "after-module-load" },
  max_rss_kb: 1234,
  cpu_ms: 12.5,
  resource_scope: "preflight-process",
};

async function childGate(exit: number, measurement?: unknown, writeSummary = true) {
  const dir = mkdtempSync(join(tmpdir(), "rmd-w9739-child-"));
  const launcher = join(dir, "rmd");
  const sandbox = join(dir, "sandbox");
  try {
    writeFileSync(launcher, `#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);\n` +
      (writeSummary ? `fs.writeFileSync(args[args.indexOf('--summary-file')+1],JSON.stringify({finishedAt:new Date().toISOString(),steps:[{name:'fixture-check',ok:${exit === 0}}],sandboxMetrics:${JSON.stringify(measurement)}}));\n` : "") +
      `process.exit(${exit});\n`);
    writeFileSync(sandbox, `#!${process.execPath}\nconst cp=require('node:child_process');const a=process.argv.slice(2);const at=a.indexOf('--');const r=cp.spawnSync(a[at+1],a.slice(at+2),{stdio:'inherit'});process.exit(r.status??128);\n`);
    chmodSync(launcher, 0o755);
    chmodSync(sandbox, 0o755);
    return await runPreopenGate(dir, {
      runGate: cwd => defaultRunGate(cwd, launcher, () => {}, {}, {
        contain: () => ({ mode: "sandboxed", file: sandbox, argv: ["--"] }),
      }),
      runPushGate: async () => ({ kind: "skipped", reason: "fixture has no remote" }),
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("W1-T9739: a sandboxed gate row names its tmp peak, compile cache and child cost", async () => {
  const result = await childGate(0, { sandbox: cost });
  assert.equal(result.kind, "pass");
  assert.deepEqual(preopenGateLedgerFields(result).sandbox, cost);
  assert.equal(preopenGateLedgerFields(result).sandbox_unmeasured, undefined);
  const failed = await childGate(1, { sandbox: cost });
  assert.equal(failed.kind, "fail");
  assert.deepEqual(failed.kind === "fail" && failed.failedSteps, ["fixture-check"]);
  assert.deepEqual(preopenGateLedgerFields(failed).sandbox, cost);
});

test("W1-T9739: an unmeasured sandbox is named, never zero", async () => {
  for (const [exit, measurement, summary] of [
    [0, undefined, false], [0, { sandbox_unmeasured: "cache enumeration incomplete" }, true],
    [1, undefined, true], [3, undefined, false],
    [0, { sandbox: { ...cost, tmp_peak_bytes: -1 } }, true],
  ] as const) {
    const result = await childGate(exit, measurement, summary);
    assert.equal(result.kind, exit === 0 ? "pass" : exit === 1 ? "fail" : "unmeasured");
    const fields = preopenGateLedgerFields(result);
    assert.equal(fields.sandbox, undefined);
    assert.equal(typeof fields.sandbox_unmeasured, "string");
    assert.ok(String(fields.sandbox_unmeasured).length > 0);
  }
});

test("W1-T9739: boundary sampling preserves returned values and thrown gate errors", () => {
  const samples = [10, 50, 20, 30], sizes = [{ files: 2, bytes: 100 }, { files: 8, bytes: 900 }];
  const sampler = createGateSandboxMetrics({ tmp: () => samples.shift()!, cache: () => sizes.shift()!, usage: () => ({ maxRSS: 2048, userCPUTime: 12_000, systemCPUTime: 500 }) });
  const sentinel = {};
  assert.equal(sampler.observe(() => sentinel), sentinel);
  assert.throws(() => sampler.observe(() => { throw Error("gate failed"); }), /gate failed/);
  assert.deepEqual(sampler.finish(), { sandbox: { ...cost, tmp_peak_bytes: 50, max_rss_kb: 2048 } });
});

test("W1-T9739: partial, unreadable and non-finite samplers stay explicitly unmeasured", () => {
  const good = { tmp: () => 1, cache: () => ({ files: 1, bytes: 2 }), usage: () => ({ maxRSS: 3, userCPUTime: 4, systemCPUTime: 5 }) };
  for (const source of [
    { tmp: () => { throw Error("tmp unreadable"); } }, { tmp: () => NaN },
    { cache: () => { throw Error("cache unreadable"); } }, { cache: () => ({ files: Infinity, bytes: 1 }) },
    { usage: () => { throw Error("usage unreadable"); } }, { usage: () => ({ maxRSS: -1, userCPUTime: 0, systemCPUTime: 0 }) },
  ]) {
    const result = createGateSandboxMetrics({ ...good, ...source }).finish();
    assert.ok("sandbox_unmeasured" in result, JSON.stringify(result));
    assert.ok(result.sandbox_unmeasured.length > 0);
  }
  const realUsage = createGateSandboxMetrics({ tmp: () => 0, cache: () => ({ files: 0, bytes: 0 }) }).finish();
  assert.ok("sandbox" in realUsage);
  assert.ok(realUsage.sandbox.max_rss_kb > 0);
  assert.ok(realUsage.sandbox.cpu_ms >= 0);
  const defaults = createGateSandboxMetrics().finish();
  assert.ok("sandbox" in defaults || defaults.sandbox_unmeasured.length > 0);
});

test("W1-T9739: tmp readings require the dedicated private tmpfs rather than host disk usage", () => {
  const mount = "40 20 0:44 / /tmp rw - tmpfs tmpfs rw\n";
  const stat = { type: 0x01021994n, blocks: 10n, bfree: 4n, bsize: 1024n };
  assert.equal(privateTmpBytes("/tmp", () => mount, () => stat as never), 6144);
  for (const bad of ["", mount.replace("rw -", "rw shared:9 -"), mount.replace("tmpfs tmpfs", "ext4 /dev/sda"), mount.replace(" / /tmp", " /other /tmp")]) {
    assert.throws(() => privateTmpBytes("/tmp", () => bad, () => stat as never), /private tmpfs/);
  }
  assert.throws(() => privateTmpBytes("/other"), /private sandbox/);
  assert.throws(() => privateTmpBytes("/tmp", () => "x".repeat(256 * 1024 + 1)), /budget/);
  assert.throws(() => privateTmpBytes("/tmp", () => mount, () => ({ ...stat, type: 1n }) as never), /not tmpfs/);
  for (const blocks of [-1n, 2n ** 80n]) assert.throws(() => privateTmpBytes("/tmp", () => mount, () => ({ ...stat, blocks }) as never), /invalid/);
  // Exercise the REAL statfs edge too; the host is not presumed to provide a private /tmp.
  try { assert.ok(privateTmpBytes("/tmp", () => mount) >= 0); }
  catch (error) { assert.match(String(error), /tmpfs|filesystem/); }
});

test("W1-T9739: the real cache walker is bounded and never follows a cache symlink", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-w9739-cache-"));
  try {
    assert.throws(() => compileCacheSize(dir, 10_000, () => 0, "darwin"), /requires Linux/);
    if (process.platform !== "linux") {
      assert.throws(() => compileCacheSize(dir), /requires Linux/);
      return; // Named unsupported measurement, not a fabricated count; Linux CI exercises the real walker.
    }
    assert.deepEqual(compileCacheSize(join(dir, "absent")), { files: 0, bytes: 0 });
    mkdirSync(join(dir, "nested"));
    writeFileSync(join(dir, "one"), "abc");
    writeFileSync(join(dir, "nested", "two"), "12345");
    assert.deepEqual(compileCacheSize(dir), { files: 2, bytes: 8 });
    assert.throws(() => compileCacheSize(dir, 0), /budget/);
    let clock = 0;
    assert.throws(() => compileCacheSize(dir, 100, () => clock++ * 101), /budget/);
    assert.throws(() => compileCacheSize(join(dir, "one")), /ENOTDIR/);
    symlinkSync(dir, join(dir, "link"));
    assert.throws(() => compileCacheSize(dir), /symlink/);
    assert.throws(() => compileCacheSize(join(dir, "link")), /ELOOP|ENOTDIR/);
    rmSync(join(dir, "link"));
    execFileSync("mkfifo", [join(dir, "pipe")]);
    assert.throws(() => compileCacheSize(dir), /non-file/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("W1-T9739: the transport parser refuses partial costs and copies only the measured schema", () => {
  assert.deepEqual(parseGateSandboxMeasurement({ sandbox: { ...cost, unexpected: "not transported" } }), { sandbox: cost });
  for (const data of [undefined, null, [], "", {}, { sandbox: {} }, { sandbox: { ...cost, cpu_ms: Infinity } }, { sandbox: { ...cost, resource_scope: "descendants" } }, { sandbox: cost, sandbox_unmeasured: "ambiguous" }, { sandbox_unmeasured: "" }]) {
    assert.ok("sandbox_unmeasured" in parseGateSandboxMeasurement(data));
  }
  assert.deepEqual(parseGateSandboxMeasurement({ sandbox_unmeasured: "partial" }), { sandbox_unmeasured: "partial" });
});

test("W1-T9739: the real preflight child writes its measurement without running real gates", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-w9739-producer-"));
  try {
    const summary = join(dir, "summary.json"), root = repoRoot();
    const code = `const {preflightCommand}=await import(${JSON.stringify(join(root, "src/run-task.ts"))});process.exitCode=await preflightCommand(['--no-fast','--sandbox-metrics','--summary-file',${JSON.stringify(summary)}],{spawn:()=>({status:0,stdout:'',stderr:''})});`;
    const child = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), "--input-type=module", "-e", code], { encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 });
    assert.equal(child.error, undefined);
    assert.equal(child.status, 0, child.stderr + child.stdout);
    const stored = JSON.parse(readFileSync(summary, "utf8"));
    assert.equal(stored.ok, true);
    assert.ok(Object.hasOwn(stored, "sandboxMetrics"), "the actual child must construct and finish its sampler");
    assert.deepEqual(parseGateSandboxMeasurement(stored.sandboxMetrics), stored.sandboxMetrics);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("W1-T9739: measurement does not turn an injected spawn into a default summary writer", async () => {
  const spawn = () => ({ status: 0, stdout: "", stderr: "" });
  assert.equal(preflightSummaryTarget(["--sandbox-metrics"], { spawn }, "/fixture"), undefined);
  assert.equal(preflightSummaryTarget(["--sandbox-metrics", "--summary-file", "/explicit"], { spawn }, "/fixture"), "/explicit");
  const log = console.log, lines: string[] = [];
  try {
    console.log = (...values: unknown[]) => { lines.push(values.join(" ")); };
    assert.equal(await preflightCommand(["--no-fast", "--sandbox-metrics"], { spawn }), 0);
  } finally { console.log = log; }
  assert.ok(lines.some(line => line.includes("summary NOT written: an injected spawn")));
});
