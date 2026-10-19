import { ghJsonAsync } from "./github-transport.js";
import { RmdError } from "./errors.js";
// @ts-expect-error — pure ESM mapping shared with the dependency-free producer; tsconfig includes TS only.
import { securityMetadataGhArgs } from "./security-metadata-gh-args.mjs";
export { securityMetadataGhArgs };
// @ts-expect-error — pure ESM companion shared with the dependency-free producer; tsconfig includes TS only.
import { readSecurityMergeDecision, readSecurityMergeDecisionSync } from "./code-scanning-merge-adapter.mjs";

export class SecurityMergeRefused extends RmdError {
 constructor(readonly state: "blocked" | "unknown", readonly reason: string, readonly headSha?: string) {
  super("github", 1, `security merge ${state}: ${reason}`, { state, reason, ...(headSha ? {headSha} : {}) });
 }
}
function targetFor(prUrl: string): { owner: string; repo: string; prNumber: number } | undefined {
 // Recognize core URL aliases before deciding scope; refuse them rather than silently skipping the guard.
 let parsed: URL, parts: string[];
 try { parsed = new URL(prUrl); parts = decodeURIComponent(parsed.pathname).split("/"); }
 catch { throw new SecurityMergeRefused("unknown", "noncanonical-pr-target"); }
 if (parsed.hostname.toLowerCase().replace(/\.$/, "") !== "github.com" ||
     parts[1]?.toLowerCase() !== "craigoley" || parts[2]?.toLowerCase() !== "remudero") return undefined; // Approval is CORE-only.
 const number = /^https:\/\/github\.com\/craigoley\/remudero\/pull\/([1-9][0-9]*)$/.exec(prUrl)?.[1];
 if (!number || !Number.isSafeInteger(Number(number))) throw new SecurityMergeRefused("unknown", "noncanonical-pr-target");
 return { owner: "craigoley", repo: "remudero", prNumber: Number(number) };
}
function allowedHead(result: { headSha?: string; decision: { mergeAllowed?: boolean; state?: string; reason?: string } }): string {
 if (result.decision?.mergeAllowed !== true || !/^[a-f0-9]{40}$/.test(result.headSha ?? ""))
  throw new SecurityMergeRefused(result.decision?.state === "blocked" ? "blocked" : "unknown",
   result.decision?.reason ?? "security-evidence-unavailable", result.headSha);
 return result.headSha!;
}

/** Exact-head source guard on normal merge effectors; no flag, status write or live rollout.
 * Server-side trusted-producer enforcement and durable UNKNOWN escalation remain separate.
 */
export function securityMergeHead(prUrl: string, read: (path: string) => unknown, expectedHead?: string): string | undefined {
 const target = targetFor(prUrl);
 return target ? allowedHead(readSecurityMergeDecisionSync({...target,expectedHead}, read)) : undefined;
}
export async function securityMergeHeadAsync(prUrl: string,
 read: (path: string) => Promise<unknown> = path => ghJsonAsync(securityMetadataGhArgs(path)), expectedHead?: string): Promise<string | undefined> {
 const target = targetFor(prUrl);
 return target ? allowedHead(await readSecurityMergeDecision({...target,expectedHead}, read)) : undefined;
}
