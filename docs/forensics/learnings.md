# learnings.ts forensics

The measured forensics, incident narratives and design arguments removed from
`src/lib/learnings.ts` when its comments were compacted to the plain-language standard.
Every block below is the removed text verbatim, marker characters stripped and nothing
else changed. Headings name the symbol the text explained; the code keeps a one-line
`// Why:` pointer where the history mattered. Base revision: origin/main at 5c5e21aae988c2a7a7f4d2b89f3d54643ef94150;
the line numbers below are that revision's.

## Module header

### Base lines 7-134 — Promptsmith — the READ side…

Promptsmith — the READ side of the compounding thesis (WS-8, W1-T19; SPLIT +
INDEX + SUPERSESSION, W1-T33).

LEARNINGS.md is written by diagnosing workers and read back only by
`retroCommand` (src/run-task.ts), which folds it into the retro's own
context — never by an ordinary implement worker. This module closes THAT
gap: it injects, into every rendered implement prompt,
  (a) DISTRUST THE PROMPT OVER THE INSTALLED VERSION (Standing rule 7),
  (b) the autonomy clause (Standing rule 8), and
  (c) the LEARNINGS entries whose file-globs MATCH the task.

Matching is DETERMINISTIC by `files:` globs — never semantic — so only
relevant facts inject. A KNOWLEDGE BUDGET caps the injected chars so a growing
learnings file can never become an unbounded context tax; over budget the
highest-relevance / most-recently-cited entries win and the rest are DROPPED
(logged). Every injected line carries `[src: learnings#<id>]`, so the rendered
prompt still passes the provenance linter (Standing rule 1).

The machine-readable source of truth is the `learnings/` directory: one flat
corpus file becomes a SCAN as it grows, so W1-T33 split it into subsystem
shards — `learnings/{platform,architecture,ci,testing,failures}.yaml` — plus
a GENERATED index (`learnings/index.json`, `scripts/generate-learnings-index.mjs`,
`npm run learnings-index`) mapping each shard to the entry ids and file-globs it
carries. `loadLearningsForTaskFiles` uses that index to LOOK UP only the shard
files a task could possibly match, instead of parsing the whole corpus every
time. The prose `LEARNINGS.md` stays the human/Architect-owned narrative
(MASTER-PLAN governance) and is intentionally NOT parsed here.

SUPERSESSION: an entry carries `lifecycle: active | superseded | quarantined`
(default `active`). Provenance decays — a fact can become FALSE — so a
`superseded` entry is NEVER injected (`selectLearnings` filters it out before
ranking); it stays in its shard file for provenance only, optionally naming
the entry that replaced it via `superseded_by`.

SELF-VERIFICATION (W1-T34): an entry may additionally carry an `assertion` —
a shell command that must exit 0 for the fact to still be considered true (a
fact pinned to, say, an SDK version must not keep being injected once the SDK
moves). `scripts/learnings-assert-check.mjs` runs every entry's assertion; a
FAILING one flips that entry's committed `lifecycle` to `quarantined` (and
records why in `quarantined_reason`) — the exact same generate-and-`--check`
shape as the W1-T33 index (`npm run learnings-assert` mutates the shard,
`npm run learnings-assert:check` fails CI when the committed corpus doesn't
match a fresh re-verification, naming the stale entry). A `quarantined`
entry is filtered out by `selectLearnings` exactly like `superseded` — this
module never itself executes an assertion, keeping injection a pure, fast,
non-shelling lookup. Re-verification (the assertion passing again) is what
lets a subsequent `npm run learnings-assert` restore `lifecycle: active`.

CONTRADICTION DETECTION (W1-T88, ratifies P14, extends W1-T33): plain
supersession above is RECENCY-OVERWRITE — a newer entry silently wins.
That is correct for a REFINEMENT but wrong for a CONTRADICTION (a wrong
late lesson could otherwise bury a right early one with no signal). The
consolidation pass (retro.ts's `keyContradictionCandidates` +
`flagContradictions` + `applyContestedLifecycle`) detects a candidate pair
DETERMINISTICALLY (same subsystem + overlapping `files` globs) and asks an
advisory judge whether the pair OPPOSES; an opposing pair is NEVER
auto-resolved — both entries flip to `lifecycle: contested` (filtered out
by `selectLearnings` exactly like `superseded`/`quarantined`) and the pair
surfaces in the retro report and the §2 question backlog until an
Architect-authored, ledgered resolution (retro.ts's
`applyContradictionResolution`) re-admits the winner as `active` and marks
the loser `superseded`. A refining (non-opposing) newer entry still
supersedes exactly as before — contradiction detection narrows
recency-overwrite, it does not replace it.

LAYERS (P32/W1-T145): the corpus this file parses is the PROJECT layer —
repo-scoped, everything above. P32 proposes two more: USER-OVERALL
(cross-project, one fleet-readable home outside any single repo checkout,
`userOverallLearningsHome` in config.ts) and RMD-GLOBAL (cross-user,
opt-in, a versioned HASH-PINNED artifact, `globalLearningsHome` in
config.ts / {@link loadGlobalArtifact} here). ONE entry shape
({@link LearningEntry}, unchanged except for the new optional `layer`
field) is valid at every layer — the SAME `parseLearningsDoc` validates a
project shard, a user-overall shard, and a global artifact's `entries`
identically, so an entry can move between layers without reshaping.
{@link loadLayeredLearnings} reads all three homes in precedence order
(project, then user-overall, then global) into one merged corpus.

