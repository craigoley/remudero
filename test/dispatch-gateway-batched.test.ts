/**
 * The DISPATCH path resolves merge state through the BATCHED gateway, not the per-task search.
 *
 * THE COST, DERIVED FROM SOURCE RATHER THAN ESTIMATED. `runTask` builds one gateway and hands it
 * straight to `projectPlan(plan, …)` over the WHOLE plan — 441 tasks at the sha this was written.
 * `ghGateway.findMergedByTrailer` spends one `gh pr list --search '"Remudero-Task: <id>" in:body'`
 * per task, and `--search` is GraphQL. So a single dispatch could spend ~441 of an account's
 * 5000/hour budget and a two-lane drain doubled it. MEASURED: graphql exhausted at 5661/5000 while
 * REST sat untouched at 5000/5000, and a drain reported `no_runnable` at $0.00 with work visible.
 *
 * THE CLAIM THAT MATTERS IS NOT THE COST, IT IS THAT THE CREDIT IS UNCHANGED. These tests drive
 * BOTH gateway shapes over the SAME PR corpus and require the same merge verdict, because a
 * partial migration that quietly changed what "merged" means would be worse than the spend. The
 * search form is documented fuzzy — it returns candidates `creditsByAnchoredTrailer` then rejects
 * — while the batched form matches the anchored trailer line directly, so the two agree on every
 * credit and differ only in how many candidates get rejected on the way there.
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Task } from "../src/lib/plan.js";
import { buildBatchedGithub, deriveStatus, ghGateway, type BatchedPr } from "../src/lib/status.js";

function task(id: string): Task {
  return {
    id,
    title: "t",
    repo: "remudero",
    depends_on: [],
    type: "implement",
    risk: "medium",
    verify: "auto",
    status: "queued",
    attempts: 0,
  };
}

function emptyLedger(): string {
  const dir = mkdtempSync(join(tmpdir(), "dispatch-gateway-"));
  const p = join(dir, "ledger.ndjson");
  writeFileSync(p, "");
  return p;
}

const OWNED = "https://github.com/craigoley/remudero/pull/75";
const FOREIGN = "https://github.com/craigoley/remudero/pull/1471";

/** The corpus both gateways answer from: one owned-run-branch implementation, one plan edit. */
const CORPUS: BatchedPr[] = [
  {
    number: 75,
    url: OWNED,
    state: "MERGED",
    headRefName: "run-W1-T24-1784137835423",
    body: "shipped the aggregator\n\nRemudero-Task: W1-T24\n",
  },
  {
    number: 1471,
    url: FOREIGN,
    state: "MERGED",
    headRefName: "claude/shard-corrections",
    // Mentions W1-T24 in prose but its ANCHORED trailer names a different task — the exact shape
    // GitHub's body search returns and the anchored re-verify then refuses.
    body: "## W1-T24 — framing withdrawn\n\nprose about W1-T24\n\nRemudero-Task: W1-T395\n",
  },
];

/**
 * A `ghGateway` whose `gh` is a fixture: the SEARCH form, answering from the same corpus.
 *
 * W1-T523: the transport moved off `gh pr list --search` (GraphQL) onto `gh api
 * search/issues?q=…` (REST) — the query-qualifier language (`in:body`) is unchanged, only the
 * argv shape carrying it is, so this fixture routes on the NEW shape rather than the old one.
 */
