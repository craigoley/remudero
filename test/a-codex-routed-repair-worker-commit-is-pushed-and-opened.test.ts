/**
 * W1-T9667 — A CODEX-ROUTED REPAIR WORKER'S COMMIT IS PUSHED AND OPENED BY THE DISPATCHER.
 *
 * 2026-10-15 13:35-13:53Z: main was red at 037a58d8f and the main-repair lane ran three fix rounds. Each was routed to a
 * codex writer, whose sandbox cannot write the git dir and is told never to push (W1-T6148): the harness committed its
 * edits LOCALLY (`commitCodexWriterEdits`) and nothing pushed them. Rounds 1 and 3 ended `main-repair.no_pr`; round 2's
 * REST open of the never-pushed head got HTTP 422 with both placeholder lines still in its body. These fixtures replay
 * that worker: the dispatcher now pushes a harness commit from the host, confirms it by ls-remote, and only then opens.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { AlertLaneAlert } from "../src/lib/alert-lane.js";
import type { Config } from "../src/lib/config.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import type { MainRepairFixRequest } from "../src/lib/main-health-rung.js";
import type { Mount } from "../src/lib/mounts.js";
import type { GhApiFetcher } from "../src/lib/open-prs-rest.js";
import { alertOriginId, alertTaskId } from "../src/lib/ops.js";
import { inertAcceptanceProofs } from "../src/lib/proof-grammar.js";
import { parseAcceptanceBlock } from "../src/lib/review.js";
import { readLedgerLines } from "../src/lib/status.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { commitCodexWriterEdits, type CodexHarnessCommit } from "../src/lib/worker-provider.js";
import { worktreeAddAsync, type SpawnWorkerArgs, type WorkerResult } from "../src/lib/worker.js";
import {
  type AlertFixDispatchDeps,
  alertFixPrompt,
  dispatchAlertFixRun,
  dispatchMainRepairFixRun,
  MAIN_REPAIR_ACCEPTANCE_PLACEHOLDER,
  MAIN_REPAIR_PROSE_PLACEHOLDER,
  mainRepairFixPrompt,
  mainRepairTaskId,
} from "../src/run-task.js";
import { GIT_REPO_FIXTURE_IDENTITY, gitRepo } from "./helpers/git-repo.js";

const OWNER = "craigoley";
const RED_MERGE = "037a58d8f".padEnd(40, "0"); // the 2026-10-15 red merge
const HEAD = "cd482d436".padEnd(40, "0");
const FAILING_TEST = "test/a-ci-friction-cause-owned-by-a-test-alone-escalates-as-no-owner.test.ts";
const FIX_PR = `https://github.com/${OWNER}/fixture-repo/pull/12099`;
const HARNESS_SHA = "9667".padEnd(40, "a");
const MOUNT: Mount = { model: "fake-model", effort: "low", maxTurns: 5, contextBudget: 1000 };
const SUBJECT = "fix(test): seed the no-owner fixture with its owning test";
const FIX_DIFF = [
  "diff --git a/test/fixtures/no-owner.ts b/test/fixtures/no-owner.ts",
  "--- a/test/fixtures/no-owner.ts",
  "+++ b/test/fixtures/no-owner.ts",
  "@@ -1,0 +2 @@",
  '+export const owningTest = "a-ci-friction-cause-owned-by-a-test-alone";',
].join("\n");
const ALERT: AlertLaneAlert = {
  source: "code-scanning",
  id: "9667",
  severity: "medium",
  state: "open",
  createdAt: "2026-10-15T00:00:00Z",
  summary: "W1-T9667 fixture alert",
  url: "https://github.com/craigoley/fixture-repo/security/code-scanning/9667",
  path: "src/lib/some-file.ts",
};

function request(testFiles: readonly string[]): MainRepairFixRequest {
  return {
    branch: "main",
    headSha: HEAD,
    offendingSha: RED_MERGE,
    offendingPr: 11997,
    diffStat: " src/lib/ci-friction.ts | +12 -2",
    failingChecks: ["ci"],
    failingTestTitles: ["a ci-friction cause owned by a test alone escalates as no owner"],
    testFiles,
    logExcerpt: `not ok 1 - ${FAILING_TEST}`,
    reason: "required check ci failed",
  };
}

/** A codex writer's result as worker-provider.ts returns it: no PR_URL, and the harness's own commit outcome. */
function codexResult(harnessCommit: CodexHarnessCommit | undefined, text = `done\nCOMMIT_MESSAGE: ${SUBJECT}\n`): WorkerResult {
  return {
    provider: "codex",
    ...(harnessCommit === undefined ? {} : { harnessCommit }),
    sessionId: "s-t9667",
    costUsd: 0,
    numTurns: 1,
    text,
    blocks: [],
    stderr: "",
    subtype: "success",
    isError: false,
    apiError: false,
    permissionDenials: [],
    childEnvKeys: [],
    model: "sonnet",
    routedModel: "gpt-6.1-sol",
    effort: "default",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {},
    compactionEvents: [],
    qualitySuspect: false,
  } as unknown as WorkerResult;
}

