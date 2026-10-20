# 0008. Start the daemon's own main from the precompiled bundle, keeping source maps on through a linked map

Status: Accepted
Date: 2026-10-20

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

Measured offline on 2026-10-20 (node 24.21.0, tsx 4.23.15), in processes the builder started itself, n=3 interleaved.
Each process loaded `src/run-task.ts`'s whole static graph, which includes the daemon command, and exited through
`inspect --help`. Raw rows are in logs-8864/bundlemain-measure.jsonl.

| entry | RSS after load | heap after GC | after one formatted stack | load to exit |
|---|---|---|---|---|
| tsx CLI (today), child process | 498-596 MiB | 105 MiB | heap 121 MiB (2 maps) | 5.9-6.6 s warm, 34.7 s cold |
| bundle, `node --enable-source-maps` | 198-204 MiB | 43 MiB | RSS 348-351 MiB, heap 188 MiB (1 map) | 0.8-0.9 s |
| bundle with `--import tsx` beside it | 956-958 MiB | 188 MiB | heap 718 MiB | 3.3-3.6 s |

Parsing every map the process could reach: 616-622 MiB RSS and 251 MiB heap under tsx (626 maps), against 364-367 MiB
and 203 MiB for the bundle (102 maps: the bundle's one, plus node_modules' own).

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

- OBSERVED offline: about 300 MiB less RSS at load per daemon (198 against about 530), and about 150-250 MiB less once
  stacks are formatted. Boot loads in under a second, against 6 s warm and 35 s cold. No tsx CLI parent process or
  esbuild service sits beside the daemon. INFERRED for the fleet until `daemon.memory` and `daemon.alive` rows confirm
  it per `boot_head_sha`: the three daemons on one host would save about 0.5-0.9 GiB.
- The bundle's map is ONE map. The first stack formatted through any bundled frame parses all of it: +145 MiB of heap,
  OBSERVED. Under tsx the cost grew per module touched, up to 146 MiB for all 626. `daemon.memory`'s
  `source_maps.parsed` (W1-T9822) counts this as 1. Its per-map calibration (240,549 B, measured on per-module maps)
  therefore under-sizes the bundle's map, and a follow-up should size it by the map's own bytes.
- A boot whose tree has no current build spends about 5.4 s and about 264 MiB peak in esbuild before the daemon
  starts (OBSERVED, `--main-entry` cold build). A tree with a current build spends about 0.1-0.8 s hashing.
- Rollback is a revert of bin/rmd. It takes effect at each daemon's next start, and no bundle needs deleting. The
  per-tree `main-entry.off` file needs no deploy.
