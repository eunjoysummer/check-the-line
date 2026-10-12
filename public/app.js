/* 책 OCR 카메라 v3 — 라우팅, 찍기, 자르기, 결과(형광펜/편집), 서재, 설정, 백업 */
(() => {
const $ = id => document.getElementById(id);
const OCR = window.BookOCR;
const APP_VERSION = '3.0.0';
// 책 검색 프록시(Cloudflare Worker) 주소. 비워 두면 직접 입력과 내 서재 검색만 됩니다.
// 예: const BOOK_API = 'https://book-search.내계정.workers.dev';
const BOOK_API = '';

// ================= 공통 =================
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const fmtTime = t => { const d = new Date(t); return (d.getMonth() + 1) + '월 ' + d.getDate() + '일 ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
const bookName = b => (b && b.title && b.title.trim()) || '제목 없는 책';

function toast(msg, action) {
  const t = $('toast');
  t.innerHTML = '<span>' + esc(msg) + '</span>' + (action ? '<button type="button">' + esc(action.label) + '</button>' : '');
  if (action) t.querySelector('button').onclick = () => { t.classList.remove('show'); action.fn(); };
  t.classList.toggle('act', !!action); t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), action ? 4500 : 2000);
}
function setStatus(text, pct, err) {
  $('statusText').textContent = text;
  $('status').classList.toggle('err', !!err);
  if (pct == null) $('bar').hidden = true; else { $('bar').hidden = false; $('barFill').style.width = Math.round(pct * 100) + '%'; }
}
function coverHTML(b, cls) {
  const c = 'cover' + (cls ? ' ' + cls : ''), ch = esc(bookName(b)[0]);
  return b && b.image
    ? '<img class="' + c + '" src="' + esc(b.image) + '" alt="" loading="lazy" referrerpolicy="no-referrer" data-t="' + ch + '">'
    : '<span class="' + c + ' ph" aria-hidden="true">' + ch + '</span>';
}
// 표지를 못 불러오면(오프라인 등) 글자 표지로 바꿈
document.addEventListener('error', e => {
  const im = e.target;
  if (!(im instanceof HTMLImageElement) || !im.classList.contains('cover')) return;
  const s = document.createElement('span'); s.className = im.className + ' ph'; s.textContent = im.dataset.t || ''; s.setAttribute('aria-hidden', 'true');
  im.replaceWith(s);
}, true);
function paraHTML(text, hls) {
  let html = '', at = 0;
  for (const h of [...hls].sort((a, b) => a.s - b.s)) {
    if (h.s < at) continue;
    html += esc(text.slice(at, h.s)) + '<mark class="' + (h.src === 'photo' ? 'photo' : 'user') + '">' + esc(text.slice(h.s, h.e)) + '</mark>'; at = h.e;
  }
  return html + esc(text.slice(at));
}
async function copyText(t, okMsg) {
  try { await navigator.clipboard.writeText(t); toast(okMsg); return; } catch (e) {}
  const ta = document.createElement('textarea'); ta.value = t; ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0'; document.body.appendChild(ta); ta.select();
  let ok = false; try { ok = document.execCommand('copy'); } catch (e) {}
  ta.remove(); toast(ok ? okMsg : '복사하지 못했습니다. 브라우저 권한을 확인하세요');
}

// ================= 저장소 (IndexedDB v2) =================
const DB = {
  db: null, ok: true, mem: { clips: new Map(), books: new Map(), meta: new Map() },
  async open() {
    if (this.db || !this.ok) return;
    try {
      this.db = await new Promise((res, rej) => {
        const rq = indexedDB.open('book-ocr-camera', 2);
        rq.onupgradeneeded = e => {
          const d = rq.result, tx = rq.transaction;
          if (e.oldVersion < 1) { d.createObjectStore('clips', { keyPath: 'id' }); d.createObjectStore('meta'); }
          if (e.oldVersion < 2) {
            const bs = d.createObjectStore('books', { keyPath: 'id' });
            if (e.oldVersion >= 1) { // v2 이전 데이터: 제목마다 책을 만들고 페이지에 bookId 연결
              const seen = new Set();
              tx.objectStore('clips').openCursor().onsuccess = ev => {
                const cs = ev.target.result; if (!cs) return;
                const v = cs.value, t = (v.book || '').trim();
                v.bookId = 't:' + t; cs.update(v);
                if (!seen.has(t)) {
                  seen.add(t);
                  bs.put({ id: 't:' + t, title: t, author: '', publisher: '', isbn: '', image: '', createdAt: v.createdAt || Date.now(), updatedAt: v.updatedAt || Date.now() });
                }
                cs.continue();
              };
            }
          }
        };
        rq.onblocked = () => toast('다른 탭에 열린 이 앱을 닫고 새로고침해 주세요');
        rq.onsuccess = () => { const d = rq.result; d.onversionchange = () => d.close(); res(d); };
        rq.onerror = () => rej(rq.error);
      });
    } catch (e) { this.ok = false; console.warn('IndexedDB 사용 불가, 메모리에만 저장', e); }
  },
  async tx(store, mode, fn) {
    await this.open();
    if (!this.db) return fn(null);
    return new Promise((res, rej) => {
      const t = this.db.transaction(store, mode); let out;
      Promise.resolve(fn(t.objectStore(store))).then(v => out = v);
      t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
    });
  },
  req: r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }),
  all(st) { return this.tx(st, 'readonly', s => s ? this.req(s.getAll()) : [...this.mem[st].values()]); },
  one(st, k) { return this.tx(st, 'readonly', s => s ? this.req(s.get(k)) : this.mem[st].get(k)); },
  put(st, v) { return this.tx(st, 'readwrite', s => s ? this.req(s.put(v)) : this.mem[st].set(v.id, v)); },
  del(st, k) { return this.tx(st, 'readwrite', s => s ? this.req(s.delete(k)) : this.mem[st].delete(k)); },
  get(k) { return this.tx('meta', 'readonly', s => s ? this.req(s.get(k)) : this.mem.meta.get(k)); },
  set(k, v) { return this.tx('meta', 'readwrite', s => s ? this.req(s.put(v, k)) : this.mem.meta.set(k, v)); }
};

