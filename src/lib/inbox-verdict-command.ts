/**
 * `rmd decline <proposalId> --reason "<text>"` and `rmd restore <proposalId> --reason "<text>"` — the terminal's
 * route to the two inbox verdicts the console already had (`POST /v1/inbox/decline`, `POST /v1/inbox/restore`).
 * Before this, an operator in a terminal could approve a proposal but decline one only through the console or a
 * hand-written curl carrying a write token. Both routes and both commands go through {@link applyProposalVerdict},
 * so what refuses and what is recorded is one decision, not two copies of it.
 */
import { flagValue, unknownArgError } from "./cli-args.js";
import { applyProposalVerdict, type InboxClassification, type ProposalVerdictKind } from "./inbox.js";
import type { WriteTier } from "./service.js";

export type InboxVerbName = "approve" | "decline" | "restore" | "reframe" | "reply" | "archive" | "snooze" | "keep";
export type InboxVerbActor = { origin: string; operator?: string };
export type InboxVerbRespond = (status: number, body: unknown, headers?: Record<string, string>) => void;
export type InboxVerbAction = (body: unknown, actor: InboxVerbActor, respond: InboxVerbRespond) => void | Promise<void>;
export type InboxVerbActions = Record<InboxVerbName, InboxVerbAction>;
type InputField = { type: string | string[]; minLength?: number; maxLength?: number; pattern?: string };
interface InboxVerbSpec {
  name: InboxVerbName;
  path: string;
  tier: WriteTier;
  tool?: string;
  syntax: string;
  summary: string;
  properties: Record<string, InputField>;
  required: string[];
  flags: Record<string, { field: string; value?: boolean | null }>;
}

function verb(spec: InboxVerbSpec) {
  return { ...spec, perform: (actions: InboxVerbActions, body: unknown, actor: InboxVerbActor, respond: InboxVerbRespond) =>
    actions[spec.name](body, actor, respond) };
}

const proposalId: InputField = { type: "string", minLength: 1 };
const text: InputField = { type: "string", minLength: 1 };
export const INBOX_VERBS = [
  verb({ name: "approve", path: "/v1/inbox/approve", tier: "high", syntax: "rmd approve <P##> [<P##> ...]",
    summary: "Ratify READY proposals through the plan gate.", properties: { proposalId }, required: ["proposalId"], flags: {} }),
  verb({ name: "decline", path: "/v1/inbox/decline", tier: "low", tool: "decline_proposal", syntax: 'rmd decline <proposalId> --reason "<text>"',
    summary: "Decline a proposal with a recorded reason.", properties: { proposalId, reason: text }, required: ["proposalId", "reason"], flags: { "--reason": { field: "reason" } } }),
  verb({ name: "restore", path: "/v1/inbox/restore", tier: "low", tool: "restore_proposal", syntax: 'rmd restore <proposalId> --reason "<text>"',
    summary: "Take back a proposal decline.", properties: { proposalId, reason: text }, required: ["proposalId", "reason"], flags: { "--reason": { field: "reason" } } }),
  verb({ name: "reframe", path: "/v1/inbox/reframe", tier: "low", tool: "reframe_proposal", syntax: 'rmd reframe <P##> --feedback "<text>" [--supersedes <rounds>]',
    summary: "Record feedback for a proposal's next draft.", properties: { proposalId, feedback: text }, required: ["proposalId", "feedback"], flags: { "--feedback": { field: "feedback" } } }),
  verb({ name: "reply", path: "/v1/inbox/thread/reply", tier: "low", tool: "reply_thread", syntax: 'rmd reply <threadId> --text "<text>" [--intent-id <id>]',
    summary: "Reply on an operator inbox thread.", properties: { threadId: { type: "string", pattern: "^thread:.+::inbox::-::-$" }, text: { ...text, maxLength: 4000 }, intentId: { type: "string", pattern: "^[A-Za-z0-9._:-]{8,128}$" } },
    required: ["threadId", "text"], flags: { "--text": { field: "text" }, "--intent-id": { field: "intentId" } } }),
  verb({ name: "archive", path: "/v1/inbox/archive", tier: "low", tool: "archive_proposal", syntax: "rmd archive <proposalId> [--undo]",
    summary: "Set an inbox item aside, or undo its archive.", properties: { proposalId, archived: { type: "boolean" } }, required: ["proposalId", "archived"], flags: { "--undo": { field: "archived", value: false } } }),
  verb({ name: "snooze", path: "/v1/inbox/snooze", tier: "low", tool: "snooze_proposal", syntax: "rmd snooze <proposalId> --until <RFC3339-UTC>|--wake",
    summary: "Hide an inbox item until a UTC instant, or wake it now.", properties: { proposalId, until: { type: ["string", "null"] } }, required: ["proposalId", "until"], flags: { "--until": { field: "until" }, "--wake": { field: "until", value: null } } }),
  verb({ name: "keep", path: "/v1/inbox/keep", tier: "low", tool: "keep_proposal", syntax: 'rmd keep <proposalId> [--reason "<text>"] [--undo]',
    summary: "Record the current observation as kept, or undo that decision.", properties: { proposalId, kept: { type: "boolean" }, reason: { type: "string" } }, required: ["proposalId"], flags: { "--reason": { field: "reason" }, "--undo": { field: "kept", value: false } } }),
];

