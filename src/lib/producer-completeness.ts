import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { resolveLedgerUnion, type LedgerGrepFsDeps } from "./ledger-grep.js";

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

// ═══════════════════════════════════════════════════════════════════════════════════════════
// SHAPE 5 — DID A WIRED, MERGED FEATURE EVER RUN? (W1-T2408)
// ═══════════════════════════════════════════════════════════════════════════════════════════
//
// W1-T2266 (#2875) named four shapes for "shipped but never adopted": a symbol with no caller,
// a field with no writer, a script with no invoker, a gate with no subject. Its own design note
// (4) says the shapes "differ in where the evidence lives, not merely in what is unadopted" —
// and every one of its corpora is STATIC: a checkout, a `package.json`, a workflow file. All
// four ask "is anything WIRED to it". None of them ask "did it ever RUN".
//
// FOUR MERGED FEATURES PROVED THE GAP. `resolveAccountFilePath` (W1-T997, #2153) HAS a caller
// (`buildServeRoutes`) — shape 1 clears — yet `RMD_ACCOUNT_FILE_PATH` is supplied by no deploy
// artifact and no live container, so the seam never receives a value. Fifteen `panel.*` write
// steps (W1-T2273, #2885) each HAVE a call site inside a route handler — shape 1 clears again —
// yet all fifteen read ZERO across the ledger union, against a CONTROL of the same serve
// process's own `serve.start`/`serve.bind_failed`/`serve.stop` steps reading nonzero from the
// identical file. Wired is not the same claim as ran.
//
// THE METHOD IS BORROWED, NOT REINVENTED. `auditProducerCompleteness` above already owns the
// "zero-with-control" shape — a reading is only trustworthy beside a control proving the same
// read mechanism can see a nonzero. What it does not own is the SCOPE: it answers the question
// only for `OpenPrView`'s optional fields. `auditRuntimeAdoption` below carries that same method
// over two corpora that are neither a checkout nor a package manifest: the ledger union
// (`resolveLedgerUnion`, the rotated + live forms together) and the deployed environment.
//
// DECLARED NAMES COME FROM `src/`, NEVER FROM THE LEDGER'S OWN OBSERVED KEYS. A first attempt at
// this exact measurement kept only ledger-step literals whose PREFIX already appeared somewhere
// in the ledger, as a cheap way to tell a step name from a config key — and that filter read
// `panel.*` at zero, not because the steps fire, but because `panel` had never appeared in the
// ledger at all, so the entire family was discarded by the very condition meant to make it
// interesting. A detector keyed on "steps I have seen" is structurally blind to a feature that
// never ran once. `declaredLedgerSteps`/`declaredEnvVarNames` below scan SOURCE TEXT only.
//
// A GATE IS REFUSED HERE ON PURPOSE. `daemon.cost_governor`/`daemon.queue_governor` also read
// zero, and by `DispatchGovernorState`'s own doc (`account-usage.ts`) neither ever logs "not
// deferring" — only that it IS deferring — so their zero is the HEALTHY state, and nothing
// mechanical separates it from `panel.*`'s inert one. `auditRuntimeAdoption` therefore returns
// ROWS, never a verdict: no `ok`, no `pass`, no `blocking` field anywhere in its output, and a
// row whose name is in `possiblyHealthyZero` carries that as DATA rather than being silently
// dropped or silently trusted. It also emits no per-section "N of M reaching" figure — that
// number would require deciding, per row, whether a zero is inert or healthy, which this method
// has just proven it cannot do from the artefacts alone.

/** Where a {@link RuntimeAdoptionRow}'s live reading was taken from. */
export type RuntimeAdoptionCorpus = "ledger" | "environment";

/** One declared name, and the exact `file:line` it was scanned from — never a ledger key. */
export interface DeclaredRuntimeName {
  name: string;
  /** 1-based `file:line` of the source literal this name was scanned from. */
  declaredAt: string;
}

/** A `"foo.bar"`-shaped dotted lower-case string literal — the same convention every ledger
 *  step name in this repo already follows (`"panel.proposal_accepted"`, `"serve.start"`). */
const LEDGER_STEP_LITERAL = /"([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+)"/g;

/** Excludes literals that only LOOK like a dotted step name because they end in a file
 *  extension (`"package.json"`, `"scripts/foo.mjs"`) — the "minus file-extension shapes"
 *  correction this measurement needed once it stopped filtering by observed ledger prefix. */
const FILE_EXTENSION_TAIL = /\.(ts|tsx|js|jsx|mjs|cjs|json|md|yaml|yml|ndjson|gz|txt|html|css|svg|png|sh)$/i;

/** This repo's one production env-var prefix — matches `RMD_ACCOUNT_FILE_PATH`,
 *  `RMD_ALLOW_LIVE_SPAWN`, and every sibling the same way, as a plain string-literal scan (the
 *  literals are declared as bare strings, e.g. `ACCOUNT_FILE_PATH_ENV = "RMD_ACCOUNT_FILE_PATH"`,
 *  not necessarily behind a `process.env.` prefix at the declaration site). */
