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
const SHEET_ID         = '12GmEb14sM0YC40TkpeyK2eBF2VxKPniCskIMzAWD-P0';

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
    if (payload.action === 'order')            return handleOrder(payload);
    if (payload.action === 'create_rzp_order') return handleCreateRzpOrder(payload);

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

  // Dashboard endpoints require a valid token
  const tokenUser = validateToken(e.parameter.token);
  if (!tokenUser) return jsonOk({ ok: false, error: 'unauthorized' });

  if (e.parameter.action === 'dashboard') return getDashboardOrders();
  if (e.parameter.action === 'summary')   return getDashboardSummary();
  if (e.parameter.action === 'expenses')  return getExpensesData();
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

  return jsonOk({ ok: true, user, token });
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

  return jsonOk({ ok: true, user: apt, token });
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

// ── ORDER HANDLING ───────────────────────────────────────────

function handleOrder(data) {
  if (!isOrdersEnabled()) {
    return jsonOk({ ok: false, paused: true,
      message: "We're not taking orders right now. Check back soon!" });
  }

  // Validate delivery date — reject if cutoff has passed (Tue ≥ 9PM closes Wed, Fri ≥ 9PM closes Sat)
  if (data.deliveryDate) {
    const now     = new Date();
    const day     = now.getDay();   // 0=Sun … 6=Sat
    const hour    = now.getHours(); // IST
    const CUTOFF  = 21;             // 9 PM
    const validDates = nextDeliveryDates(2).map(d => d.date);
    if (!validDates.includes(data.deliveryDate)) {
      return jsonOk({ ok: false, paused: true,
        message: "Orders for that date are now closed. Please choose an available date." });
    }
  }

  const ss       = SpreadsheetApp.openById(SHEET_ID);
  const aptKey   = parseApt(data.address).apt;           // 'SPC', 'BNR', or 'Other'
  const tabName  = aptKey !== 'Other' ? aptKey : 'Other';
  const sheet    = getOrCreate(ss, tabName);
  ensureOrderHeaders(sheet);

  const orderId = nextOrderId();
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
    'New',
    data.paymentMethod || '',
    data.paymentStatus || '',
    data.rzpPaymentId  || '',
    '',   // Delivered
    '',   // Payment Collected
  ]);

  const newGrams = prevGrams + totalGrams;

  notifyNewOrder(orderId, data, aptKey, q250, q500, q750, q1kg, totalGrams, totalRs, prevGrams, newGrams);

  return jsonOk({ orderId });
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

function ensureOrderHeaders(sheet) {
  if (sheet.getLastRow() > 0) return;
  const headers = ['Timestamp','Order ID','Name','Phone','Address','Map URL',
    'Delivery Date','Delivery Label','250g','500g','750g','1kg',
    'Total (g)','Total (₹)','Status',
    'Payment Method','Payment Status','RZP Payment ID',
    'Delivered','Payment Collected'];
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
    `<b>${meta.emoji} New Order — ${esc(orderId)}</b>`,
    ``,
    `${esc(data.name)}${unit ? ', ' + esc(unit) : ''}, ${esc(data.phone)}`,
    `${esc(data.deliveryLabel)}`,
    ``,
    items.map(esc).join('\n'),
    ``,
    `<b>Total: ${(totalGrams/1000).toFixed(2)} kg  ·  ₹${totalRs}</b>`,
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
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const today = fmt(new Date(), 'yyyy-MM-dd');
  const deliveryDates = nextDeliveryDates(2).map(d => d.date);
  const deliveryDateSet = {};
  deliveryDates.forEach(d => deliveryDateSet[d] = true);
  const orders = [];
  for (const apt of ['SPC', 'BNR']) {
    const sheet = ss.getSheetByName(apt);
    if (!sheet || sheet.getLastRow() < 2) continue;
    const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, 20).getValues();
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

  return jsonOk({ orders, vendorOrdered });
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

  for (const apt of ['SPC', 'BNR']) {
    const sheet = ss.getSheetByName(apt);
    if (!sheet || sheet.getLastRow() < 2) continue;
    const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, 20).getValues();
    rows.forEach(r => {
      if (!r[1]) return;
      const rs   = parseInt(r[13]) || 0;
      const kg   = (parseInt(r[12]) || 0) / 1000;
      const payStatus = String(r[16] || '').toLowerCase();
      const paid = payStatus === 'paid online' || payStatus.startsWith('upi') || payStatus === 'paid' || r[19] === 'Y';
      const delivDate = r[6] instanceof Date ? r[6] : new Date(r[6]);

      allKg += kg;
      if (paid) allCollected += rs; else allCodPending += rs;
      allCost += kg * COST_PER_KG;

      if (delivDate >= weekStart) {
        totalKg += kg;
        if (paid) collected += rs; else codPending += rs;
        cost += kg * COST_PER_KG;
      }
    });
  }

  return jsonOk({
    week:  { collected, codPending, cost: Math.round(cost),   margin: Math.round(collected - cost),   kg: Math.round(totalKg * 100) / 100 },
    total: { collected: allCollected, codPending: allCodPending, cost: Math.round(allCost), margin: Math.round(allCollected - allCost), kg: Math.round(allKg * 100) / 100 },
  });
}

