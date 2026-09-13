// Lamy Worker — background service worker.
//
// The extension is HANDS ONLY. Every decision — what to do, whether the
// daily outreach cap allows it, what a result means — is made server side.
// This file leases one action at a time, executes it in the user's own
// browser (their session, their IP), reports the result, and stops.
//
// v0.1 capabilities: fetch_job only (read a job page the server cannot).
// Outreach kinds are deliberately NOT declared, so the server never leases
// them to this version and never spends cap on it.

const KINDS = ["fetch_job"];

async function cfg() {
  const { base, token } = await chrome.storage.local.get(["base", "token"]);
  const effectiveBase = base || "http://127.0.0.1:8790";
  return token ? { base: effectiveBase.replace(/\/$/, ""), token } : null;
}

async function api(c, path, body) {
  const r = await fetch(`${c.base}/api/worker/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: c.token, ...body }),
  });
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json();
}

// Extract readable job text from a LinkedIn (or any) job page. Prefer the
// JSON-LD JobPosting block (LinkedIn embeds one server-side); fall back to
// stripped body text. Capped, like lamy__source.
function extractJob(html) {
  let title = null;
  let text = null;
  const ldBlocks = html.match(
    /<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi,
  );
  for (const block of ldBlocks ?? []) {
    try {
      const j = JSON.parse(block.replace(/<\/?script[^>]*>/gi, ""));
      const posting = Array.isArray(j)
        ? j.find((x) => x["@type"] === "JobPosting")
        : j["@type"] === "JobPosting"
          ? j
          : null;
      if (posting) {
        title = posting.title ?? null;
        const org = posting.hiringOrganization?.name;
        const desc = String(posting.description ?? "")
          .replace(/<[^>]+>/g, " ")
          .replace(/&nbsp;/g, " ")
          .replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&#\d+;/g, " ")
          .replace(/\s+/g, " ")
          .trim();
        text = `${title ?? ""}${org ? " at " + org : ""}\n${desc}`;
        break;
      }
    } catch (e) {}
  }
  if (!text) {
    text = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/\s+/g, " ")
      .trim();
  }
  return { title, text: text.slice(0, 12000) };
}

async function execute(item) {
  if (item.kind === "fetch_job") {
    const url = item.payload && item.payload.url;
    if (!url) return { ok: false, result: { error: "no url in payload" } };
    const r = await fetch(url, { credentials: "include" });
    if (!r.ok) return { ok: false, result: { error: `HTTP ${r.status}`, url } };
    const html = await r.text();
    const { title, text } = extractJob(html);
    if (!text || text.length < 200)
      return { ok: false, result: { error: "page yielded no readable text", url } };
    return { ok: true, result: { url, title, chars: text.length, untrusted_page_text: text } };
  }
  return { ok: false, result: { error: `kind ${item.kind} not supported by this version` } };
}

async function tick() {
  const c = await cfg();
  if (!c) return;
  // Human-ish jitter: 0-20s before each check-in.
  await new Promise((res) => setTimeout(res, Math.random() * 20000));
  try {
    const lease = await api(c, "lease", { kinds: KINDS });
    const now = new Date().toLocaleTimeString();
    if (lease.cap_reached) {
      await chrome.storage.local.set({ last: `${now} — daily pace reached, resting until tomorrow` });
      return;
    }
    if (!lease.item) {
      await chrome.storage.local.set({ last: `${now} — checked in, nothing queued` });
      return;
    }
    const out = await execute(lease.item);
    await api(c, "report", { id: lease.item.id, ok: out.ok, result: out.result });
    await chrome.storage.local.set({
      last: `${now} — ${lease.item.kind} #${lease.item.id}: ${out.ok ? "done" : "failed"}`,
    });
  } catch (e) {
    await chrome.storage.local.set({ last: `${new Date().toLocaleTimeString()} — ${String(e).slice(0, 80)}` });
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create("lamy-poll", { periodInMinutes: 1 });
});
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "lamy-poll") tick();
});
chrome.runtime.onMessage.addListener((msg, _s, respond) => {
  if (msg === "tick-now") { tick().then(() => respond("ok")); return true; }
});
