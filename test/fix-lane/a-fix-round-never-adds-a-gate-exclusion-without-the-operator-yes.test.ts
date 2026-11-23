import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { withGhShim } from "#test/helpers/gh-shim.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { runFixRung, type FixCommandHost } from "#src/cli/commands/fix.js";
import type { WorkerResult } from "#src/lib/worker.js";

const commentsQuery = (repo: string) => `repos/craigoley/${repo}/issues/42/comments?per_page=100 --paginate --slurp`;
const coreBaseline = "scripts/fix-fixture-baseline.json";
const consumerBaseline = "scripts/core-read-contract-baseline.json";
const author = { login: "pr-author", type: "User" };
const mount = { model: "sonnet", effort: "medium", maxTurns: 20, contextBudget: 120000, provider: "claude" } as const;
const report: WorkerResult = {
  sessionId: "fix", costUsd: 0, numTurns: 1, text: "COMMIT_MESSAGE: fix(ci): repair the round",
  blocks: [], stderr: "", subtype: "success", isError: false, apiError: false, permissionDenials: [],
  childEnvKeys: [], model: "sonnet", effort: "medium", tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
  modelUsage: {}, compactionEvents: [], qualitySuspect: false,
};

type Comment = { user: typeof author; author_association: string; body: string };
class PushReached extends Error {}
class UnexpectedPushError extends Error {}

async function round(t: TestContext, input: {
  file: string; before: string; after: string; repoName?: string; body?: string; comments?: Comment[];
  generator?: boolean; unreadable?: string; unreadableDiff?: boolean;
}) {
  const repo = gitRepo({ scope: t });
  const target = join(repo.dir, input.file);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, input.before);
  writeFileSync(join(repo.dir, ".gitignore"), "state/\nsettings.json\n");
  repo.git("add", "--all");
  repo.git("commit", "-m", "fixture: seed PR head");
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  const head = repo.git("rev-parse", "HEAD");
  const review = { state: "failure" as const, criteria: [{ claim: "repair", proof: "unit test: repair", met: false,
    reason: "red", proof_exec: "not_executable" as const }], testTheater: false, summary: "red", floorDegraded: false,
    capped: false, keywordOnly: false, planOnly: false, headSha: head, reviewerOutcome: "failure" };
  const repoName = input.repoName ?? "remudero";
  const prUrl = `https://github.com/craigoley/${repoName}/pull/42`;
  const commentsPath = commentsQuery(repoName);
  const task = { id: "W1-T13611", title: "repair CI", repo: repoName, files: [input.file],
    design: `Repair CI. The task allows an edit to ${input.file}.` };
  const events: { step: string; fields: Record<string, unknown> }[] = [];
  const prompts: string[] = [];
  const scripts: string[] = [];
  const readsBeforeSpawn: number[] = [];
  let conversationReads = () => 0;
  let pushes = 0;
  const commit = () => {
    repo.git("add", "--", input.file);
    repo.git("commit", "-m", "fix(ci): repair the round");
    return { changed: true, sha: repo.git("rev-parse", "HEAD") };
  };
  const host = {
    workerBoundaryStack: {},
    prNumberFromRef: () => 42,
    fetchPrBodyViaGh: async () => input.body ?? "",
    fixRoundGitOwnership: () => ({ harnessCommits: false, cashTools: undefined }),
    fixCensusAppliesToRepo: () => false,
    readWorktreeHeadReflog: () => undefined,
    fixWorkerRunId: (runId, label) => `${runId}-${label}`,
    fixWorkerReceipt: spawn => ({ spawn, joinFields: () => ({}), ledgerFields: () => ({}) }),
    withPredecessorTranscriptCopies: (args, _opts, spawn) => spawn(args),
    spawnFixWorkerBounded: async ({ spawn }, args) => ({ kind: "spawned", result: await spawn(args), elapsedMs: 0 }),
    checkFixCensusSnapshotAsync: async () => undefined,
    workerCreatedCurrentHead: () => repo.git("rev-parse", "HEAD") !== head,
    commitsAhead: (_worktree, base) => Number(repo.git("rev-list", "--count", `${base}..HEAD`)),
    harnessCommitForShellLessWorker: ({ commitCount }) => commitCount,
    buildImportClosureRead: () => async () => undefined,
    archiveWorkerTranscript: () => undefined,
    harvestFollowupsFromReport: () => {},
  } satisfies Partial<FixCommandHost>;
  const deps = {
    ...(input.unreadableDiff ? { scopeAmendmentGit: async () => { throw new Error("object missing"); } } : {}),
    ...(input.generator ? {
      packageScripts: { "fixture-baseline": "generator", "fixture-baseline:check": "generator --check" },
      runGeneratorScript: async (script: string) => {
        scripts.push(script);
        writeFileSync(target, input.after);
        return { status: 0, stdout: "", stderr: "" };
      },
      commitGeneratorOutput: commit,
    } : {}),
    spawn: async ({ prompt }: { prompt: string }) => {
      readsBeforeSpawn.push(conversationReads());
      prompts.push(prompt);
      writeFileSync(target, input.after);
      commit();
      return report;
    },
    push: () => { pushes++; throw new PushReached(); },
    waitForCiGreen: async () => assert.fail("a refused commit never waits for CI"),
    runReview: async () => assert.fail("a refused commit never requests another review"),
    fetchPrBody: host.fetchPrBodyViaGh,
    issues: { create: () => assert.fail("unexpected escalation"), listOpen: () => [], comment: () => {} },
    ledgerPath: join(repo.dir, "state", "ledger.ndjson"),
    log: (step: string, fields: Record<string, unknown> = {}) => events.push({ step, fields }),
    say: () => {},
    account: (result: WorkerResult) => result,
  };
  const body = input.body ?? "";
  return withGhShim([
    { when: `pr view ${prUrl} --json author,body`, stdout: JSON.stringify({ author, body }) },
    input.unreadable === undefined
      ? { when: commentsPath, stdout: JSON.stringify([input.comments ?? []]) }
      : { when: commentsPath, exit: 1, stderr: input.unreadable },
  ], async shim => {
    conversationReads = () => shim.calls().filter(call => call.includes(commentsPath)).length;
    const outcome = await runFixRung({ taskId: task.id, runId: "fixture", task,
      prUrl, branch: "run-W1-T13611-1", worktreePath: repo.dir, initialSessionId: "initial", mount,
      settingsFile: join(repo.dir, "settings.json"), config: { root: repo.dir, claudeBin: "claude" }, budgetUsd: 1, strikeCap: 2,
      initialReview: review, reviewBase: { owner: "craigoley", repo: repoName, headCheckoutDir: repo.dir, reviewerMount: mount },
      ...(input.generator ? { ciFailures: [{ name: "fixture-baseline:check", logTail: "Run 'npm run fixture-baseline' and commit the result." }] } : {}),
      deps,
    }, { ...host, FixRoundPushError: UnexpectedPushError } as unknown as FixCommandHost).catch((error: unknown) => {
      if (!(error instanceof PushReached)) throw error;
    });
    return { events, outcome, prompts, pushes, head, scripts, readsBeforeSpawn, conversationReads: conversationReads() };
  });
}

