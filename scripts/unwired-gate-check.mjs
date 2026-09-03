#!/usr/bin/env node
// scripts/unwired-gate-check.mjs
//
// UNWIRED-GATE GUARD (W1-T2735).
//
// THE PROPERTY: a gate-shaped instrument that nothing invokes is not a gate. It is a file that
// reads like enforcement to every later session, answers correctly when a human runs it by hand,
// and refuses nothing. `scripts/credit-surface-gate.mjs` is the measured exemplar -- it exists to
// refuse an implementation PR credited on NEITHER the `Remudero-Task:` trailer nor a run-shaped
// head, its own suite covers exactly that case, and on 2026-09-02 a PR with a bare `Task:` trailer
// and a `codex/` head reached review with the gate unwired. A human caught it by reading the body.
//
// THE MECHANISM, which is why this is a CLASS and not two accidents: Rule 25's instrument
// isolation refuses a PR that edits both a detector and the workflow invoking it, so a producer
// task must fence the wiring out. Both producers did, correctly and in writing -- W1-T2292
// criterion 7 ("no caller is edited by this task") and W1-T1214 design (v) (defers "wiring this
// script into a CI workflow step (a separate PR ...)"). Neither successor was ever filed. The
// fence is right; nothing noticed that the follow-through never happened. Per CLAUDE.md's own
// preamble, the remedy for a rule violated silently and repeatedly is to make something REFUSE it.
//
// THE PREDICATE IS THE NAME, NOT THE DIRECTORY. A tracked `scripts/` executable whose basename
// ends `-check.<ext>` or `-gate.<ext>` has CLAIMED to be a gate, and this guard holds it to that
// claim. Everything else under `scripts/` is out of scope by construction: `mount-headroom-sweep`
// and `plan-state-claims` are operator-run analysis tools, `shell-screenshot` is a dev utility,
// and `host-parity.ts` is imported programmatically rather than invoked -- none claimed to be a
// gate, none should be a required check, and a directory-wide predicate would report all four.
//
// WIRED means the basename appears in an EXECUTABLE position: the value of a `run:`, `uses:`,
// `entrypoint:`, `args:` or `cmd:` key in a parsed `.github/workflows/*.yml`, or a value in
// `package.json`'s `scripts` map. The workflow files are parsed with the `yaml` dependency rather
// than read as text, because a COMMENT IS NOT AN INVOCATION -- this guard's own CI job names three
// sibling scripts in its explanatory comment, and a text search credited every one of them as
// wired. A commented-out step likewise no longer exists after parsing. Job and step `name:` fields
// are prose and are excluded for the same reason. The match itself requires the position not be
// preceded by a name character, so `foo-check.mjs` is never credited by a mention of
// `bar-foo-check.mjs`.
//
// THE ALLOWANCE IS RECORDED INLINE AND MAY ONLY SHRINK. Wiring the four current offenders at once
// is a different task with a different blast radius (the blanking check alone reports 19 live
// findings, which W1-T2732 owns), so they are recorded here with a reason each and the guard is
// green on the tree it lands in. A NEWLY added gate-shaped script enters at zero allowance and is
// refused immediately -- there is no verb to add one, only an edit a reviewer sees. An entry whose
// script has since been wired, or which names a script that no longer exists, is ITSELF reported:
// a stale allowance is how a ratchet quietly stops ratcheting.
//
// The allowance is deliberately NOT a `scripts/*-baseline.json` file, which is the house idiom for
// the ratchets: that path is in the reviewer's `INSTRUMENT_SURFACE` (src/lib/review.ts), so a PR
// draining one entry would trip the very Rule 25 entanglement that produced this class.
//
// WHAT THIS CANNOT CATCH -- stated so no reader mistakes a clean run for proof of enforcement: a
// script that really is in a `run:` step, but whose step is never reached or whose exit code is
// discarded (a job with an `if:` that is always false, a step with `continue-on-error: true`, a
// command ending `|| true`), reads as WIRED here. Parsing removes the comment and commented-out
// cases; it cannot decide reachability. This guard proves a gate sits in an EXECUTABLE position,
// not that its refusal is honoured. It raises the floor from "nothing invokes this" to "something
// runs it".
//
// Usage:
//   node scripts/unwired-gate-check.mjs
// Exits 1 and names every offending path; exits 0 ("clean") otherwise.

import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";

/**
 * The gate-shape predicate, applied to a BASENAME. A hyphen is required before the suffix, so
 * `scripts/check.mjs` -- the repo's own aggregate runner -- is not swept in by its bare name.
 */
export const GATE_SHAPED_RE = /-(?:check|gate)\.[^.]+$/;

/** File extensions that make a tracked `scripts/` entry an EXECUTABLE rather than data. */
export const EXECUTABLE_RE = /\.(?:mjs|js|cjs|ts|sh)$/;

