import { z } from "zod";
import { renderRead } from "../mail/render.js";
import { withMail } from "./mail-policy.js";

/** @param {import("hors-sdk/mcp").HorsMcpServer} gated @param {{ mail: object | null }} deps @param {ReturnType<typeof import("./mail-policy.js").mailPolicy>} policy */
export function registerRead(gated, deps, policy) {
  gated.registerTool(
    "read",
    {
      description:
        "Read one email by id from search. Hidden text is removed; held login codes and links are replaced by [held · site · kind].",
      inputSchema: z.object({
        id: z.string().regex(/^[0-9a-f]{8,32}$/i),
      }),
      hors: policy,
    },
    async ({ id }) =>
      withMail(deps, async (mail) => {
        const found = await mail.read(id);
        return { content: [{ type: "text", text: renderRead(found) }] };
      }),
  );
}
