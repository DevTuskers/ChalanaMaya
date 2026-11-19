/**
 * MCP prompts and resources (plan §5.5). The definitions live in
 * reference.ts — pure data shared with the Workers dispatcher — and are
 * registered here on the real SDK server. Session resources are templates
 * without a list callback, so no board ids are ever enumerated.
 */
import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { z } from "zod";
import type { SessionService } from "../sessions/service";
import { PROMPTS, resourceDefs } from "./reference";

export {
  guideText,
  ELEMENTS_REFERENCE,
  PALETTE_REFERENCE,
  componentPresetsReference,
} from "./reference";

export const registerGuide = (server: McpServer, service: SessionService) => {
  for (const p of PROMPTS) {
    server.registerPrompt(
      p.name,
      { title: p.title, description: p.description, argsSchema: p.argsSchema as z.ZodRawShape },
      ((args: unknown) => p.run(args as Record<string, string>)) as never,
    );
  }
  for (const r of resourceDefs(service)) {
    if (r.uri) {
      server.registerResource(r.name, r.uri, { title: r.title, mimeType: r.mimeType }, ((
        uri: URL,
      ) => r.read(uri, {})) as never);
    } else {
      server.registerResource(
        r.name,
        new ResourceTemplate(r.uriTemplate!, { list: undefined }),
        { title: r.title, mimeType: r.mimeType },
        ((uri: URL, vars: Record<string, string | string[]>) => r.read(uri, vars)) as never,
      );
    }
  }
};
