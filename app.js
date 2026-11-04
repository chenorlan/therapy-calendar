/* יומן הטיפולים – גרסת אנדרואיד (אפליקציית רשת).
   כל הנתונים נשמרים ב-Google Calendar, באותם שדות שאפליקציית Windows משתמשת בהם,
   ולכן שתי האפליקציות מסונכרנות. */
'use strict';

// ------------------------------------------------------------------ קבועים
const SCOPES = 'https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/gmail.send';
const SCOPE_LIST = SCOPES.split(' ');
const PAY_KEYS = ['paid', 'pay_method', 'pay_note', 'pay_amount', 'pay_total', 'pay_date', 'pay_ref', 'pay_payer', 'pay_receipt'];
const RECEIPTS_FOLDER = 'יומן הטיפולים – אישורי תשלום';
const CANCEL_KEYS = ['cancel_reason', 'cancel_note'];
const RCPT_KEYS = ['rcpt_issued', 'rcpt_no', 'rcpt_date'];
const APP_KEYS = ['attended', ...PAY_KEYS, ...CANCEL_KEYS, ...RCPT_KEYS, 'price'];  // זהה ל-Windows
const CANCEL_REASONS = [['client', 'ביטול של המטופל/ת'], ['sick', 'מחלה'], ['me', 'ביטול שלי'], ['holiday', 'חג / חופשה'], ['noshow', 'לא הגיע/ה בלי הודעה'], ['other', 'אחר']];
const APP_FOLDER = 'יומן הטיפולים', BACKUPS_FOLDER = 'גיבויים', SETTINGS_FILE = 'הגדרות.json', BACKUP_KEEP = 30;
const DEFAULT_SETTINGS = { version: 1, default_price: 0, clients: {}, backup_email: true };
const GEMINI_MODELS = ['gemini-flash-latest', 'gemini-2.5-flash'];
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
  insert: (c, body) => api('POST', `/calendars/${enc(c)}/events`, body),
  patch: (c, id, body) => api('PATCH', `/calendars/${enc(c)}/events/${enc(id)}`, body),
  del: (c, id) => api('DELETE', `/calendars/${enc(c)}/events/${enc(id)}`),
  async setProps(c, id, p, attach = null, detach = null) {
    const body = { extendedProperties: { private: p } };
    let q = '';
    if (attach || detach) {
      const cur = await G.get(c, id);
      const atts = (cur.attachments || []).filter(a => a.fileId !== detach && a.fileId !== (attach && attach.id));
      if (attach) atts.push({ fileUrl: attach.webViewLink || `https://drive.google.com/file/d/${attach.id}/view`, title: attach.name || 'אישור תשלום', mimeType: attach.mimeType || 'image/jpeg', fileId: attach.id });
      body.attachments = atts; q = 'supportsAttachments=true';
    }
    await api('PATCH', `/calendars/${enc(c)}/events/${enc(id)}`, body, q);
    const fresh = await G.get(c, id);
    const stored = (fresh.extendedProperties && fresh.extendedProperties.private) || {};
    if (Object.entries(p).some(([k, v]) => v && stored[k] !== v)) throw new Error('Google קיבל את הבקשה אבל לא שמר את הסימון.');
    return fresh;
  },
  async updateSeries(c, masterId, body, tz) {
    const m = await G.get(c, masterId);
    const ms = m.start || {};
    const mdate = ms.dateTime ? new Date(ms.dateTime) : parseDateOnly(ms.date);
    body = { ...body };
    if (body.extendedProperties) body.extendedProperties = { private: { ...((m.extendedProperties || {}).private || {}), ...body.extendedProperties.private } };
    if (body.start) {
      const ns = new Date(body.start.dateTime), ne = new Date(body.end.dateTime);
      const st = new Date(mdate.getFullYear(), mdate.getMonth(), mdate.getDate(), ns.getHours(), ns.getMinutes());
      const en = new Date(st.getTime() + (ne - ns));
      body.start = { dateTime: localStr(st), timeZone: tz };
      body.end = { dateTime: localStr(en), timeZone: tz };
    }
    return G.patch(c, masterId, body);
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
  for (const model of GEMINI_MODELS) {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      { method: 'POST', headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (r.status === 404) continue;
    let j = {}; try { j = await r.json(); } catch { /* ignore */ }
    if (r.status === 401 || r.status === 403) throw new Error('מפתח Gemini לא תקין או שאין לו הרשאה. אפשר להחליף אותו בתפריט ☰.');
    if (r.status === 429) throw new Error('הגעת למגבלת השימוש של Gemini. בודקים שהחיוב מופעל ב-AI Studio ומנסים שוב בעוד דקה.');
    if (!r.ok) throw new Error(`שגיאה מ-Gemini (${r.status}). ${(j.error && j.error.message) || ''}`);
    try { return j.candidates[0].content.parts.map(x => x.text || '').join(''); } catch { throw new Error('Gemini לא החזיר תשובה.'); }
  }
  throw new Error('לא נמצא מודל Gemini זמין.');
}
const AI_SYSTEM = `את/ה עוזר/ת אישי/ת של קלינאית תקשורת עצמאית, ועונה על שאלות על היסטוריית הטיפולים שלה.
הנתונים שקיבלת הם רשימת הפגישות מהיומן שלה, בפורמט טבלה. ענה/י תמיד בעברית, בקצרה ובבהירות.
- הסתמך/י רק על הנתונים. אם אין מספיק מידע, אמור/י זאת.
- חשב/י מספרים וסכומים בדיוק, ובדוק/י את החישוב.
- "חוב" או "לא שולם" = פגישה שהתקיימה ולא שולמה; סכום החוב לפי עמודת המחיר.
- פגישות "טרם סומן" בעבר הן פגישות שלא סומנו; פגישות עתידיות עוד לא התקיימו.
- כשמתאים, הצג/י טבלה קצרה או רשימה. אל תמציא/י מטופלים או פגישות.`;
function eventsTable(evs) {
  const rows = ['תאריך | יום | שעה | מטופל/ת | הפגישה | סיבת ביטול | מחיר | תשלום | אמצעי | סכום ששולם | תאריך תשלום | קבלה'];
  for (const ev of evs.slice().sort((a, b) => evTimes(a).s - evTimes(b).s)) {
    const t = evTimes(ev); if (t.allDay) continue;
    const p = props(ev), pd = paid(ev), pr = evPrice(ev);
    rows.push([isoDate(t.s), DAYS[t.s.getDay()], hm(t.s), title(ev).trim(), ({ yes: 'התקיימה', no: 'לא התקיימה' })[attended(ev)] || 'טרם סומן',
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
  for (const model of GEMINI_MODELS) {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      { method: 'POST', headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (r.status === 404) continue;
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
  throw new Error('לא נמצא מודל Gemini זמין.');
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
  for (const ev of events) { if (evTimes(ev).allDay || !canEdit(ev)) continue; (by[title(ev).trim()] = by[title(ev).trim()] || []).push(ev); }
  return Object.entries(by).map(([name, evs]) => {
    let score = name && srcText.includes(name) ? 5 : 0;
    for (const t of tokens(name)) if (src.has(t)) score += 2;
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

async function handleErr(e) {
  if (e instanceof NeedLogin) { showLoginBanner(); return; }
  alertSheet('משהו השתבש', e.message || String(e));
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
    startReceipt(blob);
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
    ${S.needConsent ? '<p class="card" style="text-align:right">בעדכון האחרון נוספו הרשאות חדשות (שמירת צילומים וגיבויים ב-Google Drive ושליחת הגיבוי היומי למייל). לכן צריך להתחבר שוב פעם אחת ולסמן את <b>כל</b> התיבות במסך ההרשאות.</p>' : ''}
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
  days.forEach(d => { head += `<div class="${sameDay(d, td) ? 'today' : ''}" data-day="${isoDate(d)}">${week ? DAYS_S[d.getDay()] : DAYS[d.getDay()]}<span class="num">${d.getDate()}</span></div>`; });
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
        <b>${esc(title(ev))}</b><div class="t">${hm(t.s)}${week ? '' : '–' + hm(t.e)}</div>${showTags ? tagsHtml(ev, week) : ''}</div>`;
    }
    if (sameDay(d, now) && now.getHours() >= sh && now.getHours() < eh) inner += `<div class="nowline" style="top:${(mins(now) - sh * 60) * H / 60 + 5}px"></div>`;
    colsHtml += `<div class="tg-col${sameDay(d, td) ? ' today' : ''}" data-col="${isoDate(d)}" data-sh="${sh}" data-h="${H}" style="height:${height}px">${inner}</div>`;
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
    h += `<div class="mo-cell${d.getMonth() !== m ? ' out' : ''}${sameDay(d, td) ? ' today' : ''}" data-day="${isoDate(d)}"><div class="d"><span>${d.getDate()}</span></div>`;
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
    h += `<div class="day-h${sameDay(d, td) ? ' today' : ''}">יום ${DAYS[d.getDay()]}, ${hebDate(d)}</div>`;
    for (const ev of evs) {
      const t = evTimes(ev);
      h += `<div class="li${attended(ev) === 'no' ? ' missed' : ''}" data-id="${esc(ev.id)}"><div class="bar" style="background:${evColor(ev)}"></div><div class="main">
        <div class="nm">${esc(title(ev))}</div>
        <div class="t">${t.allDay ? 'כל היום' : hm(t.s) + '–' + hm(t.e)}</div>
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
    if (evTimes(ev).allDay) continue;
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
  const names = [...new Set(S.events.filter(e => !evTimes(e).allDay).map(e => title(e).trim()))].sort((a, b) => a.localeCompare(b, 'he'));
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
        <div class="${a === 'yes' ? 'c-ok' : a === 'no' ? 'c-no' : 'c-gray'}">${attText(ev)}</div>
        <div class="${paid(ev) ? 'c-ok' : a === 'yes' ? 'c-no' : 'c-gray'}">${payText(ev)}${paid(ev) && payLabel(ev) ? ' · ' + esc(payLabel(ev)) : ''}${paid(ev) && payAmount(ev) ? ' · ' + fmtMoney(payAmount(ev)) : ''}${paid(ev) && props(ev).pay_receipt ? ' 📎' : ''}${paid(ev) ? (receiptIssued(ev) ? ' · 🧾' : ' · <span class="c-no">ללא קבלה</span>') : ''}</div>
      </div>`;
    }
    h += '</div>';
  }
  h += `<div class="sum-actions no-print"><button class="btn" id="csvBtn">ייצוא לאקסל</button><button class="btn primary" id="pdfBtn">שמירה כ-PDF</button></div>
    <p class="note no-print" style="padding:0 14px">לחיצה על פגישה פותחת אותה לסימון או לתיקון.</p>`;
  return h;
}
async function exportCsv() {
  const rows = [['מטופל/ת', 'תאריך', 'יום', 'התחלה', 'סיום', 'הפגישה', 'תשלום', 'אמצעי תשלום', 'סכום', 'תאריך תשלום', 'אסמכתא', 'שם המשלם', 'צילום', 'מחיר', 'סיבת ביטול', 'קבלה', 'מספר קבלה']];
  for (const [name, evs] of summaryGroups()) for (const ev of evs) {
    const t = evTimes(ev);
    const p = props(ev), pd = paid(ev);
    rows.push([name, dmy(t.s), DAYS[t.s.getDay()], hm(t.s), hm(t.e), attText(ev), payText(ev), pd ? payLabel(ev) : '',
      pd ? (p.pay_amount || '') : '', pd && p.pay_date ? dmy(parseDateOnly(p.pay_date)) : '', pd ? (p.pay_ref || '') : '', pd ? (p.pay_payer || '') : '',
      pd && p.pay_receipt ? `https://drive.google.com/file/d/${p.pay_receipt}/view` : '',
      evPrice(ev) ? String(evPrice(ev)) : '', attended(ev) === 'no' ? cancelLabel(ev) : '', receiptIssued(ev) ? 'הוצאה' : '', p.rcpt_no || '']);
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
    showForm({ start: d });
  }));
  main.querySelectorAll('.tg-head [data-day]').forEach(el => el.addEventListener('click', () => { if (S.view === 'week') goDay(parseDateOnly(el.dataset.day)); }));
  main.querySelectorAll('.mo-cell').forEach(el => el.addEventListener('click', () => goDay(parseDateOnly(el.dataset.day))));
  const sc = $('#sumClient'); if (sc) sc.onchange = () => { S.sumClient = sc.value; renderView(); };
  const sf = $('#sumFilter'); if (sf) sf.onchange = () => { S.sumFilter = sf.value; renderView(); };
  const cb = $('#csvBtn'); if (cb) cb.onclick = exportCsv;
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
function closeSheet() { $('#sheet').hidden = true; $('#sheetBack').hidden = true; $('#sheet').innerHTML = ''; }
function alertSheet(t, msg) {
  const sh = openSheet(`<h3 style="margin:4px 0 8px">${esc(t)}</h3><p>${esc(msg)}</p><div class="actions"><button class="btn primary" id="okBtn">אישור</button></div>`);
  $('#okBtn', sh).onclick = closeSheet;
}
function choose(t, msg, options) {
  return new Promise(resolve => {
    const sh = openSheet(`<h3 style="margin:4px 0 8px">${esc(t)}</h3>${msg ? `<p>${esc(msg)}</p>` : ''}
      <div class="actions" style="flex-direction:column">${options.map((o, i) => `<button class="btn ${o.cls || ''}" data-i="${i}">${esc(o.label)}</button>`).join('')}
      <button class="btn" data-i="-1">ביטול</button></div>`);
    sh.querySelectorAll('[data-i]').forEach(b => b.onclick = () => { const i = Number(b.dataset.i); closeSheet(); resolve(i < 0 ? null : options[i].value); });
  });
}
let toastTimer;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => t.hidden = true, 3200); }

// ---- פרטי פגישה
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
    ${t.allDay ? '' : `<div class="k">מחיר</div><div>${evPrice(ev) ? fmtMoney(evPrice(ev)) + (toAmount(props(ev).price) ? '' : ' <span class="note">(ברירת מחדל)</span>') : '<span class="note">לא נקבע (אפשר לקבוע ב„עריכה” או ב-☰ ← מחירי טיפול)</span>'}</div>`}</div>`;
  if (!t.allDay) {
    h += `<div class="sec">הפגישה</div><div class="seg">
        <button class="btn ${a === '' ? 'on' : ''}" data-att="" ${dis}>טרם סומן</button>
        <button class="btn ${a === 'yes' ? 'on' : ''}" data-att="yes" ${dis}>✓ התקיימה</button>
        <button class="btn ${a === 'no' ? 'on' : ''}" data-att="no" ${dis}>✗ לא התקיימה</button></div>
      ${a === 'no' && cancelLabel(ev) ? `<p class="note" style="margin-top:-4px">סיבה: ${esc(cancelLabel(ev))}</p>` : ''}
      <div class="sec">תשלום</div><div class="seg">
        <button class="btn ${!paid(ev) ? 'on' : ''}" id="unpaidBtn" ${dis}>לא שולמה</button>
        <button class="btn ${paid(ev) ? 'on' : ''}" id="paidBtn" ${dis}>₪ שולמה${paid(ev) && payLabel(ev) ? ' · ' + esc(payLabel(ev)) : '…'}</button></div>
      ${paid(ev) && payDetails(ev) ? `<p class="note" style="margin-top:-4px">${esc(payDetails(ev))}</p>` : ''}
      ${paid(ev) && props(ev).pay_receipt ? '<button class="btn" id="rcptBtn" style="width:100%;margin-bottom:8px">📎 צפייה באישור התשלום</button>' : ''}
      <div class="sec">קבלה</div><div class="seg">
        <button class="btn ${!receiptIssued(ev) ? 'on' : ''}" id="rcNo" ${dis}>לא הוצאה</button>
        <button class="btn ${receiptIssued(ev) ? 'on' : ''}" id="rcYes" ${dis}>🧾 הוצאה קבלה${receiptIssued(ev) ? '' : '…'}</button></div>
      ${receiptIssued(ev) && (props(ev).rcpt_no || props(ev).rcpt_date) ? `<p class="note" style="margin-top:-4px">${[props(ev).rcpt_no ? 'מספר ' + esc(props(ev).rcpt_no) : '', props(ev).rcpt_date ? dmy(parseDateOnly(props(ev).rcpt_date)) : ''].filter(Boolean).join(' · ')}</p>` : ''}
      <p class="note">הסימונים נשמרים רק לפגישה הזו, לא לכל הסדרה.</p>`;
  }
  h += `<div class="actions">
      <button class="btn primary" id="moveBtn" ${edit && !t.allDay ? '' : 'disabled'}>הזזה</button>
      <button class="btn" id="editBtn" ${edit && !t.allDay ? '' : 'disabled'}>עריכה</button>
      <button class="btn danger" id="delBtn" ${dis}>מחיקה</button></div>
    <div class="actions"><button class="btn" id="closeBtn">סגירה</button></div>`;
  const sh = openSheet(h);
  sh.querySelectorAll('[data-att]').forEach(b => b.onclick = () => {
    if (b.dataset.att === 'no') { showCancel(ev); return; }
    setStatus(ev, { attended: b.dataset.att, cancel_reason: '', cancel_note: '' }); showDetails(ev);
  });
  const rn = $('#rcNo', sh); if (rn) rn.onclick = () => { setStatus(ev, Object.fromEntries(RCPT_KEYS.map(k => [k, '']))); showDetails(ev); };
  const ry = $('#rcYes', sh); if (ry) ry.onclick = () => showReceiptIssued(ev);
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
    setStatus(ev, { attended: 'no', cancel_reason: r ? r.value : '', cancel_note: note }); showDetails(ev);
  };
}
function showReceiptIssued(ev) {
  const p = props(ev);
  const sh = openSheet(`<h3 style="margin:4px 0 6px">קבלה על הפגישה של „${esc(title(ev))}”</h3>
    <div class="two"><div class="field"><label>מספר קבלה</label><input type="text" id="rcNum" placeholder="לא חובה" value="${esc(p.rcpt_no || '')}"></div>
      <div class="field"><label>תאריך</label><input type="date" id="rcDate" value="${esc(p.rcpt_date || isoDate(today()))}"></div></div>
    <div class="actions"><button class="btn primary" id="rcSave">שמירה</button><button class="btn" id="rcCancel">ביטול</button></div>`);
  $('#rcCancel', sh).onclick = () => showDetails(ev);
  $('#rcSave', sh).onclick = () => { setStatus(ev, { rcpt_issued: 'yes', rcpt_no: $('#rcNum', sh).value.trim(), rcpt_date: $('#rcDate', sh).value }); showDetails(ev); };
}
function showPrices() {
  const names = [...new Set([...S.events.filter(e => !evTimes(e).allDay).map(e => title(e).trim()), ...Object.keys(S.settings.clients || {})])].sort((a, b) => a.localeCompare(b, 'he'));
  const sh = openSheet(`<h3 style="margin:4px 0 6px">מחירי טיפול</h3>
    <div class="field"><label>מחיר ברירת מחדל לטיפול (₪)</label><input type="text" inputmode="decimal" dir="ltr" id="pDef" placeholder="למשל 250" value="${toAmount(S.settings.default_price) || ''}"></div>
    <p class="note">מחיר ברירת המחדל משמש למטופלים חדשים. אפשר לקבוע מחיר שונה לכל מטופל/ת (שדה ריק = ברירת המחדל), ובכל פגישה אפשר לשנות דרך „עריכה”.</p>
    ${names.map((n, i) => `<div class="two" style="align-items:center;border-bottom:1px solid var(--line);padding:4px 0"><div>${esc(n)}</div>
      <input type="text" inputmode="decimal" dir="ltr" data-pi="${i}" placeholder="ברירת מחדל" value="${toAmount(((S.settings.clients || {})[n] || {}).price) || ''}" style="max-width:130px"></div>`).join('')}
    <p class="err" id="pErr"></p>
    <div class="actions"><button class="btn primary" id="pSave">שמירה</button><button class="btn" id="pCancel">ביטול</button></div>`);
  $('#pCancel', sh).onclick = closeSheet;
  $('#pSave', sh).onclick = () => {
    const def = $('#pDef', sh).value.trim();
    if (def && !toAmount(def)) { $('#pErr', sh).textContent = 'המחיר צריך להיות מספר.'; return; }
    const clients = {};
    for (const inp of sh.querySelectorAll('[data-pi]')) {
      const v = inp.value.trim(); if (!v) continue;
      if (!toAmount(v)) { $('#pErr', sh).textContent = `המחיר של ${names[inp.dataset.pi]} צריך להיות מספר.`; return; }
      clients[names[inp.dataset.pi]] = { price: toAmount(v) };
    }
    closeSheet(); saveSettings({ ...S.settings, default_price: toAmount(def) || 0, clients });
  };
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
  const names = [...new Set([...S.events.map(e => title(e).trim()), ...Object.keys(S.settings.clients || {})])].sort((a, b) => a.localeCompare(b, 'he'));
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
        loadEvents();
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
async function startReceipt(file) {
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
    showReceiptMatch(blob, url, info, matchReceipt(info, events));
  } catch (e) { closeSheet(); handleErr(e); }
}
function showReceiptMatch(blob, url, info, matches) {
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
      toast(`✓ התשלום נשמר ב-Google (${n === 1 ? 'פגישה אחת' : n + ' פגישות'}), כולל הצילום`);
      renderView.keepScroll = true; loadEvents();
    } catch (e) { btn.disabled = false; btn.textContent = 'שמירה'; handleErr(e); }
  };
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
function showForm({ start = null, ev = null, mode = 'new', master = null } = {}) {
  // mode: new | single | instance | series
  const editing = !!ev;
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
  let count = 10, repeatLabel = 'חוזר כל שבוע', repeatNote = '';
  if (mode === 'series' && master) {
    const info = rruleInfo(master.recurrence);
    count = info.count || (info.until ? 10 : 0);
    repeatLabel = info.interval === 1 ? 'חוזר כל שבוע' : info.interval === 2 ? 'חוזר כל שבועיים' : `חוזר כל ${info.interval} שבועות`;
    const ms = master.start || {};
    if (ms.dateTime) repeatNote = `מספר הפגישות נספר מהפגישה הראשונה בסדרה (${hebDate(new Date(ms.dateTime))}).`;
  } else if (mode === 'instance') repeatNote = 'כדי לשנות את מספר הפגישות, עורכים את „כל הפגישות בסדרה”.';
  const counts = [...Array.from({ length: 51 }, (_, i) => i + 2)];
  if (count && !counts.includes(count)) counts.push(count), counts.sort((a, b) => a - b);
  const showRepeat = ['new', 'single', 'series'].includes(mode);
  const sh = openSheet(`<h3 style="margin:4px 0 6px">${editing ? 'עריכת פגישה' : 'פגישה חדשה'}</h3>
    ${mode === 'series' ? '<p class="note">השינויים יחולו על כל הפגישות בסדרה.</p>' : ''}
    ${!editing ? `<div class="field"><label>יומן</label><select id="fCal">${cals.map(c => `<option value="${esc(c.id)}" ${c.id === defCal ? 'selected' : ''}>${esc(calName(c))}${c.primary ? ' (ראשי)' : ''}</option>`).join('')}</select></div>` : ''}
    <div class="field"><label>מטופל/ת</label><input type="text" id="fName" placeholder="שם המטופל/ת" value="${esc(editing ? ev.summary || '' : '')}"></div>
    <div class="field"><label>תאריך</label><input type="date" id="fDate" value="${isoDate(s)}" ${mode === 'series' ? 'disabled' : ''}></div>
    <div class="two"><div class="field"><label>שעת התחלה</label>${timeInput('fStart', s)}</div>
      <div class="field"><label>שעת סיום <span id="fLen" class="note"></span></label>${timeInput('fEnd', e)}</div></div>
    <div class="field"><label>מיקום</label><input type="text" id="fLoc" placeholder="קליניקה, ביקור בית, בית ספר, אונליין…" value="${esc(editing ? ev.location || '' : '')}"></div>
    <div class="field"><label>מחיר (₪) <span class="note" id="fPriceNote"></span></label><input type="text" inputmode="decimal" dir="ltr" id="fPrice" placeholder="לא חובה"></div>
    ${showRepeat ? `<div class="field"><label>חזרה</label><div class="two" style="align-items:center">
        <label class="check"><input type="checkbox" id="fWeekly" ${mode === 'series' ? 'checked disabled' : ''}>${repeatLabel}</label>
        <select id="fCount" ${mode === 'series' ? '' : 'disabled'}>${counts.map(n => `<option value="${n}" ${n === count ? 'selected' : ''}>${n} פגישות</option>`).join('')}<option value="0" ${count === 0 ? 'selected' : ''}>ללא תאריך סיום</option></select></div></div>` : ''}
    ${repeatNote ? `<p class="note">${esc(repeatNote)}</p>` : ''}
    <div class="field"><label>תזכורת</label><select id="fRem">${remOpts.map(([m, l]) => `<option value="${m}" ${m === rem ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
    <div class="field"><label>הערות</label><textarea id="fNotes" rows="3" placeholder="הערות (לא חובה)">${esc(editing ? ev.description || '' : '')}</textarea></div>
    <p class="err" id="fErr"></p>
    <div class="actions"><button class="btn primary" id="fSave">${editing ? 'שמירה' : 'הוספה'}</button><button class="btn" id="fCancel">ביטול</button></div>`);
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
  const prefill = () => {
    const name = fn.value.trim(), known = name in (S.settings.clients || {}), pr = clientPrice(name);
    if (!priceTouched) fp.value = pr || '';
    fpn.textContent = !name ? '' : known ? '(מחיר המטופל/ת)' : editing ? '' : '(מטופל/ת חדש/ה · יישמר כברירת מחדל)';
  };
  fp.oninput = () => { priceTouched = true; };
  fn.addEventListener('change', prefill); fn.addEventListener('blur', prefill); prefill();
  const wk = $('#fWeekly', sh), cnt = $('#fCount', sh);
  if (wk && mode !== 'series') wk.onchange = () => { cnt.disabled = !wk.checked; };
  let remTouched = false, cntTouched = false;
  $('#fRem', sh).onchange = () => { remTouched = true; };
  if (cnt) cnt.addEventListener('change', () => { cntTouched = true; });
  $('#fCancel', sh).onclick = () => { if (editing) showDetails(ev); else closeSheet(); };
  $('#fSave', sh).onclick = async () => {
    const name = $('#fName', sh).value.trim();
    if (!name) { $('#fErr', sh).textContent = 'יש למלא את שם המטופל/ת.'; return; }
    const st = fromInputs($('#fDate', sh).value, fs.value), en = fromInputs($('#fDate', sh).value, fe.value);
    if (!(en > st)) { $('#fErr', sh).textContent = 'שעת הסיום צריכה להיות אחרי שעת ההתחלה.'; return; }
    if (fp.value.trim() && !toAmount(fp.value)) { $('#fErr', sh).textContent = 'המחיר צריך להיות מספר, למשל 250.'; return; }
    const price = toAmount(fp.value);
    const tz = currentTz();
    const body = { summary: name, start: { dateTime: localStr(st), timeZone: tz }, end: { dateTime: localStr(en), timeZone: tz },
      location: $('#fLoc', sh).value.trim(), description: $('#fNotes', sh).value.trim() };
    if (!editing) { if (price) body.extendedProperties = { private: { price: String(price) } }; }
    else if (mode === 'series') body.extendedProperties = { private: { price: price ? String(price) : '' } };
    else body.extendedProperties = { private: { ...props(ev), price: price ? String(price) : '' } };
    if (!editing || remTouched) { const m = Number($('#fRem', sh).value); body.reminders = { useDefault: false, overrides: m > 0 ? [{ method: 'popup', minutes: m }] : [] }; }
    const c = cnt ? Number(cnt.value) : 0;
    if ((mode === 'new' || mode === 'single') && wk && wk.checked) body.recurrence = ['RRULE:FREQ=WEEKLY' + (c ? ';COUNT=' + c : '')];
    else if (mode === 'series' && master && cntTouched) body.recurrence = rruleWithCount(master.recurrence, c);
    const btn = $('#fSave', sh); btn.disabled = true; btn.textContent = 'שומר…';
    try {
      if (!editing) await G.insert($('#fCal', sh).value, body);
      else if (mode === 'series') await G.updateSeries(ev._calendar_id, ev.recurringEventId, body, tz);
      else await G.patch(ev._calendar_id, ev.id, body);
      closeSheet(); toast(editing ? 'השינויים נשמרו' : `נוספה פגישה: ${name}`);
      if (!editing && price && !(name in (S.settings.clients || {}))) saveSettings({ ...S.settings, clients: { ...(S.settings.clients || {}), [name]: { price } } });
      renderView.keepScroll = true; loadEvents();
    } catch (err) { btn.disabled = false; btn.textContent = editing ? 'שמירה' : 'הוספה'; handleErr(err); }
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
    const btn = $('#mSave', sh); btn.disabled = true; btn.textContent = 'מזיז…';
    try {
      await G.patch(ev._calendar_id, ev.id, { start: { dateTime: localStr(st), timeZone: tz }, end: { dateTime: localStr(en), timeZone: tz } });
      closeSheet(); toast(`„${title(ev)}” הוזזה ליום ${DAYS[st.getDay()]}, ${hebDate(st)} בשעה ${hm(st)}`);
      renderView.keepScroll = true; loadEvents();
    } catch (e) { btn.disabled = false; btn.textContent = 'הזזה'; handleErr(e); }
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
  busy(true);
  try { await G.del(ev._calendar_id, target); toast('הפגישה נמחקה'); renderView.keepScroll = true; await loadEvents(); }
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
    <div class="menu-item"><span style="flex:1">מחירי טיפול</span><button class="btn" id="mPrices">עריכה</button></div>
    <div class="menu-item"><span style="flex:1">גיבוי</span><button class="btn" id="mBackup">גיבוי עכשיו</button></div>
    <div class="menu-item"><span style="flex:1">קובץ גיבוי</span><button class="btn" id="mExport">ייצוא</button><button class="btn" id="mRestore">שחזור</button></div>
    <label class="check"><input type="checkbox" id="mEmail" ${S.settings.backup_email !== false ? 'checked' : ''}>שליחת הגיבוי היומי למייל</label>
    <h3 style="margin:18px 0 4px">צילומי תשלום</h3>
    <div class="menu-item"><span style="flex:1">מפתח Gemini: ${store.get('geminiKey', '') ? '✓ מוגדר' : 'לא מוגדר'}</span><button class="btn" id="gKeyBtn">${store.get('geminiKey', '') ? 'החלפה' : 'הגדרה'}</button></div>
    <h3 style="margin:18px 0 4px">חשבון</h3>
    <div class="menu-item"><span style="flex:1" dir="ltr">${esc(S.email || '')}</span></div>
    <div class="actions"><button class="btn danger" id="soBtn">התנתקות</button><button class="btn" id="mClose">סגירה</button></div>
    <p class="note" style="margin-top:14px">כל הנתונים נשמרים ב-Google Calendar, ולכן הם זהים בטלפון ובמחשב.</p>`);
  sh.querySelectorAll('input[name=cal]').forEach(r => r.onchange = () => { S.calId = r.value; store.set('calId', r.value); closeSheet(); S.loaded = false; renderView(); loadEvents(); });
  $('#soBtn', sh).onclick = signOut;
  $('#gKeyBtn', sh).onclick = () => askGeminiKey(null);
  $('#mPrices', sh).onclick = showPrices;
  $('#mBackup', sh).onclick = () => { closeSheet(); makeBackup(false); };
  $('#mExport', sh).onclick = () => { closeSheet(); exportBackupFile(); };
  $('#mRestore', sh).onclick = showRestore;
  $('#mEmail', sh).onchange = e => saveSettings({ ...S.settings, backup_email: e.target.checked });
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
  $('#receiptFile').onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) startReceipt(f); };
  $('#refreshBtn').onclick = () => { renderView.keepScroll = true; S.calendars.length ? loadEvents() : loadCalendars(); };
  $('#todayBtn').onclick = () => { S.anchor = today(); S.loaded = false; renderView(); loadEvents(); };
  $('#prevBtn').onclick = () => step(-1);
  $('#nextBtn').onclick = () => step(1);
  $('#fab').onclick = () => showForm({});
  $('#sheetBack').onclick = closeSheet;
  document.querySelectorAll('#tabs button').forEach(b => b.onclick = () => setView(b.dataset.view));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.token && S.calendars.length && $('#sheet').hidden) { renderView.keepScroll = true; loadEvents(); } });
  setInterval(() => { if (document.visibilityState === 'visible' && S.token && S.calendars.length && $('#sheet').hidden) { renderView.keepScroll = true; loadEvents(); } }, 5 * 60 * 1000);
  setInterval(() => { if (S.view === 'day' || S.view === 'week') { const nl = $('.nowline'); if (nl) { renderView.keepScroll = true; renderView(); } } }, 60 * 1000);
  if ('serviceWorker' in navigator && !DEMO && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
  render();
}
init();