const ENV_VAR_LITERAL = /"(RMD_[A-Z0-9_]+)"/g;

/**
 * Every ledger-step-shaped string literal declared under `srcRoot`, scanned from SOURCE TEXT —
 * see this section's header for why the ledger's own observed keys are never consulted. Degrades
 * to `[]` on an unreadable/absent `srcRoot` or file, never throws (Shape 5's "never a gate" rule
 * starts here, not just at the report's own return value).
 */
export function declaredLedgerSteps(srcRoot: string): DeclaredRuntimeName[] {
  return declaredLiterals(srcRoot, LEDGER_STEP_LITERAL, (name) => !FILE_EXTENSION_TAIL.test(name));
}

/**
 * Every `RMD_*`-shaped env-var-name string literal declared under `srcRoot`, scanned from SOURCE
 * TEXT. Same degrade-never-throw discipline as {@link declaredLedgerSteps}.
 */
export function declaredEnvVarNames(srcRoot: string): DeclaredRuntimeName[] {
  return declaredLiterals(srcRoot, ENV_VAR_LITERAL, () => true);
}

function declaredLiterals(srcRoot: string, pattern: RegExp, keep: (name: string) => boolean): DeclaredRuntimeName[] {
  let files: string[];
  try {
    files = tsFilesUnder(srcRoot);
  } catch {
    // An unreadable/absent srcRoot degrades to "no declared names" — never throws (Shape 5's
    // discipline: this report can never become the thing that blocks a merge).
    return [];
  }
  const found = new Map<string, string>();
  for (const file of files) {
    let src: string;
    try {
      src = readFileSync(file, "utf8");
    } catch {
      // A file listed but unreadable by the time we get here (deleted/permissions mid-scan)
      // contributes no literals — same degrade-not-throw discipline as the directory read above.
      continue;
    }
    const lines = src.split("\n");
    for (let i = 0; i < lines.length; i++) {
      for (const m of lines[i].matchAll(pattern)) {
        const name = m[1];
        if (!keep(name) || found.has(name)) continue;
        found.set(name, `${file}:${i + 1}`);
      }
    }
  }
  return [...found.entries()].map(([name, declaredAt]) => ({ name, declaredAt }));
}

function escapeForRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Every regular file under `dir`, any extension — unlike {@link tsFilesUnder} this walks a
 *  deploy tree (yaml, shell, Dockerfiles), so it degrades to `[]` rather than throwing on a
 *  missing/unreadable directory instead of assuming a `.ts`-only checkout shape. */
function allFilesUnder(dir: string, acc: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    // A missing/unreadable deploy dir degrades to "no files under it" — the deploy corpus is
    // then decided by `env` alone, never a thrown error out of a report.
    return acc;
  }
  for (const entry of entries) {
    const p = join(dir, entry);
    let isDir: boolean;
    try {
      isDir = statSync(p).isDirectory();
    } catch {
      // Entry vanished between readdir and stat (race with a concurrent write) — skip it, same
      // best-effort discipline as the readdir degrade above.
      continue;
    }
    if (isDir) allFilesUnder(p, acc);
    else acc.push(p);
  }
  return acc;
}

/** True iff some file under `deployRoot` names `varName` verbatim — the same "0 files under
 *  `deploy/` name it" reading `RMD_ACCOUNT_FILE_PATH` failed. */
function deploySupplies(deployRoot: string | undefined, varName: string): boolean {
  if (!deployRoot) return false;
  for (const file of allFilesUnder(deployRoot)) {
    try {
      if (readFileSync(file, "utf8").includes(varName)) return true;
    } catch {
      // Unreadable/binary file under the deploy tree — skip it and keep scanning the rest;
      // one bad file must never erase the whole deploy-corpus reading.
      continue;
    }
  }
  return false;
}

/** One line of the report: a declared thing, its live reading, the corpus that reading came
 *  from, and the population control that makes a zero legible. Never a verdict — there is no
 *  boolean anywhere on this shape that means "this failed" or "block on this". */
export interface RuntimeAdoptionRow {
  name: string;
  corpus: RuntimeAdoptionCorpus;
  /** `file:line` the name was scanned from — always source, never the ledger's own keys. */
  declaredAt: string;
  /** The live reading: a match count for `ledger`, `0`/`1` (supplied or not) for `environment`. */
  reading: number;
  /** A same-corpus reading proving the read mechanism itself can see a nonzero, so this row's
   *  zero (if it is one) is never printed alone. */
  control: { label: string; reading: number };
  /** True when `name` is on the caller's allowlist of readings this method cannot classify as
   *  inert vs. correctly-rare (e.g. a dispatch governor that only ever logs while deferring). */
  possiblyHealthyZero: boolean;
  /** Set on an allowlisted row (the reason it's there) or when the ledger union itself could not
   *  be read (every ledger reading in that run is UNMEASURED, not a verified zero). */
  note?: string;
}

