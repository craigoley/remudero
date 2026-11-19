import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import v8 from "node:v8";
import {
  parseSync,
  type CallExpression,
  type Expression,
  type FunctionDeclaration,
  type Identifier,
  type Node,
  type VariableDeclaration,
} from "@swc/core";
// Load the cache first so its circular import can read the daemon's initialized constants.
import "#src/lib/live-analytics-snapshot-cache.js";
import { runDaemon } from "#src/lib/daemon.js";
import { mergePlanBlobs } from "#src/lib/plan.js";
import { hostIndependentDaemonDeps } from "#test/helpers/daemon-host-pins.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

test("W1-T12163 criterion 1: the helper pins all four dependencies for each run", () => {
  const first = hostIndependentDaemonDeps();
  const second = hostIndependentDaemonDeps();
  const initial = first.memoryGovernor.step();
  assert.equal(initial.tier, "clear");
  assert.equal(initial.reading.rss_bytes, 1);
  assert.equal(initial.initialReading, true);
  assert.equal(first.memoryGovernor.step().initialReading, false);
  assert.deepEqual(second.memoryGovernor.step(), initial);
  assert.deepEqual(first.heapStatistics(), { used_heap_size: 1, heap_size_limit: 1_000_000_000 });
  assert.equal(first.now().toISOString(), "2026-01-01T00:00:00.000Z");
  assert.equal(first.bootCheckoutBlocked, "");
});

