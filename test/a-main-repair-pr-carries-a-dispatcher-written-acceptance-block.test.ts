/**
 * W1-T8572 — A MAIN-REPAIR PR CARRIES AN ACCEPTANCE BLOCK THE DISPATCHER WRITES.
 *
 * 2026-10-12: #11085 turned main red, and the red-main fix worker opened #11096 with the right one-line fix. It
 * followed `mainRepairFixPrompt`'s bare `- <claim> | <proof>` instruction and wrote proofs like
 * "test/x.test.ts passes", with no `unit test:`/`grep:` prefix, so proof-discrimination failed the PR that would have
 * turned main green. These fixtures replay #11096's request: the dispatcher now writes the block itself when it knows
 * the failing test files, checks the worker's bullets before it opens the PR when it does not, and proves the revert
 * with executable proofs instead of `ci:`.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Config } from "#src/lib/config.js";
import type { MainRepairFixRequest, MainRepairRevertRequest } from "#src/lib/main-health-rung.js";
import type { Mount } from "#src/lib/mounts.js";
import type { GhApiFetcher } from "#src/lib/open-prs-rest.js";
import { ACCEPTANCE_PROOF_GRAMMAR, inertAcceptanceProofs, PR_BODY_ACCEPTANCE_GRAMMAR } from "#src/lib/proof-grammar.js";
import { acceptanceAuthorTimeCheck, isDialectPrefixed, parseAcceptanceBlock, parseWhitelistedProof } from "#src/lib/review.js";
import { readLedgerLines } from "#src/lib/status.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import type { SpawnWorkerArgs, WorkerResult } from "#src/lib/worker.js";
import {
  type AlertFixDispatchDeps,
  dispatchMainRepairFixRun,
  MAIN_REPAIR_ACCEPTANCE_DEFECT_STEP,
  MAIN_REPAIR_ACCEPTANCE_PLACEHOLDER,
  MAIN_REPAIR_PROSE_PLACEHOLDER,
  mainRepairAcceptanceCriteria,
  mainRepairFixBody,
  mainRepairFixPrompt,
  mainRepairLaneFor,
  mainRepairRevertBody,
  mainRepairTaskId,
} from "#src/run-task.js";

const OWNER = "craigoley";
const RED_MERGE = "97e3f9136d82".padEnd(40, "0"); // #11085's merge, the first red push run
const HEAD = "f84af4f0".padEnd(40, "0");
const SPENT_CHECK_TEST = "test/a-spent-check-requeue-survives-ledger-rotation.test.ts";
const FIX_PR = `https://github.com/${OWNER}/remudero/pull/11096`;
const MOUNT: Mount = { model: "fake-model", effort: "low", maxTurns: 5, contextBudget: 1000 };
/** The pushed fix's diff: #11096's one-line repair, a step added to the decision-relevant set. */
const FIX_DIFF = [
  "diff --git a/src/lib/ledger.ts b/src/lib/ledger.ts",
  "--- a/src/lib/ledger.ts",
  "+++ b/src/lib/ledger.ts",
  "@@ -40,0 +41 @@",
  '+  "refresh.clearance",',
].join("\n");

function request(testFiles: readonly string[]): MainRepairFixRequest {
  return {
    branch: "main",
    headSha: HEAD,
    offendingSha: RED_MERGE,
    offendingPr: 11085,
    diffStat: " src/lib/base-reproduction.ts | +40 -0",
    failingChecks: ["ci"],
    failingTestTitles: ["a spent check requeue survives ledger rotation"],
    testFiles,
    logExcerpt: `not ok 3 - ${SPENT_CHECK_TEST}`,
    reason: "required check ci failed",
  };
}

function workerResult(text: string): WorkerResult {
  return {
    sessionId: "s-t8572",
    costUsd: 0.01,
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
  } as unknown as WorkerResult;
}

const rowsOf = (ledgerPath: string, step: string) => readLedgerLines(ledgerPath).filter((row) => row.step === step); // ledger-read-intent: live

