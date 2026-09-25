# Model routing and cost evidence

## Decision

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

The [current OpenAI list prices](https://developers.openai.com/api/docs/models/gpt-6-sol) put Sol
at $2 input, $0.20 cached input, and $10 output per million tokens; the corresponding
[Luna prices](https://developers.openai.com/api/docs/models/gpt-6-luna) are $0.10, $0.01, and
$0.50. Both apply higher rates above 272K input tokens. Anthropic lists Opus 5.5 at $4 input,
$0.20 cache reads, and $20 output per million tokens in its
[launch announcement](https://www.anthropic.com/claude-opus-5-5). These are API list prices,
while the Codex and Claude routing auction here spends subscriptions. The quoted $4–10 monthly
personal-agent estimate does not establish Remudero savings.

## Rollback

The policy switch is the candidate membership and order of `capabilities.codex.balanced` in
`.remudero/mounts.yaml`. Review joined terminal receipts by comparable task type, risk, routing
rule, and provider. Revert through the normal reviewed PR path if the routing aggregate shows a
material quality, terminal-success, capacity, or latency regression. Do not restart or recycle a
daemon merely to change a mount policy; deployment remains governed by the established graceful
lifecycle scripts.
