# Open decisions — the rulings only the operator makes

One ruling here is still undecided; the other two rows are kept because a reader who met them as
open needs to find out where they landed, not find silence. The reason the page exists has not
changed: **a session, finding a doc silent on one of these, resolves it in prose** — and a
paragraph asserting a direction reads exactly like a paragraph recording one. Standing rule 12
draws the line the other way round for machines (an LLM may RECOMMEND, only code may ENFORCE); the
same asymmetry governs rulings. An agent may recommend. The operator ratifies.

**So: cite this page, do not settle it.** If you need one of these answered to proceed, say which
one and stop — that is a legitimate blocked state, not a gap for you to close.

## How to read the status column

Every row below names **the query, not its answer** — deliberately. This page is prose in a repo
that merges dozens of PRs a day; a status copied into it is stale the hour after it is written, and
a stale "PENDING" is worse than no status because it looks checked. Run the query.

The prose sections under the table do carry a disposition, because a row that has landed is
useless without one. Each states the date it was last verified against its own row's query. The
query is still the authority; the date tells you how much to trust the sentence before you run it.

| Decision | Where it lives | Re-check with |
|---|---|---|
| **D-11** — instance topology (cells) | `MASTER-PLAN.md` §11, entry "D-11 Instance topology" | `grep -n 'D-11 Instance topology' -A2 MASTER-PLAN.md` — the entry's own first line carries its disposition |
| **P48** — no naked zero | `MASTER-PLAN.md` §8, entry "★ P48" | `grep -n '★ P48' -A3 MASTER-PLAN.md`, plus `DECISIONS.md` for a ratification entry |
| **W1-T404** — console write tiers | `plan/tasks.d/W1-T404-write-scope-is-one-undifferentiated-grant.yaml` | `grep -n 'verify:' plan/tasks.d/W1-T404-*.yaml` for how it is judged, then `git log --oneline --grep=W1-T404 origin/main` for whether it has already shipped — a merged id is not an open decision, and this row asserted the wrong `verify:` for weeks |

---

## D-11 — one rmd instance per codebase ("cells"), nothing mutable shared

