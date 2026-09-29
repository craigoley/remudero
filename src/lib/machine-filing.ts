/**
 * lib/machine-filing.ts — the ONE header every machine filer writes (operator ruling 2026-09-29).
 *
 * Four filers (ci-friction, selector-shadow, the CI-learning rung, and the feedback landing that
 * carries its drafts) each hard-coded `verify: human` and a `risk:` constant. The operator's words:
 * "Why are they verifying human risk high? They shouldn't be. There should be an LLM judge in the
 * middle deciding what needs that level of escalation and what can be automated."
 *
 * So a filer no longer decides either field. `verify: human` here means UNJUDGED, not "needs a
 * person": machine-filing-judge.ts rules on every such record and releases it to `verify: auto`
 * on proceed. `risk:` is read from what the finding touches, not from which gardener filed it.
 *
 * A LEAF, importing types only: feedback-landing.ts and measurement-cadence.ts sit on the
 * task-linter import chain, and the judge module imports task-linter.
 */
import type { TaskRisk } from "./plan.js";

/** Paths whose change is dangerous whoever makes it: secrets and credentials, auth and permissions,
 *  CI and deploy machinery, the worker settings, and the operator's own policy and rulings. */
const SENSITIVE_SURFACE = new RegExp(
  [
    String.raw`(^|/)\.github/`,
    String.raw`(^|/)\.claude/`,
    String.raw`(^|/)settings/`,
    String.raw`(^|/)(deploy|infra|docker)[^/]*(/|$)`,
    String.raw`Dockerfile`,
    String.raw`(^|[/._-])(secrets?|credentials?|tokens?|auth|permissions?)([/._-]|$)`,
    String.raw`^plan/policy\.yaml$`,
    String.raw`^(DECISIONS|CLAUDE)\.md$`,
  ].join("|"),
  "i",
);

/** The honest band for a machine-filed record: `high` only when it declares a sensitive path. */
export function machineShardRisk(files: readonly string[]): TaskRisk {
  return files.some((f) => SENSITIVE_SURFACE.test(f)) ? "high" : "low";
}

/** The header lines every machine filer renders, in the order the shard files already use. */
export function machineShardHeaderLines(files: readonly string[]): string[] {
  const risk = machineShardRisk(files);
  return [
    "  verify: human",
    `  risk: ${risk}`,
    ...(risk === "high" ? ["  band_meaning: blast-radius"] : []),
    "  status: queued",
    "  attempts: 0",
    "  author_class: machine",
  ];
}
