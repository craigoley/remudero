/**
 * test/acceptance-fallback-diff-anchor.test.ts — W1-T4263.
 *
 * The auto-authored Acceptance fallback grepped `acceptanceAuthorTimeCheck`, a function main already has. So
 * `proof-discrimination` read it as passing at the merge base on every untasked PR that reached it, and such a PR gets
 * zero stale allowance. Each of the three authoring sites (PR open, the fix rung's body repair, and the retro repair)
 * now greps a line the PR's own diff adds. The static grep stays as the last resort, and every site ledgers
 * `acceptance.fallback.diff_anchor_unavailable` when it falls back to it.
 *
 * The fixtures are real git repositories with `origin/main` seeded. The test never mocks git's own output.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  acceptanceGateBodyRepair,
  bodyRepairFallback,
  DIFF_ANCHOR_UNAVAILABLE_STEP,
  diffAnchoredAcceptanceCriterion,
  diffSinceMergeBase,
  ghPrCreateFillCommand,
  repairRetroAcceptanceBlock,
  runFixRung,
  runGhPrCreate,
} from "./helpers/acceptance-fallback-surface.js";
import { acceptanceAuthorTimeCheck, execWhitelistedProof, parseAcceptanceBlock, parseWhitelistedProof, preexistingProofHits } from "../src/lib/review.js";
import { renderAcceptanceBlock } from "../src/lib/plan-pr-emitter.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import type { Config } from "../src/lib/config.js";
import type { ReviewVerdict } from "../src/lib/review.js";
import type { WorkerResult } from "../src/lib/worker.js";

const STATIC_PROOF = "grep: ^export function acceptanceAuthorTimeCheck in src/lib/review.ts";
const ADDED_LINE = "export const diffAnchorMarker = 4263;";
const ADDED_PROOF = `grep: ${ADDED_LINE} in src/feature.ts`;
const PR = "https://github.com/acme/remudero/pull/4263";

/** A unified diff in the shape both `git diff` and the PR diff read emit. */
const UNIFIED_DIFF = [
  "diff --git a/src/feature.ts b/src/feature.ts",
  "index 1111111..2222222 100644",
  "--- a/src/feature.ts",
  "+++ b/src/feature.ts",
  "@@ -1,0 +2 @@",
  "+}",
  `+${ADDED_LINE}`,
  "",
].join("\n");

const DELETION_ONLY_DIFF = [
  "diff --git a/src/feature.ts b/src/feature.ts",
  "--- a/src/feature.ts",
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "-export const existing = 1;",
  "",
].join("\n");

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.invalid" };

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: GIT_ENV });
}

