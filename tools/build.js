#!/usr/bin/env node
/**
 * Blue Aegis サイトビルド
 *
 * content/blog/*.md を読み、_site/ に静的サイトを組み立てる。
 * 外部ライブラリに依存しない。自動掲載の経路に供給網の攻撃面を持ち込まないため。
 *
 *   node tools/build.js                  ビルド（_site/ を生成）
 *   node tools/build.js --validate-only  記事の検証のみ（PRのCIで使用）
 *
 * 記事ファイルの規約は PUBLISHING.md を正とする。ここを変えたら向こうも直すこと。
 *
 * 検索・共有まわり（構造化データ、OGP画像、サイトマップ、RSS、内部リンク、検査）は
 * tools/lib/ に分けてある。ページを手で足しても同じ処理を通るので、付け忘れが起きない。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const seo = require('./lib/seo');
const { ogCard, logoPng } = require('./lib/ogimage');
const { audit } = require('./lib/audit');

const ROOT = path.resolve(__dirname, '..');
const SRC = { ja: path.join(ROOT, 'content', 'blog'),
              en: path.join(ROOT, 'content', 'blog-en') };
const OUT = path.join(ROOT, '_site');
const VALIDATE_ONLY = process.argv.includes('--validate-only');

const BASE = seo.BASE;

/** タグの一覧ページを作る下限。
 *  記事が少ないうちにページだけ増やすと中身の薄いページが並ぶので、
 *  この本数に達したタグだけを独立したページにする。 */
const TAG_PAGE_MIN = 3;

/** 記事下に出す関連記事の本数 */
const RELATED_MAX = 3;

/* ビルド出力に含めない（生成物・道具・設定） */
const SKIP = new Set(['content', 'tools', '_site', 'node_modules', '.git', '.github',
                      'package.json', 'package-lock.json', '.claude']);

/* 直下の .md は社内向けの文書なので配信しない。記事は content/ から HTML にして出すので、
   ここを通る .md に配信すべきものは無い。名前で数え上げると足したときに漏れる
   （実際 CLAUDE.md を足したとき、そのまま /CLAUDE.md として配信される状態になった）。 */
const SKIP_TOP = /\.md$/i;

const errors = [];
const warnings = [];
const fail = (file, msg) => errors.push(`${file}: ${msg}`);
const warn = (file, msg) => warnings.push(`${file}: ${msg}`);

/* ---------------- frontmatter ----------------
   規約で使う範囲だけを解釈する簡易YAML。
   対応：文字列 / 真偽値 / 数値 / 日付 / インライン配列 / ハイフン始まりのリスト（入れ子1段） */
function parseFrontmatter(raw, file) {
  if (!raw.startsWith('---')) { fail(file, 'frontmatter が見つかりません'); return [null, raw]; }
  const end = raw.indexOf('\n---', 3);
  if (end === -1) { fail(file, 'frontmatter が閉じられていません'); return [null, raw]; }
  const head = raw.slice(4, end);
  const body = raw.slice(raw.indexOf('\n', end + 1) + 1);

  const data = {};
  let listKey = null, listItem = null;

  for (const line of head.split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    const t = line.trim();

    if (t.startsWith('- ')) {                       // リストの要素
      if (!listKey) { fail(file, `対応するキーのないリスト要素: ${t}`); continue; }
      listItem = {};
      data[listKey].push(listItem);
      const rest = t.slice(2).trim();
      if (rest) { const [k, v] = splitKV(rest); if (k) listItem[k] = v; }
      continue;
    }
    const [k, v] = splitKV(t);
    if (!k) continue;

    if (indent > 0 && listItem) { listItem[k] = v; continue; }   // リスト要素の続き
    listItem = null;

    if (v === '') { listKey = k; data[k] = []; }                 // 次行からリスト
    else { listKey = null; data[k] = v; }
  }
  return [data, body];
}

function splitKV(s) {
  const i = s.indexOf(':');
  if (i === -1) return [null, null];
  const k = s.slice(0, i).trim();
  let v = s.slice(i + 1).trim();
  if (v.startsWith('[') && v.endsWith(']')) {
    v = v.slice(1, -1).split(',').map(x => unquote(x.trim())).filter(Boolean);
  } else if (v === 'true' || v === 'false') {
    v = v === 'true';
  } else {
    v = unquote(v);
  }
  return [k, v];
}
const unquote = s => (typeof s === 'string' && /^(".*"|'.*')$/.test(s)) ? s.slice(1, -1) : s;

