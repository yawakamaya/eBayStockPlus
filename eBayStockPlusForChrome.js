// ==UserScript==
// @name         YM Panel (Yahoo/Aucfan) – NM/FPワンタン入札予約（form限定で安全送信）
// @namespace    ymv-panel-sticky
// @description  商品ページの「NM入札(¥)」「FP入札(¥)」行から、その価格で Aucfan の入札予約を自動実行。aucviewモーダル/aucfan confirm で form 起点に価格投入→同一formの submit だけをクリックして誤操作を防止。UI配置（Aucfan/TPはヘッダー左側、eBay高順→基準売値行, 安順→現在安値行, USDは小数2桁）を維持。A列のymvに含まれる Terapeak/eBay リンク（TERAPEAK_URL / EBAY_HIGH_URL / EBAY_LOW_URL）を優先使用。
// @match        https://auctions.yahoo.co.jp/*
// @match        https://page.auctions.yahoo.co.jp/*
// @match        https://aucfan.com/*
// @match        https://aucview.aucfan.com/*
// @match        https://tools.aucfan.com/snipe/*
// @match        https://auth.login.yahoo.co.jp/*
// @run-at       document-start
// @grant        GM_setValue
// @grant        GM_getValue
// ==/UserScript==
(function () {
  'use strict';

  /* ---------- SPA URL 変化検知 ---------- */
  const _push = history.pushState, _replace = history.replaceState;
  const fire = () => window.dispatchEvent(new Event('ymv:urlchange'));
  history.pushState = function () { _push.apply(this, arguments); fire(); };
  history.replaceState = function () { _replace.apply(this, arguments); fire(); };
  addEventListener('popstate', fire);

  /* ---------- 共有ストレージ ---------- */
  const K = 'ymv:lastPayload', T = 'ymv:lastTime', EXP = 30 * 60 * 1000;
  const SNIPE = 'ymv:autoSnipe'; // {aid, price, title, link}
  const now = () => Date.now();
  const enc = s => { try { return encodeURIComponent(s); } catch { return ''; } };
  const toStr = pairs => pairs.map(([k, v]) => k + '=' + (v || '')).join('|');

  // === 追加：フロー印（パネル継続表示フラグ） ===
  const KEEP_FLAG = 'ymv_keep';
  let flowClickerAttached = false;

  function hasKeepFlag() {
    try {
      const u = new URL(location.href);
      if (u.searchParams.has(KEEP_FLAG)) return true;
      const h = new URLSearchParams(u.hash.replace(/^#/, ''));
      return h.has(KEEP_FLAG);
    } catch { return false; }
  }
  function stripKeepFlag() {
    try {
      const u = new URL(location.href);
      const sp = u.searchParams;
      const hs = new URLSearchParams(u.hash.replace(/^#/, ''));
      const had = sp.has(KEEP_FLAG) || hs.has(KEEP_FLAG);
      sp.delete(KEEP_FLAG);
      hs.delete(KEEP_FLAG);
      if (had) {
        const newHash = hs.toString();
        const newUrl = u.origin + u.pathname + (sp.toString() ? '?' + sp.toString() : '') + (newHash ? '#' + newHash : '');
        history.replaceState(null, '', newUrl);
      }
    } catch {}
  }
  // KEEPフラグがある時だけ使う、タブ縛り無しのロード
  async function loadPairsAnyTab() {
    try {
      const t = await GM_getValue(T, 0);
      if (!t || now() - t > EXP) return [];
      const raw = await GM_getValue(K, '');
      if (!raw) return [];
      return raw.split('|').map(s => {
        const i = s.indexOf('=');
        return i >= 0 ? [s.slice(0, i), s.slice(i + 1)] : [s, ''];
      });
    } catch { return []; }
  }

  function getYmvRaw() {
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

  const parse = q => {
    if (!q) return [];
    try {
      const dec = decodeURIComponent(q);
      return dec.split('|').map(s => {
        const i = s.indexOf('=');
        return i >= 0 ? [s.slice(0, i), s.slice(i + 1)] : [s, ''];
      });
    } catch { return []; }
  };

  async function savePairs(pairs) { try { await GM_setValue(K, toStr(pairs)); await GM_setValue(T, now()); } catch {} }
  async function loadPairs() {
    try {
      const t = await GM_getValue(T, 0);
      if (!t || now() - t > EXP) return [];
      const raw = await GM_getValue(K, '');
      if (!raw) return [];
      return raw.split('|').map(s => {
        const i = s.indexOf('=');
        return i >= 0 ? [s.slice(0, i), s.slice(i + 1)] : [s, ''];
      });
    } catch { return []; }
  }
  async function setAutoSnipe(obj) { try { await GM_setValue(SNIPE, JSON.stringify(obj || {})); } catch {} }
  async function getAutoSnipe() { try { const j = await GM_getValue(SNIPE, ''); return j ? JSON.parse(j) : {}; } catch { return {}; } }

  /* ---------- 共通ユーティリティ ---------- */
  const HOST = 'ymv-panel-host';
  let host, shadow, current = [];

  function ensureHost() {
    host = document.getElementById(HOST);
    if (!host) {
      host = document.createElement('div');
      host.id = HOST;
      host.style.cssText = 'position:fixed;bottom:12px;right:12px;z-index:2147483647;';
      document.documentElement.appendChild(host);
      shadow = host.attachShadow({ mode: 'open' });
    } else {
      shadow = host.shadowRoot || host.attachShadow({ mode: 'open' });
    }
  }

  const getRaw = (patterns) => {
    for (const pat of patterns) {
      for (const [k, v] of current) {
        if (typeof pat === 'string' && k === pat) return v;
        if (pat instanceof RegExp && pat.test(k)) return v;
      }
    }
    return '';
  };

  const toNum = v => {
    if (v == null || v === '') return NaN;
    const n = Number(String(v).replace(/[^\d.-]/g, ''));
    return isFinite(n) ? n : NaN;
  };

  const yen = v => {
    if (v == null || v === '') return '';
    const n = Number(String(v).replace(/[^\d.-]/g, ''));
    if (!isFinite(n)) return String(v);
    return '¥' + n.toLocaleString('ja-JP', { maximumFractionDigits: 0 });
  };

  const usd = v => {
    if (v == null || v === '') return '';
    const n = Number(String(v).replace(/[^\d.-]/g, ''));
    if (!isFinite(n)) return String(v);
    return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  const pct = v => {
    if (v == null || v === '') return '';
    const n = Number(String(v).replace(/[^\d.-]/g, ''));
    if (!isFinite(n)) return String(v);
    return Math.round(n * 100) + '%';
  };

  function flash(btn, msg) {
    if (!btn) return;
    const o = btn.textContent;
    btn.textContent = msg;
    setTimeout(() => btn.textContent = o, 900);
  }

  function normalizeUrl(u) {
    return String(u || '')
      .replace(/\uFF1D/g, '=')
      .replace(/\uFF06/g, '&')
      .replace(/\uFF1F/g, '?')
      .replace(/\uFF03/g, '#');
  }

  // 検索ページの A列キーワード（va or p）を取得（+ をスペース扱い）
  function getSearchKWFromUrl() {
    try {
      const u = new URL(normalizeUrl(location.href));
      const raw = (u.searchParams.get('va') || u.searchParams.get('p') || '');
      return raw.replace(/\+/g, ' ').trim();
    } catch { return ''; }
  }

  // eBay URLの _nkw を取り出す（+ をスペース扱い）
  function extractKeywords(ebayUrl, title) {
    try {
      const u = new URL(normalizeUrl(ebayUrl || ''));
      const kw = u.searchParams.get('_nkw') || '';
      if (kw) return kw.replace(/\+/g, ' ');
    } catch {}
    return String(title || '').trim();
  }

  // 文字列から「含める語」と「除外語」を分離（先頭が - のトークンを除外語とする）。+ も区切りとして扱う
  function splitPosNegFromString(str) {
    const s = String(str || '').replace(/[　]+/g, ' ').replace(/\+/g, ' ').trim();
    if (!s) return { pos: [], neg: [] };
    const raw = s.split(/\s+/);
    const pos = [], neg = [];
    for (let t of raw) {
      if (!t) continue;
      if (/^-[^\s-].*/.test(t)) {
        neg.push(t.replace(/^-+/, ''));
      } else {
        pos.push(t);
      }
    }
    const uniq = (arr) => Array.from(new Set(arr));
    return { pos: uniq(pos), neg: uniq(neg) };
  }

  // POS/NEG 配列から検索語文字列を組み立て
  function buildKeywordString(posArr, negArr) {
    const pos = (posArr || []).filter(Boolean).join(' ');
    const neg = (negArr || []).filter(Boolean).map(t => t.startsWith('-') ? t : '-' + t).join(' ');
    return [pos, neg].filter(Boolean).join(' ').trim().replace(/\s+/g, ' ');
  }

  /* ---------- eBay URL（フォールバック生成；A列が無いときのみ使用） ---------- */
  // ※ A列から渡ってくるURL（EBAY_LOW_URL/EBAY_HIGH_URL）があれば必ずそちらを使用する
  function buildEbayVariant(baseUrl, keywordFull, variant) {
    const safe = normalizeUrl(baseUrl || '');
    let candidate = safe || 'https://www.ebay.com/sch/i.html';
    try {
      const u = new URL(candidate);
      u.searchParams.set('_nkw', keywordFull || '');
      u.searchParams.set('LH_BIN', '1');
      if (variant === 'activeLow') {
        u.searchParams.delete('LH_Sold');
        u.searchParams.delete('LH_Complete');
        u.searchParams.set('_sop', '15'); // Price+Shipping: Lowest First
      } else if (variant === 'soldHigh') {
        u.searchParams.set('LH_Sold', '1');
        u.searchParams.set('LH_Complete', '1');
        u.searchParams.set('_sop', '16'); // Price+Shipping: Highest First
      }
      return u.toString();
    } catch (_) {
      let s = candidate;
      const encKW = encodeURIComponent(keywordFull || '');
      if (/[?&]_nkw=/.test(s)) s = s.replace(/([?&])_nkw=[^&]*/g, `$1_nkw=${encKW}`); else s += (s.includes('?') ? '&' : '?') + `_nkw=${encKW}`;
      if (/[?&]LH_BIN=/.test(s)) s = s.replace(/([?&])LH_BIN=[^&]*/,'$1LH_BIN=1'); else s += '&LH_BIN=1';
      if (variant === 'activeLow') {
        s = s.replace(/([?&])LH_Sold=1/g, '$1').replace(/([?&])LH_Complete=1/g, '$1');
        if (/[?&]_sop=/.test(s)) s = s.replace(/([?&])_sop=[^&]*/,'$1_sop=15'); else s += '&_sop=15';
      } else {
        if (!/[?&]LH_Sold=/.test(s)) s += '&LH_Sold=1';
        if (!/[?&]LH_Complete=/.test(s)) s += '&LH_Complete=1';
        if (/[?&]_sop=/.test(s)) s = s.replace(/([?&])_sop=[^&]*/,'$1_sop=16'); else s += '&_sop=16';
      }
      return s.replace(/&&+/g, '&').replace(/\?&/, '?');
    }
  }

  function buildTerapeakUrl(kw) {
    const now = Date.now(), DAY = 86400000;
    const u = new URL('https://www.ebay.com/sh/research');
    u.searchParams.set('marketplace', 'EBAY-US');
    u.searchParams.set('keywords', kw);
    u.searchParams.set('dayRange', '90');
    u.searchParams.set('startDate', String(now - 90 * DAY));
    u.searchParams.set('endDate', String(now));
    u.searchParams.set('categoryId', '0');
    u.searchParams.set('offset', '0');
    u.searchParams.set('limit', '50');
    u.searchParams.set('tabName', 'SOLD');
    u.searchParams.set('tz', 'Asia/Tokyo');
    return u.toString();
  }

  /* ---------- Aucfan 自動入札：URL生成 & 発火 ---------- */
  function getYahooAidFromUrl(u) {
    const m = String(u || location.href).match(/\/auction\/([A-Za-z0-9]+)\b/i);
    return m ? m[1] : '';
  }

  function startAutoSnipe(aid, price, title, link) {
    if (!aid || !price) {
      alert('入札予約に必要な情報が不足しました（aid/price）。');
      return;
    }
    const p = String(Math.floor(price));
    setAutoSnipe({ aid, price: p, title: title || '', link: link || location.href });
    const u = `https://aucview.aucfan.com/yahoo/${encodeURIComponent(aid)}/#ymv_snipe=${encodeURIComponent(p)}`;
    window.open(u, '_blank', 'noopener');
  }

  const isVisible = el =>
    !!(el &&
      getComputedStyle(el).display !== 'none' &&
      getComputedStyle(el).visibility !== 'hidden' &&
      el.offsetParent !== null);

  /* ---------- aucview：モーダル自動操作 ---------- */
  function tryAutoOnAucview() {
    const h = new URLSearchParams(location.hash.replace(/^#/, ''));
    const want = h.get('ymv_snipe');
    if (!want) return;

    const aidMatch = location.pathname.match(/\/yahoo\/([A-Za-z0-9]+)\b/);
    const aid = aidMatch ? aid[1] : '';
    setAutoSnipe({ aid, price: String(want) });

    const openModal = () => {
      const btn = Array.from(document.querySelectorAll('a,button')).find(el => /入札予約する/.test(el.textContent || ''));
      if (btn) { btn.click(); return true; }
      return false;
    };
    setTimeout(openModal, 300);
    setTimeout(openModal, 900);
    setTimeout(openModal, 1800);

    const poll = () => {
      const form = Array.from(document.querySelectorAll('form[action*="/snipe/item/confirm"]')).find(isVisible);
      if (!form) return;

      const field =
        form.querySelector('input[name="sss_bid_price"]:not([type="hidden"])') ||
        form.querySelector('#sss_bid_price') ||
        form.querySelector('input[type="number"],input[type="text"]');

      if (field && isVisible(field)) {
        field.focus();
        field.value = String(want);
        field.dispatchEvent(new Event('input', { bubbles: true }));
        field.dispatchEvent(new Event('change', { bubbles: true }));
        field.blur();
      }

      const submitBtn =
        form.querySelector('#snipBtn') ||
        Array.from(form.querySelectorAll('button[type="submit"],input[type="submit"]')).find(isVisible);
      if (submitBtn) { setTimeout(() => submitBtn.click(), 150); clearInterval(iv); }
    };
    const iv = setInterval(poll, 250);
    setTimeout(() => clearInterval(iv), 12000);
  }

  /* ---------- Yahoo同意ページの自動クリック ---------- */
  function tryAutoConsentYahoo() {
    const tryClick = () => {
      const byType = document.querySelector('button[type="submit"], input[type="submit"], .Button__button');
      if (byType) { byType.click(); return; }
      const byText = Array.from(document.querySelectorAll('button, input[type="submit"]'))
        .find(el => /同意|はじめる/.test(el.textContent || '') || /同意/.test(el.value || ''));
      if (byText) { byText.click(); }
    };
    setTimeout(tryClick, 400);
    setTimeout(tryClick, 1200);
    setTimeout(tryClick, 2200);
  }

  /* ---------- tools.aucfan：confirm/免責 まで自動 ---------- */
  function tryAutoOnAucfan() {
    const url = new URL(location.href);

    const injectPrice = (form, val) => {
      const cands = [
        'input[name="sss_bid_price"]', '#sss_bid_price',
        'input[name="snipe_price"]', 'input[name="bid_price"]',
        'input[type="number"]', 'input[type="text"]'
      ];
      for (const sel of cands) {
        const el = form.querySelector(sel);
        if (el && isVisible(el)) {
          el.focus();
          el.value = String(val);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          el.blur();
          return true;
        }
      }
      return false;
    };

    const clickConsent = () => {
      const b = document.querySelector('.act_consent button, button[onclick*="check_pass"]');
      if (b && isVisible(b)) { b.click(); notifyAndClose(); return true; }

      const hit = Array.from(document.querySelectorAll('button, input[type="submit"], a.button, .btn, .af-btn, .button'))
        .find(el => {
          const t = (el.textContent || el.value || '').replace(/\s/g, '');
          return isVisible(el) && (
            t.includes('免責事項を確認・同意の上、入札する') ||
            t.includes('同意の上入札') || t.includes('同意して入札')
          );
        });
      if (hit) { hit.click(); notifyAndClose(); return true; }

      return false;
    };

    const clickFormSubmit = (form) => {
      const submitBtn =
        form.querySelector('#snipBtn') ||
        Array.from(form.querySelectorAll('button[type="submit"],input[type="submit"]')).find(isVisible);
      if (submitBtn) { submitBtn.click(); return true; }
      return false;
    };

    const notifyAndClose = () => {
      try {
        const hostId = 'ymv-toast-host';
        let host = document.getElementById(hostId);
        if (!host) {
          host = document.createElement('div');
          host.id = hostId;
          host.style.cssText =
            'position:fixed;left:0;right:0;bottom:88px;display:flex;justify-content:center;' +
            'z-index:2147483647;pointer-events:none;';
          const sh = host.attachShadow({ mode: 'open' });
          sh.innerHTML = `
            <style>
              .toast{all: initial;display:inline-block;padding:12px 16px;border-radius:12px;background:#216D89;color:#fff;font:14px/1.3 -apple-system,system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:min(92vw,520px);text-align:center;pointer-events:auto;box-shadow:none;}
              .toast b{all: initial;font:700 14px/1.3 -apple-system,system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#fff;}
              .sub{all: initial;display:block;margin-top:4px;opacity:.9;font:12px/1.2 -apple-system,system-ui,Roboto,Helvetica,Arial,sans-serif;color:#fff;}
            </style>
            <div class="toast">
              <b>入札予約を完了しました</b>
              <span class="sub">このタブは自動で閉じます…</span>
            </div>`;
          document.documentElement.appendChild(host);
        }
      } catch {}
      setTimeout(() => { try { window.close(); } catch {} }, 1600);
    };

    const scheduleAutoClose = () => {
      const doneNow = () => {
        const bodyTxt = (document.body && document.body.innerText) || '';
        return /\/snipe\/item\/setsnipe/i.test(location.pathname) ||
          /入札予約を(登録|受け付け)しました|予約(が)?完了|予約を完了/.test(bodyTxt);
      };
      if (doneNow()) { setTimeout(() => window.close(), 700); return; }
      const iv = setInterval(() => { if (doneNow()) { clearInterval(iv); mo.disconnect?.(); setTimeout(() => window.close(), 700); } }, 350);
      const mo = new MutationObserver(() => { if (doneNow()) { clearInterval(iv); mo.disconnect(); setTimeout(() => window.close(), 700); } });
      mo.observe(document.documentElement, { childList: true, subtree: true });
      setTimeout(() => { clearInterval(iv); mo.disconnect?.(); }, 20000);
    };

    const go = async () => {
      scheduleAutoClose();
      const stash = await getAutoSnipe();
      const price = url.searchParams.get('sss_bid_price') || (stash && stash.price) || '';

      if (/\/snipe\/item\/confirm/.test(location.pathname)) {
        const form = document.querySelector('form[action*="/snipe/item/confirm"]') || document.querySelector('form');
        if (form && price) injectPrice(form, price);
        if (clickConsent()) return;
        if (form) clickFormSubmit(form);
        setTimeout(clickConsent, 400);
        setTimeout(clickConsent, 1200);
        setTimeout(clickConsent, 2500);
        return;
      }

      if (/\/snipe\/item\/confirm/.test(document.referrer || '')) {
        setTimeout(clickConsent, 300);
        setTimeout(clickConsent, 900);
        setTimeout(clickConsent, 1800);
      }
    };

    setTimeout(go, 400);
    setTimeout(go, 1200);
    setTimeout(go, 2500);
    setTimeout(go, 4500);
  }

  // ymv の HIST=... をパース
  function parseHistPayload(s) {
    s = String(s || '').replace(/\uFF1D/g, '=').replace(/\uFF1B/g, ';').replace(/\uFF0C/g, ',');
    const o = {};
    s.split(';').forEach(p => {
      const i = p.indexOf('=');
      if (i >= 0) o[p.slice(0, i)] = p.slice(i + 1);
    });
    const m = Number(o.m), step = Number(o.s), k = Number(o.k);
    const counts = String(o.v || '').split(',').map(x => Number(x)).filter(x => isFinite(x));
    return {
      min: isFinite(m) ? m : 0,
      step: isFinite(step) ? step : 1,
      bins: isFinite(k) ? k : counts.length,
      counts,
      currency: o.c || 'USD',
      current: Number(o.l),
      n: Number(o.n || 0)
    };
  }

  /* ===== Font Awesome の読込状態（必要時のみ） ===== */
  const ICON_MODE = 'fa';
  const FA_CSS = 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/css/all.min.css';
  let faReady = false;
  let faLinkInjected = false;
  function ensureFA() {
    if (ICON_MODE !== 'fa' || faLinkInjected) return;
    try {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = FA_CSS;
      link.onload = () => { faReady = true; };
      link.onerror = () => { faReady = false; };
      shadow.appendChild(link);
      faLinkInjected = true;
    } catch {}
  }
  function faBrandsOK() {
    try {
      if (!faReady) return false;
      return !!document.fonts && document.fonts.check('12px "Font Awesome 6 Brands"');
    } catch { return false; }
  }

  // ===== ヒストグラム描画 =====
  function renderHistogramSVG(hist, width = 360, height = 120){
    const {min, step, bins, counts, current} = hist;
    const maxC = Math.max(1, ...counts);
    const barW = width / bins;
    const gap  = Math.min(4, barW * 0.2);
    const base = 20;

    const TOP_HEADROOM = 14;
    const LABEL_MARGIN = 2;
    const top  = TOP_HEADROOM;

    const fmtDollar = (v)=>`$${Number(v).toFixed(2)}`;

    const svgNS = 'http://www.w3.org/2000/svg';
    const wrap = document.createElement('div');
    wrap.style.cssText = 'padding:6px 4px 2px;';

    const head = document.createElement('div');
    head.className = 'hist-head';
    head.style.cssText = `
      display:flex; align-items:baseline; justify-content:space-between;
      margin:2px 0 6px; gap:8px;`;
    head.style.width = width + 'px';

    const title = document.createElement('div');
    title.textContent = '価格ヒストグラム';
    title.style.cssText = 'font-weight:700;';
    head.appendChild(title);

    const meta = document.createElement('div');
    meta.className = 'hist-meta';
    meta.style.cssText = 'font:11px/1.2 -apple-system,system-ui,Segoe UI,Roboto,Helvetica,Arial; opacity:.9; margin-left:auto; text-align:right; white-space:nowrap;';
    head.appendChild(meta);

    wrap.appendChild(head);

    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('width', width);
    svg.setAttribute('height', height);
    svg.style.background = 'rgba(255,255,255,.08)';
    svg.style.borderRadius = '8px';
    svg.style.display = 'block';
    wrap.appendChild(svg);

    counts.forEach((c, i) => {
      const x  = i * barW + gap * 0.5;
      const ww = Math.max(1, barW - gap);
      const h  = Math.round((c / maxC) * (height - base - top));
      const y  = height - h - base;

      if (c > 0) {
        const R_MAX = 3.0;
        const R_W   = 0.22;
        const R_H   = 0.28;
        const r = Math.max(0, Math.min(R_MAX, ww * R_W, h * R_H));
        if (r >= 1.5) {
          const path = document.createElementNS(svgNS, 'path');
          path.setAttribute('d',
            `M ${x} ${y + r} Q ${x} ${y} ${x + r} ${y} ` +
            `L ${x + ww - r} ${y} Q ${x + ww} ${y} ${x + ww} ${y + r} ` +
            `L ${x + ww} ${y + h} L ${x} ${y + h} Z`);
          path.setAttribute('fill', 'white');
          path.setAttribute('opacity', '0.85');
          svg.appendChild(path);
        } else {
          const rect = document.createElementNS(svgNS, 'rect');
          rect.setAttribute('x', x);
          rect.setAttribute('y', y);
          rect.setAttribute('width', ww);
          rect.setAttribute('height', h);
          rect.setAttribute('fill', 'white');
          rect.setAttribute('opacity', '0.85');
          svg.appendChild(rect);
        }
        const low  = min + step * i;
        const high = min + step * (i + 1);
        svg.lastChild.setAttribute('title', `${fmtDollar(low)} 〜 ${fmtDollar(high)} : ${c}`);

        const tx = document.createElementNS(svgNS, 'text');
        tx.setAttribute('x', x + ww / 2);
        tx.setAttribute('y', Math.max(10, y - (LABEL_MARGIN + 1)));
        tx.setAttribute('text-anchor', 'middle');
        tx.setAttribute('font-size', '10');
        tx.setAttribute('fill', '#fff');
        tx.setAttribute('stroke', 'rgba(0,0,0,.45)');
        tx.setAttribute('stroke-width', '0.75');
        tx.setAttribute('paint-order', 'stroke');
        tx.textContent = String(c);
        svg.appendChild(tx);
      } else {
        const rect = document.createElementNS(svgNS, 'rect');
        rect.setAttribute('x', x);
        rect.setAttribute('y', height - base - 1);
        rect.setAttribute('width', ww);
        rect.setAttribute('height', 1);
        rect.setAttribute('fill', 'none');
        rect.setAttribute('stroke', 'rgba(255,255,255,0.25)');
        rect.setAttribute('stroke-width', '1');
        svg.appendChild(rect);
      }
    });

    if (isFinite(current)) {
      const dx = (current - min) / (step * bins);
      const cx = Math.max(0, Math.min(1, dx)) * width;

      const line = document.createElementNS(svgNS, 'line');
      line.setAttribute('x1', cx);
      line.setAttribute('x2', cx);
      line.setAttribute('y1', top);
      line.setAttribute('y2', height - base - 1);
      line.setAttribute('stroke', '#FF5D5D');
      line.setAttribute('stroke-width', '2');
      line.setAttribute('shape-rendering', 'crispEdges');
      svg.appendChild(line);

      const g = document.createElementNS(svgNS, 'g');
      svg.appendChild(g);

      const txt = document.createElementNS(svgNS, 'text');
      txt.setAttribute('font-size', '10');
      txt.setAttribute('fill', '#fff');
      txt.setAttribute('y', height - base + 14);
      txt.textContent = `NM安値 ${fmtDollar(current)}`;
      g.appendChild(txt);

      const bb = txt.getBBox();
      const padX = 6, w = bb.width + padX * 2;
      const maxVal = min + step * bins;
      const placeLeftSide = current <= (maxVal / 2);

      let xStart;
      if (placeLeftSide) {
        xStart = cx - 12;
        txt.setAttribute('text-anchor', 'start');
        txt.setAttribute('x', padX);
      } else {
        xStart = cx - (w - 10);
        txt.setAttribute('text-anchor', 'end');
        txt.setAttribute('x', w - padX);
      }

      xStart = Math.max(-2, Math.min(xStart, width - 2 - w));
      g.setAttribute('transform', `translate(${xStart},0)`);

      const dot = document.createElementNS(svgNS, 'circle');
      dot.setAttribute('cx', cx);
      dot.setAttribute('cy', height - base - 1);
      dot.setAttribute('r', 2.8);
      dot.setAttribute('fill', '#FF5D5D');
      dot.setAttribute('stroke', 'rgba(255,255,255,.95)');
      dot.setAttribute('stroke-width', '1');
      dot.setAttribute('pointer-events', 'none');
      svg.appendChild(dot);
    }

    const minT = document.createElement('div');
    const maxT = document.createElement('div');
    const maxVal2 = min + step * bins;
    minT.textContent = fmtDollar(min);
    maxT.textContent = fmtDollar(maxVal2);
    minT.style.cssText = 'font:11px/1.2 -apple-system,system-ui,Segoe UI,Roboto,Helvetica,Arial;margin-top:2px;opacity:.9;';
    maxT.style.cssText = 'font:11px/1.2 -apple-system,system-ui,Roboto,Helvetica,Arial;float:right;margin-top:-14px;opacity:.9;';
    wrap.appendChild(minT);
    wrap.appendChild(maxT);

    return wrap;
  }

  /* ---------- アイコン（SVG） ---------- */
  const AUC_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 640">
  <path fill="currentColor" d="M349.5 115.7C344.6 103.8 332.9 96 320 96C307.1 96 295.4 103.8 290.5 115.7C197.2 339.7 143.8 467.7 130.5 499.7C123.7 516 131.4 534.7 147.7 541.5C164 548.3 182.7 540.6 189.5 524.3L221.3 448L418.6 448L450.4 524.3C457.2 540.6 475.9 548.3 492.2 541.5C508.5 534.7 516.2 516 509.4 499.7C496.1 467.7 442.7 339.7 349.4 115.7zM392 384L248 384L320 211.2L392 384z"/>
</svg>`.trim();

  const TP_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 640">
  <path fill="currentColor" d="M160 96C142.3 96 128 110.3 128 128C128 145.7 142.3 160 160 160L288 160L288 512C288 529.7 302.3 544 320 544C337.7 544 352 529.7 352 512L352 160L480 160C497.7 160 512 145.7 512 128C512 110.3 497.7 96 480 96L160 96z"/>
</svg>`.trim();

  const EBAY_SEARCH_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 640" aria-hidden="true" focusable="false">
  <path fill="currentColor" d="M480 272C480 317.9 465.1 360.3 440 394.7L566.6 521.4C579.1 533.9 579.1 554.2 566.6 566.7C554.1 579.2 533.8 579.2 521.3 566.7L394.7 440C360.3 465.1 317.9 480 272 480C157.1 480 64 386.9 64 272C64 157.1 157.1 64 272 64C386.9 64 480 157.1 480 272zM272 416C351.5 416 416 351.5 416 272C416 192.5 351.5 128 272 128C192.5 128 128 192.5 128 272C128 351.5 192.5 416 272 416z"/>
</svg>`.trim();

  /* ---------- PANEL（UI） ---------- */
  function buildPanel(pairs) {
    current = pairs.slice(0);
    ensureHost();
    ensureFA();

    const title = getRaw(['Title']) || document.title.replace(/\s*\|\s*ヤフオク!.*/, '');

    const baseUsdRaw = getRaw([/^基準売値(?:\((?:USD|\$)\))?$/, /^売値(?:\((?:USD|\$)\))?$/]);

    // ▼ 現在安値（合算表示：本体 + 送料）
    const nowUsdRawAll   = getRaw([/^現在安値(?:\((?:USD|\$)\))?$/]);
    const nowUsdRawBody  = getRaw([/^現在安値\((?:USD|\$):本体\)$/]);
    const shipUsdRaw     = getRaw([/^送料\((?:USD|\$)\)$/]);

    // ---- ここから A列 ymv の URL を優先使用 ----
    const ebayLowFromYmv  = normalizeUrl(getRaw(['EBAY_LOW_URL'])  || '');
    const ebayHighFromYmv = normalizeUrl(getRaw(['EBAY_HIGH_URL']) || '');
    const tpFromYmv       = normalizeUrl(getRaw(['TERAPEAK_URL'])  || '');

    // ======== 検索語（除外語含む；フォールバック用） ========
    const ymvPos = (getRaw(['KW_POS']) || '').trim();
    const ymvNeg = (getRaw(['KW_NEG']) || '').trim();
    let posArr = ymvPos ? ymvPos.split(/\s+/).filter(Boolean) : [];
    let negArr = ymvNeg ? ymvNeg.split(/\s+/).filter(Boolean) : [];

    if (!posArr.length && !negArr.length) {
      const fromUrl = getSearchKWFromUrl();
      if (fromUrl) {
        const sp = splitPosNegFromString(fromUrl);
        posArr = sp.pos; negArr = sp.neg;
      }
    }
    if (!posArr.length && !negArr.length && title) {
      const sp = splitPosNegFromString(title);
      posArr = sp.pos; negArr = sp.neg;
    }
    const keywordFull = buildKeywordString(posArr, negArr);

    // eBay（高順/安順）リンク：A列があればそれを使用、無ければフォールバック生成
    const ebayActiveLow = ebayLowFromYmv  || buildEbayVariant('', keywordFull, 'activeLow');
    const ebaySoldHigh  = ebayHighFromYmv || buildEbayVariant('', keywordFull, 'soldHigh');

    // Terapeak：A列があればそれを使用、無ければフォールバック生成
    const tpURL = tpFromYmv || buildTerapeakUrl(keywordFull);

    const profRaw    = getRaw(['利益率', 'TARGET_PROFIT_RATE']);
    const altProfRaw = getRaw(['利益率(現安)', 'ALT_TARGET_PROFIT_RATE']);

    const nmBidRaw        = getRaw(['NM入札', 'NM｜入札', 'NM|入札']);
    const nmProfitRaw     = getRaw(['NM利益', 'NM｜利益', 'NM|利益']);
    const fpBidRaw        = getRaw(['FP入札', 'FP｜入札', 'FP|入札']);
    const nmBidNowRaw     = getRaw(['NM入札(現安)', 'NM|入札(現安)']);
    const nmProfitNowRaw  = getRaw(['NM利益(現安)', 'NM|利益(現安)']);
    const fpBidNowRaw     = getRaw(['FP入札(現安)', 'FP|入札(現安)']);

    const category = getRaw(['Category']);
    const brand    = getRaw(['Brand']);
    const klass    = getRaw(['Class']);
    const sold     = getRaw(['販売個数', '売']);

    const aucIdMatch = location.href.match(/\bauction\/([A-Za-z0-9]+)\b/i);
    const aucId = aucIdMatch ? aucIdMatch[1] : '';
    const aucfanId = aucId ? ('https://aucfan.com/aucview/yahoo/' + encodeURIComponent(aucId) + '/') : '';
    const aucfanQ  = 'https://aucfan.com/search1/?q=' + encodeURIComponent(title || '');
    const aucURL   = (aucfanId || aucfanQ) + '#ymv=' + enc(toStr(current));

    const nmBaseMain   = nmBidRaw !== '' ? yen(nmBidRaw) : '';
    const nmBaseProfit = nmProfitRaw !== '' ? yen(nmProfitRaw) : '';
    const nmLineBaseHtml = nmBaseMain
      ? `${nmBaseMain}${nmBaseProfit ? ` <span class="profit-sub">(利益 ${nmBaseProfit})</span>` : ''}`
      : '';

    const nmNowMain   = nmBidNowRaw !== '' ? yen(nmBidNowRaw) : '';
    const nmNowProfit = nmProfitNowRaw !== '' ? yen(nmProfitNowRaw) : '';
    const nmLineNowHtml = nmNowMain
      ? `${nmNowMain}${nmNowProfit ? ` <span class="profit-sub">(利益 ${nmNowProfit})</span>` : ''}`
      : '';

    // ▼ 現在安値の表示用HTML（合算 + かっこ内ブレークダウン/Free Shippinng）
    const bodyNum = toNum(nowUsdRawBody);
    const shipNum = toNum(shipUsdRaw);
    const allNum  = toNum(nowUsdRawAll);

    let nowSumNum;
    let nowParenHtml = '';

    if (!isNaN(bodyNum) && !isNaN(shipNum)) {
      nowSumNum = bodyNum + shipNum;
      nowParenHtml = shipNum > 0
        ? ` <span class="paren-sub">(${usd(bodyNum)}+${usd(shipNum)})</span>`
        : ` <span class="paren-sub">(FreeShippinng)</span>`;
    } else if (!isNaN(allNum)) {
      nowSumNum = allNum;
      if (!isNaN(shipNum)) {
        if (shipNum === 0) {
          nowParenHtml = ` <span class="paren-sub">(FreeShippinng)</span>`;
        } else {
          const inferredBody = allNum - shipNum;
          nowParenHtml = ` <span class="paren-sub">(${usd(inferredBody)}+${usd(shipNum)})</span>`;
        }
      }
    } else {
      nowSumNum = NaN; // 表示は "—"
    }

    shadow.innerHTML = `
<style>
  :host { all: initial; }
  :host{ --hb-size:22px; --hb-icon:14px; }
  .box{
    all:initial; display:block; background:#216D89; color:#fff;
    border:1px solid #1B5870; border-radius:12px; box-shadow:0 8px 20px rgba(0,0,0,.25);
    padding:8px 8px 6px; width:min(340px, 88vw);
    font:14px/1.4 -apple-system,system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif;
  }
  .header{
    display:flex;
    align-items:center;
    gap:6px;
    margin:-8px -8px 8px -8px;
    padding:8px;
    background:#063545;
    border-radius:12px 12px 0 0;
  }
  .title{font-weight:700; flex:1; min-width:0; color:#fff;}
  .headbtns{display:flex; gap:6px;}
  .btn{ all:initial; display:inline-block; text-align:center; padding:4px 8px; border-radius:6px; font-size:12px; cursor:pointer;
        border:1px solid rgba(255,255,255,.45); background:rgba(255,255,255,.10); color:#fff; }
  .btn.icon{ display:inline-flex; align-items:center; justify-content:center; width:var(--hb-size); height:var(--hb-size); padding:0; line-height:1; font-weight:700; }
  .btn.iconimg{ width:var(--hb-size); height:var(--hb-size); padding:0; display:inline-flex; align-items:center; justify-content:center; line-height:1; box-sizing:border-box; }
  .btn.iconimg svg{ height:var(--hb-icon); width:auto; display:block; }
  .btn:hover{ background:rgba(255,255,255,.18); }
  .btn.copy{ padding:2px 6px; font-size:11px; margin-left:16px; }
  .btn.ebay{ padding:2px 6px; font-size:11px; margin-left:16px; display:inline-flex; align-items:center; }
  .btn.ebay svg{ height:12px; width:auto; display:block; }
  .btn.snipe{ padding:2px 6px; font-size:11px; margin-left:10px; white-space:nowrap; background:rgba(255,255,255,.10); }
  /* 白い枠線を消す対象（aucfan/terapeak/eBay/コピー/Bid/折りたたみ/×） */
  .btn.iconimg, .btn.ebay, .btn.copy, .btn.snipe, .btn.icon { border:0 !important; box-shadow:none !important; }
  .list{margin:0 4px 6px; max-height:50vh; overflow:auto;}
  .row{margin:2px 0; display:flex; align-items:center;}
  .k{ display:inline-block; min-width:96px; margin-right:10px; color:rgba(255,255,255,.85); white-space:nowrap; }
  .v{font-weight:700; color:#fff; flex:1; min-width:0;}
  .profit-sub{ font-size:12px; font-weight:700; opacity:.9; }
  .paren-sub{ font-size:12px; font-weight:700; opacity:.9; }
  .sep{border-top:1px dashed rgba(255,255,255,.40); margin:8px 2px;}
  .group{margin:6px 2px 2px; font-weight:700; color:#fff; border-left:4px solid rgba(255,255,255,.45); padding-left:6px;}
  .gbody{ padding-left:10px; }
</style>

<div class="box">
  <div class="header">
    <div class="title">eBayStock+</div>
    <div class="headbtns">
      <a class="btn iconimg" id="btnAuc" title="Aucfan 検索" aria-label="Aucfan 検索" href="${aucURL}" target="_blank" rel="noopener">${AUC_SVG}</a>
      <a class="btn iconimg" id="btnTp"  title="Terapeak SOLD（過去90日）" aria-label="Terapeak SOLD" href="${tpURL}" target="_blank" rel="noopener">${TP_SVG}</a>
      <button class="btn icon" id="toggle"   title="折りたたみ">▾</button>
      <button class="btn icon" id="btnClose" title="このタブを閉じる">×</button>
    </div>
  </div>
  <div class="list" id="list"></div>
</div>
`;

    const toggleBtn = shadow.getElementById('toggle');
    const closeBtn  = shadow.getElementById('btnClose');
    const touchSave = () => {
      try {
        GM_setValue && GM_setValue(K, toStr(current));
        GM_setValue && GM_setValue(T, Date.now());
      } catch {}
    };
    shadow.getElementById('btnAuc')?.addEventListener('click', touchSave);
    shadow.getElementById('btnTp')?.addEventListener('click', touchSave);

    const listEl = shadow.getElementById('list');
    listEl.innerHTML = '';
    let container = listEl;
    let quickBodyRef = null;

    const aid = getYahooAidFromUrl(location.href);
    const link = location.href;

    const items = [];
    items.push({ type: 'row', k: 'Title', v: title });
    if (category) items.push({ type: 'row', k: 'Category', v: category });
    if (brand)    items.push({ type: 'row', k: 'Brand', v: brand });
    if (klass)    items.push({ type: 'row', k: 'Class', v: klass });
    if (sold !== '') items.push({ type: 'row', k: '販売個数', v: sold });
    items.push({ type: 'sep' });

    items.push({ type: 'group', label: '高利益仕入' });
    items.push({ type: 'row', k: '基準売値($)', v: baseUsdRaw !== '' ? usd(baseUsdRaw) : '—', ebay: 'high' });
    if (profRaw !== '') items.push({ type: 'row', k: '利益率(%)', v: pct(profRaw) });
    if (nmLineBaseHtml) items.push({ type: 'row', k: 'NM入札(¥)', vHtml: nmLineBaseHtml, copyRaw: nmBidRaw, snipe: 'baseNM' });
    if (fpBidRaw !== '') items.push({ type: 'row', k: 'FP入札(¥)', v: yen(fpBidRaw), copyRaw: fpBidRaw, snipe: 'baseFP' });
    items.push({ type: 'sep' });

    items.push({ type: 'group', label: '高回転仕入' });

    if (!isNaN(nowSumNum)) {
      items.push({
        type: 'row',
        k: '現在安値($)',
        vHtml: `${usd(nowSumNum)}${nowParenHtml}`,
        ebay: 'low'
      });
    } else {
      items.push({ type: 'row', k: '現在安値($)', v: '—', ebay: 'low' });
    }

    if (altProfRaw !== '') items.push({ type: 'row', k: '利益率(%)', v: pct(altProfRaw) });
    if (nmLineNowHtml) items.push({ type: 'row', k: 'NM入札(¥)', vHtml: nmLineNowHtml, copyRaw: nmBidNowRaw, snipe: 'nowNM' });
    if (fpBidNowRaw !== '') items.push({ type: 'row', k: 'FP入札(¥)', v: yen(fpBidNowRaw), copyRaw: fpBidNowRaw, snipe: 'nowFP' });

    const renderItems = (items) => {
      let seen = new Set();
      items.forEach(item => {
        if (item.type === 'sep') {
          const hr = document.createElement('div');
          hr.className = 'sep';
          listEl.appendChild(hr);
          seen.clear();
          container = listEl;
          return;
        }
        if (item.type === 'group') {
          seen.clear();
          const g = document.createElement('div');
          g.className = 'group';
          g.textContent = item.label;
          listEl.appendChild(g);

          const body = document.createElement('div');
          body.className = 'gbody';
          listEl.appendChild(body);
          container = body;

          if (item.label === '高回転仕入') quickBodyRef = body;
          return;
        }

        if (seen.has(item.k)) return;
        seen.add(item.k);

        const row = document.createElement('div');
        row.className = 'row';
        row.innerHTML = '<span class="k"></span><span class="v"></span>';

        row.children[0].textContent = item.k;
        if ('vHtml' in item) row.children[1].innerHTML = item.vHtml; else row.children[1].textContent = item.v;

        let canBid = false, priceNum = 0;
        if (item.snipe && item.copyRaw !== '') {
          priceNum = Number(String(item.copyRaw).replace(/[^\d.-]/g, ''));
          canBid = isFinite(priceNum) && priceNum > 0 && !!aid;
        }
        if (!canBid && ('copyRaw' in item) && item.copyRaw !== '') {
          const b = document.createElement('button');
          b.className = 'btn copy';
          b.textContent = '⧉';
          b.title = '値をコピー';
          b.addEventListener('click', () => {
            const num = String(item.copyRaw || '').replace(/[^\d.-]/g, '');
            if (!num) { flash(b, 'No Value'); return; }
            const el = document.createElement('input');
            el.value = num;
            el.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
            document.body.appendChild(el);
            el.select();
            document.execCommand('copy');
            document.body.removeChild(el);
            flash(b, 'Copied!');
          });
          row.appendChild(b);
        }
        if (canBid) {
          const s = document.createElement('button');
          s.className = 'btn snipe';
          s.textContent = 'Bid';
          s.title = 'Aucfanで入札予約を自動実行';
          s.addEventListener('click', () => { startAutoSnipe(aid, priceNum, title, link); });
          row.appendChild(s);
        }

        if (item.ebay === 'high' || item.ebay === 'low') {
          const a = document.createElement('a');
          a.className = 'btn ebay';
          a.target = '_blank';
          a.rel = 'noopener';
          // ▼ A列のURL（EBAY_HIGH_URL/EBAY_LOW_URL）を優先的に使用
          a.href = (item.ebay === 'high') ? ebaySoldHigh : ebayActiveLow;
          a.innerHTML = EBAY_SEARCH_SVG;
          a.title = (item.ebay === 'high' ? 'eBay ソールド（価格+送料が高い順）' : 'eBay アクティブ（価格+送料が安い順）');
          a.addEventListener('click', () => {
            try {
              GM_setValue && GM_setValue(K, toStr(current));
              GM_setValue && GM_setValue(T, Date.now());
            } catch {}
          });
          row.appendChild(a);
        }

        container.appendChild(row);
      });
    };

    renderItems(items);

    // HIST
    const histRaw = getRaw(['HIST']);
    if (histRaw) {
      const hist = parseHistPayload(histRaw);
      const percentile = (() => {
        const { min, step, bins, counts, current } = hist;
        if (!isFinite(current) || !counts.length || step <= 0) return null;
        const idx = Math.max(0, Math.min(bins - 1, Math.floor((current - min) / step)));
        let cum = 0;
        for (let i = 0; i < idx; i++) cum += (counts[i] || 0);
        const within = Math.max(0, Math.min(1, (current - (min + idx * step)) / step));
        const binCnt = counts[idx] || 0;
        const n = hist.n || counts.reduce((a, b) => a + b, 0) || 1;
        return Math.round(1000 * ((cum + within * binCnt) / n)) / 10;
      })();

      const boxEl = shadow.querySelector('.box');
      const boxInner = (boxEl ? boxEl.clientWidth : 320) - 16;
      const w = Math.max(240, Math.min(300, boxInner));
      const h = 120;
      const histEl = renderHistogramSVG(hist, w, h);

      const n = hist.n || hist.counts.reduce((a, b) => a + b, 0);
      const metaEl = histEl.querySelector('.hist-meta');
      const pctStr = (percentile != null) ? ` / 現在安値≤ ≈ ${percentile}%` : '';
      if (metaEl) metaEl.textContent = `n=${n}${pctStr}`;

      (quickBodyRef || listEl).appendChild(histEl);
    }

    // 折りたたみ・クローズ
    let collapsed = false;
    const btnAuc = shadow.getElementById('btnAuc');
    const btnTp  = shadow.getElementById('btnTp');
    const setCollapsed = flag => {
      collapsed = !!flag;
      listEl.style.display = collapsed ? 'none' : 'block';
      toggleBtn.textContent = collapsed ? '▸' : '▾';
      if (btnAuc) btnAuc.style.display = collapsed ? 'none' : 'inline-flex';
      if (btnTp)  btnTp.style.display  = collapsed ? 'none' : 'inline-flex';
    };
    setCollapsed(false);
    toggleBtn.addEventListener('click', () => setCollapsed(!collapsed));
    closeBtn.addEventListener('click', () => { try { window.close(); } catch {} });

    // ★ このページから辿るヤフオクリンクに ymv_keep=1 を付与して“流れ”を継続
    attachFlowPropagation();
  }

  // ヤフオク系リンクに ymv_keep=1 を自動付与（クリック/中クリック/⌘クリック対応）
  function attachFlowPropagation() {
    if (flowClickerAttached) return;

    const patch = (a) => {
      try {
        const u = new URL(a.href, location.href);
        const host = u.hostname;
        const isYahuoku =
          /(?:^|\.)auctions\.yahoo\.co\.jp$/.test(host) ||
          /(?:^|\.)page\.auctions\.yahoo\.co\.jp$/.test(host);
        if (!isYahuoku) return;

        const hashParams = new URLSearchParams(u.hash.replace(/^#/, ''));
        const hasYmv  = u.searchParams.has('ymv') || hashParams.has('ymv');
        const hasKeep = u.searchParams.has(KEEP_FLAG) || hashParams.has(KEEP_FLAG);
        if (hasYmv || hasKeep) return;

        if (u.hash && u.hash.length > 1) {
          hashParams.set(KEEP_FLAG, '1');
          u.hash = '#' + hashParams.toString();
        } else {
          u.searchParams.set(KEEP_FLAG, '1');
        }
        a.href = u.toString();
      } catch {}
    };

    const handler = (e) => {
      const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
      if (!a) return;
      const href = a.getAttribute('href') || '';
      if (!href || href.startsWith('javascript:')) return;
      patch(a);
    };

    document.addEventListener('click', handler, true);
    document.addEventListener('auxclick', handler, true);
    flowClickerAttached = true;
  }

  /* ---------- ルータ ---------- */
  async function render() {
    if (closeIfSetsnipe()) return;

    const url = location.href;

    if (/auth\.login\.yahoo\.co\.jp\/yconnect\/v2\/consent/.test(url)) { tryAutoConsentYahoo(); return; }
    if (/tools\.aucfan\.com\/snipe\//.test(url)) { tryAutoOnAucfan(); return; }
    if (/aucview(\.aucfan)?\.com\/yahoo\//.test(url)) { tryAutoOnAucview(); }

    let pairs;
    const q = getYmvRaw();
    if (q) {
      const p = parse(q);
      if (p.length) { await savePairs(p); pairs = p; }
    }

    // KEEPフラグがあれば、タブ縛り無しで復元（パネルの“流れ”継続）
    const keep = hasKeepFlag();
    if (!pairs && keep) {
      pairs = await loadPairsAnyTab();
    }

    // ★ フラグも ymv も無ければ出さない（無関係タブでの常時表示を防ぐ）
    if (pairs && pairs.length) {
      buildPanel(pairs);
      if (keep) stripKeepFlag(); // URLを綺麗に戻す（任意）
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', render); else render();
  addEventListener('pageshow', render);
  addEventListener('ymv:urlchange', render);
  addEventListener('hashchange', render);
  new MutationObserver(() => { if (!document.getElementById(HOST)) render(); })
    .observe(document.documentElement, { childList: true, subtree: true });
  setInterval(() => { if (!document.getElementById(HOST)) render(); }, 1000);
})();

// --- setsnipe 完了ページで自動クローズ ---
function closeIfSetsnipe() {
  if (
    location.hostname === 'tools.aucfan.com' &&
    /^\/snipe\/item\/setsnipe\/?$/.test(location.pathname)
  ) {
    setTimeout(() => { try { window.close(); } catch {} }, 600);
    return true;
  }
  return false;
}
