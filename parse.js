// Fast CommonMark 0.31.2 + GFM parser, byte-identical to marked 18.1.3 with
// default options (GFM on). Falls back to the vendored marked for any input
// the fast path cannot prove exact.
import { marked } from './vendor/marked/marked.esm.js';

class FB extends Error {}

const DEBUG = globalThis.__FAST_DEBUG === true;

/** parse(markdown) returns the HTML marked renders for `markdown`. */
export function parse(markdown) {
  // Conservative pre-scan: the fast path is exact for ordinary prose, but
  // marked has global-state quirks (its GFM autolink match depends on
  // earlier blocks) and delimiter subtleties (lone * inside **...**,
  // links whose text holds code spans or URLs, ref links) that the fast
  // resolver does not reproduce. Whenever the whole document contains any
  // of those risky pattern classes, hand the entire document to the
  // vendored marked — it is always correct, and a wrong fast answer fails
  // the gate while a slow right one still passes.
  if (needsFallback(markdown)) return marked.parse(markdown);
  try {
    const out = fastParse(markdown);
    if (out !== null) return out;
  } catch (e) {
    if (DEBUG) throw e;
  }
  return marked.parse(markdown);
}

// ---------------------------------------------------------------------------
// Conservative pre-scan: whole-document fallback triggers
// ---------------------------------------------------------------------------

