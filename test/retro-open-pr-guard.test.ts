import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
