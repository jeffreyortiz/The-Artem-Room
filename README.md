# Studio Storefront Template

Two self-contained HTML files. No build step, no dependencies to install —
open either one in a browser and it works. Everything client-specific
(name, services, colors, copy) lives in one `BUSINESS` object near the
bottom of each file's `<script>` tag.

- **`storefront.html`** — full version with booking-aware CTAs (per-service
  "Book now" vs "Request a consultation", deposit/form badges). Use this
  once a booking backend is wired up.
- **`storefront-portfolio.html`** — same look, no booking logic. Every
  service just says "Inquire" and points at contact info. Use this *now*,
  while your wife is showing work and booking isn't live yet.

Both are one file each — HTML, CSS, and JS all inline. That's intentional:
it makes them trivial to drop into any static host with zero config.

---

## Editing a site (per client)

Everything you'll touch for a new client is in one place: the `BUSINESS`
object near the bottom of the `<script>` tag.

```js
const BUSINESS = {
  name: "Studio",
  address: "123 Main Street · Your City",
  contact: "hello@yourstudio.com · (000) 000-0000",
  services: [ /* ...5 service objects... */ ]
};
```

To rebrand for a new client:

1. Change `name`, `address`, `contact`.
2. Edit/add/remove entries in `services` — each needs `id`, `name`, `tag`
   (one-liner under the hero title), `desc` (longer blurb), and `color`.
   Fewer or more than 5 services works fine; the carousel and nav build
   themselves from the array.
3. In `storefront.html` only: set `flowType` to `"direct"` or
   `"consultation"` per service, and `requiresForm` / `requiresDeposit`
   booleans — these drive the badges and CTA label automatically.
4. Swap the color palette in the `:root` CSS block (`--c-tattoo`,
   `--c-piercing`, etc. — rename/repurpose these per service).
5. Replace the placeholder line-art in the `art()` JS function with real
   photos once you're hosting somewhere that allows remote images —
   either `<img src="...">` elements or `background-image` in CSS.
6. Drop a background design (like your cyber-sigil piece) into the empty
   `.bg-layer` div — it's a fixed, full-page layer sitting behind
   everything, already wired up and just waiting for a
   `background-image`.

---

## Suggested repo layout for multiple clients

```
storefront-template/
├── base/
│   ├── storefront.html              ← the master booking template
│   └── storefront-portfolio.html    ← the master portfolio template
├── clients/
│   ├── wife-studio/
│   │   ├── storefront.html          ← copied from base, BUSINESS edited
│   │   └── storefront-portfolio.html
│   └── client-2/
│       ├── storefront.html
│       └── storefront-portfolio.html
└── README.md
```

Keep `base/` untouched as your starting point. For each new client, copy
`base/` into `clients/<name>/` and only edit the `BUSINESS` object, the
color variables, and the artwork. This keeps every client's site a clean
diff from the template, so improvements you make to the template later
(a layout fix, a new section) are easy to port into existing client sites
by hand or with a merge tool.

Deploying any single file: drag-and-drop onto Netlify, or push to a repo
and turn on GitHub Pages / Vercel / Cloudflare Pages — all of them serve
a static `.html` file with no configuration needed.

---

## Adding real booking

The template's CTAs already point at `#book` (an anchor to the footer /
booking panel). Wiring up a real backend is about picking a platform and
routing each service's CTA to the right place — you don't need to touch
layout code for this.

**1. Pick a booking platform based on what each service needs:**

| Need | Good fit |
|---|---|
| Simple direct booking (nails, hair) | Square Appointments, Fresha — both free at small scale, embeddable widget or hosted booking page |
| Consultation + intake form + deposit (tattooing, piercing) | Boulevard or Vagaro (built for studios, handle consult requests + deposits natively), *or* a lighter stack: Tally/Jotform for the intake form + a Stripe Payment Link for the deposit, with you manually confirming and booking the slot afterward |

**2. Get an embed snippet or booking link** from whichever platform you
pick — they all provide either a `<script>` embed or a hosted URL
(e.g. `https://book.squareup.com/appointments/your-shop`).

**3. Route each service's CTA:**
   - Direct-booking services (`flowType: "direct"`): set `bookingUrl` to
     the platform's booking link (or an anchor to a widget you've
     embedded in the `.booking-panel` section).
   - Consultation services (`flowType: "consultation"`): set `bookingUrl`
     to your intake form link instead (Tally/Jotform/the platform's own
     consult-request form). The deposit request typically happens *after*
     you review the consult, not before — so this is usually a manual
     step until you're doing enough volume to automate it.

**4. Replace the `.booking-panel` placeholder** with the actual embed —
either paste the platform's `<script>`/`<iframe>` snippet into that div,
or leave it as a styled link-out button if the platform doesn't offer an
embeddable widget.

Start manual (form + you following up) if you're not sure yet — it's zero
cost and tells you which parts are actually worth automating before you
commit to a platform's monthly fee.
