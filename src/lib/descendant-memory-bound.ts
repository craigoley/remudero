/**
 * lib/descendant-memory-bound.ts — W1-T11344: a worker tree's descendant whose resident memory passes the bound is
 * stopped, and every sampled tree ledgers its largest member's peak.
 *
 * OBSERVED 2026-11-04, remudero-daemon (memory.max 26,128,416,768 bytes): one test-file child inside #16240's semantic
 * review reached 19.2 GiB in under five minutes, twice. The container's anon memory reached 24.8 GB, it swapped 4.29 GB
 * and every lane slowed until the operator stopped the process by hand. Nothing bounded one process's memory.
 *
 * The tree sampler (host-memory-learning.ts) still only measures: it hands each member it reads to `onMember`, and this
 * module owns the decision, the signal and both rows. A tracked root (a worker's own agent CLI) is never signalled; a
 * member over the bound is signalled once, and only after a fresh read of its start time still matches the sampled one,
 * so a recycled pid is never hit. A failed read, signal or write is caught, named in the row, and never stops sampling.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { parseProcStat } from "./host-memory-ledger.js";
import { appendLedger, type LedgerLine } from "./ledger.js";
import { LEDGER_FILENAME } from "./ledger-path.js";

/** BACKSTOP, OPERATOR RULING 2026-11-04 "Shadow, then enforce 8 GiB": about a third of memory.max, far above any healthy
 *  tree measured (2.8 GB). Changing it needs another ruling read from the worker.descendant_rss_peak population. */
export const DESCENDANT_RSS_BOUND_MIB = 8192;
export const DESCENDANT_MEMORY_KILLED_STEP = "worker.descendant_memory_killed";
export const DESCENDANT_RSS_PEAK_STEP = "worker.descendant_rss_peak";

/** What the sampler knows about one member it read. `testFile` is set for a test runner's file child. */
export interface MemberFacts {
  root: boolean;
  testFile?: string;
}

export interface DescendantBoundPorts {
  /** The member's start time read afresh, or undefined when it can no longer hold memory (a zombie). */
  readStart: (pid: number) => string | undefined;
  kill: (pid: number) => void;
  write: (row: LedgerLine) => void;
}

export interface DescendantMemoryBound {
  onMember(pid: number, start: string, rssKb: number, facts: MemberFacts): void;
  /** Ledgers the largest member seen, once. A tree never sampled records nothing. */
  release(): void;
}

/** The real ports: `/proc/<pid>/stat`, SIGKILL, and the state root's ledger in a daemon-owned process only. */
export function descendantBoundPorts(
  context: { root?: string; daemonOwned: () => boolean },
  sys: {
    readFile?: (path: string) => string;
    signal?: (pid: number, signal: NodeJS.Signals) => void;
    append?: (path: string, row: LedgerLine) => void;
    stderr?: (line: string) => void;
  } = {},
): DescendantBoundPorts {
  const readFile = sys.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  const signal = sys.signal ?? ((pid: number, name: NodeJS.Signals) => void process.kill(pid, name));
  const append = sys.append ?? ((path: string, row: LedgerLine) => appendLedger(path, row));
  const stderr = sys.stderr ?? ((line: string) => console.error(line));
  const ledgerPath = join(context.root ?? join(homedir(), "Remudero"), "state", LEDGER_FILENAME);
  return {
    readStart: (pid) => {
      const stat = parseProcStat(readFile(`/proc/${pid}/stat`));
      return stat && !stat.zombie ? stat.start : undefined;
    },
    kill: (pid) => signal(pid, "SIGKILL"),
    // Only daemon processes share the ledger; elsewhere a stop is still said, and a peak is not population evidence.
    write: (row) => {
      if (context.daemonOwned()) append(ledgerPath, row);
      else if (row.step === DESCENDANT_MEMORY_KILLED_STEP) stderr(JSON.stringify(row));
    },
  };
}

const reasonOf = (error: unknown): string =>
  (error as NodeJS.ErrnoException | undefined)?.code ?? String((error as Error)?.message ?? error).slice(0, 120);

/** The bound for one learned reservation's trees (its nested test runs included). NEVER throws. */
export function descendantMemoryBoundHook(
  input: { workerClass: string; reservationId?: string; boundMib?: number },
  ports: DescendantBoundPorts,
): DescendantMemoryBound {
  const boundMib = input.boundMib ?? DESCENDANT_RSS_BOUND_MIB;
  const base = { run_id: input.reservationId ?? "descendant-memory-bound", task_id: "MEMORY-BUDGET",
    worker_class: input.workerClass, reservation_id: input.reservationId ?? null, bound_mib: boundMib };
  const seen = new Set<string>();
  let largest: { rssMib: number; root: boolean; testFile?: string } | undefined;
  let stopped = 0;
  let released = false;
  const write = (row: LedgerLine): void => {
    try {
      ports.write(row);
    } catch (error) {
      void error; // The ledger is unwritable: the stop stands, and sampling goes on.
    }
  };
  return {
    onMember(pid, start, rssKb, facts) {
      const rssMib = rssKb / 1024;
      if (!Number.isFinite(rssMib)) return;
      if (largest === undefined || rssMib > largest.rssMib) largest = { rssMib, root: facts.root, testFile: facts.testFile };
      const key = `${pid}:${start}`;
      if (facts.root || rssMib <= boundMib || seen.has(key)) return;
      seen.add(key); // Signalled once, whatever the outcome.
      const row: LedgerLine = { ...base, step: DESCENDANT_MEMORY_KILLED_STEP, pid, rss_mib: Math.round(rssMib),
        ...(facts.testFile ? { test_file: facts.testFile } : {}), signal: "SIGKILL", signalled: false };
      try {
        if (ports.readStart(pid) !== start) return; // Exited, or the pid now names another process.
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return;
        write({ ...row, error: `read-start: ${reasonOf(error)}` });
        return;
      }
      try {
        ports.kill(pid);
        stopped += 1;
        write({ ...row, signalled: true });
      } catch (error) {
        write({ ...row, error: `signal: ${reasonOf(error)}` });
      }
    },
    release() {
      if (released) return;
      released = true;
      if (largest === undefined) return;
      write({ ...base, step: DESCENDANT_RSS_PEAK_STEP, max_member_rss_mib: Math.round(largest.rssMib),
        member_is_root: largest.root, ...(largest.testFile ? { test_file: largest.testFile } : {}),
        members_stopped: stopped });
    },
  };
}
