import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { createService } from "../src/lib/service.js";
import { assertProvenance, lintPrompt } from "../src/lib/provenance.js";
import { renderImplementPrompt, renderReconPrompt } from "../src/run-task.js";
import type { Task } from "../src/lib/plan.js";
import {
  appendOperatorNote,
  buildAddOperatorNoteRoute,
  buildListOperatorNotesRoute,
  loadOperatorNotesForTask,
  renderOperatorNotes,
  type OperatorNoteEntry,
} from "../src/lib/operator-notes.js";

// ── W1-T164 acceptance (plan/tasks.yaml):
//   (1) a stamped operator_note on task A is injected into task A's recon/implement prompt,
//       VERBATIM, with author+timestamp, scoped to A.
//   (2) a note on task A never appears in task B's prompt (cross-task-leakage falsifier).
//   (3) an UNSTAMPED note is REFUSED at injection — never rendered into any prompt.

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "rmd-operator-notes-"));
}

function storePath(root: string): string {
  return join(root, "plan", "operator-notes.ndjson");
}

function writeRawLine(root: string, obj: unknown): void {
  mkdirSync(join(root, "plan"), { recursive: true });
  appendFileSync(storePath(root), JSON.stringify(obj) + "\n");
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "W1-T900",
    title: "a task",
    repo: "remudero",
    depends_on: [],
    type: "implement",
    verify: "auto",
    risk: "medium",
    status: "queued",
    attempts: 0,
    ...overrides,
  };
}

// ── store: append + load round trip, scoping, provenance refusal ───────────────────────────

test("appendOperatorNote + loadOperatorNotesForTask: a stamped note round-trips, scoped to its task id", () => {
  const root = tmpRoot();
  const entry: OperatorNoteEntry = { ts: "2026-07-01T00:00:00.000Z", taskId: "W1-T1", author: "craig", note: "watch the mount table" };
  assert.equal(appendOperatorNote(root, entry), true);
  const loaded = loadOperatorNotesForTask(root, "W1-T1");
  assert.equal(loaded.length, 1);
  assert.deepEqual(loaded[0], entry);
});

test("loadOperatorNotesForTask: no store file yet -> [] (never throws)", () => {
  const root = tmpRoot();
  assert.deepEqual(loadOperatorNotesForTask(root, "W1-T1"), []);
});

test("CROSS-TASK LEAKAGE FALSIFIER: a note on task A is never returned for task B", () => {
  const root = tmpRoot();
  appendOperatorNote(root, { ts: "2026-07-01T00:00:00.000Z", taskId: "W1-T-A", author: "craig", note: "A-only guidance" });
  appendOperatorNote(root, { ts: "2026-07-01T00:01:00.000Z", taskId: "W1-T-B", author: "craig", note: "B-only guidance" });
  const forA = loadOperatorNotesForTask(root, "W1-T-A");
  const forB = loadOperatorNotesForTask(root, "W1-T-B");
  assert.equal(forA.length, 1);
  assert.equal(forA[0].note, "A-only guidance");
  assert.equal(forB.length, 1);
  assert.equal(forB[0].note, "B-only guidance");
  assert.ok(!forA.some((n) => n.note === "B-only guidance"), "task A must never see task B's note");
  assert.ok(!forB.some((n) => n.note === "A-only guidance"), "task B must never see task A's note");
});

test("appendOperatorNote WRITE-SIDE refuses an unstamped note (missing author) — writes nothing", () => {
  const root = tmpRoot();
  const written = appendOperatorNote(root, { ts: "2026-07-01T00:00:00.000Z", taskId: "W1-T1", author: "", note: "no author" } as OperatorNoteEntry);
  assert.equal(written, false);
  assert.ok(!existsSync(storePath(root)), "an unstamped note must not create/append the store at all");
});

test("appendOperatorNote WRITE-SIDE refuses a note with no timestamp / an unparseable timestamp", () => {
  const root = tmpRoot();
  assert.equal(appendOperatorNote(root, { ts: "", taskId: "W1-T1", author: "craig", note: "x" } as OperatorNoteEntry), false);
  assert.equal(appendOperatorNote(root, { ts: "not-a-date", taskId: "W1-T1", author: "craig", note: "x" } as OperatorNoteEntry), false);
});

