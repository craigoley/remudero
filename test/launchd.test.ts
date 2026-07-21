import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DAEMON_LABEL,
  DEFAULT_DIGEST_HOUR,
  DEFAULT_LAUNCHD_PATH,
  DIGEST_LABEL,
  LaunchdPlistError,
  assertNoAnthropicKeys,
  generateDigestLaunchdPlist,
  generateLaunchdPlist,
  launchdPlistPath,
} from "../src/lib/launchd.js";

const VALID = { rmdBin: "/Users/op/Remudero/bin/rmd", root: "/Users/op/Remudero" };

test("generates a well-formed plist carrying the label, absolute paths, and RunAtLoad/KeepAlive", () => {
  const plist = generateLaunchdPlist(VALID);
  assert.match(plist, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(plist, /<key>Label<\/key>\s*<string>com\.remudero\.daemon<\/string>/);
  assert.match(plist, /<string>\/Users\/op\/Remudero\/bin\/rmd<\/string>/, "the launcher's absolute path is embedded");
  assert.match(plist, /<string>daemon<\/string>/, "ProgramArguments includes the `daemon` subcommand");
  assert.match(
    plist,
    /<key>WorkingDirectory<\/key>\s*<string>\/Users\/op\/Remudero<\/string>/,
    "WorkingDirectory is the absolute workspace root",
  );
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key>/);
  assert.match(
    plist,
    /<key>StandardOutPath<\/key>\s*<string>\/Users\/op\/Remudero\/state\/logs\/daemon\.out\.log<\/string>/,
  );
  assert.match(
    plist,
    /<key>StandardErrorPath<\/key>\s*<string>\/Users\/op\/Remudero\/state\/logs\/daemon\.err\.log<\/string>/,
  );
});

test("carries an EXPLICIT PATH (launchd's own default omits /usr/local/bin and Homebrew)", () => {
  const plist = generateLaunchdPlist(VALID);
  assert.match(plist, /<key>PATH<\/key>\s*<string>[^<]*\/usr\/local\/bin[^<]*<\/string>/);
  assert.equal(DEFAULT_LAUNCHD_PATH.includes("/usr/local/bin"), true);
});

test("a caller-supplied PATH overrides the default", () => {
  const plist = generateLaunchdPlist({ ...VALID, path: "/custom/bin:/usr/bin" });
  assert.match(plist, /<string>\/custom\/bin:\/usr\/bin<\/string>/);
});

test("the ANTHROPIC-clean-env boot assertion: no ANTHROPIC_* key in the actual EnvironmentVariables dict", () => {
  const plist = generateLaunchdPlist(VALID);
  const block = plist.match(/<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/)?.[1] ?? "";
  assert.doesNotMatch(block, /ANTHROPIC_/i, "the actual env dict never carries an ANTHROPIC_* key");
  assert.match(plist, /ANTHROPIC-clean-env boot assertion/, "the comment documenting the assertion is present");
});

// ── assertNoAnthropicKeys: the ONE billing-boundary assertion BOTH generateLaunchdPlist (the
// daemon unit, W1-T12b) and generateDigestLaunchdPlist (the digest unit, W1-T112) call — exported
// specifically so a fixture can inject an ANTHROPIC_* key directly and observe the throw. ────────

test("assertNoAnthropicKeys: an injected ANTHROPIC_* key throws a LaunchdPlistError naming the survivor(s)", () => {
  assert.throws(
    () => assertNoAnthropicKeys({ PATH: "/usr/bin", HOME: "/Users/op", ANTHROPIC_API_KEY: "sneaky" }),
    (e) => e instanceof LaunchdPlistError && /billing-boundary violation/.test(e.message) && /ANTHROPIC_API_KEY/.test(e.message),
  );
});

test("assertNoAnthropicKeys: a clean {PATH, HOME} env never throws", () => {
  assert.doesNotThrow(() => assertNoAnthropicKeys({ PATH: "/usr/bin", HOME: "/Users/op" }));
});

