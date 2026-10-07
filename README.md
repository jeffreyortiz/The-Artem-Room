# The Artem Room — website + booking

Live site: https://theartemroom.netlify.app/ (Netlify auto-deploys every push to `main`)

Dashboard: https://theartemroom.netlify.app/bookings.html

No build step. Plain HTML/CSS/JS files, hosted for free on Netlify.

| File | What it is |
|---|---|
| `index.html` | The public site: hero carousel, services, booking request form |
| `bookings.html` | Olie's private bookings dashboard (PIN-protected, not indexed by Google) |
| `deposit.html` | The private page a client opens from their deposit link |
| `img/` | Optimized photos (WebP, several sizes each), share image, app icons |
| `photos/` | Original full-size photos. Not loaded by the site — kept as source files |
| `fonts/` | Self-hosted Grenze Gotisch (faster than Google Fonts) |
| `supabase/functions/` | Copies of the two backend functions (already deployed) |
| `robots.txt`, `sitemap.xml`, `site.webmanifest` | SEO + "Add to Home Screen" files |

---

## Editing the site

Everything is plain HTML inside `index.html`, with comments marking each part.

- **Change a service's text**: edit its `<section class="service">` block. The nav links,
  the chips under the hero, and the booking form's service choices are built from these
  sections automatically.
- **Hero carousel**: one `<a class="slide">` per service near the top. If you change a
  service's tagline, change it in both the slide and the section.
- **Colors**: the `:root` block at the top of the `<style>`.
- **Contact info**: phone/email appear in the booking section, the footer, the
  `SITE` settings at the top of the `<script>`, and the JSON-LD block in `<head>`
  (that block is what Google reads for the business info).

### Adding a photo

Big iPhone photos make the site slow, so don't link the originals. Make WebP copies first
(e.g. squoosh.app, or ask Claude): widths **480, 800 and 1200 px**, named like
`img/nails-chrome-480.webp`, `img/nails-chrome-800.webp`, `img/nails-chrome-1200.webp`.
Then copy an existing `<div class="mini-slide">…</div>` line, swap the file names, and
write a short `alt` description of what's in the photo (this helps Google Images).

---

## How booking works

1. A client fills in the form on the site (service, idea, up to 3 reference photos,
   preferred day/time, contact info). Photos are shrunk on their phone before upload.
2. The form posts to the `artem-book` Supabase Edge Function, which checks it, blocks
   spam (hidden trap field + rate limits), saves it to the `artem_bookings` table and the
   photos to the private `artem-refs` storage bucket.
3. The database sends a push alert to Olie's phone through **ntfy** (free app). The alert
   shows first name, service and day only — never phone/email. Tapping it opens the
   booking in the dashboard.
4. Olie opens `bookings.html` (PIN), sees **New / Upcoming / Past**, texts or calls the
   client in one tap, confirms a date & time (which pre-writes the confirmation text to the
   client in her Messages app), marks done/declined, and keeps private notes.

Backend lives in the existing Supabase project (`one-page-lvl`), in tables prefixed
`artem_`. Row-level security is on with no public policies, so the website's visitors can't
read anything — only the two functions can.

### Deposits

1. On a request in the dashboard, Olie taps **Approve & request deposit**, enters the full
   price (the deposit fills in at 50%, or tap 30% / $50 / $100, or type any amount) and an
   optional note.
2. That creates a private link (`deposit.html?t=…`). **Email link** / **Text link** opens her
   own Mail or Messages app with the message already written, so it comes from her real
   address/number.
3. The client's page shows the amount, her note, the deposit policy, and how to pay:
   - **Card / Apple Pay / Google Pay** through Stripe (once connected). Marked paid
     automatically, and Olie gets a "Deposit paid" alert.
   - **Cash App / Venmo / Zelle** with the amount pre-filled. The client taps "I've sent it",
     Olie gets a "check for a deposit" alert, checks her app, and taps **Mark paid**.
4. Paid requests move back to **New** with a green "paid" tag, ready for her to confirm a time.

Payment handles, the deposit policy text, and Stripe are all set in the dashboard under ⚙︎
Settings. The Stripe key is stored encrypted in Supabase Vault and never shown again; the
payment-confirmation webhook is created automatically when the key is connected.

### Phone alerts setup (once)

Dashboard → ⚙︎ Settings → follow "Phone alerts": install ntfy, subscribe to the topic shown,
tap **Send a test alert**.

### Want real SMS instead of / as well as push?

The `artem-book` function already supports Twilio. Create a Twilio account + number, then
add these rows to `artem_settings`: `twilio_sid`, `twilio_token`, `twilio_from`
(the Twilio number, `+1…`), `owner_sms_to` (Olie's cell, `+1…`). Costs roughly a cent per text
plus the number's monthly fee, and US texting needs Twilio's A2P/toll-free registration.

### PIN

Change it any time in the dashboard Settings. Changing it signs out every other device.
Five wrong tries locks sign-in for 15 minutes.

---

## Testing changes before they go live

Work on a branch (e.g. `booking-test`), never straight on `main` (every push to `main` goes live).
Preview a branch at:

```
https://raw.githack.com/jeffreyortiz/The-Artem-Room/<branch>/index.html
```

(Netlify can also build a preview link per branch: Site configuration → Build & deploy →
Branches and deploy contexts → "All".) When it's right, merge into `main` and Netlify
publishes it in under a minute.

## SEO checklist after going live

- Add the site to Google Search Console and submit `sitemap.xml`.
- Make a free Google Business Profile (biggest win for "tattoo near me" searches) and link
  this site from it and from Instagram.
- A custom domain (e.g. `theartemroom.com`) looks more professional and ranks better than a
  netlify.app address; Netlify can connect one (Domain management). If you add one, find &
  replace `https://theartemroom.netlify.app/` in `index.html`, `robots.txt` and
  `sitemap.xml`, and update `dashboard_url` in the `artem_settings` table.
