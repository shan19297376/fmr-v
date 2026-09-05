/**
 * Family Health Records — the first app on the shell.
 *
 * It owns its screens and nothing else. Sign-in, the person switcher, routing,
 * the back button and the launcher all belong to the shell; this file declares
 * what the app shows and the shell draws the chrome around it.
 *
 * A second app is a file shaped like this one plus a line in the shell's APPS.
 */

import {
  $, esc, fmt, fmtShort, rel, api, post, put, cachedGet, bust, clearCache,
  setStatus, sheet, closeSheet, actions, download, state, person, go, refresh as route,
  refreshPeople, personSheet,
} from '../shell.js';

/* ================================================================
   1. Add — the first screen, because filing a report is the job
   ================================================================ */

async function viewUpload() {
  const events = state.current
    ? await cachedGet('/api/health/events?person=' + state.current).catch(() => []) : [];

  $('main').innerHTML =
    '<section><div class="panel">' +

      '<div class="field"><label for="upFiles">Files</label>' +
      '<input type="file" id="upFiles" multiple accept="application/pdf,image/*"></div>' +

      '<div class="field"><label for="upWho">Whose</label><select id="upWho">' +
        state.people.map((p) => '<option value="'+p.person_id+'"'+
          (p.person_id===state.current?' selected':'')+'>'+esc(p.name)+'</option>').join('') +
        '<option value="">Work it out from the documents</option>' +
      '</select></div>' +

      '<div class="field"><label for="upEvent">Episode</label><select id="upEvent">' +
        '<option value="auto">Sort automatically</option>' +
        events.map((e) => '<option value="'+e.care_event_id+'">'+esc(e.title)+'</option>').join('') +
        '<option value="__new">Start a new episode\u2026</option>' +
        '<option value="none">Leave ungrouped</option>' +
      '</select></div>' +

      '<div class="field"><label for="upKind">Type</label><select id="upKind">' +
        '<option value="bulk">Bulk \u2014 several documents</option>' +
        '<option value="one">Individual \u2014 one document</option>' +
      '</select></div>' +

      '<div class="field"><label for="upDate">Date</label>' +
      '<input type="date" id="upDate" value="'+state.account.today+'"></div>' +
      '<div class="sub" style="margin:-6px 0 12px 118px">Only used where a document has no readable date.</div>' +

      '<div class="field"><label></label><button class="go" id="upGo">Upload</button></div>' +
      '<div class="status" id="upStatus">Each document is read, sorted and filed on its own. ' +
      'Anything unclear waits for you under Review.</div>' +
    '</div></section>' +

    '<section><div class="h"><h2>Reading at home</h2></div>' +
    '<div class="sub">Blood pressure, sugar or weight, with no report to attach.</div>' +
    '<div class="panel">' +
      '<div class="field"><label for="mrParam">What</label><select id="mrParam">' +
        ['Blood Pressure','Fasting Blood Sugar','Post Meal Blood Sugar','Random Blood Sugar',
         'Pulse','SpO2','Temperature','Weight','Height'].map((x) => '<option>'+x+'</option>').join('') +
      '</select></div>' +
      '<div class="field"><label for="mrValue">Reading</label>' +
      '<input type="text" id="mrValue" placeholder="128/84"></div>' +
      '<div class="field"><label for="mrUnit">Unit</label><input type="text" id="mrUnit" placeholder="mmHg"></div>' +
      '<div class="field"><label for="mrDate">Taken on</label>' +
      '<input type="date" id="mrDate" value="'+state.account.today+'"></div>' +
      '<div class="field"><label></label><button class="go" id="mrGo">Save reading</button></div>' +
      '<div class="status" id="mrStatus"></div></div></section>' +

    '<section id="filedSec" hidden><div class="h"><h2>Just filed</h2>' +
      '<button class="more" id="reloadFiled">Refresh</button></div>' +
      '<div class="sub">Worth a glance. Tap any of these to correct it.</div>' +
      '<div class="list" id="filed"></div></section>';

  $('upEvent').onchange = (e) => { if (e.target.value === '__new') newEpisode(); };
  $('upGo').onclick = doUpload;
  $('mrGo').onclick = doReading;
  $('reloadFiled').onclick = loadFiled;
  loadFiled();
  pollQueue();
}

async function doUpload() {
  const files = [...$('upFiles').files];
  if (!files.length) return setStatus('upStatus', 'Choose at least one file.', 'err');

  const ep = $('upEvent').value;
  const bulk = $('upKind').value === 'bulk';
  const batchId = crypto.randomUUID ? crypto.randomUUID() : String(Date.now());

  const base = {
    person: $('upWho').value || undefined,
    date: $('upDate').value,
    careEventId: (ep !== 'auto' && ep !== 'none' && ep !== '__new') ? ep : undefined,
    autoEpisode: ep === 'auto',
  };

  $('upGo').disabled = true;
  try {
    // Bulk: one job per file, each read and filed on its own.
    // Individual: one job holding every file, treated as a single document.
    let job = bulk ? null : await post('/api/core/uploads', base);
    let skipped = 0;

    for (let i = 0; i < files.length; i++) {
      setStatus('upStatus', 'Sending ' + (i+1) + ' of ' + files.length + '\u2026');
      if (bulk) job = await post('/api/core/uploads', Object.assign({}, base, { batchId }));

      const form = new FormData(); form.append('file', files[i]);
      const res = await fetch('/api/core/uploads/' + job.jobId + '/file',
        { method:'POST', credentials:'same-origin', body: form });
      const body = await res.json();
      if (res.status === 409 && body.duplicate) { skipped++; continue; }
      if (!res.ok) throw new Error(body.error || (files[i].name + ' could not be sent.'));
    }

    $('upFiles').value = '';
    setStatus('upStatus',
      (files.length - skipped) + (bulk ? ' document(s)' : ' page(s)') + ' sent.' +
      (skipped ? ' ' + skipped + ' already filed, skipped.' : '') +
      ' Reading now \u2014 you can close the app.', 'ok');
    clearCache();
    pollQueue();
  } catch (err) { setStatus('upStatus', err.message, 'err'); }
  finally { $('upGo').disabled = false; }
}

async function doReading() {
  try {
    const r = await post('/api/health/records/reading', { person: state.current,
      date: $('mrDate').value, parameter: $('mrParam').value,
      result: $('mrValue').value, unit: $('mrUnit').value });
    $('mrValue').value = '';
    clearCache();
    setStatus('mrStatus', 'Saved ' + r.parameter +
      (r.abnormal ? ' \u2014 outside the usual range' : '') + '.', r.abnormal ? 'err' : 'ok');
  } catch (err) { setStatus('mrStatus', err.message, 'err'); }
}

/** Keeps the Review badge and the just-filed list honest while work is running. */
let queueTimer = null;
async function pollQueue() {
  clearTimeout(queueTimer);
  try {
    const list = await api('/api/core/review');
    const busy = list.some((j) => j.status === 'queued' || j.status === 'reading');
    paintReviewBadge(list.filter((j) => j.status !== 'queued' && j.status !== 'reading').length);
    if (busy) queueTimer = setTimeout(pollQueue, 3500);
    else { clearCache(); loadFiled(); }
  } catch (e) { /* a failed poll is not worth interrupting anyone over */ }
}

function paintReviewBadge(n) {
  const btn = document.querySelector('[data-tab="review"]');
  if (!btn) return;
  const old = btn.querySelector('.badge');
  if (old) old.remove();
  if (n > 0) btn.insertAdjacentHTML('afterbegin', '<i class="badge">' + n + '</i>');
}

