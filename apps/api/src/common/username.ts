import { randomBytes } from "crypto";

export const USERNAME_REGEX = /^[a-z0-9_]{3,20}$/;

const MAX_LENGTH = 20;
const SUFFIX_LENGTH = 4;
const SUFFIX_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

export interface ProfileByUsernameClient {
  profile: {
    findUnique(args: { where: { username: string } }): Promise<unknown>;
  };
}

export function sanitizeUsernameBase(displayName: string | null | undefined): string {
  const base = (displayName ?? "")
    .split(/\s+/)[0] ?? "";
  const cleaned = base
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "")
    .slice(0, MAX_LENGTH);
  return cleaned.length >= 3 ? cleaned : "user";
}

function randomSuffix(): string {
  const bytes = randomBytes(SUFFIX_LENGTH);
  let suffix = "";
  for (const byte of bytes) suffix += SUFFIX_ALPHABET[byte % SUFFIX_ALPHABET.length];
  return suffix;
}

async function isTaken(client: ProfileByUsernameClient, username: string): Promise<boolean> {
  return (await client.profile.findUnique({ where: { username } })) !== null;
}

export async function generateUsername(
  client: ProfileByUsernameClient,
  displayName: string | null | undefined,
): Promise<string> {
  const base = sanitizeUsernameBase(displayName);
  if (!(await isTaken(client, base))) return base;

  const baseRoom = MAX_LENGTH - 1 - SUFFIX_LENGTH;
  for (let attempt = 0; attempt < 10; attempt++) {
    const candidate = `${base.slice(0, baseRoom)}_${randomSuffix()}`;
    if (!(await isTaken(client, candidate))) return candidate;
  }

  const bytes = randomBytes(8);
  return `${base.slice(0, baseRoom)}_${Buffer.from(bytes).toString("hex").slice(0, 4)}`;
}
