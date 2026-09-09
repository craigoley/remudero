import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { browserAbsenceAnnouncement, classifyBrowserAbsence, skipReasonFor } from "./browser-absence.js";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * W1-T3018 — AN ABSENT BROWSER READ AS A REPO FULL OF BROKEN TESTS.
 *
 * With the pinned Chromium build missing, all eleven `serve.*` suites launched anyway and emitted
 * one raw Playwright error per test. A session read that as `origin/main` being 189-red and carried
 * the false claim into two merged PR bodies; CI's own shards were green on the same commits
 * throughout. `test/serve-launch-uniformity.test.ts` records the SAME misreading being made once
 * before, during W1-T202.
 *
 * THE DANGER IS THE FIX, NOT THE DEFECT, so most of these tests point at the fix. CLAUDE.md forbids
 * skipping a test to reach green, and a skip mechanism is exactly that shape. The CI leg below is
 * the falsifier that separates this from a quarantine: without it, the two are indistinguishable.
 */

// `installByDefault: true` is load-bearing — `requiredChromiumDirs` skips anything without it, so
// a manifest missing the flag yields an EMPTY required list. Writing this fixture without it made
// every absence read as "present", which is exactly the vacuous shape the `unknown` arm now closes.
const MANIFEST = JSON.stringify({
  browsers: [
    { name: "chromium", revision: "1234", installByDefault: true },
    { name: "chromium-headless-shell", revision: "1234", installByDefault: true },
    { name: "firefox", revision: "9999", installByDefault: true },
  ],
});

/** The real measured shape: the cache holds build 1194 while the pinned Playwright wants 1234. */
const INSTALLED_1194 = (dir: string): boolean => dir.endsWith("-1194");
const INSTALLED_1234 = (dir: string): boolean => dir.endsWith("-1234");

test("a cache holding the WRONG build is classified absent, and the classification names both builds", () => {
  const a = classifyBrowserAbsence({ browsersJsonText: MANIFEST, isInstalled: INSTALLED_1194 });

  assert.equal(a.kind, "absent");
  assert.deepEqual(
    a.kind === "absent" ? a.missing : [],
    ["chromium-1234", "chromium_headless_shell-1234"],
    "only the chromium pair is required — firefox is not a dependency of these suites",
  );
  assert.match(a.reason, /1234/, "the reason must name the build that is missing");
});

test("a complete install of the pinned build is classified present", () => {
  assert.equal(classifyBrowserAbsence({ browsersJsonText: MANIFEST, isInstalled: INSTALLED_1234 }).kind, "present");
});

test("a HALF-EXTRACTED install is absent, matching the INSTALLATION_COMPLETE contract the browser preflight already relies on", () => {
  // Playwright writes that marker LAST, so a directory that exists but would fail to launch must
  // read as absent here — the same predicate `ensureBrowsers` uses, not a second hand-rolled one.
  const a = classifyBrowserAbsence({ browsersJsonText: MANIFEST, isInstalled: () => false });
  assert.equal(a.kind, "absent");
});

test("an unreadable or malformed manifest is UNKNOWN, never absent — the skip fires only on verified absence", () => {
  assert.equal(classifyBrowserAbsence({ browsersJsonText: null, isInstalled: () => false }).kind, "unknown");
  assert.equal(classifyBrowserAbsence({ browsersJsonText: "{not json", isInstalled: () => false }).kind, "unknown");
});

test("UNDER CI an absent browser produces NO skip, so nothing can reach green by way of a missing browser", () => {
  // THE FALSIFIER FOR THE WHOLE TASK. Delete this leg and the change is indistinguishable from the
  // quarantine CLAUDE.md forbids. In CI the browser is installed; if it is missing there, that is
  // the defect, and the suites must fail exactly as they do today.
  const absent = classifyBrowserAbsence({ browsersJsonText: MANIFEST, isInstalled: INSTALLED_1194 });

  assert.equal(skipReasonFor(absent, { ci: true }), undefined, "CI must never skip");
  assert.ok(skipReasonFor(absent, { ci: false }), "and an author-time host must");
});

test("an UNKNOWN classification never skips, on either host — absence must be proven, not assumed", () => {
  const unknown = classifyBrowserAbsence({ browsersJsonText: null, isInstalled: () => false });

  assert.equal(skipReasonFor(unknown, { ci: false }), undefined);
  assert.equal(skipReasonFor(unknown, { ci: true }), undefined);
});

test("a PRESENT browser never skips, so the mechanism is inert on a healthy host", () => {
  const present = classifyBrowserAbsence({ browsersJsonText: MANIFEST, isInstalled: INSTALLED_1234 });

  assert.equal(skipReasonFor(present, { ci: false }), undefined);
  assert.equal(skipReasonFor(present, { ci: true }), undefined);
});

