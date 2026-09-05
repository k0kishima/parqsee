# The Parqsee site

The product page, the **privacy policy** and the **support page** — the two
URLs App Store Connect requires before the app can be submitted (#7, #16).
Plain static HTML: no build step, no framework, and no external request of any
kind, because the privacy policy claims the app talks to nothing and a page
that pulls a font from a CDN to say so would be a poor way to put it.

```
site/
├── index.html          en: product page
├── privacy.html        en: privacy policy   (App Store Connect: Privacy Policy URL)
├── support.html        en: support + FAQ    (App Store Connect: Support URL)
├── ja/                 the same three in Japanese
├── style.css           one stylesheet, light and dark
└── img/
    ├── icon.png            from backend/icons/icon.png
    └── screenshot-*.png    from `pnpm shots` (see below)
```

The app ships English and Japanese, so the listing declares both and each has
its own pair of URLs:

| | English | Japanese |
|---|---|---|
| Support URL | `…/parqsee/support.html` | `…/parqsee/ja/support.html` |
| Privacy Policy URL | `…/parqsee/privacy.html` | `…/parqsee/ja/privacy.html` |

## Deploying

`.github/workflows/pages.yml` publishes this folder on every push to `main`
that touches it. It needs two manual steps, once: **Settings → Pages → Source =
"GitHub Actions"**, and **Custom domain = `parqsee.fuji.llc`**. The result is
served at
`https://parqsee.fuji.llc/`: `site/CNAME` names the subdomain, and the DNS
side is one `CNAME` record at the registrar (`parqsee` -> `k0kishima.github.io.`).
Without it the repository's Pages would be served under the user site's own
custom domain, at `https://www.fuji.llc/parqsee/` — setting the subdomain
replaces that path. Leave **Enforce HTTPS** off until GitHub has issued the
certificate for the subdomain.

## Preview locally

```sh
python3 -m http.server 8000 --directory site   # then open http://localhost:8000/
```

## Screenshots

`img/screenshot-<lang>-<theme>.png` are the `viewer` shots from
`scripts/qa/e2e/shots.mjs` — the real app against the real backend, not a
mockup — scaled to 1600px wide:

```sh
cd scripts/qa/e2e && pnpm shots
cd ../../.. && for f in en-light en-dark ja-light ja-dark; do
  sips -Z 1600 "scripts/qa/e2e/out/shots/demo/$f-viewer-2560x1600.png" \
       --out "site/img/screenshot-$f.png"
done
```

## After the app is approved (#16)

- Replace the `badge-slot pending` span in `index.html` and `ja/index.html`
  with Apple's official *Download on the Mac App Store* badge, linking to the
  app's page. The badge artwork has to come from Apple's marketing resources;
  it may not be redrawn.
- Add the same badge to the top of the repository `README.md`.
- Swap the *Coming Soon…* label on the Parqsee card in the corporate site
  (`k0kishima/k0kishima.github.io`, the Products section of `index.html`) for
  the App Store link.
