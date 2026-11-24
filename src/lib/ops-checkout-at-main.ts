/**
 * W1-T14617: every reader of the ops catalog sees the ops repository's main, never the boot-time working tree.
 *
 * The daemon clones the ops checkout once and then only fetches it, so its working tree stays at the commit of the
 * clone while `refs/remotes/origin/main` moves. A reader of that checkout reads through this module:
 *  - ops main's bytes when ops main holds the path;
 *  - absent when the checkout's HEAD tracks the path and ops main does not;
 *  - the working-tree bytes only when neither ops main nor HEAD tracks the path (a capture not yet landed, the
 *    W1-T11374 rule). A caller that wants main alone leaves `untracked` off.
 *
 * Two arms share the rule. {@link readOpsCheckoutAtMain} fetches main first through the caller's async git, and any
 * git failure throws. {@link readOpsCheckoutAtMainSync} reads the checkout's existing origin/main with no fetch and no
 * child process: it reads the ref files and the object store (loose objects, packs, alternates) directly, so a
 * synchronous reader on the daemon loop never waits on a spawn. Any read it cannot make throws: a store it does not
 * fully read (another object format, a reftable, a pack index other than version 2, a pack and its index apart) and
 * any object whose bytes do not hash to the id asked for.
 */
import { createHash } from "node:crypto";
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { inflateSync } from "node:zlib";
import { headShaFromRefFiles } from "./checkout-head.js";

/** git rooted at the ops checkout; resolves to stdout. */
export type OpsCheckoutGit = (args: string[]) => Promise<string>;

/** The files a reader asks for: named repo-relative paths, or each file directly under `dir` whose name `match` accepts. */
export type OpsCheckoutQuery =
  | { readonly paths: readonly string[] }
  | { readonly dir: string; readonly match: (name: string) => boolean };

/** One file by the rule: from ops main (with its blob id on the sync arm), or from the working tree. */
export interface OpsCheckoutFile { text: string; source: "main" | "untracked"; oid?: string }

/** The answer: the origin/main commit read, and each file the query found, by repo-relative path. */
export interface OpsCheckoutRead { sha: string; files: Map<string, OpsCheckoutFile> }

export interface OpsCheckoutReadOpts {
  /** Read a file that neither ops main nor HEAD tracks from the working tree. Default false: ops main only. */
  untracked?: boolean;
}

const TRACKING = "refs/remotes/origin/main";
const FULL_SHA = /^[0-9a-f]{40}$/;

function pathspecOf(query: OpsCheckoutQuery): string[] {
  return "paths" in query ? [...query.paths] : [`${query.dir.replace(/\/+$/, "")}/`];
}

/** Whether a repo-relative path is one the query asks for. */
function asks(query: OpsCheckoutQuery, path: string): boolean {
  if ("paths" in query) return query.paths.includes(path);
  const prefix = `${query.dir.replace(/\/+$/, "")}/`;
  if (!path.startsWith(prefix)) return false;
  const name = path.slice(prefix.length);
  return name !== "" && !name.includes("/") && query.match(name);
}

