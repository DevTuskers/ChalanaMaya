/**
 * MCP on Workers (plan: Phase 3). The SDK's StreamableHTTP transport is
 * Node-bound, so this is a hand-rolled JSON-RPC dispatcher over POST /mcp.
 * It reuses the real tool handlers (server/mcp/tools.ts) and the shared
 * prompt/resource definitions (server/mcp/reference.ts) through a tiny
 * McpServer-shaped registry — tool behaviour stays identical on both hosts.
 *
 * Routing: session-scoped calls (tools/call + session resources) run inside
 * the board's Durable Object so agents get the same atomic apply + live
 * broadcast path as REST. Stateless calls (initialize, lists, static
 * resources, create_session) run in the worker.
 *
 * Auth: read tools need only the session id (view link semantics). Write
 * tools require the board's edit or owner key as `Authorization: Bearer` or
 * in a `#key=`/`#owner=` fragment inside the session_id argument.
 */
import { z } from "zod";
import { registerTools, type ToolContext } from "../server/mcp/tools";
import { INSTRUCTIONS, PROMPTS, resourceDefs } from "../server/mcp/reference";
import { parseBoardHash, parseSessionRef } from "../src/shared/ids";
import { ServiceError } from "../server/errors";
import type { SessionService } from "../server/sessions/service";
import type { BoardStore } from "./do/store";
import type { SocketCore } from "./do/socket";

type Obj = Record<string, unknown>;
type ToolHandler = (args: Obj) => Obj | Promise<Obj>;
type ReadHandler = (uri: URL, vars: Record<string, string | string[]>) => Obj;

interface ResourceEntry {
  name: string;
  uri?: string;
  uriTemplate?: string;
  meta: Obj;
  read: ReadHandler;
}

export const READ_TOOLS = new Set(["get_session_info", "get_scene", "list_component_presets"]);

/** Minimal McpServer-compatible registry used by registerTools on Workers. */
export class MiniMcp {
  readonly tools = new Map<string, { meta: Obj; run: ToolHandler }>();
  readonly prompts = new Map<string, { meta: Obj; run: (args: Obj) => Obj }>();
  readonly resources: ResourceEntry[] = [];

  registerTool(name: string, meta: Obj, handler: ToolHandler) {
    this.tools.set(name, { meta, run: handler });
  }
  registerPrompt(name: string, meta: Obj, handler: (args: Obj) => Obj) {
    this.prompts.set(name, { meta, run: handler });
  }
  registerResource(
    name: string,
    uriOrTemplate: string | { uriTemplate: string },
    meta: Obj,
    read: ReadHandler,
  ) {
    const t =
      typeof uriOrTemplate === "string"
        ? { uri: uriOrTemplate }
        : { uriTemplate: uriOrTemplate.uriTemplate };
    this.resources.push({ name, ...t, meta, read });
  }
}

const VERSION = "0.1.0";

const jsonSchemaOf = (shape: unknown): Obj => {
  try {
    if (shape && typeof (shape as { safeParse?: unknown }).safeParse === "function")
      return z.toJSONSchema(shape as z.ZodType) as Obj;
    if (shape && typeof shape === "object")
      return z.toJSONSchema(z.object(shape as z.ZodRawShape)) as Obj;
  } catch {
    /* fall through */
  }
  return { type: "object" };
};

const isOptional = (field: unknown) => {
  try {
    return (field as z.ZodType).safeParse(undefined).success;
  } catch {
    return false;
  }
};

const promptArgs = (meta: Obj) =>
  Object.entries((meta.argsSchema as Obj) ?? {}).map(([name, field]) => ({
    name,
    description: ((field as z.ZodType).description as string) ?? "",
    required: !isOptional(field),
  }));

const matchTemplate = (tpl: string, uri: string): Record<string, string> | null => {
  // "chalanamaya://session/{session_id}/scene" → capture {var} segments
  const names: string[] = [];
  const rx = tpl
    .replace(/[.*+?^${}()|[\]\\]/g, (m) => (m === "{" || m === "}" ? m : `\\${m}`))
    .replace(/\{([a-zA-Z_]+)\}/g, (_m, n: string) => {
      names.push(n);
      return "([^/]+)";
    });
  const m = new RegExp(`^${rx}$`).exec(uri);
  if (!m) return null;
  const vars: Record<string, string> = {};
  names.forEach((n, i) => (vars[n] = decodeURIComponent(m[i + 1])));
  return vars;
};

