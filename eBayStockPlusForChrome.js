// ==UserScript==(回転率あり)
// @name         YM Panel (Yahoo/Aucfan) – NM/FPワンタン入札予約（form限定で安全送信）
// @namespace    ymv-panel-sticky
// @description  商品ページの「NM入札(¥)」「FP入札(¥)」行から、その価格で Aucfan の入札予約を自動実行。aucviewモーダル/aucfan confirm で form 起点に価格投入→同一formの submit だけをクリックして誤操作を防止。UI配置（Aucfan/TPはヘッダー左側、eBay高順→基準売値行, 安順→現在安値行, USDは小数2桁）を維持。
// @match        https://auctions.yahoo.co.jp/*
// @match        https://page.auctions.yahoo.co.jp/*
// @match        https://aucfan.com/*
// @match        https://aucview.aucfan.com/*
// @match        https://tools.aucfan.com/snipe/*
// @match        https://auth.login.yahoo.co.jp/*
// @match        https://www.ebay.com/*
// @run-at       document-start
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @connect      ebay.com
// @connect      www.ebay.com
// ==/UserScript==
(function(){
  'use strict';

  /* ---------- SPA URL 変化検知 ---------- */
  const _push = history.pushState, _replace = history.replaceState;
  const fire = ()=>window.dispatchEvent(new Event('ymv:urlchange'));
  history.pushState    = function(){ _push.apply(this,arguments);    fire(); };
  history.replaceState = function(){ _replace.apply(this,arguments); fire(); };
  addEventListener('popstate', fire);

  /* ---------- 共有ストレージ ---------- */
  const K='ymv:lastPayload', T='ymv:lastTime', EXP=30*60*1000;
  const SNIPE='ymv:autoSnipe'; // {aid, price, title, link}
  const now=()=>Date.now();
  const enc=s=>{ try{return encodeURIComponent(s)}catch{return ''} };
  const toStr=pairs=>pairs.map(([k,v])=>k+'='+(v||'')).join('|');

  function getYmvRaw(){
    try{
      const u=new URL(location.href);
      let q=u.searchParams.get('ymv');
      if(!q){
        const h=new URLSearchParams(location.hash.replace(/^#/, ''));
        q=h.get('ymv')||'';
      }
      return q||'';
    }catch{ return ''; }
  }
  const parse=q=>{ if(!q) return []; try{
    const dec=decodeURIComponent(q);
    return dec.split('|').map(s=>{ const i=s.indexOf('='); return i>=0?[s.slice(0,i),s.slice(i+1)]:[s,'']; });
  }catch{ return []; } };
  async function savePairs(pairs){ try{ await GM_setValue(K,toStr(pairs)); await GM_setValue(T,now()); }catch{} }
  async function loadPairs(){ try{
    const t=await GM_getValue(T,0); if(!t||now()-t>EXP) return [];
    const raw=await GM_getValue(K,''); if(!raw) return [];
    return raw.split('|').map(s=>{ const i=s.indexOf('='); return i>=0?[s.slice(0,i),s.slice(i+1)]:[s,'']; });
  }catch{ return []; } }
  async function setAutoSnipe(obj){ try{ await GM_setValue(SNIPE, JSON.stringify(obj||{})); }catch{} }
  async function getAutoSnipe(){ try{ const j=await GM_getValue(SNIPE,''); return j?JSON.parse(j):{}; }catch{ return {}; } }

  /* ---------- 共通ユーティリティ ---------- */
  const HOST='ymv-panel-host';
  let host, shadow, current=[];
  function ensureHost(){
    host=document.getElementById(HOST);
    if(!host){
      host=document.createElement('div');
      host.id=HOST;
      host.style.cssText='position:fixed;bottom:12px;right:12px;z-index:2147483647;';
      document.documentElement.appendChild(host);
      shadow=host.attachShadow({mode:'open'});
    }else{
      shadow=host.shadowRoot||host.attachShadow({mode:'open'});
    }
  }
  const getRaw = (patterns)=>{
    for(const pat of patterns){
      for(const [k,v] of current){
        if (typeof pat === 'string' && k === pat) return v;
        if (pat instanceof RegExp && pat.test(k)) return v;
      }
    }
    return '';
  };
  const yen = v=>{
    if(v==null||v==='') return '';
    const n=Number(String(v).replace(/[^\d.-]/g,'')); if(!isFinite(n)) return String(v);
    return '¥'+n.toLocaleString('ja-JP',{maximumFractionDigits:0});
  };
  const usd = v=>{
    if(v==null||v==='') return '';
    const n=Number(String(v).replace(/[^\d.-]/g,'')); if(!isFinite(n)) return String(v);
    return '$'+n.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
  };
  const pct = v=>{
    if(v==null||v==='') return '';
    const n=Number(String(v).replace(/[^\d.-]/g,'')); if(!isFinite(n)) return String(v);
    return Math.round(n*100)+'%';
  };
  function flash(btn,msg){ if(!btn) return; const o=btn.textContent; btn.textContent=msg; setTimeout(()=>btn.textContent=o,900); }

  function normalizeUrl(u){ return String(u||'').replace(/\uFF1D/g,'=').replace(/\uFF06/g,'&').replace(/\uFF1F/g,'?').replace(/\uFF03/g,'#'); }
  function extractKeywords(ebayUrl, title){
    try{ const u = new URL(normalizeUrl(ebayUrl||'')); const kw = u.searchParams.get('_nkw') || ''; if(kw) return kw; }catch{}
    return String(title||'').trim();
  }

  /* ---------- eBay URL（BIN固定） ---------- */
  function buildEbayVariant(baseUrl, title, variant){
    const safe = normalizeUrl(baseUrl || '');
    let candidate = safe || ('https://www.ebay.com/sch/i.html?_nkw=' + encodeURIComponent(title || ''));
    try{
      const u = new URL(candidate);
      // Buy It Now 固定
      u.searchParams.set('LH_BIN','1');
      u.searchParams.set('rt','nc');
      if (variant === 'activeLow'){
        u.searchParams.delete('LH_Sold');
        u.searchParams.delete('LH_Complete');
        u.searchParams.set('_sop','15');
      } else if (variant === 'soldHigh'){
        u.searchParams.set('LH_Sold','1');
        u.searchParams.set('LH_Complete','1');
        u.searchParams.set('_sop','16');
      }
      return u.toString();
    }catch(_){
      let s=candidate;
      s += (s.includes('?')?'&':'?') + 'LH_BIN=1&rt=nc';
      if (variant==='activeLow'){
        s = s.replace(/([?&])LH_Sold=1/g,'$1').replace(/([?&])LH_Complete=1/g,'$1');
        s += (s.includes('?')?'&':'?') + '_sop=15';
      }else{
        s += (s.includes('?')?'&':'?') + 'LH_Sold=1&LH_Complete=1&_sop=16';
      }
      return s.replace(/&&+/g,'&').replace(/\?&/,'?');
    }
  }

  function buildTerapeakUrl(kw){
    const now = Date.now(), DAY = 86400000;
    const u = new URL('https://www.ebay.com/sh/research');
    u.searchParams.set('marketplace','EBAY-US');
    u.searchParams.set('keywords', kw);
    u.searchParams.set('dayRange','90');
    u.searchParams.set('startDate', String(now - 90*DAY));
    u.searchParams.set('endDate',   String(now));
    u.searchParams.set('categoryId','0');
    u.searchParams.set('offset','0'); u.searchParams.set('limit','50');
    u.searchParams.set('tabName','SOLD'); u.searchParams.set('tz','Asia/Tokyo');
    return u.toString();
  }

  /* ---------- eBay結果件数 取得（回転率計算用） ---------- */
  // === [ADD] eBay アクセスのスロットリング & チャレンジ検知 ===
const EBAY_MIN_GAP_MS   = 12000;            // 最低 12 秒（8–15秒推奨）
const EBAY_JITTER_MS    = 4000;             // 0–4秒のゆらぎ
const EBAY_COOLDOWN_MS  = 30 * 60 * 1000;   // 検知時は 30 分休む
let   EBAY_LAST_AT        = 0;
let   EBAY_COOLDOWN_UNTIL = 0;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function gmGetTextThrottled(url){
  if (Date.now() < EBAY_COOLDOWN_UNTIL) throw new Error('ebay cooldown');

  const elapsed = Date.now() - EBAY_LAST_AT;
  const jitter  = Math.floor(Math.random() * EBAY_JITTER_MS);
  const wait    = Math.max(0, EBAY_MIN_GAP_MS - elapsed) + jitter;
  if (wait > 0) await sleep(wait);

  const html = await gmGetText(url);
  EBAY_LAST_AT = Date.now();

  // Cloudflare/Akamai のボット検知ページを踏んだらクールダウン
  if (/Checking your browser/i.test(html) ||
      /Reference ID:/i.test(html) ||
      /cf-browser-verification|cf-chl-bypass/i.test(html)) {
    EBAY_COOLDOWN_UNTIL = Date.now() + EBAY_COOLDOWN_MS;
    throw new Error('ebay challenge');
  }
  return html;
}


  const ebayCountCache = new Map();
  function gmGetText(url){
    return new Promise((resolve, reject)=>{
      try{
        GM_xmlhttpRequest({
          method: 'GET',
          url,
          headers: { 'Accept': 'text/html' },
          onload: r => resolve(r.responseText || ''),
          onerror: () => reject(new Error('network error')),
        });
      }catch(e){ reject(e); }
    });
  }
  function parseEbayResultCount(html){
    try{
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const sels = [
        '.srp-controls__count-heading span.BOLD',
        '.srp-controls__count span.BOLD',
        'h1.srp-controls__count-heading > span.BOLD'
      ];
      for(const sel of sels){
        const el = doc.querySelector(sel);
        if(el){
          const n = Number((el.textContent||'').replace(/[^\d]/g,''));
          if(isFinite(n)) return n;
        }
      }
      const m = html.match(/class=["']BOLD["'][^>]*>([\d,]+)/i) || html.match(/([\d,]+)\s+results/i);
      if(m){
        const n = Number(m[1].replace(/[^\d]/g,''));
        if(isFinite(n)) return n;
      }
    }catch(_){}
    return NaN;
  }
    // === [CHANGE] スロットリング付きの取得に変更 ===
    async function fetchEbayCount(url){
        if (ebayCountCache.has(url)) return ebayCountCache.get(url);
        try{
            const html = await gmGetTextThrottled(url);   // ←ここだけ置き換え
            const n = parseEbayResultCount(html);
            ebayCountCache.set(url, n);
            return n;
        }catch{
            ebayCountCache.set(url, NaN);
            return NaN;
        }
    }

  /* ---------- Aucfan 自動入札：URL生成 & 発火 ---------- */
  function getYahooAidFromUrl(u){
    const m=String(u||location.href).match(/\/auction\/([A-Za-z0-9]+)\b/i);
    return m?m[1]:'';
  }

  function startAutoSnipe(aid, price, title, link){
    if(!aid || !price){ alert('入札予約に必要な情報が不足しました（aid/price）。'); return; }
    const p = String(Math.floor(price));
    setAutoSnipe({aid, price:p, title:title||'', link:link||location.href});
    const u = `https://aucview.aucfan.com/yahoo/${encodeURIComponent(aid)}/#ymv_snipe=${encodeURIComponent(p)}`;
    window.open(u, '_blank', 'noopener');
  }

  const isVisible = el => !!(el && getComputedStyle(el).display!=='none' && getComputedStyle(el).visibility!=='hidden' && el.offsetParent!==null);

  /* ---------- aucview：モーダルを開き、form 起点で投入＆送信 ---------- */
  function tryAutoOnAucview(){
    const h = new URLSearchParams(location.hash.replace(/^#/, ''));
    const want = h.get('ymv_snipe');
    if(!want) return;

    const aidMatch = location.pathname.match(/\/yahoo\/([A-Za-z0-9]+)\b/);
    const aid = aidMatch ? aidMatch[1] : '';
    setAutoSnipe({aid, price:String(want)});

    const openModal = ()=>{
      const btn = Array.from(document.querySelectorAll('a,button')).find(el=>/入札予約する/.test(el.textContent||''));
      if(btn){ btn.click(); return true; }
      return false;
    };
    setTimeout(openModal, 300);
    setTimeout(openModal, 900);
    setTimeout(openModal, 1800);

    const poll = ()=>{
      const form = Array.from(document.querySelectorAll('form[action*="/snipe/item/confirm"]')).find(isVisible);
      if(!form) return;

      const field =
        form.querySelector('input[name="sss_bid_price"]:not([type="hidden"])') ||
        form.querySelector('#sss_bid_price') ||
        form.querySelector('input[type="number"],input[type="text"]');

      if(field && isVisible(field)){
        field.focus();
        field.value = String(want);
        field.dispatchEvent(new Event('input',{bubbles:true}));
        field.dispatchEvent(new Event('change',{bubbles:true}));
        field.blur();
      }

      const submitBtn = form.querySelector('#snipBtn') ||
                        Array.from(form.querySelectorAll('button[type="submit"],input[type="submit"]')).find(isVisible);
      if(submitBtn){ setTimeout(()=>submitBtn.click(),150); clearInterval(iv); }
    };
    const iv=setInterval(poll,250);
    setTimeout(()=>clearInterval(iv),12000);
  }

  /* ---------- Yahoo同意ページの自動クリック（初回のみ想定） ---------- */
  function tryAutoConsentYahoo(){
    const tryClick = ()=>{
      const byType = document.querySelector('button[type="submit"], input[type="submit"], .Button__button');
      if(byType){ byType.click(); return; }
      const byText = Array.from(document.querySelectorAll('button, input[type="submit"]'))
        .find(el=>/同意|はじめる/.test(el.textContent||'') || /同意/.test(el.value||''));
      if(byText){ byText.click(); }
    };
    setTimeout(tryClick, 400);
    setTimeout(tryClick, 1200);
    setTimeout(tryClick, 2200);
  }

  /* ---------- tools.aucfan：confirm/免責 まで自動 ---------- */
  function tryAutoOnAucfan(){
    const url = new URL(location.href);

    const injectPrice = (form, val)=>{
      const cands = [
        'input[name="sss_bid_price"]', '#sss_bid_price',
        'input[name="snipe_price"]', 'input[name="bid_price"]',
        'input[type="number"]', 'input[type="text"]'
      ];
      for(const sel of cands){
        const el = form.querySelector(sel);
        if(el && isVisible(el)){
          el.focus();
          el.value = String(val);
          el.dispatchEvent(new Event('input',{bubbles:true}));
          el.dispatchEvent(new Event('change',{bubbles:true}));
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
        .find(el=>{
          const t=(el.textContent||el.value||'').replace(/\s/g,'');
          return isVisible(el) && (
            t.includes('免責事項を確認・同意の上、入札する') ||
            t.includes('同意の上入札') || t.includes('同意して入札')
          );
        });
      if(hit){ hit.click(); notifyAndClose(); return true; }

      return false;
    };

    const clickFormSubmit = (form)=>{
      const submitBtn = form.querySelector('#snipBtn') ||
            Array.from(form.querySelectorAll('button[type="submit"],input[type="submit"]')).find(isVisible);
      if(submitBtn){ submitBtn.click(); return true; }
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
            'position:fixed;left:0;right:0;bottom:88px;display:flex;justify-content:center;'+
            'z-index:2147483647;pointer-events:none;';
          const sh = host.attachShadow({ mode: 'open' });
          sh.innerHTML = `
            <style>
              .toast{all: initial;display:inline-block;padding:12px 16px;border-radius:12px;background:#216D89;color:#fff;font:14px/1.3 -apple-system,system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:min(92vw,520px);text-align:center;pointer-events:auto;box-shadow:none;}
              .toast b{all: initial;font:700 14px/1.3 -apple-system,system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#fff;}
              .sub{all: initial;display:block;margin-top:4px;opacity:.9;font:12px/1.2 -apple-system,system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#fff;}
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
      if (doneNow()) { setTimeout(()=>window.close(), 700); return; }
      const iv = setInterval(()=>{ if (doneNow()) { clearInterval(iv); mo.disconnect?.(); setTimeout(()=>window.close(), 700); } }, 350);
      const mo = new MutationObserver(()=>{ if (doneNow()) { clearInterval(iv); mo.disconnect(); setTimeout(()=>window.close(), 700); }});
      mo.observe(document.documentElement, { childList:true, subtree:true });
      setTimeout(()=>{ clearInterval(iv); mo.disconnect?.(); }, 20000);
    };

    const go = async ()=>{
      scheduleAutoClose();
      const stash = await getAutoSnipe();
      const price = url.searchParams.get('sss_bid_price') || (stash && stash.price) || '';

      if (/\/snipe\/item\/confirm/.test(location.pathname)){
        const form = document.querySelector('form[action*="/snipe/item/confirm"]') || document.querySelector('form');
        if(form && price) injectPrice(form, price);
        if (clickConsent()) return;
        if (form) clickFormSubmit(form);
        setTimeout(clickConsent, 400);
        setTimeout(clickConsent, 1200);
        setTimeout(clickConsent, 2500);
        return;
      }

      if (/\/snipe\/item\/confirm/.test(document.referrer||'')){
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


  /* ---------- PANEL（UI） ---------- */
  function buildPanel(pairs){
    current=pairs.slice(0);
    ensureHost();

    const title = getRaw(['Title']) || document.title.replace(/\s*\|\s*ヤフオク!.*/,'');
    // USD 値
    const baseUsdRaw = getRaw([/^基準売値(?:\((?:USD|\$)\))?$/, /^売値(?:\((?:USD|\$)\))?$/]);
    const nowUsdRaw  = getRaw([/^現在安値(?:\((?:USD|\$)\))?$/, /^NM[|｜]?最安\(API Active\)$/]);

    // eBay
    const ebayUrlRaw = getRaw(['eBayURL','eBay','Ebay','EBAY_URL']);
    const ebayActiveLow = buildEbayVariant(ebayUrlRaw, title, 'activeLow'); // x
    const ebaySoldHigh  = buildEbayVariant(ebayUrlRaw, title, 'soldHigh');  // y

    // 利益率
    const profRaw     = getRaw(['利益率','TARGET_PROFIT_RATE']);
    const altProfRaw  = getRaw(['利益率(現安)','ALT_TARGET_PROFIT_RATE']);

    // 金額（基準／現安）
    const nmBidRaw       = getRaw(['NM入札','NM｜入札','NM|入札']);
    const nmProfitRaw    = getRaw(['NM利益','NM｜利益','NM|利益']);
    const fpBidRaw       = getRaw(['FP入札','FP｜入札','FP|入札']);
    const nmBidNowRaw    = getRaw(['NM入札(現安)','NM|入札(現安)']);
    const nmProfitNowRaw = getRaw(['NM利益(現安)','NM|利益(現安)']);
    const fpBidNowRaw    = getRaw(['FP入札(現安)','FP|入札(現安)']);

    // 属性
    const category = getRaw(['Category']);
    const brand    = getRaw(['Brand']);
    const klass    = getRaw(['Class']);
    const sold     = getRaw(['販売個数','売']);

    // Aucfan / Terapeak URL
    const aucIdMatch=location.href.match(/\bauction\/([A-Za-z0-9]+)\b/i);
    const aucId=aucIdMatch?aucIdMatch[1]:'';
    const aucfanId=aucId?('https://aucfan.com/aucview/yahoo/'+encodeURIComponent(aucId)+'/'):'';
    const aucfanQ='https://aucfan.com/search1/?q='+encodeURIComponent(title||'');
    const aucURL=(aucfanId||aucfanQ)+'#ymv='+enc(toStr(current));
    const tpURL  = buildTerapeakUrl(extractKeywords(ebayUrlRaw, title));

    // NM入札 表示HTML
    const nmBaseMain   = nmBidRaw!=='' ? yen(nmBidRaw) : '';
    const nmBaseProfit = nmProfitRaw!=='' ? yen(nmProfitRaw) : '';
    const nmLineBaseHtml = nmBaseMain ? nmBaseMain + (nmBaseProfit ? ` <span class="profit-sub">(利益 ${nmBaseProfit})</span>` : '') : '';
    const nmNowMain   = nmBidNowRaw!=='' ? yen(nmBidNowRaw) : '';
    const nmNowProfit = nmProfitNowRaw!=='' ? yen(nmProfitNowRaw) : '';
    const nmLineNowHtml = nmNowMain ? nmNowMain + (nmNowProfit ? ` <span class="profit-sub">(利益 ${nmNowProfit})</span>` : '') : '';

    // 表示データ
    const items=[];
    items.push({type:'row', k:'Title', v:title});
    if(category) items.push({type:'row', k:'Category', v:category});
    if(brand)    items.push({type:'row', k:'Brand',    v:brand});
    if(klass)    items.push({type:'row', k:'Class',    v:klass});
    // 回転率は販売個数の上に表示
    items.push({type:'row', k:'回転率', v:'—', rotate:true});
    if(sold!=='')items.push({type:'row', k:'販売個数',  v:sold});
    items.push({type:'sep'});

    items.push({type:'group', label:'高利益仕入'});
    items.push({type:'row', k:'基準売値($)', v: baseUsdRaw!=='' ? usd(baseUsdRaw) : '—', ebay:'high'});
    if(profRaw!=='') items.push({type:'row', k:'利益率(%)', v:pct(profRaw)});
    if(nmLineBaseHtml) items.push({type:'row', k:'NM入札(¥)', vHtml:nmLineBaseHtml, copyRaw:nmBidRaw, snipe:'baseNM'});
    if(fpBidRaw!=='')   items.push({type:'row', k:'FP入札(¥)', v:yen(fpBidRaw),     copyRaw:fpBidRaw, snipe:'baseFP'});
    items.push({type:'sep'});

    items.push({type:'group', label:'高回転仕入'});
    items.push({type:'row', k:'現在安値($)', v: nowUsdRaw!=='' ? usd(nowUsdRaw) : '—', ebay:'low'});
    if(altProfRaw!=='') items.push({type:'row', k:'利益率(%)', v:pct(altProfRaw)});
    if(nmLineNowHtml)   items.push({type:'row', k:'NM入札(¥)', vHtml:nmLineNowHtml, copyRaw:nmBidNowRaw, snipe:'nowNM'});
    if(fpBidNowRaw!=='')items.push({type:'row', k:'FP入札(¥)', v:yen(fpBidNowRaw),  copyRaw:fpBidNowRaw, snipe:'nowFP'});

    // ===== UI =====
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        .box{
          all:initial; display:block; background:#216D89; color:#fff;
          border:1px solid #1B5870; border-radius:12px; box-shadow:0 8px 20px rgba(0,0,0,.25);
          padding:8px 8px 6px; min-width:320px; max-width:92vw;
          font:14px/1.4 -apple-system,system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif;
        }
        .header{display:flex; align-items:center; gap:6px; margin:0 0 8px 8px;}
        .title{font-weight:700; flex:1; min-width:0; color:#fff;}
        .headbtns{display:flex; gap:6px;}
        .btn{
          all:initial; display:inline-block; text-align:center; padding:4px 8px; border-radius:6px; font-size:12px; cursor:pointer;
          border:1px solid rgba(255,255,255,.45); background:rgba(255,255,255,.10); color:#fff;
        }
        .btn.icon{
           display:inline-flex; align-items:center; justify-content:center;
           width:22px; height:22px; padding:0; font-size:12px; font-weight:700; line-height:1;
        }
        .btn:hover{ background:rgba(255,255,255,.18); }
        .btn.copy{ padding:2px 6px; font-size:11px; margin-left:16px; }
        .btn.mini{ padding:2px 6px; font-size:11px; white-space:nowrap; }
        .btn.snipe{ padding:2px 6px; font-size:11px; margin-left:10px; white-space:nowrap;
                    border-color:rgba(255,255,255,.45); background:rgba(255,255,255,.10); }
        .btn.snipe:hover{ background:rgba(255,255,255,.18); }
        .btn .paren-sub{ font-size:10px; opacity:.9; }
        .list{margin:0 4px 6px; max-height:50vh; overflow:auto;}
        .row{margin:2px 0; display:flex; align-items:center;}
        .k{display:inline-block; min-width:110px; margin-right:10px; color:rgba(255,255,255,.85);}
        .v{font-weight:700; color:#fff; flex:1;}
        .profit-sub{ font-size:12px; font-weight:700; opacity:.9; }
        .sep{border-top:1px dashed rgba(255,255,255,.40); margin:8px 2px;}
        .group{margin:6px 2px 2px; font-weight:700; color:#fff; border-left:4px solid rgba(255,255,255,.45); padding-left:6px;}
        .gbody{ padding-left:10px; }
      </style>
      <div class="box">
        <div class="header">
          <div class="title">eBayStock+</div>
          <div class="headbtns">
            <button class="btn icon" id="toggle"   title="折りたたみ">▾</button>
            <!-- Aucfan / TP はあとで左側へ差し込み -->
            <button class="btn icon" id="btnClose" title="このタブを閉じる">×</button>
          </div>
        </div>
        <div class="list" id="list"></div>
      </div>
    `;

    // ヘッダーのAucfan / Terapeak ボタンを追加（折りたたみの左側）
    const hb = shadow.querySelector('.headbtns');
    const toggleBtn = shadow.getElementById('toggle');
    const closeBtn  = shadow.getElementById('btnClose');
    const touchSave = ()=>{ try{
      GM_setValue && GM_setValue(K, toStr(current));
      GM_setValue && GM_setValue(T, Date.now());
    }catch{} };

    const btnAuc = document.createElement('a');
    btnAuc.className='btn mini'; btnAuc.textContent='Aucfan';
    btnAuc.href=aucURL; btnAuc.target='_blank'; btnAuc.rel='noopener';
    btnAuc.title='Aucfan 検索'; btnAuc.addEventListener('click', touchSave);

    const btnTp = document.createElement('a');
    btnTp.className='btn mini'; btnTp.textContent='Terapeak';
    btnTp.href=tpURL; btnTp.target='_blank'; btnTp.rel='noopener';
    btnTp.title='Terapeak SOLD（過去90日）'; btnTp.addEventListener('click', touchSave);

    // 左から [Aucfan][Terapeak][折りたたみ][×]
    hb.insertBefore(btnAuc, toggleBtn);
    hb.insertBefore(btnTp,  toggleBtn);

    const listEl=shadow.getElementById('list');
    listEl.innerHTML='';
    let container = listEl;
    let rotationRowEl = null;
    let rotationReqSeq = 0;
    const aid = getYahooAidFromUrl(location.href);
    const link = location.href;

    items.forEach(item=>{
      if(item.type==='sep'){
        const hr=document.createElement('div'); hr.className='sep'; listEl.appendChild(hr);
        container = listEl; return;
      }
      if(item.type==='group'){
        const g=document.createElement('div'); g.className='group'; g.textContent=item.label; listEl.appendChild(g);
        const body=document.createElement('div'); body.className='gbody'; listEl.appendChild(body);
        container = body; return;
      }
      const row=document.createElement('div');
      row.className='row';
      row.innerHTML='<span class="k"></span><span class="v"></span>';

      row.children[0].textContent=item.k;
      if('vHtml' in item) row.children[1].innerHTML=item.vHtml; else row.children[1].textContent=item.v;

      if (item.rotate) rotationRowEl = row;

      // --- Bid がある行ではコピーを出さない ---
      let canBid = false, priceNum = 0;
      if (item.snipe && item.copyRaw!=='') {
        priceNum = Number(String(item.copyRaw).replace(/[^\d.-]/g,''));
        canBid = isFinite(priceNum) && priceNum > 0 && !!aid;
      }
      if (!canBid && ('copyRaw' in item) && item.copyRaw!=='') {
        const b=document.createElement('button');
        b.className='btn copy'; b.textContent='⧉'; b.title='値をコピー';
        b.addEventListener('click', e=>{
          const num = String(item.copyRaw||'').replace(/[^\d.-]/g,'');
          if(!num){ flash(b,'No Value'); return; }
          const el=document.createElement('input'); el.value=num; el.style.cssText='position:fixed;top:0;left:0;opacity:0';
          document.body.appendChild(el); el.select(); document.execCommand('copy'); document.body.removeChild(el);
          flash(b,'Copied!');
        });
        row.appendChild(b);
      }
      if (canBid) {
        const s=document.createElement('button');
        s.className='btn snipe';
        s.textContent='Bid';
        s.title='Aucfanで入札予約を自動実行';
        s.addEventListener('click', ()=>{ startAutoSnipe(aid, priceNum, title, link); });
        row.appendChild(s);
      }
      // --- ここまで ---

      // eBay 行内ボタン
      if(item.ebay==='high' || item.ebay==='low'){
        const a=document.createElement('a');
        a.className='btn mini';
        a.target='_blank'; a.rel='noopener';
        a.href = (item.ebay==='high') ? ebaySoldHigh : ebayActiveLow;
        a.innerHTML = 'eBay<span class="paren-sub">(' + (item.ebay==='high'?'高順':'安順') + ')</span>';
        a.title = (item.ebay==='high'?'eBay ソールド（価格+送料が高い順）':'eBay アクティブ（価格+送料が安い順）');
        a.addEventListener('click', touchSave);
        row.appendChild(a);
      }

      container.appendChild(row);
    });

    // --- 回転率（y/x）を更新 ---
    // 既存の updateRotationRow をこの実装で置き換え
      async function updateRotationRow(rowEl){
          if(!rowEl) return;
          const vEl = rowEl.querySelector('.v');
          if(!vEl) return;

          // eBayクールダウン中なら即表示だけ更新
          if (typeof EBAY_COOLDOWN_UNTIL !== 'undefined' && Date.now() < EBAY_COOLDOWN_UNTIL) {
              const left = Math.max(0, EBAY_COOLDOWN_UNTIL - Date.now());
              const mm = Math.floor(left / 60000);
              const ss = Math.floor((left % 60000) / 1000).toString().padStart(2,'0');
              vEl.textContent = `🧊 クールダウン中（残り ${mm}:${ss}）`;
              return;
          }

          // 取得中を見せる
          const mySeq = ++rotationReqSeq;
          vEl.textContent = '⏳ 取得中…';

          try{
              // 順番に取得（スロットリングを壊さないため）
              const soldCount   = await fetchEbayCount(ebaySoldHigh);
              if (mySeq !== rotationReqSeq) return; // 古いリクエストなら棄却
              const activeCount = await fetchEbayCount(ebayActiveLow);
              if (mySeq !== rotationReqSeq) return;

              const fmt = n => (isFinite(n) && n>=0) ? n.toLocaleString('ja-JP') : '—';

              if (isFinite(soldCount) && isFinite(activeCount) && activeCount > 0){
                  const ratio = soldCount / activeCount;
                  vEl.innerHTML = `${Math.round(ratio*100)}% <span class="profit-sub">(販売数 ${fmt(soldCount)} / 出品数 ${fmt(activeCount)})</span>`;
              } else if (!isFinite(soldCount) && !isFinite(activeCount)) {
                  vEl.textContent = '⚠️ 取得失敗';
              } else {
                  vEl.textContent = '—';
              }
          }catch(e){
              if (mySeq !== rotationReqSeq) return;
              const msg = String(e && e.message || '');
              if (msg.includes('cooldown')) {
                  vEl.textContent = '🧊 クールダウン中';
              } else if (msg.includes('challenge')) {
                  vEl.textContent = '🛡️ アクセス制限検知';
              } else if (msg.includes('network')) {
                  vEl.textContent = '📶 ネットワークエラー';
              } else {
                  vEl.textContent = '⚠️ 取得失敗';
              }
          }
      }
    updateRotationRow(rotationRowEl);

    // 折りたたみ・クローズ
    let collapsed = false;
    const setCollapsed = flag=>{
      collapsed=!!flag;
      listEl.style.display = collapsed ? 'none' : 'block';
      toggleBtn.textContent = collapsed ? '▸' : '▾';
    };
    setCollapsed(false);
    toggleBtn.addEventListener('click', ()=> setCollapsed(!collapsed));
    closeBtn.addEventListener('click', ()=>{ try{ window.close(); }catch{} });
  }

  /* ---------- ルータ ---------- */
  async function render(){
    if (closeIfSetsnipe()) return;

    const url = location.href;

    if (/auth\.login\.yahoo\.co\.jp\/yconnect\/v2\/consent/.test(url)) { tryAutoConsentYahoo(); return; }
    if (/tools\.aucfan\.com\/snipe\//.test(url)) { tryAutoOnAucfan(); return; }
    if (/aucview(\.aucfan)?\.com\/yahoo\//.test(url)) { tryAutoOnAucview(); }

    // パネル描画
    let pairs;
    const q=getYmvRaw();
    if(q){
      const p=parse(q);
      if(p.length){ await savePairs(p); pairs=p; }
    }
    if(!pairs){ pairs = await loadPairs(); }
    if(pairs && pairs.length) buildPanel(pairs);
  }

  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',render); else render();
  addEventListener('pageshow', render);
  addEventListener('ymv:urlchange',render);
  addEventListener('hashchange',render);
  new MutationObserver(()=>{ if(!document.getElementById(HOST)) render(); })
    .observe(document.documentElement,{childList:true,subtree:true});
  setInterval(()=>{ if(!document.getElementById(HOST)) render(); },1000);
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
