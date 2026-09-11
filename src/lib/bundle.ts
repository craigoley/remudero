import { createHash } from "node:crypto";
import { isMap, isScalar, LineCounter, parse as parseYaml, parseDocument, stringify as stringifyYaml } from "yaml";
import {
  computeArtifactHash,
  DEFAULT_KNOWLEDGE_BUDGET_CHARS,
  entryBudgetWeight,
  entryLayer,
  LAYERS,
  renderDoctrinePreamble,
  renderMatchedLearnings,
  scrubEntry,
  type LearningEntry,
  type V1BundleLearningEntry,
} from "./learnings.js";
import { buildPromptManifest, type PromptManifestPart } from "./prompt-manifest.js";
import { validateWorkerSettings, WorkerSettingsError } from "./settings.js";

/**
 * `rmd bundle export <path>` — THE MISSING EXPORT HALF (W1-T2580). Acceptance is exercised in
 * test/bundle-export.test.ts: round trip through the shipped importer + `verifyBundlePin`,
 * determinism across two exports of the same tree, provenance surviving the round trip, the
 * committed worker-settings template's deny-paths never surviving into a bundle, and the
 * budget trimming an over-budget corpus instead of dumping it whole. The CLI wiring itself
 * (`bundleCommand`/`bundleExportCommand`, run-task.ts) calls {@link buildBundle} directly —
 * `grep buildBundle( src/run-task.ts` is the sixth acceptance proof.
 *
 * THE RULING CREATES THE CONSUMER (W1-T992): bring-your-own-subscription puts each customer on
 * their own VM improving their OWN repos. Every such VM boots a remudero that knows NOTHING,
 * while this fleet's own operational knowledge layer holds provenance-tagged, lifecycle-managed
 * learnings under a CI-budgeted injection weight ({@link DEFAULT_KNOWLEDGE_BUDGET_CHARS},
 * selected by {@link selectLearnings} into every implement prompt). `rmd learnings import`
 * (run-task.ts, W1-T425) already consumes a hash-pinned bundle and {@link
 * verifyBundlePin}/`loadGlobalArtifact` (learnings.ts) already verify one — but until this module
 * nothing could PRODUCE the artifact those two were built to receive. This is that producer.
 *
 * NOT THE §6 COMMONS TRANSPORT, REFUSED BY NAME: W1-T425's `rmd learnings export` moves ONLY
 * per-entry `share: public` opted-in facts between STRANGERS (cross-user, cross-instance,
 * field-level consent). This module moves this SAME fleet's own operational corpus — doctrine,
 * budgeted learnings with FULL provenance intact, and the worker-settings template's asserted
 * conventions — to a NEW VM of the SAME operator's fleet, as a local file the operator carries by
 * hand. It reuses W1-T425's machinery ({@link computeArtifactHash}, `verifyBundlePin`,
 * `loadGlobalArtifact`, {@link scrubEntry}) rather than inventing a second hash/pin scheme, but it
 * is a DIFFERENT verb over a DIFFERENT corpus — building this does not unbank the transport.
 *
 * SHAPE: a {@link Bundle} is the exact `GlobalArtifact` shape (`version`/`hash`/`entries`)
 * `loadGlobalArtifact` already parses and hash-verifies, plus `doctrine`/`workerSettings`/
 * `manifest`/`provenance` fields that loader ignores (unknown top-level keys pass through
 * untouched) — so a bundle this module writes round-trips through the SHIPPED, UNCHANGED `rmd
 * learnings import <file> --pin <hash>` command with zero changes to it, and the SAME
 * `--pin <hash>` the exporter prints is the hash the importer must supply — one primitive, two
 * verbs.
 *
 * DETERMINISM: {@link buildBundle} is a PURE function of its arguments — no clock, no random id
 * read internally. The SAME `entries`/`workerSettingsRaw`/`provenance` in produces the
 * byte-identical {@link renderBundle} text out, every time; the CLI wrapper (run-task.ts's
 * `bundleExportCommand`) is the only place a real wall-clock timestamp is read, exactly mirroring
 * how `learningsExportCommand` supplies `exportedAt` to the equally-pure `buildExportBundle`.
 *
 * WHAT NEVER GOES IN: {@link buildBundle} touches exactly three sources — the already-loaded
 * `entries` (repo-scoped facts, no tokens/ledger/state ever recorded in a `LearningEntry`), the
 * two fixed doctrine strings, and {@link extractAssertedWorkerSettingsValues}'s narrow read of
 * the worker-settings template (four asserted fields — sandbox on/off flags and the network
 * allowlist — never the template's raw deny-paths or `$comment` prose, which name `state/`,
 * `.ssh`, `.aws` paths as things to DENY, not to ship). Every selected entry additionally runs
 * through {@link scrubEntry} (the SAME leak-grep/PII tripwire {@link buildExportBundle} already
 * gates on) as an independent floor — a hit refuses the WHOLE bundle, naming the entry, rather
 * than silently dropping it or shipping it anyway.
 */

