'use strict';
/**
 * 検索・共有まわりの機械化。
 *
 * ページを手で書いても自動で生成しても、ここを通れば同じ水準の
 * 構造化データ・OGP・言語相互宣言・サイトマップが付く。
 * 「新しいページを足したときに付け忘れる」経路を潰すのが目的。
 *
 * 構造化データに載せてよいのは、そのページに表示されている事実だけ。
 * 会社概要に出していない項目（代表者名・所在地・法人番号）は
 * 意図的に伏せているので、Organization にも書かない。ここは戻さないこと。
 */

const BASE = 'https://blueaegis.co.jp';

const SITE = {
  ja: { name: 'Blue Aegis株式会社', locale: 'ja_JP', home: 'ホーム' },
  en: { name: 'Blue Aegis Inc.',    locale: 'en_US', home: 'Home' },
};

const SECTION = {
  ja: { insights: '規制解説', blog: 'ブログ', tags: 'タグ' },
  en: { insights: 'Insights', blog: 'Blog',   tags: 'Tags' },
};

/* ---------------- 文字まわり ---------------- */

const escAttr = s => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** HTMLから取り出した文字列を素のテキストへ戻す（構造化データはHTMLではない） */
function unesc(s) {
  return String(s)
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ').trim();
}

/** 全角を2、半角を1として数える。検索結果での見え方はこの幅に近い */
function displayWidth(s) {
  let n = 0;
  for (const ch of String(s)) n += ch.codePointAt(0) > 0xFF ? 2 : 1;
  return n;
}

function jsonLd(obj) {
  // </script> でHTMLを壊さないようにする
  return `<script type="application/ld+json">${JSON.stringify(obj).replace(/</g, '\\u003c')}</script>`;
}

/* ---------------- ページの読み取り ----------------
   出力された HTML から、そのページが何であるかを読み取る。
   手書きのページも生成したページも同じ経路を通す。 */

function firstMatch(re, s) { const m = re.exec(s); return m ? m[1] : null; }

function describePage(html, relPath) {
  // タグ名などパスに日本語が入りうるので、URLとして出すときは必ず百分率符号化する
  const rel = relPath.replace(/\\/g, '/').replace(/(^|\/)index\.html$/, '$1');
  const url = BASE + '/' + rel.split('/').map(encodeURIComponent).join('/');

  const alternates = {};
  const reAlt = /<link\s+rel="alternate"\s+hreflang="([^"]+)"\s+href="([^"]+)"/g;
  let m;
  while ((m = reAlt.exec(html)) !== null) alternates[m[1]] = m[2];

  const postlist = [];
  const reItem = /<li>\s*<a href="([^"]+)">[\s\S]*?<h3>([\s\S]*?)<\/h3>/g;
  while ((m = reItem.exec(html)) !== null) postlist.push({ href: m[1], title: unesc(m[2]) });

  const sourceBlock = firstMatch(/<div class="source">([\s\S]*?)<\/div>/, html) || '';
  const citations = [];
  const reCite = /href="(https?:\/\/[^"]+)"/g;
  while ((m = reCite.exec(sourceBlock)) !== null) citations.push(m[1]);

  return {
    relPath: relPath.replace(/\\/g, '/'),
    url,
    lang: firstMatch(/<html lang="([^"]+)"/, html) || 'ja',
    title: unesc(firstMatch(/<title>([\s\S]*?)<\/title>/, html) || ''),
    ogTitle: unesc(firstMatch(/<meta property="og:title" content="([^"]*)"/, html) || ''),
    description: unesc(firstMatch(/<meta name="description" content="([^"]*)"/, html) || ''),
    canonical: firstMatch(/<link rel="canonical" href="([^"]+)"/, html),
    ogType: firstMatch(/<meta property="og:type" content="([^"]+)"/, html) || 'website',
    h1: unesc(firstMatch(/<h1[^>]*>([\s\S]*?)<\/h1>/, html) || ''),
    kicker: unesc(firstMatch(/<p class="kicker">([\s\S]*?)<\/p>/, html) || ''),
    metaLine: unesc(firstMatch(/<p class="meta">([\s\S]*?)<\/p>/, html) || ''),
    alternates,
    postlist,
    citations: [...new Set(citations)],
  };
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june',
                'july', 'august', 'september', 'october', 'november', 'december'];

