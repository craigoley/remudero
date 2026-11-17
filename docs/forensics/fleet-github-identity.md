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

Result: NOT MEASURED. The run had no GitHub API access, so the three counts (`cao825` comments,
reactions, fleet-PR commits, each split automation versus person or session) are not stated here and
none is invented. The only figures available are the task record's own OBSERVED API reading of
2026-11-16: at least 105 dedup observation comments and 13 revalidation refreshes authored by `cao825`
since 2026-11-01 (a 16-day window, not the 7-day one). Both comment kinds are written by
`src/lib/issue-revalidation-garden.ts`, so they are automation by construction (OBSERVED: the writer).

How to tell them apart, for whoever runs the census:

1. Automation comments carry the garden's fixed marker text and dated-refresh shape
   (`issue-revalidation-garden.ts`); a person's comment does not. Count by marker, not by login.
2. Reactions: `escalation-answers.ts` posts only `+1`. A `+1` by `cao825` on a GRILL issue is
   ambiguous by login alone; match its `created_at` against the ledger's `reactPlusOne` step rows.
3. Fleet-PR commits: `interventionsFromPullRequest` (`src/lib/fix-lane-gardener.ts`) treats any
   non-`remudero-fleet` login as a hand push through `isFleetActor` (`/remudero-fleet/i`). A commit by
   `cao825` that is really the Mac mini's daemon is counted as an intervention. That is the defect the
   nine open GRILL escalations (#17393, #17615, #17682, #17769, #17860, #17896, #17995, #18062, #18140)
   ask about. Tell them apart by joining the commit SHA to the ledger's push rows for the same run id.

Query to run (needs a token): `gh api --paginate repos/craigoley/remudero/issues/comments?since=2026-11-09T00:00:00Z`
filtered to `user.login == "cao825"`, then partition by the three rules above. Report each partition's count.

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
