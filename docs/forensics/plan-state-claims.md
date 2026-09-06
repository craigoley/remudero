# plan-state-claims.mjs comment forensics

The measured incidents, design arguments and rejected alternatives that were removed from
`scripts/plan-state-claims.mjs` when its comments were compacted to the plain-language standard
(docs/comment-standard.md). Nothing was cut: each section below is the file's own prose, verbatim,
under a heading naming the symbol it explained. The file itself keeps a one-line `// Why:` pointer
wherever the history mattered.

Line numbers below are positions in `scripts/plan-state-claims.mjs` at the merge base of the
compaction PR (`origin/main`).

## Why this gate exists

Removed from lines 2-45.

```
// scripts/plan-state-claims.mjs
//
// PLAN-STATE SELF-CONSISTENCY gate (W1-T409, MASTER-PLAN §8A/§12A).
//
// W1-T392 split into two halves along the seam its own design note drew: THIS half reads
// MASTER-PLAN.md against ITSELF (offline, no network, no live GitHub state — claims.yaml's own
// contract); W1-T410 (src/lib/retro.ts's planStateTruthRung) reads it against GitHub merge state.
// THIS HALF WOULD NOT HAVE CAUGHT THE W1-T149 INCIDENT — a consistency check over two lists cannot
// see an id absent from BOTH. It is filed anyway because a document that contradicts itself (an id
// recorded as landed in the SHIPPED log while another line asserts it did not land) is a real,
// decidable defect with a real gate available.
//
// WHAT IS REFUSED: a task id appearing BOTH in the "## SHIPPED log" section of MASTER-PLAN.md AND
// in a not-shipped assertion (the vocabulary W1-T410 established: "not shipped", "unbuilt", "did
// not ship") anywhere else in the same file.
//
// THE SHIPPED-LOG EXTRACTOR READS BOTH NOTATIONS the section actually uses: full `W<n>-T<n>` ids,
// and the house-style COMPRESSED PAIR `T<n>/#<pr>` a long-form-only regex cannot see (measured:
// 197 of 284 distinct SHIPPED-log task numbers appear ONLY in compressed-pair form). The bare
// number carries no workstream prefix — the section mixes W1/W2/W3 — so it is resolved against the
// PLAN'S OWN id set (plan/tasks.yaml + plan/tasks.d/*.yaml, loaded via lib/plan.ts's `loadPlan`,
// the same merge every other consumer uses) rather than guessed by prepending `W1-`. An id the plan
// does not know is not resolved and is never invented into a contradiction.
//
// THE NOT-SHIPPED EXTRACTOR REUSES `extractAssertedUnbuiltTaskIds` (src/lib/retro.ts, shipped by
// W1-T410) rather than re-deriving the clause-scoped phrase-binding logic a second time — the
// reuse obligation both split tasks' design notes name explicitly. That function's `ids` are the
// ones this gate treats as "asserted not-shipped"; the per-line citation this gate prints alongside
// a contradiction is derived locally (the exported type carries counts, not per-id line refs) by
// re-scanning for the same not-shipped vocabulary next to the id's text — a display-only lookup,
// never a second membership decision.
//
// A POSITIVE CONTROL, ONE PER SIDE, ON THE FACT THAT DISTINGUISHES A BROKEN SCAN FROM AN HONEST
// EMPTY RESULT (W1-T1232): the shipped-log side has no "read but bound nothing" state, so
// `shippedExamined === 0` still exits non-zero as UNEXAMINED unconditionally. The not-shipped side
// reuses `extractAssertedUnbuiltTaskIds`'s `examinedLines` (phrase-bearing lines READ, whether or
// not a task id bound) rather than the bound-id count: `notShippedLinesExamined === 0` means the
// phrase extractor matched nothing anywhere in the document — a suspect scan (renamed vocabulary,
// encoding fault) — and still exits UNEXAMINED. A region the extractor READ but bound no id in
// (every phrase-bearing clause named a proposal or nothing) is an honest absence, not a broken
// scan, and is reported OK — see MASTER-PLAN.md's rule 9, which tells an author to DELETE a
// corrected id from this region rather than annotate it, and which this distinction exists to
// keep from tripping the gate. The rendered report names the phrase-bearing line count either way.
```

WHY THIS MATTERS. W1-T392 split the plan-state consistency check along an offline/online seam: this
half reads MASTER-PLAN.md against only itself, while W1-T410's `planStateTruthRung`
(`src/lib/retro.ts`) reads it against real GitHub merge state. This offline half would not have
caught the W1-T149 incident — a consistency check over two lists in the same document cannot see an
id that is absent from both — and is filed anyway because a self-contradicting document (an id
recorded as landed while another line asserts it did not land) is a separate, decidable defect. The
SHIPPED-log extractor reads both the long-form `W<n>-T<n>` id and the house-style compressed pair
`T<n>/#<pr>`, because measured, 197 of 284 distinct SHIPPED-log task numbers at filing time appeared
only in compressed-pair form; a bare compressed-pair number carries no workstream prefix, so it is
resolved against the plan's own known id set rather than guessed by prepending `W1-`, and an
unrecognized number is never invented into a contradiction. The not-shipped extractor reuses
`extractAssertedUnbuiltTaskIds` (`src/lib/retro.ts`, W1-T410) rather than re-deriving its
clause-scoped phrase-binding logic a second time, per both split tasks' design notes; the per-line
citation this gate prints is a separate, display-only re-scan for the same vocabulary, never a
second membership decision.

