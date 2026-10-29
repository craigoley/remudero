import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

/**
 * W1-T9872: every tracked test file under test/ at ANY depth (relative to test/, minus test/fixtures/)
 * plus the absolute test/ directory, both resolved from the REPO ROOT that git reports for this file's
 * own folder. A readdirSync of the folder holding the suite would silently drop every file that moved
 * into a subfolder. Two independent pathspecs must agree on the count.
 */
function testCorpus(): { dir: string; files: string[] } {
  const git = (...args: string[]): string =>
    execFileSync("git", args, { cwd: fileURLToPath(new URL(".", import.meta.url)), encoding: "utf8", maxBuffer: 64 << 20 });
  const root = git("rev-parse", "--show-toplevel").trim();
  const list = (spec: string): string[] =>
    git("ls-files", "--full-name", "--", spec).split("\n").filter((f) => f.startsWith("test/") && !f.startsWith("test/fixtures/"));
  const walked = list(":(top,glob)test/**/*.test.ts");
  assert.ok(walked.length > 0, "the recursive test/ listing must find the test corpus");
  assert.equal(walked.length, list(":(top)test/*.test.ts").length, "both pathspecs must see the same population");
  return { dir: join(root, "test"), files: walked.map((f) => f.slice("test/".length)) };
}

/**
 * MASTER-PLAN §5 TIER 3 (W1-T26): "src/lib imports nothing from spike/CLI" is
 * declared in `.dependency-cruiser.cjs` as the `lib-no-spike-or-cli` rule. A
 * declared rule is not the same as an ACTIVE one — these tests are the
 * falsifier: they run the real `dependency-cruiser` integration over
 * a planted fixture and assert it exits non-zero citing the rule by name, and
 * over a clean fixture and assert it exits zero. Without this, "0 violations"
 * from a fresh gate is exactly the neon-drift `_probe(x)` trap LEARNINGS
 * warns about — suspicious until falsified, not proof of anything.
 */

const repoRoot = REPO_ROOT;
const depcruiseBin = join(repoRoot, "node_modules", ".bin", "depcruise");
const configPath = join(repoRoot, ".dependency-cruiser.cjs");

