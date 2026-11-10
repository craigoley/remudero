/**
 * W1-T10279 — the narrow entry a synchronous transport read spawns in place of `gh`, through the live
 * read broker. It answers exactly as `gh` would: gh's stdout, gh's stderr, gh's exit code. It imports
 * only the client module, so a synchronous read never loads the CLI.
 *   argv: <socket path> <class> <gh args...>
 * If the broker cannot be reached it runs `gh` itself, so a read is never lost to a broker restart.
 * W1-T11741: it runs under plain Node too (no tsx): the spawn selector gives such a child a resolve-hook preload.
 */
import { spawn } from "node:child_process";

// W1-T11741: loaded dynamically so a child that cannot start (the client or one of its imports will not
// load) is REPORTED on stderr with its own prefix and a non-zero exit, never left as a bare stack trace a
// caller reads as an ordinary failed read. It does not fall back to the direct path: a read that skipped
// the broker would spend the shared slot the broker exists to protect.
// diff-cov: process-boundary — an import-startup failure can only be proven in a forked child; this tiny helper reports it and exits.
function reportClientStartupFailure(err: unknown): never {
  process.stderr.write(`gh-broker: client failed to start (${String((err as Error)?.message ?? err)})\n`);
  process.exit(1);
}

const client = await import("./lib/gh-read-broker-client.js").catch(reportClientStartupFailure);
const { brokerGhRead, isGhBrokerClass } = client;

const [socketPath, cls, ...args] = process.argv.slice(2);
try {
  const result = await brokerGhRead(socketPath ?? "", args, { class: isGhBrokerClass(cls) ? cls : "background" });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
} catch (err) {
  // The broker went away after the caller saw its heartbeat: the read goes to gh directly instead.
  process.stderr.write(`gh-broker: unreachable (${String((err as Error)?.message ?? err)}); running gh directly\n`);
  process.exitCode = await new Promise<number>((resolve) => {
    const child = spawn("gh", args, { stdio: "inherit" });
    child.on("error", () => resolve(1));
    child.on("close", (code) => resolve(code ?? 1));
  });
}
