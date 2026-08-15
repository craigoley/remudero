/**
 * `retroCommand`'s two `projectPlan` passes resolve merge state through the BATCHED gateway.
 *
 * WHY IT MATTERS MORE HERE THAN ON THE DISPATCH PATH. The retro fires UNATTENDED —
 * `evaluateRetroTrigger` on the merges-or-days cadence `plan/policy.yaml` sets — so the per-task
 * `gh pr list --search '"Remudero-Task: <id>" in:body'` was spending a GraphQL budget with nobody
 * watching. Each pass projects a WHOLE plan (the plan-health sweep and the orientation section), so
 * one retro cost roughly two projections' worth of searches against a 5000/hour ceiling. #1529 made
 * the identical swap on `runTask`; this is its sibling, asserted the same way.
 *
 * THE CLAIM UNDER TEST IS EQUIVALENCE, NOT SPEED. A migration that quietly changed what "merged"
 * means to the retro would be worse than the spend, so both gateway shapes are driven over ONE
 * corpus and required to agree — with a DELIBERATELY FUZZY search fixture, because a fixture that
 * returned only exact matches would make them agree by construction.
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
  const dir = mkdtempSync(join(tmpdir(), "retro-gateway-"));
  const p = join(dir, "ledger.ndjson");
  writeFileSync(p, "");
  return p;
}

const OWNED = "https://github.com/craigoley/remudero/pull/1424";
const PLAN_EDIT = "https://github.com/craigoley/remudero/pull/1357";

const CORPUS: BatchedPr[] = [
  {
    number: 1424,
    url: OWNED,
    state: "MERGED",
    headRefName: "run-W1-T373-1784500000000",
    body: "shipped the fast mode\n\nRemudero-Task: W1-T373\n",
  },
  {
    number: 1357,
    url: PLAN_EDIT,
    state: "MERGED",
    headRefName: "claude/file-w1-t373",
    // Names W1-T373 in prose; its anchored trailer is absent. The full-text index returns this,
    // the anchored matcher does not — the difference the equivalence test has to survive.
    body: "## filing W1-T373\n\nprose naming W1-T373 throughout\n",
  },
];

/**
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
        const id = q.match(/Remudero-Task: (\S+)"/)?.[1] ?? "";
        const perPage = Number(arg1.match(/per_page=(\d+)/)?.[1] ?? 1);
        // FUZZY BY CONTRACT — substring, exactly as GitHub's body index behaves.
        const hits = id ? CORPUS.filter((p) => (p.body ?? "").includes(id)).slice(0, perPage) : [];
        return JSON.stringify({
          items: hits.map((p) => ({ number: p.number, html_url: p.url, state: "closed", pull_request: { merged_at: "2026-01-01T00:00:00Z" } })),
        });
      }
      if (args[0] === "api" && /^repos\/[^/]+\/[^/]+\/pulls\/\d+$/.test(arg1)) {
        const row = CORPUS.find((p) => p.number === Number(arg1.split("/").pop()));
        return JSON.stringify({ number: row?.number, html_url: row?.url, state: "closed", merged_at: "2026-01-01T00:00:00Z", body: row?.body, head: { ref: row?.headRefName } });
      }
      if (args.includes("--paginate")) return "src/lib/x.ts\n";
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

test("both gateways agree a task implemented on its own run branch is merged", () => {
  const a = deriveStatus(task("W1-T373"), { ledgerPath: emptyLedger(), github: searchGateway([]) });
  const b = deriveStatus(task("W1-T373"), { ledgerPath: emptyLedger(), github: batchedGateway([]) });
  assert.equal(a.merged, true);
  assert.equal(b.merged, true);
  assert.equal(a.prNumber, 1424);
  assert.equal(b.prNumber, 1424);
});

test("both gateways agree a task named nowhere is not merged", () => {
  const a = deriveStatus(task("W1-T999"), { ledgerPath: emptyLedger(), github: searchGateway([]) });
  const b = deriveStatus(task("W1-T999"), { ledgerPath: emptyLedger(), github: batchedGateway([]) });
  assert.equal(a.merged, false);
  assert.equal(b.merged, false);
});

test("a prose-only mention credits under NEITHER gateway — the fuzzy hit is offered, then refused", () => {
  // The search form returns the plan-edit PR for a task its body only discusses; the anchored
  // re-verify refuses it. The batched form never offers it. Same verdict, one fewer rejection —
  // which is the ONLY observable difference between the two and is asserted, not described.
  const gw = searchGateway([]);
  assert.equal(gw.findMergedByTrailer("W1-T373")?.url, OWNED, "newest fuzzy hit is the real one here");
  const batched = batchedGateway([]);
  assert.equal(batched.findMergedByTrailer("W1-T373")?.url, OWNED);

  // And for a task carried ONLY in prose, the two diverge in offering but agree in verdict.
  const proseOnly = "W1-T373-prose";
  assert.equal(batched.findMergedByTrailer(proseOnly), null, "anchored matcher offers nothing");
  const viaSearch = deriveStatus(task(proseOnly), { ledgerPath: emptyLedger(), github: searchGateway([]) });
  const viaBatched = deriveStatus(task(proseOnly), { ledgerPath: emptyLedger(), github: batchedGateway([]) });
  assert.equal(viaSearch.merged, false);
  assert.equal(viaBatched.merged, false);
});

test("the batched gateway spends ZERO searches over a plan-sized id set", () => {
  const calls: string[][] = [];
  const gw = batchedGateway(calls);
  for (let i = 0; i < 50; i += 1) gw.findMergedByTrailer(`W1-T${i}`);
  assert.equal(calls.filter((c) => c[0] === "api" && typeof c[1] === "string" && c[1].startsWith("search/issues?q=")).length, 0);
});

test("the search gateway spends EXACTLY one per id — the control the cost claim needs", () => {
  const calls: string[][] = [];
  const gw = searchGateway(calls);
  for (let i = 0; i < 50; i += 1) gw.findMergedByTrailer(`W1-T${i}`);
  const searches = calls.filter((c) => c[0] === "api" && typeof c[1] === "string" && c[1].startsWith("search/issues?q="));
  assert.equal(searches.length, 50, "one search per id — twice per retro, over a 441-task plan, now off REST rather than GraphQL");
  // W1-T523: REST's `/search/issues`, never `pr`/`list` (GraphQL's `search()` connection).
  assert.ok(searches.every((c) => c[0] === "api" && !c.includes("pr") && !c.includes("list")));
});

test("each gateway keeps its OWN failure state, so one pass's outage cannot leak into the other", () => {
  // The reason retroCommand defaults PER CALL SITE rather than once. `ghGateway` closes over
  // mutable `failed`; `buildBatchedGithub` closes over `lastFetchFailed` — the SAME shape — so the
  // per-site rule survives the swap rather than being an artefact of the old gateway.
  const healthy = buildBatchedGithub("craigoley", "remudero", { fetchAll: () => CORPUS });
  const broken = buildBatchedGithub("craigoley", "remudero", {
    fetchAll: () => {
      throw new Error("fetch exploded");
    },
  });
  broken.findMergedByTrailer("W1-T373");
  assert.equal(broken.readFailed?.(), true, "the failing instance records its own outage");
  healthy.findMergedByTrailer("W1-T373");
  assert.equal(healthy.readFailed?.(), false, "and it does not leak into a separate instance");
});

test("MUTANT: reverting either projectPlan default restores the per-task search", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/run-task.ts", import.meta.url), "utf8");
  // BOTH sites must be batched. Asserting the COUNT (not merely presence) is what makes this a
  // falsifier: reverting either one alone would still leave the other matching.
  const batchedSites = src.split("github: opts.github ?? buildBatchedGithub(owner, repo)").length - 1;
  assert.equal(batchedSites, 2, "both retro projectPlan passes must default to the batched gateway");
  const searchSites = src.split("github: opts.github ?? ghGateway(owner, repo)").length - 1;
  assert.equal(searchSites, 0, "neither may default to the per-task search gateway");
});
