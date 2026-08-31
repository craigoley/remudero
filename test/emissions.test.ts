import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  attributeVerbs,
  deriveCliVerbs,
  deriveStepPrefixes,
  emissionsReport,
  EMISSIONS_ALLOWLIST,
} from "../src/lib/emissions.js";
import { emissionsCommand, ledgerCorpusFiles } from "../src/run-task.js";
import { rotationStampIso } from "../src/lib/ledger-grep.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

// ── The instrument's own calibration, asserted rather than remembered.
//
// Three prior instruments in this repo found their detection wrong on the first pass, so the
// derivation is pinned here against the REAL source: if `COMMANDS` stops matching, or the step-scan
// stops finding the two emission shapes, these fail loudly instead of quietly surveying nothing.

test("the verb derivation reads the real COMMANDS registry, not a hardcoded list", () => {
  const verbs = deriveCliVerbs(readFileSync(join(REPO, "src", "run-task.ts"), "utf8"));
  // Non-vacuity first: a derivation that matches nothing would make every later assertion pass.
  assert.ok(verbs.length >= 40, `expected the registry to yield the repo's verbs, got ${verbs.length}`);
  for (const known of ["ops", "issues", "daemon", "sweep", "emissions"]) {
    assert.ok(verbs.includes(known), `expected \`rmd ${known}\` in the derived verb set`);
  }
});

test("the step scan finds BOTH emission shapes, including the object-literal one ops.ts uses", () => {
  // `log("x.y", …)` is the common shape; lib/ops.ts writes `{ step: "ops.alerts_polled" }`. A scan
  // that knew only the first would miss the single most important verb in the whole report.
  const logShape = deriveStepPrefixes(['log("sweep.started", {})']);
  const objShape = deriveStepPrefixes(['{ step: "ops.alerts_polled", alerts }']);
  assert.ok(logShape.has("sweep"), "the log(...) shape must be recognised");
  assert.ok(objShape.has("ops"), "the { step: ... } shape must be recognised");

  const real = deriveStepPrefixes([readFileSync(join(REPO, "src", "lib", "ops.ts"), "utf8")]);
  assert.ok(real.has("ops"), "the REAL lib/ops.ts must yield the `ops` prefix");
});

test("attribution is EXACT-NAME only, so a dead verb cannot inherit a hot sibling's traffic", () => {
  // The calibration that set this rule: a head-token match made `daemon-plist` -> `daemon`, which
  // would report a never-run verb as live off its sibling's 11,882 lines.
  const attributed = attributeVerbs(["daemon", "daemon-plist", "deploy", "deploy-run"], new Set(["daemon", "deploy"]));
  const by = new Map(attributed.map((a) => [a.name, a.prefix]));
  assert.equal(by.get("daemon"), "daemon");
  assert.equal(by.get("deploy"), "deploy");
  assert.equal(by.get("daemon-plist"), null, "daemon-plist must NOT claim the `daemon` prefix");
  assert.equal(by.get("deploy-run"), null, "deploy-run must NOT claim the `deploy` prefix");
});

// ── The report's three classifications ──────────────────────────────────────

const NO_ALLOWLIST: ReadonlyMap<string, string> = new Map();

test("a verb with zero emissions and no allowlist entry is REPORTED", () => {
  const rows = emissionsReport({
    measurable: [{ name: "issues", prefix: "issues" }],
    counts: new Map(),
    callSites: new Map([["issues", 0]]),
    allowlist: NO_ALLOWLIST,
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].verb, "issues");
  assert.equal(rows[0].count, 0);
  // The pairing per trap 1: zero emissions AND no call site beyond the CLI dispatch means nothing
  // but a human typing it could ever run it — which is a different claim from "unused this month".
  assert.equal(rows[0].status, "unreachable-in-practice");
});

test("zero emissions WITH a call site beyond dispatch reads as reachable-but-unused, not unreachable", () => {
  const rows = emissionsReport({
    measurable: [{ name: "fix", prefix: "fix" }],
    counts: new Map(),
    callSites: new Map([["fix", 3]]),
    allowlist: NO_ALLOWLIST,
  });
  assert.equal(rows[0].status, "reachable-but-unused", "a verb something else calls is a different finding");
});

