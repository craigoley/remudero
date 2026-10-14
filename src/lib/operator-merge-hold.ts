import { gatherActorEvidence, realActorEvidenceProbe, type ActorEvidenceProbe } from "./actor-evidence.js";
import { unknownArgError } from "./cli-args.js";
import { appendLedger, type LedgerLine } from "./ledger.js";
import { automergeHoldFromLedger, type AutomergeHold, type MergeHoldActor } from "./review.js";
import { readLedgerLines } from "./status.js";

export type OperatorMergeHoldAction = "engage" | "release";

/**
 * The only two paths that can create a durable human merge hold.  `operator` is
 * an execution-context label, not proof that a person made a decision: a
 * worker or a scheduled shell command can invoke the CLI with any `--by`
 * string.  The authority is therefore written with the decision and consumed
 * by the production hold reader before it can block an unattended merge.
 * `agent-cli` (W1-T7721) is an agent's own declared write: it is recorded for audit and is NEVER read as a
 * confirmed human authority by `automergeHoldFromLedger`.
 */
export type OperatorMergeHoldAuthority = "interactive-cli" | "console-confirmed" | "agent-cli";

export interface OperatorMergeHoldInput {
  action: OperatorMergeHoldAction;
  by: string;
  reason: string;
  authority: OperatorMergeHoldAuthority;
  /** Omitted means the whole fleet. */
  prNumber?: number;
  /** Optional board enrichment. The hold decision itself is scoped by prNumber, never this id. */
  taskId?: string;
}

export type ParsedOperatorMergeHold =
  | { ok: true; input: OperatorMergeHoldInput }
  | { ok: false; error: string };

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

/** Strict, side-effect-free parser for `rmd merge-hold`. */
export function parseOperatorMergeHoldArgs(args: string[]): ParsedOperatorMergeHold {
  const action = args[0];
  if (action !== "engage" && action !== "release") {
    return { ok: false, error: "the first argument must be `engage` or `release`" };
  }

  const tail = args.slice(1);
  const unknown = unknownArgError("merge-hold", tail, ["--pr", "--task", "--by", "--reason"], ["--confirm"]);
  if (unknown) return { ok: false, error: unknown };

  const by = flagValue(tail, "--by")?.trim();
  if (!by || by.startsWith("--")) return { ok: false, error: "--by <name> is required" };
  const reason = flagValue(tail, "--reason")?.trim();
  if (!reason || reason.startsWith("--")) return { ok: false, error: "--reason <text> is required" };

  const prRaw = flagValue(tail, "--pr");
  let prNumber: number | undefined;
  if (prRaw !== undefined) {
    prNumber = Number(prRaw);
    if (!/^\d+$/.test(prRaw) || !Number.isSafeInteger(prNumber) || prNumber <= 0) {
      return { ok: false, error: `--pr must be a positive integer, got ${JSON.stringify(prRaw)}` };
    }
  }

  const taskId = flagValue(tail, "--task")?.trim();
  if (taskId && !/^W1-T\d+$/.test(taskId)) {
    return { ok: false, error: `--task must be a W1-T<n> id, got ${JSON.stringify(taskId)}` };
  }
  if (taskId && prNumber === undefined) {
    return { ok: false, error: "--task is valid only with a PR-scoped hold (`--pr <n>`)" };
  }
  if (!tail.includes("--confirm")) {
    return { ok: false, error: "--confirm is required; an unattended process cannot create a human merge hold" };
  }

  return {
    ok: true,
    input: {
      action,
      by,
      reason,
      authority: "interactive-cli",
      ...(prNumber !== undefined ? { prNumber } : {}),
      ...(taskId ? { taskId } : {}),
    },
  };
}

export type MergeHoldActorProbe = ActorEvidenceProbe;
export const realMergeHoldActorProbe = realActorEvidenceProbe;

/** A probe describing a person at a real terminal: no agent markers, no container. Used where a caller has already
 *  injected its own terminal check and so must not inherit THIS process's environment. */
export function humanTerminalActorProbe(): MergeHoldActorProbe {
  return { ...realMergeHoldActorProbe(), env: {}, containerId: () => undefined, stdinIsTTY: () => true, parents: () => [] };
}

/** Evidence gathered by the writer (stored on the row as `hold_actor`: the ledger already stamps its own string `actor`), never typed by the caller. A caller is an agent when a marker is present or it
 *  runs inside a container. */
