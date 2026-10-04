import { mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";

import { queuedFeedbackLandings } from "../../src/lib/feedback-landing.js";

/** W1-T5628: a console capture is MOVED into `stateRoot`'s landing queue. This stands in for the daemon's
 *  sweep landing it and the checkout's next refresh: each queued record reaches `root` and leaves the queue. */
export function landQueuedFeedback(stateRoot: string, root: string): string[] {
  const landed = queuedFeedbackLandings(stateRoot);
  for (const rel of landed) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    renameSync(join(stateRoot, "state", "feedback-landing-pending", rel), join(root, rel));
  }
  return landed;
}
