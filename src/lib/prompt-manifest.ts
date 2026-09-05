/**
 * `buildPromptManifest` — the fingerprint of WHAT A WORKER SAW (W1-T2297).
 *
 * `renderImplementPrompt` (src/run-task.ts) assembles doctrine, the task's cited context claims,
 * recon, operator notes and matched learnings into one CONTEXT block, but until this task nothing
 * recorded WHICH of those parts a given run actually received: `run.start` carries routing
 * (repo/type/risk/class), `learnings.injected` carries an aggregate count, and neither says
 * anything about the RECON or OPERATOR NOTES text a specific dispatch was handed. This module is
 * the one pure helper that closes that gap: given the named parts a prompt was assembled FROM, it
 * returns one manifest row per part — never the part's own bytes, only its identity (a sha256) and
 * size — so a ledger line built from {@link buildPromptManifest}'s output can answer "did this
 * worker receive X?" without ever republishing prompt text into the ledger (rows are greppable
 * forever and rotate through archives with different handling than task text deserves).
 *
 * A RECORD, NEVER A GATE: nothing here decides anything, and no caller may make it one — the
 * manifest complements `learnings.injected`'s aggregate count with per-part identity, it never
 * replaces it, and it must never be consulted by dispatch, review, or any arm decision.
 *
 * ABSENT VS. EMPTY, NEVER CONFLATED (P48(ii), mirroring `ReceiptField`'s present/absent split,
 * lib/receipt.ts). `operatorNotesBlock` defaults to `""` when a task carries no notes, and
 * `reconContext` can likewise render to `""` on some paths — an empty string that happened to be
 * this run's actual content is indistinguishable from "nothing was here" if both hash to
 * `sha256("")`. So EVERY falsy value (`undefined`, `null`, or the empty string) is treated as
 * ABSENT: its row carries `present: false`, `sha256: null`, `bytes: null` — never a hash of empty
 * content masquerading as a real, if tiny, injected part.
 */
import { createHash } from "node:crypto";
import { countEnvelopes } from "./untrusted-envelope.js";

/** One named part of an assembled prompt, as {@link buildPromptManifest} receives it. `value` is
 *  the EXACT string this part contributes to the rendered prompt (before any surrounding
 *  join/filter the renderer applies) — `undefined`, `null`, or `""` all mean "this part was
 *  absent this run". */
export interface PromptManifestInput {
  name: string;
  value: string | null | undefined;
  /**
   * W1-T2700: this part is known to carry EXTERNAL text — an issue body, a PR comment, a CI log
   * tail, a webhook payload. Declared by the CALLER, because only the assembly site knows an
   * input's provenance; the manifest cannot infer it from the bytes. A part declared external
   * whose {@link PromptManifestPart.envelopes} count is 0 handed that text to a worker BARE, and
   * {@link unwrappedExternalParts} names it from the ledger row alone, after the fact.
   */
  external?: boolean;
}

/** One manifest row. `present: false` rows always carry `sha256: null` and `bytes: null` — see
 *  this module's header for why an absent part is never recorded as a hash of the empty string. */
export interface PromptManifestPart {
  name: string;
  present: boolean;
  sha256: string | null;
  bytes: number | null;
  /**
   * W1-T2700: how many untrusted-content envelopes this part's text contains. ALWAYS PRESENT, and
   * `0` on an absent part — unlike `sha256`/`bytes`, "no envelopes" is a real, actionable fact
   * about a part rather than a missing measurement, and a `null` here would force every reader to
   * re-decide what an unknown count means. `external` echoes the caller's declaration so a reader
   * can join the two without holding the assembly site's knowledge.
   */
  envelopes: number;
  external: boolean;
}

/**
 * PURE: no I/O, no clock, no randomness — the identical `parts` in produce the identical rows out
 * every time, and nothing here ever writes to the ledger itself (the call site in `run-task.ts`
 * does that, exactly once, on the returned array). Order is preserved from `parts` — callers that
 * want a stable row order should pass a stably-ordered `parts` array.
 */
export function buildPromptManifest(parts: readonly PromptManifestInput[]): PromptManifestPart[] {
  return parts.map(({ name, value, external }) => {
    if (!value) {
      return { name, present: false, sha256: null, bytes: null, envelopes: 0, external: Boolean(external) };
    }
    return {
      name,
      present: true,
      sha256: createHash("sha256").update(value, "utf8").digest("hex"),
      bytes: Buffer.byteLength(value, "utf8"),
      envelopes: countEnvelopes(value),
      external: Boolean(external),
    };
  });
}

/**
 * THE MANIFEST'S OWN READER (W1-T2700 criterion 3). Names every part that was DECLARED external,
 * was actually PRESENT this run, and carried ZERO envelopes — i.e. a worker was handed outside
 * text bare. Returns names only: the manifest never held the bytes, and this must not tempt a
 * caller into republishing prompt text.
 *
 * A RECORD, NEVER A GATE, exactly as this module's header already binds every reader here: an
 * unwrapped part is reported so a human can go and wrap it. Nothing may consult this to decide a
 * dispatch, a review, or an arm — it answers "did this already happen?", never "may this proceed?".
 *
 * An ABSENT external part is NOT reported: there was no text to wrap, so there is nothing to fix,
 * and reporting it would bury the real rows under one per skipped optional part per run.
 */
export function unwrappedExternalParts(parts: readonly PromptManifestPart[]): string[] {
  return parts.filter((p) => p.external && p.present && p.envelopes === 0).map((p) => p.name);
}
