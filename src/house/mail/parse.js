import PostalMime from "postal-mime";

/**
 * @param {Buffer | Uint8Array | string} raw
 * @returns {Promise<{ fromName: string, fromAddress: string, to: string[], subject: string, html: string|null, text: string|null, attachments: {filename: string, mimeType: string, size: number}[] }>}
 */
export async function parseMail(raw) {
  const parsed = await PostalMime.parse(raw);
  const from =
    parsed.from && typeof parsed.from === "object" ? parsed.from : {};
  const toList = Array.isArray(parsed.to) ? parsed.to : [];
  return {
    fromName: typeof from.name === "string" ? from.name : "",
    fromAddress: typeof from.address === "string" ? from.address : "",
    to: toList
      .map((item) =>
        item && typeof item.address === "string" ? item.address : "",
      )
      .filter((address) => address.length > 0),
    subject: typeof parsed.subject === "string" ? parsed.subject : "",
    html:
      typeof parsed.html === "string" && parsed.html.length > 0
        ? parsed.html
        : null,
    text: typeof parsed.text === "string" ? parsed.text : null,
    attachments: (parsed.attachments ?? []).map((item) => ({
      filename: item.filename ? item.filename : "(unnamed)",
      mimeType: item.mimeType ?? "",
      size: item.content?.byteLength ?? 0,
    })),
  };
}
