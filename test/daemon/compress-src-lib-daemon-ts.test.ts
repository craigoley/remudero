// @source-text-subject: compare daemon.ts's executable text and comment volume before/after compression.
// @census-reads: src/lib/daemon.ts
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { transformSync } from "esbuild";
import { parse } from "@babel/parser";
import { stripComments } from "#src/lib/test-placement.js";
import { assertSameTokens, compressionPinBase } from "#test/helpers/compression-pin.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

// This executable script has no declaration file; load its real export with an explicit type.
const { countCommentLines } = await import(import.meta.resolve("#scripts/comment-load-ratchet.mjs")) as {
  countCommentLines: (text: string, path: string) => { comments: number; code: number };
};

// Comment floor from 8c654c1a3cf7265719d1162ac1862ffd77c41f91:src/lib/daemon.ts, before compression.
// Keep code lines (including types and punctuation); only blank lines and trailing spaces are ignored.
function executableDigest(source: string): string {
  const code = stripComments(source).split("\n").map(line => line.trimEnd())
    .filter(line => line.trim().length > 0).join("\n");
  return createHash("sha256").update(code).digest("hex");
}

const BEFORE_COMMENTS = 2085;

function emittedDigest(source: string): string {
  const { code } = transformSync(source, { loader: "ts", format: "esm", legalComments: "none" });
  return createHash("sha256").update(code).digest("hex");
}

function executableTokens(source: string) {
  const parsed = parse(source, {
    sourceType: "module", plugins: ["typescript"], tokens: true, attachComment: false,
  });
  return parsed.tokens!.filter(token => typeof token.type !== "string")
    .map(token => [token.type.label, source.slice(token.start, token.end)]);
}

test("W1-T12263: comment compression preserves executable code", (t) => {
  const sourcePath = "src/lib/daemon.ts";
  const source = readFileSync(join(REPO_ROOT, sourcePath), "utf8");
  let before = compressionPinBase(sourcePath, import.meta.url);
  if (before === undefined) {
    // This file already has a pin: retire this comparison once its own title reaches main.
    const git = (args: string[]) => {
      const result = spawnSync("git", args, {
        cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
      });
      assert.equal(result.status, 0, `git ${args[0]} failed: ${result.error ?? result.stderr}`);
      return result.stdout;
    };
    const base = git(["merge-base", "origin/main", "HEAD"]).trim();
    if (git(["show", `${base}:test/daemon/compress-src-lib-daemon-ts.test.ts`]).includes(
      "W1-T12263: comment compression preserves executable code")) return;
    before = git(["show", `${base}:${sourcePath}`]);
  }
  assertSameTokens(executableTokens(source), executableTokens(before),
    "all executable tokens, including types and literal contents, match the PR base");
  assert.equal(executableDigest(source), executableDigest(before), "non-comment code lines match");
  assert.equal(emittedDigest(source), emittedDigest(before), "emitted JavaScript and ASI match");
  const previous = countCommentLines(before, sourcePath).comments;
  const comments = countCommentLines(source, sourcePath).comments;
  t.diagnostic(`comment lines: ${previous} -> ${comments}`);
  assert.ok(previous > 0 && comments > 0, "both measurements see comments");
  assert.ok(comments < previous, `comment lines decrease: ${comments} >= ${previous}`);
  const bytes = (text: string) => parse(text, { sourceType: "module", plugins: ["typescript"] })
    .comments!.reduce((sum, comment) => sum + Buffer.byteLength(comment.value), 0);
  assert.ok(bytes(source) < bytes(before), "comment bytes decrease too; rewrapping is insufficient");
});

// `before` is the module at the PR base on the pull request that adds this pin, else undefined.
function assertCompression(source: string, before: string | undefined) {
  if (before === undefined) return;
  // Only on the PR that adds this pin: later feature edits to the module stay free.
  const { comments } = countCommentLines(source, "src/lib/daemon.ts");
  assert.ok(comments < BEFORE_COMMENTS, `comments must decrease from the measured ${BEFORE_COMMENTS}; got ${comments}`);
  assert.equal(executableDigest(source), executableDigest(before), "all non-comment code lines match the PR base");
  // Independently catch ASI changes and whitespace inside multiline string/template literals.
  assert.equal(emittedDigest(source), emittedDigest(before), "emitted JavaScript matches the PR base");
  assert.ok(comments < countCommentLines(before, "src/lib/daemon.ts").comments,
    "comment lines decrease from the PR base");
}

test("W1-T10871: comment compression preserves executable code", () => {
  const source = readFileSync(join(REPO_ROOT, "src/lib/daemon.ts"), "utf8");
  assertCompression(source, compressionPinBase("src/lib/daemon.ts", import.meta.url));
});

test("W1-T13387 criterion 1: a pull request that does not add the pin may add comment lines", () => {
  const source = "const value = 1;";
  const grown = `${"// added\n".repeat(BEFORE_COMMENTS)}${source}`;
  assert.ok(countCommentLines(grown, "src/lib/daemon.ts").comments >= BEFORE_COMMENTS);
  assert.doesNotThrow(() => assertCompression(grown, undefined));
});

test("W1-T13387 criterion 2: the adding pull request needs fewer comment lines and the same code", () => {
  const source = 'const s = "// kept"; const t = `/* kept */`;\nconst n = 1;';
  const before = `// long comment\n// another long comment\n${source}`;
  const shorter = `// short\n${source}`;
  assert.doesNotThrow(() => assertCompression(shorter, before));
  assert.throws(() => assertCompression(before, before), /comment lines decrease/);
  assert.throws(() => assertCompression(`// a\n// b\n// c\n${source}`, before), /comment lines decrease/);
  const filled = (lines: number) => `${"// filler\n".repeat(lines)}${source}`;
  assert.throws(() => assertCompression(filled(BEFORE_COMMENTS), filled(BEFORE_COMMENTS + 1)),
    /must decrease from the measured/);
  assert.throws(() => assertCompression(shorter.replace("n = 1", "n = 2"), before), /non-comment code lines/);
  assert.throws(() => assertCompression(`${shorter}\nconst extra = 2;`, before), /non-comment code lines/);
  // Text inside a string or a template is code, however much it looks like a comment.
  assert.throws(() => assertCompression(shorter.replace('"// kept"', '"// cut"'), before), /non-comment code lines/);
  assert.throws(() => assertCompression(shorter.replace("`/* kept */`", "`/* cut */`"), before),
    /non-comment code lines/);
  assert.throws(() => assertCompression("// one\nconst text = `a\nb`;", "// one\n// two\nconst text = `a\n\nb`;"),
    /emitted JavaScript/);
});

test("daemon compression digests ignore comments and catch executable edits", () => {
  const control = 'const url = "https://example.com"; // explanation\nconst n = 1;';
  assert.equal(executableDigest(control), executableDigest(control.replace("explanation", "shorter")));
  assert.equal(emittedDigest(control), emittedDigest(`/* detail */\n${control}`));
  for (const [from, to] of [["n = 1", "n = 2"], ["example.com", "other.test"]]) {
    assert.notEqual(executableDigest(control), executableDigest(control.replace(from, to)));
    assert.notEqual(emittedDigest(control), emittedDigest(control.replace(from, to)));
  }
  assert.notEqual(emittedDigest("function f() { return 1; }"), emittedDigest("function f() { return\n1; }"));
});
