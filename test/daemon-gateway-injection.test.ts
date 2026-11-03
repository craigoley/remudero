import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { DaemonDeps, DaemonSummary } from "#src/lib/daemon.js";
import type { Plan, Task } from "#src/lib/plan.js";
import { buildBatchedGithub, ghGateway, projectPlan, type GitHub, type PrRef } from "#src/lib/status.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { daemonCommand } from "#src/run-task.js";
import { ghShim } from "#test/helpers/gh-shim.js";
import { gitRepo } from "#test/helpers/git-repo.js";

/**
 * The daemon's merged-status projection (run-task.ts `daemonCommand` -> `refreshMerged`) must
 * answer from the SINGLE non-search `gh pr list` batch, never from GitHub's search surface.
 *
 * WHY THIS FILE EXISTS: with search throttled account-wide, `ghGateway.findMergedByTrailer`
 * (a search query — W1-T523: `gh api search/issues?q=…`, REST; before it, GraphQL's `search()`
 * connection) fails, `tryJson` sets the gateway's sticky `failed` flag, and `deriveStatus`'s
 * `readFailed()` gate then discards the DEFINITIVE negative that the SUCCESSFUL non-search
 * head-branch batch had already produced -- so every task derived `indeterminate` and the daemon
 * dispatched nothing. `buildBatchedGithub` answers both questions client-side from one fetch, so
 * no search argv is ever constructed.
 *
 * Both gateways expose the SAME `opts.exec` seam, so one throwing-on-search fake drives every
 * case below without a network round-trip.
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

/**
 * One merged PR carrying BOTH the anchored trailer and an owned `run-<taskId>-*` head ref, in
 * REST's `/pulls` wire shape — which is what the batched gateway parses since its enumeration
 * moved off `gh pr list --json` (W1-T265). Note `state: "closed", merged: true`: REST has no
 * MERGED token, and `prStateFromRest` is what folds the two back into one.
 */
const MERGED_PR_JSON = JSON.stringify([
  {
    number: 777,
    url: "https://api.github.com/repos/o/r/pulls/777",
    html_url: "https://github.com/o/r/pull/777",
    state: "closed",
    merged: true,
    head: { ref: "run-W1-T262-1784913918134", sha: "deadbee" },
    body: "work\nRemudero-Task: W1-T262\n",
    title: "t",
    updated_at: "2026-07-24T00:00:00Z",
    auto_merge: null,
  },
]);

/** Records every argv the gateway constructs, and REFUSES any search query the way a throttled
 *  search surface does (HTTP 200 + an error `gh` surfaces as a throw) — W1-T523: keyed on REST's
 *  `search/issues?q=…` now, not GraphQL's `--search` flag, since `ghGateway.findMergedByTrailer`
 *  moved onto REST's own Search API, which carries its own (separate, still throttleable) limit. */
function searchRefusingExec(argvLog: string[][]): (args: string[]) => string {
  return (args: string[]) => {
    argvLog.push(args);
    const url = args[1] ?? "";
    if (args[0] === "api" && url.startsWith("search/issues?q=")) {
      throw new Error("API rate limit exceeded for the search API.");
    }
    // The merged PR lives in the CLOSED half of the REST enumeration; the open half and every
    // later page are empty, which is what stops both walks.
    if (args[0] === "api" && url.includes("state=closed") && /[?&]page=1(&|$)/.test(url)) return MERGED_PR_JSON;
    return "[]";
  };
}

function onePlan(id: string): Plan {
  const tasks: Task[] = [task({ id })];
  return { tasks, byId: new Map(tasks.map((t) => [t.id, t])) };
}

/** True for an argv this gateway's search transport built — W1-T523: REST's `search/issues?q=…`. */
const isSearch = (a: string[]): boolean => a[0] === "api" && typeof a[1] === "string" && a[1].startsWith("search/issues?q=");

test("daemonCommand derives its merged-status projection from a gateway that builds NO search argv", async () => {
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
    argvLog.filter(isSearch).length,
    0,
    "the daemon's projection constructs NO search argv -- the throttled path is never touched",
  );
});

