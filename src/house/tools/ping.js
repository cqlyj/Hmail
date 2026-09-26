import { z } from "zod";

/** @param {import("hors-sdk/mcp").HorsMcpServer} gated */
export function registerPing(gated) {
  gated.registerTool(
    "ping",
    {
      title: "Ping the house",
      description:
        "Health check: replies pong with the caller's humanId. Optional delayMs (0-55000) holds the call open.",
      inputSchema: z.object({
        delayMs: z.number().int().min(0).max(55000).optional(),
      }),
      hors: "same-human",
    },
    async ({ delayMs }, ctx) => {
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      return {
        content: [
          { type: "text", text: `pong caller=${ctx.hors.callerHumanId}` },
        ],
      };
    },
  );
}
