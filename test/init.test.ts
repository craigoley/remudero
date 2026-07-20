import assert from "node:assert/strict";
import { closeSync, fstatSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  InitError,
  parseTierFlag,
  readClaudeJsonKeys,
  resolveInitTier,
  runInit,
  SAFE_DEFAULT_TIER,
  writeTierIntoConfig,
} from "../src/lib/init.js";

function tmpConfigPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-init-test-"));
  return join(dir, "config.json");
}

// ── W1-T67: writeTierIntoConfig exclusive-create (mode 0o600 + createdFile + EEXIST merge) ──
// The create path is `writeFileSync(path, ..., { flag: "wx", mode: 0o600 })` — no
// existsSync-then-write TOCTOU. On a genuine first run it creates the file 0600 and
// reports createdFile=true; when the file already exists, `wx` throws EEXIST and the
// call falls through to read-merge-write, preserving every other key and reporting
// createdFile=false — never clobbering a concurrent winner's claudeBin/root.
//
// CodeQL js/file-system-race, round 2 (alert #25): asserting via `statSync(path)`
// then `readFileSync(path, ...)` is itself a check-by-name-then-use-by-name pair on
// the SAME path, which the query flags regardless of this being test code with no
// concurrent attacker. Open the file once and assert through the descriptor
// (fstatSync(fd) for the mode, readFileSync(fd, ...) for the contents) — no
// second path-string operation left for the query to correlate.
test("W1-T67: writeTierIntoConfig on genuine first run creates the file mode 0o600 and reports createdFile=true", () => {
  const path = tmpConfigPath();
  const res = writeTierIntoConfig(path, "max20x", "flag");
  assert.equal(res.createdFile, true);
  const fd = openSync(path, "r");
  try {
    assert.equal(fstatSync(fd).mode & 0o777, 0o600, "the created config must be mode 0600");
    assert.deepEqual(JSON.parse(readFileSync(fd, "utf8")), { tier: "max20x", tierSource: "flag" });
  } finally {
    closeSync(fd);
  }
});

test("W1-T67: writeTierIntoConfig when the file EXISTS falls through to merge (createdFile=false), preserving other keys — no clobber", () => {
  const path = tmpConfigPath();
  // A concurrent first-run winner already wrote a full config with claudeBin/root.
  writeFileSync(path, JSON.stringify({ claudeBin: "/opt/homebrew/bin/claude", root: "/SENTINEL/root" }, null, 2) + "\n");
  const res = writeTierIntoConfig(path, "pro", "detected");
  assert.equal(res.createdFile, false, "an existing file takes the EEXIST fallback, never the create branch");
  const merged = JSON.parse(readFileSync(path, "utf8"));
  // The exclusive-create discipline's whole point: the pre-existing keys SURVIVE the merge.
  assert.equal(merged.claudeBin, "/opt/homebrew/bin/claude");
  assert.equal(merged.root, "/SENTINEL/root");
  assert.equal(merged.tier, "pro");
  assert.equal(merged.tierSource, "detected");
});

// ── parseTierFlag ────────────────────────────────────────────────────────────

test("parseTierFlag: undefined flag ⇒ undefined (no override requested)", () => {
  assert.equal(parseTierFlag(undefined), undefined);
});

test("parseTierFlag: accepts known tiers case-insensitively", () => {
  assert.equal(parseTierFlag("max20x"), "max20x");
  assert.equal(parseTierFlag("MAX5X"), "max5x");
  assert.equal(parseTierFlag("Pro"), "pro");
});

test("parseTierFlag: throws InitError on an unknown value", () => {
  assert.throws(() => parseTierFlag("business"), InitError);
});

// ── resolveInitTier — the PURE resolution ladder ────────────────────────────