PROMOTION (P32/W1-T146): {@link promoteEntry} decides whether ONE entry
rises a layer. Promotion is a strict two-stage pipeline, SCRUB then JUDGE,
never the reverse: (1) {@link scrubEntry} is a DETERMINISTIC leak-grep
analog (secret-pattern regexes) plus a PII detector; a hit BLOCKS
promotion and the judge is NEVER invoked (the opt-in, error-reporting
model — nothing project-identifying reaches an LLM call without first
clearing scrub). (2) only once scrub passes does {@link
PromotionJudgeDeps.judge} — an injected, advisory LLM applicability
eval, mirroring flight-judge.ts's `deps.judge` shape so promotion stays
unit-testable without a real spawn — decide project-specific (stays) vs
broadly-applicable (promotes one layer up, via {@link
planPromotionFromVerdict}). The judge is FAIL-CLOSED: a parse failure, a
missing verdict, or a confidence below {@link
planPromotionFromVerdict}'s threshold all resolve to "does not promote" —
uncertainty never promotes. A promoted entry's `src` provenance survives
REDACTED ({@link redactProvenance} strips repo-identifying specifics —
task ids, PR/issue numbers — while keeping the origin's shape), never
dropped outright. {@link runPromotionPass} batches {@link promoteEntry}
over a corpus. The PER-LAYER BUDGET RATCHET ({@link
computeLayerBudgetUsage} / {@link evaluateLayerBudgetRatchet}) extends
learnings-budget-ratchet's (W1-T38, scripts/learnings-budget-ratchet.mjs)
injectable-weight measurement so each layer's active corpus is capped
INDEPENDENTLY, rather than one global ceiling across all three layers.

TRANSPORT (§6, W1-T425): {@link buildExportBundle}/{@link renderExportBundle}
(the SENDING side) and {@link verifyBundlePin} (the RECEIVING side's
pre-write pin check) are what actually MOVE entries onto a populated
global home — the piece the paragraph above used to call "still deferred."
Exportability is FIELD-LEVEL OPT-IN, never a redaction guess: an entry
carries `share: public` (any other value or omission is private forever)
and {@link selectExportableEntries} only ever includes an entry that says
so explicitly. `buildExportBundle` runs {@link scrubEntry} — the same
leak-grep/PII analog {@link promoteEntry} already gates on — over every
candidate as a SECOND, INDEPENDENT floor beneath the opt-in declaration,
and refuses (naming the entry) on a hit; zero opted-in entries refuses
with a reason rather than writing an empty-but-valid bundle (the vacuous-
export twin of the naked-zero rule). The bundle is the exact
{@link GlobalArtifact} shape (version/hash/entries) {@link
loadGlobalArtifact} already parses, plus a `provenance` block (source
repo, source sha, export date) that travels alongside the hash but is
NEVER hashed or re-verified — only `entries` is. On import,
`verifyBundlePin` checks the bundle's OWN declared `hash` against an
operator-supplied pin (communicated out-of-band, e.g. alongside the
export's printed hash) BEFORE anything is written to the global home; it
deliberately does not re-derive the hash from `entries` itself — that
check is {@link loadGlobalArtifact}'s job, run again at prompt-assembly
time, so import never bypasses or reimplements the tamper check, it only
places the artifact where the existing guard already looks.

## DEFAULT_KNOWLEDGE_BUDGET_CHARS

### Base lines 148-162 — Default KNOWLEDGE BUDGET: the max…

Default KNOWLEDGE BUDGET: the max chars of MATCHED-learning fact lines injected
per prompt. The two doctrine lines above are mandatory and NOT counted against
it — only the growing, file-matched corpus is capped.

PINNED, NOT PICKED (W1-T941): this figure must equal
scripts/knowledge-budget-baseline.json's `capChars` — the recorded output of
src/lib/digest.ts's `deriveKnowledgeBudgetCap` (measured dropped-fact weight
at p50/p90 over `learnings.injected` ledger rows, joined against
{@link buildEntryWeightIndex}, and priced in tokens against the measured
cache-hit mix). test/knowledge-budget-derivation.test.ts's drift test fails
if this constant and the baseline's `capChars` ever disagree — raising it is
a reviewed diff to that baseline file, backed by its own arithmetic, never a
bare edit of the literal here.

## Lifecycle

### Base lines 165-182 — An entry's LIFECYCLE (W1-T33 +…

An entry's LIFECYCLE (W1-T33 + W1-T34 + W1-T88/P14). `active` (the
default) is a candidate for injection. `superseded` means provenance
decayed by human correction — a newer entry replaced this fact — and the
entry stays in its shard for the historical record. `quarantined` means
provenance decayed AUTOMATICALLY: the entry's `assertion` currently fails,
so `scripts/learnings-assert-check.mjs` flipped it here. `contested`
(W1-T88, ratifies P14) means the consolidation pass's contradiction
detection (retro.ts's `flagContradictions`/`applyContestedLifecycle`)
found this entry OPPOSING another active entry on the same subsystem/files
— recency-overwrite is explicitly refused for a contradiction (it is
refused ONLY there; a non-opposing refinement still supersedes exactly as
before), so BOTH entries in the pair are marked `contested` until an
Architect resolves which one governs (retro.ts's
`applyContradictionResolution`). ALL FOUR of `superseded`/`quarantined`/
`contested` are filtered out by `selectLearnings` before ranking, so none
can ever be injected into a rendered prompt.

## Layer

### Base lines 185-191 — Which knowledge layer an entry…

Which knowledge layer an entry lives at (P32/W1-T145): `project`
(repo-scoped, the default), `user-overall` (cross-project, one operator's
fleet), or `global` (cross-user, opt-in, hash-pinned). Layer is ORTHOGONAL
to lifecycle — it says WHERE an entry is read from, not whether it is
injectable.

## Share

### Base lines 197-203 — The only valid non-absent value…

The only valid non-absent value of an entry's `share` field (§6, W1-T425):
`"public"`. There is deliberately no `"private"` counterpart — omitting
the field (or an entry predating this field entirely) already means
private, so a second spelling of the same state would just be another way
to get it wrong.

## LearningEntry.contestedWith

### Base lines 216-221 — (contested entries only, W1-T88/P14) the…

(contested entries only, W1-T88/P14) the id of the OTHER entry this one
was found opposing — set on BOTH members of a contested pair, so a human
reading either entry in its shard can find its counterpart without
cross-referencing the retro report or the question backlog.

## LearningEntry.assertion

### Base lines 223-227 — (W1-T34) An optional shell command…

(W1-T34) An optional shell command (run via `sh -c` from the repo root)
that must exit 0 for this entry's `fact` to still be considered true.
Verified by `scripts/learnings-assert-check.mjs`, never by this module.

## LearningEntry.quarantinedReason

### Base lines 229-233 — (quarantined entries only, W1-T34) why…

(quarantined entries only, W1-T34) why `learnings-assert-check.mjs`
auto-quarantined this entry — the failing assertion plus its exit code,
recorded so a human reading the shard sees why without re-running it.

## LearningEntry.operatorImpact

### Base lines 235-242 — (W1-T50) Marks a `failures`-subsystem incident…

(W1-T50) Marks a `failures`-subsystem incident whose SYMPTOM is
operator-visible (something you'd see running `rmd`, not only in a
worker's internal diff). Optional; defaults to `false` — most failures
entries are dev-time postmortems, not operator-facing. `true` obligates a
matching `docs/troubleshooting.md` entry; `checkTroubleshootingCoverage`
(src/lib/review.ts) enforces that at review time from the diff alone.

## LearningEntry.drillObligating

### Base lines 244-252 — (W1-T939) Marks a `failures`-subsystem incident…

(W1-T939) Marks a `failures`-subsystem incident whose GUARD carried the fleet through it and
can be injected into a `scripts/recovery-drill.mjs` fixture (`RECOVERY_PATHS`, W1-T366/
W1-T938) — sibling obligation to {@link operatorImpact}, one level narrower: "this incident's
guard belongs in the drill library." Optional; defaults to `false` — most failures entries are
dev-time postmortems about a rule, a lint or a stale criterion, with no guard to inject. `true`
obligates a matching drill-table touch in the same diff; `checkDrillCoverage`
(src/lib/review.ts) enforces that at review time from the diff alone.

## LearningEntry.layer

### Base lines 254-260 — (P32/W1-T145) Which knowledge layer this…

(P32/W1-T145) Which knowledge layer this entry lives at. Optional;
DEFAULTS TO `"project"` when omitted — every pre-existing shard entry
(written before this field existed) is a project entry with no edit
required. Use {@link entryLayer} to read the defaulted value rather than
this raw (possibly-`undefined`) field directly.

## LearningEntry.share

### Base lines 262-270 — (§6, W1-T425) The transport opt-in:…

(§6, W1-T425) The transport opt-in: `share: public` marks this entry
exportable via `rmd learnings export`. Optional; DEFAULTS TO PRIVATE
FOREVER when omitted (or set to anything but the literal `"public"`) —
{@link selectExportableEntries} only ever includes an entry that
declares this explicitly, never one the exporter guesses is safe.
Sharing is a per-entry OPERATOR act, exactly like ratification; this
module never sets it and zero entries are stamped by W1-T425 itself.

## LearningEntry.cited

### Base lines 278-284 — Optional ISO date last cited;…

Optional ISO date last cited; recent entries win a budget tie. Historically hand-stamped at
consolidation time; W1-T419's retro.ts miner (`mineLedgerCitations` + `mineGitLogCitations`
+ `stampCitations`) now derives it from measured evidence — a `learnings.injected` ledger
row's `matched_ids` or a `learnings#<id>` git-log citation — so a growing `cited_count` (see
below) backs any date this field carries going forward.

