/**
 * W1-T3351 — THE OPERATOR'S OWN WORDS REACH NO SURFACE THE DOCKET READS.
 *
 * MEASURED on the daemon host over the ledger union (919 archives + live file): the console is in
 * use — 51 `panel.*` rows and 44 `ratify.approved` — while `panel.question_answered` and
 * `operator_note.added` both read ZERO and `plan/operator-notes.ndjson` has never been created.
 * `rmd approve` is the ONE operator touchpoint that fires, and it takes no free text at all.
 *
 * THE FRICTION LESSON, TAKEN FROM THE SURFACE THAT ALREADY EXISTS AND IS UNUSED. `rmd reframe`
 * already captures operator words verbatim into `ratify.reframed` — the docket's first surface,
 * fully wired — and `"step":"ratify.reframed"` reads 0 across the whole union. It requires a
 * `--feedback "<text>"` flag. So this verb takes its text POSITIONALLY: a capture path that costs
 * a flag to use is a capture path that does not get used, and an unused surface is the defect
 * being fixed, not a smaller version of it.
 *
 * NOTHING IS RECORDED FOR AN ACTION THAT DID NOT HAPPEN. `--note` on `approve` chains only after
 * the approve SUCCEEDS. Guidance attached to a refused ratification would be a note about a state
 * the plan was never in.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { makeTempDir } from "../src/lib/tmp.js";
import { loadOperatorNotesForTask } from "../src/lib/operator-notes.js";

function storeLines(root: string): Array<Record<string, unknown>> {
  const p = join(root, "plan", "operator-notes.ndjson");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
}

test("W1-T3351: `rmd note <id> <text...>` writes one stamped note the docket's surface can read", async () => {
  const { noteCommand } = await import("../src/run-task.js");
  const root = makeTempDir("note-cli");
  const logged: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const code = await noteCommand(["W1-T42", "prefer", "the", "union", "reader", "here"], {
    root,
    now: () => new Date("2026-09-10T12:00:00.000Z"),
    log: (step, extra = {}) => logged.push({ step, extra }),
  });

  assert.equal(code, 0);
  const rows = storeLines(root);
  assert.equal(rows.length, 1, "exactly one note");
  assert.equal(rows[0].taskId, "W1-T42");
  assert.equal(rows[0].note, "prefer the union reader here", "the positional text is joined verbatim");
  assert.equal(rows[0].ts, "2026-09-10T12:00:00.000Z");
  assert.ok(String(rows[0].author).trim().length > 0, "an author is stamped — the store REFUSES an unstamped entry");
  // The read side the docket and prompt-injection both use must accept it.
  assert.equal(loadOperatorNotesForTask(root, "W1-T42").length, 1, "the stamped note reads back");
  assert.equal(logged.filter((l) => l.step === "operator_note.added").length, 1, "the write is ledgered");
});

test("W1-T3351: a note with no text, or no id, is a usage error that writes NOTHING", async () => {
  const { noteCommand } = await import("../src/run-task.js");
  const root = makeTempDir("note-cli-bad");
  const quiet = { root, log: () => {} };

  assert.equal(await noteCommand([], quiet), 2, "no id at all");
  assert.equal(await noteCommand(["W1-T42"], quiet), 2, "an id with no text is not a note");
  assert.equal(await noteCommand(["W1-T42", "   "], quiet), 2, "whitespace is not text");
  assert.equal(storeLines(root).length, 0, "a refused note writes no partial row");
});

test("W1-T3351: `rmd approve <P##> --note` is accepted, and a REFUSED approve records no note", async () => {
  const { approveCommand } = await import("../src/run-task.js");
  const root = makeTempDir("note-approve-refused");
  // An id that names no proposal: approveCommand refuses before any ratification happens.
  const code = await approveCommand(["P-does-not-exist", "--note", "this must not be recorded"], {
    config: { root } as never,
  });

  assert.notEqual(code, 0, "an unknown proposal is refused");
  assert.equal(
    storeLines(root).length,
    0,
    "guidance is never attached to a ratification that did not happen — the chain runs only after success",
  );
});

test("W1-T3351: a SUCCEEDING approve chains the note, and the same approve without --note writes none", async () => {
  const { approveCommand } = await import("../src/run-task.js");
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const root = makeTempDir("note-approve-ok");
  mkdirSync(join(root, "plan"), { recursive: true });
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(
    join(root, "plan", "tasks.yaml"),
    ["- id: W1-T1041", "  title: a parked shard", "  repo: remudero", "  type: implement", "  verify: human", "  status: queued", "  depends_on: []"].join("\n"),
  );
  const config = { root } as never;

  // (1) WITHOUT --note: approve stays exactly the one bit it documents.
  assert.equal(await approveCommand(["W1-T1041"], { config, root }), 0);
  assert.equal(storeLines(root).length, 0, "no --note, no note — the optional half is a true no-op");

  // (2) WITH --note, on a release that SUCCEEDS: the words land on the docket's surface.
  const code = await approveCommand(["W1-T1041", "--note", "release this   one   early next   cycle"], {
    config,
    root,
    now: () => new Date("2026-09-10T13:00:00.000Z"),
  });
  assert.equal(code, 0, "--note does not disturb the release path's own verdict");

  const rows = storeLines(root);
  assert.equal(rows.length, 1, "exactly one note, chained from the approve");
  assert.equal(rows[0].taskId, "W1-T1041", "scoped to the id that was approved");
  assert.equal(rows[0].note, "release this one early next cycle", "whitespace flattened, words verbatim");
  assert.equal(rows[0].ts, "2026-09-10T13:00:00.000Z");
  assert.equal(loadOperatorNotesForTask(root, "W1-T1041").length, 1, "the stamped note reads back");
});