test("acceptance 1: --tier flag writes NON-INTERACTIVELY — no TTY, no confirm hook, flag always wins", async () => {
  const d = await resolveInitTier({
    tierFlag: "max20x",
    yes: true,
    isTTY: false,
    detectionInput: {}, // no evidence at all — the flag must not need it
    // confirm deliberately omitted: there is no operator, and none may be conjured.
  });
  assert.equal(d.tier, "max20x");
  assert.equal(d.source, "flag");
  assert.equal(d.prompted, false);
});

test("acceptance 2: confident detection writes WITHOUT prompting — prompt path never entered", async () => {
  let confirmCalls = 0;
  const d = await resolveInitTier({
    yes: false,
    isTTY: false, // headless, matching the fixture-driven no-TTY test described in the acceptance proof
    detectionInput: {
      claudeJson: { oauthAccount: { organizationRateLimitTier: "default_claude_max_20x" } },
    },
    confirm: () => {
      confirmCalls++;
      return "pro";
    },
  });
  assert.equal(d.tier, "max20x");
  assert.equal(d.source, "detected");
  assert.equal(d.prompted, false);
  assert.equal(confirmCalls, 0, "the prompt path must never be entered when detection is confident");
});

test("confident detection also skips the prompt with a TTY present, given --yes", async () => {
  let confirmCalls = 0;
  const d = await resolveInitTier({
    yes: true,
    isTTY: true,
    detectionInput: {
      claudeJson: { oauthAccount: { organizationRateLimitTier: "default_claude_max_5x" } },
    },
    confirm: () => {
      confirmCalls++;
      return "pro";
    },
  });
  assert.equal(d.tier, "max5x");
  assert.equal(d.source, "detected");
  assert.equal(confirmCalls, 0);
});

test("TTY present + unconfident detection + no --yes ⇒ the ONLY path that prompts", async () => {
  let confirmSuggested: string | undefined;
  const d = await resolveInitTier({
    yes: false,
    isTTY: true,
    detectionInput: {}, // insufficient evidence ⇒ unconfident
    confirm: (suggested) => {
      confirmSuggested = suggested;
      return "max20x"; // operator overrides the suggestion
    },
  });
  assert.equal(confirmSuggested, SAFE_DEFAULT_TIER);
  assert.equal(d.tier, "max20x");
  assert.equal(d.source, "prompted");
  assert.equal(d.prompted, true);
});

test("no TTY + unconfident detection ⇒ TTY-ABSENT SAFE DEFAULT, never blocks, confirm never called", async () => {
  let confirmCalls = 0;
  const d = await resolveInitTier({
    yes: false,
    isTTY: false,
    detectionInput: {},
    confirm: () => {
      confirmCalls++;
      return "max20x";
    },
  });
  assert.equal(d.tier, SAFE_DEFAULT_TIER);
  assert.equal(d.source, "tty_absent_default");
  assert.equal(d.prompted, false);
  assert.equal(confirmCalls, 0);
  assert.match(d.detail, /safe default/i);
});

test("TTY present but --yes given + unconfident detection ⇒ still the safe default, not a prompt", async () => {
  let confirmCalls = 0;
  const d = await resolveInitTier({
    yes: true,
    isTTY: true,
    detectionInput: {},
    confirm: () => {
      confirmCalls++;
      return "max20x";
    },
  });
  assert.equal(d.tier, SAFE_DEFAULT_TIER);
  assert.equal(d.source, "tty_absent_default");
  assert.equal(confirmCalls, 0);
});

test("resolveInitTier: a bad --tier flag throws InitError even with confident evidence present", async () => {
  await assert.rejects(
    () =>
      resolveInitTier({
        tierFlag: "enterprise",
        yes: true,
        isTTY: false,
        detectionInput: { claudeJson: { oauthAccount: { organizationRateLimitTier: "default_claude_max_20x" } } },
      }),
    InitError,
  );
});

// ── readClaudeJsonKeys ───────────────────────────────────────────────────────

test("readClaudeJsonKeys: absent file ⇒ undefined (best-effort, never throws)", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-init-test-"));
  assert.equal(readClaudeJsonKeys(join(dir, "nope.json")), undefined);
});