export interface RuntimeAdoptionOptions {
  /** Where declared ledger-step / env-var literals are scanned from. */
  srcRoot: string;
  /** State dir the ledger union (`resolveLedgerUnion`) is read from. */
  stateDir: string;
  /** Injectable fs surface for the ledger union read — real fs by default. */
  ledgerFsDeps?: LedgerGrepFsDeps;
  /** The environment a live installation actually supplies. Defaults to `process.env`, injected
   *  so a test can drive both "supplied" and "supplied nowhere" without touching the real one. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Where deploy artifacts are scanned for an env-var name they might supply — optional; when
   *  omitted, the environment corpus is decided by `env` alone. */
  deployRoot?: string;
  /** A declared ledger step known to fire on a healthy install — the population control every
   *  ledger-corpus row is checked against. */
  ledgerControlName: string;
  /** A declared env var known to be supplied everywhere — the population control every
   *  environment-corpus row is checked against. */
  envControlName: string;
  /** Declared names whose zero this method cannot classify as inert vs. correctly-rare, each
   *  with the reason it's there — same allowlist-is-the-design discipline as
   *  {@link KNOWN_UNWIRED} above, applied to a different corpus. */
  possiblyHealthyZero?: Readonly<Record<string, string>>;
}

/**
 * Shape 5: does a declared ledger step or env var ever show a live, nonzero reading — never a
 * verdict, always rows. See this section's header for the method, the four merged instances that
 * motivated it, and why a gate is refused. NEVER THROWS: every I/O path degrades (an unreadable
 * `srcRoot`, an absent `stateDir`, a `deployRoot` that doesn't exist all read as "found nothing"
 * rather than propagating), so this can never become the thing that blocks a merge.
 */
export function auditRuntimeAdoption(opts: RuntimeAdoptionOptions): RuntimeAdoptionRow[] {
  const rows: RuntimeAdoptionRow[] = [];
  const healthy = opts.possiblyHealthyZero ?? {};

  // ── LEDGER CORPUS — one resolveLedgerUnion pass covers every declared step plus the control,
  // never one pass per name, so a large declared list costs one read, not N. ──
  const steps = declaredLedgerSteps(opts.srcRoot);
  const namesToMatch = new Set(steps.map((s) => s.name));
  namesToMatch.add(opts.ledgerControlName);
  const ledgerCounts = new Map<string, number>();
  let ledgerNote: string | undefined;
  try {
    const pattern = new RegExp(`"step":"(?:${[...namesToMatch].map(escapeForRegExp).join("|")})"`);
    const union = resolveLedgerUnion(opts.stateDir, pattern, opts.ledgerFsDeps);
    if (!union.ok) {
      ledgerNote =
        `ledger union unreadable at ${opts.stateDir} (archiveCount=${union.archiveCount}, ` +
        `unread=${union.unread.length}) — every ledger reading below is UNMEASURED, not a verified zero`;
    } else {
      for (const line of union.matches) {
        for (const name of namesToMatch) {
          if (line.includes(`"step":"${name}"`)) ledgerCounts.set(name, (ledgerCounts.get(name) ?? 0) + 1);
        }
      }
    }
  } catch (err) {
    // A thrown ledger read carries the distinction forward as a `note` on every row below
    // (never erased) — the caller sees UNMEASURED, not a silently-swallowed verified zero.
    ledgerNote =
      `ledger union read threw: ${err instanceof Error ? err.message : String(err)} — every ledger ` +
      `reading below is UNMEASURED, not a verified zero`;
  }
  const ledgerControlReading = ledgerCounts.get(opts.ledgerControlName) ?? 0;
  for (const step of steps) {
    const allowlisted = step.name in healthy;
    rows.push({
      name: step.name,
      corpus: "ledger",
      declaredAt: step.declaredAt,
      reading: ledgerCounts.get(step.name) ?? 0,
      control: { label: opts.ledgerControlName, reading: ledgerControlReading },
      possiblyHealthyZero: allowlisted,
      note: allowlisted ? healthy[step.name] : ledgerNote,
    });
  }

  // ── ENVIRONMENT CORPUS ──
  const env = opts.env ?? process.env;
  const envNames = declaredEnvVarNames(opts.srcRoot);
  const suppliedReading = (name: string): number =>
    env[name] !== undefined || deploySupplies(opts.deployRoot, name) ? 1 : 0;
  const envControlReading = suppliedReading(opts.envControlName);
  for (const v of envNames) {
    const allowlisted = v.name in healthy;
    rows.push({
      name: v.name,
      corpus: "environment",
      declaredAt: v.declaredAt,
      reading: suppliedReading(v.name),
      control: { label: opts.envControlName, reading: envControlReading },
      possiblyHealthyZero: allowlisted,
      note: allowlisted ? healthy[v.name] : undefined,
    });
  }

  return rows;
}
