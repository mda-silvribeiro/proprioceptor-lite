// In-memory stand-ins for the Durable Object runtime, so src/do.ts and
// src/worker.ts can be exercised under plain Node. Nothing here is shipped.

import type { DoState, DoStorage } from "../../src/do";
import { Lobby, MotionSession, TOKEN_HEADER } from "../../src/do";
import type { Env } from "../../src/worker";

/** Storage that behaves like the real thing for the operations we use. */
export class MemoryStorage implements DoStorage {
  private readonly map = new Map<string, string>();
  alarmAtMs: number | null = null;
  deleteAllCalls = 0;
  putCalls = 0;

  async get<T>(key: string): Promise<T | undefined> {
    const raw = this.map.get(key);
    if (raw === undefined) return undefined;
    // Real storage serialises values, so hand back a copy: a test must not be
    // able to observe an object the object under test still references. The
    // assertion mirrors the real API, whose generic is likewise unchecked.
    return JSON.parse(raw) as T;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.putCalls++;
    this.map.set(key, JSON.stringify(value));
  }

  async delete(key: string): Promise<boolean> {
    return this.map.delete(key);
  }

  async deleteAll(): Promise<void> {
    this.deleteAllCalls++;
    this.map.clear();
    this.alarmAtMs = null;
  }

  async setAlarm(scheduledTime: number): Promise<void> {
    this.alarmAtMs = scheduledTime;
  }

  async deleteAlarm(): Promise<void> {
    this.alarmAtMs = null;
  }

  keys(): string[] {
    return [...this.map.keys()].sort();
  }

  size(): number {
    return this.map.size;
  }

  /** Bytes a value occupies once serialised — used to check snapshot budgets. */
  byteLength(key: string): number {
    return new TextEncoder().encode(this.map.get(key) ?? "").byteLength;
  }
}

export class TestClock {
  private ms: number;

  constructor(startMs = 1_700_000_000_000) {
    this.ms = startMs;
  }

  now = (): number => this.ms;

  advance(ms: number): void {
    this.ms += ms;
  }

  set(ms: number): void {
    this.ms = ms;
  }
}

export interface Stub {
  fetch(request: Request): Promise<Response>;
}

/** Names a Durable Object the same way idFromName does: one instance per name. */
export class FakeNamespace<T extends Stub> {
  readonly storages = new Map<string, MemoryStorage>();
  private readonly instances = new Map<string, T>();
  private readonly factory: (state: DoState, storage: MemoryStorage) => T;

  constructor(factory: (state: DoState, storage: MemoryStorage) => T) {
    this.factory = factory;
  }

  idFromName(name: string): { name: string } {
    return { name };
  }

  get(id: { name: string }): T {
    return this.instance(id.name);
  }

  instance(name: string): T {
    const existing = this.instances.get(name);
    if (existing !== undefined) return existing;
    const storage = new MemoryStorage();
    const created = this.factory({ storage }, storage);
    this.storages.set(name, storage);
    this.instances.set(name, created);
    return created;
  }

  storage(name: string): MemoryStorage {
    this.instance(name);
    const storage = this.storages.get(name);
    if (storage === undefined) throw new Error(`no storage for ${name}`);
    return storage;
  }

  /** Drop the in-memory instance, keeping storage: models an isolate restart. */
  evict(name: string): void {
    this.instances.delete(name);
  }

  restart(name: string): T {
    const storage = this.storages.get(name);
    if (storage === undefined) throw new Error(`no storage for ${name}`);
    const created = this.factory({ storage }, storage);
    this.instances.set(name, created);
    return created;
  }
}

export interface Harness {
  env: Env;
  clock: TestClock;
  lobby: FakeNamespace<Lobby>;
  sessions: FakeNamespace<MotionSession>;
  assetRequests: Request[];
}

/** A Worker environment wired to in-memory Durable Objects and a stub assets binding. */
export function harness(clock: TestClock = new TestClock()): Harness {
  const lobby = new FakeNamespace<Lobby>((state) => new Lobby(state, {}, { now: clock.now }));
  const sessions = new FakeNamespace<MotionSession>(
    (state) => new MotionSession(state, {}, { now: clock.now }),
  );
  const assetRequests: Request[] = [];
  const assets = {
    async fetch(request: Request): Promise<Response> {
      assetRequests.push(request);
      return new Response("<!doctype html><title>page</title>", {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    },
  };

  // One assertion, deliberately narrow: the fakes implement exactly the members
  // the Worker calls (idFromName/get/fetch), not the whole runtime interface.
  const env = { ASSETS: assets, LOBBY: lobby, MOTION_SESSION: sessions } as unknown as Env;
  return { env, clock, lobby, sessions, assetRequests };
}

const JSON_TYPE = { "content-type": "application/json" };

export function postJson(url: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(url, {
    method: "POST",
    headers: { ...JSON_TYPE, ...headers },
    body: JSON.stringify(body),
  });
}

export function getReq(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, { method: "GET", headers });
}

/** A request as the Worker forwards it to a MotionSession. */
export function internal(path: string, token: string, body?: unknown): Request {
  const url = `https://motion-session.internal${path}`;
  const headers = { ...JSON_TYPE, [TOKEN_HEADER]: token };
  return body === undefined
    ? new Request(url, { method: "GET", headers })
    : new Request(url, { method: "POST", headers, body: JSON.stringify(body) });
}

export async function jsonOf(response: Response): Promise<Record<string, unknown>> {
  const parsed: unknown = await response.json();
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`expected a JSON object, got ${JSON.stringify(parsed)}`);
  }
  // Narrowed above; the assertion only widens to an index signature.
  return parsed as Record<string, unknown>;
}
