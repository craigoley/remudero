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
  generateSupervisorLaunchdPlist,
  launchdPlistPath,
  parseSupervisorStartInterval,
} from "../src/lib/launchd.js";

const VALID = {
  rmdBin: "/Users/op/Remudero/daemon-install/bin/rmd",
  installRoot: "/Users/op/Remudero/daemon-install",
  installRootExists: true,
  root: "/Users/op/Remudero",
};

/** Escapes a literal string for embedding in a `RegExp` — used below so an assertion tracks
 *  `VALID.rmdBin` (W1-T925: now the install-derived path) rather than restating it as a
 *  hand-typed literal that could silently drift from the fixture it is supposed to prove. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("generates a well-formed plist carrying the label, absolute paths, and RunAtLoad/KeepAlive", () => {
  const plist = generateLaunchdPlist(VALID);
  assert.match(plist, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(plist, /<key>Label<\/key>\s*<string>com\.remudero\.daemon<\/string>/);
  assert.match(
    plist,
    new RegExp(`<string>${escapeRegExp(VALID.rmdBin)}</string>`),
    "the launcher's absolute path is embedded",
  );
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

test("throws LaunchdPlistError when installRoot is not absolute", () => {
  assert.throws(
    () => generateLaunchdPlist({ ...VALID, installRoot: "Remudero/daemon-install" }),
    (e) => e instanceof LaunchdPlistError && /installRoot must be an absolute path/.test(e.message),
  );
});

// ── W1-T925 (fb-1784913390318-1fcb63): the generator refuses a unit whose ProgramArguments[0]
// would point OUTSIDE the install checkout, or at a checkout that does not yet exist — the same
// fail-at-generation posture as the self-target and ANTHROPIC-key gates above. ──────────────────

test("generateLaunchdPlist: refuses when rmdBin resolves OUTSIDE installRoot, naming the remedy", () => {
  assert.throws(
    () => generateLaunchdPlist({ ...VALID, rmdBin: "/Users/op/some-operator-checkout/bin/rmd" }),
    (e) =>
      e instanceof LaunchdPlistError &&
      /OUTSIDE the install root/.test(e.message) &&
      /rmd install-checkout --write/.test(e.message),
    "no plist string is ever returned for a binary path outside the install checkout",
  );
});

test("generateLaunchdPlist: refuses when the install checkout does not exist, naming the remedy", () => {
  assert.throws(
    () => generateLaunchdPlist({ ...VALID, installRootExists: false }),
    (e) =>
      e instanceof LaunchdPlistError &&
      /install checkout does not exist/.test(e.message) &&
      /rmd install-checkout --write/.test(e.message),
    "never emits a unit whose ProgramArguments[0] would be a missing binary",
  );
});

test("generateLaunchdPlist: a rmdBin that IS the install root's bin/rmd (the intended shape) never refuses on that account", () => {
  assert.doesNotThrow(() => generateLaunchdPlist(VALID));
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

// ── Self-target consent gate (W1-T109 — the commissioning crash-loop near-miss): a self-target
// unit generated WITHOUT --allow-self-target loads fine, but the daemon's OWN runtime guard
// (resolveDaemonTarget) then refuses to start it, and KeepAlive/SuccessfulExit:false restarts it
// forever. The generator must refuse at GENERATION instead — the cheapest layer to fail at. ──

test("generateLaunchdPlist: self-target + --allow-self-target bakes the flag into ProgramArguments", () => {
  const plist = generateLaunchdPlist({ ...VALID, repo: "remudero", isSelfTarget: true, allowSelfTarget: true });
  assert.match(
    plist,
    /<string>--repo<\/string>\s*<string>remudero<\/string>\s*<string>--allow-self-target<\/string>/,
    "--allow-self-target is baked in right after the self repo it targets",
  );
});

test("generateLaunchdPlist: self-target WITHOUT --allow-self-target refuses at generation, naming the flag, emitting no plist", () => {
  assert.throws(
    () => generateLaunchdPlist({ ...VALID, repo: "remudero", isSelfTarget: true }),
    (e) =>
      e instanceof LaunchdPlistError &&
      /--allow-self-target/.test(e.message) &&
      /self/i.test(e.message),
    "the thrown message names --allow-self-target — no plist string is ever returned",
  );
});

test("generateLaunchdPlist: self-target detection also applies with NO --repo given (the CLI's absent-repo-defaults-to-self case) — refuses without the flag", () => {
  assert.throws(
    () => generateLaunchdPlist({ ...VALID, isSelfTarget: true }),
    (e) => e instanceof LaunchdPlistError && /--allow-self-target/.test(e.message),
  );
  const plist = generateLaunchdPlist({ ...VALID, isSelfTarget: true, allowSelfTarget: true });
  assert.match(plist, /<string>--allow-self-target<\/string>/, "consent still bakes in with no --repo baked");
});

test("generateLaunchdPlist: --allow-self-target is neither required nor baked for a NON-self target, even if passed", () => {
  const plist = generateLaunchdPlist({ ...VALID, repo: "remudero-sandbox", isSelfTarget: false, allowSelfTarget: true });
  assert.doesNotMatch(plist, /--allow-self-target/, "a non-self target never bakes the flag, whether or not it was given");
});

// ── Regression lock: a NON-self --repo target's output is byte-identical to the plist this
// generator produced before W1-T109 — captured verbatim from the pre-change generator output,
// EXCEPT for the ThrottleInterval key W1-T253 (P37 CONSUMERS) added (net-new, read from
// plan/policy.yaml's launchd.throttleIntervalS — see LaunchdPlistOpts.throttleIntervalS). ──
test("generateLaunchdPlist: a non-self --repo target's output is BYTE-IDENTICAL to before W1-T109, plus W1-T253's ThrottleInterval (regression lock)", () => {
  const plist = generateLaunchdPlist({
    rmdBin: "/Users/op/Remudero/bin/rmd",
    installRoot: "/Users/op/Remudero",
    installRootExists: true,
    root: "/Users/op/Remudero",
    home: "/Users/op",
    repo: "remudero-sandbox",
  });
  const expected =
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\">\n<dict>\n  <key>Label</key>\n  <string>com.remudero.daemon</string>\n  <!-- ANTHROPIC-clean-env boot assertion (W1-T12b, billing boundary, MASTER-PLAN §9):\n       EnvironmentVariables below is a CLOSED allowlist (PATH + HOME only) — launchd\n       never sources ~/.zshrc, so this dict is the WHOLE env the daemon process\n       receives at boot. generateLaunchdPlist() throws if any ANTHROPIC_* key ever\n       lands in it. The daemon process itself re-asserts this at runtime over its\n       OWN live env (lib/daemon.ts daemonBoot, lib/env.ts assertCleanBoot) and logs\n       env_clean=true / billing_mode=subscription — belt-and-suspenders against a\n       future edit to this generator. -->\n  <key>EnvironmentVariables</key>\n  <dict>\n    <key>PATH</key>\n    <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>\n    <key>HOME</key>\n    <string>/Users/op</string>\n  </dict>\n  <key>ProgramArguments</key>\n  <array>\n    <string>/Users/op/Remudero/bin/rmd</string>\n    <string>daemon</string>\n    <string>--repo</string>\n    <string>remudero-sandbox</string>\n  </array>\n  <key>WorkingDirectory</key>\n  <string>/Users/op/Remudero</string>\n  <key>RunAtLoad</key>\n  <true/>\n  <key>KeepAlive</key>\n  <dict>\n    <key>SuccessfulExit</key>\n    <false/>\n  </dict>\n  <!-- ThrottleInterval (W1-T253, P37 CONSUMERS): the R-1 relaunch-storm rate limit,\n       net-new here — plan/policy.yaml's launchd.throttleIntervalS, unless overridden. -->\n  <key>ThrottleInterval</key>\n  <integer>60</integer>\n  <key>StandardOutPath</key>\n  <string>/Users/op/Remudero/state/logs/daemon.out.log</string>\n  <key>StandardErrorPath</key>\n  <string>/Users/op/Remudero/state/logs/daemon.err.log</string>\n</dict>\n</plist>\n";
  assert.equal(plist, expected);
});

test("generateLaunchdPlist: ThrottleInterval reads plan/policy.yaml's launchd.throttleIntervalS (60) by default, and a caller-supplied value overrides it", () => {
  const defaulted = generateLaunchdPlist(VALID);
  assert.match(defaulted, /<key>ThrottleInterval<\/key>\s*<integer>60<\/integer>/);
  const overridden = generateLaunchdPlist({ ...VALID, throttleIntervalS: 120 });
  assert.match(overridden, /<key>ThrottleInterval<\/key>\s*<integer>120<\/integer>/);
});

// ── generateDigestLaunchdPlist: the daily `rmd digest` pulse (W1-T112, the W1-T12b generator
// pattern applied to a StartCalendarInterval unit instead of RunAtLoad/KeepAlive) ───────────

test("generates a well-formed daily digest plist: label, absolute paths, ProgramArguments end [rmd, digest]", () => {
  const plist = generateDigestLaunchdPlist(VALID);
  assert.match(plist, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(plist, /<key>Label<\/key>\s*<string>com\.remudero\.digest<\/string>/);
  assert.equal(DIGEST_LABEL, "com.remudero.digest");
  assert.match(
    plist,
    new RegExp(`<string>${escapeRegExp(VALID.rmdBin)}</string>\\s*<string>digest</string>`),
    "ProgramArguments is exactly [rmdBin, digest]",
  );
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

// ── W1-T925: the digest unit's binary comes from the install checkout too — SAME gates, SAME
// generator family (generateLaunchdPlist's own module doc), reused rather than reimplemented. ──

test("generateDigestLaunchdPlist: refuses when rmdBin resolves outside installRoot, naming the remedy", () => {
  assert.throws(
    () => generateDigestLaunchdPlist({ ...VALID, rmdBin: "/Users/op/some-operator-checkout/bin/rmd" }),
    (e) =>
      e instanceof LaunchdPlistError &&
      /OUTSIDE the install root/.test(e.message) &&
      /rmd install-checkout --write/.test(e.message),
  );
});

test("generateDigestLaunchdPlist: refuses when the install checkout does not exist, naming the remedy", () => {
  assert.throws(
    () => generateDigestLaunchdPlist({ ...VALID, installRootExists: false }),
    (e) =>
      e instanceof LaunchdPlistError &&
      /install checkout does not exist/.test(e.message) &&
      /rmd install-checkout --write/.test(e.message),
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

test("generated plist fixture -> StartCalendarInterval at the given hour, EnvironmentVariables exactly {PATH, HOME}, ProgramArguments end [rmd, digest]; an ANTHROPIC_* injection fixture throws (the W1-T12b assertion reused)", () => {
  const rmdBin = "/Users/op/Remudero/bin/rmd";
  const installRoot = "/Users/op/Remudero";
  const root = "/Users/op/Remudero";
  const home = "/Users/op";
  const hour = 6;
  const plist = generateDigestLaunchdPlist({ rmdBin, installRoot, installRootExists: true, root, home, hour });

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

// ── W1-T925: the deploy-supervisor unit's binary comes from the install checkout too — SAME
// gates, SAME generator family, reused rather than reimplemented. ────────────────────────────

test("generateSupervisorLaunchdPlist: refuses when rmdBin resolves outside installRoot, naming the remedy", () => {
  assert.throws(
    () => generateSupervisorLaunchdPlist({ ...VALID, rmdBin: "/Users/op/some-operator-checkout/bin/rmd" }),
    (e) =>
      e instanceof LaunchdPlistError &&
      /OUTSIDE the install root/.test(e.message) &&
      /rmd install-checkout --write/.test(e.message),
  );
});

test("generateSupervisorLaunchdPlist: refuses when the install checkout does not exist, naming the remedy", () => {
  assert.throws(
    () => generateSupervisorLaunchdPlist({ ...VALID, installRootExists: false }),
    (e) =>
      e instanceof LaunchdPlistError &&
      /install checkout does not exist/.test(e.message) &&
      /rmd install-checkout --write/.test(e.message),
  );
});

// ── ALL FOUR units share the SAME install-derived binary (acceptance criterion 3) — the same
// {rmdBin, installRoot} pair is accepted by every generator in this family and embedded
// byte-identically, so no one unit is left on a cwd-derived path while the rest move. ──────────

test("daemon, digest, and supervisor all embed the SAME install-derived rmdBin, given the same {rmdBin, installRoot}", () => {
  const shared = { rmdBin: "/Users/op/Remudero/daemon-install/bin/rmd", installRoot: "/Users/op/Remudero/daemon-install", installRootExists: true, root: "/Users/op/Remudero" };
  const needle = new RegExp(`<string>${escapeRegExp(shared.rmdBin)}</string>`);
  assert.match(generateLaunchdPlist(shared), needle, "the daemon unit");
  assert.match(generateDigestLaunchdPlist(shared), needle, "the digest unit");
  assert.match(generateSupervisorLaunchdPlist(shared), needle, "the deploy-supervisor unit");
  // The serve unit takes the same {rmdBin, installRoot} shape (plus port/hosts) — its own copy
  // of this exact assertion lives in test/serve-plist.test.ts, over generateServeLaunchdPlist,
  // the file that already owns every other serve-unit fixture (port/hosts VALID shape).
});

test("parseSupervisorStartInterval reads back the StartInterval it just generated (W1-T301)", () => {
  const plist = generateSupervisorLaunchdPlist({ ...VALID, intervalSeconds: 90 });
  assert.equal(parseSupervisorStartInterval(plist), 90);
});

test("parseSupervisorStartInterval falls back to undefined on garbage/absent input (W1-T301)", () => {
  assert.equal(parseSupervisorStartInterval("<plist></plist>"), undefined);
  assert.equal(parseSupervisorStartInterval(""), undefined);
  assert.equal(
    parseSupervisorStartInterval("<key>StartInterval</key><integer>-5</integer>"),
    undefined,
    "a non-positive interval is never a fabricated liveness threshold",
  );
  assert.equal(
    parseSupervisorStartInterval("<key>StartInterval</key><integer>not-a-number</integer>"),
    undefined,
  );
});
