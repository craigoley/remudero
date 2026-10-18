/**
 * W1-T9665 — A RED-MAIN FIX BRIEF CARRIES THE MERGES SINCE GREEN.
 *
 * 2026-10-15: main went red after #11987 (febd1bb34) and #11997 (131248633) merged. They share no file and
 * meet only through the failing test's imports. The lane named plan-only 037a58d8f (#12006), its brief
 * carried only that merge's diff stat, and three codex rounds opened no PR. These fixtures replay that red
 * against the real rung: the cancelled commits are probed, 037a58d8f is located, and the brief must name
 * every merge since the last green, the two that reach the failing test, and their collision.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { AffectedSuitesInput } from "#src/lib/affected-suites.js";
import type { AsyncIssueGateway } from "#src/lib/escalate.js";
// A namespace import, so at a base without the brief this file still loads and each test fails on its own.
import * as rung from "#src/lib/main-health-rung.js";
import {
  buildMainHealthRung,
  type MainHealthRungDeps,
  type MainRepairFixRequest,
  type MainRepairLane,
  type MainRepairMerge,
} from "#src/lib/main-health-rung.js";
import type { GhApiFetcher } from "#src/lib/open-prs-rest.js";
import type { CiFailure } from "#src/lib/sweep.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const OWNER = "craigoley";
const REPO = "remudero";
const REPO_PATH = `repos/${OWNER}/${REPO}`;
const sha = (prefix: string): string => prefix.padEnd(40, "0");
const GREEN = sha("cd482d43");
const GARDENER = sha("febd1bb34"); // #11987
const REMEDY = sha("131248633"); // #11997
const PLAN_ONLY = sha("037a58d8f"); // #12006, main's head and its first completed red
const FAILING_TEST = "test/a-ci-friction-cause-owned-by-a-test-alone-escalates-as-no-owner.test.ts";
const FAILING_LOG = [
  `# Subtest: ${FAILING_TEST}`,
  "not ok 2 - W1-T9503: a cause owned by a test alone escalates as no-owner",
  `  location: '/home/runner/work/remudero/remudero/${FAILING_TEST}:41:1'`,
].join("\n");

interface Merge {
  sha: string;
  message: string;
  files: Array<{ filename: string; additions: number; deletions: number; patch?: string }>;
}

const MERGES: Merge[] = [
  {
    sha: GARDENER,
    message: "fix(ci-friction): a cause owned by a test alone escalates as no-owner (W1-T9503) (#11987)",
    files: [
      { filename: "src/lib/ci-friction-gardener.ts", additions: 12, deletions: 3, patch: "@@ -10,3 +10,12 @@\n+  if (owners.length === 0) return noOwner(cause);" },
      { filename: FAILING_TEST, additions: 60, deletions: 0, patch: "@@ -0,0 +1,60 @@\n+test(\"W1-T9503: a cause owned by a test alone escalates as no-owner\"" },
    ],
  },
  {
    sha: REMEDY,
    message: "fix(ci-friction): a remedy drafts only owner code (#11997)",
    files: [
      { filename: "src/lib/ci-friction-remedy.ts", additions: 8, deletions: 2, patch: "@@ -40,2 +40,8 @@\n+export const REMEDY_OWNER_ONLY = true;" },
      { filename: "test/ci-friction-remedy.test.ts", additions: 20, deletions: 0, patch: "@@ -0,0 +1,20 @@\n+test(\"a remedy drafts owner code\"" },
    ],
  },
  {
    sha: PLAN_ONLY,
    message: "chore(plan): backlog gardener proposes place for 2 task(s) (#12006)",
    files: [
      { filename: "plan/tasks.d/W1-T9001-one.yaml", additions: 2, deletions: 0, patch: "@@ -1 +1,2 @@\n+  place: next-plan-only-line" },
      { filename: "plan/tasks.d/W1-T9002-two.yaml", additions: 2, deletions: 0, patch: "@@ -1 +1,2 @@\n+  place: other" },
    ],
  },
];

/** The checkout's import graph: the failing test imports the gardener, which imports the remedy. */
const AFFECTED_FILES = new Map<string, string>([
  [FAILING_TEST, 'import { gardenCause } from "../src/lib/ci-friction-gardener.js";\n'],
  ["src/lib/ci-friction-gardener.ts", 'import { draftRemedy } from "./ci-friction-remedy.js";\nexport const gardenCause = draftRemedy;\n'],
  ["src/lib/ci-friction-remedy.ts", "export const draftRemedy = () => 1;\n"],
  ["test/ci-friction-remedy.test.ts", 'import { draftRemedy } from "../src/lib/ci-friction-remedy.js";\n'],
]);
const readAffectedInput = async (): Promise<AffectedSuitesInput> => ({ files: AFFECTED_FILES, pathReaders: [] });

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** `orphan`: a commit GitHub reads with no parent, so main's first-parent chain ends short of the green. */
function rig(lane: MainRepairLane, ledgerPath: string, overrides: Partial<MainHealthRungDeps> = {}, orphan?: string) {
  let clock = Date.parse("2026-10-15T13:30:00Z");
  const chain = [GREEN, GARDENER, REMEDY, PLAN_ONLY];
  const run = (id: number, head: string, conclusion: string) => ({
    id,
    name: "CI",
    head_sha: head,
    status: "completed",
    conclusion,
    html_url: `https://github.com/${OWNER}/${REPO}/actions/runs/${id}`,
  });
  // Newest first: the plan-only head is the first COMPLETED red; both PR merges before it were cancelled.
  const history = [run(904, PLAN_ONLY, "failure"), run(903, REMEDY, "cancelled"), run(902, GARDENER, "cancelled"), run(901, GREEN, "success")];
  const fetch = ((args: string[]) => {
    const path = args.find((arg) => arg.startsWith("repos/")) ?? "";
    if (args.includes("--method")) return {};
    if (path === REPO_PATH) return { default_branch: "main" };
    if (path === `${REPO_PATH}/commits/main`) return { sha: PLAN_ONLY };
    if (path === `${REPO_PATH}/commits/${PLAN_ONLY}/check-runs?per_page=100`) {
      return { check_runs: [{ id: 1, name: "ci", status: "completed", conclusion: "failure" }] };
    }
    if (path === `${REPO_PATH}/commits/${PLAN_ONLY}/status`) return { statuses: [] };
    if (path.startsWith(`${REPO_PATH}/actions/runs?`)) return { workflow_runs: history };
    const jobs = /actions\/runs\/(\d+)\/jobs\?per_page=100$/.exec(path)?.[1];
    if (jobs) {
      const entry = history.find((candidate) => candidate.id === Number(jobs));
      return { jobs: [{ id: Number(jobs) * 10, name: "ci", status: "completed", conclusion: entry?.conclusion ?? "failure" }] };
    }
    const commit = /^repos\/craigoley\/remudero\/commits\/([0-9a-f]{40})$/.exec(path)?.[1];
    if (commit) {
      const index = chain.indexOf(commit);
      const merge = MERGES.find((candidate) => candidate.sha === commit);
      return {
        sha: commit,
        commit: { message: merge?.message ?? "green" },
        parents: index > 0 && commit !== orphan ? [{ sha: chain[index - 1] }] : [],
        files: merge?.files ?? [],
      };
    }
    throw new Error(`unrouted gh api call: ${args.join(" ")}`);
  }) as GhApiFetcher;
  const issues: AsyncIssueGateway = {
    create: async () => `https://github.com/${OWNER}/${REPO}/issues/12030`,
    listOpen: async () => [],
    comment: async () => {},
    closeWithComment: async () => {},
  };
  const rung = buildMainHealthRung(OWNER, REPO, {
    fetch,
    issues,
    ledgerPath,
    runId: "DAEMON-MERGES-SINCE-GREEN",
    log: () => {},
    now: () => clock,
    readRequiredChecks: () => ["ci"],
    readCiFailures: (rollup) => (rollup ?? []).map((entry): CiFailure => ({ name: entry.name ?? "", conclusion: "FAILURE", logTail: FAILING_LOG })),
    mergeReader: { prMerge: () => undefined, mergeBase: () => GREEN, prsMergedBetween: () => [] },
    readAffectedInput,
    repair: lane,
    ...overrides,
  });
  return {
    observe: async () => {
      clock += 60_000;
      await rung();
      await flush();
    },
  };
}