/** The body file the prompt names: the path after "THE PR BODY IS ALREADY WRITTEN, by the dispatcher, at: ". */
function bodyFileIn(prompt: string): string {
  const match = /THE PR BODY IS ALREADY WRITTEN, by the dispatcher, at: (\S+)/.exec(prompt);
  assert.ok(match, "the prompt names the dispatcher's body file");
  return match[1]!;
}

/** A dispatch harness: a fake worker that runs `work(bodyFile)` and reports `report`, and a fake REST open. */
function harness(work: (bodyFile: string, args: SpawnWorkerArgs) => string) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t8572-`));
  const ledgerPath = join(root, "ledger.ndjson");
  const opened: Array<Record<string, string>> = [];
  const fetch = ((args: string[]) => {
    const fields: Record<string, string> = {};
    args.forEach((arg, i) => {
      if (args[i - 1] !== "-f") return;
      const eq = arg.indexOf("=");
      fields[arg.slice(0, eq)] = arg.slice(eq + 1);
    });
    opened.push(fields);
    return { html_url: FIX_PR };
  }) as GhApiFetcher;
  const deps: AlertFixDispatchDeps = {
    worktreeAdd: () => {},
    worktreeRemove: () => {},
    renderWorkerSettings: () => "/tmp/fake-settings.json",
    loadMounts: () => ({}) as never,
    resolveMount: () => MOUNT,
    spawn: async (args) => workerResult(work(bodyFileIn(args.prompt), args)),
    ensureTaskTrailer: () => {},
    checkAcceptance: () => ({ ok: true }) as never,
    fetch,
    readDiff: () => FIX_DIFF,
    readHeadSubject: () => "fix(ledger): keep refresh.clearance decision-relevant",
    readRemoteBranchHead: async () => "f1x".padEnd(40, "0"), // W1-T9667: the worker's push landed
  };
  return {
    root,
    ledgerPath,
    opened,
    deps,
    run: (req: MainRepairFixRequest) => dispatchMainRepairFixRun(OWNER, "fixture-repo", { root } as Config, req, ledgerPath, "R", deps),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("reported main-repair paths without a failing test witness use the checked proof path", async () => {
  for (const failingTestTitles of [[], [" ", ""]]) {
    const req = { ...request([SPENT_CHECK_TEST, "test/a-reported-clock-fixture.test.ts"]), failingTestTitles,
      logExcerpt: "expiring-fixture-census: BLOCKED — control_failed" };
    const h = harness((bodyFile, args) => {
      const body = readFileSync(bodyFile, "utf8");
      assert.ok(body.includes(MAIN_REPAIR_ACCEPTANCE_PLACEHOLDER), "reported paths do not become implicit file proofs");
      assert.deepEqual(parseAcceptanceBlock(body), [], "no unproven whole-file failure claim is prewritten");
      assert.ok(args.prompt.includes(PR_BODY_ACCEPTANCE_GRAMMAR[0]!));
      assert.ok(args.prompt.includes("Reported test path(s), not established whole-file failures"));
      assert.ok(args.prompt.includes(SPENT_CHECK_TEST), "paths remain available for diagnosis");
      assert.ok(args.prompt.includes("do NOT open a PR"), "the dispatcher keeps the checked publication path");
      writeFileSync(bodyFile, body.replace(MAIN_REPAIR_ACCEPTANCE_PLACEHOLDER,
        '- the pushed repair adds the missing refresh record | grep: "refresh\\.clearance", in src/lib/ledger.ts'));
      return "REPORT\nPUSHED: fixture\n";
    });
    try {
      assert.equal(await h.run(req), FIX_PR);
      assert.equal(h.opened.length, 1);
      assert.deepEqual(parseAcceptanceBlock(h.opened[0]!.body!).map((c) => c.proof),
        ['grep: "refresh\\.clearance", in src/lib/ledger.ts']);
      assert.equal(rowsOf(h.ledgerPath, MAIN_REPAIR_ACCEPTANCE_DEFECT_STEP).length, 0);
    } finally { h.cleanup(); }
  }
});

test("reported main-repair paths without a failing witness retain the worker-opened defect", async () => {
  const h = harness(() => `REPORT\nPR_URL: ${FIX_PR}\n`);
  try {
    assert.equal(await h.run({ ...request([SPENT_CHECK_TEST]), failingTestTitles: [] }), FIX_PR);
    assert.deepEqual(h.opened, [], "an existing worker-opened PR is not opened a second time");
    const row = rowsOf(h.ledgerPath, MAIN_REPAIR_ACCEPTANCE_DEFECT_STEP).at(-1);
    assert.equal(row?.defect, "worker-opened");
    assert.equal(row?.resolution, "opened-unchecked", "a breach remains explicit rather than becoming checked assurance");
  } finally { h.cleanup(); }
});

test("W1-T8572: a main-repair body passes check-acceptance and every proof has a dialect", () => {
  const body = mainRepairFixBody(request([SPENT_CHECK_TEST]));
  assert.ok(acceptanceAuthorTimeCheck(body).ok, "the body as opened passes the author-time check");
  // The trailer arm returns ok before it reads the block, so the block must also pass on its own.
  const withoutTrailer = body.replace(/^Remudero-Task: .*$/m, "");
  assert.ok(acceptanceAuthorTimeCheck(withoutTrailer).ok, "the block alone passes the author-time check");
  const criteria = parseAcceptanceBlock(body);
  assert.deepEqual(
    criteria.map((c) => c.proof),
    [`unit test: ${SPENT_CHECK_TEST}`],
  );
  for (const { proof } of criteria) {
    assert.ok(proof?.startsWith("unit test:") || proof?.startsWith("grep:"), `a dialected proof: ${proof}`);
  }
  assert.deepEqual(inertAcceptanceProofs(body), [], "no proof is inert");
  assert.match(body, new RegExp(`^origin: main-repair#${RED_MERGE}$`, "m"));
  assert.equal(body.trimEnd().split("\n").at(-1), `Remudero-Task: ${mainRepairTaskId(RED_MERGE)}`);
  // The pure renderer: one criterion per failing test file, round-tripped.
  const two = mainRepairAcceptanceCriteria({ testFiles: [SPENT_CHECK_TEST, "test/b.test.ts"] });
  assert.deepEqual(
    parseAcceptanceBlock(two).map((c) => c.proof),
    [`unit test: ${SPENT_CHECK_TEST}`, "unit test: test/b.test.ts"],
  );
});

