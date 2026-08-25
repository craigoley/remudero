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
        "(src/run-task.ts) or the scratch spike script (src/spike.ts). Layering " +
        "runs one way: CLI/spike may depend on lib, never the reverse.",
      from: { path: "^src/lib" },
      to: { path: "^src/(spike|run-task)\\.ts$" },
    },
    {
      // WHY `warn` AND NOT `error`. Fifteen cycles already exist, fourteen of them entirely
      // inside `src/lib`, knotting twenty-two modules around
      // worker/worker-home/review/plan-architect/plan-pr-emitter/open-prs-rest/sweep/
      // cost-anomaly/retro/task-linter/escalate/status. `error` would turn a REQUIRED check red
      // on day one over pre-existing structure and force either a large refactor or an
      // exclusion list, and this repo ships against these files daily. `warn` makes the count
      // OBSERVABLE and stops it growing silently, which is the whole point: before this rule the
      // cruise reported "no dependency violations found" over all fifteen, because nothing asked.
      //
      // RAISING THIS TO `error` IS A SEPARATE, REVIEWED DECISION and belongs with the work that
      // actually cuts the cycles — the cheapest first cut is `open-prs-rest` <-> `sweep`, where
      // the edge one way is `import type` only and therefore erased at runtime.
      name: "no-circular",
      severity: "warn",
      comment:
        "A cycle between modules makes load order significant and blocks extraction: neither " +
        "end can move without the other. Reported, never blocking — see the severity note above.",
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
