// W1-T10763: a codex worker's tool calls never reached the ledger. `spawnCodexWorker` reported only
// `working`/`message` events, so the run-task observer wrote no `tool-executing` `worker.activity` row
// for a codex run, and `rmd procedures` counted most codex runs as runs that took no step. Each
// `item.completed` command_execution and file_change now reaches the observer as a tool call.
//
// The stream below is fed through the REAL stream handling (the stdout parser inside
// `spawnCodexWorker`) into the REAL `worker.activity` observer. Its items carry exactly the fields
// codex-cli 0.163.0 (the version deploy/package-lock.json pins) writes in `exec --json`:
// `command_execution` {id, command, aggregated_output, exit_code, status}, and `file_change`
// {id, changes: [{path, kind: "add" | "delete" | "update"}], status}. Codex runs a command through
// its shell (`/bin/bash -lc`, measured in W1-T2754), and the fixture's command names that wrapper. A
// bare command reads the same: either way the tool call is the script, so its signature reads
// `Bash:git push` exactly as a claude row's does.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { readLedgerLines } from "#src/lib/status.js";
import type { WorkerStreamEvent } from "#src/lib/worker.js";
import { CODEX_SHELL_WRAPPER_RE, codexCommandScript, spawnCodexWorker, UNQUOTED_LITERAL_RE } from "#src/lib/worker-provider.js";
import { buildWorkerStateSensor, ledgerPathFor, WORKER_ACTIVITY_LEDGER_STEP } from "#src/run-task.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const COMMAND = "/bin/bash -lc 'git push origin HEAD'";

function recordedStream(worktree: string): string[] {
  const commandItem = { id: "item_0", type: "command_execution", command: COMMAND };
  const changes = [
    { path: join(worktree, "src", "lib", "worker-provider.ts"), kind: "update" },
    { path: join(worktree, "test", "learning", "a-new.test.ts"), kind: "add" },
  ];
  return [
    { type: "thread.started", thread_id: "thread-w1t10763" },
    { type: "turn.started" },
    { type: "item.started", item: { ...commandItem, aggregated_output: "", exit_code: null, status: "in_progress" } },
    { type: "item.completed", item: { ...commandItem, aggregated_output: "Everything up-to-date\n", exit_code: 0, status: "completed" } },
    { type: "item.started", item: { id: "item_1", type: "file_change", changes, status: "in_progress" } },
    { type: "item.completed", item: { id: "item_1", type: "file_change", changes, status: "completed" } },
    { type: "item.completed", item: { id: "item_2", type: "agent_message", text: "Pushed the fix." } },
    { type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10 } },
  ].map((event) => `${JSON.stringify(event)}\n`);
}

/** One codex run over {@link recordedStream}: every stream event, and the `worker.activity` rows it wrote. */
async function runRecordedStream(): Promise<{ worktree: string; events: WorkerStreamEvent[]; rows: Record<string, unknown>[]; ledgerText: string }> {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1t10763-"));
  try {
    const worktree = join(root, "wt");
    const workerHome = join(root, "home");
    mkdirSync(worktree);
    mkdirSync(workerHome);
    const ledgerPath = ledgerPathFor({ root });
    const sensor = buildWorkerStateSensor({ ledgerPath, runId: "run-w1t10763", taskId: "W1-T10763", root });
    const events: WorkerStreamEvent[] = [];
    const stdout = new PassThrough();
    const proc = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout, stderr: new PassThrough() });
    const run = spawnCodexWorker(
      {
        cwd: worktree,
        workerHome,
        prompt: "push the fix",
        settingsFile: join(REPO_ROOT, "settings", "worker.json"),
        streamObserver: (event) => {
          events.push(event);
          sensor.observer(event);
        },
        containment: { spawn: () => ({ process: proc as never, pid: 10_763 }), teardown: () => {} },
      },
      { claudeBin: "/unused", root, workerProviders: { enabled: ["codex"], codexBin: "/bin/sh", codexModel: "codex-fixture" } },
    );
    for (const line of recordedStream(worktree)) stdout.write(line);
    stdout.end();
    proc.emit("exit", 0);
    const result = await run;
    assert.equal(result.isError, false);
    const rows = readLedgerLines(ledgerPath).filter((line) => line.step === WORKER_ACTIVITY_LEDGER_STEP);
    return { worktree, events, rows, ledgerText: readFileSync(ledgerPath, "utf8") };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("W1-T10763: a codex command execution is reported as a Bash tool call carrying its command", async () => {
  const { worktree, events, rows, ledgerText } = await runRecordedStream();
  const toolEvents = events.filter((event) => event.kind === "tool-executing");
  assert.ok(toolEvents.length > 0, `a codex command reaches the observer as a tool call; saw ${JSON.stringify(events.map((e) => e.kind))}`);
  assert.deepEqual(
    { toolName: toolEvents[0]?.toolName, toolInput: toolEvents[0]?.toolInput, cwd: toolEvents[0]?.cwd, text: toolEvents[0]?.text },
    { toolName: "Bash", toolInput: { command: "git push origin HEAD" }, cwd: worktree, text: "[tool_use: Bash]" },
  );
  assert.ok(events.some((event) => event.kind === "working"), "the existing working events stay");
  const toolRows = rows.filter((row) => row.event_kind === "tool-executing");
  assert.equal(toolRows[0]?.tool_name, "Bash");
  assert.equal(toolRows[0]?.tool_call_index, 0, "the started item is not a second call: one row per completed item");
  assert.equal(toolRows[0]?.tool_signature, "Bash:git push", "signed by the script, as a claude row is, not `Bash:bash`");
  assert.equal(ledgerText.includes("Everything up-to-date"), false, "the ledger never carries command output");
});

