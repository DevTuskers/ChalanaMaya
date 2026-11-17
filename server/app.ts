/**
 * createApp(config): the Express app with the REST API, security layers and the
 * app pages. Used by main.ts and by the integration tests.
 */
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import fs from "node:fs";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import path from "node:path";
import { apiRouter } from "./api/routes";
import { appOrigins, ROOT_DIR, type Config } from "./config";
import { openDatabase, type DB } from "./db/schema";
import { crossSiteGuard, crossSiteReason } from "./security/csrf";
import { appHeaders, baseHeaders } from "./security/headers";
import { createSyncHub, type SyncHub } from "./sync/socket";
import { checkUpgradeHost, hostCheck, sendRefusal } from "./security/host";
import { rateLimiters, redactIds } from "./security/rateLimit";
import { SessionService } from "./sessions/service";
import { isSessionId } from "../src/shared/ids";

export const VERSION: string = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT_DIR, "package.json"), "utf8")).version;
  } catch {
    return "0.0.0";
  }
})();

export interface AppHandle {
  app: Express;
  service: SessionService;
  db: DB;
  hub: SyncHub;
  /** call after the HTTP server exists (dev mode mounts Vite on it) */
  attach(server: Server): Promise<void>;
  /**
   * The socket-upgrade handler for every listening server. `primary` is the
   * server passed to attach(); in dev mode Vite's HMR socket lives there, so the
   * other servers forward HMR upgrades to it.
   */
  upgrade(
    server: Server,
    primary: Server,
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void;
  close(): void;
}

export const createApp = (cfg: Config, opts: { db?: DB } = {}): AppHandle => {
  const db = opts.db ?? openDatabase(cfg.dataDir);
  const service = new SessionService(db, {
    limits: cfg.limits,
    mediaDir: path.join(cfg.dataDir, "media"),
  });
  const limiters = rateLimiters(cfg.rateLimits);
  const hub = createSyncHub(service, { limits: cfg.limits });
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", cfg.trustProxy);
  app.set("etag", false);
  // routes match exactly as written; the cross-site guard covers every path anyway
  app.set("case sensitive routing", true);
  app.set("strict routing", true);

  app.use(baseHeaders);
  app.use(hostCheck(cfg.allowedHosts));
  app.use(crossSiteGuard({ appOrigins: appOrigins(cfg), mcpOrigins: cfg.allowedOrigins }));

  app.use("/api", apiRouter(cfg, service, limiters, VERSION));

  // The MCP endpoint arrives in phase 4; the host check, the cross-site guard
  // and the rate limit already cover the path.
  app.all("/mcp", limiters.mcp, (req, res) => {
    sendRefusal(
      req,
      res,
      404,
      "not_available",
      "The MCP endpoint is not available in this version yet.",
    );
  });

  const pageHeaders = appHeaders(cfg.dev);
  let devMiddleware: ((req: Request, res: Response, next: NextFunction) => void) | null = null;
  let devHtml: ((url: string, html: string) => Promise<string>) | null = null;
  const indexPath = cfg.dev
    ? path.join(ROOT_DIR, "index.html")
    : path.join(cfg.appDir, "index.html");

  const sendIndex = async (req: Request, res: Response, next: NextFunction) => {
    try {
      let html = fs.readFileSync(indexPath, "utf8");
      if (devHtml) html = await devHtml(req.originalUrl, html);
      res.setHeader("Cache-Control", "no-cache");
      res.type("html").send(html);
    } catch (e) {
      next(e);
    }
  };

  app.use(pageHeaders);
  app.get("/", sendIndex);
  app.get("/s/:id", (req, res, next) => {
    // a malformed id is a 404, but still gets the app's branded "does not exist" page
    if (!isSessionId(req.params.id)) res.status(404);
    void sendIndex(req, res, next);
  });
  app.use((req, res, next) => {
    if (devMiddleware) return devMiddleware(req, res, next);
    next();
  });
  if (!cfg.dev) {
    app.use(
      express.static(cfg.appDir, {
        index: false,
        setHeaders: (res, file) => {
          if (file.includes(`${path.sep}assets${path.sep}`))
            res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        },
      }),
    );
  }
  app.use((_req, res) => {
    res.status(404).type("text/plain").send("Not found.\n");
  });
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    console.error("server error:", redactIds(String((err as Error)?.stack ?? err)));
    res.status(500).type("text/plain").send("Something went wrong on the server.\n");
  });

  let timer: NodeJS.Timeout | null = null;
  let vite: { close(): Promise<void> } | null = null;
  return {
    app,
    service,
    db,
    hub,
    async attach(server: Server) {
      timer = setInterval(() => {
        try {
          service.maintenance({ sessionTtlDays: cfg.sessionTtlDays });
        } catch (e) {
          console.error("maintenance failed:", redactIds(String((e as Error).message)));
        }
      }, 60_000);
      timer.unref();
      if (cfg.dev) {
        const { createServer } = await import("vite");
        const v = await createServer({
          root: ROOT_DIR,
          appType: "custom",
          server: { middlewareMode: true, ws: { server, path: "/__vite_hmr" } },
        });
        vite = v;
        devMiddleware = v.middlewares as unknown as typeof devMiddleware;
        devHtml = (url, html) => v.transformIndexHtml(url, html);
      }
    },
    upgrade(server, primary, req, socket, head) {
      if (!checkUpgradeHost(req, socket, cfg.allowedHosts)) return;
      if (cfg.dev && req.url?.startsWith("/__vite_hmr")) {
        if (server !== primary) primary.emit("upgrade", req, socket, head);
        return;
      }
      if (crossSiteReason(req.headers, appOrigins(cfg))) {
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
        return;
      }
      if (hub.handleUpgrade(req, socket, head)) return;
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    },
    close() {
      if (timer) clearInterval(timer);
      hub.close();
      void vite?.close();
      db.close();
    },
  };
};
