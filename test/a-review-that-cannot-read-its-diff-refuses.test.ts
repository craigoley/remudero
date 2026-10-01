import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchPrDiff, isDiffTooLarge, type PrDiffSource } from "../src/lib/pr-diff.js";

/**
 * test/a-review-that-cannot-read-its-diff-refuses.test.ts — W1-T3093.
 *
 * `gh pr diff` is refused above 300 changed files, and the reviewer's only diff source was that
 * call. MEASURED 2026-09-07 on #4510 (930 shards): every review attempt threw `Command failed:
 * gh pr diff …` out of the run, so the PR was UNREVIEWABLE — not refused, not judged, nothing
 * posted and no ledger row to attribute it to.
 */

const TOO_LARGE =
  "Command failed: gh pr diff https://github.com/o/r/pull/4510\n" +
  "could not find pull request diff: HTTP 406: Sorry, the diff exceeded the maximum number of files (300).";

function source(over: Partial<PrDiffSource> = {}): PrDiffSource {
  return {
    api: () => "API DIFF",
    local: () => "LOCAL DIFF",
    ...over,
  };
}

test("the ordinary path is the API, and the local fallback is not reached", () => {
  const out = fetchPrDiff("u", "sha", source({ local: () => assert.fail("must not be called") }));
  assert.deepEqual(out, { kind: "ok", diff: "API DIFF", source: "api" });
});

test("a diff over the 300-file cap falls back locally rather than throwing", () => {
  const out = fetchPrDiff("u", "sha", source({ api: () => { throw new Error(TOO_LARGE); } }));
  assert.equal(out.kind, "ok");
  assert.deepEqual(out, { kind: "ok", diff: "LOCAL DIFF", source: "local" });
});

test("the fallback is passed the HEAD SHA, so it compares the PR and not the working tree", () => {
  let seen: string | undefined;
  fetchPrDiff("u", "deadbeef", source({
    api: () => { throw new Error(TOO_LARGE); },
    local: (sha) => { seen = sha; return "LOCAL DIFF"; },
  }));
  assert.equal(seen, "deadbeef");
});

test("ANY OTHER API failure is REFUSED, never answered from the local checkout", () => {
  // The safety property. An auth failure, a rate limit or a deleted PR has no locally-equivalent
  // answer, and a diff computed from whatever this checkout holds would be a fabricated review
  // input. Only the file cap has a real local equivalent.
  const out = fetchPrDiff("u", "sha", source({
    api: () => { throw new Error("HTTP 401: Bad credentials"); },
    local: () => assert.fail("a non-size failure must not reach the fallback"),
  }));
  assert.equal(out.kind, "refused");
  assert.match(String(out.kind === "refused" ? out.reason : ""), /Bad credentials/);
});

test("when BOTH fail the refusal names the cap and the two remedies — never a bare rethrow", () => {
  const out = fetchPrDiff("https://github.com/o/r/pull/4510", "sha", source({
    api: () => { throw new Error(TOO_LARGE); },
    local: () => { throw new Error("fatal: bad object sha"); },
  }));
  assert.equal(out.kind, "refused");
  const reason = out.kind === "refused" ? out.reason : "";
  assert.match(reason, /300-file cap/);
  assert.match(reason, /Split the pull request/);
  assert.match(reason, /fetch\s+its head into this checkout/);
  assert.match(reason, /bad object sha/, "the underlying failure survives into the message");
});

test("the cap is recognised by BOTH halves of GitHub's wording, not by the status code alone", () => {
  assert.equal(isDiffTooLarge(TOO_LARGE), true);
  assert.equal(isDiffTooLarge("HTTP 406: Not Acceptable"), false, "a 406 that is not the cap is not the cap");
  assert.equal(isDiffTooLarge("the diff exceeded the maximum number of files (300)"), false, "nor the words alone");
});
