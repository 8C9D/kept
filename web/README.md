# web/ - the Kept web client

Wave 7 (spec §7A): sign-in, the receipts table with inline editing and
filters, detail with the image beside the fields, the confirm queue, the
multi-file backlog upload, and the year-end export. Built and gated against
local dev 2026-08-21 (`docs/gates/wave-7.md`); production sign-in waits on
the Apple Services ID below.

## Develop

```sh
# server/, with docker compose up -d already running:
npm run dev                     # the API, CORS-granting http://localhost:5173
npm run dev:session-token       # prints a session token for the dev sign-in

# web/:
npm install
npm run dev                     # Vite on 5173 (strictPort - the API's grant names it)
npm test                        # vitest over the client's logic
npm run build                   # tsc + production bundle into dist/
```

The dev build signs in by pasting the token; the production bundle carries
Sign in with Apple and none of the dev affordance (asserted against the
built bundle at the gate, wave-6 style).

## The static page that already ships

`public/privacy/index.html` is the privacy policy the App Store record
requires, served at `/privacy` in dev and copied verbatim into `dist/privacy/`
by the build. Its contents mirror the published App Store privacy label - if
the label ever changes, this page changes in the same commit. One
placeholder is deliberate: the contact address, which the owner fills in before
the page goes live.

## Putting it on keptapp.net (the owner's, in this order)

1. **Apple Services ID** (portal → Identifiers → Services IDs): create
   `com.arthurzhang.kept.web` (the id `SignIn.tsx` carries), enable Sign in
   with Apple grouped with the app id, register domain `keptapp.net` and
   return URL `https://keptapp.net/` , and complete Apple's domain
   verification.
2. **Fly secrets:** `fly secrets set APPLE_WEB_CLIENT_ID="com.arthurzhang.kept.web" WEB_ORIGIN="https://keptapp.net"` -
   without these the API neither accepts web sign-ins nor answers the
   browser at all (exact-origin CORS, no origin configured means none
   granted).
3. **R2 bucket CORS on `kept`** (dashboard → R2 → kept → Settings → CORS):
   allow origin `https://keptapp.net`, methods `PUT` and `GET`, header
   `Content-Type`. The browser PUTs images to presigned URLs directly, and
   unlike MinIO's permissive default, R2 answers a cross-origin PUT only if
   the bucket says so. Without this rule every web upload fails its
   preflight while iOS keeps working (URLSession sends no Origin).
4. **Build and deploy:** `npm run build`, then Cloudflare dashboard →
   Workers & Pages → Create → Pages → Direct upload → upload `web/dist`,
   project `keptapp-web`. Add the custom domain `keptapp.net` (and `www` if
   wanted). ⚠ Leave the `api` DNS record alone; only the apex/`www` belong
   to Pages.
5. The privacy policy URL for App Store Connect is then
   `https://keptapp.net/privacy` (wave-6 §3 step 18) - fill the contact
   address in `public/privacy/index.html` and rebuild before the upload
   that goes live.

Re-uploading `dist/` is the whole deploy story. The API address is baked
into the bundle (`https://api.keptapp.net`, same ruling as the iOS
ServerEnvironment) - moving the API means rebuilding, deliberately.
