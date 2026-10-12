/**
 * test/the-image-drift-watchdog-watches-the-worker-sdk.test.ts — W1-T5367.
 *
 * W1-T5018 (#8748) taught acr-build.yml's "Decide whether this push needs a new image" guard to
 * build when `packages['node_modules/@anthropic-ai/claude-agent-sdk']`'s version or integrity
 * moves (or the entry is added or removed), because the image's `/app` install bakes that SDK.
 * The host watchdog's drift reading in src/lib/deployer.ts still watched only the playwright-core
 * pin, so an SDK-only bump built and tagged an image the deployer read as ZERO drift and never
 * recycled onto. These tests pin the deployer to the same field the workflow reads.
 *
 * Namespace import: the new symbols are read off the module object, so a missing export fails the
 * assertion that needs it instead of failing the whole file at link time.
 */
import assert from "node:assert/strict";
import test from "node:test";

import * as deployer from "../src/lib/deployer.js";

const SDK_KEY = "node_modules/@anthropic-ai/claude-agent-sdk";

interface LockSpec {
  playwright?: string;
  sdk?: { version: string; integrity: string } | undefined;
  leftPad?: string;
}

function lockfile(spec: LockSpec): string {
  return JSON.stringify({
    packages: {
      "": { name: "remudero" },
      "node_modules/left-pad": { version: spec.leftPad ?? "1.0.0" },
      ...(spec.playwright === undefined ? {} : { "node_modules/playwright-core": { version: spec.playwright } }),
      ...(spec.sdk === undefined ? {} : { [SDK_KEY]: { version: spec.sdk.version, integrity: spec.sdk.integrity } }),
    },
  });
}

const SDK_OLD = { version: "0.2.10", integrity: "sha512-old" };
const SDK_NEW = { version: "0.2.11", integrity: "sha512-new" };

const BASE = lockfile({ playwright: "1.40.0", sdk: SDK_OLD });
const UNRELATED = lockfile({ playwright: "1.40.0", sdk: SDK_OLD, leftPad: "1.0.1" });
const SDK_BUMP = lockfile({ playwright: "1.40.0", sdk: SDK_NEW });

// ── the pure comparison: the same field the workflow guard reads ─────────────────────────────

test("W1-T5367: workerSdkChanged reads the worker SDK's version+integrity and nothing else in the lockfile", () => {
  const changed = deployer.workerSdkChanged;
  assert.equal(typeof changed, "function", "deployer exports workerSdkChanged");
  assert.equal(changed(BASE, SDK_BUMP), true, "a version+integrity move is a change");
  assert.equal(
    changed(BASE, lockfile({ playwright: "1.40.0", sdk: { version: SDK_OLD.version, integrity: "sha512-respun" } })),
    true,
    "an integrity-only move is a change (the workflow compares both fields)",
  );
  assert.equal(changed(BASE, UNRELATED), false, "unrelated lockfile churn is not a change");
  assert.equal(changed(lockfile({ playwright: "1.40.0" }), BASE), true, "an added SDK entry is a change");
  assert.equal(changed(BASE, lockfile({ playwright: "1.40.0" })), true, "a removed SDK entry is a change");
  assert.equal(changed(lockfile({}), lockfile({ leftPad: "2.0.0" })), false, "absent on both sides is no change");
  // Fail closed: an unparseable or missing side is UNKNOWN, never a change — and never a throw.
  assert.equal(changed("not json", SDK_BUMP), false);
  assert.equal(changed(BASE, undefined), false);
  assert.equal(deployer.extractWorkerSdkPin("not json"), undefined, "unparseable reads as unknown");
  assert.equal(deployer.extractWorkerSdkPin(lockfile({})), null, "a parseable lockfile without the entry reads as absent");
  assert.equal(deployer.extractWorkerSdkPin(BASE), JSON.stringify([SDK_OLD.version, SDK_OLD.integrity]));
});

test("W1-T5367: workerSdkCommitsBehind counts an SDK move as drift, churn as none, an unreadable side as unknown", () => {
  const behind = deployer.workerSdkCommitsBehind;
  assert.equal(typeof behind, "function", "deployer exports workerSdkCommitsBehind");
  const reading = (imageLock: string, mainLock: string) => (args: readonly string[]): string => {
    if (args[0] === "show" && args[1] === "img:package-lock.json") return imageLock;
    if (args[0] === "show" && args[1] === "origin/main:package-lock.json") return mainLock;
    throw new Error(`unexpected git ${args.join(" ")}`);
  };
  assert.equal(behind("img", reading(BASE, SDK_BUMP)), 1);
  assert.equal(behind("img", reading(BASE, UNRELATED)), 0, "unrelated churn is zero, not unknown");
  assert.equal(behind("img", reading(BASE, "not json")), undefined, "an unparseable side is unknown, not zero");
  assert.equal(behind(undefined, reading(BASE, SDK_BUMP)), undefined);
  assert.equal(
    behind("img", () => {
      throw new Error("git: not a repository");
    }),
    undefined,
    "an unreadable side is unknown, not zero",
  );
});

// ── the real watchdog reading: realDeployDeps() over a fixture history ──────────────────────
//
// History of package-lock.json on origin/main, newest first:
//   sdkBump     — moves ONLY the worker SDK's version+integrity   (the last lockfile commit)
//   unrelated   — left-pad churn
//   playwright  — moves the playwright-core pin                   (the running image's build sha)
//   base        — first commit of the file
// No IMAGE_BAKED_PATHS commit lies between the image and origin/main.