/** Build a MiniMcp around a (possibly stub) SessionService. */
export const buildMini = (ctx: ToolContext): MiniMcp => {
  const m = new MiniMcp();
  registerTools(m as never, ctx);
  for (const p of PROMPTS) {
    m.registerPrompt(
      p.name,
      { title: p.title, description: p.description, argsSchema: p.argsSchema },
      (args) => p.run(args as Record<string, string>) as unknown as Obj,
    );
  }
  for (const r of resourceDefs(ctx.service as SessionService)) {
    m.registerResource(
      r.name,
      r.uriTemplate ? { uriTemplate: r.uriTemplate } : (r.uri as string),
      { title: r.title, mimeType: r.mimeType },
      ((uri: URL, vars: Record<string, string | string[]>) =>
        r.read(uri, vars) as unknown as Obj) as ReadHandler,
    );
  }
  return m;
};

export interface DispatchHooks {
  /** Null = allowed; a denial reason string blocks the call. */
  gateWrite?(toolName: string): Promise<string | null>;
}

const resultOf = (id: unknown, result: unknown) => ({ jsonrpc: "2.0", id, result });
const errorOf = (id: unknown, code: number, message: string) => ({
  jsonrpc: "2.0",
  id: id ?? null,
  error: { code, message },
});
const toolError = (id: unknown, code: string, message: string) =>
  resultOf(id, {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ error: { code, message } }) }],
  });

/** One JSON-RPC message → response object, or null for notifications. */
export const dispatch = async (
  m: MiniMcp,
  msg: { id?: unknown; method?: string; params?: Obj },
  hooks: DispatchHooks = {},
): Promise<Obj | null> => {
  const { id, method, params } = msg ?? {};
  if (!method || typeof method !== "string") return errorOf(id, -32600, "Invalid request");
  if (method.startsWith("notifications/") || id === undefined) return null;

  switch (method) {
    case "initialize":
      return resultOf(id, {
        protocolVersion:
          typeof params?.protocolVersion === "string" ? params.protocolVersion : "2025-06-18",
        capabilities: { tools: { listChanged: true }, prompts: {}, resources: {} },
        serverInfo: { name: "chalanamaya", title: "ChalanaMaya", version: VERSION },
        instructions: INSTRUCTIONS,
      });
    case "ping":
      return resultOf(id, {});
    case "tools/list":
      return resultOf(id, {
        tools: [...m.tools.entries()].map(([name, t]) => ({
          name,
          title: t.meta.title,
          description: t.meta.description,
          inputSchema: jsonSchemaOf(t.meta.inputSchema),
          ...(t.meta.outputSchema ? { outputSchema: jsonSchemaOf(t.meta.outputSchema) } : {}),
          ...(t.meta.annotations ? { annotations: t.meta.annotations } : {}),
        })),
      });
    case "tools/call": {
      const name = params?.name;
      const tool = typeof name === "string" ? m.tools.get(name) : undefined;
      if (!tool) return errorOf(id, -32602, `Unknown tool ${String(name)}.`);
      const deny = await hooks.gateWrite?.(name as string);
      if (deny) return toolError(id, "forbidden", deny);
      try {
        return resultOf(id, await tool.run((params?.arguments as Obj) ?? {}));
      } catch (e) {
        if (e instanceof ServiceError) return toolError(id, e.code, e.message);
        return errorOf(id, -32603, "The tool failed on the server.");
      }
    }
    case "prompts/list":
      return resultOf(id, {
        prompts: [...m.prompts.entries()].map(([name, p]) => ({
          name,
          title: p.meta.title,
          description: p.meta.description,
          arguments: promptArgs(p.meta),
        })),
      });
    case "prompts/get": {
      const p = typeof params?.name === "string" ? m.prompts.get(params.name) : undefined;
      if (!p) return errorOf(id, -32602, `Unknown prompt ${String(params?.name)}.`);
      try {
        return resultOf(id, {
          description: p.meta.description,
          ...(await p.run((params?.arguments as Obj) ?? {})),
        });
      } catch {
        return errorOf(id, -32603, "The prompt failed on the server.");
      }
    }
    case "resources/list":
      return resultOf(id, {
        resources: m.resources
          .filter((r) => r.uri)
          .map((r) => ({
            uri: r.uri,
            name: r.name,
            title: r.meta.title,
            mimeType: r.meta.mimeType,
          })),
      });
    case "resources/templates/list":
      return resultOf(id, {
        resourceTemplates: m.resources
          .filter((r) => r.uriTemplate)
          .map((r) => ({
            uriTemplate: r.uriTemplate,
            name: r.name,
            title: r.meta.title,
            mimeType: r.meta.mimeType,
          })),
      });
    case "resources/read": {
      const uri = params?.uri;
      if (typeof uri !== "string") return errorOf(id, -32602, "resources/read needs params.uri");
      const r =
        m.resources.find((r) => r.uri === uri) ??
        m.resources.find((r) => r.uriTemplate && matchTemplate(r.uriTemplate, uri));
      if (!r) return errorOf(id, -32602, `Unknown resource ${uri}.`);
      try {
        const vars = r.uri ? {} : (matchTemplate(r.uriTemplate as string, uri) ?? {});
        return resultOf(id, await r.read(new URL(uri), vars));
      } catch (e) {
        return errorOf(id, -32603, e instanceof Error ? e.message : "Read failed.");
      }
    }
    default:
      return errorOf(id, -32601, `Method ${method} is not supported.`);
  }
};

