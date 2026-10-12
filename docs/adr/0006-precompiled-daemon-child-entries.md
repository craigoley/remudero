# 0006. Run daemon children from a precompiled, source-keyed bundle, not tsx

Status: Proposed
Date: 2026-10-10

## Context

Daemon children run the tree's own entry. `src/lib/plan-pr-emitter.ts` builds
`["--import", "tsx", RUN_TASK_ENTRY, "check-proof", …]` (`checkProofArgv`)
and runs it with `cwd` set to a worktree. The garden and preflight children
start `node --import tsx src/run-task.ts …` the same way. tsx keys its
transform cache on the **absolute source path**. The daemon cuts a fresh
worktree for each garden pass, preflight and build, so the common case is a
cold cache. The operator session's measurements (2026-10-10) for the same
source:

| run | peak RSS | cache writes |
| --- | --- | --- |
| tsx, cold (new worktree path) | 519 MB | 474 |
| tsx, warm | 284 MB | 0 |
| esbuild bundle of `src/run-task.ts` | 173–182 MB | 0 |

That comes to about 700 MB/h of path-keyed cache churn. This PR's worktree
reproduced the gap for `run-task --help`: the bundle peaked at 171 MB in
0.9 s, and tsx cold peaked at 525 MB in 5.7 s.

This is a one-way door for three reasons. Once a spawn site runs a bundle,
every module's path derivation, the main-module guard and every worker-thread
entry depend on how the bundle maps them. A stale bundle runs code that no
longer exists in the tree it was started in. The image's build also starts
requiring a bundling step that has to succeed (it is the operator's baked
path, `acr-build.yml`). W1-T5724 (iii)'s single persistent tsx cache doesn't
fix this: a cache keyed on the absolute path still misses in every new
worktree.

## Decision

Bundle daemon child entries with the esbuild that tsx already installs. Key
each bundle to a content hash of the source it was built from. A spawn site
runs a bundle only when that hash equals the hash of the tree it is spawning
into, and falls back to `node --import tsx <source>` otherwise. This task
ships the build (`scripts/build-child-entries.mjs`) and the image step. **No
spawn site switches in this task.**

The parts of the decision:

1. **Order of entries.** First comes W1-T7728's narrow check-proof entry
   (`src/check-proof-main.ts`), once it lands. It has about 52 modules and
   starts no worker thread, and the plan-PR preflight spawns one per body
   proof. Then come the garden and preflight children, which today run
   `src/run-task.ts` with a verb. `CHILD_ENTRIES` declares `src/run-task.ts`
   now because it is the entry those children already use. The check-proof
   entry is added to `CHILD_ENTRIES` in the same PR that creates it. The
   daemon and serve parents stay on tsx: they own the read plane, the read
   models and the slow lane.
2. **The `import.meta.url` modules** (`grep -rln "import\.meta\.url" src`:
   42 when the task was filed, 45 at this record's base). No module is kept
   external, so a module added later needs no list entry. An esbuild `onLoad` plugin gives every
   first-party module a module-scoped constant equal to the URL of **its own
   source file**, resolved relative to the bundle (`new URL("../../src/lib/x.ts",
   <bundle url>)`). `define` binds `import.meta.url` to that constant
   lexically, so string literals that merely contain the text stay
   unchanged. Every repo-root, script and worker path therefore resolves to
   the same file it resolves to under tsx, inside the tree that holds the
   bundle. The bundle must live at `<tree>/dist/child-entries/` (gitignored
   `dist/`). Bare imports are left external (`packages: "external"`), so
   `<tree>/node_modules` resolves them exactly as it does today.
3. **The main-module guard.** The bundle's banner sets `process.argv[1]` to
   the source entry's path. `src/run-task.ts`'s
   `fileURLToPath(import.meta.url) === process.argv[1]` then holds as it
   does under tsx. Any `argv[1]` reader sees the child as if it had been
   started on its source.
4. **Worker-thread entries.** Under the bundle, a worker started from a
   module's own URL (`new Worker(new URL(import.meta.url))`, or a `workerUrl`
   parameter defaulting to it) resolves to the module's `.ts` source, as
   before. At this record's base that covers read-model-worker.ts,
   read-model-slow-lane.ts, status.ts, board-worker.ts, ledger-union.ts,
   console-projection-worker.ts, config-gardener.ts and serve-plan-reload.ts;
   repo-dashboard-route.ts and secret-boundary.ts start workers from a URL
   their caller passes in (`grep -rln "new Worker(" src`). A bundled process has no
   tsx loader, so it cannot start such a worker as-is. The read plane already
   loads `src/run-task.ts` through a tsx-registering eval bootstrap
   (`src/lib/read-plane.ts`), so it is unaffected. Phase one therefore bundles
   only children that start no self-URL worker. The task that switches an
   entry must show that its verb starts none, or must route its workers
   through that same bootstrap. Emitting worker entries as their own bundles,
   located through the manifest, is a follow-up (below). Relying on Node's
   native type stripping was rejected: it does not cover every TypeScript
   form the tree uses, and it would make the worker path depend on the Node
   pin.
