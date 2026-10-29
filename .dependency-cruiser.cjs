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
      name: "cli-no-run-task",
      severity: "error",
      comment:
        "src/cli/ must never import the CLI entrypoint (src/run-task.ts). A verb module " +
        "receives what it needs from run-task.ts through a host parameter that the HANDLERS " +
        "entry supplies, never through an import, because that import is a cycle with " +
        "HANDLERS (which imports the module back) and a top-level const in the cycle reads " +
        "as a TDZ error at load. W1-T9331.",
      from: { path: "^src/cli/" },
      to: { path: "^src/run-task\\.ts$" },
    },
    {
      name: "drafter-never-sees-held-out-set",
      severity: "error",
      comment:
        "A skill draft is judged on held-out merged tasks (src/lib/skill-eval.ts, drawn from " +
        "src/lib/golden-corpus.ts). The drafter must never be able to read that set, or it can " +
        "tune the draft to it. Falsifier: test/a-skill-draft-is-judged-on-tasks-it-never-saw.test.ts.",
      from: { path: "^src/lib/(skill-workshop|workflow-mining)\\.ts$" },
      to: { path: "^src/lib/(skill-eval|golden-corpus)\\.ts$" },
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
    // extraction here. The parser setting silently requires the @swc/core npm
    // package even though no src file imports it.
    parser: "swc",
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default"],
    },
  },
};

/**
 * Repository integration for dependency-cruiser 18.6.0's extraction lifecycle.
 * Its ordinary extractor keeps every AST until the entire traversal finishes.
 * Run that extractor once per file (depth one), retaining only its root record;
 * follow every resolved edge here, then analyze the COMPLETE graph once. This
 * bounds AST retention to one file without changing SWC, resolution or rules.
 * Internal entry points are version-pinned and checked against native graphs.
 * Requiring this file as a config still returns only the configuration above.
 */
async function scanArchitecture() {
  const { dirname, join } = require("node:path");
  const { pathToFileURL } = require("node:url");
  const { findPackageJSON } = require("node:module");
  const { parseArgs } = require("node:util");
  const { values, positionals } = parseArgs({
    options: { "output-type": { type: "string", default: "err" } },
    allowPositionals: true,
  });
  const root = dirname(findPackageJSON("dependency-cruiser", pathToFileURL(__filename)));
  const version = require(join(root, "package.json")).version;
  if (version !== "18.6.0") {
    throw new Error(`Architecture integration requires dependency-cruiser 18.6.0; found ${version}`);
  }
  // dependency-cruiser swallows a missing SWC binding and silently uses Acorn.
  // Load the configured parser explicitly so that cannot produce a green scan.
  require("@swc/core");
  const load = (path) => import(pathToFileURL(join(root, "src", path)).href);
  const [
    { assertCruiseOptionsValid }, { normalizeCruiseOptions },
    { default: normalizeRuleSet }, { default: assertRuleSetValid },
    { default: normalizeFiles }, { default: normalizeResolveOptions },
    { default: gather }, { default: extract }, { default: analyze }, { default: reportWrap },
  ] = await Promise.all([
    load("main/options/assert-validity.mjs"), load("main/options/normalize.mjs"),
    load("main/rule-set/normalize.mjs"), load("main/rule-set/assert-validity.mjs"),
    load("main/files-and-dirs/normalize.mjs"), load("main/resolve-options/normalize.mjs"),
    load("extract/gather-initial-sources.mjs"), load("extract/index.mjs"),
    load("analyze/index.mjs"), load("main/report-wrap.mjs"),
  ]);
  const files = normalizeFiles(positionals.length ? positionals : ["src"]);
  const options = normalizeCruiseOptions(assertCruiseOptionsValid({
    ruleSet: module.exports, validate: true, outputType: values["output-type"],
  }), files);
  options.ruleSet = normalizeRuleSet(assertRuleSetValid(options.ruleSet));
  const resolveOptions = await normalizeResolveOptions(undefined, options);
  const pending = gather(files, options).reverse();
  const visited = new Set();
  const extracted = [];
  while (pending.length) {
    const source = pending.pop();
    if (visited.has(source)) continue;
    visited.add(source);
    // extract() clears its parser caches before AND after each call. Depth-one
    // child records contain no dependencies and are replaced by their own scan.
    const record = extract([source], { ...options, maxDepth: 1 }, resolveOptions)
      .find((entry) => entry.source === source);
    if (!record) throw new Error(`Architecture extraction omitted ${source}`);
    extracted.push(record);
    for (const dependency of [...record.dependencies].reverse()) {
      if (dependency.followable && !dependency.matchesDoNotFollow) pending.push(dependency.resolved);
    }
  }
  // Match the native extractor's completion of external/unresolved/core nodes.
  const modules = extracted.reduce((all, record) => all.concat(record,
    record.dependencies.filter((dep) => !dep.followable && !all.some((m) => m.source === dep.resolved))
      .map((dep) => ({
        source: dep.resolved, followable: dep.followable, coreModule: dep.coreModule,
        couldNotResolve: dep.couldNotResolve, matchesDoNotFollow: dep.matchesDoNotFollow,
        dependencyTypes: dep.dependencyTypes, dependencies: [],
      }))), []);
  const report = await reportWrap(analyze(modules, options, files), options);
  process.stdout.write(report.output);
  process.stderr.write(`Architecture AST retention window: 1 file (${visited.size} files scanned)\n`);
  process.exitCode = report.exitCode;
}

if (require.main === module) {
  scanArchitecture().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