test("an allowlisted verb is NOT reported, and a stale allowlist entry IS visible", () => {
  const allow = new Map([["wipe-test", "spends real money per pair; rare by design"]]);

  const quiet = emissionsReport({
    measurable: [{ name: "wipe-test", prefix: "wipetest" }],
    counts: new Map(),
    callSites: new Map(),
    allowlist: allow,
  });
  assert.deepEqual(quiet, [], "allowlisted AND quiet is working as intended — say nothing");

  // But once it starts being invoked the reason has expired, and a silent stale entry is a small
  // lie that grows. Surfacing it is the point.
  const stale = emissionsReport({
    measurable: [{ name: "wipe-test", prefix: "wipetest" }],
    counts: new Map([["wipetest", 5]]),
    callSites: new Map(),
    allowlist: allow,
  });
  assert.equal(stale.length, 1);
  assert.equal(stale[0].status, "stale-allowlist");
  assert.match(stale[0].allowlistReason ?? "", /rare by design/);
});

test("a hot verb is not reported as dead — the false-positive lock", () => {
  const rows = emissionsReport({
    measurable: [
      { name: "sweep", prefix: "sweep" },
      { name: "daemon", prefix: "daemon" },
    ],
    counts: new Map([
      ["sweep", 31519],
      ["daemon", 11882],
    ]),
    callSites: new Map(),
    allowlist: NO_ALLOWLIST,
  });
  assert.equal(rows.length, 2);
  for (const r of rows) {
    assert.equal(r.status, "live", `${r.verb} has ${r.count} ledger lines and must never read as dead`);
  }
});

test("every allowlist entry carries a specific reason — 'TODO' is not one", () => {
  assert.ok(EMISSIONS_ALLOWLIST.size > 0, "a vacuous allowlist would make this assertion meaningless");
  for (const [verb, reason] of EMISSIONS_ALLOWLIST) {
    assert.ok(reason.length >= 30, `\`rmd ${verb}\`'s allowlist reason is too thin to be a reason: ${reason}`);
    assert.doesNotMatch(reason, /^\s*(todo|tbd|n\/a)\b/i, `\`rmd ${verb}\` has a placeholder reason`);
  }
});

// ── The CLI shell. The pure core above is where the logic lives, but a suite that never imports
// run-task.ts leaves `emissionsCommand`'s 130 lines uninstrumented — and a diff-coverage OK on an
// lcov with ZERO DA records for a changed file is a hollow pass, not a green one. Measured: that is
// exactly what this suite produced before these tests existed.

test("ledgerCorpusFiles unions the live ledger AND its rotations IN BOTH FORMS, ignoring decoys", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-emissions-corpus-"));
  writeFileSync(join(dir, "ledger.ndjson"), "");
  writeFileSync(join(dir, "ledger.2026-07-23T03-20-10-766Z.ndjson"), "");
  // W1-T444: the gzipped form used to be dropped here, which is how this reader reached 38,744 of
  // 418,898 distinct lines on the real host — one in eleven.
  writeFileSync(join(dir, "ledger.2026-07-22T21-26-36-052Z.ndjson.gz"), "");
  writeFileSync(join(dir, "ledger-archive.txt"), ""); // not .ndjson
  writeFileSync(join(dir, "service-tokens.json"), ""); // not a ledger
  const files = ledgerCorpusFiles(dir).map((f) => f.path.split("/").pop());
  assert.deepEqual(files.sort(), [
    "ledger.2026-07-22T21-26-36-052Z.ndjson.gz",
    "ledger.2026-07-23T03-20-10-766Z.ndjson",
    "ledger.ndjson",
  ]);
  assert.deepEqual(
    ledgerCorpusFiles(dir).filter((f) => f.form === "gzip").map((f) => f.path.split("/").pop()),
    ["ledger.2026-07-22T21-26-36-052Z.ndjson.gz"],
    "and the gzipped one is TAGGED, so the reader decompresses it instead of sniffing",
  );
  assert.deepEqual(ledgerCorpusFiles(join(dir, "does-not-exist")), [], "an unreadable dir is empty, never a throw");
  rmSync(dir, { recursive: true, force: true });
});

