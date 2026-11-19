/**
 * Stateless Streamable HTTP MCP endpoint (plan §5.1): one McpServer and
 * transport per POST, nothing kept between requests, so a server restart never
 * produces "session not found". The JSON body (≤ 16 MB) is parsed by Express
 * and handed to the transport. GET and DELETE answer 405.
 */
import express, { type Request, type Response, type Router } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Config } from "../config";
import type { SessionService } from "../sessions/service";
import { redactIds } from "../security/rateLimit";
import { registerGuide } from "./guide";
import { registerTools } from "./tools";

import { INSTRUCTIONS } from "./reference";

export const MCP_BODY_LIMIT = 16 * 1024 * 1024;

export { INSTRUCTIONS };

export const buildMcpServer = (opts: {
  service: SessionService;
  peers(sessionId: string): number;
  baseUrl: string;
  maxImageBytes: number;
  maxVideoBytes?: number;
  version: string;
}) => {
  const server = new McpServer(
    { name: "chalanamaya", title: "ChalanaMaya", version: opts.version },
    {
      capabilities: { tools: { listChanged: true }, prompts: {}, resources: {} },
      instructions: INSTRUCTIONS,
    },
  );
  registerTools(server, opts);
  registerGuide(server, opts.service);
  return server;
};

const rpcError = (res: Response, status: number, code: number, message: string) =>
  res.status(status).json({ jsonrpc: "2.0", error: { code, message }, id: null });

export const mcpRouter = (
  cfg: Config,
  service: SessionService,
  peers: (sessionId: string) => number,
  version: string,
): Router => {
  const router = express.Router({ caseSensitive: true, strict: true });
  const json = express.json({
    limit: MCP_BODY_LIMIT,
    type: ["application/json", "application/*+json"],
  });
  router.post("/", (req, res, next) => {
    json(req, res, (err?: unknown) => {
      if (!err) return next();
      const e = err as { type?: string; status?: number };
      if (e.type === "entity.too.large")
        return rpcError(
          res,
          413,
          -32600,
          "The request is larger than 16 MB. Upload big media in smaller calls.",
        );
      return rpcError(res, 400, -32700, "The request body is not valid JSON.");
    });
  });
  // JSON-RPC batches would let one rate-limited POST carry many tool calls;
  // MCP 2025-06-18 dropped batching, so one request per POST
  router.post("/", (req, res, next) => {
    if (Array.isArray(req.body))
      return rpcError(
        res,
        400,
        -32600,
        "Batched JSON-RPC requests are not supported. Send one request per POST.",
      );
    next();
  });
  router.post("/", async (req: Request, res: Response) => {
    const baseUrl = cfg.publicUrl
      ? cfg.publicUrl.origin
      : `${req.protocol}://${req.headers.host ?? `localhost:${cfg.port}`}`;
    const server = buildMcpServer({
      service,
      peers,
      baseUrl,
      maxImageBytes: cfg.limits.maxImageBytes,
      maxVideoBytes: cfg.limits.maxVideoBytes,
      version,
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      console.error("mcp error:", redactIds(String((e as Error)?.stack ?? e)));
      if (!res.headersSent) rpcError(res, 500, -32603, "Something went wrong on the server.");
    }
  });
  router.all("/", (_req, res) => {
    res.setHeader("Allow", "POST");
    rpcError(
      res,
      405,
      -32000,
      "Method not allowed. This MCP endpoint is stateless: send POST requests.",
    );
  });
  return router;
};
