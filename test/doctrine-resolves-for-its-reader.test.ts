import assert from "node:assert/strict";
import test from "node:test";

import {
  DoctrineUnresolvableError,
  parseRuleHeadlines,
  resolveDoctrine,
} from "../src/lib/learnings.js";

// ── W1-T3322 — THE DOCTRINE TESTS PIN THE FILE, NOT WHAT A READER RESOLVES ────────────────────
//
// The suites that guard doctrine assert a FACT IS PRESENT — "CLAUDE.md must say what ships on merge"
// (test/fleet-heartbeat-image-sha.test.ts). They read the raw file, so they pin the CONTAINER when
// they mean the CONTENTS. A rule whose body moves to a store the reader can still reach fails them
// anyway, which is exactly why W1-T2507 migrated three bullets, watched tests redden, and reverted.
//
// NO RULE MOVES IN THIS TASK. Only how a test reads changes.

const DOCTRINE = [
  "# rules",
  "",
  "## Before you push",
  "",
  "- **Run the gate before your FIRST push.** it shells CI's own commands *(W1-T294)*",
  "- **A ghost path returns a green count, silently.** `ls` first, then diff the summaries *(2026-08-09)*",
  "",
].join("\n");

test("W1-T3322: a test can resolve the doctrine a reader sees, through the same primitives run-task.ts uses", () => {
  const d = resolveDoctrine("CLAUDE.md", { readFile: () => DOCTRINE });
  assert.equal(d.rules.length, 2);
  assert.deepEqual(d.unresolved, []);
  // The INDEX carries the instruction; the resolved TEXT carries index plus every body.
  assert.match(d.index, /Run the gate before your FIRST push/);
  assert.doesNotMatch(d.index, /shells CI's own commands/);
  assert.match(d.text, /shells CI's own commands/);
  assert.match(d.text, /ls` first/);
  // It composes the shipped primitives rather than re-parsing: same rule count as parseRuleHeadlines.
  assert.equal(parseRuleHeadlines(DOCTRINE).length, d.rules.length);
});

test("W1-T3322 MIGRATION REHEARSAL: a fact asserted through the resolver survives its body MOVING to another store", () => {
  // THE CONTROL THAT MAKES W1-T3323 SAFE. The same assertion must hold before and after a body
  // moves. If it fails here, the resolver is reading the container again and the migration will
  // revert exactly as W1-T2507's three bullets did.
  const before = resolveDoctrine("CLAUDE.md", { readFile: () => DOCTRINE });
  assert.match(before.text, /shells CI's own commands/);

  // The migrated shape: the index keeps headlines, the bodies live somewhere else entirely.
  const indexOnly = DOCTRINE.replace(" it shells CI's own commands *(W1-T294)*", " → doctrine/gate.md")
    .replace(" `ls` first, then diff the summaries *(2026-08-09)*", " → doctrine/ghost-path.md");
  const store = new Map([
    ["Run the gate before your FIRST push.", " it shells CI's own commands *(W1-T294)*"],
    ["A ghost path returns a green count, silently.", " `ls` first, then diff the summaries *(2026-08-09)*"],
  ]);
  const after = resolveDoctrine("CLAUDE.md", {
    readFile: () => indexOnly,
    retrieveBody: (h) => store.get(h),
  });
  assert.match(after.text, /shells CI's own commands/, "the fact must survive the move");
  assert.match(after.text, /ls` first/);
  assert.deepEqual(after.unresolved, []);
  // AND THE RAW FILE NO LONGER CARRIES IT — otherwise the rehearsal proves nothing.
  assert.doesNotMatch(indexOnly, /shells CI's own commands/);
});

test("W1-T3322: it still FAILS when the fact is deleted — the rehearsal must not make assertions unfalsifiable", () => {
  // Deleting is the real falsifier; moving is the thing that must be tolerated. A resolver that
  // tolerates both has made every doctrine assertion in the repo worthless.
  const deleted = DOCTRINE.replace("- **Run the gate before your FIRST push.** it shells CI's own commands *(W1-T294)*\n", "");
  const d = resolveDoctrine("CLAUDE.md", { readFile: () => deleted });
  assert.doesNotMatch(d.text, /shells CI's own commands/);
  assert.equal(d.rules.length, 1);
});

test("W1-T3322: an unreadable or empty source FAILS rather than resolving empty", () => {
  assert.throws(
    () =>
      resolveDoctrine("CLAUDE.md", {
        readFile: () => {
          throw new Error("ENOENT");
        },
      }),
    (e: unknown) => e instanceof DoctrineUnresolvableError && /unreadable/.test((e as Error).message),
  );
  // A source that parses to zero rules is the vacuous case: every "must say X" would pass over "".
  assert.throws(
    () => resolveDoctrine("CLAUDE.md", { readFile: () => "# rules\n\nno bullets here\n" }),
    (e: unknown) => e instanceof DoctrineUnresolvableError && /zero rules/.test((e as Error).message),
  );
});

test("W1-T3322: a body that cannot be retrieved is NAMED and degrades visibly, never silently dropped", () => {
  const d = resolveDoctrine("CLAUDE.md", {
    readFile: () => DOCTRINE,
    retrieveBody: (h) => (h.startsWith("Run the gate") ? undefined : " retrieved"),
  });
  assert.deepEqual(d.unresolved, ["Run the gate before your FIRST push."]);
  // retrieveRuleBodyOrDegrade's contract: the headline still renders, so the instruction survives
  // even when its evidence does not — absent evidence must not delete the rule.
  assert.match(d.text, /Run the gate before your FIRST push/);
});

test("W1-T3322: the REAL CLAUDE.md resolves — the resolver is exercised against the live doctrine, not only fixtures", () => {
  // Drives the DEFAULT readFile against the real file: a resolver proven only on fixtures says
  // nothing about the document every session actually loads.
  const d = resolveDoctrine(new URL("../CLAUDE.md", import.meta.url).pathname);
  assert.ok(d.rules.length > 40, `expected the real doctrine, got ${d.rules.length} rules`);
  assert.deepEqual(d.unresolved, [], "every rule in the live file must resolve its own body");
  assert.ok(d.text.length > d.index.length, "the resolved text must carry more than the index alone");
});