test("the skip reason names the missing build and says the suite was SKIPPED, never that it passed", () => {
  const absent = classifyBrowserAbsence({ browsersJsonText: MANIFEST, isInstalled: INSTALLED_1194 });
  const reason = skipReasonFor(absent, { ci: false })!;

  assert.match(reason, /SKIPPED/);
  assert.match(reason, /chromium-1234/, "a reason that does not name the build cannot be acted on");
  // ASSERT THE DENIAL, not the absence of the word. A "must not mention passing" regex also
  // rejects "did NOT pass", which is the honest wording — so it would have pushed this message
  // toward saying LESS. A skip that reads as a pass converts a false red into a false green, the
  // strictly more dangerous direction, so the message must deny it in as many words.
  assert.match(reason, /did NOT pass/, "the message must say outright that the suite did not pass");
  assert.match(reason, /playwright install/, "and name the action that fixes it");
});

test("the announcement is emitted ONCE per process, so eleven suites produce one line and not eleven", () => {
  const lines: string[] = [];
  const announce = browserAbsenceAnnouncement((m) => lines.push(m));
  const reason = "SKIPPED — chromium-1234 absent";

  announce(reason);
  announce(reason);
  announce(reason);

  assert.equal(lines.length, 1, "one named announcement — the point is not to replace N errors with N lines");
  assert.equal(lines[0], reason);
});

test("a manifest naming NO chromium build is UNKNOWN, not present — an empty requirement set proves nothing", () => {
  // The vacuous-pass shape: `missing.length === 0` is true over an EMPTY required list just as it
  // is over a satisfied one, and the two mean opposite things. Found by writing this suite's own
  // fixture without `installByDefault`, which silently classified a missing browser as present.
  const noChromium = JSON.stringify({ browsers: [{ name: "firefox", revision: "9999", installByDefault: true }] });

  assert.equal(classifyBrowserAbsence({ browsersJsonText: noChromium, isInstalled: () => false }).kind, "unknown");
});

// ── WIRED, OR IT IS NOTHING ──────────────────────────────────────────────────────────────────
//
// A helper no suite imports would leave the 173 launch errors exactly where they were. This half
// is DERIVED FROM THE TREE, the same way test/serve-browser-teardown.test.ts and
// test/serve-launch-uniformity.test.ts enumerate the same population, so a seventeenth
// browser-driving suite is held to the contract the day it lands rather than opting out silently.

/** Every test file that launches a browser, by the guards' own fixed-string definition. */
function browserLaunchingSuites(): string[] {
  const tracked = execFileSync("git", ["-C", REPO_ROOT, "ls-files", "--", "test/*.test.ts"], {
    encoding: "utf8",
  });
  const launchCall = "browserPromise = chromium.launch" + "(";
  return tracked
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.endsWith("serve-launch-uniformity.test.ts"))
    .filter((l) => readFileSync(join(REPO_ROOT, l), "utf8").includes(launchCall))
    .sort();
}

/** W1-T1027's falsifier. Its whole purpose is to prove `npx playwright install chromium` produced a
 *  working browser, so an absent browser IS its finding — skipping it would delete the only thing
 *  it checks. The one file that must NOT be wired. */
const THE_FALSIFIER = "test/workflow-playwright-install.test.ts";

test("every browser-launching suite EXCEPT W1-T1027's falsifier routes its tests through the absence-aware wrapper", () => {
  const suites = browserLaunchingSuites();
  assert.ok(suites.length >= 15, `expected the browser suites to be discoverable, found ${suites.length}`);
  assert.ok(suites.includes(THE_FALSIFIER), "the falsifier must still be in the population this reasons about");

  for (const f of suites) {
    const src = readFileSync(join(REPO_ROOT, f), "utf8");
    const wired = src.includes('browserTest as test } from "./browser-absence.js"');
    if (f === THE_FALSIFIER) {
      assert.equal(wired, false, `${f} must NEVER skip on an absent browser — that absence is its finding`);
      continue;
    }
    assert.equal(wired, true, `${f}: an unwired suite still emits one launch error per test`);
    assert.ok(
      src.includes("if (BROWSER_SKIP !== undefined) return;"),
      `${f}: must not launch when every test is already registered as skipped`,
    );
  }
});

test("no browser-launching suite still imports `test` directly from node:test, which would bypass the wrapper entirely", () => {
  for (const f of browserLaunchingSuites()) {
    if (f === THE_FALSIFIER) continue;
    const src = readFileSync(join(REPO_ROOT, f), "utf8");
    const nodeTestImport = /^import \{([^}]*)\} from "node:test";$/m.exec(src);
    if (nodeTestImport === null) continue;
    const names = nodeTestImport[1]!.split(",").map((n) => n.trim());
    assert.ok(
      !names.includes("test"),
      `${f}: imports \`test\` from node:test, so its tests would run and fail rather than skip`,
    );
  }
});