## LearningEntry.citedCount

### Base lines 286-294 — (W1-T419) Optional total count of…

(W1-T419) Optional total count of measured citation evidence occurrences (ledger
`matched_ids` rows + git-log `learnings#<id>` mentions) backing {@link cited}. Absent means
no evidence has been mined for this entry yet — the budget ratchet
(scripts/learnings-budget-ratchet.mjs) renders that as `never-cited`, never as zero.
selectLearnings' ranking does NOT read this field (still keyed on `cited` alone); it exists
so the ratchet's compression-candidate ordering can distinguish "cited once, long ago" from
"cited constantly" beyond what a single date captures.

## parseLearningsDoc

### Base lines 335-341 — Parse one already-loaded YAML document…

Parse one already-loaded YAML document (a list of entry mappings) into
validated `LearningEntry` records, checking ids against the supplied `seen`
set so a caller can share one set across MULTIPLE files (cross-shard
duplicate-id detection) or pass a fresh one for single-file loading.
`sourceLabel` is only used to make error messages point at the right file.

## parseLearningsDoc — the share opt-in

### Base lines 425-427 — The `share: public` opt-in (§6,…

The `share: public` opt-in (§6, W1-T425). Any other non-absent value is a
usage error, not silently treated as private — a typo here must fail loud,
never fail open into "I guess this one's fine to omit from a bundle."

## projectLearningsHome

### Base lines 463-470 — The PROJECT layer's home (P32/W1-T145):…

The PROJECT layer's home (P32/W1-T145): the repo-relative directory
`loadLearningsCorpus`/`loadLearningsForTaskFiles` already read (W1-T33's
shard split — `run-task.ts` derives this same path inline today as
`join(dirname(planPath), "..", "learnings")`; this helper names it so
project, {@link userOverallLearningsHome}, and {@link globalLearningsHome}
(config.ts) read as one symmetric set of layer-home functions).