/** The working-tree files of the query that neither ops main nor HEAD tracks. */
function untrackedFiles(checkoutDir: string, query: OpsCheckoutQuery, tracked: (path: string) => boolean): Map<string, OpsCheckoutFile> {
  const out = new Map<string, OpsCheckoutFile>();
  let candidates: string[];
  if ("paths" in query) candidates = [...query.paths];
  else {
    const dir = query.dir.replace(/\/+$/, "");
    candidates = existsSync(join(checkoutDir, dir)) ? readdirSync(join(checkoutDir, dir)).sort().map((name) => `${dir}/${name}`) : [];
  }
  for (const path of candidates) {
    if (!asks(query, path) || tracked(path)) continue;
    const abs = join(checkoutDir, path);
    let fd: number | undefined;
    try {
      fd = openSync(abs, "r");
      if (!fstatSync(fd).isFile()) continue;
      out.set(path, { text: readFileSync(fd, "utf8"), source: "untracked" });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "EISDIR") continue;
      throw error;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  return out;
}

/**
 * The async arm: fetch ops main into its tracking ref, then list and show the asked files at that commit, through
 * `runGit` rooted at `checkoutDir`. Any git failure throws; nothing falls back to the working tree.
 */
export async function readOpsCheckoutAtMain(
  checkoutDir: string,
  query: OpsCheckoutQuery,
  runGit: OpsCheckoutGit,
  opts: OpsCheckoutReadOpts = {},
): Promise<OpsCheckoutRead> {
  await runGit(["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "origin", `+refs/heads/main:${TRACKING}`]);
  const sha = (await runGit(["rev-parse", TRACKING])).trim();
  const files = new Map<string, OpsCheckoutFile>();
  const spec = pathspecOf(query);
  if (spec.length === 0) return { sha, files };
  const listed = async (rev: string) => (await runGit(["ls-tree", "--name-only", rev, "--", ...spec]))
    .split("\n").map((line) => line.trim()).filter((path) => path !== "" && asks(query, path));
  const onMain = await listed(sha);
  for (const path of onMain) files.set(path, { text: await runGit(["show", `${sha}:${path}`]), source: "main" });
  if (!opts.untracked) return { sha, files };
  const onHead = new Set(await listed("HEAD"));
  for (const [path, file] of untrackedFiles(checkoutDir, query, (p) => files.has(p) || onHead.has(p))) files.set(path, file);
  return { sha, files };
}

/** The sync arm: the same rule at the checkout's existing origin/main, read from the git files with no child process. */
export function readOpsCheckoutAtMainSync(checkoutDir: string, query: OpsCheckoutQuery, opts: OpsCheckoutReadOpts = {}): OpsCheckoutRead {
  const store = objectStoreOf(checkoutDir);
  const sha = refSha(store.commonDir, TRACKING);
  if (sha === undefined) throw new Error(`the ops checkout has no readable ${TRACKING}`);
  const files = new Map<string, OpsCheckoutFile>();
  for (const [path, oid] of blobsAsked(store, sha, query)) {
    files.set(path, { text: readObject(store, oid, "blob").toString("utf8"), source: "main", oid });
  }
  if (!opts.untracked) return { sha, files };
  const head = headShaFromRefFiles(checkoutDir);
  if (head === undefined) throw new Error("the ops checkout's HEAD cannot be read from its ref files");
  const onHead = blobsAsked(store, head, query);
  for (const [path, file] of untrackedFiles(checkoutDir, query, (p) => files.has(p) || onHead.has(p))) files.set(path, file);
  return { sha, files };
}

// ── The object store, read without git ─────────────────────────────────────

interface ObjectStore { commonDir: string; objectDirs: string[] }

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined; // an absent file: this layout keeps the value elsewhere, and the caller decides
  }
}

function objectStoreOf(checkoutDir: string): ObjectStore {
  const dotGit = join(checkoutDir, ".git");
  const pointer = readText(dotGit);
  const gitDir = pointer?.startsWith("gitdir:") ? resolve(checkoutDir, pointer.slice("gitdir:".length).trim()) : dotGit;
  const common = readText(join(gitDir, "commondir"))?.trim();
  const commonDir = common === undefined ? gitDir : resolve(gitDir, common);
  if (existsSync(join(commonDir, "reftable"))) throw new Error("the ops checkout keeps its refs in a reftable, which this reader does not read");
  const config = readText(join(commonDir, "config")) ?? "";
  const format = /^\s*objectformat\s*=\s*"?([^"\s]+)/im.exec(config)?.[1]?.toLowerCase();
  if (format !== undefined && format !== "sha1") throw new Error(`the ops checkout's object format is ${format}, which this reader does not read`);
  if (/^\s*refstorage\s*=\s*"?reftable/im.test(config)) throw new Error("the ops checkout keeps its refs in a reftable, which this reader does not read");
  const objectDirs: string[] = [];
  const visit = (dir: string, depth: number) => {
    if (objectDirs.includes(dir)) return;
    if (depth > 5) throw new Error("the ops checkout's object alternates nest too deep");
    objectDirs.push(dir);
    for (const line of readText(join(dir, "info", "alternates"))?.split("\n") ?? []) {
      const alt = line.trim();
      if (alt !== "" && !alt.startsWith("#")) visit(isAbsolute(alt) ? alt : resolve(dir, alt), depth + 1);
    }
  };
  visit(join(commonDir, "objects"), 0);
  return { commonDir, objectDirs };
}

