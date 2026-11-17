# Fleet GitHub identity

Recon for W1-T13224. The operator ruled on 2026-11-16 that `cao825` and `craigoley` are the owner and
that the automation should get its own bot identity. This page inventories where the fleet writes to
GitHub, says what could not be measured from this run, and proposes the move. It changes no credential,
token or config.

Labels: OBSERVED means read from source at this HEAD (file named). INFERRED means deduced from that
source plus the task record's own API observation. NOT MEASURED means this run had no way to read it.

## Write paths by host

How a login is chosen. `src/lib/github-credential.ts` resolves one credential per `gh` child, in
`GITHUB_CREDENTIAL_SOURCE_ORDER`: `repo-reference`, `remudero-reference`, `ambient-env`, `gh-login`
(OBSERVED). The first three can be the App installation token (`src/lib/github-app.ts` mints it and
writes `process.env.GH_TOKEN`). The last, `gh-login`, is whatever `gh auth login` stored on that host.
A process with no reference file and no ambient token behaves as before the resolver existed (OBSERVED,
module header). So the login is the App only where a source above `gh-login` answers.

| Write path | Code site (OBSERVED) | Azure host (daemon container) | Mac mini |
| --- | --- | --- | --- |
| issue comment | `src/run-task.ts` (`issues/<n>/comments` POST), `src/lib/main-health-rung.ts`, `src/lib/issue-revalidation-garden.ts` (dedup observation and still-true refresh comments, via the async issue gateway) | `remudero-fleet[bot]` — INFERRED: `GH_APP_*` env, entrypoint credential helper reads `GH_TOKEN` | `cao825` — INFERRED: no App env found in source for this host; falls to `gh-login`. NOT MEASURED |
| issue create or close | `src/lib/issue-revalidation-garden.ts` (`closeWithComment`), `src/lib/sweep.ts` (`gh issue edit`, `gh pr close`) | `remudero-fleet[bot]` — INFERRED | `cao825` — INFERRED |
| reaction | `src/lib/escalation-answers.ts` (`reactPlusOne`, `reactPlusOneOnIssue`: `-f content=+1`) | `remudero-fleet[bot]` — INFERRED | `cao825` — INFERRED |
| PR create | `src/run-task.ts` and `src/lib/worker.ts` (`gh pr create`) after the harness push | `remudero-fleet[bot]` — INFERRED | `cao825` — INFERRED |
| git push | `src/lib/git-push.ts`; plan lane at `src/run-task.ts` (W1-T11851: App identity via the git credential-helper socket in `src/lib/secret-boundary.ts`); commit author for recovery commits is fixed to `remudero-fleet[bot]` (`DIRTY_FIX_OWNER_RECOVERY_IDENTITY`) | App identity — OBSERVED for the plan lane, INFERRED elsewhere | the helper's login: `cao825` where no App source answers — INFERRED |

Commit authorship differs from push credential. Some commits use `-c user.name=remudero` /
`user.email=remudero@users.noreply.github.com` (`src/run-task.ts`), and trial merges use
`trial-merge@remudero.invalid` (OBSERVED). Those names are cosmetic; GitHub attributes the push and the
API write to the credential's login.

Not established. The Mac mini and Azure `gh auth status`, `git config` and service-token contents sit
behind paths this run's sandbox denies (`~/.config/gh`, `state/service-tokens.json`). Every host cell
above marked INFERRED therefore needs one `gh auth status` per host to become OBSERVED.

## Attribution census

Stated window: the 7 days ending 2026-11-16 (2026-11-09 to 2026-11-16).
UTC bounds: `2026-11-09T00:00:00Z` inclusive to `2026-11-16T00:00:00Z` exclusive.

Comment result: 522 `cao825` issue comments in the stated window, from the GitHub REST
`issues/comments` collection filtered to `user.login == "cao825"` and the inclusive start/exclusive
end timestamps above. Of these, 33 carry the dated-refresh marker from
`src/lib/issue-revalidation-garden.ts`, 368 carry the fixed duplicate-observation marker from
`src/lib/escalate.ts`, and 10 carry the lifecycle reconciler marker from `src/lib/sweep.ts`. These 411
comments are fleet automation by construction (OBSERVED: the writers and their fixed markers). The
remaining 111 comments are person/session-authored text without those generated markers. The API
read is a positive control for the comment corpus: it returned 522 matching rows over the interval.

