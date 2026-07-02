'use strict';
process.on('uncaughtException',  e => console.error('[UNCAUGHT]', e));
process.on('unhandledRejection', e => console.error('[UNHANDLED]', e));
/**
 * spark_nel_server.js
 * Local dashboard server for SPARK NEL — Ongoing WMS
 *
 * Usage:
 *   node spark_nel_server.js
 * Then open: http://localhost:3456
 *
 * Requires spark_nel_config.json in the same directory:
 *   { "username": "Tnix", "password": "YOUR_PASSWORD" }
 */

const http   = require('http');
const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

// ── Constants ────────────────────────────────────────────────────────────────
const PORT          = process.env.PORT || 3456;   // Railway sets PORT; falls back to 3456 locally
const GOODS_OWNER   = 93;
const WMS_HOST      = 'api.ongoingsystems.se';
const WMS_PATH      = '/BWSBNE/automation.asmx';
const WMS_NS        = 'http://ongoingsystems.se/Automation';
const CACHE_TTL     = 5 * 60 * 1000;
const REFRESH_HOURS_UTC = [6, 18];                // refresh data twice a day (06:00 & 18:00 UTC) — like the other dashboards, NOT on page-open
const DATA_DIR      = process.env.RAILWAY_VOLUME_MOUNT_PATH || __dirname;  // persisted cache dir (Railway volume in prod, survives deploys)
const CONFIG_FILE   = path.join(__dirname, 'spark_nel_config.json');
// Contract + transport live on the persisted volume so edits/bookings survive deploys; seeded from the repo copy on first run.
const CONTRACT_SEED   = path.join(__dirname, 'spark_nel_contract.json');
const CONTRACT_FILE   = path.join(DATA_DIR, 'spark_nel_contract.json');
const TRANSPORT_SEED  = path.join(__dirname, 'transport_data.json');
const TRANSPORT_FILE  = path.join(DATA_DIR, 'transport_data.json');
try {
  if (DATA_DIR !== __dirname) {
    for (const [seed, live] of [[TRANSPORT_SEED, TRANSPORT_FILE], [CONTRACT_SEED, CONTRACT_FILE]]) {
      if (!fs.existsSync(live) && fs.existsSync(seed)) fs.copyFileSync(seed, live);
    }
  }
} catch (e) { console.error('[seed] volume seed failed:', e.message); }

// ── Config / Contract ────────────────────────────────────────────────────────
function loadConfig() {
  // Prefer environment variables (Railway / cloud hosting)
  if (process.env.WMS_USERNAME && process.env.WMS_PASSWORD) {
    return { username: process.env.WMS_USERNAME, password: process.env.WMS_PASSWORD };
  }
  // Fall back to local config file
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    } catch (e) {
      console.error('Invalid JSON in config file:', e.message);
    }
  }
  // Return null — server still starts; /api/data returns 503 with a clear message
  console.error('[WMS] No credentials found. Set WMS_USERNAME and WMS_PASSWORD env vars.');
  return null;
}

function loadContract() {
  if (!fs.existsSync(CONTRACT_FILE)) {
    return { carrier:'', service:'', contractNumber:'', effectiveDate:'', expiryDate:'', accountCode:'', notes:'', rates:[] };
  }
  return JSON.parse(fs.readFileSync(CONTRACT_FILE, 'utf8'));
}

function saveContract(data) {
  fs.writeFileSync(CONTRACT_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function loadTransport() {
  if (!fs.existsSync(TRANSPORT_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(TRANSPORT_FILE, 'utf8')); } catch { return null; }
}

function saveTransport(data) {
  fs.writeFileSync(TRANSPORT_FILE, JSON.stringify(data), 'utf8');
}

// ── SOAP helpers ─────────────────────────────────────────────────────────────
function soapRequest(operation, innerXml) {
  const envelope = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
               xmlns:xsd="http://www.w3.org/2001/XMLSchema"
               xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <${operation} xmlns="${WMS_NS}">
${innerXml}
    </${operation}>
  </soap:Body>
</soap:Envelope>`;

  return new Promise((resolve, reject) => {
    const buf = Buffer.from(envelope, 'utf8');
    const opts = {
      hostname: WMS_HOST,
      path: WMS_PATH,
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'SOAPAction': `${WMS_NS}/${operation}`,
        'Content-Length': buf.length
      }
    };
    const req = https.request(opts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', reject);
    req.write(buf);
    req.end();
  });
}

// Extract first match of a tag's inner text (namespace-agnostic)
function xmlVal(xml, tag) {
  const re = new RegExp(`<(?:[\\w:]*:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w:]*:)?${tag}>`, 'i');
  const m = re.exec(xml);
  return m ? m[1].trim() : '';
}

// Extract all outer blocks matching a tag
function xmlBlocks(xml, tag) {
  const re = new RegExp(`<(?:[\\w:]*:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w:]*:)?${tag}>`, 'gi');
  const out = [];
  let m;
  while ((m = re.exec(xml)) !== null) out.push(m[1]);
  return out;
}

function parseDate(s) {
  if (!s) return null;
  const d = new Date(s);
  if (isNaN(d.getTime()) || d.getFullYear() < 2000) return null;
  return d;
}

// ── Fetch from Ongoing WMS ───────────────────────────────────────────────────
async function fetchOrders(cfg) {
  const from = new Date();
  from.setMonth(from.getMonth() - 12);
  const fromStr = from.toISOString().split('.')[0]; // YYYY-MM-DDTHH:mm:ss

  const body = await soapRequest('GetOrdersByQuery', `
      <UserName>${cfg.username}</UserName>
      <Password>${cfg.password}</Password>
      <Query>
        <GoodsOwnerId>${GOODS_OWNER}</GoodsOwnerId>
        <CreatedTimeFrom>${fromStr}</CreatedTimeFrom>
        <MaxOrdersToGet>1000</MaxOrdersToGet>
      </Query>`);

  if (body.includes('<faultstring>')) {
    throw new Error('WMS fault: ' + xmlVal(body, 'faultstring'));
  }

  // Check API-level success flag
  const success = xmlVal(body, 'Success');
  if (success === 'false') {
    throw new Error('WMS error: ' + xmlVal(body, 'Message'));
  }

  // Each <Order> block wraps <OrderInfo> and <ExternalSystemId>
  const blocks = xmlBlocks(body, 'Order');

  return blocks.map(b => {
    const info = xmlVal(b, 'OrderInfo');
    return {
      orderId:    xmlVal(info || b, 'OrderId') || xmlVal(b, 'ExternalSystemId'),
      externalId: xmlVal(info || b, 'GoodsOwnerOrderNumber') || xmlVal(info || b, 'GoodsOwnerOrderId'),
      orderDate:  parseDate(xmlVal(info || b, 'CreatedDate')),
      shippedTime:parseDate(xmlVal(info || b, 'ShippedTime')),
      statusId:   xmlVal(info || b, 'OrderStatusNumber'),
      statusText: xmlVal(info || b, 'OrderStatusText'),
      lines:      Math.round(parseFloat(xmlVal(info || b, 'OrderedNumberOfItems') || '0')) || 0,
      remark:     xmlVal(info || b, 'OrderRemark')
    };
  });
}

// ── Week / month helpers ─────────────────────────────────────────────────────
function isoWeekLabel(d) {
  const mon = new Date(d);
  mon.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // Monday
  return mon.toLocaleDateString('en-AU', { day:'2-digit', month:'short' });
}

function monthKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2,'0')}`;
}

function monthLabel(d) {
  return d.toLocaleDateString('en-AU', { month:'short', year:'numeric' });
}

// ── Process raw orders into dashboard payload ────────────────────────────────
function processOrders(orders) {
  // Ongoing WMS status 700+ = cancelled/deleted in this installation
  const CANCELLED = new Set(['700','800','900','90','95','1000']);
  const now = new Date();

  const gone    = orders.filter(o => o.shippedTime !== null);
  const pending = orders.filter(o => !o.shippedTime && !CANCELLED.has(o.statusId));

  // Week start (Monday) of today
  const todayMon = new Date(now);
  todayMon.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  todayMon.setHours(0,0,0,0);

  const thisWeekGone = gone.filter(o => o.shippedTime >= todayMon).length;

  // ── Weekly — last 13 Mondays ──────────────────────────────────────────────
  const weeklyData = [];
  for (let w = 12; w >= 0; w--) {
    const wStart = new Date(todayMon);
    wStart.setDate(todayMon.getDate() - w * 7);
    const wEnd = new Date(wStart);
    wEnd.setDate(wStart.getDate() + 7);

    weeklyData.push({
      label:      isoWeekLabel(wStart),
      dispatched: gone.filter(o => o.shippedTime >= wStart && o.shippedTime < wEnd).length,
      created:    orders.filter(o => o.orderDate && o.orderDate >= wStart && o.orderDate < wEnd).length
    });
  }

  // ── Monthly — last 12 months ──────────────────────────────────────────────
  const monthlyMap = new Map();
  for (let m = 11; m >= 0; m--) {
    const d = new Date(now.getFullYear(), now.getMonth() - m, 1);
    const key = monthKey(d);
    monthlyMap.set(key, { label: monthLabel(d), dispatched: 0, created: 0 });
  }
  orders.forEach(o => {
    if (o.orderDate) {
      const k = monthKey(o.orderDate);
      if (monthlyMap.has(k)) monthlyMap.get(k).created++;
    }
    if (o.shippedTime) {
      const k = monthKey(o.shippedTime);
      if (monthlyMap.has(k)) monthlyMap.get(k).dispatched++;
    }
  });
  const monthlyData = [...monthlyMap.values()];

  // Sort orders for tables
  const recentGone = [...gone]
    .sort((a,b) => b.shippedTime - a.shippedTime)
    .slice(0, 50)
    .map(o => ({ ...o, orderDate: o.orderDate?.toISOString(), shippedTime: o.shippedTime?.toISOString() }));

  const pendingList = [...pending]
    .sort((a,b) => (b.orderDate || 0) - (a.orderDate || 0))
    .slice(0, 50)
    .map(o => ({ ...o, orderDate: o.orderDate?.toISOString(), shippedTime: null }));

  return {
    total: orders.length,
    gone: gone.length,
    pending: pending.length,
    thisWeekGone,
    weeklyData,
    monthlyData,
    recentGone,
    pendingOrders: pendingList,
    lastFetch: new Date().toISOString()
  };
}

// ── Orders cache (serve-stale + background refresh; a request NEVER waits on WMS) ──
const ORDERS_FILE = path.join(DATA_DIR, 'spark_nel_orders.json');
let cache     = null;
let cacheTime = 0;
let ordersRefreshing = false;

function loadOrdersFile() {
  try {
    if (fs.existsSync(ORDERS_FILE)) {
      cache = JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf8'));
      cacheTime = Date.parse(cache.lastFetch) || Date.now();
      console.log('[Orders] loaded persisted cache —', cache.total, 'orders');
    }
  } catch (e) { console.error('[Orders] cache read failed:', e.message); }
}

async function refreshOrders(cfg) {
  if (ordersRefreshing || !cfg) return;
  ordersRefreshing = true;
  try {
    const orders = await fetchOrders(cfg);
    cache = processOrders(orders);
    cacheTime = Date.now();
    try { fs.writeFileSync(ORDERS_FILE, JSON.stringify(cache)); } catch (e) {}
    console.log('[Orders] refreshed —', cache.total, 'orders');
  } catch (e) { console.error('[Orders] refresh failed:', e.message); }
  finally { ordersRefreshing = false; }
}

// Non-blocking: return the current cache immediately. Only refresh on the manual Refresh
// button (force) or if there is no data at all yet — NEVER auto-refresh just because the
// page was opened. Scheduled twice-daily refresh keeps it current (see scheduleDaily).
function getDataFast(cfg, force) {
  if (force || !cache) refreshOrders(cfg);
  return cache;
}

// ── Dashboard HTML ───────────────────────────────────────────────────────────
/* ══════════════════════════════════════════════════════════════════════════
   WAREHOUSE MODULE (goods owner 93) — spliced into spark_nel_server.js
   WMS pulls are slow (articles ~78s, stock ~101s, POs heavy) so the snapshot is
   built on a BACKGROUND schedule into a persisted cache; /api/warehouse serves
   the compact payload instantly. Reuses soapRequest, xmlVal, xmlBlocks, parseDate.
   ══════════════════════════════════════════════════════════════════════════ */

const WAREHOUSE_FILE    = path.join(DATA_DIR, 'spark_nel_warehouse.json');
const WAREHOUSE_REFRESH = 12 * 60 * 60 * 1000;  // staleness threshold: on startup skip a rebuild if the cache is younger than this (12h)
const WH_INV_MONTHS     = 12;                    // inventory-adjustment look-back (fast: ~3s)
const WH_PO_MONTHS      = 6;                     // purchase-order look-back (heavy fetch — keep bounded)
const WH_PO_MAX         = 300;                   // cap POs fetched
let   warehouseCache    = null;                  // last good compact payload
let   warehouseBuilding = false;

function whInner(extra){ const c = loadConfig()||{}; return `\n      <UserName>${c.username||''}</UserName>\n      <Password>${c.password||''}</Password>\n      ${extra}`; }
const whNum = s => { const n = parseFloat(String(s).replace(/[^0-9.\-]/g,'')); return isNaN(n) ? 0 : n; };
const whYmd = s => { const d = parseDate(s); return d ? d.toISOString().slice(0,10) : ''; };
function whBackISO(months){ const d = new Date(); d.setMonth(d.getMonth()-months); return d.toISOString().split('.')[0]; }
function whSub(xml, parent, child){ const m = xml.match(new RegExp(`<${parent}>([\\s\\S]*?)</${parent}>`)); return m ? xmlVal(m[1], child) : ''; }

function loadWarehouseFile(){
  try { if (fs.existsSync(WAREHOUSE_FILE)) { warehouseCache = JSON.parse(fs.readFileSync(WAREHOUSE_FILE,'utf8')); console.log('[WH] loaded cached warehouse snapshot'); } }
  catch(e){ console.error('[WH] cache read failed:', e.message); }
}

async function buildWarehouse(cfg, force){
  if (warehouseBuilding || !cfg) return;
  if (!force && warehouseCache && warehouseCache.builtAt && (Date.now() - new Date(warehouseCache.builtAt).getTime()) < WAREHOUSE_REFRESH) {
    console.log('[WH] cache is fresh — skipping rebuild'); return;
  }
  warehouseBuilding = true;
  const t0 = Date.now();
  console.log('[WH] building warehouse snapshot…');
  try {
    // ── 1) Article master (paged) → metadata ─────────────────────────────────
    const meta = {};
    let from = 0, pages = 0;
    while (true) {
      const x = await soapRequest('GetArticlesByQuery', whInner(`<Query><GoodsOwnerId>${GOODS_OWNER}</GoodsOwnerId><ArticleDefIdFrom>${from}</ArticleDefIdFrom><MaxArticlesToGet>500</MaxArticlesToGet></Query>`));
      const bs = xmlBlocks(x, 'Article');
      if (!bs.length) break;
      for (const b of bs) {
        const no = xmlVal(b, 'ArticleNumber'); if (!no) continue;
        meta[no] = {
          name: xmlVal(b, 'ArticleName'),
          grp:  whSub(b,'ArticleGroup','Name')    || xmlVal(b,'ArticleGroupCode') || '—',
          sup:  whSub(b,'MainSupplier','SupplierName') || '—',
          cat:  whSub(b,'ArticleCategory','Name') || '—'
        };
      }
      const ids = [...x.matchAll(/<ArticleDefId>(\d+)<\/ArticleDefId>/g)].map(m=>+m[1]);
      const mx = ids.length ? Math.max(...ids) : from;
      pages++;
      if (mx <= from || bs.length < 500 || pages >= 20) break;
      from = mx;
    }

    // ── 2) Stock (all article items) → aggregate per article ──────────────────
    const stockXml = await soapRequest('GetArticleItemsByQuery', whInner(`<Query><GoodsOwnerId>${GOODS_OWNER}</GoodsOwnerId></Query>`));
    const stock = {}, locAgg = {};
    for (const b of xmlBlocks(stockXml, 'ArticleItemInfo')) {
      const no = xmlVal(b, 'ArticleNumber'); if (!no) continue;
      const q = whNum(xmlVal(b,'NumberOfItems'));
      const loc = (xmlVal(b,'Location') || '—').trim() || '—';   // stock-item location is a flat <Location>code</Location>
      if (!stock[no]) stock[no] = { onHand:0, items:0, grpCode: xmlVal(b,'ArticleGroupCode')||'—', unit: xmlVal(b,'ArticleUnitCode')||'', name: xmlVal(b,'ArticleName'), locUnits:{} };
      stock[no].onHand += q;
      stock[no].items++;
      stock[no].locUnits[loc] = (stock[no].locUnits[loc]||0) + q;
      if (!locAgg[loc]) locAgg[loc] = { units:0, items:0, skus:new Set() };
      locAgg[loc].units += q; locAgg[loc].items++; locAgg[loc].skus.add(no);
    }

    // ── 3) Purchase orders (in-orders, bounded — header-level only) ───────────
    let pos = [];
    try {
      const poXml = await soapRequest('GetInOrdersByQuery', whInner(`<Query><GoodsOwnerId>${GOODS_OWNER}</GoodsOwnerId><CreatedTimeFrom>${whBackISO(WH_PO_MONTHS)}</CreatedTimeFrom><MaxInOrdersToGet>${WH_PO_MAX}</MaxInOrdersToGet></Query>`));
      pos = xmlBlocks(poXml, 'ReceivedInOrder').map(b => {
        const info = (b.match(/<InOrderInfo>([\s\S]*?)<\/InOrderInfo>/)||[])[1] || b;
        return {
          id: xmlVal(info,'InOrderId'),
          no: xmlVal(info,'GoodsOwnerOrderNumber'),
          inDate: whYmd(xmlVal(info,'InDate')),
          recv:   whYmd(xmlVal(info,'ReceivedDate')),
          created:whYmd(xmlVal(info,'OrderDate')),
          status: xmlVal(info,'InOrderStatusNumber'),
          statusTxt: xmlVal(info,'InOrderStatusText') || ''
        };
      });
    } catch(e){ console.error('[WH] PO fetch failed:', e.message); pos = []; }

    // ── 4) Inventory adjustments (inventory changes — count/adjust txns only) ──
    const invXml = await soapRequest('GetInventoryChangesByQuery', whInner(`<Query><GoodsOwnerId>${GOODS_OWNER}</GoodsOwnerId><From>${whBackISO(WH_INV_MONTHS)}</From><To>${new Date().toISOString().split('.')[0]}</To><MaxArticlesToGet>4000</MaxArticlesToGet></Query>`));
    const adj = [];
    for (const line of xmlBlocks(invXml, 'InventoryChangeLine_GetInventoryChanges')) {
      const artNo = whSub(line,'Article','ArticleNumber');
      for (const t of xmlBlocks(line, 'InventoryTransaction_GetInventoryChanges')) {
        const im = t.match(/<Inventory>([\s\S]*?)<\/Inventory>/);
        if (!im) continue;  // only manual inventory counts/adjustments
        adj.push({
          date: whYmd(xmlVal(im[1],'InventoryTime')),
          art: artNo, name: (meta[artNo]||{}).name || (stock[artNo]||{}).name || '',
          qty: whNum(xmlVal(t,'InventoryChangesNumberOfItems')),
          user: whSub(t,'ByUser','UserName') || '—',
          comment: xmlVal(im[1],'InventoryItemComment') || '',
          loc: whSub(t,'Location','Location') || '',
          byCount: xmlVal(im[1],'ByInventoryCountTask') === 'true'
        });
      }
    }
    adj.sort((a,b)=> (b.date||'').localeCompare(a.date||''));

    warehouseCache = processWarehouse(meta, stock, pos, adj, locAgg);
    fs.writeFileSync(WAREHOUSE_FILE, JSON.stringify(warehouseCache), 'utf8');
    console.log(`[WH] snapshot built in ${((Date.now()-t0)/1000)|0}s — ${warehouseCache.kpi.skus} SKUs, ${pos.length} POs, ${adj.length} adjustments`);
  } catch (e) {
    console.error('[WH] build failed:', e.message);
  } finally {
    warehouseBuilding = false;
  }
}

// Location → zone / site classifiers (SPARK warehouse is bin-organised at the ThomasTown facility)
function zoneOf(loc){
  const U=(loc||'').toUpperCase().trim();
  if(!U||U==='—') return 'Unallocated';
  if(/STAGE|STAGING/.test(U)) return 'Staging';
  if(/YARD/.test(U)) return 'Yard';
  if(/(^|[^A-Z])TT([^A-Z]|$)|THOMAS/.test(U)) return 'Thomastown (site bay)';
  if(/(^|[^A-Z])CF([^A-Z]|$)|CAMPBELL/.test(U)) return 'Campbellfield (site bay)';
  if(/^[A-Z]{1,2}\d/.test(U)) return 'Racking';
  return 'Other';
}
function siteOf(loc){
  const U=(loc||'').toUpperCase().trim();
  if(/(^|[^A-Z])TT([^A-Z]|$)|THOMAS/.test(U)) return 'Thomastown';
  if(/(^|[^A-Z])CF([^A-Z]|$)|CAMPBELL/.test(U)) return 'Campbellfield';
  return 'ThomasTown warehouse';
}

