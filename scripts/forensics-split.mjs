#!/usr/bin/env node
// scripts/forensics-split.mjs (W1-T4096) — splits any docs/forensics/*.md page over its reading
// size into one file per `## ` anchor (lib/narrative-fold.ts's splitForensicsPage), rewrites the
// `// Why:` pointers under src/ that named a specific anchor, and leaves the original page as a
// small index. A page under the threshold is left untouched.
//
// Usage: node --import tsx scripts/forensics-split.mjs [--check] [--root <dir>] [--page <path>]
//        [--threshold <bytes>]
// --page may repeat; defaults to every docs/forensics/*.md. --check reports what WOULD split
// (dry run) and exits 1 if anything would change, writing nothing.

import { resolve } from "node:path";
import { foldNarrativeStore } from "../src/lib/narrative-fold.js";
import { isMainModule } from "./lib/argv.mjs";

export function run(argv = process.argv.slice(2)) {
  const rootFlag = argv.indexOf("--root");
  const root = rootFlag >= 0 ? resolve(argv[rootFlag + 1]) : process.cwd();
  const check = argv.includes("--check");
  const thresholdFlag = argv.indexOf("--threshold");
  const readingSizeBytes = thresholdFlag >= 0 ? Number(argv[thresholdFlag + 1]) : undefined;
  const pages = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === "--page") pages.push(argv[i + 1]);

  const report = foldNarrativeStore({
    root,
    kind: "forensics",
    forensicsPages: pages.length ? pages : undefined,
    readingSizeBytes,
    dryRun: check,
  });
  for (const note of report.notes) console.log(`forensics-split: ${note}`);
  if (check) {
    if (report.changed) {
      console.error(`forensics-split: ${report.filesWritten.length} file(s) would change — run without --check to write them`);
      return 1;
    }
    console.log("forensics-split: every page is already at or under its reading size");
    return 0;
  }
  console.log(`forensics-split: wrote ${report.filesWritten.length} file(s)`);
  return 0;
}

if (isMainModule(import.meta.url)) process.exit(run());
