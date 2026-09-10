import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// ── W1-T3345 — NO TEST MAY AIM A WRITE AT procfs ──────────────────────────────────────────────
//
// MEASURED 2026-09-10: `mkdirSync("/proc/definitely-not-writable", { recursive: true })` does not
// return EACCES on this kernel — it BLOCKS. Directly: exit 124 under a 20s bound. One assertion
// using it as a stand-in for "an unwritable root" stalled coverage-shard (2/4) for 39.5 minutes
// until `timeout-minutes` killed the job; a killed job is labelled `cancelled`, which the required
// aggregators read as a shard failure. So a blocking syscall in one test was reported to operators
// as a broken diff on PRs that never touched it, repeatedly, for hours.
//
// READS ARE FINE AND ARE NOT SCANNED. `/proc/meminfo`, `/proc/stat` and `/proc/<pid>/…` are read by
// several suites, and fixtures name procfs paths as strings all over the place. Only a path handed
// to a WRITE-shaped call is a hazard, because only that reaches mkdir/open-for-write under procfs.
//
// THE REMEDY WHEN THIS FIRES: a FILE where a directory must be. It tests the same real IO, fails at
// once with ENOTDIR, and depends on no kernel-specific behaviour.

const TEST_DIR = fileURLToPath(new URL(".", import.meta.url));
const SELF = "no-test-aims-a-write-at-procfs.test.ts";

/** Write-shaped fs entry points. A procfs literal reaching any of these can block. */
const WRITE_CALLS = ["mkdirSync", "mkdtempSync", "writeFileSync", "appendFileSync", "rmSync", "openSync", "createWriteStream", "cpSync"];

/** `dir:`/`path:`/`cwd:` options are handed to the same calls one layer down, so they count too. */
const WRITE_OPTIONS = ["dir", "path", "cwd", "root", "out", "outDir"];

interface Offence { file: string; line: number; text: string }

function scan(): Offence[] {
  const out: Offence[] = [];
  for (const entry of readdirSync(TEST_DIR, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".test.ts")) continue;
    // THIS FILE IS EXCLUDED, and must be: it names the forbidden shape twice on purpose — once in
    // the comment that explains the incident, once in the fixture that proves the detector fires.
    // A census that scans itself reports its own documentation as the defect.
    if (entry.name === SELF) continue;
    const lines = readFileSync(join(TEST_DIR, entry.name), "utf8").split("\n");
    lines.forEach((raw, i) => {
      if (!raw.includes("/proc/")) return;
      const call = WRITE_CALLS.some((c) => raw.includes(`${c}(`));
      const option = WRITE_OPTIONS.some((o) => new RegExp(`\\b${o}\\s*:\\s*["'\`]/proc/`).test(raw));
      if (call || option) out.push({ file: entry.name, line: i + 1, text: raw.trim().slice(0, 120) });
    });
  }
  return out;
}

test("W1-T3345: no test aims a write-shaped call at procfs — it blocks rather than failing", () => {
  const offences = scan();
  assert.deepEqual(
    offences,
    [],
    offences.length === 0
      ? ""
      : `a procfs path reaching a write-shaped call BLOCKS on this kernel and stalls the shard until ` +
        `timeout-minutes kills it. Use a FILE where a directory must be (ENOTDIR, immediate) instead:\n` +
        offences.map((o) => `  ${o.file}:${o.line}  ${o.text}`).join("\n"),
  );
});

test("W1-T3345: the scanner reads real suites and recognises the shape it forbids", () => {
  // THE ROW THAT STOPS THIS PASSING OVER NOTHING. A scanner pointed at an empty directory, or one
  // whose pattern matches nothing, reports zero offences exactly like a clean tree.
  const files = readdirSync(TEST_DIR).filter((f) => f.endsWith(".test.ts"));
  assert.ok(files.length > 100, `expected to scan the real suite directory, saw ${files.length} file(s)`);

  // And the detector fires on the exact line that caused the incident, reconstructed here as text.
  const offending = `  assert.equal(m.fileFoldDebt("CLAUDE.md", 1, 2, OVER, { dir: "/proc/definitely-not-writable" }), null);`;
  const matchesOption = WRITE_OPTIONS.some((o) => new RegExp(`\\b${o}\\s*:\\s*["'\`]/proc/`).test(offending));
  assert.ok(matchesOption, "the detector must recognise the historical offender");

  // A READ must NOT match, or this guard would forbid the many legitimate procfs reads.
  const legitimate = `    if (target === "/proc/meminfo") return "MemTotal: 8000000 kB\\n";`;
  const readMatchesCall = WRITE_CALLS.some((c) => legitimate.includes(`${c}(`));
  const readMatchesOption = WRITE_OPTIONS.some((o) => new RegExp(`\\b${o}\\s*:\\s*["'\`]/proc/`).test(legitimate));
  assert.equal(readMatchesCall || readMatchesOption, false, "a procfs READ must stay allowed");
});
