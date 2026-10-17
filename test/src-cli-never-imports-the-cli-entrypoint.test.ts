import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { repoRoot as findRepoRoot } from "./helpers/repo-root.js";

const repoRoot = findRepoRoot();
const depcruiseBin = join(repoRoot, "node_modules", ".bin", "depcruise");
const configPath = join(repoRoot, ".dependency-cruiser.cjs");

/** Runs the real depcruise binary over `src/` inside `root`. Never throws on a nonzero exit. */
function runDepcruise(root: string): { status: number; output: string } {
  try {
    const output = execFileSync(process.execPath, [depcruiseBin, "src", "--config", configPath], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, output };
  } catch (err) {
    const e = err as { status?: number | null; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

test("W1-T9331: depcruise blocks a planted src/cli/commands import of src/run-task.ts citing cli-no-run-task", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-cli-fixture-"));
  mkdirSync(join(root, "src", "cli", "commands"), { recursive: true });
  writeFileSync(join(root, "src", "run-task.ts"), `export const cliMarker = "cli";\n`);
  writeFileSync(
    join(root, "src", "cli", "commands", "widget.ts"),
    `import { cliMarker } from "../../run-task.js";\nexport const widget = cliMarker;\n`,
  );
  const { status, output } = runDepcruise(root);
  assert.notEqual(status, 0, `expected a nonzero exit for a planted violation. output:\n${output}`);
  assert.match(output, /cli-no-run-task/, `expected the named rule. output:\n${output}`);
  assert.match(output, /src\/cli\/commands\/widget\.ts.*src\/run-task\.ts/, `expected the edge. output:\n${output}`);
});

test("W1-T9331: depcruise over the repo src tree is clean under cli-no-run-task", () => {
  const { status, output } = runDepcruise(repoRoot);
  assert.equal(status, 0, `expected the real src tree to be clean, got ${status}. output:\n${output}`);
  assert.doesNotMatch(output, /cli-no-run-task/);
});
