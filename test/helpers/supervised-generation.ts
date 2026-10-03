/**
 * A serve generation that speaks the real supervisor protocol, for test/serve-supervisor.test.ts.
 * It uses the real modules (serve-generation for readiness and IPC, serve-drain for the drain) around
 * a tiny HTTP server, so a swap is exercised end to end without booting the whole of serve.
 *
 * argv: <port> <sha> <mode>. Modes: `ok`; `never-ready` (readiness stays 503); `wrong-sha` (ready,
 * but /v1/version reports another build); `crash-after-promote` (dies right after it binds); `status-503`
 * (ready, but /v1/status answers 503 as a warming board does); `status-warming`
 * (the first two real status reads answer 503, then recover).
 */
import { createServer } from "node:http";
import { createServeDrain, exitWithin } from "../../src/lib/serve-drain.js";
import { GENERATION_MESSAGES, awaitPromotion, listenReadiness, onDrainRequest, processChannel, supervisedRole } from "../../src/lib/serve-generation.js";

const [port, sha, mode = "ok"] = process.argv.slice(2);
const role = supervisedRole(process.env);
const channel = processChannel();
if (!role || !channel) throw new Error("supervised-generation must be forked by the supervisor");

const serveDrain = createServeDrain({ boundMs: 10_000 });
let statusReads = 0;
const server = createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    setTimeout(() => {
      const statusRead = req.url === "/v1/status";
      if (statusRead) statusReads++;
      const unavailable = statusRead && (mode === "status-503" || (mode === "status-warming" && statusReads <= 2));
      res.writeHead(unavailable ? 503 : 200, { "content-type": "application/json", "x-sha": sha });
      res.end(JSON.stringify(req.url === "/v1/version" && mode !== "wrong-sha" ? { sha } : { sha: mode === "wrong-sha" ? "someone-else" : sha, url: req.url }));
    }, 2);
  });
});
server.keepAliveTimeout = 60_000;
serveDrain.attach(server);
onDrainRequest(channel, (reason) => void serveDrain.drain(reason).then(() => exitWithin(0)));
channel.onMessage((message) => {
  if (message.type === "test.ask") channel.send({ type: GENERATION_MESSAGES.handoffRequest, reason: "checkout_behind" });
});
const bootedAt = Date.now();
await listenReadiness(server, role.socketPath, () => [() => ({ name: "booted", ok: mode !== "never-ready" && Date.now() - bootedAt > 150 })]);
await awaitPromotion(channel);
server.listen(Number(port), "127.0.0.1", () => {
  channel.send({ type: GENERATION_MESSAGES.promoted });
  if (mode === "crash-after-promote") setTimeout(() => process.exit(3), 100);
});
