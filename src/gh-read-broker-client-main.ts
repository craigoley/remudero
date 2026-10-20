/**
 * W1-T10279 — the narrow entry a synchronous transport read spawns in place of `gh`, through the live
 * read broker. It answers exactly as `gh` would: gh's stdout, gh's stderr, gh's exit code. It imports
 * only the client module, so a synchronous read never loads the CLI.
 *   argv: <socket path> <class> <gh args...>
 * If the broker cannot be reached it runs `gh` itself, so a read is never lost to a broker restart.
 */
import { spawn } from "node:child_process";
import { brokerGhRead, isGhBrokerClass } from "./lib/gh-read-broker-client.js";

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
