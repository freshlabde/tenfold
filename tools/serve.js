// Minimal static server for the tenfold PWA, local development and the
// Playwright test run. Deliberately tiny: no dependencies, no directory
// listing, no upload, static files only - there is no user data on this
// server, ever (zero-knowledge design).
//
// Path resolution: the app in web/ is served at the root (so the PWA gets
// scope "/" on the public domain). Repo paths like /tests/... and /design/...
// still resolve as a fallback so the Playwright suite and the design previews
// keep working unchanged.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const WEB = join(ROOT, "web");
const PORT = Number(process.env.PORT || 7710);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
};

const SECURITY_HEADERS = {
  // Strict CSP: own origin only. No external source can ever load, which is
  // one of the walls against the XSS-equals-total-loss scenario.
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
    "connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

async function tryRead(base, rel) {
  const file = join(base, rel);
  if (!file.startsWith(base)) return null; // path traversal guard
  try {
    return await readFile(file);
  } catch {
    return null;
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let rel = normalize(decodeURIComponent(url.pathname));

  // The app is also reachable under the /tenfold prefix
  // (kairatools.com/tenfold via the tunnel path rule). Redirect the bare
  // prefix to the trailing-slash form so relative asset paths resolve,
  // then strip the prefix - the file layout below is identical.
  if (rel === "/tenfold") {
    res.writeHead(301, { Location: "/tenfold/" }).end();
    return;
  }
  if (rel.startsWith("/tenfold/")) rel = rel.slice("/tenfold".length);

  if (rel === "/" || rel === "/index.html") rel = "/index.html";

  // App files first (served at the root), then repo files (tests, design).
  // The strict CSP applies to the app only - the design previews and test
  // fixtures under the repo fallback use inline styles by design.
  let body = await tryRead(WEB, rel);
  let fromApp = body !== null;
  if (body === null) {
    body = await tryRead(ROOT, rel);
  }
  if (body === null) {
    res.writeHead(404).end("not found");
    return;
  }
  res.writeHead(200, {
    "Content-Type": TYPES[extname(rel)] || "application/octet-stream",
    "Cache-Control": "no-store",
    ...(fromApp ? SECURITY_HEADERS : {}),
  });
  res.end(body);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`tenfold server on http://127.0.0.1:${PORT}`);
});
