// ============================================================
// DairyBliss Backend — Google Apps Script
// ============================================================

// Secrets are stored in Script Properties — never hardcode them here.
// Set via: Extensions → Apps Script → Project Settings → Script Properties
//   TG_TOKEN   = <your Telegram bot token>
//   TG_CHAT_ID = <your Telegram group chat ID>
const props         = PropertiesService.getScriptProperties();
const TELEGRAM_TOKEN   = props.getProperty('TG_TOKEN')   || '';
const TELEGRAM_CHAT_ID = props.getProperty('TG_CHAT_ID') || '';
const SHEET_ID         = '1JqZ6YhCldPSaS9S-RPm4vpJM9CHlr67OLY5HEajZHvQ';

const BLOCK_KG        = 3;     // stock bought in 3 kg blocks
const ALERT_BEFORE_KG = 0.5;  // alert this many kg before each block boundary
const COST_PER_KG     = 335;  // buying price per kg from supplier

// Key ID is public-facing (used in frontend checkout). Store in Script Properties if preferred.
// RZP_KEY_ID is stored in Script Properties (key: RZP_KEY_ID) — never hardcode here
function getRzpKeyId() {
  return PropertiesService.getScriptProperties().getProperty('RZP_KEY_ID') || '';
}

/**
 * Run ONCE from the Apps Script editor after rotating keys.
 * Paste the NEW secret directly in the Script Properties UI instead:
 * Extensions → Apps Script → Project Settings → Script Properties → Add: RZP_SECRET
 * Never paste the actual secret value here in code.
 */
function setRazorpaySecret() {
  throw new Error('Do not store the secret in code. Set RZP_SECRET via Script Properties UI directly.');
}

function getRzpSecret() {
  return PropertiesService.getScriptProperties().getProperty('RZP_SECRET');
}

// ── ENTRY POINTS ────────────────────────────────────────────

function doPost(e) {
  try {
    const raw = e.postData ? (e.postData.contents || '') : '';
    if (!raw) return jsonError('empty body');

    const payload = JSON.parse(raw);

    // Telegram webhook — no auth needed
    if (payload.message || payload.callback_query) {
      handleTelegramUpdate(payload);
      return jsonOk({});
    }

    // Customer order — no auth needed (public ordering page)
    if (payload.action === 'order')             return handleOrder(payload);
    if (payload.action === 'create_rzp_order')  return handleCreateRzpOrder(payload);
    if (payload.action === 'create_subscription') return handleCreateSubscription(payload);

    // Subscription self-service — gated by the subscription's own manage
    // token (validated inside each handler), not the ops PIN session token
    if (payload.action === 'get_subscription')        return handleGetSubscription(payload);
    if (payload.action === 'skip_delivery')           return handleSkipDelivery(payload);
    if (payload.action === 'pause_subscription')      return handlePauseSubscription(payload);
    if (payload.action === 'resume_subscription')     return handleResumeSubscription(payload);
    if (payload.action === 'update_subscription_qty') return handleUpdateSubscriptionQty(payload);
    if (payload.action === 'cancel_subscription')     return handleCancelSubscription(payload);

    // PIN auth — no token needed for these
    if (payload.action === 'verify_pin')  return handleVerifyPin(payload);
    if (payload.action === 'request_otp') return handleRequestOtp(payload);
    if (payload.action === 'verify_otp')  return handleVerifyOtp(payload);
    if (payload.action === 'setup_pin')   return handleSetupPin(payload);

    // All other dashboard actions require a valid token
    const tokenUser = validateToken(payload.token);
    if (!tokenUser) return jsonOk({ ok: false, error: 'unauthorized' });

    if (payload.action === 'mark_delivered')      return handleMarkDelivered(payload);
    if (payload.action === 'mark_paid')           return handleMarkPaid(payload);
    if (payload.action === 'mark_vendor_ordered') return handleMarkVendorOrdered(payload);
    if (payload.action === 'log_expense')         return handleLogExpense(payload);
    if (payload.action === 'update_expense')      return handleUpdateExpense(payload);
    if (payload.action === 'delete_expense')      return handleDeleteExpense(payload);

    return jsonOk({ message: 'unknown action' });
  } catch (err) {
    Logger.log('doPost error: ' + err + '\nbody: ' + (e.postData ? e.postData.contents : 'null'));
    try { tg('⚠️ Order submission error: ' + esc(err.toString())); } catch (_) {}
    return jsonError(err.toString());
  }
}

function doGet(e) {
  if (e.parameter.action === 'status') return jsonOk({ ordersEnabled: isOrdersEnabled() });
  if (e.parameter.action === 'pin_status') return getPinStatus();

  // Manage-token-gated (not a PIN session) — the self-service page's initial load
  if (e.parameter.action === 'get_subscription') return handleGetSubscription(e.parameter);

  // Dashboard endpoints require a valid token
  const tokenUser = validateToken(e.parameter.token);
  if (!tokenUser) return jsonOk({ ok: false, error: 'unauthorized' });

  if (e.parameter.action === 'dashboard')          return getDashboardOrders();
  if (e.parameter.action === 'summary')            return getDashboardSummary();
  if (e.parameter.action === 'expenses')           return getExpensesData();
  if (e.parameter.action === 'list_subscriptions') return handleListSubscriptions();
  return ContentService.createTextOutput('DairyBliss API ok');
}

// ── PIN AUTH ─────────────────────────────────────────────────

function getPinStatus() {
  const p = PropertiesService.getScriptProperties();
  return jsonOk({
    spcReady: !!p.getProperty('PIN_SPC'),
    bnrReady: !!p.getProperty('PIN_BNR')
  });
}

function handleVerifyPin(payload) {
  const pin = String(payload.pin || '');
  const p   = PropertiesService.getScriptProperties();
  const spcPin = p.getProperty('PIN_SPC');
  const bnrPin = p.getProperty('PIN_BNR');

  let user = null;
  if (spcPin && pin === spcPin) user = 'SPC';
  else if (bnrPin && pin === bnrPin) user = 'BNR';

  if (!user) return jsonOk({ ok: false });

  const token   = Utilities.getUuid();
  const expires = new Date().getTime() + (14 * 60 * 60 * 1000); // 14 hours
  p.setProperty('TOKEN_' + token, user + ':' + expires);

  // Piggyback dashboard data so the app renders immediately after
  // login instead of waiting on a second Apps Script round-trip.
  // Never let a dashboard failure break login itself.
  let dashboard = null;
  try { dashboard = buildDashboardData(); } catch (_) {}

  return jsonOk({ ok: true, user, token, dashboard });
}

function handleRequestOtp(payload) {
  const apt = payload.apt;
  if (apt !== 'SPC' && apt !== 'BNR') return jsonOk({ ok: false, message: 'Invalid user' });

  const p = PropertiesService.getScriptProperties();

  if (p.getProperty('PIN_' + apt))
    return jsonOk({ ok: false, message: 'PIN already set. Contact admin to reset.' });

  const email = p.getProperty('EMAIL_' + apt);
  if (!email) return jsonOk({ ok: false, message: 'Email not configured. Contact admin.' });

  const otp     = String(Math.floor(100000 + Math.random() * 900000));
  const expires = new Date().getTime() + (15 * 60 * 1000); // 15 minutes
  p.setProperty('OTP_' + apt, otp + ':' + expires);

  const name = apt === 'SPC' ? 'Rekha' : 'Deepa';
  MailApp.sendEmail({
    to: email,
    subject: 'DairyBliss — Your setup code',
    body:
      'Hi ' + name + ',\n\n' +
      'Your one-time setup code is: ' + otp + '\n\n' +
      'This code expires in 15 minutes.\n\n' +
      'If you didn\'t request this, ignore this email.\n\n' +
      '— DairyBliss'
  });

  return jsonOk({ ok: true });
}

function handleVerifyOtp(payload) {
  const apt = payload.apt;
  const otp = String(payload.otp || '');

  const p      = PropertiesService.getScriptProperties();
  const stored = p.getProperty('OTP_' + apt);
  if (!stored) return jsonOk({ ok: false, message: 'No code found. Request a new one.' });

  const parts      = stored.split(':');
  const storedOtp  = parts[0];
  const expires    = parseInt(parts[1]);

  if (isNaN(expires) || new Date().getTime() > expires) {
    p.deleteProperty('OTP_' + apt);
    return jsonOk({ ok: false, expired: true, message: 'Code expired — tap Resend.' });
  }

  if (otp !== storedOtp) return jsonOk({ ok: false, message: 'Wrong code — try again.' });

  // Valid — delete OTP and issue a short-lived setup token
  p.deleteProperty('OTP_' + apt);
  const setupToken  = Utilities.getUuid();
  const setupExpiry = new Date().getTime() + (10 * 60 * 1000); // 10 min to complete setup
  p.setProperty('SETUP_TOKEN_' + apt, setupToken + ':' + setupExpiry);

  return jsonOk({ ok: true, setupToken });
}