// ================= 상태 =================
// cur: 결과 화면에서 다루는 페이지 { id, book, page, paras, hl, raw, createdAt, stats }
let cur = null, dirty = false, mode = 'hl';
let curBook = null, shelf = [];
let figFor = null;
function saveDraft() { try { sessionStorage.setItem('draft', JSON.stringify({ cur, dirty })); } catch (e) {} }
function loadDraft() { try { const d = JSON.parse(sessionStorage.getItem('draft') || 'null'); if (d && d.cur) { cur = d.cur; dirty = !!d.dirty; } } catch (e) {} }
function markDirty() { dirty = true; saveDraft(); }
async function refreshShelf() { shelf = await DB.all('books'); }

// ================= 라우팅 =================
const VIEWS = ['scan', 'result', 'library', 'book', 'settings'];
function parseRoute() {
  const [a, b] = location.hash.replace(/^#\/?/, '').split('/');
  if (a === 'scan' && b === 'result') return { v: 'result' };
  if (a === 'library' && b) return { v: 'book', id: decodeURIComponent(b) };
  if (a === 'library') return { v: 'library' };
  if (a === 'settings') return { v: 'settings' };
  return { v: 'scan' };
}
const go = h => { if (location.hash === h) route(); else location.hash = h; };
let prevView = null, prevHash = null;
async function route() {
  const r = parseRoute();
  if (prevView === 'result' && r.v !== 'result') { leaveEdit(); saveDraft(); }
  if (r.v === 'result' && !cur) { location.replace('#/scan'); return; }
  VIEWS.forEach(v => { $('v-' + v).hidden = v !== r.v; });
  $('tabs').hidden = r.v === 'result';
  $('dock').hidden = r.v !== 'result';
  const tab = r.v === 'book' ? 'library' : r.v === 'result' ? 'scan' : r.v;
  document.querySelectorAll('#tabs [data-tab]').forEach(a => { if (a.dataset.tab === tab) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  if (location.hash !== prevHash) window.scrollTo(0, 0);
  prevView = r.v; prevHash = location.hash;
  if (r.v === 'scan') renderScan();
  else if (r.v === 'result') renderResult();
  else if (r.v === 'library') await renderLibrary();
  else if (r.v === 'book') await renderBook(r.id);
  else await renderSettings();
}
window.addEventListener('hashchange', route);
document.addEventListener('visibilitychange', () => { if (document.hidden && cur) { leaveEdit(); saveDraft(); } });

// ================= 찍기: 책 고르기 =================
function renderScan() {
  showBook();
  const d = cur && dirty;
  $('draftNote').hidden = !d;
  if (d) $('draftText').textContent = '저장하지 않은 페이지가 있습니다 (' + bookName(cur.book) + (cur.page != null ? ', p.' + cur.page : '') + ')';
}
$('draftOpen').onclick = () => go('#/scan/result');

function showBook() {
  $('pickCard').hidden = !curBook; $('bookSearch').hidden = !!curBook;
  if (!curBook) return;
  $('pickCover').innerHTML = coverHTML(curBook);
  $('pickTitle').textContent = bookName(curBook);
  $('pickSub').textContent = [curBook.author, curBook.publisher].filter(Boolean).join(' · ') || '직접 입력한 제목';
}
function setBook(b) {
  sSeq++; // 진행 중인 검색 결과 무시
  const title = ((b && b.title) || '').trim();
  if (!title) curBook = null;
  else {
    const info = { title, author: b.author || '', publisher: b.publisher || '', isbn: b.isbn || '', image: b.image || '' };
    const known = (info.isbn && shelf.find(x => x.isbn === info.isbn)) || shelf.find(x => x.title === title);
    // 이미 서재에 있는 책이면 id를 유지하고, 검색으로 얻은 표지·저자 정보만 덧붙임
    curBook = known ? { ...known, ...Object.fromEntries(Object.entries(info).filter(([, v]) => v)) } : { id: info.isbn || 't:' + title, ...info };
  }
  $('bookInput').value = ''; hideResults(); showBook();
  DB.set('curBook', curBook);
}
let sTimer = 0, sSeq = 0, sItems = [];
const hideResults = () => { $('bookResults').hidden = true; };
function showResults(local, remote, msg) {
  if (document.activeElement !== $('bookInput')) { hideResults(); return; }
  const isbns = new Set(local.map(b => b.isbn).filter(Boolean));
  remote = remote.filter(b => !b.isbn || !isbns.has(b.isbn));
  sItems = [...local, ...remote];
  const item = (b, i) => '<button type="button" role="option" data-i="' + i + '">' + coverHTML(b) +
    '<span><b>' + esc(bookName(b)) + '</b><small>' + esc([b.author, b.publisher, (b.pubdate || '').slice(0, 4)].filter(Boolean).join(' · ')) + '</small></span></button>';
  let html = '';
  if (local.length) html += '<div class="grp">내 서재</div>' + local.map((b, i) => item(b, i)).join('');
  if (remote.length) html += '<div class="grp">검색 결과</div>' + remote.map((b, i) => item(b, local.length + i)).join('');
  if (msg) html += '<div class="msg">' + esc(msg) + '</div>';
  $('bookResults').innerHTML = html; $('bookResults').hidden = !html;
}
async function searchBooks() {
  const q = $('bookInput').value.trim(), ql = q.toLowerCase(), seq = ++sSeq;
  const local = shelf.filter(b => b.title && (!q || b.title.toLowerCase().includes(ql) || (b.author || '').toLowerCase().includes(ql)))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, q ? 5 : 6);
  const online = !!BOOK_API && q.length >= 2;
  showResults(local, [], online ? '찾는 중…' : '');
  if (!online) return;
  let remote = [], msg = '';
  if (!navigator.onLine) msg = '오프라인이라 검색할 수 없습니다. 제목을 그대로 써도 됩니다.';
  else {
    try {
      const r = await fetch(BOOK_API + '?q=' + encodeURIComponent(q));
      if (!r.ok) throw new Error('HTTP ' + r.status);
      remote = (await r.json()).items || [];
      if (!remote.length) msg = '검색 결과가 없습니다. 제목을 그대로 써도 됩니다.';
    } catch (e) { console.warn(e); msg = '책 검색에 실패했습니다. 제목을 그대로 써도 됩니다.'; }
  }
  if (seq !== sSeq) return;
  showResults(local, remote, msg);
}
$('bookInput').addEventListener('input', () => { clearTimeout(sTimer); sTimer = setTimeout(searchBooks, 350); });
$('bookInput').addEventListener('focus', searchBooks);
$('bookInput').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('bookInput').blur(); } else if (e.key === 'Escape') hideResults(); });
$('bookInput').addEventListener('blur', () => setTimeout(() => {
  hideResults(); const v = $('bookInput').value.trim();
  if (v && !curBook) setBook({ title: v }); // 고르지 않고 입력만 했으면 그 제목으로
}, 200));
$('bookResults').addEventListener('mousedown', e => e.preventDefault()); // 입력창 포커스 유지
$('bookResults').addEventListener('click', e => { const el = e.target.closest('[data-i]'); if (el) setBook(sItems[+el.dataset.i]); });
$('pickChange').onclick = () => { curBook = null; showBook(); $('bookInput').value = ''; $('bookInput').focus(); };

