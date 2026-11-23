import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import type { Config } from "#src/lib/config.js";
import { ownerFixLaneInstructions, ownerFixLaneRefusal, readFixRoundDiff, readPrConversation, type PrConversationRead } from "#src/lib/fix-round-gate-loosening.js";
import type { Mount } from "#src/lib/mounts.js";
import type { ReviewVerdict } from "#src/lib/review.js";
import type { SpawnWorkerArgs, WorkerResult } from "#src/lib/worker.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { runFixRung } from "#test/helpers/run-task-test.js";

const MOUNT: Mount = { model: "sonnet", effort: "medium", maxTurns: 10, contextBudget: 120000 };
const CORE_BASELINE = "scripts/example-baseline.json";
const CONSUMER_BASELINE = "scripts/core-read-contract-baseline.json";
const EXCLUSION = "config/shared-exclusions.json";
const OWNER_LINE = `Please do not change \`${EXCLUSION}\` from the fix lane.`;

async function round(t: TestContext, opts: {
  repo?: string;
  path: string;
  before: string;
  after: string;
  conversation?: PrConversationRead;
  generator?: boolean;
  unreadableDiff?: boolean;
  inheritedAllowance?: boolean;
}) {
  const repo = gitRepo({ scope: t });
  const file = join(repo.dir, opts.path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, opts.before);
  repo.git("add", ".");
  repo.git("commit", "-m", "test: seed pr head");
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  if (opts.inheritedAllowance) {
    mkdirSync(join(repo.dir, "scripts"), { recursive: true });
    writeFileSync(join(repo.dir, CORE_BASELINE), '{ "inherited": 10 }\n');
    repo.git("add", "--", CORE_BASELINE);
    repo.git("commit", "-m", "test: add inherited baseline");
  }
  const headSha = repo.git("rev-parse", "HEAD");
  const review: ReviewVerdict & { headSha: string; reviewerOutcome: string } = {
    state: "failure", criteria: [], testTheater: false, summary: "red", floorDegraded: false,
    capped: false, keywordOnly: false, planOnly: false, headSha, reviewerOutcome: "failure",
  };
  const repoName = opts.repo ?? "remudero";
  const rows: Record<string, unknown>[] = [];
  const prompts: string[] = [];
  const events: string[] = [];
  let pushes = 0;
  const commitEdit = (message: string) => {
    writeFileSync(file, opts.after);
    repo.git("add", "--", opts.path);
    repo.git("commit", "-m", message);
    return repo.git("rev-parse", "HEAD");
  };
  const readPrConversation = async () => {
    events.push("conversation");
    return opts.conversation ?? { prAuthor: { login: "submitter" }, body: "", comments: [] };
  };
  const deps = {
    ...(opts.unreadableDiff ? { scopeAmendmentGit: async () => { throw new Error("fixture git read failed"); } } : {}),
    spawn: async (args: SpawnWorkerArgs) => {
      events.push("worker");
      prompts.push(args.prompt);
      commitEdit("fix(ci): repair the red");
      return { sessionId: "fixture", text: "REPORT\nCOMMIT_MESSAGE: fix(ci): repair the red", blocks: [], stderr: "",
        subtype: "success", isError: false, apiError: false, costUsd: 0, numTurns: 1, permissionDenials: [],
        childEnvKeys: [], model: "sonnet", effort: "medium", tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
        modelUsage: {}, compactionEvents: [], qualitySuspect: false } as WorkerResult;
    },
    fetchPrBody: async () => "",
    waitForCiGreen: async () => { assert.equal(pushes, 1); return "green" as const; },
    runReview: async () => ({ ...review, state: "success" as const }),
    push: () => { pushes++; },
    issues: { create: () => assert.fail("unexpected escalation"), listOpen: () => [], comment() {} },
    ledgerPath: join(repo.dir, "ledger.ndjson"),
    log: (step: string, extra?: Record<string, unknown>) => { rows.push({ step, ...extra }); },
    say() {},
    account: (r: WorkerResult) => r,
    ...(opts.generator ? {
      packageScripts: { "docs-index": "generate", "docs-index:check": "check" },
      runGeneratorScript: async () => ({ status: 0, stdout: "", stderr: "" }),
      commitGeneratorOutput: ({ message }: { message: string }) => ({ changed: true, sha: commitEdit(message) }),
    } : {}),
  };
  const fixOptions = {
    taskId: "W1-T13611", runId: "gate-loosening-fixture",
    task: { id: "W1-T13611", title: "repair", repo: repoName, files: [opts.path] },
    prUrl: `https://github.com/craigoley/${repoName}/pull/2676`,
    branch: "run-W1-T13611-1", worktreePath: repo.dir, initialSessionId: "initial",
    mount: MOUNT, settingsFile: join(repo.dir, "settings.json"), config: { root: repo.dir } as Config,
    budgetUsd: 10, strikeCap: 1, initialReview: review,
    ciFailures: [{ name: "fixture", logTail: opts.generator ? "Run 'npm run docs-index' and commit the result." : "red" }],
    reviewBase: { owner: "craigoley", repo: repoName, headCheckoutDir: repo.dir, reviewerMount: MOUNT },
    readPrConversation,
    deps,
  };
  const outcome = await runFixRung(fixOptions);
  return { outcome, rows, prompts, events, pushes };
}

