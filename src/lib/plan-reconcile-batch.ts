/**
 * W1-T11859: how much of the plan-status drift ONE cadence landing carries.
 *
 * OBSERVED 2026-11-09: the cadence handed the landing bridge every drifted shard in one call. At 397
 * shards the pull-request body (one Acceptance bullet each) was 93,961 characters, GitHub refused it
 * ("Body is too long (maximum is 65536 characters)"), and the same refusal repeated on every fire, so
 * the drift only grew. The manual verb already says a drift over 300 shards must be split across
 * several plan-only PRs (W1-T3761); this is that split for the unattended path.
 *
 * ⚠ A PREFIX, NEVER A PICK. The batch is the longest run of shards, lowest task number first, that
 * fits both limits. It never skips a shard to fit a later one, so each fire is deterministic and
 * the next fire (which reads the merged flips as no longer drifted) simply takes what follows.
 */

/** Half of GitHub's 300-file review ceiling (`PLAN_RECONCILE_REVIEW_FILE_CEILING`, W1-T3761). */
export const PLAN_RECONCILE_LANDING_FILE_LIMIT = 150;

/** Characters of pull-request body one landing may use; GitHub refuses a body over 65,536. */
export const PLAN_RECONCILE_LANDING_BODY_BUDGET = 60_000;

/** The proof a flipped shard's Acceptance bullet carries when nothing sharper is derived. */
export function planReconcileProofTemplate(file: string): string {
  return `grep: ^  status: merged$ in ${file}`;
}

/** The whole landing PR body: the explanation, then one Acceptance bullet per shard. */
export function planReconcilePrBody(files: readonly string[], proofFor: (file: string) => string): string {
  return [
    "Reconciles credited task shards whose decorative status is still queued.",
    "",
    "The change is derived from the existing credit projection and staged through the scratch-index landing bridge.",
    "",
    "## Acceptance",
    ...files.map((file) => `- ${file} is reconciled without a daemon checkout write | ${proofFor(file)}`),
  ].join("\n");
}

/** The number in `W1-T123`, or `+Infinity` for an id that carries none (so it sorts last). */
function taskNumber(taskId: string): number {
  const digits = /(\d+)\s*$/.exec(taskId);
  return digits ? Number(digits[1]) : Number.POSITIVE_INFINITY;
}

/**
 * The batch one landing carries: `items` in ascending task-number order, cut at the file limit or
 * where the body (built with the longest proof form) would pass the budget. Always at least one item,
 * so a drift is never starved by a single long path.
 */
export function takePlanReconcileBatch<T extends { readonly taskId: string }>(
  items: readonly T[],
  fileOf: (item: T) => string,
  limits: { readonly files: number; readonly bodyChars: number } = {
    files: PLAN_RECONCILE_LANDING_FILE_LIMIT,
    bodyChars: PLAN_RECONCILE_LANDING_BODY_BUDGET,
  },
): T[] {
  const ordered = [...items].sort((a, b) => taskNumber(a.taskId) - taskNumber(b.taskId) || (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0));
  const batch: T[] = [];
  let chars = planReconcilePrBody([], planReconcileProofTemplate).length;
  for (const item of ordered) {
    const file = fileOf(item);
    const cost = planReconcilePrBody([file], planReconcileProofTemplate).length - planReconcilePrBody([], planReconcileProofTemplate).length;
    if (batch.length >= limits.files) break;
    if (batch.length > 0 && chars + cost > limits.bodyChars) break;
    batch.push(item);
    chars += cost;
  }
  return batch;
}
