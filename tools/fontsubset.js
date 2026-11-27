'use strict';
/**
 * 見出し用明朝体（Shippori Mincho 600）の分割フォントを取り直す。
 *
 *   node tools/fontsubset.js
 *
 * Google Fonts が配信している「字の範囲（unicode-range）ごとに分割した woff2」をそのまま
 * fonts/shippori-mincho-600/ に同梱し、style.css の目印（mincho:begin〜end）の間に
 * 自前のパスを指す @font-face を書き込む。ブラウザは表示する字が含まれる分割だけを読むので、
 * 記事が増えて見出しの字が変わっても作り直す必要はない（書体を変えるときだけ実行する）。
 *
 * ビルドには組み込まない（ビルドは外部に出ない、を保つため）。実行時にも外部から読まない。
 * 書体は Shippori Mincho（SIL Open Font License 1.1）。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FAMILY = 'Shippori+Mincho:wght@600';
const NAME = 'BA Mincho';
const DIR = 'fonts/shippori-mincho-600';
const CSS_FILE = path.join(ROOT, 'style.css');
const BEGIN = '/* mincho:begin */';
const END = '/* mincho:end */';
/* woff2 を返してもらうため、ブラウザの UA を名乗る */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

async function get(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`取得に失敗: HTTP ${res.status} ${url}`);
  return res;
}

async function main() {
  const css = await (await get(`https://fonts.googleapis.com/css2?family=${FAMILY}&display=swap`)).text();
  const blocks = [...css.matchAll(/@font-face\s*{([^}]+)}/g)].map(m => m[1]);
  if (!blocks.length) throw new Error('@font-face が見つかりません');

  fs.rmSync(path.join(ROOT, DIR), { recursive: true, force: true });
  fs.mkdirSync(path.join(ROOT, DIR), { recursive: true });

  const faces = [];
  let total = 0;
  for (let i = 0; i < blocks.length; i++) {
    const url = (/url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/.exec(blocks[i]) || [])[1];
    const range = (/unicode-range:\s*([^;]+);/.exec(blocks[i]) || [])[1];
    if (!url || !range) throw new Error(`url または unicode-range がない @font-face があります:\n${blocks[i]}`);
    const buf = Buffer.from(await (await get(url)).arrayBuffer());
    if (buf.subarray(0, 4).toString('latin1') !== 'wOF2') throw new Error(`woff2 ではないデータ: ${url}`);
    const file = `${DIR}/${String(i).padStart(3, '0')}.woff2`;
    fs.writeFileSync(path.join(ROOT, file), buf);
    total += buf.length;
    faces.push(`@font-face{font-family:"${NAME}";font-weight:600;font-style:normal;font-display:swap;src:url(${file}) format("woff2");unicode-range:${range.trim()}}`);
  }

  const style = fs.readFileSync(CSS_FILE, 'utf8');
  const a = style.indexOf(BEGIN), b = style.indexOf(END);
  if (a < 0 || b < a) throw new Error('style.css に mincho:begin / mincho:end の目印がありません');
  const eol = style.includes('\r\n') ? '\r\n' : '\n';
  const out = style.slice(0, a + BEGIN.length) + eol + faces.join(eol) + eol + style.slice(b);
  fs.writeFileSync(CSS_FILE, out);
  console.log(`${DIR}/：${faces.length} ファイル、${(total / 1024 / 1024).toFixed(2)} MB。style.css を更新`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
