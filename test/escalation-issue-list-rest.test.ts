import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ghIssueGateway,
  labelledIssuesRestArgs,
  parseLabelledIssuesRest,
  NEEDS_HUMAN_LABEL,
} from "../src/lib/escalate.js";
import { buildBatchedGithub } from "../src/lib/status.js";

/**
 * The escalation-lifecycle issue reads (the batched board gateway's `fetchAllIssues` and
 * `ghIssueGateway.listOpen`) moved off `gh issue list --label` onto REST's `/issues` endpoint.
 *
 * WHY: `gh` implements `--label` filtering over GitHub's GraphQL `search()` connection, which is
 * throttled account-wide here. Both reads failed 100% of the time -- `board_gateway.issue_fetch_ok`
 * never once appeared in the ledger against 505 failures, and the reconciler read "zero open" every
 * tick while 79 needs-human issues sat open, several naming PRs that had since merged.
 *
 * These tests pin the two translations that are easy to get silently wrong (html_url, and dropping
 * pull requests), the state-case coexistence, and the fail-closed contract on a genuine read error.
 */
const WEB_URL = "https://github.com/craigoley/remudero/issues/795";
const API_URL = "https://api.github.com/repos/craigoley/remudero/issues/795";

/** One page of `--slurp` output carrying a single issue row, in REST's real wire shape. */
function onePage(over: Record<string, unknown> = {}): string {
  return JSON.stringify([
    [{ number: 795, url: API_URL, html_url: WEB_URL, state: "open", title: "[BLOCKED] W1-T262", body: "**Task:** W1-T262\n", ...over }],
  ]);
}

test("REST rows surface html_url as the consumer's url, and the api.github.com url never leaks through", () => {
  const rows = parseLabelledIssuesRest(onePage());

  assert.equal(rows.length, 1);
  assert.equal(rows[0].url, WEB_URL, "consumers match on the WEB url escalate.ts writes to the ledger");
  assert.notEqual(rows[0].url, API_URL);
  // The whole failure mode this guards: an api.github.com url makes every lookupIssue miss
  // SILENTLY -- a fail-open that reads as "escalation not found" rather than as an outage.
  assert.equal(
    JSON.stringify(rows).includes("api.github.com"),
    false,
    "no api.github.com url survives anywhere in the parsed rows",
  );
});

test("a row carrying a pull_request key is dropped -- REST's /issues returns PRs alongside issues", () => {
  const mixed = JSON.stringify([
    [
      { number: 795, url: API_URL, html_url: WEB_URL, state: "open", title: "an issue" },
      { number: 794, url: API_URL, html_url: "https://github.com/craigoley/remudero/pull/794", state: "open", title: "a PR", pull_request: { url: "..." } },
    ],
  ]);

  const rows = parseLabelledIssuesRest(mixed);

  assert.equal(rows.length, 1, "the pull request is dropped, the issue is kept");
  assert.equal(rows[0].number, 795);
});

test("REST's lowercase open compares equal to the uppercase convention resolveEscalation already normalizes", () => {
  const rows = parseLabelledIssuesRest(onePage());

  assert.equal(rows[0].state, "open", "REST reports lowercase, unlike gh --json state's OPEN");
  // status.ts's resolveEscalation upper-cases before comparing, so both conventions coexist --
  // this asserts the normalization contract holds, not that the raw casing changed.
  assert.equal(rows[0].state.toUpperCase(), "OPEN");
  assert.equal(parseLabelledIssuesRest(onePage({ state: "closed" }))[0].state.toUpperCase(), "CLOSED");
});

test("every page of a multi-page slurp is flattened -- no silent truncation at the 100-row page boundary", () => {
  const twoPages = JSON.stringify([
    [{ number: 1, url: API_URL, html_url: "https://github.com/o/r/issues/1", state: "open" }],
    [{ number: 2, url: API_URL, html_url: "https://github.com/o/r/issues/2", state: "closed" }],
  ]);

  const rows = parseLabelledIssuesRest(twoPages);

  assert.deepEqual(rows.map((r) => r.number), [1, 2], "both pages survive");
});

test("labelledIssuesRestArgs builds the REST argv and never gh's search-backed --label form", () => {
  const args = labelledIssuesRestArgs("craigoley/remudero", NEEDS_HUMAN_LABEL, "all");

  assert.deepEqual(args, [
    "api",
    "repos/craigoley/remudero/issues?labels=needs-human&state=all&per_page=100",
    "--paginate",
    "--slurp",
  ]);
  assert.equal(args.includes("--label"), false, "the throttled search path is never constructed");
});

test("the batched board gateway resolves an escalation issue over REST, with issueReadFailed staying false", () => {
  const calls: string[][] = [];
  const github = buildBatchedGithub("craigoley", "remudero", {
    exec: (args) => {
      calls.push(args);
      if (args[0] === "api") return onePage();
      return "[]"; // the PR fetch, irrelevant here
    },
  });

  assert.deepEqual(github.issueByUrl?.(WEB_URL), { state: "open", title: "[BLOCKED] W1-T262" });
  assert.equal(github.issueReadFailed?.(), false, "a SUCCESSFUL REST read must not report a failure");
  assert.equal(
    calls.some((a) => a.includes("--label")),
    false,
    "the board gateway's issue index never touches the throttled --label path",
  );
});

test("a genuinely failing issue read still fails CLOSED -- issueReadFailed is true and no escalation reads as absent", () => {
  const github = buildBatchedGithub("craigoley", "remudero", {
    exec: (args) => {
      if (args[0] === "api") throw new Error("gh: HTTP 502");
      return "[]";
    },
  });

  assert.equal(github.issueByUrl?.(WEB_URL), null);
  assert.equal(github.issueReadFailed?.(), true, "an outage must never be read as a confirmed zero-issues");
});

test("ghIssueGateway.listOpen PROPAGATES a REST read failure rather than returning a false zero-open", () => {
  const gateway = ghIssueGateway("craigoley", "remudero", {
    exec: () => {
      throw new Error("gh: HTTP 502");
    },
  });

  assert.throws(() => gateway.listOpen?.(NEEDS_HUMAN_LABEL), /502/);
});
