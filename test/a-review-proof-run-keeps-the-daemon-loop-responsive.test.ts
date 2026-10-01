import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  defaultAsyncProofSpawner,
  ensureDepsAsync,
  execWhitelistedProofAsync,
  judgeReview,
  judgeReviewAsync,
  parseWhitelistedProof,
  ProofCannotLoadError,
  refreshProofToolchainAsync,
  registerReviewerCheckout,
  resetBrowserPreflightForTests,
  resolveNameFilteredCandidatesAsync,
} from "../src/lib/review.js";
import { assertWallClockBound } from "./helpers/wall-clock-bound.js";
import { discriminateReviewReuseAsync } from "../src/lib/sweep.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-async-review-proof-"));
  mkdirSync(join(dir, "test"));
  mkdirSync(join(dir, "test", "setup"));
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "package.json"), '{"type":"module"}\n');
  writeFileSync(join(dir, "test", "setup", "tmp-hygiene.ts"), "// isolated proof fixture\n");
  symlinkSync(join(root, "node_modules"), join(dir, "node_modules"), "dir");
  return dir;
}

function installFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-async-review-install-"));
  writeFileSync(join(dir, "package.json"), '{"name":"async-proof-fixture","version":"1.0.0"}\n');
  writeFileSync(join(dir, "package-lock.json"),
    '{"name":"async-proof-fixture","version":"1.0.0","lockfileVersion":3,"packages":{"":{"name":"async-proof-fixture","version":"1.0.0"}}}\n');
  return dir;
}

function isolatedInstallFixture(): { parent: string; dir: string } {
  const parent = mkdtempSync(join(tmpdir(), "rmd-async-review-isolated-"));
  const dir = join(parent, "checkout");
  mkdirSync(dir);
  writeFileSync(join(dir, "package.json"), '{"name":"async-proof-fixture","version":"1.0.0"}\n');
  writeFileSync(join(dir, "package-lock.json"),
    '{"name":"async-proof-fixture","version":"1.0.0","lockfileVersion":3,"packages":{"":{"name":"async-proof-fixture","version":"1.0.0"}}}\n');
  return { parent, dir };
}

const browserManifest = JSON.stringify({
  browsers: [{ name: "chromium", revision: "1234", installByDefault: true }],
});
const browserTap = "TAP version 13\n1..1\nok 1 - browser proof\n# tests 1\n# pass 1\n# fail 0\n# duration_ms 1\n";

function browserFixture(manifest: string | undefined, cliSource = "process.exit(0);\n"): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-async-browser-"));
  mkdirSync(join(dir, "test"));
  mkdirSync(join(dir, "node_modules", "playwright-core"), { recursive: true });
  mkdirSync(join(dir, "node_modules", "playwright"));
  writeFileSync(join(dir, "package.json"), '{"type":"module"}\n');
  writeFileSync(join(dir, "test", "browser.test.ts"),
    'import { chromium } from "playwright"; test("browser proof", () => { void chromium; });\n');
  if (manifest !== undefined) writeFileSync(join(dir, "node_modules", "playwright-core", "browsers.json"), manifest);
  writeFileSync(join(dir, "node_modules", "playwright", "cli.js"), cliSource);
  return dir;
}

async function runBrowserProof(dir: string): Promise<void> {
  const proof = parseWhitelistedProof("unit test: test/browser.test.ts");
  assert.ok(proof);
  assert.equal(await execWhitelistedProofAsync(proof, dir, 2_000, async () => browserTap), "pass");
}

