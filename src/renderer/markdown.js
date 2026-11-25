// Markdown for the viewer: rendered with marked, then sanitized with DOMPurify. Nothing in a
// document runs or reaches out: scripts, styles, frames and forms are dropped, images load only
// from the file's own folder (through jarvis-file://), and links act only when clicked.
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { resolveLocal } from './viewkit.js';

let ctx = { dir: '', fileUrl: (p) => p };
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.hasAttribute('src')) {
    const src = node.getAttribute('src');
    const local = !SCHEME.test(src) && !src.startsWith('//') && resolveLocal(ctx.dir, src);
    node.removeAttribute('srcset');
    if (src.startsWith('jarvis-file:') || /^data:image\/(png|jpe?g|gif|webp);/i.test(src)) { /* fine as is */ }
    else if (local) node.setAttribute('src', ctx.fileUrl(local));
    else {
      node.removeAttribute('src');
      if (node.tagName === 'IMG') {
        node.setAttribute('alt', `[remote image not loaded${node.getAttribute('alt') ? `: ${node.getAttribute('alt')}` : ''}]`);
        node.setAttribute('title', src);
        node.classList.add('blocked');
      }
    }
  }
  if (node.tagName === 'A' && node.hasAttribute('href')) {
    const href = node.getAttribute('href');
    node.setAttribute('data-href', href);
    node.setAttribute('title', href);
    node.removeAttribute('target');
    if (!SCHEME.test(href) && !href.startsWith('#') && !href.startsWith('//')) {
      const local = resolveLocal(ctx.dir, href);
      if (local) node.setAttribute('data-local', local);
    }
    node.setAttribute('href', '#'); // never navigates; the viewer decides on click
  }
});

// Raw HTML loses its event-handler attributes before DOMPurify parses it, so the browser is never
// even asked to run one (DOMPurify would drop them anyway; this keeps CSP reports out of the log).
marked.use({ renderer: { html: ({ text }) => text.replace(/[\s/]on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '') } });

const PURIFY = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'video', 'audio', 'source', 'picture'],
  FORBID_ATTR: ['style', 'srcset', 'action', 'formaction', 'background', 'poster'],
  ALLOW_DATA_ATTR: false,
};

/** @returns DocumentFragment */
export function renderMarkdown(text, { dir, fileUrl }) {
  ctx = { dir, fileUrl };
  const html = marked.parse(String(text), { gfm: true, async: false });
  const t = document.createElement('template'); // inert: nothing in it loads until it is placed
  t.innerHTML = DOMPurify.sanitize(html, PURIFY);
  for (const img of t.content.querySelectorAll('img.blocked')) { // a quiet note in place of a broken picture
    const note = document.createElement('span');
    note.className = 'blocked';
    note.textContent = img.alt;
    note.title = img.title;
    img.replaceWith(note);
  }
  return t.content;
}
