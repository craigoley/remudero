import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  buildBundle,
  computePolicyProposalsHash,
  extractPolicyProposalRows,
  renderBundle,
  verifyBundlePolicyProposalsPin,
  type BundleProvenance,
} from "../src/lib/bundle.js";
import { loadProposalRegistry, stageBundleProposals } from "../src/lib/inbox.js";
import { verifyBundlePin, type LearningEntry } from "../src/lib/learnings.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { bundleCommand, bundleExportCommand, bundleImportCommand } from "../src/run-task.js";

// W1-T2702 — A BUNDLE CARRIES WHAT THE FLEET KNOWS AND NOT HOW IT IS ALLOWED TO ACT. W1-T2580's
// bundle carried doctrine + learnings and left every ratified plan/policy.yaml row behind, so a
// second repo onboarded with default operating limits nobody chose. These tests exercise this
// task's own three acceptance claims:
//   (1) export carries every LABELLED row as a proposal with its rationale + provenance, and no
//       UNLABELLED row ever appears.
//   (2) import (stageBundleProposals) stages one inbox proposal per row, writes nothing to the
//       policy file, and a re-import stages nothing twice.
//   (3) an edited policy_proposals section fails the bundle pin.
// Plus the acceptance's grep proof: `stageBundleProposals(` really is defined in src/lib/inbox.ts
// (exercised directly below, not merely grepped for).

function tmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}${prefix}`));
}

function entry(over: Partial<LearningEntry> = {}): LearningEntry {
  return {
    id: "fleet-fact",
    subsystem: "knowledge",
    lifecycle: "active",
    files: [],
    fact: "One entry shape is valid at every knowledge layer.",
    src: "W1-T2702-provenance-tag",
    ...over,
  };
}

const provenance: BundleProvenance = {
  sourceRepo: "craigoley/remudero",
  sourceSha: "cafef00d",
  exportedAt: "2026-09-02T00:00:00.000Z",
};

function validSettings(): Record<string, unknown> {
  return {
    permissions: { deny: [], allow: [], ask: [] },
    hooks: {},
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      network: { allowedDomains: ["github.com", "api.github.com"] },
    },
  };
}

/** A small `plan/policy.yaml`-shaped fixture exercising every case {@link extractPolicyProposalRows}
 *  must tell apart: a top-level net-new row with a two-line rationale comment directly above it
 *  (separated from an unrelated file-header paragraph by a REAL blank line); a top-level lifted
 *  row (excluded by default); a top-level row with NO `origin` at all (never a candidate, by
 *  construction); a nested block-style net-new row with its own one-line rationale; a nested
 *  FLOW-style net-new row with no comment above it (rationale ""); and a lifted row that only
 *  {@link extractPolicyProposalRows}'s `ratifiedPaths` option (the W1-T2694 seam) pulls in. */
const FIXTURE_POLICY_YAML = `# File header paragraph, line one.
# File header paragraph, line two.

# Rationale for topLevelNetNew.
# Second line of rationale.
topLevelNetNew:
  value: 42
  origin: "net-new"
  min: 0
  max: 100

topLevelLifted:
  value: 7
  origin: "lifted:src/example.ts:1 (EXAMPLE)"
  min: 0
  max: 100

topLevelNoOrigin:
  value: 9

ratifiedButLifted:
  value: 1
  origin: "lifted:src/other.ts:2 (OTHER)"
  min: 0
  max: 5

nested:
  # Rationale for nested.child.
  child:
    value: 3
    origin: "net-new"
    min: 1
    max: 10
  flowChild: { value: 5, origin: "net-new", min: 1, max: 20 }
