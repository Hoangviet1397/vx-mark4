// VX 3D: draws the speaker from its CAD parts (img/lento.bin, packed by
// tools/pack3d.py from the Fusion export) with plain WebGL, no library.
//   const m = await VX3D.load('img/lento.bin');
//   const v = new VX3D.View(canvas, m, { parts: { body: '#f1efe9', ... } });
//   v.set({ speakers: [{ x: -1, yaw: 9 }, { x: 1, yaw: -9 }], pitch: -12, spin: 0 });
// Units are mm, Y up, the front of the baffle at z = 0, the back at z < 0.
// Lit like a product shot: a soft key from the upper left, a cool fill, a
// rim from behind, a sky/ground ambient and a soft contact shadow.
(function () {
  'use strict';

  async function load(url) {
    const buf = await (await fetch(url)).arrayBuffer();
    const dv = new DataView(buf);
    if (String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3)) !== 'VX3D') throw new Error('not a VX3D file');
    const hl = dv.getUint32(4, true);
    const head = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, hl)));
    const base = 8 + hl, parts = {};
    let lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
    for (const p of head.parts) {
      const q = new Int16Array(buf, base + p.pos, p.nv * 3);
      const pos = new Float32Array(p.nv * 3);
      for (let i = 0; i < q.length; i++) {
        const v = pos[i] = q[i] * head.unit, a = i % 3;
        if (v < lo[a]) lo[a] = v; if (v > hi[a]) hi[a] = v;
      }
      const idx = p.wide ? new Uint32Array(buf, base + p.idx, p.nt * 3) : new Uint16Array(buf, base + p.idx, p.nt * 3);
      parts[p.name] = creased(pos, idx, 32);
    }
    return { parts, lo, hi };
  }

  // non-indexed triangles with "creased" normals: smooth across gentle
  // curves (the rounded edges), sharp where faces meet at > angle degrees
  function creased(pos, idx, angle) {
    const nt = idx.length / 3, fn = new Float32Array(nt * 3), cosA = Math.cos(angle * Math.PI / 180);
    const inc = new Map();
    for (let t = 0; t < nt; t++) {
      const a = idx[3 * t] * 3, b = idx[3 * t + 1] * 3, c = idx[3 * t + 2] * 3;
      const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
      const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
      fn[3 * t] = uy * vz - uz * vy; fn[3 * t + 1] = uz * vx - ux * vz; fn[3 * t + 2] = ux * vy - uy * vx;   // area weighted
      for (let k = 0; k < 3; k++) { const v = idx[3 * t + k]; let l = inc.get(v); if (!l) inc.set(v, l = []); l.push(t); }
    }
    const P = new Float32Array(nt * 9), N = new Float32Array(nt * 9);
    const unit = t => { const x = fn[3 * t], y = fn[3 * t + 1], z = fn[3 * t + 2], l = Math.hypot(x, y, z) || 1; return [x / l, y / l, z / l]; };
    for (let t = 0; t < nt; t++) {
      const me = unit(t);
      for (let k = 0; k < 3; k++) {
        const v = idx[3 * t + k], o = 9 * t + 3 * k;
        P[o] = pos[3 * v]; P[o + 1] = pos[3 * v + 1]; P[o + 2] = pos[3 * v + 2];
        let x = 0, y = 0, z = 0;
        for (const g of inc.get(v)) {
          const u = unit(g);
          if (u[0] * me[0] + u[1] * me[1] + u[2] * me[2] >= cosA) { x += fn[3 * g]; y += fn[3 * g + 1]; z += fn[3 * g + 2]; }
        }
        const l = Math.hypot(x, y, z) || 1;
        N[o] = x / l; N[o + 1] = y / l; N[o + 2] = z / l;
      }
    }
    return { P, N, n: nt * 3 };
  }

  const VS = `attribute vec3 p; attribute vec3 n; uniform mat4 M, VP; varying vec3 wn; varying vec3 wp;
    void main() { vec4 w = M * vec4(p, 1.0); wp = w.xyz; wn = mat3(M) * n; gl_Position = VP * w; }`;
  const FS = `precision mediump float; varying vec3 wn; varying vec3 wp;
    uniform vec3 col, eye; uniform float gloss, dim;
    void main() {
      vec3 N = normalize(wn); vec3 V = normalize(eye - wp);
      if (dot(N, V) < 0.0) N = -N;
      vec3 key = normalize(vec3(-0.55, 0.75, 0.55)), fill = normalize(vec3(0.7, 0.25, 0.6)), rim = normalize(vec3(0.2, 0.5, -0.9));
      float k = max(dot(N, key), 0.0), f = max(dot(N, fill), 0.0), r = max(dot(N, rim), 0.0);
      float hemi = 0.5 + 0.5 * N.y;
      vec3 amb = mix(vec3(0.42, 0.38, 0.34), vec3(0.78, 0.80, 0.84), hemi);
      vec3 c = col * (amb * 0.55 + vec3(1.0, 0.97, 0.92) * k * 0.78 + vec3(0.80, 0.86, 0.95) * f * 0.22);
      vec3 H = normalize(key + V);
      c += vec3(1.0) * pow(max(dot(N, H), 0.0), 38.0) * gloss;
      c += vec3(1.0) * pow(r, 3.0) * 0.12;
      gl_FragColor = vec4(pow(c, vec3(1.0 / 2.2)) * dim, 1.0);
    }`;
  // soft contact shadow: a quad on the floor, alpha from the distance to the footprint
  const SVS = `attribute vec2 q; uniform mat4 M, VP; uniform vec2 hs; varying vec2 uv;
    void main() { uv = q; vec4 w = M * vec4(q.x * (hs.x + 40.0), 0.0, q.y * (hs.y + 40.0), 1.0); gl_Position = VP * w; }`;
  const SFS = `precision highp float; varying vec2 uv; uniform vec2 hs; uniform float dark;
    void main() {
      vec2 d = abs(uv) * (hs + 40.0) - hs; float o = length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
      float a = o < 0.0 ? 1.0 : exp(-o * o / 260.0) * 0.55 + exp(-o / 9.0) * 0.45;
      gl_FragColor = vec4(0.0, 0.0, 0.0, a * dark);
    }`;

  function mat() { return new Float32Array(16); }
  function mul(a, b) { const o = mat(); for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + j] * b[i * 4 + k]; o[i * 4 + j] = s; } return o; }
  function persp(fov, asp, n, f) { const t = 1 / Math.tan(fov / 2), o = mat(); o[0] = t / asp; o[5] = t; o[10] = (f + n) / (n - f); o[11] = -1; o[14] = 2 * f * n / (n - f); return o; }
  function lookAt(e, c) {
    let zx = e[0] - c[0], zy = e[1] - c[1], zz = e[2] - c[2], l = Math.hypot(zx, zy, zz); zx /= l; zy /= l; zz /= l;
    let xx = zz, xy = 0, xz = -zx; l = Math.hypot(xx, xz); xx /= l; xz /= l;
    const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx, o = mat();
    o[0] = xx; o[4] = xy; o[8] = xz; o[1] = yx; o[5] = yy; o[9] = yz; o[2] = zx; o[6] = zy; o[10] = zz;
    o[12] = -(xx * e[0] + xy * e[1] + xz * e[2]); o[13] = -(yx * e[0] + yy * e[1] + yz * e[2]); o[14] = -(zx * e[0] + zy * e[1] + zz * e[2]); o[15] = 1;
    return o;
  }
  function model(x, z, yaw, cx, cz) {   // translate(x,0,z) * rotY(yaw) * translate(-cx,0,-cz)
    const c = Math.cos(yaw), s = Math.sin(yaw), o = mat();
    o[0] = c; o[2] = -s; o[5] = 1; o[8] = s; o[10] = c; o[15] = 1;
    o[12] = x - (c * cx + s * cz); o[13] = 0; o[14] = z - (-s * cx + c * cz);
    return o;
  }
  const hex = h => { const v = parseInt(h.slice(1), 16); return [(v >> 16 & 255) / 255, (v >> 8 & 255) / 255, (v & 255) / 255].map(c => Math.pow(c, 2.2) * 1.0); };

  class View {
    constructor(canvas, m, opts) {
      this.c = canvas; this.m = m; this.o = Object.assign({ parts: {}, gloss: {}, fov: 26 }, opts || {});
      const gl = this.gl = canvas.getContext('webgl', { antialias: true, alpha: true, premultipliedAlpha: true });
      if (!gl) throw new Error('no webgl');
      const prog = (vs, fs) => {
        const p = gl.createProgram();
        for (const [t, s] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
          const sh = gl.createShader(t); gl.shaderSource(sh, s); gl.compileShader(sh);
          if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
          gl.attachShader(p, sh);
        }
        gl.linkProgram(p); return p;
      };
      this.p = prog(VS, FS); this.sp = prog(SVS, SFS);
      this.buf = {};
      for (const [k, part] of Object.entries(m.parts)) {
        const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b);
        const inter = new Float32Array(part.n * 6);
        for (let i = 0; i < part.n; i++) { inter.set(part.P.subarray(3 * i, 3 * i + 3), 6 * i); inter.set(part.N.subarray(3 * i, 3 * i + 3), 6 * i + 3); }
        gl.bufferData(gl.ARRAY_BUFFER, inter, gl.STATIC_DRAW); this.buf[k] = { b, n: part.n };
      }
      this.q = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, this.q);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      this.state = { speakers: [{ x: 0, yaw: 0, dim: 1 }], pitch: -12, spin: 0, shadow: .5 };
      const lo = m.lo, hi = m.hi;
      this.cx = (lo[0] + hi[0]) / 2; this.cz = (lo[2] + hi[2]) / 2; this.floor = lo[1];
      this.size = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
    }
    set(s) { Object.assign(this.state, s); this.draw(); }
    colors(parts) { Object.assign(this.o.parts, parts); this.draw(); }
    draw() {
      const gl = this.gl, c = this.c, dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = Math.round(c.clientWidth * dpr), h = Math.round(c.clientHeight * dpr);
      if (!w || !h) return;
      if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
      gl.viewport(0, 0, w, h); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      const st = this.state, [W, H, D] = this.size, n = st.speakers.length;
      const fov = this.o.fov * Math.PI / 180, asp = w / h, pit = st.pitch * Math.PI / 180;
      const step = W * (1 + (st.gap || 0.9));
      // frame: measured, not guessed. Project the box corners (over the whole
      // range the speakers can turn to) and move the camera until they fill
      // the canvas with a little air. Cached per layout so dragging never zooms.
      const key = [n, w, h, st.fitPitch == null ? st.pitch : st.fitPitch, st.gap].join('|');
      if (this.fitKey !== key) {
        const fp = (st.fitPitch == null ? st.pitch : st.fitPitch) * Math.PI / 180;
        const pts = [];
        for (let i = 0; i < n; i++) for (let a = -40; a <= 40; a += 8) {
          const c = Math.cos(a * Math.PI / 180), s = Math.sin(a * Math.PI / 180), xi = (i - (n - 1) / 2) * step;
          for (const dx of [-W / 2, W / 2]) for (const dz of [-D / 2, D / 2]) for (const y of [this.floor, this.floor + H])
            pts.push([xi + c * dx + s * dz, y, -s * dx + c * dz]);
        }
        let dist = (H / 2) / Math.tan(fov / 2) * 1.3 + D, cy = this.floor + H / 2;
        for (let it = 0; it < 8; it++) {
          const eye = [0, cy - Math.sin(fp) * dist, Math.cos(fp) * dist];
          const VP = mul(persp(fov, asp, dist * 0.1, dist * 4), lookAt(eye, [0, cy, 0]));
          let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
          for (const [x, y, z] of pts) {
            const cw = VP[3] * x + VP[7] * y + VP[11] * z + VP[15];
            const px = (VP[0] * x + VP[4] * y + VP[8] * z + VP[12]) / cw, py = (VP[1] * x + VP[5] * y + VP[9] * z + VP[13]) / cw;
            x0 = Math.min(x0, px); x1 = Math.max(x1, px); y0 = Math.min(y0, py); y1 = Math.max(y1, py);
          }
          const k = Math.max((x1 - x0) / 1.84, (y1 - y0) / 1.80);
          cy += (y0 + y1) / 2 * dist * Math.tan(fov / 2);
          dist *= k;
        }
        this.fitKey = key; this.fit = { dist, cy };
      }
      const { dist, cy } = this.fit;
      const eye = [0, cy - Math.sin(pit) * dist, Math.cos(pit) * dist];
      const VP = mul(persp(fov, asp, dist * 0.1, dist * 4), lookAt(eye, [0, cy, 0]));
      gl.enable(gl.DEPTH_TEST); gl.disable(gl.BLEND);
      gl.useProgram(this.p);
      const L = n2 => gl.getUniformLocation(this.p, n2), aP = gl.getAttribLocation(this.p, 'p'), aN = gl.getAttribLocation(this.p, 'n');
      gl.uniformMatrix4fv(L('VP'), false, VP); gl.uniform3fv(L('eye'), eye);
      // where each speaker's front foot lands on the canvas (0..1), for labels
      this.feet = st.speakers.map((sp, i) => {
        const x = (i - (n - 1) / 2) * step, y = this.floor, z = D * 0.5;
        const cx = VP[0] * x + VP[4] * y + VP[8] * z + VP[12], cy2 = VP[1] * x + VP[5] * y + VP[9] * z + VP[13], cw = VP[3] * x + VP[7] * y + VP[11] * z + VP[15];
        return { x: (cx / cw + 1) / 2, y: (1 - cy2 / cw) / 2 };
      });
      const models = st.speakers.map((sp, i) => model((i - (n - 1) / 2) * step, 0, (sp.yaw + st.spin) * Math.PI / 180, this.cx, this.cz));
      st.speakers.forEach((sp, i) => {
        gl.uniformMatrix4fv(L('M'), false, models[i]); gl.uniform1f(L('dim'), sp.dim == null ? 1 : sp.dim);
        for (const [k, b] of Object.entries(this.buf)) {
          const col = this.o.parts[k]; if (!col) continue;
          gl.uniform3fv(L('col'), hex(col)); gl.uniform1f(L('gloss'), this.o.gloss[k] == null ? 0.06 : this.o.gloss[k]);
          gl.bindBuffer(gl.ARRAY_BUFFER, b.b);
          gl.enableVertexAttribArray(aP); gl.vertexAttribPointer(aP, 3, gl.FLOAT, false, 24, 0);
          gl.enableVertexAttribArray(aN); gl.vertexAttribPointer(aN, 3, gl.FLOAT, false, 24, 12);
          gl.drawArrays(gl.TRIANGLES, 0, b.n);
        }
      });
      // shadows under each speaker, drawn after so depth keeps them under the box
      gl.useProgram(this.sp); gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); gl.depthMask(false);
      const S = n2 => gl.getUniformLocation(this.sp, n2), aQ = gl.getAttribLocation(this.sp, 'q');
      gl.uniformMatrix4fv(S('VP'), false, VP); gl.uniform2f(S('hs'), W / 2, D / 2); gl.uniform1f(S('dark'), st.shadow);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.q); gl.enableVertexAttribArray(aQ); gl.vertexAttribPointer(aQ, 2, gl.FLOAT, false, 8, 0);
      st.speakers.forEach((sp, i) => {
        const M = model((i - (n - 1) / 2) * step, 0, (sp.yaw + st.spin) * Math.PI / 180, 0, 0);
        M[13] = this.floor - 0.4;     // just under the feet
        // the box centre in x/z sits at (cx, cz): shift the quad there
        const yaw = (sp.yaw + st.spin) * Math.PI / 180, c = Math.cos(yaw), s = Math.sin(yaw);
        M[12] = (i - (n - 1) / 2) * step; M[14] = 0;
        void c; void s;
        gl.uniformMatrix4fv(S('M'), false, M);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      });
      gl.depthMask(true); gl.disable(gl.BLEND);
    }
  }
  // The slatted grille, measured from the Fusion design (its display mesh in
  // "nubert 3.f3d"; the grille was not in the 3MF export): 21 slats on a 7 mm
  // pitch, 5 mm wide, 3 mm straight then a round top to 5 mm, running
  // y -75.5..167.5 inside an outline of x +-74.5 with ~10 mm corners. Two ring
  // grooves cut through the slats: woofer r 66..69 at (0,0), tweeter
  // r 43.4..46.5 at (0,115). Behind the 2 mm gaps a dark backing.
  function grille(g) {
    const S = { slat: [], back: [], ring: [] };
    const push = (L, P, N) => L.push([P, N]);
    const box = (L, x0, x1, y0, y1, z0, z1) => {
      const P = [], N = [];
      const q = (a, b, c, d, n) => { P.push(...a, ...b, ...c, ...a, ...c, ...d); for (let i = 0; i < 6; i++) N.push(...n); };
      q([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1]);
      q([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [-1, 0, 0]);
      q([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [1, 0, 0]);
      q([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], [0, 1, 0]);
      q([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [0, -1, 0]);
      push(L, P, N);
    };
    // one slat piece: straight sides to zs, a round top to zt, flat end caps
    const { pitch, n, w, zs, zt, y0, y1, xo, r, rings, z0 } = g;
    const R = ((w / 2) ** 2 + (zt - zs) ** 2) / (2 * (zt - zs)), cz = zt - R, a0 = Math.asin((w / 2) / R);
    const prof = [[-w / 2, z0, -1, 0], [-w / 2, zs, -1, 0]];
    for (let i = 0; i <= 8; i++) {
      const a = -a0 + 2 * a0 * i / 8;
      prof.push([R * Math.sin(a), cz + R * Math.cos(a), Math.sin(a), Math.cos(a)]);
    }
    prof.push([w / 2, zs, 1, 0], [w / 2, z0, 1, 0]);
    const slat = (xc, ya, yb) => {
      if (yb - ya < 0.3) return;
      const P = [], N = [];
      for (let i = 0; i < prof.length - 1; i++) {
        const [xa, za, na, ma] = prof[i], [xb, zb, nb, mb] = prof[i + 1];
        if (xa === xb && za === zb) continue;
        const A = [xc + xa, ya, za], B = [xc + xb, ya, zb], C = [xc + xb, yb, zb], D = [xc + xa, yb, za];
        P.push(...A, ...B, ...C, ...A, ...C, ...D);
        N.push(na, 0, ma, nb, 0, mb, nb, 0, mb, na, 0, ma, nb, 0, mb, na, 0, ma);
      }
      // end caps (fan over the profile)
      for (const [y, s] of [[ya, -1], [yb, 1]]) for (let i = 1; i < prof.length - 1; i++) {
        const p0 = prof[0], p1 = prof[i], p2 = prof[i + 1];
        P.push(xc + p0[0], y, p0[1], xc + p1[0], y, p1[1], xc + p2[0], y, p2[1]);
        N.push(0, s, 0, 0, s, 0, 0, s, 0);
      }
      push(S.slat, P, N);
    };
    const end = x => {            // slat ends follow the rounded corners of the outline
      const e = Math.abs(x) + w / 2 - (xo - r);
      const d = e > 0 ? r - Math.sqrt(Math.max(0, r * r - e * e)) : 0;
      return [y0 + d, y1 - d];
    };
    for (let k = -(n - 1) / 2; k <= (n - 1) / 2; k++) {
      const xc = k * pitch, [ya, yb] = end(xc);
      box(S.back, xc - pitch / 2, xc + pitch / 2, ya, yb, z0 - 0.8, z0 - 0.2);
      // where the ring grooves cross this slat (its centre line)
      const cuts = [];
      for (const [cx, cy, ri, ro] of rings) {
        const dx = Math.abs(xc - cx);
        if (dx >= ro) continue;
        const ho = Math.sqrt(ro * ro - dx * dx), hi = dx < ri ? Math.sqrt(ri * ri - dx * dx) : 0;
        if (hi > 0) cuts.push([cy - ho, cy - hi], [cy + hi, cy + ho]); else cuts.push([cy - ho, cy + ho]);
      }
      cuts.sort((p, q) => p[0] - q[0]);
      let y = ya;
      for (const [c0, c1] of cuts) {
        const a = Math.max(c0, ya), b = Math.min(c1, yb);
        if (b <= a) continue;
        slat(xc, y, a);
        box(S.ring, xc - w / 2, xc + w / 2, a, b, z0, z0 + 0.8);
        y = b;
      }
      slat(xc, y, yb);
    }
    const pack = L => {
      const n3 = L.reduce((s, [P]) => s + P.length, 0), P = new Float32Array(n3), N = new Float32Array(n3);
      let o = 0; for (const [p, nn] of L) { P.set(p, o); N.set(nn, o); o += p.length; }
      return { P, N, n: n3 / 3 };
    };
    return { grille: pack(S.slat), gback: pack(S.back), gring: pack(S.ring) };
  }

  window.VX3D = { load, View, grille };
})();
