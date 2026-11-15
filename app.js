const APP_VERSION = '28';
/* יומן הטיפולים – גרסת אנדרואיד (אפליקציית רשת).
   כל הנתונים נשמרים ב-Google Calendar, באותם שדות שאפליקציית Windows משתמשת בהם,
   ולכן שתי האפליקציות מסונכרנות. */
'use strict';

// ------------------------------------------------------------------ קבועים
const SCOPES = 'https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/gmail.send';
const INBOX_FOLDER = 'יומן הטיפולים – לטיפול', INBOX_DONE = 'טופלו';
const SCOPE_LIST = SCOPES.split(' ');
const PAY_KEYS = ['paid', 'pay_method', 'pay_note', 'pay_amount', 'pay_total', 'pay_date', 'pay_ref', 'pay_payer', 'pay_receipt'];
const RECEIPTS_FOLDER = 'יומן הטיפולים – אישורי תשלום';
const CANCEL_KEYS = ['cancel_reason', 'cancel_note'];
const RCPT_KEYS = ['rcpt_issued', 'rcpt_no', 'rcpt_date', 'rcpt_doc', 'rcpt_url', 'rcpt_file', 'rcpt_count', 'rcpt_src'];
const APP_KEYS = ['attended', ...PAY_KEYS, ...CANCEL_KEYS, ...RCPT_KEYS, 'price', 'session_no'];  // זהה ל-Windows
const CANCEL_REASONS = [['client', 'ביטול של המטופל/ת'], ['sick', 'מחלה'], ['me', 'ביטול שלי'], ['holiday', 'חג / חופשה'], ['noshow', 'לא הגיע/ה בלי הודעה'], ['other', 'אחר']];
const APP_FOLDER = 'יומן הטיפולים', BACKUPS_FOLDER = 'גיבויים', SETTINGS_FILE = 'הגדרות.json', BACKUP_KEEP = 30;
const DEFAULT_MORNING = { env: 'sandbox', item: 'טיפול בקלינאות תקשורת', template: 'עבור {מספר_טיפולים} טיפולים בתאריכים: {תאריכים}', vat_included: true, send_email: true };
const DEFAULT_SETTINGS = { version: 1, default_price: 0, clients: {}, backup_email: true, holidays: true, morning: { ...DEFAULT_MORNING } };
// ---- חגי ישראל (לוח ישראלי, שמות בעברית) מ-hebcal.com – זהה ל-Windows
const HOL = {};  // 'YYYY-MM-DD' → [[שם, 'yomtov'|'other']]
const HOL_BG = { yomtov: '#FFF1D6', other: '#EEF2FF' }, HOL_FG = { yomtov: '#7A4B00', other: '#3B4A86' };
const holidaysOn = d => S.settings.holidays !== false ? (HOL[isoDate(d)] || []) : [];
const holidayKind = d => { const h = holidaysOn(d); return h.length ? (h.some(x => x[1] === 'yomtov') ? 'yomtov' : 'other') : null; };
const holidayLabel = d => holidaysOn(d).map(x => x[0]).join(' · ');
const holLoading = new Set();
function addHolidays(year, items) {
  for (const k of Object.keys(HOL)) if (k.startsWith(year + '-')) delete HOL[k];
  for (const h of items) (HOL[h.date] = HOL[h.date] || []).push([h.name, h.kind]);
}
async function fetchHolidays(year) {
  if (DEMO) return [{ date: `${year}-12-04`, name: 'ערב חנוכה', kind: 'other' }, { date: `${year}-12-05`, name: 'חנוכה: א׳ נר', kind: 'other' }, { date: `${year}-11-17`, name: 'יום טוב לדוגמה', kind: 'yomtov' }];
  const q = new URLSearchParams({ v: '1', cfg: 'json', maj: 'on', min: 'on', mod: 'on', mf: 'on', ss: 'off', nx: 'off', s: 'off', c: 'off', i: 'on', start: `${year}-01-01`, end: `${year}-12-31` });
  const r = await fetch('https://www.hebcal.com/hebcal?' + q); if (!r.ok) throw new Error('hebcal ' + r.status);
  return ((await r.json()).items || []).filter(it => it.category === 'holiday' && it.date)
    .map(it => ({ date: it.date.slice(0, 10), name: it.hebrew || it.title || '', kind: it.yomtov ? 'yomtov' : 'other' }));
}
function ensureHolidays(days) {
  if (S.settings.holidays === false || !days.length) return;
  const cache = store.get('holidays', {});
  for (const y of new Set([days[0].getFullYear(), days[days.length - 1].getFullYear(), new Date().getFullYear()])) {
    const c = cache[y];
    if (c && !Object.keys(HOL).some(k => k.startsWith(y + '-'))) addHolidays(y, c.items);
    if ((c && Date.now() - c.ts < 30 * 864e5) || holLoading.has(y)) continue;
    holLoading.add(y);
    fetchHolidays(y).then(items => {
      const all = store.get('holidays', {}); all[y] = { ts: Date.now(), items }; store.set('holidays', all);
      addHolidays(y, items); renderView.keepScroll = true; renderView();
    }).catch(e => toast(`לא הצלחתי לטעון את חגי ישראל (${y}): ${e.message}`)).finally(() => holLoading.delete(y));
  }
}
const GEMINI_MODELS = ['gemini-flash-latest', 'gemini-2.5-flash', 'gemini-flash-lite-latest'];
const GEMINI_BUSY = [500, 502, 503, 504];  // עומס זמני אצל Google: מנסים מודל אחר, ואחרי כמה שניות שוב
const GEMINI_BUSY_MSG = 'Gemini עמוס כרגע אצל Google (זה זמני). נסי שוב בעוד דקה–שתיים.';
// כל ניסיון: מודל, ואחרי סבב מלא – המתנה קצרה וסבב נוסף (עד 3 סבבים)
const geminiAttempts = () => [0, 1, 2].flatMap(round => GEMINI_MODELS.map((model, i) => ({ model, wait: i === 0 && round ? 3000 * round : 0 })));
const API = 'https://www.googleapis.com/calendar/v3';
const DEFAULT_TZ = 'Asia/Jerusalem';
const DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
const DAYS_S = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'];
const MONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
const PAY_METHODS = [['cash', 'מזומן'], ['bank', 'העברה בנקאית'], ['bit', 'ביט'], ['paybox', 'פייבוקס'], ['other', 'אחר']];
const REMINDERS = [[0, 'ללא תזכורת'], [5, '5 דק׳ לפני'], [10, '10 דק׳ לפני'], [15, '15 דק׳ לפני'],
  [30, '30 דק׳ לפני'], [60, 'שעה לפני'], [120, 'שעתיים לפני'], [1440, 'יום לפני']];
const EVENT_COLORS = { 1: '#7986CB', 2: '#33B679', 3: '#8E24AA', 4: '#E67C73', 5: '#F6BF26', 6: '#F4511E',
  7: '#039BE5', 8: '#616161', 9: '#3F51B5', 10: '#0B8043', 11: '#D50000' };
const ALL = '__all__';
const DEMO = new URLSearchParams(location.search).has('demo');
const ICON = {
  check: '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 6.5l2.5 2.5L10 3.5"/></svg>',
  x: '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M3 3l6 6M9 3l-6 6"/></svg>',
};

