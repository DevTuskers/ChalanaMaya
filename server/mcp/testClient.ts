/** Test helpers: an official SDK client over Streamable HTTP. */
import zlib from "node:zlib";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export const httpClient = async (base: string, name = "test-agent") => {
  const client = new Client({ name, version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  return client;
};

type ToolClient = Pick<Client, "callTool">;

/** Calls a tool and returns its structuredContent; throws on isError. */
export const call = async (client: ToolClient, name: string, args: Record<string, unknown>) => {
  const r = await client.callTool({ name, arguments: args });
  if (r.isError) throw new Error(`${name} failed: ${JSON.stringify(r.content)}`);
  return r.structuredContent as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
};

/** Calls a tool expecting an error; returns {code, message}. */
export const callError = async (
  client: ToolClient,
  name: string,
  args: Record<string, unknown>,
) => {
  const r = await client.callTool({ name, arguments: args });
  if (!r.isError)
    throw new Error(`${name} unexpectedly succeeded: ${JSON.stringify(r.structuredContent)}`);
  const text = (r.content as { type: string; text: string }[])[0].text;
  try {
    return (JSON.parse(text) as { error: { code: string; message: string } }).error;
  } catch {
    return { code: "sdk", message: text };
  }
};

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf: Buffer) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type: string, data: Buffer) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

/** A solid-colour RGB PNG; `pad` adds an ancillary chunk to reach a size. */
export const makePng = (w: number, h: number, rgb: [number, number, number], pad = 0) => {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.alloc(1 + w * 3);
  for (let x = 0; x < w; x++) row.set(rgb, 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  const parts = [
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
  ];
  if (pad) parts.push(chunk("teXt", Buffer.alloc(pad, 0x61)));
  parts.push(chunk("IEND", Buffer.alloc(0)));
  return Buffer.concat(parts);
};