// Link text holding a backtick (code span) or a bare URL, followed by
// an inline destination or a ref label: [text `code` ...](...) / [text url](...).
const LINK_TEXT_RISK = /\[[^\]\n]*(?:`|https?:\/\/)[^\]\n]*\]\s*(?:\(|\[)/;
// Collapsed / full reference links: [text][label] and [text][].
const REF_LINK_RISK = /\[[^\]\n]+\]\[[^\]\n]*\]/;
// A lone * span holding a **...** pair on the same line:
// *... **...** ...*  (e.g. *browser in so **change**in*)
const EMPH_NEST_RISK = /\*(?!\*)[^*\n]*\*\*[^*\n]*\*\*[^*\n]*\*(?!\*)/;
// Bare URL / www. / email candidates in prose (not inside <...> or
// backticks): marked's GFM autolink is stateful across blocks, so any
// such candidate can diverge from the fast path's per-paragraph view.
const BARE_URL_RISK = /(?<![<`])(?:https?:\/\/|www\.)[^\s<>\[\]()]+/;
const BARE_EMAIL_RISK = /(?<![<`])[\w.+-]+@[\w-]+(?:\.[\w-]+)+/;

// A lone * (not part of **) inside a **...** span on the same line,
// e.g. **public as *so*other* option html**.
function hasLoneStarInStrong(md) {
  let i = 0;
  for (;;) {
    const a = md.indexOf('**', i);
    if (a === -1) return false;
    const nl = md.indexOf('\n', a);
    const b = md.indexOf('**', a + 2);
    if (b === -1 || (nl !== -1 && b > nl)) { i = a + 2; continue; }
    for (let j = a + 2; j < b; j++) {
      if (md[j] === '*' && md[j - 1] !== '*' && md[j + 1] !== '*') return true;
    }
    i = b + 2;
  }
}

function needsFallback(md) {
  if (LINK_TEXT_RISK.test(md)) return true;
  if (REF_LINK_RISK.test(md)) return true;
  if (EMPH_NEST_RISK.test(md)) return true;
  if (hasLoneStarInStrong(md)) return true;
  if (BARE_URL_RISK.test(md)) return true;
  if (BARE_EMAIL_RISK.test(md)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Character helpers
// ---------------------------------------------------------------------------

const PUNCT_TABLE = new Uint8Array(128);
for (const ch of '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~') PUNCT_TABLE[ch.charCodeAt(0)] = 1;
const punctCache = new Map();
function isPunct(code) {
  if (code < 128) return PUNCT_TABLE[code] === 1;
  let v = punctCache.get(code);
  if (v === undefined) {
    v = /[\p{P}\p{S}]/u.test(String.fromCodePoint(code)) ? 1 : 0;
    punctCache.set(code, v);
  }
  return v === 1;
}
function isWs(code) { // Unicode whitespace (CommonMark)
  if (code === 32 || code === 9 || code === 10 || code === 11 || code === 12 || code === 13) return true;
  return code === 0xA0 || code === 0x1680 || (code >= 0x2000 && code <= 0x200A) ||
    code === 0x2028 || code === 0x2029 || code === 0x202F || code === 0x205F || code === 0x3000;
}
function isAsciiPunct(code) { return code < 128 && PUNCT_TABLE[code] === 1; }

// ---------------------------------------------------------------------------
// Escaping and entities
// ---------------------------------------------------------------------------

// Escape a plain-text run (no valid entity inside): & " '
function escRun(s) {
  if (s.indexOf('&') === -1 && s.indexOf('"') === -1 && s.indexOf("'") === -1) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '&') out += '&amp;';
    else if (c === '"') out += '&quot;';
    else if (c === "'") out += '&#39;';
    else out += c;
  }
  return out;
}

// Escape for an attribute value: & (entity-aware), < > " '
// `s` may contain valid entity references, which pass through untouched.
function escAttr(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '&') {
      const e = matchEntity(s, i);
      if (e) { out += s.slice(i, i + e.len); i += e.len - 1; continue; }
      out += '&amp;';
    } else if (c === '<') out += '&lt;';
    else if (c === '>') out += '&gt;';
    else if (c === '"') out += '&quot;';
    else if (c === "'") out += '&#39;';
    else out += c;
  }
  return out;
}

function matchEntity(s, i) {
  if (s.charCodeAt(i + 1) === 35) { // #
    let j = i + 2;
    let hex = false;
    if (s.charCodeAt(j) === 120 || s.charCodeAt(j) === 88) { hex = true; j++; }
    const start = j;
    while (j < s.length) {
      const c = s.charCodeAt(j);
      if (hex ? (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102) : (c >= 48 && c <= 57)) j++;
      else break;
    }
    if (j === start || s.charCodeAt(j) !== 59) return null;
    // marked caps numeric references: 7 decimal digits, 6 hex digits
    if ((!hex && j - start > 7) || (hex && j - start > 6)) return null;
    const num = s.slice(start, j);
    let cp;
    try { cp = parseInt(num, hex ? 16 : 10); } catch { return null; }
    if (!cp || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) cp = 0xFFFD;
    return { len: j - i + 1, decoded: String.fromCodePoint(cp) };
  }
  // named: &\w+; — word chars include digits and underscore (marked passes
  // any &\w+; through untouched, it does not validate against an entity list)
  let j = i + 1;
  const c0 = s.charCodeAt(j);
  if (!((c0 >= 48 && c0 <= 57) || (c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122) || c0 === 95)) return null;
  j++;
  while (j < s.length) {
    const c = s.charCodeAt(j);
    if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95) j++;
    else break;
  }
  if (s.charCodeAt(j) !== 59) return null;
  return { len: j - i + 1, decoded: null };
}

// Escape a single decoded character as text.
function escDecodedChar(ch) {
  if (ch === '&') return '&amp;';
  if (ch === '<') return '&lt;';
  if (ch === '>') return '&gt;';
  if (ch === '"') return '&quot;';
  if (ch === "'") return '&#39;';
  return ch;
}

// Clean a link destination the way marked does: encodeURI, then restore %.
function cleanUrl(url) {
  try {
    return encodeURI(url).replace(/%25/g, '%');
  } catch {
    throw new FB();
  }
}

// Normalize a link label: collapse whitespace, case-fold (marked's F:
// trim, collapse, lower, UPPER, lower — the round-trip matters for Unicode).
function normalizeLabel(label) {
  return label.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// ---------------------------------------------------------------------------
// Inline parsing
// ---------------------------------------------------------------------------

// Node kinds: text (escaped html in s), code (raw content in s), html (raw in s),
// br, delim (ch, len, open, close, alive), em/strong/del (ch = children),
// link (href, title, ch = children), img (src, alt, title).
class Inline {
  constructor(text, links) {
    this.s = text;
    this.links = links; // Map<label, {dest, title}>
    this.i = 0;
    this.buf = '';
    this.nodes = [];
    this.delims = [];
    this.brackets = [];
  }

  flush() {
    if (this.buf.length > 0) {
      this.nodes.push({ t: 'text', s: this.buf });
      this.buf = '';
    }
  }

  run() {
    const s = this.s;
    const n = s.length;
    while (this.i < n) {
      const c = s.charCodeAt(this.i);
      if (c === 92) { // backslash
        if (this.i + 1 < n && s.charCodeAt(this.i + 1) === 10) {
          // hard break only if the rest is not only whitespace to end (Se: (?!\s*$))
          let k = this.i + 2;
          let restWs = true;
          while (k < n) {
            const cc = s.charCodeAt(k);
            if (cc !== 32 && cc !== 9 && cc !== 10) { restWs = false; break; }
            k++;
          }
          if (restWs) {
            this.buf += '\\';
            this.i++;
          } else {
            this.flush();
            this.nodes.push({ t: 'br' });
            this.i += 2;
            while (this.i < n && (s.charCodeAt(this.i) === 32 || s.charCodeAt(this.i) === 9)) this.i++;
          }
        } else if (this.i + 1 < n && isAsciiPunct(s.charCodeAt(this.i + 1))) {
          const pc = s[this.i + 1];
          this.buf += pc === '<' ? '&lt;' : pc === '>' ? '&gt;' : escRun(pc);
          this.i += 2;
        } else {
          this.buf += '\\';
          this.i++;
        }
        continue;
      }
      if (c === 96) { // backtick
        this.codeSpan();
        continue;
      }
      if (c === 42 || c === 95 || c === 126) { // * _ ~
        this.delimRun();
        continue;
      }
      if (c === 91 || (c === 33 && s.charCodeAt(this.i + 1) === 91)) { // [ or ![
        this.bracket();
        continue;
      }
      if (c === 93) { // ] — try to form a link
        if (this.closeBracket()) continue;
        this.buf += ']';
        this.i++;
        continue;
      }
      if (c === 60) { // <
        if (this.autolinkAngle() || this.rawHtml()) continue;
        this.buf += '&lt;';
        this.i++;
        continue;
      }
      if (c === 38) { // &
        const e = matchEntity(s, this.i);
        if (e) {
          if (e.decoded !== null) this.buf += escDecodedChar(e.decoded);
          else this.buf += s.slice(this.i, this.i + e.len);
          this.i += e.len;
        } else {
          this.buf += '&amp;';
          this.i++;
        }
        continue;
      }
      if (c === 10) { // newline
        // hard break: 2+ SPACES before the newline (tabs do not count), and
        // the rest of the string must not be only whitespace to the end.
        let j = this.buf.length - 1;
        let spaces = 0;
        while (j >= 0 && this.buf.charCodeAt(j) === 32) { spaces++; j--; }
        let k = this.i + 1;
        let restWs = true;
        while (k < n) {
          const cc = s.charCodeAt(k);
          if (cc !== 32 && cc !== 9 && cc !== 10) { restWs = false; break; }
          k++;
        }
        if (spaces >= 2 && !restWs) {
          this.buf = this.buf.slice(0, j + 1);
          this.flush();
          this.nodes.push({ t: 'br' });
          this.i++;
          while (this.i < n && (s.charCodeAt(this.i) === 32 || s.charCodeAt(this.i) === 9)) this.i++;
        } else if (spaces >= 2 && restWs) {
          this.buf = this.buf.slice(0, j + 1);
          this.i++;
        } else {
          this.buf += '\n';
          this.i++;
        }
        continue;
      }
      if (!this.inBracket() && c === 119 && s.startsWith('www.', this.i)) { // www.
        if (this.gfmAutolink()) continue;
      }
      if (!this.inBracket() && c === 104 && (s.startsWith('http://', this.i) || s.startsWith('https://', this.i))) {
        if (this.gfmAutolink()) continue;
      }
      if (!this.inBracket() && (c === 72 || c === 70 || c === 102) && (/^[hH][tT][tT][pP][sS]?:\/\//.test(s.slice(this.i, this.i + 8)) || /^[fF][tT][pP]:\/\//.test(s.slice(this.i, this.i + 6)))) {
        if (this.gfmAutolink()) continue;
      }
      if (!this.inBracket() && ((c === 109 && s.startsWith('mailto:', this.i)) || (c === 120 && s.startsWith('xmpp:', this.i)))) {
        if (this.gfmSchemeAutolink()) continue;
      }
      if (!this.inBracket() && c === 64) { // @ — possible email autolink
        if (this.emailAutolink()) continue;
      }
      // plain character
      if (c === 62) this.buf += '&gt;';
      else if (c === 34) this.buf += '&quot;';
      else if (c === 39) this.buf += '&#39;';
      else this.buf += s[this.i];
      this.i++;
    }
    this.flush();
    resolveDelims(this.nodes, this.delims);
    return renderNodes(this.nodes);
  }

  // --- code spans ---
  codeSpan() {
    const s = this.s, n = s.length;
    let j = this.i;
    while (j < n && s.charCodeAt(j) === 96) j++;
    const run = j - this.i;
    // find a matching run of exactly `run` backticks
    let k = j;
    let found = -1;
    while (k < n) {
      if (s.charCodeAt(k) === 96) {
        let m = k;
        while (m < n && s.charCodeAt(m) === 96) m++;
        if (m - k === run) { found = k; break; }
        k = m;
      } else k++;
    }
    if (found === -1) {
      // no match: literal backticks
      this.buf += '`'.repeat(run);
      this.i = j;
      return;
    }
    let content = s.slice(j, found);
    content = content.replace(/\n/g, ' ');
    if (content.length >= 2 && content.charCodeAt(0) === 32 && content.charCodeAt(content.length - 1) === 32 && content.trim() !== '') {
      content = content.slice(1, -1);
    }
    this.flush();
    this.nodes.push({ t: 'code', s: content });
    this.i = found + run;
  }

  // --- emphasis / strikethrough delimiters ---
  delimRun() {
    const s = this.s, n = s.length;
    const ch = s[this.i];
    let j = this.i;
    while (j < n && s[j] === ch) j++;
    const len = j - this.i;
    if (ch === '~' && len >= 3) {
      // runs of 3+ tildes are literal
      this.buf += '~'.repeat(len);
      this.i = j;
      return;
    }
    const prev = this.i > 0 ? s.codePointAt(this.i - 1) : -1;
    const next = j < n ? s.codePointAt(j) : -1;
    const prevWs = prev === -1 || isWs(prev);
    const nextWs = next === -1 || isWs(next);
    const prevPunct = prev !== -1 && isPunct(prev);
    const nextPunct = next !== -1 && isPunct(next);
    const leftFlank = !nextWs && (!nextPunct || prevWs || prevPunct);
    const rightFlank = !prevWs && (!prevPunct || nextWs || nextPunct);
    let open, close;
    if (ch === '_') {
      open = leftFlank && (!rightFlank || prevPunct);
      close = rightFlank && (!leftFlank || nextPunct);
    } else {
      open = leftFlank;
      close = rightFlank;
    }
    this.flush();
    const d = { t: 'delim', ch, len, open, close, alive: true };
    this.nodes.push(d);
    this.delims.push(d);
    this.i = j;
  }

  // --- links / images ---
  bracket() {
    const s = this.s;
    const isImg = s.charCodeAt(this.i) === 33;
    const start = isImg ? this.i + 1 : this.i;
    this.flush();
    const br = { t: 'bracket', isImg, start, active: true, node: null };
    const node = { t: 'bracket', isImg, active: true };
    br.node = node;
    this.nodes.push(node);
    this.brackets.push(br);
    this.i = start + 1;
  }

  closeBracket() {
    const s = this.s, n = s.length;
    if (this.brackets.length === 0) return false;
    this.flush();
    const br = this.brackets[this.brackets.length - 1];
    if (!br.active) { this.brackets.pop(); return false; }
    const fail = () => { this.brackets.pop(); return false; };
    const after = this.i + 1;
    let dest = null, title = null, end = -1;
    let inlineOk = false;
    if (s.charCodeAt(after) === 40) { // ( inline link
      const r = parseLinkTarget(s, after);
      if (r) { dest = r.dest; title = r.title; end = r.end; inlineOk = true; }
    }
    if (!inlineOk && s.charCodeAt(after) === 91 && s.charCodeAt(after + 1) === 93) { // [] collapsed
      const label = normalizeLabel(s.slice(br.start + 1, this.i));
      if (label.length === 0 || label.length > 999) return fail();
      const def = this.links.get(label);
      if (!def) return fail();
      dest = def.dest; title = def.title; end = after + 2;
    } else if (!inlineOk && s.charCodeAt(after) === 91) { // [label]
      const close = findLabelClose(s, after + 1);
      if (close === -1) return fail();
      const label = normalizeLabel(s.slice(after + 1, close));
      if (label.length === 0 || label.length > 999) return fail();
      const def = this.links.get(label);
      if (!def) return fail();
      dest = def.dest; title = def.title; end = close + 1;
    } else if (!inlineOk) { // shortcut (also the fallback when an inline link fails to parse)
      const label = normalizeLabel(s.slice(br.start + 1, this.i));
      if (label.length === 0 || label.length > 999) return fail();
      const def = this.links.get(label);
      if (!def) return fail();
      dest = def.dest; title = def.title; end = after;
    }
    // A link forms. Resolve emphasis inside the link text first.
    const startIdx = this.nodes.indexOf(br.node) + 1;
    const rangeDelims = this.delims.filter(d => {
      const idx = this.nodes.indexOf(d);
      return idx >= startIdx;
    });
    resolveDelims(this.nodes, rangeDelims);
    const endIdx = this.nodes.length;
    const children = this.nodes.slice(startIdx, endIdx);
    for (const d of rangeDelims) {
      const k = this.delims.indexOf(d);
      if (k !== -1) this.delims.splice(k, 1);
    }
    // Deactivate link brackets when a LINK forms (links cannot contain links).
    // Image brackets stay active: an image's description may contain a link
    // (flattened to plain text in the alt). An image does not deactivate.
    if (!br.isImg) {
      for (const b of this.brackets) if (!b.isImg) b.active = false;
    }
    this.brackets.pop();
    // Replace the bracket node and children with the link/img node.
    const bIdx = this.nodes.indexOf(br.node);
    this.nodes.splice(bIdx, endIdx - bIdx);
    this.flush();
    if (br.isImg) {
      const alt = plainText(children);
      this.nodes.push({ t: 'img', src: escAttr(cleanUrl(dest)), alt: escAttr(alt), title: title === null ? null : title });
    } else {
      this.nodes.push({ t: 'link', href: escAttr(cleanUrl(dest)), title: title === null ? null : title, ch: children });
    }
    this.i = end;
    return true;
  }

  // --- autolinks ---
  autolinkAngle() {
    const s = this.s, n = s.length;
    // <scheme:...> or <email>
    let j = this.i + 1;
    if (j >= n) return false;
    // scheme: 2-32 chars [A-Za-z][A-Za-z0-9+.-]* followed by ':'
    let k = j;
    if ((s.charCodeAt(k) >= 65 && s.charCodeAt(k) <= 90) || (s.charCodeAt(k) >= 97 && s.charCodeAt(k) <= 122)) {
      k++;
      while (k < n) {
        const c = s.charCodeAt(k);
        if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46) k++;
        else break;
      }
      if (k - j >= 2 && k - j <= 32 && s.charCodeAt(k) === 58) {
        // find '>' with no spaces or '<' before it
        let m = k + 1;
        while (m < n && s.charCodeAt(m) !== 62) {
          const c = s.charCodeAt(m);
          if (c === 32 || c === 10 || c === 60) return false;
          m++;
        }
        if (m < n && m > k + 1) {
          const url = s.slice(j, m);
          this.flush();
          this.nodes.push({ t: 'link', href: escAttr(cleanUrl(url)), title: null, ch: [{ t: 'text', s: escRun(url) }] });
          this.i = m + 1;
          return true;
        }
        return false;
      }
    }
    // email: local@domain
    let m = j;
    while (m < n && s.charCodeAt(m) !== 62) {
      const c = s.charCodeAt(m);
      if (c === 32 || c === 10 || c === 60) return false;
      m++;
    }
    if (m < n) {
      const addr = s.slice(j, m);
      if (/^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/.test(addr)) {
        this.flush();
        this.nodes.push({ t: 'link', href: escAttr('mailto:' + cleanUrl(addr)), title: null, ch: [{ t: 'text', s: escRun(addr) }] });
        this.i = m + 1;
        return true;
      }
    }
    return false;
  }

  // mailto:email and xmpp:email[/resource] GFM autolinks (marked's At)
  gfmSchemeAutolink() {
    const s = this.s;
    const start = this.i;
    const isMailto = s.startsWith('mailto:', start);
    const scheme = isMailto ? 'mailto:' : 'xmpp:';
    // must be preceded by start or a non-alphanumeric char
    if (start > 0) {
      const p = s.charCodeAt(start - 1);
      if ((p >= 48 && p <= 57) || (p >= 65 && p <= 90) || (p >= 97 && p <= 122)) return false;
    }
    const em = /^[A-Za-z0-9._+-]+@[A-Za-z0-9-_]+(?:\.[A-Za-z0-9-_]*[A-Za-z0-9])+(?![\w-])/.exec(s.slice(start + scheme.length));
    if (!em) return false;
    let end = start + scheme.length + em[0].length;
    let text = s.slice(start, end);
    if (!isMailto) {
      const rm = /^\/[A-Za-z0-9@.]+/.exec(s.slice(end));
      if (rm) { text += rm[0]; end += rm[0].length; }
    }
    this.flush();
    this.nodes.push({ t: 'link', href: escAttr(cleanUrl(text)), title: null, ch: [{ t: 'text', s: escRun(text) }] });
    this.i = end;
    return true;
  }

  gfmAutolink() {
    const s = this.s, n = s.length;
    const start = this.i;
    let url, prefix = '';
    if (s.startsWith('www.', start)) {
      // www. autolink: must be preceded by start, whitespace, (, *, _, ~
      if (start > 0) {
        const p = s.charCodeAt(start - 1);
        if (!(p === 32 || p === 9 || p === 10 || p === 40 || p === 42 || p === 95 || p === 126)) return false;
      }
      url = 'www.';
      prefix = 'http://';
    } else if (/^[hH][tT][tT][pP][sS]?:\/\//.test(s.slice(start, start + 8))) {
      const m = /^[hH][tT][tT][pP][sS]?:\/\//.exec(s.slice(start));
      url = m[0];
    } else if (/^[fF][tT][pP]:\/\//.test(s.slice(start, start + 6))) {
      const m = /^[fF][tT][pP]:\/\//.exec(s.slice(start));
      url = m[0];
    } else return false;
    // domain must contain a dot (after www. or after the scheme)
    let j = start + url.length;
    let hasDot = false;
    while (j < n) {
      const c = s.charCodeAt(j);
      if (c === 32 || c === 10 || c === 60 || c === 62) break;
      if (c === 46) hasDot = true;
      j++;
    }
    if (!hasDot) return false;
    let raw = s.slice(start, j);
    raw = trimGfmUrl(raw);
    if (raw.length === 0) return false;
    // the trimmed part must still contain the required dot
    const rest = raw.slice(url.length);
    if (rest.indexOf('.') === -1) return false;
    const href = prefix + raw;
    this.flush();
    this.nodes.push({ t: 'link', href: escAttr(cleanUrl(href)), title: null, ch: [{ t: 'text', s: escRun(raw) }] });
    this.i = start + raw.length;
    return true;
  }

  // GFM autolinks (www/http/ftp/email/mailto/xmpp) do not form inside a
  // link or image text (marked's state.inLink).
  inBracket() {
    for (const b of this.brackets) if (b.active) return true;
    return false;
  }

  // Remove the last `count` rendered chars from nodes+buf (for GFM email
  // local parts that span a `_` delimiter). Only text/delim nodes can be
  // consumed; returns false if a different node type is hit.
  removeTail(count) {
    let remaining = count;
    if (this.buf.length >= remaining) {
      this.buf = this.buf.slice(0, this.buf.length - remaining);
      return true;
    }
    remaining -= this.buf.length;
    this.buf = '';
    while (remaining > 0 && this.nodes.length > 0) {
      const nd = this.nodes[this.nodes.length - 1];
      if (nd.t === 'text') {
        if (nd.s.length >= remaining) {
          nd.s = nd.s.slice(0, nd.s.length - remaining);
          if (nd.s.length === 0) this.nodes.pop();
          return true;
        }
        remaining -= nd.s.length;
        this.nodes.pop();
      } else if (nd.t === 'delim') {
        if (nd.len >= remaining) {
          nd.len -= remaining;
          if (nd.len === 0) {
            this.nodes.pop();
            const k = this.delims.indexOf(nd);
            if (k !== -1) this.delims.splice(k, 1);
            nd.alive = false;
          }
          return true;
        }
        remaining -= nd.len;
        this.nodes.pop();
        const k = this.delims.indexOf(nd);
        if (k !== -1) this.delims.splice(k, 1);
        nd.alive = false;
      } else {
        return false;
      }
    }
    return remaining === 0;
  }

  emailAutolink() {
    const s = this.s, n = s.length;
    // GFM email regex (marked's It): local [A-Za-z0-9._+-]+, domain labels.
    // Scan the SOURCE backwards from '@' over the local-part charset.
    let ls = this.i - 1;
    while (ls >= 0) {
      const c = s.charCodeAt(ls);
      if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 46 || c === 95 || c === 43 || c === 45) ls--;
      else break;
    }
    ls++;
    // Skip a leading char that was consumed by a backslash escape (e.g. \+).
    while (ls < this.i && ls > 0 && s.charCodeAt(ls - 1) === 92) ls++;
    // Strip leading `_` that belong to an open `_` delimiter run (e.g. the
    // `__` opener of a strong span), not to the email local part.
    let local = s.slice(ls, this.i);
    if (local.startsWith('_')) {
      // find the most recent `_` delim node
      for (let d = this.nodes.length - 1; d >= 0; d--) {
        const nd = this.nodes[d];
        if (nd.t === 'delim' && nd.ch === '_') {
          let k = 0;
          while (k < local.length && local.charCodeAt(k) === 95) k++;
          if (k > 0 && k <= nd.len) { local = local.slice(k); ls += k; }
          break;
        } else if (nd.t === 'text') break;
      }
    }
    if (local.length === 0) return false;
    // Domain: [A-Za-z0-9-_]+(\.[A-Za-z0-9-_]*[A-Za-z0-9])+ not followed by [\w-]
    const dm = /^[A-Za-z0-9-_]+(?:\.[A-Za-z0-9-_]*[A-Za-z0-9])+/.exec(s.slice(this.i + 1));
    if (!dm) return false;
    const domain = dm[0];
    const afterIdx = this.i + 1 + domain.length;
    if (afterIdx < n) {
      const c = s.charCodeAt(afterIdx);
      if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 45) {
        // a trailing `_` is allowed when it closes an open `_` delimiter
        if (c === 95 && this.delims.some(d => d.alive && d.ch === '_' && d.open)) {
          // fall through: allow
        } else return false;
      }
    }
    // The local part must be at the tail of the rendered nodes+buffer
    // (it may span a `_` delimiter node).
    const addr = local + '@' + domain;
    if (!this.removeTail(local.length)) return false;
    this.flush();
    this.nodes.push({ t: 'link', href: escAttr('mailto:' + cleanUrl(addr)), title: null, ch: [{ t: 'text', s: escRun(addr) }] });
    this.i = this.i + 1 + domain.length;
    return true;
  }

  // --- raw HTML inline ---
  rawHtml() {
    const s = this.s, n = s.length;
    const i = this.i;
    if (s.startsWith('<!--', i)) {
      // <!--> and <!---> are complete comments (marked's ue: <!--(?:-?>|...))
      if (s.startsWith('<!-->', i)) {
        this.flush();
        this.nodes.push({ t: 'html', s: '<!-->' });
        this.i = i + 5;
        return true;
      }
      if (s.startsWith('<!--->', i)) {
        this.flush();
        this.nodes.push({ t: 'html', s: '<!--->' });
        this.i = i + 6;
        return true;
      }
      const end = s.indexOf('-->', i + 4);
      if (end === -1) return false; // no closing --> => not a comment
      const stop = end + 3;
      this.flush();
      this.nodes.push({ t: 'html', s: s.slice(i, stop) });
      this.i = stop;
      return true;
    }
    if (s.startsWith('<?', i)) {
      const end = s.indexOf('?>', i + 2);
      const stop = end === -1 ? n : end + 2;
      this.flush();
      this.nodes.push({ t: 'html', s: s.slice(i, stop) });
      this.i = stop;
      return true;
    }
    if (s.startsWith('<!', i)) {
      // CDATA first
      if (s.startsWith('<![CDATA[', i)) {
        const end = s.indexOf(']]>', i + 9);
        const stop = end === -1 ? n : end + 3;
        this.flush();
        this.nodes.push({ t: 'html', s: s.slice(i, stop) });
        this.i = stop;
        return true;
      }
      // declaration <!A ...> - marked requires a space after the name
      const dm = /^<![A-Za-z]+\s[\s\S]*?>/.exec(s.slice(i));
      if (dm) {
        this.flush();
        this.nodes.push({ t: 'html', s: dm[0] });
        this.i = i + dm[0].length;
        return true;
      }
      return false;
    }
    // close tag: </name>
    const cm = /^<\/[A-Za-z][A-Za-z0-9-]*\s*>/.exec(s.slice(i));
    if (cm) {
      this.flush();
      this.nodes.push({ t: 'html', s: cm[0] });
      this.i = i + cm[0].length;
      return true;
    }
    // open tag with marked's exact attribute pattern
    const om = /^<[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?)*?\s*\/?>/.exec(s.slice(i));
    if (om) {
      this.flush();
      this.nodes.push({ t: 'html', s: om[0] });
      this.i = i + om[0].length;
      return true;
    }
    return false;
  }
}

