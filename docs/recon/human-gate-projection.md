# One actionable human-gate projection, with the Inbox as its front door (W1-T5021)

STATUS: design only. Nothing here is implemented, and no `src/` file changes in this task. The child
tasks under "Implementation slices" are each independently buildable and carry their own test.

METHOD. Every claim below was read from `src/` at `d829a6507` (symbol names, not line numbers). Where a
prompt or a task record said something the code does not, the code is followed and the difference is named.
Where a fact could not be settled from the repo it is stated as an ASSUMPTION in "Open assumptions".

## 1. What is wrong, measured

W1-T3186 already RULED that the Inbox is the only front door for an ask, that change management is its own
area, and that `NEEDS ME` is dissolved. W1-T3395 (the renderer) was retired as too large. What shipped
instead is several partial projections that each answer "what is the operator owed?" differently:

| # | Quantity named "needs you" | Where | What it counts |
|---|---|---|---|
| 1 | `groupNowBoard().needsYou` | `src/lib/now-view.ts` | board rows with `needsHuman`, after running rows claim theirs first |
| 2 | `NowViewData.decisions` | `src/lib/now-decisions.ts` | open escalations, MANUAL approvals, `grilling` feedback, open task questions; capped at `NOW_DECISIONS_CAP` (50), rest in `decisionsMore` |
| 3 | `inboxLanes().counts.needsYou` | `src/lib/panel-graph.ts` | operator-owned proposals in ready, drafting, notReady AND declined |
| 4 | `inboxCounts()` (nav badge) | `src/lib/nav-badge-view.ts` | operator-owned proposals in ready, drafting, not_ready, and NOT declined |
| 5 | `NeedsMeSection` | `src/lib/status-board.ts` | costAnomaly, imageDrift, mergeHeld, uncreditedBuilds, tokenFallback, heldRoots |
| 6 | `summarizeCounts().blocked` | `src/lib/board.ts` | `status === "blocked"` OR `needsHuman` |

Consequences, each observable in the code and not inferred:

- Rows 3 and 4 disagree about `declined` for the SAME inbox classification, so the badge and the page differ.
- One escalated task is counted by rows 1, 2 and 6 at once, so no single number is "things I must decide".
- `GET /v1/status` has no `needsYou` field. `grep needsYou` over `src/lib/board.ts`, `status.ts`,
  `status-board.ts` and `status-stream-publisher.ts` finds nothing; the nearest signals are `tasks[].needsHuman`,
  `blockedPrs`, `mergeHeld` and the `blocked` count in row 6. The word names four different things in four files.
- `classifyAskRecordItem` has exactly ONE production call site (section 3), and the Inbox does not use it.
- The classifier and the Inbox disagree on `InboxState`: the classifier says `ready`, `not_ready` and
  `deferred_with_trigger` are ASK and `drafting`/`declined` are RECORD; `inboxLanes` puts `drafting` and
  `declined` inside `needsYou` and never returns `deferred_with_trigger` at all (`buildInboxRoute` documents it).
- Several human-owed conditions have no action path anywhere: held dependency roots render on `rmd status` only;
  a `verify: human` task sets `verifyHumanPending` on its row but only task-case-file reads it as a `next` action;
  the stale-reviewer `needs_human` outcome is a ledger line plus a callback (`onStaleReviewerNeedsHuman`), with
  no row on any surface; a `new` feedback entry is invisible until it becomes `grilling`.

## 2. The HumanGate record

The smallest record that gives every source one front door, one count and one verb. SEVEN fields, as the task
specifies; nothing else is added to the wire shape.

```ts
interface HumanGate {
  kind: HumanGateKind;            // closed union, section 4
  key: string;                    // `${kind}:${instance}:${subject}` — the de-duplication identity
  ownerSurface: "inbox" | "change-management";
  openedAt: string | null;        // absolute ISO time from the SOURCE; null only when the source carries none
  url: string | null;             // the thing to look at: an issue, a PR, a task, a feedback entry
  reason: string;                 // one plain sentence: what is being asked and why a machine cannot decide
  resolutionVerb: ResolutionVerb; // exactly ONE, from the closed table in section 5
}
```

Rules that make it a projection and not a store:

1. DERIVED, NEVER WRITTEN. A gate is a pure function of the source state at read time. There is no gate table,
   no dismissal state, no "snooze". Resolving the SOURCE (closing the issue, releasing the hold, answering the
   question) is the only thing that removes a gate. This is why expiry (section 6) is a source predicate.
