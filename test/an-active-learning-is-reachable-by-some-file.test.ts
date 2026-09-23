/**
 * test/an-active-learning-is-reachable-by-some-file.test.ts — W1-T4240.
 *
 * A learning is injected only when one of its `files:` globs hits a task file, and the matcher
 * anchors every glob. A bare directory (`test`, `plan/tasks.d`) therefore reaches nothing: on
 * 2026-09-23 four active entries could never be injected. The live-corpus census below makes the
 * next dead glob a CI failure in the PR that introduces it — including a PR that deletes a
 * learning's last matching file.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

import { loadLearningsCorpus, selectLearnings, unreachableLearnings, type LearningEntry } from "../src/lib/learnings.js";
import { matchedLinesAreAllComments } from "../src/lib/review.js";

const entry = (id: string, files: string[], lifecycle: LearningEntry["lifecycle"] = "active"): LearningEntry =>
  ({ id, subsystem: "t", lifecycle, files, fact: `fact ${id}`, src: "t" }) as LearningEntry;

const TRACKED = ["test/a.test.ts", "src/lib/x.ts", "docs/guide.md"];

test("W1-T4240: a learning whose every glob is dead is unreachable", () => {
  const bare = entry("bare", ["test"]);
  const recursive = entry("recursive", ["test/**"]);
  const mixed = entry("mixed", ["docs", "src/lib/*.ts"]);
  const report = unreachableLearnings([bare, recursive, mixed], TRACKED);

  // Positive control: the bare form is dead and the recursive form of the SAME directory is not,
  // so an empty report on the live corpus cannot be a census that sees nothing.
  assert.deepEqual(report, [
    { id: "bare", deadGlobs: ["test"], unreachable: true },
    { id: "mixed", deadGlobs: ["docs"], unreachable: false },
  ]);
  // The census agrees with selection itself: the entry it calls unreachable is never selected.
  assert.equal(selectLearnings([bare], TRACKED, 1e9).selected.length, 0);
  assert.equal(selectLearnings([recursive], TRACKED, 1e9).selected.length, 1);
});

test("W1-T4240: an entry with no globs is reachable only through a symbol or error signature", () => {
  const bySymbol = { ...entry("by-symbol", []), symbols: ["mkdtemp"] } as LearningEntry;
  const byError = { ...entry("by-error", []), errorSignatures: ["ERR_MODULE_NOT_FOUND"] } as LearningEntry;
  const nothing = entry("nothing", []);
  assert.deepEqual(unreachableLearnings([bySymbol, byError, nothing], TRACKED), [{ id: "nothing", deadGlobs: [], unreachable: true }]);
  // The trigger really selects it: selection text naming the symbol admits the path-less entry.
  assert.equal(selectLearnings([bySymbol], [], 1e9, { text: "a mkdtemp exemption keyed by position" }).selected.length, 1);
  assert.equal(selectLearnings([nothing], TRACKED, 1e9, { text: "anything" }).selected.length, 0);
});

test("W1-T4240: entries that are never injected are not reported", () => {
  const report = unreachableLearnings(
    [entry("s", ["test"], "superseded"), entry("q", ["test"], "quarantined"), entry("c", ["test"], "contested")],
    TRACKED,
  );
  assert.deepEqual(report, []);
});

test("W1-T4240: every active learning in the live corpus is reachable", () => {
  const tracked = execFileSync("git", ["ls-files"], { encoding: "utf8", maxBuffer: 1 << 26 }).split("\n").filter(Boolean);
  const corpus = loadLearningsCorpus("learnings");
  assert.ok(tracked.length > 1000, `git ls-files returned ${tracked.length} paths; the census would read nothing`);
  assert.ok(corpus.some((e) => e.lifecycle === "active"), "the live corpus loaded no active learning");

  const dead = unreachableLearnings(corpus, tracked);
  assert.deepEqual(
    dead,
    [],
    "active learnings with `files:` globs that match no tracked path (repoint the glob, e.g. `test` -> `test/**`, " +
      "or set `lifecycle: superseded` with `superseded_by`):\n" +
      dead.map((d) => `  ${d.id}: ${d.deadGlobs.join(", ")}${d.unreachable ? "  (UNREACHABLE)" : ""}`).join("\n"),
  );
});

test("W1-T4240: every learnings shard line stays visible to the proof judge", () => {
  // The review's comment mask reads `/*` as a block-comment opener in ANY file, so one unquoted
  // `src/**` glob turns the rest of a YAML shard into "comments" and withdraws every grep proof
  // aimed at it. Quote such globs, as ci.yaml already does (`".github/**"`).
  const shards = readdirSync("learnings").filter((f) => f.endsWith(".yaml"));
  assert.ok(shards.length >= 5, `found ${shards.length} learnings shards`);
  const blind: string[] = [];
  for (const shard of shards) {
    const text = readFileSync(`learnings/${shard}`, "utf8");
    text.split("\n").forEach((line, i) => {
      if (!/^- id: /.test(line)) return;
      if (matchedLinesAreAllComments([`learnings/${shard}:${i + 1}:${line}`], { pattern: line.slice(2), fileText: text })) blind.push(`${shard}:${i + 1}`);
    });
  }
  // Positive control: an unquoted glob above an id line DOES blind it, so an empty list is a reading.
  const control = "- id: a\n  files: [src/**]\n- id: b\n";
  assert.equal(matchedLinesAreAllComments(["x:3:- id: b"], { pattern: "id: b", fileText: control }), true);
  assert.deepEqual(blind, [], "learnings lines the proof judge reads as comments (quote the `/**` glob above them)");
});
