import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { implementPromptParts } from "../src/run-task.js";
import type { Task } from "../src/lib/plan.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKER_TS = join(REPO_ROOT, "src", "lib", "worker.ts");
const PROVIDER_TS = join(REPO_ROOT, "src", "lib", "worker-provider.ts");
const SDK_DTS = join(REPO_ROOT, "node_modules", "@anthropic-ai", "claude-agent-sdk", "sdk.d.ts");
const CLAUDE_MD = join(REPO_ROOT, "CLAUDE.md");

/**
 * test/what-a-worker-loads.test.ts — W1-T2759.
 *
 * THREE ARTIFACTS SAID CLAUDE.md IS INJECTED INTO EVERY SESSION ON EVERY LANE. It is not.
 * `spawnWorker` passes `settingSources: []`, which the installed SDK documents as isolation mode
 * requiring `'project'` to load CLAUDE.md files. So the fleet's own Claude workers see none of it,
 * and every decision that priced those bytes against WORKER throughput priced the wrong lane.
 *
 * MEASURED HERE rather than repeated: the shard cites SDK 0.3.226 and the installed version is
 * 0.3.241. The sentence is unchanged, so the finding holds — but the version in the prose was
 * already stale when this was built, which is exactly why the premise is pinned to the INSTALLED
 * file below instead of to a number written down once.
 *
 * The census is DERIVED from the four facts, never asserted as prose:
 *   interactive session in this checkout -> the whole file
 *   dispatched Claude worker             -> none
 *   dispatched Codex worker              -> instructed to read it
 */

type Lane = "interactive" | "claude-worker" | "codex-worker";

/** What each lane loads, derived from the four facts this suite checks. */
function census(facts: {
  claudeWorkerIsolated: boolean;
  sdkRequiresProject: boolean;
  codexToldToRead: boolean;
}): Record<Lane, "whole-file" | "none" | "instructed-to-read"> {
  return {
    interactive: "whole-file",
    "claude-worker": facts.claudeWorkerIsolated && facts.sdkRequiresProject ? "none" : "whole-file",
    "codex-worker": facts.codexToldToRead ? "instructed-to-read" : "none",
  };
}

test("W1-T2759: the spawn options carry the isolation option and the installed SDK still documents it as the option that must include project to load CLAUDE.md", () => {
  // COMMENTS STRIPPED FIRST. worker.ts documents `settingSources: []` in a doc comment as well as
  // passing it, so a raw text match is satisfiable by the prose alone — measured: flipping the
  // real option to ["project"] left a raw match passing. This asserts the CODE.
  const worker = readFileSync(WORKER_TS, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ");
  assert.match(worker, /settingSources:\s*\[\s*\]/, "spawnWorker must still pass the SDK isolation option");
  // Control for the strip: the prose that carries the same token IS present in the raw file, so a
  // clean match above is the code and not an emptied string.
  assert.match(readFileSync(WORKER_TS, "utf8"), /the worker settings file, and isolation mode/);

  const sdk = readFileSync(SDK_DTS, "utf8");
  // Pinned to the INSTALLED file (Standing rule 7): if a future SDK rewrites this sentence, this
  // fails and names it, rather than the premise quietly going stale in prose.
  assert.match(
    sdk,
    /Pass `\[\]` to disable filesystem settings/,
    "the installed SDK no longer documents `[]` as isolation mode — re-derive what a worker loads before trusting the census below",
  );
  assert.match(
    sdk,
    /Must include `'project'` to load CLAUDE\.md files/,
    "the installed SDK no longer says 'project' is required for CLAUDE.md — the premise of W1-T2759 has moved",
  );

  // Positive control: the same read CAN find a sentence that is present, so a passing assertion
  // above is the file being read rather than a regex that matches anything.
  assert.equal(/this sentence appears in no SDK typings anywhere/.test(sdk), false);
  assert.ok(sdk.length > 1000, "sanity: sdk.d.ts must be a real corpus");
});

test("W1-T2759: the implement prompt over a fixture task carries no line from CLAUDE.md's rule bullets, and the Codex prelude still names the file", () => {
  const task = {
    id: "W1-TFIXTURE",
    title: "a fixture task",
    repo: "remudero",
    type: "implement",
    verify: "auto",
    depends_on: [],
    files: ["src/lib/x.ts"],
    acceptance: [{ claim: "a claim", proof: "grep: x in src/lib/x.ts" }],
  } as unknown as Task;
  const parts = implementPromptParts(task, "", "RUN-1");
  const names = parts.map((p) => p.name);
  assert.deepEqual(names, ["doctrine", "task_claims", "recon", "operator_notes", "matched_learnings", "task_body"]);
  const rendered = parts.map((p) => p.value).join("\n");

  // Every headline bullet in CLAUDE.md, checked against the rendered prompt. A worker that loaded
  // the file would carry these sentences; none of them appears.
  const bullets = readFileSync(CLAUDE_MD, "utf8")
    .split("\n")
    .filter((l) => /^- \*\*/.test(l))
    .map((l) => l.replace(/^- \*\*/, "").split("**")[0].trim())
    .filter((h) => h.length > 25);
  assert.ok(bullets.length >= 10, `positive control: CLAUDE.md must yield real rule headlines; got ${bullets.length}`);
  for (const headline of bullets) {
    assert.equal(rendered.includes(headline), false, `the implement prompt carries a CLAUDE.md rule headline: ${headline}`);
  }

  // The Codex lane IS told to read it — the one lane the census records differently.
  assert.match(readFileSync(PROVIDER_TS, "utf8"), /read and follow the repository instruction files[^"]*CLAUDE\.md/);
});

test("W1-T2759: the census is derived from those facts, and each fact moves exactly one row", () => {
  assert.deepEqual(census({ claudeWorkerIsolated: true, sdkRequiresProject: true, codexToldToRead: true }), {
    interactive: "whole-file",
    "claude-worker": "none",
    "codex-worker": "instructed-to-read",
  });
  // Drop the isolation option and the Claude worker row flips — so the row is derived from the
  // fact rather than written down beside it.
  assert.equal(census({ claudeWorkerIsolated: false, sdkRequiresProject: true, codexToldToRead: true })["claude-worker"], "whole-file");
  assert.equal(census({ claudeWorkerIsolated: true, sdkRequiresProject: false, codexToldToRead: true })["claude-worker"], "whole-file");
  assert.equal(census({ claudeWorkerIsolated: true, sdkRequiresProject: true, codexToldToRead: false })["codex-worker"], "none");
});

test("W1-T2759: the three artifacts that carried the false claim now name the lane that pays", () => {
  // CLAUDE.md's own maintenance line.
  const md = readFileSync(CLAUDE_MD, "utf8");
  assert.match(md, /settingSources/, "the maintenance line must name the isolation option that makes the distinction");
  assert.equal(/injected in full into every session, so it is a context tax/.test(md), false, "the unqualified claim must be gone");
  // The ratchet suite's own header.
  const ratchetTest = readFileSync(join(REPO_ROOT, "test", "claude-md-budget-ratchet.test.ts"), "utf8");
  assert.equal(/injected in full into every session on every lane/.test(ratchetTest), false);
  assert.match(ratchetTest, /INTERACTIVE session/);
  // The cap baseline's rationale.
  assert.match(readFileSync(join(REPO_ROOT, "scripts", "claude-md-budget-baseline.json"), "utf8"), /W1-T2759/);
});
