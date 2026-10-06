// The Artem Room: owner dashboard API (used by bookings.html).
// Auth: 6-digit PIN -> random session token (only its hash is stored). Failed PINs are rate limited.
// Deployed with verify_jwt=false; every action except "login" requires a valid session.
import { createClient } from "npm:@supabase/supabase-js@2";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, x-artem-session, apikey, authorization, x-client-info",
  "Access-Control-Max-Age": "86400",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" } });

const STATUSES = ["new", "confirmed", "completed", "declined", "cancelled"];
const FAILS_PER_IP = 5;      // per 15 minutes
const FAILS_GLOBAL = 25;     // per hour, across everyone

async function sha(s: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
async function settings(): Promise<Record<string, string>> {
  const { data } = await sb.from("artem_settings").select("key,value");
  return Object.fromEntries((data ?? []).map((r) => [r.key, r.value]));
}
async function setSetting(key: string, value: string) {
  await sb.from("artem_settings").upsert({ key, value, updated_at: new Date().toISOString() });
}
async function lockedOut(ipHash: string) {
  const q15 = new Date(Date.now() - 15 * 60e3).toISOString();
  const q60 = new Date(Date.now() - 60 * 60e3).toISOString();
  const [{ count: mine }, { count: all }] = await Promise.all([
    sb.from("artem_admin_attempts").select("id", { count: "exact", head: true }).eq("ip_hash", ipHash).eq("ok", false).gte("at", q15),
    sb.from("artem_admin_attempts").select("id", { count: "exact", head: true }).eq("ok", false).gte("at", q60),
  ]);
  return (mine ?? 0) >= FAILS_PER_IP || (all ?? 0) >= FAILS_GLOBAL;
}
async function checkPin(cfg: Record<string, string>, pin: unknown) {
  if (typeof pin !== "string" || !/^\d{4,12}$/.test(pin)) return false;
  return safeEqual(await sha(`${cfg.pin_salt}:${pin}`), cfg.pin_hash ?? "");
}
async function newSession() {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const token = btoa(String.fromCharCode(...raw)).replace(/[+/=]/g, (c) => ({ "+": "-", "/": "_", "=": "" }[c]!));
  await sb.from("artem_sessions").insert({ token_hash: await sha(token) });
  return token;
}
async function validSession(token: string | null) {
  if (!token || token.length < 20) return false;
  const { data } = await sb.from("artem_sessions").select("expires_at").eq("token_hash", await sha(token)).maybeSingle();
  return !!data && new Date(data.expires_at) > new Date();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  let d: Record<string, unknown>;
  try { d = await req.json(); } catch { return json({ error: "Bad request" }, 400); }

  const cfg = await settings();
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
  const ipHash = await sha(`${cfg.ip_salt}:${ip}`);
  const action = String(d.action ?? "");

  if (action === "login") {
    if (await lockedOut(ipHash)) return json({ error: "Too many wrong tries. Wait 15 minutes and try again." }, 429);
    const ok = await checkPin(cfg, d.pin);
    await sb.from("artem_admin_attempts").insert({ ip_hash: ipHash, ok });
    if (!ok) return json({ error: "Wrong PIN." }, 401);
    // tidy up old rows while we're here
    await sb.from("artem_admin_attempts").delete().lt("at", new Date(Date.now() - 7 * 864e5).toISOString());
    await sb.from("artem_sessions").delete().lt("expires_at", new Date().toISOString());
    return json({ ok: true, token: await newSession() });
  }

  const token = req.headers.get("x-artem-session");
  if (!(await validSession(token))) return json({ error: "Please sign in again.", reauth: true }, 401);

  switch (action) {
    case "list": {
      const { data, error } = await sb.from("artem_bookings")
        .select("id,created_at,updated_at,status,service,name,phone,email,instagram,contact_pref,preferred_date,alt_date,time_pref,details,placement,size,is_adult,photo_paths,scheduled_at,owner_notes")
        .order("created_at", { ascending: false }).limit(500);
      if (error) return json({ error: "Couldn't load bookings." }, 500);
      const paths = (data ?? []).flatMap((b) => b.photo_paths ?? []);
      const urls: Record<string, string> = {};
      if (paths.length) {
        const { data: signed } = await sb.storage.from("artem-refs").createSignedUrls(paths, 60 * 60 * 6);
        for (const s of signed ?? []) if (s.signedUrl && s.path) urls[s.path] = s.signedUrl;
      }
      return json({
        ok: true,
        bookings: (data ?? []).map((b) => ({ ...b, photos: (b.photo_paths ?? []).map((p: string) => urls[p]).filter(Boolean) })),
      });
    }
    case "update": {
      const id = String(d.id ?? "");
      const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (d.status !== undefined) {
        if (!STATUSES.includes(String(d.status))) return json({ error: "Unknown status." }, 400);
        patch.status = d.status;
      }
      if (d.owner_notes !== undefined) patch.owner_notes = String(d.owner_notes ?? "").slice(0, 3000) || null;
      if (d.scheduled_at !== undefined) {
        const v = d.scheduled_at ? new Date(String(d.scheduled_at)) : null;
        if (v && isNaN(+v)) return json({ error: "Bad date." }, 400);
        patch.scheduled_at = v ? v.toISOString() : null;
      }
      const { data, error } = await sb.from("artem_bookings").update(patch).eq("id", id).select("id,status,owner_notes,scheduled_at,updated_at").maybeSingle();
      if (error || !data) return json({ error: "Couldn't update that booking." }, 400);
      return json({ ok: true, booking: data });
    }
    case "delete": {
      const id = String(d.id ?? "");
      const { data } = await sb.from("artem_bookings").select("photo_paths").eq("id", id).maybeSingle();
      if (data?.photo_paths?.length) await sb.storage.from("artem-refs").remove(data.photo_paths);
      const { error } = await sb.from("artem_bookings").delete().eq("id", id);
      return error ? json({ error: "Couldn't delete." }, 400) : json({ ok: true });
    }
    case "change_pin": {
      if (!(await checkPin(cfg, d.current_pin))) {
        await sb.from("artem_admin_attempts").insert({ ip_hash: ipHash, ok: false });
        return json({ error: "Current PIN is wrong." }, 401);
      }
      const np = String(d.new_pin ?? "");
      if (!/^\d{6,12}$/.test(np)) return json({ error: "New PIN must be 6–12 digits." }, 400);
      await setSetting("pin_hash", await sha(`${cfg.pin_salt}:${np}`));
      // sign out every other device, keep this one
      await sb.from("artem_sessions").delete().neq("token_hash", await sha(token!));
      return json({ ok: true });
    }
    case "test_notify": {
      const { error } = await sb.rpc("artem_notify", { p_test: true });
      return json({ ok: !error });
    }
    case "notify_info":
      return json({ ok: true, ntfy_server: cfg.ntfy_server, ntfy_topic: cfg.ntfy_topic });
    case "logout":
      await sb.from("artem_sessions").delete().eq("token_hash", await sha(token!));
      return json({ ok: true });
    default:
      return json({ error: "Unknown action." }, 400);
  }
});
