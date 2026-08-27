import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * PRODUCER COMPLETENESS — does anything actually WRITE the fields we read?
 *
 * THE DEFECT CLASS, measured by recon-DW over 663 ledger files and 4,185,622 lines: NINE of
 * `OpenPrView`'s optional fields were assigned by NO producer anywhere in `src/`, and every one had
 * live consumers branching on the resulting `undefined` as though it were a negative answer.
 * recon-DW's words: **"The defect isn't reading undefined — it's a false predicate falling through
 * to a row that then acts."**
 *
 * What that cost, measured: the `conflicted` disposition occurs ZERO times across 10,757 unique
 * dispositions and 5,739 sweep summaries, against a control of 391,589 for the mergeable reason —
 * three mechanisms (the dirty row, the CONFLICTED blocker state, the merge-conflict fix mode) that
 * have never once executed. One of them armed auto-merge on a conflicted PR five times in four
 * minutes before a human intervened. `checksPendingSince` cost 57 unretirable needs-human issues.
 * The review-orphan pair's two ternary arms differ 878 to 0.
 *
 * TypeScript cannot catch this: `mergeState?: MergeState` is satisfied by omission. A type-level
 * split of the REST row types (recon-DW's "Option A") is necessary but insufficient — all three
 * known instances read the field off the VIEW, not off the row.
 *
 * WHY A TEST AND NOT A LINT RULE. recon-CY assessed this family and concluded the enumerable-arrival
 * variant belongs in a test: a build gate that produces false positives gets deleted within a week.
 * The arrival path here is enumerable — an `OpenPrView` can only be built by an object literal that
 * satisfies its required fields — so the check can be exact rather than heuristic.
 */

/** One member of the audited interface. */
export interface ViewField {
  name: string;
  optional: boolean;
  /** 1-based line of the declaration, for a failure message that can be clicked. */
  line: number;
}

/**
 * Every member declared on `interfaceName`, in declaration order.
 *
 * Scans the interface BODY only — from `export interface <name> {` to the first column-0 `}` — and
 * accepts a member at exactly two-space indent. A member of a NESTED inline object type is indented
 * deeper and is deliberately not collected: it is not a field of this interface.
 */
export function declaredViewFields(src: string, interfaceName: string): ViewField[] {
  const lines = src.split("\n");
  const start = lines.findIndex((l) => new RegExp(`^export interface ${interfaceName}\\b`).test(l));
  if (start < 0) throw new Error(`producer-completeness: interface ${interfaceName} not found`);
  const out: ViewField[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\}/.test(lines[i])) break;
    const m = lines[i].match(/^ {2}(\w+)(\??)\s*:/);
    if (m) out.push({ name: m[1], optional: m[2] === "?", line: i + 1 });
  }
  return out;
}

/** What {@link producerAssignedKeys} found in one file. */
export interface ProducerScan {
  /** Every key assigned by any producer literal in this file. */
  keys: Set<string>;
  /** Spread elements seen inside a producer literal — see the doc for why these matter. */
  spreads: string[];
  /** 1-based line of each producer literal's opening brace. */
  literals: number[];
}

/**
 * Every key assigned by an `OpenPrView`-producing object literal in `src`.
 *
 * THE ANCHOR IS EXACT, NOT HEURISTIC, and this is the whole reason the check is trustworthy.
 * TypeScript already forces every `OpenPrView` literal to assign ALL of the interface's REQUIRED
 * fields; nothing else in the codebase assigns all nine. So "a brace-balanced object literal that
 * assigns every required field" identifies producers precisely. Measured on today's tree it selects
 * exactly two literals — `buildOpenPrViews` and `routeFix`'s view — which is exactly the set
 * recon-DW identified by hand.
 *
 * A looser anchor was tried first and rejected: keying on `prNumber:` alone matched literals in ten
 * files (ledger lines, board rows, clarification questions), any of which could have contributed a
 * same-named key and masked a genuinely unwired field.
 *
 * TYPE DECLARATIONS ARE EXCLUDED. The `interface OpenPrView { … }` body itself passes the
 * all-required anchor, because an optional member reads `name?: T` while the key pattern requires
 * `name:` — so the declaration appears to assign exactly the nine required fields. That was a real
 * false positive during development; a declaration is not a producer.
 */
/**
 * Split an object-literal BODY into its top-level entries and classify each.
 *
 * CHARACTER-LEVEL, NOT LINE-LEVEL, and that distinction is a corrected defect rather than a
 * preference: a line-based scan registers only the FIRST key of a single-line literal
 * (`{ id: 1, name: "n" }` yields just `id`), which is a silent false negative — the exact failure
 * shape this module exists to catch. Splitting on depth-0 commas handles one-line and multi-line
 * literals identically.
 *
 * Comments are stripped before splitting so a `//` containing a comma or brace cannot desynchronise
 * the depth counter.
 */