// ------------------------------------------------------------------ אחסון מקומי
const store = {
  get(k, d) { try { const v = localStorage.getItem('tc_' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('tc_' + k, JSON.stringify(v)); } catch { /* ignore */ } },
};

// ------------------------------------------------------------------ מצב
const S = {
  clientId: store.get('clientId', ''),
  token: null, tokenExp: 0,
  email: store.get('email', ''),
  calendars: [],
  calId: store.get('calId', null),
  view: store.get('view', 'day'),
  anchor: today(),
  events: [],
  loaded: false,
  sumClient: '', sumFilter: 'all',
  settings: { ...DEFAULT_SETTINGS, ...(store.get('settings', {}) || {}) },
  index: [], numbers: {},  // כל הפגישות בשנתיים האחרונות, בשביל מספור המפגשים
};

// ------------------------------------------------------------------ עזרים
const $ = (s, el = document) => el.querySelector(s);
const pad = n => String(n).padStart(2, '0');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const enc = encodeURIComponent;
function today() { const d = new Date(); d.setHours(0, 0, 0, 0); return d; }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function sameDay(a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }
function weekStart(d) { return addDays(new Date(d.getFullYear(), d.getMonth(), d.getDate()), -d.getDay()); }
function hm(d) { return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
function dmy(d) { return pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + '/' + d.getFullYear(); }
function hebDate(d) { return `${d.getDate()} ב${MONTHS[d.getMonth()]} ${d.getFullYear()}`; }
function isoDate(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function localStr(d) { return isoDate(d) + 'T' + hm(d) + ':00'; }
function parseDateOnly(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
function fromInputs(dateStr, timeStr) { const [y, m, d] = dateStr.split('-').map(Number); const [h, mi] = timeStr.split(':').map(Number); return new Date(y, m - 1, d, h, mi); }
function mins(d) { return d.getHours() * 60 + d.getMinutes(); }
function lengthLabel(m) {
  if (m < 60) return `${m} דק׳`;
  const h = Math.floor(m / 60), r = m % 60;
  return (h === 1 ? 'שעה' : h === 2 ? 'שעתיים' : `${h} שעות`) + (r ? ` ו-${r} דק׳` : '');
}
const LRM = '\u200e';
const ltr = s => LRM + s + LRM;

function evTimes(ev) {
  const s = ev.start || {}, e = ev.end || {};
  if (s.dateTime) return { s: new Date(s.dateTime), e: new Date(e.dateTime), allDay: false };
  const sd = parseDateOnly(s.date); const ed = parseDateOnly(e.date || s.date);
  return { s: sd, e: ed, allDay: true };
}
const props = ev => (ev.extendedProperties && ev.extendedProperties.private) || {};
const attended = ev => props(ev).attended || '';
const paid = ev => props(ev).paid === 'yes';
function payLabel(ev) {
  const p = props(ev);
  if (p.pay_method === 'other') return p.pay_note || 'אחר';
  const m = PAY_METHODS.find(x => x[0] === p.pay_method); return m ? m[1] : '';
}
const title = ev => ev.summary || '(ללא כותרת)';
function toAmount(v) { const n = parseFloat(String(v ?? '').replace(/[₪,\s]/g, '')); return n > 0 ? n : null; }
function fmtMoney(v) { if (!v) return ''; return Math.abs(v - Math.round(v)) < 0.005 ? '₪' + Math.round(v).toLocaleString('he-IL') : '₪' + v.toFixed(2); }
const payAmount = ev => toAmount(props(ev).pay_amount);
function cancelLabel(ev) {
  const p = props(ev); const r = (CANCEL_REASONS.find(x => x[0] === p.cancel_reason) || [])[1] || '';
  if (p.cancel_reason === 'other') return p.cancel_note || 'אחר';
  return r && p.cancel_note ? `${r} – ${p.cancel_note}` : r;
}
const receiptIssued = ev => props(ev).rcpt_issued === 'yes';
function clientPrice(name) { const c = (S.settings.clients || {})[(name || '').trim()] || {}; return toAmount(c.price) || toAmount(S.settings.default_price); }
const evPrice = ev => toAmount(props(ev).price) || clientPrice(title(ev));
// אירוע שאינו טיפול (למשל ישיבת צוות): לא נספר בסיכומים, במספור ובתשלומים – זהה ל-Windows
const isSession = ev => props(ev).kind !== 'event';
const EVENT_COLOR_ID = '8';
// ---- Morning (חשבונית ירוקה): חשבונית מס/קבלה – זהה ל-Windows
const MORNING_URLS = { production: 'https://api.greeninvoice.co.il/api/v1', sandbox: 'https://sandbox.d.greeninvoice.co.il/api/v1' };
// מיוני 2026 Morning עברו להתחברות OAuth בכתובת נפרדת (הכתובת הישנה /account/token חסומה) – זהה ל-Windows
const MORNING_AUTH = { production: 'https://api.morning.co/idp/v1/oauth/token', sandbox: 'https://api.sandbox.morning.dev/idp/v1/oauth/token' };
const MORNING_UPLOAD_URL = 'https://apigw.greeninvoice.co.il/file-upload/v1/url';
const MORNING_PAY = { cash: 1, bank: 4, bit: 10, paybox: 10, other: 11 };
const morningCfg = () => ({ ...DEFAULT_MORNING, ...(S.settings.morning || {}) });
const morningKeys = env => (store.get('morningKeys', {}) || {})[env] || {};
const morningReady = () => { const k = morningKeys(morningCfg().env); return !!(k.id && k.secret); };
const morningRelay = () => (store.get('morningRelay', '') || '').trim();
async function relayPost(payload) {
  // ממסר ב-Google Apps Script: Morning חוסמים פניות ישירות מדפדפן, אז הבקשה עוברת דרך Google
  let r;
  try { r = await fetch(morningRelay(), { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payload), redirect: 'follow' }); }
  catch { throw new Error('לא הצלחתי להתחבר לממסר. בודקים שהכתובת בהגדרות Morning נכונה (מסתיימת ב-/exec), ושבפריסה נבחר Who has access: Anyone.'); }
  let j; try { j = await r.json(); } catch { throw new Error('הממסר לא החזיר תשובה תקינה. בודקים שהכתובת נכונה ושהפריסה היא Web app.'); }
  return j;
}
async function morningCall(env, method, path, body, token) {
  let status, j = {};
  const url = path.startsWith('https://') ? path : MORNING_URLS[env] + path;
  if (morningRelay()) {
    const res = await relayPost({ kind: 'api', url, method, body: body || null, token: token || '' });
    status = res.status; try { j = JSON.parse(res.text || '{}'); } catch { j = { errorMessage: res.text }; }
    if (status === 400 && /רק ל-Morning/.test(res.text || '')) throw new Error('צריך לעדכן את הממסר לגרסה החדשה: מדביקים את הקוד החדש ב-script.google.com, ואז Deploy ← Manage deployments ← ✎ ← Version: New version ← Deploy.');
  } else {
    let r;
    try {
      r = await fetch(url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
    } catch (e) {
      throw new Error('Morning חוסמים חיבור ישיר מהטלפון. כדי להשתמש ב-Morning בטלפון מגדירים ממסר: ☰ ← Morning ← „כתובת ממסר”. בינתיים אפשר להפיק מהמחשב.');
    }
    status = r.status; try { j = await r.json(); } catch { /* ignore */ }
  }
  if (status < 200 || status >= 300) {
    const msg = j.errorMessage || j.message || status;
    if (status === 401 || status === 403) throw new Error(`Morning דחו את החיבור (${status}). בודקים את מפתח ה-API ושהמסלול כולל API.\n${msg}`);
    throw new Error(`שגיאה מ-Morning (${status}): ${msg}`);
  }
  return j;
}
async function morningToken(env) {
  if (DEMO) return 'demo';
  const k = morningKeys(env);
  let j;
  try { j = await morningCall(env, 'POST', MORNING_AUTH[env], { grant_type: 'client_credentials', client_id: k.id, client_secret: k.secret }); }
  catch (e) {
    if (/\((400|401|403|404)\)/.test(e.message)) throw new Error((env === 'sandbox'
      ? 'המפתח לא נמצא בסביבת הבדיקות. מפתח מהחשבון הרגיל ב-Morning עובד רק בסביבה „פעיל”. לסביבת בדיקות צריך חשבון בדיקות נפרד (app.sandbox.d.greeninvoice.co.il) ומפתח משם.'
      : 'Morning לא זיהו את המפתח. בודקים שמזהה המפתח והמפתח הסודי הועתקו במלואם, ושהמפתח פעיל.') + '\nתשובת Morning: ' + (e.message.replace('שגיאה מ-Morning ', 'קוד ').trim() || 'ללא פירוט'));
    throw e;
  }
  const tok = j.accessToken || j.access_token || j.token;
  if (!tok) throw new Error('Morning לא החזירו אישור התחברות. בודקים את מזהה המפתח והסוד.');
  return tok;
}
async function morningMe(env) {
  // בדיקת חיבור: קבלת אישור התחברות, ואם אפשר – שם העסק
  if (DEMO) return { businessName: 'עסק לדוגמה' };
  const tok = await morningToken(env);
  for (const path of ['/users/me', '/businesses/me']) {
    try { return await morningCall(env, 'GET', path, null, tok); } catch (e) { if (!/\(404\)/.test(e.message)) throw e; }
  }
  return {};
}
async function morningUploadExpense(env, blob, name) {
  // מסמך הוצאה (קבלה / חשבונית מספק): Morning קוראים אותו ויוצרים טיוטת הוצאה (זהה ל-Windows)
  if (DEMO) { await new Promise(r => setTimeout(r, 300)); Mock.expenses = (Mock.expenses || 0) + 1; return true; }
  const info = await morningCall(env, 'GET', MORNING_UPLOAD_URL + '?context=expense&data=' + encodeURIComponent(JSON.stringify({ source: 5 })), null, await morningToken(env));
  if (!info || !info.url) throw new Error('Morning לא החזירו כתובת להעלאת הקובץ.');
  if (morningRelay()) {
    const res = await relayPost({ kind: 'upload', url: info.url, fields: info.fields || null, data: await blobToBase64(blob), mime: blob.type || 'application/octet-stream', name });
    if (res.status < 200 || res.status >= 300) throw new Error(`העלאת הקובץ ל-Morning נכשלה (${res.status}). ${res.text || ''}`);
    return true;
  }
  let r;
  if (info.fields && Object.keys(info.fields).length) {
    const fd = new FormData();
    for (const [k, v] of Object.entries(info.fields)) fd.append(k, v);
    fd.append('file', blob, name);
    r = await fetch(info.url, { method: 'POST', body: fd });
  } else r = await fetch(info.url, { method: 'PUT', body: blob, headers: { 'Content-Type': blob.type || 'application/octet-stream' } });
  if (!r.ok) throw new Error(`העלאת הקובץ ל-Morning נכשלה (${r.status}).`);
  return true;
}
function showExpenses(initial = []) {
  if (!morningReady()) { showMorningSettings(() => showExpenses(initial)); return; }
  const m = morningCfg();
  let files = [...initial];
  const sh = openSheet(`<h3 style="margin:4px 0 6px">הוספת הוצאה ל-Morning</h3>
    ${m.env === 'sandbox' ? '<p class="note" style="background:#FFF1D6;color:#7A4B00;padding:6px 8px;border-radius:8px">סביבת בדיקות: ההוצאה תעלה לחשבון הבדיקות, לא לחשבון האמיתי.</p>' : ''}
    <p>בוחרים קבלות או חשבוניות על הוצאות (צילום או PDF). Morning קוראים כל מסמך ויוצרים ממנו טיוטת הוצאה, שמופיעה ב-Morning תחת „הוצאות” לבדיקה ואישור.</p>
    <label class="btn" style="display:block;text-align:center">📷 צילום / בחירת קבצים<input type="file" accept="image/*,application/pdf" multiple id="exFiles" hidden></label>
    <div id="exList" style="margin:8px 0"></div>
    <label class="check"><input type="checkbox" id="exDrive" checked>לשמור עותק גם ב-Google Drive</label>
    <p class="note" id="exStatus" style="white-space:pre-line"></p>
    <div class="actions"><button class="btn primary" id="exGo">העלאה ל-Morning</button><button class="btn" id="exClose">סגירה</button></div>`);
  const draw = () => { $('#exList', sh).innerHTML = files.map(f => `<div class="menu-item" style="padding:8px 4px">${esc(f.name || 'צילום')} · ${Math.max(1, Math.round(f.size / 1024))} KB</div>`).join('') || '<p class="note">לא נבחרו קבצים.</p>'; };
  draw();
  $('#exFiles', sh).onchange = async e => { for (const f of e.target.files) files.push(f.type.startsWith('image/') ? new File([await shrinkImage(f)], f.name, { type: f.type === 'image/png' ? 'image/png' : 'image/jpeg' }) : f); e.target.value = ''; draw(); };
  $('#exClose', sh).onclick = closeSheet;
  $('#exGo', sh).onclick = async () => {
    if (!files.length) { $('#exStatus', sh).textContent = 'לא נבחרו קבצים.'; return; }
    const btn = $('#exGo', sh); btn.disabled = true; $('#exStatus', sh).textContent = 'מעלה…';
    const done = [], failed = [], toDrive = $('#exDrive', sh).checked;
    for (const f of files) {
      const name = f.name || `הוצאה ${isoDate(today())}.jpg`;
      try { await morningUploadExpense(m.env, f, name); done.push(f); }
      catch (e) { failed.push(`• ${name}: ${e.message}`); continue; }
      if (toDrive) { try { const id = await AppData.folder('יומן הטיפולים – הוצאות', null, 'expensesFolder'); if (!DEMO) await multipartUpload({ name, parents: [id] }, f); } catch { /* ignore */ } }
    }
    files = files.filter(f => !done.includes(f)); draw(); btn.disabled = false;
    $('#exStatus', sh).textContent = `✓ הועלו ${done.length} מסמכים ל-Morning. הם יופיעו שם תחת „הוצאות” כטיוטות לבדיקה (לפעמים אחרי דקה).` + (failed.length ? '\n\n⚠ לא הועלו:\n' + failed.join('\n') : '');
  };
}
async function morningCreate(env, body) {
  if (DEMO) { await new Promise(r => setTimeout(r, 400)); return { id: 'demodoc', number: 10045, url: { he: '#' } }; }
  return morningCall(env, 'POST', '/documents', body, await morningToken(env));
}
const sessionAmount = ev => payAmount(ev) || evPrice(ev);
const receiptDatesText = ss => ss.map(e => evTimes(e).s).sort((a, b) => a - b).map(dmy).join(', ');
const renderReceiptText = (tpl, ss, name) => tpl.replace('{תאריכים}', receiptDatesText(ss)).replace('{מספר_טיפולים}', String(ss.length))
  .replace('{שם_מטופל}', name).replace('{סכום}', fmtMoney(ss.reduce((a, e) => a + (sessionAmount(e) || 0), 0)));
function morningDocument(ss, { name, emails, send, item, remarks, date, vatIncluded }) {
  const byPrice = {}, pays = {};
  for (const e of ss) { const a = Math.round(sessionAmount(e) * 100) / 100; byPrice[a] = (byPrice[a] || 0) + 1; }
  for (const e of ss) { const p = props(e), k = (p.pay_method || 'other') + '|' + (p.pay_date || date); pays[k] = Math.round(((pays[k] || 0) + sessionAmount(e)) * 100) / 100; }
  return { type: 320, date, lang: 'he', currency: 'ILS', vatType: 0, rounding: false, signed: true, attachment: !!(send && emails.length),
    client: { name, emails, add: false },
    income: Object.entries(byPrice).sort((a, b) => a[0] - b[0]).map(([price, n]) => ({ description: item, quantity: n, price: Number(price), currency: 'ILS', vatType: vatIncluded ? 1 : 0 })),
    payment: Object.entries(pays).sort((a, b) => a[0].split('|')[1].localeCompare(b[0].split('|')[1])).map(([k, price]) => { const [m, d] = k.split('|'); return { type: MORNING_PAY[m] || 11, price, currency: 'ILS', date: d }; }),
    remarks };
}
function receiptDetails(ev) {
  const p = props(ev), morning = p.rcpt_src === 'morning';
  const bits = [(morning ? 'חשבונית מס/קבלה' : 'קבלה') + (p.rcpt_no ? ' ' + p.rcpt_no : '')];
  if (morning) bits.push('Morning');
  if (p.rcpt_date) bits.push(dmy(parseDateOnly(p.rcpt_date)));
  if (p.rcpt_count && p.rcpt_count !== '1') bits.push(`על ${p.rcpt_count} טיפולים`);
  if (p.rcpt_file) bits.push('📎 מסמך מצורף');
  return bits.join(' · ');
}
function paidWithoutReceipt(extra = []) {
  const seen = new Set(), groups = {};
  for (const e of [...extra, ...S.events, ...S.index]) {
    if (seen.has(e.id) || !isSession(e) || evTimes(e).allDay || !canEdit(e)) continue;
    seen.add(e.id);
    if (paid(e) && !receiptIssued(e)) (groups[title(e).trim()] = groups[title(e).trim()] || []).push(e);
  }
  for (const k of Object.keys(groups)) groups[k].sort((a, b) => evTimes(a).s - evTimes(b).s);
  return groups;
}
const sessionLine = e => `יום ${DAYS[evTimes(e).s.getDay()]} ${dmy(evTimes(e).s)} · ${ltr(hm(evTimes(e).s))}${sessionAmount(e) ? ' · ' + fmtMoney(sessionAmount(e)) : ' · סכום לא ידוע'}${payLabel(e) ? ' · ' + esc(payLabel(e)) : ''}`;

// ---- מייל של המטופל/ת או ההורה, וזימון ליומן (זהה ל-Windows)
const clientInfo = (name, st = S.settings) => ((st.clients || {})[(name || '').trim()]) || {};
const normName = t => (t || '').replace(/["'׳״.,\-()]/g, ' ').split(/\s+/).filter(Boolean).join(' ');
const clientPayers = (name, st) => (clientInfo(name, st).payers || []).filter(Boolean);  // משלמים (הורים וכו׳) – זהה ל-Windows
const parseNames = t => (t || '').replace(/،/g, ',').split(',').map(normName).filter(Boolean);
const clientEmails = (name, st) => (clientInfo(name, st).emails || []).filter(Boolean);
const clientInvites = (name, st) => !!clientInfo(name, st).invite && clientEmails(name, st).length > 0;
function parseEmails(text) {
  const parts = String(text || '').split(/[,;\s]+/).map(x => x.trim()).filter(Boolean);
  const ok = parts.filter(x => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x));
  return [ok, parts.filter(x => !ok.includes(x))];
}
const attendeeFields = (emails, existing = []) => ({ attendees: [...existing.filter(a => !emails.includes(a.email)), ...emails.map(email => ({ email }))],
  guestsCanSeeOtherGuests: false, guestsCanInviteOthers: false, guestsCanModify: false });
const hasGuests = ev => (ev.attendees || []).some(a => !a.self);
const upd = notify => 'sendUpdates=' + (notify ? 'all' : 'none');
// ---- מספור מפגשים (זהה ל-Windows): פגישות שלא התקיימו לא נספרות; מספר שנקבע ידנית קובע גם את הבאים
function sessionMark(ev) {
  // מספר שנקבע ידנית, 'skip' (לא ידוע רק בפגישה הזו), 'stop' (לא ידוע מכאן והלאה), או null
  const v = String(props(ev).session_no || '').trim().toLowerCase();
  if (/^\d+$/.test(v) && Number(v) > 0) return Number(v);
  return v === 'skip' || v === 'stop' ? v : null;
}
const sessionAnchor = ev => { const m = sessionMark(ev); return typeof m === 'number' ? m : null; };
function computeNumbers(events) {
  // מספור נפרד לכל מטופל/ת. בלי מספר שנקבע ידנית – לא ידוע. פגישות שלא התקיימו לא נספרות (זהה ל-Windows)
  const by = {}, nums = {};
  for (const ev of events) { if (evTimes(ev).allDay || !isSession(ev)) continue; (by[title(ev).trim()] = by[title(ev).trim()] || []).push(ev); }
  for (const evs of Object.values(by)) {
    evs.sort((a, b) => evTimes(a).s - evTimes(b).s);
    let cur = null, pending = null;  // מספר שנקבע לפגישה שלא התקיימה עובר לפגישה הבאה שמתקיימת
    for (const e of evs) {
      const m = sessionMark(e);
      if (attended(e) === 'no') { if (typeof m === 'number') pending = m; continue; }
      if (pending !== null && typeof m !== 'number' && m !== 'stop') {
        cur = pending; pending = null;
        if (m === 'skip') { cur -= 1; continue; }
        nums[e.id] = cur; continue;
      }
      pending = null;
      if (typeof m === 'number') cur = m;
      else if (m === 'stop') { cur = null; continue; }
      else if (m === 'skip') continue;
      else if (cur !== null) cur += 1;
      if (cur !== null) nums[e.id] = cur;
    }
  }
  return nums;
}
function numberChanges(ev, { props: np = null, remove = false, start = null, end = null } = {}) {
  // אילו מפגשים אחרים של אותו מטופל/ת ישנו מספר אם נשנה את הפגישה הזו
  if (!S.index.some(e => e.id === ev.id)) return [];
  const before = computeNumbers(S.index);
  const sim = [];
  for (const e of S.index) {
    if (e.id !== ev.id) { sim.push(e); continue; }
    if (remove) continue;
    const e2 = { ...e };
    if (np) e2.extendedProperties = { private: np };
    if (start) { e2.start = { dateTime: start.toISOString() }; e2.end = { dateTime: end.toISOString() }; }
    sim.push(e2);
  }
  const after = computeNumbers(sim), name = title(ev).trim();
  return S.index.filter(e => e.id !== ev.id && title(e).trim() === name && (before[e.id] || null) !== (after[e.id] || null))
    .sort((a, b) => evTimes(a).s - evTimes(b).s).map(e => [e, before[e.id] || null, after[e.id] || null]);
}
async function guardSequence(ev, change, allowKeep = true) {
  // אם השינוי משפיע על המפגשים הבאים – מבקש אישור. מחזיר { ok, pin }
  const ch = numberChanges(ev, change);
  if (!ch.length) return { ok: true, pin: null };
  const f = n => n ? `מפגש ${n}` : 'לא ידוע';
  const lines = ch.slice(0, 6).map(([e, o, n]) => `• ${DAYS[evTimes(e).s.getDay()]} ${dmy(evTimes(e).s)}: ${f(o)} ← ${f(n)}`).join('\n') + (ch.length > 6 ? `\n• ועוד ${ch.length - 6} מפגשים` : '');
  const opts = [{ label: 'כן, לעדכן את כל הרצף', value: 'all', cls: 'primary' }];
  if (allowKeep) opts.push({ label: 'רק המפגש הזה – להשאיר את הבאים', value: 'keep' });
  const choice = await choose('שינוי ברצף המפגשים', `השינוי ישנה את המספור של ${ch.length} מפגשים נוספים של „${title(ev)}”:\n${lines}\n\nלעדכן את כל הרצף?`, opts);
  if (!choice) return { ok: false, pin: null };
  if (choice === 'keep') { const first = ch.find(([, o]) => o); return { ok: true, pin: first ? [first[0], first[1]] : null }; }
  return { ok: true, pin: null };
}
function applyPin(pin) { if (pin) setStatus(pin[0], { session_no: String(pin[1]) }); }
function continuedNumber(ev) {
  const sim = S.index.map(e => e.id === ev.id ? { ...e, extendedProperties: { private: { ...props(ev), session_no: '' } } } : e);
  return computeNumbers(sim)[ev.id] || null;
}
const sessionNo = ev => S.numbers[ev.id] || null;
let indexSeq = 0;
async function loadIndex() {
  if (!S.calendars.length) return;
  const seq = ++indexSeq, now = new Date();
  try {
    const evs = await G.eventsMany(writable(), new Date(now.getTime() - 730 * 864e5), new Date(now.getTime() + 200 * 864e5));
    if (seq !== indexSeq) return;
    S.index = evs; renumber();
    setTimeout(maybeDaySummary, 800);
  } catch { /* ignore */ }
}
function renumber() { S.numbers = computeNumbers(S.index); renderView.keepScroll = true; renderView(); }
function syncIndex(ev) {
  const it = S.index.find(x => x.id === ev.id);
  if (it) it.extendedProperties = JSON.parse(JSON.stringify(ev.extendedProperties || {}));
  S.numbers = computeNumbers(S.index);
}
function changed() { renderView.keepScroll = true; loadEvents(); loadIndex(); }
function payDetails(ev) {
  const p = props(ev), parts = [];
  if (payLabel(ev)) parts.push(payLabel(ev));
  if (payAmount(ev)) { const t = toAmount(p.pay_total); parts.push(fmtMoney(payAmount(ev)) + (t && Math.abs(t - payAmount(ev)) > 0.005 ? ` (מתוך ${fmtMoney(t)})` : '')); }
  if (p.pay_date) { const d = parseDateOnly(p.pay_date); if (!isNaN(d)) parts.push(dmy(d)); }
  if (p.pay_ref) parts.push('אסמכתא ' + p.pay_ref);
  return parts.join(' · ');
}
const canEdit = ev => ['owner', 'writer'].includes(ev._access);
const evColor = ev => EVENT_COLORS[ev.colorId] || ev._color || '#2F6F66';
const calName = c => c.summaryOverride || c.summary || c.id;
const writable = () => S.calendars.filter(c => ['owner', 'writer'].includes(c.accessRole));
const primaryCal = () => S.calendars.find(c => c.primary) || S.calendars[0];
function currentTz() {
  const c = S.calendars.find(c => c.id === S.calId) || primaryCal();
  return (c && c.timeZone) || DEFAULT_TZ;
}

function tagsHtml(ev, short = false) {
  if (!isSession(ev)) return '';
  const t = []; const a = attended(ev);
  if (a === 'yes') t.push(`<span class="tag ok">${ICON.check}${short ? '' : 'התקיימה'}</span>`);
  else if (a === 'no') t.push(`<span class="tag no">${ICON.x}${short ? '' : 'לא התקיימה' + (cancelLabel(ev) ? ' · ' + esc(cancelLabel(ev)) : '')}</span>`);
  if (paid(ev)) t.push(`<span class="tag pay">₪${short ? '' : ' ' + esc(payLabel(ev) || 'שולם')}</span>`);
  else if (a === 'yes') t.push(`<span class="tag unpaid">₪${short ? '' : ' לא שולם'}</span>`);
  if (receiptIssued(ev)) t.push(`<span class="tag doc">🧾${short ? '' : ' קבלה'}</span>`);
  return t.length ? `<div class="tags${short ? ' short' : ''}">${t.join('')}</div>` : '';
}

// ------------------------------------------------------------------ Google
class NeedLogin extends Error {}
const qs = obj => Object.entries(obj)
  .flatMap(([k, v]) => Array.isArray(v) ? v.map(x => [k, x]) : (v === undefined || v === null ? [] : [[k, v]]))
  .map(([k, v]) => enc(k) + '=' + enc(v)).join('&');

async function api(method, path, body, query) {
  if (DEMO) return Mock.handle(method, path, body, query);
  return gfetch(API + path + (query ? '?' + query : ''), { method, json: body });
}
async function gfetch(url, { method = 'GET', json, raw, headers = {}, asBlob = false } = {}) {
  if (!S.token || Date.now() > S.tokenExp) throw new NeedLogin();
  const r = await fetch(url, {
    method,
    headers: { Authorization: 'Bearer ' + S.token, ...(json ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: json ? JSON.stringify(json) : raw,
  });
  if (r.status === 401) { S.token = null; store.set('tok', null); throw new NeedLogin(); }
  if (!r.ok) {
    let msg = 'שגיאה ' + r.status;
    try { const j = await r.json(); msg = (j.error && j.error.message) || msg; } catch { /* ignore */ }
    throw new Error(msg);
  }
  if (asBlob) return r.blob();
  return r.status === 204 ? null : r.json();
}

const G = {
  async calendars() {
    const items = []; let page;
    do { const r = await api('GET', '/users/me/calendarList', null, qs({ pageToken: page })); items.push(...(r.items || [])); page = r.nextPageToken; } while (page);
    return items;
  },
  async events(calId, start, end) {
    const base = { timeMin: start.toISOString(), timeMax: end.toISOString(), singleEvents: 'true', orderBy: 'startTime', maxResults: 250 };
    const run = async types => {
      const items = []; let page;
      do {
        const r = await api('GET', `/calendars/${enc(calId)}/events`, null, qs({ ...base, eventTypes: types, pageToken: page }));
        items.push(...(r.items || [])); page = r.nextPageToken;
      } while (page);
      return items;
    };
    try { return await run(['default', 'fromGmail', 'focusTime', 'outOfOffice', 'workingLocation', 'birthday']); }
    catch (e) { if (e instanceof NeedLogin) throw e; return run(undefined); }
  },
  async eventsMany(cals, start, end) {
    const out = [];
    for (const c of cals) {
      for (const ev of await G.events(c.id, start, end)) {
        ev._calendar = calName(c); ev._calendar_id = c.id; ev._color = c.backgroundColor; ev._access = c.accessRole;
        out.push(ev);
      }
    }
    return out.sort((a, b) => evTimes(a).s - evTimes(b).s);
  },
  get: (c, id) => api('GET', `/calendars/${enc(c)}/events/${enc(id)}`),
  insert: (c, body, notify = false) => api('POST', `/calendars/${enc(c)}/events`, body, upd(notify)),
  patch: (c, id, body, notify = false) => api('PATCH', `/calendars/${enc(c)}/events/${enc(id)}`, body, upd(notify)),
  del: (c, id, notify = false) => api('DELETE', `/calendars/${enc(c)}/events/${enc(id)}`, null, upd(notify)),
  async setInvitees(c, id, add = [], remove = []) {
    const cur = await G.get(c, id);
    const existing = (cur.attendees || []).filter(a => !remove.includes(a.email));
    return G.patch(c, id, add.length ? attendeeFields(add, existing) : { attendees: existing }, true);
  },
  async setProps(c, id, p, attach = null, detach = null) {
    const body = { extendedProperties: { private: p } };
    let q = '';
    if (attach || detach) {
      const cur = await G.get(c, id);
      const atts = (cur.attachments || []).filter(a => a.fileId !== detach && a.fileId !== (attach && attach.id));
      if (attach && !hasGuests(cur)) atts.push({ fileUrl: attach.webViewLink || `https://drive.google.com/file/d/${attach.id}/view`, title: attach.name || 'אישור תשלום', mimeType: attach.mimeType || 'image/jpeg', fileId: attach.id });
      body.attachments = atts; q = 'supportsAttachments=true';
    }
    await api('PATCH', `/calendars/${enc(c)}/events/${enc(id)}`, body, q);
    const fresh = await G.get(c, id);
    const stored = (fresh.extendedProperties && fresh.extendedProperties.private) || {};
    if (Object.entries(p).some(([k, v]) => v && stored[k] !== v)) throw new Error('Google קיבל את הבקשה אבל לא שמר את הסימון.');
    return fresh;
  },
  async updateSeries(c, masterId, body, tz, notify = false, newDate = null) {
    const m = await G.get(c, masterId);
    const ms = m.start || {};
    let mdate = ms.dateTime ? new Date(ms.dateTime) : parseDateOnly(ms.date);
    body = { ...body };
    if (newDate && !sameDay(newDate, mdate)) { mdate = newDate; body.recurrence = rruleWithWeekday(body.recurrence || m.recurrence, newDate); }
    if (body.extendedProperties) body.extendedProperties = { private: { ...((m.extendedProperties || {}).private || {}), ...body.extendedProperties.private } };
    if (body.start) {
      const ns = new Date(body.start.dateTime), ne = new Date(body.end.dateTime);
      const st = new Date(mdate.getFullYear(), mdate.getMonth(), mdate.getDate(), ns.getHours(), ns.getMinutes());
      const en = new Date(st.getTime() + (ne - ns));
      body.start = { dateTime: localStr(st), timeZone: tz };
      body.end = { dateTime: localStr(en), timeZone: tz };
    }
    return G.patch(c, masterId, body, notify);
  },
};

// צילומי אישורי תשלום ב-Google Drive (תיקייה פרטית של האפליקציה, משותפת עם Windows)
const Drive = {
  async folder() {
    if (DEMO) return 'demo-folder';
    let id = store.get('receiptsFolder', '');
    if (id) { try { const f = await gfetch(`https://www.googleapis.com/drive/v3/files/${id}?fields=id,trashed`); if (!f.trashed) return id; } catch (e) { if (e instanceof NeedLogin) throw e; } }
    const q = `name = '${RECEIPTS_FOLDER}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
    const found = await gfetch('https://www.googleapis.com/drive/v3/files?' + qs({ q, spaces: 'drive', fields: 'files(id)' }));
    if (found.files && found.files.length) id = found.files[0].id;
    else id = (await gfetch('https://www.googleapis.com/drive/v3/files?fields=id', { method: 'POST', json: { name: RECEIPTS_FOLDER, mimeType: 'application/vnd.google-apps.folder' } })).id;
    store.set('receiptsFolder', id); return id;
  },
  async upload(blob, name) {
    if (DEMO) { const id = 'demo' + Date.now(); Mock.files[id] = blob; return { id, name, mimeType: blob.type, webViewLink: '#' }; }
    const meta = { name, parents: [await Drive.folder()] };
    const boundary = 'tc' + Math.random().toString(36).slice(2);
    const body = new Blob([`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: ${blob.type || 'image/jpeg'}\r\n\r\n`, blob, `\r\n--${boundary}--`]);
    return gfetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,webViewLink',
      { method: 'POST', raw: body, headers: { 'Content-Type': 'multipart/related; boundary=' + boundary } });
  },
  async download(id) {
    if (DEMO) return Mock.files[id] || new Blob();
    return gfetch(`https://www.googleapis.com/drive/v3/files/${enc(id)}?alt=media`, { asBlob: true });
  },
};

// ---- תיקיית האפליקציה ב-Drive: הגדרות משותפות וגיבויים (משותף עם Windows)
const AppData = {
  async folder(name, parent, key) {
    if (DEMO) return 'demo-' + name;
    let id = store.get(key, '');
    if (id) { try { const f = await gfetch(`https://www.googleapis.com/drive/v3/files/${id}?fields=id,trashed`); if (!f.trashed) return id; } catch (e) { if (e instanceof NeedLogin) throw e; } }
    let q = `name = '${name}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
    if (parent) q += ` and '${parent}' in parents`;
    const found = await gfetch('https://www.googleapis.com/drive/v3/files?' + qs({ q, spaces: 'drive', fields: 'files(id)' }));
    if (found.files && found.files.length) id = found.files[0].id;
    else id = (await gfetch('https://www.googleapis.com/drive/v3/files?fields=id', { method: 'POST', json: { name, mimeType: 'application/vnd.google-apps.folder', ...(parent ? { parents: [parent] } : {}) } })).id;
    store.set(key, id); return id;
  },
  app() { return AppData.folder(APP_FOLDER, null, 'appFolder'); },
  async backups() { return AppData.folder(BACKUPS_FOLDER, await AppData.app(), 'backupsFolder'); },
  async findSettings() {
    const q = `name = '${SETTINGS_FILE}' and '${await AppData.app()}' in parents and trashed = false`;
    const r = await gfetch('https://www.googleapis.com/drive/v3/files?' + qs({ q, spaces: 'drive', fields: 'files(id)' }));
    return r.files && r.files[0] ? r.files[0].id : null;
  },
  async loadSettings() {
    if (DEMO) return { ...DEFAULT_SETTINGS, ...(Mock.settings || {}) };
    const id = await AppData.findSettings();
    if (!id) return { ...DEFAULT_SETTINGS };
    try { return { ...DEFAULT_SETTINGS, ...JSON.parse(await (await gfetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`, { asBlob: true })).text()) }; }
    catch { return { ...DEFAULT_SETTINGS }; }
  },
  async saveSettings(st) {
    const data = new Blob([JSON.stringify({ ...st, updated: new Date().toISOString() }, null, 1)], { type: 'application/json' });
    if (DEMO) { Mock.settings = st; return; }
    const id = await AppData.findSettings();
    if (id) return gfetch(`https://www.googleapis.com/upload/drive/v3/files/${id}?uploadType=media`, { method: 'PATCH', raw: data, headers: { 'Content-Type': 'application/json' } });
    return multipartUpload({ name: SETTINGS_FILE, parents: [await AppData.app()] }, data);
  },
  async listBackups() {
    if (DEMO) return Mock.backups.slice().reverse();
    const q = `'${await AppData.backups()}' in parents and trashed = false`;
    const r = await gfetch('https://www.googleapis.com/drive/v3/files?' + qs({ q, spaces: 'drive', orderBy: 'createdTime desc', pageSize: 100, fields: 'files(id,name,createdTime,size)' }));
    return r.files || [];
  },
  async uploadBackup(text, name) {
    const blob = new Blob([text], { type: 'application/json' });
    if (DEMO) { const f = { id: 'b' + Date.now(), name, createdTime: new Date().toISOString(), size: blob.size }; Mock.files[f.id] = blob; Mock.backups.push(f); return f; }
    const f = await multipartUpload({ name, parents: [await AppData.backups()] }, blob);
    for (const old of (await AppData.listBackups()).slice(BACKUP_KEEP)) { try { await gfetch(`https://www.googleapis.com/drive/v3/files/${old.id}`, { method: 'DELETE' }); } catch { /* ignore */ } }
    return f;
  },
  async readText(id) { return (await Drive.download(id)).text(); },
};
function multipartUpload(meta, blob) {
  const boundary = 'tc' + Math.random().toString(36).slice(2);
  const body = new Blob([`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: ${blob.type || 'application/octet-stream'}\r\n\r\n`, blob, `\r\n--${boundary}--`]);
  return gfetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,webViewLink,createdTime',
    { method: 'POST', raw: body, headers: { 'Content-Type': 'multipart/related; boundary=' + boundary } });
}
const b64utf8 = str => { const bytes = new TextEncoder().encode(str); let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(bin); };
async function sendEmail(to, subject, body, attName, attText) {
  if (DEMO) { Mock.sent.push({ to, subject }); return; }
  const boundary = 'tcm' + Math.random().toString(36).slice(2);
  const mime = [`To: ${to}`, `From: ${to}`, `Subject: =?UTF-8?B?${b64utf8(subject)}?=`, 'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`, '', `--${boundary}`, 'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64', '', b64utf8(body), `--${boundary}`,
    `Content-Type: application/json; name="=?UTF-8?B?${b64utf8(attName)}?="`, 'Content-Transfer-Encoding: base64',
    `Content-Disposition: attachment; filename="=?UTF-8?B?${b64utf8(attName)}?="`, '', b64utf8(attText), `--${boundary}--`].join('\r\n');
  const raw = b64utf8(mime).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return gfetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', { method: 'POST', json: { raw } });
}
async function geminiChat(system, contents) {
  if (DEMO) { await new Promise(r => setTimeout(r, 500)); return Mock.answer(contents); }
  const key = store.get('geminiKey', '');
  const body = { systemInstruction: { parts: [{ text: system }] }, contents, generationConfig: { temperature: 0.2 } };
  let busy = false;
  for (const { model, wait } of geminiAttempts()) {
    if (wait) await new Promise(res => setTimeout(res, wait));
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      { method: 'POST', headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (r.status === 404) continue;
    if (GEMINI_BUSY.includes(r.status)) { busy = true; continue; }
    let j = {}; try { j = await r.json(); } catch { /* ignore */ }
    if (r.status === 401 || r.status === 403) throw new Error('מפתח Gemini לא תקין או שאין לו הרשאה. אפשר להחליף אותו בתפריט ☰.');
    if (r.status === 429) throw new Error('הגעת למגבלת השימוש של Gemini. בודקים שהחיוב מופעל ב-AI Studio ומנסים שוב בעוד דקה.');
    if (!r.ok) throw new Error(`שגיאה מ-Gemini (${r.status}). ${(j.error && j.error.message) || ''}`);
    try { return j.candidates[0].content.parts.map(x => x.text || '').join(''); } catch { throw new Error('Gemini לא החזיר תשובה.'); }
  }
  throw new Error(busy ? GEMINI_BUSY_MSG : 'לא נמצא מודל Gemini זמין.');
}
const AI_SYSTEM = `את/ה עוזר/ת אישי/ת של קלינאית תקשורת עצמאית, ועונה על שאלות על היסטוריית הטיפולים שלה.
הנתונים שקיבלת הם רשימת הפגישות מהיומן שלה, בפורמט טבלה. ענה/י תמיד בעברית, בקצרה ובבהירות.
- הסתמך/י רק על הנתונים. אם אין מספיק מידע, אמור/י זאת.
- חשב/י מספרים וסכומים בדיוק, ובדוק/י את החישוב.
- "חוב" או "לא שולם" = פגישה שהתקיימה ולא שולמה; סכום החוב לפי עמודת המחיר.
- פגישות "טרם סומן" בעבר הן פגישות שלא סומנו; פגישות עתידיות עוד לא התקיימו.
- כשמתאים, הצג/י טבלה קצרה או רשימה. אל תמציא/י מטופלים או פגישות.`;
function eventsTable(evs) {
  const rows = ['תאריך | יום | שעה | מטופל/ת | מספר מפגש | הפגישה | סיבת ביטול | מחיר | תשלום | אמצעי | סכום ששולם | תאריך תשלום | קבלה'];
  for (const ev of evs.slice().sort((a, b) => evTimes(a).s - evTimes(b).s)) {
    const t = evTimes(ev); if (t.allDay || !isSession(ev)) continue;
    const p = props(ev), pd = paid(ev), pr = evPrice(ev);
    rows.push([isoDate(t.s), DAYS[t.s.getDay()], hm(t.s), title(ev).trim(), sessionNo(ev) ? String(sessionNo(ev)) : '', ({ yes: 'התקיימה', no: 'לא התקיימה' })[attended(ev)] || 'טרם סומן',
      cancelLabel(ev), pr ? String(pr) : '', pd ? 'שולם' : 'לא שולם', pd ? payLabel(ev) : '', pd ? (p.pay_amount || '') : '', pd ? (p.pay_date || '') : '',
      receiptIssued(ev) ? 'הוצאה' + (p.rcpt_no ? ' ' + p.rcpt_no : '') : 'לא הוצאה'].join(' | '));
  }
  return rows.join('\n');
}
const BACKUP_FIELDS = ['id', 'summary', 'start', 'end', 'location', 'description', 'recurringEventId', 'colorId', 'extendedProperties', 'attachments', 'reminders'];
async function buildBackup() {
  const now = new Date(), start = new Date(now.getTime() - 730 * 864e5), end = new Date(now.getTime() + 200 * 864e5);
  const events = [];
  for (const c of writable()) for (const ev of await G.events(c.id, start, end)) {
    const item = {}; for (const k of BACKUP_FIELDS) if (k in ev) item[k] = ev[k];
    item.calendarId = c.id; events.push(item);
  }
  return { app: 'therapy-calendar', version: 1, device: 'android', created: now.toISOString(), range: { start: start.toISOString(), end: end.toISOString() },
    calendars: writable().map(c => ({ id: c.id, summary: calName(c) })), settings: S.settings, events };
}
const backupName = () => `גיבוי יומן הטיפולים ${isoDate(today())}.json`;
const appProps = ev => { const p = props(ev), o = {}; for (const k of APP_KEYS) if (p[k]) o[k] = p[k]; return o; };
const sameProps = (a, b) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
let backupRunning = false;
async function makeBackup(auto) {
  if (backupRunning) return; backupRunning = true;
  if (!auto) busy(true);
  try {
    const data = await buildBackup();
    const text = JSON.stringify(data);
    const name = backupName();
    await AppData.uploadBackup(text, name);
    let mailErr = null;
    if (S.settings.backup_email !== false && S.email) {
      try {
        await sendEmail(S.email, `גיבוי יומן הטיפולים – ${dmy(today())}`,
          `מצורף הגיבוי היומי של יומן הטיפולים (${data.events.length} פגישות).\n\nהגיבוי נשמר גם ב-Google Drive, בתיקייה „יומן הטיפולים ← גיבויים”.\nלשחזור: באפליקציה ☰ ← שחזור מגיבוי.\n\nהודעה אוטומטית מיומן הטיפולים.`, name, text);
      } catch (e) { mailErr = e.message || String(e); }
    }
    const msg = `✓ גיבוי נשמר ב-Google Drive (${data.events.length} פגישות)` + (S.settings.backup_email !== false ? (mailErr ? ', אבל השליחה למייל נכשלה' : ' ונשלח למייל') : '');
    toast(msg);
    if (mailErr && !auto) alertSheet('השליחה למייל נכשלה', 'הגיבוי נשמר ב-Google Drive. בודקים ש-Gmail API מופעל בפרויקט ב-Google Cloud.\n' + mailErr);
  } catch (e) { if (!auto) handleErr(e); }
  finally { backupRunning = false; if (!auto) busy(false); }
}
async function maybeAutoBackup() {
  // גיבוי יומי: מתבצע במכשיר הראשון (טלפון או מחשב) שנפתח באותו יום
  try {
    const files = await AppData.listBackups();
    if (files.length && sameDay(new Date(files[0].createdTime), new Date())) return;
    makeBackup(true);
  } catch { /* ignore */ }
}
async function loadSettings() {
  try { S.settings = await AppData.loadSettings(); store.set('settings', S.settings); renderView.keepScroll = true; renderView(); } catch { /* ignore */ }
}
async function saveSettings(st) {
  S.settings = { ...DEFAULT_SETTINGS, ...st }; store.set('settings', S.settings);
  renderView.keepScroll = true; renderView();
  try { await AppData.saveSettings(S.settings); toast('✓ ההגדרות נשמרו'); } catch (e) { handleErr(e); }
}

// ---- קריאת הצילום עם Gemini (אותה הנחיה כמו ב-Windows)
const GEMINI_PROMPT = `You are reading a screenshot or photo of a payment confirmation, most likely from an Israeli
app or bank (Bit, PayBox, a bank transfer, a credit card, etc.). The person who RECEIVED the money is the
therapist. The PAYER is a client or a client's parent. Extract the details:
- payer_name: the payer's name exactly as written (usually Hebrew). Empty string if not shown.
- amount: the amount paid, as a number only (shekels). 0 if not shown.
- date: the payment date as YYYY-MM-DD. Israeli dates are written day/month/year. If the year is missing use {year}.
  Empty string if not shown.
- time: HH:MM in 24h, or empty string.
- method: "bit" for Bit, "paybox" for PayBox, "bank" for a bank transfer, "cash" only if it explicitly says cash,
  otherwise "other".
- method_other: when method is "other", the name of the method (for example "כרטיס אשראי"), else empty string.
- reference: a confirmation / reference / transaction number if shown, else empty string.
- description: any free text note or purpose written with the payment (it often includes the child's name),
  else empty string.
- is_payment: false if the image is clearly not a payment confirmation.
Answer with JSON only.`;
const GEMINI_SCHEMA = { type: 'OBJECT', properties: {
  is_payment: { type: 'BOOLEAN' }, payer_name: { type: 'STRING' }, amount: { type: 'NUMBER' }, date: { type: 'STRING' },
  time: { type: 'STRING' }, method: { type: 'STRING', enum: ['bit', 'paybox', 'bank', 'cash', 'other'] },
  method_other: { type: 'STRING' }, reference: { type: 'STRING' }, description: { type: 'STRING' } },
  required: ['is_payment', 'payer_name', 'amount', 'date', 'method', 'reference', 'description'] };
const blobToBase64 = blob => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = () => rej(new Error('לא הצלחתי לקרוא את התמונה.')); r.readAsDataURL(blob); });
async function geminiRead(blob) {
  if (DEMO) { await new Promise(r => setTimeout(r, 600)); return Mock.gemini(); }
  const key = store.get('geminiKey', '');
  const body = { contents: [{ parts: [{ inline_data: { mime_type: blob.type || 'image/jpeg', data: await blobToBase64(blob) } },
    { text: GEMINI_PROMPT.replace('{year}', String(new Date().getFullYear())) }] }],
    generationConfig: { responseMimeType: 'application/json', responseSchema: GEMINI_SCHEMA, temperature: 0 } };
  let busy = false;
  for (const { model, wait } of geminiAttempts()) {
    if (wait) await new Promise(res => setTimeout(res, wait));
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      { method: 'POST', headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (r.status === 404) continue;
    if (GEMINI_BUSY.includes(r.status)) { busy = true; continue; }
    let j = {}; try { j = await r.json(); } catch { /* ignore */ }
    const msg = (j.error && j.error.message) || '';
    if (r.status === 400 || r.status === 401 || r.status === 403) {
      if (/API key/i.test(msg) || r.status !== 400) throw new Error('מפתח Gemini לא תקין או שאין לו הרשאה. אפשר להחליף אותו בתפריט ☰.\n' + msg);
      throw new Error('Gemini לא הצליח לקרוא את התמונה.\n' + msg);
    }
    if (r.status === 429) throw new Error('הגעת למגבלת השימוש של Gemini. בודקים שהחיוב מופעל ב-AI Studio ומנסים שוב בעוד דקה.');
    if (!r.ok) throw new Error(`שגיאה מ-Gemini (${r.status}).`);
    try { return JSON.parse(j.candidates[0].content.parts[0].text); }
    catch { throw new Error('Gemini לא החזיר תשובה שאפשר לקרוא. נסו צילום ברור יותר.'); }
  }
  throw new Error(busy ? GEMINI_BUSY_MSG : 'לא נמצא מודל Gemini זמין.');
}
// הקטנת תמונות גדולות (צילומי מצלמה) לפני שליחה ושמירה
async function shrinkImage(blob) {
  if (blob.size < 2.5e6) return blob;
  try {
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas'); c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return await new Promise(res => c.toBlob(b => res(b || blob), 'image/jpeg', 0.88));
  } catch { return blob; }
}

// ---- התאמת תשלום לפגישות (זהה ל-Windows)
const HEB_PREFIXES = 'לוהבמש';
function tokens(text) {
  const out = new Set();
  for (let w of (text || '').replace(/[׳']/g, '').match(/[\p{L}\p{N}]+/gu) || []) {
    w = w.toLowerCase(); if (w.length < 2) continue;
    out.add(w); if (w.length > 3 && HEB_PREFIXES.includes(w[0])) out.add(w.slice(1));
  }
  return out;
}
function matchReceipt(info, events) {
  const payDay = info.date && /^\d{4}-\d{2}-\d{2}$/.test(info.date) ? parseDateOnly(info.date) : today();
  const lastDay = addDays(payDay, 2);
  const srcText = `${info.payer_name || ''} ${info.description || ''}`;
  const src = tokens(srcText);
  const by = {};
  for (const ev of events) { if (evTimes(ev).allDay || !canEdit(ev) || !isSession(ev)) continue; (by[title(ev).trim()] = by[title(ev).trim()] || []).push(ev); }
  return Object.entries(by).map(([name, evs]) => {
    let score = name && srcText.includes(name) ? 5 : 0;
    for (const t of tokens(name)) if (src.has(t)) score += 2;
    const payer = normName(info.payer_name);
    for (let p of clientPayers(name)) {
      p = normName(p);
      if (p && payer && p === payer) score += 20;  // משלם/ת שכבר זוהה/תה בעבר עבור המטופל/ת
      else if (p && normName(srcText).includes(p)) score += 10;
    }
    const unpaid = evs.filter(e => !paid(e) && attended(e) !== 'no' && evTimes(e).s < lastDay).sort((a, b) => evTimes(a).s - evTimes(b).s);
    const prices = evs.filter(e => paid(e) && payAmount(e)).map(payAmount);
    return { name, score, unpaid, prices };
  }).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'he'));
}
function suggestSelection(unpaid, prices, amount) {
  if (!unpaid.length) return [];
  let n = 1;
  if (amount && prices.length) {
    const price = prices.slice().sort((a, b) => a - b)[Math.floor(prices.length / 2)];
    const k = amount / price;
    if (price > 0 && Math.abs(k - Math.round(k)) < 0.15 && Math.round(k) >= 1 && Math.round(k) <= unpaid.length) n = Math.round(k);
  }
  return unpaid.slice(-n);
}

// כללי חזרה (זהה לאפליקציית Windows)
function rruleInfo(rec) {
  const rule = (rec || []).find(r => r.toUpperCase().startsWith('RRULE:')) || '';
  const parts = Object.fromEntries(rule.slice(6).split(';').filter(x => x.includes('=')).map(x => x.split('=')));
  return { interval: Number(parts.INTERVAL || 1), count: /^\d+$/.test(parts.COUNT || '') ? Number(parts.COUNT) : 0, until: parts.UNTIL };
}
const WEEKDAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
function rruleWithWeekday(rec, d) {
  // תאריך התחלה חדש לסדרה: מעדכנים BYDAY ליום החדש, ותאריכים שבוטלו בסדרה הישנה כבר לא רלוונטיים (זהה ל-Windows)
  return (rec || []).filter(r => !/^EXDATE/i.test(r)).map(r => /^RRULE:/i.test(r)
    ? 'RRULE:' + r.slice(6).split(';').filter(Boolean).map(x => /^BYDAY=/i.test(x) ? 'BYDAY=' + WEEKDAY_CODES[d.getDay()] : x).join(';') : r);
}
function rruleWithCount(rec, count) {
  const out = []; let done = false;
  for (const r of rec || []) {
    if (r.toUpperCase().startsWith('RRULE:') && !done) {
      const parts = r.slice(6).split(';').filter(x => x && !/^(COUNT|UNTIL)=/i.test(x));
      if (count) parts.push('COUNT=' + count);
      out.push('RRULE:' + parts.join(';')); done = true;
    } else out.push(r);
  }
  if (!done) out.push('RRULE:FREQ=WEEKLY' + (count ? ';COUNT=' + count : ''));
  return out;
}

// ------------------------------------------------------------------ התחברות
function restoreToken() {
  if (DEMO) { S.token = 'demo'; S.tokenExp = Date.now() + 864e5; return; }
  const t = store.get('tok', null);
  const hasAll = t && t.s && SCOPE_LIST.every(x => t.s.split(' ').includes(x));
  if (t && t.e > Date.now() && hasAll) { S.token = t.t; S.tokenExp = t.e; }
  else if (t && !hasAll) { S.needConsent = true; store.set('tok', null); }
}
function signIn() {
  return new Promise((resolve, reject) => {
    if (!window.google || !google.accounts || !google.accounts.oauth2) {
      reject(new Error('רכיב ההתחברות של Google עוד לא נטען. בדקי שיש חיבור לאינטרנט ונסי שוב.')); return;
    }
    const tc = google.accounts.oauth2.initTokenClient({
      client_id: S.clientId, scope: SCOPES, hint: S.email || undefined, prompt: (S.email && !S.needConsent) ? '' : 'consent',
      callback: r => {
        if (r.error) { reject(new Error(r.error_description || r.error)); return; }
        if (!google.accounts.oauth2.hasGrantedAllScopes(r, ...SCOPE_LIST)) {
          S.needConsent = true;
          reject(new Error('לא אושרו כל ההרשאות. לוחצים שוב על „התחברות” ומסמנים את כל התיבות במסך של Google.')); return;
        }
        S.needConsent = false;
        S.token = r.access_token; S.tokenExp = Date.now() + (Number(r.expires_in || 3600) - 60) * 1000;
        store.set('tok', { t: S.token, e: S.tokenExp, s: r.scope || SCOPES }); resolve();
      },
      error_callback: e => reject(new Error(e && e.type === 'popup_closed' ? 'חלון ההתחברות נסגר.' : (e && (e.message || e.type)) || 'ההתחברות לא הושלמה.')),
    });
    tc.requestAccessToken();
  });
}
function signOut() {
  try { if (S.token && window.google && !DEMO) google.accounts.oauth2.revoke(S.token, () => {}); } catch { /* ignore */ }
  S.token = null; S.email = ''; S.calendars = []; S.events = []; S.loaded = false;
  store.set('tok', null); store.set('email', '');
  closeSheet(); render();
}

// ------------------------------------------------------------------ טעינה
let loadSeq = 0, loadingCount = 0;
function busy(on) { loadingCount += on ? 1 : -1; $('#loadbar').hidden = loadingCount <= 0; }

function visibleRange() {
  const a = S.anchor;
  if (S.view === 'day') return [a, addDays(a, 1)];
  if (S.view === 'week' || S.view === 'list') { const ws = weekStart(a); return [ws, addDays(ws, 7)]; }
  if (S.view === 'month') { const days = monthDays(); return [days[0], addDays(days[days.length - 1], 1)]; }
  const first = new Date(a.getFullYear(), a.getMonth(), 1);
  return [first, new Date(a.getFullYear(), a.getMonth() + 1, 1)];
}
function monthDays() {
  const first = new Date(S.anchor.getFullYear(), S.anchor.getMonth(), 1);
  const next = new Date(S.anchor.getFullYear(), S.anchor.getMonth() + 1, 1);
  const start = weekStart(first);
  const n = Math.ceil(Math.round((next - start) / 864e5) / 7) * 7;
  return Array.from({ length: n }, (_, i) => addDays(start, i));
}
function selectedCals() {
  if (S.calId === ALL) return S.calendars;
  const c = S.calendars.find(c => c.id === S.calId) || primaryCal();
  return c ? [c] : [];
}

function apiNotEnabled(msg) {
  // שגיאה של Google: שירות (Drive / Gmail / Calendar) לא הופעל בפרויקט
  const m = /([\w.]+)\.googleapis\.com\/overview\?project=(\d+)/.exec(msg || '');
  if (!m || !/has not been used|accessNotConfigured|disabled/.test(msg)) return null;
  const names = { drive: 'Google Drive API', gmail: 'Gmail API', 'calendar-json': 'Google Calendar API', generativelanguage: 'Gemini API' };
  return [names[m[1]] || m[1], `https://console.developers.google.com/apis/api/${m[1]}.googleapis.com/overview?project=${m[2]}`];
}
async function handleErr(e) {
  if (e instanceof NeedLogin) { showLoginBanner(); return; }
  const na = apiNotEnabled(e.message || '');
  if (na) {
    const sh = openSheet(`<h3 style="margin:4px 0 8px">צריך להפעיל את ${esc(na[0])}</h3>
      <p>זו פעולה חד-פעמית ב-Google Cloud: פותחים את הדף, לוחצים <b>Enable</b> (או „הפעלה”), מחכים 2–3 דקות ומנסים שוב.</p>
      <div class="actions"><a class="btn primary" style="text-align:center;text-decoration:none" href="${esc(na[1])}" target="_blank" rel="noopener">פתיחת דף ההפעלה</a><button class="btn" id="okBtn">סגירה</button></div>`);
    $('#okBtn', sh).onclick = closeSheet;
    return;
  }
  alertSheet('משהו השתבש', e.message || String(e));
}

// ---- תיבת קלט: מסמכים שהכנסת לתיקייה „יומן הטיפולים – לטיפול” ב-Drive (זהה ל-Windows)
const Inbox = {
  async folder() { return AppData.folder(INBOX_FOLDER, null, 'inboxFolder'); },
  async done() { return AppData.folder(INBOX_DONE, await Inbox.folder(), 'inboxDoneFolder'); },
  async list() {
    if (DEMO) return Mock.inbox || (Mock.inbox = [{ id: 'i1', name: 'ביט מיכל.jpg', mimeType: 'image/jpeg', createdTime: new Date().toISOString() }]);
    const fid = await Inbox.folder();
    const q = `'${fid}' in parents and trashed = false and mimeType != 'application/vnd.google-apps.folder'`;
    const r = await gfetch('https://www.googleapis.com/drive/v3/files?' + qs({ q, spaces: 'drive', orderBy: 'createdTime', pageSize: 100, fields: 'files(id,name,mimeType,size,createdTime)' }));
    return (r.files || []).filter(f => /^(image\/|application\/pdf)/.test(f.mimeType || ''));
  },
  async move(id) {
    if (DEMO) { Mock.inbox = (Mock.inbox || []).filter(f => f.id !== id); return; }
    await gfetch(`https://www.googleapis.com/drive/v3/files/${enc(id)}?` + qs({ addParents: await Inbox.done(), removeParents: await Inbox.folder(), fields: 'id' }), { method: 'PATCH', json: {} });
  },
  async download(f) {
    if (DEMO) { const c = document.createElement('canvas'); c.width = 200; c.height = 300; c.getContext('2d').fillStyle = '#00c2a8'; c.getContext('2d').fillRect(0, 0, 200, 300); return new Promise(r => c.toBlob(r, 'image/jpeg')); }
    const b = await gfetch(`https://www.googleapis.com/drive/v3/files/${enc(f.id)}?alt=media`, { asBlob: true });
    return b.type ? b : new Blob([b], { type: f.mimeType });
  },
};
function setInboxCount(n) { const b = $('#inboxBtn'); if (!b) return; $('#inboxCount').textContent = n || ''; $('#inboxCount').hidden = !n; }
async function checkInbox() { try { setInboxCount((await Inbox.list()).length); } catch { /* ignore */ } }
async function showInbox() {
  const sh = openSheet('<h3 style="margin:4px 0 6px">תיבת קלט – מסמכים לטיפול</h3><div class="spinner"></div>');
  let files;
  try { files = await Inbox.list(); } catch (e) { closeSheet(); handleErr(e); return; }
  setInboxCount(files.length);
  const fid = DEMO ? '' : await Inbox.folder().catch(() => '');
  sh.innerHTML = `<div class="grip"></div><h3 style="margin:4px 0 6px">תיבת קלט – מסמכים לטיפול</h3>
    <p class="note">כל תמונה או PDF שמכניסים לתיקייה „${INBOX_FOLDER}” ב-Google Drive מופיעים כאן – משיתוף מוואטסאפ ל-Drive, משמירת קובץ מצורף מהמייל, או מהמחשב. אחרי הטיפול הקובץ עובר ל„${INBOX_DONE}”.</p>
    ${files.length ? files.map((f, i) => `<div class="card" style="margin:8px 0;padding:10px"><b>${esc(f.name)}</b><div class="note">${dmy(new Date(f.createdTime))} ${hm(new Date(f.createdTime))} · ${/pdf/.test(f.mimeType) ? 'PDF' : 'תמונה'}</div>
      <div class="actions" style="margin-top:8px"><button class="btn primary" data-pay="${i}">₪ אישור תשלום</button><button class="btn" data-exp="${i}">📤 הוצאה</button><button class="btn" data-done="${i}">✓ טופל</button></div></div>`).join('') : '<p class="empty">אין מסמכים שממתינים לטיפול. 🎉</p>'}
    <div class="actions">${fid ? `<a class="btn" style="text-align:center;text-decoration:none" target="_blank" rel="noopener" href="https://drive.google.com/drive/folders/${esc(fid)}">פתיחת התיקייה ב-Drive</a>` : ''}<button class="btn" id="ibClose">סגירה</button></div>`;
  $('#ibClose', sh).onclick = closeSheet;
  const finished = async f => { busy(true); try { await Inbox.move(f.id); toast('✓ הקובץ עבר ל„טופלו”'); } catch (e) { handleErr(e); } finally { busy(false); checkInbox(); } };
  const load = async f => { busy(true); try { return await Inbox.download(f); } finally { busy(false); } };
  sh.querySelectorAll('[data-done]').forEach(b => b.onclick = async () => { await finished(files[+b.dataset.done]); showInbox(); });
  sh.querySelectorAll('[data-pay]').forEach(b => b.onclick = async () => {
    const f = files[+b.dataset.pay];
    try { const blob = await load(f); startReceipt(blob, () => finished(f)); } catch (e) { handleErr(e); }
  });
  sh.querySelectorAll('[data-exp]').forEach(b => b.onclick = async () => {
    const f = files[+b.dataset.exp];
    if (!morningReady()) { showMorningSettings(showInbox); return; }
    const ok = await choose('הוצאה ל-Morning', `להעלות את „${f.name}” ל-Morning כהוצאה?` + (morningCfg().env === 'sandbox' ? '\n\n(סביבת בדיקות)' : ''), [{ label: 'כן, להעלות', value: true, cls: 'primary' }]);
    if (!ok) { showInbox(); return; }
    busy(true);
    try { const blob = await Inbox.download(f); await morningUploadExpense(morningCfg().env, blob, f.name); toast(`✓ „${f.name}” הועלה ל-Morning`); await Inbox.move(f.id); }
    catch (e) { handleErr(e); return; } finally { busy(false); }
    checkInbox(); showInbox();
  });
}
async function handleDocument(file) {
  // מסמך שנבחר או שותף: אישור תשלום של מטופל/ת, או הוצאה שלי ל-Morning
  const kind = await choose('מה המסמך הזה?', '', [{ label: '₪ אישור תשלום של מטופל/ת', value: 'pay', cls: 'primary' }, { label: '📤 הוצאה שלי – להעלות ל-Morning', value: 'expense' }]);
  if (kind === 'pay') startReceipt(file);
  else if (kind === 'expense') showExpenses([file instanceof File ? file : new File([file], `הוצאה ${isoDate(today())}.${(file.type || '').includes('pdf') ? 'pdf' : 'jpg'}`, { type: file.type || 'image/jpeg' })]);
}
async function takeSharedImage() {
  // תמונה ששותפה לאפליקציה מתפריט השיתוף של אנדרואיד
  if (!new URLSearchParams(location.search).has('receipt') || !('caches' in window)) return;
  history.replaceState(null, '', location.pathname);
  try {
    const cache = await caches.open('therapy-calendar-share');
    const r = await cache.match('shared-receipt');
    if (!r) return;
    await cache.delete('shared-receipt');
    const blob = await r.blob();
    handleDocument(blob);
  } catch { /* ignore */ }
}
async function loadCalendars() {
  busy(true);
  try {
    S.calendars = await G.calendars();
    const p = primaryCal();
    if (p) { S.email = p.id; store.set('email', p.id); }
    if (S.calId !== ALL && !S.calendars.some(c => c.id === S.calId)) { S.calId = p ? p.id : null; store.set('calId', S.calId); }
    hideBanner();
    await loadEvents();
    takeSharedImage();
    loadSettings().then(maybeAutoBackup);
    loadIndex();
    checkInbox();
  } catch (e) { handleErr(e); }
  finally { busy(false); }
}
async function loadEvents() {
  if (!S.calendars.length) return;
  const seq = ++loadSeq;
  const [start, end] = visibleRange();
  busy(true);
  try {
    const evs = await G.eventsMany(selectedCals(), start, end);
    if (seq !== loadSeq) return;
    S.events = evs; S.loaded = true; hideBanner();
    renderView();
    setTimeout(maybeDaySummary, 800);
  } catch (e) { if (seq === loadSeq) handleErr(e); }
  finally { busy(false); }
}

// ------------------------------------------------------------------ מסכים
function render() {
  const main = $('#main');
  const ready = (S.clientId || DEMO) && S.token;
  $('#tabs').style.display = ready ? '' : 'none';
  $('#navRow').style.display = ready ? '' : 'none';
  $('#fab').hidden = !ready || S.view === 'summary';
  $('#refreshBtn').style.display = ready ? '' : 'none';
  if (!S.clientId && !DEMO) { main.innerHTML = setupHtml(); bindSetup(); return; }
  if (!S.token) { main.innerHTML = loginHtml(); bindLogin(); return; }
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.view === S.view));
  if (!S.calendars.length) { main.innerHTML = '<div class="spinner"></div>'; updatePeriod(); loadCalendars(); return; }
  renderView();
}