test("emissionsCommand refuses a bad window and an unknown flag, spawning nothing", () => {
  const realErr = console.error;
  console.error = () => {};
  try {
    assert.equal(emissionsCommand(["--days", "not-a-number"]), 2);
    assert.equal(emissionsCommand(["--days", "-3"]), 2);
    assert.equal(emissionsCommand(["--bogus"]), 2);
  } finally {
    console.error = realErr;
  }
});

// ── THE READ IS BOUNDED BY THE WINDOW, NOT BY ALL HISTORY ────────────────────────────────────
//
// MEASURED on the operator's mini at 2026-08-12: 670 corpus files, 4,309,016 raw lines, 2.78 GiB
// decompressed, and a peak RSS of 1.8–2.7 GiB per run against node's ~4 GiB default old-space.
// 649 of the 669 rotations were written in a SINGLE TWO-DAY BURST on 2026-07-22/23 and carry 97%
// of those lines — so the corpus is not a steady accumulation, it is one spike, and the whole
// spike crosses the default 30-day line on 2026-08-21. From that moment the old reader would
// decompress, split and regex 4.2M lines whose every `ts` loses the very next comparison.

test("rotationStampIso recovers a rotation's instant from its name, and refuses everything that is not one", () => {
  // The exact inverse of `datedArchivePath`'s `toISOString().replace(/[:.]/g, "-")`.
  assert.equal(rotationStampIso("ledger.2026-07-22T21-26-36-052Z.ndjson.gz"), "2026-07-22T21:26:36.052Z");
  assert.equal(rotationStampIso("ledger.2026-08-12T03-45-46-798Z.ndjson"), "2026-08-12T03:45:46.798Z");
  // THE OTHER DIRECTION, and it is the load-bearing half: anything undated is `undefined`, which
  // the caller must read as "cannot decide, so READ it". Skipping on an unparseable name would
  // silently drop a real corpus file.
  assert.equal(rotationStampIso("ledger.ndjson"), undefined, "the live ledger is never a rotation");
  assert.equal(rotationStampIso("ledger-archive.txt"), undefined);
  assert.equal(rotationStampIso("ledger.2026-07-22.ndjson"), undefined, "a partial stamp is not a stamp");
  assert.equal(rotationStampIso("service-tokens.json"), undefined);
});

