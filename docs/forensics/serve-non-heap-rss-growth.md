# Serve non-heap RSS growth attribution

Offline measurements and the evidence still needed to attribute live growth for W1-T10293.

Source basis: `7ecc691aaa5d7f6461524d7e934eae1fd967777c`, the dispatched checkout's
HEAD and local `origin/main` at initial inspection. Measurements use this checkout, not an asserted current
GitHub head. No serve implementation changes are part of this record.

## Growth by generation age

**Not re-measured.** The requested window is the newest seven days ending at collection
time. Its readable row count, newest row timestamp, generation count and age-bucket
quantiles are **unknown**, not zero. This worker's permission profile forbids reading
`/home/node/Remudero/state`; neither `logs-8864/c5-measure/serve-memory-1019-20.ndjson`
nor `logs-8864/c5-bench/` is supplied in this checkout. The corresponding relative
`logs-8864` and `/tmp/logs-8864` directories are absent. No fresh ledger sample is claimed.

The task record reports 764 observations from 2026-10-18T23:23Z through
2026-10-20T15:15Z across 25 generations. These are historical, task-supplied observations,
not measurements reproduced by this run:

| Generation age | Supplied n | Supplied unattributed p50 (MiB) |
|---|---:|---:|
| 0–15 min | 129 | 492 |
| 15–30 min | 118 | 436 |
| 30–60 min | 141 | 493 |
| 1–2 h | 149 | 366 |
| 2–4 h | 121 | 1,037 |
| Over 4 h | 106 | 1,099 |

READ at the source basis: `src/lib/serve-memory.ts::sampleServeMemory` subtracts
`heapTotal`, main `external`, and the sum of worker readings from resident RSS. There is
no `swap_bytes` or `unattributed_basis` field. A GitHub contents read of `main` during this
run returned the same calculation (file blob `95f9809cf137ab56d6c50b052373a6db36ab1f62`).
Consequently the W1-T10295 basis is unavailable in the measured source. The supplied
107 negative observations cannot be repaired from bucket medians; per-row swap or
physical-heap readings are needed. INFERRED: the historical table alone cannot establish
allocator residue, a leak, or a conversion order.

A valid re-measurement must enumerate every compressed archive, plain archive and live
ledger form, report the opened-file count for each, deduplicate overlapping rows, and
print both the window and newest row timestamp. Identify generations from process/start
identity before using their first sample as age zero; do not join different processes
merely because their sample timestamps are adjacent. For a generation already running
at the window start, recover its earlier start/first sample or mark its age left-censored;
do not reset it to zero at the window boundary. Use W1-T10295's explicitly named
basis consistently, preserve unknown readings, and report their excluded count. Retain
negative readings as an accounting diagnostic rather than clamping or dropping them.
The required live positive control is currently unavailable.

## Residue per thread kind

The candidate symbols still exist at the source basis, but their lifecycles differ:

| Candidate | Verified source and actual lifecycle |
|---|---|
| Status prewarm | `status.ts::runPrewarmWorker`, `postPrewarmWorkerResponse`: starts one channel walk and terminates its worker after its result |
| Serve plan reload | `serve-plan-reload.ts::readServePlanOffLoop`, `serveOnePlanReload`: reads committed plan objects, parses them, posts the plan, then parent terminates the worker |
| Repository telemetry | `repo-dashboard-route.ts::startRepoTelemetryWorker`, `computeRepoTelemetryOffThread`: **persistent** worker per module URL, unreferenced while idle, retains its ledger index and plan memo; respawns after failure |
| Integrity | `read-model-worker.ts::threadIntegrityCheck`, `checkReadModelIntegrity`: one thread per check, natural exit after reporting; corruption can also invoke rebuild |
| Issue request | `read-model-worker.ts::threadIssueRequest`, `answerReadModelIssueRequest`: one thread per request, natural exit after reporting |

The task's characterization of repository telemetry as terminated per request is
premise-rotted: `unref()` does not terminate the worker. Its per-request child comparison
must price losing the warm index, not assume an existing termination frequency.

### Offline method and limits

OBSERVED offline on Linux 6.17.0-1022-azure, glibc 2.36, with Node v24.21.0, using one fresh parent per mode and 12
passes per parent. A touched 1,536 MiB Buffer keeps the baseline near 1,600 MiB, matching
the supplied earlier bench's scale. This is smaller than the supplied 3,873–4,512 MiB
whole-serve RSS and uses Buffer ballast rather than serve's live object graph. These are
controlled source-loader comparisons, not a reproduction of serve's complete memory layout.

The exact launch tuning is `NODE_OPTIONS=--max-semi-space-size=16` and
`GLIBC_TUNABLES=glibc.malloc.arena_max=2:glibc.malloc.trim_threshold=131072`, verified at
`deploy/resource-policy.sh` lines 73–74. The parent additionally uses `--expose-gc`.
After each pass, the harness releases its result references, waits 250 ms, collects the
parent only, waits another 250 ms, then samples RSS, VmSwap, the parent's committed and physical heaps, and external memory.
This forced-collection experiment differs from natural serve collection. Source modules
load afresh per isolate; the filesystem and tsx transformation caches may already be warm.

Each pair calls the same exported production body; it does not simulate allocation with
synthetic parsed-row arrays:

- Status: `postPrewarmWorkerResponse` executes both open and closed cold walks over an
  executable offline REST fixture, 1,000 PRs per half, 4,096 body characters per PR. Assertions
  require both successful 1,000-row answers. Issues and review lookups are disabled.
  `NODE_TEST_CONTEXT=child-v8` selects the repository's no-sleep test pacer. No GitHub
  request is made. Work time includes the fixture subprocesses and response transfer.
- Plan: `serveOnePlanReload` reads committed objects at the named SHA using its real
  reader and parser. The answer control is 4,519 tasks, 4,249 blobs and 26,645,633 bytes
  of plan text. Both transports must return the same counts on every pass. A child cannot
  share the returned `SharedArrayBuffer` over default JSON IPC: the bench encodes the
  text as base64 and reconstructs a shared buffer in the parent, including that cost.
  This is an experimental adapter, not a proposed production wire format.
- Repository telemetry: `computeRepoTelemetrySync` uses its default disk/index/plan readers
  on a 20,000-row offline ledger and this checkout's complete plan. The row count is
  asserted each pass. The persistent thread keeps its actual index and plan memo. Its
  first 11 RSS readings include the live isolate; the twelfth follows an artificial
  end-of-experiment termination, not a termination that serve performs per request.
  Each child starts with a cold index and plan memo.
- Integrity: `checkReadModelIntegrity` executes real SQLite `quick_check` over a healthy
  offline database with 10,000 rows of 200-character payloads. Every answer must be
  healthy. The thread closes its port and exits naturally, as the source branch does.
  Corruption, rebuild and a production-sized database are not measured.
- Issue request: `answerReadModelIssueRequest` runs its close arm through a real
  `ghIssueGateway` with only its command transport injected. The fixture asserts one
  issue command and the expected returned URL; no remote issue is touched. The thread
  exits naturally. Escalation/dedup, failures and real CLI/network cost are not measured.

The lab uses a small wrapper entry for both transports. Threads import each body's real
source module, while children are launched by the installed `forkWorkerEntry` with
`execArgv: ['--import', 'tsx']`. This exercises the helper's source path, **not production
bundle selection**, a direct drop-in replacement, or full production request distributions.
Threaded status/plan results are followed by awaited termination; each child sends its
result, exits, and is awaited before RSS sampling.

All RSS deltas below are **OBSERVED offline parent residency above that mode's own
baseline**, not a measurement of glibc alone and not production `unattributed_bytes`.
Parent committed/physical-heap, external and swap deltas accompany them. RSS + VmSwap
is also reported as a resident-plus-swapped footprint, not as resident RSS or pure native
allocation. Missing VmSwap aborts the experiment instead of supplying zero. The separate
terms are retained rather than subtracting committed heap from resident bytes. Active persistent
worker readings include its live heap. Results are discarded by this experiment; serve
may retain them. A pilot that retained an answer promise during sampling was discarded;
only the corrected harness below supplies the final measurements. A second pilot without
VmSwap recorded a telemetry-child RSS delta of -474 MiB; that is not negative allocation
or a saving attributable to the child. It was discarded and prompted the per-process
swap control. A cgroup can hold swap with no OOM event: its swap reading during the
pilot was 3,050,729,472 bytes, which cannot be assigned to any one parent.

### Observed offline results

