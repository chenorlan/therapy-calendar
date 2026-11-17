const APP_VERSION = '44';
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
const OLD_MORNING_ITEM = 'טיפול בקלינאות תקשורת';
const DEFAULT_MORNING = { env: 'sandbox', item: 'טיפולי שפה ודיבור בחודש {חודש}', template: 'עבור {מספר_טיפולים} טיפולים בתאריכים: {תאריכים}', vat_included: true, send_email: true, send_whatsapp: true };
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
const morningCfg = () => { const m = { ...DEFAULT_MORNING, ...(S.settings.morning || {}) }; if (m.item === OLD_MORNING_ITEM) m.item = DEFAULT_MORNING.item; return m; };
function monthsText(ss) {
  // החודשים של הטיפולים, למשל „נובמבר 2026” או „אוקטובר ונובמבר 2026” – זהה ל-Windows
  const ms = [...new Set(ss.map(e => { const s = evTimes(e).s; return s.getFullYear() * 100 + s.getMonth(); }))].sort();
  if (!ms.length) return '';
  const years = new Set(ms.map(x => Math.floor(x / 100)));
  if (years.size === 1) { const n = ms.map(x => MONTHS[x % 100]); return (n.length === 1 ? n[0] : n.slice(0, -1).join(', ') + ' ו' + n[n.length - 1]) + ' ' + Math.floor(ms[0] / 100); }
  return ms.map(x => MONTHS[x % 100] + ' ' + Math.floor(x / 100)).join(', ');
}
function renderItem(item, ss) {
  item = (item || '').trim() || DEFAULT_MORNING.item;
  if (item === OLD_MORNING_ITEM) item = DEFAULT_MORNING.item;
  if (new Set(ss.map(e => { const d = evTimes(e).s; return d.getFullYear() * 100 + d.getMonth(); })).size > 1) item = item.split('בחודש {חודש}').join('בחודשים {חודש}');
  return item.split('{חודש}').join(monthsText(ss)).trim();
}
const morningKeys = env => (store.get('morningKeys', {}) || {})[env] || {};
const morningReady = () => { const k = morningKeys(morningCfg().env); return !!(k.id && k.secret); };
const morningRelay = () => (store.get('morningRelay', '') || '').trim();
async function relayPost(payload) {
  // ממסר ב-Google Apps Script: Morning חוסמים פניות ישירות מדפדפן, אז הבקשה עוברת דרך Google
  let r;
  try { r = await fetchT(morningRelay(), { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payload), redirect: 'follow' }, 60000); }
  catch (e) { if (e.timeout) throw new Error('הממסר לא ענה תוך דקה. כדאי לבדוק באתר Morning אם הקבלה בכל זאת הופקה, לפני שמנסים שוב.'); throw new Error('לא הצלחתי להתחבר לממסר. בודקים שהכתובת בהגדרות Morning נכונה (מסתיימת ב-/exec), ושבפריסה נבחר Who has access: Anyone.'); }
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
      r = await fetchT(url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined }, 60000);
    } catch (e) {
      if (e.timeout) throw new Error('Morning לא ענו תוך דקה. כדאי לבדוק באתר Morning אם המסמך בכל זאת הופק, לפני שמנסים שוב.');
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
async function morningSearchClients(env, name) {
  // אנשי קשר שמורים ב-Morning שהשם שלהם מתאים – זהה ל-Windows
  if (DEMO) { await new Promise(r => setTimeout(r, 200)); return name.includes(' ') ? [{ id: 'C1', name, emails: ['parent@example.com'] }] : []; }
  const res = await morningCall(env, 'POST', '/clients/search', { name: (name || '').trim(), active: true, page: 1, pageSize: 25 }, await morningToken(env));
  const items = Array.isArray(res) ? res : (res.items || []);
  return items.filter(c => c.id).map(c => ({ id: c.id, name: c.name || '', emails: (c.emails || []).filter(Boolean) }));
}
function pickMorningContact(contacts, ...names) {
  // לפי סדר השמות: קודם שם המטופל/ת (הילד/ה – להורה יכולים להיות כמה ילדים), ואז שם המשלם – זהה ל-Windows
  const ns = names.filter(Boolean);
  for (const n of ns) {
    const exact = contacts.filter(c => normName(c.name) === normName(n));
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) return null;
  }
  return contacts.length === 1 && ns.length === 1 ? contacts[0] : null;
}
async function findMorningContact(env, client, payer = '') {
  // קודם לפי שם המטופל/ת, ורק אם לא נמצא – לפי שם המשלם
  const found = client ? await morningSearchClients(env, client) : [];
  const c = pickMorningContact(found, client);
  if (c || !payer || normName(payer) === normName(client)) return [c, found];
  const more = await morningSearchClients(env, payer), ids = new Set(found.map(f => f.id));
  return [pickMorningContact(more, payer), found.concat(more.filter(x => !ids.has(x.id)))];
}
async function linkMorningContact(name, contact) {
  // זוכרים איזה איש קשר ב-Morning שייך למטופל/ת (במחשב ובטלפון)
  name = (name || '').trim(); if (!name) return;
  if (((clientInfo(name).morning_client) || {}).id === (contact || {}).id) return;
  const st = JSON.parse(JSON.stringify(S.settings)); st.clients = st.clients || {};
  const info = st.clients[name] = st.clients[name] || {};
  if (contact) info.morning_client = { id: contact.id, name: contact.name || '', emails: contact.emails || [] }; else delete info.morning_client;
  await saveSettings(st);
}
async function morningCreate(env, body) {
  if (DEMO) { await new Promise(r => setTimeout(r, 400)); return { id: 'demodoc', number: 10045, url: { he: '#' } }; }
  return morningCall(env, 'POST', '/documents', body, await morningToken(env));
}
const sessionAmount = ev => payAmount(ev) || evPrice(ev);
const receiptDatesText = ss => ss.map(e => evTimes(e).s).sort((a, b) => a - b).map(dmy).join(', ');
const renderReceiptText = (tpl, ss, name) => tpl.replace('{תאריכים}', receiptDatesText(ss)).replace('{מספר_טיפולים}', String(ss.length))
  .replace('{שם_מטופל}', name).replace('{סכום}', fmtMoney(ss.reduce((a, e) => a + (sessionAmount(e) || 0), 0)));
function morningDocument(ss, { name, emails, send, item, remarks, date, vatIncluded, clientId = null }) {
  item = renderItem(item, ss);
  const byPrice = {}, pays = {};
  for (const e of ss) { const a = Math.round(sessionAmount(e) * 100) / 100; byPrice[a] = (byPrice[a] || 0) + 1; }
  for (const e of ss) { const p = props(e), k = (p.pay_method || 'other') + '|' + (p.pay_date || date); pays[k] = Math.round(((pays[k] || 0) + sessionAmount(e)) * 100) / 100; }
  return { type: 320, date, lang: 'he', currency: 'ILS', vatType: 0, rounding: false, signed: true, attachment: !!(send && emails.length),
    client: clientId ? { id: clientId, name, emails } : { name, emails, add: false },
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
  const pool = numberPool();
  if (!pool.some(e => e.id === ev.id)) return [];
  const before = computeNumbers(pool);
  const sim = [];
  for (const e of pool) {
    if (e.id !== ev.id) { sim.push(e); continue; }
    if (remove) continue;
    const e2 = { ...e };
    if (np) e2.extendedProperties = { private: np };
    if (start) { e2.start = { dateTime: start.toISOString() }; e2.end = { dateTime: end.toISOString() }; }
    sim.push(e2);
  }
  const after = computeNumbers(sim), name = title(ev).trim();
  return pool.filter(e => e.id !== ev.id && title(e).trim() === name && (before[e.id] || null) !== (after[e.id] || null))
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
  const pool = numberPool(), sim = pool.map(e => e.id === ev.id ? { ...e, extendedProperties: { private: { ...props(ev), session_no: '' } } } : e);
  if (!pool.some(e => e.id === ev.id)) sim.push({ ...ev, extendedProperties: { private: { ...props(ev), session_no: '' } } });
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
    if (!loadIndex.alerted) { loadIndex.alerted = true; setTimeout(refreshAlerts, 2500); setTimeout(importIntake, 4000); }
  } catch { /* ignore */ }
}
// המספור מחושב מההיסטוריה (שנתיים אחורה), וגם מהפגישות שמוצגות עכשיו – כדי שמספר שנקבע יופיע מיד,
// גם אם ההיסטוריה עוד לא נטענה או שהפגישה מחוץ לטווח שלה (זהה ל-Windows)
function numberPool() { const ids = new Set(S.index.map(e => e.id)); return S.index.concat(S.events.filter(e => !ids.has(e.id))); }
function renumber() { S.numbers = computeNumbers(numberPool()); renderView.keepScroll = true; renderView(); }
function syncIndex(ev) {
  const it = S.index.find(x => x.id === ev.id);
  if (it) it.extendedProperties = JSON.parse(JSON.stringify(ev.extendedProperties || {}));
  S.numbers = computeNumbers(numberPool());
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
    recordUsage(model, j);
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
    recordUsage(model, j);
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
  if (sumWeekly()) { const ws = weekStart(a); return [ws, addDays(ws, 7)]; }
  const first = new Date(a.getFullYear(), a.getMonth(), 1);
  return [first, new Date(a.getFullYear(), a.getMonth() + 1, 1)];
}
// סיכום שבועי או חודשי (זהה ל-Windows)
const sumWeekly = () => S.view === 'summary' && store.get('sumPeriod', 'month') === 'week';
function sumPeriodName() {
  if (!sumWeekly()) return `${MONTHS[S.anchor.getMonth()]} ${S.anchor.getFullYear()}`;
  const ws = weekStart(S.anchor), we = addDays(ws, 6);
  return `שבוע ${dmy(ws).slice(0, 5)}–${dmy(we)}`;
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
async function checkInbox() { if (!feat('inbox')) return; try { setInboxCount((await Inbox.list()).length); } catch { /* ignore */ } }
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
    S.numbers = computeNumbers(numberPool());
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
  } else t = S.view === 'summary' ? sumPeriodName() : `${MONTHS[a.getMonth()]} ${a.getFullYear()}`;
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
  else if (S.view === 'week') { const ws = weekStart(S.anchor), wd = weekDays(); main.innerHTML = timeGridHtml(Array.from({ length: 7 }, (_, i) => addDays(ws, i)).filter(d => wd.includes(d.getDay()))); }
  else if (S.view === 'month') main.innerHTML = monthHtml();
  else if (S.view === 'list') main.innerHTML = listHtml();
  else main.innerHTML = summaryHtml();
  bindView();
  applyFeatures();
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
  const wd = weekDays(), days = monthDays().filter(d => wd.includes(d.getDay())), td = today(), m = S.anchor.getMonth();
  const gc = `style="grid-template-columns:repeat(${wd.length}, 1fr)"`;
  let h = `<div class="mo-head" ${gc}>` + wd.map(i => `<div>${DAYS_S[i]}</div>`).join('') + `</div><div class="mo-grid" ${gc}>`;
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

