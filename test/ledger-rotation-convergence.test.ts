import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DECISION_RELEVANT_LEDGER_STEPS,
  HEALTH_STEP_RETENTION_WINDOW_MS,
  MAX_RETAINED_LINES_PER_STEP,
  appendLedger,
  ledgerExceedsRotationCeiling,
  rotateLedger,
  type LedgerLine,
} from "../src/lib/ledger.js";
import { assessBootHealth, countLedgerBootsAfter } from "../src/lib/deployer.js";

// ── W1-T244 (feedback fb-1784769525147-13afc6, OBSERVED LIVE 2026-07-23): W1-T209's rotation
// existed but violated an invariant it never stated — AFTER ANY ROTATION THE LIVE LEDGER MUST
// BE STRICTLY BELOW THE ROTATION CEILING, or rotation cannot terminate. Observed live: the
// retained decision-relevant core alone exceeded the 4MiB ceiling, so EVERY append re-rotated —
// 80+ archive files, bursts of 12 rotations/second, a truncated live ledger. A SECOND, COUPLED
// defect: `daemon.boot` was absent from the retained set, so a boot heartbeat was archived
// MID-HEALTH-WINDOW, assessBootHealth returned a false negative, and a healthy deploy was
// rolled back. This file proves both fixes: the convergence invariant (with the bounded-
// retention pipeline in ledger.ts's rotateLedger) and daemon.boot/deploy.* survival within the
// health window. ────────────────────────────────────────────────────────────────────────────

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "rmd-ledger-rotation-convergence-"));
}

/** Builds one raw ledger line with an EXPLICIT `ts` — bypasses appendLedger's own clock so a
 *  test can place lines precisely in the past/present relative to `rotateLedger`'s `now`. */
function rawLine(step: string, taskId: string, tsMs: number, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ts: new Date(tsMs).toISOString(),
    run_id: `${step}-${taskId}-${tsMs}`,
    task_id: taskId,
    step,
    ...extra,
  });
}

function archivesIn(dir: string): string[] {
  return readdirSync(dir).filter((f) => f !== "ledger.ndjson");
}

