/**
 * Fetching and reading a web page, shared by the Express dev server
 * (server/index.js) and the Cloudflare Pages Function
 * (functions/local/fetch-url.ts). Plain ESM so both runtimes can import it.
 *
 * Address screening differs between the two and is injected as `screenHost`:
 * Node resolves the host and checks every answer, Workers cannot resolve at
 * all and rely on the platform refusing to route to private space.
 */
import sanitizeHtml from 'sanitize-html';

export const MAX_BYTES = 5 * 1024 * 1024;
export const FETCH_TIMEOUT_MS = 10_000;

const BROWSER_HEADERS = {
  // Some sites serve a JS-only shell to unknown agents; a normal browser UA
  // gets the readable HTML.
  'user-agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36',
  accept: 'text/html,application/xhtml+xml',
};

export function isBlockedAddress(ip) {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a >= 224) return true;
    return false;
  }
  const v6 = ip.toLowerCase();
  if (v6 === '::1' || v6 === '::') return true;
  if (v6.startsWith('fc') || v6.startsWith('fd')) return true;
  if (v6.startsWith('fe80')) return true;
  if (v6.startsWith('::ffff:')) return isBlockedAddress(v6.slice(7));
  return false;
}

/** Hostname-only screen: literal private addresses and names that can only
 *  mean the local machine. All this catches on its own is the obvious case —
 *  a caller with no DNS must pair it with a runtime that refuses to route to
 *  private space. */
export function screenHostLiterally(host) {
  const bare = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (bare === 'localhost' || bare.endsWith('.localhost') || bare.endsWith('.local')) {
    throw new Error('That host resolves to a private or local address.');
  }
  if (/^[\d.]+$/.test(bare) || bare.includes(':')) {
    if (isBlockedAddress(bare)) throw new Error('That host resolves to a private or local address.');
  }
}

async function assertPublicUrl(raw, screenHost) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('That is not a valid URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only http and https URLs are supported.');
  }
  await screenHost(url.hostname);
  return url;
}

// Fetching an arbitrary user-supplied URL is a server-side request forgery
// primitive, so redirects are followed by hand: a public host must not be able
// to bounce us to a private one on a hop the screen never sees.
export async function fetchPage(startUrl, screenHost) {
  let url = await assertPublicUrl(startUrl, screenHost);
  for (let hop = 0; hop < 5; hop += 1) {
    const res = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: BROWSER_HEADERS,
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      url = await assertPublicUrl(new URL(res.headers.get('location'), url).toString(), screenHost);
      continue;
    }
    if (!res.ok) throw new Error(`The page returned HTTP ${res.status}.`);
    const type = res.headers.get('content-type') ?? '';
    if (!type.includes('html')) {
      throw new Error(`That URL is ${type.split(';')[0] || 'not HTML'} — only web pages are supported.`);
    }
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > MAX_BYTES) throw new Error('That page is larger than the 5MB limit.');
    const bytes = await res.arrayBuffer();
    if (bytes.byteLength > MAX_BYTES) throw new Error('That page is larger than the 5MB limit.');
    return { finalUrl: url.toString(), html: new TextDecoder('utf-8').decode(bytes) };
  }
  throw new Error('Too many redirects.');
}

// Most article pages wrap the real content in <main> or <article>; keeping
// only that drops the site chrome (language lists, menus, footers) that would
// otherwise dominate the first section. Falls back to the whole document.
export function narrowToContent(html) {
  for (const tag of ['main', 'article']) {
    const open = new RegExp(`<${tag}[\\s>]`, 'i').exec(html);
    const close = html.toLowerCase().lastIndexOf(`</${tag}>`);
    if (open && close > open.index) {
      const inner = html.slice(open.index, close + tag.length + 3);
      if (inner.length > 500) return inner;
    }
  }
  return html;
}

export function extractTitle(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!m) return null;
  return m[1].replace(/\s+/g, ' ').trim() || null;
}

