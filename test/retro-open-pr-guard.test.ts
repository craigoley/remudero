import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import {
  openRetroPrBlocking,
  RETRO_BRANCH_PREFIX,
  RETRO_OPEN_PR_MAX_AGE_MS,
  staleOpenRetroPrs,
  type OpenPrRow,
} from "../src/lib/retro-open-pr-guard.js";
import { resolveRepoRoot, retroCommand } from "../src/run-task.js";
import { configPath } from "../src/lib/config.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { offlineGithub } from "./setup/offline-github.js";
import { withHealthyRetroProbeGh } from "./helpers/w4226-g1-retro-probe-gh.js";

const NOW = Date.parse("2026-09-29T18:00:00.000Z");
const HOUR = 60 * 60 * 1000;

function row(number: number, ref: string, ageMs: number): OpenPrRow {
  return {
    number,
    html_url: `https://github.com/craigoley/remudero/pull/${number}`,
    created_at: new Date(NOW - ageMs).toISOString(),
    head: { ref },
  };
}

test("W1-T4909: an open retro pull request blocks a second retro", () => {
  const open = row(7865, `${RETRO_BRANCH_PREFIX}1790692269243`, 3 * HOUR);
  const blocking = openRetroPrBlocking([open], NOW, RETRO_OPEN_PR_MAX_AGE_MS);
  assert.equal(blocking?.number, 7865);
  assert.equal(openRetroPrBlocking([], NOW, RETRO_OPEN_PR_MAX_AGE_MS), undefined);
});

test("W1-T4909: an abandoned retro pull request older than the age bound does not block", () => {
  const abandoned = row(7865, `${RETRO_BRANCH_PREFIX}1790692269243`, RETRO_OPEN_PR_MAX_AGE_MS + HOUR);
  assert.equal(openRetroPrBlocking([abandoned], NOW, RETRO_OPEN_PR_MAX_AGE_MS), undefined);
  assert.deepEqual(staleOpenRetroPrs([abandoned], NOW, RETRO_OPEN_PR_MAX_AGE_MS).map((r) => r.number), [7865]);
  const fresh = row(7872, `${RETRO_BRANCH_PREFIX}1790694205979`, HOUR);
  assert.deepEqual(staleOpenRetroPrs([fresh, abandoned], NOW, RETRO_OPEN_PR_MAX_AGE_MS).map((r) => r.number), [7865]);
});

test("W1-T4909: a pull request from another lane never blocks a retro", () => {
  const others = [
    row(1, "run-W1-T9-RETRO-x", HOUR),
    row(2, "run-W1-T4909-1790796000001", HOUR),
    row(3, `feature/${RETRO_BRANCH_PREFIX}1`, HOUR),
  ];
  assert.equal(openRetroPrBlocking(others, NOW, RETRO_OPEN_PR_MAX_AGE_MS), undefined);
  assert.deepEqual(staleOpenRetroPrs(others, NOW, RETRO_OPEN_PR_MAX_AGE_MS), []);
});

test("W1-T4909: the oldest open retro pull request is the one named", () => {
  const rows = [
    row(7872, `${RETRO_BRANCH_PREFIX}1790694205979`, 2 * HOUR),
    row(7865, `${RETRO_BRANCH_PREFIX}1790692269243`, 5 * HOUR),
    row(7880, `${RETRO_BRANCH_PREFIX}1790697000000`, HOUR),
  ];
  assert.equal(openRetroPrBlocking(rows, NOW, RETRO_OPEN_PR_MAX_AGE_MS)?.number, 7865);
});

test("W1-T4909: a pull request with an unreadable created_at is neither blocking nor stale", () => {
  const broken = { ...row(9, `${RETRO_BRANCH_PREFIX}9`, HOUR), created_at: "not-a-date" };
  assert.equal(openRetroPrBlocking([broken], NOW, RETRO_OPEN_PR_MAX_AGE_MS), undefined);
  assert.deepEqual(staleOpenRetroPrs([broken], NOW, RETRO_OPEN_PR_MAX_AGE_MS), []);
});

// ── the wiring: the REAL retroCommand asks the guard before it spawns the Architect ─────────────

const REPO_ROOT_FOR_FIXTURES = resolveRepoRoot(process.argv.slice(2), process.cwd());

