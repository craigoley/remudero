import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GATE_URL = pathToFileURL(join(REPO_ROOT, "scripts", "prompt-surface-gate.mjs")).href;

const {
  evaluatePromptSurfaceDiff,
  isCommentOnlyYamlChange,
  parseUnifiedDiff,
  refusalMessage,
} = (await import(GATE_URL)) as {
  evaluatePromptSurfaceDiff: (
    diff: string,
    opts?: { root?: string; base?: string; head?: string },
  ) => { ok: boolean; message: string; surfaces: string[]; evidence: string[] };
  isCommentOnlyYamlChange: (file: { newPath: string; oldPath: string; changedLines?: string[] }) => boolean;
  parseUnifiedDiff: (diff: string) => Array<{ newPath: string; oldPath: string; changedLines?: string[] }>;
  refusalMessage: (surfaces: string[]) => string;
};

// ── the gate offered a remedy that cannot work ───────────────────────────────────────────────────
//
// MEASURED on #5064. Its only `learnings/platform.yaml` change was four COMMENT lines documenting the
// new `symbols:` / `error_signatures:` fields. The gate refused it with:
//
//   "prompt surface touched without golden evidence: learnings/platform.yaml. Satisfy it by
//    adding/updating test/fixtures/golden-verdicts/**, or by touching a test/** file that renders
//    each changed prompt function."
//
// That PR touched SEVEN test files. It could not have satisfied the second clause however many it
// touched: `evidenceFor` derives a symbol per surface with /^.+:([^:]+)$/, a bare path yields none,
// and `symbolSurfaces.length !== surfaces.length` returns [] before any test file is read. A gate
// naming an impossible remedy is worse than one naming none — the author does the work, stays
// refused, and stops trusting the gate.
//
// TWO DEFECTS, TWO FIXES: a schema comment renders nothing, so it is no longer a touched surface at
// all; and the refusal now states the remedy that exists for the KIND of surface it refused.

const diffFor = (path: string, lines: string[]): string =>
  [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, "@@ -1,0 +1,0 @@", ...lines].join("\n");

const COMMENT_ONLY = diffFor("learnings/platform.yaml", [
  "-#   files:             repo-relative globs; entry injects iff one glob hits a task file",
  "+#   files:             repo-relative globs; entry injects when one glob hits a task file",
  "+#   symbols:           optional identifiers this fact is about",
]);

const DATA_CHANGE = diffFor("learnings/platform.yaml", [
  "-  text: the old fact that really does get injected",
  "+  text: a NEW fact that really does get injected",
]);

const MIXED = diffFor("learnings/platform.yaml", [
  "+#   symbols:           a harmless comment",
  "+  text: but this line is injected",
]);

// ── the exemption ────────────────────────────────────────────────────────────────────────────────

test("a COMMENT-ONLY learnings edit is not a prompt surface — the #5064 shape", () => {
  const verdict = evaluatePromptSurfaceDiff(COMMENT_ONLY, { root: REPO_ROOT });
  assert.equal(verdict.ok, true, verdict.message);
  assert.deepEqual(verdict.surfaces, [], "a schema comment renders nothing and must raise no surface");
});

test("CONTROL: a DATA change to the same file still refuses — the exemption is not a hole", () => {
  const verdict = evaluatePromptSurfaceDiff(DATA_CHANGE, { root: REPO_ROOT });
  assert.equal(verdict.ok, false, "an injected-content change must still demand evidence");
  assert.deepEqual(verdict.surfaces, ["learnings/platform.yaml"]);
});

test("CONTROL: a comment added BESIDE a data line still refuses — both directions must be furniture", () => {
  const verdict = evaluatePromptSurfaceDiff(MIXED, { root: REPO_ROOT });
  assert.equal(verdict.ok, false, "one injected line among comments is still an injected change");
});

test("a REMOVED data line beside an ADDED comment is not exempt", () => {
  const sneaky = diffFor("learnings/platform.yaml", [
    "-  text: a fact being deleted",
    "+#   text: … now merely described",
  ]);
  assert.equal(evaluatePromptSurfaceDiff(sneaky, { root: REPO_ROOT }).ok, false);
});