// Shape the raw maps into the compact payload the front-end renders.
function processWarehouse(meta, stock, pos, adj, locAgg){
  const round = Math.round;
  const skuList = Object.entries(stock).map(([no,s]) => {
    const m = meta[no] || {};
    const locEntries = Object.entries(s.locUnits||{}).sort((a,b)=>b[1]-a[1]);
    const primary = locEntries.length ? locEntries[0][0] : '—';
    return { no, name: s.name || m.name || no, grp: m.grp || s.grpCode || '—', sup: m.sup || '—',
             cat: m.cat || '—', unit: s.unit || '', onHand: round(s.onHand), items: s.items,
             loc: primary, nLoc: locEntries.length, zone: zoneOf(primary) };
  }).filter(a => a.onHand !== 0);
  skuList.sort((a,b)=> b.onHand - a.onHand);
  const totalUnits = skuList.reduce((s,a)=>s+a.onHand,0);

  const roll = (field) => {
    const m = {};
    for (const a of skuList){ const k=a[field]||'—'; if(!m[k]) m[k]={n:0,units:0}; m[k].n++; m[k].units+=a.onHand; }
    return Object.entries(m).map(([k,v])=>({k,n:v.n,units:v.units})).sort((a,b)=>b.units-a.units);
  };

  // ── Location detail (stock location matters most for this client) ──────────
  const byLocation = Object.entries(locAgg||{}).map(([loc,v])=>({ loc, units:round(v.units), items:v.items, skus:v.skus.size, zone:zoneOf(loc), site:siteOf(loc) }))
                       .sort((a,b)=>b.units-a.units);
  const zoneMap = {};
  byLocation.forEach(l=>{ if(!zoneMap[l.zone]) zoneMap[l.zone]={locs:0,units:0,items:0}; zoneMap[l.zone].locs++; zoneMap[l.zone].units+=l.units; zoneMap[l.zone].items+=l.items; });
  const byZone = Object.entries(zoneMap).map(([k,v])=>({k,...v})).sort((a,b)=>b.units-a.units);
  const siteMap = {};
  byLocation.forEach(l=>{ if(!siteMap[l.site]) siteMap[l.site]={locs:0,units:0,items:0}; siteMap[l.site].locs++; siteMap[l.site].units+=l.units; siteMap[l.site].items+=l.items; });
  const bySite = Object.entries(siteMap).map(([k,v])=>({k,...v})).sort((a,b)=>b.units-a.units);

  // months helpers
  const monthsBack = (n) => { const out=[]; for(let i=n-1;i>=0;i--){ const d=new Date(); d.setMonth(d.getMonth()-i,1); out.push(d.toISOString().slice(0,7)); } return out; };

  // PO monthly receipts (count) + status breakdown — header-level only
  const poByM = {}, poStatus = {};
  pos.forEach(p=>{ const k=(p.recv||p.inDate||p.created||'').slice(0,7); if(k){ poByM[k]=(poByM[k]||0)+1; }
                   const st=p.statusTxt||('status '+p.status); poStatus[st]=(poStatus[st]||0)+1; });
  const poMonths = monthsBack(WH_PO_MONTHS);
  const poMonthly = poMonths.map(m=>({ m, pos: poByM[m]||0 }));
  const recvPos = pos.filter(p=> p.status==='500' || /receiv/i.test(p.statusTxt||'') || p.recv);
  const thisMonth = new Date().toISOString().slice(0,7);

  // Adjustments monthly (up/down) + by user
  const adjByM = {}, adjByUser = {};
  adj.forEach(a=>{ const k=(a.date||'').slice(0,7); if(k){ if(!adjByM[k])adjByM[k]={pos:0,neg:0,net:0}; if(a.qty>=0)adjByM[k].pos++; else adjByM[k].neg++; adjByM[k].net+=a.qty; }
                   const u=a.user||'—'; if(!adjByUser[u])adjByUser[u]={count:0,net:0}; adjByUser[u].count++; adjByUser[u].net+=a.qty; });
  const adjMonthly = monthsBack(WH_INV_MONTHS).map(m=>({ m, pos:(adjByM[m]||{}).pos||0, neg:(adjByM[m]||{}).neg||0, net:round((adjByM[m]||{}).net||0) }));

  // Inventory adjustment rate — % of SKUs that needed a stock correction in the window,
  // and gross adjustment units as % of units on hand (→ stock accuracy estimate).
  const adjArticles = new Set(adj.map(a=>a.art).filter(Boolean)).size;
  const adjGrossUnits = adj.reduce((s,a)=>s+Math.abs(a.qty),0);
  const adjRatePct  = skuList.length ? Math.round(adjArticles/skuList.length*1000)/10 : 0;
  const adjUnitsPct = totalUnits ? Math.round(adjGrossUnits/totalUnits*1000)/10 : 0;
  const accuracyPct = Math.round((100-adjUnitsPct)*10)/10;

  return {
    builtAt: new Date().toISOString(),
    invMonths: WH_INV_MONTHS, poMonths: WH_PO_MONTHS,
    kpi: {
      skus: skuList.length,
      totalUnits,
      totalItems: skuList.reduce((s,a)=>s+a.items,0),
      groups: new Set(skuList.map(a=>a.grp)).size,
      suppliers: new Set(skuList.map(a=>a.sup).filter(x=>x&&x!=='—')).size,
      locations: byLocation.length,
      pos: pos.length,
      poReceived: recvPos.length,
      poThisMonth: pos.filter(p=>(p.recv||p.inDate||'').slice(0,7)===thisMonth).length,
      adjustments: adj.length,
      adjUp: adj.filter(a=>a.qty>=0).length,
      adjDown: adj.filter(a=>a.qty<0).length,
      adjNetUnits: round(adj.reduce((s,a)=>s+a.qty,0)),
      adjUsers: Object.keys(adjByUser).length,
      adjArticles, adjRatePct, adjUnitsPct, accuracyPct
    },
    byGroup: roll('grp').slice(0,40),
    byCat: roll('cat'),
    byLocation: byLocation.slice(0, 80),
    byZone, bySite,
    poMonthly,
    poStatus: Object.entries(poStatus).map(([k,v])=>({k,v})).sort((a,b)=>b.v-a.v),
    adjMonthly,
    adjByUser: Object.entries(adjByUser).map(([k,v])=>({k,count:v.count,net:round(v.net)})).sort((a,b)=>b.count-a.count).slice(0,20),
    articles: skuList.slice(0, 4000),
    pos: pos.sort((a,b)=>(b.recv||b.inDate||'').localeCompare(a.recv||a.inDate||'')).slice(0, 600),
    adjustments: adj.slice(0, 800)
  };
}

// Run fn at the next occurrence of each UTC hour in `hoursUTC`, then re-schedule itself (twice-daily refresh)
function scheduleDaily(hoursUTC, fn){
  const now = new Date();
  let waitMs = Infinity;
  for (const h of hoursUTC){
    const t = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h, 0, 0, 0));
    if (t <= now) t.setUTCDate(t.getUTCDate() + 1);
    waitMs = Math.min(waitMs, t.getTime() - now.getTime());
  }
  setTimeout(() => { try { fn(); } catch (e) { console.error('[schedule]', e.message); } scheduleDaily(hoursUTC, fn); }, waitMs);
}

function scheduleWarehouse(cfg){
  loadWarehouseFile();
  buildWarehouse(cfg);                                              // build on startup only if the cache is stale (skip handled inside)
  scheduleDaily(REFRESH_HOURS_UTC, () => buildWarehouse(cfg, true));  // forced rebuild twice a day (06:00 & 18:00 UTC)
}


