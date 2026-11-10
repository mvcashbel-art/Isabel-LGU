/**
 * Isabel LGU Portal backend (Google Apps Script) - v3 (hardened)
 *
 * One Google Sheet holds everything the website shares between devices:
 *   - Subscribers / SMS Outbox / Alerts : emergency alerts and SMS
 *   - Posts    : announcements, likes and comments
 *   - Settings : header text, office hours, hotlines, quick-service cards
 *   - Audit    : who logged in / published / edited what (NEW)
 *
 * Officers log in with a passcode that is checked HERE, never in the web page.
 * Passcodes live in the Script property OFFICERS, e.g.
 *   {"a-long-passcode-at-least-16-chars":"Hon. Municipal Mayor","another-long-one-1234":"Officer Ashbel Espenido"}
 * Public visitors can read, like, comment and subscribe. Everything else needs a login token.
 * Subscriber phone numbers are never returned by any public endpoint.
 *
 * WHAT CHANGED IN v3
 *   1. Barangays are checked against the official list of 24 (BARANGAYS below).
 *   2. Names are stripped to plain letters, so "=IMPORTDATA(...)" can never become a spreadsheet formula.
 *   3. Sign-up and unsubscribe need a 6-digit code texted to the number (when an SMS provider is set).
 *   4. Wrong passcodes / PINs are counted and locked out for 15 minutes.
 *   5. poll / state responses are cached, so a typhoon-day traffic spike does not overload Apps Script.
 *   6. Comments: author name is no longer client-controlled, links blocked, rate limits added. Likes are rate limited.
 *   7. publish_ records the alert FIRST, then sends SMS (outside the lock), and blocks double-publishes.
 *   8. Audit sheet for officer actions. Public errors no longer leak internals.
 *   9. housekeeping() and backupSheet() with installTriggers() (run once).
 *  10. Dead-number tracking: every alert text is followed up with Semaphore. A number whose texts fail
 *      FAIL_LIMIT alerts in a row is switched to FAILED and no longer costs you credits (checkDelivery, hourly).
 *      Admin tools: numberReport(), removeNumbers(), purgeFailedNumbers().
 *  11. "Report a concern": residents can send a report (road, flooding, fallen tree...). It goes to the Reports sheet and
 *      officers read and update it on the website. Name and contact are optional. Residents can attach a photo (saved in a
 *      private Drive folder "Isabel LGU Report Photos") and their location. Reports and photos older than 180 days are deleted.
 *
 * OPTIONAL SCRIPT PROPERTIES
 *   OTP_REQUIRED   "true" / "false". Default: true when SMS_PROVIDER is not OUTBOX, else false.
 *   OTP_6H_CAP     Max verification texts per 6 hours for the whole site (default 150).
 *   REMOVE_NUMBERS Numbers to delete when you run removeNumbers(), separated by commas. Cleared afterwards.
 */

var SHEET_SUBS = 'Subscribers';
var SHEET_ALERTS = 'Alerts';
var SHEET_OUTBOX = 'SMS Outbox';
var SHEET_POSTS = 'Posts';
var SHEET_SETTINGS = 'Settings';
var SHEET_AUDIT = 'Audit';
var SHEET_REPORTS = 'Reports';

var REPORT_CATEGORIES = ['Road or bridge', 'Flooding or drainage', 'Fallen tree or debris', 'Streetlight or electricity', 'Water supply',
  'Garbage or sanitation', 'Peace and order', 'Other'];
var REPORT_STATUSES = ['NEW', 'SEEN', 'IN PROGRESS', 'DONE', 'SPAM'];
var REPORT_KEEP_DAYS = 180;   // reports contain names and contact numbers, so old ones are deleted by housekeeping()
var REPORT_MAX_PER_HOUR = 60; // whole site
var REPORT_PHOTOS_PER_HOUR = 30;      // whole site; every photo is saved in Google Drive
var REPORT_PHOTO_MAX_BASE64 = 700000; // about 500 KB. The page shrinks photos to roughly 150-300 KB before sending.
var REPORT_PHOTO_FOLDER = 'Isabel LGU Report Photos';

var CATEGORIES = ['PERMITTING & TAXATION', 'PUBLIC SAFETY', 'HEALTH & COMMUNITY', 'EXECUTIVE ISSUANCE'];
var TOKEN_HOURS = 12;
var MAX_POSTS = 150;
var MAX_COMMENTS = 80;  // keeps one post comfortably under the 50,000-character cell limit
var CELL_LIMIT = 45000; // Google Sheets cells hold at most 50,000 characters

var SEVERITIES = ['ADVISORY', 'WARNING', 'EMERGENCY'];
var SMS_MAX_CHARS = 459; // about 3 SMS segments

var LOGIN_MAX_FAILS = 20;  // per 15 minutes, whole site (existing sessions keep working)
var PIN_MAX_FAILS = 5;     // per 15 minutes, per officer
var FAIL_WINDOW_SEC = 900;

// Dead-number tracking (see checkDelivery)
var FAIL_LIMIT = 3;          // alerts in a row a number must fail before it is switched to FAILED
var FAIL_BATCH_GUARD = 0.7;  // if more than this share of one alert's texts failed, blame the provider (credits, sender name), not the numbers
var SMS_LIST_PAGES = 10;     // pages of 1000 messages read from Semaphore per run
var SMS_SINGLE_LOOKUPS = 40; // one-by-one lookups for messages the list did not return
var SMS_CHECK_DAYS = 14;     // texts older than this are no longer followed up

// The 24 barangays of Isabel, Leyte (source: PSA data as listed on PhilAtlas). Check the spelling against the
// LGU's own records and edit here if the municipality writes any of them differently.
var BARANGAYS = [
  'Anislag', 'Antipolo', 'Apale', 'Bantigue', 'Benog', 'Bilwang', 'Can-andan', 'Cangag',
  'Consolacion', 'Honan', 'Libertad', 'Mahayag', 'Marvel', 'Matlang', 'Monte Alegre', 'Puting Bato',
  'San Francisco', 'San Roque', 'Santa Cruz', 'Santo Niño', 'Santo Rosario', 'Tabunok', 'Tolingon', 'Tubod'
];
// Other spellings people commonly type (all lower case, no accents, no dots).
var BARANGAY_ALIASES = {
  'binog': 'Benog', 'can andan': 'Can-andan', 'canandan': 'Can-andan',
  'sto nino': 'Santo Niño', 'sto rosario': 'Santo Rosario', 'sta cruz': 'Santa Cruz'
};
var BRGY_MAP = null;

/* ---------- Web app entry points ---------- */

function doGet(e) {
  try {
    var action = (e && e.parameter && e.parameter.action) || 'alerts';
    if (action === 'alerts') return json_({ ok: true, alerts: activeAlerts_() });
    if (action === 'poll') {
      return jsonText_(cached_('poll', 20, function () {
        return JSON.stringify({ ok: true, v: dataVersion_(), alerts: activeAlerts_() });
      }));
    }
    if (action === 'state') {
      return jsonText_(cached_('state', 30, function () { return JSON.stringify(state_()); }));
    }
    if (action === 'ping') return json_({ ok: true, backend: 'shared-v3' });
    return json_({ ok: false, error: 'Unknown action' });
  } catch (err) {
    return fail_(err);
  }
}

function doPost(e) {
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    switch (body.action) {
      case 'subscribe':          return json_(subscribe_(body));
      case 'confirmSubscribe':   return json_(confirmSubscribe_(body));
      case 'unsubscribe':        return json_(unsubscribe_(body));
      case 'confirmUnsubscribe': return json_(confirmUnsubscribe_(body));
      case 'publish':     return json_(publish_(body));
      case 'resolve':     return json_(resolve_(body));
      case 'smsInfo':     return json_(smsInfo_(body));
      case 'login':       return json_(login_(body));
      case 'createPost':  return json_(createPost_(body));
      case 'updatePost':  return json_(updatePost_(body));
      case 'pinPost':     return json_(pinPost_(body));
      case 'deletePost':  return json_(deletePost_(body));
      case 'likePost':    return json_(likePost_(body));
      case 'addComment':  return json_(addComment_(body));
      case 'deleteComment': return json_(deleteComment_(body));
      case 'saveSetting': return json_(saveSetting_(body));
      case 'importState': return json_(importState_(body));
      case 'report':        return json_(report_(body));
      case 'listReports':   return json_(listReports_(body));
      case 'setReportStatus': return json_(setReportStatus_(body));
      case 'getReportPhoto':  return json_(getReportPhoto_(body));
      default:            return json_({ ok: false, error: 'Unknown action' });
    }
  } catch (err) {
    return fail_(err);
  }
}

/** Real error goes to the execution log; the public only sees a generic message. */
function fail_(err) {
  console.error(err && err.stack ? err.stack : String(err));
  return json_({ ok: false, error: 'Server error. Please try again in a moment.' });
}

/* ---------- Rate limits, lockouts and caching (CacheService) ---------- */

/** Counts a hit in a fixed time bucket. Returns true while the caller is still under the limit. Window max 6 hours. */
function hit_(key, max, windowSec) {
  var c = CacheService.getScriptCache();
  var k = 'rl:' + key + ':' + Math.floor(Date.now() / (windowSec * 1000));
  var n = Number(c.get(k) || 0) + 1;
  c.put(k, String(n), Math.min(windowSec + 5, 21600));
  return n <= max;
}

function locked_(name, max) { return Number(CacheService.getScriptCache().get('fail:' + name) || 0) >= max; }
function noteFail_(name, ttl) {
  var c = CacheService.getScriptCache(), k = 'fail:' + name;
  c.put(k, String(Number(c.get(k) || 0) + 1), ttl);
}
function clearFails_(name) { CacheService.getScriptCache().remove('fail:' + name); }

function busy_() { return { ok: false, error: 'The service is busy right now. Please try again in a minute.' }; }

/** Cache big strings in 24,000-character pieces (one cache value holds at most 100 KB). */
function cacheGetBig_(key) {
  var c = CacheService.getScriptCache(), meta = c.get(key + ':n');
  if (!meta) return null;
  var n = Number(meta), keys = [], i;
  for (i = 0; i < n; i++) keys.push(key + ':' + i);
  var parts = c.getAll(keys), out = '';
  for (i = 0; i < n; i++) {
    var p = parts[key + ':' + i];
    if (p == null) return null;
    out += p;
  }
  return out;
}