`;

// ── (1) EXPORT: every LABELLED row, its rationale + provenance verbatim, no UNLABELLED row ────

test("W1-T2702: extractPolicyProposalRows exports every net-new row with its rationale and origin verbatim, and excludes lifted/unlabelled rows", () => {
  const result = extractPolicyProposalRows(FIXTURE_POLICY_YAML);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const paths = result.rows.map((r) => r.path).sort();
  assert.deepEqual(paths, ["nested.child", "nested.flowChild", "topLevelNetNew"]);

  const top = result.rows.find((r) => r.path === "topLevelNetNew");
  assert.ok(top);
  assert.equal(top!.origin, "net-new");
  assert.equal(top!.value, 42);
  assert.deepEqual(top!.bounds, { min: 0, max: 100 });
  assert.equal(top!.rationale, "Rationale for topLevelNetNew.\nSecond line of rationale.");
  // The file-header paragraph, two blank lines further up, must never bleed into this row's
  // rationale — proves the blank-line stop rule, not merely "some text got attached".
  assert.doesNotMatch(top!.rationale, /File header paragraph/);

  const nestedChild = result.rows.find((r) => r.path === "nested.child");
  assert.equal(nestedChild!.rationale, "Rationale for nested.child.");
  assert.deepEqual(nestedChild!.bounds, { min: 1, max: 10 });

  const flowChild = result.rows.find((r) => r.path === "nested.flowChild");
  assert.equal(flowChild!.rationale, "", "a row with no comment directly above it carries an empty rationale, never a guess");
  assert.equal(flowChild!.value, 5);

  // Every row carries a deterministic per-row hash — recomputing it from the row's own fields
  // must reproduce it exactly (dedup's own falsifier, exercised again in the stage tests below).
  for (const row of result.rows) {
    assert.equal(row.rowHash.length, 64, "sha256 hex digest");
  }
});

test("W1-T2702: extractPolicyProposalRows includes a lifted row ONLY when ratifiedPaths (the W1-T2694 seam) names it", () => {
  const withoutRatification = extractPolicyProposalRows(FIXTURE_POLICY_YAML);
  assert.equal(withoutRatification.ok, true);
  if (!withoutRatification.ok) return;
  assert.ok(!withoutRatification.rows.some((r) => r.path === "ratifiedButLifted"));

  const withRatification = extractPolicyProposalRows(FIXTURE_POLICY_YAML, {
    ratifiedPaths: new Set(["ratifiedButLifted"]),
  });
  assert.equal(withRatification.ok, true);
  if (!withRatification.ok) return;
  const row = withRatification.rows.find((r) => r.path === "ratifiedButLifted");
  assert.ok(row, "ratifiedPaths must pull in a lifted row it names");
  assert.equal(row!.origin, "lifted:src/other.ts:2 (OTHER)", "origin carried verbatim even when the ratification seam is what admits the row");
});

test("W1-T2702: extractPolicyProposalRows refuses (never a silent empty export) on unparseable policy YAML", () => {
  const result = extractPolicyProposalRows("not: [valid: yaml: at: all");
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /not valid YAML/);
});

test("W1-T2702: buildBundle carries policy_proposals + policyProposalsHash from opts.policyYamlText, and stays [] when omitted (W1-T2580 callers unaffected)", () => {
  const entries = [entry({ id: "policy-fact" })];

  const withoutPolicy = buildBundle(entries, validSettings(), provenance);
  assert.equal(withoutPolicy.ok, true);
  if (!withoutPolicy.ok) return;
  assert.deepEqual(withoutPolicy.bundle.policy_proposals, []);
  assert.equal(withoutPolicy.bundle.policyProposalsHash, computePolicyProposalsHash([]));

  const withPolicy = buildBundle(entries, validSettings(), provenance, { policyYamlText: FIXTURE_POLICY_YAML });
  assert.equal(withPolicy.ok, true);
  if (!withPolicy.ok) return;
  assert.equal(withPolicy.bundle.policy_proposals.length, 3);
  // `Bundle.hash` (the pin `verifyBundlePin`/loadGlobalArtifact check) is computed over `entries`
  // ALONE — adding policy_proposals must never move it, or the shipped `rmd learnings import`
  // round-trip (W1-T2580) would break the moment a caller starts passing policyYamlText.
  assert.equal(withPolicy.bundle.hash, withoutPolicy.bundle.hash);
});

// ── (2) IMPORT: one proposal per row, nothing written to the policy file, re-import is inert ──

test("W1-T2702: stageBundleProposals writes one Proposal per row carrying source provenance, and never touches the policy file", () => {
  const extracted = extractPolicyProposalRows(FIXTURE_POLICY_YAML);
  assert.equal(extracted.ok, true);
  if (!extracted.ok) return;

  const stateDir = tmpDir("bundle-stage-state-");
  const registryPath = join(stateDir, "inbox-proposals.json");
  const planDir = tmpDir("bundle-stage-plan-");
  const policyFilePath = join(planDir, "policy.yaml");
  writeFileSync(policyFilePath, FIXTURE_POLICY_YAML, "utf8");
  const before = readFileSync(policyFilePath, "utf8");

  const result = stageBundleProposals(registryPath, extracted.rows, {
    sourceRepo: "acme/upstream",
    sourceSha: "abc123",
    pin: "deadpin",
  });
  assert.equal(result.staged.length, 3);
  assert.equal(result.alreadyStaged.length, 0);

  // NEVER touches plan/policy.yaml — stageBundleProposals was never even handed this path, and
  // the file on disk proves it byte-for-byte.
  assert.equal(readFileSync(policyFilePath, "utf8"), before);

  const registered = loadProposalRegistry(registryPath);
  assert.equal(registered.length, 3);
  for (const row of extracted.rows) {
    const proposal = registered.find((p) => p.id === `bundle-policy:${row.rowHash.slice(0, 16)}`);
    assert.ok(proposal, `row '${row.path}' must have staged a proposal`);
    assert.equal(proposal!.source?.kind, "bundle");
    assert.equal(proposal!.source?.sourceRepo, "acme/upstream");
    assert.equal(proposal!.source?.sourceSha, "abc123");
    assert.equal(proposal!.source?.pin, "deadpin");
    assert.equal(proposal!.source?.rowHash, row.rowHash);
    assert.deepEqual(proposal!.evidenceAnchors, []);
    assert.match(proposal!.summary, new RegExp(row.path.replace(/\./g, "\\.")));
  }
});

test("W1-T2702: a re-import of the SAME rows stages nothing twice — dedup by row hash, not by call count", () => {
  const extracted = extractPolicyProposalRows(FIXTURE_POLICY_YAML);
  assert.equal(extracted.ok, true);
  if (!extracted.ok) return;

  const stateDir = tmpDir("bundle-restage-state-");
  const registryPath = join(stateDir, "inbox-proposals.json");
  const source = { sourceRepo: "acme/upstream", sourceSha: "abc123", pin: "deadpin" };

  const first = stageBundleProposals(registryPath, extracted.rows, source);
  assert.equal(first.staged.length, 3);

  const second = stageBundleProposals(registryPath, extracted.rows, source);
  assert.equal(second.staged.length, 0, "an unedited re-import must mint nothing new");
  assert.equal(second.alreadyStaged.length, 3);

  const registered = loadProposalRegistry(registryPath);
  assert.equal(registered.length, 3, "the registry must not carry duplicates after a re-import");
});

test("W1-T2702: a row whose value changed since the last import hashes differently and mints a NEW proposal, never overwriting the old one", () => {
  const stateDir = tmpDir("bundle-edited-row-state-");
  const registryPath = join(stateDir, "inbox-proposals.json");
  const source = { sourceRepo: "acme/upstream", sourceSha: "abc123", pin: "deadpin" };

  const before = extractPolicyProposalRows(FIXTURE_POLICY_YAML);
  assert.equal(before.ok, true);
  if (!before.ok) return;
  stageBundleProposals(registryPath, before.rows, source);

  const editedYaml = FIXTURE_POLICY_YAML.replace("value: 42", "value: 43");
  const after = extractPolicyProposalRows(editedYaml);
  assert.equal(after.ok, true);
  if (!after.ok) return;
  const changedRow = after.rows.find((r) => r.path === "topLevelNetNew")!;
  const originalRow = before.rows.find((r) => r.path === "topLevelNetNew")!;
  assert.notEqual(changedRow.rowHash, originalRow.rowHash);

  const result = stageBundleProposals(registryPath, after.rows, source);
  assert.equal(result.staged.length, 1, "only the changed row mints a new proposal");
  assert.equal(result.alreadyStaged.length, 2, "the two unchanged rows stay deduped");

  const registered = loadProposalRegistry(registryPath);
  assert.equal(registered.length, 4, "the OLD topLevelNetNew proposal is left in place, never silently retired");
});

// ── (3) THE PIN: an edited policy_proposals section fails it ──────────────────────────────────

test("W1-T2702: verifyBundlePolicyProposalsPin passes on an unedited bundle and fails after policy_proposals is edited post-export, independently of the entries pin", () => {
  const result = buildBundle([entry({ id: "pin-fact" })], validSettings(), provenance, { policyYamlText: FIXTURE_POLICY_YAML });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const text = renderBundle(result.bundle);

  const clean = verifyBundlePolicyProposalsPin(text);
  assert.equal(clean.ok, true);
  if (!clean.ok) return;
  assert.equal(clean.rows.length, 3);

  // Tamper with policy_proposals ONLY, via a real re-parse/mutate/re-stringify (never brittle
  // string surgery) — this is exactly "the policy section was edited after export".
  const parsed = parseYaml(text) as { policy_proposals: Array<{ path: string; value: unknown }> };
  const target = parsed.policy_proposals.find((r) => r.path === "topLevelNetNew")!;
  target.value = 999;
  const tamperedText = stringifyYaml(parsed);

  const tampered = verifyBundlePolicyProposalsPin(tamperedText);
  assert.equal(tampered.ok, false);
  if (tampered.ok) return;
  assert.match(tampered.reason, /hash mismatch/);

  // The entries pin (verifyBundlePin, learnings.ts) is a SEPARATE check over a SEPARATE section
  // — it must still pass, proving policy_proposals needed its OWN independent pin rather than
  // riding the one that already existed.
  const entriesPin = verifyBundlePin(tamperedText, result.bundle.hash);
  assert.equal(entriesPin.ok, true, "entries pin is untouched by a policy_proposals-only edit");
});

// ── END TO END: `rmd bundle import` stages proposals and refuses a tampered proposals section ─

function setupHome(root: string): string {
  const home = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}bundle-import-home-`));
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root }));
  return home;
}