async function loadFiled() {
  if (!$('filed')) return;
  try {
    const list = await api('/api/core/filed');
    $('filedSec').hidden = !list.length;
    $('filed').innerHTML = list.map((f) =>
      '<div class="r" data-tap data-rec="'+f.record_id+'">' +
      '<span class="d num">' + fmtShort(f.event_date) + '</span>' +
      '<span class="tag">' + esc(f.record_type) + '</span>' +
      '<span class="t">' + esc(f.person) + '</span>' +
      '<span class="v">' +
        [f.tests ? f.tests + ' tests' : '', f.medicines ? f.medicines + ' meds' : '',
         f.bills ? f.bills + ' bills' : ''].filter(Boolean).join(' \u00b7 ') + '</span>' +
      '<span class="x">' + esc(f.summary || '').slice(0, 110) +
        (f.episode ? ' \u2014 in \u201c' + esc(f.episode) + '\u201d' : '') + '</span></div>').join('');
    $('filed').onclick = (e) => {
      const r = e.target.closest('[data-rec]');
      if (r) openRecord('record', r.dataset.rec);
    };
  } catch (e) { /* not worth interrupting anyone over */ }
}

/* ================================================================
   1b. Review — permanent, not an error path
   ================================================================ */

async function viewReview() {
  const list = await api('/api/core/review');
  paintReviewBadge(list.filter((j) => j.status !== 'queued' && j.status !== 'reading').length);

  if (!list.length) {
    $('main').innerHTML = '<div class="empty">Nothing waiting.<br>' +
      'Documents the reader cannot place land here \u2014 handwritten notes, poor scans, ' +
      'or a name that does not match who you said.</div>';
    return;
  }

  const label = { queued:'Waiting', reading:'Reading', review:'Needs you', error:'Failed' };
  $('main').innerHTML =
    '<section><div class="sub">Handwritten prescriptions and poor scans are normal. ' +
    'Fill in what the reader could not work out and the document files properly.</div>' +
    '<div class="list">' + list.map((j) =>
      '<div class="r ' + (j.status==='error'?'bad':'') + '" ' +
      (j.status==='review'||j.status==='error' ? 'data-tap data-open="'+j.job_id+'"' : '') + '>' +
      '<span class="tag">' + j.files + ' file' + (j.files===1?'':'s') + '</span>' +
      '<span class="t">' + esc(j.person || j.detected_name || 'Unknown') + '</span>' +
      '<span class="v">' + (j.status==='reading'||j.status==='queued'
        ? '<span class="spin"></span> ' + label[j.status] : label[j.status]) + '</span>' +
      (j.message ? '<span class="x">' + esc(j.message) + '</span>' : '') +
      '</div>').join('') + '</div></section>';

  $('main').onclick = (e) => {
    const r = e.target.closest('[data-open]');
    if (r) openReview(r.dataset.open);
  };
  if (list.some((j) => j.status==='queued' || j.status==='reading')) setTimeout(viewReview, 4000);
}

function newEpisode() {
  sheet('<h3>New episode</h3>' + actions([{ id:'evSave', label:'Create', kind:'go' }, { id:'closeSheet', label:'Cancel' }]) + '<div class="sub">An admission, an illness, a course of treatment.</div>' +
    '<div class="field"><label for="evTitle">What</label><input type="text" id="evTitle" placeholder="Dengue, June 2026"></div>' +
    '<div class="field"><label for="evDate">Started</label><input type="date" id="evDate" value="'+state.account.today+'"></div>' +
    '<div class="field"><label for="evWhere">Hospital</label><input type="text" id="evWhere"></div>' +
    '<div class="field"><label for="evWho">Whose</label><select id="evWho">' +
      state.people.map((p) => '<option value="'+p.person_id+'"'+(p.person_id===state.current?' selected':'')+'>'+esc(p.name)+'</option>').join('') +
    '</select></div>' +
    '<div class="status" id="evStatus"></div>');

  $('evSave').onclick = async () => {
    try {
      const r = await post('/api/health/events', { person: $('evWho').value, date: $('evDate').value,
        title: $('evTitle').value, facility: $('evWhere').value });
      bust('/api/health/events');
      closeSheet();
      const sel = $('upEvent');
      if (sel) {
        const o = document.createElement('option');
        o.value = r.careEventId; o.textContent = r.title; sel.insertBefore(o, sel.lastElementChild);
        sel.value = r.careEventId;
      }
    } catch (err) { setStatus('evStatus', err.message, 'err'); }
  };
  const sel = $('upEvent'); if (sel) sel.value = '';
}

let reviewing = null;

/**
 * One document, opened for review.
 *
 * Two shapes. When the reader got something, you check and correct it. When it
 * got nothing — a handwritten prescription, a bad photograph — you fill in who,
 * when, what type and a line about it, and the scan files properly anyway.
 */
async function openReview(jobId) {
  const job = await api('/api/core/uploads/' + jobId);
  const x = job.extraction || {};
  const captured = (x.tests||[]).length + (x.medicines||[]).length +
    (x.diagnoses||[]).length + (x.bills||[]).length;
  const manual = !x.event_date && !captured && !x.summary;
  reviewing = { jobId, data: x, manual };

  const known = state.people.some((p) => p.person_id === job.person_id);
  if (job.person_id && !known) await refreshPeople();

  const events = await cachedGet('/api/health/events?person=' +
    (job.person_id || state.current)).catch(() => []);

  const TYPES = ['Lab Test','Prescription','Doctor Visit','Bill / Insurance','Imaging',
    'Discharge Summary','Hospital Admission','Vaccination','Procedure','Medicine Purchase','Other'];

  sheet(
    '<h3>' + (manual ? 'Fill in the details' : 'Check before filing') + '</h3>' +
    actions([
      { id:'rvGo', label:'File it', kind:'go' },
      { id:'rvOpen', label:'View scan' },
      { id:'rvDrop', label:'Discard', danger:true, right:true },
    ]) +
    (manual
      ? '<div class="sub">The reader could not use this page. Tell it what this is and the ' +
        'scan will be filed and findable. Values can be added later if you need them.</div>'
      : '') +
    (job.detected_name && job.person_id && job.needs_attention
      ? '<div class="warnbox">You filed this under ' +
        esc((state.people.find((p) => p.person_id === job.person_id)||{}).name || '') +
        ', but the document reads \u201c' + esc(job.detected_name) + '\u201d. ' +
        'Your choice stands unless you change it here.</div>' : '') +
    (!manual && (x.uncertain_fields||[]).length
      ? '<div class="warnbox">Hard to read: ' + esc(x.uncertain_fields.join(', ')) + '</div>' : '') +

    '<div class="field"><label for="rvWho">Whose</label><select id="rvWho">' +
      (job.person_id ? '' : '<option value="">Choose\u2026</option>') +
      state.people.map((p) => '<option value="'+p.person_id+'"'+
        (p.person_id===job.person_id?' selected':'')+'>'+esc(p.name)+'</option>').join('') +
    '</select></div>' +

    '<div class="field"><label for="rvDate">Date</label>' +
    '<input type="date" id="rvDate" value="'+esc(x.event_date || job.user_date || '')+'"></div>' +

    '<div class="field"><label for="rvType">Type</label><select id="rvType">' +
      TYPES.map((t) => '<option'+(t===(x.record_type||'Other')?' selected':'')+'>'+t+'</option>').join('') +
    '</select></div>' +

    '<div class="field"><label for="rvEvent">Episode</label><select id="rvEvent">' +
      '<option value="auto">Sort automatically</option>' +
      events.map((e) => '<option value="'+e.care_event_id+'"'+
        (e.care_event_id===job.care_event_id?' selected':'')+'>'+esc(e.title)+'</option>').join('') +
      '<option value="none">Leave ungrouped</option>' +
    '</select></div>' +

    (manual ? '<div class="field"><label for="rvWhere">Doctor or lab</label>' +
      '<input type="text" id="rvWhere" value="'+esc(x.facility||'')+'"></div>' : '') +

    '<div class="field"><label for="rvSummary">Summary</label>' +
    '<textarea id="rvSummary" placeholder="' +
      (manual ? 'Handwritten prescription from Dr Sharma for the cough' : '') +
      '">'+esc(x.summary||'')+'</textarea></div>' +

    (captured ? '<div class="legend">' +
      '<span><b>'+(x.tests||[]).length+'</b> tests</span>' +
      '<span><b>'+(x.medicines||[]).length+'</b> medicines</span>' +
      '<span><b>'+(x.diagnoses||[]).length+'</b> diagnoses</span>' +
      '<span><b>'+(x.bills||[]).length+'</b> billed</span></div>' +
      '<div class="list" style="margin-top:10px;max-height:240px;overflow:auto">' +
      (x.tests||[]).slice(0,60).map((t) => '<div class="r ' + (t.flag?'bad':'') + '">' +
        '<span class="t">'+esc(t.parameter_standard || t.parameter)+'</span>' +
        '<span class="v num">'+esc(t.result)+' '+esc(t.unit||'')+'</span></div>').join('') +
      '</div>' : '') +

    '<div class="status" id="rvStatus"></div>');

  $('rvOpen').onclick = () => window.open('/api/core/uploads/' + jobId + '/file/0', '_blank');
  $('rvGo').onclick = () => fileIt(job);
  $('rvDrop').onclick = () => discard(jobId);
}

