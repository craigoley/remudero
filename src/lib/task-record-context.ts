/**
 * W1-T14795: the task-record line of an implement prompt's CONTEXT block.
 *
 * A public-catalog task's record is in the worker's own tree, so the line points at it (the text
 * `taskRecordContextLine` in run-task-verb always rendered, moved here unchanged). An ops-catalog
 * task's record is not: its path is the ops blob label `tasks.d/<file>`, relative to the PRIVATE
 * repo's plan/, so the pointer named a file the worker could never open and no design, files or
 * proofs reached it. For that task the contract review and fix already inline
 * ({@link catalogTaskContract}) is rendered in place of the pointer.
 */
import type { AcceptanceCriterion } from "./plan.js";
import { citation } from "./provenance.js";
import { catalogTaskContract, type CatalogTaskContract, type TaskLookupResult } from "./task-lookup.js";

/** {@link CatalogTaskContract} plus the record fields an implement worker needs and review does not.
 *  `taskFalsifier` renders when supplied; the plan loader does not yet keep a record's `falsifier:`. */
export type TaskRecordContract = CatalogTaskContract & { taskTitle: string; taskFalsifier?: string };

/** The inline contract for an ops-catalog hit; `undefined` (keep the pointer) for every other lookup. */
export function opsTaskRecordContract(lookup: TaskLookupResult): TaskRecordContract | undefined {
  if (lookup.outcome !== "found" || lookup.catalog !== "ops") return undefined;
  return { ...catalogTaskContract(lookup), taskTitle: lookup.task.title };
}

export interface TaskRecordContextInput {
  taskId: string;
  recordPath: string | undefined;
  criteria?: ReadonlyArray<AcceptanceCriterion>;
  contract?: TaskRecordContract;
}

/** Which form {@link renderTaskRecordContext} delivers for this contract (the `prompt.linted` row's `record_delivery`). */
export function taskRecordDelivery(contract: TaskRecordContract | undefined): "pointer" | "inline" {
  return contract?.taskCatalog === "ops" ? "inline" : "pointer";
}

export function renderTaskRecordContext({ taskId, recordPath, criteria = [], contract }: TaskRecordContextInput): string {
  if (contract !== undefined && taskRecordDelivery(contract) === "inline") return inlineContract(taskId, contract);
  if (!recordPath) return "";
  const rendered = criteria.map(
    (c, i) => `    (${String.fromCharCode(97 + i)}) ${c.claim}\n        proof: ${c.proof}`,
  );
  return (
    `- YOUR TASK'S OWN RECORD IS AT ${recordPath} — READ IT FIRST. It carries the design, ` +
    "rationale and acceptance criteria that recon would otherwise have relayed, and nothing " +
    `else in this prompt contains them. ${citation(`plan#${taskId}`)}` +
    (rendered.length ? `\n    Acceptance criteria, verbatim from that record:\n${rendered.join("\n")}` : "")
  );
}

// The provenance linter reads CONTEXT as blocks: a blank line or a bullet starts a new (uncited) claim
// and a heading ends CONTEXT. Every record text line is therefore carried behind a `| ` gutter, so the
// whole contract stays one claim under the citation on its first line.
function gutter(text: string, indent: string): string[] {
  return text.replace(/\n+$/, "").split("\n").map((line) => `${indent}| ${line}`.trimEnd());
}

function inlineContract(taskId: string, contract: TaskRecordContract): string {
  const lines = [
    `- YOUR TASK'S OWN CONTRACT, verbatim from its ops-catalog record (that record is not in your ` +
      `worktree; nothing else in this prompt contains it). ${citation(`plan#${taskId}`)}`,
    "    Title:",
    ...gutter(contract.taskTitle, "      "),
    "    Files:",
    ...(contract.taskDeclaredFiles ?? []).map((file) => `      | ${file}`),
    "    Acceptance criteria:",
    ...contract.criteria.flatMap((c, i) => [
      `    (${String.fromCharCode(97 + i)}) ${c.claim.replace(/\n/g, " ")}`,
      `        proof: ${c.proof.replace(/\n/g, " ")}`,
    ]),
  ];
  const design = contract.taskNarrative?.design;
  if (typeof design === "string") lines.push("    Design:", ...gutter(design, "      "));
  if (contract.taskFalsifier !== undefined) lines.push("    Falsifier:", ...gutter(contract.taskFalsifier, "      "));
  lines.push(
    `    Proof labels: a proof of the form \`grep: ${taskId} criterion N in <test>\` means the test ` +
      `proving criterion N must be titled "${taskId} criterion N: ...".`,
  );
  return lines.join("\n");
}
