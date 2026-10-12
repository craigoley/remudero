// W1-T6406: on 2026-10-08 one test failed CI on #10058, #10077, #10084 and #10089 — four PRs whose
// diffs do not touch it — and a person filed it by hand. The flake-incident gardener files it once.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { fixedClock } from "../src/lib/clock.js";
import {
  FLAKE_INCIDENT_POLICY, flakeIncidentOrigin, runFlakeIncidentGardener, testSourcePaths,
} from "../src/lib/flake-incident-gardener.js";
import { selectorShadowGardenPass } from "../src/lib/garden-registry.js";
import {
  readSelectorShadowRunsAsync, SELECTOR_SHADOW_SHARDS, selectorShadowFlakeEvidence, selectorShadowFlakeLedger,
} from "../src/lib/selector-shadow-gardener.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const TEST_FILE = "test/operator-agent-scan-routes-never-block-the-loop.test.ts";
const TITLE = "after a rotation lands the emergency status answers within budget and sees the new stop";
const NOW = Date.parse("2026-10-08T14:00:00Z");

type Row = Record<string, unknown>;

function harness(testSource = "import { x } from \"../src/lib/emergency-status.js\";\n") {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}flake-incident-`));
  mkdirSync(join(root, "state"), { recursive: true });
  mkdirSync(join(root, "plan", "tasks.d"), { recursive: true });
  // The flaky test is in the filing checkout, as on main: lint-plan's admission reads the file a shard declares.
  mkdirSync(join(root, TEST_FILE, ".."), { recursive: true });
  writeFileSync(join(root, TEST_FILE), "");
  const ledger = join(root, "state", "ledger.ndjson");
  const log = (step: string, extra: Record<string, unknown> = {}) => {
    appendFileSync(ledger, JSON.stringify({ ts: new Date(NOW).toISOString(), step, ...extra }) + "\n");
  };
  const landed: Array<{ paths: string[]; title: string; body: string }> = [];
  const deps = {
    stateDir: join(root, "state"),
    repoRoot: root,
    clock: fixedClock(NOW),
    openWorkspace: () => ({
      root, branch: "selector-shadow-garden-1",
      land: (opts: { paths: string[]; title: string; body: string }) => (landed.push(opts), `https://github.com/acme/remudero/pull/${20000 + landed.length}`),
      dispose: () => {},
    }),
    log,
  };
  let minted = 0;
  const mint = () => `W1-T90${String(++minted).padStart(2, "0")}`;
  const evidence = (pr: number, extra: Row = {}) => log("test.flake_retry", {
    file: TEST_FILE, headline: "recovered on retry", ci_run_id: pr * 10, shard: 3, source: "selector-shadow",
    retry_outcome: "recovered", head_sha: `head-${pr}`, base_sha: `base-${pr}`, pr_numbers: [pr], titles: [TITLE], ...extra,
  });
  const rows = (step: string): Row[] => readFileSync(ledger, "utf8").split("\n").filter(Boolean)
    .map((l) => JSON.parse(l) as Row).filter((r) => r.step === step);
  const sources = (changed: (head: string) => string[] | Error, open: Array<{ id: string; origin?: string; status?: string; retirement?: string }> = []) => ({
    mintTaskId: mint,
    readChangedPaths: (_base: string, head: string) => { const r = changed(head); if (r instanceof Error) throw r; return r; },
    planTasks: () => open,
    readSource: () => testSource,
  });
  return { root, deps, landed, evidence, rows, sources };
}

test("W1-T6406: a test failing across unrelated PRs files one flake incident", async () => {
  const h = harness();
  h.evidence(10058);
  h.evidence(10077, { retry_outcome: "also_failed", headline: "retry also failed" });
  h.evidence(10084);
  h.evidence(10089, { retry_outcome: "also_failed", headline: "retry also failed" });
  const sources = h.sources(() => ["src/lib/unrelated.ts"]);

  await runFlakeIncidentGardener(h.deps, sources);
  assert.equal(h.landed.length, 1, "four unrelated PRs file exactly one task");
  const origin = flakeIncidentOrigin(TEST_FILE, TITLE);
  assert.equal(origin, `flake-incident:${TEST_FILE}#${TITLE}`);
  const shard = readFileSync(join(h.root, h.landed[0]!.paths[0]!), "utf8");
  assert.ok(shard.includes(JSON.stringify(origin)), "the shard carries the origin key");
  assert.ok(shard.includes(TITLE), "the shard names the test");
  for (const pr of [10058, 10077, 10084, 10089]) assert.ok(shard.includes(`#${pr}`), `the shard names #${pr}`);
  assert.ok(shard.includes("2 recovered on retry, 2 also failed on retry"), "the shard counts each retry outcome");
  assert.ok(shard.includes("author_class: machine") && shard.includes("verify: human"), "it is filed through the shared machine path");
  const filed = h.rows("flake_incident.filed");
  assert.equal(filed.length, 1);
  assert.deepEqual([filed[0]!.origin, filed[0]!.task_id, filed[0]!.prs, filed[0]!.recovered, filed[0]!.also_failed],
    [origin, "W1-T9001", [10058, 10077, 10084, 10089], 2, 2]);

  // The filing PR has not reached the plan yet: the ledgered filing is the open task.
  await runFlakeIncidentGardener(h.deps, sources);
  assert.equal(h.landed.length, 1, "a second pass with the task pending files nothing");
  assert.deepEqual(h.rows("flake_incident.skipped").map((r) => r.reason), ["open-task W1-T9001"]);

  // Once the plan holds it open, still nothing; and the skip is said once, not every pass.
  const open = [{ id: "W1-T9001", origin, status: "queued" }];
  await runFlakeIncidentGardener(h.deps, h.sources(() => ["src/lib/unrelated.ts"], open));
  assert.equal(h.landed.length, 1, "a second pass with the task open files nothing");
  assert.equal(h.rows("flake_incident.skipped").length, 1);

  // Merged, and no PR has failed since it was filed: the old evidence cannot reopen it.
  await runFlakeIncidentGardener(h.deps, h.sources(() => ["src/lib/unrelated.ts"], [{ id: "W1-T9001", origin, status: "merged" }]));
  assert.equal(h.landed.length, 1, "evidence from before the filing does not file it again");
});

