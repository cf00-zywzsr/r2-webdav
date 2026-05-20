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

Optional browser-session lifetime in seconds can be configured with `SESSION_MAX_AGE`; it defaults to 7 days and is capped at 30 days.

## Browser login

Opening the Worker URL in a browser now shows a dedicated login page instead of the browser's Basic Auth popup. Enter the same `USERNAME` and `PASSWORD` secrets there; WebDAV clients can still authenticate with Basic Auth.

The browser UI also supports common object management actions:

- create folders
- delete files or folders
- rename files or folders

Browser sessions use a signed `HttpOnly` cookie, basic same-origin form checks, security response headers, and a small per-isolate login failure throttle. For public deployments, still consider Cloudflare WAF/rate-limiting rules in front of the Worker.

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