async function fileIt(job) {
  const { jobId, data, manual } = reviewing;
  const who = $('rvWho').value;
  if (!who) return setStatus('rvStatus', 'Choose who this belongs to.', 'err');

  const ep = $('rvEvent').value;
  const payload = {
    person: who,
    date: $('rvDate').value,
    record_type: $('rvType').value,
    summary: $('rvSummary').value,
    facility: $('rvWhere') ? $('rvWhere').value : (data.facility || ''),
    careEventId: (ep !== 'auto' && ep !== 'none') ? ep : null,
    autoEpisode: ep === 'auto',
  };

  $('rvGo').disabled = true;
  setStatus('rvStatus', 'Filing\u2026');
  try {
    if (manual) {
      await post('/api/core/uploads/' + jobId + '/manual', payload);
    } else {
      if (who !== job.person_id) await post('/api/core/uploads/' + jobId + '/person', { person: who });
      await post('/api/core/uploads/' + jobId + '/approve', Object.assign({}, data, {
        event_date: payload.date, record_type: payload.record_type, summary: payload.summary }));
    }
    reviewing = null;
    clearCache(); closeSheet(); route();
  } catch (err) { setStatus('rvStatus', err.message, 'err'); $('rvGo').disabled = false; }
}

async function discard(jobId) {
  if (!confirm('Discard this upload? The scans are deleted too.')) return;
  await post('/api/core/uploads/' + jobId + '/reject', {});
  reviewing = null;
  clearCache(); closeSheet(); route();
}


/* ================================================================
   2. Overview
   ================================================================ */

async function viewOverview() {
  const [snap, dash] = await Promise.all([
    cachedGet('/api/health/snapshot?person=' + state.current),
    cachedGet('/api/health/dashboard'),
  ]);
  const p = snap.profile || {};
  const mine = (l) => l.filter((x) => x.person === person().name);
  const overdue = mine(dash.overdue), upcoming = mine(dash.upcoming);

  const fu = (list, bad) => list.map((f) =>
    '<div class="r ' + (bad?'bad':'') + '"><span class="d num">' + fmtShort(f.due_date) + '</span>' +
    '<span class="t">' + esc(f.instruction || f.type) + '</span>' +
    '<span class="v">' + esc(rel(f.due_date)) + '</span>' +
    '<button class="ghost" data-done="'+f.follow_up_id+'">Done</button></div>').join('');

  $('main').innerHTML =
    '<section><table class="facts">' +
      '<tr><td class="k">Blood group</td><td>'+esc(p.blood_group || '\u2014')+'</td></tr>' +
      '<tr><td class="k">Allergies</td><td class="'+(p.allergies?'hi':'')+'">'+esc(p.allergies || 'None recorded')+'</td></tr>' +
      '<tr><td class="k">Ongoing conditions</td><td>'+esc(p.chronic_conditions || 'None recorded')+'</td></tr>' +
      '<tr><td class="k">Last seen</td><td>'+(snap.lastVisit ? esc(fmt(snap.lastVisit.event_date)+' \u00b7 '+(snap.lastVisit.record_type||'')) : '\u2014')+'</td></tr>' +
    '</table></section>' +
    (snap.nextDue
      ? '<section><div class="h"><h2>Next up</h2><button class="more" data-goto="due">All due</button></div>' +
        '<div class="list"><div class="r ' + (snap.nextDue.due_date < state.account.today ? 'bad' : '') + '">' +
        '<span class="d num">'+fmtShort(snap.nextDue.due_date)+'</span>' +
        '<span class="t">'+esc(snap.nextDue.title)+'</span>' +
        '<span class="v">'+esc(rel(snap.nextDue.due_date))+'</span></div></div></section>' : '') +
    (overdue.length ? '<section><div class="h"><h2>Overdue</h2></div><div class="list">'+fu(overdue,true)+'</div></section>' : '') +
    (upcoming.length ? '<section><div class="h"><h2>Coming up</h2></div><div class="list">'+fu(upcoming,false)+'</div></section>' : '') +
    (snap.abnormalTests.length ? '<section><div class="h"><h2>Out of range</h2></div><div class="list">' +
      snap.abnormalTests.map((t) => '<div class="r bad" data-tap data-trend="'+esc(t.parameter)+'">' +
        '<span class="d num">'+fmtShort(t.test_date)+'</span><span class="t">'+esc(t.parameter)+'</span>' +
        '<span class="v num">'+esc([t.result_text,t.unit].filter(Boolean).join(' '))+'</span></div>').join('') +
      '</div></section>' : '') +
    (snap.activeMedicines.length ? '<section><div class="h"><h2>Current medicines</h2>' +
      '<button class="more" data-goto="medicines">Manage</button></div><div class="list">' +
      snap.activeMedicines.map((m) => '<div class="r"><span class="d num">'+fmtShort(m.prescribed_on)+'</span>' +
        '<span class="t">'+esc([m.name,m.strength].filter(Boolean).join(' '))+'</span>' +
        '<span class="v">'+esc([m.dose,m.frequency].filter(Boolean).join(' '))+'</span>' +
        (m.end_date ? '' : '<span class="tag">no end date</span>')+'</div>').join('') +
      '</div></section>' : '') +
    '<section><div class="tiles">' +
      '<button class="tile" data-goto="due"><b>Everything due</b><span>Reminders and follow-ups</span></button>' +
      '<button class="tile" data-goto="medicines"><b>Medicines</b><span>On now, unconfirmed, finished</span></button>' +
      '<button class="tile" data-goto="episodes"><b>Episodes</b><span>Visits and admissions</span></button>' +
      '<button class="tile" data-goto="settings"><b>Details &amp; exports</b><span>Profile, spreadsheet, scans</span></button>' +
    '</div></section>' +
    '<section><div class="h"><h2>Doctor handout</h2></div>' +
    '<div class="sub">One page: conditions, medicines, latest results, open follow-ups.</div>' +
    '<div class="field"><button class="ghost" id="openHandout">Open &amp; print</button>' +
    '<button class="ghost" id="shareHandout">24-hour link</button></div>' +
    '<div class="status" id="hStatus"></div></section>';

  $('main').onclick = async (e) => {
    const d = e.target.closest('[data-done]');
    const t = e.target.closest('[data-trend]');
    const g = e.target.closest('[data-goto]');
    if (d) { await post('/api/health/records/followup/'+d.dataset.done+'/complete', {}); clearCache(); route(); }
    if (t) go('trend', { parameter: t.dataset.trend });
    if (g) go(g.dataset.goto);
  };
  // Opening a new tab from a home-screen app replaces the app, and coming back
  // reboots it on the default screen. Navigating in place keeps history intact.
  $('openHandout').onclick = () => { location.href = '/api/health/handout?person=' + state.current; };
  $('shareHandout').onclick = async () => {
    try {
      const r = await post('/api/health/handout/share', { person: state.current, hours: 24 });
      await navigator.clipboard.writeText(r.url).catch(() => {});
      setStatus('hStatus', 'Copied. Works for ' + r.hours + ' hours: ' + r.url, 'ok');
    } catch (err) { setStatus('hStatus', err.message, 'err'); }
  };
}

