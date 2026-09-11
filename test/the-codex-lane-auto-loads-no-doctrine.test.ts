// W1-T3135 — THE CODEX LANE'S ROUTE TO REPOSITORY DOCTRINE.
//
// Codex's native project-doc reader loads AGENTS.md; this repo has none, so before this task the
// lane auto-loaded NOTHING and the only surviving route was a prose sentence asking the model to
// read a file itself — which also named AGENTS.md, a file that does not exist.
//
// MEASURED 2026-09-09 on codex-cli 0.152.0 in the running image, each probe prompted "Do not read
// or open any files" so a correct answer proves AUTO-INJECTION rather than tool use:
//   control, no flags .......................................... "UNKNOWN"
//   + project_doc_fallback_filenames=["CLAUDE.md"] .............. the canary
//   same flags under --sandbox workspace-write (the real lane) .. the canary
//   71938-byte doc at the default cap ........... head present, TAIL MISSING
//   same doc at project_doc_max_bytes=262144 .... head present, tail present
// The 32768 default was BRACKETED, not assumed: 32313 bytes keeps its tail, 33019 loses it.
//
// THE TWO FLAGS ARE ONE CHANGE. The fallback WITHOUT the cap is worse than neither: it loads
// CLAUDE.md and truncates it mid-rule at a byte offset, so a worker acts confidently on a document
// it cannot know was cut. Criterion 3 below is what stops them being separated.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CODEX_DOCTRINE_PRELUDE, CODEX_PROJECT_DOC_MAX_BYTES, spawnCodexWorker } from "../src/lib/worker-provider.js";
import type { ContainedSpawnOptions } from "../src/lib/worker-containment.js";

function deferredCodexProcess() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const proc = Object.assign(new EventEmitter(), { stdin, stdout, stderr });
  return {
    process: proc,
    finish(exitCode = 0) {
      stdout.write(`${JSON.stringify({ type: "thread.started", thread_id: "codex-doc" })}\n`);
      stdout.write(`${JSON.stringify({ type: "turn.started" })}\n`);
      stdout.write(`${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "done" } })}\n`);
      stdout.write(`${JSON.stringify({ type: "turn.completed", usage: {} })}\n`);
      stdout.end();
      queueMicrotask(() => proc.emit("exit", exitCode));
    },
  };
}

/** Spawn one Codex worker and hand back the argv the containment layer was asked to run — the
 *  SAME observation seam test/a-codex-worker-starts-outside-a-git-repository.test.ts uses, so the
 *  two suites can never disagree about what production actually passes. */
async function capturedArgs(): Promise<string[]> {
  const root = mkdtempSync(join(tmpdir(), "rmd-codex-doc-"));
  const controlled = deferredCodexProcess();
  let options: ContainedSpawnOptions | undefined;
  const promise = spawnCodexWorker(
    {
      workerHome: mkdtempSync(join(tmpdir(), "rmd-codex-home-")),
      cwd: root,
      prompt: "probe",
      settingsFile: join(process.cwd(), "settings", "worker.json"),
      tools: ["Bash"],
      containment: {
        spawn: (opts) => {
          options = opts;
          return { process: controlled.process as never, pid: 31_002 };
        },
        teardown: () => {},
      },
    },
    {
      claudeBin: "/unused/claude",
      root,
      workerProviders: { enabled: ["codex" as const], codexBin: "/bin/sh", codexHome: join(root, "codex-home") },
    } as never,
  );
  controlled.finish();
  await promise;
  assert.ok(options, "the containment layer was asked to spawn Codex");
  return options.args;
}

test("W1-T3135: the Codex spawn points the project-doc reader at CLAUDE.md", async () => {
  const args = await capturedArgs();
  const fallback = args.find((a) => a.startsWith("project_doc_fallback_filenames="));
  assert.ok(fallback, `no project_doc_fallback_filenames in the spawn argv: ${args.join(" ")}`);
  assert.match(fallback, /CLAUDE\.md/, "the fallback must name CLAUDE.md, the one source of doctrine");
});

