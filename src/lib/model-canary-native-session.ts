/** Native process/session mechanics. This is not activation or a qualified model adapter. */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";
import type { query, AccountInfo, Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { nativeCanaryToolPolicy } from "./model-canary-native-tool-policy.js";
import type { CanaryRequest } from "./model-canary-runner.js";

const exec = promisify(execFile);
const object = (value: unknown): Record<string, unknown> | undefined => value !== null
  && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const errorType = (error: unknown) => error instanceof Error ? error.name : "non-error";

export interface NativeCanarySessionConfig {
  /** Harness-owned private scratch directory and explicitly selected matching native executable. */
  cwd: string;
  executable: string;
  env: NodeJS.ProcessEnv;
  maxUserTurns: 8 | 25 | 50;
}
export interface NativeCanarySessionPorts {
  authority(config: NativeCanarySessionConfig, signal: AbortSignal): Promise<unknown>;
  query: typeof query;
  monotonicMs(): number;
}
async function nativeAuthority(config: NativeCanarySessionConfig, signal: AbortSignal) {
  const options = { cwd: config.cwd, env: config.env, signal, timeout: 15_000, maxBuffer: 16_384, encoding: "utf8" as const };
  const version = await exec(config.executable, ["--version"], options);
  if (version.stdout.trim() !== "2.1.303 (Claude Code)") throw new Error("native-cli-version-mismatch");
  const auth = await exec(config.executable, ["auth", "status"], options);
  return JSON.parse(auth.stdout) as unknown;
}

export interface NativeCanaryTurn {
  state: "complete" | "unavailable";
  reason: string;
  text: string;
  promptSent: boolean;
  framesObserved: number;
  /** Private correlation only. It is not served model identity or whole-fix adoption. */
  sessionId: string;
  turn: number;
  errorType?: string;
  cleanupFailure?: string;
  adapterQualified: false;
}

/** No externally selected resume ID, no synthesized assistant messages, no overlapping user turns. */
export function nativeCanarySession(config: NativeCanarySessionConfig, ports?: NativeCanarySessionPorts) {
  if (!isAbsolute(config.cwd) || !isAbsolute(config.executable) || ![8, 25, 50].includes(config.maxUserTurns))
    throw new Error("canary-native-session-config-invalid");
  // SDK process options overlay the parent's environment. Freeze that actual effective environment
  // once; refuse cash/provider/auth overrides before even running the native authority probe.
  const env = { ...process.env, ...config.env };
  const unsafe = Object.entries(env).some(([name, value]) => value !== undefined && value !== ""
    && /^(ANTHROPIC_|CLAUDE_CODE_USE_|CLAUDE_CODE_OAUTH_TOKEN$|CLAUDE_CODE_SESSION_ACCESS_TOKEN$|CLAUDE_CODE_EXTRA_BODY$)/.test(name));
  const owned = { ...config, env }, sessionId = randomUUID();
  let busy = false, sealed = false, turns = 0, pin: string | undefined, instruction: string | undefined;
  const transcript: { role: "system" | "user" | "assistant"; content: string }[] = [];
  return {
    /** The resource consumer may discover uncertainty after the native terminal result. */
    seal() { sealed = true; },
    async turn(request: CanaryRequest, consume: (message: SDKMessage, atMs: number) => void): Promise<NativeCanaryTurn> {
      const outcome: NativeCanaryTurn = { state: "unavailable", reason: "native-session-refused", text: "",
        promptSent: false, framesObserved: 0, sessionId, turn: turns + 1, adapterQualified: false };
      if (busy || sealed || turns >= config.maxUserTurns || request.signal.aborted || unsafe
        || request.pin.billing !== "subscription" || request.history.length !== 0) {
        outcome.reason = busy ? "native-session-busy" : unsafe ? "native-subscription-env-unproven" : "native-session-unavailable";
        return outcome;
      }
      const signature = JSON.stringify(request.pin);
      const supplied = request.conversation;
      if (!pin) {
        if (supplied && (supplied.length !== 2 || supplied[0]?.role !== "system" || supplied[1]?.role !== "user")) {
          outcome.reason = "native-session-replay-refused"; return outcome;
        }
        instruction = supplied?.[0]?.content;
      }
      const expected = [...transcript, { role: "user" as const, content: request.prompt }];
      if (!pin && instruction !== undefined) expected.unshift({ role: "system", content: instruction });
      if ((pin && pin !== signature) || (supplied && JSON.stringify(supplied) !== JSON.stringify(expected))
        || (turns > 0 && !supplied) || Buffer.byteLength(JSON.stringify(expected), "utf8") > 128 * 1024
        || !Number.isInteger(request.maxOutputBytes) || request.maxOutputBytes < 1 || request.maxOutputBytes > 65_536
        || !["low", "medium", "high", "xhigh", "max"].includes(request.pin.effort)) {
        outcome.reason = "native-session-contract-mismatch"; return outcome;
      }
      busy = true;
      const abort = new AbortController(), onAbort = () => abort.abort();
      request.signal.addEventListener("abort", onAbort, { once: true });
      if (request.signal.aborted) onAbort();
      let stream: ReturnType<typeof query> | undefined;
      let release: (accepted: boolean) => void = () => {};
      const gate = new Promise<boolean>(resolve => { release = resolve; });
      let phase = "native-tool-contract", resultCount = 0, visibleBytes = 0;
      try {
        nativeCanaryToolPolicy(request);
        phase = "native-authority";
        const authority = object(await (ports?.authority ?? nativeAuthority)(owned, abort.signal));
        if (authority?.loggedIn !== true || authority.authMethod !== "claude.ai" || authority.apiProvider !== "firstParty"
          || typeof authority.subscriptionType !== "string" || !authority.subscriptionType.trim()) {
          outcome.reason = "native-subscription-authority-unproven"; return outcome;
        }
        if (abort.signal.aborted) { outcome.reason = "native-aborted"; return outcome; }
        // Held/refused turns allocate neither the SDK nor the synthetic tool server.
        // Validate the pure policy above before the real authority probe.
        phase = "native-tool-contract";
        const { nativeCanaryTools } = await import("./model-canary-native-tools.js");
        const tools = nativeCanaryTools(request);
        async function* prompt(): AsyncGenerator<SDKUserMessage> {
          if (!(await gate) || abort.signal.aborted) return;
          outcome.promptSent = true;
          yield { type: "user", message: { role: "user", content: request.prompt }, parent_tool_use_id: null, session_id: sessionId };
        }
        phase = "native-sdk-initialize";
        const options: Options = { ...tools.options, cwd: config.cwd, env, pathToClaudeCodeExecutable: config.executable,
          model: request.pin.model, effort: request.pin.effort as Options["effort"], abortController: abort,
          maxTurns: 3, persistSession: true, includePartialMessages: true, systemPrompt: instruction,
          ...(turns === 0 ? { sessionId } : { resume: sessionId }),
          extraArgs: { "permission-prompts": "none", "disable-slash-commands": null },
        };
        if (abort.signal.aborted) { outcome.reason = "native-aborted"; return outcome; }
        const runQuery = ports ? ports.query : (await import("@anthropic-ai/claude-agent-sdk")).query;
        if (abort.signal.aborted) { outcome.reason = "native-aborted"; return outcome; }
        stream = runQuery({ prompt: prompt(), options });
        const account: AccountInfo = await stream.accountInfo();
        // Account data comes from THIS initialized SDK child, before its generator sends a prompt.
        // 'none' alone is not OAuth evidence; the same native CLI must also positively report claude.ai.
        if (abort.signal.aborted) { outcome.reason = "native-aborted"; return outcome; }
        if (account.apiProvider !== "firstParty" || account.apiKeySource !== "none"
          || account.subscriptionType !== authority.subscriptionType) {
          outcome.reason = "native-effective-subscription-unproven"; return outcome;
        }
        release(true);
        phase = "native-stream";
        for await (const message of stream) {
          outcome.framesObserved++;
          if (outcome.framesObserved > 8192 || message.session_id !== sessionId || resultCount !== 0) {
            outcome.reason = "native-session-frame-scope-unproven"; return outcome;
          }
          if (message.type === "stream_event" && message.event.type === "content_block_delta"
            && message.event.delta.type === "text_delta") visibleBytes += Buffer.byteLength(message.event.delta.text, "utf8");
          if (visibleBytes > request.maxOutputBytes) { outcome.reason = "native-output-bound"; return outcome; }
          if (message.type === "system" && message.subtype === "init" && (message.apiKeySource !== "none"
            || message.claude_code_version !== "2.1.303" || message.permissionMode !== "dontAsk")) {
            outcome.reason = "native-initialization-contract-mismatch"; return outcome;
          }
          phase = "native-capture"; consume(message, ports ? ports.monotonicMs() : performance.now()); phase = "native-stream";
          if (message.type === "result") {
            resultCount++;
            if (message.subtype !== "success" || message.is_error !== false || message.permission_denials.length !== 0
              || Buffer.byteLength(message.result, "utf8") > request.maxOutputBytes) {
              outcome.reason = "native-result-unavailable"; return outcome;
            }
            outcome.text = message.result;
          }
        }
        const toolFailure = tools.unavailable();
        if (abort.signal.aborted || resultCount !== 1 || !outcome.promptSent || toolFailure) {
          outcome.reason = toolFailure?.reason ?? (abort.signal.aborted ? "native-aborted" : "native-terminal-missing"); return outcome;
        }
        outcome.state = "complete"; outcome.reason = "native-turn-complete";
        pin = signature; turns++;
        transcript.splice(0, transcript.length, ...expected, { role: "assistant", content: outcome.text });
        return outcome;
      } catch (error) {
        Object.assign(outcome, { state: "unavailable", reason: abort.signal.aborted ? "native-aborted" : phase + "-unavailable",
          errorType: errorType(error) }); return outcome;
      } finally {
        release(false); abort.abort(); request.signal.removeEventListener("abort", onAbort);
        try { stream?.close(); }
        catch (error) { Object.assign(outcome, { cleanupFailure: errorType(error), state: "unavailable", reason: "native-cleanup-unavailable" }); }
        busy = false;
        // An uncertain native turn cannot be resumed or silently retried by this session owner.
        if (outcome.state !== "complete") sealed = true;
      }
    },
  };
}
