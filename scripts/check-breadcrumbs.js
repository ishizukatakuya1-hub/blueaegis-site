#!/usr/bin/env node
'use strict';
/**
 * パンくず（BreadcrumbList）の検査。
 *
 * Search Console の「項目『item』がありません（itemListElement に含まれる）」を
 * 再発させないための番人。2026-09-05 に /blog/tags/ 配下の8ページで検出した。
 * 原因は URL を持たない「タグ」の段を ListItem として出していたこと。
 *
 *   node scripts/check-breadcrumbs.js            # _site/ を見る
 *   node scripts/check-breadcrumbs.js <ディレクトリ>
 *
 * 見るのは次の5点。1つでも破れたら終了コード 1。
 *   1. JSON-LD が JSON として読めること
 *   2. 全 ListItem に item があり、空文字・空の {"@id":""} でないこと
 *   3. item が https://blueaegis.co.jp/ で始まる絶対URLであること（相対URL禁止）
 *   4. position が 1 から始まる連番であること
 *   5. 終点の item がそのページの canonical と一致すること
 *      （一覧ページ /blog/ /insights/ は自分自身が段なので、これも一致する）
 *
 * ビルドの検査（tools/lib/audit.js）は JSON として壊れていないかまでしか見ない。
 * ここは中身を見る。依存は足さない（Node.js 20 の標準ライブラリのみ）。
 */

const fs = require('fs');
const path = require('path');

const BASE = 'https://blueaegis.co.jp';
const outDir = process.argv[2] || '_site';

/** 配下の .html を全部集める */
function htmlFiles(dir) {
  const found = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.html')) found.push(p);
    }
  })(dir);
  return found.sort();
}

/** @graph でも配列でも入れ子でも、BreadcrumbList を全部拾う */
function findBreadcrumbs(node, acc = []) {
  if (Array.isArray(node)) { node.forEach(n => findBreadcrumbs(n, acc)); return acc; }
  if (node && typeof node === 'object') {
    const t = node['@type'];
    if (t === 'BreadcrumbList' || (Array.isArray(t) && t.includes('BreadcrumbList'))) acc.push(node);
    Object.values(node).forEach(v => findBreadcrumbs(v, acc));
  }
  return acc;
}

/** ListItem の item を URL 文字列にする。item は文字列でも {"@id":...} でもよい */
function itemUrl(item) {
  if (typeof item === 'string') return item;
  if (item && typeof item === 'object') return item['@id'] || item.url || '';
  return '';
}

function checkFile(file) {
  const errors = [];
  const html = fs.readFileSync(file, 'utf8');
  const rel = path.relative(outDir, file).replace(/\\/g, '/');
  const at = msg => `${rel}: ${msg}`;

  const canonical = (/<link rel="canonical" href="([^"]+)"/.exec(html) || [])[1] || null;

  const reLd = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  const crumbs = [];
  let m;
  while ((m = reLd.exec(html)) !== null) {
    let data;
    try { data = JSON.parse(m[1].replace(/\\u003c/g, '<')); }
    catch (e) { errors.push(at(`構造化データが JSON として不正です: ${e.message}`)); continue; }
    crumbs.push(...findBreadcrumbs(data));
  }

  if (crumbs.length > 1) errors.push(at(`BreadcrumbList が ${crumbs.length} 個あります（1ページに1個）`));

  for (const bc of crumbs) {
    const items = bc.itemListElement;
    if (!Array.isArray(items) || items.length === 0) {
      errors.push(at('BreadcrumbList の itemListElement が空です'));
      continue;
    }
    if (items.length < 2) {
      errors.push(at('BreadcrumbList が1段しかありません（1階層のパンくずは出さない）'));
    }

    items.forEach((it, i) => {
      const pos = `位置${i + 1}`;
      if (it.position !== i + 1) errors.push(at(`${pos}: position が ${JSON.stringify(it.position)}（1から連番にすること）`));
      if (!it.name || !String(it.name).trim()) errors.push(at(`${pos}: name がありません`));

      if (!('item' in it)) { errors.push(at(`${pos}「${it.name}」: item がありません`)); return; }

      const url = itemUrl(it.item);
      if (!url.trim()) { errors.push(at(`${pos}「${it.name}」: item が空です（${JSON.stringify(it.item)}）`)); return; }
      if (!/^https?:\/\//.test(url)) { errors.push(at(`${pos}「${it.name}」: item が相対URLです（${url}）`)); return; }
      if (!url.startsWith(BASE + '/')) errors.push(at(`${pos}「${it.name}」: item が自サイトの外を指しています（${url}）`));
    });

    const last = itemUrl(items[items.length - 1].item);
    if (canonical && last && last !== canonical) {
      errors.push(at(`終点の item が canonical と違います\n    item      = ${last}\n    canonical = ${canonical}`));
    }
  }

  return { rel, count: crumbs.length, errors };
}

if (!fs.existsSync(outDir)) {
  console.error(`${outDir}/ がありません。先に node tools/build.js を実行すること。`);
  process.exit(1);
}

const files = htmlFiles(outDir);
const errors = [];
let withCrumbs = 0;

for (const f of files) {
  const r = checkFile(f);
  if (r.count > 0) withCrumbs++;
  errors.push(...r.errors);
}

console.log(`検査 ${files.length} ページ（パンくずを持つのは ${withCrumbs} ページ / 持たないのは ${files.length - withCrumbs} ページ）`);

if (errors.length) {
  console.error(`\nパンくずに ${errors.length} 件の問題があります:`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

console.log('BreadcrumbList の全 ListItem に、非空の絶対URL item があります。問題なし');
