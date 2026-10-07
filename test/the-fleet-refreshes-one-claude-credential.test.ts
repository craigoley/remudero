import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Config } from "../src/lib/config.js";
import { LEDGER_FILENAME } from "../src/lib/ledger-path.js";
import { openUsageProbeSession } from "../src/lib/worker.js";
import {
  type ClaudeCredentialSeedEvent,
  materializeSpawnWorkerHome,
  seedClaudeFleetCredentials,
  workerCredentialFilePath,
  WORKER_CLAUDE_CREDENTIAL_DIR_RELPATH,
} from "../src/lib/worker-home.js";
import { usageCredentialSink } from "../src/run-task.js";

/**
 * W1-T6252. Core and console each forked the owner's OAuth credential into a container-local
 * `~/.claude-fleet` while site used the owner's `~/.claude` directly: three refreshing copies of ONE
 * lineage, so any holder's refresh rotated the refresh token out from under the others. On
 * 2026-10-07 core's fork was emptied 10:27Z-15:38Z and every Claude spawn and usage probe refused.
 *
 * The fixture models the deployed shape: one HOST `.claude` directory, bind-mounted (here: symlinked)
 * at `<realHome>/.claude` inside two containers whose own home directories are otherwise private.
 */
const USABLE = (token: string) => JSON.stringify({ claudeAiOauth: { accessToken: token, refreshToken: `r-${token}`, expiresAt: 1 } });
const EMPTIED = JSON.stringify({ claudeAiOauth: { accessToken: "", refreshToken: "" } });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1-t6252-"));
  const hostClaude = join(root, "host-claude");
  mkdirSync(hostClaude);
  writeFileSync(join(hostClaude, ".credentials.json"), USABLE("owner"));
  const container = (name: string) => {
    const realHome = join(root, name, "home");
    mkdirSync(realHome, { recursive: true });
    symlinkSync(hostClaude, join(realHome, ".claude"));
    return realHome;
  };
  return { root, hostClaude, core: container("core"), site: container("site") };
}

