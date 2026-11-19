#!/usr/bin/env node
/**
 * The stdio bridge (plan §5.1) for desktop MCP clients: a low-level SDK
 * Server on stdin/stdout that forwards every request to the ChalanaMaya
 * server's /mcp endpoint. It never opens the database. Its capabilities are
 * fixed, so it starts and finishes initialize while the server is still down;
 * it connects on the first forwarded request, reconnects after a failure and
 * sends tools, prompts and resources list_changed once the server is back. Results are forwarded raw.
 * Write calls without agent_name get the desktop client's name.
 *
 *   CHALANAMAYA_URL=http://localhost:5183 node dist-server/stdio.js
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
  ResultSchema,
} from "@modelcontextprotocol/sdk/types.js";

export const STDIO_MAX_BUFFER = 16 * 1024 * 1024;
const NO_AGENT_NAME = new Set([
  "create_session",
  "get_session_info",
  "get_scene",
  "list_component_presets",
]);

const isConnectionFailure = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  if (error instanceof McpError || error instanceof StreamableHTTPError) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return (
    (typeof code === "string" &&
      /^(ECONNREFUSED|ECONNRESET|ECONNABORTED|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|EPIPE|ETIMEDOUT|UND_ERR_)/.test(
        code,
      )) ||
    (error instanceof TypeError && /fetch failed|failed to fetch|network/i.test(error.message)) ||
    isConnectionFailure(error.cause)
  );
};

const requestError = (error: unknown): never => {
  if (error instanceof StreamableHTTPError) {
    const meaning =
      error.code === 403
        ? "Host/Origin refused. Set ALLOWED_HOSTS to allow the server hostname and ALLOWED_ORIGINS to allow the MCP client's origin."
        : error.code === 413
          ? "Request too large. Reduce the request payload."
          : error.code === 429
            ? "Rate limited. Wait before trying again."
            : error.code !== undefined && error.code >= 500
              ? "Server error. Check the ChalanaMaya server logs."
              : "The server refused the HTTP request.";
    throw new McpError(-32603, `ChalanaMaya HTTP ${error.code}: ${meaning}`);
  }
  throw error;
};

export interface BridgeOptions {
  url: string;
  key?: string;
  version?: string;
  log?: (msg: string) => void;
}

export const createBridge = (opts: BridgeOptions) => {
  const endpoint = new URL("/mcp", opts.url);
  const log = opts.log ?? ((m: string) => process.stderr.write(`chalanamaya: ${m}\n`));
  const server = new Server(
    { name: "chalanamaya", title: "ChalanaMaya", version: opts.version ?? "0.0.0" },
    {
      capabilities: {
        tools: { listChanged: true },
        prompts: { listChanged: true },
        resources: { listChanged: true },
      },
      instructions:
        "ChalanaMaya is a whiteboard. Every board is a session; its URL ends in /s/<session_id>. Pass that id as session_id. Read the chalanamaya://guide resource for layout rules.",
    },
  );
  let upstream: Promise<Client> | null = null;
  let wasDown = false;

  const connect = () => {
    if (!upstream) {
      const client = new Client({
        name: "chalanamaya-stdio-bridge",
        version: opts.version ?? "0.0.0",
      });
      upstream = client
        .connect(
          new StreamableHTTPClientTransport(endpoint, {
            requestInit: opts.key
              ? { headers: { Authorization: `Bearer ${opts.key}` } }
              : undefined,
          }),
        )
        .then(() => {
          if (wasDown) {
            wasDown = false;
            log(`connected to ${endpoint.origin}`);
            // clients that cached a failed or empty list fetch it again
            void server.sendToolListChanged().catch(() => {});
            void server.sendPromptListChanged().catch(() => {});
            void server.sendResourceListChanged().catch(() => {});
          }
          return client;
        })
        .catch((e: unknown) => {
          upstream = null;
          throw e;
        });
    }
    return upstream;
  };

  const downMessage = () =>
    `The ChalanaMaya server at ${endpoint.origin} is not reachable. Start it (npm start in the ChalanaMaya folder) or set CHALANAMAYA_URL, then try again.`;

  /** forwards one request; null when the server is unreachable */
  const forward = async (
    method: string,
    params: unknown,
  ): Promise<Record<string, unknown> | null> => {
    let client: Client;
    try {
      client = await connect();
    } catch (e) {
      if (!isConnectionFailure(e)) requestError(e);
      wasDown = true;
      return null;
    }
    try {
      return (await client.request(
        { method, params: params as Record<string, unknown> },
        ResultSchema,
      )) as Record<string, unknown>;
    } catch (e) {
      if (!isConnectionFailure(e)) requestError(e);
      upstream = null;
      wasDown = true;
      void client.close().catch(() => {});
      // one retry on a fresh connection (the server may have restarted)
      try {
        const again = await connect();
        return (await again.request(
          { method, params: params as Record<string, unknown> },
          ResultSchema,
        )) as Record<string, unknown>;
      } catch (e2) {
        if (!isConnectionFailure(e2)) requestError(e2);
        upstream = null;
        wasDown = true;
        return null;
      }
    }
  };

  const unavailable = () => {
    throw new McpError(-32603, downMessage());
  };
  // list and read requests have no isError result: a JSON-RPC error says the server is down
  const list = (method: string) => async (req: { params?: unknown }) =>
    (await forward(method, req.params)) ?? unavailable();

  server.setRequestHandler(ListToolsRequestSchema, list("tools/list") as never);
  server.setRequestHandler(ListPromptsRequestSchema, list("prompts/list") as never);
  server.setRequestHandler(ListResourcesRequestSchema, list("resources/list") as never);
  server.setRequestHandler(
    ListResourceTemplatesRequestSchema,
    list("resources/templates/list") as never,
  );
  server.setRequestHandler(
    GetPromptRequestSchema,
    (async (req: { params: unknown }) =>
      (await forward("prompts/get", req.params)) ?? unavailable()) as never,
  );
  server.setRequestHandler(
    ReadResourceRequestSchema,
    (async (req: { params: unknown }) =>
      (await forward("resources/read", req.params)) ?? unavailable()) as never,
  );
  server.setRequestHandler(CallToolRequestSchema, (async (req: {
    params: { name: string; arguments?: Record<string, unknown> };
  }) => {
    const params = { ...req.params, arguments: { ...(req.params.arguments ?? {}) } };
    const name = server.getClientVersion()?.name;
    if (name && !NO_AGENT_NAME.has(params.name) && params.arguments.agent_name === undefined)
      params.arguments.agent_name = name;
    const r = await forward("tools/call", params);
    return r ?? { isError: true, content: [{ type: "text", text: downMessage() }] };
  }) as never);

  return {
    server,
    start: () =>
      server.connect(
        new StdioServerTransport(process.stdin, process.stdout, {
          maxBufferSize: STDIO_MAX_BUFFER,
        }),
      ),
    close: async () => {
      const u = upstream;
      upstream = null;
      if (u) await u.then((c) => c.close()).catch(() => {});
      await server.close();
    },
  };
};

const isMain = () => {
  const arg = process.argv[1] ?? "";
  return /(?:^|[\\/])(?:stdio\.(?:js|ts)|chalanamaya-mcp)$/.test(arg);
};

if (isMain()) {
  const url = process.env.CHALANAMAYA_URL?.trim() || "http://localhost:5183";
  try {
    new URL(url);
  } catch {
    process.stderr.write(`chalanamaya: CHALANAMAYA_URL is not a URL: ${url}\n`);
    process.exit(2);
  }
  const bridge = createBridge({
    url,
    key: process.env.CHALANAMAYA_KEY?.trim() || undefined,
    version: process.env.npm_package_version,
  });
  void bridge.start();
  const stop = () => void bridge.close().finally(() => process.exit(0));
  process.stdin.on("end", stop);
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
