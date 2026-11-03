/* יומן הטיפולים – גרסת אנדרואיד (אפליקציית רשת).
   כל הנתונים נשמרים ב-Google Calendar, באותם שדות שאפליקציית Windows משתמשת בהם,
   ולכן שתי האפליקציות מסונכרנות. */
'use strict';

// ------------------------------------------------------------------ קבועים
const SCOPES = 'https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events';
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
  else if (a === 'no') t.push(`<span class="tag no">${ICON.x}${short ? '' : 'לא התקיימה'}</span>`);
  if (paid(ev)) t.push(`<span class="tag pay">₪${short ? '' : ' ' + esc(payLabel(ev) || 'שולם')}</span>`);
  else if (a === 'yes') t.push(`<span class="tag unpaid">₪${short ? '' : ' לא שולם'}</span>`);
  return t.length ? `<div class="tags${short ? ' short' : ''}">${t.join('')}</div>` : '';
}

// ------------------------------------------------------------------ Google
class NeedLogin extends Error {}
const qs = obj => Object.entries(obj)
  .flatMap(([k, v]) => Array.isArray(v) ? v.map(x => [k, x]) : (v === undefined || v === null ? [] : [[k, v]]))
  .map(([k, v]) => enc(k) + '=' + enc(v)).join('&');