/** A lane whose probes find both cancelled PR merges green, so the bisection proves the plan-only head. */
function fakeLane(): MainRepairLane & { fixes: MainRepairFixRequest[] } {
  const fixes: MainRepairFixRequest[] = [];
  return {
    fixes,
    openFixPr: async (request) => {
      fixes.push(request);
      return `https://github.com/${OWNER}/${REPO}/pull/12031`;
    },
    openRevertPr: async () => ({ refused: "not exercised" }),
    probes: {
      dispatch: (probeSha) => ({ sha: probeSha, ref: `rmd-attribution/${probeSha}`, runId: 7000 }),
      read: () => ({ status: "completed", runId: 7000, jobs: [{ name: "ci", status: "completed", conclusion: "success" }] }),
      release: () => {},
      readRunnerLoad: () => ({ queuedJobs: 0, idleRunners: 1 }),
    },
  };
}

function inScratchDir(body: (ledgerPath: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}since-green-`));
    try {
      await body(join(root, "ledger.ndjson"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
}

async function replayFix(overrides: Partial<MainHealthRungDeps> = {}, orphan?: string): Promise<MainRepairFixRequest> {
  let request: MainRepairFixRequest | undefined;
  await inScratchDir(async (ledgerPath) => {
    const lane = fakeLane();
    const daemon = rig(lane, ledgerPath, overrides, orphan);
    for (let pass = 0; pass < 4 && lane.fixes.length === 0; pass += 1) await daemon.observe();
    request = lane.fixes[0];
  })();
  assert.ok(request, "the replayed red dispatched a fix");
  assert.equal(request.offendingSha, PLAN_ONLY, "the lane still locates the plan-only head: location is unchanged");
  return request;
}

/** What mainRepairFixPrompt splices into the worker's prompt from the request. */
const briefOf = (request: MainRepairFixRequest): string => {
  const { lines, fixLine } = rung.mainRepairMergesBrief(request);
  return [...lines, fixLine].join("\n");
};
const fixLine = (prompt: string): string => prompt.split("\n").find((line) => line.startsWith("Fix EXACTLY ONE thing")) ?? "";

test("W1-T9665: a red main fix brief lists every merge since the last green main", async () => {
  const request = await replayFix();
  const since = request.mergesSinceGreen;
  assert.equal(since?.afterGreenSha, GREEN);
  assert.equal(since?.unreadable, undefined);
  assert.deepEqual(
    since?.merges.map((merge) => [merge.sha, merge.pr, merge.files]),
    MERGES.map((merge) => [merge.sha, Number(/#(\d+)\)$/.exec(merge.message)![1]), merge.files.map((file) => file.filename)]),
    "every first-parent merge after the last green, oldest first, with its PR and changed files",
  );
  const prompt = briefOf(request);
  assert.match(prompt, /Merges since the last green main `cd482d430000`:/);
  for (const merge of MERGES) {
    assert.ok(prompt.includes(`#${/#(\d+)\)$/.exec(merge.message)![1]}`), `the brief names ${merge.message}`);
    for (const file of merge.files) assert.ok(prompt.includes(file.filename), `the brief names ${file.filename}`);
  }
  assert.ok(prompt.includes("backlog gardener proposes place for 2 task(s)"), "each merge carries its subject");

  // A first-parent chain that cannot be walked to the last green is said, never shown as an empty list.
  const short = await replayFix({}, GARDENER);
  assert.deepEqual(short.mergesSinceGreen?.merges, []);
  assert.match(short.mergesSinceGreen?.unreadable ?? "", /ends at febd1bb34/);
  assert.match(briefOf(short), /Merges since the last green main `cd482d430000`: unread \(the first-parent chain/);
});