function cachePutBig_(key, str, ttl) {
  try {
    var size = 24000, n = Math.max(1, Math.ceil(str.length / size)), obj = {}, i;
    for (i = 0; i < n; i++) obj[key + ':' + i] = str.substring(i * size, (i + 1) * size);
    obj[key + ':n'] = String(n);
    CacheService.getScriptCache().putAll(obj, ttl);
  } catch (e) { /* caching is only an optimisation */ }
}

function cached_(key, ttl, build) {
  var hit = cacheGetBig_(key);
  if (hit) return hit;
  var s = build();
  cachePutBig_(key, s, ttl);
  return s;
}

/** Forgets the cached poll/state answers so the next visitor sees fresh data. */
function dropCaches_() {
  try { CacheService.getScriptCache().removeAll(['poll:n', 'state:n']); } catch (e) {}
}

/* ---------- Cleaning and validation ---------- */

function clean_(v, max) {
  return String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().substring(0, max);
}

function cleanText_(v, max) {
  return String(v == null ? '' : v).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f]/g, ' ').trim().substring(0, max);
}

/** Plain-letters name: keeps Latin letters (with accents), space, dot, apostrophe and hyphen. No digits or symbols. */
function cleanName_(v, max) {
  var s = String(v == null ? '' : v).substring(0, max * 3)
    .replace(/[^A-Za-z\u00C0-\u024F .'\u2019-]/g, '')
    .replace(/^[^A-Za-z\u00C0-\u024F]+/, '')
    .replace(/\s+/g, ' ').trim().substring(0, max);
  return s.length >= 2 ? s : '';
}

/** A spreadsheet treats a cell starting with = + - @ as a formula. A leading space makes it plain text. */
function cellSafe_(v) {
  v = String(v == null ? '' : v);
  return /^[=+\-@\t\r]/.test(v) ? ' ' + v : v;
}
function uncell_(v) {
  v = String(v == null ? '' : v);
  return /^ [=+\-@\t\r]/.test(v) ? v.substring(1) : v;
}

function brgyKey_(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/\u00f1/g, 'n').replace(/\(.*?\)/g, ' ')
    .replace(/\b(brgy|bgy|barangay)\b\.?/g, ' ').replace(/\./g, '').replace(/\s+/g, ' ').trim();
}

function brgyMap_() {
  if (BRGY_MAP) return BRGY_MAP;
  var m = {};
  BARANGAYS.forEach(function (b) { m[brgyKey_(b)] = b; });
  Object.keys(BARANGAY_ALIASES).forEach(function (k) { m[k] = BARANGAY_ALIASES[k]; });
  BRGY_MAP = m;
  return m;
}

/** Returns the official spelling, or '' when the text is not one of the 24 barangays. */
function canonBarangay_(v) {
  return brgyMap_()[brgyKey_(clean_(v, 60))] || '';
}

/** "ALL" or a comma-separated list of official barangays. Returns {value} or {error}. */
function canonBarangayList_(raw) {
  var s = clean_(raw, 300);
  if (!s || s.toUpperCase() === 'ALL') return { value: 'ALL' };
  var parts = s.split(','), seen = {}, out = [];
  for (var i = 0; i < parts.length; i++) {
    var p = parts[i].trim();
    if (!p) continue;
    if (p.toUpperCase() === 'ALL') return { value: 'ALL' };
    var c = canonBarangay_(p);
    if (!c) return { error: 'Unknown barangay "' + p.substring(0, 40) + '". Use the official spelling, or ALL.' };
    if (!seen[c]) { seen[c] = 1; out.push(c); }
  }
  return out.length ? { value: out.join(', ') } : { value: 'ALL' };
}

function normalizeMobile_(raw) {
  var d = String(raw || '').replace(/[^0-9]/g, '');
  if (/^09\d{9}$/.test(d)) d = '63' + d.substring(1);
  else if (/^9\d{9}$/.test(d)) d = '63' + d;
  return /^639\d{9}$/.test(d) ? d : '';
}

function isV2_(b) { return Number(b && b.v) >= 2; }
function refreshError_() { return { ok: false, error: 'This page was updated. Please refresh it (reload the page) and try again.' }; }

/* ---------- Text-message codes (OTP) ---------- */

function providerName_() { return (PropertiesService.getScriptProperties().getProperty('SMS_PROVIDER') || 'OUTBOX').toUpperCase(); }

function otpRequired_() {
  var flag = PropertiesService.getScriptProperties().getProperty('OTP_REQUIRED');
  if (flag === 'true') return true;
  if (flag === 'false') return false;
  return providerName_() !== 'OUTBOX';
}

function newCode_() {
  var n = parseInt(Utilities.getUuid().replace(/-/g, '').substring(0, 8), 16) % 1000000;
  return ('000000' + n).slice(-6);
}

function otpKey_(mobile, purpose) { return 'otp:' + purpose + ':' + mobile; }
function otpHash_(mobile, purpose, code) { return sign_(purpose + ':' + mobile + ':' + code); }

/** Texts a 6-digit code (valid 10 minutes) and remembers it. data = what to save once the code is confirmed. */
function sendCode_(mobile, purpose, data) {
  if (!hit_('otp-num:' + mobile, 1, 60)) return { ok: false, error: 'Please wait a minute before asking for another code.' };
  if (!hit_('otp-hour:' + mobile, 5, 3600)) return { ok: false, error: 'Too many codes were requested for this number. Please try again later.' };
  var cap = Number(PropertiesService.getScriptProperties().getProperty('OTP_6H_CAP')) || 150;
  if (!hit_('otp-6h', cap, 21600)) return { ok: false, error: 'The sign-up service is very busy. Please try again later, or sign up at the Municipal Hall.' };

  var provider = providerName_();
  if (provider === 'OUTBOX') return { ok: false, error: 'Text messages are not set up yet.' };

  var code = newCode_(), cache = CacheService.getScriptCache(), key = otpKey_(mobile, purpose);
  cache.put(key, JSON.stringify({ h: otpHash_(mobile, purpose, code), n: 0, d: data || null }), 600);
  var status = 'FAILED';
  try {
    status = sendBatch_(provider, [mobile], 'Isabel LGU code: ' + code + ' (valid for 10 minutes). Do not share this code with anyone.', 'ADVISORY');
  } catch (e) { status = 'FAILED: ' + String(e).substring(0, 100); }
  if (!/^ACCEPTED/.test(status)) {
    cache.remove(key);
    console.error('OTP send failed: ' + status);
    return { ok: false, error: 'We could not send the code. Please try again later.' };
  }
  return { ok: true };
}

/** Returns the stored data object when the code is right (and uses the code up), or null. Five tries per code. */
function checkCode_(mobile, purpose, code) {
  var cache = CacheService.getScriptCache(), key = otpKey_(mobile, purpose), raw = cache.get(key);
  if (!raw || !/^\d{6}$/.test(String(code || ''))) return null;
  var o;
  try { o = JSON.parse(raw); } catch (e) { cache.remove(key); return null; }
  if (o.n >= 5) { cache.remove(key); return null; }
  if (sameStr_(o.h, otpHash_(mobile, purpose, String(code)))) { cache.remove(key); return { d: o.d }; }
  o.n++;
  cache.put(key, JSON.stringify(o), 600);
  return null;
}

/* ---------- Subscribers ---------- */

function saveSubscriber_(name, barangay, mobile) {
  withLock_(function () {
    var sh = sheet_(SHEET_SUBS), row = findRow_(sh, 4, mobile);
    // The first column is also the consent timestamp, so it is refreshed on every confirmed sign-up.
    // Column F counts texts that failed in a row; a confirmed sign-up starts it again at 0.
    if (row) sh.getRange(row, 1, 1, 6).setValues([[new Date(), name, barangay, mobile, 'ACTIVE', 0]]);
    else sh.appendRow([new Date(), name, barangay, mobile, 'ACTIVE', 0]);
  });
}

function setSubscriberStatus_(mobile, status) {
  withLock_(function () {
    var sh = sheet_(SHEET_SUBS), row = findRow_(sh, 4, mobile);
    if (row) sh.getRange(row, 5).setValue(status);
  });
}

function subscribe_(b) {
  if (b.website) return { ok: true }; // honeypot: bots fill this hidden field
  if (b.consent !== true) return { ok: false, error: 'Consent is required.' };

  var name = cleanName_(b.name, 80);
  var barangay = canonBarangay_(b.barangay);
  var mobile = normalizeMobile_(b.mobile);
  if (!name) return { ok: false, error: 'Please enter your name (letters only).' };
  if (!barangay) return { ok: false, error: 'Please choose your barangay from the list.' };
  if (!mobile) return { ok: false, error: 'Enter a valid PH mobile number (e.g. 09171234567).' };
  if (!hit_('sub-all', 60, 60)) return busy_();

  if (!otpRequired_()) {
    // No way to verify the number, so never overwrite someone who is already subscribed.
    var sh = sheet_(SHEET_SUBS), row = findRow_(sh, 4, mobile);
    if (row && sh.getRange(row, 5).getValue() === 'ACTIVE') return { ok: true };
    saveSubscriber_(name, barangay, mobile);
    return { ok: true };
  }

  if (!isV2_(b)) return refreshError_();
  var sent = sendCode_(mobile, 'sub', { name: name, barangay: barangay });
  if (!sent.ok) return sent;
  return { ok: true, needCode: true };
}

function confirmSubscribe_(b) {
  var mobile = normalizeMobile_(b.mobile);
  if (!mobile) return { ok: false, error: 'Enter a valid PH mobile number.' };
  if (!hit_('confirm-all', 120, 60)) return busy_();
  var o = checkCode_(mobile, 'sub', String(b.code || '').replace(/\D/g, ''));
  if (!o || !o.d) return { ok: false, error: 'Wrong or expired code. Please check the text message and try again.' };
  saveSubscriber_(o.d.name, o.d.barangay, mobile);
  return { ok: true };
}

function unsubscribe_(b) {
  var mobile = normalizeMobile_(b.mobile);
  if (!mobile) return { ok: false, error: 'Enter a valid PH mobile number.' };
  if (!hit_('unsub-all', 60, 60) || !hit_('unsub:' + mobile, 5, 3600)) return busy_();

  if (!otpRequired_()) {
    setSubscriberStatus_(mobile, 'UNSUBSCRIBED');
    return { ok: true };
  }
  if (!isV2_(b)) return refreshError_();
  var sh = sheet_(SHEET_SUBS), row = findRow_(sh, 4, mobile);
  if (row && sh.getRange(row, 5).getValue() === 'ACTIVE') sendCode_(mobile, 'unsub', null); // result ignored on purpose
  // Same answer whether or not the number exists, so nobody can probe the list.
  return { ok: true, needCode: true };
}

function confirmUnsubscribe_(b) {
  var mobile = normalizeMobile_(b.mobile);
  if (!mobile) return { ok: false, error: 'Enter a valid PH mobile number.' };
  if (!hit_('confirm-all', 120, 60)) return busy_();
  var o = checkCode_(mobile, 'unsub', String(b.code || '').replace(/\D/g, ''));
  if (!o) return { ok: false, error: 'Wrong or expired code. Please check the text message and try again.' };
  setSubscriberStatus_(mobile, 'UNSUBSCRIBED');
  return { ok: true };
}

/* ---------- Alerts ---------- */

function activeAlerts_() {
  var sh = sheet_(SHEET_ALERTS);
  var data = sh.getDataRange().getValues();
  var now = new Date();
  var out = [];
  for (var i = 1; i < data.length; i++) {
    var r = data[i];
    // Columns: ID, Created, Severity, Title, Message, Barangays, Status, PostedBy, ExpiresAt, SMS
    if (r[6] !== 'ACTIVE') continue;
    if (r[8] && new Date(r[8]) < now) continue;
    out.push({
      id: String(r[0]),
      created: new Date(r[1]).toISOString(),
      severity: r[2],
      title: uncell_(r[3]),
      message: uncell_(r[4]),
      barangays: r[5] || 'ALL',
      postedBy: r[7]
    });
  }
  out.sort(function (a, b) { return a.created < b.created ? 1 : -1; });
  return out.slice(0, 5);
}

/** Returns an error object when the PIN is wrong or locked, otherwise null. Locks one officer, not everybody. */
function checkPin_(officer, pin, what) {
  var k = 'pin:' + officer;
  if (locked_(k, PIN_MAX_FAILS)) return { ok: false, error: 'Too many wrong PIN attempts. Try again in 15 minutes.' };
  if (!pinOk_(pin)) {
    noteFail_(k, FAIL_WINDOW_SEC);
    audit_(officer, 'PIN_FAIL', what, '');
    return { ok: false, error: 'Wrong alert PIN.' };
  }
  clearFails_(k);
  return null;
}

function publish_(b) {
  var officer = officerFromToken_(b.token);
  if (!officer) return authError_();
  var pinErr = checkPin_(officer, b.pin, 'publish');
  if (pinErr) return pinErr;

  var severity = String(b.severity || 'EMERGENCY').toUpperCase();
  if (SEVERITIES.indexOf(severity) < 0) severity = 'EMERGENCY';
  var title = clean_(b.title, 120);
  var message = clean_(b.message, 800);
  var bl = canonBarangayList_(b.barangays);
  if (bl.error) return { ok: false, error: bl.error };
  var hours = Math.min(Math.max(Number(b.expiresHours) || 12, 1), 168);
  if (!title || !message) return { ok: false, error: 'Title and message are required.' };

  // A double tap (or a retry after a slow connection) must not text everybody twice.
  if (!hit_('pub:' + sign_(title + '|' + message).substring(0, 40), 1, 90)) {
    return { ok: false, error: 'This same alert was just published. Please wait a moment before sending it again.' };
  }

  var id = newId_('A');
  var expires = new Date(Date.now() + hours * 3600 * 1000);

  // 1) Record the alert first, so the banner appears even if the SMS provider is down.
  withLock_(function () {
    sheet_(SHEET_ALERTS).appendRow([id, new Date(), severity, cellSafe_(title), cellSafe_(message), bl.value, 'ACTIVE', officer, expires, 'pending']);
    bumpVersion_();
  });

  // 2) Send the texts outside the lock, so likes and comments are not blocked meanwhile.
  var result = { ok: true, id: id, sms: null };
  if (b.sendSms === true) {
    try {
      result.sms = sendAlertSms_(id, severity, title, message, bl.value);
    } catch (e) {
      console.error('SMS failed: ' + (e && e.stack ? e.stack : e));
      result.sms = { mode: 'ERROR', recipients: 0, status: 'FAILED: ' + String(e).substring(0, 100) };
    }
  }
  var smsCell = result.sms ? result.sms.mode + ':' + result.sms.recipients +
    (result.sms.status && !/^(ACCEPTED|QUEUED)/.test(result.sms.status) ? ' (' + String(result.sms.status).substring(0, 60) + ')' : '') : 'no sms';
  withLock_(function () {
    var sh = sheet_(SHEET_ALERTS), row = findRow_(sh, 1, id);
    if (row) sh.getRange(row, 10).setValue(smsCell);
  });

  audit_(officer, 'ALERT_PUBLISHED', id, severity + ' | ' + bl.value + ' | ' + title + ' | sms=' + smsCell);
  return result;
}

function resolve_(b) {
  var officer = officerFromToken_(b.token);
  if (!officer) return authError_();
  var pinErr = checkPin_(officer, b.pin, 'resolve');
  if (pinErr) return pinErr;
  var id = String(b.id || '');
  var found = false;
  withLock_(function () {
    var sh = sheet_(SHEET_ALERTS), row = findRow_(sh, 1, id);
    if (row) { sh.getRange(row, 7).setValue('RESOLVED'); found = true; }
  });
  if (!found) return { ok: false, error: 'Alert not found.' };
  dropCaches_();
  audit_(officer, 'ALERT_ENDED', id, '');
  return { ok: true };
}

/* ---------- SMS ---------- */

/** Officers can reopen the message and numbers of an alert after closing the "Alert Published" box. */
function smsInfo_(b) {
  var officer = officerFromToken_(b.token);
  if (!officer) return authError_();
  var id = String(b.id || '');
  if (!id) return { ok: false, error: 'Missing alert ID.' };
  var data = sheet_(SHEET_OUTBOX).getDataRange().getValues();
  var numbers = [], text = '', status = '';
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][1]) !== id) continue;
    numbers.push(String(data[i][2]));
    text = String(data[i][3]);
    status = String(data[i][4]);
  }
  audit_(officer, 'SMS_LIST_VIEWED', id, numbers.length + ' numbers');
  return { ok: true, recipients: numbers.length, text: text, numbers: numbers.join(','), status: status };
}

