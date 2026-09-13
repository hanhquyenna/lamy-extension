async function refresh() {
  const { base, token, last } = await chrome.storage.local.get(["base", "token", "last"]);
  if (base) document.getElementById("base").value = base;
  if (token) document.getElementById("token").value = token;
  const s = document.getElementById("status");
  if (!base || !token) { s.textContent = "not configured"; return; }
  s.textContent = (last ?? "no check-in yet") + "\nfetching status...";
  try {
    const r = await fetch(`${base.replace(/\/$/, "")}/api/worker/hello`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error ?? r.status);
    s.textContent =
      `paired as: ${j.user}\nqueued actions: ${j.queued}` +
      `\ntoday's pace: ${j.cap.used_today}/${j.cap.today_cap} used (ceiling ${j.cap.hard_ceiling})` +
      `\nlast: ${last ?? "no check-in yet"}`;
  } catch (e) {
    s.textContent = `cannot reach server: ${String(e).slice(0, 100)}`;
  }
}
document.getElementById("save").addEventListener("click", async () => {
  await chrome.storage.local.set({
    base: document.getElementById("base").value.trim(),
    token: document.getElementById("token").value.trim(),
  });
  chrome.runtime.sendMessage("tick-now", () => refresh());
  setTimeout(refresh, 1500);
});
refresh();
