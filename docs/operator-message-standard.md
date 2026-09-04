# Operator Message Standard (W1-T2279)

Status: NORMATIVE. Scope: `rmd status`'s rendered board, the console's rendered rows reading
the same board model, and the narrative half of an escalation issue body. See "Surfaces in
scope" below for the precise boundary, and "Out of scope" for what this document deliberately
does not touch.

## Read this first: the messages that misled were WRONG, not unclear

Before anything else: the console's worst outage cost 3h51m and the message that would have
explained it was already good prose — `fleet-control.ts`'s pause line, "PAUSE held on `<ref>`
(set from another host) — run `rmd resume` to clear", names the condition, the cause and the
remedy in one sentence. It cost 3h51m anyway because nothing rendered it. No amount of
plain-language polish reaches a message that is never displayed.

The messages that DID mislead an operator share a different shape, and it is not a prose
problem: each one rendered an absent, unpopulated, or unobserved input as a proven negative.
`status-board.ts`'s `renderLatchesBlock` prints "no active latches" from `if
(!latches.rows.length)` — an EMPTY COLLECTION rendered as a proven negative, when the collection
was empty because the collector could not see a ref-backed latch. `status-board.ts`'s daemon
liveness rule fires "the daemon is not running — `rmd up` (or `rmd daemon ...`) to resume the
fleet" from `!ctx.services.find((s) => s.service === "daemon")?.running`, and that optional
chain cannot distinguish a service row present with `running: false` from no row at all: an
unobserved daemon and a stopped daemon produce the identical sentence.

These messages were not unclear. They were **wrong rather than unclear**. A plain-language pass
over any of them makes them worse, because it improves the delivery of a false statement — it
polishes a false statement, and polishing a false statement makes it worse, never better. This
standard does not certify that any message is true. It only requires that a message which
asserts an absence say honestly which kind of absence it is, and that a required next-action
slot is either filled or explicitly declared empty.

## The four principles this standard adopts (ISO 24495-1:2023)

ISO 24495-1:2023, "Plain language — Part 1: Governing principles and guidelines", states four
governing principles as properties of the READER's experience, not properties of the text:

- Readers get what they need (**relevant**)
- Readers can easily find what they need (**findable**)
- Readers can easily understand what they find (**understandable**)
- Readers can easily use the information (**usable**)

This document adopts those four principles, by name, as a structural contract over the messages
in scope below. It cites NO clause number from the standard: iso.org's own page and the ANSI
preview PDF both returned HTTP 403 during this task's research, so no clause number was ever
read, and none appears in this document on the strength of a source nobody here has seen. A
builder who needs a clause number must obtain the standard itself.

## Scope: a STRUCTURAL contract over UNSTRUCTURED messages only

This standard governs only **unstructured** messages: ones assembled ad hoc at a call site,
carrying no declared condition, consequence, or action. It is a structural contract, not a
wording contract — it says a message must carry certain parts, never that the words be
prettier. It does not, and cannot, certify that a message's content is correct: whether a
message correctly names WHAT HAPPENED and WHY IT MATTERS is a judgment only a reader can make.

**Excluded by name, and not reworded by this or any later task on this document's authority:**
the containment verdict strings (W1-T238, W1-T1281) — for example `containment.ts`'s
"containment UNPROVEN: turns-exhausted — the probe ran out of its turn budget before an
OS-denial for the outside-cwd write could be observed; this is NOT the same fact as an
unattempted write and containment stays UNPROVEN". That sentence is dense on purpose: the
distinction it draws (turns-exhausted vs. never-attempted) is what stops a false verdict, and
that distinction lives only in a reader's head — no diff can prove a rewrite preserved it. A
reviewer who already understood the old sentence is exactly the reader least able to tell
whether a new one still teaches it. Every hard-won precise sentence like this one is out of
scope for this standard; only unstructured messages are governed.

## The four-part structure

i.   WHAT HAPPENED — the condition, named as observed.
ii.  WHY IT MATTERS TO THIS READER — the consequence, in the reader's terms.
iii. WHAT THE READER CAN DO — and where there is nothing, the message SAYS there is nothing
     rather than omitting the part.
iv.  IF THE MESSAGE ASSERTS A NEGATIVE OR AN ABSENCE, it distinguishes "observed absent" (the
     input was checked and found empty or false) from "not observed" (the input was never
     successfully collected at all) — or it does not assert the negative at all.

### What a machine can check, and what only a reader can judge

MECHANICALLY CHECKABLE: only part (iii), and only as a SLOT — whether a required field exists
and is populated, or is explicitly null. A test or a type can prove a slot exists. It cannot,
and must not, prove that what the slot says is the right action, and this standard defines no
readability score, no word-count gate, and no sentence-length threshold — none should ever be
added in this standard's name, because this repo cannot compute reader comprehension honestly.

The repo already proves the slot works, in types, on two surfaces, today:

- `status-board.ts` declares `interface NextActionRule<TCtx> { applies: (ctx: TCtx) => boolean;
  action: (ctx: TCtx) => string; }` — `action` is a REQUIRED, non-optional field, so a liveness
  or latches rule cannot exist without naming an action.
- `escalate.ts`'s `Escalation` interface documents `detail` as "what happened, why it's stuck"
  and declares `options: EscalationOption[]` REQUIRED, with the comment that an escalation with
  no options is a bare alert.

REVIEWER-JUDGED, NEVER MACHINE-CHECKABLE: (i), (ii), and whether the action named in (iii) is
the RIGHT action for the observed condition. No check built from this standard may claim to
certify either.

### A filled slot is not a true message

`status-board.ts`'s daemon-liveness rule is a `NextActionRule` whose `action` fires "the daemon
is not running — `rmd up` (or `rmd daemon ...`) to resume the fleet". That message already
satisfies part (iii) completely: a filled action slot, a named command, a stated consequence.
It is still FALSE, for the reason given above (the optional chain cannot tell "no row" from
"row present, not running"). `NextActionRule` already type-enforces the one mechanically
checkable part of this standard — the action slot cannot be omitted — and the message inside
that very type-enforced slot is false anyway. A check built from this standard catches only the
MISSING part of the structure; it must never be read, described, or advertised as certifying
that a message is true.

## Surfaces in scope

- **`rmd status`'s rendered blocks** — `renderStatusBoardText` and its per-section helpers in
  `status-board.ts` — and the console's rendered rows, which read the same board model. One
  audience: an operator deciding whether to intervene. Both already carry a `nextAction` slot,
  so this standard describes the structure already present rather than inventing one.
- **The escalation issue body's `summary` and `detail`** (`escalate.ts`) — the NARRATIVE half
  only, read by a person who may be on a phone, nowhere near a terminal. The option-to-action
  half — making an option in `Escalation.options` terminate in something executable — belongs to
  W1-T2273 and is not re-filed here; this document says nothing about options beyond noting the
  slot already exists.
- **The narrative half of a generated commit message** (`buildPlanPrCommitMessage`, shaped by
  `shapeCommitMessage`) — the explanatory paragraphs, not the header. Its reader is whoever finds
  the commit later doing archaeology, plus the retro. That reader is the one this repo has owed the
  least structure to: `shapeCommitMessage` guarantees a header length, a subject case and a wrapped
  body, and every one of those is a commitlint contract about SHAPE. None of them asks whether the
  reader learns anything.
- **The narrative half of a generated PR body** (`buildPlanPrBody`'s intro prose) — the sections
  above the rendered blocks, read by a reviewer deciding whether to merge.

### On the two generated surfaces, the parsed structure is FROZEN

This is the whole difficulty of extending the standard to text a machine also reads. Generated
commit and PR text is parsed back by this repo in at least four ways: the `Remudero-Task:` trailer
is matched line-anchored to credit a merge; a `(W1-Tnnn)` subject citation is a second credit path;
`parseAcceptanceBlock` resolves criteria out of a PR body and fails CLOSED when it resolves none;
and `bodyContradictsDiff` reads the body against the real changeset. A plain-language pass that
treated any of that as prose would break credit, review, or both — silently, on a PR whose checks
are all green.

So on these two surfaces the standard governs the NARRATIVE parts only, and nothing here may move a
byte a parser reads. In particular the conventional `type(scope)` prefix, every commitlint limit
`shapeCommitMessage` enforces, the trailer, the subject citation, the changed-files block and the
acceptance block — its header form, its bullet forms and its proof dialects — all keep their exact
present shape. **And the mark is never spliced into the text.** A conformance note appended to a PR
body would sit after the acceptance block, whose bullets must never be interrupted; appended to a
commit message it would land in the trailer region. On these surfaces the check is therefore
returned BESIDE the record, not written into it.

Nor may this standard ever block a commit or a pull request. `operator-message.ts` fails toward
delivery, and a gate that refused to commit because a paragraph was thin would strand real work for
a prose judgement no machine can make.

## Out of scope: the daemon's stdout

The daemon's own stdout is excluded from this standard. Its only readers are operators actively
debugging, it is high-volume, and its lines are the forensic record that every retro greps;
restating any of it in this standard's terms would invalidate the searches that depend on its
current wording, for no gain to a reader who is not already reading source.

## What this task does not do

No existing operator message is reworded by this document or by the test that enforces it.
Establishing the standard and naming the one mechanically checkable slot is this task's whole
scope. A per-surface rewrite is separate, later work that must cite this document rather than
repeat its reasoning. And no message is ever simplified into being wrong: where a true statement
is unavoidably technical — the containment verdict strings above are the standing example — the
remedy is to ADD what the reader can do, never to remove what it says.
