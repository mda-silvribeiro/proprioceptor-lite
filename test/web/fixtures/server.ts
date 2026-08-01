// A ~50-line stand-in for the Workers static-asset handler: serves web/ over
// loopback with real MIME types, the SPA fallback that wrangler.jsonc configures
// (`not_found_handling: single-page-application`), and — importantly — the exact
// Content-Security-Policy from docs/CONTRACTS.md. Serving the real CSP means any
// inline script or style regresses into a console error, which the harness turns
// into a test failure.

import { createServer } from "node:http";
import { readFileSync } from "node:fs";

const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; " +
  "img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";

const MIME = new Map<string, string>([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".ico", "image/x-icon"],
  [".json", "application/json; charset=utf-8"],
]);

/** Only flat filenames: every asset in web/ is top-level. */
const ASSET = /^\/([A-Za-z0-9._-]+\.(?:html|js|css|svg|ico|json))$/;

export interface StaticServer {
  readonly origin: string;
  stop(): Promise<void>;
}

function contentTypeOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return MIME.get(dot === -1 ? "" : name.slice(dot).toLowerCase()) ?? "application/octet-stream";
}

/**
 * @param webRoot absolute path of the web/ directory, with a trailing slash
 */
export async function startStaticServer(webRoot: string): Promise<StaticServer> {
  const server = createServer((request, response) => {
    const target = (request.url ?? "/").split("?")[0] ?? "/";
    const match = ASSET.exec(target);
    const name = match?.[1] ?? "index.html";

    let body: Uint8Array;
    try {
      body = readFileSync(webRoot + name);
    } catch {
      // A missing asset is a 404; a missing *page* would be the SPA fallback,
      // and that already resolved to index.html above.
      response.statusCode = 404;
      response.setHeader("Content-Type", "text/plain; charset=utf-8");
      response.end("not found");
      return;
    }

    const contentType = contentTypeOf(name);
    response.statusCode = 200;
    response.setHeader("Content-Type", contentType);
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    if (contentType.startsWith("text/html")) response.setHeader("Content-Security-Policy", CSP);
    response.end(body);
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("static fixture server did not report a port"));
        return;
      }
      resolve(address.port);
    });
  });

  return {
    origin: `http://127.0.0.1:${port}`,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
