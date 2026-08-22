/* Blue Aegis — 共通スクリプト */

/* スクロール連動フェードイン。
   セレクタは style.css 側と同一に保つこと（片方だけ変えると要素が消えたままになる）。 */
(function(){
  var SEL = 'section .lead, section .intro, .card, .domain, .offer,'
          + '.steps > li, .pol > div, .stat, .stat-note,'
          + '.faq dt, .faq dd, .scroller,'
          + '.message p, .message .pull,'
          + '.creed blockquote, .creed p, .mail,'
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
