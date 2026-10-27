// W1-T9708: a census walks the whole tree, so a PR that adds a site the census reports reds it without
// touching the census or anything it imports. W1-T7532 (catch-erasure-ratchet: #10354, #10368 and #10491
// each added a negated optional-chain conflator) and W1-T7765 (the hardened-leaf git-spawn ratchet: every
// cited PR added a raw git spawn) were each filed as a flake from the PRs that caused the red.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { censusWalksOf, discoverCensusCandidates } from "#src/lib/ci-parity.js";
import { fixedClock } from "#src/lib/clock.js";
import { runFlakeIncidentGardener } from "#src/lib/flake-incident-gardener.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const NOW = Date.parse("2026-10-10T18:00:00Z");
/** A census the registry models: catch-erasure-census, walks src/. */
const REGISTRY_CENSUS = "test/catch-erasure-ratchet.test.ts";
/** A census only the candidate recognizer names, shaped like the hardened-leaf git-spawn ratchet. */
const UNMODELLED_CENSUS = "test/every-raw-spawn-uses-the-leaf.test.ts";
const UNMODELLED_SOURCE = [
  `import { readdirSync, readFileSync } from "node:fs";`,
  `import { maskLiterals } from "#src/lib/test-impact-map.js";`,
  `const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => [e.name]);`,
  `for (const f of files(join(REPO, "src"))) readFileSync(f, "utf8");`,
].join("\n");

type Row = Record<string, unknown>;

function harness(file: string, source: string) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}census-flake-`));
  mkdirSync(join(root, "state"), { recursive: true });
  mkdirSync(join(root, "plan", "tasks.d"), { recursive: true });
  mkdirSync(join(root, "test"), { recursive: true });
  writeFileSync(join(root, file), source);
  const ledger = join(root, "state", "ledger.ndjson");
  const log = (step: string, extra: Row = {}) => appendFileSync(ledger, JSON.stringify({ ts: new Date(NOW).toISOString(), step, ...extra }) + "\n");
  const landed: Array<{ paths: string[] }> = [];
  const deps = {
    stateDir: join(root, "state"), repoRoot: root, clock: fixedClock(NOW), log,
    openWorkspace: () => ({
      root, branch: "flake-incident-garden-1",
      land: (opts: { paths: string[] }) => (landed.push(opts), `https://github.com/acme/remudero/pull/${30000 + landed.length}`),
      dispose: () => {},
    }),
  };
  const evidence = (pr: number, outcome: "also_failed" | "recovered") => log("test.flake_retry", {
    file, headline: outcome === "recovered" ? "recovered on retry" : "retry also failed", ci_run_id: pr * 10, shard: 2,
    source: "selector-shadow", retry_outcome: outcome, head_sha: `head-${pr}`, base_sha: `base-${pr}`, pr_numbers: [pr],
  });
  const rows = (step: string): Row[] => readFileSync(ledger, "utf8").split("\n").filter(Boolean)
    .map((l) => JSON.parse(l) as Row).filter((r) => r.step === step);
  let minted = 0;
  const sources = (changed: (head: string) => string[]) => ({
    mintTaskId: () => `W1-T97${String(++minted).padStart(2, "0")}`,
    readChangedPaths: (_base: string, head: string) => changed(head),
    planTasks: () => [],
    readSource: () => source,
  });
  return { deps, landed, evidence, rows, sources };
}

test("W1-T9708: a census red on PRs whose diffs enter its walk files no flake incident", async () => {
  // W1-T7532's evidence: three PRs, every retry also failed, each diff adding a site under src/.
  const h = harness(REGISTRY_CENSUS, "");
  for (const pr of [10354, 10368, 10491]) h.evidence(pr, "also_failed");
  await runFlakeIncidentGardener(h.deps, h.sources(() => ["src/lib/read-model-worker.ts", "test/a-stale-proof.test.ts"]));
  assert.equal(h.landed.length, 0, "a census red each PR caused is that PR's own, not a flake");
  assert.deepEqual(h.rows("flake_incident.filed"), []);
  assert.deepEqual(h.rows("flake_incident.watch"), [], "a PR-caused census red does not even raise a watch row");
});

test("W1-T9708: a census red that recovers on retry still counts toward a flake incident", async () => {
  // A census that passes on retry on the same tree is timing, not the tree.
  const h = harness(REGISTRY_CENSUS, "");
  for (const pr of [10354, 10368, 10491]) h.evidence(pr, "recovered");
  await runFlakeIncidentGardener(h.deps, h.sources(() => ["src/lib/read-model-worker.ts"]));
  assert.equal(h.landed.length, 1, "three recovered retries on unrelated PRs file one flake incident");
  assert.deepEqual(h.rows("flake_incident.filed").map((r) => r.prs), [[10354, 10368, 10491]]);
});

test("W1-T9708: a census red on a PR whose diff stays outside its walk still counts", async () => {
  const h = harness(REGISTRY_CENSUS, "");
  // One outside-walk retry recovers: a group no retry recovers is main-inherited (W1-T9551), never filed.
  h.evidence(10354, "recovered");
  for (const pr of [10368, 10491, 10500]) h.evidence(pr, "also_failed");
  // #10500 changes src/; the other three are plan-only and docs-only, outside the census's walk.
  const changed = (head: string) => (head === "head-10500" ? ["src/lib/read-model-worker.ts"]
    : head === "head-10368" ? ["docs/forensics/flake.md"] : ["plan/tasks.d/w1-t1-x.yaml"]);
  await runFlakeIncidentGardener(h.deps, h.sources(changed));
  assert.equal(h.landed.length, 1, "three PRs outside the walk still file the incident");
  assert.deepEqual(h.rows("flake_incident.filed").map((r) => r.prs), [[10354, 10368, 10491]],
    "only the PR whose diff enters the walk is attributed, and it is left out");
});

test("W1-T9708: a test the census recognizer names but the registry does not is a census too", async () => {
  assert.deepEqual(censusWalksOf(UNMODELLED_CENSUS, UNMODELLED_SOURCE), ["src/"]);
  const spawn = () => ({ status: 0, stdout: `${UNMODELLED_CENSUS}\n`, stderr: "" });
  const [candidate] = discoverCensusCandidates("/nowhere", spawn, () => UNMODELLED_SOURCE);
  assert.deepEqual(censusWalksOf(UNMODELLED_CENSUS, UNMODELLED_SOURCE), candidate!.walks,
    "the gardener reads the walks rmd census-membership reports for the same file");
  assert.deepEqual(censusWalksOf(REGISTRY_CENSUS, undefined), ["src/"], "a registry row needs no source");
  assert.deepEqual(censusWalksOf("test/plain.test.ts", `import { x } from "#src/lib/x.js";\n`), [],
    "a test that walks nothing is no census, however it imports src/");

  // W1-T7765's shape: five PRs, every retry also failed, each adding a raw git spawn under src/.
  const h = harness(UNMODELLED_CENSUS, UNMODELLED_SOURCE);
  for (const pr of [10203, 10310, 10377, 10643, 10671]) h.evidence(pr, "also_failed");
  await runFlakeIncidentGardener(h.deps, h.sources((head) => [`src/lib/${head}.ts`]));
  assert.equal(h.landed.length, 0, "an unmodelled census red each PR caused files nothing");
  assert.deepEqual(h.rows("flake_incident.watch"), []);
});