/* ================================================================
   3. Tests — panels, then a grid, then one test
   ================================================================ */

async function viewPanels() {
  const panels = await cachedGet('/api/health/panels?person=' + state.current);
  if (!panels.length) {
    $('main').innerHTML = '<div class="empty">No test results yet.<br>Upload a lab report and its values appear here, grouped by panel.</div>';
    return;
  }
  $('main').innerHTML =
    '<section><div class="sub">Grouped the way a lab report is. Tap a panel to see every result side by side.</div>' +
    '<div class="tiles">' + panels.map((p) =>
      '<button class="tile" data-cat="'+esc(p.category)+'"><b>'+esc(p.category)+'</b>' +
      '<span>'+p.tests+' test'+(p.tests===1?'':'s')+' \u00b7 '+p.results+' result'+(p.results===1?'':'s')+'<br>' +
      'latest '+fmtShort(p.latest)+
      (p.flagged ? ' \u00b7 <span class="flag">'+p.flagged+' out of range</span>' : '')+'</span></button>').join('') +
    '</div></section>';
  $('main').onclick = (e) => {
    const t = e.target.closest('[data-cat]');
    if (t) go('panel', { category: t.dataset.cat });
  };
}

async function viewPanel(p) {
  const category = p.category || '';
  $('htitle').textContent = category;
  const d = await cachedGet('/api/health/panel?person=' + state.current + '&category=' + encodeURIComponent(category));

  if (!d.rows.length) { $('main').innerHTML = '<div class="empty">Nothing in this panel yet.</div>'; return; }

  const head = '<tr><th>Test</th>' + d.dates.map((x) => '<th>'+fmtShort(x)+'</th>').join('') + '<th class="ref">Reference</th></tr>';
  const body = d.rows.map((r) =>
    '<tr data-trend="'+esc(r.parameter)+'"><th>'+esc(r.parameter)+(r.unit?'<br><span style="font-weight:400;color:var(--faint);font-size:11px">'+esc(r.unit)+'</span>':'')+'</th>' +
    d.dates.map((dt) => {
      const v = r.values[dt];
      return '<td class="'+(v && v.abnormal ? 'ab':'')+'">'+(v ? esc(v.text) : '\u00b7')+'</td>';
    }).join('') +
    '<td class="ref">'+esc(r.reference || '')+'</td></tr>').join('');

  $('main').innerHTML =
    '<section><div class="sub">Every result in this panel, newest first. Tap a row for its chart.</div>' +
    '<div class="grid"><table><thead>'+head+'</thead><tbody>'+body+'</tbody></table></div>' +
    '<div class="legend"><span><span class="swatch" style="background:var(--alert-tint);border:1px solid #e6cdc9"></span>Out of range</span>' +
    '<span>' + d.dates.length + ' most recent dates shown</span></div></section>';

  $('main').onclick = (e) => {
    const r = e.target.closest('[data-trend]');
    if (r) go('trend', { parameter: r.dataset.trend });
  };
}

