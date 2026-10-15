/** Shared by every provider at the spawn boundary; no filesystem or privilege changes. */
export const WORKSPACE_CLEANUP_INSTRUCTIONS = [
  "# WORKSPACE CLEANUP",
  "Before finishing, clean up your own disposable scratch, temporary fixtures, caches and generated artifacts after their consumers finish and required evidence is saved durably.",
  "Use only your existing tool/write authority; read-only workers must not gain write access for cleanup.",
  "Never delete your current working directory or a harness-owned checkout/worktree: the harness owns its teardown. Hand-created checkouts must use the existing guarded publication-aware retirement path.",
  "Preserve active/shared paths, shared dependencies and immutable seeds, unpublished commits, dirty/untracked source, unversioned scripts/reports, credentials, state, ledger/history and durable validation evidence. Never stop another worker or clear active claims/locks. Uncertain ownership, activity, publication or safety means keep the path.",
  "The six-hour janitor is a crash/backstop reaper; finish your own cleanup. Preserve the required output schema and record retained paths/reasons only where that report or receipt contract permits.",
].join("\n");

/** Recursive provider fallback must not grow a second copy of this instruction block. */
export function withWorkspaceCleanup(prompt: string): string {
  const suffix = `\n\n${WORKSPACE_CLEANUP_INSTRUCTIONS}`;
  return prompt.endsWith(suffix) ? prompt : `${prompt}${suffix}`;
}
