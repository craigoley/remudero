// test/config-fixture-path-parity.test.ts — W1-T2414: the fixture-config-path trap that dies
// only on CI.
//
// THE DEFECT (measured on #3126's sha `21a9f3d0`): a fixture redirects `process.env.HOME`,
// reaches `loadConfig`/`configPath`, but hand-rolls its seeded `config.json` at `.remudero/`
// instead of `.config/remudero/` — the ONE path `configPath()` itself resolves. With the file
// absent at the real path, `loadConfig` takes its `created` branch, which shells
// `resolveClaudeBin()` (`execFileSync("which", ["claude"])`). Every developer host has that
// binary; a CI runner does not. The fixture passes everywhere it is written and fails only where
// it is judged, with a failure text — `Command failed: which claude` — that names nothing about a
// config path, a HOME redirect, or a fixture.
//
// TWO REMEDIES, BOTH OWNED HERE (the task's rationale left the choice open; the acceptance list
// below settled it — both are cheap, orthogonal, and neither substitutes for the other):
//   (b) a static CENSUS — `findFixtureConfigPathViolations` in src/lib/config.ts — over every
//       fixture that redirects HOME and reaches loadConfig/configPath, catching a wrong path at
//       authoring time. It only catches fixtures that IMPORT nothing special; a hand-rolled path
//       it does not recognise still slips through.
//   (c) `resolveClaudeBin`'s failure now names `configPath()` and which branch of `loadConfig`
//       entered it — the one remedy that still helps when a fixture defeats (b) anyway, because
//       every route to the failure passes through `resolveClaudeBin`. It changes no control flow,
//       no return type, and the eager call stays eager (LEARNINGS.md lazy-config-in-ci is about
//       OTHER callers of loadConfig, not this one; the rationale explicitly refuses making
//       loadConfig itself lazy as out of scope).
//
// THIS FILE VERIFIES BOTH, is itself host-independent, and — the discipline (c)'s own rationale
// insists on — never stubs the `claude` binary: the "no binary" condition below is produced by
// removing whatever REAL `claude` executables already sit on PATH, the same measurement method
// the task's own census used, never by faking one.

import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  configPath,
  findFixtureConfigPathViolations,
  loadConfig,
  renderFixtureConfigPathViolation,
  type FixtureConfigPathViolation,
} from "../src/lib/config.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── (b) THE CENSUS: real repo tree ────────────────────────────────────────────────────────────

test("CENSUS: every existing test/ fixture that seeds a config for loadConfig writes it where configPath resolves", () => {
  // MEASURED at filing time (4d0d0ccc): zero fixtures are actually at risk today — #3126's own
  // instance was already repaired (0b26058c) before this task landed. This test is the ratchet
  // that keeps that zero from silently regressing the next time someone hand-rolls a fixture.
  // THIS FILE ITSELF IS EXCLUDED: its BAD_FIXTURE/etc. constants below are STRING LITERALS that
  // deliberately embed the wrong-path shape as DATA, to pin the detector's own behaviour (the
  // synthetic tests just below this one). A text-based census cannot tell "adversarial fixture
  // living inside a template-literal string" from "adversarial fixture living inside real test
  // code" — that is why this file is the one self-referential exception, not a loophole in what
  // the real census covers.
  const SELF = "test/config-fixture-path-parity.test.ts";
  const tracked = execFileSync("git", ["-C", REPO_ROOT, "ls-files", "test"], { encoding: "utf8" })
    .split("\n")
    .filter((f) => f.endsWith(".test.ts") && f !== SELF);
  assert.ok(tracked.length > 100, "the sweep must actually see the real test/ population, not an empty glob");
  const files = tracked.map((path) => ({
    path,
    content: readFileSync(join(REPO_ROOT, path), "utf8"),
  }));
  const violations = findFixtureConfigPathViolations(files);
  assert.deepEqual(
    violations,
    [],
    violations.map(renderFixtureConfigPathViolation).join("\n") ||
      "a hit here is a fixture that will pass on this host and die only on a runner with no `claude` binary",
  );
});

// ── (b) THE CENSUS: synthetic fixtures, so the check's own behaviour is pinned ───────────────

const BAD_FIXTURE = `
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/lib/config.js";

function fixtureHome() {
  const home = mkdtempSync(join(tmpdir(), "rmd-bad-fixture-"));
  const root = join(home, "Remudero");
  mkdirSync(join(home, ".remudero"), { recursive: true });
  writeFileSync(join(home, ".remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root }));
  return home;
}

test("uses loadConfig against a hand-rolled home", () => {
  process.env.HOME = fixtureHome();
  loadConfig();
});
`;