## The positive control

Removed from lines 34-44 (folded into the section above); reproduced separately here because it is
the gate's own falsifiability argument (W1-T1232). The shipped-log side has no "read but bound
nothing" state, so `shippedExamined === 0` always exits UNEXAMINED. The not-shipped side instead
reuses `extractAssertedUnbuiltTaskIds`'s `examinedLines` — phrase-bearing lines actually read,
whether or not a task id bound — rather than the bound-id count, because
`notShippedLinesExamined === 0` means the phrase extractor matched nothing anywhere in the document
at all (a suspect scan: renamed vocabulary, an encoding fault), which must still exit UNEXAMINED. A
region the extractor read but bound no id in — every phrase-bearing clause named a proposal or
nothing — is an honest absence, not a broken scan, and is reported OK. MASTER-PLAN.md's rule 9 tells
an author to delete a corrected id from this region rather than annotate it, which is exactly the
distinction this control exists to keep from tripping the gate. The rendered report names the
phrase-bearing line count either way.

## The two extractors

Removed from the same header block (lines 18-32), reproduced above; the design argument for why
`extractShippedLogIds` and `notShippedLines`/`firstNotShippedLine` are shaped the way they are.

## extractShippedLogIds

Removed from lines 107-114 (the JSDoc; the function body was unchanged).

```
/**
 * Extract every task id the `## SHIPPED log` section records as landed, in EITHER notation, bound
 * to the line (1-indexed) and line text that first recorded it — design (iv)'s citation.
 *
 * `knownIds`: the plan's own id set (lib/plan.ts `loadPlan`). A long-form `W<n>-T<n>` match is
 * taken as-is (unambiguous). A compressed-pair `T<n>/#<pr>` match resolves ONLY when exactly one
 * known id ends `-T<n>` — zero or multiple candidates means the number is not resolved and is
 * dropped, never invented (design (ii)/acceptance criterion 4).
 */
```

## renderReport

Removed from lines 212-226 (the JSDoc; the function body was unchanged).

```
/** Render {@link checkPlanStateConsistency}'s result as the CLI's human-readable report. Three
 *  DISTINCT shapes (design (iii)): UNEXAMINED never reads like OK, and OK never reads like a
 *  contradiction report -- "zero contradictions found and zero claims examined must never print
 *  the same text". UNEXAMINED fires on `shippedExamined === 0` (unchanged) or
 *  `notShippedLinesExamined === 0` (W1-T1232: no not-shipped-phrase-bearing line was read at all --
 *  a broken scan) -- NEVER on `notShippedExamined === 0` alone, which just means every
 *  phrase-bearing line that WAS read bound a proposal or nothing, an honest empty result. All
 *  three shapes name the phrase-bearing line count so a reader can tell which case fired.
 *
 *  W1-T2223 (design (i)/(ii)): the contradiction report lists EVERY not-shipped citation site for
 *  an id, not only the first, and when a not-shipped site resolves to the SAME physical line as
 *  the shipped citation it is folded into one combined "SHIPPED AND NOT-SHIPPED" line rather than
 *  printed twice under the same line number -- a reader must not have to notice that for
 *  themselves. An id with exactly one citation site whose line differs from the shipped line
 *  renders exactly as it always has (design criterion 5). */
