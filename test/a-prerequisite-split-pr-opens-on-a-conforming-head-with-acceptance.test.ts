/**
 * test/a-prerequisite-split-pr-opens-on-a-conforming-head-with-acceptance.test.ts — W1-T5779.
 *
 * THE DEFECT. The fix rung's instrument-entanglement arm dispatches a worker with
 * `renderPrerequisitePrPrompt`, which told it to open "a fresh branch" with `gh pr create` and named
 * neither the head nor the body. A dispatched worker never loads CLAUDE.md, so #9206
 * (`prereq-instrument-1791164997643`) and #9222 were born on a head no conforming form admits and with
 * no `## Acceptance` block: head-identity-gate and acceptance-author-gate refused them at birth, GitHub
 * cannot rename an open PR's head, and the rung then sat in `waitForCiGreen` on a red it cannot fix.
 *
 * THE FIX. The rung mints the head itself (`run-unfiled-<epochMs>`), the prompt names that branch and an
 * Acceptance section, and before waiting on CI the rung reads the opened PR's head and body: another
 * head, or a body `acceptanceAuthorTimeCheck` refuses, escalates at once. Every drive below is
 * gateway-free — hand-rolled fakes for spawn, CI, the head read and the body read.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  buildPrerequisitePrDispatchArgs,
  ghLiveHead,
  RUN_BRANCH_UNFILED_RE,
  renderPrerequisitePrPrompt,
  runFixRung,
} from "./helpers/run-task-test.js";
import { acceptanceAuthorTimeCheck, type CriterionVerdict, type ReviewVerdict } from "../src/lib/review.js";
import type { Config } from "../src/lib/config.js";
import type { IssueGateway } from "../src/lib/escalate.js";
import type { Mount } from "../src/lib/mounts.js";
import type { WorkerResult } from "../src/lib/worker.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const MOUNT: Mount = { model: "sonnet", effort: "medium", maxTurns: 400, contextBudget: 120000 };
const INSTRUMENT = ["scripts/diff-coverage.mjs"];
const SRC = ["src/run-task.ts"];
const PREREQ_URL = "https://github.com/acme/remudero/pull/9206";
const CONFORMING_BODY = [
  "Splits the instrument half out of #4242.",
  "",
  "## Acceptance",
  "- the instrument reads the new field | grep: newField in scripts/diff-coverage.mjs",
].join("\n");

function entangledReview(): ReviewVerdict & { headSha: string; reviewerOutcome: string } {
  return {
    state: "failure",
    criteria: [] as CriterionVerdict[],
    testTheater: false,
    summary: "entangled",
    floorDegraded: false,
    capped: false,
    keywordOnly: false,
    planOnly: false,
    instrumentEntangled: true,
    instrumentEntanglementPaths: { instrumentPaths: INSTRUMENT, srcPaths: SRC },
    headSha: "deadbeef",
    reviewerOutcome: "success",
  };
}

function worker(text: string): WorkerResult {
  return {
    sessionId: "s",
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
    model: "default",
    effort: "default",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {},
    compactionEvents: [],
    qualitySuspect: false,
  };
}

function opts() {
  return {
    taskId: "W1-T5779FIX",
    runId: "W1-T5779FIX-1730000000000",
    task: { id: "W1-T5779FIX", title: "a task whose PR ended up instrument-entangled" },
    prUrl: "https://github.com/acme/remudero/pull/4242",
    branch: "run-W1-T5779FIX-1730000000000",
    worktreePath: "/tmp/rmd-w1-t5779-wt",
    initialSessionId: "session-0",
    mount: MOUNT,
    settingsFile: "/tmp/rmd-w1-t5779-settings.json",
    config: {} as Config,
    budgetUsd: 10,
    strikeCap: 3,
    reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: "/tmp/rmd-w1-t5779-wt", reviewerMount: MOUNT },
  };
}

interface Drive {
  issues: string[];
  lines: Array<{ step: string } & Record<string, unknown>>;
  ciWaits: string[];
  minted: () => string;
}

/** Drive the entangled arm once. `head`/`body` see the head the prompt named, so a fake can answer
 *  "the worker obeyed" or "the worker did not" without the test guessing the epoch. */
async function drive(over: {
  head?: (minted: string) => { ok: boolean; headSha?: string; headRefName?: string };
  body?: () => Promise<string>;
}) {
  const d: Drive = { issues: [], lines: [], ciWaits: [], minted: () => "" };
  let prompt = "";
  d.minted = () => prompt.match(/run-unfiled-\d+/)?.[0] ?? "";
  const issues: IssueGateway = {
    create(title) {
      d.issues.push(title);
      return "https://github.com/acme/remudero/issues/8888";
    },
  };
  const deps = {
    spawn: async (a: { prompt: string }) => {
      prompt = a.prompt;
      return worker(`opened it.\nPR_URL: ${PREREQ_URL}`);
    },
    waitForCiGreen: async (url: string) => {
      d.ciWaits.push(url);
      return "green" as const;
    },
    runReview: async (): Promise<never> => {
      throw new Error("this arm returns before a re-review");
    },
    push: () => {},
    issues,
    ledgerPath: join(mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t5779-ledger-`)), "ledger.ndjson"),
    log: (step: string, extra?: Record<string, unknown>) => d.lines.push({ step, ...(extra ?? {}) }),
    say: () => {},
    account: (r: WorkerResult) => r,
    ledgerLines: () => [],
    readPrerequisiteState: async () => ({ ok: true, state: "OPEN" }),
    ...(over.head ? { readLiveHead: async () => over.head!(d.minted()) } : {}),
    ...(over.body ? { fetchPrBody: over.body } : {}),
  };
  const outcome = await runFixRung({ ...opts(), initialReview: entangledReview(), deps } as never);
  return { outcome, ...d };
}

test("renderPrerequisitePrPrompt names the minted run-unfiled head and an Acceptance section", () => {
  const minted = "run-unfiled-1791164997643";
  const prompt = renderPrerequisitePrPrompt({
    task: { id: "W1-T5779FIX", title: "t" },
    branch: "run-W1-T5779FIX-1",
    prUrl: "https://github.com/acme/remudero/pull/4242",
    instrumentPaths: INSTRUMENT,
    srcPaths: SRC,
    prerequisiteBranch: minted,
  });
  assert.ok(prompt.includes(`\`${minted}\``), "the exact minted head, backticked");
  assert.ok(prompt.includes(`--head ${minted}`), "gh pr create is told the head, not left to infer it");
  assert.doesNotMatch(prompt, /fresh branch/, "never an unnamed branch the worker spells itself");
  assert.match(prompt, /## Acceptance/);
  assert.match(prompt, /unit test:/);
  assert.match(prompt, /grep:/);
  assert.match(prompt, /no `Remudero-Task:` trailer/i, "a trailer would credit a task this PR does not build");
});