test("W1-T6406: a PR that touches the test is not evidence of a flake", async () => {
  const h = harness();
  for (const pr of [10058, 10077, 10084, 10089]) h.evidence(pr);
  // #10058 edits the test itself, #10077 edits a module the test imports, #10084's list cannot be read.
  const changed = (head: string): string[] | Error =>
    head === "head-10058" ? [TEST_FILE]
      : head === "head-10077" ? ["src/lib/emergency-status.ts"]
        : head === "head-10084" ? new Error("compare unavailable")
          : ["src/lib/unrelated.ts"];
  await runFlakeIncidentGardener(h.deps, h.sources(changed));
  assert.equal(h.landed.length, 0, "one clear PR is noise, however many touch the test");
  assert.deepEqual(h.rows("flake_incident.watch"), [], "one counted PR does not even raise a watch row");
  assert.equal(h.rows("flake_incident.paths_unread").length, 1, "the unreadable list is ledgered");

  // A fifth PR that does not touch it makes two counted PRs: a watch row, still no task.
  h.evidence(10091);
  await runFlakeIncidentGardener(h.deps, h.sources(changed));
  assert.equal(h.landed.length, 0);
  const watch = h.rows("flake_incident.watch");
  assert.equal(watch.length, 1);
  assert.deepEqual(watch[0]!.prs, [10089, 10091]);
  await runFlakeIncidentGardener(h.deps, h.sources(changed));
  assert.equal(h.rows("flake_incident.watch").length, 1, "an unchanged watch is not re-ledgered");
});

test("W1-T6406: the per-pass changed-path read budget is spent, and a PR it could not read is not evidence", async () => {
  const h = harness();
  for (const pr of [10058, 10077, 10084, 10089]) h.evidence(pr);
  let calls = 0;
  const sources = { ...h.sources(() => { calls++; return ["src/lib/unrelated.ts"]; }), policy: { changedPathReadsPerPass: 2 } };
  await runFlakeIncidentGardener(h.deps, sources);
  assert.equal(calls, 2, "only the budgeted number of compare reads is made");
  assert.equal(h.landed.length, 0, "the two PRs left unread are not counted, so four PRs do not file");
  const watch = h.rows("flake_incident.watch");
  assert.equal(watch.length, 1, "the two PRs that were read raise a watch row");
  assert.equal((watch[0]!.prs as number[]).length, 2);
});

test("W1-T6406: the registry's selector-shadow pass ledgers a flake-incident pass that throws", async () => {
  const h = harness();
  h.evidence(10058);
  h.evidence(10077);
  const deps = {
    ...h.deps,
    log: (step: string, extra: Record<string, unknown> = {}) => {
      if (step === "flake_incident.watch") throw new Error("ledger write refused");
      h.deps.log(step, extra);
    },
  };
  const readJson = async (args: string[]): Promise<unknown> =>
    args[1]!.includes("/compare/") ? { files: [{ filename: "src/lib/unrelated.ts" }] } : { workflow_runs: [] };
  const pass = selectorShadowGardenPass(deps, "acme", "remudero", h.sources(() => []).mintTaskId, { readJson, readText: async () => "" });
  await pass();
  const failed = h.rows("flake_incident.gardener_failed");
  assert.equal(failed.length, 1, "the throw is ledgered, not raised out of the pass");
  assert.equal(failed[0]!.error, "ledger write refused");
  assert.equal(h.landed.length, 0);
});