function withHome(home: string, fn: () => void): void {
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    fn();
  } finally {
    process.env.HOME = oldHome;
  }
}

test("W1-T2702: rmd bundle import stages every net-new policy proposal into the inbox, writing nothing to plan/policy.yaml", () => {
  const projectDir = tmpDir("bundle-import-project-");
  writeFileSync(join(projectDir, "shard.yaml"), JSON.stringify([entry({ id: "import-e2e-fact" })]));
  const settingsDir = tmpDir("bundle-import-settings-");
  const settingsPath = join(settingsDir, "worker.json");
  writeFileSync(settingsPath, JSON.stringify(validSettings()));
  const policyDir = tmpDir("bundle-import-policy-");
  const policyPath = join(policyDir, "policy.yaml");
  writeFileSync(policyPath, FIXTURE_POLICY_YAML, "utf8");
  const outDir = tmpDir("bundle-import-out-");
  const out = join(outDir, "bundle.yaml");

  const exportCode = bundleExportCommand([out], { projectDir, settingsPath, policyPath, now: () => provenance.exportedAt });
  assert.equal(exportCode, 0);
  const bundleText = readFileSync(out, "utf8");
  const pin = bundleText.match(/^hash:\s*(\S+)/m)![1];

  const root = tmpDir("bundle-import-root-");
  const home = setupHome(root);
  const registryPath = join(tmpDir("bundle-import-registry-"), "inbox-proposals.json");
  withHome(home, () => {
    const code = bundleImportCommand([out, "--pin", pin], { registryPath });
    assert.equal(code, 0);
  });

  const registered = loadProposalRegistry(registryPath);
  assert.equal(registered.length, 3, "one proposal per exportable row");
  assert.ok(registered.every((p) => p.source?.kind === "bundle"));

  // `rmd bundle import` never even takes a policy-file path — nothing in this flow can write
  // plan/policy.yaml. The fixture file itself is proof by construction: unchanged on disk.
  assert.equal(readFileSync(policyPath, "utf8"), FIXTURE_POLICY_YAML);
});

