// ============================================================
// DairyBliss Backend — Google Apps Script
// ============================================================

const TELEGRAM_TOKEN   = '***REMOVED***';
const TELEGRAM_CHAT_ID = '-5080336839';
const SHEET_ID         = '12GmEb14sM0YC40TkpeyK2eBF2VxKPniCskIMzAWD-P0';

const BLOCK_KG        = 3;     // stock bought in 3 kg blocks
const ALERT_BEFORE_KG = 0.5;  // alert this many kg before each block boundary

// ── ENTRY POINTS ────────────────────────────────────────────

function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents);

    if (payload.message || payload.callback_query) {
      handleTelegramUpdate(payload);
      return jsonOk({});
    }

    if (payload.action === 'order') return handleOrder(payload);

    return jsonOk({ message: 'unknown action' });
  } catch (err) {
    Logger.log(err);
    return jsonError(err.toString());
  }
}

function doGet(e) {
  if (e.parameter.action === 'status') {
    return jsonOk({ ordersEnabled: isOrdersEnabled() });
  }
  return ContentService.createTextOutput('DairyBliss API ok');
}

// ── ORDER HANDLING ───────────────────────────────────────────

function handleOrder(data) {
  if (!isOrdersEnabled()) {
    return jsonOk({ ok: false, paused: true,
      message: "We're not taking orders right now. Check back soon!" });
  }

  const ss       = SpreadsheetApp.openById(SHEET_ID);
  const aptKey   = parseApt(data.address).apt;           // 'SPC', 'BNR', or 'Other'
  const tabName  = aptKey !== 'Other' ? aptKey : 'Other';
  const sheet    = getOrCreate(ss, tabName);
  ensureOrderHeaders(sheet);

  const orderId = tabName + '-' + String(sheet.getLastRow()).padStart(3, '0');
  const now     = new Date();

  const q250 = parseInt(data.q250) || 0;
  const q500 = parseInt(data.q500) || 0;
  const q750 = parseInt(data.q750) || 0;
  const q1kg = parseInt(data.q1kg) || 0;

  const totalGrams = q250*250 + q500*500 + q750*750 + q1kg*1000;
  const totalRs    = q250*145 + q500*280 + q750*420 + q1kg*550;

  // Running total BEFORE this order (for this apartment's sheet)
  const prevGrams = getRunningTotalGrams(sheet, data.deliveryDate);

  sheet.appendRow([
    now,
    orderId,
    data.name,
    data.phone,
    data.address,
    data.mapUrl || '',
    data.deliveryDate,
    data.deliveryLabel,
    q250, q500, q750, q1kg,
    totalGrams,
    totalRs,
    'New'
  ]);

  const newGrams = prevGrams + totalGrams;

  notifyNewOrder(orderId, data, aptKey, q250, q500, q750, q1kg, totalGrams, totalRs, prevGrams, newGrams);

  return jsonOk({ orderId });
}

function ensureOrderHeaders(sheet) {
  if (sheet.getLastRow() > 0) return;
  const headers = ['Timestamp','Order ID','Name','Phone','Address','Map URL',
    'Delivery Date','Delivery Label','250g','500g','750g','1kg',
    'Total (g)','Total (₹)','Status'];
  sheet.appendRow(headers);
  const r = sheet.getRange(1, 1, 1, headers.length);
  r.setFontWeight('bold');
  r.setBackground('#2d5a1b');
  r.setFontColor('#ffffff');
}

// ── ORDER NOTIFICATION ────────────────────────────────────────

