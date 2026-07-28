import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Plan, Task } from "../src/lib/plan.js";
import { buildBatchedGithub, ghGateway, projectPlan } from "../src/lib/status.js";
import { daemonCommand } from "../src/run-task.js";

/**
 * The daemon's merged-status projection (run-task.ts `daemonCommand` -> `refreshMerged`) must
 * answer from the SINGLE non-search `gh pr list` batch, never from GitHub's GraphQL `search()`
 * connection.
 *
 * WHY THIS FILE EXISTS: with `search()` throttled account-wide, `ghGateway.findMergedByTrailer`
 * (a `--search` query) fails, `tryJson` sets the gateway's sticky `failed` flag, and
 * `deriveStatus`'s `readFailed()` gate then discards the DEFINITIVE negative that the
 * SUCCESSFUL non-search head-branch batch had already produced -- so every task derived
 * `indeterminate` and the daemon dispatched nothing. `buildBatchedGithub` answers both
 * questions client-side from one fetch, so no `--search` argv is ever constructed.
 *
 * Both gateways expose the SAME `opts.exec` seam, so one throwing-on-`--search` fake drives
 * every case below without a network round-trip.
 */
function task(over: Partial<Task> = {}): Task {
  return {
    id: "W1-TX",
    title: "t",
    repo: "remudero",
    depends_on: [],
    type: "implement",
    risk: "medium",
    verify: "auto",
    status: "queued", // decorative -- deriveStatus must NOT trust this
    attempts: 0,
    ...over,
  };
}

/** An empty ledger: no `pr.opened`, no `pr:` field, so rungs (a)/(b) cannot answer -- the exact
 *  shape of the never-dispatched queued tasks this change exists to unjam. */
function emptyLedger(): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-daemon-gw-"));
  const p = join(dir, "ledger.ndjson");
  writeFileSync(p, "");
  return p;
}

/** One merged PR carrying BOTH the anchored trailer and an owned `run-<taskId>-*` head ref, as
 *  the real `gh pr list --state all --json ...` payload the batched gateway parses. */
const MERGED_PR_JSON = JSON.stringify([
  {
    number: 777,
    url: "https://github.com/o/r/pull/777",
    state: "MERGED",
    headRefName: "run-W1-T262-1784913918134",
    body: "work\nRemudero-Task: W1-T262\n",
    title: "t",
  },
]);

/** Records every argv the gateway constructs, and REFUSES any `--search` query the way the
 *  throttled GraphQL `search()` connection does (HTTP 200 + an error `gh` surfaces as a throw). */
function searchRefusingExec(argvLog: string[][]): (args: string[]) => string {
  return (args: string[]) => {
    argvLog.push(args);
    if (args.includes("--search")) {
      throw new Error("GraphQL: API rate limit already exceeded for user ID 4397075.");
    }
    if (args[0] === "pr" && args[1] === "list") return MERGED_PR_JSON;
    return "[]";
  };
}

function onePlan(id: string): Plan {
  const tasks: Task[] = [task({ id })];
  return { tasks, byId: new Map(tasks.map((t) => [t.id, t])) };
}

test("daemonCommand derives its merged-status projection from a gateway that builds NO --search argv", async () => {
  // loadConfig() takes no injection and reads $HOME, so redirect HOME at a throwaway dir: the
  // REAL daemonCommand then runs against tmp state, never the live daemon's root or drain lock.
  // --dry-run calls refreshMerged() and returns BEFORE any lock, spawn, or sweep -- so this
  // covers the real gateway wiring with zero spawns. The injected factory keeps it off the wire.
  const home = mkdtempSync(join(tmpdir(), "rmd-daemon-gw-cmd-"));
  const oldHome = process.env.HOME;
  const root = join(home, "Remudero");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root }));
  mkdirSync(join(root, "state"), { recursive: true });
  const planPath = join(home, "tasks.yaml");
  writeFileSync(planPath, "[]\n");
  process.env.HOME = home;

  const argvLog: string[][] = [];
  const seen: Array<{ owner: string; repo: string }> = [];
  try {
    const code = await daemonCommand(["--allow-self-target", "--plan", planPath, "--dry-run"], {
      githubFactory: (owner, repo) => {
        seen.push({ owner, repo });
        return buildBatchedGithub(owner, repo, { exec: searchRefusingExec(argvLog) });
      },
    });
    assert.equal(code, 0, "--dry-run previews and returns clean");
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }

  assert.equal(seen.length, 1, "refreshMerged built exactly ONE gateway for the projection");
  assert.equal(
    argvLog.filter((a) => a.includes("--search")).length,
    0,
    "the daemon's projection constructs NO --search argv -- the throttled path is never touched",
  );
});

test("the batched projection gateway credits a merged task while every --search is refused", () => {
  const argvLog: string[][] = [];
  const github = buildBatchedGithub("o", "r", { exec: searchRefusingExec(argvLog) });

  const proj = projectPlan(onePlan("W1-T262"), { ledgerPath: emptyLedger(), github }).get("W1-T262");

  assert.equal(proj?.merged, true, "the merged, owned, anchored PR is credited from the batch");
  assert.equal(proj?.prNumber, 777);
  assert.notEqual(proj?.indeterminate, true, "a working non-search read must never defer");
  assert.equal(argvLog.filter((a) => a.includes("--search")).length, 0);
});

test("the batched projection gateway reports a genuine none, not indeterminate, when search is refused", () => {
  const github = buildBatchedGithub("o", "r", { exec: searchRefusingExec([]) });

  // W1-T999 owns neither the trailer nor a run- head ref: the batch answers this DEFINITIVELY.
  const proj = projectPlan(onePlan("W1-T999"), { ledgerPath: emptyLedger(), github }).get("W1-T999");

  assert.equal(proj?.merged, false);
  assert.equal(proj?.source, "none", "a definitive negative, never a deferral");
  assert.notEqual(proj?.indeterminate, true, "an uncredited task stays DISPATCHABLE under a search throttle");
});

test("falsifier: the pre-change ghGateway degrades the SAME task to indeterminate under the SAME refused search", () => {
  const argvLog: string[][] = [];
  const github = ghGateway("o", "r", { exec: searchRefusingExec(argvLog) });

  const proj = projectPlan(onePlan("W1-T999"), { ledgerPath: emptyLedger(), github }).get("W1-T999");

  // This is the jam: the non-search head-branch batch succeeded and said "no merged PR owns
  // run-W1-T999-*", but the refused trailer --search poisoned readFailed() and that definitive
  // negative was discarded -- so the daemon skipped the task every tick.
  assert.equal(proj?.indeterminate, true, "ghGateway defers -- the behaviour this change replaces");
  assert.ok(
    argvLog.some((a) => a.includes("--search")),
    "and it got there by constructing a --search argv the batched gateway never builds",
  );
});