2. NO CLOCK IN THE BODY. `openedAt` is the source's own time, so an unchanged state keeps its ETag, the same
   rule `inbox-view.ts` and `now-decisions.ts` already state for their bodies.
3. UNKNOWN IS NOT ZERO. A source that could not be read contributes a `sources[]` entry with
   `state: "unavailable"` and a reason, and the count becomes `{ atLeast: n }`. This is the shape
   `nav-badge-view.ts` already uses; the projection reuses it rather than inventing one.
4. FAIL TOWARD THE HUMAN. A kind or disposition the projector does not recognise is the operator's, the same
   rule `inboxOwner` documents ("an unknown kind is the operator's"). It is never silently dropped.
5. TRUE HUMAN JUDGEMENT ONLY. A condition a machine can still repair is NOT a gate (section 7); it becomes one
   only when its repair path is exhausted, which is a state the source already records.

## 3. The classifyAskRecordItem call path, traced

`classifyAskRecordItem` (`src/lib/ask-classification.ts`) is documented as the ONE predicate "BOTH the inbox
renderer and the change-management renderer consult". At HEAD that is not true. The traced paths:

**Path A — the only production call.**
open escalation issue -> `projectPlan` (`src/lib/status.ts`) sets `BoardRow.needsHuman` and the
`escalation*` fields -> board snapshot -> `taskRendersOnInitialBoard` (`src/lib/serve.ts`) calls
`classifyAskRecordItem({ kind: "escalation", resolved: row.needsHuman !== true })` -> `projectConsoleStatusResponse`
keeps ASK rows when the plan exceeds `CONSOLE_STATUS_FULL_TASK_THRESHOLD` -> `GET /v1/status` `tasks[]`.
Here the classifier only chooses which rows survive the initial-board bound. It counts nothing and routes nothing
to the Inbox. Its `proposal`, `question` and `rundown` arms have no production caller.

**Path B — the Inbox, which does not consult it.**
`classifyAllProposalsSliced` -> `inboxLanes` (`src/lib/panel-graph.ts`) splits by `inboxOwner` -> `lanes.needsYou`
-> `inboxViewBodies` (`src/lib/inbox-view.ts`, `section=needsYou`) -> `composeNeedsYou`
(`src/lib/needs-you-view.ts`, `inbox`). The predicate is the state union plus `inboxOwner`, not the classifier.

**Path C — escalations into the composite.**
board rows -> `escalationDecisions` (`src/lib/now-decisions.ts`) -> `NowDecision` -> `now` view `decisions` ->
`composeNeedsYou` `decisions`. No classifier call; the filter is `t.needsHuman && t.escalationIssueUrl`.

DESIGN CONSEQUENCE. The projector in section 4 becomes the single consumer of the classification. Slice 2 makes
Paths A, B and C read one projection, and extends the classifier's input union with a `gate` source so its
exhaustiveness check (`never`) forces every new kind to be classified. The classifier stays the one
ASK/RECORD predicate; the projection supplies its inputs.

## 4. Source-to-HumanGate contract

Every source, what makes it a gate, its key, owner action and expiry. `ownerSurface` is `inbox` unless stated.
"Verb" names a row of the section 5 table. The Inbox is the only surface that INTERRUPTS and the only one whose
count is "things I must decide"; `change-management` gates are listed in that area (W1-T3186 clause ii) and add
to a SECOND, separately labelled count, never to the Inbox badge. There is no third surface and no second door.