test("W1-T12163 criterion 2: changing host memory leaves the entire daemon ledger equal", async (t) => {
  const reads: string[] = [];
  const mib = 1024 * 1024;
  let pressured = false;
  const rssBytes = () => (pressured ? 380 : 40) * mib;
  const heapUsed = () => (pressured ? 95 : 5) * mib;
  const memoryUsage = t.mock.method(process, "memoryUsage", () => {
    reads.push("process.memoryUsage");
    return { rss: rssBytes(), heapTotal: 100 * mib, heapUsed: heapUsed(), external: 0, arrayBuffers: 0 };
  });
  Object.assign(memoryUsage, { rss: () => {
    reads.push("process.memoryUsage.rss");
    return rssBytes();
  } });
  const realRead = fs.readFileSync as (...args: unknown[]) => unknown;
  t.mock.method(fs, "readFileSync", ((...args: unknown[]) => {
    const path = String(args[0]);
    switch (path) {
      case "/proc/self/status":
        reads.push(path);
        return `VmSwap:\t${pressured ? 64 * 1024 : 0} kB\n`;
      case "/sys/fs/cgroup/memory.high":
        reads.push(path);
        return pressured ? String(400 * mib) : "max";
      case "/sys/fs/cgroup/memory.max":
        reads.push(path);
        return String((pressured ? 500 : 1024) * mib);
      default:
        return realRead(...args);
    }
  }) as typeof fs.readFileSync);
  t.mock.method(v8, "getHeapStatistics", () => {
    reads.push("v8.getHeapStatistics");
    return { used_heap_size: heapUsed(), heap_size_limit: 100 * mib };
  });
  syncBuiltinESMExports();
  try {
    const ledgers: Array<Array<[string, Record<string, unknown>]>> = [];
    for (const highPressure of [false, true]) {
      pressured = highPressure;
      const plan = mergePlanBlobs([{
        label: "fixture.yaml",
        text: "- id: A\n  title: a\n  repo: remudero\n  type: implement\n  status: queued\n",
      }]);
      const ledger: Array<[string, Record<string, unknown>]> = [];
      const summary = await runDaemon(plan, {
        ...hostIndependentDaemonDeps(),
        targetRepo: "remudero",
        refreshMerged: () => () => false,
        runOne: async (id) => ({ taskId: id, runId: `${id}-run`, merged: true, costUsd: 0, verdict: "merged" }),
        sleep: async () => {},
        log: (step, fields = {}) => ledger.push([step, fields]),
      }, { max: 1 });
      assert.deepEqual(summary.merged, ["A"]);
      assert.equal(summary.stopReason, "max_reached");
      assert.ok(ledger.some(([step, fields]) => step === "dispatch.pick_scored" && fields.task === "A"));
      ledgers.push(ledger);
    }
    assert.deepEqual(ledgers[1], ledgers[0]);
    assert.deepEqual(reads, [], "the daemon must bypass process, proc, cgroup and V8 memory readings");
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

// An absent property leaves earlier spreads intact. A nullish value restores the default governor.
type GovernorPin = boolean | undefined;

function bindingKey(identifier: Identifier): string {
  // SWC assigns a syntax context to each binding so same-named fixtures in separate tests stay distinct.
  const { value, ctxt } = identifier as Identifier & { ctxt?: number };
  return `${ctxt}:${value}`;
}

function unwrapExpression(expression: Expression): Expression {
  switch (expression.type) {
    case "ParenthesisExpression":
    case "TsAsExpression":
    case "TsSatisfiesExpression":
    case "TsNonNullExpression":
    case "TsTypeAssertion":
    case "TsConstAssertion":
      return unwrapExpression(expression.expression);
    default:
      return expression;
  }
}

function usesUnpinnedDaemon(text: string): boolean {
  if (!text.includes("runDaemon")) return false;
  const tree = parseSync(text, { syntax: "typescript", decorators: true });
  const importedNames = new Map<string, string>();
  for (const statement of tree.body) {
    if (statement.type !== "ImportDeclaration") continue;
    for (const specifier of statement.specifiers) {
      if (specifier.type === "ImportSpecifier") {
        importedNames.set(bindingKey(specifier.local), specifier.imported?.value ?? specifier.local.value);
      }
    }
  }

  const calls: CallExpression[] = [];
  const bindings = new Map<string, Expression | FunctionDeclaration>();
  function visit(value: unknown): void {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") return;
    const node = value as Node;
    if (node.type === "CallExpression") calls.push(node as CallExpression);
    if (node.type === "VariableDeclaration" && (node as VariableDeclaration).kind === "const") {
      for (const { id, init } of (node as VariableDeclaration).declarations) {
        if (id.type === "Identifier" && init) bindings.set(bindingKey(id), init);
        if (id.type === "ObjectPattern" && init) {
          const initializer = resolveConst(init);
          const imported = initializer.type === "AwaitExpression" ? initializer.argument : initializer;
          if (imported.type === "CallExpression" && imported.callee.type === "Import") {
            for (const property of id.properties) {
              if (property.type !== "KeyValuePatternProperty") continue;
              const { key, value } = property;
              if ((key.type === "Identifier" || key.type === "StringLiteral") &&
                key.value === "runDaemon" && value.type === "Identifier") {
                importedNames.set(bindingKey(value), "runDaemon");
              }
            }
          }
        }
      }
    }
    if (node.type === "FunctionDeclaration") {
      const fn = node as FunctionDeclaration;
      bindings.set(bindingKey(fn.identifier), fn);
    }
    Object.values(node).forEach(visit);
  }
  visit(tree);

  function resolveConst(expression: Expression): Expression {
    let value = unwrapExpression(expression);
    const seen = new Set<string>();
    while (value.type === "Identifier") {
      const key = bindingKey(value);
      const binding = bindings.get(key);
      if (!binding || binding.type === "FunctionDeclaration" || seen.has(key)) break;
      seen.add(key);
      value = unwrapExpression(binding);
    }
    return value;
  }

  function isDaemonCall({ callee }: CallExpression): boolean {
    if (callee.type === "Super" || callee.type === "Import") return false;
    const target = resolveConst(callee);
    if (target.type === "Identifier") {
      return (importedNames.get(bindingKey(target)) ?? target.value) === "runDaemon";
    }
    if (target.type !== "MemberExpression") return false;
    const property = target.property.type === "Computed" ? target.property.expression : target.property;
    return (property.type === "Identifier" || property.type === "StringLiteral") && property.value === "runDaemon";
  }

  function suppliesGovernor(expression: Expression, nullishParameters: ReadonlyMap<string, boolean> = new Map()): boolean {
    const value = resolveConst(expression);
    if (value.type === "Identifier" && nullishParameters.has(bindingKey(value))) {
      return !nullishParameters.get(bindingKey(value));
    }
    if (value.type === "CallExpression" && value.callee.type === "MemberExpression" &&
      value.callee.property.type === "Identifier" && value.callee.property.value === "get") {
      const map = resolveConst(value.callee.object);
      if (map.type === "NewExpression" && map.callee.type === "Identifier" && map.callee.value === "Map" &&
        map.arguments?.length === 0) {
        const hasWrite = calls.some((call) => call.callee.type === "MemberExpression" &&
          call.callee.property.type === "Identifier" && call.callee.property.value === "set" &&
          resolveConst(call.callee.object) === map);
        if (!hasWrite) return false;
      }
    }
    return value.type !== "NullLiteral" &&
      !(value.type === "Identifier" && value.value === "undefined") &&
      !(value.type === "UnaryExpression" && value.operator === "void");
  }

  const resolving = new Set<Expression>();
  function governorIn(
    deps: Expression | undefined,
    parameters: ReadonlyMap<string, GovernorPin>,
    nullishParameters: ReadonlyMap<string, boolean> = new Map(),
  ): GovernorPin {
    if (!deps || resolving.has(deps)) return undefined;
    resolving.add(deps);
    try {
      return resolveGovernor(unwrapExpression(deps), parameters, nullishParameters);
    } finally {
      resolving.delete(deps);
    }
  }

  // Follow dependency object literals, const bindings and simple local factories.
  function resolveGovernor(
    deps: Expression,
    parameters: ReadonlyMap<string, GovernorPin>,
    nullishParameters: ReadonlyMap<string, boolean>,
  ): GovernorPin {
    switch (deps.type) {
      case "Identifier": {
        const key = bindingKey(deps);
        if (parameters.has(key)) return parameters.get(key);
        const binding = bindings.get(key);
        return binding?.type === "FunctionDeclaration" ? undefined : governorIn(binding, parameters, nullishParameters);
      }
      case "ObjectExpression": {
        let pin: GovernorPin;
        for (const property of deps.properties) {
          if (property.type === "SpreadElement") {
            pin = governorIn(property.arguments, parameters, nullishParameters) ?? pin;
          } else if (property.type === "Identifier" && property.value === "memoryGovernor") {
            pin = suppliesGovernor(property, nullishParameters);
          } else if (property.type === "KeyValueProperty" &&
            (property.key.type === "Identifier" || property.key.type === "StringLiteral") &&
            property.key.value === "memoryGovernor") {
            pin = suppliesGovernor(property.value, nullishParameters);
          }
        }
        return pin;
      }
      case "CallExpression": {
        if (deps.callee.type !== "Identifier") return undefined;
        const key = bindingKey(deps.callee);
        if (importedNames.get(key) === "hostIndependentDaemonDeps") return true;
        const factory = bindings.get(key);
        if (factory?.type !== "FunctionDeclaration" && factory?.type !== "ArrowFunctionExpression") return undefined;
        const body = factory.body;
        if (!body || deps.arguments.some((arg) => arg.spread)) return undefined;
        // SWC emits a FunctionBody for declarations and a BlockStatement for block-bodied arrows.
        const last = "stmts" in body ? body.stmts.at(-1) : undefined;
        const result = "stmts" in body ? (last?.type === "ReturnStatement" ? last.argument : undefined) : body;
        const locals = new Map(parameters);
        const nullishLocals = new Map(nullishParameters);
        factory.params.forEach((parameter, index) => {
          const pattern = parameter.type === "Parameter" ? parameter.pat : parameter;
          if (pattern.type === "Identifier") {
            const argument = deps.arguments[index]?.expression;
            locals.set(bindingKey(pattern), governorIn(argument, parameters, nullishParameters));
            nullishLocals.set(bindingKey(pattern), argument === undefined || !suppliesGovernor(argument, nullishParameters));
          }
        });
        return governorIn(result, locals, nullishLocals);
      }
      default:
        return undefined;
    }
  }

  return calls.some((call) => {
    if (!isDaemonCall(call)) return false;
    const args = call.arguments;
    return args.slice(0, 2).some((arg) => arg.spread) || governorIn(args[1]?.expression, new Map()) !== true;
  });
}

test("the daemon memory census checks the dependencies of every call", () => {
  const fixture = `
    import { runDaemon as loop } from "#src/lib/daemon.js";
    import { hostIndependentDaemonDeps as pins } from "#test/helpers/daemon-host-pins.js";
    const pinned = { ...pins() };
    function deps(overrides) { return { ...overrides }; }
  `;
  const pinnedCalls = `
    loop(plan, pinned);
    loop(plan, deps({ memoryGovernor: governor }));
  `;
  assert.equal(usesUnpinnedDaemon(fixture + pinnedCalls), false);
  assert.equal(usesUnpinnedDaemon(fixture + pinnedCalls + "loop(plan, deps({}));"), true);
  assert.equal(usesUnpinnedDaemon(fixture + "loop(plan, deps({}));" + pinnedCalls), true);
  assert.equal(usesUnpinnedDaemon(fixture + "loop(plan, { nested: { memoryGovernor: governor } });"), true);
  assert.equal(usesUnpinnedDaemon(fixture + "loop(plan, { ...pinned, memoryGovernor: undefined });"), true);
});

test("the daemon memory census counts an unpinned call through a local alias", () => {
  const fixture = `
    import { runDaemon as daemonLoop } from "#src/lib/daemon.js";
    import { hostIndependentDaemonDeps } from "#test/helpers/daemon-host-pins.js";
    const loop = daemonLoop;
  `;
  assert.equal(usesUnpinnedDaemon(fixture + "loop(plan, hostIndependentDaemonDeps());"), false);
  assert.equal(usesUnpinnedDaemon(fixture + "loop(plan, {});"), true);
  assert.equal(usesUnpinnedDaemon(fixture + "const run = (loop); run(plan, {});"), true);
  assert.equal(usesUnpinnedDaemon(fixture + "{ const loop = () => {}; loop(plan, {}); }"), false);
});

test("the daemon memory census counts a destructured dynamic-import alias", () => {
  const fixture = `
    import { hostIndependentDaemonDeps } from "#test/helpers/daemon-host-pins.js";
    async function invoke() {
      const { runDaemon: loop } = await import("#src/lib/daemon.js");
      loop(plan, {});
    }
  `;
  assert.equal(usesUnpinnedDaemon(fixture), true);
  assert.equal(usesUnpinnedDaemon(fixture.replaceAll("plan, {}", "plan, hostIndependentDaemonDeps()")), false);
  const throughModuleVariable = fixture.replace(
    "const { runDaemon: loop } = await import(\"#src/lib/daemon.js\");",
    "const daemon = await import(\"#src/lib/daemon.js\"); const { runDaemon: loop } = daemon;",
  );
  assert.equal(usesUnpinnedDaemon(throughModuleVariable), true);
  assert.equal(usesUnpinnedDaemon(throughModuleVariable.replaceAll("plan, {}", "plan, hostIndependentDaemonDeps()")), false);
});

test("the daemon memory census counts a computed daemon property", () => {
  const fixture = `
    import { hostIndependentDaemonDeps } from "#test/helpers/daemon-host-pins.js";
    async function invoke() {
      const daemon = await import("#src/lib/daemon.js");
      daemon["runDaemon"](plan, {});
    }
  `;
  assert.equal(usesUnpinnedDaemon(fixture), true);
  assert.equal(usesUnpinnedDaemon(fixture.replace("plan, {}", "plan, hostIndependentDaemonDeps()")), false);
});

test("the daemon memory census treats an empty Map lookup as an absent governor", () => {
  const fixture = `
    import { runDaemon } from "#src/lib/daemon.js";
    const governors = new Map();
  `;
  assert.equal(usesUnpinnedDaemon(fixture + 'runDaemon(plan, { memoryGovernor: governors.get("daemon") });'), true);
  assert.equal(usesUnpinnedDaemon(fixture + 'governors.set("daemon", governor); runDaemon(plan, { memoryGovernor: governors.get("daemon") });'), false);
});

test("the daemon memory census counts a nullish shorthand governor even after a pin", () => {
  const fixture = `
    import { runDaemon } from "#src/lib/daemon.js";
    import { hostIndependentDaemonDeps } from "#test/helpers/daemon-host-pins.js";
  `;
  const call = "runDaemon(plan, { ...hostIndependentDaemonDeps(), memoryGovernor });";
  assert.equal(usesUnpinnedDaemon(fixture + "const memoryGovernor = undefined;" + call), true);
  assert.equal(usesUnpinnedDaemon(fixture + "const absent = (void 0); const memoryGovernor = absent;" + call), true);
  assert.equal(usesUnpinnedDaemon(fixture + "const memoryGovernor = null;" + call), true);
  assert.equal(usesUnpinnedDaemon(fixture + "const memoryGovernor = fakeGovernor();" + call), false);
});

test("the daemon memory census counts an omitted optional governor factory parameter", () => {
  const fixture = `
    import { runDaemon } from "#src/lib/daemon.js";
    function daemonDeps(memoryGovernor?) { return { memoryGovernor }; }
  `;
  assert.equal(usesUnpinnedDaemon(fixture + "runDaemon(plan, daemonDeps());"), true);
  assert.equal(usesUnpinnedDaemon(fixture + "runDaemon(plan, daemonDeps(undefined));"), true);
  assert.equal(usesUnpinnedDaemon(fixture + "const governor = {}; runDaemon(plan, daemonDeps(governor));"), false);
});

// @source-text-subject: test/**/*.test.ts — use of the daemon's memory seams.
// @census-reads: test/**/*.test.ts
test("W1-T12163 criterion 3: the number of test files without daemon memory pins only goes down", () => {
  // Measured per call after the W1-T12163 migrations on 2026-11-19.
  const baseline = 230;
  const testRoot = join(REPO_ROOT, "test");
  const mixedDaemonFile = fs.readFileSync(join(testRoot, "heavy-new-build-admission.test.ts"), "utf8");
  assert.equal(usesUnpinnedDaemon(mixedDaemonFile), true,
    "a memory pin on one runDaemon call must not hide another unpinned call in the same file");
  const unpinned = fs.globSync("**/*.test.ts", { cwd: testRoot })
    .filter((file) => usesUnpinnedDaemon(fs.readFileSync(join(testRoot, file), "utf8")))
    .sort();
  assert.ok(unpinned.length <= baseline,
    `Found ${unpinned.length} daemon test files without memory pins (baseline ${baseline}):\n${unpinned.join("\n")}`);
});
