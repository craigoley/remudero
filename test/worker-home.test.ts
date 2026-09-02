import assert from "node:assert/strict";
import fs, {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { test } from "node:test";

import { workerHomeDir, type Config } from "../src/lib/config.js";
import { playwrightCacheRoot } from "../src/lib/review.js";
import {
  CLAUDE_CONFIG_BACKUP_PREFIX,
  CLAUDE_CONFIG_REL,
  WORKER_CLAUDE_CREDENTIAL_DIR_RELPATH,
  WORKER_HOME_RC_FILES,
  WORKER_HOME_SYMLINKS,
  WorkerHomePlacementError,
  ensureWorkerKeychain,
  gitWorkTreeAncestor,
  keychainProvisionLockPath,
  materializeWorkerHome,
  perRunWorkerHomeDir,
  playwrightCacheRelPath,
  sweepClaudeConfigBackups,
  workerHomePlan,
  workerKeychainPaths,
} from "../src/lib/worker-home.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "rmd-workerhome-"));
}

// ── workerHomePlan: PURE, no filesystem — the redirection logic itself ──────

test("workerHomePlan: every rc file lives under the INJECTED workerHome, never realHome", () => {
  const plan = workerHomePlan({ workerHome: "/scratch/worker-home", realHome: "/Users/operator" });
  assert.equal(plan.rcFiles.length, WORKER_HOME_RC_FILES.length);
  for (const rc of plan.rcFiles) {
    assert.ok(rc.startsWith("/scratch/worker-home/"), `${rc} must live under the redirected HOME`);
  }
  assert.ok(plan.rcFiles.some((f) => f.endsWith(".bashrc")), "bash's rc must be covered");
  assert.ok(plan.rcFiles.some((f) => f.endsWith(".zshrc")), "zsh's rc must be covered");
});

test("workerHomePlan: symlinks map each ALLOWLISTED path from the real HOME into the redirected HOME", () => {
  const plan = workerHomePlan({ workerHome: "/scratch/worker-home", realHome: "/Users/operator" });
  assert.equal(plan.symlinks.length, WORKER_HOME_SYMLINKS.length);
  const byRel = Object.fromEntries(plan.symlinks.map((s) => [s.from.replace("/scratch/worker-home/", ""), s]));
  assert.equal(byRel[".claude"].to, "/Users/operator/.claude");
  assert.equal(byRel[".config/gh"].to, "/Users/operator/.config/gh");
  assert.equal(byRel[".gitconfig"].to, "/Users/operator/.gitconfig");
  for (const s of plan.symlinks) {
    assert.ok(s.from.startsWith("/scratch/worker-home/"), "symlink source must live under the redirected HOME");
    assert.ok(s.to.startsWith("/Users/operator/"), "symlink target must resolve under the REAL home");
    assert.ok(s.reason.length > 0, "every grant states why it exists (allowlist discipline)");
  }
});

test("workerHomePlan: the macOS login keychain is symlinked back — the OAuth token is HOME-relative (W1-T18 spawn-deadlock fix)", () => {
  const plan = workerHomePlan({ workerHome: "/scratch/worker-home", realHome: "/Users/operator" });
  const kc = plan.symlinks.find((s) => s.from.endsWith("/Library/Keychains/login.keychain-db"));
  assert.ok(kc, "the login keychain (Claude Code-credentials OAuth token) must be granted back, or a redirected HOME hides it and the worker exits 'Not logged in' at $0 before any turn");
  assert.equal(kc!.to, "/Users/operator/Library/Keychains/login.keychain-db", "must point at the REAL login keychain");
  assert.match(kc!.reason, /keychain|OAuth/i, "the grant states why the keychain is needed");
  // MINIMALITY, STATED AS THE PROPERTY RATHER THAN AS A COUNT (W1-T1063). The invariant this
  // guards is "never grant a broad swathe of ~/Library" — it was encoded as `length === 1` while
  // the keychain was the only Library grant, and the browser-cache grant made that encoding wrong
  // without making the invariant wrong. So assert the invariant itself: every Library grant is a
  // NAMED LEAF, and neither `Library` nor `Library/Caches` is ever granted wholesale.
  const libGrants = plan.symlinks.filter((s) => s.from.includes("/Library/"));
  const expectedLibLeaves = ["Library/Keychains/login.keychain-db", "Library/Caches/ms-playwright"];
  for (const g of libGrants) {
    assert.ok(
      expectedLibLeaves.some((leaf) => g.from.endsWith(`/${leaf}`)),
      `unexpected ~/Library grant ${g.from} — a new one must be added here deliberately, never by accident`,
    );
  }
  for (const broad of ["/Library", "/Library/Caches", "/Library/Keychains"]) {
    assert.equal(
      plan.symlinks.some((s) => s.from.endsWith(broad)),
      false,
      `the whole ${broad} must never be granted — only named leaves beneath it`,
    );
  }
});

