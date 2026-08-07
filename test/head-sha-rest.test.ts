import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { headShaRestArgs, prUrlTarget, readHeadShaRest, realArmDeps } from "../src/run-task.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

// ── The post-review head-sha read, migrated off GraphQL ──────────────────────────────────────
//
// WHAT THESE TESTS ASSERT, and what they deliberately do not. The defect is not "a function
// returned the wrong value" — it is WHICH REQUEST the production path builds, because the failure
// only appears once GraphQL's point budget is exhausted. A test that stubs `gh` and checks the
// return proves the stub was called and nothing about the transport. So the assertions below are
// on the ARGV itself, and on the two refusals that must never degrade into a GraphQL retry or an
// empty head.

test("headShaRestArgs builds the REST single-PR argv from a PR URL — never a gh --json argv", () => {
  const args = headShaRestArgs("https://github.com/craigoley/remudero/pull/1436");
  assert.deepEqual(args, ["api", "repos/craigoley/remudero/pulls/1436"]);
  // The whole point: no `--json`, which is what routes a read onto the GraphQL budget.
  assert.equal(
    args.some((a) => a === "--json" || a === "pr" || a === "view"),
    false,
    "the migrated read must not build a `gh pr view --json` argv under any circumstance",
  );
});

test("prUrlTarget yields owner, repo and number, and is anchored so a branch named pull/7 is not mistaken for a PR", () => {
  assert.deepEqual(prUrlTarget("https://github.com/craigoley/remudero/pull/1436"), {
    owner: "craigoley",
    repo: "remudero",
    number: 1436,
  });
  // trailing path/query/fragment tolerated, same shape reviewPrNumber accepts
  assert.equal(prUrlTarget("https://github.com/o/r/pull/12/files")?.number, 12);
  // a bare branch name yields nothing rather than a guess
  assert.equal(prUrlTarget("pull/7"), undefined);
  assert.equal(prUrlTarget("run-W1-T379-1786028670354"), undefined);
});

test("FALSIFIER: an unresolvable URL RAISES and the message names the refusal — it never reaches for the GraphQL argv", () => {
  let raised: Error | undefined;
  try {
    headShaRestArgs("not-a-pr-url");
  } catch (e) {
    raised = e as Error;
  }
  assert.ok(raised, "an unresolvable reference must raise, never silently fall back");
  // The defect being fixed is a SILENT fallback, so assert the message rules it out explicitly
  // rather than merely that something threw.
  assert.match(raised!.message, /refusing to fall back/);
  assert.equal(
    /pr view/.test(raised!.message) && !/refusing to fall back/.test(raised!.message),
    false,
    "the failure must not be a GraphQL retry dressed as an error",
  );
});

test("readHeadShaRest reads the sha through mapRestPr's own head.sha mapping", () => {
  const calls: string[][] = [];
  const sha = readHeadShaRest("https://github.com/craigoley/remudero/pull/1436", (args) => {
    calls.push(args);
    return { number: 1436, html_url: "u", updated_at: "t", head: { ref: "b", sha: "be7ce9fa" } };
  });
  assert.equal(sha, "be7ce9fa");
  assert.deepEqual(calls, [["api", "repos/craigoley/remudero/pulls/1436"]]);
});

test("FALSIFIER: a response carrying no head.sha RAISES rather than returning the empty string mapRestPr produces", () => {
  // mapRestPr maps headRefOid from `row.head?.sha ?? ""`. Returning that would make the caller
  // judge and POST a verdict against an empty head — strictly worse than the rate-limit failure.
  assert.throws(
    () =>
      readHeadShaRest("https://github.com/craigoley/remudero/pull/1436", () => ({
        number: 1436,
        html_url: "u",
        updated_at: "t",
      })),
    /no head sha/,
  );
});

test("the PRODUCTION default is wired to the REST path — realArmDeps().headSha, no seam injected", () => {
  // Drives the real `realArmDeps()` object rather than a fake, so this fails if the dep is ever
  // re-pointed at a gh --json read. It cannot assert a successful fetch without a network, so it
  // asserts the refusal that only the REST path can produce.
  assert.throws(() => realArmDeps().headSha("not-a-pr-url"), /refusing to fall back/);
});

test("no bare `gh pr view --json headRefOid` read survives in run-task.ts", () => {
  // The substitution target, asserted absent at source level: both migrated sites used this exact
  // argv fragment. The remaining headRefOid reads request additional fields and are out of scope
  // (headRefOid,commits — the authorship check; the statusCheckRollup bundle, which has no single
  // REST analogue; and reviewViewArgs' branch-name arm, which REST cannot address at all).
  const src = readFileSync(join(REPO_ROOT, "src", "run-task.ts"), "utf8");
  assert.equal(src.includes('"--json", "headRefOid"]'), false);
});
