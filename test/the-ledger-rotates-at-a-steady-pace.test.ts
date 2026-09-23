import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LEDGER_ROTATION_BACKSTOP_MULTIPLIER,
  flagAnomalousLedgerWriters,
  rotateLedger,
  topLedgerWriters,
  type LedgerArchiveStampFsDeps,
  type LedgerLine,
} from "../src/lib/ledger.js";
import { rotationStampIso } from "../src/lib/ledger-union.js";

/** {@link LedgerArchiveStampFsDeps} backed by real `node:fs`, so a test only needs to override
 *  the one method whose failure it is proving. */
const realStampFsDeps: LedgerArchiveStampFsDeps = {
  readdirSync: (dir) => readdirSync(dir),
  statMtimeMs: (path) => statSync(path).mtimeMs,
  renameSync: (from, to) => renameSync(from, to),
};

// ── W1-T4100 — READ 2026-09-23 on the host: 369 `ledger*.gz` archives (256 MB), 310 minted on
// 2026-09-22 alone (about thirteen an hour), and one archive named
// `ledger.2027-10-14T21-24-52-494Z.ndjson.gz` with a real file date of 2026-09-13 — a name over a
// year ahead of when the archive actually landed, so a reader picking "the newest by name" picks
// that stale file over every real one written since. Three claims, three tests below: a burst of
// writes must not multiply into a burst of archives; an archive's name must never outrun the real
// file it names; and the volume driving the churn must be measurable by step, not just felt. ────

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "rmd-ledger-steady-pace-"));
}

function archivesIn(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f !== "ledger.ndjson" && (f.endsWith(".ndjson") || f.endsWith(".ndjson.gz")))
    .sort();
}

function noiseLine(n: number): string {
  return JSON.stringify({ step: "ci.polling", run_id: `noise-${n}`, task_id: "W1-NOISE", detail: "x".repeat(64) });
}

/** Pads `ledgerPath` with enough noise lines to push it past `ceiling` bytes. */
function padPast(ledgerPath: string, ceiling: number, startAt: number): number {
  let n = startAt;
  while (statSync(ledgerPath).size <= ceiling) {
    writeFileSync(ledgerPath, noiseLine(n++) + "\n", { flag: "a" });
  }
  return n;
}