/** The REST create, as `ratifyPrCreateRestArgs` builds it: `-f key=value` pairs. */
function restOpener(opened: Array<Record<string, string>>, before?: () => void): GhApiFetcher {
  return ((args: string[]) => {
    before?.();
    const fields: Record<string, string> = {};
    args.forEach((arg, i) => {
      if (args[i - 1] !== "-f") return;
      const eq = arg.indexOf("=");
      fields[arg.slice(0, eq)] = arg.slice(eq + 1);
    });
    opened.push(fields);
    return { html_url: FIX_PR };
  }) as GhApiFetcher;
}

/** A faked dispatch: a codex worker, a host push that lands `remote[branch]`, and a REST open. */
function harness(result: (args: SpawnWorkerArgs) => WorkerResult, opts: { pushLands?: boolean; pushThrows?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t9667-`));
  const ledgerPath = join(root, "ledger.ndjson");
  const events: string[] = [];
  const pushes: string[] = [];
  const opened: Array<Record<string, string>> = [];
  const prompts: string[] = [];
  const remote = new Map<string, string>();
  const branches: string[] = [];
  const trailers: string[] = [];
  const deps: AlertFixDispatchDeps = {
    worktreeAdd: (_repoDir, _path, branch) => {
      branches.push(branch);
    },
    worktreeRemove: () => {},
    renderWorkerSettings: () => "/tmp/fake-settings.json",
    loadMounts: () => ({}) as never,
    resolveMount: () => MOUNT,
    spawn: async (args) => {
      const worker = result(args);
      prompts.push(args.promptFor?.({ provider: worker.provider ?? "claude", harnessOwnsGit: worker.provider === "codex" }) ?? args.prompt);
      return worker;
    },
    ensureTaskTrailer: (prUrl) => {
      trailers.push(prUrl);
    },
    checkAcceptance: () => ({ ok: true }) as never,
    readPrBody: () => "",
    fetch: restOpener(opened, () => events.push("open")),
    readDiff: () => FIX_DIFF,
    readHeadSubject: () => SUBJECT,
    pushBranch: async (_wt, sha) => {
      events.push("push");
      pushes.push(sha);
      if (opts.pushThrows) throw new Error("! [rejected] the pre-push census refused the push");
      if (opts.pushLands !== false) remote.set(branches.at(-1)!, sha);
    },
    readRemoteBranchHead: async (_wt, branch) => {
      events.push("ls-remote");
      return remote.get(branch);
    },
  };
  return {
    ledgerPath,
    events,
    pushes,
    opened,
    prompts,
    branches,
    trailers,
    deps,
    steps: () => readLedgerLines(ledgerPath).map((row) => String(row.step)), // ledger-read-intent: live
    rows: (step: string) => readLedgerLines(ledgerPath).filter((row) => row.step === step), // ledger-read-intent: live
    main: (req: MainRepairFixRequest) => dispatchMainRepairFixRun(OWNER, "fixture-repo", { root } as Config, req, ledgerPath, "R", deps),
    alert: () => dispatchAlertFixRun(OWNER, "fixture-repo", { root } as Config, ALERT, ledgerPath, "ALERT-R", deps),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function assertNoPlaceholder(body: string): void {
  assert.ok(!body.includes("WORKER-PROSE"), "no prose placeholder line is opened");
  assert.ok(!body.includes("WORKER-ACCEPTANCE"), "no bullets placeholder line is opened");
  assert.ok(!body.includes(MAIN_REPAIR_PROSE_PLACEHOLDER) && !body.includes(MAIN_REPAIR_ACCEPTANCE_PLACEHOLDER));
}

test("W1-T9667: a harness-committed main-repair round is pushed and opened by the dispatcher", async () => {
  // 1. The 13:48Z round, for real: a real origin, the lane's own worktree, the harness's own commit, the default push
  //    and ls-remote. The open sees the branch already on origin at the harness commit.
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t9667-real-`));
  const origin = gitRepo({ bare: true, kind: "t9667-origin" });
  const seed = gitRepo({ kind: "t9667-seed" });
  const identity: Record<string, string> = {
    GIT_AUTHOR_NAME: GIT_REPO_FIXTURE_IDENTITY.name,
    GIT_AUTHOR_EMAIL: GIT_REPO_FIXTURE_IDENTITY.email,
    GIT_COMMITTER_NAME: GIT_REPO_FIXTURE_IDENTITY.name,
    GIT_COMMITTER_EMAIL: GIT_REPO_FIXTURE_IDENTITY.email,
  };
  const saved = { ...process.env };
  Object.assign(process.env, identity);
  try {
    mkdirSync(join(root, "repos"), { recursive: true });
    symlinkSync(seed.dir, join(root, "repos", "fixture-repo"));
    seed.addRemote("origin", origin.dir);
    seed.git("push", "--quiet", "origin", "main");
    seed.git("fetch", "--quiet", "origin");
    const opened: Array<Record<string, string>> = [];
    const commits: CodexHarnessCommit[] = [];
    let branch = "";
    let originAtOpen: string | undefined;
    const deps: AlertFixDispatchDeps = {
      worktreeAdd: async (dir, path, b, start, extra) => {
        branch = b;
        await worktreeAddAsync(dir, path, b, start, extra);
      },
      worktreeRemove: () => {},
      renderWorkerSettings: () => "/tmp/fake-settings.json",
      loadMounts: () => ({}) as never,
      resolveMount: () => MOUNT,
      spawn: async (args) => {
        mkdirSync(join(args.cwd, "test", "fixtures"), { recursive: true });
        writeFileSync(join(args.cwd, "test", "fixtures", "no-owner.ts"), 'export const owningTest = "a-ci-friction-cause-owned-by-a-test-alone";\n');
        const commit = commitCodexWriterEdits(args.cwd, `done\nCOMMIT_MESSAGE: ${SUBJECT}\n`);
        commits.push(commit);
        return codexResult(commit);
      },
      ensureTaskTrailer: () => {},
      checkAcceptance: () => ({ ok: true }) as never,
      fetch: restOpener(opened, () => {
        originAtOpen = origin.git("rev-parse", "--verify", "--quiet", `refs/heads/${branch}`);
      }),
    };
    const ledgerPath = join(root, "ledger.ndjson");
    const prUrl = await withLiveWritesAllowed(() =>
      dispatchMainRepairFixRun(OWNER, "fixture-repo", { root } as Config, request([FAILING_TEST]), ledgerPath, "R", deps),
    );
    assert.equal(prUrl, FIX_PR);
    const [commit] = commits;
    assert.equal(commit?.outcome, "committed", "the harness committed the codex worker's edit");
    const sha = (commit as { sha: string }).sha;
    assert.equal(originAtOpen, sha, "origin held the harness commit BEFORE the PR was opened");
    const [pr, ...more] = opened;
    assert.equal(more.length, 0);
    assert.equal(pr?.head, branch);
    assert.equal(pr?.title, SUBJECT, "titled with the worker's COMMIT_MESSAGE subject");
    assertNoPlaceholder(pr!.body!);
    assert.ok(pr!.body!.includes(RED_MERGE) && pr!.body!.includes(FAILING_TEST), "the dispatcher's sentence names the sha and the test");
    assert.deepEqual(parseAcceptanceBlock(pr!.body!).map((c) => c.proof), [`unit test: ${FAILING_TEST}`], "the dispatcher's block is kept");
    assert.equal(pr!.body!.trimEnd().split("\n").at(-1), `Remudero-Task: ${mainRepairTaskId(RED_MERGE)}`);
    const steps = readLedgerLines(ledgerPath).map((row) => String(row.step)); // ledger-read-intent: live
    assert.ok(steps.includes("main-repair.pushed") && steps.includes("main-repair.pr_opened"), steps.join(","));
    assert.ok(!steps.includes("main-repair.no_pr"));
  } finally {
    for (const key of Object.keys(identity)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    origin.cleanup();
    seed.cleanup();
    rmSync(root, { recursive: true, force: true });
  }

  // 2. With no parsed test file the worker (whose sandbox cannot reach the body file) left both placeholders: the push
  //    precedes the open, and the opened body carries the dispatcher's sentence and a grep of the pushed line.
  const h = harness(() => codexResult({ outcome: "committed", sha: HARNESS_SHA }));
  try {
    assert.equal(await h.main(request([])), FIX_PR);
    assert.deepEqual(h.pushes, [HARNESS_SHA]);
    assert.deepEqual(h.events, ["push", "ls-remote", "open"], "pushed, confirmed, then opened");
    const [pr] = h.opened;
    assertNoPlaceholder(pr!.body!);
    assert.match(pr!.body!, new RegExp(`red since \`${RED_MERGE}\``));
    assert.deepEqual(inertAcceptanceProofs(pr!.body!), []);
    assert.equal(parseAcceptanceBlock(pr!.body!).length, 1, "one grep of a line the pushed repair adds");
    assert.equal(pr!.body!.trimEnd().split("\n").at(-1), `Remudero-Task: ${mainRepairTaskId(RED_MERGE)}`);
    assert.deepEqual(h.trailers, [FIX_PR]);
  } finally {
    h.cleanup();
  }
});

