import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

/**
 * W1-T1062 ACCEPTANCE 5: "the verbs that are about this instance's own repo still derive their
 * owner from this checkout, so the lift did not silently become global."
 *
 * The task record is explicit that a fixed, closed list of verbs is SELF-SCOPED and correct
 * today, and "they must STAY self-scoped": `serveCommand`, `daemonPlistCommand`,
 * `nextTaskIdCommand`, `retroCommand`, `triageCommandLocked`, `planCommand`, `inboxCommand`,
 * `approveCommand`. None of them is in the four-part dispatch-path slice this task touches
 * (`resolveDaemonTarget`, `daemonCommand`'s `runOne` closure, `runTask`'s options type, and its
 * owner derivation) — this file is the boundary assertion the design explicitly calls for
 * ("a test must assert that boundary rather than leave it to inspection — a later reader will
 * otherwise assume the lift was meant to be global"), driven off the SAME source-slice
 * technique test/run-task.test.ts already uses for wiring proofs (its own `extractFunctionBody`
 * helper, W1-T192).
 */

const runTaskSrc = readFileSync(fileURLToPath(new URL("../src/run-task.ts", import.meta.url)), "utf8");

function extractFunctionBody(src: string, signature: string): string {
  const start = src.indexOf(signature);
  assert.ok(start >= 0, `expected to find '${signature}' in run-task.ts`);
  const nextFn = src.indexOf("\nfunction ", start + 1);
  const nextAsyncFn = src.indexOf("\nasync function ", start + 1);
  const nextExportAsyncFn = src.indexOf("\nexport async function ", start + 1);
  const boundaries = [nextFn, nextAsyncFn, nextExportAsyncFn].filter((i) => i > start);
  const end = boundaries.length ? Math.min(...boundaries) : src.length;
  return src.slice(start, end);
}

// The exact eight self-scoped verbs the task record names, with their exact source signature
// (a unique substring `extractFunctionBody` can anchor on).
const SELF_SCOPED_VERBS: Array<{ name: string; signature: string }> = [
  { name: "serveCommand", signature: "export async function serveCommand(" },
  { name: "daemonPlistCommand", signature: "export async function daemonPlistCommand(" },
  { name: "nextTaskIdCommand", signature: "export async function nextTaskIdCommand(" },
  { name: "retroCommand", signature: "async function retroCommand(" },
  { name: "triageCommandLocked", signature: "async function triageCommandLocked(" },
  { name: "planCommand", signature: "export async function planCommand(" },
  { name: "inboxCommand", signature: "export async function inboxCommand(" },
  { name: "approveCommand", signature: "export async function approveCommand(" },
];

for (const verb of SELF_SCOPED_VERBS) {
  test(`${verb.name}: still derives its owner from THIS checkout's own origin (resolveOwnerRepo) -- untouched by W1-T1062's dispatch-path lift`, () => {
    const body = extractFunctionBody(runTaskSrc, verb.signature);
    assert.match(
      body,
      /resolveOwnerRepo\(\)/,
      `${verb.name} must still call the checkout-derived resolveOwnerRepo() -- if this fails, ` +
        `either the verb was accidentally made target-aware (out of this task's scope) or its ` +
        `signature moved and this proof needs re-anchoring`,
    );
    // Guards against the exact regression the design warns about: a later edit widening
    // runTask's new `opts.owner` dispatch-path override into one of these self-scoped verbs.
    assert.doesNotMatch(
      body,
      /opts\.owner\b|target\.owner\b/,
      `${verb.name} must not read a dispatch-path owner override -- it is self-scoped, not target-scoped`,
    );
  });
}