test("W1-T8572: the fix worker opens its PR with the dispatcher-written body", async () => {
  const seen: { body?: string; prompt?: string } = {};
  const h = harness((bodyFile, args) => {
    seen.body = readFileSync(bodyFile, "utf8");
    seen.prompt = args.prompt;
    return `REPORT\nPR_URL: ${FIX_PR}\n`;
  });
  try {
    assert.equal(await h.run(request([SPENT_CHECK_TEST])), FIX_PR);
    const prompt = seen.prompt!;
    const bodyFile = bodyFileIn(prompt);
    assert.ok(seen.body, "the body file existed when the worker spawned");
    assert.deepEqual(
      parseAcceptanceBlock(seen.body!).map((c) => c.proof),
      [`unit test: ${SPENT_CHECK_TEST}`],
      "the body file already holds the dispatcher's block",
    );
    assert.ok(seen.body!.includes(MAIN_REPAIR_PROSE_PLACEHOLDER));
    assert.ok(prompt.includes(`--body-file ${bodyFile}`), "the worker opens the PR with the dispatcher's body file");
    assert.ok(!prompt.includes("an `Acceptance:` block of `- <claim> | <proof>` bullets"), "the prompt no longer asks for a block");
    assert.ok(!prompt.includes("ACCEPTANCE PROOFS are EXECUTED"), "with test files known, the worker is taught no grammar");
    assert.ok(!bodyFile.startsWith(join(h.root, "worktrees")), "the body file lives outside the worker's checkout");
    assert.equal(existsSync(bodyFile), false, "the body file is removed once the dispatch ends");
    assert.deepEqual(h.opened, [], "the worker opened it; the dispatcher opened nothing");
    assert.equal(rowsOf(h.ledgerPath, MAIN_REPAIR_ACCEPTANCE_DEFECT_STEP).length, 0);
  } finally {
    h.cleanup();
  }
});

