import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { RETRO_BRANCH_PREFIX, type OpenPrRow } from "../src/lib/retro-open-pr-guard.js";
import { resolveRepoRoot, serializedRetroCommand } from "../src/run-task.js";
import { configPath } from "../src/lib/config.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { offlineGithub } from "./setup/offline-github.js";
import { withHealthyRetroProbeGh } from "./helpers/w4226-g1-retro-probe-gh.js";

const REPO_ROOT_FOR_FIXTURES = resolveRepoRoot(process.argv.slice(2), process.cwd());

interface Drive {
  exit: number | "threw";
  error?: string;
  spawned: number;
  fetched: number;
  lockDuringRead: Array<Record<string, unknown> | null>;
  lockAfter: string | null;
  ledger: Array<Record<string, unknown>>;
}

/** Drive the REAL retroCommand against a private root; `heldBy` pre-writes the lane lock as another run would. */
async function driveRetro(
  heldBy: Record<string, unknown> | undefined,
  openPrs: () => OpenPrRow[],
  args: string[] = [],
): Promise<Drive> {
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
          serializedRetroCommand(args, {
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
  const r = await driveRetro(holder, () => []);
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
  const r = await driveRetro(undefined, () => [open]);
  assert.equal(r.exit, 1, r.error);
  assert.equal(r.fetched, 1);
  assert.equal(r.lockDuringRead[0]?.pid, process.pid, "the open-PR read runs inside this run's own lock");
  assert.equal(r.ledger.filter((l) => l.step === "retro.skipped_open_pr").length, 1);
  assert.equal(r.ledger.filter((l) => l.step === "retro.skipped_in_flight").length, 0);
  assert.equal(r.lockAfter, null, "the lane lock is released when the run ends");
});

test("W1-T9363: a dead retro's lock does not hold the lane, and a thrown run still releases it", async () => {
  const dead = { pid: 2 ** 22 + 17, host: hostname(), startedAt: new Date().toISOString() };
  const r = await driveRetro(dead, () => {
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
  const r = await driveRetro(holder, () => [], ["--dry-run"]);
  assert.equal(r.exit, 0, r.error);
  assert.equal(r.spawned, 0);
  assert.equal(r.ledger.filter((l) => l.step === "retro.skipped_in_flight").length, 0);
  assert.deepEqual(JSON.parse(r.lockAfter ?? "null"), holder);
});
