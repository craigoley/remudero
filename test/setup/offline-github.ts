/**
 * A RECORDING, OFFLINE `GitHub` gateway for tests that drive `retroCommand`.
 *
 * WHY THIS EXISTS. `retroCommand` runs `projectPlan` twice, and its default gateway is
 * `ghGateway`, whose `findMergedByTrailer` shells ONE `gh pr list --search` PER TASK. MEASURED
 * against 439 task records: `test/retro.test.ts` took 453 SECONDS for 87 passing tests from a
 * SINGLE `retroCommand(["--dry-run"])`, and `test/retro-marker-atomic.test.ts` drives the same
 * command 23 more times. None of those tests asserts anything about merge state — every assertion
 * is about rendering, marker atomicity or trigger policy — so the network round trips buy nothing.
 *
 * IT RECORDS, SO A TEST CAN PROVE IT WAS REACHED. A dep injected into a path that ignores it looks
 * exactly like one that works: both go green. `calls` is the discriminator — assert it is non-empty
 * and you have proved the production path consulted THIS object rather than opening a real gateway.
 *
 * IT ANSWERS HONESTLY, NOT EMPTILY. `readFailed()` returns FALSE: an "unreadable" gateway pushes
 * `projectPlan` down its W1-T119 indeterminate path, which is a different code path from the one
 * these tests mean to exercise. Every task reads as NOT MERGED — the same answer the real gateway
 * gives for the ~401 open tasks that dominate this plan — so the sections under test render with
 * the same shape they render in production, and a rendering assertion is not made trivially true by
 * a gateway that refuses to answer.
 */
import type { GitHub, PrRef } from "../../src/lib/status.js";

/** A recording gateway plus the log of what the production path asked it. */
export interface OfflineGithub extends GitHub {
  /** Every method invoked, in order, as `"<method>(<arg>)"`. Non-empty ⇒ the fake was REACHED. */
  readonly calls: string[];
}

/**
 * Build a gateway that answers every question offline and records being asked.
 *
 * `listMergedHeadBranches`/`listOpenHeadBranches` return an EMPTY LIST rather than `null`: `null`
 * means "the read FAILED" and makes `projectPlan` fall back to the per-task `findMergedByHeadBranch`
 * — reintroducing the O(N) shape this fake exists to remove.
 */
export function offlineGithub(): OfflineGithub {
  const calls: string[] = [];
  const note = <T>(what: string, value: T): T => {
    calls.push(what);
    return value;
  };
  return {
    calls,
    prByRef: (ref) => note(`prByRef(${String(ref)})`, null),
    findMergedByTrailer: (taskId) => note(`findMergedByTrailer(${taskId})`, null),
    findMergedByHeadBranch: (taskId) => note(`findMergedByHeadBranch(${taskId})`, [] as PrRef[]),
    listMergedHeadBranches: () => note("listMergedHeadBranches()", [] as PrRef[]),
    listOpenHeadBranches: () => note("listOpenHeadBranches()", [] as PrRef[]),
    headRefName: (prUrl) => note(`headRefName(${prUrl})`, undefined),
    prBody: (prUrl) => note(`prBody(${prUrl})`, undefined),
    autoMergeArmed: (prUrl) => note(`autoMergeArmed(${prUrl})`, false),
    warm: () => note("warm()", undefined),
    // NOT a failed read — see the header. A `true` here would reroute projectPlan entirely.
    readFailed: () => false,
    readFailureReason: () => undefined,
    issueByUrl: (url) => note(`issueByUrl(${url})`, null),
    issueReadFailed: () => false,
  };
}