function sendAlertSms_(id, severity, title, message, barangays) {
  var text = '[ISABEL LGU ' + severity + '] ' + title + ' - ' + message;
  if (text.length > SMS_MAX_CHARS) text = text.substring(0, SMS_MAX_CHARS - 3) + '...';

  var recipients = recipientsFor_(barangays);
  var provider = providerName_();
  var outbox = sheet_(SHEET_OUTBOX);
  var now = new Date();

  if (provider === 'OUTBOX' || recipients.length === 0) {
    recipients.forEach(function (m) { outbox.appendRow([now, id, m, text, 'QUEUED_MANUAL']); });
    return { mode: 'OUTBOX', recipients: recipients.length, text: text, numbers: recipients.join(',') };
  }

  var track = [];
  var status = sendBatch_(provider, recipients, text, severity, track);

  // One row per number, with the provider's message id, so checkDelivery can follow each text up later.
  var byNumber = {};
  track.forEach(function (t) { if (t.mobile) byNumber[t.mobile] = t; });
  var rows = recipients.map(function (m, i) {
    var t = byNumber[m];
    if (!t && track.length === recipients.length) t = track[i]; // provider answered in the same order
    return t && t.id ? [now, id, m, text, status, t.id, niceStatus_(t.status) || 'Pending', '']
                     : [now, id, m, text, status, '', 'NO_ID', 'Y'];
  });
  if (rows.length) {
    withLock_(function () { outbox.getRange(outbox.getLastRow() + 1, 1, rows.length, 8).setValues(rows); });
  }
  return { mode: provider, recipients: recipients.length, status: status };
}

/** Add more providers here. Returns a short status string for the Outbox sheet and the officer. */
function sendBatch_(provider, numbers, text, severity, track) {
  if (provider === 'SEMAPHORE') {
    var props = PropertiesService.getScriptProperties();
    var apiKey = props.getProperty('SEMAPHORE_API_KEY');
    if (!apiKey) return 'FAILED: SEMAPHORE_API_KEY not set';
    // Only send a sender name if you set one; otherwise Semaphore uses the default on your account.
    var sender = props.getProperty('SEMAPHORE_SENDER');
    // Emergencies use Semaphore's priority route (sent immediately, costs 2 credits per SMS).
    // Set SEMAPHORE_PRIORITY = false to use the normal queue instead.
    var priority = severity === 'EMERGENCY' && props.getProperty('SEMAPHORE_PRIORITY') !== 'false';
    var url = 'https://api.semaphore.co/api/v4/' + (priority ? 'priority' : 'messages');

    var accepted = 0, failed = 0, firstError = '';
    for (var i = 0; i < numbers.length; i += 100) {
      var chunk = numbers.slice(i, i + 100);
      var payload = { apikey: apiKey, number: chunk.join(','), message: text };
      if (sender) payload.sendername = sender;
      var resp = UrlFetchApp.fetch(url, { method: 'post', payload: payload, muteHttpExceptions: true });
      var body = resp.getContentText();
      var parsed = null;
      try { parsed = JSON.parse(body); } catch (e) {}
      if (resp.getResponseCode() >= 300 || !Array.isArray(parsed)) {
        failed += chunk.length;
        if (!firstError) firstError = String(body).substring(0, 140);
      } else {
        parsed.forEach(function (m) {
          var st = String(m.status || '').toLowerCase();
          if (st === 'failed' || st === 'refunded') failed++; else accepted++;
          if (track && m) track.push({ mobile: normalizeMobile_(m.recipient), id: String(m.message_id || ''), status: String(m.status || '') });
        });
      }
    }
    return (failed ? 'PARTIAL/FAILED: ' : 'ACCEPTED: ') + accepted + ' accepted by Semaphore, ' + failed + ' failed' +
      (priority ? ' (priority route)' : '') + (firstError ? ' - ' + firstError : '');
  }
  return 'FAILED: unknown provider ' + provider;
}

function recipientsFor_(barangays) {
  var all = String(barangays).trim().toUpperCase() === 'ALL';
  var wanted = String(barangays).split(',').map(function (s) { return s.trim().toLowerCase(); })
    .filter(function (s) { return s; });
  var data = sheet_(SHEET_SUBS).getDataRange().getValues();
  var out = [];
  for (var i = 1; i < data.length; i++) {
    if (data[i][4] !== 'ACTIVE') continue;
    // Old rows may hold free-typed barangays, so compare their official spelling when there is one.
    var b = (canonBarangay_(data[i][2]) || String(data[i][2]).trim()).toLowerCase();
    if (all || wanted.indexOf(b) >= 0) out.push(String(data[i][3]));
  }
  return out;
}