test("buildPrerequisitePrDispatchArgs threads the minted head into the worker prompt", () => {
  const args = buildPrerequisitePrDispatchArgs({
    task: { id: "W1-T5779FIX", title: "t" },
    branch: "run-W1-T5779FIX-1",
    prUrl: "https://github.com/acme/remudero/pull/4242",
    worktreePath: "/tmp/wt",
    mount: MOUNT,
    settingsFile: "/tmp/s.json",
    config: {} as Config,
    budgetUsd: 1,
    runId: "r",
    taskId: "W1-T5779FIX",
    instrumentPaths: INSTRUMENT,
    srcPaths: SRC,
    prerequisiteBranch: "run-unfiled-42",
  });
  assert.ok(args.prompt.includes("`run-unfiled-42`"));
});

test("the rung mints a run-unfiled head the head-identity form admits, and a conforming PR waits on CI and parks", async () => {
  const r = await drive({
    head: (minted) => ({ ok: true, headSha: "abc", headRefName: minted }),
    body: async () => CONFORMING_BODY,
  });
  assert.match(r.minted(), RUN_BRANCH_UNFILED_RE, "the prompt named a head the gate admits");
  assert.equal(acceptanceAuthorTimeCheck(CONFORMING_BODY).ok, true, "the fixture body is itself admissible");
  assert.deepEqual(r.ciWaits, [PREREQ_URL], "a conforming prerequisite still waits on its own CI");
  assert.equal(r.outcome.outcome, "parked");
  assert.equal(r.issues.length, 0);
});

test("a prerequisite opened on another head escalates naming that head, without waiting on CI", async () => {
  const r = await drive({
    head: () => ({ ok: true, headSha: "abc", headRefName: "prereq-instrument-1791164997643" }),
    body: async () => CONFORMING_BODY,
  });
  assert.equal(r.outcome.outcome, "escalated");
  assert.equal(r.outcome.reason, "instrument_entangled", "the same escalation that arm has always filed");
  assert.deepEqual(r.ciWaits, [], "never waits out a red it cannot fix");
  assert.equal(r.issues.length, 1);
  const failed = r.lines.find((l) => l.step === "fix.prerequisite_dispatch_failed");
  assert.ok(failed, "fix.prerequisite_dispatch_failed is logged");
  assert.equal(failed.prerequisite_pr, 9206);
  assert.match(String(failed.reason), /prereq-instrument-1791164997643/, "the reason names the head it opened on");
  assert.ok(String(failed.reason).includes(r.minted()), "and the head it was told to use");
});

test("a prerequisite whose body acceptanceAuthorTimeCheck refuses escalates without waiting on CI", async () => {
  const r = await drive({
    head: (minted) => ({ ok: true, headSha: "abc", headRefName: minted }),
    body: async () => "Splits the instrument half out of #4242. No acceptance block at all.",
  });
  assert.equal(r.outcome.outcome, "escalated");
  assert.deepEqual(r.ciWaits, []);
  const failed = r.lines.find((l) => l.step === "fix.prerequisite_dispatch_failed");
  assert.match(String(failed?.reason), /no-header/, "the reason carries acceptanceAuthorTimeCheck's own defect");
});

test("an unreadable head or body read is no evidence either way: the rung waits on CI as before", async () => {
  const unreadHead = await drive({ head: () => ({ ok: false }), body: async () => CONFORMING_BODY });
  assert.deepEqual(unreadHead.ciWaits, [PREREQ_URL]);
  assert.equal(unreadHead.outcome.outcome, "parked");

  const throwingBody = await drive({
    head: (minted) => ({ ok: true, headSha: "abc", headRefName: minted }),
    body: async () => {
      throw new Error("gh: rate limited");
    },
  });
  assert.deepEqual(throwingBody.ciWaits, [PREREQ_URL]);
  assert.equal(throwingBody.outcome.outcome, "parked");
});

test("ghLiveHead reads the head ref name beside the head sha", () => {
  const calls: string[][] = [];
  const head = ghLiveHead("https://github.com/acme/remudero/pull/9206", (args) => {
    calls.push(args);
    return { headRefOid: "abc", headRefName: "run-unfiled-1", commits: [{ oid: "abc", authors: [{ login: "fleet" }] }] };
  });
  assert.deepEqual(head, { ok: true, headSha: "abc", author: "fleet", headRefName: "run-unfiled-1" });
  assert.match(calls[0].join(" "), /headRefName/);
});
