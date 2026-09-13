import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const dbPath = process.env.LAMY_DB_PATH ?? fileURLToPath(new URL("../data/lamy.sqlite", import.meta.url));
mkdirSync(dirname(dbPath), { recursive: true });
const database = new Database(dbPath, { create: true });
const schemaPath = new URL("../db/setup-all.sql", import.meta.url);
database.exec(await Bun.file(schemaPath).text());

export type LocalUser = {
  id: string;
  display_name: string | null;
  worker_token: string | null;
  linkedin_restricted: boolean;
};

export type LocalQueueItem = {
  id: number;
  user_id: string;
  kind: string;
  payload: Record<string, unknown>;
  status: string;
  leased_at: string | null;
  created_at: string;
};

const decodeJson = <T>(value: string | null | undefined, fallback: T): T => {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

const rowUser = (row: any): LocalUser | null =>
  row
    ? {
        id: String(row.id),
        display_name: row.display_name ?? null,
        worker_token: row.worker_token ?? null,
        linkedin_restricted: Boolean(row.linkedin_restricted),
      }
    : null;

const rowQueue = (row: any): LocalQueueItem => ({
  id: Number(row.id),
  user_id: String(row.user_id),
  kind: String(row.kind),
  payload: decodeJson<Record<string, unknown>>(row.payload, {}),
  status: String(row.status),
  leased_at: row.leased_at ?? null,
  created_at: String(row.created_at),
});

export function upsertUser(id: string, displayName: string, workerToken: string) {
  database
    .query(
      `INSERT INTO lamy_users (id, display_name, worker_token)
       VALUES ($id, $display_name, $worker_token)
       ON CONFLICT(id) DO UPDATE SET
         display_name = excluded.display_name,
         worker_token = excluded.worker_token`,
    )
    .run({ $id: id, $display_name: displayName, $worker_token: workerToken });
}

export function userByWorkerToken(token: string): LocalUser | null {
  return rowUser(
    database
      .query(
        `SELECT id, display_name, worker_token, linkedin_restricted
         FROM lamy_users WHERE worker_token = $token LIMIT 1`,
      )
      .get({ $token: token }),
  );
}

export function listBank(userId: string) {
  return database
    .query(
      `SELECT id, claim, metric, tags, state, source
       FROM lamy_bank WHERE user_id = $user ORDER BY id`,
    )
    .all({ $user: userId })
    .map((row: any) => ({
      ...row,
      id: Number(row.id),
      tags: decodeJson<string[]>(row.tags, []),
    }));
}

export function listRoles(userId: string) {
  return database
    .query(
      `SELECT id, title, company, archetype, must_haves, jd, source_url
       FROM lamy_roles WHERE user_id = $user ORDER BY id`,
    )
    .all({ $user: userId })
    .map((row: any) => ({
      ...row,
      id: Number(row.id),
      must_haves: decodeJson<string[]>(row.must_haves, []),
    }));
}

export function listOpenAsks(userId: string) {
  return database
    .query(
      `SELECT id, question, unlocks, status, created_at, resolved_at
       FROM lamy_asks WHERE user_id = $user AND status = 'open' ORDER BY id`,
    )
    .all({ $user: userId })
    .map((row: any) => ({ ...row, id: Number(row.id) }));
}

export function listApplications(userId: string) {
  return database
    .query(
      `SELECT id, role_id, bullets, bank_ids, fit_at_submit, status,
              submitted_at, created_at
       FROM lamy_applications WHERE user_id = $user ORDER BY id DESC`,
    )
    .all({ $user: userId })
    .map((row: any) => ({
      ...row,
      id: Number(row.id),
      role_id: Number(row.role_id),
      bullets: decodeJson<any[]>(row.bullets, []),
      bank_ids: decodeJson<number[]>(row.bank_ids, []),
      fit_at_submit: row.fit_at_submit == null ? null : Number(row.fit_at_submit),
    }));
}

export function logEvent(userId: string, kind: string, detail: string) {
  database
    .query(`INSERT INTO lamy_events (user_id, kind, detail) VALUES ($user, $kind, $detail)`)
    .run({ $user: userId, $kind: kind, $detail: detail });
}

export function outreachHistory(userId: string) {
  return database
    .query(`SELECT at FROM lamy_outreach WHERE user_id = $user ORDER BY at DESC LIMIT 500`)
    .all({ $user: userId }) as { at: string }[];
}

export function queuedCount(userId: string) {
  const row = database
    .query(`SELECT COUNT(*) AS count FROM lamy_worker_queue WHERE user_id = $user AND status = 'queued'`)
    .get({ $user: userId }) as { count: number };
  return Number(row?.count ?? 0);
}

export function queueFetchJob(userId: string, url: string) {
  const row = database
    .query(
      `INSERT INTO lamy_worker_queue (user_id, kind, payload)
       VALUES ($user, 'fetch_job', $payload) RETURNING id`,
    )
    .get({ $user: userId, $payload: JSON.stringify({ url }) }) as { id: number };
  return Number(row.id);
}

export function leaseNext(
  userId: string,
  kinds: string[],
  allowOutreach: (item: LocalQueueItem, user: LocalUser) => { allowed: boolean; cap?: unknown },
) {
  return database.transaction(() => {
    database.exec(
      `UPDATE lamy_worker_queue
       SET status = 'queued', leased_at = NULL
       WHERE status = 'leased' AND leased_at < datetime('now', '-10 minutes')`,
    );
    const placeholders = kinds.map((_, index) => `$kind${index}`).join(",");
    const row = database
      .query(
        `SELECT id, user_id, kind, payload, status, leased_at, created_at
         FROM lamy_worker_queue
         WHERE user_id = $user AND status = 'queued' AND kind IN (${placeholders})
         ORDER BY id LIMIT 1`,
      )
      .get({ $user: userId, ...Object.fromEntries(kinds.map((kind, index) => [`$kind${index}`, kind])) });
    if (!row) return { item: null as LocalQueueItem | null };

    const item = rowQueue(row);
    const user = rowUser(
      database
        .query(`SELECT id, display_name, worker_token, linkedin_restricted FROM lamy_users WHERE id = $user`)
        .get({ $user: userId }),
    );
    if (!user) return { item: null as LocalQueueItem | null };

    if (item.kind === "connect" || item.kind === "message") {
      const gate = allowOutreach(item, user);
      if (!gate.allowed) return { item, refused: true, cap: gate.cap };
      database
        .query(`INSERT INTO lamy_outreach (user_id, kind, target) VALUES ($user, $kind, $target)`)
        .run({
          $user: userId,
          $kind: item.kind,
          $target: String(item.payload.target ?? ""),
        });
    }

    database
      .query(`UPDATE lamy_worker_queue SET status = 'leased', leased_at = datetime('now') WHERE id = $id`)
      .run({ $id: item.id });
    return { item: { ...item, status: "leased", leased_at: new Date().toISOString() }, refused: false };
  })();
}

export function requeue(id: number) {
  database
    .query(`UPDATE lamy_worker_queue SET status = 'queued', leased_at = NULL WHERE id = $id AND status = 'leased'`)
    .run({ $id: id });
}

export function report(userId: string, id: number, ok: boolean, result: unknown) {
  const status = ok ? "done" : "failed";
  const rows = database
    .query(
      `UPDATE lamy_worker_queue
       SET status = $status, result = $result, finished_at = datetime('now')
       WHERE id = $id AND user_id = $user AND status = 'leased'`,
    )
    .run({ $status: status, $result: JSON.stringify(result ?? null), $id: id, $user: userId });
  return { changed: rows.changes > 0, status };
}

export function updateBankState(userId: string, id: number, state: "confirmed" | "stale") {
  const guard = state === "confirmed" ? "state = 'inferred'" : "state <> 'stale'";
  const rows = database
    .query(
      `UPDATE lamy_bank SET state = $state, updated_at = datetime('now')
       WHERE user_id = $user AND id = $id AND ${guard}`,
    )
    .run({ $state: state, $user: userId, $id: id });
  return rows.changes > 0;
}

export function resolveAsk(userId: string, id: number, status: "skipped" | "never") {
  const rows = database
    .query(
      `UPDATE lamy_asks SET status = $status, resolved_at = datetime('now')
       WHERE user_id = $user AND id = $id AND status = 'open'`,
    )
    .run({ $status: status, $user: userId, $id: id });
  return rows.changes > 0;
}

export function closeDatabase() {
  database.close();
}