test("READ-SIDE also refuses an unstamped line, even if it reached the file some other way (hand-edited)", () => {
  const root = tmpRoot();
  writeRawLine(root, { ts: "2026-07-01T00:00:00.000Z", taskId: "W1-T1", author: "craig", note: "stamped, fine" });
  writeRawLine(root, { ts: "2026-07-01T00:00:00.000Z", taskId: "W1-T1", note: "no author field at all" }); // unstamped
  writeRawLine(root, { taskId: "W1-T1", author: "craig", note: "no ts field at all" }); // unstamped
  writeRawLine(root, { ts: "2026-07-01T00:00:00.000Z", taskId: "W1-T1", author: "craig", note: "" }); // blank note
  const loaded = loadOperatorNotesForTask(root, "W1-T1");
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].note, "stamped, fine");
});

test("READ-SIDE skips a CORRUPT (non-JSON) line without crashing the read", () => {
  const root = tmpRoot();
  mkdirSync(join(root, "plan"), { recursive: true });
  appendFileSync(storePath(root), "this is not json at all — a torn/hand-mangled line\n");
  appendFileSync(
    storePath(root),
    JSON.stringify({ ts: "2026-07-01T00:00:00.000Z", taskId: "W1-T1", author: "craig", note: "good line" }) + "\n",
  );
  const loaded = loadOperatorNotesForTask(root, "W1-T1");
  assert.equal(loaded.length, 1, "the corrupt line is skipped; the surrounding good line still loads");
  assert.equal(loaded[0].note, "good line");
});

test("appendOperatorNote WRITE-SIDE returns false (never throws) when the store path cannot be written", () => {
  const root = tmpRoot();
  // Make the store path itself a DIRECTORY so appendFileSync throws (EISDIR) — the catch must
  // report the failure as `false`, matching worker.ts's appendQuestion non-blocking contract.
  mkdirSync(storePath(root), { recursive: true });
  const written = appendOperatorNote(root, {
    ts: "2026-07-01T00:00:00.000Z",
    taskId: "W1-T1",
    author: "craig",
    note: "x",
  });
  assert.equal(written, false, "a filesystem write failure is caught and reported as false, never thrown");
});

// ── render: verbatim injection with author+timestamp, provenance-cited ─────────────────────

