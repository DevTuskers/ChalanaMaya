/** Test helpers: a real server on a random port in 5000–5999 with a temp DATA_DIR. */
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createApp, type AppHandle } from "../app";
import { loadConfig, type Config, type Env } from "../config";
import { createShape } from "../../src/scene/elements";
import type { SceneElement } from "../../src/scene/types";
import { generateNKeysBetween } from "fractional-indexing";
import { newPushId } from "../../src/shared/ids";

export const tempDir = (prefix = "cm-test-") => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

export interface TestServer {
  base: string;
  port: number;
  cfg: Config;
  handle: AppHandle;
  close(): Promise<void>;
}

const listen = (server: http.Server, port: number) =>
  new Promise<boolean>((resolve, reject) => {
    const onError = (e: NodeJS.ErrnoException) => {
      server.off("listening", onOk);
      if (e.code === "EADDRINUSE") resolve(false);
      else reject(e);
    };
    const onOk = () => {
      server.off("error", onError);
      resolve(true);
    };
    server.once("error", onError);
    server.once("listening", onOk);
    server.listen(port, "127.0.0.1");
  });

export const startServer = async (
  env: Env = {},
  overrides: Partial<Config> = {},
): Promise<TestServer> => {
  const dataDir = tempDir();
  // a stand-in for the built app, so the tests need no `vite build`
  const appDir = path.join(dataDir, "app");
  fs.mkdirSync(path.join(appDir, "assets"), { recursive: true });
  fs.writeFileSync(
    path.join(appDir, "index.html"),
    "<!doctype html><title>ChalanaMaya test app</title>",
  );
  fs.writeFileSync(path.join(appDir, "assets", "app.js"), "console.log('app')");
  // a fixed env.PORT gets one attempt; otherwise a random free port
  const fixed = env.PORT ? Number(env.PORT) : 0;
  for (let attempt = 0; attempt < (fixed ? 1 : 50); attempt++) {
    const port = fixed || 5000 + Math.floor(Math.random() * 1000);
    const cfg = loadConfig(
      { DATA_DIR: path.join(dataDir, "data"), RATE_LIMITS: "off", ...env, PORT: String(port) },
      { appDir, ...overrides },
    );
    const handle = createApp(cfg);
    const server = http.createServer(handle.app);
    server.on("upgrade", (req, socket, head) => handle.upgrade(server, server, req, socket, head));
    if (!(await listen(server, port))) {
      handle.close();
      continue;
    }
    return {
      base: `http://localhost:${port}`,
      port,
      cfg,
      handle,
      close: () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => {
            handle.close();
            fs.rmSync(dataDir, { recursive: true, force: true });
            resolve();
          });
        }),
    };
  }
  throw new Error("no free port in 5000-5999");
};

export interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  text: string;
  json: () => any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

/** A plain HTTP request with full control over headers (Host included). */
export const raw = (
  port: number,
  method: string,
  pathname: string,
  opts: { headers?: Record<string, string>; body?: string | Buffer } = {},
): Promise<RawResponse> =>
  new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path: pathname,
        headers: { host: `localhost:${port}`, ...opts.headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const body = Buffer.concat(chunks);
          const text = body.toString("utf8");
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body,
            text,
            json: () => JSON.parse(text),
          });
        });
      },
    );
    req.on("error", reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });

/** Sends a WebSocket upgrade request and returns the status line's code. */
export const upgradeStatus = (
  port: number,
  pathname: string,
  headers: Record<string, string> = {},
): Promise<number> =>
  new Promise((resolve, reject) => {
    const sock = net.connect(port, "127.0.0.1");
    let data = "";
    sock.on("data", (c: Buffer) => {
      data += c.toString("latin1");
      const m = /^HTTP\/1\.1 (\d{3})/.exec(data);
      if (m) {
        sock.destroy();
        resolve(Number(m[1]));
      }
    });
    sock.on("error", reject);
    sock.on("close", () => resolve(0));
    const all: Record<string, string> = {
      Host: `localhost:${port}`,
      Connection: "Upgrade",
      Upgrade: "websocket",
      "Sec-WebSocket-Version": "13",
      "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
      ...headers,
    };
    sock.write(
      `GET ${pathname} HTTP/1.1\r\n${Object.entries(all)
        .map(([k, v]) => `${k}: ${v}\r\n`)
        .join("")}\r\n`,
    );
  });

export const APP = { "X-ChalanaMaya": "1" };
export const JSON_APP = { ...APP, "Content-Type": "application/json" };

/** A small API client acting like the app (sends X-ChalanaMaya: 1). */
export const api = (srv: TestServer) => {
  const call = (method: string, p: string, body?: unknown, headers: Record<string, string> = {}) =>
    raw(srv.port, method, p, {
      headers: { ...(body === undefined ? APP : JSON_APP), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return {
    call,
    createSession: async (title?: string) => {
      const r = await call("POST", "/api/sessions", title === undefined ? {} : { title });
      if (r.status !== 201) throw new Error(`create failed: ${r.status} ${r.text}`);
      return r.json().session_id as string;
    },
    push: (sid: string, ops: unknown[], extra: Record<string, unknown> = {}, query = "") =>
      call("POST", `/api/sessions/${sid}/ops${query}`, {
        pushId: newPushId(),
        baseRev: 0,
        ops,
        ...extra,
      }),
    scene: async (sid: string) => (await call("GET", `/api/sessions/${sid}/scene`)).json(),
  };
};

let n = 0;
export const rect = (over: Partial<SceneElement> = {}): SceneElement =>
  ({ ...createShape("rectangle", n++ * 10, 0), ...over }) as SceneElement;

export const put = (el: unknown, idx = "a0", baseVersion = 0) => ({
  t: "put",
  el,
  idx,
  baseVersion,
});

/** 1×1 pictures. */
export const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
export const GIF = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64",
);
export const WEBP = Buffer.from(
  "UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAwA0JaQAA3AA/vuUAAA=",
  "base64",
);

/** n valid, increasing layer keys. */
export const keys = (n: number) => generateNKeysBetween(null, null, n);
