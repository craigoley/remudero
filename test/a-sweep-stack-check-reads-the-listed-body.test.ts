import assert from "node:assert/strict";
import { test } from "node:test";

import { stackPrerequisiteFromRest } from "../src/lib/arm-auto-merge.js";
import type { OpenPrView } from "./helpers/sweep-test.js";
import { buildSweepEffects } from "../src/run-task.js";

// A live CPU profile of remudero-daemon on 2026-09-30 put runSweep > stackPrerequisiteFromRest at
// 8.8% of the loop's busy time: one synchronous `gh api pulls/<n>` per open PR per pass, to read a
// body the pass's own open-PR list had fetched seconds earlier.

const URL = "https://github.com/craigoley/remudero/pull";

function recordingFetch(rows: Record<number, unknown>): { fetch: (args: string[]) => unknown; paths: string[] } {
  const paths: string[] = [];
  return {
    paths,
    fetch: (args) => {
      const path = args[1] ?? "";
      paths.push(path);
      const n = Number(path.split("/").pop());
      if (!(n in rows)) throw new Error(`unexpected read ${path}`);
      return rows[n];
    },
  };
}

test("a listed unstacked body answers the stack check with no pull request read", () => {
  const rest = recordingFetch({});
  const check = stackPrerequisiteFromRest(`${URL}/5001`, rest.fetch, "Fixes the sweep.\n\nRemudero-Task: W1-T5001");
  assert.deepEqual(check, { state: "unstacked", parentNumbers: [] });
  assert.deepEqual(rest.paths, []);
});

test("a listed stacked body still reads each declared parent live", () => {
  const rest = recordingFetch({ 5002: { state: "open", merged_at: null } });
  const check = stackPrerequisiteFromRest(`${URL}/5003`, rest.fetch, "Stacked on #5002");
  assert.equal(check.state, "blocked");
  assert.deepEqual(check.openParentNumbers, [5002]);
  assert.deepEqual(rest.paths, ["repos/craigoley/remudero/pulls/5002"], "only the parent is read, never the child");
});

test("the sweep adapter passes the view body so an unstacked pull request costs no read", () => {
  const restPaths: string[] = [];
  const effects = buildSweepEffects({
    owner: "craigoley",
    repo: "remudero",
    config: { root: "/nonexistent-for-this-fixture" } as never,
    ledgerPath: "/nonexistent-for-this-fixture/ledger.ndjson",
    runId: "RUN-stack-listed-body",
    plan: { tasks: [], byId: new Map() },
    log: () => {},
    policy: undefined,
    ghJsonImpl: (args) => {
      restPaths.push(args[1] ?? "");
      return { body: "Stacked on #5004" };
    },
    reviewRunner: undefined,
    spawnImpl: undefined,
    pushEmptyCommit: undefined,
    issuesImpl: undefined,
    stallNotice: undefined,
    armImpl: undefined,
    armSessionPrsOverride: undefined,
    updateBranchImpl: undefined,
    captureRepairFeedbackImpl: undefined,
    ghRunImpl: undefined,
    spawnWallClockBoundMsOverride: undefined,
    reclaimWorkerImpl: undefined,
  });
  const listed = { prUrl: `${URL}/5005`, body: "No stack declared." } as OpenPrView;
  assert.deepEqual(effects.stackPrerequisite?.(listed), { state: "unstacked", parentNumbers: [] });
  assert.deepEqual(restPaths, [], "the listed body is used; the child pull request is not re-read");
});