test("renderOperatorNotes: renders the note VERBATIM with its author and timestamp, provenance-cited", () => {
  const entries: OperatorNoteEntry[] = [
    { ts: "2026-07-29T12:00:00.000Z", taskId: "W1-T1", author: "craig", note: "prefer the smaller diff here" },
  ];
  const block = renderOperatorNotes(entries);
  assert.match(block, /prefer the smaller diff here/);
  assert.match(block, /craig/);
  assert.match(block, /2026-07-29T12:00:00\.000Z/);
  assert.match(block, /\[src: operator#craig@2026-07-29T12:00:00\.000Z\]/);
});

test("renderOperatorNotes: [] -> \"\" (no notes for this task)", () => {
  assert.equal(renderOperatorNotes([]), "");
});

test("the operator# citation kind is ACCEPTED by the provenance linter (assertProvenance never throws on it)", () => {
  const block = renderOperatorNotes([{ ts: "2026-07-29T12:00:00.000Z", taskId: "W1-T1", author: "craig", note: "x" }]);
  const prompt = ["# CONTEXT", block, "", "# TASK", "do the thing"].join("\n");
  assert.equal(lintPrompt(prompt).ok, true);
  assert.doesNotThrow(() => assertProvenance(prompt));
});

// ── end-to-end through the actual prompt-assembly functions ────────────────────────────────

test("renderReconPrompt: a task's stamped operator note appears VERBATIM in the recon prompt, with author+timestamp", () => {
  const notes = loadOperatorNotesForTaskFixture([
    { ts: "2026-07-29T09:00:00.000Z", taskId: "W1-T1", author: "craig", note: "the sandbox flakes on the third retry — ignore it" },
  ], "W1-T1");
  const prompt = renderReconPrompt("", renderOperatorNotes(notes));
  assert.match(prompt, /the sandbox flakes on the third retry — ignore it/);
  assert.match(prompt, /craig/);
  assert.match(prompt, /2026-07-29T09:00:00\.000Z/);
});

test("renderImplementPrompt: a task's stamped operator note appears VERBATIM in the implement prompt, with author+timestamp", () => {
  const notes = loadOperatorNotesForTaskFixture([
    { ts: "2026-07-29T09:00:00.000Z", taskId: "W1-T1", author: "craig", note: "keep this change to one file" },
  ], "W1-T1");
  const prompt = renderImplementPrompt(task({ id: "W1-T1" }), "", "run-1", "", renderOperatorNotes(notes));
  assert.match(prompt, /keep this change to one file/);
  assert.match(prompt, /craig/);
  assert.match(prompt, /2026-07-29T09:00:00\.000Z/);
  assert.doesNotThrow(() => assertProvenance(prompt));
});

test("CROSS-TASK LEAKAGE FALSIFIER (end-to-end): task A's note never appears in task B's assembled prompt", () => {
  const root = tmpRoot();
  appendOperatorNote(root, { ts: "2026-07-29T09:00:00.000Z", taskId: "W1-T-A", author: "craig", note: "A-SPECIFIC-GUIDANCE-TOKEN" });
  appendOperatorNote(root, { ts: "2026-07-29T09:01:00.000Z", taskId: "W1-T-B", author: "craig", note: "B-SPECIFIC-GUIDANCE-TOKEN" });

  const blockForB = renderOperatorNotes(loadOperatorNotesForTask(root, "W1-T-B"));
  const implementPromptB = renderImplementPrompt(task({ id: "W1-T-B" }), "", "run-1", "", blockForB);
  const reconPromptB = renderReconPrompt("", blockForB);

  assert.doesNotMatch(implementPromptB, /A-SPECIFIC-GUIDANCE-TOKEN/);
  assert.doesNotMatch(reconPromptB, /A-SPECIFIC-GUIDANCE-TOKEN/);
  assert.match(implementPromptB, /B-SPECIFIC-GUIDANCE-TOKEN/);
  assert.match(reconPromptB, /B-SPECIFIC-GUIDANCE-TOKEN/);
});

test("UNSTAMPED-NOTE FALSIFIER (end-to-end): a note lacking author/timestamp is refused at injection — never rendered into either prompt", () => {
  const root = tmpRoot();
  writeRawLine(root, { ts: "2026-07-29T09:00:00.000Z", taskId: "W1-T1", note: "UNSTAMPED-TOKEN-NO-AUTHOR" }); // no author
  writeRawLine(root, { taskId: "W1-T1", author: "craig", note: "UNSTAMPED-TOKEN-NO-TS" }); // no ts
  writeRawLine(root, { ts: "2026-07-29T09:02:00.000Z", taskId: "W1-T1", author: "craig", note: "STAMPED-TOKEN-OK" });

  const block = renderOperatorNotes(loadOperatorNotesForTask(root, "W1-T1"));
  const implementPrompt = renderImplementPrompt(task({ id: "W1-T1" }), "", "run-1", "", block);
  const reconPrompt = renderReconPrompt("", block);

  for (const prompt of [implementPrompt, reconPrompt]) {
    assert.doesNotMatch(prompt, /UNSTAMPED-TOKEN-NO-AUTHOR/);
    assert.doesNotMatch(prompt, /UNSTAMPED-TOKEN-NO-TS/);
    assert.match(prompt, /STAMPED-TOKEN-OK/);
  }
});

/** Small helper so the "end-to-end" fixture tests above read as "given these notes exist for this task". */
function loadOperatorNotesForTaskFixture(entries: OperatorNoteEntry[], taskId: string): OperatorNoteEntry[] {
  const root = tmpRoot();
  for (const e of entries) appendOperatorNote(root, e);
  return loadOperatorNotesForTask(root, taskId);
}

// ── write-scoped console route: POST /v1/operator-notes/add + GET /v1/operator-notes ───────

const READ_TOKEN = "or-read-token";
const WRITE_TOKEN = "or-write-token";

function readLedgerLines(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
}

async function withRoutes<T>(root: string, fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const ledgerPath = join(root, "state", "ledger.ndjson");
  const server = createService({
    tokens: { read: READ_TOKEN, write: WRITE_TOKEN },
    routes: [buildAddOperatorNoteRoute({ root, ledgerPath }), buildListOperatorNotesRoute({ root })],
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

function post(base: string, path: string, token: string, body: unknown) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("POST /v1/operator-notes/add: writes a stamped note (ts stamped server-side) and ledgers panel.operator_note_added", async () => {
  const root = tmpRoot();
  const ledgerPath = join(root, "state", "ledger.ndjson");
  await withRoutes(root, async (base) => {
    const res = await post(base, "/v1/operator-notes/add", WRITE_TOKEN, { taskId: "W1-T1", author: "craig", note: "steer this way" });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; taskId: string; author: string; ts: string };
    assert.equal(body.ok, true);
    assert.equal(body.taskId, "W1-T1");
    assert.ok(!Number.isNaN(Date.parse(body.ts)), "server must stamp a real ts");
  });
  const loaded = loadOperatorNotesForTask(root, "W1-T1");
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].note, "steer this way");
  assert.equal(loaded[0].author, "craig");

  const lines = readLedgerLines(ledgerPath);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].step, "panel.operator_note_added");
  assert.equal(lines[0].task_id, "W1-T1");
});

