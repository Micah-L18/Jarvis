// The file viewer: a framed pane over the scene that shows a file in the app — images, 3D models,
// PDFs, markdown, code and text, tables, audio and video — and a Text tab for what Jarvis reads
// out of a file (a transcription). Everything is loaded through jarvis-file://, which only serves
// files inside the folders Jarvis may see.
import { kindOf, extOf, kindLabel, decodeText } from '../main/filekind.js';
import { h } from './panel.js';
import { fileUrl, nameOf, dirOf, formatBytes, middle, parseCsv } from './viewkit.js';

export { fileUrl };

const DIST = new URL('../../dist/', location.href).href;
const TEXT_CAP = 2 * 1024 * 1024;
const BIG_MODEL = 150 * 1024 * 1024;
const CSV_ROWS = 1000;
const READABLE = new Set(['pdf', 'markdown', 'code', 'text', 'csv', 'json', 'office', 'html', 'image', 'svg']);
const HEARABLE = new Set(['audio', 'video']);

export class Viewer {
  /** @param app {api, root, dim, voice() -> Voice, send(text), toast(text, error?), onClose()} */
  constructor(app) {
    this.app = app;
    this.api = app.api;
    this.root = app.root;
    this.current = null; // {path, kind, name, size, modified}
    this.seq = 0;
    this.cleanup = [];
    this.api.on('ui', (e) => {
      if (e.type === 'show_file' && e.path) this.open(e.path, { focus: e.focus });
      else if (e.type === 'viewer_text' && (!e.ifOpen || e.path === this.current?.path)) this.showText(e.path, e.title, e.text); // ifOpen: not brought back once closed
    });
  }

  get isOpen() {
    return Boolean(this.current);
  }

  state() {
    const c = this.current;
    return c && !c.failed ? { path: c.path, kind: c.kind, name: c.name } : null;
  }

  _report() {
    this.api.invoke('viewer:state', this.state()).catch(() => {});
  }

  _teardown() {
    for (const fn of this.cleanup.splice(0)) {
      try { fn(); } catch { /* already gone */ }
    }
  }

  close() {
    if (!this.current && this.root.hidden) return;
    this.seq++;
    this._teardown();
    this.current = null;
    this.root.hidden = true;
    this.app.dim.hidden = true;
    this.root.replaceChildren();
    this._report();
    this.app.onClose?.();
  }

  /** Show a file. `focus`: a page (pdf), line (text) or time in seconds (audio/video). */
  async open(path, { focus } = {}) {
    path = String(path || '');
    if (!path) return;
    const seq = ++this.seq;
    this._teardown();
    let kind = kindOf(path);
    const name = nameOf(path);
    this.current = { path, kind, name, size: NaN, modified: null };
    this._frame();
    this.root.hidden = false;
    this.app.dim.hidden = false;
    this._report();

    const url = fileUrl(path);
    let head;
    try {
      head = await fetch(url, { method: 'HEAD' });
    } catch {
      head = null;
    }
    if (seq !== this.seq) return;
    if (!head || !head.ok) {
      this.current.failed = true; // nothing on screen to talk about, or to open elsewhere
      this._header();
      this._report();
      return this._message(head?.status === 403 ? 'That file is outside the folders I can see.' : 'I could not find that file.');
    }
    this.current.size = Number(head.headers.get('content-length'));
    const mod = head.headers.get('last-modified');
    this.current.modified = mod ? new Date(mod) : null;
    this._header();
    try {
      if (kind === 'image' || kind === 'svg') await this._image(url, seq);
      else if (kind === 'model') await this._model(path, seq);
      else if (kind === 'pdf') await this._pdf(url, seq, focus);
      else if (kind === 'audio' || kind === 'video') this._media(url, kind, focus);
      else if (['markdown', 'code', 'text', 'csv', 'json', 'html'].includes(kind)) {
        const text = await this._text(url, seq);
        if (seq !== this.seq) return;
        if (text == null) { // binary after all
          kind = this.current.kind = 'other';
          this._header();
          this._report();
          this._info();
        } else if (kind === 'markdown') await this._markdown(text, seq);
        else if (kind === 'csv') this._csv(text);
        else if (kind === 'json') this._code(this._pretty(text), focus);
        else this._code(text, focus);
      } else this._info();
    } catch (err) {
      if (seq === this.seq) this._message(err?.message || 'I could not show that file.');
    }
  }