/* ---------------- 検証 ---------------- */
const FILENAME = /^(\d{4}-\d{2}-\d{2})-([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/;

function validate(file, fm, body) {
  const m = FILENAME.exec(file);
  if (!m) {
    fail(file, 'ファイル名は YYYY-MM-DD-slug.md 形式（slug は英小文字・数字・ハイフン）');
    return null;
  }
  const [, fileDate, slug] = m;
  if (!fm) return null;

  for (const key of ['title', 'date', 'description', 'author']) {
    if (!fm[key]) fail(file, `frontmatter に ${key} がありません`);
  }
  if (fm.date && String(fm.date) !== fileDate) {
    fail(file, `date（${fm.date}）とファイル名の日付（${fileDate}）が一致しません`);
  }
  if (!Array.isArray(fm.tags) || fm.tags.length === 0) fail(file, 'tags が空です');

  if (!Array.isArray(fm.sources) || fm.sources.length === 0) {
    fail(file, 'sources がありません。出典の明記は必須です');
  } else {
    if (!fm.sources.some(s => s.type === 'primary')) {
      fail(file, 'sources に type: primary（一次出典）が1件もありません');
    }
    fm.sources.forEach((s, i) => {
      for (const key of ['type', 'publisher', 'title', 'url']) {
        if (!s[key]) fail(file, `sources[${i}] に ${key} がありません`);
      }
      if (s.url && !/^https?:\/\//.test(s.url)) fail(file, `sources[${i}] の url が不正です`);
      if (s.type && !['primary', 'secondary'].includes(s.type)) {
        fail(file, `sources[${i}] の type は primary か secondary`);
      }
    });
  }

  const text = body.replace(/\s/g, '');
  if (text.length < 800) warn(file, `本文が短い（約${text.length}字。目安1,500〜2,500字）`);
  if (text.length > 4000) warn(file, `本文が長い（約${text.length}字。目安1,500〜2,500字）`);
  if (/^#\s/m.test(body)) fail(file, '本文の見出しは H2（##）から。H1 は title から生成されます');
  /* 検索結果は文字数ではなく幅で切られるので、全角を2として数える */
  if (fm.title) {
    const w = seo.displayWidth(`${fm.seoTitle || fm.title}｜Blue Aegis Media`);
    if (w > 68) warn(file, `検索結果に出る title が長い（表示幅 ${w}／目安 68）。frontmatter に seoTitle を足せば、見出しはそのままで短い版を出せます`);
  }
  if (fm.description) {
    const w = seo.displayWidth(fm.description);
    if (w > 200) warn(file, `description が長い（表示幅 ${w}／目安 200）`);
    if (w < 70) warn(file, `description が短い（表示幅 ${w}／目安 70 以上）`);
  }

  return { slug, date: fileDate };
}

/* ---------------- Markdown（規約で許す範囲のみ） ---------------- */
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function inline(s) {
  return esc(s)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
             '<a href="$2" rel="noopener">$1</a>')
    .replace(/(^|[^"=>])\b(https?:\/\/[^\s<]+)/g,
             '$1<a href="$2" rel="noopener">$2</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

function renderMarkdown(md, file) {
  const out = [];
  const blocks = md.replace(/\r\n/g, '\n').split(/\n{2,}/);

  for (const raw of blocks) {
    const block = raw.trim();
    if (!block) continue;
    const lines = block.split('\n');

    if (/^###\s/.test(block))      { out.push(`<h3>${inline(block.replace(/^###\s+/, ''))}</h3>`); continue; }
    if (/^##\s/.test(block))       { out.push(`<h2>${inline(block.replace(/^##\s+/, ''))}</h2>`);  continue; }
    if (lines.every(l => /^>\s?/.test(l))) {
      out.push(`<blockquote>${inline(lines.map(l => l.replace(/^>\s?/, '')).join(' '))}</blockquote>`); continue;
    }
    if (lines.every(l => /^[-*]\s+/.test(l))) {
      out.push('<ul>' + lines.map(l => `<li>${inline(l.replace(/^[-*]\s+/, ''))}</li>`).join('') + '</ul>'); continue;
    }
    if (lines.every(l => /^\d+\.\s+/.test(l))) {
      out.push('<ol>' + lines.map(l => `<li>${inline(l.replace(/^\d+\.\s+/, ''))}</li>`).join('') + '</ol>'); continue;
    }
    if (lines.length >= 2 && lines.every(l => l.includes('|')) && /^[\s|:-]+$/.test(lines[1])) {
      const cells = l => l.replace(/^\||\|$/g, '').split('|').map(c => inline(c.trim()));
      const head = cells(lines[0]);
      const rows = lines.slice(2).map(cells);
      out.push('<div class="scroller"><table><tr>' + head.map(c => `<th>${c}</th>`).join('') + '</tr>'
        + rows.map(r => '<tr>' + r.map(c => `<td>${c}</td>`).join('') + '</tr>').join('') + '</table></div>');
      continue;
    }
    if (/^(#{1,6})\s/.test(block)) { fail(file, `対応していない見出し記法: ${block.slice(0, 20)}`); continue; }
    out.push(`<p>${inline(lines.join('\n'))}</p>`);
  }
  return out.join('\n  ');
}

/* ---------------- ページの型 ---------------- */
const LOGO = `<svg viewBox="0 0 380 130" role="img" aria-label="Blue Aegis株式会社">
        <defs>
          <path id="sh1" d="M60 8 L108 26 V62 C108 92 88 116 60 134 C32 116 12 92 12 62 V26 Z"/>
          <clipPath id="cl1"><use href="#sh1"/></clipPath>
        </defs>
        <g transform="translate(0,6) scale(0.82)">
          <g clip-path="url(#cl1)">
            <rect x="0" y="8" width="120" height="22" fill="#0A2A4F"/>
            <rect x="0" y="36" width="120" height="22" fill="#0A2A4F"/>
            <rect x="0" y="64" width="120" height="22" fill="#1E5FA8"/>
            <rect x="0" y="92" width="120" height="22" fill="#0A2A4F"/>
            <rect x="0" y="120" width="120" height="20" fill="#0A2A4F"/>
          </g>
        </g>
        <text x="110" y="68" font-family="Arial,Helvetica,sans-serif" font-size="44" font-weight="bold" letter-spacing="-1" fill="#0A2A4F">blue<tspan fill="#1E5FA8">aegis</tspan></text>
        <text x="112" y="96" font-family="Arial,Helvetica,sans-serif" font-size="14" letter-spacing="3" fill="#6B7684">Blue Aegis Inc.</text>
      </svg>`;

/* ブログ（Blue Aegis Media）の題字。
   正式ロゴの「積層の盾＋blueaegis」を引き継ぎ、英文社名の行を MEDIA に差し替え、
   Shield Blue の箇所を Media Lemon(#E0C61B) に置き換えた派生形。
   この黄は白地で 1.9:1 しかない。可読性を負わせる用途に流用しないこと。
   正本は 法人設立_BlueAegis/logo/正式/logo_07_media_横並び_カラー.svg（モノクロ・白抜きも同フォルダ）。
   symbol の id はヘッダのロゴ（sh1/cl1）と重ならないようにしてある。
   size は 'lg'（一覧の題字）と 'sm'（記事の冠）の2種類のみ。 */
function mediaLogo(size) {
  return `<svg class="medialogo ${size}" viewBox="0 0 380 130" role="img" aria-label="Blue Aegis Media">
      <defs>
        <path id="shm${size}" d="M60 8 L108 26 V62 C108 92 88 116 60 134 C32 116 12 92 12 62 V26 Z"/>
        <clipPath id="clm${size}"><use href="#shm${size}"/></clipPath>
      </defs>
      <g transform="translate(0,6) scale(0.82)">
        <g clip-path="url(#clm${size})">
          <rect x="0" y="8" width="120" height="22" fill="#0A2A4F"/>
          <rect x="0" y="36" width="120" height="22" fill="#0A2A4F"/>
          <rect x="0" y="64" width="120" height="22" fill="#E0C61B"/>
          <rect x="0" y="92" width="120" height="22" fill="#0A2A4F"/>
          <rect x="0" y="120" width="120" height="20" fill="#0A2A4F"/>
        </g>
      </g>
      <text x="110" y="68" font-family="Arial,Helvetica,sans-serif" font-size="44" font-weight="bold" letter-spacing="-1" fill="#0A2A4F">blue<tspan fill="#E0C61B">aegis</tspan></text>
      <text x="112" y="97" font-family="Arial,Helvetica,sans-serif" font-size="15" font-weight="bold" letter-spacing="5.5" fill="#0A2A4F">MEDIA</text>
      <rect x="200" y="90" width="104" height="3" fill="#E0C61B"/>
    </svg>`;
}

const ANALYTICS = `<!-- Cloudflare Web Analytics --><script defer src='https://static.cloudflareinsights.com/beacon.min.js' data-cf-beacon='{"token": "d0e128ca55ff42f8b920003d57f49159"}'></script><!-- End Cloudflare Web Analytics -->`;

/* ---------------- 言語ごとの文言 ----------------
   ブログは日英の2系統を持つ。英語版の記事は content/blog-en/ に置く。
   規制解説（/insights/）は手書きなのでここには関係しない。 */
const T = {
  ja: {
    htmlLang: 'ja',
    navBlog: 'ブログ', navInsights: '規制解説', navLicensing: 'ライセンス', navContact: 'お問い合わせ',
    navPrivacy: 'プライバシーポリシー', navDisclaimer: '免責事項',
    siteSuffix: '｜Blue Aegis Media',
    blogTitle: 'ブログ',
    blogDesc: 'AI活用と生産性について、一次出典に当たって確かめた事実をもとに書いています。Blue Aegis株式会社のメディア「Blue Aegis Media」。',
    blogIntro: 'AI活用と生産性について書いています。',
    blogIntroFeed: '更新は<a href="feed.xml">RSS</a>でも受け取れます。',
    empty: 'まだ記事がありません。',
    tagsLabel: 'タグ',
    tagJoin: '・',
    tagTitle: t => `${t}の記事`,
    tagDesc: t => `${t}に関する記事を新しい順に並べています。いずれも一次出典に当たって確かめた事実をもとに書いた、Blue Aegis株式会社のメディア「Blue Aegis Media」の記事です。`,
    tagIntro: t => `「${esc(t)}」に関する記事です。<a href="../index.html">ブログの全記事</a>もあわせてご覧ください。`,
    tagCount: n => `（${n}）`,
    srcPrimary: '一次出典', srcSecondary: '経由記事',
    srcCite: s => `${esc(s.publisher)}「${esc(s.title)}」${s.published ? `（${esc(String(s.published))}）` : ''}`,
    disclaimer: '本稿は公表資料に基づく整理であり、法的助言ではありません。',
    ctaBody: 'Blue Aegis株式会社は、規制対応を検証可能にする技術を研究開発し、その成果を特許として保有・提供しています。規制対応でお困りの場面がありましたら、判断がつかない段階でもご相談ください。',
    ctaLink: '相談する',
    backlink: '← ブログ一覧へ',
  },
  en: {
    htmlLang: 'en',
    navBlog: 'Blog', navInsights: 'Insights', navLicensing: 'Licensing', navContact: 'Contact',
    navPrivacy: 'Privacy Policy', navDisclaimer: 'Disclaimer',
    siteSuffix: ' | Blue Aegis Media',
    blogTitle: 'Blog',
    blogDesc: 'Notes on working with AI and on productivity, written from facts checked against their primary sources. Blue Aegis Media, published by Blue Aegis Inc.',
    blogIntro: 'Notes on working with AI and on productivity.',
    blogIntroFeed: 'You can also follow updates by <a href="feed.xml">RSS</a>.',
    empty: 'No articles yet.',
    tagsLabel: 'Tags',
    tagJoin: ' · ',
    tagTitle: t => `${t}`,
    tagDesc: t => `Articles on ${t}, newest first. Each is written from facts checked against their primary sources, and published as Blue Aegis Media by Blue Aegis Inc.`,
    tagIntro: t => `Articles on ${esc(t)}. You may also want <a href="../index.html">all articles</a>.`,
    tagCount: n => ` (${n})`,
    srcPrimary: 'Primary sources', srcSecondary: 'Secondary coverage',
    srcCite: s => `${esc(s.publisher)}, &ldquo;${esc(s.title)}&rdquo;${s.published ? ` (${esc(String(s.published))})` : ''}`,
    disclaimer: 'This note reflects publicly available material and is not legal advice.',
    ctaBody: 'Blue Aegis Inc. researches and develops technology that makes conformity with regulation verifiable, and holds the results as patents. If you are facing a compliance question — even one you have not yet been able to frame — we are glad to hear from you.',
    ctaLink: 'Get in touch',
    backlink: '← Back to Blog',
  },
};

/** その言語のトップまでの相対（英語は /en/ が起点） */
const langRoot = (up, lang) => up + (lang === 'en' ? 'en/' : '');

/**
 * タグ一覧のファイル名。
 * 英字だけのタグは小文字とハイフンに正規化する（URLに空白を入れないため）。
 * 日本語を含むタグはそのまま。既に公開しているURLを変えないための線引きでもある。
 */
function tagSlug(tag) {
  return /^[\x20-\x7E]+$/.test(tag)
    ? tag.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    : tag;
}

/** 記事・一覧・タグの出力先（言語で接頭辞が変わる） */
const blogDirOf = lang => (lang === 'en' ? 'en/blog' : 'blog');
const blogUrlOf = lang => `${BASE}/${blogDirOf(lang)}`;

/**
 * up はサイト直下までの相対（'../' など）。404 だけは絶対パスの '/' を渡す。
 * lang は本文とナビの言語。スタイル・スクリプト・favicon はサイト直下から引く。
 */
function page({ title, description, canonical, ogType, main, up = '../', robots, lang = 'ja', alternates }) {
  const t = T[lang];
  const L = langRoot(up, lang);
  const alt = alternates
    ? Object.entries(alternates).map(([k, v]) => `<link rel="alternate" hreflang="${k}" href="${v}">\n`).join('')
    : '';
  return `<!DOCTYPE html>
<html lang="${t.htmlLang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
${robots ? `<meta name="robots" content="${robots}">\n` : ''}<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:type" content="${ogType}">
<meta property="og:url" content="${canonical}">
<link rel="canonical" href="${canonical}">
${alt}<link rel="icon" href="${up}favicon.svg" type="image/svg+xml">
<script>document.documentElement.classList.add('js')</script>
<link rel="stylesheet" href="${up}style.css">
</head>
<body>

<header>
  <div class="wrap headbar">
    <a href="${L}index.html" style="display:block">
      ${LOGO}
    </a>
    <nav>
      <a href="${L}blog/index.html">${t.navBlog}</a>
      <a href="${L}insights/index.html">${t.navInsights}</a>
      <a href="${L}index.html#licensing">${t.navLicensing}</a>
      <a href="${L}index.html#contact">${t.navContact}</a>
    </nav>
  </div>
</header>

${main}

<footer>
  <div class="wrap">
    <div>© 2026 Blue Aegis Inc.</div>
    <div class="legal">
      <a href="${L}privacy.html">${t.navPrivacy}</a>
      <a href="${L}disclaimer.html">${t.navDisclaimer}</a>
      <a href="mailto:info@blueaegis.co.jp">info@blueaegis.co.jp</a>
    </div>
  </div>
</footer>

<script src="${up}script.js"></script>

${ANALYTICS}

</body>
</html>
`;
}

function sourcesHtml(sources, lang) {
  const t = T[lang];
  const group = (type, label) => {
    const list = (sources || []).filter(s => s.type === type);
    if (!list.length) return '';
    return `<p><strong>${label}</strong></p>\n    <ul>` + list.map(s =>
      `<li>${t.srcCite(s)}<br>` +
      `<a href="${esc(s.url)}" rel="noopener">${esc(s.url)}</a></li>`).join('') + '</ul>';
  };
  return group('primary', t.srcPrimary) + group('secondary', t.srcSecondary);
}

/** 記事本文中のタグ表示。一覧ページがあるタグはそこへ張る */
function tagLine(tags, tagPages, lang) {
  return (tags || []).map(x =>
    tagPages.has(x)
      ? `<a href="tags/${encodeURIComponent(tagSlug(x))}.html">${esc(x)}</a>`
      : esc(x)).join(T[lang].tagJoin);
}

function articleHtml(post, tagPages, lang, alternates) {
  const t = T[lang];
  const up = lang === 'en' ? '../../' : '../';
  const L = langRoot(up, lang);
  return page({
    lang, up, alternates,
    // 検索結果は幅で切られるので、長い見出しの記事は seoTitle で短い版を持てる。
    // ページ内の h1 は常に title のまま（表示は変えない）
    title: `${post.fm.seoTitle || post.fm.title}${t.siteSuffix}`,
    description: post.fm.description || '',
    canonical: `${blogUrlOf(lang)}/${post.slug}.html`,
    ogType: 'article',
    main: `<main class="wrap article">
  <p class="kicker">${mediaLogo('sm')}</p>
  <h1>${esc(post.fm.title)}</h1>
  <p class="meta">${esc(post.date)}${post.fm.tags && post.fm.tags.length ? `　${tagLine(post.fm.tags, tagPages, lang)}` : ''}</p>

  ${post.html}

  <div class="cta">
    <p>${t.ctaBody}</p>
    <a href="${L}index.html#contact">${t.ctaLink}</a>
  </div>

  <div class="source">
    ${sourcesHtml(post.fm.sources, lang)}
    <p>${t.disclaimer}</p>
  </div>

  <p class="backlink"><a href="index.html">${t.backlink}</a></p>
</main>`
  });
}

function postListHtml(posts, hrefOf) {
  return posts.map(p => `      <li>
        <a href="${hrefOf(p)}">
          <span class="date">${esc(p.date)}</span>
          <h3>${esc(p.fm.title)}</h3>
          <p>${esc(p.fm.description || '')}</p>
        </a>
      </li>`).join('\n');
}

function indexHtml(posts, tagPages, lang, alternates) {
  const t = T[lang];
  const up = lang === 'en' ? '../../' : '../';
  const items = postListHtml(posts, p => `${p.slug}.html`);
  const tags = [...tagPages.keys()].sort();
  const tagNav = tags.length ? `
    <nav class="taglinks" aria-label="${t.tagsLabel}">
      <span>${t.tagsLabel}</span>
      ${tags.map(x => `<a href="tags/${encodeURIComponent(tagSlug(x))}.html">${esc(x)}${t.tagCount(tagPages.get(x).length)}</a>`).join('\n      ')}
    </nav>` : '';

  return page({
    lang, up, alternates,
    title: `${t.blogTitle}${t.siteSuffix}`,
    description: t.blogDesc,
    canonical: `${blogUrlOf(lang)}/`,
    ogType: 'website',
    main: `<section>
  <div class="wrap">
    <p class="masthead">${mediaLogo('lg')}</p>
    <h1 class="lead">${t.blogTitle}</h1>
    <p class="intro">${t.blogIntro}<br>
    ${t.blogIntroFeed}</p>
${tagNav}
    <ul class="postlist">
${items || `      <li><p style="padding:28px 0">${t.empty}</p></li>`}
    </ul>
  </div>
</section>`
  });
}

function tagPageHtml(tag, posts, lang) {
  const t = T[lang];
  const up = lang === 'en' ? '../../../' : '../../';
  return page({
    lang, up,
    title: `${t.tagTitle(tag)}${t.siteSuffix}`,
    description: t.tagDesc(tag),
    canonical: `${blogUrlOf(lang)}/tags/${encodeURIComponent(tagSlug(tag))}.html`,
    ogType: 'website',
    main: `<section>
  <div class="wrap">
    <p class="masthead">${mediaLogo('lg')}</p>
    <h1 class="lead">${esc(tag)}</h1>
    <p class="intro">${t.tagIntro(tag)}</p>

    <ul class="postlist">
${postListHtml(posts, p => `../${p.slug}.html`)}
    </ul>
  </div>
</section>`
  });
}

/** GitHub Pages は存在しないパスすべてでこのページを返すので、参照は絶対パスにする */
function notFoundHtml() {
  return page({
    up: '/',
    robots: 'noindex',
    title: 'ページが見つかりません｜Blue Aegis株式会社',
    description: 'お探しのページは見つかりませんでした。Blue Aegis株式会社のサイト内の主な入口をご案内します。',
    canonical: `${BASE}/404.html`,
    ogType: 'website',
    main: `<main class="wrap article">
  <p class="kicker">404</p>
  <h1>ページが見つかりません</h1>
  <p class="meta">URLが変わったか、削除された可能性があります</p>

  <p>お探しのページは見つかりませんでした。以下からお探しください。</p>

  <ul>
    <li><a href="/index.html">トップページ</a> ― 事業内容と知的財産ポートフォリオ</li>
    <li><a href="/insights/index.html">規制解説</a> ― 法令の施行と改正の実務整理</li>
    <li><a href="/blog/index.html">ブログ</a> ― AI活用と生産性</li>
    <li><a href="/en/index.html">English</a></li>
  </ul>

  <div class="cta">
    <p>お探しの内容が見つからない場合や、規制対応でお困りの場面がある場合は、判断がつかない段階でもご相談ください。</p>
    <a href="/index.html#contact">相談する</a>
  </div>
</main>`
  });
}

/* ---------------- 静的ファイルの複製 ---------------- */
function copyDir(from, to, top = true) {
  fs.mkdirSync(to, { recursive: true });
  for (const name of fs.readdirSync(from)) {
    if (top && (SKIP.has(name) || SKIP_TOP.test(name))) continue;
    if (name.startsWith('.') && name !== '.nojekyll') continue;
    const s = path.join(from, name), d = path.join(to, name);
    if (fs.statSync(s).isDirectory()) copyDir(s, d, false);
    else fs.copyFileSync(s, d);
  }
}

function listHtml(dir, root = dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) listHtml(p, root, out);
    else if (name.endsWith('.html')) out.push(path.relative(root, p).replace(/\\/g, '/'));
  }
  return out;
}

/* ---------------- 仕上げ ----------------
   出来上がった HTML を1枚ずつ読み、共通の要素を足していく。
   手で書いたページも生成したページも同じ経路を通るので、
   新しいページを足したときに構造化データやOGP画像を付け忘れることがない。 */

const L = {
  ja: { crumbHome: 'ホーム', here: '現在地', related: '関連する記事', more: 'この分類の他の記事',
        feedLine: '施行と改正を追っています。更新は<a href="feed.xml">RSS</a>で受け取れます。' },
  en: { crumbHome: 'Home',   here: 'Breadcrumb', related: 'Related articles', more: 'More in this section',
        feedLine: 'We follow these rules as they come into force. Updates are available by <a href="feed.xml">RSS</a>.' },
};

const OG_KICKER = {
  insights: 'Regulatory Insight',
  blog: 'Blue Aegis Media',
  tags: 'Blue Aegis Media',
  null: 'Intellectual Property Licensing',
};

/** OGP画像のファイル名。タグ名など日本語を含むパスもあるので、必ずASCIIに落とす */
function ogName(relPath) {
  const stem = relPath.replace(/\.html$/, '').replace(/\//g, '-');
  const safe = stem.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (safe === stem) return `og/${stem}.png`;

  let h = 0x811c9dc5;
  for (let i = 0; i < stem.length; i++) { h ^= stem.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return `og/${safe || 'page'}-${h.toString(36)}.png`;
}

/** そのページから見た、サイト直下への相対プレフィックス */
function upFrom(relPath) {
  const depth = relPath.split('/').length - 1;
  return depth === 0 ? '' : '../'.repeat(depth);
}

function crumbsHtml(desc, cls) {
  const t = L[cls.lang], S = seo.SECTION[cls.lang];
  // 英語版の起点は /en/ なので、言語ごとに根を変える。日本語ページへ混ぜて戻さないこと
  const up = upFrom(desc.relPath) + (cls.lang === 'en' ? 'en/' : '');
  const parts = [`<a href="${up || './'}index.html">${t.crumbHome}</a>`];

  if (cls.section === 'insights') parts.push(`<a href="${up}insights/index.html">${S.insights}</a>`);
  if (cls.section === 'blog' || cls.section === 'tags') parts.push(`<a href="${up}blog/index.html">${S.blog}</a>`);
  parts.push(`<span aria-current="page">${esc(desc.h1 || desc.title)}</span>`);

  return `<nav class="crumbs" aria-label="${t.here}">${parts.join('<span class="sep" aria-hidden="true">/</span>')}</nav>\n  `;
}

function relatedHtml(desc, cls, siblings, tagsOf) {
  const mine = tagsOf(desc.relPath);
  const scored = siblings
    .filter(s => s.relPath !== desc.relPath)
    .map(s => {
      const theirs = tagsOf(s.relPath);
      const shared = mine.filter(t => theirs.includes(t)).length;
      return { s, shared, date: seo.isoDate(s.metaLine) || '' };
    })
    .sort((a, b) => b.shared - a.shared || (a.date < b.date ? 1 : -1))
    .slice(0, RELATED_MAX);

  if (!scored.length) return '';

  const t = L[cls.lang];
  const here = path.posix.dirname(desc.relPath);
  const items = scored.map(({ s, date }) => {
    const href = path.posix.relative(here, s.relPath).split('/').map(encodeURIComponent).join('/');
    return `      <li><a href="${href}">` +
      (date ? `<span class="date">${esc(date)}</span>` : '') +
      `<span class="t">${esc(s.h1 || s.title)}</span></a></li>`;
  }).join('\n');

  return `<aside class="related">
    <h2>${mine.length ? t.related : t.more}</h2>
    <ul>
${items}
    </ul>
  </aside>

  `;
}

function finish(loaded, tagPages) {
  const buildDate = new Date();
  const files = listHtml(OUT).sort();

  // 記事の frontmatter を出力パスで引けるようにしておく（日英とも）
  const byPath = new Map();
  for (const lang of ['ja', 'en']) {
    for (const p of loaded[lang].posts) byPath.set(`${blogDirOf(lang)}/${p.slug}.html`, p);
  }
  const tagsOf = rel => {
    const p = byPath.get(rel);
    return p ? (p.fm.tags || []) : [];
  };

  const pages = files.map(rel => {
    const html = fs.readFileSync(path.join(OUT, rel), 'utf8');
    return { rel, html, desc: seo.describePage(html, rel), cls: seo.classify(rel) };
  });

  fs.mkdirSync(path.join(OUT, 'og'), { recursive: true });
  fs.writeFileSync(path.join(OUT, 'og', 'logo.png'), logoPng());

  /* 見た目と挙動のファイルは名前が変わらないので、中身を直しても
     端末とGitHub Pagesの配信面が古いものを使い続ける（記事は新しいURLに
     なるので出るが、CSSの修正だけは何時間も反映されないことがある）。
     中身から作った版番号を問い合わせに付け、変えたときだけ別のURLにする。
     検査のリンク照合は ? の手前だけを見るので、これで切れることはない。 */
  const assetV = {};
  for (const file of ['style.css', 'script.js']) {
    assetV[file] = crypto.createHash('sha256')
      .update(fs.readFileSync(path.join(OUT, file))).digest('hex').slice(0, 8);
  }
  /* 404 はどの階層で表示されるか決まらないので絶対パスで書いてある。相対と両方を見る */
  const stampAssets = html => html.replace(
    /(href|src)="(\/|(?:\.\.\/)*)(style\.css|script\.js)"/g,
    (m, attr, up, file) => `${attr}="${up}${file}?v=${assetV[file]}"`);

  const sitemap = [];

  for (const page of pages) {
    const { rel, desc, cls } = page;
    let html = page.html;

    /* --- 共有カード --- */
    const post = byPath.get(rel);
    const dateLine = post ? post.date : (seo.isoDate(desc.metaLine) || '');
    const img = ogName(rel);
    fs.writeFileSync(path.join(OUT, img), ogCard({
      kicker: OG_KICKER[cls.section] || OG_KICKER.null,
      line: dateLine,
      seed: rel,
    }));

    /* --- パンくずと関連記事を本文へ --- */
    if (cls.kind === 'article') {
      // 手で書いたページは改行コードが CRLF のことがあるので、空白の並びは決め打ちにしない
      html = html.replace(/<main class="wrap article">\s*/,
                          m => m + crumbsHtml(desc, cls));

      const siblings = pages
        .filter(p => p.cls.kind === 'article' && p.cls.section === cls.section && p.cls.lang === cls.lang)
        .map(p => p.desc);
      const block = relatedHtml(desc, cls, siblings, tagsOf);
      if (block) html = html.replace('<p class="backlink">', block + '<p class="backlink">');
    }

    /* --- 規制解説の購読導線 ---
       施行日が先にある規制ほど、読んだ時点では動けない。次の改正まで
       つながっていられる経路を、記事と一覧の両方に置く。 */
    if (cls.section === 'insights') {
      const line = `<p class="subscribe">${L[cls.lang].feedLine}</p>\n\n  `;
      html = cls.kind === 'article'
        ? html.replace('<p class="backlink">', line + '<p class="backlink">')
        : html.replace('</ul>\n  </div>', `</ul>\n\n    ${line}</div>`);
    }

    /* --- 問い合わせの出所 ---
       どの記事を読んで相談に至ったのかが、届くメールの本文で分かるようにする。
       外部サービスもCookieも使わない。パスを1つ足すだけ。
       トップ自身の導線は「#contact」なので、ここでは書き換わらない。 */
    html = html.replace(/href="([^"]*index\.html)#contact"/g,
      (m, to) => `href="${to}?from=${rel.split('/').map(encodeURIComponent).join('/')}#contact"`);

    html = stampAssets(html);

    /* --- head --- */
    html = seo.enhanceHead(html, desc, cls, {
      ogImage: `${BASE}/${img}`,
      datePublished: post ? post.date : null,
      author: post ? post.fm.author : null,
      keywords: post ? post.fm.tags : null,
    });

    fs.writeFileSync(path.join(OUT, rel), html);

    if (cls.kind !== 'notfound') {
      sitemap.push({ desc, lastmod: cls.kind === 'article' ? (dateLine || null) : seo.todayJst(buildDate) });
    }
  }

  fs.writeFileSync(path.join(OUT, 'sitemap.xml'), seo.buildSitemap(sitemap));
  writeFeeds(loaded, pages, buildDate);

  return { pageCount: pages.length, tagPages };
}

/**
 * 購読の入口を系統ごとに書き出す。
 *
 * ブログは frontmatter から、規制解説は出力したHTMLから作る。
 * 規制解説は手書きで、記事の一覧をどこにも持っていない。ここで数え上げるので、
 * 1本足したらフィードにも載る（載せ忘れる経路がない）。
 *
 * 系統を分けているのは読者が違うからで、混ぜてはいけない。規制解説を購読した人に
 * AI活用の記事が流れると、購読の意味がなくなる。
 */
function writeFeeds(loaded, pages, buildDate) {
  const write = (dir, xml) => {
    const abs = path.join(OUT, ...dir.split('/'));
    fs.mkdirSync(abs, { recursive: true });
    fs.writeFileSync(path.join(abs, 'feed.xml'), xml);
  };

  for (const lang of ['ja', 'en']) {
    const blogDir = blogDirOf(lang);
    write(blogDir, seo.buildFeed(loaded[lang].posts.map(p => ({
      title: p.fm.title,
      url: `${BASE}/${blogDir}/${p.slug}.html`,
      date: p.date,
      description: p.fm.description || '',
      categories: p.fm.tags || [],
    })), buildDate, lang, 'blog'));

    const insightItems = pages
      .filter(p => p.cls.section === 'insights' && p.cls.kind === 'article' && p.cls.lang === lang)
      .map(p => ({ d: p.desc, date: seo.isoDate(p.desc.metaLine) || '' }))
      .sort((a, b) => (a.date < b.date ? 1 : -1))
      .map(({ d, date }) => ({
        title: d.h1 || d.title,
        url: d.url,
        date,
        description: d.description,
        categories: [],
      }));
    write(lang === 'en' ? 'en/insights' : 'insights',
          seo.buildFeed(insightItems, buildDate, lang, 'insights'));
  }
}

/* ---------------- 実行 ---------------- */

/** 1言語ぶんの記事を読み、検証して返す */
function loadPosts(lang) {
  const dir = SRC[lang];
  const files = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter(f => f.endsWith('.md')).sort().reverse()
    : [];

  const posts = [];
  let drafts = 0;

  for (const file of files) {
    const raw = fs.readFileSync(path.join(dir, file), 'utf8');
    const [fm, body] = parseFrontmatter(raw, file);
    const meta = validate(file, fm, body);
    if (!meta || !fm) continue;
    if (fm.draft === true) { drafts++; continue; }   // 下書きは公開ビルドに載せない
    posts.push({ ...meta, fm, lang, html: renderMarkdown(body, file) });
  }
  return { files, posts, drafts };
}

/** タグごとの本数を数え、下限に達したものだけ一覧ページを持つ */
function tagPagesOf(posts, lang) {
  const byTag = new Map();
  for (const p of posts) for (const t of (p.fm.tags || [])) {
    if (!byTag.has(t)) byTag.set(t, []);
    byTag.get(t).push(p);
  }
  const keep = new Map([...byTag].filter(([, list]) => list.length >= TAG_PAGE_MIN));
  const held = [...byTag].filter(([, list]) => list.length < TAG_PAGE_MIN);
  if (held.length) {
    console.log(`[${lang}] タグ一覧は ${TAG_PAGE_MIN} 本以上のタグにのみ作成。今回見送り: `
      + held.map(([t, l]) => `${t}(${l.length})`).join('、'));
  }
  return keep;
}

/** 1言語ぶんのブログを出力する */
function writeBlog(posts, tagPages, lang, pairs) {
  const dir = path.join(OUT, ...blogDirOf(lang).split('/'));
  fs.mkdirSync(dir, { recursive: true });

  for (const p of posts) {
    // 同じ slug の記事が両言語にあれば、互いを指し合う宣言を付ける
    const pair = pairs.get(p.slug);
    const alternates = pair && pair.ja && pair.en
      ? { ja: `${BASE}/blog/${p.slug}.html`, en: `${BASE}/en/blog/${p.slug}.html` }
      : null;
    fs.writeFileSync(path.join(dir, `${p.slug}.html`), articleHtml(p, tagPages, lang, alternates));
  }

  // 一覧どうしは常に対になる
  fs.writeFileSync(path.join(dir, 'index.html'),
    indexHtml(posts, tagPages, lang, { ja: `${BASE}/blog/`, en: `${BASE}/en/blog/` }));

  if (tagPages.size) {
    fs.mkdirSync(path.join(dir, 'tags'), { recursive: true });
    for (const [tag, list] of tagPages) {
      fs.writeFileSync(path.join(dir, 'tags', `${tagSlug(tag)}.html`), tagPageHtml(tag, list, lang));
    }
  }
  return dir;
}

function main() {
  const loaded = { ja: loadPosts('ja'), en: loadPosts('en') };

  if (warnings.length) {
    console.log('警告:');
    warnings.forEach(w => console.log('  ' + w));
  }
  if (errors.length) {
    console.error('検証エラー:');
    errors.forEach(e => console.error('  ' + e));
    process.exit(1);
  }
  for (const lang of ['ja', 'en']) {
    const { files, posts, drafts } = loaded[lang];
    console.log(`[${lang}] 記事 ${files.length} 件を検証（公開 ${posts.length} / 下書き ${drafts}）`);
  }

  if (VALIDATE_ONLY) { console.log('検証のみ。ビルドは行いません。'); return; }

  // slug が一致する記事どうしを翻訳の対とみなす
  const pairs = new Map();
  for (const lang of ['ja', 'en']) {
    for (const p of loaded[lang].posts) {
      if (!pairs.has(p.slug)) pairs.set(p.slug, {});
      pairs.get(p.slug)[lang] = p;
    }
  }

  fs.rmSync(OUT, { recursive: true, force: true });
  copyDir(ROOT, OUT);

  const tagPages = {};
  for (const lang of ['ja', 'en']) {
    tagPages[lang] = tagPagesOf(loaded[lang].posts, lang);
    writeBlog(loaded[lang].posts, tagPages[lang], lang, pairs);
  }

  fs.writeFileSync(path.join(OUT, '404.html'), notFoundHtml());

  const { pageCount } = finish(loaded, tagPages);
  console.log(`_site/ を生成（HTML ${pageCount} ページ、タグ一覧 ja:${tagPages.ja.size} en:${tagPages.en.size}、OGP画像 ${pageCount + 1} 枚）`);

  /* 仕上がりの検査。ここで落ちたら配信しない */
  const result = audit(OUT);
  if (result.warnings.length) {
    console.log('検査の警告:');
    result.warnings.forEach(w => console.log('  ' + w));
  }
  if (result.errors.length) {
    console.error('検査エラー:');
    result.errors.forEach(e => console.error('  ' + e));
    process.exit(1);
  }
  console.log(`検査 ${result.count} ページ：問題なし`);
}

main();
