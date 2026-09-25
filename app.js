'use strict';

// Where the data and the page scans come from. The live server injects nothing
// and the defaults apply; the static GitHub Pages build ships a config.js that
// points `data` at committed JSON and `images` at the VPS. One client, two
// deployments, so the read-only site cannot drift from the editing app.
const CFG = Object.assign({
  api: '/api',        // null on the public site: nothing is POSTed anywhere
  data: null,         // directory of committed notices.json / corrections.json
  images: null,       // base URL of the page scans; null = this server
  propose: null,      // "owner/repo": edits become a prefilled GitHub issue
  live: null,         // raw URL of the data repo's corrections.json
  readOnly: false,
}, window.RVW || {});

// GitHub answers the question we were about to build accounts for. A visitor
// edits, and we hand them a prefilled issue against the data repo: GitHub makes
// them sign in or sign up, signs the submission with their identity, and an
// Action turns the issue into a commit. No user table, no session, no token in
// this file - and the audit trail is better than one we would have written.
const PROPOSE_KEY = 'pending.corrections';
let PENDING = {};
try { PENDING = JSON.parse(localStorage.getItem(PROPOSE_KEY) || '{}'); } catch (_) { PENDING = {}; }
const savePending = () => {
  try { localStorage.setItem(PROPOSE_KEY, JSON.stringify(PENDING)); } catch (_) {}
};

// Page scans are laid out per volume on the VPS: <base>/vol3/CatInsc_3_000097.jpg
//
// Always the FULL scan, never a downscaled copy. The crop is cut from this same
// image in the browser, so asking for a 900px copy of a 5400px volume-3 page
// delivered every facsimile at 17% of its real resolution - illegible, and the
// whole point is reading the letters. The original is one cached request that
// serves both the page viewer and the crop, and it needs no re-encoding.
const pageURL = pid => {
  if (!CFG.images) return `/page/${encodeURIComponent(pid)}.jpg`;
  const m = /^CatInsc_(\d+)_/.exec(pid);
  return `${CFG.images}/vol${m ? m[1] : '0'}/${encodeURIComponent(pid)}.jpg`;
};

// ---------------------------------------------------------------- state
let NOTICES = [], CORR = {}, VIEW = [], SEL = null, VOL = '';
let sortKey = 'volume', sortAsc = true, page = 0;
const PAGE_SIZE = 150;
const EDITABLE = ['monument', 'reference', 'description', 'transcription',
                  'nb_lignes', 'note', 'page', 'numero'];

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Effective value: the human correction when one exists, the machine value
// otherwise. The machine value is never overwritten, only shadowed.
const eff = (n, k) => {
  const p = PENDING[n.id];
  if (p && p.fields && k in p.fields) return p.fields[k];
  const c = CORR[n.id];
  return (c && c.fields && k in c.fields) ? c.fields[k] : (n[k] ?? '');
};
const isEdited = (n, k) => {
  const p = PENDING[n.id];
  if (p && p.fields && k in p.fields) return p.fields[k] !== (n[k] ?? '');
  const c = CORR[n.id];
  return !!(c && c.fields && k in c.fields && c.fields[k] !== (n[k] ?? ''));
};
const anyEdit = n => EDITABLE.some(k => isEdited(n, k));
// Must consult PENDING exactly as cropStatusOf does. Reading only the published
// data meant a reviewer clicked "Reviewed", the change was staged correctly, and
// the control snapped back - the state was right and the button lied about it.
const reviewOf = n => (PENDING[n.id] && PENDING[n.id].review_status)
  || (CORR[n.id] && CORR[n.id].review_status) || 'unreviewed';
const cropStatusOf = n => (PENDING[n.id] && PENDING[n.id].crop_status)
  || (CORR[n.id] && CORR[n.id].crop_status) || 'unreviewed';
const humanCrop = n => (PENDING[n.id] && PENDING[n.id].crop !== undefined
  ? PENDING[n.id].crop : (CORR[n.id] && CORR[n.id].crop)) || null;
// The box actually used: the human's when they adjusted one, else YOLO's pair.
// "Wrong" means there is no usable box here, so fall back to nothing rather
// than to the detector - otherwise rejecting a box silently reinstates it.
const effCrop = n => {
  const hc = humanCrop(n);
  if (hc) return hc;
  if (cropStatusOf(n) === 'rejected') return null;
  return n.yolo_box ? { page: n.pages[0], box: n.yolo_box.box } : null;
};
const cropState = n => humanCrop(n) ? 'human'
  : cropStatusOf(n) === 'rejected' ? 'none' : n.yolo_pairing;