/** Extract a board key from Bearer header or a #key=/#owner= fragment in the JSON-RPC params. */
export const keyFromRequest = (req: Request, msg: { params?: Obj }): string | undefined => {
  const auth = req.headers.get("Authorization");
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  const candidates = [(msg.params?.arguments as Obj | undefined)?.session_id, msg.params?.uri];
  for (const c of candidates) {
    if (typeof c !== "string") continue;
    const i = c.indexOf("#");
    if (i < 0) continue;
    const h = parseBoardHash(c.slice(i));
    if (h.owner) return h.owner;
    if (h.key) return h.key;
  }
  return undefined;
};

/** Extract the board session id the call targets (arguments.session_id or a session resource uri). */
export const sessionRefOf = (msg: { method?: string; params?: Obj }): string | null => {
  const args = msg.params?.arguments as Obj | undefined;
  const sid = args?.session_id;
  if (typeof sid === "string") {
    const id = parseSessionRef(sid);
    if (id) return id;
  }
  const uri = msg.params?.uri;
  if (typeof uri === "string") {
    const m = /^chalanamaya:\/\/session\/([^/]+)\//.exec(uri);
    if (m) {
      const id = parseSessionRef(decodeURIComponent(m[1]));
      if (id) return id;
    }
  }
  return null;
};

/** Adapt a BoardStore to the SessionService surface the tools call (sessionId args ignored — the DO is the board). */
export const boardService = (store: BoardStore): SessionService =>
  ({
    create: () => {
      throw new ServiceError(
        400,
        "invalid_input",
        "create_session runs on the worker, not a board",
      );
    },
    meta: () => store.meta(),
    snapshot: () => store.snapshot(),
    apply: (_sid: string, push: never, opts: never) => store.apply(push, opts),
    applyAgentChange: (_sid: string, mutate: never, agent: string) =>
      store.applyAgentChange(mutate, agent),
    addFile: (_sid: string, bytes: Uint8Array, mime: string | undefined) =>
      store.addFile(bytes, mime),
    addRemoteFile: (_sid: string, url: string, mime: string, meta?: never) =>
      store.addRemoteFile(url, mime, meta),
  }) as unknown as SessionService;

/** Service stub for worker-level dispatch (lists/prompts only; create_session is intercepted before dispatch). */
export const workerService = () =>
  ({
    create: () => {
      throw new ServiceError(404, "session_not_found", "No board with this session id.");
    },
    meta: () => {
      throw new ServiceError(404, "session_not_found", "No board with this session id.");
    },
    snapshot: () => {
      throw new ServiceError(404, "session_not_found", "No board with this session id.");
    },
    apply: () => {
      throw new ServiceError(404, "session_not_found", "No board with this session id.");
    },
    applyAgentChange: () => {
      throw new ServiceError(404, "session_not_found", "No board with this session id.");
    },
    addFile: () => {
      throw new ServiceError(404, "session_not_found", "No board with this session id.");
    },
    addRemoteFile: () => {
      throw new ServiceError(404, "session_not_found", "No board with this session id.");
    },
  }) as unknown as SessionService;