/** Provenance stamped onto a bundle: where it came from and when — informational, never hashed (only `entries` is; see {@link computeArtifactHash}). */
export interface BundleProvenance {
  /** e.g. `owner/repo` of the exporting checkout. */
  sourceRepo: string;
  /** The exporting checkout's HEAD sha at export time. */
  sourceSha: string;
  /** ISO timestamp of the export. */
  exportedAt: string;
}

/**
 * The worker-settings template's ASSERTED values (never the raw template file): the sandbox
 * on/off flags `validateWorkerSettings` (src/lib/settings.ts) requires to be `true`, plus the
 * pinned network egress allowlist it checks every domain against. This is deliberately a NARROW
 * projection, not the whole `settings/worker.json` — the template's `permissions.deny`/
 * `sandbox.filesystem.denyRead`/`$comment` fields name `state/`, `.ssh`, `.aws` PATHS (things to
 * deny, not to ship) and would fail this task's own "no state path in a bundle" bar if copied in
 * verbatim.
 */
export interface WorkerSettingsAssertedValues {
  sandboxEnabled: boolean;
  sandboxFailIfUnavailable: boolean;
  sandboxAutoAllowBashIfSandboxed: boolean;
  allowedNetworkDomains: string[];
}

/**
 * Validate `rawSettings` against the SAME guard every real worker spawn runs
 * ({@link validateWorkerSettings}) — a template that fails this guard is never bundled, since it
 * would teach a fresh deployment a containment posture this fleet itself refuses to run — then
 * project out ONLY the four asserted fields, never the raw object.
 */
export function extractAssertedWorkerSettingsValues(rawSettings: unknown): WorkerSettingsAssertedValues {
  validateWorkerSettings(rawSettings);
  const settings = rawSettings as { sandbox?: Record<string, unknown> };
  const sandbox = settings.sandbox ?? {};
  const network = (sandbox.network as Record<string, unknown> | undefined) ?? {};
  const allowedDomains = Array.isArray(network.allowedDomains)
    ? network.allowedDomains.filter((d): d is string => typeof d === "string")
    : [];
  return {
    sandboxEnabled: sandbox.enabled === true,
    sandboxFailIfUnavailable: sandbox.failIfUnavailable === true,
    sandboxAutoAllowBashIfSandboxed: sandbox.autoAllowBashIfSandboxed === true,
    allowedNetworkDomains: allowedDomains,
  };
}

