import { z } from "zod";
import { GmailAuthError } from "../gmail/client.js";
import { withMail } from "./mail-policy.js";

const MAX_BYTES = 10 * 1024 * 1024;

/**
 * HORS rule: attachments of a mail that has held codes or sign-in links stay in
 * the house, so a file can never be a way around a held secret.
 * @param {{ mail: ReturnType<import("../mail/service.js").createMailService> | null }} deps
 * @returns {import("hors-sdk").Rule}
 */
function notHeldMail(deps) {
  return async (ctx) => {
    if (deps.mail === null) return true; // the handler answers "not connected"
    const id = String(/** @type {{ id?: unknown }} */ (ctx.args ?? {}).id ?? "");
    let mail;
    try {
      mail = await deps.mail.load(id);
    } catch (err) {
      if (err instanceof GmailAuthError) return true; // the handler reports it
      return { deny: "mail lookup failed", code: "MAIL_UNAVAILABLE" };
    }
    if (mail.held.length > 0) {
      return {
        deny: "this mail has held codes or sign-in links; its attachments stay in the house",
        code: "HELD_MAIL",
      };
    }
    return true;
  };
}

/** @param {import("hors-sdk/mcp").HorsMcpServer} gated @param {{ mail: ReturnType<import("../mail/service.js").createMailService> | null }} deps */
export function registerAttachment(gated, deps) {
  gated.registerTool(
    "attachment",
    {
      title: "Get an attachment",
      description:
        "Download one attachment of an email, by the mail id and the filename that read shows. Returns the file as an embedded resource (up to 10 MB). Mails that contain held codes or sign-in links are refused.",
      inputSchema: z.object({
        id: z.string().regex(/^[0-9a-f]{8,32}$/i),
        filename: z.string().min(1).max(255),
      }),
      hors: {
        origin: "same-human",
        rule: notHeldMail(deps),
        describe:
          "Owner's agents only. Attachments of mails with held codes or sign-in links are never released.",
      },
    },
    async ({ id, filename }) =>
      withMail(deps, async (mail) => {
        const file = await mail.attachment(id, filename);
        if (!file) {
          return {
            isError: true,
            content: [{ type: "text", text: `no attachment named ${filename} in that mail` }],
          };
        }
        if (file.content.byteLength > MAX_BYTES) {
          return {
            isError: true,
            content: [{ type: "text", text: `${filename} is larger than 10 MB` }],
          };
        }
        return {
          content: [
            {
              type: "text",
              text: `attachment ${filename} (${file.mimeType}, ${file.content.byteLength} bytes)`,
            },
            {
              type: "resource",
              resource: {
                uri: `hmail://mail/${id}/${encodeURIComponent(filename)}`,
                mimeType: file.mimeType,
                blob: file.content.toString("base64"),
              },
            },
          ],
        };
      }),
  );
}
