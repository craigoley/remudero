/**
 * W1-T14924: a machine shard's preservation invariant passes at the merge base by design, so its drafted acceptance
 * entry carries `kind: guard`; every other criterion, and an invariant not marked as preservation, renders as before.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { parse } from "yaml";
import { ciFrictionShardYaml } from "#src/lib/ci-friction-gardener.js";
import { selectorShadowMissTask, selectorShadowStructuralTask } from "#src/lib/selector-shadow-gardener.js";
import { machineShardInvariantClaims, renderMachineShard, type MachineShardInvariant, type MachineShardSpec } from "#src/lib/machine-filing.js";

const SPEC: MachineShardSpec = {
  taskId: "W1-T999924",
  title: "a fixture remedy keeps its gate",
  origin: "gate-gardener:fixture",
  files: ["src/lib/fixture.ts", "test/fixture.test.ts"],
  acceptance: [{ claim: "the fixture remedy admits the healthy case", proof: "unit test: W1-T999924: the healthy case is admitted" }],
  invariants: { declared: [{ slug: "gate-still-refuses", statement: "the gate still refuses its defect.",
    claim: "the defect is still refused", proof: "unit test: W1-T999924: the defect is still refused", guard: true }] },
};

type Row = { claim: string; proof: string; kind?: string };
const rows = (text: string): Row[] => (parse(text) as { acceptance: Row[] }[])[0]!.acceptance;

test("W1-T14924 criterion 1: a drafted machine shard with a preservation invariant carries kind guard", () => {
  const { text } = renderMachineShard(SPEC);
  assert.deepEqual(rows(text).map((r) => [r.claim, r.kind]), [
    ["the fixture remedy admits the healthy case", undefined],
    ["invariant:gate-still-refuses — the defect is still refused", "guard"],
  ]);
  assert.match(text, /\n {6}proof: "unit test: W1-T999924: the defect is still refused"\n {6}kind: guard\n/);
  // A real gardener's draft: the ci-friction gardener's preservation invariant is marked.
  const price = { cause: { kind: "check" as const, name: "ci-log:ci-shard" }, minutes: 37.5, rounds: 39, prs: 32 };
  const drafted = ciFrictionShardYaml({ price, rung: 1, owner: { files: ["src/lib/dispatch-governor.ts"], why: ["x"] }, rounds: [] },
    "W1-T999924", [price]);
  const invariant = rows(drafted).find((r) => r.claim.startsWith("invariant:"));
  assert.equal(invariant?.kind, "guard", drafted);
  // Both selector-shadow drafts declare the selector-keeps-its-selections preservation invariant; each entry is marked.
  const miss = { runId: 1, headSha: "a".repeat(40), selection: "narrow" as const, file: "test/foo.test.ts" };
  for (const shard of [selectorShadowMissTask(miss, "W1-T999925", ["src/lib/foo.ts"]),
    selectorShadowStructuralTask("test/foo.test.ts", "W1-T999926", ["src/lib/foo.ts -> test/foo.test.ts"], "W1-T999925")]) {
    const kept = rows(shard).find((r) => r.claim.startsWith("invariant:selector-keeps-its-selections"));
    assert.equal(kept?.kind, "guard", shard);
  }
});

test("W1-T14924 criterion 2: a drafted shard's other criteria render as today", () => {
  const { guard: _guard, ...plain } = (SPEC.invariants as { declared: readonly MachineShardInvariant[] }).declared[0]!;
  const unmarked: MachineShardSpec = { ...SPEC, invariants: { declared: [plain] } };
  const { text } = renderMachineShard(unmarked);
  assert.ok(!text.includes("kind:"), `nothing renders a kind:\n${text}`);
  // The acceptance block as the renderer wrote it before W1-T14924: claim and proof lines only.
  const q = JSON.stringify;
  const before = ["  acceptance:", ...[...SPEC.acceptance, ...machineShardInvariantClaims(unmarked.invariants)]
    .flatMap((c) => [`    - claim: ${q(c.claim)}`, `      proof: ${q(c.proof)}`])].join("\n");
  assert.ok(text.includes(`${before}\n`), text);
  assert.deepEqual(machineShardInvariantClaims(unmarked.invariants), [{ claim: "invariant:gate-still-refuses — the defect is still refused",
    proof: "unit test: W1-T999924: the defect is still refused" }], "an unmarked invariant carries no kind field");
  // The marked spec's other criterion renders exactly as in the unmarked one.
  assert.deepEqual(rows(renderMachineShard(SPEC).text)[0], rows(text)[0]);
});
