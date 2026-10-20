import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Config } from "#src/lib/config.js";
import { loadPolicy, policyPath, type Policy } from "#src/lib/policy.js";
import type { GitLogCommit, ShippedGithub } from "#src/lib/retro.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { newFeedbackIdsOldestFirst } from "#src/lib/auto-triage.js";
import { TRIAGE_COMMIT_REFUSED_STEP } from "#src/lib/triage.js";
// Namespace imports: this file must LOAD on a base without the W1-T10046 symbols, so each proof fails
// there on its own assertion rather than on a missing export.
import * as ledgerUnion from "#src/lib/ledger-union.js";
import * as retro from "#src/lib/retro.js";
import * as sweep from "#src/lib/sweep.js";
import * as runTask from "#src/run-task.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

// W1-T10046. OBSERVED 2026-10-17: every daemon boot re-read the whole ledger corpus twice, the retro check's union
// (about 288 MB, async) and the auto-triage refusal read (about 243 MB, synchronous on the main thread), for slices
// of about 1 MB. A restarted process is a FRESH reader: here it must answer from the digests a previous reader left,
// with every archive overwritten by same-length garbage under its original size and mtime.

const SHIPPED_POLICY: Policy = loadPolicy(policyPath(REPO_ROOT));
const RETRO_POLICY: Policy = { ...SHIPPED_POLICY, values: { ...SHIPPED_POLICY.values, retro: { mergesThreshold: 2, daysThreshold: 99_999 } } };
const TRIAGE_POLICY: Policy = {
  ...SHIPPED_POLICY,
  values: { ...SHIPPED_POLICY.values, autoTriage: { enabled: true, minIntervalMinutes: 1, maxPerDay: 50 } },
};
const NOW = new Date("2026-10-06T12:00:00.000Z");
const COMMITS: GitLogCommit[] = [];
/** A whole-second mtime, so restoring it after the overwrite reproduces the size:mtime key exactly. */
const MTIME_S = 1_791_000_000;

/** Rows for runs `from`..`to`: a start, a merged verdict, and one row no slice keeps. */
function runRows(from: number, to: number): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (let i = from; i < to; i++) {
    const run = `W1-T${9000 + i}-1791000000000`;
    rows.push({ ts: `2026-10-05T0${i % 10}:00:00.000Z`, run_id: run, task_id: `W1-T${9000 + i}`, step: "run.start" });
    rows.push({ ts: `2026-10-05T0${i % 10}:30:00.000Z`, run_id: run, task_id: `W1-T${9000 + i}`, step: "verdict", verdict: "merged", pr_url: `https://github.com/o/r/pull/${i}` });
    rows.push({ ts: `2026-10-05T0${i % 10}:40:00.000Z`, run_id: run, step: "noise.unretained", n: i });
  }
  return rows;
}