OBSERVED offline collection window: 2026-10-21T00:29:32.458Z through 2026-10-21T00:37:47.236Z. Ten cases completed, with 12 passes each (120 total).

Memory values below are MiB; each delta is from its own fresh parent baseline. The final persistent telemetry reading follows the lab termination. RSS + swap is a footprint on that named basis, not RSS and not an allocator-only counter.

| Kind | Mode | Base RSS | Base swap | Pass 12 RSS delta | Swap delta | RSS + swap delta | Main physical heap delta | External delta |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| integrity | thread | 1600.484 | 0.000 | 117.672 | 0.000 | 117.672 | -0.500 | 0.000 |
| integrity | child | 1600.250 | 0.000 | 0.980 | 0.000 | 0.980 | -0.750 | 0.004 |
| issue | thread | 1600.219 | 0.000 | 118.156 | 0.000 | 118.156 | -0.453 | 0.000 |
| issue | child | 1599.703 | 0.000 | -341.770 | 343.945 | 2.176 | -0.312 | 0.004 |
| repo | persistent | 1601.016 | 0.000 | 306.836 | 0.000 | 306.836 | -0.547 | 0.000 |
| repo | child | 1600.688 | 0.000 | -930.145 | 932.051 | 1.906 | -0.551 | 0.005 |
| status | thread | 1600.629 | 0.000 | 85.777 | 0.000 | 85.777 | 17.430 | 0.000 |
| status | child | 1601.258 | 0.000 | -522.680 | 579.488 | 56.809 | 30.551 | -0.000 |
| plan | thread | 1600.684 | 0.000 | -161.387 | 654.980 | 493.594 | 21.957 | 0.025 |
| plan | child | 1601.238 | 0.000 | -1360.035 | 1530.379 | 170.344 | 39.777 | 0.759 |

Startup/work values are milliseconds, shown as minimum / median / maximum. `ready` includes spawn, runtime startup and module import; it is not added to `spawn` again. `work` includes request/result transport and, for plan children, text-buffer reconstruction. The persistent worker has one startup, rather than 12.

| Kind | Mode | Synchronous spawn | Ready | Work |
|---|---|---:|---:|---:|
| integrity | thread | 0.388 / 0.516 / 2.690 | 1067.382 / 1614.179 / 1801.323 | 2.738 / 3.544 / 47.544 |
| integrity | child | 60.636 / 99.457 / 163.975 | 995.464 / 1172.862 / 1464.952 | 2.965 / 4.180 / 7.159 |
| issue | thread | 0.364 / 0.501 / 1.341 | 1028.386 / 1313.612 / 1966.366 | 1.280 / 2.064 / 7.079 |
| issue | child | 58.612 / 97.019 / 172.803 | 930.939 / 1225.165 / 2635.625 | 1.445 / 2.200 / 4.166 |
| repo | persistent | 1.309 / 1.309 / 1.309 | 873.067 / 873.067 / 873.067 | 26.955 / 36.264 / 2474.472 |
| repo | child | 62.459 / 108.760 / 225.076 | 696.577 / 839.831 / 1165.078 | 2074.119 / 2712.528 / 4470.906 |
| status | thread | 0.343 / 0.470 / 1.121 | 195.155 / 254.735 / 344.477 | 2327.384 / 2776.972 / 3250.716 |
| status | child | 85.766 / 110.771 / 272.301 | 341.774 / 410.708 / 982.236 | 676.526 / 784.129 / 2553.387 |
| plan | thread | 0.304 / 0.502 / 3.759 | 96.744 / 154.723 / 633.419 | 7256.961 / 8950.205 / 13844.870 |
| plan | child | 39.046 / 81.975 / 156.291 | 181.649 / 304.181 / 500.128 | 7929.558 / 11264.588 / 14447.207 |

These source-loader observations do not establish a production conversion order. In particular, an RSS decrease accompanied by an increase in swap is residency movement, not a negative allocation. The main physical and external terms, input size and persistence differ across kinds; their full fresh-parent deltas must not be summed or multiplied by request count.

<details>
<summary>Full-precision per-pass results and baselines (NDJSON)</summary>

The `deltaMiB` keys are `rss`, `swap` (VmSwap), `heap` (main committed heap), `physical` (main physical heap), and `external`. Timings are milliseconds. Persistent passes 1–11 retain the live worker. No field defaults an unreadable swap reading to zero.