async function viewTrend(p) {
  const parameter = p.parameter || '';
  const range = p.range || '';
  $('htitle').textContent = parameter;

  $('main').innerHTML =
    '<section><div class="chips" id="ranges">' +
    [['','All'],['3m','3 months'],['6m','6 months'],['1y','1 year'],['3y','3 years']]
      .map(([v,l]) => '<button data-r="'+v+'" aria-pressed="'+(v===range)+'">'+l+'</button>').join('') +
    '</div><div id="chartBox"><div class="empty">Loading&hellip;</div></div></section>';

  $('ranges').onclick = (e) => {
    const b = e.target.closest('[data-r]');
    if (b) go('trend', { parameter, range: b.dataset.r }, true);
  };
  $('main').onclick = (e) => {
    const r = e.target.closest('[data-rec]');
    if (r) go('record', { id: r.dataset.rec });
  };

  const d = await cachedGet('/api/health/trends/series?person=' + state.current +
    '&parameter=' + encodeURIComponent(parameter) + '&range=' + range);
  const pts = d.points.filter((x) => x.value_a !== null);

  // Every point links back to the report it came from.
  const table = '<div class="list" style="margin-top:14px">' + d.points.slice().reverse().map((x) =>
    '<div class="r ' + (x.is_abnormal?'bad':'') + '"' +
    (x.record_id ? ' data-tap data-rec="'+x.record_id+'"' : '') + '>' +
    '<span class="d num">'+fmt(x.test_date)+'</span>' +
    '<span class="t num">'+esc(x.result_text)+' '+esc(x.unit||'')+'</span>' +
    '<span class="v">'+esc(x.ref_range_text||'')+'</span>' +
    '<span class="x">'+esc(x.lab||'')+(x.record_id ? ' \u00b7 tap for the report' : '')+'</span>' +
    '</div>').join('') + '</div>';

  if (!pts.length) {
    $('chartBox').innerHTML = '<div class="empty">No numeric results to plot in this period.' +
      (d.points.length ? ' The values are text, or in a unit the app has not been taught yet.' : '') + '</div>' +
      (d.points.length ? table : '');
    return;
  }

  const low = pts[0].ref_low ?? (d.band ? d.band.low : null);
  const high = pts[0].ref_high ?? (d.band ? d.band.high : null);
  const W=760,H=250,L=44,R=12,T=12,B=28;
  const xs = pts.map((x) => Date.parse(x.test_date)), ys = pts.map((x) => x.value_a);
  const lo = Math.min.apply(null, ys.concat(low  !== null ? [low]  : []));
  const hi = Math.max.apply(null, ys.concat(high !== null ? [high] : []));
  const pad = (hi-lo)*0.16 || Math.abs(hi*0.1) || 1;
  const y0 = lo-pad, y1 = hi+pad, x0 = Math.min.apply(null,xs), x1 = Math.max.apply(null,xs);
  const px = (v) => L + (x1===x0 ? (W-L-R)/2 : ((v-x0)/(x1-x0))*(W-L-R));
  const py = (v) => T + (1-(v-y0)/(y1-y0))*(H-T-B);

  const band = (low !== null || high !== null)
    ? '<rect class="band" x="'+L+'" y="'+py(high ?? y1).toFixed(1)+'" width="'+(W-L-R)+
      '" height="'+Math.max(2, py(low ?? y0)-py(high ?? y1)).toFixed(1)+'" rx="3"/>' : '';
  const ticks = [y0,(y0+y1)/2,y1].map((v) =>
    '<line class="gridline" x1="'+L+'" y1="'+py(v).toFixed(1)+'" x2="'+(W-R)+'" y2="'+py(v).toFixed(1)+'"/>' +
    '<text class="axis" x="'+(L-6)+'" y="'+(py(v)+3).toFixed(1)+'" text-anchor="end">'+
      (+v).toFixed(Math.abs(v)<10?1:0)+'</text>').join('');
  const path = pts.map((x,i) => (i?'L':'M')+px(Date.parse(x.test_date)).toFixed(1)+','+py(x.value_a).toFixed(1)).join('');
  const dots = pts.map((x) => '<circle class="dot '+(x.is_abnormal?'bad':'')+'" cx="'+
    px(Date.parse(x.test_date)).toFixed(1)+'" cy="'+py(x.value_a).toFixed(1)+'" r="4.5"><title>'+
    esc(fmt(x.test_date))+': '+esc(x.result_text)+' '+esc(x.unit||'')+'</title></circle>').join('');

  const first = pts[0], last = pts[pts.length-1];
  const change = pts.length > 1 ? last.value_a - first.value_a : null;

  $('chartBox').innerHTML =
    '<div class="chart"><svg viewBox="0 0 '+W+' '+H+'" role="img" aria-label="'+esc(parameter)+' over time">' +
    band + ticks + '<path class="line" d="'+path+'"/>' + dots +
    '<text class="axis" x="'+L+'" y="'+(H-7)+'">'+esc(fmtShort(first.test_date))+'</text>' +
    '<text class="axis" x="'+(W-R)+'" y="'+(H-7)+'" text-anchor="end">'+esc(fmtShort(last.test_date))+'</text>' +
    '</svg><div class="legend">' +
    '<span><span class="swatch" style="background:#2c6a4f;opacity:.32"></span>Normal range' +
      (low !== null || high !== null ? ' '+(low ?? '')+'\u2013'+(high ?? '') : '') + '</span>' +
    (change !== null ? '<span>'+(change>0?'+':'')+change.toFixed(2)+' '+esc(last.unit||'')+
      ' since '+esc(fmtShort(first.test_date))+'</span>' : '') +
    '</div></div>' + table;
}

/* ================================================================
   3b. Due — reminders, follow-ups, medicines running out
   ================================================================ */

async function viewDue() {
  const r = await cachedGet('/api/core/care/reminders');
  const all = r.overdue.concat(r.today, r.upcoming);
  const next = all[0];

  const row = (x, cls) =>
    '<div class="r ' + (cls||'') + '"><span class="d num">' + fmtShort(x.due_date) + '</span>' +
    '<span class="tag">' + esc(x.kind) + '</span>' +
    '<span class="t">' + esc(x.title) + '</span>' +
    '<span class="v">' + esc(rel(x.due_date)) + '</span>' +
    '<button class="ghost" data-rdone="'+x.reminder_id+'">Done</button>' +
    '<button class="ghost" data-rsnooze="'+x.reminder_id+'">Later</button>' +
    (x.person ? '<span class="x">' + esc(x.person) + (x.detail ? ' \u00b7 ' + esc(x.detail) : '') + '</span>' : '') +
    '</div>';

  const group = (title, list, cls) => list.length
    ? '<section><div class="h"><h2>'+title+'</h2></div><div class="list">' +
      list.map((x) => row(x, cls)).join('') + '</div></section>' : '';

  $('main').innerHTML =
    (next
      ? '<div class="due-hero"><div class="lbl">Next up</div>' +
        '<div class="big">' + esc(next.title) + '</div>' +
        '<div class="when">' + esc(next.person || '') + ' \u00b7 ' + esc(fmt(next.due_date)) +
        ' \u00b7 ' + esc(rel(next.due_date)) + '</div></div>'
      : '<div class="due-hero none"><div class="lbl">Next up</div>' +
        '<div class="big" style="color:var(--ink)">Nothing due</div>' +
        '<div class="when">Follow-ups and medicines running out appear here automatically.</div></div>') +
    group('Overdue', r.overdue, 'bad') +
    group('Today', r.today, '') +
    group('Coming up', r.upcoming, '') +
    '<section><div class="field">' +
      '<button class="ghost" id="addRem">Add a reminder</button>' +
      '<button class="ghost" id="goMeds">Ongoing medicines</button>' +
    '</div></section>';

  $('main').onclick = async (e) => {
    const d = e.target.closest('[data-rdone]'), s2 = e.target.closest('[data-rsnooze]');
    if (d) { await post('/api/core/care/reminders/'+d.dataset.rdone+'/done', {}); bust('/api/core/care'); route(); }
    if (s2) { await post('/api/core/care/reminders/'+s2.dataset.rsnooze+'/snooze', { days: 7 }); bust('/api/core/care'); route(); }
  };
  $('goMeds').onclick = () => go('medicines');
  $('addRem').onclick = () => {
    sheet('<h3>New reminder</h3>' + actions([{ id:'rmSave', label:'Add', kind:'go' }, { id:'closeSheet', label:'Cancel' }]) + '' +
      '<div class="field"><label for="rmTitle">What</label><input type="text" id="rmTitle" placeholder="Repeat lipid profile"></div>' +
      '<div class="field"><label for="rmDate">When</label><input type="date" id="rmDate" value="'+state.account.today+'"></div>' +
      '<div class="field"><label for="rmWho">Whose</label><select id="rmWho">' +
        state.people.map((p) => '<option value="'+p.person_id+'"'+(p.person_id===state.current?' selected':'')+'>'+esc(p.name)+'</option>').join('') +
      '</select></div>' +
      '<div class="field"><label for="rmRepeat">Repeat</label><select id="rmRepeat">' +
        '<option value="0">Once</option><option value="30">Monthly</option>' +
        '<option value="90">Every 3 months</option><option value="180">Every 6 months</option>' +
        '<option value="365">Yearly</option></select></div>' +
      '<div class="status" id="rmStatus"></div>');
    $('rmSave').onclick = async () => {
      try {
        await post('/api/core/care/reminders', { person: $('rmWho').value, title: $('rmTitle').value,
          due_date: $('rmDate').value, repeat_days: Number($('rmRepeat').value) });
        bust('/api/core/care'); closeSheet(); route();
      } catch (err) { setStatus('rmStatus', err.message, 'err'); }
    };
  };
}