// ── POLICY PROPOSALS (W1-T2702) ─────────────────────────────────────────────────────────────
//
// A BUNDLE CARRIED WHAT THE FLEET KNOWS AND NOT HOW IT IS ALLOWED TO ACT: everything above this
// section is doctrine/learnings/worker-settings — a second repo's MEMORY. `plan/policy.yaml` —
// the cadences, ceilings and floors an operator RATIFIED one row at a time — never rode along, so
// a fresh deployment inherited default limits nobody chose for it. This section exports the
// OPERATOR-RATIFIED subset (today: every row whose `origin:` is literally `"net-new"`; a row
// carrying a W1-T2694 ratification pin joins it once that machinery exists — `ratifiedPaths` is
// the seam, read only when a caller supplies it, never guessed at here) as PROPOSALS, never as a
// second copy of `plan/policy.yaml` — `stageBundleProposals` (inbox.ts) is the only place a
// receiving repo's operator can turn one into a committed value, via the SAME `rmd approve` path
// every other proposal takes. Rule 15/Law 5, by construction: this module writes nothing to any
// policy file, ever.

/** One `plan/policy.yaml` row, carried verbatim (§ this section's header). `path` is the SAME
 *  dotted vocabulary `src/lib/policy.ts`'s `EXPECTED_ORIGIN_KIND` keys on (`"sweep.staleDays"`,
 *  never `"sweep/staleDays"`) — re-derived here from the YAML's own nesting, not imported, since
 *  this module never depends on policy.ts's schema (a malformed/unrecognized policy.yaml is not
 *  this module's failure to catch; {@link extractPolicyProposalRows} reads structurally, never
 *  validates business rules). `rationale` is the contiguous `#`-comment block immediately above
 *  the row's own key line — the file's own reasoning for the value, never re-authored here. */
export interface PolicyProposalRow {
  path: string;
  /** The row's own `origin:` string, verbatim — `"net-new"` or `"lifted:<src-site>"`. */
  origin: string;
  value: unknown;
  bounds?: { min: number; max: number };
  rationale: string;
  /** sha256 of `{path, origin, value, bounds, rationale}` — {@link stageBundleProposals}'s
   *  (inbox.ts) dedup key: a re-import of an UNCHANGED row mints nothing twice. */
  rowHash: string;
}

/** Canonical (key-order-independent) projection of a row hashed by both {@link
 *  computePolicyProposalRowHash} and {@link computePolicyProposalsHash} — `undefined` optionals
 *  normalize to `null` so an omitted field hashes alike whichever path built it, mirroring {@link
 *  computeArtifactHash}'s own discipline. */
function canonicalizePolicyProposalRow(
  row: Omit<PolicyProposalRow, "rowHash">,
): { path: string; origin: string; value: unknown; bounds: { min: number; max: number } | null; rationale: string } {
  return {
    path: row.path,
    origin: row.origin,
    value: row.value === undefined ? null : row.value,
    bounds: row.bounds ?? null,
    rationale: row.rationale,
  };
}

/** Deterministic sha256 of one row — see {@link PolicyProposalRow.rowHash}. */
export function computePolicyProposalRowHash(row: Omit<PolicyProposalRow, "rowHash">): string {
  return createHash("sha256").update(JSON.stringify(canonicalizePolicyProposalRow(row))).digest("hex");
}

/** Deterministic sha256 over the WHOLE `policy_proposals` array (sorted by `path`, so row order
 *  never moves the hash) — the pin {@link verifyBundlePolicyProposalsPin} recomputes at import
 *  time. THIS is what makes design point (iii) true: `Bundle.hash` above stays EXACTLY {@link
 *  computeArtifactHash} over `entries` alone (never touched — the shipped `rmd learnings import`
 *  round-trip, W1-T2580, depends on that), so the proposals section needs its OWN independent
 *  pin rather than folding into the one `verifyBundlePin` (learnings.ts) already checks. */
