# Video Explorer for phones

The same library, on Android, with **no PC involved**. This is a static web app
that talks to Microsoft Graph directly from the browser, so it works anywhere
there is internet — the desktop app does not have to be running, or even awake.

Install it from Chrome's **Add to Home screen** and it launches like a native
app, full screen, with its own icon.

## Why this and not a Kotlin app

Your phone has no OneDrive *sync folder*, so there is nothing local to explore —
an Android version is a Graph client either way. And Graph's download URLs are
pre-authenticated and range-capable, verified against a 105 MB cloud-only file:

```
status    : 206     (mid-file range honoured)
length    : bytes 1000000-1000999/104577739 | video/mp4
got bytes : 1000    with no Authorization header
hydrated? : no      - the placeholder was never touched
```

That is all a `<video>` element needs. A native app would buy offline caching
and background downloads; it would also need an Android SDK, Gradle and a JDK,
and would share no code with what already exists.

## What works

- Sign in with the same Microsoft account, once — the session refreshes itself
- Folders above videos, breadcrumb navigation, Android back button walks the trail
- Thumbnails from Graph, so nothing is decoded on the phone
- **Drag across a thumbnail to scrub it.** A phone has no hover, and position
  maps to time better than a timed slideshow does: your finger is the timeline
- **Long-press to select**, then tap to add more. The bar that appears rates,
  tags or moves everything selected at once; **All** takes whatever the filter
  is showing
- **Move…** opens a folder picker. Graph moves an item by re-parenting it, so
  nothing is copied and a 4 GB file moves as fast as a small one — but only
  *within* one drive. Your own folders and a folder shared from another account
  are separate drives, and that boundary is refused by name rather than faked
  with a copy-and-delete that could half-fail partway through a large file
- Tap ▶ to watch, streamed and seekable
- Ratings and tags, read from and written to the **same `library.json`** the
  desktop app uses, so a rating set on the PC shows up here and vice versa
- Filter by name or `#tag`

Nothing is written to the phone's storage except the app shell itself.

## Live

```
https://travanixlabs.github.io/video-explorer-mobile/
```

Served from `travanixlabs/video-explorer-mobile` on GitHub Pages — static files
only, no server, nothing of yours stored there.

**This folder is that repository.** There is no separate deploy copy to keep in
step, so redeploying is just:

```
git add -A && git commit -m "what changed" && git push
```

Pages rebuilds within a minute or two. `core.autocrlf` is off here on purpose:
the committed files are LF, and leaving it on marks every one of them modified
the moment the repo is checked out on Windows.

Note this is a git repository nested inside the `apps` working tree. Nothing in
`apps` is tracked today, but if that ever changes, add `video-explorer/mobile/`
to its `.gitignore` — otherwise a `git add .` there captures this folder as a
submodule pointer rather than files.

## Setup

**1. Register the redirect URIs.** In the Azure portal, open the app
registration (client `ca1688c6-…`) → **Authentication** → **Add a platform** →
**Single-page application**, and add both:

```
https://travanixlabs.github.io/video-explorer-mobile/
http://localhost:5173/
```

The first is the hosted app; the second keeps `node serve.js` working for
development. Both must be the **Single-page application** platform.

The **Single-page application** platform matters. A "Web" platform returns the
token but sends no CORS headers, so the browser is not allowed to read it — the
sign-in appears to succeed and then fails silently.

**2. Check the permission.** The phone writes ratings back, so it needs
**Files.ReadWrite** (delegated) — the desktop app only ever asked for
`Files.Read`. You already have several `Files.ReadWrite*` entries granted.

**3. Run it.**

```
node serve.js
```

`http://localhost` counts as a secure context, so service workers, `crypto.subtle`
and the whole PKCE flow behave exactly as they will on a real HTTPS host — no
certificate needed to test the real thing.

## Getting an APK

Two routes, and the first one is probably the one you want.

**Chrome makes the APK for you.** On Android, "Install app" from Chrome's menu
does not create a bookmark — it builds and installs a **WebAPK**, a real signed
Android package minted by Google's servers from the manifest. It gets a launcher
icon, an entry in the app drawer, its own task in the recents switcher, and no
browser UI. Uninstall is the normal Android uninstall. Nothing to build, nothing
to sideload, and updates arrive the moment the site changes.

Chrome only offers it when the site is served over **HTTPS**, has a service
worker with a fetch handler, and a manifest with a raster icon of at least
192px. All three are in place — `make-icons.js` generates the PNGs, since an SVG
alone does not satisfy the icon rule.

**Bubblewrap builds a real .apk file.** If you want a file you can sideload,
keep, or put on the Play Store, a Trusted Web Activity wraps the same site in an
APK you sign yourself:

```
npx @bubblewrap/cli init --manifest https://your-host/manifest.webmanifest
npx @bubblewrap/cli build
```

It needs a JDK and the Android SDK build-tools — neither is on this machine, and
Bubblewrap offers to download roughly 1.5 GB of them on first run. The output
also needs `/.well-known/assetlinks.json` on the host, tying your signing key to
the domain; without it Android shows a URL bar over the app.

Both routes need the site on HTTPS first, so hosting comes before either.

## Hosting it for the phone

A phone cannot reach `localhost` on your PC, and a PWA needs HTTPS to install,
so it needs a real origin. It is seven static files with no build step and no
server-side code, so any of these work:

| Host | Cost | Notes |
| ---- | ---- | ----- |
| GitHub Pages | free | this repo already exists; push `mobile/` and enable Pages |
| Cloudflare Pages | free | drag-and-drop the folder, custom domain if you want |
| Azure Static Web Apps | free tier | same tenant as the app registration |

Whichever you pick, add that origin's URL as a second SPA redirect URI.

**Your files never touch the host.** It serves HTML, CSS and JavaScript; the
browser then talks to Microsoft directly. Tokens live in the phone's
`localStorage` and are never sent anywhere but Microsoft.

## Files

```
index.html              layout
app.js                  browsing, scrubbing, player, ratings
auth.js                 PKCE sign-in — no MSAL, four fetches and a redirect
graph.js                Graph client: listing, streaming, library.json
styles.css              dark theme, safe-area aware
sw.js                   caches the app shell only, never video or signed URLs
manifest.webmanifest    home-screen install
serve.js                local dev server
```

## Known gaps

- Paging: a folder loads all its children at once. Fine for hundreds, not for
  folders in the thousands — those need incremental rendering.
- Scrubbing streams real bytes, so it costs mobile data. A wifi-only guard is
  not built yet.
- Move is the only file operation. Delete and rename are the same kind of Graph
  call, but destructive actions on a phone deserve more care than a tap.
- Moves have not been exercised against real files — this machine's token is
  `Files.Read` only, so the write path could not be tested from the desktop
  side. Try it on something you do not mind first.
- Cross-drive moves are refused rather than implemented. Doing them properly
  means Graph's asynchronous copy plus a delete, with progress polling and a
  recovery path if the delete fails after the copy succeeds.
