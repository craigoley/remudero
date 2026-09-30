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
- **Switches: dark by default.** `state/read-model/switches.json` holds `{"projector": "on"|"off", "views":
  {"<name>": "serve"|"shadow"|"off"}}`, and serve re-reads it every 5 s off the request path. A view
  with no entry, or no file at all, is **dark**: it answers as `off`. Only the `read-model` status view
  serves without an entry. An absent file writes one `read_model.switch_absent` row and an unreadable
  one a `read_model.switch_unreadable` row (once per distinct reason); an unreadable file turns every
  view back to its default, so a half-written `off` never reads as `serve`.
  - `off`: the view's Phase 0 computation in core answers where one exists (nav-badge), otherwise
    **404 `view_disabled`**, and the console reads its own legacy routes.
  - `shadow`: **legacy primary**. The Phase 0 computation answers where one exists (nav-badge),
    otherwise **404 `view_shadow`** so the console falls back (now, repositories). After every
    response, a sample (at most one a minute per key) goes to the worker's comparator
    (`src/lib/view-shadow.ts`), which diffs the view body against the legacy side: serve's rendered
    legacy body for nav-badge, and for now and repositories the core computation the worker's legacy
    providers produce. The HTTP answer being a 404 does not stop the comparison.
  - `serve`: the read-model body answers. A view with no body yet answers from its Phase 0
    computation, or **404 `view_not_ready`**.
- **Worker diagnostics.** The worker ledgers `read_model.lease_acquired` and `read_model.lease_elsewhere`
  when an instance's lease changes hands, and `read_model.slow_tick` when one projector tick takes longer
  than the 10 s stale bound. A source's staleness is judged from when its tick completed.

## `read-model` (version 1)

`data.instances[]`: `{ instance, generation, lease: held|elsewhere|none, heldBy?, quarantined, reason? }`.
It is the read model's own status: the committed projector transactions per instance DB, who holds the
writer lease, and how many future-dated rows were quarantined.

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

## `repositories` (version 1)

Dark until `switches.json` sets `repositories` to `serve`; until then it answers 404 (`view_disabled`,
or `view_shadow` under `shadow`) and the console reads each instance's `repos/summary` as before. Schema: `RepositoriesView` in `openapi/daemon.yaml`.

`data.instances[]`: `{ instanceId, summary?, reason? }`, one per instance serve holds.
- `summary` IS that instance's `GET /v1/i/<instance>/repos/summary` body (`RepoDashboardResult`),
  computed by the read-model worker from the instance's projected `repo_row` table (`src/lib/repositories-view.ts`).
- A `reason` beside a `summary` means the last recompute failed and the summary shown is older.

`data.projects[]`: `{ project, repos[{ id, reponame, instanceId, state }], worst{ state, repoId, repoName } }`.
- This is the console's `groupRepoProjects`, precomputed. Projects come from the instance registry, in
  first-seen order, and a repository the registry names no project for is its own project.
- `state` (`RepositoryState`) runs worst first: `unavailable` (no summary), `stale`, `unknown` (no
  ledger), `verified`. `worst` is the FIRST repository in the project holding the worst state: the
  "Unavailable · worst is remudero" line.
- It judges only what core measured. A console that cannot reach core still overlays its own
  transport failure.
- `data.projectsReason` is present when the registry could not be read.

## `now` (version 1)

`GET /v1/views/now?instance=<id>`: everything the console's /now renders for one instance. Schema:
`NowView` in `openapi/daemon.yaml`.
- A request without `instance` answers 400 `invalid_request`.
- An instance the worker does not project answers 404 `view_not_ready`.
- The worker materializes it unless `now` is `off`, and serve answers only under `serve`. Otherwise it
  answers 404 (`view_disabled`, or `view_shadow` under `shadow`), and the console reads `/v1/status` and
  `/v1/recent` as before.

`data`: `{ instance, board{ generated_at, counts, spendTodayUsd, taskProjection, tasks[], groups{ running,
needsYou, blocked, queued } }, prQueue, actions[], recent{ entries[], mergedToday{ count, day } }, health,
questions }`.
- `groups` is the console's `groupBoard` as ordered id lists.
- `actions[].strike` is `{ n, of }`, parsed once from the sweep's reason.
- `health` is the selected instance's own host probe. A field it could not read is absent and named in `health.reasons`.
- `questions` is `{ count }` for core and `{ reason }` for any other instance.
- Under `shadow`, the comparator (`src/lib/view-shadow.ts`) diffs a sampled body against `/now`'s legacy
  sources. Those are GET /v1/status's board and PR queue over the instance's live file only, plus a fresh
  host probe of that instance, computed in the worker (`createNowView`'s `legacy`).
- Probe gauges come from the view whenever both probes read them, so two samples moments apart are not a diff.

## Console latency: `POST /v1/console/telemetry` (Phase 2)

The console's hops (stream relay, refetch, render) are measured into core's own ledger
(`src/lib/console-telemetry.ts`). The browser beacons one record per applied view update to a console
route, which forwards the batch (at most 50 records, 16 KiB) here with the ingest-only token or the write
token. Each record becomes one `console.latency` row: `view`, `key`, `cause`, `emittedAt`, and the
millisecond hops `transportMs`, `fetchMs`, `coreMs`, `applyMs`, `paintMs`, `totalMs`, plus
`clockOffsetMs`. Rows are paced to about one a second after a burst of 60; the answer counts what was
`dropped`, and a `console.latency_dropped` row (at most one a minute) carries the count. Schema:
`ConsoleTelemetryRequest` in `openapi/daemon.yaml`.
