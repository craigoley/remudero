import assert from "node:assert/strict";
import { test } from "node:test";

import { checkPrOwnership, ghPrHeadGateway } from "../src/run-task.js";

/*
 * W1-T1026 — AN UNREADABLE HEAD REF AND A FOREIGN ONE REACH THE SAME TERMINAL DISPOSITION.
 *
 * `test/run-task.test.ts` already covers `checkPrOwnership` against a hand-built
 * `PrHeadGateway` fixture (`fakeGateway`) — that suite is unaffected by this task, because the
 * defect is not in `checkPrOwnership`'s three-line compare, it is in what `ghPrHeadGateway`
 * hands it. THIS file is deliberately separate (never folded into `run-task.test.ts`, which
 * already invokes `checkPrOwnership` nine times): it is coverage-load-bearing under
 * `--experimental-test-coverage`, which crashes at FILE level and zeroes the whole file's
 * record — see this task's `note`.
 *
 * Every test below drives the REAL gateway, `ghPrHeadGateway`, with an injected `gh` reader of
 * the exact `(args: string[]) => unknown` shape `execFileSync`-backed `ghJson` has — never a
 * `PrHeadGateway` fixture that skips the fallback logic entirely. `gh` is keyed on `args[0]`:
 * `"pr"` is the GraphQL probe (`gh pr view … --json headRefName`), `"api"` is the REST fallback
 * (`singlePrRestArgs`, `GET /repos/<o>/<r>/pulls/<n>`).
 */

const OWN_URL = "https://github.com/acme/remudero/pull/91";
const OWN_BRANCH = "run-W1-T1026-1787237615993";
const FOREIGN_URL = "https://github.com/acme/remudero/pull/80";
const FOREIGN_BRANCH = "dependabot/npm_and_yarn/anthropic-ai/claude-agent-sdk-0.3.209";

/** A GraphQL-probe call: `["pr", "view", <url>, "--json", "headRefName"]`. */
function isGraphqlProbe(args: string[], url: string): boolean {
  return args[0] === "pr" && args[1] === "view" && args[2] === url && args.includes("headRefName");
}

/** A REST-fallback call: `["api", "repos/acme/remudero/pulls/<n>"]` (`singlePrRestArgs`). */
function isRestProbe(args: string[], prNumber: number): boolean {
  return args[0] === "api" && args[1] === `repos/acme/remudero/pulls/${prNumber}`;
}

test("W1-T1026: an unreadable head ref does not reach the foreign-branch disposition", () => {
  // ONE reader, driving BOTH PRs in the SAME invocation (design note (iv)): a test that only
  // proves the unreadable-own-branch case recovers would equally pass on code that stopped
  // refusing foreign branches altogether, which would re-open W1-T62. GraphQL is exhausted for
  // BOTH reads (mirrors the measured failure mode — the bucket, not one URL, is what exhausts);
  // REST — a separate quota — stays healthy and answers truthfully for both.
  const gh = (args: string[]): unknown => {
    if (isGraphqlProbe(args, OWN_URL) || isGraphqlProbe(args, FOREIGN_URL)) {
      throw new Error("GraphQL: API rate limit already exceeded for user ID 4397075");
    }
    if (isRestProbe(args, 91)) return { head: { ref: OWN_BRANCH } };
    if (isRestProbe(args, 80)) return { head: { ref: FOREIGN_BRANCH } };
    throw new Error(`unexpected gh call: ${JSON.stringify(args)}`);
  };
  const gateway = ghPrHeadGateway(gh);

  // The run's OWN branch: GraphQL exhausted, REST recovers it ⇒ credited, not attribution-failed.
  const own = checkPrOwnership(OWN_URL, OWN_BRANCH, gateway, 1.5);
  assert.equal(own, null, "GraphQL exhaustion on the run's own branch must not abandon the PR");

  // A genuinely FOREIGN branch, in the SAME run: GraphQL exhausted, REST reads it honestly, and
  // it still does not match ⇒ still fails closed. Proves recovery did not neuter the guard.
  const foreign = checkPrOwnership(FOREIGN_URL, OWN_BRANCH, gateway, 2.1);
  assert.ok(foreign, "a readable foreign branch must still produce a verdict");
  assert.equal(foreign.verdict, "pr_attribution_failed");
  assert.equal(foreign.ledger.claimed_branch, FOREIGN_BRANCH);
});

