// ==UserScript==
// @name         YM Panel (Yahoo/Aucfan) – Aucfan/TP を行内に配置
// @namespace    ymv-panel-sticky
// @description  基準売値行に eBay(高順)、現在安値行に eBay(安順)。Aucfan は「販売個数」行、Terapeak は「Class」行へ配置。USDは常に2桁、NM利益は括弧＆小さめフォント。
// @match        https://auctions.yahoo.co.jp/*
// @match        https://page.auctions.yahoo.co.jp/*
// @match        https://aucfan.com/*
// @match        https://aucview.aucfan.com/*
// @run-at       document-start
// @grant        GM_setValue
// @grant        GM_getValue
// ==/UserScript==
(function(){
  'use strict';

  /* ---------- SPA URL 変化検知 ---------- */
  const _push = history.pushState, _replace = history.replaceState;
  const fire = ()=>window.dispatchEvent(new Event('ymv:urlchange'));
  history.pushState    = function(){ _push.apply(this,arguments);    fire(); };
  history.replaceState = function(){ _replace.apply(this,arguments); fire(); };
  addEventListener('popstate', fire);

  /* ---------- ymv 保存/復元 ---------- */
  const K='ymv:lastPayload', T='ymv:lastTime', EXP=30*60*1000;
  const now=()=>Date.now();
  const enc = s=>{ try{return encodeURIComponent(s)}catch{return ''} };
  function getYmvRaw(){ try{
    const u=new URL(location.href);
    let q=u.searchParams.get('ymv');
    if(!q){ const h=new URLSearchParams(location.hash.replace(/^#/, '')); q=h.get('ymv')||''; }
    return q||'';
  }catch{ return ''; } }
  const parse=q=>{ if(!q) return []; try{
    const dec=decodeURIComponent(q);
    return dec.split('|').map(s=>{ const i=s.indexOf('='); return i>=0?[s.slice(0,i),s.slice(i+1)]:[s,'']; });
  }catch{ return []; } };
  const toStr=pairs=>pairs.map(([k,v])=>k+'='+(v||'')).join('|');
  async function save(pairs){ try{ await GM_setValue(K,toStr(pairs)); await GM_setValue(T,now()); }catch{} }
  async function load(){ try{
    const t=await GM_getValue(T,0); if(!t||now()-t>EXP) return [];
    const raw=await GM_getValue(K,''); if(!raw) return [];
    return raw.split('|').map(s=>{ const i=s.indexOf('='); return i>=0?[s.slice(0,i),s.slice(i+1)]:[s,'']; });
  }catch{ return []; } }
  const buildYmvHash = pairs => '#ymv='+enc(toStr(pairs));

  /* ---------- パネルホスト ---------- */
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

  /* ---------- 値取得 ---------- */
  const getRaw = (patterns)=>{
    for(const pat of patterns){
      for(const [k,v] of current){
        if (typeof pat === 'string' && k === pat) return v;
        if (pat instanceof RegExp && pat.test(k)) return v;
      }
    }
    return '';
  };

  /* ---------- フォーマッタ ---------- */
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

  /* ---------- クリップボード ---------- */
  function copyNum(raw, btn){
    const num = String(raw||'').replace(/[^\d.-]/g,'');
    if(!num){ flash(btn,'No Value'); return false; }
    const ok = legacyCopy(num);
    if(ok){ flash(btn,'Copied!'); return true; }
    if(navigator.clipboard && window.isSecureContext){
      navigator.clipboard.writeText(num).then(()=>flash(btn,'Copied!')).catch(()=>flash(btn,'Copy NG'));
      return true;
    }
    flash(btn,'Copy NG'); return false;
    function legacyCopy(text){
      try{
        const el=document.createElement('input');
        el.value=text; el.setAttribute('readonly','');
        el.style.cssText='position:fixed;top:0;left:0;opacity:0.01;pointer-events:none;z-index:-1;';
        document.body.appendChild(el);
        el.focus({preventScroll:true});
        el.select(); el.setSelectionRange(0, el.value.length);
        const ok=document.execCommand('copy');
        document.body.removeChild(el);
        return ok;
      }catch{ return false; }
    }
  }
  function flash(btn,msg){ if(!btn) return; const o=btn.textContent; btn.textContent=msg; setTimeout(()=>btn.textContent=o,900); }
  function closeTab(){
    try{ window.close(); }catch{}
    setTimeout(()=>{ try{ window.open('','_self').close(); }catch{}; setTimeout(()=>{ if (document.referrer) history.back(); else location.href='about:blank'; },120); },60);
  }

  /* ---------- eBay/Terapeak URL 補助 ---------- */
  function normalizeUrl(u){
    if(!u) return u;
    return String(u).replace(/\uFF1D/g,'=').replace(/\uFF06/g,'&').replace(/\uFF1F/g,'?').replace(/\uFF03/g,'#');
  }
  function extractKeywords(ebayUrl, title){
    try{
      const u = new URL(normalizeUrl(ebayUrl||'')); const kw = u.searchParams.get('_nkw') || ''; if(kw) return kw;
    }catch{}
    return String(title||'').trim();
  }
  function buildEbayVariant(baseUrl, title, variant){
    const safe = normalizeUrl(baseUrl||'');
    let candidate = safe || ('https://www.ebay.com/sch/i.html?_nkw='+encodeURIComponent(title||''));
    try{
      const u = new URL(candidate);
      if(variant==='activeLow'){ u.searchParams.delete('LH_Sold'); u.searchParams.delete('LH_Complete'); u.searchParams.set('_sop','15'); }
      else if(variant==='soldHigh'){ u.searchParams.set('LH_Sold','1'); u.searchParams.set('LH_Complete','1'); u.searchParams.set('_sop','16'); }
      return u.toString();
    }catch(_){
      let s = candidate;
      if(variant==='activeLow'){ s = s.replace(/([?&])LH_Sold=1/g,'$1').replace(/([?&])LH_Complete=1/g,'$1'); s += (s.includes('?')?'&':'?') + '_sop=15'; }
      else{ s += (s.includes('?')?'&':'?') + 'LH_Sold=1&LH_Complete=1&_sop=16'; }
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
    u.searchParams.set('offset','0');
    u.searchParams.set('limit','50');
    u.searchParams.set('tabName','SOLD');
    u.searchParams.set('tz','Asia/Tokyo');
    return u.toString();
  }

  /* ---------- パネル構築 ---------- */
  function build(pairs){
    current=pairs.slice(0);
    ensureHost();

    const title = getRaw(['Title']) || document.title.replace(/\s*\|\s*ヤフオク!.*/,'');

    // USD 値
    const baseUsdRaw = getRaw([/^基準売値(?:\((?:USD|\$)\))?$/, /^売値(?:\((?:USD|\$)\))?$/]);
    const nowUsdRaw  = getRaw([/^現在安値(?:\((?:USD|\$)\))?$/, /^NM[|｜]?最安\(API Active\)$/]);

    // eBay
    const ebayUrlRaw = getRaw(['eBayURL','eBay','Ebay','EBAY_URL']);
    const ebayActiveLow = buildEbayVariant(ebayUrlRaw, title, 'activeLow');
    const ebaySoldHigh  = buildEbayVariant(ebayUrlRaw, title, 'soldHigh');

    // 利益率（A3 / A5）
    const profRaw     = getRaw(['利益率','TARGET_PROFIT_RATE']);
    const altProfRaw  = getRaw(['利益率(現安)','ALT_TARGET_PROFIT_RATE']);

    // 金額（基準ベース）
    const nmBidRaw    = getRaw(['NM入札','NM｜入札','NM|入札']);
    const nmProfitRaw = getRaw(['NM利益','NM｜利益','NM|利益']);
    const fpBidRaw    = getRaw(['FP入札','FP｜入札','FP|入札']);

    // 金額（現安ベース：H/I/J）
    const nmBidNowRaw    = getRaw(['NM入札(現安)','NM|入札(現安)']);
    const nmProfitNowRaw = getRaw(['NM利益(現安)','NM|利益(現安)']);
    const fpBidNowRaw    = getRaw(['FP入札(現安)','FP|入札(現安)']);

    // 属性
    const category = getRaw(['Category']);
    const brand    = getRaw(['Brand']);
    const klass    = getRaw(['Class']);
    const sold     = getRaw(['販売個数','売']);

    // Aucfan / Terapeak
    const m=location.href.match(/\bauction\/([A-Za-z0-9]+)\b/i);
    const aucId=m?m[1]:'';
    const aucfanId=aucId?('https://aucfan.com/aucview/yahoo/'+encodeURIComponent(aucId)+'/'):'';
    const aucfanQ='https://aucfan.com/search1/?q='+encodeURIComponent(title||'');
    const aucURL=(aucfanId||aucfanQ)+buildYmvHash(current);
    const tpURL  = buildTerapeakUrl(extractKeywords(ebayUrlRaw, title));

    // NM入札 行の表示（「(利益 xxx)」は小さめ）
    const nmBaseMain   = nmBidRaw!=='' ? yen(nmBidRaw) : '';
    const nmBaseProfit = nmProfitRaw!=='' ? yen(nmProfitRaw) : '';
    const nmLineBaseHtml = nmBaseMain ? nmBaseMain + (nmBaseProfit ? ` <span class="profit-sub">(利益 ${nmBaseProfit})</span>` : '') : '';
    const nmNowMain   = nmBidNowRaw!=='' ? yen(nmBidNowRaw) : '';
    const nmNowProfit = nmProfitNowRaw!=='' ? yen(nmProfitNowRaw) : '';
    const nmLineNowHtml = nmNowMain ? nmNowMain + (nmNowProfit ? ` <span class="profit-sub">(利益 ${nmNowProfit})</span>` : '') : '';

    // 表示順データ（特定行に mini ボタンを付けるためフラグを付与）
    const items=[];
    items.push({type:'row', k:'Title', v:title});
    if(category) items.push({type:'row', k:'Category', v:category});
    if(brand)    items.push({type:'row', k:'Brand',    v:brand});
    if(klass)    items.push({type:'row', k:'Class',    v:klass, tp:true});          // ← Terapeak をここに
    if(sold!=='')items.push({type:'row', k:'販売個数',  v:sold, aucfan:true});       // ← Aucfan をここに
    items.push({type:'sep'});

    items.push({type:'group', label:'高利益仕入'});
    items.push({type:'row', k:'基準売値($)', v: baseUsdRaw!=='' ? usd(baseUsdRaw) : '—', ebay:'high'});
    if(profRaw!=='') items.push({type:'row', k:'利益率(%)', v:pct(profRaw)});
    if(nmLineBaseHtml) items.push({type:'row', k:'NM入札(¥)', vHtml:nmLineBaseHtml, copyRaw:nmBidRaw});
    if(fpBidRaw!=='')   items.push({type:'row', k:'FP入札(¥)', v:yen(fpBidRaw),     copyRaw:fpBidRaw});
    items.push({type:'sep'});

    items.push({type:'group', label:'高回転仕入'});
    items.push({type:'row', k:'現在安値($)', v: nowUsdRaw!=='' ? usd(nowUsdRaw) : '—', ebay:'low'});
    if(altProfRaw!=='') items.push({type:'row', k:'利益率(%)', v:pct(altProfRaw)});
    if(nmLineNowHtml)   items.push({type:'row', k:'NM入札(¥)', vHtml:nmLineNowHtml, copyRaw:nmBidNowRaw});
    if(fpBidNowRaw!=='')items.push({type:'row', k:'FP入札(¥)', v:yen(fpBidNowRaw),  copyRaw:fpBidNowRaw});

    /* ---------- UI ---------- */
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        .box{
          all:initial; display:block;
          background:#216D89; color:#fff;
          border:1px solid #1B5870; border-radius:12px;
          box-shadow:0 8px 20px rgba(0,0,0,.25);
          padding:8px 8px 6px;
          min-width:320px; max-width:92vw;
          font:14px/1.4 -apple-system,system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif;
        }
        .header{display:flex; align-items:center; gap:6px; margin:0 0 4px;}
        .title{font-weight:700; flex:1; min-width:0; color:#fff;}
        .headbtns{display:flex; gap:6px;}
        .btn{
          all:initial; display:inline-block; text-align:center;
          padding:4px 8px; border-radius:6px; font-size:12px; cursor:pointer;
          border:1px solid rgba(255,255,255,.45);
          background:rgba(255,255,255,.10); color:#fff;
        }
        .btn.icon{width:28px; padding:2px 0; font-weight:700;}
        .btn:hover{ background:rgba(255,255,255,.18); }
        .btn.copy{ padding:2px 6px; font-size:11px; margin-left:16px; }
        .btn.mini{ padding:2px 6px; font-size:11px; margin-left:10px; white-space:nowrap; }
        .btn .paren-sub{ font-size:11px; opacity:.9; }
        .list{margin:0 4px 6px; max-height:50vh; overflow:auto;}
        .row{margin:2px 0; display:flex; align-items:center;}
        .k{display:inline-block; min-width:96px; margin-right:8px; color:rgba(255,255,255,.85);}
        .v{font-weight:700; color:#fff; flex:1;}
        .profit-sub{ font-size:12px; font-weight:700; opacity:.9; }
        .sep{border-top:1px dashed rgba(255,255,255,.40); margin:8px 2px;}
        .group{margin:6px 2px 2px; font-weight:700; color:#fff;
               border-left:4px solid rgba(255,255,255,.45); padding-left:6px;}
        .gbody{ padding-left:10px; }
      </style>
      <div class="box" id="box">
        <div class="header">
          <div class="title">eBayStock+</div>
          <div class="headbtns">
            <button class="btn icon" id="toggle"   title="折りたたみ">▾</button>
            <button class="btn icon" id="btnClose" title="このタブを閉じる">×</button>
          </div>
        </div>
        <div class="list" id="list"></div>
      </div>
    `;

    const touchSave = ()=>{ try{
      GM_setValue && GM_setValue(K, toStr(current));
      GM_setValue && GM_setValue(T, Date.now());
    }catch{} };

    /* ---------- リスト描画（行内ボタン付与） ---------- */
    const listEl=shadow.getElementById('list');
    listEl.innerHTML='';
    let container = listEl;
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

      // コピーアイコン
      if('copyRaw' in item && item.copyRaw!==''){
        const b=document.createElement('button');
        b.className='btn copy'; b.textContent='⧉'; b.title='値をコピー';
        b.addEventListener('click', e=>copyNum(item.copyRaw, e.currentTarget));
        row.appendChild(b);
      }

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

      // Terapeak を Class 行に
      if(item.tp){
        const tp = document.createElement('a');
        tp.className='btn mini';
        tp.target='_blank'; tp.rel='noopener';
        tp.href = tpURL;
        tp.textContent='Terapeak';
        tp.title='Terapeak SOLD（過去90日）';
        tp.addEventListener('click', touchSave);
        row.appendChild(tp);
      }

      // Aucfan を 販売個数 行に
      if(item.aucfan){
        const af = document.createElement('a');
        af.className='btn mini';
        af.target='_blank'; af.rel='noopener';
        af.href = aucURL;
        af.textContent='Aucfan';
        af.title='Aucfan 検索';
        af.addEventListener('click', touchSave);
        row.appendChild(af);
      }

      container.appendChild(row);
    });

    /* ---------- 折りたたみ・クローズ ---------- */
    let collapsed = false;
    const toggleBtn = shadow.getElementById('toggle');
    const setCollapsed = flag=>{
      collapsed=!!flag;
      listEl.style.display = collapsed ? 'none' : 'block';
      toggleBtn.textContent = collapsed ? '▸' : '▾';
    };
    setCollapsed(false);
    toggleBtn.addEventListener('click', ()=> setCollapsed(!collapsed));
    shadow.getElementById('btnClose').addEventListener('click', closeTab);
  }

  /* ---------- レンダリング制御 ---------- */
  let last=''; const sig=p=>p.map(([k,v])=>k+'='+v).join('|');
  async function render(){
    const q=getYmvRaw();
    if(q){
      const pairs=parse(q);
      if(pairs.length){
        await save(pairs);
        const s=sig(pairs); if(s!==last){ last=s; build(pairs); }
        return;
      }
    }
    const saved=await load();
    if(saved.length){
      const s=sig(saved); if(s!==last){ last=s; build(saved); }
    }
  }

  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',render); else render();
  addEventListener('pageshow', render);
  addEventListener('ymv:urlchange',render);
  addEventListener('hashchange',render);
  new MutationObserver(()=>{ if(!document.getElementById(HOST)) render(); })
    .observe(document.documentElement,{childList:true,subtree:true});
  setInterval(()=>{ if(!document.getElementById(HOST)) render(); },1000);
})();
