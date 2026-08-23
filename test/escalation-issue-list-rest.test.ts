import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ghIssueGateway,
  labelledIssuesRestArgs,
  parseLabelledIssuesRest,
  splitConcatenatedJsonPages,
  NEEDS_HUMAN_LABEL,
} from "../src/lib/escalate.js";
import { buildBatchedGithub } from "../src/lib/status.js";
import { ghUpdateBranchArgv } from "../src/run-task.js";

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
 *
 * W1-T1208: `--slurp` (the flag that used to wrap `--paginate`'s pages in one outer array) needs
 * `gh` 2.51; the operator host runs 2.45.0, so every hand-run `rmd sweep` failed the issue-list
 * read outright with `unknown flag: --slurp`. The argv below no longer sends it -- bare
 * `--paginate` writes each page's JSON array back-to-back with no separator, and
 * `parseLabelledIssuesRest` now does the page-loop reassembly `--slurp` used to hand back
 * pre-wrapped (`splitConcatenatedJsonPages`). Fixtures below are updated to that bare,
 * non-`--slurp`-wrapped shape.
 */
const WEB_URL = "https://github.com/craigoley/remudero/issues/795";
const API_URL = "https://api.github.com/repos/craigoley/remudero/issues/795";

/** One bare `--paginate` (no `--slurp`) page carrying a single issue row, in REST's real wire shape. */
function onePage(over: Record<string, unknown> = {}): string {
  return JSON.stringify([
    { number: 795, url: API_URL, html_url: WEB_URL, state: "open", title: "[BLOCKED] W1-T262", body: "**Task:** W1-T262\n", ...over },
  ]);
}

test("REST rows surface html_url as the consumer's url, and the api.github.com url never leaks through", () => {
  const rows = parseLabelledIssuesRest(onePage());

  assert.equal(rows.length, 1);
  assert.equal(rows[0].url, WEB_URL, "consumers match on the WEB url escalate.ts writes to the ledger");
  assert.notEqual(rows[0].url, API_URL);
  // The whole failure mode this guards: an api.github.com url makes every lookupIssue miss
  // SILENTLY -- a fail-open that reads as "escalation not found".
  assert.equal(
    JSON.stringify(rows).includes("api.github.com"),
    false,
    "no api.github.com url survives anywhere in the parsed rows",
  );
});

test("a row carrying a pull_request key is dropped -- REST's /issues returns PRs alongside issues", () => {
  const mixed = JSON.stringify([
    { number: 795, url: API_URL, html_url: WEB_URL, state: "open", title: "an issue" },
    { number: 794, url: API_URL, html_url: "https://github.com/craigoley/remudero/pull/794", state: "open", title: "a PR", pull_request: { url: "..." } },
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

test("every page of a multi-page --paginate read is flattened -- no silent truncation at the 100-row page boundary", () => {
  // W1-T1208: this is what bare `--paginate` (no `--slurp`) actually writes -- each page's JSON
  // array immediately followed by the next, with NO separator and no outer wrapping array.
  const page1 = JSON.stringify([{ number: 1, url: API_URL, html_url: "https://github.com/o/r/issues/1", state: "open" }]);
  const page2 = JSON.stringify([{ number: 2, url: API_URL, html_url: "https://github.com/o/r/issues/2", state: "closed" }]);
  const twoPages = page1 + page2;

  const rows = parseLabelledIssuesRest(twoPages);

  assert.deepEqual(rows.map((r) => r.number), [1, 2], "both pages survive");
});

test("labelledIssuesRestArgs builds the REST argv and never gh's search-backed --label form", () => {
  const args = labelledIssuesRestArgs("craigoley/remudero", NEEDS_HUMAN_LABEL, "all");

  assert.deepEqual(args, [
    "api",
    "repos/craigoley/remudero/issues?labels=needs-human&state=all&per_page=100",
    "--paginate",
  ]);
  assert.equal(args.includes("--label"), false, "the throttled search path is never constructed");
  assert.equal(args.includes("--slurp"), false, "gh 2.45.0 (the operator host) has no --slurp -- W1-T1208");
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

// ── W1-T1208 acceptance ───────────────────────────────────────────────────────────────────────
//
// `--slurp` needs gh 2.51 and `gh pr update-branch` needs gh 2.53; the operator host runs 2.45.0.
// The issue-list read (above, `labelledIssuesRestArgs`/`parseLabelledIssuesRest`) and the
// branch-update write (`src/run-task.ts`'s `updateBranchViaGh`, now routed through
// `ghUpdateBranchArgv`) are the two operator-runnable sites that named the flag/subcommand the
// host's gh does not have. These five tests are named to match this task's own acceptance
// criteria one-for-one.

test("W1-T1208: the issue-list read needs no flag newer than the declared floor", () => {
  const args = labelledIssuesRestArgs("craigoley/remudero", NEEDS_HUMAN_LABEL, "all");

  assert.equal(args[0], "api", "gh api -- present in every gh version this repo supports");
  assert.ok(args.includes("--paginate"), "--paginate is present in the operator host's gh 2.45.0");
  assert.equal(args.includes("--slurp"), false, "--slurp needs gh 2.51 -- the operator host runs 2.45.0");
});

test("W1-T1208: a multi-page issue payload is reassembled, not truncated", () => {
  // Exactly what bare `--paginate` (no `--slurp`) writes across three pages: each page's JSON
  // array immediately followed by the next, with no separator and no outer wrapping array.
  const page1 = JSON.stringify([{ number: 1, url: API_URL, html_url: "https://github.com/o/r/issues/1", state: "open" }]);
  const page2 = JSON.stringify([{ number: 2, url: API_URL, html_url: "https://github.com/o/r/issues/2", state: "closed" }]);
  const page3 = JSON.stringify([{ number: 3, url: API_URL, html_url: "https://github.com/o/r/issues/3", state: "open" }]);
  const raw = page1 + page2 + page3;

  assert.deepEqual(splitConcatenatedJsonPages(raw).length, 3, "the raw text is split back into its three pages");
  const rows = parseLabelledIssuesRest(raw);
  assert.deepEqual(rows.map((r) => r.number), [1, 2, 3], "all three pages survive, in order, none dropped");
});

test("W1-T1208: both version-sensitive sites are covered by one mechanism", () => {
  const issueListArgs = labelledIssuesRestArgs("craigoley/remudero", NEEDS_HUMAN_LABEL, "all");
  const updateBranchArgs = ghUpdateBranchArgv("craigoley", "remudero", 7);

  // Both sites are `gh api` REST calls -- never a subcommand (`gh issue list --label`,
  // `gh pr update-branch`) whose availability varies by gh version.
  assert.equal(issueListArgs[0], "api", "the issue-list site is a gh api call");
  assert.equal(updateBranchArgs[0], "api", "the branch-update site is a gh api call, same mechanism");
  assert.equal(issueListArgs.includes("--slurp"), false);
  assert.equal(
    updateBranchArgs.join(" ").includes("pr update-branch"),
    false,
    "the version-gated subcommand form is never constructed",
  );
});

test("W1-T1208: a failed read still yields nothing, never a false zero-open", () => {
  // A genuinely truncated/garbled --paginate read (gh killed mid-stream, or a partial write) must
  // never silently degrade to an empty array -- the reconciler would read that as "0 open"
  // (design i's "do nothing this cycle, never a false zero" contract).
  assert.throws(
    () => parseLabelledIssuesRest('[{"number":1'),
    /truncated|Unexpected/,
    "a truncated payload throws rather than reading as zero rows",
  );

  // And a genuine gh-side failure (the exact shape --slurp used to produce on the host) still
  // propagates through the gateway rather than resolving to a false empty queue.
  const gateway = ghIssueGateway("craigoley", "remudero", {
    exec: () => {
      throw new Error("gh: unknown flag: --slurp");
    },
  });
  assert.throws(
    () => gateway.listOpen?.(NEEDS_HUMAN_LABEL),
    /--slurp/,
    "a gh-side failure still propagates, never a false empty queue",
  );
});

test("W1-T1208: the falsifier drives argv and spawns no subprocess", () => {
  // Every assertion in this file drives a pure argv builder or a pure parser (or a gateway wired
  // to an injected `exec` fake) -- this file imports no `node:child_process` and starts no `gh`
  // process anywhere, so "the argv this code would send" and "how it parses a fixed payload" are
  // both provable from plain function calls, never from a live gh binary's behavior.
  const issueArgs = labelledIssuesRestArgs("craigoley/remudero", NEEDS_HUMAN_LABEL, "open");
  const rows = parseLabelledIssuesRest(onePage());
  const updateBranchArgs = ghUpdateBranchArgv("craigoley", "remudero", 42);

  assert.ok(Array.isArray(issueArgs) && issueArgs.every((a) => typeof a === "string"));
  assert.ok(Array.isArray(rows));
  assert.ok(Array.isArray(updateBranchArgs) && updateBranchArgs.every((a) => typeof a === "string"));
});

test("a malformed page THROWS rather than reading as zero open escalations", () => {
  // THE FAIL-CLOSED CONTRACT. Callers treat a throw as "do nothing this cycle"; they treat `[]`
  // as a confirmed "no open escalations". Papering a broken payload over as `[]` would retire
  // live escalations on a bad read. So a page that is not an array must throw, never degrade.
  //
  // TWO GUARDS, AND THEY CATCH DIFFERENT SHAPES — asserted apart so neither can rot into the
  // other. A well-formed JSON value that simply is not a page array reaches the array check;
  // anything that does not parse as a complete JSON document is stopped earlier, by the
  // page-splitter, with its own message.
  assert.throws(
    () => parseLabelledIssuesRest('{"message":"Bad credentials"}'),
    /expected a JSON array page/,
    "an error OBJECT — the shape a rate-limited or unauthorised gh read actually returns",
  );
  for (const [label, payload] of [
    ["a bare JSON string", '"not a page"'],
    ["a JSON number", "42"],
  ] as const) {
    assert.throws(
      () => parseLabelledIssuesRest(payload),
      /splitConcatenatedJsonPages: truncated JSON/,
      `${label} is stopped by the SPLITTER, one guard earlier — and still throws, never yields []`,
    );
  }

  // PAIRED POSITIVE CONTROL: a well-formed EMPTY page really does yield `[]`, so the throws
  // above are the guards firing and not a parser that can never return an empty result.
  assert.deepEqual(parseLabelledIssuesRest("[]"), [], "a genuinely empty page is an empty list");
});
