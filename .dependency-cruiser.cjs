/**
 * Architecture fitness rules (MASTER-PLAN §5 TIER 3, W1-T26).
 *
 * The games' purity gates ("src/game imports no Three.js") generalized into a
 * declarable layering rule for remudero: `src/lib` is the reusable core and
 * must not import the CLI entrypoint or the scratch spike script. A violation
 * makes CI red — see the `depcruise` job in `.github/workflows/ci.yml` and the
 * falsifier fixture in `test/architecture-fitness.test.ts` (a planted violation
 * proves the rule is ACTIVE, not merely declared).
 *
 * @type {import('dependency-cruiser').IConfiguration}
 */
module.exports = {
  forbidden: [
    {
      name: "lib-no-spike-or-cli",
      severity: "error",
      comment:
        "src/lib is the reusable core; it must not import the CLI entrypoint " +
        "(src/run-task.ts), the scratch spike script (src/spike.ts), or anything " +
        "under src/cli/. Layering runs one way: CLI/spike may depend on lib, never " +
        "the reverse. W1-T2883: src/cli/ does not exist yet — the run-task.ts " +
        "decomposition chain creates it — and the boundary is pre-declared so the " +
        "FIRST file to land there is already inside the rule rather than needing a " +
        "second PR to notice it.",
      from: { path: "^src/lib" },
      to: { path: "^src/(spike|run-task)\\.ts$|^src/cli/" },
    },
    {
      // WHY `error` NOW, 2026-09-08 (W1-T2895). This rule ran as `warn` from its introduction
      // (thirteen tolerated cycles, `scripts/cycle-baseline.json`'s prior `maxCycles: 13`) until
      // this task cut every one of them: six single-symbol edges each moved to a leaf module
      // (`isInPlanScope`, `ghJson`, `readLedgerLines`, `playwrightCacheRoot`, `utcWeekWindowMs`,
      // `DEFAULT_POLL_INTERVAL_MS`) plus one `import type { BoardDeps }` edge that dependency-
      // cruiser's `swc` parser counted as circular exactly like a value import. `npm run
      // cycle-ratchet -- --print` reports 0 at this sha, so `error` no longer turns a REQUIRED
      // check red over pre-existing structure — it holds the zero rather than merely observing
      // whatever count exists. `scripts/cycle-ratchet.mjs` still separately ratchets the COUNT
      // (net growth only); this rule is the hard floor under it.
      name: "no-circular",
      severity: "error",
      comment:
        "A cycle between modules makes load order significant and blocks extraction: neither " +
        "end can move without the other. Zero tolerated as of W1-T2895 — see the severity note above.",
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: {
      path: "node_modules",
    },
    // Parse with swc, not the `typescript` compiler API: dependency-cruiser's
    // tsc-based extractor only supports typescript >=2 <7, and this repo runs
    // typescript@7 (src/lib/config.ts et al target ES2022/nodenext). swc has
    // no such ceiling, so it — not the project's own tsc version — drives
    // extraction here.
    parser: "swc",
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default"],
    },
  },
};