function handleSetupPin(payload) {
  const apt        = payload.apt;
  const pin        = String(payload.pin || '');
  const setupToken = payload.setupToken;
  if (!apt || !pin || pin.length < 4) return jsonOk({ ok: false, message: 'Invalid PIN' });

  const p   = PropertiesService.getScriptProperties();
  const key = apt === 'SPC' ? 'PIN_SPC' : apt === 'BNR' ? 'PIN_BNR' : null;
  if (!key) return jsonOk({ ok: false, message: 'Invalid user' });

  if (p.getProperty(key)) return jsonOk({ ok: false, message: 'PIN already set — contact admin to reset' });

  // Verify the setup token issued after OTP verification
  const stored = p.getProperty('SETUP_TOKEN_' + apt);
  if (!stored) return jsonOk({ ok: false, message: 'Session expired — start over' });
  const parts   = stored.split(':');
  const expires = parseInt(parts[1]);
  if (setupToken !== parts[0] || new Date().getTime() > expires) {
    p.deleteProperty('SETUP_TOKEN_' + apt);
    return jsonOk({ ok: false, message: 'Session expired — start over' });
  }
  p.deleteProperty('SETUP_TOKEN_' + apt);

  p.setProperty(key, pin);

  // Issue session token — log them in immediately
  const token      = Utilities.getUuid();
  const tokenExpiry = new Date().getTime() + (14 * 60 * 60 * 1000);
  p.setProperty('TOKEN_' + token, apt + ':' + tokenExpiry);

  let dashboard = null;
  try { dashboard = buildDashboardData(); } catch (_) {}

  return jsonOk({ ok: true, user: apt, token, dashboard });
}

function validateToken(token) {
  if (!token) return null;
  const p   = PropertiesService.getScriptProperties();
  const val = p.getProperty('TOKEN_' + token);
  if (!val) return null;
  const parts   = val.split(':');
  const user    = parts[0];
  const expires = parseInt(parts[1]);
  if (isNaN(expires) || new Date().getTime() > expires) {
    p.deleteProperty('TOKEN_' + token);
    return null;
  }
  return user;
}

// ── ORDER ID ─────────────────────────────────────────────────

function nextOrderId() {
  const p   = PropertiesService.getScriptProperties();
  const seq = parseInt(p.getProperty('ORDER_SEQ') || '0') + 1;
  p.setProperty('ORDER_SEQ', String(seq));
  return 'DB' + String(seq).padStart(3, '0');
}

function nextSubscriptionId() {
  const p   = PropertiesService.getScriptProperties();
  const seq = parseInt(p.getProperty('SUB_SEQ') || '0') + 1;
  p.setProperty('SUB_SEQ', String(seq));
  return 'DBS' + String(seq).padStart(3, '0');
}

// Per-delivery pricing — single source of truth on the backend.
// (Each frontend order form keeps its own copy for instant UI feedback
// with no round-trip; this is the copy that governs what actually gets
// written to the sheet and charged.)
const PRICING = { q250: 145, q500: 280, q750: 420, q1kg: 550 };

// Saturday Specials — one-off add-ons delivered on the Saturday run only.
// Quantities live in sheet columns 22-25 (appended AFTER the original 21
// so every existing column index keeps working).
const EXTRAS_PRICING = { chaap: 150, ghee: 475, butter: 180, khoya: 175 };
// Procurement cost per SELLING unit, incl. 5% GST. Derived from cost/kg:
// chaap ₹150/kg → 500g ₹78.75 · ghee ₹700/L → 500ml ₹367.50
// butter ₹520/kg → 250g ₹136.50 · khoya ₹320/kg → 250g ₹84
const EXTRAS_COST = { chaap: 78.75, ghee: 367.5, butter: 136.5, khoya: 84 };
const EXTRAS_LABELS  = {
  chaap:  'Soya Chaap (500g)',
  ghee:   'Desi Ghee (500ml)',
  butter: 'White Butter (250g)',
  khoya:  'Khoya (250g)',
};

function parseExtras(data) {
  return {
    chaap:  parseInt(data.qChaap)  || 0,
    ghee:   parseInt(data.qGhee)   || 0,
    butter: parseInt(data.qButter) || 0,
    khoya:  parseInt(data.qKhoya)  || 0,
  };
}
function extrasRs(x) {
  return x.chaap  * EXTRAS_PRICING.chaap  + x.ghee  * EXTRAS_PRICING.ghee +
         x.butter * EXTRAS_PRICING.butter + x.khoya * EXTRAS_PRICING.khoya;
}

// ── ORDER HANDLING ───────────────────────────────────────────

function handleOrder(data) {
  if (!isOrdersEnabled()) {
    return jsonOk({ ok: false, paused: true,
      message: "We're not taking orders right now. Check back soon!" });
  }

  if (data.deliveryDate && !isDateOrderable(data.deliveryDate)) {
    return jsonOk({ ok: false, paused: true,
      message: "Orders for that date are now closed. Please choose an available date." });
  }

  const r = insertOrderRow(data, {});

  notifyNewOrder(r.orderId, data, r.aptKey, r.q250, r.q500, r.q750, r.q1kg,
    r.totalGrams, r.totalRs, r.prevGrams, r.newGrams);

  return jsonOk({ orderId: r.orderId });
}

// Writes one order row into the correct apartment sheet. Used by one-off
// orders (opts.subscriptionId omitted/blank) and by subscription signup +
// nightly materialization (opts.subscriptionId set) — the single place
// the 21-element row shape is constructed, so both paths always agree.
function insertOrderRow(data, opts) {
  const ss       = SpreadsheetApp.openById(SHEET_ID);
  // Prefer an explicit apartment (e.g. a subscription's stored Apartment
  // column) over parsing it out of the address text. This lets the address
  // hold just the flat (e.g. "G301") without misrouting to "Other".
  const optApt   = opts && opts.apt;
  const aptKey   = (optApt && optApt !== 'Other') ? optApt : parseApt(data.address).apt;
  const tabName  = aptKey !== 'Other' ? aptKey : 'Other';
  const sheet    = getOrCreate(ss, tabName);
  ensureOrderHeaders(sheet);

  const orderId = nextOrderId();
  const now     = new Date();

  const q250 = parseInt(data.q250) || 0;
  const q500 = parseInt(data.q500) || 0;
  const q750 = parseInt(data.q750) || 0;
  const q1kg = parseInt(data.q1kg) || 0;
  const x    = parseExtras(data);

  // Total (g) stays PANEER grams only — it drives the vendor block maths,
  // running totals, and stock alerts. Money includes the extras.
  const totalGrams = q250*250 + q500*500 + q750*750 + q1kg*1000;
  const totalRs    = q250*PRICING.q250 + q500*PRICING.q500 + q750*PRICING.q750 + q1kg*PRICING.q1kg
                   + extrasRs(x);

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
    'New',
    data.paymentMethod || '',
    data.paymentStatus || '',
    data.rzpPaymentId  || '',
    '',   // Delivered
    '',   // Payment Collected
    (opts && opts.subscriptionId) || '',  // Subscription ID
    x.chaap, x.ghee, x.butter, x.khoya,   // Saturday Specials (cols 22-25)
  ]);

  const newGrams = prevGrams + totalGrams;

  return { orderId, aptKey, q250, q500, q750, q1kg, extras: x, totalGrams, totalRs, prevGrams, newGrams };
}

// ── RAZORPAY ORDER CREATION ───────────────────────────────────

function handleCreateRzpOrder(data) {
  const amountPaise = parseInt(data.amount);
  if (!amountPaise || amountPaise < 100) return jsonError('invalid amount');

  const keyId  = getRzpKeyId();
  const secret = getRzpSecret();
  if (!keyId || !secret) return jsonError('Razorpay not configured');

  const creds    = Utilities.base64Encode(keyId + ':' + secret);
  const response = UrlFetchApp.fetch('https://api.razorpay.com/v1/orders', {
    method:             'post',
    muteHttpExceptions: true,
    headers: {
      'Authorization': 'Basic ' + creds,
      'Content-Type':  'application/json',
    },
    payload: JSON.stringify({
      amount:   amountPaise,
      currency: 'INR',
      receipt:  'db_' + Date.now(),
    }),
  });

  const rzp = JSON.parse(response.getContentText());
  if (!rzp.id) {
    Logger.log('Razorpay error: ' + JSON.stringify(rzp));
    return jsonError('Razorpay: ' + (rzp.error?.description || 'unknown error'));
  }

  return jsonOk({ rzp_order_id: rzp.id, key_id: keyId });
}

const ORDER_HEADERS = ['Timestamp','Order ID','Name','Phone','Address','Map URL',
  'Delivery Date','Delivery Label','250g','500g','750g','1kg',
  'Total (g)','Total (₹)','Status',
  'Payment Method','Payment Status','RZP Payment ID',
  'Delivered','Payment Collected','Subscription ID',
  'Chaap','Ghee','Butter','Khoya'];