function notifyNewOrder(orderId, data, aptKey, q250, q500, q750, q1kg, totalGrams, totalRs, prevGrams, newGrams) {
  const newKg  = (newGrams / 1000).toFixed(2);
  const meta   = aptMeta(aptKey);

  const items = [];
  if (q250) items.push(`250g × ${q250}  —  ₹${q250*145}`);
  if (q500) items.push(`500g × ${q500}  —  ₹${q500*280}`);
  if (q750) items.push(`750g × ${q750}  —  ₹${q750*420}`);
  if (q1kg) items.push(`1kg × ${q1kg}  —  ₹${q1kg*550}`);

  const { unit } = parseApt(data.address);

  const msg = [
    `${meta.emoji} <b>[${meta.key}] New Order — ${esc(orderId)}</b>`,
    ``,
    `👤 ${esc(data.name)}${unit ? '  · ' + esc(unit) : ''}  ·  📱 ${esc(data.phone)}`,
    `📅 ${esc(data.deliveryLabel)}`,
    ``,
    items.map(esc).join('\n'),
    ``,
    `<b>Total: ₹${totalRs}  ·  ${(totalGrams/1000).toFixed(2)} kg</b>`,
    `📦 ${esc(meta.key)} running total: <b>${newKg} kg</b>`
  ].join('\n');

  tg(msg);

  // Stock alert if we just crossed a block-boundary warning threshold
  checkStockAlerts(prevGrams, newGrams, data.deliveryLabel, meta);
}

// ── STOCK ALERTS ─────────────────────────────────────────────

/**
 * Fires once each time the running total crosses a warning threshold:
 * 2.5 kg, 5.5 kg, 8.5 kg, 11.5 kg … (0.5 kg before each 3 kg block)
 */
function checkStockAlerts(prevGrams, newGrams, label, meta) {
  const prevKg = prevGrams / 1000;
  const newKg  = newGrams  / 1000;

  for (let n = 1; n <= 20; n++) {
    const threshold = BLOCK_KG * n - ALERT_BEFORE_KG;  // 2.5, 5.5, 8.5 …
    const nextBlock = BLOCK_KG * n;                      // 3, 6, 9 …

    if (prevKg < threshold && newKg >= threshold) {
      tg([
        `⚠️ <b>Stock Alert — ${esc(meta.label)} · ${esc(label)}</b>`,
        `Running total: <b>${newKg.toFixed(2)} kg</b>  (approaching ${nextBlock} kg block)`,
        ``,
        `Time to order the next ${BLOCK_KG} kg block.`,
        `Send /pause to stop new orders.`
      ].join('\n'));
    }
  }
}

// ── APARTMENT HELPERS ────────────────────────────────────────

const APARTMENTS = [
  { key: 'SPC', label: 'Sobha Palm Court',   emoji: '🟢' },
  { key: 'BNR', label: 'Brigade North Ridge', emoji: '🏢 🔵' }
];

const APT_PATTERNS = {
  SPC: ['sobha palm court'],
  BNR: ['brigade north ridge', 'brigade northridge', 'brigade north-ridge']
};

/**
 * Returns { apt: 'SPC'|'BNR'|'Other', unit: 'A-301' } from a raw address string.
 * The unit is the first short comma-segment that isn't the complex name or city.
 */
function parseApt(address) {
  const lower = String(address || '').toLowerCase();

  let apt = 'Other';
  for (const key of Object.keys(APT_PATTERNS)) {
    if (APT_PATTERNS[key].some(p => lower.includes(p))) { apt = key; break; }
  }

  // Extract the unit — first short segment that doesn't contain the complex name or city
  const skipWords = ['sobha', 'brigade', 'bangalore', 'bengaluru', 'karnataka', 'india'];
  const unit = String(address || '')
    .split(',')
    .map(p => p.trim())
    .find(p => p.length < 25 && !skipWords.some(w => p.toLowerCase().includes(w)))
    || '';

  return { apt, unit };
}

function aptMeta(key) {
  return APARTMENTS.find(a => a.key === key) || { key: 'Other', label: 'Other', emoji: '⚪' };
}

// ── CUTOFF SUMMARY (Tue 9pm → Wed orders, Fri 9pm → Sat orders) ──

/**
 * Triggered at 9pm every day; only sends on Tuesday and Friday.
 * Tuesday   → final summary of Wednesday's orders (cutoff just hit)
 * Friday    → final summary of Saturday's orders  (cutoff just hit)
 */
