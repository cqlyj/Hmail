import { log } from "../../shared/log.js";
import { GmailAuthError } from "../gmail/client.js";

/** The redaction-net middleware. Reads the live mail service, or the held store, at call time. */
export function redactionNet(deps) {
  return async (ctx, next) => {
    const result = await next();
    const pairs = (deps.mail ?? deps.store)?.redactionPairs() ?? [];
    if (!result || typeof result !== "object" || !Array.isArray(result.content))
      return result;
    let count = 0;
    const content = result.content.map((block) => {
      if (!block || block.type !== "text" || typeof block.text !== "string")
        return block;
      let text = block.text;
      for (const pair of pairs) {
        if (typeof pair.secret !== "string" || pair.secret.length < 4) continue;
        if (!text.includes(pair.secret)) continue;
        const parts = text.split(pair.secret);
        count += parts.length - 1;
        text = parts.join(pair.placeholder);
      }
      return text === block.text ? block : { ...block, text };
    });
    if (count > 0)
      log("warn", "redaction net replaced held secrets", {
        fn: ctx.fn,
        count,
      });
    return { ...result, content };
  };
}

export function mailPolicy(deps) {
  return {
    origin: "same-human",
    describe: "Owner's agents only. Held codes and links never leave the house.",
    use: redactionNet(deps),
  };
}

function notConnected() {
  return {
    isError: true,
    content: [{ type: "text", text: "Gmail is not connected on this house." }],
  };
}

/**
 * @param {{ mail: { search?: Function, read?: Function } | null }} deps
 * @param {(mail: object) => Promise<unknown>} fn
 */
export async function withMail(deps, fn) {
  if (deps.mail === null) return notConnected();
  try {
    return await fn(deps.mail);
  } catch (err) {
    if (err instanceof GmailAuthError) {
      return {
        isError: true,
        content: [{ type: "text", text: err.message }],
      };
    }
    return {
      isError: true,
      content: [{ type: "text", text: "mail lookup failed" }],
    };
  }
}
