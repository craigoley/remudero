/**
 * lib/emissions.ts — "this capability exists and nothing ever runs it", made visible.
 *
 * WHY A RUNTIME READER AND NOT A FOURTH STATIC LINTER. This repo already carries three static
 * instruments (the call-site rule for new modules, the producer-completeness test for view fields,
 * the route-registration test), and each covers a different slice. None of them can catch this
 * class, and recon-EY said exactly why: "a static 'is this verb referenced?' check passes on
 * `rmd ops`, because the CLI dispatch is a real call site. NOTHING STATIC SEPARATES 'reachable but
 * never typed' from 'routinely invoked.'" Only the ledger knows which verbs actually run.
 *
 * IT IS A REPORT, NOT A GATE, and that is a decision rather than an omission. recon-CY assessed the
 * ledger-step variant of this idea and concluded a gate would be deleted within a week: deadness
 * needs a runtime corpus that is host-specific, and roughly thirty candidates are healthy
 * never-thrown error arms. A reader that an operator consults survives; a build gate that fails on
 * a verb nobody needed this month does not.
 *
 * ── WHAT IT SURVEYS, AND WHAT IT DELIBERATELY DOES NOT ──────────────────────────────────────────
 * IN: CLI verbs. A verb is the clear case — it has a name, a dispatch, and (sometimes) a
 *     characteristic ledger step, so "declared but never invoked" is decidable from the ledger.
 * OUT: every other dead-code shape — unmounted routes, unemitted ledger steps, unsupplied hooks,
 *     unloaded launchd units. Each of those is its own slice with its own evidence, and the working
 *     pattern in this repo is one instrument per slice. A single detector that tried to cover all
 *     of them would be the "second registration list" that hid the unmounted route.
 *
 * ── THE PAIRING THAT MAKES IT DIAGNOSTIC RATHER THAN A USAGE HISTOGRAM ──────────────────────────
 * An emissions count over THIS HOST's ledger measures this host's habits, not the code's health: a
 * verb nobody has needed looks identical to a verb nobody can reach. So every row carries BOTH
 * signals — the runtime count AND whether the verb has a call site beyond its own CLI dispatch.
 * Those two axes are the whole value:
 *
 *   zero emissions + NO call site beyond dispatch  ⇒ UNREACHABLE-IN-PRACTICE. Nothing can invoke it
 *                                                    but a human typing it, and no human has.
 *                                                    `rmd ops` and `rmd issues` are exactly this.
 *   zero emissions + a real call site              ⇒ reachable, simply unused this window.
 *   emissions > 0                                  ⇒ live; reported only to keep the allowlist honest.
 */

/** A verb as declared in run-task.ts's `COMMANDS` registry. */
export interface DerivedVerb {
  name: string;
  /** The ledger step prefix attributable to it, or null when nothing is attributable. */
  prefix: string | null;
}

/**
 * Every verb name in `COMMANDS`, read out of the source rather than re-listed here.
 *
 * DERIVED, NOT HARDCODED, for the reason the unmounted route taught: a hand-maintained copy of a
 * registry becomes a second registry, and the two drift silently. `COMMANDS` is what the binary
 * dispatches against, so a verb added tomorrow is surveyed the moment it exists.
 *
 * SCOPED TO THE ARRAY'S OWN BODY, NOT INDENTATION-DEPTH. The prior pattern
 * (`/^\s{4}name:\s*"…"/gm`) required an entry's `name:` to sit at exactly four leading spaces —
 * true of every multi-line entry, but three registry rows (`retro`, `resume`, `notify`) are
 * written on ONE LINE at two spaces (`{ name: "retro", usage: … }`), so that pattern silently
 * dropped them: 60 seen of 63 declared, with nothing reporting the gap (W1-T2479). Slicing to the
 * `COMMANDS` array's own source span first, then matching `name:` at ANY indentation within that
 * span, reads both entry shapes and cannot pick up an unrelated `{ name: "…" }` literal elsewhere
 * in the file (e.g. `implementPromptParts`'s prompt-part list) the way an unanchored file-wide
 * scan would.
 * FALSE POSITIVES: none observed — scoped to the `COMMANDS` array body, which is the only place
 * `name:` denotes a CLI verb.
 * FALSE NEGATIVES: a verb dispatched in `main()` without a `COMMANDS` entry would be invisible.
 * That is the same drift `COMMANDS`'s own doc comment says cannot happen ("neither is
 * hand-maintained prose"), and the help output would be wrong too, so it is loud by other means.
 * A reshape of the array itself (renamed, no longer `const COMMANDS: readonly CommandSpec[] = [`
 * … `] as const;`) fails LOUD here rather than silently scanning zero verbs — the population must
 * never shrink without saying so.
 */