test("W1-T9667: no PR is opened for an unpushed head and an empty harness commit is named", async () => {
  const cases: Array<{ label: string; result: WorkerResult; opts?: { pushLands?: boolean; pushThrows?: boolean }; step: string; pushes: number }> = [
    { label: "push refused", result: codexResult({ outcome: "committed", sha: HARNESS_SHA }), opts: { pushThrows: true }, step: "main-repair.push_failed", pushes: 1 },
    { label: "push never landed", result: codexResult({ outcome: "committed", sha: HARNESS_SHA }), opts: { pushLands: false }, step: "main-repair.push_unconfirmed", pushes: 1 },
    { label: "nothing to commit", result: codexResult({ outcome: "nothing-to-commit" }), step: "main-repair.no_change", pushes: 0 },
    { label: "commit refused", result: codexResult({ outcome: "refused", reason: "include.path is not allowed" }), step: "main-repair.harness_commit_refused", pushes: 0 },
  ];
  for (const testFiles of [[FAILING_TEST], []]) {
    for (const c of cases) {
      const h = harness(() => c.result, c.opts);
      try {
        assert.equal(await h.main(request(testFiles)), undefined, c.label);
        assert.deepEqual(h.opened, [], `${c.label}: no PR is opened`);
        assert.equal(h.pushes.length, c.pushes, `${c.label}: pushes`);
        assert.equal(h.rows(c.step).length, 1, `${c.label}: the named row ${c.step}; saw ${h.steps().join(",")}`);
        assert.equal(h.rows("main-repair.no_pr").length, 0, `${c.label}: not the generic no_pr`);
      } finally {
        h.cleanup();
      }
    }
  }
  const refused = harness(() => codexResult({ outcome: "refused", reason: "include.path is not allowed" }));
  try {
    await refused.main(request([]));
    assert.equal(refused.rows("main-repair.harness_commit_refused")[0]?.reason, "include.path is not allowed");
  } finally {
    refused.cleanup();
  }
  // A worker told to push that reports PUSHED but whose branch is absent on origin: the 422 is never requested.
  const claude = harness(() => ({ ...codexResult(undefined, "REPORT\nPUSHED: run-main-repair\n"), provider: "claude" }) as WorkerResult);
  try {
    assert.equal(await claude.main(request([])), undefined);
    assert.deepEqual(claude.opened, []);
    assert.equal(claude.rows("main-repair.unpushed_head").length, 1, claude.steps().join(","));
  } finally {
    claude.cleanup();
  }
});