test("assertNoAnthropicKeys: the thrown message names the CALLING generator when given a context", () => {
  assert.throws(
    () => assertNoAnthropicKeys({ ANTHROPIC_API_KEY: "sneaky" }, "generateDigestLaunchdPlist"),
    (e) => e instanceof LaunchdPlistError && e.message.startsWith("generateDigestLaunchdPlist: billing-boundary violation"),
  );
  assert.throws(
    () => assertNoAnthropicKeys({ ANTHROPIC_API_KEY: "sneaky" }),
    (e) => e instanceof LaunchdPlistError && e.message.startsWith("generateLaunchdPlist: billing-boundary violation"),
    "defaults to the daemon generator's name for backward compatibility",
  );
});

test("EnvironmentVariables is a closed allowlist: only PATH and HOME", () => {
  const plist = generateLaunchdPlist(VALID);
  const block = plist.match(/<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/)?.[1] ?? "";
  const keys = [...block.matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1]);
  assert.deepEqual(keys, ["PATH", "HOME"]);
});

test("throws LaunchdPlistError when rmdBin is not absolute", () => {
  assert.throws(
    () => generateLaunchdPlist({ ...VALID, rmdBin: "bin/rmd" }),
    (e) => e instanceof LaunchdPlistError && /rmdBin must be an absolute path/.test(e.message),
  );
});

test("throws LaunchdPlistError when root is not absolute", () => {
  assert.throws(
    () => generateLaunchdPlist({ ...VALID, root: "Remudero" }),
    (e) => e instanceof LaunchdPlistError && /root must be an absolute path/.test(e.message),
  );
});

test("throws LaunchdPlistError when a caller-supplied home is not absolute", () => {
  assert.throws(
    () => generateLaunchdPlist({ ...VALID, home: "relative/home" }),
    (e) => e instanceof LaunchdPlistError && /home must be an absolute path/.test(e.message),
  );
});

test("--poll-ms threads through to ProgramArguments as `daemon --poll-ms <n>`", () => {
  const plist = generateLaunchdPlist({ ...VALID, pollIntervalMs: 30000 });
  assert.match(plist, /<string>daemon<\/string>\s*<string>--poll-ms<\/string>\s*<string>30000<\/string>/);
});

test("a custom label is escaped and reflected in Label", () => {
  const plist = generateLaunchdPlist({ ...VALID, label: "com.example.daemon" });
  assert.match(plist, /<key>Label<\/key>\s*<string>com\.example\.daemon<\/string>/);
});

// ── launchdPlistPath: a pure path computation, never a write (W1-T12d writes it) ──

test("launchdPlistPath: defaults to ~/Library/LaunchAgents/<DAEMON_LABEL>.plist", () => {
  const p = launchdPlistPath(undefined, "/Users/op");
  assert.equal(p, `/Users/op/Library/LaunchAgents/${DAEMON_LABEL}.plist`);
});

test("launchdPlistPath: honors a custom label", () => {
  const p = launchdPlistPath("com.example.daemon", "/Users/op");
  assert.equal(p, "/Users/op/Library/LaunchAgents/com.example.daemon.plist");
});

// ── The plist must BAKE IN the repo target so the unit drains the intended repo, not an
// implicit default (fix/daemon-repo-targeting; W1-T12d commissions against remudero-sandbox). ──
test("generateLaunchdPlist bakes `--repo <name>` into ProgramArguments when a repo is given", () => {
  const plist = generateLaunchdPlist({ ...VALID, repo: "remudero-sandbox" });
  assert.match(plist, /<string>daemon<\/string>/);
  assert.match(plist, /<string>--repo<\/string>\s*<string>remudero-sandbox<\/string>/, "the launchd unit targets the chosen repo explicitly");
});

test("generateLaunchdPlist omits --repo when none is given (no implicit repo baked in)", () => {
  const plist = generateLaunchdPlist(VALID);
  assert.doesNotMatch(plist, /<string>--repo<\/string>/);
});

// ── generateDigestLaunchdPlist: the daily `rmd digest` pulse (W1-T112, the W1-T12b generator
// pattern applied to a StartCalendarInterval unit instead of RunAtLoad/KeepAlive) ───────────

