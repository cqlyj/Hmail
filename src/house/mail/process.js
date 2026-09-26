import { randomBytes } from "node:crypto";
import { classify, CODE_TOKEN } from "./classify.js";
import { parseMail } from "./parse.js";
import { placeholder } from "./render.js";
import { verifySender } from "./sender.js";
import {
  htmlVisibleText,
  plainVisibleText,
  stripInvisible,
} from "./visible-text.js";

/**
 * @typedef {import("./classify.js").HeldKind} HeldKind
 * @typedef {import("./sender.js").SenderVerdict} SenderVerdict
 * @typedef {{ id: string, messageId: string, site: string|null, kind: HeldKind, secret: string, verified: boolean, receivedAt: number, spent: boolean }} HeldItem
 * @typedef {{ id: string, receivedAt: number, fromName: string, fromAddress: string, to: string[], subject: string, sender: SenderVerdict, body: string, attachments: {filename: string, mimeType: string, size: number}[], held: HeldItem[] }} ProcessedMail
 */

/**
 * @param {string} messageId
 * @param {SenderVerdict} sender
 * @param {number} receivedAt
 * @param {HeldKind} kind
 * @param {string} secret
 * @returns {HeldItem}
 */
function heldItem(messageId, sender, receivedAt, kind, secret) {
  return {
    id: `h_${randomBytes(6).toString("hex")}`,
    messageId,
    site: sender.site ?? null,
    kind,
    secret,
    verified: sender.verified === true,
    receivedAt,
    spent: false,
  };
}

/**
 * @param {string} text
 * @param {string} from
 * @param {string} to
 */
function replaceAll(text, from, to) {
  if (!from) return text;
  return text.split(from).join(to);
}

/** @param {{ id: string, raw: Buffer | string, internalDate: number }} message @returns {Promise<ProcessedMail>} */
export async function processMessage({ id, raw, internalDate }) {
  const parsed = await parseMail(raw);
  const sender = await verifySender(raw);
  const visible = parsed.html
    ? htmlVisibleText(parsed.html)
    : plainVisibleText(parsed.text ?? "");
  const subjectClean = stripInvisible(parsed.subject);
  const classified = classify({
    fromAddress: parsed.fromAddress,
    subject: subjectClean,
    text: visible.text,
    links: visible.links,
  });

  /** @type {HeldItem[]} */
  const held = [];
  /** @type {HeldItem | null} */
  let codeItem = null;
  if (classified.primaryCode) {
    codeItem = heldItem(
      id,
      sender,
      internalDate,
      "login code",
      classified.primaryCode,
    );
    held.push(codeItem);
  }
  const linkItems = classified.heldLinks.map((link, index) => {
    const item = heldItem(id, sender, internalDate, link.kind, link.href);
    held.push(item);
    return { href: link.href, item, n: index };
  });

  let subject = subjectClean;
  let body = visible.text;
  const longestFirst = [...linkItems].sort(
    (a, b) => b.href.length - a.href.length,
  );
  for (const link of longestFirst) {
    body = replaceAll(body, link.href, `\u0001L${link.n}\u0001`);
  }
  if (classified.isCodeMail) {
    CODE_TOKEN.lastIndex = 0;
    subject = subject.replace(CODE_TOKEN, "\u0001C\u0001");
    CODE_TOKEN.lastIndex = 0;
    body = body.replace(CODE_TOKEN, "\u0001C\u0001");
  }
  for (const link of linkItems) {
    body = replaceAll(body, `\u0001L${link.n}\u0001`, placeholder(link.item));
  }
  if (codeItem) {
    const mark = placeholder(codeItem);
    subject = replaceAll(subject, "\u0001C\u0001", mark);
    body = replaceAll(body, "\u0001C\u0001", mark);
  }
  if (body.length > 20_000) body = `${body.slice(0, 20_000)}\n[truncated]`;

  return {
    id,
    receivedAt: internalDate,
    fromName: parsed.fromName,
    fromAddress: parsed.fromAddress,
    to: parsed.to,
    subject,
    sender,
    body,
    attachments: parsed.attachments,
    held,
  };
}
