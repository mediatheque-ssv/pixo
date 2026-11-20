/* ═══════════════════════════════════════════════════════════════════════════
   Pixo — lecture et suppression des métadonnées d'images (JPEG, PNG, WebP)
   Utilisé par demaquia.html et canvify.html. Aucune dépendance, rien n'est
   envoyé sur un serveur.

   PixoMeta.analyze(octets)  → Promise<rapport>   ce que contient l'image
   PixoMeta.strip(octets)    → { bytes, removed, format }   tout est retiré
   PixoMeta.stripAI(octets)  → Promise<idem>   seules les traces d'IA sont retirées

   Suppression par liste blanche : on ne garde que ce qui sert à afficher
   l'image (pixels, profil couleur, orientation, animation). Tout le reste
   part, y compris des métadonnées qui n'existent pas encore. Les pixels ne
   sont jamais recompressés.
   ═══════════════════════════════════════════════════════════════════════════ */
(function (root) {
'use strict';

// ── Octets ───────────────────────────────────────────────────────────────
const TD8 = new TextDecoder('utf-8');
const TD8F = new TextDecoder('utf-8', { fatal: true });
const TDL1 = new TextDecoder('latin1');

function toU8(x) {
  if (x instanceof Uint8Array) return x;
  if (x instanceof ArrayBuffer) return new Uint8Array(x);
  if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
  throw new Error('octets attendus');
}
const u16be = (b, p) => (b[p] << 8) | b[p + 1];
const u32be = (b, p) => b[p] * 16777216 + ((b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]);
const u32le = (b, p) => b[p + 3] * 16777216 + ((b[p + 2] << 16) | (b[p + 1] << 8) | b[p]);
function ascii(b, p, n) {
  let s = '';
  for (let i = 0; i < n && p + i < b.length; i++) s += String.fromCharCode(b[p + i]);
  return s;
}
function startsWith(b, p, str) {
  if (p + str.length > b.length) return false;
  for (let i = 0; i < str.length; i++) if (b[p + i] !== str.charCodeAt(i)) return false;
  return true;
}
function concat(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
function decodeText(u) { try { return TD8F.decode(u); } catch (e) { return TDL1.decode(u); } }
function utf16(u, le) {
  let s = '';
  for (let i = 0; i + 1 < u.length; i += 2) s += String.fromCharCode(le ? u[i] | (u[i + 1] << 8) : (u[i] << 8) | u[i + 1]);
  return s;
}
function clean(s) { return String(s == null ? '' : s).replace(/\u0000+/g, ' ').replace(/[ \t]+$/gm, '').trim(); }
function readable(s) { let n = 0; for (const c of s) if (/[\x20-\x7e\u00c0-\u017f\n]/.test(c)) n++; return n; }

let CRC_TABLE = null;
function crc32(bytes) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// Décompression zlib (textes PNG), limitée pour ne pas se faire piéger
async function inflate(data, max) {
  max = max || 8e6;
  if (typeof DecompressionStream === 'undefined') return null;
  const parts = [];
  let n = 0;
  try {
    const reader = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate')).getReader();
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      parts.push(r.value); n += r.value.length;
      if (n > max) { try { reader.cancel(); } catch (e) {} break; }
    }
  } catch (e) { if (!parts.length) return null; }
  return concat(parts);
}

// ── Formats ──────────────────────────────────────────────────────────────
function detectFormat(input) {
  const b = toU8(input);
  if (b.length > 3 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'jpeg';
  if (b.length > 8 && startsWith(b, 0, '\x89PNG\r\n\x1a\n')) return 'png';
  if (b.length > 12 && startsWith(b, 0, 'RIFF') && startsWith(b, 8, 'WEBP')) return 'webp';
  return null;
}
const FORMAT_LABEL = { jpeg: 'JPEG', png: 'PNG', webp: 'WebP' };
const FORMAT_MIME = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

// Petit bloc EXIF qui ne contient que l'orientation (sinon une photo prise
// en portrait s'afficherait couchée une fois nettoyée)
function tiffOrientation(o) {
  return new Uint8Array([0x4D, 0x4D, 0x00, 0x2A, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, o, 0, 0, 0, 0, 0, 0]);
}
function orientationOf(tiff) {
  const t = parseTiff(tiff);
  if (!t) return 1;
  const o = t.val(t.ifd0[0x0112]);
  return typeof o === 'number' && o >= 2 && o <= 8 ? o : 1;
}

// ── JPEG ─────────────────────────────────────────────────────────────────
function parseJpeg(b) {
  const segs = [];
  const n = b.length;
  let p = 2, eoi = -1;
  while (p < n - 1) {
    if (b[p] !== 0xFF) { const q = b.indexOf(0xFF, p); if (q < 0) break; p = q; continue; }
    const m = b[p + 1];
    if (m === 0xFF) { p++; continue; }                    // octet de remplissage
    if (m === 0xD9) { segs.push({ m, start: p, end: p + 2 }); eoi = p + 2; break; }
    if ((m >= 0xD0 && m <= 0xD7) || m === 0x01 || m === 0x00) { segs.push({ m, start: p, end: p + 2 }); p += 2; continue; }
    if (p + 4 > n) break;
    const seg = { m, start: p, data: p + 4, end: Math.min(n, p + 2 + u16be(b, p + 2)) };
    if (m === 0xDA) {                                     // données compressées jusqu'au marqueur suivant
      let q = seg.end;
      while (q < n - 1 && !(b[q] === 0xFF && b[q + 1] !== 0x00 && !(b[q + 1] >= 0xD0 && b[q + 1] <= 0xD7))) q++;
      seg.end = q < n - 1 ? q : n;
    }
    segs.push(seg);
    p = seg.end;
  }
  return { segs, eoi: eoi < 0 ? n : eoi };
}
const XMP_ID = 'http://ns.adobe.com/xap/1.0/\0';
const XMPEXT_ID = 'http://ns.adobe.com/xmp/extension/\0';
function jpegKind(b, s) {
  const m = s.m, d = s.data;
  if (m === 0xE0) return startsWith(b, d, 'JFIF\0') ? 'jfif' : startsWith(b, d, 'JFXX\0') ? 'jfxx' : 'app';
  if (m === 0xE1) return startsWith(b, d, 'Exif\0') ? 'exif' : startsWith(b, d, XMP_ID) ? 'xmp' : startsWith(b, d, XMPEXT_ID) ? 'xmpext' : 'app';
  if (m === 0xE2) return startsWith(b, d, 'ICC_PROFILE\0') ? 'icc' : startsWith(b, d, 'MPF\0') ? 'mpf' : 'app';
  if (m === 0xEB) return startsWith(b, d, 'JP') ? 'jumbf' : 'app';
  if (m === 0xED) return startsWith(b, d, 'Photoshop 3.0\0') ? 'photoshop' : 'app';
  if (m === 0xEE) return startsWith(b, d, 'Adobe') ? 'adobe' : 'app';   // nécessaire au décodage des couleurs
  if (m === 0xFE) return 'com';
  if (m >= 0xE0 && m <= 0xEF) return 'app';
  return 'image';
}
const JPEG_KEEP = new Set(['image', 'jfif', 'icc', 'adobe']);

function stripJpeg(b) {
  const { segs } = parseJpeg(b);
  const out = [b.subarray(0, 2)];
  let orientDone = false;
  for (const s of segs) {
    const k = jpegKind(b, s);
    if (JPEG_KEEP.has(k)) { out.push(b.subarray(s.start, s.end)); continue; }
    if (k === 'exif' && !orientDone) {
      orientDone = true;
      const o = orientationOf(b.subarray(s.data + 6, s.end));
      if (o > 1) {
        const tiff = tiffOrientation(o), seg = new Uint8Array(4 + 6 + tiff.length);
        seg.set([0xFF, 0xE1, 0, 2 + 6 + tiff.length, 0x45, 0x78, 0x69, 0x66, 0, 0]);
        seg.set(tiff, 10);
        out.push(seg);
      }
    }
  }
  return concat(out);   // ce qui suit la fin de l'image (EOI) n'est pas recopié
}

function jpegJumbf(b, segs) {
  const groups = new Map();
  for (const s of segs) {
    if (jpegKind(b, s) !== 'jumbf' || s.end - s.data < 16) continue;
    const en = u16be(b, s.data + 2), z = u32be(b, s.data + 4);
    if (!groups.has(en)) groups.set(en, []);
    groups.get(en).push({ z, start: s.data + 8, end: s.end });
  }
  const out = [];
  for (const parts of groups.values()) {
    parts.sort((a, c) => a.z - c.z);
    out.push(concat(parts.map((pt, i) => {
      if (i === 0) return b.subarray(pt.start, pt.end);
      const skip = u32be(b, pt.start) === 1 ? 16 : 8;       // en-tête de boîte répété
      return b.subarray(pt.start + skip, pt.end);
    })));
  }
  return out;
}

// ── PNG ──────────────────────────────────────────────────────────────────
function parsePng(b) {
  const chunks = [];
  const n = b.length;
  let p = 8;
  while (p + 12 <= n) {
    const len = u32be(b, p), type = ascii(b, p + 4, 4);
    const end = Math.min(n, p + 12 + len);
    chunks.push({ type, start: p, data: p + 8, dataEnd: Math.min(n, p + 8 + len), end });
    p = end;
    if (type === 'IEND') break;
  }
  return { chunks, end: p };
}
const PNG_KEEP = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'iCCP', 'sBIT',
  'pHYs', 'bKGD', 'hIST', 'sPLT', 'acTL', 'fcTL', 'fdAT', 'cICP', 'mDCV', 'mDCv', 'cLLI', 'cLLi']);
// Un bloc « critique » inconnu (majuscule en tête) est gardé : sans lui l'image pourrait ne plus s'ouvrir
const pngKeep = t => PNG_KEEP.has(t) || (t.charCodeAt(0) >= 65 && t.charCodeAt(0) <= 90);
function pngChunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}
function stripPng(b) {
  const { chunks } = parsePng(b);
  let orient = 1;
  const ex = chunks.find(c => c.type === 'eXIf');
  if (ex) orient = orientationOf(b.subarray(ex.data, ex.dataEnd));
  const out = [b.subarray(0, 8)];
  for (const c of chunks) {
    if (!pngKeep(c.type)) continue;
    out.push(b.subarray(c.start, c.end));
    if (c.type === 'IHDR' && orient > 1) out.push(pngChunk('eXIf', tiffOrientation(orient)));
  }
  return concat(out);
}

