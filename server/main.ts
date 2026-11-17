/**
 * Starts the ChalanaMaya server: `npm run start` (built app) or `npm run dev`
 * (Vite middleware with hot reload). Configuration comes from the environment;
 * see docs/setup.md.
 */
import http from "node:http";
import type { Duplex } from "node:stream";
import { createApp, VERSION } from "./app";
import { appOrigins, ConfigError, loadConfig } from "./config";
import { runSmokeIsolated, SmokeError } from "./db/smoke";
import { crossSiteReason } from "./security/csrf";
import { checkUpgradeHost } from "./security/host";

const fail = (msg: string): never => {
  console.error(`ChalanaMaya could not start: ${msg}`);
  process.exit(1);
};

const main = async () => {
  let cfg;
  try {
    const env = { ...process.env };
    if (process.argv.includes("--dev")) env.CHALANAMAYA_DEV = "1";
    cfg = loadConfig(env);
  } catch (e) {
    if (e instanceof ConfigError) fail(e.message);
    throw e;
  }
  try {
    runSmokeIsolated();
  } catch (e) {
    if (e instanceof SmokeError) fail(e.message);
    throw e;
  }
  const handle = createApp(cfg);
  const servers: http.Server[] = [];
  const onUpgrade = function (
    this: http.Server,
    req: http.IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ) {
    if (!checkUpgradeHost(req, socket, cfg.allowedHosts)) return;
    if (cfg.dev && req.url?.startsWith("/__vite_hmr")) {
      // Vite's HMR socket listens on the first server; pass the others' upgrades to it
      if (this !== servers[0]) servers[0]?.emit("upgrade", req, socket, head);
      return;
    }
    if (crossSiteReason(req.headers, appOrigins(cfg))) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    // no socket endpoints yet: live sync arrives in phase 3
    socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  };
  // Loopback only by default (127.0.0.1 and ::1); HOST picks one address instead.
  const addresses = cfg.host ? [cfg.host] : ["127.0.0.1", "::1"];
  for (const address of addresses) {
    const server = http.createServer(handle.app);
    server.on("upgrade", onUpgrade);
    const ok = await new Promise<boolean>((resolve) => {
      server.once("error", (e: NodeJS.ErrnoException) => {
        if (e.code === "EADDRINUSE") fail(`port ${cfg.port} is already in use (set PORT)`);
        // a machine without IPv6 still serves on 127.0.0.1
        if (
          !cfg.host &&
          address === "::1" &&
          (e.code === "EADDRNOTAVAIL" || e.code === "EAFNOSUPPORT")
        )
          return resolve(false);
        fail(`cannot listen on ${address}:${cfg.port}: ${e.message}`);
      });
      server.listen(cfg.port, address, () => resolve(true));
    });
    if (ok) servers.push(server);
  }
  await handle.attach(servers[0]!);
  const host = cfg.host && cfg.host !== "0.0.0.0" && cfg.host !== "::" ? cfg.host : "localhost";
  const shown = host.includes(":") ? `[${host}]` : host;
  console.log(`ChalanaMaya ${VERSION} is running at http://${shown}:${cfg.port}/`);
  if (cfg.publicUrl) console.log(`Public address: ${cfg.publicUrl.origin}`);
  console.log(`Boards are stored in ${cfg.dataDir}`);
  const stop = () => {
    for (const server of servers) {
      server.close();
      server.closeAllConnections();
    }
    handle.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
};

void main();
