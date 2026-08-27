/**
 * test/trailer-surface-union.test.ts — W1-T2387.
 *
 * THE TRAILER IS WRITTEN TO THE COMMIT AND READ FROM THE BODY. `appendTaskTrailerToCommit` amends
 * every worker's tip commit automatically and idempotently — no author touches it — while the PR
 * body line is hand-written and `renderBody` emits it only when a caller passes `taskId`. The
 * credit reader, `findMergedByTrailer`, searched BODIES only, so a build whose author never wrote
 * the body line shipped uncredited and was re-dispatched. Measured over 2,389 merged PRs joined to
 * their squash commits: trailer in BOTH 419, COMMIT ONLY 16, BODY ONLY 423, neither 1,531 — and
 * nine of the sixteen were credited nowhere at all.
 *
 * A UNION, NOT A COMPARISON. Body first, always; the commit surface is consulted only when the
 * body surface SUCCEEDED and answered empty. So it can only ADD credit, and every answer the body
 * already gave is unchanged. A FAILED body read still reports as a failure (W1-T119) rather than
 * being papered over with local evidence.
 *
 * THE HAZARD, PINNED. `appendTaskTrailerToCommit` is called at two sites and the second passes a
 * RUN ID (W1-T1012, the Architect path), so the commit corpus really does contain
 * `Remudero-Task: RETRO-…` / `TRIAGE-fb-…` / `PR-2641` lines. {@link TASK_ID_TRAILER_RE} is what
 * keeps those out of the index, and the run-id tests below are what keep it honest.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  TASK_ID_TRAILER_RE,
  buildBatchedGithub,
  buildCommitTrailerIndex,
  ghGateway,
  projectPlan,
  type BatchedPr,
} from "../src/lib/status.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Plan } from "../src/lib/plan.js";

/** One `git log --format=%H%x00%s%x00%b%x1e` record, exactly as the real reader parses it. */
function commit(sha: string, subject: string, body: string): string {
  return `${sha}\x00${subject}\x00${body}\x1e`;
}

/**
 * A fake `git` that answers BOTH calls the reader makes: `config --get remote.origin.url` (the
 * slug guard — a local commit surface is evidence about the LOCAL repo and no other) and `log`.
 * Defaults to an origin matching `o/r`, the slug every gateway fixture below is built for.
 */
function fakeGit(dump: string, originUrl = "git@github.com:o/r.git"): (args: string[]) => string {
  return (args: string[]) => {
    if (args[0] === "config") return `${originUrl}\n`;
    if (args[0] === "log") return dump;
    throw new Error(`unexpected git call: ${args.join(" ")}`);
  };
}

function pr(over: Partial<BatchedPr> & Pick<BatchedPr, "number">): BatchedPr {
  return { url: `https://github.com/o/r/pull/${over.number}`, state: "MERGED", ...over };
}

// ── the index itself ──────────────────────────────────────────────────────────────────────────

test("W1-T2387: the commit index credits a task-id trailer and joins it to the PR its subject names", () => {
  const index = buildCommitTrailerIndex({
    slug: "o/r",
    exec: fakeGit(
      commit("aaa", "fix(x): something (#3000)", "body\n\nRemudero-Task: W1-T2323\n")
    ),
  })();
  assert.deepEqual(index?.get("W1-T2323"), [
    { number: 3000, url: "https://github.com/o/r/pull/3000", state: "merged" },
  ]);
});

test("W1-T2387: a RUN-ID-shaped trailer is indexed as nothing — the Architect path writes those (W1-T1012)", () => {
  const index = buildCommitTrailerIndex({
    slug: "o/r",
    exec: fakeGit(
      commit("a", "chore(retro): rules (#1)", "Remudero-Task: RETRO-1787193680272\n") +
      commit("b", "chore(triage): fb (#2)", "Remudero-Task: TRIAGE-fb-1784732520769-c1a4a0\n") +
      commit("c", "fix(y): thing (#3)", "Remudero-Task: PR-2641\n") +
      commit("d", "fix(z): real (#4)", "Remudero-Task: W1-T42\n")
    ),
  })();
  assert.deepEqual([...index!.keys()], ["W1-T42"], "only the task-id-shaped token is indexed at all");
  assert.equal(index!.get("RETRO-1787193680272"), undefined);
  assert.equal(index!.get("TRIAGE-fb-1784732520769-c1a4a0"), undefined);
  assert.equal(index!.get("PR-2641"), undefined);
});

