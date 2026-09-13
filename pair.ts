import { randomBytes } from "node:crypto";
import { upsertUser } from "./backend/db.ts";

const args = process.argv.slice(2);
const valueAfter = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const userId = valueAfter("--user") ?? process.env.LAMY_USER_ID ?? "local-user";
const displayName = valueAfter("--name") ?? process.env.LAMY_DISPLAY_NAME ?? userId;
const token = `lw_${randomBytes(24).toString("hex")}`;
upsertUser(userId, displayName, token);
console.log(`Pairing token for ${displayName} (${userId}):`);
console.log(token);
console.log("Paste this token into the extension popup. Running pair again revokes the previous token.");