/* ---------- Officer login (tokens are signed here; passcodes never reach the page) ---------- */

function officers_() {
  try {
    var o = JSON.parse(PropertiesService.getScriptProperties().getProperty('OFFICERS') || '{}');
    return (o && typeof o === 'object') ? o : {};
  } catch (e) { return {}; }
}

function sameStr_(a, b) {
  a = String(a); b = String(b);
  var diff = a.length ^ b.length;
  for (var i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

function tokenSecret_() {
  var props = PropertiesService.getScriptProperties();
  var sec = props.getProperty('TOKEN_SECRET');
  if (!sec) { sec = Utilities.getUuid() + Utilities.getUuid(); props.setProperty('TOKEN_SECRET', sec); }
  return sec;
}

function sign_(payload) {
  return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(payload, tokenSecret_()));
}

function login_(b) {
  var code = String(b.passcode || '');
  var list = officers_(), name = '';
  if (Object.keys(list).length === 0) {
    return { ok: false, error: 'Officer logins are not set up on the server yet. Check the OFFICERS setting in Script properties (it must be valid JSON with straight quotes).' };
  }
  if (locked_('login', LOGIN_MAX_FAILS)) {
    if (hit_('audit-lock', 1, 900)) audit_('', 'LOGIN_LOCKED', '', 'too many failed logins');
    return { ok: false, error: 'Too many failed logins. Please wait 15 minutes, or ask the administrator to run unlockAll().' };
  }
  Object.keys(list).forEach(function (k) { if (code && sameStr_(code, k)) name = String(list[k]); });
  if (!name) {
    noteFail_('login', FAIL_WINDOW_SEC);
    if (hit_('audit-fail', 3, 300)) audit_('', 'LOGIN_FAIL', '', 'wrong passcode');
    Utilities.sleep(1000); // slows down passcode guessing
    return { ok: false, error: 'Invalid officer passcode.' };
  }
  clearFails_('login');
  audit_(name, 'LOGIN', '', '');
  var payload = Utilities.base64EncodeWebSafe(JSON.stringify({ n: name, e: Date.now() + TOKEN_HOURS * 3600 * 1000 }));
  return { ok: true, name: name, token: payload + '.' + sign_(payload), hours: TOKEN_HOURS };
}

/** Returns the officer's name for a valid, unexpired token, or '' otherwise. */
function officerFromToken_(token) {
  try {
    var parts = String(token || '').split('.');
    if (parts.length !== 2 || !sameStr_(parts[1], sign_(parts[0]))) return '';
    var data = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0])).getDataAsString());
    if (!data || !data.n || Number(data.e) < Date.now()) return '';
    // Removing someone from OFFICERS revokes their token immediately.
    var list = officers_(), still = false;
    Object.keys(list).forEach(function (k) { if (String(list[k]) === data.n) still = true; });
    return still ? String(data.n) : '';
  } catch (e) { return ''; }
}

function authError_() { return { ok: false, code: 'AUTH', error: 'Please log in as an officer again.' }; }

/* ---------- Report a concern ---------- */

/** The private Drive folder that holds report photos. Created the first time it is needed. */
function reportPhotoFolder_() {
  var it = DriveApp.getFoldersByName(REPORT_PHOTO_FOLDER);
  return it.hasNext() ? it.next() : DriveApp.createFolder(REPORT_PHOTO_FOLDER);
}

/** Checks a photo sent by the page (a JPEG as a data URL). Returns { bytes } or { error }. */
function readPhoto_(v) {
  v = String(v == null ? '' : v);
  if (!v) return { none: true };
  var m = /^data:image\/jpeg;base64,([A-Za-z0-9+\/=]+)$/.exec(v);
  if (!m || v.length > REPORT_PHOTO_MAX_BASE64) return { error: 'The photo is too large or not a photo. Please choose another one.' };
  var bytes;
  try { bytes = Utilities.base64Decode(m[1]); } catch (e) { return { error: 'The photo could not be read. Please choose another one.' }; }
  // a real JPEG starts with FF D8 FF
  if (!bytes || bytes.length < 200 || (bytes[0] & 255) !== 255 || (bytes[1] & 255) !== 216 || (bytes[2] & 255) !== 255) return { error: 'The photo could not be read. Please choose another one.' };
  return { bytes: bytes };
}

/** "lat,lng" inside the Philippines, or '' */
function cleanLoc_(v) {
  var m = /^(-?\d{1,2}\.\d{1,6}),(-?\d{1,3}\.\d{1,6})$/.exec(String(v || '').trim());
  if (!m) return '';
  var lat = Number(m[1]), lng = Number(m[2]);
  return (lat >= 4 && lat <= 22 && lng >= 116 && lng <= 128) ? m[1] + ',' + m[2] : '';
}

/** Camera time from the photo, "YYYY-MM-DD HH:MM" within the last 2 years, or '' */
function cleanTaken_(v) {
  var m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(String(v || '').trim());
  if (!m) return '';
  var y = Number(m[1]), now = new Date().getFullYear();
  if (y < now - 2 || y > now + 1 || Number(m[2]) < 1 || Number(m[2]) > 12 || Number(m[3]) < 1 || Number(m[3]) > 31 || Number(m[4]) > 23 || Number(m[5]) > 59) return '';
  return m[0];
}

/** Public: a resident reports a problem. No SMS is sent, so nothing here costs credits. */
function report_(b) {
  if (b.website) return { ok: true }; // honeypot
  if (b.consent !== true) return { ok: false, error: 'Please tick the box to agree.' };
  var barangay = canonBarangay_(b.barangay);
  if (!barangay) return { ok: false, error: 'Please choose your barangay from the list.' };
  var category = REPORT_CATEGORIES.indexOf(String(b.category)) >= 0 ? String(b.category) : '';
  if (!category) return { ok: false, error: 'Please choose what the problem is about.' };
  var photo = readPhoto_(b.photo);
  if (photo.error) return { ok: false, error: photo.error };
  var details = cleanText_(b.details, 600);
  // a photo can say it all; without one, a short description is needed
  if (!photo.bytes && details.length < 10) return { ok: false, error: 'Please add a photo or describe the problem (at least 10 characters).' };
  if (details && /https?:\/\/|www\./i.test(details)) return { ok: false, error: 'Please do not put web links in the report.' };
  var name = cleanName_(b.name, 60);
  var contact = clean_(b.contact, 40).replace(/[^0-9+\-() ]/g, '').trim();
  var loc = cleanLoc_(b.loc);
  // where and when the photo was taken, read from the photo itself by the page (only kept when a photo is sent)
  var photoGps = photo.bytes ? cleanLoc_(b.photoGps) : '', photoTaken = photo.bytes ? cleanTaken_(b.photoTaken) : '';
  if (!hit_('rep-hr', REPORT_MAX_PER_HOUR, 3600)) return busy_();
  if (photo.bytes && !hit_('rep-photo-hr', REPORT_PHOTOS_PER_HOUR, 3600)) return busy_();
  // the same report sent twice within an hour is counted once (double taps, bots)
  var sig = barangay + '|' + details.toLowerCase() + '|' + (photo.bytes ? photo.bytes.length + ':' + String(b.photo).substring(120, 180) : '');
  if (!hit_('rep-d:' + sign_(sig).substring(0, 24), 1, 3600)) return { ok: true };
  var id = newId_('R'), fileId = '';
  if (photo.bytes) {
    try {
      var file = reportPhotoFolder_().createFile(Utilities.newBlob(photo.bytes, 'image/jpeg', id + '.jpg'));
      fileId = file.getId();
    } catch (e) {
      console.error('report photo not saved: ' + e);
      return { ok: false, error: 'The photo could not be saved. Please try again, or send the report without a photo.' };
    }
  }
  return withLock_(function () {
    var sh = sheet_(SHEET_REPORTS);
    ensureReportColumns_(sh);
    sh.appendRow([id, new Date(), barangay, category, cellSafe_(details), cellSafe_(name), cellSafe_(contact), 'NEW', '', new Date(), fileId, loc, photoGps, photoTaken]);
    return { ok: true, ref: id };
  });
}

/** Reports sheets made before photos existed lack the Photo ID / Location / Photo GPS / Photo Taken columns. */
function ensureReportColumns_(sh) {
  if (String(sh.getRange(1, 11).getValue()) !== 'Photo ID') sh.getRange(1, 11, 1, 4).setValues([['Photo ID', 'Location', 'Photo GPS', 'Photo Taken']]);
  else if (String(sh.getRange(1, 13).getValue()) !== 'Photo GPS') sh.getRange(1, 13, 1, 2).setValues([['Photo GPS', 'Photo Taken']]);
  // keep the camera time as plain text so Sheets does not turn it into a date
  try { if (typeof sh.getRange(1, 14).setNumberFormat === 'function') sh.getRange(2, 14, Math.max(1, sh.getMaxRows() - 1), 1).setNumberFormat('@'); } catch (e) {}
}

/** Officers: the newest reports first (at most 200). */
function listReports_(b) {
  var officer = officerFromToken_(b.token); if (!officer) return authError_();
  var sh = sheet_(SHEET_REPORTS), last = sh.getLastRow();
  if (last < 2) return { ok: true, reports: [] };
  var from = Math.max(2, last - 199);
  var rows = sh.getRange(from, 1, last - from + 1, 14).getValues(), out = [];
  for (var i = rows.length - 1; i >= 0; i--) {
    var r = rows[i];
    out.push({
      id: String(r[0]), created: r[1] instanceof Date ? Utilities.formatDate(r[1], 'Asia/Manila', "MMM d, yyyy 'at' h:mm a") : String(r[1]),
      barangay: String(r[2]), category: String(r[3]), details: uncell_(r[4]), name: uncell_(r[5]), contact: uncell_(r[6]),
      status: String(r[7] || 'NEW'), by: String(r[8] || ''), hasPhoto: !!r[10], loc: cleanLoc_(r[11]),
      photoGps: cleanLoc_(r[12]),
      photoTaken: r[13] instanceof Date ? Utilities.formatDate(r[13], 'Asia/Manila', 'yyyy-MM-dd HH:mm') : cleanTaken_(r[13]),
      createdMs: r[1] instanceof Date ? r[1].getTime() : 0
    });
  }
  return { ok: true, reports: out };
}