/**
 * THE RECORDED ALLOWANCE. Every entry is a gate-shaped script that is unwired TODAY and whose
 * wiring is owned elsewhere. It may only shrink: delete a row when its script is wired, and this
 * guard will report the row if you forget. There is no verb that appends to it -- adding a row is
 * an edit a reviewer reads, which is the whole point.
 */
export const ALLOWANCE = [
  {
    script: "scripts/coverage-session-blanking-check.mjs",
    reason:
      "W1-T2732 owns the wiring; the check exits 1 today on 3 delete-is-noop defects and 16 " +
      "unblanked-NODE_TEST_CONTEXT findings, so wiring it here would redden every open PR at once.",
  },
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

/** A small bounded synchronous sleep (`Atomics.wait` on a throwaway buffer) -- used only to
 *  space out {@link listTrackedScripts}'s retries, never to change the eventual verdict. */
function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Tracked `scripts/` executables, via `git ls-files` -- the tracked set is the subject, and this
 *  keeps untracked scratch out of scope with no separate exclusion list.
 *
 *  Retries a CLEAN nonzero exit up to twice more, a short beat apart, before throwing: a
 *  same-process `git ls-files` is read-only and never fails on a healthy repo, so a failure here
 *  is either genuinely no-repo (this loop still throws, just after `attempts` tries -- unchanged
 *  for `listTrackedScripts` called against a real non-repo directory) or a TRANSIENT race with
 *  another `git` process sharing this checkout (a momentary `index.lock`, the exact shape
 *  test/setup/tmp-hygiene.ts's own module comment (W1-T1217) already measured and fenced for a
 *  clone racing a background `gc --auto` in this same suite). `spawn` is injectable so a test can
 *  simulate that race deterministically rather than needing a genuinely flaky host. */
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

/**
 * Every text an invocation can live in: the executable positions of each parsed
 * `.github/workflows/*.yml`, plus every VALUE in `package.json`'s `scripts` map.
 *
 * The workflows are PARSED, not read as text. A text search over the raw file credits a script
 * named in a comment -- measured while building this guard: its own CI job comment names
 * `credit-surface-gate.mjs`, `coverage-session-blanking-check.mjs` and
 * `tracked-source-write-check.mjs`, and the text form reported the first of them as newly wired.
 * A comment is not an invocation, and neither is a commented-out step.
 *
 * `package.json` KEYS are excluded for the same reason: an npm script NAMED
 * `state-citation-check` whose body runs something else would otherwise credit itself.
 *
 * A workflow that fails to parse THROWS naming the file rather than contributing nothing -- a
 * silently empty wiring text would report every gate-shaped script as unwired at once, which is
 * loud, but a parse error the operator can read is better than a wall of false violations.
 */
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

/**
 * Basename occurrence at a position not preceded by a name character, so `foo-check.mjs` is never
 * credited by a mention of `bar-foo-check.mjs`. A plain `includes` would silently over-credit the
 * shorter of any two scripts sharing a suffix.
 */
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

/**
 * The whole judgement, over an injectable tree. Returns both directions the allowance can be
 * wrong: `unwired` (a gate-shaped script nothing invokes and nothing has recorded) and `stale` (a
 * recorded entry whose script is now wired, or has been deleted) -- because an allowance that only
 * ever grows is not a ratchet.
 */
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

/**
 * The CLI's whole behaviour, injectable exactly like scripts/tracked-source-write-check.mjs's own
 * `main` (same shape, same reason): every collaborator carries a real default, so the entry point
 * below stays a bare `main()` call while a test drives BOTH the clean and the violation-found path
 * in-process. It RETURNS the exit code rather than assigning it, so a fixture's outcome can never
 * leak into the real `node --test` runner's `process.exitCode`.
 */
export function main({
  repoRoot = join(dirname(fileURLToPath(import.meta.url)), ".."),
  scan = scanRepo,
  log = console.log,
  error = console.error,
} = {}) {
  const { unwired, stale, gateShaped, scanned } = scan(repoRoot);

  if (unwired.length > 0 || stale.length > 0) {
    error("unwired-gate-check: FAILED -- a gate-shaped instrument that nothing invokes is not a gate:");
    for (const rel of unwired) {
      error(`  ${rel}: named like a gate, but no .github/workflows/ file and no package.json script invokes it`);
    }
    for (const s of stale) {
      error(`  ${s.script}: recorded in ALLOWANCE, but it ${s.why}`);
    }
    error("");
    error(
      "Wire it: add the script to a job step in .github/workflows/ and to package.json's scripts " +
        "map, exactly as this check itself is wired. The ALLOWANCE in this file records the gates " +
        "whose wiring is owned elsewhere and may only SHRINK -- there is no verb that appends to it.",
    );
    return 1;
  }

  log(
    `unwired-gate-check: clean -- ${gateShaped.length} gate-shaped of ${scanned} tracked scripts/ ` +
      `executables, ${ALLOWANCE.length} recorded as owned elsewhere, 0 unwired and unrecorded.`,
  );
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = main();
}
