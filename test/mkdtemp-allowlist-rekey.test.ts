/**
 * test/mkdtemp-allowlist-rekey.test.ts — W1-T2786.
 *
 * THE DEFECT THESE PROOFS CLOSE. `hooks/mkdtemp-allowlist.txt` keyed every exemption on
 * `<file>:<line>`. Insert one line anywhere above an allowlisted callsite and the entry stopped
 * naming it, so a callsite exempt for months was refused as though it were brand new — and the
 * red landed on whoever shifted the line, an author with no connection to temp directories.
 * Nothing failed loudly. MEASURED 2026-09-03 on a green main: one unrelated comment line
 * produced `(1 refused; 998 on hooks/mkdtemp-allowlist.txt)`.
 *
 * The key is now `<file>:<prefix>` (`allowlistKey`). A prefix does not move when the file above
 * it does.
 *
 * WHY A NEW FILE RATHER THAN MORE CASES IN test/mkdtemp-callsite-check.test.ts. W1-T362 grades a
 * `unit test:` proof `executed_stale` when it reads the same at head and at base, and that
 * sibling suite passes on an unmodified `origin/main` — so proofs citing it would substantiate
 * nothing. A path absent at base cannot pass at base. The split is a discrimination decision.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

// `scripts/**` sits outside tsconfig's `include`, so the .mjs loads through a dynamic specifier
// — the REAL module, with no shadow copy to drift from it (same pattern as the sibling suite).
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "mkdtemp-callsite-check.mjs");

type Row = { file: string; line: number; arg: string; classification: string; prefix: string };
type ScanSummary = { refused: Row[]; scanned: number; allowedCount: number };
const mod = (await import(pathToFileURL(SCRIPT).href)) as {
  ALLOWLIST_PATH: string;
  RMD_TMP_PREFIX: string;
  UNRESOLVABLE_PREFIX_SENTINEL: string;
  allowlistKey: (file: string, prefix: string) => string;
  formatRefusal: (row: { file: string; line: number; arg: string; prefix?: string }) => string;
  loadAllowlist: (repoRoot: string) => Set<string>;
  main: (opts?: { repoRoot?: string; out?: (s: string) => void; err?: (s: string) => void }) => number;
  mkdtempPrefixOf: (expr: string) => string;
  parseMkdtempFirstArg: (expr: string) => { classification: string; prefix: string };
  scanFile: (text: string) => Array<{ line: number; arg: string; classification: string; prefix: string }>;
  scanRepo: (repoRoot: string) => ScanSummary;
};
const {
  ALLOWLIST_PATH,
  RMD_TMP_PREFIX,
  UNRESOLVABLE_PREFIX_SENTINEL,
  allowlistKey,
  formatRefusal,
  main,
  mkdtempPrefixOf,
  parseMkdtempFirstArg,
  scanFile,
  scanRepo,
} = mod;

const BARE_CALLSITE = "const d = mkdtempSync(join(tmpdir(), 'sweep-reentry-'));";

function makeFixtureRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}mkdtemp-rekey-fixture-`));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
  execFileSync("git", ["-C", root, "init", "-q", "-b", "main"], { env });
  execFileSync("git", ["-C", root, "config", "user.email", "t@e.x"], { env });
  execFileSync("git", ["-C", root, "config", "user.name", "t"], { env });
  writeAll(root, files);
  execFileSync("git", ["-C", root, "add", "-A"], { env });
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "seed", "--no-verify"], { env });
  return root;
}

function writeAll(root: string, files: Record<string, string>): void {
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(root, rel.replace(/\/[^/]*$/, "") || "."), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
}

/** Rewrite one fixture file and re-stage it, the way a real edit would reach the checker. */
function rewrite(root: string, rel: string, body: string): void {
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
  writeFileSync(join(root, rel), body);
  execFileSync("git", ["-C", root, "add", "-A"], { env });
}

// ── criterion 1: the regression itself ────────────────────────────────────────────────────────