const UNBAL = t => {
  const c = ch => (t.split(ch).length - 1);
  return c('⎡') !== c('⎤') || c('⎣') !== c('⎦') || c('[') !== c(']');
};
const HAS_NOTATION = t => /[⎡⎣\[]/.test(t) || t.includes('...') || t.includes('/');
const REQUIRED = ['monument', 'description', 'transcription', 'nb_lignes'];

// ---------------------------------------------------------------- load
async function load() {
  const d = CFG.api
    ? await (await fetch(CFG.api + '/notices')).json()
    : { notices: await (await fetch(`${CFG.data}/notices.json`)).json(),
        corrections: await (await fetch(`${CFG.data}/corrections.json`)).json() };
  NOTICES = d.notices; CORR = d.corrections || {};

  // Corrections come from the data repository itself, not from the copy that
  // shipped with this page, so one applied minutes ago is already here.
  const live = await fetchCorrections({ fresh: Object.keys(PENDING).length > 0 });
  if (live) CORR = live;
  reconcilePending();
  if (CFG.readOnly) document.body.classList.add('readonly');
  if (CFG.propose) document.body.classList.add('propose');
  // Two deployments of the same interface differ only in where an edit goes,
  // which is invisible until you wonder why a button is missing. Say it.
  const mode = $('#mode');
  if (CFG.propose) {
    mode.className = 'mode-github';
    mode.textContent = 'proposes to GitHub';
    mode.title = `Edits are held in this browser until you send them to ${CFG.propose} as an issue.`;
  } else {
    mode.className = 'mode-local';
    mode.textContent = 'local';
    mode.title = 'Edits save straight to corrections.jsonl on this computer. '
               + 'They do not reach GitHub from here.';
  }
  const vols = [...new Set(NOTICES.map(n => n.volume))].sort((a, b) => a - b);
  $('#vols').innerHTML = '<button data-v="" class="on">All</button>' +
    vols.map(v => `<button data-v="${esc(v)}">${esc(v)}</button>`).join('');
  $('#vols').querySelectorAll('button').forEach(b => b.onclick = () => {
    VOL = b.dataset.v; page = 0;
    $('#vols').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    apply();
  });
  renderHome();
  apply();
  renderBanner();
  if (Object.values(PENDING).some(p => p.proposed_at)) startPolling();
}

// ---------------------------------------------------------------- overview
// The first screen answers what you arrive wanting to know - how much is
// extracted, how much is checked, where the damage is - and is the way in.
const stats = rows => {
  const s = { n: rows.length, pages: new Set(), reviewed: 0, attention: 0, edited: 0,
              noTr: 0, unbal: 0, ambiguous: 0, noDet: 0 };
  for (const r of rows) {
    r.pages.forEach(p => s.pages.add(p));
    const rv = reviewOf(r);
    if (rv === 'reviewed') s.reviewed++;
    if (rv === 'needs_attention') s.attention++;
    if (anyEdit(r)) s.edited++;
    if (!eff(r, 'transcription').trim()) s.noTr++;
    if (UNBAL(eff(r, 'transcription'))) s.unbal++;
    const cs = cropState(r);
    if (cs === 'ambiguous') s.ambiguous++;
    if (cs === 'none') s.noDet++;
  }
  return s;
};

const bar = s => `<div class="progress">
  <i class="p-rev" style="width:${100 * s.reviewed / (s.n || 1)}%"></i>
  <i class="p-att" style="width:${100 * s.attention / (s.n || 1)}%"></i></div>`;

function renderHome() {
  const all = stats(NOTICES);
  const vols = [...new Set(NOTICES.map(n => n.volume))].sort((a, b) => a - b);
  const done = all.reviewed + all.attention;

  $('#hero-sub').innerHTML = `<b>${all.n}</b> inscription notices extracted from
    <b>${vols.length}</b> catalogue volumes, over <b>${all.pages.size}</b> scanned pages.
    The extraction is partial and still being improved - this is where it gets checked
    against the printed page.`;
  $('#hero-bar').innerHTML = bar(all).replace(/^<div class="progress">|<\/div>$/g, '');
  $('#hero-key').innerHTML = `
    <span><em style="background:var(--ok)"></em><b>${all.reviewed}</b> reviewed</span>
    <span><em style="background:var(--warn)"></em><b>${all.attention}</b> need attention</span>
    <span><em style="background:#eae7e0"></em><b>${all.n - done}</b> untouched</span>
    <span><b>${all.edited}</b> notices carry a human edit</span>`;

  $('#vol-cards').innerHTML = vols.map(v => {
    const s = stats(NOTICES.filter(n => n.volume === v));
    return `<button class="vcard" data-vol="${esc(v)}">
      <div class="vn"><b>${esc(v)}</b><span>Volume</span></div>
      <div class="cnt">${s.n} notices &middot; ${s.pages.size} pages</div>
      ${bar(s)}
      <div class="vstats">
        <span><span>reviewed</span><b>${s.reviewed + s.attention} / ${s.n}</b></span>
        <span class="${s.noTr ? 'hot' : ''}"><span>no transcription</span><b>${s.noTr}</b></span>
        <span class="${s.unbal ? 'hot' : ''}"><span>unbalanced brackets</span><b>${s.unbal}</b></span>
      </div></button>`;
  }).join('');

  // Crop pairing is deliberately absent here. It is a property of the page, not
  // a fault in the extraction, and putting it on the front page made it look
  // like 712 records were broken. It stays available under the Show: dropdown.
  const queues = [
    ['unbalanced', all.unbal, 'Unbalanced brackets', 'an opening mark with no match', 'hot'],
    ['no_transcription', all.noTr, 'No transcription', 'the model returned nothing to check', 'hot'],
    ['missing_fields', NOTICES.filter(n => !REQUIRED.every(k => eff(n, k).trim())).length,
     'Missing fields', 'monument, description, lines or text absent', 'warm'],
    ['edited', all.edited, 'Already edited', 'notices a human has changed', ''],
  ];
  $('#queues').innerHTML = queues.map(([k, n, label, sub, cls]) =>
    `<button class="qcard ${cls}" data-queue="${k}">
       <span class="qn">${n}</span>
       <span class="ql">${label}<i>${sub}</i></span></button>`).join('');

  $('#home-foot').textContent =
    'Machine values are never overwritten: a correction is stored beside the extraction, ' +
    'and every field can be reverted to what the model produced.';

  $('#vol-cards').querySelectorAll('[data-vol]').forEach(b =>
    b.onclick = () => enterWork({ vol: b.dataset.vol }));
  $('#queues').querySelectorAll('[data-queue]').forEach(b =>
    b.onclick = () => enterWork({ issue: b.dataset.queue }));
}

function enterWork({ vol = '', issue = '' } = {}) {
  VOL = vol; page = 0;
  $('#fissue').value = issue; $('#fstatus').value = ''; $('#q').value = '';
  $('#vols').querySelectorAll('button').forEach(x => x.classList.toggle('on', x.dataset.v === vol));
  document.body.classList.add('working');
  apply();
}

function goHome() {
  document.body.classList.remove('working');
  SEL = null;
  $('#empty').hidden = false; $('#work').hidden = true;
  renderHome();
}
$('#home-btn').onclick = goHome;

// ---------------------------------------------------------------- filter
function apply() {
  const q = $('#q').value.trim().toLowerCase();
  const st = $('#fstatus').value, iss = $('#fissue').value;

  VIEW = NOTICES.filter(n => {
    if (VOL && n.volume !== VOL) return false;
    if (st && reviewOf(n) !== st) return false;
    if (iss) {
      const t = eff(n, 'transcription');
      if (iss.startsWith('crop_')) { if (cropState(n) !== iss.slice(5)) return false; }
      else if (iss === 'edited' && !anyEdit(n)) return false;
      else if (iss === 'no_transcription' && t.trim()) return false;
      else if (iss === 'missing_fields' && REQUIRED.every(k => eff(n, k).trim())) return false;
      else if (iss === 'unbalanced' && !UNBAL(t)) return false;
      else if (iss === 'notation' && !HAS_NOTATION(t)) return false;
    }
    if (q) {
      const hay = [eff(n, 'monument'), eff(n, 'transcription'), eff(n, 'description'),
                   eff(n, 'reference'), eff(n, 'note'), n.id].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const num = v => { const f = parseFloat(v); return isNaN(f) ? Infinity : f; };
  // The reference column orders by the catalogue itself: volume, then PRINTED
  // page, then number. Ordering by number alone interleaves pages, because the
  // same number recurs whenever the extraction misreads a numbered list.
  const ref = n => [num(n.volume), num(eff(n, 'page')), num(eff(n, 'numero'))];
  VIEW.sort((a, b) => {
    let c;
    if (sortKey === 'volume') {
      const x = ref(a), y = ref(b);
      c = x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
    } else if (sortKey === 'nb_lignes') {
      c = num(eff(a, sortKey)) - num(eff(b, sortKey));
    } else {
      c = String(eff(a, sortKey)).localeCompare(String(eff(b, sortKey)), 'hy');
    }
    if (!c) { const x = ref(a), y = ref(b); c = x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; }
    return sortAsc ? c : -c;
  });
  if (page * PAGE_SIZE >= VIEW.length) page = 0;
  render();
}

// ---------------------------------------------------------------- table
// A mark has to earn its column. "Missing field" fired on 27% of rows and said
// nothing the row did not already show ("no transcription", "no monument"), and
// crop pairing fired on 38% - that is texture, not an exception. What is left is
// rare and names itself, so the page needs no legend to decode it.
function flags(n) {
  const out = [];
  if (UNBAL(eff(n, 'transcription')))
    out.push('<b class="tag t-bad" title="an opening bracket has no match - the extraction cut or invented one">brackets</b>');
  if (anyEdit(n)) out.push('<b class="tag t-human" title="a human changed at least one field">edited</b>');
  return out.join('');
}

function render() {
  const start = page * PAGE_SIZE, slice = VIEW.slice(start, start + PAGE_SIZE);
  // Transcription and line count used to sit here too. They are both on the
  // right the moment a row is selected, so in the list they were the same
  // information twice - and they crowded out the identifiers you scan by.
  $('#rows').innerHTML = slice.map(n => {
    const mon = eff(n, 'monument');
    return `<tr data-id="${esc(n.id)}" class="st-${reviewOf(n)}${n.id === SEL ? ' sel' : ''}">
      <td><div class="ref"><b>${esc(eff(n, 'numero'))}</b><br>
        <span>v${esc(n.volume)} &middot; p.${esc(eff(n, 'page'))}</span></div></td>
      <td>${mon ? `<div class="mon">${esc(mon)}</div>` : '<span class="void">no monument</span>'}
          ${eff(n, 'transcription').trim() ? '' : '<div class="void">no transcription</div>'}</td>
      <td class="fl">${flags(n)}</td>
    </tr>`;
  }).join('');

  $('#count').textContent = VIEW.length === NOTICES.length
    ? `${NOTICES.length} notices` : `${VIEW.length} of ${NOTICES.length}`;

  const pages = Math.max(1, Math.ceil(VIEW.length / PAGE_SIZE));
  $('#pager').innerHTML = `<button ${page === 0 ? 'disabled' : ''} id="prev">&larr; Previous</button>
     <span>${VIEW.length ? start + 1 : 0}&ndash;${Math.min(start + PAGE_SIZE, VIEW.length)} of ${VIEW.length}</span>
     <button ${page >= pages - 1 ? 'disabled' : ''} id="next">Next &rarr;</button>`;
  $('#prev') && ($('#prev').onclick = () => { page--; render(); $('#scroll').scrollTop = 0; });
  $('#next') && ($('#next').onclick = () => { page++; render(); $('#scroll').scrollTop = 0; });

  document.querySelectorAll('thead th[data-sort]').forEach(th => {
    th.classList.toggle('sorted', th.dataset.sort === sortKey);
    th.querySelector('.caret').innerHTML = sortAsc ? '&#9650;' : '&#9660;';
  });
}

// ---------------------------------------------------------------- notation
// Wraps the editor's marks in spans WITHOUT altering a single character.
// Tags are inserted as sentinels first and turned into HTML only at the end:
// a "/" line-boundary mark is highlighted too, and replacing it directly would
// chew through the "/" in every "</span>" already emitted.
const SENT = {
  'n-rest': ['', ''], 'n-err': ['', ''],
  'n-ext': ['', ''], 'n-dot': ['', ''],
  'n-slash': ['', '']
};
function markup(t) {
  const w = (cls, m) => SENT[cls][0] + m + SENT[cls][1];
  let h = esc(t);
  h = h.replace(/⎡[\s\S]*?⎤/g, m => w('n-rest', m));
  h = h.replace(/⎣[\s\S]*?⎦/g, m => w('n-err', m));
  h = h.replace(/\[[^\[\]]*?\]/g, m => w('n-ext', m));
  h = h.replace(/\.{2,}/g, m => w('n-dot', m));
  h = h.replace(/\//g, m => w('n-slash', m));
  for (const [cls, [o, c]] of Object.entries(SENT))
    h = h.split(o).join(`<span class="${cls}">`).split(c).join('</span>');
  return h;
}

// ---------------------------------------------------------------- detail
const seg = (attr, opts, cur) => `<div class="grp">${opts.map(([v, lbl]) =>
  `<button data-${attr}="${v}" class="${cur === v ? 'on' : ''}">${lbl}</button>`).join('')}</div>`;

function select(id) {
  SEL = id; render();
  const n = NOTICES.find(x => x.id === id);
  if (!n) return;
  $('#empty').hidden = true; $('#work').hidden = false;

  $('#dtop').innerHTML = `
    <div class="dhead">
      <div class="id">${esc(n.id)}</div>
      <h2>${eff(n, 'monument') ? esc(eff(n, 'monument'))
            : '<span style="color:var(--mut);font-family:var(--ui);font-size:15px">no monument extracted</span>'}</h2>
      <div class="meta">volume ${esc(n.volume)} &nbsp;&middot;&nbsp; page ${esc(eff(n, 'page'))}
        &nbsp;&middot;&nbsp; &#8470; ${esc(eff(n, 'numero'))} &nbsp;&middot;&nbsp; ${esc(n.source_csv)}</div>
    </div>
    <div class="bar">
      <div class="seg"><label>Review</label>${seg('rev',
        [['unreviewed', 'Unreviewed'], ['reviewed', 'Reviewed'], ['needs_attention', 'Needs attention']],
        reviewOf(n))}</div>
      <div class="seg"><label>Crop</label>${seg('crop',
        [['unreviewed', '&mdash;'], ['accepted', 'Correct'], ['corrected', 'Fixed'], ['rejected', 'Wrong']],
        cropStatusOf(n))}</div>
      <span class="saved" id="saved">Saved</span>
    </div>`;

  $('#pane-text').innerHTML = `
    <div class="card">
      <h3>Transcription</h3>
      <div class="tr-view">${eff(n, 'transcription') ? markup(eff(n, 'transcription'))
        : '<span class="void">the extraction produced no transcription</span>'}</div>
      <div class="legend">
        <span class="n-rest">&#9121; &#9124; restoration</span>
        <span class="n-err">&#9123; &#9126; error / omission</span>
        <span class="n-ext">[ ] extraneous</span>
        <span class="n-dot">... broken</span>
        <span class="n-slash">/ line boundary</span>
      </div>
    </div>
    <div class="card"><h3>Fields</h3><div id="fields"></div></div>`;

  renderBanner();
  renderFields(n);
  renderPage(n, PV.pid && n.pages.includes(PV.pid) ? PV.pid : n.pages[0]);

  $('#dtop').querySelectorAll('[data-rev]').forEach(b =>
    b.onclick = () => save(n.id, { review_status: b.dataset.rev }));
  $('#dtop').querySelectorAll('[data-crop]').forEach(b =>
    b.onclick = () => save(n.id, { crop_status: b.dataset.crop }));
}

function renderFields(n) {
  $('#fields').innerHTML = EDITABLE.map(k => {
    const v = eff(n, k), dirty = isEdited(n, k);
    const big = ['transcription', 'description', 'reference', 'note'].includes(k);
    const rows = k === 'transcription' ? 8 : k === 'description' ? 3 : 2;
    return `<div class="fld ${dirty ? 'dirty' : ''}" data-k="${k}">
      <label>${k.replace('_', ' ')}
        ${dirty ? '<button class="rev">revert to model</button>' : ''}
        ${!v.trim() ? '<span class="empty-note">not extracted</span>' : ''}</label>
      ${big ? `<textarea rows="${rows}">${esc(v)}</textarea>` : `<input value="${esc(v)}">`}
      <div class="orig">model: ${esc(n[k] ?? '')}</div>
    </div>`;
  }).join('');
  $('#fields').querySelectorAll('.fld').forEach(d => {
    const k = d.dataset.k, el = d.querySelector('textarea,input');
    el.onchange = () => save(n.id, { fields: { [k]: el.value === (n[k] ?? '') ? null : el.value } });
    const rev = d.querySelector('.rev');
    if (rev) rev.onclick = () => save(n.id, { fields: { [k]: null } });
  });
}

const PAIRING_HELP = {
  auto: 'the page had as many drawings as notices, so they were paired in reading order',
  ambiguous: 'the counts did not match, so no box was assumed - pick one yourself',
  none: 'the detector found no drawing on this page',
};

// ------------------------------------------------- page viewer, in the pane
// Zoom that covers the transcription is useless: proofreading is a comparison.
// So the page scales inside its own pane and scrolls, next to the text. The
// view state survives the re-render that follows every save, so adjusting a box
// does not throw away your zoom and scroll position.
let PV = { pid: null, zoom: 'width', sl: 0, st: 0, scale: 1, off: null };

function renderPage(n, pid) {
  const geo = n.page_geometry[pid];
  if (PV.pid !== pid) Object.assign(PV, { pid, zoom: 'width', sl: 0, st: 0, scale: 1 });

  if (!geo) {
    $('#pane-page').innerHTML = `<div class="nocrop">no page image for ${esc(pid || '-')}</div>`;
    return;
  }
  const hc = humanCrop(n), ec = effCrop(n);
  const tabs = n.pages.length > 1
    ? `<div class="pagetabs">${n.pages.map(p =>
        `<button data-pg="${esc(p)}" class="${p === pid ? 'on' : ''}">${esc(p)}</button>`).join('')}</div>` : '';

  const yolo = (pid === n.pages[0] ? n.yolo_boxes : []);
  const isEff = b => ec && ec.page === pid && ec.box.join() === b.join();
  const pcBox = b => `left:${100 * b[0] / geo.width}%;top:${100 * b[1] / geo.height}%;` +
                     `width:${100 * (b[2] - b[0]) / geo.width}%;height:${100 * (b[3] - b[1]) / geo.height}%`;

  $('#pane-page').innerHTML = `
    <div class="pagecard">
      <div class="pvtools">
        <h3>Catalogue page</h3>
        <div class="zoom" id="zoom">
          <button data-z="fit">Fit</button><button data-z="width">Width</button>
          <button data-z="1">100%</button><button data-z="2">200%</button>
        </div>
        <span class="zpct" id="zpct" title="pinch on the trackpad, or hold Ctrl and scroll"></span>
        ${tabs}
        <a class="vopen" href="${pageURL(pid)}" target="_blank" rel="noopener">original &#8599;</a>
      </div>
      <div class="pageview" id="pv"><div class="stage" id="stage">
        <img src="${pageURL(pid)}" alt="${esc(pid)}" draggable="false">
        ${yolo.filter(b => !isEff(b.box)).map(b =>
          `<div class="bx" data-box="${b.box.join(',')}" style="${pcBox(b.box)}"
             title="detector confidence ${b.conf} - click to use this box"><label>${b.conf}</label></div>`).join('')}
        ${ec && ec.page === pid ? `<div class="bx edit" id="ebox" style="${pcBox(ec.box)}">
            <label title="${hc ? 'you set this box; the detector\'s own is kept and can be restored'
                                    : 'the detector\'s box - drag a handle to adjust it'}">${hc ? 'yours' : 'detector'}</label>
            ${['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map(h =>
              `<span class="hd" data-h="${h}"></span>`).join('')}
          </div>` : ''}
      </div></div>
      <div class="pvmeta">
        <span>${esc(pid)}</span>
        <span>${geo.width}&times;${geo.height} px</span>
        <span title="facsimile drawings the detector found on this page">${yolo.length} detection(s)</span>
        <span title="${PAIRING_HELP[n.yolo_pairing] || ''}">pairing <b>${esc(n.yolo_pairing)}</b></span>
        <span>drag a handle to adjust &middot; <kbd>Shift</kbd>+drag for a new box
          ${ec ? '&middot; <kbd>Delete</kbd> to remove it' : ''}</span>
        ${ec ? `<button id="crop-remove" title="this notice has no facsimile on the page, or the box is on the wrong thing">remove this box</button>` : ''}
        ${hc ? '<button id="draw-clear">back to the detector\'s box</button>' : ''}
        ${!ec && cropStatusOf(n) === 'rejected' && yolo.length
          ? '<button id="crop-restore">show the detector\'s boxes again</button>' : ''}
      </div>
      ${ec ? cropStrip(n, ec) : ''}
      ${!ec ? `<div class="nocrop">${
          cropStatusOf(n) === 'rejected'
            ? 'you marked this notice as having no usable box'
            : yolo.length
              ? 'this page has detections but none is paired with this notice - click one'
              : 'the detector found no drawing on this page'}</div>` : ''}
    </div>`;

  wirePage(n, pid, geo);
}

// A crop is coordinates, so the browser cuts it out of the page scan with CSS.
// Nothing is generated, stored or re-generated: correcting a box re-crops
// instantly, and the static site needs no image service at all.
function cropStrip(n, ec) {
  const g = n.page_geometry[ec.page];
  if (!g) return '';
  const [x1, y1, x2, y2] = ec.box;
  const cw = x2 - x1, ch = y2 - y1;
  return `<div class="cropstrip">
    <div class="cropwin" style="aspect-ratio:${cw} / ${ch}">
      <img src="${pageURL(ec.page)}" alt="crop of ${esc(ec.page)}"
           style="width:${100 * g.width / cw}%;left:${-100 * x1 / cw}%;top:${-100 * y1 / ch}%">
    </div>
    <a href="${pageURL(ec.page)}" target="_blank" rel="noopener"
       title="open the full page scan">${cw}&times;${ch} px &#8599;</a></div>`;
}

function wirePage(n, pid, geo) {
  const pv = $('#pv'), stage = $('#stage');

  // Zoom: the four presets, plus pinch on the trackpad. macOS reports a pinch
  // as a wheel event with ctrlKey, so that is what we listen for - and we must
  // preventDefault or the browser zooms its own chrome instead.
  const fitScale = () => Math.min((pv.clientWidth - 20) / geo.width,
                                  (pv.clientHeight - 20) / geo.height);
  const widthScale = () => (pv.clientWidth - 20) / geo.width;

  const paintScale = () => {
    stage.style.width = Math.round(geo.width * PV.scale) + 'px';
    $('#zoom').querySelectorAll('button').forEach(b =>
      b.classList.toggle('on', b.dataset.z === String(PV.zoom)));
    $('#zpct').textContent = Math.round(PV.scale * 100) + '%';
  };

  const setZoom = z => {
    PV.zoom = z;
    PV.scale = z === 'fit' ? fitScale() : z === 'width' ? widthScale() : parseFloat(z);
    paintScale();
  };

  // Scale about the point under the cursor, so the page does not slide away
  // from whatever you were reading.
  const zoomAt = (scale, cx, cy) => {
    const r0 = stage.getBoundingClientRect();
    const fx = (cx - r0.left) / r0.width, fy = (cy - r0.top) / r0.height;
    PV.zoom = 'custom';
    PV.scale = clamp(scale, 0.04, 6);
    paintScale();
    const r1 = stage.getBoundingClientRect();
    pv.scrollLeft += (r1.left + fx * r1.width) - cx;
    pv.scrollTop += (r1.top + fy * r1.height) - cy;
  };

  if (PV.zoom === 'custom') paintScale(); else setZoom(PV.zoom);
  pv.scrollLeft = PV.sl; pv.scrollTop = PV.st;
  pv.onscroll = () => { PV.sl = pv.scrollLeft; PV.st = pv.scrollTop; };
  $('#zoom').querySelectorAll('button').forEach(b => b.onclick = () => setZoom(b.dataset.z));

  // The pane has no width yet on the first frame after the detail is revealed,
  // so a Fit/Width computed now comes out tiny. Recompute whenever the pane
  // actually resizes - which also covers splitter drags and window resizes.
  if (window.ResizeObserver) {
    const ro = new ResizeObserver(() => {
      if (PV.zoom === 'fit' || PV.zoom === 'width') setZoom(PV.zoom);
    });
    ro.observe(pv);
    if (PV.ro) PV.ro.disconnect();
    PV.ro = ro;
  }

  pv.addEventListener('wheel', e => {
    if (!e.ctrlKey && !e.metaKey) return;      // plain two-finger scroll still pans
    e.preventDefault();
    zoomAt(PV.scale * Math.exp(-e.deltaY / 180), e.clientX, e.clientY);
  }, { passive: false });

  $('#pane-page').querySelectorAll('[data-pg]').forEach(b =>
    b.onclick = () => { PV.pid = null; renderPage(n, b.dataset.pg); });
  const clear = $('#draw-clear');
  if (clear) clear.onclick = () => save(n.id, { crop: null, crop_status: 'unreviewed' });
  const rm = $('#crop-remove');
  if (rm) rm.onclick = () => save(n.id, { crop: null, crop_status: 'rejected' });
  const re = $('#crop-restore');
  if (re) re.onclick = () => save(n.id, { crop: null, crop_status: 'unreviewed' });

  // Clicking one of the detector's other boxes adopts it for this notice.
  stage.querySelectorAll('.bx[data-box]').forEach(b => b.onclick = e => {
    e.stopPropagation();
    save(n.id, { crop: { page: pid, box: b.dataset.box.split(',').map(Number) },
                 crop_status: 'accepted' });
  });

  // ---- pan / move / resize / draw, all decided at mousedown ----
  const ebox = $('#ebox');
  const toPage = e => {
    const r = stage.getBoundingClientRect();
    return [(e.clientX - r.left) / PV.scale, (e.clientY - r.top) / PV.scale];
  };
  const paint = (el, b) => Object.assign(el.style, {
    left: 100 * b[0] / geo.width + '%', top: 100 * b[1] / geo.height + '%',
    width: 100 * (b[2] - b[0]) / geo.width + '%', height: 100 * (b[3] - b[1]) / geo.height + '%'
  });
  const boxOf = el => [el.offsetLeft / PV.scale, el.offsetTop / PV.scale,
                       (el.offsetLeft + el.offsetWidth) / PV.scale,
                       (el.offsetTop + el.offsetHeight) / PV.scale].map(Math.round);

  let mode = null, start = null, box0 = null, live = null, ghost = null, pan0 = null;

  pv.onmousedown = e => {
    if (e.button !== 0) return;
    const hd = e.target.closest('.hd');
    const onEdit = e.target.closest('.bx.edit');
    if (e.target.closest('.bx[data-box]')) return;   // handled by its own click
    start = toPage(e); live = null;

    if (hd && ebox) { mode = 'resize:' + hd.dataset.h; box0 = boxOf(ebox); }
    else if (onEdit && ebox) { mode = 'move'; box0 = boxOf(ebox); }
    else if (e.shiftKey) {
      mode = 'draw'; box0 = null;
      ghost = document.createElement('div');
      ghost.className = 'bx edit'; stage.appendChild(ghost);
    } else {
      mode = 'pan'; pan0 = [pv.scrollLeft, pv.scrollTop, e.clientX, e.clientY];
      pv.classList.add('pan');
    }
    e.preventDefault();
  };

  const onMove = e => {
    if (!mode) return;
    if (mode === 'pan') {
      pv.scrollLeft = pan0[0] - (e.clientX - pan0[2]);
      pv.scrollTop = pan0[1] - (e.clientY - pan0[3]);
      return;
    }
    const [x, y] = toPage(e), dx = x - start[0], dy = y - start[1];
    let b;
    if (mode === 'draw') {
      b = [Math.min(start[0], x), Math.min(start[1], y), Math.max(start[0], x), Math.max(start[1], y)];
    } else if (mode === 'move') {
      const w = box0[2] - box0[0], h = box0[3] - box0[1];
      const nx = clamp(box0[0] + dx, 0, geo.width - w), ny = clamp(box0[1] + dy, 0, geo.height - h);
      b = [nx, ny, nx + w, ny + h];
    } else {
      b = box0.slice();
      const d = mode.slice(7);
      if (d.includes('n')) b[1] = clamp(box0[1] + dy, 0, b[3] - 20);
      if (d.includes('s')) b[3] = clamp(box0[3] + dy, b[1] + 20, geo.height);
      if (d.includes('w')) b[0] = clamp(box0[0] + dx, 0, b[2] - 20);
      if (d.includes('e')) b[2] = clamp(box0[2] + dx, b[0] + 20, geo.width);
    }
    live = b.map(Math.round);
    paint(mode === 'draw' ? ghost : ebox, live);
  };

  const onUp = () => {
    if (!mode) return;
    const m = mode, b = live;
    mode = null; pv.classList.remove('pan');
    if (ghost) { ghost.remove(); ghost = null; }
    if (m === 'pan' || !b) return;
    if (b[2] - b[0] < 20 || b[3] - b[1] < 20) return;
    // The detector's box lives in notices.jsonl and is never written to;
    // adjusting it here only creates a human crop that shadows it.
    save(n.id, { crop: { page: pid, box: b }, crop_status: 'corrected' });
  };

  if (PV.off) PV.off();
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
  PV.off = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  };
}

const refit = () => {
  const z = $('#zoom');
  if (z && (PV.zoom === 'fit' || PV.zoom === 'width')) z.querySelector(`[data-z="${PV.zoom}"]`).click();
};
addEventListener('resize', refit);

// Coming back to the tab is the moment a correction is most likely to have
// landed - the issue was just filed in the other one.
addEventListener('visibilitychange', () => {
  if (document.hidden || !Object.keys(PENDING).length) return;
  checkNow(null);
});

// ---------------------------------------------------------------- splitters
// Widths persist: how much list you want against how much page depends on
// whether you are scanning or reading, and re-dragging it every session is
// friction the tool should absorb.
function makeSplit(handle, target, key, min, max) {
  const saved = parseFloat(localStorage.getItem(key) || '');
  if (saved) target.style.width = saved + 'px';
  handle.addEventListener('mousedown', e => {
    e.preventDefault();
    const x0 = e.clientX, w0 = target.getBoundingClientRect().width;
    handle.classList.add('on'); document.body.classList.add('resizing');
    const mv = ev => {
      const avail = target.parentElement.getBoundingClientRect().width;
      target.style.width = clamp(w0 + (ev.clientX - x0), min, Math.min(max, avail - min)) + 'px';
    };
    const up = () => {
      removeEventListener('mousemove', mv); removeEventListener('mouseup', up);
      handle.classList.remove('on'); document.body.classList.remove('resizing');
      try { localStorage.setItem(key, parseFloat(target.style.width)); } catch (_) {}
      refit();
    };
    addEventListener('mousemove', mv); addEventListener('mouseup', up);
  });
}
makeSplit($('#split-main'), $('#list'), 'pane.list', 280, 1100);
makeSplit($('#split-detail'), $('#pane-text'), 'pane.text', 260, 1000);
$('#reset-panes').onclick = () => {
  ['pane.list', 'pane.text'].forEach(k => { try { localStorage.removeItem(k); } catch (_) {} });
  $('#list').style.width = ''; $('#pane-text').style.width = '';
  refit();
};

// ---------------------------------------------------------------- save
async function save(id, payload) {
  if (!CFG.api) return stage(id, payload);
  const r = await fetch(CFG.api + '/notices/' + encodeURIComponent(id),
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const d = await r.json();
  if (d.error) { alert(d.error); return; }
  if (d.correction) CORR[id] = d.correction; else delete CORR[id];
  select(id);
  renderHome();
  const s = $('#saved');
  if (s) { s.classList.add('show'); setTimeout(() => s.classList.remove('show'), 1100); }
}

// ------------------------------------------------- proposals (public site)
// Two ways to read the published corrections, because they fail differently.
//
// raw.githubusercontent is free and unlimited but sits behind a CDN with a
// roughly five minute cache that a query string does NOT bust - so right after
// someone's correction is applied, it is the one source guaranteed to be wrong.
// The API is current within a minute but allows 60 requests an hour per address.
//
// So: the CDN for ordinary reading, the API only while someone is waiting on a
// correction of their own. A visitor who never edits costs the API nothing.
const LIVE_API = CFG.propose
  ? `https://api.github.com/repos/${CFG.propose}/contents/corrections.json` : null;

async function fetchCorrections({ fresh = false } = {}) {
  if (fresh && LIVE_API) {
    try {
      const r = await fetch(LIVE_API, { headers: { Accept: 'application/vnd.github.raw' } });
      if (r.ok) return await r.json();
    } catch (_) { /* fall through to the CDN */ }
  }
  if (CFG.live) {
    try {
      const r = await fetch(CFG.live, { cache: 'no-cache' });
      if (r.ok) return await r.json();
    } catch (_) { /* keep whatever we have */ }
  }
  return null;
}

async function checkNow(btn) {
  if (btn) { btn.disabled = true; btn.textContent = 'checking…'; }
  const live = await fetchCorrections({ fresh: true });
  if (live) CORR = live;
  const before = Object.keys(PENDING).length;
  reconcilePending();
  render(); renderBanner(); if (SEL) select(SEL);
  return before - Object.keys(PENDING).length;
}

// While something is awaiting GitHub, look again on a timer - but a bounded
// number of times. The API limit is 60 an hour and an abandoned tab must not
// spend it.
let pollsLeft = 0, pollTimer = null;
function startPolling() {
  pollsLeft = 10;
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    const waiting = Object.values(PENDING).some(p => p.proposed_at);
    if (!waiting || pollsLeft-- <= 0 || document.hidden) {
      if (!waiting || pollsLeft <= 0) { clearInterval(pollTimer); pollTimer = null; }
      return;
    }
    await checkNow(null);
  }, 60000);
}
// A correction stops being "unsubmitted" when it turns up in the published
// data, not when the issue form opens - we never learn whether someone pressed
// Create. Comparing against what actually landed is the only honest signal, and
// it is what stops the same fix being proposed twice.
function reconcilePending() {
  let changed = false;
  for (const [id, p] of Object.entries(PENDING)) {
    const live = CORR[id];
    if (!live) continue;
    const fieldsDone = Object.entries(p.fields || {})
      .every(([k, v]) => (live.fields || {})[k] === v);
    const cropDone = !p.crop || (live.crop
      && live.crop.page === p.crop.page
      && String(live.crop.box) === String(p.crop.box));
    const statusDone = !p.review_status || live.review_status === p.review_status;
    if (fieldsDone && cropDone && statusDone) { delete PENDING[id]; changed = true; }
  }
  if (changed) savePending();
}
function stage(id, payload) {
  const p = PENDING[id] || (PENDING[id] = { id, fields: {} });
  for (const [k, v] of Object.entries(payload.fields || {})) {
    if (v === null) delete p.fields[k]; else p.fields[k] = v;
  }
  if ('crop' in payload) p.crop = payload.crop;
  const base = CORR[id] || {};
  for (const k of ['review_status', 'crop_status']) {
    if (!payload[k]) continue;
    const isDefault = payload[k] === (base[k] || 'unreviewed');
    if (isDefault) delete p[k]; else p[k] = payload[k];
  }
  if (!Object.keys(p.fields).length && p.crop == null && !p.review_status && !p.crop_status)
    delete PENDING[id];
  else if (!PENDING[id]) PENDING[id] = p;
  savePending(); select(id); renderBanner();
}

// The body carries ONLY the corrected value. The model's value is already in
// the data repo, and including it pushed 1% of notices past GitHub's URL cap
// (measured: 414 above ~8 KB) for information the Action can look up itself.
function issueBody(n, p) {
  const payload = { id: n.id, fields: p.fields || {} };
  if (p.crop) payload.crop = p.crop;
  if (p.review_status) payload.review_status = p.review_status;
  return [
    `Notice **${n.id}** - volume ${n.volume}, page ${eff(n, 'page')}, no ${eff(n, 'numero')}`,
    eff(n, 'monument') ? `Monument: ${eff(n, 'monument')}` : '',
    '', 'Fields corrected: ' + Object.keys(p.fields || {}).join(', ') + (p.crop ? ', crop' : ''),
    '', '<!-- correction:begin -->', '```json',
    JSON.stringify(payload, null, 1), '```', '<!-- correction:end -->', '',
    '_Submitted from the proofreading interface. Do not edit the block above -',
    'it is applied automatically to the data repository._',
  ].filter(x => x !== null).join('\n');
}

function issueURL(n, p) {
  const q = new URLSearchParams({
    title: `Correction: ${n.id} (${Object.keys(p.fields || {}).join(', ') || 'crop'})`,
    labels: 'correction',
    body: issueBody(n, p),
  });
  return `https://github.com/${CFG.propose}/issues/new?${q}`;
}

async function propose(id) {
  const n = NOTICES.find(x => x.id === id), p = PENDING[id];
  if (!n || !p) return;
  const url = issueURL(n, p);
  p.proposed_at = new Date().toISOString();
  savePending(); renderBanner(); startPolling();
  if (url.length < 8000) { open(url, '_blank', 'noopener'); return; }
  // Above GitHub's cap the query string 414s, so hand it over by clipboard.
  try {
    await navigator.clipboard.writeText(issueBody(n, p));
    alert('This correction is too long for a pre-filled link, so it has been '
        + 'copied to your clipboard. A blank issue will open - paste it in.');
  } catch (_) {
    alert('This correction is too long for a pre-filled link. Copy the text from '
        + 'the transcription box, open the issue, and paste it in.');
  }
  open(`https://github.com/${CFG.propose}/issues/new?labels=correction`, '_blank', 'noopener');
}

function renderBanner() {
  const bar = $('#propose-bar');
  if (!bar) return;
  const ids = Object.keys(PENDING);
  bar.hidden = !CFG.propose || !ids.length;
  if (bar.hidden) return;
  const here = SEL && PENDING[SEL];
  const sent = ids.filter(i => PENDING[i].proposed_at).length;
  bar.innerHTML = `<b>${ids.length}</b> correction${ids.length > 1 ? 's' : ''} of yours
    ${sent ? `<span class="sent">${sent} submitted &mdash; GitHub usually publishes within a few minutes</span>` : 'not yet sent'}
    ${here ? `<button id="pb-send">${here.proposed_at ? 'Propose again' : 'Propose this notice on GitHub'}</button>` : ''}
    ${sent ? '<button id="pb-check">check now</button>' : ''}
    ${here && here.proposed_at ? '<button id="pb-done" class="quiet">clear this one</button>' : ''}
    <button id="pb-clear" class="quiet">discard all</button>`;
  const chk = $('#pb-check');
  if (chk) chk.onclick = async () => {
    const n = await checkNow(chk);
    if (!n && $('#pb-check')) {
      $('#pb-check').disabled = false;
      $('#pb-check').textContent = 'not published yet — try again shortly';
    }
  };
  const done = $('#pb-done');
  if (done) done.onclick = () => { delete PENDING[SEL]; savePending(); select(SEL); renderBanner(); };
  const send = $('#pb-send');
  if (send) send.onclick = () => propose(SEL);
  $('#pb-clear').onclick = () => {
    if (!confirm(`Discard all ${ids.length} unsubmitted corrections?`)) return;
    PENDING = {}; savePending(); renderBanner(); if (SEL) select(SEL);
  };
}

// Delete removes the box in force. Guarded on the focused element: the fields
// are plain textareas, and swallowing Backspace while someone is correcting a
// transcription would be a far worse bug than the one this fixes.
addEventListener('keydown', e => {
  if (e.key !== 'Delete' && e.key !== 'Backspace') return;
  const t = document.activeElement;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  if (!SEL) return;
  const n = NOTICES.find(x => x.id === SEL);
  if (!n || !effCrop(n)) return;
  e.preventDefault();          // Backspace would otherwise navigate back
  save(SEL, { crop: null, crop_status: 'rejected' });
});

// ---------------------------------------------------------------- wiring
$('#rows').addEventListener('click', e => {
  const tr = e.target.closest('tr'); if (tr) select(tr.dataset.id);
});
document.querySelectorAll('thead th[data-sort]').forEach(th => {
  th.insertAdjacentHTML('beforeend', '<span class="caret">&#9650;</span>');
  th.onclick = () => {
    if (sortKey === th.dataset.sort) sortAsc = !sortAsc;
    else { sortKey = th.dataset.sort; sortAsc = true; }
    apply();
  };
});
let t; $('#q').oninput = () => { clearTimeout(t); t = setTimeout(() => { page = 0; apply(); }, 180); };
['#fstatus', '#fissue'].forEach(s => $(s).onchange = () => { page = 0; apply(); });
load();
