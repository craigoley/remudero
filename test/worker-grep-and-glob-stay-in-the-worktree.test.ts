import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

// W1-T5354 — WORKER GREP, GLOB AND CODEX apply_patch STAY IN THE WORKTREE. W1-T5016 confined
// Read/Write/Edit/MultiEdit/NotebookEdit through rule 14 of hooks/deny-floor.sh, but Grep in content mode
// returns file bodies just as Read does, Glob enumerates names, and neither was in settings/worker.json's
// matcher. Every case runs the hook through the EXACT command settings/worker.json configures, with the env
// the CLI hands a hook (CLAUDE_PROJECT_DIR = spawnWorker's cwd, the assigned worktree).

const WORKER_SETTINGS_PATH = fileURLToPath(new URL("../settings/worker.json", import.meta.url));
const HOOKS_DIR = fileURLToPath(new URL("../hooks", import.meta.url));

interface WorkerHookEntry {
  matcher: string;
  hooks: Array<{ type: string; command: string }>;
}

function workerFloorEntry(): WorkerHookEntry {
  const settings = JSON.parse(readFileSync(WORKER_SETTINGS_PATH, "utf8")) as {
    hooks: { PreToolUse: WorkerHookEntry[] };
  };
  const entry = settings.hooks.PreToolUse.find((e) => e.hooks.some((h) => h.command.includes("deny-floor.sh")));
  assert.ok(entry, "settings/worker.json must route PreToolUse through hooks/deny-floor.sh");
  return entry;
}

function workerFloorCommand(): string {
  const hook = workerFloorEntry().hooks.find((h) => h.command.includes("deny-floor.sh"));
  assert.ok(hook);
  return hook.command.split("${HOOKS_DIR}").join(HOOKS_DIR);
}

interface Fixture {
  root: string;
  worktree: string;
  sibling: string;
  scratch: string;
  home: string;
}