// ── WebP ─────────────────────────────────────────────────────────────────
function parseWebp(b) {
  const riffEnd = Math.min(b.length, 8 + u32le(b, 4));
  const chunks = [];
  let p = 12;
  while (p + 8 <= riffEnd) {
    const type = ascii(b, p, 4), len = u32le(b, p + 4);
    const dataEnd = Math.min(riffEnd, p + 8 + len);
    const end = Math.min(riffEnd, p + 8 + len + (len & 1));
    chunks.push({ type, start: p, data: p + 8, dataEnd, end });
    p = end;
  }
  return { chunks, riffEnd };
}
const WEBP_KEEP = new Set(['VP8X', 'VP8 ', 'VP8L', 'ALPH', 'ANIM', 'ANMF', 'ICCP']);
function webpExifTiff(b, c) {
  const d = startsWith(b, c.data, 'Exif\0\0') ? c.data + 6 : c.data;
  return b.subarray(d, c.dataEnd);
}
function stripWebp(b) {
  const { chunks } = parseWebp(b);
  const hasVp8x = chunks.some(c => c.type === 'VP8X');
  const out = [];
  let orientKept = false;
  for (const c of chunks) {
    if (WEBP_KEEP.has(c.type)) { out.push(b.slice(c.start, c.end)); continue; }
    if (c.type === 'EXIF' && hasVp8x && !orientKept) {
      const o = orientationOf(webpExifTiff(b, c));
      if (o > 1) {
        const t = tiffOrientation(o), ch = new Uint8Array(8 + t.length);
        ch.set([0x45, 0x58, 0x49, 0x46, t.length, 0, 0, 0]); ch.set(t, 8);
        out.push(ch); orientKept = true;
      }
    }
  }
  for (const ch of out) {
    if (ascii(ch, 0, 4) === 'VP8X') ch[8] = (ch[8] & ~0x0C) | (orientKept ? 0x08 : 0);   // drapeaux EXIF / XMP
  }
  const body = concat(out);
  const head = new Uint8Array(12);
  head.set([0x52, 0x49, 0x46, 0x46]);
  new DataView(head.buffer).setUint32(4, body.length + 4, true);
  head.set([0x57, 0x45, 0x42, 0x50], 8);
  return concat([head, body]);
}

// ── Suppression ──────────────────────────────────────────────────────────
function strip(input) {
  const b = toU8(input);
  const format = detectFormat(b);
  if (!format) throw new Error('format non pris en charge (JPG, PNG ou WebP)');
  const bytes = format === 'jpeg' ? stripJpeg(b) : format === 'png' ? stripPng(b) : stripWebp(b);
  return { bytes, removed: b.length - bytes.length, format };
}

// ── EXIF (TIFF) ──────────────────────────────────────────────────────────
function parseTiff(b) {
  if (!b || b.length < 8) return null;
  const le = b[0] === 0x49 && b[1] === 0x49;
  if (!le && !(b[0] === 0x4D && b[1] === 0x4D)) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const u16 = p => dv.getUint16(p, le), u32 = p => dv.getUint32(p, le), i32 = p => dv.getInt32(p, le);
  const SZ = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4 };
  const seen = new Set();
  function readIfd(off) {
    const tags = {};
    if (typeof off !== 'number' || off < 8 || off + 2 > b.length || seen.has(off)) return { tags, next: 0 };
    seen.add(off);
    const cnt = u16(off);
    for (let i = 0; i < cnt; i++) {
      const e = off + 2 + i * 12;
      if (e + 12 > b.length) break;
      const type = u16(e + 2), count = u32(e + 4), size = (SZ[type] || 1) * count;
      const vo = size <= 4 ? e + 8 : u32(e + 8);
      if (size > 4e7 || vo + size > b.length) continue;
      tags[u16(e)] = { type, count, off: vo, size };
    }
    const nx = off + 2 + cnt * 12;
    return { tags, next: nx + 4 <= b.length ? u32(nx) : 0 };
  }
  function val(t) {
    if (!t) return undefined;
    const { type, count, off } = t;
    const many = (f, step) => { const a = []; for (let i = 0; i < Math.min(count, 32); i++) a.push(f(off + step * i)); return count === 1 ? a[0] : a; };
    if (type === 2) return clean(decodeText(b.subarray(off, off + count)));
    if (type === 3) return many(u16, 2);
    if (type === 4 || type === 13) return many(u32, 4);
    if (type === 9) return many(i32, 4);
    if (type === 5 || type === 10) return many(p => { const d = type === 5 ? u32(p + 4) : i32(p + 4); return d ? (type === 5 ? u32(p) : i32(p)) / d : 0; }, 8);
    return b.subarray(off, off + t.size);
  }
  const ifd0 = readIfd(u32(4));
  const exif = ifd0.tags[0x8769] ? readIfd(val(ifd0.tags[0x8769])).tags : {};
  const gps = ifd0.tags[0x8825] ? readIfd(val(ifd0.tags[0x8825])).tags : {};
  const ifd1 = ifd0.next ? readIfd(ifd0.next).tags : null;
  return { ifd0: ifd0.tags, exif, gps, ifd1, val };
}
function userComment(u) {
  if (typeof u === 'string') return clean(u);
  if (!(u instanceof Uint8Array) || u.length < 8) return '';
  const head = ascii(u, 0, 8), body = u.subarray(8);
  if (head.startsWith('UNICODE')) {
    const be = utf16(body, false), le = utf16(body, true);
    return clean(readable(be) >= readable(le) ? be : le);
  }
  return clean(decodeText(head.startsWith('ASCII') || head.startsWith('\0\0\0') ? body : u));
}
function exifDate(s) {
  const m = /^(\d{4})[:-](\d\d)[:-](\d\d)[ T](\d\d):(\d\d)/.exec(s || '');
  return m ? m[3] + '/' + m[2] + '/' + m[1] + ' à ' + m[4] + 'h' + m[5] : s;
}
function isoDate(s) {
  const d = new Date(s);
  if (!s || isNaN(d)) return s;
  return d.toLocaleDateString('fr-FR') + ' à ' + d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }).replace(':', 'h');
}
function deviceName(make, model) {
  make = clean(make); model = clean(model);
  return model && make && model.toLowerCase().startsWith(make.toLowerCase().split(' ')[0]) ? model : [make, model].filter(Boolean).join(' ');
}
function gpsItem(lat, lon, alt) {
  const f = x => x.toFixed(5).replace(/\.?0+$/, '');
  const v = f(lat) + ', ' + f(lon) + (typeof alt === 'number' && isFinite(alt) && alt !== 0 ? ' (altitude ' + Math.round(alt) + ' m)' : '');
  return { k: 'Position GPS', v, perso: true,
    href: 'https://www.openstreetmap.org/?mlat=' + f(lat) + '&mlon=' + f(lon) + '#map=16/' + f(lat) + '/' + f(lon) };
}

// ── Indices d'IA ─────────────────────────────────────────────────────────
// Noms d'outils reconnus dans les champs « logiciel » (pas dans l'auteur ou la description).
// Ne sert qu'à nommer l'outil : la détection repose d'abord sur les standards C2PA et IPTC.
const AI_TOOLS = [
  [/chat\s?gpt|openai|dall[\s·.\-]?e|gpt[\s-]?(4o|image)|\bsora\b/i, 'ChatGPT (OpenAI)'],
  [/gemini|imagen|google\s*ai|nano[\s-]?banana|synthid/i, 'Google Gemini'],
  [/firefly|generative\s*(fill|expand)|remplissage\s*g[ée]n[ée]ratif/i, 'Adobe Firefly'],
  [/midjourney|\bniji\b/i, 'Midjourney'],
  [/stable[\s-]?diffusion|\bsdxl\b|stability\s*ai|automatic1111|\ba1111\b|sd\.next/i, 'Stable Diffusion'],
  [/comfy\s?ui/i, 'ComfyUI'], [/invoke\s?ai/i, 'InvokeAI'], [/novel\s?ai/i, 'NovelAI'], [/fooocus/i, 'Fooocus'],
  [/bing\s*image|image\s*creator|microsoft\s*designer|copilot/i, 'Microsoft Copilot'],
  [/meta\s*ai|imagine\s*(with|me)/i, 'Meta AI'],
  [/\bgrok\b|\bx\.?ai\b/i, 'Grok'],
  [/leonardo[\s.]?ai/i, 'Leonardo AI'], [/ideogram/i, 'Ideogram'],
  [/black\s*forest\s*labs|\bflux[\s.]?(1|2|pro|dev|schnell|kontext)/i, 'Flux'],
  [/\bkrea\b/i, 'Krea'], [/playground\s*(ai|v\d)/i, 'Playground'], [/nightcafe/i, 'NightCafe'],
  [/recraft/i, 'Recraft'], [/runway(ml)?\b/i, 'Runway'], [/draw\s*things/i, 'Draw Things'],
  [/diffusion\s?bee/i, 'DiffusionBee'], [/craiyon/i, 'Craiyon'], [/dream\s?studio/i, 'DreamStudio'],
  [/canva\s*(ai|magic)|magic\s*media|dream\s*lab/i, 'Canva (IA)'], [/\bkling\b/i, 'Kling'],
  [/seedream|jimeng|doubao/i, 'Seedream'], [/hunyuan/i, 'Hunyuan'], [/qwen[\s-]?image|tongyi|wanx/i, 'Qwen'],
  [/anthropic|\bclaude\b/i, 'Claude'],
];
function toolOf(s) {
  s = String(s || '');
  for (const [re, name] of AI_TOOLS) if (re.test(s)) return name;
  return null;
}