function setupHtml() {
  return `<div class="card">
    <h2 style="margin-top:0">הגדרה חד־פעמית</h2>
    <p>כדי שהאפליקציה תוכל להתחבר ליומן Google, מדביקים כאן את ה-<b>Client ID</b> שיצרת ב-Google Cloud
      (לפי המדריך, שלב 1). עושים את זה פעם אחת בלבד.</p>
    <div class="field"><label>Client ID</label>
      <input type="text" id="cidInput" dir="ltr" placeholder="1234567890-abc...apps.googleusercontent.com" autocomplete="off"></div>
    <p class="err" id="cidErr"></p>
    <button class="btn primary" id="cidSave" style="width:100%">שמירה</button>
  </div>`;
}
function bindSetup() {
  $('#cidSave').onclick = () => {
    const v = $('#cidInput').value.trim();
    if (!/\.apps\.googleusercontent\.com$/.test(v)) { $('#cidErr').textContent = 'זה לא נראה כמו Client ID. הוא נגמר ב-apps.googleusercontent.com'; return; }
    S.clientId = v; store.set('clientId', v); render();
  };
}
function loginHtml() {
  return `<div class="center">
    <svg width="72" height="72" viewBox="0 0 24 24" fill="none" stroke="#2F6F66" stroke-width="1.6"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4"/><path d="M8.5 15l2.2 2.2L15.5 13"/></svg>
    <h2>יומן הטיפולים</h2>
    <p class="muted">מתחברים עם חשבון Google. הסיסמה נכתבת רק בדף ההתחברות של Google.</p>
    ${S.needConsent ? '<p class="card" style="text-align:right">בעדכון האחרון נוספו הרשאות חדשות (Google Drive: תיבת קלט לקבצים, צילומים וגיבויים; שליחת הגיבוי היומי למייל). לכן צריך להתחבר שוב פעם אחת ולסמן את <b>כל</b> התיבות במסך ההרשאות.</p>' : ''}
    <button class="btn primary" id="loginBtn" style="width:100%;max-width:320px;padding:14px">התחברות עם Google</button>
    <p class="err" id="loginErr"></p>
    <p class="note" style="margin-top:30px"><a href="#" id="resetCid">שינוי Client ID</a></p>
  </div>`;
}
function bindLogin() {
  $('#loginBtn').onclick = async () => {
    $('#loginErr').textContent = '';
    try { await signIn(); render(); } catch (e) { $('#loginErr').textContent = e.message; }
  };
  $('#resetCid').onclick = e => { e.preventDefault(); S.clientId = ''; store.set('clientId', ''); render(); };
}
function showLoginBanner() {
  const b = $('#banner');
  b.innerHTML = `<span style="flex:1">ההתחברות פגה (Google מבקש להתחבר מחדש מדי פעם).</span><button class="btn primary" id="reloginBtn">התחברות</button>`;
  b.hidden = false;
  $('#reloginBtn').onclick = async () => { try { await signIn(); hideBanner(); S.calendars.length ? loadEvents() : loadCalendars(); } catch (e) { toast(e.message); } };
}
function hideBanner() { $('#banner').hidden = true; }

function updatePeriod() {
  const a = S.anchor; let t = '';
  if (S.view === 'day') t = `יום ${DAYS[a.getDay()]}, ${hebDate(a)}`;
  else if (S.view === 'week' || S.view === 'list') {
    const ws = weekStart(a), we = addDays(ws, 6);
    t = ws.getMonth() === we.getMonth() ? `${ltr(ws.getDate() + '–' + we.getDate())} ב${MONTHS[ws.getMonth()]} ${ws.getFullYear()}`
      : `${ws.getDate()} ב${MONTHS[ws.getMonth()]} – ${we.getDate()} ב${MONTHS[we.getMonth()]}`;
  } else t = `${MONTHS[a.getMonth()]} ${a.getFullYear()}`;
  $('#period').textContent = '\u200f' + t;
}

function renderView() {
  try { const [a, b] = visibleRange(); ensureHolidays([a, addDays(b, -1)]); } catch { /* ignore */ }
  updatePeriod();
  $('#fab').hidden = S.view === 'summary';
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.view === S.view));
  const main = $('#main');
  if (!S.loaded) { main.innerHTML = '<div class="spinner"></div>'; return; }
  const scroll = main.scrollTop;
  if (S.view === 'day') main.innerHTML = timeGridHtml([S.anchor]);
  else if (S.view === 'week') { const ws = weekStart(S.anchor); main.innerHTML = timeGridHtml(Array.from({ length: 7 }, (_, i) => addDays(ws, i))); }
  else if (S.view === 'month') main.innerHTML = monthHtml();
  else if (S.view === 'list') main.innerHTML = listHtml();
  else main.innerHTML = summaryHtml();
  bindView();
  renderQuickBar();
  if (renderView.keepScroll) main.scrollTop = scroll;
  else if (S.view === 'day' || S.view === 'week') {
    const evs = [...main.querySelectorAll('.ev')];
    const firstTop = evs.length ? Math.min(...evs.map(el => el.offsetTop)) : 0;
    const target = evs.length ? firstTop + main.querySelector('.tg-body').offsetTop - 120 : 0;
    main.scrollTop = Math.max(0, target);
  } else main.scrollTop = 0;
  renderView.keepScroll = false;
}

// ---- יום / שבוע
function layoutDay(evs) {
  const items = evs.map(ev => { const t = evTimes(ev); return { s: mins(t.s), e: sameDay(t.s, t.e) ? Math.max(mins(t.e), mins(t.s) + 15) : 1440, ev }; })
    .sort((a, b) => a.s - b.s || b.e - a.e);
  const out = []; let cluster = [], end = -1;
  const flush = () => {
    const cols = [];
    const placed = cluster.map(it => { let ci = cols.findIndex(ce => it.s >= ce); if (ci < 0) { cols.push(it.e); ci = cols.length - 1; } else cols[ci] = it.e; return { ...it, ci }; });
    placed.forEach(p => out.push({ ...p, n: cols.length }));
  };
  for (const it of items) { if (cluster.length && it.s >= end) { flush(); cluster = []; end = -1; } cluster.push(it); end = Math.max(end, it.e); }
  if (cluster.length) flush();
  return out;
}
function timeGridHtml(days) {
  const week = days.length > 1;
  const H = week ? 62 : 80;
  const timed = S.events.filter(ev => !evTimes(ev).allDay);
  let sh = 7, eh = 21;
  timed.forEach(ev => { const t = evTimes(ev); sh = Math.min(sh, t.s.getHours()); eh = sameDay(t.s, t.e) ? Math.max(eh, t.e.getHours() + (t.e.getMinutes() ? 1 : 0)) : 24; });
  eh = Math.min(24, eh);
  const cols = `44px repeat(${days.length}, 1fr)`;
  const td = today();
  let head = `<div class="tg-head" style="grid-template-columns:${cols}"><div></div>`;
  days.forEach(d => { const hk = holidayKind(d); head += `<div class="${sameDay(d, td) ? 'today' : ''}" data-day="${isoDate(d)}" ${hk ? `style="background:${HOL_BG[hk]}"` : ''}>${week ? DAYS_S[d.getDay()] : DAYS[d.getDay()]}<span class="num">${d.getDate()}</span>${hk ? `<span class="hol" style="color:${HOL_FG[hk]}">${esc(holidayLabel(d))}</span>` : ''}</div>`; });
  head += '</div>';
  const allday = days.map(d => S.events.filter(ev => { const t = evTimes(ev); return t.allDay && t.s <= d && d < (t.e > t.s ? t.e : addDays(t.s, 1)); }));
  let ad = '';
  if (allday.some(a => a.length)) {
    ad = `<div class="tg-allday" style="grid-template-columns:${cols};top:${week ? 52 : 56}px"><div></div>`;
    allday.forEach(list => { ad += '<div>' + list.map(ev => `<span class="chip" data-id="${esc(ev.id)}" style="background:${evColor(ev)}">${esc(title(ev))}</span>`).join('') + '</div>'; });
    ad += '</div>';
  }
  const height = (eh - sh) * H + 10;
  let axis = `<div class="tg-axis" style="height:${height}px">`;
  for (let h = sh; h < eh; h++) axis += `<span style="top:${(h - sh) * H + 5}px">${pad(h)}:00</span>`;
  axis += '</div>';
  let lines = '';
  for (let h = sh; h <= eh; h++) { lines += `<div class="tg-line" style="top:${(h - sh) * H + 5}px"></div>`; if (h < eh) lines += `<div class="tg-line half" style="top:${(h - sh) * H + 5 + H / 2}px"></div>`; }
  let colsHtml = '';
  const now = new Date();
  days.forEach(d => {
    const evs = timed.filter(ev => sameDay(evTimes(ev).s, d));
    let inner = lines;
    for (const p of layoutDay(evs)) {
      const ev = p.ev, t = evTimes(ev);
      const top = (p.s - sh * 60) * H / 60 + 6, hgt = Math.max(20, (p.e - p.s) * H / 60 - 2);
      const w = 100 / p.n;
      const missed = attended(ev) === 'no';
      const showTags = hgt >= (week ? 42 : 50);
      inner += `<div class="ev${missed ? ' missed' : ''}" data-id="${esc(ev.id)}" style="--c:${evColor(ev)};background:${evColor(ev)};top:${top}px;height:${hgt}px;right:calc(${p.ci * w}% + 1px);width:calc(${w}% - 3px)">
        <b>${esc(title(ev))}</b><div class="t">${hm(t.s)}${week ? '' : '–' + hm(t.e)}${sessionNo(ev) ? (week ? ` · ${sessionNo(ev)}` : `</div><div class="t" style="direction:rtl">מפגש ${sessionNo(ev)}`) : ''}</div>${showTags ? tagsHtml(ev, week) : ''}</div>`;
    }
    if (sameDay(d, now) && now.getHours() >= sh && now.getHours() < eh) inner += `<div class="nowline" style="top:${(mins(now) - sh * 60) * H / 60 + 5}px"></div>`;
    const hk = holidayKind(d);
    colsHtml += `<div class="tg-col${sameDay(d, td) ? ' today' : ''}" data-col="${isoDate(d)}" data-sh="${sh}" data-h="${H}" style="height:${height}px${hk ? ';background:' + HOL_BG[hk] : ''}">${inner}</div>`;
  });
  return `<div class="${week ? 'week' : 'day'}">${head}${ad}<div class="tg-body" style="grid-template-columns:${cols}">${axis}${colsHtml}</div></div>`;
}

// ---- חודש
function monthHtml() {
  const days = monthDays(), td = today(), m = S.anchor.getMonth();
  let h = '<div class="mo-head">' + DAYS_S.map(d => `<div>${d}</div>`).join('') + '</div><div class="mo-grid">';
  for (const d of days) {
    const evs = S.events.filter(ev => { const t = evTimes(ev); return t.allDay ? (t.s <= d && d < (t.e > t.s ? t.e : addDays(t.s, 1))) : sameDay(t.s, d); });
    const shown = evs.length > 4 ? evs.slice(0, 3) : evs;
    const hk = holidayKind(d);
    h += `<div class="mo-cell${d.getMonth() !== m ? ' out' : ''}${sameDay(d, td) ? ' today' : ''}" data-day="${isoDate(d)}" ${hk ? `style="background:${HOL_BG[hk]}"` : ''}><div class="d"><span>${d.getDate()}</span></div>${hk ? `<div class="hol" style="color:${HOL_FG[hk]}">${esc(holidayLabel(d))}</div>` : ''}`;
    for (const ev of shown) {
      const a = attended(ev);
      let ic = '';
      if (a === 'yes') ic += `<i style="background:var(--ok);color:#fff">${ICON.check}</i>`;
      else if (a === 'no') ic += `<i style="background:var(--no);color:#fff">${ICON.x}</i>`;
      if (paid(ev)) ic += '<i style="background:var(--pay);color:var(--pay-t)">₪</i>';
      else if (a === 'yes') ic += '<i style="border:1px solid var(--no);color:var(--no)">₪</i>';
      h += `<div class="mo-ev${a === 'no' ? ' missed' : ''}"><span class="dot" style="background:${evColor(ev)}"></span><span class="nm">${esc(title(ev))}</span><span class="ic">${ic}</span></div>`;
    }
    if (evs.length > shown.length) h += `<div class="mo-more">ועוד ${evs.length - shown.length}</div>`;
    h += '</div>';
  }
  return h + '</div><p class="note" style="padding:10px 14px">לחיצה על יום פותחת אותו.</p>';
}