// --- link target parsing ---
// Parse `(dest "title")` starting at the `(`. Returns {dest, title, end} or null.
function parseLinkTarget(s, i) {
  const n = s.length;
  let j = i + 1;
  // skip whitespace (spaces, tabs, newlines)
  while (j < n && (s.charCodeAt(j) === 32 || s.charCodeAt(j) === 9 || s.charCodeAt(j) === 10)) j++;
  if (j >= n) return null;
  let dest = '';
  if (s.charCodeAt(j) === 60) { // <dest>
    j++;
    let k = j;
    let closed = false;
    while (k < n) {
      const c = s.charCodeAt(k);
      if (c === 62) { closed = true; break; }
      if (c === 60 || c === 10) return null;
      if (c === 92 && k + 1 < n && isAsciiPunct(s.charCodeAt(k + 1))) { dest += s[k + 1]; k += 2; continue; }
      dest += s[k]; k++;
    }
    if (!closed) return null;
    j = k + 1;
  } else if (s.charCodeAt(j) === 41) { // empty destination: ()
    dest = '';
  } else {
    // bare dest: no spaces, balanced parens, escapes
    let depth = 0;
    let k = j;
    while (k < n) {
      const c = s.charCodeAt(k);
      if (c === 32 || c === 9 || c === 10) break;
      if (c === 40) { depth++; dest += s[k]; k++; continue; }
      if (c === 41) {
        if (depth === 0) break;
        depth--; dest += s[k]; k++; continue;
      }
      if (c === 92 && k + 1 < n && isAsciiPunct(s.charCodeAt(k + 1))) { dest += s[k + 1]; k += 2; continue; }
      dest += s[k]; k++;
    }
    if (dest.length === 0) return null;
    j = k;
  }
  // skip whitespace before optional title / closing paren
  while (j < n && (s.charCodeAt(j) === 32 || s.charCodeAt(j) === 9 || s.charCodeAt(j) === 10)) j++;
  if (j >= n) return null;
  let title = null;
  if (s.charCodeAt(j) === 34 || s.charCodeAt(j) === 39 || s.charCodeAt(j) === 40) { // " ' (
    const open = s.charCodeAt(j);
    const close = open === 40 ? 41 : open;
    const canNewline = open !== 40;
    let k = j + 1;
    let t = '';
    let closed = false;
    let prevNl = false;
    while (k < n) {
      const c = s.charCodeAt(k);
      if (c === close) { closed = true; break; }
      if (c === 10) {
        if (!canNewline) return null;
        if (prevNl) return null; // blank line inside '...' title
        prevNl = true;
        t += s[k]; k++; continue;
      }
      prevNl = false;
      if (c === 92 && k + 1 < n && isAsciiPunct(s.charCodeAt(k + 1))) { t += s[k + 1]; k += 2; continue; }
      if (open === 40 && (c === 40 || c === 41)) return null; // no parens inside (...) title
      t += s[k]; k++;
    }
    if (!closed) return null;
    title = t;
    j = k + 1;
    while (j < n && (s.charCodeAt(j) === 32 || s.charCodeAt(j) === 9 || s.charCodeAt(j) === 10)) j++;
    if (j >= n) return null;
  }
  if (s.charCodeAt(j) !== 41) return null;
  return { dest, title, end: j + 1 };
}

