import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { hors } from "hors-sdk/mcp";
import { log } from "../shared/log.js";
import { VERSION } from "../shared/version.js";
import { registerTools } from "./tools/index.js";

/** @typedef {{ mail: ReturnType<import("./mail/service.js").createMailService> | null, approvals: import("./world/approvals.js").ApprovalManager, store: import("./held/store.js").HeldStore, audit: import("./audit.js").AuditLog, pair: { state: import("./house-config.js").HouseConfigState, requests: ReturnType<import("./pairing.js").createPairRequests> } }} HouseDeps */

/** @param {import("hors-sdk").Gate} gate @param {HouseDeps} deps @returns {import("@modelcontextprotocol/server").McpHttpHandler} */
export function createHouseMcpHandler(gate, deps) {
  return createMcpHandler(
    async () => {
      const server = new McpServer({ name: "hmail-house", version: VERSION });
      const gated = await hors(server, { gate, transport: "http" });
      registerTools(gated, deps);
      return server;
    },
    {
      onerror: (e) => log("error", "mcp handler error", { message: e.message }),
    },
  );
}
