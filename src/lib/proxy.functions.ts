import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const inputSchema = z.object({
  url: z.string().url(),
  session: z.string().optional(),
  // Rig config for sites that use Math.random client-side (e.g. rngdle).
  // mode: "off" | "fixed" | "range"
  // value: for "fixed" a number 0..1; for "range" an integer target we'll
  // bias Math.random toward when the site calls Math.floor(Math.random()*N).
  rig: z
    .object({
      mode: z.enum(["off", "fixed", "range"]).default("off"),
      value: z.number().optional(),
      max: z.number().optional(),
    })
    .optional(),
});

function normalizeUrl(raw: string): string {
  let u = raw.trim();
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;
  return u;
}

// Pool of plausible desktop identities. We pick one based on the client's
// session id so each fresh visit looks like a different device/location.
const UA_POOL = [
  {
    ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
    lang: "en-US,en;q=0.9",
  },
  {
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0 Safari/537.36",
    lang: "en-GB,en;q=0.9",
  },
  {
    ua: "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0",
    lang: "en-CA,en;q=0.9",
  },
  {
    ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    lang: "en-AU,en;q=0.9",
  },
];

function pickIdentity(session?: string) {
  let h = 0;
  const s = session || Math.random().toString();
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return UA_POOL[h % UA_POOL.length];
}

export const proxyFetch = createServerFn({ method: "POST" })
  .inputValidator((data) => inputSchema.parse(data))
  .handler(async ({ data }) => {
    const target = normalizeUrl(data.url);
    const targetUrl = new URL(target);
    const identity = pickIdentity(data.session);

    let res: Response;
    try {
      res = await fetch(target, {
        headers: {
          "user-agent": identity.ua,
          accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
          "accept-language": identity.lang,
          "cache-control": "no-cache",
          pragma: "no-cache",
        },
        redirect: "follow",
      });
    } catch (e) {
      return {
        ok: false as const,
        status: 0,
        finalUrl: target,
        error: `Could not reach ${target}. The site may be blocking proxies.`,
      };
    }

    const contentType = res.headers.get("content-type") ?? "";
    const finalUrl = res.url || target;

    if (!contentType.includes("text/html")) {
      return {
        ok: false as const,
        status: res.status,
        finalUrl,
        error: `Unsupported content type: ${contentType || "unknown"}`,
      };
    }

    let html = await res.text();

    const looksChallenged =
      res.status === 403 ||
      res.status === 503 ||
      /Just a moment\.\.\.|challenge-platform|cf-browser-verification|__cf_chl/i.test(
        html.slice(0, 4000),
      );
    if (looksChallenged) {
      return {
        ok: false as const,
        status: res.status,
        finalUrl,
        error: `${new URL(finalUrl).hostname} is behind a bot-protection challenge (Cloudflare/similar). It can't be loaded through an HTML proxy. Try a different site.`,
      };
    }

    if (res.status >= 400) {
      return {
        ok: false as const,
        status: res.status,
        finalUrl,
        error: `${new URL(finalUrl).hostname} responded with HTTP ${res.status}.`,
      };
    }

    const baseTag = `<base href="${targetUrl.origin}${targetUrl.pathname.replace(/[^/]*$/, "")}">`;
    const styleTag = `<style>html,body{background:#fff}</style>`;

    // Rig script — overrides Math.random so sites using it for local
    // "randomness" produce the outcome the user configured. Injected only
    // when a rig is active.
    const rig = data.rig;
    const rigScript =
      rig && rig.mode && rig.mode !== "off"
        ? `<script>(function(){
            var mode=${JSON.stringify(rig.mode)};
            var val=${JSON.stringify(rig.value ?? null)};
            var max=${JSON.stringify(rig.max ?? null)};
            var orig=Math.random;
            Math.random=function(){
              if(mode==='fixed' && typeof val==='number'){
                // clamp into [0,1)
                var v=val; if(v<0)v=0; if(v>=1)v=0.9999999;
                return v;
              }
              if(mode==='range' && typeof val==='number' && typeof max==='number' && max>0){
                // Site typically does Math.floor(Math.random()*N). We return
                // (val + tiny jitter)/max so floor lands on val for any N<=max.
                var target=(val + 0.5)/max;
                if(target<0)target=0; if(target>=1)target=0.9999999;
                return target;
              }
              return orig();
            };
          })();</script>`
        : "";

    const navScript = `<script>(function(){
      try{Object.defineProperty(window,'top',{get:()=>window});}catch(e){}
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

    // Rig must run BEFORE the page's own scripts, so inject at the very top of <head>.
    const headInject = `${baseTag}${styleTag}${rigScript}${navScript}`;
    if (/<head[^>]*>/i.test(html)) {
      html = html.replace(/<head([^>]*)>/i, `<head$1>${headInject}`);
    } else {
      html = `<head>${headInject}</head>` + html;
    }
    html = html.replace(/target=("|')_(blank|top|parent)("|')/gi, 'target="_self"');

    return {
      ok: true as const,
      status: res.status,
      finalUrl,
      html,
      identity: identity.ua.split(") ")[0].replace(/^Mozilla\/5\.0 \(/, ""),
    };
  });