function ensureOrderHeaders(sheet) {
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(ORDER_HEADERS);
    const r = sheet.getRange(1, 1, 1, ORDER_HEADERS.length);
    r.setFontWeight('bold');
    r.setBackground('#2d5a1b');
    r.setFontColor('#ffffff');
    return;
  }
  // Self-heal older sheets created with the 21-column layout: stamp the
  // four Saturday Specials headers into cols 22-25 if they're missing.
  if (!sheet.getRange(1, 22).getValue()) {
    const extra = sheet.getRange(1, 22, 1, 4);
    extra.setValues([ORDER_HEADERS.slice(21)]);
    extra.setFontWeight('bold');
    extra.setBackground('#2d5a1b');
    extra.setFontColor('#ffffff');
  }
}

// ── SUBSCRIPTIONS ────────────────────────────────────────────
// One shared sheet across all apartments (same pattern as Expenses).
// A subscription is a template; the nightly materializeSubscriptions()
// job (and, for the very first delivery, handleCreateSubscription
// itself) writes ordinary rows into the per-apartment order sheets via
// insertOrderRow — nothing downstream needs to know subscriptions exist.

const SUB_COL = {
  TIMESTAMP: 1, ID: 2, APT: 3, NAME: 4, PHONE: 5, ADDRESS: 6,
  FREQUENCY: 7, WEEKDAY: 8, ANCHOR_DATE: 9,
  Q250: 10, Q500: 11, Q750: 12, Q1KG: 13, PER_DELIVERY_RS: 14,
  PAYMENT_MODE: 15, PREPAID_REMAINING: 16, RZP_PAYMENT_ID: 17,
  STATUS: 18, PAUSED_UNTIL: 19, SKIP_DATES: 20, LAST_MATERIALIZED: 21,
  MANAGE_TOKEN: 22,
};

function getOrCreateSubscriptionsSheet(ss) {
  let sheet = ss.getSheetByName('Subscriptions');
  if (!sheet) {
    sheet = ss.insertSheet('Subscriptions');
    const headers = ['Timestamp','Subscription ID','Apartment','Name','Phone','Address',
      'Frequency','Weekday','Anchor Date','250g','500g','750g','1kg','Per-Delivery ₹',
      'Payment Mode','Prepaid Remaining','RZP Payment ID',
      'Status','Paused Until','Skip Dates','Last Materialized Date','Manage Token'];
    sheet.appendRow(headers);
    const r = sheet.getRange(1, 1, 1, headers.length);
    r.setFontWeight('bold');
    r.setBackground('#6b3fa0');
    r.setFontColor('#ffffff');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

// A date cell may come back as a real Date (Sheets auto-parsed it) or a
// string, depending on how it was written — the same ambiguity the order
// sheet already handles the same defensive way elsewhere in this file.
function cellToIsoDate(cell) {
  if (!cell) return '';
  return cell instanceof Date ? fmt(cell, 'yyyy-MM-dd') : String(cell);
}

function subscriptionRowToObject(row, rowIndex) {
  const c = i => row[i - 1];
  return {
    rowIndex,
    id:               c(SUB_COL.ID),
    apt:              c(SUB_COL.APT),
    name:             c(SUB_COL.NAME),
    phone:            c(SUB_COL.PHONE),
    address:          c(SUB_COL.ADDRESS),
    frequency:        c(SUB_COL.FREQUENCY),
    weekday:          c(SUB_COL.WEEKDAY),
    anchorDate:       cellToIsoDate(c(SUB_COL.ANCHOR_DATE)),
    q250:             parseInt(c(SUB_COL.Q250)) || 0,
    q500:             parseInt(c(SUB_COL.Q500)) || 0,
    q750:             parseInt(c(SUB_COL.Q750)) || 0,
    q1kg:             parseInt(c(SUB_COL.Q1KG)) || 0,
    perDeliveryRs:    parseInt(c(SUB_COL.PER_DELIVERY_RS)) || 0,
    paymentMode:      c(SUB_COL.PAYMENT_MODE),
    prepaidRemaining: c(SUB_COL.PREPAID_REMAINING) === '' ? null : parseInt(c(SUB_COL.PREPAID_REMAINING)),
    status:           c(SUB_COL.STATUS),
    pausedUntil:      cellToIsoDate(c(SUB_COL.PAUSED_UNTIL)),
    skipDates:        String(c(SUB_COL.SKIP_DATES) || '').split(',').map(s => s.trim()).filter(Boolean),
    lastMaterialized: cellToIsoDate(c(SUB_COL.LAST_MATERIALIZED)),
  };
}

// Does this subscription want a delivery on dateStr, ignoring pause/skip/
// balance state (those are checked separately by each caller)?
function isDueDate(sub, dateStr) {
  const d  = new Date(dateStr + 'T00:00:00');
  const wd = d.getDay(); // 0=Sun … 6=Sat
  const isWed = wd === 3, isSat = wd === 6;

  if (sub.frequency === 'both_days') {
    if (!isWed && !isSat) return false;
  } else {
    const wantWed = sub.weekday === 'Wed';
    if (wantWed !== isWed) return false;
    if (!wantWed && !isSat) return false;
  }

  if (sub.frequency === 'biweekly') {
    const anchor     = new Date(sub.anchorDate + 'T00:00:00');
    const weeksSince = Math.round((d - anchor) / (7 * 24 * 60 * 60 * 1000));
    if (weeksSince % 2 !== 0) return false;
  }

  return true;
}

// Looks up a subscription by ID and checks the manage token. Returns
// { rowIndex, row } on success (rowIndex is the absolute 1-indexed sheet
// row, ready for direct getRange writes), or null if not found/wrong token —
// deliberately the same shape for "no such subscription" and "wrong token"
// so this can't be used to probe for valid subscription IDs.
function validateManageToken(subId, token) {
  if (!subId || !token) return null;
  const ss    = SpreadsheetApp.openById(SHEET_ID);
  const sheet = ss.getSheetByName('Subscriptions');
  if (!sheet || sheet.getLastRow() < 2) return null;
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, 22).getValues();
  for (let i = 0; i < rows.length; i++) {
    if (rows[i][SUB_COL.ID - 1] === subId) {
      if (rows[i][SUB_COL.MANAGE_TOKEN - 1] === token) return { rowIndex: i + 2, row: rows[i] };
      return null;
    }
  }
  return null;
}

function handleCreateSubscription(data) {
  if (!isOrdersEnabled()) {
    return jsonOk({ ok: false, paused: true,
      message: "We're not taking orders right now. Check back soon!" });
  }

  const frequency = data.frequency;
  if (!['weekly', 'both_days', 'biweekly'].includes(frequency)) {
    return jsonOk({ ok: false, message: 'Invalid frequency' });
  }
  const weekday = data.weekday;
  if (weekday !== 'Wed' && weekday !== 'Sat') {
    return jsonOk({ ok: false, message: 'Invalid delivery day' });
  }
  const paymentMethod = data.paymentMethod; // 'cod' | 'prepay4'
  if (paymentMethod !== 'cod' && paymentMethod !== 'prepay4') {
    return jsonOk({ ok: false, message: 'Invalid payment method' });
  }
  if (paymentMethod === 'prepay4' && !data.rzpPaymentId) {
    return jsonOk({ ok: false, message: 'Missing payment confirmation' });
  }
  if (data.deliveryDate && !isDateOrderable(data.deliveryDate)) {
    return jsonOk({ ok: false, paused: true,
      message: 'Orders for that date are now closed. Please choose an available date.' });
  }

  const q250 = parseInt(data.q250) || 0;
  const q500 = parseInt(data.q500) || 0;
  const q750 = parseInt(data.q750) || 0;
  const q1kg = parseInt(data.q1kg) || 0;
  if (q250 + q500 + q750 + q1kg === 0) {
    return jsonOk({ ok: false, message: 'Choose at least one item' });
  }
  const perDeliveryRs = q250*PRICING.q250 + q500*PRICING.q500 + q750*PRICING.q750 + q1kg*PRICING.q1kg;

  const aptKey       = parseApt(data.address).apt;
  const subId        = nextSubscriptionId();
  const manageToken  = Utilities.getUuid();
  const anchorDate   = data.deliveryDate;
  const isPrepaid    = paymentMethod === 'prepay4';

  const ss       = SpreadsheetApp.openById(SHEET_ID);
  const subSheet = getOrCreateSubscriptionsSheet(ss);
  subSheet.appendRow([
    new Date(), subId, aptKey, data.name, data.phone, data.address,
    frequency, weekday, anchorDate,
    q250, q500, q750, q1kg, perDeliveryRs,
    isPrepaid ? 'Prepay4' : 'COD',
    isPrepaid ? 4 : '',
    data.rzpPaymentId || '',
    'Active', '', '', anchorDate, manageToken,
  ]);
  const subRow = subSheet.getLastRow();

  // First delivery happens immediately, same as a one-off order — the
  // nightly job only ever has to handle deliveries after this one.
  const orderResult = insertOrderRow({
    name: data.name, phone: data.phone, address: data.address, mapUrl: data.mapUrl,
    deliveryDate: anchorDate, deliveryLabel: data.deliveryLabel,
    q250, q500, q750, q1kg,
    paymentMethod: isPrepaid ? 'Online (Prepaid ×4)' : 'Cash on Delivery',
    paymentStatus: isPrepaid ? 'Paid Online' : '',
    rzpPaymentId:  data.rzpPaymentId || '',
  }, { subscriptionId: subId, apt: aptKey });

  if (isPrepaid) {
    subSheet.getRange(subRow, SUB_COL.PREPAID_REMAINING).setValue(3);
  }
  subSheet.getRange(subRow, SUB_COL.LAST_MATERIALIZED).setValue(anchorDate);

  data.paymentStatus = isPrepaid ? 'Paid Online' : '';
  notifyNewOrder(orderResult.orderId, data, orderResult.aptKey, q250, q500, q750, q1kg,
    orderResult.totalGrams, orderResult.totalRs, orderResult.prevGrams, orderResult.newGrams,
    subId);

  const manageUrl = 'https://dairybliss.com/manage/?id=' + subId + '&t=' + manageToken;
  return jsonOk({ subId, manageToken, manageUrl, orderId: orderResult.orderId });
}

function handleGetSubscription(payload) {
  const match = validateManageToken(payload.subId, payload.token);
  if (!match) return jsonOk({ ok: false, error: 'unauthorized' });
  const sub  = subscriptionRowToObject(match.row, match.rowIndex);
  const next = nextDeliveryDates(4).find(d => isDueDate(sub, d.date) && !sub.skipDates.includes(d.date));
  return jsonOk({ ok: true, subscription: sub, nextDueDate: next ? next.date : null });
}

function handleSkipDelivery(payload) {
  const match = validateManageToken(payload.subId, payload.token);
  if (!match) return jsonOk({ ok: false, error: 'unauthorized' });
  const sub = subscriptionRowToObject(match.row, match.rowIndex);

  const validUpcoming = nextDeliveryDates(4).map(d => d.date).filter(d => isDueDate(sub, d));
  if (!validUpcoming.includes(payload.date)) {
    return jsonOk({ ok: false, message: 'Not an upcoming delivery date' });
  }

  const skipSet = new Set(sub.skipDates);
  skipSet.add(payload.date);
  const ss = SpreadsheetApp.openById(SHEET_ID);
  ss.getSheetByName('Subscriptions')
    .getRange(match.rowIndex, SUB_COL.SKIP_DATES)
    .setValue([...skipSet].join(','));
  return jsonOk({ ok: true });
}

function handlePauseSubscription(payload) {
  const match = validateManageToken(payload.subId, payload.token);
  if (!match) return jsonOk({ ok: false, error: 'unauthorized' });
  const ss    = SpreadsheetApp.openById(SHEET_ID);
  const sheet = ss.getSheetByName('Subscriptions');
  sheet.getRange(match.rowIndex, SUB_COL.STATUS).setValue('Paused');
  sheet.getRange(match.rowIndex, SUB_COL.PAUSED_UNTIL).setValue(payload.until || '');
  return jsonOk({ ok: true });
}

function handleResumeSubscription(payload) {
  const match = validateManageToken(payload.subId, payload.token);
  if (!match) return jsonOk({ ok: false, error: 'unauthorized' });
  const ss    = SpreadsheetApp.openById(SHEET_ID);
  const sheet = ss.getSheetByName('Subscriptions');
  sheet.getRange(match.rowIndex, SUB_COL.STATUS).setValue('Active');
  sheet.getRange(match.rowIndex, SUB_COL.PAUSED_UNTIL).setValue('');
  return jsonOk({ ok: true });
}

function handleUpdateSubscriptionQty(payload) {
  const match = validateManageToken(payload.subId, payload.token);
  if (!match) return jsonOk({ ok: false, error: 'unauthorized' });

  const q250 = parseInt(payload.q250) || 0;
  const q500 = parseInt(payload.q500) || 0;
  const q750 = parseInt(payload.q750) || 0;
  const q1kg = parseInt(payload.q1kg) || 0;
  if (q250 + q500 + q750 + q1kg === 0) {
    return jsonOk({ ok: false, message: 'Choose at least one item' });
  }
  const perDeliveryRs = q250*PRICING.q250 + q500*PRICING.q500 + q750*PRICING.q750 + q1kg*PRICING.q1kg;

  const ss = SpreadsheetApp.openById(SHEET_ID);
  ss.getSheetByName('Subscriptions')
    .getRange(match.rowIndex, SUB_COL.Q250, 1, 5)
    .setValues([[q250, q500, q750, q1kg, perDeliveryRs]]);
  return jsonOk({ ok: true });
}

function handleCancelSubscription(payload) {
  const match = validateManageToken(payload.subId, payload.token);
  if (!match) return jsonOk({ ok: false, error: 'unauthorized' });
  const ss = SpreadsheetApp.openById(SHEET_ID);
  ss.getSheetByName('Subscriptions').getRange(match.rowIndex, SUB_COL.STATUS).setValue('Cancelled');
  return jsonOk({ ok: true });
}

function handleListSubscriptions() {
  const ss    = SpreadsheetApp.openById(SHEET_ID);
  const sheet = ss.getSheetByName('Subscriptions');
  if (!sheet || sheet.getLastRow() < 2) return jsonOk({ subscriptions: [] });
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, 22).getValues();
  const subscriptions = rows
    .filter(r => r[SUB_COL.ID - 1])
    .map((r, i) => subscriptionRowToObject(r, i + 2))
    .filter(s => s.status !== 'Cancelled');
  return jsonOk({ subscriptions });
}