test("W1-T9667: a harness-committed alert-fix round is pushed and opened by the dispatcher", async () => {
  const h = harness(() => codexResult({ outcome: "committed", sha: HARNESS_SHA }));
  try {
    await h.alert();
    assert.deepEqual(h.pushes, [HARNESS_SHA]);
    assert.deepEqual(h.events, ["push", "ls-remote", "open"], "pushed, confirmed, then opened");
    const [pr, ...more] = h.opened;
    assert.equal(more.length, 0);
    assert.equal(pr?.head, h.branches[0]);
    assert.equal(pr?.base, "main");
    assert.equal(pr?.title, SUBJECT);
    const body = pr!.body!;
    assertNoPlaceholder(body);
    assert.match(body, new RegExp(`^origin: alert#${alertOriginId(ALERT)}$`, "m"));
    assert.equal(body.trimEnd().split("\n").at(-1), `Remudero-Task: ${alertTaskId(ALERT)}`, "the trailer is the last line");
    assert.equal(parseAcceptanceBlock(body).length, 1);
    assert.deepEqual(inertAcceptanceProofs(body), [], "the bullets are checked like main-repair's");
    assert.deepEqual(h.trailers, [FIX_PR]);
    assert.equal(h.rows("alert-fix.pr_opened").length, 1);
    assert.equal(h.rows("alert-fix.no_pr").length, 0);
  } finally {
    h.cleanup();
  }
  const empty = harness(() => codexResult({ outcome: "nothing-to-commit" }));
  try {
    await empty.alert();
    assert.deepEqual(empty.opened, []);
    assert.equal(empty.rows("alert-fix.no_change").length, 1, empty.steps().join(","));
    assert.equal(empty.rows("alert-fix.no_pr").length, 0);
  } finally {
    empty.cleanup();
  }
  const unpushed = harness(() => codexResult({ outcome: "committed", sha: HARNESS_SHA }), { pushLands: false });
  try {
    await unpushed.alert();
    assert.deepEqual(unpushed.opened, [], "never opened over an unpushed head");
    assert.equal(unpushed.rows("alert-fix.push_unconfirmed").length, 1);
  } finally {
    unpushed.cleanup();
  }
});

