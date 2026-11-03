/*
 * Isabel LGU portal - sign-up patch
 *   1. Barangay dropdown (the 24 official barangays) in the sign-up form
 *   2. Official barangay suggestions in the alert form
 *   3. "Enter the 6-digit code we texted you" step for sign-up and unsubscribe
 *
 * Install: put this file next to index.html and add ONE line just before </body>, AFTER the big inline <script>:
 *     <script src="signup-patch.js"></script>
 * It works together with the v3 Code.gs (the server asks for the code; this page shows the code box).
 */
(function () {
  'use strict';

  var NAMES = [
    'Anislag', 'Antipolo', 'Apale', 'Bantigue', 'Benog', 'Bilwang', 'Can-andan', 'Cangag',
    'Consolacion', 'Honan', 'Libertad', 'Mahayag', 'Marvel', 'Matlang', 'Monte Alegre', 'Puting Bato',
    'San Francisco', 'San Roque', 'Santa Cruz', 'Santo Ni\u00f1o', 'Santo Rosario', 'Tabunok', 'Tolingon', 'Tubod'
  ];
  var INPUT_CLASS = 'w-full p-2.5 bg-slate-50 border border-slate-200 rounded-xl outline-none focus:ring-2 focus:ring-rose-500';

  function $(id) { return document.getElementById(id); }
  function label(n) { return (n === 'Marvel' || n === 'Santo Ni\u00f1o') ? n + ' (Poblacion)' : n; }

  if (!$('subscribeForm')) return; // not the portal page

  /* ---- 1 & 2. Barangay list ---- */
  var dl = $('barangayList');
  if (dl) {
    dl.innerHTML = ['ALL'].concat(NAMES).map(function (n) { return '<option value="' + n + '"></option>'; }).join('');
  }
  var oldInput = $('subBarangay');
  if (oldInput && oldInput.tagName !== 'SELECT') {
    var sel = document.createElement('select');
    sel.id = 'subBarangay';
    sel.required = true;
    sel.className = INPUT_CLASS;
    sel.innerHTML = '<option value="">Choose your barangay\u2026</option>' +
      NAMES.map(function (n) { return '<option value="' + n + '">' + label(n) + '</option>'; }).join('');
    oldInput.parentNode.replaceChild(sel, oldInput);
  }

  /* ---- 3a. Sign-up form: drop the old submit handler by swapping in a clone, then add the code step ---- */
  var oldForm = $('subscribeForm');
  var form = oldForm.cloneNode(true);
  oldForm.parentNode.replaceChild(form, oldForm);
  var msg = $('subMessage');

  var codeBox = document.createElement('div');
  codeBox.id = 'subCodeBox';
  codeBox.className = 'hidden space-y-2';
  codeBox.innerHTML =
    '<label class="block font-bold text-slate-700" for="subCode">6-digit code we texted you</label>' +
    '<input type="text" id="subCode" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="123456" ' +
      'class="' + INPUT_CLASS + ' font-mono text-center tracking-widest text-base">' +
    '<div class="flex items-center gap-3">' +
      '<button type="button" id="subVerifyBtn" class="flex-1 bg-rose-600 hover:bg-rose-700 text-white font-bold py-2.5 rounded-xl transition shadow cursor-pointer">Confirm &amp; Subscribe</button>' +
      '<button type="button" id="subResendBtn" class="text-slate-600 hover:text-slate-900 font-semibold underline">Send again</button>' +
    '</div>';
  form.insertBefore(codeBox, msg);

  var pending = null; // the sign-up that is waiting for its code

  function lockFields(on) {
    ['subName', 'subBarangay', 'subMobile', 'subConsent'].forEach(function (id) { if ($(id)) $(id).disabled = on; });
    $('subSubmitBtn').classList.toggle('hidden', on);
    codeBox.classList.toggle('hidden', !on);
  }

  function resetSignup() {
    pending = null;
    lockFields(false);
    $('subCode').value = '';
    $('subSubmitBtn').disabled = false;
    $('subSubmitBtn').textContent = 'Subscribe to Alerts';
  }

  function maskedMobile(m) { return '+' + m.substring(0, 2) + '\u2022\u2022\u2022\u2022\u2022\u2022\u2022' + m.slice(-3); }

  function requestCode(isResend) {
    var btn = $('subSubmitBtn');
    var payload = (isResend && pending) ? pending : {
      action: 'subscribe',
      v: 2,
      name: $('subName').value.trim(),
      barangay: $('subBarangay').value,
      mobile: normMobile($('subMobile').value),
      consent: $('subConsent').checked,
      website: $('subWebsite').value
    };
    if (!payload.mobile) return showInline(msg, 'Please enter a valid Philippine mobile number, like 09171234567.', false);
    if (!payload.barangay) return showInline(msg, 'Please choose your barangay from the list.', false);
    if (!payload.consent) return showInline(msg, 'Please tick the consent box to continue.', false);

    var finish = function (res) {
      btn.disabled = false;
      btn.textContent = 'Subscribe to Alerts';
      if (res && res.ok && res.needCode) {
        pending = payload;
        lockFields(true);
        showInline(msg, '\ud83d\udcf2 We sent a 6-digit code to ' + maskedMobile(payload.mobile) + '. Type it below.', true);
        $('subCode').focus();
      } else if (res && res.ok) {
        form.reset();
        resetSignup();
        showInline(msg, '\u2705 You are subscribed. You will get an SMS when there is an emergency in your barangay.', true);
      } else {
        showInline(msg, (res && res.error) || 'Something went wrong. Please try again.', false);
      }
    };

    btn.disabled = true;
    btn.textContent = 'Saving\u2026';

    if (DEMO_MODE) { // no online service connected: keep sign-ups in this browser only, as before
      var subs = readJson('isabel_demo_subs', []).filter(function (s) { return s.mobile !== payload.mobile; });
      subs.push({ name: payload.name, barangay: payload.barangay, mobile: payload.mobile, status: 'ACTIVE' });
      localStorage.setItem('isabel_demo_subs', JSON.stringify(subs));
      return finish({ ok: true });
    }
    backendPost(payload).then(finish).catch(function () {
      finish({ ok: false, error: 'No connection. Please check your internet and try again.' });
    });
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (pending) return;
    requestCode(false);
  });

  $('subResendBtn').addEventListener('click', function () { if (pending) requestCode(true); });

  $('subVerifyBtn').addEventListener('click', function () {
    var code = $('subCode').value.replace(/\D/g, '');
    if (!pending) return;
    if (code.length !== 6) return showInline(msg, 'Type the 6-digit code from the text message.', false);
    var b = $('subVerifyBtn');
    b.disabled = true;
    b.textContent = 'Checking\u2026';
    backendPost({ action: 'confirmSubscribe', v: 2, mobile: pending.mobile, code: code }).then(function (res) {
      b.disabled = false;
      b.textContent = 'Confirm & Subscribe';
      if (res && res.ok) {
        form.reset();
        resetSignup();
        showInline(msg, '\u2705 You are subscribed. You will get an SMS when there is an emergency in your barangay.', true);
      } else {
        showInline(msg, (res && res.error) || 'Wrong code. Please try again.', false);
      }
    }).catch(function () {
      b.disabled = false;
      b.textContent = 'Confirm & Subscribe';
      showInline(msg, 'No connection. Please try again.', false);
    });
  });

  /* ---- 3b. Unsubscribe: number first, then the code ---- */
  var unsubMessage = $('unsubMessage');
  var unsubBox = $('unsubBox');
  var unsubMobile = '';
  var codeRow = document.createElement('div');
  codeRow.id = 'unsubCodeRow';
  codeRow.className = 'hidden mt-2 flex gap-2';
  codeRow.innerHTML =
    '<input type="text" id="unsubCode" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="6-digit code" ' +
      'class="flex-1 p-2 bg-slate-50 border border-slate-200 rounded-xl font-mono text-center tracking-widest">' +
    '<button type="button" id="unsubConfirmBtn" class="bg-slate-800 hover:bg-slate-900 text-white font-bold px-3 rounded-xl">Confirm</button>';
  unsubBox.parentNode.insertBefore(codeRow, unsubMessage);

  function unsubSay(text, ok) {
    unsubMessage.classList.remove('hidden');
    unsubMessage.className = 'mt-2 text-xs font-semibold ' + (ok ? 'text-emerald-700' : 'text-rose-700');
    unsubMessage.textContent = text;
  }

  window.submitUnsubscribe = function () {
    var mobile = normMobile($('unsubMobile').value);
    if (!mobile) return unsubSay('Enter a valid mobile number.', false);

    if (DEMO_MODE) {
      var subs = readJson('isabel_demo_subs', []);
      subs.forEach(function (s) { if (s.mobile === mobile) s.status = 'UNSUBSCRIBED'; });
      localStorage.setItem('isabel_demo_subs', JSON.stringify(subs));
      return unsubSay('\u2705 If that number was subscribed, it will no longer receive alerts.', true);
    }
    backendPost({ action: 'unsubscribe', v: 2, mobile: mobile }).then(function (res) {
      if (res && res.ok && res.needCode) {
        unsubMobile = mobile;
        codeRow.classList.remove('hidden');
        unsubSay('If that number is subscribed, we texted it a 6-digit code. Type it below.', true);
      } else if (res && res.ok) {
        unsubSay('\u2705 If that number was subscribed, it will no longer receive alerts.', true);
      } else {
        unsubSay((res && res.error) || 'Something went wrong. Please try again.', false);
      }
    }).catch(function () { unsubSay('No connection. Please try again.', false); });
  };

  $('unsubConfirmBtn').addEventListener('click', function () {
    var code = $('unsubCode').value.replace(/\D/g, '');
    if (!unsubMobile) return;
    if (code.length !== 6) return unsubSay('Type the 6-digit code from the text message.', false);
    backendPost({ action: 'confirmUnsubscribe', v: 2, mobile: unsubMobile, code: code }).then(function (res) {
      if (res && res.ok) {
        codeRow.classList.add('hidden');
        $('unsubCode').value = '';
        unsubMobile = '';
        unsubSay('\u2705 Done. This number will no longer receive alerts.', true);
      } else {
        unsubSay((res && res.error) || 'Wrong code. Please try again.', false);
      }
    }).catch(function () { unsubSay('No connection. Please try again.', false); });
  });

  /* ---- Start every visit to the sign-up window from a clean state ---- */
  var originalOpen = window.openSubscribeModal;
  window.openSubscribeModal = function () {
    resetSignup();
    codeRow.classList.add('hidden');
    if (typeof originalOpen === 'function') originalOpen();
  };
})();
