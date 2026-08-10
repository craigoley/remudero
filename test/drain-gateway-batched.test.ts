import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task } from "../src/lib/plan.js";
import { loadPlan, type Plan } from "../src/lib/plan.js";
import { buildBatchedGithub, deriveStatus, ghGateway, projectPlan, type BatchedPr, type GitHub } from "../src/lib/status.js";
import { drainCommand } from "../src/run-task.js";
import type { Config } from "../src/lib/config.js";
import type { DrainDeps, DrainSummary } from "../src/lib/drain.js";

/**
 * `drainCommand` WAS THE LAST DISPATCH-PATH HOLDOUT ON THE UNBATCHED GATEWAY.
 *
 * #1529 moved `runTask`, #1531 moved `retroCommand`, and #1532 measured what the split cost: the
 * SELECTOR asked `ghGateway` and got "not merged" while `runTask` — batched since #1529 — asked
 * about the SAME task in the same second and got "merged". The resulting `task_already_merged`
 * refusal halted a `--max 6` drain at $0.00 with five live tasks behind it.
 *
 * `test/dispatch-gateway-batched.test.ts` already proves the two gateways agree at `deriveStatus`
 * level over a shared corpus. This file proves the three things that file cannot:
 *
 *   1. the DIRECTION of the only real difference — `--limit 1` — with a corpus where the search
 *      form returns a FALSE NOT-MERGED and the batched form is correct. #1529's corpus cannot
 *      show this: its owned PR sorts first, so `.slice(0, 1)` happens to pick the right one;
 *   2. that `drainCommand`'s DEFAULT is really the batched gateway, proved by a ledger line only
 *      the batched gateway can write;
 *   3. the per-pass instance contract the swap's comment claims — a fresh gateway per pass, so one
 *      pass's outage cannot mark every later pass of the same drain indeterminate.
 */

function task(id: string): Task {
  return { id, title: "t", repo: "remudero", depends_on: [], type: "implement", risk: "medium", verify: "auto", status: "queued", attempts: 0 };
}

function emptyLedger(tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), `drain-gateway-${tag}-`));
  const p = join(dir, "ledger.ndjson");
  writeFileSync(p, "");
  return p;
}

const OWNED = "https://github.com/craigoley/remudero/pull/75";
const NOISE_A = "https://github.com/craigoley/remudero/pull/1400";
const NOISE_B = "https://github.com/craigoley/remudero/pull/1471";

/**
 * A corpus built to expose `--limit 1`. THREE merged PRs mention `W1-T24`; only the LOWEST-numbered
 * one carries its anchored trailer. GitHub's body search returns newest-first, so the single
 * candidate `--limit 1` yields is #1471 — which anchors a DIFFERENT task and is correctly refused
 * by `creditsByAnchoredTrailer`, leaving the search form with nothing and no second candidate.
 */
const CORPUS: BatchedPr[] = [
  {
    number: 1471,
    url: NOISE_B,
    state: "MERGED",
    headRefName: "claude/shard-corrections",
    body: "## W1-T24 — framing withdrawn\n\nprose about W1-T24\n\nRemudero-Task: W1-T395\n",
  },
  {
    number: 1400,
    url: NOISE_A,
    state: "MERGED",
    headRefName: "claude/notes",
    body: "follow-up to W1-T24, no trailer of its own\n",
  },
  {
    number: 75,
    url: OWNED,
    state: "MERGED",
    // HAND-NAMED ON PURPOSE, not `run-W1-T24-*`. With an owned run branch, rung (c2)'s head-branch
    // corroboration rescues the credit even when the trailer scan is wrong, so the corpus would
    // prove the batched form correct for a reason that has nothing to do with the anchored match.
    // MEASURED: with `run-W1-T24-…` here, a mutant replacing the anchored regex with a bare
    // substring test left every assertion in this file GREEN. A hand-named branch forces the
    // credit to come from the anchored scan and nowhere else.
    headRefName: "claude/aggregator-work",
    body: "shipped the aggregator\n\nRemudero-Task: W1-T24\n",
  },
];

