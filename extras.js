/*
 * Isabel LGU portal - extras
 *   1. Quick buttons under the header: Services & Requirements, Report a Concern, Install App, text size
 *   2. Services & Requirements list (the content comes from services.json, so it can be edited without touching index.html)
 *   3. Report a Concern form for residents + an inbox for logged-in officers
 *   4. Bigger / smaller text (remembered on the device)
 *   5. Offline notice and "install as an app" support (works with sw.js and manifest.webmanifest)
 *
 * Install: put this file next to index.html and add ONE line just before </body>, AFTER signup-patch.js:
 *     <script src="extras.js"></script>
 */
(function () {
  'use strict';

  var BARANGAYS = [
    'Anislag', 'Antipolo', 'Apale', 'Bantigue', 'Benog', 'Bilwang', 'Can-andan', 'Cangag',
    'Consolacion', 'Honan', 'Libertad', 'Mahayag', 'Marvel', 'Matlang', 'Monte Alegre', 'Puting Bato',
    'San Francisco', 'San Roque', 'Santa Cruz', 'Santo Niño', 'Santo Rosario', 'Tabunok', 'Tolingon', 'Tubod'
  ];
  var CATEGORIES = ['Road or bridge', 'Flooding or drainage', 'Fallen tree or debris', 'Streetlight or electricity', 'Water supply',
    'Garbage or sanitation', 'Peace and order', 'Other'];
  var STATUSES = ['NEW', 'SEEN', 'IN PROGRESS', 'DONE', 'SPAM'];
  var TEXT_SIZES = [100, 112, 125, 140];

  function $(id) { return document.getElementById(id); }
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function store(key, val) { try { localStorage.setItem(key, val); } catch (e) {} }
  function load(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  function label(n) { return (n === 'Marvel' || n === 'Santo Niño') ? n + ' (Poblacion)' : n; }
  function demo() { return typeof DEMO_MODE !== 'undefined' && DEMO_MODE; }
  function isOfficer() { try { return !!activeUser; } catch (e) { return false; } }

  var header = document.querySelector('header');
  if (!header || !$('subscribeForm')) return; // not the portal page

  var BTN = 'inline-flex items-center gap-1.5 font-bold text-xs px-3 py-2 rounded-xl shadow-sm border cursor-pointer transition ';
  var INPUT = 'w-full p-2.5 bg-slate-50 border border-slate-200 rounded-xl outline-none focus:ring-2 focus:ring-blue-500 text-sm';

  /* ================= 1. Quick buttons ================= */
  var qa = document.createElement('section');
  qa.id = 'quickActions';
  qa.setAttribute('aria-label', 'Quick actions');
  qa.className = 'bg-white rounded-2xl p-2.5 sm:p-3 shadow-sm border border-slate-200/80 flex flex-wrap items-center gap-2';
  qa.innerHTML =
    '<button type="button" id="qaReport" class="' + BTN + 'bg-amber-500 hover:bg-amber-600 text-white border-amber-600">📝 Report a Concern</button>' +
    '<button type="button" id="qaReports" class="officer-only-btn hidden ' + BTN + 'bg-emerald-600 hover:bg-emerald-700 text-white border-emerald-700">📥 Reports</button>' +
    '<button type="button" id="qaInstall" class="hidden ' + BTN + 'bg-slate-800 hover:bg-slate-900 text-white border-slate-900">📲 Install App</button>' +
    '<div class="ml-auto flex items-center gap-1.5" role="group" aria-label="Text size">' +
      '<span class="text-xs text-slate-600 font-semibold hidden sm:inline">Text size</span>' +
      '<button type="button" id="tsDown" aria-label="Smaller text" class="' + BTN + 'bg-white hover:bg-slate-100 text-slate-800 border-slate-300 !px-3">A−</button>' +
      '<button type="button" id="tsUp" aria-label="Larger text" class="' + BTN + 'bg-white hover:bg-slate-100 text-slate-800 border-slate-300 !px-3 !text-sm">A+</button>' +
    '</div>' +
    '<div id="installHelp" class="hidden basis-full text-xs text-slate-700 bg-slate-50 border border-slate-200 rounded-xl p-2.5"></div>';
  header.parentNode.insertBefore(qa, header.nextSibling);

  /* ================= 2. Requirements inside each office pop-up ================= */
  // services.json lists what to bring for each service. Each entry has an "office" that is the key of an
  // office card (mayor, lcr, assessor, treasury, bfp, bjmp). It is shown inside that office's pop-up.
  var services = null, servicesLoading = null, openKey = '';

  function safeLink(u) {
    u = String(u || '').trim();
    if (/^forms\/[A-Za-z0-9._\/-]+$/.test(u) && u.indexOf('..') < 0) return u;
    if (/^https:\/\/[^\s"'<>]+$/i.test(u)) return u;
    return '';
  }

  function serviceHtml(s) {
    var reqs = Array.isArray(s.requirements) ? s.requirements.filter(Boolean) : [];
    var link = safeLink(s.form);
    var h = '<details class="border border-slate-200 rounded-xl bg-white">' +
      '<summary class="cursor-pointer p-2.5 font-bold text-slate-900 text-xs sm:text-sm">' + esc(s.title) + '</summary>' +
      '<div class="px-3 pb-3 text-xs sm:text-sm text-slate-800 space-y-2 border-t border-slate-100 pt-2">';
    if (reqs.length) {
      h += '<div><div class="text-xs font-bold text-slate-700 uppercase tracking-wide mb-1">What to bring</div><ol class="list-decimal ml-5 space-y-0.5">' +
        reqs.map(function (r) { return '<li>' + esc(r) + '</li>'; }).join('') + '</ol></div>';
    } else {
      h += '<p class="text-slate-600">The list of requirements will be posted soon. Please ask the office directly.</p>';
    }
    if (s.fee) h += '<p><strong>Fee:</strong> ' + esc(s.fee) + '</p>';
    if (s.time) h += '<p><strong>Processing time:</strong> ' + esc(s.time) + '</p>';
    if (s.note) h += '<p class="text-slate-700">' + esc(s.note) + '</p>';
    if (link) h += '<a href="' + esc(link) + '" target="_blank" rel="noopener noreferrer" class="' + BTN + 'bg-emerald-600 hover:bg-emerald-700 text-white border-emerald-700">⬇️ Download form</a>';
    return h + '</div></details>';
  }

  function loadServices() {
    if (services) return Promise.resolve();
    if (!/^https?:$/.test(location.protocol)) { services = []; return Promise.resolve(); } // opened from a file: nothing to fetch
    if (servicesLoading) return servicesLoading;
    servicesLoading = fetch('services.json', { cache: 'no-cache' })
      .then(function (r) { if (!r.ok) throw new Error('http'); return r.json(); })
      .then(function (d) {
        var list = d && Array.isArray(d.services) ? d.services : null;
        if (list) services = list.filter(function (s) { return s && s.title; });
      })
      .catch(function () {})
      .then(function () { if (!services) services = []; servicesLoading = null; });
    return servicesLoading;
  }

  var reqBox = document.createElement('div');
  reqBox.id = 'modalOfficeReqs';
  var ofUl = $('modalOfficeServices');
  if (ofUl && $('officeModal')) {
    ofUl.parentNode.parentNode.appendChild(reqBox);
    $('officeModal').firstElementChild.classList.add('max-h-[90vh]', 'overflow-y-auto');
  }

  function showReqs() {
    if (!openKey) return;
    var list = (services || []).filter(function (s) { return s.office === openKey; });
    var h = '<h4 class="font-bold text-slate-800 mb-1">📋 Requirements (what to bring):</h4>';
    if (!services) h += '<p class="text-slate-600">Loading...</p>';
    else if (!list.length) h += '<p class="text-slate-600">The list of requirements will be posted soon. Please ask the office directly.</p>';
    else h += '<div class="space-y-1.5">' + list.map(serviceHtml).join('') + '</div>' +
      '<p class="text-xs text-slate-600 mt-1.5">Requirements and fees can change. If you are unsure, ask the office before you go.</p>';
    reqBox.innerHTML = h;
  }

  if (typeof window.openOfficeModal === 'function') {
    var origOpenOffice = window.openOfficeModal;
    window.openOfficeModal = function (key) {
      origOpenOffice.apply(this, arguments);
      openKey = key; showReqs();
      if (!services) loadServices().then(function () { if (openKey === key) showReqs(); });
    };
  }
  loadServices(); // fetch early so the service worker keeps a copy for offline use

  /* ================= 3a. Report a Concern (residents) ================= */
  var rm = document.createElement('div');
  rm.id = 'reportModal';
  rm.style.display = 'none';
  rm.className = 'fixed inset-0 bg-slate-900/60 backdrop-blur-xs items-center justify-center p-4 z-50';
  rm.setAttribute('role', 'dialog');
  rm.setAttribute('aria-modal', 'true');
  rm.setAttribute('aria-label', 'Report a concern');
  rm.innerHTML =
    '<div class="bg-white rounded-2xl shadow-xl w-full max-w-md max-h-[92vh] overflow-y-auto p-4 sm:p-5 space-y-3">' +
      '<div class="flex items-start justify-between gap-2">' +
        '<div><h3 class="text-base font-extrabold text-slate-900">📝 Report a Concern</h3>' +
        '<p class="text-xs text-slate-600 mt-0.5">A photo is the quickest way to show the problem.</p></div>' +
        '<button type="button" id="rpClose" aria-label="Close" class="text-slate-500 hover:text-slate-900 text-lg px-2">✕</button>' +
      '</div>' +
      '<div class="text-xs bg-rose-50 border border-rose-200 text-rose-800 rounded-xl p-2.5"><strong>Is it an emergency?</strong> Do not use this form. Call the Emergency Hotlines listed on this page.</div>' +
      '<form id="reportForm" class="space-y-3" novalidate>' +
        '<div><label for="rpBarangay" class="block text-xs font-bold text-slate-700 mb-1">Barangay *</label>' +
          '<select id="rpBarangay" required class="' + INPUT + '"><option value="">Choose your barangay...</option>' +
          BARANGAYS.map(function (n) { return '<option value="' + esc(n) + '">' + esc(label(n)) + '</option>'; }).join('') + '</select></div>' +
        '<div><label for="rpCategory" class="block text-xs font-bold text-slate-700 mb-1">What is the problem about? *</label>' +
          '<select id="rpCategory" required class="' + INPUT + '"><option value="">Choose one...</option>' +
          CATEGORIES.map(function (n) { return '<option value="' + esc(n) + '">' + esc(n) + '</option>'; }).join('') + '</select></div>' +
        '<div><div class="block text-xs font-bold text-slate-700 mb-1">Photo of the problem</div>' +
          '<input id="rpPhoto" type="file" accept="image/*" class="hidden">' +
          '<button type="button" id="rpPhotoBtn" class="w-full ' + BTN + 'justify-center bg-slate-50 hover:bg-slate-100 text-slate-800 border-slate-400 border-dashed !text-sm !py-3">\ud83d\udcf7 Take or choose a photo</button>' +
          '<div id="rpPhotoPrev" class="hidden relative"><img id="rpPhotoImg" alt="Your photo" class="w-full max-h-52 object-cover rounded-xl border border-slate-300">' +
            '<button type="button" id="rpPhotoDel" class="absolute top-2 right-2 bg-slate-900/80 text-white text-xs font-bold px-2.5 py-1 rounded-lg">\u2715 Remove</button></div>' +
          '<div id="rpPhotoMsg" class="text-xs text-slate-600 mt-1"></div></div>' +
        '<button type="button" id="rpLocBtn" class="w-full ' + BTN + 'justify-center bg-white hover:bg-slate-100 text-slate-800 border-slate-300">\ud83d\udccd Add my location (helps us find the place)</button>' +
        '<div><label for="rpDetails" class="block text-xs font-bold text-slate-700 mb-1">Short note <span class="font-normal text-slate-500">(optional if you added a photo)</span></label>' +
          '<textarea id="rpDetails" rows="2" maxlength="300" placeholder="Example: In front of the chapel, Purok 3" class="' + INPUT + '"></textarea>' +
          '<div id="rpCount" class="text-xs text-slate-500 text-right mt-0.5">0 / 300</div></div>' +
        '<div class="grid grid-cols-1 sm:grid-cols-2 gap-2">' +
          '<div><label for="rpName" class="block text-xs font-bold text-slate-700 mb-1">Your name (optional)</label><input id="rpName" type="text" maxlength="60" autocomplete="name" class="' + INPUT + '"></div>' +
          '<div><label for="rpContact" class="block text-xs font-bold text-slate-700 mb-1">Mobile number (optional)</label><input id="rpContact" type="tel" maxlength="40" inputmode="tel" autocomplete="tel" placeholder="09XX XXX XXXX" class="' + INPUT + '"></div>' +
        '</div>' +
        '<div style="position:absolute;left:-9999px;top:auto;width:1px;height:1px;overflow:hidden" aria-hidden="true"><label>Website <input id="rpWebsite" type="text" tabindex="-1" autocomplete="off"></label></div>' +
        '<label class="flex items-start gap-2 text-xs text-slate-700"><input id="rpConsent" type="checkbox" class="mt-0.5"><span>I agree that the Municipality may use this report, my photo (with where and when it was taken) and my name or number (if given) only to respond to it (Data Privacy Act).</span></label>' +
        '<div id="rpMessage" class="hidden" role="status"></div>' +
        '<button type="submit" id="rpSubmit" class="w-full ' + BTN + 'justify-center bg-amber-500 hover:bg-amber-600 text-white border-amber-600 !text-sm">Send Report</button>' +
      '</form>' +
    '</div>';
  document.body.appendChild(rm);

  var photoData = '', photoGps = '', photoTaken = '', locVal = '', photoBusy = false;
  function resetPhoto() { photoData = ''; photoGps = ''; photoTaken = ''; $('rpPhoto').value = ''; $('rpPhotoPrev').classList.add('hidden'); $('rpPhotoBtn').classList.remove('hidden'); $('rpPhotoMsg').textContent = ''; }
  function resetLoc() { locVal = ''; $('rpLocBtn').textContent = '\ud83d\udccd Add my location (helps us find the place)'; $('rpLocBtn').classList.remove('!bg-emerald-50'); }
  function openReport() {
    $('rpMessage').className = 'hidden';
    $('rpSubmit').disabled = false;
    $('rpSubmit').textContent = 'Send Report';
    toggleModal('reportModal', true);
  }
  function closeReport() { toggleModal('reportModal', false); }
  $('qaReport').addEventListener('click', openReport);
  $('rpClose').addEventListener('click', closeReport);
  rm.addEventListener('click', function (e) { if (e.target === rm) closeReport(); });
  $('rpDetails').addEventListener('input', function () { $('rpCount').textContent = $('rpDetails').value.length + ' / 300'; });

  // Reads where and when a photo was taken from its own hidden camera data (EXIF), before the photo is shrunk.
  // Only the place and the time are kept; nothing else from the file is sent.
  function readExif(file) {
    return new Promise(function (resolve) {
      var none = { gps: '', taken: '' };
      try {
        var fr = new FileReader();
        fr.onerror = function () { resolve(none); };
        fr.onload = function () {
          try {
            var dv = new DataView(fr.result), n = dv.byteLength;
            if (n < 12 || dv.getUint16(0) !== 0xFFD8) return resolve(none);
            var o = 2, tiff = -1;
            while (o + 4 < n) {
              var mk = dv.getUint16(o), len = dv.getUint16(o + 2);
              if (mk === 0xFFE1 && dv.getUint32(o + 4) === 0x45786966) { tiff = o + 10; break; }
              if ((mk & 0xFF00) !== 0xFF00 || mk === 0xFFDA) break;
              o += 2 + len;
            }
            if (tiff < 0) return resolve(none);
            var le = dv.getUint16(tiff) === 0x4949;
            var u16 = function (p) { return dv.getUint16(p, le); }, u32 = function (p) { return dv.getUint32(p, le); };
            var ifd = function (start) {
              var out = {}, cnt = u16(start);
              for (var i = 0; i < cnt && i < 200; i++) { var e = start + 2 + i * 12; out[u16(e)] = { type: u16(e + 2), count: u32(e + 4), at: e + 8 }; }
              return out;
            };
            var asc = function (ent) { var p = ent.count > 4 ? tiff + u32(ent.at) : ent.at, t = ''; for (var i = 0; i < ent.count - 1 && i < 40; i++) t += String.fromCharCode(dv.getUint8(p + i)); return t; };
            var rat3 = function (ent) { var p = tiff + u32(ent.at), v = []; for (var i = 0; i < 3; i++) { var d = u32(p + i * 8 + 4); v.push(d ? u32(p + i * 8) / d : 0); } return v[0] + v[1] / 60 + v[2] / 3600; };
            var i0 = ifd(tiff + u32(tiff + 4)), res = { gps: '', taken: '' };
            if (i0[0x8769]) {
              var ex = ifd(tiff + u32(i0[0x8769].at)), dt = ex[0x9003] || ex[0x9004];
              var m = dt && /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2})/.exec(asc(dt));
              if (m) res.taken = m[1] + '-' + m[2] + '-' + m[3] + ' ' + m[4] + ':' + m[5];
            }
            if (i0[0x8825]) {
              var g = ifd(tiff + u32(i0[0x8825].at));
              if (g[1] && g[2] && g[3] && g[4]) {
                var lat = rat3(g[2]), lng = rat3(g[4]);
                if (asc(g[1]).charAt(0) === 'S') lat = -lat;
                if (asc(g[3]).charAt(0) === 'W') lng = -lng;
                if (isFinite(lat) && isFinite(lng) && (lat || lng)) res.gps = lat.toFixed(5) + ',' + lng.toFixed(5);
              }
            }
            resolve(res);
          } catch (e) { resolve(none); }
        };
        fr.readAsArrayBuffer(file.slice(0, 262144));
      } catch (e) { resolve(none); }
    });
  }

  // Shrinks a phone photo (often 3-8 MB) to a small JPEG. Re-drawing it on a canvas also removes hidden data such as the camera's GPS tags.
  function shrinkPhoto(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file), img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(url);
        var sides = [1280, 1024, 800, 640], quals = [0.72, 0.62, 0.55, 0.5];
        for (var i = 0; i < sides.length; i++) {
          var k = Math.min(1, sides[i] / Math.max(img.width, img.height));
          var c = document.createElement('canvas');
          c.width = Math.max(1, Math.round(img.width * k)); c.height = Math.max(1, Math.round(img.height * k));
          var g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
          var d = c.toDataURL('image/jpeg', quals[i]);
          if (d.length <= 600000) return resolve(d);
        }
        reject(new Error('too big'));
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('unreadable')); };
      img.src = url;
    });
  }
  $('rpPhotoBtn').addEventListener('click', function () { $('rpPhoto').click(); });
  $('rpPhotoDel').addEventListener('click', resetPhoto);
  $('rpPhoto').addEventListener('change', function () {
    var f = $('rpPhoto').files && $('rpPhoto').files[0];
    if (!f) return;
    if (!/^image\//.test(f.type || '')) { $('rpPhotoMsg').textContent = 'Please choose a photo.'; $('rpPhoto').value = ''; return; }
    photoBusy = true; $('rpPhotoMsg').textContent = 'Preparing your photo...';
    Promise.all([shrinkPhoto(f), readExif(f)]).then(function (both) {
      var d = both[0], ex = both[1];
      photoData = d; photoGps = ex.gps; photoTaken = ex.taken; photoBusy = false;
      $('rpPhotoImg').src = d; $('rpPhotoPrev').classList.remove('hidden'); $('rpPhotoBtn').classList.add('hidden');
      $('rpPhotoMsg').textContent = 'Photo ready (' + Math.round(d.length * 0.75 / 1024) + ' KB). ' +
        (ex.gps ? '\u2705 The photo shows where it was taken.' : '\u26a0\ufe0f This photo has no location. Please tap "Add my location" so we can find the place.');
    }).catch(function () {
      photoBusy = false; photoData = ''; $('rpPhoto').value = '';
      $('rpPhotoMsg').textContent = 'That photo could not be used. Please try another one.';
    });
  });
  $('rpLocBtn').addEventListener('click', function () {
    if (locVal) { resetLoc(); return; }
    if (!navigator.geolocation) { showInline($('rpMessage'), 'Your phone cannot share its location here. You can still send the report.', false); return; }
    $('rpLocBtn').textContent = 'Getting your location...';
    navigator.geolocation.getCurrentPosition(function (pos) {
      locVal = pos.coords.latitude.toFixed(5) + ',' + pos.coords.longitude.toFixed(5);
      $('rpLocBtn').textContent = '\u2705 Location added (tap to remove)';
    }, function () {
      resetLoc();
      showInline($('rpMessage'), 'Could not get your location. You can still send the report.', false);
    }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 });
  });

  $('reportForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var msg = $('rpMessage'), btn = $('rpSubmit');
    var p = {
      action: 'report', v: 2,
      barangay: $('rpBarangay').value, category: $('rpCategory').value, details: $('rpDetails').value.trim(),
      name: $('rpName').value.trim(), contact: $('rpContact').value.trim(),
      photo: photoData, photoGps: photoGps, photoTaken: photoTaken, loc: locVal,
      consent: $('rpConsent').checked, website: $('rpWebsite').value
    };
    if (photoBusy) return showInline(msg, 'Your photo is still being prepared. Please wait a moment.', false);
    if (!p.barangay) return showInline(msg, 'Please choose your barangay.', false);
    if (!p.category) return showInline(msg, 'Please choose what the problem is about.', false);
    if (!p.photo && p.details.length < 10) return showInline(msg, 'Please add a photo, or write a short note about the problem.', false);
    if (/https?:\/\/|www\./i.test(p.details)) return showInline(msg, 'Please do not put web links in the report.', false);
    if (!p.consent) return showInline(msg, 'Please tick the box to agree.', false);
    var last = Number(load('isabel_last_report') || 0);
    if (Date.now() - last < 30000) return showInline(msg, 'Please wait a few seconds before sending another report.', false);

    btn.disabled = true; btn.textContent = p.photo ? 'Sending photo...' : 'Sending...';
    var done = function (res) {
      if (res && res.ok) {
        store('isabel_last_report', String(Date.now()));
        showInline(msg, res.ref ? 'Thank you. Your report was sent. Reference number: ' + res.ref : 'Thank you. Your report was sent.', true);
        $('rpDetails').value = ''; $('rpCount').textContent = '0 / 300'; $('rpConsent').checked = false; resetPhoto(); resetLoc();
        btn.textContent = 'Sent ✓';
        setTimeout(function () { btn.disabled = false; btn.textContent = 'Send Report'; }, 4000);
      } else {
        showInline(msg, (res && res.error) || 'Could not send. Please try again.', false);
        btn.disabled = false; btn.textContent = 'Send Report';
      }
    };
    if (demo()) return done({ ok: true, ref: 'DEMO' });
    backendPost(p).then(done).catch(function () {
      showInline(msg, 'No connection. Your report was not sent. Please try again when you have signal.', false);
      btn.disabled = false; btn.textContent = 'Send Report';
    });
  });

  /* ================= 3b. Reports inbox (officers only) ================= */
  var im = document.createElement('div');
  im.id = 'reportsInboxModal';
  im.style.display = 'none';
  im.className = 'fixed inset-0 bg-slate-900/60 backdrop-blur-xs items-center justify-center p-4 z-50';
  im.setAttribute('role', 'dialog');
  im.setAttribute('aria-modal', 'true');
  im.setAttribute('aria-label', 'Reports from residents');
  im.innerHTML =
    '<div class="bg-white rounded-2xl shadow-xl w-full max-w-2xl max-h-[92vh] flex flex-col">' +
      '<div class="p-4 border-b border-slate-200 flex items-center justify-between gap-2">' +
        '<h3 class="text-base font-extrabold text-slate-900">📥 Reports from residents</h3>' +
        '<div class="flex items-center gap-2">' +
          '<select id="inboxFilter" aria-label="Filter reports" class="text-xs p-2 bg-slate-50 border border-slate-200 rounded-lg font-semibold">' +
            '<option value="OPEN">Open (new, seen, in progress)</option><option value="ALL">All</option>' +
            STATUSES.map(function (s) { return '<option value="' + s + '">' + s + '</option>'; }).join('') + '</select>' +
          '<button type="button" id="inboxClose" aria-label="Close" class="text-slate-500 hover:text-slate-900 text-lg px-2">✕</button>' +
        '</div>' +
      '</div>' +
      '<div id="inboxBody" class="p-4 space-y-3 overflow-y-auto text-sm"></div>' +
    '</div>';
  document.body.appendChild(im);

  var inbox = [];
  var STATUS_STYLE = { 'NEW': 'bg-rose-100 text-rose-800', 'SEEN': 'bg-slate-200 text-slate-800', 'IN PROGRESS': 'bg-amber-100 text-amber-900', 'DONE': 'bg-emerald-100 text-emerald-800', 'SPAM': 'bg-slate-100 text-slate-500' };

  function telOf(c) { var t = String(c || '').replace(/[^0-9+]/g, ''); return t.replace(/\D/g, '').length >= 7 ? t : ''; }

  function meters(a, b) {
    var p = String(a).split(',').map(Number), q = String(b).split(',').map(Number), R = 6371000, r = Math.PI / 180;
    var dLat = (q[0] - p[0]) * r, dLng = (q[1] - p[1]) * r;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(p[0] * r) * Math.cos(q[0] * r) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return Math.round(2 * R * Math.asin(Math.sqrt(h)));
  }
  var GPS_RE = /^-?\d{1,2}\.\d+,-?\d{1,3}\.\d+$/;
  // One short line that helps an officer judge whether a photo is genuine.
  function checkLine(r) {
    var bits = [], warn = false;
    if (GPS_RE.test(r.photoGps || '')) {
      bits.push('\ud83d\udccd Photo GPS: <a href="https://www.google.com/maps?q=' + esc(r.photoGps) + '" target="_blank" rel="noopener noreferrer" class="underline text-blue-700">open map</a>');
      if (GPS_RE.test(r.loc || '')) { var m = meters(r.photoGps, r.loc); bits.push(m <= 300 ? '\u2705 ' + m + ' m from where the resident was' : '\u26a0\ufe0f ' + m + ' m away from where the resident was'); if (m > 300) warn = true; }
    } else { bits.push('\u26a0\ufe0f No GPS inside the photo'); warn = true; }
    var t = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(r.photoTaken || '');
    if (t) {
      var when = new Date(+t[1], +t[2] - 1, +t[3], +t[4], +t[5]), days = r.createdMs ? (r.createdMs - when.getTime()) / 86400000 : 0;
      bits.push('\ud83d\udd52 Taken ' + when.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }));
      if (days > 2) { bits.push('\u26a0\ufe0f ' + Math.floor(days) + ' days before the report'); warn = true; }
    } else { bits.push('\u26a0\ufe0f No date inside the photo'); warn = true; }
    return '<p class="text-xs rounded-lg px-2 py-1 ' + (warn ? 'bg-amber-50 text-amber-900' : 'bg-emerald-50 text-emerald-900') + '">' + bits.join(' \u00b7 ') + '</p>';
  }
  function renderInbox() {
    var f = $('inboxFilter').value;
    var list = inbox.filter(function (r) {
      if (f === 'ALL') return true;
      if (f === 'OPEN') return r.status === 'NEW' || r.status === 'SEEN' || r.status === 'IN PROGRESS';
      return r.status === f;
    });
    var newCount = inbox.filter(function (r) { return r.status === 'NEW'; }).length;
    var badge = $('qaReports');
    badge.innerHTML = '📥 Reports' + (newCount ? ' <span class="bg-white text-emerald-800 rounded-full px-1.5 text-xs font-extrabold">' + newCount + '</span>' : '');
    if (!list.length) { $('inboxBody').innerHTML = '<p class="text-slate-600">No reports here.</p>'; return; }
    $('inboxBody').innerHTML = list.map(function (r) {
      var tel = telOf(r.contact);
      return '<div class="border border-slate-200 rounded-xl p-3 space-y-1.5">' +
        '<div class="flex items-start justify-between gap-2">' +
          '<div><div class="font-bold text-slate-900">' + esc(r.category) + ' • ' + esc(r.barangay) + '</div>' +
          '<div class="text-xs text-slate-500">' + esc(r.created) + ' • ' + esc(r.id) + '</div></div>' +
          '<span class="shrink-0 text-xs font-bold px-2 py-0.5 rounded-full ' + (STATUS_STYLE[r.status] || STATUS_STYLE.SEEN) + '">' + esc(r.status) + '</span></div>' +
        (r.details ? '<p class="text-slate-800 whitespace-pre-line">' + esc(r.details) + '</p>' : '<p class="text-slate-500 italic">No note. See the photo.</p>') +
        (r.hasPhoto ? checkLine(r) : '') +
        (r.hasPhoto ? '<div data-photo-box="' + esc(r.id) + '"><button type="button" data-photo="' + esc(r.id) + '" class="text-xs font-bold px-2.5 py-1 rounded-lg border border-slate-300 bg-white hover:bg-slate-100">\ud83d\udcf7 View photo</button></div>' : '') +
        (/^-?\d{1,2}\.\d+,-?\d{1,3}\.\d+$/.test(r.loc || '') ? '<a href="https://www.google.com/maps?q=' + esc(r.loc) + '" target="_blank" rel="noopener noreferrer" class="inline-block text-xs font-bold text-blue-700 underline">\ud83d\udccd Open the location on the map</a>' : '') +
        '<div class="text-xs text-slate-700">' + (r.name ? 'From: <strong>' + esc(r.name) + '</strong> ' : 'Name not given. ') +
          (tel ? '<a class="text-blue-700 font-bold underline" href="tel:' + esc(tel) + '">' + esc(r.contact) + '</a>' : (r.contact ? esc(r.contact) : 'No number given.')) +
          (r.by ? ' • Last handled by ' + esc(r.by) : '') + '</div>' +
        '<div class="flex flex-wrap gap-1.5 pt-1">' + ['SEEN', 'IN PROGRESS', 'DONE', 'SPAM'].filter(function (s) { return s !== r.status; }).map(function (s) {
          return '<button type="button" data-id="' + esc(r.id) + '" data-status="' + s + '" class="text-xs font-bold px-2.5 py-1 rounded-lg border border-slate-300 bg-white hover:bg-slate-100">Mark ' + s.toLowerCase() + '</button>';
        }).join('') + '</div></div>';
    }).join('');
  }

  function fetchInbox(showErrors) {
    if (!isOfficer() || demo()) return Promise.resolve();
    return api('listReports', {}).then(function (res) {
      if (res && res.ok) { inbox = res.reports || []; renderInbox(); }
      else if (showErrors && res && res.code !== 'AUTH') alert('❌ ' + (res.error || 'Could not load the reports.'));
    }).catch(function () { if (showErrors) alert('No connection. Please try again.'); });
  }

  $('qaReports').addEventListener('click', function () {
    if (!isOfficer()) return alert('Officer login required.');
    $('inboxBody').innerHTML = '<p class="text-slate-600">Loading...</p>';
    toggleModal('reportsInboxModal', true);
    if (demo()) { $('inboxBody').innerHTML = '<p class="text-slate-600">Reports are only collected on the live site.</p>'; return; }
    fetchInbox(true);
  });
  $('inboxClose').addEventListener('click', function () { toggleModal('reportsInboxModal', false); });
  im.addEventListener('click', function (e) { if (e.target === im) toggleModal('reportsInboxModal', false); });
  $('inboxFilter').addEventListener('change', renderInbox);
  $('inboxBody').addEventListener('click', function (e) {
    var pb = e.target.closest ? e.target.closest('button[data-photo]') : null;
    if (pb) {
      var pid = pb.getAttribute('data-photo'), box = pb.parentNode;
      pb.disabled = true; pb.textContent = 'Loading photo...';
      api('getReportPhoto', { id: pid }).then(function (res) {
        if (res && res.ok && /^data:image\/jpeg;base64,[A-Za-z0-9+\/=]+$/.test(res.photo || '')) {
          box.innerHTML = '<img alt="Photo sent by the resident" class="w-full max-h-96 object-contain rounded-xl border border-slate-300 bg-slate-50">';
          box.firstChild.src = res.photo;
        } else { pb.disabled = false; pb.textContent = '\ud83d\udcf7 View photo'; if (res && res.code !== 'AUTH') alert('\u274c ' + ((res && res.error) || 'Could not load the photo.')); }
      }).catch(function () { pb.disabled = false; pb.textContent = '\ud83d\udcf7 View photo'; alert('No connection. Please try again.'); });
      return;
    }
    var b = e.target.closest ? e.target.closest('button[data-id]') : null;
    if (!b) return;
    b.disabled = true;
    api('setReportStatus', { id: b.getAttribute('data-id'), status: b.getAttribute('data-status') }).then(function (res) {
      if (res && res.ok) return fetchInbox(false);
      b.disabled = false;
      if (res && res.code !== 'AUTH') alert('❌ ' + ((res && res.error) || 'Could not save.'));
    }).catch(function () { b.disabled = false; alert('No connection. Please try again.'); });
  });

  // Show the number of NEW reports on the button shortly after an officer logs in.
  var wasOfficer = false;
  setInterval(function () {
    var now = isOfficer();
    if (now && !wasOfficer) fetchInbox(false);
    wasOfficer = now;
  }, 2000);

  /* ================= 4. Text size ================= */
  var tsIndex = Number(load('isabel_textsize'));
  if (!(tsIndex >= 0 && tsIndex < TEXT_SIZES.length)) tsIndex = 0;
  function applyTextSize() {
    document.documentElement.style.fontSize = TEXT_SIZES[tsIndex] + '%';
    $('tsDown').disabled = tsIndex === 0;
    $('tsUp').disabled = tsIndex === TEXT_SIZES.length - 1;
    $('tsDown').style.opacity = tsIndex === 0 ? '.4' : '1';
    $('tsUp').style.opacity = tsIndex === TEXT_SIZES.length - 1 ? '.4' : '1';
    store('isabel_textsize', String(tsIndex));
  }
  $('tsDown').addEventListener('click', function () { if (tsIndex > 0) { tsIndex--; applyTextSize(); } });
  $('tsUp').addEventListener('click', function () { if (tsIndex < TEXT_SIZES.length - 1) { tsIndex++; applyTextSize(); } });
  applyTextSize();

  /* ================= 5. Offline notice, install as an app ================= */
  var off = document.createElement('div');
  off.id = 'offlineBar';
  off.setAttribute('role', 'status');
  off.style.cssText = 'display:none;position:fixed;left:0;right:0;bottom:0;z-index:60;background:#0f172a;color:#fff;font-size:13px;font-weight:600;text-align:center;padding:10px 12px;box-shadow:0 -2px 10px rgba(0,0,0,.3)';
  off.textContent = '📴 You are offline. Showing the last information saved on this device.';
  document.body.appendChild(off);
  function netState() { off.style.display = navigator.onLine === false ? 'block' : 'none'; }
  window.addEventListener('online', netState);
  window.addEventListener('offline', netState);
  netState();

  var standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
  var deferredInstall = null;
  var isIos = /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferredInstall = e;
    if (!standalone) $('qaInstall').classList.remove('hidden');
  });
  window.addEventListener('appinstalled', function () { deferredInstall = null; $('qaInstall').classList.add('hidden'); });
  if (isIos && !standalone) $('qaInstall').classList.remove('hidden'); // iPhones have no install prompt: show the steps instead
  $('qaInstall').addEventListener('click', function () {
    if (deferredInstall) {
      deferredInstall.prompt();
      deferredInstall.userChoice.then(function () { deferredInstall = null; $('qaInstall').classList.add('hidden'); });
      return;
    }
    var h = $('installHelp');
    h.innerHTML = 'On an iPhone or iPad: tap the <strong>Share</strong> button (the square with an arrow), then choose <strong>Add to Home Screen</strong>. The portal will then open like an app.';
    h.classList.toggle('hidden');
  });

  /* ----- Friendly "add to your home screen" banner for first-time visitors on phones ----- */
  var ua = navigator.userAgent || '';
  var inApp = /FBAN|FBAV|FB_IAB|FBIOS|Instagram|Messenger|Line\/|MicroMessenger/i.test(ua);   // Facebook, Messenger and similar built-in browsers
  var isAndroid = /android/i.test(ua);
  var isMobile = isIos || isAndroid || /Mobile/i.test(ua);
  var DISMISS_KEY = 'isabel_install_dismissed', DISMISS_DAYS = 14;
  function dismissedRecently() { var t = Number(load(DISMISS_KEY) || 0); return !!t && Date.now() - t < DISMISS_DAYS * 86400000; }

  var ib = document.createElement('div');
  ib.id = 'installBanner';
  ib.setAttribute('role', 'region');
  ib.setAttribute('aria-label', 'Add this site to your home screen');
  ib.style.cssText = 'display:none;position:fixed;left:12px;right:12px;bottom:12px;max-width:460px;margin:0 auto;z-index:45';
  document.body.appendChild(ib);

  function bannerText() {
    if (inApp) return 'You are viewing this inside Facebook or Messenger. To add the site to your home screen, tap the <strong>\u22ef</strong> or <strong>\u22ee</strong> menu at the top corner, choose <strong>Open in browser</strong> (or <strong>Open in Chrome</strong>), then add it from there.';
    if (isIos) return 'Tap the <strong>Share</strong> button (the square with an arrow) at the bottom of Safari, then choose <strong>Add to Home Screen</strong>.';
    if (deferredInstall) return 'Add it to your home screen, so you do not have to search for the address again.';
    return 'Tap the <strong>\u22ee</strong> menu of your browser, then choose <strong>Install app</strong> or <strong>Add to Home screen</strong>.';
  }
  function renderBanner() {
    ib.innerHTML =
      '<div class="bg-white border border-slate-300 rounded-2xl shadow-xl p-3.5 space-y-2.5">' +
        '<div class="flex items-start justify-between gap-2"><div class="text-sm font-extrabold text-slate-900">\ud83d\udcf2 Keep Isabel LGU on your phone</div>' +
        '<button type="button" id="ibClose" aria-label="Close" class="text-slate-500 hover:text-slate-900 text-lg leading-none px-1">\u2715</button></div>' +
        '<p class="text-xs text-slate-700">' + bannerText() + '</p>' +
        '<div class="flex gap-2">' + (deferredInstall && !inApp && !isIos ? '<button type="button" id="ibInstall" class="' + BTN + 'bg-blue-600 hover:bg-blue-700 text-white border-blue-700">Add to home screen</button>' : '') +
        '<button type="button" id="ibLater" class="' + BTN + 'bg-white hover:bg-slate-100 text-slate-700 border-slate-300">Not now</button></div>' +
      '</div>';
    var later = function () { store(DISMISS_KEY, String(Date.now())); ib.style.display = 'none'; };
    $('ibClose').addEventListener('click', later);
    $('ibLater').addEventListener('click', later);
    if ($('ibInstall')) $('ibInstall').addEventListener('click', function () {
      if (!deferredInstall) return;
      deferredInstall.prompt();
      deferredInstall.userChoice.then(function () { deferredInstall = null; $('qaInstall').classList.add('hidden'); ib.style.display = 'none'; });
    });
  }
  var bannerWanted = isMobile && !standalone && !dismissedRecently();
  function showBanner() {
    if (!bannerWanted || navigator.onLine === false) return;
    renderBanner(); ib.style.display = 'block';
  }
  if (bannerWanted) {
    setTimeout(showBanner, 4500); // after the opening screen has gone
    window.addEventListener('beforeinstallprompt', function () { if (ib.style.display === 'block') renderBanner(); });
    window.addEventListener('appinstalled', function () { bannerWanted = false; ib.style.display = 'none'; });
    window.addEventListener('offline', function () { ib.style.display = 'none'; });
  }

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () {});
    });
  }
})();