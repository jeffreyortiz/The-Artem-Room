// The Artem Room: client deposit page API + Stripe webhook.
// Public (verify_jwt=false). Clients are identified only by the long random token in their deposit link.
//   POST {action:"view", token}            -> what deposit.html shows
//   POST {action:"checkout", token}        -> Stripe Checkout URL (card / Apple Pay / Google Pay)
//   POST {action:"claim", token, method}   -> "I've sent it on Cash App/Venmo/Zelle" -> alert Olie to check
//   Stripe webhook (has Stripe-Signature)  -> marks the deposit paid + alerts Olie
import { createClient } from "npm:@supabase/supabase-js@2";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, apikey, authorization, x-client-info",
  "Access-Control-Max-Age": "86400",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" } });

const SERVICE_NOUN: Record<string, string> = {
  tattooing: "Tattoo", piercing: "Piercing", nails: "Nails", makeup: "Makeup", hair: "Hair",
};
const METHOD_NAME: Record<string, string> = { cashapp: "Cash App", venmo: "Venmo", zelle: "Zelle", stripe: "card" };
const money = (c: number) => "$" + (c / 100).toFixed(c % 100 ? 2 : 0);

async function settings(): Promise<Record<string, string>> {
  const { data } = await sb.from("artem_settings").select("key,value");
  return Object.fromEntries((data ?? []).map((r) => [r.key, r.value]));
}
async function secret(name: string): Promise<string | null> {
  const { data } = await sb.rpc("artem_get_secret", { p_name: name });
  return (data as string) || null;
}
async function byToken(token: unknown) {
  if (typeof token !== "string" || token.length < 24 || token.length > 80) return null;
  const { data } = await sb.from("artem_bookings")
    .select("id,name,email,service,status,preferred_date,scheduled_at,deposit_cents,deposit_note,deposit_status,deposit_claimed_method,deposit_paid_cents,deposit_method")
    .eq("deposit_token", token).maybeSingle();
  return data;
}
const firstName = (n: string) => String(n || "").trim().split(/\s+/)[0];

async function hex(buf: ArrayBuffer) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function verifyStripe(raw: string, header: string, whsec: string) {
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=") as [string, string]).filter((p) => p.length === 2));
  const sigs = header.split(",").filter((p) => p.startsWith("v1=")).map((p) => p.slice(3));
  const t = Number(parts.t);
  if (!t || !sigs.length || Math.abs(Date.now() / 1000 - t) > 300) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(whsec), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = await hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${raw}`)));
  return sigs.some((s) => s.length === expected.length && [...s].reduce((r, c, i) => r | (c.charCodeAt(0) ^ expected.charCodeAt(i)), 0) === 0);
}

async function markPaid(bookingId: string, cents: number, method: string, extra: Record<string, unknown> = {}) {
  const { data: b } = await sb.from("artem_bookings").select("name,service,deposit_status").eq("id", bookingId).maybeSingle();
  if (!b || b.deposit_status === "paid") return;
  await sb.from("artem_bookings").update({
    deposit_status: "paid", deposit_paid_at: new Date().toISOString(), deposit_paid_cents: cents,
    deposit_method: method, updated_at: new Date().toISOString(), ...extra,
  }).eq("id", bookingId);
  const cfg = await settings();
  await sb.rpc("artem_push", {
    p_title: "Deposit paid",
    p_message: `${firstName(b.name)} paid their ${money(cents)} ${SERVICE_NOUN[b.service]?.toLowerCase() ?? ""} deposit by ${METHOD_NAME[method] ?? method}. Time to lock in their date.`,
    p_click: `${cfg.dashboard_url ?? ""}#${bookingId}`,
    p_tags: "moneybag",
  });
}

