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
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  buildPrerequisitePrDispatchArgs,
  ghLiveHead,
  RUN_BRANCH_UNFILED_RE,
  renderPrerequisitePrPrompt,
  runFixRung,
} from "#test/helpers/run-task-test.js";
import { acceptanceAuthorTimeCheck, type CriterionVerdict, type ReviewVerdict } from "#src/lib/review.js";
import type { Config } from "#src/lib/config.js";
import type { IssueGateway } from "#src/lib/escalate.js";
import type { Mount } from "#src/lib/mounts.js";
import type { WorkerResult } from "#src/lib/worker.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { listArchivedTranscripts, TRANSCRIPT_EXCERPT_CAP } from "#src/run-task.js";
import { appendLedger, rotateLedger } from "#src/lib/ledger.js";
import { readLedgerLines } from "#src/lib/status.js";
import { gatherRuns } from "#src/lib/retro.js";

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
  root?: string;
  priorRows?: Array<Record<string, unknown>>;
  reviewHead?: string;
  bodySha256?: string;
  constraint?: string;
  progressApproach?: string;
  taskPatch?: { files?: string[]; design?: string; amendment?: string };
  report?: string;
  onSpawn?: (args: { prompt: string; env?: Record<string, string> }) => void;
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
    spawn: async (a: { prompt: string; env?: Record<string, string> }) => {
      over.onSpawn?.(a);
      prompt = a.prompt;
      return worker(over.report ?? `opened it.\nPR_URL: ${PREREQ_URL}`);
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
    ledgerPath: join(over.root ?? mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t5779-ledger-`)), "ledger.ndjson"),
    log: (step: string, extra?: Record<string, unknown>) => d.lines.push({ step, ...(extra ?? {}) }),
    say: () => {},
    account: (r: WorkerResult) => r,
    ledgerLines: () => (over.priorRows ?? []).map(row => ({ task_id: opts().taskId, ...row })),
    readPrerequisiteState: async () => ({ ok: true, state: "OPEN" }),
    ...(over.head ? { readLiveHead: async () => over.head!(d.minted()) } : {}),
    ...(over.body ? { fetchPrBody: over.body } : {}),
  };
  const outcome = await runFixRung({ ...opts(), ...(over.root ? { config: { root: over.root }, worktreePath: over.root } : {}), task: { ...opts().task, ...over.taskPatch }, prBodySha256: over.bodySha256, constraint: over.constraint, progressApproach: over.progressApproach, initialReview: { ...entangledReview(), ...(over.reviewHead ? { headSha: over.reviewHead } : {}) }, deps } as never);
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


test("a prerequisite worker that opens no PR retains its bounded diagnostic transcript", async t => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}prerequisite-evidence-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const reason = "publication refused by the normal hook";
  const r = await drive({ root, report: reason + "\n" + "x".repeat(TRANSCRIPT_EXCERPT_CAP + 100) });
  assert.equal(r.outcome.outcome, "escalated");
  assert.equal(r.outcome.reason, "instrument_entangled");
  assert.deepEqual(r.ciWaits, []);
  const archived = listArchivedTranscripts(root, opts().taskId);
  assert.equal(archived.length, 1, "a no-PR exit is still a real worker exit");
  const text = readFileSync(archived[0]!.path, "utf8");
  assert.ok(text.includes(reason), "retain the actual refusal, not only success=true");
  assert.ok(Buffer.byteLength(text) < TRANSCRIPT_EXCERPT_CAP + 2000, "reuse the existing transcript cap");
  const archivedAt = r.lines.findIndex(row => row.step === "transcript.archived");
  const refusedAt = r.lines.findIndex(row => row.step === "fix.prerequisite_dispatch_failed");
  assert.ok(archivedAt >= 0 && archivedAt < refusedAt, "preserve evidence before the no-PR return");
});

test("a prerequisite worker retains its transcript before waiting on protected CI", async t => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}prerequisite-success-evidence-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const r = await drive({ root,
    head: minted => ({ ok: true, headSha: "abc", headRefName: minted }),
    body: async () => CONFORMING_BODY,
  });
  assert.equal(r.outcome.outcome, "parked");
  assert.deepEqual(r.ciWaits, [PREREQ_URL]);
  const archived = listArchivedTranscripts(root, opts().taskId);
  assert.equal(archived.length, 1);
  assert.ok(readFileSync(archived[0]!.path, "utf8").includes(`PR_URL: ${PREREQ_URL}`));
  const archivedAt = r.lines.findIndex(row => row.step === "transcript.archived");
  const openedAt = r.lines.findIndex(row => row.step === "fix.prerequisite_opened");
  assert.ok(archivedAt >= 0 && archivedAt < openedAt);
});


test("a repeated prerequisite worker can read the prior refusal in the same daemon run", async t => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}prerequisite-predecessor-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const reason = "normal publication refused: preserve this diagnostic";
  await drive({ root, report: reason });
  let copied: string | undefined;
  let scratch: string | undefined;
  await drive({ root, report: "still cannot publish", onSpawn: args => {
    scratch = args.env?.TMPDIR;
    if (scratch) copied = readdirSync(scratch).map(name => readFileSync(join(scratch!, name), "utf8")).join("\n");
  } });
  assert.ok(copied?.includes(reason), "the actual next spawn receives a readable bounded predecessor copy");
  assert.ok(scratch && !existsSync(scratch), "only this spawn's temporary copies are retired");
  assert.equal(listArchivedTranscripts(root, opts().taskId).length, 2, "same-daemon attempts do not overwrite each other");
});


test("a completed no-PR prerequisite attempt is not repeated until its repair inputs change", async t => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}prerequisite-no-pr-reuse-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let spawns = 0;
  const input = { root, report: "No PR: the required instrument reads a collector absent on main.", bodySha256: "body-a", onSpawn: () => { spawns++; } };
  const first = await drive(input);
  assert.equal(spawns, 1);
  assert.equal(first.outcome.outcome, "escalated");
  const unchanged = await drive({ ...input, priorRows: first.lines });
  assert.equal(spawns, 1, "unchanged head, contract, narrative and body cannot launch another prerequisite worker");
  assert.equal(unchanged.outcome.outcome, "escalated", "the existing operator disposition remains");
  assert.deepEqual(unchanged.ciWaits, []);
  const marker = first.lines.find(row => row.step === "fix.prerequisite_dispatch_failed");
  assert.equal(marker?.prerequisite_outcome, "completed-no-pr");
  assert.equal(marker?.repair_pr_url, opts().prUrl);
  assert.equal(marker?.read_head_sha, "deadbeef");
  assert.equal(typeof marker?.read_contract_revision, "string");
  assert.equal(typeof marker?.read_task_semantic_revision, "string");
  assert.equal(marker?.read_body_sha256, "body-a");
  for (const changed of [{ reviewHead: "new-head" }, { bodySha256: "body-b" },
    { taskPatch: { files: ["src/qualified-new-companion.ts"] } }, { taskPatch: { design: "operator-qualified revised design" } }]) {
    const before: number = spawns;
    await drive({ ...input, priorRows: first.lines, ...changed });
    assert.equal(spawns, before + 1, "a positively changed repair input returns to existing qualification");
  }
});

test("an unbound or foreign no-PR record cannot replace an observed prerequisite attempt", async t => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}prerequisite-no-pr-negative-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let spawns = 0;
  const input = { root, report: "No PR could be built.", onSpawn: () => { spawns++; } };
  const first = await drive(input);
  const marker = first.lines.find(row => row.step === "fix.prerequisite_dispatch_failed")!;
  for (const row of [{ ...marker, read_head_sha: undefined }, { ...marker, read_contract_revision: undefined },
    { ...marker, prerequisite_outcome: undefined }, { ...marker, repair_pr_url: "https://github.com/acme/foreign/pull/4242" }]) {
    const before: number = spawns;
    await drive({ ...input, priorRows: [row] });
    assert.equal(spawns, before + 1, "historical/unbound/foreign evidence cannot suppress a first qualified attempt");
  }
  const before: number = spawns;
  const existing = await drive({ ...input, priorRows: [...first.lines, { step: "fix.prerequisite_opened", pr_url: opts().prUrl, prerequisite_pr: 9206 }] });
  assert.equal(spawns, before, "a real prerequisite already opened retains the existing owned route");
  assert.equal(existing.outcome.outcome, "parked");
});


test("a completed no-PR prerequisite refusal remains effective after real ledger rotation", async t => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}prerequisite-no-pr-rotation-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let spawns = 0;
  const input = { root, report: "No PR could be built from the unchanged source dependency.", onSpawn: () => { spawns++; } };
  const first = await drive(input);
  const marker = first.lines.find(row => row.step === "fix.prerequisite_dispatch_failed")!;
  const path = join(root, "rotation.ndjson");
  const noCeiling = { ceilingBytes: Number.MAX_SAFE_INTEGER };
  appendLedger(path, { ...marker, run_id: "FIX-rotation", task_id: opts().taskId, step: "fix.prerequisite_dispatch_failed" }, noCeiling);
  const ceiling = Buffer.byteLength(JSON.stringify(marker)) * 4;
  appendLedger(path, { run_id: "noise", task_id: "NOISE", step: "test.noise", detail: "x".repeat(ceiling * 2) }, noCeiling);
  assert.equal(rotateLedger(path, { ceilingBytes: ceiling, smoothingWindowMs: 0 }).rotated, true);
  const retained = readLedgerLines(path);
  assert.ok(retained.some(row => row.step === "fix.prerequisite_dispatch_failed" && row.prerequisite_outcome === "completed-no-pr"));
  await drive({ ...input, priorRows: retained });
  assert.equal(spawns, 1, "a real rotation cannot turn a completed attempt into a fresh worker");
  const run = { step: "run.start", run_id: "repair-attribution", task_id: opts().taskId };
  assert.equal(gatherRuns([run, { ...marker, run_id: run.run_id }])[0]!.prUrl, undefined, "a refusal names a repair target rather than an opened PR");
  assert.equal(gatherRuns([run, { ...marker, run_id: run.run_id, pr_url: opts().prUrl }])[0]!.prUrl, opts().prUrl, "positive control: the generic opened-PR field would misattribute this repair target");
});


test("a new operator instruction requalifies a no-PR attempt once while model-only advice does not", async t => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}prerequisite-operator-input-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let spawns = 0;
  const input = { root, report: "No addressable prerequisite receipt.", constraint: "operator: split the existing instrument", onSpawn: () => { spawns++; } };
  const first = await drive(input);
  await drive({ ...input, priorRows: first.lines, progressApproach: "model changed its suggested approach" });
  assert.equal(spawns, 1, "model-only advice is not new operator authority or dependency evidence");
  const changed = { ...input, constraint: "operator: qualify the newly supplied dependency under the existing gates" };
  const second = await drive({ ...changed, priorRows: first.lines });
  assert.equal(spawns, 2, "a new operator instruction receives the existing qualification once");
  const history = [...first.lines, ...second.lines];
  await drive({ ...changed, priorRows: history });
  await drive({ ...changed, priorRows: history, constraint: `  ${changed.constraint}\n` });
  await drive({ ...changed, priorRows: history, constraint: undefined });
  assert.equal(spawns, 2, "the same or consumed instruction cannot manufacture another attempt");
});
