#!/usr/bin/env node
// scripts/git-credential-socket-helper.mjs — W1-T2699.
//
// Git's OWN credential-helper protocol (see gitcredentials(7)), pointed at the daemon's unix
// socket (src/lib/secret-boundary.ts's `startCredentialHelperSocket`) instead of a token-bearing
// shell function. worker.ts's `wireCredentialHelperSocket` installs this as the ONE local
// `credential.helper` for a worktree: `!node <this> <socketPath>`, with git itself appending the
// operation ("get"/"store"/"erase") as the next argument.
//
// Only "get" round-trips to the socket. "store" and "erase" are deliberate no-ops: this helper
// persists nothing, ever, so there is never a cached token on disk for git to ask it to erase.

import { writeFileSync } from "node:fs";
import { createConnection } from "node:net";

const [, , socketPath, operation] = process.argv;

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function fillOverSocket(request) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let data = "";
    socket.on("connect", () => socket.end(request));
    socket.on("data", (chunk) => {
      data += chunk.toString("utf8");
    });
    socket.on("end", () => resolve(data));
    socket.on("error", reject);
  });
}

async function main() {
  if (operation !== "get") return;
  const raw = await readStdin();
  const consumer = process.env.RMD_CREDENTIAL_CONSUMER;
  const request = consumer ? `${raw.replace(/\n*$/, "\n")}rmd_consumer=${consumer}\n\n` : raw;
  const reply = await fillOverSocket(request);
  const lines = reply.split("\n");
  const receipt = lines.filter((line) => line.startsWith("rmd_"));
  if (receipt.length > 0 && process.env.RMD_CREDENTIAL_RECEIPT) writeFileSync(process.env.RMD_CREDENTIAL_RECEIPT, `${receipt.join("\n")}\n`);
  process.stdout.write(lines.filter((line) => !line.startsWith("rmd_")).join("\n"));
}

main().catch(() => {
  // A failed round-trip must not crash git's own credential-fill loop; emitting nothing is git's
  // own signal to fall through to whatever it does next (typically a prompt, or a failed push).
  process.exitCode = 0;
});
