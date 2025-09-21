// ==UserScript==
// @name         YM Panel (Yahoo/Aucfan) – bottom-right, collapsible, close-tab
// @namespace    ymv-panel-sticky
// @description  Title, 売値($), 利益率(%), NM入札(¥), NM利益(¥), FP入札(¥), Category, Brand, Class, 販売個数。右下固定・折りたたみ可（PCは既定で展開）。Aucfan/Yahoo 両対応、#ymv 引き継ぎ、NM/FPは数値コピー、×でタブを閉じる。
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

  // ---- URL change hook（SPA対策）----
  const _push = history.pushState, _replace = history.replaceState;
  const fire = ()=>window.dispatchEvent(new Event('ymv:urlchange'));
  history.pushState   = function(){ _push.apply(this,arguments);   fire(); };
  history.replaceState= function(){ _replace.apply(this,arguments); fire(); };
  addEventListener('popstate', fire);

  // ---- ymv 保存/復元 ----
  const K='ymv:lastPayload', T='ymv:lastTime', EXP=30*60*1000;
  const now=()=>Date.now();
  const enc = s=>{ try{return encodeURIComponent(s)}catch{return ''} };

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
  const parse=q=>{
    if(!q) return [];
    try{
      const dec=decodeURIComponent(q);
      return dec.split('|').map(s=>{
        const i=s.indexOf('='); return i>=0?[s.slice(0,i),s.slice(i+1)]:[s,''];
      });
    }catch{ return []; }
  };
  const toStr=pairs=>pairs.map(([k,v])=>k+'='+(v||'')).join('|');
  async function save(pairs){ try{ await GM_setValue(K,toStr(pairs)); await GM_setValue(T,now()); }catch{} }
  async function load(){
    try{
      const t=await GM_getValue(T,0); if(!t||now()-t>EXP) return [];
      const raw=await GM_getValue(K,''); if(!raw) return [];
      return raw.split('|').map(s=>{ const i=s.indexOf('='); return i>=0?[s.slice(0,i),s.slice(i+1)]:[s,'']; });
    }catch{ return []; }
  }
  const buildYmvHash = pairs => '#ymv='+enc(toStr(pairs));

  // ---- パネルホスト（Shadow DOM, 右下固定）----
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
  const getRaw = keys=>{
    for(const k of keys){ const kv=current.find(([kk])=>kk===k); if(kv) return kv[1]; }
    return '';
  };

  // ---- 表示フォーマッタ ----
  const yen = v=>{
    if(v==null||v==='') return '';
    const n=Number(String(v).replace(/[^\d.-]/g,'')); if(!isFinite(n)) return String(v);
    return '¥'+n.toLocaleString('ja-JP',{maximumFractionDigits:0});
  };
  const usd = v=>{
    if(v==null||v==='') return '';
    const n=Number(String(v).replace(/[^\d.-]/g,'')); if(!isFinite(n)) return '$'+String(v);
    const hasDec=String(v).includes('.');
    return '$'+(hasDec?n.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}):n.toLocaleString('en-US'));
  };
  const pct = v=>{
    if(v==null||v==='') return '';
    const n=Number(String(v).replace(/[^\d.-]/g,'')); if(!isFinite(n)) return String(v);
    return Math.round(n*100)+'%'; // 0.3 -> 30%
  };

  // ---- コピー（数値のみ）----
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
  function flash(btn,msg){
    if(!btn) return;
    const o=btn.textContent; btn.textContent=msg; setTimeout(()=>btn.textContent=o,900);
  }

  // ---- × でタブを閉じる（ベストエフォート）----
  function closeTab(){
    try{ window.close(); }catch{}
    setTimeout(()=>{
      try{ window.open('','_self').close(); }catch{}
      setTimeout(()=>{
        if (document.referrer) history.back();
        else location.href='about:blank';
      },120);
    },60);
  }

  // ---- パネル構築 ----
  function build(pairs){
    current=pairs.slice(0);
    ensureHost();

    // 値の抽出
    const title       = getRaw(['Title']) || document.title.replace(/\s*\|\s*ヤフオク!.*/,'');
    const usdVal      = getRaw(['売値(USD)']);
    const profRaw     = getRaw(['利益率','TARGET_PROFIT_RATE']);
    const nmBidRaw    = getRaw(['NM入札','NM｜入札','NM|入札']);
    const nmProfitRaw = getRaw(['NM利益','NM｜利益','NM|利益']);
    const fpBidRaw    = getRaw(['FP入札','FP｜入札','FP|入札']);
    const category    = getRaw(['Category']);
    const brand       = getRaw(['Brand']);
    const klass       = getRaw(['Class']);
    const sold        = getRaw(['販売個数','売']);

    // Aucfanリンク（ID優先）+ #ymv 付与
    const m=location.href.match(/\bauction\/([A-Za-z0-9]+)\b/i);
    const aucId=m?m[1]:'';
    const aucfanId=aucId?('https://aucfan.com/aucview/yahoo/'+enc(aucId)+'/'):'';
    const aucfanQ='https://aucfan.com/search1/?q='+enc(title||'');
    const aucURL=(aucfanId||aucfanQ)+buildYmvHash(current);

    // 表示順
    const ordered=[];
    ordered.push(['Title', title]);
    if(usdVal)        ordered.push(['売値',     usd(usdVal)]);
    if(profRaw!=='')  ordered.push(['利益率',   pct(profRaw)]);
    if(nmBidRaw)      ordered.push(['NM入札',   yen(nmBidRaw)]);
    if(nmProfitRaw)   ordered.push(['NM利益',   yen(nmProfitRaw)]);
    if(fpBidRaw)      ordered.push(['FP入札',   yen(fpBidRaw)]);
    if(category)      ordered.push(['Category', category]);
    if(brand)         ordered.push(['Brand',    brand]);
    if(klass)         ordered.push(['Class',    klass]);
    if(sold!=='')     ordered.push(['販売個数', sold]);

    // UI（右下 / 背景#216D89 / 白文字 / 折りたたみ可）
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        .box{
          all:initial; display:block;
          background:#216D89; color:#fff;
          border:1px solid #1B5870; border-radius:12px;
          box-shadow:0 8px 20px rgba(0,0,0,.25);
          padding:8px 8px 6px;
          min-width:240px; max-width:90vw;
          font:14px/1.4 -apple-system,system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif;
        }
        .header{display:flex; align-items:center; gap:6px; margin:0 0 4px;}
        .title{font-weight:700; flex:1; min-width:0; color:#fff;}
        .list{margin:0 4px 6px; max-height:50vh; overflow:auto;}
        .row{margin:2px 0;}
        .k{display:inline-block; min-width:96px; color:rgba(255,255,255,.85);}
        .v{font-weight:700; color:#fff;}
        .btns{display:flex; gap:6px; flex-wrap:nowrap; justify-content:flex-end;}
        .btn{
          all:initial; display:inline-block; text-align:center;
          padding:4px 8px; border-radius:6px; font-size:12px; cursor:pointer;
          border:1px solid rgba(255,255,255,.45);
          background:rgba(255,255,255,.10); color:#fff;
        }
        .btn:hover{ background:rgba(255,255,255,.18); }
      </style>
      <div class="box" id="box">
        <div class="header">
          <div class="title">eBayStock+</div>
          <button class="btn" id="toggle">▾</button>
        </div>
        <div class="list" id="list"></div>
        <div class="btns">
          <a class="btn" id="btnAuc" target="_blank" rel="noopener">Aucfan</a>
          <button class="btn" id="btnNM">NM｜入札</button>
          <button class="btn" id="btnFP">FP｜入札</button>
          <button class="btn" id="btnClose">×</button>
        </div>
      </div>
    `;

    // リスト描画
    const listEl=shadow.getElementById('list');
    listEl.innerHTML='';
    ordered.forEach(([k,v])=>{
      const row=document.createElement('div');
      row.className='row';
      row.innerHTML='<span class="k"></span><span class="v"></span>';
      row.children[0].textContent=k;
      row.children[1].textContent=v;
      listEl.appendChild(row);
    });

    // 折りたたみ（PCはデフォルトで展開）
    let collapsed = false;
    const toggleBtn = shadow.getElementById('toggle');
    const setCollapsed = flag=>{
      collapsed=!!flag;
      listEl.style.display = collapsed ? 'none' : 'block';
      toggleBtn.textContent = collapsed ? '▸' : '▾';
    };
    setCollapsed(false); // PC 既定で展開

    toggleBtn.addEventListener('click', ()=> setCollapsed(!collapsed));

    // ボタン動作
    const aAuc = shadow.getElementById('btnAuc');
    aAuc.href = aucURL;
    aAuc.addEventListener('click', ()=>{ try{
      GM_setValue && GM_setValue(K, toStr(current));
      GM_setValue && GM_setValue(T, Date.now());
    }catch(_){} });

    shadow.getElementById('btnNM').addEventListener('click', e=>copyNum(nmBidRaw, e.currentTarget));
    shadow.getElementById('btnFP').addEventListener('click', e=>copyNum(fpBidRaw, e.currentTarget));
    shadow.getElementById('btnClose').addEventListener('click', closeTab);

  } // build

  let last='';
  const sig=p=>p.map(([k,v])=>k+'='+v).join('|');

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
  // 万一消されたら再描画
  new MutationObserver(()=>{ if(!document.getElementById(HOST)) render(); })
    .observe(document.documentElement,{childList:true,subtree:true});
  setInterval(()=>{ if(!document.getElementById(HOST)) render(); },1000);
})();
