#!/usr/bin/env node
// scripts/unwired-gate-check.mjs — the unwired-gate guard (W1-T2735).
//
// A gate-shaped instrument that nothing invokes is not a gate: it reads like enforcement, answers
// correctly only when a human runs it by hand, and refuses nothing. This scans every tracked
// scripts/ executable and every package.json script whose NAME claims to be a gate (a basename or
// script name ending -check/-gate — see GATE_SHAPED_RE / NPM_CHECK_SHAPED_RE) and proves each is
// invoked from a .github/workflows/*.yml file or a package.json script (EXECUTING_KEYS below).
// Why: scripts/credit-surface-gate.mjs sat unwired until a PR reached review uncaught (2026-09-02).
// docs/forensics/unwired-gate-check.md#the-file-header
//
// The workflows are PARSED with the yaml dependency, never read as text: a comment naming a
// script is not an invocation, and this guard's own CI job comment names three siblings that a
// text search would wrongly credit as wired.
//
// ALLOWANCE / NPM_SCRIPT_ALLOWANCE below record gates unwired today whose wiring is owned
// elsewhere; they may only SHRINK — there is no verb that appends a row, only an edit a reviewer
// sees. A stale entry (its script now wired, or gone) is itself reported.
//
// This proves a gate sits in an EXECUTABLE position, not that its refusal is honoured: a step
// behind `if: false` or ending `|| true` still reads WIRED here.
//
// Usage: node scripts/unwired-gate-check.mjs. Exits 1 and names every offending path; 0 otherwise.

import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { isMainModule } from "./lib/argv.mjs";
import { parse as parseYaml } from "yaml";
import { REPO_ROOT } from "./lib/repo-root.mjs";

/** The gate-shape predicate for a basename. A hyphen before the suffix excludes the bare
 *  aggregate runner scripts/check.mjs. */
export const GATE_SHAPED_RE = /-(?:check|gate)\.[^.]+$/;

/** File extensions that make a tracked `scripts/` entry an EXECUTABLE rather than data. */
export const EXECUTABLE_RE = /\.(?:mjs|js|cjs|ts|sh)$/;

/** Gate-shaped scripts unwired today whose wiring is owned elsewhere — shrink-only (see file
 *  header); a script that is wired or gone is reported as stale by scanRepo below. */
export const ALLOWANCE = [
  {
    script: "scripts/credit-surface-gate.mjs",
    reason:
      "W1-T1214 design (v) deferred the workflow step to a successor that was never filed. It " +
      "needs a head ref to judge, so its CI step must supply GITHUB_HEAD_REF -- a wiring decision, " +
      "not a rename.",
  },
  {
    script: "scripts/state-citation-check.mjs",
    reason: "Reads clean today; wiring it is a green-on-landing step nothing has claimed yet.",
  },
  {
    script: "scripts/tracked-source-write-check.mjs",
    reason:
      "W1-T2291 shipped it clean (0 writes across 1012 tracked test files) and fenced the caller " +
      "out of its own scope; wiring it is a green-on-landing step nothing has claimed yet.",
  },
];

// ── R-46: an npm SCRIPT NAME can claim to be a gate too ─────────────────────────────────────
//
// GATE_SHAPED_RE judges a tracked scripts/ file's basename, blind to a check-shaped npm alias
// whose underlying file is named differently (docs-index:check-paths runs generate-docs-
// index.mjs, not itself gate-shaped). Why: R-46 measured this alias unwired and invisible to the
// file-basename predicate. docs/forensics/unwired-gate-check.md#npm_check_shaped_re
//
// Same predicate, now on the package.json KEY: a hyphen or colon must precede "check", and a
// trailing -<word> (:check-paths) still counts.
export const NPM_CHECK_SHAPED_RE = /[-:]check(?:-[a-z0-9-]+)?$/i;

/** Characters allowed inside an npm script name — wider than isWired's boundary class since names
 *  use ":" as well as "-". Stops docs-index:check being credited as wired merely because
 *  docs-index:check-paths appears in a run: step (isWired's foo-check.mjs/bar-foo-check.mjs
 *  hazard, restated for npm names). */
const NPM_SCRIPT_IDENT_RE = /[A-Za-z0-9_.:-]/;