const GOOD_FIXTURE_DIRECT = `
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/lib/config.js";

function fixtureHome() {
  const home = mkdtempSync(join(tmpdir(), "rmd-good-fixture-"));
  const root = join(home, "Remudero");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root }));
  return home;
}

test("uses loadConfig against a correctly-seeded home", () => {
  process.env.HOME = fixtureHome();
  loadConfig();
});
`;

// The exact shape test/feedback-landing.test.ts and test/install-checkout-command.test.ts use —
// the config dir built once and reused, rather than the literal segments spelled inline at the
// write site. A checker that only pattern-matches the inline shape would false-positive on both.
const GOOD_FIXTURE_INDIRECTED = `
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/lib/config.js";

function seed(home) {
  const configDir = join(home, ".config", "remudero");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "config.json"), JSON.stringify({ claudeBin: "/bin/true" }));
}

test("uses loadConfig via an indirected config dir variable", () => {
  process.env.HOME = "/tmp/whatever";
  seed("/tmp/whatever");
  loadConfig();
});
`;

const NO_CONFIG_FIXTURE = `
import { loadConfig } from "../src/lib/config.js";

test("redirects HOME and reaches loadConfig but never seeds any config file itself", () => {
  process.env.HOME = "/tmp/ambient-only";
  loadConfig(); // relies on whatever is already on disk at that HOME — writes nothing here
});
`;

const NO_HOME_REDIRECT_FIXTURE = `
import { loadConfig } from "../src/lib/config.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function seed(dir) {
  mkdirSync(join(dir, ".remudero"), { recursive: true });
  writeFileSync(join(dir, ".remudero", "config.json"), "{}"); // never redirects HOME, so out of scope
}

test("seeds a wrong-shaped config.json but never touches process.env.HOME", () => {
  seed("/tmp/unrelated");
  loadConfig();
});
`;

const NO_LOADCONFIG_FIXTURE = `
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

test("redirects HOME and writes a .remudero artifact that is not a config for loadConfig at all", () => {
  process.env.HOME = "/tmp/mounts-only";
  mkdirSync(join("/tmp/mounts-only", ".remudero"), { recursive: true });
  writeFileSync(join("/tmp/mounts-only", ".remudero", "mounts.yaml"), "mounts: []\\n"); // config.json never appears
});
`;

test("the parity check fails when a fixture seeds the legacy .remudero home", () => {
  const violations = findFixtureConfigPathViolations([{ path: "test/fake-bad.test.ts", content: BAD_FIXTURE }]);
  assert.equal(violations.length, 1, "exactly the one wrong-path seed must be reported");
  assert.equal(violations[0]?.expected, ".config/remudero/config.json");
  assert.equal(violations[0]?.found, ".remudero/config.json");
});

test("the check names the offending file and the path it expected", () => {
  const [v] = findFixtureConfigPathViolations([{ path: "test/fake-bad.test.ts", content: BAD_FIXTURE }]);
  assert.ok(v, "the bad fixture above must produce a violation for this to test anything");
  const rendered = renderFixtureConfigPathViolation(v as FixtureConfigPathViolation);
  assert.match(rendered, /test\/fake-bad\.test\.ts/, "the offending FILE must be named");
  assert.match(rendered, /\.config\/remudero\/config\.json/, "the path configPath\\(\\) expected must be named");
  assert.match(rendered, /\.remudero\/config\.json/, "and what the fixture actually wrote must be named too");
});

test("a fixture that redirects HOME and reaches loadConfig but seeds no config file at all is never reported", () => {
  const violations = findFixtureConfigPathViolations([
    { path: "test/fake-no-config.test.ts", content: NO_CONFIG_FIXTURE },
  ]);
  assert.deepEqual(violations, []);
});

test("a correctly-seeded fixture (direct literal path) is never reported", () => {
  assert.deepEqual(
    findFixtureConfigPathViolations([{ path: "test/fake-good-direct.test.ts", content: GOOD_FIXTURE_DIRECT }]),
    [],
  );
});

test("a correctly-seeded fixture via an indirected configDir variable is never reported (the false-positive this check must not make)", () => {
  assert.deepEqual(
    findFixtureConfigPathViolations([{ path: "test/fake-good-indirected.test.ts", content: GOOD_FIXTURE_INDIRECTED }]),
    [],
  );
});