function assertRefused(result: Awaited<ReturnType<typeof round>>, reason: string, files: string[], site = "rung.strike") {
  assert.equal(result.pushes, 0);
  assert.equal(result.outcome?.outcome, "stood_down");
  const refusals = result.events.filter(({ step }) => step === "fix.commit_refused");
  assert.equal(refusals.length, 1);
  assert.equal(refusals[0].fields.reason, reason);
  assert.equal(refusals[0].fields.site, site);
  assert.equal(refusals[0].fields.head_sha, result.head);
  assert.deepEqual(refusals[0].fields.files, files);
  const done = result.events.filter(({ step }) => step === "fix.done");
  assert.equal(done.length, 1);
  assert.equal(done[0].fields.subtype, "commit_refused");
}

const ceiling = '{\n  "files": {\n    "src/existing.ts": 20\n  }\n}\n';
const tighterCeiling = ceiling.replace("20", "19");

test("W1-T13611 criterion 1 refuses a core baseline addition despite declared scope", async t => {
  const result = await round(t, { file: coreBaseline, before: ceiling,
    after: ceiling.replace('20\n', '20,\n    "src/another.ts": 20\n') });
  assertRefused(result, "gate-loosening", [coreBaseline]);
  assert.match(result.outcome?.reason ?? "", /operator's yes.*W1-T11030/);
});

test("W1-T13611 criterion 2 refuses a consumer baseline row", async t => {
  const result = await round(t, { file: consumerBaseline, repoName: "remudero-console", before: "[]\n",
    after: '[\n  {"route": "/v1/views/inbox-threads", "reason": "stale pin"}\n]\n' });
  assertRefused(result, "gate-loosening", [consumerBaseline]);
});

test("W1-T13611 criterion 3 pushes tightening and ordinary changes", async t => {
  const tightening = await round(t, { file: coreBaseline, before: ceiling, after: tighterCeiling });
  assert.equal(tightening.pushes, 1);
  assert.equal(tightening.events.some(({ step }) => step === "fix.commit_refused"), false);
  const ordinary = await round(t, { file: "docs/repair.md", before: "typo\n", after: "fixed\n" });
  assert.equal(ordinary.pushes, 1);
});

test("W1-T13611 criterion 4 carries eligible refusals verbatim and enforces them before push", async t => {
  const body = "Fix worker: never edit `docs/repair.md`.";
  const owner = `  Please do not change \`${coreBaseline}\` in the fix lane.  `;
  const bot = "Fix lane: do not edit `src/bot.ts`.";
  const outsider = "Fix lane: do not edit `src/other.ts`.";
  const result = await round(t, { file: coreBaseline, before: ceiling, after: tighterCeiling, body, comments: [
    { user: { login: "maintainer", type: "User" }, author_association: "MEMBER", body: owner },
    { user: { login: "automation[bot]", type: "Bot" }, author_association: "OWNER", body: bot },
    { user: { login: "stranger", type: "User" }, author_association: "NONE", body: outsider },
  ] });
  assertRefused(result, "owner-refusal", [coreBaseline]);
  assert.deepEqual(result.readsBeforeSpawn, [1]);
  assert.equal(result.conversationReads, 1);
  assert.equal(result.prompts.length, 1);
  const prompt = result.prompts[0];
  assert.match(prompt, /OWNER INSTRUCTIONS/);
  assert.match(prompt, /leave the push to the harness/);
  assert.ok(prompt.includes(`\n${owner}\n`));
  assert.ok(prompt.includes(body));
  assert.ok(!prompt.includes(bot) && !prompt.includes(outsider));
});

test("the earlier PR-body prohibition on adding a baseline also covers tightening it", async t => {
  const result = await round(t, { file: coreBaseline, before: ceiling, after: tighterCeiling, body:
    "No baseline change is in this PR until then. Please do not add one from the fix lane." });
  assertRefused(result, "owner-refusal", [coreBaseline]);
});

test("a generator round cannot push an exclusion either", async t => {
  const file = "config/osv-scanner.toml";
  const result = await round(t, { file, before: "", after: '[[IgnoredVulns]]\nid = "GHSA-fixture"\n', generator: true });
  assert.deepEqual(result.scripts, ["fixture-baseline", "fixture-baseline:check"]);
  assert.equal(result.prompts.length, 0);
  assertRefused(result, "gate-loosening", [file], "rung.generator_fix");
});

test("a read failure stands down before dispatch", async t => {
  const result = await round(t, { file: coreBaseline, before: ceiling, after: tighterCeiling, unreadable: "comment page failed" });
  assert.equal(result.prompts.length, 0);
  assert.equal(result.pushes, 0);
  assert.equal(result.outcome?.outcome, "stood_down");
  assert.match(result.outcome.reason, /comment page failed/);
});

test("an unreadable round diff cannot authorize a push", async t => {
  const result = await round(t, { file: coreBaseline, before: ceiling, after: tighterCeiling, unreadableDiff: true });
  assertRefused(result, "round-diff-unreadable", []);
  assert.match(result.outcome?.reason ?? "", /object missing/);
});

test("test/a-fix-round-never-adds-a-gate-exclusion-without-the-operator-yes.test.ts parses every comment page and reports a malformed page", async () => {
  const { readPrConversation, ownerFixLaneInstructions } = await import("#src/lib/fix-round-gate-loosening.js");
  const url = "https://github.com/craigoley/remudero/pull/42";
  const commentsPath = commentsQuery("remudero");
  const first = { user: author, author_association: "NONE", body: "Fix round: don't edit `docs/repair.md`." };
  const last = { user: { login: "collaborator" }, author_association: "COLLABORATOR", body: "Fix lane: never add an exclusion." };
  await withGhShim([
    { when: `pr view ${url} --json author,body`, stdout: JSON.stringify({ author, body: null }) },
    { when: commentsPath, stdout: JSON.stringify([[first], [last]]) },
  ], async shim => {
    const result = await readPrConversation(url);
    assert.ok(!("unreadable" in result), JSON.stringify(result));
    assert.deepEqual(result.comments, [first, last]);
    assert.deepEqual(ownerFixLaneInstructions(result).map(({ line }) => line), [first.body, last.body]);
    assert.equal(shim.calls().length, 2);
  });
  const failed = await readPrConversation(url, args => args[0] === "pr" ? { author, body: "" } : [{ invalid: true }]);
  assert.ok("unreadable" in failed);
});