async function stripeWebhook(req: Request) {
  const raw = await req.text();
  const whsec = await secret("artem_stripe_webhook_secret");
  if (!whsec || !(await verifyStripe(raw, req.headers.get("stripe-signature") ?? "", whsec))) {
    return new Response("bad signature", { status: 400 });
  }
  const evt = JSON.parse(raw);
  const s = evt?.data?.object;
  if ((evt.type === "checkout.session.completed" || evt.type === "checkout.session.async_payment_succeeded") &&
      s?.payment_status === "paid" && s?.client_reference_id) {
    await markPaid(s.client_reference_id, s.amount_total ?? 0, "stripe", {
      stripe_session_id: s.id, stripe_payment_intent: typeof s.payment_intent === "string" ? s.payment_intent : null,
    });
  }
  return new Response("ok");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (req.headers.get("stripe-signature")) return stripeWebhook(req);

  let d: Record<string, unknown>;
  try { d = await req.json(); } catch { return json({ error: "Bad request" }, 400); }
  const b = await byToken(d.token);
  if (!b || b.deposit_status === "none" || !b.deposit_cents) {
    return json({ error: "This deposit link isn't active. Please contact the studio." }, 404);
  }
  const cfg = await settings();
  const stripeKey = await secret("artem_stripe_secret_key");

  switch (String(d.action ?? "view")) {
    case "view":
      return json({
        ok: true,
        first_name: firstName(b.name),
        service: b.service,
        service_name: SERVICE_NOUN[b.service] ?? b.service,
        amount_cents: b.deposit_cents,
        note: b.deposit_note,
        policy: cfg.deposit_policy || "",
        status: b.deposit_status,
        claimed_method: b.deposit_claimed_method,
        paid_cents: b.deposit_paid_cents,
        scheduled_at: b.scheduled_at,
        preferred_date: b.preferred_date,
        options: {
          card: !!stripeKey,
          cashapp: cfg.cashapp_tag || null,
          venmo: cfg.venmo_user || null,
          zelle: cfg.zelle_contact || null,
        },
      });

    case "checkout": {
      if (b.deposit_status === "paid" || b.deposit_status === "waived") return json({ error: "This deposit is already taken care of." }, 409);
      if (!stripeKey) return json({ error: "Card payments aren't set up yet. Please use one of the other options." }, 400);
      const site = (cfg.site_url || "https://theartemroom.netlify.app").replace(/\/$/, "");
      const back = `${site}/deposit.html?t=${encodeURIComponent(String(d.token))}`;
      const p = new URLSearchParams({
        mode: "payment",
        client_reference_id: b.id,
        success_url: `${back}&paid=1`,
        cancel_url: back,
        "line_items[0][quantity]": "1",
        "line_items[0][price_data][currency]": "usd",
        "line_items[0][price_data][unit_amount]": String(b.deposit_cents),
        "line_items[0][price_data][product_data][name]": `${SERVICE_NOUN[b.service] ?? "Appointment"} deposit — The Artem Room`,
        "line_items[0][price_data][product_data][description]": `Deposit for ${firstName(b.name)}'s ${(SERVICE_NOUN[b.service] ?? "appointment").toLowerCase()} appointment`,
        "metadata[booking_id]": b.id,
        "payment_intent_data[metadata][booking_id]": b.id,
        "payment_intent_data[description]": `The Artem Room ${(SERVICE_NOUN[b.service] ?? "").toLowerCase()} deposit — ${b.name}`,
      });
      if (b.email) p.set("customer_email", b.email);
      const r = await fetch("https://api.stripe.com/v1/checkout/sessions", {
        method: "POST",
        headers: { Authorization: `Bearer ${stripeKey}`, "Content-Type": "application/x-www-form-urlencoded" },
        body: p,
      });
      const out = await r.json().catch(() => ({}));
      if (!r.ok || !out.url) return json({ error: "Couldn't start card checkout. Please try another option or contact the studio." }, 502);
      await sb.from("artem_bookings").update({ stripe_session_id: out.id }).eq("id", b.id);
      return json({ ok: true, url: out.url });
    }

    case "claim": {
      const method = String(d.method ?? "");
      if (!["cashapp", "venmo", "zelle"].includes(method)) return json({ error: "Unknown payment method." }, 400);
      if (b.deposit_status !== "requested") return json({ ok: true, status: b.deposit_status });
      await sb.from("artem_bookings").update({
        deposit_status: "claimed", deposit_claimed_method: method, deposit_claimed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).eq("id", b.id);
      await sb.rpc("artem_push", {
        p_title: "Check for a deposit",
        p_message: `${firstName(b.name)} says they sent their ${money(b.deposit_cents)} deposit on ${METHOD_NAME[method]}. Check the app, then mark it paid.`,
        p_click: `${cfg.dashboard_url ?? ""}#${b.id}`,
        p_tags: "eyes",
      });
      return json({ ok: true, status: "claimed" });
    }

    default:
      return json({ error: "Unknown action." }, 400);
  }
});
