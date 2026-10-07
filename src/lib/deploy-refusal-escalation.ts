import type { PersistingRefusal } from "./deployer.js";
import { escalate, type IssueGateway } from "./escalate.js";

/**
 * The needs-human issue for a recycle that keeps refusing (W1-T6062). Kept out of deployer.ts,
 * which must not import escalate.ts: that edge closes ten import cycles (test/cycle-ratchet.test.ts).
 * deployer.ts counts the streak; `rmd deploy-run` injects {@link refusalEscalationFor} into it.
 */
export function escalatePersistingRefusal(
  r: PersistingRefusal,
  ctx: { issues: IssueGateway; ledgerPath: string; runId: string },
): string {
  const lag = r.lagCommits === undefined ? "an unknown number of baked-path commits" : `${r.lagCommits} baked-path commit(s)`;
  return escalate(
    {
      class: "BLOCKED",
      taskId: `DEPLOY-REFUSAL-${r.instance}-${r.key}`,
      runId: ctx.runId,
      // STABLE across windows (no count, no lag): escalate dedups on the title, so a changing one
      // would open a new issue every hour instead of updating the open one.
      summary: `image recycle for ${r.instance} keeps being refused (${r.key})`,
      detail:
        `The ${r.backend} backend refused to recycle instance ${r.instance} on ${r.count} consecutive ` +
        `backoff windows (first refused ${r.firstAtIso}, latest ${r.lastAtIso}) for the same reason. ` +
        `The running image is ${lag} behind origin/main, so merged baked-path changes are not live. ` +
        `Target head ${r.toHead}.\n\nRefusal's remedy line: ${r.remedy}\n\nFull refusal:\n${r.message.slice(0, 1500)}`,
      options: [
        { label: "apply the remedy and let the next window retry", detail: r.remedy },
        {
          label: "recycle by hand",
          detail: `run \`bash deploy/recycle-container.sh --instance ${r.instance}\` on the host once the refusal's cause is fixed.`,
        },
      ],
      recommendation: "apply the remedy and let the next window retry",
      consequence: "the instance keeps running a stale image; every hourly retry will refuse again",
    },
    ctx,
  );
}

/** The two injectable halves for `realDeployDeps`, bound to one issue gateway. */
export function refusalEscalationFor(
  issues: IssueGateway,
  ledgerPath: string,
): {
  escalateRefusal: (r: PersistingRefusal) => string;
  closeRefusalIssue: (url: string, comment: string) => void;
} {
  return {
    escalateRefusal: (r) => escalatePersistingRefusal(r, { issues, ledgerPath, runId: `DEPLOY-REFUSAL-${r.instance}` }),
    closeRefusalIssue: (url, comment) => {
      if (!issues.closeWithComment) throw new Error("issue gateway cannot close issues");
      issues.closeWithComment(url, comment);
    },
  };
}