test("the batched projection gateway credits a merged task while every search is refused", () => {
  const argvLog: string[][] = [];
  const github = buildBatchedGithub("o", "r", { exec: searchRefusingExec(argvLog) });

  const proj = projectPlan(onePlan("W1-T262"), { ledgerPath: emptyLedger(), github }).get("W1-T262");

  assert.equal(proj?.merged, true, "the merged, owned, anchored PR is credited from the batch");
  assert.equal(proj?.prNumber, 777);
  assert.notEqual(proj?.indeterminate, true, "a working non-search read must never defer");
  assert.equal(argvLog.filter(isSearch).length, 0);
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
  // run-W1-T999-*", but the refused trailer search poisoned readFailed() and that definitive
  // negative was discarded -- so the daemon skipped the task every tick.
  assert.equal(proj?.indeterminate, true, "ghGateway defers -- the behaviour this change replaces");
  assert.ok(
    argvLog.some(isSearch),
    "and it got there by constructing a search argv the batched gateway never builds",
  );
});

test("the daemon merged-status projection reads no changed files for a prose-named uncredited build", async () => {
  // Boot profile 2026-09-24 (pid 525578): refreshMerged spent 78.6 s in uncreditedBuildWarning's changed-files
  // reads, a report the daemon never reads.
  const home = mkdtempSync(join(tmpdir(), "rmd-daemon-gw-files-"));
  const oldHome = process.env.HOME;
  const root = join(home, "Remudero");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root }));
  mkdirSync(join(root, "state"), { recursive: true });
  const planPath = join(home, "tasks.yaml");
  writeFileSync(
    planPath,
    "- id: W1-T2379\n  title: t\n  repo: remudero\n  depends_on: []\n  type: implement\n  verify: auto\n  risk: medium\n  status: queued\n  attempts: 0\n",
  );
  const prose = JSON.stringify([
    {
      number: 3095,
      url: "https://api.github.com/repos/o/r/pulls/3095",
      html_url: "https://github.com/o/r/pull/3095",
      state: "closed",
      merged: true,
      head: { ref: "fix/light-pass-tick", sha: "deadbee" },
      body: "Builds W1-T2379, option (a) of its design.",
      title: "fix(sweep): stop the light-pass tick waiting",
      updated_at: "2026-07-24T00:00:00Z",
      auto_merge: null,
    },
  ]);
  const argvLog: string[][] = [];
  process.env.HOME = home;
  try {
    const code = await daemonCommand(["--allow-self-target", "--plan", planPath, "--dry-run"], {
      githubFactory: (owner, repo) =>
        buildBatchedGithub(owner, repo, {
          exec: (args: string[]) => {
            argvLog.push(args);
            const url = args[1] ?? "";
            if (args.some((a) => a.includes("/files"))) return "src/lib/sweep.ts\n";
            if (url.includes("state=closed") && /[?&]page=1(&|$)/.test(url)) return prose;
            return "[]";
          },
        }),
    });
    assert.equal(code, 0, "--dry-run previews and returns clean");
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
  assert.ok(argvLog.some((a) => (a[1] ?? "").includes("state=closed")), "the projection really read the merged batch");
  assert.equal(argvLog.filter((a) => a.some((x) => x.includes("/files"))).length, 0, "and spent no changed-files read on it");
});

// Observed overlap (#16041): these two drive `daemonCommand`, the run-task composition root, so they
// live in a suite that already imports it (the affected-suite reach ratchet caps run-task importers).
const observedOpenPr = (n: number, head: string): PrRef => ({ number: n, url: `https://github.com/acme/remudero/pull/${n}`, state: "OPEN", headRefName: head, body: "", headRefOid: "a".repeat(40) });

