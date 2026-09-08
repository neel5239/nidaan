(function(){
  var lastScreen = {clinic:'c-today', doctor:'d-queue', patient:'p-home'};

  window.showPortal = function(p){
    document.querySelectorAll('.portal').forEach(function(el){ el.classList.toggle('active', el.id === 'portal-'+p); });
    document.querySelectorAll('.role').forEach(function(b){ b.setAttribute('aria-selected', b.dataset.portal === p ? 'true' : 'false'); });
    window.scrollTo(0,0);
  };

  window.showScreen = function(portal, id, btn){
    var root = document.getElementById('portal-'+portal);
    root.querySelectorAll('.screen').forEach(function(s){ s.classList.toggle('active', s.id === id); });
    var navBtn = btn;
    if(!navBtn){
      root.querySelectorAll('.navb').forEach(function(b){ if((b.getAttribute('onclick')||'').indexOf("'"+id+"'")>-1) navBtn = b; });
    }
    if(navBtn){
      root.querySelectorAll('.navb').forEach(function(b){ b.removeAttribute('aria-current'); });
      navBtn.setAttribute('aria-current','page');
    }
    lastScreen[portal] = id;
    window.scrollTo(0,0);
  };

  window.showTab = function(btn, id){
    var bar = btn.parentElement;
    bar.querySelectorAll('.tab').forEach(function(t){ t.setAttribute('aria-selected','false'); });
    btn.setAttribute('aria-selected','true');
    var pane = document.getElementById(id);
    var container = pane.parentElement;
    container.querySelectorAll(':scope > .tabpane').forEach(function(p){ p.classList.toggle('active', p.id === id); });
  };

  window.openModal = function(id){
    document.querySelectorAll('#scrim .modal').forEach(function(m){ m.classList.add('hidden'); });
    var m = document.getElementById(id);
    m.classList.remove('hidden');
    document.getElementById('scrim').classList.add('open');
    var f = m.querySelector('input,select,textarea,button:not(.xbtn)');
    if(f) setTimeout(function(){ f.focus(); }, 30);
  };
  window.closeModal = function(){ document.getElementById('scrim').classList.remove('open'); };
  document.addEventListener('keydown', function(e){ if(e.key === 'Escape') closeModal(); });

  var assignName = '';
  window.openAssign = function(name, cc, spec){
    assignName = name;
    document.getElementById('as-name').textContent = name;
    document.getElementById('as-cc').textContent = cc;
    document.getElementById('as-spec').textContent = spec;
    var radios = document.querySelectorAll('#as-list input');
    var idx = {GP:0, Cardiology:1, Orthopaedics:2, Dermatology:3}[spec] || 0;
    radios[idx].checked = true;
    openModal('m-assign');
  };
  window.doAssign = function(){
    var picked = document.querySelector('#as-list input:checked');
    var doc = picked ? picked.parentElement.querySelector('.dn').textContent : 'doctor';
    closeModal();
    toast(assignName + ' assigned to ' + doc + ' · intake request sent to patient');
  };

  window.acceptShare = function(btn, name){
    var card = btn.closest('.card');
    card.style.opacity = '.6';
    btn.closest('.actions').innerHTML = '<span class="chip ok">Accepted · in queue</span>';
    toast(name + ' added to today’s queue');
  };

  window.openPatient = function(){ showScreen('doctor','d-patient'); };

  var toastTimer;
  window.toast = function(msg){
    var t = document.getElementById('toast');
    document.getElementById('toast-t').textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function(){ t.classList.remove('show'); }, 2600);
  };

  /* segmented controls + pain scale: generic toggle */
  document.addEventListener('click', function(e){
    var b = e.target.closest('.seg > button, .scale > button');
    if(!b) return;
    b.parentElement.querySelectorAll('button').forEach(function(x){ x.setAttribute('aria-pressed','false'); });
    b.setAttribute('aria-pressed','true');
  });

  /* ---------- request-driven intake engine ---------- */
  var IQ = {
    mode: null,      /* 'voice' | 'text' */
    a: {},           /* answers keyed by step id */
    pain: 5,
    hasReports: null,
    docs: [
      {id:'xray',  name:'X-ray right knee',        meta:'Sahyadri Diagnostics · Imaging', date:'30 Aug 2026', th:'JPG', on:true},
      {id:'lab',   name:'Uric acid and CBC',        meta:'Metropolis Labs · Lab',          date:'29 Aug 2026', th:'PDF', on:true},
      {id:'rx',    name:'Prescription — Dr. R. Menon', meta:'City Care Clinic · Viral fever', date:'14 Jul 2026', th:'PDF', on:false},
      {id:'ahc',   name:'Annual health check bundle', meta:'Metropolis Labs · 6 files',    date:'Jan 2026',    th:'ZIP', on:false}
    ],
    sent: false
  };
  var SAMPLE = {
    where:  'My right knee, mostly on the inner side. It started after a long run last Sunday.',
    since:  'About six days. It was fine during the run, then stiff and painful the next morning.',
    worst:  'Going down stairs is the worst. It is a bit swollen in the evenings and sometimes it locks for a second.',
    other:  'No fever. I have not had any injury to this knee before. I take no regular medicines.'
  };
  var STEPS = [
    {id:'mode',  title:'How would you like to answer?'},
    {id:'where', title:'What is troubling you, and where?',  q:'What is troubling you, and where exactly is it?', hint:'Describe it in your own words. Point to the place if it helps.'},
    {id:'since', title:'Since when, and how did it start?',   q:'Since when has this been going on, and how did it start?', hint:'A rough time is fine.'},
    {id:'pain',  title:'How bad is it right now?'},
    {id:'other', title:'Anything else the doctor should know?', q:'Fever, past injuries, regular medicines, or anything else?', hint:'Say "nothing else" if there is nothing.'},
    {id:'urgent',title:'Anything urgent?'},
    {id:'reports',title:'Previous reports'},
    {id:'pick',  title:'Choose reports to share', cond:function(){ return IQ.hasReports === true; }},
    {id:'summary',title:'Review and send'}
  ];
  var q = 0;
  function visible(){ return STEPS.filter(function(st){ return !st.cond || st.cond(); }); }
  function esc(t){ return String(t||'').replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];}); }

  function answerBlock(st){
    var val = IQ.a[st.id] || '';
    if(IQ.mode === 'voice'){
      return '<div class="voice">' +
        '<button type="button" class="mic" id="mic" onclick="micTap(\'' + st.id + '\')" aria-label="Tap to speak"><svg><use href="#i-mic"/></svg></button>' +
        '<div class="vs" id="mic-status">' + (val ? 'Recorded. Tap the mic to answer again.' : 'Tap the mic, then speak your answer') + '</div>' +
        '<div class="transcript' + (val ? '' : ' hidden') + '" id="transcript"><div class="label"><span>What we heard</span><button type="button" onclick="document.getElementById(\'ans\').focus()">Edit</button></div>' +
        '<textarea class="input" id="ans" rows="3" oninput="IQ.a[\'' + st.id + '\']=this.value">' + esc(val) + '</textarea></div>' +
        '</div>';
    }
    return '<div class="field"><textarea class="input" id="ans" rows="4" placeholder="Type your answer…" oninput="IQ.a[\'' + st.id + '\']=this.value">' + esc(val) + '</textarea><span class="hint">' + st.hint + '</span></div>';
  }

  function render(){
    var vis = visible(), st = vis[q], max = vis.length, h = '';
    document.getElementById('qs-n').textContent = q + 1;
    document.getElementById('qs-max').textContent = max;
    document.getElementById('qs-title').textContent = st.title;
    document.getElementById('qs-bar').style.width = Math.round((q + 1) / max * 100) + '%';
    document.getElementById('qs-back').disabled = q === 0;
    var nb = document.getElementById('qs-next');
    nb.textContent = st.id === 'summary' ? 'Send to Arogya' : 'Continue';
    nb.disabled = st.id === 'mode' && !IQ.mode;

    switch(st.id){
      case 'mode':
        h = '<h2 style="margin-bottom:4px">How would you like to answer?</h2><p class="muted small" style="margin-bottom:16px">Same questions either way. You can switch later from Back.</p>' +
          '<div class="modepick">' +
          '<label><input type="radio" name="iq-mode" value="voice"' + (IQ.mode==='voice'?' checked':'') + ' onchange="setMode(\'voice\')"><span class="mi"><svg><use href="#i-mic"/></svg></span><span class="mt">Speak your answers</span><span class="ms">We ask each question aloud. Tap the mic and talk. You can fix the text after.</span></label>' +
          '<label><input type="radio" name="iq-mode" value="text"' + (IQ.mode==='text'?' checked':'') + ' onchange="setMode(\'text\')"><span class="mi"><svg><use href="#i-keyboard"/></svg></span><span class="mt">Type your answers</span><span class="ms">Read each question and type. Good in a quiet waiting room.</span></label>' +
          '</div>';
        break;
      case 'where': case 'since': case 'other':
        h = '<h2 style="margin-bottom:4px">' + st.q + '</h2><p class="muted small" style="margin-bottom:14px">' + (IQ.mode==='voice' ? 'We will read this out. Tap the mic when ready.' : st.hint) + '</p>' + answerBlock(st);
        break;
      case 'pain':
        h = '<h2 style="margin-bottom:4px">How bad is it right now?</h2><p class="muted small" style="margin-bottom:14px">0 is no pain, 10 is the worst you can imagine.' + (IQ.mode==='voice' ? ' Say a number or tap one.' : '') + '</p>' +
          '<div class="scale" id="q-scale" aria-label="Pain 0 to 10">' + [1,2,3,4,5,6,7,8,9,10].map(function(n){ return '<button type="button" aria-pressed="' + (n===IQ.pain) + '" onclick="IQ.pain=' + n + '">' + n + '</button>'; }).join('') + '</div>' +
          '<div style="margin-top:18px"><div class="label" style="margin-bottom:8px">When is it worst?</div>' + answerBlock({id:'worst', hint:'For example: at night, on stairs, after sitting.'}) + '</div>';
        break;
      case 'urgent':
        h = '<h2 style="margin-bottom:4px">Anything urgent?</h2><p class="muted small" style="margin-bottom:14px">If yes to any of these, we mark it clearly for the doctor.</p><div class="opts">' +
          ['Fever with a hot, red joint|Could mean infection in the joint','Cannot put any weight on the leg|','Knee looks deformed or out of place|','Numbness or the foot feels cold|'].map(function(x,i){ var t=x.split('|'); return '<label class="check"><input type="checkbox" onchange="IQ.a.urg' + i + '=this.checked"' + (IQ.a['urg'+i]?' checked':'') + '><div><div class="t">' + t[0] + '</div>' + (t[1]?'<div class="s">' + t[1] + '</div>':'') + '</div></label>'; }).join('') +
          '<label class="check"><input type="checkbox" checked><div><div class="t">None of these</div></div></label></div>' +
          '<div class="notice crit" style="margin-top:14px"><svg class="ic"><use href="#i-alert"/></svg><span>Severe breathlessness, chest pain or a suspected fracture: go to the nearest emergency department now instead of continuing here.</span></div>';
        break;
      case 'reports':
        h = '<h2 style="margin-bottom:4px">Do you have any previous reports for this problem?</h2><p class="muted small" style="margin-bottom:16px">X-rays, scans, lab results, old prescriptions. Sharing them saves the doctor from repeating tests.</p>' +
          '<div class="yesno">' +
          '<label class="opt" style="text-align:center;padding:16px"><input type="radio" name="iq-rep"' + (IQ.hasReports===true?' checked':'') + ' onchange="setReports(true)">Yes, I have reports</label>' +
          '<label class="opt" style="text-align:center;padding:16px"><input type="radio" name="iq-rep"' + (IQ.hasReports===false?' checked':'') + ' onchange="setReports(false)">No, nothing to add</label>' +
          '</div>' +
          '<p class="small faint" style="margin-top:14px">You can always share reports later from Sharing.</p>';
        nb.disabled = IQ.hasReports === null;
        break;
      case 'pick':
        h = '<h2 style="margin-bottom:4px">Choose reports to share with Dr. Rao</h2><p class="muted small" style="margin-bottom:14px">Only ticked items are shared. Files already in your documents are listed first.</p>' +
          '<div class="stack" style="gap:8px" id="doc-list">' + IQ.docs.map(function(d){ return docRow(d); }).join('') +
          '<label class="doc-pick new" id="doc-add"><input type="checkbox" style="visibility:hidden"><span class="th"><svg class="ic" style="width:16px;height:16px"><use href="#i-upload"/></svg></span><span><span class="dn">Add a report not in your documents</span><span class="dm" style="display:block">Photo or PDF · saved to Right knee pain, then shared here</span></span><span class="dd"><span class="btn btn-sm btn-ghost" onclick="event.preventDefault();addDoc()">Upload</span></span></label>' +
          '</div>' +
          '<div class="notice plain" style="margin-top:14px"><svg class="ic"><use href="#i-lock"/></svg><span>Shared until the visit ends unless you extend it. Profile basics (blood group, allergies) are always included.</span></div>';
        break;
      case 'summary':
        var flags = [0,1,2,3].filter(function(i){ return IQ.a['urg'+i]; });
        var picked = IQ.docs.filter(function(d){ return d.on; });
        h = '<h2 style="margin-bottom:4px">Review and send</h2><p class="muted small" style="margin-bottom:14px">This is exactly what Arogya and Dr. Rao will see. Answered by ' + (IQ.mode==='voice'?'speaking':'typing') + '.</p>' +
          '<dl class="kv" style="margin-bottom:16px">' +
          '<dt>Problem</dt><dd>' + esc(IQ.a.where || '—') + '</dd>' +
          '<dt>Since</dt><dd>' + esc(IQ.a.since || '—') + '</dd>' +
          '<dt>Severity</dt><dd><span class="mono">' + IQ.pain + '/10</span> · ' + esc(IQ.a.worst || '—') + '</dd>' +
          '<dt>Other</dt><dd>' + esc(IQ.a.other || '—') + '</dd>' +
          '<dt>Urgent signs</dt><dd>' + (flags.length ? '<span class="chip crit">' + flags.length + ' flagged</span>' : 'None') + '</dd>' +
          '<dt>Reports</dt><dd>' + (IQ.hasReports ? (picked.length ? picked.map(function(d){ return '<span class="tag">' + esc(d.name) + '</span>'; }).join(' ') : 'None selected') : 'None to add') + '</dd>' +
          '</dl>' +
          '<div class="disclaim"><b>For reference only.</b> Based on your answers, a doctor will likely consider a meniscus strain, a ligament sprain or runner\'s knee. Only an examination can tell. This tool does not diagnose or treat.</div>';
        break;
    }
    document.getElementById('qs-body').innerHTML = h;
    var ta = document.getElementById('ans'); if(ta && IQ.mode === 'text') setTimeout(function(){ ta.focus(); }, 30);
  }
  function docRow(d){
    return '<label class="doc-pick"><input type="checkbox"' + (d.on?' checked':'') + ' onchange="IQ.docs.find(function(x){return x.id===\'' + d.id + '\'}).on=this.checked"><span class="th">' + d.th + '</span><span><span class="dn">' + esc(d.name) + '</span><span class="dm" style="display:block">' + esc(d.meta) + '</span></span><span class="dd">' + d.date + '</span></label>';
  }
  window.setMode = function(m){ IQ.mode = m; document.getElementById('qs-next').disabled = false; };
  window.setReports = function(v){ IQ.hasReports = v; document.getElementById('qs-next').disabled = false; };
  window.addDoc = function(){
    var add = document.getElementById('doc-add');
    add.querySelector('.dn').textContent = 'Uploading MRI_knee_report.pdf…';
    add.querySelector('.dm').innerHTML = '<div class="prog" style="margin-top:6px;width:180px"><i id="doc-prog" style="width:10%"></i></div>';
    var w = 10; var t = setInterval(function(){ w += 30; var b = document.getElementById('doc-prog'); if(b) b.style.width = Math.min(100,w) + '%'; if(w >= 100){ clearInterval(t);
      var d = {id:'mri'+Date.now(), name:'MRI right knee', meta:'Sahyadri Diagnostics · Imaging · just added', date:'02 Sep 2026', th:'PDF', on:true};
      IQ.docs.push(d);
      add.insertAdjacentHTML('beforebegin', docRow(d));
      add.querySelector('.dn').textContent = 'Add another report';
      add.querySelector('.dm').textContent = 'Photo or PDF · saved to Right knee pain, then shared here';
      toast('MRI right knee saved to Right knee pain and ticked for sharing');
    } }, 250);
  };
  window.micTap = function(id){
    var mic = document.getElementById('mic'), st = document.getElementById('mic-status');
    if(mic.classList.contains('on')) return;
    mic.classList.add('on'); st.textContent = 'Listening…'; st.classList.add('on');
    setTimeout(function(){
      mic.classList.remove('on'); st.classList.remove('on'); st.textContent = 'Recorded. Tap the mic to answer again.';
      var text = SAMPLE[id] || 'Nothing else.';
      IQ.a[id] = text;
      var tr = document.getElementById('transcript'); tr.classList.remove('hidden');
      document.getElementById('ans').value = text;
    }, 1800);
  };
  window.qStep = function(d){
    var vis = visible();
    if(vis[q].id === 'summary' && d > 0){ submitIntake(); return; }
    q = Math.min(vis.length - 1, Math.max(0, q + d));
    render();
  };
  window.openRequest = function(){
    showScreen('patient','p-intake');
    document.querySelectorAll('#portal-patient .navb').forEach(function(b){ b.removeAttribute('aria-current'); });
    var sb = null; document.querySelectorAll('#portal-patient .navb').forEach(function(b){ if((b.getAttribute('onclick')||'').indexOf('p-sharing')>-1) sb = b; }); if(sb) sb.setAttribute('aria-current','page');
    q = 0; render();
  };
  function submitIntake(){
    IQ.sent = true;
    var picked = IQ.docs.filter(function(d){ return d.on; });
    /* request card -> done */
    var card = document.getElementById('req-arogya');
    card.style.borderLeftColor = 'var(--teal)'; card.style.opacity = '.85';
    card.querySelector('.chip').className = 'chip ok'; card.querySelector('.chip').textContent = 'Sent';
    document.getElementById('req-arogya-actions').innerHTML = '<span class="chip ok">Sent today</span>';
    ['p-req-cnt','ps-req-cnt'].forEach(function(id){ var e = document.getElementById(id); if(e) e.textContent = '0'; });
    var hb = document.getElementById('p-home-req'); if(hb) hb.classList.add('hidden');
    var hn = document.getElementById('p-home-reqnote'); if(hn){ hn.className = 'notice ok'; hn.innerHTML = '<svg class="ic"><use href="#i-check"/></svg><span>Intake sent to Dr. Anjali Rao at Arogya. Reports shared: ' + (IQ.hasReports ? picked.length : 0) + '.</span></span>'; }
    /* active share entry */
    var tags = '<span class="tag">Intake (' + (IQ.mode==='voice'?'spoken':'typed') + ')</span>' + (IQ.hasReports ? picked.map(function(d){ return '<span class="tag">' + esc(d.name) + '</span>'; }).join('') : '') + '<span class="tag">Profile basics</span>';
    document.getElementById('ps-active-list').insertAdjacentHTML('afterbegin',
      '<div class="card perm" style="border-left:3px solid var(--teal)"><div class="avatar" style="background:var(--clinic)">AM</div><div class="pc"><div class="pn">Arogya Multispeciality · Dr. Anjali Rao <span class="chip ok" style="margin-left:6px">Just sent</span></div><div class="pm">Episode: <b>Right knee pain</b> · sent just now · ends when this visit closes</div><div class="pi">' + tags + '</div></div><div class="actions"><button class="btn btn-sm btn-danger" onclick="toast(\'Share with Dr. Rao revoked\')">Revoke</button></div></div>');
    document.getElementById('ps-log-list').insertAdjacentHTML('afterbegin', '<li class="now"><div class="tt">You sent intake' + (IQ.hasReports && picked.length ? ' + ' + picked.length + ' report' + (picked.length>1?'s':'') : '') + ' to Dr. Anjali Rao</div><div class="tm">Just now · Arogya</div></li>');
    showScreen('patient','p-sharing');
    showTab(document.getElementById('ps-tab-req'), 'ps-req');
    toast('Sent to Arogya. Dr. Rao can see it now.');
    q = 0;
  }

  /* ---------- login ---------- */
  var ROLES = {
    patient:{title:'Sign in as a patient',sub:'Use the email and password you registered with.',btn:'Sign in to patient portal',signup:'Create a patient account',home:'p-home',color:'var(--patient)'},
    clinic: {title:'Sign in to your clinic',sub:'Front desk and admin staff use the clinic login issued at registration.',btn:'Sign in to clinic portal',signup:'Register your clinic',home:'c-today',color:'var(--clinic)'},
    doctor: {title:'Sign in as a doctor',sub:'Use the login from your clinic invite. You will see only patients assigned to you.',btn:'Sign in to doctor portal',signup:'Have an invite? Set your password',home:'d-queue',color:'var(--doctor)'}
  };
  /* Demo users. Frontend only; replace with API auth later. */
  var USERS = [
    {role:'patient',email:'rohan.mehta@gmail.com',   pass:'patient123',name:'Rohan Mehta',   sub:'34 M \u00b7 NID-2041-7783',ini:'RM',hello:'Welcome back, Rohan'},
    {role:'patient',email:'sunita.pawar@gmail.com',  pass:'patient123',name:'Sunita Pawar',  sub:'58 F \u00b7 NID-1187-2290',ini:'SP',hello:'Welcome back, Sunita'},
    {role:'patient',email:'kavita.joshi@gmail.com',  pass:'patient123',name:'Kavita Joshi',  sub:'45 F \u00b7 NID-3320-0451',ini:'KJ',hello:'Welcome back, Kavita'},
    {role:'clinic', email:'frontdesk@arogya.clinic', pass:'clinic123', name:'Arogya Multispeciality',sub:'Priya Deshmukh \u00b7 Front desk',ini:'AM',hello:'Signed in \u00b7 Arogya front desk'},
    {role:'clinic', email:'admin@arogya.clinic',     pass:'clinic123', name:'Arogya Multispeciality',sub:'Dr. R. Kulkarni \u00b7 Admin',ini:'AM',hello:'Signed in \u00b7 Arogya admin'},
    {role:'doctor', email:'vikram.sethi@arogya.clinic',pass:'doctor123',name:'Dr. Vikram Sethi',sub:'General physician \u00b7 Arogya',ini:'VS',hello:'Signed in \u00b7 Dr. Vikram Sethi'},
    {role:'doctor', email:'anjali.rao@arogya.clinic', pass:'doctor123',name:'Dr. Anjali Rao', sub:'Orthopaedics \u00b7 Arogya',ini:'AR',hello:'Signed in \u00b7 Dr. Anjali Rao'},
    {role:'doctor', email:'meera.iyer@arogya.clinic', pass:'doctor123',name:'Dr. Meera Iyer', sub:'Dermatology \u00b7 Arogya',ini:'MI',hello:'Signed in \u00b7 Dr. Meera Iyer'}
  ];
  var loginRole = 'patient';
  function btnLabel(r){ return '<svg class="ic"><use href="#i-lock"/></svg>' + ROLES[r].btn; }
  window.setLoginRole = function(r){
    loginRole = r; var a = ROLES[r];
    document.getElementById('login-title').textContent = a.title;
    document.getElementById('login-sub').textContent = a.sub;
    document.getElementById('login-btn').innerHTML = btnLabel(r);
    document.getElementById('login-signup').textContent = a.signup;
    document.getElementById('login-err').classList.add('hidden');
    var radio = document.querySelector('.rolepick input[value="' + r + '"]'); if(radio) radio.checked = true;
  };
  window.fillDemo = function(i){
    var u = USERS[i];
    setLoginRole(u.role);
    var em = document.getElementById('login-email'), pw = document.getElementById('login-pass');
    em.value = u.email; pw.value = u.pass;
    clearErr(em); clearErr(pw);
    document.getElementById('login-btn').focus();
  };
  (function renderDemo(){
    var box = document.getElementById('demo-list');
    ['patient','clinic','doctor'].forEach(function(r){
      var g = document.createElement('div'); g.className = 'demo-grp'; g.style.setProperty('--role-c', ROLES[r].color);
      USERS.forEach(function(u, i){
        if(u.role !== r) return;
        var b = document.createElement('button'); b.type = 'button'; b.className = 'demo-acc';
        b.innerHTML = '<span class="sw"></span><span class="dn">' + u.name + '</span><span class="de">' + u.email + '</span><span class="dp">' + u.pass + '</span>';
        b.onclick = function(){ fillDemo(i); };
        g.appendChild(b);
      });
      box.appendChild(g);
    });
  })();
  window.togglePw = function(b){
    var i = document.getElementById('login-pass'); var show = i.type === 'password';
    i.type = show ? 'text' : 'password'; b.textContent = show ? 'Hide' : 'Show'; b.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  };
  window.clearErr = function(i){
    i.classList.remove('invalid');
    document.getElementById(i.id + '-err').classList.add('hidden');
    document.getElementById('login-err').classList.add('hidden');
  };
  function bad(i){ i.classList.add('invalid'); document.getElementById(i.id + '-err').classList.remove('hidden'); }
  function applyUser(u){
    var who = document.querySelector('#portal-' + u.role + ' .who');
    if(!who) return;
    who.querySelector('.avatar').textContent = u.ini;
    who.querySelector('.name').textContent = u.name;
    who.querySelector('.sub').textContent = u.sub;
  }
  window.doLogin = function(e){
    e.preventDefault();
    var em = document.getElementById('login-email'), pw = document.getElementById('login-pass'), ok = true;
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em.value.trim())){ bad(em); ok = false; }
    if(pw.value.length < 6){ bad(pw); ok = false; }
    if(!ok){ (em.classList.contains('invalid') ? em : pw).focus(); return false; }
    var email = em.value.trim().toLowerCase(), u = null;
    USERS.forEach(function(x){ if(x.role === loginRole && x.email === email && x.pass === pw.value) u = x; });
    if(!u){ document.getElementById('login-err').classList.remove('hidden'); pw.focus(); return false; }
    var btn = document.getElementById('login-btn'); btn.disabled = true; btn.textContent = 'Signing in\u2026';
    setTimeout(function(){
      btn.disabled = false; btn.innerHTML = btnLabel(loginRole);
      applyUser(u);
      var lbl = {patient:'Patient',clinic:'Clinic',doctor:'Doctor'}[u.role];
      document.getElementById('proto-note').textContent = 'Signed in to the ' + lbl.toLowerCase() + ' portal as ' + u.name + '. Other portals are not accessible from this login.';
      var badge = document.getElementById('role-badge-in'); badge.lastChild.textContent = lbl; badge.querySelector('.sw').style.background = ROLES[u.role].color;
      document.body.classList.remove('auth');
      showPortal(u.role);
      showScreen(u.role, ROLES[u.role].home);
      toast(u.hello);
    }, 500);
    return false;
  };
  window.logout = function(){
    document.body.classList.add('auth');
    document.getElementById('login-pass').value = '';
    document.getElementById('login-err').classList.add('hidden');
    closeModal();
    window.scrollTo(0,0);
    setTimeout(function(){ document.getElementById('login-email').focus(); }, 30);
  };
  document.body.classList.add('auth');
  setLoginRole('patient');
})();
