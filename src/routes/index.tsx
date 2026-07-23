import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useRef, useState } from "react";
import { proxyFetch } from "@/lib/proxy.functions";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Prism — a quiet window into the web" },
      {
        name: "description",
        content:
          "Prism is an edge-rendered web proxy. Paste a link and load any site inside a private preview.",
      },
      { property: "og:title", content: "Prism" },
      {
        property: "og:description",
        content: "A quiet window into the web. Edge-rendered, personal, no signup.",
      },
    ],
  }),
  component: Home,
});

type Entry = { url: string; ts: number };
type Pinned = { url: string; label: string };

type Tile = {
  label: string;
  url: string;
  domain: string;
  bg: string;
};

const TILES: Tile[] = [
  { label: "Wikipedia", url: "https://en.wikipedia.org", domain: "en.wikipedia.org", bg: "#ffffff" },
  { label: "Hacker News", url: "https://news.ycombinator.com", domain: "news.ycombinator.com", bg: "#ff6600" },
  { label: "DuckDuckGo", url: "https://duckduckgo.com/?kae=t", domain: "duckduckgo.com", bg: "#de5833" },
  { label: "GitHub", url: "https://github.com", domain: "github.com", bg: "#0d1117" },
  { label: "MDN", url: "https://developer.mozilla.org", domain: "developer.mozilla.org", bg: "#ffffff" },
  { label: "arXiv", url: "https://arxiv.org", domain: "arxiv.org", bg: "#b31b1b" },
];

// External proxies embedded raw (they run their own JS/streaming, so our
// HTML-rewrite proxy can't handle them — but they allow iframe embedding).
const EXTERNAL_LAUNCHERS: { label: string; url: string; domain: string; bg: string }[] = [
  { label: "YouTube", url: "https://www.youtubeunblocked.live/", domain: "youtube.com", bg: "#ff0000" },
  { label: "RNGdle", url: "https://www.rngdle.com/", domain: "rngdle.com", bg: "#0f1220" },
];

// Hostnames that allow framing directly (no HTML rewrite needed). Kept
// empty by default so we route through the rewriter and can inject scripts
// needed for in-app navigation. Add hosts here only if their JS truly
// requires their own origin.
const DIRECT_FRAME_HOSTS = new Set<string>([]);

function faviconFor(domain: string) {
  return `https://www.google.com/s2/favicons?sz=128&domain=${domain}`;
}

function domainOf(u: string) {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return u;
  }
}