// Nightly job (see setupTriggers): materializes every due delivery for
// every active subscription into the normal per-apartment order sheet via
// insertOrderRow — from that point on it's indistinguishable from a
// one-off order to the ops dashboard or the vendor-procurement math.
//
// Walks a small lookahead window of upcoming delivery dates rather than
// just "today" so a run that failed for a few days catches up on every
// missed delivery in order, instead of silently dropping them. Re-reads
// each subscription's row before acting on it so state a prior candidate
// in the same run just wrote (Last Materialized Date, prepaid balance)
// is never acted on stale.
function materializeSubscriptions() {
  const ss    = SpreadsheetApp.openById(SHEET_ID);
  const sheet = ss.getSheetByName('Subscriptions');
  if (!sheet || sheet.getLastRow() < 2) return;

  const upcoming = nextDeliveryDates(3); // ~10-11 days of lookahead/catch-up room
  const numRows  = sheet.getLastRow() - 1;
  const rows     = sheet.getRange(2, 1, numRows, 22).getValues();

  rows.forEach((row, i) => {
    const rowIndex = i + 2;
    if (!row[SUB_COL.ID - 1]) return;
    const sub = subscriptionRowToObject(row, rowIndex);
    if (sub.status === 'Cancelled') return;

    const candidates = upcoming
      .map(d => d.date)
      .filter(d => !sub.lastMaterialized || d > sub.lastMaterialized)
      .filter(d => isDueDate(sub, d));

    candidates.forEach(date => {
      const current = subscriptionRowToObject(
        sheet.getRange(rowIndex, 1, 1, 22).getValues()[0], rowIndex);

      if (current.skipDates.includes(date)) {
        sheet.getRange(rowIndex, SUB_COL.LAST_MATERIALIZED).setValue(date);
        return;
      }
      if (current.status === 'Paused' && (!current.pausedUntil || date < current.pausedUntil)) {
        return; // still paused for this date — don't advance, re-check next run
      }
      if (current.paymentMode === 'Prepay4' && (current.prepaidRemaining || 0) <= 0) {
        return; // out of prepaid deliveries — already alerted when balance hit 0
      }

      const label = upcoming.find(d => d.date === date)?.label || date;
      const result = insertOrderRow({
        name: current.name, phone: current.phone, address: current.address, mapUrl: '',
        deliveryDate: date, deliveryLabel: label,
        q250: current.q250, q500: current.q500, q750: current.q750, q1kg: current.q1kg,
        paymentMethod: current.paymentMode === 'Prepay4' ? 'Online (Prepaid ×4)' : 'Cash on Delivery',
        paymentStatus: current.paymentMode === 'Prepay4' ? 'Paid Online' : '',
        rzpPaymentId: '',
      }, { subscriptionId: current.id, apt: current.apt });

      notifyNewOrder(result.orderId,
        { name: current.name, phone: current.phone, address: current.address, deliveryLabel: label,
          paymentStatus: current.paymentMode === 'Prepay4' ? 'Paid Online' : '' },
        result.aptKey, result.q250, result.q500, result.q750, result.q1kg,
        result.totalGrams, result.totalRs, result.prevGrams, result.newGrams, current.id);

      sheet.getRange(rowIndex, SUB_COL.LAST_MATERIALIZED).setValue(date);

      if (current.paymentMode === 'Prepay4') {
        const remaining = (current.prepaidRemaining || 0) - 1;
        sheet.getRange(rowIndex, SUB_COL.PREPAID_REMAINING).setValue(remaining);
        if (remaining === 0) {
          const { unit } = parseApt(current.address);
          tg(`⚠️ <b>Subscription needs renewal</b>\n${esc(current.id)} — ${esc(current.name)}${unit ? ', Flat ' + esc(unit) : ''}\nJust used their last prepaid delivery. Check the Subscriptions sheet tab and nudge them when convenient.`);
        }
      }
    });
  });
}