// Vocabulaire IPTC « Digital Source Type » (origine de l'image)
const DST = {
  trainedAlgorithmicMedia: ['Image générée par IA', 'generated'],
  compositeWithTrainedAlgorithmicMedia: ['Image retouchée ou complétée par IA', 'edited'],
  algorithmicMedia: ['Image créée par un algorithme (sans IA générative)'],
  algorithmicallyEnhanced: ['Image améliorée par un algorithme'],
  compositeSynthetic: ['Montage avec des éléments de synthèse'],
  digitalCapture: ['Photo prise avec un appareil numérique'],
  computationalCapture: ['Photo prise avec un appareil numérique (traitement automatique)'],
  negativeFilm: ['Numérisation d\'un négatif'], positiveFilm: ['Numérisation d\'une diapositive'],
  print: ['Numérisation d\'un tirage'], minorHumanEdits: ['Photo légèrement retouchée'],
  humanEdits: ['Image retouchée à la main'], composite: ['Montage'], compositeCapture: ['Photo composée de plusieurs prises'],
  digitalCreation: ['Création numérique (sans IA)'], digitalArt: ['Création numérique (sans IA)'],
  screenCapture: ['Capture d\'écran'], virtualRecording: ['Enregistrement d\'un monde virtuel'],
  dataDrivenMedia: ['Visualisation de données'], softwareImage: ['Image de synthèse'],
};
function dstOf(v) {
  const key = String(v || '').trim().split('/').pop();
  const d = DST[key];
  return { key, label: d ? d[0] : key, ai: d ? d[1] || null : (/trainedAlgorithmic/i.test(key) ? 'generated' : null) };
}

const C2PA_ACTIONS = {
  'c2pa.created': 'création', 'c2pa.edited': 'retouche', 'c2pa.edited.metadata': 'modification des métadonnées',
  'c2pa.opened': 'ouverture', 'c2pa.placed': 'ajout d\'un élément', 'c2pa.removed': 'suppression d\'éléments',
  'c2pa.converted': 'conversion', 'c2pa.transcoded': 'conversion', 'c2pa.repackaged': 'réempaquetage',
  'c2pa.resized': 'redimensionnement', 'c2pa.cropped': 'recadrage', 'c2pa.color_adjustments': 'réglages de couleur',
  'c2pa.filtered': 'filtre', 'c2pa.drawing': 'dessin', 'c2pa.orientation': 'rotation', 'c2pa.published': 'publication',
  'c2pa.watermarked': 'filigrane', 'c2pa.redacted': 'masquage', 'c2pa.unknown': 'action inconnue',
};

// ── XMP ──────────────────────────────────────────────────────────────────
const xmlUnesc = s => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, '\'')
  .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(+d)).replace(/&amp;/g, '&');
const stripTags = s => xmlUnesc(String(s).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim());
// Toutes les valeurs d'une propriété XMP, quel que soit le préfixe utilisé
function xmpFind(xml, local) {
  const out = [];
  const L = local.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const reA = new RegExp('\\s[\\w.-]+:' + L + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\')', 'g');
  let m;
  while ((m = reA.exec(xml))) { const v = xmlUnesc(m[1] !== undefined ? m[1] : m[2]).trim(); if (v) out.push(v); }
  const reE = new RegExp('<([\\w.-]+:' + L + ')(\\s[^>]*?)?(?:/>|>([\\s\\S]*?)</\\1\\s*>)', 'g');
  while ((m = reE.exec(xml))) {
    const res = /rdf:resource\s*=\s*"([^"]*)"/.exec(m[2] || '');
    if (res) { out.push(xmlUnesc(res[1])); continue; }
    const inner = m[3];
    if (!inner) continue;
    if (/<rdf:li/.test(inner)) {
      const reLi = /<rdf:li(?:\s[^>]*)?>([\s\S]*?)<\/rdf:li>/g;
      let l;
      while ((l = reLi.exec(inner))) { const t = stripTags(l[1]); if (t) out.push(t); }
    } else { const t = stripTags(inner); if (t) out.push(t); }
  }
  return out;
}
const lcFirst = s => s.charAt(0).toLowerCase() + s.slice(1);
const uniq = a => Array.from(new Set(a.filter(Boolean)));
function xmpGps(s) {
  const m = /^(\d+(?:\.\d+)?),(\d+(?:\.\d+)?)(?:,(\d+(?:\.\d+)?))?\s*([NSEW])$/i.exec(String(s).trim());
  if (!m) return NaN;
  const v = +m[1] + m[2] / 60 + (m[3] ? m[3] / 3600 : 0);
  return /[SW]/i.test(m[4]) ? -v : v;
}

// ── CBOR (format des Content Credentials) ────────────────────────────────
function cborDecode(b) {
  let p = 0;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const BREAK = {};
  function half(h) {
    const e = (h >> 10) & 31, f = h & 1023, s = h & 0x8000 ? -1 : 1;
    if (e === 0) return s * f * Math.pow(2, -24);
    if (e === 31) return f ? NaN : s * Infinity;
    return s * (1 + f / 1024) * Math.pow(2, e - 15);
  }
  function len(ai) {
    if (ai < 24) return ai;
    if (ai === 24) return b[p++];
    if (ai === 25) { const v = dv.getUint16(p); p += 2; return v; }
    if (ai === 26) { const v = dv.getUint32(p); p += 4; return v; }
    if (ai === 27) { const v = dv.getUint32(p) * 4294967296 + dv.getUint32(p + 4); p += 8; return v; }
    if (ai === 31) return -1;
    throw new Error('cbor');
  }
  function item(depth) {
    if (depth > 60 || p >= b.length) throw new Error('cbor');
    const ib = b[p++], mt = ib >> 5, ai = ib & 31;
    if (mt === 7) {
      if (ai === 20) return false; if (ai === 21) return true; if (ai === 22) return null;
      if (ai === 25) { const v = half(dv.getUint16(p)); p += 2; return v; }
      if (ai === 26) { const v = dv.getFloat32(p); p += 4; return v; }
      if (ai === 27) { const v = dv.getFloat64(p); p += 8; return v; }
      if (ai === 24) { p++; return undefined; }
      if (ai === 31) return BREAK;
      return undefined;
    }
    const n = len(ai);
    if (mt === 0) return n;
    if (mt === 1) return -1 - n;
    if (mt === 2 || mt === 3) {
      if (n < 0) {
        const parts = [];
        for (let x; (x = item(depth + 1)) !== BREAK;) parts.push(x);
        return mt === 2 ? concat(parts) : parts.join('');
      }
      if (p + n > b.length) throw new Error('cbor');
      const s = b.subarray(p, p + n); p += n;
      return mt === 2 ? s : TD8.decode(s);
    }
    if (mt === 4) {
      const a = [];
      if (n < 0) { for (let x; (x = item(depth + 1)) !== BREAK;) a.push(x); }
      else { if (n > b.length - p) throw new Error('cbor'); for (let i = 0; i < n; i++) a.push(item(depth + 1)); }
      return a;
    }
    if (mt === 5) {
      const o = Object.create(null);
      if (n < 0) { for (let k; (k = item(depth + 1)) !== BREAK;) o[String(k)] = item(depth + 1); }
      else { if (n > b.length - p) throw new Error('cbor'); for (let i = 0; i < n; i++) { const k = item(depth + 1); o[String(k)] = item(depth + 1); } }
      return o;
    }
    return { __tag: n, value: item(depth + 1) };   // mt === 6
  }
  return item(0);
}
const untag = v => (v && typeof v === 'object' && '__tag' in v ? v.value : v);

// ── Certificat X.509 (pour savoir qui a signé) ───────────────────────────
function der(b, p) {
  let l = b[p + 1], h = 2;
  if (l & 0x80) { const nb = l & 0x7F; l = 0; for (let i = 0; i < nb; i++) l = l * 256 + b[p + 2 + i]; h = 2 + nb; }
  return { tag: b[p], data: p + h, end: p + h + l };
}
function derKids(b, t) {
  const out = [];
  for (let p = t.data; p < t.end;) { const c = der(b, p); if (c.end > t.end) break; out.push(c); p = c.end; }
  return out;
}
function derName(b, t) {
  const r = {};
  for (const set of derKids(b, t)) for (const atv of derKids(b, set)) {
    const [oid, v] = derKids(b, atv);
    if (!oid || !v) continue;
    const o = Array.from(b.subarray(oid.data, oid.end)).join('.');
    const raw = b.subarray(v.data, v.end);
    const s = v.tag === 0x1E ? utf16(raw, false) : decodeText(raw);
    if (o === '85.4.3') r.CN = s; else if (o === '85.4.10') r.O = s; else if (o === '85.4.11') r.OU = s;
  }
  return r;
}
function certNames(c) {
  try {
    const cert = der(c, 0);
    let k = derKids(c, derKids(c, cert)[0]);
    if (k[0].tag === 0xA0) k = k.slice(1);
    return { issuer: derName(c, k[2]), subject: derName(c, k[4]) };
  } catch (e) { return null; }
}

