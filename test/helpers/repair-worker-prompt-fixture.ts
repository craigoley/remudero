import type { Config } from "#src/lib/config.js";
import type { AlertLaneAlert } from "#src/lib/alert-lane.js";
import type { MainRepairFixRequest } from "#src/lib/main-health-rung.js";
import { alertTaskId } from "#src/lib/ops.js";
import { withWorkspaceCleanup } from "#src/lib/workspace-cleanup-contract.js";
import { alertFixPrompt, dispatchAlertFixRun, dispatchMainRepairFixRun,
  mainRepairFixPrompt, type AlertFixDispatchDeps } from "#src/run-task.js";

export type RepairPromptDispatchDeps = AlertFixDispatchDeps;

export async function dispatchRepairPromptFixtures(
  config: Config, request: MainRepairFixRequest, alert: AlertLaneAlert,
  ledger: string, deps: AlertFixDispatchDeps,
): Promise<void> {
  await dispatchMainRepairFixRun("fixture", "repair", config, request, ledger, "main-fixture", deps);
  await dispatchAlertFixRun("fixture", "repair", config, alert, ledger, "alert-fixture", deps);
}

export function expectedClaudeRepairPrompts(
  request: MainRepairFixRequest, alert: AlertLaneAlert, bodyFile: string,
): [string, string] {
  return [withWorkspaceCleanup(mainRepairFixPrompt(request, bodyFile)),
    withWorkspaceCleanup(alertFixPrompt(alert, alertTaskId(alert)))];
}