async function driveRetro(
  openPrs: (args: string[]) => unknown,
): Promise<{ exit: number | "threw"; error?: string; spawned: number; ledger: Array<Record<string, unknown>>; fetched: string[][] }> {
  const fakeHome = mkdtempSync(join(tmpdir(), "rmd-retro-open-pr-home-"));
  const root = mkdtempSync(join(tmpdir(), "rmd-retro-open-pr-root-"));
  const savedHome = process.env.HOME;
  process.env.HOME = fakeHome;
  mkdirSync(join(fakeHome, ".config", "remudero"), { recursive: true });
  writeFileSync(configPath(), JSON.stringify({ claudeBin: "/bin/true", root, installRoot: REPO_ROOT_FOR_FIXTURES }, null, 2) + "\n");
  const origLog = console.log;
  const origError = console.error;
  console.log = () => {};
  console.error = () => {};
  let spawned = 0;
  const fetched: string[][] = [];
  try {
    let exit: number | "threw";
    let error: string | undefined;
    try {
      exit = await withHealthyRetroProbeGh(() =>
        withLiveWritesAllowed(() =>
          retroCommand([], {
            github: offlineGithub(),
            openPrs: (args: string[]) => {
              fetched.push(args);
              return openPrs(args);
            },
            spawn: (async () => {
              spawned += 1;
              throw new Error("this test never pays for a worker");
            }) as never,
          } as never),
        ),
      );
    } catch (e) {
      exit = "threw";
      error = String((e as Error).message);
    }
    const ledgerPath = join(root, "state", "ledger.ndjson");
    const ledger = existsSync(ledgerPath)
      ? readFileSync(ledgerPath, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as Record<string, unknown>)
      : [];
    return { exit, error, spawned, ledger, fetched };
  } finally {
    console.log = origLog;
    console.error = origError;
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
}

test("W1-T4909: retroCommand skips, before any worker spawn, while a fresh retro pull request is open", async () => {
  const fresh = row(7865, `${RETRO_BRANCH_PREFIX}1790692269243`, 2 * HOUR);
  fresh.created_at = new Date(Date.now() - 2 * HOUR).toISOString();
  const r = await driveRetro(() => [fresh]);
  assert.equal(r.exit, 1);
  assert.equal(r.spawned, 0);
  assert.match(r.fetched[0]!.join(" "), /pulls\?state=open/);
  const skipped = r.ledger.filter((l) => l.step === "retro.skipped_open_pr");
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0]!.pr_number, 7865);
  assert.equal(skipped[0]!.pr_url, fresh.html_url);
  assert.equal(typeof skipped[0]!.age_ms, "number");
  assert.equal(r.ledger.filter((l) => l.step === "retro.start").length, 0, "the skip precedes the lane's start rows");
});

test("W1-T4909: retroCommand proceeds and ledgers an ignored stale retro pull request", async () => {
  const stale = row(7865, `${RETRO_BRANCH_PREFIX}1790692269243`, 3 * 24 * HOUR);
  stale.created_at = new Date(Date.now() - 3 * 24 * HOUR).toISOString();
  const r = await driveRetro(() => [stale]);
  assert.equal(r.ledger.filter((l) => l.step === "retro.skipped_open_pr").length, 0);
  const ignored = r.ledger.filter((l) => l.step === "retro.open_pr_ignored_stale");
  assert.equal(ignored.length, 1);
  assert.deepEqual(ignored[0]!.pr_numbers, [7865]);
  assert.equal(r.ledger.filter((l) => l.step === "retro.start").length, 1, "the retro went on to start");
});

test("W1-T4909: retroCommand throws when the open pull request listing is unreadable", async () => {
  const r = await driveRetro(() => {
    throw new Error("listing refused");
  });
  assert.equal(r.exit, "threw");
  assert.match(r.error ?? "", /listing refused/);
  assert.equal(r.spawned, 0);
  assert.equal(r.ledger.filter((l) => l.step === "retro.start").length, 0);
});

// ── W1-T9363: the retro lane lock — one retro in flight per root ─────────────────────────────────

interface LaneDrive {
  exit: number | "threw";
  error?: string;
  spawned: number;
  fetched: number;
  lockDuringRead: Array<Record<string, unknown> | null>;
  lockAfter: string | null;
  ledger: Array<Record<string, unknown>>;
}