test("W1-T3135: the spawn pins an explicit project-doc byte cap", async () => {
  const args = await capturedArgs();
  const cap = args.find((a) => a.startsWith("project_doc_max_bytes="));
  assert.ok(cap, `no project_doc_max_bytes in the spawn argv: ${args.join(" ")}`);
  assert.equal(cap, `project_doc_max_bytes=${CODEX_PROJECT_DOC_MAX_BYTES}`);
});

test("W1-T3135: the pinned cap exceeds the committed CLAUDE.md ratchet ceiling", () => {
  // READ THE CEILING, NEVER RETYPE IT. A second hand-typed number is exactly how this silently
  // re-breaks: raise the doc budget past the Codex cap and the doctrine is truncated again with no
  // signal. Reading the baseline makes that raise fail HERE instead.
  const baseline = JSON.parse(readFileSync("scripts/claude-md-budget-baseline.json", "utf8")) as { capBytes: number };
  assert.equal(typeof baseline.capBytes, "number", "the CLAUDE.md ratchet must declare a numeric capBytes");
  assert.ok(
    CODEX_PROJECT_DOC_MAX_BYTES > baseline.capBytes,
    `the Codex project-doc cap (${CODEX_PROJECT_DOC_MAX_BYTES}) must exceed the CLAUDE.md ratchet ` +
      `ceiling (${baseline.capBytes}), or a doc grown to that ceiling ships truncated`,
  );
  // AND ABOVE THE FILE AS IT STANDS, so the assertion bites today and not only in principle.
  const actual = Buffer.byteLength(readFileSync("CLAUDE.md"));
  assert.ok(
    CODEX_PROJECT_DOC_MAX_BYTES > actual,
    `the cap (${CODEX_PROJECT_DOC_MAX_BYTES}) must exceed the committed CLAUDE.md (${actual} bytes)`,
  );
  // THE FALSIFIER, RUN RATHER THAN DESCRIBED: a ceiling above the constant must be refused. This is
  // the arm that proves the comparison is real and not a tautology over two constants that agree.
  const hostileCeiling = CODEX_PROJECT_DOC_MAX_BYTES + 1;
  assert.ok(!(CODEX_PROJECT_DOC_MAX_BYTES > hostileCeiling), "a ceiling above the cap must not pass");
});

test("W1-T3135: the Codex prelude names no instruction file this repository does not contain", async () => {
  // The prelude used to say "including CLAUDE.md and AGENTS.md" — and AGENTS.md has never existed
  // here, so the nudge asked every Codex worker to open a missing file. A sentence that names a
  // non-existent path teaches nothing and costs a turn.
  //
  // Asserted on the EXPORTED VALUE the spawn actually prepends, never on the source text of
  // worker-provider.ts (W1-T2905): a prose read passes when the wording is right and the wiring is
  // wrong, and this must fail if the constant stops reaching the prompt.
  assert.ok(CODEX_DOCTRINE_PRELUDE.length > 0, "the Codex prelude sentence must still exist");
  assert.ok(
    !/AGENTS\.md/.test(CODEX_DOCTRINE_PRELUDE),
    "the prelude must not name AGENTS.md, which this repo does not contain",
  );
  assert.match(CODEX_DOCTRINE_PRELUDE, /CLAUDE\.md/, "the prelude must still point at the file that does exist");

  // Every instruction file the prelude names must be one this checkout really tracks — the defect
  // was a named path that does not exist, so the check is existence, not a hard-coded filename.
  for (const named of CODEX_DOCTRINE_PRELUDE.match(/\b[A-Za-z0-9_.-]+\.md\b/g) ?? []) {
    assert.ok(existsSync(named), `the prelude names ${named}, which this repository does not contain`);
  }
});
