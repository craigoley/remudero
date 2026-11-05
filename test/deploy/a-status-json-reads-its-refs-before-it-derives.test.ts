import assert from "node:assert/strict";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import type { Config } from "#src/lib/config.js";
import { statusCommand } from "#src/lib/report-commands.js";
import { buildStatusBoard } from "#src/lib/status-board.js";
import { withTempDir } from "#src/lib/tmp.js";

const SHA = "a".repeat(40);
const BUDGET_MS = 400;

/** A git that answers the four status ref reads at once; `claimsFail` makes the dispatch-claim read exit 1. */
function writeGit(bin: string, claimsFail: boolean): void {
  writeFileSync(join(bin, "git"), [
    "#!/bin/sh",
    '[ "$1" = "-C" ] && shift 2',
    'case "$*" in',
    `  "rev-parse origin/main") echo ${SHA} ;;`,
    `  "ls-remote --heads origin run-*") printf '${SHA}\\trefs/heads/run-W1-T42-1793000000000\\n' ;;`,
    claimsFail
      ? '  "ls-remote origin refs/rmd-dispatch/*") exit 1 ;;'
      : `  "ls-remote origin refs/rmd-dispatch/*") printf '${SHA}\\trefs/rmd-dispatch/W1-T42\\n' ;;`,
    "  *) exit 0 ;;",
    "esac",
    "",
  ].join("\n"));
  chmodSync(join(bin, "git"), 0o755);
}

/** Status JSON whose board spends longer than the whole external-read budget deriving before it reads any ref. */
async function statusWithSlowDerivation(claimsFail: boolean): Promise<Record<string, any>> {
  return withTempDir("status-refs-prefetch", async (root) => {
    const bin = join(root, "bin");
    const repo = join(root, "repo");
    mkdirSync(bin);
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(join(repo, "plan"));
    writeFileSync(join(repo, "plan", "tasks.yaml"), "[]\n");
    writeGit(bin, claimsFail);
    const oldPath = process.env.PATH;
    process.env.PATH = `${bin}:${oldPath ?? ""}`;
    const lines: string[] = [];
    try {
      const rc = await statusCommand(["--json"], {
        loadConfig: () => ({ root } as Config),
        queryService: () => ({ running: false, pid: null }),
        ledgerPathFor: () => join(root, "absent.ndjson"),
        readLedgerLines: () => [],
        repoRoot: repo,
        github: null,
        jsonDeadlineMs: BUDGET_MS,
        buildStatusBoard: (boardRoot, ledgerPath, deps) => {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, BUDGET_MS + 300);
          return buildStatusBoard(boardRoot, ledgerPath, deps);
        },
        out: (line) => lines.push(line),
      });
      assert.equal(rc, 0);
      return JSON.parse(lines[0]!) as Record<string, any>;
    } finally {
      process.env.PATH = oldPath;
    }
  });
}

test("W1-T11325 criterion 1: status JSON reports its four refs although local derivation outlasts the budget", async () => {
  const json = await statusWithSlowDerivation(false);
  for (const name of ["originMainSha", "runBranches", "sharedPause", "dispatchClaims"]) {
    assert.equal(json.externalReads[name], undefined, `${name} read before the budget ran out`);
  }
  assert.doesNotMatch(json.queueHead.unknownReason ?? "", /run-branch lookup unavailable/);
  const names = json.latches.rows.map((row: { name: string }) => row.name);
  assert.ok(names.includes("dispatch-claim:W1-T42"), "the held claim the fake origin serves is reported");
  assert.ok(!names.includes("DISPATCH_CLAIMS"), "the claim read is not reported unreachable");
});

test("W1-T11325 criterion 1: a failing prefetched read still records its own reason, not the deadline", async () => {
  const json = await statusWithSlowDerivation(true);
  assert.deepEqual(json.externalReads.dispatchClaims, { status: "unavailable", reason: "read-failed" });
  assert.equal(json.externalReads.runBranches, undefined);
  assert.equal(json.externalReads.originMainSha, undefined);
});