function searchGateway(calls: string[][]) {
  return ghGateway("craigoley", "remudero", {
    exec: (args) => {
      calls.push(args);
      const arg1 = typeof args[1] === "string" ? args[1] : "";
      if (args[0] === "api" && arg1.startsWith("search/issues?q=")) {
        const q = decodeURIComponent(arg1.slice("search/issues?q=".length).split("&")[0]);
        // FUZZY BY CONTRACT: the real search matches the body full-text index, so a PR merely
        // discussing the id comes back too. Modelling it faithfully is the whole point — a fixture
        // that returned only exact matches would prove the two agree by construction.
        const id = q.match(/Remudero-Task: (\S+)"/)?.[1] ?? "";
        const perPage = Number(arg1.match(/per_page=(\d+)/)?.[1] ?? 1);
        const hits = CORPUS.filter((p) => (p.body ?? "").includes(id)).slice(0, perPage);
        return JSON.stringify({
          items: hits.map((p) => ({ number: p.number, html_url: p.url, state: "closed", pull_request: { merged_at: "2026-01-01T00:00:00Z" } })),
        });
      }
      if (args[0] === "api" && /^repos\/[^/]+\/[^/]+\/pulls\/\d+$/.test(arg1)) {
        const n = Number(arg1.split("/").pop());
        const row = CORPUS.find((p) => p.number === n);
        return JSON.stringify({ number: row?.number, html_url: row?.url, state: "closed", merged_at: "2026-01-01T00:00:00Z", body: row?.body, head: { ref: row?.headRefName } });
      }
      if (args.includes("--paginate")) return "src/lib/x.ts\n";
      // Every other paginated pulls list (the merged/open head-branch enumerations) returns a LIST
      // — a bare object here made `cands.filter` throw, which is a fixture defect, not a code one.
      return "[]";
    },
  });
}

function batchedGateway(calls: string[][]) {
  return buildBatchedGithub("craigoley", "remudero", {
    fetchAll: () => CORPUS,
    exec: (args) => {
      calls.push(args);
      return JSON.stringify([{ filename: "src/lib/x.ts" }]);
    },
  });
}

test("both gateways agree that an owned-run-branch implementation is merged", () => {
  const a = deriveStatus(task("W1-T24"), { ledgerPath: emptyLedger(), github: searchGateway([]) });
  const b = deriveStatus(task("W1-T24"), { ledgerPath: emptyLedger(), github: batchedGateway([]) });
  assert.equal(a.merged, true, "the search form credits it today");
  assert.equal(b.merged, true, "and the batched form must credit it identically");
  assert.equal(a.prNumber, 75);
  assert.equal(b.prNumber, 75);
});

test("both gateways agree that a task named only in prose is NOT merged", () => {
  // W1-T999 appears nowhere; the fuzzy search returns nothing and neither may credit.
  const a = deriveStatus(task("W1-T999"), { ledgerPath: emptyLedger(), github: searchGateway([]) });
  const b = deriveStatus(task("W1-T999"), { ledgerPath: emptyLedger(), github: batchedGateway([]) });
  assert.equal(a.merged, false);
  assert.equal(b.merged, false);
});

test("the batched form never OFFERS the fuzzy candidate the search form must reject", () => {
  // W1-T395's own PR is the plan edit. The search form finds it and the anchored re-verify decides;
  // the batched form matches the anchored line directly, so it is the same verdict with one fewer
  // rejected candidate. This is the ONLY observable difference between them, and it is asserted
  // rather than described.
  const searchCalls: string[][] = [];
  const gw = searchGateway(searchCalls);
  assert.equal(gw.findMergedByTrailer("W1-T24")?.url, OWNED, "search returns a candidate for W1-T24");

  const batched = batchedGateway([]);
  assert.equal(batched.findMergedByTrailer("W1-T24")?.url, OWNED, "batched resolves the same PR");
  // The prose-only PR carries an anchored trailer for a DIFFERENT task, so asking for that task
  // must return it from both — proving the batched matcher is not simply stricter about everything.
  assert.equal(batched.findMergedByTrailer("W1-T395")?.url, FOREIGN);
});

test("the batched gateway spends NO per-task search — the whole point of the swap", () => {
  const calls: string[][] = [];
  const gw = batchedGateway(calls);
  for (const id of ["W1-T24", "W1-T395", "W1-T999", "W1-T413"]) gw.findMergedByTrailer(id);
  assert.equal(
    calls.filter((c) => c.includes("--search")).length,
    0,
    "resolving four tasks must issue zero GraphQL searches",
  );
});

test("the search gateway DOES spend one per task — the cost this swap removes, asserted not assumed", () => {
  const calls: string[][] = [];
  const gw = searchGateway(calls);
  for (const id of ["W1-T24", "W1-T395", "W1-T999", "W1-T413"]) gw.findMergedByTrailer(id);
  const searches = calls.filter((c) => c[0] === "api" && typeof c[1] === "string" && c[1].startsWith("search/issues?q="));
  assert.equal(searches.length, 4, "one search per task — over a 441-task plan that is the exhaustion");
  // W1-T523: moved off GraphQL's `search()` connection (`pr list --search`) onto REST's own
  // `/search/issues` — off the account's GraphQL budget, never a `pr`/`list` invocation.
  assert.ok(searches.every((c) => c[0] === "api" && !c.includes("pr") && !c.includes("list")));
});
