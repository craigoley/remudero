import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Append-only NDJSON ledger (MASTER-PLAN §9). Records the run's step timeline,
 * keyed by task id, so a run's provenance is inspectable after the fact. Every
 * line is one JSON object; `ts` is stamped here at write time.
 *
 * W1-T6: every WORKER call (recon, implement, implement.resumed) and every
 * BRAIN-PLANE call (the advisory reviewer, the retro Architect) logs the same
 * telemetry shape via {@link import("./worker.js").workerLedgerFields} —
 * `{model, effort, tokens, total_cost_usd, billing_mode, verdict}` — spread
 * onto that call's ledger line, so the full metering surface is queryable
 * uniformly regardless of which stage or tier produced the line.
 */
export interface LedgerLine {
  run_id: string;
  task_id: string;
  step: string;
  [k: string]: unknown;
}

/**
 * W1-T206 ATOMICITY, DESIGNED AGAINST THE CORRECTED EVIDENCE (plan/tasks.yaml's design
 * note for this task) — NOT a lock. `openSync(path, "a")` sets `O_APPEND`, which makes
 * the kernel atomically combine "seek to current EOF" with the write itself: concurrent
 * appenders across separate `rmd` processes can never overwrite or splice INTO each
 * other's already-placed bytes, full stop, with or without a lock. The recon that first
 * flagged this task suggested a `PIPE_BUF`-style size ceiling; that does not apply here —
 * `PIPE_BUF` bounds atomic writes to a PIPE, not a regular file — and a lock whose only
 * justification was that race is explicitly rejected by this task's design.
 *
 * The real, narrower exposure `O_APPEND` does NOT cover: if a SINGLE writer's own record
 * were split across more than one `write(2)` syscall, the gap BETWEEN those two syscalls
 * is a window where a different concurrent appender's line could land in the middle. This
 * function closes that window the way the design calls for — "a single write() of a
 * record under the filesystem block size" — by issuing the record as exactly ONE
 * `writeSync` call and checking the kernel accepted it in full, rather than by excluding
 * other writers. On a local disk this always succeeds in one call for any realistic
 * ledger line; on the fs the doc anticipated as the extreme, an incomplete write is LOUD
 * (`console.error`), never silently retried into a second syscall that would reopen the
 * exact interleave window a retry loop invites. The complementary read-side half of this
 * lives in status.ts's `readLedgerLines`/`readLedgerTail`: a torn trailing line — from
 * this or a crash mid-write, which no write-side mechanism can fully rule out — is
 * counted and surfaced, never silently absorbed into a fabricated empty record.
 */
export function appendLedger(path: string, line: LedgerLine): void {
  mkdirSync(dirname(path), { recursive: true });
  const record = { ts: new Date().toISOString(), ...line };
  const buf = Buffer.from(JSON.stringify(record) + "\n", "utf8");
  const fd = openSync(path, "a");
  try {
    const written = writeSync(fd, buf, 0, buf.length);
    if (written !== buf.length) {
      console.error(
        `ledger: short write for ${path} (${written}/${buf.length} bytes written) — ` +
          `the record may be torn; see readLedgerLines' torn-line handling`,
      );
    }
  } finally {
    closeSync(fd);
  }
}
