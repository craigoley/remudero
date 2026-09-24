/**
 * One SSE publisher per stream, fanned out to every subscriber: the source work (a ledger tail, a
 * derive) runs once however many clients listen. Wire contract: ~/Remudero/.session-scratch/sse-contract.md
 * (W1-T4455, CONSOLE-T70).
 *
 * - Every event carries `id: <bootId>:<generation>`; generation is monotonic per publisher.
 * - The last {@link SSE_RETAINED_EVENTS} events are kept. A `Last-Event-ID` inside that window
 *   replays what the client missed; a foreign boot or an older generation gets `event: resync`
 *   `{"reason":"gap"}` first, and the client re-reads its snapshot once. No id means no replay.
 * - A `: hb` comment goes to every subscriber every {@link SSE_HEARTBEAT_MS}, under Cloudflare's
 *   ~100 s proxy idle cut.
 * - The source starts on the first subscriber and stops when the last one leaves.
 */
import { randomBytes } from "node:crypto";
import type { Task } from "./plan.js";
import type { SseSend, SseStream } from "./service.js";
import { createLedgerTailCache, readLedgerTail, type BoardDeps } from "./status.js";

export const SSE_HEARTBEAT_MS = 25_000;
export const SSE_RETAINED_EVENTS = 500;
/** Changes on every serve restart, so a resume across a restart is recognised as a gap. */
export const SSE_BOOT_ID = randomBytes(6).toString("base64url");

export interface SseSubscriber {
  send: SseSend;
  stream?: SseStream;
}

export interface SsePublisher {
  subscribe(subscriber: SseSubscriber): () => void;
  publish(event: string, data: unknown): void;
  subscriberCount(): number;
}

