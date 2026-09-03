/**
 * THE THIRD POLE: the containerised daemon host, which used to report as `ci`.
 *
 * `scripts/host-parity.ts` decided the pole with `process.platform === "darwin" ? "mini" : "ci"`,
 * under a comment that lumped the two remaining cases together in as many words — *"Anything else
 * running this is a runner or a container, and its failure set belongs to the OTHER side of the
 * diff."* A runner and a container are not the same side. MEASURED on the Azure container at
 * `3a5c677`: 16 failures diffed against a `ci` baseline whose single entry is none of them.
 *
 * THIS FILE IS HOST-INDEPENDENT, like its sibling and for the same reason: a parity checker whose
 * own fixtures borrow the ambient environment would be the next instance of the defect it exists to
 * find. `resolveHostPole` takes platform, env and the container marker as ARGUMENTS — nothing here
 * reads `process.platform`, `process.env` or the filesystem.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HOST_PARITY_BASELINE, diffHostParity, resolveHostPole } from "../src/lib/host-parity.js";
import { HOST_CAUSED_SUITE_REDS } from "../src/lib/ci-parity.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// ── resolveHostPole, every branch, both directions ───────────────────────────────────────────

test("a container that is NOT a CI runner resolves to azure — the case that used to answer ci", () => {
  assert.equal(resolveHostPole({ platform: "linux", env: {}, inContainer: true }), "azure");
});

test("THE OTHER DIRECTION: a linux host with no container marker still resolves to ci, unchanged", () => {
  // The falsifier for "just return azure on linux". The fallback is deliberately untouched, so a
  // developer's bare box reports exactly what it reported before this function existed.
  assert.equal(resolveHostPole({ platform: "linux", env: {}, inContainer: false }), "ci");
});

test("darwin is still the mini, container marker or not — the judge's pole is decided first", () => {
  assert.equal(resolveHostPole({ platform: "darwin", env: {}, inContainer: false }), "mini");
  assert.equal(resolveHostPole({ platform: "darwin", env: {}, inContainer: true }), "mini");
});

test("ORDER TRAP: a CI job running INSIDE a container is ci, never azure", () => {
  // A GitHub job configured with `container:` carries /.dockerenv, but its failure set is the one
  // the ci baseline describes. Testing the marker before the CI env would silently reclassify every
  // containerised CI job as azure and empty the ci pole.
  assert.equal(resolveHostPole({ platform: "linux", env: { CI: "true" }, inContainer: true }), "ci");
  assert.equal(
    resolveHostPole({ platform: "linux", env: { GITHUB_ACTIONS: "true" }, inContainer: true }),
    "ci",
  );
});

test("the CI predicate matches isCiEnv's falsiness rules — '', '0' and 'false' are NOT CI", () => {
  // Duplicated from lib/self-sync.ts's isCiEnv rather than imported (this module has no imports at
  // all). This test is what keeps the copy honest; if it ever drifts, isCiEnv is the authority.
  for (const v of ["", "0", "false", "FALSE"]) {
    assert.equal(
      resolveHostPole({ platform: "linux", env: { CI: v }, inContainer: true }),
      "azure",
      `CI=${JSON.stringify(v)} is not truthy, so the container marker decides`,
    );
  }
  assert.equal(resolveHostPole({ platform: "linux", env: { CI: "1" }, inContainer: false }), "ci");
});

// ── the pole actually scopes the diff ────────────────────────────────────────────────────────

test("an azure run is diffed against azure's OWN declared set, not the mini's or ci's", () => {
  // The mini's four entries and ci's one must not silence — or be reported as healed by — an azure
  // run. That scoping is the whole reason the pole field exists.
  const miniEntry = HOST_PARITY_BASELINE.find((d) => d.pole === "mini");
  assert.ok(miniEntry, "fixture assumption: the baseline still declares at least one mini entry");
  const diff = diffHostParity({ observed: [miniEntry.test], pole: "azure" });
  assert.deepEqual(diff.undeclared, [miniEntry.test], "a mini entry observed on azure is a FINDING");
  assert.deepEqual(diff.healed, [], "and no mini entry is reported healed by an azure run");
  assert.deepEqual(diff.declaredSeen, []);
});

test("azure declares NOTHING today, and that is asserted rather than assumed", () => {
  // 14 of the 16 measured failures are `jq` missing from the image — a dependency defect fixed in
  // deploy/, not a divergence to bless — and the other 2 are the worker-containment flake this
  // baseline's own doc refuses to declare. So the correct azure set is empty, and an entry
  // appearing here later should be a deliberate act with a reason attached.
  assert.deepEqual(HOST_PARITY_BASELINE.filter((d) => d.pole === "azure"), []);
});

test("every declared entry still carries a pole the type admits, and a non-empty reason", () => {
  for (const d of HOST_PARITY_BASELINE) {
    assert.ok(["mini", "ci", "azure"].includes(d.pole), `unknown pole: ${d.pole}`);
    assert.ok(d.reason.trim().length > 0, `${d.test} has no reason`);
  }
});

// ── the runner really uses it (the reachability half) ────────────────────────────────────────

test("REACHABILITY: scripts/host-parity.ts resolves its pole through resolveHostPole, not a ternary", () => {
  // A unit test of resolveHostPole passes just as happily while the runner keeps its old inline
  // ternary — the same consumer-wired-producer-never shape that let W1-T126 ship dead. This reads
  // the runner's source because the runner is a top-level script with no importable seam.
  const src = readFileSync(join(REPO_ROOT, "scripts", "host-parity.ts"), "utf8");
  assert.match(src, /resolveHostPole\(\{/, "the runner must call the resolver");
  assert.match(src, /inContainer:\s*existsSync\("\/\.dockerenv"\)/, "and pass the real marker");
  assert.doesNotMatch(
    src,
    /process\.platform === "darwin" \? "mini" : "ci"/,
    "the old two-pole ternary must be gone, or a container still reports as ci",
  );
});

// ── W1-T2776: the registry has to enforce its OWN completeness ────────────────────────────────
//
// THE GAP THIS CLOSES. `HOST_CAUSED_SUITE_REDS` (src/lib/ci-parity.ts) named ONE file for the
// bash-3.2 `declare -A` cluster. Eight tracked tests spawn that script the same way and red the
// same way; seven of them co-existed with the registry for hundreds of commits, unregistered, so
// their 36 measured failures read to any lane as defects in whatever diff happened to be open.
// Nothing existed that could notice — the registry is a hand-maintained list, and a NEW test
// joining an EXISTING cluster is exactly the case a hand-maintained list loses.
//
// WHY THE PREDICATE IS THIS ONE. It is not "mentions a deploy script" — ten tracked tests
// reference `deploy/recycle-container.sh` in code and only eight fail. The two that pass spawn
// it through a version-resolved bash (see `BASH_BIN` in test/container-config-mount.test.ts) or
// never spawn it at all. So the predicate is the CAUSAL one: a bash-4-only script, executed
// through the PATH `bash`, which is 3.2 on darwin. Checked against a real run of all ten files
// on 2026-09-03, it agrees on every one — no false positives, no false negatives.
//
// HOST-INDEPENDENCE. Like REACHABILITY above, this reads tracked SOURCE; it reads no host facts
// (no `process.platform`, no bash version, no live suite result), so it gives the same verdict
// on the mini, on a runner and in the container — which is the property this file's header
// paragraph is actually about.
//
// THIS IS A CENSUS TEST — CLAUDE.md hazard (j). It walks a population rather than naming
// symbols, so it can red a PR that references nothing in this file and whose author will not
// find it by grep. That is the point, and it is why the failure message below names the two
// remedies in full rather than merely reporting a violation: an unexplained census refusal is
// how a rule gets routed around instead of followed.

/** bash-4-only syntax. `declare -A` (associative arrays) is the one construct this repo's deploy
 *  scripts use that bash 3.2 rejects outright, with `declare: -A: invalid option`. */
