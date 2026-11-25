import type { WorkerStreamEvent } from "./worker.js";

/** W1-T14037: what one reviewer tool call IS, so the `review.reviewer` row can say how many of each the reviewer made.
 *  `proof_rerun` is a shell call that re-executes a proof the orchestrator already ran and recorded at this head. */
export const REVIEWER_TOOL_KINDS = ["proof_rerun", "bash", "read", "grep", "glob", "other"] as const;
export type ReviewerToolKind = typeof REVIEWER_TOOL_KINDS[number];
export type ReviewerToolCounts = Record<ReviewerToolKind, number>;

/** One proof execution the orchestrator recorded at the reviewed head (argv, never a shell string). */
export interface RecordedProofCommand { command: string; args: readonly string[] }

const SHELL_TOOLS = new Set(["Bash", "command_execution"]);
const READ_TOOLS = new Set(["Read", "read_file"]);

function shellText(input: unknown): string | undefined {
  if (input === null || typeof input !== "object") return undefined;
  const command = (input as { command?: unknown }).command;
  return typeof command === "string" ? command : Array.isArray(command) ? command.filter((c) => typeof c === "string").join(" ") : undefined;
}

/** True when `text` runs the recorded proof: its executable appears as a word and EVERY non-flag argument of the recorded
 *  argv appears in the text. Flags are skipped so a reviewer's own `--test-concurrency` or `-n` still matches; a recorded
 *  argv with no non-flag argument names nothing specific and never matches. */
export function rerunsRecordedProof(text: string, recorded: readonly RecordedProofCommand[]): boolean {
  const words = text.split(/[\s;&|()]+/).map((w) => w.replace(/^['"]|['"]$/g, ""));
  return recorded.some((proof) => {
    const executable = proof.command.split("/").pop() ?? proof.command;
    const specific = proof.args.filter((a) => a.length > 0 && !a.startsWith("-"));
    return specific.length > 0
      && words.some((w) => (w.split("/").pop() ?? w) === executable)
      && specific.every((a) => text.includes(a));
  });
}

/** Classify one reviewer tool call. PURE. */
export function classifyReviewerToolCall(
  toolName: string | undefined,
  toolInput: unknown,
  recorded: readonly RecordedProofCommand[],
): ReviewerToolKind {
  if (toolName !== undefined && SHELL_TOOLS.has(toolName)) {
    const text = shellText(toolInput);
    return text !== undefined && rerunsRecordedProof(text, recorded) ? "proof_rerun" : "bash";
  }
  if (toolName !== undefined && READ_TOOLS.has(toolName)) return "read";
  if (toolName === "Grep") return "grep";
  if (toolName === "Glob") return "glob";
  return "other";
}

/** Counts each kind of tool call a reviewer stream carries. A `tool_use` id seen twice counts once. */
export class ReviewerToolCallCounter {
  private readonly seen = new Set<string>();
  private readonly counts: ReviewerToolCounts = { proof_rerun: 0, bash: 0, read: 0, grep: 0, glob: 0, other: 0 };

  constructor(private readonly recorded: () => readonly RecordedProofCommand[]) {}

  observe(event: Pick<WorkerStreamEvent, "kind" | "toolName" | "toolInput" | "toolUseId">): void {
    if (event.kind !== "tool-executing") return;
    if (event.toolUseId !== undefined) {
      if (this.seen.has(event.toolUseId)) return;
      this.seen.add(event.toolUseId);
    }
    this.counts[classifyReviewerToolCall(event.toolName, event.toolInput, this.recorded())] += 1;
  }

  snapshot(): ReviewerToolCounts { return { ...this.counts }; }
}
