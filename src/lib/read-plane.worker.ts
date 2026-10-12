import { isMainThread, parentPort, workerData, type MessagePort } from "node:worker_threads";
import { READ_PLANE_KIND } from "./read-plane.js";

export function readPlaneWorkerInput<T>(): T | undefined {
  return !isMainThread && workerData?.kind === READ_PLANE_KIND ? workerData.input as T : undefined;
}

export function readPlaneWorkerLog(step: string, extra?: Record<string, unknown>): void {
  parentPort?.postMessage({ kind: "log", step, extra });
}

// The composition root installs its read-only producer; this library never imports the CLI.
export function runReadPlaneWorker<I, O>(produce: (input: I) => O | Promise<O>,
  port: Pick<MessagePort, "on" | "postMessage"> | null = parentPort): void {
  if (!port) throw new Error("read plane requires a worker port");
  let tail: Promise<unknown> = Promise.resolve();
  port.on("message", (request: { generation: number; input: I }) => {
    tail = tail.then(async () => {
      try {
        const facts = await produce(request.input);
        port.postMessage({ generation: request.generation, facts });
      } catch (error) {
        port.postMessage({ generation: request.generation, error: String(error) });
      }
    });
  });
}