<!-- BENCH_RESULTS -->
```jsonl
{"kind":"integrity","mode":"thread","N":12,"startedAt":"2026-10-21T00:29:32.458Z","endedAt":"2026-10-21T00:29:56.996Z","baseMiB":{"rss":1600.484375,"swap":0,"heap":11.5390625,"physical":10.76171875,"external":1539.7454242706299},"node":"v24.21.0","tuning":"glibc.malloc.arena_max=2:glibc.malloc.trim_threshold=131072","rows":[{"pass":1,"deltaMiB":{"rss":108.4453125,"swap":0,"heap":-0.5,"physical":0.23828125,"external":0.00003814697265625},"readyMs":1791.371153,"spawnSyncMs":1.8861089999999194,"workMs":39.15758800000003},{"pass":2,"deltaMiB":{"rss":110.046875,"swap":0,"heap":-0.5,"physical":-0.5,"external":0.00003814697265625},"readyMs":1734.3977570000006,"spawnSyncMs":0.5904120000000148,"workMs":5.071084000000155},{"pass":3,"deltaMiB":{"rss":112.1171875,"swap":0,"heap":-0.5,"physical":-0.5,"external":0.00003814697265625},"readyMs":1169.0342689999998,"spawnSyncMs":0.3983360000001994,"workMs":3.6376659999996264},{"pass":4,"deltaMiB":{"rss":113.52734375,"swap":0,"heap":-0.5,"physical":-0.5,"external":0.00003814697265625},"readyMs":1485.5314099999996,"spawnSyncMs":0.48587599999973463,"workMs":3.3744520000000193},{"pass":5,"deltaMiB":{"rss":114.34765625,"swap":0,"heap":-0.5,"physical":-0.5,"external":0.00003814697265625},"readyMs":1659.9792730000008,"spawnSyncMs":2.690049999999246,"workMs":47.54423700000007},{"pass":6,"deltaMiB":{"rss":114.63671875,"swap":0,"heap":0.5,"physical":-0.23828125,"external":0.00003814697265625},"readyMs":1314.3447809999998,"spawnSyncMs":0.444444000000658,"workMs":3.133112000001347},{"pass":7,"deltaMiB":{"rss":115.12109375,"swap":0,"heap":-0.5,"physical":-0.5,"external":0.00003814697265625},"readyMs":1588.170782000001,"spawnSyncMs":1.229801999999836,"workMs":3.0379249999987223},{"pass":8,"deltaMiB":{"rss":114.4453125,"swap":0,"heap":-0.5,"physical":-0.5,"external":0.00003814697265625},"readyMs":1801.3229390000015,"spawnSyncMs":0.3880800000006275,"workMs":3.643125999999029},{"pass":9,"deltaMiB":{"rss":115.99609375,"swap":0,"heap":-0.5,"physical":-0.5,"external":0.00003814697265625},"readyMs":1640.1880740000015,"spawnSyncMs":0.4951610000025539,"workMs":3.7426510000004782},{"pass":10,"deltaMiB":{"rss":118.0234375,"swap":0,"heap":-0.5,"physical":-0.5,"external":0.00003814697265625},"readyMs":1720.2641650000005,"spawnSyncMs":1.4354260000000068,"workMs":3.133573000002798},{"pass":11,"deltaMiB":{"rss":118.21875,"swap":0,"heap":-0.5,"physical":-0.5,"external":0.00003814697265625},"readyMs":1177.4267020000007,"spawnSyncMs":0.5370719999991707,"workMs":2.738213000000542},{"pass":12,"deltaMiB":{"rss":117.671875,"swap":0,"heap":-0.5,"physical":-0.5,"external":0.00003814697265625},"readyMs":1067.3817350000027,"spawnSyncMs":0.4850350000015169,"workMs":3.449757000002137}]}
{"kind":"integrity","mode":"child","N":12,"startedAt":"2026-10-21T00:29:58.130Z","endedAt":"2026-10-21T00:30:18.728Z","baseMiB":{"rss":1600.25,"swap":0,"heap":11.7890625,"physical":11.01171875,"external":1539.7454242706299},"node":"v24.21.0","tuning":"glibc.malloc.arena_max=2:glibc.malloc.trim_threshold=131072","rows":[{"pass":1,"deltaMiB":{"rss":0.85546875,"swap":0,"heap":-1,"physical":-0.26171875,"external":0.004277229309082031},"readyMs":1205.585524,"spawnSyncMs":62.53360999999995,"workMs":4.84025500000007},{"pass":2,"deltaMiB":{"rss":0.85546875,"swap":0,"heap":-1,"physical":-1,"external":0.004283905029296875},"readyMs":1216.1555009999997,"spawnSyncMs":120.76642700000002,"workMs":4.15676300000041},{"pass":3,"deltaMiB":{"rss":0.85546875,"swap":0,"heap":-1,"physical":-1,"external":0.004283905029296875},"readyMs":1082.7328689999995,"spawnSyncMs":101.40104799999972,"workMs":2.9649409999992713},{"pass":4,"deltaMiB":{"rss":0.98046875,"swap":0,"heap":-0.75,"physical":-0.75,"external":0.004283905029296875},"readyMs":1163.1775360000001,"spawnSyncMs":134.70312600000034,"workMs":4.202972000000045},{"pass":5,"deltaMiB":{"rss":0.98046875,"swap":0,"heap":-0.75,"physical":-0.75,"external":0.004283905029296875},"readyMs":1464.9520859999993,"spawnSyncMs":163.97455700000046,"workMs":7.158708999999362},{"pass":6,"deltaMiB":{"rss":0.98046875,"swap":0,"heap":-0.75,"physical":-0.75,"external":0.004283905029296875},"readyMs":1285.4796069999993,"spawnSyncMs":141.7724249999992,"workMs":4.21244999999908},{"pass":7,"deltaMiB":{"rss":0.98046875,"swap":0,"heap":-0.75,"physical":-0.75,"external":0.004283905029296875},"readyMs":1175.665551,"spawnSyncMs":120.16246499999943,"workMs":3.9657719999995606},{"pass":8,"deltaMiB":{"rss":0.98046875,"swap":0,"heap":-0.75,"physical":-0.75,"external":0.004283905029296875},"readyMs":1045.343444,"spawnSyncMs":86.19996499999979,"workMs":4.095616000000518},{"pass":9,"deltaMiB":{"rss":0.98046875,"swap":0,"heap":-0.75,"physical":-0.75,"external":0.004283905029296875},"readyMs":1170.0586460000013,"spawnSyncMs":97.51395199999934,"workMs":4.414412000000084},{"pass":10,"deltaMiB":{"rss":0.98046875,"swap":0,"heap":0.25,"physical":-0.48828125,"external":0.004283905029296875},"readyMs":995.4642099999983,"spawnSyncMs":60.636264000000665,"workMs":4.53772200000094},{"pass":11,"deltaMiB":{"rss":0.98046875,"swap":0,"heap":-0.75,"physical":-0.75,"external":0.004283905029296875},"readyMs":1208.223747,"spawnSyncMs":77.04197100000238,"workMs":3.0997019999995246},{"pass":12,"deltaMiB":{"rss":0.98046875,"swap":0,"heap":-0.75,"physical":-0.75,"external":0.004283905029296875},"readyMs":1130.5745920000008,"spawnSyncMs":64.62859899999967,"workMs":3.475764999999228}]}
{"kind":"issue","mode":"thread","N":12,"startedAt":"2026-10-21T00:30:19.850Z","endedAt":"2026-10-21T00:30:42.495Z","baseMiB":{"rss":1600.21875,"swap":0,"heap":11.5390625,"physical":10.48046875,"external":1539.7454242706299},"node":"v24.21.0","tuning":"glibc.malloc.arena_max=2:glibc.malloc.trim_threshold=131072","rows":[{"pass":1,"deltaMiB":{"rss":109.29296875,"swap":0,"heap":-1,"physical":-0.18359375,"external":0.00003814697265625},"readyMs":1490.285636,"spawnSyncMs":1.3406529999999748,"workMs":7.078678999999738},{"pass":2,"deltaMiB":{"rss":111.671875,"swap":0,"heap":-0.75,"physical":-0.50390625,"external":0.00003814697265625},"readyMs":1421.4001170000001,"spawnSyncMs":0.5812180000002627,"workMs":1.492351000000781},{"pass":3,"deltaMiB":{"rss":112.85546875,"swap":0,"heap":-0.75,"physical":-0.49609375,"external":0.00003814697265625},"readyMs":1391.0978059999998,"spawnSyncMs":0.5249039999998786,"workMs":1.7521280000000843},{"pass":4,"deltaMiB":{"rss":112.9453125,"swap":0,"heap":-0.75,"physical":-0.49609375,"external":0.00003814697265625},"readyMs":1136.474002,"spawnSyncMs":0.4211990000003425,"workMs":2.9100140000000465},{"pass":5,"deltaMiB":{"rss":114.484375,"swap":0,"heap":-0.75,"physical":-0.49609375,"external":0.00003814697265625},"readyMs":1220.0417959999995,"spawnSyncMs":0.5739080000003014,"workMs":2.5056750000003376},{"pass":6,"deltaMiB":{"rss":113.41015625,"swap":0,"heap":-0.75,"physical":-0.49609375,"external":0.00003814697265625},"readyMs":1318.7786500000002,"spawnSyncMs":0.4182250000012573,"workMs":2.0435639999996056},{"pass":7,"deltaMiB":{"rss":113.7890625,"swap":0,"heap":-0.75,"physical":-0.453125,"external":0.00003814697265625},"readyMs":1307.6873560000004,"spawnSyncMs":0.47714300000006915,"workMs":1.560602999999901},{"pass":8,"deltaMiB":{"rss":113.10546875,"swap":0,"heap":0.25,"physical":-0.19140625,"external":0.00003814697265625},"readyMs":1966.3658340000002,"spawnSyncMs":0.41444899999987683,"workMs":3.219798999998602},{"pass":9,"deltaMiB":{"rss":114.01953125,"swap":0,"heap":-0.75,"physical":-0.453125,"external":0.00003814697265625},"readyMs":1828.0722309999983,"spawnSyncMs":0.5504240000009304,"workMs":2.779069000000163},{"pass":10,"deltaMiB":{"rss":119.6015625,"swap":0,"heap":-0.75,"physical":-0.453125,"external":0.00003814697265625},"readyMs":1308.4452520000013,"spawnSyncMs":0.5525259999994887,"workMs":1.6849289999991015},{"pass":11,"deltaMiB":{"rss":118.7578125,"swap":0,"heap":-0.75,"physical":-0.453125,"external":0.00003814697265625},"readyMs":1028.3859169999996,"spawnSyncMs":0.36365400000067893,"workMs":2.0849060000000463},{"pass":12,"deltaMiB":{"rss":118.15625,"swap":0,"heap":-0.75,"physical":-0.453125,"external":0.00003814697265625},"readyMs":1030.9001790000002,"spawnSyncMs":0.40449400000215974,"workMs":1.2804940000023635}]}
{"kind":"issue","mode":"child","N":12,"startedAt":"2026-10-21T00:30:43.537Z","endedAt":"2026-10-21T00:31:06.280Z","baseMiB":{"rss":1599.703125,"swap":0,"heap":11.5390625,"physical":10.56640625,"external":1539.7454242706299},"node":"v24.21.0","tuning":"glibc.malloc.arena_max=2:glibc.malloc.trim_threshold=131072","rows":[{"pass":1,"deltaMiB":{"rss":0.98046875,"swap":0,"heap":-1,"physical":-0.2578125,"external":0.004300117492675781},"readyMs":1192.9767930000003,"spawnSyncMs":71.72441600000002,"workMs":1.8949929999998858},{"pass":2,"deltaMiB":{"rss":0.98046875,"swap":0,"heap":-0.75,"physical":-0.72265625,"external":0.004306793212890625},"readyMs":1228.2008180000003,"spawnSyncMs":132.2926309999998,"workMs":1.7970759999998336},{"pass":3,"deltaMiB":{"rss":1.10546875,"swap":0,"heap":-0.5,"physical":-0.3125,"external":0.004306793212890625},"readyMs":1096.801617,"spawnSyncMs":87.72235,"workMs":1.7890240000006088},{"pass":4,"deltaMiB":{"rss":1.10546875,"swap":0,"heap":-0.5,"physical":-0.3125,"external":0.004306793212890625},"readyMs":1382.9375630000004,"spawnSyncMs":106.3154370000002,"workMs":2.4401899999993475},{"pass":5,"deltaMiB":{"rss":1.10546875,"swap":0,"heap":-0.5,"physical":-0.3125,"external":0.004306793212890625},"readyMs":982.1711249999989,"spawnSyncMs":83.17722000000049,"workMs":2.939867000000959},{"pass":6,"deltaMiB":{"rss":1.10546875,"swap":0,"heap":-0.5,"physical":-0.3125,"external":0.004306793212890625},"readyMs":930.9389890000002,"spawnSyncMs":64.73074599999927,"workMs":2.861338999999134},{"pass":7,"deltaMiB":{"rss":1.10546875,"swap":0,"heap":0.5,"physical":-0.05078125,"external":0.004306793212890625},"readyMs":1222.1295500000015,"spawnSyncMs":62.38824199999908,"workMs":2.271357999999964},{"pass":8,"deltaMiB":{"rss":1.10546875,"swap":0,"heap":-0.5,"physical":-0.3125,"external":0.004306793212890625},"readyMs":1510.481721,"spawnSyncMs":107.5856530000001,"workMs":4.165886999999202},{"pass":9,"deltaMiB":{"rss":1.10546875,"swap":0,"heap":-0.5,"physical":-0.3125,"external":0.004306793212890625},"readyMs":2635.6251550000015,"spawnSyncMs":151.7435179999993,"workMs":1.9170669999984966},{"pass":10,"deltaMiB":{"rss":-82.64453125,"swap":84.50390625,"heap":-0.5,"physical":-0.3125,"external":0.004306793212890625},"readyMs":1868.942716999998,"spawnSyncMs":172.80313100000058,"workMs":1.444720999999845},{"pass":11,"deltaMiB":{"rss":-341.76953125,"swap":343.9453125,"heap":-0.5,"physical":-0.3125,"external":0.004306793212890625},"readyMs":1305.4747320000024,"spawnSyncMs":155.59354200000234,"workMs":2.431506000000809},{"pass":12,"deltaMiB":{"rss":-341.76953125,"swap":343.9453125,"heap":-0.5,"physical":-0.3125,"external":0.004306793212890625},"readyMs":938.8082900000009,"spawnSyncMs":58.61163999999917,"workMs":2.129614000001311}]}
{"kind":"repo","mode":"persistent","N":12,"startedAt":"2026-10-21T00:31:07.335Z","endedAt":"2026-10-21T00:31:17.139Z","baseMiB":{"rss":1601.015625,"swap":0,"heap":11.5390625,"physical":10.5703125,"external":1539.7454242706299},"node":"v24.21.0","tuning":"glibc.malloc.arena_max=2:glibc.malloc.trim_threshold=131072","rows":[{"pass":1,"deltaMiB":{"rss":334.8046875,"swap":0,"heap":-0.75,"physical":0.01953125,"external":0.00003814697265625},"readyMs":873.0667910000001,"spawnSyncMs":1.3087570000000142,"workMs":2474.472009},{"pass":2,"deltaMiB":{"rss":335.3515625,"swap":0,"heap":-0.75,"physical":-0.71875,"external":0.00003814697265625},"readyMs":null,"spawnSyncMs":null,"workMs":42.338824000000386},{"pass":3,"deltaMiB":{"rss":335.05859375,"swap":0,"heap":-0.75,"physical":-0.71484375,"external":0.00003814697265625},"readyMs":null,"spawnSyncMs":null,"workMs":42.58419199999935},{"pass":4,"deltaMiB":{"rss":335.890625,"swap":0,"heap":-0.75,"physical":-0.55078125,"external":0.00003814697265625},"readyMs":null,"spawnSyncMs":null,"workMs":42.50752300000022},{"pass":5,"deltaMiB":{"rss":336.609375,"swap":0,"heap":-0.75,"physical":-0.546875,"external":0.00003814697265625},"readyMs":null,"spawnSyncMs":null,"workMs":30.18648800000028},{"pass":6,"deltaMiB":{"rss":339.2578125,"swap":0,"heap":-0.75,"physical":-0.546875,"external":0.00003814697265625},"readyMs":null,"spawnSyncMs":null,"workMs":39.40577099999973},{"pass":7,"deltaMiB":{"rss":341.9296875,"swap":0,"heap":-0.75,"physical":-0.546875,"external":0.00003814697265625},"readyMs":null,"spawnSyncMs":null,"workMs":33.121947000000546},{"pass":8,"deltaMiB":{"rss":341.9296875,"swap":0,"heap":-0.75,"physical":-0.546875,"external":0.00003814697265625},"readyMs":null,"spawnSyncMs":null,"workMs":27.305951999999706},{"pass":9,"deltaMiB":{"rss":346.5546875,"swap":0,"heap":-0.75,"physical":-0.546875,"external":0.00003814697265625},"readyMs":null,"spawnSyncMs":null,"workMs":27.90297399999872},{"pass":10,"deltaMiB":{"rss":344.6484375,"swap":0,"heap":-0.75,"physical":-0.546875,"external":0.00003814697265625},"readyMs":null,"spawnSyncMs":null,"workMs":28.45816399999967},{"pass":11,"deltaMiB":{"rss":329.82421875,"swap":0,"heap":-0.75,"physical":-0.546875,"external":0.00003814697265625},"readyMs":null,"spawnSyncMs":null,"workMs":26.954947000000175},{"pass":12,"deltaMiB":{"rss":306.8359375,"swap":0,"heap":-0.75,"physical":-0.546875,"external":0.00003814697265625},"readyMs":null,"spawnSyncMs":null,"workMs":47.589890999999625}]}
{"kind":"repo","mode":"child","N":12,"startedAt":"2026-10-21T00:31:18.239Z","endedAt":"2026-10-21T00:32:10.105Z","baseMiB":{"rss":1600.6875,"swap":0,"heap":11.5390625,"physical":10.55859375,"external":1539.7454242706299},"node":"v24.21.0","tuning":"glibc.malloc.arena_max=2:glibc.malloc.trim_threshold=131072","rows":[{"pass":1,"deltaMiB":{"rss":0.98046875,"swap":0,"heap":-0.75,"physical":0.01953125,"external":0.0045642852783203125},"readyMs":779.524324,"spawnSyncMs":134.50908800000002,"workMs":2101.602756},{"pass":2,"deltaMiB":{"rss":0.98046875,"swap":0,"heap":-0.75,"physical":-0.55078125,"external":0.004570960998535156},"readyMs":696.5772360000001,"spawnSyncMs":78.75367499999993,"workMs":2074.118901},{"pass":3,"deltaMiB":{"rss":0.98046875,"swap":0,"heap":-0.75,"physical":-0.55078125,"external":0.004570960998535156},"readyMs":717.0687180000004,"spawnSyncMs":77.46180300000015,"workMs":2449.805555000001},{"pass":4,"deltaMiB":{"rss":0.98046875,"swap":0,"heap":-0.75,"physical":-0.55078125,"external":0.004570960998535156},"readyMs":817.5381450000004,"spawnSyncMs":151.2483349999984,"workMs":2324.288490000001},{"pass":5,"deltaMiB":{"rss":0.98046875,"swap":0,"heap":-0.75,"physical":-0.55078125,"external":0.004570960998535156},"readyMs":1165.0779219999986,"spawnSyncMs":106.49444600000061,"workMs":4265.927739999999},{"pass":6,"deltaMiB":{"rss":0.98046875,"swap":0,"heap":-0.75,"physical":-0.55078125,"external":0.004570960998535156},"readyMs":1122.9200180000007,"spawnSyncMs":225.07593400000042,"workMs":3407.767501999999},{"pass":7,"deltaMiB":{"rss":-26.39453125,"swap":27.53515625,"heap":-0.75,"physical":-0.55078125,"external":0.004570960998535156},"readyMs":862.1245929999968,"spawnSyncMs":105.30262199999925,"workMs":3064.6795280000006},{"pass":8,"deltaMiB":{"rss":-446.14453125,"swap":447.828125,"heap":-0.75,"physical":-0.55078125,"external":0.004570960998535156},"readyMs":894.8023220000032,"spawnSyncMs":111.02507200000036,"workMs":4470.9059709999965},{"pass":9,"deltaMiB":{"rss":-593.89453125,"swap":595.8203125,"heap":0.25,"physical":-0.2890625,"external":0.004570960998535156},"readyMs":1115.2815910000063,"spawnSyncMs":113.53171999999904,"workMs":2979.9231160000054},{"pass":10,"deltaMiB":{"rss":-633.39453125,"swap":635.41796875,"heap":-0.75,"physical":-0.55078125,"external":0.004570960998535156},"readyMs":786.0670529999989,"spawnSyncMs":67.25535500000115,"workMs":2975.249563999998},{"pass":11,"deltaMiB":{"rss":-837.01953125,"swap":839.05078125,"heap":-0.75,"physical":-0.55078125,"external":0.004570960998535156},"readyMs":903.0471009999965,"spawnSyncMs":112.9286260000008,"workMs":2108.6244609999994},{"pass":12,"deltaMiB":{"rss":-930.14453125,"swap":932.05078125,"heap":-0.75,"physical":-0.55078125,"external":0.004570960998535156},"readyMs":760.2407059999969,"spawnSyncMs":62.459452000002784,"workMs":2228.711102000001}]}
{"kind":"status","mode":"thread","N":12,"startedAt":"2026-10-21T00:32:11.296Z","endedAt":"2026-10-21T00:32:54.139Z","baseMiB":{"rss":1600.62890625,"swap":0,"heap":11.7890625,"physical":10.828125,"external":1539.7454242706299},"node":"v24.21.0","tuning":"glibc.malloc.arena_max=2:glibc.malloc.trim_threshold=131072","rows":[{"pass":1,"deltaMiB":{"rss":64.06640625,"swap":0,"heap":14.25,"physical":7.1796875,"external":0.00003814697265625},"readyMs":283.71534799999995,"spawnSyncMs":1.120616000000041,"workMs":2628.477395},{"pass":2,"deltaMiB":{"rss":77.4609375,"swap":0,"heap":30.25,"physical":15.34765625,"external":0.00003814697265625},"readyMs":248.50643899999977,"spawnSyncMs":0.49154499999986,"workMs":2788.122201},{"pass":3,"deltaMiB":{"rss":78.45703125,"swap":0,"heap":30.25,"physical":16.33203125,"external":0.00003814697265625},"readyMs":257.80958499999906,"spawnSyncMs":0.5269179999995686,"workMs":2327.384175000001},{"pass":4,"deltaMiB":{"rss":79.546875,"swap":0,"heap":30.25,"physical":17.4296875,"external":0.00003814697265625},"readyMs":287.960344000001,"spawnSyncMs":0.5565330000008544,"workMs":3025.494831},{"pass":5,"deltaMiB":{"rss":78.6953125,"swap":0,"heap":30.25,"physical":17.4296875,"external":0.00003814697265625},"readyMs":271.70828299999994,"spawnSyncMs":0.4896530000005441,"workMs":2655.341571000001},{"pass":6,"deltaMiB":{"rss":79.03515625,"swap":0,"heap":30.25,"physical":17.4296875,"external":0.00003814697265625},"readyMs":195.15494300000137,"spawnSyncMs":0.39104500000030384,"workMs":2953.846443000002},{"pass":7,"deltaMiB":{"rss":78.87109375,"swap":0,"heap":-0.75,"physical":0.2109375,"external":0.00003814697265625},"readyMs":236.75770399999965,"spawnSyncMs":0.45784500000081607,"workMs":2752.2335759999987},{"pass":8,"deltaMiB":{"rss":83.17578125,"swap":0,"heap":14.25,"physical":7.3359375,"external":0.00003814697265625},"readyMs":283.30588999999964,"spawnSyncMs":0.46345300000029965,"workMs":3250.7155669999993},{"pass":9,"deltaMiB":{"rss":83.41015625,"swap":0,"heap":30.25,"physical":15.4609375,"external":0.00003814697265625},"readyMs":231.88472100000217,"spawnSyncMs":0.470314000001963,"workMs":2784.3759739999987},{"pass":10,"deltaMiB":{"rss":84.44921875,"swap":0,"heap":30.25,"physical":16.4453125,"external":0.00003814697265625},"readyMs":344.47711900000286,"spawnSyncMs":0.4690219999974943,"workMs":2769.567145000001},{"pass":11,"deltaMiB":{"rss":85.02734375,"swap":0,"heap":30.25,"physical":17.4296875,"external":0.00003814697265625},"readyMs":239.29898800000228,"spawnSyncMs":0.41915700000390643,"workMs":3117.352834999998},{"pass":12,"deltaMiB":{"rss":85.77734375,"swap":0,"heap":30.25,"physical":17.4296875,"external":0.00003814697265625},"readyMs":251.65950000000157,"spawnSyncMs":0.3430630000002566,"workMs":2490.618303999996}]}
{"kind":"status","mode":"child","N":12,"startedAt":"2026-10-21T00:32:55.345Z","endedAt":"2026-10-21T00:33:20.329Z","baseMiB":{"rss":1601.2578125,"swap":0,"heap":11.7890625,"physical":10.98828125,"external":1539.7454242706299},"node":"v24.21.0","tuning":"glibc.malloc.arena_max=2:glibc.malloc.trim_threshold=131072","rows":[{"pass":1,"deltaMiB":{"rss":25.828125,"swap":0,"heap":30.25,"physical":16.140625,"external":0.00421905517578125},"readyMs":427.60507500000006,"spawnSyncMs":109.63700500000004,"workMs":794.6742879999999},{"pass":2,"deltaMiB":{"rss":53.453125,"swap":0,"heap":32,"physical":31.6015625,"external":0.05093097686767578},"readyMs":444.75916700000016,"spawnSyncMs":115.59681300000011,"workMs":824.569031},{"pass":3,"deltaMiB":{"rss":55.71484375,"swap":0,"heap":31.5,"physical":31.26171875,"external":0.023275375366210938},"readyMs":376.78981099999964,"spawnSyncMs":117.5077769999998,"workMs":700.8193089999995},{"pass":4,"deltaMiB":{"rss":55.74609375,"swap":0,"heap":32.5,"physical":32.3046875,"external":0.018713951110839844},"readyMs":349.42847299999994,"spawnSyncMs":102.75571500000024,"workMs":723.3971659999997},{"pass":5,"deltaMiB":{"rss":55.81640625,"swap":0,"heap":33.25,"physical":33.0546875,"external":0.046362876892089844},"readyMs":393.80993800000033,"spawnSyncMs":98.02274599999964,"workMs":773.5844370000004},{"pass":6,"deltaMiB":{"rss":56.1796875,"swap":0,"heap":32.25,"physical":32.06640625,"external":0.046362876892089844},"readyMs":345.87897599999997,"spawnSyncMs":85.76624000000083,"workMs":676.526398},{"pass":7,"deltaMiB":{"rss":56.14453125,"swap":0,"heap":32.75,"physical":32.56640625,"external":0.011511802673339844},"readyMs":341.77437699999973,"spawnSyncMs":96.53141700000015,"workMs":729.6386940000011},{"pass":8,"deltaMiB":{"rss":56.33203125,"swap":0,"heap":33.25,"physical":33.06640625,"external":0.04636955261230469},"readyMs":361.459519,"spawnSyncMs":111.90483099999983,"workMs":744.1897719999997},{"pass":9,"deltaMiB":{"rss":-68.4375,"swap":124.890625,"heap":29.75,"physical":30.55078125,"external":-0.00034236907958984375},"readyMs":557.501275999999,"spawnSyncMs":139.64302000000134,"workMs":2553.3874389999983},{"pass":10,"deltaMiB":{"rss":-409.98046875,"swap":466.20703125,"heap":31.25,"physical":31.3125,"external":0.018713951110839844},"readyMs":982.2360630000003,"spawnSyncMs":225.23830200000157,"workMs":1520.4841099999976},{"pass":11,"deltaMiB":{"rss":-523.02734375,"swap":579.48828125,"heap":32.25,"physical":32.3125,"external":0.011511802673339844},"readyMs":962.7658880000017,"spawnSyncMs":272.30095699999947,"workMs":1891.7170530000003},{"pass":12,"deltaMiB":{"rss":-522.6796875,"swap":579.48828125,"heap":29.75,"physical":30.55078125,"external":-0.00034236907958984375},"readyMs":450.09317100000044,"spawnSyncMs":106.02159499999834,"workMs":866.1869480000023}]}
{"kind":"plan","mode":"thread","N":12,"control":{"tasks":4519,"blobs":4249,"textBytes":26645633},"startedAt":"2026-10-21T00:33:21.944Z","endedAt":"2026-10-21T00:35:20.801Z","baseMiB":{"rss":1600.68359375,"swap":0,"heap":11.7890625,"physical":11.01171875,"external":1539.7454242706299},"node":"v24.21.0","tuning":"glibc.malloc.arena_max=2:glibc.malloc.trim_threshold=131072","rows":[{"pass":1,"deltaMiB":{"rss":468.0703125,"swap":0,"heap":33,"physical":10.390625,"external":0.00003814697265625},"readyMs":633.4187869999998,"spawnSyncMs":3.7594429999999193,"workMs":13844.869777},{"pass":2,"deltaMiB":{"rss":247.765625,"swap":240.828125,"heap":30.25,"physical":31.02734375,"external":0.02908039093017578},"readyMs":194.45574899999883,"spawnSyncMs":0.5517049999998562,"workMs":9195.123059999998},{"pass":3,"deltaMiB":{"rss":-78.65625,"swap":568.84375,"heap":30.25,"physical":31.02734375,"external":0.02908039093017578},"readyMs":157.6073970000034,"spawnSyncMs":0.8196260000004258,"workMs":8095.143528000004},{"pass":4,"deltaMiB":{"rss":-75.10546875,"swap":566.8671875,"heap":31.75,"physical":21.20703125,"external":0.02908039093017578},"readyMs":210.88131900000008,"spawnSyncMs":0.49097400000027847,"workMs":8705.287441},{"pass":5,"deltaMiB":{"rss":-74.17578125,"swap":566.85546875,"heap":32,"physical":21.45703125,"external":0.024518966674804688},"readyMs":169.77244999999675,"spawnSyncMs":0.4941689999977825,"workMs":9802.076720000005},{"pass":6,"deltaMiB":{"rss":-73.171875,"swap":566.85546875,"heap":33.25,"physical":22.70703125,"external":0.024518966674804688},"readyMs":171.41210200000205,"spawnSyncMs":0.35099500000069384,"workMs":8635.371286000001},{"pass":7,"deltaMiB":{"rss":-71.8828125,"swap":566.85546875,"heap":34,"physical":23.45703125,"external":0.024518966674804688},"readyMs":98.1441330000016,"spawnSyncMs":0.4223809999966761,"workMs":7256.960791999998},{"pass":8,"deltaMiB":{"rss":-72.89453125,"swap":566.85546875,"heap":33.75,"physical":23.20703125,"external":0.024518966674804688},"readyMs":104.9234570000117,"spawnSyncMs":0.39044400000420865,"workMs":9238.415578999993},{"pass":9,"deltaMiB":{"rss":-72.2109375,"swap":566.8515625,"heap":34.75,"physical":23.9609375,"external":0.024518966674804688},"readyMs":151.83900500000163,"spawnSyncMs":0.509301999991294,"workMs":7830.290074000004},{"pass":10,"deltaMiB":{"rss":-73.8828125,"swap":566.8515625,"heap":30,"physical":30.77734375,"external":0.024518966674804688},"readyMs":96.7444819999946,"spawnSyncMs":0.5207099999970524,"workMs":7906.748022999993},{"pass":11,"deltaMiB":{"rss":-85.671875,"swap":580.3046875,"heap":32,"physical":21.45703125,"external":0.024518966674804688},"readyMs":107.62923500000034,"spawnSyncMs":0.5268979999964358,"workMs":9974.329572000002},{"pass":12,"deltaMiB":{"rss":-161.38671875,"swap":654.98046875,"heap":32.5,"physical":21.95703125,"external":0.024518966674804688},"readyMs":113.01650599999994,"spawnSyncMs":0.3044649999937974,"workMs":9819.200117999993}]}
{"kind":"plan","mode":"child","N":12,"control":{"tasks":4519,"blobs":4249,"textBytes":26645633},"startedAt":"2026-10-21T00:35:22.325Z","endedAt":"2026-10-21T00:37:47.236Z","baseMiB":{"rss":1601.23828125,"swap":0,"heap":11.7890625,"physical":10.51171875,"external":1539.7454242706299},"node":"v24.21.0","tuning":"glibc.malloc.arena_max=2:glibc.malloc.trim_threshold=131072","rows":[{"pass":1,"deltaMiB":{"rss":158.20703125,"swap":0,"heap":30.25,"physical":31.0859375,"external":0.00421905517578125},"readyMs":379.861083,"spawnSyncMs":155.62443399999984,"workMs":14447.206941999999},{"pass":2,"deltaMiB":{"rss":164.42578125,"swap":0,"heap":31.5,"physical":32.59765625,"external":25.446011543273926},"readyMs":334.6530670000029,"spawnSyncMs":156.2911469999999,"workMs":8623.862629000003},{"pass":3,"deltaMiB":{"rss":-228.96484375,"swap":395.58984375,"heap":31.75,"physical":32.99609375,"external":25.473660469055176},"readyMs":276.99190799999997,"spawnSyncMs":92.0201199999974,"workMs":8953.257256999997},{"pass":4,"deltaMiB":{"rss":-232.2109375,"swap":399.9609375,"heap":33,"physical":34.24609375,"external":25.467617988586426},"readyMs":213.65481100000034,"spawnSyncMs":68.76110200000403,"workMs":7929.558231000003},{"pass":5,"deltaMiB":{"rss":-662.484375,"swap":830.7578125,"heap":34,"physical":35.24609375,"external":28.470852851867676},"readyMs":317.2609550000052,"spawnSyncMs":110.05789299999742,"workMs":12013.886441000002},{"pass":6,"deltaMiB":{"rss":-994.8984375,"swap":1164.49609375,"heap":35.25,"physical":36.52734375,"external":0.3484153747558594},"readyMs":276.8798319999987,"spawnSyncMs":71.92904900000576,"workMs":12948.674284999994},{"pass":7,"deltaMiB":{"rss":-1059.94921875,"swap":1229.7421875,"heap":35.5,"physical":36.77734375,"external":0.3484153747558594},"readyMs":471.88364100000763,"spawnSyncMs":136.7102509999968,"workMs":14410.231855999999},{"pass":8,"deltaMiB":{"rss":-1286.15234375,"swap":1456.20703125,"heap":35.5,"physical":36.77734375,"external":25.473660469055176},"readyMs":500.1282530000026,"spawnSyncMs":99.41770499999984,"workMs":12618.19137700001},{"pass":9,"deltaMiB":{"rss":-1308.9375,"swap":1479.1171875,"heap":36,"physical":37.27734375,"external":25.473660469055176},"readyMs":291.1001830000023,"spawnSyncMs":44.08108699999866,"workMs":11383.495082000009},{"pass":10,"deltaMiB":{"rss":-1337.3671875,"swap":1507.83203125,"heap":37.25,"physical":38.52734375,"external":25.495266914367676},"readyMs":181.64885800000047,"spawnSyncMs":39.045965000012075,"workMs":9631.097488},{"pass":11,"deltaMiB":{"rss":-1360.640625,"swap":1530.8515625,"heap":37.5,"physical":38.77734375,"external":25.543362617492676},"readyMs":212.8327319999953,"spawnSyncMs":49.29313499999989,"workMs":11145.68013400001},{"pass":12,"deltaMiB":{"rss":-1360.03515625,"swap":1530.37890625,"heap":38.5,"physical":39.77734375,"external":0.7594261169433594},"readyMs":318.3415190000087,"spawnSyncMs":45.053522000001976,"workMs":10538.807771000022}]}
```

