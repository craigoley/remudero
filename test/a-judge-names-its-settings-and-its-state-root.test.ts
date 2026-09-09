/**
 * A JUDGE'S SETTINGS FILE AND STATE ROOT ARE PART OF ITS WIRING.
 *
 * Both judges merged on 2026-09-09 were unreachable in production and their suites were green,
 * because every test injected a fake `judge` and a fake `stageProposal`. The seams were correct and
 * proved nothing about the real path. MEASURED on the first real sweep: 0 of 56 shards judged, all
 * 56 refused with "worker settings must define `sandbox`", and all 56 staged proposals written to a
 * lane rather than to the state root the ledger uses.
 *
 * These tests exercise what an injected seam skips: the settings file the command actually names,
 * and the directory a staged proposal actually lands in.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { gitRepo } from "./helpers/git-repo.js";
import { validateWorkerSettingsFile } from "../src/lib/settings.js";
import { verifyHumanSweepCommand } from "../src/run-task.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("the file a judge spawn names VALIDATES as worker settings, and the one it used to name does not", () => {
  // The positive control and the defect, side by side. `.claude/settings.json` is the
  // interactive-lane deny floor — its own header says a worker never reads it — and it defines no
  // `sandbox`, so every spawn built from it was refused before it ran.
  assert.doesNotThrow(
    () => validateWorkerSettingsFile(join(REPO_ROOT, "settings", "worker.json")),
    "settings/worker.json must validate — it is what a real spawn renders from",
  );
  assert.throws(
    () => validateWorkerSettingsFile(join(REPO_ROOT, ".claude", "settings.json")),
    /sandbox/,
    "and the file both judges used to name must still be refused, or this test proves nothing",
  );
});

test("no judge spawn in run-task.ts names the interactive deny floor as its settings file", () => {
  const src = readFileSync(join(REPO_ROOT, "src", "run-task.ts"), "utf8");
  assert.doesNotMatch(
    src,
    /settingsFile: join\(root, "\.claude", "settings\.json"\)/,
    "a spawn built from the deny floor is refused for want of `sandbox` — see the sibling test",
  );
});

test("a staged proposal lands under the STATE root, the same root the ledger uses", async () => {
  // The defect this replaces: `ledgerPathFor(config)` resolves under `config.root` while the
  // registry was built from `root` (the CHECKOUT), so a decision's two halves landed in two
  // directories and nothing reached the inbox an operator reads.
  const state = gitRepo({ kind: "t-judgepaths-state" });
  const checkout = gitRepo({ kind: "t-judgepaths-checkout" });
  mkdirSync(join(checkout.dir, "plan"), { recursive: true });
  writeFileSync(
    join(checkout.dir, "plan", "tasks.yaml"),
    "- id: W1-T1\n  title: parked\n  repo: remudero\n  type: implement\n  verify: human\n  status: queued\n  depends_on: []\n",
  );

  mkdirSync(join(checkout.dir, ".remudero"), { recursive: true });
  copyFileSync(join(REPO_ROOT, ".remudero", "mounts.yaml"), join(checkout.dir, ".remudero", "mounts.yaml"));

  const code = await verifyHumanSweepCommand([], {
    root: checkout.dir,
    config: { root: state.dir } as never,
    // A stub router that stages exactly one proposal, so the only question this test asks is
    // WHERE the registry write lands — never what the judge decided.
    route: (async (_shards: unknown, deps: { stageProposal: (p: unknown) => void }) => {
      deps.stageProposal({ id: "verify-human:W1-T1", summary: "s", evidenceAnchors: [] } as never);
      return { judged: 1, needsOperator: ["W1-T1"], backlog: [], skipped: [] };
    }) as never,
  });

  assert.equal(code, 0);
  assert.ok(
    existsSync(join(state.dir, "state", "inbox-proposals.json")),
    "the proposal must land under the STATE root, where the inbox reads it",
  );
  assert.ok(
    !existsSync(join(checkout.dir, "state", "inbox-proposals.json")),
    "and NOT under the checkout — that split is what sent 56 proposals to a lane nobody reads",
  );
});

test("ruleCommand resolves its ledger through ledgerPathFor, never a hardcoded filename", () => {
  // It wrote to `ledger.jsonl`; the real file is `ledger.ndjson` and `ledgerPathFor` owns that name,
  // so a hardcoded spelling writes to a file nothing reads and survives a rename silently.
  const src = readFileSync(join(REPO_ROOT, "src", "run-task.ts"), "utf8");
  assert.doesNotMatch(
    src,
    /const ledgerPath = join\(root, "state", "ledger\.jsonl"\)/,
    "the ledger filename belongs to ledgerPathFor, not to a call site",
  );
});
