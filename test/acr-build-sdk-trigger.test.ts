/**
 * test/acr-build-sdk-trigger.test.ts — W1-T5018.
 *
 * The image's `/app` `npm ci` installs the worker SDK (`@anthropic-ai/claude-agent-sdk`) from the
 * ROOT `package-lock.json`. W1-T4061 made that lockfile a trigger path but gated the actual build on
 * the playwright-core pin alone, so an SDK-only bump skipped the build and left the running fleet
 * behind the tested code.
 *
 * These tests do not grep the guard — they EXECUTE it: the "Decide whether this push needs a new
 * image" step's own `run:` script, lifted out of acr-build.yml, runs under bash in a throwaway git
 * repo whose two commits are the `before` and `after` of a push, and the test reads the
 * `build=` line it writes to `$GITHUB_OUTPUT`.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { parse as parseYaml } from "yaml";
import { gitRepo } from "./helpers/git-repo.js";

const REPO_ROOT = join(import.meta.dirname, "..");
const SDK_KEY = "node_modules/@anthropic-ai/claude-agent-sdk";

interface GuardStep {
  name?: string;
  run?: string;
}

function guardScript(): string {
  const doc = parseYaml(readFileSync(join(REPO_ROOT, ".github", "workflows", "acr-build.yml"), "utf8")) as {
    jobs?: { build?: { steps?: GuardStep[] } };
  };
  const step = doc.jobs?.build?.steps?.find((s) => s.name === "Decide whether this push needs a new image");
  assert.ok(step?.run, "the image guard step must exist and carry a run script");
  return step.run;
}

interface SdkEntry {
  version: string;
  integrity: string;
}

function lockfile(sdk: SdkEntry | undefined, opts: { leftPad?: string; playwright?: string } = {}): string {
  return JSON.stringify(
    {
      name: "remudero",
      lockfileVersion: 3,
      packages: {
        "": { name: "remudero" },
        "node_modules/left-pad": { version: opts.leftPad ?? "1.0.0", integrity: `sha512-leftpad-${opts.leftPad ?? "1.0.0"}` },
        "node_modules/playwright-core": { version: opts.playwright ?? "1.40.0" },
        ...(sdk === undefined ? {} : { [SDK_KEY]: { version: sdk.version, integrity: sdk.integrity } }),
      },
    },
    null,
    2,
  );
}

const SDK_OLD: SdkEntry = { version: "0.3.284", integrity: "sha512-old" };
const SDK_NEW: SdkEntry = { version: "0.3.285", integrity: "sha512-new" };

/** Commit `before` then `after` as the root package-lock.json and run the real guard step. */
function guardSays(before: string, after: string, extraChangedFile?: string): string {
  const repo = gitRepo({ seedCommit: false, kind: "acr-sdk-trigger" });
  const dir = repo.dir;
  const git = (...args: string[]): string => repo.git("-c", "commit.gpgsign=false", ...args);
  writeFileSync(join(dir, "package-lock.json"), before);
  git("add", "-A");
  git("commit", "-q", "-m", "before");
  const beforeSha = git("rev-parse", "HEAD");
  writeFileSync(join(dir, "package-lock.json"), after);
  if (extraChangedFile) {
    mkdirSync(dirname(join(dir, extraChangedFile)), { recursive: true });
    writeFileSync(join(dir, extraChangedFile), "changed\n");
  }
  git("add", "-A");
  git("commit", "-q", "--allow-empty", "-m", "after");
  const afterSha = git("rev-parse", "HEAD");

  const outputFile = join(dir, "github-output");
  writeFileSync(outputFile, "");
  execFileSync("bash", ["-c", guardScript()], {
    cwd: dir,
    env: { ...process.env, BEFORE_SHA: beforeSha, AFTER_SHA: afterSha, GITHUB_OUTPUT: outputFile },
    encoding: "utf8",
  });
  const line = readFileSync(outputFile, "utf8")
    .split("\n")
    .find((l) => l.startsWith("build="));
  assert.ok(line, "the guard must write a build= line to GITHUB_OUTPUT");
  return line.slice("build=".length);
}

test("W1-T5018: image build detects a worker SDK lockfile bump", () => {
  // An SDK-only bump (version and integrity move, nothing else in the image's inputs does).
  assert.equal(guardSays(lockfile(SDK_OLD), lockfile(SDK_NEW)), "true", "an SDK-only lockfile bump must build an image");
  // Unrelated lockfile churn: left-pad moves, the SDK and playwright-core pins do not.
  assert.equal(
    guardSays(lockfile(SDK_OLD), lockfile(SDK_OLD, { leftPad: "1.0.1" })),
    "false",
    "unrelated lockfile churn must not build an image",
  );
});

test("W1-T5018: an SDK integrity-only change still builds", () => {
  // Same version string, different tarball — a republish or registry swap is still a different SDK.
  assert.equal(guardSays(lockfile(SDK_OLD), lockfile({ ...SDK_OLD, integrity: "sha512-republished" })), "true");
});

test("W1-T5018: the SDK appearing in or disappearing from the lockfile builds", () => {
  assert.equal(guardSays(lockfile(undefined), lockfile(SDK_NEW)), "true", "SDK added");
  assert.equal(guardSays(lockfile(SDK_OLD), lockfile(undefined)), "true", "SDK removed");
});

test("W1-T5018: the playwright-core and other-baked-path triggers still build", () => {
  // W1-T4061's pin keeps working beside the SDK check.
  assert.equal(guardSays(lockfile(SDK_OLD), lockfile(SDK_OLD, { playwright: "1.41.0" })), "true");
  // Any other watched path builds unconditionally, whatever the lockfile did.
  assert.equal(guardSays(lockfile(SDK_OLD), lockfile(SDK_OLD), ".dockerignore"), "true");
  // An unparseable lockfile on either side reads as "build": unknown never silently skips.
  assert.equal(guardSays(lockfile(SDK_OLD), "not json"), "true");
});

test("W1-T5018: the guard reads the SDK from the same lockfile key the image installs", () => {
  // The package the worker imports is the one the guard watches — a rename on either side breaks here.
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  assert.ok(pkg.dependencies?.["@anthropic-ai/claude-agent-sdk"], "the worker SDK is a runtime dependency");
  const lock = JSON.parse(readFileSync(join(REPO_ROOT, "package-lock.json"), "utf8")) as {
    packages?: Record<string, { version?: string }>;
  };
  assert.ok(lock.packages?.[SDK_KEY]?.version, `the root lockfile resolves ${SDK_KEY}`);
  assert.match(guardScript(), /node_modules\/@anthropic-ai\/claude-agent-sdk/);
});

test("the real image guard builds for a baked supervisor change and skips mounted source", () => {
  assert.equal(guardSays(lockfile(SDK_OLD), lockfile(SDK_OLD), "src/lib/serve-supervisor.ts"), "true");
  assert.equal(guardSays(lockfile(SDK_OLD), lockfile(SDK_OLD), "src/run-task.ts"), "false");
});


test("the image guard detects the supervisor loader and its Linux compiler pins", () => {
  for (const name of ["tsx", "esbuild", "@esbuild/linux-x64"]) {
    const before = JSON.parse(lockfile(SDK_OLD));
    const after = JSON.parse(lockfile(SDK_OLD));
    before.packages[`node_modules/${name}`] = { version: "1.0.0", integrity: "sha512-old" };
    after.packages[`node_modules/${name}`] = { version: "1.0.0", integrity: "sha512-new" };
    assert.equal(guardSays(JSON.stringify(before), JSON.stringify(after)), "true", name);
  }
});
