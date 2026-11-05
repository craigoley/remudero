import { GITHUB_COMPARE_FILES_LISTED } from "./base-reproduction.js";
import type { BaseChangedFiles, LightPassPreReviewTiming, OpenPrView } from "./sweep.js";

/**
 * W1-T11293 — the light pass's distance reader for READY PRs (checks green, review success). It reads every PR it is
 * handed, memoized per (head, main): a ready PR is the only kind that can merge, so it is never left unmeasured behind
 * the three-per-window rotation that W1-T3277's stale-distance refresh uses (`distanceRefreshProbeTargets`). On
 * 2026-11-03 that rotation held #16546 and #16548 "ready PR distance is unreadable" for ~90 minutes: four passes read
 * three compares each, and #16548 was never read. A compare that fails or reads no `ahead_by` still holds only its PR.
 */
export function createReadyPrCompareReader(owner: string, repo: string, read: (args: string[]) => Promise<unknown>) {
  type Facts = { behindBy: number; baseFiles?: BaseChangedFiles };
  const memo = new Map<number, { head: string; main: string | undefined; value: Promise<Facts | undefined> }>();
  return {
    retain: (prs: readonly OpenPrView[]) => {
      const heads = new Map(prs.map((pr) => [pr.prNumber, pr.headSha]));
      for (const [number, entry] of memo) if (heads.get(number) !== entry.head) memo.delete(number);
    },
    read: async (prs: readonly OpenPrView[], main: string | undefined, timing: LightPassPreReviewTiming) => {
      const behindMainByPr = new Map<number, number>();
      const baseChangedFilesByPr = new Map<number, BaseChangedFiles>();
      await timing.measure("compare", () => Promise.all(prs.map(async (pr) => {
        const start = timing.clock.now();
        let entry = memo.get(pr.prNumber);
        const cacheHit = main !== undefined && entry?.head === pr.headSha && entry.main === main;
        if (!cacheHit) {
          const value = Promise.resolve().then(async (): Promise<Facts | undefined> => {
            const compare = await read(["api", `repos/${owner}/${repo}/compare/${pr.headSha}...${main ?? "main"}`]) as {
              ahead_by?: unknown; files?: unknown;
            };
            if (typeof compare?.ahead_by !== "number" || !Number.isFinite(compare.ahead_by)) return undefined;
            return { behindBy: compare.ahead_by, ...(Array.isArray(compare.files) ? { baseFiles: {
              files: compare.files.flatMap((f) => typeof f?.filename === "string" ? [f.filename] : []),
              truncated: compare.files.length >= GITHUB_COMPARE_FILES_LISTED,
            } } : {}) };
          });
          entry = { head: pr.headSha, main, value };
          if (main !== undefined) memo.set(pr.prNumber, entry);
        }
        const row: Record<string, unknown> = { pr_number: pr.prNumber, head_sha: pr.headSha, main_sha: main ?? null, cache_hit: cacheHit };
        try {
          const facts = await entry!.value;
          row.outcome = facts ? "read" : "unreadable";
          if (facts) {
            behindMainByPr.set(pr.prNumber, facts.behindBy);
            if (facts.baseFiles) baseChangedFilesByPr.set(pr.prNumber, facts.baseFiles);
          } else if (memo.get(pr.prNumber) === entry) memo.delete(pr.prNumber);
        } catch (error) {
          Object.assign(row, { outcome: "error", error: String(error) });
          if (memo.get(pr.prNumber) === entry) memo.delete(pr.prNumber);
        } finally {
          row.elapsed_ms = timing.clock.now() - start;
          timing.compareReads.push(row);
        }
      })));
      return { behindMainByPr, baseChangedFilesByPr };
    },
  };
}