test("a rotation stamped before the cutoff is SKIPPED unread, and the answer is unchanged", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-emissions-window-"));
  try {
    const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
    const stamp = (isoTs: string) => isoTs.replace(/[:.]/g, "-");
    const row = (isoTs: string, step: string) => `${JSON.stringify({ ts: isoTs, step })}\n`;
    const recent = iso(2 * 864e5);
    const ancient = iso(400 * 864e5);
    // IN window, and its own name is inside the cutoff.
    writeFileSync(join(dir, `ledger.${stamp(iso(1 * 864e5))}.ndjson`), row(recent, "daemon.poll"));
    // OUT of window by its NAME. Its body is deliberately in-window-looking garbage that would
    // change the count if it were ever read — a rotation cannot contain a line newer than its own
    // stamp in reality, so this fixture can only be reached by a reader that ignored the name.
    writeFileSync(join(dir, `ledger.${stamp(ancient)}.ndjson`), row(recent, "daemon.poll") + row(recent, "sweep.disposed"));
    // No stamp at all ⇒ ALWAYS read.
    writeFileSync(join(dir, "ledger.ndjson"), row(recent, "sweep.disposed"));

    const lines: string[] = [];
    const realLog = console.log;
    console.log = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
    try {
      assert.equal(emissionsCommand([], { stateDir: dir }), 0);
    } finally {
      console.log = realLog;
    }
    const out = lines.join("\n");
    assert.match(out, /3 ledger file\(s\) \(2 within the window, 1 skipped as older\)/, "the skip is REPORTED, never silent");
    assert.match(out, /2 lines scanned/, "only the two in-window files were read");
    assert.match(out, /2 distinct in-window events/, "one daemon.poll and one sweep.disposed — the skipped file's copies never arrived");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("THE OTHER DIRECTION: with no skippable rotation the read is byte-for-byte what it always was", () => {
  // The no-op proof. At today's default window on the real host this is the live case — 670 files,
  // 0 skipped — so the fix must be invisible until the corpus outgrows the window.
  const dir = mkdtempSync(join(tmpdir(), "rmd-emissions-nowindow-"));
  try {
    const isoTs = new Date(Date.now() - 2 * 864e5).toISOString();
    const stamp = new Date(Date.now() - 1 * 864e5).toISOString().replace(/[:.]/g, "-");
    writeFileSync(join(dir, `ledger.${stamp}.ndjson`), `${JSON.stringify({ ts: isoTs, step: "daemon.poll" })}\n`);
    writeFileSync(join(dir, "ledger.ndjson"), `${JSON.stringify({ ts: isoTs, step: "sweep.disposed" })}\n`);
    const lines: string[] = [];
    const realLog = console.log;
    console.log = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
    try {
      assert.equal(emissionsCommand([], { stateDir: dir }), 0);
    } finally {
      console.log = realLog;
    }
    const out = lines.join("\n");
    assert.match(out, /2 ledger file\(s\) \(2 within the window, 0 skipped as older\)/);
    assert.match(out, /2 lines scanned/);
    assert.match(out, /2 distinct in-window events/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("emissionsCommand renders the real report over the real corpus", () => {
  // Drives the WHOLE body — derivation, attribution, the ledger scan, the render — against this
  // checkout and this host's ledger. Read-only: it writes nothing and spawns nothing.
  const lines: string[] = [];
  const realLog = console.log;
  console.log = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  let code: number;
  try {
    code = emissionsCommand([]);
  } finally {
    console.log = realLog;
  }
  const out = lines.join("\n");
  assert.equal(code, 0);
  assert.match(out, /^rmd emissions — window 30d/m);
  assert.match(out, /corpus\s+: \d+ ledger file\(s\)/);
  // W1-T2479: "declared" (COMMANDS.length) and "scanned" (deriveCliVerbs's own count) are printed
  // separately — assertVerbScanAgreesWithRegistry has already asserted they're equal by this
  // point, but the report states its own corpus check rather than collapsing to one number.
  assert.match(out, /verbs\s+: \d+ declared, \d+ scanned, \d+ measurable, \d+ unauditable/);
  // The false-positive lock, against the LIVE corpus rather than a fixture: the daemon and the
  // sweep run constantly, so neither may ever be classified as dead here.
  //
  // CONDITIONAL ON THERE BEING A CORPUS, and that is not a hedge. `state/` is gitignored, so a CI
  // checkout has ZERO ledger files and EVERY verb correctly reads as unreachable — asserting the
  // opposite there tests the runner's filesystem, not this code. The shape assertions above hold
  // on any corpus; this one is a statement about a host that has actually run the fleet, so it is
  // gated on the report's own corpus count rather than on an assumption about where it runs.
  const corpusFiles = Number(/corpus\s+: (\d+) ledger file\(s\)/.exec(out)?.[1] ?? "0");
  if (corpusFiles > 0) {
    assert.doesNotMatch(out, /UNREACHABLE-IN-PRACTICE\s+rmd (daemon|sweep)\b/);
  }
  assert.match(out, /UNAUDITABLE \(no ledger step carries the verb's name\)/);
});

test("an unreadable ledger file is skipped, not a crash — the corrupted-corpus arm", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-emissions-bad-"));
  // A DIRECTORY named like a ledger file: ledgerCorpusFiles lists it, readFileSync throws EISDIR.
  mkdirSync(join(dir, "ledger.2026-07-01T00-00-00-000Z.ndjson"));
  writeFileSync(join(dir, "ledger.ndjson"), `{"ts":"${new Date().toISOString()}","step":"sweep.started"}\n`);
  const lines: string[] = [];
  const realLog = console.log;
  console.log = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  let code: number;
  try {
    code = emissionsCommand([], { stateDir: dir });
  } finally {
    console.log = realLog;
  }
  assert.equal(code, 0, "an unreadable file must be skipped, never thrown");
  assert.match(lines.join("\n"), /corpus\s+: 2 ledger file\(s\)/);
  rmSync(dir, { recursive: true, force: true });
});
