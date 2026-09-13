/**
 * Lamy's management page — one page per user, reached ONLY by a signed
 * expiring magic link the agent mints (lamy__link). No passwords, no signup.
 *
 * The local SQLite file is the source of truth for this standalone copy; fit
 * scores come from the same scoreRole implementation used by the worker.
 * Every write here logs to lamy_events.
 *
 * Auth model: /b/<token> where token = base64url("user.exp") + "." + HMAC.
 * A valid token becomes an HttpOnly cookie; every request re-verifies it, so
 * expiry needs no session store. Re-issuing (ask Lamy "send me the link") is
 * the re-login. Confirming a bank entry on this page IS explicit human
 * confirmation — the one way an entry may become 'confirmed'.
 *
 * Env: LAMY_LINK_SECRET (or LAMY_LINK_SECRET_FILE), LAMY_DB_PATH (optional),
 * HOST and PORT (default 127.0.0.1:8790). Run: ./run.sh
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { scoreRole, type BankRow, type RoleRow } from "./lamy-scoring.ts";
import { computeCap } from "./lamy-cap.ts";
import {
  listApplications,
  listBank,
  listOpenAsks,
  listRoles,
  logEvent,
  outreachHistory,
  queuedCount,
  leaseNext,
  report,
  resolveAsk,
  updateBankState,
  userByWorkerToken,
} from "./db.ts";

const SECRET =
  process.env.LAMY_LINK_SECRET ??
  (process.env.LAMY_LINK_SECRET_FILE
    ? (await Bun.file(process.env.LAMY_LINK_SECRET_FILE).text()).trim()
    : "");
const PORT = Number(process.env.PORT ?? 8790);
if (!SECRET) {
  console.error("need LAMY_LINK_SECRET (generate one with: openssl rand -hex 32)");
  process.exit(1);
}

// --- auth -------------------------------------------------------------------
function verifyToken(token: string | undefined): string | null {
  if (!token) return null;
  const dot = token.lastIndexOf(".");
  if (dot < 1) return null;
  const payloadB64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  let payload: string;
  try {
    payload = Buffer.from(payloadB64, "base64url").toString();
  } catch {
    return null;
  }
  const expect = createHmac("sha256", SECRET).update(payload).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const sep = payload.lastIndexOf(".");
  const user = payload.slice(0, sep);
  const exp = Number(payload.slice(sep + 1));
  if (!user || !Number.isFinite(exp) || Date.now() > exp) return null;
  return user;
}
const cookieToken = (req: Request) =>
  /(?:^|;\s*)lamy=([^;]+)/.exec(req.headers.get("cookie") ?? "")?.[1];

// --- html -------------------------------------------------------------------
const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

function page(user: string, body: string) {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Lamy</title><style>
:root{--bg:#f7f7f5;--card:#fff;--ink:#1a1a1a;--mut:#6b6b6b;--line:#e4e4e0;--ok:#1f7a4d;--warn:#a15c00;--bad:#a13030;--acc:#3d5a80}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 -apple-system,system-ui,sans-serif}
main{max-width:960px;margin:0 auto;padding:20px 16px 60px}
h1{font-size:20px;margin:8px 0 2px}h2{font-size:15px;margin:26px 0 8px;text-transform:uppercase;letter-spacing:.4px;color:var(--mut)}
.sub{color:var(--mut);font-size:13px;margin-bottom:6px}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px 14px;margin-bottom:8px}
.row{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap}.grow{flex:1;min-width:220px}
.tag{display:inline-block;font-size:11px;padding:1px 8px;border-radius:10px;border:1px solid var(--line);color:var(--mut)}
.tag.ok{color:var(--ok);border-color:var(--ok)}.tag.warn{color:var(--warn);border-color:var(--warn)}.tag.bad{color:var(--bad);border-color:var(--bad)}
.score{font-weight:700;font-size:18px}.score.pass{color:var(--ok)}.score.fail{color:var(--warn)}
button{background:var(--acc);color:#fff;border:0;border-radius:6px;padding:5px 12px;font-size:13px;cursor:pointer}
button.ghost{background:transparent;color:var(--mut);border:1px solid var(--line)}
form{display:inline}small{color:var(--mut)}
.board{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px}
.col{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:8px;min-height:60px}
.col h3{font-size:11px;margin:0 0 6px;text-transform:uppercase;letter-spacing:.4px;color:var(--mut)}
.chip{font-size:12px;background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:4px 6px;margin-bottom:4px}
ul{margin:6px 0;padding-left:18px}li{margin:2px 0}
</style></head><body><main>
<h1>Lamy</h1><div class="sub">Signed in as <b>${esc(user)}</b> · this page and the chat share one truth — edits here re-score everything immediately. · Last updated <span id="upd"></span></div>
<div id="stale" style="display:none;background:#a13030;color:#fff;padding:10px 14px;border-radius:8px;margin:10px 0;font-weight:600">Connection lost — this page may be showing old information. It keeps retrying by itself; you can also just reload.</div>
${body}</main>
<script>
document.getElementById('upd').textContent = new Date().toLocaleTimeString();
// Self-healing floor: a cheap heartbeat drives an unmissable banner (this
// persona will not notice a subtle spinner), and a full reload every 60s
// removes the need to perfectly detect every dead-connection edge case.
let fails = 0;
async function beat(){
  try { const r = await fetch('/', {method:'HEAD'}); if(!r.ok) throw 0;
        fails = 0; document.getElementById('stale').style.display='none'; }
  catch(e){ if(++fails >= 2) document.getElementById('stale').style.display='block'; }
}
setInterval(beat, 20000);
setTimeout(() => location.reload(), 60000);
</script></body></html>`;
}

// --- data + render ----------------------------------------------------------
const STAGES = ["sourced", "profiled", "scored", "tailored", "gated", "ready", "submitted", "answered"] as const;

async function renderHome(user: string): Promise<string> {
  const [bank, roles, asks, apps] = await Promise.all([
    Promise.resolve(listBank(user) as BankRow[]),
    Promise.resolve(listRoles(user) as RoleRow[]),
    Promise.resolve(listOpenAsks(user)),
    Promise.resolve(listApplications(user)),
  ]);

  const stateTag = (s: string) =>
    s === "confirmed" ? "ok" : s === "inferred" ? "warn" : "bad";
  const bankRows = (state: string) =>
    bank
      .filter((b) => b.state === state)
      .map(
        (b) => `<div class="card"><div class="row">
<span class="grow">#${b.id} · ${esc(b.claim)}${b.metric ? ` <b>(${esc(b.metric)})</b>` : ""}<br><small>source: ${esc(b.source)}</small></span>
<span class="tag ${stateTag(b.state)}">${b.state}</span>
${state === "inferred" ? `<form method="post" action="/bank/${b.id}/confirm"><button>Confirm — this is true</button></form>` : ""}
${state !== "stale" ? `<form method="post" action="/bank/${b.id}/stale"><button class="ghost">Mark stale</button></form>` : ""}
</div></div>`,
      )
      .join("") || `<div class="sub">nothing here</div>`;

  const roleCards = roles
    .map((r) => {
      const f = scoreRole(r, bank);
      return `<div class="card"><div class="row">
<span class="grow"><b>${esc(r.title)}</b> · ${esc(r.company)}<br><small>${
        r.must_haves.length
      } requirements${(r as any).source_url ? ` · <a href="${esc((r as any).source_url)}" rel="noreferrer">posting</a>` : ""}</small></span>
<span class="score ${f.passes_bar ? "pass" : "fail"}">${f.score}</span><small>/ bar ${f.bar}</small></div>
${f.gaps.length ? `<small>missing: ${f.gaps.map(esc).join(" · ")}</small>` : ""}
${f.weak_only.length ? `<br><small>unconfirmed evidence only: ${f.weak_only.map((w) => esc(w.need) + " (bank #" + w.by + ")").join(" · ")}</small>` : ""}
</div>`;
    })
    .join("") || `<div class="sub">no saved roles yet — give Lamy a job link</div>`;

  const askCards = asks
    .map(
      (a) => `<div class="card"><div class="row">
<span class="grow">${esc(a.question)}<br><small>unlocks: ${esc(a.unlocks)}</small></span>
<form method="post" action="/ask/${a.id}/skipped"><button class="ghost">Skip for now</button></form>
<form method="post" action="/ask/${a.id}/never"><button class="ghost">Never ask again</button></form>
</div></div>`,
    )
    .join("") || `<div class="sub">no open questions</div>`;

  const appCards = apps
    .map(
      (a) => `<div class="card"><div class="row">
<span class="grow">role #${a.role_id} · <b>${esc(a.status)}</b> · fit at submit: ${a.fit_at_submit}<br>
<small>${(a.bullets ?? []).map((b: any) => esc(b.text)).join("<br>")}</small></span>
<small>${esc((a.submitted_at ?? a.created_at ?? "").slice(0, 10))}</small></div></div>`,
    )
    .join("") || `<div class="sub">no applications yet</div>`;

  // Pipeline: derived, like everything else. tailored/gated are chat-transient
  // states and stay empty here until the stage machine is table-backed.
  const stageOf = new Map<number, string>();
  for (const r of roles) stageOf.set(r.id, r.must_haves.length ? "scored" : "sourced");
  for (const a of apps) {
    const s =
      a.status === "prepared" ? "ready" : a.status === "submitted" ? "submitted" : "answered";
    stageOf.set(a.role_id, s);
  }
  const board = STAGES.map((s) => {
    const items = roles
      .filter((r) => stageOf.get(r.id) === s)
      .map((r) => `<div class="chip">${esc(r.title)} · ${esc(r.company)}</div>`)
      .join("");
    return `<div class="col"><h3>${s}</h3>${items}</div>`;
  }).join("");

  return page(
    user,
    `<h2>Pipeline</h2><div class="board">${board}</div>
<h2>Experience bank — needs your confirmation</h2>${bankRows("inferred")}
<h2>Experience bank — confirmed</h2>${bankRows("confirmed")}
<h2>Experience bank — stale</h2>${bankRows("stale")}
<h2>Saved roles (fit is computed live)</h2>${roleCards}
<h2>Open questions from Lamy</h2>${askCards}
<h2>Applications (frozen history)</h2>${appCards}`,
  );
}

// --- server -----------------------------------------------------------------
const redirect = (to: string, cookie?: string) =>
  new Response(null, {
    status: 303,
    headers: { Location: to, ...(cookie ? { "Set-Cookie": cookie } : {}) },
  });

Bun.serve({
  hostname: process.env.HOST ?? "127.0.0.1",
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/healthz")
      return new Response(JSON.stringify({ ok: true, database: "local" }), {
        headers: { "Content-Type": "application/json" },
      });

    const m = /^\/b\/(.+)$/.exec(url.pathname);
    if (m) {
      const user = verifyToken(decodeURIComponent(m[1]));
      if (!user)
        return new Response("This link is invalid or has expired. Ask Lamy for a fresh one.", { status: 401 });
      return redirect(
        "/",
        `lamy=${encodeURIComponent(m[1])}; Path=/; HttpOnly; SameSite=Lax; Max-Age=1209600`,
      );
    }

    // Worker-API requests authenticate with their own pairing token inside
    // the block below — the magic-link cookie gate must not intercept them.
    const isWorkerApi = url.pathname.startsWith("/api/worker/");
    const user = verifyToken(cookieToken(req) && decodeURIComponent(cookieToken(req)!));
    if (!user && !isWorkerApi)
      return new Response("Not signed in. Ask Lamy for your link.", { status: 401 });

    // ------------------------------------------------------------------
    // Extension-worker API. Authenticated by the long-lived pairing token
    // (lamy_users.worker_token), NOT the magic-link cookie. The extension is
    // hands only: lease one action, do it, report — every decision including
    // the outreach cap is made here, server side.
    // ------------------------------------------------------------------
    if (url.pathname.startsWith("/api/worker/")) {
      const cors = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Content-Type": "application/json",
      };
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
      if (req.method !== "POST")
        return new Response(JSON.stringify({ error: "POST only" }), { status: 405, headers: cors });
      let body: any = {};
      try { body = await req.json(); } catch {}
      const tok = String(body.token ?? "");
      if (!/^lw_[0-9a-f]{48}$/.test(tok))
        return new Response(JSON.stringify({ error: "bad token" }), { status: 401, headers: cors });
      const wu = userByWorkerToken(tok);
      if (!wu)
        return new Response(JSON.stringify({ error: "unknown token" }), { status: 401, headers: cors });

      if (url.pathname === "/api/worker/hello") {
        const cap = computeCap(outreachHistory(wu.id), wu.linkedin_restricted);
        const queued = queuedCount(wu.id);
        return new Response(
          JSON.stringify({ user: wu.id, queued, cap }),
          { headers: cors },
        );
      }

      if (url.pathname === "/api/worker/lease") {
        const kinds = Array.isArray(body.kinds) && body.kinds.length
          ? body.kinds.map(String)
          : ["fetch_job"];
        const leased = leaseNext(wu.id, kinds, (_item, user) => {
          const cap = computeCap(outreachHistory(user.id), user.linkedin_restricted);
          return cap.used_today >= cap.today_cap ? { allowed: false, cap } : { allowed: true, cap };
        });
        const item = leased.item;
        if (!item) return new Response(JSON.stringify({ none: true }), { headers: cors });

        if (leased.refused) {
          logEvent(wu.id, "outreach_refused", `${item.kind} (worker, cap reached)`);
          return new Response(
            JSON.stringify({ none: true, cap_reached: true, cap: leased.cap }),
            { headers: cors },
          );
        }

        if (item.kind === "connect" || item.kind === "message") {
          // The atomic outreach gate fires at EXECUTION time — here. A refusal
          // returns the item to the queue for tomorrow; the extension is told
          // to stop asking today.
          logEvent(wu.id, "outreach_logged", `${item.kind} ${String(item.payload?.target ?? "").slice(0, 60)} (worker)`);
        }
        return new Response(JSON.stringify({ item }), { headers: cors });
      }

      if (url.pathname === "/api/worker/report") {
        const id = Number(body.id);
        if (!id) return new Response(JSON.stringify({ error: "id required" }), { status: 400, headers: cors });
        // Guarded: only a currently-leased item can be reported.
        const outcome = report(wu.id, id, Boolean(body.ok), body.result ?? null);
        if (outcome.changed) logEvent(wu.id, `worker_${outcome.status}`, `#${id}`);
        return new Response(
          JSON.stringify(outcome.changed ? { recorded: id, status: outcome.status } : { recorded: false, note: "not leased — nothing changed" }),
          { headers: cors },
        );
      }
      return new Response(JSON.stringify({ error: "unknown endpoint" }), { status: 404, headers: cors });
    }

    if (req.method === "HEAD") return new Response(null, { status: 200 });

    if (req.method === "GET" && url.pathname === "/")
      return new Response(await renderHome(user), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });

    if (req.method === "POST") {
      let mm = /^\/bank\/(\d+)\/(confirm|stale)$/.exec(url.pathname);
      if (mm) {
        const state = mm[2] === "confirm" ? "confirmed" : "stale";
        // Guarded write: only lands if the row is still in a state this
        // button applies to — chat or the sheet sync may have won meanwhile.
        // Zero rows back means the redirect simply re-renders the newer
        // truth; no phantom event is logged.
        const changed = updateBankState(user, Number(mm[1]), state);
        if (changed) logEvent(user, `bank_${state}`, `#${mm[1]} (web)`);
        return redirect("/");
      }
      mm = /^\/ask\/(\d+)\/(skipped|never)$/.exec(url.pathname);
      if (mm) {
        const changed = resolveAsk(user, Number(mm[1]), mm[2] as "skipped" | "never");
        if (changed) logEvent(user, `ask_${mm[2]}`, `#${mm[1]} (web)`);
        return redirect("/");
      }
    }
    return new Response("not found", { status: 404 });
  },
});
console.log(`lamy web on ${process.env.HOST ?? "127.0.0.1"}:${PORT}`);