Measurement NDJSON SHA-256: `70af9762dec6bf6cf2e4256fd27ffed431e99a2764ab54ececc4a8fe5b5d8124`.

</details>

### Reproduce the offline comparison

Run from the source-basis checkout with its installed dependencies. This creates only
owned temporary fixtures; it neither reads the live ledger nor calls GitHub. Plan reads
use the production reader's read-only local git calls. Keep all cases sequential.

```bash
export BENCH_ROOT="$PWD"
BENCH_DIR="$(mktemp -d /tmp/rmd-rss-bench-XXXXXX)"
export BENCH_DIR
python3 - <<'PYCODE'
import os
from pathlib import Path
text = Path('docs/forensics/serve-non-heap-rss-growth.md').read_text()
code = text.split('<!-- BENCH_SOURCE -->\n```javascript\n', 1)[1].split('\n```', 1)[0] + '\n'
Path(os.environ['BENCH_DIR'], 'bench.mjs').write_text(code)
PYCODE
export GLIBC_TUNABLES=glibc.malloc.arena_max=2:glibc.malloc.trim_threshold=131072
export NODE_OPTIONS=--max-semi-space-size=16
export NODE_TEST_CONTEXT=child-v8
export BENCH_N=12
node --import tsx "$BENCH_DIR/bench.mjs" setup
for spec in 'integrity thread' 'integrity child' 'issue thread' 'issue child' 'repo persistent' 'repo child' 'status thread' 'status child' 'plan thread' 'plan child'; do
  node --expose-gc --import tsx "$BENCH_DIR/bench.mjs" $spec >> "$BENCH_DIR/results.ndjson" || break
done
python3 - <<'PYCODE'
import json, os
from pathlib import Path
rows = [json.loads(line) for line in Path(os.environ['BENCH_DIR'], 'results.ndjson').read_text().splitlines()]
expected = {(kind, mode) for kind in ['integrity', 'issue', 'repo', 'status', 'plan'] for mode in (['persistent', 'child'] if kind == 'repo' else ['thread', 'child'])}
assert {(r['kind'], r['mode']) for r in rows} == expected and len(rows) == 10
assert all(r['N'] == 12 and [p['pass'] for p in r['rows']] == list(range(1, 13)) for r in rows)
print('complete: 10 cases, 120 passes')
PYCODE
```

