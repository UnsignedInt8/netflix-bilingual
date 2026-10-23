// ==UserScript==
// @name         Netflix Bilingual Subtitles (English Learning)
// @namespace    https://github.com/local/netflix-bilingual
// @version      0.1.2
// @description  Always show English subtitles under the Netflix subtitle you picked (e.g. Chinese), for learning English.
// @match        https://www.netflix.com/*
// @run-at       document-start
// @inject-into  page
// @grant        none
// ==/UserScript==

function nfBilingualMain() {
  'use strict';

  if (window.__nfBilingual) return;
  document.documentElement.setAttribute('data-nf-bilingual', 'hooks');

  // ---- settings ----------------------------------------------------------
  const LEARN_LANG = 'en';          // language that is always shown
  // Subtitle formats we ask Netflix for, best first (same set the well-known
  // subtitle downloader requests).
  const FORMATS = ['webvtt-lssdh-ios8', 'dfxp-ls-sdh', 'simplesdh', 'imsc1.1'];
  const FONT_RATIO = 0.034;         // font size relative to player height
  const GAP_PX = 4;                 // gap between native subtitle and ours
  const TICK_MS = 100;
  const STORAGE_KEY = 'nfBilingual.enabled';
  const LOG = '[NF-Bilingual]';

  const manifests = new Map();      // movieId -> text tracks[]
  const idMap = new Map();          // page/video id -> manifest movieId
  const cueCache = new Map();       // movieId -> Promise<cue[]|null>

  // ---- manifest hooks ----------------------------------------------------
  // Ask Netflix for text-based subtitle formats (and all languages) when the
  // player requests its manifest, then remember the tracks of the response.
  const stats = { patched: 0, manifests: 0, parseCalls: 0, mentions: 0 };
  let lastDbg = '';
  function dbg(msg) {            // log only when the message changes
    if (msg !== lastDbg) { lastDbg = msg; console.log(LOG, msg); }
  }

  const MANIFEST_URL = /manifest|licensedManifest/;
  const looksLikeProfiles = (a) => a.length && a.every((s) => typeof s === 'string') &&
    a.some((s) => /^(playready|heaac|dfxp|simplesdh|vp9|h264|av1)/.test(s));

  function patchProfiles(h, strict) {
    if (!h || typeof h !== 'object' || !Array.isArray(h.profiles)) return false;
    if (strict && !looksLikeProfiles(h.profiles)) return false;
    for (const f of FORMATS) if (!h.profiles.includes(f)) h.profiles.unshift(f);
    if (h.showAllSubDubTracks != null) h.showAllSubDubTracks = true;
    return true;
  }

  const rawStringify = JSON.stringify;
  JSON.stringify = function (value) {
    try {
      if (value && typeof value === 'object') {
        let hit = false;
        if (typeof value.url === 'string' && MANIFEST_URL.test(value.url)) {
          for (const k in value) hit = patchProfiles(value[k], false) || hit;
        } else {
          for (const h of [value, value.params, value.data && value.data.params]) {
            if (patchProfiles(h, true)) { hit = true; break; }
          }
        }
        if (hit) { stats.patched++; console.log(LOG, 'manifest request patched'); }
        // the page URL id can differ from the manifest's movieId
        const ui = value.params && value.params.sessionParams && value.params.sessionParams.uiplaycontext;
        if (typeof value.movieId === 'number' && ui && ui.video_id) {
          idMap.set(String(ui.video_id), String(value.movieId));
        }
      }
    } catch (e) { /* never break the page */ }
    return rawStringify.apply(this, arguments);
  };

  const tracksOf = (o) => (Array.isArray(o.timedtexttracks) ? o.timedtexttracks
    : Array.isArray(o.textTracks) ? o.textTracks : null);

  // Find the track list anywhere in a parsed payload, with the nearest movieId.
  function findTracks(o, movieId, depth) {
    if (!o || typeof o !== 'object' || depth > 6) return null;
    if (o.movieId) movieId = o.movieId;
    const tracks = tracksOf(o);
    if (tracks && movieId) return { movieId, tracks };
    for (const k in o) {
      const hit = findTracks(o[k], movieId, depth + 1);
      if (hit) return hit;
    }
    return null;
  }

  const describe = (t) => t.language + '/' + t.rawTrackType +
    '[' + Object.keys(t.ttDownloadables || t.downloadables || {}).join(',') + ']';

  const rawParse = JSON.parse;
  JSON.parse = function () {
    const result = rawParse.apply(this, arguments);
    try {
      const text = arguments[0];
      stats.parseCalls++;
      if (typeof text === 'string' && (text.indexOf('timedtexttracks') > -1 || text.indexOf('textTracks') > -1)) {
        stats.mentions++;
        const hit = findTracks(result, null, 0);
        if (hit) {
          manifests.set(String(hit.movieId), hit.tracks);
          stats.manifests++;
          console.log(LOG, 'manifest', hit.movieId, 'tracks:', hit.tracks.map(describe).join(' '));
        }
      }
    } catch (e) { /* ignore */ }
    return result;
  };

  // ---- subtitle loading --------------------------------------------------
  // Returns { url, format } for the best available format of a track.
  function trackSource(track) {
    const dl = track.ttDownloadables || track.downloadables;
    if (!dl) return null;
    for (const format of FORMATS) {
      const d = dl[format];
      if (!d) continue;
      const urls = d.downloadUrls
        ? Object.values(d.downloadUrls)
        : (d.urls || []).map((u) => (u && u.url) || u);
      const url = urls.find((u) => typeof u === 'string');
      if (url) return { url, format };
    }
    return null;
  }

  function pickTrack(tracks) {
    const cands = tracks.filter((t) =>
      !t.isNoneTrack && !t.isForcedNarrative &&
      String(t.language || '').toLowerCase().split('-')[0] === LEARN_LANG &&
      trackSource(t));
    // Prefer plain subtitles over closed captions ("[door slams]" etc.)
    return cands.find((t) => t.rawTrackType === 'subtitles') || cands[0] || null;
  }

  const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', lrm: '', rlm: '' };
  function decode(s) {
    return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      if (e[0] === '#') {
        const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return String.fromCodePoint(code);
      }
      const v = ENTITIES[e.toLowerCase()];
      return v === undefined ? m : v;
    });
  }

  function toSeconds(ts) {
    const parts = ts.replace(',', '.').split(':').reverse().map(Number);
    return parts[0] + (parts[1] || 0) * 60 + (parts[2] || 0) * 3600;
  }

  function parseVTT(text) {
    const cues = [];
    const re = /((?:\d+:)?\d+:\d+[.,]\d+)\s*-->\s*((?:\d+:)?\d+:\d+[.,]\d+)/;
    for (const block of text.replace(/\r/g, '').split(/\n{2,}/)) {
      const lines = block.split('\n');
      const i = lines.findIndex((l) => l.includes('-->'));
      if (i < 0) continue;
      const m = lines[i].match(re);
      if (!m) continue;
      const body = decode(lines.slice(i + 1).join('\n').replace(/<[^>]*>/g, '')).trim();
      if (body) cues.push({ start: toSeconds(m[1]), end: toSeconds(m[2]), text: body });
    }
    return cues.sort((a, b) => a.start - b.start);
  }

  // TTML / DFXP / IMSC: <p begin end>text<br/>text</p>
  function parseTTML(text) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    const root = doc.documentElement;
    const tickRate = Number(root && root.getAttribute('ttp:tickRate')) || 10000000;
    const time = (v) => {
      const m = /^(\d+(?:\.\d+)?)(h|ms|m|s|f|t)$/.exec(v || '');
      if (!m) return v ? toSeconds(v) : NaN;
      const n = Number(m[1]);
      return { h: n * 3600, m: n * 60, s: n, ms: n / 1000, f: n / 24, t: n / tickRate }[m[2]];
    };
    const flatten = (node) => {
      let out = '';
      for (const c of node.childNodes) {
        if (c.nodeType === 3) out += c.nodeValue;
        else if (c.nodeType === 1) out += c.localName === 'br' ? '\n' : flatten(c);
      }
      return out;
    };
    const cues = [];
    for (const p of doc.getElementsByTagName('p')) {
      const start = time(p.getAttribute('begin'));
      const end = time(p.getAttribute('end'));
      const body = flatten(p).replace(/[ \t]*\n[ \t]*/g, '\n').replace(/[ \t]+/g, ' ').trim();
      if (body && start >= 0 && end >= 0) cues.push({ start, end, text: body });
    }
    return cues.sort((a, b) => a.start - b.start);
  }

  function loadCues(movieId) {
    if (cueCache.has(movieId)) return cueCache.get(movieId);
    const tracks = manifests.get(movieId);
    const track = tracks && pickTrack(tracks);
    const source = track && trackSource(track);
    let p;
    if (!source) {
      console.warn(LOG, 'no usable', LEARN_LANG, 'subtitle track for', movieId,
        '(tracks: ' + (tracks || []).map(describe).join(' ') + ')');
      p = Promise.resolve(null);
    } else {
      p = fetch(source.url)
        .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
        .then((t) => {
          const cues = source.format.startsWith('webvtt') ? parseVTT(t) : parseTTML(t);
          console.log(LOG, 'loaded', cues.length, source.format, 'cues for', movieId);
          return cues;
        })
        .catch((err) => {
          console.warn(LOG, 'subtitle fetch failed', err);
          setTimeout(() => cueCache.delete(movieId), 5000);
          return null;
        });
    }
    cueCache.set(movieId, p);
    return p;
  }

  function cueAt(cues, t) {
    let lo = 0, hi = cues.length - 1, idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cues[mid].start <= t) { idx = mid; lo = mid + 1; } else hi = mid - 1;
    }
    // cues may overlap, so look back a little
    for (let i = idx; i >= 0 && i > idx - 4; i--) {
      if (cues[i].end > t) return cues[i];
    }
    return null;
  }

  // ---- Netflix player info -----------------------------------------------
  function playerInfo() {
    try {
      const api = window.netflix.appContext.state.playerApp.getAPI().videoPlayer;
      const ids = api.getAllPlayerSessionIds();
      const p = api.getVideoPlayerBySessionId(ids[ids.length - 1]);
      const track = p.getTimedTextTrack && p.getTimedTextTrack();
      return {
        movieId: p.getMovieId && p.getMovieId(),
        lang: track && String(track.bcp47 || track.language || '').toLowerCase(),
        // user switched subtitles to "Off"
        off: !track || !!track.isNoneTrack || /NONE/.test(String(track.trackId || '')),
      };
    } catch (e) {
      return {};
    }
  }

  // ---- overlay -----------------------------------------------------------
  let overlay = null;
  let shift = 0;                    // px we moved the native subtitles up
  let lastNativeBottom = null;      // px from container top (unshifted)
  let enabled = localStorage.getItem(STORAGE_KEY) !== '0';

  function ensureOverlay(container) {
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'nf-bilingual-sub';
      overlay.style.cssText = [
        'position:absolute', 'left:6%', 'right:6%', 'top:0', 'display:none',
        'text-align:center', 'pointer-events:none', 'z-index:10',
        'color:#fff', 'font-weight:500', 'line-height:1.25', 'white-space:pre-wrap',
        'font-family:"Netflix Sans","Helvetica Neue",Helvetica,Arial,sans-serif',
        'text-shadow:0 0 4px #000,0 0 4px #000,1px 1px 2px #000,-1px -1px 2px #000',
      ].join(';');
    }
    if (overlay.parentElement !== container) {
      if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
      container.appendChild(overlay);
    }
  }

  // Netflix rewrites inline styles of its subtitle element about once a second,
  // so the shift lives in a stylesheet rule (!important) driven by a CSS
  // variable instead of an inline transform.
  function setNativeShift(px) {
    if (!document.getElementById('nf-bilingual-style')) {
      const st = document.createElement('style');
      st.id = 'nf-bilingual-style';
      st.textContent = '.player-timedtext{translate:0 var(--nfb-shift,0px) !important}';
      (document.head || document.documentElement).appendChild(st);
    }
    document.documentElement.style.setProperty('--nfb-shift', -px + 'px');
    shift = px;
  }

  function nativeBottom(container, cTop) {
    const tt = container.querySelector('.player-timedtext');
    if (!tt) return null;
    let bottom = null;
    for (const el of tt.querySelectorAll('span, img')) {
      if (el.tagName === 'SPAN' && !el.textContent.trim()) continue;
      const r = el.getBoundingClientRect();
      if (r.height > 0) bottom = Math.max(bottom === null ? -Infinity : bottom, r.bottom - cTop + shift);
    }
    return bottom;
  }

  function hide(container) {
    if (overlay) { overlay.style.display = 'none'; overlay.textContent = ''; }
    if (shift) setNativeShift(0);
  }

  function render(video, text) {
    const container = video.closest('.watch-video--player-view') || video.parentElement;
    if (!text) { hide(container); return; }
    ensureOverlay(container);
    const cRect = container.getBoundingClientRect();
    if (overlay.textContent !== text) overlay.textContent = text;
    overlay.style.fontSize = Math.round(cRect.height * FONT_RATIO) + 'px';
    overlay.style.display = 'block';

    const nb = nativeBottom(container, cRect.top);
    if (nb !== null) lastNativeBottom = nb;
    const base = lastNativeBottom !== null ? lastNativeBottom : cRect.height * 0.86;
    let top = base + GAP_PX;
    const overflow = top + overlay.offsetHeight - cRect.height * 0.97;
    const newShift = Math.max(0, Math.round(overflow));
    if (newShift !== shift) setNativeShift(newShift);
    overlay.style.top = Math.round(top - newShift) + 'px';
  }

  // ---- main loop ---------------------------------------------------------
  let lastKey = '';
  let subsOff = false;
  function tick() {
    const video = document.querySelector('video');
    const urlId = (location.pathname.match(/^\/watch\/(\d+)/) || [])[1];
    if (!video || !urlId) {
      if (overlay && overlay.style.display !== 'none') hide(overlay.parentElement);
      lastNativeBottom = null;
      return;
    }
    if (!enabled) { hide(overlay && overlay.parentElement); dbg('disabled (Alt+E)'); return; }

    const info = playerInfo();
    subsOff = !!info.off;
    if (subsOff) {                      // user turned subtitles off
      hide(overlay && overlay.parentElement);
      dbg('subtitles are off');
      return;
    }
    if (info.lang && info.lang.split('-')[0] === LEARN_LANG) { // already English
      hide(overlay && overlay.parentElement);
      dbg('selected subtitle is already English: ' + info.lang);
      return;
    }

    const movieId = [String(info.movieId || ''), idMap.get(urlId), urlId].find((id) => id && manifests.has(id));
    if (!movieId) {
      hide(overlay && overlay.parentElement);
      dbg('no manifest for movie ' + urlId + '/' + info.movieId + ' (have: ' + [...manifests.keys()] + ', patched requests: ' + stats.patched + ', JSON.parse calls: ' + stats.parseCalls + ')');
      return;
    }
    dbg('using movie ' + movieId + ', native lang=' + (info.lang || 'unknown'));
    if (movieId !== lastKey) { lastKey = movieId; lastNativeBottom = null; }

    loadCues(movieId).then((cues) => {
      if (!cues) { dbg('no English cues for ' + movieId); return; }
      if (!enabled || subsOff) return;
      const cue = cueAt(cues, video.currentTime);
      render(video, cue ? cue.text : '');
    });
  }

  setInterval(tick, TICK_MS);

  // Alt+E toggles the English line
  window.addEventListener('keydown', (e) => {
    if (e.altKey && e.code === 'KeyE') {
      enabled = !enabled;
      localStorage.setItem(STORAGE_KEY, enabled ? '1' : '0');
      console.log(LOG, enabled ? 'on' : 'off');
    }
  }, true);

  window.__nfBilingual = { manifests, cueCache, parseVTT, parseTTML, pickTrack, stats, idMap, playerInfo,
    dump: () => JSON.stringify({ stats, manifests: [...manifests.keys()], player: playerInfo() }, null, 1) };
  console.log(LOG, 'hooks installed');
}

// Userscript managers on Safari may run us in an isolated world, where hooking
// JSON.parse/stringify would not affect Netflix. Inject into the page's own
// world first (inline, then Blob URL); run directly only if both are blocked.
(function bootstrap() {
  const root = document.documentElement;
  const injected = () => root.hasAttribute('data-nf-bilingual');
  const code = '(' + nfBilingualMain.toString() + ')();';
  const attempts = [
    () => {
      const s = document.createElement('script');
      s.textContent = code;
      root.appendChild(s);
      s.remove();
    },
    () => {
      const s = document.createElement('script');
      s.src = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
      root.appendChild(s);
      s.addEventListener('load', () => { URL.revokeObjectURL(s.src); s.remove(); });
    },
  ];
  for (const attempt of attempts) {
    try { attempt(); } catch (e) { /* try next */ }
    if (injected()) return;
  }
  // Blob scripts load asynchronously; give them a moment before falling back.
  setTimeout(() => { if (!injected()) nfBilingualMain(); }, 0);
})();
