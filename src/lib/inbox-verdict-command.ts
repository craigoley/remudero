/**
 * `rmd decline <proposalId> --reason "<text>"` and `rmd restore <proposalId> --reason "<text>"` — the terminal's
 * route to the two inbox verdicts the console already had (`POST /v1/inbox/decline`, `POST /v1/inbox/restore`).
 * Before this, an operator in a terminal could approve a proposal but decline one only through the console or a
 * hand-written curl carrying a write token. Both routes and both commands go through {@link applyProposalVerdict},
 * so what refuses and what is recorded is one decision, not two copies of it.
 */
import { flagValue, unknownArgError } from "./cli-args.js";
import { applyProposalVerdict, type InboxClassification, type ProposalVerdictKind } from "./inbox.js";

export interface ProposalVerdictCommandDeps {
  /** Classify one proposal live, as `rmd approve` would, with the ledger's declines applied. */
  find: (proposalId: string) => { exists: boolean; classification?: InboxClassification };
  /** Append the verdict's ledger row. */
  record: (step: string, proposalId: string, reason: string) => void;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

export const PROPOSAL_VERDICT_SYNTAX: Record<ProposalVerdictKind, string> = {
  decline: 'rmd decline <proposalId> --reason "<text>"',
  restore: 'rmd restore <proposalId> --reason "<text>"',
};

/** Exit 0 recorded, 1 refused (unknown, ratified, or already in the asked-for state), 2 a usage error. */
export function proposalVerdictCommand(kind: ProposalVerdictKind, rest: string[], deps: ProposalVerdictCommandDeps): number {
  const out = deps.out ?? ((line: string) => console.log(line));
  const err = deps.err ?? ((line: string) => console.error(line));
  const proposalId = rest[0];
  const reason = flagValue(rest, "--reason");
  const badArg = proposalId?.startsWith("--") ? `rmd ${kind}: <proposalId> must come first` : unknownArgError(kind, rest.slice(1), ["--reason"]);
  if (!proposalId || badArg || !reason?.trim()) {
    err(`${badArg ?? `rmd ${kind}: a proposal id and a non-empty --reason are required`} — usage: ${PROPOSAL_VERDICT_SYNTAX[kind]}`);
    return 2;
  }
  const outcome = applyProposalVerdict(kind, { proposalId, reason }, deps.find(proposalId), deps.record);
  if (!outcome.ok) {
    err(`rmd ${kind}: ${outcome.detail}`);
    return 1;
  }
  out(
    kind === "decline"
      ? `rmd decline: ${proposalId} DECLINED — take it back with ${PROPOSAL_VERDICT_SYNTAX.restore.replace("<proposalId>", proposalId)}`
      : `rmd restore: ${proposalId} RESTORED — it is back in the inbox and classifies as it would have before the decline`,
  );
  return 0;
}
