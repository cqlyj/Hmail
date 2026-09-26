import { parseDocument } from "htmlparser2";

const HIDDEN_STYLE =
  /display:none|visibility:hidden|opacity:0(\.0+)?(;|$|!)|font-size:0|max-height:0|max-width:0|(^|;)height:0(px)?(;|$|!)|(^|;)width:0(px)?(;|$|!)|mso-hide:all|color:transparent|clip:rect\(0|(left|top|text-indent):-\d{3,}/;

const INVISIBLE =
  /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

const SKIP_TAGS = new Set([
  "head",
  "title",
  "noscript",
  "template",
  "meta",
  "link",
  "svg",
  "iframe",
  "object",
  "img",
  "input",
  "select",
  "option",
]);

const BREAK_TAGS = new Set([
  "p",
  "div",
  "br",
  "tr",
  "li",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "table",
  "section",
  "article",
  "header",
  "footer",
  "blockquote",
  "hr",
]);

const LINK_RE = /https?:\/\/[^\s<>"')\]]+/g;
const CLASS_SELECTOR = /^\s*\.[A-Za-z_][\w-]*\s*$/;

/** Removes zero-width, bidi-control, soft-hyphen and C0/C1 control characters except \n and \t. */
export function stripInvisible(s) {
  INVISIBLE.lastIndex = 0;
  return String(s ?? "").replace(INVISIBLE, "");
}

/**
 * @param {string} style
 */
function normalizeStyle(style) {
  return style.toLowerCase().replace(/\s+/g, "");
}

/**
 * @param {string} style
 */
function styleIsHidden(style) {
  if (!style) return false;
  return HIDDEN_STYLE.test(normalizeStyle(style));
}

/**
 * @param {string} css
 * @param {Set<string>} hiddenClasses
 */
function collectHiddenClasses(css, hiddenClasses) {
  const cleaned = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const match of cleaned.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!styleIsHidden(match[2] ?? "")) continue;
    const selectors = (match[1] ?? "").split(",");
    if (!selectors.every((selector) => CLASS_SELECTOR.test(selector))) continue;
    for (const selector of selectors)
      hiddenClasses.add(selector.trim().slice(1));
  }
}

/**
 * @param {{ data?: string, children?: unknown[] }} node
 */
function nodeText(node) {
  if (typeof node.data === "string") return node.data;
  return (node.children ?? [])
    .map((child) =>
      nodeText(/** @type {{ data?: string, children?: unknown[] }} */ (child)),
    )
    .join("");
}

/**
 * @param {import("htmlparser2").Element | import("domhandler").AnyNode} node
 * @param {Set<string>} hiddenClasses
 */
function collectStyles(node, hiddenClasses) {
  if (node.type === "style" || (node.type === "tag" && node.name === "style")) {
    collectHiddenClasses(nodeText(node), hiddenClasses);
  }
  for (const child of node.children ?? []) collectStyles(child, hiddenClasses);
}

/**
 * @param {string} s
 */
function cleanup(s) {
  const stripped = stripInvisible(s).replace(/[ \t]+/g, " ");
  return stripped
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * @param {string} s
 */
function cleanupInline(s) {
  return stripInvisible(s).replace(/\s+/g, " ").trim();
}

/**
 * @param {import("domhandler").AnyNode} node
 * @param {Set<string>} hiddenClasses
 * @returns {{ text: string, links: { href: string, text: string }[] }}
 */
function renderNode(node, hiddenClasses) {
  if (node.type === "text") return { text: node.data ?? "", links: [] };
  if (node.type === "style" || node.type === "script")
    return { text: "", links: [] };
  if (node.type !== "tag")
    return renderChildren(node.children ?? [], hiddenClasses);

  const name = node.name.toLowerCase();
  if (SKIP_TAGS.has(name)) return { text: "", links: [] };
  const attribs = node.attribs ?? {};
  if (Object.prototype.hasOwnProperty.call(attribs, "hidden"))
    return { text: "", links: [] };
  if (attribs["aria-hidden"] === "true") return { text: "", links: [] };
  const classes = (attribs.class ?? "").split(/\s+/).filter(Boolean);
  if (classes.some((name) => hiddenClasses.has(name)))
    return { text: "", links: [] };
  if (styleIsHidden(attribs.style ?? "")) return { text: "", links: [] };

  const href = stripInvisible(attribs.href ?? "");
  if (name === "a" && /^https?:/i.test(href)) {
    const inner = renderChildren(node.children ?? [], hiddenClasses);
    const anchorText = cleanupInline(inner.text);
    const shown =
      anchorText === "" || anchorText === href
        ? `(${href})`
        : `${anchorText} (${href})`;
    return {
      text: shown,
      links: [{ href, text: anchorText }, ...inner.links],
    };
  }

  const inner = renderChildren(node.children ?? [], hiddenClasses);
  const text = BREAK_TAGS.has(name) ? `\n${inner.text}\n` : inner.text;
  return { text, links: inner.links };
}

/**
 * @param {import("domhandler").AnyNode[]} nodes
 * @param {Set<string>} hiddenClasses
 * @returns {{ text: string, links: { href: string, text: string }[] }}
 */
function renderChildren(nodes, hiddenClasses) {
  let text = "";
  /** @type {{ href: string, text: string }[]} */
  const links = [];
  for (const node of nodes) {
    const part = renderNode(node, hiddenClasses);
    text += part.text;
    links.push(...part.links);
  }
  return { text, links };
}

/** @param {string} html @returns {{ text: string, links: { href: string, text: string }[] }} */
export function htmlVisibleText(html) {
  const doc = parseDocument(html);
  /** @type {Set<string>} */
  const hiddenClasses = new Set();
  collectStyles(doc, hiddenClasses);
  const rendered = renderChildren(doc.children ?? [], hiddenClasses);
  const text = cleanup(rendered.text);
  /** @type {{ href: string, text: string }[]} */
  const links = rendered.links.slice();
  const seen = new Set(links.map((link) => link.href));
  for (const line of text.split("\n")) {
    LINK_RE.lastIndex = 0;
    for (const match of line.matchAll(LINK_RE)) {
      const href = match[0];
      if (seen.has(href)) continue;
      seen.add(href);
      const index = match.index ?? 0;
      links.push({
        href,
        text: line.slice(Math.max(0, index - 60), index),
      });
    }
  }
  return { text, links };
}

/** @param {string} text @returns {{ text: string, links: { href: string, text: string }[] }} */
export function plainVisibleText(text) {
  const stripped = stripInvisible(text ?? "");
  /** @type {{ href: string, text: string }[]} */
  const links = [];
  for (const line of stripped.split("\n")) {
    LINK_RE.lastIndex = 0;
    for (const match of line.matchAll(LINK_RE)) {
      const index = match.index ?? 0;
      links.push({
        href: match[0],
        text: line.slice(Math.max(0, index - 60), index),
      });
    }
  }
  return { text: cleanup(stripped), links };
}
