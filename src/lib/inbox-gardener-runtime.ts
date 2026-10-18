/** Governed production ports shared by daemon registration and direct default-source qualification. */
import { join } from "node:path";
import { loadedHarnessRevision, benchmarkNonDispatchSpawn, withReceiptIdentity } from "./benchmark-run.js";
import { defaultInboxGardenerPorts } from "./inbox-gardener.js";
import { inboxSemanticDigest } from "./inbox-retirement.js";
import { resolveRepoLayout } from "./repo-layout.js";
import { loadMounts, mountsPath, type Mount } from "./mounts.js";
import { resolveVerifyHumanJudgeMount } from "./verify-human-judge.js";
import type { spawnWorker } from "./worker.js";
import type { ghJsonAsync } from "./github-transport.js";

export interface InboxGardenerRuntimeContext {
  config: { root: string };
  repoRoot: string; owner: string; repo: string; codeSha?: string;
  log(step: string, extra?: Record<string, unknown>): void;
}

export async function inboxGardenerRunTaskPorts(ctx: InboxGardenerRuntimeContext, seams: { spawn?: typeof spawnWorker; mount?: () => Mount; githubJson?: typeof ghJsonAsync; readCodeSha?: () => Promise<string> } = {}) {
  const scope = { instance: process.env.RMD_INSTANCE_NAME ?? "core", repository: `${ctx.owner}/${ctx.repo}`, root: ctx.config.root };
  let codeSha = ctx.codeSha ?? "unknown";
  if (ctx.codeSha === undefined) {
    try {
      const pin = loadedHarnessRevision();
      codeSha = seams.readCodeSha ? (await seams.readCodeSha()).trim() : pin && "revision" in pin ? pin.revision : "unknown";
    }
    catch (error) { ctx.log("inbox.gardener_source_unavailable", { reason: String(error) }); }
  }
  return { scope, ports: defaultInboxGardenerPorts({ stateDir: join(ctx.config.root, "state"), scope, planPath: resolveRepoLayout(ctx.repoRoot).planMonolith,
    creditOverridePath: join(resolveRepoLayout(ctx.repoRoot).planDir, "credit-overrides.yaml"), codeSha, githubJson: seams.githubJson,
    judge: async (prompt, candidate) => {
      const mount = seams.mount?.() ?? resolveVerifyHumanJudgeMount(loadMounts(mountsPath(ctx.repoRoot)));
      const spawn = seams.spawn ?? benchmarkNonDispatchSpawn("inbox-gardener");
      const result = await spawn(withReceiptIdentity({ cwd: ctx.repoRoot, settingsFile: join(ctx.repoRoot, "settings", "worker.json"),
        permissionMode: "bypassPermissions", prompt: `${prompt}\nRespond with only JSON: {"decision":"needs_triage"|"mechanical_followup","reason":"..."}.`,
        model: mount.model, effort: mount.effort, maxTurns: 1, tools: [], ...(mount.provider ? { mountProvider: mount.provider } : {}) },
      { taskId: "INBOX-GARDENER", runId: `inbox-gardener-${inboxSemanticDigest([candidate.proposal.id, prompt])}` }));
      return JSON.parse(result.text);
    } }) };
}