// The hook's TMPDIR is a dedicated `scratch` child, so the sibling checkout is NOT under an allowed root.
function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t5354-`));
  const worktree = join(root, "worktree");
  const sibling = join(root, "sibling-worktree");
  const scratch = join(root, "scratch");
  const home = join(root, "worker-home-run1");
  for (const dir of [join(worktree, "src"), join(sibling, "src"), scratch, home]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(worktree, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(sibling, "src", "a.ts"), "export const secret = 1;\n");
  const sharedDeps = join(root, "shared-deps", "node_modules");
  mkdirSync(join(sharedDeps, "pkg"), { recursive: true });
  writeFileSync(join(sharedDeps, "pkg", "index.d.ts"), "export {};\n");
  symlinkSync(sharedDeps, join(worktree, "node_modules"));
  return { root, worktree, sibling, scratch, home };
}

function runHook(
  fx: Fixture,
  payload: Record<string, unknown>,
  opts: { command?: string; codex?: boolean } = {},
): { status: number | null; stderr: string } {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: fx.home,
    TMPDIR: fx.scratch,
    XDG_CACHE_HOME: join(fx.root, "cache"),
    CLAUDE_PROJECT_DIR: fx.worktree,
  };
  // A Codex hook gets no CLAUDE_PROJECT_DIR, so the floor anchors on the payload cwd.
  if (opts.codex) delete env.CLAUDE_PROJECT_DIR;
  const result = spawnSync("bash", ["-c", opts.command ?? workerFloorCommand()], {
    input: JSON.stringify({ cwd: fx.worktree, ...payload }),
    encoding: "utf8",
    env,
  });
  return { status: result.status, stderr: result.stderr };
}

const tool = (fx: Fixture, name: string, input: Record<string, unknown>, opts: { command?: string } = {}) =>
  runHook(fx, { tool_name: name, tool_input: input }, opts);

test("W1-T5354: worker Grep and Glob outside the worktree are refused; no path, in-worktree and node_modules are allowed", () => {
  const fx = fixture();
  try {
    const matcher = workerFloorEntry().matcher.split("|");
    for (const name of ["Grep", "Glob"]) assert.ok(matcher.includes(name), `the worker matcher must route ${name} through the floor`);

    // Refused: a path naming a sibling worktree, a file in it, or an absolute Glob pattern rooted in it.
    for (const name of ["Grep", "Glob"]) {
      const out = tool(fx, name, { pattern: "secret", path: fx.sibling });
      assert.equal(out.status, 2, `${name} path=/sibling-worktree must be refused`);
      assert.match(out.stderr, /outside the assigned worktree/);
      assert.match(out.stderr, /W1-T5354/);
    }
    assert.equal(tool(fx, "Grep", { pattern: "secret", path: join(fx.sibling, "src", "a.ts"), output_mode: "content" }).status, 2);
    const absGlob = tool(fx, "Glob", { pattern: `${fx.sibling}/**/*.ts` });
    assert.equal(absGlob.status, 2, "Glob pattern=/sibling/**/*.ts must be refused");
    assert.match(absGlob.stderr, /outside the assigned worktree/);
    assert.equal(
      tool(fx, "Glob", { pattern: `${fx.sibling}/**/*.ts`, path: fx.worktree }).status,
      2,
      "an absolute pattern is checked even when path is inside the worktree",
    );
    // The literal prefix stops at the last `/` before the first metacharacter: `<worktree>*` also matches
    // `<worktree>-sibling`, so it is judged by its parent, which is outside.
    assert.equal(tool(fx, "Glob", { pattern: `${fx.worktree}*/src/*.ts` }).status, 2);
    assert.equal(tool(fx, "Glob", { pattern: "../sibling-worktree/**/*.ts" }).status, 2, "a `..` pattern climbs out");
    assert.equal(tool(fx, "Glob", { pattern: `${fx.worktree}/*/../../sibling-worktree/**` }).status, 2);
    assert.equal(tool(fx, "Grep", { pattern: "x", path: "../sibling-worktree" }).status, 2);
    assert.equal(tool(fx, "Grep", { pattern: "x", path: "~/../.." }).status, 2, "a `~` path is not resolved by the floor, so it fails closed");

    // Symlink resolution exactly as rule 14: a link inside the worktree that leads out is refused.
    symlinkSync(fx.sibling, join(fx.worktree, "escape"));
    assert.equal(tool(fx, "Grep", { pattern: "secret", path: join(fx.worktree, "escape") }).status, 2);
    assert.equal(tool(fx, "Glob", { pattern: `${fx.worktree}/escape/**/*.ts` }).status, 2);

    // Allowed: the common shape names no path, and the target is the session cwd — the worktree.
    assert.equal(tool(fx, "Grep", { pattern: "export", output_mode: "content" }).status, 0, "a no-path Grep is never refused");
    assert.equal(tool(fx, "Grep", { pattern: "export", path: "" }).status, 0, "an empty path is the cwd too");
    assert.equal(tool(fx, "Glob", { pattern: "**/*.ts" }).status, 0, "a relative pattern with no path is the cwd");
    assert.equal(tool(fx, "Grep", { pattern: "export", glob: "**/*.ts" }).status, 0);
    assert.equal(tool(fx, "Grep", { pattern: "export", path: join(fx.worktree, "src") }).status, 0);
    assert.equal(tool(fx, "Grep", { pattern: "export", path: "src" }).status, 0, "a relative path resolves against cwd");
    assert.equal(tool(fx, "Glob", { pattern: "*.ts", path: join(fx.worktree, "src") }).status, 0);
    assert.equal(tool(fx, "Glob", { pattern: `${fx.worktree}/src/**/*.ts` }).status, 0);
    // Reads through the worktree's own node_modules link, as rule 14 allows Read.
    assert.equal(tool(fx, "Grep", { pattern: "export", path: join(fx.worktree, "node_modules", "pkg") }).status, 0);
    assert.equal(tool(fx, "Glob", { pattern: `${fx.worktree}/node_modules/pkg/*.d.ts` }).status, 0);
    // The scratch root and the worker home.
    assert.equal(tool(fx, "Grep", { pattern: "x", path: fx.scratch }).status, 0);
    assert.equal(tool(fx, "Glob", { pattern: "*", path: fx.home }).status, 0);

    // A no-path call from a cwd outside the worktree searches that cwd, so it is judged like a path.
    assert.equal(runHook(fx, { tool_name: "Grep", tool_input: { pattern: "x" }, cwd: fx.sibling }).status, 2);

    // The interactive lane calls the hook WITHOUT --confine-file-tools and is unchanged.
    const bare = { command: `bash ${join(HOOKS_DIR, "deny-floor.sh")}` };
    assert.equal(tool(fx, "Grep", { pattern: "secret", path: fx.sibling }, bare).status, 0);
    assert.equal(tool(fx, "Glob", { pattern: `${fx.sibling}/**/*.ts` }, bare).status, 0);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

