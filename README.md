# Lamy browser extension and worker backend

This repository contains both pieces of the Lamy worker:

- the Chrome MV3 extension, which reads a queued job page in the user's own browser;
- the small HTTP backend in `backend/server.ts`, which authenticates the extension, leases queued work, and records results;
- a local SQLite database in `data/lamy.sqlite`, created automatically on first start.

The extension has no personal server URL or token baked into it. A clone uses its own local backend at `http://127.0.0.1:8790` and its own local SQLite file. Nothing connects to the original project or requires Supabase.

## Run your own copy

Requirement: [Bun](https://bun.sh).

1. Clone this repository and create local configuration:

   ```sh
   cp .env.example .env
   openssl rand -hex 32
   ```

   Put the generated value after `LAMY_LINK_SECRET=` in `.env`. Never commit that file.

2. Start the backend:

   ```sh
   bun run start
   ```

   The server listens on `127.0.0.1:8790` by default and creates `data/lamy.sqlite`. Check it with `curl http://127.0.0.1:8790/healthz`.

3. Create a user and pairing token:

   ```sh
   bun run pair -- --user friend --name Friend
   ```

   Copy the printed `lw_...` token. Running `pair` again replaces the old token and revokes it.

4. In Chrome, open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select this repository folder. In the Lamy popup, leave the server address as `http://127.0.0.1:8790` and paste the pairing token.

5. Click the Lamy toolbar icon to open the persistent Side Panel. If Chrome still shows the old popup, reload the extension once from `chrome://extensions`.

6. To test a queued job without a chat agent, queue a URL from another terminal:

   ```sh
   bun run queue -- --user friend --url https://www.linkedin.com/jobs/view/123456789/
   ```

   With Chrome open, the extension leases the job and reports the result to the local backend.

## Checks

```sh
bun run check
```

This builds the backend and helper scripts, checks both extension scripts, and parses the manifest. No user data or credentials are included in the repository.