test("W1-T6252: the first spawn provisions the shared credential and every fleet Claude process resolves it", async () => {
  const { root, hostClaude, core, site } = fixture();
  try {
    const events: ClaudeCredentialSeedEvent[] = [];
    // The FIRST spawn, on core, provisions the shared store from the usable owner credential.
    materializeSpawnWorkerHome({ workerHome: join(root, "core", "worker-1"), realHome: core });
    const store = join(hostClaude, "fleet-auth", "claude");
    assert.equal(readFileSync(join(store, ".credentials.json"), "utf8"), USABLE("owner"));
    assert.equal(statSync(store).mode & 0o777, 0o700);
    assert.equal(statSync(join(store, ".credentials.json")).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(join(hostClaude, "fleet-auth")), ["claude"], "no staged file is left behind");

    // A second container's spawn finds the store and creates nothing of its own.
    assert.equal(seedClaudeFleetCredentials({ realHome: site, onEvent: (e) => events.push(e) }), "kept");
    materializeSpawnWorkerHome({ workerHome: join(root, "site", "worker-1"), realHome: site });
    assert.equal(events.length, 0, "an existing usable store is neither provisioned again nor healed");

    // No container holds a private fork.
    for (const home of [core, site]) {
      assert.equal(existsSync(join(home, WORKER_CLAUDE_CREDENTIAL_DIR_RELPATH)), false, `${home} forked a credential`);
    }

    // Every worker on both containers, and the usage probe on both, resolve the ONE file.
    const resolved = new Set<string>();
    for (const [home, worker] of [[core, "worker-1"], [site, "worker-1"]] as const) {
      resolved.add(realpathSync(workerCredentialFilePath(home)));
      resolved.add(realpathSync(join(home, "..", worker, ".claude", ".credentials.json")));
      let configDir: string | undefined;
      const session = openUsageProbeSession((p) => {
        configDir = (p as { options: { env?: NodeJS.ProcessEnv } }).options.env?.CLAUDE_CONFIG_DIR;
        return { return: async () => ({}) } as never;
      }, { realHome: home, platform: "linux" });
      await session.return?.(undefined);
      resolved.add(realpathSync(join(configDir!, ".credentials.json")));
    }
    assert.deepEqual([...resolved], [realpathSync(join(store, ".credentials.json"))]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T6252: the first provisioning reports itself, and a concurrent provisioner keeps the winner", () => {
  const { root, hostClaude, core, site } = fixture();
  try {
    const events: ClaudeCredentialSeedEvent[] = [];
    const store = join(hostClaude, "fleet-auth", "claude");
    assert.equal(seedClaudeFleetCredentials({
      realHome: core,
      onEvent: (e) => events.push(e),
      fsImpl: {
        // Site wins the exclusive mkdir between core's staging and its own claim.
        mkdirSync: ((path: string, opts?: { recursive?: boolean }) => {
          if (opts?.recursive) return mkdirSync(path, opts as never);
          mkdirSync(path);
          writeFileSync(join(path, ".credentials.json"), USABLE("site-refreshed"));
          throw Object.assign(new Error("concurrent provision"), { code: "EEXIST" });
        }) as typeof mkdirSync,
      },
    }), "kept");
    assert.equal(readFileSync(join(store, ".credentials.json"), "utf8"), USABLE("site-refreshed"));
    assert.equal(events.length, 0, "the loser records nothing");
    rmSync(join(hostClaude, "fleet-auth"), { recursive: true });

    assert.equal(seedClaudeFleetCredentials({ realHome: site, onEvent: (e) => events.push(e) }), "provisioned");
    assert.deepEqual(events, [
      // The in-container path: the mount it resolves through, which is what every holder there reads.
      { kind: "provisioned", store: join(site, ".claude", "fleet-auth", "claude"), priorVerdict: "absent" },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T6252: a credential heal writes one ledger row", () => {
  const { root, hostClaude, core } = fixture();
  try {
    const store = join(hostClaude, "fleet-auth", "claude");
    mkdirSync(store, { recursive: true, mode: 0o700 });
    writeFileSync(join(store, ".credentials.json"), EMPTIED);
    const config = { claudeBin: "/bin/true", root: join(root, "rmd") } as Config;
    const sink = usageCredentialSink(config);

    assert.equal(seedClaudeFleetCredentials({ realHome: core, onEvent: sink }), "healed");
    assert.equal(readFileSync(join(store, ".credentials.json"), "utf8"), USABLE("owner"));
    // The healed store is usable now, so the next probe tick heals nothing and records nothing.
    assert.equal(seedClaudeFleetCredentials({ realHome: core, onEvent: sink }), "kept");

    const rows = readFileSync(join(config.root, "state", LEDGER_FILENAME), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].step, "usage.credential_healed");
    assert.equal(rows[0].store, join(core, ".claude", "fleet-auth", "claude"));
    assert.equal(rows[0].prior_verdict, "credential-file-empty");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T6252: provisioning writes one usage.credential_provisioned ledger row", () => {
  const { root, hostClaude, core, site } = fixture();
  try {
    const config = { claudeBin: "/bin/true", root: join(root, "rmd") } as Config;
    assert.equal(seedClaudeFleetCredentials({ realHome: core, onEvent: usageCredentialSink(config) }), "provisioned");
    assert.equal(seedClaudeFleetCredentials({ realHome: site, onEvent: usageCredentialSink(config) }), "kept");
    const rows = readFileSync(join(config.root, "state", LEDGER_FILENAME), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.deepEqual(rows.map((r) => [r.step, r.store, r.prior_verdict]), [
      ["usage.credential_provisioned", join(core, ".claude", "fleet-auth", "claude"), "absent"],
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T6252: an unwritable credential ledger is reported without throwing", (t) => {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1-t6252-ledger-failure-"));
  try {
    const blocker = join(root, "not-a-directory");
    writeFileSync(blocker, "occupied");
    const config = { claudeBin: "/bin/true", root: join(blocker, "rmd") } as Config;
    const diagnostics: string[] = [];
    t.mock.method(console, "error", (...parts: unknown[]) => diagnostics.push(parts.map(String).join(" ")));
    const sink = usageCredentialSink(config);

    assert.doesNotThrow(() => sink({
      kind: "healed",
      store: join(root, "shared", "claude"),
      priorVerdict: "credential-file-empty",
    }));
    assert.equal(diagnostics.length, 1);
    const diagnostic = JSON.parse(diagnostics[0]!) as { event: string; reason: string };
    assert.equal(diagnostic.event, "usage.credential_ledger_failed");
    assert.match(diagnostic.reason, /not a directory|ENOTDIR/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T6252: an unusable owner credential provisions nothing and forks nothing", () => {
  const { root, hostClaude, core } = fixture();
  try {
    writeFileSync(join(hostClaude, ".credentials.json"), EMPTIED);
    assert.equal(seedClaudeFleetCredentials({ realHome: core }), "skipped");
    assert.deepEqual(readdirSync(hostClaude), [".credentials.json"]);
    assert.equal(existsSync(join(core, WORKER_CLAUDE_CREDENTIAL_DIR_RELPATH)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
