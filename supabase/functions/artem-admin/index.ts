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
async function secret(name: string): Promise<string | null> {
  const { data } = await sb.rpc("artem_get_secret", { p_name: name });
  return (data as string) || null;
}
function randomToken(bytes = 24) {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...raw)).replace(/[+/=]/g, (c) => ({ "+": "-", "/": "_", "=": "" }[c]!));
}
const cents = (v: unknown) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? n : NaN;
};
const DEPOSIT_FIELDS = "id,quote_cents,deposit_cents,deposit_note,deposit_status,deposit_token,deposit_requested_at,deposit_claimed_method,deposit_claimed_at,deposit_paid_at,deposit_paid_cents,deposit_method,updated_at";
const PAY_KEYS = ["cashapp_tag", "venmo_user", "zelle_contact", "deposit_policy"];
async function stripe(key: string, path: string, method = "GET", body?: URLSearchParams) {
  const r = await fetch(`https://api.stripe.com/v1/${path}`, {
    method, body,
    headers: { Authorization: `Bearer ${key}`, ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
  });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(out?.error?.message || `Stripe error ${r.status}`);
  return out;
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
        .select("id,created_at,updated_at,status,service,name,phone,email,instagram,contact_pref,preferred_date,alt_date,time_pref,details,placement,size,is_adult,photo_paths,scheduled_at,owner_notes,quote_cents,deposit_cents,deposit_note,deposit_status,deposit_token,deposit_requested_at,deposit_claimed_method,deposit_claimed_at,deposit_paid_at,deposit_paid_cents,deposit_method")
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
    case "request_deposit": {
      const id = String(d.id ?? "");
      const dep = cents(d.deposit_cents);
      const quote = d.quote_cents === null || d.quote_cents === "" || d.quote_cents === undefined ? null : cents(d.quote_cents);
      if (!(dep >= 100 && dep <= 10000000)) return json({ error: "Deposit must be at least $1." }, 400);
      if (quote !== null && !(quote >= 0 && quote <= 10000000)) return json({ error: "Full price looks wrong." }, 400);
      const { data: cur } = await sb.from("artem_bookings").select("deposit_token,deposit_status").eq("id", id).maybeSingle();
      if (!cur) return json({ error: "Booking not found." }, 404);
      if (cur.deposit_status === "paid") return json({ error: "This deposit is already paid." }, 409);
      const { data, error } = await sb.from("artem_bookings").update({
        deposit_cents: dep, quote_cents: quote,
        deposit_note: String(d.note ?? "").trim().slice(0, 1000) || null,
        deposit_status: "requested",
        deposit_token: cur.deposit_token || randomToken(),
        deposit_requested_at: new Date().toISOString(),
        deposit_claimed_method: null, deposit_claimed_at: null,
        updated_at: new Date().toISOString(),
      }).eq("id", id).select(DEPOSIT_FIELDS).maybeSingle();
      if (error || !data) return json({ error: "Couldn't save the deposit." }, 400);
      return json({ ok: true, booking: data });
    }
    case "mark_deposit": {
      const id = String(d.id ?? "");
      const to = String(d.status ?? "");
      const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (to === "paid") {
        const m = String(d.method ?? "other");
        if (!["stripe", "cashapp", "venmo", "zelle", "cash", "other"].includes(m)) return json({ error: "Unknown method." }, 400);
        const { data: cur } = await sb.from("artem_bookings").select("deposit_cents").eq("id", id).maybeSingle();
        Object.assign(patch, { deposit_status: "paid", deposit_method: m, deposit_paid_at: new Date().toISOString(), deposit_paid_cents: cur?.deposit_cents ?? null });
      } else if (to === "waived") {
        Object.assign(patch, { deposit_status: "waived" });
      } else if (to === "requested") {
        Object.assign(patch, { deposit_status: "requested", deposit_paid_at: null, deposit_paid_cents: null, deposit_method: null, deposit_claimed_method: null, deposit_claimed_at: null });
      } else if (to === "none") {
        // cancel: the old link stops working
        Object.assign(patch, { deposit_status: "none", deposit_token: null, deposit_paid_at: null, deposit_paid_cents: null, deposit_method: null, deposit_claimed_method: null, deposit_claimed_at: null });
      } else return json({ error: "Unknown deposit status." }, 400);
      const { data, error } = await sb.from("artem_bookings").update(patch).eq("id", id).select(DEPOSIT_FIELDS).maybeSingle();
      if (error || !data) return json({ error: "Couldn't update the deposit." }, 400);
      return json({ ok: true, booking: data });
    }
    case "payment_settings": {
      const key = await secret("artem_stripe_secret_key");
      return json({
        ok: true,
        ...Object.fromEntries(PAY_KEYS.map((k) => [k, cfg[k] ?? ""])),
        stripe_connected: !!key,
        stripe_mode: key ? (key.includes("_test_") ? "test" : "live") : null,
      });
    }
    case "save_payment_settings": {
      const clean: Record<string, string> = {
        cashapp_tag: String(d.cashapp_tag ?? "").trim().replace(/^\$+/, "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 30),
        venmo_user: String(d.venmo_user ?? "").trim().replace(/^@+/, "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40),
        zelle_contact: String(d.zelle_contact ?? "").trim().slice(0, 120),
        deposit_policy: String(d.deposit_policy ?? "").trim().slice(0, 1500),
      };
      for (const [k, v] of Object.entries(clean)) await setSetting(k, v);
      return json({ ok: true, ...clean });
    }
    case "connect_stripe": {
      const key = String(d.secret_key ?? "").trim();
      if (!/^(sk|rk)_(test|live)_[A-Za-z0-9]{10,}$/.test(key)) return json({ error: "That doesn't look like a Stripe secret key (starts with sk_live_ or sk_test_)." }, 400);
      const hookUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/artem-deposit`;
      try {
        // replace any webhook we made before, then create a fresh one (Stripe only shows its secret on creation)
        const existing = await stripe(key, "webhook_endpoints?limit=100");
        for (const w of existing.data ?? []) if (w.url === hookUrl) await stripe(key, `webhook_endpoints/${w.id}`, "DELETE");
        const hook = await stripe(key, "webhook_endpoints", "POST", new URLSearchParams([
          ["url", hookUrl],
          ["enabled_events[]", "checkout.session.completed"],
          ["enabled_events[]", "checkout.session.async_payment_succeeded"],
          ["description", "The Artem Room deposits"],
        ]));
        await sb.rpc("artem_set_secret", { p_name: "artem_stripe_secret_key", p_value: key });
        await sb.rpc("artem_set_secret", { p_name: "artem_stripe_webhook_secret", p_value: hook.secret });
        await sb.rpc("artem_set_secret", { p_name: "artem_stripe_webhook_id", p_value: hook.id });
      } catch (e) {
        return json({ error: `Stripe said: ${(e as Error).message}` }, 400);
      }
      return json({ ok: true, stripe_connected: true, stripe_mode: key.includes("_test_") ? "test" : "live" });
    }
    case "disconnect_stripe": {
      const key = await secret("artem_stripe_secret_key");
      const hookId = await secret("artem_stripe_webhook_id");
      if (key && hookId) await stripe(key, `webhook_endpoints/${hookId}`, "DELETE").catch(() => null);
      for (const n of ["artem_stripe_secret_key", "artem_stripe_webhook_secret", "artem_stripe_webhook_id"]) {
        await sb.rpc("artem_set_secret", { p_name: n, p_value: "" });
      }
      return json({ ok: true, stripe_connected: false });
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