function Home() {
  const run = useServerFn(proxyFetch);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [doc, setDoc] = useState<string | null>(null);
  const [externalUrl, setExternalUrl] = useState<string | null>(null);
  const [externalLabel, setExternalLabel] = useState<string>("");
  const [stack, setStack] = useState<string[]>([]);
  const [history, setHistory] = useState<Entry[]>([]);
  const [pinned, setPinned] = useState<Pinned[]>([]);
  const [latency, setLatency] = useState<number | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [flash, setFlash] = useState<string | null>(null);
  // A fresh session id per page load = the proxy picks a different UA /
  // "location" every visit, and cache-busts upstream fetches.
  const [sessionId, setSessionId] = useState<string>(() =>
    Math.random().toString(36).slice(2) + Date.now().toString(36),
  );
  const [identity, setIdentity] = useState<string | null>(null);
  const flashMsg = (m: string) => {
    setFlash(m);
    window.setTimeout(() => setFlash((f) => (f === m ? null : f)), 1600);
  };
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const finalUrl = externalUrl ?? stack[stack.length - 1] ?? "";

  useEffect(() => {
    try {
      const pins = localStorage.getItem("prism.pinned");
      if (pins) setPinned(JSON.parse(pins));
    } catch {}
    // Auto-reset on every visit: clear history + caches, rotate session.
    try { localStorage.removeItem("prism.history"); } catch {}
    if ("caches" in window) {
      caches.keys().then((keys) => keys.forEach((k) => caches.delete(k))).catch(() => {});
    }
    const t0 = performance.now();
    fetch("/", { method: "HEAD" })
      .then(() => setLatency(Math.round(performance.now() - t0)))
      .catch(() => {});
  }, []);

  const pushHistory = (url: string) => {
    setHistory((prev) => {
      const next = [{ url, ts: Date.now() }, ...prev.filter((e) => e.url !== url)].slice(0, 8);
      try {
        localStorage.setItem("prism.history", JSON.stringify(next));
      } catch {}
      return next;
    });
  };

  const savePinned = (next: Pinned[]) => {
    setPinned(next);
    try {
      localStorage.setItem("prism.pinned", JSON.stringify(next));
    } catch {}
  };

  const addPinned = (url: string) => {
    const u = url.trim();
    if (!u) return;
    const normalized = /^https?:\/\//i.test(u) ? u : "https://" + u;
    if (pinned.some((p) => p.url === normalized)) return;
    savePinned([...pinned, { url: normalized, label: domainOf(normalized) }]);
  };

  const removePinned = (url: string) => {
    savePinned(pinned.filter((p) => p.url !== url));
  };

  const load = async (raw: string, mode: "push" | "replace" = "push") => {
    const url = raw.trim();
    if (!url) return;
    const normalized = /^https?:\/\//i.test(url) ? url : "https://" + url;

    // Rotate identity on EVERY navigation — the whole point of the proxy is
    // "different location every time you use it".
    const nextSession =
      Math.random().toString(36).slice(2) + Date.now().toString(36);
    setSessionId(nextSession);

    let host = "";
    try {
      host = new URL(normalized).hostname.toLowerCase();
    } catch {}

    if (DIRECT_FRAME_HOSTS.has(host)) {
      launchExternal(normalized, host.replace(/^www\./, ""));
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const res = await run({ data: { url: normalized, session: nextSession } });
      if (!res.ok) {
        setError(res.error);
      } else {
        setDoc(res.html);
        setStack((s) => (mode === "replace" ? [...s.slice(0, -1), res.finalUrl] : [...s, res.finalUrl]));
        setInput(res.finalUrl);
        pushHistory(res.finalUrl);
        setIdentity((res as { identity?: string }).identity ?? null);
        setReloadKey((k) => k + 1);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  };

  const launchExternal = (url: string, label: string) => {
    setDoc(null);
    setStack([]);
    setError(null);
    setExternalUrl(url);
    setExternalLabel(label);
    setInput(url);
    pushHistory(url);
    setReloadKey((k) => k + 1);
  };

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const data = e.data as { __prism?: string; url?: string };
      if (data && data.__prism === "nav" && typeof data.url === "string") {
        load(data.url);
      }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const goBack = () => {
    if (stack.length <= 1) return;
    const prev = stack[stack.length - 2];
    setStack((s) => s.slice(0, -1));
    setInput(prev);
    load(prev, "replace");
  };

  const closeBrowser = () => {
    setDoc(null);
    setExternalUrl(null);
    setStack([]);
    setInput("");
    setError(null);
  };

  const fullReset = () => {
    setDoc(null);
    setExternalUrl(null);
    setStack([]);
    setInput("");
    setError(null);
    setHistory([]);
    setIdentity(null);
    setSessionId(Math.random().toString(36).slice(2) + Date.now().toString(36));
    setReloadKey((k) => k + 1);
    try { localStorage.removeItem("prism.history"); } catch {}
    if ("caches" in window) {
      caches.keys().then((keys) => keys.forEach((k) => caches.delete(k))).catch(() => {});
    }
    flashMsg("Proxy reset — new location assigned");
  };

  const refreshCurrent = () => {
    if (externalUrl) {
      setReloadKey((k) => k + 1);
      flashMsg("Reloading…");
    } else if (finalUrl) {
      load(finalUrl, "replace");
      flashMsg("Reloading…");
    }
  };

  if (doc || externalUrl) {
    const isExternal = !!externalUrl;
    return (
      <div className="flex h-screen flex-col bg-[var(--bg)] text-[var(--fg)]">
        <div className="flex items-center gap-2 border-b border-white/10 bg-black/60 px-3 py-2 backdrop-blur">
          <button
            onClick={closeBrowser}
            className="grid h-8 w-8 place-items-center rounded-md bg-gradient-to-br from-[var(--accent-a)] to-[var(--accent-b)] shadow-[0_0_20px_-6px_var(--accent-a)]"
            title="Home"
          >
            <div className="h-2.5 w-2.5 rotate-45 bg-black/80" />
          </button>
          <button
            onClick={goBack}
            disabled={isExternal || stack.length <= 1}
            className="grid h-8 w-8 place-items-center rounded-md border border-white/10 text-white/70 transition hover:bg-white/10 disabled:opacity-30"
            title="Back"
          >
            ←
          </button>
          <button
            onClick={refreshCurrent}
            className="grid h-8 w-8 place-items-center rounded-md border border-white/10 text-white/70 transition hover:bg-white/10 active:scale-90"
            title="Refresh"
          >
            ↻
          </button>
          <button
            onClick={fullReset}
            className="grid h-8 w-8 place-items-center rounded-md border border-red-500/30 text-red-300 transition hover:bg-red-500/10"
            title="Full reset (clear cache & history)"
          >
            ⟳
          </button>
          <button
            onClick={() => finalUrl && addPinned(finalUrl)}
            disabled={!finalUrl || pinned.some((p) => p.url === finalUrl)}
            className="grid h-8 w-8 place-items-center rounded-md border border-white/10 text-white/70 transition hover:bg-white/10 disabled:opacity-30"
            title="Pin site"
          >
            ★
          </button>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (isExternal) return;
              load(input);
            }}
            className="flex flex-1 items-center gap-2 rounded-md border border-white/10 bg-white/[0.04] px-3 py-1.5"
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                loading ? "animate-pulse bg-[var(--accent-a)]" : "bg-[var(--accent-a)]"
              }`}
            />
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              readOnly={isExternal}
              spellCheck={false}
              className="flex-1 truncate bg-transparent font-mono text-xs text-white/90 focus:outline-none"
            />
            {isExternal ? (
              <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-white/40">
                via {externalLabel}
              </span>
            ) : identity ? (
              <span
                className="font-mono text-[10px] uppercase tracking-[0.2em] text-white/40"
                title={`Session ${sessionId.slice(0, 6)} — ${identity}`}
              >
                {identity.split(";")[0]}
              </span>
            ) : null}
          </form>
        </div>

        {error && (
          <div className="border-b border-red-500/30 bg-red-500/10 px-4 py-2 font-mono text-xs text-red-200">
            {error}
          </div>
        )}

        <div className="relative min-h-0 flex-1">
          {isExternal ? (
            <iframe
              key={reloadKey}
              ref={iframeRef}
              title="Preview"
              src={externalUrl!}
              sandbox="allow-scripts allow-forms allow-popups allow-same-origin allow-presentation allow-pointer-lock allow-popups-to-escape-sandbox allow-downloads"
              allow="autoplay; fullscreen; encrypted-media; picture-in-picture; clipboard-write"
              className="h-full w-full bg-white"
            />
          ) : doc ? (
            <iframe
              key={reloadKey}
              ref={iframeRef}
              title="Preview"
              srcDoc={doc}
              sandbox="allow-scripts allow-forms allow-popups allow-same-origin allow-presentation allow-pointer-lock"
              allow="autoplay; fullscreen; encrypted-media; picture-in-picture; clipboard-write"
              className="h-full w-full bg-white"
            />
          ) : (
            <div className="grid h-full place-items-center bg-black/40 p-8 text-center">
              <div className="max-w-md">
                <div className="mx-auto mb-4 h-10 w-10 animate-spin rounded-full border-2 border-white/10 border-t-[var(--accent-a)]" />
                <div className="font-mono text-xs uppercase tracking-[0.25em] text-white/50">
                  {loading ? "Loading…" : "Nothing loaded"}
                </div>
              </div>
            </div>
          )}
          {loading && (
            <div className="pointer-events-none absolute inset-x-0 top-0 h-0.5 overflow-hidden bg-white/5">
              <div className="h-full w-1/3 animate-[loading_1.2s_ease-in-out_infinite] bg-gradient-to-r from-transparent via-[var(--accent-a)] to-transparent" />
            </div>
          )}
          {flash && (
            <div className="pointer-events-none absolute left-1/2 top-3 -translate-x-1/2 rounded-full border border-white/10 bg-black/80 px-4 py-1.5 font-mono text-[11px] uppercase tracking-[0.2em] text-white/80 shadow-lg backdrop-blur">
              {flash}
            </div>
          )}
        </div>
      </div>
    );
  }

  // === LANDING ===
  return (
    <div className="relative min-h-screen bg-[var(--bg)] text-[var(--fg)]">
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -top-40 left-1/2 h-[520px] w-[820px] -translate-x-1/2 rounded-full bg-[var(--glow-a)] blur-[140px] opacity-60" />
        <div className="absolute bottom-[-200px] right-[-120px] h-[420px] w-[520px] rounded-full bg-[var(--glow-b)] blur-[140px] opacity-50" />
      </div>

      <div className="relative z-10 mx-auto max-w-6xl px-4 pb-16 pt-6 sm:px-6 sm:pt-8">
        {flash && (
          <div className="fixed left-1/2 top-4 z-50 -translate-x-1/2 rounded-full border border-white/10 bg-black/80 px-4 py-1.5 font-mono text-[11px] uppercase tracking-[0.2em] text-white/80 shadow-lg backdrop-blur">
            {flash}
          </div>
        )}
        <header className="mb-6 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="grid h-8 w-8 place-items-center rounded-md bg-gradient-to-br from-[var(--accent-a)] to-[var(--accent-b)] shadow-[0_0_24px_-4px_var(--accent-a)]">
              <div className="h-3 w-3 rotate-45 bg-black/80" />
            </div>
            <span className="font-mono text-sm tracking-[0.25em] text-white/90">PRISM</span>
          </div>
          <button
            onClick={fullReset}
            className="rounded-md border border-red-500/30 px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.2em] text-red-300 transition hover:bg-red-500/10"
            title="Clear cache & history"
          >
            Full reset
          </button>
        </header>

        <div className="grid gap-4 lg:grid-cols-2">
          {/* LEFT COLUMN */}
          <div className="flex flex-col gap-4">
            {/* Brand card */}
            <section className="relative overflow-hidden rounded-3xl border border-white/10 bg-white/[0.03] p-6 backdrop-blur-xl">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h1 className="font-serif text-4xl font-medium tracking-tight sm:text-5xl">
                    Prism
                  </h1>
                  <div className="mt-2 font-mono text-[11px] uppercase tracking-[0.2em] text-white/40">
                    v 1.0 · edge
                  </div>
                  <p className="mt-6 max-w-sm text-lg text-white/70">
                    A quiet window into the web.
                  </p>
                  <div className="mt-6 font-mono text-[11px] tracking-[0.2em] text-white/40">
                    prism / proxy
                  </div>
                </div>
                <PrismOrb />
              </div>
            </section>

            {/* Browse card */}
            <section className="rounded-3xl border border-white/10 bg-white/[0.03] p-6 backdrop-blur-xl">
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  load(input);
                }}
                className="flex flex-col gap-2"
              >
                <div className="flex items-center gap-2 rounded-2xl border border-white/10 bg-black/40 px-4 py-3">
                  <span className="font-mono text-[11px] uppercase tracking-[0.2em] text-white/40">
                    url
                  </span>
                  <input
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    placeholder="example.com"
                    spellCheck={false}
                    autoCapitalize="off"
                    autoCorrect="off"
                    className="flex-1 bg-transparent font-mono text-sm text-white placeholder:text-white/30 focus:outline-none"
                  />
                </div>
                <div className="flex gap-2">
                  <button
                    type="submit"
                    disabled={loading || !input.trim()}
                    className="flex-1 rounded-2xl bg-white/[0.06] px-5 py-3 text-sm font-medium text-white ring-1 ring-white/10 transition hover:bg-white/[0.1] disabled:opacity-40"
                  >
                    {loading ? "Loading…" : "Browse →"}
                  </button>
                  <button
                    type="button"
                    onClick={() => input.trim() && addPinned(input)}
                    disabled={!input.trim()}
                    className="rounded-2xl border border-white/10 px-4 py-3 text-sm text-white/80 transition hover:bg-white/[0.06] disabled:opacity-40"
                    title="Pin to your list"
                  >
                    ★ Pin
                  </button>
                </div>
                {error && (
                  <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 font-mono text-[11px] text-red-200">
                    {error}
                  </div>
                )}
              </form>
            </section>

            {/* Pinned sites */}
            <section className="rounded-3xl border border-white/10 bg-white/[0.03] p-4 backdrop-blur-xl">
              <div className="mb-2 flex items-center justify-between px-2 font-mono text-[11px] uppercase tracking-[0.2em] text-white/40">
                <span>My sites</span>
                <span className="text-white/30">{pinned.length}</span>
              </div>
              {pinned.length === 0 ? (
                <div className="px-2 py-3 text-xs text-white/40">
                  Pin any site with ★ to keep it here.
                </div>
              ) : (
                <ul className="divide-y divide-white/5">
                  {pinned.map((p) => (
                    <li key={p.url} className="flex items-center gap-2">
                      <button
                        onClick={() => load(p.url)}
                        className="flex flex-1 items-center gap-3 rounded-lg px-2 py-2 text-left transition hover:bg-white/[0.04]"
                      >
                        <img src={faviconFor(domainOf(p.url))} alt="" className="h-4 w-4" loading="lazy" />
                        <span className="truncate font-mono text-xs text-white/80">{p.url}</span>
                      </button>
                      <button
                        onClick={() => removePinned(p.url)}
                        className="px-2 py-1 text-xs text-white/40 hover:text-red-300"
                        title="Remove"
                      >
                        ✕
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {history.length > 0 && (
              <section className="rounded-3xl border border-white/10 bg-white/[0.03] p-4 backdrop-blur-xl">
                <div className="mb-2 flex items-center justify-between px-2 font-mono text-[11px] uppercase tracking-[0.2em] text-white/40">
                  <span>Recent</span>
                  <button
                    onClick={() => {
                      setHistory([]);
                      localStorage.removeItem("prism.history");
                    }}
                    className="hover:text-white"
                  >
                    clear
                  </button>
                </div>
                <ul className="divide-y divide-white/5">
                  {history.map((h) => (
                    <li key={h.url + h.ts}>
                      <button
                        onClick={() => load(h.url)}
                        className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition hover:bg-white/[0.04]"
                      >
                        <span className="h-1.5 w-1.5 rounded-full bg-[var(--accent-b)]" />
                        <span className="truncate font-mono text-xs text-white/80">
                          {h.url}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>

          {/* RIGHT COLUMN */}
          <div className="flex flex-col gap-4">
            {/* Status card */}
            <section className="rounded-3xl border border-white/10 bg-white/[0.03] p-6 backdrop-blur-xl">
              <div className="text-2xl font-medium">Status</div>
              <div className="mt-6 flex flex-col gap-5">
                <StatusRow
                  label={<><span className="font-semibold">HTML</span> <span className="text-white/50">rewriter</span></>}
                  indicator={
                    <span className="h-3 w-3 rounded-full bg-[var(--accent-a)] shadow-[0_0_12px_var(--accent-a)]" />
                  }
                />
                <StatusRow
                  label={<><span className="font-semibold">Edge</span> <span className="text-white/50">worker</span></>}
                  indicator={<BoltIcon />}
                />
                <StatusRow
                  label={
                    <>
                      <span className="font-semibold">
                        {latency == null ? "…" : `~${latency} ms`}
                      </span>{" "}
                      <span className="text-white/50">latency</span>
                    </>
                  }
                  indicator={<BarsIcon />}
                />
              </div>
            </section>

            {/* Quick launch */}
            <section className="flex-1 rounded-3xl border border-white/10 bg-white/[0.03] p-6 backdrop-blur-xl">
              <div className="text-2xl font-medium">Quick launch</div>
              <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
                {TILES.map((t) => (
                  <button
                    key={t.url}
                    onClick={() => load(t.url)}
                    className="group relative flex flex-col overflow-hidden rounded-2xl border border-white/10 bg-white/[0.02] transition hover:-translate-y-0.5 hover:border-white/20 hover:bg-white/[0.05]"
                  >
                    <div
                      className="flex aspect-[5/4] items-center justify-center"
                      style={{ background: t.bg }}
                    >
                      <img
                        src={faviconFor(t.domain)}
                        alt=""
                        className="h-14 w-14"
                        loading="lazy"
                      />
                    </div>
                    <div className="flex items-center justify-between border-t border-white/5 bg-black/30 px-3 py-2 text-sm font-medium text-white">
                      {t.label}
                    </div>
                  </button>
                ))}
                {EXTERNAL_LAUNCHERS.map((t) => (
                  <button
                    key={t.url}
                    onClick={() => launchExternal(t.url, t.label)}
                    className="group relative flex flex-col overflow-hidden rounded-2xl border border-white/10 bg-white/[0.02] transition hover:-translate-y-0.5 hover:border-white/20 hover:bg-white/[0.05]"
                    title={`Opens ${t.label} through ${new URL(t.url).hostname}`}
                  >
                    <div
                      className="flex aspect-[5/4] items-center justify-center"
                      style={{ background: t.bg }}
                    >
                      <img
                        src={faviconFor(t.domain)}
                        alt=""
                        className="h-14 w-14"
                        loading="lazy"
                      />
                    </div>
                    <div className="flex items-center justify-between border-t border-white/5 bg-black/30 px-3 py-2 text-sm font-medium text-white">
                      <span>{t.label}</span>
                      <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-white/40">
                        proxy
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            </section>
          </div>
        </div>

        <footer className="mt-8 text-center font-mono text-[10px] uppercase tracking-[0.25em] text-white/30">
          Prism · edge proxy · for research use
        </footer>
      </div>
    </div>
  );
}

function StatusRow({ label, indicator }: { label: React.ReactNode; indicator: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <div className="text-sm">{label}</div>
      <div className="grid h-9 w-9 place-items-center rounded-full bg-white/[0.04] ring-1 ring-white/10">
        {indicator}
      </div>
    </div>
  );
}

function PrismOrb() {
  return (
    <div className="relative h-24 w-24 shrink-0">
      <div className="absolute inset-0 rounded-2xl bg-black/60" />
      <div className="absolute inset-2 rounded-full bg-gradient-to-br from-[var(--accent-a)] via-[var(--accent-b)] to-[#3d1e6d] blur-[1px]" />
      <div className="absolute inset-4 rounded-full bg-gradient-to-br from-[var(--accent-a)] to-[var(--accent-b)]" />
      <div className="absolute inset-6 rounded-full bg-black/30 mix-blend-overlay" />
    </div>
  );
}

function BoltIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" className="text-[var(--accent-b)]">
      <path d="M13 2 4 14h6l-1 8 9-12h-6l1-8z" />
    </svg>
  );
}

function BarsIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-white/70">
      <path d="M4 20V10M10 20V4M16 20v-8M22 20v-4" />
    </svg>
  );
}
