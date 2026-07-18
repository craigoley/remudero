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
