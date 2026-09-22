# Model routing and cost evidence

## Decision

**2026-09-22 model change.** Opus 5.5 replaces Opus 5, GPT-6 Luna replaces GPT-5.6 Luna, and Terra
is phased out:

- Frontier work (`opus`, `claude-opus-5-5`) **prefers Claude**: it runs on Opus 5.5 whenever the
  Claude subscription has headroom, and reaches Codex `gpt-6-sol` only when Claude is below
  reserve or unreadable (`capabilities.provider_preference` in `.remudero/mounts.yaml`). Before
  this, the auction split frontier work by headroom alone, and 84 of 127 Opus-requested runs went
  to `gpt-5.6-sol`.
- Codex economy and balanced work leads with `gpt-6-luna`; `gpt-5.6-luna` trails as a fallback.
  Terra is in no Codex row, and Sol is deliberately not added to the balanced rows.
- Every assignment an automatic auction decided under that preference records
  `routing.capabilityPreference`; a Sol fallback also records `routing.preferenceBypass`.
- The cash (Azure) ladder is unchanged: GPT-6 models reach the Codex subscription before Azure.
- `gpt-6-astra` is visible on the account (and is its default) but is not routed.

The earlier decision follows. Codex balanced work preferred `gpt-5.6-luna`, then `gpt-5.6-terra`.
Frontier work still preferred Sol. The cash provider keeps its own ordered deployments because that ordering is based on
measured task shapes, context limits, and per-request receipts rather than subscription capacity.

This is a policy experiment, not a claim that Luna is universally the strongest reasoning model.
Luna is preferred where the current subscription policy asks for balanced capability. Terra remains
the immediate fallback. A frontier task is not silently lowered to Luna.

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

Official OpenAI model documentation describes GPT-5.6 Luna as cost-sensitive and high-volume. That
supports testing it in balanced lanes; it does not justify moving frontier work without outcome
evidence. Source checked 2026-09-18: <https://developers.openai.com/api/docs/models/gpt-5.6-luna>.

## Rollback

The policy switch is the order of `capabilities.codex.balanced` in `.remudero/mounts.yaml`.
Revert that order through the normal reviewed PR path if the routing aggregate shows a material
quality, terminal-success, capacity, or latency regression for comparable work. Do not restart or
recycle a daemon merely to change a mount policy; deployment remains governed by the established
graceful lifecycle scripts.