/** A real repo: `origin/main` carries src/feature.ts, and the branch commits `change` on top of it. */
function repoWithChange(change: (dir: string) => void): string {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}diff-anchor-`));
  git(dir, "init", "--quiet", "-b", "main");
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "feature.ts"), "export const existing = 1;\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "chore: seed");
  git(dir, "update-ref", "refs/remotes/origin/main", git(dir, "rev-parse", "HEAD").trim());
  change(dir);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "feat(x): a subject\n\nno Acceptance block in this commit message");
  return dir;
}

const addsTheMarker = (dir: string) => writeFileSync(join(dir, "src", "feature.ts"), `export const existing = 1;\n${ADDED_LINE}\n`);
const deletesTheFile = (dir: string) => rmSync(join(dir, "src", "feature.ts"));

type Logged = Array<{ step: string; extra?: Record<string, unknown> }>;

/** The body the REST create would send. `logged` receives what `runGhPrCreate`, the production executor, ledgers. */
function openedBody(dir: string, logged: Logged = []): string {
  const built = withLiveWritesAllowed(() => ghPrCreateFillCommand(dir, "o", "r", "run-T1-1", "feat(x): a subject"));
  runGhPrCreate(built, "run-T1-1", (step, extra) => logged.push({ step, extra }), () => {}, () => '{"html_url":"https://github.com/o/r/pull/1","number":1}');
  const at = built.args.findIndex((a) => a.startsWith("body="));
  assert.notEqual(at, -1, "the create argv must carry a body");
  return built.args[at].slice("body=".length);
}

test("W1-T4263: a unified-diff fixture yields a grep proof naming the exact added line and its file path", () => {
  const criterion = diffAnchoredAcceptanceCriterion(UNIFIED_DIFF);
  assert.ok(criterion, "a diff carrying a genuine added line must yield a criterion");
  assert.equal(criterion.proof, ADDED_PROOF, "the first SAFE added line: `}` is too short to discriminate anything");
  assert.notEqual(criterion.proof, STATIC_PROOF);
  assert.match(criterion.claim, /not a claim that the underlying diff is correct, or that any task's acceptance is met/);
  assert.deepEqual(parseAcceptanceBlock(renderAcceptanceBlock([criterion])), [criterion], "it round-trips through the block it is written into");
  assert.equal(diffAnchoredAcceptanceCriterion(DELETION_ONLY_DIFF), undefined, "a deletion-only diff has no anchor");
  assert.equal(diffAnchoredAcceptanceCriterion(""), undefined);
});

test("W1-T4263: the diff-anchored proof misses at the merge base and passes at head under the real reviewer machinery", () => {
  const anchored = diffAnchoredAcceptanceCriterion(UNIFIED_DIFF);
  assert.ok(anchored);
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}diff-anchor-exec-`));
  try {
    const head = join(root, "head");
    const base = join(root, "base");
    for (const dir of [head, base]) {
      mkdirSync(join(dir, "src", "lib"), { recursive: true });
      writeFileSync(join(dir, "src", "lib", "review.ts"), "export function acceptanceAuthorTimeCheck() {}\n");
      writeFileSync(join(dir, "src", "feature.ts"), "export const existing = 1;\n");
    }
    writeFileSync(join(head, "src", "feature.ts"), `export const existing = 1;\n${ADDED_LINE}\n`);
    const exec = (w: NonNullable<ReturnType<typeof parseWhitelistedProof>>, cwd: string) => execWhitelistedProof(w, cwd);

    const parsed = parseWhitelistedProof(anchored.proof);
    assert.ok(parsed && parsed.kind === "grep", "the anchored proof parses through the real whitelist");
    assert.equal(exec(parsed, head), "pass", "it passes at head");
    assert.equal(exec(parsed, base), "fail", "and finds nothing at the merge base");
    assert.equal(preexistingProofHits(parsed, exec, base), false, "the reviewer's base classifier does not call it stale");

    // The shape it replaces is the shape proof-discrimination refuses: it passes at both.
    const old = parseWhitelistedProof(STATIC_PROOF);
    assert.ok(old);
    assert.equal(preexistingProofHits(old, exec, base), true, "the static grep passes at the merge base");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T4263: the PR-open fallback criterion greps a line its own diff adds", () => {
  const dir = repoWithChange(addsTheMarker);
  const logged: Logged = [];
  assert.equal(diffSinceMergeBase(dir)?.includes(`+${ADDED_LINE}`), true, "the worktree's own diff since its merge base is read");
  const criteria = parseAcceptanceBlock(openedBody(dir, logged));
  assert.equal(criteria.length, 1);
  assert.equal(criteria[0].proof, ADDED_PROOF, "the opened body's proof greps the line this branch adds");
  assert.match(criteria[0].claim, /auto-authored when the PR was opened/, "the open-time provenance wording is kept");
  assert.equal(logged.some((l) => l.step === DIFF_ANCHOR_UNAVAILABLE_STEP), false, "an anchored fallback ledgers nothing");
});

function noReviewYet(headSha: string): ReviewVerdict & { headSha: string; reviewerOutcome: string } {
  return { state: "failure", criteria: [], testTheater: false, summary: "", floorDegraded: false, capped: false, keywordOnly: false, planOnly: false, headSha, reviewerOutcome: "success" };
}

function result(): WorkerResult {
  return {
    sessionId: "s", costUsd: 0, numTurns: 0, text: "", blocks: [], stderr: "", subtype: "success", isError: false, apiError: false,
    permissionDenials: [], childEnvKeys: [], model: "default", effort: "default",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, modelUsage: {}, compactionEvents: [], qualitySuspect: false,
  };
}