// ---- רשימה
function listHtml() {
  const ws = weekStart(S.anchor), td = today();
  let h = '';
  for (let i = 0; i < 7; i++) {
    const d = addDays(ws, i);
    const evs = S.events.filter(ev => sameDay(evTimes(ev).s, d));
    if (!evs.length) continue;
    h += `<div class="day-h${sameDay(d, td) ? ' today' : ''}">יום ${DAYS[d.getDay()]}, ${hebDate(d)}${holidaysOn(d).length ? ` <span style="color:${HOL_FG[holidayKind(d)]};font-weight:600">· ${esc(holidayLabel(d))}</span>` : ''}</div>`;
    for (const ev of evs) {
      const t = evTimes(ev);
      h += `<div class="li${attended(ev) === 'no' ? ' missed' : ''}" data-id="${esc(ev.id)}"><div class="bar" style="background:${evColor(ev)}"></div><div class="main">
        <div class="nm">${esc(title(ev))}</div>
        <div class="t">${t.allDay ? 'כל היום' : hm(t.s) + '–' + hm(t.e)}</div>${sessionNo(ev) ? `<div class="loc">מפגש ${sessionNo(ev)}</div>` : ''}
        ${ev.location ? `<div class="loc">${esc(ev.location)}</div>` : ''}
        ${t.allDay ? '' : `<div style="margin-top:5px">${tagsHtml(ev)}</div>`}
      </div></div>`;
    }
  }
  return h || '<div class="empty">אין פגישות בשבוע הזה.</div>';
}

// ---- סיכום חודשי
const attText = ev => attended(ev) === 'no' ? 'לא התקיימה' + (cancelLabel(ev) ? ` (${cancelLabel(ev)})` : '') : (attended(ev) === 'yes' ? 'התקיימה' : 'טרם סומן');
const payText = ev => paid(ev) ? 'שולם' : (attended(ev) === 'yes' ? 'לא שולם' : '—');
function stats(evs) {
  return { received: evs.filter(paid).reduce((a, e) => a + (payAmount(e) || 0), 0), total: evs.length,
    owed: evs.filter(e => attended(e) === 'yes' && !paid(e)).reduce((a, e) => a + (evPrice(e) || 0), 0),
    noRcpt: evs.filter(e => paid(e) && !receiptIssued(e)).length, held: evs.filter(e => attended(e) === 'yes').length, missed: evs.filter(e => attended(e) === 'no').length,
    paid: evs.filter(paid).length, unpaid: evs.filter(e => attended(e) === 'yes' && !paid(e)).length };
}
function summaryGroups() {
  const groups = {};
  for (const ev of S.events) {
    if (evTimes(ev).allDay || !isSession(ev)) continue;
    const name = title(ev).trim();
    if (S.sumClient && name !== S.sumClient) continue;
    if (S.sumFilter === 'held' && attended(ev) !== 'yes') continue;
    if (S.sumFilter === 'unpaid' && !(attended(ev) === 'yes' && !paid(ev))) continue;
    if (S.sumFilter === 'no_rcpt' && !(paid(ev) && !receiptIssued(ev))) continue;
    if (S.sumFilter === 'missed' && attended(ev) !== 'no') continue;
    (groups[name] = groups[name] || []).push(ev);
  }
  return Object.keys(groups).sort((a, b) => a.localeCompare(b, 'he')).map(k => [k, groups[k]]);
}
function summaryHtml() {
  const names = [...new Set(S.events.filter(e => !evTimes(e).allDay && isSession(e)).map(e => title(e).trim()))].sort((a, b) => a.localeCompare(b, 'he'));
  if (S.sumClient && !names.includes(S.sumClient)) S.sumClient = '';
  const groups = summaryGroups();
  const all = groups.flatMap(g => g[1]);
  const st = stats(all);
  const methods = {};
  all.filter(paid).forEach(e => { const l = payLabel(e) || 'לא צוין'; methods[l] = (methods[l] || 0) + 1; });
  let h = `<div class="print-title">סיכום טיפולים ותשלומים – ${MONTHS[S.anchor.getMonth()]} ${S.anchor.getFullYear()}${S.sumClient ? ' – ' + esc(S.sumClient) : ''}</div>
    <div class="sum-controls no-print">
      <select id="sumClient"><option value="">כל המטופלים</option>${names.map(n => `<option ${n === S.sumClient ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>
      <select id="sumFilter">
        <option value="all" ${S.sumFilter === 'all' ? 'selected' : ''}>כל הפגישות</option>
        <option value="held" ${S.sumFilter === 'held' ? 'selected' : ''}>רק שהתקיימו</option>
        <option value="unpaid" ${S.sumFilter === 'unpaid' ? 'selected' : ''}>רק שהתקיימו וטרם שולמו</option>
        <option value="no_rcpt" ${S.sumFilter === 'no_rcpt' ? 'selected' : ''}>שולמו וטרם הוצאה קבלה</option>
        <option value="missed" ${S.sumFilter === 'missed' ? 'selected' : ''}>רק ביטולים</option>
      </select>
    </div>
    <div class="totals">${groups.length} מטופלים · ${st.total} פגישות · ${st.held} התקיימו · ${st.missed} לא התקיימו · ${st.paid} שולמו · ${st.unpaid} התקיימו וטרם שולמו${st.received ? ` · התקבלו ${fmtMoney(st.received)}` : ''}${st.owed ? ` · יתרה לתשלום ${fmtMoney(st.owed)}` : ''}${st.noRcpt ? ` · ${st.noRcpt} שולמו בלי קבלה` : ''}</div>
    ${Object.keys(methods).length ? `<div class="methods note">לפי אמצעי תשלום: ${Object.entries(methods).map(([k, v]) => esc(k) + ': ' + v).join(' · ')}</div>` : ''}`;
  if (!groups.length) h += '<div class="empty">אין פגישות בחודש הזה לפי הסינון שנבחר.</div>';
  for (const [name, evs] of groups) {
    const cs = stats(evs);
    h += `<div class="client"><div class="client-h"><b>${esc(name)}</b><div class="st">${cs.total} פגישות · ${cs.held} התקיימו · ${cs.paid} שולמו${cs.received ? ` (${fmtMoney(cs.received)})` : ''}${cs.owed ? ` · <span class="debt">חוב ${fmtMoney(cs.owed)}</span>` : ''}${cs.unpaid ? ` · <span class="debt">${cs.unpaid} טרם שולמו</span>` : ''}</div></div>`;
    for (const ev of evs) {
      const t = evTimes(ev), a = attended(ev);
      h += `<div class="srow" data-id="${esc(ev.id)}">
        <div class="when">${DAYS[t.s.getDay()]} ${dmy(t.s)}<small>${hm(t.s)}–${hm(t.e)}</small></div>
        <div class="${a === 'yes' ? 'c-ok' : a === 'no' ? 'c-no' : 'c-gray'}">${attText(ev)}${sessionNo(ev) ? `<small class="muted" style="display:block;font-weight:400">מפגש ${sessionNo(ev)}</small>` : ''}</div>
        <div class="${paid(ev) ? 'c-ok' : a === 'yes' ? 'c-no' : 'c-gray'}">${payText(ev)}${paid(ev) && payLabel(ev) ? ' · ' + esc(payLabel(ev)) : ''}${paid(ev) && payAmount(ev) ? ' · ' + fmtMoney(payAmount(ev)) : ''}${paid(ev) && props(ev).pay_receipt ? ' 📎' : ''}${paid(ev) ? (receiptIssued(ev) ? ' · 🧾' : ' · <span class="c-no">ללא קבלה</span>') : ''}</div>
      </div>`;
    }
    h += '</div>';
  }
  h += `<div class="sum-actions no-print"><button class="btn" id="morningBtn">🧾 קבלות ב-Morning</button></div>
    <div class="sum-actions no-print"><button class="btn" id="csvBtn">ייצוא לאקסל</button><button class="btn primary" id="pdfBtn">שמירה כ-PDF</button></div>
    <p class="note no-print" style="padding:0 14px">לחיצה על פגישה פותחת אותה לסימון או לתיקון.</p>`;
  return h;
}
async function exportCsv() {
  const rows = [['מטופל/ת', 'תאריך', 'יום', 'התחלה', 'סיום', 'הפגישה', 'תשלום', 'אמצעי תשלום', 'סכום', 'תאריך תשלום', 'אסמכתא', 'שם המשלם', 'צילום', 'מחיר', 'סיבת ביטול', 'קבלה', 'מספר קבלה', 'מספר מפגש']];
  for (const [name, evs] of summaryGroups()) for (const ev of evs) {
    const t = evTimes(ev);
    const p = props(ev), pd = paid(ev);
    rows.push([name, dmy(t.s), DAYS[t.s.getDay()], hm(t.s), hm(t.e), attText(ev), payText(ev), pd ? payLabel(ev) : '',
      pd ? (p.pay_amount || '') : '', pd && p.pay_date ? dmy(parseDateOnly(p.pay_date)) : '', pd ? (p.pay_ref || '') : '', pd ? (p.pay_payer || '') : '',
      pd && p.pay_receipt ? `https://drive.google.com/file/d/${p.pay_receipt}/view` : '',
      evPrice(ev) ? String(evPrice(ev)) : '', attended(ev) === 'no' ? cancelLabel(ev) : '', receiptIssued(ev) ? 'הוצאה' : '', p.rcpt_no || '', sessionNo(ev) ? String(sessionNo(ev)) : '']);
  }
  const csv = '\ufeff' + rows.map(r => r.map(c => /[",\n]/.test(c) ? '"' + c.replace(/"/g, '""') + '"' : c).join(',')).join('\r\n');
  const fname = `סיכום ${MONTHS[S.anchor.getMonth()]} ${S.anchor.getFullYear()}${S.sumClient ? ' - ' + S.sumClient : ''}.csv`;
  const file = new File([csv], fname, { type: 'text/csv' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: fname }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = fname; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  toast('הקובץ ירד לתיקיית ההורדות');
}

// ---- אירועי לחיצה במסך
function findEv(id) { return S.events.find(e => e.id === id); }
function bindView() {
  const main = $('#main');
  main.querySelectorAll('[data-id]').forEach(el => el.addEventListener('click', e => { e.stopPropagation(); const ev = findEv(el.dataset.id); if (ev) showDetails(ev); }));
  main.querySelectorAll('.tg-col').forEach(col => col.addEventListener('click', e => {
    if (e.target.closest('.ev')) return;
    const rect = col.getBoundingClientRect();
    const sh = Number(col.dataset.sh), H = Number(col.dataset.h);
    let m = sh * 60 + (e.clientY - rect.top - 5) * 60 / H;
    m = Math.max(0, Math.min(23 * 60 + 45, Math.floor(m / 15) * 15));
    const d = parseDateOnly(col.dataset.col); d.setHours(Math.floor(m / 60), m % 60);
    showNewMenu(d);
  }));
  main.querySelectorAll('.tg-head [data-day]').forEach(el => el.addEventListener('click', () => { if (S.view === 'week') goDay(parseDateOnly(el.dataset.day)); }));
  main.querySelectorAll('.mo-cell').forEach(el => el.addEventListener('click', () => goDay(parseDateOnly(el.dataset.day))));
  const sc = $('#sumClient'); if (sc) sc.onchange = () => { S.sumClient = sc.value; renderView(); };
  const sf = $('#sumFilter'); if (sf) sf.onchange = () => { S.sumFilter = sf.value; renderView(); };
  const cb = $('#csvBtn'); if (cb) cb.onclick = exportCsv;
  const mb = $('#morningBtn'); if (mb) mb.onclick = () => showMorningIssue({ client: S.sumClient || null, extra: S.events });
  const pb = $('#pdfBtn'); if (pb) pb.onclick = () => window.print();
}
function goDay(d) { S.anchor = d; setView('day'); }
function setView(v) { S.view = v; store.set('view', v); S.loaded = false; renderView(); loadEvents(); }
function step(dir) {
  const a = S.anchor;
  if (S.view === 'day') S.anchor = addDays(a, dir);
  else if (S.view === 'week' || S.view === 'list') S.anchor = addDays(a, 7 * dir);
  else S.anchor = new Date(a.getFullYear(), a.getMonth() + dir, 1);
  S.loaded = false; renderView(); loadEvents();
}

// ------------------------------------------------------------------ חלונות (Bottom sheets)
function openSheet(html) {
  const sh = $('#sheet');
  sh.innerHTML = '<div class="grip"></div>' + html;
  sh.hidden = false; $('#sheetBack').hidden = false; sh.scrollTop = 0;
  return sh;
}
function closeSheet() { const ta = $('#noteText'); if (ta) ta.dispatchEvent(new Event('change')); Voice.cancel(); $('#sheet').hidden = true; $('#sheetBack').hidden = true; $('#sheet').innerHTML = ''; }
function alertSheet(t, msg) {
  const sh = openSheet(`<h3 style="margin:4px 0 8px">${esc(t)}</h3><p style="white-space:pre-line">${esc(msg)}</p><div class="actions"><button class="btn primary" id="okBtn">אישור</button></div>`);
  $('#okBtn', sh).onclick = closeSheet;
}
function choose(t, msg, options) {
  return new Promise(resolve => {
    const sh = openSheet(`<h3 style="margin:4px 0 8px">${esc(t)}</h3>${msg ? `<p style="white-space:pre-line">${esc(msg)}</p>` : ''}
      <div class="actions" style="flex-direction:column">${options.map((o, i) => `<button class="btn ${o.cls || ''}" data-i="${i}">${esc(o.label)}</button>`).join('')}
      <button class="btn" data-i="-1">ביטול</button></div>`);
    sh.querySelectorAll('[data-i]').forEach(b => b.onclick = () => { const i = Number(b.dataset.i); closeSheet(); resolve(i < 0 ? null : options[i].value); });
  });
}
let toastTimer;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => t.hidden = true, 3200); }

// ---- פרטי פגישה

// ---- הערות טיפול, חובות, תזכורות, מכסות ורשימת המתנה (זהה ל-Windows)
const NOTE_KEYS = ['note', 'note_2', 'note_3', 'note_4'];  // ערך של מאפיין ביומן מוגבל ל-1024 תווים
const NOTE_CHUNK = 1000, NOTE_MAX = NOTE_CHUNK * NOTE_KEYS.length;
const DEFAULT_PAY_REMINDER = 'שלום, תזכורת קטנה לגבי הטיפולים של {שם_מטופל}: {מספר_טיפולים} טיפולים עדיין לא שולמו ({תאריכים}), סה"כ {סכום}.\nתודה רבה!';
const DEFAULT_SESSION_REMINDER = 'שלום, תזכורת: מחר, יום {יום} {תאריך}, בשעה {שעה}, יש טיפול ל{שם_מטופל}. נתראה!';
const DEFAULT_REMINDERS = { enabled: false, hour: 18, template: DEFAULT_SESSION_REMINDER };
const DAY_SUMMARY_HOUR = 19, VOICE_MAX_SECONDS = 6 * 60;
const TRANSCRIBE_SYSTEM = 'זו הקלטה של קלינאית תקשורת שמכתיבה הערה קצרה על טיפול. תמלל/י את ההקלטה לעברית במדויק, עם פיסוק נכון ומשפטים מסודרים. אל תוסיף/י מידע שלא נאמר. החזר/י רק את הטקסט המתומלל, בלי הקדמות. אם אין בהקלטה דיבור, החזר/י מחרוזת ריקה.';
const evNote = ev => NOTE_KEYS.map(k => props(ev)[k] || '').join('');
const noteProps = text => { text = (text || '').trim().slice(0, NOTE_MAX); return Object.fromEntries(NOTE_KEYS.map((k, i) => [k, text.slice(i * NOTE_CHUNK, (i + 1) * NOTE_CHUNK)])); };
const allKnown = () => [...S.events, ...S.index];
function uniqueSessions(evs) {
  const seen = new Set(), out = [];
  for (const e of evs) { if (seen.has(e.id) || !isSession(e) || evTimes(e).allDay) continue; seen.add(e.id); out.push(e); }
  return out;
}
function computeDebts(evs, includeUnmarked = true) {
  const now = new Date(), groups = {};
  for (const e of uniqueSessions(evs)) {
    if (!canEdit(e) || paid(e) || attended(e) === 'no' || evTimes(e).s >= now) continue;
    if (attended(e) !== 'yes' && !includeUnmarked) continue;
    (groups[title(e).trim()] = groups[title(e).trim()] || []).push(e);
  }
  return Object.entries(groups).map(([name, ss]) => {
    ss.sort((a, b) => evTimes(a).s - evTimes(b).s);
    return { name, sessions: ss, total: ss.reduce((t, e) => t + (sessionAmount(e) || 0), 0), unmarked: ss.filter(e => attended(e) !== 'yes').length };
  }).sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, 'he'));
}
function unmarkedSessions(evs, days = 7) {
  const now = new Date(), since = new Date(now - days * 864e5);
  return uniqueSessions(evs).filter(e => canEdit(e) && !attended(e) && evTimes(e).s >= since && evTimes(e).e <= now)
    .sort((a, b) => evTimes(a).s - evTimes(b).s);
}
function whatsappUrl(phone, text) {
  let d = (phone || '').replace(/\D/g, ''); if (d.startsWith('0')) d = '972' + d.slice(1);
  return `https://wa.me/${d}?text=${encodeURIComponent(text)}`;
}
const clientPhone = (name, st) => (clientInfo(name, st).phone || '').trim();
function quotaStatus(name, evs = allKnown(), st = S.settings) {
  const info = clientInfo(name, st), total = parseInt(info.quota, 10) || 0;
  if (!total) return null;
  const from = info.quota_from || '', now = new Date();
  let held = 0, planned = 0;
  for (const e of uniqueSessions(evs)) {
    if (title(e).trim() !== (name || '').trim()) continue;
    const s = evTimes(e).s;
    if (from && isoDate(s) < from) continue;
    if (attended(e) === 'yes') held++;
    else if (attended(e) !== 'no' && s >= now) planned++;
  }
  return { quota: total, held, left: total - held, planned, from };
}
function quotaText(q) {
  if (!q) return '';
  let t = `${q.held} מתוך ${q.quota} התקיימו · נשארו ${Math.max(q.left, 0)}`;
  if (q.left <= 0) t += ' · ⚠ המכסה נגמרה'; else if (q.left <= 2) t += ' · ⚠ המכסה עומדת להיגמר';
  if (q.planned) t += ` · ${q.planned} נוספים כבר ביומן`;
  if (q.from) t += ` (מתאריך ${dmy(parseDateOnly(q.from))})`;
  return t;
}
function quotaWarning(ev) {
  const q = quotaStatus(title(ev).trim());
  if (!q || q.left > 2) return;
  const n = title(ev).trim();
  alertSheet('מכסת מפגשים', (q.left <= 0 ? `שימי לב: המכסה של ${n} נגמרה (${q.held} מתוך ${q.quota} מפגשים).`
    : `שימי לב: נשארו ל${n} עוד ${q.left} מפגשים במכסה (${q.held} מתוך ${q.quota}).`) + ' כדאי לבקש אישור להמשך.');
}
function previousNote(ev) {
  const name = title(ev).trim(), start = evTimes(ev).s;
  let best = null;
  for (const e of uniqueSessions(allKnown())) {
    if (e.id === ev.id || title(e).trim() !== name) continue;
    const s = evTimes(e).s;
    if (s < start && evNote(e) && (!best || s > best[0])) best = [s, evNote(e)];
  }
  return best;
}
async function sendPlainEmail(to, subject, body) {
  if (DEMO) { Mock.sent.push({ to, subject }); return; }
  const mime = [`To: ${to}`, `Subject: =?UTF-8?B?${b64utf8(subject)}?=`, 'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', b64utf8(body)].join('\r\n');
  const raw = b64utf8(mime).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return gfetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', { method: 'POST', json: { raw } });
}

// הקלטה מהמיקרופון ל-WAV (16kHz מונו) ותמלול ב-Gemini
const Voice = {
  rec: null,
  async start() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const src = ctx.createMediaStreamSource(stream), node = ctx.createScriptProcessor(4096, 1, 1), chunks = [];
    node.onaudioprocess = e => chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    src.connect(node); node.connect(ctx.destination);
    this.rec = { stream, ctx, src, node, chunks, rate: ctx.sampleRate };
  },
  async stop() {
    const r = this.rec; this.rec = null;
    if (!r) return null;
    try { r.node.disconnect(); r.src.disconnect(); } catch { /* ignore */ }
    r.stream.getTracks().forEach(t => t.stop());
    try { await r.ctx.close(); } catch { /* ignore */ }
    return Voice.wav(r.chunks, r.rate);
  },
  cancel() { if (this.rec) this.stop(); },
  wav(chunks, rate) {
    const n = chunks.reduce((t, c) => t + c.length, 0), all = new Float32Array(n);
    let o = 0; for (const c of chunks) { all.set(c, o); o += c.length; }
    const ratio = rate / 16000, len = Math.floor(n / ratio), pcm = new Int16Array(len);
    for (let i = 0; i < len; i++) {
      // ממוצע של הדגימות בכל מקטע – הורדת קצב פשוטה
      const a = Math.floor(i * ratio), b = Math.max(a + 1, Math.floor((i + 1) * ratio));
      let sum = 0; for (let j = a; j < b && j < n; j++) sum += all[j];
      const v = Math.max(-1, Math.min(1, sum / (b - a)));
      pcm[i] = v < 0 ? v * 32768 : v * 32767;
    }
    const buf = new ArrayBuffer(44 + pcm.length * 2), dv = new DataView(buf);
    const w = (p, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(p + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); dv.setUint32(4, 36 + pcm.length * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
    dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, 16000, true);
    dv.setUint32(28, 32000, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); w(36, 'data');
    dv.setUint32(40, pcm.length * 2, true); new Int16Array(buf, 44).set(pcm);
    return new Blob([buf], { type: 'audio/wav' });
  },
};
async function geminiTranscribe(wav) {
  if (DEMO) { await new Promise(r => setTimeout(r, 400)); return 'היום עבדנו על הגיית ר׳ בתחילת מילה, הצליח יפה. להמשיך עם כרטיסיות.'; }
  const data = await blobToBase64(wav);
  return (await geminiChat(TRANSCRIBE_SYSTEM, [{ role: 'user', parts: [{ inline_data: { mime_type: 'audio/wav', data } }, { text: 'תמלל/י את ההקלטה.' }] }])).trim();
}
function bindNoteBox(ev, sh) {
  const ta = $('#noteText', sh), info = $('#noteInfo', sh), rb = $('#noteRec', sh), sb = $('#noteSave', sh);
  if (!ta) return;
  let saved = evNote(ev), timer = null, secs = 0;
  const save = () => {
    const t = ta.value.trim();
    if (!canEdit(ev) || t === saved.trim()) return;
    saved = t.slice(0, NOTE_MAX);
    setStatus(ev, noteProps(t)); info.textContent = '✓ ההערה נשמרה';
  };
  ta.addEventListener('change', save);
  sb.onclick = save;
  const stopRec = async () => {
    clearInterval(timer); rb.textContent = '🎤 הקלטה';
    const wav = await Voice.stop();
    if (!wav || wav.size < 16000) { info.textContent = 'ההקלטה קצרה מדי.'; return; }
    info.textContent = 'Gemini מתמלל…'; rb.disabled = true;
    try {
      const text = await geminiTranscribe(wav);
      if (!text) info.textContent = 'לא זוהה דיבור בהקלטה.';
      else { const cur = ta.value.trim(); ta.value = cur ? cur + '\n' + text : text; info.textContent = '✓ התמלול נוסף'; save(); }
    } catch (e) { info.textContent = ''; handleErr(e); }
    finally { rb.disabled = false; }
  };
  rb.onclick = async () => {
    if (Voice.rec) { stopRec(); return; }
    if (!DEMO && !store.get('geminiKey', '')) { askGeminiKey(() => showDetails(ev)); return; }
    try { await Voice.start(); } catch (e) { alertSheet('הקלטה', 'לא הצלחתי להפעיל את המיקרופון. מאשרים לאפליקציה גישה למיקרופון בהגדרות של Chrome.'); return; }
    secs = 0; rb.textContent = '⏹ סיום הקלטה'; info.textContent = '🔴 מקליט… 0:00';
    timer = setInterval(() => { secs++; info.textContent = `🔴 מקליט… ${Math.floor(secs / 60)}:${pad(secs % 60)}`; if (secs >= VOICE_MAX_SECONDS) stopRec(); }, 1000);
  };
}
function noteBoxHtml(ev) {
  const prev = previousNote(ev), dis = canEdit(ev) ? '' : 'disabled';
  return `<div class="sec">מה היה בטיפול <span class="note">(הערה פרטית – לא נשלחת למוזמנים)</span></div>
    ${prev ? `<p class="note" style="margin-top:-4px;white-space:pre-wrap">בטיפול הקודם (${dmy(prev[0]).slice(0, 5)}): ${esc(prev[1])}</p>` : ''}
    <textarea id="noteText" rows="3" style="width:100%;box-sizing:border-box" placeholder="מה עשינו, איך הלך, מה להמשיך בפעם הבאה…" ${dis}>${esc(evNote(ev))}</textarea>
    <div class="seg" style="margin-top:6px"><button class="btn" id="noteRec" ${dis}>🎤 הקלטה</button><button class="btn" id="noteSave" ${dis}>שמירת ההערה</button></div>
    <p class="note" id="noteInfo" style="margin-top:-4px"></p>`;
}

// סימון מהיר
function showQuickMark(items = unmarkedSessions(allKnown()), heading = 'סימון הטיפולים') {
  if (!items.length) { alertSheet(heading, 'כל הטיפולים מהשבוע האחרון כבר סומנו. ✓'); return; }
  const row = e => { const t = evTimes(e), a = attended(e); return `<div class="card" style="margin:6px 0;padding:8px 10px">
      <div><b>${esc(title(e))}</b> <span class="note">${DAYS[t.s.getDay()]} ${dmy(t.s).slice(0, 5)} · ${ltr(hm(t.s))}</span></div>
      <div class="seg" style="margin:6px 0 0"><button class="btn ${a === 'yes' ? 'on' : ''}" data-q="${esc(e.id)}" data-v="yes">✓ התקיימה</button>
      <button class="btn ${a === 'no' ? 'on' : ''}" data-q="${esc(e.id)}" data-v="no">✗ לא התקיימה</button></div></div>`; };
  const sh = openSheet(`<h3 style="margin:4px 0 6px">${heading}</h3><p class="note">הטיפולים האלה כבר נגמרו ועוד לא סומנו.</p>
    ${items.map(row).join('')}
    <div class="actions"><button class="btn primary" id="qmAll">✓ כל השאר התקיימו</button><button class="btn" id="qmClose">סגירה</button></div>`);
  const byId = id => items.find(e => e.id === id);
  sh.querySelectorAll('[data-q]').forEach(b => b.onclick = async () => {
    const ev = byId(b.dataset.q), v = b.dataset.v, target = attended(ev) === v ? '' : v;
    if (target === 'no') { showCancel(ev); return; }
    const changes = { attended: target, cancel_reason: '', cancel_note: '' };
    const g = await guardSequence(ev, { props: { ...props(ev), ...changes } });
    if (g.ok) { await setStatus(ev, changes); applyPin(g.pin); if (target === 'yes') quotaWarning(ev); }
    if (!$('#sheet').hidden && $('#qmAll')) showQuickMark(items, heading);
  });
  $('#qmAll', sh).onclick = async () => {
    for (const ev of items) if (!attended(ev)) setStatus(ev, { attended: 'yes', cancel_reason: '', cancel_note: '' });
    closeSheet(); toast('✓ סומן');
  };
  $('#qmClose', sh).onclick = closeSheet;
}
function maybeDaySummary() {
  if (!S.token || !S.calendars.length || store.get('daySummary', true) === false) return;
  if (new Date().getHours() < +(store.get('daySummaryHour', DAY_SUMMARY_HOUR) ?? DAY_SUMMARY_HOUR)) return;
  const day = isoDate(today());
  if (store.get('daySummaryShown', '') === day || !$('#sheet').hidden) return;
  const items = unmarkedSessions(allKnown()).filter(e => sameDay(evTimes(e).s, today()));
  if (!items.length) return;
  store.set('daySummaryShown', day);
  showQuickMark(items, 'סיכום היום – סימון הטיפולים');
}
function renderQuickBar() {
  const bar = $('#quickBar'); if (!bar) return;
  const ready = S.token && S.calendars.length;
  bar.hidden = !ready;
  if (!ready) return;
  const n = unmarkedSessions(allKnown()).length, w = (S.settings.waitlist || []).length;
  bar.innerHTML = `<button class="qchip ${n ? 'warn' : ''}" id="qbMark">✔ סימון${n ? ` (${n})` : ''}</button>
    <button class="qchip" id="qbDebts">💰 מי חייב לי</button><button class="qchip" id="qbWait">⏳ המתנה${w ? ` (${w})` : ''}</button>`;
  $('#qbMark').onclick = () => showQuickMark();
  $('#qbDebts').onclick = showDebts;
  $('#qbWait').onclick = showWaitlist;
}

