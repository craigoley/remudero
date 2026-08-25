/**
 * A FIXTURE MUST OWN ITS CONDITION — A STRUCTURAL WALK OF `test/`, NOT ANOTHER BRIEF.
 *
 * THE CONVENTION THIS REPLACES, and `test/spawn-guard.test.ts` already made this exact argument one
 * level down: its old protection was "successive briefs telling each session not to run that file —
 * a convention that depends on every future reader of every future brief, and that has already
 * failed once", and it was replaced by a structural walk so "a new site added without the guard
 * fails the build, which is what stops this decaying back into a convention."
 *
 * HERE THE CONVENTION IS "remember that a test can be host-dependent," and its record is measured:
 * NINE encounters, EIGHT independent rediscoveries, ZERO durable entries. Eight test files each
 * carry a prose comment explaining the trap, written by people who did not know the others existed,
 * and two of them assert "three suites in this repo already fail in a container" WITHOUT LISTING
 * WHICH THREE. This file lists them.
 *
 * ── WHAT IT COVERS: THE GREPPABLE HALF, AND ONLY THAT ────────────────────────────────────────────
 *
 * FOUR textual properties, each with a countable population today, which is what makes this a
 * ratchet rather than an aspiration. Every allowlist below declares TODAY'S sites with a reason; a
 * new one fails the build.
 *
 * ── WHAT IT CANNOT COVER, AND A READER MUST NOT TRUST IT FURTHER ─────────────────────────────────
 *
 * THREE INSTANCES HAVE NO GREPPABLE TOKENS AT ALL, and each was MEASURED to have none:
 *
 *   - #1645. `MUTANT (defect 4)` in `test/entrypoint-boot.test.ts` asserted a commit must FAIL with
 *     no git identity configured. Git does not guarantee that: it guesses `user@fqdn` from the
 *     passwd entry and `gethostname`, and ACCEPTS the guess when the hostname looks domain-like.
 *     Tailscale MagicDNS gives the mini one, so the mutant passed there and the assertion inverted.
 *     Grepping that test's body for `hostname`, `/usr/bin`, `getuid`, `process.platform`,
 *     `process.env.HOME` or `chmod` returns ZERO.
 *   - #892. `test/serve.*.test.ts` died on a Chromium revision the review host had never installed,
 *     and the whole-file proof's exit code posted it as `executed_fail` on code `ci` was passing.
 *     W1-T202 burned FIVE identical FAIL rounds on it. Also zero greppable tokens.
 *   - #1693, THE THIRD FORM: A HELPER THAT SPAWNS WITHOUT PINNING `HOME`. `printWithState`
 *     (test/host-update-reclaim.test.ts) pinned only `RMD_STATE_DIR`, so when a NEW credential check
 *     inside `deploy/host-update.sh` began reading `~/.claude`, the ambient home decided a test that
 *     asserts on the STATE VOLUME and happens to add `doesNotMatch(/WARNING/)`. Green on the mini,
 *     which has a real credential; red on a runner, which does not. THE IDIOM EXISTED BESIDE THE
 *     DEFECT — the credential cases in that same file already pinned `RMD_CLAUDE_DIR` through
 *     `printWithPaths`; only the volume helper inherited. USE THE PINNING HELPER.
 *     WHY THERE IS NO PREDICATE FOR IT, measured: 36 test files pass an inline `env:` object and only
 *     8 set `HOME:`, so a check keyed on `spawns without pinning HOME` flags 28 files that inherit
 *     legitimately for git, npm or tsx. And the coupling is not in `test/` at all — it is between a
 *     shell script's new behaviour and a helper's env, added in different commits, so no walk of this
 *     directory can connect them. A guard here would have been a false positive for months and still
 *     missed the day it mattered.
 *
 * ALL THREE ENTERED THROUGH A CHILD PROCESS'S OWN VIEW OF A WORLD THE TEST NEVER MENTIONS. No sweep of
 * `test/` can see that class, and this one does not claim to. THE INSTRUMENT FOR THE OTHER HALF IS
 * RUNNING THE SUITE ON BOTH POLES AND DIFFING THE FAILURE SETS (PR #1659) — this walk is the cheap,
 * fast complement that stops the greppable forms from accumulating between those runs. BE PRECISE
 * ABOUT WHICH DIRECTION THAT INSTRUMENT COVERS: `HOST_PARITY_BASELINE`'s mini pole is automated, its
 * ci pole is DECLARED BY HAND (the `ci` job publishes no machine-readable failure set), and #1693
 * failed on the ci side — so CI going red on first push, not host-parity, is what caught it.
 * THE CHEAP SWEEP FOR THIS FORM IS NOT A PREDICATE BUT A RUN: the whole suite with `HOME` pointed at
 * an empty directory, diffed against a normal run. MEASURED at d4179ae — 50 tests move, of which 48
 * are the harness's OWN artefact (Playwright's browser cache lives under `$HOME`; pin
 * `PLAYWRIGHT_BROWSERS_PATH` and they vanish), leaving exactly ONE genuine dependant:
 * `emissionsCommand renders the real report over the real corpus`, which is already declared. That
 * run cannot see a test passing on BOTH homes for two different reasons, which is the form nothing
 * here detects.
 *
 * ── NOT A MIGRATION ──────────────────────────────────────────────────────────────────────────────
 *
 * The existing fixtures are declared, NOT rewritten. Two of the chmod sites are MEASURED VACUOUS
 * under uid 0 — a readable empty root returns byte-for-byte what the REGRESSION LOCK asserts, and
 * `newestActivityMs` with the `0o600` omitted still satisfies both its assertions — but fixing them
 * is separate work with its own evidence, and a ratchet that also migrates is two changes wearing
 * one hat.
 *
 * THE REMEDY EACH `chmod` REASON POINTS AT was discovered twice INDEPENDENTLY in this repo, which is
 * the whole reason it is written down here: `test/worker-credential-preflight.test.ts` uses a
 * DIRECTORY at the credential path (EISDIR) and `test/deploy-idle-unknown.test.ts` uses a FILE where
 * a directory is expected (ENOTDIR). Both throw for every uid on both platforms, so neither degrades
 * to the readable case under root. A third author should find the answer here rather than re-derive
 * it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * THIS FILE IS THE ONE EXCLUSION, because its own synthetic corpora contain every token it hunts
 * for. The exclusion is a SET and a test below asserts it holds exactly this one member — widening
 * it is therefore itself a visible change, which is the property a bare `if (file === self)` would
 * not have.
 */