async function viewMedicines() {
  const d = await cachedGet('/api/core/care/medicines?person=' + state.current);

  const row = (m, showActions) =>
    '<div class="r"><span class="d num">' + fmtShort(m.prescribed_on) + '</span>' +
    '<span class="t">' + esc([m.name, m.strength].filter(Boolean).join(' ')) + '</span>' +
    '<span class="v">' + esc([m.dose, m.frequency].filter(Boolean).join(' ')) + '</span>' +
    (showActions
      ? '<button class="ghost" data-mstop="'+m.medicine_id+'">Stop</button>' +
        (m.status === 'unknown' ? '<button class="ghost" data-mgo="'+m.medicine_id+'">Still on it</button>' : '')
      : '') +
    '<span class="x">' + (m.end_date ? 'until ' + fmt(m.end_date)
      : m.status === 'unknown' ? 'no end date recorded' : 'continuing') +
      (m.doctor ? ' \u00b7 ' + esc(m.doctor) : '') + '</span></div>';

  const block = (title, list, sub, actions) => list.length
    ? '<section><div class="h"><h2>'+title+'</h2></div>' +
      (sub ? '<div class="sub">'+sub+'</div>' : '') +
      '<div class="list">' + list.map((m) => row(m, actions)).join('') + '</div></section>' : '';

  $('main').innerHTML =
    block('On now', d.active, '', true) +
    block('Unconfirmed', d.unconfirmed,
      'No end date was printed on the prescription, so the app will not claim these are state.current. Confirm or stop each one.', true) +
    block('Finished', d.past, '', false) +
    (!d.active.length && !d.unconfirmed.length && !d.past.length
      ? '<div class="empty">No medicines recorded yet.</div>' : '') +
    '<section><div class="field"><button class="ghost" id="addMed">Add a medicine</button></div></section>';

  $('main').onclick = async (e) => {
    const stop = e.target.closest('[data-mstop]'), keep = e.target.closest('[data-mgo]');
    if (stop) { await post('/api/core/care/medicines/'+stop.dataset.mstop+'/stop', {}); bust('/api/'); route(); }
    if (keep) { await post('/api/core/care/medicines/'+keep.dataset.mgo+'/ongoing', {}); bust('/api/'); route(); }
  };
  $('addMed').onclick = () => {
    sheet('<h3>Add a medicine</h3>' + actions([{ id:'amSave', label:'Add', kind:'go' }, { id:'closeSheet', label:'Cancel' }]) + '<div class="sub">For anything without a prescription on file.</div>' +
      '<div class="field"><label for="amName">Name</label><input type="text" id="amName"></div>' +
      '<div class="field"><label for="amStr">Strength</label><input type="text" id="amStr" placeholder="500 mg"></div>' +
      '<div class="field"><label for="amDose">Dose</label><input type="text" id="amDose" placeholder="1-0-1"></div>' +
      '<div class="field"><label for="amStart">Started</label><input type="date" id="amStart" value="'+state.account.today+'"></div>' +
      '<div class="field"><label for="amEnd">Until</label><input type="date" id="amEnd"></div>' +
      '<label class="opt"><input type="checkbox" id="amOngoing"> Continuing indefinitely</label>' +
      '<div class="status" id="amStatus"></div>');
    $('amSave').onclick = async () => {
      try {
        await post('/api/core/care/medicines', { person: state.current, name: $('amName').value,
          strength: $('amStr').value, dose: $('amDose').value, start_date: $('amStart').value,
          end_date: $('amEnd').value, ongoing: $('amOngoing').checked });
        bust('/api/'); closeSheet(); route();
      } catch (err) { setStatus('amStatus', err.message, 'err'); }
    };
  };
}

/* ================================================================
   4. History
   ================================================================ */

const KINDS = [['all','All'],['test','Tests'],['medicine','Medicines'],['record','Visits'],
  ['document','Documents'],['diagnosis','Diagnoses'],['followup','Follow-ups'],['bill','Bills']];
let kind = 'all', page = 0, query = '';

async function viewHistory() {
  $('main').innerHTML =
    '<section><div class="field"><input type="search" id="q" placeholder="Search records" value="'+esc(query)+'"></div>' +
    '<div class="chips" id="kinds">' + KINDS.map(([k,l]) =>
      '<button data-k="'+k+'" aria-pressed="'+(k===kind)+'">'+l+'</button>').join('') + '</div>' +
    '<div id="rows"><div class="empty">Loading&hellip;</div></div>' +
    '<div class="field" style="margin-top:12px"><button class="ghost" id="more" hidden>Show more</button></div></section>';

  $('kinds').onclick = (e) => {
    const b = e.target.closest('[data-k]');
    if (!b) return;
    kind = b.dataset.k; page = 0;
    [...$('kinds').children].forEach((x) => x.setAttribute('aria-pressed', x.dataset.k === kind));
    loadRows(true);
  };
  let t;
  $('q').oninput = (e) => { clearTimeout(t); t = setTimeout(() => { query = e.target.value.trim(); page = 0; loadRows(true); }, 280); };
  await loadRows(true);
}

async function loadRows(reset) {
  const path = query
    ? '/api/health/search?person=' + state.current + '&q=' + encodeURIComponent(query)
    : '/api/health/timeline?person=' + state.current + '&kind=' + kind + '&page=' + page;
  const data = page === 0 ? await cachedGet(path) : await api(path);
  const items = data.items || [];

  const html = items.map((r) =>
    '<div class="r ' + (r.flag && r.flag!=='active' && r.flag!=='pending' ? 'bad':'') +
    '" data-tap data-ref="'+r.ref_id+'" data-kind="'+r.kind+'">' +
    '<span class="d num">'+fmtShort(r.date)+'</span><span class="tag">'+esc(r.kind)+'</span>' +
    '<span class="t">'+esc(r.title)+'</span><span class="v num">'+esc(r.value||'')+'</span>' +
    (r.detail ? '<span class="x">'+esc(r.detail)+'</span>' : '') + '</div>').join('');

  const box = $('rows');
  if (reset) box.innerHTML = items.length ? '<div class="list">'+html+'</div>' : '<div class="empty">Nothing here yet.</div>';
  else if (box.querySelector('.list')) box.querySelector('.list').insertAdjacentHTML('beforeend', html);

  if ($('more')) { $('more').hidden = !data.hasMore; $('more').onclick = () => { page++; loadRows(false); }; }
  box.onclick = (e) => {
    const r = e.target.closest('[data-ref]');
    if (r) openRecord(r.dataset.kind, r.dataset.ref);
  };
}

async function openRecordEdit(kind, id) {
  // A visit is worth a screen of its own — everything filed from it, in one place.

  try {
    const rec = await api('/api/health/records/' + kind + '/' + id);
    sheet('<h3>Edit</h3>' +
      actions([
        { id:'saveEdit', label:'Save', kind:'go' },
        { id:'closeSheet', label:'Cancel' },
        { id:'delRec', label:'Delete', danger:true, right:true },
      ]) +
      '<div class="sub">Every change is kept with its reason.</div>' +
      rec.fields.map((f) =>
        '<div class="field"><label for="f_'+f.name+'">'+esc(f.label)+'</label>' +
        (f.type === 'textarea'
          ? '<textarea id="f_'+f.name+'">'+esc(f.value)+'</textarea>'
          : '<input type="'+(f.type==='date'?'date':'text')+'" id="f_'+f.name+'" value="'+esc(f.value)+'">') +
        '</div>').join('') +
      '<div class="field"><label for="f_reason">Why</label>' +
      '<input type="text" id="f_reason" placeholder="the lab printed the wrong date"></div>' +
      '<div class="status" id="editStatus"></div>');

    $('saveEdit').onclick = async () => {
      const values = {};
      rec.fields.forEach((f) => { values[f.name] = $('f_'+f.name).value; });
      try {
        await put('/api/health/records/'+kind+'/'+id, { values, reason: $('f_reason').value });
        clearCache(); closeSheet(); route();
      } catch (err) { setStatus('editStatus', err.message, 'err'); }
    };
    $('delRec').onclick = async () => {
      if (!confirm('Delete this? It stays in the audit trail but leaves your records.')) return;
      try { await api('/api/health/records/'+kind+'/'+id, { method:'DELETE' }); clearCache(); closeSheet(); route(); }
      catch (err) { setStatus('editStatus', err.message, 'err'); }
    };
  } catch (err) { alert(err.message); }
}