function sendCutoffSummary(aptFilter) {
  const now = new Date();
  const day = now.getDay();

  let deliveryDate, deliveryLabel;
  if (day === 2) {
    const wed = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    deliveryDate  = fmt(wed, 'yyyy-MM-dd');
    deliveryLabel = fmt(wed, 'EEE, d MMM');
  } else if (day === 5) {
    const sat = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    deliveryDate  = fmt(sat, 'yyyy-MM-dd');
    deliveryLabel = fmt(sat, 'EEE, d MMM');
  } else if (!aptFilter) {
    // Only skip non-Tue/Fri when called by the scheduled trigger (no filter)
    return;
  } else {
    // Manual /summary SPC or /summary BNR — show next delivery date
    const next = nextDeliveryDates(1)[0];
    if (!next) { tg('No upcoming delivery dates.'); return; }
    deliveryDate  = next.date;
    deliveryLabel = next.label;
  }

  const ss   = SpreadsheetApp.openById(SHEET_ID);
  const apts = aptFilter ? APARTMENTS.filter(a => a.key === aptFilter) : APARTMENTS;

  if (aptFilter && apts.length === 0) {
    tg(`Unknown apartment: <code>${esc(aptFilter)}</code>. Use SPC or BNR.`); return;
  }

  // Send one summary message per apartment
  apts.forEach(({ key, label, emoji }) => {
    const sheet  = getOrCreate(ss, key);
    const orders = ordersForDate(sheet, deliveryDate);

    if (orders.length === 0) {
      tg(`${emoji} <b>${esc(label)}</b>\n📋 Orders closed for <b>${esc(deliveryLabel)}</b> — no orders.`);
      return;
    }
    anyOrders = true;

    const s = orders.reduce((acc, o) => {
      acc.q250 += o.q250; acc.q500 += o.q500;
      acc.q750 += o.q750; acc.q1kg += o.q1kg;
      acc.grams += o.q250*250 + o.q500*500 + o.q750*750 + o.q1kg*1000;
      acc.rs    += o.q250*145 + o.q500*280 + o.q750*420 + o.q1kg*550;
      return acc;
    }, { q250:0, q500:0, q750:0, q1kg:0, grams:0, rs:0 });

    const lines = [
      `${emoji} <b>${esc(label)} — ${esc(deliveryLabel)}</b>`,
      ``,
      `<b>${orders.length} orders  ·  ${(s.grams/1000).toFixed(2)} kg  ·  ₹${s.rs}</b>`,
      `250g × ${s.q250}  ·  500g × ${s.q500}  ·  750g × ${s.q750}  ·  1kg × ${s.q1kg}`,
      ``,
    ];

    orders.forEach((o, i) => {
      const { unit } = parseApt(o.address);
      const items = [];
      if (o.q250) items.push(`250g×${o.q250}`);
      if (o.q500) items.push(`500g×${o.q500}`);
      if (o.q750) items.push(`750g×${o.q750}`);
      if (o.q1kg) items.push(`1kg×${o.q1kg}`);
      lines.push(`${i+1}. ${esc(o.name)}${unit ? ' · ' + esc(unit) : ''}  —  ${items.join(', ')}`);
    });

    tg(lines.join('\n'));
  });
}

// ── TELEGRAM COMMAND HANDLING ─────────────────────────────────

function handleTelegramUpdate(update) {
  const msg = update.message;
  if (!msg || !msg.text) return;

  const chatId = String(msg.chat.id);
  if (chatId !== TELEGRAM_CHAT_ID) return;

  const parts  = msg.text.trim().split(/\s+/);
  const cmd    = parts[0].split('@')[0].toLowerCase();
  const aptArg = parts[1] ? parts[1].toUpperCase() : null; // e.g. SPC or BNR

  switch (cmd) {
    case '/pause':
      setOrdersEnabled(false);
      tg('⏸ <b>Orders paused.</b> The website will show a paused message until you /resume.');
      break;

    case '/resume':
      setOrdersEnabled(true);
      tg('▶️ <b>Orders resumed.</b> The website is accepting orders again.');
      break;

    case '/status':
      sendStatus(aptArg);
      break;

    case '/summary':
      sendCutoffSummary(aptArg);
      break;

    case '/help':
      tg([
        `<b>DairyBliss Bot — Commands</b>`,
        `/status — All apartments running totals`,
        `/status SPC  or  /status BNR — one apartment`,
        `/summary — Full order list (both apartments)`,
        `/summary SPC  or  /summary BNR — one apartment`,
        `/pause — Stop accepting orders`,
        `/resume — Resume accepting orders`,
        `/debug — Confirm bot is alive`
      ].join('\n'));
      break;

    case '/debug':
      tg([
        `✅ <b>Bot is alive</b>`,
        `Chat ID: <code>${chatId}</code>`,
        `Expected: <code>${TELEGRAM_CHAT_ID}</code>`,
        `Match: ${chatId === TELEGRAM_CHAT_ID ? '✅ yes' : '❌ no — update TELEGRAM_CHAT_ID in Code.gs'}`
      ].join('\n'));
      break;
  }
}