/** Drive the REAL retroCommand against a private root; `heldBy` pre-writes the lane lock as another run would. */
async function driveRetroLane(
  heldBy: Record<string, unknown> | undefined,
  openPrs: () => OpenPrRow[],
  args: string[] = [],
): Promise<LaneDrive> {
  const fakeHome = mkdtempSync(join(tmpdir(), "rmd-retro-lock-home-"));
  const root = mkdtempSync(join(tmpdir(), "rmd-retro-lock-root-"));
  const lockPath = join(root, "state", "retro.lock");
  const savedHome = process.env.HOME;
  process.env.HOME = fakeHome;
  mkdirSync(join(fakeHome, ".config", "remudero"), { recursive: true });
  writeFileSync(configPath(), JSON.stringify({ claudeBin: "/bin/true", root, installRoot: REPO_ROOT_FOR_FIXTURES }, null, 2) + "\n");
  if (heldBy) {
    mkdirSync(join(root, "state"), { recursive: true });
    writeFileSync(lockPath, JSON.stringify(heldBy));
  }
  const origLog = console.log;
  const origError = console.error;
  console.log = () => {};
  console.error = () => {};
  let spawned = 0;
  let fetched = 0;
  const lockDuringRead: Array<Record<string, unknown> | null> = [];
  try {
    let exit: number | "threw";
    let error: string | undefined;
    try {
      exit = await withHealthyRetroProbeGh(() =>
        withLiveWritesAllowed(() =>
          retroCommand(args, {
            github: offlineGithub(),
            openPrs: () => {
              fetched += 1;
              lockDuringRead.push(existsSync(lockPath) ? (JSON.parse(readFileSync(lockPath, "utf8")) as Record<string, unknown>) : null);
              return openPrs();
            },
            spawn: (async () => {
              spawned += 1;
              throw new Error("this test never pays for a worker");
            }) as never,
          } as never),
        ),
      );
    } catch (e) {
      exit = "threw";
      error = String((e as Error).message);
    }
    const ledgerPath = join(root, "state", "ledger.ndjson");
    const ledger = existsSync(ledgerPath)
      ? readFileSync(ledgerPath, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as Record<string, unknown>)
      : [];
    const lockAfter = existsSync(lockPath) ? readFileSync(lockPath, "utf8") : null;
    return { exit, error, spawned, fetched, lockDuringRead, lockAfter, ledger };
  } finally {
    console.log = origLog;
    console.error = origError;
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
}

test("W1-T9363: a retro that finds another retro in flight skips without synthesizing", async () => {
  const holder = { pid: process.pid, host: hostname(), startedAt: new Date().toISOString() };
  const r = await driveRetroLane(holder, () => []);
  assert.equal(r.exit, 1, r.error);
  assert.equal(r.spawned, 0, "no Architect spawn while another retro holds the lane");
  assert.equal(r.fetched, 0, "the open-PR re-query belongs to the holder, not the contender");
  const skipped = r.ledger.filter((l) => l.step === "retro.skipped_in_flight");
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0]!.holder_pid, holder.pid);
  assert.equal(skipped[0]!.holder_host, holder.host);
  assert.equal(skipped[0]!.holder_started_at, holder.startedAt);
  assert.equal(r.ledger.filter((l) => l.step === "retro.start").length, 0);
  assert.deepEqual(JSON.parse(r.lockAfter ?? "null"), holder, "the holder's lock is left exactly as it was");
});

test("W1-T9363: a retro re-reads open retro pull requests while it holds the lane, then releases it", async () => {
  const open: OpenPrRow = {
    number: 12001,
    html_url: "https://github.com/craigoley/remudero/pull/12001",
    created_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    head: { ref: `${RETRO_BRANCH_PREFIX}1792000000000` },
  };
  const r = await driveRetroLane(undefined, () => [open]);
  assert.equal(r.exit, 1, r.error);
  assert.equal(r.fetched, 1);
  assert.equal(r.lockDuringRead[0]?.pid, process.pid, "the open-PR read runs inside this run's own lock");
  assert.equal(r.ledger.filter((l) => l.step === "retro.skipped_open_pr").length, 1);
  assert.equal(r.ledger.filter((l) => l.step === "retro.skipped_in_flight").length, 0);
  assert.equal(r.lockAfter, null, "the lane lock is released when the run ends");
});

test("W1-T9363: a dead retro's lock does not hold the lane, and a thrown run still releases it", async () => {
  const dead = { pid: 2 ** 22 + 17, host: hostname(), startedAt: new Date().toISOString() };
  const r = await driveRetroLane(dead, () => {
    throw new Error("listing refused");
  });
  assert.equal(r.exit, "threw");
  assert.match(r.error ?? "", /listing refused/);
  assert.equal(r.ledger.filter((l) => l.step === "retro.skipped_in_flight").length, 0);
  assert.equal(r.fetched, 1, "the reclaimed lane runs the retro's own open-PR read");
  assert.equal(r.lockAfter, null);
});

test("W1-T9363: a dry-run retro writes nothing, so it never waits on the lane", async () => {
  const holder = { pid: process.pid, host: hostname(), startedAt: new Date().toISOString() };
  const r = await driveRetroLane(holder, () => [], ["--dry-run"]);
  assert.equal(r.exit, 0, r.error);
  assert.equal(r.spawned, 0);
  assert.equal(r.ledger.filter((l) => l.step === "retro.skipped_in_flight").length, 0);
  assert.deepEqual(JSON.parse(r.lockAfter ?? "null"), holder);
});