// ── JUMBF / C2PA ─────────────────────────────────────────────────────────
function boxes(b, s, e) {
  const out = [];
  let p = s;
  while (p + 8 <= e) {
    let len = u32be(b, p), hdr = 8;
    const type = ascii(b, p + 4, 4);
    if (len === 1) { if (p + 16 > e) break; len = u32be(b, p + 8) * 4294967296 + u32be(b, p + 12); hdr = 16; }
    else if (len === 0) len = e - p;
    if (len < hdr || p + len > e) len = e - p;
    if (len < hdr) break;
    out.push({ type, data: p + hdr, end: p + len });
    p += len;
  }
  return out;
}
function superbox(b, box, depth) {
  if (depth > 12) return null;
  const kids = boxes(b, box.data, box.end);
  if (!kids.length || kids[0].type !== 'jumd') return null;
  const d = kids[0];
  let p = d.data + 16, label = '';
  const toggles = b[p++];
  if (toggles & 0x02) { let q = p; while (q < d.end && b[q] !== 0) q++; label = TD8.decode(b.subarray(p, q)); }
  const node = { label: label.replace(/__\d+$/, ''), children: [], content: [] };
  for (const k of kids.slice(1)) {
    if (k.type === 'jumb') { const c = superbox(b, k, depth + 1); if (c) node.children.push(c); }
    else node.content.push({ type: k.type, data: b.subarray(k.data, k.end) });
  }
  return node;
}
function boxValue(node) {
  for (const c of node.content) {
    try {
      if (c.type === 'cbor') return cborDecode(c.data);
      if (c.type === 'json') return JSON.parse(TD8.decode(c.data));
    } catch (e) { return null; }
  }
  return null;
}
const nameOfAgent = a => (a && typeof a === 'object' ? [a.name, a.version].filter(Boolean).join(' ') : a ? String(a) : '');
function readManifest(m) {
  const info = { actions: [], dst: [], agents: [], ingredients: [], training: null, authors: [], cawg: false,
    exifGps: false, generator: '', title: '', signer: null, issuer: null };
  for (const c of m.children) {
    if (c.label === 'c2pa.assertions') {
      for (const a of c.children) {
        const L = a.label, v = untag(boxValue(a));
        if (/^c2pa\.actions(\.v\d+)?$/.test(L) && v) {
          for (const act of [].concat(v.actions || [])) {
            if (!act || typeof act !== 'object') continue;
            info.actions.push(String(act.action || ''));
            if (act.digitalSourceType) info.dst.push(act.digitalSourceType);
            const ag = nameOfAgent(act.softwareAgent);
            if (ag) info.agents.push(ag);
            if (act.when && !info.when) info.when = act.when;
            const desc = act.description || (act.parameters && (act.parameters.description || act.parameters['com.adobe.description']));
            if (desc && typeof desc === 'string') info.agents.push(desc);
          }
          for (const t of [].concat(v.templates || [])) if (t && t.digitalSourceType) info.dst.push(t.digitalSourceType);
          for (const sa of [].concat(v.softwareAgents || [])) { const n = nameOfAgent(sa); if (n) info.agents.push(n); }
        } else if (/^c2pa\.ingredient/.test(L) && v) {
          const t = v['dc:title'] || v.title;
          if (t) info.ingredients.push(String(t));
        } else if (/training-mining$/.test(L) && v) {
          const e = v.entries || {};
          const g = e['c2pa.ai_generative_training'] || e['cawg.ai_generative_training'] || e['c2pa.ai_training'] || e['cawg.ai_training'];
          if (g && g.use) info.training = g.use;
        } else if (L === 'stds.schema-org.CreativeWork' && v) {
          for (const au of [].concat(v.author || [])) { const n = au && (au.name || (typeof au === 'string' ? au : '')); if (n) info.authors.push(String(n)); }
        } else if (/^cawg\.identity/.test(L)) {
          info.cawg = true;
        } else if (L === 'stds.exif' && v) {
          if (Object.keys(v).some(k => /GPS(Latitude|Longitude)/.test(k))) info.exifGps = true;
        }
      }
    } else if (/^c2pa\.claim(\.v\d+)?$/.test(c.label)) {
      const cl = untag(boxValue(c));
      if (cl) {
        const gi = [].concat(cl.claim_generator_info || [])[0];
        const giName = nameOfAgent(gi);
        info.generator = giName && !/^c2pa/i.test(giName) ? giName : String(cl.claim_generator || giName || '');
        info.title = String(cl['dc:title'] || cl.title || '');
      }
    } else if (c.label === 'c2pa.signature') {
      try {
        const s = untag(boxValue(c));
        if (Array.isArray(s)) {
          const prot = s[0] instanceof Uint8Array && s[0].length ? cborDecode(s[0]) : {};
          const unprot = s[1] || {};
          const x5 = prot['33'] || unprot['33'] || unprot.x5chain || prot.x5chain;
          const leaf = x5 instanceof Uint8Array ? x5 : Array.isArray(x5) ? x5[0] : null;
          const names = leaf && certNames(leaf);
          if (names) { info.signer = names.subject; info.issuer = names.issuer; }
        }
      } catch (e) {}
    }
  }
  return info;
}

// ── IPTC (bloc Photoshop des JPEG) ───────────────────────────────────────
const IIM = { 5: 'Titre', 25: 'Mots-clés', 40: 'Instructions', 55: 'Date de création', 65: 'Logiciel', 80: 'Auteur',
  85: 'Fonction de l\'auteur', 90: 'Ville', 95: 'Région', 101: 'Pays', 105: 'Titre', 110: 'Crédit', 115: 'Source',
  116: 'Copyright', 118: 'Contact', 120: 'Légende', 122: 'Rédacteur' };
const IIM_PERSO = new Set([80, 85, 90, 95, 101, 116, 118, 122]);
function parseIim(b) {
  const out = [];
  let p = 0;
  while (p + 5 <= b.length && b[p] === 0x1C) {
    const rec = b[p + 1], ds = b[p + 2];
    let n = u16be(b, p + 3), h = 5;
    if (n & 0x8000) { const nb = n & 0x7FFF; n = 0; for (let i = 0; i < nb; i++) n = n * 256 + b[p + 5 + i]; h = 5 + nb; }
    out.push({ rec, ds, v: clean(decodeText(b.subarray(p + h, p + h + n))) });
    p += h + n;
  }
  return out;
}
function photoshopResources(b, s, e) {
  const res = [];
  let p = s;
  while (p + 12 <= e && startsWith(b, p, '8BIM')) {
    const id = u16be(b, p + 4), nl = b[p + 6];
    const q = p + 6 + (1 + nl) + ((1 + nl) & 1);
    if (q + 4 > e) break;
    const size = u32be(b, q), d = q + 4;
    res.push({ id, data: b.subarray(d, Math.min(e, d + size)) });
    p = d + size + (size & 1);
  }
  return res;
}

// ── Rapport ──────────────────────────────────────────────────────────────
function newReport(b, format) {
  const ai = { generated: false, edited: false, other: false, tools: [], reasons: [] };
  const R = {
    format, formatLabel: FORMAT_LABEL[format] || '?', mime: FORMAT_MIME[format] || '', size: b.length,
    groups: [], kept: [], personal: [], signers: [], ai,
    group(g) { g.items = g.items.filter(it => it && it.v !== undefined && it.v !== null && String(it.v).trim() !== ''); if (g.items.length || g.note) this.groups.push(g); return g; },
    flag(kind, reason) { if (kind === 'generated') ai.generated = true; else if (kind === 'edited') ai.edited = true; else ai.other = true; if (reason && !ai.reasons.includes(reason)) ai.reasons.push(reason); },
    tool(name) { if (name && !ai.tools.includes(name)) ai.tools.push(name); },
    perso(label) { if (!this.personal.includes(label)) this.personal.push(label); },
    keep(label) { if (!this.kept.includes(label)) this.kept.push(label); },
  };
  return R;
}
// Un champ « logiciel » qui nomme un outil d'IA
function softwareItem(R, k, v, source) {
  const t = toolOf(v);
  if (t) { R.tool(t); R.flag('other', source + ' : ' + clean(v)); }
  return { k, v, ia: !!t };
}

const MJ_JOB = /Job ID:\s*[0-9a-f-]{16,}/i;
const isGenParams = s => /Steps: \d+/.test(s) && /Sampler: /.test(s);
// Une description peut contenir le prompt d'une IA (Midjourney y met « Job ID: … »)
function descItem(R, v) {
  if (MJ_JOB.test(v)) { R.tool('Midjourney'); R.flag('generated', 'prompt Midjourney'); return { k: 'Prompt', v, long: true, ia: true }; }
  if (isGenParams(v)) { R.tool('Stable Diffusion'); R.flag('generated', 'paramètres Stable Diffusion'); return { k: 'Prompt et réglages', v, long: true, ia: true }; }
  return { k: 'Description', v, long: true };
}