/** Officers: mark a report as seen / in progress / done / spam. */
function setReportStatus_(b) {
  var officer = officerFromToken_(b.token); if (!officer) return authError_();
  var status = REPORT_STATUSES.indexOf(String(b.status)) >= 0 ? String(b.status) : '';
  if (!status) return { ok: false, error: 'Unknown status.' };
  var id = clean_(b.id, 30);
  return withLock_(function () {
    var sh = sheet_(SHEET_REPORTS), row = findRow_(sh, 1, id);
    if (!row) return { ok: false, error: 'That report no longer exists.' };
    sh.getRange(row, 8, 1, 3).setValues([[status, officer, new Date()]]);
    audit_(officer, 'REPORT_' + status.replace(' ', '_'), id, '');
    return { ok: true };
  });
}

/** Officers: the photo of one report, as a data URL. Photos are fetched one at a time to keep lists fast. */
function getReportPhoto_(b) {
  var officer = officerFromToken_(b.token); if (!officer) return authError_();
  var sh = sheet_(SHEET_REPORTS), row = findRow_(sh, 1, clean_(b.id, 30));
  if (!row) return { ok: false, error: 'That report no longer exists.' };
  var fileId = String(sh.getRange(row, 11).getValue() || '');
  if (!fileId) return { ok: false, error: 'This report has no photo.' };
  try {
    var blob = DriveApp.getFileById(fileId).getBlob();
    return { ok: true, photo: 'data:image/jpeg;base64,' + Utilities.base64Encode(blob.getBytes()) };
  } catch (e) {
    console.error('report photo missing: ' + e);
    return { ok: false, error: 'The photo is no longer available.' };
  }
}

/** Deletes reports older than maxAgeMs together with their photos. Returns how many reports were removed. */
function purgeOldReports_(maxAgeMs) {
  var sh = sheet_(SHEET_REPORTS), last = sh.getLastRow();
  if (last < 2) return 0;
  var vals = sh.getRange(2, 1, last - 1, 12).getValues(), cutoff = Date.now() - maxAgeMs, n = 0;
  for (var i = vals.length - 1; i >= 0; i--) {
    var t = ms_(vals[i][1]);
    if (t && t < cutoff) {
      var fid = String(vals[i][10] || '');
      if (fid) { try { DriveApp.getFileById(fid).setTrashed(true); } catch (e) {} }
      sh.deleteRow(i + 2); n++;
    }
  }
  return n;
}

/* ---------- Audit trail ---------- */

function audit_(officer, action, target, detail) {
  try {
    sheet_(SHEET_AUDIT).appendRow([new Date(), cellSafe_(officer || ''), action, cellSafe_(String(target || '').substring(0, 80)), cellSafe_(String(detail || '').substring(0, 300))]);
  } catch (e) { console.error('audit failed: ' + e); }
}

function settingSummary_(key, val) {
  if (key === 'hotlines') return val.map(function (h) { return h.title + ': ' + h.phone; }).join(' | ');
  if (/^svc:/.test(key)) return [val.title, val.category, val.subtitle, val.phone ? ('tel ' + val.phone) : '(no phone)', val.image ? '(photo set)' : '(no photo)'].join(' | ');
  return JSON.stringify(val);
}

/* ---------- Shared state ---------- */

function dataVersion_() { return Number(PropertiesService.getScriptProperties().getProperty('DATA_VERSION') || 0); }
function bumpVersion_() {
  var props = PropertiesService.getScriptProperties();
  props.setProperty('DATA_VERSION', String(dataVersion_() + 1));
  dropCaches_();
}
function initialized_() { return PropertiesService.getScriptProperties().getProperty('INITIALIZED') === '1'; }

function state_() {
  var init = initialized_();
  return {
    ok: true, v: dataVersion_(), empty: !init, alerts: activeAlerts_(),
    posts: init ? readPosts_() : [], settings: init ? readSettings_() : {}
  };
}

/* ---------- Posts ---------- */

function readPosts_() {
  var data = sheet_(SHEET_POSTS).getDataRange().getValues(), out = [];
  for (var i = 1; i < data.length; i++) {
    if (data[i][3] !== 'LIVE') continue;
    try { out.push(JSON.parse(data[i][4])); } catch (e) {}
  }
  out.sort(function (a, b) { return a.createdAt < b.createdAt ? 1 : -1; });
  return out.slice(0, MAX_POSTS);
}

function loadPost_(sh, id) {
  var row = findRow_(sh, 1, String(id || ''));
  if (!row || sh.getRange(row, 4).getValues()[0][0] !== 'LIVE') return null;
  return { row: row, post: JSON.parse(sh.getRange(row, 5).getValues()[0][0]) };
}

function storePost_(sh, row, post) {
  sh.getRange(row, 3, 1, 3).setValues([[new Date(), 'LIVE', JSON.stringify(post)]]);
}

function cleanImageUrl_(v) {
  v = String(v || '').trim();
  return /^https?:\/\/[^\s"'<>]{1,480}$/i.test(v) ? v : '';
}

function stamp_() { return Utilities.formatDate(new Date(), 'Asia/Manila', "MMM d, yyyy 'at' h:mm a"); }
function newId_(prefix) {
  return prefix + Utilities.formatDate(new Date(), 'Asia/Manila', 'yyMMddHHmmss') + ('00' + Math.floor(Math.random() * 1000)).slice(-3);
}

function postFields_(b) {
  var title = clean_(b.title, 150), content = cleanText_(b.content, 3000);
  if (!title || !content) return { error: 'Title and details are required.' };
  var category = CATEGORIES.indexOf(b.category) >= 0 ? b.category : 'PUBLIC SAFETY';
  return { title: title, content: content, category: category, image: cleanImageUrl_(b.image) };
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function needInit_() {
  return initialized_() ? null : { ok: false, code: 'NOT_INITIALIZED', error: 'The shared site has no content yet. Publish this device\'s content first.' };
}

function createPost_(b) {
  var officer = officerFromToken_(b.token); if (!officer) return authError_();
  var ni = needInit_(); if (ni) return ni;
  var f = postFields_(b); if (f.error) return { ok: false, error: f.error };
  return withLock_(function () {
    var post = { id: newId_('P'), author: officer, category: f.category, timestamp: stamp_(), createdAt: new Date().toISOString(),
      title: f.title, content: f.content, image: f.image, likes: 0, shares: 0, pinned: b.pinned === true, comments: [] };
    sheet_(SHEET_POSTS).appendRow([post.id, new Date(), new Date(), 'LIVE', JSON.stringify(post)]);
    bumpVersion_();
    audit_(officer, 'POST_CREATED', post.id, f.title);
    return { ok: true, post: post };
  });
}

function updatePost_(b) {
  var officer = officerFromToken_(b.token); if (!officer) return authError_();
  var f = postFields_(b); if (f.error) return { ok: false, error: f.error };
  return withLock_(function () {
    var sh = sheet_(SHEET_POSTS), found = loadPost_(sh, b.id);
    if (!found) return { ok: false, error: 'That post no longer exists.' };
    found.post.title = f.title; found.post.content = f.content; found.post.category = f.category; found.post.image = f.image;
    storePost_(sh, found.row, found.post); bumpVersion_();
    audit_(officer, 'POST_EDITED', found.post.id, f.title);
    return { ok: true, post: found.post };
  });
}

function pinPost_(b) {
  var officer = officerFromToken_(b.token); if (!officer) return authError_();
  return withLock_(function () {
    var sh = sheet_(SHEET_POSTS), found = loadPost_(sh, b.id);
    if (!found) return { ok: false, error: 'That post no longer exists.' };
    found.post.pinned = b.pinned === true;
    storePost_(sh, found.row, found.post); bumpVersion_();
    audit_(officer, found.post.pinned ? 'POST_PINNED' : 'POST_UNPINNED', found.post.id, found.post.title);
    return { ok: true, post: found.post };
  });
}

function deletePost_(b) {
  var officer = officerFromToken_(b.token); if (!officer) return authError_();
  return withLock_(function () {
    var sh = sheet_(SHEET_POSTS), found = loadPost_(sh, b.id);
    if (!found) return { ok: true }; // already gone
    sh.getRange(found.row, 3, 1, 2).setValues([[new Date(), 'DELETED']]); // kept in the sheet as an audit trail
    bumpVersion_();
    audit_(officer, 'POST_DELETED', found.post.id, found.post.title);
    return { ok: true };
  });
}

function likePost_(b) {
  var id = clean_(b.id, 40);
  if (!hit_('like-all', 120, 60) || !hit_('like-post:' + id, 40, 60)) return { ok: false, error: 'Please slow down.' };
  return withLock_(function () {
    var sh = sheet_(SHEET_POSTS), found = loadPost_(sh, id);
    if (!found) return { ok: false, error: 'That post no longer exists.' };
    found.post.likes = Number(found.post.likes || 0) + 1;
    storePost_(sh, found.row, found.post); // no version bump: like counts refresh at the next full load
    return { ok: true, likes: found.post.likes };
  });
}

function addComment_(b) {
  var text = clean_(b.text, 300);
  if (!text) return { ok: false, error: 'Write a comment first.' };
  var id = clean_(b.id, 40);
  var officer = officerFromToken_(b.token);
  if (!officer) {
    if (/https?:\/\/|www\./i.test(text)) return { ok: false, error: 'Links are not allowed in public comments.' };
    if (!hit_('c-all', 30, 60) || !hit_('c-post:' + id, 8, 60) || !hit_('c-hour', 400, 3600)) {
      return { ok: false, error: 'Too many comments right now. Please try again in a minute.' };
    }
  }
  // The name is never taken from the browser, so nobody can sign a comment as "MDRRMO Isabel".
  var author = officer || 'Isabel Citizen';
  return withLock_(function () {
    var sh = sheet_(SHEET_POSTS), found = loadPost_(sh, id);
    if (!found) return { ok: false, error: 'That post no longer exists.' };
    if (found.post.comments.length >= MAX_COMMENTS) return { ok: false, error: 'Comments are closed on this post.' };
    found.post.comments.push({ id: newId_('C'), author: author, text: text, official: !!officer });
    if (JSON.stringify(found.post).length > CELL_LIMIT) return { ok: false, error: 'Comments are closed on this post.' };
    storePost_(sh, found.row, found.post); bumpVersion_();
    return { ok: true, post: found.post };
  });
}

function deleteComment_(b) {
  var officer = officerFromToken_(b.token); if (!officer) return authError_();
  return withLock_(function () {
    var sh = sheet_(SHEET_POSTS), found = loadPost_(sh, b.id);
    if (!found) return { ok: false, error: 'That post no longer exists.' };
    found.post.comments = found.post.comments.filter(function (c) { return c.id !== b.commentId; });
    storePost_(sh, found.row, found.post); bumpVersion_();
    audit_(officer, 'COMMENT_DELETED', found.post.id, String(b.commentId || '').substring(0, 30));
    return { ok: true, post: found.post };
  });
}

/* ---------- Settings (header, hours, hotlines, quick-service cards) ---------- */

function cleanSetting_(key, v) {
  if (v == null || typeof v !== 'object') return null;
  if (key === 'header') {
    var t = clean_(v.title, 120), st = clean_(v.subtitle, 200);
    return t && st ? { title: t, subtitle: st } : null;
  }
  if (key === 'schedule') {
    var w = clean_(v.weekday, 120), we = clean_(v.weekend, 120), l = clean_(v.location, 160);
    return w && we && l ? { weekday: w, weekend: we, location: l } : null;
  }
  if (key === 'hotlines') {
    if (!Array.isArray(v) || v.length < 1 || v.length > 12) return null;
    var out = [];
    for (var i = 0; i < v.length; i++) {
      var h = v[i] || {}, title = clean_(h.title, 60), phone = clean_(h.phone, 60);
      if (!title || !phone) return null;
      out.push({ id: clean_(h.id, 20) || ('h' + (i + 1)), icon: clean_(h.icon, 8), title: title, desc: clean_(h.desc, 80),
        phone: phone, tel: String(h.tel || '').replace(/[^0-9+]/g, '').substring(0, 20) });
    }
    return out;
  }
  if (/^svc:/.test(key)) {
    var ti = clean_(v.title, 80), cat = clean_(v.category, 60), sub = clean_(v.subtitle, 120);
    if (!ti || !cat || !sub) return null;
    var img = String(v.image || '').trim();
    if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+\/=]+$/.test(img)) img = cleanImageUrl_(img);
    if (img.length > 42000) img = '';
    return { key: key.substring(4), category: cat, color: clean_(v.color, 12), title: ti, subtitle: sub, image: img,
      phone: clean_(v.phone, 60), loc: clean_(v.loc, 120) };
  }
  return null;
}

