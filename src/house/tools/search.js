import { z } from "zod";
import { renderSearch } from "../mail/render.js";
import { withMail } from "./mail-policy.js";

/** @param {import("hors-sdk/mcp").HorsMcpServer} gated @param {{ mail: object | null }} deps @param {ReturnType<typeof import("./mail-policy.js").mailPolicy>} policy */
export function registerSearch(gated, deps, policy) {
  gated.registerTool(
    "search",
    {
      description:
        "Search the owner's Gmail (Gmail search syntax). Held login codes and links are replaced by [held · site · kind].",
      inputSchema: z.object({
        query: z.string().min(1).max(200),
        max: z.number().int().min(1).max(20).optional(),
      }),
      hors: policy,
    },
    async ({ query, max }) =>
      withMail(deps, async (mail) => {
        const mails = await mail.search(query, max ?? 10);
        return { content: [{ type: "text", text: renderSearch(mails) }] };
      }),
  );
}