// THE CODEX FINDING. Captured 2026-10-03 from the installed codex-cli 0.159.0 (copied out of the remudero
// image), run `codex exec --enable hooks --dangerously-bypass-hook-trust` against a local fake Responses
// endpoint that answered with one freeform `apply_patch` call, the hook a recorder. Codex's own edit tool
// DOES reach PreToolUse: tool_name "apply_patch", the patch text in tool_input.command, and the matchers
// `Edit`, `Write` and `apply_patch` each routed it (`Bash` alone did not). This is the recorded payload,
// with only the paths templated. Its `cwd` is the worker cwd; Codex sets no CLAUDE_PROJECT_DIR of its own.
function codexApplyPatchPayload(cwd: string, patch: string): Record<string, unknown> {
  return {
    session_id: "01a0ffb8-612e-7a82-91be-2923641861c7",
    turn_id: "01a0ffb8-6148-7201-bd5a-a954c3433739",
    transcript_path: join(cwd, "..", "rollout.jsonl"),
    cwd,
    hook_event_name: "PreToolUse",
    model: "gpt-6-luna",
    permission_mode: "bypassPermissions",
    tool_name: "apply_patch",
    tool_input: { command: patch },
    tool_use_id: "call_1",
  };
}

test("W1-T5354: a Codex apply_patch reaches the hook, and rule 14 refuses a patch header outside the worktree", () => {
  const fx = fixture();
  try {
    const matcher = workerFloorEntry().matcher.split("|");
    assert.ok(matcher.includes("apply_patch"), "the worker matcher names Codex's edit tool, not only its Edit/Write aliases");

    const patch = (...headers: string[]) => `*** Begin Patch\n${headers.join("\n")}\n*** End Patch\n`;
    const codex = (p: string) => runHook(fx, codexApplyPatchPayload(fx.worktree, p), { codex: true });

    const escaped = codex(patch(`*** Add File: ${join(fx.sibling, "escaped.txt")}`, "+hello", "*** Update File: src/a.ts", "@@", "-a", "+b"));
    assert.equal(escaped.status, 2, "the captured payload's Add File outside the worktree is refused");
    assert.match(escaped.stderr, /outside the assigned worktree/);
    assert.match(escaped.stderr, /W1-T5354/);
    assert.equal(codex(patch(`*** Update File: ${join(fx.sibling, "src", "a.ts")}`, "@@", "-a", "+b")).status, 2);
    assert.equal(codex(patch(`*** Delete File: ${join(fx.sibling, "src", "a.ts")}`)).status, 2);
    assert.equal(codex(patch("*** Update File: src/a.ts", `*** Move to: ${join(fx.sibling, "moved.ts")}`, "@@", "-a", "+b")).status, 2);
    assert.equal(codex(patch("*** Add File: ../sibling-worktree/x.ts", "+x")).status, 2, "a relative `..` header climbs out");
    assert.equal(codex(patch(`   *** Add File: ${join(fx.sibling, "indented.ts")}`, "+x")).status, 2, "Codex trims header lines");
    assert.equal(codex(patch(`*** Add File: ${join(fx.worktree, "node_modules", "pkg", "x.d.ts")}`, "+x")).status, 2, "writes never go through node_modules");
    assert.equal(codex("*** Begin Patch\n*** End Patch\n").status, 2, "a patch naming no file fails closed");

    // In-worktree edits stay available, relative or absolute, including a scratch file.
    assert.equal(codex(patch("*** Update File: src/a.ts", "@@", "-a", "+b")).status, 0);
    assert.equal(codex(patch(`*** Add File: ${join(fx.worktree, "src", "new", "b.ts")}`, "+b", "*** Delete File: src/a.ts")).status, 0);
    assert.equal(codex(patch("*** Update File: src/a.ts", "*** Move to: src/c.ts", "@@", "-a", "+b")).status, 0);
    assert.equal(codex(patch(`*** Add File: ${join(fx.scratch, "notes.md")}`, "+n")).status, 0);

    // The interactive lane is unchanged.
    const bare = spawnSync("bash", ["-c", `bash ${join(HOOKS_DIR, "deny-floor.sh")}`], {
      input: JSON.stringify(codexApplyPatchPayload(fx.worktree, patch(`*** Add File: ${join(fx.sibling, "x.ts")}`, "+x"))),
      encoding: "utf8",
      env: { ...process.env, HOME: fx.home, TMPDIR: fx.scratch, XDG_CACHE_HOME: join(fx.root, "cache") },
    });
    assert.equal(bare.status, 0);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});
