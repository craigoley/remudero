# Model routing and cost evidence

## Decision

**2026-10-02 Sol 6.1 switch.** `gpt-6.1-sol` now leads every subscription balanced and frontier
Sol seat. `gpt-6-sol` and `gpt-5.6-sol` trail for account availability and supported effort fallback.
Claude keeps frontier preference; economy keeps Luna/Spark. No effort or subscription share changes.
The old concrete-model experiments remain readable. New high-effort epochs `sol61-vs-sonnet55`
and `sol61-vs-sonnet5` start on October 2 and are reviewed daily from that day. The minimum remains
20 tasks per arm; daily observations are provisional, and reaching the minimum is not a winner.
The daily fleet refresh at 04:17 UTC writes private dated JSON/text reviews and `latest.json` under
`state/field-trials/routing-daily/`, before its GitHub collection. Each repository is reported
separately with sample growth, missing receipts, crossovers and ledger quality. Remote collection
failure cannot prevent this local review. A readable but incomplete ledger permits a provisional
report; it cannot establish a comparison. Review matched task/risk/lane/stack cohorts before
changing routing, and retain the existing Field Trials verified-outcome and release boundaries.
Retries keep their task assignment; a fallback to Sol 6 belongs to its original epoch. Assignment,
served model, terminal receipt, non-starter, crossover, risk/class/lane and pinned stack remain
separate evidence. Before/after adoption is observational; it does not establish a causal winner.

Azure Foundry offers `gpt-6.1-sol`, version `2026-09-29`, in our East US 2 account (GlobalStandard).
Cash balanced rows retain nano/OSS/Luna ahead of Sol 6.1; economy does not offer Sol. A squeezed
Sonnet 5.5 deployment returning 404 can walk once to a ready, context-fitting Sol 6.1. Frontier
cash remains the existing bounded Opus emergency. All paid Sol turns reserve against the same
fleet allowance and $25/day operator cap, including retries; no cap is raised by this change.

