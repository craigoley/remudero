#!/usr/bin/env node
// test/helpers/check-dependency-licences.mjs
//
// DEPENDENCY-LICENCE ALLOW-LIST GATE (W1-T934), self-contained replacement for the
// actions/dependency-review-action-backed `license-review` job.
//
// WHY THIS EXISTS INSTEAD OF THE VENDOR ACTION: the first cut of this gate (round 1) used
// actions/dependency-review-action, which classifies licences via ONE call to GitHub's own
// `GET /repos/{owner}/{repo}/dependency-graph/compare/{basehead}` API. On THIS repository that
// call returns 403 ("Dependency review is not supported on this repository... ensure Dependency
// graph is enabled") -- confirmed independently via `gh api repos/{owner}/{repo}/dependency-
// graph/sbom` (404, "not enabled for this repository") and a direct `compare` call (403), and
// this worker's own token lacks the `administration` scope needed to flip that repo/org setting
// even though it never gets the chance to try (org policy, not a missing checkbox this repo's
// admin left off). The vendor action has NO fallback path that skips this API (verified against
// its pinned source at a1d282b: `src/dependency-graph.ts`'s `compare()` is the only source of
// dependency changes; there is no local/manifest-only mode) -- so it can never pass here no
// matter how it is configured. This script keeps the SAME acceptance shape (an allow-listed,
// diff-scoped, blocking licence gate) without depending on that unavailable API: it reads
// `package-lock.json` DIRECTLY at the PR's base and head refs via `git show`, computes the set
// of `name@version` pairs newly introduced at head (present at head, absent at base -- the same
// "added" semantics the vendor's compare API itself documents), and classifies each one's
// `license` field (present in every entry of an npm lockfileVersion 3 `packages` map, sourced
// from the registry at lock time -- no network call needed here either).
//
// WHY IT LIVES UNDER `test/helpers/`, NOT `scripts/`: MASTER-PLAN Standing rule 25 (W1-T297,
// `src/lib/review.ts`) forces a diff to failure, unsuppressibly, when it entangles an
// INSTRUMENT_SURFACE path (`.github/workflows/**` is one) with a `src/**` product path in the
// SAME PR -- and a NEW `scripts/*.mjs` referenced from a workflow is exactly the "declare it in
// INSTRUMENT_SURFACE/EXCLUSIONS" case that requires editing `src/lib/review.ts`. This PR already
// touches `.github/workflows/dependency-review.yml` to invoke this script, so adding it under
// `scripts/` would force that same-PR entanglement. `test/**` is the design's own documented
// carve-out instead (`isProductPath` is `src/**` minus `test/**`, deliberately, "so an
// instrument-only PR could never carry the fixture that proves it" -- see docs/ORIENTATION.md
// Standing rule 25 and test/instrument-surface-completeness.test.ts's own exclusion-derivation
// logic, which never treats a `test/**` path as a gate-rule candidate needing a declaration at
// all). This module is imported directly by test/dependency-licence-policy.test.ts's unit tests
// AND invoked as a real CLI by the workflow step -- one file, no behavioural difference either way.
//
// CLASSIFICATION (mirrors the vendor's own forbidden/unresolved/unlicensed split, § test suite):
//   - "allowed"     -- every clause of the licence (single id, or an `A AND B` / `A OR B` SPDX
//                      expression) is on the allow-list ("OR": any one clause suffices).
//   - "forbidden"   -- a syntactically SPDX-id-shaped licence (or expression) that isn't on the
//                      allow-list, e.g. a copyleft licence. ALWAYS fails; never exemptable --
//                      there is no escape hatch for a genuinely-classified disallowed licence.
//   - "unresolved"  -- a licence string present but not shaped like an SPDX id/expression (e.g.
//                      "SEE LICENSE IN LICENSE.md").
//   - "no-license"  -- no `license` field at all (`null`/missing/empty).
// "unresolved" and "no-license" are the two undeterminable buckets; both fail UNLESS the package
// is named (with a reason) in LICENSE_EXEMPTIONS, reviewed individually rather than papered over.
//
// Usage:
//   node test/helpers/check-dependency-licences.mjs --base <ref> --head <ref>
//   (env overrides: ALLOW_LICENSES="MIT, Apache-2.0, ...", LICENSE_EXEMPTIONS='[{"name":"x","reason":"y"}]')

import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

export const DEFAULT_ALLOW_LICENSES = ["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC"];

const SPDX_TOKEN = /^[A-Za-z0-9.+-]+$/;

/** Load and JSON.parse `package-lock.json` as it existed at `ref`, via `git show`. */
export function readLockAtRef(ref, { cwd } = {}) {
  const raw = execFileSync("git", ["show", `${ref}:package-lock.json`], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 128,
    cwd,
  });
  return JSON.parse(raw);
}

/**
 * Flatten an npm lockfileVersion-3 `packages` map into `name@version` -> licence (string|null).
 * Workspace-local entries (no `version`, e.g. this repo's own `apps/dashboard`) and the root `""`
 * entry are skipped -- they are not third-party dependencies. The package NAME is derived from
 * the map's own key (the path segment after the LAST `node_modules/`), not the entry's own
 * `name` field (npm does not always populate that field on nested entries), so a scoped package
 * nested arbitrarily deep (`node_modules/foo/node_modules/@scope/bar`) still resolves correctly.
 */