// ================= 자르기 (영역 지정, 90도 회전) =================
const CROP = { img: null, rect: null, scale: 1, drag: null, done: null };
async function bitmapOf(file) {
  try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch (e) {
    return await new Promise((res, rej) => {
      const im = new Image(); im.onload = () => res(im);
      im.onerror = () => rej(new Error('사진을 열 수 없습니다. JPG나 PNG로 다시 시도하세요.'));
      im.src = URL.createObjectURL(file);
    });
  }
}
async function openCrop(file) {
  const bmp = await bitmapOf(file);
  const s = Math.min(1, 2400 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas'); c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  CROP.img = c; CROP.rect = { x: 0, y: 0, w: c.width, h: c.height };
  $('crop').hidden = false; document.documentElement.style.overflow = 'hidden';
  requestAnimationFrame(drawCrop);
  return new Promise(res => { CROP.done = res; });
}
function closeCrop(val) {
  $('crop').hidden = true; document.documentElement.style.overflow = '';
  const d = CROP.done; CROP.done = null; CROP.img = null; CROP.drag = null;
  if (d) d(val);
}
function drawCrop() {
  const img = CROP.img; if (!img) return;
  const st = $('cropStage'), cv = $('cropCv');
  const sc = Math.min((st.clientWidth - 24) / img.width, (st.clientHeight - 16) / img.height); CROP.scale = sc;
  const dpr = window.devicePixelRatio || 1, cw = Math.round(img.width * sc), ch = Math.round(img.height * sc);
  cv.style.width = cw + 'px'; cv.style.height = ch + 'px'; cv.width = Math.round(cw * dpr); cv.height = Math.round(ch * dpr);
  const g = cv.getContext('2d'); g.setTransform(dpr * sc, 0, 0, dpr * sc, 0, 0);
  g.drawImage(img, 0, 0);
  const r = CROP.rect;
  g.fillStyle = 'rgba(0,0,0,.55)'; g.beginPath(); g.rect(0, 0, img.width, img.height); g.rect(r.x, r.y, r.w, r.h); g.fill('evenodd');
  g.strokeStyle = '#fff'; g.lineWidth = 2 / sc; g.strokeRect(r.x, r.y, r.w, r.h);
  const L = 22 / sc, T = 5 / sc; g.fillStyle = '#fff';
  for (const [x, y, dx, dy] of [[r.x, r.y, 1, 1], [r.x + r.w, r.y, -1, 1], [r.x + r.w, r.y + r.h, -1, -1], [r.x, r.y + r.h, 1, -1]]) {
    g.fillRect(dx > 0 ? x : x - L, dy > 0 ? y : y - T, L, T);
    g.fillRect(dx > 0 ? x : x - T, dy > 0 ? y : y - L, T, L);
  }
}
const cropCv = $('cropCv');
const toImg = e => { const b = cropCv.getBoundingClientRect(); return [(e.clientX - b.left) / CROP.scale, (e.clientY - b.top) / CROP.scale]; };
cropCv.addEventListener('pointerdown', e => {
  if (!CROP.img) return; e.preventDefault(); cropCv.setPointerCapture(e.pointerId);
  const [x, y] = toImg(e), r = CROP.rect, tol = 32 / CROP.scale;
  const cs = [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]];
  let k = -1, best = tol;
  cs.forEach(([cx, cy], i) => { const d = Math.hypot(cx - x, cy - y); if (d < best) { best = d; k = i; } });
  if (k >= 0) CROP.drag = { mode: 'anchor', ax: cs[(k + 2) % 4][0], ay: cs[(k + 2) % 4][1], prev: { ...r } }; // 모서리: 반대쪽 모서리 고정
  else if (x > r.x && x < r.x + r.w && y > r.y && y < r.y + r.h) CROP.drag = { mode: 'move', dx: x - r.x, dy: y - r.y }; // 안쪽: 이동
  else CROP.drag = { mode: 'anchor', ax: x, ay: y, prev: { ...r } }; // 바깥: 새 영역
});
cropCv.addEventListener('pointermove', e => {
  const d = CROP.drag; if (!d) return;
  const img = CROP.img; let [x, y] = toImg(e);
  x = clamp(x, 0, img.width); y = clamp(y, 0, img.height);
  if (d.mode === 'move') { const r = CROP.rect; r.x = clamp(x - d.dx, 0, img.width - r.w); r.y = clamp(y - d.dy, 0, img.height - r.h); }
  else CROP.rect = { x: Math.min(d.ax, x), y: Math.min(d.ay, y), w: Math.abs(x - d.ax), h: Math.abs(y - d.ay) };
  drawCrop();
});
const endCropDrag = () => {
  const d = CROP.drag; if (!d || !CROP.img) return; CROP.drag = null;
  const r = CROP.rect; if (r.w < 24 || r.h < 24) CROP.rect = d.prev || { x: 0, y: 0, w: CROP.img.width, h: CROP.img.height }; // 너무 작으면 되돌림
  drawCrop();
};
cropCv.addEventListener('pointerup', endCropDrag);
cropCv.addEventListener('pointercancel', endCropDrag);
$('cropRot').onclick = () => {
  const img = CROP.img; if (!img) return;
  const c = document.createElement('canvas'); c.width = img.height; c.height = img.width;
  const g = c.getContext('2d'); g.translate(c.width, 0); g.rotate(Math.PI / 2); g.drawImage(img, 0, 0);
  const r = CROP.rect; CROP.rect = { x: img.height - (r.y + r.h), y: r.x, w: r.h, h: r.w }; // 시계 방향 90도
  CROP.img = c; drawCrop();
};
$('cropAll').onclick = () => { if (!CROP.img) return; CROP.rect = { x: 0, y: 0, w: CROP.img.width, h: CROP.img.height }; drawCrop(); };
$('cropCancel').onclick = () => closeCrop(null);
$('cropOk').onclick = () => {
  const img = CROP.img, r = CROP.rect; if (!img) return;
  const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(r.w)); c.height = Math.max(1, Math.round(r.h));
  c.getContext('2d').drawImage(img, r.x, r.y, r.w, r.h, 0, 0, c.width, c.height);
  c.toBlob(b => closeCrop(b), 'image/jpeg', 0.95);
};
window.addEventListener('resize', () => { if (CROP.img) drawCrop(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && CROP.img) closeCrop(null); });

