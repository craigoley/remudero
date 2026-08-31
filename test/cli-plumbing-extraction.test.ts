/**
 * test/cli-plumbing-extraction.test.ts — W1-T2260.
 *
 * Four locally-declared CLI symbols (`repoRoot`, `resolveRepoRoot`, `resolveOwnerRepo`,
 * `unknownArgError`) used to live only in `src/run-task.ts`, invisible to any dependency
 * graph because a DECLARATION carries no import statement. `src/lib/branch-reaper.ts`'s own
 * header names them as the reason `reapBranchesCommand` stayed behind when the guard
 * list/citation scan/reverse-drift planner moved out — this is the prerequisite that clears
 * that block for a future extraction. `commandSyntax`, the fourth symbol the operator brief
 * measured, stays in `run-task.ts` on purpose: it reads `commandSpec`/`COMMANDS`, the
 * registry that IS the CLI's identity, and moving it would be a redesign this task doesn't
 * make (see the `note:`/rationale in the task's own plan shard).
 *
 * This is a structural/relocation proof, not a re-test of business logic: `resolveRepoRoot`'s
 * priority order and `unknownArgError`'s flag validation are already covered by
 * test/repo-root-identity.test.ts and test/run-task.test.ts respectively (both of which
 * import from `../src/run-task.js`, proving the re-export path still works unchanged).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as repoLocation from "../src/lib/repo-location.js";
import * as cliArgs from "../src/lib/cli-args.js";
import { resolveRepoRoot as reExportedResolveRepoRoot, unknownArgError as reExportedUnknownArgError } from "../src/run-task.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const runTaskSrc = readFileSync(join(repoRoot, "src", "run-task.ts"), "utf8");
const libDir = join(repoRoot, "src", "lib");
const depcruiseBin = join(repoRoot, "node_modules", "dependency-cruiser", "bin", "dependency-cruise.mjs");
const configPath = join(repoRoot, ".dependency-cruiser.cjs");

// ── Criterion 1: the repo-location cluster relocated together, initialiser included ────────

test("repo-location cluster: repoRoot, its initialiser resolveRepoRoot, and resolveOwnerRepo all live in src/lib/repo-location.ts", () => {
  assert.equal(typeof repoLocation.resolveRepoRoot, "function", "resolveRepoRoot must be exported from src/lib/repo-location.ts");
  assert.equal(typeof repoLocation.resolveOwnerRepo, "function", "resolveOwnerRepo must be exported from src/lib/repo-location.ts");
  assert.equal(typeof repoLocation.repoRoot, "string", "repoRoot's evaluated value must be exported from src/lib/repo-location.ts");
});

test("repo-location cluster: none of the three symbols is declared locally in src/run-task.ts anymore", () => {
  assert.doesNotMatch(runTaskSrc, /^export function resolveRepoRoot\(/m, "resolveRepoRoot must no longer be declared in run-task.ts");
  assert.doesNotMatch(runTaskSrc, /^const repoRoot = resolveRepoRoot\(/m, "repoRoot must no longer be declared in run-task.ts");
  assert.doesNotMatch(runTaskSrc, /^function resolveOwnerRepo\(/m, "resolveOwnerRepo must no longer be declared in run-task.ts");
  assert.match(
    runTaskSrc,
    /import \{ repoRoot, resolveOwnerRepo, resolveRepoRoot \} from "\.\/lib\/repo-location\.js";/,
    "run-task.ts must import the cluster from ./lib/repo-location.js",
  );
});

test("repo-location.ts's repoRoot initialiser is resolveRepoRoot itself, not a re-derivation", () => {
  const src = readFileSync(join(libDir, "repo-location.ts"), "utf8");
  assert.match(
    src,
    /export const repoRoot = resolveRepoRoot\(process\.argv\.slice\(2\), process\.cwd\(\)\);/,
    "repoRoot's initialiser must call the co-located resolveRepoRoot, exactly as it did in run-task.ts",
  );
});

test("resolveRepoRoot's install-path fallback still resolves to the checkout root, not src/lib, from its new file location", () => {
  // `resolveRepoRoot`'s install-path fallback derives the checkout root from its OWN
  // `import.meta.url`, which is module-relative. The move put it one directory deeper
  // (src/lib/repo-location.ts vs. src/run-task.ts) — this pins the fallback still resolving to
  // the real checkout root, catching the exact off-by-one-directory bug a naive verbatim move
  // would have introduced (repoLocation's own repoRoot value, evaluated the same way, is the
  // independent oracle here — both must land on the same directory).
  let stderr = "";
  const origError = console.error;
  console.error = (m: string) => {
    stderr += `${m}\n`;
  };
  let resolved: string;
  try {
    resolved = repoLocation.resolveRepoRoot(["lint-plan"], "/definitely/not/a/git/tree", () => {
      throw new Error("fatal: not a git repository");
    });
  } finally {
    console.error = origError;
  }
  assert.equal(resolved, repoLocation.repoRoot, "the install-path fallback must resolve to the same checkout root repoRoot itself evaluated to");
  assert.match(stderr, /not inside a git work tree/, "the fallback must still report itself on stderr, never silently");
});

// ── Criterion 2: relocating repoRoot must not move argv evaluation into a module a test can
//    import for an unrelated symbol ─────────────────────────────────────────────────────────

test("repo-location.ts exports ONLY the repo-location cluster — nothing unrelated shares its argv-at-import-time cost", () => {
  const exported = Object.keys(repoLocation).sort();
  assert.deepEqual(exported, ["repoRoot", "resolveOwnerRepo", "resolveRepoRoot"], `repo-location.ts must export exactly the cluster, got: ${exported.join(", ")}`);
});

test("no other src/lib module imports src/lib/repo-location.ts — only run-task.ts (the CLI entrypoint) pays the argv-at-import cost", () => {
  const importers: string[] = [];
  for (const file of readdirSync(libDir, { recursive: true }) as string[]) {
    if (!file.endsWith(".ts") || file === "repo-location.ts") continue;
    const full = join(libDir, file);
    let text: string;
    try {
      text = readFileSync(full, "utf8");
    } catch {
      continue; // directory entry
    }
    if (/from ["']\.\.?\/(.*\/)?repo-location\.js["']/.test(text)) importers.push(file);
  }
  assert.deepEqual(importers, [], `an unrelated src/lib module imports repo-location.ts and would pay the argv-at-import cost on import: ${importers.join(", ")}`);
});

// ── Criterion 3: the separable arg-parsing symbol moves without dragging the registry ───────

test("unknownArgError lives in src/lib/cli-args.ts and is self-contained (no imports at all)", () => {
  assert.equal(typeof cliArgs.unknownArgError, "function", "unknownArgError must be exported from src/lib/cli-args.ts");
  const src = readFileSync(join(libDir, "cli-args.ts"), "utf8");
  assert.doesNotMatch(src, /^import /m, "cli-args.ts must import nothing — unknownArgError depends on nothing local");
  assert.doesNotMatch(
    src,
    /commandSpec\(|COMMANDS\.|commandSyntax\(/,
    "cli-args.ts must not drag the command registry (COMMANDS/commandSpec/commandSyntax) along with it",
  );
});

test("commandSyntax stays anchored in run-task.ts — it is NOT relocated, because it reads the COMMANDS registry", () => {
  assert.match(runTaskSrc, /^function commandSyntax\(name: string\): string \{/m, "commandSyntax must remain declared in run-task.ts");
  assert.match(runTaskSrc, /return commandSpec\(name\)\.syntax/, "commandSyntax must still read the COMMANDS registry via commandSpec");
});

// ── Criterion 4: no signature changes, no call sites rewritten ─────────────────────────────

test("resolveRepoRoot keeps its exact three-parameter signature after the move", () => {
  const src = readFileSync(join(libDir, "repo-location.ts"), "utf8");
  assert.match(
    src,
    /export function resolveRepoRoot\(\s*argv: string\[\],\s*cwd: string,\s*showToplevel: \(dir: string\) => string = \(dir\) =>/,
    "resolveRepoRoot's parameter list must be byte-identical to the pre-move declaration",
  );
});

test("resolveOwnerRepo keeps its exact zero-arg, {owner,repo}-returning signature after the move", () => {
  const src = readFileSync(join(libDir, "repo-location.ts"), "utf8");
  assert.match(
    src,
    /export function resolveOwnerRepo\(\): \{ owner: string; repo: string \} \{/,
    "resolveOwnerRepo's signature must be byte-identical to the pre-move declaration",
  );
});

test("unknownArgError keeps its exact four-parameter signature after the move", () => {
  const src = readFileSync(join(libDir, "cli-args.ts"), "utf8");
  assert.match(
    src,
    /export function unknownArgError\(\s*command: string,\s*rest: string\[\],\s*valueFlags: string\[\],\s*boolFlags: string\[\] = \[\],\s*\): string \| null \{/,
    "unknownArgError's parameter list must be byte-identical to the pre-move declaration",
  );
});

test("run-task.ts re-exports resolveRepoRoot and unknownArgError so every existing call site keeps working unchanged", () => {
  assert.equal(reExportedResolveRepoRoot, repoLocation.resolveRepoRoot, "the re-exported resolveRepoRoot must be the same function, not a redeclared copy");
  assert.equal(reExportedUnknownArgError, cliArgs.unknownArgError, "the re-exported unknownArgError must be the same function, not a redeclared copy");
});

test("run-task.ts call sites still reference repoRoot/resolveOwnerRepo/unknownArgError by their bare original names, never a qualified lib.<name> access", () => {
  assert.doesNotMatch(runTaskSrc, /\brepoLocation\.\w/, "no call site should have been rewritten to a qualified repoLocation.<name> access");
  assert.doesNotMatch(runTaskSrc, /\bcliArgs\.\w/, "no call site should have been rewritten to a qualified cliArgs.<name> access");
  // The bulk of the original in-code reference counts (165 repoRoot, 57 resolveOwnerRepo, 44
  // unknownArgError, measured on this task's own baseline) must still read as bare identifiers.
  const repoRootRefs = (runTaskSrc.match(/\brepoRoot\b/g) ?? []).length;
  const resolveOwnerRepoRefs = (runTaskSrc.match(/\bresolveOwnerRepo\b/g) ?? []).length;
  const unknownArgErrorRefs = (runTaskSrc.match(/\bunknownArgError\b/g) ?? []).length;
  assert.ok(repoRootRefs >= 150, `expected repoRoot to still be referenced widely in run-task.ts, got ${repoRootRefs}`);
  assert.ok(resolveOwnerRepoRefs >= 50, `expected resolveOwnerRepo to still be referenced widely in run-task.ts, got ${resolveOwnerRepoRefs}`);
  assert.ok(unknownArgErrorRefs >= 40, `expected unknownArgError to still be referenced widely in run-task.ts, got ${unknownArgErrorRefs}`);
});

test("unknownArgError's behavior is unchanged post-move (the daemon-install hazard stays caught)", () => {
  // Mirrors test/run-task.test.ts's own coverage — re-asserted here against the LIB export
  // directly (not the run-task.js re-export) to prove the move didn't touch behavior.
  assert.match(cliArgs.unknownArgError("daemon", ["install", "--dry-run"], ["--max", "--poll-ms"], [])!, /unexpected argument 'install'/);
  assert.equal(cliArgs.unknownArgError("daemon", ["--max", "5"], ["--max", "--poll-ms"], []), null);
});

// ── Criterion 5: the layering rule still refuses lib -> CLI, and the cycle count doesn't rise ──

/** Runs the real depcruise binary over remudero's own `src/` tree. Never throws on nonzero exit. */
function runDepcruise(): { status: number; output: string } {
  try {
    const output = execFileSync(process.execPath, [depcruiseBin, "src", "--config", configPath], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, output };
  } catch (err) {
    const e = err as { status?: number | null; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

test(".dependency-cruiser.cjs's lib-no-spike-or-cli rule is still declared at severity error, covering run-task.ts", () => {
  const cfg = readFileSync(configPath, "utf8");
  assert.match(cfg, /name:\s*"lib-no-spike-or-cli"/);
  assert.match(cfg, /severity:\s*"error"/);
  assert.match(cfg, /to:\s*\{\s*path:\s*"\^src\/\(spike\|run-task\)/);
});

test("neither new lib module (repo-location.ts, cli-args.ts) imports src/run-task.ts or src/spike.ts", () => {
  for (const name of ["repo-location.ts", "cli-args.ts"]) {
    const src = readFileSync(join(libDir, name), "utf8");
    assert.doesNotMatch(src, /from ["']\.\.\/run-task\.js["']/, `${name} must not import run-task.ts`);
    assert.doesNotMatch(src, /from ["']\.\.\/spike\.js["']/, `${name} must not import spike.ts`);
  }
});

test("depcruise over the real src tree still reports zero ERRORS (the layering rule is enforced, not just declared)", () => {
  const { status, output } = runDepcruise();
  assert.equal(status, 0, `expected the real src tree to have zero depcruise errors, got status ${status}. output:\n${output}`);
  assert.doesNotMatch(output, /lib-no-spike-or-cli/, `no lib module may reach back into the CLI entrypoint or spike script. output:\n${output}`);
});

test("depcruise's reported cycle count does not rise above this task's own baseline of 13 no-circular warnings", () => {
  const { output } = runDepcruise();
  const cycleCount = (output.match(/warn no-circular:/g) ?? []).length;
  // Baseline measured on this task's own head, both before (git-stashed) and after this
  // relocation: 13 `no-circular` warnings, 0 errors, over 150 modules / 689 dependencies. A
  // relocation that LOWERS this is a bonus (see the task's rationale); one that raises it fails
  // regardless of what else it tidied.
  assert.ok(cycleCount <= 13, `expected no more than 13 no-circular warnings (this task's baseline), got ${cycleCount}:\n${output}`);
});
