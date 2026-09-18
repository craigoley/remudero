# Model routing and cost evidence

## Decision

Codex balanced work now prefers `gpt-5.6-luna`, then `gpt-5.6-terra`. Frontier work still
prefers Sol. The cash provider keeps its own ordered deployments because that ordering is based on
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