test("W1-T2786 rekey: an unrelated line insertion above an allowlisted callsite does not refuse", () => {
  const root = makeFixtureRepo({
    "test/bare.test.ts": ["import { mkdtempSync } from 'node:fs';", BARE_CALLSITE].join("\n"),
    [ALLOWLIST_PATH]: `test/bare.test.ts:sweep-reentry-  # exempt\n`,
  });
  assert.equal(scanRepo(root).refused.length, 0, "the allowlisted callsite must start clean");

  // The edit that used to break it: one unrelated line inserted ABOVE the callsite, by an
  // author with no connection to temp directories. The callsite moves from line 2 to line 4.
  rewrite(
    root,
    "test/bare.test.ts",
    ["// an unrelated comment", "// and another", "import { mkdtempSync } from 'node:fs';", BARE_CALLSITE].join("\n"),
  );
  const after = scanRepo(root);
  assert.equal(after.refused.length, 0, `a line insertion must not resurrect the refusal; got:\n${after.refused.map((r) => formatRefusal(r)).join("\n")}`);

  // The callsite really did move — otherwise this proves nothing about position independence.
  const rows = scanFile(readFileSync(join(root, "test/bare.test.ts"), "utf8"));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.line, 4, "the callsite must actually have shifted for this to be a test");
});

test("W1-T2786 rekey: the retired `<file>:<line>` spelling is INERT — the old scheme cannot silently still be in force", () => {
  // The negative half of criterion 1. If keying had not really changed, a line-keyed entry
  // would still exempt and the proof above would pass for the wrong reason.
  const root = makeFixtureRepo({
    "test/bare.test.ts": ["import { mkdtempSync } from 'node:fs';", BARE_CALLSITE].join("\n"),
    [ALLOWLIST_PATH]: `test/bare.test.ts:2  # the retired line-keyed spelling\n`,
  });
  const summary = scanRepo(root);
  assert.equal(summary.refused.length, 1, "a line-keyed entry must no longer exempt anything");
  assert.equal(summary.refused[0]!.prefix, "sweep-reentry-");
});

// ── criterion 2: the rule did not go soft ─────────────────────────────────────────────────────

test("W1-T2786 rekey: a genuinely new bare-prefix callsite is still refused", () => {
  const root = makeFixtureRepo({
    "test/bare.test.ts": ["import { mkdtempSync } from 'node:fs';", BARE_CALLSITE].join("\n"),
    [ALLOWLIST_PATH]: `test/bare.test.ts:sweep-reentry-  # exempt\n`,
  });
  assert.equal(scanRepo(root).refused.length, 0);

  // A DIFFERENT prefix in the SAME, already-allowlisted file: the exemption is per prefix, not
  // a licence for the file.
  rewrite(
    root,
    "test/bare.test.ts",
    ["import { mkdtempSync } from 'node:fs';", BARE_CALLSITE, "const e = mkdtempSync(join(tmpdir(), 'brand-new-'));"].join("\n"),
  );
  const summary = scanRepo(root);
  assert.equal(summary.refused.length, 1, "a new bare prefix must refuse even in an allowlisted file");
  assert.equal(summary.refused[0]!.prefix, "brand-new-");
});

// ── criterion 3: the file half of the key still carries meaning ───────────────────────────────

test("W1-T2786 rekey: an allowlisted prefix appearing in a DIFFERENT file is still refused", () => {
  const root = makeFixtureRepo({
    "test/bare.test.ts": ["import { mkdtempSync } from 'node:fs';", BARE_CALLSITE].join("\n"),
    "test/other.test.ts": ["import { mkdtempSync } from 'node:fs';", BARE_CALLSITE].join("\n"),
    [ALLOWLIST_PATH]: `test/bare.test.ts:sweep-reentry-  # exempt, this file only\n`,
  });
  const summary = scanRepo(root);
  assert.equal(summary.refused.length, 1, "dropping the line must not have dropped the file — that would be a global prefix amnesty");
  assert.equal(summary.refused[0]!.file, "test/other.test.ts");
  assert.equal(summary.refused[0]!.prefix, "sweep-reentry-");
});