test("W1-T9665: a merge that reaches a failing test through its import closure carries its diff", async () => {
  const request = await replayFix();
  const byPr = new Map((request.mergesSinceGreen?.merges ?? []).map((merge) => [merge.pr, merge] as [number | undefined, MainRepairMerge]));
  assert.equal(byPr.get(11997)?.reachesFailingTests, true, "#11997 shares no file with the test, but its import closure reaches it");
  assert.deepEqual(byPr.get(11997)?.reached, [FAILING_TEST]);
  assert.equal(byPr.get(11987)?.reachesFailingTests, true, "#11987 adds the failing test");
  assert.equal(byPr.get(12006)?.reachesFailingTests, false, "the plan-only merge reaches no failing test");
  const prompt = briefOf(request);
  assert.ok(prompt.includes("+export const REMEDY_OWNER_ONLY = true;"), "the reaching merge's unified diff is in the brief");
  assert.ok(prompt.includes("diff --git a/src/lib/ci-friction-remedy.ts b/src/lib/ci-friction-remedy.ts"));
  assert.ok(!prompt.includes("next-plan-only-line"), "a merge that reaches nothing carries its diff stat, not its diff");
  assert.ok(prompt.includes(" plan/tasks.d/W1-T9001-one.yaml | +2 -0"));
  assert.ok(prompt.indexOf("(#11997)") < prompt.indexOf("(#12006) chore(plan)"), "the reaching merges come first");

  // An unreadable affected-suites input is said, and never read as "no overlap".
  const unread = await replayFix({ readAffectedInput: () => Promise.reject(new Error("the tracked-file read exited 128")) });
  const remedy = unread.mergesSinceGreen?.merges.find((merge) => merge.pr === 11997);
  assert.equal(remedy?.reachesFailingTests, undefined);
  assert.match(remedy?.reachUnknown ?? "", /affected-suites input is unreadable: the tracked-file read exited 128/);
  const unreadPrompt = briefOf(unread);
  assert.ok(!unreadPrompt.includes("reaches none of the failing tests"), "unknown reach is never rendered as a miss");
  assert.match(unreadPrompt, /reach UNKNOWN: the affected-suites input is unreadable/);

  // A tree without the failing test cannot say a merge misses it.
  const stale = await replayFix({ readAffectedInput: async () => ({ files: new Map([...AFFECTED_FILES].filter(([path]) => path !== FAILING_TEST)), pathReaders: [] }) });
  const staleRemedy = stale.mergesSinceGreen?.merges.find((merge) => merge.pr === 11997);
  assert.equal(staleRemedy?.reachesFailingTests, undefined);
  assert.match(staleRemedy?.reachUnknown ?? "", /a tree without test\/a-ci-friction/);
  assert.equal(stale.mergesSinceGreen?.merges.find((merge) => merge.pr === 11987)?.reachesFailingTests, true, "a merge that adds the failing test still reaches it");
});