// ── ORDER NOTIFICATION ────────────────────────────────────────

function notifyNewOrder(orderId, data, aptKey, q250, q500, q750, q1kg, totalGrams, totalRs, prevGrams, newGrams, subscriptionId) {
  const newKg  = (newGrams / 1000).toFixed(2);
  const meta   = aptMeta(aptKey);

  const items = [];
  if (q250) items.push(`Paneer 250g × ${q250}  —  ₹${q250*PRICING.q250}`);
  if (q500) items.push(`Paneer 500g × ${q500}  —  ₹${q500*PRICING.q500}`);
  if (q750) items.push(`Paneer 750g × ${q750}  —  ₹${q750*PRICING.q750}`);
  if (q1kg) items.push(`Paneer 1kg × ${q1kg}  —  ₹${q1kg*PRICING.q1kg}`);
  const x = parseExtras(data);
  Object.keys(x).forEach(k => {
    if (x[k]) items.push(`${EXTRAS_LABELS[k]} × ${x[k]}  —  ₹${x[k]*EXTRAS_PRICING[k]}`);
  });

  const { unit } = parseApt(data.address);
  const title = subscriptionId
    ? `🔁 Subscription Delivery — ${esc(orderId)}`
    : `New Order — ${esc(orderId)}`;

  const isPaidOnline = String(data.paymentStatus || '').toLowerCase().includes('paid');
  const payLine = isPaidOnline
    ? `✅ Paid online — ₹${totalRs}`
    : `💰 COD — ₹${totalRs} to collect`;

  const msg = [
    `<b>${meta.emoji} ${title}</b>`,
    ``,
    `${esc(data.name)}${unit ? ', Flat ' + esc(unit) : ''}, ${esc(data.phone)}`,
    `${esc(data.deliveryLabel)}`,
    ``,
    items.map(esc).join('\n'),
    totalGrams > 0
      ? `<b>Total: ${(totalGrams/1000).toFixed(2)} kg paneer  ·  ₹${totalRs}</b>`
      : `<b>Total: ₹${totalRs}</b>`,
    ``,
    payLine,
    ``,
    `${esc(meta.key)} running total: <b>${newKg} kg</b>`
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
        `⚠️ <b>Stock Alert — ${esc(meta.key)} · ${esc(label)}</b>`,
        `Running total: <b>${newKg.toFixed(2)} kg</b>  (approaching ${nextBlock} kg block)`,
        ``,
        `Time to order the next ${BLOCK_KG} kg block.`,
        `Send /pause to stop new orders.`
      ].join('\n'));
    }
  }
}

// ── DASHBOARD READ ───────────────────────────────────────────

function getDashboardOrders() {
  return jsonOk(buildDashboardData());
}

// Plain-object version so verify_pin/setup_pin can piggyback the
// dashboard payload on the login response (saves the client a
// second round-trip on first login).
function buildDashboardData() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const today = fmt(new Date(), 'yyyy-MM-dd');
  const deliveryDates = nextDeliveryDates(2).map(d => d.date);
  const deliveryDateSet = {};
  deliveryDates.forEach(d => deliveryDateSet[d] = true);
  const orders = [];
  for (const apt of APARTMENTS.map(a => a.key)) {
    const sheet = ss.getSheetByName(apt);
    if (!sheet || sheet.getLastRow() < 2) continue;
    const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, 25).getValues();
    rows.forEach(r => {
      if (!r[1]) return;
      const deliveryDate = r[6] instanceof Date ? fmt(r[6], 'yyyy-MM-dd') : String(r[6]);
      const paymentStatus = r[16] || '';
      const paymentCollected = r[19] === 'Y';
      const isPaidOnline = String(paymentStatus).toLowerCase() === 'paid online';
      const isPastUnpaidCod = deliveryDate < today && !isPaidOnline && !paymentCollected;

      // The ops Home/Orders tabs only need the next two delivery dates and
      // unresolved old COD rows. Keeping this small prevents dashboard hangs.
      if (!deliveryDateSet[deliveryDate] && !isPastUnpaidCod) return;

      orders.push({
        id:               r[1],
        name:             r[2],
        phone:            r[3],
        address:          r[4],
        deliveryDate:     deliveryDate,
        deliveryLabel:    r[7],
        q250:             parseInt(r[8])  || 0,
        q500:             parseInt(r[9])  || 0,
        q750:             parseInt(r[10]) || 0,
        q1kg:             parseInt(r[11]) || 0,
        totalGrams:       parseInt(r[12]) || 0,
        totalRs:          parseInt(r[13]) || 0,
        paymentMethod:    r[15] || '',
        paymentStatus:    paymentStatus,
        rzpPaymentId:     r[17] || '',
        delivered:        r[18] === 'Y',
        paymentCollected: paymentCollected,
        qChaap:           parseInt(r[21]) || 0,
        qGhee:            parseInt(r[22]) || 0,
        qButter:          parseInt(r[23]) || 0,
        qKhoya:           parseInt(r[24]) || 0,
        apt:              apt,
      });
    });
  }
  // Vendor order status for next two delivery dates
  const p2 = PropertiesService.getScriptProperties();
  const vendorOrdered = {};
  nextDeliveryDates(2).forEach(d => {
    vendorOrdered[d.date] = p2.getProperty('VENDOR_ORDERED_' + d.date) === 'Y';
  });

  return { orders, vendorOrdered };
}

function getDashboardSummary() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const now = new Date();
  // Week starts Monday
  const dow = now.getDay() === 0 ? 6 : now.getDay() - 1;
  const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dow);
  weekStart.setHours(0, 0, 0, 0);

  let collected = 0, codPending = 0, cost = 0, totalKg = 0;
  let allCollected = 0, allCodPending = 0, allCost = 0, allKg = 0;

  for (const apt of APARTMENTS.map(a => a.key)) {
    const sheet = ss.getSheetByName(apt);
    if (!sheet || sheet.getLastRow() < 2) continue;
    const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, 25).getValues();
    rows.forEach(r => {
      if (!r[1]) return;
      const rs   = parseInt(r[13]) || 0;
      const kg   = (parseInt(r[12]) || 0) / 1000;
      const payStatus = String(r[16] || '').toLowerCase();
      const paid = payStatus === 'paid online' || payStatus.startsWith('upi') || payStatus === 'paid' || r[19] === 'Y';
      const delivDate = r[6] instanceof Date ? r[6] : new Date(r[6]);

      // Row procurement cost = paneer (per kg) + Saturday Specials (per unit)
      const rowCost = kg * COST_PER_KG
        + (parseInt(r[21]) || 0) * EXTRAS_COST.chaap
        + (parseInt(r[22]) || 0) * EXTRAS_COST.ghee
        + (parseInt(r[23]) || 0) * EXTRAS_COST.butter
        + (parseInt(r[24]) || 0) * EXTRAS_COST.khoya;

      allKg += kg;
      if (paid) allCollected += rs; else allCodPending += rs;
      allCost += rowCost;

      if (delivDate >= weekStart) {
        totalKg += kg;
        if (paid) collected += rs; else codPending += rs;
        cost += rowCost;
      }
    });
  }

  return jsonOk({
    week:  { collected, codPending, cost: Math.round(cost),   margin: Math.round(collected - cost),   kg: Math.round(totalKg * 100) / 100 },
    total: { collected: allCollected, codPending: allCodPending, cost: Math.round(allCost), margin: Math.round(allCollected - allCost), kg: Math.round(allKg * 100) / 100 },
  });
}

// Only the login that owns an apartment may change its orders' delivered/paid
// state. Rekha can't mark Deepa's buildings and vice-versa.
function authorizeAptAction(payload) {
  const user = validateToken(payload.token);
  if (!user) return { ok: false, resp: jsonOk({ ok: false, error: 'unauthorized' }) };
  if (APT_OWNER[payload.apt] !== user) {
    return { ok: false, resp: jsonOk({ ok: false, error: 'forbidden' }) };
  }
  return { ok: true };
}

function handleMarkDelivered(payload) {
  const auth = authorizeAptAction(payload);
  if (!auth.ok) return auth.resp;
  return markOrderColumn(payload.orderId, payload.apt, 19, payload.value ? 'Y' : '');
}

function handleMarkPaid(payload) {
  const auth = authorizeAptAction(payload);
  if (!auth.ok) return auth.resp;
  return markOrderColumn(payload.orderId, payload.apt, 20, payload.value ? 'Y' : '');
}

function handleMarkVendorOrdered(payload) {
  const p = PropertiesService.getScriptProperties();
  const key = 'VENDOR_ORDERED_' + payload.deliveryDate;
  if (payload.value) {
    p.setProperty(key, 'Y');
  } else {
    p.deleteProperty(key);
  }
  return jsonOk({});
}

// ── EXPENSE HANDLING ─────────────────────────────────────────