function validSettingKey_(key) { return /^(header|schedule|hotlines|svc:[a-z0-9_-]{1,30})$/i.test(String(key || '')); }

function readSettings_() {
  var data = sheet_(SHEET_SETTINGS).getDataRange().getValues();
  var out = { services: [] }, svcs = [];
  for (var i = 1; i < data.length; i++) {
    var key = String(data[i][0]), val;
    try { val = JSON.parse(data[i][3]); } catch (e) { continue; }
    if (/^svc:/.test(key)) svcs.push({ order: Number(data[i][1]) || 0, val: val });
    else out[key] = val;
  }
  svcs.sort(function (a, b) { return a.order - b.order; });
  out.services = svcs.map(function (x) { return x.val; });
  return out;
}

function writeSetting_(sh, key, val, order) {
  var json = JSON.stringify(val);
  if (json.length > CELL_LIMIT) return false;
  var row = findRow_(sh, 1, key);
  if (row) sh.getRange(row, 2, 1, 3).setValues([[order, new Date(), json]]);
  else sh.appendRow([key, order, new Date(), json]);
  return true;
}

function saveSetting_(b) {
  var officer = officerFromToken_(b.token); if (!officer) return authError_();
  var ni = needInit_(); if (ni) return ni;
  if (!validSettingKey_(b.key)) return { ok: false, error: 'Unknown setting.' };
  var val = cleanSetting_(b.key, b.value);
  if (!val) return { ok: false, error: 'Some required fields are missing or invalid.' };
  return withLock_(function () {
    var sh = sheet_(SHEET_SETTINGS), order = 0;
    if (/^svc:/.test(b.key)) {
      var row = findRow_(sh, 1, b.key);
      if (!row) return { ok: false, error: 'That office card does not exist.' };
      order = Number(sh.getRange(row, 2).getValues()[0][0]) || 0;
    }
    if (!writeSetting_(sh, b.key, val, order)) return { ok: false, error: 'Too large to save. Use a smaller photo.' };
    bumpVersion_();
    audit_(officer, 'SETTING_SAVED', b.key, settingSummary_(b.key, val));
    return { ok: true, value: val };
  });
}

/** One-time publish of content from an officer's browser, only while the shared site is still empty. */
function importState_(b) {
  var officer = officerFromToken_(b.token); if (!officer) return authError_();
  return withLock_(function () {
    if (initialized_()) return { ok: false, error: 'The shared site already has content.' };
    var notes = [], posts = Array.isArray(b.posts) ? b.posts.slice(0, MAX_POSTS) : [];
    var psh = sheet_(SHEET_POSTS), now = Date.now(), n = 0;
    posts.reverse().forEach(function (p, i) { // oldest first so createdAt stays in display order
      p = p || {};
      var f = postFields_(p); if (f.error) return;
      var comments = (Array.isArray(p.comments) ? p.comments : []).slice(0, MAX_COMMENTS).map(function (c, j) {
        return { id: newId_('C') + j, author: clean_(c && c.author, 40) || 'Isabel Citizen', text: clean_(c && c.text, 300) };
      }).filter(function (c) { return c.text; });
      var post = { id: newId_('P') + i, author: clean_(p.author, 80) || 'LGU Officer', category: f.category,
        timestamp: clean_(p.timestamp, 40) || stamp_(), createdAt: new Date(now + i).toISOString(), title: f.title, content: f.content,
        image: f.image, likes: Math.max(0, Math.min(Number(p.likes) || 0, 1000000)), shares: Math.max(0, Math.min(Number(p.shares) || 0, 1000000)),
        pinned: p.pinned === true, comments: comments };
      psh.appendRow([post.id, new Date(), new Date(), 'LIVE', JSON.stringify(post)]); n++;
    });

    var ssh = sheet_(SHEET_SETTINGS), st = b.settings || {};
    ['header', 'schedule', 'hotlines'].forEach(function (k) {
      var v = cleanSetting_(k, st[k]);
      if (v) writeSetting_(ssh, k, v, 0); else if (st[k]) notes.push('Skipped invalid ' + k);
    });
    (Array.isArray(st.services) ? st.services : []).slice(0, 20).forEach(function (svc, i) {
      var key = clean_(svc && svc.key, 30).replace(/[^a-z0-9_-]/gi, '');
      if (!key) return;
      var v = cleanSetting_('svc:' + key, svc);
      if (!v) { notes.push('Skipped card ' + key); return; }
      if (svc.image && !v.image) notes.push('Photo on "' + v.title + '" was too large; add it again');
      writeSetting_(ssh, 'svc:' + key, v, i + 1);
    });
    PropertiesService.getScriptProperties().setProperty('INITIALIZED', '1');
    bumpVersion_();
    audit_(officer, 'SITE_IMPORTED', '', n + ' posts');
    return { ok: true, posts: n, notes: notes };
  });
}

/* ---------- Helpers ---------- */

function pinOk_(pin) {
  var real = PropertiesService.getScriptProperties().getProperty('ALERT_PIN');
  if (!real || !pin) return false;
  return sameStr_(String(pin), String(real));
}

function sheet_(name) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name);
  if (sh) return sh;
  sh = ss.insertSheet(name);
  var headers = {};
  headers[SHEET_SUBS] = ['Timestamp', 'Name', 'Barangay', 'Mobile (63...)', 'Status', 'Failed in a row'];
  headers[SHEET_ALERTS] = ['ID', 'Created', 'Severity', 'Title', 'Message', 'Barangays', 'Status', 'Posted By', 'Expires At', 'SMS'];
  headers[SHEET_OUTBOX] = ['Timestamp', 'Alert ID', 'Mobile', 'Message', 'Status', 'Message ID', 'Delivery', 'Counted'];
  headers[SHEET_POSTS] = ['ID', 'Created', 'Updated', 'Status', 'JSON'];
  headers[SHEET_SETTINGS] = ['Key', 'Order', 'Updated', 'JSON'];
  headers[SHEET_AUDIT] = ['Time', 'Officer', 'Action', 'Target', 'Detail'];
  headers[SHEET_REPORTS] = ['ID', 'Created', 'Barangay', 'Category', 'Details', 'Name', 'Contact', 'Status', 'Handled By', 'Updated', 'Photo ID', 'Location', 'Photo GPS', 'Photo Taken'];
  sh.appendRow(headers[name]);
  sh.setFrozenRows(1);
  if (name === SHEET_SUBS) sh.getRange('D:D').setNumberFormat('@'); // keep numbers as text
  return sh;
}

function findRow_(sh, col, value) {
  var vals = sh.getRange(1, col, Math.max(sh.getLastRow(), 1), 1).getValues();
  for (var i = 1; i < vals.length; i++) if (String(vals[i][0]) === value) return i + 1;
  return 0;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function jsonText_(str) {
  return ContentService.createTextOutput(str).setMimeType(ContentService.MimeType.JSON);
}

/* ====================================================================
 * ADMIN FUNCTIONS - run these by hand from the Apps Script editor
 * (pick the function in the drop-down, press Run, read View > Logs)
 * ==================================================================== */

/** Run once from the editor to create the sheets and authorize the script. */
function setup() {
  sheet_(SHEET_SUBS); sheet_(SHEET_ALERTS); sheet_(SHEET_OUTBOX); sheet_(SHEET_POSTS); sheet_(SHEET_SETTINGS); sheet_(SHEET_AUDIT);
  ensureTrackingHeaders_();
  Logger.log('Sheets ready. Next: set ALERT_PIN and OFFICERS in Project Settings > Script properties, then run installTriggers().');
}

/** Run once: daily cleanup at about 3 AM, a weekly backup on Sundays at about 2 AM, and an hourly delivery check. */
function installTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var f = t.getHandlerFunction();
    if (f === 'housekeeping' || f === 'backupSheet' || f === 'checkDelivery') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('housekeeping').timeBased().everyDays(1).atHour(3).create();
  ScriptApp.newTrigger('backupSheet').timeBased().onWeekDay(ScriptApp.WeekDay.SUNDAY).atHour(2).create();
  ScriptApp.newTrigger('checkDelivery').timeBased().everyHours(1).create();
  Logger.log('Triggers installed. In Project Settings, set the time zone to Asia/Manila so the hours above are local time.');
}