test("W1-T2387: the grammar accepts every live plan id shape and rejects every run-id shape", () => {
  for (const id of ["W1-T1", "W1-T2387", "W1-T1000002", "W1-T123a", "W1-T123B"]) {
    assert.equal(TASK_ID_TRAILER_RE.test(id), true, `${id} is a real plan id shape`);
  }
  for (const id of ["RETRO-1787193680272", "TRIAGE-fb-1784732520769-c1a4a0", "PR-2641", "P19", "W1-T2324-1787823430981", "DAEMON-1787840000000"]) {
    assert.equal(TASK_ID_TRAILER_RE.test(id), false, `${id} is not a task id`);
  }
});

test("W1-T2387: a commit naming no PR in its subject is skipped rather than guessed at", () => {
  const index = buildCommitTrailerIndex({
    slug: "o/r",
    exec: fakeGit(
      commit("a", "fix(x): pushed straight to main", "Remudero-Task: W1-T99\n")
    ),
  })();
  assert.equal(index?.get("W1-T99"), undefined, "without a (#N) suffix there is no PrRef to return");
});

test("W1-T2387: a failed git read is null, never an empty index — the failure/absence distinction", () => {
  const index = buildCommitTrailerIndex({
    slug: "o/r",
    exec: (args: string[]) => {
      if (args[0] === "config") return "git@github.com:o/r.git\n";
      throw new Error("not a git repository");
    },
  })();
  assert.equal(index, null);
});

test("W1-T2387: a checkout whose origin is a DIFFERENT repo yields no local evidence at all", () => {
  // THE DEFECT THIS PINS SHIPPED ONCE IN THIS TASK'S OWN FIRST DRAFT and was caught by running
  // every caller in full: a gateway built for one repo was answered with the local checkout's
  // history. A commit surface is evidence about the LOCAL repo and about no other.
  const index = buildCommitTrailerIndex({
    slug: "acme/other",
    exec: fakeGit(commit("aaa", "fix(x): thing (#3000)", "Remudero-Task: W1-T2323\n")),
  })();
  assert.deepEqual([...index!.keys()], [], "an empty index, not a hit from the wrong repository");
  assert.notEqual(index, null, "and an ABSENCE of local evidence, never a failed read (W1-T119)");
});

test("W1-T2387: a checkout with no `origin` at all yields an empty index, never a crash and never a hit", () => {
  // The OTHER catch arm: `git config --get remote.origin.url` exits non-zero when no such remote
  // exists (a bare clone, a detached scratch tree). That is an absence of local evidence, exactly
  // like a foreign origin — never a failed read, and never a fall-through to the log.
  let loggedAnyway = false;
  const index = buildCommitTrailerIndex({
    slug: "o/r",
    exec: (args: string[]) => {
      if (args[0] === "config") throw Object.assign(new Error("no such remote"), { status: 1 });
      loggedAnyway = true;
      return commit("aaa", "fix(x): thing (#3000)", "Remudero-Task: W1-T2323\n");
    },
  })();
  assert.deepEqual([...index!.keys()], []);
  assert.equal(loggedAnyway, false, "the log is never even reached once the slug cannot be established");
});

// ── the union, on the gateway resolveAlreadySatisfied actually builds ─────────────────────────

test("W1-T2387: a merged PR carrying the trailer ONLY in its commit now credits its task", () => {
  const gh = buildBatchedGithub("o", "r", {
    fetchAll: () => [pr({ number: 3000, body: "no trailer here at all" })],
    commitTrailerIndex: buildCommitTrailerIndex({
      slug: "o/r",
      exec: fakeGit(
      commit("aaa", "fix(gateway): thing (#3000)", "Remudero-Task: W1-T2323\n")
    ),
    }),
  });
  assert.deepEqual(gh.findMergedByTrailer("W1-T2323"), {
    number: 3000,
    url: "https://github.com/o/r/pull/3000",
    state: "merged",
  });
});

