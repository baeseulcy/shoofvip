const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const https = require('https');
const http = require('http');
const { URL } = require('url');

const SITE = 'https://shooflive.net';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/147 Safari/537.36';

const manifest = {
  id: 'com.naevistv.shoofvip',
  version: '1.1.0',
  name: 'ShoofVIP',
  description: 'Search ShoofVIP directly and provide its episodes and streams.',
  resources: [
    { name: 'catalog', types: ['series'], idPrefixes: ['shoof:'] },
    { name: 'meta', types: ['series'], idPrefixes: ['shoof:'] },
    { name: 'stream', types: ['series'], idPrefixes: ['shoof:'] }
  ],
  types: ['series'],
  catalogs: [
    {
      type: 'series',
      id: 'shoofvip_search',
      name: 'ShoofVIP',
      extra: [{ name: 'search', isRequired: true }]
    }
  ]
};

const builder = new addonBuilder(manifest);

function request(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error('Too many redirects'));
    let u;
    try { u = new URL(url); } catch (_) { return reject(new Error('Bad URL')); }
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.get(url, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ar,en;q=0.8',
        'Referer': SITE + '/'
      },
      timeout: 20000
    }, res => {
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        return request(new URL(res.headers.location, url).href, redirects + 1).then(resolve, reject);
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error('HTTP ' + res.statusCode));
        resolve({ html: data, finalUrl: url, headers: res.headers });
      });
    });
    req.on('timeout', () => req.destroy(new Error('Timeout')));
    req.on('error', reject);
  });
}

