/** Local SDK resource integration. Production admission and activation belong to the caller. */
import { nativeCanarySession, type NativeCanarySessionConfig, type NativeCanarySessionPorts } from "./model-canary-native-session.js";
import { canaryNativeStreamCapture } from "./model-canary-native-stream.js";
import type { CanaryRequest, CanaryResponse } from "./model-canary-runner.js";

export function nativeCanaryAdapter(config: NativeCanarySessionConfig, ports?: NativeCanarySessionPorts) {
  const session = nativeCanarySession(config, ports);
  const now = ports?.monotonicMs ?? (() => performance.now());
  return {
    async request(request: CanaryRequest): Promise<CanaryResponse & {
      observation: ReturnType<ReturnType<typeof canaryNativeStreamCapture>["finish"]>["observation"];
      native: { state: "complete" | "unavailable"; reason: string; promptSent: boolean; framesObserved: number; adapterQualified: false };
    }> {
      const capture = canaryNativeStreamCapture(now(), request.pin.billing, request.maxOutputBytes);
      const turn = await session.turn(request, (message, atMs) => capture.event(message, atMs));
      const measured = capture.finish(now(), request.signal.aborted ? "timeout" : turn.state === "complete" ? "complete" : "error");
      // A successful process result cannot qualify incomplete, mixed or reset resource evidence.
      // Close this session's resume authority after either kind of unavailable turn.
      if (measured.resources.terminal !== "complete") session.seal();
      return { text: measured.text, toolCalls: [], resources: measured.resources, observation: measured.observation,
        native: { state: turn.state, reason: turn.reason, promptSent: turn.promptSent,
          framesObserved: turn.framesObserved, adapterQualified: false } };
    },
  };
}
