import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * MASTER-PLAN §5 TIER 3 (W1-T26): "src/lib imports nothing from spike/CLI" is
 * declared in `.dependency-cruiser.cjs` as the `lib-no-spike-or-cli` rule. A
 * declared rule is not the same as an ACTIVE one — these tests are the
 * falsifier: they run the real `dependency-cruiser` binary (not a stub) over
 * a planted fixture and assert it exits non-zero citing the rule by name, and
 * over a clean fixture and assert it exits zero. Without this, "0 violations"
 * from a fresh gate is exactly the neon-drift `_probe(x)` trap LEARNINGS
 * warns about — suspicious until falsified, not proof of anything.
 */

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const depcruiseBin = join(repoRoot, "node_modules", "dependency-cruiser", "bin", "dependency-cruise.mjs");
const configPath = join(repoRoot, ".dependency-cruiser.cjs");

/** Runs the real depcruise binary over `src/` inside `fixtureRoot`. Never throws on a nonzero exit. */
function runDepcruise(fixtureRoot: string): { status: number; output: string } {
  try {
    const output = execFileSync(process.execPath, [depcruiseBin, "src", "--config", configPath], {
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

// ── Playwright teardown-race guard (the #632/#645 flake): a `return page.<method>(...)` inside a
// test that ALSO closes the page/context in a `finally` returns the PENDING promise, so the
// finally tears down BEFORE it settles -> "Target page ... has been closed", flaking the test and
// false-reddening unrelated PRs. The fix is `return await`. This guard forbids the bare form
// across the browser-driven serve suites so the class cannot silently regress.

test("no serve test returns a bare (un-awaited) page.<method>(...) — the teardown-race anti-pattern is forbidden fleet-wide", () => {
  const testDir = join(fileURLToPath(new URL("..", import.meta.url)), "test");
  const offenders: string[] = [];
  for (const file of readdirSync(testDir)) {
    if (!/^serve.*\.test\.ts$/.test(file)) continue;
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

  const testDir = join(fileURLToPath(new URL("..", import.meta.url)), "test");
  // THIS FILE IS SKIPPED, and the reason is not convenience: the controls above are the offending
  // shape written out as string literals, so a sweep including this file matches its own fixtures
  // and reports a defect that does not exist — the self-match failure mode CLAUDE.md names for
  // `pkill -f`, in a different dress. The hole it leaves is a mutant import written into the guard
  // file itself, which is the one file in the repo whose whole purpose is to contain no such thing.
  const SELF = "architecture-fitness.test.ts";
  const offenders: string[] = [];
  for (const file of readdirSync(testDir)) {
    if (!/\.test\.ts$/.test(file) || file === SELF) continue;
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