5. **Keying and fallback.** `sourceHash(root)` is a sha256 over:
   - every file under `src/`, as relative path plus bytes;
   - `package-lock.json`, `package.json` and `tsconfig.json`;
   - the recipe version (`RECIPE_VERSION`) and the esbuild version.

   The absolute path never enters the hash, so every worktree holding the
   same source shares one key. That is exactly what tsx's cache lacks. The
   build writes `dist/child-entries/manifest.json` (`sourceHash`, `entries[]`)
   last, removes the old manifest first, and refuses to write one if `src/`
   changed during the build. `childEntryIsCurrent(root, name)` returns
   `current: true` only when the manifest, the entry and the bundle all exist
   and the hash matches. Any doubt (`no-manifest`, `entry-not-built`,
   `bundle-missing`, `source-changed`) means the tsx fallback runs. A
   worktree on a newer main therefore never runs a stale bundle. The check
   costs about 180–330 ms on this tree (496 files, 19 MB), against about 5 s
   for a cold tsx start. Any change to the bundling recipe must bump
   `RECIPE_VERSION`.
6. **The image.** `deploy/Dockerfile` runs `node scripts/build-child-entries.mjs`
   right after `COPY . .` and before `USER node`, then hands `dist/` to
   `node`. A failed build prints `BUILD ASSERTION FAILED (W1-T7729)` and
   exits 1, so the image build fails loudly. The image therefore ships
   bundles keyed to its own source.
7. **Baked runtime inputs.** The script does **not** belong in
   `src/lib/baked-runtime-inputs.ts` (`BAKED_RUNTIME_SOURCE_PATHS`). That
   list names source the image-resident serve supervisor *executes*, and the
   supervisor never runs this script. The script does not belong in
   `acr-build.yml`'s `paths:` list either. That list names inputs whose
   change makes a running image wrong. A change here cannot do that: the
   recipe and esbuild versions are part of the key, so an older image's
   bundles stop matching a tree built by a newer recipe and the tsx fallback
   runs. `src/` itself is likewise not in that list. `deploy/Dockerfile` is
   in it, so this PR's step triggers its own rebuild.

## Consequences

- A child can run under plain `node` with no tsx loader and no cache writes,
  roughly halving its peak RSS against a warm tsx run and cutting it by about
  two thirds against a cold one.
- The image build takes about a second longer and adds a ~9 MB bundle. If
  bundling fails, the image fails, which is the intent.
- The bundle depends on its location: it resolves source and `node_modules`
  relative to `<tree>/dist/child-entries/`. Moving a bundle out of its tree
  breaks it. The hash check catches a moved manifest but not a hand-copied
  bundle.
- Code that branches on its own extension (for example run-task.ts's
  `measurement-cadence-child${import.meta.url.endsWith(".ts") ? ".ts" : ".js"}`)
  still sees `.ts` and picks the source path. That is correct: the child it
  starts keeps its own loader.
- A fresh worktree has no `dist/`, so until the shared store below exists,
  only children whose tree matches a built tree (the image's `/app`, or a
  tree that ran the build) benefit. Everything else falls back to tsx, which
  is today's behaviour, so this step costs nothing in correctness.
- Follow-up tasks this record files:
  - switch the check-proof spawn sites (`checkProofChildArgv`, W1-T7728) to
    the bundle when `childEntryIsCurrent` holds, with tsx as the fallback;
  - a hash-addressed bundle store shared by all worktrees at one source hash.
    It would be built once per main revision by the daemon, with the tree
    root passed in rather than taken from the bundle's location;
  - emit the worker-thread entries (read models, slow lane, status, board)
    as their own bundles, located through the manifest, before any parent
    that starts them is bundled;
  - switch the garden and preflight children once their verbs are shown to
    start no self-URL worker.