test("W1-T6406: a PR with any row touching the test is dropped whole, and a row without shas is touching", async () => {
  const h = harness();
  for (const pr of [1, 2, 3]) h.evidence(pr);
  h.evidence(2, { ci_run_id: 21, head_sha: "head-2-fix", base_sha: "base-2" });
  h.evidence(4, { head_sha: undefined, base_sha: undefined });
  await runFlakeIncidentGardener(h.deps, h.sources((head) => (head === "head-2-fix" ? [TEST_FILE] : ["src/lib/unrelated.ts"])));
  assert.equal(h.landed.length, 0, "PR 2's later commit edited the test and PR 4 has no shas, leaving PRs 1 and 3");
  assert.deepEqual(h.rows("flake_incident.watch")[0]?.prs, [1, 3]);
});

test("W1-T6406: rows from the CI runner's own ledger shape, or without a PR, are not incident evidence", async () => {
  const h = harness();
  for (const pr of [1, 2, 3]) h.evidence(pr, { pr_numbers: [] });
  for (const pr of [4, 5, 6]) h.evidence(pr, { source: "ci-runner" });
  await runFlakeIncidentGardener(h.deps, h.sources(() => []));
  assert.equal(h.landed.length, 0);
  assert.deepEqual(h.rows("flake_incident.watch"), []);
});

test("W1-T6406: the policy is tiered — one PR is noise, two watch, three file", () => {
  assert.deepEqual([FLAKE_INCIDENT_POLICY.watchPrs, FLAKE_INCIDENT_POLICY.filePrs], [2, 3]);
});

test("W1-T6406: the modules a test imports are the source its failure could come from", () => {
  assert.deepEqual(
    testSourcePaths("test/a.test.ts", `import x from "../src/lib/x.js";\nconst y = await import("./helpers/y.ts");\nimport z from "zod";`),
    ["src/lib/x.ts", "test/helpers/y.ts"],
  );
  assert.deepEqual(testSourcePaths("test/a.test.ts", undefined), []);
});

test("W1-T6406: the coverage-shard logs yield the PR, titles and retry outcome, including a retry that also failed", async () => {
  const shard = (n: number, conclusion: string, lines: string[]) => [
    `coverage-shard (${n}/8)\tSELECTOR-SHADOW-JOB: conclusion=${conclusion}`,
    ...[...lines, `2026-10-08T11:00:00Z AFFECTED-SUITES-SHADOW: ${JSON.stringify({ fullRun: false, floorSize: 80, narrowSize: 20, failures: [] })}`]
      .map((line) => `coverage-shard (${n}/8)\t${line}`),
  ];
  const log = [
    ...shard(1, "failure", [
      `2026-10-08T11:00:00Z FLAKE-RETRY: first attempt failed — ${TITLE}`,
      `2026-10-08T11:00:01Z FLAKE-RETRY-FILES: retrying 1 failed file(s) uninstrumented — ${TEST_FILE}`,
      `2026-10-08T11:00:02Z FLAKE-RETRY: retry ALSO failed — ${TITLE}`,
    ]),
    ...shard(2, "success", [
      "2026-10-08T11:00:00Z FLAKE-RETRY: first attempt failed — one, two",
      "2026-10-08T11:00:01Z FLAKE-RETRY-FILES: retrying 2 failed file(s) uninstrumented — test/a.test.ts, test/b.test.ts",
      "2026-10-08T11:00:02Z FLAKE-RETRY-RECOVERED: a flake, not a pass — one, two",
    ]),
    ...Array.from({ length: SELECTOR_SHADOW_SHARDS - 2 }, (_, i) => shard(i + 3, "success", []).join("\n")),
  ].join("\n");
  assert.deepEqual(selectorShadowFlakeEvidence(log), [
    { shard: 1, file: TEST_FILE, retryOutcome: "also_failed", titles: [TITLE] },
    { shard: 2, file: "test/a.test.ts", retryOutcome: "recovered" },
    { shard: 2, file: "test/b.test.ts", retryOutcome: "recovered" },
  ], "titles are attached only when the shard retried exactly one file");

  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}flake-incident-logs-`));
  const rows: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  await readSelectorShadowRunsAsync("acme", "remudero", 1, {
    cachePath: join(root, "logs.json"),
    clock: fixedClock(1_000),
    readJson: async () => ({ workflow_runs: [{
      id: 7, head_sha: "h7", status: "completed", conclusion: "failure", created_at: new Date(1_000).toISOString(),
      pull_requests: [{ number: 10058, base: { sha: "b7" } }],
    }] }),
    readLog: async () => log,
    onFlakes: selectorShadowFlakeLedger((step, extra) => { rows.push({ step, extra }); }),
  });
  assert.deepEqual(rows[0], { step: "test.flake_retry", extra: {
    file: TEST_FILE, headline: "retry also failed", ci_run_id: 7, shard: 1, source: "selector-shadow", retry_outcome: "also_failed",
    head_sha: "h7", base_sha: "b7", pr_numbers: [10058], titles: [TITLE],
  } });
  assert.equal(rows.length, 3);
  writeFileSync(join(root, "done"), "");
});
