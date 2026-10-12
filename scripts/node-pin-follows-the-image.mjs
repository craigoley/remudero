#!/usr/bin/env node
// W1-T6064 — keep .nvmrc on the Node version deploy/Dockerfile's FROM names, within one major.
// Dependabot's /deploy docker lane edits FROM only; the exact-pin rule (ADR 0002) needs both. A
// major is refused: W1-T6063 keeps majors out of Dependabot, and one arriving here is a plan change.
//
// Exit 0: in sync, or .nvmrc rewritten. Exit 1: a major was refused. Exit 2: unreadable input.
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const FROM_NODE = /^FROM node:(\d+)\.(\d+)\.(\d+)-/;

/** The `major.minor.patch` the Dockerfile's single `FROM node:` line names, or undefined. */
export function imageNodeVersion(dockerfile) {
  const from = dockerfile.split("\n").filter((line) => line.startsWith("FROM "));
  if (from.length !== 1) return undefined;
  const match = FROM_NODE.exec(from[0]);
  return match ? `${match[1]}.${match[2]}.${match[3]}` : undefined;
}

/** Compare the image's Node with the pin and decide; writes nothing. */
export function planNodePin(dockerfile, nvmrc) {
  const image = imageNodeVersion(dockerfile);
  const pinned = nvmrc.trim().replace(/^v/, "");
  if (image === undefined) return { action: "unreadable", pinned };
  if (image === pinned) return { action: "in-sync", image, pinned };
  if (image.split(".")[0] !== pinned.split(".")[0]) return { action: "major", image, pinned };
  return { action: "rewrite", image, pinned };
}

export function main(argv) {
  const { values } = parseArgs({ args: argv, options: { root: { type: "string", default: "." } } });
  const root = resolve(values.root);
  const nvmrcPath = join(root, ".nvmrc");
  const plan = planNodePin(readFileSync(join(root, "deploy", "Dockerfile"), "utf8"), readFileSync(nvmrcPath, "utf8"));
  switch (plan.action) {
    case "unreadable":
      console.error("node-pin-follows-the-image: deploy/Dockerfile must carry exactly one `FROM node:<x.y.z>-` line.");
      return 2;
    case "in-sync":
      console.log(`node-pin-follows-the-image: .nvmrc is already ${plan.pinned}.`);
      return 0;
    case "major":
      console.error(`node-pin-follows-the-image: REFUSING — the image moves Node ${plan.pinned} -> ${plan.image}, a major. ` +
        "A major is a coordinated plan change to .nvmrc, the image and the code (W1-T6063), never a sync.");
      return 1;
    default:
      writeFileSync(nvmrcPath, `${plan.image}\n`);
      console.log(`node-pin-follows-the-image: .nvmrc ${plan.pinned} -> ${plan.image}.`);
      return 0;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = main(process.argv.slice(2));