  /** A text result for a file (a transcription), in the pane's Text tab. */
  async showText(path, title, text) {
    if (path && path !== this.current?.path) await this.open(path);
    if (!this.current) {
      this.current = { path: path || '', kind: 'text', name: title || 'Text', size: NaN, modified: null };
      this._frame();
      this._header();
      this.root.hidden = false;
      this.app.dim.hidden = false;
      this._message('');
      this._report();
    }
    const copy = h('button', { class: 'btn', onclick: async () => {
      try { await navigator.clipboard.writeText(text); } catch { /* no clipboard */ }
      copy.textContent = 'Copied';
      setTimeout(() => { copy.textContent = 'Copy'; }, 1500);
    } }, 'Copy');
    this.els.text.replaceChildren(
      h('div', { class: 'v-text-head' }, h('span', {}, title || 'Text'), copy),
      h('div', { class: 'v-prose' }, String(text || '')),
    );
    this.els.tabs.hidden = false;
    this._tab('text');
  }

  // ---- frame -------------------------------------------------------------------

  _frame() {
    const tab = (id, label) => h('button', { 'data-tab': id, onclick: () => this._tab(id) }, label);
    const viewTab = tab('view', 'View');
    const textTab = tab('text', 'Text');
    this.els = {
      kind: h('div', { class: 'kind' }),
      name: h('h2', {}),
      path: h('div', { class: 'path' }),
      tools: h('div', { class: 'v-tools' }),
      viewTab,
      textTab,
      view: h('div', { class: 'v-pane v-view' }),
      text: h('div', { class: 'v-pane v-text', hidden: true }),
      info: h('div', { class: 'v-info' }),
      actions: h('div', { class: 'row v-actions' }),
    };
    const e = this.els;
    this.root.replaceChildren(
      h('header', { class: 'v-head' },
        h('div', { class: 'v-title' }, e.kind, e.name, e.path),
        e.tools,
        (e.tabs = h('nav', { class: 'v-tabs', hidden: true }, viewTab, textTab)),
        h('button', { class: 'v-x', title: 'Close (Esc)', onclick: () => this.close() }, '×')),
      h('div', { class: 'v-body' }, e.view, e.text),
      h('footer', { class: 'v-foot' }, e.info, e.actions),
    );
    this._tab('view');
  }

  _tab(id) {
    for (const b of [this.els.viewTab, this.els.textTab]) b.classList.toggle('on', b.dataset.tab === id);
    this.els.view.hidden = id !== 'view';
    this.els.text.hidden = id !== 'text';
  }

  _header() {
    const c = this.current;
    const e = this.els;
    e.kind.textContent = [kindLabel(c.kind), formatBytes(c.size)].filter(Boolean).join(' · ');
    e.name.textContent = c.name;
    e.name.title = c.name;
    e.path.textContent = middle(c.path);
    e.path.title = c.path;
    const ask = (verb) => () => this.app.send(`${verb} ${c.name}.`);
    const readable = !c.failed && (READABLE.has(c.kind) || HEARABLE.has(c.kind));
    const there = c.path && !c.failed;
    e.actions.replaceChildren(...[
      readable && h('button', { class: 'btn', onclick: ask('Summarize') }, 'Summarize'),
      readable && h('button', { class: 'btn', onclick: ask('Transcribe') }, 'Transcribe'),
      there && h('button', { class: 'btn', onclick: () => this._openOutside() }, 'Open in default app'),
      there && h('button', { class: 'btn', onclick: () => this.api.invoke('fs:reveal', c.path) }, 'Show in folder'),
      h('button', { class: 'btn', onclick: () => this.close() }, 'Close'),
    ].filter(Boolean));
  }

  async _openOutside() {
    const res = await this.api.invoke('fs:open', this.current.path).catch(() => 'failed');
    if (res) this.app.toast('I could not open that in another app.', true);
  }

  _line(text) {
    this.els.info.textContent = text || '';
  }

  _message(text) {
    this.els.view.replaceChildren(h('div', { class: 'v-message' }, text));
  }

  // ---- kinds -------------------------------------------------------------------