Require ten result records, each containing all 12 passes and the named controls; a
missing record is a failed/incomplete run. Preserve results before cleaning the owned
fixture directory. Do not run against newer source and label it with this record's SHA.

<!-- BENCH_SOURCE -->
```javascript
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { getHeapStatistics } from 'node:v8';
const root = process.env.BENCH_ROOT;
const dir = fileURLToPath(new URL('.', import.meta.url));
const N = Number(process.env.BENCH_N ?? 12);
const kind = process.argv[2] ?? workerData?.kind;
const mode = process.argv[3];
const child = Boolean(process.send);
const modulePath = { status: 'status', integrity: 'read-model-worker', repo: 'repo-dashboard-route', plan: 'serve-plan-reload', issue: 'read-model-worker' };
const nowMs = Date.parse('2026-10-21T00:00:00Z');
if (!isMainThread || child) {
  const mod = await import(pathToFileURL(join(root, 'src/lib', modulePath[kind] + '.ts')).href);
  const send = (value) => child ? process.send(value) : parentPort.postMessage(value);
  send({ type: 'ready' });
  const run = async () => {
    if (kind === 'plan') {
      let result;
      await mod.serveOnePlanReload({ repoDir: root, ref: '7ecc691aaa5d7f6461524d7e934eae1fd967777c' }, { postMessage: (value) => { result = value; } });
      assert.equal(result.ok, true, result.reason);
      assert.ok(result.read.plan.tasks.length > 0);
      return result;
    }
    if (kind === 'issue') {
      const { ghIssueGateway } = await import(pathToFileURL(join(root, 'src/lib/escalate.ts')).href);
      let calls = 0;
      const issues = ghIssueGateway('offline', 'fixture', { exec: (args) => { assert.equal(args[0], 'issue'); calls++; return ''; } });
      const result = mod.answerReadModelIssueRequest({ op: 'close', repository: 'offline/fixture', url: 'https://example.invalid/issues/1', comment: 'offline fixture' }, issues);
      assert.equal(calls, 1);
      assert.equal(result.url, 'https://example.invalid/issues/1');
      return result;
    }
    if (kind === 'integrity') {
      const result = mod.checkReadModelIntegrity({ instance: 'bench', dbPath: join(dir, 'healthy.sqlite'), stateDir: dir, ledgerDir: dir });
      assert.equal(result.ok, true);
      return result;
    }
    if (kind === 'repo') {
      const result = mod.computeRepoTelemetrySync({ kind: 'remudero-repo-telemetry', repos: [{ repo: 'offline/fixture' }], ledgerPath: join(dir, 'ledger.ndjson'), planPath: join(root, 'plan/tasks.yaml'), nowMs, own: 0, planStamp: 'fixed' });
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.index.rows, 20000);
      return result;
    }
    let result;
    mod.postPrewarmWorkerResponse({ postMessage: (value) => { result = value; } }, { kind: 'remudero-board-prewarm-walk', owner: 'offline', repo: 'fixture', ghBin: join(dir, 'offline-page'), fetchOpen: true, fetchMerged: true, fetchIssues: false, reviewRefs: [] });
    assert.equal(result.open.ok, true, JSON.stringify(result.open));
    assert.equal(result.merged.ok, true, JSON.stringify(result.merged));
    assert.equal(result.open.rows.length, 1000);
    assert.equal(result.merged.rows.length, 1000);
    return result;
  };
  (child ? process : parentPort).on('message', async () => {
    const result = await run();
    const control = kind === 'plan' ? { tasks: result.read.plan.tasks.length, blobs: result.read.text.labels.length, textBytes: result.read.text.buffer.byteLength } : undefined;
    if (child && kind === 'plan') result.read.text.buffer = Buffer.from(result.read.text.buffer).toString('base64');
    if (child) process.send({ type: 'done', result, control }, () => process.exit(0));
    else { send({ type: 'done', result, control }); if (kind === 'integrity' || kind === 'issue') parentPort.close(); }
  });
} else if (kind === 'setup') {
  const db = new DatabaseSync(join(dir, 'healthy.sqlite'));
  db.exec('CREATE TABLE sample (id INTEGER PRIMARY KEY, payload TEXT); BEGIN');
  const put = db.prepare('INSERT INTO sample VALUES (?, ?)');
  for (let i = 0; i < 10000; i++) put.run(i, 'x'.repeat(200));
  db.exec('COMMIT'); db.close();
  writeFileSync(join(dir, 'ledger.ndjson'), Array.from({ length: 20000 }, (_, i) => JSON.stringify({ ts: new Date(nowMs - 200000 + i).toISOString(), step: 'run.start', run_id: `bench-${i}`, task_id: `W1-T${i}`, repo: 'offline/fixture' })).join('\n') + '\n');
  const page = Array.from({ length: 100 }, (_, i) => ({ number: i + 1, title: 'fixture', body: 'x'.repeat(4096), html_url: `https://example.invalid/pull/${i + 1}`, state: 'open', updated_at: new Date(nowMs - i).toISOString(), head: { ref: 'fixture', sha: 'a'.repeat(40) } }));
  writeFileSync(join(dir, 'page.json'), JSON.stringify(page));
  writeFileSync(join(dir, 'offline-page'), '#!/usr/bin/env node\nconst fs = require("node:fs"); const url = process.argv.at(-1); const page = Number(new URL("https://example.invalid/" + url).searchParams.get("page") || 1); const rows = page <= 10 ? JSON.parse(fs.readFileSync(__dirname + "/page.json", "utf8")).map(r => ({...r, number:r.number + (page-1)*100, state:url.includes("state=closed") ? "closed" : "open", merged_at:url.includes("state=closed") ? "2026-10-20T00:00:00Z" : null})) : []; process.stdout.write("HTTP/2.0 200 OK\\r\\nX-RateLimit-Remaining: 5000\\r\\nX-RateLimit-Limit: 5000\\r\\nX-RateLimit-Resource: core\\r\\n\\r\\n" + JSON.stringify(rows));\n');
  chmodSync(join(dir, 'offline-page'), 0o755);
  console.log(JSON.stringify({ setup: true, ledgerRows: 20000, sqliteRows: 10000, statusPrs: 2000 }));
} else {
  const { forkWorkerEntry } = await import(pathToFileURL(join(root, 'src/lib/child-entry-argv.ts')).href);
  const ballast = Buffer.alloc(1536 * 1024 ** 2, 1);
  global.gc(); await sleep(250);
  const memory = () => {
    const usage = process.memoryUsage();
    const swap = /^VmSwap:\s+(\d+) kB/m.exec(readFileSync('/proc/self/status', 'utf8'));
    assert.ok(swap, 'VmSwap is required, never defaulted to zero');
    return { rss: usage.rss, swap: Number(swap[1]) * 1024, heap: usage.heapTotal, physical: getHeapStatistics().total_physical_size, external: usage.external };
  };
  const base = memory();
  const startedAt = new Date().toISOString();
  const rows = [];
  let control;
  const deadline = setTimeout(() => { console.error('benchmark timed out'); process.exit(2); }, 300000);
  deadline.unref();
  let lane;
  const spawn = async () => {
    const start = performance.now();
    let syncMs;
    if (mode === 'child') {
      const launched = forkWorkerEntry(import.meta.url, [kind], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
      lane = launched.child; syncMs = launched.spawnSyncMs;
    } else {
      lane = new Worker(new URL(import.meta.url), { workerData: { kind }, execArgv: ['--import', 'tsx'] });
      syncMs = performance.now() - start;
    }
    const exited = once(lane, 'exit');
    const [msg] = await once(lane, 'message');
    assert.equal(msg.type, 'ready');
    return { readyMs: performance.now() - start, syncMs, exited };
  };
  let started;
  for (let pass = 1; pass <= N; pass++) {
    if (mode !== 'persistent' || pass === 1) started = await spawn();
    const workMs = await (async () => {
      const done = once(lane, 'message');
      const begin = performance.now();
      mode === 'child' ? lane.send({ run: true }) : lane.postMessage({ run: true });
      const [answer] = await done; assert.equal(answer.type, 'done');
      if (kind === 'plan') {
        if (mode === 'child') {
          const bytes = Buffer.from(answer.result.read.text.buffer, 'base64');
          answer.result.read.text.buffer = new SharedArrayBuffer(bytes.length);
          Buffer.from(answer.result.read.text.buffer).set(bytes);
        }
        assert.equal(answer.result.read.text.buffer.byteLength, answer.control.textBytes);
        assert.equal(answer.result.read.plan.tasks.length, answer.control.tasks);
        if (control) assert.deepEqual(answer.control, control); else control = answer.control;
      }
      return performance.now() - begin;
    })();
    if (mode === 'child' || kind === 'integrity' || kind === 'issue') await started.exited;
    else if (mode !== 'persistent' || pass === N) await lane.terminate();
    await sleep(250); global.gc(); await sleep(250);
    const current = memory();
    const deltaMiB = Object.fromEntries(Object.keys(base).map(key => [key, (current[key] - base[key]) / 1024 ** 2]));
    rows.push({ pass, deltaMiB, readyMs: mode === 'persistent' && pass > 1 ? null : started.readyMs, spawnSyncMs: mode === 'persistent' && pass > 1 ? null : started.syncMs, workMs });
  }
  assert.equal(ballast[ballast.length - 1], 1);
  console.log(JSON.stringify({ kind, mode, N, control, startedAt, endedAt: new Date().toISOString(), baseMiB: Object.fromEntries(Object.entries(base).map(([key, value]) => [key, value / 1024 ** 2])), node: process.version, tuning: process.env.GLIBC_TUNABLES, rows }));
}
```

Harness SHA-256: `2b90eec537bc89f7fcac4970f51670ea5492a6d81236a2183deb2f60c85d7f68`.

## Live attribution

**Unavailable.** No live spawn/exit events or `serve.memory` thread lists were accessible.
No kind is identified as preceding the reported live step changes by this run.

For a valid join, match thread identifiers and owning process/generation, and distinguish
spawn, successful response, termination request and completed exit. A thread absent from
two samples may have run entirely between them; absence is not a zero spawn count.
Flag unsized/error worker readings and changes in the measured worker set; missing
heap coverage can create a residual step without an allocator change.
Join consecutive samples on the same accounting basis, recording elapsed time, main and
worker heap changes, swap, relief events and overlapping workers. Compare exits with
otherwise quiet intervals; post-exit loss of a subtracted worker heap can itself increase
the residual without an RSS increase. A temporal association would be INFERRED attribution,
not proof of allocator causation. Persistent telemetry should be joined at actual restarts
or failures, not at every refresh.

## Proposal

**No conversion order is justified yet.** Keep the existing lifecycles pending a valid live
join and representative measurements. Offline fixture savings are conditional observations;
without frequency, they cannot establish which child pays for its fork and cold load.
Do not transfer PR #13207's synthetic 300 MB allocation ratio to these real bodies.

INFERRED priority for finishing live validation: **plan reload first**, because it has
the largest observed final footprint difference among the actual short-lived kinds in
this source-loader replay. This ranks evidence collection; it does not establish the
production frequency or an allocator-only saving.

| Kind | OBSERVED offline pass-12 footprint delta, thread to child (MiB) | Disposition before any conversion task is filed |
|---|---|---|
| Plan reload | 493.594 to 170.344; difference 323.250 | First live-validation candidate. Child median work was 11.265 s versus 8.950 s; price the text-buffer bridge and actual reload count, then validate the bundled path |
| Status prewarm | 85.777 to 56.809; difference 28.969 | Leave as a thread pending cold-versus-delta walk frequency and a representative transport replay; the cold fixture's subprocess cost differs from production network/pacing cost |
| Integrity | 117.672 to 0.980; difference 116.691 | Leave as a thread pending actual unclean-shutdown/periodic counts and database size; a daily periodic check is not a measured repeated two-hour workload |
| Issue request | 118.156 to 2.176; difference 115.980 | Leave as a thread pending close/escalate counts and both real transport paths; only the close body with injected command transport was measured |
| Repository telemetry | 306.836 after lab termination to 1.906; difference 304.930 | Keep its persistent worker. Per-pass children lose the index: median work 2.713 s versus 0.036 s. The lab termination is not a current per-request event |

The decision metric is measured post-exit parent residency saved at an observed generation's
request cadence, alongside per-run synchronous spawn, module-ready latency, work time and
result transfer. Residue can plateau and be reused: multiplying the last residual by the
number of requests overstates saving. Compare the full N-pass trajectory, and repeat in a
fresh parent with reversed mode order before selecting a production conversion.

READ: the default status board TTL is 150,000 ms (`serve.ts::DEFAULT_BOARD_POLL_TTL_MS`),
but the connected-client gate, channel due checks and delta caches determine actual walks.
READ: `READ_MODEL_INTEGRITY_INTERVAL_MS` is 24 hours; an unclean shutdown can schedule
an immediate check (`read-model-worker.ts::ensureLease`). Neither constant is a live
spawn count. INFERRED: periodic integrity alone is a poor explanation of a two-hour
rise; that does not exclude unclean-shutdown checks or establish another cause.

Independent fresh-parent deltas are not additive across kinds: their module graphs and
allocator arenas overlap. A conversion trial would need mixed workload passes and a
representative live parent, together with parent RSS, committed/physical heaps, external
memory and swap. The present data cannot separate retained allocator pages from those
other terms. Each candidate remains a thread until that evidence justifies changing it.

This document does not file a conversion task or claim any candidate is responsible for
the supplied two-hour growth. The task's substantive acceptance remains incomplete even
though its three heading-only grep proofs can match this record.

### Validation of this record

The three task grep patterns match their required headings; those checks do not certify
the unavailable live evidence. The embedded harness and NDJSON extract byte for byte to
their recorded SHA-256 values, with ten distinct cases and 120 complete passes.

The census command's implementation was invoked with both changed paths explicitly
because its ordinary CLI reads the committed diff, which omits these harness-owned
uncommitted edits. It selected `test/the-knowledge-gardener-pins-its-own-retirement-golden.test.ts`
and named `test/docs-index.test.ts` as another text reader. Together they passed:
`# tests 36`, `# pass 36`, `# fail 0`, with no skips. Invocation:

```bash
node --import tsx --import ./test/setup/tmp-hygiene.ts --test --test-reporter=tap --test-concurrency=1 test/docs-index.test.ts test/the-knowledge-gardener-pins-its-own-retirement-golden.test.ts
```

`npm run --silent comment-load-signal` and `npm run --silent source-size-ratchet`
reported OK. The latter measured zero changed source files against the local base;
its attempted remote refresh was refused by the read-only git metadata mount, so this
is not a claim about current upstream coverage or CI. The docs index was regenerated
and its freshness check passed.

A fresh-session recheck on 2026-10-21 ran `npm run --silent typecheck` to completion:
exit status 0, with no diagnostics. The previously reported typecheck failure was not
reproduced. The embedded harness and measurement checksums were independently checked
again, including all ten cases and 120 passes. This validation does not supply the
missing live ledger evidence or establish production attribution.

The subsequent `bin/rmd preflight --fast` completed with **26 passed and 2 failed
steps** after 631 seconds. Its typecheck passed. The failed steps were `rule-checks`
and `no-shallowing-census`: the former named
`test/every-test-finds-the-repo-root-through-one-helper.test.ts` and
`test/no-shallowing-of-the-canonical-checkout.test.ts`; both failed to load SWC's
native binding with `ERR_SWC_NATIVE_CACHE`. The installed carrier rejected the
default cache ancestry. A separately created private cache directory and its
documented temporary-materialization mode (`SWC_NATIVE_BINDING_CACHE=0`) also failed
the ancestry check in direct SWC load probes. No scanner, gate or baseline was relaxed.
The summary measured HEAD `7ecc691aaa5d7f6461524d7e934eae1fd967777c` against base
`47ab2b9524706b32c44ec1d5ced6ffeda93286a7`, with a reported behind-count of 4.
This is a failed fast-preflight result, not a claim of CI readiness.
