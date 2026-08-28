import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  auditProducerCompleteness,
  declaredViewFields,
  producerAssignedKeys,
  KNOWN_UNWIRED,
} from "../src/lib/producer-completeness.js";

/**
 * recon-DW found NINE optional `OpenPrView` fields that no producer assigns, each with live
 * consumers branching on the resulting `undefined`. #1082 wired one of them. This is the standing
 * check that stops a tenth from shipping silently.
 */

const REPO = join(import.meta.dirname, "..");

/** A synthetic tree, so the checker's own behaviour is testable without touching the real one. */
function fixtureTree(iface: string, producer: string): { srcRoot: string; interfaceFile: string } {
  const dir = mkdtempSync(join(tmpdir(), "rmd-prodcomp-"));
  const srcRoot = join(dir, "src");
  mkdirSync(join(srcRoot, "lib"), { recursive: true });
  const interfaceFile = join(srcRoot, "lib", "view.ts");
  writeFileSync(interfaceFile, iface);
  writeFileSync(join(srcRoot, "producer.ts"), producer);
  return { srcRoot, interfaceFile };
}

const IFACE = `export interface DemoView {
  id: number;
  name: string;
  wired?: string;
  orphan?: string;
}
`;
const PRODUCER = `export function build(): DemoView {
  return {
    id: 1,
    name: "n",
    wired: "yes",
  };
}
`;

test("a field with no producer and no allowlist entry FAILS the audit", () => {
  const { srcRoot, interfaceFile } = fixtureTree(IFACE, PRODUCER);
  const r = auditProducerCompleteness({ srcRoot, interfaceFile, interfaceName: "DemoView", allowlist: {} });
  assert.deepEqual(
    r.unwired.map((f) => f.name),
    ["orphan"],
    "an optional field nothing writes is reported",
  );
  assert.equal(r.unwired[0].line, 5, "the declaration line is reported so the failure is clickable");
  assert.deepEqual(r.staleAllowlist, []);
});

test("a field that HAS a producer but is still allowlisted FAILS — the stale-entry lock", () => {
  // Without this, the allowlist rots into a lie: a field gets wired, the entry stays, and the next
  // reader believes something is pending that is in fact done.
  const { srcRoot, interfaceFile } = fixtureTree(IFACE, PRODUCER);
  const r = auditProducerCompleteness({
    srcRoot,
    interfaceFile,
    interfaceName: "DemoView",
    allowlist: { wired: "stale — this field acquired a producer", orphan: "genuinely pending" },
  });
  assert.deepEqual(r.staleAllowlist, ["wired"], "the entry for a now-produced field is flagged");
  assert.deepEqual(r.unwired, [], "and the genuinely-pending one is correctly silent");
});

test("an allowlist entry naming a field the interface does not declare FAILS", () => {
  const { srcRoot, interfaceFile } = fixtureTree(IFACE, PRODUCER);
  const r = auditProducerCompleteness({
    srcRoot,
    interfaceFile,
    interfaceName: "DemoView",
    allowlist: { orphan: "pending", ghostField: "renamed away and nobody cleaned up" },
  });
  assert.deepEqual(r.unknownAllowlist, ["ghostField"]);
});

test("a field assigned ONLY in a test fixture is still reported unwired — test files are OUT of scope", () => {
  // THE POLICY, stated in the name. recon-DW measured the merge fields assigned 5/7/2 times in
  // `test/` and ZERO times in `src/`; impl-DX's falsifier initially caught only one test because
  // three others hand-assigned the field. A checker that counted fixtures as producers could not
  // detect its own defect class.
  const dir = mkdtempSync(join(tmpdir(), "rmd-prodcomp-t-"));
  const srcRoot = join(dir, "src");
  mkdirSync(join(srcRoot, "lib"), { recursive: true });
  const interfaceFile = join(srcRoot, "lib", "view.ts");
  writeFileSync(interfaceFile, IFACE);
  writeFileSync(join(srcRoot, "producer.ts"), PRODUCER);
  // A test fixture that hand-assigns `orphan` — deliberately placed OUTSIDE srcRoot.
  mkdirSync(join(dir, "test"), { recursive: true });
  writeFileSync(join(dir, "test", "fx.test.ts"), `const v = { id: 1, name: "n", wired: "y", orphan: "hand-set" };\n`);

  const r = auditProducerCompleteness({ srcRoot, interfaceFile, interfaceName: "DemoView", allowlist: {} });
  assert.deepEqual(r.unwired.map((f) => f.name), ["orphan"], "a fixture assignment is not a producer");
});

test("the producer anchor selects only literals that satisfy EVERY required field", () => {
  const src = `
const notAProducer = { id: 5, unrelated: true };
const alsoNot = { id: 9, name: "x" , extra: 1};
function real(): DemoView { return { id: 1, name: "n", wired: "w" }; }
`;
  const scan = producerAssignedKeys(src, ["id", "name", "wired"]);
  assert.equal(scan.literals.length, 1, "only the literal assigning all three required keys counts");
  assert.ok(scan.keys.has("wired"));
  assert.equal(scan.keys.has("unrelated"), false, "keys from a non-producer literal never leak in");
});