function assertRefused(result: Awaited<ReturnType<typeof round>>, reason: string, file: string | undefined, site = "rung.strike") {
  assert.equal(result.pushes, 0);
  assert.equal(result.outcome.outcome, "stood_down");
  const refused = result.rows.find(row => row.step === "fix.commit_refused");
  assert.equal(refused?.reason, reason);
  assert.equal(refused.site, site);
  assert.deepEqual(refused.files, file === undefined ? [] : [file]);
  const done = result.rows.filter(row => row.step === "fix.done");
  assert.equal(done.length, 1);
  assert.equal(done[0]?.subtype, "commit_refused");
}

test("W1-T13611 criterion 1 refuses added gate allowances at both push sites", async (t) => {
  for (const generator of [false, true]) {
    const result = await round(t, { path: CORE_BASELINE, before: "{}\n", after: '{ "legacy": 1 }\n', generator });
    assertRefused(result, "gate-loosening", CORE_BASELINE, generator ? "rung.generator_fix" : "rung.strike");
    assert.match(result.outcome.reason, /operator's yes.*W1-T11030/);
  }
  for (const path of ["config/osv-scanner.toml", ".github/semgrep/rules.yml", ".semgrepignore", ".gitleaksignore",
    ".trivyignore", ".github/workflows/ci.yml"]) {
    assertRefused(await round(t, { path, before: "# before\n", after: "# before\nignored\n" }), "gate-loosening", path);
  }
});

test("W1-T13611 criterion 2 refuses a consumer-repo baseline row", async (t) => {
  const result = await round(t, { repo: "remudero-console", path: CONSUMER_BASELINE,
    before: "[]\n", after: '[\n  { "route": "/v1/views/inbox-threads", "reason": "stale pin" }\n]\n' });
  assertRefused(result, "gate-loosening", CONSUMER_BASELINE);
});

test("W1-T13611 criterion 3 pushes a lowered ceiling and an ordinary repair", async (t) => {
  for (const [path, before, after] of [
    [CORE_BASELINE, '{\n  "ceiling": 10\n}\n', '{\n  "ceiling": 9\n}\n'],
    ["src/repair.ts", "export const n = 0;\n", "export const n = 1;\n"],
  ]) {
    const result = await round(t, { path, before, after, inheritedAllowance: path !== CORE_BASELINE });
    assert.equal(result.pushes, 1);
    assert.equal(result.outcome.outcome, "fixed", result.outcome.reason);
    assert.ok(!result.rows.some(row => row.step === "fix.commit_refused"));
  }
});

test("W1-T13611 criterion 4 carries and enforces eligible owner instructions", async (t) => {
  const result = await round(t, { path: EXCLUSION, before: "[]\n", after: '["legacy"]\n',
    conversation: { prAuthor: { login: "submitter" }, body: "", comments: [
      { user: { login: "maintainer", type: "User" }, author_association: "OWNER", body: OWNER_LINE },
      { user: { login: "robot[bot]", type: "Bot" }, author_association: "MEMBER", body: "Fix lane, do not change bots.json." },
      { user: { login: "outsider", type: "User" }, author_association: "NONE", body: "Fix lane, do not change outsiders.json." },
    ] },
  });
  assert.deepEqual(result.events, ["conversation", "worker"]);
  assert.match(result.prompts[0] ?? "", /OWNER INSTRUCTIONS/);
  assert.ok(result.prompts[0]?.includes(OWNER_LINE));
  assert.ok(!result.prompts[0]?.includes("bots.json"));
  assert.ok(!result.prompts[0]?.includes("outsiders.json"));
  assertRefused(result, "owner-refusal", EXCLUSION);
});

test("test/a-fix-round-never-adds-a-gate-exclusion-without-the-operator-yes.test.ts verifies PR conversation pagination", async () => {
  const calls: string[][] = [];
  const body = "No baseline change is in this PR until then. Please do not add one from the fix lane.";
  const authorLine = "Fix round, don't touch Dockerfile.";
  const memberLine = "Do not add tests. Never edit \`config/release.json\`.";
  const collaboratorLine = "Fix worker, don't introduce waivers.";
  const url = "https://github.com/craigoley/remudero-console/pull/2676";
  const read = await readPrConversation(url, args => {
    calls.push(args);
    if (args[0] === "pr") return { author: { login: "submitter", is_bot: false }, body };
    return [
      [{ user: { login: "SUBMITTER", type: "User" }, author_association: "NONE", body: authorLine }],
      [{ user: { login: "member", type: "User" }, author_association: "MEMBER", body: `For the fix lane:\n${memberLine}` },
       { user: { login: "collaborator", type: "User" }, author_association: "COLLABORATOR", body: collaboratorLine }],
    ];
  });
  assert.deepEqual(calls, [
    ["pr", "view", url, "--json", "author,body"],
    ["api", "repos/craigoley/remudero-console/issues/2676/comments?per_page=100", "--paginate", "--slurp"],
  ]);
  assert.ok(!("unreadable" in read));
  const instructions = ownerFixLaneInstructions(read);
  assert.deepEqual(instructions.map(({ line }) => line), [body, authorLine, memberLine, collaboratorLine]);
  const barred = [CONSUMER_BASELINE, "Dockerfile", "config/release.json", "config/waivers.yaml"];
  assert.deepEqual(ownerFixLaneRefusal([...barred, "src/unrelated.ts"], instructions)?.files, barred);
  assert.equal(ownerFixLaneRefusal(["src/unrelated.ts"], instructions), undefined);
});

test("an unreadable PR conversation or round diff stands down at its read boundary", async (t) => {
  assert.deepEqual(await readPrConversation("invalid", () => assert.fail("invalid PR URL queried")), {
    unreadable: "unrecognized pull request URL",
  });
  const url = "https://github.com/craigoley/remudero-console/pull/2676";
  const read = await readPrConversation(url, args => {
    if (args[0] === "pr") return { author: { login: "submitter" }, body: "" };
    throw new Error("fixture comments unavailable");
  });
  assert.deepEqual(read, { unreadable: "Error: fixture comments unavailable" });
  const edit = { path: "src/repair.ts", before: "export {};\n", after: "export const n = 1;\n" };
  const beforeDispatch = await round(t, { ...edit, conversation: read });
  assert.deepEqual(beforeDispatch.events, ["conversation"]);
  assert.equal(beforeDispatch.outcome.outcome, "stood_down");
  assert.match(beforeDispatch.outcome.reason, /comments unavailable/);
  assertRefused(await round(t, { ...edit, conversation: read, generator: true }), "pr-conversation-unreadable", undefined, "rung.generator_fix");

  const beforePush = await round(t, { ...edit, unreadableDiff: true });
  assert.equal(beforePush.pushes, 0);
  assert.equal(beforePush.outcome.outcome, "stood_down");
  assert.match(beforePush.outcome.reason, /fixture git read failed/);
  assert.equal(beforePush.rows.find(row => row.step === "fix.commit_refused")?.reason, "round-diff-unreadable");
  assert.deepEqual(await readFixRoundDiff("prior", undefined, () => assert.fail("unpinned diff queried")), {
    unreadable: "the PR head or the round head could not be pinned",
  });
  assert.deepEqual(await readFixRoundDiff("prior", "head", () => ""), { diffFiles: [], diff: "" });
});