const EXCLUDED_FROM_WALK: readonly string[] = ["host-capability-fixtures.test.ts"];

/** One observed use of a host capability: `kind` says which property, `key` says which variant. */
interface Site {
  kind: "chmod" | "platform-tool" | "live-tree-git" | "unidentified-commit";
  file: string;
  key: string;
}

/**
 * One declared site-group, at the granularity argued in this file's PR: per (file, kind, key) with
 * an EXACT expected COUNT.
 *
 * WHY NOT PER-FILE: `test/worktree-reap-liveness.test.ts` already holds four of the eight chmod
 * sites, so a per-file entry would let it add a fifth silently — precisely the accumulation this
 * exists to stop. WHY NOT PER-LINE: line numbers drift on every edit above them and the allowlist
 * would rot into noise within a week. A count is per-site tight and per-file stable: moving a call
 * inside its file still passes, adding one does not. MEASURED CHURN over 90 days across all seven
 * files carrying a declared site: 14 commits total, 1–5 each — so the cost of the tighter form is a
 * handful of one-line allowlist edits a quarter.
 */
interface Declared {
  kind: Site["kind"];
  file: string;
  key: string;
  count: number;
  /** Why this site is acceptable. An entry with an empty reason is refused — a bare path list would
   *  rebuild the silent gap this check exists to close, which is `INSTRUMENT_SURFACE_EXCLUSIONS`'
   *  own stated design point (W1-T402) and `CI_PARITY_TABLE`'s (`mirrored: false` + `reason`). */
  reason: string;
}