/** `ghGateway` over the corpus, modelling the SEARCH faithfully: fuzzy, newest-first, `--limit 1`. */
function searchGateway(calls: string[][] = []): GitHub {
  return ghGateway("craigoley", "remudero", {
    exec: (args) => {
      calls.push(args);
      if (args.includes("--search")) {
        const term = args[args.indexOf("--search") + 1];
        const id = term.match(/Remudero-Task: (\S+)"/)?.[1] ?? "";
        // FUZZY BY CONTRACT — the real search hits the body full-text index, so a PR merely
        // DISCUSSING the id comes back too. A fixture returning only exact matches would prove
        // agreement by construction, which is the whole failure mode this corpus exists to avoid.
        const hits = CORPUS.filter((p) => (p.body ?? "").includes(id)).sort((a, b) => b.number - a.number);
        return JSON.stringify(hits.map((p) => ({ number: p.number, url: p.url, state: p.state })).slice(0, 1));
      }
      if (args.includes("view")) {
        const url = args[args.indexOf("view") + 1];
        const row = CORPUS.find((p) => p.url === url);
        if (args.includes("files")) return JSON.stringify({ files: [{ path: "src/lib/x.ts" }] });
        return JSON.stringify({ headRefName: row?.headRefName, body: row?.body });
      }
      return "[]";
    },
  });
}

function batchedGateway(calls: string[][] = []): GitHub {
  return buildBatchedGithub("craigoley", "remudero", {
    fetchAll: () => CORPUS,
    exec: (args) => {
      calls.push(args);
      return JSON.stringify([{ filename: "src/lib/x.ts" }]);
    },
  });
}

// ── 1. the DIRECTION: the swap can only ADD credits ─────────────────────────────────────────

test("FIXTURE PRECONDITION: the search really is fuzzy here — three PRs mention W1-T24 and limit-1 picks the wrong one", () => {
  const gw = searchGateway();
  const hit = gw.findMergedByTrailer("W1-T24");
  assert.equal(hit?.url, NOISE_B, "the single candidate the search yields is the newest MENTION, not the trailer");
  assert.equal(
    CORPUS.filter((p) => (p.body ?? "").includes("W1-T24")).length,
    3,
    "and the fuzziness is real: a corpus with one matching body would prove nothing",
  );
});

test("the search form reports a FALSE not-merged where the batched form is correct — the direction of the swap", () => {
  const searched = deriveStatus(task("W1-T24"), { ledgerPath: emptyLedger("dir-search"), github: searchGateway() });
  const batched = deriveStatus(task("W1-T24"), { ledgerPath: emptyLedger("dir-batched"), github: batchedGateway() });

  // THE WHOLE CLAIM IN TWO LINES. `--limit 1` handed the anchored re-verify a candidate it had to
  // refuse, and there was no second — so the task reads not-merged and the drain OFFERS it, which
  // is exactly the W1-T24 dispatch #1532 measured halting a drain at $0.00.
  assert.equal(searched.merged, false, "the unbatched selector would offer this already-merged task");
  assert.equal(batched.merged, true, "the batched selector agrees with runTask, which has been batched since #1529");
  assert.equal(batched.prNumber, 75);
});

test("the swap never WITHDRAWS a credit — every task the search credits, the batched form credits too", () => {
  // The converse direction, and the one that would make the swap dangerous if it failed: a task
  // becoming newly OFFERED would put fresh work at risk, not merely waste a selection. It cannot
  // happen, because rung (c) re-verifies EVERY hit with `creditsByAnchoredTrailer` before
  // crediting — so the search's fuzziness never credited anything on its own.
  for (const id of ["W1-T24", "W1-T395", "W1-T999"]) {
    const searched = deriveStatus(task(id), { ledgerPath: emptyLedger(`conv-s-${id}`), github: searchGateway() });
    const batched = deriveStatus(task(id), { ledgerPath: emptyLedger(`conv-b-${id}`), github: batchedGateway() });
    if (searched.merged) assert.equal(batched.merged, true, `${id}: batched must credit everything the search credits`);
  }
  // W1-T395 is the case that proves the batched matcher is not simply stricter about everything:
  // the prose-only PR anchors THAT task, and both forms credit it.
  const s = deriveStatus(task("W1-T395"), { ledgerPath: emptyLedger("conv-s2"), github: searchGateway() });
  const b = deriveStatus(task("W1-T395"), { ledgerPath: emptyLedger("conv-b2"), github: batchedGateway() });
  assert.equal(s.merged, true);
  assert.equal(b.merged, true);
});

// ── 2. the cost, asserted BOTH WAYS over the projection the drain actually runs ──────────────

const PLAN_IDS = ["W1-T24", "W1-T395", "W1-T999", "W1-T413", "W1-T400"];

/** A real `Plan` over those ids — `projectPlan` takes the loader's shape, not a bare array. */
function planOfIds(tag: string): Plan {
  const dir = mkdtempSync(join(tmpdir(), `drain-gateway-plan-${tag}-`));
  const f = join(dir, "tasks.yaml");
  writeFileSync(
    f,
    PLAN_IDS.map((id) => `- id: ${id}\n  title: t\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n`).join(""),
  );
  return loadPlan(f);
}

test("projectPlan over the drain's own plan spends ZERO GraphQL searches on the batched gateway", () => {
  const calls: string[][] = [];
  const proj = projectPlan(planOfIds("batched"), { ledgerPath: emptyLedger("cost-batched"), github: batchedGateway(calls) });
  assert.equal(proj.size, PLAN_IDS.length, "REACHED THE CODE: every task was really projected");
  assert.equal(calls.filter((c) => c.includes("--search")).length, 0, "zero searches for the whole plan");
});

test("projectPlan over the SAME plan spends exactly one search PER TASK on the unbatched gateway — the cost removed", () => {
  const calls: string[][] = [];
  const proj = projectPlan(planOfIds("search"), { ledgerPath: emptyLedger("cost-search"), github: searchGateway(calls) });
  assert.equal(proj.size, PLAN_IDS.length);
  const searches = calls.filter((c) => c.includes("--search"));
  assert.equal(searches.length, PLAN_IDS.length, "one GraphQL search per task — over ~441 tasks that is the exhaustion");
  assert.ok(searches.every((c) => c.includes("pr") && c.includes("list")));
});

// ── 3. drainCommand's DEFAULT is the batched gateway ────────────────────────────────────────

const ONE_TASK_YAML = `
- id: W1-T24
  title: a
  repo: remudero
  type: implement
  depends_on: []
  status: queued
`;

/**
 * Proved by a LEDGER LINE ONLY THE BATCHED GATEWAY CAN WRITE. `buildBatchedGithub` logs
 * `board_gateway.fetch_ok` / `board_gateway.fetch_failed` through the `log` it is handed;
 * `ghGateway` takes no `log` at all and emits no such step, at any sha. So the line's presence is
 * a fact about which constructor ran — not an assertion about a string in the source.
 *
 * No network is required and none is assumed: `gh` failing (absent, unauthenticated, throttled) is
 * the path this asserts, and it is also the fail-SAFE direction — a failed read marks the
 * projection indeterminate, so the drain declines rather than dispatching blind.
 */
test("REACHABILITY: the real drainCommand builds its projection from the BATCHED gateway, by default", async () => {
  const root = mkdtempSync(join(tmpdir(), "drain-gateway-default-"));
  mkdirSync(join(root, "state"), { recursive: true });
  const config = { claudeBin: "/nonexistent/claude-not-installed", root } as Config;
  const planDir = mkdtempSync(join(tmpdir(), "drain-gateway-default-plan-"));
  const planPath = join(planDir, "tasks.yaml");
  writeFileSync(planPath, ONE_TASK_YAML);

  try {
    let captured: DrainDeps | undefined;
    // `runDrain` IS INJECTED SO THE LOOP NEVER RUNS. That is a safety property, not a convenience:
    // an earlier draft of this test let the real loop proceed, and with the gateway reading a task
    // as not-merged the drain went on toward a REAL dispatch — 13.7s of it — against a nonexistent
    // claudeBin. A reachability test for a gateway default must not be able to spawn a worker.
    // `githubFactory` is still NOT injected, which is the whole point: the default is what is
    // under test, and `refreshMerged` is driven directly below.
    const code = await drainCommand([], {
      config,
      planPath,
      skipGitSync: true,
      notifyChannel: { send: () => true } as never,
      runDrain: async (_plan: Plan, deps: DrainDeps): Promise<DrainSummary> => {
        captured = deps;
        return { attempted: [], merged: [], stopReason: "stopped", costUsd: 0, resumeCommand: "rmd drain" };
      },
    });
    assert.equal(code, 0);
    assert.ok(captured, "runDrain was reached and its DrainDeps captured");

    // Drive the DEFAULT factory once. `gh` failing here (absent, unauthenticated, throttled) is
    // the expected and fail-SAFE path — a failed read marks the projection indeterminate, so the
    // selector declines rather than dispatching blind.
    captured.refreshMerged();

    const lines = readFileSync(join(root, "state", "ledger.ndjson"), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const steps = [...new Set(lines.map((l) => String(l.step)))];
    // ONLY THE BATCHED GATEWAY CAN WRITE THIS. `buildBatchedGithub` logs `board_gateway.fetch_ok`
    // / `board_gateway.fetch_failed` through the `log` it is handed; `ghGateway` takes no `log`
    // parameter at all and emits no such step at any sha. So this is a fact about which
    // constructor ran, not an assertion about a string in the source.
    assert.ok(
      steps.some((s2) => s2.startsWith("board_gateway.")),
      `FALSIFIER: reverting the factory to ghGateway removes every board_gateway.* step. steps=${steps.join(",")}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 4. the per-pass instance contract ───────────────────────────────────────────────────────

test("the gateway is constructed PER PASS, so one pass's outage cannot poison the rest of the drain", async () => {
  const root = mkdtempSync(join(tmpdir(), "drain-gateway-perpass-"));
  mkdirSync(join(root, "state"), { recursive: true });
  const config = { claudeBin: "/nonexistent/claude-not-installed", root } as Config;
  const planDir = mkdtempSync(join(tmpdir(), "drain-gateway-perpass-plan-"));
  const planPath = join(planDir, "tasks.yaml");
  writeFileSync(planPath, ONE_TASK_YAML);

  const built: GitHub[] = [];
  let captured: DrainDeps | undefined;
  try {
    await drainCommand([], {
      config,
      planPath,
      skipGitSync: true,
      notifyChannel: { send: () => true } as never,
      githubFactory: () => {
        const gw = batchedGateway();
        built.push(gw);
        return gw;
      },
      runDrain: async (_plan: Plan, deps: DrainDeps): Promise<DrainSummary> => {
        captured = deps;
        return { attempted: [], merged: [], stopReason: "stopped", costUsd: 0, resumeCommand: "rmd drain" };
      },
    } as never);

    assert.ok(captured, "runDrain was reached and its DrainDeps captured");
    const before = built.length;
    captured.refreshMerged();
    captured.refreshMerged();
    assert.equal(built.length - before, 2, "each pass constructs its OWN gateway — the factory is inside refreshMerged");
    // DISTINCT INSTANCES, not merely two calls: `buildBatchedGithub` closes over mutable
    // `lastFetchFailed` exactly as `ghGateway` closes over `failed`, so a shared instance would
    // carry one pass's outage into every later pass of the same drain. That is the reason this
    // swap kept the construction inside the closure rather than hoisting it.
    assert.notEqual(built[built.length - 1], built[built.length - 2], "and they are different objects");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 5. the two commands' factories must not drift apart again ───────────────────────────────

test("drainCommand and daemonCommand build their gateway with the SAME expression — the drift that caused #1532", () => {
  const src = readFileSync(new URL("../src/run-task.ts", import.meta.url), "utf8");
  const factories = src.split("\n").filter((l) => l.includes("const githubFactory = deps.githubFactory ??"));
  assert.equal(factories.length, 2, "exactly two commands build a status gateway this way");
  assert.equal(
    factories[0].trim(),
    factories[1].trim(),
    "byte-identical, deliberately: #1532 was one command reading a gateway the other did not, and the " +
      "two share refreshMerged/isOpenPr/openPrCount/isIndeterminate verbatim — the factory was the one line they did not",
  );
  assert.match(factories[0], /buildBatchedGithub/, "and both are the BATCHED form");
});
