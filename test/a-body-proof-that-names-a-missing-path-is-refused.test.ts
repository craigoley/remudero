// test/a-body-proof-that-names-a-missing-path-is-refused.test.ts
//
// W1-T3675 — A PULL REQUEST BODY'S `grep:` PROOF NAMES A FILE BY PATH AND IS SILENTLY INVALIDATED
// BY A RENAME. MEASURED THREE TIMES in one evening on #5742/#5718 (the task's rationale): a shard
// renumbered out from under a body's own `grep: ... in plan/tasks.d/<old-id>-....yaml` proof passed
// every check `acceptance-author-gate` ran — dialect present, one physical line, a path-shaped
// target with an extension — because nothing STATS the path until `remudero-review` executes it, a
// full CI round later, and it then reads as a FAILED CRITERION rather than a STALE PATH.
//
// WHAT IS REAL HERE: `evaluateGate`/`bodyProofTargetMissing` are the production functions from the
// script itself, imported directly — no seam, nothing mocked, the same convention
// test/acceptance-author-gate.test.ts documents for a `.mjs` file that imports a `.ts` module.

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "acceptance-author-gate.mjs");
const GATE_URL = pathToFileURL(SCRIPT).href;

type GateVerdict = { ok: boolean; defect?: string; message: string };
type GateInput = { body: string; authorLogin?: string };
const mod = (await import(GATE_URL)) as {
  evaluateGate: (input: GateInput) => GateVerdict;
  bodyProofTargetMissing: (
    criteria: readonly { claim: string; proof: string }[],
    root?: string,
  ) => GateVerdict | undefined;
};
const { evaluateGate, bodyProofTargetMissing } = mod;

// #5718's third break, replayed verbatim (the task's falsifier): a shard renumbered away leaves a
// body's proof naming the OLD id. This file is genuinely absent from the checked-out tree.
const MISSING_SHARD = "plan/tasks.d/W1-T99999-does-not-exist.yaml";
// A real shard this repo's own tree carries (W1-T3653, merged) — the falsifier's "point the same
// proof at the file that does exist" counterpart.
const EXISTING_SHARD = "plan/tasks.d/W1-T3653-a-proof-can-name-an-extensionless-file.yaml";

function missingBody(target: string): string {
  return `## Acceptance\n\n- claim: a criterion naming a renamed shard\n  proof: grep: id in ${target}\n`;
}

test("a grep proof naming a repository path that does not exist at this head is refused, naming the path", () => {
  const refused = evaluateGate({ body: missingBody(MISSING_SHARD), authorLogin: "a-human" });
  assert.equal(refused.ok, false);
  assert.equal(refused.defect, "grep-proof-target-missing");
  assert.ok(refused.message.includes(MISSING_SHARD), `refusal names ${MISSING_SHARD}: ${refused.message}`);

  // The falsifier's other half: point the identical proof shape at a path that DOES exist, and it
  // must pass — this is not a ban on the file, only on the absence.
  const passed = evaluateGate({ body: missingBody(EXISTING_SHARD), authorLogin: "a-human" });
  assert.equal(passed.ok, true, passed.message);
});

test("the refusal names an absent path, not a failed criterion", () => {
  const refused = evaluateGate({ body: missingBody(MISSING_SHARD), authorLogin: "a-human" });
  assert.equal(refused.ok, false);
  // The author needs to read "the path is absent" rather than "the criterion failed" — those are
  // two different debugging sessions, and the whole point of this task is picking the right one.
  assert.match(refused.message, /does not exist at this head/);
  assert.match(refused.message, /path is absent, not the criterion failed/);
  assert.doesNotMatch(refused.message, /cannot execute/);
});

test("a title proof is not path-checked", () => {
  const titleBody = "## Acceptance\n\n- claim: a title-form proof\n  proof: unit test: a real title\n";
  const result = evaluateGate({ body: titleBody, authorLogin: "a-human" });
  assert.equal(result.ok, true, result.message);

  // Directly on the exported predicate too: a `unit test:` criterion carries no grep target at
  // all, so it must never be refused for "having no path" — the arm this test falsifies if removed
  // (the task's own falsifier: "delete that arm and the third test fails").
  const direct = bodyProofTargetMissing([{ claim: "a title-form proof", proof: "unit test: a real title" }]);
  assert.equal(direct, undefined);
});

test("bodyProofTargetMissing: an existing target under an injected root passes", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-body-proof-target-"));
  try {
    writeFileSync(join(dir, "present.ts"), "// present\n");
    const result = bodyProofTargetMissing(
      [{ claim: "a file that exists", proof: "grep: present in present.ts" }],
      dir,
    );
    assert.equal(result, undefined);

    const missing = bodyProofTargetMissing(
      [{ claim: "a file that was renamed away", proof: "grep: present in absent.ts" }],
      dir,
    );
    assert.equal(missing?.ok, false);
    assert.equal(missing?.defect, "grep-proof-target-missing");
    assert.ok(missing?.message.includes("absent.ts"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bodyProofTargetMissing: a legacy fenced grep proof's author-selected argv is not path-checked", () => {
  // The house dialect always compiles a fixed `["-arn", "--", pattern, path]` argv; the legacy
  // fenced `` `grep ...` `` shape passes the author's own argv through, whose last element need not
  // even be a path — outside-the-repository targets are "not this gate's business" (the task's own
  // design), so this must pass through untouched exactly like a title proof.
  const result = bodyProofTargetMissing([
    { claim: "a legacy fenced grep proof", proof: "`grep -n TODO src/lib/review.ts`" },
  ]);
  assert.equal(result, undefined);
});