/** A full ref's sha: the loose ref file, else its `packed-refs` line (a loose ref wins, as in git). */
function refSha(commonDir: string, ref: string): string | undefined {
  const loose = readText(join(commonDir, ref))?.trim();
  if (loose !== undefined) return FULL_SHA.test(loose) ? loose : undefined;
  for (const line of readText(join(commonDir, "packed-refs"))?.split("\n") ?? []) {
    const [sha, name] = line.trim().split(" ");
    if (name === ref && sha !== undefined && FULL_SHA.test(sha)) return sha;
  }
  return undefined;
}

/** The blobs the query asks for in the commit's tree, by repo-relative path. */
function blobsAsked(store: ObjectStore, commit: string, query: OpsCheckoutQuery): Map<string, string> {
  const body = readObject(store, commit, "commit").toString("utf8");
  const root = /^tree ([0-9a-f]{40})\n/.exec(body)?.[1];
  if (root === undefined) throw new Error(`commit ${commit} names no tree`);
  const out = new Map<string, string>();
  const treeAt = (dir: string): Map<string, TreeEntry> | undefined => {
    let entries = treeEntries(store, root);
    for (const part of dir.split("/").filter(Boolean)) {
      const next = entries.get(part);
      if (next === undefined || next.kind !== "tree") return undefined;
      entries = treeEntries(store, next.oid);
    }
    return entries;
  };
  if ("paths" in query) {
    for (const path of query.paths) {
      const slash = path.lastIndexOf("/");
      const entry = treeAt(slash < 0 ? "" : path.slice(0, slash))?.get(path.slice(slash + 1));
      if (entry?.kind === "blob") out.set(path, entry.oid);
    }
    return out;
  }
  const dir = query.dir.replace(/\/+$/, "");
  for (const [name, entry] of [...(treeAt(dir) ?? new Map<string, TreeEntry>())].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (entry.kind === "blob" && query.match(name)) out.set(`${dir}/${name}`, entry.oid);
  }
  return out;
}

interface TreeEntry { kind: "tree" | "blob" | "other"; oid: string }

function treeEntries(store: ObjectStore, oid: string): Map<string, TreeEntry> {
  const data = readObject(store, oid, "tree");
  const out = new Map<string, TreeEntry>();
  let p = 0;
  while (p < data.length) {
    const space = data.indexOf(0x20, p);
    const nul = data.indexOf(0, space);
    if (space < 0 || nul < 0 || nul + 21 > data.length) throw new Error(`tree ${oid} is malformed`);
    const mode = data.toString("latin1", p, space);
    out.set(data.toString("utf8", space + 1, nul), {
      kind: mode === "40000" ? "tree" : mode.startsWith("100") ? "blob" : "other",
      oid: data.subarray(nul + 1, nul + 21).toString("hex"),
    });
    p = nul + 21;
  }
  return out;
}

const OBJECT_TYPES = ["", "commit", "tree", "blob", "tag"] as const;
/** Objects never change under their id, so a read is kept; the cache is cleared past this many bytes. */
const OBJECT_CACHE_BYTES = 32 * 1024 * 1024;
const objectCache = new Map<string, { type: string; data: Buffer }>();
let objectCacheBytes = 0;

/** A delta chain longer than this is refused (git packs to depth 50 by default), so a cycle throws and never loops. */
const MAX_DELTA_DEPTH = 512;

function readObject(store: ObjectStore, oid: string, want: (typeof OBJECT_TYPES)[number]): Buffer {
  const found = findObject(store, oid);
  if (found.type !== want) throw new Error(`object ${oid} is a ${found.type}, not a ${want}`);
  return found.data;
}

function findObject(store: ObjectStore, oid: string, depth = 0): { type: string; data: Buffer } {
  if (!FULL_SHA.test(oid)) throw new Error(`"${oid}" is not an object id`);
  if (depth > MAX_DELTA_DEPTH) throw new Error("a pack delta chain is too deep");
  const kept = objectCache.get(oid);
  if (kept !== undefined) return kept;
  for (const dir of store.objectDirs) {
    const found = looseObject(dir, oid) ?? packedObject(store, dir, oid, depth);
    if (found === undefined) continue;
    if (!(OBJECT_TYPES as readonly string[]).includes(found.type) || found.type === "") throw new Error(`object ${oid} has the unknown type ${found.type}`);
    const id = createHash("sha1").update(`${found.type} ${found.data.length}\0`).update(found.data).digest("hex");
    if (id !== oid) throw new Error(`object ${oid} does not hash to its id (its bytes hash to ${id})`);
    if (objectCacheBytes + found.data.length > OBJECT_CACHE_BYTES) {
      objectCache.clear();
      objectCacheBytes = 0;
    }
    objectCache.set(oid, found);
    objectCacheBytes += found.data.length;
    return found;
  }
  throw new Error(`object ${oid} is not in the ops checkout's object store`);
}