function handleMarkDelivered(payload) {
  return markOrderColumn(payload.orderId, payload.apt, 19, payload.value ? 'Y' : '');
}

function handleMarkPaid(payload) {
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

const APARTMENTS = [
  { key: 'SPC', label: 'Sobha Palm Court',   emoji: '🟢' },
  { key: 'BNR', label: 'Brigade North Ridge', emoji: '🔵' }
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
      tg(`Unknown apartment: <code>${esc(aptFilter)}</code>. Use SPC or BNR.`); return;
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
        lines.push(`${i+1}. ${esc(o.name)}${unit ? ', ' + esc(unit) : ''}  —  ${items.join(', ')}`);
      });
      tg(lines.join('\n'));
    });

  } else {
    // ── Scheduled trigger — combined order-to-place summary ──
    const combined = { q250:0, q500:0, q750:0, q1kg:0, grams:0, rs:0 };
    const aptLines = [];

    APARTMENTS.forEach(({ key, emoji }) => {
      const sheet  = getOrCreate(ss, key);
      const orders = ordersForDate(sheet, deliveryDate);
      const s      = sumOrders(orders);
      combined.q250  += s.q250;  combined.q500  += s.q500;
      combined.q750  += s.q750;  combined.q1kg  += s.q1kg;
      combined.grams += s.grams; combined.rs    += s.rs;
      if (orders.length === 0) return;
      const kg = (s.grams / 1000).toFixed(2);
      aptLines.push(`${emoji} ${key}: ${orders.length} order${orders.length !== 1 ? 's' : ''} · ${kg} kg · ₹${s.rs}`);
    });

    if (combined.grams === 0) {
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
    lines.push(
      ``,
      `<b>${totalKg.toFixed(2)} kg total</b>`,
      `Cost ₹${buyCost}  ·  Collect ₹${combined.rs}`,
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

function sumOrders(orders) {
  return orders.reduce((acc, o) => {
    acc.q250  += o.q250;  acc.q500  += o.q500;
    acc.q750  += o.q750;  acc.q1kg  += o.q1kg;
    acc.grams += o.q250*250 + o.q500*500 + o.q750*750 + o.q1kg*1000;
    acc.rs    += o.q250*145 + o.q500*280 + o.q750*420 + o.q1kg*550;
    return acc;
  }, { q250:0, q500:0, q750:0, q1kg:0, grams:0, rs:0 });
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
  if (aptFilter && typeof aptFilter !== 'string') aptFilter = null;
  const ss    = SpreadsheetApp.openById(SHEET_ID);
  const now   = new Date();
  const dates = nextDeliveryDates(2);
  const apts  = aptFilter ? APARTMENTS.filter(a => a.key === aptFilter) : APARTMENTS;

  if (aptFilter && apts.length === 0) {
    tg(`Unknown apartment: <code>${esc(aptFilter)}</code>. Use SPC or BNR.`); return;
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
  sheet.getRange(2, 1, sheet.getLastRow()-1, 20).getValues().forEach(row => {
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
  return sheet.getRange(2, 1, sheet.getLastRow()-1, 20).getValues()
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

  for (const aptName of ['SPC', 'BNR']) {
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
  const headers = [
    'Timestamp', 'Order ID', 'Name', 'Phone', 'Address', 'Map URL',
    'Delivery Date', 'Delivery Label', '250g', '500g', '750g', '1kg',
    'Total (g)', 'Total (₹)', 'Status',
    'Payment Method', 'Payment Status', 'RZP Payment ID',
    'Delivered', 'Payment Collected'
  ];
  for (const aptName of ['SPC', 'BNR']) {
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

