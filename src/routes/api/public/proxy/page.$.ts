import { createFileRoute } from "@tanstack/react-router";
import {
  normalizeUrl,
  pickIdentity,
  rewriteHtml,
  upstreamHeaders,
  type RigConfig,
  type RigMode,
} from "@/lib/proxy-core";

export const Route = createFileRoute("/api/public/proxy/page/$")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const splat = (params as { _splat?: string })._splat ?? "";
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

        const qp = new URL(request.url).searchParams;
        const session = qp.get("session") ?? undefined;
        const rig: RigConfig | undefined = qp.get("rig_mode")
          ? {
              mode: (qp.get("rig_mode") as RigMode) || "off",
              value: qp.get("rig_value") ? Number(qp.get("rig_value")) : null,
              max: qp.get("rig_max") ? Number(qp.get("rig_max")) : null,
            }
          : undefined;

        const identity = pickIdentity(session);

        let upstream: Response;
        try {
          upstream = await fetch(targetUrl.href, {
            headers: upstreamHeaders(identity),
            redirect: "follow",
          });
        } catch (err) {
          return new Response(`fetch failed: ${(err as Error).message}`, {
            status: 502,
          });
        }

        const ct = upstream.headers.get("content-type") ?? "";
        if (!ct.includes("text/html")) {
          // Not HTML – just stream the body straight back.
          return new Response(upstream.body, {
            status: upstream.status,
            headers: {
              "content-type": ct || "application/octet-stream",
              "cache-control": "no-store",
            },
          });
        }

        const html = await upstream.text();
        const finalUrl = new URL(upstream.url || targetUrl.href);
        const proxyOrigin = new URL(request.url).origin;
        const rewritten = rewriteHtml(html, finalUrl, proxyOrigin, rig);

        return new Response(rewritten, {
          status: 200,
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
            "x-prism-identity": `${identity.loc}; ${identity.lang}`,
          },
        });
      },
    },
  },
});
