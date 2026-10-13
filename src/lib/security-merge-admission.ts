import { ghJson, ghJsonAsync } from "./github-transport.js";
// @ts-expect-error — shared metadata program is dependency-free ESM outside tsconfig source roots.
import { readSecurityMergeDecision, readSecurityMergeDecisionSync } from "../../scripts/lib/code-scanning-merge-adapter.mjs";

export class SecurityMergeRefused extends Error {
 constructor(readonly state: "blocked" | "unknown", readonly reason: string) {
  super(`security merge ${state}: ${reason}`);
 }
}
function targetFor(prUrl: string): { owner: string; repo: string; prNumber: number } | undefined {
 if (!prUrl.startsWith("https://github.com/craigoley/remudero/pull/")) return undefined; // Approval is CORE-only.
 const number = /^https:\/\/github\.com\/craigoley\/remudero\/pull\/([1-9][0-9]*)$/.exec(prUrl)?.[1];
 if (!number || !Number.isSafeInteger(Number(number))) throw new SecurityMergeRefused("unknown", "noncanonical-pr-target");
 return { owner: "craigoley", repo: "remudero", prNumber: Number(number) };
}
function allowedHead(result: { headSha?: string; decision: { mergeAllowed?: boolean; state?: string; reason?: string } }): string {
 if (result.decision?.mergeAllowed !== true || !/^[a-f0-9]{40}$/.test(result.headSha ?? ""))
  throw new SecurityMergeRefused(result.decision?.state === "blocked" ? "blocked" : "unknown",
   result.decision?.reason ?? "security-evidence-unavailable");
 return result.headSha!;
}

/** Exact-head source guard on normal merge effectors; no flag, status write or live rollout.
 * Server-side trusted-producer enforcement and durable UNKNOWN escalation remain separate.
 */
export function securityMergeHead(prUrl: string, read: (path: string) => unknown = path => ghJson(["api", path])): string | undefined {
 const target = targetFor(prUrl);
 return target ? allowedHead(readSecurityMergeDecisionSync(target, read)) : undefined;
}
export async function securityMergeHeadAsync(prUrl: string,
 read: (path: string) => Promise<unknown> = path => ghJsonAsync(["api", path])): Promise<string | undefined> {
 const target = targetFor(prUrl);
 return target ? allowedHead(await readSecurityMergeDecision(target, read)) : undefined;
}