/** The check-shaped-npm-script sibling of ALLOWANCE: same shrink-only contract, keyed by
 *  npmScript rather than a file path. Each entry is a different generator's own staleness check,
 *  unit-tested but invoked by no CI job. Why: measured 2026-09-05, 6 of 14 check-shaped names
 *  were already wired. docs/forensics/unwired-gate-check.md#npm_script_allowance */
export const NPM_SCRIPT_ALLOWANCE = [
  {
    npmScript: "learnings-index:check",
    reason:
      "generate-learnings-index.mjs's own staleness check on learnings/index.json; tested at the " +
      "unit level (test/learnings-index.test.ts) but invoked by no CI job -- wiring it is a " +
      "separate, single-concern PR, same shape as the docs-index pair this PR does wire.",
  },
  {
    npmScript: "plan-index:check",
    reason:
      "generate-plan-index.mjs's own staleness check on plan/plan-index.json; tested at the unit " +
      "level (test/plan-index.test.ts) but invoked by no CI job -- wiring it is a separate, " +
      "single-concern PR, same shape as the docs-index pair this PR does wire.",
  },
  {
    npmScript: "learnings-assert:check",
    reason:
      "learnings-assert-check.mjs's own `--check` mode; invoked by no CI job today -- wiring it " +
      "is a separate, single-concern PR outside R-46's docs-index scope.",
  },
  {
    npmScript: "cli-reference:check",
    reason:
      "generate-cli-reference.mjs's staleness check; exercised only indirectly, by " +
      "test/cli-reference.test.ts spawning the generator script directly (never `npm run " +
      "cli-reference:check`) as part of `npm run test:ci` -- a unit test of the generator, not a " +
      "CI gate enforcing it against the committed docs/cli-reference.md. Wiring the npm alias " +
      "itself is a separate, single-concern PR.",
  },
  {
    npmScript: "macro-skills:check",
    reason:
      "generate-macro-skills.mjs's own `--check` mode; invoked by no CI job today -- wiring it is " +
      "a separate, single-concern PR outside R-46's docs-index scope.",
  },
  {
    npmScript: "capability-snapshot:check",
    reason:
      "generate-capability-snapshot.mjs's own `--check` mode; invoked by no CI job today -- " +
      "wiring it is a separate, single-concern PR outside R-46's docs-index scope.",
  },
  {
    npmScript: "worker-branch-shape:check",
    reason:
      "worker-branch-shape.mjs's own check mode; invoked by no CI job today -- wiring it is a " +
      "separate, single-concern PR outside R-46's docs-index scope.",
  },
];

/** True when a `package.json` scripts KEY has, by its own name, claimed to be a gate. */
export function isNpmScriptCheckShaped(name) {
  return NPM_CHECK_SHAPED_RE.test(name);
}

/** package.json's scripts map keys; a missing or unparseable file yields none rather than
 *  throwing, same as collectWiringText's own read of the file. */
export function listNpmScriptNames(repoRoot) {
  let pkg = {};
  try {
    pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  } catch {
    pkg = {};
  }
  return Object.keys(pkg.scripts ?? {});
}

/** Two-sided occurrence check (isWired is one-sided): a check-shaped name can be a PREFIX of a
 *  longer sibling's name (docs-index:check inside docs-index:check-paths), not only a suffix.
 *  Reuses collectWiringText's text, which excludes a script's own KEY, so it cannot self-credit. */
export function isNpmScriptWired(name, wiringText) {
  let i = wiringText.indexOf(name);
  while (i !== -1) {
    const prev = i === 0 ? "" : wiringText[i - 1];
    const next = wiringText[i + name.length] ?? "";
    if (!NPM_SCRIPT_IDENT_RE.test(prev) && !NPM_SCRIPT_IDENT_RE.test(next)) return true;
    i = wiringText.indexOf(name, i + 1);
  }
  return false;
}

/** The npm-script-name judgement over an injectable tree — scanRepo's sibling, same
 *  unwired/stale shape and shrink-only allowance contract. */