// ================= 인식 =================
let busy = false;
async function handle(file) {
  if (!file || busy) return;
  if (cur && dirty && !confirm('저장하지 않은 페이지가 있습니다. 버리고 새로 찍을까요?')) return;
  let blob;
  try { blob = await openCrop(file); } catch (e) { setStatus(e.message || String(e), null, true); return; }
  if (!blob) return;
  busy = true; const t0 = performance.now();
  try {
    const res = await OCR.run(blob, setStatus);
    const sec = ((performance.now() - t0) / 1000).toFixed(1);
    cur = {
      id: null, book: curBook ? { ...curBook } : null, page: res.page, raw: res.raw, paras: res.paras,
      hl: res.hl.map(h => ({ ...h })), createdAt: null,
      stats: '책 ' + res.lines.length + '줄 → ' + res.paras.length + '개 문단' + (res.page != null ? ', 쪽 번호 ' + res.page : ', 쪽 번호 못 찾음') +
        (res.hl.length ? ', 사진 형광펜 ' + res.hl.length + '곳' : '') + ' (' + sec + '초)'
    };
    const cs = getComputedStyle(document.documentElement);
    OCR.drawFigure($('fig'), res, { line: cs.getPropertyValue('--accent').trim(), para: cs.getPropertyValue('--warn').trim(), page: cs.getPropertyValue('--page').trim() });
    figFor = cur; mode = 'hl'; markDirty();
    setStatus('사진을 찍으면 인식할 영역을 고른 뒤 읽습니다.', null);
    go('#/scan/result');
    toast(res.page != null ? '쪽 번호가 맞는지 확인하고 저장하세요' : '쪽 번호를 못 찾았습니다. p. 칸에 넣어 주세요');
  } catch (e) {
    console.error(e && e.stack ? e.stack : e);
    setStatus(e.message || String(e), null, true);
  } finally { busy = false; }
}
$('cam').onchange = e => { const f = e.target.files[0]; e.target.value = ''; handle(f); };
$('pick').onchange = e => { const f = e.target.files[0]; e.target.value = ''; handle(f); };