test("W1-T4100: a burst of writes produces few archives", () => {
  const dir = tmpDir();
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    const ceiling = 2000;
    writeFileSync(ledgerPath, "");
    let n = padPast(ledgerPath, ceiling, 0);

    const first = rotateLedger(ledgerPath, { ceilingBytes: ceiling });
    assert.equal(first.rotated, true, "sanity: the first crossing rotates — nothing to smooth against yet");
    assert.equal(archivesIn(dir).length, 1);

    // THE BURST: several more crossings landing within real milliseconds of the first rotation —
    // exactly the shape of the incident (a burst of writes, not a steady trickle). Each one alone
    // would have minted its own archive before this task; none of them may now, because the
    // smoothing window has not elapsed and none pushes the live file anywhere near the backstop.
    for (let i = 0; i < 6; i++) {
      n = padPast(ledgerPath, ceiling, n);
      const result = rotateLedger(ledgerPath, { ceilingBytes: ceiling });
      assert.equal(result.rotated, false, `crossing ${i} inside the smoothing window must not rotate again`);
    }
    assert.equal(
      archivesIn(dir).length,
      1,
      "FALSIFIER: a burst of six more crossings must not multiply into six more archives",
    );
    assert.ok(statSync(ledgerPath).size > ceiling, "the live file keeps growing for real — the burst was throttled, not discarded");

    // THE BACKSTOP: growing the live file to LEDGER_ROTATION_BACKSTOP_MULTIPLIER times the
    // ceiling must force a rotation even though the window has not elapsed — the smoothing
    // window is a courtesy, never a way to hold the live ledger past a size this repo has
    // already been burned by keeping in memory whole.
    while (statSync(ledgerPath).size <= ceiling * LEDGER_ROTATION_BACKSTOP_MULTIPLIER) {
      writeFileSync(ledgerPath, noiseLine(n++) + "\n", { flag: "a" });
    }
    const backstopped = rotateLedger(ledgerPath, { ceilingBytes: ceiling });
    assert.equal(backstopped.rotated, true, "a live file past the backstop rotates regardless of how recently the last one fired");
    assert.equal(archivesIn(dir).length, 2, "the backstop trip is the SECOND archive — the smoothing window still held for everything short of it");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T4100: an archive name never runs ahead of its file", () => {
  const dir = tmpDir();
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    const ceiling = 2000;
    writeFileSync(ledgerPath, "");
    padPast(ledgerPath, ceiling, 0);

    // THE FALSIFIER'S OWN SCENARIO: a clock set ahead — the exact incident, a year and change
    // past the real date the archive actually lands on disk.
    const result = rotateLedger(ledgerPath, { ceilingBytes: ceiling, now: () => new Date("2027-10-14T21:24:52.494Z") });
    assert.equal(result.rotated, true);
    assert.ok(result.archivePath, "a rotation that fires must name the archive it wrote");

    const archivePath = result.archivePath as string;
    const stampIso = rotationStampIso(archivePath.split("/").pop() as string);
    assert.ok(stampIso, "the archive's name must still be a parseable rotation stamp");
    const nameMs = Date.parse(stampIso as string);
    const mtimeMs = statSync(archivePath).mtimeMs;

    assert.ok(
      nameMs <= mtimeMs,
      `FALSIFIER: named from the wall clock alone, the archive's name (${stampIso}) would run ahead of ` +
        `its own real file (mtime ${new Date(mtimeMs).toISOString()})`,
    );
    assert.ok(!archivePath.includes("2027-10-14"), "the injected future stamp must not survive into the archive's real name");

    // Back-date the first archive's own mtime past the rotation-smoothing window (a SEPARATE
    // W1-T4100 concern, covered by its own test) so this test's second rotation below is not
    // throttled by it — this test is about naming safety, not cadence.
    const tenMinutesAgo = Date.now() - 10 * 60_000;
    utimesSync(archivePath, new Date(tenMinutesAgo), new Date(tenMinutesAgo));

    // SELF-HEAL: an archive already on disk from BEFORE this fix, carrying a literal future-dated
    // name but a real (past) mtime — the exact shape the 2026-09-23 read found live on the host.
    const staleFutureName = "ledger.2027-01-01T00-00-00-000Z.ndjson.gz";
    const stalePath = join(dir, staleFutureName);
    writeFileSync(stalePath, Buffer.from("stale"));
    const realPastMs = Date.parse("2026-09-13T00:00:00.000Z");
    utimesSync(stalePath, new Date(realPastMs), new Date(realPastMs));
    assert.equal(readdirSync(dir).includes(staleFutureName), true, "fixture: the stale future-dated archive exists before the next rotation");

    padPast(ledgerPath, ceiling, 100_000);
    const next = rotateLedger(ledgerPath, { ceilingBytes: ceiling });
    assert.equal(next.rotated, true, "sanity: a further crossing after the backstop-free window rotates again");

    assert.equal(
      readdirSync(dir).includes(staleFutureName),
      false,
      "FALSIFIER: an existing future-dated archive must be renamed by the next rotation, not left stale forever",
    );
    const healedNames = readdirSync(dir).filter((f) => f.endsWith(".ndjson.gz") || f.endsWith(".ndjson"));
    const healedForStale = healedNames.find((f) => {
      const iso = rotationStampIso(f);
      if (!iso) return false;
      return Math.abs(Date.parse(iso) - realPastMs) < 1000;
    });
    assert.ok(healedForStale, "the stale archive's content survives under a name derived from its own real (past) mtime, not deleted");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T4100: the digest names the top ledger writers", () => {
  const lines: string[] = [];
  for (let i = 0; i < 50; i++) {
    lines.push(JSON.stringify({ step: "ci.polling", run_id: `poll-${i}`, task_id: "W1-NOISE", detail: "x".repeat(8) } satisfies LedgerLine));
  }
  // ONE step writing far more bytes than everything else combined — the shape of a real "what
  // writes so much" incident: not evenly spread noise, one misbehaving producer.
  for (let i = 0; i < 5; i++) {
    lines.push(
      JSON.stringify({
        step: "sweep.escalation_reconcile.summary",
        run_id: `sweep-${i}`,
        task_id: "W1-HEAVY",
        payload: "y".repeat(2000),
      } satisfies LedgerLine),
    );
  }

  const ranked = topLedgerWriters(lines);
  assert.equal(ranked[0]?.step, "sweep.escalation_reconcile.summary", "the digest's ranking must name the heaviest writer first");
  assert.ok(ranked[0]!.shareOfBytes > 0.5, "the heaviest writer's share must reflect that it dwarfs the rest of the corpus");
  const pollingEntry = ranked.find((w) => w.step === "ci.polling");
  assert.ok(pollingEntry, "every distinct step present must be represented, not just the top one");
  assert.ok(pollingEntry!.lineCount === 50, "line counts are exact, not sampled");

  // A step writing FAR ABOVE its historical share is flagged (design note i) — the same
  // ci.polling volume, present in BOTH windows at a steady share, must NOT be flagged, while the
  // heavy step, absent from the baseline window entirely, must be.
  const baseline: string[] = [];
  for (let i = 0; i < 50; i++) {
    baseline.push(JSON.stringify({ step: "ci.polling", run_id: `base-poll-${i}`, task_id: "W1-NOISE", detail: "x".repeat(8) } satisfies LedgerLine));
  }
  const flagged = flagAnomalousLedgerWriters(lines, baseline);
  const heavyFlag = flagged.find((w) => w.step === "sweep.escalation_reconcile.summary");
  const pollingFlag = flagged.find((w) => w.step === "ci.polling");
  assert.equal(heavyFlag?.aboveHistoricalShare, true, "a step absent from the baseline that now dominates must be flagged");
  assert.equal(pollingFlag?.aboveHistoricalShare, false, "a step holding its OWN steady share across both windows must not be flagged");
});

