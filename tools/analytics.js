#!/usr/bin/env node
'use strict';
/**
 * Cloudflare Web Analytics の集計を読み出す。
 *
 * サイトの計測は Cloudflare Web Analytics（beacon）で行っている。数値は
 * Cloudflare 側にしか無く、リポジトリには保存されない。ここはその読み出し口。
 *
 *   node tools/analytics.js              直近7日
 *   node tools/analytics.js --days=30    期間を変える（Freeプランの保持期間まで）
 *   node tools/analytics.js --top=20     一覧の表示件数
 *   node tools/analytics.js --json       集計結果をJSONで出す（他の処理に渡す用）
 *   node tools/analytics.js --schema     データセットの項目名を出す（不調時の切り分け）
 *
 * 認証は環境変数のみ。引数でトークンを渡す口は用意しない（HANDOVER.md §4-4）。
 *
 *   CF_API_TOKEN    必須。権限は「アカウント → Analytics → 読み取り」だけで足りる
 *   CF_ACCOUNT_ID   任意。省略時はトークンから引ける最初のアカウントを使う
 *   CF_SITE_TAG     任意。省略時は beacon のトークンから site_tag を引く
 *
 * ビルドとは独立している。依存パッケージは無し（Node 20 の fetch を使う）。
 */

const fs = require('fs');
const path = require('path');

const API = 'https://api.cloudflare.com/client/v4';
const GRAPHQL = 'https://api.cloudflare.com/client/v4/graphql';

/* 引数。--key=value と --key の2形だけ扱う */
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const DAYS = Math.max(1, parseInt(opt('days', '7'), 10) || 7);
const TOP = Math.max(1, parseInt(opt('top', '10'), 10) || 10);
const AS_JSON = flag('json');

/* beacon のトークンは tools/build.js に1か所だけ書いてある。
   ここで二重に持つと片方だけ直る事故が起きるので、そこから読む。 */
function beaconToken() {
  const src = fs.readFileSync(path.join(__dirname, 'build.js'), 'utf8');
  const m = src.match(/data-cf-beacon='\{"token":\s*"([0-9a-f]+)"\}'/);
  if (!m) throw new Error('tools/build.js から beacon のトークンを読めなかった。ANALYTICS の定数を確認すること');
  return m[1];
}

async function cf(url, token) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body || body.success === false) {
    const detail = body && body.errors ? body.errors.map((e) => `${e.code}: ${e.message}`).join(' / ') : `HTTP ${res.status}`;
    throw new Error(`${url} が失敗した — ${detail}`);
  }
  return body.result;
}