test("W1-T9667: a harness-owned repair prompt names no push or PR open", async () => {
  const BODY = "/root/tmp/repair-body.md";
  for (const testFiles of [[FAILING_TEST], []]) {
    const owned = mainRepairFixPrompt(request(testFiles), BODY, true);
    assert.ok(!owned.includes("git push") && !owned.includes("gh pr create"), owned);
    assert.match(owned, /run NO git or gh command/);
    assert.match(owned, /COMMIT_MESSAGE:/);
    assert.ok(owned.includes(BODY), "the body file is still named");
    const claude = mainRepairFixPrompt(request(testFiles), BODY);
    assert.equal(mainRepairFixPrompt(request(testFiles), BODY, false), claude);
    assert.ok(claude.includes("`git push origin HEAD` (NOT -u); never push to main;"), "a claude-routed worker still pushes");
  }
  const ownedAlert = alertFixPrompt(ALERT, alertTaskId(ALERT), { bodyFile: BODY });
  assert.ok(!ownedAlert.includes("git push") && !ownedAlert.includes("gh pr create"), ownedAlert);
  assert.ok(ownedAlert.includes(`THE PR BODY IS ALREADY WRITTEN, by the dispatcher, at: ${BODY}`));
  assert.ok(ownedAlert.includes(MAIN_REPAIR_ACCEPTANCE_PLACEHOLDER));
  const claudeAlert = alertFixPrompt(ALERT, alertTaskId(ALERT));
  assert.ok(claudeAlert.includes("`git push origin HEAD` (NOT -u);") && claudeAlert.includes("gh pr create"));
  assert.ok(!claudeAlert.includes("THE PR BODY IS ALREADY WRITTEN"));
  // The selected provider, rather than the requested mount, determines the prompt contract.
  const h = harness(() => codexResult(undefined, `REPORT\nPR_URL: ${FIX_PR}\n`));
  try {
    await h.main(request([FAILING_TEST]));
    await h.alert();
    const bodyFile = /THE PR BODY IS ALREADY WRITTEN, by the dispatcher, at: (\S+)/.exec(h.prompts[0]!)![1]!;
    assert.equal(h.prompts[0], mainRepairFixPrompt(request([FAILING_TEST]), bodyFile, true));
    const alertBodyFile = /THE PR BODY IS ALREADY WRITTEN, by the dispatcher, at: (\S+)/.exec(h.prompts[1]!)![1]!;
    assert.equal(h.prompts[1], alertFixPrompt(ALERT, alertTaskId(ALERT), { bodyFile: alertBodyFile }));
  } finally {
    h.cleanup();
  }
});