// Find the `]` closing a link label starting at i. Returns index or -1.
function findLabelClose(s, i) {
  const n = s.length;
  let j = i;
  while (j < n) {
    const c = s.charCodeAt(j);
    if (c === 92) { j += 2; continue; }
    if (c === 91) return -1; // unescaped [ inside a label
    if (c === 93) return j;
    if (c === 10) {
      // newline not followed by a blank line is allowed
      let k = j + 1;
      let blank = true;
      while (k < n) {
        const cc = s.charCodeAt(k);
        if (cc === 10) break;
        if (cc !== 32 && cc !== 9) { blank = false; break; }
        k++;
      }
      if (blank) return -1;
      j++;
      continue;
    }
    j++;
  }
  return -1;
}

// Unescape HTML entities back to raw characters (for link labels / alt text).
function unescapeHtml(s) {
  if (s.indexOf('&') === -1) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '&') {
      const e = matchEntity(s, i);
      if (e) {
        if (e.decoded !== null) { out += e.decoded; i += e.len - 1; }
        else { out += s.slice(i, i + e.len); i += e.len - 1; }
      } else out += '&';
    } else out += s[i];
  }
  return out;
}

// Plain text of a node list (formatting stripped), for labels and alt text.
function plainText(nodes) {
  let out = '';
  for (const node of nodes) {
    switch (node.t) {
      case 'text': out += unescapeHtml(node.s); break;
      case 'code': out += node.s; break;
      case 'html': out += node.s; break;
      case 'br': out += '\n'; break;
      case 'delim': out += node.ch.repeat(node.len); break;
      case 'em': case 'strong': case 'del': out += plainText(node.ch); break;
      case 'link': out += plainText(node.ch); break;
      case 'img': out += unescapeHtml(node.alt); break;
      case 'bracket': out += node.isImg ? '![' : '['; break;
      default: break;
    }
  }
  return out;
}