// ================= 결과 화면 =================
const HINT = {
  hl: "글자를 길게 눌러 범위를 고른 뒤 아래 '형광펜'을 누르세요. 분홍은 사진에서 찾은 형광펜, 노랑은 직접 칠한 형광펜입니다.",
  edit: '문장을 바로 고칠 수 있습니다. 빈 줄로 문단을 나누고, 고친 뒤에도 형광펜은 같은 글자를 따라갑니다.'
};
function renderResult() {
  if (!cur) return;
  $('rBook').innerHTML = coverHTML(cur.book, 'xs') + '<span>' + esc(bookName(cur.book)) + '</span>';
  $('page').value = cur.page ?? '';
  $('mHl').setAttribute('aria-pressed', String(mode === 'hl'));
  $('mEdit').setAttribute('aria-pressed', String(mode === 'edit'));
  $('reader').hidden = mode !== 'hl'; $('editor').hidden = mode !== 'edit';
  $('hint').textContent = HINT[mode];
  if (mode === 'hl') {
    $('reader').innerHTML = cur.paras.length
      ? cur.paras.map((t, i) => '<p data-p="' + i + '">' + paraHTML(t, cur.hl.filter(h => h.p === i)) + '</p>').join('')
      : '<p class="muted">문단이 없습니다. 편집에서 직접 쓸 수 있습니다.</p>';
  } else $('editor').value = cur.paras.join('\n\n');
  $('stats').textContent = cur.stats || '';
  $('figBox').hidden = figFor !== cur;
  updateDock();
}
function leaveEdit() {
  if (mode !== 'edit' || !cur) return;
  const paras = $('editor').value.split(/\n\s*\n/).map(t => t.replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean);
  // 고친 뒤에도 형광펜 위치를 글자 기준으로 다시 찾기
  const moved = [];
  for (const h of cur.hl) {
    const order = [h.p, ...paras.map((_, i) => i).filter(i => i !== h.p)];
    for (const p of order) { const s = (paras[p] || '').indexOf(h.text); if (s >= 0) { moved.push({ p, s, e: s + h.text.length, src: h.src }); break; } }
  }
  cur.paras = paras; cur.hl = OCR.mergeHl(moved, paras);
}
function setMode(m) { leaveEdit(); mode = m; lastSel = null; window.getSelection().removeAllRanges(); saveDraft(); renderResult(); }
$('mHl').onclick = () => setMode('hl');
$('mEdit').onclick = () => setMode('edit');
$('editor').addEventListener('input', () => { dirty = true; });
$('page').oninput = () => { const v = $('page').value.trim(); cur.page = v === '' ? null : parseInt(v, 10); markDirty(); };
$('backBtn').onclick = () => go('#/scan');

// ---------- 형광펜 칠하기, 지우기 (지우기는 형광펜만 지움) ----------
let lastSel = null, selT = 0;
function selToRanges() {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed || !cur) return null;
  const rg = sel.getRangeAt(0), reader = $('reader');
  if (!reader.contains(rg.commonAncestorContainer)) return null;
  const off = (pEl, node, o) => { const r = document.createRange(); r.setStart(pEl, 0); r.setEnd(node, o); return r.toString().length; };
  const out = [];
  reader.querySelectorAll('p[data-p]').forEach(pEl => {
    if (!rg.intersectsNode(pEl)) return;
    const p = +pEl.dataset.p, t = cur.paras[p]; if (t == null) return;
    let s = pEl.contains(rg.startContainer) ? off(pEl, rg.startContainer, rg.startOffset) : 0;
    let e = pEl.contains(rg.endContainer) ? off(pEl, rg.endContainer, rg.endOffset) : t.length;
    while (s < e && /\s/.test(t[s])) s++;
    while (e > s && /\s/.test(t[e - 1])) e--;
    if (e > s) out.push({ p, s, e });
  });
  return out.length ? out : null;
}
function updateDock() {
  const can = mode === 'hl' && !!(selToRanges() || lastSel);
  $('hlAdd').classList.toggle('off', !can); $('hlDel').classList.toggle('off', !can);
}
document.addEventListener('selectionchange', () => {
  if (prevView !== 'result' || mode !== 'hl') return;
  const r = selToRanges(); clearTimeout(selT);
  if (r) lastSel = r;
  else selT = setTimeout(() => { if (!selToRanges()) { lastSel = null; updateDock(); } }, 400);
  updateDock();
});
['hlAdd', 'hlDel'].forEach(id => ['pointerdown', 'mousedown'].forEach(ev => $(id).addEventListener(ev, e => e.preventDefault()))); // 선택이 풀리지 않게
function pickRanges() {
  if (mode !== 'hl') { setMode('hl'); toast('글자를 길게 눌러 고른 뒤 다시 눌러 주세요'); return null; }
  const r = selToRanges() || lastSel;
  if (!r) toast('먼저 글자를 길게 눌러 범위를 고르세요');
  return r;
}
function afterHl(msg) { lastSel = null; window.getSelection().removeAllRanges(); markDirty(); renderResult(); toast(msg); }
$('hlAdd').onclick = () => {
  const r = pickRanges(); if (!r) return;
  cur.hl = OCR.mergeHl([...cur.hl.map(h => ({ ...h })), ...r.map(x => ({ ...x, src: 'user' }))], cur.paras);
  afterHl('형광펜을 칠했습니다');
};
$('hlDel').onclick = () => {
  const r = pickRanges(); if (!r) return;
  let hl = cur.hl.map(h => ({ ...h }));
  for (const x of r) {
    const next = [];
    for (const h of hl) {
      if (h.p !== x.p || h.e <= x.s || h.s >= x.e) { next.push(h); continue; }
      if (h.s < x.s) next.push({ ...h, e: x.s });
      if (h.e > x.e) next.push({ ...h, s: x.e });
    }
    hl = next;
  }
  cur.hl = OCR.mergeHl(hl.filter(h => cur.paras[h.p].slice(h.s, h.e).trim()), cur.paras);
  afterHl('형광펜을 지웠습니다');
};