async function fixRungRepairedBody(worktreePath: string, headSha: string, logged: Logged): Promise<string[]> {
  const mount = { model: "sonnet", effort: "medium", maxTurns: 400, contextBudget: 120000 } as const;
  const gate = { name: "acceptance-author-gate", logTail: "REFUSED (no-header)" };
  const written: string[] = [];
  await runFixRung({
    taskId: "PR-4263", runId: "PR-4263-1", task: { id: "PR-4263", title: "PR #4263" }, prUrl: PR, branch: "fix/a-branch",
    worktreePath, initialSessionId: "session-0", mount, settingsFile: join(worktreePath, "settings.json"), config: {} as Config, budgetUsd: 1,
    reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: worktreePath, reviewerMount: mount },
    strikeCap: 1,
    initialReview: noReviewYet(headSha),
    ciFailures: [gate],
    deps: {
      spawn: async () => result(),
      waitForCiGreen: async () => "red",
      fetchCiFailures: async () => [gate],
      fetchPrBody: async () => "This PR fixes the thing.\n",
      updatePrBody: async (_url, body) => {
        written.push(body);
      },
      addedTestsAtHead: () => ({ kind: "read", files: [] }),
      runReview: async () => noReviewYet(headSha),
      push: () => {},
      issues: { create: () => "https://github.com/acme/remudero/issues/1", listOpen: () => [], comment() {} },
      ledgerPath: join(mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}diff-anchor-ledger-`)), "ledger.ndjson"),
      log: (step, extra) => logged.push({ step, extra }),
      say: () => {},
      account: (r) => r,
    },
  });
  return written;
}

test("W1-T4263: the body-repair fallback criterion is anchored on its checkout diff", async () => {
  const dir = repoWithChange(addsTheMarker);
  const headSha = git(dir, "rev-parse", "HEAD").trim();
  const logged: Logged = [];
  // The fix rung's DEFAULT diff read: no `diffAtHead` dep, so it reads `opts.worktreePath` at the PR head.
  const written = await fixRungRepairedBody(dir, headSha, logged);
  assert.equal(written.length, 1, "the no-header body is repaired with a body-only write");
  const criteria = parseAcceptanceBlock(written[0]);
  assert.equal(criteria.length, 1);
  assert.equal(criteria[0].proof, ADDED_PROOF, "the repaired proof greps the line the checkout's diff adds");
  assert.match(criteria[0].claim, /mechanically repaired by the fix rung/, "the fix rung's provenance wording is kept");
  assert.equal(acceptanceAuthorTimeCheck(written[0]).ok, true, "and the repaired body passes the gate's own predicate");
  assert.equal(logged.some((l) => l.step === DIFF_ANCHOR_UNAVAILABLE_STEP), false);
});

test("W1-T4263: the retro acceptance repair fallback is dialect-valid and diff-anchored", () => {
  const edits: string[] = [];
  const diffReads: string[] = [];
  const genericBody = renderAcceptanceBlock([{ claim: "auto-authored", proof: STATIC_PROOF }]);
  const outcome = repairRetroAcceptanceBlock(PR, () => {}, {
    fetchBody: () => genericBody,
    editBody: (_url, body) => edits.push(body),
    // No `diff`: the repair reads the PR diff itself through its own dep.
    diffText: (url) => {
      diffReads.push(url);
      return UNIFIED_DIFF;
    },
  });
  assert.equal(outcome, "repaired");
  assert.deepEqual(diffReads, [PR], "the PR's own diff is read once, for this PR");
  const criteria = parseAcceptanceBlock(edits[0]);
  assert.equal(criteria.length, 1);
  assert.equal(criteria[0].proof, ADDED_PROOF, "the static grep is replaced by a grep of the line this PR adds");
  const parsed = parseWhitelistedProof(criteria[0].proof);
  assert.ok(parsed && parsed.kind === "grep", "the proof carries an executable dialect");
});

test("W1-T4263: with no usable diff anchor every site keeps the static fallback and ledgers diff_anchor_unavailable", async () => {
  // PR open: the branch only deletes, so no added line exists.
  const openLogged: Logged = [];
  const deleting = repoWithChange(deletesTheFile);
  assert.equal(parseAcceptanceBlock(openedBody(deleting, openLogged))[0].proof, STATIC_PROOF, "PR open keeps the static grep");
  const openRow = openLogged.find((l) => l.step === DIFF_ANCHOR_UNAVAILABLE_STEP);
  assert.deepEqual([openRow?.extra?.site, openRow?.extra?.reason], ["pr-open", "no-safe-candidate"]);

  // Body repair: the checkout diff cannot be read at all, through the fix rung's real wiring.
  const repairLogged: Logged = [];
  const notARepo = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}diff-anchor-norepo-`));
  const written = await fixRungRepairedBody(notARepo, "0000000000000000000000000000000000000000", repairLogged);
  assert.equal(parseAcceptanceBlock(written[0])[0].proof, STATIC_PROOF, "the body repair keeps the static grep");
  const repairRow = repairLogged.find((l) => l.step === DIFF_ANCHOR_UNAVAILABLE_STEP);
  assert.deepEqual([repairRow?.extra?.site, repairRow?.extra?.reason], ["body-repair", "no-diff"]);
  const pureLogged: Logged = [];
  const pure = acceptanceGateBodyRepair("no block", bodyRepairFallback("no block", [], () => DELETION_ONLY_DIFF, (step, extra) => pureLogged.push({ step, extra })));
  assert.equal(parseAcceptanceBlock(pure?.repairedBody ?? "")[0].proof, STATIC_PROOF);
  assert.equal(pureLogged.find((l) => l.step === DIFF_ANCHOR_UNAVAILABLE_STEP)?.extra?.reason, "no-safe-candidate");

  // Retro repair: an unreadable PR diff writes the static grep into a malformed body.
  const retroLogged: Logged = [];
  const edits: string[] = [];
  const outcome = repairRetroAcceptanceBlock(PR, (step, extra) => retroLogged.push({ step, extra }), {
    fetchBody: () => "a retro body with no judgeable acceptance block",
    editBody: (_url, body) => edits.push(body),
    diffText: () => {
      throw new Error("the PR diff could not be read");
    },
  });
  assert.equal(outcome, "repaired");
  assert.equal(parseAcceptanceBlock(edits[0])[0].proof, STATIC_PROOF, "the retro repair keeps the static grep");
  const retroRow = retroLogged.find((l) => l.step === DIFF_ANCHOR_UNAVAILABLE_STEP);
  assert.deepEqual([retroRow?.extra?.site, retroRow?.extra?.reason, retroRow?.extra?.pr_url], ["retro-repair", "no-diff", PR]);
});