export function scanNpmScripts(repoRoot, { allowance = NPM_SCRIPT_ALLOWANCE, scripts, wiringText } = {}) {
  const names = scripts ?? listNpmScriptNames(repoRoot);
  const wiring = wiringText ?? collectWiringText(repoRoot);
  const checkShaped = names.filter(isNpmScriptCheckShaped);
  const allowed = new Map(allowance.map((e) => [e.npmScript, e]));

  const unwired = [];
  for (const name of checkShaped) {
    if (isNpmScriptWired(name, wiring)) continue;
    if (allowed.has(name)) continue;
    unwired.push(name);
  }

  const stale = [];
  for (const entry of allowance) {
    if (!names.includes(entry.npmScript)) {
      stale.push({ npmScript: entry.npmScript, why: "no longer a package.json script" });
      continue;
    }
    if (isNpmScriptWired(entry.npmScript, wiring)) {
      stale.push({ npmScript: entry.npmScript, why: "is now wired -- delete this row" });
    }
  }

  return { unwired, stale, checkShaped, scanned: names.length };
}

/** A small bounded synchronous sleep (`Atomics.wait` on a throwaway buffer) -- used only to
 *  space out {@link listTrackedScripts}'s retries, never to change the eventual verdict. */
function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Tracked scripts/ executables via git ls-files, so untracked scratch stays out of scope.
 *  Retries a nonzero exit up to twice more before throwing: a same-process, read-only git call
 *  fails only on no-repo or a transient race with another git process (an index.lock, per
 *  test/setup/tmp-hygiene.ts's W1-T1217 fencing); spawn is injectable so a test can simulate it. */
export function listTrackedScripts(repoRoot, spawn = spawnSync) {
  let res;
  const attempts = 3;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    res = spawn("git", ["ls-files", "scripts/"], { cwd: repoRoot, encoding: "utf8" });
    if (res.status === 0 || attempt === attempts) break;
    sleepMs(20 * attempt);
  }
  if (res.status !== 0) {
    throw new Error(`unwired-gate-check: \`git ls-files scripts/\` failed (status ${res.status}): ${res.stderr ?? ""}`);
  }
  return res.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && EXECUTABLE_RE.test(l));
}

/** True when a tracked path has claimed, by its own name, to be a gate. */
export function isGateShaped(relPath) {
  return GATE_SHAPED_RE.test(basename(relPath));
}

/** The YAML keys whose values are EXECUTED. `name:` is prose and is excluded deliberately -- a
 *  step named after the script it does not run must not credit it. */
export const EXECUTING_KEYS = new Set(["run", "uses", "entrypoint", "args", "cmd"]);

/** Collect every string sitting under an {@link EXECUTING_KEYS} key, at any depth. */
export function collectExecutingStrings(node, out = []) {
  if (Array.isArray(node)) {
    for (const item of node) collectExecutingStrings(item, out);
    return out;
  }
  if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (EXECUTING_KEYS.has(key)) {
        if (typeof value === "string") out.push(value);
        else if (Array.isArray(value)) out.push(...value.filter((v) => typeof v === "string"));
      }
      collectExecutingStrings(value, out);
    }
  }
  return out;
}

/** Every text an invocation can live in: each parsed .github/workflows/*.yml's executable
 *  positions, plus every VALUE in package.json's scripts map (never a KEY, so a script named
 *  after itself cannot self-credit).
 *  Why: workflows are parsed, not read as text — a comment naming a script is not an invocation.
 *  docs/forensics/unwired-gate-check.md#collectwiringtext
 *
 *  An unparseable workflow THROWS naming the file, rather than silently reporting every
 *  gate-shaped script as unwired at once. */
export function collectWiringText(repoRoot) {
  const parts = [];
  const wfDir = join(repoRoot, ".github", "workflows");
  let entries = [];
  try {
    entries = readdirSync(wfDir);
  } catch {
    entries = [];
  }
  for (const name of entries.sort()) {
    if (!/\.ya?ml$/.test(name)) continue;
    const full = join(wfDir, name);
    let doc;
    try {
      doc = parseYaml(readFileSync(full, "utf8"));
    } catch (err) {
      throw new Error(`unwired-gate-check: cannot parse .github/workflows/${name}: ${String(err)}`);
    }
    parts.push(...collectExecutingStrings(doc));
  }
  let pkg = {};
  try {
    pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  } catch {
    pkg = {};
  }
  parts.push(...Object.values(pkg.scripts ?? {}).filter((v) => typeof v === "string"));
  return parts.join("\n");
}