test("isCommentOnlyYamlChange: nothing observed is NOT evidence of nothing changed", () => {
  // An empty changed-line list would otherwise exempt every YAML surface by default, which is the
  // vacuous-pass direction. A file the parser saw no lines for must stay refusable.
  assert.equal(isCommentOnlyYamlChange({ newPath: "learnings/x.yaml", oldPath: "learnings/x.yaml", changedLines: [] }), false);
  assert.equal(isCommentOnlyYamlChange({ newPath: "learnings/x.yaml", oldPath: "learnings/x.yaml" }), false);
  // …and a non-YAML path is never exempt by this route whatever its lines look like.
  assert.equal(
    isCommentOnlyYamlChange({ newPath: "src/lib/learnings.ts", oldPath: "src/lib/learnings.ts", changedLines: ["+// a comment"] }),
    false,
  );
});

test("the parser now carries changed-line TEXT, which the exemption is decided on", () => {
  const files = parseUnifiedDiff(COMMENT_ONLY);
  assert.equal(files.length, 1);
  // POSITIVE CONTROL: ranges alone could not distinguish these cases, so the text must be present.
  assert.ok((files[0].changedLines ?? []).length >= 2, "changed line text was not captured");
  assert.ok(
    (files[0].changedLines ?? []).every((l) => /^[+-]#|^[+-]\s*$/.test(l)),
    "the captured lines are not the comment lines this diff contains",
  );
  // NO ASSERTION HERE ABOUT +++/--- HEADERS. One was written and it could never fail: the parser's
  // header branches consume those lines and `continue` before the capture is reached. Deleting the
  // redundant guard killed no test, which is how the dead code was found — so both went, rather than
  // keeping an assertion that passes for a reason unrelated to what it claims to check.
});

// ── the refusal names a remedy that exists ───────────────────────────────────────────────────────

test("a PATH-surface refusal says golden evidence is the ONLY route, and does not promise a test file", () => {
  const msg = refusalMessage(["learnings/platform.yaml"]);
  assert.match(msg, /golden-verdicts/, "it must name the route that works");
  assert.match(msg, /ONLY admissible/, "and say it is the only one");
  assert.match(msg, /a test\/\*\* file cannot satisfy a path surface/, "and say plainly why the other route cannot apply");
  assert.match(msg, /comment-only YAML change is already exempt/, "and point at the exemption when the edit renders nothing");
});

test("a SYMBOL-surface refusal still offers BOTH routes, because both really work there", () => {
  const msg = refusalMessage(["src/lib/prompt-render.ts:renderFixPrompt"]);
  assert.match(msg, /renderFixPrompt/);
  // Asserted on INTENT, not phrasing: both routes offered, and the fixture directory named so an
  // author knows where to put one. Pinning the sentence is how a message improvement reads as a
  // regression — which is what happened when this suite first went red against its own gate.
  assert.match(msg, /golden verdict/);
  assert.match(msg, /test\/fixtures\/golden-verdicts/, "a refusal must name WHERE a golden verdict goes");
  assert.match(msg, /test\/\*\* file naming each changed function/);
  assert.equal(/ONLY admissible/.test(msg), false, "a symbol surface must not be told golden is the only way");
});

test("a MIXED refusal separates the two kinds rather than averaging them", () => {
  const msg = refusalMessage(["learnings/platform.yaml", "src/lib/prompt-render.ts:renderFixPrompt"]);
  assert.match(msg, /PATH surface\(s\) learnings\/platform\.yaml/);
  assert.match(msg, /SYMBOL surface\(s\) src\/lib\/prompt-render\.ts:renderFixPrompt/);
});

test("the live gate emits the corrected message, not the old impossible one", () => {
  const verdict = evaluatePromptSurfaceDiff(DATA_CHANGE, { root: REPO_ROOT });
  assert.equal(verdict.ok, false);
  assert.equal(
    /or by touching a test\/\*\* file that renders each changed prompt function/.test(verdict.message),
    false,
    "the refusal still promises the remedy that cannot satisfy a path surface",
  );
  assert.match(verdict.message, /ONLY admissible evidence is a golden verdict/);
});

test("a diff touching NO prompt surface is still silently OK", () => {
  const unrelated = diffFor("docs/readme.md", ["+a line"]);
  const verdict = evaluatePromptSurfaceDiff(unrelated, { root: REPO_ROOT });
  assert.equal(verdict.ok, true);
  assert.match(verdict.message, /no prompt surface touched/);
});