  _image(url, seq) {
    const img = h('img', { class: 'v-image', alt: this.current.name, draggable: 'false' });
    const stage = h('div', { class: 'v-stage' }, img);
    this.els.view.replaceChildren(stage);
    const view = { s: 1, x: 0, y: 0, fit: 1 };
    const apply = () => {
      img.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.s})`;
      img.classList.toggle('pixel', view.s >= 2.5);
    };
    const size = () => [img.naturalWidth || 300, img.naturalHeight || 150];
    const reset = () => {
      const [w, hh] = size();
      const cw = stage.clientWidth;
      const ch = stage.clientHeight;
      view.fit = view.s = Math.min((cw - 24) / w, (ch - 24) / hh, 8);
      view.x = (cw - w * view.s) / 2;
      view.y = (ch - hh * view.s) / 2;
      apply();
    };
    stage.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = stage.getBoundingClientRect();
      const cx = e.clientX - r.left;
      const cy = e.clientY - r.top;
      const next = Math.min(Math.max(view.s * Math.exp(-e.deltaY * 0.0015), view.fit * 0.25), 64);
      view.x = cx - ((cx - view.x) * next) / view.s;
      view.y = cy - ((cy - view.y) * next) / view.s;
      view.s = next;
      apply();
    }, { passive: false });
    let drag = null;
    stage.addEventListener('pointerdown', (e) => { drag = { x: e.clientX - view.x, y: e.clientY - view.y }; stage.setPointerCapture(e.pointerId); stage.classList.add('grab'); });
    stage.addEventListener('pointermove', (e) => { if (!drag) return; view.x = e.clientX - drag.x; view.y = e.clientY - drag.y; apply(); });
    const end = () => { drag = null; stage.classList.remove('grab'); };
    stage.addEventListener('pointerup', end);
    stage.addEventListener('pointercancel', end);
    stage.addEventListener('dblclick', reset);
    const ro = new ResizeObserver(() => reset());
    this.cleanup.push(() => ro.disconnect());
    return new Promise((resolve, reject) => {
      img.onload = () => {
        if (seq !== this.seq) return resolve();
        reset();
        ro.observe(stage);
        if (img.naturalWidth) this._line(`${img.naturalWidth} × ${img.naturalHeight} px · scroll to zoom, drag to pan, double-click to fit`);
        resolve();
      };
      img.onerror = () => reject(new Error('I could not draw that image.'));
      img.src = url;
    });
  }

  async _model(path, seq) {
    const c = this.current;
    if (c.size > BIG_MODEL && !this._bigOk?.has(path)) {
      this.els.view.replaceChildren(h('div', { class: 'v-message' },
        h('p', {}, `This model is ${formatBytes(c.size)}. It may take a while to load.`),
        h('div', { class: 'row' },
          h('button', { class: 'btn solid', onclick: () => { (this._bigOk ||= new Set()).add(path); this.open(path); } }, 'Load it'),
          h('button', { class: 'btn', onclick: () => this._openOutside() }, 'Open in default app'))));
      return;
    }
    const status = h('div', { class: 'v-loading' }, 'Loading model…');
    const host = h('div', { class: 'v-model' }, status);
    this.els.view.replaceChildren(host);
    const { ModelView } = await import('./model3d.js');
    if (seq !== this.seq) return;
    const mv = new ModelView(host, { path, ext: extOf(path), url: fileUrl, onProgress: (f) => { status.textContent = `Loading model… ${Math.round(f * 100)}%`; } });
    this.cleanup.push(() => mv.dispose());
    this.model = mv;
    this.cleanup.push(() => { if (this.model === mv) this.model = null; });
    let stats;
    try {
      stats = await mv.load();
    } catch (err) {
      if (seq !== this.seq) return;
      mv.dispose();
      throw new Error(err?.plain ? err.message : 'I could not read that model.');
    }
    if (seq !== this.seq || !stats) return;
    status.remove();
    const seg = h('div', { class: 'seg v-look' },
      ...['hologram', 'solid'].map((look) => h('button', { class: look === mv.look ? 'on' : '', onclick: (e) => {
        mv.setLook(look);
        for (const b of seg.children) b.classList.toggle('on', b === e.currentTarget);
      } }, look)));
    this.els.tools.replaceChildren(seg);
    const counts = stats.triangles ? `${stats.vertices.toLocaleString()} vertices · ${stats.triangles.toLocaleString()} triangles` : `${stats.vertices.toLocaleString()} points`;
    this._line(`${counts} · ${stats.size} units · drag to turn`);
  }

  async _pdf(url, seq, focus) {
    this.els.view.replaceChildren(h('div', { class: 'v-loading' }, 'Opening PDF…'));
    const pdfjs = await import('pdfjs-dist');
    pdfjs.GlobalWorkerOptions.workerSrc = `${DIST}pdfjs/pdf.worker.mjs`;
    const data = await (await fetch(url)).arrayBuffer();
    if (seq !== this.seq) return;
    const task = pdfjs.getDocument({
      data,
      isEvalSupported: false,
      standardFontDataUrl: `${DIST}pdfjs/standard_fonts/`,
      cMapUrl: `${DIST}pdfjs/cmaps/`,
      wasmUrl: `${DIST}pdfjs/wasm/`,
    });
    this.cleanup.push(() => task.destroy());
    let doc;
    try {
      doc = await task.promise;
    } catch (err) {
      throw new Error(/password/i.test(err?.name || err?.message) ? 'That PDF is locked with a password.' : 'I could not read that PDF.');
    }
    if (seq !== this.seq) return;
    const first = await doc.getPage(1);
    const ratio = first.getViewport({ scale: 1 }).height / first.getViewport({ scale: 1 }).width;
    const scroller = h('div', { class: 'v-pdf' });
    this.els.view.replaceChildren(scroller);
    const width = () => Math.min(scroller.clientWidth - 40, 980);
    const pages = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const box = h('div', { class: 'v-page', 'data-page': i }, h('span', { class: 'v-page-no' }, String(i)));
      box.style.width = `${width()}px`;
      box.style.height = `${Math.round(width() * ratio)}px`;
      scroller.append(box);
      pages.push(box);
    }
    const drawn = new Map();
    const draw = async (box) => {
      const n = Number(box.dataset.page);
      if (drawn.has(n)) return;
      drawn.set(n, true);
      const page = await doc.getPage(n);
      if (seq !== this.seq) return;
      const w = width();
      const base = page.getViewport({ scale: 1 });
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const viewport = page.getViewport({ scale: (w / base.width) * dpr });
      const canvas = h('canvas', { width: Math.floor(viewport.width), height: Math.floor(viewport.height) });
      box.style.height = `${Math.round(viewport.height / dpr)}px`;
      const job = page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport });
      this.cleanup.push(() => job.cancel());
      try {
        await job.promise;
        box.prepend(canvas);
      } catch { drawn.delete(n); }
      page.cleanup();
    };
    const io = new IntersectionObserver((entries) => {
      for (const en of entries) if (en.isIntersecting) draw(en.target);
    }, { root: scroller, rootMargin: '600px 0px' });
    for (const p of pages) io.observe(p);
    this.cleanup.push(() => io.disconnect());
    this._line(`${doc.numPages} page${doc.numPages === 1 ? '' : 's'}`);
    const page = Math.min(doc.numPages, Math.max(1, Number(focus) || 1));
    if (page > 1) requestAnimationFrame(() => pages[page - 1].scrollIntoView({ block: 'start' }));
  }

  async _text(url, seq) {
    this.truncated = false;
    if (this.current.size === 0) return ''; // no bytes to ask a range of: an empty file is empty text
    const res = await fetch(url, { headers: { Range: `bytes=0-${TEXT_CAP - 1}` } });
    if (!res.ok) throw new Error('I could not read that file.');
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (seq !== this.seq) return '';
    const text = decodeText(bytes); // UTF-8, or UTF-16 by its byte-order mark or its NULs
    if (text == null) return null;
    this.truncated = this.current.size > bytes.length;
    return text;
  }

  _pretty(text) {
    if (extOf(this.current.path) === 'json' || extOf(this.current.path) === 'geojson') {
      try { return JSON.stringify(JSON.parse(text), null, 2); } catch { /* shown as written */ }
    }
    return text;
  }

  _note() {
    return this.truncated ? `showing the first ${formatBytes(TEXT_CAP)}` : '';
  }

  _code(text, focus) {
    const lines = text.split('\n');
    if (lines.length > 1 && lines.at(-1) === '') lines.pop();
    const gutter = h('pre', { class: 'v-gutter' }, lines.map((_, i) => i + 1).join('\n'));
    const src = h('pre', { class: 'v-src' }, lines.join('\n'));
    const box = h('div', { class: 'v-code' }, gutter, src);
    this.els.view.replaceChildren(box);
    this._line([`${lines.length.toLocaleString()} line${lines.length === 1 ? '' : 's'}`, this._note()].filter(Boolean).join(' · '));
    const line = Number(focus);
    if (line > 1) requestAnimationFrame(() => { box.scrollTop = (line - 1) * parseFloat(getComputedStyle(src).lineHeight) - 40; });
  }

  _csv(text) {
    const ext = extOf(this.current.path);
    const firstLine = text.slice(0, text.indexOf('\n') >>> 0);
    const delimiter = ext === 'tsv' ? '\t' : (firstLine.split(';').length > firstLine.split(',').length ? ';' : ',');
    const rows = parseCsv(text, delimiter, CSV_ROWS + 2);
    while (rows.length && rows.at(-1).every((c) => c === '')) rows.pop();
    const [headRow = [], ...body] = rows;
    const shown = body.slice(0, CSV_ROWS);
    const table = h('table', { class: 'v-table' },
      h('thead', {}, h('tr', {}, h('th', {}, '#'), headRow.map((c) => h('th', {}, c)))),
      h('tbody', {}, shown.map((r, i) => h('tr', {}, h('td', {}, String(i + 1)), r.map((c) => h('td', {}, c))))));
    this.els.view.replaceChildren(h('div', { class: 'v-table-wrap' }, table));
    const more = body.length > CSV_ROWS || this.truncated;
    this._line([`${headRow.length} column${headRow.length === 1 ? '' : 's'}`, `${more ? 'first ' : ''}${shown.length.toLocaleString()} row${shown.length === 1 ? '' : 's'}`, this._note()].filter(Boolean).join(' · '));
  }

  async _markdown(text, seq) {
    const { renderMarkdown } = await import('./markdown.js');
    if (seq !== this.seq) return;
    const doc = h('article', { class: 'v-md' });
    doc.append(renderMarkdown(text, { dir: dirOf(this.current.path), fileUrl }));
    doc.addEventListener('click', (e) => {
      const a = e.target.closest('a');
      if (!a) return;
      e.preventDefault();
      const href = a.getAttribute('data-href') || '';
      if (href.startsWith('#')) doc.querySelector(`[id="${CSS.escape(decodeURIComponent(href.slice(1)))}"]`)?.scrollIntoView({ block: 'start' });
      else if (/^https?:/i.test(href)) window.open(href); // the main process hands web links to the browser
      else if (a.dataset.local) this.open(a.dataset.local);
    });
    this.els.view.replaceChildren(h('div', { class: 'v-md-wrap' }, doc));
    this._line(this._note());
  }

  _media(url, kind, focus) {
    const el = h(kind, { class: `v-${kind}`, controls: true, preload: 'metadata' });
    const voice = this.app.voice();
    const sink = voice?.sinkId || '';
    if (sink && el.setSinkId) el.setSinkId(sink).catch(() => {});
    const hold = (on) => voice?.hold?.('viewer', on);
    el.addEventListener('playing', () => hold(true));
    for (const ev of ['pause', 'ended', 'emptied', 'error']) el.addEventListener(ev, () => hold(false));
    el.addEventListener('loadedmetadata', () => {
      const t = Number(focus);
      if (t > 0 && t < el.duration) el.currentTime = t;
      const d = el.duration;
      const time = Number.isFinite(d) ? `${Math.floor(d / 60)}:${String(Math.floor(d % 60)).padStart(2, '0')}` : '';
      const dims = kind === 'video' && el.videoWidth ? `${el.videoWidth} × ${el.videoHeight}` : '';
      this._line([time, dims].filter(Boolean).join(' · '));
    });
    el.addEventListener('error', () => this._line('This file will not play here — try Open in default app.'));
    el.src = url;
    this.cleanup.push(() => { hold(false); el.pause(); el.removeAttribute('src'); el.load(); });
    const body = kind === 'audio'
      ? h('div', { class: 'v-audio-card' }, h('div', { class: 'v-glyph' }, extOf(this.current.path) || 'audio'), h('div', { class: 'v-audio-name' }, this.current.name), el)
      : el;
    this.els.view.replaceChildren(h('div', { class: 'v-media' }, body));
  }

  _info() {
    const c = this.current;
    const ext = extOf(c.path);
    this.els.view.replaceChildren(h('div', { class: 'v-message v-card' },
      h('div', { class: 'v-glyph' }, ext || 'file'),
      h('div', { class: 'v-audio-name' }, c.name),
      h('dl', {},
        h('dt', {}, 'Size'), h('dd', {}, formatBytes(c.size) || '—'),
        h('dt', {}, 'Modified'), h('dd', {}, c.modified ? c.modified.toLocaleString() : '—'),
        h('dt', {}, 'Kind'), h('dd', {}, c.kind === 'office' ? `${ext} document` : ext ? `.${ext} file` : 'file')),
      h('p', {}, c.kind === 'office' ? 'I cannot draw this here, but I can read it for you — or open it in its own app.' : 'I cannot show this kind of file here.'),
      h('div', { class: 'row' }, h('button', { class: 'btn solid', onclick: () => this._openOutside() }, 'Open in default app'))));
  }
}
