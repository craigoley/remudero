// W1-T5352: rule 1 of hooks/deny-floor.sh judged a `git push` segment with two loose greps -- a force
// flag anywhere in it AND the substring `main|master` anywhere in it. So a forced push of a run branch
// whose NAME held "main" was refused, while `+HEAD:main`, `--force-with-lease origin main`, `-fu`,
// `HEAD:refs/heads/master` behind `-C`, `:main` and `--delete main` all passed. The rule now parses
// the push and refuses by its DESTINATION ref: force, delete and plain pushes whose destination is
// exactly main or master, in any refspec spelling.
//
// Every case runs through BOTH lanes' configured hook command, rendered the way each lane renders it:
// the interactive lane's `.claude/settings.json` (`$CLAUDE_PROJECT_DIR`) and the worker lane's
// `settings/worker.json` template (`${HOOKS_DIR}`, substituted as renderWorkerSettings does).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const HOOKS_DIR = join(REPO_ROOT, "hooks");

interface HookSettings {
  hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> };
}

function denyFloorCommand(settingsFile: string): string {
  const settings = JSON.parse(readFileSync(join(REPO_ROOT, settingsFile), "utf8")) as HookSettings;
  const commands = settings.hooks.PreToolUse.flatMap((m) => m.hooks.map((h) => h.command));
  const command = commands.find((c) => c.includes("deny-floor.sh"));
  assert.ok(command, `${settingsFile} configures no deny-floor.sh hook`);
  return command;
}

const LANES = [
  { lane: "interactive", command: denyFloorCommand(".claude/settings.json") },
  { lane: "worker", command: denyFloorCommand("settings/worker.json").split("${HOOKS_DIR}").join(HOOKS_DIR) },
];

function run(hookCommand: string, command: string): { status: number | null; stderr: string } {
  const scratch = mkdtempSync(join(tmpdir(), "rmd-push-tripwire-"));
  try {
    const r = spawnSync("bash", ["-c", hookCommand], {
      input: JSON.stringify({ cwd: scratch, tool_name: "Bash", tool_input: { command } }),
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: REPO_ROOT, XDG_CACHE_HOME: scratch },
    });
    return { status: r.status, stderr: r.stderr };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const FORCE = /git push --force to a default branch/;
const DELETE = /deleting a default branch/;
const PLAIN = /a push to a default branch — open a PR/;
const ANY_PUSH_REFUSAL = /default branch|unparseable git push/;

const ALLOWED = [
  "git push origin HEAD:refs/heads/run-W1-T5175-1790953587398",
  "git push origin HEAD:refs/heads/run-W1-T5175-1790953587398 && gh api --method POST repos/o/r/pulls -f title=x -f head=run-W1-T5175-1790953587398 -f base=main",
  "git push -f origin HEAD:refs/heads/run-fix-main-gate-1",
  "git -C /x/wt-main push --force origin run-x",
  "git push --force-with-lease origin HEAD:refs/heads/run-x",
  "git push origin HEAD:refs/heads/run-x # main",
  "git push origin HEAD",
  "git push",
  "git push -u origin run-domain-maintenance",
  "git push -f origin remain:refs/heads/run-master-plan",
  "git push -o ci.skip origin run-x",
  "git push origin main:refs/heads/run-from-main",
  "git commit -m 'never git push origin main' && git push origin run-x",
  "git log --oneline origin/main..HEAD && git push origin run-x 2>&1",
];

const REFUSED: Array<[string, RegExp]> = [
  ["git push --force origin main", FORCE],
  ["git push -f origin master", FORCE],
  ["git push origin main --force", FORCE],
  ["git push origin +HEAD:main", FORCE],
  ["git push --force-with-lease origin main", FORCE],
  ["git push --force-with-lease=main:abc origin HEAD:main", FORCE],
  ["git push -fu origin HEAD:main", FORCE],
  ["git push -uf origin HEAD:refs/heads/main", FORCE],
  ["git push --force-if-includes origin main", FORCE],
  ["git -C /x push -f origin HEAD:refs/heads/master", FORCE],
  ["git -c push.default=current push -f origin main", FORCE],
  ["echo ready && git push --force origin main", FORCE],
  ["git push --mirror origin", FORCE],
  ["git push origin :main", DELETE],
  ["git push origin --delete main", DELETE],
  ["git push -d origin master", DELETE],
  ["git push origin :refs/heads/master", DELETE],
  ["git push origin main", PLAIN],
  ["git push origin HEAD:refs/heads/main", PLAIN],
  ["git push origin HEAD:main", PLAIN],
  ["git push -u origin 'main'", PLAIN],
  ["git push origin run-x main", PLAIN],
];

test("a push is refused or allowed by its destination ref: a run branch whose name or path contains main is allowed", () => {
  for (const { lane, command: hook } of LANES) {
    for (const command of ALLOWED) {
      const { status, stderr } = run(hook, command);
      assert.doesNotMatch(stderr, ANY_PUSH_REFUSAL, `[${lane}] wrongly refused: ${command}`);
      assert.equal(status, 0, `[${lane}] must allow: ${command} (stderr: ${stderr})`);
    }
  }
});

test("a push is refused or allowed by its destination ref: force, delete or plain pushes to main or master are refused in every refspec spelling", () => {
  for (const { lane, command: hook } of LANES) {
    for (const [command, reason] of REFUSED) {
      const { status, stderr } = run(hook, command);
      assert.equal(status, 2, `[${lane}] must refuse: ${command}`);
      assert.match(stderr, reason, `[${lane}] wrong refusal for: ${command}`);
      assert.match(stderr, /^deny-floor: blocked — /, `[${lane}] refusal lost its shape: ${command}`);
    }
  }
});
