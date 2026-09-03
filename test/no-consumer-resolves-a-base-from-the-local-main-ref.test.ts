import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// ── W1-T2630: NO CONSUMER RESOLVES A BASE FROM THE LOCAL `main` REF ─────────────────────────
//
// THE CLAIM UNDER TEST (docs/base-ref-contract.md carries the same claim for humans): every base
// this repository's executable surface resolves for a diff is origin-tracking (`origin/main`),
// event-supplied (a PR `BASE_SHA`/`GITHUB_BASE_REF` read after an explicit fetch), caller-supplied
// (an explicit `--base` argument), or a remote-API branch-name argument that never touches a local
// ref. NONE of them reads the local `main` ref this checkout's `git rev-list --count main..
// origin/main` measured 1898 commits behind at filing (MASTER-PLAN's standing note: this drifts
// ~100 commits/cycle and nothing is SUPPOSED to fast-forward it — see docs/base-ref-contract.md
// for the full ruling). A stale ref nobody reads is inert; this file is the falsifiable proof that
// nobody reads it, not a fix for the drift itself.
//
// THE DISCRIMINATOR IS POSITION, NEVER THE WORD "main". A guard that flags every source-text
// occurrence of the string "main" would redden this very file, `MASTER-PLAN.md`'s standing note,
// and dozens of comments discussing exactly this defect class (W1-T81's lesson: a check matching
// surface text where it means to match a property produces false positives that train authors to
// write around it). So `scanSource` below only looks at the REF OPERAND of six git subcommands —
// `diff`, `log`, `merge-base`, `rev-list`, `rev-parse`, `show` — the only positions a "diff base"
// can be read from. A bare `main` (or `refs/heads/main`) in one of those slots is LOCAL-REF; a
// `main` anywhere else in the source text — a forge `--base` argument, a `-b main`/`-b main`
// branch-creation flag, a `branch === "main"` string compare, a `default_branch ?? "main"` remote-
// API fallback, or plain prose — is not even LOOKED AT, because it never occupies that slot.
//
// THE GUARD READS FILES AND NEVER INVOKES GIT (criterion 3). `scanSource`/`scanRepo` below are
// pure string scans over `readFileSync` text — no `child_process`, no `execFile`, no `spawn`
// anywhere in this file. That is what lets the "no git command runs" test below assert real
// behaviour (a `PATH` with no `git` on it) rather than merely re-reading this comment.
//
// SCOPE IS THE EXECUTABLE SURFACE ONLY: src/, scripts/, hooks/, .github/, deploy/. `deploy/` is
// included even though the design note's own illustrative list names only the first four —
// the task's rationale explicitly flags `deploy/` as swept-by-this-task ("hooks/, deploy/, the
// remaining workflow files... were NOT swept" is the stated gap this task closes), and
// `deploy/entrypoint.sh` / `deploy/recycle-container.sh` both run real git diffs against a
// checkout at boot, so leaving the directory out would be exactly the kind of unstated scope this
// task's own acceptance criterion 4 refuses. `plan/` and prose docs are deliberately EXCLUDED —
// they legitimately discuss `main` at length (this file among them) and gating on prose would
// redden every plan PR, the same trap design note "SCOPE IS EXECUTABLE SURFACE ONLY" names.
//
// THE ALLOWLIST IS DATA (criterion 2's second half). `ALLOWLIST` below is an array of
// `{ file, line, reason }` rows, empty for the real repository because the sweep this test also
// runs (last test in this file) found zero live LOCAL-REF consumers to admit. It stays typed and
// exported so that IF a future legitimate shape ever needs one, admitting it is a one-line row
// carrying a reason, never a loosened regex — proven mechanically by the "allowlist is DATA" test,
// which seeds two byte-identical offending fixtures at different paths, allowlists only one, and
// asserts the sibling still fails.

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

/** The only six git subcommands that ever supply a diff BASE. Checkout, branch, clone, fetch,
 *  push, etc. are deliberately absent — see the header comment's "position, never the word". */
const BASE_SUBCOMMANDS = new Set(["diff", "log", "merge-base", "rev-list", "rev-parse", "show"]);

/** Directories that make up the executable surface this guard scans. */
const SCAN_DIRS = ["src", "scripts", "hooks", ".github", "deploy"];

const EXCLUDED_DIR_NAMES = new Set(["node_modules", ".git", "dist", "build", "coverage"]);

/** Extensions using `//` / `/* *\/` comment syntax — comments are stripped before scanning so a
 *  comment discussing this exact defect class (of which this repo has many) is never mistaken for
 *  an invocation. */
const JS_COMMENT_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

/** Extensions using `#` comment syntax (shell scripts, and YAML — workflow `run:` blocks embed
 *  shell under `#` comments too). */
