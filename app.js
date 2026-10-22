'use strict';

// ===== 상수 =====
const DB_NAME = 'cardbox';
const STORE = 'cards';
const PHOTO_MAX = 1400;   // 원본 사진 긴 변(px)
const THUMB_MAX = 420;    // 목록 썸네일 긴 변(px)
const STATUSES = ['보유', '판매예정', '판매완료', '위시'];
const TEXT_FIELDS = ['player', 'team', 'nation', 'season', 'status', 'brand', 'set', 'cardNo', 'parallel',
  'serial', 'grader', 'grade', 'condition', 'buyDate', 'buyFrom', 'location', 'memo'];
const NUM_FIELDS = ['buyPrice', 'value'];
const BOOL_FIELDS = ['rookie', 'auto', 'patch'];
const AUTOCOMPLETE = ['player', 'team', 'nation', 'season', 'brand', 'set', 'parallel', 'buyFrom', 'location'];
const ATTR_FILTERS = [
  { key: 'rookie', label: '루키', test: c => c.rookie },
  { key: 'auto', label: '사인', test: c => c.auto },
  { key: 'patch', label: '패치', test: c => c.patch },
  { key: 'graded', label: '그레이딩', test: c => !!c.grader },
  { key: 'serial', label: '넘버링', test: c => !!c.serial },
];

// ===== 상태 =====
let db;
let cards = [];
const thumbUrls = new Map();
const state = { q: '', sort: 'new', status: '전체', attrs: new Set() };
let editing = null;          // 수정 중인 카드(신규면 null)
let pendingPhotos = {};      // { front: Blob|null, back: Blob|null } 폼에서 새로 고른 사진
let currentDetailId = null;

const $ = s => document.querySelector(s);
const won = n => (n || n === 0) && n !== '' ? Number(n).toLocaleString('ko-KR') + '원' : '-';
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ===== IndexedDB =====
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function tx(mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    const result = fn(store);
    t.oncomplete = () => resolve(result && 'result' in result ? result.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}
const dbAll = () => tx('readonly', s => s.getAll());
const dbPut = card => tx('readwrite', s => s.put(card));
const dbPutMany = list => tx('readwrite', s => list.forEach(c => s.put(c)));
const dbDelete = id => tx('readwrite', s => s.delete(id));

// ===== 이미지 처리 =====
function loadImage(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('이미지를 읽을 수 없습니다')); };
    img.src = url;
  });
}
async function resize(blob, max, quality = 0.82) {
  const img = await loadImage(blob);
  const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  return new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
}
const blobToDataURL = blob => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(r.result);
  r.onerror = () => reject(r.error);
  r.readAsDataURL(blob);
});
const dataURLToBlob = async url => (await fetch(url)).blob();

function thumbUrl(card) {
  if (!card.thumb) return null;
  if (!thumbUrls.has(card.id)) thumbUrls.set(card.id, URL.createObjectURL(card.thumb));
  return thumbUrls.get(card.id);
}
function dropThumb(id) {
  if (thumbUrls.has(id)) { URL.revokeObjectURL(thumbUrls.get(id)); thumbUrls.delete(id); }
}

// ===== 목록 렌더링 =====
function filtered() {
  const q = state.q.trim().toLowerCase();
  let list = cards.filter(c => {
    if (state.status !== '전체' && c.status !== state.status) return false;
    for (const key of state.attrs) {
      const f = ATTR_FILTERS.find(a => a.key === key);
      if (f && !f.test(c)) return false;
    }
    if (!q) return true;
    return [c.player, c.team, c.nation, c.season, c.brand, c.set, c.cardNo, c.parallel, c.serial, c.location, c.memo]
      .some(v => v && String(v).toLowerCase().includes(q));
  });
  const by = {
    new: (a, b) => b.createdAt - a.createdAt,
    player: (a, b) => (a.player || '').localeCompare(b.player || '', 'ko'),
    season: (a, b) => (b.season || '').localeCompare(a.season || '') || b.createdAt - a.createdAt,
    value: (a, b) => (b.value || 0) - (a.value || 0),
    buy: (a, b) => (b.buyPrice || 0) - (a.buyPrice || 0),
  }[state.sort];
  return list.sort(by);
}

function badgesHtml(c) {
  const b = [];
  if (c.rookie) b.push('<span class="badge">RC</span>');
  if (c.auto) b.push('<span class="badge gold">AUTO</span>');
  if (c.patch) b.push('<span class="badge">PATCH</span>');
  if (c.serial) b.push(`<span class="badge">${esc(c.serial)}</span>`);
  if (c.grader) b.push(`<span class="badge gold">${esc(c.grader)} ${esc(c.grade)}</span>`);
  return b.join('');
}

