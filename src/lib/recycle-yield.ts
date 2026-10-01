/**
 * W1-T5127: a fleet PAUSE engaged by deploy/recycle-container.sh is a pending restart, not an operator
 * hold. A build run that is only waiting on CI hands that wait off when one is engaged, so the recycle's
 * drain is not held by work the sweep resumes after any restart. Read through fleet-control's own PAUSE
 * reader (`pauseDetail`), never a second parser; any other PAUSE reason still means hold.
 */
import { pauseDetail } from "./fleet-control.js";

const RECYCLE_PAUSE = /recycle-container\.sh/;

/** The PAUSE detail when the local PAUSE was engaged for a container recycle, else `undefined`. */
export function recyclePauseDetail(root: string, readDetail: (root: string) => string | undefined = pauseDetail): string | undefined {
  const detail = readDetail(root);
  return detail !== undefined && RECYCLE_PAUSE.test(detail) ? detail : undefined;
}