export function computePolicyProposalsHash(rows: PolicyProposalRow[]): string {
  const canonical = [...rows]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((r) => ({ ...canonicalizePolicyProposalRow(r), rowHash: r.rowHash }));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/** Walk upward from `keyLine` (1-indexed, as `yaml`'s `LineCounter` reports it) collecting the
 *  contiguous `#`-comment block immediately above it, stopping at the first line that is neither
 *  a comment nor blank. NEVER crosses a genuinely blank line (no `#` at all) — this is what keeps
 *  `plan/policy.yaml`'s own file-header boilerplate from bleeding into its FIRST field's
 *  rationale: a real blank line separates the header's last paragraph from `proofTimeoutMs`'s own
 *  dedicated comment block, verified against the committed file. A comment-only blank line (bare
 *  `#`) is not a stop condition — it is still part of the same paragraph. */
function extractRowRationale(lines: string[], keyLine: number): string {
  const collected: string[] = [];
  for (let i = keyLine - 2; i >= 0; i--) {
    const line = lines[i] ?? "";
    if (line.trim().length === 0) break;
    const m = /^\s*#(.*)$/.exec(line);
    if (!m) break;
    const text = m[1].startsWith(" ") ? m[1].slice(1) : m[1];
    collected.push(text);
  }
  collected.reverse();
  return collected.join("\n").trim();
}

/** One raw candidate row, before the net-new/ratified filter — {@link collectRawPolicyRows}'s
 *  output. */
interface RawPolicyRow {
  path: string;
  /** 1-indexed line of the row's own key, per `yaml`'s `LineCounter`. */
  keyLine: number;
  origin: unknown;
  value: unknown;
  bounds?: { min: number; max: number };
}

/** Walk `doc`'s mapping tree collecting every "row" — a nested mapping carrying BOTH a `value`
 *  and an `origin` key, exactly the `{value, origin, min?, max?}` shape every `plan/policy.yaml`
 *  leaf field uses (`src/lib/policy.ts`'s `numberField`/`booleanField`/`validateHeadroomCurve`) —
 *  building each row's dotted path from its own nesting. A mapping that is itself a row is never
 *  also recursed into (a row's own `min`/`max`/`origin` children are never candidate parents). */
function collectRawPolicyRows(root: unknown, lineCounter: LineCounter): RawPolicyRow[] {
  const out: RawPolicyRow[] = [];
  function walk(node: unknown, pathParts: string[]): void {
    if (!isMap(node)) return;
    for (const pair of node.items) {
      const keyNode = pair.key;
      const valueNode = pair.value;
      if (!isScalar(keyNode) || typeof keyNode.value !== "string" || !isMap(valueNode)) continue;
      const childKeys = new Set(
        valueNode.items
          .map((p) => (isScalar(p.key) ? p.key.value : undefined))
          .filter((k): k is string => typeof k === "string"),
      );
      const path = [...pathParts, keyNode.value].join(".");
      if (childKeys.has("origin") && childKeys.has("value")) {
        const range = keyNode.range;
        if (!range) continue; // no source position — cannot locate a rationale; skip the row rather than guess one
        const rowObj = valueNode.toJSON() as Record<string, unknown>;
        const bounds =
          typeof rowObj.min === "number" && typeof rowObj.max === "number" ? { min: rowObj.min, max: rowObj.max } : undefined;
        out.push({
          path,
          keyLine: lineCounter.linePos(range[0]).line,
          origin: rowObj.origin,
          value: rowObj.value,
          bounds,
        });
      } else {
        walk(valueNode, [...pathParts, keyNode.value]);
      }
    }
  }
  walk(root, []);
  return out;
}

/** The outcome of one {@link extractPolicyProposalRows} call — a refusal always names why, never
 *  a silent empty export of a policy.yaml that failed to parse. */
export type ExtractPolicyProposalRowsResult = { ok: true; rows: PolicyProposalRow[] } | { ok: false; reason: string };

function selectBundleEntries(
  entries: LearningEntry[],
  budgetChars: number,
): { selected: LearningEntry[]; dropped: LearningEntry[] } {
  const ranked = entries
    .filter((entry) => entry.lifecycle === "active")
    .sort((a, b) => {
      const layerDiff = LAYERS.indexOf(entryLayer(a)) - LAYERS.indexOf(entryLayer(b));
      if (layerDiff !== 0) return layerDiff;
      const ac = a.cited ?? "";
      const bc = b.cited ?? "";
      if (ac !== bc) return bc < ac ? -1 : 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  const selected: LearningEntry[] = [];
  const dropped: LearningEntry[] = [];
  let used = 0;
  for (const entry of ranked) {
    const cost = entryBudgetWeight(entry) + 1;
    if (used + cost > budgetChars && selected.length > 0) {
      dropped.push(entry);
      continue;
    }
    selected.push(entry);
    used += cost;
  }
  return { selected, dropped };
}

/**
 * Extract the exportable rows from a `plan/policy.yaml` text (W1-T2702, design (i)): every row
 * whose `origin:` is literally `"net-new"`, OR whose dotted path is in `opts.ratifiedPaths` (the
 * W1-T2694 ratification-pin seam — read only when a caller supplies it; nothing in this repo
 * populates it today, so day-one behavior is the `net-new` clause alone). A row with NO `origin`
 * field at all (structurally not a `{value, origin, ...}` mapping) is never a candidate — "rows
 * without an origin label are not exported" is true by construction, not a filter that could miss
 * one. PURE — no I/O; the caller reads `plan/policy.yaml` and passes its text in.
 */
export function extractPolicyProposalRows(
  policyYamlText: string,
  opts: { ratifiedPaths?: ReadonlySet<string> } = {},
): ExtractPolicyProposalRowsResult {
  const lineCounter = new LineCounter();
  const doc = parseDocument(policyYamlText, { lineCounter });
  if (doc.errors.length > 0) {
    return { ok: false, reason: `plan/policy.yaml is not valid YAML: ${doc.errors.map((e) => e.message).join("; ")}` };
  }
  const lines = policyYamlText.split("\n");
  const ratified = opts.ratifiedPaths ?? new Set<string>();
  const rows: PolicyProposalRow[] = [];
  for (const raw of collectRawPolicyRows(doc.contents, lineCounter)) {
    if (typeof raw.origin !== "string" || raw.origin.length === 0) continue; // unlabelled — never exported
    if (raw.origin !== "net-new" && !ratified.has(raw.path)) continue;
    const rationale = extractRowRationale(lines, raw.keyLine);
    const base = { path: raw.path, origin: raw.origin, value: raw.value, bounds: raw.bounds, rationale };
    rows.push({ ...base, rowHash: computePolicyProposalRowHash(base) });
  }
  rows.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { ok: true, rows };
}

/** The outcome of one {@link verifyBundlePolicyProposalsPin} call. */
export type BundlePolicyProposalsPinResult = { ok: true; rows: PolicyProposalRow[] } | { ok: false; reason: string };

/**
 * Verify a bundle FILE's own declared `policyProposalsHash` against a fresh recompute over its
 * OWN `policy_proposals` array (W1-T2702, design (iii)). This is deliberately NOT a second
 * operator-supplied `--pin` — the operator already pinned the whole file once, via `--pin <hash>`
 * / {@link verifyBundlePin} (learnings.ts), which checks `entries` only. This is the independent
 * half that check does not cover: an edit to `policy_proposals` after export changes nothing
 * `verifyBundlePin` looks at, so without this, a tampered proposals section would sail through
 * import undetected. Mirrors {@link loadGlobalArtifact}'s (learnings.ts) own recompute-and-compare
 * shape for `entries` — "an edited policy section fails the bundle pin exactly as an edited
 * learning does" (design (iii)), just gated at IMPORT time here rather than at load time there,
 * since nothing today re-reads a bundle's policy section after import the way prompt-assembly
 * re-reads the global learnings artifact.
 */
export function verifyBundlePolicyProposalsPin(bundleText: string): BundlePolicyProposalsPinResult {
  let raw: unknown;
  try {
    raw = parseYaml(bundleText);
  } catch (err) {
    return { ok: false, reason: `bundle is not valid YAML: ${String(err)}` };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: "bundle must be a mapping with 'policy_proposals'/'policyProposalsHash' — refused, not staged" };
  }
  const r = raw as Record<string, unknown>;
  const rows = Array.isArray(r.policy_proposals) ? (r.policy_proposals as PolicyProposalRow[]) : [];
  if (typeof r.policyProposalsHash !== "string" || r.policyProposalsHash.length === 0) {
    return {
      ok: false,
      reason: "bundle missing string 'policyProposalsHash' — cannot verify the proposals section, refused, not staged",
    };
  }
  const actual = computePolicyProposalsHash(rows);
  if (actual !== r.policyProposalsHash) {
    return {
      ok: false,
      reason:
        `bundle policy_proposals hash mismatch: declared ${r.policyProposalsHash}, computed ${actual} — the ` +
        `proposals section was edited after export, refused, not staged`,
    };
  }
  return { ok: true, rows };
}

/**
 * The exact `GlobalArtifact` shape (`version`/`hash`/`entries`) `loadGlobalArtifact` already
 * parses and hash-verifies, plus the doctrine preamble, the worker-settings asserted values, a
 * W1-T2297-discipline per-part manifest, export provenance, and (W1-T2702) the operator-ratified
 * `plan/policy.yaml` rows as proposals — everything a fresh deployment's prompts AND operating
 * limits consume, bundled once.
 */
export interface Bundle {
  /** Advisory version tag; defaults to `provenance.exportedAt` in {@link buildBundle}. */
  version: string;
  /** sha256 hex digest of `entries`, per {@link computeArtifactHash} — the SAME pin `verifyBundlePin` (learnings.ts) checks against an operator-supplied `--pin`. NEVER extended to cover `policy_proposals` — see {@link computePolicyProposalsHash}'s doc for why that section has its own pin instead. */
  hash: string;
  /** The BUDGET-SELECTED corpus ({@link selectLearnings}), with `src` lineage but no structured origin under V1. */
  entries: V1BundleLearningEntry[];
  /** {@link renderDoctrinePreamble}'s two mandatory doctrine lines, verbatim. */
  doctrine: string;
  /** {@link extractAssertedWorkerSettingsValues}'s narrow, validated projection of the worker-settings template. */
  workerSettings: WorkerSettingsAssertedValues;
  /** Per-part `{name, sha256, bytes}` fingerprint (W1-T2297 discipline) of the doctrine/learnings/worker-settings parts above. */
  manifest: PromptManifestPart[];
  provenance: BundleProvenance;
  /** W1-T2702: every exportable `plan/policy.yaml` row ({@link extractPolicyProposalRows}) — `[]` when the caller supplied no policy YAML text to {@link buildBundle}. Never written back to any policy file by anything in this module. */
  policy_proposals: PolicyProposalRow[];
  /** sha256 over `policy_proposals` ({@link computePolicyProposalsHash}) — the independent pin {@link verifyBundlePolicyProposalsPin} checks at import time. */
  policyProposalsHash: string;
}

/** The outcome of one {@link buildBundle} call — a refusal always NAMES why (and, for a tripwire hit, which entry), never a silent empty or under-validated bundle. */
export type BuildBundleResult =
  | { ok: true; bundle: Bundle; dropped: LearningEntry[] }
  | { ok: false; reason: string; blockedEntryId?: string };

/** A V1 artifact cannot carry a field its hash canon does not bind. Preserve identity when there is no origin. */
function projectV1BundleEntry(entry: LearningEntry): V1BundleLearningEntry {
  if (entry.origin === undefined) return entry as V1BundleLearningEntry;
  const { origin: _origin, ...withoutOrigin } = entry;
  return withoutOrigin;
}

/**
 * Build a day-one knowledge bundle from an already-loaded learnings corpus and a parsed
 * worker-settings template (§ this module's header, W1-T2580). PURE — no I/O, no clock read
 * internally; `provenance.exportedAt` and `entries`/`rawSettings` are the caller's job to supply,
 * exactly like {@link buildExportBundle} (learnings.ts) already does for the §6 transport.
 *
 * Four refusals, all BEFORE anything is ever produced:
 * 1. `selectLearnings` (repo-wide, budget-bounded) selects zero entries — refuses naming that.
 * 2. A selected entry matches {@link scrubEntry}'s leak-grep/PII tripwire — refuses naming the
 *    offending entry's id, the SAME independent floor {@link buildExportBundle} already runs.
 * 3. `rawSettings` fails {@link extractAssertedWorkerSettingsValues}'s `validateWorkerSettings`
 *    guard — refuses naming the validation error, never bundling an unvalidated posture.
 * 4. (W1-T2702) `opts.policyYamlText`, when supplied, fails to parse — refuses naming the YAML
 *    error rather than silently exporting zero policy proposals from a broken file.
 *
 * `opts.policyYamlText` is OPTIONAL and additive: omitted (every pre-W1-T2702 caller, including
 * `test/bundle-export.test.ts`), the bundle carries `policy_proposals: []` and a `policyProposalsHash`
 * over that empty array — never a breaking change to the W1-T2580 shape or its round-trip.
 */
export function buildBundle(
  entries: LearningEntry[],
  rawSettings: unknown,
  provenance: BundleProvenance,
  opts: { budgetChars?: number; version?: string; policyYamlText?: string; ratifiedPolicyPaths?: ReadonlySet<string> } = {},
): BuildBundleResult {
  const version = opts.version ?? provenance.exportedAt;
  const budgetChars = opts.budgetChars ?? DEFAULT_KNOWLEDGE_BUDGET_CHARS;
  const { selected, dropped } = selectBundleEntries(entries, budgetChars);
  if (selected.length === 0) {
    return {
      ok: false,
      reason:
        "zero active learnings entries available to bundle — a fresh deployment needs at least one fact to carry; " +
        "populate the project learnings corpus, then bundle again.",
    };
  }
  for (const entry of selected) {
    const scrub = scrubEntry(entry);
    if (scrub.blocked) {
      return {
        ok: false,
        reason:
          `bundle aborted: entry '${entry.id}' matched the leak-grep tripwire (${scrub.reasons.join(", ")}) — ` +
          `no bundle was written. This is the independent floor beneath the budget selection.`,
        blockedEntryId: entry.id,
      };
    }
  }
  let workerSettings: WorkerSettingsAssertedValues;
  try {
    workerSettings = extractAssertedWorkerSettingsValues(rawSettings);
  } catch (err) {
    const message = err instanceof WorkerSettingsError || err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `bundle aborted: worker-settings template failed validation: ${message}` };
  }
  let policyProposals: PolicyProposalRow[] = [];
  if (opts.policyYamlText !== undefined) {
    const extracted = extractPolicyProposalRows(opts.policyYamlText, { ratifiedPaths: opts.ratifiedPolicyPaths });
    if (!extracted.ok) {
      return { ok: false, reason: `bundle aborted: ${extracted.reason}` };
    }
    policyProposals = extracted.rows;
  }
  const doctrine = renderDoctrinePreamble();
  const manifest = buildPromptManifest([
    { name: "doctrine", value: doctrine },
    { name: "learnings", value: renderMatchedLearnings(selected) },
    { name: "worker-settings", value: JSON.stringify(workerSettings) },
  ]);
  const bundledEntries = selected.map(projectV1BundleEntry);
  const bundle: Bundle = {
    version,
    hash: computeArtifactHash(bundledEntries),
    entries: bundledEntries,
    doctrine,
    workerSettings,
    manifest,
    provenance,
    policy_proposals: policyProposals,
    policyProposalsHash: computePolicyProposalsHash(policyProposals),
  };
  return { ok: true, bundle, dropped };
}

/** Render a {@link Bundle} to YAML — the same `GlobalArtifact`-compatible shape {@link loadGlobalArtifact} (learnings.ts) parses back, plus the doctrine/worker-settings/manifest/provenance extras it ignores. */
export function renderBundle(bundle: Bundle): string {
  return stringifyYaml(bundle);
}
