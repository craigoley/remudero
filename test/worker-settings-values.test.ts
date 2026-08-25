import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  ALLOWED_NETWORK_DOMAINS,
  validateWorkerSettings,
  WorkerSettingsError,
} from "../src/lib/settings.js";
import { renderWorkerSettings } from "../src/lib/worker.js";

// W1-T2243 — THE WORKER TEMPLATE'S SECURITY-CRITICAL VALUES ARE UNASSERTED WHILE ITS KEYS ARE
// PINNED. `validateWorkerSettings` already pins WHICH keys may exist (SANDBOX_KEYS /
// NETWORK_KEYS / FILESYSTEM_KEYS, checkKeys) and enforces three booleans/emptiness invariants,
// but nothing asserted WHICH domains `sandbox.network.allowedDomains` may hold — so a changed
// egress list, or an added `api.anthropic.com`, passed every gate the fleet has. This file
// exercises the new membership check added to `validateWorkerSettings` in src/lib/settings.ts.

const WORKER_SETTINGS_TEMPLATE_PATH = new URL("../settings/worker.json", import.meta.url).pathname;

function readWorkerSettingsTemplate(): Record<string, unknown> {
  return JSON.parse(readFileSync(WORKER_SETTINGS_TEMPLATE_PATH, "utf8"));
}

/** A minimal, otherwise-valid settings object — mirrors test/settings.test.ts's own GOOD
 * fixture shape so these tests exercise real validateWorkerSettings preconditions, not an
 * injected shortcut. */
function baseSettings(): Record<string, unknown> {
  return {
    permissions: { deny: [], allow: [], ask: [] },
    hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "x" }] }] },
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      network: { allowedDomains: [...ALLOWED_NETWORK_DOMAINS] },
    },
  };
}

// ── ACCEPTANCE 1: a changed allowed-domain list is refused before any worker spawns ───────────

test("ACCEPTANCE 1: a changed allowed-domain list (an unapproved domain swapped in) is refused", () => {
  const settings = baseSettings() as { sandbox: { network: { allowedDomains: string[] } } };
  settings.sandbox.network.allowedDomains = [
    "github.com",
    "api.github.com",
    "codeload.github.com",
    "evil.example.com", // registry.npmjs.org replaced — a "changed" egress list
  ];
  assert.throws(
    () => validateWorkerSettings(settings),
    (e: unknown) =>
      e instanceof WorkerSettingsError &&
      /evil\.example\.com/.test((e as Error).message) &&
      /allowedDomains/.test((e as Error).message),
    "a domain outside the pinned allowlist must be refused, naming the offending domain",
  );
});

// ── ACCEPTANCE 2: the four allowed domains still validate unchanged ───────────────────────────

test("ACCEPTANCE 2: the committed template's four allowed domains still validate unchanged", () => {
  const template = readWorkerSettingsTemplate();
  assert.doesNotThrow(() => validateWorkerSettings(template));
  const domains = (template as { sandbox: { network: { allowedDomains: string[] } } }).sandbox
    .network.allowedDomains;
  assert.deepEqual(
    [...domains].sort(),
    [...ALLOWED_NETWORK_DOMAINS].sort(),
    "the template's live domain list must be exactly the pinned allowlist — proves the pin " +
      "tracks the template rather than an independent, driftable copy",
  );
});

test("ACCEPTANCE 2: a subset of the allowlist (fewer domains) still validates", () => {
  const settings = baseSettings() as { sandbox: { network: { allowedDomains: string[] } } };
  settings.sandbox.network.allowedDomains = ["github.com"];
  assert.doesNotThrow(() => validateWorkerSettings(settings));
});

// ── ACCEPTANCE 3: an added anthropic api domain is refused rather than admitted ────────────────

test("ACCEPTANCE 3: adding api.anthropic.com to the template's own domain list is refused", () => {
  const settings = baseSettings() as { sandbox: { network: { allowedDomains: string[] } } };
  settings.sandbox.network.allowedDomains = [...ALLOWED_NETWORK_DOMAINS, "api.anthropic.com"];
  assert.throws(
    () => validateWorkerSettings(settings),
    (e: unknown) =>
      e instanceof WorkerSettingsError && /api\.anthropic\.com/.test((e as Error).message),
    "api.anthropic.com must be refused by name, not merely absent by convention",
  );
});

