import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { HANDLERS, main } from "#src/run-task.js";
import { GithubCredentialMissingError, GITHUB_CREDENTIAL_MISSING_STEP, installGithubCredentialMissingSink, resolveGithubCredential } from "#src/lib/github-credential.js";
import { LEDGER_FILENAME } from "#src/lib/ledger-path.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

// Same convention as test/mounts-wiring.test.ts: assert the CLI entrypoint
// actually calls into the lib (loadSkillRegistry/renderSkillList) rather than
// hand-rolling its own registry read or a hardcoded listing.
const runTaskSrc = readFileSync(fileURLToPath(new URL("../src/run-task.ts", import.meta.url)), "utf8");

test("`rmd skill` dispatches to skillCommand", () => {
  // W1-T2893: main() resolves "skill" against src/cli/registry.ts's HANDLERS map (dispatchCommand)
  // rather than its own `cmd === "skill"` branch — assert the registry entry exists, and that its
  // handler body still calls the real skillCommand.
  assert.ok(HANDLERS.has("skill"), "HANDLERS must have a 'skill' entry for dispatchCommand to resolve");
  assert.match(runTaskSrc, /skillCommand\(rest\)/, "the 'skill' command must call skillCommand");
});

test("skillCommand's 'list' subcommand loads the SHIPPED registry via loadSkillRegistry(skillsDir(repoRoot)) — never a hardcoded list", () => {
  assert.match(runTaskSrc, /sub !== "list"/, "skillCommand must gate on the 'list' subcommand (fail loud on an unknown one)");
  assert.match(
    runTaskSrc,
    /loadSkillRegistry\(skillsDir\(repoRoot\)\)/,
    "skill list must resolve the registry from .remudero/skills/ via the lib loader",
  );
  assert.match(runTaskSrc, /renderSkillList\(/, "skill list must render via the lib's renderSkillList, not ad-hoc formatting");
});

test("skillCommand validates its args via unknownArgError BEFORE any read — fail loud, spawn/read nothing on bad input", () => {
  const skillCommandMatch = runTaskSrc.match(/async function skillCommand[\s\S]*?\n}\n/);
  assert.ok(skillCommandMatch, "skillCommand function body must be present");
  const body = skillCommandMatch![0];
  assert.match(body, /unknownArgError\(/, "skillCommand must validate rest args via unknownArgError");
});

test("USAGE documents `rmd skill list`", () => {
  assert.match(runTaskSrc, /rmd skill list/, "the USAGE banner must document the new command");
});

test("the skill lib is imported from ./lib/skill.js (config lives in .remudero/skills, loader lives in src/lib)", () => {
  assert.match(runTaskSrc, /from "\.\/lib\/skill\.js"/);
});

test("W1-T11926 criterion 2: the CLI entry point installs the production ledger writer", async (t) => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}credential-sink-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const stateDir = join(root, "remudero", "state");
  const ghConfigDir = join(root, "gh-config");
  for (const dir of [join(home, ".config", "remudero"), stateDir, ghConfigDir]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({
    root: join(root, "remudero"),
    claudeBin: "/usr/bin/claude",
  }));
  writeFileSync(join(ghConfigDir, "hosts.yml"), "github.com:\n    user: test-user\n");

  // Make sure main() installs its own sink instead of relying on a previously installed writer.
  installGithubCredentialMissingSink(undefined);
  const saved = new Map<string, string | undefined>();
  for (const key of ["HOME", "GH_TOKEN", "GITHUB_TOKEN", "GH_CONFIG_DIR", "XDG_CONFIG_HOME"]) saved.set(key, process.env[key]);
  const originalArgv = process.argv;
  process.env.HOME = home;
  delete process.env.GH_TOKEN;
  delete process.env.GITHUB_TOKEN;
  process.env.GH_CONFIG_DIR = ghConfigDir;
  delete process.env.XDG_CONFIG_HOME;
  process.argv = ["node", "rmd", "skill", "sink-install-probe"];
  class Exit extends Error {
    constructor(readonly code: number | undefined) { super(`process.exit(${code})`); }
  }
  t.mock.method(process, "exit", ((code?: number): never => { throw new Exit(code); }) as typeof process.exit);
  try {
    let caught: unknown;
    await main({
      checkFreshness: () => ({ status: "guarded" }),
      dispatch: async () => {
        assert.throws(
          () => resolveGithubCredential({ env: process.env, repo: "acme/widgets", operation: "gh pr review" }),
          GithubCredentialMissingError,
        );
        return 0;
      },
    }).catch((error: unknown) => { caught = error; });
    assert.ok(caught instanceof Exit && caught.code === 0, `expected a clean CLI exit, got ${String(caught)}`);
    const rows = readFileSync(join(stateDir, LEDGER_FILENAME), "utf8").trim().split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((row) => row.step === GITHUB_CREDENTIAL_MISSING_STEP);
    assert.equal(rows.length, 1, "main() writes the missing-credential row through the live ledger writer");
    assert.equal(rows[0]?.operation, "gh pr review");
    assert.equal(rows[0]?.repo, "acme/widgets");
    assert.doesNotMatch(JSON.stringify(rows[0]), /test-token/);
  } finally {
    process.argv = originalArgv;
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    installGithubCredentialMissingSink(undefined);
  }
});
