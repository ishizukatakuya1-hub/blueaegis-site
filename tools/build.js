#!/usr/bin/env node
/**
 * Blue Aegis サイトビルド
 *
 * content/blog/*.md を読み、_site/ に静的サイトを組み立てる。
 * 外部ライブラリに依存しない。自動掲載の経路に供給網の攻撃面を持ち込まないため。
 *
 *   node tools/build.js                  ビルド（_site/ を生成）
 *   node tools/build.js --validate-only  検証のみ（PRのCIで使用）
 *
 * 記事ファイルの規約は PUBLISHING.md を正とする。ここを変えたら向こうも直すこと。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'content', 'blog');
const OUT = path.join(ROOT, '_site');
const VALIDATE_ONLY = process.argv.includes('--validate-only');

/* ビルド出力に含めない（生成物・道具・設定） */
const SKIP = new Set(['content', 'tools', '_site', 'node_modules', '.git', '.github',
                      'package.json', 'package-lock.json', 'PUBLISHING.md', 'HANDOVER.md', '.claude']);

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
  if (fm.title && fm.title.length > 60) warn(file, `title が長い（${fm.title.length}字）`);
  if (fm.description && fm.description.length > 120) warn(file, `description が長い（${fm.description.length}字）`);

  return { slug, date: fileDate };
}

/* ---------------- Markdown（規約で許す範囲のみ） ---------------- */
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

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

const ANALYTICS = `<!-- Cloudflare Web Analytics --><script defer src='https://static.cloudflareinsights.com/beacon.min.js' data-cf-beacon='{"token": "d0e128ca55ff42f8b920003d57f49159"}'></script><!-- End Cloudflare Web Analytics -->`;

function page({ title, description, canonical, ogType, main }) {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:type" content="${ogType}">
<meta property="og:url" content="${canonical}">
<link rel="canonical" href="${canonical}">
<link rel="icon" href="../favicon.svg" type="image/svg+xml">
<script>document.documentElement.classList.add('js')</script>
<link rel="stylesheet" href="../style.css">
</head>
<body>

<header>
  <div class="wrap headbar">
    <a href="../index.html" style="display:block">
      ${LOGO}
    </a>
    <nav>
      <a href="index.html">ブログ</a>
      <a href="../insights/index.html">規制解説</a>
      <a href="../index.html#licensing">ライセンス</a>
      <a href="../index.html#contact">お問い合わせ</a>
    </nav>
  </div>
</header>

${main}

<footer>
  <div class="wrap">
    <div>© 2026 Blue Aegis Inc.</div>
    <div><a href="mailto:info@blueaegis.co.jp">info@blueaegis.co.jp</a></div>
  </div>
</footer>

<script src="../script.js"></script>

${ANALYTICS}

</body>
</html>
`;
}

function sourcesHtml(sources) {
  const group = (type, label) => {
    const list = (sources || []).filter(s => s.type === type);
    if (!list.length) return '';
    return `<p><strong>${label}</strong></p>\n    <ul>` + list.map(s =>
      `<li>${esc(s.publisher)}「${esc(s.title)}」${s.published ? `（${esc(String(s.published))}）` : ''}<br>` +
      `<a href="${esc(s.url)}" rel="noopener">${esc(s.url)}</a></li>`).join('') + '</ul>';
  };
  return group('primary', '一次出典') + group('secondary', '経由記事');
}

function articleHtml(post) {
  const tags = (post.fm.tags || []).map(t => esc(t)).join('・');
  return page({
    title: `${post.fm.title}｜Blue Aegis Media`,
    description: post.fm.description || '',
    canonical: `https://blueaegis.co.jp/blog/${post.slug}.html`,
    ogType: 'article',
    main: `<main class="wrap article">
  <p class="kicker">BLUE AEGIS MEDIA</p>
  <h1>${esc(post.fm.title)}</h1>
  <p class="meta">${esc(post.date)}${tags ? `　${tags}` : ''}</p>

  ${post.html}

  <div class="cta">
    <p>Blue Aegis株式会社は、規制対応を検証可能にする技術を研究開発し、その成果を特許として保有・提供しています。規制対応でお困りの場面がありましたら、判断がつかない段階でもご相談ください。</p>
    <a href="../index.html#contact">相談する</a>
  </div>

  <div class="source">
    ${sourcesHtml(post.fm.sources)}
    <p>本稿は公表資料に基づく整理であり、法的助言ではありません。</p>
  </div>

  <p class="backlink"><a href="index.html">← ブログ一覧へ</a></p>
</main>`
  });
}