const CHMOD_REMEDY =
  "Prefer a uid-independent denial: a DIRECTORY at a file path (EISDIR, test/worker-credential-preflight.test.ts) " +
  "or a FILE where a directory is expected (ENOTDIR, test/deploy-idle-unknown.test.ts). Both throw for every uid.";

/**
 * TODAY'S POPULATION, re-measured at `70d52c2`. Queries, so the next author can re-run them:
 *   chmod           — depth-matched `chmodSync(` call sites whose mode's OWNER digit is not 7
 *   platform-tool   — `git grep -anE '/usr/bin/(date|stat|sed|readlink|du|find)' -- test/`
 *   live-tree-git   — a git spawn naming `origin/main` that reaches the LIVE checkout: no `-C`, and
 *                     either no `cwd:` at all or a `cwd:` naming a repo-root token
 *   unidentified-commit — a real-git file that commits with no `user.name`/`user.email`/`GIT_AUTHOR_*`
 */
const DECLARED: readonly Declared[] = [
  // ── chmod: root bypasses read/write denial, so these change meaning at uid 0 ────────────────
  {
    kind: "chmod",
    file: "worktree-reap-liveness.test.ts",
    key: "0o000",
    count: 3,
    reason:
      "unreadable-tree fixtures for the reaper's blind arms. TWO OF THESE ARE MEASURED VACUOUS UNDER uid 0 — a " +
      `readable empty root returns byte-for-byte the summary the REGRESSION LOCK asserts. Fixing them is separate work. ${CHMOD_REMEDY}`,
  },
  {
    kind: "chmod",
    file: "worktree-reap-liveness.test.ts",
    key: "0o600",
    count: 1,
    reason:
      "read-but-not-traverse on a DIRECTORY, so every stat of a child fails EACCES — the per-entry catch arm. Root " +
      `traverses regardless, and the test's own comment says "without this the arm never runs". ${CHMOD_REMEDY}`,
  },
  {
    kind: "chmod",
    file: "prune-liveness.test.ts",
    key: "0o500",
    count: 1,
    reason: `no-write on a subdirectory so the reaper's rmSync throws EACCES. Root writes anyway. ${CHMOD_REMEDY}`,
  },
  {
    kind: "chmod",
    file: "worker-home-poisoned-slot.test.ts",
    key: "0o500",
    count: 1,
    reason: `no-write on the link's PARENT so symlinkSync fails for real rather than by a stub. Root writes anyway. ${CHMOD_REMEDY}`,
  },
  {
    kind: "chmod",
    file: "spawn-nopid-diagnosis.test.ts",
    key: "0o644",
    count: 1,
    reason:
      "SAFE AT EVERY UID, and declared rather than excluded so the reasoning is on the record: POSIX grants root " +
      "execute permission only when SOME execute bit is set, and 0o644 has none — so the OS refuses to exec it for " +
      "root too. This is the shape to copy when a denial must survive a container.",
  },
  {
    kind: "chmod",
    file: "toolchain-refusal-errno.test.ts",
    key: "0o644",
    count: 2,
    reason:
      "SAFE AT EVERY UID, same shape as spawn-nopid-diagnosis.test.ts above: 0o644 has no execute bit at all, so " +
      "the OS refuses to exec it for root too (W1-T901). Both sites build a non-executable husk that the REAL " +
      "(uninjected) defaultCanExecute probe must report as a real EACCES — the whole point is that a stubbed " +
      "canExecute cannot falsify this, so it has to survive root.",
  },
  {
    kind: "chmod",
    file: "serve-plist.test.ts",
    key: "0o644",
    count: 1,
    reason:
      "not a denial fixture at all — it reproduces the mode launchd's own umask produces, so the boot path can be " +
      "shown to REPAIR it back to 0o600. Nothing is asserted to fail, so no uid changes the outcome.",
  },
  {
    kind: "chmod",
    file: "state-backup.test.ts",
    key: "0o600",
    count: 1,
    reason:
      "not a denial fixture at all — it seeds a service-token file at the mode worker-home.ts itself uses, so " +
      "restoreState can be shown to PRESERVE it (the test asserts the restored mode is 0o600). Nothing is asserted " +
      "to fail, and statSync(...).mode & 0o777 reads the same for every uid, so root changes no outcome here. " +
      "CHMOD_REMEDY does not apply: there is no denial to replace with EISDIR/ENOTDIR.",
  },
  {
    kind: "chmod",
    file: "check-proof-base.test.ts",
    key: "0o200",
    count: 1,
    reason:
      "W1-T912: simulates the base run's grep child COULD NOT EXECUTE (an environment gap, never a false " +
      "discrimination) — WRITE-ONLY so buildBaseProofDir's own writeFileSync still succeeds (baseCheckoutDir comes " +
      "back genuinely defined) but the grep spawn that needs READ access is refused. Neither EISDIR nor ENOTDIR " +
      "reaches this: both would fail the PRECEDING write too, which this fixture needs to succeed. Root bypasses " +
      `the read denial, so the covered branch is skipped rather than falsified there. ${CHMOD_REMEDY}`,
  },
  {
    kind: "chmod",
    file: "check-proof-base.test.ts",
    key: "0o600",
    count: 1,
    reason:
      "the same fixture's own teardown, restoring write+read on the 0o200 file above so rmSync can remove it — not " +
      `a denial itself, but paired with the site above and audited by the same depth-matched walk. ${CHMOD_REMEDY}`,
  },
  {
    kind: "chmod",
    file: "stale-git-config-lock.test.ts",
    key: "0o444",
    count: 1,
    reason:
      "W1-T1036: acceptance criterion 5 requires proving a read-only lock is removed by unlinkSync rather than " +
      "failing on an open-for-write — the test first pins that writeFileSync on the fixture throws EACCES, then " +
      "asserts reclaimStaleConfigLock still succeeds via unlink. Root bypasses the write denial, so the covered " +
      "branch (falling back from truncate to unlink) is merely unexercised there, never falsified. CHMOD_REMEDY " +
      "does not apply: EISDIR/ENOTDIR deny writeFileSync too, but they also deny the unlinkSync this test needs " +
      "to observe succeeding, so neither substitutes for a real read-only FILE.",
  },
  {
    kind: "chmod",
    file: "adoption-report-has-a-producer.test.ts",
    key: "0o000",
    count: 2,
    reason:
      "W1-T2266 SHAPE 2/3: the ONLY fixture that reaches the adoption walk's unreadable-file catch arm. " +
      "CHMOD_REMEDY does not apply, and the reason is mechanical rather than stylistic: walkAdoptionFiles " +
      "(src/lib/measurement-cadence.ts) pushes a child only on `e.isFile()`, so a DIRECTORY at the path — the " +
      "EISDIR shape — is skipped at ENUMERATION and never reaches the readFileSync whose catch degrades to \"\". " +
      "Substituting it would silently stop covering the branch, which is test theatre, not a safer fixture. " +
      "Root bypasses read denial, so at uid 0 the file IS read: the content is then seen as a real write, the " +
      "expected finding is absent, and the assertion FAILS LOUDLY. It does not go vacuous — the uid-0 failure " +
      "direction here is red, never green.",
  },
  {
    kind: "chmod",
    file: "adoption-report-has-a-producer.test.ts",
    key: "0o644",
    count: 2,
    reason:
      "The RESTORE half of the two 0o000 fixtures above, one per site, in each test's own `finally` — not a " +
      "denial at all. Unlike the 0o644 husks in spawn-nopid-diagnosis/toolchain-refusal-errno, nothing here " +
      "depends on the absent execute bit; these exist so rmSync can remove the fixture tree afterwards. They " +
      "disappear if and when the 0o000 sites do.",
  },
  // ── platform-varying real binaries ──────────────────────────────────────────────────────────
  {
    kind: "platform-tool",
    file: "fleet-heartbeat.test.ts",
    key: "/usr/bin/date",
    count: 4,
    reason:
      "the BSD_DATE and IGNORES_D stubs emulate a foreign `date` by DELEGATING the parse to /usr/bin/date. On macOS " +
      "that IS BSD date and rejects -d, so both tests fail on the mini and pass on a runner — two of the four " +
      "divergences the host-parity baseline declares. Linux-only by construction; the file's own header says the " +
      "branch has never run anywhere.",
  },
  // ── git against the LIVE checkout ───────────────────────────────────────────────────────────
  {
    kind: "live-tree-git",
    file: "recon-gaps-relayed.test.ts",
    key: "origin/main",
    count: 1,
    reason:
      "`git show origin/main:src/run-task.ts` against the repo root. .github/workflows/ci.yml uses actions/checkout " +
      "with NO fetch-depth, so origin/main does not exist as a ref on a runner: this passes on the mini and fails " +
      "there. The fix is a depth guarantee in the workflow, not here.",
  },
  // ── unidentified-commit has NO entries on purpose: the floor is zero and worth holding. ─────
];