// ── materializeWorkerHome: given an INJECTED HOME, isolation holds on disk ──

test("materializeWorkerHome: every rc file is created and EMPTY under the injected workerHome (isolation independent of operator dotfiles)", () => {
  const workerHome = tmp();
  const realHome = tmp();
  try {
    materializeWorkerHome({ workerHome, realHome });
    for (const rc of WORKER_HOME_RC_FILES) {
      const p = join(workerHome, rc);
      assert.ok(existsSync(p), `${rc} must exist under the redirected HOME`);
      assert.equal(readFileSync(p, "utf8"), "", `${rc} must be empty`);
    }
  } finally {
    rmSync(workerHome, { recursive: true, force: true });
    rmSync(realHome, { recursive: true, force: true });
  }
});

test("materializeWorkerHome: truncates a PLANTED alias in the injected workerHome's rc — never trusts leftovers as clean", () => {
  const workerHome = tmp();
  const realHome = tmp();
  try {
    // Simulate a stranger's populated ~/.bashrc landing in the slot Remudero owns.
    writeFileSync(join(workerHome, ".bashrc"), "alias ls='ls -la'\n");
    materializeWorkerHome({ workerHome, realHome });
    assert.equal(readFileSync(join(workerHome, ".bashrc"), "utf8"), "", "the planted alias must be wiped, not appended to");
  } finally {
    rmSync(workerHome, { recursive: true, force: true });
    rmSync(realHome, { recursive: true, force: true });
  }
});

test("materializeWorkerHome: the auth-path symlinks (.claude, .config/gh, .gitconfig) resolve UNDER the redirected HOME to the real HOME's paths", () => {
  const workerHome = tmp();
  const realHome = tmp();
  try {
    // Fixture: the real HOME carries the three grants a worker needs back.
    mkdirSync(join(realHome, ".claude"), { recursive: true });
    writeFileSync(join(realHome, ".claude", "session.json"), "{}");
    mkdirSync(join(realHome, ".config", "gh"), { recursive: true });
    writeFileSync(join(realHome, ".config", "gh", "hosts.yml"), "github.com: {}\n");
    writeFileSync(join(realHome, ".gitconfig"), "[user]\n\tname = Test\n");

    materializeWorkerHome({ workerHome, realHome });

    for (const rel of [".claude", join(".config", "gh"), ".gitconfig"]) {
      const from = join(workerHome, rel);
      const st = lstatSync(from);
      assert.ok(st.isSymbolicLink(), `${rel} must be a symlink under the redirected HOME`);
      assert.equal(readlinkSync(from), join(realHome, rel), `${rel} must resolve to the REAL home's path`);
    }
    // And the content is genuinely reachable through the redirected HOME.
    assert.equal(readFileSync(join(workerHome, ".gitconfig"), "utf8"), "[user]\n\tname = Test\n");
  } finally {
    rmSync(workerHome, { recursive: true, force: true });
    rmSync(realHome, { recursive: true, force: true });
  }
});

test("materializeWorkerHome: a grant absent on the real HOME (e.g. gh never configured) is skipped, never thrown", () => {
  const workerHome = tmp();
  const realHome = tmp(); // empty — no .claude, no gh, no gitconfig
  try {
    assert.doesNotThrow(() => materializeWorkerHome({ workerHome, realHome }));
    assert.equal(existsSync(join(workerHome, ".claude")), false);
    assert.equal(existsSync(join(workerHome, ".config", "gh")), false);
    assert.equal(existsSync(join(workerHome, ".gitconfig")), false);
  } finally {
    rmSync(workerHome, { recursive: true, force: true });
    rmSync(realHome, { recursive: true, force: true });
  }
});

test("materializeWorkerHome: idempotent across repeated spawns in the same run — a second call does not throw and rc files stay empty", () => {
  const workerHome = tmp();
  const realHome = tmp();
  try {
    mkdirSync(join(realHome, ".claude"), { recursive: true });
    materializeWorkerHome({ workerHome, realHome });
    assert.doesNotThrow(() => materializeWorkerHome({ workerHome, realHome }));
    assert.equal(readFileSync(join(workerHome, ".bashrc"), "utf8"), "");
    assert.ok(lstatSync(join(workerHome, ".claude")).isSymbolicLink());
  } finally {
    rmSync(workerHome, { recursive: true, force: true });
    rmSync(realHome, { recursive: true, force: true });
  }
});

test("materializeWorkerHome: self-heals a symlink pointing at a STALE real-HOME path", () => {
  const workerHome = tmp();
  const realHome = tmp();
  const staleTarget = tmp();
  try {
    mkdirSync(join(workerHome), { recursive: true });
    symlinkSync(staleTarget, join(workerHome, ".claude")); // pre-existing, wrong target
    mkdirSync(join(realHome, ".claude"), { recursive: true });

    materializeWorkerHome({ workerHome, realHome });

    assert.equal(readlinkSync(join(workerHome, ".claude")), join(realHome, ".claude"), "must repoint at the current real HOME");
  } finally {
    rmSync(workerHome, { recursive: true, force: true });
    rmSync(realHome, { recursive: true, force: true });
    rmSync(staleTarget, { recursive: true, force: true });
  }
});