function indexHtml(posts) {
  const items = posts.map(p => `      <li>
        <a href="${p.slug}.html">
          <span class="date">${esc(p.date)}</span>
          <h3>${esc(p.fm.title)}</h3>
          <p>${esc(p.fm.description || '')}</p>
        </a>
      </li>`).join('\n');

  return page({
    title: 'ブログ｜Blue Aegis Media',
    description: 'AI活用と生産性について、一次出典に当たって確かめた事実をもとに書いています。Blue Aegis株式会社のメディア「Blue Aegis Media」。',
    canonical: 'https://blueaegis.co.jp/blog/',
    ogType: 'website',
    main: `<section>
  <div class="wrap">
    <h2>BLUE AEGIS MEDIA</h2>
    <div class="lead">ブログ</div>
    <p class="intro">AI活用と生産性について書いています。数字や調査を引くときは必ず一次出典まで辿り、媒体名・タイトル・公開日・URLを明記します。誇張した効果や収益の保証は書きません。<br>
    規制そのものの解説は<a href="../insights/index.html">規制解説</a>に分けています。</p>

    <ul class="postlist">
${items || '      <li><p style="padding:28px 0">まだ記事がありません。</p></li>'}
    </ul>
  </div>
</section>`
  });
}

/* ---------------- sitemap ----------------
   記事が増えるたびに手で足すと必ず漏れるので、ビルド時に組み立てる。
   手書きページは固定、ブログは公開分だけを列挙する。 */
const STATIC_PAGES = [
  { loc: '/',                                          alt: { ja: '/', en: '/en/' } },
  { loc: '/en/',                                       alt: { ja: '/', en: '/en/' } },
  { loc: '/insights/' },
  { loc: '/insights/eu-ai-act-transparency.html',
    alt: { ja: '/insights/eu-ai-act-transparency.html', en: '/en/insights/eu-ai-act-transparency.html' } },
  { loc: '/en/insights/eu-ai-act-transparency.html',
    alt: { ja: '/insights/eu-ai-act-transparency.html', en: '/en/insights/eu-ai-act-transparency.html' } },
  { loc: '/insights/aml-ekyc-2027.html' },
  { loc: '/insights/housing-safety-net-postmortem.html' },
  { loc: '/insights/eudi-wallet-relying-party.html' },
  { loc: '/blog/' },
];

function writeSitemap(posts) {
  const BASE = 'https://blueaegis.co.jp';
  const today = new Date().toISOString().slice(0, 10);
  const entry = (loc, lastmod, alt) =>
    `  <url>\n    <loc>${BASE}${loc}</loc>\n    <lastmod>${lastmod}</lastmod>\n` +
    (alt ? `    <xhtml:link rel="alternate" hreflang="ja" href="${BASE}${alt.ja}"/>\n` +
           `    <xhtml:link rel="alternate" hreflang="en" href="${BASE}${alt.en}"/>\n` : '') +
    `  </url>`;

  const urls = [
    ...STATIC_PAGES.map(p => entry(p.loc, today, p.alt)),
    ...posts.map(p => entry(`/blog/${p.slug}.html`, p.date)),
  ];

  fs.writeFileSync(path.join(OUT, 'sitemap.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"\n` +
    `        xmlns:xhtml="http://www.w3.org/1999/xhtml">\n` +
    urls.join('\n') + `\n</urlset>\n`);
}

/* ---------------- 静的ファイルの複製 ---------------- */
function copyDir(from, to, top = true) {
  fs.mkdirSync(to, { recursive: true });
  for (const name of fs.readdirSync(from)) {
    if (top && SKIP.has(name)) continue;
    if (name.startsWith('.') && name !== '.nojekyll') continue;
    const s = path.join(from, name), d = path.join(to, name);
    if (fs.statSync(s).isDirectory()) copyDir(s, d, false);
    else fs.copyFileSync(s, d);
  }
}

/* ---------------- 実行 ---------------- */
function main() {
  const files = fs.existsSync(SRC)
    ? fs.readdirSync(SRC).filter(f => f.endsWith('.md')).sort().reverse()
    : [];

  const posts = [];
  let drafts = 0;

  for (const file of files) {
    const raw = fs.readFileSync(path.join(SRC, file), 'utf8');
    const [fm, body] = parseFrontmatter(raw, file);
    const meta = validate(file, fm, body);
    if (!meta || !fm) continue;
    if (fm.draft === true) { drafts++; continue; }   // 下書きは公開ビルドに載せない
    posts.push({ ...meta, fm, html: renderMarkdown(body, file) });
  }

  if (warnings.length) {
    console.log('警告:');
    warnings.forEach(w => console.log('  ' + w));
  }
  if (errors.length) {
    console.error('検証エラー:');
    errors.forEach(e => console.error('  ' + e));
    process.exit(1);
  }
  console.log(`記事 ${files.length} 件を検証（公開 ${posts.length} / 下書き ${drafts}）`);

  if (VALIDATE_ONLY) { console.log('検証のみ。ビルドは行いません。'); return; }

  fs.rmSync(OUT, { recursive: true, force: true });
  copyDir(ROOT, OUT);
  const blogDir = path.join(OUT, 'blog');
  fs.mkdirSync(blogDir, { recursive: true });
  for (const p of posts) fs.writeFileSync(path.join(blogDir, `${p.slug}.html`), articleHtml(p));
  fs.writeFileSync(path.join(blogDir, 'index.html'), indexHtml(posts));

  writeSitemap(posts);
  console.log(`_site/ を生成（ブログ ${posts.length + 1} ページを含む）`);
}

main();
