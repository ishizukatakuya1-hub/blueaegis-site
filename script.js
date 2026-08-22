/* Blue Aegis — 共通スクリプト */

/* スクロール連動フェードイン。
   セレクタは style.css 側と同一に保つこと（片方だけ変えると要素が消えたままになる）。 */
(function(){
  var SEL = 'section .lead, section .intro, .card, .domain, .offer,'
          + '.steps > li, .pol > div, .stat, .stat-note,'
          + '.faq dt, .faq dd, .scroller,'
          + '.message p, .message .pull,'
          + '.creed blockquote, .creed p, .mail, .bot,'
          + '.article p, .article h3, .article ul, .article .source, .postlist li';
  var els = document.querySelectorAll(SEL);
  var motionOK = window.matchMedia && window.matchMedia('(prefers-reduced-motion: no-preference)').matches;

  if (!motionOK || !('IntersectionObserver' in window)) {
    for (var i = 0; i < els.length; i++) els[i].classList.add('in');
    return;
  }
  var io = new IntersectionObserver(function(entries){
    entries.forEach(function(e){
      if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
    });
  }, { threshold: 0.12, rootMargin: '0px 0px -8% 0px' });
  for (var j = 0; j < els.length; j++) io.observe(els[j]);
})();

/* 問い合わせ：選択内容から mailto の下書きを組み立てる。
   外部サービスを介さないため、送信するまでデータはどこにも渡らない。
   表示文言はフォームの data 属性から読むので、このファイルは日英共通で使える。 */
(function(){
  var form = document.getElementById('inq');
  if (!form) return;
  var L = form.dataset;
  form.addEventListener('submit', function(e){
    e.preventDefault();
    var v = function(n){
      var el = form.querySelector('[name="'+n+'"]:checked') || form.querySelector('[name="'+n+'"]');
      return el ? el.value.trim() : '';
    };
    /* どの記事を読んで相談に至ったかを本文に添える。
       記事側の導線が ?from=... を付けてくるので、それを読むだけ。
       外部へ送るものは何もなく、本人が送信するメールに1行入るだけ。 */
    var m = /[?&]from=([^&]+)/.exec(window.location.search);
    var src = '';
    if (m) {
      try { src = decodeURIComponent(m[1]); } catch (e) { src = ''; }
      /* このサイトのページのパスにしか見えないものだけ通す。
         タグ一覧は日本語を含むので文字種では絞れない。空白・記号を弾き、
         .html で終わることを求める。細工したURLで本文に文言を差し込めないように。 */
      if (!/^[^\s:<>"'\\]+\.html$/.test(src)) src = '';
    }

    var lines = [
      L.labelKind + v('kind'),
      L.labelArea + v('area'),
      L.labelWho  + (v('who') || L.blank),
      '',
      L.labelBody,
      v('body') || L.blank,
      '',
      '--------------------'
    ];
    if (src && L.labelFrom) lines.push(L.labelFrom + src);
    lines.push(L.footer);
    window.location.href = 'mailto:info@blueaegis.co.jp'
      + '?subject=' + encodeURIComponent(L.subject + v('kind'))
      + '&body='    + encodeURIComponent(lines.join('\r\n'));
  });
})();

/* 問い合わせ：会話式の案内（相談ナビ）。
   台本は同じページの <script type="application/json" id="botflow"> に置いてあるので、
   このファイルは日英共通で使える。文言をここに書かないこと。

   選択肢を押して進むだけで、自由入力も外部との通信もない。最後にやるのは
   下のフォームのラジオと自由記述欄へ選択内容を移すことだけで、送信は従来どおり
   利用者のメールソフトが行う。「送信するまで当社には何も届かない」という
   問い合わせ欄の約束はこの機能を足しても変わらない。

   台本が壊れていた場合は何も表示せず黙って降りる（フォーム単体で完結するため）。 */
(function(){
  var box  = document.getElementById('bot');
  var src  = document.getElementById('botflow');
  var form = document.getElementById('inq');
  if (!box || !src || !form) return;

  var flow;
  try { flow = JSON.parse(src.textContent); } catch (e) { return; }
  if (!flow || !flow.nodes || !flow.first || !flow.nodes[flow.first]) return;

  var UI    = flow.ui || {};
  var log   = box.querySelector('.bot-log');
  var opts  = box.querySelector('.bot-opts');
  var again = box.querySelector('.bot-restart');
  if (!log || !opts) return;

  var picked = {};

  function say(text, who){
    if (!text) return;
    var p = document.createElement('p');
    p.className = who;                 /* says＝当社側 / picked＝利用者が選んだもの */
    p.textContent = text;              /* 台本は必ず文字として入れる（HTMLとして解釈させない） */
    log.appendChild(p);
  }

  function empty(el){ while (el.firstChild) el.removeChild(el.firstChild); }

  function button(label, cls, run){
    var b = document.createElement('button');
    b.type = 'button';                 /* フォームの外にあるが、念のため送信させない */
    if (cls) b.className = cls;
    b.textContent = label;
    b.addEventListener('click', run);
    opts.appendChild(b);
  }

  function go(id){
    var node = flow.nodes[id];
    if (!node) return;
    empty(opts);
    say(node.q, 'says');
    if (node.final) { button(UI.fill || 'OK', 'bot-go', fill); return; }
    (node.opts || []).forEach(function(o){
      button(o.label, '', function(){
        say(o.label, 'picked');
        if (o.set) for (var k in o.set) picked[k] = o.set[k];
        if (o.body) picked.body = o.body;
        go(o.next);
      });
    });
  }

  /* 選んだ内容をフォームへ移す。値の一致でラジオを探す（属性セレクタを組み立てない）。 */
  function fill(){
    empty(opts);
    ['kind', 'area'].forEach(function(name){
      if (!picked[name]) return;
      var list = form.querySelectorAll('[name="' + name + '"]');
      for (var i = 0; i < list.length; i++) {
        if (list[i].value === picked[name]) { list[i].checked = true; break; }
      }
    });
    var body = form.querySelector('[name="body"]');
    if (body && picked.body) {
      var had = body.value.replace(/\s+$/, '');
      body.value = had ? had + '\n' + picked.body : picked.body;
      try { body.focus({ preventScroll: true }); } catch (e) { /* 古い実装では位置指定なしで諦める */ }
    }
    say(UI.filled, 'says');
    form.scrollIntoView({ block: 'start' });
  }

  function start(){ say(flow.intro, 'says'); go(flow.first); }

  if (again) again.addEventListener('click', function(){
    picked = {};
    empty(log);
    empty(opts);
    start();
  });

  start();
})();