export interface SsePublisherOptions {
  /** Starts the source; returns its stop. Runs on the first subscriber, stops after the last. */
  start: (publisher: SsePublisher) => () => void;
  bootId?: string;
  heartbeatMs?: number;
  retained?: number;
  setInterval?: (run: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

interface RetainedEvent {
  generation: number;
  event: string;
  data: unknown;
}

/** `<bootId>:<generation>` → the generation, or undefined when the id is foreign, malformed or absent. */
export function parseSseEventId(id: string | undefined, bootId: string): number | undefined {
  if (!id) return undefined;
  const at = id.lastIndexOf(":");
  if (at < 0 || id.slice(0, at) !== bootId) return undefined;
  const generation = Number(id.slice(at + 1));
  return Number.isSafeInteger(generation) && generation >= 0 ? generation : undefined;
}

export function createSsePublisher(options: SsePublisherOptions): SsePublisher {
  const bootId = options.bootId ?? SSE_BOOT_ID;
  const heartbeatMs = options.heartbeatMs ?? SSE_HEARTBEAT_MS;
  const retained = options.retained ?? SSE_RETAINED_EVENTS;
  const setTimer = options.setInterval ?? ((run: () => void, ms: number) => setInterval(run, ms));
  const clearTimer = options.clearInterval ?? ((handle: unknown) => clearInterval(handle as NodeJS.Timeout));
  const subscribers = new Set<SseSubscriber>();
  const ring: RetainedEvent[] = [];
  let generation = 0;
  let stopSource: (() => void) | undefined;
  let heartbeat: unknown;

  const idOf = (g: number) => `${bootId}:${g}`;
  const deliver = (subscriber: SseSubscriber, retainedEvent: RetainedEvent) =>
    subscriber.send(retainedEvent.event, retainedEvent.data, idOf(retainedEvent.generation));

  const resume = (subscriber: SseSubscriber): void => {
    const lastEventId = subscriber.stream?.lastEventId;
    if (!lastEventId) return;
    const seen = parseSseEventId(lastEventId, bootId);
    const oldest = ring.length > 0 ? ring[0].generation : generation + 1;
    if (seen === undefined || seen > generation || seen < oldest - 1) {
      subscriber.send("resync", { reason: "gap" }, idOf(generation));
      return;
    }
    for (const missed of ring) if (missed.generation > seen) deliver(subscriber, missed);
  };

  const publisher: SsePublisher = {
    subscribe(subscriber) {
      subscribers.add(subscriber);
      resume(subscriber);
      if (subscribers.size === 1) {
        heartbeat = setTimer(() => {
          for (const s of subscribers) s.stream?.comment("hb");
        }, heartbeatMs);
        (heartbeat as { unref?: () => void } | undefined)?.unref?.();
        stopSource = options.start(publisher);
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        subscribers.delete(subscriber);
        if (subscribers.size > 0) return;
        clearTimer(heartbeat);
        stopSource?.();
        stopSource = undefined;
      };
    },
    publish(event, data) {
      generation += 1;
      const retainedEvent = { generation, event, data };
      ring.push(retainedEvent);
      if (ring.length > retained) ring.shift();
      for (const subscriber of subscribers) deliver(subscriber, retainedEvent);
    },
    subscriberCount: () => subscribers.size,
  };
  return publisher;
}

/** One task's streamed projection over a given ledger view (board.ts supplies it: deriveStatus plus live spend). */
export type StatusStreamProjector = (task: Task, deps: BoardDeps, lines: Array<Record<string, unknown>>) => unknown;

/**
 * The per-task status source: ONE ledger tail and ONE last-sent map for every subscriber. A task's
 * "before" projection is derived lazily, off the lines the publisher had already seen, the first
 * time a new line touches it: priming every plan task up front held the loop ~9.8 s per subscribe
 * on the host's 2,320-task plan.
 */
function startStatusSource(deps: BoardDeps, pollMs: number, project: StatusStreamProjector, publisher: SsePublisher): () => void {
  // An unchanged ledger between ticks costs one stat, not a re-read.
  const tail = createLedgerTailCache();
  const readLedger = deps.readLedger ?? ((path: string) => readLedgerTail(path, tail));
  const deriveOver = (task: Task, lines: Array<Record<string, unknown>>): string => JSON.stringify(project(task, { ...deps, readLedger: () => lines }, lines));
  let lastLineCount = readLedger(deps.ledgerPath).length;
  const lastSent = new Map<string, string>();

  const tick = (): void => {
    const lines = readLedger(deps.ledgerPath);
    if (lines.length <= lastLineCount) return;
    const seen = lines.slice(0, lastLineCount);
    const newLines = lines.slice(lastLineCount);
    lastLineCount = lines.length;
    const touched = new Set<string>();
    for (const line of newLines) if (typeof line.task_id === "string") touched.add(line.task_id);
    for (const taskId of touched) {
      const task = deps.plan.byId.get(taskId);
      if (!task) continue;
      if (!lastSent.has(taskId)) lastSent.set(taskId, deriveOver(task, seen));
      const serialized = deriveOver(task, lines);
      if (lastSent.get(taskId) === serialized) continue;
      lastSent.set(taskId, serialized);
      publisher.publish("status", JSON.parse(serialized));
    }
  };
  const timer = setInterval(tick, pollMs);
  return () => clearInterval(timer);
}

const statusPublishers = new WeakMap<BoardDeps, SsePublisher>();

/** Subscribes one `/v1/status/stream` client to the board's shared publisher, creating it on first use. */
export function subscribeStatusStream(
  deps: BoardDeps,
  pollMs: number,
  subscriber: SseSubscriber,
  project: StatusStreamProjector,
  publisherOptions: Omit<SsePublisherOptions, "start"> = {},
): () => void {
  let publisher = statusPublishers.get(deps);
  if (!publisher) {
    publisher = createSsePublisher({ ...publisherOptions, start: (p) => startStatusSource(deps, pollMs, project, p) });
    statusPublishers.set(deps, publisher);
  }
  return publisher.subscribe(subscriber);
}
