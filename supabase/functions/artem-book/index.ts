// The Artem Room: public booking-request endpoint.
// POST JSON from the site's booking form -> validates -> saves to artem_bookings
// -> stores reference photos in the private "artem-refs" bucket -> pings Olie's phone.
// Deployed with verify_jwt=false (public form); abuse limits are enforced below.
import { createClient } from "npm:@supabase/supabase-js@2";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, apikey, authorization, x-client-info",
  "Access-Control-Max-Age": "86400",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const SERVICES: Record<string, string> = {
  tattooing: "Tattooing", piercing: "Piercing", nails: "Nails", makeup: "Makeup", hair: "Hair",
};
const TIMES = ["morning", "afternoon", "evening", "flexible"];
const CONTACT = ["text", "call", "email", "instagram"];
const MAX_PHOTOS = 3;
const MAX_PHOTO_BYTES = 4 * 1024 * 1024;
const PER_IP_PER_HOUR = 4;
const GLOBAL_PER_HOUR = 40;

async function sha(s: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
async function settings(): Promise<Record<string, string>> {
  const { data } = await sb.from("artem_settings").select("key,value");
  return Object.fromEntries((data ?? []).map((r) => [r.key, r.value]));
}
const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const isoDate = (v: unknown) => {
  const s = str(v, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s + "T12:00:00Z");
  if (isNaN(+d)) return null;
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  const max = new Date(today); max.setUTCFullYear(max.getUTCFullYear() + 1);
  return d >= new Date(+today - 864e5) && d <= max ? s : null;
};
function decodePhoto(p: unknown): { bytes: Uint8Array; type: string; ext: string } | null {
  if (typeof p !== "string") return null;
  const m = p.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!m) return null;
  const bin = atob(m[2]);
  if (bin.length > MAX_PHOTO_BYTES) return null;
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  const sig = (i: number, ...v: number[]) => v.every((x, k) => bytes[i + k] === x);
  if (m[1] === "image/jpeg" && sig(0, 0xff, 0xd8, 0xff)) return { bytes, type: m[1], ext: "jpg" };
  if (m[1] === "image/png" && sig(0, 0x89, 0x50, 0x4e, 0x47)) return { bytes, type: m[1], ext: "png" };
  if (m[1] === "image/webp" && sig(0, 0x52, 0x49, 0x46, 0x46) && sig(8, 0x57, 0x45, 0x42, 0x50)) return { bytes, type: m[1], ext: "webp" };
  return null;
}
const prettyDate = (s: string | null) =>
  s ? new Date(s + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }) : "";

