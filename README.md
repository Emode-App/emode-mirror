# Emode Mirror

A try-on mirror for the **Proto Luma**. Someone walks up, scans a QR code, sends
clothes from their phone — screenshots or product links — then steps back. The
Luma takes their photo and shows them wearing what they picked, life-size.

Part of [Emode](https://www.emode.style). Same AI try-on engine as the app,
pointed at a person standing in front of a mirror instead of a profile photo.

---

## How it fits together

```
 Proto Luma (kiosk)             visitor's phone
 https://mirror.emode.style/?device=KEY     https://mirror.emode.style/s/<visit>#<token>   ← from the QR code
        │                                │
        └──────────────┬─────────────────┘
                       ▼
         Supabase edge function  `mirror`          ← the only thing with database access
                       │
        ┌──────────────┼──────────────────┐
   mirror_* tables   `mirror` bucket    Gemini image model
   (visits, pieces,  (private; signed   (same model as the
    looks, devices)   URLs only)         Emode app)
```

**Proto apps are web apps.** There is no native SDK: a Proto opens a hosted URL
through its App Launcher, renders it at **2160 × 3840 portrait** on a Luma, and
gives the page the touchscreen, camera and mic **without a permission prompt**.
So this is a Next.js site. Source: Proto's developer docs, *App Development*.

| Path | What |
|---|---|
| `/` | The mirror. Needs `?device=<key>` (remembered after first launch). |
| `/calibrate` | Hardware check — open this on the Luma first. |
| `/s/[visit]` | The phone page the QR code opens. |
| `supabase/functions/mirror` | The whole backend: one function, action-based. |
| `supabase/migrations` | Schema. Already applied to the live project. |
| `scripts/smoke.mjs` | End-to-end API check. `--generate` runs one real look. |
| `scripts/register-device.mjs` | Make a key for a new screen. |

## Where it runs

**https://mirror.emode.style** — Vercel project `emode-mirror` (team *logical*),
deploying from `main` on every push. The `*.vercel.app` URLs sit behind Vercel's
login; the Luma and visitors' phones use the custom domain.

## Running it

```bash
npm install
npm run dev                     # http://localhost:3000
```

Open `http://localhost:3000/?device=<DEV_DEVICE_KEY>`. The dev key is in
`.devices.local` on Brandon's machine — ask for it; it's not in git. It's a
separate device from the Luma with its own daily limit, so testing on a laptop
webcam never spends the Luma's allowance.

To pair a real phone with a laptop, the phone has to reach the laptop — use
the deployed site, or a tunnel. `localhost` in a QR code only works on the
laptop itself.

```bash
node scripts/smoke.mjs                                    # API checks, no AI call
node scripts/smoke.mjs --link <product url> --generate    # + one real generation
```

You don't need any secrets to work on the app. The function holds the Gemini key
and the service role; the browser only ever sends the public anon key.

## Putting it on the Luma

1. **Calibrate first.** Open `https://mirror.emode.style/calibrate?device=<LUMA_KEY>` on the
   Luma through the [Proto App Launcher](http://protoapps.protohologram.com/). It
   answers the three things Proto's docs don't:
   - **Which colour reads as empty space** — black or white. The mirror uses it
     as its background *and* asks the AI to put the person on it, so they look
     like they're standing inside the display. Defaults to black; this is a guess
     until someone looks at the real panel.
   - **Which camera.** A Luma also reports a capture device on its HDMI 2 port;
     inputs named HDMI or RealSense are skipped (Proto's own recommendation). If
     it still picks wrong, choose here.
   - **Rotation**, if the camera is mounted on its side.

   Settings save on that screen.
2. **Launch URL:** `https://mirror.emode.style/?device=<LUMA_KEY>`.
3. When submitting to Proto, ask for **Include Serial Number** (adds
   `protoSerialNumber`, recorded per device) and **Pinch to Zoom: off**.

## Privacy — the rules the code enforces

- Nobody is photographed without tapping a consent screen that says what
  happens: one photo, sent to an AI image service, deleted at the end. 18+.
- **The photo is deleted the moment the visit ends** — Finish, or 90 seconds of
  nobody touching the screen (3 minutes while pairing), with a 15-second warning.
- **Looks stay downloadable on the visitor's phone for 60 minutes**, then
  everything from the visit is deleted. A visit nobody ends is swept after 20
  minutes idle.
- Visitors are anonymous. No Emode account, no `auth.users` row.
- The phone's access token rides in the URL **fragment**, which browsers never
  send to a server or in a Referer.
- All media lives in a private bucket; the function hands out 30-minute signed URLs.

## Limits

Per visit: 12 pieces, 6 per look, 12 looks. Per device per day: set on the
device row (Luma: 150, dev laptop: 40). A look takes about **20–30 seconds**.

## Product links: what to expect

Links pull the product photo from the store page. Tested:

| Works | Blocked |
|---|---|
| Uniqlo, Nike, Everlane | Zara, H&M, SSENSE (refuse automated requests), Gap (photo loads by JavaScript) |

**Screenshots work from every store**, so the phone leads with them and says so
when a link fails.

## Known gaps

- **Identity preservation is untested on a real face.** The pipeline is proven
  end to end with a drawn mannequin, which shows the plumbing, the 9:16 full-body
  framing and garment accuracy — but a faceless figure has no identity to keep.
  First real test: a consenting person at the Luma.
- Store photos often show the garment *on a model*. Early testing returned the
  store's model instead of the visitor; the prompt now forbids that explicitly.
  Watch for it.
- The kiosk polls for updates every 1.5–2s rather than using Realtime — more
  forgiving of venue Wi-Fi. Fine at this scale.
- No admin dashboard yet. Devices are registered with a script and SQL.

## Next

1. Real-face testing on the Luma; tune the prompt.
2. `emode.style/mirror` landing + retailer inquiry page (website repo — see
   `docs/website-handoff.md`). The `mirror_inquiries` table already exists.
3. Animate a look into a short video (Runway Aleph) — a "bring it to life" button
   on the result screen.
4. Device admin: register screens, see usage, set branding per retailer.
5. Real-time try-on.
