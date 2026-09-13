# Lamy browser extension and worker backend

This repository contains both pieces of the Lamy worker:

- the Chrome MV3 extension, which reads a queued job page in the user's own browser;
- the small HTTP backend in `backend/server.ts`, which authenticates the extension, leases queued work, and records results.

The extension has no personal server URL or token baked into it. A clone uses its own local backend at `http://127.0.0.1:8790` by default. The backend uses the operator's own Supabase project; service-role credentials stay in `.env`, which is ignored by Git.

## Run your own copy

Requirements: [Bun](https://bun.sh) and a Supabase project.

1. Clone this repository and create the database tables. In the Supabase SQL editor, run [`db/setup-all.sql`](db/setup-all.sql).
2. Create local configuration:

   ```sh
   cp .env.example .env
   openssl rand -hex 32
   ```

   Put your own Supabase URL, service-role key, and generated secret in `.env`. Never commit that file.

3. Start the backend:

   ```sh
   bun run start
   ```

   The server listens on `127.0.0.1:8790` by default. Set `HOST=0.0.0.0` only when you deliberately run your own remote host or tunnel.

4. Create a user and pairing token in your own Supabase database. Generate a token locally, then run an update like:

   ```sql
   insert into lamy_users (id, display_name, worker_token)
   values ('friend', 'Friend', 'lw_REPLACE_WITH_48_HEX_CHARACTERS')
   on conflict (id) do update set worker_token = excluded.worker_token;
   ```

   The token must match `lw_` followed by 48 hexadecimal characters. It is separate from the magic-link secret and can be revoked by replacing it.

5. In Chrome, open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select this repository folder. In the Lamy popup, leave the server address as `http://127.0.0.1:8790` and paste the pairing token you created.

## Checks

```sh
bun run check
```

This builds the backend, checks both extension scripts, and parses the manifest. No user data or credentials are included in the repository.
