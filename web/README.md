# web/

Still the placeholder for the eventual web client (spec §11, wave 7).
What exists today is one static page:

- `privacy/index.html` — the privacy policy the App Store record requires.
  No build step, no framework, nothing to install. Its contents mirror the
  published App Store privacy label (six data types, all linked to identity,
  none used for tracking) — if the label ever changes, this page changes in
  the same commit. One placeholder is deliberate: the contact address, which
  the owner fills in before the page goes live.

## Putting it on keptapp.net (instructions only — deploying is the owner's)

The zone is already on Cloudflare, so Cloudflare Pages is the shortest path
and costs nothing at this size:

1. Cloudflare dashboard → Workers & Pages → Create → Pages → Direct upload.
   Upload the `web/` directory (Pages serves `privacy/index.html` at
   `/privacy`). Name the project `keptapp-web`.
2. Add the custom domain `keptapp.net` (and `www` if wanted) to the Pages
   project. Cloudflare wires the DNS itself since the zone is local —
   ⚠ leave the `api` record alone; only the apex/`www` belong to Pages.
3. The privacy policy URL for App Store Connect is then
   `https://keptapp.net/privacy` — paste it in App Information → Privacy
   Policy URL before submission (wave-6 §3 step 18).

Re-uploading the directory is the whole deploy story until the real web
client exists; if the web client later takes over the domain, it inherits
`/privacy` as a route it must keep serving.