const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>SPARK NEL — Ongoing Dashboard</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"><\/script>
<script src="https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js"><\/script>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#eef2f7;--surface:#ffffff;--surface2:#eef3f8;--border:#d8e0ea;
  --accent:#2563a8;--accent2:#7c5cfc;--success:#1f8a4c;--danger:#cc2a2a;
  --warning:#c2640f;--text:#1f2734;--muted:#647387;--radius:10px;
}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:var(--bg);color:var(--text);min-height:100vh;padding:28px 16px 60px}
.container{max-width:1300px;margin:0 auto}
.header{display:flex;align-items:center;justify-content:space-between;margin-bottom:26px;flex-wrap:wrap;gap:12px}
.header h1{font-size:1.6rem;font-weight:700;background:linear-gradient(135deg,#f59e0b,#ef4444);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.header p{color:var(--muted);font-size:.8rem;margin-top:3px}
.hdr-right{display:flex;align-items:center;gap:10px}
.dot{width:8px;height:8px;border-radius:50%;background:var(--success);flex-shrink:0}
.dot.spin-state{background:var(--warning)}
.dot.err{background:var(--danger)}
.btn{background:var(--surface2);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:.82rem;font-weight:600;padding:8px 16px;cursor:pointer;font-family:inherit;transition:background .15s;white-space:nowrap}
.btn:hover{background:#e7edf5}
.btn-accent{background:linear-gradient(135deg,#f59e0b,#ef4444);border:none;color:#fff}
.btn-accent:hover{opacity:.88}
.tabs{display:flex;gap:2px;margin-bottom:24px;border-bottom:1px solid var(--border)}
.tab{padding:9px 18px;cursor:pointer;font-size:.84rem;font-weight:600;color:var(--muted);border-bottom:2px solid transparent;margin-bottom:-1px;transition:all .15s;white-space:nowrap}
.tab.active{color:var(--warning);border-bottom-color:var(--warning)}
.tab:hover:not(.active){color:var(--text)}
.kpi-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:14px;margin-bottom:22px}
.kpi{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:18px 20px}
.kpi-label{font-size:.66rem;color:var(--muted);font-weight:700;text-transform:uppercase;letter-spacing:.07em;margin-bottom:10px}
.kpi-val{font-size:2.1rem;font-weight:700;line-height:1}
.kpi-sub{font-size:.72rem;color:var(--muted);margin-top:6px}
.kpi.c-total .kpi-val{color:var(--accent)}
.kpi.c-gone .kpi-val{color:var(--success)}
.kpi.c-pending .kpi-val{color:var(--warning)}
.kpi.c-week .kpi-val{color:var(--accent2)}
.charts-row{display:grid;grid-template-columns:1.4fr 1fr;gap:16px;margin-bottom:20px}
@media(max-width:860px){.charts-row{grid-template-columns:1fr}}
.chart-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:20px}
.chart-hdr{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;gap:8px}
.chart-title{font-size:.84rem;font-weight:600}
.chart-wrap{position:relative;height:200px}
.period-toggle{display:flex;background:var(--bg);border:1px solid var(--border);border-radius:7px;padding:2px;gap:2px}
.ptbtn{padding:3px 11px;border-radius:5px;font-size:.72rem;font-weight:700;cursor:pointer;border:none;background:none;color:var(--muted);font-family:inherit;transition:all .15s}
.ptbtn.active{background:var(--surface2);color:var(--text)}
.section{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:20px;margin-bottom:16px}
.sec-hdr{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;flex-wrap:wrap;gap:8px}
.sec-title{font-size:.88rem;font-weight:600}
.badge{display:inline-flex;align-items:center;font-size:.62rem;font-weight:700;padding:2px 9px;border-radius:99px;text-transform:uppercase;letter-spacing:.05em;white-space:nowrap}
.b-green{background:rgba(54,211,153,.1);color:var(--success);border:1px solid rgba(54,211,153,.2)}
.b-warn{background:rgba(245,158,11,.1);color:var(--warning);border:1px solid rgba(245,158,11,.2)}
.b-blue{background:rgba(79,142,247,.1);color:var(--accent);border:1px solid rgba(79,142,247,.2)}
.b-muted{background:var(--surface2);color:var(--muted);border:1px solid var(--border)}
.tbl-scroll{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:.81rem}
th{text-align:left;font-size:.65rem;color:var(--muted);font-weight:700;text-transform:uppercase;letter-spacing:.05em;padding:6px 10px;border-bottom:1px solid var(--border);white-space:nowrap}
td{padding:7px 10px;border-bottom:1px solid var(--border);vertical-align:middle}
tr:last-child td{border-bottom:none}
tbody tr:nth-child(even) td{background:#f8fafc}
tr:hover td{background:#eef4ff}
code{background:var(--surface2);border:1px solid var(--border);border-radius:4px;padding:1px 6px;font-size:.78em;font-family:ui-monospace,monospace}
.contract-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px;margin-bottom:16px}
@media(max-width:700px){.contract-grid{grid-template-columns:1fr 1fr}}
.fg label{display:block;font-size:.65rem;color:var(--muted);font-weight:700;text-transform:uppercase;letter-spacing:.06em;margin-bottom:5px}
input[type=text],input[type=date],textarea,select{background:var(--bg);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:.84rem;padding:7px 10px;outline:none;font-family:inherit;width:100%;transition:border-color .15s}
input:focus,textarea:focus,select:focus{border-color:var(--warning)}
textarea{resize:vertical;min-height:70px}
.rt td input{padding:4px 7px;font-size:.79rem}
.del-btn{background:none;border:none;color:var(--danger);cursor:pointer;font-size:.95rem;padding:0 6px;opacity:.6;transition:opacity .15s}
.del-btn:hover{opacity:1}
.add-row-btn{background:none;border:1px dashed var(--border);border-radius:6px;color:var(--muted);font-size:.78rem;padding:5px 14px;cursor:pointer;margin-top:8px;font-family:inherit;transition:all .15s}
.add-row-btn:hover{border-color:var(--warning);color:var(--warning)}
.placeholder{border:2px dashed var(--border);border-radius:var(--radius);padding:44px;text-align:center;color:var(--muted)}
.placeholder h3{font-size:.98rem;margin-bottom:8px;color:var(--text)}
.placeholder p{font-size:.82rem;line-height:1.6}
.ph-cols{display:flex;gap:8px;justify-content:center;flex-wrap:wrap;margin-top:20px}
.ph-col{background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:7px 14px;font-size:.73rem;color:var(--muted)}
.inv-ghost{opacity:.35;pointer-events:none;margin-top:14px}
.alert{padding:10px 14px;border-radius:8px;font-size:.81rem;margin-bottom:14px}
.a-error{background:rgba(204,42,42,.07);border:1px solid rgba(204,42,42,.25);color:#b91c1c}
.a-ok{background:rgba(54,211,153,.07);border:1px solid rgba(54,211,153,.25);color:var(--success)}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
.spinning{animation:spin .7s linear infinite}
.pulsing{animation:pulse 1.2s ease-in-out infinite}
::-webkit-scrollbar{width:5px;height:5px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px}
.ask-wrap{max-width:940px}
.ask-intro{background:#eaf1fb;border-left:4px solid var(--accent);border-radius:6px;padding:11px 14px;font-size:.8rem;color:#33425a;margin-bottom:14px;line-height:1.5}
.ask-log{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:14px;min-height:300px;max-height:480px;overflow-y:auto;margin-bottom:12px}
.ask-msg{display:flex;margin:8px 0}
.ask-msg.you{justify-content:flex-end}
.ask-bubble{max-width:84%;padding:10px 13px;border-radius:12px;font-size:.82rem;line-height:1.55}
.ask-msg.you .ask-bubble{background:var(--accent);color:#fff;border-bottom-right-radius:3px}
.ask-msg.bot .ask-bubble{background:var(--surface2);color:var(--text);border-bottom-left-radius:3px}
.ask-bubble table{border-collapse:collapse;margin-top:8px;font-size:.75rem;width:100%}
.ask-bubble th,.ask-bubble td{border:1px solid var(--border);padding:3px 7px;text-align:left;white-space:nowrap}
.ask-bubble th{background:var(--surface2)}
.ask-bubble td.num,.ask-bubble th.num{text-align:right}
.ask-row{display:flex;gap:10px;align-items:center;margin-bottom:10px}
.ask-input{flex:1;padding:10px 13px;border:1px solid var(--border);border-radius:8px;font-size:.9rem;font-family:inherit}
.ask-send{padding:10px 22px;border:none;border-radius:8px;background:var(--accent);color:#fff;font-weight:700;font-size:.85rem;cursor:pointer}
.ask-send:hover{background:#1d4f88}
.ask-chips{display:flex;gap:8px;flex-wrap:wrap}
.ask-chip{background:var(--surface2);border:1px solid var(--border);color:#33425a;border-radius:14px;padding:5px 11px;font-size:.75rem;cursor:pointer}
.ask-chip:hover{background:#e2e9f3}
input[type=number]{background:var(--bg);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:.84rem;padding:7px 10px;outline:none;font-family:inherit;width:100%;transition:border-color .15s}
input[type=number]:focus{border-color:var(--warning)}
.modal-ov{position:fixed;inset:0;background:rgba(17,24,39,.55);display:none;align-items:flex-start;justify-content:center;z-index:200;padding:34px 16px;overflow-y:auto}
.modal-ov.show{display:flex}
.modal{background:var(--surface);border:1px solid var(--border);border-radius:12px;width:100%;max-width:640px;box-shadow:0 18px 50px rgba(0,0,0,.28)}
.modal-hd{display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid var(--border)}
.modal-hd h3{font-size:1rem;font-weight:700}
.modal-x{background:none;border:none;font-size:1.4rem;color:var(--muted);cursor:pointer;line-height:1}
.modal-bd{padding:18px 20px}
.modal-ft{display:flex;justify-content:flex-end;gap:10px;padding:14px 20px;border-top:1px solid var(--border)}
.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:13px}
.form-grid .fg-full{grid-column:1 / -1}
.rate-hint{font-size:.7rem;color:var(--success);margin-top:5px;min-height:1em}
.wms-hint{font-size:.7rem;color:var(--accent);margin-top:5px;min-height:1em}
</style>
</head>
<body>
<div class="container">

<div class="header">
  <div>
    <h1>SPARK NEL — Ongoing Dashboard</h1>
    <p id="sync-lbl">Loading data…</p>
  </div>
  <div class="hdr-right">
    <div id="dot" class="dot spin-state pulsing"></div>
    <button class="btn btn-accent" onclick="refresh()">↻ Refresh</button>
  </div>
</div>

<div class="tabs">
  <div class="tab active"  onclick="showTab('overview',this)">Overview</div>
  <div class="tab"         onclick="showTab('ask',this)">Ask</div>
  <div class="tab"         onclick="showTab('orders',this)">Orders</div>
  <div class="tab"         onclick="showTab('po',this)">Purchase Orders</div>
  <div class="tab"         onclick="showTab('stock',this)">Stock &amp; Articles</div>
  <div class="tab"         onclick="showTab('adjust',this)">Inventory Adjustments</div>
  <div class="tab"         onclick="showTab('warehouse',this)">Warehouse Analytics</div>
  <div class="tab"         onclick="showTab('contract',this)">Freight Contract</div>
  <div class="tab"         onclick="showTab('summaries',this)">Summaries</div>
  <div class="tab"         onclick="showTab('transport',this)">Transport</div>
  <div class="tab"         onclick="showTab('invoicing',this)">Invoicing</div>
  <div class="tab"         onclick="showTab('planner',this)">Planner</div>
</div>

<div id="alert-box"></div>

<!-- ═══ NEW BOOKING MODAL ══════════════════════════════════════════════════ -->
<div id="booking-ov" class="modal-ov" onclick="if(event.target===this)closeBooking()">
  <div class="modal">
    <div class="modal-hd">
      <h3 id="bf-title">New transport booking</h3>
      <button class="modal-x" onclick="closeBooking()" title="Close">&times;</button>
    </div>
    <div class="modal-bd">
      <div class="form-grid">
        <div class="fg"><label>Date *</label><input type="date" id="bf-date"></div>
        <div class="fg"><label>Status</label><select id="bf-status"></select></div>
        <div class="fg fg-full">
          <label>WMS Order ID</label>
          <input type="text" id="bf-order" list="bf-order-list" placeholder="Type or pick a WMS order…" oninput="onOrderInput()">
          <datalist id="bf-order-list"></datalist>
          <div class="wms-hint" id="bf-wms-hint"></div>
        </div>
        <div class="fg"><label>Client</label><select id="bf-client"></select></div>
        <div class="fg"><label>Site</label><select id="bf-site"></select></div>
        <div class="fg"><label>Vehicle type</label><select id="bf-type" onchange="onRateInputs()"></select></div>
        <div class="fg"><label>Supplier</label><select id="bf-supplier" onchange="onRateInputs()"></select></div>
        <div class="fg fg-full" style="border-top:1px solid var(--border);padding-top:12px;margin-top:2px"><div style="font-size:.66rem;color:var(--muted);font-weight:700;text-transform:uppercase;letter-spacing:.06em">Expected (quoted) — from rate card</div></div>
        <div class="fg"><label>EX Buy $ (ex GST)</label><input type="number" step="0.01" id="bf-exbuy"></div>
        <div class="fg"><label>EX Sell $ (ex GST)</label><input type="number" step="0.01" id="bf-exsell"></div>
        <div class="fg fg-full"><label style="font-size:.72rem;text-transform:none;font-weight:600;color:var(--text);display:flex;align-items:center;gap:7px"><input type="checkbox" id="bf-userate" checked style="width:auto"> Auto-fill EX from rate card (supplier + vehicle)</label><div class="rate-hint" id="bf-rate-hint"></div></div>
        <div class="fg fg-full" style="border-top:1px solid var(--border);padding-top:12px;margin-top:2px"><div style="font-size:.66rem;color:var(--muted);font-weight:700;text-transform:uppercase;letter-spacing:.06em">Actual — fill in when the supplier invoice arrives</div></div>
        <div class="fg"><label>ACC Buy $ (ex GST)</label><input type="number" step="0.01" id="bf-buy"></div>
        <div class="fg"><label>ACC Sell $ (ex GST)</label><input type="number" step="0.01" id="bf-sell"></div>
        <div class="fg"><label>Invoice #</label><input type="text" id="bf-invoice" placeholder="Optional"></div>
        <div class="fg" id="bf-qtyrow"><label>Qty — identical trips</label><input type="number" id="bf-qty" min="1" step="1" value="1"></div>
        <div class="fg fg-full"><label>Comments</label><textarea id="bf-comments" placeholder="Notes, reference, cargo…"></textarea></div>
      </div>
    </div>
    <div class="modal-ft">
      <button class="btn" onclick="closeBooking()">Cancel</button>
      <button class="btn" id="bf-addanother" onclick="submitBooking(true)">Save &amp; add another</button>
      <button class="btn btn-accent" onclick="submitBooking(false)">Save &amp; close</button>
    </div>
  </div>
</div>

<!-- ═══ OVERVIEW ═══════════════════════════════════════════════════════════ -->
<div id="tab-overview">
  <div class="kpi-row">
    <div class="kpi c-total"><div class="kpi-label">Total Orders</div><div class="kpi-val" id="k-total">—</div><div class="kpi-sub">Last 24 months</div></div>
    <div class="kpi c-gone"><div class="kpi-label">Dispatched</div><div class="kpi-val" id="k-gone">—</div><div class="kpi-sub">Shipped &amp; confirmed</div></div>
    <div class="kpi c-pending"><div class="kpi-label">Pending</div><div class="kpi-val" id="k-pending">—</div><div class="kpi-sub">Yet to dispatch</div></div>
    <div class="kpi c-week"><div class="kpi-label">This Week</div><div class="kpi-val" id="k-week">—</div><div class="kpi-sub">Dispatched Mon–today</div></div>
  </div>

  <div class="charts-row">
    <div class="chart-card">
      <div class="chart-hdr">
        <span class="chart-title">Dispatch &amp; Creation Trend</span>
        <div class="period-toggle">
          <button class="ptbtn active" id="pt-wk" onclick="setPeriod('weekly')">Weekly</button>
          <button class="ptbtn"        id="pt-mo" onclick="setPeriod('monthly')">Monthly</button>
        </div>
      </div>
      <div class="chart-wrap"><canvas id="chart-trend"></canvas></div>
    </div>
    <div class="chart-card">
      <div class="chart-hdr"><span class="chart-title">Monthly Dispatch Volume</span></div>
      <div class="chart-wrap"><canvas id="chart-mo"></canvas></div>
    </div>
  </div>

  <div class="section">
    <div class="sec-hdr"><span class="sec-title">Monthly Breakdown</span></div>
    <div class="tbl-scroll">
      <table>
        <thead><tr><th>Month</th><th>Orders Created</th><th>Dispatched</th></tr></thead>
        <tbody id="mo-tbody"></tbody>
      </table>
    </div>
  </div>
</div>

<!-- ═══ ORDERS ═════════════════════════════════════════════════════════════ -->
<div id="tab-orders" style="display:none">
  <div style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap;align-items:center">
    <input type="text" id="ord-search" placeholder="Search order ref, WMS ID, status…" oninput="renderOrderTables()" style="max-width:320px;font-size:.82rem">
    <div class="period-toggle">
      <button class="ptbtn active" id="ord-all"  onclick="setOrdView('all')">All</button>
      <button class="ptbtn"        id="ord-gone" onclick="setOrdView('gone')">Dispatched</button>
      <button class="ptbtn"        id="ord-pend" onclick="setOrdView('pending')">Pending</button>
    </div>
    <span class="badge b-muted" id="bdg-ord-count">—</span>
  </div>
  <div id="ord-section-gone" class="section">
    <div class="sec-hdr">
      <span class="sec-title">Dispatched Orders</span>
      <span class="badge b-green" id="bdg-gone">—</span>
    </div>
    <div class="tbl-scroll">
      <table>
        <thead><tr><th>Order Ref</th><th>WMS ID</th><th>Created</th><th>Shipped</th><th>Lines</th><th>Status</th></tr></thead>
        <tbody id="gone-tbody"></tbody>
      </table>
    </div>
  </div>
  <div id="ord-section-pend" class="section">
    <div class="sec-hdr">
      <span class="sec-title">Pending Orders</span>
      <span class="badge b-warn" id="bdg-pending">—</span>
    </div>
    <div class="tbl-scroll">
      <table>
        <thead><tr><th>Order Ref</th><th>WMS ID</th><th>Created</th><th>Lines</th><th>Status</th><th>Remark</th></tr></thead>
        <tbody id="pend-tbody"></tbody>
      </table>
    </div>
  </div>
</div>

<!-- ═══ FREIGHT CONTRACT ════════════════════════════════════════════════════ -->
<div id="tab-contract" style="display:none">
  <div class="section">
    <div class="sec-hdr">
      <span class="sec-title">Freight Contract — SPARK NEL</span>
      <button class="btn btn-accent" onclick="saveContract()">Save</button>
    </div>
    <div class="contract-grid">
      <div class="fg"><label>Carrier</label><input type="text" id="c-carrier" placeholder="e.g. Toll, Linfox, Pacific National"></div>
      <div class="fg"><label>Service Level</label><input type="text" id="c-service" placeholder="e.g. Road Express, Air, Sea FCL"></div>
      <div class="fg"><label>Contract Number</label><input type="text" id="c-cno" placeholder="e.g. BWS-SPARK-2025-001"></div>
      <div class="fg"><label>Effective Date</label><input type="date" id="c-eff"></div>
      <div class="fg"><label>Expiry Date</label><input type="date" id="c-exp"></div>
      <div class="fg"><label>Account Code</label><input type="text" id="c-acct" placeholder="Carrier account code"></div>
    </div>
    <div class="fg" style="margin-bottom:16px"><label>Notes / Special Conditions</label><textarea id="c-notes" placeholder="Surcharges, restrictions, special terms…"></textarea></div>
    <div>
      <div class="fg" style="margin-bottom:8px"><label>Rate Schedule</label></div>
      <div class="tbl-scroll">
        <table class="rt">
          <thead><tr><th>Zone / Lane</th><th>Service</th><th>Rate (ex. GST)</th><th>Unit</th><th>Notes</th><th></th></tr></thead>
          <tbody id="rates-tbody"></tbody>
        </table>
      </div>
      <button class="add-row-btn" onclick="addRateRow()">+ Add Rate Row</button>
    </div>
    <div id="c-status" style="margin-top:14px"></div>
  </div>

  <!-- Rate card: supplier + vehicle → expected buy/sell (feeds the booking form & back-fills EX) -->
  <div class="section">
    <div class="sec-hdr">
      <span class="sec-title">Rate Card — expected buy / sell by supplier + vehicle</span>
      <div style="display:flex;gap:8px">
        <button class="btn" onclick="applyRateCard()">Apply to register (fill blank EX)</button>
        <button class="btn btn-accent" onclick="saveContract()">Save</button>
      </div>
    </div>
    <p style="font-size:.78rem;color:var(--muted);margin-bottom:12px">These rates auto-fill <b>EX Buy/Sell</b> on new bookings. <b>Apply to register</b> writes them onto existing register rows that have no EX value yet — i.e. puts the contract values onto the old transport registers.</p>
    <div class="tbl-scroll">
      <table class="rt">
        <thead><tr><th>Supplier</th><th>Vehicle type</th><th>EX Buy $</th><th>EX Sell $</th><th></th></tr></thead>
        <tbody id="ratecard-tbody"></tbody>
      </table>
    </div>
    <button class="add-row-btn" onclick="addRateCardRow()">+ Add rate</button>
    <datalist id="rc-sup-list"></datalist>
    <datalist id="rc-type-list"></datalist>
    <div id="rc-status" style="margin-top:10px"></div>
  </div>

  <!-- Contract usage: contracted trip allowance vs used (old + current register) -->
  <div class="section">
    <div class="sec-hdr">
      <span class="sec-title">Contract Usage — trip allowance vs used (old + current register)</span>
      <button class="btn btn-accent" onclick="saveContract()">Save allowance</button>
    </div>
    <div class="tbl-scroll">
      <table>
        <thead><tr><th>Vehicle type</th><th>Contracted</th><th>Used</th><th>Remaining</th><th>% used</th></tr></thead>
        <tbody id="usage-tbody"></tbody>
      </table>
    </div>
  </div>
</div>

<!-- ═══ PLANNER ══════════════════════════════════════════════════════════════ -->
<div id="tab-planner" style="display:none">
  <div id="pl-empty" class="placeholder"><h3>Trip Planner</h3><p>Needs live Ongoing orders. Load order data (WMS credentials) and the planner will estimate upcoming trips from the pending backlog.</p></div>
  <div id="pl-data" style="display:none">
    <div class="kpi-row">
      <div class="kpi"><div class="kpi-label">Pending backlog</div><div class="kpi-val" id="pl-backlog" style="color:var(--warning)">—</div><div class="kpi-sub">Orders yet to dispatch</div></div>
      <div class="kpi"><div class="kpi-label">Est. trips to clear</div><div class="kpi-val" id="pl-trips" style="color:var(--accent)">—</div><div class="kpi-sub">backlog × trips/order</div></div>
      <div class="kpi"><div class="kpi-label">Est. trips / day</div><div class="kpi-val" id="pl-perday" style="color:var(--accent2)">—</div><div class="kpi-sub">at current capacity</div></div>
      <div class="kpi"><div class="kpi-label">Est. days to clear</div><div class="kpi-val" id="pl-days" style="color:var(--success)">—</div><div class="kpi-sub">business days</div></div>
    </div>
    <div class="section">
      <div class="sec-hdr"><span class="sec-title">Assumptions</span><span class="badge b-muted" id="pl-basis">—</span></div>
      <div class="contract-grid">
        <div class="fg"><label>Dispatch capacity (orders / business day)</label><input type="number" min="1" step="1" id="pl-cap" oninput="renderPlanner()"></div>
        <div class="fg"><label>Trips per order</label><input type="number" min="0" step="0.05" id="pl-tpo" oninput="renderPlanner()"></div>
        <div class="fg"><label>Planning horizon (business days)</label><input type="number" min="1" max="60" step="1" id="pl-horizon" value="15" oninput="renderPlanner()"></div>
      </div>
      <p style="font-size:.75rem;color:var(--muted)">Defaults derive from recent Ongoing dispatch history and the transport register. Adjust to model different scenarios.</p>
    </div>
    <div style="display:grid;grid-template-columns:1.6fr 1fr;gap:16px">
      <div class="section" style="margin-bottom:0">
        <div class="sec-hdr"><span class="sec-title">Estimated trips by day (draining the backlog)</span></div>
        <div class="tbl-scroll">
          <table>
            <thead><tr><th>Date</th><th>Day</th><th>Est. orders</th><th>Est. trips</th><th>Backlog left</th></tr></thead>
            <tbody id="pl-tbody"></tbody>
          </table>
        </div>
      </div>
      <div class="section" style="margin-bottom:0">
        <div class="sec-hdr"><span class="sec-title">Historical trips by weekday</span></div>
        <div class="tbl-scroll">
          <table>
            <thead><tr><th>Weekday</th><th>Trips</th><th>Share</th></tr></thead>
            <tbody id="pl-dow-tbody"></tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
</div>

<!-- ═══ TRANSPORT ════════════════════════════════════════════════════════════ -->
<div id="tab-transport" style="display:none">
  <div id="tp-empty" class="placeholder">
    <h3>Transport Register</h3>
    <p>Add bookings directly below, or upload <strong>Transport Register- NEL.xlsx</strong> to import the existing register and link bookings to WMS orders.</p>
    <div style="display:flex;gap:10px;justify-content:center;margin-top:16px;flex-wrap:wrap">
      <button class="btn btn-accent" onclick="openBooking()">+ New booking</button>
      <label class="btn" style="display:inline-block;cursor:pointer">
        Upload xlsx<input type="file" accept=".xlsx" style="display:none" onchange="handleTransportUpload(event)">
      </label>
    </div>
  </div>
  <div id="tp-data" style="display:none">
    <div class="kpi-row">
      <div class="kpi"><div class="kpi-label">Total Trips</div><div class="kpi-val" id="tk-trips" style="color:var(--accent)">—</div><div class="kpi-sub">Transport bookings</div></div>
      <div class="kpi"><div class="kpi-label">Total Cost</div><div class="kpi-val" id="tk-cost" style="color:var(--danger)">—</div><div class="kpi-sub">ACC Buy (ex GST)</div></div>
      <div class="kpi"><div class="kpi-label">Total Revenue</div><div class="kpi-val" id="tk-sell" style="color:var(--success)">—</div><div class="kpi-sub">ACC Sell (ex GST)</div></div>
      <div class="kpi"><div class="kpi-label">Profit</div><div class="kpi-val" id="tk-profit" style="color:var(--accent2)">—</div><div class="kpi-sub">Revenue minus cost</div></div>
    </div>
    <!-- Site split -->
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:22px">
      <div class="section" style="margin-bottom:0">
        <div class="sec-hdr" style="margin-bottom:10px"><span class="sec-title" style="color:#f59e0b">📍 Thomastown</span></div>
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px">
          <div><div style="font-size:.63rem;color:var(--muted);text-transform:uppercase;font-weight:700;letter-spacing:.06em;margin-bottom:4px">Trips</div><div style="font-size:1.4rem;font-weight:700;color:var(--accent)" id="tk-tt-trips">—</div></div>
          <div><div style="font-size:.63rem;color:var(--muted);text-transform:uppercase;font-weight:700;letter-spacing:.06em;margin-bottom:4px">Cost</div><div style="font-size:1.1rem;font-weight:700;color:var(--danger)" id="tk-tt-cost">—</div></div>
          <div><div style="font-size:.63rem;color:var(--muted);text-transform:uppercase;font-weight:700;letter-spacing:.06em;margin-bottom:4px">Revenue</div><div style="font-size:1.1rem;font-weight:700;color:var(--success)" id="tk-tt-rev">—</div></div>
          <div><div style="font-size:.63rem;color:var(--muted);text-transform:uppercase;font-weight:700;letter-spacing:.06em;margin-bottom:4px">Profit</div><div style="font-size:1.1rem;font-weight:700;color:var(--accent2)" id="tk-tt-profit">—</div></div>
        </div>
      </div>
      <div class="section" style="margin-bottom:0">
        <div class="sec-hdr" style="margin-bottom:10px"><span class="sec-title" style="color:#a78bfa">📍 Campbellfield</span></div>
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px">
          <div><div style="font-size:.63rem;color:var(--muted);text-transform:uppercase;font-weight:700;letter-spacing:.06em;margin-bottom:4px">Trips</div><div style="font-size:1.4rem;font-weight:700;color:var(--accent)" id="tk-cf-trips">—</div></div>
          <div><div style="font-size:.63rem;color:var(--muted);text-transform:uppercase;font-weight:700;letter-spacing:.06em;margin-bottom:4px">Cost</div><div style="font-size:1.1rem;font-weight:700;color:var(--danger)" id="tk-cf-cost">—</div></div>
          <div><div style="font-size:.63rem;color:var(--muted);text-transform:uppercase;font-weight:700;letter-spacing:.06em;margin-bottom:4px">Revenue</div><div style="font-size:1.1rem;font-weight:700;color:var(--success)" id="tk-cf-rev">—</div></div>
          <div><div style="font-size:.63rem;color:var(--muted);text-transform:uppercase;font-weight:700;letter-spacing:.06em;margin-bottom:4px">Profit</div><div style="font-size:1.1rem;font-weight:700;color:var(--accent2)" id="tk-cf-profit">—</div></div>
        </div>
      </div>
    </div>
    <div class="section">
      <div class="sec-hdr">
        <span class="sec-title">Transport Bookings</span>
        <div style="display:flex;gap:8px;align-items:center">
          <span class="badge b-blue" id="bdg-transport">—</span>
          <button class="btn btn-accent" style="font-size:.76rem;padding:5px 12px" onclick="openBooking()">+ New booking</button>
          <label class="btn" style="cursor:pointer;font-size:.76rem;padding:5px 12px">Re-upload<input type="file" accept=".xlsx" style="display:none" onchange="handleTransportUpload(event)"></label>
        </div>
      </div>
      <div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;align-items:center">
        <input type="text" id="tf-search" placeholder="Search date, order, client, type, invoice, comments…" oninput="renderTransport()" style="max-width:340px;font-size:.78rem">
        <select id="tf-site" onchange="renderTransport()" style="width:auto;font-size:.78rem;padding:5px 10px">
          <option value="">All sites</option>
          <option value="Thomastown">Thomastown</option>
          <option value="Campbellfield">Campbellfield</option>
          <option value="Other">Other</option>
        </select>
        <select id="tf-supplier" onchange="renderTransport()" style="width:auto;font-size:.78rem;padding:5px 10px"></select>
        <select id="tf-linked" onchange="renderTransport()" style="width:auto;font-size:.78rem;padding:5px 10px">
          <option value="">All bookings</option>
          <option value="linked">Linked to WMS order</option>
          <option value="unlinked">No WMS link</option>
        </select>
      </div>
      <div class="tbl-scroll">
        <table>
          <thead><tr><th>Date</th><th>Site</th><th>WMS Order</th><th>Client</th><th>Vehicle Type</th><th>Supplier</th><th>Invoice</th><th>EX Buy</th><th>EX Sell</th><th>ACC Buy</th><th>ACC Sell</th><th>Profit $</th><th>Comments</th><th></th></tr></thead>
          <tbody id="transport-tbody"></tbody>
        </table>
      </div>
    </div>
  </div>
</div>

<!-- ═══ INVOICING ════════════════════════════════════════════════════════════ -->
<div id="tab-invoicing" style="display:none">
  <div id="inv-empty" class="placeholder">
    <h3>Invoicing</h3>
    <p>Upload <strong>Transport Register- NEL.xlsx</strong> on the Transport tab to populate invoice data here.</p>
    <label class="btn btn-accent" style="display:inline-block;margin-top:16px;cursor:pointer">
      Upload xlsx<input type="file" accept=".xlsx" style="display:none" onchange="handleTransportUpload(event)">
    </label>
  </div>
  <div id="inv-data" style="display:none">
    <div class="kpi-row">
      <div class="kpi"><div class="kpi-label">Invoiced Jobs</div><div class="kpi-val" id="ik-invoiced" style="color:var(--success)">—</div><div class="kpi-sub">With invoice number</div></div>
      <div class="kpi"><div class="kpi-label">Uninvoiced</div><div class="kpi-val" id="ik-uninvoiced" style="color:var(--warning)">—</div><div class="kpi-sub">No invoice yet</div></div>
      <div class="kpi"><div class="kpi-label">Total Invoiced $</div><div class="kpi-val" id="ik-total" style="color:var(--accent)">—</div><div class="kpi-sub">ACC Sell on invoiced jobs</div></div>
      <div class="kpi"><div class="kpi-label">Avg Margin</div><div class="kpi-val" id="ik-margin" style="color:var(--accent2)">—</div><div class="kpi-sub">Revenue vs cost</div></div>
    </div>
    <div style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap;align-items:center">
      <input type="text" id="inv-search" placeholder="Search invoice #, date, WMS order, client, supplier…" oninput="renderInvoicing()" style="max-width:360px;font-size:.82rem">
      <select id="inv-site" onchange="renderInvoicing()" style="width:auto;font-size:.78rem;padding:5px 10px">
        <option value="">All sites</option>
        <option value="Thomastown">Thomastown</option>
        <option value="Campbellfield">Campbellfield</option>
        <option value="Other">Other</option>
      </select>
      <select id="inv-supplier" onchange="renderInvoicing()" style="width:auto;font-size:.78rem;padding:5px 10px"><option value="">All suppliers</option></select>
    </div>
    <div class="section">
      <div class="sec-hdr"><span class="sec-title">Invoice Register</span><span class="badge b-blue" id="bdg-invoices">—</span></div>
      <div class="tbl-scroll">
        <table>
          <thead><tr><th>Invoice #</th><th>Date</th><th>Site</th><th>WMS Order</th><th>Client</th><th>Supplier</th><th>ACC Buy</th><th>ACC Sell</th><th>Profit $</th><th>Margin</th><th>Comments</th></tr></thead>
          <tbody id="inv-tbody"></tbody>
        </table>
      </div>
    </div>
    <div class="section">
      <div class="sec-hdr"><span class="sec-title">Uninvoiced Jobs</span><span class="badge b-warn" id="bdg-uninv">—</span></div>
      <div class="tbl-scroll">
        <table>
          <thead><tr><th>Date</th><th>Site</th><th>WMS Order</th><th>Client</th><th>Supplier</th><th>ACC Buy</th><th>ACC Sell</th><th>Comments</th></tr></thead>
          <tbody id="uninv-tbody"></tbody>
        </table>
      </div>
    </div>
  </div>
</div>

<!-- ═══ SUMMARIES ═════════════════════════════════════════════════════════════ -->
<div id="tab-summaries" style="display:none">
  <div id="sum-empty" class="placeholder">
    <h3>Summaries</h3>
    <p>Upload <strong>Transport Register- NEL.xlsx</strong> on the Transport tab to generate summaries.</p>
  </div>
  <div id="sum-data" style="display:none">

    <!-- Filters -->
    <div style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap;align-items:center">
      <select id="sum-supplier" onchange="renderSummaries()" style="width:auto;font-size:.78rem;padding:5px 10px"><option value="">All suppliers</option></select>
      <label style="font-size:.78rem;color:var(--muted)">From</label>
      <input type="month" id="sum-from" onchange="renderSummaries()" style="width:auto;font-size:.78rem;padding:5px 10px">
      <label style="font-size:.78rem;color:var(--muted)">To</label>
      <input type="month" id="sum-to" onchange="renderSummaries()" style="width:auto;font-size:.78rem;padding:5px 10px">
      <button class="btn" style="font-size:.75rem;padding:4px 10px" onclick="document.getElementById('sum-supplier').value='';document.getElementById('sum-from').value='';document.getElementById('sum-to').value='';renderSummaries()">Clear</button>
    </div>

    <!-- KPI row -->
    <div class="kpi-row">
      <div class="kpi"><div class="kpi-label">Total Trips</div><div class="kpi-val" id="sk-trips" style="color:var(--accent)">—</div><div class="kpi-sub">All transport bookings</div></div>
      <div class="kpi"><div class="kpi-label">Total Cost</div><div class="kpi-val" id="sk-cost" style="color:var(--danger)">—</div><div class="kpi-sub">ACC Buy (ex GST)</div></div>
      <div class="kpi"><div class="kpi-label">Total Revenue</div><div class="kpi-val" id="sk-rev" style="color:var(--success)">—</div><div class="kpi-sub">ACC Sell (ex GST)</div></div>
      <div class="kpi"><div class="kpi-label">Profit</div><div class="kpi-val" id="sk-profit" style="color:var(--accent2)">—</div><div class="kpi-sub">Revenue minus cost</div></div>
    </div>

    <!-- By Site -->
    <div class="section">
      <div class="sec-hdr"><span class="sec-title">By Site</span></div>
      <div class="tbl-scroll">
        <table>
          <thead><tr><th>Site</th><th>Trips</th><th>Invoiced</th><th>EX Buy (quoted)</th><th>Cost (ACC Buy)</th><th>Revenue (ACC Sell)</th><th>Profit $</th><th>Margin</th></tr></thead>
          <tbody id="sum-site-tbody"></tbody>
        </table>
      </div>
    </div>

    <!-- By Supplier -->
    <div class="section">
      <div class="sec-hdr"><span class="sec-title">By Supplier</span></div>
      <div class="tbl-scroll">
        <table>
          <thead><tr><th>Supplier</th><th>Trips</th><th>Cost (ACC Buy)</th><th>Revenue (ACC Sell)</th><th>Profit $</th><th>Margin</th></tr></thead>
          <tbody id="sum-supplier-tbody"></tbody>
        </table>
      </div>
    </div>

    <!-- By Month -->
    <div class="section">
      <div class="sec-hdr"><span class="sec-title">By Month</span></div>
      <div class="tbl-scroll">
        <table>
          <thead><tr><th>Month</th><th>Trips</th><th>Invoiced</th><th>Cost (ACC Buy)</th><th>Revenue (ACC Sell)</th><th>Profit $</th><th>Margin</th></tr></thead>
          <tbody id="sum-month-tbody"></tbody>
        </table>
      </div>
    </div>

    <!-- By Week -->
    <div class="section">
      <div class="sec-hdr"><span class="sec-title">By Week</span><span style="color:var(--muted);font-size:.8rem;margin-left:8px">(weeks with activity)</span></div>
      <div class="tbl-scroll">
        <table>
          <thead><tr><th>Week (Mon)</th><th>Trips</th><th>Invoiced</th><th>Cost (ACC Buy)</th><th>Revenue (ACC Sell)</th><th>Profit $</th><th>Margin</th><th>Suppliers</th></tr></thead>
          <tbody id="sum-week-tbody"></tbody>
        </table>
      </div>
    </div>

  </div>
</div>

<!-- ═══ PURCHASE ORDERS ═══════════════════════════════════════════════════════ -->
<div id="tab-po" style="display:none">
  <div id="wh-build-po" class="placeholder" style="display:none"><h3>Warehouse snapshot building…</h3><p>Pulling articles, stock, receipts &amp; adjustments from Ongoing WMS. This refreshes in the background twice a day — first build takes a few minutes.</p></div>
  <div id="po-data" style="display:none">
    <div class="kpi-row">
      <div class="kpi"><div class="kpi-label">Purchase Orders</div><div class="kpi-val" id="pok-pos" style="color:var(--accent)">—</div><div class="kpi-sub" id="pok-window">Recent</div></div>
      <div class="kpi"><div class="kpi-label">Received</div><div class="kpi-val" id="pok-recv" style="color:var(--success)">—</div><div class="kpi-sub">Booked in</div></div>
      <div class="kpi"><div class="kpi-label">This Month</div><div class="kpi-val" id="pok-month" style="color:var(--accent2)">—</div><div class="kpi-sub">Receipts this month</div></div>
    </div>
    <div class="charts-row">
      <div class="chart-card"><div class="chart-hdr"><span class="chart-title">Monthly Goods Receipts (POs)</span></div><div class="chart-wrap"><canvas id="po-chart"></canvas></div></div>
      <div class="chart-card"><div class="chart-hdr"><span class="chart-title">Purchase Orders by Status</span></div><div class="chart-wrap"><canvas id="po-status-chart"></canvas></div></div>
    </div>
    <div class="section">
      <div class="sec-hdr"><span class="sec-title">Purchase Orders</span><span class="badge b-blue" id="bdg-po">—</span></div>
      <div style="margin-bottom:12px"><input type="text" id="po-search" placeholder="Search PO no, status…" oninput="renderPOTable()" style="max-width:320px;font-size:.82rem"></div>
      <div class="tbl-scroll"><table>
        <thead><tr><th>PO / Order No</th><th>Created</th><th>In Date</th><th>Received</th><th>Status</th></tr></thead>
        <tbody id="po-tbody"></tbody>
      </table></div>
    </div>
  </div>
</div>

<!-- ═══ STOCK & ARTICLES ══════════════════════════════════════════════════════ -->
<div id="tab-stock" style="display:none">
  <div id="wh-build-stock" class="placeholder" style="display:none"><h3>Warehouse snapshot building…</h3><p>Pulling current stock from Ongoing WMS. Refreshes twice a day.</p></div>
  <div id="stock-data" style="display:none">
    <div class="alert" style="background:rgba(194,100,15,.06);border:1px solid rgba(194,100,15,.2);color:#7a4a12">Stock is held at the <b>ThomasTown facility</b> and tracked to <b>bin / location</b>. Zones below = Racking, Staging &amp; Yard; any site-tagged bays (TT / CF) are called out. Freight movements to the <b>Campbellfield</b> site are tracked in the <b>Transport</b> tab.</div>
    <div class="kpi-row">
      <div class="kpi"><div class="kpi-label">SKUs in Stock</div><div class="kpi-val" id="stk-skus" style="color:var(--accent)">—</div><div class="kpi-sub">Distinct articles on hand</div></div>
      <div class="kpi"><div class="kpi-label">Units on Hand</div><div class="kpi-val" id="stk-units" style="color:var(--success)">—</div><div class="kpi-sub">Total quantity</div></div>
      <div class="kpi"><div class="kpi-label">Storage Locations</div><div class="kpi-val" id="stk-locs" style="color:var(--warning)">—</div><div class="kpi-sub">Distinct bins / locations</div></div>
      <div class="kpi"><div class="kpi-label">Stock Lines</div><div class="kpi-val" id="stk-items" style="color:var(--accent2)">—</div><div class="kpi-sub">Item / location records</div></div>
      <div class="kpi"><div class="kpi-label">Article Groups</div><div class="kpi-val" id="stk-groups" style="color:var(--muted)">—</div><div class="kpi-sub">Distinct groups</div></div>
    </div>
    <div class="charts-row">
      <div class="chart-card"><div class="chart-hdr"><span class="chart-title">Units on Hand by Article Group (top 12)</span></div><div class="chart-wrap"><canvas id="stk-grp-chart"></canvas></div></div>
      <div class="chart-card"><div class="chart-hdr"><span class="chart-title">Stock by Storage Zone</span></div><div class="chart-wrap"><canvas id="stk-zone-chart"></canvas></div></div>
    </div>
    <div class="section">
      <div class="sec-hdr"><span class="sec-title">&#x1F4CD; Top Storage Locations</span><span class="badge b-muted" id="bdg-loc">—</span></div>
      <div style="margin-bottom:10px"><input type="text" id="loc-search" placeholder="Search location / bin / zone&hellip;" oninput="renderLocTable()" style="max-width:300px;font-size:.82rem"></div>
      <div class="tbl-scroll" style="max-height:340px"><table>
        <thead><tr><th>Location / Bin</th><th>Zone</th><th>Site</th><th>SKUs</th><th>Stock Lines</th><th>Units on Hand</th></tr></thead>
        <tbody id="stk-loc-tbody"></tbody>
      </table></div>
    </div>
    <div class="section">
      <div class="sec-hdr"><span class="sec-title">Articles on Hand</span><span class="badge b-blue" id="bdg-stock">—</span></div>
      <div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap"><input type="text" id="stk-search" placeholder="Search article no, name, supplier, location&hellip;" oninput="renderStockTable()" style="max-width:320px;font-size:.82rem"><select id="stk-grp" onchange="renderStockTable()" style="width:auto;font-size:.78rem;padding:5px 10px"><option value="">All groups</option></select><select id="stk-zone" onchange="renderStockTable()" style="width:auto;font-size:.78rem;padding:5px 10px"><option value="">All zones</option></select></div>
      <div class="tbl-scroll"><table>
        <thead><tr><th>Article</th><th>Name</th><th>Group</th><th>Primary Location</th><th>Zone</th><th># Locs</th><th>Unit</th><th>On Hand</th></tr></thead>
        <tbody id="stk-tbody"></tbody>
      </table></div>
    </div>
  </div>
</div>

<!-- ═══ INVENTORY ADJUSTMENTS ═════════════════════════════════════════════════ -->
<div id="tab-adjust" style="display:none">
  <div id="wh-build-adjust" class="placeholder" style="display:none"><h3>Warehouse snapshot building…</h3><p>Pulling inventory adjustments from Ongoing WMS. Refreshes twice a day.</p></div>
  <div id="adjust-data" style="display:none">
    <div class="alert" style="background:rgba(37,99,168,.07);border:1px solid rgba(37,99,168,.22);color:#1d4e89">Stock corrections from physical counts — <b>positive</b> = stock found / counted up, <b>negative</b> = shortage / counted down. Each line is a real WMS inventory adjustment with the operator and their note.</div>
    <div class="kpi-row">
      <div class="kpi"><div class="kpi-label">Adjustments</div><div class="kpi-val" id="adk-count" style="color:var(--accent)">—</div><div class="kpi-sub" id="adk-window">Look-back window</div></div>
      <div class="kpi"><div class="kpi-label">Inventory Accuracy</div><div class="kpi-val" id="adk-rate" style="color:var(--success)">—</div><div class="kpi-sub" id="adk-rate-sub">% of SKUs correct</div></div>
      <div class="kpi"><div class="kpi-label">Stock Up (+)</div><div class="kpi-val" id="adk-pos" style="color:var(--success)">—</div><div class="kpi-sub">Found / counted up</div></div>
      <div class="kpi"><div class="kpi-label">Stock Down (−)</div><div class="kpi-val" id="adk-neg" style="color:var(--danger)">—</div><div class="kpi-sub">Shortage / counted down</div></div>
      <div class="kpi"><div class="kpi-label">Net Units</div><div class="kpi-val" id="adk-net" style="color:var(--accent2)">—</div><div class="kpi-sub">Net quantity change</div></div>
      <div class="kpi"><div class="kpi-label">Operators</div><div class="kpi-val" id="adk-users" style="color:var(--muted)">—</div><div class="kpi-sub">Staff adjusting stock</div></div>
    </div>
    <div class="chart-card" style="margin-bottom:16px"><div class="chart-hdr"><span class="chart-title">Adjustments by Month (stock up vs down)</span></div><div class="chart-wrap"><canvas id="adj-chart"></canvas></div></div>
    <div class="section">
      <div class="sec-hdr"><span class="sec-title">Adjustment Log</span><span class="badge b-blue" id="bdg-adj">—</span></div>
      <div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap"><input type="text" id="adj-search" placeholder="Search article, operator, note, location…" oninput="renderAdjTable()" style="max-width:340px;font-size:.82rem"><select id="adj-dir" onchange="renderAdjTable()" style="width:auto;font-size:.78rem;padding:5px 10px"><option value="">All</option><option value="pos">Stock up (+)</option><option value="neg">Stock down (−)</option></select></div>
      <div class="tbl-scroll"><table>
        <thead><tr><th>Date</th><th>Article</th><th>Name</th><th>Change</th><th>Operator</th><th>Location</th><th>Note</th></tr></thead>
        <tbody id="adj-tbody"></tbody>
      </table></div>
    </div>
  </div>
</div>

<!-- ═══ WAREHOUSE ANALYTICS ═══════════════════════════════════════════════════ -->
<div id="tab-warehouse" style="display:none">
  <div id="wh-build-warehouse" class="placeholder" style="display:none"><h3>Warehouse snapshot building…</h3><p>Refreshes twice a day from Ongoing WMS.</p></div>
  <div id="warehouse-data" style="display:none">
    <div class="kpi-row">
      <div class="kpi"><div class="kpi-label">SKUs on Hand</div><div class="kpi-val" id="whk-skus" style="color:var(--accent)">—</div></div>
      <div class="kpi"><div class="kpi-label">Units on Hand</div><div class="kpi-val" id="whk-units" style="color:var(--success)">—</div></div>
      <div class="kpi"><div class="kpi-label" id="whk-po-lbl">Purchase Orders</div><div class="kpi-val" id="whk-poin" style="color:var(--accent2)">—</div></div>
      <div class="kpi"><div class="kpi-label">Adjustments</div><div class="kpi-val" id="whk-adj" style="color:var(--warning)">—</div></div>
      <div class="kpi"><div class="kpi-label">Inventory Accuracy</div><div class="kpi-val" id="whk-adjrate" style="color:var(--success)">—</div><div class="kpi-sub" id="whk-adjrate-sub">% of SKUs correct</div></div>
    </div>
    <div class="charts-row">
      <div class="chart-card"><div class="chart-hdr"><span class="chart-title">Receipts vs Adjustments by Month</span></div><div class="chart-wrap"><canvas id="wh-flow-chart"></canvas></div></div>
      <div class="chart-card"><div class="chart-hdr"><span class="chart-title">Top 12 Articles by Units on Hand</span></div><div class="chart-wrap"><canvas id="wh-top-chart"></canvas></div></div>
    </div>
    <div class="section">
      <div class="sec-hdr"><span class="sec-title">Stock by Article Group</span></div>
      <div class="tbl-scroll"><table>
        <thead><tr><th>Group</th><th>SKUs</th><th>Units on Hand</th><th>% of Units</th></tr></thead>
        <tbody id="wh-grp-tbody"></tbody>
      </table></div>
    </div>
    <p id="wh-built" style="color:var(--muted);font-size:.75rem;margin-top:10px"></p>
  </div>
</div>

<!-- ═══ ASK ═══════════════════════════════════════════════════════════════════ -->
<div id="tab-ask" style="display:none">
  <div class="ask-wrap">
    <div class="ask-intro">Ask about the warehouse in plain English — where an article is, its stock on hand, counts by product group, zone or location, plus purchase orders and stock adjustments. Answers come straight from the live warehouse data; nothing leaves your browser.</div>
    <div id="askLog" class="ask-log"></div>
    <div class="ask-row">
      <input id="askInput" class="ask-input" placeholder="e.g. where is an article no  ·  how many units in Racking  ·  units by group" onkeydown="if(event.key==='Enter'){askSubmit();}">
      <button type="button" class="ask-send" onclick="askSubmit()">Ask</button>
    </div>
    <div class="ask-chips" id="askChips"></div>
  </div>
</div>

</div><!-- /container -->
<script>
let D = null, T = null, period = 'weekly', trendChart = null, moChart = null;

const chartBase = {
  responsive:true, maintainAspectRatio:false,
  plugins:{ legend:{ display:false } },
  scales:{
    x:{ ticks:{color:'#64748b',font:{size:10}}, grid:{color:'rgba(20,40,80,.07)'} },
    y:{ ticks:{color:'#64748b',font:{size:10},stepSize:1}, grid:{color:'rgba(20,40,80,.07)'}, beginAtZero:true }
  }
};

function fd(s){ if(!s) return '—'; return new Date(s).toLocaleDateString('en-AU',{day:'2-digit',month:'short',year:'numeric'}); }
function setDot(s){ const d=document.getElementById('dot'); d.className='dot'+(s==='spin'?' spin-state pulsing':s==='err'?' err':''); }
function showAlert(msg,type){ document.getElementById('alert-box').innerHTML='<div class="alert a-'+(type||'ok')+'">'+msg+'</div>'; }
function clearAlert(){ document.getElementById('alert-box').innerHTML=''; }

function load(force){
  setDot('spin');
  document.getElementById('sync-lbl').textContent='Loading…';
  clearAlert();
  loadOrders(force);   // independent + self-polls while the cache warms
  // Freight contract — independent
  fetch('/api/contract').then(r=>r.json()).then(renderContract).catch(()=>{});
  // Transport register → Transport / Invoicing / Summaries — independent of orders
  fetch('/api/transport').then(r=> r.status===200 ? r.json() : null)
    .then(t=>{ if(t && t.bookings){ T=t; renderTransport(); renderInvoicing(); renderSummaries(); renderPlanner(); if(typeof renderUsage==='function') renderUsage(); } }).catch(()=>{});
}
// Orders served stale-while-revalidate; on a cold cache the server returns 202 {building} — poll until ready (no transport re-fetch)
function loadOrders(force){
  fetch('/api/data'+(force?'?refresh=1':''))
    .then(async r=>{ if(!r.ok) throw new Error(await r.text()); return r.json(); })
    .then(d=>{ if(!d || d.building || d.total==null){ document.getElementById('sync-lbl').textContent='Loading orders…'; setTimeout(()=>loadOrders(false), 6000); return; }
               D=d; render(); setDot('ok'); document.getElementById('sync-lbl').textContent='Last sync: '+fd(D.lastFetch); })
    .catch(e=>{ setDot('err'); document.getElementById('sync-lbl').textContent='Orders load failed'; showAlert('Orders failed to load: '+e.message,'error'); });
}

function refresh(){ load(true); }

function render(){
  if(!D) return;
  document.getElementById('k-total').textContent   = D.total;
  document.getElementById('k-gone').textContent    = D.gone;
  document.getElementById('k-pending').textContent = D.pending;
  document.getElementById('k-week').textContent    = D.thisWeekGone;
  document.getElementById('bdg-gone').textContent    = D.gone+' orders';
  document.getElementById('bdg-pending').textContent = D.pending+' orders';
  renderTrend(); renderMo(); renderMoTable(); renderOrderTables(); renderPlanner();
}

function setPeriod(p){
  period=p;
  document.getElementById('pt-wk').className='ptbtn'+(p==='weekly'?' active':'');
  document.getElementById('pt-mo').className='ptbtn'+(p==='monthly'?' active':'');
  renderTrend();
}

function renderTrend(){
  if(!D) return;
  const rows = period==='weekly' ? D.weeklyData : D.monthlyData;
  if(trendChart) trendChart.destroy();
  trendChart = new Chart(document.getElementById('chart-trend'),{
    type:'bar',
    data:{
      labels: rows.map(r=>r.label),
      datasets:[
        {label:'Dispatched', data:rows.map(r=>r.dispatched), backgroundColor:'rgba(54,211,153,.65)', borderRadius:3},
        {label:'Created',    data:rows.map(r=>r.created),    backgroundColor:'rgba(79,142,247,.3)',  borderRadius:3}
      ]
    },
    options:{ ...chartBase, plugins:{ legend:{ display:true, labels:{ color:'#52617a', font:{size:10}, boxWidth:10 } } } }
  });
}

function renderMo(){
  if(!D) return;
  const rows = D.monthlyData;
  if(moChart) moChart.destroy();
  moChart = new Chart(document.getElementById('chart-mo'),{
    type:'line',
    data:{
      labels: rows.map(r=>r.label),
      datasets:[{ label:'Dispatched', data:rows.map(r=>r.dispatched),
        borderColor:'#f59e0b', backgroundColor:'rgba(245,158,11,.1)',
        tension:.3, fill:true, pointRadius:3, pointBackgroundColor:'#f59e0b' }]
    },
    options:chartBase
  });
}

function renderMoTable(){
  if(!D) return;
  document.getElementById('mo-tbody').innerHTML =
    D.monthlyData.map(r=>
      '<tr><td>'+r.label+'</td><td>'+r.created+'</td><td>'+
      '<span style="color:var(--success);font-weight:600">'+r.dispatched+'</span></td></tr>'
    ).join('');
}

let ordView = 'all';
function setOrdView(v){
  ordView=v;
  ['all','gone','pend'].forEach(k=>{ document.getElementById('ord-'+k).className='ptbtn'+(v===k||v==='gone'&&k==='gone'||v==='pending'&&k==='pend'?' active':''); });
  document.getElementById('ord-all').className='ptbtn'+(v==='all'?' active':'');
  document.getElementById('ord-gone').className='ptbtn'+(v==='gone'?' active':'');
  document.getElementById('ord-pend').className='ptbtn'+(v==='pending'?' active':'');
  document.getElementById('ord-section-gone').style.display=(v==='pending'?'none':'');
  document.getElementById('ord-section-pend').style.display=(v==='gone'?'none':'');
  renderOrderTables();
}

function renderOrderTables(){
  if(!D) return;
  const q = (document.getElementById('ord-search')||{value:''}).value.toLowerCase().trim();
  function matchOrd(o){
    if(!q) return true;
    return [o.externalId,String(o.orderId||''),o.statusText,o.remark].some(f=>String(f||'').toLowerCase().includes(q));
  }
  const gone = D.recentGone.filter(matchOrd);
  const pend = D.pendingOrders.filter(matchOrd);
  const total = (ordView==='all' ? gone.length+pend.length : ordView==='gone' ? gone.length : pend.length);
  document.getElementById('bdg-ord-count').textContent = total+' order'+(total!==1?'s':'')+(q?' matched':'');
  document.getElementById('bdg-gone').textContent = gone.length+' orders';
  document.getElementById('bdg-pending').textContent = pend.length+' orders';

  const gTb = document.getElementById('gone-tbody');
  gTb.innerHTML = gone.length
    ? gone.map(o=>
        '<tr><td><code>'+(o.externalId||'—')+'</code></td>'+
        '<td style="color:var(--muted)">'+o.orderId+'</td>'+
        '<td>'+fd(o.orderDate)+'</td><td style="color:var(--success)">'+fd(o.shippedTime)+'</td>'+
        '<td>'+o.lines+'</td>'+
        '<td><span class="badge b-green">'+(o.statusText||'Shipped')+'</span></td></tr>'
      ).join('')
    : '<tr><td colspan="6" style="text-align:center;padding:20px;color:var(--muted)">'+(q?'No orders match "'+q+'"':'No dispatched orders found')+'</td></tr>';

  const pTb = document.getElementById('pend-tbody');
  pTb.innerHTML = pend.length
    ? pend.map(o=>
        '<tr><td><code>'+(o.externalId||'—')+'</code></td>'+
        '<td style="color:var(--muted)">'+o.orderId+'</td>'+
        '<td>'+fd(o.orderDate)+'</td><td>'+o.lines+'</td>'+
        '<td><span class="badge b-warn">'+(o.statusText||'Pending')+'</span></td>'+
        '<td style="color:var(--muted);font-size:.77rem">'+(o.remark||'')+'</td></tr>'
      ).join('')
    : '<tr><td colspan="6" style="text-align:center;padding:20px;color:var(--muted)">'+(q?'No orders match "'+q+'"':'No pending orders')+'</td></tr>';
}

function renderContract(c){
  c = c || {};
  window.__contract = c;
  document.getElementById('c-carrier').value = c.carrier||'';
  document.getElementById('c-service').value = c.service||'';
  document.getElementById('c-cno').value     = c.contractNumber||'';
  document.getElementById('c-eff').value     = c.effectiveDate||'';
  document.getElementById('c-exp').value     = c.expiryDate||'';
  document.getElementById('c-acct').value    = c.accountCode||'';
  document.getElementById('c-notes').value   = c.notes||'';
  document.getElementById('rates-tbody').innerHTML='';
  (c.rates||[]).forEach(r=>addRateRow(r));

  // Rate card
  document.getElementById('rc-sup-list').innerHTML  = BF_VOCAB.supplier.map(s=>'<option value="'+s+'">').join('');
  document.getElementById('rc-type-list').innerHTML = BF_VOCAB.type.map(s=>'<option value="'+s+'">').join('');
  document.getElementById('ratecard-tbody').innerHTML='';
  let card = c.rateCard;
  if(!card || !card.length){ card = Object.keys(BF_RATES).map(k=>{ const [supplier,type]=k.split('|'); return {supplier,type,exBuy:BF_RATES[k].buy,exSell:BF_RATES[k].sell}; }); }
  card.forEach(r=>addRateCardRow(r));
  syncRateCard();
  renderUsage();
}

const CONTRACT_DEFAULTS = {'1T Ute':50,'Light Rigid W tail Gate':718,'Semi Trailer':693};
function addRateCardRow(r){
  const tb=document.getElementById('ratecard-tbody');
  const tr=document.createElement('tr');
  const esc=s=>String(s==null?'':s).replace(/"/g,'&quot;');
  tr.innerHTML=[
    '<td><input type="text" list="rc-sup-list" value="'+esc(r&&r.supplier)+'" placeholder="Arrow" oninput="syncRateCard()"></td>',
    '<td><input type="text" list="rc-type-list" value="'+esc(r&&r.type)+'" placeholder="8T Flat bed…" oninput="syncRateCard()"></td>',
    '<td><input type="number" step="0.01" value="'+esc(r&&r.exBuy)+'" placeholder="0" oninput="syncRateCard()"></td>',
    '<td><input type="number" step="0.01" value="'+esc(r&&r.exSell)+'" placeholder="0" oninput="syncRateCard()"></td>',
    '<td><button class="del-btn" onclick="delRow(this);syncRateCard()">✕</button></td>'
  ].join('');
  tb.appendChild(tr);
}
function gatherRateCard(){
  return [...document.querySelectorAll('#ratecard-tbody tr')].map(tr=>{
    const i=tr.querySelectorAll('input');
    return {supplier:i[0].value.trim(), type:i[1].value.trim(), exBuy:parseFloat(i[2].value)||0, exSell:parseFloat(i[3].value)||0};
  }).filter(r=>r.supplier&&r.type);
}
function syncRateCard(){
  RATECARD = {};
  gatherRateCard().forEach(r=>{ RATECARD[r.supplier+'|'+r.type] = {buy:r.exBuy||null, sell:r.exSell||null}; });
}
async function applyRateCard(){
  syncRateCard();
  if(!T||!T.bookings){ showAlert('No bookings loaded','error'); return; }
  let n=0;
  T.bookings.forEach(b=>{
    if((b.exBuy||0)===0 && (b.exSell||0)===0){
      const r = rateFor(b.supplier, b.type);
      if(r){ if(r.buy!=null) b.exBuy=r.buy; if(r.sell!=null) b.exSell=r.sell; if(r.buy!=null||r.sell!=null) n++; }
    }
  });
  if(!n){ document.getElementById('rc-status').innerHTML='<div class="alert a-ok">No blank-EX rows matched a rate card entry.</div>'; return; }
  T.uploadedAt=new Date().toISOString();
  try{
    const r=await fetch('/api/transport',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(T)});
    if(!r.ok) throw new Error(await r.text());
    renderTransport(); renderInvoicing(); renderSummaries(); renderUsage();
    document.getElementById('rc-status').innerHTML='<div class="alert a-ok">Filled EX on '+n+' register rows.</div>';
  }catch(e){ document.getElementById('rc-status').innerHTML='<div class="alert a-error">Apply failed: '+e.message+'</div>'; }
}
function renderUsage(){
  const c = window.__contract||{};
  const allow = c.allowance || CONTRACT_DEFAULTS;
  const used = {};
  if(T&&T.bookings) T.bookings.forEach(b=>{ const t=(b.type||'—').trim()||'—'; used[t]=(used[t]||0)+1; });
  const types = [...new Set([...Object.keys(allow), ...Object.keys(used), ...BF_VOCAB.type])].filter(t=>t&&t!=='—');
  const esc=s=>String(s==null?'':s).replace(/"/g,'&quot;');
  document.getElementById('usage-tbody').innerHTML = types.map(t=>{
    const contr = allow[t]!=null?allow[t]:'';
    const u = used[t]||0;
    const rem = (contr!==''&&!isNaN(contr)) ? (Number(contr)-u) : '';
    const pct = (contr!==''&&Number(contr)>0) ? Math.round(u/Number(contr)*100) : null;
    const remColor = (rem!==''&&rem<0)?'var(--danger)':'var(--text)';
    return '<tr>'+
      '<td>'+t+'</td>'+
      '<td><input type="number" min="0" step="1" style="width:90px;padding:4px 7px" value="'+esc(contr)+'" data-type="'+esc(t)+'" class="usage-inp"></td>'+
      '<td>'+u+'</td>'+
      '<td style="color:'+remColor+'">'+(rem===''?'—':rem)+'</td>'+
      '<td>'+(pct!=null?pct+'%':'—')+'</td>'+
    '</tr>';
  }).join('') || '<tr><td colspan="5" style="text-align:center;padding:16px;color:var(--muted)">No data</td></tr>';
}
function gatherAllowance(){
  const a={};
  document.querySelectorAll('#usage-tbody .usage-inp').forEach(inp=>{ const v=inp.value.trim(); if(v!=='') a[inp.dataset.type]=Number(v); });
  return a;
}

/* ═══ PLANNER — estimate upcoming trips from Ongoing pending backlog + history ═══ */
let plDefaulted = false;
function renderPlanner(){
  const empty=document.getElementById('pl-empty'), data=document.getElementById('pl-data');
  if(!empty||!data) return;
  if(!D){ empty.style.display=''; data.style.display='none'; return; }
  empty.style.display='none'; data.style.display='';
  const wk = (D.weeklyData||[]);
  const last4 = wk.slice(-4);
  const disp4 = last4.reduce((s,w)=>s+(w.dispatched||0),0);
  const avgDaily = last4.length ? Math.max(1, Math.round(disp4/(last4.length*5))) : 10;
  let tpo = 0.5;
  if(T&&T.bookings&&T.bookings.length){
    const cut=new Date(); cut.setDate(cut.getDate()-56); const cutISO=cut.toISOString().slice(0,10);
    const recentTrips = T.bookings.filter(b=>b.date&&b.date>=cutISO).length;
    const disp8 = wk.slice(-8).reduce((s,w)=>s+(w.dispatched||0),0);
    if(disp8>0 && recentTrips>0) tpo = Math.round(recentTrips/disp8*100)/100;
  }
  const capEl=document.getElementById('pl-cap'), tpoEl=document.getElementById('pl-tpo');
  if(!plDefaulted){ capEl.value=avgDaily; tpoEl.value=tpo; plDefaulted=true; }
  const cap = Math.max(1, parseInt(capEl.value,10)||avgDaily);
  const tripsPerOrder = Math.max(0, parseFloat(tpoEl.value)||tpo);
  const horizon = Math.max(1, Math.min(60, parseInt(document.getElementById('pl-horizon').value,10)||15));
  document.getElementById('pl-basis').textContent = 'basis: '+disp4+' orders dispatched / last '+last4.length+' wks';
  let backlog = D.pending||0;
  document.getElementById('pl-backlog').textContent = backlog;
  document.getElementById('pl-trips').textContent   = Math.round(backlog*tripsPerOrder);
  document.getElementById('pl-perday').textContent  = Math.round(cap*tripsPerOrder);
  document.getElementById('pl-days').textContent    = Math.ceil(backlog/cap);
  const DOW=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const rows=[]; const d=new Date(); d.setHours(0,0,0,0); let guard=0;
  while(backlog>0 && rows.length<horizon && guard++<200){
    d.setDate(d.getDate()+1);
    const dow=d.getDay(); if(dow===0||dow===6) continue;
    const orders=Math.min(cap,backlog); backlog-=orders;
    rows.push({date:d.toISOString().slice(0,10), dow:DOW[dow], orders, trips:Math.round(orders*tripsPerOrder), left:backlog});
  }
  document.getElementById('pl-tbody').innerHTML = rows.length ? rows.map(r=>
    '<tr><td style="white-space:nowrap">'+r.date+'</td><td>'+r.dow+'</td><td>'+r.orders+'</td>'+
    '<td style="font-weight:700;color:var(--accent)">'+r.trips+'</td><td style="color:var(--muted)">'+r.left+'</td></tr>'
  ).join('') : '<tr><td colspan="5" style="text-align:center;padding:16px;color:var(--muted)">No pending backlog to schedule</td></tr>';
  const dowCount=[0,0,0,0,0,0,0];
  if(T&&T.bookings) T.bookings.forEach(b=>{ if(b.date){ const dd=new Date(b.date); if(!isNaN(dd)) dowCount[dd.getDay()]++; } });
  const totDow=dowCount.reduce((a,b)=>a+b,0)||1;
  const order=[1,2,3,4,5,6,0];
  document.getElementById('pl-dow-tbody').innerHTML = order.map(i=>{
    const share=Math.round(dowCount[i]/totDow*100);
    return '<tr><td>'+DOW[i]+'</td><td>'+dowCount[i]+'</td><td><div style="display:flex;align-items:center;gap:6px"><div style="height:7px;width:'+share+'%;min-width:2px;background:var(--accent);border-radius:3px"></div><span style="color:var(--muted);font-size:.72rem">'+share+'%</span></div></td></tr>';
  }).join('');
}

function addRateRow(r){
  const tb=document.getElementById('rates-tbody');
  const tr=document.createElement('tr');
  tr.innerHTML=[
    '<td><input type="text" value="'+(r?.zone||'')+'" placeholder="e.g. BNE–TT"></td>',
    '<td><input type="text" value="'+(r?.service||'')+'" placeholder="Road/Air/Sea"></td>',
    '<td><input type="text" value="'+(r?.rate||'')+'" placeholder="e.g. $2.50/kg"></td>',
    '<td><input type="text" value="'+(r?.unit||'')+'" placeholder="per kg/shipment"></td>',
    '<td><input type="text" value="'+(r?.notes||'')+'" placeholder="Conditions"></td>',
    '<td><button class="del-btn" onclick="delRow(this)">✕</button></td>'
  ].join('');
  tb.appendChild(tr);
}

async function saveContract(){
  const rates=[...document.querySelectorAll('#rates-tbody tr')].map(tr=>{
    const i=tr.querySelectorAll('input');
    return {zone:i[0].value,service:i[1].value,rate:i[2].value,unit:i[3].value,notes:i[4].value};
  });
  const payload={
    carrier:        document.getElementById('c-carrier').value,
    service:        document.getElementById('c-service').value,
    contractNumber: document.getElementById('c-cno').value,
    effectiveDate:  document.getElementById('c-eff').value,
    expiryDate:     document.getElementById('c-exp').value,
    accountCode:    document.getElementById('c-acct').value,
    notes:          document.getElementById('c-notes').value,
    rates,
    rateCard:       gatherRateCard(),
    allowance:      gatherAllowance()
  };
  window.__contract = payload;
  syncRateCard();
  renderUsage();
  try{
    const r=await fetch('/api/contract',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    if(!r.ok) throw new Error(await r.text());
    document.getElementById('c-status').innerHTML='<div class="alert a-ok">Saved successfully.</div>';
    setTimeout(()=>{document.getElementById('c-status').innerHTML='';},3000);
  } catch(e){
    document.getElementById('c-status').innerHTML='<div class="alert a-error">Save failed: '+e.message+'</div>';
  }
}

function delRow(btn){ btn.closest('tr').remove(); }

function showTab(name,el){
  ['overview','ask','orders','contract','transport','invoicing','planner','summaries','po','stock','adjust','warehouse'].forEach(t=>{
    document.getElementById('tab-'+t).style.display = t===name ? '' : 'none';
  });
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
  el.classList.add('active');
  if(name==='planner') renderPlanner();
}

function cur(id){ return document.getElementById(id).value; }

function fmtMoney(v){ return v != null && !isNaN(v) && (v!==0||true) ? '$'+Math.abs(v).toLocaleString('en-AU',{minimumFractionDigits:0,maximumFractionDigits:0}) : '—'; }

function buildOrderMap(){
  const m = {};
  if(D){ [...(D.recentGone||[]),...(D.pendingOrders||[])].forEach(o=>{ if(o.orderId) m[String(o.orderId)]=o; }); }
  return m;
}

async function handleTransportUpload(evt){
  const file = evt.target.files[0]; if(!file) return;
  const reader = new FileReader();
  reader.onload = async e => {
    try {
      const wb = XLSX.read(e.target.result, {type:'array'});
      const parsed = parseTransportXlsx(wb);
      const r = await fetch('/api/transport',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(parsed)});
      if(!r.ok) throw new Error(await r.text());
      T = parsed; renderTransport(); renderInvoicing(); renderSummaries(); renderPlanner(); if(typeof renderUsage==='function') renderUsage();
      showAlert('Transport data loaded: '+parsed.bookings.length+' bookings','ok');
    } catch(err){ showAlert('Upload failed: '+err.message,'error'); }
  };
  reader.readAsArrayBuffer(file);
}

function parseTransportXlsx(wb){
  const ws = wb.Sheets['Data'] || wb.Sheets[wb.SheetNames[0]];
  const raw = XLSX.utils.sheet_to_json(ws,{header:1,defval:''});
  const hdr = raw[0];
  function ci(n){ return hdr.findIndex(h=>String(h).toLowerCase().trim()===n.toLowerCase().trim()); }
  function xlDate(s){ if(!s||typeof s!=='number'||s<40000) return null; return new Date(Math.round((s-25569)*86400*1000)).toISOString().split('T')[0]; }
  const bookings = raw.slice(1).filter(r=>r[0]!==''&&r[ci('Date')]!=='').map(r=>({
    date:     xlDate(r[ci('Date')]),
    status:   String(r[ci('Status')]||'').trim(),
    orderId:  r[ci('Order ID')]||null,
    spark:    String(r[ci('Spark')]||r[ci('Client')]||'').trim(),
    site:     String(r[ci('Site')]||'').trim(),
    type:     String(r[ci('Type')]||'').trim(),
    supplier: String(r[ci('Supplier')]||'').trim(),
    invoice:  String(r[ci('Invoice')]||'').trim(),
    exBuy:    parseFloat(r[ci('EX Buy')])||0,
    exSell:   parseFloat(r[ci('EX Sell')])||0,
    accBuy:   parseFloat(r[ci('ACC Buy')])||0,
    accSell:  parseFloat(r[ci('ACC Sell')])||0,
    comments: String(r[ci('Comments')]||'').trim(),
  }));
  return {bookings, uploadedAt:new Date().toISOString()};
}

/* ═══ NEW BOOKING FORM (replaces manual keying into the NEL Excel) ═══════════ */
const BF_VOCAB = {
  status:   ['','Quoted','Planned','Booked','Completed','Cancelled'],
  client:   ['Spark','Trawalla','NON ME&I','Surface Works','Other'],
  site:     ['Thomastown','Campbellfield','Other'],
  type:     ['1T Ute','Light Rigid W tail Gate','Semi Trailer','7T Flat bed',
             '8T Flat bed BWS Tunnel Truck','6T Flat bed BWS Tunnel Truck',
             '9 T Tilt Tray','12 T Tilt Tray','Prime Mover','Drop Deck','Franna','Other'],
  supplier: ['Arrow','JYC','AMC','Tasman','Other'],
};
const BF_RATES = {
  'Arrow|8T Flat bed BWS Tunnel Truck':{buy:618.8, sell:1006.25},
  'Arrow|Prime Mover':                 {buy:658,   sell:null},
  'Arrow|7T Flat bed':                 {buy:7120,  sell:8120},
  'Arrow|12 T Tilt Tray':              {buy:8160,  sell:9300},
};
let RATECARD = Object.assign({}, BF_RATES);
function rateFor(sup, type){ return RATECARD[sup+'|'+type] || null; }
function bfOptions(key, field){
  const base = BF_VOCAB[key].slice();
  if(T && T.bookings) T.bookings.forEach(b=>{ const v=(b[field]||'').trim(); if(v && !base.includes(v)) base.push(v); });
  return base;
}
function fillSelect(id, opts, sel){
  document.getElementById(id).innerHTML = opts.map(o=>'<option'+(o===sel?' selected':'')+'>'+o+'</option>').join('');
}
function todayISO(){ const d=new Date(); return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,10); }
let bfEditIdx = null;

function bfFillOrderList(){
  const om = buildOrderMap();
  const ids = Object.keys(om).sort((a,b)=>(om[b].shippedTime||om[b].orderDate||'').localeCompare(om[a].shippedTime||om[a].orderDate||''));
  document.getElementById('bf-order-list').innerHTML =
    ids.map(id=>'<option value="'+id+'">'+id+(om[id].externalId?' — '+om[id].externalId:'')+'</option>').join('');
}
function openBooking(){
  bfEditIdx = null;
  document.getElementById('bf-title').textContent = 'New transport booking';
  document.getElementById('bf-addanother').style.display = '';
  fillSelect('bf-status',   BF_VOCAB.status);
  fillSelect('bf-client',   bfOptions('client','spark'),   'Spark');
  fillSelect('bf-site',     bfOptions('site','site'),      'Thomastown');
  fillSelect('bf-type',     ['',...bfOptions('type','type')]);
  fillSelect('bf-supplier', bfOptions('supplier','supplier'), 'Arrow');
  document.getElementById('bf-date').value = todayISO();
  ['bf-order','bf-invoice','bf-exbuy','bf-exsell','bf-buy','bf-sell','bf-comments'].forEach(id=>document.getElementById(id).value='');
  document.getElementById('bf-qty').value = '1';
  document.getElementById('bf-qtyrow').style.display = '';
  document.getElementById('bf-userate').checked = true;
  document.getElementById('bf-rate-hint').textContent='';
  document.getElementById('bf-wms-hint').textContent='';
  bfFillOrderList();
  document.getElementById('booking-ov').classList.add('show');
}
function editBooking(idx){
  const b = T && T.bookings && T.bookings[idx];
  if(!b) return;
  bfEditIdx = idx;
  document.getElementById('bf-title').textContent = 'Edit booking';
  document.getElementById('bf-addanother').style.display = 'none';
  document.getElementById('bf-qtyrow').style.display = 'none';
  fillSelect('bf-status',   BF_VOCAB.status,                  b.status||'');
  fillSelect('bf-client',   bfOptions('client','spark'),      b.spark||'');
  fillSelect('bf-site',     bfOptions('site','site'),         b.site||'');
  fillSelect('bf-type',     ['',...bfOptions('type','type')], b.type||'');
  fillSelect('bf-supplier', bfOptions('supplier','supplier'), b.supplier||'');
  document.getElementById('bf-date').value    = b.date||'';
  document.getElementById('bf-order').value   = b.orderId!=null?b.orderId:'';
  document.getElementById('bf-invoice').value = b.invoice||'';
  document.getElementById('bf-exbuy').value   = b.exBuy||'';
  document.getElementById('bf-exsell').value  = b.exSell||'';
  document.getElementById('bf-buy').value     = b.accBuy||'';
  document.getElementById('bf-sell').value    = b.accSell||'';
  document.getElementById('bf-comments').value= b.comments||'';
  document.getElementById('bf-userate').checked = false;
  document.getElementById('bf-rate-hint').textContent='';
  document.getElementById('bf-wms-hint').textContent='';
  bfFillOrderList();
  onOrderInput();
  document.getElementById('booking-ov').classList.add('show');
}
function closeBooking(){ document.getElementById('booking-ov').classList.remove('show'); bfEditIdx=null; }

function onOrderInput(){
  const id = document.getElementById('bf-order').value.trim();
  const hint = document.getElementById('bf-wms-hint');
  const o = id && buildOrderMap()[id];
  if(!o){ hint.textContent = id?'No matching WMS order (kept as free-text reference).':''; return; }
  hint.textContent = '✓ Linked: '+(o.externalId||id)+(o.statusText?' · '+o.statusText:'')+(o.remark?' · '+o.remark.slice(0,40):'');
  const wd = (o.shippedTime||o.orderDate||'').slice(0,10);
  const dEl=document.getElementById('bf-date'); if(wd && !dEl.value) dEl.value=wd;
  const cEl=document.getElementById('bf-comments'); if(o.remark && !cEl.value) cEl.value=o.remark;
}
function onRateInputs(){
  const hint = document.getElementById('bf-rate-hint');
  if(!document.getElementById('bf-userate').checked){ hint.textContent=''; return; }
  const sup=document.getElementById('bf-supplier').value, type=document.getElementById('bf-type').value;
  const r = rateFor(sup, type);
  if(!r){ hint.textContent=''; return; }
  const buy=document.getElementById('bf-exbuy'), sell=document.getElementById('bf-exsell');
  let applied=[];
  if(r.buy!=null && !buy.value){ buy.value=r.buy; applied.push('EX buy $'+r.buy); }
  if(r.sell!=null && !sell.value){ sell.value=r.sell; applied.push('EX sell $'+r.sell); }
  hint.textContent = applied.length ? '✓ Rate card applied ('+applied.join(', ')+') — actuals go in ACC when invoiced' : '';
}
async function submitBooking(keepOpen){
  const date = document.getElementById('bf-date').value;
  if(!date){ showAlert('Booking needs a date','error'); return; }
  const qty = Math.max(1, Math.min(50, parseInt(document.getElementById('bf-qty').value,10)||1));
  const orderRaw = document.getElementById('bf-order').value.trim();
  const orderId  = orderRaw==='' ? null : (/^\\d+$/.test(orderRaw) ? Number(orderRaw) : orderRaw);
  const base = {
    date,
    status:   document.getElementById('bf-status').value.trim(),
    orderId,
    spark:    document.getElementById('bf-client').value.trim(),
    site:     document.getElementById('bf-site').value.trim(),
    type:     document.getElementById('bf-type').value.trim(),
    supplier: document.getElementById('bf-supplier').value.trim(),
    invoice:  document.getElementById('bf-invoice').value.trim(),
    exBuy:    parseFloat(document.getElementById('bf-exbuy').value)||0,
    exSell:   parseFloat(document.getElementById('bf-exsell').value)||0,
    accBuy:   parseFloat(document.getElementById('bf-buy').value)||0,
    accSell:  parseFloat(document.getElementById('bf-sell').value)||0,
    comments: document.getElementById('bf-comments').value.trim(),
  };
  if(!T || !T.bookings) T = {bookings:[], uploadedAt:new Date().toISOString()};
  const editing = bfEditIdx!=null;
  let snapshot;
  if(editing){ snapshot = T.bookings[bfEditIdx]; T.bookings[bfEditIdx] = {...base}; }
  else       { for(let i=0;i<qty;i++) T.bookings.push({...base}); }
  T.uploadedAt = new Date().toISOString();
  try {
    const r = await fetch('/api/transport',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(T)});
    if(!r.ok) throw new Error(await r.text());
    renderTransport(); renderInvoicing(); renderSummaries(); if(typeof renderUsage==='function') renderUsage();
    if(editing){
      showAlert('Booking updated','ok'); closeBooking();
    } else {
      showAlert('Saved '+qty+' booking'+(qty>1?'s':'')+' — '+T.bookings.length+' total','ok');
      if(keepOpen){
        ['bf-order','bf-invoice','bf-comments'].forEach(id=>document.getElementById(id).value='');
        document.getElementById('bf-qty').value='1';
        document.getElementById('bf-wms-hint').textContent='';
        document.getElementById('bf-order').focus();
      } else { closeBooking(); }
    }
  } catch(err){
    if(editing){ T.bookings[bfEditIdx] = snapshot; }
    else       { for(let i=0;i<qty;i++) T.bookings.pop(); }
    showAlert('Save failed: '+err.message,'error');
  }
}

function renderTransport(){
  const empty = document.getElementById('tp-empty');
  const data  = document.getElementById('tp-data');
  if(!T||!T.bookings){ empty.style.display=''; data.style.display='none'; return; }
  empty.style.display='none'; data.style.display='';
  const bk = T.bookings;
  const totalCost   = bk.reduce((s,b)=>s+b.accBuy,0);
  const totalSell   = bk.reduce((s,b)=>s+b.accSell,0);
  const totalProfit = totalSell - totalCost;
  document.getElementById('tk-trips').textContent  = bk.length;
  document.getElementById('tk-cost').textContent   = fmtMoney(totalCost);
  document.getElementById('tk-sell').textContent   = fmtMoney(totalSell);
  document.getElementById('tk-profit').textContent = (totalProfit>=0?'':'-')+fmtMoney(totalProfit);
  // Site split KPIs
  ['Thomastown','Campbellfield'].forEach(site=>{
    const pfx = site==='Thomastown'?'tt':'cf';
    const sb = bk.filter(b=>b.site===site);
    const sc = sb.reduce((s,b)=>s+b.accBuy,0), sr = sb.reduce((s,b)=>s+b.accSell,0), sp=sr-sc;
    document.getElementById('tk-'+pfx+'-trips').textContent  = sb.length;
    document.getElementById('tk-'+pfx+'-cost').textContent   = sc?fmtMoney(sc):'—';
    document.getElementById('tk-'+pfx+'-rev').textContent    = sr?fmtMoney(sr):'—';
    document.getElementById('tk-'+pfx+'-profit').textContent = (sc||sr)?((sp>=0?'':'-')+fmtMoney(sp)):'—';
  });
  const suppliers = ['All suppliers',...new Set(bk.map(b=>b.supplier).filter(Boolean))].sort((a,b)=>a==='All suppliers'?-1:1);
  const sfEl = document.getElementById('tf-supplier');
  const curSup = sfEl.value;
  sfEl.innerHTML = suppliers.map(s=>'<option value="'+(s==='All suppliers'?'':s)+'"'+(s===curSup||(!curSup&&s==='All suppliers')?' selected':'')+'>'+s+'</option>').join('');
  const supFilter  = cur('tf-supplier');
  const siteFilter = (document.getElementById('tf-site')||{value:''}).value;
  const linkFilter = cur('tf-linked');
  const searchQ    = (document.getElementById('tf-search')||{value:''}).value.toLowerCase().trim();
  const orderMap   = buildOrderMap();
  let filtered = bk;
  if(siteFilter)             filtered = filtered.filter(b=>b.site===siteFilter);
  if(supFilter)              filtered = filtered.filter(b=>b.supplier===supFilter);
  if(linkFilter==='linked')  filtered = filtered.filter(b=>b.orderId&&orderMap[String(b.orderId)]);
  if(linkFilter==='unlinked')filtered = filtered.filter(b=>!b.orderId||!orderMap[String(b.orderId)]);
  if(searchQ) filtered = filtered.filter(b=>[b.date,String(b.orderId||''),b.spark,b.site,b.type,b.invoice,b.comments,b.supplier].some(f=>String(f||'').toLowerCase().includes(searchQ)));
  document.getElementById('bdg-transport').textContent = filtered.length+' bookings';
  const sorted = [...filtered].sort((a,b)=>(b.date||'').localeCompare(a.date||''));
  const tb = document.getElementById('transport-tbody');
  tb.innerHTML = sorted.length ? sorted.map(b=>{
    const idx  = T.bookings.indexOf(b);
    const wms = b.orderId&&orderMap[String(b.orderId)];
    const prof = b.accSell-b.accBuy;
    const pc   = prof>0?'var(--success)':prof<0?'var(--danger)':'var(--muted)';
    const siteColor = b.site==='Thomastown'?'#f59e0b':b.site==='Campbellfield'?'#a78bfa':'var(--muted)';
    const awaiting = (!b.accBuy&&!b.accSell)&&(b.exBuy||b.exSell);
    return '<tr'+(awaiting?' style="background:rgba(245,158,11,.05)"':'')+'>'+
      '<td style="white-space:nowrap">'+(b.date||'—')+'</td>'+
      '<td style="white-space:nowrap"><span style="font-size:.72rem;font-weight:700;color:'+siteColor+'">'+(b.site||'—')+'</span></td>'+
      '<td>'+(b.orderId?'<code style="'+(wms?'color:var(--success)':'opacity:.55')+'">'+b.orderId+'</code>'+(wms?' <span style="color:var(--muted);font-size:.72em">'+(wms.externalId||'')+'</span>':''):'—')+'</td>'+
      '<td>'+(b.spark||'—')+'</td>'+
      '<td style="color:var(--muted);font-size:.77rem">'+(b.type||'—')+'</td>'+
      '<td><span class="badge b-blue">'+(b.supplier||'—')+'</span></td>'+
      '<td>'+(b.invoice?'<code>'+b.invoice+'</code>':'<span style="color:var(--muted)">—</span>')+'</td>'+
      '<td style="color:var(--warning)">'+(b.exBuy?fmtMoney(b.exBuy):'—')+'</td>'+
      '<td style="color:var(--warning)">'+(b.exSell?fmtMoney(b.exSell):'—')+'</td>'+
      '<td style="color:var(--danger)">'+(b.accBuy?fmtMoney(b.accBuy):(awaiting?'<span style="color:var(--warning);font-size:.7rem">awaiting inv</span>':'—'))+'</td>'+
      '<td style="color:var(--success)">'+(b.accSell?fmtMoney(b.accSell):'—')+'</td>'+
      '<td style="color:'+pc+'">'+(b.accBuy||b.accSell?(prof>=0?'':'-')+fmtMoney(prof):'—')+'</td>'+
      '<td style="color:var(--muted);font-size:.75rem;max-width:170px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+(b.comments||'')+'</td>'+
      '<td><button class="btn" style="padding:3px 9px;font-size:.72rem" onclick="editBooking('+idx+')">Edit</button></td>'+
    '</tr>';
  }).join('') : '<tr><td colspan="14" style="text-align:center;padding:20px;color:var(--muted)">No bookings match filter</td></tr>';
}

function renderInvoicing(){
  const empty = document.getElementById('inv-empty');
  const data  = document.getElementById('inv-data');
  if(!T||!T.bookings){ empty.style.display=''; data.style.display='none'; return; }
  empty.style.display='none'; data.style.display='';
  const bk       = T.bookings.filter(b=>b.accBuy>0||b.accSell>0);
  const invoiced  = bk.filter(b=>b.invoice&&b.invoice.trim());
  const uninvoiced= bk.filter(b=>!b.invoice||!b.invoice.trim());
  const totalSell = bk.reduce((s,b)=>s+b.accSell,0);
  const totalCost = bk.reduce((s,b)=>s+b.accBuy,0);
  const invSell   = invoiced.reduce((s,b)=>s+b.accSell,0);
  const margin    = totalSell>0 ? Math.round((totalSell-totalCost)/totalSell*100) : 0;
  document.getElementById('ik-invoiced').textContent   = invoiced.length;
  document.getElementById('ik-uninvoiced').textContent = uninvoiced.length;
  document.getElementById('ik-total').textContent      = fmtMoney(invSell);
  document.getElementById('ik-margin').textContent     = margin+'%';
  const orderMap = buildOrderMap();
  const invSupEl = document.getElementById('inv-supplier');
  if(invSupEl){
    const curIS = invSupEl.value;
    const supSet = [...new Set(bk.map(b=>b.supplier).filter(Boolean))].sort();
    invSupEl.innerHTML='<option value="">All suppliers</option>'+supSet.map(s=>'<option value="'+s+'"'+(s===curIS?' selected':'')+'>'+s+'</option>').join('');
  }
  const invQ    = (document.getElementById('inv-search')||{value:''}).value.toLowerCase().trim();
  const invSup  = (document.getElementById('inv-supplier')||{value:''}).value;
  const invSite = (document.getElementById('inv-site')||{value:''}).value;
  function matchInv(b){
    if(invSup  && b.supplier!==invSup)  return false;
    if(invSite && b.site!==invSite)     return false;
    if(!invQ) return true;
    return [b.invoice,b.date,String(b.orderId||''),b.spark,b.site,b.supplier,b.comments].some(f=>String(f||'').toLowerCase().includes(invQ));
  }
  function wmsCell(b){
    const wms=b.orderId&&orderMap[String(b.orderId)];
    return b.orderId?'<code>'+(wms?'<span style="color:var(--success)">':'')+b.orderId+(wms?'</span>':'')+'</code>'+(wms?' <span style="color:var(--muted);font-size:.72em">'+(wms.externalId||'')+'</span>':''):'—';
  }
  const invSorted  = [...invoiced].filter(matchInv).sort((a,b)=>(b.date||'').localeCompare(a.date||''));
  const uninvSorted= [...uninvoiced].filter(matchInv).sort((a,b)=>(b.date||'').localeCompare(a.date||''));
  document.getElementById('bdg-invoices').textContent  = invSorted.length+' invoices';
  document.getElementById('bdg-uninv').textContent     = uninvSorted.length+' jobs';
  document.getElementById('inv-tbody').innerHTML = invSorted.length ? invSorted.map(b=>{
    const prof=b.accSell-b.accBuy, mg=b.accSell>0?Math.round(prof/b.accSell*100):0;
    const pc=prof>0?'var(--success)':prof<0?'var(--danger)':'var(--muted)';
    const isc=b.site==='Thomastown'?'#f59e0b':b.site==='Campbellfield'?'#a78bfa':'var(--muted)';
    return '<tr>'+
      '<td><code>'+b.invoice+'</code></td>'+
      '<td style="white-space:nowrap">'+(b.date||'—')+'</td>'+
      '<td style="white-space:nowrap"><span style="font-size:.72rem;font-weight:700;color:'+isc+'">'+(b.site||'—')+'</span></td>'+
      '<td>'+wmsCell(b)+'</td>'+
      '<td>'+(b.spark||'—')+'</td>'+
      '<td><span class="badge b-blue">'+(b.supplier||'—')+'</span></td>'+
      '<td style="color:var(--danger)">'+(b.accBuy?fmtMoney(b.accBuy):'—')+'</td>'+
      '<td style="color:var(--success)">'+(b.accSell?fmtMoney(b.accSell):'—')+'</td>'+
      '<td style="color:'+pc+'">'+(b.accBuy||b.accSell?(prof>=0?'':'-')+fmtMoney(prof):'—')+'</td>'+
      '<td style="color:'+pc+'">'+(b.accSell>0?mg+'%':'—')+'</td>'+
      '<td style="color:var(--muted);font-size:.75rem">'+(b.comments||'').slice(0,55)+'</td>'+
    '</tr>';
  }).join('') : '<tr><td colspan="10" style="text-align:center;padding:20px;color:var(--muted)">No invoiced jobs</td></tr>';
  document.getElementById('uninv-tbody').innerHTML = uninvSorted.length ? uninvSorted.map(b=>{
    const usc=b.site==='Thomastown'?'#f59e0b':b.site==='Campbellfield'?'#a78bfa':'var(--muted)';
    return '<tr>'+
      '<td style="white-space:nowrap">'+(b.date||'—')+'</td>'+
      '<td style="white-space:nowrap"><span style="font-size:.72rem;font-weight:700;color:'+usc+'">'+(b.site||'—')+'</span></td>'+
      '<td>'+wmsCell(b)+'</td>'+
      '<td>'+(b.spark||'—')+'</td>'+
      '<td><span class="badge b-blue">'+(b.supplier||'—')+'</span></td>'+
      '<td style="color:var(--danger)">'+(b.accBuy?fmtMoney(b.accBuy):'—')+'</td>'+
      '<td style="color:var(--success)">'+(b.accSell?fmtMoney(b.accSell):'—')+'</td>'+
      '<td style="color:var(--muted);font-size:.75rem">'+(b.comments||'').slice(0,60)+'</td>'+
    '</tr>';
  }).join('') : '<tr><td colspan="8" style="text-align:center;padding:20px;color:var(--muted)">All jobs are invoiced</td></tr>';
}

function renderSummaries(){
  const empty = document.getElementById('sum-empty');
  const data  = document.getElementById('sum-data');
  if(!T||!T.bookings){ empty.style.display=''; data.style.display='none'; return; }
  empty.style.display='none'; data.style.display='';

  // Populate supplier dropdown
  const sumSupEl = document.getElementById('sum-supplier');
  if(sumSupEl){
    const curSS = sumSupEl.value;
    const supSet = [...new Set(T.bookings.map(b=>b.supplier).filter(Boolean))].sort();
    sumSupEl.innerHTML='<option value="">All suppliers</option>'+supSet.map(s=>'<option value="'+s+'"'+(s===curSS?' selected':'')+'>'+s+'</option>').join('');
  }
  const sumSup  = (document.getElementById('sum-supplier')||{value:''}).value;
  const sumFrom = (document.getElementById('sum-from')||{value:''}).value;
  const sumTo   = (document.getElementById('sum-to')||{value:''}).value;
  let bk = T.bookings;
  if(sumSup)  bk = bk.filter(b=>b.supplier===sumSup);
  if(sumFrom) bk = bk.filter(b=>b.date&&b.date.slice(0,7)>=sumFrom);
  if(sumTo)   bk = bk.filter(b=>b.date&&b.date.slice(0,7)<=sumTo);

  // ── KPIs ────────────────────────────────────────────────────────────────────
  const totalTrips  = bk.length;
  const totalCost   = bk.reduce((s,b)=>s+(b.accBuy||0),0);
  const totalRev    = bk.reduce((s,b)=>s+(b.accSell||0),0);
  const totalProfit = totalRev - totalCost;
  document.getElementById('sk-trips').textContent  = totalTrips;
  document.getElementById('sk-cost').textContent   = fmtMoney(totalCost);
  document.getElementById('sk-rev').textContent    = fmtMoney(totalRev);
  document.getElementById('sk-profit').textContent = (totalProfit>=0?'+':'-')+fmtMoney(Math.abs(totalProfit));

  // ── By Site ─────────────────────────────────────────────────────────────────
  const SITES_ORDER = ['Thomastown','Campbellfield','Other'];
  const siteColors  = {Thomastown:'#f59e0b', Campbellfield:'#a78bfa'};
  const siteMap = {};
  bk.forEach(b=>{
    const k = b.site||'Other';
    if(!siteMap[k]) siteMap[k]={trips:0,invoiced:0,exbuy:0,cost:0,rev:0};
    siteMap[k].trips++;
    if(b.invoice&&b.invoice.trim()) siteMap[k].invoiced++;
    siteMap[k].exbuy += b.exBuy||0;
    siteMap[k].cost  += b.accBuy||0;
    siteMap[k].rev   += b.accSell||0;
  });
  const siteRows = [...SITES_ORDER,...Object.keys(siteMap).filter(k=>!SITES_ORDER.includes(k))].filter(k=>siteMap[k]);
  document.getElementById('sum-site-tbody').innerHTML = siteRows.map(site=>{
    const s=siteMap[site], prof=s.rev-s.cost, mg=s.rev>0?Math.round(prof/s.rev*100):null;
    const pc=prof>0?'var(--success)':prof<0?'var(--danger)':'var(--muted)';
    const sc=siteColors[site]||'var(--muted)';
    return '<tr>'+
      '<td><span style="font-weight:700;color:'+sc+'">'+site+'</span></td>'+
      '<td>'+s.trips+'</td>'+
      '<td style="color:var(--muted)">'+s.invoiced+' / '+s.trips+'</td>'+
      '<td style="color:var(--warning)">'+(s.exbuy?fmtMoney(s.exbuy):'—')+'</td>'+
      '<td style="color:var(--danger)">'+(s.cost?fmtMoney(s.cost):'—')+'</td>'+
      '<td style="color:var(--success)">'+(s.rev?fmtMoney(s.rev):'—')+'</td>'+
      '<td style="color:'+pc+'">'+(s.cost||s.rev?(prof>=0?'':'-')+fmtMoney(Math.abs(prof)):'—')+'</td>'+
      '<td style="color:'+pc+'">'+(mg!==null?mg+'%':'—')+'</td>'+
    '</tr>';
  }).join('') || '<tr><td colspan="8" style="text-align:center;padding:16px;color:var(--muted)">No data</td></tr>';

  // ── By Supplier ─────────────────────────────────────────────────────────────
  const suppliers = {};
  bk.forEach(b=>{
    const k = b.supplier||'—';
    if(!suppliers[k]) suppliers[k]={trips:0,cost:0,rev:0};
    suppliers[k].trips++;
    suppliers[k].cost += b.accBuy||0;
    suppliers[k].rev  += b.accSell||0;
  });
  const supRows = Object.entries(suppliers).sort((a,b)=>b[1].trips-a[1].trips);
  document.getElementById('sum-supplier-tbody').innerHTML = supRows.map(([sup,s])=>{
    const prof=s.rev-s.cost, mg=s.rev>0?Math.round(prof/s.rev*100):null;
    const pc=prof>0?'var(--success)':prof<0?'var(--danger)':'var(--muted)';
    return '<tr>'+
      '<td><span class="badge b-blue">'+sup+'</span></td>'+
      '<td>'+s.trips+'</td>'+
      '<td style="color:var(--danger)">'+(s.cost?fmtMoney(s.cost):'—')+'</td>'+
      '<td style="color:var(--success)">'+(s.rev?fmtMoney(s.rev):'—')+'</td>'+
      '<td style="color:'+pc+'">'+(s.cost||s.rev?(prof>=0?'':'-')+fmtMoney(Math.abs(prof)):'—')+'</td>'+
      '<td style="color:'+pc+'">'+(mg!==null?mg+'%':'—')+'</td>'+
    '</tr>';
  }).join('');

  // ── helpers: ISO week key (Monday) ──────────────────────────────────────────
  function weekKey(dateStr){
    if(!dateStr) return null;
    const d = new Date(dateStr);
    const day = d.getDay(); // 0=Sun
    const diff = (day===0?-6:1-day);
    const mon = new Date(d); mon.setDate(d.getDate()+diff);
    return mon.toISOString().split('T')[0];
  }
  function monthKey(dateStr){ return dateStr?dateStr.slice(0,7):null; }
  function fmtMonth(k){ if(!k) return '—'; const [y,m]=k.split('-'); return new Date(y,m-1,1).toLocaleDateString('en-AU',{month:'short',year:'numeric'}); }

  // ── By Month ────────────────────────────────────────────────────────────────
  const months={};
  bk.forEach(b=>{
    const k=monthKey(b.date); if(!k) return;
    if(!months[k]) months[k]={trips:0,invoiced:0,cost:0,rev:0};
    months[k].trips++;
    if(b.invoice&&b.invoice.trim()) months[k].invoiced++;
    months[k].cost += b.accBuy||0;
    months[k].rev  += b.accSell||0;
  });
  const monthRows = Object.keys(months).sort((a,b)=>b.localeCompare(a));
  document.getElementById('sum-month-tbody').innerHTML = monthRows.map(k=>{
    const m=months[k], prof=m.rev-m.cost, mg=m.rev>0?Math.round(prof/m.rev*100):null;
    const pc=prof>0?'var(--success)':prof<0?'var(--danger)':'var(--muted)';
    return '<tr>'+
      '<td style="white-space:nowrap;font-weight:500">'+fmtMonth(k)+'</td>'+
      '<td>'+m.trips+'</td>'+
      '<td style="color:var(--muted)">'+m.invoiced+' / '+m.trips+'</td>'+
      '<td style="color:var(--danger)">'+(m.cost?fmtMoney(m.cost):'—')+'</td>'+
      '<td style="color:var(--success)">'+(m.rev?fmtMoney(m.rev):'—')+'</td>'+
      '<td style="color:'+pc+'">'+(m.cost||m.rev?(prof>=0?'':'-')+fmtMoney(Math.abs(prof)):'—')+'</td>'+
      '<td style="color:'+pc+'">'+(mg!==null?mg+'%':'—')+'</td>'+
    '</tr>';
  }).join('') || '<tr><td colspan="7" style="text-align:center;padding:16px;color:var(--muted)">No data</td></tr>';

  // ── By Week ─────────────────────────────────────────────────────────────────
  const weeks={};
  bk.forEach(b=>{
    const k=weekKey(b.date); if(!k) return;
    if(!weeks[k]) weeks[k]={trips:0,invoiced:0,cost:0,rev:0,sups:new Set()};
    weeks[k].trips++;
    if(b.invoice&&b.invoice.trim()) weeks[k].invoiced++;
    weeks[k].cost += b.accBuy||0;
    weeks[k].rev  += b.accSell||0;
    if(b.supplier) weeks[k].sups.add(b.supplier);
  });
  const weekRows = Object.keys(weeks).sort((a,b)=>b.localeCompare(a));
  document.getElementById('sum-week-tbody').innerHTML = weekRows.map(k=>{
    const w=weeks[k], prof=w.rev-w.cost, mg=w.rev>0?Math.round(prof/w.rev*100):null;
    const pc=prof>0?'var(--success)':prof<0?'var(--danger)':'var(--muted)';
    const supList=[...w.sups].map(s=>'<span class="badge b-blue" style="margin:1px">'+s+'</span>').join('');
    return '<tr>'+
      '<td style="white-space:nowrap;font-weight:500">'+k+'</td>'+
      '<td>'+w.trips+'</td>'+
      '<td style="color:var(--muted)">'+w.invoiced+' / '+w.trips+'</td>'+
      '<td style="color:var(--danger)">'+(w.cost?fmtMoney(w.cost):'—')+'</td>'+
      '<td style="color:var(--success)">'+(w.rev?fmtMoney(w.rev):'—')+'</td>'+
      '<td style="color:'+pc+'">'+(w.cost||w.rev?(prof>=0?'':'-')+fmtMoney(Math.abs(prof)):'—')+'</td>'+
      '<td style="color:'+pc+'">'+(mg!==null?mg+'%':'—')+'</td>'+
      '<td>'+supList+'</td>'+
    '</tr>';
  }).join('') || '<tr><td colspan="8" style="text-align:center;padding:16px;color:var(--muted)">No data</td></tr>';
}

/* ═══ WAREHOUSE front-end (goods owner 93) — appended into the dashboard script ═══ */
let W = null;
let poChart=null, poStatusChart=null, stkGrpChart=null, stkCatChart=null, adjChart=null, adjUserChart=null, whFlowChart=null, whTopChart=null;
const whN = n => (n==null||isNaN(n)) ? '—' : Math.round(n).toLocaleString('en-AU');
const WH_PAL = ['#4f8ef7','#36d399','#f59e0b','#7c5cfc','#f87171','#22d3ee','#a3e635','#fb923c','#e879f9','#60a5fa','#34d399','#fbbf24'];
const whChartBase = {
  responsive:true, maintainAspectRatio:false,
  plugins:{ legend:{ display:false } },
  scales:{ x:{ ticks:{color:'#64748b',font:{size:9}}, grid:{color:'rgba(20,40,80,.07)'} },
           y:{ ticks:{color:'#64748b',font:{size:10}}, grid:{color:'rgba(20,40,80,.07)'}, beginAtZero:true } }
};

function whShowState(ready){
  ['po','stock','adjust','warehouse'].forEach(t=>{
    const b=document.getElementById('wh-build-'+t), d=document.getElementById(t+'-data');
    if(b) b.style.display = ready ? 'none' : '';
    if(d) d.style.display = ready ? '' : 'none';
  });
}

async function loadWarehouse(){
  try{
    const r = await fetch('/api/warehouse');
    if(r.status===202){ whShowState(false); setTimeout(loadWarehouse, 30000); return; }
    if(!r.ok) throw new Error(await r.text());
    W = await r.json();
    if(!W || !W.kpi){ whShowState(false); setTimeout(loadWarehouse, 30000); return; }
    whShowState(true);
    renderPO(); renderStock(); renderAdjust(); renderWhAnalytics(); askInit();
  } catch(e){ console.error('warehouse load failed', e); whShowState(false); }
}

/* ── Purchase Orders ── */
function renderPO(){
  if(!W) return;
  document.getElementById('pok-pos').textContent   = whN(W.kpi.pos);
  document.getElementById('pok-recv').textContent  = whN(W.kpi.poReceived);
  document.getElementById('pok-month').textContent = whN(W.kpi.poThisMonth);
  document.getElementById('pok-window').textContent= 'Last '+W.poMonths+' months';
  const ms = W.poMonthly.map(r=>fmtMonShort(r.m));
  if(poChart) poChart.destroy();
  poChart = new Chart(document.getElementById('po-chart'),{ type:'bar',
    data:{ labels:ms, datasets:[{ label:'POs', data:W.poMonthly.map(r=>r.pos), backgroundColor:'rgba(79,142,247,.6)', borderRadius:3 }] },
    options:whChartBase });
  const st = W.poStatus.slice(0,6);
  if(poStatusChart) poStatusChart.destroy();
  poStatusChart = new Chart(document.getElementById('po-status-chart'),{ type:'doughnut',
    data:{ labels:st.map(s=>s.k), datasets:[{ data:st.map(s=>s.v), backgroundColor:WH_PAL, borderColor:'#ffffff', borderWidth:2 }] },
    options:{ responsive:true, maintainAspectRatio:false, plugins:{ legend:{ position:'right', labels:{color:'#52617a',font:{size:10},boxWidth:10} } } } });
  renderPOTable();
}
function renderPOTable(){
  if(!W) return;
  const q=(document.getElementById('po-search')||{value:''}).value.toLowerCase().trim();
  const rows = W.pos.filter(p=> !q || [p.no,p.statusTxt,String(p.status)].some(f=>String(f||'').toLowerCase().includes(q)));
  document.getElementById('bdg-po').textContent = rows.length+' POs';
  document.getElementById('po-tbody').innerHTML = rows.length ? rows.slice(0,600).map(p=>
    '<tr><td><code>'+(p.no||'—')+'</code></td><td>'+(p.created||'—')+'</td><td>'+(p.inDate||'—')+'</td>'+
    '<td style="color:var(--success)">'+(p.recv||'—')+'</td>'+
    '<td><span class="badge '+(/receiv/i.test(p.statusTxt||'')||p.status==='500'?'b-green':'b-warn')+'">'+(p.statusTxt||('status '+p.status))+'</span></td></tr>'
  ).join('') : '<tr><td colspan="5" style="text-align:center;padding:20px;color:var(--muted)">No purchase orders'+(q?' match "'+q+'"':'')+'</td></tr>';
}

/* ── Stock & Articles ── */
const ZONE_COLOR={'Racking':'#2563a8','Staging':'#c2640f','Yard':'#7c5cfc','Thomastown (site bay)':'#1f8a4c','Campbellfield (site bay)':'#d4147a','Other':'#647387','Unallocated':'#aab3c2'};
function renderStock(){
  if(!W) return;
  document.getElementById('stk-skus').textContent   = whN(W.kpi.skus);
  document.getElementById('stk-units').textContent  = whN(W.kpi.totalUnits);
  document.getElementById('stk-items').textContent  = whN(W.kpi.totalItems);
  document.getElementById('stk-groups').textContent = whN(W.kpi.groups);
  document.getElementById('stk-locs').textContent   = whN(W.kpi.locations);
  const g = W.byGroup.slice(0,12);
  if(stkGrpChart) stkGrpChart.destroy();
  stkGrpChart = new Chart(document.getElementById('stk-grp-chart'),{ type:'bar',
    data:{ labels:g.map(x=>x.k), datasets:[{ label:'Units', data:g.map(x=>x.units), backgroundColor:'rgba(31,138,76,.6)', borderRadius:3 }] },
    options:{ ...whChartBase, indexAxis:'y', scales:{ x:{ ticks:{color:'#64748b',font:{size:9}}, grid:{color:'rgba(20,40,80,.07)'}, beginAtZero:true }, y:{ ticks:{color:'#52617a',font:{size:9}}, grid:{display:false} } } } });
  const z = (W.byZone||[]).filter(x=>x.units>0);
  if(stkCatChart) stkCatChart.destroy();
  stkCatChart = new Chart(document.getElementById('stk-zone-chart'),{ type:'doughnut',
    data:{ labels:z.map(x=>x.k), datasets:[{ data:z.map(x=>x.units), backgroundColor:z.map(x=>ZONE_COLOR[x.k]||'#647387'), borderColor:'#ffffff', borderWidth:2 }] },
    options:{ responsive:true, maintainAspectRatio:false, plugins:{ legend:{ position:'right', labels:{color:'#52617a',font:{size:10},boxWidth:10} }, tooltip:{callbacks:{label:c=>c.label+': '+whN(c.raw)+' units'}} } } });
  const sel=document.getElementById('stk-grp'); const cur=sel.value;
  sel.innerHTML='<option value="">All groups</option>'+W.byGroup.map(x=>'<option value="'+x.k.replace(/"/g,'&quot;')+'"'+(x.k===cur?' selected':'')+'>'+x.k+'</option>').join('');
  const zsel=document.getElementById('stk-zone'); const zcur=zsel.value;
  zsel.innerHTML='<option value="">All zones</option>'+(W.byZone||[]).map(x=>'<option value="'+x.k.replace(/"/g,'&quot;')+'"'+(x.k===zcur?' selected':'')+'>'+x.k+'</option>').join('');
  renderLocTable(); renderStockTable();
}
function siteBadge(s){ const cls = s==='Thomastown'?'b-warn':s==='Campbellfield'?'b-blue':'b-muted'; return '<span class="badge '+cls+'">'+esc(s)+'</span>'; }
function renderLocTable(){
  if(!W) return;
  const q=(document.getElementById('loc-search')||{value:''}).value.toLowerCase().trim();
  const rows=(W.byLocation||[]).filter(l=> !q || [l.loc,l.zone,l.site].some(f=>String(f||'').toLowerCase().includes(q)));
  document.getElementById('bdg-loc').textContent = whN(W.kpi.locations)+' locations';
  document.getElementById('stk-loc-tbody').innerHTML = rows.length ? rows.slice(0,200).map(l=>
    '<tr><td><code>'+esc(l.loc)+'</code></td><td style="color:var(--muted)">'+esc(l.zone)+'</td><td>'+siteBadge(l.site)+'</td>'+
    '<td>'+whN(l.skus)+'</td><td style="color:var(--muted)">'+whN(l.items)+'</td>'+
    '<td style="font-weight:600;color:var(--success)">'+whN(l.units)+'</td></tr>'
  ).join('') : '<tr><td colspan="6" style="text-align:center;padding:18px;color:var(--muted)">No locations match</td></tr>';
}
function renderStockTable(){
  if(!W) return;
  const q=(document.getElementById('stk-search')||{value:''}).value.toLowerCase().trim();
  const grp=(document.getElementById('stk-grp')||{value:''}).value;
  const zone=(document.getElementById('stk-zone')||{value:''}).value;
  const rows = W.articles.filter(a=> (!grp||a.grp===grp) && (!zone||a.zone===zone) && (!q || [a.no,a.name,a.sup,a.loc].some(f=>String(f||'').toLowerCase().includes(q))));
  document.getElementById('bdg-stock').textContent = rows.length+' SKUs';
  document.getElementById('stk-tbody').innerHTML = rows.length ? rows.slice(0,120).map(a=>
    '<tr><td><code>'+a.no+'</code></td><td>'+esc(a.name)+'</td><td style="color:var(--muted)">'+esc(a.grp)+'</td>'+
    '<td><code>'+esc(a.loc||'—')+'</code></td><td style="color:var(--muted);font-size:.77rem">'+esc(a.zone||'—')+'</td>'+
    '<td style="color:var(--muted)">'+(a.nLoc||0)+'</td><td style="color:var(--muted)">'+(a.unit||'—')+'</td>'+
    '<td style="font-weight:600;color:var(--success)">'+whN(a.onHand)+'</td></tr>'
  ).join('') : '<tr><td colspan="8" style="text-align:center;padding:20px;color:var(--muted)">No articles'+(q?' match "'+q+'"':'')+'</td></tr>';
}

/* ── Inventory Adjustments ── */
function renderAdjust(){
  if(!W) return;
  document.getElementById('adk-count').textContent = whN(W.kpi.adjustments);
  document.getElementById('adk-pos').textContent   = whN(W.kpi.adjUp);
  document.getElementById('adk-neg').textContent   = whN(W.kpi.adjDown);
  document.getElementById('adk-net').textContent   = (W.kpi.adjNetUnits>=0?'+':'')+whN(W.kpi.adjNetUnits);
  document.getElementById('adk-users').textContent = whN(W.kpi.adjUsers);
  document.getElementById('adk-rate').textContent  = (W.kpi.adjRatePct!=null?(100-W.kpi.adjRatePct).toFixed(1):'—')+'%';
  document.getElementById('adk-rate-sub').textContent = whN(W.kpi.adjArticles)+' of '+whN(W.kpi.skus)+' SKUs adjusted ('+W.invMonths+'mo)';
  document.getElementById('adk-window').textContent= 'Last '+W.invMonths+' months';
  const ms = W.adjMonthly.map(r=>fmtMonShort(r.m));
  if(adjChart) adjChart.destroy();
  adjChart = new Chart(document.getElementById('adj-chart'),{ type:'bar',
    data:{ labels:ms, datasets:[
      { label:'Stock up (+)', data:W.adjMonthly.map(r=>r.pos), backgroundColor:'rgba(54,211,153,.65)', borderRadius:3, stack:'a' },
      { label:'Stock down (−)', data:W.adjMonthly.map(r=>r.neg), backgroundColor:'rgba(248,113,113,.65)', borderRadius:3, stack:'a' }
    ] },
    options:{ ...whChartBase, plugins:{ legend:{display:true, labels:{color:'#52617a',font:{size:10},boxWidth:10}} }, scales:{ x:{ stacked:true, ticks:{color:'#64748b',font:{size:9}}, grid:{color:'rgba(20,40,80,.07)'} }, y:{ stacked:true, ticks:{color:'#64748b',font:{size:10}}, grid:{color:'rgba(20,40,80,.07)'}, beginAtZero:true } } } });
  renderAdjTable();
}
function renderAdjTable(){
  if(!W) return;
  const q=(document.getElementById('adj-search')||{value:''}).value.toLowerCase().trim();
  const dir=(document.getElementById('adj-dir')||{value:''}).value;
  let rows = W.adjustments.filter(a=> !q || [a.art,a.name,a.user,a.comment,a.loc].some(f=>String(f||'').toLowerCase().includes(q)));
  if(dir==='pos') rows=rows.filter(a=>a.qty>=0);
  if(dir==='neg') rows=rows.filter(a=>a.qty<0);
  document.getElementById('bdg-adj').textContent = rows.length+' adjustments';
  document.getElementById('adj-tbody').innerHTML = rows.length ? rows.slice(0,200).map(a=>{
    const up=a.qty>=0; const col=up?'var(--success)':'var(--danger)';
    return '<tr><td style="white-space:nowrap">'+(a.date||'—')+'</td><td><code>'+esc(a.art)+'</code></td>'+
      '<td>'+esc(a.name||'—')+'</td><td style="font-weight:700;color:'+col+'">'+(up?'+':'')+whN(a.qty)+'</td>'+
      '<td>'+esc(a.user)+'</td><td style="color:var(--muted);font-size:.77rem">'+esc(a.loc||'—')+'</td>'+
      '<td style="color:var(--muted);font-size:.75rem;max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(a.comment||'')+(a.byCount?' <span class="badge b-muted">count</span>':'')+'</td></tr>';
  }).join('') : '<tr><td colspan="7" style="text-align:center;padding:20px;color:var(--muted)">No adjustments'+(q?' match "'+q+'"':'')+'</td></tr>';
}

/* ── Warehouse Analytics ── */
function renderWhAnalytics(){
  if(!W) return;
  document.getElementById('whk-skus').textContent  = whN(W.kpi.skus);
  document.getElementById('whk-units').textContent = whN(W.kpi.totalUnits);
  document.getElementById('whk-poin').textContent  = whN(W.kpi.pos);
  document.getElementById('whk-po-lbl').textContent= 'Purchase Orders ('+W.poMonths+'mo)';
  document.getElementById('whk-adj').textContent   = whN(W.kpi.adjustments);
  document.getElementById('whk-adjrate').textContent = (W.kpi.adjRatePct!=null?(100-W.kpi.adjRatePct).toFixed(1):'—')+'%';
  document.getElementById('whk-adjrate-sub').textContent = whN(W.kpi.adjArticles)+' of '+whN(W.kpi.skus)+' SKUs adjusted · '+W.invMonths+'mo';
  // receipts vs adjustments by month (align last 6)
  const poMap={}; W.poMonthly.forEach(r=>poMap[r.m]=r.pos);
  const adjMap={}; W.adjMonthly.forEach(r=>adjMap[r.m]=r.pos+r.neg);
  const months = W.adjMonthly.map(r=>r.m).slice(-8);
  if(whFlowChart) whFlowChart.destroy();
  whFlowChart = new Chart(document.getElementById('wh-flow-chart'),{ type:'bar',
    data:{ labels:months.map(fmtMonShort), datasets:[
      { label:'PO receipts', data:months.map(m=>poMap[m]||0), backgroundColor:'rgba(79,142,247,.6)', borderRadius:3 },
      { label:'Adjustments', data:months.map(m=>adjMap[m]||0), backgroundColor:'rgba(245,158,11,.6)', borderRadius:3 }
    ] },
    options:{ ...whChartBase, plugins:{ legend:{display:true, labels:{color:'#52617a',font:{size:10},boxWidth:10}} } } });
  const top = W.articles.slice(0,12);
  if(whTopChart) whTopChart.destroy();
  whTopChart = new Chart(document.getElementById('wh-top-chart'),{ type:'bar',
    data:{ labels:top.map(a=>a.no), datasets:[{ label:'On hand', data:top.map(a=>a.onHand), backgroundColor:'rgba(54,211,153,.6)', borderRadius:3 }] },
    options:{ ...whChartBase, indexAxis:'y', scales:{ x:{ ticks:{color:'#64748b',font:{size:9}}, grid:{color:'rgba(20,40,80,.07)'}, beginAtZero:true }, y:{ ticks:{color:'#52617a',font:{size:9}}, grid:{display:false} } } } });
  const tot = W.byGroup.reduce((s,x)=>s+x.units,0)||1;
  document.getElementById('wh-grp-tbody').innerHTML = W.byGroup.slice(0,25).map(x=>
    '<tr><td>'+esc(x.k)+'</td><td>'+whN(x.n)+'</td><td style="color:var(--success);font-weight:600">'+whN(x.units)+'</td>'+
    '<td style="color:var(--muted)">'+(x.units/tot*100).toFixed(1)+'%</td></tr>').join('');
  document.getElementById('wh-built').textContent = 'Warehouse snapshot built '+fd(W.builtAt)+' — refreshes twice a day (06:00 & 18:00 UTC) from Ongoing WMS.';
}

function fmtMonShort(k){ if(!k) return '—'; const [y,m]=k.split('-'); return new Date(y,m-1,1).toLocaleDateString('en-AU',{month:'short',year:'2-digit'}); }
function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

/* ═══ ASK — SPARK NEL warehouse assistant (goods owner 93; from live /api/warehouse) ═══ */
var SP_STOP = new Set('THE A AN IS ARE HOW MANY MUCH WHERE WHAT LIST SHOW WHICH IN ON OF FOR ME GET ALL ARTICLE ARTICLES SKU SKUS STOCK UNIT UNITS HAND LEVEL COUNT NUMBER GROUP ZONE LOCATION WITH AND TOTAL HERE ITEM ITEMS WHATS DO WE HAVE THERE'.split(' '));
function spFind(q){
  if(!W) return null;
  var up=q.toUpperCase();
  var toks=up.match(/[A-Z0-9][A-Z0-9\\-\\/\\.]{2,}/g)||[];
  var byNo=new Map(); W.articles.forEach(function(a){ byNo.set(String(a.no).toUpperCase(),a); });
  for(var i=0;i<toks.length;i++){ if(byNo.has(toks[i])) return {art:byNo.get(toks[i])}; }
  for(var j=0;j<toks.length;j++){ var t=toks[j];
    if(SP_STOP.has(t)||!/[0-9]/.test(t)) continue;
    var hits=W.articles.filter(function(a){ return String(a.no).toUpperCase().indexOf(t)>=0; });
    if(hits.length===1) return {art:hits[0]};
    if(hits.length>1) return {matches:hits.slice(0,12),token:t,more:hits.length};
  }
  return null;
}
function spOneOf(q,field){ var up=' '+q.toUpperCase()+' ';
  var vals=[...new Set(W.articles.map(function(a){return a[field];}).filter(Boolean))].sort(function(a,b){return b.length-a.length;});
  for(var i=0;i<vals.length;i++){ if(up.indexOf(vals[i].toUpperCase())>=0) return vals[i]; } return null; }
function spArtInfo(a){
  return '🔧 <b>'+esc(a.no)+'</b> — '+esc(a.name)+'.<br>📍 Location <b>'+esc(a.loc||'—')+'</b>'+(a.zone?' · zone '+esc(a.zone):'')+(a.grp?' · group '+esc(a.grp):'')+(a.nLoc>1?' · '+a.nLoc+' locations':'')+'.<br>📦 On hand <b>'+whN(a.onHand)+'</b>'+(a.unit?' '+esc(a.unit):' units')+(a.sup?' · supplier '+esc(a.sup):'')+'.';
}
function spArtTable(rows,limit){
  var N=limit||15, shown=rows.slice(0,N);
  var h='<table><thead><tr><th>Article</th><th>Description</th><th>Group</th><th>Location</th><th>Zone</th><th class="num">On hand</th></tr></thead><tbody>';
  h+=shown.map(function(a){ return '<tr><td>'+esc(a.no)+'</td><td>'+esc((a.name||'').slice(0,40))+'</td><td>'+esc(a.grp||'')+'</td><td>'+esc(a.loc||'')+'</td><td>'+esc(a.zone||'')+'</td><td class="num">'+whN(a.onHand)+'</td></tr>'; }).join('');
  h+='</tbody></table>';
  if(rows.length>N) h+='<div style="margin-top:6px;color:var(--muted)">…and '+whN(rows.length-N)+' more — add a group, zone or location.</div>';
  return h;
}
function spTwoCol(title,rows,c1,c2){
  return '<b>'+title+'</b><table><thead><tr><th>'+c1+'</th><th class="num">'+c2+'</th></tr></thead><tbody>'+
    rows.map(function(r){ return '<tr><td>'+esc(r.k)+'</td><td class="num">'+whN(r.units)+'</td></tr>'; }).join('')+'</tbody></table>';
}
function spAnswer(q){
  var up=q.toUpperCase().trim();
  if(!up||/^(HELP|EXAMPLES?|WHAT CAN|\\?)/.test(up)) return spHelp();
  if(!W || !W.kpi) return 'The warehouse data is still loading from Ongoing — give it a few seconds and try again.';
  var wantWhere=/\\bWHERE\\b/.test(up);
  var wantStock=/ON HAND|IN STOCK|STOCK LEVEL|HOW MUCH|HOW MANY.*(ON HAND|LEFT)/.test(up);
  var wantCount=/\\bHOW MANY\\b|\\bCOUNT\\b|\\bNUMBER OF\\b/.test(up);
  var wantList=/\\bLIST\\b|\\bSHOW\\b|\\bWHICH\\b|WHAT.?S IN/.test(up);
  var wantPO=/PURCHASE ORDER|\\bPO\\b|\\bPOS\\b|RECEIPT|RECEIVED/.test(up);
  var wantAdj=/ADJUSTMENT|ADJUST|CYCLE COUNT/.test(up);

  if(wantPO && (wantCount||/HOW MANY/.test(up))) return '📥 <b>'+whN(W.kpi.pos)+'</b> purchase orders ('+whN(W.kpi.poReceived)+' received, '+whN(W.kpi.poThisMonth)+' this month).';
  if(wantAdj && (wantCount||/HOW MANY/.test(up))) return '🎯 <b>'+whN(W.kpi.adjustments)+'</b> stock adjustments ('+whN(W.kpi.adjUp)+' up, '+whN(W.kpi.adjDown)+' down; net '+(W.kpi.adjNetUnits>=0?'+':'')+whN(W.kpi.adjNetUnits)+' units).';

  var found=spFind(q);
  if(found && found.matches) return 'Found '+found.more+' articles matching “'+esc(found.token)+'”. Which one?'+spArtTable(found.matches,12);
  if(found && found.art && !wantCount && !wantList){
    var a=found.art;
    if(wantWhere) return '📍 <b>'+esc(a.no)+'</b> ('+esc(a.name)+') is at <b>'+esc(a.loc||'—')+'</b>'+(a.zone?' ('+esc(a.zone)+')':'')+' — '+whN(a.onHand)+' on hand'+(a.nLoc>1?' across '+a.nLoc+' locations':'')+'.';
    if(wantStock) return '📦 <b>'+esc(a.no)+'</b> ('+esc(a.name)+') — <b>'+whN(a.onHand)+'</b>'+(a.unit?' '+esc(a.unit):' units')+' on hand'+(a.loc?' at '+esc(a.loc):'')+'.';
    return spArtInfo(a);
  }

  var grp=spOneOf(q,'grp'), zone=spOneOf(q,'zone'), loc=spOneOf(q,'loc');
  var rows=W.articles.filter(function(a){ return (!grp||a.grp===grp)&&(!zone||a.zone===zone)&&(!loc||a.loc===loc); });
  var lbl=[grp,zone,loc].filter(Boolean).join(' · ')||'all SKUs';
  var filtered=grp||zone||loc;

  if((wantStock||/UNIT/.test(up)) && filtered){
    if(zone){ var zr=(W.byZone||[]).find(function(z){return z.k===zone;}); var zn=W.articles.filter(function(a){return a.zone===zone;}).length; if(zr) return '📦 <b>'+whN(zr.units)+'</b> units on hand in zone <b>'+esc(zone)+'</b> ('+whN(zn)+' SKUs based here).'; }
    if(loc){ var lr=(W.byLocation||[]).find(function(l){return l.loc===loc;}); if(lr) return '📦 <b>'+whN(lr.units)+'</b> units at location <b>'+esc(loc)+'</b> ('+whN(lr.skus)+' SKUs · zone '+esc(lr.zone)+').'; }
    if(grp){ var gr=(W.byGroup||[]).find(function(g){return g.k===grp;}); if(gr) return '📦 <b>'+whN(gr.units)+'</b> units on hand in group <b>'+esc(grp)+'</b> ('+whN(gr.n)+' SKUs).'; }
    var u=rows.reduce(function(s,a){return s+(a.onHand||0);},0); return '📦 <b>'+whN(u)+'</b> units on hand across <b>'+whN(rows.length)+'</b> SKUs ('+esc(lbl)+').';
  }
  if(wantList && filtered) return '<b>'+whN(rows.length)+'</b> SKUs — '+esc(lbl)+':'+spArtTable(rows);
  if(wantCount){
    if(!filtered){
      if(/UNIT/.test(up)) return '📦 <b>'+whN(W.kpi.totalUnits)+'</b> units on hand across <b>'+whN(W.kpi.skus)+'</b> SKUs.';
      if(/ZONE/.test(up)) return spTwoCol((W.byZone||[]).length+' zones:',(W.byZone||[]).filter(function(z){return z.units>0;}),'Zone','Units');
      if(/GROUP/.test(up)) return spTwoCol((W.byGroup||[]).length+' product groups:',W.byGroup.slice(0,20),'Group','Units');
      if(/LOCATION/.test(up)) return '📍 <b>'+whN(W.kpi.locations)+'</b> storage locations across '+whN((W.byZone||[]).length)+' zones.';
      return '<b>'+whN(W.kpi.skus)+'</b> SKUs · <b>'+whN(W.kpi.totalUnits)+'</b> units on hand across '+whN(W.kpi.locations)+' locations.';
    }
    return '<b>'+whN(rows.length)+'</b> SKUs — '+esc(lbl)+'.';
  }
  if(/UNITS? BY ZONE/.test(up)) return spTwoCol('Units by zone:',(W.byZone||[]).filter(function(z){return z.units>0;}),'Zone','Units');
  if(/UNITS? BY GROUP/.test(up)) return spTwoCol('Units by group:',W.byGroup.slice(0,20),'Group','Units');
  if(filtered) return '<b>'+whN(rows.length)+'</b> SKUs — '+esc(lbl)+':'+spArtTable(rows);

  var kws=(up.match(/[A-Z0-9]{3,}/g)||[]).filter(function(t){return !SP_STOP.has(t);});
  if(kws.length){ var hits=W.articles.filter(function(a){ return kws.every(function(kw){ return [a.no,a.name,a.grp,a.sup].some(function(v){ return String(v||'').toUpperCase().indexOf(kw)>=0; }); }); });
    if(hits.length) return 'Found <b>'+whN(hits.length)+'</b> SKUs matching “'+esc(kws.join(' '))+'”:'+spArtTable(hits); }
  return 'I could not match that. Try <i>help</i> — I can find articles, locations, stock on hand, counts by group / zone / location, plus purchase orders and adjustments.';
}
function spHelp(){
  var zone=(W&&W.byZone&&W.byZone.find(function(z){return z.units>0;}))?W.byZone.find(function(z){return z.units>0;}).k:'Racking';
  var grp=(W&&W.byGroup&&W.byGroup[0])?W.byGroup[0].k:'a group';
  return 'I answer from the live warehouse data (goods owner 93) — try:'+
    '<ul style="margin:8px 0 0 18px;padding:0;line-height:1.7">'+
    '<li><i>where is &lt;article no&gt;</i></li>'+
    '<li><i>how much stock of &lt;article no&gt;</i></li>'+
    '<li><i>how many units on hand</i> · <i>how many units in '+esc(zone)+'</i></li>'+
    '<li><i>how many units in '+esc(grp)+'</i></li>'+
    '<li><i>units by zone</i> · <i>units by group</i></li>'+
    '<li><i>how many purchase orders</i> · <i>how many adjustments</i></li></ul>';
}
function askPush(who,html){ var log=document.getElementById('askLog'); if(!log)return; var d=document.createElement('div'); d.className='ask-msg '+who; d.innerHTML='<div class="ask-bubble">'+html+'</div>'; log.appendChild(d); log.scrollTop=log.scrollHeight; }
function askSubmit(){ var inp=document.getElementById('askInput'); var q=(inp.value||'').trim(); if(!q)return; askPush('you',esc(q)); var a; try{a=spAnswer(q);}catch(e){a='Sorry — I could not work that one out. Try <i>help</i>.';console.error(e);} askPush('bot',a); inp.value=''; inp.focus(); }
function askAsk(t){ var inp=document.getElementById('askInput'); if(!inp)return; inp.value=t; askSubmit(); }
function askInit(){
  var el=document.getElementById('askChips'); if(!el)return;
  var zone=(W&&W.byZone&&W.byZone.find(function(z){return z.units>0;}))?W.byZone.find(function(z){return z.units>0;}).k:'Racking';
  var sample=(W&&W.articles&&W.articles[0])?W.articles[0].no:'';
  var ex=[sample?('Where is '+sample):'Where is an article','How many units on hand','How many units in '+zone,'Units by group','How many purchase orders','How many adjustments'];
  el.innerHTML=ex.map(function(e){ return '<span class="ask-chip" onclick="askAsk(this.textContent)">'+esc(e)+'</span>'; }).join('');
  var log=document.getElementById('askLog'); if(log && !log.childNodes.length) askPush('bot',spHelp());
}

load();
loadWarehouse();
askInit();
<\/script>
</body>
</html>`;

// ── HTTP Server ───────────────────────────────────────────────────────────────
const cfg = loadConfig();

function readBody(req) {
  return new Promise((ok, fail) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try { ok(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { fail(new Error('Invalid JSON: ' + e.message)); }
    });
    req.on('error', fail);
  });
}

// ── access gate (code only; ACCESS_CODE in env, fail-closed if unset) ──────────
const ACCESS_CODE = process.env.ACCESS_CODE || '';
const GATE_SECRET = process.env.GATE_SECRET || 'spark-gate-2026';
const GATE_TOKEN  = crypto.createHash('sha256').update(ACCESS_CODE + '|' + GATE_SECRET).digest('hex');
const GATE_COOKIE = 'spark_gate';
function gateCookie(req){ for(const p of (req.headers.cookie||'').split(';')){ const i=p.indexOf('='); if(i>0 && p.slice(0,i).trim()===GATE_COOKIE) return p.slice(i+1).trim(); } return ''; }
function gateLoginHtml(error){
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SPARK NEL Dashboard</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:"Segoe UI",system-ui,sans-serif;background:#f4f6f9;color:#222;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:16px}
.box{background:#fff;border-radius:12px;box-shadow:0 6px 28px rgba(0,0,0,.14);width:380px;max-width:94vw;overflow:hidden}.hd{background:#1a2340;color:#fff;padding:22px 24px}.hd h1{font-size:16px;font-weight:700;line-height:1.3}
.bd{padding:22px 24px}.bd p{font-size:13px;color:#667;margin-bottom:16px}label{font-size:12px;font-weight:600;color:#445;display:block;margin-bottom:6px}
input{width:100%;padding:11px 12px;border:1px solid #dde2eb;border-radius:8px;font-size:15px}input:focus{outline:none;border-color:#0066cc;box-shadow:0 0 0 3px rgba(0,102,204,.15)}
button{width:100%;margin-top:16px;padding:12px;border:none;border-radius:8px;background:#0066cc;color:#fff;font-size:14px;font-weight:700;cursor:pointer}button:hover{background:#0055aa}.err{color:#cc2222;font-size:13px;font-weight:600;margin-top:12px;min-height:18px}</style></head>
<body><form class="box" method="POST" action="/login"><div class="hd"><h1>&#x1F69A; SPARK NEL &mdash; Ongoing Dashboard</h1></div>
<div class="bd"><p>Enter the access code to open the dashboard.</p><label for="code">Access code</label>
<input id="code" name="code" type="password" autofocus autocomplete="off" placeholder="Access code"><button type="submit">Open dashboard</button>
<div class="err">${error ? 'Incorrect code &mdash; please try again.' : ''}</div></div></form></body></html>`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── gate: health open; handle login/logout; everything else needs the cookie ──
  if (url.pathname === '/health' || url.pathname === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); return; }
  if (url.pathname === '/login' && req.method === 'POST') {
    let raw = ''; req.on('data', c => raw += c); await new Promise(r => req.on('end', r));
    const code = new URLSearchParams(raw).get('code') || '';
    if (ACCESS_CODE && code === ACCESS_CODE) {
      res.writeHead(302, { 'Set-Cookie': `${GATE_COOKIE}=${GATE_TOKEN}; HttpOnly; Path=/; Max-Age=43200; SameSite=Lax`, 'Location': '/' });
      return res.end();
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(gateLoginHtml(true));
  }
  if (url.pathname === '/logout') {
    res.writeHead(302, { 'Set-Cookie': `${GATE_COOKIE}=; HttpOnly; Path=/; Max-Age=0`, 'Location': '/' }); return res.end();
  }
  if (gateCookie(req) !== GATE_TOKEN) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(gateLoginHtml(false));
  }

  try {
    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');

    } else if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(HTML);

    } else if (url.pathname === '/api/data') {
      if (!cfg) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'WMS credentials not configured. Set WMS_USERNAME and WMS_PASSWORD environment variables in Railway.' }));
        return;
      }
      const force = url.searchParams.get('refresh') === '1';
      const data = getDataFast(cfg, force);              // never blocks on the WMS fetch
      if (!data) { res.writeHead(202, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ building: true })); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));

    } else if (url.pathname === '/api/warehouse') {
      if (!warehouseCache) { res.writeHead(202, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ building: true })); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(warehouseCache));

    } else if (url.pathname === '/api/transport') {
      if (req.method === 'POST') {
        const body = await readBody(req);
        saveTransport(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } else {
        const t = loadTransport();
        res.writeHead(t ? 200 : 204, { 'Content-Type': 'application/json' });
        res.end(t ? JSON.stringify(t) : '');
      }

    } else if (url.pathname === '/api/contract') {
      if (req.method === 'POST') {
        const body = await readBody(req);
        saveContract(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(loadContract()));
      }

    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  } catch (err) {
    console.error('[Server error]', err.message);
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Error: ' + err.message);
  }
});

const host = process.env.RAILWAY_ENVIRONMENT ? '0.0.0.0' : '127.0.0.1';
server.listen(PORT, host, () => {
  console.log('');
  console.log('  SPARK NEL Dashboard');
  console.log(`  → http://localhost:${PORT}`);
  console.log('');
  if (!process.env.PORT) console.log('  Press Ctrl+C to stop.\n');

  // Orders: serve the persisted cache; rebuild on startup only if it's stale; then refresh twice a day (NOT on page-open)
  if (cfg) {
    loadOrdersFile();
    if (!cache || Date.now() - cacheTime >= WAREHOUSE_REFRESH) refreshOrders(cfg).then(() => console.log('[Orders] primed on startup.')).catch(() => {});
    scheduleDaily(REFRESH_HOURS_UTC, () => refreshOrders(cfg));
  }

  // Build the warehouse snapshot in the background (heavy WMS pulls; refreshes twice a day at 06:00 & 18:00 UTC)
  if (cfg) scheduleWarehouse(cfg);
});
