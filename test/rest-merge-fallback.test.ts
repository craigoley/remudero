// W1-T1255 — the arm's direct-merge fallback ran on `gh pr merge --squash`, which is GraphQL: the
// SAME budget the arm had just been refused on. These tests pin the transport swap onto
// `PUT /repos/{owner}/{repo}/pulls/{n}/merge` (REST/core) and the ONE new trigger,
// `armFailureIsRateLimited` (W1-T1235, already live).
//
// THE THREE FALSIFIERS THIS FILE EXISTS FOR:
//   (1) a rate-limited arm on an already-clean PR takes the REST path and merges;
//   (2) a rate-limited arm on a PR that is NOT clean does not merge — GitHub refuses it;
//   (3) a non-rate-limit failure never reaches the fallback at all.
import assert from "node:assert/strict";
import test from "node:test";

import {
  attemptArm,
  ghMergePrArgv,
  ghUpdateBranchArgv,
  armFailureIsRateLimited,
  mergeTargetFromPrUrl,
} from "../src/run-task.js";

const PR = "https://github.com/craigoley/remudero/pull/2598";
const RATE_LIMIT = "GraphQL: API rate limit already exceeded for user ID 4397075.";
const CLEAN = "Pull request is in clean status";

function deps(over: Partial<Parameters<typeof attemptArm>[1]> = {}) {
  const said: string[] = [];
  const calls: string[] = [];
  const base = {
    armAuto: () => {
      calls.push("armAuto");
    },
    mergeDirect: () => {
      calls.push("mergeDirect");
    },
    say: (m: string) => {
      said.push(m);
    },
  };
  return { d: { ...base, ...over } as Parameters<typeof attemptArm>[1], said, calls };
}

const throwing = (msg: string) => () => {
  throw Object.assign(new Error("boom"), { stderr: msg });
};

// ── criterion 1: the fallback reaches the REST endpoint, not the GraphQL CLI ────────────────────
test("ghMergePrArgv builds the REST merge PUT with a squash method — not a `gh pr merge` subcommand", () => {
  const argv = ghMergePrArgv("craigoley", "remudero", 2598);
  assert.deepEqual(argv, [
    "api",
    "--method",
    "PUT",
    "repos/craigoley/remudero/pulls/2598/merge",
    "-f",
    "merge_method=squash",
  ]);
  // the GraphQL shape it replaces must be absent: no `pr`/`merge` subcommand, no `--squash` flag
  assert.equal(argv.includes("pr"), false, "a `gh pr ...` subcommand would be the GraphQL transport again");
  assert.equal(argv.includes("--squash"), false, "the CLI flag is replaced by the REST merge_method field");
  assert.equal(argv[0], "api", "`gh api` is what routes this onto the core budget");
});

test("ghMergePrArgv mirrors ghUpdateBranchArgv's mechanism — same gh api PUT shape, different endpoint", () => {
  const merge = ghMergePrArgv("o", "r", 7);
  const update = ghUpdateBranchArgv("o", "r", 7);
  assert.deepEqual(merge.slice(0, 3), update.slice(0, 3), "both are `gh api --method PUT`");
  assert.equal(merge[3], "repos/o/r/pulls/7/merge");
  assert.equal(update[3], "repos/o/r/pulls/7/update-branch");
});

// ── criterion 2 + falsifier (3): rate-limit is the ONLY new trigger ─────────────────────────────
test("a rate-limited arm on an already-green PR takes the fallback and merges (falsifier 1)", () => {
  const { d, said, calls } = deps({ armAuto: throwing(RATE_LIMIT) });
  const r = attemptArm(PR, d);
  assert.equal(r.outcome, "direct-merged");
  assert.deepEqual(calls, ["mergeDirect"], "the fallback ran");
  assert.ok(
    said.some((s) => s.includes("automerge.rate_limited_rest_merge (W1-T1255")),
    `expected the W1-T1255 row, got ${JSON.stringify(said)}`,
  );
});

test("a NON-rate-limit arm failure never reaches the fallback (falsifier 3)", () => {
  for (const msg of [
    "GraphQL: Something unrelated went wrong",
    "Base branch was modified",
    "ETIMEDOUT",
    "connect ECONNRESET",
  ]) {
    const { d, calls } = deps({ armAuto: throwing(msg) });
    const r = attemptArm(PR, d);
    assert.equal(r.outcome, "arm-error-ignored", `${msg} must not merge`);
    assert.deepEqual(calls, [], `${msg} must not reach mergeDirect — got ${JSON.stringify(calls)}`);
  }
});

test("armFailureIsRateLimited is the trigger this path consults — no second classifier is introduced", () => {
  assert.equal(armFailureIsRateLimited(RATE_LIMIT), true);
  assert.equal(armFailureIsRateLimited("ETIMEDOUT"), false, "a transport blip is not an exhausted bucket");
  assert.equal(armFailureIsRateLimited("Base branch was modified"), false);
});