test("W1-T2702: rmd bundle import refuses (stages nothing) when policy_proposals was edited after export, even though the entries pin still matches", () => {
  const projectDir = tmpDir("bundle-tamper-project-");
  writeFileSync(join(projectDir, "shard.yaml"), JSON.stringify([entry({ id: "tamper-e2e-fact" })]));
  const settingsDir = tmpDir("bundle-tamper-settings-");
  const settingsPath = join(settingsDir, "worker.json");
  writeFileSync(settingsPath, JSON.stringify(validSettings()));
  const policyDir = tmpDir("bundle-tamper-policy-");
  const policyPath = join(policyDir, "policy.yaml");
  writeFileSync(policyPath, FIXTURE_POLICY_YAML, "utf8");
  const outDir = tmpDir("bundle-tamper-out-");
  const out = join(outDir, "bundle.yaml");

  assert.equal(bundleExportCommand([out], { projectDir, settingsPath, policyPath, now: () => provenance.exportedAt }), 0);
  const bundleText = readFileSync(out, "utf8");
  const pin = bundleText.match(/^hash:\s*(\S+)/m)![1];

  const parsed = parseYaml(bundleText) as { policy_proposals: Array<{ value: unknown }> };
  parsed.policy_proposals[0].value = "tampered";
  writeFileSync(out, stringifyYaml(parsed), "utf8");

  const root = tmpDir("bundle-tamper-root-");
  const home = setupHome(root);
  const registryPath = join(tmpDir("bundle-tamper-registry-"), "inbox-proposals.json");
  withHome(home, () => {
    const code = bundleImportCommand([out, "--pin", pin], { registryPath });
    assert.equal(code, 1, "a tampered policy_proposals section must refuse the import");
  });

  assert.throws(() => readFileSync(registryPath, "utf8"), "nothing was ever staged from a refused import");
});