function looseObject(dir: string, oid: string): { type: string; data: Buffer } | undefined {
  let raw: Buffer;
  try {
    raw = readFileSync(join(dir, oid.slice(0, 2), oid.slice(2)));
  } catch {
    return undefined; // not loose here: the packs are read next
  }
  const inflated = inflateSync(raw);
  const nul = inflated.indexOf(0);
  const [type, size] = inflated.toString("latin1", 0, nul).split(" ");
  const data = inflated.subarray(nul + 1);
  if (nul < 0 || type === undefined || Number(size) !== data.length) throw new Error(`loose object ${oid} is malformed`);
  return { type, data };
}

interface PackIndex { pack: string; idx: Buffer; count: number }
const packIndexes = new Map<string, { names: string; packs: PackIndex[] }>();

function packsOf(dir: string): PackIndex[] {
  const packDir = join(dir, "pack");
  // A multi-pack index is not read: every pack must keep its own index, which is read instead.
  const listed = existsSync(packDir) ? readdirSync(packDir) : [];
  const names = listed.filter((n) => n.endsWith(".idx")).sort();
  const packNames = listed.filter((n) => n.endsWith(".pack"));
  for (const pack of packNames) if (!names.includes(pack.replace(/\.pack$/, ".idx"))) throw new Error(`pack ${pack} has no index`);
  const kept = packIndexes.get(dir);
  if (kept?.names === names.join("\n")) return kept.packs;
  const packs = names.map((name) => {
    const pack = join(packDir, name.replace(/\.idx$/, ".pack"));
    if (!packNames.includes(name.replace(/\.idx$/, ".pack"))) throw new Error(`pack index ${name} has no pack`);
    const idx = readFileSync(join(packDir, name));
    if (idx.length < 8 + 1024 || idx.readUInt32BE(0) !== 0xff744f63 || idx.readUInt32BE(4) !== 2) {
      throw new Error(`pack index ${name} is not a version 2 index`);
    }
    const count = idx.readUInt32BE(8 + 255 * 4);
    if (idx.length < 8 + 1024 + count * 28 + 40) throw new Error(`pack index ${name} is truncated`);
    return { pack, idx, count };
  });
  packIndexes.set(dir, { names: names.join("\n"), packs });
  return packs;
}

function packOffset(index: PackIndex, oid: string): number | undefined {
  const { idx, count } = index;
  const target = Buffer.from(oid, "hex");
  const first = target[0]!;
  let lo = first === 0 ? 0 : idx.readUInt32BE(8 + (first - 1) * 4);
  let hi = idx.readUInt32BE(8 + first * 4);
  const shas = 8 + 1024;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const cmp = Buffer.compare(idx.subarray(shas + mid * 20, shas + mid * 20 + 20), target);
    if (cmp === 0) {
      const offsets = shas + count * 24;
      const small = idx.readUInt32BE(offsets + mid * 4);
      if ((small & 0x80000000) === 0) return small;
      return Number(idx.readBigUInt64BE(offsets + count * 4 + (small & 0x7fffffff) * 8));
    }
    if (cmp < 0) lo = mid + 1;
    else hi = mid;
  }
  return undefined;
}

function packedObject(store: ObjectStore, dir: string, oid: string, depth: number): { type: string; data: Buffer } | undefined {
  for (const index of packsOf(dir)) {
    const offset = packOffset(index, oid);
    if (offset === undefined) continue;
    const fd = openSync(index.pack, "r");
    try {
      const header = readAt(fd, 0, 12);
      if (header.length < 12 || header.toString("latin1", 0, 4) !== "PACK" || ![2, 3].includes(header.readUInt32BE(4))) {
        throw new Error(`pack ${index.pack.slice(index.pack.lastIndexOf("/") + 1)} has no version 2 or 3 pack header`);
      }
      return packEntry(store, fd, statSync(index.pack).size, offset, depth);
    } finally {
      closeSync(fd);
    }
  }
  return undefined;
}