function handleLogExpense(payload) {
  const ss    = SpreadsheetApp.openById(SHEET_ID);
  const sheet = getOrCreateExpensesSheet(ss);

  let receiptUrl = '';
  if (payload.receiptB64) {
    try {
      const folder  = getOrCreateReceiptsFolder();
      const decoded = Utilities.base64Decode(payload.receiptB64);
      const ts      = Utilities.formatDate(new Date(), 'Asia/Kolkata', 'yyyyMMdd_HHmmss');
      const blob    = Utilities.newBlob(decoded, 'image/jpeg', 'receipt_' + ts + '.jpg');
      const file    = folder.createFile(blob);
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      receiptUrl = 'https://drive.google.com/uc?id=' + file.getId();
    } catch (ex) {
      Logger.log('Receipt upload error: ' + ex);
    }
  } else if (payload.noReceiptReason) {
    receiptUrl = 'No receipt: ' + payload.noReceiptReason;
  }

  const id  = 'EXP' + Date.now();
  const now = new Date();
  sheet.appendRow([
    now,
    id,
    payload.category    || '',
    payload.description || '',
    parseFloat(payload.amount) || 0,
    payload.date || Utilities.formatDate(now, 'Asia/Kolkata', 'yyyy-MM-dd'),
    receiptUrl,
    payload.loggedBy || '',
  ]);

  return jsonOk({ id, receiptUrl });
}

function handleUpdateExpense(payload) {
  const ss    = SpreadsheetApp.openById(SHEET_ID);
  const sheet = ss.getSheetByName('Expenses');
  if (!sheet || sheet.getLastRow() < 2) return jsonError('sheet not found');
  const ids = sheet.getRange(2, 2, sheet.getLastRow() - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(payload.id)) {
      const row = i + 2;
      sheet.getRange(row, 3).setValue(payload.category    || '');
      sheet.getRange(row, 4).setValue(payload.description || '');
      sheet.getRange(row, 5).setValue(parseFloat(payload.amount) || 0);
      return jsonOk({});
    }
  }
  return jsonOk({});
}

function handleDeleteExpense(payload) {
  const ss    = SpreadsheetApp.openById(SHEET_ID);
  const sheet = ss.getSheetByName('Expenses');
  if (!sheet || sheet.getLastRow() < 2) return jsonOk({});
  const ids = sheet.getRange(2, 2, sheet.getLastRow() - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(payload.id)) {
      sheet.deleteRow(i + 2);
      return jsonOk({});
    }
  }
  return jsonOk({});
}

function getExpensesData() {
  const ss    = SpreadsheetApp.openById(SHEET_ID);
  const sheet = ss.getSheetByName('Expenses');
  if (!sheet || sheet.getLastRow() < 2) return jsonOk({ expenses: [] });
  const numRows = sheet.getLastRow() - 1;
  const rows    = sheet.getRange(2, 1, numRows, 8).getValues();
  const expenses = rows
    .filter(r => r[1])
    .map(r => ({
      id:          String(r[1]),
      category:    r[2] || '',
      description: r[3] || '',
      amount:      parseFloat(r[4]) || 0,
      date:        r[5] instanceof Date
                     ? Utilities.formatDate(r[5], 'Asia/Kolkata', 'yyyy-MM-dd')
                     : String(r[5]),
      receiptUrl:  r[6] || '',
      loggedBy:    r[7] || '',
    }))
    .reverse(); // newest first
  return jsonOk({ expenses });
}

function getOrCreateExpensesSheet(ss) {
  let sheet = ss.getSheetByName('Expenses');
  if (!sheet) {
    sheet = ss.insertSheet('Expenses');
    const headers = ['Timestamp','ID','Category','Description','Amount (₹)','Date','Receipt URL','Logged By'];
    sheet.appendRow(headers);
    const r = sheet.getRange(1, 1, 1, headers.length);
    r.setFontWeight('bold');
    r.setBackground('#1a3a6b');
    r.setFontColor('#ffffff');
  }
  return sheet;
}

function getOrCreateReceiptsFolder() {
  const name = 'DairyBliss Receipts';
  const it   = DriveApp.getFoldersByName(name);
  if (it.hasNext()) return it.next();
  return DriveApp.createFolder(name);
}

function markOrderColumn(orderId, apt, col, value) {
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(apt);
  if (!sheet || sheet.getLastRow() < 2) return jsonError('sheet not found');
  const ids = sheet.getRange(2, 2, sheet.getLastRow() - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) {
    if (ids[i][0] === orderId) {
      sheet.getRange(i + 2, col).setValue(value);
      return jsonOk({});
    }
  }
  return jsonError('order not found');
}

// ── APARTMENT HELPERS ────────────────────────────────────────

// Apartment identity colours. Red/green/yellow are reserved for signal
// semantics (✅ paid, ⚠️ warnings, 🔴 alerts) — never use them here.
const APARTMENTS = [
  { key: 'SPC', label: 'Sobha Palm Court',   emoji: '🟠' },
  { key: 'BNR', label: 'Brigade North Ridge', emoji: '🔵' },
  { key: 'ADG', label: 'Adarsh Greens',       emoji: '🟤' },
  { key: 'BNL', label: 'Bren Northern Lights', emoji: '🟣' }
];

// Which PIN identity (login) owns each apartment's orders. Must match the
// APTS `owner` map in ops/index.html. Rekha (SPC) handles SPC;
// Deepa (BNR) handles BNR + ADG + BNL.
const APT_OWNER = { SPC: 'SPC', BNL: 'BNR', BNR: 'BNR', ADG: 'BNR' };

const APT_PATTERNS = {
  SPC: ['sobha palm court'],
  BNR: ['brigade north ridge', 'brigade northridge', 'brigade north-ridge'],
  ADG: ['adarsh greens', 'adarsh green'],
  BNL: ['bren northern lights', 'bren northern light', 'bren northernlights']
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
  const skipWords = ['sobha', 'brigade', 'adarsh', 'bren', 'bangalore', 'bengaluru', 'karnataka', 'india'];
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

// ── CUTOFF SUMMARY (Tue 8pm → Wed orders, Fri 8pm → Sat orders) ──

/**
 * Triggered at 8pm every day; only fires on Tuesday and Friday.
 * Scheduled trigger (no aptFilter): sends ONE combined order-to-place message.
 * Manual /summary SPC|BNR: sends per-apartment detail (names + flats).
 */
function sendCutoffSummary(aptFilter) {
  // When called from a time-based trigger, Apps Script passes the event object
  // as the first argument. Discard it so we always send the full summary.
  if (aptFilter && typeof aptFilter !== 'string') aptFilter = null;
  const now = new Date();
  const day = now.getDay();

  let deliveryDate, deliveryLabel;
  if (day === 2) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    deliveryDate  = fmt(d, 'yyyy-MM-dd');
    deliveryLabel = fmt(d, 'EEE, d MMM');
  } else if (day === 5) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    deliveryDate  = fmt(d, 'yyyy-MM-dd');
    deliveryLabel = fmt(d, 'EEE, d MMM');
  } else if (!aptFilter) {
    return; // scheduled trigger on non-Tue/Fri — do nothing
  } else {
    // Manual /summary SPC|BNR on any day — use next delivery date
    const next = nextDeliveryDates(1)[0];
    if (!next) { tg('No upcoming delivery dates.'); return; }
    deliveryDate  = next.date;
    deliveryLabel = next.label;
  }

  const ss = SpreadsheetApp.openById(SHEET_ID);

  if (aptFilter) {
    // ── Manual /summary SPC or /summary BNR — per-apartment detail ──
    const apts = APARTMENTS.filter(a => a.key === aptFilter);
    if (apts.length === 0) {
      tg(`Unknown apartment: <code>${esc(aptFilter)}</code>. Use SPC, BNR, ADG, or BNL.`); return;
    }
    apts.forEach(({ key, emoji }) => {
      const sheet  = getOrCreate(ss, key);
      const orders = ordersForDate(sheet, deliveryDate);
      if (orders.length === 0) {
        tg(`${emoji} <b>${esc(key)} — ${esc(deliveryLabel)}</b>\nNo orders.`);
        return;
      }
      const s = sumOrders(orders);
      const lines = [
        `${emoji} <b>${esc(key)} — ${esc(deliveryLabel)}</b>`,
        `${orders.length} orders  ·  ${(s.grams/1000).toFixed(2)} kg  ·  ₹${s.rs}`,
        ``,
      ];
      orders.forEach((o, i) => {
        const { unit } = parseApt(o.address);
        const items = [];
        if (o.q250) items.push(`250g×${o.q250}`);
        if (o.q500) items.push(`500g×${o.q500}`);
        if (o.q750) items.push(`750g×${o.q750}`);
        if (o.q1kg) items.push(`1kg×${o.q1kg}`);
        if (o.chaap)  items.push(`Chaap×${o.chaap}`);
        if (o.ghee)   items.push(`Ghee×${o.ghee}`);
        if (o.butter) items.push(`Butter×${o.butter}`);
        if (o.khoya)  items.push(`Khoya×${o.khoya}`);
        lines.push(`${i+1}. ${esc(o.name)}${unit ? ', Flat ' + esc(unit) : ''}  —  ${items.join(', ')}`);
      });
      tg(lines.join('\n'));
    });

  } else {
    // ── Scheduled trigger — combined order-to-place summary ──
    const combined = { q250:0, q500:0, q750:0, q1kg:0,
                       chaap:0, ghee:0, butter:0, khoya:0, grams:0, rs:0 };
    const aptLines = [];

    APARTMENTS.forEach(({ key, emoji }) => {
      const sheet  = getOrCreate(ss, key);
      const orders = ordersForDate(sheet, deliveryDate);
      const s      = sumOrders(orders);
      combined.q250  += s.q250;  combined.q500  += s.q500;
      combined.q750  += s.q750;  combined.q1kg  += s.q1kg;
      combined.chaap  += s.chaap;  combined.ghee  += s.ghee;
      combined.butter += s.butter; combined.khoya += s.khoya;
      combined.grams += s.grams; combined.rs    += s.rs;
      if (orders.length === 0) return;
      const kg = (s.grams / 1000).toFixed(2);
      aptLines.push(`${emoji} ${key}: ${orders.length} order${orders.length !== 1 ? 's' : ''} · ${kg} kg · ₹${s.rs}`);
    });

    if (combined.grams === 0 && combined.rs === 0) {
      tg(`No orders for <b>${esc(deliveryLabel)}</b>.`);
      return;
    }

    const totalKg   = combined.grams / 1000;
    const buyCost   = Math.round(totalKg * COST_PER_KG);

    const lines = [
      `<b>Place order — ${esc(deliveryLabel)}</b>`,
      ``,
    ];
    if (combined.q250) lines.push(`250g × ${combined.q250}`);
    if (combined.q500) lines.push(`500g × ${combined.q500}`);
    if (combined.q750) lines.push(`750g × ${combined.q750}`);
    if (combined.q1kg) lines.push(`1kg  × ${combined.q1kg}`);
    if (combined.chaap)  lines.push(`Soya Chaap × ${combined.chaap}`);
    if (combined.ghee)   lines.push(`Desi Ghee × ${combined.ghee}`);
    if (combined.butter) lines.push(`White Butter × ${combined.butter}`);
    if (combined.khoya)  lines.push(`Khoya × ${combined.khoya}`);
    lines.push(
      ``,
      `<b>${totalKg.toFixed(2)} kg paneer</b>`,
      `Paneer cost ₹${buyCost}  ·  Collect ₹${combined.rs}`,
      ``
    );
    aptLines.forEach(l => lines.push(l));

    // Vendor order status
    const p3 = PropertiesService.getScriptProperties();
    const vendorPlaced = p3.getProperty('VENDOR_ORDERED_' + deliveryDate) === 'Y';
    lines.push(``, vendorPlaced ? `✅ Vendor order placed` : `⚠️ Vendor order not yet placed`);

    tg(lines.join('\n'));
  }
}