// ── W1-T4100 — THE NAMING-SAFETY MACHINERY DEGRADES, IT NEVER THROWS. Every one of the four
// filesystem races below (an unreadable state dir, a file gone between `readdir` and `stat`, a
// rename the OS refuses, an unstattable file just written) is real on a live host — a concurrent
// compactor deleting an archive, a permissions hiccup, disk pressure mid-rename — and each is
// explicitly documented as best-effort in ledger.ts's own comments: "must never fail the rotation
// that triggered it". These four tests inject a throwing LedgerArchiveStampFsDeps to prove that
// promise deterministically, without needing a real race to land inside a single test process. ──

test("W1-T4100: an unreadable state dir degrades reconciliation to 'nothing to heal', never a throw", () => {
  const dir = tmpDir();
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    const ceiling = 2000;
    writeFileSync(ledgerPath, "");
    padPast(ledgerPath, ceiling, 0);

    const unreadableDirDeps: LedgerArchiveStampFsDeps = {
      ...realStampFsDeps,
      readdirSync: () => {
        throw new Error("EACCES: permission denied");
      },
    };
    const result = rotateLedger(ledgerPath, { ceilingBytes: ceiling, archiveStampFsDeps: unreadableDirDeps });
    assert.equal(result.rotated, true, "an unreadable state dir must not block rotation — it degrades, never throws");
    assert.equal(archivesIn(dir).length, 1, "the rotation still lands a real archive despite readdir failing throughout");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T4100: an archive that vanishes between readdir and stat is skipped, not thrown, and left untouched", () => {
  const dir = tmpDir();
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    const ceiling = 2000;
    writeFileSync(ledgerPath, "");
    padPast(ledgerPath, ceiling, 0);

    const vanishingName = "ledger.2026-01-01T00-00-00-000Z.ndjson";
    const vanishingPath = join(dir, vanishingName);
    writeFileSync(vanishingPath, "old");

    const vanishingDeps: LedgerArchiveStampFsDeps = {
      ...realStampFsDeps,
      statMtimeMs: (path) => {
        if (path === vanishingPath) throw new Error("ENOENT: no such file or directory");
        return realStampFsDeps.statMtimeMs(path);
      },
    };
    const result = rotateLedger(ledgerPath, { ceilingBytes: ceiling, archiveStampFsDeps: vanishingDeps });
    assert.equal(result.rotated, true, "one unstattable archive must not block the rotation for every other file");
    assert.equal(
      readdirSync(dir).includes(vanishingName),
      true,
      "FALSIFIER: the skipped archive is left exactly as it was — never renamed, never deleted",
    );
    assert.equal(archivesIn(dir).length, 2, "the new archive still lands alongside the untouched one");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T4100: a rename the filesystem refuses leaves the stale name in place, unhealed but never thrown", () => {
  const dir = tmpDir();
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    const ceiling = 2000;
    writeFileSync(ledgerPath, "");
    padPast(ledgerPath, ceiling, 0);

    // A name well ahead of its own real (backdated) mtime — reconcileArchiveStamps must attempt
    // to heal this one, giving the injected rename failure something to refuse.
    const staleFutureName = "ledger.2027-01-01T00-00-00-000Z.ndjson.gz";
    const stalePath = join(dir, staleFutureName);
    writeFileSync(stalePath, Buffer.from("stale"));
    const realPastMs = Date.parse("2026-09-13T00:00:00.000Z");
    utimesSync(stalePath, new Date(realPastMs), new Date(realPastMs));

    const refusingRenameDeps: LedgerArchiveStampFsDeps = {
      ...realStampFsDeps,
      renameSync: () => {
        throw new Error("EACCES: rename refused");
      },
    };
    const result = rotateLedger(ledgerPath, { ceilingBytes: ceiling, archiveStampFsDeps: refusingRenameDeps });
    assert.equal(result.rotated, true, "a refused rename must not block the rotation itself");
    assert.equal(
      readdirSync(dir).includes(staleFutureName),
      true,
      "FALSIFIER: a rename the OS refuses leaves the old (unsafe) name on disk rather than throwing or deleting it",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T4100: an unstattable just-written archive is left named exactly as written, not thrown", () => {
  const dir = tmpDir();
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    const ceiling = 2000;
    writeFileSync(ledgerPath, "");
    padPast(ledgerPath, ceiling, 0);

    // No pre-existing archive shaped name exists yet, so reconcileArchiveStamps' own scan never
    // reaches statMtimeMs at all (only ledger.ndjson is on disk, and that name carries no
    // rotation stamp) — this throw is reached exclusively via healIfAheadOfOwnMtime's post-write
    // check on the archive this very rotation just wrote.
    const unstattableJustWrittenDeps: LedgerArchiveStampFsDeps = {
      ...realStampFsDeps,
      statMtimeMs: () => {
        throw new Error("ENOENT: cannot stat the archive just written");
      },
    };
    const result = rotateLedger(ledgerPath, { ceilingBytes: ceiling, archiveStampFsDeps: unstattableJustWrittenDeps });
    assert.equal(result.rotated, true, "an unstattable just-written archive must not block the rotation that wrote it");
    assert.ok(result.archivePath, "the rotation still names and returns the archive it wrote");
    assert.equal(
      readdirSync(dir).includes((result.archivePath as string).split("/").pop() as string),
      true,
      "FALSIFIER: the archive lands under exactly the name it was given — heal is skipped, not faked, when it cannot verify the file",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