// ── W1-T505: narrow the `.claude` grant to a credential-only sibling ───────
//
// Today's grant hands a worker the operator's WHOLE `.claude` (measured 1.8GB: 10,101
// session transcripts, a writable `settings.json` that can inject env vars into the
// operator's NEXT session, `history.jsonl`, `skills/`, `plugins/`) to reach one 509-byte
// `.credentials.json`. These four tests are the task's own falsifier, both directions:
// present, the narrowed grant resolves a credential and hides everything else; absent,
// today's wholesale behaviour still spawns a worker rather than refusing.

test("W1-T505: the narrowed grant still resolves a readable credential", () => {
  const workerHome = tmp();
  const realHome = tmp();
  try {
    const credOnlyDir = join(realHome, WORKER_CLAUDE_CREDENTIAL_DIR_RELPATH);
    mkdirSync(credOnlyDir, { recursive: true });
    writeFileSync(join(credOnlyDir, ".credentials.json"), '{"claudeAiOauth":{"accessToken":"x"}}');
    // The operator's real .claude also exists, to prove the narrowed sibling wins.
    mkdirSync(join(realHome, ".claude"), { recursive: true });

    materializeWorkerHome({ workerHome, realHome });

    const credPath = join(workerHome, ".claude", ".credentials.json");
    assert.equal(
      readFileSync(credPath, "utf8"),
      '{"claudeAiOauth":{"accessToken":"x"}}',
      "the credential must be readable through the redirected HOME's .claude slot",
    );
    assert.equal(
      readlinkSync(join(workerHome, ".claude")),
      credOnlyDir,
      "the .claude slot must resolve to the credential-only sibling, not the operator's whole .claude",
    );
  } finally {
    rmSync(workerHome, { recursive: true, force: true });
    rmSync(realHome, { recursive: true, force: true });
  }
});

test("W1-T505: a narrowed worker home cannot reach projects history or settings", () => {
  const workerHome = tmp();
  const realHome = tmp();
  try {
    const credOnlyDir = join(realHome, WORKER_CLAUDE_CREDENTIAL_DIR_RELPATH);
    mkdirSync(credOnlyDir, { recursive: true });
    writeFileSync(join(credOnlyDir, ".credentials.json"), "{}");
    // The operator's real .claude carries exactly the surfaces the task names.
    mkdirSync(join(realHome, ".claude", "projects", "some-project"), { recursive: true });
    writeFileSync(join(realHome, ".claude", "history.jsonl"), "operator prompt history\n");
    writeFileSync(join(realHome, ".claude", "settings.json"), '{"env":{"INJECTED":"1"}}');

    materializeWorkerHome({ workerHome, realHome });

    assert.equal(existsSync(join(workerHome, ".claude", "projects")), false, "projects/ must not be reachable");
    assert.equal(existsSync(join(workerHome, ".claude", "history.jsonl")), false, "history.jsonl must not be reachable");
    assert.equal(existsSync(join(workerHome, ".claude", "settings.json")), false, "settings.json must not be reachable");
  } finally {
    rmSync(workerHome, { recursive: true, force: true });
    rmSync(realHome, { recursive: true, force: true });
  }
});

test("W1-T505: an absent credential-only directory falls back rather than refusing", () => {
  const workerHome = tmp();
  const realHome = tmp();
  try {
    // Today's shape only: no .claude-fleet sibling has been populated on this host yet.
    mkdirSync(join(realHome, ".claude"), { recursive: true });
    writeFileSync(join(realHome, ".claude", ".credentials.json"), "{}");
    assert.equal(existsSync(join(realHome, WORKER_CLAUDE_CREDENTIAL_DIR_RELPATH)), false, "fixture precondition");

    assert.doesNotThrow(() => materializeWorkerHome({ workerHome, realHome }), "a missing narrowed dir must not refuse to spawn");

    const claudeLink = join(workerHome, ".claude");
    assert.ok(lstatSync(claudeLink).isSymbolicLink(), "the worker still gets a .claude grant");
    assert.equal(
      readlinkSync(claudeLink),
      join(realHome, ".claude"),
      "falls back to today's wholesale grant when the narrowed sibling is absent",
    );
  } finally {
    rmSync(workerHome, { recursive: true, force: true });
    rmSync(realHome, { recursive: true, force: true });
  }
});

