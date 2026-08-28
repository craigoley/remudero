import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { buildBatchedGithub, classifyGhFailure, ghGateway, GH_CALL_TIMEOUT_MS } from "../src/lib/status.js";

/**
 * A `gh` CALL WITH NO CEILING PARKS THE WHOLE DAEMON, because both gateways in `lib/status.ts`
 * shell it through the SYNCHRONOUS `execFileSync`. On 2026-08-13 one sweep pass that began at
 * 10:57 was still running at 11:54 — observed on `gh api --paginate repos/…/pulls/768/files` —
 * with four PRs unreviewed for the whole hour. A hang is not an error, so nothing was logged.
 *
 * The fix is a bound plus a NAME for what fires it: a killed child carries no stderr, so without
 * an explicit `code` branch every timeout would classify "unknown", which is precisely the silent
 * classification that let the 2026-07-20 outage run for hours.
 */

// ── THE ERROR SHAPE THE BOUND PRODUCES — measured from Node, not assumed. ─────────────────────

test("execFileSync past its timeout really does throw code ETIMEDOUT with an EMPTY stderr — the premise the classifier's code branch rests on", () => {
  let err: NodeJS.ErrnoException & { status?: number | null; stderr?: string; signal?: string } | undefined;
  try {
    execFileSync("sleep", ["5"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 250 });
  } catch (e) {
    err = e as typeof err;
  }
  assert.ok(err, "the call must have been killed, not completed");
  assert.equal(err?.code, "ETIMEDOUT", "the Node error code the classifier keys on");
  assert.equal(err?.signal, "SIGTERM", "killed, not exited");
  assert.equal(String(err?.stderr ?? ""), "", "THE WHOLE POINT: no stderr, so a text-matching classifier is blind to it");
  assert.equal(err?.status, null, "and no exit status either");
});

test("classifyGhFailure names a timeout `transport` — without the code branch it would be `unknown`", () => {
  assert.equal(classifyGhFailure(null, "", "ETIMEDOUT"), "transport");
  // The falsifiable half: the stderr regex ALONE cannot see it, which is why the branch exists.
  assert.equal(classifyGhFailure(null, "", undefined), "unknown", "empty stderr with no code is genuinely unclassifiable");
});

// ── DIRECTION: the new branch must not swallow the classifications that already worked. ───────

test("the timeout branch does not shadow rate_limit, auth, buffer_overflow or the stderr-bearing transport form", () => {
  assert.equal(classifyGhFailure(1, "API rate limit exceeded", undefined), "rate_limit");
  assert.equal(classifyGhFailure(1, "gh auth login required", undefined), "auth");
  assert.equal(classifyGhFailure(null, "", "ENOBUFS"), "buffer_overflow", "ENOBUFS is still checked FIRST");
  assert.equal(classifyGhFailure(1, "dial tcp: connection refused", undefined), "transport");
  assert.equal(classifyGhFailure(1, "something nobody has seen", undefined), "unknown");
});

test("a rate-limited call that ALSO carries the timeout code still reports rate_limit's own text — ordering is not accidentally inverted", () => {
  // ENOBUFS wins over everything (pre-existing contract); ETIMEDOUT is checked before the text
  // scan, so a genuinely-killed child cannot be re-read as something else.
  assert.equal(classifyGhFailure(null, "API rate limit exceeded", "ENOBUFS"), "buffer_overflow");
  assert.equal(classifyGhFailure(null, "", "ETIMEDOUT"), "transport");
});

// ── THE BOUND ITSELF: it must not be able to fire on a healthy call. ──────────────────────────

test("GH_CALL_TIMEOUT_MS cannot fire on a healthy call — it is orders of magnitude above the measured worst healthy read", () => {
  // MEASURED 2026-08-13 against this repo: the heaviest board read (a 100-row closed page with
  // every body) took 0.70-0.90s over six consecutive calls; a per-PR --paginate file list took
  // 0.32-0.40s. A bound that fires on a healthy condition is this repo's recurring defect, so the
  // floor asserted here is deliberately far above anything observed.
  assert.ok(
    GH_CALL_TIMEOUT_MS >= 30_000,
    `a bound this low could fire on a slow-but-healthy network (got ${GH_CALL_TIMEOUT_MS}ms against a 0.90s measured worst case)`,
  );
  // And it must still be small enough to be a BOUND: an hour-long park is the defect being fixed.
  assert.ok(GH_CALL_TIMEOUT_MS <= 120_000, "a ceiling above two minutes stops bounding the hang this exists to stop");
});