function exifGroup(R, tiff, title, size) {
  const t = parseTiff(tiff);
  if (!t) return R.group({ title, size, items: [], note: 'Bloc EXIF illisible.' });
  const v = tag => t.val(t.ifd0[tag]), ve = tag => t.val(t.exif[tag]), vg = tag => t.val(t.gps[tag]);
  const str = x => (typeof x === 'string' ? x : '');
  const items = [];
  const device = deviceName(str(v(0x010F)), str(v(0x0110)));
  if (device) { items.push({ k: 'Appareil', v: device, perso: true }); R.perso('appareil'); }
  const lens = str(ve(0xA434)); if (lens) items.push({ k: 'Objectif', v: lens });
  const serial = str(ve(0xA431)); if (serial) { items.push({ k: 'N° de série', v: serial, perso: true }); R.perso('n° de série'); }
  const owner = str(ve(0xA430)); if (owner) { items.push({ k: 'Propriétaire', v: owner, perso: true }); R.perso('nom'); }
  const artist = str(v(0x013B)); if (artist) { items.push({ k: 'Auteur', v: artist, perso: true }); R.perso('nom'); }
  const xpAuthor = v(0x9C9D); if (xpAuthor instanceof Uint8Array) { const s = clean(utf16(xpAuthor, true)); if (s) { items.push({ k: 'Auteur', v: s, perso: true }); R.perso('nom'); } }
  const copy = str(v(0x8298)); if (copy) items.push({ k: 'Copyright', v: copy });
  const soft = str(v(0x0131)); if (soft) items.push(softwareItem(R, 'Logiciel', soft, 'EXIF'));
  const desc = str(v(0x010E)); if (desc) items.push(descItem(R, desc));
  for (const [tag, k] of [[0x9C9B, 'Titre'], [0x9C9C, 'Commentaire'], [0x9C9E, 'Mots-clés'], [0x9C9F, 'Sujet']]) {
    const x = v(tag); if (x instanceof Uint8Array) { const s = clean(utf16(x, true)); if (s) items.push({ k, v: s }); }
  }
  const uc = userComment(ve(0x9286));
  if (uc) {
    if (/Steps: \d+/.test(uc) && /Sampler: /.test(uc)) {
      items.push({ k: 'Paramètres de génération', v: uc, long: true, ia: true });
      R.flag('generated', 'paramètres Stable Diffusion dans l\'EXIF'); R.tool('Stable Diffusion');
    } else items.push({ k: 'Commentaire', v: uc, long: true });
  }
  const shot = str(ve(0x9003)); if (shot) { items.push({ k: 'Prise de vue', v: exifDate(shot), perso: true }); R.perso('date de prise de vue'); }
  const mod = str(v(0x0132)); if (mod) items.push({ k: 'Modifiée le', v: exifDate(mod) });
  const lat = vg(2), lon = vg(4);
  if (Array.isArray(lat) && Array.isArray(lon) && lat.length >= 2 && lon.length >= 2) {
    let la = lat[0] + lat[1] / 60 + (lat[2] || 0) / 3600, lo = lon[0] + lon[1] / 60 + (lon[2] || 0) / 3600;
    if (/S/i.test(str(vg(1)))) la = -la;
    if (/W/i.test(str(vg(3)))) lo = -lo;
    if (isFinite(la) && isFinite(lo) && (la || lo)) { items.push(gpsItem(la, lo, vg(6))); R.perso('position GPS'); }
  } else if (Object.keys(t.gps).length) items.push({ k: 'GPS', v: 'informations de localisation partielles', perso: true });
  if (t.ifd1 && (t.ifd1[0x0201] || t.ifd1[0x0111])) items.push({ k: 'Miniature', v: 'une petite copie de l\'image est intégrée' });
  const orient = v(0x0112);
  if (typeof orient === 'number' && orient > 1) R.keep('orientation');
  const shown = new Set([0x010F, 0x0110, 0x013B, 0x8298, 0x0131, 0x010E, 0x0132, 0x9C9B, 0x9C9C, 0x9C9D, 0x9C9E, 0x9C9F, 0x8769, 0x8825, 0x0112]);
  const shownExif = new Set([0xA434, 0xA431, 0xA430, 0x9286, 0x9003]);
  const others = Object.keys(t.ifd0).filter(k => !shown.has(+k)).length + Object.keys(t.exif).filter(k => !shownExif.has(+k)).length;
  if (others) items.push({ k: 'Autres', v: others + ' réglage' + (others > 1 ? 's' : '') + ' technique' + (others > 1 ? 's' : '') + ' (exposition, ISO, dimensions…)', muted: true });
  return R.group({ title, size, items });
}

function xmpGroup(R, xml, size, title) {
  const items = [];
  for (const d of uniq(xmpFind(xml, 'DigitalSourceType'))) {
    const o = dstOf(d);
    items.push({ k: 'Origine déclarée', v: o.label, ia: !!o.ai });
    if (o.ai) R.flag(o.ai, 'IPTC : ' + lcFirst(o.label));
  }
  const sys = uniq(xmpFind(xml, 'AISystemUsed')), sysV = uniq(xmpFind(xml, 'AISystemVersionUsed'));
  if (sys.length) {
    items.push({ k: 'Outil d\'IA', v: sys.join(', ') + (sysV.length ? ' ' + sysV.join(', ') : ''), ia: true });
    R.flag('generated', 'IPTC : outil d\'IA déclaré'); R.tool(toolOf(sys.join(' ')) || sys[0]);
  }
  const prompt = uniq(xmpFind(xml, 'AIPromptInformation'));
  if (prompt.length) { items.push({ k: 'Prompt', v: prompt.join('\n'), long: true, ia: true }); R.flag('generated', 'IPTC : prompt'); }
  const pw = uniq(xmpFind(xml, 'AIPromptWriterName'));
  if (pw.length) { items.push({ k: 'Auteur du prompt', v: pw.join(', '), perso: true }); R.perso('nom'); }
  for (const s of uniq(xmpFind(xml, 'CreatorTool'))) items.push(softwareItem(R, 'Logiciel', s, 'XMP'));
  const agents = uniq(xmpFind(xml, 'softwareAgent'));
  if (agents.length) {
    const it = softwareItem(R, 'Logiciels utilisés', agents.join(', '), 'XMP');
    it.long = agents.length > 3; items.push(it);
  }
  for (const s of uniq(xmpFind(xml, 'Credit'))) items.push(softwareItem(R, 'Crédit', s, 'XMP'));
  const creator = uniq(xmpFind(xml, 'creator')).concat(uniq(xmpFind(xml, 'Artist')));
  if (creator.length) { items.push({ k: 'Auteur', v: uniq(creator).join(', '), perso: true }); R.perso('nom'); }
  items.push({ k: 'Titre', v: uniq(xmpFind(xml, 'title')).join(' · ') });
  const descs = uniq(xmpFind(xml, 'description')).join('\n');
  if (descs) items.push(descItem(R, descs));
  items.push({ k: 'Mots-clés', v: uniq(xmpFind(xml, 'subject')).join(', ') });
  items.push({ k: 'Droits', v: uniq(xmpFind(xml, 'rights')).join(' · ') });
  const dev = uniq(xmpFind(xml, 'Make').concat(xmpFind(xml, 'Model'))).join(' ');
  if (dev) { items.push({ k: 'Appareil', v: dev, perso: true }); R.perso('appareil'); }
  const la = xmpGps(xmpFind(xml, 'GPSLatitude')[0] || ''), lo = xmpGps(xmpFind(xml, 'GPSLongitude')[0] || '');
  if (isFinite(la) && isFinite(lo)) { items.push(gpsItem(la, lo)); R.perso('position GPS'); }
  const created = xmpFind(xml, 'DateCreated')[0] || xmpFind(xml, 'CreateDate')[0];
  if (created) items.push({ k: 'Créée le', v: isoDate(created) });
  if (/MotionPhoto|MicroVideo/.test(xml)) items.push({ k: 'Photo animée', v: 'une courte vidéo est intégrée à l\'image' });
  if (/hdrgm:/.test(xml)) items.push({ k: 'HDR', v: 'réglages de luminosité pour les écrans HDR' });
  return R.group({ title: title || 'XMP', size, items, raw: xml.trim() });
}

function c2paGroup(R, j, size) {
  let store = null;
  try { const top = boxes(j, 0, j.length).find(x => x.type === 'jumb'); store = top && superbox(j, top, 0); } catch (e) {}
  if (!store || !store.children.length) {
    return R.group({ title: 'Content Credentials (C2PA)', size, items: [], note: 'Bloc présent mais illisible par Pixo.', tag: 'tech' });
  }
  const manifests = store.children.map(readManifest);
  const act = manifests[manifests.length - 1];       // le manifeste actif est le dernier
  const items = [];
  const signer = act.signer && (act.signer.O || act.signer.CN);
  if (signer) { items.push({ k: 'Signé par', v: signer + (act.signer.O && act.signer.CN && act.signer.CN !== act.signer.O ? ' (' + act.signer.CN + ')' : '') }); R.signers.push(signer); }
  if (act.generator) items.push(softwareItem(R, 'Outil', act.generator, 'C2PA'));
  const dsts = uniq(manifests.flatMap(m => m.dst));
  for (const d of dsts) {
    const o = dstOf(d);
    items.push({ k: 'Origine déclarée', v: o.label, ia: !!o.ai });
    if (o.ai) R.flag(o.ai, 'C2PA : ' + lcFirst(o.label));
  }
  for (const a of uniq(manifests.flatMap(m => m.agents))) { const t = toolOf(a); if (t) { R.tool(t); R.flag('other', 'C2PA : ' + a); } }
  const acts = uniq(act.actions.map(a => C2PA_ACTIONS[a] || a.replace(/^c2pa\./, '')));
  if (acts.length) items.push({ k: 'Étapes', v: acts.join(', ') });
  if (act.when) items.push({ k: 'Date', v: isoDate(act.when) });
  if (act.title) items.push({ k: 'Titre', v: act.title });
  if (manifests.length > 1) items.push({ k: 'Historique', v: manifests.length + ' signatures successives (l\'image a été reprise ou retouchée)' });
  const ingr = uniq(manifests.flatMap(m => m.ingredients));
  if (ingr.length) items.push({ k: 'Images sources', v: ingr.join(', ') });
  const authors = uniq(manifests.flatMap(m => m.authors));
  if (authors.length) { items.push({ k: 'Auteur', v: authors.join(', '), perso: true }); R.perso('nom'); }
  if (manifests.some(m => m.cawg)) { items.push({ k: 'Identité', v: 'identité du créateur intégrée', perso: true }); R.perso('identité'); }
  if (manifests.some(m => m.exifGps)) { items.push({ k: 'Position GPS', v: 'présente dans les Content Credentials', perso: true }); R.perso('position GPS'); }
  if (act.training) items.push({ k: 'Entraînement d\'IA', v: /notAllowed/i.test(act.training) ? 'non autorisé par l\'auteur' : /constrained/i.test(act.training) ? 'autorisé sous conditions' : 'autorisé' });
  return R.group({ title: 'Content Credentials (C2PA)', size, items, c2pa: true,
    note: 'Pixo montre ce que dit cette signature, mais ne peut pas garantir qu\'elle est vraie.' });
}

