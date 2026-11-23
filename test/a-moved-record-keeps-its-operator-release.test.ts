// W1-T14408: the mover's moved_from line is provenance, never an approved term, so a release survives a catalog move.
import assert from "node:assert/strict";
import { test } from "node:test";
// Namespace import: a name this build changes reads at base without a load-time failure.
import * as release from "#src/lib/operator-release.js";
import { parseTasksFromYaml } from "#src/lib/plan.js";

const SHA = "a".repeat(40);
const PUBLIC_TEXT = [
  "- id: W1-T7", "  title: a released record", "  repo: remudero", "  type: implement", "  priority: 1",
  "  status: queued", "  verify: human", "  files:", "    - src/a.ts", "  acceptance:",
  "    - claim: it works", "      proof: \"grep: works in src/a.ts\"", "  design: |", "    do the thing", "",
].join("\n");
const withMove = (text: string): string => text.replace("- id: W1-T7\n", `- id: W1-T7\n  moved_from: remudero@${SHA}\n`);
const load = (text: string, label: string) => parseTasksFromYaml(text, label)[0]!;
const pinOf = (task: unknown): string => release.operatorReleasePin(task as Parameters<typeof release.operatorReleasePin>[0]);

/** A ratify.approved row as the release authority reads it, resolved through the real pin lookup. */
function releasedFor(approvedAgainst: unknown, reading: unknown): { released: boolean; reapproval: boolean } {
  const row = JSON.stringify({ step: "ratify.approved", task_id: "W1-T7", release_pin: pinOf(approvedAgainst), released: "verify-human" });
  const evidence = release.qualifyReleaseEvidence([row], new Map(),
    release.releaseContractPins([reading as Parameters<typeof release.releaseContractPins>[0][number]]));
  return { released: evidence.authors.get("W1-T7") === "operator", reapproval: evidence.reapproval.has("W1-T7") };
}

test("W1-T14408 criterion 1: a record and the same record with a moved_from line pin the same", () => {
  const pub = load(PUBLIC_TEXT, "public");
  const ops = load(withMove(PUBLIC_TEXT), "ops");
  assert.equal(ops.moved_from, `remudero@${SHA}`, "the parsed ops copy really carries the provenance line");
  assert.equal(pinOf(ops), pinOf(pub));
});

test("W1-T14408 criterion 2: a release against the public record holds for the moved copy; any contract term change still needs reapproval", () => {
  const pub = load(PUBLIC_TEXT, "public");
  const ops = load(withMove(PUBLIC_TEXT), "ops");
  assert.deepEqual(releasedFor(pub, ops), { released: true, reapproval: false });
  const changed: Record<string, string> = {
    title: PUBLIC_TEXT.replace("a released record", "a different record"),
    files: PUBLIC_TEXT.replace("src/a.ts\n  acceptance", "src/b.ts\n  acceptance"),
    acceptance: PUBLIC_TEXT.replace("it works", "it works differently"),
    design: PUBLIC_TEXT.replace("do the thing", "do another thing"),
  };
  for (const [term, text] of Object.entries(changed)) {
    assert.notEqual(text, PUBLIC_TEXT, `${term}: the fixture really changed`);
    assert.deepEqual(releasedFor(pub, load(withMove(text), "ops")), { released: false, reapproval: true }, `${term} change must read as reapproval required`);
  }
});

test("W1-T14408 criterion 3: without a moved_from line the pin is exactly origin/main's (pinned digest, every term still pinned)", () => {
  const record = { id: "W1-T7", title: "t", repo: "remudero", type: "implement", priority: 1, status: "queued", verify: "human",
    files: ["a.ts"], acceptance: [{ claim: "c", proof: "grep: x in a.ts" }], design: "d" };
  assert.equal(pinOf(record), "a68948e322ed1f850d17184e7e2018b088bfde802c2c4a27691a4bfa04ac129a");
  for (const [key, value] of [["title", "u"], ["files", ["b.ts"]], ["priority", 2], ["status", "blocked"], ["repo", "other"], ["design", "e"]] as const) {
    assert.notEqual(pinOf({ ...record, [key]: value }), pinOf(record), `${key} stays pinned`);
  }
  assert.notEqual(pinOf({ ...record, moved_from: "x" }), "", "a record with the line still pins");
});