[Sol 6.1](https://developers.openai.com/api/docs/models/gpt-6.1-sol) uses Responses for tools and
supports low/medium/high/xhigh/max API reasoning. The adapter preserves encrypted reasoning and
function-call items, executes the same bounded tools, and reports failed or incomplete responses.
A failed local tool ends the Sol chain. Missing usage or the Responses `cache_write_tokens`
counter leaves the conservative reservation charged ([cache accounting](https://developers.openai.com/api/docs/guides/prompt-caching));
an unknown transport outcome does too, while a definite 404 settles to zero. Actual served identity
comes from the response, never from the deployment name. Per-turn cache reads/writes, output,
duration, cost estimate and assignment identity feed the existing worker-attempt/Field Trials path.

[Azure's published Global Standard rates](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/provisioned-throughput-sizing)
are $2 input, $0.10 cached input, $2.50 cache write and $10 output per million. Above 272K input,
the entire request uses $4/$0.20/$5/$15. Reservations use the higher cache-write input rate and
8K output ceiling; settlement uses each turn's receipt, rather than pricing the summed conversation
as one long request. The Azure input bound is 922K, with room for output. Provisioning, source
merge, runtime boot and first selected/served timestamps are separate switch evidence. Retain the
private deployment/probe receipt and refresh `rmd field-trials` after runtime activation.

**2026-09-24 balanced-lane guard.** Codex `balanced.low`, `.medium`, and `.high` now offer
`gpt-6-sol`, then `gpt-5.6-sol`. They do not offer Luna or the retiring `gpt-5.5`. A Sonnet mount
can execute a multi-turn worker chain at any effort, and its high-effort Sol fallback previously
dropped to Luna if Sol was unavailable. The high-effort GPT-6 Sol-versus-Sonnet A/B remains tagged
only when GPT-6 Sol serves the Codex arm, and is scheduled for review on 2026-10-08. The older Sol
fallback and lower-effort balanced work remain in the headroom auction without that A/B tag.
Codex economy rows retain Luna for lower-risk work, and frontier work still prefers Claude Opus 5.5.
Some economy mounts still run multi-turn docs, plan, review, or manual workers; their deterministic
checks and human review remain necessary. This policy does not claim that every Luna call is a
single-call classification, or that an unvalidated Luna worker chain is reliable.
The separate cash ladder still includes Luna on balanced rows and can promote it when both
subscriptions are blocked. That path is governed by the existing cash cap and tool eligibility;
this Codex subscription change does not establish an end-to-end ban on balanced Luna spawns.

This change is a safety boundary, not a measured claim that one model fails at a specific rate on
Remudero tasks. The motivating external test reported four malformed or incorrect Luna outputs in
50 structured calls and one missed failure in a six-step chain. Four of 50 is 8%, not the 4%
retry rate claimed in the test summary. Those small, harness-specific samples should prompt a
fleet comparison, not a claimed production error rate. Remudero has no DeepSeek V4 Flash route to
replace, and its heartbeat is a script rather than a model call.
The [Anthropic Terminal-Bench table](https://www.anthropic.com/claude-opus-5-5) compares Opus 5.5
with GPT-5.6 Sol, not GPT-6 Sol; it cannot by itself establish the quoted 23-point gap for the
model this router serves.
OpenAI describes [Luna](https://developers.openai.com/api/docs/models/gpt-6-luna) as intended for
focused, high-volume tasks and [Sol](https://developers.openai.com/api/docs/models/gpt-6-sol) as
built for complex coding and agentic workflows. The provider's [Structured Outputs guidance](https://developers.openai.com/api/docs/guides/structured-outputs)
also favors strict schemas and validation over trusting prompt-only JSON formatting. The Codex CLI
worker route uses model-selected tool calls rather than an API JSON-schema response, so a parser
retry alone cannot prove a multi-step task completed correctly.

**2026-09-22 model change.** Opus 5.5 replaced Opus 5, GPT-6 Luna replaced GPT-5.6 Luna in
economy rows, and Terra was phased out:

- Frontier work (`opus`, `claude-opus-5-5`) **prefers Claude**: it runs on Opus 5.5 whenever the
  Claude subscription has headroom, and reaches Codex `gpt-6-sol` only when Claude is below
  reserve or unreadable (`capabilities.provider_preference` in `.remudero/mounts.yaml`). Before
  this, the auction split frontier work by headroom alone, and 84 of 127 Opus-requested runs went
  to `gpt-5.6-sol`.
- Codex economy work leads with `gpt-6-luna` when Spark is unavailable; `gpt-5.6-luna` trails as
  a fallback. Terra is in no Codex row. The original balanced Luna policy was superseded above.
- Every assignment an automatic auction decided under that preference records
  `routing.capabilityPreference`; a Sol fallback also records `routing.preferenceBypass`.
- The cash (Azure) ladder is unchanged: GPT-6 models reach the Codex subscription before Azure.
- `gpt-6-astra` is visible on the account (and is its default) but is not routed.

The earlier decision follows. Codex balanced work preferred `gpt-5.6-luna`, then `gpt-5.6-terra`.
Frontier work still preferred Sol. The cash provider keeps its own ordered deployments because that ordering is based on
measured task shapes, context limits, and per-request receipts rather than subscription capacity.

The earlier Luna-first balanced policy was a subscription-capacity experiment. Its task mix and
terminal receipts remain useful when comparing the new balanced ladder. Neither a subscription
assignment nor an API list price is an invoice for this fleet.

## What is measured

Every worker assignment already writes an immutable `worker.assignment` ledger event before the
call begins. The terminal `verdict` row now carries the same `selection_assignment_id`, configured
and served-model fields, token envelope, call duration, worker-level `success`, cost, and any
capability fallback. A task verdict (for example `blocked_ci`) is deliberately not treated as a
model-call failure.

`GET /v1/analytics` now publishes a bounded `routingTelemetry` (`routing-v1`) aggregate. It joins
those two records by assignment ID and reports only:

- provider, assigned model, task type, and routing rule;
- assignment and terminal-result counts, success/failure counts, token, duration, and modeled call
  cost totals;
- controlled fallback categories; and
- the last 30 UTC daily token-per-terminal-result inputs.

An assignment with no terminal receipt remains incomplete. A terminal receipt that has no matching
assignment remains separately counted. Neither case becomes a fabricated success, provider receipt,
or zero-cost call.

### Benchmark evidence quality (internal)

`GET /v1/analytics?projectionVersion=benchmark-quality-v1` serves a separate, read-scoped quality
projection from the existing process-owned analytics snapshot. It does not scan the ledger on GET,
alter `routing-v1`, or add bytes to the full analytics response. The first refresh after upgrading
an older checkpoint replays the existing archive/live union once to establish complete coverage;
subsequent refreshes resume the same cursor. A missing or unreadable source is `unavailable`, not an
empty healthy cohort. Intermediate `implement.done` rows are never terminal worker outcomes.
Malformed or non-object archive rows likewise make benchmark quality `ledger-source-malformed`;
the local audit records source path, form, first/last line ordinal and count without retaining
the bad payload. The benchmark response exposes only counts by source form, never paths. Its
checkpoint retains the finding across cursor resumes and rechecks a changed archive. An incomplete
live final line is a distinct `ledger-live-torn-tail`: the cursor resumes at that line's starting
byte so a later completed write can recover. An existing live path that cannot be read is
`ledger-live-unreadable`, even when an archive still yields valid rows; repair triggers recheck.
The dispatch-history audit keeps its prior
best-effort posture; source-quality uncertainty does not stop a worker, review, or PR.
Each dispatch worker now emits a distinct `worker.attempt` receipt at the shared spawn boundary;
the projection prefers it over a run `verdict` for the same assignment. Older verdict-only rows
remain labeled legacy evidence. A call that returned successfully is not a verified task fix.

The assignment-based coverage denominators name missing task class, risk, requested/selected/served
model, provider, effort, outcome, tokens, duration, billing mode, and cost separately. No terminal
receipt is distinct from a terminal whose provider did not report a field. Unmatched terminal rows
and duplicate assignment/terminal IDs are separate counts. The projection carries scan time and
the latest retained source timestamp, but no run, task, repo, account, prompt, or source identifier.
The OpenAPI contract is internal and the public Field Trials page does not fetch this endpoint.

`total_cost_usd` comes from the worker-result envelope, not an invoice. The quality projection sums
API-mode request estimates and subscription-mode notional amounts in different fields, only when
both billing mode and a finite nonnegative cost are present. A missing cost never becomes a measured
zero, and a subscription call with zero notional dollars is still a call consuming capacity. A
configured model differing from the provider-served model is counted as routing evidence; it is
**not** called an experimental crossover because no random-allocation receipt exists yet. This
projection cannot support a public causal model ranking on its own.

The private `benchmark-run-v1` envelope rides the existing `worker.assignment`, per-call
`worker.attempt`, and run `verdict` rows; it is not an extra worker call or a public endpoint. It freezes the
assignment-time task class, risk, requested and selected stack. The executing harness commit is
attested from the module actually loaded by the worker process, only when that module is tracked
and the tracked source, launcher, and package inputs are clean at load time; an operator checkout, origin/main HEAD, or
image build stamp from a different mounted source is not substituted. Prompt, tool, scorer, and
environment revisions remain unavailable until an immutable resolved artifact or explicit trial
manifest pins them. Invalid or conflicting pins stay unavailable with a bounded reason.
Comparability names mismatched and missing stack fields separately; only two completely observed,
matching working stacks classify comparable. This is an identity check, not a model-effect estimate.
Rights are private without a local consent receipt, and allocation is observational without a
randomization receipt. An attempt envelope names worker-call outcome and per-field missingness;
observed zero tokens, duration, or cost differ from absent measurements. API request estimates
and subscription notional cost occupy separate fields. Intermediate worker rows and verdicts
without a matching assignment cannot become joined benchmark outcomes. This metadata is a
producer contract for the later cohort gardener, not a model score or publication authorization.
The run verdict stays a separate end-to-end phase; a thrown spawn emits a failed call with unknown
usage, and a failed telemetry write cannot affect the worker or PR path. A daemon cycle without a
model call contributes source freshness and coverage, never a synthetic model trial.

### Non-dispatch worker coverage

Dispatch is not the whole model population. Inbox drafting, cash fallback rungs, reviews and fixes,
triage, standalone judges, specialists, and auxiliary sweeps may call a worker outside the main
task dispatcher. The non-dispatch boundary now writes a private assignment and `worker.attempt`
for each such call, preserving the enclosing run/lane where available. A cash ladder model that
fails because its deployment is absent or rejects the required response format gets its own
failed attempt before the successor gets a new assignment. The final rung is recorded once, from
the returned worker result. These are model-call observations, not independent verified task wins.

An assignment write failure leaves the attempt's join unavailable and logs coverage debt; it does
not suppress the caller's existing assignment callback or change the worker route. A missing
result has unknown tokens, duration, and cost rather than fabricated zeros. The source caller
census warns locally about an unclassified entrypoint and proposes follow-up work, without
becoming a PR gate. The cohort gardener must still reconcile the actual three-instance runtime
population, GitHub outcomes, and consent before any aggregate is eligible for publication.
The enclosing run/assignment IDs remain local ledger join keys, never metric labels. If a later
OpenTelemetry export uses bounded dimensions, its overflow bucket must be reported as lost
dimension coverage, not a trustworthy provider/model slice: the SDK retains the total but strips
the overflowing measurement's original attributes ([OpenTelemetry cardinality guidance](https://opentelemetry.io/blog/2026/cardinality-limits-in-opentelemetry/)).

### Local cohort gardener (internal)

Each daemon instance now runs a detached, best-effort cohort pass over its own ledger state. It
audits gzip/plain rotations and the live tail in bounded, resumable source batches, checkpoints
source hashes and a local `benchmark-cohort-v1` snapshot atomically, and re-audits edited sources
or a changed live prefix. Supervised idle instances also run one model-free, four-source pass
within each existing five-minute pulse, with a two-minute process timeout and no added PR-probe
delay; failure is a logged maintenance result, not a reason to block review. A live scan records
only a newline-terminated byte prefix, rehashes that exact prefix after reading, and records
pending tail bytes for the next pass. Concurrent append or an unfinished final line no longer
suppresses a complete snapshot for the audited prefix. A retired, truncated, or rewritten source
must reconcile its exact evidence lines in a successor before the snapshot can be observed; an
unproven in-place model-label change is not silently accepted. Exact replay lines are deduplicated;
late attempts, terminal
fallback, corrections, and retractions rebuild affected dimension partitions. A missing or
malformed source with no bounded clean suffix, unreadable archive, or incomplete scan yields
`unavailable` with last-good age rather than a fresh zero. A damaged checkpoint triggers full replay and stays
unavailable until that replay completes. None of these conditions gates a worker or PR.
An unchanged faulty source is recorded locally by source hash, count of malformed rows, and
bounded timestamp range only when **every** nonempty row has a canonical timestamp (including
damaged rows). The raw archive is never rewritten by this projection. Later sources continue to be
audited. The fault's file mtime is included in the cutoff so a later cohort cannot predate the
archive's last write. A strictly later UTC-day assignment with a newly minted UUIDv4, and no joined receipt
that crosses the fault's timestamp bound, can enter an explicitly `observed-partial` clean cohort;
older, legacy-ID, or unbounded joins remain excluded with visible missingness. This uses the
assignment producer's fresh-random-ID causal contract, not archive filenames as a time guarantee.
If any malformed line lacks that timestamp, no clean model denominator is asserted. The complete
cohort remains unavailable until every source is healthy or a retired source's evidence is
reconciled. A partial clean cohort is not a public ranking or experiment effect.

Dimensions are UTC day, task class, selected provider/model, and observed or explicitly unavailable
harness revision. Assignment-based denominators distinguish no worker call from a call with missing
served-model, billing, or cost evidence. A per-call attempt wins over a final verdict as worker
call evidence; neither proves task correctness. Estimated API dollars and subscription notional
amounts remain separate. The pressure report measures source and checkpoint bytes, relevant
evidence bytes by UTC day, observed events per run, dimension count, and rebuilt partitions;
it does not delete raw rows or impose a fixed storage cutoff. Run and assignment IDs stay in the
private local checkpoint as join keys, never graph labels. There is no uploader, public cohort
endpoint or randomized-effect estimate. A read-only, optional verified-outcome overlay can now
join a fresh `task-case-file-v1` snapshot to the cohort's private task/run/assignment keys. It
credits completion only when that run names the same PR and the current head has successful
review, acceptance and CI evidence plus merged task credit. Open PRs are censored at the cutoff;
closed unmerged PRs, old or unreadable case files, and assignments predating the join keys are
counted as unavailable. The overlay reports per-class/selected-model completion, observed repair
runs, merge latency, and API versus subscription-notional cost coverage. No case-file snapshot
means the original explicit `unavailable-no-github-verification-join` state; an empty or missing
snapshot never becomes a zero-failure claim. Cached ledger projections refresh this overlay
without replaying the ledger, while the daemon's ordinary pass continues without GitHub polling.
An analyst can pass a fresh JSON array of `rmd case-file <task-id> --json` results to the internal
`node --import tsx src/lib/benchmark-cohort.ts <state-dir> --case-files <snapshot.json>` entrypoint;
it prints only aggregate outcome groups and refuses unreadable or malformed input.
Neither this observational join nor worker-call success promotes a model. The public
Field Trials route remains feature-flagged to 404 until consent, quality, and review are ready.

## Baseline and savings

On 2026-09-18, a read-only, rotation-safe production-ledger census found 326 retained
`worker.assignment` records from 2026-09-11 through 2026-09-17: 208 Claude selections (63.8%)
and 118 Codex selections (36.2%). The Codex selections were 80 GPT-5.5 (67.8%), 28 Terra (23.7%),
9 Luna (7.6%), and 1 Spark (0.8%); no selected `cash` provider was observed. This is a routing
decision mix, not an invoice or a spend total.

Only 140 assignments joined to a retained task type: 138 `implement` and 2 `diagnose`. No
commodity task type was observed in that join, and Haiku was not selected in the 326 assignments.
The other 186 assignments have no matching retained `run.start` type. That falsifies an immediate
claim that moving routine lint, schema, or documentation work from Sonnet would save a measured
amount here; there is no such observed population in this retention window. The dashboard makes
that future decision auditable rather than treating the absence as zero usage.

The same census found 229 terminal `verdict` rows but none with a
`selection_assignment_id`, so it cannot produce a historical assignment-to-outcome quality, token,
latency, or cost baseline. This change starts that joined series. The current subscription has no
per-request invoice inside the ledger, so it is not valid to convert a model preference into dollars
per month. Cash rows do carry provider-reported or modeled request cost, while subscription rows
express capacity use, terminal quality, token use, and latency.

The first 30 days after deployment are the comparison window. Compare like-for-like task type,
risk, routing rule, and provider before promoting or rolling back a model. A raw across-model total
is not a quality or cost measurement because the task populations can differ.

The [current OpenAI list prices](https://developers.openai.com/api/docs/models/gpt-6.1-sol) put Sol 6.1
at $2 input, $0.10 cached input, and $10 output per million tokens; the corresponding
[Luna prices](https://developers.openai.com/api/docs/models/gpt-6-luna) are $0.10, $0.01, and
$0.50. Both apply higher rates above 272K input tokens. Anthropic lists Opus 5.5 at $4 input,
$0.20 cache reads, and $20 output per million tokens in its
[launch announcement](https://www.anthropic.com/claude-opus-5-5). These are API list prices,
while the Codex and Claude routing auction here spends subscriptions. The quoted $4–10 monthly
personal-agent estimate does not establish Remudero savings.

## Paid pilot accounting

The narrow `cash-simple` paid trial is a separate, task-stable allocation for low-risk, single-file
docs or plan-lint implementation. Its pilot-only daily spend is the sum of distinct API-billed
cash worker-call `total_cost_usd` receipts joined to trial assignment IDs, attributed to the
call's UTC day. The final task verdict's `cost_usd` can include other subscription and repair
work and is not the cash-arm budget. These receipts are worker/provider estimates, not invoices;
subscription notional amounts remain separate. An unreadable ledger source, conflicting call
receipt, or missing cost evidence temporarily holds only the paid arm with a reason. Control and
ordinary subscription work continue, and no benchmark check holds a PR. The existing overall
daily cash cap is still an independent backstop. Trial PR-open rate is an operational diagnostic,
not verified completion or a public causal model ranking.

For a three-daemon host, that backstop is a **fleet** cap only after all cash instances use
the migrated `workerProviders.fleetCashAllowancePath`. Each instance otherwise maintains a
local allowance. The shared path serializes reservation and settlement across processes and
refuses missing or unreadable state. The read-only `--report` mode of
`deploy/migrate-fleet-cash-allowance.sh` shows the combined UTC-day commitment and source mtime;
it does not report an invoice or grant permission to raise the $25 ceiling.

## Rollback

The policy switch is the candidate membership and order of `capabilities.codex.balanced` in
`.remudero/mounts.yaml`. Review joined terminal receipts by comparable task type, risk, routing
rule, and provider. Revert through the normal reviewed PR path if the routing aggregate shows a
material quality, terminal-success, capacity, or latency regression. Do not restart or recycle a
daemon merely to change a mount policy; deployment remains governed by the established graceful
lifecycle scripts.