test("W1-T505: the narrowed grant is writable not read only", () => {
  const workerHome = tmp();
  const realHome = tmp();
  try {
    const credOnlyDir = join(realHome, WORKER_CLAUDE_CREDENTIAL_DIR_RELPATH);
    mkdirSync(credOnlyDir, { recursive: true });
    writeFileSync(join(credOnlyDir, ".credentials.json"), "{}");

    materializeWorkerHome({ workerHome, realHome });

    // The token self-refreshes and is rewritten IN PLACE (deploy/host-update.sh's own
    // rationale) — a write through the redirected HOME's slot must land on the real
    // credential-only sibling, which only holds if the grant is read-write, not `:ro`.
    writeFileSync(join(workerHome, ".claude", ".credentials.json"), '{"refreshed":true}');
    assert.equal(
      readFileSync(join(credOnlyDir, ".credentials.json"), "utf8"),
      '{"refreshed":true}',
      "a refresh write through the worker-home slot must reach the real credential-only directory",
    );
  } finally {
    rmSync(workerHome, { recursive: true, force: true });
    rmSync(realHome, { recursive: true, force: true });
  }
});

// ── W1-T339: the steady-state ensureWorkerKeychain path stays LOCK-FREE ─────
//
// The provisioning branch (absent/identity-changed/expired store) is what W1-T339
// serializes with an exclusive lock -- see test/worker-keychain-account.test.ts for
// that. This is the OTHER half of the claim: a call that finds a present,
// identity-matching, unexpired store must take NO lock at all, so the overwhelming
// majority of dispatches never pay for a mutex they don't need.

const STEADY_STATE_LOGIN = "/Users/operator/Library/Keychains/login.keychain-db";

