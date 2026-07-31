# Account selection: which account a run uses

Decision record, W1-T266. Depends on W1-T265 (shipped, PR #1022 / commit 843ecce), which made
the worker credential store identity-aware and per-account-capable but deliberately selects
nothing — it only makes the one store that exists follow whichever account is actually logged
in. This record answers the question W1-T265 explicitly left open: which account should a run
use, and does the fleet ever need two live at once.

THIS RECORD RULES NO CODE CHANGE. It changes no dispatch path and no spawn. Its only effect is
on which of three filed, dependent tasks (W1-T268, W1-T269, W1-T270) should be built.

## SELECTION MODE

**Ruling: `pinned`** — one account per host, switched deliberately by an operator, never chosen
per-run by the fleet itself.

The other two candidate modes are rejected:

- **`most-headroom`** (route each run to whichever configured account currently has the most
  window left) requires a live, comparable headroom reading for every configured account *before*
  a run is dispatched. That reading does not exist today — `UsageSnapshot`
  (`src/lib/headroom.ts:45`) is `{ billingMode, session, weekly }` with no account field, by
  design, because the module does window math for exactly one budget. Building the comparison
  this mode needs is W1-T269's entire scope, and W1-T269 is itself gated on this ruling — so
  `most-headroom` would require standing up its own prerequisite as a side effect of naming it.
  It is also the mode with the worst asymmetric-failure shape: a routing bug here doesn't just
  misattribute spend after the fact, it silently spends the *wrong* account's remaining window
  while the operator believes the fleet is conserving the one they intended.
- **`next-available`** (round-robin or first-unlocked account) assumes concurrent multi-account
  operation is the target end state — otherwise "available" only ever resolves to one candidate
  and the mode degenerates to `pinned` with extra machinery. Concurrent operation is rejected
  below, so this mode has no product to serve.

`pinned` is also the mode the fleet already has, operationally: W1-T265 shipped an
identity-aware re-provision precisely so that a pinned switch (`claude /logout` + `/login` as a
new subscription, documented at `docs/operator-guide.md:349` "Switching the fleet's Anthropic
account") is safe and ledgered. This ruling formalizes the mode already in production rather than
introducing a new one.

## SERIAL SWITCH versus concurrent

**Ruling: serial switch only. Two accounts must never be live simultaneously on one host.**

Two independent sources point the same direction:

1. **What the operator actually did.** The observed operation (07e5861-era rationale, W1-T265)
   was a one-way move of the *whole host* from one subscription to another — logout, login,
   re-provision — not two credential stores spending side by side. The stated ask ("multiple
   subscriptions working on rmd seamlessly") and the operation performed are different products
   with different costs, and this ruling declines to build the more expensive one on the strength
   of the stated ask alone.
2. **Published house policy.** `MASTER-PLAN.md` records, twice (line 1714-1715 and line
   1863-1864, in the "Published promises" and "Security posture" sections respectively), as a
   testable, non-marketing commitment: *"operators run the harness on their own subscription per
   Anthropic's terms (one operator, one account, one machine; the harness is a tool for your seat,
   not a seat-multiplier)."* Concurrent multi-account operation — two subscriptions spending at
   once from one fleet — is a seat-multiplier by construction. Building it would put the codebase
   at odds with a ratified public promise. A *serial* switch (one account live, deliberately
   changed) is fully consistent with that promise; concurrent operation is not.

Because this ruling is serial-switch, not concurrent:

- **W1-T269** (per-account headroom: splitting `UsageSnapshot`, the reserve curve, and the
  governor's gate across multiple simultaneously-live accounts) **should be WITHDRAWN rather than
  built.** With one account live per host, the existing single-window governor is already
  correct; a per-account split of a set with one element is pure cost with no behavioral payoff.
- **W1-T270** (console account-control surface, gated on W1-T269) **should be WITHDRAWN as
  filed.** Its own text allows that the read-only spend-per-epoch view might still be wanted on
  its own merits even under a serial ruling — that is a separate, smaller task (a history view
  keyed by the ledger's account label, not a live multi-account panel) and is out of scope here;
  see Follow-ups.
- **W1-T268**'s ledger account dimension (giving every spend-carrying ledger line an account
  label plus the hard-start `ACCOUNT_ATTRIBUTION_EPOCH`) **is unaffected in shape but collapses
  in cardinality**: at any instant exactly one label is "current" per host, so the dimension
  records *history* (which account a past line was attributed to, across switches) rather than
  *concurrency* (which of several simultaneously-live accounts a line belongs to). W1-T268 is
  still worth building for that historical record — it is the only way to answer "how much did
  we spend on the old subscription before the switch" — but it is not a prerequisite for any
  live-concurrency feature, because none is being built.

## THE SEAM

If a selector is ever wanted after all — a future ruling reopens this — the one pure function it
would have to attach to is `workerKeychainPaths(stateDir, accountLabel?)`
(`src/lib/worker-home.ts`). It is already shaped to carry a label: given an `accountLabel` it
returns a distinct `remudero-worker-<label>.keychain-db` / `worker-keychain-password-<label>`
pair instead of the legacy unlabelled files, and W1-T265's `ensureWorkerKeychain` already accepts
an `accountId` to detect when the login identity underneath a store has drifted. What is missing —
and what this ruling declines to add — is anything upstream that *decides* which label to pass in
for a given run.

A `.remudero/mounts.yaml` `account:` row alone would be inert: `parseMount`
(`src/lib/mounts.ts:123-144`) destructures exactly `{ model, effort, max_turns, context_budget }`
from the raw mount object, and there is no unknown-key rejection anywhere in that file, so an
added `account:` key would parse cleanly, fail nothing, and be silently dropped on the floor — the
same #781 trap CLAUDE.md already records (a named declarative source that ships green and changes
nothing observable). Any future selector must reach `workerKeychainPaths` directly (or its one
caller, `spawnWorker` in `src/lib/worker.ts`) — a data row elsewhere is not sufficient by itself.

## THE ACCOUNTING EPOCH

The instant before which per-account attribution is impossible, quoted exactly so no downstream
reader has to re-derive it:

**2026-07-31T16:39:00.582Z**

This is the sole `daemon.worker_keychain` line in the unioned ledger (4,160,926 lines across 662
files) that reads `provisioned:true` — the boot that re-provisioned the worker keychain after the
operator's manual account switch. No line before it can be attributed to an account, because no
line before it carries one. W1-T268, if built, must export this exact literal as
`ACCOUNT_ATTRIBUTION_EPOCH` rather than re-deriving it from the ledger at read time.

## Policy data

No row is added to `plan/policy.yaml`. The design this task was filed under is explicit that a
non-pinned mode is carried as validated policy data and a `pinned` ruling adds nothing — the
absence of a policy row is itself the record of that choice. `pinned` needs no enum value: it is
the mode the fleet already runs today (a single unlabelled credential store, switched by hand per
`docs/operator-guide.md`'s documented procedure), so there is no new default to bound or validate.

## Follow-ups

- task: mark W1-T269 and W1-T270 `status: withdrawn` (or equivalent) in their task files per this
  ruling, so the task index stops listing them as pending work — this record only rules the
  content of the decision, not the bookkeeping of the task queue, which is a separate mechanical
  edit.
- task: consider filing a smaller, non-gated task for a read-only *historical* per-account spend
  view (grouped by the ledger label W1-T268 would add, bounded by `ACCOUNT_ATTRIBUTION_EPOCH`) —
  W1-T270's own text notes this may still be wanted on its own merits even under a serial ruling,
  but it is a different, smaller product than the live multi-account panel W1-T270 was filed as.
- research: if the operator's stated ask for "multiple subscriptions working on rmd seamlessly"
  persists after this ruling, that is a request to revisit the published one-account-per-machine
  promise in `MASTER-PLAN.md` itself, not a request this task can grant by building around it —
  worth a direct conversation before any future task reopens concurrent multi-account.
