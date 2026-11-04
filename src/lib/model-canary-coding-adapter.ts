/**
 * The coding canary's worker request port: the bounded, tool-less provider request that asks for a
 * candidate program. The native host execution port that runs that program under the systemd/bwrap
 * backend is W1-T11313; without it the coding schedule defers before any provider admission.
 */
import type { CanaryExecutionPorts } from "./model-canary-runner.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.js";
import type { SpawnWorkerArgs, WorkerResult } from "./worker.js";
import { resolveInstallRoot } from "./install-root.js";

/** Provider transport stays outside the candidate namespace; no worker tools see the owner store. */
export type CodingWorker = (args: SpawnWorkerArgs) => Promise<Pick<WorkerResult,
  "exit" | "text" | "isError" | "apiError" | "workerDurationMs" | "workerFirstTextMs" | "tokens"
  | "tokenUsageState" | "sdkReportedUsageRatedUsd" | "notionalCostUsd" | "servedModel" | "executionEvidence">>;

export function codingWorkerRequestPorts(config: Config, ownerDirectory: string,
  worker: CodingWorker): CanaryExecutionPorts {
  return {
    // spawnWorker owns live capacity admission and the ordinary shared allowance before transport.
    admit: async pin => pin.billing === "subscription" && pin.route === "claude" && config.overflow !== "api_key"
      ? { state: "admitted" } : { state: "refused", reason: "coding-subscription-route-required" },
    monotonicMs: () => performance.now(),
    save: async () => {}, // The terminal callback persists the complete run in the existing owner.
    request: async (request, context) => {
      if (!context || request.history.length || request.allowedTools?.length)
        throw new Error("coding-worker-request-contract-invalid");
      const cwd = mkdtempSync(join(ownerDirectory, "coding-request-"));
      let workerStarted = false, closed = false;
      try {
        const { renderWorkerSettings } = await import("./worker.js");
        const installRoot = resolveInstallRoot(config);
        const settingsFile = renderWorkerSettings({ templatePath: join(installRoot, "settings", "worker.json"),
          hooksDir: join(installRoot, "hooks"), outPath: join(cwd, "worker-settings.json") });
        workerStarted = true;
        const result = await worker({ config, cwd, permissionMode: "dontAsk",
          settingsFile,
          prompt: `Return only a JSON object with one string property, source, containing the JavaScript program.\n${request.prompt}`,
          model: request.pin.model, effort: request.pin.effort,
          mountProvider: "claude", mcpIsolation: "repo-knowledge-only",
          tools: [], cashTools: [], maxTurns: 1, signal: request.signal,
          runId: context.runId, taskId: "MODEL-CANARY-CODING" });
        if (!result.exit || result.exit.kind === "unobserved") throw new Error("coding-worker-closure-unavailable");
        closed = true;
        const tokens = result.tokenUsageState === "observed" ? result.tokens : null;
        return { text: result.text, toolCalls: [], resources: {
          durationMs: result.workerDurationMs ?? null, firstTextMs: result.workerFirstTextMs ?? null,
          generationMs: null, inputTokens: tokens?.input ?? null, outputTokens: tokens?.output ?? null,
          cacheReadTokens: tokens?.cacheRead ?? null, cacheWriteTokens: tokens?.cacheCreation ?? null,
          reasoningTokens: null, usageRatedUsd: result.sdkReportedUsageRatedUsd ?? result.notionalCostUsd ?? null,
          billing: request.pin.billing, servedModel: result.servedModel ?? null,
          terminal: result.isError || result.apiError || result.exit.kind === "signal"
            || result.exit.kind === "exit" && result.exit.code !== 0 ? "error" as const : "complete" as const,
          executionEvidence: result.executionEvidence,
        } };
      } finally {
        // A rejected/ambiguous worker retains its scratch beside its held slot for native recovery.
        if (!workerStarted || closed) rmSync(cwd, { recursive: true, force: true });
      }
    },
  };
}
