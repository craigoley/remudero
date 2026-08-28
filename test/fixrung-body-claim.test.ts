/**
 * test/fixrung-body-claim.test.ts — W1-T307.
 *
 * THE DEFECT (MEASURED 2026-08-03 on PR #1202/W1-T301). The fix rung's body-coverage strike read
 * the CI/coverage-ratchet gap and repaired it correctly — committing the genuinely missing test.
 * That commit took the changeset from 4 files to 5. The PR BODY still read "This PR touches
 * exactly 4 files: …", enumerating the original four. `bodyContradictsDiff` (lib/review.ts) then
 * failed the PR, CORRECTLY: the body did contradict its diff. The verdict was `FAIL … needs a
 * human`, and an operator's own edit of the count (4 -> 5, plus the new file) took the SAME head
 * sha to a pass. THE LOOP IS SELF-DEFEATING: every repair that adds a file to a PR whose body
 * enumerates its changeset guarantees this exact failure, converting a successful auto-fix into a
 * human-needed block.
 *
 * THE FIX. `deriveChangesetClaimUpdate` (pure, run-task.ts) reuses `bodyContradictsDiff`'s OWN
 * parse to decide whether a body's "exactly N files[: a, b]" claim is stale against the CURRENT
 * diff — never a second contradiction matcher that could disagree with the gate — and, when
 * confident, returns a body with ONLY that claim's count + enumeration mechanically corrected.
 * `runFixRung` calls this in `body-coverage` mode, right after fetching the fresh PR body and
 * BEFORE the review that judges it runs, writing the correction via `updatePrBody` (defaults to
 * `gh pr edit`) so the SAME strike that changed the file set closes its own staleness rather than
 * striking again on a block it already fixed.
 */
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  runFixRung,
  deriveChangesetClaimUpdate,
  fetchPrDiffFilesViaGh,
  updatePrBodyViaGh,
} from "../src/run-task.js";
import type { CriterionVerdict, ReviewVerdict } from "../src/lib/review.js";
import type { IssueGateway } from "../src/lib/escalate.js";
import type { Mount } from "../src/lib/mounts.js";
import type { Config } from "../src/lib/config.js";
import type { WorkerResult } from "../src/lib/worker.js";

function result(over: Partial<WorkerResult> = {}): WorkerResult {
  return {
    sessionId: "s",
    costUsd: 0,
    numTurns: 0,
    text: "",
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
    ...over,
  };
}

function criterion(over: Partial<CriterionVerdict> & Pick<CriterionVerdict, "claim" | "met">): CriterionVerdict {
  return { proof: "proof", reason: "", proof_exec: "not_executable", ...over };
}

function fakeReview(
  state: "success" | "failure",
  criteria: CriterionVerdict[],
  headSha = "deadbeef",
): ReviewVerdict & { headSha: string; reviewerOutcome: string } {
  return {
    state,
    criteria,
    testTheater: false,
    summary: state === "success" ? "all criteria met" : "unmet criteria",
    floorDegraded: false,
    capped: false,
    keywordOnly: false,
    planOnly: false,
    headSha,
    reviewerOutcome: "success",
  };
}

const FIX_RUNG_MOUNT: Mount = { model: "sonnet", effort: "medium", maxTurns: 400, contextBudget: 120000 };

function fixRungBaseOpts() {
  return {
    taskId: "W1-T307X",
    runId: "W1-T307X-1730000000000",
    task: { id: "W1-T307X", title: "Some task" },
    prUrl: "https://github.com/acme/remudero/pull/1202",
    branch: "run-W1-T307X-1730000000000",
    worktreePath: "/tmp/rmd-fixrung-bodyclaim-wt",
    initialSessionId: "session-0",
    mount: FIX_RUNG_MOUNT,
    settingsFile: "/tmp/rmd-fixrung-bodyclaim-settings.json",
    config: {} as Config,
    budgetUsd: 10,
    reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: "/tmp/rmd-fixrung-bodyclaim-wt", reviewerMount: FIX_RUNG_MOUNT },
  };
}

function tmpLedgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-fixrung-bodyclaim-")), "ledger.ndjson");
}

function fakeIssues(): IssueGateway {
  return {
    create() {
      return "https://github.com/acme/remudero/issues/9";
    },
  };
}

// ── deriveChangesetClaimUpdate — the pure boundary (all three acceptance criteria) ─────────────

test("deriveChangesetClaimUpdate (acceptance 1): a body's stale 'exactly N files: …' claim is updated to the CURRENT diff's count + enumeration when the rung's commit added a file", () => {
  const body =
    "## Summary\n" +
    "Repairs coverage-ratchet.\n\n" +
    "This PR touches exactly 4 files: `a.ts`, `b.ts`, `c.ts`, `d.ts`.\n\n" +
    "Remudero-Task: W1-T301\n";
  const diffFiles = ["a.ts", "b.ts", "c.ts", "d.ts", "e.test.ts"];
  const updated = deriveChangesetClaimUpdate(body, diffFiles);
  assert.ok(updated, "a stale count/enumeration claim must be updated");
  assert.match(updated!, /This PR touches exactly 5 files: `a\.ts`, `b\.ts`, `c\.ts`, `d\.ts`, `e\.test\.ts`\./);
  // NARROW: only the claim itself changes — the rest of the body (summary prose, trailer) is
  // untouched, never regenerated (design point 2, "a rung rewriting a human's rationale is a
  // worse failure than the one being fixed").
  assert.match(updated!, /## Summary\nRepairs coverage-ratchet\./);
  assert.match(updated!, /Remudero-Task: W1-T301/);
});

test("deriveChangesetClaimUpdate (acceptance 1): count-only claims (no enumeration) get their number updated and nothing invented", () => {
  const body = "This PR touches exactly 4 files.\n";
  const updated = deriveChangesetClaimUpdate(body, ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"]);
  assert.equal(updated, "This PR touches exactly 5 files.\n");
});

test("deriveChangesetClaimUpdate (acceptance 1): a single remaining file is pluralized correctly ('1 file', not '1 files')", () => {
  const body = "This PR touches exactly 2 files: `a.ts`, `b.ts`.\n";
  const updated = deriveChangesetClaimUpdate(body, ["a.ts"]);
  assert.equal(updated, "This PR touches exactly 1 file: `a.ts`.\n");
});

test("deriveChangesetClaimUpdate (acceptance 2): a body with no changeset claim at all is left untouched — never given one", () => {
  const body = "## Summary\nAdds a helper function and its test.\n\nRemudero-Task: W1-T301\n";
  assert.equal(deriveChangesetClaimUpdate(body, ["a.ts", "b.ts", "new.ts"]), undefined);
});

test("deriveChangesetClaimUpdate (acceptance 2): a claim that is ABOUT the changeset but already matches the diff is left untouched — nothing is stale", () => {
  const body = "This PR touches exactly 3 files: `a.ts`, `b.ts`, `c.ts`.\n";
  assert.equal(deriveChangesetClaimUpdate(body, ["a.ts", "b.ts", "c.ts"]), undefined);
});

test("deriveChangesetClaimUpdate (acceptance 2): a count phrase with no changeset-context word ('exactly one file' inside unrelated prose) is left untouched, per bodyContradictsDiff's own anchor", () => {
  const body = "Each unit-test proof resolves to exactly one file and matches exactly 1 test.\n";
  assert.equal(deriveChangesetClaimUpdate(body, ["a.ts", "b.ts", "c.ts"]), undefined);
});

test("deriveChangesetClaimUpdate (acceptance 3): a claim repeated verbatim twice in the body is left stale — an unambiguous splice is impossible, so it fails safe rather than editing the wrong (or both) occurrence(s)", () => {
  const claim = "This PR touches exactly 4 files: `a.ts`, `b.ts`, `c.ts`, `d.ts`.";
  const body = `${claim}\n\n(repeated in the appendix for clarity)\n\n${claim}\n`;
  assert.equal(deriveChangesetClaimUpdate(body, ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"]), undefined);
});

test("deriveChangesetClaimUpdate (acceptance 3): inconsistent enumeration wrapping is left stale rather than guessed at", () => {
  // One item backtick-wrapped, one quoted, one bare — not a uniform style to copy forward.
  const body = 'This PR touches exactly 3 files: `a.ts`, "b.ts", c.ts.\n';
  assert.equal(deriveChangesetClaimUpdate(body, ["a.ts", "b.ts", "c.ts", "new.ts"]), undefined);
});

test("deriveChangesetClaimUpdate (acceptance 3): an empty CURRENT diff (nothing to enumerate with confidence) is left stale", () => {
  const body = "This PR touches exactly 4 files: `a.ts`, `b.ts`, `c.ts`, `d.ts`.\n";
  assert.equal(deriveChangesetClaimUpdate(body, []), undefined);
});

test("fetchPrDiffFilesViaGh: returns the PR's changed file paths via the injected gh reader, and [] when files is absent", async () => {
  assert.deepEqual(
    await fetchPrDiffFilesViaGh("https://github.com/acme/remudero/pull/1", () => ({
      files: [{ path: "a.ts" }, { path: "b.ts" }],
    })),
    ["a.ts", "b.ts"],
  );
  assert.deepEqual(await fetchPrDiffFilesViaGh("https://github.com/acme/remudero/pull/1", () => ({})), []);
});

// ── runFixRung, wired end to end (acceptance 1, 2, 3 as behavior) ───────────────────────────────

test("runFixRung (acceptance 1): a body-coverage strike whose commit adds a file gets its PR body's stale changeset claim corrected via updatePrBody BEFORE the review that judges it runs, and the fix resolves", async () => {
  const failing = fakeReview("failure", [
    criterion({ claim: "criterion A is covered", met: false, reason: "proof unmet: report does not substantiate it (matched 4/12 proof keywords)" }),
  ]);
  const passing = fakeReview("success", [criterion({ claim: "criterion A is covered", met: true })]);
  const STALE_BODY = "This PR touches exactly 4 files: `a.ts`, `b.ts`, `c.ts`, `d.ts`.\n\nRemudero-Task: W1-T307X\n";
  const CURRENT_DIFF_FILES = ["a.ts", "b.ts", "c.ts", "d.ts", "e.test.ts"];

  const updateCalls: Array<{ prUrl: string; body: string }> = [];
  const reviewReports: string[] = [];

  const outcome = await runFixRung({
    ...fixRungBaseOpts(),
    strikeCap: 2,
    initialReview: failing,
    deps: {
      spawn: async () => result({ sessionId: "fix-1", text: "committed the missing coverage test" }),
      waitForCiGreen: async () => "green",
      fetchPrBody: async () => STALE_BODY,
      fetchPrDiffFiles: async () => CURRENT_DIFF_FILES,
      updatePrBody: async (prUrl, body) => {
        updateCalls.push({ prUrl, body });
      },
      runReview: async (args) => {
        reviewReports.push(args.report);
        // The floor passes ONLY once the corrected claim (5 files) is what's judged.
        return args.report.includes("exactly 5 files") ? passing : failing;
      },
      push: () => {},
      issues: fakeIssues(),
      ledgerPath: tmpLedgerPath(),
      log: () => {},
      say: () => {},
      account: (r) => r,
    },
  });

  assert.equal(updateCalls.length, 1, "the stale claim must be corrected exactly once, on the strike that caused the staleness");
  assert.equal(updateCalls[0].prUrl, "https://github.com/acme/remudero/pull/1202");
  assert.match(updateCalls[0].body, /exactly 5 files: `a\.ts`, `b\.ts`, `c\.ts`, `d\.ts`, `e\.test\.ts`/);

  assert.equal(reviewReports.length, 1, "exactly one re-review after the single strike");
  assert.equal(reviewReports[0], updateCalls[0].body, "the review must judge the UPDATED body — the update happens before the review re-runs");

  assert.equal(outcome.outcome, "fixed", "the corrected claim must let the review pass instead of parking the PR as needs-human");
  assert.equal(outcome.strikes, 1);
});

test("runFixRung (acceptance 2): a body carrying no changeset claim is never touched — updatePrBody is never called", async () => {
  const failing = fakeReview("failure", [
    criterion({ claim: "criterion A is covered", met: false, reason: "proof unmet: report does not substantiate it (matched 4/12 proof keywords)" }),
  ]);
  const passing = fakeReview("success", [criterion({ claim: "criterion A is covered", met: true })]);
  const PLAIN_BODY = "## Summary\nAdds the missing coverage test.\n\nRemudero-Task: W1-T307X\n";

  let updateCalls = 0;

  const outcome = await runFixRung({
    ...fixRungBaseOpts(),
    strikeCap: 1,
    initialReview: failing,
    deps: {
      spawn: async () => result({ sessionId: "fix-1" }),
      waitForCiGreen: async () => "green",
      fetchPrBody: async () => PLAIN_BODY,
      fetchPrDiffFiles: async () => ["a.ts", "b.ts", "new.test.ts"],
      updatePrBody: async () => {
        updateCalls++;
      },
      runReview: async () => passing,
      push: () => {},
      issues: fakeIssues(),
      ledgerPath: tmpLedgerPath(),
      log: () => {},
      say: () => {},
      account: (r) => r,
    },
  });

  assert.equal(updateCalls, 0, "no changeset claim means nothing to update — updatePrBody must never be called");
  assert.equal(outcome.outcome, "fixed");
});

test("runFixRung (acceptance 3): a claim the rung cannot update confidently is left stale — updatePrBody is never called and the review still judges the ORIGINAL body", async () => {
  const failing = fakeReview("failure", [
    criterion({ claim: "criterion A is covered", met: false, reason: "proof unmet: report does not substantiate it (matched 4/12 proof keywords)" }),
  ]);
  // Inconsistent enumeration wrapping — not a style `deriveChangesetClaimUpdate` can copy forward.
  const AMBIGUOUS_BODY = 'This PR touches exactly 3 files: `a.ts`, "b.ts", c.ts.\n\nRemudero-Task: W1-T307X\n';

  let updateCalls = 0;
  const reviewReports: string[] = [];

  const outcome = await runFixRung({
    ...fixRungBaseOpts(),
    strikeCap: 1,
    initialReview: failing,
    deps: {
      spawn: async () => result({ sessionId: "fix-1" }),
      waitForCiGreen: async () => "green",
      fetchPrBody: async () => AMBIGUOUS_BODY,
      fetchPrDiffFiles: async () => ["a.ts", "b.ts", "c.ts", "new.test.ts"],
      updatePrBody: async () => {
        updateCalls++;
      },
      runReview: async (args) => {
        reviewReports.push(args.report);
        return failing; // still failing — the claim genuinely IS stale, just not confidently fixable
      },
      push: () => {},
      issues: fakeIssues(),
      ledgerPath: tmpLedgerPath(),
      log: () => {},
      say: () => {},
      account: (r) => r,
    },
  });

  assert.equal(updateCalls, 0, "an unconfident reconstruction must never be written — fail safe, not a wrong edit");
  assert.equal(reviewReports[0], AMBIGUOUS_BODY, "the review must judge the body exactly as fetched — no partial/guessed edit");
  assert.equal(outcome.outcome, "escalated", "left stale, the review keeps failing exactly as it did before this fix — a human is still needed for the SAME reason, not a new one");
});

// ── The `gh` LEAF ITSELF. Every test above injects `updatePrBody`, so `updatePrBodyViaGh` --
// the function that actually shells out -- never runs in any of them: the CLAUDE.md #977/#978
// shape, where a fully-faked seam leaves its default implementation unreachable and uncovered.
// This drives the REAL leaf against a recorder `gh` first on PATH, and asserts the argv it
// builds, because that argv is the whole contract (`gh pr edit <url> --body <body>`) -- a wrong
// flag here would silently rewrite the wrong field of a live PR.

test("updatePrBodyViaGh: shells the REAL `gh pr edit --body`, with the URL and body it was given", async () => {
  const binDir = mkdtempSync(join(tmpdir(), "fixrung-gh-bin-"));
  const recordPath = join(binDir, "argv.json");
  writeFileSync(
    join(binDir, "gh"),
    ["#!/usr/bin/env node", 'require("fs").writeFileSync(' + JSON.stringify(recordPath) + ", JSON.stringify(process.argv.slice(2)));", "process.exit(0);"].join("\n"),
  );
  chmodSync(join(binDir, "gh"), 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = `${binDir}:${originalPath ?? ""}`;
  try {
    await updatePrBodyViaGh("https://github.com/o/r/pull/1216", "the corrected body");
    const argv = JSON.parse(readFileSync(recordPath, "utf8")) as string[];
    assert.deepEqual(argv, ["pr", "edit", "https://github.com/o/r/pull/1216", "--body", "the corrected body"]);
  } finally {
    process.env.PATH = originalPath;
  }
});

test("updatePrBodyViaGh: a nonzero `gh` exit PROPAGATES rather than silently reporting success", async () => {
  const binDir = mkdtempSync(join(tmpdir(), "fixrung-gh-fail-"));
  writeFileSync(join(binDir, "gh"), ["#!/usr/bin/env node", 'process.stderr.write("could not update pull request");', "process.exit(1);"].join("\n"));
  chmodSync(join(binDir, "gh"), 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = `${binDir}:${originalPath ?? ""}`;
  try {
    // A swallowed failure here would leave a stale claim on the PR while the rung believed it had
    // corrected it -- the review would then fail on a body the rung reports as already fixed.
    await assert.rejects(() => updatePrBodyViaGh("https://github.com/o/r/pull/1216", "body"));
  } finally {
    process.env.PATH = originalPath;
  }
});

test("runFixRung: a FAILING body update is traced and the review still runs on the original body — the rung degrades, never crashes", async () => {
  const failing = fakeReview("failure", [
    criterion({ claim: "criterion A is covered", met: false, reason: "proof unmet: report does not substantiate it (matched 4/12 proof keywords)" }),
  ]);
  const STALE_BODY = "This PR touches exactly 2 files: a.ts, b.ts.\n\nRemudero-Task: W1-T307X\n";

  const steps: string[] = [];
  const reviewReports: string[] = [];

  const outcome = await runFixRung({
    ...fixRungBaseOpts(),
    strikeCap: 1,
    initialReview: failing,
    deps: {
      spawn: async () => result({ sessionId: "fix-1" }),
      waitForCiGreen: async () => "green",
      fetchPrBody: async () => STALE_BODY,
      fetchPrDiffFiles: async () => ["a.ts", "b.ts", "new.test.ts"],
      // `gh pr edit` can fail for reasons that have nothing to do with the claim (rate limit,
      // a revoked token, a PR closed underneath us). The correction is best-effort: losing it
      // must cost the ORIGINAL refusal, never the whole rung.
      updatePrBody: async () => {
        throw new Error("gh: could not update pull request");
      },
      runReview: async (args) => {
        reviewReports.push(args.report);
        return failing;
      },
      push: () => {},
      issues: fakeIssues(),
      ledgerPath: tmpLedgerPath(),
      log: (step) => steps.push(step),
      say: () => {},
      account: (r) => r,
    },
  });

  assert.ok(steps.includes("fix.body_claim_update_error"), "the failed update is TRACED, not swallowed into silence");
  assert.ok(!steps.includes("fix.body_claim_updated"), "a failed write must never be recorded as a successful correction");
  assert.equal(reviewReports[0], STALE_BODY, "the review judges the body exactly as fetched when the correction could not be written");
  assert.equal(outcome.outcome, "escalated", "the rung completes its ordinary refusal rather than throwing");
});

// ── the repairer must refuse a claim it can only see PART of ─────────────────────────
//
// `recognizeChangesetClaims`' own `countRe` (lib/review.ts) captures an enumeration as
// comma-separated tokens only. An author whose last item is joined with "and" therefore gets a
// claim that STOPS EARLY, and the splice in `deriveChangesetClaimUpdate` replaces only the span it
// was handed — leaving the orphan behind. MEASURED before this guard, against a 3-file diff:
//
//   in : "touches exactly two files: src/x.ts and src/y.ts."
//   out: "touches exactly 3 files: a.ts, b.ts, c.ts and src/y.ts."
//
// A body that now names FOUR paths while claiming three: a worse claim than the stale one it
// replaced, written automatically, on a PR whose author never asked for it. Every other refusal in
// this function guards against editing the WRONG text; this one guards against editing the right
// text INCOMPLETELY, which is the failure mode that turns a false-positive check into a
// false-positive edit.

const AND_STYLE_DIFF = ["a.ts", "b.ts", "c.ts"];

/** One ordinary fix-worker strike's own pushes. The BODY REPAIR contributes none — the two rung
 *  tests below assert this same number with the repair firing and refusing, which is what isolates
 *  the repair's contribution from the worker's. */
const PUSHES_PER_WORKER_STRIKE = 1;

test("an 'A and B' enumeration is REFUSED, not half-rewritten — the orphaned tail is why", () => {
  const body = "This PR touches exactly two files: src/x.ts and src/y.ts.";
  assert.equal(
    deriveChangesetClaimUpdate(body, AND_STYLE_DIFF),
    undefined,
    "the repairer cannot see the whole claim, so it must decline rather than splice",
  );
  // THE FALSIFIER FOR THIS GUARD: the pre-fix behaviour, spelled out. If the guard is removed, the
  // function returns this string — which both changes the count AND leaves `and src/y.ts` behind.
  // Asserting the absence of THIS EXACT output is what makes the test fail when the fix is reverted,
  // rather than merely passing because some other refusal happened to fire.
  const corrupted = "This PR touches exactly 3 files: a.ts, b.ts, c.ts and src/y.ts.";
  assert.notEqual(deriveChangesetClaimUpdate(body, AND_STYLE_DIFF), corrupted);
});

test("a comma list whose LAST item is joined with 'and' is refused too — the truncation is the same shape", () => {
  assert.equal(
    deriveChangesetClaimUpdate("touches exactly two files: src/x.ts, src/y.ts and src/z.ts.", AND_STYLE_DIFF),
    undefined,
  );
});

test("the guard does NOT over-refuse — comma-only lists, bare counts, and ordinary prose containing 'and' still repair exactly as before", () => {
  // CONTROLS. A guard that refused these would have closed the corruption by disabling the repair,
  // which is not a fix. Each of these three was repairable before the guard and must still be.
  assert.equal(
    deriveChangesetClaimUpdate("touches exactly two files: src/x.ts, src/y.ts.", AND_STYLE_DIFF),
    "touches exactly 3 files: a.ts, b.ts, c.ts.",
  );
  assert.equal(deriveChangesetClaimUpdate("touches exactly two files.", AND_STYLE_DIFF), "touches exactly 3 files.");
  // `and` present, but the token after it is not path-shaped — prose, not a continued enumeration.
  assert.equal(
    deriveChangesetClaimUpdate("touches exactly two files and 2 directories.", AND_STYLE_DIFF),
    "touches exactly 3 files and 2 directories.",
  );
  // A sentence boundary ends the clause: the `And` below begins new prose, not a list item.
  assert.equal(
    deriveChangesetClaimUpdate("touches exactly two files. And the rationale is elsewhere.", AND_STYLE_DIFF),
    "touches exactly 3 files. And the rationale is elsewhere.",
  );
});

test("runFixRung: a comma-style stale claim is REPAIRED in place — one body write, a fix.body_claim_updated row, and no commit", async () => {
  const failing = fakeReview("failure", [
    criterion({ claim: "criterion A is covered", met: false, reason: "proof unmet: report does not substantiate it (matched 4/12 proof keywords)" }),
  ]);
  const STALE_BODY = "This PR touches exactly 2 files: a.ts, b.ts.\n\nRemudero-Task: CHANGESET-REPAIR-A\n";

  const steps: string[] = [];
  const written: string[] = [];
  let pushes = 0;

  await runFixRung({
    ...fixRungBaseOpts(),
    strikeCap: 1,
    initialReview: failing,
    deps: {
      spawn: async () => result({ sessionId: "fix-1" }),
      waitForCiGreen: async () => "green",
      fetchPrBody: async () => STALE_BODY,
      fetchPrDiffFiles: async () => ["a.ts", "b.ts", "new.test.ts"],
      updatePrBody: async (_url: string, body: string) => {
        written.push(body);
      },
      runReview: async () => failing,
      push: () => {
        pushes += 1;
      },
      issues: fakeIssues(),
      ledgerPath: tmpLedgerPath(),
      log: (step) => steps.push(step),
      say: () => {},
      account: (r) => r,
    },
  });

  assert.equal(written.length, 1, "exactly one body write");
  assert.match(written[0], /exactly 3 files: a\.ts, b\.ts, new\.test\.ts/, "the count AND the enumeration are corrected");
  assert.ok(steps.includes("fix.body_claim_updated"), "the correction is recorded");
  // BODY-ONLY, MEASURED AS A DELTA RATHER THAN AN ABSOLUTE. This strike also runs an ordinary fix
  // WORKER, which legitimately commits — so a bare `pushes === 0` would be asserting something
  // false about the surrounding round, not something true about the repair. What the repair must
  // contribute is ZERO pushes, and the control for that is the refusal test below: identical rung,
  // identical worker, repair declines. Both record the same count, so the repair adds none.
  assert.equal(pushes, PUSHES_PER_WORKER_STRIKE, "the repair itself adds no push — see the refusal test's identical count");
});

test("runFixRung: an 'A and B' stale claim is REFUSED in place — no body write, no fix.body_claim_updated row, and the review judges the body as-fetched", async () => {
  const failing = fakeReview("failure", [
    criterion({ claim: "criterion A is covered", met: false, reason: "proof unmet: report does not substantiate it (matched 4/12 proof keywords)" }),
  ]);
  // #3217's shape: the last enumerated file is joined with "and", so the recognised claim stops at
  // `a.ts` and a splice would leave ` and b.ts` orphaned behind the rewritten count.
  const STALE_BODY = "This PR touches exactly 2 files: a.ts and b.ts.\n\nRemudero-Task: CHANGESET-REPAIR-B\n";

  const steps: string[] = [];
  const written: string[] = [];
  const reviewReports: string[] = [];
  let pushes = 0;

  await runFixRung({
    ...fixRungBaseOpts(),
    strikeCap: 1,
    initialReview: failing,
    deps: {
      spawn: async () => result({ sessionId: "fix-1" }),
      waitForCiGreen: async () => "green",
      fetchPrBody: async () => STALE_BODY,
      fetchPrDiffFiles: async () => ["a.ts", "b.ts", "new.test.ts"],
      updatePrBody: async (_url: string, body: string) => {
        written.push(body);
      },
      runReview: async (args) => {
        reviewReports.push(args.report);
        return failing;
      },
      push: () => {
        pushes += 1;
      },
      issues: fakeIssues(),
      ledgerPath: tmpLedgerPath(),
      log: (step) => steps.push(step),
      say: () => {},
      account: (r) => r,
    },
  });

  assert.deepEqual(written, [], "REFUSED: not one body write may happen on a claim the repairer cannot fully see");
  assert.ok(!steps.includes("fix.body_claim_updated"), "nothing may be recorded as a correction");
  assert.equal(reviewReports[0], STALE_BODY, "the review judges the body exactly as fetched — the stale claim is left for a human");
  // THE CONTROL THE REPAIR TEST'S PUSH ASSERTION LEANS ON: the repair declined here, and the push
  // count is unchanged. Same rung, same worker, one push either way ⇒ the body repair contributes
  // no commit. Neither test can establish that alone; the pair does.
  assert.equal(pushes, PUSHES_PER_WORKER_STRIKE, "an ordinary strike pushes exactly this many times, repair or no repair");
});