// ---------- 저장, 복사 ----------
$('saveBtn').onclick = async () => {
  if (!cur) return;
  leaveEdit();
  if (!cur.paras.length) { toast('저장할 내용이 없습니다'); return; }
  const now = Date.now(), b = cur.book || { title: '' };
  const info = { title: (b.title || '').trim(), author: b.author || '', publisher: b.publisher || '', isbn: b.isbn || '', image: b.image || '' };
  const id = b.id || info.isbn || 't:' + info.title;
  const old = await DB.one('books', id);
  const book = { ...(old || {}), id, createdAt: old ? old.createdAt : now, updatedAt: now };
  for (const [k, v] of Object.entries(info)) book[k] = v || (old && old[k]) || ''; // 비어 있는 값으로 기존 정보를 지우지 않음
  await DB.put('books', book);
  const isNew = !cur.id;
  const clip = { id: cur.id || uid(), bookId: id, book: book.title, page: cur.page ?? null, paras: cur.paras, hl: cur.hl, raw: cur.raw || [], createdAt: cur.createdAt || now, updatedAt: now };
  await DB.put('clips', clip);
  cur.id = clip.id; cur.createdAt = clip.createdAt; cur.book = book; dirty = false; saveDraft();
  if (curBook && curBook.id === id) { curBook = { ...book }; DB.set('curBook', curBook); }
  await refreshShelf();
  const r = await autoBackup(true);
  toast((isNew ? '서재에 저장했습니다' : '고친 내용을 저장했습니다') + (r === 'ok' ? ' · 백업 완료' : ''),
    { label: '서재에서 보기', fn: () => go('#/library/' + encodeURIComponent(id)) });
};
const cite = c => [c.book && c.book.title, c.page != null && !isNaN(c.page) ? 'p.' + c.page : ''].filter(Boolean).join(', ');
$('copyHlBtn').onclick = () => {
  if (!cur) return; leaveEdit();
  if (!cur.hl.length) { toast('칠한 형광펜이 없습니다'); return; }
  const c = cite(cur);
  copyText(cur.hl.map(h => '“' + h.text + '”').join('\n') + (c ? '\n(' + c + ')' : ''), '형광펜 ' + cur.hl.length + '곳을 복사했습니다');
};

// ================= 서재 =================
async function renderLibrary() {
  const [books, clips] = await Promise.all([DB.all('books'), DB.all('clips')]);
  const stat = new Map();
  for (const c of clips) {
    const s = stat.get(c.bookId) || { n: 0, hl: 0, t: 0, title: c.book || '' };
    s.n++; s.hl += (c.hl || []).length; s.t = Math.max(s.t, c.updatedAt || 0); stat.set(c.bookId, s);
  }
  const list = books.filter(b => stat.has(b.id));
  for (const [id, s] of stat) if (!books.some(b => b.id === id)) list.push({ id, title: s.title }); // 책 정보가 빠진 페이지 대비
  list.sort((a, b) => stat.get(b.id).t - stat.get(a.id).t);
  $('libCount').textContent = list.length ? '책 ' + list.length + '권, ' + clips.length + '쪽' : '';
  $('shelf').innerHTML = list.length
    ? list.map(b => { const s = stat.get(b.id); return '<a class="bk" href="#/library/' + encodeURIComponent(b.id) + '">' + coverHTML(b) + '<b>' + esc(bookName(b)) + '</b><small>' + s.n + '쪽' + (s.hl ? ' · 형광펜 ' + s.hl : '') + '</small></a>'; }).join('')
    : '<div class="empty sheet">저장한 페이지가 책별로 여기에 쌓입니다. 찍기 탭에서 첫 페이지를 저장해 보세요.</div>';
}