test("ACCEPTANCE 3: api.anthropic.com is not itself a member of the pinned allowlist", () => {
  assert.ok(
    !ALLOWED_NETWORK_DOMAINS.includes("api.anthropic.com"),
    "the pinned allowlist itself must never carry the model-API domain",
  );
});

// ── ACCEPTANCE 4: the existing unknown-key refusals behave exactly as they do today ────────────

test("ACCEPTANCE 4: unknown sandbox key is still rejected, unaffected by the new domain check", () => {
  const settings = baseSettings() as Record<string, unknown> & {
    sandbox: Record<string, unknown>;
  };
  settings.sandbox.bogusKey = true;
  assert.throws(() => validateWorkerSettings(settings), WorkerSettingsError);
});

test("ACCEPTANCE 4: allowedDomains misplaced at the sandbox root is still the WS-0 silent-drop refusal, not the new domain check", () => {
  const settings = baseSettings() as { sandbox: Record<string, unknown> };
  delete (settings.sandbox as { network?: unknown }).network;
  settings.sandbox.allowedDomains = [...ALLOWED_NETWORK_DOMAINS]; // approved values, wrong place
  assert.throws(
    () => validateWorkerSettings(settings),
    (e: unknown) =>
      e instanceof WorkerSettingsError &&
      /sandbox\.network/.test((e as Error).message) &&
      /allowedDomains/.test((e as Error).message),
    "even an APPROVED domain list must still be refused when misplaced — the key check runs first",
  );
});

test("ACCEPTANCE 4: unknown key inside sandbox.network is still rejected", () => {
  const settings = baseSettings() as { sandbox: { network: Record<string, unknown> } };
  settings.sandbox.network.bogusNetworkKey = true;
  assert.throws(() => validateWorkerSettings(settings), WorkerSettingsError);
});

// ── ACCEPTANCE 5: the two sandbox boolean invariants still refuse when either is flipped ───────

test("ACCEPTANCE 5: sandbox.enabled = false is still refused", () => {
  const settings = baseSettings() as { sandbox: { enabled: boolean } };
  settings.sandbox.enabled = false;
  assert.throws(() => validateWorkerSettings(settings), WorkerSettingsError);
});

test("ACCEPTANCE 5: sandbox.failIfUnavailable = false is still refused", () => {
  const settings = baseSettings() as { sandbox: { failIfUnavailable: boolean } };
  settings.sandbox.failIfUnavailable = false;
  assert.throws(() => validateWorkerSettings(settings), WorkerSettingsError);
});

// ── ACCEPTANCE 6: the assertion reads the same on a rendered file from any hooks path ──────────

test("ACCEPTANCE 6: the domain assertion reads identically on the RENDERED template, across different hooks paths", () => {
  const roots = [
    mkdtempSync(join(tmpdir(), "rmd-w1-t2243-render-a-")),
    mkdtempSync(join(tmpdir(), "rmd-w1-t2243-render-b-")),
  ];
  try {
    const hooksDirs = [join(roots[0], "hooks-one"), join(roots[1], "some", "very", "different", "hooks", "dir")];
    const renderedDomainLists = hooksDirs.map((hooksDir, i) => {
      const settingsFile = renderWorkerSettings({
        templatePath: WORKER_SETTINGS_TEMPLATE_PATH,
        hooksDir,
        outPath: join(roots[i], "worker.json"),
      });
      const rendered = JSON.parse(readFileSync(settingsFile, "utf8"));
      assert.doesNotThrow(
        () => validateWorkerSettings(rendered),
        `rendered settings must still validate with hooksDir=${hooksDir}`,
      );
      return rendered.sandbox.network.allowedDomains;
    });
    assert.deepEqual(
      renderedDomainLists[0],
      renderedDomainLists[1],
      "the domain list must be identical regardless of hooksDir — ${HOOKS_DIR} substitution " +
        "never touches sandbox.network, so the assertion's verdict cannot depend on the host",
    );
    // And the rendered domain list is unaffected by an unapproved swap: prove the check would
    // still fire post-render, not merely pre-render on the raw template string.
    const tampered = JSON.parse(readFileSync(join(roots[0], "worker.json"), "utf8"));
    tampered.sandbox.network.allowedDomains = ["not-approved.example.com"];
    assert.throws(() => validateWorkerSettings(tampered), WorkerSettingsError);
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
});
