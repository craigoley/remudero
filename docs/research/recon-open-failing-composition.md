# Recon: what the 176 open-failing number is actually made of — 2026-08-06

Run at origin/main `c7233cfb89e14a14ec53ad8a5d36ee4a25787832` (toplevel /home/user/remudero, branch main;
single `git -C` invocation). Report-only; no filings, no code, no PRs. Verifying the laws report's claim:
"~77% gravestones, ~22% real broken-proof work, and the gates now prevent ALL new debt — zero failures in
the T246–T325 band." The operator-host ledger was not needed for any figure below; everything is DERIVED
from a live `lint-plan` run at this sha plus one pass over origin/main's full commit history
(subjects + bodies, ~1,500 commits — git history, not the ledger).

## Q1 — the composition, reproduced with a stated method. The report UNDERCOUNTED the gravestones.

**Method (mechanical, two tiers):** run `RMD_SELF_SYNC_DONE=1 bin/rmd lint-plan` (377 checked — 176
failing unique ids, 554 warnings); for each failing id, scan every commit on origin/main for
(a) a `Remudero-Task: <id>` trailer in the body, (b) the id cited in an IMPLEMENTING subject
(fix/feat/refactor/docs), with subjects beginning `chore(plan)`/`chore(triage)`/`chore(feedback)`/
`docs(plan)` explicitly EXCLUDED as filing citations, not merge evidence — the classifier's one
judgement point, and the source of every prior number's instability.

**Result:** 167 of 176 (**94%**) carry an implementing commit — 47 by hard trailer, 120 by
implementing-subject citation, and ZERO of the subject citations were filing-only once the exclusion ran.
Only **9 tasks have no citation of any kind**: W1-T2, W1-T60, W1-T72, W1-T113, W1-T164, W2-T2, W3-T4,
W3-T7, W12-T1 — genesis-era and future-wave relics, plus one live intent (W1-T164, operator guidance
notes). **The laws report's 77% was a conservative bracket** (its agent reported 47 hard-trailer minimum
/ 156 any-evidence and settled low); the reproducible number is 94% gravestones, 5% real. The classifier
is mechanical given the filing-exclusion rule; its stability across evidence bars is 47 → 156 → 167,
which is exactly why the rule must be stated with the number. Caveat: an implementing-subject citation
proves work merged NAMING the task, not that every criterion shipped — for the retirement question that
distinction belongs to W1-T370's per-task census, not this recon.

**Failing ids by 50-band:** T0–49: 42 · T50–99: 43 · T100–149: 36 · T150–199: 33 · T200–249: 8 ·
**T250–299: 0** · T300–349: 1 (W1-T326, `ruling-verify` — the new governance lint firing retroactively,
not proof debt) · W2/W3/W12 relics: 13.

## Q2 — the zero band is real; the closer is the dialect-convention PACKAGE, and finer attribution is
unrecoverable.

