import { assertClaimRefPushAllowed, assertClaimRefPushAllowedAsync } from "./live-write-guard.js";
import { taskIdReservationRef } from "./task-id-reservation.js";

/**
 * Releases a `refs/rmd-id/<id>` reservation that THIS run pushed and then never filed, because a
 * gate refused the filing before any branch or PR could carry the id. Measured 2026-10-14: 3,885
 * of 7,130 reservations on origin had no shard, branch or PR, and the garden lanes leaked 99-100%
 * of what they reserved (scout 1,490, host-resource 512), each one a ref push that bought nothing.
 *
 * The doctrine that a contested reservation is never deleted still holds: this deletes only the
 * caller's own claim, leased on the exact sha it pushed, so a ref another writer has since taken
 * over or re-recorded is reported `foreign` and left alone. Idempotent: an absent ref is a no-op.
 */
export interface HeldTaskIdReservation {
  taskId: string;
  /** The sha this run left the ref at: its anchor, or the amended commit a takeover pushed. */
  sha: string;
}

export type ReservationReleaseOutcome = "released" | "already_absent" | "foreign" | "unreadable" | "failed";

export const RESERVATION_RELEASED_STEP = "task_id.reservation_released";
export const RESERVATION_RELEASE_SKIPPED_STEP = "task_id.reservation_release_skipped";

type GitAnswer = { status: number; stdout: string; stderr: string };
type ReleaseLog = (step: string, fields: Record<string, unknown>) => void;

interface ReleaseVerdict {
  outcome: ReservationReleaseOutcome;
  detail?: string;
}

/** The protocol both drivers run: read the ref, then delete it only under a lease on `held.sha`. */
function* releaseProtocol(held: HeldTaskIdReservation): Generator<string[], ReleaseVerdict, GitAnswer> {
  const ref = taskIdReservationRef(held.taskId);
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(held.sha)) return { outcome: "failed", detail: `not a full object name: ${JSON.stringify(held.sha)}` };
  const listed = yield ["ls-remote", "origin", ref];
  if (listed.status !== 0) return { outcome: "unreadable", detail: listed.stderr.trim() || `ls-remote exited ${listed.status}` };
  const line = listed.stdout.split("\n").map((l) => l.trim().split(/\s+/)).find(([, name]) => name === ref);
  if (!line) return { outcome: "already_absent" };
  if (line[0] !== held.sha) return { outcome: "foreign", detail: `the ref is at ${line[0]}, not the ${held.sha} this run pushed` };
  const pushed = yield ["push", `--force-with-lease=${ref}:${held.sha}`, "origin", `:${ref}`];
  if (pushed.status === 0) return { outcome: "released" };
  const said = pushed.stderr.trim();
  return { outcome: /stale info|rejected/i.test(said) ? "foreign" : "failed", detail: said || `push exited ${pushed.status}` };
}

function record(held: HeldTaskIdReservation, reason: string, lane: string, verdict: ReleaseVerdict, log?: ReleaseLog): ReservationReleaseOutcome {
  const released = verdict.outcome === "released" || verdict.outcome === "already_absent";
  log?.(released ? RESERVATION_RELEASED_STEP : RESERVATION_RELEASE_SKIPPED_STEP, {
    reserved_id: held.taskId, ref: taskIdReservationRef(held.taskId), sha: held.sha, lane, reason, outcome: verdict.outcome,
    ...(verdict.detail === undefined ? {} : { detail: verdict.detail }),
  });
  return verdict.outcome;
}

/** Never throws: a release that cannot complete leaves the reservation exactly as it was, and says why. */
export function releaseTaskIdReservation(
  run: (args: string[]) => GitAnswer,
  held: HeldTaskIdReservation,
  opts: { reason: string; lane: string; log?: ReleaseLog },
): ReservationReleaseOutcome {
  let verdict: ReleaseVerdict;
  try {
    const steps = releaseProtocol(held);
    let next = steps.next();
    while (!next.done) {
      if (next.value[0] === "push") assertClaimRefPushAllowed(run, taskIdReservationRef(held.taskId));
      next = steps.next(run(next.value));
    }
    verdict = next.value;
  } catch (e) {
    verdict = { outcome: "failed", detail: String((e as Error)?.message ?? e) };
  }
  return record(held, opts.reason, opts.lane, verdict, opts.log);
}

/** {@link releaseTaskIdReservation} over an awaited git runner, for the daemon loop. */
export async function releaseTaskIdReservationAsync(
  run: (args: string[]) => Promise<GitAnswer>,
  held: HeldTaskIdReservation,
  opts: { reason: string; lane: string; log?: ReleaseLog },
): Promise<ReservationReleaseOutcome> {
  let verdict: ReleaseVerdict;
  try {
    const steps = releaseProtocol(held);
    let next = steps.next();
    while (!next.done) {
      if (next.value[0] === "push") await assertClaimRefPushAllowedAsync(run, taskIdReservationRef(held.taskId));
      next = steps.next(await run(next.value));
    }
    verdict = next.value;
  } catch (e) {
    verdict = { outcome: "failed", detail: String((e as Error)?.message ?? e) };
  }
  return record(held, opts.reason, opts.lane, verdict, opts.log);
}