test("W1-T1026: a readable foreign branch still fails closed", () => {
  // GraphQL answers on the FIRST try — no exhaustion, no REST fallback in play at all — and the
  // branch it reports is genuinely not this run's own. Modeled on W1-T54b-1784151420811 (PR #80
  // was Dependabot's, not that run's). The guard must keep doing this real work (rationale (3)).
  const gh = (args: string[]): unknown => {
    if (isGraphqlProbe(args, FOREIGN_URL)) return { headRefName: FOREIGN_BRANCH };
    throw new Error(`unexpected gh call: ${JSON.stringify(args)}`);
  };
  const gateway = ghPrHeadGateway(gh);

  const v = checkPrOwnership(FOREIGN_URL, OWN_BRANCH, gateway, 2.1);
  assert.ok(v, "a branch mismatch must produce a verdict, never a silent pass");
  assert.equal(v.verdict, "pr_attribution_failed");
  assert.equal(v.ledger.claimed_branch, FOREIGN_BRANCH);
  assert.equal(v.ledger.owned_branch, OWN_BRANCH);
  // The MISMATCH reason, never the unresolved one — this branch read cleanly.
  assert.match(v.ledger.reason, /is not this run's own branch/);
  assert.doesNotMatch(v.ledger.reason, /could not be resolved/);
});

test("W1-T1026: the run's own branch is still recognised as owned", () => {
  // The baseline good path: GraphQL healthy, head ref equals this run's own branch. Unaffected
  // by the REST fallback — it must never even be consulted when the first read succeeds.
  const gh = (args: string[]): unknown => {
    if (isGraphqlProbe(args, OWN_URL)) return { headRefName: OWN_BRANCH };
    throw new Error(`unexpected gh call: ${JSON.stringify(args)} — REST must not be consulted on a clean read`);
  };
  const gateway = ghPrHeadGateway(gh);

  const v = checkPrOwnership(OWN_URL, OWN_BRANCH, gateway, 0.4);
  assert.equal(v, null, "a matching, cleanly-read head ref must proceed, never be refused");
});

test("W1-T1026: the unreadable path is driven by a throwing reader", () => {
  // Mirrors the LIVE transport's failure shape: `execFileSync`-backed `ghJson` THROWS on a `gh`
  // hiccup, it never returns a sentinel. Both the GraphQL probe and the REST fallback throw here
  // — the residual "both transports down" case design note (ii) names as still terminal — so the
  // gateway must still degrade to `undefined` and never to `null`/an assumed branch.
  const gh = (args: string[]): unknown => {
    if (isGraphqlProbe(args, OWN_URL)) {
      throw new Error("GraphQL: API rate limit already exceeded for user ID 4397075");
    }
    if (isRestProbe(args, 91)) {
      throw new Error("HttpError: 403 rate limit exceeded (REST core, same account)");
    }
    throw new Error(`unexpected gh call: ${JSON.stringify(args)}`);
  };
  const gateway = ghPrHeadGateway(gh);

  assert.equal(gateway.headRefName(OWN_URL), undefined, "a doubly-throwing reader must resolve to unreadable");

  const v = checkPrOwnership(OWN_URL, OWN_BRANCH, gateway, 0);
  assert.ok(v);
  assert.equal(v.verdict, "pr_attribution_failed");
  assert.equal(v.ledger.claimed_branch, null, "unreadable must ledger as null, never a guessed branch");
  assert.match(v.ledger.reason, /could not be resolved/i);
});