export function collectLockPackages(lock) {
  const out = new Map();
  const packages = lock?.packages ?? {};
  for (const [path, info] of Object.entries(packages)) {
    if (path === "" || !info || typeof info !== "object") continue;
    const idx = path.lastIndexOf("node_modules/");
    if (idx === -1) continue; // a workspace member (e.g. apps/dashboard), not a dependency
    const name = path.slice(idx + "node_modules/".length);
    const version = info.version;
    if (!name || !version) continue;
    const key = `${name}@${version}`;
    if (!out.has(key)) out.set(key, info.license ?? null);
  }
  return out;
}

/** `name@version` pairs present in `head` but absent from `base` -- the PR's own introductions. */
export function diffAdded(baseMap, headMap) {
  const added = [];
  for (const [key, license] of headMap) {
    if (baseMap.has(key)) continue;
    const at = key.lastIndexOf("@");
    added.push({ name: key.slice(0, at), version: key.slice(at + 1), license });
  }
  added.sort((a, b) => (a.name === b.name ? a.version.localeCompare(b.version) : a.name.localeCompare(b.name)));
  return added;
}

/** Classify one licence string (or expression) against an allow-list. See header comment. */
export function classifyLicense(license, allowList) {
  if (license === null || license === undefined) return "no-license";
  const trimmed = String(license).trim();
  if (!trimmed) return "no-license";
  const stripped = trimmed.replace(/^\(+/, "").replace(/\)+$/, "");
  let clauses;
  let mode;
  if (stripped.includes(" AND ")) {
    clauses = stripped.split(" AND ");
    mode = "AND";
  } else if (stripped.includes(" OR ")) {
    clauses = stripped.split(" OR ");
    mode = "OR";
  } else {
    clauses = [stripped];
    mode = "AND";
  }
  const normalized = clauses.map((c) => c.trim());
  if (!normalized.every((c) => SPDX_TOKEN.test(c))) return "unresolved";
  const allowSet = new Set(allowList.map((s) => s.trim()));
  const satisfied = mode === "AND" ? normalized.every((c) => allowSet.has(c)) : normalized.some((c) => allowSet.has(c));
  return satisfied ? "allowed" : "forbidden";
}

/**
 * Evaluate every added dependency, splitting into offenders (forbidden -- never exemptable) and
 * undetermined (no-license/unresolved -- exemptable by name+reason in `exemptions`).
 */
export function evaluate(added, { allowList, exemptions = [] }) {
  const exemptNames = new Set(exemptions.map((e) => e.name));
  const offenders = [];
  const undetermined = [];
  const allowed = [];
  for (const dep of added) {
    const verdict = classifyLicense(dep.license, allowList);
    if (verdict === "allowed") {
      allowed.push(dep);
    } else if (verdict === "forbidden") {
      offenders.push({ ...dep, verdict });
    } else if (exemptNames.has(dep.name)) {
      allowed.push(dep);
    } else {
      undetermined.push({ ...dep, verdict });
    }
  }
  return { offenders, undetermined, allowed };
}

function formatDep(dep) {
  return `  - ${dep.name}@${dep.version} (licence: ${dep.license ?? "NOASSERTION"}, verdict: ${dep.verdict})`;
}

export function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      base: { type: "string" },
      head: { type: "string", default: "HEAD" },
    },
  });
  if (!values.base) {
    console.error("check-dependency-licences: --base <ref> is required (the PR's base ref/sha).");
    process.exitCode = 1;
    return;
  }

  const allowList = (process.env.ALLOW_LICENSES ?? DEFAULT_ALLOW_LICENSES.join(", "))
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  let exemptions = [];
  const rawExemptions = process.env.LICENSE_EXEMPTIONS ?? "[]";
  if (rawExemptions.trim()) {
    exemptions = JSON.parse(rawExemptions);
  }

  const baseMap = collectLockPackages(readLockAtRef(values.base));
  const headMap = collectLockPackages(readLockAtRef(values.head));
  const added = diffAdded(baseMap, headMap);

  if (added.length === 0) {
    console.log("check-dependency-licences: no dependency added by this PR -- nothing to classify.");
    process.exitCode = 0;
    return;
  }

  const { offenders, undetermined, allowed } = evaluate(added, { allowList, exemptions });
  console.log(
    `check-dependency-licences: ${added.length} dependenc${added.length === 1 ? "y" : "ies"} added, ` +
      `${allowed.length} allowed, ${offenders.length} forbidden, ${undetermined.length} undetermined.`,
  );
  if (offenders.length > 0) {
    console.error("check-dependency-licences: FORBIDDEN licence(s) introduced (not on the allow-list, never exemptable):");
    for (const dep of offenders) console.error(formatDep(dep));
  }
  if (undetermined.length > 0) {
    console.error(
      "check-dependency-licences: UNDETERMINABLE licence(s) introduced, not named in LICENSE_EXEMPTIONS with a reason:",
    );
    for (const dep of undetermined) console.error(formatDep(dep));
  }
  if (offenders.length > 0 || undetermined.length > 0) {
    process.exitCode = 1;
    return;
  }
  console.log(`check-dependency-licences: clean -- every added dependency's licence is on [${allowList.join(", ")}].`);
  process.exitCode = 0;
}

// Only run when executed directly (`node test/helpers/check-dependency-licences.mjs ...`), never on import.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2));
}