const SHELL_COMMENT_EXTENSIONS = new Set([".sh", ".yml", ".yaml"]);

const SCANNED_EXTENSIONS = new Set([...JS_COMMENT_EXTENSIONS, ...SHELL_COMMENT_EXTENSIONS]);

export interface AllowlistRow {
  /** Repo-relative path (posix separators), matched exactly against the finding's file. */
  file: string;
  /** 1-indexed line the finding was reported at, matched exactly. */
  line: number;
  /** WHY this specific occurrence is not a live consumer — required, never blank. */
  reason: string;
}

/** EMPTY FOR THE REAL REPO. See header comment "THE ALLOWLIST IS DATA". A finding here is refused
 *  by scanRepo's own caller unless a row names it — there is no wildcard/regex-loosening form. */
export const ALLOWLIST: AllowlistRow[] = [];

export interface Finding {
  file: string;
  line: number;
  subcommand: string;
  snippet: string;
}

/** Blanks `/* *\/` block comments (preserving newlines, so line numbers do not shift) and `//...`
 *  line comments (unless preceded by `:`, so `https://` survives). */
function stripJsComments(text: string): string {
  const noBlocks = text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  return noBlocks
    .split("\n")
    .map((line) => line.replace(/(?<!:)\/\/.*$/, ""))
    .join("\n");
}

/** Blanks `#...` shell/YAML comments — either the whole line (optionally indented) or anything
 *  after a `#` preceded by whitespace, which covers the `local x=1  # why` shape too. */
function stripShellComments(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/(^|\s)#.*$/, "$1"))
    .join("\n");
}

