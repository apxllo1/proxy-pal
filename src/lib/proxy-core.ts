// Shared proxy helpers used by both the createServerFn (srcDoc flow) and
// the raw server routes at /api/public/proxy/{page,asset} (real-origin flow
// that fixes SPA/Next.js crashes caused by opaque-origin srcdoc iframes).

export type RigMode = "off" | "fixed" | "range";
export type RigConfig = { mode: RigMode; value?: number | null; max?: number | null };

const UA_POOL: { ua: string; lang: string; loc: string }[] = [
  {
    ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
    lang: "en-US,en;q=0.9",
    loc: "US",
  },
  {
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0 Safari/537.36",
    lang: "en-GB,en;q=0.9",
    loc: "UK",
  },
  {
    ua: "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0",
    lang: "en-CA,en;q=0.9",
    loc: "CA",
  },
  {
    ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    lang: "en-AU,en;q=0.9",
    loc: "AU",
  },
  {
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0",
    lang: "de-DE,de;q=0.9,en;q=0.8",
    loc: "DE",
  },
  {
    ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
    lang: "fr-FR,fr;q=0.9,en;q=0.8",
    loc: "FR",
  },
  {
    ua: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0 Mobile Safari/537.36",
    lang: "ja-JP,ja;q=0.9,en;q=0.8",
    loc: "JP",
  },
  {
    ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36",
    lang: "es-ES,es;q=0.9,en;q=0.8",
    loc: "ES",
  },
];

export function pickIdentity(seed?: string) {
  let h = 0;
  const s = seed || Math.random().toString();
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return UA_POOL[h % UA_POOL.length];
}

export function normalizeUrl(raw: string): string {
  let u = raw.trim();
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;
  return u;
}

export function upstreamHeaders(identity: { ua: string; lang: string }, extra?: HeadersInit): Headers {
  const h = new Headers(extra);
  h.set("user-agent", identity.ua);
  h.set(
    "accept",
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  );
  h.set("accept-language", identity.lang);
  h.set("cache-control", "no-cache");
  h.set("pragma", "no-cache");
  return h;
}

// Headers we should NEVER return to the browser because they'd break
// same-origin proxying or re-enable framing/security blocks that would
// crash the injected shim.
const STRIP_RESPONSE_HEADERS = new Set([
  "content-security-policy",
  "content-security-policy-report-only",
  "x-frame-options",
  "cross-origin-opener-policy",
  "cross-origin-embedder-policy",
  "cross-origin-resource-policy",
  "strict-transport-security",
  "content-length",
  "content-encoding",
  "transfer-encoding",
  "set-cookie", // avoid leaking upstream cookies to a different origin
]);

export function sanitizeUpstreamHeaders(src: Headers): Headers {
  const out = new Headers();
  src.forEach((value, key) => {
    if (STRIP_RESPONSE_HEADERS.has(key.toLowerCase())) return;
    out.set(key, value);
  });
  out.set("access-control-allow-origin", "*");
  out.set("cache-control", "no-store");
  return out;
}

const ASSET_PREFIX = "/api/public/proxy/asset/";

function encodeTarget(url: string): string {
  return ASSET_PREFIX + encodeURIComponent(url);
}

