import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { loadLearningsCorpus } from "./learnings.js";
import { resolveRepoLayout } from "./repo-layout.js";

/**
 * lib/knowledge-inventory.ts (W1-T4095) — one list of everything the fleet knows, and where.
 *
 * Knowledge lives in six places with six shapes: learnings (the learnings YAML shards), doctrine rule
 * bodies (`doctrine/**`), decision records (`DECISIONS.md` sections), forensics pages
 * (`docs/forensics/*`), plan narrative (the master plan's sections) and, when configured, the
 * operator's Claude Code memory files. The knowledge gardener scores and tends them as one corpus,
 * so it needs one list: an id, a kind, the file it lives in, its size, and its text.
 */

export type KnowledgeKind = "learning" | "doctrine" | "decision" | "forensics" | "plan" | "memory";

export interface KnowledgeItem {
  id: string;
  kind: KnowledgeKind;
  /** Repo-relative (or, for memory, absolute) path of the file holding it. */
  path: string;
  bytes: number;
  text: string;
  /** Learnings only. */
  lifecycle?: string;
  subsystem?: string;
}

function walkMarkdown(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walkMarkdown(path));
    else if (ent.isFile() && ent.name.endsWith(".md")) out.push(path);
  }
  return out.sort();
}

/** Split a markdown file into its `## ` sections, each an item. Text before the first heading is
 *  the file's preamble, kept as its own item so nothing is left out of the size totals. */
function sections(root: string, file: string, kind: KnowledgeKind): KnowledgeItem[] {
  const abs = join(root, file);
  if (!existsSync(abs)) return [];
  const text = readFileSync(abs, "utf8");
  const parts = text.split(/\n(?=## )/);
  return parts.map((part, i) => {
    const heading = /^## (.+)/.exec(part)?.[1]?.trim();
    const slug = heading ? heading.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) : `preamble-${i}`;
    return { id: `${file}#${slug}`, kind, path: file, bytes: Buffer.byteLength(part), text: part };
  });
}

export function buildKnowledgeInventory(root: string, opts: { memoryDirs?: string[] } = {}): KnowledgeItem[] {
  const items: KnowledgeItem[] = [];
  const layout = resolveRepoLayout(root);
  for (const e of loadLearningsCorpus(layout.learningsDir)) {
    items.push({
      id: `learnings#${e.id}`,
      kind: "learning",
      path: relative(root, layout.learningsDir),
      bytes: Buffer.byteLength(e.fact),
      text: e.fact,
      lifecycle: e.lifecycle,
      subsystem: e.subsystem,
    });
  }
  for (const file of walkMarkdown(join(root, "doctrine"))) {
    const text = readFileSync(file, "utf8");
    items.push({ id: relative(root, file), kind: "doctrine", path: relative(root, file), bytes: Buffer.byteLength(text), text });
  }
  items.push(...sections(root, "DECISIONS.md", "decision"));
  for (const file of walkMarkdown(join(root, "docs", "forensics"))) {
    const text = readFileSync(file, "utf8");
    items.push({ id: relative(root, file), kind: "forensics", path: relative(root, file), bytes: Buffer.byteLength(text), text });
  }
  items.push(...sections(root, relative(root, layout.masterPlan), "plan"));
  for (const dir of opts.memoryDirs ?? []) {
    if (!existsSync(dir)) continue;
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (!ent.isFile() || !ent.name.endsWith(".md") || ent.name.startsWith("MEMORY")) continue;
      const path = join(dir, ent.name);
      const text = readFileSync(path, "utf8");
      items.push({ id: `memory:${ent.name}`, kind: "memory", path, bytes: Buffer.byteLength(text), text });
    }
  }
  return items;
}

/** Per kind: how many items, how many bytes, and the largest single item. */
export function inventoryTotals(items: KnowledgeItem[]): Record<string, { count: number; bytes: number; largest: number }> {
  const out: Record<string, { count: number; bytes: number; largest: number }> = {};
  for (const item of items) {
    const t = (out[item.kind] ??= { count: 0, bytes: 0, largest: 0 });
    t.count += 1;
    t.bytes += item.bytes;
    t.largest = Math.max(t.largest, item.bytes);
  }
  return out;
}

/** Every `Why: docs/forensics/<page>` pointer in src/ whose page does not exist. */
export function danglingWhyPointers(root: string): Array<{ file: string; line: number; target: string }> {
  const out: Array<{ file: string; line: number; target: string }> = [];
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, ent.name);
      if (ent.isDirectory()) walk(path);
      else if (ent.isFile() && ent.name.endsWith(".ts")) {
        readFileSync(path, "utf8")
          .split("\n")
          .forEach((text, i) => {
            for (const m of text.matchAll(/Why:\s*(docs\/forensics\/[\w./-]+\.md)/g)) {
              if (!existsSync(join(root, m[1]!))) out.push({ file: relative(root, path), line: i + 1, target: m[1]! });
            }
          });
      }
    }
  };
  walk(join(root, "src"));
  return out;
}