// Textes intégrés aux PNG (tEXt, zTXt, iTXt)
async function pngText(b, c) {
  const d = b.subarray(c.data, c.dataEnd);
  const z = d.indexOf(0);
  if (z < 0) return null;
  const key = TDL1.decode(d.subarray(0, z));
  let text = '';
  if (c.type === 'tEXt') text = decodeText(d.subarray(z + 1));
  else if (c.type === 'zTXt') { const u = await inflate(d.subarray(z + 2)); text = u ? decodeText(u) : ''; }
  else {
    const comp = d[z + 1];
    let p = z + 3;
    const lz = d.indexOf(0, p); if (lz < 0) return null; p = lz + 1;
    const tz = d.indexOf(0, p); if (tz < 0) return null; p = tz + 1;
    const raw = d.subarray(p);
    const u = comp ? await inflate(raw) : raw;
    text = u ? TD8.decode(u) : '';
  }
  return { key, text, size: c.end - c.start };
}
function hexProfile(text) {         // « Raw profile type exif » d'ImageMagick
  const m = /^\s*\S+\s+(\d+)\s+([\s\S]*)$/.exec(text);
  if (!m) return null;
  const hex = m[2].replace(/[^0-9a-f]/gi, '');
  const out = new Uint8Array(Math.min(+m[1], hex.length >> 1));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}
const PNG_TEXT_LABEL = { title: 'Titre', author: 'Auteur', description: 'Description', copyright: 'Copyright',
  'creation time': 'Créée le', software: 'Logiciel', disclaimer: 'Avertissement', warning: 'Avertissement',
  source: 'Source', comment: 'Commentaire', 'date:create': 'Créée le', 'date:modify': 'Modifiée le', 'date:timestamp': 'Date' };

function genGroup(R, tool, items, size) {
  R.flag('generated', 'paramètres de génération (' + tool + ')');
  R.tool(tool);
  return R.group({ title: 'Paramètres de génération', size, items, tag: 'ia' });
}
function parseA1111(s) {
  const iNeg = s.indexOf('\nNegative prompt:');
  const mSteps = /(^|\n)Steps: \d+/.exec(s);
  const iSteps = mSteps ? mSteps.index : -1;
  const prompt = s.slice(0, iNeg >= 0 ? iNeg : iSteps >= 0 ? iSteps : s.length).trim();
  const neg = iNeg >= 0 ? s.slice(iNeg + 17, iSteps > iNeg ? iSteps : s.length).trim() : '';
  const set = iSteps >= 0 ? s.slice(iSteps).trim() : '';
  const model = /Model: ([^,\n]+)/.exec(set), seed = /Seed: (\d+)/.exec(set);
  return [
    { k: 'Prompt', v: prompt, long: true, ia: true },
    { k: 'À éviter', v: neg, long: true },
    { k: 'Modèle d\'IA', v: model && model[1].trim() },
    { k: 'N° de tirage', v: seed && seed[1] },
    { k: 'Réglages', v: set, long: true, muted: true },
  ];
}
function parseComfy(json) {
  let o;
  try { o = JSON.parse(json); } catch (e) { return null; }
  if (!o || typeof o !== 'object') return null;
  const nodes = Array.isArray(o.nodes) ? o.nodes : Object.values(o);
  const prompts = [], models = [];
  for (const n of nodes) {
    if (!n || typeof n !== 'object') continue;
    const type = String(n.class_type || n.type || '');
    const inp = n.inputs && !Array.isArray(n.inputs) ? n.inputs : {};
    if (/TextEncode/i.test(type)) {
      if (typeof inp.text === 'string') prompts.push(inp.text);
      else if (Array.isArray(n.widgets_values) && typeof n.widgets_values[0] === 'string') prompts.push(n.widgets_values[0]);
    }
    for (const k of ['ckpt_name', 'unet_name', 'model_name']) if (typeof inp[k] === 'string') models.push(inp[k]);
    if (/Loader/i.test(type) && Array.isArray(n.widgets_values) && typeof n.widgets_values[0] === 'string' && /\.(safetensors|ckpt|gguf|pt)$/i.test(n.widgets_values[0])) models.push(n.widgets_values[0]);
  }
  return { prompts: uniq(prompts), models: uniq(models) };
}

async function analyzePngTexts(R, texts) {
  const by = {};
  for (const t of texts) by[t.key.toLowerCase()] = t;
  const used = new Set();
  const sizeOf = keys => keys.reduce((n, k) => n + (by[k] ? by[k].size : 0), 0);
  // Générateurs connus
  if (by.parameters) {
    used.add('parameters');
    const s = by.parameters.text;
    if (/fooocus/i.test(s)) genGroup(R, 'Fooocus', [{ k: 'Paramètres', v: s, long: true, ia: true }], sizeOf(['parameters']));
    else genGroup(R, 'Stable Diffusion', parseA1111(s), sizeOf(['parameters']));
  }
  if (by.prompt || by.workflow) {
    ['prompt', 'workflow'].forEach(k => used.add(k));
    const c = parseComfy((by.prompt || by.workflow).text) || parseComfy((by.workflow || by.prompt).text) || { prompts: [], models: [] };
    genGroup(R, 'ComfyUI', [
      { k: 'Prompt', v: c.prompts.join('\n—\n'), long: true, ia: true },
      { k: 'Modèle d\'IA', v: c.models.join(', ') },
      { k: 'Schéma', v: 'le schéma complet de création est intégré', muted: true },
    ], sizeOf(['prompt', 'workflow']));
  }
  const invoke = ['invokeai_metadata', 'invokeai_graph', 'sd-metadata', 'dream'].filter(k => by[k]);
  if (invoke.length) {
    invoke.forEach(k => used.add(k));
    let p = '';
    try { const m = JSON.parse(by[invoke[0]].text); p = m.positive_prompt || (m.image && m.image.prompt && [].concat(m.image.prompt).map(x => x.prompt || x).join(' ')) || ''; } catch (e) { p = by[invoke[0]].text; }
    genGroup(R, 'InvokeAI', [{ k: 'Prompt', v: String(p), long: true, ia: true }], sizeOf(invoke));
  }
  if (by.software && /novel\s?ai/i.test(by.software.text)) {
    ['software', 'comment', 'description', 'source', 'title', 'generation time'].forEach(k => used.add(k));
    let neg = '';
    try { neg = JSON.parse(by.comment.text).uc || ''; } catch (e) {}
    genGroup(R, 'NovelAI', [
      { k: 'Prompt', v: by.description ? by.description.text : '', long: true, ia: true },
      { k: 'À éviter', v: neg, long: true },
      { k: 'Modèle d\'IA', v: by.source ? by.source.text : '' },
    ], sizeOf(['software', 'comment', 'description', 'source', 'title', 'generation time']));
  }
  // XMP et EXIF rangés dans des textes
  for (const t of texts) {
    const k = t.key.toLowerCase();
    if (used.has(k)) continue;
    if (k === 'xml:com.adobe.xmp') { used.add(k); xmpGroup(R, t.text, t.size); }
    else if (k === 'raw profile type exif' || k === 'raw profile type app1') {
      used.add(k);
      const bytes = hexProfile(t.text);
      if (bytes) exifGroup(R, startsWith(bytes, 0, 'Exif\0') ? bytes.subarray(6) : bytes, 'EXIF', t.size);
    } else if (k === 'raw profile type xmp') {
      used.add(k);
      const bytes = hexProfile(t.text);
      if (bytes) xmpGroup(R, TD8.decode(bytes), t.size);
    }
  }
  // ImageMagick range l'EXIF en dizaines de textes « exif:… » : on n'en montre que l'essentiel
  const im = texts.filter(t => !used.has(t.key.toLowerCase()) && /^(exif|icc|png|tiff|xmp|photoshop|jpeg|8bim|iptc):/i.test(t.key));
  if (im.length) {
    const g = {};
    for (const t of im) { used.add(t.key.toLowerCase()); g[t.key.replace(/^exif:/i, '').toLowerCase()] = clean(t.text); }
    const items = [];
    const dev = deviceName(g.make, g.model);
    if (dev) { items.push({ k: 'Appareil', v: dev, perso: true }); R.perso('appareil'); }
    const serial = [g.bodyserialnumber, g.lensserialnumber].filter(Boolean).join(' · ');
    if (serial) { items.push({ k: 'N° de série', v: serial, perso: true }); R.perso('n° de série'); }
    if (g.artist) { items.push({ k: 'Auteur', v: g.artist, perso: true }); R.perso('nom'); }
    if (g.software) items.push(softwareItem(R, 'Logiciel', g.software, 'PNG'));
    if (g.datetimeoriginal) { items.push({ k: 'Prise de vue', v: exifDate(g.datetimeoriginal), perso: true }); R.perso('date de prise de vue'); }
    const dms = s => { const p = String(s || '').split(',').map(x => { const [n, d] = x.split('/'); return d ? n / d : +n; }); return p.length >= 2 ? p[0] + p[1] / 60 + (p[2] || 0) / 3600 : NaN; };
    let la = dms(g.gpslatitude), lo = dms(g.gpslongitude);
    if (/S/i.test(g.gpslatituderef || '')) la = -la;
    if (/W/i.test(g.gpslongituderef || '')) lo = -lo;
    if (isFinite(la) && isFinite(lo)) { items.push(gpsItem(la, lo)); R.perso('position GPS'); }
    const n = im.length - items.length;
    if (n > 0) items.push({ k: 'Autres', v: n + ' champ' + (n > 1 ? 's' : '') + ' technique' + (n > 1 ? 's' : '') + ' (réglages, profil couleur…)', muted: true });
    R.group({ title: 'EXIF (copie ImageMagick)', size: im.reduce((s, t) => s + t.size, 0), items });
  }
  // Le reste : textes libres
  const rest = texts.filter(t => !used.has(t.key.toLowerCase()));
  if (rest.length) {
    const items = rest.map(t => {
      const k = t.key.toLowerCase();
      const label = PNG_TEXT_LABEL[k] || t.key;
      if (k === 'software' || k === 'source') return softwareItem(R, label, clean(t.text), 'PNG');
      if (k === 'author') { R.perso('nom'); return { k: label, v: clean(t.text), perso: true }; }
      const v = clean(t.text);
      if (k === 'description' || k === 'comment') return Object.assign(descItem(R, v), { k: label });
      return { k: label, v: /^date|creation time/.test(k) ? isoDate(v) : v, long: v.length > 120 };
    });
    R.group({ title: 'Textes intégrés', size: rest.reduce((n, t) => n + t.size, 0), items });
  }
}

