import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  WORKER_HOME_RC_FILES,
  WORKER_HOME_SYMLINKS,
  materializeWorkerHome,
  workerHomePlan,
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
  // Minimality: ONLY the single DB file is granted, never the whole ~/Library.
  const libGrants = plan.symlinks.filter((s) => s.from.includes("/Library/"));
  assert.equal(libGrants.length, 1, "exactly ONE path under ~/Library is granted (the login keychain DB), not the whole Library");
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