test("W1-T10763: a codex file change is reported as a file tool call per changed path", async () => {
  const { worktree, events, rows } = await runRecordedStream();
  const fileEvents = events.filter((event) => event.kind === "tool-executing" && event.toolName !== "Bash");
  assert.deepEqual(
    fileEvents.map((event) => ({ toolName: event.toolName, toolInput: event.toolInput, cwd: event.cwd })),
    [
      { toolName: "Edit", toolInput: { file_path: join(worktree, "src", "lib", "worker-provider.ts") }, cwd: worktree },
      { toolName: "Write", toolInput: { file_path: join(worktree, "test", "learning", "a-new.test.ts") }, cwd: worktree },
    ],
  );
  const toolRows = rows.filter((row) => row.event_kind === "tool-executing");
  assert.deepEqual(
    toolRows.map((row) => [row.tool_name, row.tool_signature, row.tool_call_index]),
    [["Bash", "Bash:git push", 0], ["Edit", "Edit:src/lib/worker-provider.ts", 1],
      ["Write", "Write:test/learning/a-new.test.ts", 2]],
    "each changed path is one tool row whose signature is repo-relative, as a claude row's is",
  );
});

test("a codex command is unwrapped only when its shell runs one literal script", () => {
  // Every quoting a shell-join of argv can produce reads back to the same script.
  for (const line of ["/bin/bash -lc 'git push origin HEAD'", 'bash -lc "git push origin HEAD"', "sh -c git\\ push\\ origin\\ HEAD",
    "/usr/bin/zsh -lc 'git push origin '\"HEAD\"", "/bin/bash -c 'git push origin HEAD'"]) {
    assert.equal(codexCommandScript(line), "git push origin HEAD", line);
  }
  assert.equal(codexCommandScript(`/bin/bash -lc 'echo it'"'"'s'`), "echo it's", "a quote the join escaped");
  assert.equal(codexCommandScript(`/bin/bash -lc 'echo it'\\''s'`), "echo it's", "a quote escaped the other way");
  assert.equal(codexCommandScript(`/bin/bash -lc "echo \\$HOME"`), "echo $HOME", "an escaped dollar is literal");
  assert.equal(CODEX_SHELL_WRAPPER_RE.test("/bin/bash -lc 'git status'"), true);
  assert.equal(CODEX_SHELL_WRAPPER_RE.test("python -c 'print(1)'"), false);
  assert.equal(UNQUOTED_LITERAL_RE.test("a"), true);
  assert.equal(UNQUOTED_LITERAL_RE.test("$"), false);
  // Anything that expands, or is not one word under a known shell, is reported as it came.
  for (const line of [`/bin/bash -lc "git push $REMOTE"`, "/bin/bash -lc 'git push' extra", "/bin/bash -lc 'unterminated",
    "/bin/bash -lc git*", "/bin/bash -lc ''", "python -c 'print(1)'", "git push origin HEAD", "/bin/bash -lc `id`",
    "/bin/bash scripts/setup.sh"]) {
    assert.equal(codexCommandScript(line), line, line);
  }
});