function otherGroup(R, list) {
  if (!list.length) return;
  R.group({ title: 'Autres blocs', size: list.reduce((n, x) => n + x.size, 0), tag: 'tech',
    items: list.map(x => ({ k: x.k, v: x.v, muted: true })) });
}
function trailingGroup(R, n) {
  if (n > 0) R.group({ title: 'Données après l\'image', size: n, tag: 'tech',
    items: [{ k: 'Contenu', v: 'souvent une 2e image ou une courte vidéo (photo animée)', muted: true }] });
}

async function analyzeJpeg(b, R) {
  const { segs, eoi } = parseJpeg(b);
  const xmps = [], ext = new Map(), others = [];
  let jumbfSize = 0;
  for (const s of segs) {
    const k = jpegKind(b, s), size = s.end - s.start;
    if (k === 'exif') exifGroup(R, b.subarray(s.data + 6, s.end), 'EXIF', size);
    else if (k === 'xmp') xmps.push({ xml: TD8.decode(b.subarray(s.data + XMP_ID.length, s.end)), size });
    else if (k === 'xmpext' && s.end - s.data > XMPEXT_ID.length + 40) {
      const d = s.data + XMPEXT_ID.length;
      const guid = ascii(b, d, 32), off = u32be(b, d + 36);
      if (!ext.has(guid)) ext.set(guid, { parts: [], size: 0 });
      const g = ext.get(guid); g.parts.push({ off, data: b.subarray(d + 40, s.end) }); g.size += size;
    } else if (k === 'jumbf') jumbfSize += size;
    else if (k === 'photoshop') {
      const res = photoshopResources(b, s.data + 14, s.end);
      const iptc = res.find(r => r.id === 0x0404);
      const items = [];
      if (iptc) for (const f of parseIim(iptc.data)) {
        if (f.rec !== 2 || !IIM[f.ds] || !f.v) continue;
        const perso = IIM_PERSO.has(f.ds);
        if (perso) R.perso(f.ds >= 90 && f.ds <= 101 ? 'lieu' : 'nom');
        items.push(f.ds === 65 ? softwareItem(R, IIM[f.ds], f.v, 'IPTC') : { k: IIM[f.ds], v: f.v, perso, long: f.v.length > 120 });
      }
      if (!items.length) items.push({ k: 'Contenu', v: res.length + ' élément' + (res.length > 1 ? 's' : '') + ' ajouté' + (res.length > 1 ? 's' : '') + ' par Photoshop', muted: true });
      R.group({ title: 'IPTC / Photoshop', size, items });
    } else if (k === 'com') {
      const v = clean(decodeText(b.subarray(s.data, s.end)));
      if (v) R.group({ title: 'Commentaire', size, items: [softwareItem(R, 'Texte', v, 'commentaire')].map(it => Object.assign(it, { long: v.length > 120 })) });
    } else if (k === 'icc') R.keep('profil couleur');
    else if (k === 'jfxx') others.push({ k: 'Miniature', v: 'petite copie de l\'image', size });
    else if (k === 'mpf') others.push({ k: 'Deuxième image', v: 'une autre image est rangée dans le fichier', size });
    else if (k === 'app') others.push({ k: 'Logiciel', v: 'données propres à un logiciel' + ((n => n ? ' (' + n + ')' : '')(clean(ascii(b, s.data, 24).replace(/[^\x20-\x7e].*$/, '')))), size });
  }
  const xml = xmps.map(x => x.xml).join('\n');
  let extXml = '';
  for (const g of ext.values()) extXml += TD8.decode(concat(g.parts.sort((a, c) => a.off - c.off).map(p => p.data)));
  if (xml || extXml) xmpGroup(R, xml + (extXml ? '\n' + extXml : ''), xmps.reduce((n, x) => n + x.size, 0) + [...ext.values()].reduce((n, g) => n + g.size, 0));
  for (const j of jpegJumbf(b, segs)) c2paGroup(R, j, jumbfSize);
  otherGroup(R, others);
  trailingGroup(R, b.length - eoi);
}

async function analyzePng(b, R) {
  const { chunks, end } = parsePng(b);
  const texts = [], others = [];
  for (const c of chunks) {
    const size = c.end - c.start;
    if (c.type === 'tEXt' || c.type === 'zTXt' || c.type === 'iTXt') { const t = await pngText(b, c); if (t) texts.push(t); }
    else if (c.type === 'eXIf') exifGroup(R, b.subarray(c.data, c.dataEnd), 'EXIF', size);
    else if (c.type === 'caBX') c2paGroup(R, b.subarray(c.data, c.dataEnd), size);
    else if (c.type === 'iCCP') R.keep('profil couleur');
    else if (c.type === 'tIME') {
      const d = b.subarray(c.data, c.dataEnd);
      if (d.length >= 7) others.push({ k: 'Date de modification', v: String(d[3]).padStart(2, '0') + '/' + String(d[2]).padStart(2, '0') + '/' + u16be(d, 0), size });
    } else if (!pngKeep(c.type)) others.push({ k: 'Logiciel', v: 'données propres à un logiciel (' + c.type + ')', size });
  }
  await analyzePngTexts(R, texts);
  otherGroup(R, others);
  trailingGroup(R, b.length - end);
}

async function analyzeWebp(b, R) {
  const { chunks, riffEnd } = parseWebp(b);
  const others = [];
  for (const c of chunks) {
    const size = c.end - c.start;
    if (c.type === 'EXIF') exifGroup(R, webpExifTiff(b, c), 'EXIF', size);
    else if (c.type === 'XMP ') xmpGroup(R, TD8.decode(b.subarray(c.data, c.dataEnd)), size);
    else if (c.type === 'C2PA') c2paGroup(R, b.subarray(c.data, c.dataEnd), size);
    else if (c.type === 'ICCP') R.keep('profil couleur');
    else if (!WEBP_KEEP.has(c.type)) others.push({ k: 'Logiciel', v: 'données propres à un logiciel (' + c.type.trim() + ')', size });
  }
  otherGroup(R, others);
  trailingGroup(R, b.length - riffEnd);
}

async function analyze(input) {
  const b = toU8(input);
  const format = detectFormat(b);
  const R = newReport(b, format);
  if (!format) { R.error = 'format non pris en charge (JPG, PNG ou WebP)'; return R; }
  try {
    if (format === 'jpeg') await analyzeJpeg(b, R);
    else if (format === 'png') await analyzePng(b, R);
    else await analyzeWebp(b, R);
  } catch (e) { R.partial = true; }
  // Dernier filet : le terme IPTC de l'IA générative ailleurs dans le fichier
  if (!R.ai.generated && !R.ai.edited) {
    const s = TDL1.decode(b.length > 4e7 ? b.subarray(0, 4e7) : b);
    if (s.includes('compositeWithTrainedAlgorithmicMedia')) R.flag('edited', 'mention IPTC « complétée par IA »');
    else if (s.includes('trainedAlgorithmicMedia')) R.flag('generated', 'mention IPTC « générée par IA »');
  }
  const ai = R.ai;
  // Outil non nommé : on se rabat sur l'organisme qui a signé les Content Credentials
  if ((ai.generated || ai.edited || ai.other) && !ai.tools.length) for (const s of R.signers) { const t = toolOf(s); if (t) R.tool(t); }
  ai.found = ai.generated || ai.edited || ai.other;
  const PLAIN = {
    'Content Credentials (C2PA)': ['Signature d\'origine', 'C2PA'],
    'XMP': ['Fiche descriptive', 'XMP'],
    'EXIF': ['Infos de prise de vue', 'EXIF'],
    'EXIF (copie ImageMagick)': ['Infos de prise de vue (copie)', 'EXIF'],
    'IPTC / Photoshop': ['Légende et crédits', 'IPTC'],
    'Paramètres de génération': ['Prompt et réglages de l\'IA', ''],
    'Textes intégrés': ['Notes cachées dans le fichier', ''],
    'Autres blocs': ['Autres données techniques', ''],
    'Données après l\'image': ['Données ajoutées en fin de fichier', ''],
  };
  for (const g of R.groups) {
    if (PLAIN[g.title]) { g.tech = PLAIN[g.title][1]; g.title = PLAIN[g.title][0]; }
    if (!g.tag) g.tag = g.items.some(i => i.ia) ? 'ia' : g.items.some(i => i.perso) ? 'perso' : 'tech';
  }
  const order = { ia: 0, perso: 1, tech: 2 };
  R.groups.sort((a, c) => order[a.tag] - order[c.tag]);
  let stripped = null;
  try { stripped = strip(b).bytes; } catch (e) {}
  R.removable = stripped ? b.length - stripped.length : 0;
  R.verdict = ai.found ? 'ia' : R.removable > 0 || R.groups.length ? 'meta' : 'clean';
  delete R.group; delete R.flag; delete R.tool; delete R.perso; delete R.keep;
  return R;
}