## PROJECT_LEARNINGS_SHARD_NAMES

### Base lines 475-482 — The five subsystem shard names…

The five subsystem shard names THIS repo's own corpus is split into (W1-T33 SPLIT —
`learnings/{architecture,ci,failures,platform,testing}.yaml`). `rmd onboard --phase
synthesize` (W1-T2505) seeds an onboarded target repo's {@link projectLearningsHome} with the
SAME split rather than inventing a new one, so {@link loadLearningsCorpus} and the generated
{@link loadLearningsIndex} loader work UNCHANGED against an onboarded repo, exactly as they do
against this one.

## seedProjectLearningsHomeFiles

### Base lines 508-520 — The seeded project learnings home's…

The seeded project learnings home's file contents (W1-T2505), keyed by filename RELATIVE to
the home directory (never a full path — the caller, `rmd onboard --phase synthesize`, decides
where the home itself lives): the five empty subsystem shards ({@link
PROJECT_LEARNINGS_SHARD_NAMES}) plus a matching `index.json`.

The `index.json` value is exactly what `scripts/generate-learnings-index.mjs`'s own
`buildIndex`/`serializeIndex` would produce from five empty shards (every shard maps to
`{entries: [], globs: []}`, `bySubsystem` empty) -- reproduced here rather than shelled out to,
since onboarding writes through its own injected fs seam (never a child process), and an empty
corpus's index is fully determined regardless. `npm run learnings-index:check`-equivalent
tooling in the seeded repo will find this `index.json` already fresh.

## loadLearningsCorpus

### Base lines 552-561 — Parse EVERY `*.yaml` shard in…

Parse EVERY `*.yaml` shard in `dir` (sorted by filename for determinism) into
one merged corpus (W1-T33 SPLIT). Ids are checked for uniqueness ACROSS every
shard, not just within one — two shards defining the same id is a corpus
error, same as a single-file duplicate. A MISSING directory is not an error —
returns `[]` (no corpus yet, same convention as {@link loadLearnings}).
Includes `superseded` entries (callers that must never inject them, i.e.
`selectLearnings`, filter those out themselves); this is the full corpus,
kept for provenance/index purposes too.

## entryBudgetWeight

### Base lines 587-594 — Compute a per-entry char weight…

Compute a per-entry char weight that budget accounting counts against —
the RENDERED injectable line length (P32/W1-T145; the shape
`selectLearnings` already used inline, now named/exported so it is the ONE
definition every layer/caller — including the future per-layer ratchet,
W1-T146 — measures "budget-counted" against, rather than each re-deriving
its own render).

## buildEntryWeightIndex

### Base lines 599-606 — id -> {@link entryBudgetWeight} (+1…

id -> {@link entryBudgetWeight} (+1 for the joining "\n", same convention `selectLearnings`/
`computeLayerBudgetUsage` fold in) for every entry in `entries` (W1-T941). A `learnings.injected`
ledger row only carries dropped entry IDS, never their weight — this is the lookup
src/lib/digest.ts's `measureKnowledgeBudgetPressure` joins those IDs against to size the
dropped-fact WEIGHT a budget derivation needs, without digest.ts importing this module's
corpus-loading machinery.

## GlobalArtifact

### Base lines 615-624 — The RMD-GLOBAL layer's artifact shape…

The RMD-GLOBAL layer's artifact shape (P32/W1-T145): a VERSIONED,
content-addressed bundle of {@link LearningEntry} records. `hash` pins the
artifact's own content — {@link computeArtifactHash} recomputed over
`entries` must equal it, or the artifact is a forgery/corruption and
{@link loadGlobalArtifact} refuses it. The transport that produces/pulls
this file (opt-in POST up / hash-pinned pull down, §6, DECISIONS.md
distribution-architecture Tier 3) is DEFERRED — this is only the shape a
pulled artifact must satisfy to be trusted.

## computeArtifactHash

### Base lines 633-639 — Deterministic sha256 content hash of…

Deterministic sha256 content hash of a set of layered-learnings entries
(P32/W1-T145). Sorted by `id` first so ENTRY ORDER never changes the hash —
only content does — then hashed over each field the schema defines
(`undefined` optionals normalized to `null` so an omitted field hashes
identically regardless of which code path produced the in-memory object).

## GLOBAL_ARTIFACT_ABSENT_REASON_PREFIX

### Base lines 661-669 — The exact reason-string PREFIX {@link…

The exact reason-string PREFIX {@link loadGlobalArtifact} emits for a missing artifact — the
ONE `catch` around `readFileSync`, and the ONLY designed/deferred-§6-transport absence among
its seven possible failure reasons (W1-T1251). Exported so a reason string can be classified
({@link classifyGlobalArtifactRefusal}) by the SAME literal this module itself returns, rather
than a second, driftable regex a caller (e.g. status-board.ts) would otherwise have to guess
at. `startsWith`, not exact-equal, so a short test fixture (`"global artifact not found"`) and
the real, path-suffixed message (`"global artifact not found: <path>"`) both classify alike.

## GlobalArtifactRefusalKind

### Base lines 672-678 — `"absent"` — the artifact simply…

`"absent"` — the artifact simply doesn't exist yet (nothing pulled/provisioned), the ONE
designed, non-fatal, §6-deferred-transport state. `"refused"` — every other
{@link loadGlobalArtifact} failure: not valid YAML, not a mapping, missing `version`/`hash`, a
malformed entry, or a hash mismatch (the tamper signal) — a REAL problem with an artifact that
DOES exist, never to be read as an expected absence (W1-T1251).

## classifyGlobalArtifactRefusal

