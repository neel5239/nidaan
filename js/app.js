/* Nidaan front end. Same UI as the prototype, now driven by the API in /server. */
(function () {
  'use strict';

  /* ---------------- utilities ---------------- */
  var $ = function (id) { return document.getElementById(id); };
  function esc(t) { return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function parseTs(s) { if (!s) return null; if (s instanceof Date) return s; if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(s + 'T00:00:00'); return new Date(s.replace(' ', 'T') + (/Z|[+-]\d{2}:?\d{2}$/.test(s) ? '' : 'Z')); }
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function fmtDate(s) { var d = parseTs(s); if (!d || isNaN(d)) return '—'; return d.getDate() + ' ' + MON[d.getMonth()] + ' ' + d.getFullYear(); }
  function fmtTime(s) { var d = parseTs(s); if (!d || isNaN(d)) return ''; return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  function fmtWhen(s) { var d = parseTs(s); if (!d || isNaN(d)) return '—'; var now = new Date(); var today = d.toDateString() === now.toDateString(); return (today ? 'Today' : fmtDate(s)) + ' ' + fmtTime(s); }
  function ago(min) { if (min < 1) return 'just now'; if (min < 60) return min + ' min'; var h = Math.floor(min / 60); return h + ' h ' + (min % 60) + ' min'; }
  function plural(n, w) { return n + ' ' + w + (n === 1 ? '' : 's'); }
  function initials(name) { return String(name || '').replace(/^Dr\.?\s+/i, '').split(/\s+/).filter(Boolean).slice(0, 2).map(function (s) { return s[0].toUpperCase(); }).join(''); }
  document.querySelectorAll('.today-date').forEach(function (el) { var d = new Date(); el.textContent = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()] + ' ' + d.getDate() + ' ' + MON[d.getMonth()] + ' ' + d.getFullYear(); });

  var toastTimer;
  window.toast = function (msg, kind) {
    var t = $('toast'); $('toast-t').textContent = msg;
    t.classList.toggle('err', kind === 'err');
    $('toast-ic').setAttribute('href', kind === 'err' ? '#i-alert' : '#i-check');
    t.classList.add('show'); clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, kind === 'err' ? 4200 : 2600);
  };
  window.openModal = function (id) {
    document.querySelectorAll('#scrim .modal').forEach(function (m) { m.classList.add('hidden'); });
    var m = $(id); m.classList.remove('hidden'); $('scrim').classList.add('open');
    var f = m.querySelector('input:not([type=hidden]):not([style*="display:none"]),select,textarea,button:not(.xbtn)'); if (f) setTimeout(function () { try { f.focus(); } catch (e) {} }, 30);
  };
  window.closeModal = function () { $('scrim').classList.remove('open'); };
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeModal(); });

  var lastScreen = { clinic: 'c-today', doctor: 'd-queue', patient: 'p-home' };
  var loaders = {};
  window.showPortal = function (p) {
    document.querySelectorAll('.portal').forEach(function (el) { el.classList.toggle('active', el.id === 'portal-' + p); });
    window.scrollTo(0, 0);
  };
  window.showScreen = function (portal, id, btn, arg) {
    var root = $('portal-' + portal);
    root.querySelectorAll('.screen').forEach(function (s) { s.classList.toggle('active', s.id === id); });
    var navBtn = btn;
    if (!navBtn) root.querySelectorAll('.navb').forEach(function (b) { if ((b.getAttribute('onclick') || '').indexOf("'" + id + "'") > -1) navBtn = b; });
    root.querySelectorAll('.navb').forEach(function (b) { b.removeAttribute('aria-current'); });
    if (navBtn) navBtn.setAttribute('aria-current', 'page');
    lastScreen[portal] = id; window.scrollTo(0, 0);
    if (loaders[id]) loaders[id](arg);
  };
  window.showTab = function (btn, id) {
    btn.parentElement.querySelectorAll('.tab').forEach(function (t) { t.setAttribute('aria-selected', 'false'); });
    btn.setAttribute('aria-selected', 'true');
    var pane = $(id); pane.parentElement.querySelectorAll(':scope > .tabpane').forEach(function (p) { p.classList.toggle('active', p.id === id); });
  };
  document.addEventListener('click', function (e) {
    var b = e.target.closest('.seg > button, .scale > button');
    if (!b) return;
    b.parentElement.querySelectorAll('button').forEach(function (x) { x.setAttribute('aria-pressed', 'false'); });
    b.setAttribute('aria-pressed', 'true');
  });

  /* ---------------- API client ---------------- */
  var TOKEN_KEY = 'nidaan.token';
  var token = localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY) || '';
  var USER = null;
  function api(method, url, body) {
    var opts = { method: method, headers: {} };
    if (token) opts.headers.Authorization = 'Bearer ' + token;
    if (body instanceof FormData) opts.body = body;
    else if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    return fetch('/api' + url, opts).then(function (r) {
      return r.json().catch(function () { return { error: 'Server returned ' + r.status }; }).then(function (data) {
        if (r.status === 401 && USER) { logout(); throw new Error('Please sign in again'); }
        if (!r.ok) throw new Error(data.error || ('Request failed (' + r.status + ')'));
        return data;
      });
    });
  }
  function fileUrl(role, id) { return '/api/' + role + '/documents/' + id + '/file?token=' + encodeURIComponent(token); }
  /* documents open inside the app (PDF / image / text in a modal); "Open in new tab" stays available */
  window.openFile = function (role, id, name, mime) {
    var url = fileUrl(role, id);
    $('m-doc-t').textContent = name || 'Document'; $('m-doc-sub').textContent = mime ? mime.replace('application/', '').toUpperCase() : '';
    $('m-doc-new').href = url;
    var body = $('m-doc-body');
    if (/^image\//i.test(mime || '')) body.innerHTML = '<img src="' + url + '" alt="' + esc(name || 'document') + '" style="max-width:100%;max-height:100%;object-fit:contain">';
    else if (/^text\//i.test(mime || '')) { body.innerHTML = '<pre class="small" style="white-space:pre-wrap;padding:16px;margin:0;width:100%;box-sizing:border-box;text-align:left">Loading…</pre>'; fetch(url).then(function (r) { return r.text(); }).then(function (t) { body.firstChild.textContent = t; }); }
    else body.innerHTML = '<iframe src="' + url + '" title="' + esc(name || 'document') + '" style="width:100%;height:100%;border:0;background:#fff"></iframe>';
    openModal('m-doc');
  };
  function fail(e) { toast(e.message || String(e), 'err'); console.error(e); }
  /* background refresh: skip re-rendering when the server payload has not changed */
  var lastPayload = {};
  function unchanged(key, data) { var j = JSON.stringify(data, function (k, v) { return k === 'wait_min' || k === 'longest' || k === 'avg_wait' ? undefined : v; }); if (lastPayload[key] === j) return true; lastPayload[key] = j; return false; }


  /* ---------------- login ---------------- */
  var ROLES = {
    patient: { title: 'Sign in as a patient', sub: 'Use the email and password you registered with.', btn: 'Sign in to patient portal', signup: 'Create a patient account', home: 'p-home', color: 'var(--patient)' },
    clinic: { title: 'Sign in to your clinic', sub: 'Front desk and admin staff use the clinic login issued at registration.', btn: 'Sign in to clinic portal', signup: 'Register your clinic', home: 'c-today', color: 'var(--clinic)' },
    doctor: { title: 'Sign in as a doctor', sub: 'Use the login from your clinic invite. You will see only patients assigned to you.', btn: 'Sign in to doctor portal', signup: 'Have an invite? Set your password', home: 'd-queue', color: 'var(--doctor)' }
  };
  var DEMO = [
    { role: 'patient', email: 'rohan.mehta@gmail.com', pass: 'patient123', name: 'Rohan Mehta' },
    { role: 'patient', email: 'sunita.pawar@gmail.com', pass: 'patient123', name: 'Sunita Pawar' },
    { role: 'patient', email: 'kavita.joshi@gmail.com', pass: 'patient123', name: 'Kavita Joshi' },
    { role: 'clinic', email: 'frontdesk@arogya.clinic', pass: 'clinic123', name: 'Arogya · Front desk' },
    { role: 'clinic', email: 'admin@arogya.clinic', pass: 'clinic123', name: 'Arogya · Admin' },
    { role: 'doctor', email: 'vikram.sethi@arogya.clinic', pass: 'doctor123', name: 'Dr. Vikram Sethi' },
    { role: 'doctor', email: 'anjali.rao@arogya.clinic', pass: 'doctor123', name: 'Dr. Anjali Rao' },
    { role: 'doctor', email: 'meera.iyer@arogya.clinic', pass: 'doctor123', name: 'Dr. Meera Iyer' }
  ];
  var loginRole = 'patient';
  function btnLabel(r) { return '<svg class="ic"><use href="#i-lock"/></svg>' + ROLES[r].btn; }
  window.setLoginRole = function (r) {
    loginRole = r; var a = ROLES[r];
    $('login-title').textContent = a.title; $('login-sub').textContent = a.sub; $('login-btn').innerHTML = btnLabel(r); $('login-signup').textContent = a.signup;
    $('login-err').classList.add('hidden');
    var radio = document.querySelector('.rolepick input[value="' + r + '"]'); if (radio) radio.checked = true;
  };
  window.fillDemo = function (i) {
    var u = DEMO[i]; setLoginRole(u.role);
    $('login-email').value = u.email; $('login-pass').value = u.pass; clearErr($('login-email')); clearErr($('login-pass')); $('login-btn').focus();
  };
  (function renderDemo() {
    var box = $('demo-list');
    ['patient', 'clinic', 'doctor'].forEach(function (r) {
      var g = document.createElement('div'); g.className = 'demo-grp'; g.style.setProperty('--role-c', ROLES[r].color);
      DEMO.forEach(function (u, i) {
        if (u.role !== r) return;
        var b = document.createElement('button'); b.type = 'button'; b.className = 'demo-acc';
        b.innerHTML = '<span class="sw"></span><span class="dn">' + esc(u.name) + '</span><span class="de">' + esc(u.email) + '</span><span class="dp">' + esc(u.pass) + '</span>';
        b.onclick = function () { fillDemo(i); }; g.appendChild(b);
      });
      box.appendChild(g);
    });
  })();
  window.togglePw = function (b) { var i = $('login-pass'); var show = i.type === 'password'; i.type = show ? 'text' : 'password'; b.textContent = show ? 'Hide' : 'Show'; };
  window.clearErr = function (i) { i.classList.remove('invalid'); $(i.id + '-err').classList.add('hidden'); $('login-err').classList.add('hidden'); };
  function bad(i) { i.classList.add('invalid'); $(i.id + '-err').classList.remove('hidden'); }
  function applyUser(u) {
    var who = document.querySelector('#portal-' + u.role + ' .who');
    who.querySelector('.avatar').textContent = u.ini;
    who.querySelector('.name').textContent = u.display || u.name;
    who.querySelector('.sub').textContent = u.sub || '';
    var lbl = { patient: 'Patient', clinic: 'Clinic', doctor: 'Doctor' }[u.role];
    $('proto-note').textContent = 'Signed in to the ' + lbl.toLowerCase() + ' portal as ' + u.name + '. Other portals are not accessible from this login.';
    var badge = $('role-badge-in'); badge.lastChild.textContent = lbl; badge.querySelector('.sw').style.background = ROLES[u.role].color;
    if (u.role === 'clinic') $('c-foot-reg').textContent = 'Reg. no. ' + (u.reg_no || '—');
    if (u.role === 'doctor') $('d-foot-hours').textContent = 'On duty ' + (u.hours_from || '') + '–' + (u.hours_to || '');
  }
  function enter(u, quiet) {
    USER = u; applyUser(u);
    document.body.classList.remove('auth');
    showPortal(u.role); showScreen(u.role, ROLES[u.role].home);
    if (!quiet) toast(u.hello || 'Signed in');
  }
  window.doLogin = function (e) {
    e.preventDefault();
    var em = $('login-email'), pw = $('login-pass'), ok = true;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em.value.trim())) { bad(em); ok = false; }
    if (pw.value.length < 6) { bad(pw); ok = false; }
    if (!ok) { (em.classList.contains('invalid') ? em : pw).focus(); return false; }
    var btn = $('login-btn'); btn.disabled = true; btn.textContent = 'Signing in…';
    api('POST', '/login', { role: loginRole, email: em.value.trim(), password: pw.value }).then(function (r) {
      token = r.token;
      ($('login-keep').checked ? localStorage : sessionStorage).setItem(TOKEN_KEY, token);
      enter(r.user);
    }).catch(function (err) {
      $('login-err-t').textContent = err.message; $('login-err').classList.remove('hidden'); pw.focus();
    }).finally(function () { btn.disabled = false; btn.innerHTML = btnLabel(loginRole); });
    return false;
  };
  window.logout = function () {
    token = ''; USER = null; localStorage.removeItem(TOKEN_KEY); sessionStorage.removeItem(TOKEN_KEY); lastPayload = {};
    stopSpeech();
    document.body.classList.add('auth'); $('login-pass').value = ''; $('login-err').classList.add('hidden'); closeModal(); window.scrollTo(0, 0);
    setTimeout(function () { $('login-email').focus(); }, 30);
  };
  document.body.classList.add('auth'); setLoginRole('patient');
  if (token) api('GET', '/me').then(function (u) { setLoginRole(u.role); enter(u, true); }).catch(function () { token = ''; localStorage.removeItem(TOKEN_KEY); sessionStorage.removeItem(TOKEN_KEY); });

  /* =====================================================================
     PATIENT PORTAL
     ===================================================================== */
  var PH = null;               /* last /patient/home payload */
  window.PE = { id: null };    /* current episode */

  function reqNote(r) {
    return '<div class="notice warn" style="margin-bottom:16px"><svg class="ic"><use href="#i-inbox"/></svg><span><b>' + esc(r.clinic_name) + '</b> has ' + (r.doctor_name ? 'assigned you to <b>' + esc(r.doctor_name) + '</b> and ' : '') + 'asked for a short intake before your visit. <a href="#" onclick="event.preventDefault();openRequest(' + r.id + ')">Answer now</a></span></div>';
  }
  function episodeCard(e) {
    var sh = e.active_shares[0];
    var chip = e.status === 'open' ? '<span class="chip warn">Ongoing · ' + esc(daysSince(e.started_at)) + '</span>' : '<span class="chip ok">Resolved · ' + fmtDate(e.resolved_at) + '</span>';
    var em = 'Started ' + fmtDate(e.started_at) + (sh ? ' · shared with ' + esc(sh.doctor_name ? sh.doctor_name + ', ' : '') + esc(sh.clinic_name) : '');
    var ef = '<span><b>' + e.doc_count + '</b> ' + (e.doc_count === 1 ? 'document' : 'documents') + '</span><span><b>' + e.intake_count + '</b> intake ' + (e.intake_count === 1 ? 'summary' : 'summaries') + '</span>' +
      (sh ? '<span><b>Shared</b> with ' + esc(sh.clinic_name) + (sh.expires_at ? ' until ' + fmtDate(sh.expires_at) : sh.duration === 'revoke' ? ' until revoked' : ' for this visit') + '</span>' : (e.shares.length ? '<span>Share ' + esc(e.shares[0].status) + '</span>' : '<span>Never shared</span>'));
    var rx = e.last_rx ? '<div class="notice ok" style="margin-top:12px"><svg class="ic"><use href="#i-check"/></svg><span>' + esc(e.last_rx.issued_by || 'Your doctor') + ' uploaded a prescription ' + fmtWhen(e.last_rx.created_at).toLowerCase() + '. <a href="#" onclick="event.preventDefault();event.stopPropagation();openFile(\'patient\',' + e.last_rx.id + ',' + JSON.stringify(e.last_rx.name).replace(/"/g, '&quot;') + ',\'' + esc(e.last_rx.mime || '') + '\')">Open it</a></span></div>' : '';
    return '<div class="card epi" onclick="openEpisode(' + e.id + ')"><div class="row" style="justify-content:space-between"><div class="et">' + esc(e.title) + '</div>' + chip + '</div><div class="em">' + em + '</div><div class="ef">' + ef + '</div>' + rx + '</div>';
  }
  function daysSince(s) { var d = parseTs(s); var n = Math.floor((Date.now() - d) / 86400000); return n <= 0 ? 'today' : n + (n === 1 ? ' day' : ' days'); }
  function kvProfile(p) {
    return '<dl class="kv"><dt>Blood group</dt><dd>' + esc(p.blood_group || '—') + '</dd><dt>Allergies</dt><dd>' + esc(p.allergies || 'None recorded') + '</dd><dt>Long-term conditions</dt><dd>' + esc(p.conditions || 'None recorded') + '</dd><dt>Regular medicines</dt><dd>' + esc(p.medicines || 'None recorded') + '</dd><dt>Emergency contact</dt><dd>' + esc(p.emergency_contact || '—') + '</dd></dl><p class="small faint" style="margin-top:10px">Included automatically in every share.</p>';
  }
  loaders['p-home'] = function () {
    api('GET', '/patient/home').then(function (h) {
      if (unchanged('p-home', h)) return;
      PH = h;
      $('p-doc-cnt').textContent = h.doc_count; $('p-req-cnt').textContent = h.requests.length;
      var rb = $('p-home-req'); rb.classList.toggle('hidden', !h.requests.length); rb.innerHTML = '<svg class="ic"><use href="#i-inbox"/></svg>' + plural(h.requests.length, 'clinic request');
      $('p-home-reqnote').innerHTML = h.requests.map(reqNote).join('');
      var open = h.episodes.filter(function (e) { return e.status === 'open'; }), done = h.episodes.filter(function (e) { return e.status !== 'open'; });
      $('p-epi-active').innerHTML = open.length ? open.map(episodeCard).join('') : '<div class="empty"><svg class="ic"><use href="#i-folder"/></svg><h4>No active problems</h4><p class="small">Upload a report or answer a clinic request and an episode is created for it.</p></div>';
      $('p-epi-resolved').innerHTML = done.map(episodeCard).join('');
      $('p-epi-resolved-wrap').style.display = done.length ? '' : 'none';
      $('p-whocan').innerHTML = (h.active_shares.length ? h.active_shares.map(function (s) { return '<div><div class="row" style="justify-content:space-between"><b>' + esc(s.clinic_name) + '</b><span class="chip ok">Active</span></div><div class="small muted">' + esc(s.episode_title || 'Episode') + ' · ' + (s.intake_id ? 'intake + ' : '') + plural(s.item_count, 'report') + (s.expires_at ? ' · until ' + fmtDate(s.expires_at) : s.duration === 'revoke' ? ' · until you revoke' : ' · this visit') + '</div></div>'; }).join('') : '') +
        '<div class="small faint">' + (h.active_shares.length ? 'No other clinic or doctor' : 'No clinic or doctor') + ' can see your records.</div>';
      $('p-profile').innerHTML = kvProfile(h.profile);
    }).catch(fail);
  };
  window.openProfile = function () {
    var p = PH ? PH.profile : {};
    $('pf-age').value = p.age || ''; $('pf-sex').value = p.sex || ''; $('pf-phone').value = p.phone || ''; $('pf-city').value = p.city || '';
    $('pf-bg').value = p.blood_group || ''; $('pf-all').value = p.allergies || ''; $('pf-cond').value = p.conditions || ''; $('pf-med').value = p.medicines || ''; $('pf-em').value = p.emergency_contact || '';
    openModal('m-profile');
  };
  window.saveProfile = function () {
    api('PUT', '/patient/profile', { age: $('pf-age').value, sex: $('pf-sex').value, phone: $('pf-phone').value, city: $('pf-city').value, blood_group: $('pf-bg').value, allergies: $('pf-all').value, conditions: $('pf-cond').value, medicines: $('pf-med').value, emergency_contact: $('pf-em').value })
      .then(function () { closeModal(); toast('Profile saved'); loaders['p-home'](); }).catch(fail);
  };

  /* ----- episode ----- */
  function docRowHtml(d, role, extra) {
    var vals = d.extracted && d.extracted.values ? d.extracted.values.filter(function (v) { return v.status && v.status !== 'normal' && v.status !== 'unknown'; }).slice(0, 3) : [];
    var meta = [d.doc_type, d.issued_by, d.doc_date ? fmtDate(d.doc_date) : null, d.uploader_role === 'doctor' ? 'uploaded by doctor' : 'you uploaded'].filter(Boolean).map(esc).join(' · ');
    if (vals.length) meta += ' · ' + vals.map(function (v) { return esc(v.name) + ' <span class="mono">' + esc(v.value) + '</span>'; }).join(' · ');
    var chip = d.flag_count ? '<span class="chip ' + (d.flags.some(function (f) { return f.level === 'crit'; }) ? 'crit' : 'warn') + '">' + plural(d.flag_count, 'flag') + '</span>' : (d.extracted ? '<span class="chip ok plain">Read by OCR</span>' : '');
    return '<div class="doc"><div class="th' + (/IMG/.test(d.th) ? ' img' : '') + '">' + esc(d.th) + '</div><div><div class="dn">' + esc(d.name) + '</div><div class="dm">' + meta + '</div>' + (d.extracted && d.extracted.summary ? '<div class="dm" style="margin-top:3px">' + esc(d.extracted.summary) + '</div>' : '') + '</div><div class="dr">' + (extra || '') + chip + '<button class="btn btn-sm" onclick="openFile(\'' + role + '\',' + d.id + ',' + JSON.stringify(d.name).replace(/"/g, '&quot;') + ',\'' + esc(d.mime || '') + '\')">Open</button></div></div>';
  }
  window.openEpisode = function (id) { showScreen('patient', 'p-episode', null, id); };
  loaders['p-episode'] = function (id) {
    if (id) PE.id = id; if (!PE.id) return showScreen('patient', 'p-home');
    api('GET', '/patient/episodes/' + PE.id).then(function (r) {
      var e = r.episode; PE.data = r;
      $('pe-crumb').textContent = e.title; $('pe-title').textContent = e.title;
      $('pe-sub').textContent = 'Started ' + fmtDate(e.started_at) + (e.status === 'open' ? ' · ongoing' : ' · resolved ' + fmtDate(e.resolved_at));
      $('pe-resolve').textContent = e.status === 'open' ? 'Mark resolved' : 'Reopen';
      $('pe-doc-n').textContent = r.documents.length;
      $('pe-docs').innerHTML = r.documents.length ? r.documents.map(function (d) { return docRowHtml(d, 'patient', d.shared ? '<span class="chip plain">Shared</span>' : '<button class="btn btn-sm btn-ghost" onclick="deleteDoc(' + d.id + ')">Delete</button>'); }).join('') : '<div class="small muted">No documents yet. <a href="#" onclick="event.preventDefault();gotoUpload(' + e.id + ')">Add one</a>.</div>';
      $('pe-int-n').textContent = plural(r.intakes.length, 'intake');
      $('pe-intakes').innerHTML = (r.intakes.length ? '<ul class="tl" style="margin-bottom:-18px">' + r.intakes.map(function (i) { return '<li class="done"><div class="tt"><a href="#" onclick="event.preventDefault();viewIntake(' + i.id + ')">Intake for ' + esc(i.doctor_name || i.clinic_name || 'clinic') + '</a></div><div class="ts">Answered by ' + (i.mode === 'voice' ? 'speaking' : 'typing') + ' · ' + plural(i.answers.length, 'answer') + (i.summary && i.summary.red_flags.length ? ' · ' + plural(i.summary.red_flags.length, 'flag') : '') + '</div><div class="tm">' + fmtWhen(i.sent_at) + (i.clinic_name ? ' · ' + esc(i.clinic_name) + ' request' : '') + '</div></li>'; }).join('') + '</ul>' : '<div class="small muted">No intake answered for this problem yet.</div>') +
        '<p class="small faint" style="margin-top:14px"><svg class="ic" style="width:13px;height:13px;vertical-align:-2px;margin-right:4px"><use href="#i-lock"/></svg>Your answers are kept with this problem and shown only to the doctor you send them to.</p>';
      $('pe-timeline').innerHTML = r.timeline.map(function (t, i) { return '<li class="' + (i === 0 ? 'now' : 'done') + '"><div class="tt">' + esc(t.t) + '</div>' + (t.s ? '<div class="ts">' + esc(t.s) + '</div>' : '') + '<div class="tm">' + fmtWhen(t.at) + '</div></li>'; }).join('');
      $('pe-shared').innerHTML = e.shares.length ? e.shares.map(function (s) { return '<div style="margin-bottom:10px"><div class="row" style="justify-content:space-between"><b>' + esc(s.clinic_name) + (s.doctor_name ? ' · ' + esc(s.doctor_name) : '') + '</b><span class="chip ' + (s.status === 'active' ? 'ok' : 'plain') + '">' + esc(s.status) + '</span></div><div class="small muted">' + (s.expires_at ? 'until ' + fmtDate(s.expires_at) : s.duration === 'revoke' ? 'until you revoke' : 'this visit') + '</div>' + (s.status === 'active' ? '<div class="row" style="margin-top:8px"><button class="btn btn-sm btn-danger" onclick="revokeShare(' + s.id + ')">Revoke</button></div>' : '') + '</div>'; }).join('') : '<div class="small muted">Not shared with anyone.</div>';
    }).catch(fail);
  };
  window.toggleResolved = function () {
    var e = PE.data.episode;
    api('PATCH', '/patient/episodes/' + e.id, { status: e.status === 'open' ? 'resolved' : 'open' }).then(function () { toast(e.status === 'open' ? 'Marked as resolved. You can reopen it anytime.' : 'Episode reopened'); loaders['p-episode'](); }).catch(fail);
  };
  window.deleteDoc = function (id) {
    if (!confirm('Delete this document from your record?')) return;
    api('DELETE', '/patient/documents/' + id).then(function () { toast('Document deleted'); loaders['p-episode'](); }).catch(fail);
  };
  window.revokeShare = function (id) {
    api('POST', '/patient/shares/' + id + '/revoke').then(function () { toast('Access revoked'); if ($('p-episode').classList.contains('active')) loaders['p-episode'](); else loaders['p-sharing'](); }).catch(fail);
  };
  window.viewIntake = function (id) {
    var i = (PE.data ? PE.data.intakes : []).filter(function (x) { return x.id === id; })[0]; if (!i) return;
    $('m-iv-sub').textContent = 'Sent ' + fmtWhen(i.sent_at) + ' · answered by ' + (i.mode === 'voice' ? 'speaking' : 'typing');
    $('m-iv-body').innerHTML = summaryHtml(i, true);
    openModal('m-intake-view');
  };

  /* ----- upload ----- */
  var UP = { id: null, extracted: null };
  window.gotoUpload = function (epId) { showScreen('patient', 'p-upload', null, epId); };
  loaders['p-upload'] = function (epId) {
    resetUpload();
    api('GET', '/patient/episodes').then(function (eps) {
      var sel = $('upepi');
      sel.innerHTML = eps.map(function (e) { return '<option value="' + e.id + '">' + esc(e.title) + ' (' + (e.status === 'open' ? 'ongoing' : 'resolved') + ')</option>'; }).join('') + '<option value="new">— Start a new problem —</option>';
      if (epId) sel.value = String(epId); else if (!eps.length) sel.value = 'new';
      $('upnew-wrap').style.display = sel.value === 'new' ? '' : 'none';
    }).catch(fail);
    var drop = $('up-drop');
    drop.ondragover = function (e) { e.preventDefault(); drop.style.borderColor = 'var(--accent)'; };
    drop.ondragleave = function () { drop.style.borderColor = ''; };
    drop.ondrop = function (e) { e.preventDefault(); drop.style.borderColor = ''; if (e.dataTransfer.files[0]) uploadPicked(e.dataTransfer.files[0]); };
  };
  function resetUpload() {
    UP = { id: null, extracted: null };
    $('up-filerow').innerHTML = ''; $('up-extract').innerHTML = ''; $('up-form').style.display = 'none'; $('up-actions').style.display = 'none'; $('up-save').disabled = true; $('up-file').value = '';
    $('upname').value = ''; $('upfrom').value = ''; $('update').value = new Date().toISOString().slice(0, 10);
  }
  window.uploadPicked = function (file) {
    if (!file) return;
    if (file.size > 25 * 1024 * 1024) return toast('File is larger than 25 MB', 'err');
    var fd = new FormData(); fd.append('file', file);
    $('up-filerow').innerHTML = '<div class="doc"><div class="th">' + (/pdf/i.test(file.type) ? 'PDF' : 'IMG') + '</div><div><div class="dn">' + esc(file.name) + '</div><div class="dm">' + (file.size / 1024 / 1024).toFixed(1) + ' MB · uploading and reading…</div><div class="prog" style="margin-top:6px;width:200px"><i id="up-prog" style="width:30%"></i></div></div><div class="dr"><span class="chip info">Reading</span></div></div>';
    $('up-actions').style.display = ''; $('up-save').disabled = true;
    var w = 30, t = setInterval(function () { w = Math.min(90, w + 6); var b = $('up-prog'); if (b) b.style.width = w + '%'; }, 400);
    api('POST', '/patient/documents/upload', fd).then(function (r) {
      clearInterval(t);
      UP.id = r.id; UP.extracted = r.extracted;
      var ex = r.extracted || {};
      $('up-filerow').innerHTML = '<div class="doc"><div class="th">' + (/pdf/i.test(file.type) ? 'PDF' : 'IMG') + '</div><div><div class="dn">' + esc(file.name) + '</div><div class="dm">' + (file.size / 1024 / 1024).toFixed(1) + ' MB · uploaded · OCR: ' + esc(r.ocr_engine) + ', ' + r.ocr_chars + ' characters read</div><div class="prog" style="margin-top:6px;width:200px"><i style="width:100%"></i></div></div><div class="dr"><span class="chip ok">Ready</span></div></div>';
      $('up-form').style.display = '';
      $('upname').value = ex.title || file.name.replace(/\.[^.]+$/, '');
      if (ex.doc_type) $('uptype').value = ex.doc_type;
      if (ex.doc_date) $('update').value = ex.doc_date;
      $('upfrom').value = ex.issued_by || '';
      if (r.error) $('up-extract').innerHTML = '<div class="notice warn"><svg class="ic"><use href="#i-alert"/></svg><span>Could not read this file automatically (' + esc(r.error) + '). You can still save it; fill the details by hand.</span></div>';
      else if (ex.readable === false) $('up-extract').innerHTML = '<div class="notice warn"><svg class="ic"><use href="#i-alert"/></svg><span>The file could not be read. Try a clearer photo, or save it as is.</span></div>';
      else $('up-extract').innerHTML = '<div class="card" style="background:var(--surface-2)"><div class="cb"><div class="label" style="margin-bottom:8px">We read these values · please confirm</div>' + extractHtml(ex) + '</div></div>';
      $('up-save').disabled = false;
    }).catch(function (e) { clearInterval(t); resetUpload(); fail(e); });
  };
  function extractHtml(ex) {
    var h = '<dl class="kv">';
    if (ex.summary) h += '<dt>Summary</dt><dd>' + esc(ex.summary) + '</dd>';
    (ex.values || []).forEach(function (v) { h += '<dt>' + esc(v.name) + '</dt><dd><span class="mono">' + esc(v.value) + (v.unit ? ' ' + esc(v.unit) : '') + '</span>' + (v.ref ? ' <span class="faint small">ref ' + esc(v.ref) + '</span>' : '') + (v.status && v.status !== 'normal' && v.status !== 'unknown' ? ' <span class="chip ' + (v.status === 'critical' ? 'crit' : 'warn') + '">' + esc(v.status) + '</span>' : '') + '</dd>'; });
    h += '</dl>';
    if (ex.red_flags && ex.red_flags.length) h += '<div class="stack" style="gap:8px;margin-top:12px">' + ex.red_flags.map(flagHtml).join('') + '</div>';
    return h;
  }
  function flagHtml(f) { return '<div class="flag' + (f.level === 'crit' ? '' : ' warn') + '"><div><div class="ft">' + esc(f.title) + '</div>' + (f.detail ? '<div class="fs">' + esc(f.detail) + '</div>' : '') + '</div></div>'; }
  window.cancelUpload = function () { if (UP.id) api('DELETE', '/patient/documents/' + UP.id).catch(function () {}); resetUpload(); };
  window.saveUpload = function () {
    if (!UP.id) return;
    var body = { name: $('upname').value.trim(), doc_type: $('uptype').value, doc_date: $('update').value, issued_by: $('upfrom').value.trim() };
    if ($('upepi').value === 'new') { body.new_episode_title = $('upnew').value.trim(); if (!body.new_episode_title) return toast('Name the new problem first', 'err'); }
    else body.episode_id = Number($('upepi').value);
    if (!body.name) return toast('Give the document a name', 'err');
    $('up-save').disabled = true;
    api('PATCH', '/patient/documents/' + UP.id, body).then(function (d) {
      toast('Saved. Not shared with anyone yet.');
      openEpisode(d.episode_id);
    }).catch(function (e) { $('up-save').disabled = false; fail(e); });
  };

  /* ----- vault ----- */
  var PV = null;
  loaders['p-vault'] = function () { api('GET', '/patient/documents').then(function (r) { PV = r; renderVault(); }).catch(fail); };
  window.renderVault = function () {
    if (!PV) return;
    var qv = ($('pv-search').value || '').toLowerCase();
    $('pv-sub').textContent = plural(PV.documents.length, 'document') + ' across ' + plural(PV.episodes.length, 'episode') + '. Grouped by episode so nothing gets mixed up.';
    var docs = PV.documents.filter(function (d) { return !qv || (d.name + ' ' + (d.issued_by || '') + ' ' + JSON.stringify(d.extracted || '')).toLowerCase().indexOf(qv) > -1; });
    var groups = PV.episodes.map(function (e) {
      var ds = docs.filter(function (d) { return d.episode_id === e.id; }); if (!ds.length && qv) return '';
      return '<div class="card"><div class="ch"><h3><a href="#" onclick="event.preventDefault();openEpisode(' + e.id + ')" style="color:inherit;text-decoration:none">' + esc(e.title) + '</a></h3><span class="chip ' + (e.status === 'open' ? 'warn' : 'ok') + '">' + (e.status === 'open' ? 'Ongoing' : 'Resolved') + '</span><span class="faint small">' + plural(ds.length, 'document') + '</span></div>' + (ds.length ? '<div class="cb">' + ds.map(function (d) { return '<div class="doc-row"><div><b>' + esc(d.name) + '</b><div class="small muted">' + esc(d.issued_by || (d.uploader_role === 'doctor' ? 'From your doctor' : '—')) + '</div></div><span class="mono small">' + (d.doc_date ? fmtDate(d.doc_date) : fmtDate(d.created_at)) + '</span><span class="tag">' + esc(d.doc_type || 'Document') + '</span><span class="small muted">' + (d.shared_with.length ? 'Shared: ' + esc(d.shared_with.join(', ')) : 'Not shared') + '</span><button class="btn btn-sm btn-ghost" onclick="openFile(\'patient\',' + d.id + ',' + JSON.stringify(d.name).replace(/"/g, '&quot;') + ',\'' + esc(d.mime || '') + '\')">Open</button></div>'; }).join('') + '</div>' : '') + '</div>';
    }).join('');
    $('pv-list').innerHTML = groups || '<div class="empty"><svg class="ic"><use href="#i-folder"/></svg><h4>No documents yet</h4><p class="small">Upload a report to start your vault.</p></div>';
  };

  /* ----- sharing ----- */
  loaders['p-sharing'] = function () {
    api('GET', '/patient/sharing').then(function (r) {
      if (unchanged('p-sharing', r)) return;
      $('ps-req-cnt').textContent = r.requests.length; $('p-req-cnt').textContent = r.requests.length; $('ps-active-cnt').textContent = r.active.length; $('ps-ended-cnt').textContent = r.ended.length;
      $('ps-req-list').innerHTML = r.requests.map(function (q) {
        return '<div class="card perm" style="border-left:3px solid var(--terracotta)"><div class="avatar" style="background:var(--clinic)">' + esc(initials(q.clinic_name)) + '</div><div class="pc"><div class="pn">' + esc(q.clinic_name) + ' <span class="chip accent" style="margin-left:6px">New</span></div><div class="pm">Front desk ' + (q.doctor_name ? 'assigned you to <b>' + esc(q.doctor_name) + '</b>' + (q.specialty ? ' (' + esc(q.specialty) + ')' : '') : 'added you to the queue') + (q.episode_title ? ' for <b>' + esc(q.episode_title) + '</b>' : '') + ' · ' + fmtWhen(q.created_at).toLowerCase() + '</div>' + (q.note ? '<div class="pm" style="margin-top:4px"><b>Reason:</b> ' + esc(q.note) + '</div>' : '') + '<div class="pm" style="margin-top:6px">They ask for: a short intake (answer by speaking or typing) and any previous reports you want the doctor to see.</div><div class="pi"><span class="tag">Intake questions</span><span class="tag">Previous reports (optional)</span><span class="tag">Profile basics</span></div></div><div class="actions"><button class="btn btn-sm btn-ghost" onclick="declineRequest(' + q.id + ')">Decline</button><button class="btn btn-sm btn-primary" onclick="openRequest(' + q.id + ')">Open request</button></div></div>';
      }).join('');
      $('req-empty').classList.toggle('hidden', !!r.requests.length);
      function shareCard(s, ended) {
        var tags = (s.intake ? '<span class="tag">Intake (' + (s.intake.mode === 'voice' ? 'spoken' : 'typed') + ')</span>' : '') + s.docs.map(function (d) { return '<span class="tag">' + esc(d.name) + '</span>'; }).join('') + (s.include_profile ? '<span class="tag">Profile basics</span>' : '');
        return '<div class="card perm"' + (ended ? ' style="opacity:.8"' : '') + '><div class="avatar" style="background:var(--' + (ended ? 'ink-3' : 'clinic') + ')">' + esc(initials(s.clinic_name)) + '</div><div class="pc"><div class="pn">' + esc(s.clinic_name) + (s.doctor_name ? ' · ' + esc(s.doctor_name) : '') + (!ended && !s.accepted ? ' <span class="chip warn" style="margin-left:6px">Waiting for clinic</span>' : '') + '</div><div class="pm">Episode: <b>' + esc(s.episode_title || '—') + '</b> · shared ' + fmtWhen(s.created_at).toLowerCase() + ' · ' + (ended ? esc(s.status) + ' ' + fmtWhen(s.ended_at).toLowerCase() : (s.expires_at ? 'ends ' + fmtDate(s.expires_at) : s.duration === 'revoke' ? 'until you revoke' : 'ends when this visit closes')) + '</div><div class="pi">' + tags + '</div></div><div class="actions">' + (ended ? '<button class="btn btn-sm btn-ghost" onclick="openShare(' + (s.episode_id || 'null') + ')">Share again</button>' : '<button class="btn btn-sm btn-danger" onclick="revokeShare(' + s.id + ')">Revoke</button>') + '</div></div>';
      }
      $('ps-active-list').innerHTML = r.active.length ? r.active.map(function (s) { return shareCard(s, false); }).join('') : '<div class="empty"><svg class="ic"><use href="#i-share"/></svg><h4>Nothing shared right now</h4><p class="small">Answer a clinic request, or share an episode yourself.</p></div>';
      $('ps-ended-list').innerHTML = r.ended.length ? r.ended.map(function (s) { return shareCard(s, true); }).join('') : '<div class="empty"><h4>No ended shares</h4></div>';
      $('ps-log-list').innerHTML = r.log.length ? r.log.map(function (l, i) { return '<li class="' + (i === 0 ? 'now' : 'done') + '"><div class="tt">' + esc(l.action) + '</div><div class="tm">' + fmtWhen(l.created_at) + (l.clinic_name ? ' · ' + esc(l.clinic_name) : '') + '</div></li>'; }).join('') : '<li class="done"><div class="tt">Nothing yet</div><div class="tm">Every view of your records is listed here.</div></li>';
    }).catch(fail);
  };
  window.declineRequest = function (id) { api('POST', '/patient/requests/' + id + '/decline').then(function () { toast('Request declined. The clinic has been told.'); loaders['p-sharing'](); }).catch(fail); };

  /* share modal (patient-initiated) */
  var SH = { clinics: [], docs: null };
  window.openShare = function (epId) {
    Promise.all([api('GET', '/patient/clinics'), api('GET', '/patient/documents'), api('GET', '/patient/home')]).then(function (rs) {
      SH.clinics = rs[0]; SH.docs = rs[1]; SH.home = rs[2];
      $('sh-clinic').innerHTML = rs[0].map(function (c) { return '<option value="' + c.id + '">' + esc(c.name) + (c.address ? ', ' + esc(c.address.split(',').slice(-2).join(',').trim()) : '') + '</option>'; }).join('');
      var eps = rs[1].episodes;
      if (!eps.length) return toast('Upload a report or answer a request first to create an episode', 'err');
      $('sh-epi').innerHTML = eps.map(function (e) { return '<option value="' + e.id + '">' + esc(e.title) + ' (' + (e.status === 'open' ? 'ongoing' : 'resolved') + ')</option>'; }).join('');
      if (epId) $('sh-epi').value = String(epId);
      renderShareItems(); openModal('m-share');
    }).catch(fail);
  };
  window.renderShareItems = function () {
    var epId = Number($('sh-epi').value);
    var ep = SH.home.episodes.filter(function (e) { return e.id === epId; })[0];
    var docs = SH.docs.documents.filter(function (d) { return d.episode_id === epId; });
    var h = '';
    if (ep && ep.intake_count) h += '<label class="check"><input type="checkbox" checked data-kind="intake"><div><div class="t">Latest intake summary</div><div class="s">Your answers and flags from this episode</div></div></label>';
    h += docs.map(function (d) { return '<label class="check"><input type="checkbox" checked data-doc="' + d.id + '"><div><div class="t">' + esc(d.name) + '</div><div class="s">' + esc(d.issued_by || d.doc_type || '') + (d.doc_date ? ' · ' + fmtDate(d.doc_date) : '') + '</div></div></label>'; }).join('');
    h += '<label class="check"><input type="checkbox" checked data-kind="profile"><div><div class="t">Profile basics</div><div class="s">Blood group, allergies, long-term conditions, medicines, emergency contact</div></div></label>';
    $('sh-items').innerHTML = h;
    updateShareBtn(); $('sh-items').querySelectorAll('input').forEach(function (i) { i.onchange = updateShareBtn; });
  };
  function updateShareBtn() { $('sh-btn').textContent = 'Share ' + plural($('sh-items').querySelectorAll('input:checked').length, 'item'); }
  window.doShare = function () {
    var epId = Number($('sh-epi').value);
    var docIds = Array.prototype.map.call($('sh-items').querySelectorAll('input[data-doc]:checked'), function (i) { return Number(i.dataset.doc); });
    var intakeCb = $('sh-items').querySelector('input[data-kind=intake]');
    var body = { clinic_id: Number($('sh-clinic').value), episode_id: epId, document_ids: docIds, include_profile: !!$('sh-items').querySelector('input[data-kind=profile]:checked'), duration: document.querySelector('input[name=dur]:checked').value };
    var go = function () { api('POST', '/patient/shares', body).then(function () { closeModal(); toast('Shared with the clinic. They will see it at the front desk.'); if ($('p-sharing').classList.contains('active')) loaders['p-sharing'](); else if ($('p-episode').classList.contains('active')) loaders['p-episode'](); else loaders['p-home'](); }).catch(fail); };
    if (intakeCb && intakeCb.checked) api('GET', '/patient/episodes/' + epId).then(function (r) { if (r.intakes[0]) body.intake_id = r.intakes[0].id; go(); }).catch(fail); else go();
  };

  /* =====================================================================
     INTAKE ENGINE (request-driven, questions from the language module)
     ===================================================================== */
  window.IQ = null;            /* global: inline handlers in rendered HTML read it */
  var QUESTION_ESTIMATE = 12;   /* ~6 complaint follow-ups + 6 Dashavidha questions */
  function newIQ() { return { id: null, request: null, phase: 'mode', mode: null, questions: [], history: [], pain: null, urgentOptions: null, urgent: {}, hasReports: null, docs: null, picked: {}, preview: null, episodeId: null, busy: false }; }
  window.openRequest = function (reqId) {
    IQ = newIQ();
    api('POST', '/intake/start', { request_id: reqId }).then(function (r) {
      IQ.id = r.intake.id; IQ.request = r.request; IQ.episodeId = r.request.episode_id || null;
      IQ.questions = [r.first];
      /* resume a saved draft */
      if (r.intake.answers && r.intake.answers.length) { IQ.history = r.intake.answers.map(function (a) { return { q: a.q, a: a.a, field: a.field, kind: a.kind, section: a.section || 'complaint' }; }); IQ.questions = IQ.history.map(function (h) { return { question: h.q, field: h.field, kind: h.kind, hint: '', section: h.section }; }); }
      if (r.intake.mode && r.intake.answers.length) IQ.mode = r.intake.mode;
      if (r.intake.pain != null) IQ.pain = r.intake.pain;
      $('qs-crumb').textContent = 'Request from ' + r.request.clinic_name;
      $('qs-h1').textContent = r.request.doctor_name ? 'Intake for ' + r.request.doctor_name : 'Intake for ' + r.request.clinic_name;
      $('qs-sub').textContent = r.request.clinic_name + ' asked a few questions before your visit. Not a diagnosis. Sent only when you press Send.';
      showScreen('patient', 'p-intake');
      document.querySelectorAll('#portal-patient .navb').forEach(function (b) { b.removeAttribute('aria-current'); if ((b.getAttribute('onclick') || '').indexOf('p-sharing') > -1) b.setAttribute('aria-current', 'page'); });
      if (IQ.history.length && IQ.mode) { IQ.phase = 'q'; qAdvance(true); } else renderQ();
    }).catch(fail);
  };
  window.exitIntake = function () { stopSpeech(); if (IQ && IQ.phase === 'q' && IQ.history.length) saveProgress(); showScreen('patient', 'p-sharing'); };
  function saveProgress() { return api('POST', '/intake/' + IQ.id + '/next', { history: IQ.history, mode: IQ.mode, pain: IQ.pain }).catch(function () {}); }
  function stepInfo() {
    var qn = Math.max(IQ.questions.length, IQ.history.length + 1);
    var qTotal = IQ.phase === 'q' ? Math.max(qn, QUESTION_ESTIMATE) : IQ.history.length;
    var tail = 3 + (IQ.hasReports ? 1 : 0);
    var total = 1 + qTotal + tail, n;
    switch (IQ.phase) { case 'mode': n = 1; break; case 'q': n = 1 + IQ.history.length + 1; break; case 'urgent': n = 1 + qTotal + 1; break; case 'reports': n = 1 + qTotal + 2; break; case 'pick': n = 1 + qTotal + 3; break; default: n = total; }
    return { n: n, total: total };
  }
  function currentQ() { return IQ.questions[IQ.history.length]; }
  window.renderQ = renderQ;
  function renderQ() {
    var si = stepInfo();
    $('qs-n').textContent = si.n; $('qs-max').textContent = si.total; $('qs-bar').style.width = Math.round(si.n / si.total * 100) + '%';
    $('qs-back').disabled = IQ.phase === 'mode' || IQ.busy;
    var nb = $('qs-next'); nb.disabled = IQ.busy; nb.textContent = IQ.phase === 'summary' ? 'Send to ' + (IQ.request.doctor_name || IQ.request.clinic_name) : 'Continue';
    var titles = { mode: 'How would you like to answer?', q: 'Questions', urgent: 'Anything urgent?', reports: 'Previous reports', pick: 'Choose reports to share', summary: 'Review and send' };
    $('qs-title').textContent = titles[IQ.phase];
    var h = '';
    if (IQ.phase === 'mode') {
      h = '<h2 style="margin-bottom:4px">How would you like to answer?</h2><p class="muted small" style="margin-bottom:16px">Same questions either way. The questions come one at a time and follow what you say, like a doctor would ask.</p><div class="modepick">' +
        '<label><input type="radio" name="iq-mode" value="voice"' + (IQ.mode === 'voice' ? ' checked' : '') + ' onchange="setMode(\'voice\')"><span class="mi"><svg><use href="#i-mic"/></svg></span><span class="mt">Speak your answers</span><span class="ms">We read each question aloud. Tap the mic and talk. You can fix the text after.' + (hasSTT() ? '' : ' (Your browser has no speech recognition; we will record and transcribe.)') + '</span></label>' +
        '<label><input type="radio" name="iq-mode" value="text"' + (IQ.mode === 'text' ? ' checked' : '') + ' onchange="setMode(\'text\')"><span class="mi"><svg><use href="#i-keyboard"/></svg></span><span class="mt">Type your answers</span><span class="ms">Read each question and type. Good in a quiet waiting room.</span></label></div>';
      nb.disabled = !IQ.mode;
    } else if (IQ.phase === 'q') {
      var q = currentQ();
      if (!q) { h = '<div class="empty"><h4>Thinking of the next question…</h4></div>'; }
      else {
        var prev = IQ.history[IQ.history.length] ? '' : (IQ.pendingAnswer || '');
        if (q.section === 'dashavidha') h += '<div class="row" style="justify-content:space-between;margin-bottom:10px"><span class="chip accent plain">Dashavidha Pariksha</span><span class="small faint">' + esc(q.label || 'Ayurvedic tenfold examination') + '</span></div>' + (IQ.history.filter(function (x) { return x.section === 'dashavidha'; }).length === 0 ? '<p class="muted small" style="margin-bottom:12px">A few questions about your constitution, digestion, strength and habits. They help the doctor see the whole person, not only the complaint.</p>' : '');
        h += '<h2 style="margin-bottom:4px">' + esc(q.question) + '</h2><p class="muted small" style="margin-bottom:14px">' + esc(IQ.mode === 'voice' ? 'We read this out. Tap the mic when ready.' + (q.kind === 'scale' ? ' Say a number or tap one.' : q.kind === 'yesno' ? ' Say yes or no, or tap.' : '') : (q.hint || '')) + '</p>';
        if (q.kind === 'scale') h += '<div class="scale" id="q-scale" aria-label="0 to 10">' + [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(function (n) { return '<button type="button" aria-pressed="' + (String(n) === String(IQ.pendingAnswer)) + '" onclick="setAnswer(\'' + n + '\')">' + n + '</button>'; }).join('') + '</div><p class="small faint" style="margin-top:8px">0 is none, 10 is the worst you can imagine.</p>' + (IQ.mode === 'voice' ? voiceBlock('') : '');
        else if (q.kind === 'yesno') h += '<div class="yesno"><label class="opt" style="text-align:center;padding:16px"><input type="radio" name="iq-yn"' + (/^yes/i.test(prev) ? ' checked' : '') + ' onchange="setAnswer(\'Yes\')">Yes</label><label class="opt" style="text-align:center;padding:16px"><input type="radio" name="iq-yn"' + (/^no/i.test(prev) ? ' checked' : '') + ' onchange="setAnswer(\'No\')">No</label></div><div class="field" style="margin-top:12px"><textarea class="input" id="ans-extra" rows="2" placeholder="Add a detail if you like (optional)" oninput="IQ.extra=this.value"></textarea></div>' + (IQ.mode === 'voice' ? voiceBlock('') : '');
        else h += (IQ.mode === 'voice' ? voiceBlock(prev) : '<div class="field"><textarea class="input" id="ans" rows="4" placeholder="Type your answer…" oninput="IQ.pendingAnswer=this.value">' + esc(prev) + '</textarea><span class="hint">' + esc(q.hint || '') + '</span></div>');
      }
    } else if (IQ.phase === 'urgent') {
      h = '<h2 style="margin-bottom:4px">Anything urgent?</h2><p class="muted small" style="margin-bottom:14px">These warning signs are specific to what you described. If yes to any, we mark it clearly for the doctor.</p>';
      if (!IQ.urgentOptions) h += '<div class="empty"><h4>Preparing the warning signs…</h4></div>';
      else h += '<div class="opts">' + IQ.urgentOptions.map(function (s, i) { return '<label class="check"><input type="checkbox" onchange="IQ.urgent[' + i + ']=this.checked;syncNone()"' + (IQ.urgent[i] ? ' checked' : '') + '><div><div class="t">' + esc(s.label) + '</div>' + (s.why ? '<div class="s">' + esc(s.why) + '</div>' : '') + '</div></label>'; }).join('') + '<label class="check"><input type="checkbox" id="urg-none"' + (Object.keys(IQ.urgent).some(function (k) { return IQ.urgent[k]; }) ? '' : ' checked') + ' onchange="if(this.checked){IQ.urgent={};renderQ()}"><div><div class="t">None of these</div></div></label></div>' +
        '<div class="notice crit" style="margin-top:14px"><svg class="ic"><use href="#i-alert"/></svg><span>Severe breathlessness, crushing chest pain, a suspected fracture or heavy bleeding: go to the nearest emergency department now instead of continuing here.</span></div>';
    } else if (IQ.phase === 'reports') {
      h = '<h2 style="margin-bottom:4px">Do you have any previous reports for this problem?</h2><p class="muted small" style="margin-bottom:16px">X-rays, scans, lab results, old prescriptions. Sharing them saves the doctor from repeating tests. Reports are read by OCR so the doctor sees the key values at a glance.</p><div class="yesno">' +
        '<label class="opt" style="text-align:center;padding:16px"><input type="radio" name="iq-rep"' + (IQ.hasReports === true ? ' checked' : '') + ' onchange="setReports(true)">Yes, I have reports</label><label class="opt" style="text-align:center;padding:16px"><input type="radio" name="iq-rep"' + (IQ.hasReports === false ? ' checked' : '') + ' onchange="setReports(false)">No, nothing to add</label></div><p class="small faint" style="margin-top:14px">You can always share reports later from Sharing.</p>';
      nb.disabled = IQ.hasReports === null;
    } else if (IQ.phase === 'pick') {
      h = '<h2 style="margin-bottom:4px">Choose reports to share with ' + esc(IQ.request.doctor_name || IQ.request.clinic_name) + '</h2><p class="muted small" style="margin-bottom:14px">Only ticked items are shared. Files already in your documents are listed first; upload a new one below and it is read by OCR right away.</p>';
      if (!IQ.docs) h += '<div class="empty"><h4>Loading your documents…</h4></div>';
      else h += '<div class="stack" style="gap:8px" id="doc-list">' + IQ.docs.map(pickRow).join('') +
        '<label class="doc-pick new" id="doc-add" style="cursor:pointer"><input type="file" id="doc-add-file" accept=".pdf,.jpg,.jpeg,.png,.webp" style="display:none" onchange="addDoc(this.files[0])"><span class="th"><svg class="ic" style="width:16px;height:16px"><use href="#i-upload"/></svg></span><span><span class="dn">Add a report not in your documents</span><span class="dm" style="display:block">Photo or PDF · saved to this problem, then shared here</span></span><span class="dd"><span class="btn btn-sm btn-ghost">Upload</span></span></label></div>' +
        '<div class="notice plain" style="margin-top:14px"><svg class="ic"><use href="#i-lock"/></svg><span>Shared until the visit ends unless you extend it. Profile basics (blood group, allergies, medicines) are always included.</span></div>';
    } else if (IQ.phase === 'summary') {
      var flags = Object.keys(IQ.urgent).filter(function (k) { return IQ.urgent[k]; }).map(function (k) { return IQ.urgentOptions[k].label; });
      var picked = (IQ.docs || []).filter(function (d) { return IQ.picked[d.id]; });
      h = '<h2 style="margin-bottom:4px">Review and send</h2><p class="muted small" style="margin-bottom:14px">This is exactly what ' + esc(IQ.request.clinic_name) + (IQ.request.doctor_name ? ' and ' + esc(IQ.request.doctor_name) : '') + ' will see. Answered by ' + (IQ.mode === 'voice' ? 'speaking' : 'typing') + '.</p>';
      if (!IQ.preview) h += '<div class="empty"><h4>Preparing your summary…</h4><p class="small">Reading your answers' + (picked.length ? ' and ' + plural(picked.length, 'report') : '') + '.</p></div>';
      else {
        var s = IQ.preview.summary;
        h += '<dl class="kv" style="margin-bottom:16px">' + s.fields.map(function (f) { return '<dt>' + esc(f.k) + '</dt><dd>' + esc(f.v) + '</dd>'; }).join('') +
          '<dt>Urgent signs</dt><dd>' + (flags.length ? '<span class="chip crit">' + plural(flags.length, 'sign') + ' flagged</span> ' + esc(flags.join('; ')) : 'None') + '</dd>' +
          '<dt>Reports</dt><dd>' + (IQ.hasReports ? (picked.length ? picked.map(function (d) { return '<span class="tag">' + esc(d.name) + '</span>'; }).join(' ') : 'None selected') : 'None to add') + '</dd></dl>';
        if (s.red_flags.length) h += '<div class="stack" style="gap:8px;margin-bottom:14px">' + s.red_flags.map(flagHtml).join('') + '</div>';
        if (s.dashavidha) h += dashavidhaHtml(s.dashavidha) + '<div style="height:14px"></div>';
        h += '<div class="disclaim"><b>For reference only.</b> ' + (s.considerations.length ? 'Based on your answers, the doctor may want to look at: ' + s.considerations.map(function (c) { return esc(c.name); }).join('; ') + '. ' : '') + 'Only an examination can tell. This tool does not diagnose or treat.</div>';
      }
    }
    $('qs-body').innerHTML = h;
    var ta = $('ans'); if (ta && IQ.mode === 'text') setTimeout(function () { ta.focus(); }, 30);
    if (IQ.phase === 'q' && IQ.mode === 'voice' && currentQ()) speak(questionSpeech(currentQ()), afterQuestion);
    else if (IQ.phase !== 'q') stopSpeech();
  }
  function voiceBlock(val) {
    return '<div class="voice"><button type="button" class="mic" id="mic" onclick="micTap()" aria-label="Tap to speak"><svg><use href="#i-mic"/></svg></button><div class="vs" id="mic-status">' + (val ? 'Recorded. Tap the mic to answer again.' : 'Tap the mic, then speak your answer') + '</div>' +
      '<button type="button" class="btn btn-sm btn-ghost" id="say-again" onclick="sayAgain()" style="margin-top:8px"><svg class="ic"><use href="#i-mic"/></svg>Read the question again</button>' +
      '<div class="transcript' + (val ? '' : ' hidden') + '" id="transcript"><div class="label"><span>What we heard</span><button type="button" onclick="document.getElementById(\'ans\').focus()">Edit</button></div><textarea class="input" id="ans" rows="3" oninput="IQ.pendingAnswer=this.value">' + esc(val) + '</textarea></div></div>';
  }
  function pickRow(d) { return '<label class="doc-pick"><input type="checkbox"' + (IQ.picked[d.id] ? ' checked' : '') + ' onchange="IQ.picked[' + d.id + ']=this.checked"><span class="th">' + esc(d.th) + '</span><span><span class="dn">' + esc(d.name) + '</span><span class="dm" style="display:block">' + esc([d.issued_by, d.doc_type, d.episode_title].filter(Boolean).join(' · ')) + (d.flag_count ? ' · ' + plural(d.flag_count, 'flag') : '') + '</span></span><span class="dd">' + (d.doc_date ? fmtDate(d.doc_date) : '') + '</span></label>'; }
  window.setMode = function (m) { IQ.mode = m; $('qs-next').disabled = false; if (m === 'voice') speak('We will read each question aloud. Tap the mic and speak your answer. Press Continue to start.'); else stopSpeech(); };
  window.setReports = function (v) { IQ.hasReports = v; $('qs-next').disabled = false; };
  window.setAnswer = function (v) { IQ.pendingAnswer = String(v); };
  window.syncNone = function () { var n = $('urg-none'); if (n) n.checked = !Object.keys(IQ.urgent).some(function (k) { return IQ.urgent[k]; }); };
  window.addDoc = function (file) {
    if (!file) return;
    var add = $('doc-add'); add.querySelector('.dn').textContent = 'Uploading ' + file.name + '…';
    add.querySelector('.dm').innerHTML = '<div class="prog" style="margin-top:6px;width:180px"><i id="doc-prog" style="width:10%"></i></div>';
    var w = 10, t = setInterval(function () { w = Math.min(90, w + 8); var b = $('doc-prog'); if (b) b.style.width = w + '%'; }, 400);
    var fd = new FormData(); fd.append('file', file);
    api('POST', '/patient/documents/upload', fd).then(function (r) {
      var ex = r.extracted || {};
      var body = { name: ex.title || file.name.replace(/\.[^.]+$/, ''), doc_type: ex.doc_type || 'Other', doc_date: ex.doc_date || '', issued_by: ex.issued_by || '' };
      if (IQ.episodeId) body.episode_id = IQ.episodeId; else body.new_episode_title = episodeTitleGuess();
      return api('PATCH', '/patient/documents/' + r.id, body);
    }).then(function (d) {
      clearInterval(t);
      IQ.episodeId = d.episode_id; IQ.picked[d.id] = true; IQ.docs.unshift(d);
      add.insertAdjacentHTML('beforebegin', pickRow(d));
      add.querySelector('.dn').textContent = 'Add another report'; add.querySelector('.dm').textContent = 'Photo or PDF · saved to this problem, then shared here';
      toast(d.name + ' saved and ticked for sharing' + (d.flag_count ? ' · ' + plural(d.flag_count, 'flag') + ' found' : ''));
    }).catch(function (e) { clearInterval(t); add.querySelector('.dn').textContent = 'Add a report not in your documents'; add.querySelector('.dm').textContent = 'Upload failed: ' + e.message; fail(e); });
  };
  function episodeTitleGuess() { var a = (IQ.history[0] && IQ.history[0].a) || 'Health concern'; return a.replace(/\s+/g, ' ').slice(0, 48).replace(/[.,;]?\s*$/, ''); }

  function takeAnswer() {
    var q = currentQ(); if (!q) return null;
    var a = IQ.pendingAnswer || '';
    if (q.kind === 'yesno' && IQ.extra) a = (a || '') + (a ? ' — ' : '') + IQ.extra;
    a = String(a).trim();
    if (!a) return null;
    if (q.kind === 'scale') { var n = parseInt(a, 10); if (!isNaN(n)) { IQ.pain = Math.max(0, Math.min(10, n)); a = String(IQ.pain) + '/10'; } }
    return { q: q.question, a: a, field: q.field, kind: q.kind, section: q.section || 'complaint' };
  }
  function setBusy(b) { IQ.busy = b; $('qs-next').disabled = b; $('qs-back').disabled = b || IQ.phase === 'mode'; if (b) $('qs-next').textContent = 'One moment…'; }
  function qAdvance(resume) {
    /* ask the language module for the next question given everything answered so far */
    setBusy(true); if (!resume) renderQ();
    api('POST', '/intake/' + IQ.id + '/next', { history: IQ.history, mode: IQ.mode, pain: IQ.pain }).then(function (n) {
      setBusy(false);
      if (n.done) { IQ.phase = 'urgent'; loadUrgent(); renderQ(); }
      else { IQ.questions = IQ.history.concat([n]).map(function (x, i) { return i < IQ.history.length ? IQ.questions[i] : x; }); IQ.pendingAnswer = ''; IQ.extra = ''; IQ.autoListen = true; renderQ(); }
    }).catch(function (e) { setBusy(false); renderQ(); fail(e); });
  }
  function loadUrgent() {
    if (IQ.urgentOptions) return;
    api('POST', '/intake/' + IQ.id + '/urgent-options', { history: IQ.history }).then(function (r) { IQ.urgentOptions = r.signs; if (IQ.phase === 'urgent') renderQ(); }).catch(fail);
  }
  function loadPreview() {
    IQ.preview = null;
    var docIds = (IQ.docs || []).filter(function (d) { return IQ.hasReports && IQ.picked[d.id]; }).map(function (d) { return d.id; });
    api('POST', '/intake/' + IQ.id + '/preview', { history: IQ.history, pain: IQ.pain, urgent: urgentLabels(), document_ids: docIds }).then(function (r) { IQ.preview = r; if (IQ.phase === 'summary') renderQ(); }).catch(function (e) { fail(e); IQ.phase = IQ.hasReports ? 'pick' : 'reports'; renderQ(); });
  }
  function urgentLabels() { return Object.keys(IQ.urgent).filter(function (k) { return IQ.urgent[k]; }).map(function (k) { return IQ.urgentOptions[k].label; }); }
  window.qStep = function (d) {
    if (!IQ || IQ.busy) return;
    stopSpeech();
    if (d < 0) {
      if (IQ.phase === 'q') { if (IQ.history.length === 0) { IQ.phase = 'mode'; } else { var last = IQ.history.pop(); IQ.pendingAnswer = last.kind === 'scale' ? String(IQ.pain == null ? '' : IQ.pain) : last.a; IQ.extra = ''; } }
      else if (IQ.phase === 'urgent') { IQ.phase = 'q'; var l2 = IQ.history.pop(); IQ.pendingAnswer = l2 ? (l2.kind === 'scale' ? String(IQ.pain) : l2.a) : ''; }
      else if (IQ.phase === 'reports') IQ.phase = 'urgent';
      else if (IQ.phase === 'pick') IQ.phase = 'reports';
      else if (IQ.phase === 'summary') IQ.phase = IQ.hasReports ? 'pick' : 'reports';
      renderQ(); return;
    }
    if (IQ.phase === 'mode') { if (!IQ.mode) return; IQ.phase = 'q'; IQ.pendingAnswer = ''; if (!currentQ()) qAdvance(); else renderQ(); return; }
    if (IQ.phase === 'q') {
      var ans = takeAnswer(); if (!ans) { toast(currentQ().kind === 'scale' ? 'Pick a number first' : 'Please answer before continuing', 'err'); return; }
      IQ.history.push(ans); IQ.pendingAnswer = ''; IQ.extra = '';
      if (IQ.questions[IQ.history.length]) { renderQ(); return; } /* going forward again after Back */
      qAdvance(); return;
    }
    if (IQ.phase === 'urgent') { IQ.phase = 'reports'; renderQ(); return; }
    if (IQ.phase === 'reports') {
      if (IQ.hasReports === null) return;
      if (IQ.hasReports) { IQ.phase = 'pick'; if (!IQ.docs) api('GET', '/intake/' + IQ.id + '/documents').then(function (r) { IQ.docs = r.documents; r.documents.forEach(function (d) { if (d.episode_id && d.episode_id === IQ.episodeId) IQ.picked[d.id] = true; }); if (IQ.phase === 'pick') renderQ(); }).catch(fail); renderQ(); }
      else { IQ.phase = 'summary'; loadPreview(); renderQ(); }
      return;
    }
    if (IQ.phase === 'pick') { IQ.phase = 'summary'; loadPreview(); renderQ(); return; }
    if (IQ.phase === 'summary') { if (!IQ.preview) return; submitIntake(); }
  };
  function submitIntake() {
    setBusy(true); $('qs-next').textContent = 'Sending…';
    var docIds = (IQ.docs || []).filter(function (d) { return IQ.hasReports && IQ.picked[d.id]; }).map(function (d) { return d.id; });
    api('POST', '/intake/' + IQ.id + '/send', { history: IQ.history, mode: IQ.mode, pain: IQ.pain, urgent: urgentLabels(), has_reports: !!IQ.hasReports, document_ids: docIds, episode_id: IQ.episodeId }).then(function (r) {
      setBusy(false);
      toast('Sent to ' + (r.request.doctor_name || r.request.clinic_name) + '. They can see it now.');
      IQ = null;
      showScreen('patient', 'p-sharing');
      showTab($('ps-tab-req'), 'ps-req');
    }).catch(function (e) { setBusy(false); renderQ(); fail(e); });
  }

  /* ----- speech: question read aloud, answer transcribed ----- */
  var synth = window.speechSynthesis, rec = null, recorder = null;
  function pickVoice() { if (!synth) return null; var vs = synth.getVoices(); return vs.filter(function (v) { return /en-IN/i.test(v.lang); })[0] || vs.filter(function (v) { return /^en/i.test(v.lang); })[0] || null; }
  var speakSeq = 0, speaking = false;
  function speak(text, onEnd) {
    if (!synth) { if (onEnd) onEnd(); return; }
    var my = ++speakSeq;
    synth.cancel();
    var go = function () {
      if (my !== speakSeq) return;                 /* a newer question replaced this one */
      try { synth.resume(); } catch (e) {}        /* Chrome sometimes leaves the engine paused after cancel() */
      var u = new SpeechSynthesisUtterance(text); var v = pickVoice(); if (v) u.voice = v; u.lang = v ? v.lang : 'en-IN'; u.rate = 0.95; u.pitch = 1;
      speaking = true; setSpeakStatus(true);
      u.onend = u.onerror = function () { if (my !== speakSeq) return; speaking = false; setSpeakStatus(false); if (onEnd) onEnd(); };
      synth.speak(u);
    };
    /* voices load asynchronously in Chrome; wait briefly for them the first time */
    if (synth.getVoices().length || !('onvoiceschanged' in synth)) setTimeout(go, 120);
    else { var done = false; var fire = function () { if (done) return; done = true; synth.onvoiceschanged = null; go(); }; synth.onvoiceschanged = fire; setTimeout(fire, 700); }
  }
  function setSpeakStatus(on) {
    var b = $('say-again'); if (b) b.classList.toggle('on', on);
    var st = $('mic-status'); if (st && on) st.textContent = 'Reading the question aloud…';
    else if (st && !on && !IQ.pendingAnswer && !(rec || recorder)) st.textContent = 'Tap the mic, then speak your answer';
  }
  window.sayAgain = function () { var q = currentQ(); if (q) speak(questionSpeech(q)); };
  /* what we read out: the question plus a short cue for scale / yes-no answers */
  function questionSpeech(q) {
    if (q.kind === 'scale') return q.question + ' Say a number from 0 to 10.';
    if (q.kind === 'yesno') return q.question + ' Say yes or no.';
    return q.question;
  }
  /* after the question is read, start listening automatically (only when nothing recorded yet) */
  function afterQuestion() {
    if (!IQ || IQ.phase !== 'q' || IQ.mode !== 'voice' || IQ.pendingAnswer) return;
    if (!hasSTT() && !(navigator.mediaDevices && window.MediaRecorder)) return;
    if ($('mic') && !$('mic').classList.contains('on') && IQ.autoListen !== false) setTimeout(function () { if ($('mic') && !$('mic').classList.contains('on')) micTap(true); }, 250);
  }
  function stopSpeech() { if (synth) synth.cancel(); if (rec) { try { rec.abort(); } catch (e) {} rec = null; } if (recorder && recorder.state !== 'inactive') { try { recorder.stop(); } catch (e) {} } }
  if (synth) synth.onvoiceschanged = function () {};
  function hasSTT() { return !!(window.SpeechRecognition || window.webkitSpeechRecognition); }
  function heard(text) {
    var q = currentQ(); if (!q) return;
    text = String(text || '').trim();
    var st = $('mic-status'), mic = $('mic');
    if (mic) mic.classList.remove('on'); if (st) { st.classList.remove('on'); }
    if (!text) { if (st) st.textContent = 'Did not catch that. Tap the mic and try again.'; IQ.autoListen = false; return; }
    if (q.kind === 'scale') { var m = text.match(/\d+/); var words = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 }; var n = m ? parseInt(m[0], 10) : (words[text.toLowerCase().split(/\s+/)[0]]); if (n != null && !isNaN(n)) { IQ.pendingAnswer = String(Math.max(0, Math.min(10, n))); renderQ(); if ($('mic-status')) $('mic-status').textContent = 'Heard ' + IQ.pendingAnswer + '. Tap Continue.'; return; } }
    if (q.kind === 'yesno') { if (/^(yes|yeah|haan|ha|ho)\b/i.test(text)) IQ.pendingAnswer = 'Yes'; else if (/^(no|nahi|nope|nahin)\b/i.test(text)) IQ.pendingAnswer = 'No'; IQ.extra = text.replace(/^(yes|no|yeah|nope|haan|nahi)[,.\s]*/i, ''); renderQ(); if ($('ans-extra')) $('ans-extra').value = IQ.extra; if ($('mic-status')) $('mic-status').textContent = 'Heard: ' + text; return; }
    IQ.pendingAnswer = text;
    var tr = $('transcript'); if (tr) tr.classList.remove('hidden'); var ta = $('ans'); if (ta) ta.value = text;
    if (st) st.textContent = 'Recorded. Tap the mic to answer again, or edit the text.';
  }
  window.micTap = function (auto) {
    var mic = $('mic'), st = $('mic-status');
    if (!mic) return;
    if (synth && !auto) { speakSeq++; synth.cancel(); speaking = false; }
    if (mic.classList.contains('on')) { if (rec) rec.stop(); else if (recorder) recorder.stop(); return; }
    mic.classList.add('on'); st.textContent = auto ? 'Listening… speak now, or tap the mic to stop' : 'Listening… tap again to stop'; st.classList.add('on');
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SR) {
      rec = new SR(); rec.lang = 'en-IN'; rec.interimResults = true; rec.continuous = true; rec.maxAlternatives = 1;
      var finalText = '', silence;
      rec.onresult = function (e) {
        var interim = '';
        for (var i = e.resultIndex; i < e.results.length; i++) { if (e.results[i].isFinal) finalText += e.results[i][0].transcript + ' '; else interim += e.results[i][0].transcript; }
        var tr = $('transcript'), ta = $('ans'); if (tr && ta) { tr.classList.remove('hidden'); ta.value = (finalText + interim).trim(); }
        clearTimeout(silence); silence = setTimeout(function () { try { rec.stop(); } catch (x) {} }, 2500);
      };
      rec.onerror = function (e) { rec = null; if (e.error === 'not-allowed') { mic.classList.remove('on'); st.classList.remove('on'); st.textContent = 'Microphone blocked. Allow it in the browser, or type instead.'; } else recordFallback(); };
      rec.onend = function () { if (!rec) return; rec = null; heard(finalText || ($('ans') ? $('ans').value : '')); };
      try { rec.start(); } catch (e) { rec = null; recordFallback(); }
    } else recordFallback();
  };
  function recordFallback() {
    var st = $('mic-status'), mic = $('mic');
    if (!navigator.mediaDevices || !window.MediaRecorder) { mic.classList.remove('on'); st.classList.remove('on'); st.textContent = 'No microphone support in this browser. Please type instead.'; return; }
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      var chunks = []; recorder = new MediaRecorder(stream);
      recorder.ondataavailable = function (e) { chunks.push(e.data); };
      recorder.onstop = function () {
        stream.getTracks().forEach(function (t) { t.stop(); });
        st.textContent = 'Transcribing…';
        var fd = new FormData(); fd.append('audio', new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }), 'answer.webm');
        recorder = null;
        api('POST', '/intake/stt', fd).then(function (r) { heard(r.text); }).catch(function (e) { heard(''); fail(e); });
      };
      recorder.start(); st.textContent = 'Recording… tap the mic again to stop';
      setTimeout(function () { if (recorder && recorder.state === 'recording') recorder.stop(); }, 30000);
    }).catch(function () { mic.classList.remove('on'); st.classList.remove('on'); st.textContent = 'Microphone blocked. Allow it in the browser, or type instead.'; });
  }

  /* shared renderer: intake summary (patient view & doctor view) */
  var DASHA_ROWS = [['prakriti', 'Prakriti', 'constitution'], ['vikriti', 'Vikriti', 'current imbalance'], ['sara', 'Sara', 'tissue quality'], ['samhanana', 'Samhanana', 'build'], ['pramana', 'Pramana', 'measure'], ['satmya', 'Satmya', 'habituation'], ['sattva', 'Sattva', 'mind'], ['ahara_shakti', 'Ahara-shakti', 'appetite & digestion'], ['vyayama_shakti', 'Vyayama-shakti', 'exercise capacity'], ['vaya', 'Vaya', 'age']];
  function dashavidhaHtml(d) {
    return '<div style="margin-top:14px"><div class="row" style="justify-content:space-between;margin-bottom:8px"><span class="chip accent plain">Dashavidha Pariksha</span><span class="small faint">Patient-reported · Sara and Vikriti need examination</span></div><dl class="kv">' +
      DASHA_ROWS.map(function (r) { return '<dt>' + r[1] + '<div class="faint" style="font-size:11px">' + r[2] + '</div></dt><dd>' + esc(d[r[0]] || '\u2014') + '</dd>'; }).join('') + '</dl></div>';
  }
  function summaryHtml(i, withAnswers) {
    var s = i.summary || { fields: [], red_flags: [], considerations: [] };
    var h = '<dl class="kv">' + s.fields.map(function (f) { return '<dt>' + esc(f.k) + '</dt><dd>' + esc(f.v) + '</dd>'; }).join('') + (i.urgent && i.urgent.length ? '<dt>Urgent signs</dt><dd>' + esc(i.urgent.join('; ')) + '</dd>' : '') + '</dl>';
    if (s.red_flags.length) h += '<div class="stack" style="gap:8px;margin-top:12px">' + s.red_flags.map(flagHtml).join('') + '</div>';
    if (s.dashavidha) h += dashavidhaHtml(s.dashavidha);
    if (withAnswers && i.answers && i.answers.length) h += '<details style="margin-top:12px"><summary class="small muted" style="cursor:pointer">All ' + i.answers.length + ' questions and answers</summary><dl class="kv" style="margin-top:8px">' + i.answers.map(function (a) { return '<dt>' + esc(a.q) + '</dt><dd>' + esc(a.a) + '</dd>'; }).join('') + '</dl></details>';
    return h;
  }

  /* =====================================================================
     CLINIC PORTAL
     ===================================================================== */
  var CT = null, CDOCS = [], CPAT = null;
  var queueFilter = 'all';
  $('c-queue-seg').addEventListener('click', function (e) { var b = e.target.closest('button'); if (b) { queueFilter = b.dataset.f; renderQueue(); } });
  function flagChip(f) { if (!f.has_intake && !f.docs) return '<span class="chip plain">Not answered yet</span>'; if (f.crit) return '<span class="chip crit">' + plural(f.crit, 'red flag') + '</span>'; if (f.warn) return '<span class="chip warn">' + plural(f.warn, 'flag') + '</span>'; return '<span class="chip ok">No flags</span>'; }
  loaders['c-today'] = function () {
    Promise.all([api('GET', '/clinic/today'), api('GET', '/clinic/doctors')]).then(function (rs) {
      if (unchanged('c-today', rs)) return;
      CT = rs[0]; CDOCS = rs[1];
      var k = CT.kpi;
      $('ck-wait').textContent = k.waiting; $('ck-wait-d').textContent = k.waiting_flagged ? k.waiting_flagged + ' with red flags in intake' : 'none with red flags';
      $('ck-with').textContent = k.with_doctor; $('ck-with-d').textContent = 'across ' + plural(k.on_duty, 'doctor') + ' on duty';
      $('ck-seen').textContent = k.seen; $('ck-seen-d').textContent = k.seen ? 'avg wait ' + k.avg_wait + ' min' : 'no one seen yet';
      $('ck-duty').innerHTML = k.on_duty + '<span class="faint" style="font-size:16px">/' + k.doctors + '</span>'; $('ck-duty-d').textContent = CDOCS.filter(function (d) { return d.paused; }).map(function (d) { return d.name + ' paused'; }).join(', ') || 'all accepting patients';
      $('c-cnt-today').textContent = CT.queue.filter(function (x) { return x.status !== 'seen'; }).length;
      $('c-cnt-req').textContent = CT.pending_shares; $('c-cnt-doc').textContent = CDOCS.length;
      $('c-review-btn').textContent = CT.pending_shares ? 'Review ' + plural(CT.pending_shares, 'new share') : 'Share requests';
      renderQueue();
    }).catch(fail);
  };
  function renderQueue() {
    if (!CT) return;
    var rows = CT.queue.filter(function (x) { return queueFilter === 'all' || x.status === queueFilter; });
    $('c-queue-empty').classList.toggle('hidden', !!rows.length);
    $('c-queue-body').innerHTML = rows.map(function (x) {
      var shared = x.share ? esc(x.episode_title || 'Episode') + '<div class="ps">' + (x.flags.has_intake ? 'Intake' : 'No intake') + (x.flags.docs ? ' + ' + plural(x.flags.docs, 'report') : '') + '</div>' : '<span class="muted">' + (x.request_status === 'pending' ? 'Request sent · waiting for patient' : x.request_status === 'declined' ? 'Patient declined' : 'Nothing shared') + '</span>';
      var status = x.status === 'waiting' ? '<span class="chip warn">Waiting ' + ago(x.wait_min) + '</span>' : x.status === 'with_doctor' ? '<span class="chip info">With doctor</span>' : '<span class="chip ok">Seen · ' + fmtTime(x.seen_at) + '</span>';
      var act = x.status === 'seen' ? '' : (!x.doctor ? '<button class="btn btn-sm btn-primary" onclick="openAssign(' + x.id + ')">Assign doctor</button>' : '<button class="btn btn-sm btn-ghost" onclick="openShared(' + x.id + ')">View shared</button> <button class="btn btn-sm btn-ghost" onclick="openAssign(' + x.id + ')">Reassign</button>');
      return '<tr><td><div class="pn">' + esc(x.patient.name) + '</div><div class="ps">' + esc((x.patient.age || '—') + ' ' + (x.patient.sex || '')) + ' · <span class="mono">' + esc(x.patient.nid) + '</span></div></td><td class="mono">' + fmtTime(x.arrived_at) + '</td><td>' + shared + '</td><td>' + flagChip(x.flags) + '</td><td>' + (x.doctor ? esc(x.doctor.name) + '<div class="ps">' + esc(x.doctor.specialty) + '</div>' : '<span class="muted">—</span>') + '</td><td>' + status + '</td><td>' + act + '</td></tr>';
    }).join('');
  }
  /* patient arrived */
  var AR = { patient: null, timer: null };
  window.openArrive = function () { AR.patient = null; $('ar-search').value = ''; $('ar-note').value = ''; $('ar-results').innerHTML = '<div class="small faint">Type at least 3 characters.</div>'; $('ar-add').disabled = true; $('ar-assign').disabled = true; openModal('m-arrive'); };
  window.arriveSearch = function (v) {
    clearTimeout(AR.timer); AR.patient = null; $('ar-add').disabled = true; $('ar-assign').disabled = true;
    if (v.trim().length < 3) { $('ar-results').innerHTML = '<div class="small faint">Type at least 3 characters.</div>'; return; }
    AR.timer = setTimeout(function () {
      api('GET', '/clinic/patients/search?q=' + encodeURIComponent(v.trim())).then(function (rows) {
        AR.rows = rows;
        $('ar-results').innerHTML = rows.length ? rows.map(function (p, i) { return '<label class="doctor-pick"><input type="radio" name="arrive" onchange="arrivePick(' + i + ')"><div><div class="dn">' + esc(p.name) + ' <span class="muted" style="font-weight:400">' + esc((p.age || '') + ' ' + (p.sex || '')) + '</span></div><div class="ds">' + esc(p.phone || '') + ' · <span class="mono">' + esc(p.nid) + '</span>' + (p.active_share ? ' · shared ' + esc(p.active_share.episode || 'an episode') : '') + '</div></div><div class="dl">' + (p.active_share ? '<span class="chip ok">Active share</span>' : p.pending_request ? '<span class="chip warn">Request pending</span>' : '<span class="chip warn">No active share</span>') + '</div></label>'; }).join('') : '<div class="small muted">No patient found. They need a Nidaan account.</div>';
      }).catch(fail);
    }, 250);
  };
  window.arrivePick = function (i) { AR.patient = AR.rows[i]; $('ar-add').disabled = false; $('ar-assign').disabled = false; };
  window.arriveAdd = function (assign) {
    if (!AR.patient) return;
    if (assign) { closeModal(); openAssign(null, AR.patient, $('ar-note').value); return; }
    api('POST', '/clinic/arrive', { patient_id: AR.patient.id, note: $('ar-note').value, share_id: AR.patient.active_share ? AR.patient.active_share.id : null }).then(function () { closeModal(); toast(AR.patient.name + ' added to today’s queue · intake request sent'); loaders['c-today'](); }).catch(fail);
  };
  /* assign */
  var AS = { queueId: null, patient: null };
  window.openAssign = function (queueId, patient, note) {
    AS = { queueId: queueId, patient: patient, note: note || '' };
    var row = queueId ? CT.queue.filter(function (x) { return x.id === queueId; })[0] : null;
    var name = row ? row.patient.name : patient.name;
    $('as-name').textContent = name; $('as-cc').textContent = row ? (row.episode_title || 'No intake yet') + (row.flags.total ? ' · ' + plural(row.flags.total, 'flag') : '') : (patient.active_share ? 'Shared ' + (patient.active_share.episode || 'an episode') : 'No records shared yet');
    $('as-note').value = AS.note || (row && row.note) || '';
    var ready = function () {
      $('as-list').innerHTML = CDOCS.map(function (d, i) { return '<label class="doctor-pick"' + (d.paused ? ' style="opacity:.6"' : '') + '><input type="radio" name="asdoc" value="' + d.id + '"' + (i === 0 ? ' checked' : '') + '><div><div class="dn">' + esc(d.name) + '</div><div class="ds">' + esc(d.specialty) + ' · ' + esc(d.hours_from + '–' + d.hours_to) + (d.paused ? ' · paused' : '') + '</div></div><div class="dl">Waiting<b>' + d.waiting + '</b></div></label>'; }).join('');
      openModal('m-assign');
    };
    if (CDOCS.length) ready(); else api('GET', '/clinic/doctors').then(function (d) { CDOCS = d; ready(); }).catch(fail);
  };
  window.doAssign = function () {
    var picked = document.querySelector('#as-list input:checked'); if (!picked) return;
    var docId = Number(picked.value), note = $('as-note').value;
    var docName = CDOCS.filter(function (d) { return d.id === docId; })[0].name;
    var p = AS.queueId ? api('POST', '/clinic/queue/' + AS.queueId + '/assign', { doctor_id: docId, note: note }) : api('POST', '/clinic/arrive', { patient_id: AS.patient.id, doctor_id: docId, note: note, share_id: AS.patient.active_share ? AS.patient.active_share.id : null });
    p.then(function () { closeModal(); toast($('as-name').textContent + ' assigned to ' + docName + ' · intake request sent to patient'); loaders['c-today'](); if ($('c-patients').classList.contains('active')) loaders['c-patients'](); }).catch(fail);
  };
  window.openShared = function (queueId) {
    api('GET', '/clinic/queue/' + queueId + '/summary').then(function (s) {
      $('msh-body').innerHTML = '<dl class="kv"><dt>Patient</dt><dd>' + esc(s.patient.name) + ' · ' + esc((s.patient.age || '') + ' ' + (s.patient.sex || '')) + ' · <span class="mono">' + esc(s.patient.nid) + '</span></dd><dt>Episode</dt><dd>' + esc(s.episode_title || '—') + '</dd><dt>Intake</dt><dd>' + (s.intake ? flagChip(s.flags) + ' · completed ' + fmtWhen(s.intake.sent_at).toLowerCase() + ' · ' + plural(s.intake.answers, 'answer') + ' by ' + (s.intake.mode === 'voice' ? 'speaking' : 'typing') : 'Not answered yet') + '</dd><dt>Documents</dt><dd>' + (s.docs.length ? s.docs.map(function (d) { return esc(d.name) + (d.date ? ' (' + fmtDate(d.date) + ')' : ''); }).join(' · ') : 'None') + '</dd><dt>Also included</dt><dd>' + (s.include_profile ? 'Profile basics: blood group, allergies, medicines, emergency contact' : '—') + '</dd><dt>Access ends</dt><dd>' + (s.expires_at ? fmtDate(s.expires_at) : (s.share ? (s.share.duration === 'revoke' ? 'When the patient revokes' : 'When this visit closes') : '—')) + '</dd></dl><div class="notice plain" style="margin-top:14px"><svg class="ic"><use href="#i-lock"/></svg><span>Document contents and questionnaire answers are hidden from front-desk staff by design.</span></div>';
      $('msh-assign').onclick = function () { closeModal(); openAssign(queueId); };
      openModal('m-shared');
    }).catch(fail);
  };
  loaders['c-requests'] = function () {
    api('GET', '/clinic/requests').then(function (r) {
      if (unchanged('c-requests', r)) return;
      $('c-cnt-req').textContent = r.incoming.length;
      $('c-req-list').innerHTML = r.incoming.length ? r.incoming.map(function (s) { return '<div class="card perm"><div class="avatar" style="background:var(--patient)">' + esc(s.patient.ini) + '</div><div class="pc"><div class="pn">' + esc(s.patient.name) + ' ' + (s.flags.total ? flagChip(s.flags) : '') + '</div><div class="pm">Shared <b>' + esc(s.episode_title || 'an episode') + '</b> · ' + fmtWhen(s.created_at).toLowerCase() + ' · ' + (s.expires_at ? 'expires ' + fmtDate(s.expires_at) : s.duration === 'revoke' ? 'until revoked' : 'this visit only') + '</div><div class="pi">' + s.items.map(function (t) { return '<span class="tag">' + esc(t) + '</span>'; }).join('') + '</div></div><div class="actions"><button class="btn btn-sm btn-primary" onclick="acceptShare(' + s.id + ',\'' + esc(s.patient.name).replace(/'/g, '') + '\')">Accept &amp; add to queue</button></div></div>'; }).join('') : '<div class="empty"><svg class="ic"><use href="#i-inbox"/></svg><h4>No new shares</h4><p class="small">When a patient shares an episode with this clinic from their app, it appears here.</p></div>';
      $('c-sent-list').innerHTML = r.sent.length ? r.sent.map(function (q) { return '<div class="card perm" style="opacity:.9"><div class="avatar" style="background:var(--ink-3)">' + esc(initials(q.patient_name)) + '</div><div class="pc"><div class="pn">' + esc(q.patient_name) + ' <span class="chip warn" style="margin-left:6px">Waiting for patient</span></div><div class="pm">Intake request sent ' + fmtWhen(q.created_at).toLowerCase() + (q.doctor_name ? ' · for ' + esc(q.doctor_name) : '') + '</div></div></div>'; }).join('') : '<div class="small muted">None pending.</div>';
    }).catch(fail);
  };
  window.acceptShare = function (id, name) { api('POST', '/clinic/shares/' + id + '/accept').then(function () { toast(name + ' added to today’s queue'); loaders['c-requests'](); }).catch(fail); };
  loaders['c-patients'] = function () { api('GET', '/clinic/patients').then(function (r) { CPAT = r; renderClinicPatients(); }).catch(fail); };
  window.renderClinicPatients = function () {
    if (!CPAT) return;
    var qv = ($('c-pat-search').value || '').toLowerCase();
    var rows = CPAT.patients.filter(function (p) { return !qv || (p.patient.name + ' ' + p.patient.nid).toLowerCase().indexOf(qv) > -1; });
    $('c-pat-sub').textContent = 'Only patients with an active share to this clinic. ' + CPAT.patients.length + ' active · ' + CPAT.expired + ' ended.';
    $('c-pat-foot').textContent = 'Showing ' + rows.length + ' of ' + CPAT.patients.length;
    var rr = function (p) { return p.pending_request ? '<span class="chip warn">Request pending</span>' : '<button class="btn btn-sm btn-ghost" onclick="openRerequest(' + p.patient.id + ')">Request again</button>'; };
    $('c-pat-body').innerHTML = rows.length ? rows.map(function (p) { return '<tr><td><div class="pn">' + esc(p.patient.name) + '</div><div class="ps">' + esc((p.patient.age || '') + ' ' + (p.patient.sex || '')) + ' · <span class="mono">' + esc(p.patient.nid) + '</span>' + (p.patient.phone ? ' · ' + esc(p.patient.phone) : '') + '</div></td><td>' + esc(p.episode_title || '—') + '</td><td>' + (p.has_intake ? '<span class="tag">Intake</span> ' : '') + (p.doc_count ? '<span class="tag">' + plural(p.doc_count, 'report') + '</span> ' : '') + (p.include_profile ? '<span class="tag">Profile</span>' : '') + '</td><td>' + (p.expires_at ? '<span class="mono">' + fmtDate(p.expires_at) + '</span>' : p.duration === 'revoke' ? '<span class="chip ok plain">Until revoked</span>' : '<span class="mono">This visit</span>') + '</td><td>' + (p.doctor_name ? esc(p.doctor_name) : '<span class="muted">Not yet</span>') + '</td><td><div class="row" style="justify-content:flex-end;flex-wrap:nowrap">' + (p.queue && p.queue.status !== 'seen' ? '<button class="btn btn-sm" onclick="showScreen(\'clinic\',\'c-today\')">In queue</button>' : '<button class="btn btn-sm btn-primary" onclick="acceptShare(' + p.share_id + ',\'' + esc(p.patient.name).replace(/'/g, '') + '\')">Add to queue</button>') + rr(p) + '</div></td></tr>'; }).join('') : '<tr><td colspan="6" class="muted">No patients with an active share.</td></tr>';
    var ended = (CPAT.ended || []).filter(function (p) { return !qv || (p.patient.name + ' ' + p.patient.nid).toLowerCase().indexOf(qv) > -1; });
    $('c-pat-ended').innerHTML = ended.length ? ended.map(function (p) { return '<tr><td><div class="pn">' + esc(p.patient.name) + '</div><div class="ps">' + esc((p.patient.age || '') + ' ' + (p.patient.sex || '')) + ' · <span class="mono">' + esc(p.patient.nid) + '</span></div></td><td>' + esc(p.last_episode || '—') + '<div class="ps">' + plural(p.shares, 'past share') + '</div></td><td>' + esc(p.last_doctor || '—') + '</td><td><span class="chip plain">' + esc(p.last_status || 'ended') + ' · ' + fmtDate(p.ended_at) + '</span></td><td style="text-align:right">' + rr(p) + '</td></tr>'; }).join('') : '<tr><td colspan="5" class="muted">No previously shared patients.</td></tr>';
  };
  /* request again: fresh intake request to a patient the clinic has seen before (or is seeing now) */
  var RR = { patientId: null };
  window.openRerequest = function (patientId) {
    var p = (CPAT.patients.concat(CPAT.ended || [])).filter(function (x) { return x.patient.id === patientId; })[0]; if (!p) return;
    RR.patientId = patientId;
    $('rr-name').textContent = p.patient.name; $('rr-sub').textContent = p.episode_title ? 'Active share: ' + p.episode_title : (p.last_episode ? 'Last shared: ' + p.last_episode : 'No share yet');
    $('rr-reason').value = '';
    var ready = function () {
      $('rr-list').innerHTML = '<label class="doctor-pick"><input type="radio" name="rrdoc" value="" checked><div><div class="dn">Front desk decides later</div><div class="ds">Assign a doctor when the patient arrives</div></div></label>' +
        CDOCS.map(function (d) { return '<label class="doctor-pick"><input type="radio" name="rrdoc" value="' + d.id + '"' + ((p.doctor_name || p.last_doctor) === d.name ? ' checked' : '') + '><div><div class="dn">' + esc(d.name) + '</div><div class="ds">' + esc(d.specialty) + ' · ' + esc(d.hours_from + '–' + d.hours_to) + '</div></div></label>'; }).join('');
      openModal('m-rerequest');
    };
    if (CDOCS.length) ready(); else api('GET', '/clinic/doctors').then(function (d) { CDOCS = d; ready(); }).catch(fail);
  };
  window.sendRerequest = function () {
    var reason = $('rr-reason').value.trim(); if (!reason) return toast('Give the patient a reason for the request', 'err');
    var doc = document.querySelector('#rr-list input:checked');
    api('POST', '/clinic/patients/' + RR.patientId + '/request', { doctor_id: doc && doc.value ? Number(doc.value) : null, note: reason }).then(function (r) { closeModal(); toast('Request sent to ' + $('rr-name').textContent + (r.doctor ? ' for ' + r.doctor.name : '')); loaders['c-patients'](); }).catch(fail);
  };
  loaders['c-doctors'] = function () {
    api('GET', '/clinic/doctors').then(function (docs) {
      CDOCS = docs; $('c-cnt-doc').textContent = docs.length;
      $('c-doc-body').innerHTML = docs.map(function (d) { return '<tr><td><div class="pn">' + esc(d.name) + '</div><div class="ps">' + esc(d.email || '') + '</div></td><td>' + esc(d.specialty) + '</td><td class="mono">' + esc(d.reg_no || '—') + '</td><td class="mono">' + esc(d.hours_from + '–' + d.hours_to) + '</td><td><span class="num">' + d.with_doctor + '</span> <span class="faint small">with · ' + d.waiting + ' waiting</span></td><td>' + (d.paused ? '<span class="chip warn">Paused</span>' : '<span class="chip ok">On duty</span>') + '</td><td><button class="btn btn-sm btn-ghost" onclick="editDoctor(' + d.id + ')">Edit</button></td></tr>'; }).join('');
    }).catch(fail);
  };
  window.addDoctor = function () {
    var body = { name: $('ad-name').value.trim(), specialty: $('ad-spec').value, reg_no: $('ad-reg').value.trim(), email: $('ad-email').value.trim(), password: $('ad-pass').value, hours_from: $('ad-from').value, hours_to: $('ad-to').value };
    if (!body.name || !body.email) return toast('Name and email are required', 'err');
    api('POST', '/clinic/doctors', body).then(function (d) { closeModal(); toast(d.name + ' can now sign in with ' + d.email + ' / ' + d.password); $('ad-name').value = ''; $('ad-email').value = ''; $('ad-reg').value = ''; loaders['c-doctors'](); }).catch(fail);
  };
  window.editDoctor = function (id) {
    var d = CDOCS.filter(function (x) { return x.id === id; })[0]; if (!d) return;
    var spec = prompt('Specialty for ' + d.name, d.specialty); if (spec === null) return;
    var hours = prompt('Hours (from-to)', d.hours_from + '-' + d.hours_to); if (hours === null) return;
    var hh = hours.split(/[-–]/);
    api('PATCH', '/clinic/doctors/' + id, { specialty: spec.trim(), hours_from: (hh[0] || '').trim(), hours_to: (hh[1] || '').trim() }).then(function () { toast('Doctor updated'); loaders['c-doctors'](); }).catch(fail);
  };
  window.loadClinicProfile = loaders['c-onboard'] = function () {
    api('GET', '/clinic/profile').then(function (c) { $('cname').value = c.name || ''; $('creg').value = c.reg_no || ''; $('ctype').value = c.type || 'Multispeciality clinic'; $('caddr').value = c.address || ''; $('cphone').value = c.phone || ''; $('cmail').value = c.email || ''; $('cspec').value = (c.specialties || []).join(', '); }).catch(fail);
  };
  window.saveClinicProfile = function () {
    api('PUT', '/clinic/profile', { name: $('cname').value, reg_no: $('creg').value, type: $('ctype').value, address: $('caddr').value, phone: $('cphone').value, email: $('cmail').value, specialties: $('cspec').value.split(',').map(function (s) { return s.trim(); }).filter(Boolean) }).then(function (c) { toast('Clinic details saved.'); USER.clinic_name = c.name; applyUser(USER); }).catch(fail);
  };

  /* =====================================================================
     DOCTOR PORTAL
     ===================================================================== */
  var DQ = null, DP = null, DH = null;
  loaders['d-queue'] = function () {
    api('GET', '/doctor/queue').then(function (r) {
      if (unchanged('d-queue', r)) return;
      DQ = r;
      $('d-cnt').textContent = r.queue.filter(function (x) { return x.status !== 'seen'; }).length;
      $('dk-seen').textContent = r.kpi.seen + ' of ' + r.kpi.total + ' assigned'; $('dk-wait').textContent = r.kpi.waiting + (r.kpi.waiting ? ' · longest ' + ago(r.kpi.longest) : ''); $('dk-flags').textContent = r.kpi.flagged ? plural(r.kpi.flagged, 'patient') : 'None';
      $('d-pause').textContent = r.paused ? 'Resume assignments' : 'Pause new assignments'; $('d-duty-chip').className = 'chip ' + (r.paused ? 'warn' : 'ok'); $('d-duty-chip').textContent = r.paused ? 'Paused' : 'On duty';
      $('d-list').innerHTML = r.queue.length ? r.queue.map(function (x) {
        if (x.status === 'seen') return '<div class="card" style="opacity:.75"><div class="perm"><div class="avatar" style="background:var(--ink-3)">' + esc(x.patient.ini) + '</div><div class="pc"><div class="pn">' + esc(x.patient.name) + ' <span class="chip ok" style="margin-left:6px">Seen ' + fmtTime(x.seen_at) + '</span></div><div class="pm">' + esc(x.complaint || 'No intake') + ' · ' + esc(x.meta) + '</div></div><button class="btn btn-sm btn-ghost" onclick="openPatient(' + x.id + ')">View</button></div></div>';
        var flags = x.flags.length ? x.flags.map(function (f) { return '<span class="chip ' + (f.level === 'crit' ? 'crit' : 'warn') + '">' + esc(f.title) + '</span>'; }).join('') : (x.has_share ? '<span class="chip ok">No flags</span>' : '<span class="chip plain">Waiting for the patient’s intake</span>');
        return '<div class="card pat-card' + (x.flag_counts.crit ? ' urgent' : '') + '" onclick="openPatient(' + x.id + ')"><div class="avatar" style="background:var(--patient)">' + esc(x.patient.ini) + '</div><div class="body"><div class="row" style="justify-content:space-between"><span><b>' + esc(x.patient.name) + '</b> <span class="muted">' + esc((x.patient.age || '') + ' ' + (x.patient.sex || '')) + '</span> <span class="mono faint">' + esc(x.patient.nid) + '</span></span>' + (x.status === 'with_doctor' ? '<span class="chip info">In consultation</span>' : '<span class="chip warn">Waiting ' + ago(x.wait_min) + '</span>') + '</div><div class="cc">' + esc(x.complaint || (x.has_share ? 'Shared records, no intake' : 'Intake not answered yet')) + '</div><div class="meta">' + esc(x.meta) + (x.note ? ' · Front desk: ' + esc(x.note) : '') + '</div><div class="flags">' + flags + '</div></div><button class="btn ' + (x.flag_counts.crit ? 'btn-primary ' : '') + 'btn-sm" onclick="event.stopPropagation();openPatient(' + x.id + ')">Open</button></div>';
      }).join('') : '<div class="empty"><svg class="ic"><use href="#i-users"/></svg><h4>No patients assigned yet today</h4><p class="small">The front desk assigns patients to you. They appear here the moment that happens.</p></div>';
    }).catch(fail);
  };
  window.togglePause = function () { api('POST', '/doctor/pause', { paused: !(DQ && DQ.paused) }).then(function () { loaders['d-queue'](); }).catch(fail); };
  window.openPatient = function (queueId) { showScreen('doctor', 'd-patient', null, queueId); };
  loaders['d-patient'] = function (queueId) {
    if (queueId) DP = { id: queueId }; if (!DP) return showScreen('doctor', 'd-queue');
    api('GET', '/doctor/queue/' + DP.id).then(function (r) {
      DP.data = r; var p = r.patient, qe = r.queue, s = r.share, i = r.intake;
      $('dp-crumb').textContent = p.name; $('dp-name').innerHTML = esc(p.name) + ' <span class="muted" style="font-weight:400">' + esc((p.age || '') + ' ' + (p.sex || '')) + '</span>';
      $('dp-sub').innerHTML = '<span class="mono">' + esc(p.nid) + '</span>' + (p.city ? ' · ' + esc(p.city) : '') + (qe.arrived_at ? ' · Arrived ' + fmtTime(qe.arrived_at) : '') + (s && s.assigned_at ? ' · Assigned to you at ' + fmtTime(s.assigned_at) + ' by front desk' : '') + (qe.note ? ' · Note: ' + esc(qe.note) : '');
      $('dp-chips').innerHTML = s && s.status === 'active' ? '<span class="chip accent"><svg class="ic" style="width:12px;height:12px"><use href="#i-lock"/></svg>Shared by patient · ' + esc(s.episode_title || 'Episode') + '</span><span class="chip plain">' + (s.expires_at ? 'Access until ' + fmtDate(s.expires_at) : s.duration === 'revoke' ? 'Access until revoked' : 'Access until this visit closes') + '</span><span class="chip plain">Patient can revoke anytime</span>' : '<span class="chip warn">' + (s ? 'Share ' + esc(s.status) : 'Nothing shared yet · intake request pending') + '</span>';
      $('dp-start').style.display = qe.status === 'waiting' ? '' : 'none'; $('dp-seen').style.display = qe.status === 'seen' ? 'none' : '';
      var allFlags = (i && i.summary ? i.summary.red_flags : []).concat(r.documents.reduce(function (a, d) { return a.concat(d.flags.map(function (f) { return Object.assign({}, f, { detail: (f.detail || '') + ' (' + d.name + ')' }); })); }, []));
      var crit = allFlags.filter(function (f) { return f.level === 'crit'; });
      $('dp-flagbar').innerHTML = crit.length ? '<div class="flag" style="margin-bottom:18px"><svg class="ic" style="width:20px;height:20px;color:var(--crit);flex:none"><use href="#i-alert"/></svg><div><div class="ft">' + plural(crit.length, 'red flag') + (i ? ' from intake · reported ' + fmtWhen(i.sent_at).toLowerCase() : '') + '</div><div class="fs">' + esc(crit.map(function (f) { return f.title; }).join('; ')) + '. Consider seeing this patient before others in the queue.</div></div></div>' : '';
      /* intake column */
      var col = '';
      if (i && i.summary) {
        col += '<div class="card"><div class="ch"><div><h3>Current intake</h3><div class="small muted">Sent ' + fmtWhen(i.sent_at).toLowerCase() + ' · answered by ' + (i.mode === 'voice' ? 'speaking' : 'typing') + ' · ' + plural(i.answers.length, 'answer') + '</div></div><span class="chip accent">Latest</span>' + (r.previous_intakes.length ? '<button class="btn btn-sm btn-ghost" onclick="openPrev()"><svg class="ic"><use href="#i-cal"/></svg>Previous intake summaries<span class="cnt" style="margin-left:6px;font-family:var(--mono);font-size:11px;background:var(--surface-2);padding:0 6px;border-radius:999px">' + r.previous_intakes.length + '</span></button>' : '') + '</div><div class="cb">' + summaryHtml(Object.assign({}, i, { summary: Object.assign({}, i.summary, { red_flags: [] }) }), true) + '</div></div>';
        col += '<div class="card"><div class="ch"><h3>Red flags</h3>' + (crit.length ? '<span class="chip crit">' + crit.length + ' critical</span>' : '') + (allFlags.length - crit.length ? '<span class="chip warn">' + (allFlags.length - crit.length) + ' caution</span>' : '') + '</div><div class="cb stack" style="gap:8px">' + (allFlags.length ? allFlags.map(flagHtml).join('') : '<div class="small muted">No red flags in the intake answers or the shared reports.</div>') + '</div></div>';
      } else col += '<div class="card"><div class="cb"><div class="empty"><svg class="ic"><use href="#i-inbox"/></svg><h4>' + (s && s.status === 'active' ? 'Records shared, no intake' : 'Intake not answered yet') + '</h4><p class="small">' + (s && s.status === 'active' ? 'The patient shared documents without answering questions.' : 'The front desk sent the patient an intake request. This page fills in the moment they send it.') + '</p></div></div></div>';
      $('dp-intake-col').innerHTML = col;
      var cons = i && i.summary ? i.summary.considerations : [];
      $('dp-cond').innerHTML = (cons.length ? cons.map(function (c) { return '<div class="cond"><div><div class="cn">' + esc(c.name) + (c.specialty ? ' <span class="chip plain" style="margin-left:4px">' + esc(c.specialty) + '</span>' : '') + '</div><div class="cs">' + esc(c.why) + '</div></div>' + (c.features ? '<div class="cl">' + plural(c.features, 'feature') + '</div>' : '') + '</div>'; }).join('') : '<div class="small muted">Available after the patient sends the intake.</div>') +
        '<div class="disclaim" style="margin-top:12px"><b>Not a diagnosis.</b> Possible areas only, matched from the patient’s answers and shared reports to help you orient. Order is by how many reported features match. The clinical judgement stays with you.</div>';
      var v = qe.vitals || {};
      $('dp-vitals').innerHTML = '<div><div class="l">BP</div><div class="v">' + esc(v.bp || '—') + '</div></div><div><div class="l">Pulse</div><div class="v">' + esc(v.pulse || '—') + '</div></div><div><div class="l">SpO₂</div><div class="v">' + esc(v.spo2 || '—') + '</div></div><div><div class="l">Temp</div><div class="v">' + esc(v.temp || '—') + '</div></div>';
      /* reports */
      $('dp-rep-cnt').textContent = r.documents.length;
      $('dp-reports').innerHTML = (r.documents.length ? '<div class="notice info"><svg class="ic"><use href="#i-info"/></svg><span>Only the ' + plural(r.documents.length, 'document') + ' the patient chose to share for this episode ' + (r.documents.length === 1 ? 'is' : 'are') + ' shown. Values and flags were read by OCR; open the original to verify.</span></div>' + r.documents.map(function (d) { return '<div class="card"><div class="cb">' + docRowHtml(d, 'doctor') + (d.extracted ? '<div style="margin-top:10px">' + extractHtml(Object.assign({}, d.extracted, { summary: '' })) + '</div>' : '') + '</div></div>'; }).join('') : '<div class="empty"><svg class="ic"><use href="#i-folder"/></svg><h4>No reports shared</h4><p class="small">Use “Request more records” to ask the patient.</p></div>');
      /* meds & history */
      $('dp-meds').innerHTML = r.profile ? '<dl class="kv"><dt>Blood group</dt><dd>' + esc(r.profile.blood_group || '—') + '</dd><dt>Allergies</dt><dd>' + (r.profile.allergies ? '<span class="chip crit">' + esc(r.profile.allergies) + '</span>' : 'None recorded') + '</dd><dt>Conditions</dt><dd>' + esc(r.profile.conditions || 'None recorded') + '</dd><dt>Regular medicines</dt><dd>' + esc(r.profile.medicines || 'None recorded') + '</dd><dt>Emergency contact</dt><dd>' + esc(r.profile.emergency_contact || '—') + '</dd></dl>' : '<div class="small muted">Profile basics were not included in this share.</div>';
      $('dp-hist').innerHTML = r.episode_history && r.episode_history.length ? '<ul class="tl">' + r.episode_history.map(function (e) { return '<li class="' + (e.shared ? 'now' : 'done') + '"><div class="tt">' + (e.shared ? esc(e.title) : 'Another problem') + '</div><div class="ts">' + (e.shared ? plural(e.intakes, 'intake') + ' · shared with you' : 'Not shared with this clinic') + '</div><div class="tm">' + fmtDate(e.started_at) + (e.status === 'open' ? ' – ongoing' : '') + '</div></li>'; }).join('') + '</ul>' : '<div class="small muted">Nothing shared.</div>';
      /* notes */
      $('dnote').value = r.note ? r.note.text : ''; $('dnote-status').textContent = r.note ? 'Saved ' + fmtWhen(r.note.updated_at).toLowerCase() : 'Autosaves 3 s after you stop typing';
    }).catch(function (e) { fail(e); showScreen('doctor', 'd-queue'); });
  };
  window.openPrev = function () {
    var r = DP.data;
    $('mprev-sub').innerHTML = esc(r.patient.name) + ' · <b>' + esc(r.share.episode_title) + '</b> episode only. Intakes from other problems are not part of this share.';
    $('mprev-body').innerHTML = '<div class="notice plain"><svg class="ic"><use href="#i-info"/></svg><span>Read-only. The current intake on the main screen is what the patient sent for today. These are earlier answers attached to the same episode.</span></div>' + r.previous_intakes.map(function (i, idx) { return '<details class="card"' + (idx === 0 ? ' open' : '') + '><summary class="ch" style="cursor:pointer;list-style:none"><div style="flex:1"><h3 style="display:inline">' + fmtWhen(i.sent_at) + '</h3><div class="small muted">Answered by ' + (i.mode === 'voice' ? 'speaking' : 'typing') + ' · ' + plural(i.answers.length, 'answer') + (i.doctor_name ? ' · sent to ' + esc(i.doctor_name) : '') + '</div></div>' + (i.summary && i.summary.red_flags.length ? '<span class="chip warn">' + plural(i.summary.red_flags.length, 'flag') + '</span>' : '<span class="chip plain">No flags</span>') + '</summary><div class="cb">' + summaryHtml(i, true) + '</div></details>'; }).join('');
    openModal('m-prev-intake');
  };
  window.startConsult = function () { api('POST', '/doctor/queue/' + DP.id + '/start').then(function () { toast('Consultation started ' + fmtTime(new Date().toISOString())); loaders['d-patient'](); }).catch(fail); };
  window.markSeen = function () { if (!confirm('Mark this patient as seen? A "this visit only" share ends now.')) return; saveNote(false).then(function () { return api('POST', '/doctor/queue/' + DP.id + '/seen'); }).then(function () { toast('Marked as seen'); showScreen('doctor', 'd-queue'); }).catch(fail); };
  var noteTimer;
  window.noteChanged = function () { clearTimeout(noteTimer); $('dnote-status').textContent = 'Unsaved changes…'; noteTimer = setTimeout(function () { saveNote(false); }, 3000); };
  window.saveNote = function (loud) { clearTimeout(noteTimer); return api('PUT', '/doctor/queue/' + DP.id + '/notes', { text: $('dnote').value }).then(function () { $('dnote-status').textContent = 'Saved ' + fmtTime(new Date().toISOString()); if (loud) toast('Notes saved'); }).catch(fail); };
  window.uploadRx = function (input) {
    var f = input.files[0]; if (!f) return;
    var fd = new FormData(); fd.append('file', f); fd.append('name', 'Prescription — ' + USER.name);
    toast('Uploading prescription…');
    api('POST', '/doctor/queue/' + DP.id + '/prescription', fd).then(function () { toast('Prescription sent to the patient’s record'); input.value = ''; loaders['d-patient'](); }).catch(fail);
  };
  window.openVitals = function () { var v = (DP.data.queue.vitals) || {}; $('vt-bp').value = v.bp || ''; $('vt-pulse').value = v.pulse || ''; $('vt-spo2').value = v.spo2 || ''; $('vt-temp').value = v.temp || ''; openModal('m-vitals'); };
  window.saveVitals = function () { api('POST', '/doctor/queue/' + DP.id + '/vitals', { bp: $('vt-bp').value, pulse: $('vt-pulse').value, spo2: $('vt-spo2').value, temp: $('vt-temp').value }).then(function () { closeModal(); toast('Vitals saved'); loaders['d-patient'](); }).catch(fail); };
  loaders['d-history'] = function () { api('GET', '/doctor/history').then(function (rows) { DH = rows; renderHistory(); }).catch(fail); };
  window.renderHistory = function () {
    if (!DH) return;
    var qv = ($('d-hist-search').value || '').toLowerCase();
    var rows = DH.filter(function (r) { return !qv || (r.patient.name + ' ' + r.complaint).toLowerCase().indexOf(qv) > -1; });
    $('d-hist-empty').classList.toggle('hidden', !!rows.length);
    $('d-hist-body').innerHTML = rows.map(function (r) { return '<tr><td class="mono">' + fmtDate(r.seen_at) + '</td><td><div class="pn">' + esc(r.patient.name) + '</div><div class="ps">' + esc((r.patient.age || '') + ' ' + (r.patient.sex || '')) + '</div></td><td>' + esc(r.complaint) + '</td><td>' + (r.share_status === 'active' ? '<span class="chip ok">Active' + (r.expires_at ? ' until ' + fmtDate(r.expires_at) : '') + '</span>' : '<span class="chip plain">Share ended</span>') + '</td><td>' + esc(r.outcome) + '</td><td><button class="btn btn-sm btn-ghost" onclick="openPatient(' + r.id + ')">' + (r.share_status === 'active' ? 'Open' : 'Notes') + '</button></td></tr>'; }).join('');
  };

  /* live refresh: queues and requests update while the page is open */
  setInterval(function () {
    if (!USER || document.hidden) return;
    var id = lastScreen[USER.role];
    if (['c-today', 'd-queue', 'p-sharing', 'p-home', 'c-requests'].indexOf(id) > -1 && $(id).classList.contains('active') && !$('scrim').classList.contains('open')) loaders[id]();
  }, 15000);
})();