// ── DAILY TOTALS DIGEST (9pm every day) ─────────────────────────
// Unlike sendCutoffSummary (which only fires content on Tue/Fri, for the
// single date about to close), this runs every day and shows a running
// snapshot — paneer AND Saturday Specials — for both upcoming delivery
// dates, broken out per apartment. Paneer and Specials orders can target
// different dates (a customer can order paneer for Wed and Specials for
// the following Sat in the same checkout), so both dates are shown per
// apartment rather than picking just one.
function sendDailyTotals() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const upcoming = nextDeliveryDates(2); // [{date, label, open}, ...]
  if (upcoming.length === 0) return;

  const lines = [`<b>📊 Daily Totals — ${fmt(new Date(), 'EEE d MMM, h:mm a')}</b>`];

  APARTMENTS.forEach(({ key, label, emoji }) => {
    const sheet = getOrCreate(ss, key);
    const aptLines = [];
    upcoming.forEach(({ date, label: dLabel }) => {
      const orders = ordersForDate(sheet, date);
      if (orders.length === 0) { aptLines.push(`${dLabel}: no orders yet`); return; }
      const s = sumOrders(orders);
      const parts = [`${orders.length} order${orders.length !== 1 ? 's' : ''}`];
      if (s.grams) parts.push(`${(s.grams/1000).toFixed(2)} kg paneer`);
      const specials = [];
      if (s.chaap)  specials.push(`Chaap×${s.chaap}`);
      if (s.ghee)   specials.push(`Ghee×${s.ghee}`);
      if (s.butter) specials.push(`Butter×${s.butter}`);
      if (s.khoya)  specials.push(`Khoya×${s.khoya}`);
      if (specials.length) parts.push(specials.join(', '));
      parts.push(`₹${s.rs}`);
      aptLines.push(`${dLabel}: ${parts.join(' · ')}`);
    });
    lines.push(``, `${emoji} <b>${esc(label)}</b>`, ...aptLines.map(esc));
  });

  tg(lines.join('\n'));
}

function sumOrders(orders) {
  return orders.reduce((acc, o) => {
    acc.q250  += o.q250;  acc.q500  += o.q500;
    acc.q750  += o.q750;  acc.q1kg  += o.q1kg;
    acc.chaap  += o.chaap  || 0;  acc.ghee  += o.ghee  || 0;
    acc.butter += o.butter || 0;  acc.khoya += o.khoya || 0;
    acc.grams += o.q250*250 + o.q500*500 + o.q750*750 + o.q1kg*1000;
    acc.rs    += o.q250*PRICING.q250 + o.q500*PRICING.q500
               + o.q750*PRICING.q750 + o.q1kg*PRICING.q1kg
               + (o.chaap||0)*EXTRAS_PRICING.chaap + (o.ghee||0)*EXTRAS_PRICING.ghee
               + (o.butter||0)*EXTRAS_PRICING.butter + (o.khoya||0)*EXTRAS_PRICING.khoya;
    return acc;
  }, { q250:0, q500:0, q750:0, q1kg:0, chaap:0, ghee:0, butter:0, khoya:0, grams:0, rs:0 });
}

// ── TELEGRAM COMMAND HANDLING ─────────────────────────────────

