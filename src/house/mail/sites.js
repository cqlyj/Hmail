import { getDomain } from "tldts";

const SITE_MAP = {
  "luma-mail.com": "lu.ma",
  "lu.ma": "lu.ma",
  "luma.com": "lu.ma",
};

/** getDomain() from tldts on the lowercased domain; then SITE_MAP[org] ?? org; null if getDomain returns null. */
export function siteForDomain(domain) {
  if (typeof domain !== "string" || domain.length === 0) return null;
  const org = getDomain(domain.toLowerCase());
  if (org == null) return null;
  return SITE_MAP[org] ?? org;
}