test("an interface declaration is not mistaken for a producer", () => {
  // A REAL false positive found during development: an interface body passes the all-required
  // anchor, because an OPTIONAL member reads `name?: T` while the key pattern requires `name:`.
  const scan = producerAssignedKeys(IFACE, ["id", "name"]);
  assert.deepEqual(scan.literals, [], "a declaration assigns nothing");
});

test("ES6 shorthand counts as an assignment", () => {
  const src = `function f(id: number, name: string, wired: string) { return { id, name, wired }; }`;
  const scan = producerAssignedKeys(src, ["id", "name"]);
  assert.equal(scan.literals.length, 1);
  assert.ok(scan.keys.has("wired"), "`{ wired }` is an assignment, not an omission");
});

test("a spread inside a producer literal is reported as unresolvable rather than silently ignored", () => {
  const src = `function f(): DemoView { return { id: 1, name: "n", ...base }; }`;
  const scan = producerAssignedKeys(src, ["id", "name"]);
  assert.equal(scan.literals.length, 1);
  assert.equal(scan.spreads.length, 1, "the method cannot resolve a spread statically and says so");
  assert.match(scan.spreads[0], /\.\.\.base/);
});

test("OpenPrView's producer completeness holds on the real tree", () => {
  const r = auditProducerCompleteness({
    srcRoot: join(REPO, "src"),
    interfaceFile: join(REPO, "src", "lib", "sweep.ts"),
    interfaceName: "OpenPrView",
  });

  // The anchor must have found the producers at all — an empty set means the anchor broke (a
  // refactor moved or reshaped the literals) and every field would look unwired. Fail loudly on
  // that rather than reporting a flood of false orphans.
  assert.ok(r.producers.length >= 2, `expected >=2 OpenPrView producers, found ${r.producers.length}`);

  assert.deepEqual(
    r.unwired.map((f) => `${f.name} (sweep.ts:${f.line})`),
    [],
    "an OpenPrView field that no producer assigns must be wired or added to KNOWN_UNWIRED with a reason",
  );
  assert.deepEqual(r.staleAllowlist, [], "a KNOWN_UNWIRED entry whose field now HAS a producer must be deleted");
  assert.deepEqual(r.unknownAllowlist, [], "a KNOWN_UNWIRED entry naming no declared field must be deleted");
  assert.deepEqual(r.unresolvableSpreads, [], "a spread in a producer literal would make this audit unsound");
});

test("every KNOWN_UNWIRED entry carries a substantive reason, not a TODO", () => {
  // Was 8 when PR #1083 landed the check; W1-T225's pair (reviewOrphanedByPush,
  // priorReviewOrphans) was wired and REMOVED here, which is the allowlist shrinking as
  // intended. The stale-entry lock is what forces the removal: leaving them would fail.
  // W1-T435 wired pendingAnswer (buildOpenPrViews now assigns it via operatorVerdictEvidence),
  // shrinking the count again, six -> five. W1-T920 added supersessionVerdict — its DETECTOR is a
  // separate, out-of-scope shard (that task's own design note), so the field stays unwired here
  // until that shard lands and wires a producer — five -> six. W1-T984 wired mergeConflict
  // (buildOpenPrViews now assigns it via hydrateMergeConflictEvidence) — six -> five. W1-T2384
  // wired supersessionVerdict, the detector W1-T920 deferred to "a separate shard" and nobody
  // filed for months: buildOpenPrViews now assigns it via hydrateSupersessionVerdicts
  // (lib/open-prs-rest.ts), scoped to PRs the arithmetic already flagged — five -> four. It was
  // WIRED, never allowlisted: this file's own doc forbids the vague entry because "it launders
  // 'nobody has looked at this' into 'this is fine'", and an entry for a detector that can never
  // fire is exactly that.
  // W1-T2424: this is a CEILING, not an equality. The history above is entirely one-directional
  // wiring (six -> five -> four, never a re-add), and an equality refuses BOTH the bad direction
  // (a fifth exemption sneaking in) AND the good one (wiring the fourth away, per #3115's own
  // precedent of shrinking this exact count) -- forcing an edit to this file for a change that is
  // strictly an improvement. A ceiling keeps the guard (growth still fails) and frees the shrink.
  const unwiredCount = Object.keys(KNOWN_UNWIRED).length;
  assert.ok(
    unwiredCount <= 4,
    `KNOWN_UNWIRED has ${unwiredCount} entries, exceeding the ceiling of 4 -- a new exemption must ` +
      "either wire a real producer or justify why the ceiling itself should move",
  );
  for (const [field, reason] of Object.entries(KNOWN_UNWIRED)) {
    assert.ok(reason.length >= 80, `${field}: a one-word reason launders 'nobody looked' into 'this is fine'`);
    assert.doesNotMatch(reason, /^\s*(TODO|FIXME|tbd)\b/i, `${field}: name the reason`);
  }
});

test("declaredViewFields separates required from optional and reports real line numbers", () => {
  const fields = declaredViewFields(IFACE, "DemoView");
  assert.deepEqual(
    fields.map((f) => [f.name, f.optional, f.line]),
    [
      ["id", false, 2],
      ["name", false, 3],
      ["wired", true, 4],
      ["orphan", true, 5],
    ],
  );
});