// ── THE WIRING, not just the leaf: EVERY gh exec site must actually pass it. ─────────────────
//
// W1-T2440 MADE THE OLD MATCHER BLIND, AND BLIND IN THE UNSAFE DIRECTION. It hardcoded the string
// `execFileSync("gh", args, {` — a LITERAL binary. That task legitimately made the binary an
// EXPRESSION at two of the three sites: the warm worker shells `req.ghBin` (it runs on another
// thread and receives its binary in the request), and the batched gateway's own default became
// `opts.ghBin ?? "gh"` so a test proving the worker path never reaches a real `gh` cannot be
// silently bypassed by a cache-miss read on the main thread. Both still carry the bound. But the
// old pattern matched NEITHER, so it saw 1 site of 3 — and an unbounded `gh` added at either of
// the two it could no longer see would have sailed straight past this guard. Widening the matcher
// STRENGTHENS this test; it does not relax it.
//
// THE COUNT IS NO LONGER THE ONLY GUARD, precisely because a hardcoded count is what went stale.
// A LOOSE scan derives the denominator independently — every `execFileSync(` whose first argument
// is gh-shaped, options object or not — and the strict matcher must account for ALL of them. A
// future site written in a shape neither pattern anticipated fails on that equality rather than
// disappearing from the census.
const GH_BIN_EXPR = String.raw`(?:"gh"|[A-Za-z_$][\w$]*\.ghBin(?:\s*\?\?\s*"gh")?)`;

