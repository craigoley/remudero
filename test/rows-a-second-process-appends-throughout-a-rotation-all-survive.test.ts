import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { rotateLedger } from "../src/lib/ledger.js";

// W1-T5514 — the concurrency half. A real second OS process appends numbered rows in a tight
// loop through the real `appendLedger` (open by NAME with O_APPEND, one writeSync, close), while
// this process rotates an oversized ledger again and again. The child appends until told to stop,
// so EVERY rotation overlaps it, then reports how many rows (K) it wrote. serve and the daemon
// share the state volume exactly like this. The union of the live file and every
// archive (both forms) must hold every sequence number at least once. Before the fix, a rotation
// overlapping the child lost every row appended between its catch-up read and its rename (they
// land on the inode the rename replaces): measured at base, 51,448 of 171,712 rows in 6 rotations.
//
// The child runs with coverage and test-runner env stripped (`env -u ...`): a child inheriting
// NODE_V8_COVERAGE once broke a coverage run.

const CEILING = 1024 * 1024;
const ROTATIONS = 6;
const BUDGET_NS = 60_000_000_000n;

const REPO = new URL("..", import.meta.url);
const LEDGER_MODULE = new URL("src/lib/ledger.ts", REPO).href;

// The child loads the REAL `appendLedger` through tsx, so the appender half of the protocol
// (re-append a row that landed behind a rotation's seal) is what is under test, not a mimic.
const CHILD = `
import { existsSync, writeFileSync } from "node:fs";
const [ledgerModule, path, startedPath, stopPath, donePath] = process.argv.slice(1);
const { appendLedger } = await import(ledgerModule);
writeFileSync(startedPath, "");
let seq = 0;
for (; seq % 64 !== 0 || !existsSync(stopPath); seq++) {
  appendLedger(path, { step: "ci.polling", run_id: "child", task_id: "W1-T5514", seq }, { ceilingBytes: Number.MAX_SAFE_INTEGER });
}
writeFileSync(donePath, String(seq));
`;

function noise(bytes: number, tag: number): string {
  const line = (n: number) => JSON.stringify({ step: "ci.polling", run_id: `noise-${tag}-${n}`, task_id: "W1-NOISE", detail: "x".repeat(200) });
  const lines: string[] = [];
  let size = 0;
  while (size <= bytes) {
    const l = line(lines.length) + "\n";
    lines.push(l);
    size += l.length;
  }
  return lines.join("");
}

function unionText(dir: string): string {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".ndjson") || f.endsWith(".ndjson.gz"))
    .map((f) => {
      const buf = readFileSync(join(dir, f));
      return (f.endsWith(".gz") ? gunzipSync(buf) : buf).toString("utf8");
    })
    .join("");
}

function waitForExit(child: ReturnType<typeof spawn>, ms: number): Promise<number | null> {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null) return resolve(child.exitCode);
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`child appender did not exit within ${ms}ms`));
    }, ms);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

test("rows a second process appends throughout a rotation all survive in the live ledger or an archive", { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-rotation-concurrent-append-"));
  const ledgerPath = join(dir, "ledger.ndjson");
  const startedPath = join(dir, "child.started");
  const stopPath = join(dir, "child.stop");
  const donePath = join(dir, "child.done");
  try {
    appendFileSync(ledgerPath, noise(CEILING * 2, 0));
    const child = spawn(
      "env",
      ["-u", "NODE_V8_COVERAGE", "-u", "NODE_OPTIONS", "-u", "NODE_TEST_CONTEXT", process.execPath, "--import", "tsx", "--input-type=module", "-e", CHILD, LEDGER_MODULE, ledgerPath, startedPath, stopPath, donePath],
      { stdio: ["ignore", "ignore", "pipe"], cwd: REPO },
    );
    let stderr = "";
    child.stderr!.on("data", (d) => (stderr += String(d)));
    const t0 = process.hrtime.bigint();
    const overBudget = () => process.hrtime.bigint() - t0 > BUDGET_NS;
    while (!existsSync(startedPath) && child.exitCode === null && !overBudget()) {
      // spin until the child is appending — it starts in tens of milliseconds
    }
    assert.ok(existsSync(startedPath), `the child appender started (stderr: ${stderr})`);

    let rotations = 0;
    let attempts = 0;
    while (rotations < ROTATIONS && attempts < ROTATIONS * 4 && child.exitCode === null && !overBudget()) {
      attempts++;
      if (statSync(ledgerPath).size <= CEILING) appendFileSync(ledgerPath, noise(CEILING, attempts));
      if (rotateLedger(ledgerPath, { ceilingBytes: CEILING, smoothingWindowMs: 0 }).rotated) rotations++;
    }
    const overlapped = child.exitCode === null && !existsSync(donePath);
    appendFileSync(stopPath, "");
    const code = await waitForExit(child, 60_000);
    assert.equal(code, 0, `the child appender exited cleanly (stderr: ${stderr})`);
    assert.ok(overlapped, "the child was still appending when the last rotation finished");
    assert.equal(rotations, ROTATIONS, `every rotation ran while the child appended (${rotations} of ${attempts} attempts rotated)`);
    const K = Number(readFileSync(donePath, "utf8"));
    assert.ok(K > 0, `the child reports the rows it wrote (got ${K})`);

    const seen = new Set<number>();
    const twice: number[] = [];
    for (const line of unionText(dir).split("\n")) {
      if (!line.includes(`"run_id":"child"`)) continue;
      const { seq } = JSON.parse(line) as { seq: number };
      if (seen.has(seq)) twice.push(seq);
      seen.add(seq);
    }
    const missing: number[] = [];
    for (let seq = 0; seq < K; seq++) if (!seen.has(seq)) missing.push(seq);
    assert.deepEqual(missing.slice(0, 20), [], `${missing.length} of ${K} child rows are in no ledger file after ${rotations} rotations`);
    assert.deepEqual(twice.slice(0, 20), [], `${twice.length} child rows were copied twice — the drain and a re-append overlapped`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