// Phone push: the database sends it (public.artem_notify via pg_net -> ntfy.sh), so it leaves from the
// project's own IP rather than shared edge IPs that ntfy rate-limits. Client phone/email are never in the push.
// Optional real SMS via Twilio runs here if twilio_* settings are ever added to artem_settings.
async function notify(cfg: Record<string, string>, id: string, b: Record<string, unknown>) {
  await sb.rpc("artem_notify", { p_id: id });
  if (cfg.twilio_sid && cfg.twilio_token && cfg.twilio_from && cfg.owner_sms_to) {
    const when = [prettyDate(b.preferred_date as string | null), b.time_pref ? String(b.time_pref) : ""].filter(Boolean).join(" · ");
    const body = new URLSearchParams({
      From: cfg.twilio_from, To: cfg.owner_sms_to,
      Body: `The Artem Room: ${String(b.name).split(/\s+/)[0]} wants ${SERVICES[b.service as string]}${when ? ` (${when})` : ""}. ${cfg.dashboard_url || ""}#${id}`,
    });
    await fetch(`https://api.twilio.com/2010-04-01/Accounts/${cfg.twilio_sid}/Messages.json`, {
      method: "POST",
      headers: { Authorization: "Basic " + btoa(`${cfg.twilio_sid}:${cfg.twilio_token}`), "Content-Type": "application/x-www-form-urlencoded" },
      body,
    }).catch(() => null);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let d: Record<string, unknown>;
  try { d = await req.json(); } catch { return json({ error: "Bad request" }, 400); }

  // Bot traps: hidden field must be empty, form must have been open a few seconds.
  if (str(d.website, 200) || (typeof d.elapsed_ms === "number" && d.elapsed_ms < 2500)) {
    return json({ ok: true, id: crypto.randomUUID() }); // pretend success, store nothing
  }

  const service = str(d.service, 20);
  const name = str(d.name, 120);
  const phone = str(d.phone, 40).replace(/[^\d+()\-.\s]/g, "");
  const email = str(d.email, 200).toLowerCase();
  const errors: Record<string, string> = {};
  if (!SERVICES[service]) errors.service = "Pick a service.";
  if (!name) errors.name = "Add your name.";
  if (!phone && !email) errors.phone = "Add a phone number or email so we can reach you.";
  if (phone && phone.replace(/\D/g, "").length < 10) errors.phone = "That phone number looks short.";
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) errors.email = "That email doesn't look right.";
  const contact_pref = CONTACT.includes(str(d.contact_pref, 12)) ? str(d.contact_pref, 12) : (phone ? "text" : "email");
  if ((contact_pref === "text" || contact_pref === "call") && !phone) errors.phone = "Add a phone number so we can text or call.";
  if (contact_pref === "email" && !email) errors.email = "Add an email so we can write back.";
  if (service === "tattooing" && d.is_adult !== true) errors.is_adult = "You must be 18+ to get tattooed in New York.";
  if (Object.keys(errors).length) return json({ error: "Please fix the highlighted fields.", fields: errors }, 422);

  const cfg = await settings();
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
  const ipHash = await sha(`${cfg.ip_salt}:${ip}`);
  const hourAgo = new Date(Date.now() - 3600e3).toISOString();
  const [{ count: mine }, { count: all }] = await Promise.all([
    sb.from("artem_bookings").select("id", { count: "exact", head: true }).eq("source_ip_hash", ipHash).gte("created_at", hourAgo),
    sb.from("artem_bookings").select("id", { count: "exact", head: true }).gte("created_at", hourAgo),
  ]);
  if ((mine ?? 0) >= PER_IP_PER_HOUR || (all ?? 0) >= GLOBAL_PER_HOUR) {
    return json({ error: "We've received a lot of requests just now. Please text or email us directly." }, 429);
  }

  const photos = (Array.isArray(d.photos) ? d.photos : []).slice(0, MAX_PHOTOS).map(decodePhoto).filter(Boolean) as
    { bytes: Uint8Array; type: string; ext: string }[];

  const row = {
    service, name, contact_pref,
    phone: phone || null,
    email: email || null,
    instagram: str(d.instagram, 60).replace(/^@+/, "") || null,
    preferred_date: isoDate(d.preferred_date),
    alt_date: isoDate(d.alt_date),
    time_pref: TIMES.includes(str(d.time_pref, 12)) ? str(d.time_pref, 12) : null,
    details: str(d.details, 3000) || null,
    placement: str(d.placement, 200) || null,
    size: str(d.size, 100) || null,
    is_adult: typeof d.is_adult === "boolean" ? d.is_adult : null,
    source_ip_hash: ipHash,
  };
  const { data: saved, error } = await sb.from("artem_bookings").insert(row).select("id").single();
  if (error || !saved) return json({ error: "Couldn't save your request. Please text or email us directly." }, 500);

  const paths: string[] = [];
  for (const [i, p] of photos.entries()) {
    const path = `${saved.id}/${i + 1}.${p.ext}`;
    const up = await sb.storage.from("artem-refs").upload(path, p.bytes, { contentType: p.type, upsert: true });
    if (!up.error) paths.push(path);
  }
  if (paths.length) await sb.from("artem_bookings").update({ photo_paths: paths }).eq("id", saved.id);

  await notify(cfg, saved.id, row).catch(() => null);

  return json({ ok: true, id: saved.id, photos: paths.length });
});