/**
 * /status — running totals for the next two delivery dates
 */
function sendStatus(aptFilter) {
  const ss    = SpreadsheetApp.openById(SHEET_ID);
  const now   = new Date();
  const dates = nextDeliveryDates(2);
  const apts  = aptFilter ? APARTMENTS.filter(a => a.key === aptFilter) : APARTMENTS;

  if (aptFilter && apts.length === 0) {
    tg(`Unknown apartment: <code>${esc(aptFilter)}</code>. Use SPC or BNR.`); return;
  }

  const lines = [`📊 <b>Running Totals — ${fmt(now, 'EEE d MMM, h:mm a')}</b>`, ``];

  dates.forEach(({date, label, open}) => {
    const status = open ? '🟢 open' : '🔴 closed';
    lines.push(`<b>${esc(label)}</b>  (${status})`);

    apts.forEach(({ key, label: aptLabel, emoji }) => {
      const sheet = getOrCreate(ss, key);
      const s     = statsForDate(sheet, date);
      const kg    = (s.totalGrams / 1000).toFixed(2);
      if (s.orders === 0) {
        lines.push(`  ${emoji} ${esc(aptLabel)}: no orders yet`);
      } else {
        lines.push(`  ${emoji} ${esc(aptLabel)}: ${s.orders} orders · <b>${kg} kg</b> · ₹${s.totalRs}`);
      }
    });
    lines.push(``);
  });

  tg(lines.join('\n'));
}

// ── SETTINGS ──────────────────────────────────────────────────

function isOrdersEnabled() {
  try {
    const ss    = SpreadsheetApp.openById(SHEET_ID);
    const sheet = getOrCreate(ss, 'Settings');
    const rows  = sheet.getDataRange().getValues();
    for (const row of rows) {
      if (row[0] === 'orders_enabled') return row[1] === true || row[1] === 'TRUE';
    }
    setOrdersEnabled(true);
    return true;
  } catch (e) { return true; }
}

function setOrdersEnabled(val) {
  const ss    = SpreadsheetApp.openById(SHEET_ID);
  const sheet = getOrCreate(ss, 'Settings');
  const rows  = sheet.getDataRange().getValues();
  for (let i = 0; i < rows.length; i++) {
    if (rows[i][0] === 'orders_enabled') { sheet.getRange(i+1, 2).setValue(val); return; }
  }
  sheet.appendRow(['orders_enabled', val]);
}

// ── ONE-TIME SETUP FUNCTIONS ──────────────────────────────────

function setupTriggers() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));

  // Poll Telegram for commands every minute
  ScriptApp.newTrigger('pollTelegram')
    .timeBased().everyMinutes(1).create();

  // Cutoff summary: 9pm every day — function checks if it's Tue or Fri inside
  ScriptApp.newTrigger('sendCutoffSummary')
    .timeBased().atHour(21).everyDays(1).create();

  Logger.log('Triggers set up successfully.');
}

// ── TELEGRAM POLLING ──────────────────────────────────────────

function pollTelegram() {
  const props  = PropertiesService.getScriptProperties();
  const offset = parseInt(props.getProperty('tg_offset') || '0');

  const res  = UrlFetchApp.fetch(
    `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates?offset=${offset}&limit=10&timeout=0`
  );
  const data = JSON.parse(res.getContentText());

  if (!data.ok || !data.result.length) return;

  data.result.forEach(update => {
    try { handleTelegramUpdate(update); } catch(e) { Logger.log(e); }
    props.setProperty('tg_offset', String(update.update_id + 1));
  });
}

