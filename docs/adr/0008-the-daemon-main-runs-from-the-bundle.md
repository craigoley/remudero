# 0008. Start the daemon's own main from the precompiled bundle, keeping source maps on through a linked map

Status: Accepted
Date: 2026-10-20
Built in: PR 13218

## Context

[ADR 0006](0006-precompiled-daemon-child-entries.md) moved the daemon's CHILDREN to a source-keyed esbuild bundle.
Its decision 1 kept the daemon and serve parents on tsx. Decision 4 named the obstacle: a worker started from a
module's own URL resolves to its .ts source, and a bundled process has no tsx loader. W1-T8777 then gave the listed
worker modules their own bundles. Even so, `bin/rmd daemon` still ran `tsx src/run-task.ts daemon` for the core, site
and console daemons. Each paid for a tsx CLI parent process, the transform of about 800 modules, and, with maps on, a
parsed source map per module that a formatted stack touched.

The operator ruled on 2026-10-19: "Run the four daemon main processes from prebuilt bundles instead of tsx
(extending ADR 0006, the one-way door you held for W1-T9117), keeping source maps on through a linked map file?
→ Yes, build it".

Measured offline on 2026-10-20 (node 24.21.0, tsx 4.23.15), in processes the builder started itself, n=3 interleaved,
two sessions. Each process loaded `src/run-task.ts`'s whole static graph, which includes the daemon command, and
exited through `inspect --help`. Raw rows: logs-8864/bundlemain-measure.jsonl (tsx cache cold, just after `npm ci`)
and bundlemain-measure2.jsonl (tsx cache warm).

| entry | RSS after load | heap after GC | after one formatted stack | every reachable map parsed | load to exit |
|---|---|---|---|---|---|
| tsx (`node --import tsx`), cache warm | 304-307 MiB | 104 MiB | 307-309 MiB (2 maps) | 466-467 MiB, heap 250 MiB (626 maps) | 1.4-1.7 s |
| tsx, cache cold | 498-596 MiB, plus a 20 MiB esbuild child | 105 MiB | 500-597 MiB | 616-622 MiB | 5.7-6.6 s (34.7 s first) |
| bundle, `node --enable-source-maps` | 198-204 MiB | 43 MiB | 348-351 MiB, heap 188 MiB (1 map) | 364-367 MiB, heap 203 MiB (102 maps) | 0.8-0.9 s |
| bundle with `--import tsx` beside it | 954-960 MiB | 188 MiB | 1035-1047 MiB, heap 718 MiB | 1045-1057 MiB | 3.0-3.8 s |

`bin/rmd`'s tsx line also keeps a tsx CLI parent process beside the daemon: 54 MiB RSS of its own (n=3).

## Decision

1. `bin/rmd daemon` asks `scripts/build-child-entries.mjs --main-entry daemon` (`mainEntry`, plain node) which entry to
   start. It execs `node --enable-source-maps dist/child-entries/run-task.mjs daemon …` when all of these hold:
   - the bundle is current for the tree's source hash (the tree is built once first when it is not);
   - every declared worker bundle is current;
   - the linked `run-task.mjs.map` is beside it;
   - no bundled boot of this source failed before its first tick.

   On any doubt it execs today's tsx line, unchanged. The choice reaches the daemon in `RMD_MAIN_ENTRY`, and the
   daemon ledgers it as `daemon.entry.selected`.
2. Source maps stay on. The recipe (RECIPE_VERSION 5) writes a LINKED map beside each bundle, without `sourcesContent`.
3. tsx's loader is never on the bundled main's node line: beside the bundle it transforms all 12 MB of it (the third
   row above). Instead, a bundled main appends the loader to `process.execArgv` for the children it starts from a .ts
   source. The bundle banner gives the loader to any worker started from a .ts source that has no worker bundle.
   Every module that starts a worker through `startWorker`/`bundledWorkerUrl` is a WORKER_ENTRIES bundle.
4. Demotion, not a threshold. `mainEntry` writes `dist/child-entries/main-attempt.json` before a bundled start. The
   daemon settles it at its first `daemon.tick_phases`. An unsettled attempt for the same source sends the next boot to
   tsx (`demoted: …`), and a new source hash tries the bundle again. `dist/child-entries/main-entry.off` sends every
   boot of that tree to tsx.
5. Serve stays on tsx until its own change. Its supervisor and generations start through
   `src/lib/serve-supervisor.ts`, not `bin/rmd daemon`.

ADR 0006 decision 1 is superseded for the daemon verb only.

## Consequences

- OBSERVED offline, per daemon, with the 54 MiB tsx parent counted:
  - no stack formatted through the bundle: 198-204 MiB against about 360 MiB warm (about -160 MiB);
  - one stack formatted: 349 against about 361 (about -12 MiB);
  - every reachable map parsed: 365 against about 520 (about -155 MiB).

  A cold tsx cache, after any source change, peaked at 500-600 MiB. The bundle has no such peak, and it loads in
  under a second. INFERRED for the fleet until `daemon.memory` and `daemon.alive` rows confirm it per
  `boot_head_sha`: from about 0 to about 0.5 GiB across the three daemons on one host, depending on how much of
  the bundle's map their formatted stacks pull in.
- The bundle's map is ONE map, so the first stack formatted through any bundled frame parses all of it: +145 MiB of
  heap, OBSERVED. Under tsx the cost grew per module touched, up to 146 MiB for all 626. This is the price of keeping
  maps on through a linked file. `daemon.memory`'s `source_maps.parsed` (W1-T9822) counts it as 1, and its per-map
  calibration (240,549 B, measured on per-module maps) under-sizes the bundle's map. A follow-up should size a map by
  its own bytes.
- A boot whose tree has no current build spends about 5.4 s and 264 MiB peak in esbuild before the daemon starts
  (OBSERVED, `--main-entry` cold build). A boot with a current build spends 0.1-0.8 s hashing the tree.
- Rollback is a revert of bin/rmd. It takes effect at each daemon's next start, and no bundle needs deleting. The
  per-tree `dist/child-entries/main-entry.off` file is a rollback that needs no deploy.
