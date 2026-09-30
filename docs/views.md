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

## Rules for a new view

1. Name it after the surface (`nav-badge`, `now`, `repositories`), not after its inputs.
2. `compute` runs on the request. It must be synchronous and cheap, over in-memory caches or one small
   file, and it must never read the ledger union or call `gh`.
3. Declare it in `openapi/daemon.yaml` under `/v1/views/<name>`, with its `data` schema.
4. Register it in `src/lib/serve.ts` through `buildViewRoutes` (`src/lib/views.ts`).

## `nav-badge` (version 1)

`data.agent`: `{ count? | atLeast?, proposalIds, instances[], reason? }`.
- This is the operator-agent sparkle badge, summed over every daemon instance serve holds (core plus each registry instance). `?instances=a,b` narrows it.
- `count` is present only when every instance was counted; otherwise `atLeast`, a floor. `instances[]` says which ones were counted and why not.
- It is a port of the console's `generateProposals` plus `visibleProposals` (remudero-console b66762a). The port is `src/lib/nav-badge-view.ts`, over serve's analytics snapshot, operator-agent memory and settings.
- `proposalIds` (at most 20) lets the console compare its own engine against core's until core is the only engine.

`data.inbox`: `{ ready?, needsYou?, fleet?, reason? }`.
- These are open inbox items by who must act.
- The source is the classification that `GET /v1/inbox` writes (`state/inbox-classified.json`).