function handleTelegramUpdate(update) {
  // Deduplicate: Telegram retries the webhook if we don't respond in time (GAS cold start).
  // Track the last processed update_id so retries are ignored.
  const updateId = String(update.update_id || '');
  if (updateId) {
    const lastId = PropertiesService.getScriptProperties().getProperty('TG_LAST_UPDATE_ID');
    if (lastId && Number(updateId) <= Number(lastId)) return; // already processed
    PropertiesService.getScriptProperties().setProperty('TG_LAST_UPDATE_ID', updateId);
  }

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
        `/status SPC, BNR, ADG, or BNL — one apartment`,
        `/summary — Full order list (all apartments)`,
        `/summary SPC, BNR, ADG, or BNL — one apartment`,
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
  if (aptFilter && typeof aptFilter !== 'string') aptFilter = null;
  const ss    = SpreadsheetApp.openById(SHEET_ID);
  const now   = new Date();
  const dates = nextDeliveryDates(2);
  const apts  = aptFilter ? APARTMENTS.filter(a => a.key === aptFilter) : APARTMENTS;

  if (aptFilter && apts.length === 0) {
    tg(`Unknown apartment: <code>${esc(aptFilter)}</code>. Use SPC, BNR, ADG, or BNL.`); return;
  }

  const lines = [`📊 <b>Running Totals — ${fmt(now, 'EEE d MMM, h:mm a')}</b>`, ``];

  dates.forEach(({date, label, open}) => {
    lines.push(`<b>${esc(label)}</b>  (${open ? 'open' : 'closed'})`);

    apts.forEach(({ key, emoji }) => {
      const sheet = getOrCreate(ss, key);
      const s     = statsForDate(sheet, date);
      const kg    = (s.totalGrams / 1000).toFixed(2);
      if (s.orders === 0) {
        lines.push(`  ${emoji} ${key}: no orders yet`);
      } else {
        lines.push(`  ${emoji} ${key}: ${s.orders} order${s.orders !== 1 ? 's' : ''} · <b>${kg} kg</b> · ₹${s.totalRs}`);
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

  // Cutoff summary: 8pm every day — function checks if it's Tue or Fri inside
  ScriptApp.newTrigger('sendCutoffSummary')
    .timeBased().atHour(20).everyDays(1).create();

  // Subscription materialization: 6am every day, well before the 8pm
  // vendor-order cutoff, so today's subscription deliveries are ordinary
  // rows by the time that summary runs its procurement math.
  ScriptApp.newTrigger('materializeSubscriptions')
    .timeBased().atHour(6).everyDays(1).create();

  // Daily totals digest: 9pm every day (an hour after the cutoff summary,
  // which only fires content on Tue/Fri) — a running snapshot across all
  // apartments and both upcoming delivery dates, every single day.
  ScriptApp.newTrigger('sendDailyTotals')
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

// ── ONE-OFF: migrate Nithin Kailas (Bren Northern Lights) ADG → BNL ──
// A customer in Bren Northern Lights was forwarded the Adarsh Greens order
// page, so his order + subscription got filed under ADG with the flat typed
// into the address. This moves his order row(s) to the BNL sheet and relocates
// his subscription to BNL, fixing the address to "Bren Northern Lights, G301".
//
// SAFE TO RUN ONCE. Call migrateNithinToBNL(true) first for a dry-run preview
// (logs what it *would* do, changes nothing), then migrateNithinToBNL() to apply.
// Idempotent: re-running after it's applied finds nothing left in ADG to move.
function migrateNithinToBNL(dryRun) {
  const PHONE10   = '8056081140';                       // canonical identifier
  const NEW_ADDR  = 'Bren Northern Lights, G301';
  const FROM_APT  = 'ADG';
  const TO_APT    = 'BNL';
  const norm = v => String(v || '').replace(/\D/g, '').slice(-10);
  const log  = [];

  const ss = SpreadsheetApp.openById(SHEET_ID);

  // 1) Move order rows: ADG sheet → BNL sheet, address rewritten.
  const src = ss.getSheetByName(FROM_APT);
  let moved = 0;
  if (src && src.getLastRow() >= 2) {
    const width = src.getLastColumn();
    const rows  = src.getRange(2, 1, src.getLastRow() - 1, width).getValues();
    const dst   = getOrCreate(ss, TO_APT);
    ensureOrderHeaders(dst);
    const toDelete = [];                                // sheet row indices (1-based)
    rows.forEach((row, i) => {
      if (norm(row[3]) !== PHONE10) return;             // col 4 = Phone
      const newRow = row.slice();
      newRow[4] = NEW_ADDR;                             // col 5 = Address
      log.push(`ORDER ${row[1]}: ADG → BNL, address "${row[4]}" → "${NEW_ADDR}"`);
      if (!dryRun) dst.appendRow(newRow);
      toDelete.push(i + 2);
      moved++;
    });
    // Delete moved rows from ADG bottom-up so indices stay valid.
    if (!dryRun) toDelete.sort((a, b) => b - a).forEach(r => src.deleteRow(r));
  }

  // 2) Relocate subscription(s): apartment → BNL, address fixed. Keeps status
  //    as-is (Active stays Active) so his twice-weekly deliveries continue,
  //    just materialised into the BNL sheet from now on.
  const subs = ss.getSheetByName('Subscriptions');
  let relocated = 0;
  if (subs && subs.getLastRow() >= 2) {
    const data = subs.getRange(2, 1, subs.getLastRow() - 1, subs.getLastColumn()).getValues();
    data.forEach((row, i) => {
      if (norm(row[SUB_COL.PHONE - 1]) !== PHONE10) return;
      const rowIndex = i + 2;
      log.push(`SUB ${row[SUB_COL.ID - 1]}: apt "${row[SUB_COL.APT - 1]}" → ${TO_APT}, ` +
               `address "${row[SUB_COL.ADDRESS - 1]}" → "${NEW_ADDR}"`);
      if (!dryRun) {
        subs.getRange(rowIndex, SUB_COL.APT).setValue(TO_APT);
        subs.getRange(rowIndex, SUB_COL.ADDRESS).setValue(NEW_ADDR);
      }
      relocated++;
    });
  }

  const summary = `${dryRun ? '[DRY RUN] ' : ''}Nithin → BNL: ` +
                  `${moved} order row(s) moved, ${relocated} subscription(s) relocated.`;
  Logger.log(summary);
  log.forEach(l => Logger.log('  ' + l));
  return summary;
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
  sheet.getRange(2, 1, sheet.getLastRow()-1, 21).getValues().forEach(row => {
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
  return sheet.getRange(2, 1, sheet.getLastRow()-1, 25).getValues()
    .filter(r => matchDate(r[6], dateStr))
    .map(r => ({ name:r[2], phone:r[3], address:r[4],
      q250:parseInt(r[8])||0, q500:parseInt(r[9])||0,
      q750:parseInt(r[10])||0, q1kg:parseInt(r[11])||0,
      chaap:parseInt(r[21])||0, ghee:parseInt(r[22])||0,
      butter:parseInt(r[23])||0, khoya:parseInt(r[24])||0 }));
}

function matchDate(cell, dateStr) {
  if (!cell) return false;
  if (cell instanceof Date) return fmt(cell, 'yyyy-MM-dd') === dateStr;
  return String(cell).includes(dateStr);
}

/**
 * Returns the next n delivery dates (Wed=3, Sat=6) with an open/closed flag.
 * Wed cutoff: the Monday before at 8pm IST.
 * Sat cutoff: the Friday before at 8pm IST.
 * A date is "open" if now is before its cutoff.
 */
function nextDeliveryDates(n) {
  const result = [];
  const now    = new Date();

  for (let offset = 1; result.length < n && offset < 15; offset++) {
    const d  = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
    const wd = d.getDay();
    if (wd !== 3 && wd !== 6) continue;

    // Cutoff = 2 days before (Mon for Wed, Fri for Sat) at 20:00 IST
    const cutoffDay = wd === 3 ? d.getDate() - 2 : d.getDate() - 1;
    const cutoff    = new Date(d.getFullYear(), d.getMonth(), cutoffDay, 20, 0, 0);

    result.push({
      date:  fmt(d, 'yyyy-MM-dd'),
      label: fmt(d, 'EEE, d MMM'),
      open:  now < cutoff
    });
  }
  return result;
}

// Is dateStr one of the next two valid delivery dates? Used to reject a
// one-off order or a new subscription's first delivery once that date's
// ordering window has effectively passed.
function isDateOrderable(dateStr) {
  return nextDeliveryDates(2).some(d => d.date === dateStr);
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

// ── PIN RESET UTILITIES ───────────────────────────────────────
// Run these manually from the Apps Script editor when a PIN needs to be reset.
// After reset, the user will be prompted to set up a new PIN via OTP on next login.

function resetSpcPin() {
  const p = PropertiesService.getScriptProperties();
  p.deleteProperty('PIN_SPC');
  p.deleteProperty('OTP_SPC');
  p.deleteProperty('SETUP_TOKEN_SPC');
  Logger.log('Rekha (SPC) PIN reset ✓ — she can set a new PIN via OTP on next login');
}

function resetBnrPin() {
  const p = PropertiesService.getScriptProperties();
  p.deleteProperty('PIN_BNR');
  p.deleteProperty('OTP_BNR');
  p.deleteProperty('SETUP_TOKEN_BNR');
  Logger.log('Deepa (BNR) PIN reset ✓ — she can set a new PIN via OTP on next login');
}

// ── CLEAN UP TABLE (run once from editor) ────────────────────────────
// Normalises payment statuses to canonical values and auto-fills
// Payment Method where it is blank.
//
//  Old value                  → Canonical
//  "UPI"                      → "Paid Online"
//  "UPI - Customer Confirmed" → "Paid Online"
//  "Cash on Delivery"         → "Cash on Delivery"  (unchanged)
//  "Paid Online"              → "Paid Online"        (unchanged)
//
// Payment Method is back-filled from Payment Status when blank:
//  Paid Online → "Online"
//  Cash on Delivery → "COD"
//
function cleanupTable() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  let fixed = 0;

  for (const aptName of APARTMENTS.map(a => a.key)) {
    const sheet = ss.getSheetByName(aptName);
    if (!sheet || sheet.getLastRow() < 2) continue;

    const numRows = sheet.getLastRow() - 1;
    // Cols: P=16 (paymentMethod), Q=17 (paymentStatus) — 1-indexed
    const methodRange  = sheet.getRange(2, 16, numRows, 1);
    const statusRange  = sheet.getRange(2, 17, numRows, 1);
    const methodVals   = methodRange.getValues();
    const statusVals   = statusRange.getValues();

    for (let i = 0; i < numRows; i++) {
      const raw    = String(statusVals[i][0] || '').trim();
      const lo     = raw.toLowerCase();
      let canonical = raw;

      if (lo === 'paid online')                           canonical = 'Paid Online';
      else if (lo.startsWith('upi'))                      canonical = 'Paid Online';
      else if (lo === 'cash on delivery' || lo === 'cod') canonical = 'Cash on Delivery';

      if (canonical !== raw) {
        statusVals[i][0] = canonical;
        fixed++;
      }

      // Back-fill Payment Method if empty
      if (!methodVals[i][0]) {
        methodVals[i][0] = canonical === 'Paid Online' ? 'Online' : 'COD';
        fixed++;
      }
    }

    statusRange.setValues(statusVals);
    methodRange.setValues(methodVals);
    Logger.log('✅ ' + aptName + ' cleaned');
  }

  Logger.log('Done — ' + fixed + ' cell(s) updated.');
}

// ── FIX SHEET HEADERS (run once from editor if headers are missing) ──
// Rewrites the full header row for SPC and BNR sheets so all 20 columns are labelled.
function fixSheetHeaders() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const headers = ORDER_HEADERS;
  for (const aptName of APARTMENTS.map(a => a.key)) {
    const sheet = ss.getSheetByName(aptName);
    if (!sheet) continue;
    const r = sheet.getRange(1, 1, 1, headers.length);
    r.setValues([headers]);
    r.setFontWeight('bold');
    r.setBackground('#2d5a1b');
    r.setFontColor('#ffffff');
    sheet.setFrozenRows(1);
    Logger.log('✅ Headers fixed for ' + aptName);
  }
}