/** Deletes old rows: SMS Outbox after 30 days (it holds phone numbers), Alerts after 90 days, Audit after 1 year. */
function housekeeping() {
  var day = 86400000;
  var a = deleteOldRows_(sheet_(SHEET_OUTBOX), 1, 30 * day);
  var b = deleteOldRows_(sheet_(SHEET_ALERTS), 9, 90 * day);
  var c = deleteOldRows_(sheet_(SHEET_AUDIT), 1, 365 * day);
  var d = purgeOldReports_(REPORT_KEEP_DAYS * day);
  Logger.log('Removed ' + a + ' outbox row(s), ' + b + ' old alert(s), ' + c + ' old audit row(s), ' + d + ' old report(s).');
}

function deleteOldRows_(sh, col, maxAgeMs) {
  var last = sh.getLastRow();
  if (last < 2) return 0;
  var vals = sh.getRange(2, col, last - 1, 1).getValues(), cutoff = Date.now() - maxAgeMs, n = 0;
  for (var i = vals.length - 1; i >= 0; i--) {
    var d = vals[i][0], t = d instanceof Date ? d.getTime() : new Date(d).getTime();
    if (t && t < cutoff) { sh.deleteRow(i + 2); n++; }
  }
  return n;
}

/**
 * Copies this spreadsheet into a Drive folder "Isabel LGU Backups" and trashes copies older than 8 weeks.
 * The copy contains subscriber phone numbers, so keep that folder private.
 * Script properties (OFFICERS, ALERT_PIN, API keys) are NOT part of the copy: keep them written down safely offline.
 */
function backupSheet() {
  var file = DriveApp.getFileById(SpreadsheetApp.getActiveSpreadsheet().getId());
  var it = DriveApp.getFoldersByName('Isabel LGU Backups');
  var folder = it.hasNext() ? it.next() : DriveApp.createFolder('Isabel LGU Backups');
  file.makeCopy('Isabel LGU portal backup ' + Utilities.formatDate(new Date(), 'Asia/Manila', 'yyyy-MM-dd'), folder);
  var files = folder.getFiles(), cutoff = Date.now() - 56 * 86400000;
  while (files.hasNext()) {
    var f = files.next();
    if (f.getDateCreated().getTime() < cutoff) f.setTrashed(true);
  }
  Logger.log('Backup done.');
}

/**
 * Run ONCE after upgrading (run backupSheet() first). Fixes existing subscribers:
 *  - barangays typed freely are changed to the official spelling when they match one of the 24
 *  - names or barangays that are spreadsheet formulas are neutralised
 * Anything it cannot match (for example plain "Poblacion", which is Marvel OR Santo Niño) is listed in the log to fix by hand.
 */
function cleanupSubscribers() {
  var sh = sheet_(SHEET_SUBS), last = sh.getLastRow();
  if (last < 2) { Logger.log('No subscribers yet.'); return; }
  var rng = sh.getRange(2, 1, last - 1, 5), vals = rng.getValues();
  var forms = sh.getRange(2, 2, last - 1, 2).getFormulas();
  var names = 0, brgys = 0, unknown = {}, formulaRows = [];
  for (var i = 0; i < vals.length; i++) {
    var nameF = forms[i][0], brgyF = forms[i][1];
    if (nameF || brgyF) formulaRows.push(i + 2);
    var cleanedName = cleanName_(nameF || String(vals[i][1]), 80) || '(name removed)';
    if (cleanedName !== String(vals[i][1])) { vals[i][1] = cleanedName; names++; }
    var rawB = brgyF ? '' : String(vals[i][2]);
    var canon = canonBarangay_(rawB);
    if (canon) {
      if (canon !== rawB) { vals[i][2] = canon; brgys++; }
    } else {
      var shown = brgyF ? '(was a formula)' : (rawB || '(empty)');
      vals[i][2] = brgyF ? '(check barangay)' : vals[i][2];
      unknown[shown] = (unknown[shown] || 0) + 1;
    }
  }
  rng.setValues(vals);
  Logger.log('Names fixed: ' + names + '. Barangays set to official spelling: ' + brgys + '.');
  if (formulaRows.length) Logger.log('WARNING: formulas were found in row(s) ' + formulaRows.join(', ') + ' and were neutralised. Someone tried to inject them.');
  var keys = Object.keys(unknown);
  if (keys.length) {
    Logger.log('Fix these barangays BY HAND in the Subscribers sheet (they would not receive barangay-specific alerts):');
    keys.forEach(function (k) { Logger.log('  "' + k + '" x ' + unknown[k]); });
  } else {
    Logger.log('Every subscriber now has an official barangay.');
  }
}

/** Lifts the 15-minute lockouts (wrong passcodes / PINs) right away. */
function unlockAll() {
  clearFails_('login');
  var list = officers_();
  Object.keys(list).forEach(function (k) { clearFails_('pin:' + list[k]); });
  Logger.log('Logins and PIN attempts unlocked.');
}

/** Signs EVERY officer out immediately (all 12-hour tokens stop working). Run it if a passcode may have leaked. */
function revokeAllSessions() {
  PropertiesService.getScriptProperties().deleteProperty('TOKEN_SECRET');
  dropCaches_();
  Logger.log('All officer sessions revoked. Officers must log in again. Now change the leaked passcode in OFFICERS.');
}

/**
 * Run from the editor (select checkOfficers, press Run, then open View > Logs / Execution log)
 * to see whether OFFICERS and ALERT_PIN are valid and strong. Passcodes themselves are never printed.
 */
function checkOfficers() {
  var props = PropertiesService.getScriptProperties();
  var raw = props.getProperty('OFFICERS');
  if (!raw) { Logger.log('PROBLEM: there is no OFFICERS property. Add it under Project Settings > Script properties.'); return; }
  var parsed;
  try { parsed = JSON.parse(raw); }
  catch (e) {
    Logger.log('PROBLEM: OFFICERS is not valid JSON (' + e.message + '). Common causes: curly quotes instead of straight quotes, a missing comma, a missing closing brace.');
    if (/[\u201c\u201d\u2018\u2019]/.test(raw)) Logger.log('FOUND curly quotes in OFFICERS. Retype them as straight quotes (").');
    return;
  }
  var keys = Object.keys(parsed || {});
  if (!keys.length) { Logger.log('PROBLEM: OFFICERS is valid JSON but empty.'); return; }
  Logger.log('OFFICERS is valid. ' + keys.length + ' officer(s):');
  var pin = props.getProperty('ALERT_PIN') || '';
  keys.forEach(function (k) {
    var notes = [];
    if (k !== k.trim()) notes.push('passcode has a space at the start or end');
    if (/[^\x20-\x7e]/.test(k)) notes.push('passcode contains a non-standard character');
    if (k.length < 16) notes.push('passcode is short: use 16 or more characters');
    if (pin && k === pin) notes.push('passcode is the same as ALERT_PIN');
    Logger.log(' - ' + parsed[k] + ' (passcode length ' + k.length + ')' + (notes.length ? '  <-- ' + notes.join('; ') : ''));
  });
  if (!pin) Logger.log('PROBLEM: ALERT_PIN is not set, so alerts cannot be published.');
  else Logger.log('ALERT_PIN length ' + pin.length + (pin.length < 8 ? '  <-- too short: use 8 or more characters' : ''));
  Logger.log('SMS provider: ' + providerName_() + '. Text-message codes for sign-up: ' + (otpRequired_() ? 'ON' : 'OFF (set SMS_PROVIDER=SEMAPHORE to turn them on)') + '.');
}

/* ====================================================================
 * DEAD-NUMBER TRACKING
 * Nobody can see from outside whether a person still uses a number. What the provider CAN tell us is
 * whether each text was accepted by the network. A number that fails several alerts in a row is almost
 * certainly cancelled, so checkDelivery() (hourly trigger) switches it to FAILED and it is never texted again.
 * It cannot catch a number that was handed to a new owner (those texts still go through).
 * ==================================================================== */

function ms_(v) { return v instanceof Date ? v.getTime() : new Date(v).getTime(); }

/** Semaphore statuses: Queued, Pending, Sent (reached the network), Failed, Refunded. */
function niceStatus_(s) {
  var l = String(s == null ? '' : s).toLowerCase().trim();
  if (l === 'sent' || l === 'success' || l === 'delivered') return 'Sent';
  if (l === 'failed') return 'Failed';
  if (l === 'refunded') return 'Refunded';
  if (l === 'queued') return 'Queued';
  if (l === 'pending') return 'Pending';
  return String(s == null ? '' : s).trim();
}
function done_(g) { return g === 'Sent' || g === 'Failed' || g === 'Refunded' || g === 'TIMEOUT'; }
function bad_(g) { return g === 'Failed' || g === 'Refunded'; }

/** Adds the new columns to sheets created by an older version. Safe to run any time. */
function ensureTrackingHeaders_() {
  var ob = sheet_(SHEET_OUTBOX);
  if (!ob.getRange(1, 6).getValue()) ob.getRange(1, 6, 1, 3).setValues([['Message ID', 'Delivery', 'Counted']]);
  var sb = sheet_(SHEET_SUBS);
  if (!sb.getRange(1, 6).getValue()) sb.getRange(1, 6).setValue('Failed in a row');
}

function fetchJson_(url) {
  try {
    var r = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (r.getResponseCode() >= 300) return null;
    return JSON.parse(r.getContentText());
  } catch (e) { return null; }
}

/** Asks Semaphore for the current status of these message ids. Returns { messageId: status } for those it found. */
function semaphoreStatuses_(ids, sinceMs) {
  var apiKey = PropertiesService.getScriptProperties().getProperty('SEMAPHORE_API_KEY');
  var out = {};
  if (!apiKey || !ids.length) return out;
  var base = 'https://api.semaphore.co/api/v4/messages';
  var want = {}, left = 0;
  ids.forEach(function (i) { if (!want[i]) { want[i] = 1; left++; } });
  var start = Utilities.formatDate(new Date(sinceMs - 86400000), 'Asia/Manila', 'yyyy-MM-dd');
  var end = Utilities.formatDate(new Date(Date.now() + 86400000), 'Asia/Manila', 'yyyy-MM-dd');

  // 1) the message list (1000 per page); Semaphore allows 30 calls a minute on it
  for (var page = 1; page <= SMS_LIST_PAGES && left > 0; page++) {
    if (page > 1) Utilities.sleep(2200);
    var arr = fetchJson_(base + '?apikey=' + encodeURIComponent(apiKey) + '&limit=1000&page=' + page + '&startDate=' + start + '&endDate=' + end);
    if (!Array.isArray(arr) || !arr.length) break;
    arr.forEach(function (m) {
      var id = String(m && m.message_id);
      if (want[id] && !(id in out)) { out[id] = String(m.status || ''); left--; }
    });
    if (arr.length < 1000) break;
  }

  // 2) anything the list did not return is looked up one by one
  Object.keys(want).filter(function (i) { return !(i in out); }).slice(0, SMS_SINGLE_LOOKUPS).forEach(function (id) {
    Utilities.sleep(2200);
    var one = fetchJson_(base + '/' + encodeURIComponent(id) + '?apikey=' + encodeURIComponent(apiKey));
    var m = Array.isArray(one) ? one[0] : one;
    if (m && String(m.message_id) === id && m.status) out[id] = String(m.status);
  });
  return out;
}