test("readClaudeJsonKeys: reads the real observed shape (W1-T9b recon)", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-init-test-"));
  const p = join(dir, "claude.json");
  writeFileSync(
    p,
    JSON.stringify({
      hasAvailableSubscription: true,
      oauthAccount: { organizationRateLimitTier: "default_claude_max_20x", organizationType: "claude_max" },
    }),
  );
  const keys = readClaudeJsonKeys(p);
  assert.equal(keys?.hasAvailableSubscription, true);
  assert.equal(keys?.oauthAccount?.organizationRateLimitTier, "default_claude_max_20x");
});

test("readClaudeJsonKeys: unparsable JSON ⇒ undefined, not a throw", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-init-test-"));
  const p = join(dir, "claude.json");
  writeFileSync(p, "{not json");
  assert.equal(readClaudeJsonKeys(p), undefined);
});

// ── writeTierIntoConfig ──────────────────────────────────────────────────────

test("writeTierIntoConfig: creates the file when absent and reports createdFile", () => {
  const p = tmpConfigPath();
  const result = writeTierIntoConfig(p, "max20x", "flag");
  assert.equal(result.createdFile, true);
  const written = JSON.parse(readFileSync(p, "utf8"));
  assert.equal(written.tier, "max20x");
  assert.equal(written.tierSource, "flag");
});

test("writeTierIntoConfig: merges into an existing config, preserving other keys", () => {
  const p = tmpConfigPath();
  writeFileSync(p, JSON.stringify({ claudeBin: "/usr/bin/claude", root: "/tmp/root" }));
  const result = writeTierIntoConfig(p, "pro", "tty_absent_default");
  assert.equal(result.createdFile, false);
  const written = JSON.parse(readFileSync(p, "utf8"));
  assert.equal(written.claudeBin, "/usr/bin/claude");
  assert.equal(written.root, "/tmp/root");
  assert.equal(written.tier, "pro");
  assert.equal(written.tierSource, "tty_absent_default");
});

// ── runInit — the end-to-end (no-TTY, no-operator) entry point ─────────────

test("acceptance 1 (end-to-end): `rmd init --tier max20x --yes` writes a valid config, no stdin/no TTY", async () => {
  const p = tmpConfigPath();
  const logs: string[] = [];
  const result = await runInit({
    tierFlag: "max20x",
    yes: true,
    isTTY: false,
    configPath: p,
    // No claudeJson/usage captured, no confirm hook — nothing an operator or a
    // live call would need to supply, exactly what a headless CLI invocation has.
    log: (l) => logs.push(l),
  });
  assert.equal(result.tier, "max20x");
  assert.equal(result.source, "flag");
  const written = JSON.parse(readFileSync(p, "utf8"));
  assert.equal(written.tier, "max20x");
  assert.equal(written.tierSource, "flag");
  assert.ok(logs.length > 0, "the resolution must be logged — never silent (§9)");
});

test("acceptance 2 (end-to-end): confident fixture detection writes without ever prompting", async () => {
  const p = tmpConfigPath();
  let confirmCalls = 0;
  const result = await runInit({
    yes: false,
    isTTY: false,
    configPath: p,
    claudeJson: { oauthAccount: { userRateLimitTier: "default_claude_max_5x" } },
    confirm: () => {
      confirmCalls++;
      return "pro";
    },
    log: () => {},
  });
  assert.equal(result.tier, "max5x");
  assert.equal(result.source, "detected");
  assert.equal(confirmCalls, 0);
  const written = JSON.parse(readFileSync(p, "utf8"));
  assert.equal(written.tier, "max5x");
});

test("runInit: a bad --tier flag returns no write — InitError propagates for the CLI to report", async () => {
  const p = tmpConfigPath();
  await assert.rejects(
    () => runInit({ tierFlag: "bogus", yes: true, isTTY: false, configPath: p }),
    InitError,
  );
});
