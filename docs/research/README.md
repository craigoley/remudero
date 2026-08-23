# Recovered research artefacts

Four agent-written reports, recovered and committed verbatim. They are **dated artefacts**: each records
what was true at the sha named in its own header, and nothing in them has been reformatted, re-wrapped,
corrected, or annotated. Where a claim in them has since gone stale, the staleness is part of the record
and should be read as such rather than repaired in place.

## Why they were nearly lost

Each was written into `state/`, which `.gitignore` excludes. That exclusion is correct and load-bearing —
`state/` is where the daemon writes its runtime exhaust, and un-ignoring it would make every run show up
as a dirty working tree. The defect was never the ignore rule; it was the **placement**. A report written
to an ignored path is scratch, not a record, however carefully it was researched.

The consequence is that these four existed on exactly one filesystem. They were never committed on any
ref across roughly 2,200 commits, and at the time of recovery they were absent from both the Azure fleet
host and the Mac mini, and were not among the mini's dangling objects. Meanwhile tracked files in this
repository **cite them by path**, so those citations resolved to nothing for anyone who did not happen to
be working on the one machine that still had them.

They were recovered from the original authoring working tree, which had persisted inside a sandbox
container. Each file's own header names that tree — `toplevel /home/user/remudero` — so the copies
committed here came from the directory they were written in, not from a mirror or a re-derivation. A
`git clone` cannot reproduce an ignored file, which is why no fresh checkout anywhere had them.

## Why the loss was already costing something

This is not a tidy-up. One of these files is load-bearing for an open proposal.

`1ccfca2` (2026-08-05) proposed **P48, the Outcome-typed boundary**. P48 is Proposal 1 of
`research-laws-and-gaps-2026-08-05.md` — the same design, mined from the same session, on the same day.

Six days later `710b18b` (#1587, 2026-08-11) had to carry P48's still-checkable evidence into the
MASTER-PLAN entry **because the report backing it could no longer be read**. That commit recorded the
file as unrecoverable and stated the cost in terms: the census of instances behind P48 was gone, the
figure could not be re-derived from the entry, and ratifying the proposal as written would have meant
ratifying a number nobody could check. MASTER-PLAN still carries that finding today.

The census in question is Part 1 of the recovered file. It is back. This directory does not ratify,
amend, or re-argue P48 — it only restores the document P48 was drawn from, so that whoever takes that
decision can read the evidence instead of working around its absence.

## What is here, and what is not

| file | bytes | sha256 | dated |
| --- | --- | --- | --- |
| `research-laws-and-gaps-2026-08-05.md` | 21665 | `91eadd510897f655f7ece805a3054fb7648c2f76f3546d55bbd0e55fe146f673` | 2026-08-05 |
| `recon-open-failing-composition.md` | 10088 | `a77d9876d90a15dafa5f278f4115e7ad881003fa7a61c2ca7835d35fc8a5a2b5` | 2026-08-06 |
| `recon-proof-survey.md` | 9077 | `c575cf41c6d1b45622670d2cf9f4fda2d06e42a24ba1b2d2aad9d7e2791f4115` | 2026-08-06 |
| `recon-guard-complements.md` | 14152 | `ba67deb3e185b477e9511cc7c7a012c8e1980ea45fbc3b11c991a0e79e7701d2` | 2026-08-11 |

Every digest above was verified on both sides of the copy, and `cmp` reported the files identical before
they were staged. Three of the four are dated 2026-08-05/06; `recon-guard-complements.md` is dated
2026-08-11, which is recorded here rather than rounded into the others.

**The accounting, stated plainly so nobody mistakes this for a complete rescue.** Tracked files cite
**31 distinct `state/*.md` paths**. After this commit, **3 of those 31 now resolve** —
`research-laws-and-gaps-2026-08-05.md`, `recon-guard-complements.md` and
`recon-open-failing-composition.md`. **The other 28 do not**, and on the evidence available at recovery
time they are not anywhere. `recon-proof-survey.md` is a **fourth file that no tracked file cites** —
recovered because it survived alongside the others, not because anything pointed at it.

## Their citations still point at `state/`

The tracked files that reference these reports still name them under their original `state/` paths, so
those citations remain broken even though the content now exists. Repointing them is a separate concern
and is deliberately not done in the same change as the recovery.
