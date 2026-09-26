/** @typedef {"login code"|"magic link"|"reset link"|"new-device link"} HeldKind */

const CODE_WORDS = String.raw`(?:code|pin|passcode|otp)`;
const CODE_SUBJECT = new RegExp(
  String.raw`\b(?:verification|verify|log[ -]?in|sign[ -]?in|one[ -]?time|security|confirmation|access|authentication|2fa|two[ -]?factor)\b[^\n]{0,30}\b${CODE_WORDS}\b` +
    String.raw`|\b(?:your|the)\s+(?:\w+\s+){0,2}${CODE_WORDS}\b|\b${CODE_WORDS}\s*(?:is|:)|\b\d{4,8}\s+is\s+your\b`,
  "i",
);
const CODE_CONTEXT = /\b(?:code|passcode|otp|pin|one[- ]time)\b/i;
export const CODE_TOKEN =
  /(?<![\w-])(?:\d{4,8}|\d{3}[ -]\d{3}|(?=[A-Z0-9-]*\d)[A-Z0-9]{3,4}-[A-Z0-9]{3,4}|(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{6,8})(?![\w-])/g;
const NOREPLY_LOCAL =
  /^(?:no-?reply|do-?not-?reply|donotreply|notifications?|notify|security|accounts?|auth|verify|verification|login|signin)(?:[+._-].*)?$/i;
const LINK_SUBJECT =
  /\b(?:sign[ -]?in|log[ -]?in|magic link|verify|verification|confirm|reset|password|security alert|new (?:device|sign[ -]?in|login)|was this you)\b/i;
const LINK_SKIP =
  /unsubscribe|preferences|privacy|terms|policy|help|support|contact|facebook\.com|twitter\.com|x\.com\/|linkedin\.com|instagram\.com|youtube\.com|tiktok\.com|discord\.(?:gg|com)/i;
const RESET_LINK = /reset|password|recover/i;
const MAGIC_LINK =
  /magic|log[-_ ]?in|sign[-_ ]?in|auth|verify|verification|confirm|token=|code=|otp|session/i;
const NEW_DEVICE_MAIL =
  /new (?:device|sign[- ]?in|login)|was this you|is this you|confirm (?:it'?s|it is) you|unrecognized|suspicious|security alert/i;
const NEW_DEVICE_LINK =
  /confirm|approve|\byes\b|verify|secure|review|check activity|it was me|this was me|not me/i;

/**
 * @param {{ fromAddress: string, subject: string, text: string, links: { href: string, text: string }[] }} input
 * @returns {{ isCodeMail: boolean, primaryCode: string|null, heldLinks: { href: string, kind: HeldKind }[] }}
 */
export function classify({ fromAddress, subject, text, links }) {
  const local = String(fromAddress ?? "").split("@")[0] ?? "";
  const hay = `${subject}\n${text}`;
  CODE_TOKEN.lastIndex = 0;
  const codeMatches = [...hay.matchAll(CODE_TOKEN)];
  const isCodeMail =
    codeMatches.length > 0 &&
    (CODE_SUBJECT.test(subject) ||
      (NOREPLY_LOCAL.test(local) && CODE_CONTEXT.test(hay)));

  /** @type {string | null} */
  let primaryCode = null;
  if (isCodeMail) {
    const context = CODE_CONTEXT.exec(hay);
    if (context) {
      const after = context.index + context[0].length;
      primaryCode =
        codeMatches.find((match) => (match.index ?? 0) >= after)?.[0] ??
        codeMatches[0][0];
    } else {
      primaryCode = codeMatches[0][0];
    }
  }

  /** @type {{ href: string, kind: HeldKind }[]} */
  const heldLinks = [];
  const seenHref = new Set();
  const linkEligible =
    NOREPLY_LOCAL.test(local) || LINK_SUBJECT.test(subject) || isCodeMail;
  if (linkEligible) {
    for (const link of links ?? []) {
      const href = link.href ?? "";
      const linkText = link.text ?? "";
      if (LINK_SKIP.test(href) || LINK_SKIP.test(linkText)) continue;
      /** @type {HeldKind | null} */
      let kind = null;
      if (RESET_LINK.test(`${href} ${linkText}`)) kind = "reset link";
      else if (NEW_DEVICE_MAIL.test(hay) && NEW_DEVICE_LINK.test(linkText))
        kind = "new-device link";
      else if (MAGIC_LINK.test(`${href} ${linkText}`)) kind = "magic link";
      if (!kind || seenHref.has(href)) continue;
      seenHref.add(href);
      heldLinks.push({ href, kind });
    }
  }

  return { isCodeMail, primaryCode, heldLinks };
}