const SHA = {
  sdkBump: "5".repeat(40),
  unrelated: "4".repeat(40),
  playwright: "3".repeat(40),
  base: "2".repeat(40),
  bakedOnly: "1".repeat(40),
};

const HISTORY: Record<string, string> = {
  [SHA.sdkBump]: lockfile({ playwright: "1.41.0", sdk: SDK_NEW, leftPad: "1.0.1" }),
  [SHA.unrelated]: lockfile({ playwright: "1.41.0", sdk: SDK_OLD, leftPad: "1.0.1" }),
  [SHA.playwright]: lockfile({ playwright: "1.41.0", sdk: SDK_OLD }),
  [SHA.base]: lockfile({ playwright: "1.40.0", sdk: SDK_OLD }),
};
const PARENT: Record<string, string | undefined> = {
  [SHA.sdkBump]: SHA.unrelated,
  [SHA.unrelated]: SHA.playwright,
  [SHA.playwright]: SHA.base,
  [SHA.base]: undefined,
};
const DISTANCE: Record<string, number> = {
  [SHA.sdkBump]: 0,
  [SHA.unrelated]: 2,
  [SHA.playwright]: 5,
  [SHA.base]: 9,
  [SHA.bakedOnly]: 12,
};

function fixtureExec(opts: { mainLock?: string; lockfileUnreadable?: boolean; bakedUnreadable?: boolean } = {}) {
  return (cmd: string, argv: string[]): string => {
    if (cmd === "docker" && argv[0] === "exec") return `${SHA.playwright}\n`;
    if (cmd !== "git") throw new Error(`unexpected exec ${cmd}`);
    const args = argv[0] === "-C" ? argv.slice(2) : argv;
    if (args[0] === "rev-list" && args[1] === "--count" && args.includes("--")) {
      if (opts.bakedUnreadable) throw new Error("git: bad revision");
      return "0\n"; // no IMAGE_BAKED_PATHS commit since the image
    }
    if (args[0] === "rev-list" && args[1] === "--count") {
      const sha = String(args[2]).replace(/\.\.origin\/main$/, "");
      return `${DISTANCE[sha]}\n`;
    }
    if (args[0] === "log" && args.includes("-1")) return `${SHA.bakedOnly}\n`;
    if (args[0] === "log") return Object.keys(HISTORY).join("\n") + "\n";
    if (args[0] === "show") {
      if (opts.lockfileUnreadable) throw new Error("git: unreadable blob");
      const [ref] = String(args[1]).split(":");
      if (ref === "origin/main") return opts.mainLock ?? HISTORY[SHA.sdkBump]!;
      if (ref?.endsWith("^")) {
        const parent = PARENT[ref.slice(0, -1)];
        if (!parent) throw new Error(`no parent for ${ref}`);
        return HISTORY[parent]!;
      }
      const content = HISTORY[String(ref)];
      if (content === undefined) throw new Error(`unknown ref ${ref}`);
      return content;
    }
    throw new Error(`unexpected git ${args.join(" ")}`);
  };
}

function fixtureDeps(execFile: (cmd: string, args: string[]) => string) {
  return deployer.realDeployDeps({
    installPath: "/repo",
    stateRoot: "/state",
    daemonLabel: "com.remudero.daemon",
    serveLabel: "com.remudero.serve",
    servePort: 4317,
    uid: 502,
    ledgerPath: "/state/ledger.ndjson",
    log: () => {},
    sleep: () => {},
    execFile,
  });
}

test("W1-T5367: a worker-SDK-only lockfile change is image drift and names that commit as the newest image input", () => {
  const deps = fixtureDeps(fixtureExec());
  const behind = deps.imageBakedCommitsBehind?.();
  assert.ok(behind !== undefined && behind > 0, `an SDK-only bump since the image is drift, got ${behind}`);
  assert.equal(
    deps.newestBakedSha?.(),
    SHA.sdkBump,
    "the newest image input is the SDK bump acr-build.yml tagged, not the older playwright commit",
  );
});

test("W1-T5367: unrelated lockfile churn since the image is no drift", () => {
  // origin/main's lockfile differs from the image's only in left-pad.
  const deps = fixtureDeps(fixtureExec({ mainLock: HISTORY[SHA.unrelated]! }));
  assert.equal(deps.imageBakedCommitsBehind?.(), 0);
});

test("W1-T5367: an unreadable lockfile side stays unknown rather than zero", () => {
  const deps = fixtureDeps(fixtureExec({ lockfileUnreadable: true, bakedUnreadable: true }));
  assert.equal(deps.imageBakedCommitsBehind?.(), undefined, "every signal unreadable is UNKNOWN, never zero");
  // One known signal is never swallowed by the others going unreadable.
  const bakedKnown = fixtureDeps(fixtureExec({ lockfileUnreadable: true }));
  assert.equal(bakedKnown.imageBakedCommitsBehind?.(), 0);
  // An unparseable origin/main lockfile is unknown for the SDK reading too — the walk still answers.
  assert.equal(deployer.workerSdkCommitsBehind?.(SHA.playwright, (args) => (args[1]?.startsWith("origin/main") ? "{" : HISTORY[SHA.playwright]!)), undefined);
});
