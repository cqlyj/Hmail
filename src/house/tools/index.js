import { mailPolicy } from "./mail-policy.js";
import { registerPair } from "./pair.js";
import { registerPing } from "./ping.js";
import { registerRead } from "./read.js";
import { registerSearch } from "./search.js";
import { registerUseCode } from "./use-code.js";

export function registerTools(gated, deps) {
  const policy = mailPolicy(deps);
  registerPing(gated);
  registerSearch(gated, deps, policy);
  registerRead(gated, deps, policy);
  registerUseCode(gated, deps);
  registerPair(gated, deps);
}
