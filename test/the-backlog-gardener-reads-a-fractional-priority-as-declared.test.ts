import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { parse as parseYaml } from "yaml";

import { applyBacklogActions, type BacklogAction, type BacklogDisposition } from "../src/lib/backlog-gardener.js";

const SIGNATURE = "0123456789abcdef";
const OLD_SIGNATURE = "fedcba9876543210";

// Shaped like plan/tasks.d/w1-t6287-selector-shadow-miss.yaml: the machine-filing judge's 2.5.
const FRACTIONAL = [
  "- id: W1-T6287",
  "  title: \"REPAIR THE SELECTOR EDGE\"",
  "  repo: remudero",
  "  depends_on: []",
  "  type: implement",
  "  verify: auto",
  "  priority: 2.5",
  "  risk: low",
  "  status: queued",
  "  attempts: 0",
  "  author_class: machine",
  "  files: [src/lib/affected-suites.ts]",
  "",
].join("\n");

function shard(id: string, priority: string | undefined, marker: number | undefined): string {
  return [
    `- id: ${id}`,
    `  title: task ${id}`,
    "  repo: remudero",
    ...(priority === undefined ? [] : [`  priority: ${priority}`]),
    "  status: queued",
    ...(marker === undefined ? [] : [`  # backlog gardener: band=${marker} evidence=${OLD_SIGNATURE}`]),
    "  attempts: 0",
    "",
  ].join("\n");
}

function action(target: string, disposition: BacklogDisposition): BacklogAction {
  return {
    class: disposition.kind === "retire" ? "retire" : "place",
    target,
    reason: "fixture",
    disposition,
    evidence: { fanout: 0, symptoms: [], missingFiles: [], presentFiles: [], missingSymbols: [], presentSymbols: [], proofsHold: false, signature: SIGNATURE },
  };
}

function fixture(t: { after: (fn: () => void) => void }, texts: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "rmd-backlog-fraction-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "plan", "tasks.d"), { recursive: true });
  const shards = new Map<string, string>();
  for (const [id, text] of Object.entries(texts)) {
    const rel = `plan/tasks.d/${id}.yaml`;
    shards.set(id, rel);
    writeFileSync(join(root, rel), text);
  }
  return { root, shards, read: (id: string) => readFileSync(join(root, shards.get(id)!), "utf8") };
}

/** Parses with the yaml package's default `uniqueKeys`, so a duplicate `priority:` throws. */
function parsedTask(text: string): Record<string, unknown> {
  const doc = parseYaml(text) as Array<Record<string, unknown>>;
  assert.equal(Array.isArray(doc) && doc.length, 1, "a shard holds exactly one task");
  return doc[0]!;
}

function priorityLines(text: string): number {
  return text.split("\n").filter((line) => /^ {2}priority:/.test(line)).length;
}

test("W1-T6307: a fractional declared priority is respected, not duplicated", (t) => {
  const f = fixture(t, { "W1-T6287": FRACTIONAL });
  assert.deepEqual(applyBacklogActions(f.root, f.shards, [action("W1-T6287", { kind: "band", band: 4 })]), []);
  assert.equal(f.read("W1-T6287"), FRACTIONAL, "a judge-set 2.5 is the shard's own priority; the gardener must not touch it");
  assert.equal(parsedTask(f.read("W1-T6287")).priority, 2.5);
});

test("W1-T6307: a gardened shard always parses with one priority key", (t) => {
  const f = fixture(t, {
    "W1-T1": shard("W1-T1", "2", 2), // integer, ours by marker: the band may move
    "W1-T2": FRACTIONAL.replace("W1-T6287", "W1-T2"), // fractional, not ours
    "W1-T3": shard("W1-T3", undefined, undefined), // undeclared: the gardener adds one
    "W1-T4": shard("W1-T4", "3", 3), // integer, ours: retirement removes it
    "W1-T5": shard("W1-T5", "2.5", undefined), // fractional facing retirement: not ours, untouched
  });
  const written = applyBacklogActions(f.root, f.shards, [
    action("W1-T1", { kind: "band", band: 3 }),
    action("W1-T2", { kind: "band", band: 2 }),
    action("W1-T3", { kind: "band", band: 4 }),
    action("W1-T4", { kind: "retire", retirement: "withdrawn" }),
    action("W1-T5", { kind: "retire", retirement: "closed" }),
  ]);
  assert.deepEqual(written, ["plan/tasks.d/W1-T1.yaml", "plan/tasks.d/W1-T3.yaml", "plan/tasks.d/W1-T4.yaml"]);

  const expected: Record<string, number | undefined> = { "W1-T1": 3, "W1-T2": 2.5, "W1-T3": 4, "W1-T4": undefined, "W1-T5": 2.5 };
  for (const [id, priority] of Object.entries(expected)) {
    const text = f.read(id);
    const parsed = parsedTask(text);
    assert.equal(parsed.priority, priority, `${id} carries the expected priority`);
    assert.equal(priorityLines(text), priority === undefined ? 0 : 1, `${id} holds ${priority === undefined ? "no" : "exactly one"} priority line`);
  }
  assert.equal(parsedTask(f.read("W1-T4")).status, "blocked");
  assert.equal(parsedTask(f.read("W1-T4")).retirement, "withdrawn");
  assert.equal(parsedTask(f.read("W1-T5")).status, "queued");
});
