import { stringify as stringifyYaml } from "yaml";
import {
  computeArtifactHash,
  DEFAULT_KNOWLEDGE_BUDGET_CHARS,
  renderDoctrinePreamble,
  renderMatchedLearnings,
  scrubEntry,
  selectLearnings,
  type LearningEntry,
} from "./learnings.js";
import { buildPromptManifest, type PromptManifestPart } from "./prompt-manifest.js";
import { validateWorkerSettings, WorkerSettingsError } from "./settings.js";

/**
 * `rmd bundle export <path>` — THE MISSING EXPORT HALF (W1-T2580).
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

/**
 * The exact `GlobalArtifact` shape (`version`/`hash`/`entries`) `loadGlobalArtifact` already
 * parses and hash-verifies, plus the doctrine preamble, the worker-settings asserted values, a
 * W1-T2297-discipline per-part manifest, and export provenance — everything a fresh deployment's
 * prompts consume, bundled once.
 */
export interface Bundle {
  /** Advisory version tag; defaults to `provenance.exportedAt` in {@link buildBundle}. */
  version: string;
  /** sha256 hex digest of `entries`, per {@link computeArtifactHash} — the SAME pin `verifyBundlePin` (learnings.ts) checks against an operator-supplied `--pin`. */
  hash: string;
  /** The BUDGET-SELECTED corpus ({@link selectLearnings}), every entry's provenance intact — never the full unbounded corpus. */
  entries: LearningEntry[];
  /** {@link renderDoctrinePreamble}'s two mandatory doctrine lines, verbatim. */
  doctrine: string;
  /** {@link extractAssertedWorkerSettingsValues}'s narrow, validated projection of the worker-settings template. */
  workerSettings: WorkerSettingsAssertedValues;
  /** Per-part `{name, sha256, bytes}` fingerprint (W1-T2297 discipline) of the doctrine/learnings/worker-settings parts above. */
  manifest: PromptManifestPart[];
  provenance: BundleProvenance;
}

/** The outcome of one {@link buildBundle} call — a refusal always NAMES why (and, for a tripwire hit, which entry), never a silent empty or under-validated bundle. */
export type BuildBundleResult =
  | { ok: true; bundle: Bundle; dropped: LearningEntry[] }
  | { ok: false; reason: string; blockedEntryId?: string };

/**
 * Build a day-one knowledge bundle from an already-loaded learnings corpus and a parsed
 * worker-settings template (§ this module's header, W1-T2580). PURE — no I/O, no clock read
 * internally; `provenance.exportedAt` and `entries`/`rawSettings` are the caller's job to supply,
 * exactly like {@link buildExportBundle} (learnings.ts) already does for the §6 transport.
 *
 * Three refusals, all BEFORE anything is ever produced:
 * 1. `selectLearnings` (repo-wide, budget-bounded) selects zero entries — refuses naming that.
 * 2. A selected entry matches {@link scrubEntry}'s leak-grep/PII tripwire — refuses naming the
 *    offending entry's id, the SAME independent floor {@link buildExportBundle} already runs.
 * 3. `rawSettings` fails {@link extractAssertedWorkerSettingsValues}'s `validateWorkerSettings`
 *    guard — refuses naming the validation error, never bundling an unvalidated posture.
 */
export function buildBundle(
  entries: LearningEntry[],
  rawSettings: unknown,
  provenance: BundleProvenance,
  opts: { budgetChars?: number; version?: string } = {},
): BuildBundleResult {
  const budgetChars = opts.budgetChars ?? DEFAULT_KNOWLEDGE_BUDGET_CHARS;
  // Repo-wide (taskFiles undefined): a fresh deployment needs the WHOLE budgeted corpus, not one
  // task's file-matched slice — the budget still bounds the tax, same as selectLearnings' own
  // repo-wide convention.
  const { selected, dropped } = selectLearnings(entries, undefined, budgetChars);
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
  const doctrine = renderDoctrinePreamble();
  const manifest = buildPromptManifest([
    { name: "doctrine", value: doctrine },
    { name: "learnings", value: renderMatchedLearnings(selected) },
    { name: "worker-settings", value: JSON.stringify(workerSettings) },
  ]);
  const bundle: Bundle = {
    version: opts.version ?? provenance.exportedAt,
    hash: computeArtifactHash(selected),
    entries: selected,
    doctrine,
    workerSettings,
    manifest,
    provenance,
  };
  return { ok: true, bundle, dropped };
}

/** Render a {@link Bundle} to YAML — the same `GlobalArtifact`-compatible shape {@link loadGlobalArtifact} (learnings.ts) parses back, plus the doctrine/worker-settings/manifest/provenance extras it ignores. */
export function renderBundle(bundle: Bundle): string {
  return stringifyYaml(bundle);
}