export function gatherMergeHoldActor(probe: MergeHoldActorProbe = realMergeHoldActorProbe()): MergeHoldActor {
  const { caller_class: _class, ssh: _ssh, claimed_session_id: _claim, ...actor } = gatherActorEvidence(probe);
  return actor;
}

/** Decide whether `actor` may write `input`, and under which authority. An agent that names a human is refused; an
 *  agent that declares itself (`--by agent:<session>`) writes `agent-cli`, which no reader treats as a human hold. */
export function authorizeMergeHoldWrite(
  input: OperatorMergeHoldInput,
  actor: MergeHoldActor,
): { ok: true; input: OperatorMergeHoldInput } | { ok: false; error: string } {
  const declaresAgent = /^agent:\S+/.test(input.by);
  if (actor.kind === "agent" && !declaresAgent) {
    const evidence = [
      actor.agent_markers.length > 0 ? `agent markers ${actor.agent_markers.join(",")}` : undefined,
      actor.container_id ? `container ${actor.container_id}` : undefined,
    ].filter(Boolean).join("; ");
    return {
      ok: false,
      error:
        `refusing --by ${JSON.stringify(input.by)} from a non-human caller (${evidence}) — an agent must sign as ` +
        `--by agent:<session>; a human hold is set from a real terminal outside any agent session or container`,
    };
  }
  if (!declaresAgent) return { ok: true, input };
  if (input.action === "release") {
    return { ok: false, error: "an agent identity cannot release a hold — only a confirmed human can" };
  }
  return { ok: true, input: { ...input, authority: "agent-cli" } };
}

export interface OperatorMergeHoldResult {
  action: OperatorMergeHoldAction;
  scope: string;
  written: boolean;
  prior?: AutomergeHold;
  current?: AutomergeHold;
}

export interface OperatorMergeHoldDeps {
  readLedger?: (path: string) => Array<Record<string, unknown>>;
  appendLedger?: (path: string, line: LedgerLine) => void;
  now?: () => number;
  /** W1-T7721 — the writer-gathered actor, recorded beside the claimed `by`. */
  actor?: MergeHoldActor;
}

/**
 * Append one durable operator decision and read it back through the same production reader every
 * arm site uses. A release of an already-clear scope is an idempotent no-op, not a misleading row.
 */
export function applyOperatorMergeHold(
  ledgerPath: string,
  input: OperatorMergeHoldInput,
  deps: OperatorMergeHoldDeps = {},
): OperatorMergeHoldResult {
  const read = deps.readLedger ?? ((path: string) => readLedgerLines(path));
  const append = deps.appendLedger ?? appendLedger;
  const scopeProbe = input.prNumber ?? -1;
  const scope = input.prNumber === undefined ? "the whole fleet" : `PR #${input.prNumber}`;
  const prior = automergeHoldFromLedger(read(ledgerPath), scopeProbe);

  if (input.action === "release" && !prior) {
    return { action: input.action, scope, written: false };
  }

  const step = input.action === "engage" ? "automerge.hold_engaged" : "automerge.hold_released";
  append(ledgerPath, {
    run_id: `OPERATOR-MERGE-HOLD-${(deps.now ?? Date.now)()}`,
    task_id: input.taskId ?? (input.prNumber === undefined ? "FLEET" : `PR-${input.prNumber}`),
    step,
    lane: "operator",
    by: input.by,
    reason: input.reason,
    authority: input.authority,
    ...(deps.actor ? { hold_actor: deps.actor } : {}),
    ...(input.prNumber !== undefined ? { pr_number: input.prNumber } : {}),
  });

  const current = automergeHoldFromLedger(read(ledgerPath), scopeProbe);
  // An agent-cli row is audit-only: the reader must leave the standing decision exactly as it was.
  const expected = input.authority === "agent-cli"
    ? prior
    : input.action === "engage"
      ? { by: input.by, reason: input.reason, ...(deps.actor ? { actor: deps.actor } : {}) }
      : undefined;
  if (JSON.stringify(current) !== JSON.stringify(expected)) {
    throw new Error(
      `merge-hold write did not become the current decision for ${scope}; requested=${JSON.stringify(expected)} observed=${JSON.stringify(current)}`,
    );
  }

  return { action: input.action, scope, written: true, prior, current };
}