test("generates a well-formed daily digest plist: label, absolute paths, ProgramArguments end [rmd, digest]", () => {
  const plist = generateDigestLaunchdPlist(VALID);
  assert.match(plist, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(plist, /<key>Label<\/key>\s*<string>com\.remudero\.digest<\/string>/);
  assert.equal(DIGEST_LABEL, "com.remudero.digest");
  assert.match(plist, /<string>\/Users\/op\/Remudero\/bin\/rmd<\/string>\s*<string>digest<\/string>/, "ProgramArguments is exactly [rmdBin, digest]");
  assert.match(
    plist,
    /<key>WorkingDirectory<\/key>\s*<string>\/Users\/op\/Remudero<\/string>/,
    "WorkingDirectory is the absolute workspace root",
  );
  assert.match(
    plist,
    /<key>StandardOutPath<\/key>\s*<string>\/Users\/op\/Remudero\/state\/logs\/digest\.out\.log<\/string>/,
  );
  assert.match(
    plist,
    /<key>StandardErrorPath<\/key>\s*<string>\/Users\/op\/Remudero\/state\/logs\/digest\.err\.log<\/string>/,
  );
});

test("generateDigestLaunchdPlist is DAILY: StartCalendarInterval at the given hour, :00, never RunAtLoad/KeepAlive", () => {
  const plist = generateDigestLaunchdPlist({ ...VALID, hour: 6 });
  assert.match(plist, /<key>StartCalendarInterval<\/key>\s*<dict>\s*<key>Hour<\/key>\s*<integer>6<\/integer>\s*<key>Minute<\/key>\s*<integer>0<\/integer>\s*<\/dict>/);
  assert.doesNotMatch(plist, /<key>RunAtLoad<\/key>/);
  assert.doesNotMatch(plist, /<key>KeepAlive<\/key>/);
});

test("generateDigestLaunchdPlist defaults to the morning pulse hour when --hour is omitted", () => {
  const plist = generateDigestLaunchdPlist(VALID);
  assert.equal(DEFAULT_DIGEST_HOUR, 8);
  assert.match(plist, new RegExp(`<key>Hour</key>\\s*<integer>${DEFAULT_DIGEST_HOUR}</integer>`));
});

test("generateDigestLaunchdPlist throws on an out-of-range hour, never silently clamping", () => {
  assert.throws(
    () => generateDigestLaunchdPlist({ ...VALID, hour: 24 }),
    (e) => e instanceof LaunchdPlistError && /hour must be an integer in \[0, 23\]/.test(e.message),
  );
  assert.throws(
    () => generateDigestLaunchdPlist({ ...VALID, hour: -1 }),
    (e) => e instanceof LaunchdPlistError && /hour must be an integer in \[0, 23\]/.test(e.message),
  );
  assert.throws(
    () => generateDigestLaunchdPlist({ ...VALID, hour: 8.5 }),
    (e) => e instanceof LaunchdPlistError && /hour must be an integer in \[0, 23\]/.test(e.message),
  );
});

test("generateDigestLaunchdPlist: EnvironmentVariables is the SAME closed allowlist as the daemon unit — only PATH and HOME", () => {
  const plist = generateDigestLaunchdPlist(VALID);
  const block = plist.match(/<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/)?.[1] ?? "";
  const keys = [...block.matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1]);
  assert.deepEqual(keys, ["PATH", "HOME"]);
});

test("generateDigestLaunchdPlist: the ANTHROPIC-clean-env boot assertion applies to the digest unit too", () => {
  const plist = generateDigestLaunchdPlist(VALID);
  const block = plist.match(/<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/)?.[1] ?? "";
  assert.doesNotMatch(block, /ANTHROPIC_/i, "the actual env dict never carries an ANTHROPIC_* key");
});

test("generateDigestLaunchdPlist's own EnvironmentVariables block, run through the SAME assertNoAnthropicKeys the daemon generator uses, does not throw (the assertion is reused, not reimplemented)", () => {
  const plist = generateDigestLaunchdPlist(VALID);
  const block = plist.match(/<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/)?.[1] ?? "";
  const keys = [...block.matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1]);
  const values = [...block.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]);
  const env = Object.fromEntries(keys.map((k, i) => [k, values[i]]));
  assert.doesNotThrow(() => assertNoAnthropicKeys(env, "generateDigestLaunchdPlist"));
  // ...and an ANTHROPIC_*-polluted VERSION of that same block throws, proving the digest
  // generator's env block is NOT specially exempt from the daemon's own assertion.
  assert.throws(
    () => assertNoAnthropicKeys({ ...env, ANTHROPIC_API_KEY: "sneaky" }, "generateDigestLaunchdPlist"),
    (e) => e instanceof LaunchdPlistError && /ANTHROPIC_API_KEY/.test(e.message),
  );
});

