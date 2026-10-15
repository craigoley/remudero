/**
 * W1-T9698 — the alert-fix dispatch's read of the PR it just opened. The body is read ONCE over an awaited `gh`
 * child and judged twice: by the author-time acceptance check (W1-T952) and by the inert-proof count (W1-T8625).
 * The synchronous `ghJson` used to hold the daemon loop here for two round trips per open.
 */
import { ghJsonAsync } from "./github-transport.js";
import { inertAcceptanceProofs } from "./proof-grammar.js";
import { acceptanceAuthorTimeCheck, type AcceptanceAuthorTimeResult } from "./review.js";

/** The dispatch's two body seams. `checkAcceptance` judges the body handed to it, or reads its own when handed none. */
export interface AlertFixBodySeams {
  checkAcceptance: (prUrl: string, body?: string) => AcceptanceAuthorTimeResult | Promise<AcceptanceAuthorTimeResult>;
  readPrBody?: (prUrl: string) => string | Promise<string>;
}

/** W1-T8625: the opened PR's body over `gh`. `read` defaults to the awaited {@link ghJsonAsync}; an absent `body`
 *  field reads as `""`. */
export async function readAlertFixPrBody(prUrl: string, read: (args: string[]) => unknown = ghJsonAsync): Promise<string> {
  const view = (await read(["pr", "view", prUrl, "--json", "body"])) as { body?: string } | undefined;
  return view?.body ?? "";
}

/** W1-T952: the real acceptance check over the PR body. No `expectedTaskId`: an alert-fix task id never resolves in
 *  the plan, so the body-only check applies. */
export async function checkAlertFixAcceptance(prUrl: string, read: (args: string[]) => unknown = ghJsonAsync): Promise<AcceptanceAuthorTimeResult> {
  return acceptanceAuthorTimeCheck(await readAlertFixPrBody(prUrl, read));
}

/** The real body seams over one reader. */
export function alertFixBodyDeps(read: (args: string[]) => unknown = ghJsonAsync): Required<AlertFixBodySeams> {
  return {
    checkAcceptance: (prUrl, body) => (body === undefined ? checkAlertFixAcceptance(prUrl, read) : acceptanceAuthorTimeCheck(body)),
    readPrBody: (prUrl) => readAlertFixPrBody(prUrl, read),
  };
}

/**
 * Read the opened body once, then ledger the acceptance check's defect and the inert-proof count over it. Each
 * judgment is guarded on its own: a failed read or check is a named `acceptance_check_error`, never a clean body
 * and never fatal to the lane. Without `readPrBody` the inert-proof count does not run.
 */
export async function judgeOpenedAlertFixBody(
  prUrl: string,
  deps: AlertFixBodySeams,
  log: (step: string, extra?: Record<string, unknown>) => void,
): Promise<void> {
  let body: { read: string } | { error: unknown } | undefined;
  if (deps.readPrBody) {
    try {
      body = { read: await deps.readPrBody(prUrl) };
    } catch (error) {
      // Carried in `body`: the inert-proof count below ledgers it as its named check error.
      body = { error };
    }
  }
  try {
    const check = await deps.checkAcceptance(prUrl, body && "read" in body ? body.read : undefined);
    if (!check.ok) {
      log("alert-fix.acceptance_defect", { pr_url: prUrl, defect: check.defect, message: check.message });
    }
  } catch (e) {
    log("alert-fix.acceptance_check_error", { pr_url: prUrl, error: String((e as Error)?.message ?? e) });
  }
  if (!body) return;
  try {
    if ("error" in body) throw body.error;
    const inert = inertAcceptanceProofs(body.read);
    if (inert.length > 0) {
      log("alert-fix.acceptance_defect", {
        pr_url: prUrl,
        defect: "inert-proofs",
        inert_count: inert.length,
        inert_proofs: inert,
        message: `${inert.length} Acceptance proof(s) carry no executable \`unit test:\`/\`grep:\` dialect — the reviewer will not run them`,
      });
    }
  } catch (e) {
    log("alert-fix.acceptance_check_error", { pr_url: prUrl, check: "inert-proofs", error: String((e as Error)?.message ?? e) });
  }
}
