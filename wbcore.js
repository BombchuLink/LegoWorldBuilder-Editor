/* WorldBuilder core: Shockwave (.dcr) container, cast members, bitmaps and level text.
 * Works in browsers (classic <script>) and in Node (require). No dependencies. */
(function (root) {
  "use strict";
  const WB = {};

  // ---------------------------------------------------------------- bytes

  const latin1 = (u8) => {
    let s = "";
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return s;
  };
  const fromLatin1 = (s) => {
    const u8 = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      u8[i] = c < 256 ? c : 63;
    }
    return u8;
  };
  WB.latin1 = latin1;
  WB.fromLatin1 = fromLatin1;

  class Reader {
    constructor(u8, pos = 0) {
      this.u8 = u8;
      this.pos = pos;
      this.dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    }
    byte() { return this.u8[this.pos++]; }
    u32le() { const v = this.dv.getUint32(this.pos, true); this.pos += 4; return v; }
    // XFIR stores fourCCs byte-reversed
    tag() { const t = latin1(this.u8.subarray(this.pos, this.pos + 4)).split("").reverse().join(""); this.pos += 4; return t; }
    varint() {
      let v = 0;
      for (;;) {
        const b = this.byte();
        v = v * 128 + (b & 0x7f);
        if (!(b & 0x80)) return v;
      }
    }
    bytes(n) { const v = this.u8.subarray(this.pos, this.pos + n); this.pos += n; return v; }
  }

  class Writer {
    constructor() { this.parts = []; this.length = 0; }
    push(u8) { this.parts.push(u8); this.length += u8.length; }
    tag(t) { this.push(fromLatin1(t.split("").reverse().join(""))); }
    varint(v) { this.push(encVarint(v)); }
    u32le(v) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v, true); this.push(b); }
    concat() {
      const out = new Uint8Array(this.length);
      let p = 0;
      for (const part of this.parts) { out.set(part, p); p += part.length; }
      return out;
    }
  }

  function encVarint(v) {
    const groups = [v % 128];
    v = Math.floor(v / 128);
    while (v > 0) { groups.unshift((v % 128) | 0x80); v = Math.floor(v / 128); }
    return Uint8Array.from(groups);
  }

  async function streamThrough(u8, stream) {
    const out = new Response(new Blob([u8]).stream().pipeThrough(stream));
    return new Uint8Array(await out.arrayBuffer());
  }
  const inflate = (u8) => streamThrough(u8, new DecompressionStream("deflate"));
  const deflate = (u8) => streamThrough(u8, new CompressionStream("deflate"));
  WB.inflate = inflate;
  WB.deflate = deflate;

  // ---------------------------------------------------------------- Afterburner container

  /* Parse an Afterburner movie. Resource payloads stay compressed until requested. */
  async function openMovie(buffer) {
    let u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    // Launcher.exe is a projector stub with the .dcr appended verbatim, then a small trailer
    let wrapper = null;
    if (u8[0] === 0x4d && u8[1] === 0x5a) {
      const off = findEmbeddedMovie(u8);
      if (off < 0) throw new Error("This program doesn't contain a Shockwave movie.");
      const len = new DataView(u8.buffer, u8.byteOffset).getUint32(off + 4, true) + 8;
      wrapper = { stub: u8.slice(0, off), trailer: u8.slice(off + len) };
      u8 = u8.slice(off, off + len);
    }
    const r = new Reader(u8);
    if (r.tag() !== "RIFX") throw new Error("Not a Shockwave movie (missing XFIR header)");
    r.u32le();
    if (r.tag() !== "FGDM") throw new Error("Not an Afterburner-compressed movie");

    const chunkStart = r.pos;
    if (r.tag() !== "Fver") throw new Error("Unexpected layout: Fver");
    { const n = r.varint(); r.pos += n; }
    if (r.tag() !== "Fcdr") throw new Error("Unexpected layout: Fcdr");
    { const n = r.varint(); r.pos += n; }
    const preamble = u8.slice(chunkStart, r.pos); // Fver + Fcdr, copied verbatim on save

    if (r.tag() !== "ABMP") throw new Error("Unexpected layout: ABMP");
    const abmpLen = r.varint();
    const abmpEnd = r.pos + abmpLen;
    r.varint();
    r.varint();
    const abmp = new Reader(await inflate(u8.subarray(r.pos, abmpEnd)));
    r.pos = abmpEnd;
    const abmpUnk1 = abmp.varint();
    const abmpUnk2 = abmp.varint();
    const count = abmp.varint();
    const entries = [];
    for (let i = 0; i < count; i++) {
      const e = { id: abmp.varint(), off: abmp.varint(), csize: abmp.varint(), usize: abmp.varint(), ctype: abmp.varint(), tag: abmp.tag() };
      if (e.off >= 0xffffffff) e.off = -1;
      entries.push(e);
    }

    if (r.tag() !== "FGEI") throw new Error("Unexpected layout: FGEI");
    r.varint();
    const body = r.pos;

    const byId = new Map(entries.map((e) => [e.id, e]));
    const ilsEntry = byId.get(2);
    const ilsCompressed = u8.slice(body + ilsEntry.off, body + ilsEntry.off + ilsEntry.csize);
    const ils = await inflate(ilsCompressed);
    const ilsOrder = [];
    const ir = new Reader(ils);
    while (ir.pos < ils.length) {
      const id = ir.varint();
      const e = byId.get(id);
      e.ilsData = ils.slice(ir.pos, ir.pos + e.csize);
      ir.pos += e.csize;
      ilsOrder.push(id);
    }

    const movie = new Movie(u8, preamble, abmpUnk1, abmpUnk2, entries, body, ilsOrder, ilsCompressed);
    movie.wrapper = wrapper;
    await movie._index();
    return movie;
  }
  WB.openMovie = openMovie;

  /* Offset of the last Afterburner movie ("XFIR" .... "MDGF") that fits inside the file. */
  function findEmbeddedMovie(u8) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let found = -1;
    for (let i = 0; i + 12 <= u8.length; i++) {
      if (u8[i] === 0x58 && u8[i + 1] === 0x46 && u8[i + 2] === 0x49 && u8[i + 3] === 0x52 &&
          u8[i + 8] === 0x4d && u8[i + 9] === 0x44 && u8[i + 10] === 0x47 && u8[i + 11] === 0x46 &&
          i + 8 + dv.getUint32(i + 4, true) <= u8.length) found = i;
    }
    return found;
  }

  /* Put a rebuilt movie back into a projector: same stub and trailer, so the movie keeps its offset. */
  WB.wrapProjector = function (wrapper, dcr) {
    const out = new Uint8Array(wrapper.stub.length + dcr.length + wrapper.trailer.length);
    out.set(wrapper.stub, 0);
    out.set(dcr, wrapper.stub.length);
    out.set(wrapper.trailer, wrapper.stub.length + dcr.length);
    return out;
  };

  /* Read just the projector wrapper from a Launcher.exe (to patch it with a movie opened from a .dcr). */
  WB.readProjector = function (buffer) {
    const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    if (u8[0] !== 0x4d || u8[1] !== 0x5a) throw new Error("That isn't a Windows program (.exe).");
    const off = findEmbeddedMovie(u8);
    if (off < 0) throw new Error("This program doesn't contain a Shockwave movie.");
    const len = new DataView(u8.buffer, u8.byteOffset).getUint32(off + 4, true) + 8;
    return { stub: u8.slice(0, off), trailer: u8.slice(off + len) };
  };

  class Movie {
    constructor(u8, preamble, abmpUnk1, abmpUnk2, entries, body, ilsOrder, ilsCompressed) {
      Object.assign(this, { u8, preamble, abmpUnk1, abmpUnk2, entries, body, ilsOrder, ilsCompressed });
      this.byId = new Map(entries.map((e) => [e.id, e]));
      this.cache = new Map();
      this.modified = new Map();
    }

    async data(id) {
      if (this.modified.has(id)) return this.modified.get(id);
      if (this.cache.has(id)) return this.cache.get(id);
      const e = this.byId.get(id);
      if (!e) return null;
      let d;
      if (e.ilsData) d = e.ilsData;
      else if (e.off < 0) return null;
      else {
        const raw = this.u8.subarray(this.body + e.off, this.body + e.off + e.csize);
        d = e.csize !== e.usize && e.ctype === 0 ? await inflate(raw) : raw;
      }
      this.cache.set(id, d);
      return d;
    }

    setData(id, u8) { this.modified.set(id, u8); }

    async _index() {
      const key = await this.data(this.entries.find((e) => e.tag === "KEY*").id);
      const kv = new DataView(key.buffer, key.byteOffset, key.byteLength);
      const used = kv.getUint32(8, true);
      this.children = new Map();
      for (let i = 0; i < used; i++) {
        const o = 12 + 12 * i;
        const sid = kv.getUint32(o, true), parent = kv.getUint32(o + 4, true);
        const tag = latin1(key.subarray(o + 8, o + 12)).split("").reverse().join("");
        if (!this.children.has(parent)) this.children.set(parent, {});
        this.children.get(parent)[tag] = sid;
      }
      this.members = [];
      for (const e of this.entries) {
        if (e.tag !== "CASt") continue;
        const m = parseCast(await this.data(e.id));
        m.id = e.id;
        this.members.push(m);
      }
      this.byName = new Map();
      for (const m of this.members) if (m.name && !this.byName.has(m.name)) this.byName.set(m.name, m);
      this.castLibs = [];
      for (const e of this.entries) {
        if (e.tag !== "CAS*") continue;
        const d = await this.data(e.id);
        const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
        const ids = [];
        for (let i = 0; i + 4 <= d.length; i += 4) ids.push(dv.getUint32(i));
        this.castLibs.push(ids);
      }
    }

    child(memberId, tag) {
      const c = this.children.get(memberId);
      return c && c[tag] != null && this.byId.has(c[tag]) ? c[tag] : null;
    }

    async text(name) {
      const m = this.byName.get(name);
      if (!m) return null;
      const x = this.child(m.id, "XMED");
      if (x != null) return xmedGetText(await this.data(x));
      const s = this.child(m.id, "STXT");
      if (s != null) return stxtGetText(await this.data(s));
      return null;
    }

    async setText(name, text) {
      const m = this.byName.get(name);
      const x = m && this.child(m.id, "XMED");
      if (x == null) throw new Error(`No editable text member named "${name}"`);
      this.setData(x, xmedSetText(await this.data(x), text));
    }

    textMembers() {
      return this.members.filter((m) => m.name && this.child(m.id, "XMED") != null).map((m) => m.name);
    }

    /* Rebuild the whole Afterburner file, reusing original compressed bytes for untouched resources. */
    async save() {
      const ilsTouched = this.ilsOrder.some((id) => this.modified.has(id));
      let ilsCompressed = this.ilsCompressed, ilsUsize = this.byId.get(2).usize;
      const sizes = new Map();
      if (ilsTouched) {
        const w = new Writer();
        for (const id of this.ilsOrder) {
          const d = this.modified.get(id) || this.byId.get(id).ilsData;
          w.varint(id);
          w.push(d);
          sizes.set(id, d.length);
        }
        const ils = w.concat();
        ilsUsize = ils.length;
        ilsCompressed = await deflate(ils);
      }

      const external = this.entries.filter((e) => e.id !== 2 && !e.ilsData && e.off >= 0).sort((a, b) => a.off - b.off);
      const blobs = [];
      const placed = new Map();
      let off = ilsCompressed.length;
      for (const e of external) {
        let raw, usize = e.usize;
        if (this.modified.has(e.id)) {
          const d = this.modified.get(e.id);
          raw = await deflate(d);
          usize = d.length;
        } else {
          raw = this.u8.subarray(this.body + e.off, this.body + e.off + e.csize);
        }
        placed.set(e.id, { off, csize: raw.length, usize });
        blobs.push(raw);
        off += raw.length;
      }

      const aw = new Writer();
      aw.varint(this.abmpUnk1);
      aw.varint(this.abmpUnk2);
      aw.varint(this.entries.length);
      for (const e of this.entries) {
        let o = e.off, cs = e.csize, us = e.usize;
        if (e.id === 2) { o = 0; cs = ilsCompressed.length; us = ilsUsize; }
        else if (e.ilsData) { o = 0xffffffff; cs = us = sizes.get(e.id) ?? e.csize; }
        else if (placed.has(e.id)) ({ off: o, csize: cs, usize: us } = placed.get(e.id));
        else if (o < 0) o = 0xffffffff;
        aw.varint(e.id);
        aw.varint(o);
        aw.varint(cs);
        aw.varint(us);
        aw.varint(e.ctype);
        aw.tag(e.tag);
      }
      const abmpRaw = aw.concat();
      const abmpZ = await deflate(abmpRaw);

      const w = new Writer();
      w.tag("RIFX");
      w.u32le(0);
      w.tag("FGDM");
      w.push(this.preamble);
      const abmpBody = new Writer();
      abmpBody.varint(0);
      abmpBody.varint(abmpRaw.length);
      abmpBody.push(abmpZ);
      w.tag("ABMP");
      w.varint(abmpBody.length);
      w.push(abmpBody.concat());
      w.tag("FGEI");
      w.varint(0);
      w.push(ilsCompressed);
      for (const b of blobs) w.push(b);
      const out = w.concat();
      new DataView(out.buffer).setUint32(4, out.length - 8, true);
      return out;
    }
  }

  // ---------------------------------------------------------------- cast members

  const be32 = (u8, o) => ((u8[o] << 24) | (u8[o + 1] << 16) | (u8[o + 2] << 8) | u8[o + 3]) >>> 0;
  const be16 = (u8, o) => (u8[o] << 8) | u8[o + 1];
  const bes16 = (u8, o) => (be16(u8, o) << 16) >> 16;

  function parseCast(d) {
    const type = be32(d, 0), infoLen = be32(d, 4), specLen = be32(d, 8);
    const info = d.subarray(12, 12 + infoLen);
    const spec = d.subarray(12 + infoLen, 12 + infoLen + specLen);
    let name = null;
    if (info.length >= 22) {
      const dataOff = be32(info, 0);
      const n = be16(info, dataOff);
      if (n >= 2) {
        const offs = [];
        for (let i = 0; i < n; i++) offs.push(be32(info, dataOff + 2 + 4 * i));
        const base = dataOff + 2 + 4 * n + 4;
        const item = info.subarray(base + offs[1], base + (n > 2 ? offs[2] : info.length - base));
        if (item.length) name = latin1(item.subarray(1, 1 + item[0]));
      }
    }
    return { type, name, spec };
  }

  // ---------------------------------------------------------------- text members (XMED)

  /* A long text is stored in several "0002" sections, each "\x00" + length(hex) + "," + text, whose
   * count field is where that piece starts in the whole text (config: pieces at 0, 4211 and 8250). */
  function xmedPieces(secs) {
    return secs
      .filter((x) => x.id === "0002")
      .map((x) => {
        const m = /^\x00([0-9A-F]+),/.exec(x.data);
        return { sec: x, start: parseInt(x.count, 16), head: m[0].length, len: parseInt(m[1], 16) };
      })
      .sort((a, b) => a.start - b.start);
  }

  function xmedGetText(d) {
    const s = latin1(d);
    if (s.search(/\x030002[0-9A-F]{16}\x00/) < 0) return null;
    return xmedPieces(xmedSections(s).secs)
      .map((p) => p.sec.data.substr(p.head, p.len))
      .join("")
      .replace(/\r/g, "\n");
  }

  function stxtGetText(d) {
    const off = be32(d, 0), len = be32(d, 4);
    return latin1(d.subarray(off, off + len)).replace(/\r/g, "\n");
  }

  /* XMED layout: header, then sections "\x03" + id(4 hex) + size(8 hex) + count(8 hex) + data,
   * where size counts the data plus the "\x03" that follows it. The text's length and the
   * boundaries between its pieces are mirrored in a few sections (paragraph/style run tables),
   * which are patched along with the text itself; the game ignores the rest of their layout data. */
  function xmedSections(s) {
    const first = s.search(/\x03[0-9A-F]{20}/);
    const head = s.slice(0, first);
    const secs = [];
    let p = first;
    while (p < s.length && s[p] === "\x03" && /^[0-9A-F]{20}$/.test(s.substr(p + 1, 20))) {
      const id = s.substr(p + 1, 4), size = parseInt(s.substr(p + 5, 8), 16), count = s.substr(p + 13, 8);
      const data = s.substr(p + 21, size - 1);
      // the last section can claim more bytes than the member has left; keep its size as it was
      secs.push({ id, count, data, short: size - 1 - data.length });
      p += 21 + size - 1;
    }
    return { head, secs, tail: s.slice(p) };
  }

  function xmedSetText(d, text) {
    const s = latin1(d);
    const { head, secs, tail } = xmedSections(s);
    const pieces = xmedPieces(secs);
    const old = pieces.map((p) => p.sec.data.substr(p.head, p.len)).join("");
    const body = text.replace(/\r\n?|\n/g, "\r");
    const oldLen = old.length, newLen = body.length, delta = newLen - oldLen;
    // Keep the pieces: boundaries before the change stay, the ones after it move with the text.
    // (One piece, as in every level, simply gets the whole text.)
    let pre = 0;
    while (pre < oldLen && pre < newLen && old[pre] === body[pre]) pre++;
    let suf = 0;
    while (suf < oldLen - pre && suf < newLen - pre && old[oldLen - 1 - suf] === body[newLen - 1 - suf]) suf++;
    const moved = (b) => (b <= pre ? b : b >= oldLen - suf ? b + delta : pre);
    const bounds = [...pieces.map((p) => p.start), oldLen];
    const nb = bounds.map((b, i) => (i === 0 ? 0 : i === bounds.length - 1 ? newLen : moved(b)));
    const hex = (n) => n.toString(16).toUpperCase();
    pieces.forEach((p, i) => {
      const part = body.slice(nb[i], nb[i + 1]);
      p.sec.data = "\x00" + hex(part.length) + "," + part + p.sec.data.slice(p.head + p.len);
      p.sec.count = hex(nb[i]).padStart(8, "0");
    });
    const remap = (data, map) =>
      data.replace(/([\x01\x02])([0-9A-F]+)/g, (all, mark, h) => (map.has(parseInt(h, 16)) ? mark + hex(map.get(parseInt(h, 16))) : all));
    const boundsMap = new Map(bounds.slice(1).map((b, i) => [b, nb[i + 1]]).filter(([a, b]) => a !== b));
    const totalMap = new Map([[oldLen + 2, newLen + 2]]);
    for (const x of secs) {
      if (x.id === "0001") x.data = remap(x.data, boundsMap);
      if (["0004", "0005", "0128", "0129"].includes(x.id)) x.data = remap(x.data, totalMap);
    }
    const hex8 = (n) => n.toString(16).toUpperCase().padStart(8, "0");
    let out = head;
    for (const x of secs) out += "\x03" + x.id + hex8(x.data.length + 1 + x.short) + x.count + x.data;
    return fromLatin1(out + tail);
  }
  WB.xmedGetText = xmedGetText;
  WB.xmedSetText = xmedSetText;

  // ---------------------------------------------------------------- bitmaps

  function packbits(d, expect) {
    const out = new Uint8Array(expect);
    let i = 0, o = 0;
    while (i < d.length && o < expect) {
      const n = d[i++];
      if (n < 0x80) {
        const c = Math.min(n + 1, expect - o);
        out.set(d.subarray(i, i + c), o);
        o += c;
        i += n + 1;
      } else {
        const c = Math.min(257 - n, expect - o);
        out.fill(d[i++], o, o + c);
        o += c;
      }
    }
    return out;
  }

  function systemPalette() {
    const pal = [];
    for (let r = 0; r < 6; r++) for (let g = 0; g < 6; g++) for (let b = 0; b < 6; b++) pal.push([255 - r * 51, 255 - g * 51, 255 - b * 51]);
    pal.length = 215;
    const ramp = [238, 221, 187, 170, 136, 119, 85, 68, 34, 17];
    for (let ch = 0; ch < 3; ch++) for (const v of ramp) { const c = [0, 0, 0]; c[ch] = v; pal.push(c); }
    for (const v of ramp) pal.push([v, v, v]);
    pal.push([0, 0, 0]);
    return pal;
  }

  // 2- and 4-bit bitmaps without their own palette: white to black
  function greyPalette(depth) {
    const n = 1 << depth;
    return Array.from({ length: n }, (_, i) => { const v = Math.round(255 - (i * 255) / (n - 1)); return [v, v, v]; });
  }

  /* Decode a bitmap member to {w, h, rgba, regX, regY}. Pure white is made transparent, matching
   * the "background transparent" ink the game uses for map sprites. */
  Movie.prototype.bitmap = async function (name) {
    const m = this.byName.get(name);
    if (!m || m.type !== 1) return null;
    const spec = m.spec;
    const pitch = be16(spec, 0) & 0x7fff;
    const top = bes16(spec, 2), left = bes16(spec, 4), bottom = bes16(spec, 6), right = bes16(spec, 8);
    const w = right - left, h = bottom - top;
    const regY = bes16(spec, 18), regX = bes16(spec, 20);
    const depth = spec.length > 23 ? spec[23] : 1;
    const clutMember = spec.length >= 28 ? bes16(spec, 26) : -1;
    const bid = this.child(m.id, "BITD");
    if (w <= 0 || h <= 0 || bid == null) return null;
    const bitd = await this.data(bid);
    const raw = bitd.length === pitch * h ? bitd : packbits(bitd, pitch * h);
    const rgba = new Uint8ClampedArray(w * h * 4);
    let pal = null;
    if (depth === 8 || depth === 4 || depth === 2) {
      pal = depth === 8 ? systemPalette() : greyPalette(depth);
      if (clutMember > 0) {
        // the palette member lives in the bitmap's own cast unless it can't be found there
        const own = this.castLibs.find((l) => l.includes(m.id));
        for (const lib of own ? [own, ...this.castLibs.filter((l) => l !== own)] : this.castLibs) {
          const cid = lib[clutMember - 1];
          const clut = cid ? this.child(cid, "CLUT") : null;
          if (clut != null) {
            const d = await this.data(clut);
            pal = [];
            for (let i = 0; i + 6 <= d.length; i += 6) pal.push([d[i], d[i + 2], d[i + 4]]);
            break;
          }
        }
      }
    }
    const alfaId = this.child(m.id, "ALFA");
    let alpha = null;
    if (alfaId != null && depth === 32) {
      const a = await this.data(alfaId);
      alpha = a.length === w * h ? a : packbits(a, w * h);
    }
    for (let y = 0; y < h; y++) {
      const row = y * pitch;
      for (let x = 0; x < w; x++) {
        let r, g, b, a = 255;
        if (depth === 32) {
          r = raw[row + w + x]; g = raw[row + 2 * w + x]; b = raw[row + 3 * w + x];
          if (alpha) a = alpha[y * w + x];
        } else if (depth === 8) {
          [r, g, b] = pal[raw[row + x]] || [0, 0, 0];
        } else if (depth === 4) {
          [r, g, b] = pal[(raw[row + (x >> 1)] >> (x & 1 ? 0 : 4)) & 15] || [0, 0, 0];
        } else if (depth === 2) {
          [r, g, b] = pal[(raw[row + (x >> 2)] >> (6 - 2 * (x & 3))) & 3] || [0, 0, 0];
        } else if (depth === 16) {
          // rows are planar like 32-bit: all high bytes, then all low bytes (x1r5g5b5)
          const v = (raw[row + x] << 8) | raw[row + w + x];
          r = Math.round(((v >> 10) & 31) * 255 / 31); g = Math.round(((v >> 5) & 31) * 255 / 31); b = Math.round((v & 31) * 255 / 31);
        } else {
          const bit = (raw[row + (x >> 3)] >> (7 - (x & 7))) & 1;
          r = g = b = bit ? 0 : 255;
        }
        if (r === 255 && g === 255 && b === 255) a = 0;
        const o = (y * w + x) * 4;
        rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = a;
      }
    }
    return { w, h, rgba, regX, regY };
  };

  // ---------------------------------------------------------------- first-mission tutorial

  /* World Builder 1's world-map flag script does, after loading a mission:
   *   if world = 1 and mission = 1 then tutorial_manager.setTutorialMode(1) ...
   * In bytecode: getprop world, pushint8 1, eq, getprop mission, pushint8 <1>, eq, and, jmpifz.
   * Changing that second constant to 0 makes the check never match, so mission 1 plays as a
   * normal level. Returns {id, pos, enabled} or null if the game has no such hook (World Builder 2). */
  Movie.prototype.findTutorialHook = async function () {
    const hits = [];
    for (const e of this.entries) {
      if (e.tag !== "Lscr") continue;
      const d = await this.data(e.id);
      for (let i = 0; i + 16 <= d.length; i++) {
        if (d[i] === 0x8a && d[i + 3] === 0x81 && d[i + 4] === 0 && d[i + 5] === 1 && d[i + 6] === 0x0f &&
            d[i + 7] === 0x8a && d[i + 10] === 0x81 && d[i + 11] === 0 && (d[i + 12] === 1 || d[i + 12] === 0) &&
            d[i + 13] === 0x0f && d[i + 14] === 0x12 && d[i + 15] === 0x95) {
          hits.push({ id: e.id, pos: i + 12, enabled: d[i + 12] === 1 });
        }
      }
    }
    // only patch when the match is unambiguous
    return hits.length === 1 ? hits[0] : null;
  };

  Movie.prototype.setTutorialHook = async function (hook, enabled) {
    const d = (await this.data(hook.id)).slice();
    d[hook.pos] = enabled ? 1 : 0;
    this.setData(hook.id, d);
    hook.enabled = enabled;
  };

  // ---------------------------------------------------------------- keyboard controls

  /* Both games' movie script has (Mac key codes):
   *   on keyDown
   *     ...
   *     case the keyCode of
   *       126, 125, 123, 124: map_display.scrollmapManual(...)   -- arrow keys
   *       49: glob.highlighted_object.actionButton()            -- space
   *     end case
   * The WASD patch changes the arrows to W/S/A/D and adds
   *       12: if not voidp(glob.highlighted_object) and not glob.highlighted_object.buildIconP() then
   *             glob.highlighted_object.menuclick("disassemble")
   * which is what the info panel's take-apart button does (it's shown for anything selected
   * that isn't a plan). The rebuilt handler is appended to its script chunk and the handler
   * record repointed, so nothing else in the chunk moves. */
  const ARROWS = [126, 125, 123, 124], WASD = [13, 1, 0, 2], KEY_Q = 12;
  const opLen = (op) => (op < 0x40 ? 1 : op < 0x80 ? 2 : op < 0xc0 ? 3 : 5);

  function readNames(d) {
    const off = be16(d, 16), cnt = be16(d, 18);
    const names = [];
    for (let i = 0, p = off; i < cnt; i++) { names.push(latin1(d.subarray(p + 1, p + 1 + d[p]))); p += 1 + d[p]; }
    return names;
  }

  // positions of the "peek 0, pushint8 <key>, eq, jmpifz" tests in a keyDown handler
  function keyTests(code) {
    const at = new Map();
    for (let i = 0; i + 7 <= code.length; i++) {
      if (code[i] === 0x64 && code[i + 1] === 0 && code[i + 2] === 0x81 && code[i + 3] === 0 && code[i + 5] === 0x0f && code[i + 6] === 0x95) {
        at.set(code[i + 4], i + 4);
      }
    }
    return at;
  }

  /* Every handler of every script: {id (Lscr), rec (offset of its 42-byte record), name, names, code}. */
  Movie.prototype.handlers = async function* () {
    for (const e of this.entries) {
      if (e.tag !== "Lctx") continue;
      const ctx = await this.data(e.id);
      const lnam = await this.data(be32(ctx, 32));
      if (!lnam) continue;
      const names = readNames(lnam);
      const count = be32(ctx, 8), eoff = be16(ctx, 16);
      for (let i = 0; i < count; i++) {
        const sid = be32(ctx, eoff + 12 * i + 4);
        if (!this.byId.has(sid) || this.byId.get(sid).tag !== "Lscr") continue;
        const d = await this.data(sid);
        const hcount = be16(d, 72), hoff = be32(d, 74);
        for (let h = 0; h < hcount; h++) {
          const rec = hoff + 42 * h, off = be32(d, rec + 8);
          yield { id: sid, rec, names, name: names[be16(d, rec)], code: d.subarray(off, off + be32(d, rec + 4)) };
        }
      }
    }
  };

  /* Give a handler new bytecode: it's appended to the script chunk and the handler record
   * repointed, so nothing else in the chunk moves (the old bytes stay behind, unused).
   * The chunk has to stay an even length, or Director stops with a script error while loading. */
  Movie.prototype.replaceHandlerCode = async function (id, rec, code) {
    const d = await this.data(id);
    const at = d.length + (d.length & 1);
    const out = new Uint8Array(at + code.length + (code.length & 1));
    out.set(d);
    out.set(code, at);
    const dv = new DataView(out.buffer);
    dv.setUint32(8, out.length);
    dv.setUint32(12, out.length);
    dv.setUint32(rec + 4, code.length);
    dv.setUint32(rec + 8, at);
    this.setData(id, out);
  };

  const nameRef = (names) => (n) => {
    const i = names.indexOf(n);
    if (i < 0) throw new Error(`The game has no "${n}" name`);
    return [i >> 8, i & 0xff];
  };

  /* Returns [{id, rec, names, wasd}] for every keyDown handler of the expected shape. */
  Movie.prototype.findKeyHandlers = async function () {
    const found = [];
    for await (const h of this.handlers()) {
      if (h.name !== "keyDown") continue;
      const tests = keyTests(h.code);
      const has = (keys) => keys.every((k) => tests.has(k));
      const esc = menuCase(h.code, h.names), menu = !!(esc && esc.sound);
      if (has([...WASD, KEY_Q, 49])) found.push({ ...h, wasd: true, menu });
      else if (has([...ARROWS, 49]) && h.code.length >= 3 && h.code[h.code.length - 3] === 0x65) found.push({ ...h, wasd: false, menu });
    }
    return found;
  };

  Movie.prototype.setWasdControls = async function (handler) {
    if (handler.wasd) return;
    const old = handler.code;
    const name = nameRef(handler.names);
    const G = name("glob"), H = name("highlighted_object");
    const q = [
      0x64, 0, 0x81, 0, KEY_Q, 0x0f, 0x95, -1, -1,
      0x89, ...G, 0x85, ...H, 0x43, 2, 0xa7, ...name("getAt"), 0x43, 1, 0x97, ...name("voidp"), 0x14, 0x95, -1, -1,
      0x89, ...G, 0xa1, ...H, 0x43, 1, 0xa7, ...name("buildIconP"), 0x14, 0x95, -1, -1,
      0x89, ...G, 0xa1, ...H, 0x85, ...name("disassemble"), 0x43, 1, 0x97, ...name("string"), 0x42, 2, 0xa7, ...name("menuclick"),
    ];
    for (let i = 0; i < q.length; i++) if (q[i] === -1) { const rel = q.length - (i - 1); q[i] = rel >> 8; q[i + 1] = rel & 0xff; i++; }

    const code = addKeyCase(old, q);
    const tests = keyTests(code);
    ARROWS.forEach((k, i) => { code[tests.get(k)] = WASD[i]; });
    await this.replaceHandlerCode(handler.id, handler.rec, code);
    handler.code = code;
    handler.wasd = true;
  };

  // Back to the arrow keys, without the Q case
  Movie.prototype.unsetWasdControls = async function (handler) {
    if (!handler.wasd) return;
    const at = keyTests(handler.code).get(KEY_Q);
    const from = at - 4, j = from + 6; // peek 0, pushint8 12, eq, jmpifz <past the case>
    const code = cutCode(handler.code, from, j + be16(handler.code, j + 1));
    const tests = keyTests(code);
    WASD.forEach((k, i) => { code[tests.get(k)] = ARROWS[i]; });
    await this.replaceHandlerCode(handler.id, handler.rec, code);
    handler.code = code;
    handler.wasd = false;
  };

  /* Escape opens the in-game menu, or closes it again, like the Menu button and its Continue,
   * with the click those buttons make:
   *       53: if not voidp(glob.main_menu_popup) then
   *             SndSFX("sfx_interface_click_button")
   *             if getAt(glob.main_menu_popup.ss, 1).locH = 1000 then glob.main_menu_popup.show()
   *             else glob.main_menu_popup.hide()
   * (the menu's hide parks all its sprites at point(1000, 1000); it's void outside missions).
   * The keyDown script has no such string, so it gets added to the script's literals.
   * An Esc case from an earlier version (without the sound) is replaced. */
  const KEY_ESC = 53, CLICK = "sfx_interface_click_button";
  Movie.prototype.setMenuKey = async function (handler) {
    if (handler.menu) return;
    const name = nameRef(handler.names);
    const G = name("glob"), M = name("main_menu_popup");
    const popup = [0x89, ...G, 0xa1, ...M];
    const click = (await this.addLiteral(handler.id, CLICK)) * 8;
    const q = asm([
      0x64, 0, 0x81, 0, KEY_ESC, 0x0f, { op: 0x95, to: "end" },
      0x89, ...G, 0x85, ...M, 0x43, 2, 0xa7, ...name("getAt"), 0x43, 1, 0x97, ...name("voidp"), 0x14, { op: 0x95, to: "end" },
      0x84, click >> 8, click & 0xff, 0x42, 1, 0x97, ...name("SndSFX"),
      ...popup, 0xa1, ...name("ss"), 0x81, 0, 1, 0x43, 2, 0x97, ...name("getAt"), 0xa1, ...name("locH"),
      0x81, 1000 >> 8, 1000 & 0xff, 0x0f, { op: 0x95, to: "shown" },
      ...popup, 0x42, 1, 0xa7, ...name("show"), { op: 0x93, to: "end" },
      { label: "shown" }, ...popup, 0x42, 1, 0xa7, ...name("hide"),
      { label: "end" },
    ]);
    const old = menuCase(handler.code, handler.names);
    const code = addKeyCase(old ? removeCase(handler.code, old.from, old.to) : handler.code, q);
    await this.replaceHandlerCode(handler.id, handler.rec, code);
    handler.code = code;
    handler.menu = true;
  };

  Movie.prototype.unsetMenuKey = async function (handler) {
    const esc = menuCase(handler.code, handler.names);
    if (!esc) return;
    const code = cutCode(handler.code, esc.from, esc.to);
    await this.replaceHandlerCode(handler.id, handler.rec, code);
    handler.code = code;
    handler.menu = false;
  };

  // The Esc case in a keyDown handler: {from, to, sound (plays the click)}, or null
  function menuCase(code, names) {
    const at = keyTests(code).get(KEY_ESC);
    if (at === undefined) return null;
    const from = at - 4, j = from + 6; // peek 0, pushint8 53, eq, jmpifz <past the case>
    const to = j + be16(code, j + 1), sfx = names.indexOf("SndSFX");
    return { from, to, sound: decode(code.subarray(from, to)).some((i) => i.op === 0x57 && i.arg === sfx) };
  }

  // Cut code[from, to) out of a handler; jumps from before it to past it get shorter
  function removeCase(old, from, to) {
    const n = to - from;
    const code = new Uint8Array(old.length - n);
    code.set(old.subarray(0, from));
    code.set(old.subarray(to), from);
    for (let p = 0; p < from; p += opLen(code[p])) {
      if ((code[p] === 0x93 || code[p] === 0x95) && p + be16(code, p + 1) >= to) {
        const rel = be16(code, p + 1) - n;
        code[p + 1] = rel >> 8; code[p + 2] = rel & 0xff;
      }
    }
    return code;
  }

  /* Index of a string literal in a script, adding it if it's missing. The literal table and its
   * data are copied to the end of the chunk with the new one added (the old copy stays, unused). */
  Movie.prototype.addLiteral = async function (id, str) {
    const d = await this.data(id);
    const lits = scriptLiterals(d), have = lits.indexOf(str);
    if (have >= 0) return have;
    const count = be16(d, 78), off = be32(d, 80), dataLen = be32(d, 84), dataOff = be32(d, 88);
    const bytes = new TextEncoder().encode(str + "\0");
    const entry = 4 + bytes.length + ((4 + bytes.length) & 1);
    const at = d.length + (d.length & 1), table = 8 * (count + 1), newData = at + table;
    const out = new Uint8Array(newData + dataLen + entry);
    out.set(d);
    out.set(d.subarray(off, off + 8 * count), at);
    out.set(d.subarray(dataOff, dataOff + dataLen), newData);
    const dv = new DataView(out.buffer);
    dv.setUint32(at + 8 * count, 1); // string
    dv.setUint32(at + 8 * count + 4, dataLen);
    dv.setUint32(newData + dataLen, bytes.length);
    out.set(bytes, newData + dataLen + 4);
    dv.setUint32(8, out.length);
    dv.setUint32(12, out.length);
    dv.setUint16(78, count + 1);
    dv.setUint32(80, at);
    dv.setUint32(84, dataLen + entry);
    dv.setUint32(88, newData);
    this.setData(id, out);
    return count;
  };

  // bytes, with {op, to: label} for a jump and {label} for where one lands
  function asm(items) {
    const labels = {}, out = [];
    let p = 0;
    for (const it of items) if (typeof it === "number") p++; else if (it.label) labels[it.label] = p; else p += 3;
    for (const it of items) {
      if (typeof it === "number") out.push(it);
      else if (!it.label) { const rel = labels[it.to] - out.length; out.push(it.op, rel >> 8, rel & 0xff); }
    }
    return out;
  }

  /* Add a case at the end of a keyDown handler's "case the keyCode of". */
  function addKeyCase(old, q) {
    const end = old.length - 3; // "pop 1, ret" that closes the case statement
    const code = new Uint8Array(old.length + q.length);
    code.set(old.subarray(0, end));
    code.set(q, end);
    code.set(old.subarray(end), end + q.length);
    // the cases' "jump to end case" now has to skip the new case too
    for (let p = 0; p < end; p += opLen(code[p])) {
      if (code[p] === 0x93 && p + be16(code, p + 1) === end) {
        const rel = be16(code, p + 1) + q.length;
        code[p + 1] = rel >> 8; code[p + 2] = rel & 0xff;
      }
    }
    return code;
  }

  // ---------------------------------------------------------------- plan pickup animation fix

  /* Picking up a plan swoops its icon from the map to its slot in the plans bar:
   *   on setPlanLater me, class, opt
   *     pSwoop = [#from: opt, #to: s.loc, #start: the milliseconds, #class: class]
   * Picking up a second copy of the same plan while the first is still flying reads s.loc
   * mid-flight, so the slot's icon ends up stuck over the map. The fix puts
   *     if not voidp(pSwoop) then s.loc = pSwoop.to
   * in front, so the new swoop starts from the slot's real position. */
  Movie.prototype.findPlanSwoop = async function () {
    const found = [];
    for await (const h of this.handlers()) {
      if (h.name !== "setPlanLater") continue;
      if (h.code[0] === 0x85) found.push({ ...h, fixed: false }); // starts with pushsymb #from
      else if (h.code[0] === 0x8a) found.push({ ...h, fixed: true }); // getprop pSwoop
    }
    return found;
  };

  Movie.prototype.fixPlanSwoop = async function (handler) {
    if (handler.fixed) return;
    const name = nameRef(handler.names);
    const P = name("pSwoop");
    const pre = [
      0x8a, ...P, 0x43, 1, 0x97, ...name("voidp"), 0x14, 0x95, 0, 15,
      0x8a, ...name("s"), 0x8a, ...P, 0xa1, ...name("to"), 0xa2, ...name("loc"),
    ];
    const code = new Uint8Array(pre.length + handler.code.length);
    code.set(pre);
    code.set(handler.code, pre.length);
    await this.replaceHandlerCode(handler.id, handler.rec, code);
    handler.code = code;
    handler.fixed = true;
  };

  // The fix's "if" ends where its jmpifz (at 9) lands; the original handler follows
  Movie.prototype.unfixPlanSwoop = async function (handler) {
    if (!handler.fixed) return;
    if (handler.code[9] !== 0x95) throw new Error("setPlanLater: unexpected code");
    const code = handler.code.slice(9 + be16(handler.code, 10));
    await this.replaceHandlerCode(handler.id, handler.rec, code);
    handler.code = code;
    handler.fixed = false;
  };

  // ---------------------------------------------------------------- units and plans on deep water

  /* The game's level loader (map_display.readmap) places units and plans like this:
   *     if thingy[1] = "waterunit" then entry.setAt(#terrain, #water)     (same for "waterplan")
   * so they can only start on plain water. Goals already read an optional terrain:
   *     if thingy.count > 2 then entry.setAt(#terrain, symbol(thingy[3]))
   * The fix copies that statement into both water branches, reading thingy[4], so
   * "waterunit,vehicle,tugboat,water_undiggable" and "waterplan,freighter,1,water_undiggable"
   * start on deep water. */
  const DEEP_KINDS = ["waterunit", "waterplan"];

  // Lscr literals: strings come back as strings, the rest as null
  function scriptLiterals(d) {
    const count = be16(d, 78), off = be32(d, 80), dataOff = be32(d, 88);
    const out = [];
    for (let i = 0; i < count; i++) {
      const type = be32(d, off + 8 * i), o = be32(d, off + 8 * i + 4);
      out.push(type === 1 ? latin1(d.subarray(dataOff + o + 4, dataOff + o + 4 + be32(d, dataOff + o))).replace(/\0+$/, "") : null);
    }
    return out;
  }

  // one instruction per entry: {p, op (0x00-0x7f, without the argument size), arg, len}
  function decode(code) {
    const out = [];
    for (let p = 0; p < code.length;) {
      const b = code[p], len = opLen(b);
      const arg = len === 2 ? code[p + 1] : len === 3 ? be16(code, p + 1) : len === 5 ? be32(code, p + 1) : null;
      out.push({ p, op: b < 0x40 ? b : 0x40 + (b % 0x40), arg, len });
      p += len;
    }
    return out;
  }
  // rewrite an instruction's argument in place, at the width it already has
  function setArg(code, i, v) {
    const q = i.p + 1;
    if (i.len === 2 && v < 0x100) code[q] = v;
    else if (i.len === 3 && v < 0x10000) { code[q] = v >> 8; code[q + 1] = v & 0xff; }
    else if (i.len === 5) { code[q] = v >>> 24; code[q + 1] = (v >> 16) & 0xff; code[q + 2] = (v >> 8) & 0xff; code[q + 3] = v & 0xff; }
    else throw new Error("readmap: a value got too big to patch");
  }
  const OP = { eq: 0x0f, pushint8: 0x41, pushcons: 0x44, getlocal: 0x4c, jmp: 0x53, endrepeat: 0x54, jmpifz: 0x55, getobjprop: 0x61 };

  // Inside a handler: the "if thingy[1] = <kind> then" test, as {test, body (start), end}
  function kindBranch(ins, lits, kind) {
    for (let k = 0; k + 2 < ins.length; k++) {
      const c = ins[k];
      if (c.op !== OP.pushcons || lits[c.arg / 8] !== kind) continue;
      if (ins[k + 1].op !== OP.eq || ins[k + 2].op !== OP.jmpifz) continue;
      const j = ins[k + 2];
      return { jump: j, body: ins[k + 3].p, end: j.p + j.arg };
    }
    return null;
  }

  /* Returns [{id, rec, names, code, kinds: {waterunit: fixed?, waterplan: fixed?}, fixed (all), ...}]
   * for the readmap handler when it has the expected shape. */
  Movie.prototype.findDeepWater = async function () {
    const found = [];
    for await (const h of this.handlers()) {
      if (h.name !== "readmap") continue;
      const lits = scriptLiterals(await this.data(h.id));
      const ins = decode(h.code);
      const count = h.names.indexOf("count");
      if (count < 0) continue;
      // the goals' "if thingy.count > 2 then entry.setAt(#terrain, ...)" statement gets copied
      const k = ins.findIndex((i, n) => i.op === OP.getlocal && n + 4 < ins.length &&
        ins[n + 1].op === OP.getobjprop && ins[n + 1].arg === count &&
        ins[n + 2].op === OP.pushint8 && ins[n + 2].arg === 2 && ins[n + 4].op === OP.jmpifz);
      if (k < 0) continue;
      const kinds = {};
      for (const kind of DEEP_KINDS) {
        const b = kindBranch(ins, lits, kind);
        if (b) kinds[kind] = ins.some((i) => i.p >= b.body && i.p < b.end && i.op === OP.getobjprop && i.arg === count);
      }
      if (!Object.keys(kinds).length) continue;
      const g = ins[k + 4];
      found.push({ ...h, lits, kinds, fixed: Object.values(kinds).every(Boolean), template: h.code.slice(ins[k].p, g.p + g.arg) });
    }
    return found;
  };

  Movie.prototype.fixDeepWater = async function (handler) {
    if (handler.fixed) return;
    // thingy.count > 3 ... thingy[4] instead of > 2 ... thingy[3]
    const t = handler.template.slice();
    const ti = decode(t).filter((i) => i.op === OP.pushint8);
    if (ti.length !== 2 || ti[0].arg !== 2 || ti[1].arg !== 3) throw new Error("readmap: unexpected goal terrain code");
    setArg(t, ti[0], 3);
    setArg(t, ti[1], 4);
    let code = handler.code;
    for (const kind of DEEP_KINDS) {
      if (handler.kinds[kind] !== false) continue;
      code = insertCode(code, kindBranch(decode(code), handler.lits, kind).end, t);
      handler.kinds[kind] = true;
    }
    await this.replaceHandlerCode(handler.id, handler.rec, code);
    handler.code = code;
    handler.fixed = true;
  };

  // The copied statement is the last thing in each water branch, as long as the goals' one
  Movie.prototype.unfixDeepWater = async function (handler) {
    let code = handler.code;
    const n = handler.template.length, count = handler.names.indexOf("count");
    for (const kind of DEEP_KINDS) {
      if (handler.kinds[kind] !== true) continue;
      const end = kindBranch(decode(code), handler.lits, kind).end;
      if (!decode(code.subarray(end - n, end)).some((i) => i.op === OP.getobjprop && i.arg === count)) throw new Error("readmap: unexpected code");
      code = cutCode(code, end - n, end);
      handler.kinds[kind] = false;
    }
    if (code === handler.code) return;
    await this.replaceHandlerCode(handler.id, handler.rec, code);
    handler.code = code;
    handler.fixed = false;
  };

  /* Put bytecode in at the end of an if-branch's body. Jumps that cross it get longer; ones
   * landing on it skip it (only the branch, which falls through into it, runs it). */
  function insertCode(old, at, t) {
    const n = t.length;
    const code = new Uint8Array(old.length + n);
    code.set(old.subarray(0, at));
    code.set(t, at);
    code.set(old.subarray(at), at + n);
    for (const i of decode(old)) {
      if (i.op !== OP.jmp && i.op !== OP.jmpifz && i.op !== OP.endrepeat) continue;
      const from = i.p, to = i.op === OP.endrepeat ? from - i.arg : from + i.arg;
      const nf = from < at ? from : from + n, nt = to < at ? to : to + n;
      const arg = Math.abs(nt - nf);
      if (arg !== i.arg) setArg(code, { ...i, p: nf }, arg);
    }
    return code;
  }

  /* Take code[from, to) back out of a handler (undoing insertCode and friends). Jumps from outside
   * it that cross it get shorter; ones landing inside it land where it was. */
  function cutCode(old, from, to) {
    const n = to - from;
    const code = new Uint8Array(old.length - n);
    code.set(old.subarray(0, from));
    code.set(old.subarray(to), from);
    for (const i of decode(old)) {
      if (i.op !== OP.jmp && i.op !== OP.jmpifz && i.op !== OP.endrepeat) continue;
      if (i.p >= from && i.p < to) continue;
      const t = i.op === OP.endrepeat ? i.p - i.arg : i.p + i.arg;
      const nf = i.p < from ? i.p : i.p - n, nt = t <= from ? t : t >= to ? t - n : from;
      const arg = Math.abs(nt - nf);
      if (arg !== i.arg) setArg(code, { ...i, p: nf }, arg);
    }
    return code;
  }

  // ---------------------------------------------------------------- music per level

  /* Starting a mission (startlevel) plays a random in-game track:
   *     if not restartP then SndMusicStart("music_game")
   * SndMusicStart picks one of glob.songs for "music_game", but plays any other name as given.
   * The fix lets a level choose with a "music=music_game_a" line in its [map] section:
   *     if not restartP then
   *       if voidp(findPos(glob.map_display.pMap.map, #music)) then SndMusicStart("music_game")
   *       else SndMusicStart(getProp(glob.map_display.pMap.map, #music))
   * (startlevel has just read the level into map_display.pMap). */
  Movie.prototype.findLevelMusic = async function () {
    const found = [];
    for await (const h of this.handlers()) {
      if (h.name !== "startlevel") continue;
      const names = h.names, lits = scriptLiterals(await this.data(h.id));
      const ins = decode(h.code);
      const start = names.indexOf("SndMusicStart"), findPos = names.indexOf("findPos");
      const fixed = ins.some((i) => i.op === 0x67 && i.arg === findPos);
      // pushcons "music_game", pusharglistnoret 1, extcall SndMusicStart
      const k = ins.findIndex((i, n) => i.op === OP.pushcons && lits[i.arg / 8] === "music_game" && n + 2 < ins.length &&
        ins[n + 1].op === 0x42 && ins[n + 1].arg === 1 && ins[n + 2].op === 0x57 && ins[n + 2].arg === start);
      if (!fixed && k < 0) continue;
      found.push({ ...h, fixed, call: k < 0 ? null : { from: ins[k].p, to: ins[k + 2].p + ins[k + 2].len } });
    }
    return found;
  };

  Movie.prototype.fixLevelMusic = async function (handler) {
    if (handler.fixed) return;
    const name = nameRef(handler.names);
    const old = handler.code, { from, to } = handler.call;
    const random = [...old.subarray(from, to)]; // the original SndMusicStart("music_game")
    const map = [0x89, ...name("glob"), 0xa1, ...name("map_display"), 0xa1, ...name("pMap"), 0xa1, ...name("map"),
      0x85, ...name("music"), 0x43, 2];
    const chosen = [...map, 0xa7, ...name("getProp"), 0x42, 1, 0x97, ...name("SndMusicStart")];
    const test = [...map, 0xa7, ...name("findPos"), 0x43, 1, 0x97, ...name("voidp")];
    const rel = (n) => [n >> 8, n & 0xff];
    // jmpifz (a #music line) skips the random call and its jmp; the jmp skips the chosen call
    const block = [...test, 0x95, ...rel(3 + random.length + 3), ...random, 0x93, ...rel(3 + chosen.length), ...chosen];
    const code = new Uint8Array(old.length - (to - from) + block.length);
    code.set(old.subarray(0, from));
    code.set(block, from);
    code.set(old.subarray(to), from + block.length);
    // jumps over the replaced call (the "if not restartP" one) now have to skip the whole block
    const grow = block.length - (to - from);
    for (const i of decode(old)) {
      if (i.op !== OP.jmp && i.op !== OP.jmpifz && i.op !== OP.endrepeat) continue;
      const f = i.p, t = i.op === OP.endrepeat ? f - i.arg : f + i.arg;
      if ((t > from && t < to) || (f >= from && f < to)) throw new Error("startlevel: unexpected jump");
      const nf = f < from ? f : f + grow, nt = t < to ? t : t + grow;
      const arg = Math.abs(nt - nf);
      if (arg !== i.arg) setArg(code, { ...i, p: nf }, arg);
    }
    await this.replaceHandlerCode(handler.id, handler.rec, code);
    handler.code = code;
    handler.fixed = true;
    handler.call = { from: from + 28, to: from + 28 + (to - from) };
  };

  /* The fix's block is: test (25 bytes), jmpifz, the original call, jmp, chosen call (25 bytes).
   * Put the original call back in its place. */
  Movie.prototype.unfixLevelMusic = async function (handler) {
    if (!handler.fixed) return;
    const { from, to } = handler.call, start = from - 28, end = to + 3 + 25;
    const c = handler.code;
    if (c[start] !== 0x89 || c[from - 3] !== 0x95 || c[to] !== 0x93) throw new Error("startlevel: unexpected code");
    const code = cutCode(cutCode(c, to, end), start, from);
    await this.replaceHandlerCode(handler.id, handler.rec, code);
    handler.code = code;
    handler.fixed = false;
    handler.call = { from: start, to: start + (to - from) };
  };

  /* Reaching a goal or bonus goal ends in worlds_manager's
   *   on reportSuccess me, a
   *     ...
   *     me.writePrefs()
   * which writes the whole progress file to disk mid-game, and the game freezes until it's done.
   * The fix drops that call and saves when the mission is left instead, at the top of
   *   on quitlevel restartP
   *     glob.worlds_manager.writePrefs()
   * (End, Restart and the tutorial all go through quitlevel; closing the window mid-mission loses
   * that mission's result). Returns [{...handler, kind: "report" | "quit", fixed}]. */
  Movie.prototype.findGoalSave = async function () {
    const found = [];
    for await (const h of this.handlers()) {
      if (h.name !== "reportSuccess" && h.name !== "quitlevel") continue;
      const wp = h.names.indexOf("writePrefs"), ins = decode(h.code);
      const call = ins.findIndex((i) => i.op === 0x67 && i.arg === wp);
      if (h.name === "quitlevel") found.push({ ...h, kind: "quit", fixed: call >= 0 && call < 4 });
      // the worlds_manager one: its last statement is "getparam me, pusharglistnoret 1, objcall writePrefs"
      else if (call >= 2 && ins[call - 2].op === 0x4b && ins[call - 1].op === 0x42 && ins[call - 1].arg === 1 &&
        ins[call + 1] && ins[call + 1].op === 0x01) found.push({ ...h, kind: "report", fixed: false, call: ins[call - 2].p });
      else if (wp >= 0 && h.names.includes("worlds_manager") && h.code.length > 3 &&
        ins.some((i) => i.op === 0x67 && i.arg === h.names.indexOf("setFinished"))) found.push({ ...h, kind: "report", fixed: true });
    }
    // only a game where both halves are there can be fixed
    return found.some((h) => h.kind === "report") && found.some((h) => h.kind === "quit") ? found : [];
  };

  Movie.prototype.fixGoalSave = async function (handler) {
    if (handler.fixed) return;
    let code;
    if (handler.kind === "report") {
      code = new Uint8Array(handler.call + 1);
      code.set(handler.code.subarray(0, handler.call));
      code[handler.call] = 0x01; // ret
    } else {
      const name = nameRef(handler.names);
      const save = [0x89, ...name("glob"), 0xa1, ...name("worlds_manager"), 0x42, 1, 0xa7, ...name("writePrefs")];
      code = new Uint8Array(save.length + handler.code.length);
      code.set(save);
      code.set(handler.code, save.length);
    }
    await this.replaceHandlerCode(handler.id, handler.rec, code);
    handler.code = code;
    handler.fixed = true;
    if (handler.kind === "report") delete handler.call;
  };

  Movie.prototype.unfixGoalSave = async function (handler) {
    if (!handler.fixed) return;
    const name = nameRef(handler.names), old = handler.code;
    let code;
    if (handler.kind === "report") {
      // me.writePrefs() back in front of the closing ret
      const save = [0x4b, 0, 0x42, 1, 0xa7, ...name("writePrefs")];
      code = new Uint8Array(old.length + save.length);
      code.set(old.subarray(0, old.length - 1));
      code.set(save, old.length - 1);
      code[code.length - 1] = 0x01;
      handler.call = old.length - 1;
    } else {
      if (old[0] !== 0x89 || old[8] !== 0xa7) throw new Error("quitlevel: unexpected code");
      code = old.slice(11);
    }
    await this.replaceHandlerCode(handler.id, handler.rec, code);
    handler.code = code;
    handler.fixed = false;
  };

  /* A whirlpool remembers the unit going through it (pOccupant, on both ends of the pair) and
   * MoveObject won't let any other unit onto it while that's set:
   *   wpuser = ttile.whirlpool.getUser()
   *   if not voidp(wpuser) and wpuser <> ftile.occupant then return [0, ttile]
   * It's only cleared by leaveWhirlpool when the unit drives off. A unit taken apart after
   * teleporting is still sitting on the far whirlpool, so that one stays taken for good, and the
   * pair is dead. The fix puts this at the top of the whirlpool's stepFrame:
   *   if not voidp(pOccupant) then
   *     if not voidp(pWhirlpoolPartner) then
   *       if me.getProp(#pTile, #occupant) <> pOccupant then
   *         if pWhirlpoolPartner.getProp(#pTile, #occupant) <> pOccupant then pOccupant = void
   * (a unit really using the pair always stands on one of its two tiles).
   * Returns [{...handler, at, template, fixed}]. */
  function whirlpoolCode(names) {
    const n = nameRef(names), k = (x) => { const [hi, lo] = n(x); return (hi << 8) | lo; };
    const OCC = ["getprop", k("pOccupant")], PARTNER = ["getprop", k("pWhirlpoolPartner")];
    const tileOccupant = [["pushsymb", k("pTile")], ["pushsymb", k("occupant")], ["pusharglist", 3], ["objcall", k("getProp")]];
    return lingo([
      OCC, ["pusharglist", 1], ["extcall", k("voidp")], ["not"], ["jmpifz", "end"],
      PARTNER, ["pusharglist", 1], ["extcall", k("voidp")], ["not"], ["jmpifz", "end"],
      ["getparam", 0], ...tileOccupant, OCC, ["nteq"], ["jmpifz", "end"],
      PARTNER, ...tileOccupant, OCC, ["nteq"], ["jmpifz", "end"],
      ["pusharglist", 0], ["extcall", k("void")], ["setprop", k("pOccupant")],
      { label: "end" },
    ]);
  }

  Movie.prototype.findWhirlpoolFix = async function () {
    const all = [], scripts = new Set();
    for await (const h of this.handlers()) { all.push(h); if (h.name === "enterWhirlpool") scripts.add(h.id); }
    const found = [];
    for (const h of all) {
      if (h.name !== "stepFrame" || !scripts.has(h.id)) continue;
      let template;
      try { template = whirlpoolCode(h.names); } catch { continue; }
      const fixed = h.code.length >= template.length && template.every((b, i) => h.code[i] === b);
      found.push({ ...h, at: 0, template, fixed });
    }
    return found.length === 1 ? found : [];
  };

  Movie.prototype.fixWhirlpool = async function (handler) {
    if (handler.fixed) return;
    const code = insertCode(handler.code, handler.at, handler.template);
    await this.replaceHandlerCode(handler.id, handler.rec, code);
    handler.code = code;
    handler.fixed = true;
  };

  Movie.prototype.unfixWhirlpool = async function (handler) {
    if (!handler.fixed) return;
    const code = cutCode(handler.code, handler.at, handler.at + handler.template.length);
    await this.replaceHandlerCode(handler.id, handler.rec, code);
    handler.code = code;
    handler.fixed = false;
  };

  /* Monsters can't be controlled: map_display.forwardClick only passes a click on to a tile's
   * occupant when its occupant_type isn't #monster. But when something's been built, the build
   * cloud's prepareFrame selects it once the cloud clears, straight past that check:
   *   if not pObject.pDead then pObject.click(#mouseDown, #dontplaysound)
   * so a monster built from a plan came out selected, with its menu, and could be driven around.
   * The fix makes that
   *   if not pObject.pDead and not pObject.monsterP() then ...
   * (every object has monsterP; monster.generic's says yes). Returns [{...handler, at, template, fixed}]. */
  function builtSelectTest(names) {
    const n = nameRef(names), k = (x) => { const [hi, lo] = n(x); return (hi << 8) | lo; };
    return lingo([["getprop", k("pObject")], ["pusharglist", 1], ["objcall", k("monsterP")], ["not"], ["and"]]);
  }

  Movie.prototype.findBuiltMonsterSelect = async function () {
    const found = [];
    for await (const h of this.handlers()) {
      if (h.name !== "prepareFrame") continue;
      const pObject = h.names.indexOf("pObject"), pDead = h.names.indexOf("pDead"), click = h.names.indexOf("click");
      if (pObject < 0 || pDead < 0 || click < 0 || h.names.indexOf("monsterP") < 0) continue;
      const ins = decode(h.code);
      // getprop pObject, getobjprop pDead, not, [the fix], jmpifz, getprop pObject, ..., objcall click
      const k = ins.findIndex((i, j) => i.op === 0x4a && i.arg === pObject && ins[j + 1] && ins[j + 1].op === 0x61 &&
        ins[j + 1].arg === pDead && ins[j + 2] && ins[j + 2].op === 0x14);
      if (k < 0) continue;
      const at = ins[k + 2].p + 1, template = builtSelectTest(h.names);
      const fixed = h.code.length >= at + template.length && template.every((b, i) => h.code[at + i] === b);
      const jz = ins.find((i) => i.p === (fixed ? at + template.length : at));
      const call = ins.find((i) => jz && i.p > jz.p && i.op === 0x67 && i.arg === click);
      if (!jz || jz.op !== OP.jmpifz || !call || call.p > jz.p + jz.arg) continue;
      found.push({ ...h, at, template, fixed });
    }
    return found.length === 1 ? found : [];
  };

  Movie.prototype.fixBuiltMonsterSelect = async function (handler) {
    if (handler.fixed) return;
    const code = insertCode(handler.code, handler.at, handler.template);
    await this.replaceHandlerCode(handler.id, handler.rec, code);
    handler.code = code;
    handler.fixed = true;
  };

  Movie.prototype.unfixBuiltMonsterSelect = async function (handler) {
    if (!handler.fixed) return;
    const code = cutCode(handler.code, handler.at, handler.at + handler.template.length);
    await this.replaceHandlerCode(handler.id, handler.rec, code);
    handler.code = code;
    handler.fixed = false;
  };

  /* Cheat: every mission and world is open. A mission's state is <0 locked, 0 open, >=1 done:
   *   readWorlds   starts every mission at -1 ([#opens: ..., #state: -1])
   *   setState     then puts back the saved progress from the Prefs file
   *   mouseDown    on a world-map world button: if not worldCompleteP(<previous world>) then
   *                  "coming soon" sound and blink, else go to that world
   * The cheat makes readWorlds start them at 0 (pushint 1, inv becomes pushint 0, inv), puts
   *     if state < 0 then state = 0
   * in front of setState, and a jump past the world buttons' check. Missions opened by the cheat
   * are saved as open in the progress file, so they stay open if it's switched off again.
   * Returns [{...handler, kind: "init" | "state" | "world", fixed}]. */
  const CLAMP_STATE = [0x4b, 0x18, 0x03, 0x0c, 0x95, 0, 6, 0x03, 0x51, 0x18]; // getparam state (4th), pushzero, lt, jmpifz, pushzero, setparam state
  Movie.prototype.findUnlockAll = async function () {
    const found = [];
    for await (const h of this.handlers()) {
      const st = h.names.indexOf("state");
      if (st < 0) continue;
      if (h.name === "readWorlds") {
        // pushsymb #state, pushint <1 or 0>, inv
        const ins = decode(h.code);
        const k = ins.findIndex((i, n) => i.op === 0x45 && i.arg === st && n + 2 < ins.length &&
          ins[n + 1].op === OP.pushint8 && ins[n + 1].arg <= 1 && ins[n + 2].op === 0x09);
        if (k >= 0) found.push({ ...h, kind: "init", pos: ins[k + 1].p, len: ins[k + 1].len, fixed: ins[k + 1].arg === 0 });
      } else if (h.name === "setState") {
        const fixed = CLAMP_STATE.every((b, i) => h.code[i] === b);
        // its last statement is level.state = state: getlocal, getparam state, setobjprop #state
        const tail = decode(h.code).slice(-3);
        if (tail[0].op === 0x4b && tail[0].arg === 0x18 && tail[1].op === 0x62 && tail[1].arg === st) found.push({ ...h, kind: "state", fixed });
      } else if (h.name === "mouseDown") {
        const wc = h.names.indexOf("worldCompleteP"), ins = decode(h.code);
        const k = ins.findIndex((i, n) => i.op === 0x67 && i.arg === wc && n >= 5 && ins[n + 1].op === 0x14 && ins[n + 2].op === OP.jmpifz);
        if (wc < 0 || k < 0) continue;
        const j = ins[k + 2], target = j.p + j.arg, before = ins[k - 5];
        found.push({ ...h, kind: "world", at: ins[k - 4].p, fixed: before.op === OP.jmp && before.p + before.arg === target });
      }
    }
    return found.some((h) => h.kind === "init") && found.some((h) => h.kind === "state") ? found : [];
  };

  Movie.prototype.fixUnlockAll = async function (handler) {
    if (handler.fixed) return;
    let code;
    if (handler.kind === "init") {
      code = handler.code.slice();
      code[handler.pos + handler.len - 1] = 0;
    } else if (handler.kind === "state") {
      code = new Uint8Array(CLAMP_STATE.length + handler.code.length);
      code.set(CLAMP_STATE);
      code.set(handler.code, CLAMP_STATE.length);
    } else {
      // a jmp in front of the check, to where its jmpifz goes when the world is complete
      const ins = decode(handler.code), j = ins.find((i) => i.p > handler.at && i.op === OP.jmpifz);
      code = jumpInFront(handler.code, handler.at, j.p + j.arg);
      handler.at += 3;
    }
    await this.replaceHandlerCode(handler.id, handler.rec, code);
    handler.code = code;
    handler.fixed = true;
  };

  Movie.prototype.unfixUnlockAll = async function (handler) {
    if (!handler.fixed) return;
    let code;
    if (handler.kind === "init") {
      code = handler.code.slice();
      code[handler.pos + handler.len - 1] = 1;
    } else if (handler.kind === "state") {
      code = handler.code.slice(CLAMP_STATE.length);
    } else {
      // cut the jmp; the check after it was left as it was
      code = cutCode(handler.code, handler.at - 3, handler.at);
      handler.at -= 3;
    }
    await this.replaceHandlerCode(handler.id, handler.rec, code);
    handler.code = code;
    handler.fixed = false;
  };

  // ---------------------------------------------------------------- deep-water goal shadow

  /* A goal (or bonus goal) draws its shadow from the member "goal.shadow." & <its tile's terrain>.
   * The games only ship shadows for some terrains (normal and water; WB2 also goalterrain), so a goal
   * on deep water ("goal,freighter,water_undiggable") stops with a script error. The fix adds a
   * "goal.shadow.water_undiggable" member: the water shadow, darkened to stand out on deep water. */
  const DEEP_SHADOW = "goal.shadow.water_undiggable", WATER_SHADOW = "goal.shadow.water";
  // Scales the water shadow's colours (fill 0,204,204, rim 0,204,255) to 0,102,112 and 0,102,140: clearly
  // darker than the deep-water tile (14,153,184), as the water shadow is darker than plain water.
  const DEEP_TINT = [0.5, 0.5, 0.55];

  // PackBits, one row at a time (runs never cross a row, which every decoder accepts)
  function packbitsEncode(d, pitch) {
    const out = [];
    for (let r = 0; r < d.length; r += pitch) {
      const row = d.subarray(r, Math.min(r + pitch, d.length));
      let i = 0;
      while (i < row.length) {
        let run = 1;
        while (i + run < row.length && run < 128 && row[i + run] === row[i]) run++;
        if (run >= 2) { out.push(257 - run, row[i]); i += run; continue; }
        let n = 1;
        while (i + n < row.length && n < 128 && !(i + n + 1 < row.length && row[i + n] === row[i + n + 1])) n++;
        out.push(n - 1, ...row.subarray(i, i + n));
        i += n;
      }
    }
    return new Uint8Array(out);
  }

  // A CASt record with its name (info item 1) replaced
  function castWithName(d, name) {
    const infoLen = be32(d, 4), specLen = be32(d, 8);
    const info = d.subarray(12, 12 + infoLen), spec = d.subarray(12 + infoLen, 12 + infoLen + specLen);
    const dataOff = be32(info, 0), n = be16(info, dataOff);
    const offs = [];
    for (let i = 0; i <= n; i++) offs.push(be32(info, dataOff + 2 + 4 * i));
    const base = dataOff + 2 + 4 * (n + 1);
    const items = [];
    for (let i = 0; i < n; i++) items.push(info.subarray(base + offs[i], base + offs[i + 1]));
    items[1] = new Uint8Array([name.length, ...fromLatin1(name)]);
    const body = items.reduce((s, x) => s + x.length, 0);
    const ni = new Uint8Array(base + body);
    const dv = new DataView(ni.buffer);
    ni.set(info.subarray(0, dataOff + 2));
    let o = 0;
    items.forEach((x, i) => { dv.setUint32(dataOff + 2 + 4 * i, o); ni.set(x, base + o); o += x.length; });
    dv.setUint32(dataOff + 2 + 4 * n, o);
    const out = new Uint8Array(12 + ni.length + spec.length);
    out.set(d.subarray(0, 12));
    new DataView(out.buffer).setUint32(4, ni.length);
    out.set(ni, 12);
    out.set(spec, 12 + ni.length);
    return out;
  }

  // KEY* rows: {child resource id, parent id, tag}
  Movie.prototype._editKeys = async function (fn) {
    const id = this.entries.find((e) => e.tag === "KEY*").id;
    const key = await this.data(id);
    const kv = new DataView(key.buffer, key.byteOffset, key.byteLength);
    const rows = [];
    for (let i = 0; i < kv.getUint32(8, true); i++) {
      const o = 12 + 12 * i;
      rows.push({ sid: kv.getUint32(o, true), parent: kv.getUint32(o + 4, true), raw: key.slice(o + 8, o + 12) });
    }
    // the player looks rows up by parent (binary search), so they stay sorted by it; the sort is
    // stable, so rows already in order keep their places
    const keep = fn(rows).map((r, i) => ({ r, i })).sort((a, b) => a.r.parent - b.r.parent || a.i - b.i).map((x) => x.r);
    const max = Math.max(kv.getUint32(4, true), keep.length);
    // the unused rows past the end hold a filler row; keep them, and refill rows that get freed
    const out = new Uint8Array(Math.max(key.length, 12 + 12 * max));
    out.set(key);
    const ov = new DataView(out.buffer);
    ov.setUint32(4, max, true);
    ov.setUint32(8, keep.length, true);
    const fill = key.length >= 24 + 12 * rows.length ? key.slice(12 + 12 * rows.length, 24 + 12 * rows.length) : new Uint8Array(12);
    for (let i = keep.length; i < rows.length; i++) out.set(fill, 12 + 12 * i);
    keep.forEach((r, i) => {
      ov.setUint32(12 + 12 * i, r.sid, true);
      ov.setUint32(16 + 12 * i, r.parent, true);
      out.set(r.raw || fromLatin1(r.tag.split("").reverse().join("")), 20 + 12 * i);
    });
    this.setData(id, out);
  };

  // KEY* rows, read only
  Movie.prototype._readKeys = async function (fn) {
    const key = await this.data(this.entries.find((e) => e.tag === "KEY*").id);
    const kv = new DataView(key.buffer, key.byteOffset, key.byteLength);
    const rows = [];
    for (let i = 0; i < kv.getUint32(8, true); i++) rows.push({ sid: kv.getUint32(12 + 12 * i, true), parent: kv.getUint32(16 + 12 * i, true) });
    return fn(rows);
  };

  // Which CAS* resource (cast library) holds a member, and at which slot
  Movie.prototype._castSlot = async function (memberId) {
    for (const e of this.entries) {
      if (e.tag !== "CAS*") continue;
      const d = await this.data(e.id);
      for (let i = 0; i + 4 <= d.length; i += 4) if (be32(d, i) === memberId) return { cas: e.id, at: i };
    }
    return null;
  };

  Movie.prototype._reindexMembers = async function () {
    this.cache.clear();
    await this._index();
  };

  /* Is member `name` there as this version adds it: bitmap data `want`, resource ids within the
   * movie's limit and KEY* in order? Older versions of the editor's additions fail this, so their
   * patches count as not installed and saving puts them back right. */
  Movie.prototype._memberIsCurrent = async function (name, want) {
    const m = this.byName.get(name);
    if (!m || !(await this._memberHasBitmap(name, want))) return false;
    const ids = [m.id, ...Object.values(this.children.get(m.id) || {})];
    let keysSorted = true;
    await this._readKeys((rows) => { for (let i = 1; i < rows.length; i++) if (rows[i].parent < rows[i - 1].parent) keysSorted = false; });
    return keysSorted && ids.every((id) => id <= this.abmpUnk2);
  };

  Movie.prototype._memberHasBitmap = async function (name, want) {
    const m = this.byName.get(name);
    const bitd = m ? this.child(m.id, "BITD") : null;
    const have = bitd != null ? await this.data(bitd) : null;
    return !!have && have.length === want.length && have.every((b, i) => b === want[i]);
  };

  /* Resource ids for new resources. The ABMP header's second number is the movie's highest
   * resource id, and the player only knows resources up to it, so new ones take unused ids below it
   * (gaps left by resources that were deleted or that Afterburner dropped, which KEY* may still name). */
  Movie.prototype._freeIds = async function (n) {
    const taken = new Set(this.entries.map((e) => e.id));
    await this._readKeys((rows) => { for (const r of rows) { taken.add(r.sid); taken.add(r.parent); } });
    for (const lib of this.castLibs) for (const id of lib) taken.add(id);
    for (const e of this.entries) {
      if (e.tag !== "Lctx") continue;
      const d = await this.data(e.id);
      const count = be32(d, 8), off = be16(d, 16);
      for (let i = 0; i < count; i++) taken.add(be32(d, off + 12 * i + 4));
    }
    const out = [];
    for (let id = this.abmpUnk2; id > 1024 && out.length < n; id--) if (!taken.has(id)) out.push(id);
    if (out.length < n) throw new Error("No free resource ids left in this movie");
    return out;
  };

  /* Add a bitmap member (its CASt record and BITD data) in a free slot of the cast library that
   * holds member `near`. */
  Movie.prototype._addMember = async function (cast, bitd, near) {
    const slot = await this._castSlot(near);
    const lib = await this.data(slot.cas);
    let at = -1;
    for (let i = 0; i + 4 <= lib.length; i += 4) if (be32(lib, i) === 0) { at = i; break; }
    if (at < 0) throw new Error("The cast has no free member slot");
    const [castId, bitdId] = await this._freeIds(2);

    // the member record loads with the movie (like every other CASt); its bitmap streams in later
    const ce = { id: castId, off: -1, csize: cast.length, usize: cast.length, ctype: 0, tag: "CASt", ilsData: cast };
    const be = { id: bitdId, off: Number.MAX_SAFE_INTEGER, csize: bitd.length, usize: bitd.length, ctype: 0, tag: "BITD" };
    this.entries.push(ce, be);
    this.ilsOrder.push(castId);
    this.setData(castId, cast);
    this.setData(bitdId, bitd);
    this.byId.set(castId, ce);
    this.byId.set(bitdId, be);

    const newLib = lib.slice();
    new DataView(newLib.buffer).setUint32(at, castId);
    this.setData(slot.cas, newLib);
    await this._editKeys((rows) => [...rows, { sid: bitdId, parent: castId, tag: "BITD" }]);
    await this._reindexMembers();
  };

  // Take a member (and its BITD, Thum...) back out of the movie
  Movie.prototype._removeMember = async function (name) {
    const m = this.byName.get(name);
    if (!m) return;
    const gone = new Set([m.id]);
    const kids = this.children.get(m.id) || {};
    for (const t of Object.keys(kids)) gone.add(kids[t]);
    const slot = await this._castSlot(m.id);
    if (slot) {
      const lib = (await this.data(slot.cas)).slice();
      new DataView(lib.buffer).setUint32(slot.at, 0);
      this.setData(slot.cas, lib);
    }
    await this._editKeys((rows) => rows.filter((r) => !gone.has(r.sid) && !gone.has(r.parent)));
    this.entries = this.entries.filter((e) => !gone.has(e.id));
    this.ilsOrder = this.ilsOrder.filter((id) => !gone.has(id));
    for (const id of gone) { this.byId.delete(id); this.modified.delete(id); }
    await this._reindexMembers();
  };

  /* [{fixed, goalShadow}] when the game has a water goal shadow to build the deep-water one from.
   * Part of the editor's "Deep water" patch, together with findDeepWater's readmap fix. */
  Movie.prototype.findGoalShadow = async function () {
    if (!this.byName.has(WATER_SHADOW)) return [];
    return [{ fixed: await this._memberIsCurrent(DEEP_SHADOW, await this._deepShadowBitmap()), goalShadow: true }];
  };

  // The deep-water shadow's BITD: the water shadow with DEEP_TINT applied
  Movie.prototype._deepShadowBitmap = async function () {
    const src = this.byName.get(WATER_SHADOW);
    const srcBitd = this.child(src.id, "BITD");
    const spec = src.spec;
    const pitch = be16(spec, 0) & 0x7fff, h = bes16(spec, 6) - bes16(spec, 2), w = bes16(spec, 8) - bes16(spec, 4);
    const depth = spec[23];
    if (srcBitd == null || depth !== 32 || pitch !== 4 * w) throw new Error("goal shadow: unexpected bitmap format");
    const packed = await this.data(srcBitd);
    const px = packed.length === pitch * h ? packed.slice() : packbits(packed, pitch * h);
    // 32-bit rows are planar: alpha, red, green, blue. White is the transparent background.
    for (let y = 0; y < h; y++) {
      const r = y * pitch;
      for (let x = 0; x < w; x++) {
        const c = [px[r + w + x], px[r + 2 * w + x], px[r + 3 * w + x]];
        if (c[0] === 255 && c[1] === 255 && c[2] === 255) continue;
        for (let k = 0; k < 3; k++) px[r + (k + 1) * w + x] = Math.round(c[k] * DEEP_TINT[k]);
      }
    }
    return packbitsEncode(px, pitch);
  };

  Movie.prototype.fixGoalShadow = async function (handler) {
    if (handler.fixed) return;
    // one from an earlier version: take it out first, then add it again as this version makes it
    await this._removeMember(DEEP_SHADOW);
    const src = this.byName.get(WATER_SHADOW);
    await this._addMember(castWithName(await this.data(src.id), DEEP_SHADOW), await this._deepShadowBitmap(), src.id);
    handler.fixed = true;
  };

  Movie.prototype.unfixGoalShadow = async function (handler) {
    if (!handler.fixed) return;
    await this._removeMember(DEEP_SHADOW);
    handler.fixed = false;
  };

  // ---------------------------------------------------------------- monster plans

  /* The game already handles plans for monsters ("plan,crab,5", "crab=3" in [inventory]): the plan
   * resolves through the whole config, the build check has a #monster branch, and building calls
   * createObject, which makes any "<class>.<name> parent". What's missing is the plan's icon, the
   * member "monster.<name>.plan" the plans bar shows. WB2 has one, for the lion: its left-facing
   * sprite. The fix adds the others the same way, shrunk to the size of the other plan icons.
   * The boulder isn't a buildable model (its recipe is nothing), so it gets none. */
  const PLAN_TEMPLATE = "building.marina.plan"; // a 32-bit plan icon to copy the member record from
  const PLAN_MAX_W = 54, PLAN_MAX_H = 40; // the largest plan icons in WB1 (freighter 53 wide, robot lab 40 high)
  const NO_PLAN = new Set(["generic", "boulder"]);

  // Monsters with a script (the ones a level, or a build, can create)
  function monsterNames(movie) {
    const out = [];
    for (const m of movie.members) {
      const mm = m.name && /^monster\.(\w+) parent$/.exec(m.name);
      if (mm && !NO_PLAN.has(mm[1])) out.push(mm[1]);
    }
    return [...new Set(out)].sort();
  }

  // The sideways sprite to make the icon from. Only monsters with their full artwork (a sideways and a
  // down-facing sprite) get plans: WB2's scorpion and T Rex have just a frame or two and aren't finished.
  function monsterPose(movie, n) {
    const has = (x) => movie.byName.has(x) && movie.byName.get(x).type === 1;
    if (![`monster.${n}.down`, `monster.${n}.down.walk.1`].some(has)) return null;
    return [`monster.${n}.left`, `monster.${n}.left.walk.1`, `monster.${n}.right`, `monster.${n}.right.walk.1`].find(has) || null;
  }

  /* A plan icon from a sprite {w, h, rgba} (white/alpha 0 = transparent): drops the one-pixel fringe
   * the map sprites have from being drawn against grass or water, crops, and shrinks it (by area
   * averaging) to fit maxW x maxH. Registration point in the middle, like the game's plan icons. */
  function planIcon(src, maxW = PLAN_MAX_W, maxH = PLAN_MAX_H) {
    const { w, h } = src;
    const px = new Uint8ClampedArray(src.rgba);
    const op = (x, y) => x >= 0 && y >= 0 && x < w && y < h && px[(y * w + x) * 4 + 3] > 0;
    const fringe = (r, g, b) => (g > 140 && g > r + 70 && g > b + 70) || (r < 70 && g > 160 && b > 200);
    const drop = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (!op(x, y)) continue;
      const o = (y * w + x) * 4;
      if ((!op(x - 1, y) || !op(x + 1, y) || !op(x, y - 1) || !op(x, y + 1)) && fringe(px[o], px[o + 1], px[o + 2])) drop.push(o);
    }
    for (const o of drop) px[o + 3] = 0;
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (op(x, y)) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    if (x1 < 0) return null;
    const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
    const k = Math.min(1, maxW / cw, maxH / ch);
    const tw = Math.max(1, Math.round(cw * k)), th = Math.max(1, Math.round(ch * k));
    const sx = cw / tw, sy = ch / th;
    const rgba = new Uint8ClampedArray(tw * th * 4);
    for (let ty = 0; ty < th; ty++) for (let tx = 0; tx < tw; tx++) {
      let cov = 0, r = 0, g = 0, b = 0;
      const fx0 = tx * sx, fx1 = fx0 + sx, fy0 = ty * sy, fy1 = fy0 + sy;
      for (let y = Math.floor(fy0); y < Math.ceil(fy1); y++) for (let x = Math.floor(fx0); x < Math.ceil(fx1); x++) {
        if (!op(x0 + x, y0 + y)) continue;
        const a = (Math.min(fx1, x + 1) - Math.max(fx0, x)) * (Math.min(fy1, y + 1) - Math.max(fy0, y));
        const o = ((y0 + y) * w + x0 + x) * 4;
        cov += a; r += px[o] * a; g += px[o + 1] * a; b += px[o + 2] * a;
      }
      const o = (ty * tw + tx) * 4;
      if (cov < 0.5 * sx * sy) continue; // stays transparent
      rgba[o] = Math.round(r / cov); rgba[o + 1] = Math.round(g / cov); rgba[o + 2] = Math.round(b / cov); rgba[o + 3] = 255;
      if (rgba[o] === 255 && rgba[o + 1] === 255 && rgba[o + 2] === 255) rgba[o + 2] = 254; // white would be see-through
    }
    return { w: tw, h: th, rgba, regX: Math.floor(tw / 2), regY: Math.ceil(th / 2) };
  }
  WB.planIcon = planIcon;

  // 32-bit BITD (planar rows: alpha, red, green, blue; transparent is white, like the game's plan icons)
  function bitd32(img) {
    const { w, h, rgba } = img;
    const pitch = 4 * w, d = new Uint8Array(pitch * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4, r = y * pitch;
      const see = rgba[o + 3] === 0;
      d[r + x] = 255;
      d[r + w + x] = see ? 255 : rgba[o];
      d[r + 2 * w + x] = see ? 255 : rgba[o + 1];
      d[r + 3 * w + x] = see ? 255 : rgba[o + 2];
    }
    return packbitsEncode(d, pitch);
  }

  // A copy of a 32-bit bitmap member's record, renamed and resized for `img`
  function bitmapCast(templateCast, name, img) {
    const out = castWithName(templateCast, name);
    const so = 12 + be32(out, 4);
    const dv = new DataView(out.buffer, out.byteOffset);
    dv.setUint16(so, 0x8000 | (4 * img.w));
    dv.setInt16(so + 2, 0); dv.setInt16(so + 4, 0); dv.setInt16(so + 6, img.h); dv.setInt16(so + 8, img.w);
    dv.setInt32(so + 14, 0);
    dv.setInt16(so + 18, img.regY); dv.setInt16(so + 20, img.regX);
    return out;
  }

  // The icon this version makes for a monster's plan, or null if it has no sprite to make it from
  Movie.prototype.monsterPlanIcon = async function (n) {
    const pose = monsterPose(this, n);
    const src = pose && (await this.bitmap(pose));
    return src ? planIcon(src) : null;
  };

  /* A built monster's health is the inverse of the energy brick it was built with. Units' health is
   * their energy (pInfo.energy: one 0-100 charge per energy brick in the recipe). A monster placed by
   * the level has none yet and gets full bricks; a built one gets the charges of the bricks used
   * (map_display.createObject's #energy). readmap calls init twice on a level's [mapitems] units,
   * and by the second call a placed monster has its full bricks, so the inverting only happens on a
   * monster's first init (pWandering is set at the end of init and never cleared).
   * monster.generic's init, after it sets the speed, gets:
   *   if voidp(pWandering) and ilk(me.pInfo[#energy]) = #list then
   *     speedScale = 1   -- init's only local, done with by then
   *     repeat while speedScale <= count(me.pInfo[#energy])
   *       me.pInfo[#energy][speedScale] = max(1, 100 - me.pInfo[#energy][speedScale])
   *       speedScale = speedScale + 1
   *     end repeat
   *   end if
   * so a nearly empty brick makes a healthy monster and a full one a nearly dead one (at least 1:
   * at 0 the game treats it as dead, standing still until something hits it). */
  const HEALTH_NAMES = ["pInfo", "energy", "count", "getAt", "setAt", "ilk", "list", "max", "voidp", "pWandering"];

  // Bytecode from [op, arg] / {label} / [jump op, label] items; arguments take 1 or 2 bytes as needed
  function lingo(items) {
    const BASE = { eq: 0x0f, nteq: 0x0e, and: 0x12, lteq: 0x0d, sub: 0x06, add: 0x05, not: 0x14, pushint8: 0x41, pusharglistnoret: 0x42,
      pusharglist: 0x43, pushsymb: 0x45, getprop: 0x4a, getparam: 0x4b, getlocal: 0x4c, setprop: 0x50, setlocal: 0x52,
      jmpifz: 0x55, endrepeat: 0x54, extcall: 0x57, getobjprop: 0x61, objcall: 0x67 };
    const JUMPS = new Set(["jmpifz", "endrepeat"]);
    const size = (it) => (it.label ? 0 : it.length === 1 ? 1 : JUMPS.has(it[0]) || it[1] > 0xff ? 3 : 2);
    const labels = {};
    let p = 0;
    for (const it of items) { if (it.label) labels[it.label] = p; p += size(it); }
    const out = [];
    for (const it of items) {
      if (it.label) continue;
      const b = BASE[it[0]];
      if (it.length === 1) { out.push(b); continue; }
      const here = out.length;
      const arg = it[0] === "jmpifz" ? labels[it[1]] - here : it[0] === "endrepeat" ? here - labels[it[1]] : it[1];
      if (size(it) === 3) out.push(b + 0x40, arg >> 8, arg & 0xff); else out.push(b, arg);
    }
    return new Uint8Array(out);
  }

  /* firstOnly false gives the patch's first version (which also inverted a placed monster's full
   * bricks on its second init), so a game that has it can be found and upgraded. */
  function healthCode(names, local, firstOnly = true) {
    const n = (x) => names.indexOf(x);
    const E = [["getparam", 0], ["getobjprop", n("pInfo")], ["pushsymb", n("energy")], ["pusharglist", 2], ["objcall", n("getAt")]];
    const first = firstOnly ? [["getprop", n("pWandering")], ["pusharglist", 1], ["extcall", n("voidp")], ["jmpifz", "end"]] : [];
    return lingo([
      ...first,
      ...E, ["pusharglist", 1], ["extcall", n("ilk")], ["pushsymb", n("list")], ["eq"], ["jmpifz", "end"],
      ["pushint8", 1], ["setlocal", local],
      { label: "loop" },
      ["getlocal", local], ...E, ["pusharglist", 1], ["extcall", n("count")], ["lteq"], ["jmpifz", "end"],
      ...E, ["getlocal", local],
      ["pushint8", 1], ["pushint8", 100], ...E, ["getlocal", local], ["pusharglist", 2], ["objcall", n("getAt")], ["sub"],
      ["pusharglist", 2], ["extcall", n("max")],
      ["pusharglistnoret", 3], ["objcall", n("setAt")],
      ["getlocal", local], ["pushint8", 1], ["add"], ["setlocal", local],
      ["endrepeat", "loop"],
      { label: "end" },
    ]);
  }

  // [{id, rec, code, at, template, fixed}]: monster.generic's init, when it has the expected shape
  Movie.prototype.findMonsterHealth = async function () {
    const h = await this._findMonsterHealth();
    return h ? [h] : [];
  };

  Movie.prototype.fixMonsterHealth = async function (handler) {
    if (handler.fixed) return;
    if (handler.old) await this.unfixMonsterHealth(handler);
    const code = insertCode(handler.code, handler.at, handler.template);
    await this.replaceHandlerCode(handler.id, handler.rec, code);
    handler.code = code;
    handler.fixed = true;
  };

  Movie.prototype.unfixMonsterHealth = async function (handler) {
    const t = handler.fixed ? handler.template : handler.old;
    if (!t) return;
    const code = cutCode(handler.code, handler.at, handler.at + t.length);
    await this.replaceHandlerCode(handler.id, handler.rec, code);
    handler.code = code;
    handler.fixed = false;
    handler.old = null;
  };

  /* monster.generic's init (the script with "wander"), where its speed is set: {id, rec, code, at,
   * template, fixed} */
  Movie.prototype._findMonsterHealth = async function () {
    const scripts = new Set();
    const all = [];
    for await (const h of this.handlers()) { all.push(h); if (h.name === "wander") scripts.add(h.id); }
    for (const h of all) {
      if (h.name !== "init" || !scripts.has(h.id) || HEALTH_NAMES.some((x) => h.names.indexOf(x) < 0)) continue;
      const ins = decode(h.code);
      // starts "speedScale = (80 + random(40)) / 100.0", then me.pBuild.speed = ...
      const first = ins.findIndex((i) => i.op === 0x52); // setlocal
      const set = ins.findIndex((i) => i.op === 0x62); // setobjprop
      if (ins[0].op !== OP.pushint8 || ins[0].arg !== 80 || first < 0 || set < 0) continue;
      const at = ins[set].p + ins[set].len;
      const template = healthCode(h.names, ins[first].arg), oldTemplate = healthCode(h.names, ins[first].arg, false);
      const has = (t) => h.code.length >= at + t.length && t.every((b, i) => h.code[at + i] === b);
      const fixed = has(template);
      // an older version of the patch counts as not installed; fixing swaps it for this one
      return { ...h, at, template, fixed, old: !fixed && has(oldTemplate) ? oldTemplate : null, monsterHealth: true };
    }
    return null;
  };

  /* [{fixed, monsterPlans, targets: [{name, member, icon, bitd}]}]: the monsters that get a plan icon.
   * A monster whose icon came with the game (WB2's lion) is left alone. */
  Movie.prototype.findMonsterPlans = async function () {
    if (!this.byName.has(PLAN_TEMPLATE)) return [];
    const targets = [];
    for (const n of monsterNames(this)) {
      const icon = await this.monsterPlanIcon(n);
      if (!icon) continue;
      const member = `monster.${n}.plan`, bitd = bitd32(icon);
      if (this.byName.has(member) && !(await this._memberHasBitmap(member, bitd))) continue;
      targets.push({ name: n, member, icon, bitd });
    }
    if (!targets.length) return [];
    let fixed = true;
    for (const t of targets) if (!(await this._memberIsCurrent(t.member, t.bitd))) fixed = false;
    return [{ fixed, monsterPlans: true, targets }];
  };

  Movie.prototype.fixMonsterPlans = async function (handler) {
    if (handler.fixed) return;
    const tpl = this.byName.get(PLAN_TEMPLATE);
    const tplCast = await this.data(tpl.id);
    for (const t of handler.targets) {
      await this._removeMember(t.member);
      await this._addMember(bitmapCast(tplCast, t.member, t.icon), t.bitd, tpl.id);
    }
    handler.fixed = true;
  };

  Movie.prototype.unfixMonsterPlans = async function (handler) {
    for (const t of handler.targets) await this._removeMember(t.member);
    handler.fixed = false;
  };

  /* Put "jmp <to>" in front of code[at]: jumps that crossed `at` get 3 longer, ones that landed on
   * `at` now land on the jmp. */
  function jumpInFront(old, at, to) {
    const code = new Uint8Array(old.length + 3);
    code.set(old.subarray(0, at));
    const rel = to + 3 - at;
    code.set([0x93, rel >> 8, rel & 0xff], at);
    code.set(old.subarray(at), at + 3);
    for (const i of decode(old)) {
      if (i.op !== OP.jmp && i.op !== OP.jmpifz && i.op !== OP.endrepeat) continue;
      const t = i.op === OP.endrepeat ? i.p - i.arg : i.p + i.arg;
      const nf = i.p < at ? i.p : i.p + 3, nt = t <= at ? t : t + 3;
      const arg = Math.abs(nt - nf);
      if (arg !== i.arg) setArg(code, { ...i, p: nf }, arg);
    }
    return code;
  }

  // In-game music tracks: the music_game_<x> members SndMusicStart can play
  Movie.prototype.musicTracks = function () {
    return [...this.byName.keys()].filter((n) => /^music_game_\w+$/.test(n)).sort();
  };

  // ---------------------------------------------------------------- game knowledge

  const WB1_TERRAIN = {
    ".": "normal", T: "tree", w: "water", M: "mountain", _: "normal_undiggable", x: "water_undiggable",
    r: "water_reefs", "@": "hole", "~": "billboard", "#": "swamp", "^": "volcano",
  };

  const TERRAIN_LABELS = {
    normal: "Grass", tree: "Tree", water: "Water", mountain: "Mountain", normal_undiggable: "Rocky ground (can't dig)",
    water_undiggable: "Deep water (can't fill)", water_reefs: "Reefs", hole: "Hole (edge of world)",
    billboard: "Spacebar billboard", swamp: "Swamp", volcano: "Volcano (same as Mountain, no minimap icon)", goal: "Capture zone (collect goals)",
    cement: "Cement", roadblock: "Road block", street1: "Street 1", street2: "Street 2", street3: "Street 3",
    street4: "Street 4", street5: "Street 5", street6: "Street 6", street7: "Street 7", street8: "Street 8",
    street9: "Street 9", street10: "Street 10", street_undiggable: "Street (can't dig)", tree2: "Cypress",
    tree3: "Little pine", tree4: "Palm tree", jungle1: "Flowery plant", jungle2: "Lumpy root",
    jungle3: "Cauliflowers", jungle4: "Rocks and flowers",
  };
  WB.TERRAIN_LABELS = TERRAIN_LABELS;

  // Where units can stand, from the games' walkthroughs (config only lists some of them)
  const UNIT_TERRAIN = {
    fish: ["water", "water_undiggable"], tugboat: ["water", "water_undiggable"], speedboat: ["water", "water_undiggable"],
    freighter: ["water", "water_undiggable"], marina: ["water"], shark: ["water", "water_undiggable"],
    water_crab: ["water", "water_undiggable"], duck: ["normal", "water"], frog: ["normal", "water"], gator: ["normal", "water"],
  };

  const WATERY = new Set(["water", "water_undiggable", "water_reefs", "water_whirlpool"]);
  WB.isWaterTerrain = (t) => WATERY.has(t);

  // Which terrain a unit can use (from its config, else the walkthroughs' list)
  function unitTerrains(game, cls, name) {
    const cfg = game.config[cls] && game.config[cls][name];
    if (cfg && Array.isArray(cfg.terrain)) return cfg.terrain;
    return UNIT_TERRAIN[name] || ["normal"];
  }
  // Can this unit be placed on water (true) or on land (false)?
  WB.unitCanUse = (game, cls, name, water) =>
    unitTerrains(game, cls, name).some((t) => WATERY.has(t) === water);
  WB.unitTerrains = unitTerrains;

  function parseLingoList(src, i) {
    // returns [value, nextIndex]; supports [..] lists/proplists, #symbols, numbers, "strings"
    const ws = () => { while (i < src.length && /[\s]/.test(src[i])) i++; };
    ws();
    if (src[i] === "[") {
      i++;
      const list = [], props = {};
      let isProp = false;
      ws();
      if (src[i] === ":") { i++; ws(); }
      while (i < src.length && src[i] !== "]") {
        let [v, j] = parseLingoList(src, i);
        i = j;
        ws();
        if (src[i] === ":") {
          isProp = true;
          let [v2, k] = parseLingoList(src, i + 1);
          props[String(v)] = v2;
          i = k;
        } else list.push(v);
        ws();
        if (src[i] === ",") i++;
        ws();
      }
      return [isProp ? props : list, i + 1];
    }
    if (src[i] === '"') {
      const j = src.indexOf('"', i + 1);
      return [src.slice(i + 1, j), j + 1];
    }
    const m = /^#?[\w.\-]+/.exec(src.slice(i));
    if (!m) return [null, i + 1];
    const tok = m[0];
    return [tok.startsWith("#") ? tok.slice(1) : isNaN(+tok) ? tok : +tok, i + tok.length];
  }

  /* Read the game's own data: terrain table, units/buildings config, levels, worlds. */
  Movie.prototype.loadGame = async function () {
    const g = { terrain: {}, config: { building: {}, vehicle: {}, monster: {} }, levels: [] };
    const tm = await this.text("terrainmap");
    g.edition = tm ? 2 : 1;
    if (tm) {
      for (const line of tm.split("\n")) {
        if (line.length >= 3) g.terrain[line[0]] = line.slice(2).trim();
      }
    } else g.terrain = { ...WB1_TERRAIN };

    const cfg = (await this.text("config")) || "";
    let sec = null;
    const lines = cfg.split("\n");
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li].trim();
      const s = /^\[(\w+)\]$/.exec(line);
      if (s) { sec = s[1]; continue; }
      const m = /^#(\w+)\s*=\s*\[/.exec(line);
      if (!m || !sec) continue;
      let src = line.slice(line.indexOf("["));
      let depth = 0;
      const balanced = (t) => { depth = 0; for (const c of t) depth += c === "[" ? 1 : c === "]" ? -1 : 0; return depth <= 0; };
      while (!balanced(src) && li + 1 < lines.length) src += " " + lines[++li].trim();
      try {
        const [v] = parseLingoList(src.replace(/\s*\]\s*\]\s*$/, "]]"), 0);
        (g.config[sec] = g.config[sec] || {})[m[1]] = v;
      } catch (e) { /* ignore malformed entries */ }
    }

    const names = this.members.map((m) => m.name).filter((n) => n && /^map\d+\.\d+$/.test(n));
    const seen = new Set();
    for (const n of names) {
      if (seen.has(n)) continue;
      seen.add(n);
      const [w, l] = n.slice(3).split(".").map(Number);
      g.levels.push({ member: n, world: w, mission: l });
    }
    g.levels.sort((a, b) => a.world - b.world || a.mission - b.mission);
    // titles shown on the world map live in a separate "level names" member: "world mission title"
    g.titles = new Map();
    for (const line of ((await this.text("level names")) || "").split("\n")) {
      const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      if (m) g.titles.set(`${+m[1]} ${+m[2]}`, m[3].trim());
    }
    for (const lv of g.levels) {
      lv.missionTitle = g.titles.get(`${lv.world} ${lv.mission}`) || "";
      lv.text = await this.text(lv.member);
      const nm = /^\s*name\s*=\s*(.*)$/m.exec(lv.text || "");
      lv.title = nm ? nm[1].trim() : "";
    }
    // monsters and animals appear only in maps; collect every unit name the levels use
    const units = { vehicle: new Set(), monster: new Set(), building: new Set() };
    for (const lv of g.levels) {
      for (const m of (lv.text || "").matchAll(/^\s*\S\s*=\s*(?:water)?unit\s*,\s*(\w+)\s*,\s*(\w+)/gm)) {
        (units[m[1]] = units[m[1]] || new Set()).add(m[2]);
      }
    }
    for (const k of Object.keys(g.config)) for (const n of Object.keys(g.config[k] || {})) (units[k] = units[k] || new Set()).add(n);
    for (const m of this.members) {
      const mm = m.name && /^(monster|vehicle|building)\.([A-Za-z_0-9]+)\./.exec(m.name);
      if (mm && m.type === 1) units[mm[1]].add(mm[2] === "repairBot" ? "repairbot" : mm[2]);
    }
    g.units = Object.fromEntries(Object.entries(units).map(([k, v]) => [k, [...v].sort()]));
    // Units the game can actually create: readmap needs a "<class>.<name> parent" script, and the
    // unit needs its own artwork (defender2/defender3 are only listed in config and break the level).
    const lower = this.members.filter((m) => m.name).map((m) => ({ n: m.name.toLowerCase(), t: m.type }));
    const scripts = new Set(lower.filter((m) => m.n.endsWith(" parent")).map((m) => m.n));
    g.placeable = {};
    for (const [cls, list] of Object.entries(g.units)) {
      g.placeable[cls] = new Set(list.filter((n) =>
        scripts.has(`${cls}.${n} parent`) &&
        lower.some((m) => m.t === 1 && (m.n === `${cls}.${n}` || m.n.startsWith(`${cls}.${n}.`)))));
    }
    g.musicTracks = this.musicTracks();
    // terrains a goal can stand on: the ones with a "goal.shadow.<terrain>" member to draw under it
    g.goalShadows = new Set(this.members.map((m) => m.name && /^goal\.shadow\.(.+)$/.exec(m.name)).filter(Boolean).map((m) => m[1]));
    // models a plan can be for: the ones with a "<class>.<name>.plan" icon for the plans bar
    g.planIcons = new Set(this.members.filter((m) => m.type === 1).map((m) => m.name && /^(?:vehicle|building|monster)\.(\w+)\.plan$/.exec(m.name)).filter(Boolean).map((m) => m[1].toLowerCase()));
    g.resources = ["red", "yellow", "blue", "green", "white", "wheel", "energy"].filter(
      (r) => this.byName.has(`resource.${r}`) || this.byName.has(`resource.${r}.1`)
    );
    return g;
  };

  // ---------------------------------------------------------------- level text <-> model

  /* Mirror of the game's parseParams: whole-line "--" comments, "[section]" headers,
   * comma-separated "key=value,more,values". */
  function parseLevel(text, terrain) {
    const lv = { name: "", center: null, rows: [], items: [], inventory: [], mapExtra: [], other: [], problems: [] };
    let sec = null;
    for (const raw of text.split(/\r\n?|\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("--")) continue;
      const s = /^\[(.*)\]$/.exec(line);
      if (s) { sec = s[1]; if (!["map", "mapitems", "inventory"].includes(sec)) lv.other.push(line); continue; }
      const eq = line.indexOf("=");
      const key = eq > 0 ? line.slice(0, eq).trim() : null;
      const val = eq > 0 ? line.slice(eq + 1).trim() : line;
      if (sec === "map") {
        if (key === "map") lv.rows.push(val);
        else if (key === "name") lv.name = val;
        else if (key === "center") lv.center = val.split(",").map((v) => parseInt(v, 10));
        else lv.mapExtra.push(line);
      } else if (sec === "mapitems") {
        if (key) lv.items.push({ key, parts: val.split(",").map((p) => p.trim()) });
      } else if (sec === "inventory") {
        if (key) lv.inventory.push({ name: key, count: parseInt(val, 10) || 0 });
      } else lv.other.push(line);
    }
    // grid of {t: terrain char, item: item index or -1}
    const w = Math.max(0, ...lv.rows.map((r) => r.length));
    // item keys are Lingo symbols, so "p" on the map finds a "P=" definition
    const itemByKey = new Map(lv.items.map((it, i) => [it.key.toLowerCase(), i]));
    lv.grid = lv.rows.map((row) => {
      const out = [];
      for (let i = 0; i < w; i++) {
        const c = row[i] ?? ".";
        if (terrain[c] != null) out.push({ t: c, item: -1 });
        else if (itemByKey.has(c.toLowerCase())) {
          const idx = itemByKey.get(c.toLowerCase());
          const parts = lv.items[idx].parts;
          const t = Object.keys(terrain).find((k) => terrain[k] === itemTerrain(parts));
          out.push({ t: t ?? (itemIsWater(parts) ? "w" : "."), item: idx });
        } else {
          // not terrain and not defined: kept as-is (WB1 has legacy shortcuts like "C" for a crab)
          out.push({ t: c, item: -1 });
        }
      }
      return out;
    });
    delete lv.rows;
    return lv;
  }

  function itemIsWater(parts) {
    const k = parts[0];
    if (k === "waterunit" || k === "waterplan" || k === "waterpile" || k === "whirlpool") return true;
    if ((k === "goal" || k === "bonusgoal") && parts[2] === "water") return true;
    return false;
  }
  WB.itemIsWater = itemIsWater;

  /* The terrain an object stands on: goals keep any terrain in their third field, water units and
   * plans an optional fourth (deep water, with the readmap fix), the other water versions plain water. */
  function itemTerrain(parts) {
    const k = parts[0];
    if (k === "goal" || k === "bonusgoal") return parts[2] || "normal";
    if (k === "waterunit" || k === "waterplan") return parts[3] || "water";
    return itemIsWater(parts) ? "water" : "normal";
  }
  WB.itemTerrain = itemTerrain;

  /* Item key characters: not a terrain char, unique ignoring case (Lingo symbols are case-insensitive). */
  // The game looks item keys up ignoring case ("B" finds "b"), so only one case of each letter
  function keyPool(terrain) {
    const out = [];
    for (const c of "abcdefghijklmnopqrstuvwxyz0123456789") {
      if (terrain[c] == null) out.push(c);
    }
    return out;
  }

  function serializeLevel(lv, terrain) {
    // collapse identical item definitions that are in use, keeping original keys when possible
    const used = new Map(); // canonical -> {key, parts}
    const cellKey = new Map(); // item index -> canonical
    for (const row of lv.grid) for (const c of row) {
      if (c.item < 0) continue;
      const it = lv.items[c.item];
      const canon = it.parts.join(",");
      cellKey.set(c.item, canon);
      if (!used.has(canon)) used.set(canon, { key: it.key, parts: it.parts });
    }
    const taken = new Set();
    const ok = (k) => k && k.length === 1 && terrain[k] == null && !taken.has(k.toLowerCase()) && /[A-Za-z0-9]/.test(k);
    const pending = [];
    for (const d of used.values()) {
      if (ok(d.key)) taken.add(d.key.toLowerCase());
      else pending.push(d);
    }
    const pool = keyPool(terrain);
    for (const d of pending) {
      const k = pool.find((c) => !taken.has(c.toLowerCase()));
      if (!k) throw new Error("Too many different objects on one map (ran out of key characters)");
      d.key = k;
      taken.add(k.toLowerCase());
    }
    const rows = lv.grid.map((row) => row.map((c) => (c.item >= 0 ? used.get(cellKey.get(c.item)).key : c.t)).join(""));

    const L = ["[map]"];
    if (lv.name) L.push("name=" + lv.name);
    for (const x of lv.mapExtra) L.push(x);
    L.push("");
    for (const r of rows) L.push(" map=" + r);
    L.push("");
    if (lv.center) L.push(`center=${lv.center[0]},${lv.center[1]}`);
    L.push("", "[mapitems]");
    const defs = [...used.values()].sort((a, b) => a.key.localeCompare(b.key));
    for (const d of defs) L.push(`${d.key}=${d.parts.join(",")}`);
    L.push("", "[inventory]");
    for (const inv of lv.inventory) L.push(`${inv.name}=${inv.count}`);
    if (lv.other.length) L.push("", ...lv.other);
    L.push("");
    return L.join("\n");
  }

  // A plan whose model has no plans-bar icon: the game stops with a script error when it's picked up
  function planIconError(game, name, what) {
    const monster = game.config && game.config.monster && name in game.config.monster && name !== "boulder";
    return monster
      ? `${what} for ${name} needs the "Monster plans" game patch (Game tab).`
      : `${what} for ${name} has no plan icon in this game, which causes a script error; pick another model.`;
  }

  /* Problems the game would choke on, plus gameplay sanity checks. */
  function validateLevel(lv, game) {
    const errs = [], warns = [];
    const terrain = game.terrain;
    const h = lv.grid.length, w = h ? lv.grid[0].length : 0;
    if (h < 2) errs.push("The map needs at least 2 rows.");
    if (w < 2) errs.push("The map needs at least 2 columns.");
    if (/,/.test(lv.name)) errs.push("Mission name can't contain commas.");
    const used = new Set();
    for (const row of lv.grid) for (const c of row) if (c.item >= 0) used.add(c.item);
    let goals = 0, bonus = 0, captureTiles = 0, collect = false;
    const whirl = new Map();
    lv.grid.forEach((row, y) => row.forEach((c, x) => {
      if (terrain[c.t] === "goal") captureTiles++;
      if (c.item < 0) return;
      const p = lv.items[c.item].parts;
      const at = `(${x + 1},${y + 1})`;
      if (p[0] === "goal") { goals++; if (/^collect\b/.test(p[1] || "")) collect = true; }
      if (p[0] === "bonusgoal") { bonus++; if (/^collect\b/.test(p[1] || "")) collect = true; }
      if ((p[0] === "goal" || p[0] === "bonusgoal") && game.goalShadows && !game.goalShadows.has(itemTerrain(p))) {
        const t = itemTerrain(p);
        errs.push(t === "water_undiggable"
          ? `The ${p[0] === "goal" ? "goal" : "bonus goal"} at ${at} is on deep water, which needs the "Deep water" game patch (Game tab).`
          : `The ${p[0] === "goal" ? "goal" : "bonus goal"} at ${at} is on ${t}, which the game has no goal shadow for (script error); use ${[...game.goalShadows].join(" or ")}.`);
      }
      if ((p[0] === "plan" || p[0] === "waterplan") && game.planIcons && !game.planIcons.has((p[1] || "").toLowerCase()))
        errs.push(planIconError(game, p[1], `The plan at ${at}`));
      if (p[0] === "whirlpool") whirl.set(p[1], (whirl.get(p[1]) || 0) + 1);
      if (p[0] === "unit" || p[0] === "waterunit") {
        if (game.placeable && !(game.placeable[p[1]] && game.placeable[p[1]].has(p[2]))) {
          errs.push(`${p[2]} at ${at} isn't finished in this game (no script or artwork) and causes a script error; remove it.`);
          return;
        }
        const onWater = p[0] === "waterunit";
        const ts = unitTerrains(game, p[1], p[2]);
        if (!WB.unitCanUse(game, p[1], p[2], onWater))
          warns.push(`${p[2]} at ${at} is placed on ${onWater ? "water" : "land"} but can only use: ${ts.join(", ")}.`);
        else if (onWater && p[3] && !ts.includes(p[3]))
          warns.push(`${p[2]} at ${at} is placed on ${p[3]} but can only use: ${ts.join(", ")}.`);
      }
    }));
    if (game.planIcons) for (const inv of lv.inventory) if (!game.planIcons.has(inv.name.toLowerCase())) errs.push(planIconError(game, inv.name, "The starting plan"));
    if (goals === 0) errs.push("The map has no mission goal.");
    if (collect && captureTiles === 0) warns.push('A "collect" goal needs capture-zone tiles (":") to deliver to.');
    for (const [id, n] of whirl) if (n !== 2) warns.push(`Whirlpool ${id} appears ${n} time${n === 1 ? "" : "s"}; whirlpools work in pairs.`);
    const music = lv.mapExtra.map((l) => /^music\s*=\s*(.*)$/i.exec(l)).find(Boolean);
    if (music && game.musicTracks && !game.musicTracks.includes(music[1].trim()))
      warns.push(`The music "${music[1].trim()}" isn't one of this game's tracks.`);
    if (lv.center && (lv.center[0] > w || lv.center[1] > h)) warns.push("The start position is outside the map.");
    if (used.size > keyPool(terrain).length) errs.push("Too many different object types on this map.");
    // the game converts number-like values, which would break a map row
    try {
      const txt = serializeLevel(lv, terrain);
      for (const m of txt.matchAll(/^ map=(.*)$/gm)) {
        if (/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(m[1])) errs.push(`Row "${m[1]}" looks like a number to the game; change a tile in it.`);
      }
    } catch (e) { errs.push(e.message); }
    return { errs, warns };
  }

  WB.parseLevel = parseLevel;
  WB.serializeLevel = serializeLevel;
  WB.validateLevel = validateLevel;
  WB.keyPool = keyPool;

  if (typeof module !== "undefined" && module.exports) module.exports = WB;
  else root.WB = WB;
})(typeof self !== "undefined" ? self : this);