/** POST /mcp inside a board DO: gate write tools on the board key, run the dispatch, broadcast live changes. */
export const handleBoardMcp = async (
  req: Request,
  store: BoardStore,
  sock: SocketCore,
  baseUrl: string,
): Promise<Response> => {
  let msg: { id?: unknown; method?: string; params?: Obj };
  try {
    msg = (await req.json()) as typeof msg;
  } catch {
    return Response.json(errorOf(null, -32700, "The request body is not valid JSON."), {
      status: 400,
    });
  }
  const key = keyFromRequest(req, msg);
  const m = buildMini({
    service: boardService(store),
    peers: () => sock.peers(),
    baseUrl,
    maxImageBytes: 10 * 1024 * 1024,
    maxVideoBytes: 50 * 1024 * 1024,
  });
  const out = await dispatch(m, msg, {
    gateWrite: async (name) => {
      if (READ_TOOLS.has(name)) return null;
      const ok = key ? await store.checkKey(key, "edit") : false;
      return ok
        ? null
        : "This board is look-only for you. Pass the board's edit or owner key (Authorization: Bearer, or #key= in the board URL) to change it.";
    },
  });
  if (out === null) return new Response(null, { status: 202 });
  const ev = store.lastEvent;
  store.lastEvent = null;
  if (ev) sock.broadcast(ev);
  return Response.json(out);
};

const MCP_BODY_LIMIT = 16 * 1024 * 1024;

/**
 * POST /mcp on the worker: session-scoped JSON-RPC goes to the board DO;
 * everything else is dispatched locally with a stub service (lists,
 * prompts, static resources, create_session).
 */
export const handleMcp = async (
  req: Request,
  env: { BOARD: DurableObjectNamespace },
  ctx: ExecutionContext,
  create: (
    title: string,
    ctx: ExecutionContext,
  ) => Promise<{ sessionId: string; editKey: string; ownerKey: string }>,
): Promise<Response> => {
  if (req.method !== "POST") {
    return Response.json(
      errorOf(
        null,
        -32000,
        "Method not allowed. This MCP endpoint is stateless: send POST requests.",
      ),
      {
        status: 405,
        headers: { Allow: "POST" },
      },
    );
  }
  const len = Number(req.headers.get("Content-Length") ?? 0);
  if (len > MCP_BODY_LIMIT)
    return Response.json(errorOf(null, -32600, "The request is larger than 16 MB."), {
      status: 413,
    });
  const text = await req.text();
  if (text.length > MCP_BODY_LIMIT)
    return Response.json(errorOf(null, -32600, "The request is larger than 16 MB."), {
      status: 413,
    });
  let msg: { id?: unknown; method?: string; params?: Obj };
  try {
    msg = JSON.parse(text) as typeof msg;
  } catch {
    return Response.json(errorOf(null, -32700, "The request body is not valid JSON."), {
      status: 400,
    });
  }
  if (Array.isArray(msg))
    return Response.json(
      errorOf(
        null,
        -32600,
        "Batched JSON-RPC requests are not supported. Send one request per POST.",
      ),
      { status: 400 },
    );

  const sid = sessionRefOf(msg);
  const isCreate = msg.method === "tools/call" && (msg.params?.name as string) === "create_session";

  if (isCreate) {
    // create_session is intercepted: the tools handler needs a sync create(),
    // and the returned URL must carry the edit key on this host.
    const args = (msg.params?.arguments as Obj) ?? {};
    const title = typeof args.title === "string" ? args.title.slice(0, 120) : "";
    try {
      const { sessionId, editKey, ownerKey } = await create(title, ctx);
      const url = `${new URL(req.url).origin}/s/${sessionId}#key=${editKey}`;
      const data = {
        session_id: sessionId,
        url,
        // an agent-created board has no human owner link: without this the
        // caller could never rotate keys or delete it
        owner_url: `${new URL(req.url).origin}/s/${sessionId}#owner=${ownerKey}`,
      };
      return Response.json(
        resultOf(msg.id, {
          structuredContent: data,
          content: [{ type: "text", text: JSON.stringify(data) }],
        }),
      );
    } catch (e) {
      if (e instanceof ServiceError) return Response.json(toolError(msg.id, e.code, e.message));
      return Response.json(errorOf(msg.id, -32603, "Could not create the board."), { status: 500 });
    }
  }

  if (sid) {
    // Session-scoped call: run inside the board's DO so edits broadcast.
    const stub = env.BOARD.get(env.BOARD.idFromName(sid));
    return stub.fetch(
      new Request("https://board/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(req.headers.get("Authorization")
            ? { Authorization: req.headers.get("Authorization") as string }
            : {}),
          "x-cm-base": new URL(req.url).origin,
        },
        body: text,
      }),
    );
  }

  const m = buildMini({
    service: workerService(),
    peers: () => 0,
    baseUrl: new URL(req.url).origin,
    maxImageBytes: 10 * 1024 * 1024,
    maxVideoBytes: 50 * 1024 * 1024,
  });
  const out = await dispatch(m, msg);
  if (out === null) return new Response(null, { status: 202 });
  return Response.json(out);
};
