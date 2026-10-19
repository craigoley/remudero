import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { defaultRunGate, preopenGateLedgerFields, runPreopenGate } from "#src/lib/preopen-gate.js";

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
