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

/** The operator's own priority band: machine work competes inside it, never behind it (2026-09-30:
 *  a 1..90 cost scale sorted every priced release behind all operator work, which sits at 0–4). */
export const MACHINE_PRIORITY_BAND = { top: 1, bottom: 4 } as const;

/** Where released work with no measured cost dispatches: the middle of the band. */
export const UNPRICED_PRIORITY = (MACHINE_PRIORITY_BAND.top + MACHINE_PRIORITY_BAND.bottom) / 2;

/**
 * Dispatch priority from the cost a filer measured, by its QUANTILE among the costs the same filer
 * priced in the same pass (lower dispatches sooner): the costliest lands at the band's top, beside
 * operator priority-1 work, the cheapest at its bottom, ties share a rank, and a finding with no
 * peers to compare against sits mid-band. Relative, so no cost is a threshold and the scale follows
 * whatever the filer measures, minutes or occurrences, without mixing the two.
 */
export function costPriority(cost: number, population: readonly number[] = [cost]): number {
  const n = population.length;
  if (n < 2) return UNPRICED_PRIORITY;
  const below = population.filter((c) => c < cost).length;
  const ties = population.filter((c) => c === cost).length;
  const q = Math.min(1, (below + Math.max(0, ties - 1) / 2) / (n - 1));
  const { top, bottom } = MACHINE_PRIORITY_BAND;
  return Math.round((bottom - (bottom - top) * q) * 100) / 100;
}

/** The header lines every machine filer renders, in the order the shard files already use. */
export function machineShardHeaderLines(files: readonly string[], cost?: number, population?: readonly number[]): string[] {
  const risk = machineShardRisk(files);
  return [
    "  verify: human",
    `  risk: ${risk}`,
    ...(risk === "high" ? ["  band_meaning: blast-radius"] : []),
    ...(cost === undefined ? [] : [`  priority: ${costPriority(cost, population)}`]),
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
  /** The finding's measured cost (PR-minutes or occurrences), which sets its dispatch priority. */
  cost?: number;
  /** Every cost the filer priced in the same pass, which ranks `cost` ({@link costPriority}). */
  costPopulation?: readonly number[];
  /** The evidence the worker builds from, one line each, rendered as a `rationale: |` block. */
  rationale?: readonly string[];
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
    ...machineShardHeaderLines(spec.files, spec.cost, spec.costPopulation),
    `  origin: ${q(spec.origin)}`,
    "  files:",
    ...spec.files.map((f) => `    - ${f}`),
    "  acceptance:",
    ...spec.acceptance.flatMap((c) => [`    - claim: ${q(c.claim)}`, `      proof: ${q(c.proof)}`]),
    ...(spec.note === undefined ? [] : [`  note: ${q(spec.note)}`]),
    ...(spec.rationale === undefined ? [] : ["  rationale: |", ...spec.rationale.map((line) => (line === "" ? "" : `    ${line}`))]),
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

// ── The deterministic backstop (operator ruling 2026-09-29, DECISIONS.md) ─────────────────────
// Irreversible work escalates before any model reads it. Measured 2026-09-29: sonnet released a
// ledger-archive deletion and haiku released "delete every merged branch". A wrong release there
// cannot be undone by closing a PR, so no confidence score may carry it past a person.

const MERGE_POLICY_PATH = /(^|\/)[^/]*(auto-?merge|merge-queue|branch-protection|rulesets?)[^/]*$/i;
const BACKSTOP_TEXT: readonly [string, RegExp][] = [
  ["deletes data, branches, archives or ledgers",
    /\b(delet\w*|remov\w*|truncat\w*|purg\w*|prun\w*|drop\w*|wipe\w*|eras\w*|reap\w*|overwrit\w*)\b[^.;\n]{0,80}?\b(branch(es)?|archives?|ledgers?|data|history|rows?|databases?|backups?|proposals?|tags?|refs?|state|records?)\b/i],
  ["takes an irreversible action", /\b(force[- ]push\w*|rewrite (git )?history|reset --hard|irreversibl\w*|permanently)\b/i],
  ["touches secrets, auth, tokens or permissions",
    /\b(secrets?|credentials?|api[ _-]?keys?|passwords?|private keys?|tokens?|permissions?|oauth|auth|authenticat\w*|authoriz\w*)\b/i],
  ["changes merge, deploy or branch-protection policy",
    /\b(auto-?merge|branch[- ]protection|merge[- ]queue|required (status )?checks?|rulesets?|(merge|deploy(ment)?|review) policy|(bypass\w*|disabl\w*)\b[^.;\n]{0,40}\b(reviews?|gates?|checks?))\b/i],
];

/** Why a record must go to a person whatever a judge would say, or undefined. Reads what the record
 *  will DO — title, prompt, acceptance claims and declared paths — never its narrative note. */
export function deterministicEscalation(task: {
  title: string;
  prompt?: string;
  files?: readonly string[];
  acceptance?: readonly { claim?: string }[];
}): string | undefined {
  const path = (task.files ?? []).find((f) => SENSITIVE_SURFACE.test(f) || MERGE_POLICY_PATH.test(f));
  if (path) return `it declares ${path}, a secrets, auth, CI, deploy, merge-policy or ruling path`;
  const text = [task.title, task.prompt ?? "", ...(task.acceptance ?? []).map((c) => c.claim ?? "")].join("\n");
  for (const [why, re] of BACKSTOP_TEXT) {
    const hit = re.exec(text);
    if (hit) return `it ${why} ("${hit[0].trim()}")`;
  }
  return undefined;
}