test("W1-T339: the steady-state path (present, identity-matching, unexpired store) stays LOCK-FREE — no provisioning lock file is ever opened, and no credential is read", (t) => {
  const root = tmp();
  try {
    const paths = workerKeychainPaths(join(root, "state"));
    mkdirSync(join(root, "state"), { recursive: true });
    // A store a PRIOR call already provisioned: present, identity recorded, and a
    // far-future expiry -- exactly the steady-state gate this claim is about. No
    // ensureWorkerKeychain call is made to set this up, so the ONLY call under test
    // is the steady-state one whose lock-freedom is being asserted.
    writeFileSync(paths.keychainPath, "not a real keychain database, just needs to exist\n");
    writeFileSync(paths.identityPath, "acct-1", { mode: 0o600 });
    writeFileSync(paths.expiryPath, String(Date.now() + 24 * 60 * 60 * 1000), { mode: 0o600 });

    const openSyncSpy = t.mock.method(fs, "openSync");
    const strictRunner = (argv: string[]): string => {
      assert.notEqual(argv[0], "find-generic-password", "the steady-state path must never re-read the login keychain");
      return "";
    };

    const summary = ensureWorkerKeychain({
      ...paths,
      loginKeychainPath: STEADY_STATE_LOGIN,
      runner: strictRunner,
      accountId: "acct-1",
    });

    assert.equal(summary.provisioned, false, "a matching store never re-provisions");
    assert.equal(summary.reason, "skipped");

    const lockPath = keychainProvisionLockPath(paths.keychainPath);
    assert.ok(
      !openSyncSpy.mock.calls.some((c) => String(c.arguments[0]) === lockPath),
      "the provisioning lock file must never be opened on the steady-state path",
    );
    assert.ok(!existsSync(lockPath), "no provisioning lock file is left behind");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── W1-T981: `.claude.json` is absent by construction, disposition (A) — pinned ────
//
// "Claude configuration file not found at worker-home-<uuid>/.claude.json" is not a race:
// every per-run redirected HOME starts this slot empty because nothing in this module
// writes it and it is not on the WORKER_HOME_SYMLINKS allowlist. These tests pin that as
// the deliberate, tested behaviour rather than an emergent property nobody asserts, and
// bound the one real cost the mechanism has — the CLI's own backup of the file it
// replaces landing, unbounded, in the shared granted `.claude` directory.

test("W1-T981: .claude.json is absent by construction after materialization — disposition (A), never seeded or granted back", () => {
  const workerHome = tmp();
  const realHome = tmp();
  try {
    // Even when the real HOME carries a populated .claude.json, disposition (A) means the
    // worker's own slot for it stays untouched by this module — the CLI creates its own
    // fresh one on first use, which is the notice this task pins as deliberate, not a race.
    writeFileSync(join(realHome, CLAUDE_CONFIG_REL), '{"hasAvailableSubscription":true}');

    materializeWorkerHome({ workerHome, realHome });

    assert.equal(
      existsSync(join(workerHome, CLAUDE_CONFIG_REL)),
      false,
      "materializeWorkerHome must not create or seed .claude.json in the redirected HOME",
    );
    assert.ok(
      !WORKER_HOME_SYMLINKS.some((s) => s.relPath === CLAUDE_CONFIG_REL),
      "disposition (A): .claude.json must never be added to the symlink allowlist — that is option " +
        "(C), rejected because it would re-share a mutable operator file across every concurrent worker",
    );
    assert.ok(
      !WORKER_HOME_RC_FILES.includes(CLAUDE_CONFIG_REL),
      "disposition (A) is ACCEPT, not SEED (option B) — .claude.json is not among the files this module writes",
    );
  } finally {
    rmSync(workerHome, { recursive: true, force: true });
    rmSync(realHome, { recursive: true, force: true });
  }
});

test("W1-T981: sweepClaudeConfigBackups bounds the CLI's per-spawn .claude.json backups instead of letting them accumulate unbounded", () => {
  const realHome = tmp();
  try {
    const claudeDir = join(realHome, ".claude");
    const backupsDir = join(claudeDir, "backups");
    mkdirSync(backupsDir, { recursive: true });
    const epochs = Array.from({ length: 25 }, (_, i) => 1_700_000_000_000 + i * 1000);
    for (const epoch of epochs) {
      writeFileSync(join(backupsDir, `${CLAUDE_CONFIG_BACKUP_PREFIX}${epoch}`), "{}");
    }

    const summary = sweepClaudeConfigBackups(claudeDir, { maxKeep: 20 });

    assert.equal(summary.kept.length, 20, "only the newest maxKeep backups survive");
    assert.equal(summary.removed.length, 5, "the rest are reaped, not left to accumulate forever");
    assert.equal(readdirSync(backupsDir).length, 20, "the backups directory itself reflects the bound on disk");

    const removedEpochs = summary.removed
      .map((n) => Number(n.slice(CLAUDE_CONFIG_BACKUP_PREFIX.length)))
      .sort((a, b) => a - b);
    assert.deepEqual(removedEpochs, epochs.slice(0, 5), "the OLDEST backups are the ones removed, newest kept");
  } finally {
    rmSync(realHome, { recursive: true, force: true });
  }
});

test("W1-T981: sweepClaudeConfigBackups is a silent no-op, never throws, when no backups directory exists yet", () => {
  const realHome = tmp();
  try {
    const claudeDir = join(realHome, ".claude"); // no backups/ subdir at all
    assert.doesNotThrow(() => sweepClaudeConfigBackups(claudeDir));
    assert.deepEqual(sweepClaudeConfigBackups(claudeDir), { removed: [], kept: [] });
  } finally {
    rmSync(realHome, { recursive: true, force: true });
  }
});

test("W1-T981: materializeWorkerHome runs and OBSERVES the backup sweep against the resolved .claude grant target, not silently", () => {
  const workerHome = tmp();
  const realHome = tmp();
  try {
    const backupsDir = join(realHome, ".claude", "backups");
    mkdirSync(backupsDir, { recursive: true });
    writeFileSync(join(backupsDir, `${CLAUDE_CONFIG_BACKUP_PREFIX}1700000000000`), "{}");

    const plan = materializeWorkerHome({ workerHome, realHome });

    assert.ok(plan.claudeConfigBackupSweep, "the sweep outcome must be observable on the returned plan");
    assert.deepEqual(
      plan.claudeConfigBackupSweep!.kept,
      [`${CLAUDE_CONFIG_BACKUP_PREFIX}1700000000000`],
      "a single backup, well under the bound, is kept and reported",
    );
    assert.deepEqual(plan.claudeConfigBackupSweep!.removed, []);
  } finally {
    rmSync(workerHome, { recursive: true, force: true });
    rmSync(realHome, { recursive: true, force: true });
  }
});

test("W1-T981: materialization still succeeds with neither the credential-only grant nor any .claude directory present — the backup sweep adds no new refusal path", () => {
  const workerHome = tmp();
  const realHome = tmp(); // nothing at all — falsifier (v): no second way to refuse a spawn
  try {
    assert.doesNotThrow(() => materializeWorkerHome({ workerHome, realHome }));
    const plan = materializeWorkerHome({ workerHome, realHome });
    assert.deepEqual(plan.claudeConfigBackupSweep, { removed: [], kept: [] });
  } finally {
    rmSync(workerHome, { recursive: true, force: true });
    rmSync(realHome, { recursive: true, force: true });
  }
});

test("W1-T981: one backup that refuses to be removed is kept and never blocks the reaping of the rest", () => {
  const realHome = tmp();
  try {
    const claudeDir = join(realHome, ".claude");
    const backupsDir = join(claudeDir, "backups");
    mkdirSync(backupsDir, { recursive: true });
    // Six backups, maxKeep 2 -> the four OLDEST are reaping candidates. The unlucky one is in
    // the middle of that group, so a catch that swallowed the whole forEach would be visible as
    // the entries AFTER it going unreaped, not merely as the failing one surviving.
    const epochs = Array.from({ length: 6 }, (_, i) => 1_700_000_000_000 + i * 1000);
    for (const epoch of epochs) {
      writeFileSync(join(backupsDir, `${CLAUDE_CONFIG_BACKUP_PREFIX}${epoch}`), "{}");
    }
    const unremovable = `${CLAUDE_CONFIG_BACKUP_PREFIX}${epochs[1]}`;

    const summary = sweepClaudeConfigBackups(claudeDir, {
      maxKeep: 2,
      fsImpl: {
        rmSync: (target, ...rest) => {
          // A permissions hiccup on exactly ONE entry — the real EACCES shape, injected rather
          // than simulated by chmod, which root ignores on a CI runner.
          if (String(target).endsWith(unremovable)) {
            throw Object.assign(new Error(`EACCES: permission denied, unlink '${String(target)}'`), { code: "EACCES" });
          }
          return rmSync(target as Parameters<typeof rmSync>[0], ...(rest as [Parameters<typeof rmSync>[1]]));
        },
      },
    });

    // The refusal is absorbed: the entry is REPORTED as kept rather than lost or thrown.
    assert.ok(summary.kept.includes(unremovable), "an entry that could not be removed is reported kept, not silently dropped");
    assert.ok(!summary.removed.includes(unremovable), "an entry that threw is never reported as removed");

    // ...and the rest of the sweep still ran — this is the claim the catch arm exists to make.
    const expectedRemoved = [epochs[0], epochs[2], epochs[3]].map((e) => `${CLAUDE_CONFIG_BACKUP_PREFIX}${e}`);
    assert.deepEqual(summary.removed.sort(), expectedRemoved.sort(), "every other over-limit backup is still reaped");
    assert.equal(summary.kept.length, 3, "the two newest, plus the one that refused");

    // The on-disk state agrees with the summary, so this is not a bookkeeping-only assertion.
    assert.deepEqual(readdirSync(backupsDir).sort(), summary.kept.sort());
  } finally {
    rmSync(realHome, { recursive: true, force: true });
  }
});

// ── W1-T1063: the browser cache grant ────────────────────────────────────────────────────────

test("worker home: the granted cache path matches the resolver", () => {
  // DERIVED, NOT A SECOND COPY. The whole point of the design is that the grant and the launch
  // path cannot disagree about where the cache lives, so this asserts the table entry equals what
  // `playwrightCacheRoot` computes for the SAME platform, rather than equalling a literal.
  for (const platform of ["linux", "darwin"] as const) {
    const home = "/__rmd_home__";
    const expected = relative(home, playwrightCacheRoot({}, platform, home)).split(sep).join("/");
    assert.equal(playwrightCacheRelPath(platform), expected, `${platform}: grant must equal the resolver`);
  }
  // BOTH PLATFORMS ARE COVERED AND THEY GENUINELY DIFFER — a single shared answer would mean the
  // platform branch was not being exercised at all.
  assert.notEqual(playwrightCacheRelPath("linux"), playwrightCacheRelPath("darwin"));
  assert.equal(playwrightCacheRelPath("linux"), ".cache/ms-playwright");
  assert.equal(playwrightCacheRelPath("darwin"), "Library/Caches/ms-playwright");
});

test("worker home: the browser cache is granted into a redirected home", () => {
  // ASSERTS THE RESOLVED PATH, NOT MERELY THAT A LINK EXISTS. A test that only checked for a
  // symlink would pass on a link pointing anywhere; what a worker needs is that reading through
  // the redirected HOME lands on the populated cache. So this writes a real marker on the REAL
  // home's side and reads it back through the WORKER home's path.
  const root = mkdtempSync(join(tmpdir(), "rmd-t1063-grant-"));
  const realHome = join(root, "real");
  const workerHome = join(root, "worker-home-RUN1");
  const rel = playwrightCacheRelPath();
  const realCache = join(realHome, rel);
  mkdirSync(realCache, { recursive: true });
  writeFileSync(join(realCache, "INSTALLATION_COMPLETE"), "x");

  materializeWorkerHome({ workerHome, realHome });

  const through = join(workerHome, rel, "INSTALLATION_COMPLETE");
  assert.equal(existsSync(through), true, "a worker must be able to READ THROUGH the grant to the populated cache");
  assert.equal(readFileSync(through, "utf8"), "x", "and read the real bytes, not an empty shim");

  // NEGATIVE CONTROL: a path that is NOT granted must not resolve through the worker home. Without
  // this the assertion above would pass on a wholesale HOME copy, which is exactly what the grant
  // table exists to avoid.
  const ungranted = join(realHome, ".not-granted-cache");
  mkdirSync(ungranted, { recursive: true });
  writeFileSync(join(ungranted, "marker"), "y");
  assert.equal(
    existsSync(join(workerHome, ".not-granted-cache", "marker")),
    false,
    "an UNGRANTED path must not resolve through the worker home",
  );
});

test("worker home: an absent cache skips the grant and still materializes", () => {
  // DEGRADE, NEVER BREAK. A host that never populated a cache must still get a working home — the
  // grant is optional and its absence is recorded, not thrown.
  const root = mkdtempSync(join(tmpdir(), "rmd-t1063-absent-"));
  const realHome = join(root, "real");
  const workerHome = join(root, "worker-home-RUN2");
  mkdirSync(realHome, { recursive: true });
  const rel = playwrightCacheRelPath();
  assert.equal(existsSync(join(realHome, rel)), false, "fixture precondition: the real home has NO cache");

  const plan = materializeWorkerHome({ workerHome, realHome });

  assert.equal(existsSync(workerHome), true, "the home still materializes");
  assert.equal(existsSync(join(workerHome, rel)), false, "no dangling link is left where the target is absent");
  const outcome = (plan.outcomes ?? []).find((o) => o.relFrom === rel);
  assert.ok(outcome, "the grant's outcome is RECORDED rather than silently dropped");
  assert.equal(outcome?.state, "absent", "an absent target is `absent`, distinguishable from `failed`");
});

test("worker home: the cache grant adds no writable path", () => {
  // CONTAINMENT IS UNCHANGED. The grant is a symlink INSIDE the worker home pointing at the real
  // home — not a bind and not a new writable location. Asserting the link's own type is what
  // distinguishes this from a copy, which WOULD be new writable bytes under the worker home.
  const root = mkdtempSync(join(tmpdir(), "rmd-t1063-nowrite-"));
  const realHome = join(root, "real");
  const workerHome = join(root, "worker-home-RUN3");
  const rel = playwrightCacheRelPath();
  mkdirSync(join(realHome, rel), { recursive: true });

  materializeWorkerHome({ workerHome, realHome });

  const linkPath = join(workerHome, rel);
  assert.equal(lstatSync(linkPath).isSymbolicLink(), true, "the grant is a SYMLINK, never a copied tree");
  assert.equal(realpathSync(linkPath), realpathSync(join(realHome, rel)), "and it resolves to the real home's cache");
});

// ── W1-T2633: the placement invariant — a worker home may never resolve inside a git work tree ──
//
// workerHomeDir (config.ts) resolves an OPERATOR-SETTABLE config.workerHomeRoot with no guard.
// These tests pin the refusal at BOTH layers: the pure predicate in isolation, and
// materializeWorkerHome's call to it — for a clone's .git DIRECTORY and a linked worktree's .git
// FILE alike, and reached through the settable config field, not only the default derivation.

test("gitWorkTreeAncestor: finds a .git DIRECTORY ancestor (a plain clone)", () => {
  const found = gitWorkTreeAncestor("/repo/nested/worker-home-x", (p) => p === "/repo/.git");
  assert.equal(found, "/repo/.git");
});

test("gitWorkTreeAncestor: finds a .git FILE ancestor (a linked worktree's gitdir pointer)", () => {
  const found = gitWorkTreeAncestor("/worktrees/run-1/worker-home-x", (p) => p === "/worktrees/run-1/.git");
  assert.equal(found, "/worktrees/run-1/.git");
});

test("gitWorkTreeAncestor: undefined when no ancestor up to the filesystem root carries a .git entry", () => {
  assert.equal(gitWorkTreeAncestor("/scratch/worker-home-x", () => false), undefined);
});

test("materializeWorkerHome: refuses a worker home inside a git CLONE (.git directory), naming both paths, and writes nothing", () => {
  const root = tmp();
  const realHome = tmp();
  try {
    const repo = join(root, "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    const workerHome = join(repo, "worker-home-RUN1");

    assert.throws(
      () => materializeWorkerHome({ workerHome, realHome }),
      (err: unknown) => {
        assert.ok(err instanceof WorkerHomePlacementError, "must throw the named placement error");
        assert.equal(err.workerHome, workerHome, "the error must name the offending home path");
        assert.equal(err.gitAncestor, join(repo, ".git"), "the error must name the .git ancestor that disqualified it");
        return true;
      },
    );
    assert.equal(existsSync(workerHome), false, "nothing is written when the guard refuses");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(realHome, { recursive: true, force: true });
  }
});

test("materializeWorkerHome: refuses a worker home inside a linked WORKTREE (.git file), same as a clone's .git directory", () => {
  const root = tmp();
  const realHome = tmp();
  try {
    const worktree = join(root, "worktree");
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, ".git"), "gitdir: /elsewhere/repo/.git/worktrees/worktree\n");
    const workerHome = join(worktree, "worker-home-RUN1");

    assert.throws(
      () => materializeWorkerHome({ workerHome, realHome }),
      (err: unknown) => {
        assert.ok(err instanceof WorkerHomePlacementError, "a .git FILE must be detected the same as a .git directory");
        assert.equal(err.gitAncestor, join(worktree, ".git"));
        return true;
      },
    );
    assert.equal(existsSync(workerHome), false, "nothing is written when the guard refuses");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(realHome, { recursive: true, force: true });
  }
});

test("materializeWorkerHome: a worker home OUTSIDE every git work tree materializes exactly as before — the guard adds a refusal and moves no other behaviour", () => {
  const workerHomeRoot = tmp();
  const workerHome = perRunWorkerHomeDir(workerHomeRoot, "RUN1");
  const realHome = tmp();
  try {
    mkdirSync(join(realHome, ".claude"), { recursive: true });

    const plan = materializeWorkerHome({ workerHome, realHome });

    assert.equal(plan.workerHome, workerHome);
    for (const rc of WORKER_HOME_RC_FILES) {
      assert.equal(readFileSync(join(workerHome, rc), "utf8"), "", `${rc} still materializes empty`);
    }
    assert.ok(lstatSync(join(workerHome, ".claude")).isSymbolicLink(), "the existing grants still materialize");
    // the sibling shape is unchanged: workerHome sits BESIDE workerHomeRoot, never nested under it.
    assert.equal(dirname(workerHome), dirname(workerHomeRoot));
  } finally {
    rmSync(workerHomeRoot, { recursive: true, force: true });
    rmSync(workerHome, { recursive: true, force: true });
    rmSync(realHome, { recursive: true, force: true });
  }
});

test("materializeWorkerHome: the guard fires through config.ts's settable workerHomeRoot field, not only the default root derivation", () => {
  const root = tmp();
  const configRoot = tmp();
  const realHome = tmp();
  try {
    // An operator points workerHomeRoot at a path INSIDE a tracked checkout — the one unguarded
    // path by which home scaffolding could reach a tracked tree (this task's filing).
    const trackedCheckout = join(root, "tracked-checkout");
    mkdirSync(join(trackedCheckout, ".git"), { recursive: true });
    const configuredRoot = join(trackedCheckout, "scratch");
    const config = { claudeBin: "/bin/true", root: configRoot, workerHomeRoot: configuredRoot } as unknown as Config;

    const workerHome = perRunWorkerHomeDir(workerHomeDir(config), "RUN1");

    assert.throws(() => materializeWorkerHome({ workerHome, realHome }), WorkerHomePlacementError);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(configRoot, { recursive: true, force: true });
    rmSync(realHome, { recursive: true, force: true });
  }
});

test("materializeWorkerHome: the guard also fires on the DEFAULT root derivation when config.root itself is a checkout", () => {
  const root = tmp();
  const realHome = tmp();
  try {
    // root == checkout is not a supported shape, but the default derivation (`<root>/worker-home`)
    // nests the home directly under it, so this must refuse rather than silently materialize.
    mkdirSync(join(root, ".git"), { recursive: true });
    const config = { claudeBin: "/bin/true", root } as unknown as Config;

    const workerHome = perRunWorkerHomeDir(workerHomeDir(config), "RUN1");

    assert.throws(() => materializeWorkerHome({ workerHome, realHome }), WorkerHomePlacementError);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(realHome, { recursive: true, force: true });
  }
});

// ── W1-T2633: the ignore list stays narrow — see .gitignore's own "os / editor" section ──

test("W1-T2633: .gitignore ignores the two editor directories, and does NOT ignore the rc file names or .claude.json", () => {
  const ignore = readFileSync(new URL("../.gitignore", import.meta.url), "utf8");
  const lines = ignore.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));

  // The two editor directories the report named — never legitimate repo content, so a stray one
  // can never be staged into a PR diff by accident.
  assert.ok(lines.includes(".idea/"), ".idea/ must be ignored");
  assert.ok(lines.includes(".vscode/"), ".vscode/ must be ignored");

  // DELIBERATELY NOT IGNORED: an ignore entry for these would MASK the very defect the placement
  // guard above exists to make loud — a home materialized into a work tree would then be
  // invisible instead of refused, which is strictly worse than the status quo.
  for (const rc of WORKER_HOME_RC_FILES) {
    assert.ok(!lines.includes(rc), `${rc} must stay UN-ignored — an ignore entry would hide the guard's own defect`);
  }
  assert.ok(
    !lines.includes(CLAUDE_CONFIG_REL),
    ".claude.json must stay UN-ignored — same reasoning as the rc files above",
  );
});

test("worker home: the existing grants are unchanged", () => {
  // ADDING ONE ENTRY MUST NOT DISTURB THE FOUR BESIDE IT. Named explicitly rather than by count,
  // so this states which grants must survive rather than merely how many.
  const rels = WORKER_HOME_SYMLINKS.map((s) => s.relPath);
  for (const expected of [".claude", ".config/gh", ".gitconfig", "Library/Keychains/login.keychain-db"]) {
    assert.ok(rels.includes(expected), `the pre-existing grant ${expected} must still be present`);
  }
  assert.ok(rels.includes(playwrightCacheRelPath()), "and the new grant is present beside them");
  for (const s of WORKER_HOME_SYMLINKS) {
    assert.ok(s.reason.trim().length > 0, `every grant carries a written reason — ${s.relPath} does not`);
  }
});
