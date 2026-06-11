'use strict';
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

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

// ── Constants ────────────────────────────────────────────────────────────────
const PORT          = 3456;
const GOODS_OWNER   = 93;
const WMS_HOST      = 'api.ongoingsystems.se';
const WMS_PATH      = '/BWSBNE/automation.asmx';
const WMS_NS        = 'http://ongoingsystems.se/Automation';
const CACHE_TTL     = 5 * 60 * 1000;
const CONFIG_FILE   = path.join(__dirname, 'spark_nel_config.json');
const CONTRACT_FILE   = path.join(__dirname, 'spark_nel_contract.json');
const TRANSPORT_FILE  = path.join(__dirname, 'transport_data.json');

// ── Config / Contract ────────────────────────────────────────────────────────
function loadConfig() {
  // Prefer environment variables (Railway / cloud hosting)
  if (process.env.WMS_USERNAME && process.env.WMS_PASSWORD) {
    return { username: process.env.WMS_USERNAME, password: process.env.WMS_PASSWORD };
  }
  // Fall back to local config file
  if (!fs.existsSync(CONFIG_FILE)) {
    console.error(`
  No credentials found. Either:
    Set env vars WMS_USERNAME and WMS_PASSWORD, OR
    Create ${CONFIG_FILE} with: { "username": "...", "password": "..." }
`);
    process.exit(1);
  }
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (e) {
    console.error('Invalid JSON in config file:', e.message);
    process.exit(1);
  }
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

// ── Cache ────────────────────────────────────────────────────────────────────
let cache     = null;
let cacheTime = 0;

async function getData(cfg, force = false) {
  if (!force && cache && Date.now() - cacheTime < CACHE_TTL) return cache;
  const orders = await fetchOrders(cfg);
  cache     = processOrders(orders);
  cacheTime = Date.now();
  return cache;
}

// ── Dashboard HTML ───────────────────────────────────────────────────────────
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
  --bg:#0f1117;--surface:#1a1d27;--surface2:#22263a;--border:#2e3348;
  --accent:#4f8ef7;--accent2:#7c5cfc;--success:#36d399;--danger:#f87171;
  --warning:#f59e0b;--text:#e2e8f0;--muted:#64748b;--radius:10px;
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
.btn:hover{background:#2a3050}
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
td{padding:7px 10px;border-bottom:1px solid rgba(255,255,255,.04);vertical-align:middle}
tr:last-child td{border-bottom:none}
tr:hover td{background:rgba(255,255,255,.02)}
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
.a-error{background:rgba(248,113,113,.07);border:1px solid rgba(248,113,113,.25);color:#fca5a5}
.a-ok{background:rgba(54,211,153,.07);border:1px solid rgba(54,211,153,.25);color:var(--success)}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
.spinning{animation:spin .7s linear infinite}
.pulsing{animation:pulse 1.2s ease-in-out infinite}
::-webkit-scrollbar{width:5px;height:5px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px}
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
  <div class="tab"         onclick="showTab('orders',this)">Orders</div>
  <div class="tab"         onclick="showTab('contract',this)">Freight Contract</div>
  <div class="tab"         onclick="showTab('transport',this)">Transport</div>
  <div class="tab"         onclick="showTab('invoicing',this)">Invoicing</div>
  <div class="tab"         onclick="showTab('summaries',this)">Summaries</div>
</div>

<div id="alert-box"></div>

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
</div>

<!-- ═══ TRANSPORT ════════════════════════════════════════════════════════════ -->
<div id="tab-transport" style="display:none">
  <div id="tp-empty" class="placeholder">
    <h3>Transport Register</h3>
    <p>Upload <strong>Transport Register- NEL.xlsx</strong> to link transport bookings to WMS orders.</p>
    <label class="btn btn-accent" style="display:inline-block;margin-top:16px;cursor:pointer">
      Upload xlsx<input type="file" accept=".xlsx" style="display:none" onchange="handleTransportUpload(event)">
    </label>
  </div>
  <div id="tp-data" style="display:none">
    <div class="kpi-row">
      <div class="kpi"><div class="kpi-label">Total Trips</div><div class="kpi-val" id="tk-trips" style="color:var(--accent)">—</div><div class="kpi-sub">Transport bookings</div></div>
      <div class="kpi"><div class="kpi-label">Total Cost</div><div class="kpi-val" id="tk-cost" style="color:var(--danger)">—</div><div class="kpi-sub">ACC Buy (ex GST)</div></div>
      <div class="kpi"><div class="kpi-label">Total Revenue</div><div class="kpi-val" id="tk-sell" style="color:var(--success)">—</div><div class="kpi-sub">ACC Sell (ex GST)</div></div>
      <div class="kpi"><div class="kpi-label">Profit</div><div class="kpi-val" id="tk-profit" style="color:var(--accent2)">—</div><div class="kpi-sub">Revenue minus cost</div></div>
    </div>
    <div class="section">
      <div class="sec-hdr">
        <span class="sec-title">Transport Bookings</span>
        <div style="display:flex;gap:8px;align-items:center">
          <span class="badge b-blue" id="bdg-transport">—</span>
          <label class="btn" style="cursor:pointer;font-size:.76rem;padding:5px 12px">Re-upload<input type="file" accept=".xlsx" style="display:none" onchange="handleTransportUpload(event)"></label>
        </div>
      </div>
      <div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;align-items:center">
        <input type="text" id="tf-search" placeholder="Search date, order, client, type, invoice, comments…" oninput="renderTransport()" style="max-width:340px;font-size:.78rem">
        <select id="tf-supplier" onchange="renderTransport()" style="width:auto;font-size:.78rem;padding:5px 10px"></select>
        <select id="tf-linked" onchange="renderTransport()" style="width:auto;font-size:.78rem;padding:5px 10px">
          <option value="">All bookings</option>
          <option value="linked">Linked to WMS order</option>
          <option value="unlinked">No WMS link</option>
        </select>
      </div>
      <div class="tbl-scroll">
        <table>
          <thead><tr><th>Date</th><th>WMS Order</th><th>Client</th><th>Vehicle Type</th><th>Supplier</th><th>Invoice</th><th>ACC Buy</th><th>ACC Sell</th><th>Profit $</th><th>Comments</th></tr></thead>
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
      <select id="inv-supplier" onchange="renderInvoicing()" style="width:auto;font-size:.78rem;padding:5px 10px"><option value="">All suppliers</option></select>
    </div>
    <div class="section">
      <div class="sec-hdr"><span class="sec-title">Invoice Register</span><span class="badge b-blue" id="bdg-invoices">—</span></div>
      <div class="tbl-scroll">
        <table>
          <thead><tr><th>Invoice #</th><th>Date</th><th>WMS Order</th><th>Client</th><th>Supplier</th><th>ACC Buy</th><th>ACC Sell</th><th>Profit $</th><th>Margin</th><th>Comments</th></tr></thead>
          <tbody id="inv-tbody"></tbody>
        </table>
      </div>
    </div>
    <div class="section">
      <div class="sec-hdr"><span class="sec-title">Uninvoiced Jobs</span><span class="badge b-warn" id="bdg-uninv">—</span></div>
      <div class="tbl-scroll">
        <table>
          <thead><tr><th>Date</th><th>WMS Order</th><th>Client</th><th>Supplier</th><th>ACC Buy</th><th>ACC Sell</th><th>Comments</th></tr></thead>
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

</div><!-- /container -->
<script>
let D = null, T = null, period = 'weekly', trendChart = null, moChart = null;

const chartBase = {
  responsive:true, maintainAspectRatio:false,
  plugins:{ legend:{ display:false } },
  scales:{
    x:{ ticks:{color:'#64748b',font:{size:10}}, grid:{color:'rgba(255,255,255,.05)'} },
    y:{ ticks:{color:'#64748b',font:{size:10},stepSize:1}, grid:{color:'rgba(255,255,255,.05)'}, beginAtZero:true }
  }
};

function fd(s){ if(!s) return '—'; return new Date(s).toLocaleDateString('en-AU',{day:'2-digit',month:'short',year:'numeric'}); }
function setDot(s){ const d=document.getElementById('dot'); d.className='dot'+(s==='spin'?' spin-state pulsing':s==='err'?' err':''); }
function showAlert(msg,type){ document.getElementById('alert-box').innerHTML='<div class="alert a-'+(type||'ok')+'">'+msg+'</div>'; }
function clearAlert(){ document.getElementById('alert-box').innerHTML=''; }

async function load(force){
  setDot('spin');
  document.getElementById('sync-lbl').textContent='Loading…';
  clearAlert();
  try{
    const r = await fetch('/api/data'+(force?'?refresh=1':''));
    if(!r.ok) throw new Error(await r.text());
    D = await r.json();
    render();
    setDot('ok');
    document.getElementById('sync-lbl').textContent='Last sync: '+fd(D.lastFetch);
    const cr = await fetch('/api/contract');
    renderContract(await cr.json());
    const tr = await fetch('/api/transport');
    if(tr.status===200){ T = await tr.json(); renderTransport(); renderInvoicing(); renderSummaries(); }
  } catch(e){
    setDot('err');
    showAlert('Failed to load data: '+e.message,'error');
    document.getElementById('sync-lbl').textContent='Load failed';
  }
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
  renderTrend(); renderMo(); renderMoTable(); renderOrderTables();
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
    options:{ ...chartBase, plugins:{ legend:{ display:true, labels:{ color:'#94a3b8', font:{size:10}, boxWidth:10 } } } }
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
  if(!c) return;
  document.getElementById('c-carrier').value = c.carrier||'';
  document.getElementById('c-service').value = c.service||'';
  document.getElementById('c-cno').value     = c.contractNumber||'';
  document.getElementById('c-eff').value     = c.effectiveDate||'';
  document.getElementById('c-exp').value     = c.expiryDate||'';
  document.getElementById('c-acct').value    = c.accountCode||'';
  document.getElementById('c-notes').value   = c.notes||'';
  document.getElementById('rates-tbody').innerHTML='';
  (c.rates||[]).forEach(r=>addRateRow(r));
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
    rates
  };
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
  ['overview','orders','contract','transport','invoicing','summaries'].forEach(t=>{
    document.getElementById('tab-'+t).style.display = t===name ? '' : 'none';
  });
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
  el.classList.add('active');
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
      T = parsed; renderTransport(); renderInvoicing(); renderSummaries();
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
    accBuy:   parseFloat(r[ci('ACC Buy')])||0,
    accSell:  parseFloat(r[ci('ACC Sell')])||0,
    comments: String(r[ci('Comments')]||'').trim(),
  }));
  return {bookings, uploadedAt:new Date().toISOString()};
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
  const suppliers = ['All suppliers',...new Set(bk.map(b=>b.supplier).filter(Boolean))].sort((a,b)=>a==='All suppliers'?-1:1);
  const sfEl = document.getElementById('tf-supplier');
  const curSup = sfEl.value;
  sfEl.innerHTML = suppliers.map(s=>'<option value="'+(s==='All suppliers'?'':s)+'"'+(s===curSup||(!curSup&&s==='All suppliers')?' selected':'')+'>'+s+'</option>').join('');
  const supFilter  = cur('tf-supplier');
  const linkFilter = cur('tf-linked');
  const searchQ    = (document.getElementById('tf-search')||{value:''}).value.toLowerCase().trim();
  const orderMap   = buildOrderMap();
  let filtered = bk;
  if(supFilter)              filtered = filtered.filter(b=>b.supplier===supFilter);
  if(linkFilter==='linked')  filtered = filtered.filter(b=>b.orderId&&orderMap[String(b.orderId)]);
  if(linkFilter==='unlinked')filtered = filtered.filter(b=>!b.orderId||!orderMap[String(b.orderId)]);
  if(searchQ) filtered = filtered.filter(b=>[b.date,String(b.orderId||''),b.spark,b.site,b.type,b.invoice,b.comments,b.supplier].some(f=>String(f||'').toLowerCase().includes(searchQ)));
  document.getElementById('bdg-transport').textContent = filtered.length+' bookings';
  const sorted = [...filtered].sort((a,b)=>(b.date||'').localeCompare(a.date||''));
  const tb = document.getElementById('transport-tbody');
  tb.innerHTML = sorted.length ? sorted.map(b=>{
    const wms = b.orderId&&orderMap[String(b.orderId)];
    const prof = b.accSell-b.accBuy;
    const pc   = prof>0?'var(--success)':prof<0?'var(--danger)':'var(--muted)';
    return '<tr>'+
      '<td style="white-space:nowrap">'+(b.date||'—')+'</td>'+
      '<td>'+(b.orderId?'<code style="'+(wms?'color:var(--success)':'opacity:.55')+'">'+b.orderId+'</code>'+(wms?' <span style="color:var(--muted);font-size:.72em">'+(wms.externalId||'')+'</span>':''):'—')+'</td>'+
      '<td>'+(b.spark||'—')+'</td>'+
      '<td style="color:var(--muted);font-size:.77rem">'+(b.type||'—')+'</td>'+
      '<td><span class="badge b-blue">'+(b.supplier||'—')+'</span></td>'+
      '<td>'+(b.invoice?'<code>'+b.invoice+'</code>':'<span style="color:var(--muted)">—</span>')+'</td>'+
      '<td style="color:var(--danger)">'+(b.accBuy?fmtMoney(b.accBuy):'—')+'</td>'+
      '<td style="color:var(--success)">'+(b.accSell?fmtMoney(b.accSell):'—')+'</td>'+
      '<td style="color:'+pc+'">'+(b.accBuy||b.accSell?(prof>=0?'':'-')+fmtMoney(prof):'—')+'</td>'+
      '<td style="color:var(--muted);font-size:.75rem;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+(b.comments||'')+'</td>'+
    '</tr>';
  }).join('') : '<tr><td colspan="10" style="text-align:center;padding:20px;color:var(--muted)">No bookings match filter</td></tr>';
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
  const invQ   = (document.getElementById('inv-search')||{value:''}).value.toLowerCase().trim();
  const invSup = (document.getElementById('inv-supplier')||{value:''}).value;
  function matchInv(b){
    if(invSup && b.supplier!==invSup) return false;
    if(!invQ) return true;
    return [b.invoice,b.date,String(b.orderId||''),b.spark,b.supplier,b.comments].some(f=>String(f||'').toLowerCase().includes(invQ));
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
    return '<tr>'+
      '<td><code>'+b.invoice+'</code></td>'+
      '<td style="white-space:nowrap">'+(b.date||'—')+'</td>'+
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
    return '<tr>'+
      '<td style="white-space:nowrap">'+(b.date||'—')+'</td>'+
      '<td>'+wmsCell(b)+'</td>'+
      '<td>'+(b.spark||'—')+'</td>'+
      '<td><span class="badge b-blue">'+(b.supplier||'—')+'</span></td>'+
      '<td style="color:var(--danger)">'+(b.accBuy?fmtMoney(b.accBuy):'—')+'</td>'+
      '<td style="color:var(--success)">'+(b.accSell?fmtMoney(b.accSell):'—')+'</td>'+
      '<td style="color:var(--muted);font-size:.75rem">'+(b.comments||'').slice(0,60)+'</td>'+
    '</tr>';
  }).join('') : '<tr><td colspan="7" style="text-align:center;padding:20px;color:var(--muted)">All jobs are invoiced</td></tr>';
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

load();
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  try {
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(HTML);

    } else if (url.pathname === '/api/data') {
      const force = url.searchParams.get('refresh') === '1';
      console.log(force ? '[WMS] Force-fetching orders…' : '[WMS] Serving cached data…');
      const data = await getData(cfg, force);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));

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

  // Pre-warm cache so first visitor doesn't wait for the 28MB WMS fetch
  getData(cfg).then(() => console.log('[WMS] Cache primed on startup.')).catch(e => console.error('[WMS] Startup fetch failed:', e.message));
});
