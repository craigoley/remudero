import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HOOK = fileURLToPath(new URL("../hooks/deny-floor.sh", import.meta.url));

function run(command: string): { status: number | null; stderr: string } {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.RMD_HOUSE_RULE_OVERRIDE;
  const result = spawnSync("bash", [HOOK], {
    cwd: tmpdir(),
    input: JSON.stringify({
      tool_name: "Bash",
      cwd: "/nonexistent-env-split-test-cwd",
      tool_input: { command },
    }),
    encoding: "utf8",
    env,
  });
  return { status: result.status, stderr: result.stderr };
}

function assertRefused(command: string, message: RegExp): void {
  const result = run(command);
  assert.equal(result.status, 2, `expected refusal: ${command}\n${result.stderr}`);
  assert.match(result.stderr, message, `refusal must name the applicable floor rule: ${command}`);
}

test("env split-string cannot hide a refused stash command from deny-floor", () => {
  for (const command of [
    "env -S 'git stash'",
    "env -S'git stash'",
    "env -i -S 'git stash'",
    "env --split-string='git stash'",
    "env -S 'RMD_HOUSE_RULE_OVERRIDE=stash git stash'",
    "env -S 'git' stash",
    "env -P /usr/bin git stash",
    "env -u HOME git stash",
    "env -S 'env -S \"git stash\"'",
  ]) {
    assertRefused(command, /house rule: never stash/);
  }
});

test("env argv preserves harmless near-misses while refusing the neighboring stash", () => {
  for (const command of [
    "env -S 'echo git stash'",
    "env -S 'echo x; git stash'",
    "env -P /usr/bin echo git stash",
    "env -S 'git stash list'",
  ]) {
    const result = run(command);
    assert.equal(result.status, 0, `expected allowed argv: ${command}\n${result.stderr}`);
  }
  assertRefused("env -S 'git stash pop'", /house rule: never stash/);
});

test("env split-string cannot hide destructive SSH commands from deny-floor", () => {
  assertRefused("env -S 'ssh remudero killall node'", /READ-ONLY for sessions \(house rule\)/);
  assertRefused(
    "env -S 'ssh remudero bash' <<'EOF'\nkillall node\nEOF",
    /READ-ONLY for sessions \(house rule\)/,
  );
  const readOnly = run("env -S 'ssh remudero ps aux'");
  assert.equal(readOnly.status, 0, readOnly.stderr);
});
