import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { appendLedger } from "./ledger.js";
import { LEDGER_FILENAME } from "./ledger-path.js";

// PRIMARY CONTROL: bound retained identities; exhaustion reports unknown rather than evicting joins.
export const WORKER_TOOL_LINEAGE_MAX_CALLS = 2048;
const PROVIDERS = ["claude", "codex", "cash-chat", "cash-responses", "cash-claude"] as const;
type Provider = typeof PROVIDERS[number] | "unsupported";
const TOOLS = ["Bash", "Read", "Write", "Edit", "MultiEdit", "Glob", "Grep", "WebFetch", "WebSearch", "Task", "Agent",
  "read_file", "write_file", "apply_patch", "list_files", "run_check", "web_search", "command_execution", "file_change", "mcp_tool_call"] as const;
type Tool = typeof TOOLS[number] | "other";
type Result = "success" | "error" | "unknown";
type Reason = "missing-call-id" | "missing-turn-id" | "missing-run-id" | "malformed-payload" | "malformed-outcome"
  | "unsupported-adapter" | "ambiguous-call-id" | "capacity-exceeded" | "duplicate-use" | "duplicate-result"
  | "unmatched-result" | "stream-ended" | "interrupted";

export interface WorkerToolReceipt {
  provider: Provider;
  streamId: string;
  runId: string | null;
  turnId: string | null;
  callId: string | null;
  tool: Tool;
  state: "attempt" | "joined" | "duplicate" | "orphan-result" | "unfinished" | "unsupported";
  result: Result;
  admission: "unknown";
  taskOutcome: "unknown";
  reason?: Reason;
  /** W1-T14037: set only on a reviewer's command receipt; the command text itself is never recorded. */
  commandKind?: ReviewerCommandKind;
}

/** W1-T14037: one proof execution the orchestrator recorded at the reviewed head, as argv (never a shell string). */
export interface RecordedProofCommand { command: string; args: readonly string[]; cwd?: string }
export type ReviewerCommandKind = "proof-rerun" | "test-run" | "read";
export type ReviewerCommandKindCounts = Record<ReviewerCommandKind, number>;

export interface WorkerToolLineageOptions {
  provider: string;
  runId?: string;
  taskId?: string;
  root?: string;
  sink?: (receipt: WorkerToolReceipt) => unknown;
  /** W1-T14037: present only on a reviewer spawn; its command receipts then carry a kind and the lineage counts each. */
  reviewer?: { recordedProofCommands: readonly RecordedProofCommand[]; cwd?: string };
}

const SHELL_OPERATORS = new Set(["&&", "||", ";", "|", "&", "\n"]);
/** One shell word; `raw` when no quote or escape touched it, so only a raw word can be an operator or a redirection. */
type ShellWord = { text: string; raw: boolean };

/** Shell words of `text`, honouring quotes and backslashes; an operator is its own word. Never throws. */
function shellWords(text: string): ShellWord[] {
  const words: ShellWord[] = [];
  let word = "";
  let raw = true;
  let quoted = false;
  const flush = () => { if (word.length > 0 || quoted) words.push({ text: word, raw }); word = ""; raw = true; quoted = false; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "'") {
      const end = text.indexOf("'", i + 1);
      word += text.slice(i + 1, end < 0 ? text.length : end); quoted = true; raw = false; i = end < 0 ? text.length : end;
    } else if (c === "\"") {
      quoted = true; raw = false;
      for (i++; i < text.length && text[i] !== "\""; i++) {
        if (text[i] === "\\" && i + 1 < text.length && "\"\\$`".includes(text[i + 1]!)) i++;
        word += text[i]!;
      }
    } else if (c === "\\" && i + 1 < text.length) {
      if (text[i + 1] !== "\n") { word += text[i + 1]; raw = false; }
      i++;
    } else if (c === "&" && raw && (/[<>]$/.test(word) || text[i + 1] === ">")) word += c;
    else if (c === "\n" || c === ";" || c === "|" || c === "&") {
      flush();
      const two = text.slice(i, i + 2);
      if (two === "&&" || two === "||") { words.push({ text: two, raw: true }); i++; } else words.push({ text: c, raw: true });
    } else if (c === " " || c === "\t" || c === "\r") flush();
    else word += c;
  }
  flush();
  return words;
}

const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** A bare redirection operator, whose target is the next word; and one that carries its own target (`2>&1`, `>/dev/null`). */
const REDIRECT_RE = /^(\d*|&)(>>?|<)$/;
const REDIRECT_WITH_TARGET_RE = /^(\d*|&)(>>?|<)\S+$/;
const WRAPPERS = new Set(["env", "exec", "command", "time", "nice", "nohup"]);
const SHELLS = new Set(["bash", "sh", "zsh", "dash"]);

function base(path: string): string { return path.split("/").pop() ?? path; }