/* ================================================================
   4b. One visit — everything that came from it
   ================================================================ */

async function viewRecord(p) {
  const d = await cachedGet('/api/health/records/' + p.id);
  const r = d.record;
  $('htitle').textContent = r.record_type || 'Visit';

  const block = (title, rows) => rows
    ? '<section><div class="h"><h2>' + title + '</h2></div><div class="list">' + rows + '</div></section>' : '';

  const docs = d.documents.map((x) =>
    '<div class="r" data-tap data-doc="'+x.document_id+'">' +
    '<span class="tag">' + esc(x.document_type || 'Document') + '</span>' +
    '<span class="t">' + esc(x.file_name) + '</span>' +
    '<span class="v">' + (x.bytes ? Math.round(x.bytes/1024) + ' KB' : '') + '</span>' +
    '<span class="x">Tap to open or edit its details</span></div>').join('');

  const tests = d.tests.map((x) =>
    '<div class="r ' + (x.is_abnormal?'bad':'') + '" data-tap data-trendp="'+esc(x.parameter)+'">' +
    '<span class="t">' + esc(x.parameter) + '</span>' +
    '<span class="v num">' + esc([x.result_text, x.unit_raw].filter(Boolean).join(' ')) + '</span>' +
    (x.ref_range_text ? '<span class="x">ref ' + esc(x.ref_range_text) + '</span>' : '') + '</div>').join('');

  const meds = d.medicines.map((x) =>
    '<div class="r" data-tap data-edit="medicine:'+x.medicine_id+'">' +
    '<span class="t">' + esc([x.name, x.strength].filter(Boolean).join(' ')) + '</span>' +
    '<span class="v">' + esc([x.dose, x.frequency].filter(Boolean).join(' ')) + '</span>' +
    '<span class="x">' + (x.end_date ? 'until ' + fmt(x.end_date) : esc(x.duration_text || x.status)) +
    '</span></div>').join('');

  const bills = d.bills.map((x) =>
    '<div class="r" data-tap data-edit="bill:'+x.bill_id+'">' +
    '<span class="t">' + esc(x.medicine_name || x.item || 'Item') + '</span>' +
    '<span class="v num">' + esc(String(x.bill_total ?? x.line_amount ?? '')) + '</span>' +
    '<span class="x">' + esc([x.vendor, x.payment_status].filter(Boolean).join(' \u00b7 ')) + '</span></div>').join('');

  const dx = d.diagnoses.map((x) =>
    '<div class="r" data-tap data-edit="diagnosis:'+x.diagnosis_id+'">' +
    '<span class="t">' + esc(x.diagnosis) + '</span>' +
    '<span class="v">' + esc(x.status || '') + '</span></div>').join('');

  const fu = d.followUps.map((x) =>
    '<div class="r" data-tap data-edit="followup:'+x.follow_up_id+'">' +
    '<span class="d num">' + fmtShort(x.due_date) + '</span>' +
    '<span class="t">' + esc(x.instruction || x.type) + '</span>' +
    '<span class="v">' + esc(x.status) + '</span></div>').join('');

  $('main').innerHTML =
    '<section><table class="facts">' +
      '<tr><td class="k">Date</td><td>' + esc(fmt(r.event_date)) + '</td></tr>' +
      '<tr><td class="k">Person</td><td>' + esc(r.person) + '</td></tr>' +
      '<tr><td class="k">Type</td><td>' + esc(r.record_type) + '</td></tr>' +
      (r.doctor || r.facility ? '<tr><td class="k">Seen at</td><td>' +
        esc([r.doctor, r.facility].filter(Boolean).join(', ')) + '</td></tr>' : '') +
      '<tr><td class="k">Episode</td><td>' + (r.episode
        ? '<a href="#" data-ep="'+r.care_event_id+'">' + esc(r.episode) + '</a>'
        : 'Not grouped') + '</td></tr>' +
      (r.summary ? '<tr><td class="k">Summary</td><td>' + esc(r.summary) + '</td></tr>' : '') +
    '</table>' +
    '<div class="field" style="margin-top:12px">' +
      '<button class="ghost" id="editVisit">Edit this visit</button></div></section>' +
    block('Documents', docs) +
    block('Results', tests) +
    block('Medicines', meds) +
    block('Diagnoses', dx) +
    block('Follow-ups', fu) +
    block('Bills', bills);

  $('editVisit').onclick = () => openRecordEdit('record', p.id);
  $('main').onclick = (e) => {
    const doc = e.target.closest('[data-doc]');
    const ed = e.target.closest('[data-edit]');
    const tr = e.target.closest('[data-trendp]');
    const ep = e.target.closest('[data-ep]');
    if (doc) return documentSheet(doc.dataset.doc);
    if (ed) { const [k, id] = ed.dataset.edit.split(':'); return openRecordEdit(k, id); }
    if (tr) return go('trend', { parameter: tr.dataset.trendp });
    if (ep) { e.preventDefault(); return go('episodes'); }
  };
}

/**
 * A document's own card: whose, when, which visit, which episode — visible and
 * editable — with the scan one tap away.
 */
async function documentSheet(id) {
  const d = await api('/api/core/documents/' + id);
  sheet('<h3>' + esc(d.document_type || 'Document') + '</h3>' +
    actions([
      { id:'docOpen', label:'Open document', kind:'go' },
      { id:'docEdit', label:'Edit details' },
      { id:'closeSheet', label:'Close', right:true },
    ]) +
    '<table class="facts">' +
      '<tr><td class="k">Person</td><td>' + esc(d.person) + '</td></tr>' +
      '<tr><td class="k">Date</td><td>' + esc(fmt(d.document_date)) + '</td></tr>' +
      '<tr><td class="k">Type</td><td>' + esc(d.document_type || '\u2014') + '</td></tr>' +
      '<tr><td class="k">From</td><td>' + esc(d.provider || '\u2014') + '</td></tr>' +
      '<tr><td class="k">Visit</td><td>' + esc(d.record_summary || d.record_type || '\u2014') + '</td></tr>' +
      '<tr><td class="k">Episode</td><td>' + esc(d.episode || 'Not grouped') + '</td></tr>' +
      '<tr><td class="k">File</td><td style="word-break:break-all">' + esc(d.file_name) + '</td></tr>' +
    '</table>');

  $('docOpen').onclick = () => { location.href = '/api/core/documents/' + id + '/file'; };
  $('docEdit').onclick = () => openRecordEdit('document', id);
}



