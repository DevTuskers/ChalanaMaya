/**
 * The live socket of a session board (plan §3.6, phase 3). Connects to
 * `/api/sessions/:id/socket`, says `hello` with the last rev seen, hands the
 * socket to the SyncClient and feeds it every server message. On a drop it
 * reconnects with back-off (0.5 s doubling to 10 s, with jitter); the browser's
 * `offline` event closes the socket at once and `online` reconnects right away.
 */
import type { ServerMessage } from "../shared/protocol";
import { getBoardKey } from "./api";
import type { SyncClient } from "./client";

export const RECONNECT_MIN_MS = 500;
export const RECONNECT_MAX_MS = 10_000;
const PING_MS = 25_000;

type SocketCtor = new (url: string) => WebSocket;

export const socketUrl = (loc: { protocol: string; host: string }, sessionId: string) =>
  `${loc.protocol === "https:" ? "wss:" : "ws:"}//${loc.host}/api/sessions/${sessionId}/socket`;

export class LiveChannel {
  private ws: WebSocket | null = null;
  private backoff = 0;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private ping: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  /** sockets opened so far (tests) */
  connects = 0;

  constructor(
    private readonly client: SyncClient,
    private readonly url: string,
    private readonly win: Pick<Window, "addEventListener" | "removeEventListener"> | null = null,
    private readonly Socket: SocketCtor = WebSocket,
  ) {}

  start() {
    this.win?.addEventListener("offline", this.onOffline);
    this.win?.addEventListener("online", this.onOnline);
    this.connect();
  }

  dispose() {
    this.closed = true;
    this.win?.removeEventListener("offline", this.onOffline);
    this.win?.removeEventListener("online", this.onOnline);
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.drop();
  }

  /** Closes the socket as if the network went away (tests). */
  disconnect() {
    this.drop();
    this.scheduleReconnect();
  }

  private onOffline = () => this.disconnect();

  private onOnline = () => {
    if (this.closed || this.ws) return;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.backoff = 0;
    this.connect();
  };

  private drop() {
    const ws = this.ws;
    if (!ws) return;
    this.ws = null;
    if (this.ping) clearInterval(this.ping);
    this.ping = null;
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
    try {
      ws.close();
    } catch {
      // already closing
    }
    this.client.detach();
  }

  private connect() {
    if (this.closed || this.ws) return;
    let ws: WebSocket;
    try {
      ws = new this.Socket(this.url);
    } catch {
      this.client.detach();
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    this.connects += 1;
    ws.onopen = () => {
      this.backoff = 0;
      // keyed hosts authenticate the socket inside hello (never the URL)
      const hello = this.client.hello();
      const key = getBoardKey();
      if (key && hello.type === "hello") hello.key = key;
      ws.send(JSON.stringify(hello));
      this.client.attach({ send: (m) => ws.send(JSON.stringify(m)) });
      this.ping = setInterval(() => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "ping" }));
      }, PING_MS);
    };
    ws.onmessage = (e) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(e.data)) as ServerMessage;
      } catch {
        return;
      }
      this.client.receive(msg);
    };
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      this.drop();
      // 4404: the board was deleted; there is nothing to reconnect to
      if (e?.code === 4404) {
        this.closed = true;
        return;
      }
      this.scheduleReconnect();
    };
    ws.onerror = () => ws.close();
  }

  private scheduleReconnect() {
    if (this.closed || this.retry) return;
    this.backoff = Math.min(RECONNECT_MAX_MS, this.backoff ? this.backoff * 2 : RECONNECT_MIN_MS);
    const delay = this.backoff * (0.75 + Math.random() * 0.5);
    this.retry = setTimeout(() => {
      this.retry = null;
      this.connect();
    }, delay);
  }
}
