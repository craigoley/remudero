import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const NOW = 1_800_000_000_000;

function generation(publishedAtMs: number) {
  return { generation: 1, source: "inline" as const, publishedAtMs,
    settledAtMs: publishedAtMs, facts: { openPrViews: ["open-pr"] } };
}

test("W1-T13107: auto_triage.repair_snapshot_unavailable no longer recurs", async () => {
  // Keep the daemon seam dynamically resolved so this regression suite does not add
  // another static importer to the whole-tree affected-suite census.
  const daemonModule = "#src/cli/commands/" + "daemon.js";
  const [{ autoTriageRepairReadGeneration }, { fixedClock }, { DEPENDABOT_REPAIR_SNAPSHOT_MAX_AGE_MS }, { freezeReadGeneration }] = await Promise.all([
    import(daemonModule), import("#src/lib/clock.js"), import("#src/lib/dep-review.js"), import("#src/lib/read-plane.js"),
  ]);
  const lastPublished = generation(NOW - 1_000);
  const clock = fixedClock(NOW);

  // The live slot is empty during refresh; repair ordering can still use the bounded last publish.
  assert.equal(autoTriageRepairReadGeneration(undefined, lastPublished, undefined, clock), lastPublished);
  assert.equal(autoTriageRepairReadGeneration(undefined, generation(NOW - DEPENDABOT_REPAIR_SNAPSHOT_MAX_AGE_MS - 1),
    undefined, clock), undefined, "the fallback remains age bounded");
});

test("W1-T13107: the symptom is still recorded when its failure occurs", async () => {
  const taskModule = "#src/run-task" + ".js";
  const { daemonCommand } = await import(taskModule);
  const home = mkdtempSync(join(tmpdir(), "rmd-t13107-"));
  const root = join(home, "Remudero");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root }));
  const planPath = join(home, "tasks.yaml");
  writeFileSync(planPath, "[]\n");
  const priorHome = process.env.HOME;
  process.env.HOME = home;
  let repairSnapshot: (() => unknown) | undefined;
  try {
    const code = await daemonCommand(["--allow-self-target", "--plan", planPath, "--max", "0"], {
      buildAutoTriageHooks: (options) => {
        repairSnapshot = options?.repairSnapshot;
        return { checkAutoTriage: () => ({ fire: false as const, reason: "fixture" }), runAutoTriage: async () => {} };
      },
      runDaemon: async (_plan, _deps) =>
        ({ attempted: [], merged: [], stopReason: "stopped", costUsd: 0, ticks: 0 }),
    });
    assert.equal(code, 0);
    assert.equal(typeof repairSnapshot, "function");
    assert.equal(repairSnapshot!(), undefined);
    const ledger = join(root, "state", "ledger.ndjson");
    const rows = (existsSync(ledger) ? readFileSync(ledger, "utf8") : "").split("\n").filter(Boolean)
      .map(line => JSON.parse(line));
    assert.deepEqual(rows.filter(row => row.step === "auto_triage.repair_snapshot_unavailable").map(row => row.reasonCode),
      ["unpublished-generation"]);
  } finally {
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    rmSync(home, { recursive: true, force: true });
  }
});
