/**
 * W1-T2495: a declared registry of every PSEUDO sender that writes to the ledger — a producer
 * that is not itself a plan task (the daemon loop, retro, drain, sweep, the CLI's own
 * self-instrumentation, ...) and so stamps `task_id` with a label it invented for itself rather
 * than a `W<n>-T<n>` id. SURFACE 1/2 (this task's own rationale): seventeen such labels exist in
 * this repo today, and two pairs of them — `DAEMON`/`daemon`, `RETRO`/`retro` — are the SAME
 * producer under two spellings, which means anything that groups, counts, or threads by that
 * raw string sees two colleagues where there is one.
 *
 * A REGISTRY, NOT A NORMALISER. Lower-casing (or otherwise case-folding) every incoming id at
 * the read site would collapse the two known pairs but leaves the door open for an EIGHTEENTH
 * producer to invent yet another spelling tomorrow — case-folding can never tell a NEW,
 * undeclared label apart from a known one, because it does not consult a list of what is known
 * at all. This module instead is a closed, declared list: each producer is named exactly once,
 * with the human-readable display name the console/inbox will eventually print as its "From"
 * (W1-T2497 owns that rendering; this only supplies the name it will read). A raw id that is
 * not a key in {@link PRODUCER_IDENTITIES} — a typo, a renamed lane, a genuinely new producer
 * that never registered — is REFUSED by {@link resolveProducerIdentity}, never silently accepted
 * as a new, ungoverned key.
 *
 * A PLAN TASK ID IS NEVER A PSEUDO SENDER. `W1-T2495` already has an owner a human can look up
 * in the plan; it does not belong in this registry and {@link resolveProducerIdentity} refuses
 * one on sight rather than quietly returning nothing meaningful for it.
 *
 * NOT IN SCOPE (this task's own record): renaming any pseudo id already written to the ledger's
 * own rows (the archives are append-only; this registry declares the SEVENTEEN as they stand),
 * the thread model (W1-T2494, already merged), and the console's rendering of any of this
 * (W1-T2497).
 */

/** One declared producer: a canonical id (used to GROUP its spellings) plus the human-readable
 *  name a console/inbox surface prints as the message's "From". */
export interface ProducerIdentity {
  readonly id: string;
  readonly displayName: string;
}

/** Thrown by {@link resolveProducerIdentity} for any `task_id` that is neither a declared pseudo
 *  sender nor a plan task id — the REFUSAL this registry exists to make possible (claim: "an
 *  undeclared sender is refused rather than silently accepted"). A plain `Error` subclass, never
 *  a bare string throw, so a caller can `instanceof`-narrow it without parsing a message. */
export class UndeclaredProducerError extends Error {
  constructor(public readonly rawSenderId: string) {
    super(
      `producer-identity: ${JSON.stringify(rawSenderId)} is not a declared pseudo sender — ` +
        `declare it in PRODUCER_IDENTITIES (src/lib/producer-identity.ts) before writing it to the ledger`,
    );
    this.name = "UndeclaredProducerError";
  }
}

/** A plan task id — `W<digits>-T<digits>`, the SAME shape `panel-graph.ts`'s own referent
 *  classifier already tests for. Anything matching this is a plan task's OWN identity, never a
 *  pseudo sender, no matter what string it happens to be. */
export const PLAN_TASK_ID_PATTERN = /^W\d+-T\d+$/;

function producer(id: string, displayName: string): ProducerIdentity {
  return Object.freeze({ id, displayName });
}

// One shared object per PRODUCER (not per spelling) — `DAEMON` and `daemon` below are two keys
// pointing at the exact same frozen object, so resolving either yields an identity `===`-equal
// to resolving the other (claim: "the two case-variant pairs collapse to one sender each").
const DAEMON = producer("daemon", "Daemon");
const RETRO = producer("retro", "Retro");

/**
 * THE CLOSED LIST. Every raw `task_id` string this repo's own producers write to the ledger
 * today when the WRITER, not a plan task, is the sender — enumerated from source (every
 * task_id string literal in src/, plus `PANEL_TASK_ID`/`cmd.toUpperCase()`'s two call-time
 * values, `DAEMON`/`SERVE`, both already listed). Adding a new producer means adding a new
 * entry HERE first; nothing downstream ever infers one.
 */
export const PRODUCER_IDENTITIES: Readonly<Record<string, ProducerIdentity>> = Object.freeze({
  DAEMON,
  daemon: DAEMON,
  RETRO,
  retro: RETRO,
  REAP: producer("reap", "Reaper"),
  DRAIN: producer("drain", "Drain"),
  SWEEP: producer("sweep", "Sweep"),
  FIX: producer("fix", "Fix Rung"),
  FLEET: producer("fleet", "Fleet"),
  SERVE: producer("serve", "Serve"),
  RELAY: producer("relay", "Relay"),
  BATCH: producer("batch", "Batch Approve"),
  CLI: producer("cli", "CLI"),
  OPS: producer("ops", "Ops"),
  PANEL: producer("panel", "Console Panel"),
  DEPLOY: producer("deploy", "Deploy Supervisor"),
  ISSUES: producer("issues", "Issues Intake"),
  GOVERNOR: producer("governor", "Governor"),
  inbox: producer("inbox", "Inbox"),
  _ledger: producer("_ledger", "Ledger Internals"),
  "coverage-improve": producer("coverage-improve", "Coverage Improvement"),
});

/**
 * Resolve a raw ledger `task_id` to its declared {@link ProducerIdentity}, or REFUSE it.
 *
 * Two REFUSAL shapes, both thrown rather than returning something falsy a caller could let
 * slide past unchecked:
 *  - a plan task id (`W1-T2495`) — never a pseudo sender at all (claim: "a plan task id is
 *    never treated as a pseudo sender");
 *  - anything else not present as a key in {@link PRODUCER_IDENTITIES} — an undeclared sender
 *    (claim: "an undeclared sender is refused rather than silently accepted").
 *
 * Every declared entry this DOES return carries a `displayName` by construction — every value
 * in {@link PRODUCER_IDENTITIES} is built through {@link producer}, which requires one (claim:
 * "every declared sender carries a human-readable display name").
 */
export function resolveProducerIdentity(rawSenderId: string): ProducerIdentity {
  if (PLAN_TASK_ID_PATTERN.test(rawSenderId)) {
    throw new Error(
      `producer-identity: ${JSON.stringify(rawSenderId)} is a plan task id, not a pseudo sender — ` +
        `resolveProducerIdentity never resolves a plan task`,
    );
  }
  const identity = PRODUCER_IDENTITIES[rawSenderId];
  if (!identity) throw new UndeclaredProducerError(rawSenderId);
  return identity;
}

/**
 * Group a batch of raw `task_id` strings by the declared producer they resolve to — the
 * denominator {@link resolveProducerIdentity} exists to fix: a producer that wrote under two
 * spellings (`DAEMON` and `daemon`) lands in ONE bucket, keyed by the canonical
 * {@link ProducerIdentity.id}, not two (claim: "grouping by sender yields one bucket for a
 * producer that used two spellings"). Throws on the first plan-task-id or undeclared entry —
 * same refusal {@link resolveProducerIdentity} makes, never silently dropped from the grouping.
 */
export function groupBySender(rawSenderIds: readonly string[]): Map<string, string[]> {
  const buckets = new Map<string, string[]>();
  for (const raw of rawSenderIds) {
    const identity = resolveProducerIdentity(raw);
    const bucket = buckets.get(identity.id);
    if (bucket) bucket.push(raw);
    else buckets.set(identity.id, [raw]);
  }
  return buckets;
}
