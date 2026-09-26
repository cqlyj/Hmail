import { createSigner } from "hors-sdk/client";

/** @returns {Promise<import("hors-sdk/client").CallOutcome>} */
export async function callHouse({ service, fn, args, profile, home }) {
  if (home) process.env.HORS_HOME = home;
  const signer = await createSigner({ profile });
  return signer.call(service, fn, args);
}