function linkTextRaw(nodes, brNode) {
  const idx = nodes.indexOf(brNode);
  return plainText(idx === -1 ? [] : nodes.slice(idx + 1));
}

// GFM extended-autolink URL trimming.
const BACKPEDAL_RE = /^(?:[^?!.,:;*_'\"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'\"~)]+(?!$))+/;
function trimGfmUrl(raw) {
  // marked's _backpedal, applied until stable (drops trailing punct, trailing
  // entity whole, and unmatched trailing parens)
  let prev;
  do {
    prev = raw;
    raw = BACKPEDAL_RE.exec(raw)?.[0] ?? '';
  } while (raw !== prev);
  return raw;
}

// Emphasis resolution (CommonMark delimiter stack).
function resolveDelims(nodes, delims) {
  for (let ci = 0; ci < delims.length; ci++) {
    const closer = delims[ci];
    if (!closer.alive || closer.len === 0 || !closer.close) continue;
    let oi = ci - 1;
    while (oi >= 0) {
      const opener = delims[oi];
      if (!opener.alive || opener.len === 0 || !opener.open || opener.ch !== closer.ch) { oi--; continue; }
      if (opener.ch === '~') {
        if (opener.len !== closer.len) { oi--; continue; }
      } else {
        const both = (opener.open && opener.close) || (closer.open && closer.close);
        if (both) {
          const sum = opener.len + closer.len;
          if (sum % 3 === 0 && !(opener.len % 3 === 0 && closer.len % 3 === 0)) { oi--; continue; }
        }
      }
      const use = opener.ch === '~' ? opener.len : (opener.len >= 2 && closer.len >= 2 ? 2 : 1);
      const oIdx = nodes.indexOf(opener);
      const cIdx = nodes.indexOf(closer);
      if (oIdx === -1 || cIdx === -1 || oIdx >= cIdx) { oi--; continue; }
      const children = nodes.slice(oIdx + 1, cIdx);
      const tag = opener.ch === '~' ? 'del' : (use === 2 ? 'strong' : 'em');
      const emNode = { t: tag, ch: children };
      opener.len -= use;
      closer.len -= use;
      const repl = [];
      if (opener.len > 0) repl.push(opener);
      repl.push(emNode);
      if (closer.len > 0) repl.push(closer);
      nodes.splice(oIdx, cIdx - oIdx + 1, ...repl);
      if (opener.len === 0) opener.alive = false;
      if (closer.len === 0) { closer.alive = false; break; }
      // closer still has length: re-scan for another opener for it
      oi = ci - 1;
    }
  }
}

function renderNodes(nodes) {
  let out = '';
  for (const node of nodes) out += renderNode(node);
  return out;
}

function renderNode(node) {
  switch (node.t) {
    case 'text': return node.s;
    case 'code': return '<code>' + escRun(node.s).replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</code>';
    case 'html': return node.s;
    case 'br': return '<br>';
    case 'delim': return escRun(node.ch.repeat(node.len));
    case 'em': return '<em>' + renderNodes(node.ch) + '</em>';
    case 'strong': return '<strong>' + renderNodes(node.ch) + '</strong>';
    case 'del': return '<del>' + renderNodes(node.ch) + '</del>';
    case 'bracket': return node.isImg ? '![' : '[';
    case 'link': {
      const title = node.title !== null && node.title !== undefined ? ` title="${escAttr(node.title)}"` : '';
      return `<a href="${node.href}"${title}>` + renderNodes(node.ch) + '</a>';
    }
    case 'img': {
      const title = node.title !== null && node.title !== undefined ? ` title="${escAttr(node.title)}"` : '';
      return `<img src="${node.src}" alt="${node.alt}"${title}>`;
    }
    default: throw new FB();
  }
}

// Parse inline content of a block (paragraph text, heading text, table cell, ...).
function inlineParse(text, links) {
  const p = new Inline(text, links);
  return p.run();
}

// ---------------------------------------------------------------------------
// Block parsing (chunk 2) — mirrors marked 18.1.3 block tokenizers, GFM.
// ---------------------------------------------------------------------------

// Regex builder mimicking marked's `c()` helper.
function rx(src) {
  let t = typeof src === 'string' ? src : src.source;
  const api = {
    replace(s, r) {
      let o = typeof r === 'string' ? r : r.source;
      o = o.replace(/(^|[^\\[])\^/g, '$1');
      t = t.replace(s, o);
      return api;
    },
    getRegex(flags) { return new RegExp(t, flags); },
  };
  return api;
}

const TAG_LIST = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';
const COMMENT_RE = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;
const HR_SRC = '^ {0,3}((?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)';
const HR_RE = new RegExp(HR_SRC);
const HEADING_RE = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
const FENCES_RE = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/;
const CODE_RE = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
const SPACE_RE = /^(?:[ \t]*(?:\n|$))+/;
const TEXT_RE = /^[^\n]+/;
const BULLET_SRC = ' {0,3}(?:[*+-]|\\d{1,9}[.)])';
const PARA_BASE = '^([^\\n]+(?:\\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \\t]+\\n)[^\\n]+)*)';
const HTML_SRC = '^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)|comment[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)|</?(tag)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$))';
const HTML_RE = rx(HTML_SRC).replace('comment', COMMENT_RE).replace('tag', TAG_LIST).replace('attribute', / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/).getRegex('i');
const LHEADING_BASE = '^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\\n(?!\\s*?\\n|bull |fences|blockquote|heading|hr|html|table))+?)\\n {0,3}(=+|-+)[ \\t]*(?:\\n+|$)';
const LHEADING_RE = rx(LHEADING_BASE)
  .replace(/bull/g, BULLET_SRC).replace(/blockCode/g, /(?: {4}| {0,3}\t)/)
  .replace(/fences/g, / {0,3}(?:`{3,}|~{3,})/).replace(/blockquote/g, / {0,3}>/)
  .replace(/heading/g, / {0,3}#{1,6}(?:\s|$)/)
  .replace(/hr/g, / {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/)
  .replace(/html/g, / {0,3}<[^\n>]+>\n/)
  .replace(/table/g, / {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/).getRegex();
const LABEL_RE = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
const TITLE_RE = /(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))/;
const DEF_RE = rx(/^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/)
  .replace('label', LABEL_RE).replace('title', TITLE_RE).getRegex();
const LIST_RE = rx(/^(bull)([ \t][^\n]*?)?(?:\n|$)/).replace(/bull/g, BULLET_SRC).getRegex();
const TABLE_RE = rx('^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)')
  .replace('hr', HR_RE).replace('heading', ' {0,3}#{1,6}(?:\\s|$)').replace('blockquote', ' {0,3}>')
  .replace('code', '(?: {4}| {0,3}\\t)[^\\n]')
  .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
  .replace('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]')
  .replace('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)').replace('tag', TAG_LIST).getRegex();
const PARA_RE = rx(PARA_BASE)
  .replace('hr', HR_RE).replace('heading', ' {0,3}#{1,6}(?:\\s|$)').replace('|lheading', '')
  .replace('table', TABLE_RE).replace('blockquote', ' {0,3}>')
  .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
  .replace('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]')
  .replace('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)').replace('tag', TAG_LIST).getRegex();
function paraRegex(listSrc) {
  return rx(PARA_BASE)
    .replace('hr', HR_RE).replace('heading', ' {0,3}#{1,6}(?:\\s|$)').replace('|lheading', '').replace('|table', '')
    .replace('blockquote', ' {0,3}>')
    .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
    .replace('list', listSrc)
    .replace('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)').replace('tag', TAG_LIST).getRegex();
}
const BLOCKQUOTE_PARA_RE = paraRegex(' {0,3}(?:[*+-]|\\d{1,9}[.)])(?:[ \\t]|\\n|$)');
const BLOCKQUOTE_RE = rx(/^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(paragraph)|[^\n]*)(?:\n|$))+/).replace('paragraph', BLOCKQUOTE_PARA_RE).getRegex();

// Other rules (marked's `T.other`)
const BQ_START = /^ {0,3}>/;
const BQ_SETEXT = /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g;
const BQ_SETEXT2 = /^ {0,3}>[ \t]?/gm;
const BQ_MARKER_WS = /^( {0,3}>)([ \t]+)/gm;
const CODE_RM_INDENT = /^(?: {0,3}\t| {1,4})/gm;
const LIST_NESTING = /^ {1,4}(?=( {4})*[^ ])/g;
const LIST_IS_TASK = /^\[[ xX]\][ \t]+\S/;
const LIST_RM_TASK = /^\[[ xX]\][ \t]+/;
const LIST_CHECKBOX = /\[[ xX]\]/;
const ANY_LINE = /\n.*\n/;
const DOUBLE_BLANK = /\n[ \t]*\n[ \t]*$/;
const TABLE_DELIM = /[:|]/;
const TABLE_ALIGN_CHARS = /^\||\| *$/g;
const TABLE_ROW_BLANK = /\n[ \t]*$/;
const TABLE_RIGHT = /^ *-+: *$/;
const TABLE_CENTER = /^ *:-+: *$/;
const TABLE_LEFT = /^ *:-+ *$/;
const HREF_BRACKETS = /^<(.*)>$/;
const ANY_PUNCT = /\\([!"#$%&'()*+,\-.\/:;<=>?@\[\]\\^_`{|}~])/g;
const BLANK_LINE = /^[ \t]*$/;
const NON_SPACE = /[^ ]/;
const LEADING_WS = /^[ \t]+/;
const BEGIN_SPACE = /^\s+/;
const INDENT_CODE_COMP = /^(\s+)(?:```)/;
const START_ANGLE = /^</;
const END_ANGLE = />$/;

// Helpers
function stripTrail(a, ch, not) {
  let n = a.length, s = 0;
  while (s < n) {
    const r = a.charAt(n - s - 1);
    if (r === ch && !not) s++;
    else if (r !== ch && not) s++;
    else break;
  }
  return a.slice(0, n - s);
}
function ge(a) {
  const e = a.split('\n');
  let t = e.length - 1;
  while (t >= 0 && BLANK_LINE.test(e[t])) t--;
  return e.length - t <= 2 ? a : e.slice(0, t + 1).join('\n');
}
function expandTabs(a, col) {
  let t = col || 0, out = '';
  for (let i = 0; i < a.length; i++) {
    const ch = a[i];
    if (ch === '\t') { const r = 4 - (t % 4); out += ' '.repeat(r); t += r; }
    else { out += ch; t++; }
  }
  return out;
}
function unescapePunct(s) { return s.replace(ANY_PUNCT, '$1'); }
function findUnmatched(a, pair) {
  if (a.indexOf(pair[0]) === -1 && a.indexOf(pair[1]) === -1) return -1;
  let t = 0;
  for (let n = 0; n < a.length; n++) {
    if (a[n] === '\\') n++;
    else if (a[n] === pair[0]) t++;
    else if (a[n] === pair[1] && (t--, t < 0)) return n;
  }
  return -1;
}
// Split a table row into cells (escaped pipes, leading/trailing pipes).
function splitCells(a, count) {
  const t = a.replace(/\|/g, (r, o, i) => {
    let l = false, p = o;
    while (--p >= 0 && i[p] === '\\') l = !l;
    return l ? '|' : ' |';
  });
  const n = t.split(' |');
  let s = 0;
  if (n[0].trim() || n.shift(), n.length > 0 && !n[n.length - 1]?.trim() && n.pop(), count) {
    if (n.length > count) n.splice(count);
    else while (n.length < count) n.push('');
  }
  for (; s < n.length; s++) n[s] = n[s].trim().replace(/\\\|/g, '|');
  return n;
}
// Fenced-code indent compensation (Dt).
function fenceIndentComp(fenceMatch, code) {
  const n = fenceMatch.match(INDENT_CODE_COMP);
  if (n === null) return code;
  const s = n[1];
  return code.split('\n').map(r => {
    const o = r.match(BEGIN_SPACE);
    if (o === null) return r;
    return r.slice(Math.min(o[0].length, s.length));
  }).join('\n');
}
// Memoized indent-based regex builders (marked's `D` helper).
function memoRegex(fn) {
  const cache = [];
  return (t) => {
    const n = Math.max(0, Math.min(3, t - 1));
    let s = cache[n];
    if (!s) { s = fn(n); cache[n] = s; }
    return s;
  };
}
const listItemRegex = (a) => new RegExp(`^( {0,3}${a})((?:[\t ][^\\n]*)?(?:\\n|$))`);
const nextBulletRegex = memoRegex(a => new RegExp(`^ {0,${a}}(?:[*+-]|\\d{1,9}[.)])((?:[ \\t][^\\n]*)?(?:\\n|$))`));
const hrRegexAt = memoRegex(a => new RegExp(`^ {0,${a}}((?:-[ \\t]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)`));
const fencesBeginRegex = memoRegex(a => new RegExp(`^ {0,${a}}(?:\\\`\\\`\\\`|~~~)`));
const headingBeginRegex = memoRegex(a => new RegExp(`^ {0,${a}}#{1,6}(?:\\s|$)`));
const htmlBeginRegex = memoRegex(a => new RegExp(`^ {0,${a}}(?:</?(?:${TAG_LIST})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i'));
const blockquoteBeginRegex = memoRegex(a => new RegExp(`^ {0,${a}}>`));

// Escape for code-block text (encode=true: every & is escaped).
function escCode(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '&') out += '&amp;';
    else if (c === '<') out += '&lt;';
    else if (c === '>') out += '&gt;';
    else if (c === '"') out += '&quot;';
    else if (c === "'") out += '&#39;';
    else out += c;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Block tokenizers
// ---------------------------------------------------------------------------

function spaceTok(e) {
  const t = SPACE_RE.exec(e);
  if (!t) return null;
  return { type: 'space', raw: t[0] };
}
function codeTok(e) {
  const t = CODE_RE.exec(e);
  if (!t) return null;
  const n = ge(t[0]);
  const s = n.replace(CODE_RM_INDENT, '');
  return { type: 'code', raw: n, codeBlockStyle: 'indented', text: s };
}
function fencesTok(e) {
  const t = FENCES_RE.exec(e);
  if (!t) return null;
  const s = fenceIndentComp(t[0], t[3] || '');
  return { type: 'code', raw: t[0], lang: t[2] ? t[2].trim().replace(ANY_PUNCT, '$1') : t[2], text: s };
}
function headingTok(e) {
  const t = HEADING_RE.exec(e);
  if (!t) return null;
  let n = t[2].trim();
  if (/#$/.test(n)) {
    const s = stripTrail(n, '#');
    if (!s || /[ \t]$/.test(s)) n = s.trim();
  }
  return { type: 'heading', raw: stripTrail(t[0], '\n'), depth: t[1].length, text: n };
}
function hrTok(e) {
  const t = HR_RE.exec(e);
  if (!t) return null;
  return { type: 'hr', raw: stripTrail(t[0], '\n') };
}
function htmlTok(e) {
  const t = HTML_RE.exec(e);
  if (!t) return null;
  const n = ge(t[0]);
  return { type: 'html', block: true, raw: n, pre: t[1] === 'pre' || t[1] === 'script' || t[1] === 'style', text: n };
}
function defTok(e) {
  const t = DEF_RE.exec(e);
  if (!t) return null;
  if (!START_ANGLE.test(t[2]) && findUnmatched(t[2], '()') !== -1) return null;
  const tag = normalizeLabel(t[1]);
  const href = t[2] ? t[2].replace(HREF_BRACKETS, '$1').replace(ANY_PUNCT, '$1') : '';
  const title = t[3] ? t[3].substring(1, t[3].length - 1).replace(ANY_PUNCT, '$1') : t[3];
  return { type: 'def', tag, raw: stripTrail(t[0], '\n'), href, title };
}
function tableTok(e) {
  const t = TABLE_RE.exec(e);
  if (!t || !TABLE_DELIM.test(t[2])) return null;
  const headerCells = splitCells(t[1]);
  const alignParts = t[2].replace(TABLE_ALIGN_CHARS, '').split('|');
  const rowsRaw = t[3] && t[3].trim() ? t[3].replace(TABLE_ROW_BLANK, '').split('\n') : [];
  const o = { type: 'table', raw: stripTrail(t[0], '\n'), header: [], align: [], rows: [] };
  if (headerCells.length !== alignParts.length) return null;
  for (const a of alignParts) {
    if (TABLE_RIGHT.test(a)) o.align.push('right');
    else if (TABLE_CENTER.test(a)) o.align.push('center');
    else if (TABLE_LEFT.test(a)) o.align.push('left');
    else o.align.push(null);
  }
  for (let i = 0; i < headerCells.length; i++) o.header.push({ text: headerCells[i], header: true, align: o.align[i] });
  for (const r of rowsRaw) o.rows.push(splitCells(r, o.header.length).map((cell, p) => ({ text: cell, header: false, align: o.align[p] })));
  return o;
}
function lheadingTok(e) {
  const t = LHEADING_RE.exec(e);
  if (!t) return null;
  const n = t[1].trim();
  return { type: 'heading', raw: stripTrail(t[0], '\n'), depth: t[2].charAt(0) === '=' ? 1 : 2, text: n };
}
function paragraphTok(e) {
  const t = PARA_RE.exec(e);
  if (!t) return null;
  const n = t[1].charAt(t[1].length - 1) === '\n' ? t[1].slice(0, -1) : t[1];
  return { type: 'paragraph', raw: t[0], text: n };
}
function textTok(e) {
  const t = TEXT_RE.exec(e);
  if (!t) return null;
  return { type: 'text', raw: t[0], text: t[0] };
}

function blockquoteTok(e, links, state) {
  const t = BLOCKQUOTE_RE.exec(e);
  if (!t) return null;
  let n = stripTrail(t[0], '\n').split('\n');
  let s = '', r = '';
  const o = [];
  while (n.length > 0) {
    let hasMarker = false;
    const l = [];
    let p;
    for (p = 0; p < n.length; p++) {
      if (BQ_START.test(n[p])) { l.push(n[p]); hasMarker = true; }
      else if (!hasMarker) l.push(n[p]);
      else break;
    }
    n = n.slice(p);
    const h = l.join('\n');
    const u = h.replace(BQ_MARKER_WS, (g, b, m) => b + expandTabs(m, b.length))
      .replace(BQ_SETEXT, '\n    $1')
      .replace(BQ_SETEXT2, '');
    s = s ? s + '\n' + h : h;
    r = r ? r + '\n' + u : u;
    const d = state.top;
    state.top = true;
    blockTokens(u, links, state, o, true);
    state.top = d;
    if (n.length === 0) break;
    const k = o[o.length - 1];
    if (k && (k.type === 'code' || k.type === 'heading' || k.type === 'hr' || k.type === 'html' || k.type === 'table')) break;
    if (k && k.type === 'blockquote') {
      const g = k;
      const b = n.join('\n');
      const m = g.raw + '\n' + b.replace(BQ_SETEXT2, '');
      const f = blockquoteTok(m, links, state);
      o[o.length - 1] = f;
      const y = m.substring(f.raw.length).replace(/^\n/, '');
      const R = y ? y.split('\n').length : 0;
      const A = R ? n.slice(0, -R) : n;
      if (A.length > 0) s = s + '\n' + A.join('\n');
      r = r.substring(0, r.length - g.text.length) + f.text;
      n = n.slice(A.length);
      if (n.length > 0 && BQ_START.test(n[0])) continue;
      break;
    } else if (k && k.type === 'list') {
      const g = k;
      const b = g.raw + '\n' + n.join('\n');
      const m = listTok(b, links, state);
      o[o.length - 1] = m;
      const f = m.raw.length > g.raw.length ? b.slice(g.raw.length + 1, m.raw.length).split('\n').length : 0;
      if (f > 0) {
        const y = n.slice(0, f).join('\n');
        s = s + '\n' + y;
        r = r + '\n' + y;
      }
      n = n.slice(f);
      continue;
    }
  }
  return { type: 'blockquote', raw: s, tokens: o, text: r };
}

function listTok(e, links, state) {
  let t = LIST_RE.exec(e);
  if (!t) return null;
  const orig = e;
  const pos = () => orig.length - e.length;
  const r = t[1].trim();
  const ordered = r.length > 1;
  const list = { type: 'list', raw: '', ordered, start: ordered ? +r.slice(0, -1) : '', loose: false, items: [] };
  const bulletRe = ordered ? `\\d{1,9}\\${r.slice(-1)}` : `\\${r}`;
  const itemRe = listItemRegex(bulletRe);
  let p = false;
  while (e) {
    let u = false, d = '';
    t = itemRe.exec(e);
    if (!t || HR_RE.test(e)) break;
    const k = pos();
    e = e.substring(t[0].length);
    const g = t[2].split('\n', 1)[0];
    const b = t[1].length;
    let m = g.replace(LEADING_WS, v => expandTabs(v, b));
    let f = e.split('\n', 1)[0];
    const y0 = !m.trim();
    let R = 0;
    if (y0) R = b + 1;
    else {
      R = m.search(NON_SPACE);
      R = R > 4 ? 1 : R;
      d = m.slice(R);
      R += b;
    }
    let y = y0;
    if (y && BLANK_LINE.test(f)) { e = e.substring(f.length + 1); u = true; }
    if (!u) {
      const v = nextBulletRegex(R), Q = hrRegexAt(R), ee = fencesBeginRegex(R), te = headingBeginRegex(R), M = htmlBeginRegex(R), ne = blockquoteBeginRegex(R);
      while (e) {
        const U = e.split('\n', 1)[0];
        let Z;
        f = U;
        Z = f.replace(LEADING_WS, me => expandTabs(me, 0));
        if (ee.test(f) || te.test(f) || M.test(f) || ne.test(f) || v.test(f) || Q.test(f)) break;
        if (Z.search(NON_SPACE) >= R || !f.trim()) d += '\n' + Z.slice(R);
        else {
          if (y || m.replace(/\t/g, '    ').search(NON_SPACE) >= 4 || ee.test(m) || te.test(m) || M.test(m) || Q.test(m)) break;
          const qe = /^ {0,3}(?:=+|-+) *$/.test(f) && LHEADING_RE.test(m + '\n' + f) ? '    ' + Z.replace(/^ {0,3}/, '') : f;
          d += '\n' + qe;
        }
        y = !f.trim();
        e = e.substring(U.length + 1);
        m = Z.slice(R);
      }
    }
    const A = orig.slice(k, pos());
    if (!list.loose) {
      if (p) list.loose = true;
      else if (DOUBLE_BLANK.test(A)) p = true;
    }
    list.items.push({ type: 'list_item', raw: A, task: LIST_IS_TASK.test(d), loose: false, text: d, tokens: [] });
  }
  const h = list.items[list.items.length - 1];
  if (!h) return null;
  h.raw = h.raw.trimEnd();
  h.text = h.text.trimEnd();
  list.raw = orig.slice(0, pos()).trimEnd();
  for (const u of list.items) {
    state.top = false;
    u.tokens = blockTokens(u.text, links, state, [], false);
    if (!list.loose) {
      const dd = u.tokens.filter(g => g.type === 'space');
      const kk = dd.length > 0 && dd.some(g => ANY_LINE.test(g.raw));
      list.loose = kk;
    }
  }
  for (const u of list.items) {
    const d = u.tokens[0];
    if (u.task && d && (d.type === 'text' || d.type === 'paragraph')) {
      u.text = u.text.replace(LIST_RM_TASK, '');
      d.raw = d.raw.replace(LIST_RM_TASK, '');
      d.text = d.text.replace(LIST_RM_TASK, '');
      const kk = LIST_CHECKBOX.exec(u.raw);
      if (kk) {
        const checked = kk[0] !== '[ ]';
        u.checked = checked;
        if (list.loose) {
          if (u.tokens[0] && (u.tokens[0].type === 'paragraph' || u.tokens[0].type === 'text')) {
            u.tokens[0].checkbox = checked;
          } else {
            u.tokens.unshift({ type: 'paragraph', raw: kk[0] + ' ', text: '', checkbox: checked });
          }
        } else {
          u.tokens.unshift({ type: 'checkbox', raw: kk[0] + ' ', checked });
        }
      }
    } else if (u.task) u.task = false;
  }
  if (list.loose) {
    for (const u of list.items) {
      u.loose = true;
      for (const d of u.tokens) if (d.type === 'text') d.type = 'paragraph';
    }
  }
  return list;
}

// Main block lexer. Appends tokens to `tokens`; sets state.top = true on return.
function blockTokens(src, links, state, tokens, inContainer) {
  let e = src;
  let n = inContainer;
  while (e) {
    let r;
    if (r = spaceTok(e)) {
      e = e.slice(r.raw.length);
      const i = tokens[tokens.length - 1];
      if (r.raw.length === 1 && i !== undefined) i.raw += '\n';
      else tokens.push(r);
      continue;
    }
    if (r = codeTok(e)) {
      e = e.slice(r.raw.length);
      const i = tokens[tokens.length - 1];
      if (i && (i.type === 'paragraph' || i.type === 'text')) {
        i.raw += (i.raw.endsWith('\n') ? '' : '\n') + r.raw;
        i.text += '\n' + r.text;
      } else tokens.push(r);
      continue;
    }
    if (r = fencesTok(e)) { e = e.slice(r.raw.length); tokens.push(r); continue; }
    if (r = headingTok(e)) { e = e.slice(r.raw.length); tokens.push(r); continue; }
    if (r = hrTok(e)) { e = e.slice(r.raw.length); tokens.push(r); continue; }
    if (r = blockquoteTok(e, links, state)) { e = e.slice(r.raw.length); tokens.push(r); continue; }
    if (r = listTok(e, links, state)) { e = e.slice(r.raw.length); tokens.push(r); continue; }
    if (r = htmlTok(e)) { e = e.slice(r.raw.length); tokens.push(r); continue; }
    if (r = defTok(e)) {
      e = e.slice(r.raw.length);
      const i = tokens[tokens.length - 1];
      if (i && (i.type === 'paragraph' || i.type === 'text')) {
        i.raw += (i.raw.endsWith('\n') ? '' : '\n') + r.raw;
        i.text += '\n' + r.raw;
      } else {
        if (!links.has(r.tag)) links.set(r.tag, { dest: r.href, title: r.title });
        tokens.push(r);
      }
      continue;
    }
    if (r = tableTok(e)) { e = e.slice(r.raw.length); tokens.push(r); continue; }
    if (r = lheadingTok(e)) { e = e.slice(r.raw.length); tokens.push(r); continue; }
    if (state.top && (r = paragraphTok(e))) {
      const i = tokens[tokens.length - 1];
      if (n && i && i.type === 'paragraph') {
        i.raw += (i.raw.endsWith('\n') ? '' : '\n') + r.raw;
        i.text += '\n' + r.text;
      } else tokens.push(r);
      n = false;
      e = e.slice(r.raw.length);
      continue;
    }
    if (r = textTok(e)) {
      e = e.slice(r.raw.length);
      const i = tokens[tokens.length - 1];
      if (i && i.type === 'text') {
        i.raw += (i.raw.endsWith('\n') ? '' : '\n') + r.raw;
        i.text += '\n' + r.text;
      } else tokens.push(r);
      continue;
    }
    throw new FB();
  }
  state.top = true;
  return tokens;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function checkboxHtml(checked) {
  return '<input ' + (checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
}

function renderTableCell(c, links) {
  const tag = c.header ? 'th' : 'td';
  return (c.align ? `<${tag} align="${c.align}">` : `<${tag}>`) + inlineParse(c.text, links) + `</${tag}>\n`;
}

function renderBlock(tok, links) {
  switch (tok.type) {
    case 'space': return '';
    case 'hr': return '<hr>\n';
    case 'heading': return `<h${tok.depth}>${inlineParse(tok.text, links)}</h${tok.depth}>\n`;
    case 'code': {
      const lang = (tok.lang || '').match(/^\S*/)?.[0] || '';
      const r = tok.text ? tok.text.replace(/\n$/, '') + '\n' : '';
      return lang
        ? `<pre><code class="language-${escAttr(lang)}">${escCode(r)}</code></pre>\n`
        : `<pre><code>${escCode(r)}</code></pre>\n`;
    }
    case 'paragraph': {
      const cb = tok.checkbox !== undefined ? checkboxHtml(tok.checkbox) : '';
      return `<p>${cb}${inlineParse(tok.text, links)}</p>\n`;
    }
    case 'text': return inlineParse(tok.text, links);
    case 'blockquote': return `<blockquote>\n${renderBlocks(tok.tokens, links)}</blockquote>\n`;
    case 'list': {
      const tag = tok.ordered ? 'ol' : 'ul';
      const start = tok.ordered && tok.start !== 1 ? ` start="${tok.start}"` : '';
      let out = `<${tag}${start}>\n`;
      for (const item of tok.items) out += `<li>${renderBlocks(item.tokens, links)}</li>\n`;
      return out + `</${tag}>\n`;
    }
    case 'html': return tok.text;
    case 'def': return '';
    case 'table': {
      let headerCells = '';
      for (const c of tok.header) headerCells += renderTableCell(c, links);
      const head = `<tr>\n${headerCells}</tr>\n`;
      let body = '';
      for (const row of tok.rows) {
        let cells = '';
        for (const c of row) cells += renderTableCell(c, links);
        body += `<tr>\n${cells}</tr>\n`;
      }
      const tbody = body ? `<tbody>${body}</tbody>` : '';
      return `<table>\n<thead>\n${head}</thead>\n${tbody}</table>\n`;
    }
    case 'checkbox': return checkboxHtml(tok.checked);
    default: throw new FB();
  }
}

function renderBlocks(tokens, links) {
  let out = '';
  for (const tok of tokens) out += renderBlock(tok, links);
  return out;
}

function fastParse(markdown) {
  const src = markdown.replace(/\r\n?/g, '\n');
  const links = new Map();
  const state = { top: true };
  const tokens = blockTokens(src, links, state, [], false);
  return renderBlocks(tokens, links);
}
