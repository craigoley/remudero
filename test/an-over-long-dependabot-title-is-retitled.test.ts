import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { checkCommitMessage, CONVENTIONAL_LIMITS } from "../src/lib/commit-message.js";
import { clockFromMillisFn } from "../src/lib/clock.js";
import { fitDependabotTitle, overallSemverLevel, parseDependabotBumpFacts, type NodePinSyncIo } from "../src/lib/dep-review.js";
import { defaultDepReviewPrMutations, depReviewCommand, type DepReviewDeps } from "../src/run-task.js";
import { ghShim } from "./helpers/gh-shim.js";

// #11968's title as Dependabot wrote it (and restored it on 2026-10-16T16:44:30Z), 162 characters.
const PR11968_TITLE = "chore(deps): bump google/osv-scanner-action/.github/workflows/osv-scanner-reusable.yml from 2.6.0 to 2.7.0 " +
  "in the actions-minor-and-patch group across 1 directory";
const PR11968_BODY = [
  "Bumps the actions-minor-and-patch group with 1 update in the / directory: " +
    "[google/osv-scanner-action/.github/workflows/osv-scanner-reusable.yml](https://github.com/google/osv-scanner-action).",
  "",
  "Updates `google/osv-scanner-action/.github/workflows/osv-scanner-reusable.yml` from 2.6.0 to 2.7.0",
  "- [Release notes](https://github.com/google/osv-scanner-action/releases)",
].join("\n");
const LONG_NAME = `@scope/${"a".repeat(80)}`;
const UNFITTABLE_TITLE = `chore(deps): bump ${LONG_NAME} from 1.2.3 to 1.2.4 in /`;

test("W1-T9828: an over-long Dependabot title is fitted keeping its dependency and versions", () => {
  assert.equal(PR11968_TITLE.length, 162, "the recorded fixture is the real over-long title");
  const fit = fitDependabotTitle(PR11968_TITLE, PR11968_BODY);
  assert.equal(fit.kind, "fitted");
  const title = (fit as { title: string }).title;
  assert.equal(title, "chore(deps): bump google/osv-scanner-action/…/osv-scanner-reusable.yml from 2.6.0 to 2.7.0");
  assert.ok(title.length <= CONVENTIONAL_LIMITS.headerMaxLength);
  assert.ok(title.startsWith("chore(deps): "), "the type(scope) is kept byte-for-byte");
  assert.deepEqual(checkCommitMessage(title), [], "the fitted title passes every checked commitlint rule");

  // A directory clause outlives the group clauses and is dropped only when nothing else fits.
  const dir = `ci(deps): bump actions/checkout from 4.1.1 to 4.2.0 in /deploy in the ${"g".repeat(40)} group across 2 directories`;
  assert.deepEqual(fitDependabotTitle(dir, ""), { kind: "fitted", title: "ci(deps): bump actions/checkout from 4.1.1 to 4.2.0 in /deploy" });
  const grouped = `chore(deps): bump the ${"g".repeat(45)} group in /deploy across 2 directories with 3 updates`;
  assert.deepEqual(fitDependabotTitle(grouped, ""), { kind: "fitted", title: `chore(deps): bump the ${"g".repeat(45)} group in /deploy with 3 updates` });
  assert.deepEqual(fitDependabotTitle("chore(deps): bump actions/checkout from 4.1.1 to 4.2.0", ""), { kind: "fits" });
});

test("W1-T9828: a fitted Dependabot title parses to the same bump facts as the original", () => {
  const fit = fitDependabotTitle(PR11968_TITLE, PR11968_BODY);
  assert.equal(fit.kind, "fitted");
  const title = (fit as { title: string }).title;
  const original = parseDependabotBumpFacts(PR11968_TITLE, PR11968_BODY);
  assert.equal(original.length, 1);
  assert.deepEqual(parseDependabotBumpFacts(title, PR11968_BODY), original, "the elided title fact folds into the body fact");
  assert.equal(original[0].dependency, "google/osv-scanner-action/.github/workflows/osv-scanner-reusable.yml");
  assert.equal(overallSemverLevel(title, PR11968_BODY), overallSemverLevel(PR11968_TITLE, PR11968_BODY));
  assert.equal(overallSemverLevel(title, PR11968_BODY), "minor");
  // With no body fact to fold into, the elided name would be a second identity, so the fit is refused.
  assert.equal(fitDependabotTitle(PR11968_TITLE, "").kind, "unfittable");
  // An elided name never folds into a dependency whose ends differ.
  assert.equal(parseDependabotBumpFacts("chore(deps): bump google/osv-scanner-action/…/other.yml from 2.6.0 to 2.7.0", PR11968_BODY).length, 2);
});

