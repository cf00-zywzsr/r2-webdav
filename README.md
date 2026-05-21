# r2-webdav

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/abersheeran/r2-webdav)

Use Cloudflare Workers to provide a WebDav interface for Cloudflare R2.

Currently the server advertises WebDAV Class 1 and Class 2 (LOCK/UNLOCK) support.

## Usage

Change wrangler.toml to your own.

```toml
[[r2_buckets]]
binding = 'bucket' # <~ valid JavaScript variable name, don't change this
bucket_name = 'webdav'
```

Then use wrangler to deploy.

```bash
wrangler deploy

wrangler secret put USERNAME
wrangler secret put PASSWORD
wrangler secret put SESSION_SECRET # recommended for browser login cookies
```

`SESSION_SECRET` is used to sign the browser login session cookie. It is optional: when it is not configured, the Worker falls back to using `PASSWORD` as the signing secret. For better separation between the WebDAV password and browser-session signing key, configure a long random `SESSION_SECRET` value.

Optional browser-session lifetime in seconds can be configured with `SESSION_MAX_AGE`; it defaults to 7 days and is capped at 30 days.

Basic Auth is disabled by default. To allow WebDAV clients or browser Basic Auth credentials, set `ENABLE_BASIC_AUTH=true` in your Worker environment variables.

When deploying from GitHub Actions, add these repository secrets before running the deploy workflow:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `USERNAME`
- `PASSWORD`
- `SESSION_SECRET`

## Browser login

Opening the Worker URL in a browser now shows a dedicated login page instead of the browser's Basic Auth popup. Enter the same `USERNAME` and `PASSWORD` secrets there. WebDAV clients can authenticate with Basic Auth only when `ENABLE_BASIC_AUTH=true`.

The browser UI also supports common object management actions:

- create folders
- delete files or folders
- rename files or folders

Browser sessions use a signed `HttpOnly` cookie, security response headers, and a small per-isolate login failure throttle. Login and file-management form posts use basic same-origin form checks. For public deployments, still consider Cloudflare WAF/rate-limiting rules in front of the Worker.

The browser "logout" button clears the cookie session and returns to the login page. If you previously authenticated through the browser's Basic Auth popup, the browser may continue to cache those credentials until the tab/browser is closed or the site's saved credentials are cleared.

## Development

With `wrangler`, you can run and deploy your Worker with the following commands:

```sh
# run your Worker in an ideal development workflow (with a local server, file watcher & more)
$ npm run dev

# deploy your Worker globally to the Cloudflare network (update your wrangler.toml file for configuration)
$ npm run deploy
```

## Test

Use [litmus](https://github.com/notroj/litmus) to test.

GitHub Actions runs the `basic`, `copymove`, `props`, and `locks` litmus suites against `wrangler dev --local`.
The `http` suite is currently excluded because local Workers runs still time out on the interim `Expect: 100-continue` response check.