test("W1-T8572: with no parsed test file the prompt carries the PR-body proof grammar", () => {
  const prompt = mainRepairFixPrompt(request([]), "/root/tmp/main-repair-body.md");
  for (const line of PR_BODY_ACCEPTANCE_GRAMMAR) assert.ok(prompt.includes(line), `the PR-body grammar line: ${line}`);
  assert.ok(!prompt.includes("You are FILING work"), "never the filing grammar");
  for (const line of ACCEPTANCE_PROOF_GRAMMAR.filter((l) => !PR_BODY_ACCEPTANCE_GRAMMAR.includes(l))) {
    assert.ok(!prompt.includes(line), `no filing-only grammar line: ${line}`);
  }
  assert.ok(prompt.includes(MAIN_REPAIR_ACCEPTANCE_PLACEHOLDER), "the worker is told where its bullets go");
  assert.ok(prompt.includes("do NOT open a PR"), "the dispatcher opens the PR after checking the bullets");
  assert.ok(!prompt.includes("gh pr create"));
  // With failing test files known, the grammar is not needed and not given.
  assert.ok(!mainRepairFixPrompt(request([SPENT_CHECK_TEST]), "/b.md").includes(PR_BODY_ACCEPTANCE_GRAMMAR[0]!));
});

test("W1-T8572: an undialected no-test-file body is ledgered and never opened as written", async () => {
  const PROSE = `${SPENT_CHECK_TEST} passes`;
  const h = harness((bodyFile) => {
    const written = readFileSync(bodyFile, "utf8").replace(MAIN_REPAIR_ACCEPTANCE_PLACEHOLDER, `- main is green | ${PROSE}`);
    writeFileSync(bodyFile, written);
    assert.match(written, /^Remudero-Task: main-repair-/m, "the body carries a trailer, so the trailer arm would pass it");
    assert.ok(acceptanceAuthorTimeCheck(written).ok, "the check the filed design trusted passes this inert body");
    return "REPORT\nPUSHED: main-repair-fix\n";
  });
  try {
    assert.equal(await h.run(request([])), FIX_PR);
    const [row, ...more] = rowsOf(h.ledgerPath, MAIN_REPAIR_ACCEPTANCE_DEFECT_STEP);
    assert.equal(more.length, 0);
    assert.equal(row?.defect, "inert-proofs");
    assert.equal(row?.count, 1);
    assert.deepEqual(row?.inert_proofs, [PROSE]);
    assert.equal(row?.resolution, "rewritten");
    const [pr] = h.opened;
    assert.ok(pr, "the dispatcher opened the rewritten body");
    assert.ok(!pr.body!.includes(`| ${PROSE}`), "the inert bullet is never opened as written");
    assert.deepEqual(
      parseAcceptanceBlock(pr.body!).map((c) => c.proof),
      ['grep: "refresh\\.clearance", in src/lib/ledger.ts'],
      "one grep of a line the pushed fix adds",
    );
    assert.deepEqual(inertAcceptanceProofs(pr.body!), []);
    assert.equal(pr.title, "fix(ledger): keep refresh.clearance decision-relevant");
    assert.equal(pr.base, "main");

    // With no usable added line, the body is refused: no PR, and the lane falls through to its revert.
    h.deps.readDiff = () => "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n+ok\n";
    assert.equal(await h.run(request([])), undefined);
    const refused = rowsOf(h.ledgerPath, MAIN_REPAIR_ACCEPTANCE_DEFECT_STEP).at(-1);
    assert.equal(refused?.resolution, "refused");
    assert.equal(h.opened.length, 1, "no second PR opened");
    assert.equal(rowsOf(h.ledgerPath, "main-repair.no_pr").length, 1);
  } finally {
    h.cleanup();
  }
});

