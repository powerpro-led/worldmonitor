# Patched dependencies

Applied automatically by `patch-package` via the `postinstall` script in
`package.json`. Do not hand-edit files under `node_modules/` — edit them, then
regenerate the patch with `npx patch-package <pkg>` so the change survives the
next `npm install`.

## `@nitric/sdk@1.4.2` — remove a double-decode of HTTP query params

`HttpContext.fromHttpRequest` (`lib/index.js`, ~line 13720) ran
`decodeURIComponent()` over every query-param value. The Go membrane has
**already** decoded them by the time they cross the gRPC boundary, so this was a
second decode of an already-decoded value.

Two failure modes, both fixed by dropping the redundant call:

1. **Crash (loud).** A value containing a literal `%` — extremely common in
   financial headlines ("Gold jumps 4%") — is not a valid percent-escape, so the
   second `decodeURIComponent` threw `URIError: URI malformed`. The throw happens
   inside the SDK *before any application middleware runs*, so the request died
   with a bare `500` and **no CORS headers** — which browsers report as a CORS
   error, sending you looking for a CORS misconfiguration that isn't there.
2. **Silent corruption (worse).** A value whose text legitimately contains a
   percent-escape got decoded a second time: a query param carrying a URL, or any
   string containing `%20`/`%26`, arrived at the handler mangled rather than
   erroring.

Evidence it is genuinely a double decode, not a needed decode:

* In the same function, **headers and path params are not decoded** — only query
  params were. If the membrane delivered raw percent-encoded values, all three
  would need decoding.
* Measured on the wire: a request for `?title=a%2520b` reached the handler as
  `a b` (two decodes). After the patch it arrives as `a%20b`, while an ordinary
  `?title=x%20y` still arrives correctly decoded as `x y` — confirming the
  membrane, not the SDK, is what performs the (single, correct) decode.

The fix makes the query reducer identical to the `params` reducer three lines
below it.

### Not patched: the same pattern in `WebsocketNotificationContext`

`lib/index.js` ~line 15565 decodes websocket connection query params the same
way. It is almost certainly the same bug, but this repo does not use Nitric
websockets, so the membrane's behaviour on that path was never verified here.
Left alone deliberately — verify before patching it.

Upstream: `@nitric/sdk@1.4.2` is the latest published version as of 2026-08-20,
so there is no newer release to upgrade to instead.