function lineNumberAt(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

function lineTextAt(text: string, lineNumber: number): string {
  return text.split("\n")[lineNumber - 1]?.trim() ?? "";
}

/** True when `token` — one whitespace-delimited shell word, or one JS array-literal string
 *  element — names the LOCAL `main` ref as one component of a (possibly two/three-dot) range, or
 *  as a `ref:path` show target. `origin/main`, `refs/remotes/origin/main`, and anything else
 *  carrying a `/` before `main` is EXCLUDED by construction (only an exact `main` or
 *  `refs/heads/main` component counts as local). Flags (leading `-`) are never refs. */
function isLocalMainRefToken(token: string): boolean {
  if (token.startsWith("-")) return false;
  const rangeParts = token.split(/\.\.\.|\.\./);
  for (const raw of rangeParts) {
    const part = raw.split(":")[0];
    if (part === "main" || part === "refs/heads/main") return true;
  }
  return false;
}

/** Detects `execFile(Sync)?`/`spawn(Sync)?`-shaped invocations: a quoted `"git"` argument
 *  immediately followed by an array-literal argv. Only the SUBCOMMAND'S OWN array is inspected —
 *  a label string passed before it (e.g. `shellOut(spawn, "git fetch origin main (...)", "git",
 *  ["fetch", "origin", "main"], ...)`) is prose to this scanner and is never matched as `"git"`
 *  itself, so it cannot manufacture a false hit. */
function scanArrayLiteralInvocations(codeText: string, relPath: string): Finding[] {
  const findings: Finding[] = [];
  const invocationRe = /["'`]git["'`]\s*,\s*\[([\s\S]*?)\]/g;
  let m: RegExpExecArray | null;
  while ((m = invocationRe.exec(codeText))) {
    const argvText = m[1];
    const tokens: string[] = [];
    const tokenRe = /["'`]([^"'`]*)["'`]/g;
    let t: RegExpExecArray | null;
    while ((t = tokenRe.exec(argvText))) tokens.push(t[1]);
    const subIdx = tokens.findIndex((tok) => BASE_SUBCOMMANDS.has(tok));
    if (subIdx === -1) continue;
    const subcommand = tokens[subIdx];
    for (const tok of tokens.slice(subIdx + 1)) {
      if (isLocalMainRefToken(tok)) {
        const line = lineNumberAt(codeText, m.index);
        findings.push({ file: relPath, line, subcommand, snippet: lineTextAt(codeText, line) });
        break; // one finding per invocation is enough to name the offending path+position
      }
    }
  }
  return findings;
}

/** Detects shell-syntax invocations: the literal word `git`, optional flags (including the
 *  two-token `-C <dir>` form every `-C`-scoped call in this repo uses), one of the six BASE
 *  subcommands, then a bare `main`/`refs/heads/main` ref token anywhere in the remainder of that
 *  line. Runs over EVERY scanned extension (not only `.sh`/`.yml`) so a shell command embedded in
 *  a JS template literal would still be caught. */
function scanShellLikeInvocations(codeText: string, relPath: string): Finding[] {
  const findings: Finding[] = [];
  const lines = codeText.split("\n");
  const cmdRe = /\bgit(?:\s+-C\s+\S+|\s+-\S+|\s+--\S+)*\s+(diff|log|merge-base|rev-list|rev-parse|show)\b(.*)$/;
  lines.forEach((line, idx) => {
    const m = cmdRe.exec(line);
    if (!m) return;
    const subcommand = m[1];
    const rest = m[2];
    const tokens = rest.trim().split(/\s+/).filter(Boolean);
    for (const tok of tokens) {
      if (isLocalMainRefToken(tok)) {
        findings.push({ file: relPath, line: idx + 1, subcommand, snippet: line.trim() });
        break;
      }
    }
  });
  return findings;
}

/** Pure scan of one file's already-read text — no fs, no git, unit-testable on a bare string. */
export function scanSource(text: string, relPath: string): Finding[] {
  const dot = relPath.lastIndexOf(".");
  const ext = dot === -1 ? "" : relPath.slice(dot);
  const codeText = JS_COMMENT_EXTENSIONS.has(ext)
    ? stripJsComments(text)
    : SHELL_COMMENT_EXTENSIONS.has(ext)
      ? stripShellComments(text)
      : text;
  return [...scanArrayLiteralInvocations(codeText, relPath), ...scanShellLikeInvocations(codeText, relPath)];
}

function walk(dir: string, relRoot: string, out: Array<{ abs: string; rel: string }>): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT" || (err as NodeJS.ErrnoException).code === "ENOTDIR") return;
    throw err;
  }
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    const rel = relRoot ? `${relRoot}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;
      walk(abs, rel, out);
    } else if (entry.isFile()) {
      const dot = entry.name.lastIndexOf(".");
      const ext = dot === -1 ? "" : entry.name.slice(dot);
      if (SCANNED_EXTENSIONS.has(ext)) out.push({ abs, rel });
    }
  }
}

/** Walks `dirs` under `repoRoot` (default: the executable-surface SCAN_DIRS), scans every file,
 *  and splits findings against `allowlist` — NEVER by loosening the pattern, only by an exact
 *  `{file, line}` row match. Reads only; invokes no git command and needs no `.git`/origin at all,
 *  which is what makes it safe to run over an arbitrary temp fixture directory. */
export function scanRepo(
  repoRoot: string,
  dirs: string[] = SCAN_DIRS,
  allowlist: AllowlistRow[] = ALLOWLIST,
): { findings: Finding[]; allowed: Array<Finding & { reason: string }>; filesScanned: number } {
  const files: Array<{ abs: string; rel: string }> = [];
  for (const dir of dirs) walk(join(repoRoot, dir), dir, files);

  const findings: Finding[] = [];
  const allowed: Array<Finding & { reason: string }> = [];
  for (const { abs, rel } of files) {
    const text = readFileSync(abs, "utf8");
    for (const finding of scanSource(text, rel)) {
      const row = allowlist.find((r) => r.file === finding.file && r.line === finding.line);
      if (row) allowed.push({ ...finding, reason: row.reason });
      else findings.push(finding);
    }
  }
  return { findings, allowed, filesScanned: files.length };
}

// ── fixtures ──────────────────────────────────────────────────────────────────────────────────

let fixtureDirs: string[] = [];

function mkFixtureDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "base-ref-guard-fixture-"));
  fixtureDirs.push(dir);
  return dir;
}

function writeFixture(root: string, subdirRelToScanDir: string, name: string, content: string): void {
  const full = join(root, subdirRelToScanDir);
  mkdirSync(full, { recursive: true });
  writeFileSync(join(full, name), content, "utf8");
}

test.after(() => {
  for (const dir of fixtureDirs) rmSync(dir, { recursive: true, force: true });
  fixtureDirs = [];
});

test("a bare local `main` in a git base position is flagged, naming the offending path and position — two-dot, three-dot, JS argv and shell forms all fail", () => {
  const root = mkFixtureDir();
  writeFixture(
    root,
    "src",
    "bare-diff.ts",
    'export function f(cwd: string) {\n  return execFileSync("git", ["-C", cwd, "diff", "main"], { encoding: "utf8" });\n}\n',
  );
  writeFixture(
    root,
    "scripts",
    "bare-two-dot.sh",
    '#!/bin/sh\ngit -C "$TREE" log HEAD..main\n',
  );
  writeFixture(
    root,
    "hooks",
    "bare-three-dot.sh",
    '#!/bin/sh\ngit diff main...HEAD\n',
  );
  writeFixture(
    root,
    "src",
    "bare-merge-base.ts",
    'const mb = execFileSync("git", ["merge-base", "main", "HEAD"], { encoding: "utf8" });\n',
  );

  const { findings, filesScanned } = scanRepo(root);

  assert.equal(filesScanned, 4);
  assert.equal(findings.length, 4, `expected one finding per fixture, got: ${JSON.stringify(findings)}`);

  const byFile = new Map(findings.map((f) => [f.file, f]));
  assert.equal(byFile.get("src/bare-diff.ts")?.subcommand, "diff");
  assert.equal(byFile.get("scripts/bare-two-dot.sh")?.subcommand, "log");
  assert.equal(byFile.get("hooks/bare-three-dot.sh")?.subcommand, "diff");
  assert.equal(byFile.get("src/bare-merge-base.ts")?.subcommand, "merge-base");
  // The position is named, not just "somewhere in the file":
  assert.equal(byFile.get("scripts/bare-two-dot.sh")?.line, 2);
  assert.equal(byFile.get("hooks/bare-three-dot.sh")?.line, 2);
});