test("W1-T4772: a timer keeps firing while a review proof child runs", async () => {
  const dir = fixture();
  try {
    writeFileSync(join(dir, "test", "timer.test.ts"),
      'import { test } from "node:test";\n' +
      'test("async review timer proof", async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });\n');
    const criteria = [{ claim: "the async review timer proof runs", proof: "unit test: test/timer.test.ts" }];
    let ticks = 0;
    const started = Date.now();
    const timer = setInterval(() => { ticks++; }, 20);
    try {
      const verdict = await judgeReviewAsync(criteria, {
        diff: "diff --git a/src/new.ts b/src/new.ts\n+export const newValue = 1;\n",
        report: "the async review timer proof runs",
        headCheckoutDir: dir,
      });
      assert.equal(verdict.criteria[0]?.proof_exec, "executed_pass");
    } finally {
      clearInterval(timer);
    }
    assert.ok(ticks >= 5, `expected the daemon timer to fire during the proof child; saw ${ticks} ticks`);
    assertWallClockBound(Date.now() - started, 10_000, "the bounded proof fixture took too long");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T4772: an async proof run returns the same verdict as the synchronous one", async () => {
  const dir = fixture();
  const base = fixture();
  try {
    writeFileSync(join(dir, "src", "example.ts"), "export const asyncProofMarker = true;\n");
    writeFileSync(join(base, "src", "example.ts"), "export const unrelated = true;\n");
    const criterion = { claim: "the async proof marker exists", proof: "grep: asyncProofMarker in src/example.ts" };
    const criteria = [criterion, { ...criterion }];
    const evidence = {
      diff: "diff --git a/src/example.ts b/src/example.ts\n+export const asyncProofMarker = true;\n",
      report: "the async proof marker exists",
      headCheckoutDir: dir,
      baseCheckoutDir: base,
      baseIsCheckout: true,
    };
    const synchronous = judgeReview(criteria, evidence);
    const asynchronous = await judgeReviewAsync(criteria, evidence);
    assert.deepEqual(asynchronous, synchronous);
    assert.equal(asynchronous.criteria[0]?.proof_exec, "executed_pass");
    assert.equal(asynchronous.proofUniqueRuns, 2, "one head and one base run, shared by both criteria");

    writeFileSync(join(dir, "src", "example.ts"), "export const unrelated = true;\n");
    const syncFailure = judgeReview(criteria, evidence);
    const asyncFailure = await judgeReviewAsync(criteria, evidence);
    assert.deepEqual(asyncFailure, syncFailure);
    assert.equal(asyncFailure.criteria[0]?.proof_exec, "executed_fail");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(base, { recursive: true, force: true });
  }
});

test("async proof subprocess keeps clean failure distinct from timeout", async () => {
  const dir = fixture();
  try {
    writeFileSync(join(dir, "src", "example.ts"), "export const marker = true;\n");
    const proof = parseWhitelistedProof("grep: marker in src/example.ts");
    assert.ok(proof);
    assert.equal(existsSync(join(dir, "src", "example.ts")), true);
    const fail = await execWhitelistedProofAsync(proof, dir, 1_000,
      (_command, _args, cwd, timeoutMs) => defaultAsyncProofSpawner(process.execPath, ["-e", "process.exit(1)"], cwd, timeoutMs));
    assert.equal(fail, "fail");
    await assert.rejects(
      execWhitelistedProofAsync(proof, dir, 20,
        (_command, _args, cwd, timeoutMs) => defaultAsyncProofSpawner(process.execPath, ["-e", "setTimeout(() => {}, 500)"], cwd, timeoutMs)),
      (error: unknown) =>
        (error as NodeJS.ErrnoException & { signal?: string }).signal === "SIGKILL" ||
        (error as NodeJS.ErrnoException).code === "ETIMEDOUT",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("async name lookup scopes a real test proof and preserves its TAP verdict", async () => {
  const dir = fixture();
  try {
    writeFileSync(join(dir, "test", "named.test.ts"),
      'import { test } from "node:test";\n' +
      'test("named async proof", () => {});\n');
    const criteria = [{ claim: "the named async proof runs", proof: "unit test: named async proof" }];
    const verdict = await judgeReviewAsync(criteria, {
      diff: "diff --git a/src/new.ts b/src/new.ts\n+export const newValue = 1;\n",
      report: "the named async proof runs",
      headCheckoutDir: dir,
    });
    assert.equal(verdict.criteria[0]?.proof_exec, "executed_pass");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("async title lookup distinguishes absence from an interpolated declaration", async () => {
  const dir = fixture();
  try {
    writeFileSync(join(dir, "test", "profiles.test.ts"),
      'test(`profile coverage: \'${profile}\' is accepted and produces stable output`, () => {});\n');
    assert.deepEqual(await resolveNameFilteredCandidatesAsync(dir, "a title absent from every test"), { status: "absent" });
    assert.deepEqual(
      await resolveNameFilteredCandidatesAsync(dir, "profile coverage: 'alpha' is accepted and produces stable output"),
      { status: "unresolvable", reason: "an interpolated test title could render to this name" },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("async Vitest proofs scope matching files and refuse an empty suite", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-async-vitest-"));
  const target = { owner: "craigoley", repo: "remudero-site" };
  try {
    mkdirSync(join(dir, "tests"));
    const proof = parseWhitelistedProof("unit test: alpha passes", target);
    assert.ok(proof);
    assert.equal(await execWhitelistedProofAsync(proof, dir, 1_000), "no-match");

    mkdirSync(join(dir, "node_modules", "vitest"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "vitest", "vitest.mjs"), "");
    writeFileSync(join(dir, "tests", "alpha.test.ts"), 'test("alpha passes", () => {});\n');
    const tap = "TAP version 13\n1..1\nok 1 - tests/alpha.test.ts # time=3ms {\n" +
      "    1..1\n    ok 1 - alpha passes # time=1ms\n}\n";
    const outcome = await execWhitelistedProofAsync(proof, dir, 1_000, async (_command, args) => {
      assert.ok(args.includes("tests/alpha.test.ts"));
      return tap;
    }, { preflightBrowsers: () => {} });
    assert.equal(outcome, "pass");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("async dependency priming and staged refresh spawn the package command off-loop", async () => {
  const priming = installFixture();
  const refresh = installFixture();
  const fakeBin = mkdtempSync(join(tmpdir(), "rmd-async-review-bin-"));
  writeFileSync(join(fakeBin, "npm"), "#!/bin/sh\nsleep 0.15\nmkdir -p node_modules\n", { mode: 0o755 });
  const previousPath = process.env.PATH;
  process.env.PATH = `${fakeBin}:${previousPath ?? ""}`;
  try {
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 20);
    try {
      const runner = join(priming, "node_modules");
      assert.deepEqual(await Promise.all([ensureDepsAsync(priming, runner), ensureDepsAsync(priming, runner)]), [true, true]);
      registerReviewerCheckout(refresh);
      assert.equal(await refreshProofToolchainAsync(refresh), true);
    } finally {
      clearInterval(timer);
    }
    assert.ok(ticks >= 5, `package children blocked the timer: ${ticks} ticks`);
    assert.equal(existsSync(join(priming, "node_modules")), true);
    assert.equal(existsSync(join(refresh, "node_modules")), true);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    rmSync(priming, { recursive: true, force: true });
    rmSync(refresh, { recursive: true, force: true });
    rmSync(fakeBin, { recursive: true, force: true });
  }
});

test("async browser preflight treats a missing manifest as unreadable", async () => {
  const dir = browserFixture(undefined);
  const cache = mkdtempSync(join(tmpdir(), "rmd-async-browser-cache-"));
  const previous = process.env.PLAYWRIGHT_BROWSERS_PATH;
  process.env.PLAYWRIGHT_BROWSERS_PATH = cache;
  try {
    resetBrowserPreflightForTests();
    await runBrowserProof(dir);
  } finally {
    if (previous === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH;
    else process.env.PLAYWRIGHT_BROWSERS_PATH = previous;
    rmSync(dir, { recursive: true, force: true });
    rmSync(cache, { recursive: true, force: true });
  }
});

test("async browser preflight skips an already installed pinned browser", async () => {
  const dir = browserFixture(browserManifest, 'import { writeFileSync } from "node:fs"; writeFileSync("unexpected-install", "called");\n');
  const cache = mkdtempSync(join(tmpdir(), "rmd-async-browser-cache-"));
  const previous = process.env.PLAYWRIGHT_BROWSERS_PATH;
  process.env.PLAYWRIGHT_BROWSERS_PATH = cache;
  try {
    resetBrowserPreflightForTests();
    mkdirSync(join(cache, "chromium-1234"));
    writeFileSync(join(cache, "chromium-1234", "INSTALLATION_COMPLETE"), "done");
    await runBrowserProof(dir);
    assert.equal(existsSync(join(dir, "unexpected-install")), false);
  } finally {
    if (previous === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH;
    else process.env.PLAYWRIGHT_BROWSERS_PATH = previous;
    rmSync(dir, { recursive: true, force: true });
    rmSync(cache, { recursive: true, force: true });
  }
});

test("async browser preflight shares one in-flight install and remembers completion", async () => {
  const cache = mkdtempSync(join(tmpdir(), "rmd-async-browser-cache-"));
  const dir = browserFixture(browserManifest,
    'import { appendFileSync } from "node:fs"; appendFileSync("install-calls", "x"); setTimeout(() => process.exit(0), 120);\n');
  const previous = process.env.PLAYWRIGHT_BROWSERS_PATH;
  process.env.PLAYWRIGHT_BROWSERS_PATH = cache;
  try {
    resetBrowserPreflightForTests();
    await Promise.all([runBrowserProof(dir), runBrowserProof(dir)]);
    await runBrowserProof(dir);
    assert.equal(readFileSync(join(dir, "install-calls"), "utf8"), "x", "one pinned install serves concurrent and later proofs");
  } finally {
    if (previous === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH;
    else process.env.PLAYWRIGHT_BROWSERS_PATH = previous;
    rmSync(dir, { recursive: true, force: true });
    rmSync(cache, { recursive: true, force: true });
  }
});

test("async browser install failure stays best effort for the proof verdict", async () => {
  const cache = mkdtempSync(join(tmpdir(), "rmd-async-browser-cache-"));
  const dir = browserFixture(browserManifest, "process.exit(3);\n");
  const previous = process.env.PLAYWRIGHT_BROWSERS_PATH;
  process.env.PLAYWRIGHT_BROWSERS_PATH = cache;
  try {
    resetBrowserPreflightForTests();
    await runBrowserProof(dir);
  } finally {
    if (previous === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH;
    else process.env.PLAYWRIGHT_BROWSERS_PATH = previous;
    rmSync(dir, { recursive: true, force: true });
    rmSync(cache, { recursive: true, force: true });
  }
});

test("async staged refresh preserves the old install when its swap fails", async () => {
  const dir = installFixture();
  try {
    registerReviewerCheckout(dir);
    mkdirSync(join(dir, "node_modules"));
    writeFileSync(join(dir, "node_modules", "sentinel"), "old install");
    let renames = 0;
    const outcome = await refreshProofToolchainAsync(dir, {
      install: async (stage) => { mkdirSync(join(stage, "node_modules")); },
      rename: (from, to) => {
        renames++;
        if (renames === 2) throw new Error("swap refused");
        renameSync(from, to);
      },
    });
    assert.equal(outcome, false);
    assert.equal(readFileSync(join(dir, "node_modules", "sentinel"), "utf8"), "old install");
    assert.equal(renames, 3, "the rollback restored the original tree");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("async staged refresh resolves shared installs, honors their hash marker, and refuses broken links", async () => {
  const { parent, dir: canonical } = isolatedInstallFixture();
  const checkout = join(parent, "review-head");
  const dangling = join(parent, "dangling-head");
  const unreadable = isolatedInstallFixture();
  try {
    mkdirSync(checkout);
    mkdirSync(join(canonical, "node_modules"));
    symlinkSync(join(canonical, "node_modules"), join(checkout, "node_modules"), "dir");
    registerReviewerCheckout(checkout);
    assert.equal(await refreshProofToolchainAsync(checkout, {
      install: async (stage) => { mkdirSync(join(stage, "node_modules")); },
    }), true);
    assert.equal(await refreshProofToolchainAsync(checkout, {
      install: async () => { throw new Error("a fresh shared install must not run twice"); },
    }), false, "the installed hash marker prevents a second refresh");

    mkdirSync(dangling);
    symlinkSync(join(parent, "missing-install"), join(dangling, "node_modules"), "dir");
    registerReviewerCheckout(dangling);
    assert.equal(await refreshProofToolchainAsync(dangling), false);

    const unreadableHead = join(unreadable.parent, "review-head");
    mkdirSync(unreadableHead);
    mkdirSync(join(unreadable.dir, "node_modules"));
    mkdirSync(join(unreadable.dir, "node_modules", ".rmd-install-hash"));
    symlinkSync(join(unreadable.dir, "node_modules"), join(unreadableHead, "node_modules"), "dir");
    registerReviewerCheckout(unreadableHead);
    assert.equal(await refreshProofToolchainAsync(unreadableHead), false, "an unreadable marker cannot certify freshness");
  } finally {
    rmSync(parent, { recursive: true, force: true });
    rmSync(unreadable.parent, { recursive: true, force: true });
  }
});

test("async staged refresh records failed install and preserves old modules when rollback fails", async () => {
  const failedInstall = isolatedInstallFixture();
  const rollback = isolatedInstallFixture();
  try {
    registerReviewerCheckout(failedInstall.dir);
    assert.equal(await refreshProofToolchainAsync(failedInstall.dir, {
      install: async () => { throw new Error("offline install"); },
    }), false);

    registerReviewerCheckout(rollback.dir);
    mkdirSync(join(rollback.dir, "node_modules"));
    writeFileSync(join(rollback.dir, "node_modules", "sentinel"), "old install");
    let renames = 0;
    assert.equal(await refreshProofToolchainAsync(rollback.dir, {
      install: async (stage) => { mkdirSync(join(stage, "node_modules")); },
      rename: (from, to) => {
        renames++;
        if (renames >= 2) throw new Error("swap and rollback refused");
        renameSync(from, to);
      },
    }), false);
    assert.equal(renames, 3);
    const backups = readdirSync(rollback.parent).filter((name) => name.startsWith(".rmd-review-old-"));
    assert.equal(backups.length, 1, "the old tree is kept when rollback cannot restore it");
    assert.equal(readFileSync(join(rollback.parent, backups[0]!, "node_modules", "sentinel"), "utf8"), "old install");
  } finally {
    rmSync(failedInstall.parent, { recursive: true, force: true });
    rmSync(rollback.parent, { recursive: true, force: true });
  }
});

test("async staged refresh reports cleanup failures without discarding the installed tree", async () => {
  const { parent, dir } = isolatedInstallFixture();
  try {
    registerReviewerCheckout(dir);
    mkdirSync(join(dir, "node_modules"));
    let cleanupCalls = 0;
    assert.equal(await refreshProofToolchainAsync(dir, {
      install: async (stage) => { mkdirSync(join(stage, "node_modules")); },
      remove: () => { cleanupCalls++; throw new Error("cleanup refused"); },
    }), true);
    assert.equal(cleanupCalls, 2, "both staging and old-install cleanup were attempted");
    assert.equal(existsSync(join(dir, "node_modules", ".rmd-install-hash")), true);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("async name-filtered load failure refreshes once before reporting cannot-load", async () => {
  const dir = fixture();
  try {
    writeFileSync(join(dir, "test", "load.test.ts"), 'test("async load proof", () => {});\n');
    const proof = parseWhitelistedProof("unit test: async load proof");
    assert.ok(proof);
    const stdout = "TAP version 13\nnot ok 1 - test/load.test.ts\n" +
      "  error: Cannot find module 'missing-dep'\n# tests 1\n# fail 1\n# duration_ms 12\n";
    let runs = 0;
    let refreshes = 0;
    await assert.rejects(
      execWhitelistedProofAsync(proof, dir, 1_000, async () => {
        runs++;
        throw Object.assign(new Error("module load failed"), { status: 1, stdout, stderr: "" });
      }, {
        preflightBrowsers: () => {},
        refreshToolchain: () => { refreshes++; },
      }),
      ProofCannotLoadError,
    );
    assert.equal(runs, 2);
    assert.equal(refreshes, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sweep reuse awaits head and base proof observations", async () => {
  const head = fixture();
  const base = fixture();
  try {
    writeFileSync(join(head, "src", "example.ts"), "export const reuseProofMarker = true;\n");
    writeFileSync(join(base, "src", "example.ts"), "export const unrelated = true;\n");
    const criteria = [{ claim: "reuse proof marker exists", proof: "grep: reuseProofMarker in src/example.ts" }];
    const diff = "diff --git a/src/example.ts b/src/example.ts\n+export const reuseProofMarker = true;\n";
    const report = "reuse proof marker exists";
    const prior = judgeReview(criteria, { diff, report, headCheckoutDir: head });
    const result = await discriminateReviewReuseAsync({
      prior, diff, report, headCheckoutDir: head, baseCheckoutDir: base, baseIsCheckout: true,
    });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.verdict.criteria[0]?.proof_exec, "executed_pass");
  } finally {
    rmSync(head, { recursive: true, force: true });
    rmSync(base, { recursive: true, force: true });
  }
});
