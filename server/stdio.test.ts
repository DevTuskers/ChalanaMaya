/** Integration: the official SDK stdio client against the bridge process (plan §8). */
import net from "node:net";
import http from "node:http";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  PromptListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { startServer, type TestServer } from "./test/helpers";
import { call, callError, makePng } from "./mcp/testClient";
import type { ChangesEvent } from "./sessions/service";

const ROOT = path.resolve(import.meta.dirname, "..");
const BUILT = path.join(ROOT, "dist-server", "stdio.js");

// the tests run the built bridge, as desktop clients do (`node dist-server/stdio.js`)
beforeAll(() => {
  const r = spawnSync(
    process.execPath,
    [
      path.join(ROOT, "node_modules", "vite", "bin", "vite.js"),
      "build",
      "--ssr",
      "-c",
      "vite.server.config.ts",
      "--logLevel",
      "error",
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(`server build failed: ${r.stderr}`);
}, 120_000);

const freePort = async (): Promise<number> => {
  for (;;) {
    const port = 5000 + Math.floor(Math.random() * 1000);
    const ok = await new Promise<boolean>((resolve) => {
      const s = net.createServer();
      s.once("error", () => resolve(false));
      s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
    });
    if (ok) return port;
  }
};

let cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.reverse()) await c().catch(() => {});
  cleanup = [];
});

const bridge = async (url: string, name = "Claude Desktop") => {
  const client = new Client({ name, version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BUILT],
    env: { ...process.env, CHALANAMAYA_URL: url } as Record<string, string>,
    stderr: "pipe",
  });
  await client.connect(transport);
  cleanup.push(() => client.close());
  return client;
};

const serve = async (port?: number) => {
  const s = await startServer(port ? { PORT: String(port) } : {});
  cleanup.push(() => s.close());
  return s;
};

describe("stdio bridge", () => {
  it.each([403, 413, 429, 500])("reports HTTP %i without reconnecting", async (status) => {
    const srv = await serve();
    let refusal = false;
    let requests = 0;
    const proxy = http.createServer(async (req, res) => {
      requests++;
      if (refusal) {
        res.writeHead(status).end("refused");
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const reply = await fetch(`${srv.base}/mcp`, {
        method: req.method,
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: req.method === "POST" ? Buffer.concat(chunks) : undefined,
      });
      res.writeHead(reply.status, { "content-type": reply.headers.get("content-type")! });
      res.end(await reply.text());
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => new Promise<void>((resolve) => proxy.close(() => resolve())));
    const url = `http://127.0.0.1:${(proxy.address() as net.AddressInfo).port}`;
    const client = await bridge(url);
    await client.listTools();
    refusal = true;
    const before = requests;
    const meaning =
      status === 403
        ? "ALLOWED_HOSTS.*ALLOWED_ORIGINS"
        : status === 413
          ? "too large"
          : status === 429
            ? "Rate limited"
            : "Server error";
    await expect(client.listTools()).rejects.toThrow(new RegExp(`HTTP ${status}.*${meaning}`));
    expect(requests - before).toBe(1);
    // The same refusal during the initial upstream connection must not be called unreachable.
    const fresh = await bridge(url);
    const initial = requests;
    await expect(fresh.listTools()).rejects.toThrow(new RegExp(`HTTP ${status}.*${meaning}`));
    expect(requests - initial).toBe(1);
    refusal = false;
    expect((await client.listTools()).tools.length).toBe(17);
  });

  it("forwards tools, prompts and resources and names the agent", async () => {
    const srv = await serve();
    const client = await bridge(srv.base);
    expect(client.getServerCapabilities()?.tools?.listChanged).toBe(true);
    const tools = await client.listTools();
    expect(tools.tools.length).toBe(17);
    expect((await client.listPrompts()).prompts.length).toBe(4);
    const guide = await client.readResource({ uri: "chalanamaya://guide" });
    expect((guide.contents[0] as { text: string }).text).toContain("ChalanaMaya");
    const id = (await call(client, "create_session", {})).session_id as string;
    const events: ChangesEvent[] = [];
    const on = (e: ChangesEvent) => events.push(e);
    srv.handle.service.events.on("changes", on);
    await call(client, "add_elements", {
      session_id: id,
      elements: [{ type: "rectangle", label: "x" }],
    });
    await call(client, "add_elements", {
      session_id: id,
      agent_name: "Mine",
      elements: [{ type: "note" }],
    });
    srv.handle.service.events.off("changes", on);
    expect(events.map((e) => e.origin)).toEqual([
      { kind: "agent", name: "Claude Desktop" },
      { kind: "agent", name: "Mine" },
    ]);
    // tool errors pass through untouched
    expect(
      (
        await callError(client, "place_media", {
          session_id: id,
          kind: "image",
          source: { url: "https://127.0.0.1/a.png" },
        })
      ).code,
    ).toBe("invalid_input");
    // a 10 MB upload (≈ 13.4 MB of base64) fits through the 16 MB stdio buffer
    const big = makePng(8, 8, [0, 0, 255], 10 * 1024 * 1024 - 400);
    const up = await call(client, "upload_media", {
      session_id: id,
      data_base64: big.toString("base64"),
      mime_type: "image/png",
    });
    expect(up.size).toBe(big.length);
  }, 60_000);

  it("starts before the server, then recovers and announces the tools", async () => {
    const port = await freePort();
    const client = await bridge(`http://localhost:${port}`);
    expect(client.getServerVersion()?.name).toBe("chalanamaya");
    // list calls have no isError result: they fail with a JSON-RPC error that says why
    await expect(client.listTools()).rejects.toThrow(/not reachable/);
    await expect(client.listPrompts()).rejects.toThrow(/not reachable/);
    await expect(client.listResources()).rejects.toThrow(/not reachable/);
    const down = await client.callTool({ name: "get_scene", arguments: { session_id: "x" } });
    expect(down.isError).toBe(true);
    expect(JSON.stringify(down.content)).toMatch(/not reachable/);

    let changed = 0;
    let prompts = 0;
    let resources = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      changed++;
    });
    client.setNotificationHandler(PromptListChangedNotificationSchema, () => {
      prompts++;
    });
    client.setNotificationHandler(ResourceListChangedNotificationSchema, () => {
      resources++;
    });
    let srv: TestServer = await serve(port);
    const id = (await call(client, "create_session", {})).session_id as string;
    await expect.poll(() => changed).toBe(1);
    await expect.poll(() => prompts + resources).toBe(2);
    expect((await client.listTools()).tools.length).toBe(17);
    expect((await client.listPrompts()).prompts.length).toBe(4);

    // the server goes away and comes back on the same port
    await srv.close();
    expect(
      (await client.callTool({ name: "get_scene", arguments: { session_id: id } })).isError,
    ).toBe(true);
    srv = await serve(port);
    const fresh = (await call(client, "create_session", {})).session_id as string;
    expect(fresh).toMatch(/^[A-Za-z0-9_-]{24}$/);
    await expect.poll(() => changed).toBe(2);
  }, 60_000);
});