// ── criterion 3 + falsifier (2): a PR that is not already green is not merged ───────────────────
test("a rate-limited arm on a PR GitHub refuses as unmergeable does NOT merge (falsifier 2)", () => {
  const { d, said, calls } = deps({
    armAuto: throwing(RATE_LIMIT),
    mergeDirect: throwing("HTTP 405: Pull Request is not mergeable"),
    isMerged: () => false,
  });
  const r = attemptArm(PR, d);
  assert.equal(r.outcome, "arm-error-ignored", "a refused REST merge must not report a merge");
  assert.notEqual(r.outcome, "direct-merged");
  assert.ok(said.some((s) => s.includes("rate_limited_rest_merge_refused")), "the refusal is named");
  assert.equal(calls.length, 0, "mergeDirect threw; nothing recorded a successful call");
});

// ── criterion 6: a rate-limited refusal still records the bucket and reset ──────────────────────
test("a rate-limited arm whose fallback is refused still records the bucket and reset", () => {
  const { d, said } = deps({
    armAuto: throwing(RATE_LIMIT),
    mergeDirect: throwing("HTTP 405: Pull Request is not mergeable"),
    isMerged: () => false,
  });
  const r = attemptArm(PR, d);
  assert.equal(r.outcome, "arm-error-ignored");
  assert.ok(r.rateLimit, "the W1-T1235 rate-limit reading rides the result");
  assert.ok(
    said.some((s) => s.includes("automerge.rate_limit_refused") && s.includes("bucket:") && s.includes("resets:")),
    `expected the bucket/reset row, got ${JSON.stringify(said)}`,
  );
});

// ── criterion 7: arming is still first, and the fallback never replaces it ──────────────────────
test("a PR that CAN arm still arms — the fallback never runs for it", () => {
  const { d, calls } = deps();
  const r = attemptArm(PR, d);
  assert.equal(r.outcome, "armed");
  assert.deepEqual(calls, ["armAuto"], "mergeDirect must not run when the arm succeeded");
});

test("the clean-status branch is preserved exactly — it still merges, and is not the rate-limit path", () => {
  const { d, said, calls } = deps({ armAuto: throwing(CLEAN) });
  const r = attemptArm(PR, d);
  assert.equal(r.outcome, "direct-merged");
  assert.deepEqual(calls, ["mergeDirect"]);
  assert.ok(
    said.some((s) => s.includes("automerge.clean_status_direct_merge")),
    "GitHub's own already-mergeable certification keeps its own row",
  );
  assert.equal(
    said.some((s) => s.includes("rate_limited_rest_merge")),
    false,
    "a clean-status refusal is not a quota refusal and must not be reported as one",
  );
});

// ── criterion 4: a refused verdict cannot merge by EITHER transport ─────────────────────────────
test("an operator hold refuses the arm before either transport is reached", () => {
  const { d, calls } = deps({
    ledgerLines: () => [
      { step: "automerge.hold_engaged", pr_number: 2598, by: "craig", reason: "held for review" },
    ],
  });
  const r = attemptArm(PR, d);
  assert.notEqual(r.outcome, "armed");
  assert.notEqual(r.outcome, "direct-merged");
  assert.deepEqual(calls, [], "neither armAuto nor mergeDirect may run under a hold");
});

// ── criterion 5: the live-write guard still gates the real dep ──────────────────────────────────
test("the real mergeDirect is guarded by the live-write boundary before it can touch a PR", async () => {
  const src = await import("node:fs").then((fs) =>
    fs.readFileSync(new URL("../src/run-task.ts", import.meta.url), "utf8"),
  );
  const i = src.indexOf("mergeDirect: (prUrl) => {");
  assert.ok(i > 0, "the real dep is still defined");
  const body = src.slice(i, i + 1400);
  assert.ok(
    body.indexOf('assertLiveWriteAllowed("gh-pr-merge"') < body.indexOf("execFileSync"),
    "the guard must fire BEFORE the write, not after it",
  );
  assert.ok(body.includes("ghMergePrArgv"), "the real dep uses the REST argv");
  assert.equal(body.includes('["pr", "merge", prUrl, "--squash"]'), false, "the GraphQL form is gone");
});

// ── the URL guard: mergeDirect must raise, never silently skip ──────────────────────────────────
test("mergeTargetFromPrUrl resolves the three REST path components from a real PR URL", () => {
  assert.deepEqual(mergeTargetFromPrUrl(PR), { owner: "craigoley", repo: "remudero", prNumber: 2598 });
});

test("mergeTargetFromPrUrl returns undefined for a URL it cannot read, so the caller throws rather than merging blind", () => {
  for (const bad of ["", "not a url", "https://example.com/craigoley/remudero/pull/1", "https://github.com/craigoley/remudero"]) {
    assert.equal(mergeTargetFromPrUrl(bad), undefined, `${bad} must not resolve to a merge target`);
  }
});

// ── the post-merge-step failure path: a merge that LANDED is never reported as a failure ────────
test("a rate-limited fallback whose post-merge step throws still reports the merge that landed", () => {
  const { d, said } = deps({
    armAuto: throwing(RATE_LIMIT),
    mergeDirect: throwing("merged, but a later step exploded"),
    isMerged: () => true,
  });
  const r = attemptArm(PR, d);
  assert.equal(r.outcome, "direct-merged", "GitHub says it merged — the verdict must say so too");
  assert.ok(
    said.some((s) => s.includes("merge landed; a post-merge step failed")),
    `expected the landed-merge row, got ${JSON.stringify(said)}`,
  );
});