test("a fixture that seeds a wrong-shaped config.json but never redirects HOME is out of scope, not reported", () => {
  // Cannot reach resolveClaudeBin through THIS seam without a HOME redirect — reporting it would
  // be a false positive on a fixture aimed at some other machine's real config.
  assert.deepEqual(
    findFixtureConfigPathViolations([{ path: "test/fake-no-home.test.ts", content: NO_HOME_REDIRECT_FIXTURE }]),
    [],
  );
});

test("a fixture that seeds a .remudero artifact but never calls loadConfig/configPath is out of scope, not reported", () => {
  // The exact shape W1-T2414's own census found: 5 `.remudero` writers that seed a wholly
  // different artifact (mounts.yaml) and reference loadConfig zero times.
  assert.deepEqual(
    findFixtureConfigPathViolations([{ path: "test/fake-mounts-only.test.ts", content: NO_LOADCONFIG_FIXTURE }]),
    [],
  );
});

// ── (c) resolveClaudeBin's failure names the config path it was reached from ────────────────
//
// NEVER STUBS THE BINARY: the helper below strips only PATH entries that hold a REAL, already-
// resolvable `claude` executable (verified before AND after), so on a host that has one the
// absence is genuine, and on a host (CI) that never had one the block below is a no-op and the
// existing absence is used as-is — either way, `execFileSync("which", ["claude"])` still runs for
// real. Nothing is mocked, faked, or written to disk.

function claudeIsOnPath(): boolean {
  try {
    execFileSync("which", ["claude"], { encoding: "utf8" }).trim();
    return true;
  } catch {
    return false;
  }
}

function withoutClaudeOnPath<T>(fn: () => T): T {
  const savedPath = process.env.PATH;
  const before = claudeIsOnPath();
  const dirs = (savedPath ?? "").split(delimiter).filter(Boolean);
  const stripped = dirs.filter((dir) => {
    try {
      return !existsSync(join(dir, "claude"));
    } catch {
      return true;
    }
  });
  assert.ok(
    !before || stripped.length < dirs.length,
    "if claude is resolvable, this must actually remove at least one PATH entry that provides it",
  );
  process.env.PATH = stripped.join(delimiter);
  try {
    assert.equal(claudeIsOnPath(), false, "the real `which claude` must genuinely fail under the stripped PATH");
    return fn();
  } finally {
    process.env.PATH = savedPath;
    if (before) assert.equal(claudeIsOnPath(), true, "restoring PATH must restore the REAL binary — nothing was stubbed");
  }
}

function fixtureHomeWithNoConfig(): string {
  return mkdtempSync(join(tmpdir(), "rmd-config-parity-nobin-"));
}

test("the claude lookup failure names the config path it was reached from", () => {
  const home = fixtureHomeWithNoConfig();
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  try {
    withoutClaudeOnPath(() => {
      const expectedPath = configPath();
      assert.throws(
        () => loadConfig(),
        (err: unknown) => {
          assert.ok(err instanceof Error, "loadConfig must still throw an Error, not swallow it");
          assert.match(
            (err as Error).message,
            new RegExp(escapeRegExp(expectedPath)),
            "the failure must name the config path it was reached from, not just `which claude`",
          );
          assert.match(
            (err as Error).message,
            /creation was entered/,
            "and it must say creation (not the read/fallback path) was what reached for the binary",
          );
          return true;
        },
      );
    });
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  }
});

// ── (c) the config read stays eager ──────────────────────────────────────────────────────────

test("loadConfig's creation branch still calls resolveClaudeBin unconditionally — the eager read did not become lazy", () => {
  // A regression guard on the diff's own promise: (c) changes no control flow. If a future edit
  // ever gates this behind a lazy getter or defers it past the `created` branch, this must catch
  // it — the rationale explicitly refuses making loadConfig lazy as a separate, larger change.
  const source = readFileSync(join(REPO_ROOT, "src/lib/config.ts"), "utf8");
  const createdBranch = /if \(result\.created\) \{([\s\S]*?)\n {2}\}\n/.exec(source);
  assert.ok(createdBranch, "loadConfig's `if (result.created)` branch must still exist in this shape");
  assert.match(
    createdBranch?.[1] ?? "",
    /resolveClaudeBin\(/,
    "creation must still call resolveClaudeBin unconditionally, not behind a lazy seam",
  );
});
