# DailyDairy download page

A page where customers download the DailyDairy Android app. The APK lives in a **private** Cloudflare R2 bucket
(`dailydairy-downloads`). The page asks the Worker for a signed link that works for 15 minutes, so the file is never
public and a link can't be passed around forever. Downloads resume on flaky mobile connections.

There is one app for every dairy: after signing in, the customer's PIN code decides which dairy delivers to them.

- `public/index.html`: the page.
- `src/index.ts`: the Worker (`/api/link`, `/api/latest`, `/apk`).
- `wrangler.jsonc`: the R2 binding (add a custom domain there when you have one).

## One-time setup

1. Turn on R2 in the Cloudflare dashboard (R2 Object Storage).
2. `npm install`
3. `npx wrangler r2 bucket create dailydairy-downloads`
4. `npm run deploy`
5. Set the signing secret (any long random string): `npx wrangler secret put DOWNLOAD_SECRET`

Live at `https://dailydairy-download.prathviholla67.workers.dev` once deployed. The website's "Download the app"
buttons point here (`DOWNLOAD_URL` in the website's `src/config.ts`).

## Publishing a new app version

Build the APK in `Milkdelivery application` (for example `npm run apk:cloud`), download it, then:

```bash
npm run upload-apk -- "C:\path\to\DailyDairy.apk"
```

The page picks up the new size and date straight away. Nothing else to deploy.