test("W1-T9665: two merges that reach the failing tests are named as a collision to repair together", async () => {
  const request = await replayFix();
  const prompt = briefOf(request);
  assert.match(prompt, /The red may be a COLLISION of `febd1bb34000` \(#11987\), `131248633000` \(#11997\)/);
  assert.match(prompt, /each was green on its own base/);
  const line = fixLine(prompt);
  assert.ok(line.includes("#11987") && line.includes("#11997"), `the fix line names the reaching merges: ${line}`);
  assert.ok(!line.includes("the merge above"), `the plan-only located merge is not the one to repair: ${line}`);
  assert.ok(!line.includes("037a58d8f"), line);

  // One reaching merge is no collision; a located merge that reaches the tests keeps today's line.
  const one: MainRepairFixRequest = {
    ...request,
    offendingSha: REMEDY,
    mergesSinceGreen: { ...request.mergesSinceGreen!, merges: request.mergesSinceGreen!.merges.filter((merge) => merge.pr !== 11987) },
  };
  const onePrompt = briefOf(one);
  assert.ok(!onePrompt.includes("COLLISION"));
  assert.equal(fixLine(onePrompt), "Fix EXACTLY ONE thing: make main green again by REPAIRING the defect the merge above introduced.");
});

test("W1-T9665: past the brief's budget, whole non-reaching merges are cut first and counted", () => {
  const merge = (n: number, reaches: boolean | undefined, diffLines = 0): MainRepairMerge => ({
    sha: sha(`a${n}`),
    pr: 12000 + n,
    subject: `merge ${n}`,
    files: [`src/lib/m${n}.ts`],
    diffStat: ` src/lib/m${n}.ts | +1 -0`,
    ...(reaches === undefined ? { reachUnknown: "not read" } : { reachesFailingTests: reaches }),
    ...(reaches ? { reached: [FAILING_TEST], diff: Array.from({ length: diffLines }, (_, i) => `+line ${i}`).join("\n") } : {}),
  });
  const misses = Array.from({ length: 30 }, (_, i) => merge(i + 2, false));
  const since = { afterGreenSha: GREEN, merges: [merge(1, true, 60), ...misses, merge(40, undefined)] };
  const text = rung.renderMainRepairMergesSinceGreen(since, 1500);
  assert.ok(text.includes("(#12001)") && text.includes("+line 59"), "the reaching merge keeps its whole diff");
  assert.ok(text.includes("(#12040)"), "a merge of unknown reach is kept before a known miss");
  const omitted = /\((\d+) more merge\(s\) omitted to fit the brief, none reaching a failing test/.exec(text);
  assert.ok(omitted, text);
  const shown = since.merges.filter((m) => text.includes(`(#${m.pr})`)).length;
  assert.ok(shown < since.merges.length && Number(omitted[1]) > 0);
  assert.equal(Number(omitted[1]) + shown, since.merges.length, "every merge is shown or counted");
  assert.ok(text.length <= 1500 + 600, `bounded: ${text.length}`);

  // A reaching diff past the budget keeps its head and counts the lines it cut.
  const huge = rung.renderMainRepairMergesSinceGreen({ afterGreenSha: GREEN, merges: [merge(1, true, 400), merge(2, false)] }, 1500);
  assert.ok(huge.includes("+line 0") && !huge.includes("+line 399"));
  assert.match(huge, /\(\d+ more diff lines omitted\)/);
  assert.match(huge, /\(1 more merge\(s\) omitted/);
  assert.ok(huge.length <= 1500 + 200, `bounded: ${huge.length}`);

  assert.match(rung.renderMainRepairMergesSinceGreen(undefined), /not read/);
  assert.match(rung.renderMainRepairMergesSinceGreen({ merges: [], unreadable: "this observation read no last green main" }), /unread \(this observation read no last green main\)/);
});
