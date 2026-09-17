import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { parseAcceptanceBlock } from "../src/lib/review.js";

// ── W1-T3739 — THE FILING PROTOCOL IS TYPED WHEN A FUNCTION ALREADY PRODUCES IT ──────────────
//
// `reservationHandoffNoteLine` exists in scripts/task-id-existence-check.mjs with a comment
// stating its whole purpose: it returns "ONLY the bare hand-off text, with nothing before or after
// it, so whatever prints it can guarantee -- BY CONSTRUCTION, not by instruction a reader might
// skip -- that nothing else ever shares its line."
//
// The guarantee held for the gate's own refusal message, and never reached the FILER. MEASURED
// 2026-09-17: the line was wrong three times in one day — #5894 wrote `planfast -> planfast` where
// the reservation had recorded `unknown`, and #5901 shipped without it twice.
//
// Same shape for the body block: five pull requests carried an `## Acceptance` that diverged from
// the shard their trailer resolves, which `acceptance-author-gate` refuses as the CONSOLE-T12
// shape. Every one of those bodies was authored beside a shard that already held the answer.
//
// WHAT IS REAL HERE: the production generators, imported from the scripts that own the matcher and
// the refusal they exist to make unreachable. The round-trip goes through the REVIEWER'S parser.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const idGate = (await import(pathToFileURL(join(ROOT, "scripts", "task-id-existence-check.mjs")).href)) as {
  scaffoldShardStub: (o: Record<string, unknown>) => string;
  writeScaffoldedShard: (o: Record<string, unknown>, fs?: unknown) => string | undefined;
  reservationHandoffNoteLine: (holder: string, filer: string) => string;
  shardNoteRecordsReservationHandoff: (text: string, holder: string, filer: string) => boolean;
};
const authorGate = (await import(pathToFileURL(join(ROOT, "scripts", "acceptance-author-gate.mjs")).href)) as {
  renderAcceptanceBlock: (criteria: readonly { claim?: string; proof?: string; satisfied_by?: string }[]) => string;
};

test("the scaffolded note is the function's own output", () => {
  // Not "a line that looks like it" — the bytes the matcher's own producer returns, on a line of
  // its own. A template string that happened to agree today is the defect one layer up.
  const stub = idGate.scaffoldShardStub({ id: "W1-T9999", slug: "a-defect", holderBranch: "unknown", filerBranch: "file-a-defect" });
  const produced = idGate.reservationHandoffNoteLine("unknown", "file-a-defect");
  const lines = stub.split("\n").map((l) => l.trim());
  assert.ok(lines.includes(produced), `the stub must carry ${JSON.stringify(produced)} verbatim`);

  // W1-T3648: end-of-line anchored. Nothing may share the line.
  const carrying = stub.split("\n").filter((l) => l.includes("reservation hand-off"));
  assert.equal(carrying.length, 1);
  assert.equal(carrying[0].trim(), produced, "no text may share the physical line");

  // No hand-off needed ⇒ no line, rather than a meaningless one a filer learns to ignore.
  const sameBranch = idGate.scaffoldShardStub({ id: "W1-T9999", slug: "x", holderBranch: "b", filerBranch: "b" });
  assert.doesNotMatch(sameBranch, /reservation hand-off/);
});

test("a scaffolded shard satisfies the reservation-holder check", () => {
  // The gate that refused those three filings, run against the generator's own output.
  const stub = idGate.scaffoldShardStub({ id: "W1-T9999", slug: "a-defect", holderBranch: "main", filerBranch: "plan/file-it" });
  assert.equal(idGate.shardNoteRecordsReservationHandoff(stub, "main", "plan/file-it"), true);

  // AND IT IS THE HOLDER THAT WAS RECORDED, NOT THE ONE INFERRED. #5894's entire defect was an
  // author writing the branch they were on as the left-hand side; the matcher compares against
  // what the RESERVATION recorded, so a stub built from the filer on both sides must not match.
  assert.equal(idGate.shardNoteRecordsReservationHandoff(stub, "plan/file-it", "plan/file-it"), false);
});

test("a rendered block round-trips through the reviewer's parser", () => {
  // Through `parseAcceptanceBlock` — the function review actually uses — never a string
  // comparison. A renderer checked against a hand-written expectation drifts from the parser the
  // exact way the five diverging bodies did.
  const criteria = [
    { claim: "a thing happens", proof: "unit test: a thing happens" },
    { claim: "another thing", proof: "grep: aSymbol in src/lib/x.ts" },
  ];
  const parsed = parseAcceptanceBlock(authorGate.renderAcceptanceBlock(criteria));
  assert.deepEqual(
    parsed.map((c) => ({ claim: c.claim.trim(), proof: (c.proof ?? "").trim() })),
    criteria,
    "what the renderer writes is exactly what the reviewer reads back",
  );

  // A criterion the plan credits to an earlier merge carries NO proof text (plan.ts: satisfied_by
  // stands in place of one), so rendering a `proof:` for it would invent one that
  // proof-discrimination would then try to execute.
  const credited = authorGate.renderAcceptanceBlock([{ claim: "already met", satisfied_by: "https://github.com/craigoley/remudero/pull/5797" }]);
  assert.match(credited, /satisfied_by: https/);
  assert.doesNotMatch(credited, /^\s*proof:/m);

  // Nothing to render ⇒ nothing, rather than a bare header the gate would read as an empty block.
  assert.equal(authorGate.renderAcceptanceBlock([]), "");
});

test("--no-scaffold writes nothing", () => {
  // A filer with their own shard is never forced through the generator — a bound with no escape is
  // a wall. And the escape must be REAL: nothing on disk, not an empty file.
  const dir = mkdtempSync(join(tmpdir(), "rmd-scaffold-"));
  const declined = idGate.writeScaffoldedShard({ planDir: dir, id: "W1-T9999", slug: "a-defect", scaffold: false });
  assert.equal(declined, undefined);
  assert.deepEqual(readdirSync(dir), [], "nothing written at all");

  // THE CONTROL: "wrote nothing" is also true of a writer that never writes. The default must.
  const written = idGate.writeScaffoldedShard({ planDir: dir, id: "W1-T9999", slug: "a-defect", holderBranch: "unknown", filerBranch: "f" });
  assert.equal(written, join(dir, "W1-T9999-a-defect.yaml"));
  assert.ok(existsSync(written as string));

  // And it never lands on top of a filing to save a paste.
  assert.throws(
    () => idGate.writeScaffoldedShard({ planDir: dir, id: "W1-T9999", slug: "a-defect", holderBranch: "unknown", filerBranch: "f" }),
    /refusing to overwrite/,
  );
});
