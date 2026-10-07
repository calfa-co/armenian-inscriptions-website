'use strict';

// Where the data and the page scans come from. The local editing tool injects
// nothing and the defaults apply; the GitHub Pages build ships a config.js that
// points `data` at committed JSON and `images` at object storage.
const CFG = Object.assign({
  api: '/api',        // null on the public site: nothing is POSTed anywhere
  data: null,         // directory of committed notices.json / corrections.json
  images: null,       // base URL of the page scans; null = this server
  propose: null,      // "owner/repo": edits become a prefilled GitHub issue
  live: null,         // raw URL of the data repo's corrections.json
  site: null,         // canonical address used in permalinks and citations
  readOnly: false,
}, window.RVW || {});
const SITE = CFG.site || (location.origin + location.pathname);

// A correction is handed to GitHub as a prefilled issue against the data repo:
// GitHub signs the submission, and an Action turns the issue into a commit.
// Until then it lives only in this browser.
const PROPOSE_KEY = 'pending.corrections';
let PENDING = {};
try { PENDING = JSON.parse(localStorage.getItem(PROPOSE_KEY) || '{}'); } catch (_) { PENDING = {}; }
const savePending = () => {
  try { localStorage.setItem(PROPOSE_KEY, JSON.stringify(PENDING)); } catch (_) {}
};
const pref = (k, v) => {
  try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (_) {}
  return null;
};

// Always the FULL scan: the crop is cut from this same image in the browser,
// and a downscaled copy made the letters illegible.
const pageURL = pid => {
  if (!CFG.images) return `/page/${encodeURIComponent(pid)}.jpg`;
  const m = /^CatInsc_(\d+)_/.exec(pid);
  return `${CFG.images}/vol${m ? m[1] : '0'}/${encodeURIComponent(pid)}.jpg`;
};

// ---------------------------------------------------------------- state
let NOTICES = [], BYID = new Map(), CORR = {}, VIEW = [], SEL = null, LOADED = false;
let F = { vol: '', status: '', flag: '', q: '' };
let sortKey = 'volume', sortAsc = true, page = 0;
// The edit session. It starts from one notice's Edit button and follows the
// reader through the result list until Done, a change of filter, or leaving
// Browse. Memory only: a returning visitor always lands in reading mode.
let EDITING = false;
const PAGE_SIZE = 150;
const EDITABLE = ['monument', 'description', 'transcription', 'nb_lignes',
                  'reference', 'note', 'page', 'numero'];
// `monument` holds the bold opening words of the printed notice - usually a
// locator that runs on into the description, not the name of a monument.
const LABEL = {
  monument: 'Lemma', description: 'Location and description', transcription: 'Text',
  nb_lignes: 'Lines', reference: 'References', note: 'Note', page: 'Page', numero: 'No.',
};

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const fmtN = n => n.toLocaleString('en');
const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
const roman = v => ROMAN[+v] || v;

// Unsent edits are shown only inside the edit session, on the notice being
// edited. Everywhere else - reading, lists, counts, exports - the published
// record is what a visitor sees.
const P = id => (EDITING && id === SEL) ? PENDING[id] : undefined;

// Effective value: the human correction when one exists, the machine value
// otherwise. The machine value is never overwritten, only shadowed.
const pub = (n, k) => {
  const c = CORR[n.id];
  return (c && c.fields && k in c.fields) ? c.fields[k] : (n[k] ?? '');
};
const eff = (n, k) => {
  const p = P(n.id);
  if (p && p.fields && k in p.fields) return p.fields[k];
  return pub(n, k);
};
const isEdited = (n, k) => {
  const p = P(n.id);
  if (p && p.fields && k in p.fields) return p.fields[k] !== (n[k] ?? '');
  const c = CORR[n.id];
  return !!(c && c.fields && k in c.fields && c.fields[k] !== (n[k] ?? ''));
};
const anyEdit = n => EDITABLE.some(k => isEdited(n, k));
const editedFields = n => EDITABLE.filter(k => isEdited(n, k));
// All five accessors must consult the same source, or a control shows one
// state while the record holds another.
const reviewOf = n => (P(n.id) && P(n.id).review_status)
  || (CORR[n.id] && CORR[n.id].review_status) || 'unreviewed';
const cropStatusOf = n => (P(n.id) && P(n.id).crop_status)
  || (CORR[n.id] && CORR[n.id].crop_status) || 'unreviewed';
const humanCrop = n => (P(n.id) && P(n.id).crop !== undefined
  ? P(n.id).crop : (CORR[n.id] && CORR[n.id].crop)) || null;
// The box actually used: the human's when they adjusted one, else the
// detector's pair. "Rejected" means no usable box, so fall back to nothing.
const effCrop = n => {
  const hc = humanCrop(n);
  if (hc) return hc;
  if (cropStatusOf(n) === 'rejected') return null;
  return n.yolo_box ? { page: n.pages[0], box: n.yolo_box.box } : null;
};
const cropState = n => humanCrop(n) ? 'human'
  : cropStatusOf(n) === 'rejected' ? 'none' : n.yolo_pairing;
const cropSource = n => humanCrop(n) ? 'editor' : effCrop(n) ? 'detector' : null;