/**
 * Reads the Outbox, files the latest status of every text, and counts failures per number.
 * Runs inside the script lock, so it must not call the network.
 */
function applyDelivery_(statuses) {
  var res = { checked: 0, counted: 0, deactivated: 0, anomalies: 0, timeouts: 0 };
  var ob = sheet_(SHEET_OUTBOX), last = ob.getLastRow();
  if (last < 2) return res;
  var data = ob.getRange(2, 1, last - 1, 8).getValues();
  var now = Date.now(), cutoff = now - SMS_CHECK_DAYS * 86400000;

  // group the texts that are still open by alert
  var groups = {}, order = [];
  data.forEach(function (r, i) {
    if (!r[5] || String(r[7]) !== '') return;           // no message id, or already counted
    var t = ms_(r[0]);
    if (!t || t < cutoff) return;
    var g = String(r[6] || '');
    if (!done_(g) && statuses[String(r[5])]) g = niceStatus_(statuses[String(r[5])]);
    data[i][6] = g;
    var key = String(r[1]);
    if (!groups[key]) { groups[key] = { t: t, idx: [] }; order.push(key); }
    groups[key].t = Math.min(groups[key].t, t);
    groups[key].idx.push(i);
    res.checked++;
  });
  order.sort(function (a, b) { return groups[a].t - groups[b].t; }); // oldest alert first, so "in a row" is in the right order

  var sb = sheet_(SHEET_SUBS), sLast = sb.getLastRow(), subs = null, pos = {};
  function loadSubs() {
    if (subs) return;
    subs = sLast >= 2 ? sb.getRange(2, 1, sLast - 1, 6).getValues() : [];
    subs.forEach(function (r, i) { pos[String(r[3])] = i; });
  }

  var notes = [];
  order.forEach(function (key) {
    var idx = groups[key].idx;
    var allDone = idx.every(function (i) { return done_(data[i][6]); });
    var stale = now - groups[key].t > 24 * 3600 * 1000;
    if (!allDone && !stale) return;                      // still waiting for the network: look again next hour

    var nDone = 0, nBad = 0;
    idx.forEach(function (i) {
      if (!done_(data[i][6])) { data[i][6] = 'TIMEOUT'; res.timeouts++; }
      if (data[i][6] === 'TIMEOUT') return;
      nDone++;
      if (bad_(data[i][6])) nBad++;
    });

    // Most of one alert failing means the provider had a problem (no credits, sender name blocked), not the numbers.
    if (nDone >= 5 && nBad / nDone > FAIL_BATCH_GUARD) {
      idx.forEach(function (i) { data[i][7] = 'N'; });
      res.anomalies++;
      notes.push('alert ' + key + ': ' + nBad + ' of ' + nDone + ' texts failed, so no number was blamed');
      return;
    }

    idx.forEach(function (i) {
      data[i][7] = 'Y';
      var g = data[i][6];
      if (g === 'TIMEOUT') return;
      loadSubs();
      var p = pos[String(data[i][2])];
      if (p === undefined) return;                       // the subscriber row was deleted meanwhile
      var s = subs[p];
      if (bad_(g)) {
        s[5] = (Number(s[5]) || 0) + 1;
        res.counted++;
        if (s[5] >= FAIL_LIMIT && s[4] === 'ACTIVE') { s[4] = 'FAILED'; res.deactivated++; }
      } else if (g === 'Sent') {
        s[5] = 0;
      }
    });
  });

  ob.getRange(2, 7, data.length, 2).setValues(data.map(function (r) { return [r[6], r[7]]; }));
  if (subs) sb.getRange(2, 5, subs.length, 2).setValues(subs.map(function (r) { return [r[4], r[5]]; }));
  if (res.deactivated || res.anomalies) {
    audit_('system', res.anomalies ? 'DELIVERY_ANOMALY' : 'NUMBERS_STOPPED', '',
      res.deactivated + ' number(s) switched to FAILED' + (notes.length ? ' | ' + notes.join(' | ') : ''));
  }
  res.notes = notes;
  return res;
}

/**
 * Runs every hour (installTriggers). You can also run it by hand and read View > Logs.
 * Numbers that fail FAIL_LIMIT alerts in a row become FAILED in the Subscribers sheet and stop receiving texts.
 */
function checkDelivery() {
  if (providerName_() !== 'SEMAPHORE') { Logger.log('SMS provider is not SEMAPHORE, so there is nothing to check.'); return; }
  ensureTrackingHeaders_();

  // 1) which texts are still waiting for a final status?
  var ob = sheet_(SHEET_OUTBOX), last = ob.getLastRow(), open = [], oldest = Date.now();
  if (last >= 2) {
    var cutoff = Date.now() - SMS_CHECK_DAYS * 86400000;
    ob.getRange(2, 1, last - 1, 8).getValues().forEach(function (r) {
      if (!r[5] || String(r[7]) !== '' || done_(String(r[6]))) return;
      var t = ms_(r[0]);
      if (!t || t < cutoff) return;
      open.push(String(r[5]));
      oldest = Math.min(oldest, t);
    });
  }

  // 2) ask Semaphore (outside the lock, this can take a minute)
  var statuses = semaphoreStatuses_(open, oldest);
  var found = Object.keys(statuses).length;

  // 3) file the answers
  var res = withLock_(function () { return applyDelivery_(statuses); });
  Logger.log('Texts followed up: ' + res.checked + '. Failures counted: ' + res.counted + '. Numbers stopped: ' + res.deactivated +
    '. Timed out: ' + res.timeouts + '.');
  (res.notes || []).forEach(function (n) { Logger.log('NOTE: ' + n + ' (check your Semaphore credits and sender name).'); });
  if (open.length && !found) {
    Logger.log('WARNING: Semaphore gave no status for ' + open.length + ' text(s). Check SEMAPHORE_API_KEY and that the Semaphore dashboard shows these messages.');
  }
}

/** Counts of subscribers by status, and the numbers that were stopped. Read it in View > Logs. */
function numberReport() {
  var sh = sheet_(SHEET_SUBS), last = sh.getLastRow();
  if (last < 2) { Logger.log('No subscribers yet.'); return; }
  var rows = sh.getRange(2, 1, last - 1, 6).getValues(), count = {}, warned = 0, stopped = [];
  rows.forEach(function (r) {
    count[r[4]] = (count[r[4]] || 0) + 1;
    if (r[4] === 'ACTIVE' && Number(r[5]) > 0) warned++;
    if (r[4] === 'FAILED') stopped.push(r[3] + ' (' + r[2] + ')');
  });
  Logger.log('Subscribers by status: ' + JSON.stringify(count));
  Logger.log('Still ACTIVE but failed their last text(s): ' + warned + '. They are stopped after ' + FAIL_LIMIT + ' failed alerts in a row.');
  if (stopped.length) {
    Logger.log('Stopped numbers (no longer texted): ' + stopped.length);
    stopped.forEach(function (x) { Logger.log('  ' + x); });
    Logger.log('To delete them for good, run purgeFailedNumbers(). A person can start again by signing up with the same number.');
  }
}

/** Deletes every row whose status is FAILED. They are not texted anyway; this only tidies the sheet and the personal data in it. */
function purgeFailedNumbers() {
  var n = withLock_(function () {
    var sh = sheet_(SHEET_SUBS), last = sh.getLastRow(), c = 0;
    if (last < 2) return 0;
    var st = sh.getRange(2, 5, last - 1, 1).getValues();
    for (var i = st.length - 1; i >= 0; i--) if (st[i][0] === 'FAILED') { sh.deleteRow(i + 2); c++; }
    return c;
  });
  audit_('admin', 'FAILED_NUMBERS_PURGED', '', n + ' row(s)');
  Logger.log('Deleted ' + n + ' FAILED subscriber row(s).');
}

/**
 * Deletes numbers you name. Add a Script property REMOVE_NUMBERS with the numbers separated by commas,
 * for example   09171234567, 09181234567   then run removeNumbers(). The property is cleared afterwards.
 */
function removeNumbers() {
  var props = PropertiesService.getScriptProperties();
  var list = String(props.getProperty('REMOVE_NUMBERS') || '').split(/[,;\n]+/).map(normalizeMobile_).filter(String);
  if (!list.length) { Logger.log('Add a Script property REMOVE_NUMBERS (numbers separated by commas), then run this again.'); return; }
  var n = withLock_(function () {
    var sh = sheet_(SHEET_SUBS), last = sh.getLastRow(), c = 0, want = {};
    if (last < 2) return 0;
    list.forEach(function (m) { want[m] = 1; });
    var nums = sh.getRange(2, 4, last - 1, 1).getValues();
    for (var i = nums.length - 1; i >= 0; i--) if (want[String(nums[i][0])]) { sh.deleteRow(i + 2); c++; }
    return c;
  });
  props.deleteProperty('REMOVE_NUMBERS');
  audit_('admin', 'NUMBERS_REMOVED', '', n + ' of ' + list.length + ' number(s) deleted');
  Logger.log('Deleted ' + n + ' of ' + list.length + ' number(s). ' + (n < list.length ? 'The rest were not in the Subscribers sheet.' : ''));
}

/**
 * Run from the editor to send ONE real text to yourself and check the provider is working.
 * First add a Script property TEST_NUMBER (your own mobile, e.g. 09171234567).
 * Note: Semaphore silently ignores any message that starts with the word "TEST".
 */
function sendTestSms() {
  var props = PropertiesService.getScriptProperties();
  var number = normalizeMobile_(props.getProperty('TEST_NUMBER'));
  var provider = providerName_();
  if (!number) throw new Error('Add a valid TEST_NUMBER in Script properties first.');
  if (provider === 'OUTBOX') throw new Error('Set SMS_PROVIDER = SEMAPHORE in Script properties first.');
  Logger.log(sendBatch_(provider, [number], 'Isabel LGU alert system check. Please ignore this message.', 'ADVISORY'));
}