function abs(href, base = SITE + '/') {
  try { return new URL(href, base).href; } catch (_) { return ''; }
}
function decodeHtml(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#039;|&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h,16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}
function strip(s) { return decodeHtml(String(s || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim(); }
function enc(s) { return Buffer.from(String(s), 'utf8').toString('base64url'); }
function dec(s) { return Buffer.from(String(s), 'base64url').toString('utf8'); }
function idFor(url) { return 'shoof:' + enc(url); }
function urlFromId(id) { return dec(id.slice('shoof:'.length)); }
function unique(arr) { return [...new Set(arr.filter(Boolean))]; }

function linksFrom(html, base) {
  const out = [];
  const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const href = abs(decodeHtml(m[1]), base);
    const text = strip(m[2]);
    if (href) out.push({ href, text });
  }
  return out;
}

function imageFromHtml(html, baseUrl) {
  const candidates = [];
  const add = value => {
    if (!value) return;
    const v = abs(decodeHtml(value.trim()), baseUrl);
    if (v && /^https?:\/\//i.test(v) && !candidates.includes(v)) candidates.push(v);
  };
  let m = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
  if (m) add(m[1]);
  if (!candidates.length) {
    m = html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
    if (m) add(m[1]);
  }
  if (!candidates.length) {
    m = html.match(/<meta[^>]+(?:name|property)=["'](?:twitter:image|twitter:image:src)["'][^>]+content=["']([^"']+)["']/i);
    if (m) add(m[1]);
  }
  if (!candidates.length) {
    m = html.match(/"image"\s*:\s*(?:\[\s*)?["']([^"']+)["']/i);
    if (m) add(m[1]);
  }
  if (!candidates.length) {
    const imgRe = /<img\b[^>]*(?:data-src|data-lazy-src|src)=["']([^"']+)["'][^>]*>/gi;
    let im;
    while ((im = imgRe.exec(html))) {
      const u = abs(decodeHtml(im[1]), baseUrl);
      if (u && /^https?:\/\//i.test(u) && !/logo|avatar|icon|emoji|favicon/i.test(u)) {
        candidates.push(u); break;
      }
    }
  }
  return candidates[0] || undefined;
}

function titleFromHtml(html) {
  let m = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i);
  if (!m) m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (m) return strip(m[1]).replace(/\s*[|–-]\s*شوف\s*لايف.*$/i, '').trim();
  m = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  return m ? strip(m[1]) : 'ShoofVIP';
}

function episodeNumber(text, url) {
  const s = (text || '') + ' ' + (url || '');
  const patterns = [
    /(?:الحلقة|حلقة|الحلقه|episode|ep|e)\s*#?\s*(\d+)/i,
    /[\s_-](\d+)(?:[/?#]|$)/i
  ];
  for (const p of patterns) { const m = s.match(p); if (m) return Number(m[1]); }
  return null;
}

function seasonNumber(text, url) {
  const s = (text || '') + ' ' + (url || '');
  const m = s.match(/(?:season|الموسم|موسم)\s*#?\s*(\d+)/i);
  return m ? Number(m[1]) : 1;
}

function findEpisodeLinks(html, baseUrl) {
  const all = linksFrom(html, baseUrl);
  const eps = [];
  for (const x of all) {
    if (!/\/episode\//i.test(x.href)) continue;
    const ep = episodeNumber(x.text, x.href);
    if (ep != null) eps.push({ ...x, episode: ep, season: seasonNumber(x.text, x.href) });
  }
  const map = new Map();
  for (const x of eps) map.set(`${x.season}:${x.episode}`, x);
  return [...map.values()].sort((a,b) => a.season-b.season || a.episode-b.episode);
}

function searchResults(html, baseUrl) {
  const all = linksFrom(html, baseUrl);
  const candidates = [];
  for (const x of all) {
    if (!/^https?:\/\/[^/]+\/(?:series|movies)\//i.test(x.href)) continue;
    if (/\/episode\//i.test(x.href)) continue;
    const text = strip(x.text);
    if (!text || /شاهد الآن|اقرأ المزيد|تحميل/i.test(text)) continue;
    candidates.push(x);
  }
  const seen = new Set();
  return candidates.filter(x => !seen.has(x.href) && seen.add(x.href)).slice(0, 30);
}

function cleanSearchTitle(s) { return strip(s).replace(/\s+/g, ' ').trim(); }

builder.defineCatalogHandler(async ({ extra }) => {
  const q = cleanSearchTitle(extra && extra.search);
  if (!q) return { metas: [] };
  try {
    const searchUrl = SITE + '/?s=' + encodeURIComponent(q);
    const { html } = await request(searchUrl);
    const results = searchResults(html, searchUrl);
    const metas = [];
    for (const r of results) {
      const page = await request(r.href).catch(() => null);
      const title = page ? titleFromHtml(page.html) : strip(r.text) || q;
      const eps = page ? findEpisodeLinks(page.html, r.href) : [];
      const poster = page ? imageFromHtml(page.html, r.href) : undefined;
      metas.push({
        id: idFor(r.href),
        type: 'series',
        name: title || strip(r.text) || q,
        poster,
        background: poster,
        description: 'ShoofVIP',
        videos: eps.slice(0, 300).map(e => ({
          id: idFor(e.href),
          title: e.text || `Episode ${e.episode}`,
          season: e.season,
          episode: e.episode
        }))
      });
    }
    return { metas };
  } catch (e) {
    console.log('[ShoofVIP] catalog error:', e.message);
    return { metas: [] };
  }
});

builder.defineMetaHandler(async ({ id }) => {
  try {
    const pageUrl = urlFromId(id);
    const { html } = await request(pageUrl);
    const title = titleFromHtml(html);
    const poster = imageFromHtml(html, pageUrl);
    const eps = findEpisodeLinks(html, pageUrl);
    return {
      meta: {
        id,
        type: 'series',
        name: title,
        poster,
        background: poster,
        videos: eps.map(e => ({
          id: idFor(e.href),
          title: e.text || `Episode ${e.episode}`,
          season: e.season,
          episode: e.episode
        }))
      }
    };
  } catch (e) {
    console.log('[ShoofVIP] meta error:', e.message);
    return { meta: { id, type: 'series', name: 'ShoofVIP', videos: [] } };
  }
});

function b64decode(s) {
  try { return Buffer.from(s, 'base64').toString('utf8'); } catch (_) { return ''; }
}

function extractDirect(html, pageUrl) {
  const out = [];
  const seen = new Set();
  const add = (url, title) => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    out.push({ name: 'ShoofVIP', title, url, quality: 'HD', headers: { Referer: pageUrl, 'User-Agent': UA } });
  };

  const direct = /https?:\/\/[^"'\\\s<>]+\.(?:m3u8|mp4)(?:\?[^"'\\\s<>]*)?/gi;
  let m;
  while ((m = direct.exec(html))) add(decodeHtml(m[0]), /m3u8/i.test(m[0]) ? 'ShoofVIP HLS' : 'ShoofVIP MP4');

  const encoded = /(?:video_url|file|url|src|source)=([A-Za-z0-9+/=_-]{40,})/gi;
  while ((m = encoded.exec(html))) {
    const v = b64decode(m[1].replace(/-/g,'+').replace(/_/g,'/'));
    if (/^https?:\/\//i.test(v) && /\.(?:m3u8|mp4)/i.test(v)) add(v, /m3u8/i.test(v) ? 'ShoofVIP HLS' : 'ShoofVIP MP4');
  }

  const iframes = [];
  const ifr = /<iframe[^>]+src=["']([^"']+)["']/gi;
  while ((m = ifr.exec(html))) iframes.push(abs(decodeHtml(m[1]), pageUrl));

  return { streams: out, iframes: unique(iframes) };
}

function serverNameFromHost(host) {
  const h = String(host || '').toLowerCase();
  if (h.includes('cdnplus')) return 'CDNPlus';
  if (h.includes('mp4plus')) return 'MP4Plus';
  if (h.includes('anafast')) return 'AnaFast';
  if (h.includes('vidoba')) return 'Vidoba';
  if (h.includes('vidspeed')) return 'VidSpeed';
  if (h.includes('ok.ru')) return 'OK';
  return 'ShoofVIP Server';
}

function addExternal(out, url, title, referer) {
  if (!url) return;
  out.push({
    name: 'ShoofVIP',
    title,
    externalUrl: url,
    behaviorHints: { notWebReady: true },
    headers: { Referer: referer || SITE + '/', 'User-Agent': UA }
  });
}

function anaplayerServerUrls(iframeUrl, html) {
  const out = [];
  const seen = new Set();
  const add = (u, name) => {
    if (!u || seen.has(u)) return;
    seen.add(u);
    out.push({ url: u, name: name || serverNameFromHost(new URL(u).hostname) });
  };

  // AnaPlayer uses ?serv=0..N. Discover the base path from the iframe itself.
  try {
    const u = new URL(iframeUrl);
    u.search = '';
    for (let i = 0; i < 8; i++) {
      const x = new URL(u.href);
      x.searchParams.set('serv', String(i));
      add(x.href, `AnaPlayer Server ${i + 1}`);
    }
  } catch (_) {}

  // Also capture any explicit AnaPlayer server links present in the page.
  const re = /href=["']([^"']*anaplayer[^"']*(?:serv=\d+)[^"']*)["']/gi;
  let m;
  while ((m = re.exec(html || ''))) add(abs(decodeHtml(m[1]), iframeUrl));
  return out;
}

async function resolveAnaPlayer(iframeUrl, referer) {
  const out = [];
  const basePage = await request(iframeUrl).catch(() => null);
  if (!basePage) return out;

  const servers = anaplayerServerUrls(iframeUrl, basePage.html);
  // First resolve each selected server. This is the important part missing in v1.
  for (const srv of servers) {
    const page = await request(srv.url).catch(() => null);
    if (!page) continue;

    const x = extractDirect(page.html, srv.url);
    for (const st of x.streams) {
      st.title = srv.name + (st.title ? ' • ' + st.title : '');
      st.headers = { ...(st.headers || {}), Referer: srv.url, 'User-Agent': UA };
      out.push(st);
    }

    // The selected AnaPlayer page normally contains the actual provider iframe.
    for (const nested of x.iframes.slice(0, 3)) {
      const nestedPage = await request(nested).catch(() => null);
      if (!nestedPage) {
        // If the provider blocks server-side fetching, at least expose the working player URL.
        addExternal(out, nested, srv.name, srv.url);
        continue;
      }
      const nx = extractDirect(nestedPage.html, nested);
      for (const st of nx.streams) {
        st.title = srv.name + (st.title ? ' • ' + st.title : '');
        st.headers = { ...(st.headers || {}), Referer: nested, 'User-Agent': UA };
        out.push(st);
      }
      if (!nx.streams.length) addExternal(out, nested, srv.name, srv.url);
    }

    // If extraction failed completely, returning the selected AnaPlayer server is
    // still useful and prevents Nuvio from reporting "No streams found".
    if (!x.streams.length && !x.iframes.length) {
      addExternal(out, srv.url, srv.name, iframeUrl);
    }
  }
  return uniqueStreams(out);
}

async function resolveEmbed(iframeUrl, referer, depth = 0) {
  const out = [];
  if (!iframeUrl || depth > 2) return out;

  // ShoofVIP currently routes its episode iframe through AnaPlayer.
  if (/anaplayer\.online/i.test(iframeUrl)) {
    return resolveAnaPlayer(iframeUrl, referer);
  }

  const page = await request(iframeUrl).catch(() => null);
  if (!page) {
    addExternal(out, iframeUrl, serverNameFromHost(new URL(iframeUrl).hostname), referer);
    return out;
  }

  const x = extractDirect(page.html, iframeUrl);
  out.push(...x.streams);
  if (!x.streams.length && !x.iframes.length) {
    addExternal(out, iframeUrl, serverNameFromHost(new URL(iframeUrl).hostname), referer);
  }

  for (const nested of x.iframes.slice(0, 4)) {
    out.push(...await resolveEmbed(nested, iframeUrl, depth + 1));
  }
  return uniqueStreams(out);
}

builder.defineStreamHandler(async ({ id }) => {
  try {
    const pageUrl = urlFromId(id);
    const { html } = await request(pageUrl);
    const direct = extractDirect(html, pageUrl);
    let streams = direct.streams;
    for (const iframe of direct.iframes.slice(0, 6)) {
      streams = streams.concat(await resolveEmbed(iframe, pageUrl));
    }
    streams = uniqueStreams(streams);
    console.log('[ShoofVIP] streams', streams.length, pageUrl);
    return { streams };
  } catch (e) {
    console.log('[ShoofVIP] stream error:', e.message);
    return { streams: [] };
  }
});

const port = Number(process.env.PORT || 7000);
serveHTTP(builder.getInterface(), { port });
console.log(`ShoofVIP addon listening on port ${port}`);