**RATIFIED 2026-09-02 by the operator. No longer an open decision** (verified 2026-09-08 against
this row's own query). The disposition is carried by the first line of the "D-11 Instance topology"
entry in `MASTER-PLAN.md` §11, and that entry ends with a **RATIFICATION RECORD**: ratified as
written — cells, accounts at the relay only, the instance dialling out, the relay a transparent
proxy over the §7A console contract — with no amendment to the recommendation's text, and the
reasoning above the record preserved verbatim rather than rewritten after the fact. The entry also
names what the ratification did **not** decide; read that there rather than inferring it here.
Filed originally from the operator's own architecture brief (`oper#architecture-2026-08-11`),
promoted out of the Banked queue's "multiple products, one daemon vs. daemon-per-product".

The ratified shape is daemon-per-product: a **cell** is one codebase plus its own config root —
its own ledger, governor, budget, drain lock, inflight/KICK markers, worktree pool, clones and
console port. On the mini a cell is a sibling config root and launchd label set; on Linux a cell is
one container of the shipped worker image (`deploy/Dockerfile`). `remudero.com` is **Tier 2**: the
instance dials out, accounts exist at the relay only, and the relay stays a transparent proxy over
the §7A console contract. Core stays self-hosted per §6A.

**What the ratification released, and what it never gated.** It gated exactly one thing — the
wild-trails cell pilot (W1-T433) — and the entry now states in as many words that the arc is
dispatchable and W1-T433's pilot is no longer gated on this entry. The operator's WS-2 deferral
judgment was always a second, separate condition on that pilot, and this page does not speak for
it. Ratification never gated the seams: W1-T429 (repo-scoped decision keys), W1-T430
(identity-provider seam), W1-T431 (outbound relay client), W1-T432 (shared knowledge homes) were
each correct on their own terms before it. Read the D-11 entry before assuming an ordering; it
states the arc explicitly.

**The thing a reader most often gets wrong:** D-11 does not overturn the 2026-07-21 two-dispatcher
rejection. That rejection was two *ungoverned* dispatchers on one repo's plan. Cells are one
governed dispatcher per plan, sharing neither plan nor ledger nor locks, and the N=1 parallelism
constraints still apply **within** a cell.

## P48 — a boundary read's empty answer must say which empty it is

**OPEN — P48 remains pending ratification** (verified 2026-09-08: `DECISIONS.md` carries no
ratification entry for it). Proposed in #1402, whose title says "pending ratification" in as many
words. Note that at least one task shard describes P48 as "ratified #1402"; that is wrong, and
#1402's own title is the check.

Two clauses: **(i)** a boundary read returns `found | absent | query_invalid | source_unreachable`,
never a bare count; **(ii)** no naked zero — any zero feeding a decision carries a positive control
proving the reader *can* see. The entry is explicit that (ii) is load-bearing and that ratifying
(i) alone "satisfies the letter and fixes nothing".

**Ratify with your eyes open on one point.** P48's 21-instance census lived in a `state/` report
that was never committed and no longer exists (#1587 established this: no commit, no object, no
backup). The entry carries the conclusion but not the method — the six mechanism classes are never
enumerated and the selection predicate is never stated. Its FIRST TRANCHE scoping rule ("a boundary
qualifies when it has a RECORDED census instance and no second channel at head") therefore **cannot
be evaluated as written**: membership depends on a census nobody can read. #1587 added an addendum
carrying the still-checkable parts rather than manufacturing a replacement number. The clauses can
be ratified on their merits; the *scoping criterion* needs restating either way.

## W1-T404 — the console's `write` scope is one undifferentiated grant

**CLOSED — ruled and shipped as #1709; the shard reads `verify: auto`, not `verify: human`**
(verified 2026-09-08 against this row's own query). `feat(service): split write scope into
low/middle/high consequence tiers (W1-T404)` merged as #1709, and two follow-ons have merged since:
#1835 (`feat(service): add a read-sensitivity axis for scope`, shipped dark, W1-T495) and #1849
(`feat(serve): turn on write-tier enforcement`, W1-T500). A merged id is not an open decision.

**Two traps when you re-run this row's query.** The shard's `status:` field still reads `queued`;
nothing updates it on merge, so it is not a completion signal and never was — the merge evidence
is. And `git log --grep` answers only about the history you actually have: on a shallow clone it
returns a clean zero for an id that shipped hundreds of commits ago, with no error and no warning.
Deepen the clone, or check the merged PR, before reading that zero as "not shipped".

Kept as the record of what was decided, because the ruling's *shape* is what the rest of the arc
was ordered around. Measured at filing: `Scope` was exactly the union of read and write, with two
grant sets and no third tier and no per-route capability; 22 scope declarations across 20 distinct
write-scoped route paths; `grantedScopes` had exactly one call site inside `createService`'s
dispatcher. So the same credential that added an operator note raised the spend ceiling, dispatched
paid work, executed a skill against the operator's checkout and halted the fleet — and the obvious
second factor did not exist server-side (the arm-then-confirm interaction was client-side only, a
mis-click guard that anything speaking HTTP bypassed). The ruling answered it as three tiers
(low/middle/high consequence) with a server-issued action-bound confirm nonce as the second factor;
the shard's own amendment note records both, and is the place to read them.

**Why it ordered the rest.** Console-initiated merge was composable even at filing — `armAutoMerge`'s
gh calls behind the existing `ratifyCliGateway` spawn pattern, no architectural barrier — but a
merge button would have ridden the same grant as a note-add. So the tier shape had to be decided
first, or the console would grow a fleet-control capability behind a note-taking credential. The
recon establishing this ordering ran with #1590; no task was filed for the ruling itself, because
the ruling was not a task.

---

## The direction these serve

The operator's stated goal is that **the harness is the product and GitHub is plumbing** — minimise
the time a human spends on a PR page, a checks tab, or a merge button. #1590 re-aimed the feedback
arc accordingly: W1-T435 captures operator verdicts in the console (not by reading PR comments) and
feeds them to the fix rung; W1-T436 files the docket's proposal through the inbox registry, moving
the human gate *earlier* — in-console ratification before any write, with the PR demoted to
transport and audit; W1-T437 is the instrument that counts the remaining touchpoints.

Some GitHub contact is irreducible and is not a defect to engineer away: `verify: human` draft-PR
merges, plan-approval merges, commons and outbound gates, Dependabot majors, org settings and
credential acts, the forge drill.

The W1-T404 ruling that used to block a console merge button is made, and its enforcement has
merged. What stands between that arc and a merge button is now ordinary queued work, not a ruling —
which is a different kind of wait, and this page is not where you track it.