// ---- סיכום שבועי / חודשי
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
  let h = `<div class="print-title">סיכום טיפולים ותשלומים – ${sumPeriodName()}${S.sumClient ? ' – ' + esc(S.sumClient) : ''}</div>
    <div class="sum-controls no-print">
      <select id="sumPeriod" style="flex:none;width:auto"><option value="month" ${sumWeekly() ? '' : 'selected'}>חודשי</option><option value="week" ${sumWeekly() ? 'selected' : ''}>שבועי</option></select>
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
  const fname = `סיכום ${sumPeriodName().replace(/\//g, '.')}${S.sumClient ? ' - ' + S.sumClient : ''}.csv`;
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
  const sp = $('#sumPeriod'); if (sp) sp.onchange = () => { store.set('sumPeriod', sp.value); if (sp.value === 'week' && S.anchor.getMonth() !== today().getMonth()) S.anchor = new Date(S.anchor.getFullYear(), S.anchor.getMonth(), 1); S.loaded = false; renderView(); loadEvents(); };
  const sf = $('#sumFilter'); if (sf) sf.onchange = () => { S.sumFilter = sf.value; renderView(); };
  const cb = $('#csvBtn'); if (cb) cb.onclick = exportCsv;
  const mb = $('#morningBtn'); if (mb) mb.onclick = () => showMorningIssue({ client: S.sumClient || null, extra: S.events });
  const pb = $('#pdfBtn'); if (pb) pb.onclick = () => window.print();
}
// ימים שמוצגים ביומן (0 = ראשון … 6 = שבת), ברירת מחדל: בלי שבת – זהה ל-Windows
const DEFAULT_WEEK_DAYS = [0, 1, 2, 3, 4, 5];
const weekDays = () => { const d = [...new Set((S.settings.week_days || DEFAULT_WEEK_DAYS).map(Number).filter(x => x >= 0 && x <= 6))].sort(); return d.length ? d : [0, 1, 2, 3, 4, 5, 6]; };
function showWeekDays() {
  const cur = weekDays();
  const sh = openSheet(`<h3 style="margin:4px 0 6px">ימים שמוצגים ביומן</h3><p class="note">אילו ימים להציג בתצוגת שבוע וחודש? (פגישות בימים מוסתרים לא נמחקות)</p>
    ${DAYS.map((d, i) => `<label class="check"><input type="checkbox" data-wd="${i}" ${cur.includes(i) ? 'checked' : ''}>${d}</label>`).join('')}
    <p class="err" id="wdErr"></p><div class="actions"><button class="btn primary" id="wdSave">שמירה</button><button class="btn" id="wdCancel">ביטול</button></div>`);
  $('#wdCancel', sh).onclick = closeSheet;
  $('#wdSave', sh).onclick = async () => {
    const days = [...sh.querySelectorAll('[data-wd]')].filter(c => c.checked).map(c => +c.dataset.wd);
    if (!days.length) { $('#wdErr', sh).textContent = 'צריך לבחור לפחות יום אחד.'; return; }
    closeSheet(); await saveSettings({ ...S.settings, week_days: days }); renderView();
  };
}
function goDay(d) { S.anchor = d; setView('day'); }
function setView(v) { S.view = v; store.set('view', v); S.loaded = false; renderView(); loadEvents(); }
function step(dir) {
  const a = S.anchor;
  if (S.view === 'day') { const wd = weekDays(); let d = a; for (let i = 0; i < 7; i++) { d = addDays(d, dir); if (wd.includes(d.getDay())) break; } S.anchor = d; }
  else if (S.view === 'week' || S.view === 'list' || sumWeekly()) S.anchor = addDays(a, 7 * dir);
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
function progressSheet(t, msg = '') {
  // חלון „עובד על זה…” – כדי שלא ייראה שלא קורה כלום בזמן שמחכים ל-Morning
  openSheet(`<div style="text-align:center;padding:18px 6px"><div class="spinner" style="margin:6px auto"></div><h3 style="margin:12px 0 6px">${esc(t)}</h3><p class="note" style="white-space:pre-line">${esc(msg || 'זה יכול לקחת עד חצי דקה. לא סוגרים את האפליקציה.')}</p></div>`);
}
async function fetchT(url, opts = {}, ms = 45000) {
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ac.signal }); }
  catch (e) { if (e.name === 'AbortError') { const x = new Error('timeout'); x.timeout = true; throw x; } throw e; }
  finally { clearTimeout(t); }
}
function alertSheet(t, msg, then = null) {
  const sh = openSheet(`<h3 style="margin:4px 0 8px">${esc(t)}</h3><p style="white-space:pre-line">${esc(msg)}</p><div class="actions"><button class="btn primary" id="okBtn">אישור</button></div>`);
  $('#okBtn', sh).onclick = () => (then ? then() : closeSheet());
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
const DEBT_RANGES = [['all', 'כל התקופה'], ['this_month', 'החודש'], ['last_month', 'החודש הקודם'], ['month', 'חודש מסוים'], ['3months', '3 החודשים האחרונים'], ['year', 'השנה'], ['custom', 'מתאריך עד תאריך']];
function debtRange(key, month = null, from = '', to = '') {
  // טווח תאריכים לסינון „מי חייב לי” (תאריכי ISO, כולל) – זהה ל-Windows
  const t = today(), first = new Date(t.getFullYear(), t.getMonth(), 1);
  if (key === 'this_month') return [isoDate(first), isoDate(t)];
  if (key === 'last_month') return [isoDate(new Date(t.getFullYear(), t.getMonth() - 1, 1)), isoDate(addDays(first, -1))];
  if (key === 'month' && month) { const m = parseDateOnly(month); return [isoDate(m), isoDate(addDays(new Date(m.getFullYear(), m.getMonth() + 1, 1), -1))]; }
  if (key === '3months') return [isoDate(new Date(t.getFullYear(), t.getMonth() - 2, 1)), isoDate(t)];
  if (key === 'year') return [isoDate(new Date(t.getFullYear(), 0, 1)), isoDate(t)];
  if (key === 'custom') return [from || null, to || null];
  return [null, null];
}
function computeDebts(evs, includeUnmarked = true, since = null, until = null) {
  const now = new Date(), groups = {};
  for (const e of uniqueSessions(evs)) {
    if (!canEdit(e) || paid(e) || attended(e) === 'no' || evTimes(e).s >= now) continue;
    const d = isoDate(evTimes(e).s);
    if ((since && d < since) || (until && d > until)) continue;
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
// הטלפון לוואטסאפ: של ההורה, ואם אין – של המטופל/ת (זהה ל-Windows)
const clientPhone = (name, st) => { const i = clientInfo(name, st); return (i.parent_phone || i.phone || '').trim(); };
const DEFAULT_RECEIPT_WA = 'שלום, מצורפת חשבונית מס/קבלה מס׳ {מספר_קבלה} עבור {תיאור} ({סכום}):\n{קישור}\nתודה!';
function receiptWaText(ss, name, number, url, item) {
  const total = ss.reduce((t, e) => t + (sessionAmount(e) || 0), 0);
  return (S.settings.receipt_wa || DEFAULT_RECEIPT_WA).split('{מספר_קבלה}').join(String(number || '')).split('{קישור}').join(url || '')
    .split('{תיאור}').join(name && !item.includes(name) ? `${item} של ${name}` : item).split('{סכום}').join(fmtMoney(total)).split('{שם_מטופל}').join(name || '').trim();
}
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
  if (!feat('quota')) return;
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
  if (!S.token || !S.calendars.length || store.get('daySummary', true) === false || !feat('quickmark')) return;
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
  const al = computeAlerts().length, mk = feat('makeups') ? uniqueSessions(allKnown()).filter(makeupDue).length : 0;
  const chips = [
    ['alerts', al, `<button class="qchip warn" id="qbAlerts">🔔 ${al}</button>`, showAlerts],
    ['quickmark', 1, `<button class="qchip ${n ? 'warn' : ''}" id="qbMark">✔ סימון${n ? ` (${n})` : ''}</button>`, () => showQuickMark()],
    ['assistant', 1, '<button class="qchip" id="qbAssist">🗣 עוזרת</button>', () => showAssistant()],
    ['clientfile', 1, '<button class="qchip" id="qbFile">📁 תיק מטופל</button>', showClientPicker],
    ['debts', 1, '<button class="qchip" id="qbDebts">💰 מי חייב לי</button>', () => showDebts()],
    ['makeups', mk, `<button class="qchip" id="qbMk">↺ השלמות (${mk})</button>`, showMakeups],
    ['waitlist', 1, `<button class="qchip" id="qbWait">⏳ המתנה${w ? ` (${w})` : ''}</button>`, showWaitlist],
    ['slots', 1, '<button class="qchip" id="qbSlot">🔎 שעה פנויה</button>', () => showSlotFinder({ onPick: sl => showNewMenu(sl[0]) })],
    ['cancelday', 1, '<button class="qchip" id="qbCday">🤒 יום ביטול</button>', () => showCancelDay()],
    ['morning', 1, '<button class="qchip" id="qbRcpt">🧾 קבלה</button>', () => showMorningIssue()],
    ['bulkreceipts', feat('morning') ? 1 : 0, '<button class="qchip" id="qbBulk">🧾 קבלות לחודש</button>', () => showBulkReceipts()],
  ].filter(c => feat(c[0]) && c[1]);
  bar.innerHTML = chips.map(c => c[2]).join('');
  bar.hidden = !chips.length;
  bar.querySelectorAll('button').forEach((b, i) => b.onclick = chips[i][3]);
}

// מי חייב לי + תזכורת תשלום
function showDebts(include = true, f = null) {
  f = f || store.get('debtFilter', { range: 'all', month: '', from: '', to: '' });
  const months = []; for (let i = 0; i < 24; i++) months.push(new Date(today().getFullYear(), today().getMonth() - i, 1));
  if (!f.month) f.month = isoDate(months[0]);
  if (!f.from) f.from = isoDate(months[0]);
  if (!f.to) f.to = isoDate(today());
  const [since, until] = debtRange(f.range, f.month, f.from, f.to);
  const data = computeDebts(allKnown(), include, since, until), tot = data.reduce((t, d) => t + d.total, 0);
  const period = since ? ` (${dmy(parseDateOnly(since))}–${dmy(parseDateOnly(until || isoDate(today())))})` : '';
  const sh = openSheet(`<h3 style="margin:4px 0 6px">מי חייב לי</h3>
    <div class="field"><label>תקופה</label><select id="dbRange">${DEBT_RANGES.map(([k, l]) => `<option value="${k}" ${k === f.range ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
    ${f.range === 'month' ? `<div class="field"><select id="dbMonth">${months.map(m => `<option value="${isoDate(m)}" ${isoDate(m) === f.month ? 'selected' : ''}>${MONTHS[m.getMonth()]} ${m.getFullYear()}</option>`).join('')}</select></div>` : ''}
    ${f.range === 'custom' ? `<div class="two"><div class="field"><label>מתאריך</label><input type="date" id="dbFrom" value="${f.from}"></div><div class="field"><label>עד</label><input type="date" id="dbTo" value="${f.to}"></div></div>` : ''}
    <label class="check"><input type="checkbox" id="dbInc" ${include ? 'checked' : ''}>כולל טיפולים שעברו ועוד לא סומן אם התקיימו</label>
    ${data.length ? data.map((d, i) => `<div class="card" style="margin:8px 0;padding:10px">
      <div style="display:flex;gap:8px;align-items:center"><b style="flex:1">${esc(d.name)}</b><b>${d.total ? fmtMoney(d.total) : '—'}</b></div>
      <div class="note">${d.sessions.length} טיפולים${d.unmarked ? ` · מהם ${d.unmarked} לא סומנו` : ''}: ${d.sessions.map(e => dmy(evTimes(e).s).slice(0, 5)).join(', ')}</div>
      <button class="btn" data-rem="${i}" style="margin-top:6px">📨 תזכורת תשלום</button></div>`).join('')
      : `<p>אין חובות פתוחים${period} 🎉</p>`}
    ${data.length ? `<p><b>סה"כ${period}: ${fmtMoney(tot)} · ${data.length} מטופלים</b></p><button class="btn primary" id="dbAll" style="width:100%">📨 תזכורת לכולם</button>` : ''}
    <p class="note">החישוב לפי השנתיים האחרונות. טיפול שלא התקיים לא נחשב חוב.</p>
    <div class="actions"><button class="btn" id="dbClose">סגירה</button></div>`);
  const again = ch => { const nf = { ...f, ...ch }; store.set('debtFilter', nf); showDebts($('#dbInc', sh).checked, nf); };
  $('#dbRange', sh).onchange = e => again({ range: e.target.value });
  if ($('#dbMonth', sh)) $('#dbMonth', sh).onchange = e => again({ month: e.target.value });
  if ($('#dbFrom', sh)) $('#dbFrom', sh).onchange = e => again({ from: e.target.value });
  if ($('#dbTo', sh)) $('#dbTo', sh).onchange = e => again({ to: e.target.value });
  $('#dbInc', sh).onchange = e => showDebts(e.target.checked, f);
  sh.querySelectorAll('[data-rem]').forEach(b => b.onclick = () => showPayReminder(data[+b.dataset.rem], include));
  if ($('#dbAll', sh)) $('#dbAll', sh).onclick = () => {
    const tpl = S.settings.pay_reminder || DEFAULT_PAY_REMINDER;
    showNotify(data.map(d => [d.sessions[0], renderReceiptText(tpl, d.sessions, d.name)]),
      `תזכורת תשלום ל-${data.length} מטופלים – לכל אחד הסכום והתאריכים שלו בתקופה שנבחרה (לחיצה על שם מציגה את ההודעה):`, 'תזכורת תשלום', () => showDebts(include, f));
  };
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
      ${(w.days || []).length || w.from ? `<div class="note">🕒 ${(w.days || []).map(i => DAY_LETTERS[i]).join(' ')} ${esc(w.from || '')}${w.to ? '–' + esc(w.to) : ''}</div>` : ''}
      ${w.note ? `<div class="note" style="white-space:pre-wrap">${esc(w.note)}</div>` : ''}
      <div class="seg" style="margin-top:6px"><button class="btn primary" data-ws="${i}">📅 קביעת טיפולים</button><button class="btn" data-we="${i}">עריכה</button><button class="btn danger" data-wd="${i}">הסרה</button></div></div>`).join('')
      : '<p class="note">הרשימה ריקה.</p>'}
    <div class="actions"><button class="btn primary" id="wlAdd">+ הוספה</button>${feat('intake') ? '<button class="btn" id="wlForm">📝 טופס קליטה</button>' : ''}<button class="btn" id="wlClose">סגירה</button></div>`);
  if ($('#wlForm', sh)) $('#wlForm', sh).onclick = showIntake;
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
  sh.querySelectorAll('[data-ws]').forEach(b => b.onclick = () => {
    const w = items[+b.dataset.ws];
    if (!feat('slots')) { showForm({ purpose: 'client', wait: w }); return; }
    showSlotFinder({ heading: `שעה ל${w.name}`, days: (w.days || []).length ? w.days : null, from: w.from || null, to: w.to || null,
      note: `זמינות: ${(w.days || []).map(i => DAY_LETTERS[i]).join(' ') || 'לא צוינה'} ${w.from || ''}${w.to ? '–' + w.to : ''}${w.location ? ' · ' + w.location : ''}`,
      onPick: sl => showForm({ purpose: 'client', wait: w, start: sl[0] }), onBack: showWaitlist });
  });
}
function showWaitItem(w, saveList) {
  const x = w || {};
  const sh = openSheet(`<h3 style="margin:4px 0 6px">${w ? 'עריכה' : 'ממתין/ה חדש/ה'}</h3>
    <div class="field"><label>שם</label><input type="text" id="wiName" value="${esc(x.name || '')}"></div>
    <div class="field"><label>טלפון</label><input type="tel" dir="ltr" id="wiPhone" value="${esc(x.phone || '')}"></div>
    <div class="field"><label>מייל</label><input type="email" dir="ltr" id="wiEmail" value="${esc(x.email || '')}"></div>
    <div class="field"><label>מיקום</label><input type="text" id="wiLoc" list="locList" placeholder="בוחרים מהרשימה או כותבים מקום אחר" value="${esc(x.location || '')}">${locList()}</div>
    <div class="field"><label>זמינות</label><div class="seg" style="margin:0">${DAY_LETTERS.slice(0, 6).map((l, i) => `<label class="check" style="margin:0"><input type="checkbox" data-wd2="${i}" ${(x.days || []).includes(i) ? 'checked' : ''}>${l}</label>`).join('')}</div>
      <div class="two" style="margin-top:6px"><input type="time" id="wiFrom" value="${esc(x.from || '')}"><input type="time" id="wiTo" value="${esc(x.to || '')}"></div></div>
    <div class="field"><label>הערות</label><textarea id="wiNote" rows="3" style="width:100%;box-sizing:border-box" placeholder="גיל, סיבת הפנייה, ימים ושעות שמתאימים…">${esc(x.note || '')}</textarea></div>
    <p class="err" id="wiErr"></p>
    <div class="actions"><button class="btn primary" id="wiSave">שמירה</button><button class="btn" id="wiBack">חזרה</button></div>`);
  $('#wiBack', sh).onclick = showWaitlist;
  $('#wiSave', sh).onclick = async () => {
    const name = $('#wiName', sh).value.trim(), email = $('#wiEmail', sh).value.trim();
    if (!name) { $('#wiErr', sh).textContent = 'צריך שם.'; return; }
    if (email && parseEmails(email)[1].length) { $('#wiErr', sh).textContent = 'המייל לא תקין.'; return; }
    const item = { ...x, name, phone: $('#wiPhone', sh).value.trim(), email, location: $('#wiLoc', sh).value.trim(), note: $('#wiNote', sh).value.trim(),
      days: [...sh.querySelectorAll('[data-wd2]')].filter(c => c.checked).map(c => +c.dataset.wd2), from: $('#wiFrom', sh).value, to: $('#wiTo', sh).value };
    item.id = item.id || 'w' + Date.now(); item.added = item.added || isoDate(today());
    const list = (S.settings.waitlist || []).filter(y => y.id !== item.id).concat([item]);
    const st = { ...S.settings, waitlist: list, locations: [...(S.settings.locations || [])] };
    addLocation(st, item.location);
    await saveSettings(st); renderQuickBar(); showWaitlist();
  };
}

// ---- תכונות (הפעלה / כיבוי) – זהה ל-Windows
const FEATURES = [
  ['clientfile', '📁 תיק מטופל', 'כל הטיפולים, התשלומים וההערות של מטופל/ת במסך אחד'],
  ['notes', '📝 מה היה בטיפול', 'הערה פרטית לכל טיפול'],
  ['voice', '🎤 הקלטה ותמלול', 'הכתבת ההערה בקול (Gemini מתמלל)'],
  ['summary', '📄 סיכום טיפול (AI)', 'טיוטת סיכום / דו״ח התקדמות מההערות'],
  ['docs', '📎 מסמכים למטופל', 'הפניות, התחייבויות ואבחונים, עם תאריך תפוגה'],
  ['quota', '🔢 מכסת מפגשים', 'כמה מפגשים אושרו וכמה נשארו'],
  ['quickmark', '✔ סימון מהיר', 'סימון הטיפולים שעברו, וחלון בסוף היום'],
  ['debts', '💰 מי חייב לי', 'חובות ותזכורות תשלום'],
  ['photo', '📷 מסמך מצילום', 'קריאת אישורי תשלום והוצאות מצילום (Gemini)'],
  ['inbox', '📥 תיבת קלט', 'מסמכים מתיקייה ב-Google Drive'],
  ['morning', '🧾 קבלות ב-Morning', 'הפקת חשבוניות מס/קבלה'],
  ['expenses', '📤 הוצאות ל-Morning', 'העלאת קבלות על הוצאות'],
  ['reminders', '⏰ תזכורות למטופלים', 'מייל אוטומטי יום לפני הטיפול'],
  ['waitlist', '⏳ רשימת המתנה', 'מי מחכה לתור'],
  ['slots', '🔎 חיפוש שעה פנויה', 'הצעת שעות פנויות ביומן'],
  ['cancelday', '🤒 יום ביטול', 'ביטול כל הטיפולים של יום והודעה להורים'],
  ['makeups', '↺ פגישות השלמה', 'מעקב אחרי טיפולים שצריך להשלים'],
  ['alerts', '🔔 התראות', 'חגים שנופלים על טיפולים, מסמכים שתוקפם נגמר, מכסות'],
  ['ai', '🤖 שאלה ל-AI', 'שאלות על היסטוריית הטיפולים'],
  ['usage', '💳 שימוש ב-Gemini', 'הערכת העלות החודשית ותקציב'],
];
const feat = k => ((S.settings.features || {})[k]) !== false;
function showFeatures() {
  const cur = S.settings.features || {};
  const sh = openSheet(`<h3 style="margin:4px 0 6px">תכונות</h3>
    <p class="note">מסמנים אילו תכונות להציג. תכונה כבויה נעלמת מהמסכים, אבל המידע שלה לא נמחק. הבחירה זהה בטלפון ובמחשב.</p>
    ${FEATURES.map(([k, l, d]) => `<label class="check"><input type="checkbox" data-f="${k}" ${cur[k] !== false ? 'checked' : ''}><span>${l} <span class="note">– ${d}</span></span></label>`).join('')}
    <div class="actions"><button class="btn primary" id="ftSave">שמירה</button><button class="btn" id="ftCancel">ביטול</button></div>`);
  $('#ftCancel', sh).onclick = closeSheet;
  $('#ftSave', sh).onclick = async () => {
    const f = {}; sh.querySelectorAll('[data-f]').forEach(c => { if (!c.checked) f[c.dataset.f] = false; });
    closeSheet(); await saveSettings({ ...S.settings, features: f }); applyFeatures();
  };
}
function applyFeatures() {
  const show = (id, on) => { const el = $(id); if (el) el.style.display = on ? '' : 'none'; };
  const ready = S.token && S.calendars.length;
  show('#aiBtn', feat('ai')); show('#receiptBtn', feat('photo')); show('#inboxBtn', feat('inbox'));
  if (ready) renderQuickBar();
}

// ---- שימוש ב-Gemini (הערכה לפי המחירון של Google) – זהה ל-Windows
const GEMINI_PRICES = { lite: [0.10, 0.30, 0.40], flash: [0.30, 1.00, 2.50] }, USD_ILS = 3.7;
let usagePending = [], usageTimer = null;
function geminiCost(model, um) {
  const p = GEMINI_PRICES[(model || '').includes('lite') ? 'lite' : 'flash'];
  const prompt = +um.promptTokenCount || 0, out = (+um.candidatesTokenCount || 0) + (+um.thoughtsTokenCount || 0);
  const audio = (um.promptTokensDetails || []).filter(d => d.modality === 'AUDIO').reduce((t, d) => t + (+d.tokenCount || 0), 0);
  return ((prompt - audio) * p[0] + audio * p[1] + out * p[2]) / 1e6 * USD_ILS;
}
function recordUsage(model, j) {
  if (!j || !j.usageMetadata) return;
  usagePending.push(geminiCost(model, j.usageMetadata));
  clearTimeout(usageTimer); usageTimer = setTimeout(flushUsage, 4000);
}
const monthKey = () => isoDate(today()).slice(0, 7);
const usageMonth = (k = monthKey()) => ((S.settings.ai_usage || {})[k]) || { ils: 0, calls: 0 };
async function flushUsage() {
  if (!usagePending.length || !S.token) return;
  const n = usagePending.length, total = usagePending.reduce((a, b) => a + b, 0); usagePending = [];
  const st = JSON.parse(JSON.stringify(S.settings)), usage = st.ai_usage = st.ai_usage || {}, k = monthKey();
  const cur = usage[k] = usage[k] || { ils: 0, calls: 0 }, before = cur.ils || 0;
  cur.ils = Math.round((before + total) * 1e4) / 1e4; cur.calls = (cur.calls || 0) + n;
  for (const old of Object.keys(usage).sort().slice(0, -12)) delete usage[old];
  const budget = toAmount(st.ai_budget) || 0;
  let warn = '';
  if (budget && feat('usage')) for (const [frac, flag] of [[1, 'w100'], [0.8, 'w80']]) {
    if (before < budget * frac && cur.ils >= budget * frac && !cur[flag]) {
      cur[flag] = true;
      warn = frac === 1 ? `השימוש ב-Gemini החודש עבר את התקציב (${fmtMoney(budget)}).` : `השימוש ב-Gemini החודש הגיע ל-80% מהתקציב (כ-${fmtMoney(cur.ils)} מתוך ${fmtMoney(budget)}).`;
      break;
    }
  }
  S.settings = { ...DEFAULT_SETTINGS, ...st }; store.set('settings', S.settings);
  try { await AppData.saveSettings(S.settings); } catch { /* ignore */ }
  if (warn) toast(warn);
}
function showUsage() {
  const cur = usageMonth(), budget = toAmount(S.settings.ai_budget) || 0, left = budget - cur.ils;
  const hist = Object.entries(S.settings.ai_usage || {}).sort().reverse().slice(0, 6);
  const sh = openSheet(`<h3 style="margin:4px 0 6px">שימוש ב-Gemini</h3>
    <p><b>החודש: כ-${fmtMoney(cur.ils) || '₪0'}</b> · ${cur.calls} פעולות</p>
    ${budget ? `<p style="${left < budget * 0.2 ? 'color:#B54708;font-weight:600' : ''}">תקציב ${fmtMoney(budget)} · נשאר כ-${fmtMoney(Math.max(left, 0)) || '₪0'}${left < 0 ? ' · ⚠ עברת את התקציב' : ''}</p>` : ''}
    ${hist.length ? `<p class="note">חודשים אחרונים: ${hist.map(([k, v]) => `${k.slice(5)}/${k.slice(2, 4)}: ${fmtMoney(v.ils) || '₪0'}`).join(' · ')}</p>` : ''}
    <div class="field"><label>תקציב חודשי (₪)</label><input type="text" inputmode="decimal" dir="ltr" id="usBudget" placeholder="למשל 20 (ריק = בלי תקציב)" value="${budget || ''}"></div>
    <p class="note">זו הערכה לפי כמות הטקסט, התמונות וההקלטות שנשלחו, ולפי המחירון של Google (בשקלים, לפי דולר ≈ ₪3.7). Google לא מאפשרים לאפליקציה לקרוא את יתרת החיוב עצמה.</p>
    <p class="note"><a href="https://aistudio.google.com/usage" target="_blank" rel="noopener">השימוש ב-AI Studio</a> · <a href="https://console.cloud.google.com/billing" target="_blank" rel="noopener">החיוב ב-Google Cloud</a></p>
    <p class="err" id="usErr"></p>
    <div class="actions"><button class="btn primary" id="usSave">שמירה</button><button class="btn" id="usClose">סגירה</button></div>`);
  $('#usClose', sh).onclick = closeSheet;
  $('#usSave', sh).onclick = async () => {
    const t = $('#usBudget', sh).value.trim();
    if (t && !toAmount(t)) { $('#usErr', sh).textContent = 'התקציב צריך להיות מספר.'; return; }
    closeSheet(); await saveSettings({ ...S.settings, ai_budget: toAmount(t) || 0 });
  };
}

// ---- תיק מטופל וסיכום טיפול
function statusText(ev) {
  const a = attended(ev);
  if (a === 'yes') return 'התקיימה';
  if (a === 'no') return 'בוטלה' + (cancelLabel(ev) ? ` (${cancelLabel(ev)})` : '');
  return evTimes(ev).s > new Date() ? 'עתידית' : 'טרם סומן';
}
const clientSessions = name => uniqueSessions(allKnown()).filter(e => title(e).trim() === (name || '').trim()).sort((a, b) => evTimes(a).s - evTimes(b).s);
const makeupDue = ev => attended(ev) === 'no' && props(ev).makeup === 'due';
const MAKEUP_REASONS = ['sick', 'me', 'holiday'];
function showClientPicker() {
  const names = clientNames();
  const sh = openSheet(`<h3 style="margin:4px 0 6px">תיק מטופל</h3>
    <div class="field"><input type="search" id="cpSearch" placeholder="חיפוש…"></div>
    <div id="cpList">${names.map(n => `<button class="btn" data-cp="${esc(n)}" style="width:100%;margin:3px 0;text-align:start">${esc(n)}</button>`).join('')}</div>
    <div class="actions"><button class="btn" id="cpClose">סגירה</button></div>`);
  $('#cpSearch', sh).oninput = e => sh.querySelectorAll('[data-cp]').forEach(b => { b.style.display = b.dataset.cp.includes(e.target.value.trim()) ? '' : 'none'; });
  sh.querySelectorAll('[data-cp]').forEach(b => b.onclick = () => showClientFile(b.dataset.cp));
  $('#cpClose', sh).onclick = closeSheet;
}
function showClientFile(name) {
  const ss = clientSessions(name), info = clientInfo(name), now = new Date();
  const held = ss.filter(e => attended(e) === 'yes').length, canc = ss.filter(e => attended(e) === 'no').length;
  const fut = ss.filter(e => evTimes(e).s > now && attended(e) !== 'no').length;
  const debt = computeDebts(ss).find(d => d.name === name), due = ss.filter(makeupDue);
  const loc = (ss.slice().reverse().find(e => e.location) || {}).location;
  const facts = [`התקיימו ${held} · בוטלו ${canc} · עתידיים ${fut}`];
  if (clientPrice(name)) facts.push('מחיר: ' + fmtMoney(clientPrice(name)));
  if (info.parent_phone) facts.push('טלפון הורה: ' + ltr(esc(info.parent_phone)));
  if (info.phone) facts.push('טלפון: ' + ltr(esc(info.phone)));
  if ((info.emails || []).length) facts.push('מייל: ' + esc(info.emails.join(', ')));
  if ((info.payers || []).length) facts.push('משלמים: ' + esc(info.payers.join(', ')));
  if (loc) facts.push('מיקום: ' + esc(loc));
  if (feat('quota') && quotaStatus(name)) facts.push('מכסה: ' + esc(quotaText(quotaStatus(name))));
  if (feat('debts') && debt) facts.push(`לא שולמו: ${debt.sessions.length} טיפולים${debt.total ? ' · ' + fmtMoney(debt.total) : ''}`);
  if (feat('makeups') && due.length) facts.push(`השלמות פתוחות: ${due.length}`);
  const row = e => { const t = evTimes(e), n = sessionNo(e), p = props(e);
    return `<div class="card" data-open="${esc(e.id)}" style="margin:6px 0;padding:8px 10px">
      <div style="display:flex;gap:8px"><b style="flex:1">${dmy(t.s)} · ${ltr(hm(t.s))}${n ? ` · מפגש ${n}` : ''}</b><span class="note">${esc(statusText(e))}</span></div>
      <div class="note">${paid(e) ? '₪ ' + esc(payLabel(e) || 'שולמה') : attended(e) === 'yes' ? 'לא שולמה' : ''}${receiptIssued(e) ? ' · קבלה ' + esc(p.rcpt_no || '✓') : ''}${makeupDue(e) ? ' · ↺ השלמה' : ''}${p.makeup_for ? ' · פגישת השלמה' : ''}</div>
      ${feat('notes') && evNote(e) ? `<div style="white-space:pre-wrap;margin-top:4px">${esc(evNote(e))}</div>` : ''}
      ${feat('exercises') && p.homework ? `<div class="note">📚 ${esc(p.homework)}</div>` : ''}</div>`; };
  const sh = openSheet(`<h3 style="margin:4px 0 6px">📁 ${esc(name)}</h3>
    <p style="line-height:1.6">${facts.join('<br>')}</p>
    <div class="seg"><button class="btn" id="cfPhone">📞 טלפון הורה</button>${feat('morning') ? '<button class="btn" id="cfRcpt">🧾 קבלה ב-Morning</button>' : ''}${feat('summary') ? '<button class="btn" id="cfSum">📄 סיכום טיפול (AI)</button>' : ''}${feat('docs') ? '<button class="btn" id="cfDocs">📎 מסמכים</button>' : ''}
      ${feat('debts') && debt ? '<button class="btn" id="cfRem">📨 תזכורת תשלום</button>' : ''}${feat('makeups') && due.length ? '<button class="btn" id="cfMk">↺ קביעת השלמה</button>' : ''}${feat('export') ? '<button class="btn" id="cfPdf">🖨 ייצוא ל-PDF</button>' : ''}</div>
    ${(() => { const up = ss.filter(e => evTimes(e).s > now && attended(e) !== 'no').slice(0, 3);
      return up.length ? `<div class="sec">הטיפולים הקרובים</div>${up.map(row).join('')}` : ''; })()}
    <div class="sec">טיפולים שהיו (מהחדש לישן)</div>${ss.filter(e => evTimes(e).s <= now || attended(e) === 'no').reverse().map(row).join('') || '<p class="note">אין עדיין.</p>'}
    <div class="actions"><button class="btn" id="cfClose">סגירה</button></div>`);
  sh.querySelectorAll('[data-open]').forEach(c => c.onclick = () => { const e = allKnown().find(x => x.id === c.dataset.open); if (e) showDetails(e); });
  const on = (id, fn) => { const b = $(id, sh); if (b) b.onclick = fn; };
  on('#cfSum', () => showSummary(name));
  on('#cfRcpt', () => showMorningIssue({ client: name, onBack: () => showClientFile(name) }));
  on('#cfPhone', async () => { const t = prompt(`טלפון ההורה של ${name} (לקבלות ולתזכורות בוואטסאפ):`, clientPhone(name)); if (t !== null) { await saveClientPhone(name, t); showClientFile(name); } }); on('#cfDocs', () => showClientDocs(name));
  on('#cfRem', () => showPayReminder(debt, true)); on('#cfPdf', () => exportClient(name)); on('#cfMk', () => scheduleMakeup(due[0]));
  $('#cfClose', sh).onclick = closeSheet;
}
const SUMMARY_AUDIENCES = [['kupa', 'קופת חולים / גורם מממן', 'דו״ח התקדמות לקופת חולים'], ['school', 'בית ספר / גן', 'סיכום טיפול לצוות החינוכי'],
  ['parents', 'הורים', 'סיכום טיפול להורים, בשפה פשוטה וחמה'], ['general', 'כללי', 'סיכום טיפול מקצועי']];
const SUMMARY_SYSTEM = `את/ה עוזר/ת לקלינאית תקשורת לכתוב {doc}.
כתוב/י בעברית, בגוף ראשון של הקלינאית, בשפה מקצועית{tone}.
הסתמך/י רק על המידע שקיבלת (רשימת המפגשים וההערות). אל תמציא/י אבחנות, ציונים או פרטים שלא נכתבו.
במקום שבו חסר מידע חשוב, השאר/י סוגריים מרובעים עם הסבר, למשל [גיל המטופל/ת].
מבנה: פרטים (שם, תקופת הטיפול, מספר המפגשים שהתקיימו ושבוטלו), מטרות הטיפול (רק אם עולות מההערות),
מהלך הטיפול, התקדמות, והמלצות להמשך. בלי כותרת „טיוטה”, בלי הקדמה ובלי סיכום של מה שעשית.`;
function summaryPrompt(name, ss, aud, extra) {
  const doc = (SUMMARY_AUDIENCES.find(a => a[0] === aud) || [])[2] || 'סיכום טיפול';
  const tone = aud === 'parents' ? ', פשוטה וחמה, בלי מונחים מקצועיים לא מוסברים' : '';
  const lines = [`שם: ${name}`, `מפגשים שהתקיימו: ${ss.filter(e => attended(e) === 'yes').length}, בוטלו: ${ss.filter(e => attended(e) === 'no').length}`];
  for (const e of ss) { const n = sessionNo(e); lines.push(`${dmy(evTimes(e).s)} | ${n ? 'מפגש ' + n : 'מפגש'} | ${statusText(e)}${evNote(e) ? ' | ' + evNote(e) : ''}`); }
  if (extra) lines.push(`הנחיות נוספות מהקלינאית: ${extra}`);
  return [SUMMARY_SYSTEM.replace('{doc}', doc).replace('{tone}', tone), lines.join('\n')];
}
function showSummary(name) {
  const info = clientInfo(name);
  const from = info.quota_from || isoDate(addDays(today(), -90));
  const sh = openSheet(`<h3 style="margin:4px 0 6px">סיכום טיפול – ${esc(name)}</h3>
    <div class="two"><div class="field"><label>מתאריך</label><input type="date" id="smFrom" value="${from}"></div>
      <div class="field"><label>עד תאריך</label><input type="date" id="smTo" value="${isoDate(today())}"></div></div>
    <div class="field"><label>בשביל</label><select id="smAud">${SUMMARY_AUDIENCES.map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></div>
    <div class="field"><label>הנחיות (לא חובה)</label><input type="text" id="smExtra" placeholder="למשל „להדגיש את ההתקדמות בשטף”"></div>
    <button class="btn primary" id="smGen" style="width:100%">✨ יצירת טיוטה</button>
    <p class="note" id="smInfo"></p>
    <textarea id="smText" rows="12" style="width:100%;box-sizing:border-box" placeholder="כאן תופיע הטיוטה. אפשר לערוך אותה לפני ההעתקה או השמירה."></textarea>
    <div class="actions"><button class="btn" id="smCopy">העתקה</button><button class="btn" id="smSave">💾 שמירה כ-Google Doc</button></div>
    <p class="note">ההערות נשלחות ל-Gemini ליצירת הטיוטה. חשוב לקרוא ולתקן לפני ששולחים לגורם חיצוני.</p>
    <div class="actions"><button class="btn" id="smBack">חזרה לתיק</button></div>`);
  const info2 = $('#smInfo', sh);
  $('#smGen', sh).onclick = async () => {
    const a = $('#smFrom', sh).value, b = $('#smTo', sh).value;
    const ss = clientSessions(name).filter(e => { const d = isoDate(evTimes(e).s); return d >= a && d <= b; });
    if (!ss.length) { info2.textContent = 'אין טיפולים בתקופה הזו.'; return; }
    if (!DEMO && !store.get('geminiKey', '')) { askGeminiKey(() => showSummary(name)); return; }
    const withNotes = ss.filter(evNote).length;
    info2.textContent = `${ss.length} טיפולים בתקופה, ל-${withNotes} מהם יש הערה. Gemini כותב…`;
    const [sys, data] = summaryPrompt(name, ss, $('#smAud', sh).value, $('#smExtra', sh).value.trim());
    try {
      busy(true);
      const text = DEMO ? `סיכום טיפול – ${name}\n\n${data}` : await geminiChat(sys, [{ role: 'user', parts: [{ text: data }] }]);
      $('#smText', sh).value = text.trim();
      info2.textContent = `✓ הטיוטה מוכנה (${ss.length} טיפולים, ${withNotes} עם הערה). כדאי לקרוא ולתקן.` + (withNotes ? '' : ' שימי לב: אין הערות, ולכן הסיכום כללי מאוד.');
    } catch (e) { info2.textContent = ''; handleErr(e); } finally { busy(false); }
  };
  $('#smCopy', sh).onclick = async () => { try { await navigator.clipboard.writeText($('#smText', sh).value); toast('✓ הועתק'); } catch { toast('לא הצלחתי להעתיק'); } };
  $('#smSave', sh).onclick = async () => {
    const text = $('#smText', sh).value.trim(); if (!text) return;
    try { busy(true); const f = await ClientDocs.createTextDoc(name, `סיכום טיפול – ${name} – ${dmy(today()).replace(/\//g, '.')}`, text); toast('✓ נשמר ב-Google Drive'); if (f.webViewLink && f.webViewLink !== '#') window.open(f.webViewLink, '_blank'); }
    catch (e) { handleErr(e); } finally { busy(false); }
  };
  $('#smBack', sh).onclick = () => showClientFile(name);
}

// ---- מסמכים למטופל: יומן הטיפולים / מטופלים / <שם> (זהה ל-Windows)
const DOC_TYPES = [['referral', 'הפניה'], ['approval', 'התחייבות / אישור טיפולים'], ['assessment', 'אבחון'], ['report', 'סיכום / דו״ח'], ['other', 'אחר']];
const docTypeLabel = k => (DOC_TYPES.find(d => d[0] === k) || [0, 'אחר'])[1];
const ClientDocs = {
  async folder(name) {
    const root = await AppData.folder('מטופלים', await AppData.app(), 'clientsFolder');
    const safe = (name || '').replace(/\//g, '-').replace(/'/g, '׳').trim() || 'ללא שם';
    return AppData.folder(safe, root, 'clientFolder:' + safe);
  },
  async list(name = null) {
    if (DEMO) return (Mock.docs || []).filter(f => !name || f.appProperties.client === name);
    let q = "appProperties has { key='tc' and value='client_doc' } and trashed = false";
    if (name) q += ` and appProperties has { key='client' and value='${name.trim().replace(/'/g, "\\'")}' }`;
    let out = [], token = '';
    do {
      const r = await gfetch('https://www.googleapis.com/drive/v3/files?' + qs({ q, spaces: 'drive', pageSize: 200, ...(token ? { pageToken: token } : {}), fields: 'nextPageToken,files(id,name,mimeType,webViewLink,createdTime,appProperties)' }));
      out = out.concat(r.files || []); token = r.nextPageToken || '';
    } while (token);
    return out;
  },
  async upload(name, file, docType, expiry) {
    const appProperties = { tc: 'client_doc', client: name.trim(), doc_type: docType, expiry: expiry || '' };
    if (DEMO) { const f = { id: 'doc' + Date.now(), name: file.name, webViewLink: '#', createdTime: new Date().toISOString(), appProperties }; (Mock.docs = Mock.docs || []).push(f); return f; }
    return multipartUpload({ name: file.name, parents: [await ClientDocs.folder(name)], appProperties }, file);
  },
  async setProps(id, appProperties) {
    if (DEMO) { const f = (Mock.docs || []).find(x => x.id === id); if (f) f.appProperties = appProperties; return; }
    return gfetch(`https://www.googleapis.com/drive/v3/files/${enc(id)}?fields=id`, { method: 'PATCH', json: { appProperties } });
  },
  async trash(id) {
    if (DEMO) { Mock.docs = (Mock.docs || []).filter(x => x.id !== id); return; }
    return gfetch(`https://www.googleapis.com/drive/v3/files/${enc(id)}?fields=id`, { method: 'PATCH', json: { trashed: true } });
  },
  async createTextDoc(name, docTitle, text) {
    const appProperties = { tc: 'client_doc', client: name.trim(), doc_type: 'report', expiry: '' };
    if (DEMO) { const f = { id: 'doc' + Date.now(), name: docTitle, webViewLink: '#', createdTime: new Date().toISOString(), appProperties }; (Mock.docs = Mock.docs || []).push(f); return f; }
    return multipartUpload({ name: docTitle, mimeType: 'application/vnd.google-apps.document', parents: [await ClientDocs.folder(name)], appProperties }, new Blob([text], { type: 'text/plain' }));
  },
};
let clientDocsCache = [];
async function showClientDocs(name) {
  const sh = openSheet(`<h3 style="margin:4px 0 6px">📎 מסמכים – ${esc(name)}</h3><div id="dcList"><div class="spinner"></div></div>
    <div class="sec">העלאת מסמך</div>
    <div class="field"><input type="file" id="dcFile" accept="image/*,application/pdf,.doc,.docx"></div>
    <div class="field"><label>סוג</label><select id="dcType">${DOC_TYPES.map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></div>
    <div class="field"><label>תוקף עד (לא חובה – תקבלי התראה חודש לפני)</label><input type="date" id="dcExp"></div>
    <div class="actions"><button class="btn primary" id="dcUp">⬆ העלאה</button><button class="btn" id="dcBack">חזרה לתיק</button></div>
    <p class="note">המסמכים נשמרים ב-Google Drive, בתיקייה „יומן הטיפולים ← מטופלים ← ${esc(name)}”.</p>`);
  $('#dcBack', sh).onclick = () => showClientFile(name);
  $('#dcType', sh).onchange = e => { if (e.target.value === 'approval' && !$('#dcExp', sh).value) $('#dcExp', sh).value = isoDate(addDays(today(), 180)); };
  $('#dcUp', sh).onclick = async () => {
    const f = $('#dcFile', sh).files[0]; if (!f) { toast('בוחרים קובץ'); return; }
    try { busy(true); await ClientDocs.upload(name, f, $('#dcType', sh).value, $('#dcExp', sh).value); toast('✓ המסמך הועלה'); refreshAlerts(); showClientDocs(name); }
    catch (e) { handleErr(e); } finally { busy(false); }
  };
  let docs = [];
  try { docs = (await ClientDocs.list(name)).sort((a, b) => (b.createdTime || '').localeCompare(a.createdTime || '')); }
  catch (e) { $('#dcList', sh).innerHTML = `<p class="err">${esc(e.message)}</p>`; return; }
  const soon = isoDate(addDays(today(), 30)), now = isoDate(today());
  $('#dcList', sh).innerHTML = docs.length ? docs.map((f, i) => { const ap = f.appProperties || {};
    return `<div class="card" style="margin:6px 0;padding:8px 10px"><b>${esc(f.name)}</b>
      <div class="note">${docTypeLabel(ap.doc_type)}${ap.expiry ? ` · תוקף עד ${dmy(parseDateOnly(ap.expiry))}${ap.expiry < now ? ' ⚠ פג' : ap.expiry <= soon ? ' ⚠ בקרוב' : ''}` : ''} · ${(f.createdTime || '').slice(0, 10)}</div>
      <div class="seg" style="margin:6px 0 0"><button class="btn" data-do="${i}">פתיחה</button><button class="btn" data-de="${i}">תוקף…</button><button class="btn danger" data-dd="${i}">מחיקה</button></div></div>`; }).join('')
    : '<p class="note">אין עדיין מסמכים.</p>';
  sh.querySelectorAll('[data-do]').forEach(b => b.onclick = () => { const f = docs[+b.dataset.do]; if (f.webViewLink && f.webViewLink !== '#') window.open(f.webViewLink, '_blank'); });
  sh.querySelectorAll('[data-de]').forEach(b => b.onclick = async () => {
    const f = docs[+b.dataset.de], ap = { ...(f.appProperties || {}) };
    const v = prompt('תוקף עד (YYYY-MM-DD), או ריק בלי תוקף:', ap.expiry || isoDate(addDays(today(), 180)));
    if (v === null) return;
    if (v.trim() && !/^\d{4}-\d{2}-\d{2}$/.test(v.trim())) { toast('תאריך בצורה 2026-12-31'); return; }
    ap.expiry = v.trim();
    try { busy(true); await ClientDocs.setProps(f.id, ap); refreshAlerts(); showClientDocs(name); } catch (e) { handleErr(e); } finally { busy(false); }
  });
  sh.querySelectorAll('[data-dd]').forEach(b => b.onclick = async () => {
    const f = docs[+b.dataset.dd];
    if (!await choose('מחיקה', `למחוק את „${f.name}”? (הוא יעבור לסל המחזור של Drive)`, [{ label: 'מחיקה', value: true, cls: 'danger' }])) { showClientDocs(name); return; }
    try { busy(true); await ClientDocs.trash(f.id); refreshAlerts(); } catch (e) { handleErr(e); } finally { busy(false); showClientDocs(name); }
  });
}

// ---- חיפוש שעה פנויה (זהה ל-Windows)
const DEFAULT_WORK = { days: [0, 1, 2, 3, 4], from: '08:00', to: '19:00', minutes: 45 };
const DAY_LETTERS = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'];
const holidayBlock = d => holidaysOn(d).some(([n, k]) => k === 'yomtov' || n.includes('עצמאות'));
function findFreeSlots(evs, days, from, to, minutes, weeks = 3, limit = 80) {
  const now = new Date(), out = [];
  const busyList = evs.filter(e => !evTimes(e).allDay && attended(e) !== 'no' && e.status !== 'cancelled').map(e => [evTimes(e).s, evTimes(e).e]).sort((a, b) => a[0] - b[0]);
  const [h1, m1] = from.split(':').map(Number), [h2, m2] = to.split(':').map(Number), len = minutes * 60000;
  const round = new Date(now); round.setSeconds(0, 0); round.setMinutes(Math.ceil(round.getMinutes() / 15) * 15);
  for (let i = 0; i < weeks * 7; i++) {
    const d = addDays(today(), i);
    if (!days.includes(d.getDay()) || holidayBlock(d)) continue;
    const ws = new Date(d); ws.setHours(h1, m1, 0, 0); const we = new Date(d); we.setHours(h2, m2, 0, 0);
    if (we <= now) continue;
    let cur = new Date(Math.max(ws, round));
    for (const [bs, be] of busyList.filter(b => b[1] > ws && b[0] < we).concat([[we, we]])) {
      const gapEnd = new Date(Math.min(bs, we));
      if (gapEnd - cur >= len) {
        let t = new Date(cur), n = 0;
        while (t.getTime() + len <= gapEnd.getTime() && n < 4) { out.push([new Date(t), new Date(t.getTime() + len), gapEnd]); t = new Date(t.getTime() + (minutes <= 30 ? 30 : minutes) * 60000); n++; }
      }
      if (be > cur) cur = new Date(be);
      if (out.length >= limit) return out;
    }
  }
  return out;
}
function showSlotFinder({ heading = 'חיפוש שעה פנויה', minutes = null, days = null, from = null, to = null, note = '', onPick, onBack = null }) {
  const w = { ...DEFAULT_WORK, ...(S.settings.work_hours || {}) };
  ensureHolidays([today(), addDays(today(), 60)]);
  const st = { days: days || w.days, from: from || w.from, to: to || w.to, minutes: +(minutes || w.minutes), weeks: 3 };
  const times = []; for (let h = 7; h < 23; h++) for (const m of [0, 30]) times.push(pad(h) + ':' + pad(m));
  const draw = () => {
    const slots = findFreeSlots(allKnown(), st.days, st.from, st.to, st.minutes, st.weeks);
    const sh = openSheet(`<h3 style="margin:4px 0 6px">${esc(heading)}</h3>${note ? `<p class="note">${esc(note)}</p>` : ''}
      <div class="seg">${DAY_LETTERS.slice(0, 6).map((l, i) => `<button class="btn ${st.days.includes(i) ? 'on' : ''}" data-sd="${i}" style="min-width:40px">${l}</button>`).join('')}</div>
      <div class="two"><div class="field"><label>משעה</label><select id="sfFrom">${times.map(t => `<option ${t === st.from ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
        <div class="field"><label>עד</label><select id="sfTo">${times.map(t => `<option ${t === st.to ? 'selected' : ''}>${t}</option>`).join('')}</select></div></div>
      <div class="two"><div class="field"><label>אורך</label><select id="sfLen">${[30, 40, 45, 50, 60, 90].map(m => `<option value="${m}" ${m === st.minutes ? 'selected' : ''}>${m} דק׳</option>`).join('')}</select></div>
        <div class="field"><label>טווח</label><select id="sfWeeks">${[1, 2, 3, 4, 6, 8].map(x => `<option value="${x}" ${x === st.weeks ? 'selected' : ''}>${x === 1 ? 'שבוע' : x + ' שבועות'}</option>`).join('')}</select></div></div>
      <label class="check"><input type="checkbox" id="sfSave">לשמור כשעות העבודה הקבועות שלי</label>
      <div class="sec">${slots.length ? slots.length + ' אפשרויות' : 'לא נמצאו שעות פנויות. אפשר להרחיב ימים, שעות או טווח.'}</div>
      ${slots.map(([s, e, g], i) => `<button class="btn" data-sl="${i}" style="width:100%;margin:3px 0;text-align:start">יום ${DAYS[s.getDay()]} ${dmy(s).slice(0, 5)} · ${ltr(hm(s) + '–' + hm(e))} <span class="note">(פנוי עד ${hm(g)})</span></button>`).join('')}
      <div class="actions"><button class="btn" id="sfBack">${onBack ? 'חזרה' : 'סגירה'}</button></div>`);
    sh.querySelectorAll('[data-sd]').forEach(b => b.onclick = () => { const i = +b.dataset.sd; st.days = st.days.includes(i) ? st.days.filter(x => x !== i) : st.days.concat([i]); draw(); });
    $('#sfFrom', sh).onchange = e => { st.from = e.target.value; draw(); };
    $('#sfTo', sh).onchange = e => { st.to = e.target.value; draw(); };
    $('#sfLen', sh).onchange = e => { st.minutes = +e.target.value; draw(); };
    $('#sfWeeks', sh).onchange = e => { st.weeks = +e.target.value; draw(); };
    $('#sfBack', sh).onclick = () => (onBack ? onBack() : closeSheet());
    sh.querySelectorAll('[data-sl]').forEach(b => b.onclick = async () => {
      if ($('#sfSave', sh).checked) await saveSettings({ ...S.settings, work_hours: { days: st.days, from: st.from, to: st.to, minutes: st.minutes } });
      onPick(slots[+b.dataset.sl]);
    });
  };
  draw();
}

// ---- פגישות השלמה
function showMakeups() {
  const due = uniqueSessions(allKnown()).filter(makeupDue).sort((a, b) => evTimes(a).s - evTimes(b).s);
  const sh = openSheet(`<h3 style="margin:4px 0 6px">↺ פגישות השלמה</h3><p class="note">טיפולים שבוטלו וצריך להשלים:</p>
    ${due.map((e, i) => `<div class="card" style="margin:6px 0;padding:8px 10px"><b>${esc(title(e))}</b> <span class="note">${dmy(evTimes(e).s)}${cancelLabel(e) ? ' · ' + esc(cancelLabel(e)) : ''}</span>
      <div class="seg" style="margin:6px 0 0"><button class="btn primary" data-mk="${i}">🔎 קביעת השלמה</button><button class="btn" data-mn="${i}">אין צורך</button></div></div>`).join('') || '<p>אין השלמות פתוחות. ✓</p>'}
    <div class="actions"><button class="btn" id="mkClose">סגירה</button></div>`);
  sh.querySelectorAll('[data-mk]').forEach(b => b.onclick = () => scheduleMakeup(due[+b.dataset.mk], showMakeups));
  sh.querySelectorAll('[data-mn]').forEach(b => b.onclick = async () => { await setStatus(due[+b.dataset.mn], { makeup: '' }); showMakeups(); });
  $('#mkClose', sh).onclick = closeSheet;
}
function scheduleMakeup(ev, onBack = null) {
  const t = evTimes(ev), minutes = Math.max(15, Math.round((t.e - t.s) / 60000)), name = title(ev).trim();
  const create = async start => {
    const end = new Date(start.getTime() + minutes * 60000), tz = currentTz();
    if (!await choose('פגישת השלמה', `לקבוע פגישת השלמה ל${name} ביום ${DAYS[start.getDay()]} ${dmy(start).slice(0, 5)} בשעה ${hm(start)}?`, [{ label: 'כן, לקבוע', value: true, cls: 'primary' }])) { if (onBack) onBack(); else closeSheet(); return; }
    const p = { makeup_for: ev.id }; if (props(ev).price) p.price = props(ev).price;
    const body = { summary: name, start: { dateTime: localStr(start), timeZone: tz }, end: { dateTime: localStr(end), timeZone: tz }, extendedProperties: { private: p } };
    if (ev.location) body.location = ev.location;
    if (ev.colorId && ev.colorId !== '8') body.colorId = ev.colorId;
    const emails = clientInvites(name) ? clientEmails(name) : [];
    if (emails.length) body.attendees = emails.map(email => ({ email }));
    try {
      busy(true);
      const created = await G.insert(ev._calendar_id, body, !!emails.length);
      await setStatus(ev, { makeup: 'done', makeup_ev: (created && created.id) || '' });
      closeSheet(); toast(`✓ נקבעה פגישת השלמה ל${name}`); changed();
    } catch (e) { handleErr(e); } finally { busy(false); }
  };
  if (feat('slots')) showSlotFinder({ heading: `השלמה ל${name}`, minutes, note: `פגישת השלמה לטיפול שבוטל ב-${dmy(t.s)}. בוחרים שעה פנויה:`, onPick: s => create(s[0]), onBack });
  else {
    const sh = openSheet(`<h3 style="margin:4px 0 6px">מועד פגישת ההשלמה – ${esc(name)}</h3>
      <div class="two"><div class="field"><label>תאריך</label><input type="date" id="mkD" value="${isoDate(addDays(today(), 1))}"></div>
      <div class="field"><label>שעה</label>${timeInput('mkT', t.s)}</div></div>
      <div class="actions"><button class="btn primary" id="mkOk">המשך</button><button class="btn" id="mkNo">ביטול</button></div>`);
    $('#mkNo', sh).onclick = () => (onBack ? onBack() : closeSheet());
    $('#mkOk', sh).onclick = () => create(fromInputs($('#mkD', sh).value, $('#mkT', sh).value));
  }
}

// ---- יום ביטול
const DEFAULT_CANCEL_MSG = 'שלום, לצערי הטיפול של {שם_מטופל} ב{יום} {תאריך} בשעה {שעה} מבוטל. אחזור אליכם לתיאום מועד השלמה. סליחה על אי הנוחות!';
const renderCancelMsg = (tpl, ev) => { const s = evTimes(ev).s; return tpl.split('{שם_מטופל}').join(title(ev).trim()).split('{יום}').join('יום ' + DAYS[s.getDay()]).split('{תאריך}').join(dmy(s).slice(0, 5)).split('{שעה}').join(hm(s)); };
function showCancelDay(day = today()) {
  const items = uniqueSessions(allKnown()).filter(e => canEdit(e) && sameDay(evTimes(e).s, day) && attended(e) !== 'no').sort((a, b) => evTimes(a).s - evTimes(b).s);
  const sh = openSheet(`<h3 style="margin:4px 0 6px">🤒 יום ביטול</h3>
    <div class="field"><label>היום שמתבטל</label><input type="date" id="cdDay" value="${isoDate(day)}"></div>
    <div class="field"><label>סיבה</label><select id="cdReason">${['sick', 'me', 'holiday', 'other'].map(k => `<option value="${k}">${CANCEL_REASONS.find(r => r[0] === k)[1]}</option>`).join('')}</select>
      <input type="text" id="cdNote" placeholder="פירוט (לא חובה)" style="margin-top:6px"></div>
    <div class="sec">הטיפולים שיבוטלו</div>
    ${items.map((e, i) => `<label class="check"><input type="checkbox" data-cd="${i}" checked>${ltr(hm(evTimes(e).s))} ${esc(title(e))}</label>`).join('') || '<p class="note">אין טיפולים ביום הזה.</p>'}
    ${feat('makeups') ? '<label class="check"><input type="checkbox" id="cdMk" checked>לסמן שצריך פגישת השלמה</label>' : ''}
    <div class="field"><label>ההודעה להורים (אפשר לערוך)</label><textarea id="cdMsg" rows="4" style="width:100%;box-sizing:border-box">${esc(S.settings.cancel_message || DEFAULT_CANCEL_MSG)}</textarea>
      <p class="note">אפשר להשתמש ב: {שם_מטופל} {יום} {תאריך} {שעה}. אחרי הביטול נפתח מסך לשליחת ההודעות.</p></div>
    <div class="actions"><button class="btn danger" id="cdGo" ${items.length ? '' : 'disabled'}>ביטול הטיפולים</button><button class="btn" id="cdClose">סגירה</button></div>`);
  $('#cdDay', sh).onchange = e => { if (e.target.value) showCancelDay(parseDateOnly(e.target.value)); };
  $('#cdClose', sh).onclick = closeSheet;
  $('#cdGo', sh).onclick = async () => {
    const chosen = items.filter((_, i) => sh.querySelector(`[data-cd="${i}"]`).checked);
    if (!chosen.length) { toast('לא נבחרו טיפולים'); return; }
    const reason = $('#cdReason', sh).value, note = $('#cdNote', sh).value.trim(), tpl = $('#cdMsg', sh).value.trim() || DEFAULT_CANCEL_MSG;
    const mk = feat('makeups') && $('#cdMk', sh).checked;
    if (tpl !== (S.settings.cancel_message || DEFAULT_CANCEL_MSG)) saveSettings({ ...S.settings, cancel_message: tpl });
    for (const ev of chosen) setStatus(ev, { attended: 'no', cancel_reason: reason, cancel_note: note, ...(feat('makeups') ? { makeup: mk ? 'due' : '' } : {}) });
    showNotify(chosen.map(ev => [ev, renderCancelMsg(tpl, ev)]));
  };
}
function showNotify(items, intro = '✓ הטיפולים סומנו כמבוטלים. עכשיו שולחים הודעה:', subject = 'ביטול טיפול', onBack = null) {
  const sh = openSheet(`<h3 style="margin:4px 0 6px">הודעה להורים</h3><p>${esc(intro)}</p>
    ${items.map(([ev, text], i) => { const n = title(ev).trim(); return `<div class="menu-item"><details style="flex:1"><summary>${esc(n)}</summary><div class="note" style="white-space:pre-wrap">${esc(text)}</div></details><button class="btn" data-nc="${i}">📋 העתקה</button><button class="btn" data-nw="${i}">💬 וואטסאפ</button><button class="btn" data-nm="${i}" ${clientEmails(n).length ? '' : 'disabled'}>✉ מייל</button></div>`; }).join('')}
    <div class="actions"><button class="btn" id="ntAll">✉ מייל לכל מי שיש לו מייל</button><button class="btn primary" id="ntDone">סיום</button></div>`);
  const mail = async (i, b) => { const [ev, text] = items[i], n = title(ev).trim(), em = clientEmails(n); if (!em.length) return;
    try { await sendPlainEmail(em.join(', '), `${subject} – ${n}`, text); if (b) b.textContent = '✓ נשלח'; } catch (e) { handleErr(e); } };
  sh.querySelectorAll('[data-nw]').forEach(b => b.onclick = () => { const [ev, text] = items[+b.dataset.nw]; window.open(whatsappUrl(clientPhone(title(ev).trim()), text), '_blank'); b.textContent = '✓ נפתח'; });
  sh.querySelectorAll('[data-nm]').forEach(b => b.onclick = () => mail(+b.dataset.nm, b));
  sh.querySelectorAll('[data-nc]').forEach(b => b.onclick = async () => { try { await navigator.clipboard.writeText(items[+b.dataset.nc][1]); b.textContent = '✓ הועתק'; } catch { toast('לא הצלחתי להעתיק'); } });
  $('#ntAll', sh).onclick = async () => { busy(true); try { for (let i = 0; i < items.length; i++) await mail(i, sh.querySelector(`[data-nm="${i}"]`)); toast('✓ נשלחו המיילים'); } finally { busy(false); } };
  $('#ntDone', sh).onclick = () => (onBack ? onBack() : closeSheet());
}

// ---- התראות: חגים שנופלים על טיפולים, מסמכים שתוקפם נגמר, מכסות שנגמרות (זהה ל-Windows)
const holidayClash = d => { for (const [n, k] of holidaysOn(d)) if (k === 'yomtov' || n.includes('עצמאות') || n.startsWith('ערב ')) return n; return null; };
function computeAlerts() {
  if (!feat('alerts')) return [];
  const now = new Date(), until = new Date(now.getTime() + 45 * 864e5), dismissed = new Set(S.settings.dismissed_alerts || []), out = [];
  for (const e of uniqueSessions(allKnown())) {
    const s = evTimes(e).s;
    if (s < now || s > until || attended(e) === 'no' || !canEdit(e)) continue;
    const h = holidayClash(s), key = 'hol:' + e.id;
    if (h && !dismissed.has(key)) out.push({ key, kind: 'holiday', ev: e, text: `${dmy(s).slice(0, 5)} ${ltr(hm(s))} · ${title(e)} – ${h}` });
  }
  if (feat('docs')) {
    const soon = isoDate(addDays(today(), 30)), td = isoDate(today());
    for (const f of clientDocsCache) {
      const ap = f.appProperties || {}; if (!ap.expiry) continue;
      const key = `doc:${f.id}:${ap.expiry}`;
      if (ap.expiry <= soon && !dismissed.has(key)) out.push({ key, kind: 'doc', doc: f, text: `${ap.client || ''} · ${f.name} – ${ap.expiry < td ? 'התוקף נגמר ב-' : 'בתוקף עד '}${dmy(parseDateOnly(ap.expiry))}` });
    }
  }
  const upcoming = {}, recent = new Set();
  for (const e of uniqueSessions(allKnown())) {
    const s = evTimes(e).s, n = title(e).trim();
    if (s > now && attended(e) !== 'no' && canEdit(e)) (upcoming[n] = upcoming[n] || []).push(e);
    else if (s <= now && s >= addDays(now, -21)) recent.add(n);
  }
  for (const [n, evs] of Object.entries(upcoming).sort()) {
    evs.sort((a, b) => evTimes(a).s - evTimes(b).s);
    const last = evs[evs.length - 1];
    if (evs.length <= 2 && recent.has(n) && last.recurringEventId) {
      const key = `series:${last.recurringEventId}:${isoDate(evTimes(last).s)}`;
      if (!dismissed.has(key)) out.push({ key, kind: 'series', ev: last, client: n, text: `${n} · נשארו ${evs.length} טיפולים בסדרה (האחרון ב-${dmy(evTimes(last).s).slice(0, 5)})` });
    }
  }
  if (feat('quota')) for (const name of Object.keys(S.settings.clients || {}).sort()) {
    const q = quotaStatus(name); if (!q) continue;
    const key = `quota:${name}:${q.quota}:${q.from}:${Math.max(q.left, 0)}`;
    if (q.left <= 2 && !dismissed.has(key)) out.push({ key, kind: 'quota', client: name, text: `${name} · מכסה: ${quotaText(q)}` });
  }
  return out;
}
async function refreshAlerts() {
  if (!S.token || !feat('alerts')) return;
  ensureHolidays([today(), addDays(today(), 60)]);
  if (feat('docs')) { try { clientDocsCache = await ClientDocs.list(); } catch { /* ignore */ } }
  renderQuickBar();
  const day = isoDate(today());
  if (store.get('alertsShown', '') !== day && $('#sheet').hidden && computeAlerts().length) { store.set('alertsShown', day); showAlerts(); }
}
function showAlerts() {
  const alerts = computeAlerts();
  const heads = { holiday: '🕎 טיפולים שנופלים על חג או ערב חג', series: '🔁 סדרות טיפולים שנגמרות', doc: '📎 מסמכים שתוקפם נגמר או עומד להיגמר', quota: '🔢 מכסות שנגמרות' };
  let h = '<h3 style="margin:4px 0 6px">🔔 התראות</h3>';
  for (const kind of ['holiday', 'series', 'doc', 'quota']) {
    const items = alerts.filter(a => a.kind === kind); if (!items.length) continue;
    h += `<div class="sec">${heads[kind]}</div>` + items.map(a => { const i = alerts.indexOf(a);
      return `<div class="card" style="margin:6px 0;padding:8px 10px"><div>${esc(a.text)}</div><div class="seg" style="margin:6px 0 0">
        ${kind === 'holiday' ? `<button class="btn" data-ac="${i}">ביטול (חג)</button><button class="btn" data-am="${i}">הזזה</button>` : ''}
        ${kind === 'doc' ? `<button class="btn" data-ao="${i}">פתיחה</button>` : ''}
        ${kind === 'series' ? `<button class="btn" data-ax="${i}">הארכה</button>` : ''}
        ${kind === 'quota' && feat('clientfile') ? `<button class="btn" data-af="${i}">תיק מטופל</button>` : ''}
        <button class="btn" data-ad="${i}">הסתרה</button></div></div>`; }).join('');
  }
  if (!alerts.length) h += '<p>אין התראות. ✓</p>';
  const sh = openSheet(h + '<div class="actions"><button class="btn" id="alClose">סגירה</button></div>');
  sh.querySelectorAll('[data-ac]').forEach(b => b.onclick = async () => { await setStatus(alerts[+b.dataset.ac].ev, { attended: 'no', cancel_reason: 'holiday', cancel_note: '', makeup: feat('makeups') ? 'due' : '' }); showAlerts(); });
  sh.querySelectorAll('[data-am]').forEach(b => b.onclick = () => showMove(alerts[+b.dataset.am].ev));
  sh.querySelectorAll('[data-ax]').forEach(b => b.onclick = () => editEvent(alerts[+b.dataset.ax].ev));
  sh.querySelectorAll('[data-ao]').forEach(b => b.onclick = () => { const l = alerts[+b.dataset.ao].doc.webViewLink; if (l && l !== '#') window.open(l, '_blank'); });
  sh.querySelectorAll('[data-af]').forEach(b => b.onclick = () => showClientFile(alerts[+b.dataset.af].client));
  sh.querySelectorAll('[data-ad]').forEach(b => b.onclick = async () => { await saveSettings({ ...S.settings, dismissed_alerts: [...(S.settings.dismissed_alerts || []), alerts[+b.dataset.ad].key].slice(-300) }); showAlerts(); });
  $('#alClose', sh).onclick = closeSheet;
}

// ---- קבלות לסוף החודש, עוזרת בשפה חופשית, הארכת סדרה, טופס קליטה, תרגילים לבית, ייצוא תיק (זהה ל-Windows)
FEATURES.push(
  ['bulkreceipts', '🧾 קבלות לסוף החודש', 'הפקת קבלה לכל מטופל/ת על כל הטיפולים ששולמו בחודש'],
  ['assistant', '🗣 עוזרת בשפה חופשית', '„תקבעי ליואב ביום שלישי ב-4” – בכתב או בקול'],
  ['intake', '📝 טופס קליטה להורים', 'קישור לטופס שנכנס ישר לרשימת ההמתנה'],
  ['exercises', '📚 תרגילים לבית', 'ספריית תרגילים ושליחה להורים'],
  ['export', '🖨 ייצוא תיק ל-PDF', 'כל הטיפולים וההערות של מטופל/ת בקובץ אחד'],
);
const INTAKE_FOLDER = 'טפסי קליטה';

function showSend({ name, heading, text, subject, onSent = null, onBack = null }) {
  const phone = clientPhone(name), emails = clientEmails(name);
  const sh = openSheet(`<h3 style="margin:4px 0 6px">${esc(heading)}</h3>
    <div class="field"><label>ההודעה (אפשר לערוך)</label><textarea id="snText" rows="8" style="width:100%;box-sizing:border-box">${esc(text)}</textarea></div>
    <p class="note">${phone ? 'טלפון: ' + ltr(esc(phone)) : 'אין טלפון שמור – וואטסאפ ייפתח לבחירת איש קשר.'}${emails.length ? '<br>מייל: ' + esc(emails.join(', ')) : ''}</p>
    <div class="actions"><button class="btn primary" id="snWa">💬 וואטסאפ</button><button class="btn" id="snMail" ${emails.length ? '' : 'disabled'}>✉ מייל</button><button class="btn" id="snCopy">העתקה</button></div>
    <div class="actions"><button class="btn" id="snBack">${onBack ? 'חזרה' : 'סגירה'}</button></div>`);
  const msg = () => $('#snText', sh).value.trim(), sent = () => { if (onSent) onSent(); };
  $('#snWa', sh).onclick = () => { window.open(whatsappUrl(phone, msg()), '_blank'); sent(); };
  $('#snCopy', sh).onclick = async () => { try { await navigator.clipboard.writeText(msg()); toast('✓ ההודעה הועתקה'); sent(); } catch { toast('לא הצלחתי להעתיק'); } };
  $('#snMail', sh).onclick = async () => { try { busy(true); await sendPlainEmail(emails.join(', '), subject, msg()); toast('✓ נשלח במייל'); sent(); closeSheet(); } catch (e) { handleErr(e); } finally { busy(false); } };
  $('#snBack', sh).onclick = () => (onBack ? onBack() : closeSheet());
}

// ---- קבלות לסוף החודש
function showBulkReceipts(monthIdx = null) {
  if (!morningReady()) { showMorningSettings(() => showBulkReceipts(monthIdx)); return; }
  const months = []; let d = new Date(today().getFullYear(), today().getMonth(), 1);
  for (let i = 0; i < 6; i++) { months.push(d); d = new Date(d.getFullYear(), d.getMonth() - 1, 1); }
  const mi = monthIdx ?? (today().getDate() <= 10 ? 1 : 0), month = months[mi], m = morningCfg();
  const groups = paidWithoutReceipt();
  const rows = Object.keys(groups).sort((a, b) => a.localeCompare(b, 'he')).map(name => {
    const ss = groups[name].filter(e => { const s = evTimes(e).s; return s.getFullYear() === month.getFullYear() && s.getMonth() === month.getMonth(); }).sort((a, b) => evTimes(a).s - evTimes(b).s);
    return { name, ss, missing: ss.some(e => !sessionAmount(e)), payer: name, realPayer: (ss.map(e => props(e).pay_payer).find(Boolean)) || '' };
  }).filter(r => r.ss.length);
  const sh = openSheet(`<h3 style="margin:4px 0 6px">🧾 קבלות לסוף החודש</h3>
    <div class="field"><label>חודש הטיפולים</label><select id="brMonth">${months.map((x, i) => `<option value="${i}" ${i === mi ? 'selected' : ''}>${MONTHS[x.getMonth()]} ${x.getFullYear()}</option>`).join('')}</select></div>
    ${m.env === 'sandbox' ? '<p class="note" style="background:#FFF1D6;color:#7A4B00;padding:6px 8px;border-radius:8px">סביבת בדיקות: המסמכים לא יהיו אמיתיים.</p>' : ''}
    <div class="field"><label>תאריך הקבלות</label><div class="two"><input type="date" id="brDate" value="${showBulkReceipts.date || isoDate(today())}" style="flex:2"><button class="btn" id="brEnd" style="flex:1">סוף החודש</button></div></div>
    ${rows.length ? `<p class="note">קבלה אחת לכל מטופל/ת על כל הטיפולים שלו/ה בחודש:</p>` + rows.map((r, i) => `<div class="card" style="margin:6px 0;padding:8px 10px">
      <label class="check" style="margin:0"><input type="checkbox" data-br="${i}" ${r.missing ? '' : 'checked'}><b>${esc(r.name)}</b> · ${r.ss.length} טיפולים · ${fmtMoney(r.ss.reduce((t, e) => t + (sessionAmount(e) || 0), 0))}${r.missing ? ' <span class="err">⚠ חסר סכום</span>' : ''}</label>
      <input type="text" data-bp="${i}" value="${esc(r.payer)}" placeholder="שם על הקבלה" style="margin-top:6px;width:100%;box-sizing:border-box">
      <button class="btn" data-bd="${i}" style="margin-top:6px">פירוט ועריכה…</button></div>`).join('')
      : '<p>אין בחודש הזה טיפולים ששולמו בלי קבלה. ✓</p>'}
    <label class="check"><input type="checkbox" id="brSend" ${m.send_email ? 'checked' : ''}>לשלוח כל קבלה במייל של המטופל/ת או ההורה (למי שיש מייל)</label>
    <div class="actions"><button class="btn primary" id="brGo" ${rows.length ? '' : 'disabled'}>🧾 הפקת הקבלות</button><button class="btn" id="brClose">סגירה</button></div>`);
  $('#brMonth', sh).onchange = e => showBulkReceipts(+e.target.value);
  $('#brDate', sh).onchange = e => { showBulkReceipts.date = e.target.value; };
  $('#brEnd', sh).onclick = () => { const end = addDays(new Date(month.getFullYear(), month.getMonth() + 1, 1), -1); $('#brDate', sh).value = isoDate(end < today() ? end : today()); showBulkReceipts.date = $('#brDate', sh).value; };
  sh.querySelectorAll('[data-bd]').forEach(b => b.onclick = () => { const r = rows[+b.dataset.bd], ids = r.ss.map(e => e.id);
    showMorningIssue({ client: r.name, preIds: ids, onlyIds: ids, docDate: $('#brDate', sh).value, onBack: () => showBulkReceipts(mi) }); });
  $('#brClose', sh).onclick = closeSheet;
  $('#brGo', sh).onclick = async () => {
    const jobs = rows.map((r, i) => ({ ...r, payer: sh.querySelector(`[data-bp="${i}"]`).value.trim() || r.name, on: sh.querySelector(`[data-br="${i}"]`).checked })).filter(r => r.on);
    if (!jobs.length) return;
    const bad = jobs.find(j => j.missing); if (bad) { toast(`ל${bad.name} יש טיפול בלי סכום`); return; }
    const send = $('#brSend', sh).checked, total = jobs.reduce((t, j) => t + j.ss.reduce((a, e) => a + sessionAmount(e), 0), 0);
    if (!await choose('קבלות לסוף החודש', `להפיק ${jobs.length} חשבוניות מס/קבלה, סה״כ ${fmtMoney(total)}?` + (m.env === 'production' ? '\n\nאלה מסמכים רשמיים: אחרי ההפקה אי אפשר למחוק אותם, רק לבטל במסמך זיכוי.' : '\n\n(סביבת בדיקות)'), [{ label: 'כן, להפיק', value: true, cls: 'primary' }])) { showBulkReceipts(mi); return; }
    const date = $('#brDate', sh).value || isoDate(today()); let ok = 0; const errors = [], done = [];
    busy(true); progressSheet(`מפיק ${jobs.length} קבלות ב-Morning…`);
    try {
      for (const j of jobs) {
        try {
          let contact = clientInfo(j.name).morning_client || null;
          if (!contact) { try { contact = (await findMorningContact(m.env, j.payer || j.name, j.realPayer))[0]; } catch { contact = null; } }
          const emails = (contact && contact.emails && contact.emails.length) ? contact.emails : clientEmails(j.name);
          const body = morningDocument(j.ss, { name: (contact && contact.name) || j.payer, emails, send: send && emails.length > 0, item: m.item, remarks: renderReceiptText(m.template || '', j.ss, j.name), date, vatIncluded: m.vat_included, clientId: contact ? contact.id : null });
          const res = await morningCreate(m.env, body), url = res.url || {};
          const ch = { rcpt_issued: 'yes', rcpt_no: String(res.number || ''), rcpt_date: date, rcpt_doc: String(res.id || ''), rcpt_url: typeof url === 'object' ? (url.he || url.origin || '') : String(url), rcpt_src: 'morning', rcpt_count: j.ss.length > 1 ? String(j.ss.length) : '' };
          for (const e of j.ss) await setStatus(e, ch);
          if (contact) await linkMorningContact(j.name, contact);
          done.push([j.ss[0], receiptWaText(j.ss, j.name, ch.rcpt_no, ch.rcpt_url, renderItem(m.item, j.ss))]);
          ok++;
        } catch (e) { errors.push(`${j.name}: ${e.message}`); }
      }
    } finally { busy(false); }
    if (done.length && m.send_whatsapp !== false) showNotify(done, `✓ הופקו ${ok} קבלות.${errors.length ? ' לא הצלחתי: ' + errors.join('; ') : ''} עכשיו שולחים להורים בוואטסאפ (או מעתיקים ושולחים בעצמך):`, 'חשבונית מס/קבלה');
    else alertSheet('קבלות לסוף החודש', `✓ הופקו ${ok} קבלות.` + (errors.length ? '\n\nלא הצלחתי:\n' + errors.join('\n') : ''));
  };
}

// ---- עוזרת בשפה חופשית
const ASSIST_SCHEMA = { type: 'OBJECT', properties: {
  action: { type: 'STRING', enum: ['create', 'move', 'cancel', 'attended', 'paid', 'question', 'unknown'] },
  client: { type: 'STRING' }, event_id: { type: 'STRING' }, date: { type: 'STRING' }, time: { type: 'STRING' },
  minutes: { type: 'INTEGER' }, weekly_count: { type: 'INTEGER' },
  reason: { type: 'STRING', enum: ['', 'client', 'sick', 'me', 'holiday', 'noshow', 'other'] },
  method: { type: 'STRING', enum: ['', 'cash', 'bank', 'bit', 'paybox', 'other'] },
  amount: { type: 'NUMBER' }, explanation: { type: 'STRING' } }, required: ['action', 'explanation'] };
const ASSIST_SYSTEM = `את/ה עוזר/ת יומן של קלינאית תקשורת. היא כותבת בקשה בעברית חופשית, ואת/ה מתרגם/ת אותה לפעולה אחת.
פעולות: create – פגישה חדשה למטופל/ת (date, time, minutes, ואם ביקשה „כל שבוע” – weekly_count, ברירת מחדל 10);
move – הזזת פגישה קיימת (event_id מהרשימה, date ו-time החדשים); cancel – ביטול פגישה (event_id, reason);
attended – סימון שהפגישה התקיימה (event_id); paid – סימון תשלום (event_id, method, amount אם נאמר);
question – שאלה על היסטוריה, נתונים או חובות; unknown – אם הבקשה לא ברורה (ואז explanation עם שאלה קצרה).
כללים: event_id רק מתוך רשימת הפגישות. „מחר”, „ביום שלישי”, „בשבוע הבא” – לפי התאריך של היום. שעה בלי ציון בוקר/ערב
בין 1 ל-7 היא אחר הצהריים (4 = 16:00). שם המטופל/ת – כפי שמופיע ברשימה אם יש התאמה. explanation – משפט קצר בעברית
שמתאר מה תעשה/י. אם לא ברור לאיזו פגישה הכוונה – unknown.`;
function assistContext() {
  const now = new Date(), w = { ...DEFAULT_WORK, ...(S.settings.work_hours || {}) };
  const lines = [`היום: יום ${DAYS[now.getDay()]} ${isoDate(now)}, השעה ${hm(now)}.`, `אורך טיפול רגיל: ${w.minutes} דקות.`, 'מטופלים: ' + clientNames().join(', '), 'פגישות (id | תאריך | יום | שעה | מטופל/ת | סטטוס):'];
  for (const e of uniqueSessions(allKnown())) {
    const s = evTimes(e).s;
    if (s >= addDays(now, -14) && s <= addDays(now, 45)) lines.push(`${e.id} | ${isoDate(s)} | ${DAYS[s.getDay()]} | ${hm(s)} | ${title(e)} | ${statusText(e)}${paid(e) ? ' | שולמה' : ''}`);
  }
  return lines.join('\n');
}
async function geminiAssist(request) {
  if (DEMO) { await new Promise(r => setTimeout(r, 400)); const e = uniqueSessions(allKnown()).find(x => evTimes(x).s > new Date());
    return { action: 'move', event_id: e.id, date: isoDate(addDays(evTimes(e).s, 1)), time: '17:00', explanation: 'הזזה' }; }
  const key = store.get('geminiKey', '');
  const body = { systemInstruction: { parts: [{ text: ASSIST_SYSTEM }] }, contents: [{ role: 'user', parts: [{ text: assistContext() + '\n\nהבקשה: ' + request }] }],
    generationConfig: { responseMimeType: 'application/json', responseSchema: ASSIST_SCHEMA, temperature: 0 } };
  let busy2 = false;
  for (const { model, wait } of geminiAttempts()) {
    if (wait) await new Promise(res => setTimeout(res, wait));
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, { method: 'POST', headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (r.status === 404) continue;
    if (GEMINI_BUSY.includes(r.status)) { busy2 = true; continue; }
    if (!r.ok) throw new Error(`שגיאה מ-Gemini (${r.status}).`);
    const j = await r.json(); recordUsage(model, j);
    return JSON.parse(j.candidates[0].content.parts[0].text);
  }
  throw new Error(busy2 ? GEMINI_BUSY_MSG : 'לא נמצא מודל Gemini זמין.');
}
function showAssistant(prefill = '', result = '') {
  const sh = openSheet(`<h3 style="margin:4px 0 6px">🗣 עוזרת</h3>
    <p class="note">למשל: „תקבעי ליואב טיפול ביום שלישי ב-4”, „תזיזי את נועה למחר ב-5”, „נועה שילמה בביט על היום”, „דני ביטל את הטיפול של מחר – מחלה”.</p>
    <div class="field"><textarea id="asQ" rows="2" style="width:100%;box-sizing:border-box" placeholder="מה לעשות?">${esc(prefill)}</textarea></div>
    <div class="seg">${feat('voice') ? '<button class="btn" id="asRec">🎤 בקול</button>' : ''}<button class="btn primary" id="asGo">הבנה</button></div>
    <div id="asOut" style="white-space:pre-wrap;margin:8px 0">${esc(result)}</div>
    <div class="actions"><button class="btn primary" id="asOk" style="display:none">✓ אישור וביצוע</button><button class="btn" id="asClose">סגירה</button></div>`);
  const out = $('#asOut', sh), okb = $('#asOk', sh);
  let plan = null, timer = null;
  const find = id => allKnown().find(e => e.id === id);
  const at = (d, t) => fromInputs(d, t);
  const understand = async () => {
    const text = $('#asQ', sh).value.trim(); if (!text) return;
    if (!DEMO && !store.get('geminiKey', '')) { askGeminiKey(() => showAssistant(text)); return; }
    out.textContent = 'חושבת…'; okb.style.display = 'none';
    try { plan = await geminiAssist(text); } catch (e) { out.textContent = 'שגיאה: ' + e.message; return; }
    const a = plan.action, ev = find(plan.event_id || '');
    let desc = plan.explanation || '', ok = true;
    try {
      if (a === 'create') { const st = at(plan.date, plan.time), n = +plan.weekly_count || 0;
        desc = `פגישה חדשה ל${plan.client}: יום ${DAYS[st.getDay()]} ${dmy(st)} בשעה ${hm(st)}, ${plan.minutes || 45} דקות${n > 1 ? `, כל שבוע (${n} פגישות)` : ''}` + (clientNames().includes((plan.client || '').trim()) ? '' : '\n⚠ שם שלא מופיע ברשימת המטופלים.');
        if (isNaN(st)) ok = false; }
      else if (a === 'move' && ev) { const st = at(plan.date, plan.time), s = evTimes(ev).s;
        desc = `הזזת הפגישה של ${title(ev)} מ-${dmy(s).slice(0, 5)} ${hm(s)} ליום ${DAYS[st.getDay()]} ${dmy(st).slice(0, 5)} בשעה ${hm(st)}`; if (isNaN(st)) ok = false; }
      else if (['cancel', 'attended', 'paid'].includes(a) && ev) { const s = evTimes(ev).s;
        desc = `${{ cancel: 'ביטול', attended: 'סימון שהתקיימה', paid: 'סימון תשלום' }[a]}: ${title(ev)}, ${dmy(s).slice(0, 5)} בשעה ${hm(s)}`;
        if (a === 'cancel' && plan.reason) desc += ` (סיבה: ${(CANCEL_REASONS.find(r => r[0] === plan.reason) || [0, ''])[1]})`;
        if (a === 'paid') desc += ` · ${(PAY_METHODS.find(p => p[0] === (plan.method || 'other')) || [0, ''])[1]}${plan.amount ? ' · ' + fmtMoney(plan.amount) : ''}`; }
      else if (a === 'question') desc = 'זו שאלה – אפתח אותה ב„שאלה ל-AI”.';
      else ok = false;
    } catch { ok = false; }
    out.textContent = desc || 'לא הבנתי. אפשר לנסח אחרת?';
    okb.style.display = ok && a !== 'unknown' ? '' : 'none';
  };
  $('#asGo', sh).onclick = understand;
  const rb = $('#asRec', sh);
  if (rb) rb.onclick = async () => {
    if (Voice.rec) {
      clearInterval(timer); rb.textContent = '🎤 בקול';
      const wav = await Voice.stop(); out.textContent = 'Gemini מתמלל…';
      try { const t = await geminiTranscribe(wav); if (t) { $('#asQ', sh).value = t; understand(); } else out.textContent = 'לא זוהה דיבור.'; } catch (e) { out.textContent = 'שגיאה: ' + e.message; }
      return;
    }
    if (!DEMO && !store.get('geminiKey', '')) { askGeminiKey(() => showAssistant()); return; }
    try { await Voice.start(); } catch { alertSheet('הקלטה', 'לא הצלחתי להפעיל את המיקרופון. מאשרים לאפליקציה גישה למיקרופון בהגדרות של Chrome.'); return; }
    rb.textContent = '⏹ סיום'; out.textContent = '🔴 מקליט…'; let secs = 0;
    timer = setInterval(() => { secs++; if (secs >= 60) rb.click(); }, 1000);
  };
  okb.onclick = async () => {
    const p = plan || {}, a = p.action, ev = find(p.event_id || '');
    try {
      busy(true);
      if (a === 'create') {
        const st = at(p.date, p.time), en = new Date(st.getTime() + (+p.minutes || 45) * 60000), tz = currentTz(), name = (p.client || '').trim();
        const body = { summary: name, start: { dateTime: localStr(st), timeZone: tz }, end: { dateTime: localStr(en), timeZone: tz } };
        const prev = clientSessions(name).filter(e => e.location); if (prev.length) body.location = prev[prev.length - 1].location;
        if ((+p.weekly_count || 0) > 1) body.recurrence = [`RRULE:FREQ=WEEKLY;COUNT=${+p.weekly_count}`];
        const cal = (S.calId && S.calId !== ALL && writable().find(c => c.id === S.calId)) || writable()[0];
        await G.insert(cal.id, body); changed();
      } else if (a === 'move' && ev) {
        const st = at(p.date, p.time), t = evTimes(ev), en = new Date(st.getTime() + (t.e - t.s));
        await G.patch(ev._calendar_id, ev.id, { start: { dateTime: localStr(st), timeZone: currentTz() }, end: { dateTime: localStr(en), timeZone: currentTz() } }, hasGuests(ev)); changed();
      } else if (a === 'cancel' && ev) {
        await setStatus(ev, { attended: 'no', cancel_reason: p.reason || '', cancel_note: '', ...(feat('makeups') ? { makeup: MAKEUP_REASONS.includes(p.reason) ? 'due' : '' } : {}) });
      } else if (a === 'attended' && ev) {
        await setStatus(ev, { attended: 'yes', cancel_reason: '', cancel_note: '' }); quotaWarning(ev);
      } else if (a === 'paid' && ev) {
        await setStatus(ev, { paid: 'yes', pay_method: p.method || 'other', pay_date: isoDate(today()), ...(p.amount ? { pay_amount: String(p.amount) } : {}) });
      } else if (a === 'question') { busy(false); showAI($('#asQ', sh).value.trim()); return; }
      showAssistant('', '✓ בוצע. אפשר לכתוב בקשה נוספת.');
    } catch (e) { handleErr(e); } finally { busy(false); }
  };
  $('#asClose', sh).onclick = closeSheet;
}

// ---- תרגילים לבית
function showExercises(ev = null, q = '') {
  const all = (S.settings.exercises || []).slice().sort((a, b) => (a.topic || '').localeCompare(b.topic || '', 'he') || a.title.localeCompare(b.title, 'he'));
  const items = all.filter(x => !q || x.title.includes(q) || (x.topic || '').includes(q));
  const sh = openSheet(`<h3 style="margin:4px 0 6px">📚 תרגילים לבית${ev ? ' – ' + esc(title(ev)) : ''}</h3>
    <div class="field"><input type="search" id="exQ" placeholder="חיפוש לפי שם או נושא…" value="${esc(q)}"></div>
    ${items.map((x, i) => `<div class="card" style="margin:6px 0;padding:8px 10px">
      ${ev ? `<label class="check" style="margin:0"><input type="checkbox" data-xc="${i}"><b>${esc(x.title)}</b>${x.topic ? ` <span class="note">(${esc(x.topic)})</span>` : ''}</label>` : `<b>${esc(x.title)}</b>${x.topic ? ` <span class="note">(${esc(x.topic)})</span>` : ''}`}
      <div class="note" style="white-space:pre-wrap">${esc(x.text)}</div>
      <div class="seg" style="margin:6px 0 0"><button class="btn" data-xe="${i}">עריכה</button><button class="btn danger" data-xd="${i}">מחיקה</button></div></div>`).join('') || '<p class="note">אין עדיין תרגילים.</p>'}
    <div class="actions">${ev ? '<button class="btn primary" id="exSend">📨 שליחה להורה</button>' : ''}<button class="btn" id="exAdd">+ תרגיל חדש</button><button class="btn" id="exClose">סגירה</button></div>`);
  $('#exQ', sh).onchange = e => showExercises(ev, e.target.value.trim());
  $('#exAdd', sh).onclick = () => showExerciseEdit(null, () => showExercises(ev, q));
  $('#exClose', sh).onclick = () => (ev ? showDetails(ev) : closeSheet());
  sh.querySelectorAll('[data-xe]').forEach(b => b.onclick = () => showExerciseEdit(items[+b.dataset.xe], () => showExercises(ev, q)));
  sh.querySelectorAll('[data-xd]').forEach(b => b.onclick = async () => {
    const x = items[+b.dataset.xd];
    if (await choose('מחיקה', `למחוק את „${x.title}”?`, [{ label: 'מחיקה', value: true, cls: 'danger' }])) await saveSettings({ ...S.settings, exercises: all.filter(y => y.id !== x.id) });
    showExercises(ev, q);
  });
  const sb = $('#exSend', sh);
  if (sb) sb.onclick = () => {
    const chosen = items.filter((_, i) => sh.querySelector(`[data-xc="${i}"]`).checked);
    if (!chosen.length) { toast('מסמנים תרגיל אחד או יותר'); return; }
    const name = title(ev).trim(), titles = chosen.map(x => x.title).join(' · ').slice(0, 900);
    showSend({ name, heading: 'שליחת תרגול לבית', subject: `תרגול לבית – ${name}`,
      text: `שלום, תרגול לבית בעקבות הטיפול של ${name}:\n\n` + chosen.map(x => `• ${x.title}\n${x.text}`).join('\n\n') + '\n\nבהצלחה!',
      onSent: () => setStatus(ev, { homework: titles }), onBack: () => showExercises(ev, q) });
  };
}
function showExerciseEdit(x, back) {
  const sh = openSheet(`<h3 style="margin:4px 0 6px">${x ? 'עריכת תרגיל' : 'תרגיל חדש'}</h3>
    <div class="field"><label>שם</label><input type="text" id="xeT" value="${esc(x ? x.title : '')}"></div>
    <div class="field"><label>נושא</label><input type="text" id="xeP" placeholder="למשל: הגייה, שפה, שטף, בליעה" value="${esc(x ? x.topic || '' : '')}"></div>
    <div class="field"><label>התרגיל</label><textarea id="xeX" rows="5" style="width:100%;box-sizing:border-box" placeholder="מה עושים בבית, כמה פעמים, ולמה זה חשוב">${esc(x ? x.text : '')}</textarea></div>
    <p class="err" id="xeErr"></p>
    <div class="actions"><button class="btn primary" id="xeSave">שמירה</button><button class="btn" id="xeBack">חזרה</button></div>`);
  $('#xeBack', sh).onclick = back;
  $('#xeSave', sh).onclick = async () => {
    const t = $('#xeT', sh).value.trim(), tx = $('#xeX', sh).value.trim();
    if (!t || !tx) { $('#xeErr', sh).textContent = 'צריך שם ותיאור.'; return; }
    const v = { ...(x || {}), title: t, topic: $('#xeP', sh).value.trim(), text: tx }; v.id = v.id || 'x' + Date.now();
    await saveSettings({ ...S.settings, exercises: (S.settings.exercises || []).filter(y => y.id !== v.id).concat([v]) });
    back();
  };
}

// ---- ייצוא תיק מטופל ל-PDF (דרך הדפסה ← „שמירה כ-PDF”)
async function exportClient(name) {
  const ss = clientSessions(name), info = clientInfo(name), now = new Date();
  let docs = [];
  if (feat('docs')) { try { busy(true); docs = await ClientDocs.list(name); } catch { /* ignore */ } finally { busy(false); } }
  const held = ss.filter(e => attended(e) === 'yes').length, canc = ss.filter(e => attended(e) === 'no').length;
  const facts = [info.phone ? 'טלפון: ' + esc(info.phone) : '', (info.emails || []).length ? 'מייל: ' + esc(info.emails.join(', ')) : '',
    (info.payers || []).length ? 'משלמים: ' + esc(info.payers.join(', ')) : '', quotaStatus(name) ? 'מכסה: ' + esc(quotaText(quotaStatus(name))) : ''].filter(Boolean);
  const rows = ss.filter(e => evTimes(e).s <= now || attended(e) === 'no').map(e => { const s = evTimes(e).s, n = sessionNo(e), p = props(e);
    return `<tr><td>${dmy(s)}</td><td>${hm(s)}</td><td>${n || ''}</td><td>${esc(statusText(e))}</td><td style="white-space:pre-wrap">${esc(evNote(e))}${p.homework ? '<br>📚 ' + esc(p.homework) : ''}</td></tr>`; }).join('');
  const html = `<!doctype html><html dir="rtl" lang="he"><head><meta charset="utf-8"><title>תיק מטופל – ${esc(name)}</title><style>
    body{font-family:Arial,sans-serif;font-size:11pt;color:#1F2D2B;margin:24px}h1{color:#1E4D47;font-size:18pt}table{width:100%;border-collapse:collapse}
    th,td{border:1px solid #D3E0DD;padding:5px;text-align:right;vertical-align:top}th{background:#E6EFED}.n{color:#8A9A97;font-size:8pt}</style></head><body>
    <h1>תיק מטופל – ${esc(name)}</h1><p>הופק ב-${dmy(today())}${ss.length ? ' · טיפולים מ-' + dmy(evTimes(ss[0]).s) : ''} · התקיימו ${held} · בוטלו ${canc}</p>
    ${facts.length ? `<p>${facts.join('<br>')}</p>` : ''}
    <table><tr><th>תאריך</th><th>שעה</th><th>מפגש</th><th>סטטוס</th><th>מה היה בטיפול</th></tr>${rows}</table>
    ${docs.length ? `<h3>מסמכים</h3><ul>${docs.map(f => { const ap = f.appProperties || {}; return `<li>${esc(f.name)} – ${docTypeLabel(ap.doc_type)}${ap.expiry ? ' (תוקף עד ' + dmy(parseDateOnly(ap.expiry)) + ')' : ''}</li>`; }).join('')}</ul>` : ''}
    <p class="n">מסמך חסוי – מכיל מידע רפואי.</p><script>setTimeout(function(){print()},300)<\/script></body></html>`;
  const w = window.open('', '_blank');
  if (!w) { toast('הדפדפן חסם חלון חדש'); return; }
  w.document.open(); w.document.write(html); w.document.close();
}

// ---- טופס קליטה: הטופס רץ בסקריפט „ממסר Morning”, והפניות נשמרות כקבצים ב-Drive
function intakeToWait(d, fileId) {
  const note = [d.parent ? 'הורה: ' + d.parent : '', d.age ? 'גיל: ' + d.age : '', d.reason ? 'סיבת פנייה: ' + d.reason : '', d.notes || ''].filter(Boolean).join('\n');
  return { id: 'f' + fileId, name: String(d.child || d.parent || 'פנייה').trim().slice(0, 80), phone: String(d.phone || '').slice(0, 30), email: String(d.email || '').slice(0, 100),
    location: String(d.location || '').slice(0, 100), note: note.slice(0, 1500), days: (d.days || []).map(Number).filter(x => x >= 0 && x <= 5),
    from: String(d.from || '').slice(0, 5), to: String(d.to || '').slice(0, 5), added: String(d.sent || isoDate(today())).slice(0, 10), source: 'form' };
}
const relayUrl = () => (S.settings.relay_url || morningRelay() || '').trim();
const intakeUrl = () => relayUrl().startsWith('https://') ? relayUrl() + (relayUrl().includes('?') ? '&' : '?') + 'form=intake' : '';
async function importIntake() {
  if (!S.token || !feat('intake') || !relayUrl() || DEMO) return;
  try {
    const fid = await AppData.folder(INTAKE_FOLDER, await AppData.app(), 'intakeFolder');
    const r = await gfetch('https://www.googleapis.com/drive/v3/files?' + qs({ q: `'${fid}' in parents and trashed = false`, spaces: 'drive', pageSize: 100, fields: 'files(id,name)' }));
    const items = [];
    for (const f of r.files || []) { try { items.push(intakeToWait(JSON.parse(await (await Drive.download(f.id)).text()), f.id)); } catch { /* ignore */ } }
    if (!items.length) return;
    const have = new Set((S.settings.waitlist || []).map(w => w.id)), added = items.filter(w => !have.has(w.id));
    if (added.length) { await saveSettings({ ...S.settings, waitlist: [...(S.settings.waitlist || []), ...added] }); toast(`✓ ${added.length} פניות חדשות מטופס הקליטה נכנסו לרשימת ההמתנה`); }
    for (const w of items) { try { await gfetch(`https://www.googleapis.com/drive/v3/files/${enc(w.id.slice(1))}?fields=id`, { method: 'PATCH', json: { trashed: true } }); } catch { /* ignore */ } }
  } catch { /* ignore */ }
}
function showIntake() {
  const sh = openSheet(`<h3 style="margin:4px 0 6px">📝 טופס קליטה להורים</h3>
    <p>שולחים להורים קישור לטופס. מה שהם ממלאים (פרטים, סיבת פנייה, זמינות ומקום מועדף) נכנס ישר לרשימת ההמתנה, ומגיע אלייך גם מייל. הטופס רץ בסקריפט „ממסר Morning” שבחשבון Google שלך.</p>
    <div class="field"><label>כתובת הממסר</label><input type="url" dir="ltr" id="inRelay" value="${esc(relayUrl())}" placeholder="https://script.google.com/macros/s/…/exec"></div>
    <div class="field"><label>כותרת הטופס</label><input type="text" id="inTitle" value="${esc(S.settings.intake_title || 'טופס פנייה לטיפול בקלינאות תקשורת')}"></div>
    <p class="note" dir="ltr" id="inLink" style="word-break:break-all;text-align:left"></p>
    <div class="actions"><button class="btn" id="inCopy">העתקת הקישור</button><button class="btn" id="inWa">💬 וואטסאפ</button><button class="btn" id="inOpen">פתיחה</button></div>
    <p class="note">צריך את גרסת הקוד העדכנית של הממסר.</p>
    <div class="actions"><button class="btn primary" id="inSave">שמירה</button><button class="btn" id="inClose">סגירה</button></div>`);
  const url = () => { const u = $('#inRelay', sh).value.trim(); return u.startsWith('https://') ? u + (u.includes('?') ? '&' : '?') + 'form=intake' : ''; };
  const upd = () => { $('#inLink', sh).textContent = url() || '(מדביקים קודם את כתובת הממסר)'; };
  $('#inRelay', sh).oninput = upd; upd();
  $('#inCopy', sh).onclick = async () => { if (url()) { try { await navigator.clipboard.writeText(url()); toast('✓ הועתק'); } catch { toast('לא הצלחתי להעתיק'); } } };
  $('#inWa', sh).onclick = () => { if (url()) window.open(whatsappUrl('', `שלום, זה הטופס לפנייה לטיפול. אשמח שתמלאו אותו: ${url()}`), '_blank'); };
  $('#inOpen', sh).onclick = () => { if (url()) window.open(url(), '_blank'); };
  $('#inClose', sh).onclick = closeSheet;
  $('#inSave', sh).onclick = async () => { const st = { ...S.settings, relay_url: $('#inRelay', sh).value.trim(), intake_title: $('#inTitle', sh).value.trim() }; closeSheet(); await saveSettings(st); };
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
    ${t.allDay || !isSession(ev) || !feat('quota') || !quotaStatus(title(ev).trim()) ? '' : `<div class="k">מכסה</div><div style="${quotaStatus(title(ev).trim()).left <= 2 ? 'color:#B54708;font-weight:600' : ''}">${esc(quotaText(quotaStatus(title(ev).trim())))}</div>`}
    ${t.allDay || !isSession(ev) ? '' : `<div class="k">מחיר</div><div>${evPrice(ev) ? fmtMoney(evPrice(ev)) + (toAmount(props(ev).price) ? '' : ' <span class="note">(ברירת מחדל)</span>') : '<span class="note">לא נקבע (אפשר לקבוע ב„עריכה” או ב-☰ ← מחירי טיפול)</span>'}</div>`}</div>`;
  if (!t.allDay && isSession(ev)) {
    h += `<div class="sec">הפגישה</div><div class="seg">
        <button class="btn ${a === 'yes' ? 'on' : ''}" data-att="yes" ${dis}>✓ התקיימה</button>
        <button class="btn ${a === 'no' ? 'on' : ''}" data-att="no" ${dis}>✗ לא התקיימה</button></div>
      ${a === '' ? '<p class="note" style="margin-top:-6px">טרם סומן · לחיצה חוזרת על סימון מבטלת אותו</p>' : ''}
      ${a === 'no' && cancelLabel(ev) ? `<p class="note" style="margin-top:-4px">סיבה: ${esc(cancelLabel(ev))}</p>` : ''}
      ${feat('makeups') && makeupDue(ev) ? `<p class="note" style="margin-top:-4px">↺ צריך פגישת השלמה</p>${edit ? '<button class="btn" id="mkBtn" style="width:100%;margin-bottom:8px">↺ קביעת פגישת השלמה</button>' : ''}` : ''}
      ${feat('makeups') && a === 'no' && props(ev).makeup === 'done' ? '<p class="note" style="margin-top:-4px">✓ נקבעה פגישת השלמה</p>' : ''}
      ${feat('makeups') && props(ev).makeup_for ? `<p class="note" style="margin-top:-4px">↺ פגישת השלמה${(() => { const o = allKnown().find(x => x.id === props(ev).makeup_for); return o ? ' לטיפול מ-' + dmy(evTimes(o).s) : ''; })()}</p>` : ''}
      <div class="sec">תשלום</div><div class="seg">
        <button class="btn ${!paid(ev) ? 'on' : ''}" id="unpaidBtn" ${dis}>לא שולמה</button>
        <button class="btn ${paid(ev) ? 'on' : ''}" id="paidBtn" ${dis}>₪ שולמה${paid(ev) && payLabel(ev) ? ' · ' + esc(payLabel(ev)) : '…'}</button></div>
      ${paid(ev) && payDetails(ev) ? `<p class="note" style="margin-top:-4px">${esc(payDetails(ev))}</p>` : ''}
      ${paid(ev) && props(ev).pay_receipt ? '<button class="btn" id="rcptBtn" style="width:100%;margin-bottom:8px">📎 צפייה באישור התשלום</button>' : ''}
      <div class="sec">קבלה</div><div class="seg">
        <button class="btn ${!receiptIssued(ev) ? 'on' : ''}" id="rcNo" ${dis}>לא הוצאה</button>
        <button class="btn ${receiptIssued(ev) && props(ev).rcpt_src === 'morning' ? 'on' : ''}" id="rcMorning" ${feat('morning') ? '' : 'style="display:none"'} ${edit && paid(ev) && !receiptIssued(ev) ? '' : 'disabled'}>🧾 ${receiptIssued(ev) && props(ev).rcpt_src === 'morning' ? 'הופקה ב-Morning' : 'הפקה ב-Morning…'}</button>
        <button class="btn ${receiptIssued(ev) && props(ev).rcpt_src !== 'morning' ? 'on' : ''}" id="rcYes" ${dis}>שיוך ידני…</button></div>
      ${receiptIssued(ev) ? `<p class="note" style="margin-top:-4px">${esc(receiptDetails(ev))}</p>` : ''}
      ${receiptIssued(ev) && (props(ev).rcpt_url || props(ev).rcpt_file) ? '<button class="btn" id="rcView" style="width:100%;margin-bottom:8px">📄 צפייה בקבלה</button>' : ''}
      ${receiptIssued(ev) && edit ? '<button class="btn danger" id="rcVoid" style="width:100%;margin-bottom:8px">✖ ביטול הקבלה (הופקה בטעות)</button>' : ''}
      ${!receiptIssued(ev) && props(ev).rcpt_void ? `<p class="note" style="margin-top:-4px">קבלה קודמת בוטלה: ${esc(props(ev).rcpt_void)}</p>` : ''}
      ${feat('notes') ? noteBoxHtml(ev) : ''}
      <p class="note">הסימונים נשמרים רק לפגישה הזו, לא לכל הסדרה.</p>`;
  }
  h += `<div class="actions">
      <button class="btn primary" id="moveBtn" ${edit && !t.allDay ? '' : 'disabled'}>הזזה</button>
      <button class="btn" id="editBtn" ${edit && !t.allDay ? '' : 'disabled'}>עריכה</button>
      <button class="btn danger" id="delBtn" ${dis}>מחיקה</button></div>
    ${!t.allDay && isSession(ev) && (feat('clientfile') || feat('exercises')) ? `<div class="actions">${feat('exercises') ? '<button class="btn" id="hwBtn">📚 תרגיל לבית</button>' : ''}${feat('clientfile') ? '<button class="btn" id="fileBtn">📁 תיק מטופל</button>' : ''}</div>
      ${feat('exercises') && props(ev).homework ? `<p class="note">📚 נשלח: ${esc(props(ev).homework)}</p>` : ''}` : ''}
    <div class="actions"><button class="btn" id="closeBtn">סגירה</button></div>`;
  const sh = openSheet(h);
  sh.querySelectorAll('[data-att]').forEach(b => b.onclick = async () => {
    // לחיצה על הסימון הנוכחי מבטלת אותו (= טרם סומן)
    const target = attended(ev) === b.dataset.att ? '' : b.dataset.att;
    if (target === 'no') { showCancel(ev); return; }
    const changes = { attended: target, cancel_reason: '', cancel_note: '' };
    if (props(ev).makeup === 'due') changes.makeup = '';
    const g = await guardSequence(ev, { props: { ...props(ev), ...changes } });
    if (g.ok) { setStatus(ev, changes); applyPin(g.pin); }
    showDetails(ev);
    if (g.ok && target === 'yes') quotaWarning(ev);
  });
  bindNoteBox(ev, sh);
  if (!feat('voice') && $('#noteRec', sh)) $('#noteRec', sh).style.display = 'none';
  const mkb = $('#mkBtn', sh); if (mkb) mkb.onclick = () => scheduleMakeup(ev, () => showDetails(ev));
  const hwb = $('#hwBtn', sh); if (hwb) hwb.onclick = () => showExercises(ev);
  const flb = $('#fileBtn', sh); if (flb) flb.onclick = () => showClientFile(title(ev).trim());
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
  const rvd = $('#rcVoid', sh); if (rvd) rvd.onclick = () => voidReceipt(ev, () => showDetails(ev));
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
    <p class="note">אפשר גם לשמור בלי סיבה.</p>
    ${feat('makeups') ? `<label class="check"><input type="checkbox" id="crMk" ${p.makeup === 'due' ? 'checked' : ''}>צריך פגישת השלמה</label>` : ''}
    <p class="err" id="crErr"></p>
    <div class="actions"><button class="btn primary" id="crSave">שמירה</button><button class="btn" id="crCancel">ביטול</button></div>`);
  $('#crCancel', sh).onclick = () => showDetails(ev);
  if ($('#crMk', sh) && p.makeup !== 'due') sh.querySelectorAll('input[name=cr]').forEach(r => r.onchange = () => { $('#crMk', sh).checked = MAKEUP_REASONS.includes(r.value); });
  $('#crSave', sh).onclick = () => {
    const r = sh.querySelector('input[name=cr]:checked'), note = $('#crNote', sh).value.trim();
    if (r && r.value === 'other' && !note) { $('#crErr', sh).textContent = 'יש לכתוב מה הסיבה.'; return; }
    const changes = { attended: 'no', cancel_reason: r ? r.value : '', cancel_note: note };
    if ($('#crMk', sh)) changes.makeup = $('#crMk', sh).checked ? 'due' : (p.makeup === 'done' ? 'done' : '');
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
    <div class="field"><label>תיאור השירות</label><input type="text" id="moItem" value="${esc(m.item)}"><p class="note">{חודש} = החודש של הטיפולים (למשל „נובמבר 2026”).</p></div>
    <div class="field"><label>טקסט קבוע על הקבלה</label><textarea id="moTpl" rows="3">${esc(m.template)}</textarea>
      <p class="note">אפשר להשתמש ב: {תאריכים} {מספר_טיפולים} {שם_מטופל} {סכום}</p></div>
    <label class="check"><input type="checkbox" id="moVat" ${m.vat_included ? 'checked' : ''}>המחירים כוללים מע״מ</label>
    <label class="check"><input type="checkbox" id="moSend" ${m.send_email ? 'checked' : ''}>לשלוח את הקבלה למייל של המטופל/ת או ההורה</label>
    <label class="check"><input type="checkbox" id="moWa" ${m.send_whatsapp !== false ? 'checked' : ''}>אחרי ההפקה לשלוח בוואטסאפ לטלפון של ההורה, עם הקישור לקבלה</label>
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
    await saveSettings({ ...S.settings, ...($('#moRelay', sh).value.trim() ? { relay_url: $('#moRelay', sh).value.trim() } : {}), morning: { env, item: $('#moItem', sh).value.trim() || DEFAULT_MORNING.item, template: $('#moTpl', sh).value.trim(), vat_included: $('#moVat', sh).checked, send_email: $('#moSend', sh).checked, send_whatsapp: $('#moWa', sh).checked } });
    closeSheet(); if (then) then();
  };
}
// ---- ביטול קבלה שהופקה בטעות: חשבונית זיכוי ב-Morning, או רק עדכון שהיא בוטלה (זהה ל-Windows)
function receiptGroup(ev) {
  const p = props(ev), [k, v] = p.rcpt_doc ? ['rcpt_doc', p.rcpt_doc] : ['rcpt_no', p.rcpt_no];
  if (!v) return [ev];
  const seen = new Set(), out = [];
  for (const e of [ev, ...allKnown()]) { if (seen.has(e.id) || props(e)[k] !== v || props(e).rcpt_issued !== 'yes') continue; seen.add(e.id); out.push(e); }
  return out;
}
function morningCreditDocument(ss, { name, emails, item, docNo, origId, date, vatIncluded, clientId = null }) {
  const body = morningDocument(ss, { name, emails, send: false, item, remarks: `ביטול חשבונית מס/קבלה מס׳ ${docNo} – הופקה בטעות.`, date, vatIncluded, clientId });
  body.type = 330; body.description = `ביטול חשבונית מס/קבלה מס׳ ${docNo}`;
  delete body.payment; body.linkedDocumentIds = [origId]; body.linkType = 'cancel';
  return body;
}
async function voidReceipt(ev, back) {
  const p = props(ev), group = receiptGroup(ev), name = title(ev).trim(), no = p.rcpt_no || '';
  const dates = group.map(e => evTimes(e).s).sort((a, b) => a - b).map(d => dmy(d).slice(0, 5)).join(', ');
  const canCredit = p.rcpt_src === 'morning' && !!p.rcpt_doc && feat('morning');
  const opts = (canCredit ? [{ label: 'ביטול ב-Morning (חשבונית זיכוי)', value: 'credit', cls: 'danger' }] : [])
    .concat([{ label: p.rcpt_src === 'morning' ? 'כבר בוטלה ב-Morning – רק לעדכן כאן' : 'לבטל את שיוך הקבלה', value: 'mark' }]);
  const choice = await choose('ביטול קבלה', `ביטול קבלה ${no ? 'מס׳ ' + no : ''} של ${name} (${group.length} טיפולים: ${dates}).\n\nמסמך חשבונאי לא נמחק: ב-Morning מבטלים אותו בחשבונית זיכוי. התשלום נשאר מסומן, והטיפולים יחזרו לרשימת „שולם, בלי קבלה”, כדי שאפשר יהיה להפיק קבלה מתוקנת.`, opts);
  if (!choice) { back(); return; }
  const finish = async (creditNo = '') => {
    const note = `${no ? 'מס׳ ' + no : 'קבלה'}${creditNo ? ' בוטלה בחשבונית זיכוי ' + creditNo : ' בוטלה'} (${dmy(today())})`;
    for (const e of group) await setStatus(e, { ...Object.fromEntries(RCPT_KEYS.map(k => [k, ''])), rcpt_void: note.slice(0, 900) });
    toast('✓ ' + note);
    if (feat('morning') && await choose('קבלה מתוקנת', 'להפיק עכשיו קבלה מתוקנת על אותם טיפולים?', [{ label: 'כן, להפיק', value: true, cls: 'primary' }]))
      showMorningIssue({ ev: group[0], extra: group, preIds: group.map(e => e.id), onBack: back });
    else back();
  };
  if (choice === 'mark') { await finish(); return; }
  if (!morningReady()) { showMorningSettings(back); return; }
  const m = morningCfg();
  if (m.env === 'production' && !await choose('חשבונית זיכוי', `להפיק ב-Morning חשבונית זיכוי שמבטלת את קבלה ${no}?\n\nגם חשבונית הזיכוי היא מסמך רשמי.`, [{ label: 'כן, להפיק', value: true, cls: 'danger' }])) { back(); return; }
  const contact = clientInfo(name).morning_client || {};
  const payer = contact.name || group.map(e => props(e).pay_payer).find(Boolean) || name;
  busy(true); progressSheet('מפיק חשבונית זיכוי ב-Morning…');
  try {
    const res = await morningCreate(m.env, morningCreditDocument(group, { name: payer, emails: (contact.emails && contact.emails.length) ? contact.emails : clientEmails(name), item: m.item, docNo: no, origId: p.rcpt_doc, date: isoDate(today()), vatIncluded: m.vat_included, clientId: contact.id || null }));
    busy(false); await finish(String(res.number || ''));
  } catch (e) { busy(false); alertSheet('ההפקה של חשבונית הזיכוי נכשלה', e.message + '\n\nאפשר לבטל את הקבלה ישירות באתר Morning, ואז לבחור כאן „כבר בוטלה ב-Morning”.', back); }
}
function showMorningIssue({ ev = null, client = null, extra = [], preIds = null, docDate = null, onlyIds = null, onBack = null } = {}) {
  // הפקת חשבונית מס/קבלה אחת ב-Morning – לטיפול אחד או לכמה טיפולים יחד
  const again = () => showMorningIssue({ ev, client, extra, preIds, docDate, onlyIds, onBack });
  if (!morningReady()) { showMorningSettings(again); return; }
  let groups = paidWithoutReceipt(extra);
  if (onlyIds) {  // מ„קבלות לסוף החודש”: רק הטיפולים של החודש שנבחר
    const ids = new Set(onlyIds);
    groups = Object.fromEntries(Object.entries(groups).map(([n, g]) => [n, g.filter(e => ids.has(e.id))]).filter(([, g]) => g.length));
  }
  const names = Object.keys(groups).sort((a, b) => a.localeCompare(b, 'he'));
  if (!names.length) { alertSheet('קבלות ב-Morning', 'אין טיפולים ששולמו וטרם הוצאה להם קבלה.'); return; }
  if (client && !groups[client] && !ev) { alertSheet('קבלות ב-Morning', `ל${client} אין טיפולים ששולמו וטרם הוצאה להם קבלה.`); return; }
  let name = ev ? title(ev).trim() : (client && groups[client] ? client : names[0]);
  if (!groups[name]) { alertSheet('קבלות ב-Morning', 'אין לפגישה הזו תשלום בלי קבלה.'); return; }
  const m = morningCfg();
  const pre = preIds ? new Set(preIds) : ev ? new Set(groups[name].filter(e => evTimes(e).s.getMonth() === evTimes(ev).s.getMonth() && evTimes(e).s.getFullYear() === evTimes(ev).s.getFullYear()).map(e => e.id).concat([ev.id])) : null;
  const sh = openSheet(`<h3 style="margin:4px 0 6px">הפקת חשבונית מס/קבלה ב-Morning</h3>
    ${m.env === 'sandbox' ? '<p class="note" style="background:#FFF1D6;color:#7A4B00;padding:6px 8px;border-radius:8px">סביבת בדיקות: המסמך לא יהיה אמיתי. (אפשר לעבור לפעיל בתפריט ☰ ← Morning)</p>' : ''}
    <div class="field"><label>מטופל/ת</label><select id="miClient">${names.map(n => `<option ${n === name ? 'selected' : ''} value="${esc(n)}">${esc(n)} (${groups[n].length} טיפולים בלי קבלה)</option>`).join('')}</select></div>
    <div class="sec">הטיפולים שייכללו בקבלה (אפשר כמה – קבלה אחת על כולם):</div><div id="miList"></div>
    <div class="field"><label>איש קשר ב-Morning</label><div class="two"><select id="miContact" style="flex:3"></select><button class="btn" id="miFind" style="flex:1">🔎 חיפוש</button></div><p class="note" id="miCInfo" style="margin:4px 0 0"></p></div>
    <div class="field"><label>שם על הקבלה</label><input type="text" id="miName"></div>
    <div class="field"><label class="check"><input type="checkbox" id="miSend" ${m.send_email ? 'checked' : ''}>לשלוח את הקבלה במייל ל:</label><input type="email" dir="ltr" id="miEmails"></div>
    <div class="field"><label>תיאור השירות</label><input type="text" id="miItem" value="${esc(m.item)}"></div>
    <div class="field"><label>טקסט קבוע</label><textarea id="miRemarks" rows="3"></textarea></div>
    <div class="field"><label>תאריך המסמך</label><input type="date" id="miDate" value="${docDate || isoDate(today())}"></div>
    <p class="totals" id="miSum" style="padding:0"></p><p class="err" id="miErr"></p>
    <div class="actions"><button class="btn primary" id="miGo">הפקה ב-Morning</button><button class="btn" id="miCancel">ביטול</button></div>`);
  let touched = false, itemTouched = false;
  $('#miRemarks', sh).oninput = () => { touched = true; };
  $('#miItem', sh).oninput = () => { itemTouched = true; };
  const chosen = () => [...sh.querySelectorAll('[data-mi]:checked')].map(i => groups[name][Number(i.dataset.mi)]);
  const upd = () => {
    const ss = chosen(), total = ss.reduce((a, e) => a + (sessionAmount(e) || 0), 0), by = {};
    for (const e of ss) by[payLabel(e) || 'לא צוין'] = (by[payLabel(e) || 'לא צוין'] || 0) + (sessionAmount(e) || 0);
    if (!touched) $('#miRemarks', sh).value = ss.length ? renderReceiptText(m.template, ss, name) : '';
    if (!itemTouched) $('#miItem', sh).value = renderItem(m.item, ss);
    $('#miSum', sh).textContent = ss.length ? `${ss.length} טיפולים · סה״כ ${fmtMoney(total)} · תשלום: ${Object.entries(by).map(([k, v]) => k + ' ' + fmtMoney(v)).join(', ')}` : 'לא נבחרו טיפולים.';
  };
  let contacts = {};
  const setContacts = (list, selId) => {
    contacts = Object.fromEntries(list.map(c => [c.id, c]));
    $('#miContact', sh).innerHTML = '<option value="">בלי – פרטים חד-פעמיים על הקבלה</option>' + list.map(c => `<option value="${esc(c.id)}" ${c.id === selId ? 'selected' : ''}>${esc(c.name)}${c.emails.length ? ' (' + esc(c.emails.join(', ')) + ')' : ''}</option>`).join('');
    if (selId) contactChosen();
  };
  const contactChosen = () => {
    const c = contacts[$('#miContact', sh).value]; if (!c) return;
    $('#miName', sh).value = c.name; if (c.emails.length) $('#miEmails', sh).value = c.emails.join(', ');
    $('#miCInfo', sh).textContent = 'הקבלה תירשם על איש הקשר הזה ב-Morning (לא ייווצר איש קשר חדש).' + (c.emails.length ? ' המייל שלו נלקח מ-Morning.' : '');
  };
  const search = async (text, auto = false, payer = '') => {
    text = (text || '').trim(); if (!text) return;
    const forName = name; $('#miCInfo', sh).textContent = 'מחפש אנשי קשר ב-Morning…';
    try {
      const [best, found] = auto ? await findMorningContact(m.env, text, payer) : [null, await morningSearchClients(m.env, text)];
      if (forName !== name || !$('#miContact', sh)) return;
      const keep = $('#miContact', sh).value, merged = Object.values(contacts).concat(found.filter(c => !contacts[c.id]));
      const pick = keep || (auto ? (best || {}).id : null);
      setContacts(merged, pick);
      $('#miCInfo', sh).textContent = (found.length ? `נמצאו ${found.length} אנשי קשר. ` : 'לא נמצא איש קשר בשם הזה ב-Morning. ') + (auto && pick && best && pick === best.id ? (normName(best.name) === normName(text) ? '✓ נבחר לפי שם המטופל/ת.' : `✓ נבחר לפי שם המשלם (לא נמצא איש קשר על שם ${text}).`) : 'אפשר לבחור מהרשימה.');
    } catch (e) { $('#miCInfo', sh).textContent = 'החיפוש ב-Morning נכשל: ' + e.message; }
  };
  $('#miContact', sh).onchange = contactChosen;
  $('#miFind', sh).onclick = () => search($('#miName', sh).value);
  const fill = () => {
    const ss = groups[name], sel = pre && name === title(ev || {}).trim() ? pre : new Set(ss.map(e => e.id));
    $('#miList', sh).innerHTML = ss.map((e, i) => `<label class="radio"><input type="checkbox" data-mi="${i}" ${sel.has(e.id) ? 'checked' : ''}>${sessionLine(e)}</label>`).join('');
    sh.querySelectorAll('[data-mi]').forEach(i => i.onchange = upd);
    const payer = (ss.map(e => props(e).pay_payer).find(Boolean)) || '';
    $('#miName', sh).value = name || payer;  // שם הילד/ה הוא העיקר
    $('#miEmails', sh).value = clientEmails(name).join(', ');
    setContacts([], null); $('#miCInfo', sh).textContent = '';
    const linked = clientInfo(name).morning_client;
    if (linked && linked.id) { setContacts([{ ...linked, emails: linked.emails || [] }], linked.id); $('#miCInfo', sh).textContent = '✓ מקושר לאיש הקשר הזה מקבלה קודמת.'; }
    else search(name, true, payer);
    upd();
  };
  $('#miClient', sh).onchange = e => { name = e.target.value; touched = false; fill(); };
  fill();
  $('#miCancel', sh).onclick = () => { if (onBack) onBack(); else if (ev) showDetails(ev); else closeSheet(); };
  $('#miGo', sh).onclick = async () => {
    const ss = chosen(), err = t => { $('#miErr', sh).textContent = t; };
    if (!ss.length) return err('יש לבחור לפחות טיפול אחד.');
    const miss = ss.find(e => !sessionAmount(e));
    if (miss) return err(`לטיפול ב-${dmy(evTimes(miss).s)} אין סכום. מוסיפים סכום בסימון התשלום או קובעים מחיר.`);
    const [emails, bad] = parseEmails($('#miEmails', sh).value);
    if (bad.length) return err(`המייל לא תקין: ${bad.join(', ')}`);
    const payer = $('#miName', sh).value.trim(); if (!payer) return err('יש למלא שם על הקבלה.');
    const total = ss.reduce((a, e) => a + sessionAmount(e), 0), date = $('#miDate', sh).value;
    const remarks = $('#miRemarks', sh).value.trim(), item = $('#miItem', sh).value.trim() || m.item, send = $('#miSend', sh).checked, cid = $('#miContact', sh).value;
    const real = m.env === 'production';
    const ok = await choose('הפקת קבלה', `להפיק חשבונית מס/קבלה על ${ss.length} טיפולים, סה״כ ${fmtMoney(total)}, על שם „${payer}”?` + (real ? '\n\nזה מסמך רשמי: אחרי ההפקה אי אפשר למחוק אותו, רק לבטל במסמך זיכוי.' : '\n\n(סביבת בדיקות)'), [{ label: 'כן, להפיק', value: true, cls: 'primary' }]);
    if (!ok) { showMorningIssue({ ev, client: name, extra, preIds, docDate, onlyIds, onBack }); return; }
    busy(true); progressSheet('מפיק קבלה ב-Morning…');
    try {
      const contact = contacts[cid] || null;
      const body = morningDocument(ss, { name: payer, emails, send, item, remarks, date, vatIncluded: m.vat_included, clientId: contact ? contact.id : null });
      const res = await morningCreate(m.env, body);
      const url = res.url || {};
      const ch = { rcpt_issued: 'yes', rcpt_no: String(res.number || ''), rcpt_date: date, rcpt_doc: String(res.id || ''), rcpt_url: typeof url === 'object' ? (url.he || url.origin || '') : String(url), rcpt_src: 'morning', rcpt_count: ss.length > 1 ? String(ss.length) : '' };
      for (const e of ss) await setStatus(e, ch);
      try { await linkMorningContact(name, contact); } catch { /* לא קריטי */ }
      const phone = clientPhone(name);
      if (m.send_whatsapp !== false && phone) {
        const text = receiptWaText(ss, name, ch.rcpt_no, ch.rcpt_url, item), wa = whatsappUrl(phone, text);
        // הדפדפן לא מאפשר לפתוח אפליקציה אחרת בלי לחיצה – לכן לחיצה אחת על „שליחה בוואטסאפ”
        const sh2 = openSheet(`<h3 style="margin:4px 0 6px">✓ הופקה חשבונית מס/קבלה ${esc(ch.rcpt_no)}</h3><p>על ${ss.length} טיפולים של ${esc(name)}.</p>
          <div class="note" style="white-space:pre-wrap;background:#F7FAF9;border:1px solid var(--line2);border-radius:10px;padding:8px">${esc(text)}</div>
          <div class="actions"><a class="btn primary" id="rcWa" href="${esc(wa)}" target="_blank" rel="noopener">💬 שליחה בוואטסאפ להורה</a><button class="btn" id="rcCopy">📋 העתקה</button></div>
          <div class="actions"><button class="btn" id="rcClose">סגירה</button></div>`);
        $('#rcWa', sh2).onclick = () => setTimeout(closeSheet, 300);
        $('#rcCopy', sh2).onclick = async () => { try { await navigator.clipboard.writeText(text); $('#rcCopy', sh2).textContent = '✓ הועתק'; } catch { toast('לא הצלחתי להעתיק'); } };
        $('#rcClose', sh2).onclick = () => (onBack ? onBack() : closeSheet());
      } else alertSheet('Morning', `✓ הופקה חשבונית מס/קבלה ${ch.rcpt_no} על ${ss.length} טיפולים.` + (phone || m.send_whatsapp === false ? '' : '\n\nכדי שהקבלה תישלח גם בוואטסאפ, מוסיפים טלפון הורה (☰ ← מטופלים).'), onBack);
    } catch (e) { alertSheet('ההפקה נכשלה', (e && e.message) || String(e), () => showMorningIssue({ ev, client: name, extra, preIds, docDate, onlyIds, onBack })); }
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
      <input type="tel" dir="ltr" data-ppi="${i}" placeholder="טלפון הורה (לוואטסאפ: קבלות, תזכורות)" value="${esc(c.parent_phone || '')}" style="margin-top:6px;width:100%;box-sizing:border-box">
      <input type="tel" dir="ltr" data-phi="${i}" placeholder="טלפון של המטופל/ת (לא חובה)" value="${esc(c.phone || '')}" style="margin-top:6px;width:100%;box-sizing:border-box">
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
      const parentPhone = sh.querySelector(`[data-ppi="${i}"]`).value.trim();
      const phone = sh.querySelector(`[data-phi="${i}"]`).value.trim(), remind = sh.querySelector(`[data-ri="${i}"]`).checked;
      const quota = sh.querySelector(`[data-qi="${i}"]`).value.trim(), qfrom = sh.querySelector(`[data-qf="${i}"]`).value;
      if (remind && !emails.length) return err(`כדי לשלוח תזכורת ל${n} צריך מייל.`);
      if (quota && !(parseInt(quota, 10) > 0)) return err(`מכסת המפגשים של ${n} צריכה להיות מספר שלם.`);
      delete old.price; delete old.emails; delete old.invite; delete old.payers;
      delete old.phone; delete old.remind; delete old.quota; delete old.quota_from; delete old.parent_phone;
      const info = { ...old };
      if (phone) info.phone = phone;
      if (parentPhone) info.parent_phone = parentPhone;
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
function showAI(initialQ = '') {
  if (!DEMO && !store.get('geminiKey', '')) { askGeminiKey(() => showAI(initialQ)); return; }
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
  if (initialQ) ask(initialQ);
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
    <div class="two"><div class="field"><label>סכום (₪)</label><input type="text" inputmode="decimal" id="payAmt" dir="ltr" placeholder="לא חובה" value="${esc(p.pay_amount || (evPrice(ev) ? String(evPrice(ev)) : ''))}"></div>
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
      if (feat('morning') && morningReady() && !chosen.some(receiptIssued)) {
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
  let rem = 0;  // ברירת מחדל: בלי תזכורת (זהה ל-Windows)
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
    <div class="field" ${isEv ? 'hidden' : ''} id="fPhoneBox"><label>טלפון הורה <span class="note">(לקבלות ולתזכורות בוואטסאפ)</span></label><input type="tel" dir="ltr" id="fPhone" placeholder="050-1234567"></div>
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
  let inviteFor = null, phoneTouched = false;
  $('#fPhone', sh).oninput = () => { phoneTouched = true; };
  const prefill = () => {
    if (isEv) return;
    const name = fn.value.trim(), known = name in (S.settings.clients || {}), pr = clientPrice(name);
    if (!phoneTouched) $('#fPhone', sh).value = name ? clientPhone(name) : '';
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
  if (wait && wait.phone) { $('#fPhone', sh).value = wait.phone; phoneTouched = true; }
  const wk = $('#fWeekly', sh), cnt = $('#fCount', sh);
  if (wk && mode !== 'series') wk.onchange = () => { cnt.disabled = !wk.checked; };
  let remTouched = false, cntTouched = false;
  $('#fRem', sh).onchange = () => { remTouched = true; };
  if (cnt) cnt.addEventListener('change', () => { cntTouched = true; });
  $('#fCancel', sh).onclick = () => { if (editing) showDetails(ev); else closeSheet(); };
  $('#fSave', sh).onclick = async () => {
    const name = $('#fName', sh).value.trim(), phone = isEv ? '' : $('#fPhone', sh).value.trim();
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
        if (phone && phone !== clientPhone(name)) info.parent_phone = phone;
        const wl = (S.settings.waitlist || []).filter(x => !wait || x.id !== wait.id);
        const st = { ...S.settings, waitlist: wl, locations: [...(S.settings.locations || [])], clients: { ...(S.settings.clients || {}), [name]: info } };
        const newLoc = addLocation(st, body.location);
        if (JSON.stringify(info) !== before || wl.length !== (S.settings.waitlist || []).length || newLoc) saveSettings(st);
        if (invite) toast(`נוספה פגישה: ${name} · נשלח זימון`);
      } else if (!isEv && phoneTouched) saveClientPhone(name, phone);
      changed();
    } catch (err) { if (btn) { btn.disabled = false; btn.textContent = editing ? 'שמירה' : 'הוספה'; } handleErr(err); }
    finally { if (!btn) busy(false); }
  };
}

async function saveClientPhone(name, phone) {
  // טלפון ההורה של המטופל/ת (לוואטסאפ: קבלות, תזכורות) – זהה ל-Windows
  name = (name || '').trim(); phone = (phone || '').trim();
  if (!name || phone === clientPhone(name)) return;
  const st = JSON.parse(JSON.stringify(S.settings)); st.clients = st.clients || {};
  const info = st.clients[name] = st.clients[name] || {};
  if (phone) info.parent_phone = phone; else { delete info.parent_phone; delete info.phone; }
  await saveSettings(st);
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
    <h3 style="margin:18px 0 4px">הגדרות</h3>
    <div class="menu-item"><span style="flex:1">תכונות: מה להציג</span><button class="btn" id="mFeat">בחירה</button></div>
    <div class="menu-item"><span style="flex:1">מטופלים: מחירים ומיילים</span><button class="btn" id="mPrices">עריכה</button></div>
    ${feat('exercises') ? '<div class="menu-item"><span style="flex:1">ספריית תרגילים לבית</span><button class="btn" id="mEx">עריכה</button></div>' : ''}
    ${feat('intake') ? '<div class="menu-item"><span style="flex:1">טופס קליטה להורים</span><button class="btn" id="mIntake">קישור</button></div>' : ''}
    <div class="menu-item"><span style="flex:1">ימים שמוצגים ביומן</span><button class="btn" id="mWeekDays">בחירה</button></div>
    <div class="menu-item"><span style="flex:1">מקומות טיפול${(S.settings.locations || []).length ? ` (${S.settings.locations.length})` : ''}</span><button class="btn" id="mLocs">עריכה</button></div>
    ${feat('reminders') || feat('debts') ? `<div class="menu-item"><span style="flex:1">תזכורות למטופלים ותזכורת תשלום ${(S.settings.reminders || {}).enabled ? '✓' : ''}</span><button class="btn" id="mRemind">הגדרה</button></div>` : ''}
    <div class="menu-item" ${feat('quickmark') ? '' : 'style="display:none"'}><label class="check" style="flex:1"><input type="checkbox" id="mDay" ${store.get('daySummary', true) !== false ? 'checked' : ''}>חלון סימון בסוף היום</label>
      <select id="mDayHour" style="flex:none;width:auto">${Array.from({ length: 12 }, (_, i) => i + 12).map(h => `<option value="${h}" ${+store.get('daySummaryHour', DAY_SUMMARY_HOUR) === h ? 'selected' : ''}>${pad(h)}:00</option>`).join('')}</select></div>
    <div class="menu-item"><span style="flex:1">גיבוי</span><button class="btn" id="mBackup">גיבוי עכשיו</button></div>
    <div class="menu-item"><span style="flex:1">קובץ גיבוי</span><button class="btn" id="mExport">ייצוא</button><button class="btn" id="mRestore">שחזור</button></div>
    <label class="check"><input type="checkbox" id="mEmail" ${S.settings.backup_email !== false ? 'checked' : ''}>שליחת הגיבוי היומי למייל</label>
    <div class="menu-item"><label class="check" style="flex:1"><input type="checkbox" id="mHol" ${S.settings.holidays !== false ? 'checked' : ''}>חגי ישראל ביומן</label><button class="btn" id="mHolRefresh">רענון</button></div>
    ${feat('morning') || feat('expenses') ? `<div class="menu-item"><span style="flex:1">Morning – קבלות ${morningReady() ? '✓' : ''}</span><button class="btn" id="mMorning">הגדרה</button></div>` : ''}
    ${feat('expenses') ? '<div class="menu-item"><span style="flex:1">הוספת הוצאה ל-Morning</span><button class="btn primary" id="mExpense">📤 העלאה</button></div>' : ''}
    <div class="menu-item"><span style="flex:1">שיתוף מוואטסאפ / מייל לאפליקציה</span><span class="note">${'serviceWorker' in navigator && navigator.serviceWorker.controller ? '✓ מוכן' : '⏳ עוד לא מוכן – סוגרים ופותחים את האפליקציה'}</span></div>
    <h3 style="margin:18px 0 4px">צילומי תשלום</h3>
    <div class="menu-item"><span style="flex:1">מפתח Gemini: ${store.get('geminiKey', '') ? '✓ מוגדר' : 'לא מוגדר'}</span><button class="btn" id="gKeyBtn">${store.get('geminiKey', '') ? 'החלפה' : 'הגדרה'}</button></div>
    ${feat('usage') ? `<div class="menu-item"><span style="flex:1">שימוש ב-Gemini החודש: כ-${fmtMoney(usageMonth().ils) || '₪0'}${toAmount(S.settings.ai_budget) ? ' מתוך ' + fmtMoney(toAmount(S.settings.ai_budget)) : ''}</span><button class="btn" id="mUsage">פרטים</button></div>` : ''}
    <h3 style="margin:18px 0 4px">חשבון</h3>
    <div class="menu-item"><span style="flex:1" dir="ltr">${esc(S.email || '')}</span></div>
    <div class="actions"><button class="btn danger" id="soBtn">התנתקות</button><button class="btn" id="mClose">סגירה</button></div>
    <p class="note" style="margin-top:14px">כל הנתונים נשמרים ב-Google Calendar, ולכן הם זהים בטלפון ובמחשב.</p>
    <p class="note">גרסה ${APP_VERSION}</p>`);
  sh.querySelectorAll('input[name=cal]').forEach(r => r.onchange = () => { S.calId = r.value; store.set('calId', r.value); closeSheet(); S.loaded = false; renderView(); loadEvents(); });
  $('#soBtn', sh).onclick = signOut;
  $('#gKeyBtn', sh).onclick = () => askGeminiKey(null);
  $('#mPrices', sh).onclick = showPrices;
  const onc = (id, fn) => { const b = $(id, sh); if (b) b.onclick = fn; };
  onc('#mRemind', showReminders); onc('#mWeekDays', showWeekDays); onc('#mEx', () => showExercises()); onc('#mIntake', showIntake); onc('#mFeat', showFeatures); onc('#mUsage', showUsage);
  $('#mLocs', sh).onclick = showLocations;
  $('#mDay', sh).onchange = e => store.set('daySummary', e.target.checked);
  $('#mDayHour', sh).onchange = e => { store.set('daySummaryHour', +e.target.value); store.set('daySummaryShown', ''); };
  onc('#mMorning', () => showMorningSettings(null));
  onc('#mExpense', () => showExpenses());
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
  setInterval(() => { if (document.visibilityState === 'visible') refreshAlerts(); }, 3 * 60 * 60 * 1000);
  setInterval(() => { if (document.visibilityState === 'visible') importIntake(); }, 10 * 60 * 1000);
  setInterval(() => { if (S.view === 'day' || S.view === 'week') { const nl = $('.nowline'); if (nl) { renderView.keepScroll = true; renderView(); } } }, 60 * 1000);
  if ('serviceWorker' in navigator && !DEMO && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(r => r.update()).catch(() => {});
  }
  render();
}
init();