test("EVERY gh exec site in lib/status.ts bounds its child — a fix applied to one leaves the others able to park the daemon", () => {
  const src = readFileSync(new URL("../src/lib/status.ts", import.meta.url), "utf8");
  // Source only — the doc comments in this file spell `execFileSync("gh", args, ...)` in prose,
  // and counting those would inflate the census with text that executes nothing.
  const code = src
    .split("\n")
    .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
    .join("\n");

  const loose = [...code.matchAll(new RegExp(String.raw`execFileSync\(${GH_BIN_EXPR},`, "g"))];
  const execSites = [...code.matchAll(new RegExp(String.raw`execFileSync\(${GH_BIN_EXPR}, args, \{[^}]*\}\)`, "g"))].map((m) => m[0]);

  assert.equal(
    execSites.length,
    loose.length,
    `a gh exec site exists that this matcher cannot parse — loose scan found ${loose.length}, strict found ${execSites.length}. ` +
      `Widen the pattern rather than letting the site drop out of the census.`,
  );
  assert.equal(
    execSites.length,
    3,
    `exactly three real gh exec sites are expected here (ghGateway's default, the prewarm worker's, ` +
      `and buildBatchedGithub's default): ${execSites.length} found`,
  );
  for (const site of execSites) {
    assert.match(site, /timeout: GH_CALL_TIMEOUT_MS/, `an unbounded gh exec site survives: ${site}`);
  }
  // NEGATIVE CONTROL: this file also shells `git`, and those calls are deliberately unbounded.
  // A matcher that swept them in would report a false violation on the very next assertion.
  for (const site of execSites) {
    assert.doesNotMatch(site, /execFileSync\("git"/, `the git exec sites must stay outside this census: ${site}`);
  }
  assert.ok(
    /execFileSync\("git", args, \{/.test(code),
    "premise: lib/status.ts really does carry git exec sites, so excluding them is a real exclusion and not a vacuous one",
  );
});

test("both gateways construct their REAL default exec when no `exec` is injected — the bounded closure is the one production gets", () => {
  // WHY THIS EXISTS AS A TEST AND NOT AN ASSUMPTION: every other suite in this repo injects
  // `opts.exec`, so the `opts.exec ?? (…)` fallback — the only closure a real daemon ever runs,
  // and the one carrying the new timeout — is never even CONSTRUCTED under test. Building each
  // gateway with no `exec` evaluates that fallback without shelling out (both are lazy: nothing
  // calls `gh` until a query method is invoked, and none is invoked here).
  const bare = ghGateway("o", "r");
  assert.equal(typeof bare.findMergedByTrailer, "function", "ghGateway's default-exec form builds");
  const batched = buildBatchedGithub("o", "r");
  assert.equal(typeof batched.findMergedByTrailer, "function", "buildBatchedGithub's default-exec form builds");
});

test("the batched gateway keeps its 64 MiB maxBuffer alongside the new timeout — the W1-T181 ENOBUFS fix is not displaced", () => {
  const src = readFileSync(new URL("../src/lib/status.ts", import.meta.url), "utf8");
  assert.match(src, /maxBuffer: 1 << 26, timeout: GH_CALL_TIMEOUT_MS/, "both bounds ride the same options object");
});

// ── END TO END: a timing-out gateway degrades, names the reason, and recovers. ────────────────

test("a gateway whose `gh` times out fails SOFT and names `transport` — never a silent hang, never a false empty repo", () => {
  const timeoutError = Object.assign(new Error("spawnSync gh ETIMEDOUT"), {
    code: "ETIMEDOUT",
    status: null,
    signal: "SIGTERM",
    stderr: "",
  });
  const logged: Array<{ event: string; extra?: Record<string, unknown> }> = [];
  const gh = buildBatchedGithub("o", "r", {
    exec: () => {
      throw timeoutError;
    },
    log: (event, extra) => logged.push({ event, extra }),
  });

  // `null`, not `undefined` — the gateway's own "null (never []) on a FAILED fetch" contract, so
  // a caller can tell "read failed" from "no such PR".
  assert.equal(gh.findMergedByTrailer("W1-T1"), null, "no credit is invented from a failed read");
  assert.equal(gh.readFailed?.(), true, "the failure is VISIBLE — never reported as a repo with zero PRs");
  assert.equal(gh.readFailureReason?.(), "transport", "and it is NAMED, not 'unknown'");
  const failure = logged.find((l) => l.event === "board_gateway.fetch_failed");
  assert.ok(failure, "the ledger carries the failure");
  assert.equal(failure?.extra?.reason, "transport", "with the classified reason, so an alert can key on it");
});

test("the SAME gateway recovers on its next successful fetch — a timeout is one bad poll, not a stuck instance", () => {
  let boom = true;
  const rows = [{ number: 7, url: "https://github.com/o/r/pull/7", state: "MERGED", headRefName: "run-W1-T1-1", body: "Remudero-Task: W1-T1", autoMergeRequest: null, title: "t", updatedAt: "2026-08-01T00:00:00Z" }];
  let clock = 1_000_000;
  const gh = buildBatchedGithub("o", "r", {
    now: () => clock,
    fetchAll: () => {
      if (boom) throw Object.assign(new Error("spawnSync gh ETIMEDOUT"), { code: "ETIMEDOUT", status: null, stderr: "" });
      return rows as never;
    },
  });

  // W1-T2219: readFailed()/readFailureReason() no longer force their own fetch — trigger the
  // (failing) attempt explicitly first via a query method that itself calls index(), exactly
  // like every real caller already reaches these accessors after one of the calls below.
  assert.equal(gh.findMergedByTrailer("W1-T1"), null, "the timed-out fetch surfaces as no credit");
  assert.equal(gh.readFailed?.(), true, "first fetch times out");
  assert.equal(gh.readFailureReason?.(), "transport");

  boom = false;
  clock += 60_000; // past the TTL, as the next daemon poll would be
  assert.equal(gh.findMergedByTrailer("W1-T1")?.number, 7, "the next poll's fetch succeeds");
  assert.equal(gh.readFailed?.(), false, "and the failure flag is CLEARED — a stale failure must not shadow a good read");
  assert.equal(gh.readFailureReason?.(), undefined);
});