test("W1-T2786 rekey: two callsites in ONE file sharing a prefix collapse to a single entry", () => {
  // The intended consequence of dropping the line, asserted rather than assumed: they would
  // want exempting together anyway, and a collapsed entry cannot half-decay.
  const root = makeFixtureRepo({
    "test/bare.test.ts": ["import { mkdtempSync } from 'node:fs';", BARE_CALLSITE, BARE_CALLSITE, BARE_CALLSITE].join("\n"),
    [ALLOWLIST_PATH]: `test/bare.test.ts:sweep-reentry-  # one entry, three callsites\n`,
  });
  assert.equal(scanFile(readFileSync(join(root, "test/bare.test.ts"), "utf8")).length, 3, "the fixture must really hold three callsites");
  assert.equal(scanRepo(root).refused.length, 0);
});

// ── criterion 4: unresolvable callsites stay expressible ──────────────────────────────────────

test("W1-T2786 rekey: a statically unresolvable prefix keys on the file plus an explicit sentinel and remains exemptible", () => {
  const varCallsite = "const d = mkdtempSync(join(tmpdir(), somePrefix));";
  const root = makeFixtureRepo({
    "scripts/drill.mjs": ["import { mkdtempSync } from 'node:fs';", varCallsite].join("\n"),
    [ALLOWLIST_PATH]: "# no exemptions yet\n",
  });
  const before = scanRepo(root);
  assert.equal(before.refused.length, 1, "a variable prefix must fail closed — the AST cannot prove reapability");
  assert.equal(before.refused[0]!.classification, "unresolvable");
  assert.equal(before.refused[0]!.prefix, UNRESOLVABLE_PREFIX_SENTINEL, "it must carry the sentinel, not an empty or invented prefix");

  // And it must be exemptible — otherwise a whole refusable classification would have become
  // inexpressible in the allowlist, which is a capability the re-key must not silently drop.
  writeAll(root, { [ALLOWLIST_PATH]: `${allowlistKey("scripts/drill.mjs", UNRESOLVABLE_PREFIX_SENTINEL)}  # variable prefix normalized at runtime\n` });
  assert.equal(scanRepo(root).refused.length, 0, "the sentinel key must actually exempt the callsite");
});

test("W1-T2786 rekey: the sentinel cannot collide with a real extracted prefix", () => {
  // Angle brackets cannot appear in the literal head of a template or in an identifier, so no
  // real callsite can produce the sentinel by accident.
  assert.equal(mkdtempPrefixOf(`join(tmpdir(), '${UNRESOLVABLE_PREFIX_SENTINEL}')`), UNRESOLVABLE_PREFIX_SENTINEL);
  assert.equal(parseMkdtempFirstArg(`join(tmpdir(), '${UNRESOLVABLE_PREFIX_SENTINEL}')`).classification, "bare-literal");
  // A template that OPENS with an interpolation has an EMPTY literal head, which names nothing
  // a reader could act on — it must take the sentinel rather than an empty-string key.
  assert.equal(mkdtempPrefixOf("join(tmpdir(), `${notSanctioned}-tail-`)"), UNRESOLVABLE_PREFIX_SENTINEL);
});

// ── criterion 5: one shared extractor ─────────────────────────────────────────────────────────

test("W1-T2786 rekey: the key and the refusal message read the prefix through one shared extractor", () => {
  // Proven by ROUND TRIP rather than by comparing two strings: paste the key the message tells
  // you to add, and the refusal must go away. If the message's prefix and the key's prefix were
  // computed by different code, the advice would be unfollowable — which is exactly what the
  // pre-W1-T2786 `formatRefusal` regex did on the template case below.
  const tricky = "const d = mkdtempSync(join(tmpdir(), `bare-${suffix}-x`));";
  const root = makeFixtureRepo({
    "test/tricky.test.ts": ["import { mkdtempSync } from 'node:fs';", tricky].join("\n"),
    [ALLOWLIST_PATH]: "# no exemptions yet\n",
  });
  const err: string[] = [];
  assert.equal(main({ repoRoot: root, out: () => {}, err: (s) => err.push(s) }), 1);

  const advised = /add `([^`]+)` to/.exec(err.join("\n"));
  assert.ok(advised, `the refusal must name the key to add; got:\n${err.join("\n")}`);
  assert.equal(advised[1], "test/tricky.test.ts:bare-", "the advised key must use the STATIC head, not the raw template text");

  writeAll(root, { [ALLOWLIST_PATH]: `${advised[1]}  # exempt\n` });
  assert.equal(scanRepo(root).refused.length, 0, "following the message's own advice must silence the refusal");
});