export function validateInboxVerbArguments(spec: typeof INBOX_VERBS[number], body: unknown): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "arguments must be an object";
  const fields = body as Record<string, unknown>;
  if (Object.keys(fields).some(key => !(key in spec.properties))) return "unexpected argument";
  for (const key of spec.required) if (fields[key] === undefined) return `${key} is required`;
  for (const [key, value] of Object.entries(fields)) {
    const rule = spec.properties[key]!;
    const types = Array.isArray(rule.type) ? rule.type : [rule.type];
    if (!types.includes(value === null ? "null" : typeof value)) return `${key} has an invalid type`;
    if (typeof value === "string" && ((rule.minLength && value.trim().length < rule.minLength) ||
      (rule.maxLength && value.length > rule.maxLength) || (rule.pattern && !new RegExp(rule.pattern).test(value)))) return `${key} is invalid`;
  }
  return undefined;
}

export function validatedInboxAction<T>(validate: (body: unknown) => T | { error: string },
  perform: (input: T, actor: InboxVerbActor, respond: InboxVerbRespond) => void | Promise<void>): InboxVerbAction {
  return (body, actor, respond) => {
    const input = validate(body);
    if (input && typeof input === "object" && "error" in input) { respond(400, { error: "invalid_request", detail: input.error }); return; }
    return perform(input as T, actor, respond);
  };
}

export async function inboxVerbCommand(name: InboxVerbName, args: string[], actions: InboxVerbActions): Promise<number> {
  const spec = INBOX_VERBS.find(v => v.name === name)!;
  const body: Record<string, unknown> = { [name === "reply" ? "threadId" : "proposalId"]: args[0] };
  if (name === "archive") body.archived = true;
  if (name === "keep") body.kept = true;
  const used = new Set<string>();
  let error = !args[0] || args[0].startsWith("--") ? "an id must come first" : undefined;
  for (let i = 1; !error && i < args.length; i++) {
    const flag = spec.flags[args[i]!];
    if (!flag || used.has(flag.field)) { error = "unexpected or conflicting flag"; break; }
    used.add(flag.field);
    if ("value" in flag) body[flag.field] = flag.value;
    else {
      const value = args[++i];
      if (value === undefined || value.startsWith("--")) error = "flag needs a value";
      else body[flag.field] = value;
    }
  }
  error ??= validateInboxVerbArguments(spec, body);
  if (error) { console.error(`rmd ${name}: ${error} — usage: ${spec.syntax}`); return 2; }
  let code = 1;
  await spec.perform(actions, body, { origin: "rmd-cli" }, (status, result) => {
    code = status < 400 ? 0 : status === 400 ? 2 : 1;
    (code === 0 ? console.log : console.error)(JSON.stringify(result));
  });
  return code;
}

export const PROPOSAL_VERDICT_SYNTAX: Record<ProposalVerdictKind, string> = {
  decline: 'rmd decline <proposalId> --reason "<text>"',
  restore: 'rmd restore <proposalId> --reason "<text>"',
};

/**
 * Exit 0 recorded, 1 refused (unknown, ratified, or already in the asked-for state), 2 a usage error. `find` classifies
 * one proposal live, as `rmd approve` would, with the ledger's declines applied; `record` appends the verdict's row.
 */
export function proposalVerdictCommand(
  kind: ProposalVerdictKind,
  rest: string[],
  find: (proposalId: string) => { exists: boolean; classification?: InboxClassification },
  record: (step: string, proposalId: string, reason: string) => void,
): number {
  const proposalId = rest[0];
  const reason = flagValue(rest, "--reason");
  const badArg = proposalId?.startsWith("--") ? `rmd ${kind}: <proposalId> must come first` : unknownArgError(kind, rest.slice(1), ["--reason"]);
  if (!proposalId || badArg || reason === undefined || reason.trim() === "") {
    console.error(`${badArg ?? `rmd ${kind}: a proposal id and a non-empty --reason are required`} — usage: ${PROPOSAL_VERDICT_SYNTAX[kind]}`);
    return 2;
  }
  const outcome = applyProposalVerdict(kind, { proposalId, reason }, find(proposalId), record);
  if (!outcome.ok) {
    console.error(`rmd ${kind}: ${outcome.detail}`);
    return 1;
  }
  console.log(
    kind === "decline"
      ? `rmd decline: ${proposalId} DECLINED — take it back with ${PROPOSAL_VERDICT_SYNTAX.restore.replace("<proposalId>", proposalId)}`
      : `rmd restore: ${proposalId} RESTORED — it is back in the inbox and classifies as it would have before the decline`,
  );
  return 0;
}
