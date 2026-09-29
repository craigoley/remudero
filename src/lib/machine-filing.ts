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
 * {@link renderMachineShard} renders a whole record from a filer's finding, for a filer that has no
 * field order of its own to keep; the others render {@link machineShardHeaderLines} in place.
 * feedback-landing.ts never imports this module: task-linter's import chain reaches it.
 */
import { loadPlanFromYaml, type TaskRisk } from "./plan.js";
import { lintTask } from "./task-linter.js";

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

/** What a filer knows about ONE finding, enough to render its record. */
export interface MachineShardSpec {
  taskId: string;
  title: string;
  /** `<family>:<key>` — the family is what the judge's track record is kept by. */
  origin: string;
  files: readonly string[];
  acceptance: readonly { claim: string; proof: string }[];
  note?: string;
}

/**
 * Render a finding as a single-record shard with the shared header, then parse it back and lint it.
 * `refused` names every blocking lint check; a filer never writes a refused record.
 */
export function renderMachineShard(spec: MachineShardSpec): { text: string; refused?: string } {
  const q = (v: string): string => JSON.stringify(v);
  const text = [
    `- id: ${spec.taskId}`,
    `  title: ${q(spec.title)}`,
    "  repo: remudero",
    "  depends_on: []",
    "  type: implement",
    ...machineShardHeaderLines(spec.files),
    `  origin: ${q(spec.origin)}`,
    "  files:",
    ...spec.files.map((f) => `    - ${f}`),
    "  acceptance:",
    ...spec.acceptance.flatMap((c) => [`    - claim: ${q(c.claim)}`, `      proof: ${q(c.proof)}`]),
    ...(spec.note === undefined ? [] : [`  note: ${q(spec.note)}`]),
    "",
  ].join("\n");
  try {
    const lint = lintTask(loadPlanFromYaml(text, `${spec.taskId}.yaml`).tasks[0]!);
    const blocks = lint.violations.filter((v) => v.severity === "block").map((v) => v.check);
    return blocks.length === 0 ? { text } : { text, refused: blocks.join(", ") };
  } catch (e) {
    return { text, refused: `unparseable: ${(e as Error).message}` };
  }
}
