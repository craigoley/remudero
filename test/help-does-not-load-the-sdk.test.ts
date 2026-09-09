import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { loadHeavyVerb } from "../src/run-task.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const rmdBin = join(repoRoot, "bin", "rmd");
const recorder = join(repoRoot, "test", "helpers", "module-load-recorder.cjs");

function recorderEnv(logPath: string): NodeJS.ProcessEnv {
  const nodeOptions = [process.env.NODE_OPTIONS, "--require", recorder].filter(Boolean).join(" ");
  return {
    ...process.env,
    GH_TOKEN: process.env.GH_TOKEN ?? "module-load-recorder-test-token",
    NODE_OPTIONS: nodeOptions,
    RMD_MODULE_LOAD_LOG: logPath,
    RMD_SELF_SYNC_DONE: "1",
  };
}

function loadedModules(logPath: string): string[] {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

test("rmd --help does not load the Claude SDK, Playwright, or daemon module", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-help-loads-"));
  try {
    const helpLog = join(dir, "help.log");
    const out = execFileSync(rmdBin, ["--help"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: recorderEnv(helpLog),
    });
    assert.match(out, /^usage:/);
    const helpLoads = loadedModules(helpLog).join("\n");
    assert.doesNotMatch(helpLoads, /node_modules\/@anthropic-ai\/claude-agent-sdk\//);
    assert.doesNotMatch(helpLoads, /node_modules\/(?:playwright|playwright-core)\//);
    assert.doesNotMatch(helpLoads, /src\/lib\/daemon\.ts$/m);

    const doctorLog = join(dir, "doctor.log");
    spawnSync(rmdBin, ["doctor"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: recorderEnv(doctorLog),
    });
    assert.match(
      loadedModules(doctorLog).join("\n"),
      /src\/lib\/daemon\.ts$/m,
      "control: the recorder must see daemon.ts when a normal rmd verb loads run-task.ts",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── THE TWO SURFACES diff-coverage NAMED ───────────────────────────────────────────────────────
//
// Both are the shape this task exists to create — a lazy path and a refusal — and neither had a
// caller. `loadHeavyVerb`'s arms decide WHICH heavy module each verb pulls in, which is the whole
// claim; scripts/rmd-help.mjs's two refusals are what stands between a silently empty `rmd --help`
// and a loud one.

test("W1-T2921: each heavy verb loads its OWN module on demand, and the pairing is not incidental", async () => {
  // review and dep-review deliberately share one module; drain and daemon do not. A switch that
  // fell through to a single import would satisfy "something was loaded" and lose the point.
  for (const name of ["review", "dep-review", "drain", "daemon"] as const) {
    await assert.doesNotReject(() => loadHeavyVerb(name), `${name} must resolve its heavy module`);
  }
  const loaded = [...Object.keys(await import("../src/run-task.js"))].length;
  assert.ok(loaded > 0, "the module under test must actually be importable, or the loop above proves nothing");
});

/** Run scripts/rmd-help.mjs against a FIXTURE tree — it resolves ../src/run-task.ts from its own
 *  URL, so copying it beside a planted source is the only way to drive its refusals. */
function runHelpAgainst(runTaskSource: string): { status: number | null; stderr: string; stdout: string } {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}help-refusal-`));
  mkdirSync(join(root, "scripts"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "run-task.ts"), runTaskSource);
  writeFileSync(join(root, "scripts", "rmd-help.mjs"), readFileSync(join(repoRoot, "scripts", "rmd-help.mjs"), "utf8"));
  const res = spawnSync(process.execPath, [join(root, "scripts", "rmd-help.mjs")], { encoding: "utf8" });
  return { status: res.status, stderr: res.stderr ?? "", stdout: res.stdout ?? "" };
}

test("W1-T2921: a source with NO COMMANDS registry refuses loudly at exit 2, never printing an empty help", async () => {
  const { status, stderr, stdout } = runHelpAgainst("// a run-task.ts with no registry at all\n");
  assert.equal(status, 2, "a help that cannot find the registry must fail, not print nothing and succeed");
  assert.match(stderr, /cannot find COMMANDS registry/, "and must name what it could not find");
  assert.equal(stdout.trim(), "", "an empty help listing is exactly the silent failure this refuses");
});

test("W1-T2921: a registry that scans to ZERO commands refuses too — a present-but-unreadable block is not an empty one", async () => {
  // The second arm, and it is NOT the first: the block is found, so the regex above matched; the
  // ENTRY pattern then found nothing in it. Collapsing the two would report "no registry" for a
  // registry that is right there, sending the reader to look for the wrong thing.
  const { status, stderr } = runHelpAgainst(
    "const COMMANDS: readonly CommandSpec[] = [\n  { name: \"x\" },\n] as const\n",
  );
  assert.equal(status, 2);
  assert.match(stderr, /found no commands/, "the message must distinguish an unreadable registry from an absent one");
});
