# Handoff: `emode.style/mirror` (website repo)

Paste this into the session that works on the **Emode-App/emode** website. The
mirror itself lives in **Emode-App/emode-mirror**; the website only needs to
market it and collect retailer interest. Nothing in the website talks to a
Luma.

---

Add two pages to the website for **Emode Mirror**, a holographic try-on mirror
that runs on Proto Luma displays. A visitor scans a QR code on the Luma, sends
clothes from their phone (screenshots or product links), steps back, and sees
themselves wearing them, life-size.

### 1. `/mirror` — landing page

Audience: shoppers who saw one, and retailers who might want one.

- Hero: "Your wardrobe. Larger than life." Sub: try on anything, without
  changing — on a life-size holographic mirror.
- How it works, three steps: **Scan** the code on the mirror → **Send** clothes
  from your phone (screenshots from any store, or product links) → **Step back**
  and see yourself wearing them.
- Privacy, stated plainly — these are true and enforced by the code: one photo,
  deleted when you finish; looks kept on your phone for an hour, then deleted;
  no account needed.
- Two CTAs: **Bring Emode Mirror to your store** → `/mirror/business`, and a
  secondary "Find a mirror" (can say "Pilot locations coming soon" for now).
- Any imagery of the mirror must be clearly labelled as a concept until there
  are real photos of the Luma running it.
- Add **Mirror** to the main navigation.

### 2. `/mirror/business` — retailer inquiry form

Position it as software for Proto displays a retailer already owns: "Turn your
Proto into an AI fitting room." Points: bring-your-own-garment (any store's
clothes), native touchscreen experience, multi-piece outfits, links back to the
products.

**Do not publish prices yet.**

The form writes to a table that **already exists** in the live Supabase project
(`scvvbjheyfnxlsiiozta` — the one the app uses, not the other one):

```ts
await supabase.from('mirror_inquiries').insert({
  business_name,   // required, ≤200
  contact_name,    // required, ≤200
  email,           // required, must contain @
  phone,           // optional, ≤40
  industry,        // optional: retail | luxury | events | hospitality | other
  device_count,    // optional integer
  proto_model,     // optional: Luma | Epic | M | M2 | "Don't own one yet"
  use_case,        // optional, ≤4000
  wants_demo,      // boolean
  source: 'website/mirror/business',
});
```

It's **insert-only** for the anon key: the website can submit, but nobody can
read submissions back with that key. Don't add a `.select()` after the insert —
it will fail. Read inquiries in the Supabase dashboard (or ask for an admin
view later).

Show a clear success state ("We'll be in touch within two business days") and
handle the error state.

### Not in scope for the website

The QR-code pairing page is **not** a website page — it's `/s/[visit]` on the
mirror's own domain (planned `mirror.emode.style`), served by the mirror repo.