function topLevelEntries(body: string): { local: Set<string>; localSpreads: string[] } {
  const stripped = body.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
  const local = new Set<string>();
  const localSpreads: string[] = [];
  let depth = 0;
  let buf = "";
  const flush = (): void => {
    const entry = buf.trim();
    buf = "";
    if (!entry) return;
    if (entry.startsWith("...")) {
      localSpreads.push(entry.slice(0, 48));
      return;
    }
    // `name: value` AND ES6 shorthand `name` — both are assignments.
    const m = entry.match(/^(\w+)\s*(?::|$)/);
    if (m) local.add(m[1]);
  };
  for (const c of stripped) {
    if (c === "{" || c === "[" || c === "(") depth++;
    else if (c === "}" || c === "]" || c === ")") depth--;
    if (c === "," && depth === 0) {
      flush();
      continue;
    }
    buf += c;
  }
  flush();
  return { local, localSpreads };
}

export function producerAssignedKeys(src: string, required: readonly string[]): ProducerScan {
  const keys = new Set<string>();
  const spreads: string[] = [];
  const literals: number[] = [];
  // ANCHOR ON THE BARE IDENTIFIER, not on `name:`. Keying on the colon form missed a producer
  // written entirely in ES6 shorthand (`return { prNumber, prUrl, … }`), because the substring
  // `prNumber:` never appears — a silent false negative of exactly the kind this module hunts.
  // Matching the identifier widens the candidate set; the all-required check below restores
  // precision, so the only cost is a few more brace walks per file.
  const anchor = new RegExp(`\\b${required[0]}\\b`, "g");
  for (const hit of src.matchAll(anchor)) {
    const idx = hit.index ?? 0;
    let depth = 0;
    let open = -1;
    for (let i = idx; i >= 0; i--) {
      const c = src[i];
      if (c === "}") depth++;
      else if (c === "{") {
        if (depth === 0) {
          open = i;
          break;
        }
        depth--;
      }
    }
    if (open < 0) continue;
    let d = 0;
    let close = -1;
    for (let i = open; i < src.length; i++) {
      const c = src[i];
      if (c === "{") d++;
      else if (c === "}") {
        d--;
        if (d === 0) {
          close = i;
          break;
        }
      }
    }
    if (close < 0) continue;
    const openLine = src.slice(0, open).split("\n").pop() ?? "";
    if (/\b(interface|type)\b/.test(openLine)) continue;

    const { local, localSpreads } = topLevelEntries(src.slice(open + 1, close));
    if (!required.every((r) => local.has(r))) continue;
    literals.push(src.slice(0, open).split("\n").length);
    for (const k of local) keys.add(k);
    spreads.push(...localSpreads);
  }
  return { keys, spreads, literals };
}

/**
 * FIELDS DELIBERATELY LEFT UNWIRED, each with the reason it is acceptable TODAY.
 *
 * THE ALLOWLIST IS THE DESIGN. Eight fields are unwired on `main` as this lands, so a check with no
 * escape hatch could not land at all. But an entry with a vague reason is worse than no entry: it
 * launders "nobody has looked at this" into "this is fine". recon-DW found that of the five
 * non-asymmetry cases, "two are honestly documented as pending, three are not" — this is where that
 * honesty is now recorded, and the audit FAILS a stale entry so it cannot rot into a lie.
 *
 * Adding an entry is a deliberate act with a named consequence. Removing a field from this list
 * means wiring it.
 */