test("the guard does NOT fire on the legitimate non-ref uses of the word — forge --base, branch-name compare, clone -b, remote-API branch arg", () => {
  const root = mkFixtureDir();
  // (a) a forge base argument — `gh`, not `git`, and not one of the six subcommands either way.
  writeFixture(root, "src", "forge-base.ts", 'const cmd = "gh pr create --fill --base main";\n');
  // (b) a branch-name comparison — a plain string compare, no git invocation at all.
  writeFixture(root, "scripts", "branch-compare.mjs", 'if (branch === "main") { skip(); }\n');
  // (c) a clone branch flag / init branch flag — "clone"/"init" are not BASE_SUBCOMMANDS.
  writeFixture(
    root,
    "src",
    "clone-branch-flag.ts",
    'execFileSync("git", ["clone", "--quiet", "-b", "main", originUrl, path]);\n',
  );
  writeFixture(root, "deploy", "init-branch-flag.sh", "#!/bin/sh\ngit init -q -b main .\n");
  // (d) a remote-API branch argument — no git invocation, just a JSON field fallback.
  writeFixture(
    root,
    "src",
    "remote-api-fallback.ts",
    'const defaultBranch = metadata?.default_branch ?? "main";\n',
  );

  const { findings } = scanRepo(root);

  assert.deepEqual(findings, [], `expected zero findings on legitimate shapes, got: ${JSON.stringify(findings)}`);
});

test("the allowlist is DATA — an explicit {file, line, reason} row suppresses exactly that occurrence while a byte-identical sibling at a different path still fails", () => {
  const root = mkFixtureDir();
  const offendingLine = 'execFileSync("git", ["diff", "main"], { encoding: "utf8" });\n';
  writeFixture(root, "src", "allowlisted.ts", offendingLine);
  writeFixture(root, "src", "not-allowlisted.ts", offendingLine);

  const customAllowlist: AllowlistRow[] = [
    { file: "src/allowlisted.ts", line: 1, reason: "TEST FIXTURE ONLY — proves the row mechanism, not a real exemption" },
  ];

  const { findings, allowed } = scanRepo(root, SCAN_DIRS, customAllowlist);

  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.file, "src/not-allowlisted.ts");
  assert.equal(allowed.length, 1);
  assert.equal(allowed[0]?.file, "src/allowlisted.ts");
  assert.match(allowed[0]?.reason ?? "", /TEST FIXTURE ONLY/);

  // Widening the PATTERN, rather than adding a row, is not how this suppresses a finding — an
  // allowlist keyed on {file, line} cannot accidentally cover a different file's identical text.
  assert.notEqual(findings[0]?.file, customAllowlist[0]?.file);
});

test("the guard is a static source scan — it invokes no git command and needs no origin remote", () => {
  const root = mkFixtureDir(); // note: NOT `git init`ed. If scanRepo shelled out to git this
  // would already fail with "not a git repository" rather than a clean empty result.
  writeFixture(root, "src", "clean.ts", 'export const x = 1;\n');

  const originalPath = process.env.PATH;
  try {
    // A PATH with no directories on it cannot resolve a `git` binary — if scanRepo (or anything
    // it calls) ever shells out, this line is what turns that into a loud ENOENT instead of a
    // silently-passing assumption.
    process.env.PATH = "";
    const result = scanRepo(root);
    assert.deepEqual(result.findings, []);
    assert.equal(result.filesScanned, 1);
  } finally {
    process.env.PATH = originalPath;
  }
});

test("the real repository's executable surface (src/, scripts/, hooks/, .github/, deploy/) has zero unallowlisted local-main findings", () => {
  const { findings, filesScanned } = scanRepo(REPO_ROOT);

  assert.ok(filesScanned > 100, `scan looks vacuous — only ${filesScanned} files scanned`);
  assert.deepEqual(
    findings,
    [],
    `LOCAL-REF consumer(s) found — see docs/base-ref-contract.md for the ruling this must uphold: ${JSON.stringify(findings, null, 2)}`,
  );
});
