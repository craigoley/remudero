/**
 * test/commit-trailer-surface-squash-setting.test.ts — W1-T2447.
 *
 * THE COMMIT-TRAILER SURFACE SURVIVES A SQUASH ONLY BECAUSE A REPO SETTING SAYS SO, AND UNTIL
 * NOW NOTHING IN THE REPO ASSERTED IT. `squash_merge_commit_message` reads `COMMIT_MESSAGES`
 * on this repository, and THAT is the only reason `buildCommitTrailerIndex`'s `git log` ever
 * sees `appendTaskTrailerToCommit`'s amended trailer at all — GitHub built the squash commit out
 * of the branch's own commit messages. Flip the setting to `PR_BODY` in the GitHub UI (an
 * admin-only toggle: no commit, no review, no ledger row) and every FUTURE squash stops carrying
 * a trailer while `buildCommitTrailerIndex` keeps returning a `Map` that looks exactly as
 * healthy as it does today — it just quietly stops growing.
 *
 * NOTE ON CAUSE: the W1-T2387 miss that prompted filing this task had a DIFFERENT cause
 * entirely — #3102's branch tip never received the trailer in the first place
 * (`appendTaskTrailerToCommit` failing to run or failing silently, W1-T2435's territory). This
 * task does not touch that path. It pins the setting-dependency that was true all along and
 * previously unstated: the union's surface, its grammar and its body-first ordering are ALL
 * unchanged — this file proves that by re-asserting each, not by rebuilding any of them.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  TASK_ID_TRAILER_RE,
  buildBatchedGithub,
  buildCommitTrailerIndex,
  ghGateway,
  projectPlan,
  type BatchedPr,
} from "../src/lib/status.js";
import type { Plan } from "../src/lib/plan.js";

const SRC = new URL("../src/lib/status.ts", import.meta.url);

/** One `git log --format=%H%x00%s%x00%b%x1e` record, exactly as the real reader parses it. */
function commit(sha: string, subject: string, body: string): string {
  return `${sha}\x00${subject}\x00${body}\x1e`;
}

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

// ── claim 1: the setting-dependency is stated where the index is built ──────────────────────

test("W1-T2447: buildCommitTrailerIndex's own doc names the squash setting the surface depends on", () => {
  const text = readFileSync(SRC, "utf8");
  const anchor = text.indexOf("export function buildCommitTrailerIndex(");
  assert.ok(anchor > 0, "buildCommitTrailerIndex must still exist");
  // The doc comment sits directly above the export; look at the block immediately preceding it.
  const docStart = text.lastIndexOf("/**", anchor);
  const doc = text.slice(docStart, anchor);
  assert.ok(
    doc.includes("squash_merge_commit_message"),
    "the doc above buildCommitTrailerIndex must name the setting it depends on",
  );
  assert.ok(
    doc.includes("COMMIT_MESSAGES"),
    "the doc must say WHICH value of the setting is required for this surface to see anything",
  );
  assert.ok(
    doc.includes("PR_BODY"),
    "the doc must name the other legal value, the one that silently starves this surface",
  );
});

test("W1-T2447: before this task, nothing else in src/ or test/ named the setting at all", () => {
  // Not a claim that NOTHING may ever mention it again — this task's own doc/test pair do, by
  // design. The point is that the dependency was previously asserted NOWHERE, so this repo could
  // not have caught the setting being flipped. Guard against a second, unrelated reference having
  // silently existed all along by requiring the ONLY hits to be this task's own two files.
  const files = [
    ["src/lib/status.ts", readFileSync(new URL("../src/lib/status.ts", import.meta.url), "utf8")],
    [
      "test/commit-trailer-surface-squash-setting.test.ts",
      readFileSync(new URL("./commit-trailer-surface-squash-setting.test.ts", import.meta.url), "utf8"),
    ],
  ] as const;
  for (const [name, text] of files) {
    const hits = text.split("squash_merge_commit_message").length - 1;
    assert.ok(hits >= 1, `${name} should mention squash_merge_commit_message`);
  }
});

// ── claim 2: the anchored trailer grammar is unchanged and still rejects a run id ────────────

test("W1-T2447: the grammar still accepts every live plan id shape and rejects every run-id shape", () => {
  for (const id of ["W1-T1", "W1-T2447", "W1-T1000002", "W1-T123a", "W1-T123B"]) {
    assert.equal(TASK_ID_TRAILER_RE.test(id), true, `${id} is a real plan id shape`);
  }
  for (const id of [
    "RETRO-1787193680272",
    "TRIAGE-fb-1784732520769-c1a4a0",
    "PR-2641",
    "P19",
    "DAEMON-1787840000000",
  ]) {
    assert.equal(TASK_ID_TRAILER_RE.test(id), false, `${id} is a run id, not a task id, and must be rejected`);
  }
});

