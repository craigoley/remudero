// W1-T1270: `parseProposalRegistry` used to collapse FOUR distinct inputs — an absent
// registry file, a torn/malformed one, a wrong-shaped one, and a genuinely empty one —
// into the identical `[]`, so nobody looking at `rmd inbox` could tell "this path has
// never fired" from "it fired and was drained" from the silent-empty corruption
// `updateProposalRegistry`'s own header doc warns about. These tests pin the new
// discriminated `parseProposalRegistryResult` (which tells the four cases apart) AND
// confirm the existing `parseProposalRegistry` fail-soft `[]` contract every caller
// already depends on is untouched.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseProposalRegistry, parseProposalRegistryResult, type Proposal } from "../src/lib/inbox.js";

test("parseProposalRegistryResult: an absent registry is reported apart from a genuinely empty one", () => {
  const absent = parseProposalRegistryResult(undefined);
  assert.deepEqual(absent, { kind: "absent" });

  const emptyText = JSON.stringify({ proposals: [] });
  const empty = parseProposalRegistryResult(emptyText);
  assert.deepEqual(empty, { kind: "ok", proposals: [] });

  // Same downstream `[]` for both, but the discriminated result tells them apart —
  // that distinction is the whole point of this task.
  assert.notEqual(absent.kind, empty.kind);
});

test("parseProposalRegistryResult: a torn or malformed registry is a fault, never a silent empty", () => {
  const torn = parseProposalRegistryResult('{"proposals": [{"id": "P1", "summ'); // truncated mid-write
  assert.deepEqual(torn, { kind: "fault", reason: "malformed" });

  const notJson = parseProposalRegistryResult("not json");
  assert.deepEqual(notJson, { kind: "fault", reason: "malformed" });
});

test("parseProposalRegistryResult: a registry whose proposals key is missing or wrong-shaped is a fault", () => {
  assert.deepEqual(parseProposalRegistryResult("{}"), { kind: "fault", reason: "wrong-shape" });
  assert.deepEqual(
    parseProposalRegistryResult('{"proposals": "not an array"}'),
    { kind: "fault", reason: "wrong-shape" },
  );
  assert.deepEqual(parseProposalRegistryResult("null"), { kind: "fault", reason: "wrong-shape" });
});

test("parseProposalRegistryResult: a populated registry still parses to its proposals unchanged", () => {
  const proposals: Proposal[] = [
    { id: "P1", summary: "s1", evidenceAnchors: [] },
    { id: "P2", summary: "s2", evidenceAnchors: [] },
  ];
  const result = parseProposalRegistryResult(JSON.stringify({ proposals }));
  assert.deepEqual(result, { kind: "ok", proposals });
});

test("parseProposalRegistryResult: an empty proposals array is still a legitimate empty result, not a fault", () => {
  const result = parseProposalRegistryResult(JSON.stringify({ proposals: [] }));
  assert.deepEqual(result, { kind: "ok", proposals: [] });
});

test("parseProposalRegistry: no caller is made to fail on a registry that has never been created", () => {
  // Every existing caller keeps getting `[]` back for exactly the inputs it always did —
  // the new discrimination lives only in parseProposalRegistryResult, so this fail-soft
  // contract (undefined/malformed/wrong-shaped -> [], never a throw) is unchanged.
  assert.deepEqual(parseProposalRegistry(undefined), []);
  assert.deepEqual(parseProposalRegistry("not json"), []);
  assert.deepEqual(parseProposalRegistry("{}"), []);
  assert.deepEqual(parseProposalRegistry('{"proposals": "not an array"}'), []);

  const proposals: Proposal[] = [{ id: "P1", summary: "s", evidenceAnchors: [] }];
  assert.deepEqual(parseProposalRegistry(JSON.stringify({ proposals })), proposals);
  assert.deepEqual(parseProposalRegistry(JSON.stringify({ proposals: [] })), []);
});