function render() {
  const list = filtered();
  $('#grid').innerHTML = list.map(c => {
    const url = thumbUrl(c);
    const sub = [c.season, c.brand, c.set, c.parallel].filter(Boolean).join(' · ') || c.team || '';
    const status = c.status && c.status !== '보유' ? `<span class="badge status">${esc(c.status)}</span>` : '';
    return `<button class="card" data-id="${c.id}">
      <div class="thumb">${url ? `<img src="${url}" alt="" loading="lazy">` : '사진 없음'}
        <div class="badges">${badgesHtml(c)}</div>${status}</div>
      <div class="meta"><div class="name">${esc(c.player)}</div><div class="sub">${esc(sub)}</div></div>
    </button>`;
  }).join('');
  $('#empty').hidden = cards.length > 0;
  if (cards.length > 0 && list.length === 0) {
    $('#grid').innerHTML = '<p class="empty" style="grid-column:1/-1">조건에 맞는 카드가 없습니다</p>';
  }
  renderStats();
}

function renderStats() {
  const owned = cards.filter(c => c.status === '보유' || c.status === '판매예정');
  const buy = owned.reduce((s, c) => s + (c.buyPrice || 0), 0);
  const val = owned.reduce((s, c) => s + (c.value || c.buyPrice || 0), 0);
  const wish = cards.filter(c => c.status === '위시').length;
  $('#stats').innerHTML =
    `<span>보유 <b>${owned.length}</b>장</span>` +
    `<span>구매 <b>${won(buy)}</b></span>` +
    `<span>추정 <b>${won(val)}</b></span>` +
    (wish ? `<span>위시 <b>${wish}</b></span>` : '');
}

function renderChips() {
  const st = ['전체', ...STATUSES].map(s =>
    `<button class="chip ${state.status === s ? 'on' : ''}" data-status="${s}">${s}</button>`).join('');
  const at = ATTR_FILTERS.map(a =>
    `<button class="chip ${state.attrs.has(a.key) ? 'on' : ''}" data-attr="${a.key}">${a.label}</button>`).join('');
  $('#chips').innerHTML = st + at;
}

function renderDatalists() {
  $('#datalists').innerHTML = AUTOCOMPLETE.map(f => {
    const vals = [...new Set(cards.map(c => c[f]).filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b), 'ko'));
    return `<datalist id="dl-${f}">${vals.map(v => `<option value="${esc(v)}">`).join('')}</datalist>`;
  }).join('');
}

// ===== 시트(화면) 열고 닫기 — 뒤로가기 제스처 지원 =====
// sheetStack 항목: 시트 id 또는 확대 이미지 요소
const sheetStack = [];
function pushLayer(layer) {
  sheetStack.push(layer);
  history.pushState({ depth: sheetStack.length }, '');
}
function openSheet(id) {
  $('#' + id).hidden = false;
  pushLayer(id);
}
window.addEventListener('popstate', () => {
  // history.go(-2) 등 여러 단계 이동도 한 번에 정리
  const depth = history.state?.depth || 0;
  while (sheetStack.length > depth) {
    const layer = sheetStack.pop();
    if (typeof layer === 'string') $('#' + layer).hidden = true;
    else layer.remove();
  }
});
document.addEventListener('click', e => {
  if (e.target.closest('[data-close]')) history.back();
});

