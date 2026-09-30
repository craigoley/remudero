# Console views: `GET /v1/views/<name>`

A view is **one read per console surface, computed in core**. The console renders it; it does not
assemble it from raw routes. The first view is `nav-badge` (arch plan Phase 0, item 0.4). Phase 1
moves every view onto the projector's `node:sqlite` read model and pushes `view → version` over one
SSE stream; the wire shape below is the contract those phases keep.

## Body

```json
{
  "view": "nav-badge",
  "version": 1,
  "generatedAt": "2026-09-30T12:00:00.000Z",
  "asOf": "2026-09-30T11:59:00.000Z",
  "stale": false,
  "sources": [{ "name": "analytics", "asOf": "2026-09-30T11:59:00.000Z", "state": "fresh" }],
  "data": { }
}
```

| field | meaning |
|---|---|
| `version` | the schema version of `data`. An added optional field keeps it. Anything a consumer could misread bumps it, and a consumer checks it before trusting `data`. |
| `generatedAt` | when this body was computed. |
| `asOf` | the **oldest** input's as-of time: how old the facts are, which is not the same as how old the response is. |
| `stale` | any source is `stale` or `unavailable`; `sources[].reason` says why. |
| `ETag` | weak, `W/"<view>.<version>.<hash of {version, stale, data}>"`. It ignores the times, so an unchanged view answers a matching `If-None-Match` with **304** and no body, even after a recompute. `Cache-Control: no-cache`. |

An input that is cold makes its value **absent with a reason**, never a zero. A view's query
parameters narrow it; an unusable one answers 400 `invalid_request` with a `detail`.

## Served from the read model (Phase 1)

A view the read-model worker materializes (`src/lib/read-model-worker.ts`, its `READ_MODEL_VIEWS`) is
served from serve's in-memory body map (`buildReadModelViewRoutes`, `src/lib/views.ts`). A request
reads no file and no SQLite.

- **Warm boot.** Serve loads the last committed bodies from core's read model at start, so a restart
  answers at once. Until an instance's projector ticks, its `ledger:<instance>` source reads `stale`
  with the reason `read model warming`.
- **Per-source freshness.** Every read-model body lists a `ledger:<instance>` source per instance it
  read. Its state is re-judged on each request against the worker's latest tick. It goes stale when that
  projector is more than 10 s behind, has failed, or another serve holds its lease, and the `reason`
  says which. A re-judged `stale` changes the ETag.
- **Keys.** The query string, sorted by parameter name, selects the body (`?instance=console`); an
  unkeyed view has the empty key.
- **Kill switch.** `state/read-model/switches.json` holds `{"projector": "on"|"off", "views": {"<name>":
  "serve"|"shadow"|"off"}}`, and serve re-reads it every 5 s off the request path. A view set to `off`
  answers from its Phase 0 computation where one exists (nav-badge), otherwise **404 `view_disabled`**.
  A view with no body yet answers from that computation, or **404 `view_not_ready`**.

## `read-model` (version 1)

`data.instances[]`: `{ instance, generation, lease: held|elsewhere|none, heldBy?, quarantined, reason? }`.
It is the read model's own status: the committed projector transactions per instance DB, who holds the
writer lease, and how many future-dated rows were quarantined.

## `repositories` (version 1)

`GET /v1/views/repositories` returns `data.instances[]`, one entry per configured daemon instance.
Each entry names its `instanceId` and carries that instance's `RepoDashboardResult` as `summary` when
available; otherwise it carries a `reason`. The summary keeps the existing repository-card contract,
including explicit null/unmeasured telemetry and `not_computed` fields. `data.reason` explains a
portfolio-wide unavailable input. Per-instance `repositories:<instance>` sources report summary
freshness, and `ledger:<instance>` sources report projector freshness.

## Rules for a new view

1. Name it after the surface (`nav-badge`, `now`, `repositories`), not after its inputs.
2. `compute` runs on the request. It must be synchronous and cheap, over in-memory caches or one small
   file, and it must never read the ledger union or call `gh`.
3. Declare it in `openapi/daemon.yaml` under `/v1/views/<name>`, with its `data` schema.
4. Register it in `src/lib/serve.ts` through `buildReadModelViewRoutes` (`src/lib/views.ts`): a Phase 0
   computation in `legacy`, or a read-model materializer in `READ_MODEL_VIEWS`.

## `nav-badge` (version 1)

`data.agent`: `{ count? | atLeast?, proposalIds, instances[], reason? }`.
- This is the operator-agent sparkle badge, summed over every daemon instance serve holds (core plus each registry instance). `?instances=a,b` narrows it.
- `count` is present only when every instance was counted; otherwise `atLeast`, a floor. `instances[]` says which ones were counted and why not.
- It is a port of the console's `generateProposals` plus `visibleProposals` (remudero-console b66762a). The port is `src/lib/nav-badge-view.ts`, over serve's analytics snapshot, operator-agent memory and settings.
- `proposalIds` (at most 20) lets the console compare its own engine against core's until core is the only engine.

`data.inbox`: `{ ready?, needsYou?, fleet?, reason? }`.
- These are open inbox items by who must act.
- The source is the classification that `GET /v1/inbox` writes (`state/inbox-classified.json`).