// ── Retrait des seules traces d'IA ───────────────────────────────────────
// Retire : signature C2PA qui déclare l'IA, champs IPTC/XMP de l'IA, nom d'un
// outil d'IA (logiciel, crédit, historique), prompts et réglages de génération.
// Garde tout le reste (appareil, date, lieu, auteur…). Pixels inchangés.
const TE = new TextEncoder();
const bytesOf = str => Uint8Array.from(str, ch => ch.charCodeAt(0));
const aiDst = v => !!dstOf(v).ai;
const GEN_TEXT_KEYS = new Set(['parameters', 'prompt', 'workflow', 'invokeai_metadata', 'invokeai_graph', 'sd-metadata', 'dream', 'fooocus_scheme']);

function xmpStripAI(xml) {
  let out = xml;
  const rm = (local, pred) => {
    out = out.replace(new RegExp('\\s[\\w.-]+:' + local + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\')', 'g'),
      (m, a, b) => (pred(xmlUnesc(a !== undefined ? a : b)) ? '' : m));
    out = out.replace(new RegExp('<([\\w.-]+:' + local + ')(\\s[^>]*?)?(?:/>|>([\\s\\S]*?)</\\1\\s*>)', 'g'), (m, q, attrs, inner) => {
      const res = /rdf:resource\s*=\s*"([^"]*)"/.exec(attrs || '');
      return pred(res ? xmlUnesc(res[1]) : stripTags(inner || '')) ? '' : m;
    });
  };
  rm('DigitalSourceType', aiDst);
  for (const k of ['AISystemUsed', 'AISystemVersionUsed', 'AIPromptInformation', 'AIPromptWriterName']) rm(k, () => true);
  for (const k of ['CreatorTool', 'softwareAgent', 'Credit']) rm(k, v => !!toolOf(v));
  rm('description', v => MJ_JOB.test(v) || isGenParams(v));
  rm('UserComment', v => isGenParams(v) || !!toolOf(v));
  return { xml: out, changed: out !== xml };
}
// EXIF : on efface la valeur sur place (mêmes positions, rien d'autre ne bouge)
function tiffStripAI(tiff) {
  const t = parseTiff(tiff);
  if (!t) return false;
  let changed = false;
  const wipe = tag => { tiff.fill(0, tag.off, tag.off + tag.size); changed = true; };
  const sw = t.ifd0[0x0131];
  if (sw && toolOf(t.val(sw))) wipe(sw);
  const de = t.ifd0[0x010E];
  if (de) { const s = t.val(de); if (typeof s === 'string' && (MJ_JOB.test(s) || isGenParams(s))) wipe(de); }
  const uc = t.exif[0x9286];
  if (uc) { const s = userComment(t.val(uc)); if (isGenParams(s) || MJ_JOB.test(s) || toolOf(s)) wipe(uc); }
  return changed;
}
function iimStripAI(d) {
  let p = 0, changed = false;
  while (p + 5 <= d.length && d[p] === 0x1C) {
    let n = u16be(d, p + 3), h = 5;
    if (n & 0x8000) { const nb = n & 0x7FFF; n = 0; for (let i = 0; i < nb; i++) n = n * 256 + d[p + 5 + i]; h = 5 + nb; }
    if (d[p + 1] === 2 && d[p + 2] === 65 && toolOf(decodeText(d.subarray(p + h, p + h + n)))) { d.fill(0x20, p + h, p + h + n); changed = true; }
    p += h + n;
  }
  return changed;
}
function jumbfIsAI(j) {
  try {
    const top = boxes(j, 0, j.length).find(x => x.type === 'jumb');
    const store = top && superbox(j, top, 0);
    if (!store) return false;
    return store.children.map(readManifest).some(m => m.dst.some(aiDst) || toolOf(m.generator) || m.agents.some(a => toolOf(a)));
  } catch (e) { return false; }
}
function riffBody(chunks) {
  const body = concat(chunks), head = new Uint8Array(12);
  head.set([0x52, 0x49, 0x46, 0x46]);
  new DataView(head.buffer).setUint32(4, body.length + 4, true);
  head.set([0x57, 0x45, 0x42, 0x50], 8);
  return concat([head, body]);
}

function stripAIJpeg(b) {
  const c = b.slice();
  const { segs, eoi } = parseJpeg(c);
  const dropC2pa = jpegJumbf(c, segs).some(jumbfIsAI);
  const dropExt = segs.some(s => jpegKind(c, s) === 'xmpext' && xmpStripAI(TD8.decode(c.subarray(s.data + XMPEXT_ID.length + 40, s.end))).changed);
  const out = [c.subarray(0, 2)];
  for (const s of segs) {
    const k = jpegKind(c, s);
    if ((k === 'jumbf' && dropC2pa) || (k === 'xmpext' && dropExt)) continue;
    if (k === 'exif') tiffStripAI(c.subarray(s.data + 6, s.end));
    if (k === 'photoshop') { const r = photoshopResources(c, s.data + 14, s.end).find(x => x.id === 0x0404); if (r) iimStripAI(r.data); }
    if (k === 'com') { const t = decodeText(c.subarray(s.data, s.end)); if (toolOf(t) || isGenParams(t) || MJ_JOB.test(t)) continue; }
    if (k === 'xmp') {
      const r = xmpStripAI(TD8.decode(c.subarray(s.data + XMP_ID.length, s.end)));
      if (r.changed) {
        const payload = concat([bytesOf(XMP_ID), TE.encode(r.xml)]);
        if (payload.length > 65533) continue;
        const seg = new Uint8Array(4 + payload.length);
        seg.set([0xFF, 0xE1, (payload.length + 2) >> 8, (payload.length + 2) & 0xFF]); seg.set(payload, 4);
        out.push(seg); continue;
      }
    }
    out.push(c.subarray(s.start, s.end));
  }
  if (eoi < c.length) out.push(c.subarray(eoi));
  return concat(out);
}

async function stripAIPng(b) {
  const c = b.slice();
  const { chunks, end } = parsePng(c);
  const texts = new Map();
  for (const ch of chunks) if (/^(tEXt|zTXt|iTXt)$/.test(ch.type)) texts.set(ch, await pngText(c, ch));
  const novel = [...texts.values()].some(t => t && t.key.toLowerCase() === 'software' && /novel\s?ai/i.test(t.text));
  const out = [c.subarray(0, 8)];
  for (const ch of chunks) {
    const t = texts.get(ch);
    if (t) {
      const k = t.key.toLowerCase();
      if (GEN_TEXT_KEYS.has(k)) continue;
      if (novel && ['software', 'comment', 'description', 'source', 'title', 'generation time'].includes(k)) continue;
      if (/^(software|source|exif:software)$/.test(k) && toolOf(t.text)) continue;
      if (/^(description|comment|exif:imagedescription|exif:usercomment)$/.test(k) && (MJ_JOB.test(t.text) || isGenParams(t.text))) continue;
      if (k === 'xml:com.adobe.xmp') {
        const r = xmpStripAI(t.text);
        if (r.changed) { out.push(pngChunk('iTXt', concat([bytesOf('XML:com.adobe.xmp\0\0\0\0\0'), TE.encode(r.xml)]))); continue; }
      }
      if (k === 'raw profile type exif' || k === 'raw profile type app1') {
        const by = hexProfile(t.text);
        if (by && tiffStripAI(startsWith(by, 0, 'Exif\0') ? by.subarray(6) : by)) continue;
      }
      if (k === 'raw profile type xmp') { const by = hexProfile(t.text); if (by && xmpStripAI(TD8.decode(by)).changed) continue; }
    } else if (ch.type === 'caBX') {
      if (jumbfIsAI(c.subarray(ch.data, ch.dataEnd))) continue;
    } else if (ch.type === 'eXIf') {
      const d = c.subarray(ch.data, ch.dataEnd);
      if (tiffStripAI(d)) { out.push(pngChunk('eXIf', d)); continue; }
    }
    out.push(c.subarray(ch.start, ch.end));
  }
  if (end < c.length) out.push(c.subarray(end));
  return concat(out);
}

function stripAIWebp(b) {
  const c = b.slice();
  const { chunks, riffEnd } = parseWebp(c);
  const out = [];
  for (const ch of chunks) {
    if (ch.type === 'C2PA' && jumbfIsAI(c.subarray(ch.data, ch.dataEnd))) continue;
    if (ch.type === 'EXIF') tiffStripAI(webpExifTiff(c, ch));
    if (ch.type === 'XMP ') {
      const r = xmpStripAI(TD8.decode(c.subarray(ch.data, ch.dataEnd)));
      if (r.changed) {
        const x = TE.encode(r.xml), chunk = new Uint8Array(8 + x.length + (x.length & 1));
        chunk.set(bytesOf('XMP ')); new DataView(chunk.buffer).setUint32(4, x.length, true); chunk.set(x, 8);
        out.push(chunk); continue;
      }
    }
    out.push(c.subarray(ch.start, ch.end));
  }
  const res = riffBody(out);
  return riffEnd < c.length ? concat([res, c.subarray(riffEnd)]) : res;
}

async function stripAI(input) {
  const b = toU8(input);
  const format = detectFormat(b);
  if (!format) throw new Error('format non pris en charge (JPG, PNG ou WebP)');
  const bytes = format === 'jpeg' ? stripAIJpeg(b) : format === 'png' ? await stripAIPng(b) : stripAIWebp(b);
  let same = bytes.length === b.length;
  for (let i = 0; same && i < b.length; i++) if (bytes[i] !== b[i]) same = false;
  return { bytes, removed: b.length - bytes.length, format, changed: !same };
}

const API = { analyze, strip, stripAI, detectFormat, mime: f => FORMAT_MIME[f] || '', version: '1.1' };
if (typeof module !== 'undefined' && module.exports) module.exports = API;
else root.PixoMeta = API;
})(typeof self !== 'undefined' ? self : this);