let bookView = 'all', bookCtx = null;
async function renderBook(id) {
  const [b0, all] = await Promise.all([DB.one('books', id), DB.all('clips')]);
  const clips = all.filter(c => c.bookId === id).sort((x, y) => (x.page ?? 1e9) - (y.page ?? 1e9) || x.createdAt - y.createdAt);
  const b = b0 || { id, title: (clips[0] && clips[0].book) || '' };
  bookCtx = { b, clips };
  const nHl = clips.reduce((a, c) => a + (c.hl || []).length, 0);
  $('bookHead').innerHTML = coverHTML(b, 'lg') + '<div><h1 class="ptitle">' + esc(bookName(b)) + '</h1>' +
    (b.author || b.publisher ? '<p class="sub">' + esc([b.author, b.publisher].filter(Boolean).join(' · ')) + '</p>' : '') +
    '<p class="sub">' + clips.length + '쪽 · 형광펜 ' + nHl + '곳</p></div>';
  $('bvAll').setAttribute('aria-pressed', String(bookView === 'all'));
  $('bvHl').setAttribute('aria-pressed', String(bookView === 'hl'));
  const shown = bookView === 'hl' ? clips.filter(c => (c.hl || []).length) : clips;
  if (!shown.length) { $('pages').innerHTML = '<div class="empty sheet">' + (clips.length ? '칠한 형광펜이 없습니다.' : '이 책에 남은 페이지가 없습니다.') + '</div>'; return; }
  $('pages').innerHTML = shown.map(c => {
    const body = bookView === 'hl'
      ? c.hl.map(h => '<p><mark class="' + (h.src === 'photo' ? 'photo' : 'user') + '">' + esc(h.text) + '</mark></p>').join('')
      : c.paras.map((t, i) => '<p>' + paraHTML(t, (c.hl || []).filter(h => h.p === i)) + '</p>').join('');
    return '<article class="sheet"><div class="pgc-h"><span class="pgn">' + (c.page != null ? 'p.' + c.page : '쪽 없음') + '</span>' +
      '<button type="button" class="btn small" data-edit="' + c.id + '">고치기</button>' +
      '<button type="button" class="linkbtn" data-del="' + c.id + '">삭제</button></div><div class="pgc-b">' + body + '</div></article>';
  }).join('');
}
$('bvAll').onclick = () => { bookView = 'all'; route(); };
$('bvHl').onclick = () => { bookView = 'hl'; route(); };
$('bookCopy').onclick = () => {
  if (!bookCtx) return;
  const { b, clips } = bookCtx, withHl = clips.filter(c => (c.hl || []).length);
  if (!withHl.length) { toast('칠한 형광펜이 없습니다'); return; }
  const n = withHl.reduce((a, c) => a + c.hl.length, 0);
  const head = bookName(b) + (b.author ? ' (' + b.author + ')' : '');
  const body = withHl.map(c => (c.page != null ? 'p.' + c.page : '쪽 없음') + '\n' + c.hl.map(h => '“' + h.text + '”').join('\n')).join('\n\n');
  copyText(head + '\n\n' + body, '형광펜 ' + n + '곳을 복사했습니다');
};
async function openClip(id) {
  if (cur && cur.id === id && dirty) { mode = 'hl'; go('#/scan/result'); return; }
  if (cur && dirty && !confirm('저장하지 않은 페이지가 있습니다. 버리고 이 페이지를 열까요?')) return;
  const c = await DB.one('clips', id); if (!c) return;
  const b = (await DB.one('books', c.bookId)) || { id: c.bookId, title: c.book || '' };
  cur = { id: c.id, book: b, page: c.page, paras: [...c.paras], hl: (c.hl || []).map(h => ({ ...h })), raw: c.raw || [], createdAt: c.createdAt, stats: '서재에서 불러왔습니다. 고친 뒤 저장을 누르세요.' };
  dirty = false; mode = 'hl'; saveDraft(); go('#/scan/result');
}
$('pages').addEventListener('click', async e => {
  const ed = e.target.closest('[data-edit]'); if (ed) { openClip(ed.dataset.edit); return; }
  const del = e.target.closest('[data-del]'); if (!del) return;
  if (!del.classList.contains('armed')) {
    del.classList.add('armed'); del.textContent = '정말 삭제';
    setTimeout(() => { del.classList.remove('armed'); del.textContent = '삭제'; }, 3000); return;
  }
  await DB.del('clips', del.dataset.del);
  if (cur && cur.id === del.dataset.del) { cur.id = null; saveDraft(); }
  await autoBackup(); toast('삭제했습니다'); route();
});