// ── HELPERS ───────────────────────────────────────────────────

function tg(text) {
  UrlFetchApp.fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text: text,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    })
  });
}

function getOrCreate(ss, name) {
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

function fmt(date, pattern) {
  return Utilities.formatDate(date, 'Asia/Kolkata', pattern);
}

function getRunningTotalGrams(sheet, deliveryDate) {
  return statsForDate(sheet, deliveryDate).totalGrams;
}

function statsForDate(sheet, dateStr) {
  const s = { orders:0, totalGrams:0, totalRs:0, q250:0, q500:0, q750:0, q1kg:0 };
  if (sheet.getLastRow() < 2) return s;
  sheet.getRange(2, 1, sheet.getLastRow()-1, 15).getValues().forEach(row => {
    if (!matchDate(row[6], dateStr)) return;
    s.orders++;
    s.q250       += parseInt(row[8])  || 0;
    s.q500       += parseInt(row[9])  || 0;
    s.q750       += parseInt(row[10]) || 0;
    s.q1kg       += parseInt(row[11]) || 0;
    s.totalGrams += parseInt(row[12]) || 0;
    s.totalRs    += parseInt(row[13]) || 0;
  });
  return s;
}

function ordersForDate(sheet, dateStr) {
  if (sheet.getLastRow() < 2) return [];
  return sheet.getRange(2, 1, sheet.getLastRow()-1, 15).getValues()
    .filter(r => matchDate(r[6], dateStr))
    .map(r => ({ name:r[2], phone:r[3], address:r[4],
      q250:parseInt(r[8])||0, q500:parseInt(r[9])||0,
      q750:parseInt(r[10])||0, q1kg:parseInt(r[11])||0 }));
}

function matchDate(cell, dateStr) {
  if (!cell) return false;
  if (cell instanceof Date) return fmt(cell, 'yyyy-MM-dd') === dateStr;
  return String(cell).includes(dateStr);
}

/**
 * Returns the next n delivery dates (Wed=3, Sat=6) with an open/closed flag.
 * Wed orders close Tue 9pm; Sat orders close Fri 9pm.
 */
function nextDeliveryDates(n) {
  const result = [];
  const now    = new Date();
  const day    = now.getDay();
  const hour   = parseInt(fmt(now, 'H'));

  // Is Wednesday currently open?  Open: Sat 0am → Tue 9pm
  // Is Saturday currently open?   Open: Wed 0am → Fri 9pm
  const wedOpen = !((day === 2 && hour >= 21) || day === 3 || day === 4 || day === 5 || day === 6 || (day === 0));
  // Wed closed after Tue 9pm through end of Wed delivery day (Sat morning reopens)
  // Simplified: Wed open if day is Sat(6), Sun(0), Mon(1), or Tue before 9pm
  const wedOpenSimple = (day === 6) || (day === 0) || (day === 1) || (day === 2 && hour < 21);
  const satOpenSimple = (day === 3) || (day === 4) || (day === 5 && hour < 21);

  for (let offset = 1; result.length < n && offset < 15; offset++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
    const wd = d.getDay();
    if (wd === 3) {
      result.push({ date: fmt(d,'yyyy-MM-dd'), label: fmt(d,'EEE, d MMM'), open: wedOpenSimple });
    } else if (wd === 6) {
      result.push({ date: fmt(d,'yyyy-MM-dd'), label: fmt(d,'EEE, d MMM'), open: satOpenSimple });
    }
  }
  return result;
}

function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function clip(s, len) {
  return s && s.length > len ? s.slice(0, len) + '…' : (s || '');
}

function jsonOk(data)   { return res(JSON.stringify({ ok:true,  ...data })); }
function jsonError(msg) { return res(JSON.stringify({ ok:false, error:msg })); }
function res(body)      { return ContentService.createTextOutput(body).setMimeType(ContentService.MimeType.JSON); }