test("W1-T2786 rekey: the retired private regex in formatRefusal disagreed with the classifier — the shared extractor is load-bearing", () => {
  // The pre-W1-T2786 message regex was /^join\(\s*tmpdir\(\)\s*,\s*(['"`])([^'"`]{0,60})\1/,
  // which for this template captured the RAW body `bare-${suffix}-x`, while the key would have
  // been built from the static head `bare-`. Two extractors, two answers, one unfollowable
  // instruction. This asserts the surviving extractor gives the head.
  const arg = "join(tmpdir(), `bare-${suffix}-x`)";
  const retired = /^join\s*\(\s*tmpdir\s*\(\s*\)\s*,\s*(['"`])([^'"`]{0,60})\1/.exec(arg);
  assert.equal(retired?.[2], "bare-${suffix}-x", "the retired regex really did capture the raw template body");
  assert.equal(mkdtempPrefixOf(arg), "bare-", "the shared extractor gives the static head instead");
  assert.notEqual(retired?.[2], mkdtempPrefixOf(arg), "the two disagree — which is why only one may survive");

  const msg = formatRefusal({ file: "test/tricky.test.ts", line: 2, arg, prefix: mkdtempPrefixOf(arg) });
  assert.ok(msg.includes("`test/tricky.test.ts:bare-`"), `the message must quote the shared key; got: ${msg}`);
});

// ── criterion 6: the migrated allowlist, against the REAL repo ────────────────────────────────

test("W1-T2786 rekey: the migrated allowlist leaves the checker clean on an unmodified tree", () => {
  const out: string[] = [];
  const err: string[] = [];
  const rc = main({ repoRoot: REPO_ROOT, out: (s) => out.push(s), err: (s) => err.push(s) });
  assert.equal(rc, 0, `the real tree must be clean under the migrated allowlist; refusals:\n${err.join("\n")}`);
  assert.match(out.join("\n"), /clean — \d+ tracked \.ts\/\.mjs file\(s\)/);
});

test("W1-T2786 rekey: every migrated entry names a prefix that actually occurs at a callsite in the file it names", () => {
  // The migration derived from OBSERVATION — a scan with an empty allowlist, taking the
  // scanner's own refusal set. This is the independent check on that: no entry may name a
  // prefix the file does not actually produce, which is what a migration that RESOLVED
  // `<file>:<line>` against the tree would have written for every already-drifted entry.
  const entries = [...mod.loadAllowlist(REPO_ROOT)];
  assert.ok(entries.length > 100, `the real allowlist must be loaded for this to mean anything; got ${entries.length}`);

  const byFile = new Map<string, string[]>();
  for (const entry of entries) {
    const cut = entry.indexOf(":");
    assert.notEqual(cut, -1, `every entry must carry a prefix half: ${entry}`);
    const file = entry.slice(0, cut);
    const prefix = entry.slice(cut + 1);
    assert.notEqual(prefix, "", `an empty prefix names nothing: ${entry}`);
    assert.ok(!/^\d+$/.test(prefix), `a purely numeric prefix is a retired <file>:<line> entry, not a prefix: ${entry}`);
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file)!.push(prefix);
  }

  const orphans: string[] = [];
  for (const [file, prefixes] of byFile) {
    let text: string;
    try {
      text = readFileSync(join(REPO_ROOT, file), "utf8");
    } catch {
      orphans.push(`${file}: allowlisted file does not exist`);
      continue;
    }
    const observed = new Set(scanFile(text).map((r) => r.prefix));
    for (const prefix of prefixes) {
      if (!observed.has(prefix)) orphans.push(allowlistKey(file, prefix));
    }
  }
  assert.deepEqual(orphans, [], `every entry must name a prefix the file really produces; orphans:\n${orphans.join("\n")}`);
});