/** Runs the default architecture integration over the fixture's `src/`. Captures nonzero exits. */
function runDepcruise(fixtureRoot: string): { status: number; output: string } {
  try {
    const output = execFileSync(process.execPath, [configPath, "src"], {
      cwd: fixtureRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, output };
  } catch (err) {
    const e = err as { status?: number | null; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

/** A throwaway `src/lib`+`src/spike.ts`+`src/run-task.ts` tree, mirroring remudero's real layout. */
function buildFixture(libImport: string): string {
  const root = mkdtempSync(join(tmpdir(), "rmd-depcruise-fixture-"));
  mkdirSync(join(root, "src", "lib"), { recursive: true });
  writeFileSync(join(root, "src", "spike.ts"), `export const spikeMarker = "spike";\n`);
  writeFileSync(join(root, "src", "run-task.ts"), `export const cliMarker = "cli";\n`);
  writeFileSync(join(root, "src", "lib", "widget.ts"), libImport);
  return root;
}

test("depcruise BLOCKS a planted src/lib -> src/spike.ts import: nonzero exit, citing lib-no-spike-or-cli", () => {
  const fixture = buildFixture(
    `import { spikeMarker } from "../spike.js";\nexport const widget = spikeMarker;\n`,
  );
  const { status, output } = runDepcruise(fixture);
  assert.notEqual(status, 0, `expected a nonzero exit for a planted violation, got 0. output:\n${output}`);
  assert.match(output, /lib-no-spike-or-cli/, `expected the violation to cite the named rule. output:\n${output}`);
  assert.match(output, /src\/lib\/widget\.ts.*src\/spike\.ts/, `expected the offending edge in the output. output:\n${output}`);
});

test("depcruise BLOCKS a planted src/lib -> src/run-task.ts (CLI) import: nonzero exit, citing lib-no-spike-or-cli", () => {
  const fixture = buildFixture(
    `import { cliMarker } from "../run-task.js";\nexport const widget = cliMarker;\n`,
  );
  const { status, output } = runDepcruise(fixture);
  assert.notEqual(status, 0, `expected a nonzero exit for a planted violation, got 0. output:\n${output}`);
  assert.match(output, /lib-no-spike-or-cli/, `expected the violation to cite the named rule. output:\n${output}`);
  assert.match(output, /src\/lib\/widget\.ts.*src\/run-task\.ts/, `expected the offending edge in the output. output:\n${output}`);
});

test("depcruise is a clean fixture (no spike/CLI import from src/lib): zero exit, no rule cited", () => {
  const fixture = buildFixture(`export const widget = "clean";\n`);
  const { status, output } = runDepcruise(fixture);
  assert.equal(status, 0, `expected a clean exit for a violation-free fixture, got ${status}. output:\n${output}`);
  assert.doesNotMatch(output, /lib-no-spike-or-cli/, `a clean fixture must not cite the rule. output:\n${output}`);
});

test("depcruise over remudero's OWN src tree is clean today (the rule is live, not just fixture-tested)", () => {
  const { status, output } = runDepcruise(repoRoot);
  assert.equal(status, 0, `expected remudero's real src/lib to be clean, got ${status}. output:\n${output}`);
});

function architectureScan(root: string, bounded: boolean) {
  return spawnSync(process.execPath, ["--max-old-space-size=512",
    ...(bounded ? [configPath, "src"] : [depcruiseBin, "src", "--config", configPath]),
    "--output-type", "json"], {
    cwd: root, encoding: "utf8", timeout: 120_000, maxBuffer: 32 << 20,
    env: { ...process.env, NODE_OPTIONS: "", NODE_V8_COVERAGE: "" },
  });
}

function graphPopulation(output: string) {
  const graph = JSON.parse(output);
  return { modules: graph.modules, violations: graph.summary.violations,
    rules: graph.summary.ruleSetUsed, folders: graph.folders };
}

test("W1-T10946: the default full-source architecture scan completes within its unchanged heap bound", (t) => {
  const scan = spawnSync("npm", ["run", "--silent", "depcruise", "--", "--output-type", "json"], {
    cwd: REPO_ROOT, encoding: "utf8", timeout: 120_000, maxBuffer: 32 << 20,
    env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=512", NODE_V8_COVERAGE: "" },
  });
  assert.equal(scan.error, undefined);
  assert.equal(scan.status, 0, scan.stderr);
  assert.match(scan.stderr, /AST retention window: 1 file/);
  assert.match(JSON.parse(scan.stdout).summary.environment.transpilersFound
    .find((parser: { name: string }) => parser.name === "swc").currentVersion, /^@swc\/core@/,
  "the configured SWC parser must actually load; package availability alone permits Acorn fallback");
  const reference = architectureScan(REPO_ROOT, false);
  assert.equal(reference.error, undefined);
  if (reference.status === 0) {
    assert.deepEqual(graphPopulation(scan.stdout), graphPopulation(reference.stdout));
  } else {
    assert.equal(reference.signal, "SIGABRT", reference.stderr);
    assert.match(reference.stderr, /heap out of memory|Reached heap limit/);
  }
  assert.ok(JSON.parse(scan.stdout).modules.length > 600, "the full source graph was scanned");
  t.diagnostic(`512 MiB: default=${scan.status}, native=${reference.status}/${reference.signal}`);
});

test("W1-T10946: planted forbidden imports remain detected and removal of the memory fix restores the measured retention failure", (t) => {
  const fixture = buildFixture(`import { spikeMarker } from "../spike.js";\nexport const widget = spikeMarker;\n`);
  try {
    mkdirSync(join(fixture, "src", "cli"));
    writeFileSync(join(fixture, "src", "cli", "verb.ts"), 'import "../run-task.js";\n');
    writeFileSync(join(fixture, "src", "run-task.ts"), 'import "./lib/widget.js";\n');
    writeFileSync(join(fixture, "src", "spike.ts"), 'import "./lib/widget.js";\nexport const spikeMarker = 1;\n');
    writeFileSync(join(fixture, "src", "lib", "skill-workshop.ts"), 'import "./golden-corpus.js";\n');
    writeFileSync(join(fixture, "src", "lib", "golden-corpus.ts"), 'export const heldOut = 1;\n');
    const bounded = architectureScan(fixture, true);
    const reference = architectureScan(fixture, false);
    assert.equal(bounded.error, undefined);
    assert.equal(reference.error, undefined);
    assert.equal(bounded.status, 0, bounded.stderr);
    assert.equal(reference.status, 0, reference.stderr);
    assert.deepEqual(graphPopulation(bounded.stdout), graphPopulation(reference.stdout));
    const names = new Set(JSON.parse(bounded.stdout).summary.violations.map((v: { rule: { name: string } }) => v.rule.name));
    for (const name of ["lib-no-spike-or-cli", "cli-no-run-task", "drafter-never-sees-held-out-set", "no-circular"]) {
      assert.ok(names.has(name), `planted ${name} must be detected`);
    }
    // A narrow chain with large syntax bodies separates retained ASTs from graph size.
    const body = Array.from({ length: 10_000 }, (_, n) => `const value${n} = { nested: [${n}, "payload"] };`).join("\n");
    for (let n = 0; n < 60; n++) {
      const edge = n < 59 ? `import "./large-${n + 1}.js";\n` : "";
      writeFileSync(join(fixture, "src", `large-${n}.ts`), edge + body);
    }
    const fixed = architectureScan(fixture, true);
    assert.equal(fixed.error, undefined);
    assert.equal(fixed.status, 0, fixed.stderr);
    assert.equal(JSON.parse(fixed.stdout).modules.filter((m: { source: string }) => /large-\d+\.ts$/.test(m.source)).length, 60);
    const erased = architectureScan(fixture, false);
    t.diagnostic(`512 MiB, large AST chain: bounded=${fixed.status}/${fixed.signal}, erased=${erased.status}/${erased.signal}`);
    assert.equal(erased.error, undefined);
    assert.equal(erased.signal, "SIGABRT", `unbounded terminal outcome: ${erased.status}\n${erased.stderr}`);
    assert.match(erased.stderr, /heap out of memory|Reached heap limit/);
    for (let n = 0; n < 60; n++) {
      writeFileSync(join(fixture, "src", `large-${n}.ts`), n < 59 ? `import "./large-${n + 1}.js";\n` : "");
    }
    const compact = architectureScan(fixture, false);
    assert.equal(compact.error, undefined);
    assert.equal(compact.status, 0, compact.stderr);
    assert.deepEqual(graphPopulation(fixed.stdout), graphPopulation(compact.stdout),
      "removing dependency-free syntax must preserve the entire module/edge/rule population");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

// ── Playwright teardown-race guard (the #632/#645 flake): a `return page.<method>(...)` inside a
// test that ALSO closes the page/context in a `finally` returns the PENDING promise, so the
// finally tears down BEFORE it settles -> "Target page ... has been closed", flaking the test and
// false-reddening unrelated PRs. The fix is `return await`. This guard forbids the bare form
// across the browser-driven serve suites so the class cannot silently regress.

test("no serve test returns a bare (un-awaited) page.<method>(...) — the teardown-race anti-pattern is forbidden fleet-wide", () => {
  const { dir: testDir, files } = testCorpus();
  const offenders: string[] = [];
  for (const file of files) {
    if (!/(^|\/)serve[^/]*\.test\.ts$/.test(file)) continue;
    const lines = readFileSync(join(testDir, file), "utf8").split("\n");
    lines.forEach((line, i) => {
      // a `return page.<something>(` that is NOT `return await page.` — the un-awaited return.
      if (/^\s*return\s+page\.\w+\s*\(/.test(line) && !/^\s*return\s+await\s+page\./.test(line)) {
        offenders.push(`${file}:${i + 1}: ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(offenders, [], `un-awaited \`return page.…\` in a serve test races the finally teardown; use \`return await\`:\n${offenders.join("\n")}`);
});


// ── mutant-module placement guard (the W1-T421 coverage collapse) ─────────────────────────────
// A suite that writes a MUTATED COPY of a src/lib module and imports it must put the copy INSIDE
// the project root. MEASURED across 14 bisect runs of the same 14 files: a copy under `os.tmpdir()`
// re-enters the real src/lib graph from outside the root, a synthetic `SF:src/lib/<define:import.meta>`
// record appears, and `src/lib/commit-message.ts` collapses from LH:533 to LH:109 — 424 lines that
// then read to `scripts/diff-coverage.mjs` exactly like code nobody tested. Two suites had this
// shape; both were falsifiers written the same week, which is why it surfaced now rather than a
// year ago. The guard is here rather than in either suite because the NEXT one written is the risk.

/** The offending shape: a specifier `await import()`ed whose own assignment reaches `tmpdir()`. */
function tmpdirModuleImports(text: string): string[] {
  const bad: string[] = [];
  for (const m of text.matchAll(/await import\(([A-Za-z_$][A-Za-z0-9_$]*)\)/g)) {
    const id = m[1];
    // The assignment, from `const <id> =` to the first statement terminator at end of line — the
    // construction spans lines in both real call sites, so this cannot be a single-line match.
    const assign = new RegExp(`(?:const|let|var)\\s+${id}\\s*=[\\s\\S]*?;\\s*$`, "m").exec(text);
    if (assign && /\btmpdir\(\)/.test(assign[0])) bad.push(id);
  }
  return bad;
}

test("no test imports a mutated module copy from outside the project root — the coverage-record anti-pattern is forbidden fleet-wide", () => {
  // BOTH DIRECTIONS. A detector that only ever returns [] passes over every file in the repo and
  // proves nothing, so it is driven with the exact pre-fix construction first — and with the two
  // legitimate shapes it must stay silent on: a dynamic import of a REAL in-tree module
  // (test/clock-sweep.test.ts and two siblings), and a tmpdir used for fixture DATA rather than a
  // module, which is ubiquitous here.
  assert.deepEqual(
    tmpdirModuleImports(
      'const mutantPath = join(mkdtempSync(join(tmpdir(), "x-mutant-")), "review.ts");\nconst m = await import(mutantPath);\n',
    ),
    ["mutantPath"],
    "the detector must fire on the shape this task removed, or it is vacuous",
  );
  assert.deepEqual(
    tmpdirModuleImports(
      'const SWEEP_URL = pathToFileURL(join(dir, "..", "scripts", "clock-sweep.mjs")).href;\nconst mod = await import(SWEEP_URL);\n',
    ),
    [],
    "a dynamic import of a real in-tree module is the repo idiom and must stay silent",
  );
  assert.deepEqual(
    tmpdirModuleImports(
      'const ledger = join(mkdtempSync(join(tmpdir(), "led-")), "ledger.ndjson");\nconst m = await import(REAL_URL);\n',
    ),
    [],
    "a tmpdir holding fixture DATA is not this anti-pattern",
  );

  const { dir: testDir, files } = testCorpus();
  // THIS FILE IS SKIPPED, and the reason is not convenience: the controls above are the offending
  // shape written out as string literals, so a sweep including this file matches its own fixtures
  // and reports a defect that does not exist — the self-match failure mode CLAUDE.md names for
  // `pkill -f`, in a different dress. The hole it leaves is a mutant import written into the guard
  // file itself, which is the one file in the repo whose whole purpose is to contain no such thing.
  const SELF = "architecture-fitness.test.ts";
  const offenders: string[] = [];
  for (const file of files) {
    if (file.split("/").at(-1) === SELF) continue;
    for (const id of tmpdirModuleImports(readFileSync(join(testDir, file), "utf8"))) {
      offenders.push(`${file}: a mutant module imported from ${id}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "a mutant module imported from os.tmpdir() destroys the coverage record of every src/lib module " +
      "its graph re-enters; use writeMutantModule (test/helpers/mutant-module.ts), which writes the " +
      `copy under test/ instead:\n${offenders.join("\n")}`,
  );
});

// THE SAME COLLAPSE, A SECOND SHAPE (#11757). The mechanism under both is tsx's MODULE FORMAT, not the
// path: a `.ts`/`.js` file outside any `"type": "module"` package scope (os.tmpdir() has none) is compiled
// as COMMONJS, and every real src module it imports is then `require()`d and compiled as CommonJS too,
// with `import.meta` substituted by a `define` that esbuild names `<define:import.meta>` in the source
// map. Under coverage that becomes `SF:src/lib/<define:import.meta>`. The pre-push harness of
// test/the-pre-push-gate-runs-the-branch-s-own-checks-in-the-proof-sandbox.test.ts wrote
// `harness/src/lib/git-push.ts` re-exporting the real module into a tmp dir with no package.json; its
// hook children carried the record into coverage shard 3, and coverage-merge-ratchet refused #11757.
// The guard above only sees `await import(<id>)` of a tmpdir path, so this shape walked past it.

/** The offending shape: a generated `.ts`/`.js` module whose text imports the real `src/` through an
 *  interpolated specifier, written as `<write>(join(<dir>, "...ts"), \`...\`)` into a `<dir>` the file never
 *  makes an ESM scope (`join(<dir>, "package.json")` holding `type: "module"`). An `.mts`/`.mjs` name is ESM by
 *  extension and never matches. BLIND SPOT: a path held in a variable rather than a literal `join(...)`. */
function cjsScopeSourceWrappers(text: string): string[] {
  const bad: string[] = [];
  const write = /\b(?:writeFileSync|writeFile|put)\(\s*join\(\s*([A-Za-z_$][\w$]*)\s*,([^`;]*?\.(?:ts|tsx|cts|js|cjs))"\s*\)\s*,\s*`([^`]*)`/g;
  for (const m of text.matchAll(write)) {
    const [, dir, file, body] = m;
    if (!/(?:\bfrom\s*|\bimport\s*\(\s*)\$\{[^}]*\bsrc["/]/.test(body)) continue;
    const esmScope = new RegExp(`join\\(\\s*${dir.replace(/\$/g, "\\$")}\\s*,\\s*"package\\.json"\\s*\\)[^;]*\\btype"?\\s*:\\s*"module"`);
    if (!esmScope.test(text)) bad.push(`${dir}:${file.trim().replace(/^"/, "")}`);
  }
  return bad;
}

test("no test compiles the real src graph as CommonJS through a generated module outside an ESM scope — the <define:import.meta> record is forbidden", () => {
  // BOTH DIRECTIONS, as above: the #11757 harness construction verbatim must fire; the same wrapper in a
  // directory given `{"type":"module"}` must not, nor an .mjs wrapper, nor a .ts fixture importing nothing real.
  const wrapper = 'put(join(harness, "src/lib/git-push.ts"), `import * as p from ${url("src/lib/git-push.ts")};\nexport const x = p;\n`);\n';
  assert.deepEqual(cjsScopeSourceWrappers(wrapper), ['harness:src/lib/git-push.ts'], "the detector must fire on the #11757 shape, or it is vacuous");
  assert.deepEqual(
    cjsScopeSourceWrappers(`put(join(harness, "package.json"), JSON.stringify({ type: "module" }));\n${wrapper}`),
    [],
    "a wrapper inside a declared ESM scope compiles as ESM and must stay silent",
  );
  assert.deepEqual(
    cjsScopeSourceWrappers('writeFileSync(join(root, "child.mjs"), `import { f } from ${JSON.stringify(pathToFileURL(join(REPO, "src/lib/x.ts")).href)};`);\n'),
    [],
    "an .mjs wrapper is ESM by extension",
  );
  assert.deepEqual(
    cjsScopeSourceWrappers('writeFileSync(join(root, "test", "a.test.ts"), `import { test } from "node:test";\ntest("a", () => {});\n`);\n'),
    [],
    "a generated test importing no real src module is not this shape",
  );

  const { dir: testDir, files } = testCorpus();
  // SKIPPED: this file, whose controls above are the offending shape as literals, and the one suite that builds
  // the shape ON PURPOSE to prove the mechanism — it points its probe child's NODE_V8_COVERAGE at its own temp
  // dir, so the record it makes never reaches a shard's lcov.
  const SKIP = new Set(["architecture-fitness.test.ts", "a-define-import-meta-coverage-record-names-its-commonjs-cause.test.ts"]);
  const offenders: string[] = [];
  for (const file of files) {
    if (SKIP.has(file.split("/").at(-1)!)) continue;
    for (const hit of cjsScopeSourceWrappers(readFileSync(join(testDir, file), "utf8"))) offenders.push(`${file}: ${hit}`);
  }
  assert.deepEqual(
    offenders,
    [],
    "a generated .ts/.js module outside an ESM package scope compiles the real src graph as CommonJS and plants " +
      "SF:src/lib/<define:import.meta> in coverage, which coverage-merge-ratchet refuses; write " +
      `{"type":"module"} into that directory's package.json, or name the module .mts/.mjs:\n${offenders.join("\n")}`,
  );
});