async function api(method, path, body, query) {
  if (DEMO) return Mock.handle(method, path, body, query);
  if (!S.token || Date.now() > S.tokenExp) throw new NeedLogin();
  const r = await fetch(API + path + (query ? '?' + query : ''), {
    method,
    headers: { Authorization: 'Bearer ' + S.token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 401) { S.token = null; store.set('tok', null); throw new NeedLogin(); }
  if (!r.ok) {
    let msg = 'שגיאה ' + r.status;
    try { const j = await r.json(); msg = (j.error && j.error.message) || msg; } catch { /* ignore */ }
    throw new Error(msg);
  }
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
  async setProps(c, id, p) {
    await G.patch(c, id, { extendedProperties: { private: p } });
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
  if (t && t.e > Date.now()) { S.token = t.t; S.tokenExp = t.e; }
}
function signIn() {
  return new Promise((resolve, reject) => {
    if (!window.google || !google.accounts || !google.accounts.oauth2) {
      reject(new Error('רכיב ההתחברות של Google עוד לא נטען. בדקי שיש חיבור לאינטרנט ונסי שוב.')); return;
    }
    const tc = google.accounts.oauth2.initTokenClient({
      client_id: S.clientId, scope: SCOPES, hint: S.email || undefined, prompt: S.email ? '' : 'consent',
      callback: r => {
        if (r.error) { reject(new Error(r.error_description || r.error)); return; }
        S.token = r.access_token; S.tokenExp = Date.now() + (Number(r.expires_in || 3600) - 60) * 1000;
        store.set('tok', { t: S.token, e: S.tokenExp }); resolve();
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

async function loadCalendars() {
  busy(true);
  try {
    S.calendars = await G.calendars();
    const p = primaryCal();
    if (p) { S.email = p.id; store.set('email', p.id); }
    if (S.calId !== ALL && !S.calendars.some(c => c.id === S.calId)) { S.calId = p ? p.id : null; store.set('calId', S.calId); }
    hideBanner();
    await loadEvents();
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
const attText = ev => ({ yes: 'התקיימה', no: 'לא התקיימה' })[attended(ev)] || 'טרם סומן';
const payText = ev => paid(ev) ? 'שולם' : (attended(ev) === 'yes' ? 'לא שולם' : '—');
function stats(evs) {
  return { total: evs.length, held: evs.filter(e => attended(e) === 'yes').length, missed: evs.filter(e => attended(e) === 'no').length,
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
      </select>
    </div>
    <div class="totals">${groups.length} מטופלים · ${st.total} פגישות · ${st.held} התקיימו · ${st.missed} לא התקיימו · ${st.paid} שולמו · ${st.unpaid} התקיימו וטרם שולמו</div>
    ${Object.keys(methods).length ? `<div class="methods note">לפי אמצעי תשלום: ${Object.entries(methods).map(([k, v]) => esc(k) + ': ' + v).join(' · ')}</div>` : ''}`;
  if (!groups.length) h += '<div class="empty">אין פגישות בחודש הזה לפי הסינון שנבחר.</div>';
  for (const [name, evs] of groups) {
    const cs = stats(evs);
    h += `<div class="client"><div class="client-h"><b>${esc(name)}</b><div class="st">${cs.total} פגישות · ${cs.held} התקיימו · ${cs.paid} שולמו${cs.unpaid ? ` · <span class="debt">${cs.unpaid} טרם שולמו</span>` : ''}</div></div>`;
    for (const ev of evs) {
      const t = evTimes(ev), a = attended(ev);
      h += `<div class="srow" data-id="${esc(ev.id)}">
        <div class="when">${DAYS[t.s.getDay()]} ${dmy(t.s)}<small>${hm(t.s)}–${hm(t.e)}</small></div>
        <div class="${a === 'yes' ? 'c-ok' : a === 'no' ? 'c-no' : 'c-gray'}">${attText(ev)}</div>
        <div class="${paid(ev) ? 'c-ok' : a === 'yes' ? 'c-no' : 'c-gray'}">${payText(ev)}${paid(ev) && payLabel(ev) ? ' · ' + esc(payLabel(ev)) : ''}</div>
      </div>`;
    }
    h += '</div>';
  }
  h += `<div class="sum-actions no-print"><button class="btn" id="csvBtn">ייצוא לאקסל</button><button class="btn primary" id="pdfBtn">שמירה כ-PDF</button></div>
    <p class="note no-print" style="padding:0 14px">לחיצה על פגישה פותחת אותה לסימון או לתיקון.</p>`;
  return h;
}
async function exportCsv() {
  const rows = [['מטופל/ת', 'תאריך', 'יום', 'התחלה', 'סיום', 'הפגישה', 'תשלום', 'אמצעי תשלום']];
  for (const [name, evs] of summaryGroups()) for (const ev of evs) {
    const t = evTimes(ev);
    rows.push([name, dmy(t.s), DAYS[t.s.getDay()], hm(t.s), hm(t.e), attText(ev), payText(ev), paid(ev) ? payLabel(ev) : '']);
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
    <div class="k">יומן</div><div>${esc(ev._calendar || '')}</div></div>`;
  if (!t.allDay) {
    h += `<div class="sec">הפגישה</div><div class="seg">
        <button class="btn ${a === '' ? 'on' : ''}" data-att="" ${dis}>טרם סומן</button>
        <button class="btn ${a === 'yes' ? 'on' : ''}" data-att="yes" ${dis}>✓ התקיימה</button>
        <button class="btn ${a === 'no' ? 'on' : ''}" data-att="no" ${dis}>✗ לא התקיימה</button></div>
      <div class="sec">תשלום</div><div class="seg">
        <button class="btn ${!paid(ev) ? 'on' : ''}" id="unpaidBtn" ${dis}>לא שולמה</button>
        <button class="btn ${paid(ev) ? 'on' : ''}" id="paidBtn" ${dis}>₪ שולמה${paid(ev) && payLabel(ev) ? ' · ' + esc(payLabel(ev)) : '…'}</button></div>
      <p class="note">הסימון נשמר רק לפגישה הזו, לא לכל הסדרה.</p>`;
  }
  h += `<div class="actions">
      <button class="btn primary" id="moveBtn" ${edit && !t.allDay ? '' : 'disabled'}>הזזה</button>
      <button class="btn" id="editBtn" ${edit && !t.allDay ? '' : 'disabled'}>עריכה</button>
      <button class="btn danger" id="delBtn" ${dis}>מחיקה</button></div>
    <div class="actions"><button class="btn" id="closeBtn">סגירה</button></div>`;
  const sh = openSheet(h);
  sh.querySelectorAll('[data-att]').forEach(b => b.onclick = () => { setStatus(ev, { attended: b.dataset.att }); showDetails(ev); });
  const ub = $('#unpaidBtn', sh); if (ub) ub.onclick = () => { setStatus(ev, { paid: '', pay_method: '', pay_note: '' }); showDetails(ev); };
  const pb = $('#paidBtn', sh); if (pb) pb.onclick = () => showPayment(ev);
  $('#moveBtn', sh).onclick = () => showMove(ev);
  $('#editBtn', sh).onclick = () => editEvent(ev);
  $('#delBtn', sh).onclick = () => deleteEvent(ev);
  $('#closeBtn', sh).onclick = closeSheet;
}

async function setStatus(ev, changes) {
  if (!canEdit(ev)) return;
  const before = JSON.parse(JSON.stringify(ev.extendedProperties || null));
  const p = { ...props(ev), ...changes };
  ev.extendedProperties = { ...(ev.extendedProperties || {}), private: p };
  renderView.keepScroll = true; renderView();
  try {
    const fresh = await G.setProps(ev._calendar_id, ev.id, p);
    if (fresh && fresh.extendedProperties) ev.extendedProperties = fresh.extendedProperties;
    toast('✓ הסימון נשמר ב-Google');
  } catch (e) {
    ev.extendedProperties = before || undefined;
    renderView.keepScroll = true; renderView();
    handleErr(e);
  }
}

function showPayment(ev) {
  const p = props(ev);
  const sh = openSheet(`<h3 style="margin:4px 0 6px">איך שולמה הפגישה של „${esc(title(ev))}”?</h3>
    ${PAY_METHODS.map(([k, l]) => `<label class="radio"><input type="radio" name="pm" value="${k}" ${p.pay_method === k ? 'checked' : ''}>${l}</label>`).join('')}
    <div class="field"><input type="text" id="payNote" placeholder="מה? למשל צ׳ק, כרטיס אשראי, הוראת קבע…" value="${esc(p.pay_note || '')}"></div>
    <p class="err" id="payErr"></p>
    <div class="actions"><button class="btn primary" id="paySave">שמירה</button><button class="btn" id="payCancel">ביטול</button></div>`);
  const note = $('#payNote', sh);
  const sync = () => { const m = sh.querySelector('input[name=pm]:checked'); note.disabled = !(m && m.value === 'other'); };
  sh.querySelectorAll('input[name=pm]').forEach(r => r.onchange = () => { sync(); if (r.value === 'other') note.focus(); });
  sync();
  $('#payCancel', sh).onclick = () => showDetails(ev);
  $('#paySave', sh).onclick = () => {
    const m = sh.querySelector('input[name=pm]:checked');
    if (!m) { $('#payErr', sh).textContent = 'יש לבחור איך שולמה הפגישה.'; return; }
    if (m.value === 'other' && !note.value.trim()) { $('#payErr', sh).textContent = 'יש לכתוב מה אמצעי התשלום.'; return; }
    setStatus(ev, { paid: 'yes', pay_method: m.value, pay_note: m.value === 'other' ? note.value.trim() : '' });
    showDetails(ev);
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
    const tz = currentTz();
    const body = { summary: name, start: { dateTime: localStr(st), timeZone: tz }, end: { dateTime: localStr(en), timeZone: tz },
      location: $('#fLoc', sh).value.trim(), description: $('#fNotes', sh).value.trim() };
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
    <h3 style="margin:18px 0 4px">חשבון</h3>
    <div class="menu-item"><span style="flex:1" dir="ltr">${esc(S.email || '')}</span></div>
    <div class="actions"><button class="btn danger" id="soBtn">התנתקות</button><button class="btn" id="mClose">סגירה</button></div>
    <p class="note" style="margin-top:14px">כל הנתונים נשמרים ב-Google Calendar, ולכן הם זהים בטלפון ובמחשב.</p>`);
  sh.querySelectorAll('input[name=cal]').forEach(r => r.onchange = () => { S.calId = r.value; store.set('calId', r.value); closeSheet(); S.loaded = false; renderView(); loadEvents(); });
  $('#soBtn', sh).onclick = signOut;
  $('#mClose', sh).onclick = closeSheet;
}

// ------------------------------------------------------------------ מצב הדגמה (לבדיקה בלבד: ?demo)
const Mock = {
  data: null,
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
