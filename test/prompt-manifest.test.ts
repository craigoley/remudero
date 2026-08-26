import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { buildPromptManifest, type PromptManifestInput } from "../src/lib/prompt-manifest.js";
import { implementPromptParts, renderImplementPrompt } from "../src/run-task.js";
import type { Task } from "../src/lib/plan.js";

function task(over: Partial<Task> = {}): Task {
  return {
    id: "W1-T2297",
    title: "record the prompt a worker saw",
    repo: "remudero",
    depends_on: [],
    type: "implement",
    risk: "high",
    verify: "auto",
    status: "queued",
    attempts: 0,
    prompt: "assemble ${TASK_ID} on run ${RUN_ID}",
    ...over,
  };
}

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

test("every injected context part yields one manifest row with a stable fingerprint", () => {
  const parts: PromptManifestInput[] = [
    { name: "doctrine", value: "distrust the prompt over the installed version" },
    { name: "task_claims", value: "- some claim [src: recon#W1-T2297]" },
    { name: "recon", value: "OBSERVED: git status is clean" },
    { name: "operator_notes", value: "watch the budget" },
    { name: "matched_learnings", value: "- cache keys on exact prefix bytes" },
  ];
  const manifest = buildPromptManifest(parts);

  assert.equal(manifest.length, parts.length);
  for (const [i, row] of manifest.entries()) {
    assert.equal(row.name, parts[i].name);
    assert.equal(row.present, true);
    assert.equal(row.sha256, sha256(parts[i].value as string));
    assert.equal(row.bytes, Buffer.byteLength(parts[i].value as string, "utf8"));
  }
});

test("identical parts in produce identical fingerprints out", () => {
  const a = buildPromptManifest([{ name: "recon", value: "OBSERVED: same text twice" }]);
  const b = buildPromptManifest([{ name: "recon", value: "OBSERVED: same text twice" }]);
  assert.deepEqual(a, b);
  assert.equal(a[0].sha256, b[0].sha256);

  const different = buildPromptManifest([{ name: "recon", value: "OBSERVED: different text" }]);
  assert.notEqual(a[0].sha256, different[0].sha256);
});

test("the rendered worker prompt is byte-identical with the manifest wired and without it", () => {
  const t = task();
  const reconContext = "- OBSERVED: git remote -v shows origin [src: recon#W1-T2297]";
  const operatorNotesBlock = "## OPERATOR NOTES\n- watch the budget";
  const matchedLearnings = "- cache keys on exact prefix bytes [src: learnings#cache-prefix-bytes]";
  const runId = "W1-T2297-1700000000000";

  // WITHOUT the manifest ever computed.
  const promptAlone = renderImplementPrompt(t, reconContext, runId, matchedLearnings, operatorNotesBlock);

  // WITH the manifest computed from the SAME inputs, alongside the render — buildPromptManifest
  // reads implementPromptParts' output, it never writes back into it, so computing (or even
  // discarding) the manifest must not perturb a single byte of the rendered prompt.
  const parts = implementPromptParts(t, reconContext, runId, matchedLearnings, operatorNotesBlock);
  buildPromptManifest(parts); // computed and discarded — purely observational
  const promptWithManifestComputed = renderImplementPrompt(
    t,
    reconContext,
    runId,
    matchedLearnings,
    operatorNotesBlock,
  );

  assert.equal(promptWithManifestComputed, promptAlone);
});

test("no manifest row ever carries prompt text", () => {
  const parts: PromptManifestInput[] = [
    { name: "recon", value: "OBSERVED: some very specific secret-looking recon text" },
    { name: "operator_notes", value: "" },
  ];
  const manifest = buildPromptManifest(parts);
  const serialized = JSON.stringify(manifest);

  assert.equal(serialized.includes("OBSERVED"), false);
  assert.equal(serialized.includes("secret-looking"), false);
  // Only identity + size fields ever appear on a row.
  for (const row of manifest) {
    assert.deepEqual(Object.keys(row).sort(), ["bytes", "name", "present", "sha256"]);
  }
});

test("an absent optional part is recorded as absent rather than as empty content", () => {
  const undefinedPart = buildPromptManifest([{ name: "operator_notes", value: undefined }]);
  const emptyStringPart = buildPromptManifest([{ name: "recon", value: "" }]);
  const nullPart = buildPromptManifest([{ name: "matched_learnings", value: null }]);

  for (const [row] of [undefinedPart, emptyStringPart, nullPart]) {
    assert.equal(row.present, false);
    assert.equal(row.sha256, null);
    assert.equal(row.bytes, null);
  }

  // Never a hash of the empty string standing in for "nothing here".
  assert.notEqual(emptyStringPart[0].sha256, sha256(""));
});

test("implementPromptParts feeds the SAME five named context parts renderImplementPrompt renders", () => {
  const t = task();
  const parts = implementPromptParts(t, "recon text", "W1-T2297-1700000000000", "learnings text", "notes text");
  const names = parts.map((p) => p.name);
  assert.deepEqual(names, ["doctrine", "task_claims", "recon", "operator_notes", "matched_learnings", "task_body"]);

  const manifest = buildPromptManifest(parts);
  assert.equal(manifest.find((r) => r.name === "recon")?.present, true);
  assert.equal(manifest.find((r) => r.name === "operator_notes")?.present, true);
});