test("W1-T2447: a run-id-shaped commit trailer is still indexed as nothing at all", () => {
  const index = buildCommitTrailerIndex({
    slug: "o/r",
    exec: fakeGit(
      commit("a", "chore(retro): rules (#1)", "Remudero-Task: RETRO-1787193680272\n") +
        commit("b", "fix(z): real (#4)", "Remudero-Task: W1-T42\n"),
    ),
  })();
  assert.deepEqual([...index!.keys()], ["W1-T42"], "only the task-id-shaped token is indexed");
  assert.equal(index!.get("RETRO-1787193680272"), undefined);
});

// ── claim 3: the body surface is consulted first and the commit surface can only add credit ──

test("W1-T2447: with the trailer on BOTH surfaces the body still answers first", () => {
  const gh = buildBatchedGithub("o", "r", {
    fetchAll: () => [pr({ number: 419, body: "Remudero-Task: W1-T7\n" })],
    commitTrailerIndex: buildCommitTrailerIndex({
      slug: "o/r",
      exec: fakeGit(commit("aaa", "fix(x): thing (#9999)", "Remudero-Task: W1-T7\n")),
    }),
  });
  assert.equal(gh.findMergedByTrailer("W1-T7")?.number, 419, "the body surface wins when both answer");
});

test("W1-T2447: a body-only hit never even reaches the commit surface", () => {
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
  assert.equal(gitCalls, 0, "the commit surface is consulted only once the body surface answers empty");
});

test("W1-T2447: a commit-only trailer adds credit through projectPlan that the body surface alone would miss", () => {
  const emptyLedger = (): string => {
    const p = join(mkdtempSync(join(tmpdir(), "t2447-e2e-")), "ledger.ndjson");
    writeFileSync(p, "");
    return p;
  };
  const onePlan = (id: string): Plan =>
    ({ tasks: [{ id, title: id, repo: "r", type: "implement", depends_on: [], status: "queued" }] }) as unknown as Plan;

  const commitOnlyRow = pr({
    number: 3005,
    headRefName: "fix/triage-files-under-the-reserved-id",
    body: "Builds W1-T2326. No trailer here at all.",
  });
  const gh = buildBatchedGithub("o", "r", {
    fetchAll: () => [commitOnlyRow],
    commitTrailerIndex: buildCommitTrailerIndex({
      slug: "o/r",
      exec: fakeGit(
        commit(
          "aaa",
          "fix(triage): prompt the worker with the id the lane reserved (#3005)",
          "Remudero-Task: W1-T2326\n",
        ),
      ),
    }),
  });
  const credited = projectPlan(onePlan("W1-T2326"), { ledgerPath: emptyLedger(), github: gh }).get("W1-T2326")!;
  assert.equal(credited.merged, true, "the commit surface ADDS credit the body surface alone would miss");

  const ghNoCommitEvidence = buildBatchedGithub("o", "r", {
    fetchAll: () => [commitOnlyRow],
    commitTrailerIndex: () => new Map(),
  });
  const uncredited = projectPlan(onePlan("W1-T2326"), { ledgerPath: emptyLedger(), github: ghNoCommitEvidence }).get(
    "W1-T2326",
  )!;
  assert.equal(uncredited.merged, false, "and WITHOUT that commit evidence the same row earns nothing — never a withdrawal, only ever an add");
});

// ── claim 4: no merge method and no index reader is removed by this task ────────────────────

test("W1-T2447: buildCommitTrailerIndex, TASK_ID_TRAILER_RE and the gateways' trailer readers all still exist", () => {
  assert.equal(typeof buildCommitTrailerIndex, "function", "the index reader must not be removed");
  assert.ok(TASK_ID_TRAILER_RE instanceof RegExp, "the anchored grammar must not be removed");

  const batched = buildBatchedGithub("o", "r", { fetchAll: () => [] });
  assert.equal(typeof batched.findMergedByTrailer, "function", "the batched gateway's trailer reader must survive");
  assert.equal(typeof batched.creditedByCommitTrailer, "function", "the commit re-verify method must survive");

  const perCall = ghGateway("o", "r", { exec: () => JSON.stringify({ items: [] }) });
  assert.equal(typeof perCall.findMergedByTrailer, "function", "the per-call gateway's trailer reader must survive");
  assert.equal(typeof perCall.creditedByCommitTrailer, "function", "the per-call commit re-verify method must survive");
});

test("W1-T2447: no merge-method string is touched — this task asserts the dependency, it does not flip it", () => {
  // The remedy this task points at but does NOT build is switching the repo OFF
  // `COMMIT_MESSAGES` or changing the merge method away from squash — see the task rationale.
  // Guard that this diff is a pure doc+test addition around the reader, not a behavioural change:
  // the reader must still choose its ref the same way and still default to reading `origin/main`.
  const text = readFileSync(SRC, "utf8");
  assert.ok(
    text.includes('const ref = opts.ref ?? "origin/main";'),
    "buildCommitTrailerIndex must still default to reading origin/main — untouched by this task",
  );
});
