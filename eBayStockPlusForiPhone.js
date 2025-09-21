// ==UserScript==
// @name         YM Panel (Yahoo/Aucfan) – bottom-right, mobile-friendly
// @namespace    ymv-panel
// @description  Title, 売値($), 利益率(%), NM入札(¥), NM利益(¥), FP入札(¥), Category, Brand, Class, 販売個数。右下固定・モバイルは折りたたみ。Aucfan/Yahooで#ymvを引き継ぎ。×でタブを閉じるベストエフォート。
// @match        https://auctions.yahoo.co.jp/*
// @match        https://page.auctions.yahoo.co.jp/*
// @match        https://aucfan.com/*
// @match        https://aucview.aucfan.com/*
// @run-at       document-start
// @grant        GM_setValue
// @grant        GM_getValue
// ==/UserScript==
(function () {
  'use strict';

  /* ---------- storage helpers (GM_* or localStorage) ---------- */
  const S = {
    get(k, d) {
      try {
        if (typeof GM_getValue === 'function') return GM_getValue(k, d);
        const v = localStorage.getItem(k);
        return v === null ? d : v;
      } catch { return d; }
    },
    set(k, v) {
      try {
        if (typeof GM_setValue === 'function') GM_setValue(k, v);
        else localStorage.setItem(k, v);
      } catch {}
    }
  };

  const isMobile = () =>
    /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    (window.matchMedia && window.matchMedia('(max-width: 812px)').matches);

  const enc = s => { try { return encodeURIComponent(s); } catch { return ''; } };

  /* ---------- ymv payload pickup / persisting ---------- */
  const KEY_RAW = 'ymv:lastRaw';
  const KEY_COLLAPSED = 'ymv:collapsed';

  function getRawFromURL() {
    try {
      const u = new URL(location.href);
      let q = u.searchParams.get('ymv');
      if (!q) {
        const h = new URLSearchParams(location.hash.replace(/^#/, ''));
        q = h.get('ymv') || '';
      }
      return q || '';
    } catch { return ''; }
  }

  function parsePairs(rawEnc) {
    if (!rawEnc) return [];
    try {
      const dec = decodeURIComponent(rawEnc);
      return dec.split('|').map(s => {
        const i = s.indexOf('=');
        return i >= 0 ? [s.slice(0, i), s.slice(i + 1)] : [s, ''];
      });
    } catch { return []; }
  }

  function pairsToRaw(pairs) {
    return pairs.map(([k, v]) => `${k}=${v || ''}`).join('|');
  }

  function hashFromPairs(pairs) {
    return '#ymv=' + enc(pairsToRaw(pairs));
  }

  /* ---------- keep #ymv when clicking Yahoo item links ---------- */
  addEventListener('click', (e) => {
    const a = e.target && (e.target.closest ? e.target.closest('a') : null);
    if (!a) return;
    const href = a.getAttribute('href') || a.href || '';
    if (!href) return;
    const isItem = /page\.auctions\.yahoo\.co\.jp\/jp\/auction\//.test(href) || /\/jp\/auction\//.test(href);
    if (!isItem) return;
    if (/#.*\bymv=/.test(href) || /\?[^#]*\bymv=/.test(href)) return;

    const rawURL = getRawFromURL();
    const rawStored = S.get(KEY_RAW, '');
    const raw = rawURL || enc(rawStored || '');
    if (!raw) return;

    try {
      const [base] = href.split('#');
      a.href = base + '#ymv=' + raw;
    } catch {}
  }, true);

  /* ---------- number formatting ---------- */
  const yen = v => {
    if (v == null || v === '') return '';
    const n = Number(String(v).replace(/[^\d.-]/g, ''));
    if (!isFinite(n)) return String(v);
    return '¥' + n.toLocaleString('ja-JP', { maximumFractionDigits: 0 });
  };
  const usd = v => {
    if (v == null || v === '') return '';
    const n = Number(String(v).replace(/[^\d.-]/g, ''));
    if (!isFinite(n)) return '$' + String(v);
    const hasDec = String(v).includes('.');
    return '$' + (hasDec
      ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : n.toLocaleString('en-US'));
  };
  const pct = v => {
    if (v == null || v === '') return '';
    const n = Number(String(v).replace(/[^\d.-]/g, ''));
    if (!isFinite(n)) return String(v);
    return Math.round(n * 100) + '%';
  };

  /* ---------- copy number (iOS friendly) ---------- */
  function copyNumber(raw, btn) {
    const num = String(raw || '').replace(/[^\d.-]/g, '');
    if (!num) { flash(btn, 'No Value'); return false; }
    const okLegacy = legacyCopy(num);
    if (okLegacy) { flash(btn, 'Copied!'); return true; }
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(num).then(() => flash(btn, 'Copied!')).catch(() => flash(btn, 'Copy NG'));
      return true;
    }
    flash(btn, 'Copy NG'); return false;

    function legacyCopy(text) {
      try {
        const el = document.createElement('input');
        el.value = text;
        el.setAttribute('readonly', '');
        el.style.cssText = 'position:fixed;top:0;left:0;opacity:0.01;pointer-events:none;z-index:-1;';
        document.body.appendChild(el);
        el.focus({ preventScroll: true });
        el.select();
        el.setSelectionRange(0, el.value.length);
        const ok = document.execCommand('copy');
        document.body.removeChild(el);
        return ok;
      } catch { return false; }
    }
  }

  function flash(btn, msg) {
    if (!btn) return;
    const o = btn.textContent;
    btn.textContent = msg;
    setTimeout(() => { btn.textContent = o; }, 900);
  }

  /* ---------- close tab (best-effort for Safari) ---------- */
  function closeTabBestEffort() {
    try { window.close(); } catch {}
    setTimeout(() => {
      try { window.open('', '_self').close(); } catch {}
      setTimeout(() => {
        if (document.referrer) history.back();
        else location.href = 'about:blank';
      }, 120);
    }, 60);
  }

  /* ---------- build bottom-right panel ---------- */
  const ID = 'ymv-panel';
  let lastSig = '';

  function getVal(pairs, keys) {
    for (const k of keys) {
      const kv = pairs.find(([kk]) => kk === k);
      if (kv) return kv[1];
    }
    return '';
  }

  function buildPanel(pairs) {
    const sig = pairsToRaw(pairs);
    if (sig === lastSig && document.getElementById(ID)) return;
    lastSig = sig;

    // Persist raw for next pages (Aucfanなど)
    S.set(KEY_RAW, sig);

    // values
    const title       = getVal(pairs, ['Title']) || document.title.replace(/\s*\|\s*ヤフオク!.*/, '');
    const usdVal      = getVal(pairs, ['売値(USD)']);
    const profitRaw   = getVal(pairs, ['利益率', 'TARGET_PROFIT_RATE']);
    const nmBidRaw    = getVal(pairs, ['NM入札', 'NM｜入札', 'NM|入札']);
    const nmProfitRaw = getVal(pairs, ['NM利益', 'NM｜利益', 'NM|利益']);
    const fpBidRaw    = getVal(pairs, ['FP入札', 'FP｜入札', 'FP|入札']);
    const category    = getVal(pairs, ['Category']);
    const brand       = getVal(pairs, ['Brand']);
    const klass       = getVal(pairs, ['Class']);
    const sold        = getVal(pairs, ['販売個数', '売']);

    // Aucfan link（ID優先） + #ymv継承
    const m = location.href.match(/\bauction\/([A-Za-z0-9]+)\b/i);
    const aucId = m ? m[1] : '';
    const aucfanId = aucId ? ('https://aucfan.com/aucview/yahoo/' + enc(aucId) + '/') : '';
    const aucfanQ  = 'https://aucfan.com/search1/?q=' + enc(title || '');
    const aucURL   = (aucfanId || aucfanQ) + hashFromPairs(pairs);

    // order
    const ordered = [];
    ordered.push(['Title',     title]);
    if (usdVal)        ordered.push(['売値',     usd(usdVal)]);
    if (profitRaw!=='')ordered.push(['利益率',   pct(profitRaw)]);
    if (nmBidRaw)      ordered.push(['NM入札',   yen(nmBidRaw)]);
    if (nmProfitRaw)   ordered.push(['NM利益',   yen(nmProfitRaw)]);
    if (fpBidRaw)      ordered.push(['FP入札',   yen(fpBidRaw)]);
    if (category)      ordered.push(['Category', category]);
    if (brand)         ordered.push(['Brand',    brand]);
    if (klass)         ordered.push(['Class',    klass]);
    if (sold!=='')     ordered.push(['販売個数', sold]);

    // remove old
    let box = document.getElementById(ID);
    if (box) box.remove();

    // create
    box = document.createElement('div');
    box.id = ID;
    box.style.cssText = [
      // 右下固定＋常に画面内（12pxマージン）
      'position:fixed;bottom:12px;right:12px;z-index:2147483647;',
      // パネル見た目
      'background:#216D89;border:1px solid #1b5870;border-radius:12px;',
      'box-shadow:0 8px 20px rgba(0,0,0,.25);',
      'color:#fff;font:14px/1.4 -apple-system,system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif;',
      // 幅はモバイルでもはみ出さない
      'min-width:240px;max-width:90vw;padding:8px 8px 6px;'
    ].join('');

    const hdr = document.createElement('div');
    hdr.style.cssText = 'display:flex;align-items:center;gap:6px;margin:0 0 4px;';
    const ttl = document.createElement('div');
    ttl.textContent = 'YM 見積';
    ttl.style.cssText = 'font-weight:700;flex:1;min-width:0;color:#fff;';
    const tgl = document.createElement('button');
    tgl.textContent = '▾';
    tgl.title = '開く/たたむ';
    tgl.style.cssText = btnStyle(true);
    hdr.appendChild(ttl); hdr.appendChild(tgl);

    const list = document.createElement('div');
    list.style.cssText = 'margin:0 4px 6px;max-height:50vh;overflow:auto;';
    ordered.forEach(([k, v]) => {
      const row = document.createElement('div');
      row.style.cssText = 'margin:2px 0;';
      const kEl = document.createElement('span');
      kEl.textContent = k;
      kEl.style.cssText = 'display:inline-block;min-width:96px;color:rgba(255,255,255,.85);';
      const vEl = document.createElement('span');
      vEl.textContent = v;
      vEl.style.cssText = 'font-weight:700;color:#fff;';
      row.appendChild(kEl); row.appendChild(vEl);
      list.appendChild(row);
    });

    const btns = document.createElement('div');
    btns.style.cssText = 'display:flex;gap:6px;flex-wrap:nowrap;justify-content:flex-end;';
    const aAuc = document.createElement('a');
    aAuc.textContent = 'Aucfan';
    aAuc.href = aucURL; aAuc.target = '_blank';
    aAuc.style.cssText = btnStyle();
    const bNM = document.createElement('button');
    bNM.textContent = 'NM｜入札';
    bNM.style.cssText = btnStyle();
    const bFP = document.createElement('button');
    bFP.textContent = 'FP｜入札';
    bFP.style.cssText = btnStyle();
    const bClose = document.createElement('button');
    bClose.textContent = '×';
    bClose.style.cssText = btnStyle(true);

    btns.appendChild(aAuc); btns.appendChild(bNM); btns.appendChild(bFP); btns.appendChild(bClose);

    box.appendChild(hdr);
    box.appendChild(list);
    box.appendChild(btns);
    document.documentElement.appendChild(box);

    // collapsed state（モバイルは既定で畳む）
    let collapsed = S.get(KEY_COLLAPSED, '__UNSET__');
    collapsed = (collapsed === '__UNSET__') ? isMobile() : (collapsed === 'true' || collapsed === true);
    setCollapsed(collapsed);

    function setCollapsed(flag) {
      collapsed = !!flag;
      list.style.display = collapsed ? 'none' : 'block';
      tgl.textContent = collapsed ? '▸' : '▾';
      S.set(KEY_COLLAPSED, String(collapsed));
    }

    tgl.addEventListener('click', () => setCollapsed(!collapsed));
    bNM.addEventListener('click', () => copyNumber(nmBidRaw, bNM));
    bFP.addEventListener('click', () => copyNumber(fpBidRaw, bFP));
    bClose.addEventListener('click', closeTabBestEffort);

    function btnStyle(narrow = false) {
      return [
        'all:initial;display:inline-block;',
        'padding:4px 8px;',
        'border:1px solid rgba(255,255,255,.45);border-radius:6px;',
        'cursor:pointer;background:rgba(255,255,255,.10);color:#fff;font-size:12px;',
        'text-align:center;', narrow ? 'min-width:28px;' : ''
      ].join('');
    }
  }

  /* ---------- render control ---------- */
  function render() {
    const raw = getRawFromURL();
    if (raw) {
      const pairs = parsePairs(raw);
      if (pairs.length) {
        S.set(KEY_RAW, pairsToRaw(pairs));
        buildPanel(pairs);
        return;
      }
    }
    const saved = S.get(KEY_RAW, '');
    if (saved) {
      const pairs = saved.split('|').map(s => {
        const i = s.indexOf('='); return i >= 0 ? [s.slice(0, i), s.slice(i + 1)] : [s, ''];
      });
      buildPanel(pairs);
    }
  }

  // SPA対応（Aucfan/Yahooの動的遷移）
  const _push = history.pushState, _replace = history.replaceState;
  const ping = () => window.dispatchEvent(new Event('ymv:urlchange'));
  history.pushState = function(){ _push.apply(this, arguments); ping(); };
  history.replaceState = function(){ _replace.apply(this, arguments); ping(); };
  addEventListener('popstate', ping);

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', render); else render();
  addEventListener('pageshow', render);
  addEventListener('ymv:urlchange', render);
  addEventListener('hashchange', render);

  new MutationObserver(() => {
    if (!document.getElementById(ID)) render();
  }).observe(document.documentElement, { childList: true, subtree: true });
  setInterval(() => { if (!document.getElementById(ID)) render(); }, 1200);
})();