```

The inline comment at the site that folds a same-line not-shipped citation into the SHIPPED line
(`scripts/plan-state-claims.mjs`, inside the `for (const c of contradictions)` loop) read, before
compaction: `// design (ii): a not-shipped site sharing the shipped citation's exact line number
reads as ONE combined line, never as a SHIPPED line followed by a NOT-SHIPPED line naming the same
number -- that duplication is what made a genuinely two-site contradiction (#2718) read as a
single-site one.` MEASURED: PR #2718 is the incident this fold exists to prevent — a genuinely
two-site contradiction that read as single-site before the fold was added.

## Smaller compacted comments

These carried narrower design notes, not measured incidents; each is reproduced verbatim because
compaction replaced its wording rather than merely shortening it in place.

**`NOT_SHIPPED_PHRASE_RE`** (lines 64-67): `/** Mirrors src/lib/retro.ts's own (module-private)
NOT_SHIPPED_PHRASE_RE — duplicated here ONLY to locate a citation LINE for an id
extractAssertedUnbuiltTaskIds already decided is asserted not-shipped; it is never used to decide
membership (that decision is entirely the reused function's), so this is a display lookup, not a
second phrase-extractor. */`

**`shippedLogLineRange`** (lines 70-72): `/** The \`## SHIPPED log\` section's line range within
\`lines\` (0-indexed, \`start\` inclusive of the first line AFTER the header, \`end\` exclusive) —
from the header to the next \`## \` heading, or EOF. \`{ start: -1, end: -1 }\` when no
\`## SHIPPED log\` heading exists at all. */`

**`numberToKnownIds`** (lines 92-94): `/** Every known task id's trailing number (\`W1-T148\` ->
\`["148", "W1-T148"]\`) as a number -> ids map, so a bare compressed-pair number resolves ONLY when
the plan's own id set names exactly one id ending \`-T<number>\` — never invented, never guessed by
prefix. */`

**`notShippedLines`** (lines 139-144): `/** Every line (1-indexed), in document order, asserting
\`id\` not-shipped -- the contradiction citation's full site list (design (i), W1-T2223). A second,
independent not-shipped site for the same id must not be invisible just because a different site
happens to sort first; see the module doc's note on why this is a display-only re-scan, not a
second extractor -- membership (which ids are contradictions at all) is decided entirely by
\`extractAssertedUnbuiltTaskIds\`, never by this function or by \`NOT_SHIPPED_PHRASE_RE\`. */`

**`notShippedLines`'s inline comment** (lines 146-147): `// Only a W1- id can appear in bare
\`T<n>\` form -- extractAssertedUnbuiltTaskIds's own normalizeAssertedTaskId assumes bare T<n>
means W1-T<n> throughout this corpus.`

**`firstNotShippedLine`** (lines 162-166): `/** The first line (1-indexed) asserting \`id\`
not-shipped. Kept as the single-site lookup its name has always promised (design (i): "the
function's name is honest — it returns the first — so the fix is at the record, not at the name");
{@link notShippedLines} is now the contradiction record's actual citation source. \`undefined\`
when \`id\` is never asserted not-shipped anywhere, same as before. */`

**`checkPlanStateConsistency`** (lines 171-181): `/** The gate's whole decision: every SHIPPED-log
id (both notations, short-form resolved against \`knownIds\`) crossed against every not-shipped id
(reused from W1-T410's \`extractAssertedUnbuiltTaskIds\`). \`contradictions\` names each id found on
both sides, with a citation line from the shipped side and EVERY not-shipped citation site (design
(i)/(iv), W1-T2223 -- not only the first one found). \`shippedExamined\` and
\`notShippedLinesExamined\` are the positive control's two counts (design (iii)) — both must be
nonzero for a scan to count as having examined anything at all (W1-T1232: the not-shipped side's
control is the PHRASE-LINE count, not the bound-id count — see the module doc).
\`notShippedExamined\` is the bound-id count, carried through separately so the report can still say
how many ids it found. */`

**`checkPlanStateConsistency`'s inline comment** (lines 191-192): `// W1-T2223 (design (i)): every
not-shipped site, not just the first -- a second, independent citation for the same id must not be
invisible just because a different site sorts first.`

**`main`'s inline comment** (lines 304-309): `// No try/catch here, unlike the two reads above:
\`masterPlanMd\` is always a string (readFileSync succeeded with an explicit "utf8" encoding) and
\`knownIds\` is always an array of validated, non-empty string ids (loadPlan's own
parseTasksFromYaml rejects a task with a missing/blank id before this line is ever reached) --
checkPlanStateConsistency's extractors are pure string/regex operations over those two
guaranteed-valid inputs and have no other failure mode to catch.`
