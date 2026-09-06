// Bybit WebSocket V5 client with auto-reconnect, heartbeat, and topic subscription.
// Supports both public (market data) and private (orders, wallet) streams.

import { createHmac, randomUUID } from "node:crypto";
import { type BybitConfig, BYBIT_WS_PUBLIC, BYBIT_WS_PRIVATE, BybitConnectionError } from "./types.ts";

export type WsMessageHandler = (topic: string, data: unknown) => void;

interface SubscriptionState {
  topic: string;
  subscribed: boolean;
}

export class WsClient {
  private config: BybitConfig;
  private ws: WebSocket | null = null;
  private isPrivate: boolean;
  private url: string;
  private handlers = new Map<string, Set<WsMessageHandler>>();
  private subscriptions = new Map<string, SubscriptionState>();
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts: number;
  private pingIntervalMs: number;
  private _connected = false;
  private _latencyMs = 0;

  constructor(config: BybitConfig, isPrivate = false) {
    this.config = config;
    this.isPrivate = isPrivate;
    this.url = isPrivate
      ? (config.testnet ? BYBIT_WS_PRIVATE.testnet : BYBIT_WS_PRIVATE.mainnet)
      : (config.testnet ? BYBIT_WS_PUBLIC.testnet : BYBIT_WS_PUBLIC.mainnet);
    this.maxReconnectAttempts = config.maxRetries ?? 5;
    this.pingIntervalMs = config.wsPingIntervalMs ?? 20000;
  }

  /** Connect to the WebSocket stream. */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.url);
      } catch (err) {
        reject(new BybitConnectionError(`Failed to create WebSocket: ${(err as Error).message}`));
        return;
      }

      this.ws.onopen = async () => {
        this._connected = true;
        this.reconnectAttempts = 0;

        // Authenticate if private stream
        if (this.isPrivate) {
          await this.authenticate();
        }

        // Resubscribe to all topics
        for (const [topic, state] of this.subscriptions) {
          if (state.subscribed) {
            this.sendSubscribe(topic);
          }
        }

        // Start heartbeat
        this.startPing();

        resolve();
      };

      this.ws.onmessage = (event: MessageEvent) => {
        this.handleMessage(event.data as string);
      };

      this.ws.onclose = () => {
        this._connected = false;
        this.stopPing();
        this.tryReconnect();
      };

      this.ws.onerror = (err) => {
        // onclose will fire after this
        console.error(`[bybit:ws] WebSocket error:`, err);
      };
    });
  }

  /** Disconnect and clean up. */
  disconnect(): void {
    this.stopPing();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.maxReconnectAttempts = 0; // prevent reconnect
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this._connected = false;
  }

  /** Subscribe to one or more topics. */
  subscribe(topics: string[]): void {
    for (const topic of topics) {
      this.subscriptions.set(topic, { topic, subscribed: true });
      if (this._connected) {
        this.sendSubscribe(topic);
      }
    }
  }

  /** Unsubscribe from topics. */
  unsubscribe(topics: string[]): void {
    for (const topic of topics) {
      this.subscriptions.set(topic, { topic, subscribed: false });
      if (this._connected) {
        this.ws?.send(JSON.stringify({ op: "unsubscribe", args: [topic] }));
      }
    }
  }

  /** Register a handler for messages on a specific topic. */
  on(topic: string, handler: WsMessageHandler): void {
    let handlers = this.handlers.get(topic);
    if (!handlers) {
      handlers = new Set();
      this.handlers.set(topic, handlers);
    }
    handlers.add(handler);
  }

  /** Remove a handler. */
  off(topic: string, handler: WsMessageHandler): void {
    this.handlers.get(topic)?.delete(handler);
  }

  /** Connection status. */
  isConnected(): boolean {
    return this._connected;
  }

  /** Get latency (ms). */
  getLatencyMs(): number {
    return this._latencyMs;
  }

  /** Get currently subscribed topics. */
  getSubscribedTopics(): string[] {
    return Array.from(this.subscriptions.entries())
      .filter(([_, s]) => s.subscribed)
      .map(([topic, _]) => topic);
  }

  // ── Private Methods ────────────────────────────────────────────────

  private sendSubscribe(topic: string): void {
    this.ws?.send(JSON.stringify({ op: "subscribe", args: [topic] }));
  }

  private async authenticate(): Promise<void> {
    const expires = Date.now() + 10000;
    const signature = createHmac("sha256", this.config.apiSecret)
      .update(`GET/realtime${expires}`)
      .digest("hex");

    this.ws?.send(JSON.stringify({
      op: "auth",
      args: [this.config.apiKey, expires, signature],
    }));

    // Wait for auth response
    await new Promise<void>((resolve, reject) => {
      if (!this.ws) return reject(new BybitConnectionError("WebSocket not connected"));

      const handler = (event: MessageEvent) => {
        try {
          const msg = JSON.parse(event.data as string);
          if (msg.op === "auth" && msg.success) {
            resolve();
          } else if (msg.op === "auth" && !msg.success) {
            reject(new BybitConnectionError(`Auth failed: ${msg.ret_msg}`));
          }
        } catch { /* not an auth response */ }
      };

      this.ws!.addEventListener("message", handler, { once: true });
      // Timeout after 5s
      setTimeout(() => reject(new BybitConnectionError("Auth timeout")), 5000);
    });
  }

  private startPing(): void {
    this.pingTimer = setInterval(() => {
      const start = Date.now();
      this.ws?.send(JSON.stringify({ op: "ping", req_id: randomUUID().slice(0, 8) }));

      // Estimate latency — next pong will update _latencyMs
      const onPong = (event: MessageEvent) => {
        try {
          const msg = JSON.parse(event.data as string);
          if (msg.op === "pong") {
            this._latencyMs = Date.now() - start;
            this.ws?.removeEventListener("message", onPong);
          }
        } catch { /* ignore */ }
      };
      this.ws?.addEventListener("message", onPong);
    }, this.pingIntervalMs);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private handleMessage(raw: string): void {
    try {
      const msg = JSON.parse(raw);

      // Handle pong
      if (msg.op === "pong") return;

      // Handle subscription response
      if (msg.op === "subscribe") {
        console.log(`[bybit:ws] Subscribed to: ${msg.ret_msg}`);
        return;
      }

      // Handle topic data
      if (msg.topic) {
        const handlers = this.handlers.get(msg.topic);
        if (handlers) {
          for (const handler of handlers) {
            handler(msg.topic, msg.data || msg);
          }
        }
      }
    } catch {
      // Ignore parse errors (e.g., keepalive comments)
    }
  }

  private tryReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error(`[bybit:ws] Max reconnect attempts (${this.maxReconnectAttempts}) reached.`);
      return;
    }

    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 16000);
    this.reconnectAttempts++;

    console.log(`[bybit:ws] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

    this.reconnectTimer = setTimeout(() => {
      this.connect().catch((err) => {
        console.error(`[bybit:ws] Reconnect failed:`, err.message);
      });
    }, delay);
  }
}