/** 「2026年8月22日」「2026-08-22」「22 August 2026」のいずれでも ISO の日付にする */
function isoDate(text) {
  if (!text) return null;
  const pad = n => String(n).padStart(2, '0');

  let m = /(\d{4})年(\d{1,2})月(\d{1,2})日/.exec(text);
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;

  m = /(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (m) return m[0];

  m = /(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/.exec(text);
  if (m) {
    const mo = MONTHS.indexOf(m[2].toLowerCase());
    if (mo >= 0) return `${m[3]}-${pad(mo + 1)}-${pad(m[1])}`;
  }
  return null;
}

/**
 * 構造化データに載せる日時。
 * 日付だけだと Google が「日時値が無効」「タイムゾーンがありません」と警告するので、
 * 記事の公開日（JST）として時刻と時差まで書く。
 */
function dateTimeJst(isoDay) {
  return isoDay ? `${isoDay}T00:00:00+09:00` : null;
}

/**
 * 日本時間での「今日」。
 * ビルドは UTC の実行環境で動くので、toISOString() をそのまま使うと前日になる。
 */
function todayJst(now = new Date()) {
  return new Date(now.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

/* ---------------- ページの区分 ---------------- */

function classify(relPath) {
  const p = relPath.replace(/\\/g, '/');
  const lang = p.startsWith('en/') ? 'en' : 'ja';
  const rest = lang === 'en' ? p.slice(3) : p;

  if (rest === 'index.html') return { kind: 'home', lang, section: null };
  if (rest === '404.html') return { kind: 'notfound', lang, section: null };
  if (rest === 'insights/index.html') return { kind: 'collection', lang, section: 'insights' };
  if (rest.startsWith('insights/')) return { kind: 'article', lang, section: 'insights' };
  if (rest === 'blog/index.html') return { kind: 'collection', lang, section: 'blog' };
  if (rest.startsWith('blog/tags/')) return { kind: 'collection', lang, section: 'tags' };
  if (rest.startsWith('blog/')) return { kind: 'article', lang, section: 'blog' };
  return { kind: 'page', lang, section: null };
}

/* ---------------- 構造化データ ---------------- */

const ORG_ID = `${BASE}/#organization`;

/**
 * 会社そのもの。全ページから参照する。
 * ここに住所・代表者名・法人番号を足さないこと（会社概要から意図的に外している）。
 */
function organization(lang) {
  return {
    '@type': 'Organization',
    '@id': ORG_ID,
    name: SITE[lang].name,
    /* 商号の読み。katakana の「ブルーイージス」を宣言しておかないと、
       その表記での検索に対して当サイト側に手掛かりが一切なくなる（実際に順位が付いていなかった）。
       §4-5 の伏せる対象（代表者名・所在地・法人番号）ではないので、ここに置いてよい。 */
    alternateName: lang === 'ja'
      ? ['ブルーイージス', 'Blue Aegis Inc.']
      : ['Blue Aegis株式会社', 'ブルーイージス'],
    url: BASE + '/',
    email: 'info@blueaegis.co.jp',
    logo: { '@type': 'ImageObject', url: `${BASE}/og/logo.png`, width: 512, height: 512 },
    description: lang === 'ja'
      ? '規制対応技術の研究開発と、自ら創出した知的財産の保有・ライセンスを行う会社。'
      : 'Develops regulatory compliance technology and holds and licenses the intellectual property it creates.',
  };
}

function breadcrumbs(desc, cls) {
  const S = SECTION[cls.lang], root = cls.lang === 'en' ? `${BASE}/en/` : `${BASE}/`;
  const items = [{ name: SITE[cls.lang].home, item: root }];

  if (cls.section === 'insights') items.push({ name: S.insights, item: `${root}insights/` });
  if (cls.section === 'blog' || cls.section === 'tags') items.push({ name: S.blog, item: `${root}blog/` });
  if (cls.section === 'tags') items.push({ name: S.tags, item: null });
  if (cls.kind === 'article') items.push({ name: desc.h1 || desc.title, item: desc.url });
  if (cls.kind === 'collection' && cls.section === 'tags') items.push({ name: desc.h1 || desc.title, item: desc.url });

  return {
    '@type': 'BreadcrumbList',
    itemListElement: items.map((it, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: it.name,
      ...(it.item ? { item: it.item } : {}),
    })),
  };
}

/**
 * ページ1枚ぶんの構造化データ。
 * extra には、生成したブログ記事のときだけ frontmatter 由来の情報が入る。
 */
function structuredData(desc, cls, extra) {
  const lang = cls.lang;
  const graph = [organization(lang)];

  graph.push({
    '@type': 'WebSite',
    '@id': `${BASE}/#website`,
    url: BASE + '/',
    name: SITE[lang].name,
    inLanguage: lang,
    publisher: { '@id': ORG_ID },
  });

  if (cls.kind !== 'notfound') graph.push(breadcrumbs(desc, cls));

  if (cls.kind === 'article') {
    const published = extra.datePublished || isoDate(desc.metaLine);
    graph.push({
      '@type': cls.section === 'blog' ? 'BlogPosting' : 'Article',
      '@id': desc.url + '#article',
      mainEntityOfPage: desc.url,
      url: desc.url,
      headline: desc.h1 || desc.title,
      description: desc.description,
      inLanguage: lang,
      isAccessibleForFree: true,
      ...(published ? { datePublished: dateTimeJst(published),
                        dateModified: dateTimeJst(extra.dateModified || published) } : {}),
      author: extra.author
        ? { '@type': 'Organization', name: extra.author, url: BASE + '/' }
        : { '@id': ORG_ID },
      publisher: { '@id': ORG_ID },
      image: { '@type': 'ImageObject', url: extra.ogImage, width: 1200, height: 630 },
      ...(extra.keywords && extra.keywords.length ? { keywords: extra.keywords.join(', ') } : {}),
      // 一次出典に当たって書いていることは、この会社の記事の性格そのものなので機械にも伝える
      ...(desc.citations.length ? { citation: desc.citations.map(u => ({ '@type': 'CreativeWork', url: u })) } : {}),
    });
  }

  if (cls.kind === 'collection') {
    graph.push({
      '@type': 'CollectionPage',
      '@id': desc.url + '#collection',
      url: desc.url,
      name: desc.h1 || desc.title,
      description: desc.description,
      inLanguage: lang,
      isPartOf: { '@id': `${BASE}/#website` },
      ...(desc.postlist.length ? {
        mainEntity: {
          '@type': 'ItemList',
          numberOfItems: desc.postlist.length,
          itemListElement: desc.postlist.map((p, i) => ({
            '@type': 'ListItem',
            position: i + 1,
            name: p.title,
            url: new URL(p.href, desc.url).href,
          })),
        },
      } : {}),
    });
  }

  if (cls.kind === 'home') {
    graph.push({
      '@type': 'WebPage',
      '@id': desc.url + '#webpage',
      url: desc.url,
      name: desc.title,
      description: desc.description,
      inLanguage: lang,
      isPartOf: { '@id': `${BASE}/#website` },
      about: { '@id': ORG_ID },
    });
  }

  return { '@context': 'https://schema.org', '@graph': graph };
}

/* ---------------- head への注入 ---------------- */

/**
 * 1枚のHTMLに、共有カード・言語宣言・構造化データ・フィードのリンクを足す。
 * 既に書かれているタグは尊重し、足りないものだけ補う。
 */
function enhanceHead(html, desc, cls, extra) {
  const add = [];
  const has = re => re.test(html);

  const site = SITE[cls.lang];

  if (!has(/property="og:site_name"/)) add.push(`<meta property="og:site_name" content="${escAttr(site.name)}">`);
  if (!has(/property="og:locale"/))    add.push(`<meta property="og:locale" content="${site.locale}">`);

  if (!has(/property="og:image"/)) {
    add.push(`<meta property="og:image" content="${extra.ogImage}">`);
    add.push(`<meta property="og:image:width" content="1200">`);
    add.push(`<meta property="og:image:height" content="630">`);
    add.push(`<meta property="og:image:alt" content="${escAttr(site.name)}">`);
  }
  if (!has(/name="twitter:card"/)) {
    add.push(`<meta name="twitter:card" content="summary_large_image">`);
    add.push(`<meta name="twitter:title" content="${escAttr(desc.ogTitle || desc.title)}">`);
    add.push(`<meta name="twitter:description" content="${escAttr(desc.description)}">`);
    add.push(`<meta name="twitter:image" content="${extra.ogImage}">`);
  }

  if (cls.kind === 'article') {
    const published = extra.datePublished || isoDate(desc.metaLine);
    if (published && !has(/property="article:published_time"/)) {
      add.push(`<meta property="article:published_time" content="${dateTimeJst(published)}">`);
    }
    if (extra.keywords) {
      for (const t of extra.keywords) add.push(`<meta property="article:tag" content="${escAttr(t)}">`);
    }
  }

  // 言語版が両方あるページは x-default も出す。片方しかないページには付けない
  if (Object.keys(desc.alternates).length >= 2 && !has(/hreflang="x-default"/)) {
    add.push(`<link rel="alternate" hreflang="x-default" href="${desc.alternates.ja || desc.alternates.en}">`);
  }

  /* 購読の入口。規制解説を読んでいる人にブログのRSSを渡さない（読者が違う）。
     トップだけは入口なので両方を出す。 */
  if (!has(/type="application\/rss\+xml"/)) {
    const sections = cls.kind === 'home' ? ['insights', 'blog']
                   : cls.section === 'insights' ? ['insights'] : ['blog'];
    for (const sec of sections) {
      add.push(`<link rel="alternate" type="application/rss+xml" title="${escAttr(FEED[sec][cls.lang].title)}" href="${feedUrl(cls.lang, sec)}">`);
    }
  }

  if (cls.kind !== 'notfound') add.push(jsonLd(structuredData(desc, cls, extra)));

  return html.replace('</head>', add.map(t => t + '\n').join('') + '</head>');
}

/* ---------------- サイトマップ ----------------
   出力された HTML を数え上げて作る。一覧を手で持たないので、
   ページを足したのにサイトマップに載っていない、という状態が起きない。 */

function buildSitemap(pages) {
  const entry = p => {
    const alts = Object.entries(p.desc.alternates);
    return `  <url>\n    <loc>${p.desc.url}</loc>\n` +
      (p.lastmod ? `    <lastmod>${p.lastmod}</lastmod>\n` : '') +
      alts.map(([l, h]) => `    <xhtml:link rel="alternate" hreflang="${l}" href="${h}"/>\n`).join('') +
      `  </url>`;
  };
  return `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"\n` +
    `        xmlns:xhtml="http://www.w3.org/1999/xhtml">\n` +
    pages.map(entry).join('\n') + `\n</urlset>\n`;
}

/* ---------------- RSS ----------------
   購読という入口を増やす。更新の通知先を自社サイトの外に置かないための経路でもある。
   日英で別のフィードを持つ。混ぜると購読者に読めない記事が流れる。 */

const FEED = {
  blog: {
    ja: { path: '/blog/', title: 'Blue Aegis Media',
          desc: 'AI活用と生産性について、一次出典に当たって確かめた事実をもとに書いています。' },
    en: { path: '/en/blog/', title: 'Blue Aegis Media',
          desc: 'Notes on working with AI and on productivity, written from facts checked against their primary sources.' },
  },
  insights: {
    ja: { path: '/insights/', title: 'Blue Aegis 規制解説',
          desc: '規制の施行と改正について、事業者が何を求められ、何を記録しておくべきかを、公表資料に当たって整理しています。' },
    en: { path: '/en/insights/', title: 'Blue Aegis Regulatory Insights',
          desc: 'What incoming regulation requires of a business, and what it needs to be able to show afterwards — written from the published sources.' },
  },
};

/** そのページに出すフィードのURL。読者が違うので系統ごとに分ける */
function feedUrl(lang, section = 'blog') {
  return `${BASE}${FEED[section][lang].path}feed.xml`;
}

/**
 * フィード1本。
 * items は { title, url, date, description, categories } に正規化して渡す。
 * ブログは frontmatter から、規制解説は出力したHTMLから作るので、
 * 素材の出どころが違っても同じ形で出る。
 */
function buildFeed(items, buildDate, lang = 'ja', section = 'blog') {
  const esc = s => escAttr(s);
  const ch = FEED[section][lang];
  const body = items.map(it => `    <item>
      <title>${esc(it.title)}</title>
      <link>${it.url}</link>
      <guid isPermaLink="true">${it.url}</guid>
${it.date ? `      <pubDate>${new Date(`${it.date}T00:00:00+09:00`).toUTCString()}</pubDate>\n` : ''}      <description>${esc(it.description || '')}</description>
${(it.categories || []).map(t => `      <category>${esc(t)}</category>`).join('\n')}
    </item>`).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${esc(ch.title)}</title>
    <link>${BASE}${ch.path}</link>
    <atom:link href="${feedUrl(lang, section)}" rel="self" type="application/rss+xml"/>
    <description>${esc(ch.desc)}</description>
    <language>${lang}</language>
    <lastBuildDate>${buildDate.toUTCString()}</lastBuildDate>
${body}
  </channel>
</rss>
`;
}

module.exports = {
  BASE, SITE, SECTION,
  describePage, classify, structuredData, enhanceHead,
  buildSitemap, buildFeed, feedUrl, isoDate, dateTimeJst, todayJst, displayWidth, unesc, escAttr,
};