export function deriveCliVerbs(runTaskSource: string): string[] {
  const marker = "const COMMANDS: readonly CommandSpec[] = [";
  const start = runTaskSource.indexOf(marker);
  if (start === -1) {
    throw new Error(`deriveCliVerbs: could not find \`${marker}\` — has the registry been renamed or reshaped?`);
  }
  const end = runTaskSource.indexOf("\n] as const;", start);
  if (end === -1) {
    throw new Error("deriveCliVerbs: found the COMMANDS array's start but not its closing `] as const;` — has it been reshaped?");
  }
  const body = runTaskSource.slice(start, end);
  return [...body.matchAll(/\bname:\s*"([a-z0-9-]+)"/g)].map((m) => m[1]);
}

/**
 * Every ledger step literal emitted anywhere in the given sources, grouped to its prefix.
 *
 * BOTH EMISSION SHAPES, measured rather than assumed. `log("x.y", …)` is the common one, but
 * `lib/ops.ts:557` writes `{ step: "ops.alerts_polled", … }` as an object field — and a scan that
 * knew only the first shape would have missed the single most important verb in this whole report.
 *
 * FALSE NEGATIVES: a step whose name is COMPUTED (a template literal or a variable) is invisible
 * here. That is inherent to a source scan and is why this pairs with the ledger rather than
 * replacing it: the ledger shows what was actually written, whatever built the string.
 */
