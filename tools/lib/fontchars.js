'use strict';
/**
 * トップページの見出し用明朝体（Shippori Mincho 600）のサブセット。
 *
 * 同梱しているのは、トップ（日英）の見出しに実際に出てくる字だけ。
 * どの要素の字を拾うかをここ1か所で決め、作る側（tools/fontsubset.js）と
 * 確かめる側（lib/audit.js）が同じ規則を使う。
 *
 * 拾う要素は style.css の「トップの文字組み」で明朝にしている要素と揃えること。
 */

const PAGES = ['index.html', 'en/index.html'];
const FONT_FILE = 'fonts/shippori-mincho-600-top.woff2';
const CHARS_FILE = 'fonts/shippori-mincho-600-top.txt';

const TARGETS = [
  /<h1>([\s\S]*?)<\/h1>/g,
  /<h2>([\s\S]*?)<\/h2>/g,
  /<div class="lead">([\s\S]*?)<\/div>/g,
  /<div class="pull">([\s\S]*?)<\/div>/g,
  /<blockquote>([\s\S]*?)<\/blockquote>/g,
  /<p class="bandcopy">([\s\S]*?)<\/p>/g,
];

/* CSS が足す字：セクション番号（01〜）とダッシュ、数字（.stat b） */
const EXTRA = '0123456789—';

/** HTML 群から、明朝で描く字の集合を返す（空白は除く） */
function headingChars(htmls) {
  let text = EXTRA;
  for (const html of htmls) {
    for (const re of TARGETS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(html)) !== null) text += m[1].replace(/<[^>]+>/g, '');
    }
  }
  return new Set([...text.replace(/\s/g, '')]);
}

module.exports = { PAGES, FONT_FILE, CHARS_FILE, headingChars };
