// Supabase > Edge Functions > nueva función "nl-webhook" (Verify JWT: DESACTIVADO)
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
Deno.serve(async (req) => {
  const body = await req.text();
  const h = req.headers.get("NL-Signature") || "";
  const t = /t=(\d+)/.exec(h)?.[1], v1 = /v1=([0-9a-f]+)/.exec(h)?.[1];
  if (!t || !v1 || Math.abs(Date.now() / 1000 - Number(t)) > 300) return new Response("bad request", { status: 400 });
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(Deno.env.get("NEXTLEVEL_WEBHOOK_SECRET")!), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const exp = hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(t + "." + body)));
  let diff = exp.length ^ v1.length;
  for (let i = 0; i < Math.min(exp.length, v1.length); i++) diff |= exp.charCodeAt(i) ^ v1.charCodeAt(i);
  if (diff !== 0) return new Response("bad signature", { status: 401 });
  const ev = JSON.parse(body);
  if (ev.type === "webhook.test") return new Response("ok");
  const m = /^madi-(\d+)$/.exec(ev.order?.clientReference || "");
  if (!m) return new Response("ignored");
  const id = Number(m[1]);
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  if (ev.type === "order.processing") await db.from("orders").update({ status: "processing", nl_status: "PROCESSING" }).eq("id", id).eq("status", "pending");
  else if (ev.type === "order.completed") await db.rpc("settle_order", { p_id: id, p_ok: true });
  else if (ev.type === "order.refunded" || ev.type === "order.failed") {
    await db.from("orders").update({ nl_status: ev.order?.status, nl_error: "Next Level no pudo entregar la recarga" }).eq("id", id);
    await db.rpc("settle_order", { p_id: id, p_ok: false });
  }
  return new Response("ok");
});
