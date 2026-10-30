import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readSelectedInstanceRegistry, type RegistrySelectionInput } from "./lib/instance-registry-selection.js";
import { copySelectedRegistryIntent } from "./lib/selected-registry-consumers.js";

const consumers = new Set(["install", "launcher", "recycle", "serve", "host-update", "field-trials", "heartbeat"]);
interface Session {
  version: 1;
  input: RegistrySelectionInput;
  initial: "ready" | "absent" | "unknown";
}
const flags = new Set(["--session", "--consumer", "--instance", "--repository", "--namespace", "--identity",
  "--registry", "--contract-version", "--require-capability", "--pin"]);

async function privateParent(path: string): Promise<void> {
  if (!isAbsolute(path) || path.includes("\0")) throw new Error("invalid_session");
  const parent = await lstat(dirname(path));
  if (!parent.isDirectory() || (parent.mode & 0o077) !== 0 || parent.uid !== process.getuid?.()) throw new Error("unsafe_session");
}

async function sessionFile(path: string, write: boolean, exclusive = false) {
  await privateParent(path);
  const handle = await open(path, constants.O_NOFOLLOW | constants.O_NONBLOCK | (write
    ? constants.O_WRONLY | constants.O_CREAT | (exclusive ? constants.O_EXCL : constants.O_APPEND) : constants.O_RDONLY), 0o600);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0
      || stat.size > 65536) throw new Error("unsafe_session");
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function readSession(path: string): Promise<Session & { pin: string }> {
  const handle = await sessionFile(path, false);
  let text: string;
  try {
    const buffer = Buffer.alloc(65537);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 65536) throw new Error("oversized_session");
    text = buffer.subarray(0, bytesRead).toString("utf8");
  } finally { await handle.close(); }
  const session = JSON.parse(text) as Session;
  const intent = copySelectedRegistryIntent({ version: 1, kind: "shadow", input: session.input });
  if (session.version !== 1 || !["ready", "absent", "unknown"].includes(session.initial) || intent?.kind !== "shadow"
    || (session.initial === "ready" && intent.input.expectedDigest === undefined)
    || (intent.input.expectedDigest !== undefined && !/^[a-f0-9]{64}$/.test(intent.input.expectedDigest))) throw new Error("invalid_session");
  return { version: 1, input: intent.input, initial: session.initial,
    pin: createHash("sha256").update(text).digest("hex") };
}

/** Trusted, data-only qualification transport. It neither invokes nor authorizes any legacy effect. */
export async function selectedRegistryShadowMain(argv: readonly string[], env: NodeJS.ProcessEnv = process.env,
  signal?: AbortSignal): Promise<number> {
  const options = new Map<string, string>();
  let shadow = false, capture = false;
  if (argv.length > 30) return 2;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    if (flag === "--shadow") { shadow = true; continue; }
    if (flag === "--capture") { capture = true; continue; }
    const value = argv[++i];
    if (!flags.has(flag) || options.has(flag) || value === undefined || value.length > 4096) return 2;
    options.set(flag, value);
  }
  const path = options.get("--session"), consumer = options.get("--consumer"), pin = options.get("--pin");
  if (!shadow || !path || (!capture && !consumers.has(consumer ?? ""))) return 2;
  if (!capture && !/^[a-f0-9]{64}$/.test(pin ?? "")) return 2;
  try {
    if (capture) {
      const envPath = env.RMD_INSTANCE_REGISTRY;
      const input: RegistrySelectionInput = {
        ...(options.has("--registry") ? { cliPath: options.get("--registry") } : {}),
        envPath: envPath !== undefined && envPath.length > 4096 ? "" : envPath,
        contractVersion: options.has("--contract-version") ? Number(options.get("--contract-version")) : 1,
        requiredCapabilities: options.has("--require-capability") ? [options.get("--require-capability")!] : ["identity"],
      };
      const selected = await readSelectedInstanceRegistry({ ...input, signal });
      const session: Session = { version: 1, input: { ...input,
        ...(selected.kind === "ready" ? { expectedDigest: selected.binding.digest } : {}) },
        initial: selected.kind === "ready" ? "ready" : selected.kind === "legacy" ? "absent" : "unknown" };
      let handle;
      try { handle = await sessionFile(path, true, true); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        console.log((await readSession(path)).pin); // Reuse the pin; never silently rewrite it.
        return 0;
      }
      const text = JSON.stringify(session);
      try { await handle.writeFile(text); }
      finally { await handle.close(); }
      console.log(createHash("sha256").update(text).digest("hex"));
      return 0;
    }
    const session = await readSession(path);
    const sessionChanged = session.pin !== pin;
    const selected = sessionChanged ? { kind: "unknown" as const, reason: "session_changed" }
      : await readSelectedInstanceRegistry({ ...session.input, signal });
    const instance = options.get("--instance"), repository = options.get("--repository"), namespace = options.get("--namespace");
    const validTarget = (!instance || /^[A-Za-z0-9_-]+$/.test(instance))
      && (!repository || /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository));
    let selectedState = "unknown", reason: string | undefined;
    if (sessionChanged) reason = "session_changed";
    else if (session.initial === "absent") { selectedState = "absent"; reason = "selection_missing"; }
    else if (session.initial !== "ready") reason = "selection_unavailable";
    else if (selected.kind !== "ready") reason = selected.kind === "legacy" ? "selection_missing" : selected.reason;
    else if (!validTarget || (!instance && !repository)) reason = "target_unavailable";
    else if (namespace !== "host" || options.get("--identity")) reason = "namespace_unmapped";
    else {
      const checked = await selected.binding.recheck(signal);
      if (checked.kind !== "unchanged") reason = "reason" in checked ? checked.reason : "revision_changed";
      else {
        const rows = selected.binding.instances.filter(row => (!instance || row.name === instance)
          && (!repository || row.repo.toLowerCase() === repository.toLowerCase()));
        selectedState = rows.length === 0 ? "absent" : rows.every(row => !row.live) ? "retired" : "ready";
        if (selectedState !== "ready") reason = selectedState === "absent" ? "target_absent" : "target_retired";
      }
    }
    const fields = { mode: "shadow", action: consumer, selected_state: selectedState, reason,
      selected_outcome: selectedState === "ready" ? "would-observe" : "would-refuse",
      boundary: "attempt", namespace: namespace === "host" ? "host" : "unknown", mapping_state: "unknown",
      ...(validTarget && instance ? { target_instance: instance } : {}),
      ...(validTarget && repository ? { target_repo: repository.toLowerCase() } : {}),
      ...(options.has("--identity") ? { target_digest: createHash("sha256").update(options.get("--identity")!).digest("hex") } : {}),
      ...(!sessionChanged && session.input.expectedDigest ? { binding_digest: session.input.expectedDigest } : {}),
      ...(selected.kind === "ready" ? { contract_version: selected.binding.contractVersion,
        capabilities: selected.binding.capabilities } : {}), publication_permission: "not-granted" };
    const sink = await sessionFile(path + ".observations", true);
    try { await sink.writeFile(JSON.stringify(fields) + "\n"); }
    finally { await sink.close(); }
    return 0;
  } catch (error) {
    // Session, observer and sink failures share a safe diagnostic, never permission or a legacy exit.
    console.error("instance_registry.shell_shadow_unrecorded", error instanceof Error ? "observer_or_sink_failed" : "observer_failed");
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await selectedRegistryShadowMain(process.argv.slice(2));
}
