'use strict';
/**
 * 最小限のPNG書き出しと描画。
 *
 * OGP画像を作るためだけの道具。外部パッケージを入れずに済ませるため自前で持つ。
 * ビルドの依存を増やさない方針は tools/build.js の冒頭コメントを参照。
 *
 * 対応するのは 8bit truecolor(RGB) のみ。透過もインターレースも扱わない。
 * 図形の縁は SS 倍で描いてから縮小することで滑らかにしている。
 */

const zlib = require('zlib');

/* ---------------- PNG ---------------- */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** 幅・高さとRGBの生データ（w*h*3）から PNG のバイト列を組む */
function encodePng(width, height, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 2;    // color type: truecolor
  ihdr[10] = 0;   // compression
  ihdr[11] = 0;   // filter
  ihdr[12] = 0;   // interlace

  // 走査線ごとに先頭へフィルタ種別（0＝なし）を挟む
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------------- 5×7 ビットマップフォント ----------------
   OGP画像に載せるのは社名・区分・日付といった英数字だけなので、
   フォントファイルを持たずに済むこの範囲で足りる。
   各文字は7行、1行の下位5bitが左から並ぶ点の有無。 */

const FONT = {
  A: [0x0E, 0x11, 0x11, 0x1F, 0x11, 0x11, 0x11],
  B: [0x1E, 0x11, 0x11, 0x1E, 0x11, 0x11, 0x1E],
  C: [0x0E, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0E],
  D: [0x1E, 0x11, 0x11, 0x11, 0x11, 0x11, 0x1E],
  E: [0x1F, 0x10, 0x10, 0x1E, 0x10, 0x10, 0x1F],
  F: [0x1F, 0x10, 0x10, 0x1E, 0x10, 0x10, 0x10],
  G: [0x0E, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0F],
  H: [0x11, 0x11, 0x11, 0x1F, 0x11, 0x11, 0x11],
  I: [0x0E, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0E],
  J: [0x07, 0x02, 0x02, 0x02, 0x02, 0x12, 0x0C],
  K: [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11],
  L: [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1F],
  M: [0x11, 0x1B, 0x15, 0x15, 0x11, 0x11, 0x11],
  N: [0x11, 0x19, 0x15, 0x13, 0x11, 0x11, 0x11],
  O: [0x0E, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0E],
  P: [0x1E, 0x11, 0x11, 0x1E, 0x10, 0x10, 0x10],
  Q: [0x0E, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0D],
  R: [0x1E, 0x11, 0x11, 0x1E, 0x14, 0x12, 0x11],
  S: [0x0F, 0x10, 0x10, 0x0E, 0x01, 0x01, 0x1E],
  T: [0x1F, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
  U: [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0E],
  V: [0x11, 0x11, 0x11, 0x11, 0x11, 0x0A, 0x04],
  W: [0x11, 0x11, 0x11, 0x15, 0x15, 0x1B, 0x11],
  X: [0x11, 0x11, 0x0A, 0x04, 0x0A, 0x11, 0x11],
  Y: [0x11, 0x11, 0x0A, 0x04, 0x04, 0x04, 0x04],
  Z: [0x1F, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1F],
  0: [0x0E, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0E],
  1: [0x04, 0x0C, 0x04, 0x04, 0x04, 0x04, 0x0E],
  2: [0x0E, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1F],
  3: [0x1F, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0E],
  4: [0x02, 0x06, 0x0A, 0x12, 0x1F, 0x02, 0x02],
  5: [0x1F, 0x10, 0x1E, 0x01, 0x01, 0x11, 0x0E],
  6: [0x06, 0x08, 0x10, 0x1E, 0x11, 0x11, 0x0E],
  7: [0x1F, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
  8: [0x0E, 0x11, 0x11, 0x0E, 0x11, 0x11, 0x0E],
  9: [0x0E, 0x11, 0x11, 0x0F, 0x01, 0x02, 0x0C],
  ' ': [0, 0, 0, 0, 0, 0, 0],
  '.': [0, 0, 0, 0, 0, 0x18, 0x18],
  ',': [0, 0, 0, 0, 0x18, 0x18, 0x10],
  '-': [0, 0, 0, 0x1F, 0, 0, 0],
  '/': [0x01, 0x02, 0x02, 0x04, 0x08, 0x08, 0x10],
  ':': [0, 0x18, 0x18, 0, 0x18, 0x18, 0],
  '(': [0x02, 0x04, 0x08, 0x08, 0x08, 0x04, 0x02],
  ')': [0x08, 0x04, 0x02, 0x02, 0x02, 0x04, 0x08],
};

const GLYPH_W = 5, GLYPH_H = 7;

/** 描画せずに横幅だけ求める（右寄せ・中央寄せの計算用） */
function textWidth(str, scale, tracking = 1) {
  const n = str.length;
  if (n === 0) return 0;
  return n * GLYPH_W * scale + (n - 1) * tracking * scale;
}

/* ---------------- SVGパス → 多角形 ----------------
   ロゴの盾の形をSVGの d 属性から取り込む。
   M / L / V / H / C / Z の絶対座標だけ対応すれば足りる。 */

function pathToPolygon(d, samples = 48) {
  const tokens = d.match(/[MLVHCZmlvhcz]|-?\d*\.?\d+/g) || [];
  const pts = [];
  let i = 0, cx = 0, cy = 0, cmd = null;

  const num = () => parseFloat(tokens[i++]);
  const push = (x, y) => { pts.push([x, y]); cx = x; cy = y; };

  while (i < tokens.length) {
    if (/^[A-Za-z]$/.test(tokens[i])) { cmd = tokens[i++].toUpperCase(); }
    if (cmd === 'Z') break;

    if (cmd === 'M' || cmd === 'L') { push(num(), num()); }
    else if (cmd === 'V') { push(cx, num()); }
    else if (cmd === 'H') { push(num(), cy); }
    else if (cmd === 'C') {
      const x0 = cx, y0 = cy;
      const x1 = num(), y1 = num(), x2 = num(), y2 = num(), x3 = num(), y3 = num();
      for (let s = 1; s <= samples; s++) {
        const t = s / samples, u = 1 - t;
        pts.push([
          u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3,
          u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3,
        ]);
      }
      cx = x3; cy = y3;
    }
    else { i++; }   // 未対応の命令は読み飛ばす
  }
  return pts;
}

/* ---------------- 画布 ----------------
   座標は最終的な出力サイズで指定する。内部では SS 倍で描き、
   最後に平均して縮小するため、斜めの縁が階段状にならない。
   文字は SS の整数倍で描かれるので縮小しても滲まない。 */

const SS = 3;

class Canvas {
  constructor(width, height, background) {
    this.w = width;
    this.h = height;
    this.W = width * SS;
    this.H = height * SS;
    this.buf = Buffer.alloc(this.W * this.H * 3);
    if (background) this.fillRect(0, 0, width, height, background);
  }

  /** 単色でも、論理座標を受け取って色を返す関数でも指定できる */
  _paint(X, Y, color) {
    const c = typeof color === 'function' ? color(X / SS, Y / SS) : color;
    if (!c) return;
    const o = (Y * this.W + X) * 3;
    this.buf[o] = c[0]; this.buf[o + 1] = c[1]; this.buf[o + 2] = c[2];
  }

  fillRect(x, y, w, h, color) {
    const x0 = Math.max(0, Math.round(x * SS)), y0 = Math.max(0, Math.round(y * SS));
    const x1 = Math.min(this.W, Math.round((x + w) * SS)), y1 = Math.min(this.H, Math.round((y + h) * SS));
    for (let Y = y0; Y < y1; Y++) for (let X = x0; X < x1; X++) this._paint(X, Y, color);
  }

  /** 多角形の塗り。走査線と辺の交点を求めて、対になった区間を塗る */
  fillPolygon(points, color) {
    const P = points.map(p => [p[0] * SS, p[1] * SS]);
    let minY = Infinity, maxY = -Infinity;
    for (const p of P) { if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1]; }
    const y0 = Math.max(0, Math.floor(minY)), y1 = Math.min(this.H - 1, Math.ceil(maxY));

    for (let Y = y0; Y <= y1; Y++) {
      const yc = Y + 0.5;
      const xs = [];
      for (let k = 0; k < P.length; k++) {
        const a = P[k], b = P[(k + 1) % P.length];
        if ((a[1] <= yc && b[1] > yc) || (b[1] <= yc && a[1] > yc)) {
          xs.push(a[0] + (yc - a[1]) / (b[1] - a[1]) * (b[0] - a[0]));
        }
      }
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const s = Math.max(0, Math.ceil(xs[k] - 0.5)), e = Math.min(this.W - 1, Math.floor(xs[k + 1] - 0.5));
        for (let X = s; X <= e; X++) this._paint(X, Y, color);
      }
    }
  }

  /** 英数字のみ。未収録の文字は空白として詰める */
  text(str, x, y, scale, color, tracking = 1) {
    const s = String(str).toUpperCase();
    let cursor = x;
    for (const ch of s) {
      const g = FONT[ch];
      if (g) {
        for (let row = 0; row < GLYPH_H; row++) {
          for (let col = 0; col < GLYPH_W; col++) {
            if (g[row] & (1 << (GLYPH_W - 1 - col))) {
              this.fillRect(cursor + col * scale, y + row * scale, scale, scale, color);
            }
          }
        }
      }
      cursor += (GLYPH_W + tracking) * scale;
    }
  }

  /** SS×SS を平均して出力サイズへ落とし、PNGにする */
  toPng() {
    const out = Buffer.alloc(this.w * this.h * 3);
    const n = SS * SS;
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        let r = 0, g = 0, b = 0;
        for (let dy = 0; dy < SS; dy++) {
          const row = ((y * SS + dy) * this.W + x * SS) * 3;
          for (let dx = 0; dx < SS; dx++) {
            r += this.buf[row + dx * 3];
            g += this.buf[row + dx * 3 + 1];
            b += this.buf[row + dx * 3 + 2];
          }
        }
        const o = (y * this.w + x) * 3;
        out[o] = Math.round(r / n); out[o + 1] = Math.round(g / n); out[o + 2] = Math.round(b / n);
      }
    }
    return encodePng(this.w, this.h, out);
  }
}

module.exports = { Canvas, encodePng, pathToPolygon, textWidth, FONT, GLYPH_W, GLYPH_H };