/** Basename occurrence not preceded by a name character, so foo-check.mjs is never credited by
 *  a mention of bar-foo-check.mjs — a plain includes would over-credit the shorter of two
 *  scripts sharing a suffix. */
export function isWired(relPath, wiringText) {
  const needle = basename(relPath);
  let i = wiringText.indexOf(needle);
  while (i !== -1) {
    const prev = i === 0 ? "" : wiringText[i - 1];
    if (!/[A-Za-z0-9_-]/.test(prev)) return true;
    i = wiringText.indexOf(needle, i + 1);
  }
  return false;
}

/** The whole judgement over an injectable tree: unwired (a gate-shaped script nothing invokes
 *  and nothing has recorded) and stale (a recorded entry now wired or deleted) — an allowance
 *  that only ever grows is not a ratchet. */
export function scanRepo(repoRoot, { allowance = ALLOWANCE, scripts, wiringText } = {}) {
  const tracked = scripts ?? listTrackedScripts(repoRoot);
  const wiring = wiringText ?? collectWiringText(repoRoot);
  const gateShaped = tracked.filter(isGateShaped);
  const allowed = new Map(allowance.map((e) => [e.script, e]));

  const unwired = [];
  for (const rel of gateShaped) {
    if (isWired(rel, wiring)) continue;
    if (allowed.has(rel)) continue;
    unwired.push(rel);
  }

  const stale = [];
  for (const entry of allowance) {
    if (!tracked.includes(entry.script)) {
      stale.push({ script: entry.script, why: "no longer tracked under scripts/" });
      continue;
    }
    if (isWired(entry.script, wiring)) {
      stale.push({ script: entry.script, why: "is now wired -- delete this row" });
    }
  }

  return { unwired, stale, gateShaped, scanned: tracked.length };
}

/** The CLI's whole behaviour, injectable like tracked-source-write-check.mjs's own main: every
 *  collaborator carries a real default, so a test drives both the clean and violation-found
 *  path in-process. Returns the exit code rather than assigning it, so a fixture's outcome can
 *  never leak into the real test runner's process.exitCode. */
export function main({
  repoRoot = REPO_ROOT,
  scan = scanRepo,
  scanNpm = scanNpmScripts,
  log = console.log,
  error = console.error,
} = {}) {
  const { unwired, stale, gateShaped, scanned } = scan(repoRoot);
  const { unwired: npmUnwired, stale: npmStale, checkShaped, scanned: npmScanned } = scanNpm(repoRoot);

  if (unwired.length > 0 || stale.length > 0 || npmUnwired.length > 0 || npmStale.length > 0) {
    error("unwired-gate-check: FAILED -- a gate-shaped instrument that nothing invokes is not a gate:");
    for (const rel of unwired) {
      error(`  ${rel}: named like a gate, but no .github/workflows/ file and no package.json script invokes it`);
    }
    for (const s of stale) {
      error(`  ${s.script}: recorded in ALLOWANCE, but it ${s.why}`);
    }
    for (const name of npmUnwired) {
      error(`  ${name}: an npm script named like a gate, but no .github/workflows/ file and no OTHER package.json script invokes it`);
    }
    for (const s of npmStale) {
      error(`  ${s.npmScript}: recorded in NPM_SCRIPT_ALLOWANCE, but it ${s.why}`);
    }
    error("");
    error(
      "Wire it: add the script to a job step in .github/workflows/ and to package.json's scripts " +
        "map, exactly as this check itself is wired. The ALLOWANCE/NPM_SCRIPT_ALLOWANCE in this " +
        "file record the gates whose wiring is owned elsewhere and may only SHRINK -- there is no " +
        "verb that appends to either.",
    );
    return 1;
  }

  log(
    `unwired-gate-check: clean -- ${gateShaped.length} gate-shaped of ${scanned} tracked scripts/ ` +
      `executables, ${ALLOWANCE.length} recorded as owned elsewhere, 0 unwired and unrecorded; ` +
      `${checkShaped.length} check-shaped of ${npmScanned} package.json scripts, ` +
      `${NPM_SCRIPT_ALLOWANCE.length} recorded as owned elsewhere, 0 unwired and unrecorded.`,
  );
  return 0;
}

if (isMainModule(import.meta.url)) {
  process.exitCode = main();
}