export function deriveStepPrefixes(sources: ReadonlyArray<string>): Set<string> {
  const res = [/\blog\(\s*"([a-zA-Z_][\w.]*)"/g, /\bstep:\s*"([a-zA-Z_][\w.]*)"/g];
  const prefixes = new Set<string>();
  for (const text of sources) {
    for (const re of res) {
      for (const m of text.matchAll(re)) {
        const step = m[1];
        if (step.includes(".")) prefixes.add(step.split(".")[0]);
      }
    }
  }
  return prefixes;
}

/**
 * Attribute a ledger step prefix to each verb, BY EXACT NAME ONLY.
 *
 * THE CALIBRATION THAT SET THIS RULE. A looser head-token match (`run-task` → `run`) raised
 * coverage from 14 verbs to 21, and hand-reading the seven it added showed it was mostly WRONG:
 *
 *   run-task    -> run      CORRECT   (`run.start`/`run.error`, emitted by run-task.ts)
 *   lint-plan   -> lint     WRONG     (`lint.blocked`/`lint.warned` are DISPATCH-time lint, not the verb)
 *   console-url -> console  WRONG     (`console.*` is emitted by daemon.ts consuming console markers)
 *   daemon-plist-> daemon   WRONG     (a distinct verb hiding behind its hot sibling's prefix)
 *   deploy-run  -> deploy   WRONG     (same)
 *   deploy-plist-> deploy   WRONG     (same)
 *   serve-plist -> serve    WRONG     (same)
 *
 * One right, six wrong. Worse, the four sibling cases fail in the DANGEROUS direction: a dead verb
 * inherits a hot verb's traffic and reads as live. Exact-name matching cannot do that, because a
 * prefix equal to one verb's exact name can never be claimed by another verb.
 *
 * THE COST, stated rather than hidden: verbs that emit under a differently-named prefix are
 * unauditable here. `run-task` is the known case — it emits `run.*`. It is also the single hottest
 * verb in the repo, so its deadness is not a live risk; the honest move is to report it as
 * unauditable rather than to widen the rule that was six-sevenths wrong.
 */
export function attributeVerbs(verbs: ReadonlyArray<string>, prefixes: ReadonlySet<string>): DerivedVerb[] {
  return verbs.map((name) => {
    const forms = [name, name.replace(/-/g, "_"), name.replace(/-/g, "")];
    const hit = forms.find((f) => prefixes.has(f));
    return { name, prefix: hit ?? null };
  });
}

/**
 * Verbs that are legitimately rare, each with a SPECIFIC reason. "TODO" is not a reason.
 *
 * An allowlisted verb is not reported as dead — but a stale entry is still surfaced (see
 * {@link emissionsReport}'s `stale-allowlist` status), because an allowlisted verb that starts
 * being invoked is itself worth knowing: the reason has expired and the entry should go.
 */
export const EMISSIONS_ALLOWLIST: ReadonlyMap<string, string> = new Map([
  ["onboard", "one-shot per new machine; this host was onboarded before the ledger existed"],
  ["init", "one-shot at repo creation — running it again on a live repo would be the defect"],
  ["project", "`rmd project init` scaffolds a DIFFERENT repo's gate stack; nothing to run against this one"],
  ["wipe-test", "the A/B learning harness spends real money per pair; rare by design, never by accident"],
]);

export type EmissionStatus = "unreachable-in-practice" | "reachable-but-unused" | "live" | "stale-allowlist";

export interface EmissionRow {
  verb: string;
  prefix: string;
  count: number;
  /** Call sites beyond the verb's own CLI dispatch — the STATIC half of the pairing. */
  callSitesBeyondDispatch: number;
  status: EmissionStatus;
  allowlistReason?: string;
}

export interface EmissionsInput {
  /** Only verbs with an attributable prefix are measurable; the rest are reported separately. */
  measurable: ReadonlyArray<{ name: string; prefix: string }>;
  /** prefix -> number of ledger lines in the window. */
  counts: ReadonlyMap<string, number>;
  callSites: ReadonlyMap<string, number>;
  allowlist?: ReadonlyMap<string, string>;
}

/**
 * The report. Pure — no ledger read, no filesystem, no clock — so every classification below is
 * unit-testable without a corpus.
 */
export function emissionsReport(input: EmissionsInput): EmissionRow[] {
  const allow = input.allowlist ?? EMISSIONS_ALLOWLIST;
  const rows: EmissionRow[] = [];
  for (const { name, prefix } of input.measurable) {
    const count = input.counts.get(prefix) ?? 0;
    const callSites = input.callSites.get(name) ?? 0;
    const reason = allow.get(name);
    let status: EmissionStatus;
    if (count > 0) {
      // A live verb is reported ONLY when the allowlist still excuses it — a stale entry is a small
      // lie that grows, and it is cheap to surface exactly when it stops being true.
      status = reason ? "stale-allowlist" : "live";
    } else if (reason) {
      continue; // allowlisted AND still quiet: working as intended, say nothing.
    } else {
      status = callSites > 0 ? "reachable-but-unused" : "unreachable-in-practice";
    }
    rows.push({ verb: name, prefix, count, callSitesBeyondDispatch: callSites, status, ...(reason ? { allowlistReason: reason } : {}) });
  }
  const rank: Record<EmissionStatus, number> = {
    "unreachable-in-practice": 0,
    "reachable-but-unused": 1,
    "stale-allowlist": 2,
    live: 3,
  };
  return rows.sort((a, b) => rank[a.status] - rank[b.status] || a.count - b.count || a.verb.localeCompare(b.verb));
}