The zero-failure claim reproduces (T250–299 zero; T300+ carries only the governance catch). Which gate
closed it: the failing set's blocking violations are 300 `proof-dialect` + 189 `proof-resolvability`
(+5 headless-fitness, +1 ruling-verify) — ALL of them authoring-shape violations. The mechanisms that
force correct authoring shape landed as ONE cultural package in the 2026-07-24/25 era: the dialect
linter's blocking checks, the `rmd check-proof` verb, and the CLAUDE.md verify-before-filing rule
(#766/#773/#777 lineage) — reinforced by changed-tasks CI lint and `preDispatchLint`. Rule 19 sizing,
the call-site criterion, and `ruling-verify` contribute ZERO rows to this composition (sizing: 0
occurrences; call-site: warn-only ×2; ruling-verify: the one W1-T326 catch) — they close OTHER debt
classes. Between the linter and the convention that authors run it: the parts shipped together and every
post-package filing faced all of them at once, so per-gate attribution is UNRECOVERABLE from this data,
and picking one would be narrative. The package closed it; that is as fine as the evidence goes.

## Q3 — THE AGE TEST: the confound dies at the violation level. Every failing violation was BORN broken.

The falsifier the brief demanded turns out to have a cleaner resolution than band-vs-band comparison:
**decompose the violations by whether AGING can produce them at all.**

- `proof-dialect` (300 rows): a missing or malformed dialect prefix. A later merge cannot remove a
  prefix from a filed proof. **Age-insensitive by construction — born broken.**
- `proof-resolvability` (189 rows): checked every one — **all 189 are the same shape, "is
  `unit test:`-prefixed but names no resolvable artifact"** — title-form proofs that never carried a
  path. Zero rows are the aged shape (a named path that existed and was later moved/deleted). A proof
  that names no path cannot lose one to subsequent merges. **Born broken, all of them.**

So the age hypothesis — "young tasks just haven't had time to break" — fails on the actual failure
content: **nothing in the 495 blocking violations is something time produces.** A task filed under the
convention cannot acquire these violations by aging, so the T250+ zero band cannot be an age artifact.
The matched-age band comparison the brief sketched is therefore unnecessary for THIS claim — though one
honest residual stands: aged breakage (path-form proofs whose files later move) is possible in
principle, currently measures ZERO in the failing set, and is exactly the class W1-T362's base-run
downgrade (in review at #1404) and the check-proof discipline will surface if it ever appears. **The
"gates prevent new debt" claim SURVIVES its falsifier, with the sharpened statement: the gates prevent
the only debt classes that exist, because both are authoring-time shapes.**

## Q4 — what the 176 actually blocks, mechanically.

Dispatch mechanics at this sha: `proof-dialect`, `headless-fitness` and `ruling-verify` BLOCK at
`preDispatchLint` (`blocked_illformed`, zero spend); `proof-resolvability` only WARNS there — a
resolvability-only task DISPATCHES and burns a full run into a CAPPED verdict.

- **150 of 176 are parked, spending nothing** (141 gravestones + 8 relics + W1-T326's ruling hold).
- **Exactly ONE genuinely-open task can dispatch and burn: W1-T164** (resolvability-only, no merge
  evidence, live intent).
- **26 gravestones are dispatch-permitted** (resolvability-only). Whether each ACTUALLY dispatches
  depends on crediting: 6 carry hard trailers (`deriveStatus` parks them — W1-T88/T112/T161/T178/T179/
  T245); **20 have implementing-subject evidence only** (W1-T25, T83, T89, T91, T92, T96, T98, T101,
  T106, T114, T115, T133, T134, T142, T145, T146, T166, T167, T168, T196) — the exact
  phantom-re-dispatch class that billed W1-T254 five same-day no-op runs and W1-T1 four. UNMEASURED
  from here whether each is currently credited by a `pr:` field or correction line (that read needs
  the host's derivation against live GitHub); the class's spend risk is proven by the corpus, not
  estimated.

## The recommendation

**Rescope W1-T369; let W1-T370 drain by attrition as already ruled; add one cheap reporting fix.**

1. **W1-T369 as filed targets "the 39 open" — the true open-real population is NINE, and eight of
   those are dispatch-blocked relics** that want WITHDRAWAL under the #1239 convention (W2/W3/W12
   future-wave stubs and three genesis relics), not proof rewrites. The rewrite effort worth paying
   for is: **W1-T164** (the one live burner) plus **the 20 subject-only dispatch-permitted
   gravestones** — and for those 20 the right fix is CREDITING (an `rmd correct` / `pr:`-field pass so
   `isMerged` parks them), which is cheaper than rewriting proofs on work that already shipped and
   closes a measured spend risk rather than a cosmetic one.
2. **W1-T370's 136-record mass is confirmed cosmetic** except the touched-row tax — the standing
   attrition ruling holds; no new spend warranted.
3. **The number itself is the remaining harm.** "176 open-failing" drove decisions this week while
   meaning "9 real, 1 burning." That is Law 1 Face A wearing a report line. The one-line fix worth
   filing (operator's call — this recon files nothing): lint-plan's headline splits the count by
   merge-evidence, e.g. `176 failing (167 with merged implementations, 9 open)` — the same
   split this recon computed mechanically, run by the tool that already prints the number.

## Plain language

Of the 176 things the linter complains about, almost none can stop work. About 167 are complaints about
the paperwork of tasks whose work already shipped — gravestones with untidy inscriptions. Eight more are
ancient wish-list entries that the dispatcher refuses to touch anyway. Exactly one live task can
actually waste money on a bad proof today, and about twenty of the gravestones could each trick the
dispatcher into one pointless re-run if their credit records are incomplete — that narrow slice, plus
the one live task, is the only part worth anyone's time. Fixing the rest would make a number smaller
without making anything work better. The most useful change is to make the number stop lying: report
"9 open, 167 already shipped" instead of "176 failing," because this week the big scary number did more
damage than the debt it describes.

## CORRECTION — 2026-08-06, found while implementing the headline split

The 167/9 split above OVERCOUNTS gravestones by three. The recon classifier tested the
filing-subject exclusion against the raw parsed subject, which carries a LEADING NEWLINE from the
`%x01` entry delimiter — so `\nchore(plan): file W1-T147 …`-shaped subjects escaped the anchored
`^chore\(plan\)` exclusion and three FILING commits were miscounted as implementing evidence. The
corrected split at the same history: **164 with a merged implementation, 12 without**; W1-T147
(chaos drill), W1-T185, and W1-T326 (the parallelism ruling record) move to the no-evidence set —
each is cited ONLY by its own filing commit, which coheres with all three being genuinely open
records. The shipped classifier (`classifyFailingMergeEvidence`, src/run-task.ts) trims before
testing the exclusion and is the corrected form; every conclusion above survives (the split moves
94%→93%), including the recommendation.