test("observed scope producer: the daemon composition root builds it from the projection's open rows", async () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}observed-overlap-root-`));
  const home = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}observed-overlap-home-`));
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, ["- id: W1-T1", "  title: wiring fixture", "  repo: remudero", "  type: implement", "  verify: auto", "  risk: medium", "  files: [src/a.ts]", "  origin: test", "  status: queued", ""].join("\n"));
  const origin = gitRepo({ bare: true, kind: "observed-overlap-origin" });
  const seed = gitRepo({ seedCommit: false, kind: "observed-overlap-seed" });
  seed.addRemote("origin", origin.dir);
  writeFileSync(join(seed.dir, "README.md"), "seed\n");
  seed.git("add", "-A");
  seed.git("commit", "-q", "-m", "seed");
  seed.git("push", "-q", "-u", "origin", "main");
  const repoRoot = join(root, "repos", "remudero");
  mkdirSync(join(root, "repos"), { recursive: true });
  execFileSync("git", ["clone", "-q", origin.dir, repoRoot]);
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root }));
  const previous = { HOME: process.env.HOME, CI: process.env.CI, GITHUB_ACTIONS: process.env.GITHUB_ACTIONS };
  process.env.HOME = home;
  delete process.env.CI;
  delete process.env.GITHUB_ACTIONS;
  const changedFilesAsked: string[] = [];
  const github: GitHub = {
    prByRef: () => null,
    findMergedByTrailer: () => null,
    headRefName: () => undefined,
    prBody: () => undefined,
    listOpenHeadBranches: () => [observedOpenPr(15679, "run-W1-T9796-1793544678400")],
    changedFiles: (url) => { changedFilesAsked.push(url); return ["src/a.ts"]; },
  };
  try {
    let captured: DaemonDeps | undefined;
    const code = await daemonCommand(["--repo", "acme/remudero", "--plan", planPath, "--max", "0"], {
      repoRoot,
      githubFactory: () => github,
      readObservedOverlapMode: () => "shadow",
      runDaemon: async (_plan, deps): Promise<DaemonSummary> => {
        captured = deps;
        return { attempted: [], merged: [], stopReason: "stopped", costUsd: 0, ticks: 0 };
      },
    });
    assert.equal(code, 0);
    assert.ok(captured);
    assert.equal(typeof captured.observedOpenPrScope, "function", "the composition root supplies a producer");
    captured.refreshMerged();
    const scope = captured.observedOpenPrScope?.();
    assert.deepEqual(scope?.observedByTask.get("W1-T9796")?.files, ["src/a.ts"]);
    assert.equal(scope?.sourcesByTask.get("W1-T9796")?.[0]?.pr, 15679);
    assert.equal(captured.observedOverlapMode?.(), "shadow");
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    origin.cleanup();
    seed.cleanup();
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("observed scope producer: the async read-plane refresh publishes the open rows the producer reads; changed-files cache: an open PR's list is keyed on its head, so a push re-reads it once", async () => {
  // Production ticks call `refreshMergedAsync` (the read plane), never the synchronous `refreshMerged`.
  // No `githubFactory` here, so the read plane is live; its read is injected, and the changed-files
  // read goes through the shared `gh` shim on PATH.
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}observed-overlap-async-root-`));
  const home = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}observed-overlap-async-home-`));
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, ["- id: W1-T1", "  title: wiring fixture", "  repo: remudero", "  type: implement", "  verify: auto", "  risk: medium", "  files: [src/a.ts]", "  origin: test", "  status: queued", ""].join("\n"));
  const origin = gitRepo({ bare: true, kind: "observed-overlap-async-origin" });
  const seed = gitRepo({ seedCommit: false, kind: "observed-overlap-async-seed" });
  seed.addRemote("origin", origin.dir);
  writeFileSync(join(seed.dir, "README.md"), "seed\n");
  seed.git("add", "-A");
  seed.git("commit", "-q", "-m", "seed");
  seed.git("push", "-q", "-u", "origin", "main");
  const repoRoot = join(root, "repos", "remudero");
  mkdirSync(join(root, "repos"), { recursive: true });
  execFileSync("git", ["clone", "-q", origin.dir, repoRoot]);
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root }));
  const gh = ghShim([{ when: "pulls/15679/files", stdout: "src/a.ts\n" }], { kind: "observed-overlap-async-gh" });
  const previous = { HOME: process.env.HOME, CI: process.env.CI, GITHUB_ACTIONS: process.env.GITHUB_ACTIONS, PATH: process.env.PATH };
  process.env.HOME = home;
  process.env.PATH = `${gh.dir}:${process.env.PATH ?? ""}`;
  delete process.env.CI;
  delete process.env.GITHUB_ACTIONS;
  let reads = 0;
  let headRefOid = "a".repeat(40);
  const fileReads = () => gh.calls().filter((c) => c.includes("pulls/15679/files")).length;
  try {
    let captured: DaemonDeps | undefined;
    const code = await daemonCommand(["--repo", "acme/remudero", "--plan", planPath, "--max", "0"], {
      repoRoot,
      readObservedOverlapMode: () => "shadow",
      wireSweepWake: () => ({ sleep: async () => "timeout", acknowledge: () => {}, close: () => {} }),
      startGitCredentialSocket: async () => ({ socketPath: "/fixture/socket", close: async () => {} }),
      startMemoryCensus: () => () => {},
      startReadPlane: (() => ({
        read: async (input: { plan?: Plan }) => {
          reads++;
          return { generation: reads, source: "inline", publishedAtMs: Date.now(), settledAtMs: Date.now(),
            facts: { plan: input.plan, projection: [], openBranches: [{ ...observedOpenPr(15679, "run-W1-T9796-1793544678400"), headRefOid }],
              creditUpdates: [] } };
        },
        stop: async () => {},
      })) as never,
      runDaemon: async (_plan, deps): Promise<DaemonSummary> => {
        captured = deps;
        return { attempted: [], merged: [], stopReason: "stopped", costUsd: 0, ticks: 0 };
      },
    });
    assert.equal(code, 0);
    assert.ok(captured?.refreshMergedAsync, "the read plane is live, so production's async refresh is wired");
    await captured.refreshMergedAsync();
    assert.equal(reads, 1, "the async refresh read the plane");
    let scope = captured.observedOpenPrScope?.();
    assert.ok(scope, "the async publish handed the producer this pass's open rows");
    // The first lookup schedules the off-loop files read; it lands on a later turn.
    for (let i = 0; i < 200 && !scope?.observedByTask.has("W1-T9796"); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      scope = captured.observedOpenPrScope?.();
    }
    assert.deepEqual(scope?.observedByTask.get("W1-T9796")?.files, ["src/a.ts"]);
    assert.equal(scope?.sourcesByTask.get("W1-T9796")?.[0]?.pr, 15679);
    assert.equal(fileReads(), 1, "the files came from the gateway's own read once");
    await captured.refreshMergedAsync();
    assert.deepEqual(captured.observedOpenPrScope?.()?.observedByTask.get("W1-T9796")?.files, ["src/a.ts"]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fileReads(), 1, "another snapshot of the same head reuses the files");

    gh.addRoute({ when: "pulls/15679/files", stdout: "src/b.ts\n" });
    headRefOid = "b".repeat(40);
    await captured.refreshMergedAsync();
    scope = captured.observedOpenPrScope?.();
    assert.deepEqual(scope?.observedByTask.get("W1-T9796")?.files, ["src/a.ts"], "the prior list is served during refresh");
    for (let i = 0; i < 200 && scope?.observedByTask.get("W1-T9796")?.files[0] !== "src/b.ts"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      scope = captured.observedOpenPrScope?.();
    }
    assert.deepEqual(scope?.observedByTask.get("W1-T9796")?.files, ["src/b.ts"], "the async snapshot's new head invalidates the list");
    assert.equal(scope?.sourcesByTask.get("W1-T9796")?.[0]?.headRefOid, headRefOid);
    assert.equal(fileReads(), 2, "a pushed head triggers exactly one additional read");
    await captured.refreshMergedAsync();
    assert.deepEqual(captured.observedOpenPrScope?.()?.observedByTask.get("W1-T9796")?.files, ["src/b.ts"]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fileReads(), 2, "another snapshot of the pushed head reuses the new list");
    assert.equal(gh.calls().some((c) => c.includes("pulls?") || c.includes("pr list")), false,
      "the projection gateway's separate PR index stays cold");
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    origin.cleanup();
    seed.cleanup();
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    rmSync(gh.dir, { recursive: true, force: true });
  }
});