/** The simple commands of a shell text as argv: wrappers, assignments and redirections dropped, `bash -c '…'` unwrapped. */
function simpleCommands(text: string, depth = 0): string[][] {
  const commands: string[][] = [];
  let argv: string[] = [];
  const end = () => {
    while (argv.length > 0 && (ASSIGNMENT_RE.test(argv[0]!) || WRAPPERS.has(argv[0]!))) argv.shift();
    const flagged = argv.length >= 3 && SHELLS.has(base(argv[0]!)) ? argv.slice(1).findIndex((a) => /^-[a-z]*c[a-z]*$/.test(a)) : -1;
    if (flagged >= 0 && depth < 2 && argv[flagged + 2] !== undefined) commands.push(...simpleCommands(argv[flagged + 2]!, depth + 1));
    else if (argv.length > 0) commands.push(argv);
    argv = [];
  };
  const words = shellWords(text);
  for (let i = 0; i < words.length; i++) {
    const { text: word, raw } = words[i]!;
    if (raw && SHELL_OPERATORS.has(word)) end();
    else if (raw && REDIRECT_RE.test(word)) i++;
    else if (!raw || !REDIRECT_WITH_TARGET_RE.test(word)) argv.push(word);
  }
  end();
  return commands;
}

/** One argv word with the reviewer's own cwd (or the recorded execution's) stripped, so a path names the same file. */
function normalWord(word: string, roots: readonly string[]): string {
  for (const root of roots) {
    if (root.length > 1 && word.startsWith(`${root.replace(/\/+$/, "")}/`)) return word.slice(root.replace(/\/+$/, "").length + 1);
  }
  return word.startsWith("./") && word.length > 2 ? word.slice(2) : word;
}

function sameArgv(argv: readonly string[], proof: RecordedProofCommand, cwd: string | undefined): boolean {
  const roots = [cwd, proof.cwd].filter((r): r is string => typeof r === "string");
  if (argv.length !== proof.args.length + 1 || base(argv[0]!) !== base(proof.command)) return false;
  return proof.args.every((arg, i) => normalWord(argv[i + 1]!, roots) === normalWord(arg, roots));
}

function isTestRun(argv: readonly string[]): boolean {
  if (argv.some((a) => base(a) === "node" || base(a) === "tsx") && argv.some((a) => a === "--test" || a.startsWith("--test="))) {
    return true;
  }
  return argv.some((a) => /^vitest(\.m?js)?$/.test(base(a)));
}

/** W1-T14037: what one reviewer shell command IS. `proof-rerun` when one of its simple commands has the same argv as a
 *  proof execution the orchestrator recorded (modulo the reviewer's own cwd); `test-run` for another `node --test` or
 *  vitest invocation; `read` for everything else. PURE, and never throws. */
export function classifyReviewerCommand(
  commandText: string,
  recordedProofCommands: readonly RecordedProofCommand[],
  cwd?: string,
): ReviewerCommandKind {
  const commands = simpleCommands(commandText);
  if (commands.some((argv) => recordedProofCommands.some((proof) => sameArgv(argv, proof, cwd)))) return "proof-rerun";
  return commands.some(isTestRun) ? "test-run" : "read";
}

/** A Codex `item.command` as shell text: a string as-is, an argv array quoted word by word. */
function shellTextOf(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) return undefined;
  return (value as string[]).map((v) => /^[\w@%+=:,./-]+$/.test(v) ? v : `'${v.replace(/'/g, "'\\''")}'`).join(" ");
}

type Delivery = { state: "unavailable" | "written" | "pending" }
  | { state: "failed"; reason: "sink-threw" | "normalization-threw"; errorClass: "TypeError" | "Error" | "non-error" };
type Call = { turnId: string; tool: Tool; completed: boolean; ambiguous: boolean; commandKind?: ReviewerCommandKind };
type Metadata = { kind: "use" | "result"; id: unknown; turnId?: unknown; name?: unknown; result?: Result; reason?: Reason;
  commandKind?: ReviewerCommandKind };

function encoded(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 4096
    ? createHash("sha256").update(value).digest("hex") : null;
}