// ================= 설정 =================
function syncSeg(id, val) { document.querySelectorAll('#' + id + ' button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === val))); }
function setPref(key, store, val) {
  const el = document.documentElement;
  if (val) el.dataset[key] = val; else delete el.dataset[key];
  try { if (val) localStorage.setItem(store, val); else localStorage.removeItem(store); } catch (e) {}
}
$('themeSeg').onclick = e => { const b = e.target.closest('button'); if (!b) return; setPref('theme', 'theme', b.dataset.v); syncSeg('themeSeg', b.dataset.v); };
$('sizeSeg').onclick = e => { const b = e.target.closest('button'); if (!b) return; setPref('size', 'fontSize', b.dataset.v); syncSeg('sizeSeg', b.dataset.v); };
async function renderSettings() {
  syncSeg('themeSeg', document.documentElement.dataset.theme || '');
  syncSeg('sizeSeg', document.documentElement.dataset.size || '');
  await bkState();
}

// ================= 백업 (JSON 한 파일 덮어쓰기) =================
const FS = 'showSaveFilePicker' in window;
const BK_NAME = '책OCR카메라_백업.json';
async function backupJSON() {
  const [books, clips] = await Promise.all([DB.all('books'), DB.all('clips')]);
  return JSON.stringify({ app: 'book-ocr-camera', version: 2, exportedAt: new Date().toISOString(), books, clips }, null, 1);
}
async function bkState() {
  if (!FS) { $('bkState').textContent = '파일 덮어쓰기 미지원 브라우저'; return; }
  const h = await DB.get('backupHandle'); const t = await DB.get('lastBackup');
  $('bkState').textContent = h ? h.name + (t ? ', ' + fmtTime(t) + ' 백업' : '') : '연결된 백업 파일 없음';
  $('bkPick').textContent = h ? '백업 파일 바꾸기' : '백업 파일 정하기';
}
async function writeTo(handle, interactive) {
  let perm = await handle.queryPermission({ mode: 'readwrite' });
  if (perm !== 'granted' && interactive) perm = await handle.requestPermission({ mode: 'readwrite' });
  if (perm !== 'granted') return 'perm';
  const w = await handle.createWritable(); await w.write(await backupJSON()); await w.close(); // 같은 파일을 통째로 덮어씀
  await DB.set('lastBackup', Date.now()); await bkState(); return 'ok';
}
async function autoBackup(interactive) {
  if (!FS) return 'none';
  const h = await DB.get('backupHandle'); if (!h) return 'none';
  try { const r = await writeTo(h, interactive); if (r === 'perm') $('bkState').textContent = h.name + ', 권한 다시 허용 필요 (지금 백업 누르기)'; return r; }
  catch (e) { console.warn(e); $('bkState').textContent = '백업 실패: ' + (e.message || e); return 'fail'; }
}
function download(text) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' })); a.download = BK_NAME;
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
$('bkPick').onclick = async () => {
  if (!FS) { download(await backupJSON()); toast('백업 파일을 내려받았습니다'); return; }
  try {
    const h = await window.showSaveFilePicker({ suggestedName: BK_NAME, types: [{ description: '백업 JSON', accept: { 'application/json': ['.json'] } }] });
    await DB.set('backupHandle', h); const r = await writeTo(h, true);
    toast(r === 'ok' ? '이제 저장할 때마다 ' + h.name + ' 파일을 덮어씁니다' : '파일 쓰기 권한이 필요합니다');
  } catch (e) { if (e.name !== 'AbortError') toast('백업 파일을 정하지 못했습니다: ' + (e.message || e)); }
};
$('bkNow').onclick = async () => {
  if (!FS) { download(await backupJSON()); toast('백업 파일을 내려받았습니다'); return; }
  const r = await autoBackup(true);
  if (r === 'none') $('bkPick').click(); else if (r === 'ok') toast('백업 파일을 덮어썼습니다'); else if (r === 'perm') toast('파일 쓰기 권한을 허용해 주세요');
};
async function importText(text) {
  let data; try { data = JSON.parse(text); } catch (e) { throw new Error('백업 파일을 읽지 못했습니다. 이 툴에서 만든 JSON인지 확인하세요.'); }
  if (!data || !Array.isArray(data.clips)) throw new Error('이 툴의 백업 파일이 아닙니다.');
  const haveB = new Map((await DB.all('books')).map(b => [b.id, b]));
  for (const b of (Array.isArray(data.books) ? data.books : [])) {
    const o = haveB.get(b.id);
    if (!o || (b.updatedAt || 0) > (o.updatedAt || 0)) { await DB.put('books', b); haveB.set(b.id, b); }
  }
  const have = new Map((await DB.all('clips')).map(c => [c.id, c])); let n = 0;
  for (const c of data.clips) {
    if (!c.bookId) c.bookId = 't:' + (c.book || '').trim(); // version 1 백업
    if (!haveB.has(c.bookId)) {
      const nb = { id: c.bookId, title: (c.book || '').trim(), author: '', publisher: '', isbn: '', image: '', createdAt: c.createdAt || Date.now(), updatedAt: c.updatedAt || Date.now() };
      await DB.put('books', nb); haveB.set(nb.id, nb);
    }
    const o = have.get(c.id);
    if (!o || (c.updatedAt || 0) > (o.updatedAt || 0)) { await DB.put('clips', c); n++; }
  }
  await refreshShelf(); return n;
}
async function doImport(file, handle) {
  try {
    const n = await importText(await file.text());
    if (handle) { await DB.set('backupHandle', handle); await writeTo(handle, true); } // 불러온 파일을 앞으로의 백업 파일로 연결
    toast('백업에서 ' + n + '쪽을 가져왔습니다' + (handle ? '. 이 파일에 계속 덮어씁니다' : ''));
    await bkState();
  } catch (e) { toast(e.message || String(e)); }
}
$('bkImport').onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) doImport(f, null); };
if ('showOpenFilePicker' in window) {
  document.querySelector('label[for=bkImport]').addEventListener('click', async e => {
    e.preventDefault();
    try {
      const [h] = await window.showOpenFilePicker({ types: [{ description: '백업 JSON', accept: { 'application/json': ['.json'] } }] });
      await doImport(await h.getFile(), h);
    } catch (err) { if (err.name !== 'AbortError') $('bkImport').click(); }
  });
}
if (!FS) {
  $('bkHelp').textContent = '이 브라우저는 파일 덮어쓰기를 지원하지 않아 백업할 때마다 파일을 새로 내려받습니다. 크롬이나 엣지에서 열면 파일 하나를 계속 덮어쓸 수 있습니다.';
  $('bkPick').textContent = '백업 파일 내려받기'; $('bkNow').hidden = true;
}

// ================= 시작 =================
(async () => {
  $('appVer').textContent = APP_VERSION;
  $('bookInput').placeholder = BOOK_API ? '책 제목이나 저자로 검색' : '읽고 있는 책 제목';
  setStatus($('statusText').textContent, null);
  loadDraft();
  await DB.open();
  await refreshShelf();
  const cb = await DB.get('curBook');
  if (cb) { const k = shelf.find(b => b.id === cb.id); curBook = k ? { ...cb, ...k } : cb; }
  if (!DB.ok) $('bkHelp').textContent = '이 화면에서는 기기 저장소를 쓸 수 없어 새로고침하면 서재가 비워집니다. 배포 주소나 오프라인 파일에서 열어 주세요.';
  if (!/^#\//.test(location.hash)) history.replaceState(null, '', '#/scan');
  await route();
})();
if ('serviceWorker' in navigator && /^https?:/.test(location.protocol) && !window.__EMBED && !/claude|claudeusercontent/.test(location.hostname)) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
window.__app = { handle, state: () => cur, DB, go };
})();
