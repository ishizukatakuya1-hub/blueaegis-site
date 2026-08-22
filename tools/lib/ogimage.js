'use strict';
/**
 * OGP画像の生成。
 *
 * SNSやチャットにURLが貼られたときのカード画像を、ページごとに作る。
 * ブランドガイドラインに沿った版面を機械的に組むので、記事が増えても手作業は発生しない。
 *
 * 記事タイトルは画像に載せない。載っている書体でしか描けず、
 * 日本語のグリフを持たないため。タイトルは og:title としてテキストで伝わる。
 * 代わりに、区分（規制解説／メディア）・日付・盾の意匠でページを見分けられるようにしている。
 * 盾のどの帯を強調するかは slug から決めるので、同じ記事なら毎回同じ絵になる。
 */

const { Canvas, pathToPolygon, textWidth } = require('./png');

const W = 1200, H = 630;

/* ブランドガイドラインの配色。ロゴのSVGと同じ値を使う */
const NAVY    = [0x0A, 0x2A, 0x4F];
const ACCENT  = [0x1E, 0x5F, 0xA8];
const BAND    = [0x13, 0x3A, 0x69];
const GAP     = [0x07, 0x1E, 0x3A];
const WHITE   = [0xFF, 0xFF, 0xFF];
const KICKER  = [0x6E, 0xA8, 0xE5];
const MUTED   = [0x8A, 0xA6, 0xC7];
const HAIRLINE = [0x1B, 0x44, 0x74];

/* ロゴの盾。tools/build.js の LOGO と同じ d 属性 */
const SHIELD_D = 'M60 8 L108 26 V62 C108 92 88 116 60 134 C32 116 12 92 12 62 V26 Z';

/* 版面。左が文字、右が盾 */
const PAD_L = 88;
const COL_W = 600;          // 文字が使ってよい横幅
const SHIELD_H = 420;

function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** 指定幅に収まる最大の倍率を選ぶ（1〜max）。1文字は 5×7 + 字間1 */
function fitScale(str, maxWidth, max) {
  const n = str.length;
  if (!n) return 1;
  const s = Math.floor((maxWidth + 1) / (6 * n));
  return Math.max(1, Math.min(max, s));
}

/** ASCII外を落として書体で描ける文字だけにする */
function ascii(str) {
  return String(str).toUpperCase().replace(/[^A-Z0-9 .,\-/:()]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** 盾の外形を、指定の高さ・右端に合わせて置く。top を渡せばその位置に、省略すれば縦中央に */
function placeShield(height, right, canvasH, top) {
  const poly = pathToPolygon(SHIELD_D);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of poly) {
    if (p[0] < minX) minX = p[0];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[1] > maxY) maxY = p[1];
  }
  const s = height / (maxY - minY);
  const offX = right - (maxX - minX) * s - minX * s;
  const offY = (top === undefined ? (canvasH - height) / 2 : top) - minY * s;
  return { pts: poly.map(p => [p[0] * s + offX, p[1] * s + offY]), s, offY };
}

/** 帯はロゴと同じ 28 間隔・厚み 22。hi の1本だけ強調する */
function bandColor(s, offY, hi) {
  return (x, y) => {
    const oy = (y - offY) / s;                 // ロゴの座標系に戻す
    const i = Math.floor((oy - 8) / 28);
    if ((oy - 8) - i * 28 >= 22) return GAP;
    return i === hi ? ACCENT : BAND;
  };
}

/* 背景と盾は5通りしかないので描き直さない。
   記事が増えてもビルド時間が線形に膨らまないようにするため。 */
const baseCache = new Map();

function baseCanvas(hi) {
  if (!baseCache.has(hi)) {
    const c = new Canvas(W, H, NAVY);
    const sh = placeShield(SHIELD_H, W - 90, H);
    c.fillPolygon(sh.pts, bandColor(sh.s, sh.offY, hi));
    baseCache.set(hi, c.buf);
  }
  const c = new Canvas(W, H);
  c.buf = Buffer.from(baseCache.get(hi));
  return c;
}

/**
 * カード画像を1枚作る。
 *   kicker  区分ラベル（英字）
 *   line    下段に置く1行（日付など。英数字のみ）
 *   seed    盾の強調帯を決める文字列。同じ seed なら同じ絵になる
 */
function ogCard({ kicker, line, seed }) {
  const c = baseCanvas(hash(seed) % 5);

  /* --- 左：文字 --- */
  c.fillRect(PAD_L, 148, 96, 8, ACCENT);

  const k = ascii(kicker);
  const ks = fitScale(k, COL_W, 4);
  c.text(k, PAD_L, 186, ks, KICKER);

  c.text('BLUE AEGIS', PAD_L, 252, 10, WHITE);

  const tag = 'THE SHIELD FOR THE INTELLIGENT AGE';
  c.text(tag, PAD_L, 356, fitScale(tag, COL_W, 3), MUTED);

  c.fillRect(PAD_L, 432, COL_W, 2, HAIRLINE);

  const foot = ascii(line ? `${line} / BLUEAEGIS.CO.JP` : 'BLUEAEGIS.CO.JP');
  c.text(foot, PAD_L, 462, fitScale(foot, COL_W, 3), MUTED);

  return c.toPng();
}

/**
 * 発行元の印として構造化データから参照する正方形のロゴ。
 * 検索結果の見出し脇に出ることがあるので、盾だけで成立する版面にしている。
 */
function logoPng(size = 512) {
  const c = new Canvas(size, size, NAVY);
  const shH = size * 0.55;
  const shW = shH * (96 / 126);                       // 盾の縦横比
  const sh = placeShield(shH, (size + shW) / 2, size, size * 0.08);
  c.fillPolygon(sh.pts, bandColor(sh.s, sh.offY, 2));

  const label = 'BLUE AEGIS';
  const scale = fitScale(label, size * 0.78, 8);
  c.text(label, (size - textWidth(label, scale)) / 2, size * 0.70, scale, WHITE);
  return c.toPng();
}

module.exports = { ogCard, logoPng, OG_WIDTH: W, OG_HEIGHT: H };