// מי חייב לי + תזכורת תשלום
function showDebts(include = true) {
  const data = computeDebts(allKnown(), include), tot = data.reduce((t, d) => t + d.total, 0);
  const sh = openSheet(`<h3 style="margin:4px 0 6px">מי חייב לי</h3>
    <label class="check"><input type="checkbox" id="dbInc" ${include ? 'checked' : ''}>כולל טיפולים שעברו ועוד לא סומן אם התקיימו</label>
    ${data.length ? data.map((d, i) => `<div class="card" style="margin:8px 0;padding:10px">
      <div style="display:flex;gap:8px;align-items:center"><b style="flex:1">${esc(d.name)}</b><b>${d.total ? fmtMoney(d.total) : '—'}</b></div>
      <div class="note">${d.sessions.length} טיפולים${d.unmarked ? ` · מהם ${d.unmarked} לא סומנו` : ''}: ${d.sessions.map(e => dmy(evTimes(e).s).slice(0, 5)).join(', ')}</div>
      <button class="btn" data-rem="${i}" style="margin-top:6px">📨 תזכורת תשלום</button></div>`).join('')
      : '<p>אין חובות פתוחים 🎉</p>'}
    ${data.length ? `<p><b>סה"כ: ${fmtMoney(tot)} · ${data.length} מטופלים</b></p>` : ''}
    <p class="note">החישוב לפי השנתיים האחרונות. טיפול שלא התקיים לא נחשב חוב.</p>
    <div class="actions"><button class="btn" id="dbClose">סגירה</button></div>`);
  $('#dbInc', sh).onchange = e => showDebts(e.target.checked);
  sh.querySelectorAll('[data-rem]').forEach(b => b.onclick = () => showPayReminder(data[+b.dataset.rem], include));
  $('#dbClose', sh).onclick = closeSheet;
}
function showPayReminder(d, include) {
  const phone = clientPhone(d.name), emails = clientEmails(d.name);
  const text = renderReceiptText(S.settings.pay_reminder || DEFAULT_PAY_REMINDER, d.sessions, d.name);
  const sh = openSheet(`<h3 style="margin:4px 0 6px">תזכורת תשלום – ${esc(d.name)}</h3>
    <div class="field"><label>ההודעה (אפשר לערוך)</label><textarea id="prText" rows="5" style="width:100%;box-sizing:border-box">${esc(text)}</textarea></div>
    <p class="note">${phone ? 'טלפון: ' + ltr(esc(phone)) : 'אין טלפון שמור – וואטסאפ ייפתח לבחירת איש קשר.'}${emails.length ? '<br>מייל: ' + esc(emails.join(', ')) : ''}</p>
    <div class="actions"><button class="btn primary" id="prWa">💬 וואטסאפ</button><button class="btn" id="prMail" ${emails.length ? '' : 'disabled'}>✉ מייל</button><button class="btn" id="prCopy">העתקה</button></div>
    <div class="actions"><button class="btn" id="prBack">חזרה</button></div>`);
  const msg = () => $('#prText', sh).value.trim();
  $('#prWa', sh).onclick = () => { window.open(whatsappUrl(phone, msg()), '_blank'); };
  $('#prCopy', sh).onclick = async () => { try { await navigator.clipboard.writeText(msg()); toast('✓ ההודעה הועתקה'); } catch { toast('לא הצלחתי להעתיק'); } };
  $('#prMail', sh).onclick = async () => {
    try { busy(true); await sendPlainEmail(emails.join(', '), `תזכורת תשלום – טיפולים של ${d.name}`, msg()); toast('✓ התזכורת נשלחה במייל'); closeSheet(); }
    catch (e) { handleErr(e); } finally { busy(false); }
  };
  $('#prBack', sh).onclick = () => showDebts(include);
}

// תזכורות
function showReminders() {
  const r = { ...DEFAULT_REMINDERS, ...(S.settings.reminders || {}) };
  const sh = openSheet(`<h3 style="margin:4px 0 6px">תזכורות</h3>
    <div class="sec">תזכורת למטופלים יום לפני הטיפול (במייל)</div>
    <label class="check"><input type="checkbox" id="rmOn" ${r.enabled ? 'checked' : ''}>לשלוח תזכורות אוטומטיות</label>
    <div class="field"><label>שעת השליחה (יום לפני)</label><select id="rmHour">${Array.from({ length: 16 }, (_, i) => i + 7).map(h => `<option value="${h}" ${+r.hour === h ? 'selected' : ''}>${pad(h)}:00</option>`).join('')}</select></div>
    <div class="field"><label>נוסח</label><textarea id="rmTpl" rows="3" style="width:100%;box-sizing:border-box">${esc(r.template || DEFAULT_SESSION_REMINDER)}</textarea>
      <p class="note">אפשר להשתמש ב: {שם_מטופל} {יום} {תאריך} {שעה}</p></div>
    <p class="note">התזכורת נשלחת רק למטופלים שסומן להם „תזכורת” ויש להם מייל (☰ ← מטופלים), ולא לטיפולים שבוטלו. את השליחה עושה הסקריפט „ממסר Morning” בחשבון Google שלך, גם כשהטלפון והמחשב כבויים. פעם אחת צריך להדביק בו את הקוד המעודכן ולהפעיל בו את setupReminders (לפי המדריך).</p>
    <div class="sec">נוסח תזכורת תשלום (במסך „מי חייב לי”)</div>
    <textarea id="rmPay" rows="4" style="width:100%;box-sizing:border-box">${esc(S.settings.pay_reminder || DEFAULT_PAY_REMINDER)}</textarea>
    <p class="note">אפשר להשתמש ב: {שם_מטופל} {מספר_טיפולים} {תאריכים} {סכום}</p>
    <div class="actions"><button class="btn primary" id="rmSave">שמירה</button><button class="btn" id="rmCancel">ביטול</button></div>`);
  $('#rmCancel', sh).onclick = closeSheet;
  $('#rmSave', sh).onclick = async () => {
    const st = JSON.parse(JSON.stringify(S.settings)), pay = $('#rmPay', sh).value.trim();
    st.reminders = { enabled: $('#rmOn', sh).checked, hour: +$('#rmHour', sh).value, template: $('#rmTpl', sh).value.trim() || DEFAULT_SESSION_REMINDER };
    if (pay && pay !== DEFAULT_PAY_REMINDER) st.pay_reminder = pay; else delete st.pay_reminder;
    const cal = (S.calId && S.calId !== ALL && S.calendars.find(c => c.id === S.calId)) || primaryCal();
    if (cal && cal.id) st.calendar_id = cal.id;
    st.time_zone = currentTz() || st.time_zone;
    closeSheet(); await saveSettings(st);
  };
}

// מקומות טיפול (זהה ל-Windows)
const locList = () => `<datalist id="locList">${(S.settings.locations || []).map(l => `<option value="${esc(l)}"></option>`).join('')}</datalist>`;
function addLocation(st, loc) {
  loc = (loc || '').trim(); st.locations = st.locations || [];
  if (loc && !st.locations.includes(loc)) { st.locations.push(loc); return true; }
  return false;
}
function showLocations() {
  const locs = (S.settings.locations || []).slice();
  const draw = () => {
    const sh = openSheet(`<h3 style="margin:4px 0 6px">מקומות טיפול</h3>
      <p class="note">המקומות יופיעו לבחירה כשיוצרים מטופל/ת חדש/ה או ממתין/ה. אפשר תמיד לכתוב גם מקום אחר.</p>
      ${locs.map((l, i) => `<div class="menu-item"><input type="text" data-li="${i}" value="${esc(l)}" style="flex:1"><button class="btn danger" data-lr="${i}">הסרה</button></div>`).join('') || '<p class="note">אין עדיין מקומות.</p>'}
      <div class="menu-item"><input type="text" id="locNew" placeholder="מקום חדש, למשל: קליניקה ברחוב הרצל" style="flex:1"><button class="btn" id="locAdd">הוספה</button></div>
      <div class="actions"><button class="btn primary" id="locSave">שמירה</button><button class="btn" id="locCancel">ביטול</button></div>`);
    const read = () => sh.querySelectorAll('[data-li]').forEach(i => { locs[+i.dataset.li] = i.value.trim(); });
    sh.querySelectorAll('[data-lr]').forEach(b => b.onclick = () => { read(); locs.splice(+b.dataset.lr, 1); draw(); });
    $('#locAdd', sh).onclick = () => { read(); const t = $('#locNew', sh).value.trim(); if (t && !locs.includes(t)) locs.push(t); draw(); };
    $('#locCancel', sh).onclick = closeSheet;
    $('#locSave', sh).onclick = async () => {
      read(); const t = $('#locNew', sh).value.trim(); if (t) locs.push(t);
      closeSheet(); await saveSettings({ ...S.settings, locations: [...new Set(locs.filter(Boolean))] });
    };
  };
  draw();
}

// רשימת המתנה
function showWaitlist() {
  const items = (S.settings.waitlist || []).slice().sort((a, b) => (a.added || '').localeCompare(b.added || ''));
  const sh = openSheet(`<h3 style="margin:4px 0 6px">רשימת המתנה</h3>
    ${items.length ? items.map((w, i) => `<div class="card" style="margin:8px 0;padding:10px">
      <div style="display:flex;gap:8px"><b style="flex:1">${esc(w.name)}</b><span class="note">${w.added ? dmy(parseDateOnly(w.added)) : ''}</span></div>
      ${w.phone || w.email ? `<div class="note" dir="ltr" style="text-align:right">${esc([w.phone, w.email].filter(Boolean).join(' · '))}</div>` : ''}
      ${w.location ? `<div class="note">📍 ${esc(w.location)}</div>` : ''}
      ${w.note ? `<div class="note" style="white-space:pre-wrap">${esc(w.note)}</div>` : ''}
      <div class="seg" style="margin-top:6px"><button class="btn primary" data-ws="${i}">📅 קביעת טיפולים</button><button class="btn" data-we="${i}">עריכה</button><button class="btn danger" data-wd="${i}">הסרה</button></div></div>`).join('')
      : '<p class="note">הרשימה ריקה.</p>'}
    <div class="actions"><button class="btn primary" id="wlAdd">+ הוספה</button><button class="btn" id="wlClose">סגירה</button></div>`);
  const saveList = async list => { await saveSettings({ ...S.settings, waitlist: list }); renderQuickBar(); };
  $('#wlAdd', sh).onclick = () => showWaitItem(null, saveList);
  $('#wlClose', sh).onclick = closeSheet;
  sh.querySelectorAll('[data-we]').forEach(b => b.onclick = () => showWaitItem(items[+b.dataset.we], saveList));
  sh.querySelectorAll('[data-wd]').forEach(b => b.onclick = async () => {
    const w = items[+b.dataset.wd];
    if (await choose('הסרה', `להסיר את ${w.name} מרשימת ההמתנה?`, [{ label: 'הסרה', value: true, cls: 'danger' }])) {
      await saveList((S.settings.waitlist || []).filter(x => x.id !== w.id)); showWaitlist();
    } else showWaitlist();
  });
  sh.querySelectorAll('[data-ws]').forEach(b => b.onclick = () => showForm({ purpose: 'client', wait: items[+b.dataset.ws] }));
}
function showWaitItem(w, saveList) {
  const x = w || {};
  const sh = openSheet(`<h3 style="margin:4px 0 6px">${w ? 'עריכה' : 'ממתין/ה חדש/ה'}</h3>
    <div class="field"><label>שם</label><input type="text" id="wiName" value="${esc(x.name || '')}"></div>
    <div class="field"><label>טלפון</label><input type="tel" dir="ltr" id="wiPhone" value="${esc(x.phone || '')}"></div>
    <div class="field"><label>מייל</label><input type="email" dir="ltr" id="wiEmail" value="${esc(x.email || '')}"></div>
    <div class="field"><label>מיקום</label><input type="text" id="wiLoc" list="locList" placeholder="בוחרים מהרשימה או כותבים מקום אחר" value="${esc(x.location || '')}">${locList()}</div>
    <div class="field"><label>הערות</label><textarea id="wiNote" rows="3" style="width:100%;box-sizing:border-box" placeholder="גיל, סיבת הפנייה, ימים ושעות שמתאימים…">${esc(x.note || '')}</textarea></div>
    <p class="err" id="wiErr"></p>
    <div class="actions"><button class="btn primary" id="wiSave">שמירה</button><button class="btn" id="wiBack">חזרה</button></div>`);
  $('#wiBack', sh).onclick = showWaitlist;
  $('#wiSave', sh).onclick = async () => {
    const name = $('#wiName', sh).value.trim(), email = $('#wiEmail', sh).value.trim();
    if (!name) { $('#wiErr', sh).textContent = 'צריך שם.'; return; }
    if (email && parseEmails(email)[1].length) { $('#wiErr', sh).textContent = 'המייל לא תקין.'; return; }
    const item = { ...x, name, phone: $('#wiPhone', sh).value.trim(), email, location: $('#wiLoc', sh).value.trim(), note: $('#wiNote', sh).value.trim() };
    item.id = item.id || 'w' + Date.now(); item.added = item.added || isoDate(today());
    const list = (S.settings.waitlist || []).filter(y => y.id !== item.id).concat([item]);
    const st = { ...S.settings, waitlist: list, locations: [...(S.settings.locations || [])] };
    addLocation(st, item.location);
    await saveSettings(st); renderQuickBar(); showWaitlist();
  };
}

function showDetails(ev) {
  const t = evTimes(ev), edit = canEdit(ev), a = attended(ev);
  const when = t.allDay ? `יום ${DAYS[t.s.getDay()]}, ${hebDate(t.s)} · כל היום`
    : `יום ${DAYS[t.s.getDay()]}, ${hebDate(t.s)} · ${ltr(hm(t.s) + '–' + hm(t.e))}`;
  const dis = edit ? '' : 'disabled';
  let h = `<div class="sh-title" style="border-color:${evColor(ev)}">${esc(title(ev))}</div>
    <div class="kv"><div class="k">מתי</div><div>${when}</div>
    ${ev.recurringEventId ? '<div class="k">חזרה</div><div>פגישה קבועה (חלק מסדרה)</div>' : ''}
    ${ev.location ? `<div class="k">מיקום</div><div>${esc(ev.location)}</div>` : ''}
    ${ev.description ? `<div class="k">הערות</div><div style="white-space:pre-wrap">${esc(ev.description)}</div>` : ''}
    <div class="k">יומן</div><div>${esc(ev._calendar || '')}</div>
    ${hasGuests(ev) ? `<div class="k">זימון</div><div dir="auto">${esc((ev.attendees || []).filter(a => !a.self).map(a => a.email).join(', '))} <span class="note">(קיבלו זימון ליומן)</span></div>` : ''}
    ${!isSession(ev) ? '<div class="k">סוג</div><div class="note">אירוע (לא טיפול) – לא נספר בסיכומים, במספור ובתשלומים</div>' : ''}
    ${t.allDay || !isSession(ev) ? '' : `<div class="k">מפגש</div><div>${a === 'no' ? '<span class="note">— (פגישה שלא התקיימה לא נספרת)</span>' : `${sessionNo(ev) ? 'מפגש ' + sessionNo(ev) : 'לא ידוע'}${sessionAnchor(ev) ? ' <span class="note">(נקבע ידנית)</span>' : ''}${sessionMark(ev) === 'stop' ? ' <span class="note">(לא ידוע מכאן והלאה)</span>' : ''} ${edit ? '<button class="btn" id="numBtn" style="padding:3px 10px;font-size:13px;margin-inline-start:6px">שינוי</button>' : ''}`}</div>`}
    ${t.allDay || !isSession(ev) || !quotaStatus(title(ev).trim()) ? '' : `<div class="k">מכסה</div><div style="${quotaStatus(title(ev).trim()).left <= 2 ? 'color:#B54708;font-weight:600' : ''}">${esc(quotaText(quotaStatus(title(ev).trim())))}</div>`}
    ${t.allDay || !isSession(ev) ? '' : `<div class="k">מחיר</div><div>${evPrice(ev) ? fmtMoney(evPrice(ev)) + (toAmount(props(ev).price) ? '' : ' <span class="note">(ברירת מחדל)</span>') : '<span class="note">לא נקבע (אפשר לקבוע ב„עריכה” או ב-☰ ← מחירי טיפול)</span>'}</div>`}</div>`;
  if (!t.allDay && isSession(ev)) {
    h += `<div class="sec">הפגישה</div><div class="seg">
        <button class="btn ${a === 'yes' ? 'on' : ''}" data-att="yes" ${dis}>✓ התקיימה</button>
        <button class="btn ${a === 'no' ? 'on' : ''}" data-att="no" ${dis}>✗ לא התקיימה</button></div>
      ${a === '' ? '<p class="note" style="margin-top:-6px">טרם סומן · לחיצה חוזרת על סימון מבטלת אותו</p>' : ''}
      ${a === 'no' && cancelLabel(ev) ? `<p class="note" style="margin-top:-4px">סיבה: ${esc(cancelLabel(ev))}</p>` : ''}
      <div class="sec">תשלום</div><div class="seg">
        <button class="btn ${!paid(ev) ? 'on' : ''}" id="unpaidBtn" ${dis}>לא שולמה</button>
        <button class="btn ${paid(ev) ? 'on' : ''}" id="paidBtn" ${dis}>₪ שולמה${paid(ev) && payLabel(ev) ? ' · ' + esc(payLabel(ev)) : '…'}</button></div>
      ${paid(ev) && payDetails(ev) ? `<p class="note" style="margin-top:-4px">${esc(payDetails(ev))}</p>` : ''}
      ${paid(ev) && props(ev).pay_receipt ? '<button class="btn" id="rcptBtn" style="width:100%;margin-bottom:8px">📎 צפייה באישור התשלום</button>' : ''}
      <div class="sec">קבלה</div><div class="seg">
        <button class="btn ${!receiptIssued(ev) ? 'on' : ''}" id="rcNo" ${dis}>לא הוצאה</button>
        <button class="btn ${receiptIssued(ev) && props(ev).rcpt_src === 'morning' ? 'on' : ''}" id="rcMorning" ${edit && paid(ev) && !receiptIssued(ev) ? '' : 'disabled'}>🧾 ${receiptIssued(ev) && props(ev).rcpt_src === 'morning' ? 'הופקה ב-Morning' : 'הפקה ב-Morning…'}</button>
        <button class="btn ${receiptIssued(ev) && props(ev).rcpt_src !== 'morning' ? 'on' : ''}" id="rcYes" ${dis}>שיוך ידני…</button></div>
      ${receiptIssued(ev) ? `<p class="note" style="margin-top:-4px">${esc(receiptDetails(ev))}</p>` : ''}
      ${receiptIssued(ev) && (props(ev).rcpt_url || props(ev).rcpt_file) ? '<button class="btn" id="rcView" style="width:100%;margin-bottom:8px">📄 צפייה בקבלה</button>' : ''}
      ${noteBoxHtml(ev)}
      <p class="note">הסימונים נשמרים רק לפגישה הזו, לא לכל הסדרה.</p>`;
  }
  h += `<div class="actions">
      <button class="btn primary" id="moveBtn" ${edit && !t.allDay ? '' : 'disabled'}>הזזה</button>
      <button class="btn" id="editBtn" ${edit && !t.allDay ? '' : 'disabled'}>עריכה</button>
      <button class="btn danger" id="delBtn" ${dis}>מחיקה</button></div>
    <div class="actions"><button class="btn" id="closeBtn">סגירה</button></div>`;
  const sh = openSheet(h);
  sh.querySelectorAll('[data-att]').forEach(b => b.onclick = async () => {
    // לחיצה על הסימון הנוכחי מבטלת אותו (= טרם סומן)
    const target = attended(ev) === b.dataset.att ? '' : b.dataset.att;
    if (target === 'no') { showCancel(ev); return; }
    const changes = { attended: target, cancel_reason: '', cancel_note: '' };
    const g = await guardSequence(ev, { props: { ...props(ev), ...changes } });
    if (g.ok) { setStatus(ev, changes); applyPin(g.pin); }
    showDetails(ev);
    if (g.ok && target === 'yes') quotaWarning(ev);
  });
  bindNoteBox(ev, sh);
  const nb = $('#numBtn', sh); if (nb) nb.onclick = () => showSessionNo(ev);
  const rn = $('#rcNo', sh); if (rn) rn.onclick = async () => {
    if (props(ev).rcpt_src === 'morning') {
      const ok = await choose('ביטול סימון קבלה', 'הקבלה הופקה ב-Morning. ביטול הסימון כאן לא מבטל את המסמך ב-Morning (שם מבטלים במסמך זיכוי).', [{ label: 'לבטל את הסימון', value: true, cls: 'danger' }]);
      if (!ok) { showDetails(ev); return; }
    }
    setStatus(ev, Object.fromEntries(RCPT_KEYS.map(k => [k, '']))); showDetails(ev);
  };
  const ry = $('#rcYes', sh); if (ry) ry.onclick = () => showReceiptIssued(ev);
  const rm = $('#rcMorning', sh); if (rm) rm.onclick = () => showMorningIssue({ ev });
  const rv = $('#rcView', sh); if (rv) rv.onclick = () => viewReceiptDoc(ev);
  const ub = $('#unpaidBtn', sh); if (ub) ub.onclick = () => {
    const old = props(ev).pay_receipt || null;
    setStatus(ev, Object.fromEntries(PAY_KEYS.map(k => [k, ''])), { detach: old }); showDetails(ev);
  };
  const rb = $('#rcptBtn', sh); if (rb) rb.onclick = () => viewReceipt(ev);
  const pb = $('#paidBtn', sh); if (pb) pb.onclick = () => showPayment(ev);
  $('#moveBtn', sh).onclick = () => showMove(ev);
  $('#editBtn', sh).onclick = () => editEvent(ev);
  $('#delBtn', sh).onclick = () => deleteEvent(ev);
  $('#closeBtn', sh).onclick = closeSheet;
}

async function setStatus(ev, changes, { receipt = null, detach = null } = {}) {
  if (!canEdit(ev)) return;
  const before = JSON.parse(JSON.stringify(ev.extendedProperties || null));
  const p = { ...props(ev), ...changes };
  ev.extendedProperties = { ...(ev.extendedProperties || {}), private: p };
  syncIndex(ev);
  renderView.keepScroll = true; renderView();
  try {
    let attach = null;
    if (receipt) {
      busy(true);
      try { attach = await Drive.upload(receipt, `אישור תשלום ${title(ev)} ${p.pay_date || ''}.${receipt.type === 'image/png' ? 'png' : 'jpg'}`); }
      finally { busy(false); }
      p.pay_receipt = attach.id;
    }
    const fresh = await G.setProps(ev._calendar_id, ev.id, p, attach, detach);
    if (fresh && fresh.extendedProperties) ev.extendedProperties = fresh.extendedProperties;
    toast('✓ הסימון נשמר ב-Google');
  } catch (e) {
    ev.extendedProperties = before || undefined;
    syncIndex(ev);
    renderView.keepScroll = true; renderView();
    handleErr(e);
  }
}

function showCancel(ev) {
  const p = props(ev);
  const sh = openSheet(`<h3 style="margin:4px 0 6px">למה הפגישה של „${esc(title(ev))}” לא התקיימה?</h3>
    ${CANCEL_REASONS.map(([k, l]) => `<label class="radio"><input type="radio" name="cr" value="${k}" ${p.cancel_reason === k ? 'checked' : ''}>${l}</label>`).join('')}
    <div class="field"><input type="text" id="crNote" placeholder="פירוט (לא חובה)" value="${esc(p.cancel_note || '')}"></div>
    <p class="note">אפשר גם לשמור בלי סיבה.</p><p class="err" id="crErr"></p>
    <div class="actions"><button class="btn primary" id="crSave">שמירה</button><button class="btn" id="crCancel">ביטול</button></div>`);
  $('#crCancel', sh).onclick = () => showDetails(ev);
  $('#crSave', sh).onclick = () => {
    const r = sh.querySelector('input[name=cr]:checked'), note = $('#crNote', sh).value.trim();
    if (r && r.value === 'other' && !note) { $('#crErr', sh).textContent = 'יש לכתוב מה הסיבה.'; return; }
    const changes = { attended: 'no', cancel_reason: r ? r.value : '', cancel_note: note };
    guardSequence(ev, { props: { ...props(ev), ...changes } }).then(g => { if (g.ok) { setStatus(ev, changes); applyPin(g.pin); } showDetails(ev); });
  };
}
function showSessionNo(ev) {
  const mark = sessionMark(ev), cont = continuedNumber(ev);
  const sel = typeof mark === 'number' ? 'num' : mark === 'skip' ? 'skip' : mark === 'stop' ? 'stop' : 'auto';
  const sh = openSheet(`<h3 style="margin:4px 0 6px">מספר המפגש של „${esc(title(ev))}”</h3>
    <label class="radio"><input type="radio" name="sn" value="num" ${sel === 'num' ? 'checked' : ''}>מפגש מספר
      <input type="number" inputmode="numeric" min="1" max="999" id="snNum" dir="ltr" value="${sessionNo(ev) || cont || 1}" style="width:96px;flex:none;min-height:38px;padding:6px 8px;margin-inline-start:auto"></label>
    <label class="radio"><input type="radio" name="sn" value="auto" ${sel === 'auto' ? 'checked' : ''}>המשך מהמפגש הקודם ${cont ? `(יהיה מפגש ${cont})` : '(אין מספור קודם, יהיה „לא ידוע”)'}</label>
    <label class="radio"><input type="radio" name="sn" value="skip" ${sel === 'skip' ? 'checked' : ''}>לא ידוע – רק המפגש הזה (המספור ממשיך אחריו)</label>
    <label class="radio"><input type="radio" name="sn" value="stop" ${sel === 'stop' ? 'checked' : ''}>לא ידוע – מהמפגש הזה והלאה</label>
    <p class="note">כל מטופל/ת מקבל/ת מספור משלו/ה. פגישות שלא התקיימו לא נספרות. אם השינוי משפיע על המפגשים הבאים, אבקש אישור לפני העדכון.</p>
    <p class="err" id="snErr"></p>
    <div class="actions"><button class="btn primary" id="snSave">שמירה</button><button class="btn" id="snCancel">ביטול</button></div>`);
  $('#snNum', sh).oninput = () => { sh.querySelector('input[name=sn][value=num]').checked = true; };
  $('#snCancel', sh).onclick = () => showDetails(ev);
  $('#snSave', sh).onclick = async () => {
    const kind = sh.querySelector('input[name=sn]:checked').value;
    let value = '';
    if (kind === 'num') {
      const v = Number($('#snNum', sh).value);
      if (!Number.isInteger(v) || v < 1 || v > 999) { $('#snErr', sh).textContent = 'יש להזין מספר שלם בין 1 ל-999.'; return; }
      value = String(v);
    } else if (kind === 'skip' || kind === 'stop') value = kind;
    if (value === String(props(ev).session_no || '')) { showDetails(ev); return; }
    const g = await guardSequence(ev, { props: { ...props(ev), session_no: value } });
    if (g.ok) { setStatus(ev, { session_no: value }); applyPin(g.pin); }
    showDetails(ev);
  };
}
function showReceiptIssued(ev) {
  // שיוך קבלה שהוצאת בעצמך: מספר, תאריך, מסמך (לא חובה), ואפשר לכמה טיפולים יחד
  const p = props(ev);
  const others = (paidWithoutReceipt()[title(ev).trim()] || []).filter(e => e.id !== ev.id);
  let file = null;
  const sh = openSheet(`<h3 style="margin:4px 0 6px">שיוך קבלה שהוצאת בעצמך – „${esc(title(ev))}”</h3>
    <div class="two"><div class="field"><label>מספר קבלה</label><input type="text" id="rcNum" placeholder="לא חובה" value="${esc(p.rcpt_no || '')}"></div>
      <div class="field"><label>תאריך</label><input type="date" id="rcDate" value="${esc(p.rcpt_date || isoDate(today()))}"></div></div>
    <label class="btn" style="display:block;text-align:center">📎 צירוף מסמך הקבלה (PDF או תמונה)<input type="file" accept="application/pdf,image/*" id="rcFile" hidden></label>
    <div class="note" id="rcFileNote">${p.rcpt_file ? 'יש מסמך מצורף' : ''}</div>
    ${others.length ? `<div class="sec" style="margin-top:8px">הקבלה כוללת גם את הטיפולים האלה:</div>${others.map((e, i) => `<label class="radio"><input type="checkbox" data-oi="${i}">${sessionLine(e)}</label>`).join('')}` : ''}
    <div class="actions"><button class="btn primary" id="rcSave">שמירה</button><button class="btn" id="rcCancel">ביטול</button></div>`);
  $('#rcFile', sh).onchange = e => { file = e.target.files[0] || null; $('#rcFileNote', sh).textContent = file ? '✓ ' + file.name : ''; };
  $('#rcCancel', sh).onclick = () => showDetails(ev);
  $('#rcSave', sh).onclick = async () => {
    const targets = [ev, ...[...sh.querySelectorAll('[data-oi]:checked')].map(i => others[Number(i.dataset.oi)])];
    const ch = { rcpt_issued: 'yes', rcpt_no: $('#rcNum', sh).value.trim(), rcpt_date: $('#rcDate', sh).value, rcpt_src: 'manual', rcpt_count: targets.length > 1 ? String(targets.length) : '' };
    if (file) {
      busy(true);
      try { const f = await Drive.upload(file, `קבלה ${ch.rcpt_no} ${title(ev)} ${file.name}`); ch.rcpt_file = f.id; }
      catch (e) { busy(false); handleErr(e); return; }
      busy(false);
    }
    for (const t of targets) setStatus(t, ch);
    showDetails(ev);
  };
}
async function viewReceiptDoc(ev) {
  const p = props(ev);
  if (p.rcpt_url) { window.open(p.rcpt_url, '_blank', 'noopener'); return; }
  if (!p.rcpt_file) return;
  busy(true);
  try {
    const blob = await Drive.download(p.rcpt_file);
    const url = URL.createObjectURL(blob);
    if ((blob.type || '').includes('pdf')) { window.open(url, '_blank'); return; }
    const sh = openSheet(`<h3 style="margin:4px 0 8px">קבלה – ${esc(title(ev))}</h3><img src="${url}" style="width:100%;border-radius:10px;border:1px solid var(--line2)">
      <div class="actions"><button class="btn" id="rvBack">חזרה</button></div>`);
    $('#rvBack', sh).onclick = () => { URL.revokeObjectURL(url); showDetails(ev); };
  } catch (e) { handleErr(e); } finally { busy(false); }
}
function showMorningSettings(then) {
  const m = morningCfg(), keys = store.get('morningKeys', {}) || {};
  const sh = openSheet(`<h3 style="margin:4px 0 6px">Morning – חיבור והגדרות קבלות</h3>
    <p class="note">המפתחות נוצרים ב-Morning: אזור אישי ← כלים למפתחים ← מפתחות API. הם נשמרים רק בטלפון הזה. מומלץ להתחיל בסביבת הבדיקות.</p>
    <div class="field"><label>סביבה</label><select id="moEnv"><option value="sandbox" ${m.env === 'sandbox' ? 'selected' : ''}>סביבת בדיקות (sandbox) – בלי מסמכים אמיתיים</option><option value="production" ${m.env === 'production' ? 'selected' : ''}>פעיל – מסמכים אמיתיים</option></select></div>
    <div class="field"><label>כתובת ממסר (נדרש בטלפון)</label><input type="url" dir="ltr" id="moRelay" autocomplete="off" placeholder="https://script.google.com/macros/s/…/exec" value="${esc(morningRelay())}">
      <p class="note">Morning חוסמים חיבור ישיר מהטלפון, ולכן הבקשות עוברות דרך ממסר קטן ב-Google Apps Script בחשבון שלך (לפי המדריך).</p></div>
    <div class="field"><label>מזהה מפתח (ID)</label><input type="text" dir="ltr" id="moId" autocomplete="off"></div>
    <div class="field"><label>מפתח סודי (Secret)</label><input type="text" dir="ltr" id="moSecret" autocomplete="off" style="-webkit-text-security:disc"><button class="btn" id="moShow" type="button" style="margin-top:6px">הצגה</button></div>
    <div class="field"><label>תיאור השירות</label><input type="text" id="moItem" value="${esc(m.item)}"></div>
    <div class="field"><label>טקסט קבוע על הקבלה</label><textarea id="moTpl" rows="3">${esc(m.template)}</textarea>
      <p class="note">אפשר להשתמש ב: {תאריכים} {מספר_טיפולים} {שם_מטופל} {סכום}</p></div>
    <label class="check"><input type="checkbox" id="moVat" ${m.vat_included ? 'checked' : ''}>המחירים כוללים מע״מ</label>
    <label class="check"><input type="checkbox" id="moSend" ${m.send_email ? 'checked' : ''}>לשלוח את הקבלה למייל של המטופל/ת או ההורה</label>
    <div class="actions"><button class="btn" id="moTest">בדיקת חיבור</button></div><p class="note" id="moRes" style="white-space:pre-line"></p>
    <div class="actions"><button class="btn primary" id="moSave">שמירה</button><button class="btn" id="moCancel">ביטול</button></div>`);
  const k = { ...keys };
  let env = m.env;
  const load = () => { $('#moId', sh).value = (k[env] || {}).id || ''; $('#moSecret', sh).value = (k[env] || {}).secret || ''; };
  const keep = () => { k[env] = { id: $('#moId', sh).value.trim(), secret: $('#moSecret', sh).value.trim() }; };
  load();
  $('#moShow', sh).onclick = () => { const i = $('#moSecret', sh), hid = i.style.webkitTextSecurity !== 'none'; i.style.webkitTextSecurity = hid ? 'none' : 'disc'; $('#moShow', sh).textContent = hid ? 'הסתרה' : 'הצגה'; };
  $('#moEnv', sh).onchange = e => { keep(); env = e.target.value; load(); $('#moRes', sh).textContent = ''; };
  $('#moTest', sh).onclick = async () => {
    keep(); store.set('morningKeys', k); store.set('morningRelay', $('#moRelay', sh).value.trim()); $('#moRes', sh).textContent = 'בודק…';
    try { const me = await morningMe(env); $('#moRes', sh).textContent = '✓ החיבור עובד' + ((me.businessName || me.firstName) ? ' – ' + (me.businessName || me.firstName) : ''); }
    catch (e) { $('#moRes', sh).textContent = '⚠ ' + e.message; }
  };
  $('#moCancel', sh).onclick = closeSheet;
  $('#moSave', sh).onclick = async () => {
    keep(); store.set('morningKeys', k); store.set('morningRelay', $('#moRelay', sh).value.trim());
    await saveSettings({ ...S.settings, morning: { env, item: $('#moItem', sh).value.trim() || DEFAULT_MORNING.item, template: $('#moTpl', sh).value.trim(), vat_included: $('#moVat', sh).checked, send_email: $('#moSend', sh).checked } });
    closeSheet(); if (then) then();
  };
}
function showMorningIssue({ ev = null, client = null, extra = [], preIds = null } = {}) {
  // הפקת חשבונית מס/קבלה אחת ב-Morning – לטיפול אחד או לכמה טיפולים יחד
  if (!morningReady()) { showMorningSettings(() => showMorningIssue({ ev, client, extra, preIds })); return; }
  const groups = paidWithoutReceipt(extra), names = Object.keys(groups).sort((a, b) => a.localeCompare(b, 'he'));
  if (!names.length) { alertSheet('קבלות ב-Morning', 'אין טיפולים ששולמו וטרם הוצאה להם קבלה.'); return; }
  let name = ev ? title(ev).trim() : (client && groups[client] ? client : names[0]);
  if (!groups[name]) { alertSheet('קבלות ב-Morning', 'אין לפגישה הזו תשלום בלי קבלה.'); return; }
  const m = morningCfg();
  const pre = preIds ? new Set(preIds) : ev ? new Set(groups[name].filter(e => evTimes(e).s.getMonth() === evTimes(ev).s.getMonth() && evTimes(e).s.getFullYear() === evTimes(ev).s.getFullYear()).map(e => e.id).concat([ev.id])) : null;
  const sh = openSheet(`<h3 style="margin:4px 0 6px">הפקת חשבונית מס/קבלה ב-Morning</h3>
    ${m.env === 'sandbox' ? '<p class="note" style="background:#FFF1D6;color:#7A4B00;padding:6px 8px;border-radius:8px">סביבת בדיקות: המסמך לא יהיה אמיתי. (אפשר לעבור לפעיל בתפריט ☰ ← Morning)</p>' : ''}
    <div class="field"><label>מטופל/ת</label><select id="miClient">${names.map(n => `<option ${n === name ? 'selected' : ''} value="${esc(n)}">${esc(n)} (${groups[n].length} טיפולים בלי קבלה)</option>`).join('')}</select></div>
    <div class="sec">הטיפולים שייכללו בקבלה (אפשר כמה – קבלה אחת על כולם):</div><div id="miList"></div>
    <div class="field"><label>שם על הקבלה</label><input type="text" id="miName"></div>
    <div class="field"><label class="check"><input type="checkbox" id="miSend" ${m.send_email ? 'checked' : ''}>לשלוח את הקבלה במייל ל:</label><input type="email" dir="ltr" id="miEmails"></div>
    <div class="field"><label>תיאור השירות</label><input type="text" id="miItem" value="${esc(m.item)}"></div>
    <div class="field"><label>טקסט קבוע</label><textarea id="miRemarks" rows="3"></textarea></div>
    <div class="field"><label>תאריך המסמך</label><input type="date" id="miDate" value="${isoDate(today())}"></div>
    <p class="totals" id="miSum" style="padding:0"></p><p class="err" id="miErr"></p>
    <div class="actions"><button class="btn primary" id="miGo">הפקה ב-Morning</button><button class="btn" id="miCancel">ביטול</button></div>`);
  let touched = false;
  $('#miRemarks', sh).oninput = () => { touched = true; };
  const chosen = () => [...sh.querySelectorAll('[data-mi]:checked')].map(i => groups[name][Number(i.dataset.mi)]);
  const upd = () => {
    const ss = chosen(), total = ss.reduce((a, e) => a + (sessionAmount(e) || 0), 0), by = {};
    for (const e of ss) by[payLabel(e) || 'לא צוין'] = (by[payLabel(e) || 'לא צוין'] || 0) + (sessionAmount(e) || 0);
    if (!touched) $('#miRemarks', sh).value = ss.length ? renderReceiptText(m.template, ss, name) : '';
    $('#miSum', sh).textContent = ss.length ? `${ss.length} טיפולים · סה״כ ${fmtMoney(total)} · תשלום: ${Object.entries(by).map(([k, v]) => k + ' ' + fmtMoney(v)).join(', ')}` : 'לא נבחרו טיפולים.';
  };
  const fill = () => {
    const ss = groups[name], sel = pre && name === title(ev || {}).trim() ? pre : new Set(ss.map(e => e.id));
    $('#miList', sh).innerHTML = ss.map((e, i) => `<label class="radio"><input type="checkbox" data-mi="${i}" ${sel.has(e.id) ? 'checked' : ''}>${sessionLine(e)}</label>`).join('');
    sh.querySelectorAll('[data-mi]').forEach(i => i.onchange = upd);
    $('#miName', sh).value = (ss.map(e => props(e).pay_payer).find(Boolean)) || name;
    $('#miEmails', sh).value = clientEmails(name).join(', ');
    upd();
  };
  $('#miClient', sh).onchange = e => { name = e.target.value; touched = false; fill(); };
  fill();
  $('#miCancel', sh).onclick = () => { if (ev) showDetails(ev); else closeSheet(); };
  $('#miGo', sh).onclick = async () => {
    const ss = chosen(), err = t => { $('#miErr', sh).textContent = t; };
    if (!ss.length) return err('יש לבחור לפחות טיפול אחד.');
    const miss = ss.find(e => !sessionAmount(e));
    if (miss) return err(`לטיפול ב-${dmy(evTimes(miss).s)} אין סכום. מוסיפים סכום בסימון התשלום או קובעים מחיר.`);
    const [emails, bad] = parseEmails($('#miEmails', sh).value);
    if (bad.length) return err(`המייל לא תקין: ${bad.join(', ')}`);
    const payer = $('#miName', sh).value.trim(); if (!payer) return err('יש למלא שם על הקבלה.');
    const total = ss.reduce((a, e) => a + sessionAmount(e), 0), date = $('#miDate', sh).value;
    const remarks = $('#miRemarks', sh).value.trim(), item = $('#miItem', sh).value.trim() || m.item, send = $('#miSend', sh).checked;
    const real = m.env === 'production';
    const ok = await choose('הפקת קבלה', `להפיק חשבונית מס/קבלה על ${ss.length} טיפולים, סה״כ ${fmtMoney(total)}, על שם „${payer}”?` + (real ? '\n\nזה מסמך רשמי: אחרי ההפקה אי אפשר למחוק אותו, רק לבטל במסמך זיכוי.' : '\n\n(סביבת בדיקות)'), [{ label: 'כן, להפיק', value: true, cls: 'primary' }]);
    if (!ok) { showMorningIssue({ ev, client: name, extra }); return; }
    busy(true);
    try {
      const body = morningDocument(ss, { name: payer, emails, send, item, remarks, date, vatIncluded: m.vat_included });
      const res = await morningCreate(m.env, body);
      const url = res.url || {};
      const ch = { rcpt_issued: 'yes', rcpt_no: String(res.number || ''), rcpt_date: date, rcpt_doc: String(res.id || ''), rcpt_url: typeof url === 'object' ? (url.he || url.origin || '') : String(url), rcpt_src: 'morning', rcpt_count: ss.length > 1 ? String(ss.length) : '' };
      for (const e of ss) setStatus(e, ch);
      alertSheet('Morning', `✓ הופקה חשבונית מס/קבלה ${ch.rcpt_no} על ${ss.length} טיפולים.`);
    } catch (e) { alertSheet('ההפקה נכשלה', e.message); }
    finally { busy(false); }
  };
}
function showPrices() {
  const names = [...new Set([...S.events, ...S.index].filter(e => !evTimes(e).allDay && isSession(e)).map(e => title(e).trim()).concat(Object.keys(S.settings.clients || {})))].sort((a, b) => a.localeCompare(b, 'he'));
  const sh = openSheet(`<h3 style="margin:4px 0 6px">מטופלים: מחירים ומיילים</h3>
    <div class="field"><label>מחיר ברירת מחדל לטיפול (₪)</label><input type="text" inputmode="decimal" dir="ltr" id="pDef" placeholder="למשל 250" value="${toAmount(S.settings.default_price) || ''}"></div>
    <p class="note">תזכורת: מייל אוטומטי יום לפני כל טיפול (☰ ← תזכורות). מכסה: מספר המפגשים שאושרו (למשל 12 מקופת החולים), ומאיזה תאריך סופרים. מחיר: שדה ריק = ברירת המחדל. מייל: של המטופל/ת או של ההורה (אפשר כמה, מופרדים בפסיק). משלמים: שמות מי שמשלם (למשל ההורים) כפי שהם מופיעים בביט / בהעברה – כך צילומי תשלום מזוהים אוטומטית. שמות נוספים נשמרים כאן לבד אחרי אישור תשלום. „זימון ליומן”: הפגישות יישלחו כהזמנה ליומן של המייל, וכל שינוי שעה או ביטול יעדכן אותם.</p>
    ${names.map((n, i) => { const c = clientInfo(n); return `<div class="card" style="margin:8px 0;padding:10px">
      <b>${esc(n)}</b>
      <div class="two" style="margin-top:6px"><input type="text" inputmode="decimal" dir="ltr" data-pi="${i}" placeholder="מחיר (ברירת מחדל)" value="${toAmount(c.price) || ''}" style="max-width:120px">
        <input type="email" dir="ltr" data-ei="${i}" placeholder="מייל של המטופל/ת או ההורה" value="${esc((c.emails || []).join(', '))}"></div>
      <input type="text" data-yi="${i}" placeholder="משלמים (למשל שמות ההורים), מופרדים בפסיק" value="${esc((c.payers || []).join(', '))}" style="margin-top:6px;width:100%;box-sizing:border-box">
      <input type="tel" dir="ltr" data-phi="${i}" placeholder="טלפון (לוואטסאפ)" value="${esc(c.phone || '')}" style="margin-top:6px;width:100%;box-sizing:border-box">
      <div class="two" style="margin-top:6px"><input type="number" min="1" inputmode="numeric" data-qi="${i}" placeholder="מכסת מפגשים" value="${parseInt(c.quota, 10) || ''}" style="max-width:130px">
        <label style="display:flex;align-items:center;gap:6px;flex:1"><span class="note">מתאריך</span><input type="date" data-qf="${i}" value="${esc(c.quota_from || '')}"></label></div>
      <label class="check"><input type="checkbox" data-ri="${i}" ${c.remind ? 'checked' : ''}>תזכורת במייל יום לפני כל טיפול</label>
      <label class="check"><input type="checkbox" data-ii="${i}" ${c.invite ? 'checked' : ''}>לשלוח זימון ליומן של המייל</label></div>`; }).join('')}
    <p class="note">שימי לב: מי שמוזמן/ת לפגישה רואה בזימון את השעה, המקום וההערות של הפגישה. הסימונים (תשלום, ביטול, קבלה ומספר מפגש) נשארים פרטיים.</p>
    <p class="err" id="pErr"></p>
    <div class="actions"><button class="btn primary" id="pSave">שמירה</button><button class="btn" id="pCancel">ביטול</button></div>`);
  $('#pCancel', sh).onclick = closeSheet;
  $('#pSave', sh).onclick = async () => {
    const err = m => { $('#pErr', sh).textContent = m; };
    const def = $('#pDef', sh).value.trim();
    if (def && !toAmount(def)) return err('המחיר צריך להיות מספר.');
    const clients = {};
    for (let i = 0; i < names.length; i++) {
      const n = names[i], old = { ...clientInfo(n) };
      const pv = sh.querySelector(`[data-pi="${i}"]`).value.trim();
      if (pv && !toAmount(pv)) return err(`המחיר של ${n} צריך להיות מספר.`);
      const [emails, bad] = parseEmails(sh.querySelector(`[data-ei="${i}"]`).value);
      if (bad.length) return err(`המייל של ${n} לא תקין: ${bad.join(', ')}`);
      const invite = sh.querySelector(`[data-ii="${i}"]`).checked;
      if (invite && !emails.length) return err(`כדי לשלוח זימון ל${n} צריך מייל.`);
      const payers = parseNames(sh.querySelector(`[data-yi="${i}"]`).value);
      const phone = sh.querySelector(`[data-phi="${i}"]`).value.trim(), remind = sh.querySelector(`[data-ri="${i}"]`).checked;
      const quota = sh.querySelector(`[data-qi="${i}"]`).value.trim(), qfrom = sh.querySelector(`[data-qf="${i}"]`).value;
      if (remind && !emails.length) return err(`כדי לשלוח תזכורת ל${n} צריך מייל.`);
      if (quota && !(parseInt(quota, 10) > 0)) return err(`מכסת המפגשים של ${n} צריכה להיות מספר שלם.`);
      delete old.price; delete old.emails; delete old.invite; delete old.payers;
      delete old.phone; delete old.remind; delete old.quota; delete old.quota_from;
      const info = { ...old };
      if (phone) info.phone = phone;
      if (remind) info.remind = true;
      if (quota) { info.quota = parseInt(quota, 10); if (qfrom) info.quota_from = qfrom; }
      if (payers.length) info.payers = payers;
      if (toAmount(pv)) info.price = toAmount(pv);
      if (emails.length) info.emails = emails;
      if (invite) info.invite = true;
      if (Object.keys(info).length) clients[n] = info;
    }
    const oldSt = JSON.parse(JSON.stringify(S.settings));
    const newSt = { ...S.settings, default_price: toAmount(def) || 0, clients };
    closeSheet(); await saveSettings(newSt);
    for (const n of names) {
      const was = clientInvites(n, oldSt) ? clientEmails(n, oldSt) : [], now = clientInvites(n, newSt) ? clientEmails(n, newSt) : [];
      const add = now.filter(x => !was.includes(x)), remove = was.filter(x => !now.includes(x));
      if (!add.length && !remove.length) continue;
      const targets = futureSessions(n);
      if (!targets.length) continue;
      const parts = []; if (add.length) parts.push(`לשלוח זימון ל-${add.join(', ')}`); if (remove.length) parts.push(`לבטל את הזימון של ${remove.join(', ')}`);
      const yes = await choose('זימונים ליומן', `${n}: ${parts.join(' ו')} גם לפגישות העתידיות שכבר קיימות ביומן? (פגישות חדשות יקבלו את ההגדרה הזו בכל מקרה.)`, [{ label: 'כן', value: true, cls: 'primary' }]);
      if (yes) await applyInvites(n, targets, add, remove);
    }
  };
}
function futureSessions(name) {
  // הפגישות העתידיות של מטופל/ת: סדרה (פעם אחת לכל סדרה) או פגישה בודדת
  const now = new Date(), seen = new Map();
  for (const e of S.index) {
    if (title(e).trim() !== name || !canEdit(e) || !isSession(e) || evTimes(e).allDay || evTimes(e).s < now) continue;
    const key = e._calendar_id + '|' + (e.recurringEventId || e.id);
    if (!seen.has(key)) seen.set(key, [e._calendar_id, e.recurringEventId || e.id]);
  }
  return [...seen.values()];
}
async function applyInvites(name, targets, add, remove) {
  busy(true); let n = 0;
  try { for (const [c, id] of targets) { await G.setInvitees(c, id, add, remove); n++; } toast(`✓ הזימונים של ${name} עודכנו (${n})`); changed(); }
  catch (e) { handleErr(e); } finally { busy(false); }
}

const AI_RANGES = [['month', 'החודש'], ['prev_month', 'החודש הקודם'], ['3m', '3 החודשים האחרונים'], ['year', 'מתחילת השנה'], ['prev_year', 'השנה הקודמת'], ['12m', '12 החודשים האחרונים']];
const AI_EXAMPLES = ['כמה טיפולים היו לכל מטופל/ת?', 'מי חייב/ת לי כסף ובכמה?', 'כמה ביטולים היו ומה הסיבות?', 'על אילו תשלומים עוד לא הוצאתי קבלה?', 'מה ההכנסה בכל חודש?'];
function aiRange(key) {
  const t = today(), first = new Date(t.getFullYear(), t.getMonth(), 1), m = (k) => new Date(t.getFullYear(), t.getMonth() + k, 1);
  if (key === 'month') return [first, m(1)];
  if (key === 'prev_month') return [m(-1), first];
  if (key === '3m') return [m(-2), m(1)];
  if (key === 'year') return [new Date(t.getFullYear(), 0, 1), new Date(t.getFullYear() + 1, 0, 1)];
  if (key === 'prev_year') return [new Date(t.getFullYear() - 1, 0, 1), new Date(t.getFullYear(), 0, 1)];
  return [m(-11), m(1)];
}
function mdToHtml(md) {
  // תצוגה פשוטה של תשובת ה-AI: הדגשות, רשימות וטבלאות
  const lines = esc(md).split('\n'); let out = '', inList = false, inTable = false;
  const inline = x => x.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/(^|\s)\*(.+?)\*/g, '$1<i>$2</i>');
  for (const raw of lines) {
    const l = raw.trim();
    if (/^\|.*\|$/.test(l)) {
      if (/^\|[\s:|-]+\|$/.test(l)) continue;
      if (!inTable) { out += '<div style="overflow-x:auto"><table style="border-collapse:collapse;margin:6px 0;font-size:13px">'; inTable = true; }
      out += '<tr>' + l.slice(1, -1).split('|').map(c => `<td style="border:1px solid var(--line2);padding:3px 6px">${inline(c.trim())}</td>`).join('') + '</tr>'; continue;
    } else if (inTable) { out += '</table></div>'; inTable = false; }
    if (/^[-*•]\s+/.test(l) || /^\d+[.)]\s+/.test(l)) { if (!inList) { out += '<ul style="margin:4px 0;padding-inline-start:20px">'; inList = true; } out += `<li>${inline(l.replace(/^([-*•]|\d+[.)])\s+/, ''))}</li>`; continue; }
    if (inList) { out += '</ul>'; inList = false; }
    if (/^#{1,4}\s/.test(l)) out += `<div style="font-weight:700;margin-top:6px">${inline(l.replace(/^#+\s/, ''))}</div>`;
    else if (l === '---') out += '<hr>';
    else if (l) out += `<div>${inline(l)}</div>`;
  }
  if (inList) out += '</ul>'; if (inTable) out += '</table></div>';
  return out;
}
const AI = { history: [], key: null, data: '', transcript: [] };
function showAI() {
  if (!DEMO && !store.get('geminiKey', '')) { askGeminiKey(showAI); return; }
  const names = [...new Set([...S.events.filter(isSession).map(e => title(e).trim()), ...Object.keys(S.settings.clients || {})])].sort((a, b) => a.localeCompare(b, 'he'));
  const sh = openSheet(`<h3 style="margin:4px 0 6px">שאלה ל-AI על הטיפולים</h3>
    <div class="two"><select id="aiRange">${AI_RANGES.map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select>
      <select id="aiClient"><option value="">כל המטופלים</option>${names.map(n => `<option>${esc(n)}</option>`).join('')}</select></div>
    <div id="aiOut" style="margin:10px 0;min-height:120px;max-height:45vh;overflow:auto;background:#F7FAF9;border:1px solid var(--line2);border-radius:12px;padding:10px;font-size:14.5px;line-height:1.5"></div>
    <div class="tags" style="gap:6px;margin-bottom:8px">${AI_EXAMPLES.map(q => `<button class="btn" data-q="${esc(q)}" style="padding:6px 10px;font-size:13px">${esc(q)}</button>`).join('')}</div>
    <div class="two"><input type="text" id="aiQ" placeholder="כתבי שאלה…" style="flex:3"><button class="btn primary" id="aiAsk" style="flex:1">שאלה</button></div>
    <p class="note">הנתונים של התקופה והמטופל/ת שנבחרו נשלחים ל-Gemini (במסלול בתשלום) כדי לענות. Gemini יכול לטעות, לכן כדאי לבדוק מספרים חשובים בסיכום.</p>
    <div class="actions"><button class="btn" id="aiClose">סגירה</button></div>`);
  const out = $('#aiOut', sh);
  const draw = () => { out.innerHTML = AI.transcript.map(([who, t]) => who === 'user' ? `<div style="font-weight:700;margin-top:8px">את/ה: ${esc(t)}</div>` : `<div>${mdToHtml(t)}</div>`).join('<hr style="border:none;border-top:1px solid var(--line2)">') || '<span class="note">כאן תופיע התשובה.</span>'; out.scrollTop = out.scrollHeight; };
  const reset = () => { AI.history = []; AI.key = null; AI.transcript = []; draw(); };
  $('#aiRange', sh).onchange = reset; $('#aiClient', sh).onchange = reset; draw();
  const ask = async q => {
    q = (q || '').trim(); if (!q) return;
    $('#aiQ', sh).value = ''; const btn = $('#aiAsk', sh); btn.disabled = true;
    AI.transcript.push(['user', q], ['ai', '_חושב…_']); draw();
    const rk = $('#aiRange', sh).value, who = $('#aiClient', sh).value, k = rk + '|' + who;
    try {
      if (AI.key !== k) {
        const [a, b] = aiRange(rk);
        let evs = await G.eventsMany(selectedCals(), a, b);
        if (who) evs = evs.filter(e => title(e).trim() === who);
        AI.data = `היום: ${isoDate(today())}. תקופה: ${AI_RANGES.find(x => x[0] === rk)[1]} (${dmy(a)}–${dmy(addDays(b, -1))}).` + (who ? ` מטופל/ת: ${who}.` : ' כל המטופלים.') + `\nמספר פגישות בנתונים: ${evs.length}\n\n` + eventsTable(evs);
        AI.key = k; AI.history = [];
      }
      const contents = [{ role: 'user', parts: [{ text: 'הנה הנתונים:\n' + AI.data }] }, { role: 'model', parts: [{ text: 'קיבלתי את הנתונים. מה השאלה?' }] },
        ...AI.history, { role: 'user', parts: [{ text: q }] }];
      const ans = await geminiChat(AI_SYSTEM, contents);
      AI.history.push({ role: 'user', parts: [{ text: q }] }, { role: 'model', parts: [{ text: ans }] });
      AI.transcript[AI.transcript.length - 1] = ['ai', ans];
    } catch (e) { AI.transcript[AI.transcript.length - 1] = ['ai', '⚠ ' + (e instanceof NeedLogin ? 'צריך להתחבר מחדש.' : e.message)]; if (e instanceof NeedLogin) showLoginBanner(); }
    btn.disabled = false; draw();
  };
  sh.querySelectorAll('[data-q]').forEach(b => b.onclick = () => ask(b.dataset.q));
  $('#aiAsk', sh).onclick = () => ask($('#aiQ', sh).value);
  $('#aiQ', sh).onkeydown = e => { if (e.key === 'Enter') ask($('#aiQ', sh).value); };
  $('#aiClose', sh).onclick = closeSheet;
}

async function showRestore() {
  const sh = openSheet(`<h3 style="margin:4px 0 6px">שחזור מגיבוי</h3><div id="rsList"><div class="spinner"></div></div>
    <label class="btn" style="display:block;text-align:center;margin-top:8px">גיבוי מקובץ…<input type="file" accept=".json,application/json" id="rsFile" hidden></label>
    <div id="rsInfo"></div><div class="actions"><button class="btn" id="rsClose">סגירה</button></div>`);
  $('#rsClose', sh).onclick = closeSheet;
  $('#rsFile', sh).onchange = async e => { const f = e.target.files[0]; if (f) analyzeBackup(await f.text(), sh); };
  try {
    const files = await AppData.listBackups();
    $('#rsList', sh).innerHTML = files.length ? files.map(f => `<label class="radio"><input type="radio" name="bk" value="${esc(f.id)}">${dmy(new Date(f.createdTime))} ${hm(new Date(f.createdTime))} · ${Math.round((f.size || 0) / 1024)} KB</label>`).join('')
      + '<button class="btn primary" id="rsCheck" style="width:100%;margin-top:8px">בדיקת הגיבוי שנבחר</button>' : '<p class="note">עוד אין גיבויים ב-Google Drive.</p>';
    const first = sh.querySelector('input[name=bk]'); if (first) first.checked = true;
    const chk = $('#rsCheck', sh);
    if (chk) chk.onclick = async () => { const r = sh.querySelector('input[name=bk]:checked'); if (!r) return; chk.disabled = true; try { analyzeBackup(await AppData.readText(r.value), sh); } catch (e) { handleErr(e); } chk.disabled = false; };
  } catch (e) { $('#rsList', sh).innerHTML = `<p class="err">${esc(e.message)}</p>`; }
}
async function analyzeBackup(text, sh) {
  let bk;
  try { bk = JSON.parse(text); if (bk.app !== 'therapy-calendar') throw new Error(); } catch { alertSheet('שחזור מגיבוי', 'זה לא קובץ גיבוי של יומן הטיפולים.'); return; }
  const info = $('#rsInfo', sh); info.innerHTML = '<div class="spinner"></div>';
  try {
    const ids = new Set(bk.events.map(e => e.calendarId));
    const cals = S.calendars.filter(c => ids.has(c.id));
    const cur = await G.eventsMany(cals, new Date(bk.range.start), new Date(bk.range.end));
    const byId = Object.fromEntries(cur.map(e => [e.id, e]));
    const fix = [], missing = [];
    for (const it of bk.events) { const c = byId[it.id]; const want = appProps(it); if (!c) missing.push(it); else if (!sameProps(appProps(c), want)) fix.push([it, c]); }
    info.innerHTML = `<p>גיבוי מ-${dmy(new Date(bk.created))} ${hm(new Date(bk.created))}: ${bk.events.length} פגישות.<br>• ${fix.length} פגישות שהסימונים שלהן שונים היום מהגיבוי.<br>• ${missing.length} פגישות מהגיבוי שלא קיימות היום ביומן.</p>
      <label class="check"><input type="checkbox" id="rsProps" checked>להחזיר סימונים, תשלומים, מחירים, ביטולים וקבלות</label>
      <label class="check"><input type="checkbox" id="rsMissing" ${missing.length ? '' : 'disabled'}>ליצור מחדש פגישות שנמחקו (כפגישות בודדות)</label>
      <label class="check"><input type="checkbox" id="rsSettings" checked>להחזיר את מחירי הטיפול מהגיבוי</label>
      <button class="btn danger" id="rsGo" style="width:100%;margin-top:8px">שחזור</button>`;
    $('#rsGo', sh).onclick = async () => {
      const doProps = $('#rsProps', sh).checked, doMissing = $('#rsMissing', sh).checked, doSettings = $('#rsSettings', sh).checked;
      const sure = await choose('שחזור מגיבוי', 'לשחזר לפי הגיבוי? הסימונים הנוכחיים של הפגישות האלה יוחלפו במה שבגיבוי.', [{ label: 'כן, לשחזר', value: true, cls: 'danger' }]);
      if (!sure) return;
      busy(true); let fixed = 0, created = 0;
      try {
        if (doProps) for (const [it, c] of fix) {
          const p = { ...props(c) }; for (const k of APP_KEYS) p[k] = ((it.extendedProperties || {}).private || {})[k] || '';
          await G.setProps(it.calendarId, it.id, p); fixed++;
        }
        if (doMissing) for (const it of missing) {
          const body = {}; for (const k of ['summary', 'start', 'end', 'location', 'description', 'colorId', 'extendedProperties', 'reminders']) if (k in it) body[k] = it[k];
          await G.insert(it.calendarId, body); created++;
        }
        if (doSettings && bk.settings) await saveSettings({ ...DEFAULT_SETTINGS, ...bk.settings });
        alertSheet('השחזור הסתיים', `עודכנו ${fixed} פגישות` + (created ? `, נוצרו מחדש ${created}` : '') + '.');
        changed();
      } catch (e) { handleErr(e); } finally { busy(false); }
    };
  } catch (e) { info.innerHTML = ''; handleErr(e); }
}
async function exportBackupFile() {
  busy(true);
  try {
    const text = JSON.stringify(await buildBackup(), null, 1);
    const file = new File([text], backupName(), { type: 'application/json' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) { try { await navigator.share({ files: [file], title: file.name }); return; } catch (e) { if (e.name === 'AbortError') return; } }
    const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = file.name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    toast('הקובץ ירד לתיקיית ההורדות');
  } catch (e) { handleErr(e); } finally { busy(false); }
}

function showPayment(ev) {
  const p = props(ev);
  let receipt = null;
  const sh = openSheet(`<h3 style="margin:4px 0 6px">איך שולמה הפגישה של „${esc(title(ev))}”?</h3>
    ${PAY_METHODS.map(([k, l]) => `<label class="radio"><input type="radio" name="pm" value="${k}" ${p.pay_method === k ? 'checked' : ''}>${l}</label>`).join('')}
    <div class="field"><input type="text" id="payNote" placeholder="מה? למשל צ׳ק, כרטיס אשראי, הוראת קבע…" value="${esc(p.pay_note || '')}"></div>
    <div class="two"><div class="field"><label>סכום (₪)</label><input type="text" inputmode="decimal" id="payAmt" dir="ltr" placeholder="לא חובה" value="${esc(p.pay_amount || '')}"></div>
      <div class="field"><label>תאריך התשלום</label><input type="date" id="payDate" value="${esc(p.pay_date || isoDate(today()))}"></div></div>
    <div class="field"><label>אסמכתא</label><input type="text" id="payRef" placeholder="לא חובה" value="${esc(p.pay_ref || '')}"></div>
    <div class="field"><label>צילום אישור</label>
      <label class="btn" style="display:block;text-align:center">📎 צירוף צילום<input type="file" accept="image/*" id="payFile" hidden></label>
      <div class="note" id="payFileNote">${p.pay_receipt ? 'יש צילום מצורף' : ''}</div></div>
    <p class="err" id="payErr"></p>
    <div class="actions"><button class="btn primary" id="paySave">שמירה</button><button class="btn" id="payCancel">ביטול</button></div>`);
  const note = $('#payNote', sh);
  const sync = () => { const m = sh.querySelector('input[name=pm]:checked'); note.disabled = !(m && m.value === 'other'); };
  sh.querySelectorAll('input[name=pm]').forEach(r => r.onchange = () => { sync(); if (r.value === 'other') note.focus(); });
  sync();
  $('#payFile', sh).onchange = async e => { const f = e.target.files[0]; if (f) { receipt = await shrinkImage(f); $('#payFileNote', sh).textContent = '✓ צילום חדש ייצורף בשמירה'; } };
  $('#payCancel', sh).onclick = () => showDetails(ev);
  $('#paySave', sh).onclick = () => {
    const m = sh.querySelector('input[name=pm]:checked');
    if (!m) { $('#payErr', sh).textContent = 'יש לבחור איך שולמה הפגישה.'; return; }
    if (m.value === 'other' && !note.value.trim()) { $('#payErr', sh).textContent = 'יש לכתוב מה אמצעי התשלום.'; return; }
    const amtTxt = $('#payAmt', sh).value.trim(), amt = toAmount(amtTxt);
    if (amtTxt && !amt) { $('#payErr', sh).textContent = 'הסכום צריך להיות מספר, למשל 250.'; return; }
    setStatus(ev, { paid: 'yes', pay_method: m.value, pay_note: m.value === 'other' ? note.value.trim() : '',
      pay_amount: amt ? String(amt) : '', pay_date: $('#payDate', sh).value, pay_ref: $('#payRef', sh).value.trim() }, { receipt });
    showDetails(ev);
  };
}

async function viewReceipt(ev) {
  const id = props(ev).pay_receipt; if (!id) return;
  const sh = openSheet('<div class="spinner"></div>');
  try {
    const blob = await Drive.download(id);
    const url = URL.createObjectURL(blob);
    sh.innerHTML = `<div class="grip"></div><h3 style="margin:4px 0 8px">אישור תשלום – ${esc(title(ev))}</h3>
      <img src="${url}" alt="" style="width:100%;border-radius:10px;border:1px solid var(--line2)">
      <div class="actions"><a class="btn" style="text-align:center;text-decoration:none" href="https://drive.google.com/file/d/${esc(id)}/view" target="_blank" rel="noopener">פתיחה ב-Google Drive</a>
      <button class="btn" id="rvBack">חזרה</button></div>`;
    $('#rvBack', sh).onclick = () => { URL.revokeObjectURL(url); showDetails(ev); };
  } catch (e) { closeSheet(); handleErr(e); }
}

// ---- עדכון תשלום מצילום
async function startReceipt(file, onSaved = null) {
  if (!S.token || !S.calendars.length) { toast('קודם מתחברים ליומן'); return; }
  if (!DEMO && !store.get('geminiKey', '')) { askGeminiKey(() => startReceipt(file)); return; }
  const blob = await shrinkImage(file);
  const url = URL.createObjectURL(blob);
  openSheet(`<h3 style="margin:4px 0 8px">עדכון תשלום מצילום</h3><img src="${url}" alt="" style="max-height:200px;display:block;margin:0 auto;border-radius:8px">
    <div class="spinner"></div><p class="center muted" style="padding:0">Gemini קורא את הצילום…</p>`);
  try {
    const info = await geminiRead(blob);
    const day = info.date && /^\d{4}-\d{2}-\d{2}$/.test(info.date) ? parseDateOnly(info.date) : today();
    const events = await G.eventsMany(writable(), addDays(day, -75), addDays(day, 2));
    showReceiptMatch(blob, url, info, matchReceipt(info, events), onSaved);
  } catch (e) { closeSheet(); handleErr(e); }
}
function showReceiptMatch(blob, url, info, matches, onSaved = null) {
  const amt0 = toAmount(info.amount);
  const opts = matches.filter(m => m.unpaid.length || m.score > 0);
  let cur = matches.length && matches[0].score > 0 ? matches[0].name : '';
  const sh = openSheet(`<h3 style="margin:4px 0 6px">עדכון תשלום מצילום</h3>
    ${info.is_payment === false ? '<p class="err">שימי לב: נראה שהתמונה הזו היא לא אישור תשלום.</p>' : ''}
    <details style="margin-bottom:6px"><summary class="note">הצגת הצילום</summary><img src="${url}" alt="" style="width:100%;margin-top:6px;border-radius:8px"></details>
    <div class="sec">מה זוהה בצילום (אפשר לתקן)</div>
    <div class="field"><label>שם המשלם</label><input type="text" id="rPayer" value="${esc(info.payer_name || '')}"></div>
    <div class="two"><div class="field"><label>סכום (₪)</label><input type="text" inputmode="decimal" dir="ltr" id="rAmt" value="${amt0 ? amt0 : ''}"></div>
      <div class="field"><label>תאריך התשלום</label><input type="date" id="rDate" value="${esc(/^\d{4}-\d{2}-\d{2}$/.test(info.date || '') ? info.date : isoDate(today()))}"></div></div>
    <div class="two"><div class="field"><label>אמצעי תשלום</label><select id="rMethod">${PAY_METHODS.map(([k, l]) => `<option value="${k}" ${k === (info.method || 'other') ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div class="field"><label>אסמכתא</label><input type="text" id="rRef" value="${esc(info.reference || '')}"></div></div>
    <div class="field" id="rOtherWrap"><input type="text" id="rOther" placeholder="מה אמצעי התשלום?" value="${esc(info.method_other || '')}"></div>
    ${info.description ? `<p class="note">פירוט: ${esc(info.description)}</p>` : ''}
    <div class="sec">לאיזו פגישה שייך התשלום?</div>
    <div class="field"><select id="rClient"><option value="">בחירת מטופל/ת…</option>${opts.map(m => `<option value="${esc(m.name)}" ${m.name === cur ? 'selected' : ''}>${esc(m.name)}${m.unpaid.length ? ` (${m.unpaid.length} טרם שולמו)` : ' (אין פגישות שטרם שולמו)'}</option>`).join('')}</select></div>
    <div id="rSessions"></div><div class="note" id="rShare"></div>
    <label class="check"><input type="checkbox" id="rHeld" checked>לסמן את הפגישות שנבחרו גם כ„התקיימה”</label>
    <p class="err" id="rErr"></p>
    <div class="actions"><button class="btn primary" id="rSave">שמירה</button><button class="btn" id="rCancel">ביטול</button></div>`);
  const syncOther = () => { $('#rOtherWrap', sh).style.display = $('#rMethod', sh).value === 'other' ? '' : 'none'; };
  $('#rMethod', sh).onchange = syncOther; syncOther();
  const selected = () => [...sh.querySelectorAll('#rSessions input:checked')].map(i => S._rcptMap[i.value]).filter(Boolean);
  const updShare = () => {
    const n = selected().length, a = toAmount($('#rAmt', sh).value);
    $('#rShare', sh).textContent = n > 1 && a ? `נבחרו ${n} פגישות · ${fmtMoney(a / n)} לכל פגישה` : n === 1 ? 'נבחרה פגישה אחת' : '';
  };
  const fill = () => {
    const m = matches.find(x => x.name === $('#rClient', sh).value);
    S._rcptMap = {};
    if (!m) { $('#rSessions', sh).innerHTML = ''; updShare(); return; }
    const chosen = new Set(suggestSelection(m.unpaid, m.prices, toAmount($('#rAmt', sh).value)));
    $('#rSessions', sh).innerHTML = m.unpaid.length ? m.unpaid.slice().reverse().map((ev, i) => {
      S._rcptMap[i] = ev; const t = evTimes(ev);
      return `<label class="radio"><input type="checkbox" value="${i}" ${chosen.has(ev) ? 'checked' : ''}>יום ${DAYS[t.s.getDay()]} ${dmy(t.s)} · ${ltr(hm(t.s))} · ${attended(ev) === 'yes' ? 'התקיימה' : 'טרם סומן'}</label>`;
    }).join('') : '<p class="note">אין למטופל/ת הזה/ו פגישות שטרם שולמו בחודשיים האחרונים.</p>';
    sh.querySelectorAll('#rSessions input').forEach(i => i.onchange = updShare);
    updShare();
  };
  $('#rClient', sh).onchange = fill; $('#rAmt', sh).oninput = updShare; fill();
  $('#rCancel', sh).onclick = () => { URL.revokeObjectURL(url); closeSheet(); };
  $('#rSave', sh).onclick = async () => {
    const chosen = selected(), n = chosen.length;
    const amtTxt = $('#rAmt', sh).value.trim(), a = toAmount(amtTxt), method = $('#rMethod', sh).value;
    if (!n) { $('#rErr', sh).textContent = 'יש לבחור לפחות פגישה אחת.'; return; }
    if (amtTxt && !a) { $('#rErr', sh).textContent = 'הסכום צריך להיות מספר.'; return; }
    if (method === 'other' && !$('#rOther', sh).value.trim()) { $('#rErr', sh).textContent = 'יש לכתוב מה אמצעי התשלום.'; return; }
    const changes = { paid: 'yes', pay_method: method, pay_note: method === 'other' ? $('#rOther', sh).value.trim() : '',
      pay_amount: a ? String(Math.round(a / n * 100) / 100) : '', pay_total: a && n > 1 ? String(a) : '',
      pay_date: $('#rDate', sh).value, pay_ref: $('#rRef', sh).value.trim(), pay_payer: $('#rPayer', sh).value.trim() };
    const held = $('#rHeld', sh).checked;
    const btn = $('#rSave', sh); btn.disabled = true; btn.textContent = 'שומר…';
    try {
      const f = await Drive.upload(blob, `אישור תשלום ${changes.pay_payer || title(chosen[0])} ${changes.pay_date}.${blob.type === 'image/png' ? 'png' : 'jpg'}`);
      for (const ev of chosen) {
        const p = { ...props(ev), ...changes, pay_receipt: f.id };
        if (held && !p.attended) p.attended = 'yes';
        const fresh = await G.setProps(ev._calendar_id, ev.id, p, f, null);
        ev.extendedProperties = fresh.extendedProperties || { private: p };
      }
      URL.revokeObjectURL(url); closeSheet();
      rememberPayer(title(chosen[0]).trim(), changes.pay_payer || info.payer_name);
      toast(`✓ התשלום נשמר ב-Google (${n === 1 ? 'פגישה אחת' : n + ' פגישות'}), כולל הצילום`);
      if (onSaved) onSaved();
      changed();
      if (morningReady() && !chosen.some(receiptIssued)) {
        const yes = await choose('קבלה ב-Morning', 'להפיק עכשיו חשבונית מס/קבלה ב-Morning על התשלום הזה?', [{ label: 'כן, להפיק', value: true, cls: 'primary' }]);
        if (yes) showMorningIssue({ ev: chosen[0], extra: chosen, preIds: chosen.map(e => e.id) });
      }
    } catch (e) { btn.disabled = false; btn.textContent = 'שמירה'; handleErr(e); }
  };
}
function rememberPayer(client, payer) {
  // אחרי אישור תשלום: לזכור שהמשלם/ת שייך/ת למטופל/ת, כדי לזהות אוטומטית בפעם הבאה (זהה ל-Windows)
  payer = normName(payer);
  if (!client || !payer || payer === normName(client) || clientPayers(client).map(normName).includes(payer)) return;
  const st = JSON.parse(JSON.stringify(S.settings));
  st.clients = st.clients || {}; const c = st.clients[client] = st.clients[client] || {};
  c.payers = [...(c.payers || []), payer];
  saveSettings(st).catch(() => {});
}
function askGeminiKey(then) {
  const sh = openSheet(`<h3 style="margin:4px 0 6px">מפתח Gemini</h3>
    <p>כדי לקרוא צילומי תשלום, האפליקציה צריכה מפתח Gemini API. יוצרים אותו ב-<a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">Google AI Studio</a> ומדביקים כאן. עושים את זה פעם אחת בטלפון.</p>
    <div class="field"><input type="text" id="gKey" dir="ltr" autocomplete="off" placeholder="AIza…" value="${esc(store.get('geminiKey', ''))}"></div>
    <p class="err" id="gErr"></p>
    <div class="actions"><button class="btn primary" id="gSave">שמירה</button><button class="btn" id="gCancel">ביטול</button></div>`);
  $('#gCancel', sh).onclick = closeSheet;
  $('#gSave', sh).onclick = () => {
    const v = $('#gKey', sh).value.trim();
    if (v.length < 20) { $('#gErr', sh).textContent = 'זה לא נראה כמו מפתח Gemini. הוא בדרך כלל מתחיל ב-AIza.'; return; }
    store.set('geminiKey', v); closeSheet(); toast('מפתח Gemini נשמר');
    if (then) then();
  };
}

// ---- טופס פגישה (חדשה / עריכה)
const timeInput = (id, d) => `<input type="time" id="${id}" step="300" value="${hm(d)}" dir="ltr">`;
function showNewMenu(start = null) {
  // + חדש: מטופל/ת חדש/ה, פגישה למטופל/ת קיים/ת, או אירוע חד-פעמי
  const sh = openSheet(`<h3 style="margin:4px 0 10px">מה להוסיף?</h3>
    <div class="actions" style="flex-direction:column">
      <button class="btn primary" data-p="client" style="padding:14px">👤 מטופל/ת חדש/ה (סדרת טיפולים)</button>
      <button class="btn" data-p="event" style="padding:14px">🗓 פגישה / אירוע חד-פעמי</button>
      <button class="btn" data-p="">ביטול</button></div>`);
  sh.querySelectorAll('[data-p]').forEach(b => b.onclick = () => { if (!b.dataset.p) closeSheet(); else showForm({ start, purpose: b.dataset.p }); });
}
const clientNames = () => [...new Set([...S.index, ...S.events].filter(e => isSession(e) && !evTimes(e).allDay).map(e => title(e).trim()).concat(Object.keys(S.settings.clients || {})))].sort((a, b) => a.localeCompare(b, 'he'));
function showForm({ start = null, ev = null, mode = 'new', master = null, purpose = 'session', oneTime = false, wait = null } = {}) {
  // mode: new | single | instance | series ; purpose: session | client | event
  const editing = !!ev;
  if (editing && !isSession(ev)) purpose = 'event';
  const isEv = purpose === 'event', isClient = purpose === 'client';
  // חד-פעמי חדש: אירוע (לא טיפול), או פגישת טיפול חד-פעמית למטופל/ת קיים/ת
  oneTime = !editing && (oneTime || isEv);
  let s, e;
  if (editing) { const t = evTimes(ev); s = t.s; e = t.e; }
  else {
    s = start || (() => { const d = new Date(S.anchor); d.setHours(16, 0, 0, 0); return d; })();
    e = new Date(s.getTime() + 45 * 60000);
  }
  const cals = writable();
  const curCal = S.calendars.find(c => c.id === S.calId);
  const defCal = curCal && cals.includes(curCal) ? curCal.id : (primaryCal() || cals[0] || {}).id;
  let rem = 30;
  if (editing) { const o = (ev.reminders && ev.reminders.overrides) || []; if (o.length) rem = o[0].minutes; else if (ev.reminders && ev.reminders.useDefault === false) rem = 0; }
  const remOpts = REMINDERS.some(r => r[0] === rem) ? REMINDERS : [...REMINDERS, [rem, `${rem} דק׳ לפני`]].sort((a, b) => a[0] - b[0]);
  let count = isClient ? 0 : 10, repeatLabel = 'חוזר כל שבוע', repeatNote = '';
  if (mode === 'series' && master) {
    const info = rruleInfo(master.recurrence);
    count = info.count || (info.until ? 10 : 0);
    repeatLabel = info.interval === 1 ? 'חוזר כל שבוע' : info.interval === 2 ? 'חוזר כל שבועיים' : `חוזר כל ${info.interval} שבועות`;
    const ms = master.start || {};
    if (ms.dateTime) repeatNote = `מספר הפגישות נספר מהפגישה הראשונה בסדרה (${hebDate(new Date(ms.dateTime))}).`;
  } else if (mode === 'instance') repeatNote = 'כדי לשנות את מספר הפגישות, עורכים את „כל הפגישות בסדרה”.';
  const counts = [...Array.from({ length: 51 }, (_, i) => i + 2)];
  if (count && !counts.includes(count)) counts.push(count), counts.sort((a, b) => a - b);
  const showRepeat = ['new', 'single', 'series'].includes(mode) && !isEv && !oneTime;
  const seriesFirst = mode === 'series' && master && master.start && master.start.dateTime ? (d => new Date(d.getFullYear(), d.getMonth(), d.getDate()))(new Date(master.start.dateTime)) : null;
  const heading = oneTime ? 'פגישה / אירוע חד-פעמי' : isEv ? 'עריכת אירוע' : isClient ? 'מטופל/ת חדש/ה' : (editing ? 'עריכת פגישה' : 'פגישה למטופל/ת קיים/ת');
  const names = clientNames();
  const sh = openSheet(`<h3 style="margin:4px 0 6px">${heading}</h3>
    ${oneTime ? `<label class="check"><input type="checkbox" id="fTherapy" ${isEv ? '' : 'checked'}>זו פגישת טיפול חד-פעמית למטופל/ת קיים/ת</label>` : ''}
    ${isEv ? '<p class="note">אירוע שאינו טיפול: מוצג ביומן באפור, ולא נספר בסיכומים, במספור המפגשים ובתשלומים.</p>' : ''}
    ${mode === 'series' ? '<p class="note">השינויים יחולו על כל הפגישות בסדרה.</p>' : ''}
    ${!editing ? `<div class="field"><label>יומן</label><select id="fCal">${cals.map(c => `<option value="${esc(c.id)}" ${c.id === defCal ? 'selected' : ''}>${esc(calName(c))}${c.primary ? ' (ראשי)' : ''}</option>`).join('')}</select></div>` : ''}
    <div class="field"><label>${isEv ? 'כותרת' : isClient ? 'מטופל/ת חדש/ה' : 'מטופל/ת'}</label><input type="text" id="fName" ${purpose === 'session' ? 'list="fNames"' : ''} placeholder="${isEv ? 'למשל: ישיבת צוות, השתלמות, הדרכה…' : 'שם המטופל/ת'}" value="${esc(editing ? ev.summary || '' : '')}">
      ${purpose === 'session' ? `<datalist id="fNames">${names.map(n => `<option value="${esc(n)}">`).join('')}</datalist>` : ''}</div>
    <div class="field"><label>${isClient ? 'פגישה ראשונה' : seriesFirst ? 'תחילת הסדרה (הפגישה הראשונה)' : 'תאריך'}</label><input type="date" id="fDate" value="${isoDate(seriesFirst || s)}" ${mode === 'series' && !seriesFirst ? 'disabled' : ''}>
      ${seriesFirst ? '<p class="note">אפשר לשנות, למשל אם הטיפולים התחילו בתאריך אחר ממה שהוזן.</p>' : ''}</div>
    <div class="two"><div class="field"><label>שעת התחלה</label>${timeInput('fStart', s)}</div>
      <div class="field"><label>שעת סיום <span id="fLen" class="note"></span></label>${timeInput('fEnd', e)}</div></div>
    <div class="field"><label>מיקום</label><input type="text" id="fLoc" list="locList" placeholder="בוחרים מהרשימה או כותבים מקום אחר" value="${esc(editing ? ev.location || '' : '')}">${locList()}</div>
    <div class="field" ${isEv ? 'hidden' : ''}><label>מחיר (₪) <span class="note" id="fPriceNote"></span></label><input type="text" inputmode="decimal" dir="ltr" id="fPrice" placeholder="לא חובה"></div>
    ${!editing && !isEv ? `<div class="field"><label class="check"><input type="checkbox" id="fInvite">לשלוח זימון ליומן של:</label>
      <input type="email" dir="ltr" id="fEmails" placeholder="מייל של המטופל/ת או ההורה"></div>` : ''}
    ${showRepeat ? `<div class="field"><label>חזרה</label><div class="two" style="align-items:center">
        <label class="check"><input type="checkbox" id="fWeekly" ${mode === 'series' ? 'checked disabled' : isClient ? 'checked' : ''}>${repeatLabel}</label>
        <select id="fCount" ${mode === 'series' || isClient ? '' : 'disabled'}>${counts.map(n => `<option value="${n}" ${n === count ? 'selected' : ''}>${n} פגישות</option>`).join('')}<option value="0" ${count === 0 ? 'selected' : ''}>ללא תאריך סיום</option></select></div></div>` : ''}
    ${repeatNote ? `<p class="note">${esc(repeatNote)}</p>` : ''}
    ${isClient && !editing ? `<div class="field"><label class="check"><input type="checkbox" id="fNoOn" checked>המפגש הראשון הוא מפגש מספר
      <input type="number" inputmode="numeric" min="1" max="999" id="fNo" value="1" dir="ltr" style="width:80px;flex:none;min-height:36px;padding:4px 8px;margin-inline-start:6px"></label></div>` : ''}
    <div class="field"><label>תזכורת</label><select id="fRem">${remOpts.map(([m, l]) => `<option value="${m}" ${m === rem ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
    <div class="field"><label>הערות</label><textarea id="fNotes" rows="3" placeholder="הערות (לא חובה)">${esc(editing ? ev.description || '' : '')}</textarea></div>
    <p class="err" id="fErr"></p>
    <div class="actions"><button class="btn primary" id="fSave">${editing ? 'שמירה' : 'הוספה'}</button><button class="btn" id="fCancel">ביטול</button></div>`);
  const th = $('#fTherapy', sh);
  if (th) th.onchange = () => {
    const keep = { name: $('#fName', sh).value, date: $('#fDate', sh).value, st: $('#fStart', sh).value, en: $('#fEnd', sh).value, loc: $('#fLoc', sh).value, notes: $('#fNotes', sh).value };
    showForm({ start: fromInputs(keep.date, keep.st), purpose: th.checked ? 'session' : 'event', oneTime: true });
    const sh2 = $('#sheet');
    if (!th.checked) $('#fName', sh2).value = keep.name;
    $('#fEnd', sh2).value = keep.en; $('#fLoc', sh2).value = keep.loc; $('#fNotes', sh2).value = keep.notes;
    $('#fEnd', sh2).dispatchEvent(new Event('change'));
  };
  let dur = Math.max(5, Math.round((e - s) / 60000));
  const fs = $('#fStart', sh), fe = $('#fEnd', sh), fl = $('#fLen', sh);
  const toM = v => { const [h, m] = v.split(':').map(Number); return h * 60 + m; };
  const fromM = m => pad(Math.floor(m / 60)) + ':' + pad(m % 60);
  const updLen = () => { const d = toM(fe.value) - toM(fs.value); if (d > 0) { dur = d; fl.textContent = `(${lengthLabel(d)})`; fl.className = 'note'; } else { fl.textContent = 'לפני ההתחלה'; fl.className = 'err'; } };
  fs.onchange = () => { if (fs.value) { fe.value = fromM(Math.min(toM(fs.value) + dur, 23 * 60 + 55)); updLen(); } };
  fe.onchange = updLen; updLen();
  const fp = $('#fPrice', sh), fpn = $('#fPriceNote', sh), fn = $('#fName', sh);
  let priceTouched = false;
  const own = editing ? toAmount(((mode === 'series' && master ? master : ev).extendedProperties || {}).private?.price) : null;
  if (own) { fp.value = own; priceTouched = true; }
  let inviteFor = null;
  const prefill = () => {
    if (isEv) return;
    const name = fn.value.trim(), known = name in (S.settings.clients || {}), pr = clientPrice(name);
    if (!editing && inviteFor !== name) { inviteFor = name; $('#fEmails', sh).value = clientEmails(name).join(', '); $('#fInvite', sh).checked = clientInvites(name); }
    if (!priceTouched) fp.value = pr || '';
    fpn.textContent = !name ? '' : known ? '(מחיר המטופל/ת)' : editing ? '' : '(מטופל/ת חדש/ה · יישמר כברירת מחדל)';
  };
  fp.oninput = () => { priceTouched = true; };
  if (!editing && !isEv) $('#fEmails', sh).oninput = e => { $('#fInvite', sh).checked = !!e.target.value.trim(); };
  fn.addEventListener('change', prefill); fn.addEventListener('blur', prefill);
  if (wait) fn.value = wait.name || '';  // מרשימת ההמתנה
  prefill();
  if (wait && wait.email && !editing && !isEv) $('#fEmails', sh).value = wait.email;
  if (wait && wait.location) $('#fLoc', sh).value = wait.location;
  const wk = $('#fWeekly', sh), cnt = $('#fCount', sh);
  if (wk && mode !== 'series') wk.onchange = () => { cnt.disabled = !wk.checked; };
  let remTouched = false, cntTouched = false;
  $('#fRem', sh).onchange = () => { remTouched = true; };
  if (cnt) cnt.addEventListener('change', () => { cntTouched = true; });
  $('#fCancel', sh).onclick = () => { if (editing) showDetails(ev); else closeSheet(); };
  $('#fSave', sh).onclick = async () => {
    const name = $('#fName', sh).value.trim();
    if (!name) { $('#fErr', sh).textContent = isEv ? 'יש למלא כותרת.' : 'יש למלא את שם המטופל/ת.'; return; }
    if (isClient && !editing && names.includes(name)) {
      const go = await choose('מטופל/ת חדש/ה', `כבר יש ביומן מטופל/ת בשם „${name}”. להוסיף בכל זאת?`, [{ label: 'כן, להוסיף', value: true, cls: 'primary' }]);
      if (!go) return;
    }
    const st = fromInputs($('#fDate', sh).value, fs.value), en = fromInputs($('#fDate', sh).value, fe.value);
    if (!(en > st)) { $('#fErr', sh).textContent = 'שעת הסיום צריכה להיות אחרי שעת ההתחלה.'; return; }
    if (fp.value.trim() && !toAmount(fp.value)) { $('#fErr', sh).textContent = 'המחיר צריך להיות מספר, למשל 250.'; return; }
    const price = toAmount(fp.value);
    let emails = [], invite = false;
    if (!editing && !isEv) {
      const [ok, bad] = parseEmails($('#fEmails', sh).value);
      if (bad.length) { $('#fErr', sh).textContent = `המייל לא תקין: ${bad.join(', ')}`; return; }
      emails = ok; invite = $('#fInvite', sh).checked;
      if (invite && !emails.length) { $('#fErr', sh).textContent = 'כדי לשלוח זימון צריך מייל.'; return; }
    }
    const tz = currentTz();
    const body = { summary: name, start: { dateTime: localStr(st), timeZone: tz }, end: { dateTime: localStr(en), timeZone: tz },
      location: $('#fLoc', sh).value.trim(), description: $('#fNotes', sh).value.trim() };
    const firstNo = isClient && !editing && $('#fNoOn', sh) && $('#fNoOn', sh).checked ? Number($('#fNo', sh).value) || 1 : null;
    if (isEv) { if (!editing) { body.extendedProperties = { private: { kind: 'event' } }; body.colorId = EVENT_COLOR_ID; } }
    else if (!editing) {
      const pr = {}; if (price) pr.price = String(price);
      if (firstNo && !(wk && wk.checked)) pr.session_no = String(firstNo);
      if (Object.keys(pr).length) body.extendedProperties = { private: pr };
    }
    else if (mode === 'series') body.extendedProperties = { private: { price: price ? String(price) : '' } };
    else body.extendedProperties = { private: { ...props(ev), price: price ? String(price) : '' } };
    if (!editing || remTouched) { const m = Number($('#fRem', sh).value); body.reminders = { useDefault: false, overrides: m > 0 ? [{ method: 'popup', minutes: m }] : [] }; }
    const c = cnt ? Number(cnt.value) : 0;
    if (isEv) { /* אירוע חד-פעמי: בלי חזרה */ }
    else if ((mode === 'new' || mode === 'single') && wk && wk.checked) body.recurrence = ['RRULE:FREQ=WEEKLY' + (c ? ';COUNT=' + c : '')];
    else if (mode === 'series' && master && cntTouched) body.recurrence = rruleWithCount(master.recurrence, c);
    let newStart = null, keepNo = null;
    if (seriesFirst) {
      const nd = parseDateOnly($('#fDate', sh).value);
      if (!sameDay(nd, seriesFirst)) {
        newStart = nd;
        const series = S.index.filter(e => e.recurringEventId === ev.recurringEventId).sort((a, b) => evTimes(a).s - evTimes(b).s);
        const firstEv = series.length && sameDay(evTimes(series[0]).s, seriesFirst) ? series[0] : null;
        keepNo = firstEv ? sessionAnchor(firstEv) : null;
        let msg;
        if (nd < seriesFirst) msg = `להקדים את תחילת הסדרה של „${name}” מ-${dmy(seriesFirst)} ל-${dmy(nd)}?\n\nייווספו ביומן הפגישות השבועיות שבין שני התאריכים.`;
        else {
          const lost = series.filter(e => evTimes(e).s < nd), marked = lost.filter(e => attended(e) || paid(e) || receiptIssued(e));
          msg = `לדחות את תחילת הסדרה של „${name}” מ-${dmy(seriesFirst)} ל-${dmy(nd)}?\n\n${lost.length} פגישות שלפני התאריך החדש יוסרו מהיומן.`;
          if (marked.length) msg += `\n\nשימי לב: ב-${marked.length} מהן יש סימונים (התקיימה / תשלום / קבלה), והם יימחקו יחד איתן.`;
        }
        if (nd.getDay() !== seriesFirst.getDay()) msg += `\n\nהפגישות יעברו ליום ${DAYS[nd.getDay()]} בכל שבוע.`;
        if (keepNo) msg += `\n\nמספור המפגשים יתחיל מהפגישה הראשונה החדשה (מפגש ${keepNo}).`;
        if (rruleInfo(master.recurrence).count && !body.recurrence) msg += '\n\nהסדרה מוגבלת במספר פגישות, שייספרו מהתאריך החדש, ולכן גם תאריך הסיום שלה ישתנה.';
        const ok = await choose('תחילת הסדרה', msg, [{ label: 'כן, לעדכן', value: true, cls: 'primary' }]);
        if (!ok) { showForm({ ev, mode, master, purpose }); return; }
      }
    }
    const btn = $('#fSave', sh);  // אחרי חלון אישור הטופס כבר סגור
    if (btn) { btn.disabled = true; btn.textContent = 'שומר…'; } else busy(true);
    try {
      if (!editing && invite) Object.assign(body, attendeeFields(emails));
      if (!editing) {
        const calId = $('#fCal', sh).value;
        const created = await G.insert(calId, body, invite);
        if (firstNo && body.recurrence) {
          // מספר המפגש נשמר על המופע הראשון בסדרה (לא על הסדרה, אחרת כל המופעים יקבלו אותו)
          const inst = await api('GET', `/calendars/${enc(calId)}/events/${enc(created.id)}/instances`, null, qs({ maxResults: 1 }));
          const first = (inst.items || [])[0];
          if (first) await G.setProps(calId, first.id, { ...props(first), session_no: String(firstNo) });
        }
      }
      else if (mode === 'series' && newStart) {
        await G.updateSeries(ev._calendar_id, ev.recurringEventId, body, tz, hasGuests(ev), newStart);
        if (keepNo) {
          const inst = await api('GET', `/calendars/${enc(ev._calendar_id)}/events/${enc(ev.recurringEventId)}/instances`, null, qs({ maxResults: 1 }));
          const first = (inst.items || [])[0];
          if (first) await G.setProps(ev._calendar_id, first.id, { ...props(first), session_no: String(keepNo) });
        }
      }
      else if (mode === 'series') await G.updateSeries(ev._calendar_id, ev.recurringEventId, body, tz, hasGuests(ev));
      else await G.patch(ev._calendar_id, ev.id, body, hasGuests(ev));
      closeSheet(); toast(editing ? 'השינויים נשמרו' : isEv ? `נוסף אירוע: ${name}` : `נוספה פגישה: ${name}`);
      if (!editing && !isEv) {
        const info = { ...clientInfo(name) }, before = JSON.stringify(info);
        if (price && !('price' in info) && !(name in (S.settings.clients || {}))) info.price = price;
        if (emails.length) info.emails = emails;
        if (emails.length || info.invite) { if (invite) info.invite = true; else delete info.invite; }
        if (wait && wait.phone && !info.phone) info.phone = wait.phone;
        const wl = (S.settings.waitlist || []).filter(x => !wait || x.id !== wait.id);
        const st = { ...S.settings, waitlist: wl, locations: [...(S.settings.locations || [])], clients: { ...(S.settings.clients || {}), [name]: info } };
        const newLoc = addLocation(st, body.location);
        if (JSON.stringify(info) !== before || wl.length !== (S.settings.waitlist || []).length || newLoc) saveSettings(st);
        if (invite) toast(`נוספה פגישה: ${name} · נשלח זימון`);
      }
      changed();
    } catch (err) { if (btn) { btn.disabled = false; btn.textContent = editing ? 'שמירה' : 'הוספה'; } handleErr(err); }
    finally { if (!btn) busy(false); }
  };
}

async function editEvent(ev) {
  let mode = 'single';
  if (ev.recurringEventId) {
    const scope = await choose('עריכת פגישה', 'זו פגישה קבועה. על מה להחיל את השינוי?',
      [{ label: 'רק הפגישה הזו', value: 'one' }, { label: 'כל הפגישות בסדרה', value: 'all' }]);
    if (!scope) { showDetails(ev); return; }
    if (scope === 'all') {
      busy(true);
      try { const master = await G.get(ev._calendar_id, ev.recurringEventId); showForm({ ev, mode: 'series', master }); }
      catch (e) { handleErr(e); } finally { busy(false); }
      return;
    }
    mode = 'instance';
  }
  showForm({ ev, mode });
}

// ---- הזזה
function showMove(ev) {
  const t = evTimes(ev);
  const sh = openSheet(`<h3 style="margin:4px 0 6px">הזזת פגישה</h3>
    <p>„${esc(title(ev))}”<br><span class="note">כרגע: יום ${DAYS[t.s.getDay()]}, ${hebDate(t.s)} · ${ltr(hm(t.s) + '–' + hm(t.e))}</span></p>
    <div class="field"><label>תאריך חדש</label><input type="date" id="mDate" value="${isoDate(t.s)}"></div>
    <div class="two"><div class="field"><label>שעת התחלה</label>${timeInput('mStart', t.s)}</div>
      <div class="field"><label>שעת סיום <span id="mLen" class="note"></span></label>${timeInput('mEnd', t.e)}</div></div>
    ${ev.recurringEventId ? '<p class="note">רק הפגישה הזו תוזז. שאר הפגישות בסדרה יישארו כמו שהן.</p>' : ''}
    <p class="err" id="mErr"></p>
    <div class="actions"><button class="btn primary" id="mSave">הזזה</button><button class="btn" id="mCancel">ביטול</button></div>`);
  let dur = Math.round((t.e - t.s) / 60000);
  const ms = $('#mStart', sh), me = $('#mEnd', sh), ml = $('#mLen', sh);
  const toM = v => { const [h, m] = v.split(':').map(Number); return h * 60 + m; };
  const fromM = m => pad(Math.floor(m / 60)) + ':' + pad(m % 60);
  const upd = () => { const d = toM(me.value) - toM(ms.value); if (d > 0) { dur = d; ml.textContent = `(${lengthLabel(d)})`; ml.className = 'note'; } else { ml.textContent = 'לפני ההתחלה'; ml.className = 'err'; } };
  ms.onchange = () => { if (ms.value) { me.value = fromM(Math.min(toM(ms.value) + dur, 23 * 60 + 55)); upd(); } };
  me.onchange = upd; upd();
  $('#mCancel', sh).onclick = () => showDetails(ev);
  $('#mSave', sh).onclick = async () => {
    const st = fromInputs($('#mDate', sh).value, ms.value), en = fromInputs($('#mDate', sh).value, me.value);
    if (!(en > st)) { $('#mErr', sh).textContent = 'שעת הסיום צריכה להיות אחרי שעת ההתחלה.'; return; }
    const tz = currentTz();
    const g = await guardSequence(ev, { start: st, end: en }, false);
    if (!g.ok) { showMove(ev); return; }
    const btn = $('#mSave', sh); if (btn) { btn.disabled = true; btn.textContent = 'מזיז…'; } else busy(true);
    try {
      await G.patch(ev._calendar_id, ev.id, { start: { dateTime: localStr(st), timeZone: tz }, end: { dateTime: localStr(en), timeZone: tz } }, hasGuests(ev));
      closeSheet(); toast(`„${title(ev)}” הוזזה ליום ${DAYS[st.getDay()]}, ${hebDate(st)} בשעה ${hm(st)}`);
      changed();
    } catch (e) { if (btn) { btn.disabled = false; btn.textContent = 'הזזה'; } handleErr(e); }
    finally { if (!btn) busy(false); }
  };
}

// ---- מחיקה
async function deleteEvent(ev) {
  let target = ev.id;
  if (ev.recurringEventId) {
    const scope = await choose('מחיקת פגישה', 'זו פגישה קבועה. מה למחוק?',
      [{ label: 'רק הפגישה הזו', value: 'one', cls: 'danger' }, { label: 'כל הפגישות בסדרה', value: 'all', cls: 'danger' }]);
    if (!scope) { showDetails(ev); return; }
    if (scope === 'all') {
      const sure = await choose('מחיקת סדרה', `למחוק את כל הפגישות בסדרה של „${title(ev)}”? אי אפשר לבטל את הפעולה.`, [{ label: 'כן, למחוק הכול', value: true, cls: 'danger' }]);
      if (!sure) { showDetails(ev); return; }
      target = ev.recurringEventId;
    }
  } else {
    const t = evTimes(ev);
    const sure = await choose('מחיקת פגישה', `למחוק את „${title(ev)}” ב-${hebDate(t.s)}${t.allDay ? '' : ' בשעה ' + hm(t.s)}?`, [{ label: 'מחיקה', value: true, cls: 'danger' }]);
    if (!sure) { showDetails(ev); return; }
  }
  let pin = null;
  if (target === ev.id) { const g = await guardSequence(ev, { remove: true }); if (!g.ok) { showDetails(ev); return; } pin = g.pin; }
  busy(true);
  try { await G.del(ev._calendar_id, target, hasGuests(ev)); toast('הפגישה נמחקה'); applyPin(pin); changed(); }
  catch (e) { handleErr(e); } finally { busy(false); }
}

// ---- תפריט
function showMenu() {
  if (!S.token) return;
  const opts = [{ id: ALL, name: 'כל היומנים' }, ...S.calendars.slice().sort((a, b) => (b.primary ? 1 : 0) - (a.primary ? 1 : 0))
    .map(c => ({ id: c.id, name: calName(c) + (c.primary ? ' (ראשי)' : '') + (['owner', 'writer'].includes(c.accessRole) ? '' : ' (צפייה בלבד)') }))];
  const sh = openSheet(`<h3 style="margin:4px 0 4px">יומן</h3>
    ${opts.map(o => `<label class="radio"><input type="radio" name="cal" value="${esc(o.id)}" ${o.id === S.calId ? 'checked' : ''}>${esc(o.name)}</label>`).join('')}
    <h3 style="margin:18px 0 4px">מחירים וגיבוי</h3>
    <div class="menu-item"><span style="flex:1">מטופלים: מחירים ומיילים</span><button class="btn" id="mPrices">עריכה</button></div>
    <div class="menu-item"><span style="flex:1">מקומות טיפול${(S.settings.locations || []).length ? ` (${S.settings.locations.length})` : ''}</span><button class="btn" id="mLocs">עריכה</button></div>
    <div class="menu-item"><span style="flex:1">תזכורות למטופלים ותזכורת תשלום ${(S.settings.reminders || {}).enabled ? '✓' : ''}</span><button class="btn" id="mRemind">הגדרה</button></div>
    <div class="menu-item"><label class="check" style="flex:1"><input type="checkbox" id="mDay" ${store.get('daySummary', true) !== false ? 'checked' : ''}>חלון סימון בסוף היום</label>
      <select id="mDayHour">${Array.from({ length: 12 }, (_, i) => i + 12).map(h => `<option value="${h}" ${+store.get('daySummaryHour', DAY_SUMMARY_HOUR) === h ? 'selected' : ''}>${pad(h)}:00</option>`).join('')}</select></div>
    <div class="menu-item"><span style="flex:1">גיבוי</span><button class="btn" id="mBackup">גיבוי עכשיו</button></div>
    <div class="menu-item"><span style="flex:1">קובץ גיבוי</span><button class="btn" id="mExport">ייצוא</button><button class="btn" id="mRestore">שחזור</button></div>
    <label class="check"><input type="checkbox" id="mEmail" ${S.settings.backup_email !== false ? 'checked' : ''}>שליחת הגיבוי היומי למייל</label>
    <div class="menu-item"><label class="check" style="flex:1"><input type="checkbox" id="mHol" ${S.settings.holidays !== false ? 'checked' : ''}>חגי ישראל ביומן</label><button class="btn" id="mHolRefresh">רענון</button></div>
    <div class="menu-item"><span style="flex:1">Morning – קבלות ${morningReady() ? '✓' : ''}</span><button class="btn" id="mMorning">הגדרה</button></div>
    <div class="menu-item"><span style="flex:1">הוספת הוצאה ל-Morning</span><button class="btn primary" id="mExpense">📤 העלאה</button></div>
    <div class="menu-item"><span style="flex:1">שיתוף מוואטסאפ / מייל לאפליקציה</span><span class="note">${'serviceWorker' in navigator && navigator.serviceWorker.controller ? '✓ מוכן' : '⏳ עוד לא מוכן – סוגרים ופותחים את האפליקציה'}</span></div>
    <h3 style="margin:18px 0 4px">צילומי תשלום</h3>
    <div class="menu-item"><span style="flex:1">מפתח Gemini: ${store.get('geminiKey', '') ? '✓ מוגדר' : 'לא מוגדר'}</span><button class="btn" id="gKeyBtn">${store.get('geminiKey', '') ? 'החלפה' : 'הגדרה'}</button></div>
    <h3 style="margin:18px 0 4px">חשבון</h3>
    <div class="menu-item"><span style="flex:1" dir="ltr">${esc(S.email || '')}</span></div>
    <div class="actions"><button class="btn danger" id="soBtn">התנתקות</button><button class="btn" id="mClose">סגירה</button></div>
    <p class="note" style="margin-top:14px">כל הנתונים נשמרים ב-Google Calendar, ולכן הם זהים בטלפון ובמחשב.</p>
    <p class="note">גרסה ${APP_VERSION}</p>`);
  sh.querySelectorAll('input[name=cal]').forEach(r => r.onchange = () => { S.calId = r.value; store.set('calId', r.value); closeSheet(); S.loaded = false; renderView(); loadEvents(); });
  $('#soBtn', sh).onclick = signOut;
  $('#gKeyBtn', sh).onclick = () => askGeminiKey(null);
  $('#mPrices', sh).onclick = showPrices;
  $('#mRemind', sh).onclick = showReminders;
  $('#mLocs', sh).onclick = showLocations;
  $('#mDay', sh).onchange = e => store.set('daySummary', e.target.checked);
  $('#mDayHour', sh).onchange = e => { store.set('daySummaryHour', +e.target.value); store.set('daySummaryShown', ''); };
  $('#mMorning', sh).onclick = () => showMorningSettings(null);
  $('#mExpense', sh).onclick = () => showExpenses();
  $('#mBackup', sh).onclick = () => { closeSheet(); makeBackup(false); };
  $('#mExport', sh).onclick = () => { closeSheet(); exportBackupFile(); };
  $('#mRestore', sh).onclick = showRestore;
  $('#mEmail', sh).onchange = e => saveSettings({ ...S.settings, backup_email: e.target.checked });
  $('#mHol', sh).onchange = e => saveSettings({ ...S.settings, holidays: e.target.checked });
  $('#mHolRefresh', sh).onclick = async () => {
    const y = new Date().getFullYear();
    try {
      const items = await fetchHolidays(y);
      const all = store.get('holidays', {}); all[y] = { ts: Date.now(), items }; store.set('holidays', all); addHolidays(y, items);
      const next = items.filter(h => h.date >= isoDate(today())).slice(0, 3).map(h => `• ${dmy(parseDateOnly(h.date))} – ${h.name}`).join('\n');
      alertSheet('חגי ישראל', `נטענו ${items.length} חגים ומועדים לשנת ${y}.` + (next ? `\n\nהקרובים:\n${next}` : ''));
      renderView.keepScroll = true; renderView();
    } catch (e) { alertSheet('חגי ישראל', 'לא הצלחתי לטעון את חגי ישראל מ-hebcal.com. בודקים שיש חיבור לאינטרנט.\n' + e.message); }
  };
  $('#mClose', sh).onclick = closeSheet;
}

// ------------------------------------------------------------------ מצב הדגמה (לבדיקה בלבד: ?demo)
const Mock = {
  data: null,
  files: {},
  settings: { default_price: 200, clients: { 'דרור גרינברג': { price: 250 } } },
  backups: [],
  sent: [],
  answer(contents) { const q = contents[contents.length - 1].parts[0].text; return `**תשובת הדגמה** לשאלה: ${q}\n\n| מטופל/ת | חוב |\n|---|---|\n| דרור גרינברג | ₪250 |\n\n- סה״כ חוב: **₪250**`; },
  gemini() {
    const d = addDays(today(), -1);
    return { is_payment: true, payer_name: 'מיכל גרינברג', amount: 500, date: isoDate(today()), time: '20:14', method: 'bit',
      method_other: '', reference: '88123456', description: 'טיפולים לדרור' };
  },
  init() {
    const masters = {}; const ws = weekStart(new Date(2026, 8, 1));
    const sched = { 0: [[16, 0, 'נריה ביר']], 1: [[7, 45, 'יערה וינשטיין'], [8, 45, 'דרור גרינברג'], [11, 0, 'עילאי יונגר'], [12, 15, 'עדי לוי'], [13, 0, 'איתי צדקני']],
      2: [[17, 30, 'אנגלית לארבל']], 3: [[7, 45, 'איתן מדמון'], [9, 30, 'רון אלון בנימין'], [11, 0, 'נטע קרויזר'], [11, 55, 'יובל טלינגר'], [12, 40, 'יואב שר']],
      4: [[13, 0, 'איתם קעטבי'], [14, 0, 'אדר']] };
    let n = 0;
    for (const [dow, list] of Object.entries(sched)) for (const [h, m, name] of list) {
      const s = addDays(ws, Number(dow)); s.setHours(h, m); const e = new Date(s.getTime() + 45 * 60000);
      const id = 'm' + (n++);
      masters[id] = { id, summary: name, start: { dateTime: localStr(s), timeZone: DEFAULT_TZ }, end: { dateTime: localStr(e), timeZone: DEFAULT_TZ }, recurrence: ['RRULE:FREQ=WEEKLY;COUNT=40'], location: name === 'עדי לוי' ? 'קליניקה' : '' };
    }
    const f = new Date(); f.setHours(10, 0, 0, 0); while (f.getDay() !== 5) f.setDate(f.getDate() + 1);
    masters.single = { id: 'single', summary: 'ליאור', start: { dateTime: localStr(f) }, end: { dateTime: localStr(new Date(f.getTime() + 3600000)) } };
    const ad = today(); masters.allday = { id: 'allday', summary: 'איסוף חולצות', start: { date: isoDate(ad) }, end: { date: isoDate(addDays(ad, 1)) } };
    this.data = { masters, overrides: {}, deleted: new Set() };
    // כמה סימונים לדוגמה
    for (let i = 1; i <= 10; i++) {
      const d = addDays(today(), -i);
      for (const ev of this.expand(d, addDays(d, 1))) {
        const r = (ev.summary.length * 7 + i) % 10;
        const p = r < 1 ? { attended: 'no' } : r < 4 ? { attended: 'yes' } : { attended: 'yes', paid: 'yes', pay_method: ['cash', 'bank', 'bit', 'paybox'][r % 4] };
        this.data.overrides[ev.id] = { ...ev, extendedProperties: { private: p } };
      }
    }
  },
  expand(start, end) {
    const out = [];
    for (const m of Object.values(this.data.masters)) {
      if (!m.recurrence) { const t = evTimes(m); if (t.s < end && t.e > start && !this.data.deleted.has(m.id)) out.push(JSON.parse(JSON.stringify(m))); continue; }
      const info = rruleInfo(m.recurrence); const t0 = evTimes(m);
      const count = info.count || 200;
      for (let k = 0; k < count; k++) {
        const s = addDays(t0.s, 7 * info.interval * k); if (s >= end) break;
        const id = m.id + '_' + isoDate(s).replace(/-/g, '');
        if (this.data.deleted.has(id)) continue;
        let inst = this.data.overrides[id];
        if (!inst) { const e = new Date(s.getTime() + (t0.e - t0.s)); inst = { ...JSON.parse(JSON.stringify(m)), id, recurringEventId: m.id, start: { dateTime: localStr(s) }, end: { dateTime: localStr(e) } }; delete inst.recurrence; }
        const ti = evTimes(inst);
        if (ti.s < end && ti.e > start) out.push(JSON.parse(JSON.stringify(inst)));
      }
    }
    return out.sort((a, b) => evTimes(a).s - evTimes(b).s);
  },
  find(id) {
    if (this.data.masters[id]) return this.data.masters[id];
    if (this.data.overrides[id]) return this.data.overrides[id];
    const [mid, ymd] = id.split('_'); const m = this.data.masters[mid]; if (!m || !ymd) return null;
    const d = parseDateOnly(ymd.slice(0, 4) + '-' + ymd.slice(4, 6) + '-' + ymd.slice(6, 8));
    return this.expand(d, addDays(d, 1)).find(e => e.id === id) || null;
  },
  async handle(method, path, body, query) {
    if (!this.data) this.init();
    await new Promise(r => setTimeout(r, 120));
    const p = new URLSearchParams(query || '');
    if (path === '/users/me/calendarList') return { items: [{ id: 'chenorlan@gmail.com', summary: 'chenorlan@gmail.com', primary: true, accessRole: 'owner', backgroundColor: '#7986CB', timeZone: DEFAULT_TZ }] };
    const parts = path.split('/').map(decodeURIComponent); // ['', 'calendars', id, 'events', evId?]
    const evId = parts[4];
    if (method === 'GET' && parts[5] === 'instances') {
      const m = this.data.masters[evId]; if (!m) return { items: [] };
      const t0 = evTimes(m); return { items: this.expand(t0.s, addDays(t0.s, 1)).filter(e => e.recurringEventId === evId).slice(0, 1) };
    }
    if (method === 'GET' && !evId) return { items: this.expand(new Date(p.get('timeMin')), new Date(p.get('timeMax'))) };
    if (method === 'GET') { const ev = this.find(evId); if (!ev) throw new Error('Not found'); return JSON.parse(JSON.stringify(ev)); }
    if (method === 'POST') { const id = 'n' + Date.now(); this.data.masters[id] = { ...body, id }; return this.data.masters[id]; }
    if (method === 'PATCH') {
      const cur = this.find(evId); if (!cur) throw new Error('Not found');
      const upd = { ...JSON.parse(JSON.stringify(cur)), ...body };
      if (this.data.masters[evId]) this.data.masters[evId] = upd; else this.data.overrides[evId] = upd;
      return JSON.parse(JSON.stringify(upd));
    }
    if (method === 'DELETE') { if (this.data.masters[evId]) delete this.data.masters[evId]; else this.data.deleted.add(evId); return null; }
    throw new Error('unsupported');
  },
};

// ------------------------------------------------------------------ התחלה
function init() {
  restoreToken();
  $('#menuBtn').onclick = showMenu;
  $('#receiptBtn').onclick = () => $('#receiptFile').click();
  $('#aiBtn').onclick = () => { if (S.token && S.calendars.length) showAI(); };
  $('#receiptFile').onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) handleDocument(f); };
  $('#refreshBtn').onclick = () => { renderView.keepScroll = true; S.calendars.length ? loadEvents() : loadCalendars(); };
  $('#todayBtn').onclick = () => { S.anchor = today(); S.loaded = false; renderView(); loadEvents(); };
  $('#prevBtn').onclick = () => step(-1);
  $('#nextBtn').onclick = () => step(1);
  $('#fab').onclick = () => showNewMenu();
  $('#sheetBack').onclick = closeSheet;
  document.querySelectorAll('#tabs button').forEach(b => b.onclick = () => setView(b.dataset.view));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.token && S.calendars.length && $('#sheet').hidden) { renderView.keepScroll = true; loadEvents(); checkInbox(); } });
  $('#inboxBtn').onclick = () => { if (S.token && S.calendars.length) showInbox(); };
  setInterval(() => { if (document.visibilityState === 'visible' && S.token && S.calendars.length && $('#sheet').hidden) { renderView.keepScroll = true; loadEvents(); } }, 5 * 60 * 1000);
  setInterval(() => { if (S.view === 'day' || S.view === 'week') { const nl = $('.nowline'); if (nl) { renderView.keepScroll = true; renderView(); } } }, 60 * 1000);
  if ('serviceWorker' in navigator && !DEMO && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(r => r.update()).catch(() => {});
  }
  render();
}
init();
