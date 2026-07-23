import { createFileRoute } from "@tanstack/react-router";
import {
  normalizeUrl,
  pickIdentity,
  rewriteCss,
  rewriteHtml,
  sanitizeUpstreamHeaders,
  upstreamHeaders,
} from "@/lib/proxy-core";

const HOP_BY_HOP = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authorization",
  "proxy-authenticate",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "cookie",
  "origin",
  "referer",
  "accept-encoding",
]);

async function handle(request: Request, splat: string) {
  if (!splat) return new Response("missing url", { status: 400 });
  let target: string;
  try {
    target = decodeURIComponent(splat);
  } catch {
    return new Response("bad url", { status: 400 });
  }
  target = normalizeUrl(target);

  let targetUrl: URL;
  try {
    targetUrl = new URL(target);
  } catch {
    return new Response("bad url", { status: 400 });
  }

  // Preserve original query string appended after the encoded target.
  const incoming = new URL(request.url);
  incoming.searchParams.forEach((v, k) => {
    if (!targetUrl.searchParams.has(k)) targetUrl.searchParams.append(k, v);
  });

  const identity = pickIdentity(request.headers.get("x-prism-session") ?? undefined);
  const outHeaders = upstreamHeaders(identity);
  request.headers.forEach((v, k) => {
    if (HOP_BY_HOP.has(k.toLowerCase())) return;
    if (outHeaders.has(k)) return;
    outHeaders.set(k, v);
  });

  let upstream: Response;
  try {
    upstream = await fetch(targetUrl.href, {
      method: request.method,
      headers: outHeaders,
      body:
        request.method === "GET" || request.method === "HEAD"
          ? undefined
          : await request.arrayBuffer(),
      redirect: "follow",
    });
  } catch (err) {
    return new Response(`fetch failed: ${(err as Error).message}`, {
      status: 502,
      headers: { "access-control-allow-origin": "*" },
    });
  }

  const headers = sanitizeUpstreamHeaders(upstream.headers);
  const ct = upstream.headers.get("content-type") ?? "";
  const proxyOrigin = new URL(request.url).origin;

  if (ct.includes("text/html")) {
    const html = await upstream.text();
    const finalUrl = new URL(upstream.url || targetUrl.href);
    const rewritten = rewriteHtml(html, finalUrl, proxyOrigin);
    headers.set("content-type", "text/html; charset=utf-8");
    return new Response(rewritten, { status: upstream.status, headers });
  }

  if (ct.includes("text/css")) {
    const css = await upstream.text();
    const finalUrl = new URL(upstream.url || targetUrl.href);
    const rewritten = rewriteCss(css, finalUrl, proxyOrigin);
    headers.set("content-type", "text/css; charset=utf-8");
    return new Response(rewritten, { status: upstream.status, headers });
  }

  // Read as ArrayBuffer so fetch decompresses gzip/br transparently.
  // Streaming upstream.body directly would forward raw compressed bytes,
  // but we already stripped content-encoding for the browser.
  const buf = await upstream.arrayBuffer();
  return new Response(buf, {
    status: upstream.status,
    headers,
  });
}

export const Route = createFileRoute("/api/public/proxy/asset/$")({
  server: {
    handlers: {
      GET: async ({ request, params }) =>
        handle(request, (params as { _splat?: string })._splat ?? ""),
      POST: async ({ request, params }) =>
        handle(request, (params as { _splat?: string })._splat ?? ""),
      PUT: async ({ request, params }) =>
        handle(request, (params as { _splat?: string })._splat ?? ""),
      DELETE: async ({ request, params }) =>
        handle(request, (params as { _splat?: string })._splat ?? ""),
      OPTIONS: async () =>
        new Response(null, {
          status: 204,
          headers: {
            "access-control-allow-origin": "*",
            "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
            "access-control-allow-headers": "*",
            "access-control-max-age": "86400",
          },
        }),
    },
  },
});