test("W1-T2387: a merged PR carrying the trailer ONLY in its body still credits it, from the body, unchanged", () => {
  let gitCalls = 0;
  const gh = buildBatchedGithub("o", "r", {
    fetchAll: () => [pr({ number: 2602, body: "text\n\nRemudero-Task: W1-T500\n" })],
    commitTrailerIndex: () => {
      gitCalls++;
      return new Map();
    },
  });
  const hit = gh.findMergedByTrailer("W1-T500");
  assert.equal(hit?.number, 2602);
  assert.equal(gitCalls, 0, "NO NEW FETCH: the commit surface is never consulted when the body answers");
});

test("W1-T2387: with the trailer on BOTH surfaces the body still answers, so today's answers do not move", () => {
  const gh = buildBatchedGithub("o", "r", {
    fetchAll: () => [pr({ number: 419, body: "Remudero-Task: W1-T7\n" })],
    commitTrailerIndex: buildCommitTrailerIndex({
      slug: "o/r",
      exec: fakeGit(
      commit("aaa", "fix(x): thing (#9999)", "Remudero-Task: W1-T7\n")
    ),
    }),
  });
  assert.equal(gh.findMergedByTrailer("W1-T7")?.number, 419, "the body surface is consulted first and wins");
});

test("W1-T2387: a FAILED body read still reports a failure — local evidence never papers over an outage", () => {
  const gh = buildBatchedGithub("o", "r", {
    exec: () => {
      throw Object.assign(new Error("boom"), { status: 1, stderr: "gh: API rate limit exceeded" });
    },
    commitTrailerIndex: buildCommitTrailerIndex({
      slug: "o/r",
      exec: fakeGit(
      commit("aaa", "fix(x): thing (#3000)", "Remudero-Task: W1-T2323\n")
    ),
    }),
  });
  assert.equal(gh.findMergedByTrailer("W1-T2323"), null, "an outage must keep reading as an outage (W1-T119)");
  assert.equal(gh.readFailed?.(), true);
});

test("W1-T2387: findMergedByTrailerAll takes the same union, in the same order", () => {
  const gh = buildBatchedGithub("o", "r", {
    fetchAll: () => [pr({ number: 3000, body: "nothing" })],
    commitTrailerIndex: buildCommitTrailerIndex({
      slug: "o/r",
      exec: fakeGit(
      commit("a", "fix(x): one (#2998)", "Remudero-Task: W1-T2323\n") +
        commit("b", "fix(x): two (#3000)", "Remudero-Task: W1-T2323\n")
    ),
    }),
  });
  assert.deepEqual(gh.findMergedByTrailerAll?.("W1-T2323")?.map((p) => p.number), [2998, 3000]);
});

test("W1-T2387: the commit index is built at most ONCE per gateway, however many tasks miss", () => {
  let gitCalls = 0;
  const gh = buildBatchedGithub("o", "r", {
    fetchAll: () => [pr({ number: 1, body: "nothing" })],
    commitTrailerIndex: () => {
      gitCalls++;
      return new Map();
    },
  });
  for (const id of ["W1-T1", "W1-T2", "W1-T3", "W1-T4"]) gh.findMergedByTrailer(id);
  assert.equal(gitCalls, 1, "memoized — never one `git log` per task, the O(N)-subprocess shape W1-T187 removed");
});

// ── the same union on the per-call gateway ────────────────────────────────────────────────────

test("W1-T2387: ghGateway takes the union too, and a successful-but-empty search is what opens it", () => {
  const gh = ghGateway("o", "r", {
    exec: () => JSON.stringify({ items: [] }),
    commitTrailerIndex: buildCommitTrailerIndex({
      slug: "o/r",
      exec: fakeGit(
      commit("aaa", "fix(x): thing (#2999)", "Remudero-Task: W1-T2324\n")
    ),
    }),
  });
  assert.equal(gh.findMergedByTrailer("W1-T2324")?.number, 2999);
});

test("W1-T2387: nothing added paces, throttles or sleeps a call", () => {
  const src = new URL("../src/lib/status.ts", import.meta.url);
  const text = readFileSync(src, "utf8");
  const from = text.indexOf("export function buildCommitTrailerIndex(");
  const region = text.slice(from, text.indexOf("\n}", from));
  for (const banned of ["setTimeout", "setInterval", "sleep", "Atomics.wait", "execSync(\"sleep"]) {
    assert.equal(region.includes(banned), false, `${banned} must not appear on this path (W1-T1066)`);
  }
});


