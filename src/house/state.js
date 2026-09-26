import { mkdir, stat } from "node:fs/promises";

/** mkdir -p with mode 0o700; if it exists, (stat.mode & 0o077) must be 0, else throw. */
export async function ensureStateDir(dir) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const info = await stat(dir);
  if ((info.mode & 0o077) !== 0) {
    throw new Error(
      `state dir ${dir} must not be accessible by group/others (chmod 700)`,
    );
  }
}