test("CONVERGENCE — with the retained core bloated past the rotation ceiling, a single append triggers exactly one rotation and the live ledger ends strictly below the ceiling", () => {
  const dir = tmpDir();
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    const ceiling = 6000;
    const base = Date.now() - 3_600_000; // an hour in the past — comfortably "old"

    // Bloat the retained core the REAL way: many DIFFERENT tasks' run.start lines — this is
    // exactly W1-T244's own root cause (every run appends more, unbounded, over enough runs).
    const bloat: string[] = [];
    for (let i = 0; i < 400; i++) bloat.push(rawLine("run.start", `W1-BLOAT-${i}`, base + i));
    writeFileSync(ledgerPath, bloat.join("\n") + "\n");
    assert.ok(
      statSync(ledgerPath).size > ceiling,
      "sanity: the retained-core-only content already exceeds the ceiling before any append",
    );

    // ONE real appendLedger call — the actual production trigger — must converge in one shot.
    appendLedger(ledgerPath, { run_id: "trigger", task_id: "W1-TRIGGER", step: "run.start" } as LedgerLine, {
      ceilingBytes: ceiling,
    });

    assert.equal(
      ledgerExceedsRotationCeiling(ledgerPath, ceiling),
      false,
      "THE CONVERGENCE INVARIANT: post-rotation the live ledger must be strictly below the ceiling",
    );
    assert.equal(archivesIn(dir).length, 1, "exactly one rotation occurred for the append that crossed the ceiling");

    // FALSIFIER, tight form: before this fix, rotation made no size progress at all (the
    // retained core stayed permanently over the ceiling), so the VERY NEXT append after a
    // rotation would ALSO exceed the ceiling and re-rotate. The convergence invariant just
    // proved above (live strictly < ceiling) guarantees a single small append cannot immediately
    // cross back over — assert that directly, deterministically, with no timing/size guesswork.
    appendLedger(ledgerPath, { run_id: "after-0", task_id: "W1-TRIGGER", step: "run.start" } as LedgerLine, {
      ceilingBytes: ceiling,
    });
    assert.equal(
      archivesIn(dir).length,
      1,
      "FALSIFIER: the append immediately after a converged rotation must not itself re-rotate",
    );

    // FALSIFIER, loose form: before this fix, EVERY one of these appends would have re-rotated
    // (11 appends -> 11 rotations, matching the observed live incident's 12-rotations/second
    // burst). Ten more small appends must trigger FAR fewer than ten more rotations — the
    // ledger keeps growing for real (eventually re-crossing the ceiling is expected and fine),
    // but it must not be 1:1 with appends.
    for (let i = 1; i < 10; i++) {
      appendLedger(ledgerPath, { run_id: `after-${i}`, task_id: "W1-TRIGGER", step: "run.start" } as LedgerLine, {
        ceilingBytes: ceiling,
      });
    }
    assert.ok(
      archivesIn(dir).length <= 4,
      `FALSIFIER: ten more small appends produced ${archivesIn(dir).length} total rotations — a divergent, non-converging ` +
        `rotation would produce one PER append (11)`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CONVERGENCE — when the retained core alone would exceed the ceiling, the oldest retained lines are shed to the archive with an archived-pointer line left behind", () => {
  const dir = tmpDir();
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    const ceiling = 6000;
    const oldBase = Date.now() - 3_600_000;
    const newBase = Date.now() - 1_000;

    const oldLines: string[] = [];
    for (let i = 0; i < 300; i++) oldLines.push(rawLine("run.start", `W1-OLD-${i}`, oldBase + i));
    const newLines: string[] = [];
    for (let i = 0; i < 5; i++) newLines.push(rawLine("verdict.merged", `W1-NEW-${i}`, newBase + i, { pr_url: `https://x/${i}` }));

    writeFileSync(ledgerPath, [...oldLines, ...newLines].join("\n") + "\n");
    assert.ok(ledgerExceedsRotationCeiling(ledgerPath, ceiling), "sanity: padded past the ceiling");

    const result = rotateLedger(ledgerPath, { ceilingBytes: ceiling });
    assert.equal(result.rotated, true);
    assert.ok(result.archivePath, "a rotation that sheds must still name the archive it wrote");

    const liveContent = readFileSync(ledgerPath, "utf8");
    const liveLines = liveContent
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);

    const pointer = liveLines.find((l) => l.step === "ledger.rotation_shed");
    assert.ok(pointer, "a rotation that sheds retained lines must leave a pointer line behind, not just silently drop them");
    assert.ok((pointer!.shed_count as number) > 0, "the pointer records how many lines were shed");
    assert.equal(pointer!.archive_path, result.archivePath, "the pointer names the SAME archive the rest of history went to");

    // At least the single OLDEST line (W1-OLD-0) must be gone from live — proves shedding
    // actually happened against the oldest end, not just a no-op that left everything in place.
    const survivingOld0 = liveLines.some((l) => l.task_id === "W1-OLD-0");
    assert.equal(survivingOld0, false, "the very oldest retained line is shed, not kept in an over-ceiling loop");

    // At least the single NEWEST line (W1-NEW-4) must survive — shedding targets the oldest
    // end, never the newest, however far the eviction has to reach.
    const survivingNewest = liveLines.some((l) => l.task_id === "W1-NEW-4");
    assert.equal(survivingNewest, true, "the newest retained line survives — shedding never reaches past it while older lines remain");

    // THE GENERAL ORDERING INVARIANT: diff live vs. archive to find every SHED line (present
    // pre-rotation, absent post-rotation) and every SURVIVING decision line, then assert no
    // shed line is newer than any surviving one — "oldest first," proven structurally rather
    // than by hardcoding one exact boundary count (which would be a brittle byte-budget guess).
    const archiveContent = readFileSync(result.archivePath as string, "utf8");
    assert.ok(archiveContent.includes("W1-OLD-0"), "every pre-rotation line, including shed ones, is preserved verbatim in the archive");
    const archiveLines = archiveContent
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const survivingKeys = new Set(liveLines.filter((l) => l.step !== "ledger.rotation_shed").map((l) => l.run_id as string));
    const shedTsMs = archiveLines
      .filter((l) => !survivingKeys.has(l.run_id as string))
      .map((l) => Date.parse(l.ts as string));
    const survivingTsMs = liveLines
      .filter((l) => l.step !== "ledger.rotation_shed")
      .map((l) => Date.parse(l.ts as string));
    assert.ok(shedTsMs.length > 0 && survivingTsMs.length > 0, "sanity: both a shed set and a surviving set exist");
    assert.ok(
      Math.max(...shedTsMs) <= Math.min(...survivingTsMs),
      "every shed line is older than every surviving line — the oldest-first invariant",
    );

    assert.equal(
      ledgerExceedsRotationCeiling(ledgerPath, ceiling),
      false,
      "shedding must actually bring the live ledger back under the ceiling",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("BOUNDED RETENTION — only the latest sweep.disposed per pr@head survives rotation, and per-step retention is capped", () => {
  const dir = tmpDir();
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    const base = Date.now() - 600_000;

    // A still-open PR at a fixed head re-disposed on every sweep poll (the real-world source
    // of sweep.disposed bloat): one genuine acted:true line buried among many acted:false
    // no-op re-polls for the SAME pr@head.
    const prNumber = 42;
    const headSha = "deadbeef";
    const dupLines: string[] = [];
    for (let i = 0; i < 40; i++) {
      const acted = i === 10; // the ONE real action, not the first and not the last
      dupLines.push(
        rawLine("sweep.disposed", "W1-SWEPT", base + i, {
          pr_number: prNumber,
          head_sha: headSha,
          disposition: "mergeable",
          acted,
        }),
      );
    }

    // Per-step cap: far more run.start lines than MAX_RETAINED_LINES_PER_STEP, distinct
    // task ids, increasing ts — only the newest MAX_RETAINED_LINES_PER_STEP may survive.
    const capLines: string[] = [];
    const capCount = MAX_RETAINED_LINES_PER_STEP + 400;
    for (let i = 0; i < capCount; i++) capLines.push(rawLine("run.start", `W1-CAP-${i}`, base + 1000 + i));

    writeFileSync(ledgerPath, [...dupLines, ...capLines].join("\n") + "\n");

    // A ceiling BELOW the raw (unbounded) size — forcing rotation — but comfortably ABOVE what
    // the dedup+cap mechanisms alone retain (1 sweep line + MAX_RETAINED_LINES_PER_STEP run.start
    // lines), so the final convergence-shed safety valve never fires here — this test isolates
    // the DEDUP/CAP mechanisms themselves (the dedicated shed test above covers the shed
    // pointer/ordering behavior on its own).
    const ceiling = 50_000;
    assert.ok(statSync(ledgerPath).size > ceiling, "sanity: raw content exceeds the ceiling before dedup/cap");
    const result = rotateLedger(ledgerPath, { ceilingBytes: ceiling });
    assert.equal(result.rotated, true);

    const liveLines = readFileSync(ledgerPath, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);

    const sweptSurvivors = liveLines.filter((l) => l.step === "sweep.disposed" && l.task_id === "W1-SWEPT");
    assert.equal(sweptSurvivors.length, 1, "only ONE sweep.disposed line per pr@head survives — every re-poll duplicate is archived");
    assert.equal(sweptSurvivors[0]!.acted, true, "the surviving line is the acted:true evidence line, never a redundant acted:false re-poll");

    assert.ok(
      !liveLines.some((l) => l.step === "ledger.rotation_shed"),
      "sanity: the dedup+cap mechanisms alone keep this under ceiling — the shed safety valve must not have fired",
    );

    const capSurvivors = liveLines.filter((l) => l.step === "run.start" && typeof l.task_id === "string" && (l.task_id as string).startsWith("W1-CAP-"));
    assert.equal(capSurvivors.length, MAX_RETAINED_LINES_PER_STEP, "per-step retention is capped at MAX_RETAINED_LINES_PER_STEP");
    const survivingIndices = capSurvivors.map((l) => Number((l.task_id as string).replace("W1-CAP-", "")));
    const oldestSurviving = Math.min(...survivingIndices);
    assert.equal(
      oldestSurviving,
      capCount - MAX_RETAINED_LINES_PER_STEP,
      "the cap keeps the NEWEST lines and archives the oldest excess, never the reverse",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("HEALTH RETENTION — daemon.boot and deploy.* lines within the health window survive rotation, and assessBootHealth reads identically before and after", () => {
  const dir = tmpDir();
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    const kickstartMs = Date.now() - 30_000; // "kickstart" happened 30s ago
    const freshBootMs = kickstartMs + 5_000; // a fresh boot 5s after kickstart — inside any real health window
    const staleBootMs = Date.now() - (HEALTH_STEP_RETENTION_WINDOW_MS + 60_000); // long expired

    const lines: string[] = [
      rawLine("daemon.boot", "W1-DAEMON", staleBootMs, { env_clean: true }),
      rawLine("daemon.boot", "W1-DAEMON", freshBootMs, { env_clean: true }),
      rawLine("deploy.kickstart", "W1-DAEMON", kickstartMs, { to: "abc1234" }),
      rawLine("deploy.ok", "W1-DAEMON", freshBootMs, { to: "abc1234" }),
    ];
    // Pad with noise past the ceiling so rotation actually fires.
    for (let i = 0; i < 300; i++) {
      lines.push(JSON.stringify({ ts: new Date(freshBootMs).toISOString(), step: "ci.polling", run_id: `n${i}`, task_id: "W1-NOISE", detail: "x".repeat(64) }));
    }
    writeFileSync(ledgerPath, lines.join("\n") + "\n");

    const ceiling = 2000;
    assert.ok(ledgerExceedsRotationCeiling(ledgerPath, ceiling), "sanity: padded past the ceiling");

    const beforeBoots = countLedgerBootsAfter(ledgerPath, kickstartMs);
    const beforeHealth = assessBootHealth({ bootObserved: beforeBoots > 0, crashCount: 0 });
    assert.equal(beforeHealth.healthy, true, "sanity: a fresh boot after kickstart reads healthy before rotation");

    const result = rotateLedger(ledgerPath, { ceilingBytes: ceiling, now: () => new Date(freshBootMs + 1000) });
    assert.equal(result.rotated, true);

    const afterBoots = countLedgerBootsAfter(ledgerPath, kickstartMs);
    const afterHealth = assessBootHealth({ bootObserved: afterBoots > 0, crashCount: 0 });

    assert.equal(
      afterHealth.healthy,
      beforeHealth.healthy,
      "assessBootHealth must read IDENTICALLY before and after rotation — the false-negative that rolled back a healthy deploy must not recur",
    );
    assert.equal(afterBoots, beforeBoots, "the fresh daemon.boot heartbeat inside the health window survives rotation unchanged");

    const liveContent = readFileSync(ledgerPath, "utf8");
    assert.ok(liveContent.includes("deploy.kickstart"), "deploy.* lines inside the health window survive rotation too");
    assert.ok(liveContent.includes("deploy.ok"));
    assert.ok(
      !liveContent.includes(new Date(staleBootMs).toISOString()),
      "a daemon.boot line long outside the health window is archived, not retained forever (bounds restart-storm growth)",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Sanity: DECISION_RELEVANT_LEDGER_STEPS itself names daemon.boot (W1-T244's literal ask). ──
test("DECISION_RELEVANT_LEDGER_STEPS includes daemon.boot", () => {
  assert.ok(DECISION_RELEVANT_LEDGER_STEPS.has("daemon.boot"));
});