// Strip the page down to readable markup: no scripts, styles, iframes, forms
// or event handlers, and every relative URL made absolute so images and links
// still resolve where the client renders them.
export function clean(html, baseUrl) {
  const absolute = (value) => {
    try {
      return new URL(value, baseUrl).toString();
    } catch {
      return null;
    }
  };
  return sanitizeHtml(html, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat([
      'img', 'figure', 'figcaption', 'h1', 'h2', 'main', 'article', 'section', 'header', 'footer',
    ]),
    allowedAttributes: {
      a: ['href', 'title'],
      img: ['src', 'alt', 'title', 'width', 'height'],
      '*': ['id'],
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesByTag: { img: ['http', 'https', 'data'] },
    nonTextTags: ['style', 'script', 'textarea', 'option', 'noscript', 'svg', 'title'],
    exclusiveFilter: (frame) => ['nav', 'form', 'iframe', 'object', 'embed'].includes(frame.tag),
    transformTags: {
      a: (tagName, attribs) => {
        const href = attribs.href ? absolute(attribs.href) : null;
        return {
          tagName,
          attribs: href ? { href, target: '_blank', rel: 'noopener noreferrer nofollow' } : {},
        };
      },
      img: (tagName, attribs) => {
        const src = attribs.src ? absolute(attribs.src) : null;
        return { tagName, attribs: src ? { ...attribs, src } : { alt: attribs.alt ?? '' } };
      },
    },
  });
}

const BLOCK_BREAKS = /<\/(p|div|li|tr|h[1-6]|section|article|blockquote|pre)>/gi;

function textOf(fragment) {
  return sanitizeHtml(fragment.replace(BLOCK_BREAKS, '\n'), { allowedTags: [], allowedAttributes: {} })
    .replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .trim();
}

// Split the cleaned markup at top-level headings so the agent can address
// parts of the page the same way it addresses PDF pages. The markup blocks
// are returned alongside the text: the client renders exactly these, so its
// scroll positions stay index-aligned with the sections the tools serve
// instead of both sides re-deriving the split.
export function sectionize(cleanHtml, fallbackTitle) {
  const parts = cleanHtml.split(/(?=<h[12][\s>])/i).filter((p) => textOf(p).length > 0);
  const sections = [];
  const blocks = [];
  for (const part of parts) {
    const heading = /<h[12][^>]*>([\s\S]*?)<\/h[12]>/i.exec(part);
    const label = heading ? textOf(heading[1]).slice(0, 80) : null;
    sections.push({
      index: sections.length,
      label: label || (sections.length === 0 ? fallbackTitle : `Section ${sections.length + 1}`),
      text: textOf(part),
    });
    blocks.push(part);
  }
  return { sections, blocks };
}

/** The one request handler both runtimes wrap: takes the raw `url` field a
 *  client sent and returns either the read page or the message to show. */
export async function readPage(rawUrl, screenHost) {
  const target = typeof rawUrl === 'string' ? rawUrl.trim() : '';
  if (!target) return { status: 400, body: { error: 'Expected a "url" field.' } };

  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(target)?.[1]?.toLowerCase();
  if (scheme && scheme !== 'http' && scheme !== 'https') {
    return { status: 400, body: { error: 'Only http and https URLs are supported.' } };
  }

  try {
    const { finalUrl, html } = await fetchPage(scheme ? target : `https://${target}`, screenHost);
    const title = extractTitle(html) ?? new URL(finalUrl).hostname;
    const { sections, blocks } = sectionize(clean(narrowToContent(html), finalUrl), title);
    if (sections.length === 0) {
      return { status: 422, body: { error: 'That page had no readable text — it may be script-rendered.' } };
    }
    return { status: 200, body: { url: finalUrl, title, sections, blocks } };
  } catch (err) {
    const message =
      err?.name === 'TimeoutError' ? 'That page took too long to respond.' : String(err?.message || err);
    return { status: 400, body: { error: message } };
  }
}