async function graphql(token, query, variables) {
  const res = await fetch(GRAPHQL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json().catch(() => null);
  if (!body) throw new Error(`GraphQL の応答を解釈できなかった（HTTP ${res.status}）`);
  if (body.errors && body.errors.length) {
    throw new Error('GraphQL がエラーを返した — ' + body.errors.map((e) => e.message).join(' / '));
  }
  return body.data;
}

/* アカウントと site_tag の解決。
   beacon に入っているのは site_token で、GraphQL の絞り込みに使う site_tag とは別の値。
   そのため site_info を引いて突き合わせる。 */
async function resolveTarget(token) {
  let accountId = process.env.CF_ACCOUNT_ID;
  if (!accountId) {
    const accounts = await cf(`${API}/accounts?per_page=50`, token);
    if (!accounts.length) throw new Error('このトークンから見えるアカウントが無い。トークンの適用範囲を確認すること');
    accountId = accounts[0].id;
    if (accounts.length > 1) {
      console.error(`※ アカウントが${accounts.length}件見えている。1件目（${accounts[0].name}）を使う。別のものなら CF_ACCOUNT_ID を設定すること`);
    }
  }

  let siteTag = process.env.CF_SITE_TAG;
  if (!siteTag) {
    const wanted = beaconToken();
    const sites = await cf(`${API}/accounts/${accountId}/rum/site_info/list?per_page=100`, token);
    const hit = sites.find((s) => s.site_token === wanted)
      || sites.find((s) => JSON.stringify(s).includes('blueaegis.co.jp'));
    if (!hit) {
      throw new Error(`beacon のトークン ${wanted} に対応するサイトが見つからない。Web Analytics の登録を確認するか CF_SITE_TAG を設定すること`);
    }
    siteTag = hit.site_tag;
  }

  return { accountId, siteTag };
}

/* 期間。日付境界は JST で切る。記事の公開日も JST なので揃えておく */
function range(days) {
  const now = new Date();
  const end = new Date(now.getTime() + 60 * 1000); // 直近の欠けを避けて少し先まで
  const start = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return { start: start.toISOString(), end: end.toISOString() };
}

const GROUPS = `
  count
  sum { visits }
  dimensions { %DIM% }
`;

function block(alias, dim, limit, orderBy) {
  return `
    ${alias}: rumPageloadEventsAdaptiveGroups(
      filter: { siteTag: $siteTag, datetime_geq: $start, datetime_lt: $end }
      limit: ${limit}
      orderBy: [${orderBy}]
    ) { ${GROUPS.replace('%DIM%', dim)} }`;
}

async function fetchStats(token, accountId, siteTag, days) {
  const { start, end } = range(days);
  const query = `
    query($accountTag: String!, $siteTag: String!, $start: Time!, $end: Time!) {
      viewer {
        accounts(filter: { accountTag: $accountTag }) {
          ${block('byDate', 'date', 400, 'date_ASC')}
          ${block('byPath', 'requestPath', 500, 'count_DESC')}
          ${block('byReferer', 'refererHost', 200, 'count_DESC')}
          ${block('byCountry', 'countryName', 200, 'count_DESC')}
        }
      }
    }`;
  const data = await graphql(token, query, { accountTag: accountId, siteTag, start, end });
  const acc = data && data.viewer && data.viewer.accounts && data.viewer.accounts[0];
  if (!acc) throw new Error('アカウントの集計が返ってこなかった。CF_ACCOUNT_ID を確認すること');
  return { start, end, ...acc };
}

/* 不調時の切り分け用。使える項目名をデータセットから直接引く */
async function printSchema(token) {
  const query = `
    query {
      __type(name: "AccountRumPageloadEventsAdaptiveGroupsDimensions") { fields { name } }
      filterType: __type(name: "AccountRumPageloadEventsAdaptiveGroupsFilter_InputObject") { inputFields { name } }
    }`;
  const data = await graphql(token, query, {});
  const dims = data.__type ? data.__type.fields.map((f) => f.name) : [];
  const filters = data.filterType ? data.filterType.inputFields.map((f) => f.name) : [];
  console.log('dimensions:', dims.length ? dims.join(', ') : '(取得できず。型名が変わった可能性)');
  console.log('filter:', filters.length ? filters.join(', ') : '(取得できず。型名が変わった可能性)');
}

/* 表示 */
function total(rows) {
  return rows.reduce((a, r) => ({ views: a.views + r.count, visits: a.visits + (r.sum ? r.sum.visits : 0) }), { views: 0, visits: 0 });
}

function table(title, rows, key, limit) {
  console.log(`\n${title}`);
  if (!rows.length) { console.log('  （データなし）'); return; }
  const top = rows.slice(0, limit);
  const width = Math.max(...top.map((r) => String(r.dimensions[key] || '(なし)').length));
  for (const r of top) {
    const label = String(r.dimensions[key] || '(なし)').padEnd(width);
    console.log(`  ${label}  ${String(r.count).padStart(6)} PV  ${String(r.sum ? r.sum.visits : 0).padStart(6)} 訪問`);
  }
  if (rows.length > limit) console.log(`  …ほか ${rows.length - limit} 件`);
}

function report(stats, days) {
  const t = total(stats.byDate);
  console.log(`blueaegis.co.jp — 直近${days}日（${stats.start.slice(0, 10)} 〜 ${stats.end.slice(0, 10)}）`);
  console.log(`合計 ${t.views} PV / ${t.visits} 訪問`);

  console.log('\n日別');
  if (!stats.byDate.length) console.log('  （データなし）');
  for (const r of stats.byDate) {
    console.log(`  ${r.dimensions.date}  ${String(r.count).padStart(6)} PV  ${String(r.sum ? r.sum.visits : 0).padStart(6)} 訪問`);
  }

  table(`ページ別 上位${TOP}`, stats.byPath, 'requestPath', TOP);
  table(`参照元 上位${TOP}`, stats.byReferer, 'refererHost', TOP);
  table(`国 上位${TOP}`, stats.byCountry, 'countryName', TOP);

  console.log('\n※ Cloudflare Web Analytics は Cookie を使わない集計。個人の特定はできない。');
  console.log('※ アクセスが多い期間は標本化がかかるため、数値は概算。');
}

async function main() {
  const token = process.env.CF_API_TOKEN;
  if (!token) {
    console.error('CF_API_TOKEN が設定されていない。');
    console.error('');
    console.error('  1. https://dash.cloudflare.com/profile/api-tokens で「カスタムトークンを作成」');
    console.error('  2. 権限は アカウント → Analytics → 読み取り のみ');
    console.error('  3. 適用範囲は Blue Aegis のアカウントに限定');
    console.error('  4. 出来た値を、この環境の環境変数 CF_API_TOKEN に設定する');
    console.error('');
    console.error('※ これは beacon に埋め込んである公開値とは別物。リポジトリにコミットせず、');
    console.error('   会話にも貼らないこと（HANDOVER.md §4-4 の例外にあたるのは beacon 側だけ）。');
    process.exit(1);
  }

  if (flag('schema')) return printSchema(token);

  const { accountId, siteTag } = await resolveTarget(token);
  const stats = await fetchStats(token, accountId, siteTag, DAYS);
  if (AS_JSON) console.log(JSON.stringify(stats, null, 2));
  else report(stats, DAYS);
}

main().catch((err) => {
  console.error(`失敗: ${err.message}`);
  console.error('項目名の食い違いが疑われるときは node tools/analytics.js --schema で実際の項目名を確認すること。');
  process.exit(1);
});
