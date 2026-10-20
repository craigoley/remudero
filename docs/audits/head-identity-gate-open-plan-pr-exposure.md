# Open plan PR exposure to head-identity-gate (W1-T9376)

The October 20, 2026 snapshot contains one qualifying open PR, #13008. It is **not exposed** to the historical synthetic-merge checkout failure; its observed gate result is successful.

## Scope and collection

Collected at approximately 22:04–22:06 UTC on 2026-10-20 using the connected GitHub API, without changing any audited PR. These findings describe that snapshot, not future heads.

- Enumerated [open PRs, page 1](https://api.github.com/repos/craigoley/remudero/pulls?state=open&per_page=100&page=1): 13 entries. [Page 2](https://api.github.com/repos/craigoley/remudero/pulls?state=open&per_page=100&page=2) returned `[]`, establishing pagination completion.
- Applied the installed `isDispatchedRunBranch` predicate from `src/lib/sweep.ts`: `/^run-.+-\d+$/`. A mere `run-` prefix is insufficient. Both filed and unfiled run branches qualify for exclusion.
- Twelve entries matched that predicate: #13228, #13226, #13224, #13223, #13218, #13204, #13195, #13177, #13173, #13172, #13121 and #13039. The remaining entry was #13008. Filtering by branch before inspecting paths preserves every possible qualifying PR.
- Retrieved #13008's complete, paginated changed-filename list: its only path is `plan/tasks.d/W1-T10160-machine-filing-judge-monetary-producer-evidence.yaml`. Thus it is a plan-only filing, rather than a mixed implementation PR inferred from its title.
- Positive controls: the enumeration returned both run-shaped and non-run-shaped branches; the file-list lookup returned a real plan shard; the checks lookup returned 71 check runs, including the named gate on the exact audited head. The newest PR update in the enumeration was `2026-10-20T22:03:34Z`.

## Qualifying PR inventory

| PR | Branch name | head sha | Classification | Deciding evidence | remediation |
| --- | --- | --- | --- | --- | --- |
| [#13008](https://github.com/craigoley/remudero/pull/13008) | `codex/gardener-judge-price-filing-20261018` | `846276ed23e3c7873b092edad4a4a6c143e2fa3c` | **not exposed** | `head-identity-gate` completed with `success` on this exact SHA at `2026-10-20T04:25:24Z`; [observed job](https://github.com/craigoley/remudero/actions/runs/39369416204/job/118453650205). Its entire diff is the single plan shard above, admitted by the installed non-code-diff rule. | None required for this failure at this head; retain the PR and its current branch. |

Qualifying population: **1**. Exposed: **0**. Not exposed: **1**. This is a finding about the historical identity failure, not a claim that every required check on #13008 is green or that it is ready to merge.

## Why this head is admitted

The [head commit](https://api.github.com/repos/craigoley/remudero/commits/846276ed23e3c7873b092edad4a4a6c143e2fa3c) is an actual two-parent update merge with subject `Merge branch 'main' into codex/gardener-judge-price-filing-20261018`, without a task trailer. Its branch is outside the run shape. Neither fact alone establishes exposure under the installed gate:

- `readHeadCommitMessage` in `scripts/head-identity-gate.mjs` reads the newest non-merge commit along the first-parent history. It does not use the update merge's subject as the author identity or borrow a commit from main's history.
- `evaluateHeadIdentityGate` admits a readable, nonempty diff whose every path passes `isNonCodePath`. `NON_CODE_PATH_PATTERNS` in `src/run-task.ts` includes `/^plan\//`. Filing-shaped subjects also require that same non-code condition; a subject alone is insufficient.
- `changedPathsAtHead` uses the merge-base with the PR base branch and a no-renames path list. An absent, unreadable or empty diff does not earn this exemption.

The observed successful job is direct evidence for the audited head. The installed predicates explain why a plan shard can pass without a run-shaped ref or a head trailer; they are not a replacement for that observation.

## Historical fix and remediation decision

[PR #5365](https://github.com/craigoley/remudero/pull/5365) is **merged**, according to GitHub PR metadata: `merged: true`, `merged_at: 2026-09-13T11:48:34Z`, merge commit `b40eb2b68ab6430cf176af9cbbe4cd50ba46a78d`. It fixed checkout of GitHub's synthetic test-merge commit, which could hide a filing subject or task trailer from the gate. Its body records the motivating identical-head pass/fail on #5363; that historical account is distinct from this audit's live observation.

The task's phrase “while #5365 is unmerged” is historical context, not the current state. The checkout fix remains present both in this checkout at `c89ef695bad57f9c47c23a4f1255961e3832e344` and in the [live base workflow inspected at e741b8ce3594d3b83893c7e2972aaa8b732c3106](https://github.com/craigoley/remudero/blob/e741b8ce3594d3b83893c7e2972aaa8b732c3106/.github/workflows/head-identity-gate.yml):

```yaml
ref: ${{ github.event.pull_request.head.sha }}
fetch-depth: 0
```

There is no exposed PR requiring remediation in this snapshot. Waiting for #5365 to merge is obsolete, and rebasing or re-filing #13008 solely for this historical failure is unwarranted. Do not fan out branch updates after a base fix.

If a later head becomes exposed, first inspect the failed job's checked-out SHA and actual diff. For an old synthetic-merge failure, rerun against the fixed base workflow and verify that the job reads the real PR head. For a genuine unidentified implementation head, follow the installed gate's refusal: before PR creation, use a conforming session branch; for an already-open PR, add a new commit with the appropriate valid task trailer (or its own `PR-<n>` identity for ad-hoc work), without rewriting history. Do not invent a filed-task credit for a plan filing. A still-readable plan-only diff should pass the non-code route; diagnose any contrary result before changing its identity.

## Findings ledger

| Finding | Evidence | Disposition and reason |
| --- | --- | --- |
| W1-T9376/1 — complete qualifying inventory | 13 open PRs; terminal empty page; 12 run-shaped exclusions; complete file list for #13008 | One qualifying PR recorded with branch and full head sha. |
| W1-T9376/2 — no present exposure observed | Successful `head-identity-gate` job on `846276ed23e3c7873b092edad4a4a6c143e2fa3c`; installed non-code admission rule | #13008 is not exposed at the audited head; no identity repair justified. |
| W1-T9376/3 — historical dependency resolved | GitHub reports #5365 merged; pinned checkout remains in the inspected base workflow | No PR waits for #5365; preserve the current PR rather than refreshing its branch for this fix. |

This table is the durable findings ledger within the task's declared report artifact. The live runtime ledger was neither read nor modified: its location is outside this worker's permitted filesystem access. No claim is made about existing runtime-ledger entries.

## Acceptance and reproducibility

Before editing, the task record at checkout HEAD `c89ef695bad57f9c47c23a4f1255961e3832e344` (the dispatch-time `origin/main`) was fetched and matched the local record. It cites no `file:line` premises. All three acceptance greps failed because the requested report was absent; the task was not already satisfied. A merged-PR search for this task trailer also returned no candidates. The shared `origin/main` subsequently advanced to `e741b8ce3594d3b83893c7e2972aaa8b732c3106`; the workflow at that SHA was inspected separately above.

To repeat the audit, enumerate all pages of `GET /repos/craigoley/remudero/pulls?state=open&per_page=100`, apply the installed branch predicate, and retrieve every remaining PR's complete file list. Keep entries whose nonempty diff contains only `plan/` paths. For each entry, retain the PR number, branch and full head sha, inspect checks for that exact SHA, and read the installed workflow and predicates before deciding exposure. Reclassify if either the head or workflow changes; an API snapshot is not an atomic repository lock.

Acceptance proofs for this report:

```sh
grep -arn -- 'head sha' docs/audits/head-identity-gate-open-plan-pr-exposure.md
grep -arn -- 'exposed' docs/audits/head-identity-gate-open-plan-pr-exposure.md
grep -arn -- 'remediation' docs/audits/head-identity-gate-open-plan-pr-exposure.md
```

## Worker validation after the preflight retry

The reported typecheck failure did not reproduce: `npm run --silent typecheck`
exited 0 without diagnostics, and `./bin/rmd preflight --fast` independently
reported `typecheck: PASS`. The three acceptance greps above also passed.

The complete fast preflight exited 1 with 26 passing steps and two failing steps,
`rule-checks` and `no-shallowing-census`. Both failures arose from SWC's native
binding cache validation (`ERR_SWC_NATIVE_CACHE`), affecting
`test/every-test-finds-the-repo-root-through-one-helper.test.ts` and
`test/no-shallowing-of-the-canonical-checkout.test.ts`. The loader rejected a
cache ancestor as writable by another user without trusted sticky protection.
An explicit cache under an owned worker directory and the installed package's
documented temporary mode (`SWC_NATIVE_BINDING_CACHE=0`) both failed the same
validation. No source or baseline change is justified by those diagnostics.

That run measured checkout `c89ef695bad57f9c47c23a4f1255961e3832e344` against
base `210009b46b42f86cc71b6d41ab564b2054c86be9`, with a reported behind-count of
2. Its full diagnostics remain in the local `coverage/preflight-summary.json`;
this is a failed fast preflight, not a claim that the audit passed every gate.