Reaction result for the GRILL-answer corpus: 8 automation, 0 person/session. The Mac runtime ledger
has 9 `panel.question_answered` rows in the window on #18451, #18489, #18496 and #18519. The GitHub
reaction connections for those four issues contain 8 `+1` reactions by `cao825`, each matching a
ledger comment id and timestamp; the ninth accepted answer (#18489 comment 6878486020) has no
reaction. The 9 open GRILL escalations listed below have no `cao825` issue or comment reactions in
the window. The 8 observed reactions therefore come from the Mac answer automation, not a person or
session. The local ledger's current rows extend through 2026-11-16T23:22:20Z, covering the window end.

Fleet-PR commit result: 104 unique `cao825` commits, 6 automation, 98 person/session. The census
searched fleet-authored PRs updated 2026-11-09 through 2026-11-17, then filtered commit timestamps to
the stated window and deduplicated by commit SHA. It returned 465 PRs. The three PRs with more than
20 commits (#18305, #18033, #17804) were read through their full 65, 23 and 21 commits. The 104
commit SHAs were joined against the Mac ledger's `pushed_head_sha` rows (9 rows, 8 unique SHAs);
6 matched a fleet PR commit and are automation. The other 98 had no matching automated push row and
are person/session commits. The 6 automation matches are the evidence a GitHub login alone cannot
provide.

The task record's earlier OBSERVED figures of 105 dedup observation comments and 13 refreshes cover
2026-11-01 onward (16 days), not this seven-day window.

How to tell them apart, for whoever runs the census:

1. Automation comments carry fixed source markers: the dated garden refresh, duplicate escalation
   observation, and lifecycle reconciler text. The other comments are person/session text. Count by
   marker, not by login.
2. `escalation-answers.ts` posts only `+1`. Match the reaction's comment id and timestamp to the
   `panel.question_answered` ledger row and count only a reaction returned by GitHub. A ledger row
   without a returned reaction is not a posted reaction.
3. Fleet-PR commits: `interventionsFromPullRequest` (`src/lib/fix-lane-gardener.ts`) treats any
   non-`remudero-fleet` login as a hand push through `isFleetActor` (`/remudero-fleet/i`). Join the
   commit SHA to `pushed_head_sha` rows to distinguish a Mac daemon push from a person/session push.
   Six matches in this window are the concrete misclassified automation commits. The nine open GRILL
   escalations (#17393, #17615, #17682, #17769, #17860, #17896, #17995, #18062, #18140) ask about
   this attribution defect.

The comment query was `gh api --paginate repos/craigoley/remudero/issues/comments?since=2026-11-09T00:00:00Z`
filtered to `user.login == "cao825"` and the stated end timestamp. Reactions were read from GitHub
GraphQL issue/comment reaction connections and joined to the Mac ledger. Commits were read from
GitHub GraphQL's paginated search for `author:remudero-fleet[bot]` PRs and joined to the Mac ledger's
`pushed_head_sha` rows.

## Proposed identity split

Goal: every automated write is `remudero-fleet[bot]`; `cao825` is only a person.

Ordered steps. Each is a separate change; none is done by this document.

1. Measure first (no approval needed): run the census above and `gh auth status` on both hosts, so the
   INFERRED cells become OBSERVED. Owner: any session with API access.
2. Mac mini: add a `github-credential-references.json` entry, `kind: "app"`, scope `*`, naming the
   `remudero-fleet` App id, installation id and private-key path, so source `remudero-reference` answers
   before `gh-login`. This is a credential and config change on the host. Approver: the operator.
3. Mac mini: install the App private key at that path with owner-only permissions. Approver: the
   operator. Console hard rules forbid anyone else making it.
4. Git push on the Mac mini: point the checkout's credential helper at the App-minting socket, as the
   plan lane already does (W1-T11851). Config change; approver: the operator.
5. Remove the ambient `cao825` fallback only after steps 2 to 4 show App-authored rows for a full
   window: `gh auth logout` for the stored login on the daemon host, or leave it and rely on the order.
   Approver: the operator. Reversible by `gh auth login`.
6. Code follow-up: have `interventionsFromPullRequest` classify by the ledger's run join rather than
   login alone, or keep login-based classification once step 5 makes it accurate. A separate task.
7. Verify: repeat the census for a new 7-day window; expect zero automation-marked comments by `cao825`.

What no step does: rotate or print a token, edit the `remudero-fleet` App's permissions, or change
`deploy/` files. The App's permission set (issues write, pull requests write, contents write) is
assumed already sufficient because the Azure host performs these writes today; confirm in step 1.