test("W1-T9828: an unfittable Dependabot title is refused, never truncated", async (t) => {
  const fit = fitDependabotTitle(UNFITTABLE_TITLE, "");
  assert.equal(fit.kind, "unfittable");
  assert.match((fit as { reason: string }).reason, /exceed 100 characters/);
  assert.deepEqual(fitDependabotTitle("chore(deps): something else entirely ".repeat(4), ""),
    { kind: "unfittable", reason: "the title is not Dependabot's bump grammar" });

  const f = fixture(t, UNFITTABLE_TITLE);
  await f.run();
  await f.run();
  assert.deepEqual(f.retitles, [], "an unfittable title is never written");
  const refused = f.ledger().filter((r) => r.step === "dep-review.retitle_refused");
  assert.equal(refused.length, 1, "refused once per head and title");
  assert.equal(refused[0].old_title, UNFITTABLE_TITLE);
  assert.equal(f.ledger().filter((r) => r.step === "dep-review.decided").length, 2, "the existing hold still runs");
  assert.equal(f.ledger().some((r) => String(r.step).startsWith("dep-review.own_red")), false, "a title red files no own-red build");
  assert.equal(f.captures, 0);
});

test("W1-T9828: dep-review retitles an over-long Dependabot PR and ledgers both titles", async (t) => {
  const f = fixture(t, PR11968_TITLE, PR11968_BODY);
  assert.equal(await f.run(), 1, "the retitle pass holds");
  const fitted = "chore(deps): bump google/osv-scanner-action/…/osv-scanner-reusable.yml from 2.6.0 to 2.7.0";
  assert.deepEqual(f.retitles, [{ url: "https://github.com/craigoley/remudero/pull/11968", title: fitted }]);
  const rows = f.ledger().filter((r) => r.step === "dep-review.retitled");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].pr_number, 11968);
  assert.equal(rows[0].head_sha, "f".repeat(40));
  assert.equal(rows[0].old_title, PR11968_TITLE);
  assert.equal(rows[0].new_title, fitted);
  assert.equal(f.ledger().some((r) => r.step === "dep-review.decided"), false, "the retitle returns before any verdict");
  assert.deepEqual(f.statuses, [], "no review is posted");
  assert.equal(f.captures, 0, "no own-red proposal");

  await f.run();
  assert.equal(f.retitles.length, 1, "a fitting title is not written");
  assert.equal(f.ledger().some((r) => r.step === "dep-review.decided"), true, "the fitted head is judged as usual");
});

test("W1-T9828: a failed title write is ledgered with its candidate and holds", async (t) => {
  const f = fixture(t, PR11968_TITLE, PR11968_BODY, () => { throw new Error("HTTP 502"); });
  assert.equal(await f.run(), 1);
  const failed = f.ledger().filter((r) => r.step === "dep-review.retitle_failed");
  assert.equal(failed.length, 1);
  assert.equal(failed[0].error, "HTTP 502");
  assert.match(String(failed[0].candidate), /^chore\(deps\): bump google\/osv-scanner-action\/…\//);
  assert.equal(f.ledger().some((r) => r.step === "dep-review.decided"), false);
});

test("W1-T9828: the default title write is a REST PATCH of the pull request", async () => {
  const shim = ghShim([], { kind: "dep-review-retitle" });
  const oldPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${oldPath}`;
  try {
    await defaultDepReviewPrMutations("craigoley", "remudero").retitle!("https://github.com/craigoley/remudero/pull/11968", "chore(deps): bump x from 1.0.0 to 1.0.1");
  } finally {
    process.env.PATH = oldPath;
  }
  assert.deepEqual(shim.calls(), ["api -X PATCH repos/craigoley/remudero/pulls/11968 -f title=chore(deps): bump x from 1.0.0 to 1.0.1"]);
});

function fixture(t: { after(fn: () => void): void }, title: string, body = "", write?: () => void) {
  const root = mkdtempSync(join(tmpdir(), "rmd-dep-retitle-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ledgerPath = join(root, "state", "ledger.ndjson");
  const view = { title };
  const retitles: Array<{ url: string; title: string }> = [];
  const statuses: string[] = [];
  let captures = 0;
  const nodePin: NodePinSyncIo = { readAtHead: () => undefined, commitAndPush: () => "c".repeat(40) };
  const deps: DepReviewDeps = {
    config: { root, ledger: ledgerPath } as never,
    clock: clockFromMillisFn(() => 1_000),
    gh: () => ({
      number: 11968, url: "https://github.com/craigoley/remudero/pull/11968", title: view.title, body,
      headRefOid: "f".repeat(40), headRefName: "dependabot/github_actions/actions-minor-and-patch-0123",
      author: { login: "app/dependabot" },
      statusCheckRollup: [{ name: "commitlint", conclusion: "FAILURE" }, { name: "ci-gate", conclusion: "FAILURE" }],
    }),
    prDiff: () => "diff --git a/.github/workflows/scan.yml b/.github/workflows/scan.yml\n",
    postStatus: (async (args) => { statuses.push(args.state); return { posted: true }; }) as DepReviewDeps["postStatus"],
    arm: () => "armed",
    nodePin,
    prMutations: {
      comment: () => undefined, close: () => undefined,
      retitle: async (url, next) => { write?.(); retitles.push({ url, title: next }); view.title = next; },
    },
    captureMigrationFeedback: (args) => { captures += 1; return { id: args.id } as never; },
  };
  return {
    retitles, statuses,
    get captures() { return captures; },
    run: () => depReviewCommand("11968", ["--repo", "remudero", "--dependabot-own-red", "main-passes"], { ...deps }),
    ledger: () => readFileSync(ledgerPath, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}