export const KNOWN_UNWIRED: Readonly<Record<string, string>> = {
  checksPendingSince:
    "declared by W1-T176 for a pending-age basis; no producer derives the first-pending timestamp. " +
    "The stale-pending rows fail toward the pre-existing behaviour, so the cost is a missing " +
    "escalation detail rather than a wrong action. Fixed FORWARD by #1041's bounding; the FIELD is " +
    "still unwired.",
  isPlanFiling:
    "documented as pending at its own declaration — the plan-filing stand-down (sweep.ts:2000) is " +
    "written and waiting for a producer. Until that wiring lands the row never matches, which is " +
    "the fail-open direction.",
  mergeable:
    "single-PR-only REST field. #1082 wired mergeState (the narrowed vocabulary the disposition " +
    "rows read) but deliberately did NOT widen mapRestPr to carry the raw booleans; mergeableFactLine " +
    "(sweep.ts:887) still returns empty on every call. Wiring it is recon-DW's D4/D6.",
  mergeableState:
    "single-PR-only REST field, the raw GitHub string W1-T186 wants quoted verbatim in an " +
    "escalation. Same producer gap as mergeable above; #1082 carried only the narrowed mergeState.",
  // mergeConflict WIRED by W1-T984: buildOpenPrViews (run-task.ts) now assigns it via
  // lib/open-prs-rest.ts's hydrateMergeConflictEvidence, scoped to PRs already read
  // mergeState === "dirty" — removed here per this file's own "removing a field from this list
  // means wiring it" rule. isPureConcurrentAddition itself stays byte-identical, and the
  // `conflicted` disposition row it feeds is gated off by default (mergeConflictAdmissionEnabled,
  // lib/sweep.ts) — see that flag's own doc for why.
  // pendingAnswer WIRED by W1-T435: buildOpenPrViews (run-task.ts) now assigns it via
  // lib/sweep.ts's operatorVerdictEvidence, reading the operator_feedback ledger step and
  // plan/questions.ndjson — removed here per this file's own "removing a field from this list
  // means wiring it" rule.
  // supersessionVerdict WIRED by W1-T2384: buildOpenPrViews (run-task.ts) now assigns it via
  // lib/open-prs-rest.ts's hydrateSupersessionVerdicts, scoped to PRs the arithmetic already
  // flagged (`supersededBy != null`) — removed here per this file's own "removing a field from
  // this list means wiring it" rule, never allowlisted.
};

/** What the audit concluded. Both lists must be empty for the check to pass. */
export interface ProducerCompletenessResult {
  /** Optional fields no producer assigns AND that carry no allowlist entry. */
  unwired: ViewField[];
  /** Allowlisted names that now HAVE a producer — the entry has rotted and must be deleted. */
  staleAllowlist: string[];
  /** Allowlisted names that are not declared on the interface at all. */
  unknownAllowlist: string[];
  /** Spreads seen inside a producer literal — assignments this method cannot resolve statically. */
  unresolvableSpreads: string[];
  /** Every producer literal found, as `file:line`. Empty ⇒ the anchor broke; the caller must fail. */
  producers: string[];
}

function tsFilesUnder(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) tsFilesUnder(p, acc);
    else if (p.endsWith(".ts")) acc.push(p);
  }
  return acc;
}

/**
 * Audit one interface's optional fields against every producer literal under `srcRoot`.
 *
 * READS FILES, NEVER GREPS. Two of this repo's source files carry a raw NUL byte
 * (`src/lib/flight-signals.ts`, `src/lib/task-linter.ts`) and `grep` reports NOTHING on them
 * without `-a` — a producer living in either would have been invisible and reported as a false
 * orphan. `readFileSync` has no such behaviour, so the whole trap is sidestepped rather than
 * worked around.
 *
 * TEST FILES ARE OUT OF SCOPE, DELIBERATELY. `srcRoot` is `src/`. A field assigned ONLY by a test
 * fixture is exactly the shape being hunted: impl-DX's falsifier initially caught only one test
 * because three others hand-assigned `mergeState`, and recon-DW measured the merge fields assigned
 * 5/7/2 times in `test/` and zero times in `src/`. Counting a fixture as a producer would make this
 * check unable to detect its own defect class.
 */
export function auditProducerCompleteness(opts: {
  srcRoot: string;
  interfaceFile: string;
  interfaceName: string;
  allowlist?: Readonly<Record<string, string>>;
}): ProducerCompletenessResult {
  const allowlist = opts.allowlist ?? KNOWN_UNWIRED;
  const fields = declaredViewFields(readFileSync(opts.interfaceFile, "utf8"), opts.interfaceName);
  const required = fields.filter((f) => !f.optional).map((f) => f.name);
  const produced = new Set<string>();
  const unresolvableSpreads: string[] = [];
  const producers: string[] = [];
  for (const file of tsFilesUnder(opts.srcRoot)) {
    const scan = producerAssignedKeys(readFileSync(file, "utf8"), required);
    for (const k of scan.keys) produced.add(k);
    for (const s of scan.spreads) unresolvableSpreads.push(`${file}: ${s}`);
    for (const l of scan.literals) producers.push(`${file}:${l}`);
  }
  const optional = fields.filter((f) => f.optional);
  return {
    unwired: optional.filter((f) => !produced.has(f.name) && !(f.name in allowlist)),
    staleAllowlist: Object.keys(allowlist).filter((n) => produced.has(n)),
    unknownAllowlist: Object.keys(allowlist).filter((n) => !fields.some((f) => f.name === n)),
    unresolvableSpreads,
    producers,
  };
}