function readAt(fd: number, offset: number, length: number): Buffer {
  const buf = Buffer.alloc(length);
  const n = readSync(fd, buf, 0, length, offset);
  return buf.subarray(0, n);
}

/** Inflate the zlib stream that starts at `offset`, reading more of the pack until the stream ends. */
function inflateAt(fd: number, packSize: number, offset: number, size: number): Buffer {
  for (let chunk = size + 1024; ; chunk *= 2) {
    const end = Math.min(packSize, offset + chunk);
    try {
      const out = inflateSync(readAt(fd, offset, end - offset));
      if (out.length !== size) throw new Error(`a pack entry inflated to ${out.length} bytes, not ${size}`);
      return out;
    } catch (error) {
      if (end >= packSize || !/unexpected end of file/i.test(String((error as Error)?.message ?? error))) throw error;
    }
  }
}

function packEntry(store: ObjectStore, fd: number, packSize: number, offset: number, depth: number): { type: string; data: Buffer } {
  // Offset deltas are followed in a loop, so a chain that names itself meets the bound and never recurses.
  const deltas: Buffer[] = [];
  let base: { type: string; data: Buffer } | undefined;
  for (let at = offset, d = depth; base === undefined; d += 1) {
    if (d > MAX_DELTA_DEPTH) throw new Error("a pack delta chain is too deep");
    if (at < 12 || at >= packSize) throw new Error(`a pack entry offset ${at} is outside its pack`);
    const head = readAt(fd, at, 64);
    let i = 0;
    let c = head[i++]!;
    const typeCode = (c >> 4) & 7;
    let size = c & 15;
    for (let shift = 4; c & 0x80; shift += 7) {
      c = head[i++]!;
      size += (c & 0x7f) * 2 ** shift;
    }
    if (typeCode >= 1 && typeCode <= 4) {
      base = { type: OBJECT_TYPES[typeCode]!, data: inflateAt(fd, packSize, at + i, size) };
    } else if (typeCode === 6) {
      c = head[i++]!;
      let back = c & 0x7f;
      while (c & 0x80) {
        c = head[i++]!;
        back = (back + 1) * 128 + (c & 0x7f);
      }
      deltas.push(inflateAt(fd, packSize, at + i, size));
      at -= back;
    } else if (typeCode === 7) {
      const baseOid = head.subarray(i, i + 20).toString("hex");
      deltas.push(inflateAt(fd, packSize, at + i + 20, size));
      base = findObject(store, baseOid, d + 1);
    } else {
      throw new Error(`a pack entry has the unknown type ${typeCode}`);
    }
  }
  let data = base.data;
  for (let k = deltas.length - 1; k >= 0; k -= 1) data = applyDelta(data, deltas[k]!);
  return { type: base.type, data };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let p = 0;
  const varint = (): number => {
    let value = 0;
    let c: number;
    let shift = 0;
    do {
      c = delta[p++]!;
      value += (c & 0x7f) * 2 ** shift;
      shift += 7;
    } while (c & 0x80);
    return value;
  };
  if (varint() !== base.length) throw new Error("a pack delta names a base of another size");
  const out = Buffer.alloc(varint());
  let o = 0;
  while (p < delta.length) {
    const op = delta[p++]!;
    if (op & 0x80) {
      let from = 0;
      let length = 0;
      for (let bit = 0; bit < 4; bit += 1) if (op & (1 << bit)) from += delta[p++]! * 2 ** (8 * bit);
      for (let bit = 0; bit < 3; bit += 1) if (op & (0x10 << bit)) length += delta[p++]! * 2 ** (8 * bit);
      if (length === 0) length = 0x10000;
      if (from + length > base.length || o + length > out.length) throw new Error("a pack delta copies outside its base");
      base.copy(out, o, from, from + length);
      o += length;
    } else if (op !== 0) {
      if (p + op > delta.length || o + op > out.length) throw new Error("a pack delta inserts past its end");
      delta.copy(out, o, p, p + op);
      o += op;
      p += op;
    } else {
      throw new Error("a pack delta has a zero opcode");
    }
  }
  if (o !== out.length) throw new Error("a pack delta ends short of its size");
  return out;
}
