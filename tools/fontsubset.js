'use strict';
/**
 * トップの見出し用明朝体のサブセットを作り直す。
 *
 *   node tools/fontsubset.js
 *
 * トップ（日英）の見出しを書き換えて、ビルドの検査が
 * 「明朝のサブセットにない字があります」と警告したときだけ実行する。
 * ビルドには組み込まない（ビルドは外部に出ない、を保つため）。
 *
 * Google Fonts の text= 指定は、渡した字だけを含む woff2 を返す。
 * それを fonts/ に置いて同梱し、実行時には外部から読まない。
 * 書体は Shippori Mincho（SIL Open Font License 1.1）。
 */

const fs = require('fs');
const path = require('path');
const { PAGES, FONT_FILE, CHARS_FILE, headingChars } = require('./lib/fontchars');

const ROOT = path.join(__dirname, '..');
const FAMILY = 'Shippori+Mincho:wght@600';
/* woff2 を返してもらうため、ブラウザの UA を名乗る */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

async function main() {
  const htmls = PAGES.map(p => fs.readFileSync(path.join(ROOT, p), 'utf8'));
  const chars = [...headingChars(htmls)].sort().join('');

  const cssUrl = `https://fonts.googleapis.com/css2?family=${FAMILY}&text=${encodeURIComponent(chars)}&display=swap`;
  const css = await (await fetch(cssUrl, { headers: { 'User-Agent': UA } })).text();
  const urls = [...css.matchAll(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)\s*format\('woff2'\)/g)].map(m => m[1]);
  if (urls.length !== 1) throw new Error(`woff2 の URL が1つではありません（${urls.length} 件）:\n${css}`);

  const res = await fetch(urls[0], { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`フォントの取得に失敗: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.subarray(0, 4).toString('latin1') !== 'wOF2') throw new Error('woff2 ではないデータが返りました');

  fs.mkdirSync(path.join(ROOT, 'fonts'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, FONT_FILE), buf);
  fs.writeFileSync(path.join(ROOT, CHARS_FILE), chars + '\n');
  console.log(`${FONT_FILE}：${chars.length} 字、${Math.round(buf.length / 1024)} KB`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
