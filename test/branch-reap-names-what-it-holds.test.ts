import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DECLARED_BRANCH_GUARDS, reapBranchesCommand } from "../src/run-task.js";

const branchNames = ["main", "needs-review", "closed-unmerged"];

function runReaper() {
  const dir = mkdtempSync(join(tmpdir(), "rmd-branch-reap-names-"));
  const ledgerPath = join(dir, "ledger.ndjson");
  const calls: string[][] = [];
  const output: string[] = [];
  const realLog = console.log;
  console.log = (...args: unknown[]) => output.push(args.map(String).join(" "));
  const exec = (cmd: string, args: string[]): string => {
    calls.push([cmd, ...args]);
    if (args[0] === "ls-remote") return branchNames.map((name, i) => `${i + 1}\trefs/heads/${name}`).join("\n") + "\n";
    if (args[0] === "merge-base") {
      if (args[2] === "origin/main") return "";
      throw new Error("not an ancestor");
    }
    if (args[0] === "rev-parse") return "deadbeef\n";
    if (args[0] === "grep" && args.includes("-o")) {
      return DECLARED_BRANCH_GUARDS.map((name) => `src/run-task.ts:1:${name}`).join("\n");
    }
    if (args[0] === "grep") throw new Error("no source match");
    if (cmd === "gh") {
      const endpoint = args[1] ?? "";
      if (endpoint.includes("closed-unmerged")) return "closed\tfalse\n";
      if (endpoint.includes("pulls?state=open")) return "";
      return "";
    }
    return "";
  };

  try {
    const code = reapBranchesCommand([], { exec, ledgerPath });
    const rows = readFileSync(ledgerPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    return { code, calls, output: output.join("\n"), row: rows.find((row) => row.step === "branch_reap.dry_run") };
  } finally {
    console.log = realLog;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("W1-T2445: the reaper prints the names it holds", () => {
  const result = runReaper();
  assert.equal(result.code, 0);
  assert.match(result.output, /held branches:/);
  assert.match(result.output, /needs-review/);
  assert.match(result.output, /no PR ever opened/);
});

test("W1-T2445: the dry-run row carries a reason for every branch", () => {
  const result = runReaper();
  assert.ok(result.row);
  assert.deepEqual(Object.keys(result.row.reasons as Record<string, unknown>).sort(), branchNames.sort());
  assert.equal((result.row.reasons as Record<string, unknown>)["needs-review"], "no_pr_ever");
});

test("W1-T2445: closed_unmerged reaches the ledger as a reason and not a tally", () => {
  const result = runReaper();
  assert.equal((result.row?.reasons as Record<string, unknown>)["closed-unmerged"], "closed_unmerged");
  assert.deepEqual(result.row?.held_branches, ["needs-review"]);
});

test("W1-T2445: reporting the names does not add a deletion path", () => {
  const result = runReaper();
  const destructive = result.calls.filter((call) =>
    call.includes("--delete") || call.includes("refs/heads/") && call.includes("push") || call.includes("-D") || call.includes("--force"),
  );
  assert.deepEqual(destructive, []);
});