// ── THE RE-VERIFY, END TO END — the half a gateway-level test cannot see ─────────────────────
//
// W1-T2387's union widened the SEARCH (`findMergedByTrailer` falls back to the commit index) and,
// until this, not the RE-VERIFY: `creditsByAnchoredTrailer`'s first line demanded an anchored
// trailer in the PR BODY, so rung (c) discarded the very candidate the union had just produced.
// MEASURED on the real #3005/W1-T2326 case through `projectPlan`: `merged=false` with the union
// both ON and OFF, while `findMergedByTrailer("W1-T2326")` returned #3005 either way.
//
// The gateway test above stays and proves a different thing — that the SEARCH finds it. These
// prove the projection CREDITS it.

const emptyLedger = (): string => {
  const p = join(mkdtempSync(join(tmpdir(), "t2387-e2e-")), "ledger.ndjson");
  writeFileSync(p, "");
  return p;
};
const onePlan = (id: string): Plan => ({ tasks: [{ id, title: id, repo: "r", type: "implement", depends_on: [], status: "queued" }] }) as unknown as Plan;

/** #3005's real shape: merged, trailer in the COMMIT only, body naming the task in prose alone. */
const COMMIT_ONLY_ROW = pr({
  number: 3005,
  headRefName: "fix/triage-files-under-the-reserved-id",
  body: "Builds W1-T2326. No trailer here at all.",
});
const COMMIT_ONLY_GIT = () =>
  buildCommitTrailerIndex({
    slug: "o/r",
    exec: fakeGit(commit("aaa", "fix(triage): prompt the worker with the id the lane reserved (#3005)", "Remudero-Task: W1-T2326\n")),
  });

test("W1-T2387 END TO END: a commit-only trailer now CREDITS through deriveStatus, not merely through the gateway", () => {
  const gh = buildBatchedGithub("o", "r", { fetchAll: () => [COMMIT_ONLY_ROW], commitTrailerIndex: COMMIT_ONLY_GIT() });
  const p = projectPlan(onePlan("W1-T2326"), { ledgerPath: emptyLedger(), github: gh }).get("W1-T2326")!;
  assert.equal(p.merged, true, "the projection credits it — the re-verify accepts the second anchored surface");
  assert.equal(p.source, "trailer");
  assert.equal(p.prNumber, 3005);
});

test("W1-T2387 FALSIFIER: with the commit index EMPTY the same row is NOT credited — the credit really comes from that surface", () => {
  const gh = buildBatchedGithub("o", "r", { fetchAll: () => [COMMIT_ONLY_ROW], commitTrailerIndex: () => new Map() });
  const p = projectPlan(onePlan("W1-T2326"), { ledgerPath: emptyLedger(), github: gh }).get("W1-T2326")!;
  assert.equal(p.merged, false, "no commit evidence, no anchored body trailer, no credit");
});

test("W1-T2387 + W1-T2392 COMPOSE: a build the union credits stops warning as an uncredited build", () => {
  // W1-T2392's warning fires only when every credit surface came back empty. The union adds a
  // reading to one of them, so a build it now credits must go silent — asserted in one place
  // because the two are only correct together.
  const gh = buildBatchedGithub("o", "r", { fetchAll: () => [COMMIT_ONLY_ROW], commitTrailerIndex: COMMIT_ONLY_GIT() });
  const p = projectPlan(onePlan("W1-T2326"), { ledgerPath: emptyLedger(), github: gh }).get("W1-T2326")!;
  assert.equal(p.merged, true, "credited");
  assert.equal(p.uncreditedBuild, undefined, "and therefore NOT reported as an uncredited build");
});

// ── every W1-T20c property, re-asserted against the WIDENED guard ────────────────────────────
//
// The commit trailer is a SECOND ANCHORED SURFACE, not a relaxation: it is extracted as its own
// exact `^Remudero-Task: <id>$` line and held to the same run-id grammar (measured: 174 of 743
// commit trailer tokens rejected). Every veto below still applies to a commit-credited candidate.

