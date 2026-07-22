import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { appendLedger } from "../src/lib/ledger.js";
import { readLedgerLines } from "../src/lib/status.js";

// ── W1-T206: the ledger is the provenance spine AND the dispatch breaker's backing store —
// these three tests are the proof the review round named for that task's remaining unmet
// criteria: a torn line must be COUNTED and SURFACED (not silently {}); N concurrent
// appenders must produce N well-formed lines with none lost or torn; a record too large for
// a single write(2) must still land as one readable line (or fail observably).

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const APPEND_WORKER = join(__dirname, "fixtures", "ledger-atomic", "append-worker.ts");

function tmpLedgerDir(): string {
  return mkdtempSync(join(tmpdir(), "rmd-ledger-atomic-"));
}

/** Spawn one real OS process running append-worker.ts against `ledgerPath`. Resolves on a
 *  clean (code 0) exit, rejects otherwise — never resolves early the way `spawnSync` run in
 *  a loop would (that serializes every "concurrent" appender, proving nothing). */
function spawnAppender(ledgerPath: string, workerIndex: number, payloadSize?: number): Promise<void> {
  const args = ["--import", "tsx", APPEND_WORKER, ledgerPath, String(workerIndex)];
  if (payloadSize) args.push(String(payloadSize));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: REPO_ROOT, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`append-worker ${workerIndex} exited ${code}: ${stderr}`));
    });
  });
}

test("readLedgerLines: a torn/unparseable line is COUNTED and SURFACED, not silently dropped into the void", () => {
  const dir = tmpLedgerDir();
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    writeFileSync(
      ledgerPath,
      [
        JSON.stringify({ step: "run.start", task_id: "W1-T1" }),
        "{ this is not valid json at all",
        JSON.stringify({ step: "pr.opened", task_id: "W1-T1", pr_url: "https://github.com/o/r/pull/1" }),
      ].join("\n") + "\n",
    );

    const originalError = console.error;
    const logged: string[] = [];
    console.error = (msg: string) => logged.push(String(msg));
    let lines;
    try {
      lines = readLedgerLines(ledgerPath);
    } finally {
      console.error = originalError;
    }

    // COUNTED: a consumer with no stderr to watch can still tell a line was lost.
    assert.equal(lines.torn, 1, "the torn line is counted, not silently absorbed into an empty {}");
    // SURFACED: the valid lines are still there, untouched, and NO phantom {} stands in
    // for the lost one (the array has exactly 2 entries, not 3).
    assert.deepEqual(
      lines,
      [
        { step: "run.start", task_id: "W1-T1" },
        { step: "pr.opened", task_id: "W1-T1", pr_url: "https://github.com/o/r/pull/1" },
      ],
      "the torn line is dropped outright, never fabricated as a synthetic {} record",
    );
    // ALSO surfaced to a human watching stderr (belt and suspenders, not a replacement
    // for the programmatic `.torn` count above).
    assert.equal(logged.length, 1, "the torn line is also console.error-logged");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("appendLedger: N concurrent appenders (real OS processes) produce N well-formed lines, none lost, all valid JSON", async () => {
  const dir = tmpLedgerDir();
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    const N = 12;

    await Promise.all(Array.from({ length: N }, (_, i) => spawnAppender(ledgerPath, i)));

    const raw = readFileSync(ledgerPath, "utf8");
    const rawLines = raw.split("\n").filter((l) => l.trim().length > 0);

    // LINE COUNT: every appender's write landed -- none silently lost to a torn/overwritten
    // interleave, none merged into a neighbor's line.
    assert.equal(rawLines.length, N, `expected exactly ${N} lines, got ${rawLines.length}:\n${raw}`);

    // JSON-VALIDITY of EVERY line: no interleaved/torn line half-written by one appender and
    // half by another -- every single line parses clean.
    const parsed = rawLines.map((l, i) => {
      try {
        return JSON.parse(l) as Record<string, unknown>;
      } catch (e) {
        throw new Error(`line ${i} is not valid JSON: ${l}\n(${(e as Error).message})`);
      }
    });

    // Every worker index 0..N-1 appears EXACTLY once -- none lost, none duplicated by a
    // torn write that happened to reproduce another worker's bytes.
    const seenIndices = parsed.map((l) => l.worker_index).sort((a, b) => (a as number) - (b as number));
    assert.deepEqual(seenIndices, Array.from({ length: N }, (_, i) => i));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("appendLedger: a record too large for one write(2) syscall is still readable as exactly one line", async () => {
  const dir = tmpLedgerDir();
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    // Comfortably past PIPE_BUF (4096B on Linux, irrelevant to a regular file -- see
    // ledger.ts's doc) and large enough that if appendLedger's single writeSync call ever
    // got split into more than one write(2) syscall, a concurrent appender racing it would
    // have a real chance of landing bytes in the middle of this line.
    const bigPayloadSize = 2_000_000; // 2MB filler
    const smallCount = 8;

    await Promise.all([
      spawnAppender(ledgerPath, 999, bigPayloadSize),
      ...Array.from({ length: smallCount }, (_, i) => spawnAppender(ledgerPath, i)),
    ]);

    const raw = readFileSync(ledgerPath, "utf8");
    const rawLines = raw.split("\n").filter((l) => l.trim().length > 0);
    assert.equal(rawLines.length, smallCount + 1, `expected ${smallCount + 1} lines, got ${rawLines.length}`);

    const parsed = rawLines.map((l) => JSON.parse(l) as Record<string, unknown>); // throws (fails the test) on any torn line
    const big = parsed.find((l) => l.worker_index === 999);
    assert.ok(big, "the large record's line is present, intact, and was found among the others");
    assert.equal((big!.filler as string).length, bigPayloadSize, "the large record parsed as ONE line with its full payload, never truncated");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