/** Depth-matched call bodies for `name(` — `join(a, b)` inside an argument list must not truncate
 *  the match, which a `[^)]*` regex would do. */
function callBodies(text: string, name: string): string[] {
  const re = new RegExp(`\\b${name}\\s*\\(`, "g");
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    let i = m.index + m[0].length;
    let depth = 1;
    let body = "";
    while (i < text.length && depth > 0) {
      const c = text[i];
      if (c === "(") depth++;
      else if (c === ")") depth--;
      if (depth > 0) body += c;
      i++;
    }
    out.push(body);
  }
  return out;
}

/** Every host-capability site one file's TEXT reveals. Pure over (path, text) so the direction
 *  tests below can drive it with a synthetic corpus that never touches disk. */
export function scanForHostCapability(file: string, text: string): Site[] {
  const sites: Site[] = [];

  // (1) chmod to a mode whose OWNER digit is not 7 — something is being denied, and root may not
  // honour the denial. `mode:` options on a CREATE are excluded: writing a file 0o600 and reading it
  // back as the same user asserts nothing about permissions.
  for (const body of callBodies(text, "chmodSync")) {
    const mode = /0o([0-7]{3,4})/.exec(body);
    if (!mode) continue;
    const digits = mode[1] ?? "";
    const owner = Number(digits[digits.length - 3]);
    if (owner !== 7) sites.push({ kind: "chmod", file, key: `0o${digits}` });
  }

  // (2) a platform-varying real binary, invoked rather than merely named.
  const tool = /\/usr\/bin\/(date|stat|sed|readlink|du|find)\b/g;
  let t: RegExpExecArray | null;
  while ((t = tool.exec(text))) sites.push({ kind: "platform-tool", file, key: `/usr/bin/${t[1]}` });

  // (3)/(4) git spawns. A call reaches a FIXTURE repo through `-C <dir>` (or a `git(dir, …)` helper
  // that emits it) or through a `cwd:` naming a local temp dir. It reaches the LIVE checkout when it
  // names one of the repo-root tokens, or passes no target at all and inherits the runner's cwd.
  //
  // MEASURED, and the reason this is not simply "no -C": that cruder rule flagged
  // `test/status-board.test.ts`, which builds a real fixture repo and gives it `cwd: gitRoot` —
  // while MISSING nothing, since the one true positive names `import.meta.url` in its own `cwd:`.
  const spawnNames = ["execFileSync", "spawnSync", "execSync", "spawn", "execFile"];
  const gitBodies = spawnNames.flatMap((n) => callBodies(text, n)).filter((b) => /["']git["']/.test(b.slice(0, 40)));
  // NOT a `cwd:\s*<token>` anchor: the one true positive spells its cwd
  // `fileURLToPath(new URL("..", import.meta.url))`, and an anchored match stops at that inner
  // comma. Matching the token anywhere in the call body is what actually reads both idioms.
  const liveRootToken = /REPO_ROOT|repoRoot|process\.cwd\(\)|import\.meta\.url/;
  for (const body of gitBodies) {
    if (!/origin\/main/.test(body)) continue;
    if (/["']-C["']/.test(body)) continue;
    if (/\bcwd:/.test(body) && !liveRootToken.test(body)) continue;
    sites.push({ kind: "live-tree-git", file, key: "origin/main" });
  }
  const commits = gitBodies.some((b) => /["']commit["']|commit -m|commit -qm/.test(b));
  const identity = /user\.(name|email)|GIT_AUTHOR_NAME|GIT_COMMITTER_NAME/.test(text);
  if (commits && !identity) sites.push({ kind: "unidentified-commit", file, key: "commit" });

  return sites;
}

/** What the walk concluded. All three lists empty ⇒ the ratchet holds. */
interface Audit {
  /** Observed with no declaration at all — a new host-capability fixture. */
  undeclared: Site[];
  /** Declared, but the file now holds a different number of them. */
  miscounted: { declared: Declared; observed: number }[];
  /** Declared and NOT observed — either the fixture is gone (prune the entry) or the walk read
   *  nothing, which is the same signal and must never be silent. */
  unseen: Declared[];
}

/** The whole check, pure over a corpus. */
export function auditHostCapability(
  corpus: readonly { file: string; text: string }[],
  declared: readonly Declared[] = DECLARED,
): Audit {
  const observed = new Map<string, { site: Site; count: number }>();
  for (const { file, text } of corpus) {
    for (const site of scanForHostCapability(file, text)) {
      const k = `${site.kind} ${site.file} ${site.key}`;
      const prev = observed.get(k);
      if (prev) prev.count++;
      else observed.set(k, { site, count: 1 });
    }
  }
  const undeclared: Site[] = [];
  const miscounted: { declared: Declared; observed: number }[] = [];
  const seen = new Set<string>();
  for (const [k, { site, count }] of observed) {
    const d = declared.find((x) => x.kind === site.kind && x.file === site.file && x.key === site.key);
    if (!d) {
      undeclared.push(site);
      continue;
    }
    seen.add(k);
    if (d.count !== count) miscounted.push({ declared: d, observed: count });
  }
  const unseen = declared.filter((d) => !seen.has(`${d.kind} ${d.file} ${d.key}`));
  return { undeclared, miscounted, unseen };
}

/**
 * THE MESSAGE A PERSON MID-TASK ACTUALLY READS. It must say how to PASS, because a ratchet nobody
 * can satisfy gets deleted rather than satisfied — so it names the const to edit, demands a reason,
 * and offers the uid-independent remedy first so the cheapest way through is also the right one.
 */
export function explainAudit(audit: Audit): string {
  const lines: string[] = [];
  for (const s of audit.undeclared) {
    lines.push(
      `UNDECLARED host-capability fixture: ${s.kind} ${s.key} in test/${s.file}`,
      s.kind === "chmod"
        ? `  ${CHMOD_REMEDY}`
        : "  This changes what the test asserts depending on which machine runs it.",
      `  If it is genuinely needed, ADD AN ENTRY to DECLARED in test/host-capability-fixtures.test.ts:`,
      `    { kind: "${s.kind}", file: "${s.file}", key: "${s.key}", count: <n>, reason: "<why this is acceptable>" }`,
      "  The reason is the point — an entry without one is refused.",
    );
  }
  for (const { declared, observed } of audit.miscounted) {
    lines.push(
      `COUNT MOVED: test/${declared.file} declares ${declared.count} × ${declared.key} (${declared.kind}) and now has ${observed}.`,
      observed > declared.count
        ? `  A new site was added to an already-allowlisted file. ${declared.kind === "chmod" ? CHMOD_REMEDY : ""}`.trimEnd()
        : "  A site was removed — lower the count so the entry keeps meaning what it says.",
    );
  }
  for (const d of audit.unseen) {
    lines.push(
      `DECLARED BUT NOT FOUND: ${d.kind} ${d.key} in test/${d.file}.`,
      "  Either the fixture is gone (delete the entry) or this walk read nothing — a stale allowlist mutes the check.",
    );
  }
  return lines.join("\n");
}

/** The real corpus: every `test/*.ts`, read as TEXT, minus this file. */
function realCorpus(): { file: string; text: string }[] {
  return readdirSync(TEST_DIR)
    .filter((f) => f.endsWith(".ts") && !EXCLUDED_FROM_WALK.includes(f))
    .map((file) => ({ file, text: readFileSync(join(TEST_DIR, file), "utf8") }));
}

// ── THE WALK, AGAINST THE REAL TREE ───────────────────────────────────────────────────────────

test("today's population is exactly what DECLARED says it is", () => {
  const audit = auditHostCapability(realCorpus());
  assert.deepEqual(audit.undeclared, [], `\n${explainAudit(audit)}`);
  assert.deepEqual(audit.miscounted, [], `\n${explainAudit(audit)}`);
  assert.deepEqual(audit.unseen, [], `\n${explainAudit(audit)}`);
});

test("the walk really READ the tree — it saw hundreds of files and every declared site", () => {
  // A check that only asserts "no findings" passes on a walk that reads nothing. This is the
  // positive control on COVERAGE, not on readability.
  const corpus = realCorpus();
  assert.ok(corpus.length > 400, `the walk must see the whole suite, saw ${corpus.length}`);
  const sites = corpus.flatMap((c) => scanForHostCapability(c.file, c.text));
  assert.ok(sites.length >= DECLARED.reduce((n, d) => n + d.count, 0), "every declared site must be observed");
});

test("the floor holds: no test file commits through real git with no identity anywhere in it", () => {
  const offenders = realCorpus()
    .flatMap((c) => scanForHostCapability(c.file, c.text))
    .filter((s) => s.kind === "unidentified-commit");
  assert.deepEqual(offenders, [], "this population is ZERO today and the entry list is empty to hold it there");
});

// ── THE EMPTY-DIRECTORY CONTROL ───────────────────────────────────────────────────────────────

test("pointed at an EMPTY corpus the walk COMPLAINS rather than reporting clean", () => {
  // THE VACUOUS SHAPE this repo has caught repeatedly: a sweep that reads nothing reports nothing
  // and looks identical to a healthy tree. Every declared entry going unseen is the alarm.
  const audit = auditHostCapability([]);
  assert.deepEqual(audit.undeclared, []);
  assert.equal(audit.unseen.length, DECLARED.length, "an empty read must surface every declaration as missing");
  assert.match(explainAudit(audit), /DECLARED BUT NOT FOUND/);
  assert.match(explainAudit(audit), /this walk read nothing/);
});

// ── DIRECTION 1: A NEW UNDECLARED SITE FAILS ──────────────────────────────────────────────────

test("a NEWLY ADDED undeclared chmod fails, and the message says how to pass", () => {
  const corpus = [{ file: "brand-new.test.ts", text: 'chmodSync(join(dir, "x"), 0o000);\n' }];
  const audit = auditHostCapability(corpus, []);
  assert.deepEqual(audit.undeclared, [{ kind: "chmod", file: "brand-new.test.ts", key: "0o000" }]);
  const msg = explainAudit(audit);
  assert.match(msg, /UNDECLARED host-capability fixture: chmod 0o000 in test\/brand-new\.test\.ts/);
  assert.match(msg, /EISDIR/, "the remedy comes first — the cheapest way through must be the right one");
  assert.match(msg, /ADD AN ENTRY to DECLARED/, "and the gate must be passable, or it gets deleted");
  assert.match(msg, /reason: "<why this is acceptable>"/);
});

test("a FIFTH site in an already-allowlisted file fails on the COUNT — per-file would miss it", () => {
  // The argument for this granularity, made executable: worktree-reap-liveness already holds four
  // of the eight chmod sites.
  const declared: Declared[] = [
    { kind: "chmod", file: "a.test.ts", key: "0o000", count: 1, reason: "declared for this fixture" },
  ];
  const audit = auditHostCapability([{ file: "a.test.ts", text: "chmodSync(x, 0o000); chmodSync(y, 0o000);" }], declared);
  assert.deepEqual(audit.undeclared, [], "the KIND is allowlisted…");
  assert.equal(audit.miscounted.length, 1, "…but the count moved");
  assert.equal(audit.miscounted[0]?.observed, 2);
  assert.match(explainAudit(audit), /COUNT MOVED: test\/a\.test\.ts declares 1 × 0o000 \(chmod\) and now has 2\./);
  assert.match(explainAudit(audit), /A new site was added to an already-allowlisted file/);
});

test("each of the other three properties fails when newly introduced", () => {
  const cases: { text: string; kind: Site["kind"]; key: string }[] = [
    { text: 'const stub = "exec /usr/bin/date -u -d";', kind: "platform-tool", key: "/usr/bin/date" },
    {
      text: 'execFileSync("git", ["show", "origin/main:src/x.ts"], { cwd: REPO_ROOT });',
      kind: "live-tree-git",
      key: "origin/main",
    },
    { text: 'execFileSync("git", ["commit", "-qm", "x"], { cwd: d });', kind: "unidentified-commit", key: "commit" },
  ];
  for (const c of cases) {
    const audit = auditHostCapability([{ file: "n.test.ts", text: c.text }], []);
    assert.deepEqual(audit.undeclared, [{ kind: c.kind, file: "n.test.ts", key: c.key }], c.kind);
  }
});

// ── DIRECTION 2: THE LEGITIMATE SHAPES STAY SILENT ────────────────────────────────────────────

test("THE OTHER DIRECTION: a fixture repo, an owner-7 chmod and an identified commit are all clean", () => {
  // If these ever started failing, the ratchet would be unsatisfiable and would be deleted rather
  // than obeyed — which is how the convention came back last time.
  const corpus = [
    { file: "ok.test.ts", text: 'chmodSync(p, 0o755);\nexecFileSync("git", ["-C", dir, "show", "origin/main:x"]);' },
    {
      file: "ok2.test.ts",
      text: 'execFileSync("git", ["-C", d, "-c", "user.email=t@t", "commit", "-qm", "x"]);',
    },
    { file: "ok3.test.ts", text: 'const GIT_ENV = { GIT_AUTHOR_NAME: "t" };\nexecFileSync("git", ["commit"], { env: GIT_ENV });' },
    { file: "ok4.test.ts", text: 'writeFileSync(p, body, { mode: 0o600 });' },
    // MEASURED false positive of the cruder "no -C" rule: test/status-board.test.ts builds a real
    // fixture repo and addresses it by `cwd:`, never `-C`. A guard that flagged this would be
    // unsatisfiable for a whole legitimate idiom.
    {
      file: "ok5.test.ts",
      text: 'execFileSync("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], { cwd: gitRoot });',
    },
  ];
  assert.deepEqual(auditHostCapability(corpus, []).undeclared, [], "no legitimate shape may be flagged");
});

// ── THE ALLOWLIST ITSELF ──────────────────────────────────────────────────────────────────────

test("every declaration names a real file, a positive count, and a reason worth reading", () => {
  for (const d of DECLARED) {
    assert.ok(readFileSync(join(TEST_DIR, d.file), "utf8").length > 0, `${d.file} must exist`);
    assert.ok(d.count > 0, `${d.file} ${d.key} must declare a positive count`);
    assert.ok(d.reason.trim().length > 40, `${d.file} ${d.key} must say WHY`);
  }
});

test("the walk excludes exactly ONE file — itself — so widening the hole is a visible change", () => {
  assert.deepEqual(EXCLUDED_FROM_WALK, ["host-capability-fixtures.test.ts"]);
  assert.ok(
    !realCorpus().some((c) => c.file === "host-capability-fixtures.test.ts"),
    "and the exclusion is really applied — this file's own synthetic corpora carry every hunted token",
  );
});