test("W1-T20c PRESERVED: a prefix-sharing id is not credited by a longer id's commit trailer", () => {
  const gh = buildBatchedGithub("o", "r", {
    fetchAll: () => [pr({ number: 3000, headRefName: "run-W1-T23230-1", body: "no trailer" })],
    commitTrailerIndex: buildCommitTrailerIndex({ slug: "o/r", exec: fakeGit(commit("a", "fix(x): y (#3000)", "Remudero-Task: W1-T23230\n")) }),
  });
  const p = projectPlan(onePlan("W1-T2323"), { ledgerPath: emptyLedger(), github: gh }).get("W1-T2323")!;
  assert.equal(p.merged, false, "W1-T2323 must not inherit W1-T23230's commit trailer");
});

test("W1-T20c PRESERVED: a head branch claiming ANOTHER task still vetoes a commit-credited candidate", () => {
  const gh = buildBatchedGithub("o", "r", {
    fetchAll: () => [pr({ number: 3006, headRefName: "run-W1-T9999-1787000000000", body: "no trailer" })],
    commitTrailerIndex: buildCommitTrailerIndex({ slug: "o/r", exec: fakeGit(commit("a", "fix(x): y (#3006)", "Remudero-Task: W1-T2326\n")) }),
  });
  const p = projectPlan(onePlan("W1-T2326"), { ledgerPath: emptyLedger(), github: gh }).get("W1-T2326")!;
  assert.equal(p.merged, false, "the branch-name veto is untouched by the widening");
});

/**
 * THE NON-MERGED ARM IS UNREACHABLE FROM THIS SURFACE, AND THAT IS A PROPERTY RATHER THAN A GAP.
 * `buildCommitTrailerIndex` reads `git log origin/main`, so a commit it indexes is ON MAIN and the
 * work IS merged — the index therefore reports `state: "merged"` for every hit. A fixture that
 * declared such a row OPEN would be asserting a state the surface cannot produce. What must stay
 * true is that the non-merged arm's ownership requirement is untouched for candidates that DO
 * reach it, i.e. body-surface hits, which is what this asserts.
 */
test("W1-T20c PRESERVED: a NON-merged body-trailer hit still needs its own run branch", () => {
  const gh = buildBatchedGithub("o", "r", {
    fetchAll: () => [pr({ number: 3007, state: "OPEN", headRefName: "fix/someone-elses-branch", body: "x\n\nRemudero-Task: W1-T2326\n" })],
    commitTrailerIndex: () => new Map(),
  });
  const p = projectPlan(onePlan("W1-T2326"), { ledgerPath: emptyLedger(), github: gh }).get("W1-T2326")!;
  assert.equal(p.merged, false, "ownership is still required on the non-merged arm, and the widening did not touch it");
});

test("W1-T20c PRESERVED: an UNREADABLE head still fails CLOSED for a commit-credited merged candidate", () => {
  // W1-T119: an absent head ref is a read that FAILED, never a branch carrying no claim. The
  // widening supplies a second way to satisfy the trailer check and changes nothing here.
  const gh = buildBatchedGithub("o", "r", {
    fetchAll: () => [pr({ number: 3009, headRefName: undefined, body: "no trailer" })],
    commitTrailerIndex: buildCommitTrailerIndex({ slug: "o/r", exec: fakeGit(commit("a", "fix(x): y (#3009)", "Remudero-Task: W1-T2326\n")) }),
  });
  const p = projectPlan(onePlan("W1-T2326"), { ledgerPath: emptyLedger(), github: gh }).get("W1-T2326")!;
  assert.equal(p.merged, false, "unreadable head fails closed, commit evidence or not");
});

test("W1-T2387: a gateway with no commit surface at all behaves exactly as it did before the union", () => {
  const gh = buildBatchedGithub("o", "r", { fetchAll: () => [pr({ number: 3008, headRefName: "fix/x", body: "no trailer" })] , commitTrailerIndex: () => null });
  const p = projectPlan(onePlan("W1-T2326"), { ledgerPath: emptyLedger(), github: gh }).get("W1-T2326")!;
  assert.equal(p.merged, false, "an unbuildable commit index fails CLOSED — never a credit");
});