async function viewEpisodes() {
  const list = await cachedGet('/api/health/events?person=' + state.current);
  $('main').innerHTML =
    '<section><div class="sub">Group an admission, an illness or a course of treatment so its reports, prescriptions and bills sit together. New episodes are created on the Add screen.</div>' +
    (list.length ? '<div class="list">' + list.map((e) =>
      '<div class="r" data-tap data-ev="'+e.care_event_id+'"><span class="d num">'+fmtShort(e.event_date)+'</span>' +
      '<span class="t">'+esc(e.title)+'</span>' +
      '<span class="v">'+e.items+' item'+(e.items===1?'':'s')+'</span>' +
      (e.auto_created ? '<span class="tag">grouped</span>' : '') +
      (e.facility ? '<span class="x">'+esc(e.facility)+'</span>' : '') + '</div>').join('') + '</div>'
      : '<div class="empty">No episodes yet.</div>') + '</section>';
  $('main').onclick = async (e) => {
    const r = e.target.closest('[data-ev]');
    if (!r) return;
    const d = await api('/api/health/events/' + r.dataset.ev);
    sheet('<h3>'+esc(d.event.title)+'</h3><div class="sub">'+esc(fmt(d.event.event_date))+
      (d.event.facility ? ' \u00b7 '+esc(d.event.facility) : '')+'</div>' +
      (d.items.length ? '<div class="list">' + d.items.map((i) =>
        '<div class="r"><span class="d num">'+fmtShort(i.date)+'</span><span class="tag">'+esc(i.kind)+'</span>' +
        '<span class="t">'+esc(i.title)+'</span><span class="v num">'+esc(i.value||'')+'</span></div>').join('') + '</div>'
        : '<div class="empty">Nothing filed under this yet.</div>') +
      '<div class="field" style="margin-top:14px"><button class="ghost" id="closeSheet">Close</button></div>');
  };
}

async function viewSettings() {
  const [profile, aliases] = await Promise.all([
    cachedGet('/api/health/profile?person=' + state.current),
    api('/api/health/records/aliases/list').catch(() => []),
  ]);
  const f = (id, label, value, type) =>
    '<div class="field"><label for="'+id+'">'+label+'</label>' +
    (type === 'textarea' ? '<textarea id="'+id+'">'+esc(value||'')+'</textarea>'
      : '<input type="'+(type||'text')+'" id="'+id+'" value="'+esc(value||'')+'">') + '</div>';

  $('main').innerHTML =
    '<section><div class="h"><h2>'+esc(person().name)+'</h2></div>' +
    '<div class="sub">These appear at the top of the doctor handout.</div><div class="panel">' +
      f('pDob','Date of birth', profile.date_of_birth, 'date') + f('pBlood','Blood group', profile.blood_group) +
      f('pAllergy','Allergies', profile.allergies, 'textarea') +
      f('pChronic','Conditions', profile.chronic_conditions, 'textarea') +
      f('pDocs','Regular doctors', profile.regular_doctors) +
      f('pEmerg','Emergency contact', profile.emergency_contact) + f('pIns','Insurance', profile.insurance) +
      '<div class="field"><label></label><button class="go" id="pSave">Save</button></div>' +
      '<div class="status" id="pStatus"></div></div></section>' +

    '<section><div class="h"><h2>Take everything with you</h2></div>' +
    '<div class="sub">Built fresh each time, never stored. Nothing here locks you in.</div>' +
    '<div class="field"><button class="ghost" id="dlX">Spreadsheet</button>' +
    '<button class="ghost" id="dlZ">All scans</button></div>' +
    '<div class="status" id="dlStatus"></div></section>' +

    '<section><div class="h"><h2>Test names learned</h2></div>' +
    '<div class="sub">Labs print the same test many ways. Correct a mapping and every result using it updates.</div>' +
    (aliases.length ? '<div class="list">' + aliases.map((a) =>
      '<div class="r" data-tap data-alias="'+esc(a.alias_key)+'"><span class="t">'+esc(a.original)+'</span>' +
      '<span class="v">\u2192 '+esc(a.parameter)+'</span>' +
      '<span class="tag">'+a.uses+'</span></div>').join('') + '</div>'
      : '<div class="empty">Nothing learned yet.</div>') + '</section>';

  $('pSave').onclick = async () => {
    try {
      await put('/api/health/profile', { person_id: state.current, date_of_birth: $('pDob').value,
        blood_group: $('pBlood').value, allergies: $('pAllergy').value,
        chronic_conditions: $('pChronic').value, regular_doctors: $('pDocs').value,
        emergency_contact: $('pEmerg').value, insurance: $('pIns').value });
      bust('/api/'); setStatus('pStatus', 'Saved.', 'ok');
    } catch (err) { setStatus('pStatus', err.message, 'err'); }
  };
  $('dlX').onclick = (e) => download('/api/health/export/workbook', e.target, 'dlStatus');
  $('dlZ').onclick = (e) => download('/api/health/export/documents', e.target, 'dlStatus');
  $('main').onclick = (e) => {
    const a = e.target.closest('[data-alias]');
    if (!a) return;
    const original = a.querySelector('.t').textContent;
    const name = a.querySelector('.v').textContent.replace('\u2192 ','');
    sheet('<h3>Standard name</h3>' + actions([{ id:'aSave', label:'Save', kind:'go' }, { id:'closeSheet', label:'Cancel' }]) + '<div class="sub">Printed on the report as \u201c'+esc(original)+'\u201d</div>' +
      '<div class="field"><label for="aName">Standard</label><input type="text" id="aName" value="'+esc(name)+'"></div>' +
      '<div class="field"><label for="aUnit">Usual unit</label><input type="text" id="aUnit"></div>' +
      '<div class="status" id="aStatus"></div>');
    $('aSave').onclick = async () => {
      try {
        await put('/api/health/records/aliases/'+encodeURIComponent(a.dataset.alias),
          { parameter: $('aName').value, unit: $('aUnit').value });
        clearCache(); closeSheet(); route();
      } catch (err) { setStatus('aStatus', err.message, 'err'); }
    };
  };
}

/* ---------- the manifest the shell reads ---------- */

export default {
  id: 'health',
  name: 'Family Health Records',
  home: 'upload',
  tabs: [
    ['upload',    'Add',      'M12 5v14M5 12h14'],
    ['review',    'Review',   'M9 11l3 3 7-7M20 12v6a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h9'],
    ['overview',  'Overview', 'M4 12h5l2 6 3-13 2 7h4'],
    ['tests',     'Tests',    'M4 19h16M7 19V9M12 19V5M17 19v-7'],
    ['history',   'History',  'M4 6h16M4 12h16M4 18h10'],
  ],
  screens: {
    upload:    { title:'Add a report',      tab:'upload',   render: viewUpload },
    overview:  { title:'Overview',          tab:'overview', render: viewOverview },
    tests:     { title:'Tests',             tab:'tests',    render: viewPanels },
    panel:     { title:'Panel',             tab:'tests',    render: viewPanel,     deep:true },
    trend:     { title:'Trend',             tab:'tests',    render: viewTrend,     deep:true },
    due:       { title:'Due',               tab:'overview', render: viewDue,       deep:true },
    review:    { title:'Review',            tab:'review',   render: viewReview },
    medicines: { title:'Medicines',         tab:'overview', render: viewMedicines, deep:true },
    history:   { title:'History',           tab:'history',  render: viewHistory },
    record:    { title:'Visit',             tab:'history',  render: viewRecord,    deep:true },
    episodes:  { title:'Episodes of care',  tab:'overview', render: viewEpisodes,  deep:true },
    settings:  { title:'Details & exports', tab:'overview', render: viewSettings,  deep:true },
  },
};


/** Where a tapped row goes: visits get a screen, documents a card, the rest an edit. */
function openRecord(kind, id) {
  if (kind === 'record') return go('record', { id });
  if (kind === 'document') return documentSheet(id);
  return openRecordEdit(kind, id);
}
