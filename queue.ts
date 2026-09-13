import { queueFetchJob } from "./backend/db.ts";
const args = process.argv.slice(2);
const valueAfter = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const userId = valueAfter("--user") ?? process.env.LAMY_USER_ID ?? "local-user";
const url = valueAfter("--url");
if (!url) {
  console.error("Usage: bun run queue -- --user <id> --url <job-url>");
  process.exit(1);
}

const id = queueFetchJob(userId, url);
console.log(`Queued fetch_job #${id} for ${userId}: ${url}`);
