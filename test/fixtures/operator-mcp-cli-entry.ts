// W1-T14173: runs `rmd mcp` the way src/run-task.ts main() does, on this process's real stdin and stdout:
// the verb's own promise, then flushThenExit with its code. argv[2] is the state root holding service-tokens.json.
import { flushThenExit } from "#src/lib/flush-exit.js";
import { operatorMcpCommand } from "#src/lib/operator-mcp.js";

const root = process.argv[2];
if (!root) throw new Error("usage: operator-mcp-cli-entry.ts <root>");
await flushThenExit(await operatorMcpCommand([], { root }, process.cwd()));