| Source (today) | kind | Is a gate when | key subject | owner action (verb) | expires when (all derived from the source) |
|---|---|---|---|---|---|
| Open escalation issue, class != MANUAL (`escalation.issue_opened`, `BoardRow.needsHuman`) | `escalation` | the issue is OPEN. If open state could not be confirmed (`escalationUnverified`) it STAYS a gate and the reason says so — fail closed | task id | `mark_handled` | the issue closes, or the referent task reaches a terminal state (the classifier's `resolved`) |
| Open escalation, class MANUAL | `manual_approval` | the issue is OPEN | task id | `approve` | issue closes; approval route ledgers `panel.*` |
| Open task question (`plan/questions.ndjson`) | `task_question` | a QUESTION with no later answer, on a task not merged/done | task id + question ts | `answer` | an answer line or `panel.question_answered` fact is newer; task closes |
| Feedback entry `grilling` | `feedback_grill` | status `grilling` | feedback id | `answer` | status leaves `grilling` |
| Feedback entry `proposed` | `feedback_proposal` | status `proposed`, awaiting accept/reject | feedback id | `ratify` | status becomes `accepted`/`rejected` |
| Feedback entry `new` | `feedback_new` | `new` AND older than the measured triage age bound (slice 6); until then it is MACHINE work (`auto-triage.ts` claims it) | feedback id | `triage` | status leaves `new` |
| Inbox proposal, operator-owned (`inboxOwner === "operator"`), state `ready` / `not_ready` / `deferred_with_trigger` | `proposal` | per `classifyAskRecordItem` proposal arm; fleet-owned proposals are NOT gates | proposal id | `ratify` (ready), `reframe` (not_ready) | state becomes ratified/retired/declined, or the proposal row is pruned |
| Dependency review ESCALATE (`dep-review.ts`: unparseable bump or unextractable major; MANUAL escalation) | `dependency_review` | the MANUAL escalation issue is open | PR number | `approve` | issue closes or the PR closes. MIGRATE is NOT a gate: it files durable feedback and closes the PR by itself |
| Held dependency root (`heldDependencyRoots`: `verify-not-auto` or `blocked` with no retirement) | `held_root` | the root is unmerged, unreleased, and at least one task stalls behind it | root task id | `release` or `retire` | the root merges, is released, or gets a retirement ruling; or `stalled` becomes empty |
| `verify: human` task (`verifyHumanPending`) whose judge ruled it genuinely needs a person (W1-T3188) | `verify_human` | `verifyHumanPending` AND judge verdict is "needs human". A judge-cleared one becomes a fleet-owned `verify-human-automate` proposal and is NOT a gate | task id | `verify` | the task merges or `verifyHumanPending` clears |
| Missing/drifted pin (`ratificationPinCheck`, `plan/ratifications.yaml`) | `pin_drift` | a ratified rung's recomputed `operationHash` differs from its pin (`{fire:false}`). An ABSENT row is NOT a gate: it fires unopinionated BY DESIGN (W1-T2694) | rung name | `reratify` | a pin row matching the live hash exists |
| Stale reviewer, `needs_human` outcome (`review.stale_reviewer_needs_human`, once per `codeSha`) | `stale_reviewer` | the loaded reviewer code sha != origin/main AND `trackStaleReviewerSkipRecurrence` returned `needs_human` | `codeSha` | `restart` | the daemon's loaded code sha equals origin/main, or a newer `codeSha` supersedes it (the newer key replaces the older) |
| Blocked PR, disposition tone `exhausted` or `unknown` (`nowActions`) | `blocked_pr` | the sweep recorded no remaining machine repair | PR number | `rework` or `close` | the PR merges/closes or the next `sweep.disposed` has a repairable tone |
| Blocked PR, tone `blocked` | `blocked_pr`, `ownerSurface: "change-management"` | a disposition that needs work but not a decision | PR number | `rework` | as above |
| Blocked PR, tone `repairing` | NONE | a fix lane is still running; machine repair, no human (section 7) | — | — | — |
| Operator merge hold (`automerge.hold_engaged`, `mergeHeld`) | `merge_held`, `ownerSurface: "change-management"` | a hold stands (never `hold_released`). The operator made it; it is a standing refusal, not an ask | PR number | `release_hold` | `automerge.hold_released` for that scope |
| Status-board operator items: `costAnomaly`, `imageDrift`, `tokenFallback`, `uncreditedBuilds` | `operator_item` | the board row is present (they already render only when they stand: healthy renders nothing) | item name | `acknowledge` (read) or the row's own named action | the row stops rendering. These are RECORD-like unless their row names an action; slice 8 classifies each rather than assuming |

RECORD, NEVER GATES (the classifier's falsifier, kept): a rundown line (`RundownLine`), a resolved escalation,
an answered question, a ratified/retired proposal. A rundown line and an escalation fired by the same blocked
task produce one gate (the escalation) and one record (the rundown) — never two gates.

DE-DUPLICATION. `key` is the identity; the projector keeps one gate per key. The same condition seen through
several sources collapses: the `needsHuman` board row, its `escalationDecisions` entry and its Mailbox thread
(W1-T3187's double render) are ONE `escalation:<instance>:<taskId>`. Two instances never collide because the
instance is in the key. A MANUAL escalation and a plain one for the same task keep the older issue's kind.

## 5. Ownership and the resolution vocabulary

Each gate has exactly ONE `resolutionVerb`, dispatched by the existing write route and tier, so no new write
surface and no new approval gate is added. The tiers are the ones already in `ESCALATION_OPTION_ROUTES`:

| verb | existing route | tier |
|---|---|---|
| `approve` | `POST /v1/manual/approve` (escalation) or `POST /v1/inbox/approve` (proposal) | high |
| `mark_handled` | `POST /v1/escalation/mark-handled` | low |
| `answer` | `POST /v1/questions/answer`, or `POST /v1/feedback {replyTo}` for a grill | low |
| `ratify` / `reframe` | the proposal card routes (W1-T111/T193) | high / unchanged |
| `triage` | `POST /v1/drain/feedback` | low |
| `release_hold` | `rmd merge-hold` release (operator CLI, `--confirm`); no new route | as today |
| `release` / `retire` | the plan edit that releases or retires the root; no new route | PR, as today |
| `restart`, `rework`, `close`, `reratify`, `verify`, `acknowledge` | the existing operator action each names; where none exists as a route the verb is `operator-only` (`EscalationOptionKind`'s own term) and the row says so | n/a |

This retires the "Mark handled" / "Open" / "Resolve" triple that W1-T3186 (v) named: a gate has one verb, and
whatever the operator does is visible wherever the same key renders because every surface reads the same
projection.

ADDING NO APPROVAL GATE. The projection only reads and re-labels. It adds no PR check, no merge condition, no
new `approve` requirement and no dispatch precondition. An implementation slice that would add one is out of
scope by this design and must be refused at review.

## 6. Expiry, in one rule

A gate has NO time-to-live of its own. It exists while its source predicate holds, and the table's right-hand
column is that predicate. Two consequences, both deliberate:

- NOTHING AGES OUT SILENTLY. W1-T507 recorded 31 `verify: human` tasks waiting on a person nobody told; a TTL
  would hide that queue instead of showing it. An old gate sorts OLDEST-FIRST with its age shown, so the queue is
  aged by being visible, not discarded.
- SUPERSESSION IS BY KEY. Event-sourced gates (`stale_reviewer` by `codeSha`, `blocked_pr` by PR number and its
  latest `sweep.disposed`) keep one live key; a newer event replaces the older one, so a re-fire does not stack.

The only age-based boundary in the design is `feedback_new`'s "older than the triage bound", and it is a
PROMOTION from machine work to human work, not an expiry. Its bound is MEASURED first (slice 6), because a bound
that fires on a healthy condition is this repo's recurring defect and no number is chosen here.

## 7. Machine-actionable repair versus true human judgement

The projection separates them with one test: can an existing automated lane still change the outcome?

| Condition | Machine lane | Becomes a human gate when |
|---|---|---|
| Blocked PR, `repairing` tone | sweep fix lane (strike n of N) | strikes exhausted -> tone `exhausted` -> `blocked_pr` gate |
| Stale reviewer | restart request (`review.stale_reviewer_restart_requested`) | `trackStaleReviewerSkipRecurrence` returns `needs_human` (restart did not clear it) |
| Dependency PR, confined minor/patch | ARM + auto-merge | never; held PRs are `HOLD`, not gates. ESCALATE only |
| Dependency major | MIGRATE: feedback + close | never (the feedback entry is then ordinary feedback) |
| `verify: human` judged automatable | `verify-human-automate` fleet proposal | never (fleet-owned) |
| Fleet-owned inbox proposal | the fleet lane (`inboxOwner === "fleet"`) | never |
| New feedback | `auto-triage.ts` | older than the measured bound with no triage claim |
| Missing pin row | none needed; fires unopinionated | never; only a MISMATCH is a gate |

The projection never performs the repair and never marks a machine-repairable condition as a gate "to be safe";
the opposite error, hiding a human-owed one, is the one W1-T507 and W1-T3186 (iv) forbid, which is why
unrecognised inputs fall toward the human (rule 4 of section 2).

## 8. Count semantics

One function, `projectHumanGates(sources) -> { gates, count, sources }`, owns every number:

- `count.inbox` = distinct keys with `ownerSurface: "inbox"`. THIS is "the count of things he must decide"
  (W1-T3186 i). It is the Inbox badge, the `needs-you` composite's header, and `GET /v1/status`'s new
  `needsYou` field (slice 7), by construction the same number.
- `count.changeManagement` = distinct keys with `ownerSurface: "change-management"`, labelled separately and never
  added to `count.inbox`.
- `count.byKind` = per-kind counts of `count.inbox`, so a surface can group (W1-T507's "threads by type").
- Capping: a surface may show a first page, but the total is always the projection's, with `more` stated, as
  `NOW_DECISIONS_CAP`/`decisionsMore` already do. A cap never changes `count`.
- Partial reads: an unreadable source makes `count` `{ atLeast }` with a named reason; it is never rendered `0`.

The six quantities in section 1 become views of this one function: row 1 and 6 stop counting `needsHuman` as a
decision count, rows 3 and 4 share one predicate (the `declined` disagreement disappears because `declined` is
RECORD per the classifier), and row 5 becomes the `operator_item`/`held_root`/`merge_held` kinds.

## 9. Implementation slices

Each slice is one PR, has its own test, adds no approval gate, and names what it depends on. Slice 1 lands first
because it defines the type; slices 2-8 depend ONLY on slice 1 and are independent of each other. None needs the
others to be merged to be correct — a surface simply shows the kinds that exist so far.

1. **Gate type and pure projector** — `src/lib/human-gate.ts`: `HumanGate`, `HumanGateKind`, `projectHumanGates`,
   key de-duplication, oldest-first order, `count` and the `atLeast`/unavailable shape. Kinds wired from sources
   already in-process: `escalation`, `manual_approval`, `task_question`, `feedback_grill` (reusing
   `escalationDecisions`, `taskQuestionDecisions`, `grillDecisions`). Test: one fixture where a task has an open
   escalation, a rundown line and a Mailbox-equivalent row yields exactly ONE gate; an unreadable source yields
   `atLeast`, not zero. Depends on: nothing.
2. **One classifier input, three paths** — add a `gate` arm to `classifyAskRecordItem`, route `taskRendersOnInitialBoard`,
   `inboxLanes` and `composeNeedsYou` through the projection, and resolve the `drafting`/`declined`/
   `deferred_with_trigger` disagreement (section 1). Test: for every `InboxState`, the Inbox page, the nav badge and
   the classifier agree on ASK vs RECORD. Depends on: 1.
3. **Change-management kinds** — `blocked_pr` (tone mapping: exhausted/unknown to inbox, blocked to
   change-management, repairing to none) and `merge_held`, from `nowActions`. Test: a `repairing` PR yields no gate;
   a strike-exhausted one yields an inbox gate; a `hold_released` ledger row removes the hold gate. Depends on: 1.
4. **Dependency and verify kinds** — `dependency_review` (MANUAL escalation from the ESCALATE verdict), `held_root`
   (from `heldDependencyRoots`), `verify_human` (judge-ruled only, W1-T3188). Test: a MIGRATE verdict yields no
   gate; a judge-cleared `verify: human` yields none; a held root yields one gate with its `stalled` list.
   Depends on: 1.
5. **Pin and stale-reviewer kinds** — `pin_drift` from `ratificationPinCheck`'s `{fire:false}` and `stale_reviewer`
   from `review.stale_reviewer_needs_human`. Test: an ABSENT pin row yields no gate (the falsifier for inventing one);
   a newer `codeSha` supersedes the older key. Depends on: 1.
6. **Feedback kinds** — `feedback_proposal` and `feedback_new`. FIRST measures how long a `new` entry normally waits
   for `auto-triage` (the age bound is an output of this slice, recorded in the PR, not a guess made here). Test:
   a `new` entry inside the bound yields no gate; one past it does. Depends on: 1.
7. **One count on every surface** — `GET /v1/status` gains `needsYou: { count, byKind, changeManagement }`; the nav
   badge, the `needs-you` composite and `now-view` read the same projection and stop computing their own. Test: one
   fixture with N gates reports N on all four surfaces. Depends on: 1 (and shows more as 3-6 land).
8. **Status-board operator items** — classify `costAnomaly`, `imageDrift`, `tokenFallback`, `uncreditedBuilds` as
   `operator_item` gate or RECORD, each with a stated reason. Test: a healthy board yields zero gates (these
   rows already render only when standing). Depends on: 1.

## 10. Open assumptions

QUESTION: what the task's "missing pin" refers to. CURRENT_ASSUMPTION: ratification pin drift, because it is the
only "pin" with an operator action at HEAD (`rmd ratify <rung>`, `plan/ratifications.yaml`); an absent row is inert
by design, so only a hash mismatch is a gate. IMPACT_IF_WRONG: low — slice 5 re-reads the producer first.

QUESTION: whether the judge's "genuinely needs a person" verdict (W1-T3188) is a readable field today.
CURRENT_ASSUMPTION: the verdict `src/lib/verify-human-judge.ts` produces is readable per task id.
IMPACT_IF_WRONG: low — slice 4 falls back to the operator-owned `verify-human` proposal kind, which
`inboxOwner` already treats as the operator's.

QUESTION: whether the status-board operator items name a resolution action. CURRENT_ASSUMPTION: most do not and
are RECORD. IMPACT_IF_WRONG: low — slice 8 decides each row on its own evidence.
