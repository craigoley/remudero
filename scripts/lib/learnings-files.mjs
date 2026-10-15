import { readdirSync } from "node:fs";
import { join } from "node:path";

/** Shards and one-entry files, tagged with the shard used for standing briefs. */
export function learningsSourceFiles(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const files = [];
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".yaml")) {
      files.push({ filename: entry.name, shard: entry.name });
    } else if (entry.isDirectory() && entry.name.endsWith(".d")) {
      const shard = `${entry.name.slice(0, -2)}.yaml`;
      for (const child of readdirSync(join(dir, entry.name), { withFileTypes: true })) {
        if (child.isFile() && child.name.endsWith(".yaml")) {
          files.push({ filename: `${entry.name}/${child.name}`, shard });
        }
      }
    }
  }
  return files.sort((a, b) => a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0);
}