test("W1-T8572: a prose proof naming a test path is still an inert proof", () => {
  const PROSE = `${SPENT_CHECK_TEST} passes`;
  assert.notEqual(parseWhitelistedProof(PROSE), null, "the legacy bare-path shape accepts it");
  assert.equal(isDialectPrefixed(PROSE), false);
  const body = mainRepairFixBody(request([])).replace(MAIN_REPAIR_ACCEPTANCE_PLACEHOLDER, `- main is green | ${PROSE}`);
  assert.deepEqual(inertAcceptanceProofs(body), [PROSE]);
});

test("W1-T8572: a no-test-file body whose proofs all execute opens with no defect row", async () => {
  const BULLET = '- refresh.clearance is decision-relevant | grep: "refresh\\.clearance", in src/lib/ledger.ts';
  const h = harness((bodyFile) => {
    writeFileSync(bodyFile, readFileSync(bodyFile, "utf8").replace(MAIN_REPAIR_ACCEPTANCE_PLACEHOLDER, BULLET));
    return "REPORT\nPUSHED: main-repair-fix\n";
  });
  try {
    assert.equal(await h.run(request([])), FIX_PR);
    assert.equal(rowsOf(h.ledgerPath, MAIN_REPAIR_ACCEPTANCE_DEFECT_STEP).length, 0, "no defect row");
    const [pr] = h.opened;
    assert.ok(pr?.body?.includes(BULLET), "opened as written");
    assert.match(pr!.body!, new RegExp(`^Remudero-Task: ${mainRepairTaskId(RED_MERGE)}$`, "m"));
    assert.equal(rowsOf(h.ledgerPath, "main-repair.pr_opened").length, 1);
  } finally {
    h.cleanup();
  }
});

test("W1-T8572: a no-test-file worker that opens its own PR is ledgered as an unchecked open", async () => {
  const PROSE = `${SPENT_CHECK_TEST} passes`;
  const h = harness((bodyFile) => {
    writeFileSync(bodyFile, readFileSync(bodyFile, "utf8").replace(MAIN_REPAIR_ACCEPTANCE_PLACEHOLDER, `- main is green | ${PROSE}`));
    return `REPORT\nPR_URL: ${FIX_PR}\n`;
  });
  try {
    assert.equal(await h.run(request([])), FIX_PR, "the PR exists, so it is still returned for review");
    assert.deepEqual(h.opened, [], "the dispatcher opens no second PR");
    const [row, ...more] = rowsOf(h.ledgerPath, MAIN_REPAIR_ACCEPTANCE_DEFECT_STEP);
    assert.equal(more.length, 0);
    assert.equal(row?.defect, "worker-opened");
    assert.equal(row?.resolution, "opened-unchecked");
    assert.equal(row?.pr_url, FIX_PR);
    assert.deepEqual(row?.inert_proofs, [PROSE]);
    assert.equal(row?.count, 1);
  } finally {
    h.cleanup();
  }
});

