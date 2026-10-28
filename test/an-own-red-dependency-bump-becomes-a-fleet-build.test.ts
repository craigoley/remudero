/**
 * W1-T9586 — AN OWN-RED DEPENDENCY BUMP BECOMES A FLEET BUILD.
 *
 * 2026-10-14/15: #11788 (SDK 0.3.293 -> 0.3.296) and #11791 (image CLI 2.1.293 -> 2.1.296) were red on
 * test/the-haiku55-image-pins-match-its-sdk.test.ts, which pins both literals and requires them to agree, so
 * neither can pass alone; #11793 was red on three tests that hardcode action SHAs. dep-review held all three
 * on every pass: a companion test edit on the bot branch is refused by the manifest allowlist, and the only
 * remedy was the 24 h escalation. An own red now files ONE migration proposal for an owned task branch,
 * through the W1-T2705 capture path, with no Dependabot command and no close.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import {
  DEPENDABOT_REBASE_COMMAND,
  dependabotOwnRedSignal,
  dependabotReviewArgs,
  depReviewOwnRedSubmissionKey,
  prioritizeDepReviewRepairs,
  type DepReviewRepairSnapshot,
  reconcileDependabotOwnRed,
  renderDepReviewOwnRedFeedback,
  type DependabotOwnRedSignal,
  type DepReviewResult,
} from "#src/lib/dep-review.js";
import { clockFromMillisFn } from "#src/lib/clock.js";
import type { Config } from "#src/lib/config.js";
import type { IssueGateway } from "#src/lib/escalate.js";
import type { Plan } from "#src/lib/plan.js";
import { buildSweepEffects, depReviewCommand, type DepReviewDeps } from "#test/helpers/run-task-test.js";
import { DEFAULT_SWEEP_POLICY, runSweep, type OpenPrView, type SweepDeps } from "#test/helpers/sweep-test.js";

const NOW = Date.parse("2026-10-15T09:00:00.000Z");
const ASOF = "2026-10-15T09:00:00.000Z";
const MAIN = "32cfb064f".padEnd(40, "0");
const SDK_TITLE = "build(deps): bump @anthropic-ai/claude-agent-sdk from 0.3.293 to 0.3.296";
const CLI_TITLE = "build(deps): bump @anthropic-ai/claude-code from 2.1.293 to 2.1.296 in /deploy";
const RED_CHECK = "coverage-shard (4/8)";

test("an exact-head aged dependency repair precedes 63 older incidents without changing admission", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "rmd-dep-priority-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, "dep-review-holds", "craigoley", "remudero");
  mkdirSync(dir, { recursive: true });
  const id = "fb-dep-review-0216c34510eeb042";
  const candidates = [...Array.from({ length: 63 }, (_, i) => `incident-${i}`), id];
  const bumps = [{ dependency: "sdk", fromVersion: "1.0.0", toVersion: "1.0.1" }];
  const proposal = { feedbackId: id, prNumbers: [13350], bumps: ["sdk@1.0.1"] };
  const record = { feedbackId: id, headSha: MAIN, bumps, redChecks: ["ci"], firstSeenMs: NOW - 7200000, lastSeenMs: NOW };
  const registry = (value: unknown) => writeFileSync(join(dir, "own-red-proposals.json"), JSON.stringify(value));
  const state = (value: unknown) => writeFileSync(join(dir, "PR13350.json"), JSON.stringify(value));
  registry({ proposals: [proposal] }); state({ ownRed: record });
  const snapshot: DepReviewRepairSnapshot = { owner: "craigoley", repo: "remudero", asOfMs: NOW, prs: [{
    prNumber: 13350, headSha: MAIN, headRefName: "dependabot/npm_and_yarn/sdk", checksState: "red",
    createdAt: new Date(NOW - 7200000).toISOString(),
  }] };
  const rows: string[] = [];
  const ordered = await prioritizeDepReviewRepairs(candidates, root, snapshot, NOW, step => rows.push(step));
  assert.deepEqual(ordered, [id, ...candidates.slice(0, 63)]);
  assert.deepEqual(candidates.slice(-1), [id], "the existing FIFO input is not mutated");
  assert.deepEqual(rows, ["auto_triage.repair_priority"]);
  assert.deepEqual(await prioritizeDepReviewRepairs(candidates, root, { ...snapshot,
    prs: [...snapshot.prs, { ...snapshot.prs[0], prNumber: 13354 }] }, NOW), ordered,
    "an unrelated red PR without repair state cannot starve a positively verified repair");
  assert.deepEqual(await prioritizeDepReviewRepairs(candidates.slice(0, 63), root, snapshot, NOW), candidates.slice(0, 63),
    "a repair absent from the eligible set is never reintroduced");
  for (const changed of [undefined, { ...snapshot, asOfMs: NOW - 300001 }, { ...snapshot, asOfMs: NOW + 1 },
    { ...snapshot, prs: [] }, { ...snapshot, owner: "../other" }, { ...snapshot, asOfMs: Number.NaN },
    ...["green", "pending", "none"].map(checksState => ({ ...snapshot, prs: [{ ...snapshot.prs[0], checksState }] })),
    { ...snapshot, prs: [{ ...snapshot.prs[0], createdAt: new Date(NOW - 3599999).toISOString() }] },
    { ...snapshot, prs: [{ ...snapshot.prs[0], createdAt: "unknown" }] },
    { ...snapshot, prs: [{ ...snapshot.prs[0], headSha: "different" }] },
    { ...snapshot, prs: [{ ...snapshot.prs[0], headRefName: "run-unfiled-1" }] }]) {
    assert.deepEqual(await prioritizeDepReviewRepairs(candidates, root, changed as DepReviewRepairSnapshot | undefined, NOW), candidates);
  }
  for (const changed of [{ ...record, feedbackId: "other" }, { ...record, bumps: [{ ...bumps[0], toVersion: "2.0.0" }] }, null]) {
    state({ ownRed: changed });
    assert.deepEqual(await prioritizeDepReviewRepairs(candidates, root, snapshot, NOW), candidates);
  }
  state({ ownRed: record });
  for (const changed of [{ proposals: [{ ...proposal, prNumbers: [1] }] }, { proposals: [{ ...proposal, feedbackId: "other" }] },
    { proposals: [{ ...proposal, bumps: [] }] }, { proposals: null }, null]) {
    registry(changed);
    assert.deepEqual(await prioritizeDepReviewRepairs(candidates, root, snapshot, NOW), candidates);
  }
  registry({ proposals: [proposal] });
  assert.deepEqual(await prioritizeDepReviewRepairs(candidates, root, snapshot, NOW, () => { throw new Error("telemetry unavailable"); }), ordered);
  writeFileSync(join(dir, "own-red-proposals.json"), "{broken");
  assert.deepEqual(await prioritizeDepReviewRepairs(candidates, root, snapshot, NOW, () => { throw new Error("telemetry unavailable"); }), candidates);
  rmSync(join(dir, "own-red-proposals.json"));
  assert.deepEqual(await prioritizeDepReviewRepairs(candidates, root, snapshot, NOW), candidates);
});

interface FixturePr { number: number; title: string; head: string; red: boolean }

interface Fixture {
  run: (prNumber: number, signal?: string) => Promise<number>;
  advance: (ms: number) => void;
  pr: (prNumber: number) => FixturePr;
  holdDir: string;
  captures: Array<{ id: string; raw: string; submissionKey: string }>;
  failCapture: (fail: boolean) => void;
  comments: Array<{ url: string; body: string }>;
  ledger: () => Record<string, unknown>[];
}

function fixture(t: TestContext): Fixture {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1-t9586-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ledgerPath = join(root, "state", "ledger.ndjson");
  let now = NOW;
  let captureFails = false;
  const prs = new Map<number, FixturePr>([
    [11788, { number: 11788, title: SDK_TITLE, head: "b00fda7b".padEnd(40, "0"), red: true }],
    [11791, { number: 11791, title: CLI_TITLE, head: "a11791aa".padEnd(40, "0"), red: true }],
    [11800, { number: 11800, title: SDK_TITLE, head: "c11800cc".padEnd(40, "0"), red: true }],
  ]);
  const captures: Fixture["captures"] = [];
  const comments: Fixture["comments"] = [];
  const issues: IssueGateway = { create: () => "https://github.com/craigoley/remudero/issues/9586", listOpen: () => [], closeWithComment() {} };
  const deps: DepReviewDeps = {
    config: { root, ledger: ledgerPath } as never,
    clock: clockFromMillisFn(() => now),
    gh: (args) => {
      const pr = prs.get(Number(args[2]))!;
      return {
        number: pr.number, url: `https://github.com/craigoley/remudero/pull/${pr.number}`, title: pr.title, body: "",
        headRefOid: pr.head, headRefName: `dependabot/npm_and_yarn/pr-${pr.number}`, author: { login: "app/dependabot" },
        statusCheckRollup: [{ name: "ci-gate", conclusion: pr.red ? "FAILURE" : "SUCCESS" },
          { name: RED_CHECK, conclusion: pr.red ? "FAILURE" : "SUCCESS" }],
        commits: [{ oid: pr.head, authors: [{ login: "", name: "dependabot[bot]" }] }],
      };
    },
    prDiff: () => "diff --git a/package.json b/package.json\n--- a/package.json\n+++ b/package.json\n",
    postStatus: (async () => ({ posted: true })) as DepReviewDeps["postStatus"],
    arm: () => "armed",
    issues,
    captureMigrationFeedback: ((args: { id: string; raw: string; submissionKey: string }) => {
      if (captureFails) throw new Error("feedback store unavailable");
      captures.push({ id: args.id, raw: args.raw, submissionKey: args.submissionKey });
      return { id: args.id };
    }) as never,
    prMutations: {
      comment: (url, body) => { comments.push({ url, body }); },
      close: () => { throw new Error("an own-red proposal never closes the Dependabot PR"); },
    },
  };
  return {
    run: (prNumber, signal) => depReviewCommand(String(prNumber),
      ["--repo", "remudero", ...(signal === undefined ? [] : ["--dependabot-own-red", signal])], deps),
    advance: (ms) => { now += ms; },
    pr: (prNumber) => prs.get(prNumber)!,
    holdDir: join(root, "state", "dep-review-holds", "craigoley", "remudero"),
    captures,
    failCapture: (fail) => { captureFails = fail; },
    comments,
    ledger: () => readFileSync(ledgerPath, "utf8").trim().split("\n").map((line) => JSON.parse(line)),
  };
}

function holdResult(over: Partial<DepReviewResult> = {}): DepReviewResult {
  return { decision: "hold", semverLevel: "patch", pinOnly: false, offendingFiles: [], redChecks: [RED_CHECK],
    migrationBumps: [], reason: "required check(s) not green", ...over };
}

function view(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 11788, prUrl: "https://github.com/craigoley/remudero/pull/11788", headSha: "b00fda7b".padEnd(40, "0"),
    headRefName: "dependabot/npm_and_yarn/sdk", isDependabot: true, reviewState: "none", checksState: "red",
    ciFailures: [{ name: RED_CHECK, logTail: "# fail 1" }], unmetCriteria: [], priorStrikes: 0,
    lastActivityAt: "2026-10-15T08:00:00.000Z", autoMergeArmed: false, mergeState: "clean",
    changedFiles: ["package.json", "package-lock.json"], ...over,
  };
}

function mainHealth(state: "red" | "green", observed: string[]): Record<string, unknown> {
  return { run_id: "main-health", task_id: "DAEMON", step: "main.health.observed", ts: ASOF, sha: MAIN, state,
    failing_checks: state === "red" ? ["ci"] : [], observed_checks: observed };
}

async function sweepSignals(seed: Record<string, unknown>[], pr: OpenPrView): Promise<Array<DependabotOwnRedSignal | undefined>> {
  const rows = [...seed];
  const signals: Array<DependabotOwnRedSignal | undefined> = [];
  const deps: SweepDeps = {
    arm: () => {}, close: () => {}, dispatchFix: () => {}, escalate: () => {},
    ledgerPath: "/nonexistent-rmd-w1-t9586/ledger.ndjson", runId: "W1-T9586-sweep", now: () => NOW,
    readLedger: () => rows.slice(), appendLine: (_path, row) => { rows.push({ ...row, ts: ASOF }); },
    depReview: (_pr, _refresh, ownRed) => { signals.push(ownRed); return "hold"; },
  };
  await runSweep([pr], deps, DEFAULT_SWEEP_POLICY);
  return signals;
}

test("W1-T9586: an own-red minor dependency hold files one migration proposal and leaves the PR open", async (t) => {
  // The sweep reads the red as the head's own and says on what evidence: main's newest run passes the check.
  assert.deepEqual(await sweepSignals([mainHealth("green", ["ci", "ci-gate", RED_CHECK])], view()), ["main-passes"]);
  assert.deepEqual(await sweepSignals([mainHealth("red", ["ci", RED_CHECK])], view()), ["main-passes"],
    "a check main's run passes is this head's red, even beside main's own red");
  assert.deepEqual(await sweepSignals([mainHealth("green", ["ci"])], view()), ["unclassified"],
    "a check main's census never ran is not evidence either way");
  assert.deepEqual(await sweepSignals([mainHealth("red", ["ci"])], view({ ciFailures: [{ name: "ci", logTail: "" }] })), [undefined],
    "main's own red is a wait, never an own red");
  assert.equal(dependabotOwnRedSignal({ kind: "own" }, undefined, []), undefined, "a head with no failure has no own red");
  assert.equal(dependabotOwnRedSignal({ kind: "own" }, { state: "pending", failingChecks: [], observedChecks: [RED_CHECK] }, [RED_CHECK]),
    "unclassified", "an unsettled main run passes nothing");

  // The effect adapter carries the signal to the command as a flag; a refresh request still wins.
  assert.deepEqual(dependabotReviewArgs({ kind: "own" }, "main-passes"), ["--dependabot-own-red", "main-passes"]);
  assert.deepEqual(dependabotReviewArgs({ kind: "request", cause: "fixed-on-main", check: "x" }, undefined), ["--dependabot-refresh", "fixed-on-main"]);
  assert.deepEqual(dependabotReviewArgs({ kind: "wait", check: "ci" }, undefined), []);
  const fxRoot = mkdtempSync(join(tmpdir(), "rmd-w1-t9586-fx-"));
  t.after(() => rmSync(fxRoot, { recursive: true, force: true }));
  const commandArgs: string[][] = [];
  const effects = buildSweepEffects({ owner: "craigoley", repo: "remudero", config: { root: fxRoot, claudeBin: "/bin/true" } as Config,
    ledgerPath: join(fxRoot, "ledger.ndjson"), runId: "W1-T9586-fx", plan: { tasks: [], byId: new Map() } as Plan,
    policy: DEFAULT_SWEEP_POLICY, log: () => {}, contributorAdmissionImpl: async () => {},
    depReviewCommandImpl: async (_pr, rest = []) => { commandArgs.push(rest); return 1; } });
  await effects.depReview!(view(), { kind: "own" }, "main-passes");
  assert.deepEqual(commandArgs, [["--repo", "remudero", "--dependabot-own-red", "main-passes"]]);

  const f = fixture(t);
  // Control: with no own-red signal the hold is exactly W1-T9584's: nothing filed.
  assert.equal(await f.run(11788), 1);
  f.advance(15 * 60_000);
  assert.equal(await f.run(11788), 1);
  assert.equal(f.captures.length, 0);

  // First own-red pass records the head; the next pass files the proposal.
  assert.equal(await f.run(11788, "main-passes"), 1);
  assert.equal(f.captures.length, 0, "the first own-red pass records the head so a held sibling can register");
  assert.equal(f.ledger().filter((r) => r.step === "dep-review.own_red.observed").length, 1);
  f.advance(15 * 60_000);
  assert.equal(await f.run(11788, "main-passes"), 1, "the PR stays held: an own-red proposal arms nothing");
  assert.equal(f.captures.length, 1, "one migration proposal");
  const [proposal] = f.captures;
  assert.match(proposal.id, /^fb-dep-review-[0-9a-f]{16}$/);
  assert.match(proposal.raw, /Dependabot PR #11788/);
  assert.match(proposal.raw, new RegExp(`Head: ${f.pr(11788).head}`));
  assert.match(proposal.raw, /@anthropic-ai\/claude-agent-sdk 0\.3\.293 -> 0\.3\.296/);
  assert.match(proposal.raw, /Red checks: ci-gate, coverage-shard \(4\/8\)/);
  assert.match(proposal.raw, /owned task branch/);
  assert.match(proposal.raw, /claudeCodeVersion/);
  assert.equal(proposal.submissionKey, "dep-review:own-red:craigoley/remudero:@anthropic-ai/claude-agent-sdk@0.3.296");
  assert.deepEqual(f.comments, [], "no @dependabot command is posted");
  const captured = f.ledger().filter((r) => r.step === "dep-review.own_red.feedback_captured");
  assert.equal(captured.length, 1);
  assert.equal(captured[0].pr_number, 11788);
  assert.equal(captured[0].head_sha, f.pr(11788).head);
  assert.equal(captured[0].feedback_id, proposal.id);
  assert.deepEqual(captured[0].red_checks, ["ci-gate", RED_CHECK]);
  assert.equal(captured[0].basis, "main-passes");
  assert.equal(f.ledger().some((r) => String(r.step).startsWith("dep-review.migrate.")), false, "never the major path's ignore and close");
  assert.equal(f.ledger().filter((r) => r.step === "dep-review.decided").at(-1)?.decision, "hold");

  // Green checks are no hold: nothing more is filed.
  f.pr(11788).red = false;
  assert.equal(await f.run(11788, "main-passes"), 0);
  assert.equal(f.captures.length, 1);
});

test("W1-T9586: the same bumps never file a second proposal", async (t) => {
  const f = fixture(t);
  // #11788 and #11791 are held own-red in the same cycle; the first to file names the other, which folds in.
  await f.run(11788, "main-passes");
  await f.run(11791, "main-passes");
  f.advance(15 * 60_000);
  await f.run(11788, "main-passes");
  await f.run(11791, "main-passes");
  assert.equal(f.captures.length, 1, "one proposal for the pair that cannot pass alone");
  assert.match(f.captures[0].raw, /Sibling Dependabot PRs folded in: #11791 \(@anthropic-ai\/claude-code 2\.1\.293 -> 2\.1\.296\)/);
  assert.equal(f.captures[0].submissionKey,
    "dep-review:own-red:craigoley/remudero:@anthropic-ai/claude-agent-sdk@0.3.296,@anthropic-ai/claude-code@2.1.296");
  const folded = f.ledger().filter((r) => r.step === "dep-review.own_red.folded");
  assert.deepEqual(folded.map((r) => [r.pr_number, r.feedback_id]), [[11791, f.captures[0].id]]);
  assert.deepEqual(f.ledger().find((r) => r.step === "dep-review.own_red.feedback_captured")?.folded_prs, [11791]);

  // A second pass on the same heads files nothing new.
  f.advance(15 * 60_000);
  await f.run(11788, "main-passes");
  await f.run(11791, "main-passes");
  // A regrouped Dependabot PR with the same bumps, and a rebased head of #11788, fold into the same proposal.
  await f.run(11800, "main-passes");
  f.pr(11788).head = "d11788dd".padEnd(40, "0");
  await f.run(11788, "main-passes");
  f.advance(15 * 60_000);
  await f.run(11800, "main-passes");
  await f.run(11788, "main-passes");
  assert.equal(f.captures.length, 1, "the same bumps never file a second proposal");
  assert.deepEqual(f.ledger().filter((r) => r.step === "dep-review.own_red.folded").map((r) => r.pr_number), [11791, 11800, 11788]);
  assert.deepEqual(f.comments, []);

  // Losing the registry still cannot mint a new key for the same bumps: the capture store dedupes on it.
  const key = depReviewOwnRedSubmissionKey("CraigOley", "Remudero", [
    { dependency: "@anthropic-ai/claude-code", fromVersion: "2.1.293", toVersion: "2.1.296" },
    { dependency: "@anthropic-ai/claude-agent-sdk", fromVersion: "0.3.293", toVersion: "0.3.296" },
    { dependency: "@anthropic-ai/claude-agent-sdk", fromVersion: "0.3.293", toVersion: "0.3.296" },
  ]);
  assert.equal(key, f.captures[0].submissionKey, "the key is the sorted, de-duplicated bump set, case-folded");
});

test("W1-T9586: a red that survived a Dependabot refresh is own; a failed capture keeps the hold and retries", async (t) => {
  const f = fixture(t);
  // Unclassified with no refresh on record: the hold stands and nothing is recorded.
  await f.run(11788, "unclassified");
  f.advance(60_000);
  await f.run(11788, "unclassified");
  assert.equal(f.ledger().some((r) => String(r.step).startsWith("dep-review.own_red.")), false);
  // A refresh was delivered for an earlier head, and the head Dependabot rebuilt is still red.
  const statePath = join(f.holdDir, "PR11788.json");
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  state.refreshes = [{ headSha: "e".repeat(40), command: DEPENDABOT_REBASE_COMMAND, cause: "fixed-on-main", requestedAtMs: NOW, delivered: true }];
  writeFileSync(statePath, `${JSON.stringify(state)}\n`);
  await f.run(11788, "unclassified");
  f.advance(60_000);
  f.failCapture(true);
  assert.equal(await f.run(11788, "unclassified"), 1);
  assert.equal(f.ledger().filter((r) => r.step === "dep-review.own_red.capture_failed").length, 1, "fail closed: the hold stays");
  f.failCapture(false);
  await f.run(11788, "unclassified");
  assert.equal(f.captures.length, 1, "a failed capture is retried on the next pass");
  assert.match(f.captures[0].raw, /survived a requested Dependabot refresh/);
  assert.match(f.captures[0].raw, /Sibling Dependabot PRs folded in: none/);

  // Unreadable durable state fails closed: the command ledgers it and files nothing.
  writeFileSync(statePath, `${JSON.stringify({ ...state, headSha: f.pr(11788).head, heldSinceMs: NOW, ownRed: { headSha: 7 } })}\n`);
  assert.equal(await f.run(11788, "main-passes"), 1);
  assert.equal(f.ledger().filter((r) => r.step === "dep-review.own_red.failed").length, 1);
  assert.equal(f.captures.length, 1);
});

test("W1-T9586: the reconcile refuses unreadable proposals, skips unreadable siblings and never keys an unparsed bump", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-w1-t9586-unit-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(dir, { recursive: true });
  const statePath = join(dir, "PR11788.json");
  const steps: string[] = [];
  const captures: string[] = [];
  const reconcile = (over: Partial<Parameters<typeof reconcileDependabotOwnRed>[0]> = {}) => reconcileDependabotOwnRed({
    statePath, owner: "craigoley", repo: "remudero", prUrl: "https://github.com/craigoley/remudero/pull/11788", prNumber: 11788,
    title: SDK_TITLE, body: "Bumps the npm group.", headSha: "a".repeat(40), result: holdResult(), signal: "main-passes", nowMs: NOW,
    capture: ({ raw }) => { captures.push(raw); return { id: "fb-dep-review-0000000000000000" }; },
    log: (step) => { steps.push(step); }, ...over,
  });
  assert.equal(reconcile({ result: holdResult({ decision: "arm", redChecks: [] }) }), "none");
  assert.equal(reconcile({ signal: undefined }), "none");
  assert.equal(reconcile({ title: "chore: refresh the toolchain" }), "unkeyed", "no parsed bump, no key: the 24 h backstop owns it");
  assert.deepEqual(steps, ["dep-review.own_red.unkeyed"]);

  // An unreadable sibling is not named; a sibling seen before this head was first seen is stale.
  writeFileSync(join(dir, "PR11791.json"), "{not json");
  writeFileSync(join(dir, "PR11792.json"), `${JSON.stringify({ headSha: "s".repeat(40), heldSinceMs: NOW, asks: [], ownRed: {
    headSha: "s".repeat(40), bumps: [{ dependency: "x", fromVersion: "1.0.0", toVersion: "1.0.1" }], redChecks: ["ci"],
    firstSeenMs: NOW - 1, lastSeenMs: NOW - 1 } })}\n`);
  assert.equal(reconcile(), "observed");
  assert.equal(reconcile({ nowMs: NOW + 1 }), "captured");
  assert.match(captures[0], /Sibling Dependabot PRs folded in: none/);
  assert.match(captures[0], /Bumps the npm group\./);
  assert.equal(reconcile({ nowMs: NOW + 2 }), "proposed", "the same head is never filed twice");

  // A proposal registry that cannot be read refuses to file, rather than filing a duplicate.
  writeFileSync(join(dir, "own-red-proposals.json"), `${JSON.stringify({ proposals: [{ feedbackId: 1 }] })}\n`);
  assert.equal(reconcile({ headSha: "b".repeat(40), nowMs: NOW + 3 }), "observed");
  assert.throws(() => reconcile({ headSha: "b".repeat(40), nowMs: NOW + 4 }), /invalid dependency own-red proposals/);
  assert.equal(captures.length, 1);

  assert.match(renderDepReviewOwnRedFeedback({ prUrl: "u", prNumber: 1, title: "t", body: "  ", headSha: "h", basis: "main-passes",
    bumps: [], redChecks: ["ci"], siblings: [] }), /\(empty body\)/);
});