// ===== 상세 =====
let detailUrls = [];
function showDetail(id) {
  if (renderDetail(id)) openSheet('detailSheet');
}
function renderDetail(id) {
  const c = cards.find(x => x.id === id);
  if (!c) return false;
  currentDetailId = id;
  detailUrls.forEach(u => URL.revokeObjectURL(u));
  detailUrls = [];
  const objUrl = blob => { const u = URL.createObjectURL(blob); detailUrls.push(u); return u; };
  const imgs = ['front', 'back'].map(side => c[side]
    ? `<img src="${objUrl(c[side])}" data-zoom alt="${side === 'front' ? '앞면' : '뒷면'}">`
    : `<div class="noimg">${side === 'front' ? '앞면' : '뒷면'} 없음</div>`).join('');
  const profit = c.value && c.buyPrice ? c.value - c.buyPrice : null;
  const rows = [
    ['상태', c.status], ['소속팀', c.team], ['국가', c.nation], ['시즌', c.season],
    ['브랜드', c.brand], ['세트', c.set], ['카드 번호', c.cardNo], ['패럴렐', c.parallel], ['시리얼', c.serial],
    ['그레이딩', c.grader ? `${c.grader} ${c.grade || ''}` : '무등급'], ['컨디션', c.condition],
    ['구매일', c.buyDate], ['구매처', c.buyFrom], ['구매가', c.buyPrice ? won(c.buyPrice) : ''],
    ['추정 시세', c.value ? won(c.value) : ''],
    ['손익', profit === null ? '' : `<span class="${profit >= 0 ? 'profit-up' : 'profit-down'}">${profit >= 0 ? '+' : ''}${won(profit)}</span>`],
    ['보관 위치', c.location], ['메모', c.memo],
  ].filter(([, v]) => v);
  $('#detailBody').innerHTML = `
    <div class="detail-photos">${imgs}</div>
    <h2 class="detail-name">${esc(c.player)}</h2>
    <div class="detail-sub">${esc([c.season, c.brand, c.set].filter(Boolean).join(' · '))}</div>
    <div class="detail-badges">${badgesHtml(c)}</div>
    <dl class="kv">${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${k === '손익' ? v : esc(v)}</dd></div>`).join('')}</dl>`;
  return true;
}
$('#detailBody').addEventListener('click', e => {
  const img = e.target.closest('[data-zoom]');
  if (!img) return;
  const z = document.createElement('div');
  z.className = 'zoom';
  z.innerHTML = `<img src="${img.src}" alt="">`;
  z.addEventListener('click', () => history.back());
  document.body.appendChild(z);
  pushLayer(z);
});

// ===== 등록·수정 폼 =====
const form = $('#cardForm');
function setSlot(side, blob) {
  const slot = form.querySelector(`.photo-slot[data-side="${side}"]`);
  const img = slot.querySelector('img');
  if (img.src.startsWith('blob:')) URL.revokeObjectURL(img.src);
  if (blob) { img.src = URL.createObjectURL(blob); img.hidden = false; }
  else { img.removeAttribute('src'); img.hidden = true; }
}
function openForm(card) {
  editing = card || null;
  pendingPhotos = {};
  form.reset();
  $('#formTitle').textContent = card ? '카드 수정' : '카드 등록';
  $('#btnDelete').hidden = !card;
  if (card) {
    for (const f of [...TEXT_FIELDS, ...NUM_FIELDS]) if (form.elements[f]) form.elements[f].value = card[f] ?? '';
    for (const f of BOOL_FIELDS) form.elements[f].checked = !!card[f];
  }
  setSlot('front', card?.front);
  setSlot('back', card?.back);
  form.scrollTop = 0;
  openSheet('formSheet');
}
form.addEventListener('change', async e => {
  if (e.target.type !== 'file' || !e.target.files[0]) return;
  const side = e.target.name;
  try {
    const blob = await resize(e.target.files[0], PHOTO_MAX);
    pendingPhotos[side] = blob;
    setSlot(side, blob);
  } catch (err) {
    toast(err.message);
  }
  e.target.value = '';
});
const toNum = v => { const n = Number(String(v).replace(/[^\d.-]/g, '')); return v !== '' && !isNaN(n) ? n : null; };

$('#btnSave').addEventListener('click', async () => {
  if (!form.elements.player.value.trim()) { toast('선수명을 입력해 주세요'); form.elements.player.focus(); return; }
  const now = Date.now();
  const card = editing ? { ...editing } : { id: crypto.randomUUID ? crypto.randomUUID() : String(now) + Math.random(), createdAt: now };
  for (const f of TEXT_FIELDS) card[f] = form.elements[f].value.trim();
  for (const f of NUM_FIELDS) card[f] = toNum(form.elements[f].value);
  for (const f of BOOL_FIELDS) card[f] = form.elements[f].checked;
  if ('front' in pendingPhotos) {
    card.front = pendingPhotos.front;
    card.thumb = card.front ? await resize(card.front, THUMB_MAX, 0.75) : null;
  }
  if ('back' in pendingPhotos) card.back = pendingPhotos.back;
  card.updatedAt = now;
  try {
    await dbPut(card);
  } catch (err) {
    toast('저장 실패: ' + (err?.message || '저장 공간을 확인하세요'));
    return;
  }
  dropThumb(card.id);
  const idx = cards.findIndex(c => c.id === card.id);
  if (idx >= 0) cards[idx] = card; else cards.push(card);
  renderDatalists();
  render();
  if (editing && currentDetailId === card.id) renderDetail(card.id);
  history.back();
  toast(editing ? '수정했습니다' : '등록했습니다');
});

$('#btnDelete').addEventListener('click', async () => {
  if (!editing || !confirm(`'${editing.player}' 카드를 삭제할까요?\n삭제하면 되돌릴 수 없습니다.`)) return;
  await dbDelete(editing.id);
  dropThumb(editing.id);
  cards = cards.filter(c => c.id !== editing.id);
  currentDetailId = null;
  renderDatalists();
  render();
  history.go(-2); // 폼과 상세 화면을 함께 닫기
  toast('삭제했습니다');
});

// ===== 백업·CSV =====
async function saveFile(blob, filename) {
  const file = new File([blob], filename, { type: blob.type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: filename }); return; }
    catch (err) { if (err.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
const stamp = () => new Date().toISOString().slice(0, 10);

$('#btnExport').addEventListener('click', async () => {
  if (!cards.length) { toast('내보낼 카드가 없습니다'); return; }
  toast('백업 파일을 만드는 중…');
  const out = [];
  for (const c of cards) {
    const { thumb, front, back, ...rest } = c;
    out.push({ ...rest, front: front ? await blobToDataURL(front) : null, back: back ? await blobToDataURL(back) : null });
  }
  const json = JSON.stringify({ app: 'cardbox', version: 1, exportedAt: new Date().toISOString(), cards: out });
  await saveFile(new Blob([json], { type: 'application/json' }), `카드함-백업-${stamp()}.json`);
});

$('#importFile').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  let data;
  try { data = JSON.parse(await file.text()); } catch { toast('백업 파일 형식이 아닙니다'); return; }
  if (data.app !== 'cardbox' || !Array.isArray(data.cards)) { toast('카드함 백업 파일이 아닙니다'); return; }
  if (!confirm(`${data.cards.length}장을 불러옵니다.\n같은 카드가 이미 있으면 백업 내용으로 덮어씁니다.`)) return;
  toast('불러오는 중…');
  const list = [];
  for (const c of data.cards) {
    const card = { ...c };
    card.front = c.front ? await dataURLToBlob(c.front) : null;
    card.back = c.back ? await dataURLToBlob(c.back) : null;
    card.thumb = card.front ? await resize(card.front, THUMB_MAX, 0.75) : null;
    list.push(card);
  }
  await dbPutMany(list);
  list.forEach(c => dropThumb(c.id));
  cards = await dbAll();
  renderDatalists();
  render();
  toast(`${list.length}장을 불러왔습니다`);
});

$('#btnCsv').addEventListener('click', () => {
  if (!cards.length) { toast('내보낼 카드가 없습니다'); return; }
  const cols = [['player', '선수명'], ['team', '소속팀'], ['nation', '국가'], ['season', '시즌'], ['brand', '브랜드'],
    ['set', '세트'], ['cardNo', '카드번호'], ['parallel', '패럴렐'], ['serial', '시리얼'], ['rookie', '루키'],
    ['auto', '사인'], ['patch', '패치'], ['grader', '그레이딩'], ['grade', '등급'], ['condition', '컨디션'],
    ['status', '상태'], ['buyDate', '구매일'], ['buyFrom', '구매처'], ['buyPrice', '구매가'], ['value', '추정시세'],
    ['location', '보관위치'], ['memo', '메모']];
  const cell = v => {
    const s = typeof v === 'boolean' ? (v ? 'Y' : '') : String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [cols.map(c => c[1]).join(','), ...cards.map(c => cols.map(([k]) => cell(c[k])).join(','))].join('\r\n');
  saveFile(new Blob(['﻿' + csv], { type: 'text/csv' }), `카드함-${stamp()}.csv`);
});

async function renderStorage() {
  const el = $('#storageInfo');
  if (!navigator.storage?.estimate) { el.textContent = '이 브라우저는 사용량 조회를 지원하지 않습니다.'; return; }
  const { usage = 0, quota = 0 } = await navigator.storage.estimate();
  const mb = n => (n / 1024 / 1024).toFixed(1) + 'MB';
  const persisted = navigator.storage.persisted ? await navigator.storage.persisted() : false;
  el.textContent = `카드 ${cards.length}장 · 사용 ${mb(usage)}${quota ? ' / 가능 ' + mb(quota) : ''}` +
    (persisted ? ' · 영구 보관 설정됨' : '');
}

// ===== 기타 =====
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2200);
}

$('#grid').addEventListener('click', e => {
  const el = e.target.closest('.card');
  if (el) showDetail(el.dataset.id);
});
$('#chips').addEventListener('click', e => {
  const b = e.target.closest('.chip');
  if (!b) return;
  if (b.dataset.status) state.status = b.dataset.status;
  if (b.dataset.attr) state.attrs.has(b.dataset.attr) ? state.attrs.delete(b.dataset.attr) : state.attrs.add(b.dataset.attr);
  renderChips();
  render();
});
$('#q').addEventListener('input', e => { state.q = e.target.value; render(); });
$('#sort').addEventListener('change', e => { state.sort = e.target.value; render(); });
$('#btnAdd').addEventListener('click', () => openForm(null));
$('#btnEdit').addEventListener('click', () => openForm(cards.find(c => c.id === currentDetailId)));
$('#btnSettings').addEventListener('click', () => { renderStorage(); openSheet('settingsSheet'); });

(async function init() {
  db = await openDB();
  cards = await dbAll();
  renderChips();
  renderDatalists();
  render();
  // 브라우저가 저장 공간을 임의로 정리하지 않도록 요청
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