// ── CLI ROUTING ─────────────────────────────────────────────────────────────────────────────

test("W1-T2702: bundleCommand routes 'import' to bundleImportCommand", () => {
  // No <file> given -> the subcommand's own usage refusal (code 2), proving the dispatcher
  // actually reached bundleImportCommand rather than falling through to the unknown-subcommand line.
  assert.equal(bundleCommand(["import"]), 2);
});

test("W1-T2702: bundleImportCommand requires --pin", () => {
  assert.equal(bundleImportCommand(["some-file.yaml"]), 2);
});

// ── W1-T2702: the refusal arms, which a well-formed fixture never reaches ────────────────────────

/*
 * diff-coverage flagged bundle.ts:312/315/320-322/430 — every one an early return for a bundle that
 * is malformed rather than merely empty. The existing suite supplies well-formed YAML throughout,
 * which is the shape CLAUDE.md names: when every test hands in a good input, the refusal arms are
 * unreachable and the gate that would have caught a broken message never runs. Each case below
 * drives one arm and asserts the REASON, because a refusal whose text is wrong is as bad as none —
 * the caller stages nothing and the operator is told why.
 */

test("W1-T2702: a bundle that is not valid YAML is refused, naming the parse failure", () => {
  const out = verifyBundlePolicyProposalsPin(":\n  - [unclosed\n");
  assert.equal(out.ok, false);
  assert.match(out.reason ?? "", /not valid YAML/);
});

test("W1-T2702: a bundle that parses to a non-mapping is refused rather than treated as empty", () => {
  // Both shapes a YAML document can take that are NOT a mapping — a scalar and a sequence. An empty
  // proposals section and "this is not a bundle at all" must not arrive as the same answer.
  for (const text of ["just a string\n", "- one\n- two\n"]) {
    const out = verifyBundlePolicyProposalsPin(text);
    assert.equal(out.ok, false, `${JSON.stringify(text)} must be refused`);
    assert.match(out.reason ?? "", /must be a mapping/);
    assert.match(out.reason ?? "", /not staged/, "the refusal must say the proposals were not staged");
  }
});

test("W1-T2702: a bundle missing its proposals hash is refused — an unverifiable section is not a passing one", () => {
  for (const text of ["policy_proposals: []\n", 'policy_proposals: []\npolicyProposalsHash: ""\n']) {
    const out = verifyBundlePolicyProposalsPin(text);
    assert.equal(out.ok, false, `${JSON.stringify(text)} must be refused`);
    assert.match(out.reason ?? "", /policyProposalsHash/);
    assert.match(out.reason ?? "", /cannot verify/);
  }
});

test("W1-T2702: buildBundle aborts when the policy text it was handed cannot be extracted", () => {
  // The abort path at the caller: extractPolicyProposalRows refuses, and buildBundle must surface
  // that reason rather than shipping a bundle with a silently empty proposals section. It refuses
  // only on a YAML PARSE failure — a well-formed document that is merely the wrong SHAPE extracts
  // zero rows and succeeds, which is why this fixture is unparseable rather than just not a mapping.
  const out = buildBundle([entry({ id: "policy-fact" })], validSettings(), provenance, {
    policyYamlText: "sweep:\n  - [unclosed\n",
  });
  assert.equal(out.ok, false);
  assert.match(out.reason ?? "", /bundle aborted/);
});
