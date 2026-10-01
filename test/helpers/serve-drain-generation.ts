/**
 * One serve "generation" for test/serve-drain.test.ts, run as a cluster worker so every
 * generation shares the primary's ONE listening handle (arch-phase3-design.md option (c)).
 * Answers GET and POST after ~2 ms of work, so requests are genuinely in flight during a swap;
 * `{type:"drain"}` runs the real {@link createServeDrain} and exits when it resolves.
 */
import { createServer } from "node:http";
import { createServeDrain } from "../../src/lib/serve-drain.js";

const generation = process.env.GEN ?? String(process.pid);
const serveDrain = createServeDrain({ boundMs: 10_000, graceMs: Number(process.env.GRACE_MS ?? 1_000) });
const server = createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json", "x-gen": generation });
      res.end(JSON.stringify({ gen: generation, method: req.method }));
    }, 2);
  });
});
server.keepAliveTimeout = 60_000;
serveDrain.attach(server);
process.on("message", (message: { type?: string }) => {
  if (message?.type !== "drain") return;
  void serveDrain.drain("handover").then((outcome) => {
    process.send?.({ type: "drained", outcome });
    process.exit(0);
  });
});
server.listen(Number(process.env.PORT), "127.0.0.1", () => process.send?.({ type: "ready" }));
