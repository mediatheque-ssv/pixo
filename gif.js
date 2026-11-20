/* ═══════════════════════════════════════════════════════════════════════════
   Pixo — lecture des GIF (y compris animés), sans dépendance
   Utilisé par index.html (Redimensionner) pour garder l'animation.

   PixoGif.parse(octets)   → { width, height, frames: [...], loops }
   PixoGif.frames(gif)     → itérateur d'images complètes, dans l'ordre :
                             { data: Uint8ClampedArray RGBA (largeur × hauteur), delay (ms) }
                             (le même tableau est réutilisé d'une image à l'autre)

   Décodage LZW repris d'omggif (Dean McNamee, licence MIT).
   ═══════════════════════════════════════════════════════════════════════════ */
(function (root) {
'use strict';

const u16 = (b, p) => b[p] | (b[p + 1] << 8);
function ascii(b, p, n) { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(b[p + i]); return s; }

function parse(input) {
  const b = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (ascii(b, 0, 3) !== 'GIF') throw new Error('Ce fichier n\'est pas un GIF.');
  const width = u16(b, 6), height = u16(b, 8), flags = b[10];
  let p = 13, gct = null;
  if (flags & 0x80) { const n = 3 << ((flags & 7) + 1); gct = b.subarray(p, p + n); p += n; }
  const frames = [];
  let gce = null, loops = -1;      // -1 : l'animation ne se joue qu'une fois
  while (p < b.length) {
    const t = b[p++];
    if (t === 0x3B) break;                                   // fin du fichier
    if (t === 0x21) {                                        // extension
      const label = b[p++];
      if (label === 0xF9 && b[p] >= 4) {
        const f = b[p + 1];
        gce = { dispose: (f >> 2) & 7, delay: u16(b, p + 2) * 10, transparent: f & 1 ? b[p + 4] : -1 };
      } else if (label === 0xFF && b[p] === 11 && /^(NETSCAPE2\.0|ANIMEXTS1\.0)$/.test(ascii(b, p + 1, 11)) && b[p + 12] >= 3) {
        loops = u16(b, p + 14);                              // 0 : en boucle
      }
      while (p < b.length) { const n = b[p++]; if (!n) break; p += n; }
      continue;
    }
    if (t !== 0x2C) break;                                   // bloc inconnu : on s'arrête là
    const x = u16(b, p), y = u16(b, p + 2), w = u16(b, p + 4), h = u16(b, p + 6), f = b[p + 8];
    p += 9;
    let lct = null;
    if (f & 0x80) { const n = 3 << ((f & 7) + 1); lct = b.subarray(p, p + n); p += n; }
    const minCode = b[p++];
    const parts = [];
    let size = 0;
    while (p < b.length) { const n = b[p++]; if (!n) break; parts.push(b.subarray(p, p + n)); size += n; p += n; }
    const data = new Uint8Array(size);
    let o = 0;
    for (const part of parts) { data.set(part, o); o += part.length; }
    frames.push({ x, y, w, h, interlaced: !!(f & 0x40), palette: lct || gct, minCode, data,
      dispose: gce ? gce.dispose : 0, delay: gce ? gce.delay : 0, transparent: gce ? gce.transparent : -1 });
    gce = null;
  }
  return { width, height, frames, loops };
}

// Décompression LZW → un index de couleur par pixel
function lzw(minSize, data, out) {
  const clear = 1 << minSize, eoi = clear + 1, n = out.length;
  const table = new Int32Array(4096);
  let next = eoi + 1, prev = -1, size = minSize + 1, mask = (1 << size) - 1;
  let cur = 0, shift = 0, p = 0, op = 0;
  for (;;) {
    while (shift < 16 && p < data.length) { cur |= data[p++] << shift; shift += 8; }
    if (shift < size) break;
    let code = cur & mask;
    cur >>>= size; shift -= size;
    if (code === clear) { next = eoi + 1; size = minSize + 1; mask = (1 << size) - 1; prev = -1; continue; }
    if (code === eoi) break;
    const chaseCode = code < next ? code : prev;
    if (chaseCode < 0) break;
    let len = 0, chase = chaseCode;
    while (chase > clear) { chase = table[chase] >> 8; ++len; }
    const k = chase;
    if (op + len + (chaseCode !== code ? 1 : 0) >= n) {      // image plus courte que prévu : on remplit ce qui tient
      const s = []; let c = chaseCode;
      for (let i = 0; i < len; i++) { s.push(table[c] & 0xFF); c = table[c] >> 8; }
      s.push(k); s.reverse(); if (chaseCode !== code) s.push(k);
      for (let i = 0; i < s.length && op < n; i++) out[op++] = s[i];
      break;
    }
    out[op++] = k;
    op += len;
    let q = op;
    if (chaseCode !== code) out[op++] = k;
    chase = chaseCode;
    while (len--) { chase = table[chase]; out[--q] = chase & 0xFF; chase >>= 8; }
    if (prev >= 0 && next < 4096) {
      table[next++] = (prev << 8) | k;
      if (next >= mask + 1 && size < 12) { ++size; mask = (mask << 1) | 1; }
    }
    prev = code;
  }
  return out;
}

// Ordre des lignes d'une image entrelacée
function interlacedRows(h) {
  const rows = [];
  for (const [start, step] of [[0, 8], [4, 8], [2, 4], [1, 2]]) for (let y = start; y < h; y += step) rows.push(y);
  return rows;
}

// Images complètes, en appliquant les règles d'effacement entre deux images
function* frames(gif) {
  const W = gif.width, H = gif.height;
  const canvas = new Uint8ClampedArray(W * H * 4);       // fond transparent, comme dans les navigateurs
  let saved = null;
  for (const f of gif.frames) {
    if (f.dispose === 3) saved = canvas.slice();
    const pal = f.palette;
    if (pal && f.w && f.h) {
      const idx = lzw(f.minCode, f.data, new Uint8Array(f.w * f.h));
      const rows = f.interlaced ? interlacedRows(f.h) : null;
      const ncol = pal.length / 3;
      for (let r = 0; r < f.h; r++) {
        const y = f.y + (rows ? rows[r] : r);
        if (y >= H) continue;
        for (let c = 0; c < f.w; c++) {
          const x = f.x + c;
          if (x >= W) break;
          const ci = idx[r * f.w + c];
          if (ci === f.transparent || ci >= ncol) continue;
          const o = (y * W + x) * 4;
          canvas[o] = pal[ci * 3]; canvas[o + 1] = pal[ci * 3 + 1]; canvas[o + 2] = pal[ci * 3 + 2]; canvas[o + 3] = 255;
        }
      }
    }
    yield { data: canvas, delay: f.delay };
    if (f.dispose === 2) {
      for (let y = f.y; y < Math.min(H, f.y + f.h); y++) canvas.fill(0, (y * W + f.x) * 4, (y * W + Math.min(W, f.x + f.w)) * 4);
    } else if (f.dispose === 3 && saved) canvas.set(saved);
  }
}

const API = { parse, frames };
if (typeof module !== 'undefined' && module.exports) module.exports = API;
else root.PixoGif = API;
})(typeof self !== 'undefined' ? self : this);