function tool(value: unknown): Tool {
  return TOOLS.includes(value as Tool & typeof TOOLS[number]) ? value as Tool : "other";
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function errorClass(error: unknown): "TypeError" | "Error" | "non-error" {
  return error instanceof TypeError ? "TypeError" : error instanceof Error ? "Error" : "non-error";
}

function kindOf(call: Call): { commandKind?: ReviewerCommandKind } {
  return call.commandKind === undefined ? {} : { commandKind: call.commandKind };
}

function resultOf(value: unknown): Result {
  return value === true ? "error" : value === false || value === undefined ? "success" : "unknown";
}

export class WorkerToolLineage {
  readonly provider: Provider;
  readonly streamId = randomUUID();
  delivery: Delivery = { state: "unavailable" };
  private readonly runId: string | null;
  private readonly calls = new Map<string, Map<string, Call>>();
  private callCount = 0;
  private readonly sink?: WorkerToolLineageOptions["sink"];
  private codexTurn = 0;
  private codexTurnActive = false;
  private closed = false;
  private readonly reviewer?: { recordedProofCommands: readonly RecordedProofCommand[]; cwd?: string };
  private readonly kindCounts?: ReviewerCommandKindCounts;

  constructor(options: WorkerToolLineageOptions) {
    this.provider = PROVIDERS.includes(options.provider as typeof PROVIDERS[number]) ? options.provider as Provider : "unsupported";
    if (options.reviewer) {
      const recordedProofCommands = options.reviewer.recordedProofCommands.map((proof) => ({ ...proof, args: [...proof.args] }));
      this.reviewer = { recordedProofCommands, ...(options.reviewer.cwd === undefined ? {} : { cwd: options.reviewer.cwd }) };
      this.kindCounts = { "proof-rerun": 0, "test-run": 0, read: 0 };
    }
    this.runId = encoded(options.runId);
    const taskId = encoded(options.taskId);
    this.sink = options.sink ?? (options.root ? receipt => appendLedger(join(options.root!, "state", LEDGER_FILENAME), {
      run_id: this.runId ?? "unattributed",
      task_id: taskId ?? "unattributed",
      step: "worker.tool_lineage",
      tool_lineage: receipt,
    }) : undefined);
  }

  private emit(fields: Pick<WorkerToolReceipt, "state"> & Partial<WorkerToolReceipt>): void {
    const receipt: WorkerToolReceipt = {
      provider: this.provider, streamId: this.streamId, runId: this.runId, turnId: null, callId: null,
      tool: "other", result: "unknown", admission: "unknown", taskOutcome: "unknown", ...fields,
    };
    if (!this.sink) return;
    try {
      const pending = this.sink(receipt);
      if (pending instanceof Promise) {
        if (this.delivery.state !== "failed") this.delivery = { state: "pending" };
        void pending.then(() => {
          if (this.delivery.state !== "failed") this.delivery = { state: "written" };
        }, error => { this.delivery = { state: "failed", reason: "sink-threw", errorClass: errorClass(error) }; });
      } else if (this.delivery.state !== "failed") this.delivery = { state: "written" };
    } catch (error) {
      this.delivery = { state: "failed", reason: "sink-threw", errorClass: errorClass(error) };
    }
  }

  /** W1-T14037: the per-kind count of this reviewer's command calls; `undefined` when the spawn is not a reviewer's. */
  commandKinds(): ReviewerCommandKindCounts | undefined {
    return this.kindCounts ? { ...this.kindCounts } : undefined;
  }

  private classify(command: unknown): ReviewerCommandKind | undefined {
    if (!this.reviewer) return undefined;
    return classifyReviewerCommand(shellTextOf(command) ?? "", this.reviewer.recordedProofCommands, this.reviewer.cwd);
  }

  /** Counts one command call (never a duplicate of a use already seen) and returns its receipt field. */
  private counted(kind: ReviewerCommandKind | undefined): { commandKind?: ReviewerCommandKind } {
    if (kind === undefined || !this.kindCounts) return {};
    this.kindCounts[kind]++;
    return { commandKind: kind };
  }

  private accept(meta: Metadata): void {
    const callId = encoded(meta.id);
    const turnId = encoded(meta.turnId);
    if (!this.runId || !callId || (meta.kind === "use" && !turnId)) {
      this.emit({ state: "unsupported", callId, turnId, tool: tool(meta.name),
        reason: !this.runId ? "missing-run-id" : !callId ? "missing-call-id" : "missing-turn-id",
        ...(meta.kind === "use" ? this.counted(meta.commandKind) : {}) });
      return;
    }
    const variants = this.calls.get(callId);
    const existing = turnId ? variants?.get(turnId) : variants?.size === 1 ? variants.values().next().value : undefined;
    if (meta.kind === "use") {
      if (existing) {
        if (existing.tool !== tool(meta.name)) existing.ambiguous = true;
        const kind = existing.commandKind ?? meta.commandKind;
        this.emit({ state: existing.ambiguous ? "unsupported" : "duplicate", callId, turnId,
          tool: tool(meta.name), reason: existing.ambiguous ? "ambiguous-call-id" : "duplicate-use",
          ...(kind === undefined ? {} : { commandKind: kind }) });
      } else if (this.callCount >= WORKER_TOOL_LINEAGE_MAX_CALLS) {
        this.emit({ state: "unsupported", callId, turnId, reason: "capacity-exceeded", ...this.counted(meta.commandKind) });
      } else {
        const turns = variants ?? new Map<string, Call>();
        turns.set(turnId!, { turnId: turnId!, tool: tool(meta.name), completed: false, ambiguous: false,
          ...(meta.commandKind === undefined ? {} : { commandKind: meta.commandKind }) });
        this.calls.set(callId, turns);
        this.callCount++;
        this.emit({ state: "attempt", callId, turnId, tool: tool(meta.name), ...this.counted(meta.commandKind) });
      }
      return;
    }
    if (meta.turnId === undefined && variants && variants.size > 1) {
      this.emit({ state: "unsupported", callId, reason: "ambiguous-call-id" });
    } else if (!existing || (meta.turnId !== undefined && existing.turnId !== turnId)) {
      this.emit({ state: "orphan-result", runId: null, callId, reason: "unmatched-result" });
    } else if (existing.ambiguous) {
      this.emit({ state: "unsupported", callId, reason: "ambiguous-call-id" });
    } else if (existing.completed) {
      this.emit({ state: "duplicate", callId, turnId: existing.turnId, tool: existing.tool, reason: "duplicate-result",
        ...kindOf(existing) });
    } else {
      existing.completed = true;
      this.emit({ state: "joined", callId, turnId: existing.turnId, tool: existing.tool,
        result: meta.result, ...(meta.result === "unknown" ? { reason: meta.reason ?? "malformed-outcome" } : {}),
        ...kindOf(existing) });
    }
  }

  observe(raw: unknown): void {
    if (this.closed) return;
    try {
      const event = record(raw);
      if (this.provider === "unsupported") {
        this.emit({ state: "unsupported", reason: "unsupported-adapter" });
      } else if (!event) {
        this.emit({ state: "unsupported", reason: "malformed-payload" });
      } else if (this.provider === "claude") {
        if (event.type !== "assistant" && event.type !== "user") return;
        const message = record(event.message);
        const content = message?.content;
        if (typeof content === "string" && event.type === "user") return;
        if (!Array.isArray(content)) {
          this.emit({ state: "unsupported", reason: "malformed-payload" });
          return;
        }
        for (const value of content) {
          const block = record(value);
          if (event.type === "assistant" && block?.type === "tool_use") {
            this.accept({ kind: "use", id: block.id, turnId: message?.id, name: block.name,
              commandKind: block.name === "Bash" ? this.classify(record(block.input)?.command) : undefined });
          } else if (event.type === "user" && block?.type === "tool_result") {
            this.accept({ kind: "result", id: block.tool_use_id, result: resultOf(block.is_error) });
          } else if (!block) this.emit({ state: "unsupported", reason: "malformed-payload" });
        }
      } else if (this.provider === "codex") {
        if (event.type === "turn.started") { this.codexTurn++; this.codexTurnActive = true; }
        if (event.type === "turn.completed" || event.type === "turn.failed") this.codexTurnActive = false;
        const item = record(event.item);
        if (event.type !== "item.started" && event.type !== "item.completed") return;
        if (!item) { this.emit({ state: "unsupported", reason: "malformed-payload" }); return; }
        if (!["command_execution", "file_change", "web_search", "mcp_tool_call"].includes(item.type as string)) return;
        const turnId = this.codexTurnActive ? String(this.codexTurn) : undefined;
        const outcome = item.status === "failed" || record(item.error) ||
          (typeof item.exit_code === "number" && item.exit_code !== 0) ? "error"
          : item.status === "completed" && (item.type !== "command_execution" || item.exit_code === 0) ? "success" : "unknown";
        this.accept({ kind: event.type === "item.started" ? "use" : "result", id: item.id, turnId, name: item.type, result: outcome,
          commandKind: event.type === "item.started" && item.type === "command_execution" ? this.classify(item.command) : undefined });
      } else if (event.type === "tool_use" || event.type === "tool_result") {
        this.accept({ kind: event.type === "tool_use" ? "use" : "result", id: event.type === "tool_use" ? event.id : event.tool_use_id,
          turnId: event.turnId, name: event.name, result: resultOf(event.is_error) });
      }
    } catch (error) {
      this.emit({ state: "unsupported", reason: "malformed-payload" });
      this.delivery = { state: "failed", reason: "normalization-threw", errorClass: errorClass(error) };
    }
  }

  finish(reason: "stream-ended" | "interrupted"): void {
    if (this.closed) return;
    this.closed = true;
    for (const [callId, turns] of this.calls) {
      for (const call of turns.values()) {
        if (!call.completed) this.emit({ state: "unfinished", callId, turnId: call.turnId, tool: call.tool, reason, ...kindOf(call) });
      }
    }
    this.calls.clear();
  }
}

export function createWorkerToolLineage(options: WorkerToolLineageOptions): WorkerToolLineage {
  return new WorkerToolLineage(options);
}

export function observeWorkerToolLineage(observer: WorkerToolLineage, raw: unknown): void {
  observer.observe(raw);
}
