import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
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
  scaffoldCli: (argv: string[], deps?: Record<string, unknown>) => { ok: boolean; message: string; path?: string };
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

test("the generator is reachable from a filer's own flow", () => {
  // A generator nothing invokes is one more correct thing nobody runs — the dormancy this task
  // exists to fix, one layer up. The CLI arm is what puts it in a filer's hands.
  const dir = mkdtempSync(join(tmpdir(), "rmd-scaffold-cli-"));
  const wrote = idGate.scaffoldCli(
    ["--scaffold", "W1-T9999", "--slug", "a-defect", "--holder", "unknown", "--for-branch", "file-a-defect"],
    { planDir: dir },
  );
  assert.equal(wrote.ok, true, wrote.message);
  assert.match(wrote.message, /^scaffold: wrote /);
  const written = readFileSync(wrote.path as string, "utf8");
  assert.ok(written.split("\n").map((l) => l.trim()).includes(idGate.reservationHandoffNoteLine("unknown", "file-a-defect")));

  // The escape reaches the CLI too, and still writes nothing.
  const declined = idGate.scaffoldCli(["--scaffold", "W1-T9998", "--slug", "x", "--no-scaffold"], { planDir: dir });
  assert.equal(declined.ok, true);
  assert.match(declined.message, /declined/);
  assert.deepEqual(readdirSync(dir), ["W1-T9999-a-defect.yaml"]);

  // A missing id is a usage error, not a silent no-op.
  assert.equal(idGate.scaffoldCli(["--scaffold"], { planDir: dir }).ok, false);
});

test("a slug that would escape the plan directory is refused", () => {
  // THE SLUG BECOMES A PATH SEGMENT. Refused by shape rather than sanitised: a silently-rewritten
  // filename is a shard nobody can find.
  const dir = mkdtempSync(join(tmpdir(), "rmd-scaffold-esc-"));
  for (const slug of ["../../etc/passwd", "has/slash", "Has-Caps", "trailing-"]) {
    assert.throws(
      () => idGate.writeScaffoldedShard({ planDir: dir, id: "W1-T9999", slug, holderBranch: "unknown", filerBranch: "f" }),
      /not a kebab-case slug/,
      `'${slug}' must be refused`,
    );
  }
  assert.deepEqual(readdirSync(dir), [], "nothing escaped and nothing landed");

  // THE CONTROL: an ordinary slug still writes, or the refusal above proves nothing.
  const ok = idGate.writeScaffoldedShard({ planDir: dir, id: "W1-T9999", slug: "a-real-slug", holderBranch: "unknown", filerBranch: "f" });
  assert.equal(ok, join(dir, "W1-T9999-a-real-slug.yaml"));
});

// ── W1-T3739 follow-up: THE FAILURE PATHS, WHICH ARE THE ONLY REASON THE CATCH EXISTS ─────────
//
// `diff-coverage` refused this PR naming five added lines, and it was right to. The `wx` create
// CodeQL made us write has TWO failure branches and only the EEXIST one was exercised; an untested
// re-throw is how a write error becomes a silent success, which is the exact class of bug the
// atomic create was introduced to prevent.
test("a write failure that is not a collision propagates as itself", () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}scaffold-enoent-`));
  // A planDir that does not exist: writeFileSync fails ENOENT, which is NOT the collision case.
  assert.throws(
    () =>
      idGate.writeScaffoldedShard({
        planDir: join(dir, "no-such-directory"),
        id: "W1-T9001",
        slug: "a-real-slug",
        holderBranch: "unknown",
        filerBranch: "f",
      }),
    (err: NodeJS.ErrnoException) => {
      // It must arrive AS ITSELF. Reporting an ENOENT as "already exists" would send the author to
      // pick a new id when the actual defect is a missing directory.
      assert.equal(err.code, "ENOENT");
      assert.doesNotMatch(String(err.message), /already exists/);
      return true;
    },
  );
});

test("scaffoldCli reports a write failure as a refusal instead of throwing through the CLI", () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}scaffold-cli-fail-`));
  const out = idGate.scaffoldCli(["--scaffold", "W1-T9002", "--slug", "a-real-slug"], {
    planDir: join(dir, "no-such-directory"),
    currentBranch: () => "f",
    readHolder: () => ({ recordedBranch: "unknown" }),
  });
  // ok:false, not a throw — this CLI's contract is an exit code and one line, and a stack trace on
  // stderr is neither.
  assert.equal(out.ok, false);
  assert.match(out.message, /^scaffold: /);
  assert.match(out.message, /ENOENT/);
});
