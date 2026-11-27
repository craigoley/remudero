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

/** PRIMARY CONTROL: half of GitHub's 300-file review ceiling (`PLAN_RECONCILE_REVIEW_FILE_CEILING`, W1-T3761). */
export const PLAN_RECONCILE_LANDING_FILE_LIMIT = 150;

/**
 * W1-T14485: PRIMARY CONTROL: the plan review's per-pull-request record bound (remudero-ops
 * scripts/ops-gate.rb MAX_RECORDS_PER_PULL_REQUEST). Both status-reconciliation callers cut their
 * batch here, so every re-queue row and landed count names only records that went into the landing.
 */
export const PLAN_RECONCILE_LANDING_RECORD_LIMIT = 50;

/** PRIMARY CONTROL: characters of pull-request body one landing may use; GitHub refuses a body over 65,536. */
export const PLAN_RECONCILE_LANDING_BODY_BUDGET = 60_000;

/** The proof a flipped shard's Acceptance bullet carries when nothing sharper is derived. */
export function planReconcileProofTemplate(file: string): string {
  return `grep: ^  status: merged$ in ${file}`;
}

/** W1-T14302: the proof a re-queued shard's Acceptance bullet carries. */
export function planReconcileRequeueProofTemplate(file: string): string {
  return `grep: ^  status: queued$ in ${file}`;
}

/** The template for one landed file: a shard whose landed text reads `status: queued` was re-queued. */
export function planReconcileProofFor(file: string, landedText: string | undefined): string {
  return landedText !== undefined && /^  status: queued[ \t]*$/m.test(landedText)
    ? planReconcileRequeueProofTemplate(file)
    : planReconcileProofTemplate(file);
}

/** The statuses a reconcile landing writes: a credited flip, and a W1-T14302 re-queue. */
const PLAN_RECONCILE_STATUSES = ["merged", "queued"] as const;

/** A repository path the fenced proof below can name as one argv token (no quoting, no shell metacharacter). */
const PLAN_RECONCILE_COUNT_PROOF_PATH = /^[\w./-]+$/;

/**
 * W1-T15048: the `  status: <status>` lines of `text` that sit between two newlines. This is
 * exactly what {@link planReconcileStatusCountProof}'s pattern counts.
 */
export function planReconcileStatusLineCount(text: string, status: string): number {
  const lines = text.split("\n");
  let count = 0;
  for (let i = 1; i < lines.length - 1; i++) if (lines[i] === `  status: ${status}`) count++;
  return count;
}

/**
 * W1-T15048: a proof for a pure status flip into a file that already holds that status, where no
 * line of the landed text is new. Any line grep matches there is also a base line, so no line
 * proof can fail at base (check-proof --base exits 5, and the plan PR preflight refuses the whole
 * batch). This proof counts instead. It reads the file as one record (`-z`) and needs the head's
 * number of status lines, so it passes at head and fails at a base that holds fewer. Undefined
 * when no status gains a line, or when the path cannot be one argv token.
 */
export function planReconcileStatusCountProof(file: string, baseText: string | undefined, headText: string | undefined): string | undefined {
  if (baseText === undefined || headText === undefined || !PLAN_RECONCILE_COUNT_PROOF_PATH.test(file)) return undefined;
  for (const status of PLAN_RECONCILE_STATUSES) {
    const count = planReconcileStatusLineCount(headText, status);
    if (count > planReconcileStatusLineCount(baseText, status)) {
      return `\`grep -aPzc "(?:\\n  status: ${status}(?=\\n)[\\s\\S]*?){${count}}" ${file}\``;
    }
  }
  return undefined;
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

/** A git runner bound to one checkout: resolves with stdout, rejects on a nonzero exit. */
export type PlanReconcileSourceGit = (args: readonly string[]) => Promise<string>;

const COMMIT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/**
 * W1-T14574: INVARIANT a-moved-carried-record-never-lands-stale. The ops status landing builds its
 * candidate on the CURRENT ops main, but each record it carries holds bytes derived from the run's
 * pinned commit. A candidate whose parent descends from the pin is safe exactly when no commit
 * since the pin touched a carried record; any other parent, and any git failure, refuses (fail closed).
 */
export async function assertCarriedRecordsUnmoved(
  git: PlanReconcileSourceGit, pin: string, parent: string, carriedPaths: Iterable<string>,
): Promise<void> {
  const carried = [...new Set(carriedPaths)];
  let changed: string[];
  try {
    if (!COMMIT_ID.test(pin) || !COMMIT_ID.test(parent) || carried.length === 0) throw new Error("not a judgeable landing");
    await git(["merge-base", "--is-ancestor", pin, parent]);
    const names = await git(["diff", "--name-only", "--no-renames", "-z", pin, parent, "--", ...carried.map((path) => `:(literal)${path}`)]);
    changed = names.split("\0").filter((path) => carried.includes(path));
  } catch (error) {
    throw new Error("ops-status-source-moved", { cause: error });
  }
  if (changed.length > 0) throw new Error("ops-status-source-moved", { cause: new Error(`changed since the pin: ${changed.join(", ")}`) });
}

/** The landing's plan PR preflight, run only after the candidate's parent passes {@link assertCarriedRecordsUnmoved}. */
export function preflightOnUnmovedRecords<P, R>(
  git: PlanReconcileSourceGit, pin: string, carriedPaths: Iterable<string>, inner: (sha: string, pr: P) => R | Promise<R>,
): (sha: string, pr: P) => Promise<R> {
  return async (sha, pr) => {
    let parent: string;
    try { parent = (await git(["rev-parse", "--verify", `${sha}^`])).trim(); }
    catch (error) { throw new Error("ops-status-source-moved", { cause: error }); }
    await assertCarriedRecordsUnmoved(git, pin, parent, carriedPaths);
    return inner(sha, pr);
  };
}
