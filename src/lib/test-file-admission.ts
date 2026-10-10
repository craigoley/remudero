/**
 * test-file-admission — a `node --test` FILE CHILD waits, before its test file loads, while the memory headroom cannot
 * hold one more file beside the growth its admitted siblings still have to make.
 *
 * WHY HERE. OBSERVED 2026-10-10 in the core daemon container: a worker typed `node --test <many files>` by hand, Node ran
 * cores − 1 file children at once, and the tree reached 2.8 GB (7–8 children at 300–570 MB each). Node refuses
 * `--test-concurrency` in NODE_OPTIONS and runs no `--import` in the runner itself, so a hand-typed runner cannot be
 * sized from outside. Its children can: every one loads test/setup/tmp-hygiene.ts first (the deny floor refuses a
 * hand-run without it), and that preload calls {@link admitTestFile} before the test file is imported.
 *
 * TIERED, NEVER A REFUSAL:
 *   no reading (macOS) or not a runner's file child → run at once, nothing recorded;
 *   first in line with no admitted sibling             → run (the floor: one file always progresses);
 *   first in line, headroom ≥ one file plus every admitted sibling's not-yet-reached peak → run;
 *   otherwise                                          → wait, re-reading each poll, and say so once;
 *   admission directory unusable                       → `unqueued`: run at once, and say why.
 * Siblings queue first-come by an atomically claimed sequence number in a directory keyed by the runner's pid and start
 * time; a sibling that died (pid gone or reused) is ignored, never waited on.
 */
