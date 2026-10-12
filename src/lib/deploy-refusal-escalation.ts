import { systemClock, type Clock } from "./clock.js";
import type { PersistingRefusal } from "./deployer.js";
import { escalate, type Escalation, type IssueGateway } from "./escalate.js";
import { spoolEscalation, spoolIssueAction, withdrawSpooledEscalation, type SpoolMeta } from "./host-escalation-spool.js";

/**
 * The needs-human issue for a recycle that keeps refusing (W1-T6062). Kept out of deployer.ts,
 * which must not import escalate.ts: that edge closes ten import cycles (test/cycle-ratchet.test.ts).
 * deployer.ts counts the streak; `rmd deploy-run` injects {@link refusalEscalationFor} into it.
 */
export function escalatePersistingRefusal(
  r: PersistingRefusal,
  ctx: { issues: IssueGateway; ledgerPath: string; runId: string },
): string {
  return escalate({ ...persistingRefusalEscalation(r), runId: ctx.runId }, ctx);
}

/** The dedup identity of one instance's refusal reason: the task id and the title. */
export function refusalIdentity(instance: string, key: string): Pick<Escalation, "taskId" | "summary"> {
  return {
    taskId: `DEPLOY-REFUSAL-${instance}-${key}`,
    // STABLE across windows (no count, no lag): escalate dedups on the title, so a changing one
    // would open a new issue every hour instead of updating the open one.
    summary: `image recycle for ${instance} keeps being refused (${key})`,
  };
}

export function persistingRefusalEscalation(r: PersistingRefusal): Escalation {
  const lag = r.lagCommits === undefined ? "an unknown number of baked-path commits" : `${r.lagCommits} baked-path commit(s)`;
  return {
    class: "BLOCKED",
    ...refusalIdentity(r.instance, r.key),
    runId: `DEPLOY-REFUSAL-${r.instance}`,
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
  };
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

/** The halves `realDeployDeps` takes; each is absent when nothing can carry it. */
export interface RefusalEscalationHalves {
  escalateRefusal?: (r: PersistingRefusal) => string | undefined;
  closeRefusalIssue?: (url: string, comment: string) => void;
  withdrawRefusal?: (r: { instance: string; key: string }, comment: string) => void;
}

/** Where a host-side `rmd deploy-run` spools what it cannot post (host-escalation-spool.ts). */
export interface RefusalSpool {
  stateDir: string;
  host: string;
  clock?: Clock;
}

/**
 * {@link refusalEscalationFor} for a checkout that may not name its own owner/repo or hold a GitHub
 * credential. With a `spool`, nothing is dropped: each half tries the direct gateway first and,
 * when that is absent, throws or opens nothing (the host's `gh` is not logged in, so its dedup read
 * fails), spools the escalation or close for the daemon to post. Without one, a checkout with no
 * owner/repo gets no halves: the refusal is counted and logged but opens no issue.
 */
export function refusalEscalationOrNone(
  resolveSelf: () => { owner: string; repo: string },
  gatewayFor: (owner: string, repo: string) => IssueGateway,
  ledgerPath: string,
  spool?: RefusalSpool,
): RefusalEscalationHalves {
  let direct: ReturnType<typeof refusalEscalationFor> | undefined;
  let directError = "no resolvable owner/repo";
  try {
    const self = resolveSelf();
    direct = refusalEscalationFor(gatewayFor(self.owner, self.repo), ledgerPath);
  } catch (e) {
    directError = String((e as Error)?.message ?? e); // carried into every spooled entry as its directError
  }
  if (!spool) return direct ?? {};
  const meta = (error: string): SpoolMeta => ({ source: "deploy-run", host: spool.host, clock: spool.clock ?? systemClock, directError: error });
  return {
    escalateRefusal: (r) => {
      let error = directError;
      try {
        const url = direct?.escalateRefusal(r);
        if (url) return url;
        if (direct) error = "the direct escalation opened no issue (its dedup read failed: see escalation.dedup_unreadable)";
      } catch (e) {
        error = String((e as Error)?.message ?? e); // the spooled entry names why the host could not post
      }
      return spoolEscalation(spool.stateDir, persistingRefusalEscalation(r), meta(error)) || undefined;
    },
    closeRefusalIssue: (url, comment) => {
      let error = directError;
      try {
        if (direct) return direct.closeRefusalIssue(url, comment);
      } catch (e) {
        error = String((e as Error)?.message ?? e); // the spooled entry names why the host could not post
      }
      spoolIssueAction(spool.stateDir, { kind: "close", url, body: comment }, meta(error));
    },
    withdrawRefusal: (r, comment) => withdrawSpooledEscalation(spool.stateDir, refusalIdentity(r.instance, r.key), comment, meta(directError)),
  };
}