function stateRoot(prefix: string): { root: string; stateDir: string; config: Config } {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}${prefix}-`));
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  return { root, stateDir, config: { claudeBin: "/bin/true", root } };
}

function archives(stateDir: string): string[] {
  return ledgerUnion.ledgerRotationEntries(readdirSync(stateDir), stateDir).map((entry) => entry.path);
}

function pinMtimes(stateDir: string): void {
  for (const path of archives(stateDir)) utimesSync(path, MTIME_S, MTIME_S);
}

/** The restarted process's view: every archive is now unreadable garbage of the same length, at the same mtime. */
function garbleArchives(stateDir: string): void {
  for (const path of archives(stateDir)) {
    writeFileSync(path, Buffer.alloc(statSync(path).size, 0x21));
    utimesSync(path, MTIME_S, MTIME_S);
  }
}

function rowsOfStep(stateDir: string, step: string): Array<Record<string, unknown>> {
  return readFileSync(join(stateDir, "ledger.ndjson"), "utf8").split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>).filter((row) => row.step === step);
}

function github(commits: GitLogCommit[] = COMMITS): ShippedGithub {
  return { findMergedByTrailer: () => null, headRefName: () => undefined, unavailable: () => undefined, mergedCommits: () => commits };
}

/** One merged commit per archived task: a run the check can see takes its merge out of the runless count. */
const ARCHIVED_COMMITS: GitLogCommit[] = [0, 1, 2, 3, 4].map((i) => ({ date: "2026-10-05T12:00:00+00:00", message: `feat: task ${i}\n\nRemudero-Task: W1-T${9000 + i}` }));

/** Counts event-loop turns while `pending` settles: a loop held by synchronous I/O turns none. */
async function turnsWhile<T>(pending: () => Promise<T>): Promise<{ value: T; turns: number }> {
  let turns = 0;
  let on = true;
  const tick = (): void => {
    if (!on) return;
    turns += 1;
    setImmediate(tick);
  };
  setImmediate(tick);
  try {
    return { value: await pending(), turns };
  } finally {
    on = false;
  }
}

const RUN_PATTERN = '"step":"run\\.start"|"step":"verdict"|"step":"pr\\.opened"';
const freshRunReader = () => sweep.createEscalationTriageHistoryReader({ slice: runTask.RETRO_TRIGGER_RUN_SLICE });
const freshRefusalReader = () => sweep.createEscalationTriageHistoryReader({ slice: runTask.AUTO_TRIAGE_REFUSAL_SLICE });

test("W1-T10046: a restarted retro check reads its run slice from digests, not rotations", async () => {
  const { root, stateDir, config } = stateRoot("retro-digest");
  try {
    writeLedger(runRows(6, 7), {
      dir: stateDir,
      rotations: [
        { at: "2026-10-01T00:00:00.000Z", rows: runRows(0, 2) },
        { at: "2026-10-03T00:00:00.000Z", rows: runRows(2, 5), gz: true },
      ],
    });
    pinMtimes(stateDir);
    const check = (runHistory: ReturnType<typeof freshRunReader>) =>
      runTask.retroTriggerCheckAsync(NOW, { config, github: github(ARCHIVED_COMMITS), policy: RETRO_POLICY, readMergedCommits: async () => ARCHIVED_COMMITS, runHistory });
    // The sync twin over the intact corpus is the answer every later read must give: every archived merge has its run.
    const expected = runTask.retroTriggerCheck(NOW, { config, github: github(ARCHIVED_COMMITS), policy: RETRO_POLICY });
    assert.ok(expected, "the check decides over the intact corpus");
    assert.deepEqual(await check(freshRunReader()), expected, "the first process writes the digests and answers the same");

    garbleArchives(stateDir);
    assert.equal(ledgerUnion.resolveLedgerUnion(stateDir, RUN_PATTERN).ok, false, "the archives themselves are unreadable now");
    const restarted = await check(freshRunReader());
    assert.deepEqual(restarted, expected, "a restarted check still credits the archived runs, from their digests");
    const row = rowsOfStep(stateDir, "retro_trigger.ledger_read").at(-1);
    assert.ok(row, "every retro check ledgers what its read cost");
    assert.equal(row.source, "union");
    assert.equal(row.rotations, 2);
    assert.equal(row.loaded_rotations, 2);
    assert.equal(row.digest_hits, 2, "both rotations came from digests");
    assert.equal(row.digest_misses, 0, "no rotation was decompressed");
    assert.equal(row.seeded_rotations, 2, "the union pass re-read no digest on the loop");
    assert.ok(Number(row.loop_read_bytes) <= statSync(join(stateDir, "ledger.ndjson")).size, `the loop read only the live file: ${JSON.stringify(row)}`);
    assert.equal(typeof row.ms, "number");

    // A rotation with no digest and garbage bytes is unread: the check falls back to the live file, as today.
    rmSync(join(stateDir, "cache"), { recursive: true, force: true });
    const fallback = await runTask.readRetroTriggerRunsAsync(config, freshRunReader());
    assert.equal(rowsOfStep(stateDir, "retro_trigger.ledger_read").at(-1)?.source, "live-file");
    assert.ok(fallback.some((rec) => rec.run_id === "W1-T9006-1791000000000"), "the live run is still read");
    assert.ok(!fallback.some((rec) => rec.run_id === "W1-T9000-1791000000000"), "an unread archive contributes nothing");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T10046: a fresh auto-triage check reads its refusal slice from digests off the loop", async () => {
  const candidates = newFeedbackIdsOldestFirst(REPO_ROOT);
  assert.ok(candidates.length >= 1, "this checkout holds at least one status: new entry to exercise");
  const { root, stateDir, config } = stateRoot("triage-refusal-digest");
  try {
    const refusals = candidates.map((id, i) => ({
      ts: `2026-10-02T00:00:${String(i % 60).padStart(2, "0")}.000Z`, run_id: `TRIAGE-${id}`, task_id: `TRIAGE-${id}`, step: TRIAGE_COMMIT_REFUSED_STEP, feedback_id: id,
    }));
    const bulk = Array.from({ length: 30_000 }, (_, i) => ({ ts: "2026-10-02T01:00:00.000Z", step: "noise.bulk", i }));
    writeLedger([{ ts: "2026-10-05T00:00:00.000Z", step: "noise.live" }], {
      dir: stateDir, rotations: [{ at: "2026-10-03T00:00:00.000Z", rows: [...refusals, ...bulk], gz: true }],
    });
    pinMtimes(stateDir);
    const claimReserver = { mintAnchor: () => "a", attempt: () => "created", claimedIds: () => new Map() } as never;
    const check = (refusalHistory: ReturnType<typeof freshRefusalReader>) => turnsWhile(() => runTask.autoTriageCheck({
      config, policy: TRIAGE_POLICY, now: new Date(), deferralPending: true, dispatchCount: 1, laneBudget: 1, claimReserver, refusalHistory,
    }));

    const first = await check(freshRefusalReader());
    assert.equal(first.value.fire, false, `every candidate is refused in the archive: ${JSON.stringify(first.value)}`);
    assert.match(first.value.reason, /refused triage commit/);
    assert.ok(first.turns > 0, `the refusal read must leave the loop turning (turned ${first.turns})`);

    garbleArchives(stateDir);
    const restarted = await check(freshRefusalReader());
    assert.equal(restarted.value.fire, false, `the archived refusal still holds after a restart: ${JSON.stringify(restarted.value)}`);
    assert.match(restarted.value.reason, /refused triage commit/);
    assert.ok(restarted.turns > 0, `the restarted read is off the loop too (turned ${restarted.turns})`);
    const row = rowsOfStep(stateDir, "auto_triage.refusal_read").at(-1);
    assert.ok(row, "the refusal read ledgers what it cost");
    assert.equal(row.ok, true);
    assert.equal(row.rows, candidates.length);
    assert.equal(row.digest_hits, 1, "the archive came from its digest");
    assert.equal(row.digest_misses, 0);

    // With no digest, a garbage archive is unread: no refusals, so the oldest entry is retried (today's behaviour).
    rmSync(join(stateDir, "cache"), { recursive: true, force: true });
    assert.equal(await runTask.readAutoTriageRefusalRowsAsync(config, freshRefusalReader()), undefined);
    assert.equal(rowsOfStep(stateDir, "auto_triage.refusal_read").at(-1)?.ok, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T10046: a slice read whose cost row cannot be ledgered still returns its rows", async () => {
  const { root, stateDir, config } = stateRoot("slice-row-unwritable");
  try {
    writeLedger(runRows(0, 1), { dir: stateDir });
    const refused = () => {
      throw new Error("ledger unwritable");
    };
    const records = await runTask.readRetroTriggerRunsAsync(config, freshRunReader(), refused);
    assert.equal(records.filter((rec) => rec.step === "run.start").length, 1, "no rotation yet: the live file is read whole");
    assert.deepEqual(await runTask.readAutoTriageRefusalRowsAsync(config, freshRefusalReader(), refused), []);
    assert.equal(rowsOfStep(stateDir, "retro_trigger.ledger_read").length, 0);
    rmSync(join(stateDir, "ledger.ndjson"));
    assert.deepEqual(await runTask.readRetroTriggerRunsAsync(config, freshRunReader(), refused), [], "no ledger at all reads empty");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T10046: the production checks build their own slice readers", async () => {
  const { root, stateDir, config } = stateRoot("slice-default-readers");
  try {
    writeLedger(runRows(0, 3), { dir: stateDir, rotations: [{ at: "2026-10-01T00:00:00.000Z", rows: runRows(3, 4), gz: true }] });
    const decision = await runTask.retroTriggerCheckAsync(NOW, { config, github: github(), policy: RETRO_POLICY, readMergedCommits: async () => COMMITS });
    assert.equal(decision?.fire, true);
    assert.equal(rowsOfStep(stateDir, "retro_trigger.ledger_read").at(-1)?.source, "union");
    // The slice read finds the same runs the whole-union read finds.
    const union = retro.parseLedger(ledgerUnion.resolveLedgerUnion(stateDir, RUN_PATTERN).matches.join("\n"));
    assert.deepEqual(await runTask.readRetroTriggerRunsAsync(config, freshRunReader()), union);
    const claimReserver = { mintAnchor: () => "a", attempt: () => "created", claimedIds: () => new Map() } as never;
    await runTask.autoTriageCheck({ config, policy: TRIAGE_POLICY, now: new Date(), deferralPending: true, dispatchCount: 1, laneBudget: 1, claimReserver });
    assert.equal(rowsOfStep(stateDir, "auto_triage.refusal_read").at(-1)?.ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
