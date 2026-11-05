// Supabase > Edge Functions > nueva función "fulfill" (Verify JWT: activado)
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
const BASE = "https://oficialnextlevel.com/api/v1";
const j = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const nl = async (path: string, init: RequestInit = {}) => {
  const r = await fetch(BASE + path, { ...init, headers: { Authorization: "Bearer " + Deno.env.get("NEXTLEVEL_API_KEY"), "Content-Type": "application/json" } });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const sb = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: req.headers.get("Authorization")! } } });
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return j({ ok: false, error: "Inicia sesión" }, 401);
    const db = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: me } = await db.from("profiles").select("role,banned").eq("id", user.id).single();
    if (!me || me.banned) return j({ ok: false, error: "Cuenta no habilitada" }, 403);
    const isAdmin = me.role === "admin";
    const { action, order_id } = await req.json();

    if (action === "catalog") {
      if (!isAdmin) return j({ ok: false, error: "No autorizado" }, 403);
      const [a, p] = await Promise.all([nl("/account"), nl("/products")]);
      if (a.status >= 400) return j({ ok: false, error: a.body?.error?.message || "No se pudo consultar Next Level" });
      return j({ ok: true, account: a.body.account, products: p.body.products || [] });
    }

    const { data: o } = await db.from("orders").select("*").eq("id", order_id).single();
    if (!o) return j({ ok: false, error: "Pedido no encontrado" }, 404);
    if (o.user_id !== user.id && !isAdmin) return j({ ok: false, error: "No autorizado" }, 403);

    if (action === "sync") {
      if (!o.nl_id || o.status !== "processing") return j({ ok: true, status: o.status });
      if (o.nl_synced && Date.now() - new Date(o.nl_synced).getTime() < 8000) return j({ ok: true, status: o.status });
      await db.from("orders").update({ nl_synced: new Date().toISOString() }).eq("id", o.id);
      const r = await nl("/orders/" + o.nl_id);
      const st = (r.body.order || r.body)?.status;
      if (st === "COMPLETED") await db.rpc("settle_order", { p_id: o.id, p_ok: true });
      else if (st === "REFUNDED" || st === "FAILED") {
        await db.from("orders").update({ nl_status: st, nl_error: "Next Level no pudo entregar la recarga" }).eq("id", o.id);
        await db.rpc("settle_order", { p_id: o.id, p_ok: false });
      } else if (st) await db.from("orders").update({ nl_status: st }).eq("id", o.id);
      return j({ ok: true, status: st });
    }

    if (action === "send") {
      if (!isAdmin && o.method !== "credits") return j({ ok: false, error: "Este pedido lo acepta el administrador" }, 403);
      if (!o.nl_product) return j({ ok: false, error: "Esta oferta no tiene producto de Next Level" });
      if (o.status !== "pending") return j({ ok: true, status: o.status });
      const [pl, zn] = String(o.player_id).split(/[|/]/).map((s) => s.trim());
      const body: Record<string, string> = { productId: o.nl_product, playerId: pl, clientReference: "madi-" + o.id };
      if (zn) body.zoneId = zn;
      const r = await nl("/orders", { method: "POST", body: JSON.stringify(body) });
      if (r.status >= 400) {
        const code = r.body?.error?.code, msg = r.body?.error?.message || "Error de Next Level";
        await db.from("orders").update({ nl_error: `${code}: ${msg}` }).eq("id", o.id);
        if (code === "PLAYER_ID_INVALID" || code === "ZONE_ID_REQUIRED") {
          await db.rpc("settle_order", { p_id: o.id, p_ok: false });
          return j({ ok: false, error: msg, rejected: true });
        }
        return j({ ok: false, error: msg });
      }
      const ord = r.body.order;
      await db.from("orders").update({ status: "processing", nl_id: ord.id, nl_status: ord.status, nl_error: null }).eq("id", o.id).eq("status", "pending");
      if (ord.status === "COMPLETED") await db.rpc("settle_order", { p_id: o.id, p_ok: true });
      return j({ ok: true, status: ord.status });
    }
    return j({ ok: false, error: "Acción desconocida" }, 400);
  } catch (e) {
    return j({ ok: false, error: "Error interno: " + String(e) }, 500);
  }
});