const BASH4_ONLY_SYNTAX = /^\s*(?:local|declare|typeset)\s+-[A-Za-z]*A\b/m;

/** A spawn of a script through the PATH `bash` — the resolution that finds macOS's 3.2. A file
 *  that resolves a bash-4 binary first (test/container-config-mount.test.ts's `BASH_BIN`) does
 *  not match, and measurably does not fail. */
const BARE_BASH_SPAWN = /(?:spawnSync|spawn|execFileSync|execFile)\(\s*"bash"/;

/** Comments stripped so a file that merely DISCUSSES a script in prose — three tracked tests do,
 *  including this cluster's own registry test — is never mistaken for one that runs it. */
function codeOnly(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1 ");
}

/** TRACKED files only, via `git ls-files` — never a raw directory walk, so untracked scratch,
 *  a stale worktree artefact or another lane's uncommitted fixture can neither trip this test
 *  nor hide a real violation from it. Same discipline as scripts/mkdtemp-callsite-check.mjs. */
function trackedFiles(pattern: string): string[] {
  return execFileSync("git", ["ls-files", pattern], { cwd: REPO_ROOT, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
}

test("W1-T2776 DISCOVERY: every tracked test that spawns a bash-4-only deploy script through the system bash is registered in HOST_CAUSED_SUITE_REDS", () => {
  const scripts = trackedFiles("deploy/*.sh").filter((s) =>
    BASH4_ONLY_SYNTAX.test(readFileSync(join(REPO_ROOT, s), "utf8")),
  );
  // POSITIVE CONTROL, both halves. A zero on either walk would make the assertion below pass
  // over an empty set — the vacuous pass this whole test exists to prevent elsewhere.
  assert.ok(scripts.length > 0, "no deploy script uses bash-4-only syntax — the walk, the pattern or the corpus is wrong, not the repo");
  const testFiles = trackedFiles("test/*.test.ts");
  assert.ok(testFiles.length > 100, `the test corpus walk found only ${testFiles.length} files — git ls-files is not seeing the suite`);

  const registered = new Set(HOST_CAUSED_SUITE_REDS.map((e) => e.file));
  const matched: string[] = [];
  const unregistered: string[] = [];
  for (const file of testFiles) {
    const code = codeOnly(readFileSync(join(REPO_ROOT, file), "utf8"));
    if (!scripts.some((s) => code.includes(basename(s)))) continue;
    if (!BARE_BASH_SPAWN.test(code)) continue;
    matched.push(file);
    if (!registered.has(file)) unregistered.push(file);
  }
  assert.ok(
    matched.length > 0,
    "the predicate matched NO test file at all — it has gone blind (a spawn helper was refactored, or the script moved), which would make this test pass forever without checking anything",
  );

  assert.deepEqual(
    unregistered,
    [],
    `${unregistered.length} tracked test file(s) spawn a bash-4-only deploy script through the PATH \`bash\`, which is 3.2 on macOS, so they FAIL on every darwin host — but HOST_CAUSED_SUITE_REDS does not name them, so those failures read as defects in your diff:\n` +
      unregistered.map((f) => `  - ${f}`).join("\n") +
      `\n\nTWO REMEDIES — pick one:\n` +
      `  (a) PREFERRED: resolve a bash-4 binary before spawning, the way test/container-config-mount.test.ts does (its BASH_BIN constant). The test then passes on every host and needs no registry entry at all.\n` +
      `  (b) Register it: run the file alone, take its measured \`# fail\` count, add an entry to HOST_CAUSED_SUITE_REDS in src/lib/ci-parity.ts under cause "bash-3.2-no-associative-arrays", and add the matching row to the expected table in test/host-caused-suite-reds.test.ts.\n` +
      `Do NOT add an entry without measuring: a count that overstates the cluster absorbs a real failure into the host-caused set, which is worse than no entry at all.`,
  );
});

test("W1-T2776: the discovery predicate distinguishes RUNNING a bash-4-only script from merely mentioning one — the distinction its whole accuracy rests on", () => {
  // A unit test of the two regexes against the four shapes the real corpus contains, so a future
  // edit to either pattern fails HERE with a named cause rather than silently widening the
  // census test above into a false-positive machine (or narrowing it back into blindness).
  // SELF-MATCH GUARD. Every fixture below is assembled across a `+` seam so this file's own
  // SOURCE never contains a contiguous `spawnSync("bash"` or a bare script basename — otherwise
  // the census test above matches its own fixtures and refuses this file, which is exactly what
  // it did on first run. The RUNTIME strings are the real shapes; only the source text is
  // broken up. The same hazard as CLAUDE.md's `pkill -f` self-match rule: a scan whose corpus
  // includes the scanner needs the scanner to be unrepresentable in its own pattern.
  const SCRIPT = "recycle-container" + ".sh";
  const bareSpawn = `const S = join(R, "deploy", "${SCRIPT}");\n` + 'spawnSync(' + '"bash", [S]);';
  const resolvedSpawn =
    `const BASH_BIN = ["/opt/homebrew/opt/bash/bin/bash"].find(existsSync) ?? "bash";\n` +
    "spawnSync(BASH_BIN, [S]);";
  const sourceReadOnly = `assert.match(readFileSync(join(R, "deploy", "${SCRIPT}"), "utf8"), /x/);`;
  const proseOnly = `/${"/"} deploy/${SCRIPT} is discussed here but never run\n`;

  assert.ok(BARE_BASH_SPAWN.test(bareSpawn), "a PATH-resolved bash spawn is the failing shape");
  assert.ok(!BARE_BASH_SPAWN.test(resolvedSpawn), "a version-resolved binary must NOT be flagged — it is the remedy this test recommends");
  assert.ok(!BARE_BASH_SPAWN.test(sourceReadOnly), "reading a script's source never invokes bash");
  assert.equal(codeOnly(proseOnly).includes(SCRIPT), false, "a script named only in a comment is not a call site");
  assert.ok(BASH4_ONLY_SYNTAX.test("declare -A CAPTURED=()"), "the bash-4 construct is recognised");
  assert.ok(!BASH4_ONLY_SYNTAX.test("declare -a LIST=()"), "lowercase -a is an INDEXED array and works fine on bash 3.2");
});
