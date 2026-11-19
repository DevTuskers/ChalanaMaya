import type { Rejected } from "./protocol";

/**
 * An agent batch was refused by the board (`Rejected[]` from the apply ack).
 * Shared between the Node SessionService and the Worker BoardStore so MCP
 * error handling catches it across both hosts.
 */
export class AgentRejected extends Error {
  constructor(readonly rejected: Rejected[]) {
    super(rejected.map((r) => `${r.id}: ${r.reason}`).join("; ") || "rejected");
  }
}
