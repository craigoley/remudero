import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { decideCashTrial } from "#src/lib/cash-trial.js";
import type { Config } from "#src/lib/config.js";
import { ledgerCarriedPrefixPath, ledgerRetainedStepsPath } from "#src/lib/ledger.js";
import { ledgerLivePath } from "#src/lib/ledger-union.js";

const docsTask = { id: "T-DOCS", type: "implement", risk: "low", files: ["docs/guide.md"] };
const SHA = "a".repeat(64);

// Supplied fixture policy only: no live policy read, no billed call.
function config(): Config {
  return {
    claudeBin: "/bin/true",
    root: "/tmp",
    dailyCapUsd: 25,
    workerProviders: { enabled: ["claude", "cash"], harnessCommitsImplement: true, cashTrial: { sharePercent: 100 } },
  } as Config;
}

function stateDirWithLive(): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-cash-trial-metadata-"));
  const old = Array.from({ length: 5 }, (_, i) => [
    { ts: "2026-09-01T01:00:00Z", run_id: `old-${i}`, step: "worker.assignment", worker_assignment: { id: `old-id-${i}`, routing: { decision: { trial: "cash-simple", trialArm: "cash" } } } },
    { ts: "2026-09-01T02:00:00Z", run_id: `old-${i}`, step: "verdict", verdict: "no_pr", selection_assignment_id: `old-id-${i}`, cost_usd: 0.1 },
  ]).flat();
  writeFileSync(ledgerLivePath(dir), old.map((row) => JSON.stringify(row)).join("\n") + "\n");
  return dir;
}

const decide = (stateDir: string) =>
  decideCashTrial({ task: docsTask, taskClass: "docs", config: config(), harnessCommits: true, stateDir, today: "2026-09-25" });

test("cash trial evidence tolerates valid metadata but refuses unknown corpus gaps", () => {
  const dir = stateDirWithLive();
  try {
    const live = ledgerLivePath(dir);
    writeFileSync(ledgerCarriedPrefixPath(live), JSON.stringify({ bytes: 93, sha256: SHA, rateBytesPerHour: 1.5, effectiveCeilingBytes: 1000, core: {} }));
    writeFileSync(ledgerRetainedStepsPath(live), JSON.stringify({ steps: ["verdict"], lastFullRotationMs: 1 }));
    assert.equal(decide(dir)?.arm, "cash", "valid producer metadata alone does not make spend evidence unavailable");

    writeFileSync(join(dir, "ledger.ndjson.bak"), "old backup\n");
    const backup = decide(dir);
    assert.equal(backup?.arm, "held", "an unknown backup is still a corpus gap");
    assert.match(backup!.reason, /unreadable|incomplete/);
    rmSync(join(dir, "ledger.ndjson.bak"));

    writeFileSync(ledgerCarriedPrefixPath(live), "{not json");
    const corrupt = decide(dir);
    assert.equal(corrupt?.arm, "held", "corrupt metadata is not classified, so it is still a gap");
    assert.match(corrupt!.reason, /unreadable|incomplete/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