import { createHash } from "node:crypto";
import { linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { setTimeout as sleepAsync } from "node:timers/promises";

import { readMemoryHeadroom, TEST_FILE_PEAK_BYTES, testSlotProcessFacts } from "./test-slot.js";
import { RMD_TMP_PREFIX } from "./tmp.js";

const ADMISSION_POLL_MS = 500;

/** Does `argv` (a NUL-split /proc cmdline) start a `node --test` runner? A file child's argv never carries bare `--test`. */
export function isTestRunnerArgv(argv: readonly string[]): boolean {
  return /^node(js)?$/.test(basename(argv[0] ?? "")) && argv.includes("--test");
}

function procRunner(pid: number): boolean {
  try {
    return isTestRunnerArgv(readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0"));
  } catch {
    // No /proc entry to read: nothing proves a runner, so nothing waits.
    return false;
  }
}

function procRss(pid: number): number | undefined {
  try {
    const kb = /^VmRSS:\s*(\d+)\s*kB/m.exec(readFileSync(`/proc/${pid}/status`, "utf8"))?.[1];
    return kb === undefined ? undefined : Number(kb) * 1024;
  } catch {
    // Unreadable: the sibling's whole peak stays reserved, the conservative reading.
    return undefined;
  }
}

/** Seams for {@link admitTestFile}; every one defaults to this process and host. */
export interface TestFileAdmissionOptions {
  env?: NodeJS.ProcessEnv;
  pid?: number;
  runnerPid?: number;
  isRunner?: (pid: number) => boolean;
  facts?: (pid: number) => { start: string; parent: number } | undefined;
  rss?: (pid: number) => number | undefined;
  headroom?: () => number | undefined;
  perFileBytes?: number;
  dir?: string;
  pollMs?: number;
  sleep?: (ms: number) => Promise<unknown>;
  now?: () => number;
  log?: (line: string) => void;
}

export interface TestFileAdmission {
  /** `unqueued`: the admission directory was unusable, so the file ran without waiting (and said why). */
  outcome: "not-a-runner-child" | "no-memory-reading" | "admitted" | "unqueued";
  waitedMs: number;
  /** Removes this child's record; safe to call more than once. */
  release(): void;
}

interface Ticket {
  seq: number;
  pid: number;
  start: string;
  state: "waiting" | "running";
}

function readTickets(dir: string): Ticket[] {
  const tickets: Ticket[] = [];
  for (const name of readdirSync(dir)) {
    const seq = /^seq-([0-9]+)$/.exec(name)?.[1];
    if (seq === undefined) continue;
    try {
      const raw = JSON.parse(readFileSync(join(dir, name), "utf8"));
      if (Number.isSafeInteger(raw.pid) && typeof raw.start === "string") tickets.push({ ...raw, seq: Number(seq) });
    } catch {
      // Gone between the listing and the read (its child exited): nobody to count.
    }
  }
  return tickets;
}

/** Wait (bounded only by siblings finishing) until this file child may load its test file. Never throws. */
export async function admitTestFile(opts: TestFileAdmissionOptions = {}): Promise<TestFileAdmission> {
  const now = opts.now ?? Date.now;
  const startedAt = now();
  const skip = (outcome: TestFileAdmission["outcome"]): TestFileAdmission => ({ outcome, waitedMs: 0, release: () => {} });
  const env = opts.env ?? process.env;
  if (!/^child/.test(env.NODE_TEST_CONTEXT ?? "")) return skip("not-a-runner-child");
  const headroom = opts.headroom ?? readMemoryHeadroom;
  if (headroom() === undefined) return skip("no-memory-reading");
  const facts = opts.facts ?? testSlotProcessFacts;
  const runnerPid = opts.runnerPid ?? process.ppid;
  const pid = opts.pid ?? process.pid;
  // A subprocess a test spawns inherits NODE_TEST_CONTEXT too; only the runner's own file children queue here.
  const runnerStart = (opts.isRunner ?? procRunner)(runnerPid) ? facts(runnerPid)?.start : undefined;
  const start = facts(pid)?.start;
  if (runnerStart === undefined || start === undefined) return skip("not-a-runner-child");
  const perFile = opts.perFileBytes ?? TEST_FILE_PEAK_BYTES;
  const key = createHash("sha256").update(runnerStart).digest("hex").slice(0, 12);
  const dir = opts.dir ?? join(tmpdir(), `${RMD_TMP_PREFIX}test-admit-${runnerPid}-${key}`);
  const rss = opts.rss ?? procRss;
  const log = opts.log ?? ((line: string) => void process.stderr.write(`${line}\n`));
  let path: string | undefined;
  const release = () => {
    if (path === undefined) return;
    try {
      unlinkSync(path);
      rmdirSync(dir);
    } catch {
      // Already gone, or a sibling still queued (ENOTEMPTY): the last one out removes the directory.
    }
    path = undefined;
  };
  try {
    // Claim the next sequence number atomically: the ticket is complete before link(2) makes it visible.
    const draft = join(tmpdir(), `${RMD_TMP_PREFIX}test-admit-ticket-${pid}`);
    const ticket = (state: Ticket["state"]) => JSON.stringify({ pid, start, state });
    writeFileSync(draft, ticket("waiting"));
    let seq = 0;
    try {
      for (;;) {
        mkdirSync(dir, { recursive: true });
        seq = Math.max(seq, ...readTickets(dir).map((t) => t.seq)) + 1;
        try {
          linkSync(draft, join(dir, `seq-${seq}`));
          path = join(dir, `seq-${seq}`);
          break;
        } catch (error) {
          // EEXIST: a sibling took this number; ENOENT: the last one out removed the directory. Either way, again.
          if (!["EEXIST", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        }
      }
    } finally {
      unlinkSync(draft);
    }
    let announced = false;
    for (;;) {
      const live = readTickets(dir).filter((t) => t.pid !== pid && facts(t.pid)?.start === t.start);
      const ahead = live.filter((t) => t.state === "waiting" && t.seq < seq);
      const running = live.filter((t) => t.state === "running");
      const room = running.length === 0 ? undefined : headroom();
      const need = running.reduce((sum, t) => sum + Math.max(0, perFile - (rss(t.pid) ?? 0)), perFile);
      if (ahead.length === 0 && (room === undefined || room >= need)) {
        const promoted = `${path}.running`;
        writeFileSync(promoted, ticket("running"));
        renameSync(promoted, path!);
        const waitedMs = now() - startedAt;
        if (announced) log(JSON.stringify({ step: "test_file_admission.admitted", pid, waitedMs }));
        return { outcome: "admitted", waitedMs, release };
      }
      if (!announced) {
        announced = true;
        log(JSON.stringify({
          step: "test_file_admission.waiting", pid, ahead: ahead.length, running: running.length,
          ...(room === undefined ? {} : { headroomMiB: Math.round(room / 1024 ** 2), needMiB: Math.round(need / 1024 ** 2) }),
        }));
      }
      await (opts.sleep ?? sleepAsync)(opts.pollMs ?? ADMISSION_POLL_MS);
    }
  } catch (error) {
    // An unusable admission directory never stops a test file: it runs, and says why it ran unqueued.
    release();
    log(JSON.stringify({ step: "test_file_admission.unavailable", pid, error: String((error as Error)?.message ?? error) }));
    return { outcome: "unqueued", waitedMs: now() - startedAt, release: () => {} };
  }
}