// Rewrite absolute + protocol-relative URLs in HTML so subresources
// (scripts, styles, images, XHR triggered from HTML) go through our asset
// passthrough instead of hitting the upstream origin directly (which
// would trip CORS / mixed-origin bugs).
export function rewriteHtml(
  html: string,
  targetUrl: URL,
  rig?: RigConfig,
): string {
  const origin = targetUrl.origin;
  const basePath = targetUrl.pathname.replace(/[^/]*$/, "");

  const baseTag = `<base href="${origin}${basePath}">`;
  const styleTag = `<style>html,body{background:#fff}</style>`;

  const rigScript =
    rig && rig.mode && rig.mode !== "off"
      ? `<script>(function(){
          var mode=${JSON.stringify(rig.mode)};
          var val=${JSON.stringify(rig.value ?? null)};
          var max=${JSON.stringify(rig.max ?? null)};
          var orig=Math.random;
          Math.random=function(){
            if(mode==='fixed'&&typeof val==='number'){var v=val;if(v<0)v=0;if(v>=1)v=0.9999999;return v;}
            if(mode==='range'&&typeof val==='number'&&typeof max==='number'&&max>0){
              var t=(val+0.5)/max; if(t<0)t=0; if(t>=1)t=0.9999999; return t;
            }
            return orig();
          };
        })();</script>`
      : "";

  // Runtime shim: rewrites fetch/XHR/dynamic script and image sources so
  // rngdle's `/api/stats/global` and Next chunk fetches route through our
  // asset passthrough and keep the app alive.
  const shim = `<script>(function(){
    var ORIGIN=${JSON.stringify(origin)};
    var BASE=${JSON.stringify(origin + basePath)};
    var ASSET=${JSON.stringify(ASSET_PREFIX)};
    var SELF=location.origin;
    function abs(u){try{return new URL(u,BASE).href}catch(e){return null}}
    function shouldProxy(u){
      if(!u) return false;
      if(u.startsWith(ASSET)) return false;
      if(u.startsWith('data:')||u.startsWith('blob:')||u.startsWith('javascript:')) return false;
      return true;
    }
    function rew(u){
      if(!shouldProxy(u)) return u;
      var a=abs(u); if(!a) return u;
      if(a.startsWith(SELF+ASSET)) return a;
      return ASSET+encodeURIComponent(a);
    }
    var origFetch=window.fetch.bind(window);
    window.fetch=function(input,init){
      try{
        if(typeof input==='string'){ input=rew(input); }
        else if(input && input.url){ input=new Request(rew(input.url),input); }
      }catch(e){}
      return origFetch(input,init);
    };
    var origOpen=XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open=function(m,u){
      try{ arguments[1]=rew(u); }catch(e){}
      return origOpen.apply(this,arguments);
    };
    // Intercept dynamic <script>/<img>/<link> src writes.
    ['src','href'].forEach(function(prop){
      ['HTMLScriptElement','HTMLImageElement','HTMLLinkElement','HTMLIFrameElement','HTMLSourceElement','HTMLMediaElement'].forEach(function(cn){
        var C=window[cn]; if(!C) return;
        var d=Object.getOwnPropertyDescriptor(C.prototype,prop);
        if(!d||!d.set) return;
        Object.defineProperty(C.prototype,prop,{
          configurable:true,enumerable:d.enumerable,
          get:d.get, set:function(v){ try{v=rew(v);}catch(e){} return d.set.call(this,v); }
        });
      });
    });
    // Neutralise framebusters.
    try{Object.defineProperty(window,'top',{get:function(){return window;}});}catch(e){}
    try{Object.defineProperty(window,'parent',{get:function(){return window;}});}catch(e){}
  })();</script>`;

  const navScript = `<script>(function(){
    function abs(u){try{return new URL(u,document.baseURI).href}catch(e){return null}}
    function send(u){if(u)parent.postMessage({__prism:'nav',url:u},'*')}
    document.addEventListener('click',function(e){
      var a=e.target && e.target.closest && e.target.closest('a[href]');
      if(!a)return;
      var href=a.getAttribute('href');
      if(!href||href.startsWith('javascript:')||href.startsWith('#'))return;
      e.preventDefault();send(abs(href));
    },true);
    document.addEventListener('submit',function(e){
      var f=e.target;if(!f||f.tagName!=='FORM')return;
      var method=(f.method||'GET').toUpperCase();
      if(method!=='GET')return;
      e.preventDefault();
      var params=new URLSearchParams(new FormData(f)).toString();
      var action=abs(f.action||location.href);
      if(!action)return;
      send(action+(action.includes('?')?'&':'?')+params);
    },true);
  })();</script>`;

  // Rewrite absolute URLs of the target origin found in inline HTML
  // attributes (src=, href=, action=). We also handle protocol-relative
  // (//host/…) and root-relative (/…) forms.
  const attrRe = /\b(src|href|action|data|poster)=(")([^"]+)(")|\b(src|href|action|data|poster)=(')([^']+)(')/gi;
  html = html.replace(attrRe, (_m, a1, q1a, v1, q1b, a2, q2a, v2, q2b) => {
    const attr = (a1 || a2) as string;
    const quote = (q1a || q2a) as string;
    const val = (v1 || v2) as string;
    if (!val) return _m;
    if (/^(data:|blob:|javascript:|mailto:|tel:|#)/i.test(val)) return _m;
    let absUrl: string;
    try {
      absUrl = new URL(val, origin + basePath).href;
    } catch {
      return _m;
    }
    return `${attr}=${quote}${encodeTarget(absUrl)}${quote}`;
  });

  const headInject = `${baseTag}${styleTag}${shim}${rigScript}${navScript}`;
  if (/<head[^>]*>/i.test(html)) {
    html = html.replace(/<head([^>]*)>/i, `<head$1>${headInject}`);
  } else {
    html = `<head>${headInject}</head>` + html;
  }
  html = html.replace(/target=("|')_(blank|top|parent)("|')/gi, 'target="_self"');

  return html;
}