test("POST /v1/operator-notes/add: a CLIENT-supplied ts is IGNORED — the server always stamps its own", async () => {
  const root = tmpRoot();
  await withRoutes(root, async (base) => {
    const res = await post(base, "/v1/operator-notes/add", WRITE_TOKEN, {
      taskId: "W1-T1", author: "craig", note: "x", ts: "1999-01-01T00:00:00.000Z",
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ts: string };
    assert.notEqual(body.ts, "1999-01-01T00:00:00.000Z");
  });
});

test("POST /v1/operator-notes/add: missing author -> 400, no write, no ledger line", async () => {
  const root = tmpRoot();
  const ledgerPath = join(root, "state", "ledger.ndjson");
  await withRoutes(root, async (base) => {
    const res = await post(base, "/v1/operator-notes/add", WRITE_TOKEN, { taskId: "W1-T1", note: "x" });
    assert.equal(res.status, 400);
  });
  assert.deepEqual(loadOperatorNotesForTask(root, "W1-T1"), []);
  assert.equal(readLedgerLines(ledgerPath).length, 0);
});

test("POST /v1/operator-notes/add: is write-scoped — a read-only token gets 403", async () => {
  const root = tmpRoot();
  await withRoutes(root, async (base) => {
    const res = await post(base, "/v1/operator-notes/add", READ_TOKEN, { taskId: "W1-T1", author: "craig", note: "x" });
    assert.equal(res.status, 403);
  });
});

test("POST /v1/operator-notes/add: a write failure surfaces as 500 write_failed and ledgers nothing", async () => {
  const root = tmpRoot();
  const ledgerPath = join(root, "state", "ledger.ndjson");
  // Force appendOperatorNote to fail from inside the handler: make the store path a directory.
  mkdirSync(storePath(root), { recursive: true });
  await withRoutes(root, async (base) => {
    const res = await post(base, "/v1/operator-notes/add", WRITE_TOKEN, { taskId: "W1-T1", author: "craig", note: "x" });
    assert.equal(res.status, 500);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "write_failed");
  });
  assert.equal(readLedgerLines(ledgerPath).length, 0, "a failed write must ledger nothing (the panel line is emitted only after a successful write)");
});

test("GET /v1/operator-notes?taskId=…: read-scoped, returns only that task's notes", async () => {
  const root = tmpRoot();
  appendOperatorNote(root, { ts: "2026-07-29T09:00:00.000Z", taskId: "W1-T-A", author: "craig", note: "A note" });
  appendOperatorNote(root, { ts: "2026-07-29T09:00:00.000Z", taskId: "W1-T-B", author: "craig", note: "B note" });
  await withRoutes(root, async (base) => {
    const res = await fetch(`${base}/v1/operator-notes?taskId=W1-T-A`, { headers: { authorization: `Bearer ${READ_TOKEN}` } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { taskId: string; notes: OperatorNoteEntry[] };
    assert.equal(body.notes.length, 1);
    assert.equal(body.notes[0].note, "A note");
  });
});

test("GET /v1/operator-notes with no taskId -> 400 (never a repo-wide dump)", async () => {
  const root = tmpRoot();
  await withRoutes(root, async (base) => {
    const res = await fetch(`${base}/v1/operator-notes`, { headers: { authorization: `Bearer ${READ_TOKEN}` } });
    assert.equal(res.status, 400);
  });
});