### Base lines 681-690 — Classify a `loadGlobalArtifact` refusal `reason`…

Classify a `loadGlobalArtifact` refusal `reason` string into its {@link
GlobalArtifactRefusalKind} — the ONE discriminant every consumer (today: {@link
loadGlobalArtifact} itself, and status-board.ts's LEARNINGS INJECTION block) reads instead of
each re-deriving its own string match. `"absent"` iff `reason` starts with {@link
GLOBAL_ARTIFACT_ABSENT_REASON_PREFIX}; every other reason (including one this module has never
seen before) classifies `"refused"` — fail toward PROMINENT, never toward silently-designed,
so an unrecognized future failure reason still reads as a problem rather than vanishing into
the deferred-transport line.

## loadGlobalArtifact

### Base lines 706-724 — Load and VERIFY the RMD-GLOBAL…

Load and VERIFY the RMD-GLOBAL artifact at `path` (P32/W1-T145).

`entries` is parsed through the exact same {@link parseLearningsDoc} every
other layer uses — a malformed global entry is rejected with the same
{@link LearningsError} shape a malformed project or user-overall entry
would produce; ONE validator, every layer. The content hash is then
recomputed via {@link computeArtifactHash} and compared to the artifact's
own `hash` field: a MISMATCH (tampering, corruption, or a hand-edited
`entries` list that forgot to re-pin) means the artifact is REFUSED —
`{ ok: false }`, contributing zero entries — never silently trusted. A
missing file is refused the same way (nothing pulled yet reads identically
to "refuse silently", which is the correct default for an opt-in layer
nothing has to populate) — BUT is the only one of the seven possible
failure reasons carrying `kind: "absent"` rather than `kind: "refused"`
(W1-T1251): a designed, non-fatal, §6-deferred-transport state is not the
same claim as a tampered or malformed artifact, even though both stop the
global layer contributing entries identically.

## loadLayeredLearnings

### Base lines 778-794 — Read all three P32 layers…

Read all three P32 layers into ONE merged corpus, in PRECEDENCE ORDER:
project first, user-overall second, global last (bottom-up promotion's
read-side mirror — the most repo-specific facts are listed first).
Downstream ranking ({@link selectLearnings}) still applies its own
match-count/recency ordering on top of this list; "precedence" here only
fixes the merge order, not the final injected order.

Missing project/user-overall directories are non-fatal, same convention as
{@link loadLearningsCorpus} (no corpus at that layer yet -> contributes
nothing). A global artifact that fails verification contributes ZERO
entries and its reason is surfaced via `globalRefusedReason` for the
caller to log — excluded, never silently trusted (the W1-T145 falsifier).

No PROMOTION or SCRUB gate lives here — this only reads what already
exists at each home; deciding what MOVES between layers is W1-T146.

## loadLayeredLearningsForTaskFiles

### Base lines 799-812 — The PROMPT-ASSEMBLY entry point (P32/W1-T145):…

The PROMPT-ASSEMBLY entry point (P32/W1-T145): identical to
{@link loadLayeredLearnings} except the PROJECT layer is read via the
INDEX-based {@link loadLearningsForTaskFiles} lookup (W1-T33) instead of a
full corpus scan — the same lookup-not-scan property the project layer
already had is preserved once user-overall/global are merged in, so
layering never regresses the project corpus's O(matching shards) cost.
This is what a real prompt assembly (`run-task.ts`'s implement dispatch)
calls: project (index lookup, file-matched) + user-overall (full corpus,
expected small/cross-project) + global (hash-verified artifact), merged in
PRECEDENCE ORDER, ready to hand to {@link selectLearnings} /
{@link renderMatchedLearnings} exactly like the project-only corpus was
before this task.

## SECRET_PATTERNS

### Base lines 846-851 — Leak-grep analog: deterministic secret-shaped patterns.…

Leak-grep analog: deterministic secret-shaped patterns. Deliberately
conservative (specific token shapes, not "any long string") so scrub does
not blanket-block ordinary facts — the acceptance bar is "a deliberately
secret-bearing entry is BLOCKED," not "every entry with a long word is."

## scrubEntry

### Base lines 882-890 — The SCRUB gate (P32/W1-T146, stage…

The SCRUB gate (P32/W1-T146, stage 1 of {@link promoteEntry}): a
DETERMINISTIC leak-grep analog (secret-pattern regexes) plus a PII
detector, run over every free-text field of `entry`. Pure and synchronous
— no LLM call, no network, no I/O — so a caller can run it before ever
paying for (or risking) a judge invocation. `blocked: true` means
promotion must stop HERE; {@link promoteEntry} never calls the judge when
this returns blocked.

## buildPromotionJudgePrompt

### Base lines 913-920 — Build the promotion judge's prompt…

Build the promotion judge's prompt for ONE entry (P32/W1-T146). The judge
sees ONLY this entry's fields (id, subsystem, fact, src, files) — never
sibling entries, never the corpus it would join — so its verdict is about
this fact's own shape, not comparative. Mirrors flight-judge.ts's
`buildJudgePrompt`: prose framing + a fixed MACHINE-READABLE OUTPUT
contract a caller can parse without an LLM round-trip to re-ask.

## FAIL_CLOSED_PROMOTION_VERDICT

### Base lines 954-960 — FAIL-CLOSED default when the judge's…

FAIL-CLOSED default when the judge's output carries no parseable verdict
(same doctrine as flight-judge.ts's `FAIL_CLOSED_VERDICT`): an unreadable
judge is evidence the entry should NOT move, not a reason to wave it
through. `applicability: "project-specific"` at `confidence: 0` can never
satisfy {@link planPromotionFromVerdict}'s threshold.

## parsePromotionJudgeVerdict

### Base lines 967-973 — Parse the promotion judge's `PROMOTION_APPLICABILITY`/`PROMOTION_CONFIDENCE`/…

Parse the promotion judge's `PROMOTION_APPLICABILITY`/`PROMOTION_CONFIDENCE`/
`PROMOTION_RATIONALE` lines into a {@link PromotionJudgeVerdict}. Missing or
unrecognized applicability fails closed ({@link FAIL_CLOSED_PROMOTION_VERDICT});
a missing/invalid confidence defaults to 0. Case-insensitive; tolerant of
surrounding prose (same tolerance as flight-judge.ts's `parseJudgeVerdict`).

## planPromotionFromVerdict

### Base lines 994-1001 — The deterministic actor on a…

The deterministic actor on a {@link PromotionJudgeVerdict} (Standing rule
12 — judgment is advisory, the decision to act is a pure function of it).
Promotes iff the judge said `broadly-applicable` AND its confidence meets
`confidenceThreshold` — anything else (including a `project-specific`
call, a low-confidence `broadly-applicable` call, or the fail-closed
default) does not promote.

## redactProvenance

### Base lines 1016-1023 — Redact repo-identifying SPECIFICS out of…

Redact repo-identifying SPECIFICS out of a provenance `src` string while
keeping its origin shape (P32/W1-T146: "provenance survives promotion in
REDACTED form" — the origin is kept, project-identifying specifics
scrubbed). Strips task ids (`W1-T146`), PR numbers, issue numbers, and any
other bare `#<digits>` reference; anything else in `src` (e.g. a
subsystem/team name) survives untouched.

## promoteEntry

### Base lines 1058-1078 — The PROMOTION PIPELINE for ONE…

The PROMOTION PIPELINE for ONE entry (P32/W1-T146): SCRUB, then JUDGE,
strictly in that order and never the reverse.

1. {@link scrubEntry}. A block returns immediately with `stage: "scrub"` —
   `deps.judge` is NEVER called (assert zero judge invocations in a test
   fixture; that is the scrub falsifier).
2. If `entry` is already at the top layer (`global`), there is nothing
   above it to promote to — returns `stage: "top-layer"` without invoking
   the judge either (a judge call would be meaningless with no target).
3. Otherwise `deps.judge(entry)` runs and {@link planPromotionFromVerdict}
   decides. A non-promoting verdict (including the fail-closed default)
   returns `stage: "judge"`, `promoted: false` — the entry stays exactly
   where it was (the judge falsifier: a project-specific entry never
   appears at the next layer after a pass).
4. A promoting verdict returns `stage: "promoted"` with `promotedEntry`:
   the SAME entry, `layer` set to the next layer up and `src` run through
   {@link redactProvenance}. `promoteEntry` does not mutate `entry` and
   does not write `promotedEntry` anywhere — persisting it to a real
   user-overall/global home is the deferred transport's job.

## runPromotionPass

### Base lines 1130-1139 — Run {@link promoteEntry} over a…

Run {@link promoteEntry} over a whole corpus (P32/W1-T146) — "a promotion
pass." `superseded`/`quarantined` entries are skipped (never promotion
candidates — same lifecycle filter {@link selectLearnings} applies before
injection; a decayed fact should not rise a layer either). Returns every
entry's individual {@link PromotionResult} plus the flat `promotedEntries`
list a caller would merge into the next layer's home — a project-specific
entry's result has `promoted: false` and contributes nothing to that list,
which is the shape the judge-falsifier test asserts against.

## Transport section header

### Base lines 1152-1158 — ── TRANSPORT: EXPORT/IMPORT (§6, W1-T425)…

── TRANSPORT: EXPORT/IMPORT (§6, W1-T425) ──────────────────────────────────

TWO VERBS RIDING MACHINERY THAT ALREADY EXISTS: {@link loadGlobalArtifact}'s
hash-pin verification and {@link scrubEntry}'s leak-grep/PII analog both
predate this section — export/import only produce and consume the bundle
those already-shipped guards read. This section builds ONLY the bundle in
between, never a second copy of either guard.

## ExportBundle

### Base lines 1170-1176 — A bundle produced by `rmd…

A bundle produced by `rmd learnings export` — the EXACT {@link GlobalArtifact}
shape (`version`/`hash`/`entries`) {@link loadGlobalArtifact} already parses
and hash-verifies, plus a `provenance` block. `loadGlobalArtifact` ignores
unknown top-level keys, so a `provenance`-carrying bundle round-trips
through the EXISTING loader with no changes to it.

## selectExportableEntries

### Base lines 1181-1187 — Only ACTIVE entries carrying the…

Only ACTIVE entries carrying the explicit `share: "public"` opt-in are
ever exportable (§6, W1-T425). Absence of `share`, a `lifecycle` other
than `active`, or any `share` value other than `"public"` (parsing
already rejects anything else) all mean PRIVATE — this is a pure filter
over the DECLARED field, never a guess about what looks safe.

## buildExportBundle

### Base lines 1197-1213 — Build an exportable bundle from…

Build an exportable bundle from a loaded corpus (§6, W1-T425). Two
refusals, both BEFORE anything is ever produced:

1. Zero entries carry `share: public` — refuses naming that (never an
   empty-but-valid bundle; the vacuous-export twin of the naked-zero
   rule).
2. A candidate entry matches {@link scrubEntry}'s leak-grep/PII patterns —
   the SAME deterministic gate {@link promoteEntry} already runs before
   ANY entry rises a layer — refuses naming the offending entry's id. This
   is the independent floor BENEATH the opt-in declaration: a
   mis-declared `share: public` entry still cannot leave the tree if its
   text itself looks secret-shaped.

`version` defaults to the export timestamp so a caller doesn't have to
invent one; pass an explicit value (e.g. a semver-ish tag) to override.

## verifyBundlePin

### Base lines 1251-1264 — Verify a bundle's OWN declared…

Verify a bundle's OWN declared `hash` against an operator-supplied pin
(§6, W1-T425) — the check `rmd learnings import` runs BEFORE writing
anything to the global home. `pin` is communicated out-of-band (e.g. the
hash `rmd learnings export` printed), so this catches a wrong file or one
corrupted/substituted in transit before it ever reaches disk.

Deliberately does NOT recompute the hash from `entries` — that
content-vs-hash re-derivation is {@link loadGlobalArtifact}'s job, run
again at prompt-assembly time against whatever import wrote. Import never
bypasses or reimplements that tamper check; this function only gates
WHETHER import writes the file at all, against a DIFFERENT question (did
the operator get the bundle they meant to trust).

## computeLayerBudgetUsage

### Base lines 1300-1310 — Measure each layer's injectable weight…

Measure each layer's injectable weight INDEPENDENTLY (P32/W1-T146):
same formula scripts/learnings-budget-ratchet.mjs's `computeActiveChars`
uses (rendered `- <fact> [src: learnings#<id>]` line length, +1 per entry
for the joining newline, `lifecycle: active` only — `superseded`/
`quarantined` entries carry zero weight because {@link selectLearnings}
never injects them) via {@link entryBudgetWeight}, but bucketed by {@link
entryLayer} instead of summed across the whole corpus. Always returns one
entry per {@link LAYERS}, in that order, even when a layer has zero
entries (`chars: 0`).

## evaluateLayerBudgetRatchet

### Base lines 1323-1332 — The per-layer ratchet check (P32/W1-T146,…

The per-layer ratchet check (P32/W1-T146, extends learnings-budget-ratchet
W1-T38 from a single global ceiling to one INDEPENDENT cap per layer): a
layer whose measured {@link computeLayerBudgetUsage} exceeds its `caps`
entry is a violation, named in the returned string; a layer with no cap
set is never a violation. Exceeding ONE layer's cap does not affect
another layer's evaluation — each is judged solely against its own cap,
same as the acceptance bar names ("exceeding one layer's cap fails the
ratchet"). Empty array means every capped layer is at or under budget.

## LearningsIndex

### Base lines 1344-1351 — A GENERATED lookup index (W1-T33):…

A GENERATED lookup index (W1-T33): for every corpus shard filename, the
entry ids it carries and the union of `files:` globs those entries use, plus
a `subsystem -> shard filename(s)` map. `scripts/generate-learnings-index.mjs`
writes `learnings/index.json` from the shard files; `npm run
learnings-index:check` fails when the committed index doesn't match a fresh
regeneration (a STALE index).

## candidateShardFiles

### Base lines 1375-1382 — PURE lookup: which shard filenames…

PURE lookup: which shard filenames in `index` could possibly contain an
entry matching `taskFiles`? Repo-wide (`taskFiles` empty/absent) candidates
every shard — the budget still bounds the tax. Otherwise a shard is a
candidate iff at least one of the globs its entries use matches at least one
task file. This is the LOOKUP, not a full scan: it never parses/loads a
shard's entries, only tests the pre-recorded glob strings from the index.

## loadLearningsForTaskFiles

### Base lines 1393-1401 — The Promptsmith entry point (W1-T33):…

The Promptsmith entry point (W1-T33): load only the corpus shards `taskFiles`
could match, using the generated `learnings/index.json` for the lookup — a
task touching one subsystem's files parses ONE shard, not all five (and not
whatever N grows to). Falls back to a full `loadLearningsCorpus` scan if the
index is missing (e.g. a fresh checkout before the first `npm run
learnings-index` run) — correctness never depends on the index being
present, only the LOOKUP-vs-SCAN performance win does.

## selectLearnings

### Base lines 1413-1438 — Select the learnings to inject…

Select the learnings to inject for a task, DETERMINISTICALLY.

LIFECYCLE FILTER (W1-T33 supersession, W1-T34 quarantine) first: an entry
whose `lifecycle` is `superseded` OR `quarantined` is dropped from
candidacy before matching even runs — its provenance has decayed (by human
correction, or by a failing self-verification assertion) and it must NEVER
be injected, no matter how well its `files:` would otherwise match. It is
excluded here, not merely de-prioritized, so no budget pressure or
tie-break can let it slip through.

Matching: an entry is a candidate iff one of its globs matches one of
`taskFiles`. When `taskFiles` is empty/absent the task is treated as
repo-wide, so EVERY (non-superseded) entry is a candidate (the budget still
bounds the tax).

Ordering (highest first): concrete match count → LAYER PRECEDENCE
(project → user-overall → global, P32/W1-T145 — the most repo-specific
fact wins a tie before recency does) → most-recently-cited → id. Then fill
up to `budgetChars` of rendered fact lines; the remainder is `dropped`
(returned for logging), so the injected corpus is bounded. Every entry
pre-W1-T145 has no `layer` set, which defaults to `"project"` — so the
layer tiebreak is a no-op for the pre-existing project-only corpus and
only distinguishes entries once a user-overall/global layer is actually
populated.

## renderDoctrinePreamble

### Base lines 1481-1488 — Render ONLY the two mandatory,…

Render ONLY the two mandatory, INVARIANT doctrine lines (Tier 0, MASTER-PLAN
§8A) — the distrust rule and the autonomy clause. This is the STABLE PREFIX
of the cache-aware assembly rule (W1-T35): it is line-capped and must change
RARELY, since an edit here busts the prompt cache for every worker rendered
after it. Callers place this FIRST in a rendered prompt, ahead of anything
volatile (task context, recon output, matched learnings). Always non-empty.

## renderMatchedLearnings

### Base lines 1496-1501 — Render ONLY the task-matched LEARNINGS…

Render ONLY the task-matched LEARNINGS facts (Tier 1, W1-T19/W1-T33) — no
doctrine lines. VOLATILE: the corpus grows every retro, so callers place
this LAST in a rendered prompt (cache-aware ordering, W1-T35), never ahead
of the stable {@link renderDoctrinePreamble} block. "" when nothing matched.

## renderLearningsContext

### Base lines 1506-1520 — Render the LEARNINGS half of…

Render the LEARNINGS half of a prompt's CONTEXT block: the two mandatory
doctrine lines followed by the pre-selected, matched facts. Every line is
cited, so the block passes the provenance linter. Returns "" only if you pass
an empty selection AND the doctrine lines are unwanted (never — they always
emit), so the string is always non-empty.

Bundles {@link renderDoctrinePreamble} + {@link renderMatchedLearnings} in
historical (doctrine-then-facts) order for callers that want ONE block
rather than the two pieces separately. `renderImplementPrompt` (run-task.ts)
does NOT use this — it keeps the two pieces apart so it can place the
stable preamble first and the volatile matched facts last in the wider
CONTEXT block (cache-aware ordering, W1-T35), not merely relative to each
other.

## Progressive disclosure section

### Base lines 1525-1539 — PROGRESSIVE DISCLOSURE FOR A HEADLINE+BODY…

PROGRESSIVE DISCLOSURE FOR A HEADLINE+BODY RULE CORPUS (W1-T2508).

CLAUDE.md's own bullets are already written `- **HEADLINE** body *(citation)*` — an
agent-skill-shaped split (description always-on, full material on activation) that nobody
had to invent, only honour (W1-T2508's rationale). This is a SEPARATE mechanism from the
`LearningEntry` corpus above: a `LearningEntry.fact` is one line with no headline/body
structure of its own, {@link selectLearnings}/{@link renderMatchedLearnings}/
{@link renderDoctrinePreamble} are UNCHANGED by anything below, and nothing here is wired
into {@link renderLearningsContext} or `run-task.ts`'s `implementPromptParts` — flipping a
live prompt's shape is explicitly NOT this task's acceptance (its rationale's "NOT IN
SCOPE" names "any change to what a worker is permitted to do"). What this proves is that
the RETRIEVAL PATH exists and is safe before any body is ever withheld — the hazard the
rationale names: "a headline whose body cannot be fetched is strictly worse than today."

## RuleHeadline

### Base lines 1541-1546 — One parsed rule bullet. `body`…

One parsed rule bullet. `body` is EVERYTHING in the original bullet other than the bolded
headline marker — `` `- **${headline}**${body}` `` reproduces the source bullet BYTE FOR
BYTE, so splitting a rule into headline+body never alters its text (W1-T2508 acceptance:
"no rule text is altered by being split into headline and body").

## parseRuleHeadlines

### Base lines 1559-1567 — Split `markdown` into top-level `-…

Split `markdown` into top-level `- **HEADLINE** body` bullets — the exact shape CLAUDE.md's
"Before you push" / "Investigation discipline" etc. sections already use. A bullet runs from
one line matching `^- \*\*` up to (but not including) the next such line or a `#` heading, so
a bullet's body may freely contain blank lines, nested sub-bullets, or a markdown table (real
CLAUDE.md bullets do, e.g. the "baked path" rule's ships-on-merge table) without truncating
early. A line that opens a bullet but never closes its `**` is refused loudly — a malformed
source degrading silently into a wrong split would be worse than not splitting at all.

## buildHeadlineIndex

### Base lines 1596-1602 — Index every rule by its…

Index every rule by its headline. A headline mapping to two DIFFERENT bodies is refused
loudly rather than letting the second silently win — "every headline in the index resolves
to exactly one body" is an acceptance criterion, not an assumption, and a silent overwrite is
exactly the kind of zero-signal wrong-answer CLAUDE.md's own "Investigation discipline"
section warns against.

## renderHeadlineOnlyIndex

### Base lines 1615-1620 — The ALWAYS-ON half: headlines only,…

The ALWAYS-ON half: headlines only, never a body — the STABLE metadata an agent-skill
description is, in the always-on-injection/on-activation split this mirrors. One bolded
headline per line, in the corpus's own order; ~15% of CLAUDE.md's own bulk by the rationale's
own measurement, because a headline is a skill description by any measure.

## retrieveRuleBodyOrDegrade

### Base lines 1631-1639 — Resolve one rule's body ON…

Resolve one rule's body ON DEMAND via the injected `retrieve` — and if that retrieval fails
(returns `undefined`: a missing index entry, an unreadable source, a dead retrieval path),
degrade to injecting the FULL rule (`- **headline**body`) rather than nothing. This is the
hazard W1-T2508's rationale names explicitly: "a headline whose body cannot be fetched is
strictly worse than today: the reader knows a rule exists, cannot read it, and proceeds
anyway" — so a failed retrieval must never resolve to `""` or throw, only to the pre-split
rule text the reader would have seen before any split existed.

## renderProgressiveRuleContext

### Base lines 1649-1656 — The wider CONTEXT-block shape this…

The wider CONTEXT-block shape this mechanism assembles into, mirroring
{@link renderLearningsContext}'s own stable-then-volatile ordering (cache-aware assembly,
W1-T35): the headline index is STABLE (bounded, corpus-shape, changes only when a rule is
added/reworded) and sits first; `retrievedBodies` is VOLATILE (grows over the life of a
session as the worker actually asks for material) and sits last, exactly where
{@link renderMatchedLearnings} sits relative to {@link renderDoctrinePreamble} today.