const UNBAL = t => {
  const c = ch => (t.split(ch).length - 1);
  return c('⎡') !== c('⎤') || c('⎣') !== c('⎦') || c('[') !== c(']');
};
const HAS_NOTATION = t => /[⎡⎣\[]/.test(t) || t.includes('...') || t.includes('/');
const REQUIRED = ['monument', 'description', 'transcription', 'nb_lignes'];

// Who checked it, as the data records it.
const byWhom = n => {
  const c = CORR[n.id];
  if (!c || !c.updated_by || c.updated_by === 'local') return '';
  const who = c.updated_by === 'pre-github' ? 'before GitHub' : c.updated_by;
  return `${who}${c.updated_at ? ', ' + c.updated_at.slice(0, 10) : ''}`;
};
// Crop-only changes never count as "corrected": the text is what is certified.
const STATUS = n => {
  const rv = reviewOf(n), ed = anyEdit(n);
  if (rv === 'needs_attention') return ['warn', 'Flagged for review', 'flagged for review'];
  if (rv === 'reviewed') return ed ? ['ok', 'Checked · corrected', 'checked, corrected']
                                   : ['ok', 'Checked against the scan', 'checked against the scan'];
  return ed ? ['human', 'Partly corrected · not yet checked', 'partly corrected, not yet checked']
            : ['', 'Machine-read · not yet checked', 'machine-read, not yet checked'];
};

// ---------------------------------------------------------------- volumes
// Read off each volume's own title page: the scholarly titles of the Divan.
const VOLUMES = {
  '1':  ['ԱՆԻ ՔԱՂԱՔ', 'Հ. Ա. Օրբելի', 1966],
  '2':  ['Գորիսի, Սիսիանի և Ղափանի շրջաններ', 'Ս. Գ. Բարխուդարյան', 1960],
  '3':  ['Վայոց ձոր — Եղեգնաձորի և Ազիզբեկովի շրջաններ', 'Ս. Գ. Բարխուդարյան', 1967],
  '4':  ['Գեղարքունիք — Կամոյի, Մարտունու և Վարդենիսի շրջաններ', 'Ս. Գ. Բարխուդարյան', 1973],
  '5':  ['Արցախ', 'Ս. Գ. Բարխուդարյան', 1982],
  '6':  ['Իջևանի շրջան', 'Ս. Ա. Ավագյան, Հ. Մ. Ջանփոլադյան', 1977],
  '7':  ['Ուկրաինա, Մոլդովա', 'Գ. Մ. Գրիգորյան', 1996],
  '8':  ['Ռուսաստանի Դաշնություն', 'Գր. Մ. Գրիգորյան', 1999],
  '9':  ['Լոռու մարզ', 'Ս. Գ. Բարխուդարյան, Կ. Ղ. Ղաֆադարյան, Ս. Տ. Սաղումյան', 2012],
  '10': ['Շիրակի մարզ', 'Ս. Գ. Բարխուդարյան', 2017],
};
// English gloss and romanised editors, for readers who do not read Armenian.
const VOL_EN = {
  '1':  ['The city of Ani', 'H. A. Orbeli'],
  '2':  ['Goris, Sisian and Ghapan districts', 'S. G. Barkhudaryan'],
  '3':  ['Vayots Dzor: Yeghegnadzor and Azizbekov districts', 'S. G. Barkhudaryan'],
  '4':  ['Gegharkunik: Kamo, Martuni and Vardenis districts', 'S. G. Barkhudaryan'],
  '5':  ['Artsakh', 'S. G. Barkhudaryan'],
  '6':  ['Ijevan district', 'S. A. Avagyan, H. M. Janpoladyan'],
  '7':  ['Ukraine, Moldova', 'G. M. Grigoryan'],
  '8':  ['Russian Federation', 'Gr. M. Grigoryan'],
  '9':  ['Lori province', 'S. G. Barkhudaryan, K. Gh. Ghafadaryan, S. T. Saghumyan'],
  '10': ['Shirak province', 'S. G. Barkhudaryan'],
};
const surname = v => ((VOL_EN[v] || [, ''])[1].split(',')[0].split(' ').pop()) || '';
const volShort = v => `Divan ${roman(v)}`;
const volLine = v => VOLUMES[v]
  ? `${volShort(v)} · <span class="arm">${esc(VOLUMES[v][0])}</span> · ${esc(surname(v))} ${VOLUMES[v][2]}`
  : volShort(v);

// The signs, described so the wording holds for every volume. Each volume's
// own table of conventional signs remains the authority.
const SIGNS = [
  ['⎡ ⎤', 'text restored by the editor'],
  ['⎣ ⎦', 'editor’s correction or addition (omission, abbreviation)'],
  ['[ ]', 'square brackets as printed, usually letters supplied by the editor'],
  ['...', 'lost text (lacuna)'],
  ['/', 'line division as printed'],
  ['( )', 'editor’s parenthesis, usually a year converted to AD'],
  ['։Ա։', 'letters used as numerals'],
];

// ---------------------------------------------------------------- load
async function load() {
  const d = CFG.api
    ? await (await fetch(CFG.api + '/notices')).json()
    : { notices: await (await fetch(`${CFG.data}/notices.json`)).json(),
        corrections: await (await fetch(`${CFG.data}/corrections.json`)).json() };
  NOTICES = d.notices; CORR = d.corrections || {};
  NOTICES.forEach(n => BYID.set(n.id, n));

  // Corrections come from the data repository itself, not from the copy that
  // shipped with this page, so one applied minutes ago is already here.
  const live = await fetchCorrections({ fresh: Object.keys(PENDING).length > 0 });
  if (live) CORR = live;
  CORR_AT = new Date();
  HAY.clear();
  reconcilePending();
  if (CFG.api) {
    const mode = $('#mode');
    mode.textContent = 'local';
    mode.title = 'Edits save straight to corrections.jsonl on this computer.';
  }
  const vols = [...new Set(NOTICES.map(n => n.volume))].sort((a, b) => a - b);
  $('#fvol').innerHTML = '<option value="">All volumes</option>' + vols.map(v =>
    `<option value="${esc(v)}">${volShort(v)}${VOL_EN[v] ? ' — ' + esc(VOL_EN[v][0]) : ''}</option>`).join('');
  LOADED = true;
  lastRouted = null;
  route();
  renderBanner();
  if (Object.values(PENDING).some(p => p.proposed_at)) startPolling();
}
let CORR_AT = null;

// ---------------------------------------------------------------- router
// Hash routes, so every notice and every result set has an address that can be
// cited or shared, and GitHub Pages needs no server-side rewriting.
//   #/  #/browse?vol=5&q=…  #/notice/<id>?…  #/data  #/about/<section>  #/proofreading
let VIEWNAME = 'home', lastRouted = null;

function parseHash() {
  const h = location.hash.replace(/^#\/?/, '');
  const i = h.indexOf('?');
  const path = i < 0 ? h : h.slice(0, i), qs = i < 0 ? '' : h.slice(i + 1);
  const [view, ...rest] = path.split('/');
  return { view: view || 'home', arg: decodeURIComponent(rest.join('/')),
           params: new URLSearchParams(qs) };
}

function showView(name) {
  if (VIEWNAME === 'browse' && name !== 'browse') endEdit(false);
  VIEWNAME = name;
  document.querySelectorAll('.view').forEach(v => v.hidden = v.id !== 'v-' + name);
  document.querySelectorAll('nav.top a').forEach(a => a.classList.toggle('on', a.dataset.nav === name));
  document.body.dataset.view = name;
}

function route() {
  if (location.hash === lastRouted) return;
  lastRouted = location.hash;
  const r = parseHash();
  const view = { notice: 'browse', contribute: 'proofreading' }[r.view] || r.view;
  if (!['home', 'browse', 'data', 'about', 'proofreading'].includes(view)) { go('#/'); return; }
  showView(view);
  renderFooters();
  if (view === 'about') return renderAbout(r.arg);
  if (!LOADED) return;
  if (view === 'home') return renderHome();
  if (view === 'proofreading') return renderDash();
  if (view === 'data') { readFilters(r.params, true); apply(false); return renderData(r.params); }
  // browse
  readFilters(r.params);
  apply(false);
  if (r.view === 'notice' && r.arg) {
    const idx = VIEW.findIndex(n => n.id === r.arg);
    if (idx >= 0) page = Math.floor(idx / PAGE_SIZE);
    select(r.arg, { keepEdit: r.arg === SEL });
    render();
    const tr = document.querySelector(`#rows tr[data-id="${CSS.escape(r.arg)}"]`);
    if (tr) tr.scrollIntoView({ block: 'nearest' });
  } else {
    clearSelection();
  }
}

function readFilters(p, keep = false) {
  if (keep && ![...p.keys()].some(k => ['vol', 'status', 'flag', 'q'].includes(k))) return;
  F = { vol: p.get('vol') || '', status: p.get('status') || '', flag: p.get('flag') || '', q: p.get('q') || '' };
  page = Math.max(0, (parseInt(p.get('p'), 10) || 1) - 1);
  $('#fvol').value = F.vol; $('#fstatus').value = F.status;
  if (document.activeElement !== $('#q')) $('#q').value = F.q;
}

function filterQS() {
  const p = new URLSearchParams();
  for (const k of ['vol', 'status', 'flag', 'q']) if (F[k]) p.set(k, F[k]);
  if (page) p.set('p', page + 1);
  const s = p.toString();
  return s ? '?' + s : '';
}

function syncHash() {
  if (VIEWNAME !== 'browse') return;
  const h = (SEL ? `#/notice/${encodeURIComponent(SEL)}` : '#/browse') + filterQS();
  if (location.hash !== h) history.replaceState(null, '', h);
  lastRouted = location.hash;
  $('nav.top a[data-nav=browse]').href = h;
}

const go = h => { if (location.hash === h) { lastRouted = null; route(); } else location.hash = h; };
addEventListener('hashchange', route);
addEventListener('popstate', route);

const permalink = n => `${SITE}#/notice/${encodeURIComponent(n.id)}`;

// ---------------------------------------------------------------- home
const stats = rows => {
  const s = { n: rows.length, pages: new Set(), reviewed: 0, attention: 0, edited: 0,
              noTr: 0, unbal: 0, missing: 0, ambiguous: 0, noDet: 0, human: 0 };
  for (const r of rows) {
    r.pages.forEach(p => s.pages.add(p));
    const rv = reviewOf(r);
    if (rv === 'reviewed') s.reviewed++;
    if (rv === 'needs_attention') s.attention++;
    if (anyEdit(r)) s.edited++;
    const t = eff(r, 'transcription');
    if (!t.trim()) s.noTr++;
    if (UNBAL(t)) s.unbal++;
    if (!REQUIRED.every(k => eff(r, k).trim())) s.missing++;
    const cs = cropState(r);
    if (cs === 'ambiguous') s.ambiguous++;
    if (cs === 'none') s.noDet++;
    if (cs === 'human') s.human++;
  }
  return s;
};
const VOLS = () => [...new Set(NOTICES.map(n => n.volume))].sort((a, b) => a - b);

function renderHome() {
  const all = stats(NOTICES), vols = VOLS();
  $('#figures').innerHTML = `
    <div><b>${fmtN(all.n)}</b><span>notices</span></div>
    <div><b>${vols.length}</b><span>volumes</span></div>
    <div><b>${fmtN(all.pages.size)}</b><span>printed pages</span></div>`;
  $('.silver span').innerHTML = `Texts were machine-read from the printed volumes and may contain errors;
    ${fmtN(all.reviewed)} have been checked so far. The page scan is authoritative.
    <a href="#/about/method">About the data</a>`;
  $('#vol-table tbody').innerHTML = vols.map(v => {
    const [title, , year] = VOLUMES[v] || ['', '', ''];
    const [en, ed] = VOL_EN[v] || ['', ''];
    const cnt = NOTICES.filter(n => n.volume === v).length;
    return `<tr class="go" data-vol="${esc(v)}">
      <td><b>${roman(v)}</b></td>
      <td><span class="arm">${esc(title)}</span><span class="sub">${esc(en)}</span></td>
      <td>${esc(ed)}</td><td class="r">${year}</td><td class="r">${fmtN(cnt)}</td></tr>`;
  }).join('');
  $('#vol-table').querySelectorAll('[data-vol]').forEach(tr =>
    tr.onclick = () => go(`#/browse?vol=${tr.dataset.vol}`));
}

function renderFooters() {
  const html = `<img src="assets/calfa-logo.png" alt="Calfa">
    <span>Data: <a href="https://creativecommons.org/licenses/by-sa/4.0/" target="_blank" rel="noopener">CC BY-SA 4.0</a></span>
    ${CFG.propose ? `<a href="https://github.com/${CFG.propose}" target="_blank" rel="noopener">Data repository</a>` : ''}
    <a href="#/data">Download</a><a href="#/about/cite">How to cite</a>`;
  document.querySelectorAll('footer.site .wrap').forEach(f => f.innerHTML = html);
}

// ---------------------------------------------------------------- dashboard
const FLAGS = {
  unbalanced: ['Unbalanced brackets', 'an opening sign with no match'],
  no_transcription: ['No transcription', 'the extraction returned no text'],
  missing_fields: ['Missing fields', 'lemma, description, lines or text absent'],
  notation: ['With editorial signs', 'text contains ⎡⎤ ⎣⎦ [ ] … /'],
  crop_ambiguous: ['Facsimile box ambiguous', 'drawings and notices did not match on the page'],
  crop_none: ['No facsimile detected', 'the detector found no drawing'],
  crop_auto: ['Facsimile box auto-paired', 'paired in reading order'],
  crop_human: ['Facsimile box set by hand', 'adjusted by an editor'],
  edited: ['Corrected', 'at least one field changed by a specialist'],
  pending: ['My unsent corrections', 'kept in this browser'],
  awaiting: ['My sent corrections', 'submitted, not yet published'],
};

function renderDash() {
  const all = stats(NOTICES);
  const un = all.n - all.reviewed - all.attention;
  $('#dash-progress').innerHTML = `
    <div class="progress"><i class="p-rev" style="width:${100 * all.reviewed / all.n}%"></i>
      <i class="p-att" style="width:${100 * all.attention / all.n}%"></i></div>
    <div class="key">
      <button data-st="reviewed"><em style="background:var(--ok)"></em><b>${fmtN(all.reviewed)}</b> checked</button>
      <button data-st="needs_attention"><em style="background:var(--warn)"></em><b>${fmtN(all.attention)}</b> flagged</button>
      <button data-st="unreviewed"><em style="background:var(--rule-soft)"></em><b>${fmtN(un)}</b> not yet checked</button>
      <button data-st="edited"><b>${fmtN(all.edited)}</b> corrected</button>
    </div>`;
  $('#dash-progress').querySelectorAll('[data-st]').forEach(b =>
    b.onclick = () => go(`#/browse?status=${b.dataset.st}`));
  const unsent = Object.values(PENDING).filter(p => !p.proposed_at).length;
  const sent = Object.values(PENDING).filter(p => p.proposed_at).length;
  const q = [
    ['unbalanced', all.unbal], ['no_transcription', all.noTr], ['missing_fields', all.missing],
    ['crop_ambiguous', all.ambiguous], ['crop_none', all.noDet], ['edited', all.edited],
    ...(unsent ? [['pending', unsent]] : []), ...(sent ? [['awaiting', sent]] : []),
  ];
  $('#queues').innerHTML = `<thead><tr><th>Queue</th><th></th><th class="r">Notices</th></tr></thead><tbody>` +
    q.map(([k, c]) => `<tr class="go" data-flag="${k}"><td><a href="#/browse?flag=${k}">${esc(FLAGS[k][0])}</a></td>
      <td class="small">${esc(FLAGS[k][1])}</td><td class="r">${fmtN(c)}</td></tr>`).join('') + '</tbody>';
  $('#queues').querySelectorAll('[data-flag]').forEach(tr =>
    tr.onclick = e => { if (e.target.tagName !== 'A') go(`#/browse?flag=${tr.dataset.flag}`); });
  $('#dash-vols').innerHTML = `<thead><tr><th>Vol.</th><th class="r">Notices</th><th class="r">Checked</th>
    <th class="r">Flagged</th><th class="r">No text</th><th class="r">Unbalanced</th></tr></thead><tbody>` +
    VOLS().map(v => {
      const s = stats(NOTICES.filter(n => n.volume === v));
      return `<tr class="go" data-vol="${esc(v)}"><td><b>${roman(v)}</b> <span class="small">${esc((VOL_EN[v] || [''])[0])}</span></td>
        <td class="r">${fmtN(s.n)}</td><td class="r">${fmtN(s.reviewed)}</td><td class="r">${fmtN(s.attention)}</td>
        <td class="r">${fmtN(s.noTr)}</td><td class="r">${fmtN(s.unbal)}</td></tr>`;
    }).join('') + '</tbody>';
  $('#dash-vols').querySelectorAll('[data-vol]').forEach(tr =>
    tr.onclick = () => go(`#/browse?vol=${tr.dataset.vol}`));
}

// ---------------------------------------------------------------- search
// The index ignores the editorial signs, so ՓԱԹՇԱՀԻՆ finds ՓԱԹՇԱ⎡ՀԻՆ⎤ and
// ՍՈՒՐԲ finds Ս[ՈՒՐ]Բ. Display only: the stored text is untouched.
const norm = t => String(t || '').toLowerCase()
  .replace(/[⎡⎤⎣⎦\[\]()]/g, '')
  .replace(/\.{2,}/g, ' ')
  .replace(/(\S)\/(?=\S)/g, '$1')
  .replace(/\//g, ' ')
  .replace(/[։՝՛՜՞:]/g, ' ')
  .replace(/և/g, 'եւ')
  .replace(/\s+/g, ' ');
const HAY = new Map();
const hay = n => {
  let h = HAY.get(n.id);
  if (h === undefined) {
    h = norm(['monument', 'transcription', 'description', 'reference', 'note']
      .map(k => pub(n, k)).join(' ')) + ' ' + n.id.toLowerCase();
    HAY.set(n.id, h);
  }
  return h;
};

// ---------------------------------------------------------------- filter
function matchFlag(n, iss) {
  const t = eff(n, 'transcription');
  if (iss.startsWith('crop_')) return cropState(n) === iss.slice(5);
  switch (iss) {
    case 'edited': return anyEdit(n);
    case 'pending': return !!(PENDING[n.id] && !PENDING[n.id].proposed_at);
    case 'awaiting': return !!(PENDING[n.id] && PENDING[n.id].proposed_at);
    case 'no_transcription': return !t.trim();
    case 'missing_fields': return !REQUIRED.every(k => eff(n, k).trim());
    case 'unbalanced': return UNBAL(t);
    case 'notation': return HAS_NOTATION(t);
  }
  return true;
}

function filtered(f) {
  const q = norm(f.q).trim();
  return NOTICES.filter(n => {
    if (f.vol && n.volume !== f.vol) return false;
    if (f.status === 'edited') { if (!anyEdit(n)) return false; }
    else if (f.status && reviewOf(n) !== f.status) return false;
    if (f.flag && !matchFlag(n, f.flag)) return false;
    if (q && !hay(n).includes(q)) return false;
    return true;
  });
}

function apply(sync = true) {
  VIEW = filtered(F);
  const num = v => { const f = parseFloat(v); return isNaN(f) ? Infinity : f; };
  // Catalogue order: volume, then PRINTED page, then number.
  const ref = n => [num(n.volume), num(pub(n, 'page')), num(pub(n, 'numero'))];
  VIEW.sort((a, b) => {
    let c;
    if (sortKey === 'volume') {
      const x = ref(a), y = ref(b);
      c = x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
    } else {
      c = String(pub(a, sortKey)).localeCompare(String(pub(b, sortKey)), 'hy');
    }
    if (!c) { const x = ref(a), y = ref(b); c = x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; }
    return sortAsc ? c : -c;
  });
  if (page * PAGE_SIZE >= VIEW.length) page = 0;
  $('#fchip').innerHTML = F.flag && FLAGS[F.flag]
    ? `<span class="chip">${esc(FLAGS[F.flag][0])}<button title="Remove this filter" id="unflag">&times;</button></span>` : '';
  const uf = $('#unflag');
  if (uf) uf.onclick = () => setFilter({ flag: '' });
  render();
  renderBanner();
  if (sync) syncHash();
}

function setFilter(change) {
  Object.assign(F, change);
  page = 0;
  endEdit(false);
  if (VIEWNAME !== 'browse') { showView('browse'); SEL = null; clearSelection(); }
  apply();
}

// ---------------------------------------------------------------- list
const incipit = n => (pub(n, 'transcription').split(/\/|\n/)[0] || '').trim();

function rowTags(n) {
  const out = [];
  const rv = reviewOf(n);
  if (rv === 'reviewed') out.push('<span class="tag t-ok">checked</span>');
  if (rv === 'needs_attention') out.push('<span class="tag t-warn">flagged</span>');
  if (anyEdit(n)) out.push('<span class="tag t-human">corrected</span>');
  if (PENDING[n.id]) out.push(`<span class="tag t-human">${PENDING[n.id].proposed_at ? 'sent' : 'unsent'}</span>`);
  return out.join('');
}

function render() {
  const start = page * PAGE_SIZE, slice = VIEW.slice(start, start + PAGE_SIZE);
  $('#rows').innerHTML = slice.map(n => {
    const mon = pub(n, 'monument'), inc = incipit(n);
    return `<tr data-id="${esc(n.id)}" class="${n.id === SEL ? 'sel' : ''}">
      <td><div class="ref"><b>No. ${esc(pub(n, 'numero'))}</b><br>
        <span>${roman(n.volume)} · p. ${esc(pub(n, 'page'))}</span></div></td>
      <td>${mon ? `<div class="mon">${esc(mon)}</div>` : ''}
        ${inc ? `<div class="inc">${esc(inc)}</div>` : '<div class="void">no text</div>'}
        ${rowTags(n)}</td>
    </tr>`;
  }).join('');

  $('#count').textContent = VIEW.length === NOTICES.length
    ? `${fmtN(NOTICES.length)} notices` : `${fmtN(VIEW.length)} of ${fmtN(NOTICES.length)}`;

  const pages = Math.max(1, Math.ceil(VIEW.length / PAGE_SIZE));
  $('#pager').innerHTML = `<button class="btn sm" ${page === 0 ? 'disabled' : ''} id="prev">&larr; Previous</button>
     <span>${VIEW.length ? start + 1 : 0}&ndash;${Math.min(start + PAGE_SIZE, VIEW.length)} of ${fmtN(VIEW.length)}
       · <a href="#/data${filterQS() ? filterQS() + '&' : '?'}scope=results">Export</a></span>
     <button class="btn sm" ${page >= pages - 1 ? 'disabled' : ''} id="next">Next &rarr;</button>`;
  $('#prev').onclick = () => { page--; render(); syncHash(); $('#scroll').scrollTop = 0; };
  $('#next').onclick = () => { page++; render(); syncHash(); $('#scroll').scrollTop = 0; };

  document.querySelectorAll('.rows thead th[data-sort]').forEach(th => {
    th.classList.toggle('sorted', th.dataset.sort === sortKey);
    th.querySelector('.caret').innerHTML = sortAsc ? '&#9650;' : '&#9660;';
  });
}

// ---------------------------------------------------------------- notation
// Wraps the signs in spans WITHOUT altering a single character. Tags go in as
// sentinels and become HTML only at the end: the "/" sign is highlighted too,
// and replacing it directly would chew through every "</span>" already emitted.
const SENT = {
  'n-rest': ['', ''], 'n-err': ['', ''],
  'n-ext': ['', ''], 'n-dot': ['', ''],
  'n-slash': ['', ''], 'gl': ['', ''],
};
function markup(t) {
  const w = (cls, m) => SENT[cls][0] + m + SENT[cls][1];
  const pair = (cls, m) => w(cls, w('gl', m[0]) + m.slice(1, -1) + w('gl', m.slice(-1)));
  let h = esc(t);
  h = h.replace(/⎡[\s\S]*?⎤/g, m => pair('n-rest', m));
  h = h.replace(/⎣[\s\S]*?⎦/g, m => pair('n-err', m));
  h = h.replace(/\[[^\[\]]*?\]/g, m => pair('n-ext', m));
  h = h.replace(/\.{2,}/g, m => w('n-dot', m));
  h = h.replace(/\//g, m => w('n-slash', m));
  for (const [cls, [o, c]] of Object.entries(SENT))
    h = h.split(o).join(`<span class="${cls}">`).split(c).join('</span>');
  return h;
}

// `reference` mixes previous editions (Հրատ.) and photographs (Լուսանկ.). It is
// split for display only, and only when every segment starts with one of the
// two prefixes as printed; otherwise it is shown whole.
function splitRefs(t) {
  const idx = [...t.matchAll(/Հրատ\.|Լուսանկ\./g)].map(m => m.index);
  if (!idx.length || t.slice(0, idx[0]).trim()) return null;
  const segs = idx.map((s, i) => t.slice(s, idx[i + 1] ?? t.length).trim());
  return { ed: segs.filter(s => s.startsWith('Հրատ.')).join('\n'),
           ph: segs.filter(s => s.startsWith('Լուսանկ.')).join('\n') };
}

// ---------------------------------------------------------------- detail
const seg = (attr, opts, cur) => `<div class="grp">${opts.map(([v, lbl]) =>
  `<button data-${attr}="${v}" class="${cur === v ? 'on' : ''}">${lbl}</button>`).join('')}</div>`;

function clearSelection() {
  SEL = null;
  $('#empty').hidden = false; $('#work').hidden = true;
  document.body.classList.remove('editing');
  render();
  syncHash();
}

function citation(n) {
  const v = n.volume, vt = VOLUMES[v];
  const ed = vt ? ` (${surname(v)} ${vt[2]})` : '';
  const today = new Date().toISOString().slice(0, 10);
  return `Divan hay vimagrutʻyan ${roman(v)}${ed}, p. ${pub(n, 'page')}, no. ${pub(n, 'numero')}. `
    + `Armenian Inscriptions, Calfa, record ${n.id}, ${permalink(n)} `
    + `(${STATUS(n)[2]}; accessed ${today}). CC BY-SA 4.0.`;
}

function reportURL(n) {
  const body = [
    `Notice: ${n.id} (vol. ${roman(n.volume)}, p. ${pub(n, 'page')}, no. ${pub(n, 'numero')})`,
    pub(n, 'monument') ? `Lemma: ${pub(n, 'monument')}` : '',
    'Field concerned: (text / description / references / facsimile box / other)',
    'What is wrong:', '', '',
    `Source: ${permalink(n)}`,
    '_Reported from the reading interface; not an automatic correction._',
  ].filter(x => x !== null).join('\n');
  return `https://github.com/${CFG.propose}/issues/new?` +
    new URLSearchParams({ title: `Report: ${n.id}`, body });
}

function select(id, { keepEdit = true } = {}) {
  const n = BYID.get(id);
  if (!n) {
    SEL = null;
    $('#empty').hidden = false; $('#work').hidden = true;
    $('#empty').innerHTML = `<p>No notice with the identifier <code>${esc(id)}</code>.</p>`;
    return;
  }
  if (id !== SEL && !keepEdit) EDITING = false;
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  SEL = id;
  document.body.classList.toggle('editing', EDITING);
  $('#empty').hidden = true; $('#work').hidden = false;
  document.querySelectorAll('#rows tr').forEach(tr => tr.classList.toggle('sel', tr.dataset.id === id));
  syncHash();

  const idx = VIEW.indexOf(n);
  const [scls, slabel] = STATUS(n);
  const who = byWhom(n);
  const ed = editedFields(n);
  const mine = PENDING[id];

  $('#dtop').innerHTML = `
    <div class="drow">
      <div class="dhead">
        <div class="cite-line">${volLine(n.volume)}</div>
        <h2 class="ptitle">No. ${esc(eff(n, 'numero')) || '—'} <span class="sep">·</span> p. ${esc(eff(n, 'page')) || '—'}</h2>
        ${eff(n, 'monument') ? `<div class="lemma" title="Lemma: the opening words of the printed notice">${esc(eff(n, 'monument'))}</div>` : ''}
        <div class="status"><b class="s-${scls}">${slabel}</b>${who && (reviewOf(n) !== 'unreviewed' || ed.length)
          ? ` <span>— ${esc(who)}</span>` : ''}${ed.length
          ? ` · <span>corrected: ${ed.map(k => LABEL[k].toLowerCase()).join(', ')}</span>` : ''}</div>
      </div>
      <div class="dact">
        <div class="stepper">
          <button class="btn sm" id="st-prev" title="Previous result (←)" ${idx > 0 ? '' : 'disabled'}>&lsaquo;</button>
          <span class="small pos">${idx >= 0 ? `${fmtN(idx + 1)} of ${fmtN(VIEW.length)}` : ''}</span>
          <button class="btn sm" id="st-next" title="Next result (→)" ${idx >= 0 && idx < VIEW.length - 1 ? '' : 'disabled'}>&rsaquo;</button>
        </div>
        ${EDITING ? '<button class="btn primary" id="edit-done">Done</button>'
                  : '<button class="btn" id="edit-go" title="Correct this notice (specialists)">Edit</button>'}
        <div class="menu"><button class="btn" id="cite-btn">Cite</button>
          <div class="pop cite-pop" id="cite-pop" hidden>
            <div class="cite-text" id="cite-text">${esc(citation(n))}</div>
            <hr><button id="cite-copy">Copy citation</button><button id="link-copy">Copy link</button>
          </div></div>
        <div class="menu"><button class="btn" id="more-btn" title="More" aria-label="More actions">&middot;&middot;&middot;</button>
          <div class="pop" id="more-pop" hidden>
            <button id="dl-json">Download JSON</button>
            <button id="dl-csv">Download CSV</button>
            <a href="${pageURL(effCrop(n) ? effCrop(n).page : n.pages[0])}" target="_blank" rel="noopener">Open page scan</a>
            ${CFG.propose ? `<hr><a href="${esc(reportURL(n))}" target="_blank" rel="noopener">Report a problem</a>` : ''}
          </div></div>
        <span class="flash" id="flash"></span>
      </div>
    </div>
    ${EDITING ? editBar(n) : ''}`;

  if (EDITING) renderEditText(n); else renderReadText(n, mine);
  renderBanner();
  // Open on the page the crop is actually on: a notice can span two pages.
  const ec0 = effCrop(n);
  const start = PV.pid && n.pages.includes(PV.pid) ? PV.pid
    : (ec0 && n.pages.includes(ec0.page) ? ec0.page : n.pages[0]);
  renderPage(n, start);
  wireTop(n, idx);
}

function editBar(n) {
  const mine = PENDING[n.id];
  return `<div class="editbar">
    <div class="seg"><label>Text</label>${seg('rev',
      [['unreviewed', 'Not checked'], ['reviewed', 'Checked'], ['needs_attention', 'Flag']],
      reviewOf(n))}</div>
    <div class="seg"><label>Facsimile box</label>${seg('crop',
      [['unreviewed', '&mdash;'], ['accepted', 'Correct'], ['corrected', 'Adjusted'], ['rejected', 'None']],
      cropStatusOf(n))}</div>
    ${mine && mine.review_status === 'reviewed' && !(CORR[n.id] || {}).review_status
      ? '<span class="auto-rev" title="Correcting the text marks it checked. Change it if you only fixed part of it.">checked by your edit</span>' : ''}
    ${CFG.propose && mine ? `<button class="btn sm primary" id="pb-send">${mine.proposed_at ? 'Send again' : 'Send to GitHub'}</button>` : ''}
    <span class="saved flash" id="saved">Saved</span>
    <span class="note">${CFG.propose
      ? 'Changes stay in this browser until you send them as a GitHub issue (a GitHub account is required).'
      : 'Changes are saved to this computer.'}</span>
  </div>`;
}

function wireTop(n, idx) {
  const step = d => {
    const m = VIEW[idx + d];
    if (!m) return;
    const i = idx + d;
    if (Math.floor(i / PAGE_SIZE) !== page) { page = Math.floor(i / PAGE_SIZE); render(); }
    select(m.id);
    const tr = document.querySelector(`#rows tr[data-id="${CSS.escape(m.id)}"]`);
    if (tr) tr.scrollIntoView({ block: 'nearest' });
  };
  $('#st-prev').onclick = () => step(-1);
  $('#st-next').onclick = () => step(1);
  STEP = step;
  const eg = $('#edit-go');
  if (eg) eg.onclick = () => { EDITING = true; select(n.id); render(); };
  const ed = $('#edit-done');
  if (ed) ed.onclick = () => endEdit(true);
  const pop = (btn, el) => {
    $(btn).onclick = e => {
      e.stopPropagation();
      const open = $(el).hidden;
      document.querySelectorAll('.menu .pop').forEach(p => p.hidden = true);
      $(el).hidden = !open;
    };
  };
  pop('#cite-btn', '#cite-pop'); pop('#more-btn', '#more-pop');
  $('#cite-pop').onclick = e => e.stopPropagation();
  const flash = msg => {
    const f = $('#flash'); if (!f) return;
    f.textContent = msg; f.classList.add('show');
    setTimeout(() => f.classList.remove('show'), 1400);
  };
  const copy = async (txt, msg) => {
    try { await navigator.clipboard.writeText(txt); flash(msg); } catch (_) { prompt('Copy:', txt); }
    document.querySelectorAll('.menu .pop').forEach(p => p.hidden = true);
  };
  $('#cite-copy').onclick = () => copy(citation(n), 'Citation copied');
  $('#link-copy').onclick = () => copy(permalink(n), 'Link copied');
  $('#dl-json').onclick = () => {
    download(`${n.id}.json`, JSON.stringify({ meta: exportMeta([n], 'current'), records: [record(n, 'current')] }, null, 1), 'application/json');
  };
  $('#dl-csv').onclick = () => download(`${n.id}.csv`, toCSV([n], 'current'), 'text/csv');

  $('#dtop').querySelectorAll('[data-rev]').forEach(b =>
    b.onclick = () => save(n.id, { review_status: b.dataset.rev }));
  $('#dtop').querySelectorAll('[data-crop]').forEach(b => b.onclick = () => {
    const st = b.dataset.crop, ec = effCrop(n);
    // "Correct" is a judgement about a specific rectangle. Pin it.
    if (st === 'accepted' && ec) return save(n.id, { crop_status: st, crop: ec });
    if (st === 'rejected') return save(n.id, { crop_status: st, crop: null });
    if (st === 'unreviewed') return save(n.id, { crop_status: st, crop: null });
    save(n.id, { crop_status: st });
  });
  const send = $('#pb-send');
  if (send) send.onclick = () => propose(n.id);
}
let STEP = null;
document.addEventListener('click', () =>
  document.querySelectorAll('.menu .pop').forEach(p => p.hidden = true));

function endEdit(rerender) {
  if (!EDITING) return;
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  EDITING = false;
  document.body.classList.remove('editing');
  if (rerender && SEL) select(SEL);
  if (rerender) render();
  renderBanner();
}

// ------------------------------------------------- reading view of a notice
function renderReadText(n, mine) {
  const cont = pref('ui.continuous') === '1';
  const tr = pub(n, 'transcription');
  const shown = cont ? tr.replace(/\s*\n\s*/g, ' ') : tr;
  const mk = k => isEdited(n, k) ? '<span class="mk">corrected</span>' : '';
  const machine = k => isEdited(n, k)
    ? `<details class="machine"><summary>Machine reading</summary><div class="orig">${esc(n[k] || '—')}</div></details>` : '';
  const lemma = pub(n, 'monument'), desc = pub(n, 'description');
  const refs = pub(n, 'reference'), split = refs ? splitRefs(refs) : null;
  const ec = effCrop(n), src = cropSource(n);
  const c = CORR[n.id];

  const dd = (v, cls = '') => v && String(v).trim()
    ? `<dd class="${cls}">${esc(v)}</dd>` : '<dd><span class="void">—</span></dd>';

  $('#pane-text').innerHTML = `
    ${mine ? `<div class="unsent-note">You have ${mine.proposed_at ? 'sent, not yet published,' : 'unsent'} changes to this notice.
      <button class="link" id="un-edit">Edit</button>${mine.proposed_at ? '' : ' · <button class="link" id="un-discard">Discard</button>'}</div>` : ''}
    <dl class="rec">
      <dt>Location and description ${mk('monument') || mk('description')}</dt>
      ${lemma || desc ? `<dd>${lemma ? `<b>${esc(lemma)}</b> ` : ''}${esc(desc)}</dd>` : dd('')}
      ${machine('monument')}${machine('description')}

      <dt class="tdt"><span>Text ${mk('transcription')}</span>
        <span class="tbar">
          <label><input type="checkbox" id="cont" ${cont ? 'checked' : ''}> Continuous text</label>
          <details><summary>Signs</summary>
            <div class="legend">${SIGNS.map(([g, d]) => `<span class="g">${esc(g)}</span><span>${esc(d)}</span>`).join('')}
              <span></span><span class="small">The printed page is authoritative for every sign.</span></div>
          </details>
        </span></dt>
      <dd class="block">${tr.trim() ? `<div class="text">${markup(shown)}</div>`
        : '<span class="void">No transcription was extracted.</span>'}${machine('transcription')}</dd>

      <dt>Lines ${mk('nb_lignes')}</dt>${dd(pub(n, 'nb_lignes'), 'short')}${machine('nb_lignes')}

      ${split ? `
        ${split.ed ? `<dt>Previous editions ${mk('reference')}</dt>${dd(split.ed)}` : ''}
        ${split.ph ? `<dt>Photographs ${split.ed ? '' : mk('reference')}</dt>${dd(split.ph)}` : ''}`
      : `<dt>References ${mk('reference')}</dt>${dd(refs)}`}
      ${machine('reference')}

      ${pub(n, 'note').trim() || isEdited(n, 'note') ? `<dt>Note ${mk('note')}</dt>${dd(pub(n, 'note'))}${machine('note')}` : ''}
    </dl>

    <div class="prov">
      <span>Source</span><b>${volShort(n.volume)}${VOLUMES[n.volume] ? ` (${esc(surname(n.volume))} ${VOLUMES[n.volume][2]})` : ''}, p. ${esc(pub(n, 'page'))}, no. ${esc(pub(n, 'numero'))}</b>
      <span>Page scan</span><b>${n.pages.map(p => `<a href="${pageURL(p)}" target="_blank" rel="noopener">${esc(p)}</a>`).join(', ')}</b>
      <span>Extraction</span><b>machine-read (vision-language model)</b>
      <span>Facsimile box</span><b>${src === 'editor' ? 'adjusted by an editor' : src === 'detector' ? 'detected automatically' : 'none'}</b>
      ${c && (c.review_status !== 'unreviewed' || anyEdit(n)) && byWhom(n) ? `<span>Corrections</span><b>${esc(byWhom(n))}</b>` : ''}
      <span>Record</span><b>${esc(n.id)}</b>
      ${CFG.propose ? `<span></span><b><a href="${esc(reportURL(n))}" target="_blank" rel="noopener">Report a problem</a>
        · <a href="https://github.com/${CFG.propose}/issues?q=${encodeURIComponent('"' + n.id + '"')}" target="_blank" rel="noopener">Correction history</a></b>` : ''}
    </div>`;

  $('#cont').onchange = e => { pref('ui.continuous', e.target.checked ? '1' : '0'); renderReadText(n, mine); };
  const ue = $('#un-edit');
  if (ue) ue.onclick = () => { EDITING = true; select(n.id); render(); };
  const ud = $('#un-discard');
  if (ud) ud.onclick = () => {
    if (!confirm('Discard your unsent changes to this notice?')) return;
    delete PENDING[n.id]; savePending(); select(n.id); render();
  };
}

// None of the signs is on a keyboard, and the corpus is defined by getting
// them exactly right - so they are buttons. Wrap the selection, or insert at
// the cursor with the caret left between the pair.
const MARKS = [
  ['⎡', '⎤', 'restored', 'text restored by the editor'],
  ['⎣', '⎦', 'correction', 'editor’s correction or addition'],
  ['[', ']', 'brackets', 'square brackets as printed'],
  ['...', '', 'lacuna', 'lost text'],
  ['/', '', 'line', 'line division as printed'],
];

function insertMark(el, open, close) {
  const s = el.selectionStart, e = el.selectionEnd, v = el.value;
  const sel = v.slice(s, e);
  el.value = v.slice(0, s) + open + sel + close + v.slice(e);
  const at = sel ? s + open.length + sel.length + close.length : s + open.length;
  el.focus();
  el.setSelectionRange(at, at);
  el.dataset.touched = '1';
}

function renderEditText(n) {
  const order = ['transcription', 'monument', 'description', 'nb_lignes', 'reference', 'note', 'page', 'numero'];
  $('#pane-text').innerHTML = `
    <div class="preview">${eff(n, 'transcription') ? markup(eff(n, 'transcription')) : '<span class="void">No transcription</span>'}</div>
    ${order.map(k => {
      const v = eff(n, k), dirty = isEdited(n, k);
      const big = ['transcription', 'description', 'reference', 'note'].includes(k);
      const rows = k === 'transcription' ? 8 : k === 'description' ? 3 : 2;
      return `<div class="fld ${dirty ? 'dirty' : ''}" data-k="${k}">
        <label>${LABEL[k]}
          ${dirty ? '<button class="rev">Revert</button>' : ''}
          ${!String(v).trim() ? '<span class="empty-note">empty</span>' : ''}</label>
        ${big ? `<textarea rows="${rows}">${esc(v)}</textarea>` : `<input value="${esc(v)}">`}
        ${k === 'transcription' ? `<div class="marks">${MARKS.map(([o, c, lbl, tip], i) =>
          `<button data-m="${i}" title="${esc(tip)} — wraps the selection"><b>${esc(o + (c ? ' ' + c : ''))}</b>${esc(lbl)}</button>`
          ).join('')}</div>` : ''}
        <div class="orig">Machine: ${esc(n[k] ?? '')}</div>
      </div>`;
    }).join('')}`;

  $('#pane-text').querySelectorAll('.fld').forEach(d => {
    const k = d.dataset.k, el = d.querySelector('textarea,input');
    const commit = () => {
      delete el.dataset.touched;
      save(n.id, { fields: { [k]: el.value === (n[k] ?? '') ? null : el.value } });
    };
    el.onchange = commit;
    // A sign inserted by button does not always set the browser's own dirty
    // flag, so a blur after clicking only buttons would otherwise lose the edit.
    el.onblur = () => { if (el.dataset.touched) commit(); };
    d.querySelectorAll('[data-m]').forEach(b => b.onmousedown = ev => {
      ev.preventDefault();
      const [o, c] = MARKS[+b.dataset.m];
      insertMark(el, o, c);
    });
    const rev = d.querySelector('.rev');
    if (rev) rev.onclick = () => save(n.id, { fields: { [k]: null } });
  });
}

const PAIRING_HELP = {
  auto: 'the page had as many drawings as notices, so they were paired in reading order',
  ambiguous: 'the counts did not match, so no box was assumed',
  none: 'the detector found no drawing on this page',
};

// ------------------------------------------------- page viewer, in the pane
// Proofreading is a comparison, so the page scales inside its own pane, next
// to the text. The view state survives the re-render that follows every save.
let PV = { pid: null, zoom: 'width', sl: 0, st: 0, scale: 1, off: null };

function renderPage(n, pid) {
  const geo = n.page_geometry[pid];
  if (PV.pid !== pid) Object.assign(PV, { pid, zoom: 'width', sl: 0, st: 0, scale: 1 });

  if (!geo) {
    $('#pane-page').innerHTML = `<div class="nocrop">No page image for ${esc(pid || '-')}</div>`;
    return;
  }
  const hc = humanCrop(n), ec = effCrop(n);
  const tabs = n.pages.length > 1
    ? `<div class="pagetabs">${n.pages.map(p =>
        `<button data-pg="${esc(p)}" class="${p === pid ? 'on' : ''}"
           title="${ec && ec.page === p ? 'the facsimile drawing is on this page' : ''}"
          >${esc(p.replace(/^CatInsc_\d+_0*/, 'scan '))}${ec && ec.page === p ? ' &#9679;' : ''}</button>`).join('')}</div>` : '';

  const yolo = EDITING && pid === n.pages[0] ? n.yolo_boxes : [];
  const isEff = b => ec && ec.page === pid && ec.box.join() === b.join();
  const pcBox = b => `left:${100 * b[0] / geo.width}%;top:${100 * b[1] / geo.height}%;` +
                     `width:${100 * (b[2] - b[0]) / geo.width}%;height:${100 * (b[3] - b[1]) / geo.height}%`;
  const effBox = ec && ec.page === pid
    ? (EDITING
      ? `<div class="bx edit" id="ebox" style="${pcBox(ec.box)}">
          <label>${hc ? 'yours' : 'detector'}</label>
          ${['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map(h => `<span class="hd" data-h="${h}"></span>`).join('')}
        </div>`
      : `<div class="bx view" style="${pcBox(ec.box)}"></div>`)
    : '';

  $('#pane-page').innerHTML = `
    <div class="pagecard">
      <div class="pvtools">
        <h3>Printed page</h3>
        <div class="seg2" id="zoom">
          <button data-z="fit">Fit</button><button data-z="width">Width</button>
          <button data-z="1">100%</button><button data-z="2">200%</button>
        </div>
        <span class="zpct" id="zpct" title="Pinch, or hold Ctrl and scroll, to zoom"></span>
        ${tabs}
        <a class="vopen" href="${pageURL(pid)}" target="_blank" rel="noopener">Full scan &#8599;</a>
      </div>
      ${ec ? cropStrip(n, ec) : ''}
      <div class="pageview" id="pv"><div class="stage" id="stage">
        <img src="${pageURL(pid)}" alt="Page ${esc(pid)}" draggable="false">
        ${yolo.filter(b => !isEff(b.box)).map(b =>
          `<div class="bx" data-box="${b.box.join(',')}" style="${pcBox(b.box)}"
             title="detection, confidence ${b.conf} — click to use this box"><label>${b.conf}</label></div>`).join('')}
        ${effBox}
      </div></div>
      ${EDITING ? `<div class="pvmeta">
        <span>${esc(pid)} · ${geo.width}&times;${geo.height} px</span>
        <span title="${PAIRING_HELP[n.yolo_pairing] || ''}">${yolo.length} detection(s), pairing ${esc(n.yolo_pairing)}</span>
        <span><kbd>Shift</kbd>+drag: new box${ec ? ' · <kbd>Del</kbd>: remove' : ''}</span>
        ${ec ? '<button class="btn sm" id="crop-remove" title="No facsimile for this notice, or the box is on the wrong drawing">No facsimile</button>' : ''}
        ${hc ? '<button class="btn sm" id="draw-clear">Reset box</button>' : ''}
        ${!ec && cropStatusOf(n) === 'rejected' && yolo.length ? '<button class="btn sm" id="crop-restore">Show detections</button>' : ''}
      </div>
      ${!ec ? `<div class="nocrop">${cropStatusOf(n) === 'rejected' ? 'Marked as having no facsimile'
          : yolo.length ? 'No box paired — click a detection' : 'No drawing detected on this page'}</div>` : ''}` : ''}
      ${ec && ec.page !== pid ? `<div class="nocrop">The facsimile drawing is on ${esc(ec.page)}</div>` : ''}
    </div>`;

  wirePage(n, pid, geo);
}

// A crop is coordinates, so the browser cuts it out of the page scan with CSS.
function cropStrip(n, ec) {
  const g = n.page_geometry[ec.page];
  if (!g) return '';
  const [x1, y1, x2, y2] = ec.box;
  const cw = x2 - x1, ch = y2 - y1;
  return `<div class="cropstrip">
    <span class="cap">Facsimile drawing · ${cropSource(n) === 'editor' ? 'box adjusted by an editor' : 'detected automatically'}</span>
    <div class="cropwin" style="aspect-ratio:${cw} / ${ch}">
      <img src="${pageURL(ec.page)}" alt="Facsimile drawing from ${esc(ec.page)}"
           style="width:${100 * g.width / cw}%;left:${-100 * x1 / cw}%;top:${-100 * y1 / ch}%">
    </div></div>`;
}

function wirePage(n, pid, geo) {
  const pv = $('#pv'), stage = $('#stage');

  // Zoom: four presets, plus pinch. macOS reports a pinch as a wheel event
  // with ctrlKey, which must be prevented or the browser zooms itself.
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
  // Scale about the point under the cursor.
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

  // The pane has no width on the first frame after it is revealed; recompute
  // whenever it actually resizes.
  if (window.ResizeObserver) {
    const ro = new ResizeObserver(() => {
      if (PV.zoom === 'fit' || PV.zoom === 'width') setZoom(PV.zoom);
    });
    ro.observe(pv);
    if (PV.ro) PV.ro.disconnect();
    PV.ro = ro;
  }

  pv.addEventListener('wheel', e => {
    if (!e.ctrlKey && !e.metaKey) return;
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

  // ---- pan / move / resize / draw, all decided at mousedown. Reading mode
  // only ever pans: nothing a reader does to the page can stage a correction.
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
    if (EDITING && e.target.closest('.bx[data-box]')) return;
    start = toPage(e); live = null;
    if (EDITING && hd && ebox) { mode = 'resize:' + hd.dataset.h; box0 = boxOf(ebox); }
    else if (EDITING && onEdit && ebox) { mode = 'move'; box0 = boxOf(ebox); }
    else if (EDITING && e.shiftKey) {
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
    // The detector's box is never written to; this creates a human crop that shadows it.
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
// Widths persist; double-click a divider to reset it.
function makeSplit(handle, target, key, min, max) {
  const saved = parseFloat(pref(key) || '');
  if (saved) target.style.width = saved + 'px';
  handle.addEventListener('dblclick', () => {
    try { localStorage.removeItem(key); } catch (_) {}
    target.style.width = ''; refit();
  });
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
      pref(key, parseFloat(target.style.width));
      refit();
    };
    addEventListener('mousemove', mv); addEventListener('mouseup', up);
  });
}
makeSplit($('#split-main'), $('#list'), 'pane.list', 280, 1100);
makeSplit($('#split-detail'), $('#pane-text'), 'pane.text', 260, 1000);

// ---------------------------------------------------------------- save
// The single gate on every write path: outside the edit session of this very
// notice, nothing a visitor does can stage or save a correction.
async function save(id, payload) {
  if (!EDITING || id !== SEL) return;
  if (!CFG.api) return stage(id, payload);
  const r = await fetch(CFG.api + '/notices/' + encodeURIComponent(id),
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const d = await r.json();
  if (d.error) { alert(d.error); return; }
  if (d.correction) CORR[id] = d.correction; else delete CORR[id];
  HAY.delete(id);
  select(id);
  const s = $('#saved');
  if (s) { s.classList.add('show'); setTimeout(() => s.classList.remove('show'), 1100); }
}

// ------------------------------------------------- proposals (public site)
// raw.githubusercontent is unlimited but cached for about five minutes; the
// API is current but allows 60 requests an hour. So: the CDN for ordinary
// reading, the API only while someone is waiting on a correction of their own.
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
  if (btn) { btn.disabled = true; btn.textContent = 'Checking…'; }
  const live = await fetchCorrections({ fresh: true });
  if (live) { CORR = live; CORR_AT = new Date(); HAY.clear(); }
  const before = Object.keys(PENDING).length;
  reconcilePending();
  if (VIEWNAME === 'browse') { render(); if (SEL) select(SEL); }
  renderBanner();
  return before - Object.keys(PENDING).length;
}

// While something is awaiting GitHub, look again on a timer - a bounded
// number of times, so an abandoned tab does not spend the API limit.
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
// data, not when the issue form opens: we never learn whether someone pressed
// Create. Comparing against what actually landed is the only honest signal.
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
    const cropStatusDone = !p.crop_status || live.crop_status === p.crop_status;
    if (fieldsDone && cropDone && statusDone && cropStatusDone) {
      delete PENDING[id]; changed = true;
    }
  }
  if (changed) savePending();
}
function stage(id, payload) {
  const p = PENDING[id] || (PENDING[id] = { id, fields: {} });
  // Correcting a notice IS reviewing it - you cannot fix a transcription without
  // having read it against the page. So the first substantive edit marks it
  // reviewed. Only as a default: an explicit choice wins, and it never
  // overrides a state already recorded in the published data.
  const substantive = Object.keys(payload.fields || {}).length || 'crop' in payload;
  if (substantive && !payload.review_status && !p.review_status
      && !(CORR[id] || {}).review_status) {
    p.review_status = 'reviewed';
  }
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
  savePending(); select(id); render(); renderBanner();
}

// The body carries ONLY the corrected value: including the model's value
// pushed 1% of notices past GitHub's URL cap for information the Action can
// look up itself.
function issueBody(n, p) {
  const payload = { id: n.id, fields: p.fields || {} };
  if (p.crop) payload.crop = p.crop;
  if (p.crop_status) payload.crop_status = p.crop_status;
  if (p.review_status) payload.review_status = p.review_status;
  return [
    `Notice **${n.id}** - volume ${n.volume}, page ${pub(n, 'page')}, no ${pub(n, 'numero')}`,
    pub(n, 'monument') ? `Monument: ${pub(n, 'monument')}` : '',
    '', 'Corrected: ' + ([...Object.keys(p.fields || {}),
        p.crop ? 'crop' : null, p.crop_status ? `crop marked ${p.crop_status}` : null,
        p.review_status ? `marked ${p.review_status.replace('_', ' ')}` : null]
        .filter(Boolean).join(', ') || 'nothing'),
    '', '<!-- correction:begin -->', '```json',
    JSON.stringify(payload, null, 1), '```', '<!-- correction:end -->', '',
    '_Submitted from the proofreading interface. Do not edit the block above -',
    'it is applied automatically to the data repository._',
  ].filter(x => x !== null).join('\n');
}

function issueURL(n, p) {
  const q = new URLSearchParams({
    title: `Correction: ${n.id} (${[...Object.keys(p.fields || {}),
      p.crop ? 'crop' : (p.crop_status ? 'crop ' + p.crop_status : null)]
      .filter(Boolean).join(', ') || 'review'})`,
    labels: 'correction',
    body: issueBody(n, p),
  });
  return `https://github.com/${CFG.propose}/issues/new?${q}`;
}

// Before anything opens: precisely what will go.
function describe(n, p) {
  const rows = [];
  for (const [k, v] of Object.entries(p.fields || {})) {
    const was = n[k] ?? '';
    rows.push(`<div class="cf-row"><b>${esc(LABEL[k] || k)}</b>
      <div class="cf-was">${was ? esc(was.slice(0, 240)) + (was.length > 240 ? '…' : '')
        : '<i>nothing was extracted</i>'}</div>
      <div class="cf-now">${esc(v.slice(0, 240))}${v.length > 240 ? '…' : ''}</div></div>`);
  }
  if (p.crop) rows.push(`<div class="cf-row"><b>Facsimile box</b>
    <div class="cf-now">${p.crop.box[2] - p.crop.box[0]}&times;${p.crop.box[3] - p.crop.box[1]} px
      on ${esc(p.crop.page)}</div></div>`);
  if (p.crop_status) rows.push(`<div class="cf-row"><b>Facsimile box marked</b>
    <div class="cf-now">${esc(p.crop_status)}</div></div>`);
  if (p.review_status) rows.push(`<div class="cf-row"><b>Notice marked</b>
    <div class="cf-now">${esc(p.review_status.replace('_', ' '))}</div></div>`);
  return rows.join('') || '<div class="cf-row"><i>nothing to send</i></div>';
}

function propose(id) {
  const n = BYID.get(id), p = PENDING[id];
  if (!n || !p) return;
  $('#cf-what').innerHTML = describe(n, p);
  $('#confirm').hidden = false;
  $('#cf-go').onclick = () => { $('#confirm').hidden = true; sendToGitHub(id); };
  $('#cf-cancel').onclick = () => { $('#confirm').hidden = true; };
}

async function sendToGitHub(id) {
  const n = BYID.get(id), p = PENDING[id];
  if (!n || !p) return;
  const url = issueURL(n, p);
  p.proposed_at = new Date().toISOString();
  savePending(); renderBanner(); startPolling();
  if (SEL === id) select(id);
  if (url.length < 8000) { open(url, '_blank', 'noopener'); return; }
  // Above GitHub's cap the query string 414s, so hand it over by clipboard.
  try {
    await navigator.clipboard.writeText(issueBody(n, p));
    alert('This correction is too long for a pre-filled link, so it has been '
        + 'copied to your clipboard. A blank issue will open: paste it in.');
  } catch (_) {
    alert('This correction is too long for a pre-filled link. Copy the text from '
        + 'the transcription box, open the issue, and paste it in.');
  }
  open(`https://github.com/${CFG.propose}/issues/new?labels=correction`, '_blank', 'noopener');
}

// Readers never see the pending bar. Inside an edit session it is the list of
// what is waiting; outside, a small header badge keeps unsent work findable.
function renderBanner() {
  const bar = $('#propose-bar'), badge = $('#unsent');
  const ids = Object.keys(PENDING);
  const sent = ids.filter(i => PENDING[i].proposed_at).length;
  const unsent = ids.length - sent;
  badge.hidden = !CFG.propose || EDITING || !ids.length;
  if (!badge.hidden) {
    badge.textContent = unsent ? `${unsent} unsent` : `${sent} sent`;
    badge.title = unsent ? 'Corrections kept in this browser, not yet sent to GitHub'
                         : 'Submitted to GitHub, not yet published';
    badge.onclick = () => go(`#/browse?flag=${unsent ? 'pending' : 'awaiting'}`);
  }
  bar.hidden = !CFG.propose || !EDITING || !ids.length;
  if (bar.hidden) return;
  bar.innerHTML = `
    ${unsent ? `<button class="link" data-goto="pending"><b>${unsent}</b> unsent</button>` : ''}
    ${sent ? `<button class="link" data-goto="awaiting"
        title="Submitted to GitHub. Corrections usually appear within a few minutes."><b>${sent}</b> sent</button>` : ''}
    ${sent ? '<button class="btn" id="pb-check">Refresh</button>' : ''}
    ${SEL && PENDING[SEL] && PENDING[SEL].proposed_at ? '<button class="btn" id="pb-done">Dismiss</button>' : ''}
    <button class="link end" id="pb-clear">Discard all</button>`;
  bar.querySelectorAll('[data-goto]').forEach(b =>
    b.onclick = () => { setFilter({ flag: b.dataset.goto }); EDITING = true; renderBanner(); });
  const chk = $('#pb-check');
  if (chk) chk.onclick = async () => {
    const n = await checkNow(chk);
    if (!n && $('#pb-check')) {
      $('#pb-check').disabled = false;
      $('#pb-check').textContent = 'Not yet';
    }
  };
  const done = $('#pb-done');
  if (done) done.onclick = () => { delete PENDING[SEL]; savePending(); select(SEL); render(); };
  $('#pb-clear').onclick = () => {
    if (!confirm(`Discard all ${ids.length} unsubmitted corrections?`)) return;
    PENDING = {}; savePending(); renderBanner(); if (SEL) select(SEL); render();
  };
}

// ---------------------------------------------------------------- keyboard
const typing = () => {
  const t = document.activeElement;
  return t && (['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || t.isContentEditable);
};
addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (!$('#confirm').hidden) { $('#confirm').hidden = true; return; }
    document.querySelectorAll('.menu .pop').forEach(p => p.hidden = true);
    return;
  }
  if (VIEWNAME !== 'browse' || !SEL || typing() || !$('#confirm').hidden) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'ArrowLeft' && STEP) { e.preventDefault(); STEP(-1); return; }
  if (e.key === 'ArrowRight' && STEP) { e.preventDefault(); STEP(1); return; }
  // Delete removes the box, but only inside the edit session.
  if ((e.key === 'Delete' || e.key === 'Backspace') && EDITING) {
    if (document.activeElement && document.activeElement.tagName === 'BUTTON') return;
    const n = BYID.get(SEL);
    if (!n || !effCrop(n)) return;
    e.preventDefault();
    save(SEL, { crop: null, crop_status: 'rejected' });
  }
});

// ---------------------------------------------------------------- export
// Built in the browser from what this page holds: the extraction it shipped
// with and the corrections it read live from the data repository. Unsent
// local edits are never included.
const EXPORT_FIELDS = ['page', 'numero', 'monument', 'description', 'transcription',
                       'nb_lignes', 'reference', 'note'];

function pubCrop(n) {
  const c = CORR[n.id];
  if (c && c.crop) return { page: c.crop.page, box: c.crop.box, source: 'editor' };
  if (c && c.crop_status === 'rejected') return null;
  return n.yolo_box ? { page: n.pages[0], box: n.yolo_box.box, source: 'detector' } : null;
}

function record(n, vals, geo = false) {
  const c = CORR[n.id] || {};
  const corrected = EDITABLE.filter(k => c.fields && k in c.fields && c.fields[k] !== (n[k] ?? ''));
  const vt = VOLUMES[n.volume];
  const r = { id: n.id, volume: n.volume,
    volume_title: vt ? vt[0] : '', volume_editors: vt ? vt[1] : '', volume_year: vt ? vt[2] : '' };
  for (const k of EXPORT_FIELDS) r[k] = vals === 'machine' ? (n[k] ?? '') : pub(n, k);
  if (vals === 'both') { r.machine = {}; for (const k of EXPORT_FIELDS) r.machine[k] = n[k] ?? ''; }
  Object.assign(r, {
    review_status: c.review_status || 'unreviewed',
    corrected_fields: corrected,
    corrected_by: c.updated_by && c.updated_by !== 'local' ? c.updated_by : '',
    corrected_at: c.updated_at || '',
    crop: pubCrop(n), crop_status: c.crop_status || 'unreviewed',
    scan_pages: n.pages, scan_urls: n.pages.map(pageURL),
    permalink: permalink(n),
  });
  if (geo) Object.assign(r, { page_geometry: n.page_geometry, yolo_boxes: n.yolo_boxes,
                              yolo_box: n.yolo_box, yolo_pairing: n.yolo_pairing });
  return r;
}

const csvCell = v => {
  const s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
function toCSV(rows, vals, geo = false) {
  const head = ['id', 'volume', 'volume_title', 'volume_year', ...EXPORT_FIELDS,
    ...(vals === 'both' ? EXPORT_FIELDS.map(k => k + '_machine') : []),
    'review_status', 'corrected_fields', 'corrected_by', 'corrected_at',
    'crop_page', 'crop_box', 'crop_source', 'scan_pages', 'scan_urls', 'permalink',
    ...(geo ? ['page_geometry', 'yolo_boxes', 'yolo_pairing'] : [])];
  const lines = [head.join(',')];
  for (const n of rows) {
    const r = record(n, vals, geo);
    const flat = { ...r,
      ...(vals === 'both' ? Object.fromEntries(EXPORT_FIELDS.map(k => [k + '_machine', r.machine[k]])) : {}),
      corrected_fields: r.corrected_fields.join(' '),
      crop_page: r.crop ? r.crop.page : '', crop_box: r.crop ? r.crop.box.join(' ') : '',
      crop_source: r.crop ? r.crop.source : '',
      scan_pages: r.scan_pages.join(' '), scan_urls: r.scan_urls.join(' ') };
    lines.push(head.map(k => csvCell(flat[k])).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

function download(name, text, mime) {
  const bom = mime === 'text/csv' ? '﻿' : '';
  const url = URL.createObjectURL(new Blob([bom + text], { type: mime + ';charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

let PROV = null;
async function provenance() {
  if (PROV) return PROV;
  const noticesURL = CFG.data ? new URL(`${CFG.data}/notices.json`, location.href).href : null;
  PROV = { notices: { url: noticesURL }, corrections: { url: CFG.live } };
  if (noticesURL) {
    try {
      const r = await fetch(noticesURL, { method: 'HEAD', cache: 'no-cache' });
      PROV.notices.modified = r.headers.get('last-modified');
    } catch (_) {}
  }
  if (CFG.propose) {
    try {
      const r = await fetch(`https://api.github.com/repos/${CFG.propose}/commits?path=corrections.json&per_page=1`);
      if (r.ok) {
        const [c] = await r.json();
        if (c) Object.assign(PROV.corrections, { commit: c.sha, date: c.commit.committer.date, html: c.html_url,
          pinned: `https://raw.githubusercontent.com/${CFG.propose}/${c.sha}/corrections.json` });
      }
    } catch (_) {}
  }
  return PROV;
}

function exportMeta(rows, vals, scopeLabel = '') {
  const p = PROV || {};
  return {
    title: 'Armenian Inscriptions: Divan of Armenian Inscriptions, vols I–X (machine-read)',
    publisher: 'Calfa', site: SITE, licence: 'CC BY-SA 4.0',
    licence_url: 'https://creativecommons.org/licenses/by-sa/4.0/',
    generated_at: new Date().toISOString(),
    scope: scopeLabel, records: rows.length, values: vals,
    sources: {
      notices: { url: (p.notices || {}).url || null, last_modified: (p.notices || {}).modified || null },
      corrections: { url: CFG.live, loaded_at: CORR_AT ? CORR_AT.toISOString() : null,
                     latest_commit: (p.corrections || {}).commit || null,
                     latest_commit_date: (p.corrections || {}).date || null,
                     records: Object.keys(CORR).length },
      scans: CFG.images,
    },
    merge_rule: 'Each field takes the published correction when one exists, otherwise the machine extraction. Unsent local edits are excluded.',
    note: 'Machine-read records may contain errors; the printed page is authoritative.',
  };
}

const describeFilters = f => [
  f.vol ? volShort(f.vol) : '', f.status ? `status: ${$('#fstatus').querySelector(`[value="${f.status}"]`).textContent.toLowerCase()}` : '',
  f.flag && FLAGS[f.flag] ? FLAGS[f.flag][0].toLowerCase() : '', f.q ? `search “${f.q}”` : '',
].filter(Boolean).join(', ');

function renderData(params) {
  const vols = VOLS();
  const scopeParam = params.get('scope');
  const hasResults = VIEW.length !== NOTICES.length;
  $('#exp-scope').innerHTML = `
    <label><input type="radio" name="scope" value="all" ${scopeParam !== 'results' ? 'checked' : ''}> All notices (${fmtN(NOTICES.length)})</label>
    <label><input type="radio" name="scope" value="vol"> Volume
      <select id="exp-vol">${vols.map(v => `<option value="${esc(v)}">${volShort(v)} — ${esc((VOL_EN[v] || [''])[0])}</option>`).join('')}</select></label>
    <label><input type="radio" name="scope" value="results" ${scopeParam === 'results' ? 'checked' : ''} ${hasResults ? '' : 'disabled'}>
      Current results (${fmtN(VIEW.length)})${hasResults ? ` <span class="small">${esc(describeFilters(F))}</span>` : ''}</label>
    <span class="hint">“Current results” follows the filters and search set in Browse.</span>`;
  $('#exp-vol').onfocus = () => { document.querySelector('input[name=scope][value=vol]').checked = true; summary(); };

  const opts = () => {
    const scope = document.querySelector('input[name=scope]:checked').value;
    const vals = document.querySelector('input[name=vals]:checked').value;
    const fmt = document.querySelector('input[name=fmt]:checked').value;
    const geo = $('#exp-geo').checked;
    const vol = $('#exp-vol').value;
    const rows = scope === 'all' ? NOTICES : scope === 'vol' ? NOTICES.filter(n => n.volume === vol) : VIEW;
    const label = scope === 'all' ? 'all notices' : scope === 'vol' ? volShort(vol) : `results: ${describeFilters(F)}`;
    const tag = scope === 'all' ? 'all' : scope === 'vol' ? `vol${vol}` : 'results';
    return { scope, vals, fmt, geo, rows, label, tag };
  };
  const summary = () => {
    const o = opts();
    $('#exp-sum').textContent = `${fmtN(o.rows.length)} records · ${o.fmt.toUpperCase()} · ${
      { current: 'current values', machine: 'machine values only', both: 'current and machine values' }[o.vals]}`;
  };
  document.querySelectorAll('#exp input, #exp select').forEach(i => i.onchange = summary);
  summary();

  const go = $('#exp-go');
  go.disabled = false;
  go.onclick = async () => {
    const o = opts();
    go.disabled = true; go.textContent = 'Preparing…';
    await provenance();
    const date = new Date().toISOString().slice(0, 10);
    const sha = PROV.corrections.commit ? '_' + PROV.corrections.commit.slice(0, 7) : '';
    const base = `armenian-inscriptions_${o.tag}_${date}${sha}`;
    if (o.fmt === 'csv') download(base + '.csv', toCSV(o.rows, o.vals, o.geo), 'text/csv');
    else if (o.fmt === 'json') download(base + '.json', JSON.stringify({
      meta: exportMeta(o.rows, o.vals, o.label), records: o.rows.map(n => record(n, o.vals, o.geo)) }, null, 1), 'application/json');
    else download(base + '.jsonl', o.rows.map(n => JSON.stringify(record(n, o.vals, o.geo))).join('\n') + '\n', 'application/x-ndjson');
    go.disabled = false; go.textContent = 'Download';
  };

  renderSources();
  provenance().then(renderSources);

  $('#fields-dict').innerHTML = `<thead><tr><th>Field</th><th>Content</th></tr></thead><tbody>${[
    ['id', 'Record identifier, derived from volume and number at extraction. Used in permalinks; may change while volume and number are corrected.'],
    ['volume, volume_title, volume_year', 'Volume of the Divan, its title and year of publication.'],
    ['page, numero', 'Printed page and number of the notice in the volume.'],
    ['monument', 'Lemma: the opening words of the printed notice, usually a locator that continues into the description.'],
    ['description', 'Location of the inscription and description of its support, as printed.'],
    ['transcription', 'Diplomatic text with the editorial signs as printed. Line breaks mostly follow the printed page, not the stone; “/” marks line division where the edition gives it.'],
    ['nb_lignes', 'Number of lines, as stated by the editor.'],
    ['reference', 'Previous editions (Հրատ.) and photographs (Լուսանկ.), as printed.'],
    ['note', 'Editor’s note; occasionally a translation (Թարգմ.).'],
    ['*_machine', 'With “Both”: the machine extraction of each field, whether or not it was corrected.'],
    ['review_status', 'unreviewed, reviewed (checked against the scan) or needs_attention (flagged).'],
    ['corrected_fields, corrected_by, corrected_at', 'Fields changed by a specialist, with the contributor and date recorded in the data repository.'],
    ['crop, crop_status', 'Facsimile drawing box on the scan: page, [x1, y1, x2, y2] in scan pixels, and whether it came from the detector or an editor.'],
    ['scan_pages, scan_urls', 'Scanned page(s) the notice was read from, and their full-resolution images.'],
    ['permalink', 'Address of the notice on this site.'],
  ].map(([k, d]) => `<tr><td><code>${esc(k)}</code></td><td>${esc(d)}</td></tr>`).join('')}</tbody>`;
}

function renderSources() {
  const p = PROV || { notices: {}, corrections: {} };
  const dup = (() => {
    const c = new Map();
    NOTICES.forEach(n => { const k = n.volume + '|' + n.numero; c.set(k, (c.get(k) || 0) + 1); });
    return [...c.values()].filter(x => x > 1).length;
  })();
  const repo = CFG.propose ? `https://github.com/${CFG.propose}` : null;
  $('#srcs').innerHTML = `<table class="tbl">
    <tr><td>Machine extraction</td><td>
      ${p.notices.url ? `<a href="${esc(p.notices.url)}">${esc(p.notices.url.replace(/^https?:\/\//, ''))}</a>` : 'local server'}
      <span class="state">· ${fmtN(NOTICES.length)} notices${p.notices.modified ? ` · published ${esc(new Date(p.notices.modified).toISOString().slice(0, 10))}` : ''}</span>
      ${repo ? `<br><span class="state">Canonical copy: <a href="${repo}/blob/main/notices.jsonl" target="_blank" rel="noopener">notices.jsonl</a> in the data repository</span>` : ''}</td></tr>
    <tr><td>Corrections</td><td>
      ${CFG.live ? `<a href="${esc(CFG.live)}" target="_blank" rel="noopener">corrections.json</a>` : 'local server'}
      <span class="state">· ${fmtN(Object.keys(CORR).length)} records, read live${CORR_AT ? ' at ' + CORR_AT.toTimeString().slice(0, 5) : ''}</span>
      ${p.corrections.commit ? `<br><span class="state">Latest commit <a href="${esc(p.corrections.html)}" target="_blank" rel="noopener"><code>${p.corrections.commit.slice(0, 7)}</code></a>
        (${esc(p.corrections.date.slice(0, 10))}) · <a href="${esc(p.corrections.pinned)}" target="_blank" rel="noopener">pinned copy</a></span>` : ''}
      ${repo ? `<br><span class="state"><a href="${repo}/commits/main/corrections" target="_blank" rel="noopener">History of corrections</a></span>` : ''}</td></tr>
    <tr><td>Page scans</td><td><code>${esc(CFG.images || '/page')}/vol&lt;n&gt;/&lt;scan&gt;.jpg</code>
      <span class="state">· full resolution, linked from each record</span></td></tr>
  </table>
  <h3 class="h3">Known limitations</h3>
  <ul class="prose small">
    <li>Records are machine-read and largely unchecked; the printed page is authoritative.</li>
    <li>The site (village, monastery) under which a notice is printed is not extracted.</li>
    <li>Identifiers follow the extracted numbering: ${fmtN(dup)} volume/number pairs occur more than once.</li>
    <li><code>reference</code> mixes previous editions and photographs; <code>note</code> occasionally holds a translation.</li>
    <li>Line breaks in <code>transcription</code> mostly reproduce the printed page; overlines marking abbreviations and numerals are not reproduced.</li>
  </ul>`;
}

// ---------------------------------------------------------------- about
function renderAbout(sec) {
  if (!$('#notation').innerHTML) {
    $('#notation').innerHTML = `<tbody>${SIGNS.map(([g, d]) =>
      `<tr><td>${esc(g)}</td><td>${esc(d)}</td></tr>`).join('')}</tbody>`;
    $('#bib-divan').innerHTML = Object.keys(VOLUMES).map(v => {
      const [t, , y] = VOLUMES[v], [en, ed] = VOL_EN[v];
      return `<li>${esc(ed)}. <span class="arm">Դիվան հայ վիմագրության</span>, ${roman(v)}:
        <span class="arm">${esc(t)}</span> [Divan of Armenian Inscriptions ${roman(v)}: ${esc(en)}]. Yerevan, ${y}.</li>`;
    }).join('');
    $('#cite-example').textContent = 'Divan hay vimagrutʻyan V (Barkhudaryan 1982), p. 20, no. 27. '
      + `Armenian Inscriptions, Calfa, record v5-n27, ${SITE}#/notice/v5-n27 `
      + '(machine-read, not yet checked; accessed 2026-10-07). CC BY-SA 4.0.';
  }
  if (LOADED) $('#artsakh-count').textContent = `· ${fmtN(NOTICES.filter(n => n.volume === '5').length)} notices`;
  const id = sec || 'project';
  document.querySelectorAll('#toc a').forEach(a => a.classList.toggle('on', a.dataset.sec === id));
  const el = $('#s-' + id);
  if (el && sec) el.scrollIntoView({ block: 'start' });
  else $('#v-about').scrollTop = 0;
}

// ---------------------------------------------------------------- wiring
$('#rows').addEventListener('click', e => {
  const tr = e.target.closest('tr'); if (tr) select(tr.dataset.id);
});
document.querySelectorAll('.rows thead th[data-sort]').forEach(th => {
  th.insertAdjacentHTML('beforeend', '<span class="caret">&#9650;</span>');
  th.onclick = () => {
    if (sortKey === th.dataset.sort) sortAsc = !sortAsc;
    else { sortKey = th.dataset.sort; sortAsc = true; }
    apply();
  };
});
let qt;
$('#q').oninput = () => {
  clearTimeout(qt);
  qt = setTimeout(() => { if (LOADED) setFilter({ q: $('#q').value.trim() }); }, 200);
};
$('#q').onkeydown = e => { if (e.key === 'Enter' && LOADED) { clearTimeout(qt); setFilter({ q: $('#q').value.trim() }); } };
$('#fvol').onchange = () => setFilter({ vol: $('#fvol').value });
$('#fstatus').onchange = () => setFilter({ status: $('#fstatus').value });

route();
load().catch(err => {
  $('#figures').innerHTML = `<span class="loading">The corpus could not be loaded (${esc(err.message)}).</span>`;
});