test("generateDigestLaunchdPlist throws LaunchdPlistError when rmdBin/root are not absolute", () => {
  assert.throws(
    () => generateDigestLaunchdPlist({ ...VALID, rmdBin: "bin/rmd" }),
    (e) => e instanceof LaunchdPlistError && /rmdBin must be an absolute path/.test(e.message),
  );
  assert.throws(
    () => generateDigestLaunchdPlist({ ...VALID, root: "Remudero" }),
    (e) => e instanceof LaunchdPlistError && /root must be an absolute path/.test(e.message),
  );
});

test("launchdPlistPath honors DIGEST_LABEL the same generic way it does DAEMON_LABEL", () => {
  const p = launchdPlistPath(DIGEST_LABEL, "/Users/op");
  assert.equal(p, "/Users/op/Library/LaunchAgents/com.remudero.digest.plist");
});

// ── W1-T112 review-gate proof, restated as ONE combined fixture (round-2 fix): "generated plist
// fixture -> StartCalendarInterval at the given hour, EnvironmentVariables exactly {PATH, HOME},
// ProgramArguments end [rmd, digest]; an ANTHROPIC_* injection fixture throws (the W1-T12b
// assertion reused)" — every clause of that sentence asserted here, literally, in one place, in
// addition to the more granular tests above. ──────────────────────────────────────────────────

test("generated plist fixture: StartCalendarInterval at the given hour, EnvironmentVariables exactly {PATH, HOME}, ProgramArguments end [rmd, digest]; an ANTHROPIC_* injection fixture throws (the W1-T12b assertion reused)", () => {
  const rmdBin = "/Users/op/Remudero/bin/rmd";
  const root = "/Users/op/Remudero";
  const home = "/Users/op";
  const hour = 6;
  const plist = generateDigestLaunchdPlist({ rmdBin, root, home, hour });

  // StartCalendarInterval at the given hour, :00.
  const calBlock = plist.match(/<key>StartCalendarInterval<\/key>\s*<dict>([\s\S]*?)<\/dict>/)?.[1] ?? "";
  const calKeys = [...calBlock.matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1]);
  const calInts = [...calBlock.matchAll(/<integer>([^<]+)<\/integer>/g)].map((m) => Number(m[1]));
  assert.deepEqual(Object.fromEntries(calKeys.map((k, i) => [k, calInts[i]])), { Hour: hour, Minute: 0 });

  // EnvironmentVariables exactly {PATH, HOME} — not a subset check, the full closed dict.
  const envBlock = plist.match(/<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/)?.[1] ?? "";
  const envKeys = [...envBlock.matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1]);
  const envValues = [...envBlock.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]);
  const env = Object.fromEntries(envKeys.map((k, i) => [k, envValues[i]]));
  assert.deepEqual(env, { PATH: DEFAULT_LAUNCHD_PATH, HOME: home });

  // ProgramArguments ends [rmdBin, "digest"] — and here that IS the whole array.
  const argsBlock = plist.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/)?.[1] ?? "";
  const args = [...argsBlock.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]);
  assert.deepEqual(args, [rmdBin, "digest"]);

  // The ANTHROPIC_* injection fixture: run the digest unit's OWN rendered env back through the
  // SAME assertNoAnthropicKeys the daemon generator (W1-T12b) uses, polluted, and observe the throw.
  assert.throws(
    () => assertNoAnthropicKeys({ ...env, ANTHROPIC_API_KEY: "sneaky" }, "generateDigestLaunchdPlist"),
    (e) => e instanceof LaunchdPlistError && /billing-boundary violation/.test(e.message) && /ANTHROPIC_API_KEY/.test(e.message),
  );
});
