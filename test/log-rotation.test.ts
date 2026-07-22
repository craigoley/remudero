import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import {
  LOG_AGE_CEILING_HOURS,
  LOG_ROTATION_COUNT,
  LOG_SIZE_CEILING_KB,
  LogRotationConfigError,
  NEVER_ROTATE_FILENAME,
  ROTATED_LOG_FILES,
  generateNewsyslogConfig,
  newsyslogConfigPath,
} from "../src/lib/log-rotation.js";

// ── W1-T218: "no log has a size or age bound — and a naive rotation policy would sweep up the
// ledger and zero the dispatch breaker" (RECON R-25). generateNewsyslogConfig (src/lib/
// log-rotation.ts) is the fix: a pure generator — mirrors lib/launchd.ts's plist generators —
// that emits a newsyslog.d config EXPLICITLY naming every rotated file, never a directory glob.
// THE EXCLUSION IS THE LOAD-BEARING PART, so most of this file is about what is NOT rotated,
// not what is. ──────────────────────────────────────────────────────────────────────────────

const ROOT = "/Users/op/Remudero";

test("every daemon and service log carries a stated size AND age bound, not unbounded growth", () => {
  const config = generateNewsyslogConfig(ROOT);
  const expectedNames = [
    "daemon.out.log",
    "daemon.err.log",
    "digest.out.log",
    "digest.err.log",
    "supervisor.out.log",
    "supervisor.err.log",
    "serve.log",
    "drain.log",
    "sweep-loop.log",
  ];
  assert.deepEqual(
    [...ROTATED_LOG_FILES].sort(),
    [...expectedNames].sort(),
    "the measured-at-intake logs (daemon.err/out, serve, drain, sweep-loop) plus the same launchd-redirected-stdio shape (digest, supervisor)",
  );

  for (const name of expectedNames) {
    const absolutePath = join(ROOT, "state", "logs", name);
    // One line per file, carrying the SAME numeric size (KB) and age (hours) ceiling — a
    // "size or age bound" per the acceptance claim, not just a mention of the filename.
    const linePattern = new RegExp(
      `^${absolutePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+\\d+\\s+${LOG_ROTATION_COUNT}\\s+${LOG_SIZE_CEILING_KB}\\s+${LOG_AGE_CEILING_HOURS}\\s+\\S+$`,
      "m",
    );
    assert.match(config, linePattern, `${name} has an explicit size(${LOG_SIZE_CEILING_KB}KB)/age(${LOG_AGE_CEILING_HOURS}h) rotation line`);
  }

  assert.equal(LOG_SIZE_CEILING_KB > 0, true, "the size ceiling is a real bound, not zero/disabled");
  assert.equal(LOG_AGE_CEILING_HOURS > 0, true, "the age ceiling is a real bound, not zero/disabled");
});

test("THE EXCLUSION FALSIFIER: ledger.ndjson is never named, and the config is an explicit list, not a directory sweep", () => {
  const config = generateNewsyslogConfig(ROOT);

  // The comment block is allowed to NAME ledger.ndjson in prose (explaining the exclusion) —
  // what must never happen is an actual rotation ENTRY (a non-comment line) for it.
  const entryLines = config.split("\n").filter((line) => line.length > 0 && !line.startsWith("#"));
  assert.equal(entryLines.length, ROTATED_LOG_FILES.length, "one entry line per rotated file, nothing extra");
  assert.equal(
    entryLines.some((line) => line.includes("ledger.ndjson")),
    false,
    "no rotation entry line ever names the dispatch breaker's backing store",
  );
  assert.equal(ROTATED_LOG_FILES.includes(NEVER_ROTATE_FILENAME), false, "ROTATED_LOG_FILES never contains the ledger filename");
  assert.equal(NEVER_ROTATE_FILENAME, "ledger.ndjson");

  // No wildcard/glob in any ENTRY line — every rotated path is a literal filename under
  // state/logs/, so nothing can be "swept up" the way a `state/*` rule would.
  assert.equal(
    entryLines.every((line) => !line.includes("*")),
    true,
    "every entry line names one literal file, never a glob",
  );

  // state/ledger.ndjson lives OUTSIDE state/logs/ (a sibling directory), so even a directory
  // sweep scoped to state/logs/ specifically would miss it — this asserts that structural fact
  // holds for every path this generator actually emits.
  for (const name of ROTATED_LOG_FILES) {
    const path = join(ROOT, "state", "logs", name);
    assert.equal(path.includes(join(ROOT, "state", "ledger.ndjson")), false);
  }

  // Belt-and-suspenders: if ROTATED_LOG_FILES were ever hand-edited to include the ledger
  // filename, generation itself refuses rather than silently emitting a rotation line for it.
  const original = [...ROTATED_LOG_FILES];
  (ROTATED_LOG_FILES as string[]).push(NEVER_ROTATE_FILENAME);
  try {
    assert.throws(() => generateNewsyslogConfig(ROOT), LogRotationConfigError);
  } finally {
    (ROTATED_LOG_FILES as string[]).length = 0;
    (ROTATED_LOG_FILES as string[]).push(...original);
  }
});

test("a decision-backing file added to state/ later is NOT silently enrolled by this same rule", () => {
  // W1-T209's rotateLedger backs state/ledger.ndjson specifically; a hypothetical future
  // decision-backing file (e.g. state/some-new-breaker.json) is not swept in here either,
  // because this generator never reads the filesystem — it only ever emits ROTATED_LOG_FILES,
  // a fixed, explicit, source-controlled list. Adding a real file to state/ at runtime cannot
  // change what generateNewsyslogConfig emits.
  const before = generateNewsyslogConfig(ROOT);
  // No filesystem read happened above and none is possible here either — the assertion is
  // that the function's SHAPE (root: string) => string admits no directory listing at all.
  assert.equal(generateNewsyslogConfig.length, 1, "the generator takes only `root` — no directory/state listing input");
  assert.doesNotMatch(before, /some-new-breaker|inflight-lock|status\.json/, "only the explicit ROTATED_LOG_FILES names ever appear");
});

test("generateNewsyslogConfig requires an absolute root, same discipline as generateLaunchdPlist", () => {
  assert.throws(() => generateNewsyslogConfig("relative/path"), LogRotationConfigError);
});

test("newsyslogConfigPath is a pure computation under /etc/newsyslog.d/, never a write", () => {
  assert.equal(newsyslogConfigPath(), "/etc/newsyslog.d/com.remudero.logs.conf");
});
