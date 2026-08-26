/**
 * W1-T523: `ghGateway`'s `gh pr view`/`gh pr list` reads move to REST (`gh api …`), reusing
 * `prStateFromRest` (`src/lib/open-prs-rest.ts`, NOT edited by this task) rather than a second
 * decoder. `statusCheckRollup` stays on GraphQL — it is a `CheckRun`/`StatusContext` union with no
 * single REST field, and it does not live on `ghGateway` at all (it is read in `src/run-task.ts`,
 * e.g. `pollToGate`), so this file's job is a TRANSPORT falsifier, counted both directions (design
 * (vi)): the converted reads must issue ZERO `pr view`/`pr list` invocations, and an UNCONVERTED
 * rollup-bearing read elsewhere in the tree must still be issued over GraphQL. Getting either
 * direction wrong is a silent regression: converting the rollup has no REST answer to fall back
 * on, and leaving a converted read on `gh pr view` reopens the exact budget this task closes.
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Task } from "../src/lib/plan.js";
import { deriveStatus, ghGateway } from "../src/lib/status.js";
import { pollToGate } from "../src/run-task.js";

function task(over: Partial<Task> = {}): Task {
  return {
    id: "W1-TX",
    title: "t",
    repo: "remudero",
    depends_on: [],
    type: "implement",
    risk: "medium",
    verify: "auto",
    status: "queued",
    attempts: 0,
    ...over,
  };
}

function emptyLedger(): string {
  const dir = mkdtempSync(join(tmpdir(), "status-rest-transport-"));
  const p = join(dir, "ledger.ndjson");
  writeFileSync(p, "");
  return p;
}

// ── acceptance 1: the state read goes over REST and still distinguishes MERGED from CLOSED ────

test("W1-T523: a merged pull request still reads MERGED over the REST transport", () => {
  // MEASURED shape (design (ii)): PR 1862 reads `MERGED` over GraphQL and `closed` + `merged:
  // true` over REST — a naive `state.toUpperCase()` would read this row as `CLOSED`.
  const calls: string[][] = [];
  const github = ghGateway("craigoley", "remudero", {
    exec: (args) => {
      calls.push(args);
      return JSON.stringify({
        number: 1862,
        html_url: "https://github.com/craigoley/remudero/pull/1862",
        state: "closed",
        merged: true,
        merged_at: "2026-01-01T00:00:00Z",
        title: "shipped it",
      });
    },
  });

  const pr = github.prByRef(1862);
  assert.equal(pr?.state, "MERGED", "closed+merged:true must fold to the single MERGED token, never CLOSED");
  assert.equal(pr?.number, 1862);
  assert.deepEqual(calls, [["api", "repos/craigoley/remudero/pulls/1862"]], "a REST single-PR read, not `gh pr view`");

  // A genuinely CLOSED-unmerged row must NOT read MERGED — the other half of the same fold.
  const closedCalls: string[][] = [];
  const closedGithub = ghGateway("craigoley", "remudero", {
    exec: (args) => {
      closedCalls.push(args);
      return JSON.stringify({ number: 1863, html_url: "u/1863", state: "closed", merged: false, merged_at: null });
    },
  });
  assert.equal(closedGithub.prByRef(1863)?.state, "CLOSED");
});

// ── acceptance 2: an indeterminate read stays indeterminate, never a terminal "unknown" ────────

test("W1-T523: a failed read stays indeterminate and never reads as unknown", () => {
  // Same shape as the pre-existing W1-T119 regression this design note (iv) explicitly protects:
  // `LiveStateResult`'s `ok: false` (and this gateway's own `readFailed()`) means the read never
  // happened, which is NOT the same fact as `state: "UNKNOWN"` (terminalStateReason treats any
  // non-"OPEN" token, including a literal "UNKNOWN", as terminal — collapsing the two would make
  // `rmd fix` refuse a live PR it was simply unable to read).
  const rateLimitError = Object.assign(new Error("Command failed: gh api"), {
    status: 1,
    stderr: "gh: API rate limit exceeded for user ID 123456. (HTTP 403)",
  });
  const github = ghGateway("craigoley", "remudero", {
    exec: () => {
      throw rateLimitError;
    },
  });

  // The gateway's own read-failure signal, never a fabricated terminal state.
  assert.equal(github.prByRef(5), null, "a failed read resolves null, never a state:UNKNOWN row");
  assert.equal(github.readFailed?.(), true);
  assert.equal(github.readFailureReason?.(), "rate_limit");

  // And the same failure, seen through deriveStatus end-to-end: indeterminate, not none/unknown.
  const proj = deriveStatus(task({ pr: 5 }), { ledgerPath: emptyLedger(), github });
  assert.equal(proj.indeterminate, true);
  assert.equal(proj.unavailableReason, "rate_limit");
  assert.equal(proj.merged, false);
  assert.notEqual(proj.source, "none", "a throttled read must never collapse to the ordinary-absence shape");
});

// ── acceptance 3 (SUPERSEDED by W1-T2268): the rollup read now HAS a REST form ──────────────────

test("W1-T2268: pollToGate's rollup read now goes over REST too, not `gh pr view`", async () => {
  // `statusCheckRollup` is a `CheckRun`/`StatusContext` union with no SINGLE REST field
  // (design (i)/rationale (3) of W1-T523, which this task does not dispute), but it DOES have a
  // composed REST form across two endpoints — `rollupFromRest`/`rollupFor` (`open-prs-rest.ts`),
  // built for the sweep and reused here. `pollToGate` was W1-T523's own named negative control
  // ("the one read this task does NOT convert"); W1-T2268 converts exactly it, closing the last
  // GraphQL read in the run path. This replaces that stale pin: `pollToGate` now issues ONLY
  // `gh api` reads, never `pr view`.
  const calls: string[][] = [];
  const outcome = await pollToGate("https://github.com/craigoley/remudero/pull/1862", () => {}, 6, {
    readJson: async (args) => {
      calls.push(args);
      if (args[1] === "repos/craigoley/remudero/pulls/1862") {
        return { number: 1862, state: "closed", merged: true, merged_at: "2026-01-01T00:00:00Z", head: { sha: "abc" } };
      }
      return {};
    },
  });

  assert.equal(outcome.merged, true);
  assert.deepEqual(
    calls,
    [["api", "repos/craigoley/remudero/pulls/1862"]],
    "a merged PR resolves off the single-PR REST read alone — no rollup fetch, no `gh pr view`",
  );
});

// ── acceptance 4: a gateway pass issues NO pr view/pr list for the converted reads ─────────────

test("W1-T523: the converted reads issue no pr view or pr list", () => {
  const calls: string[][] = [];
  const github = ghGateway("craigoley", "remudero", {
    exec: (args) => {
      calls.push(args);
      const arg1 = typeof args[1] === "string" ? args[1] : "";
      if (args[0] === "api" && arg1.startsWith("search/issues?q=")) {
        return JSON.stringify({
          items: [{ number: 9, html_url: "u/9", state: "closed", pull_request: { merged_at: "2026-01-01T00:00:00Z" } }],
        });
      }
      if (args[0] === "api" && /^repos\/[^/]+\/[^/]+\/issues\/\d+$/.test(arg1)) {
        return JSON.stringify({ state: "open", title: "an issue" });
      }
      if (args[0] === "api" && /^repos\/[^/]+\/[^/]+\/pulls\/\d+$/.test(arg1)) {
        return JSON.stringify({
          number: 9,
          html_url: "u/9",
          state: "closed",
          merged: true,
          head: { ref: "run-W1-TX-1" },
          body: "b",
          title: "t",
          auto_merge: {},
        });
      }
      if (args.includes("--paginate")) return "src/lib/x.ts\n";
      return "[]"; // the paginated open/closed pulls-list pages
    },
  });

  // Every method this task converts, driven end to end — the SAME projections as before (design
  // (vi)), asserted via the falsifier's OTHER half: not one `pr`/`list`/`view` invocation.
  github.prByRef(9);
  github.prByRef("https://github.com/craigoley/remudero/pull/9");
  github.findMergedByTrailer("W1-TX");
  github.findMergedByTrailerAll?.("W1-TX");
  github.findMergedByHeadBranch?.("W1-TX");
  github.listMergedHeadBranches?.();
  github.listOpenHeadBranches?.();
  github.headRefName("https://github.com/craigoley/remudero/pull/9");
  github.prBody("https://github.com/craigoley/remudero/pull/9");
  github.changedFiles?.("https://github.com/craigoley/remudero/pull/9");
  github.autoMergeArmed?.("https://github.com/craigoley/remudero/pull/9");
  github.issueByUrl?.("https://github.com/craigoley/remudero/issues/9");

  assert.ok(calls.length > 0, "the fixture was actually reached");
  assert.ok(calls.every((c) => c[0] === "api"), `every converted call must be REST (\`gh api\`): saw ${JSON.stringify(calls)}`);
  assert.ok(
    calls.every((c) => !c.includes("view") && !c.includes("list")),
    `no argv may carry a \`pr view\`/\`pr list\`/\`issue view\` verb: saw ${JSON.stringify(calls)}`,
  );
});