test("W1-T8572: the repair lane dispatches the fix and carries its test files into the matching revert", async () => {
  const workerBodies: string[] = [];
  const h = harness((bodyFile) => {
    workerBodies.push(readFileSync(bodyFile, "utf8"));
    return `REPORT\nPR_URL: ${FIX_PR}\n`;
  });
  const config = { root: h.root } as Config;
  const revertBodies: string[] = [];
  const revertPrUrl = `${FIX_PR}-revert`;
  const lane = mainRepairLaneFor(OWNER, "fixture-repo", config, h.ledgerPath, "R",
    (owner, repo, cfg, req, ledgerPath, runId) =>
      dispatchMainRepairFixRun(owner, repo, cfg, req, ledgerPath, runId, h.deps),
    async (owner, repo, cfg, req, ledgerPath, runId, fetch, testFiles) => {
      assert.deepEqual([owner, repo, cfg, ledgerPath, runId, fetch],
        [OWNER, "fixture-repo", config, h.ledgerPath, "R", undefined]);
      revertBodies.push(mainRepairRevertBody(req, { testFiles }));
      return { prUrl: revertPrUrl };
    },
  );
  const fix = request([SPENT_CHECK_TEST]);
  const otherFix = { ...request(["test/b.test.ts"]), offendingSha: "a".repeat(40) };
  const revert: MainRepairRevertRequest = {
    branch: fix.branch,
    headSha: fix.headSha,
    offendingSha: fix.offendingSha,
    failingChecks: fix.failingChecks,
    fixPrUrl: FIX_PR,
    whyFixInsufficient: "fix PR made no progress",
  };
  const proofs = (body: string) => parseAcceptanceBlock(body).map((c) => c.proof);
  try {
    assert.equal(await lane.openFixPr(fix), FIX_PR);
    assert.equal(await lane.openFixPr(otherFix), FIX_PR);
    assert.deepEqual(workerBodies.map(proofs), [[`unit test: ${SPENT_CHECK_TEST}`], ["unit test: test/b.test.ts"]]);
    assert.deepEqual(await lane.openRevertPr(revert), { prUrl: revertPrUrl });
    assert.deepEqual(proofs(revertBodies[0]!), [`unit test: ${SPENT_CHECK_TEST}`]);
    assert.deepEqual(await lane.openRevertPr({ ...revert, offendingSha: otherFix.offendingSha }), { prUrl: revertPrUrl });
    assert.deepEqual(proofs(revertBodies[1]!), ["unit test: test/b.test.ts"]);
    assert.deepEqual(await lane.openRevertPr({ ...revert, offendingSha: "b".repeat(40) }), { prUrl: revertPrUrl });
    assert.deepEqual(revertBodies[2], mainRepairRevertBody({ ...revert, offendingSha: "b".repeat(40) }));
  } finally {
    h.cleanup();
  }
});

test("W1-T8572: the revert body proves the revert with executable proofs", () => {
  const revert: MainRepairRevertRequest = {
    branch: "main",
    headSha: HEAD,
    offendingSha: RED_MERGE,
    offendingPr: 11085,
    failingChecks: ["ci"],
    fixPrUrl: FIX_PR,
    whyFixInsufficient: "fix PR made no progress",
  };
  const revertDiff = [
    "diff --git a/census.txt b/census.txt",
    "--- a/census.txt",
    "+++ b/census.txt",
    "@@ -1 +1 @@",
    "-recorded 32/52 by #10092",
    "+recorded 33/53 before it",
  ].join("\n");
  const bodies = {
    withTests: mainRepairRevertBody(revert, { testFiles: [SPENT_CHECK_TEST] }),
    withDiff: mainRepairRevertBody(revert, { revertDiff }),
    withNothing: mainRepairRevertBody(revert),
  };
  for (const [name, body] of Object.entries(bodies)) {
    assert.ok(!/\|\s*ci:/.test(body), `${name}: no ci: proof`);
    const proofs = parseAcceptanceBlock(body).map((c) => c.proof ?? "");
    assert.ok(proofs.length > 0, `${name}: a block`);
    for (const proof of proofs) assert.ok(proof.startsWith("unit test:") || proof.startsWith("grep:"), `${name}: ${proof}`);
    assert.deepEqual(inertAcceptanceProofs(body), [], `${name}: every proof executes`);
  }
  assert.deepEqual(parseAcceptanceBlock(bodies.withTests).map((c) => c.proof), [`unit test: ${SPENT_CHECK_TEST}`]);
  assert.deepEqual(parseAcceptanceBlock(bodies.withDiff).map((c) => c.proof), ["grep: recorded 33/53 before it in census.txt"]);
});
