'use strict';
(function () {
  // ── Toast de progresso de scan (visível em todas as páginas) ─────────────────
  // Injeta o elemento e consulta /api/scan-status a cada 3 s.
  // Só exibe fora de configuracoes.html (que tem a barra inline própria).
  var isConfigPage = /configuracoes\.html/i.test(window.location.pathname) || window.location.pathname === '/';

  function injectScanToast() {
    if (document.getElementById('_scanToast')) return;
    var el = document.createElement('div');
    el.id = '_scanToast';
    el.style.cssText = [
      'position:fixed', 'bottom:28px', 'right:28px',
      'background:rgba(20,40,70,.96)', 'backdrop-filter:blur(16px)',
      'border:1px solid rgba(96,184,240,.3)', 'color:#fff',
      'padding:13px 18px', 'border-radius:12px',
      'font-family:Montserrat,sans-serif', 'font-size:.82rem', 'font-weight:700',
      'box-shadow:0 8px 32px rgba(0,0,0,.5)',
      'opacity:0', 'transform:translateY(12px)',
      'transition:opacity .3s,transform .3s',
      'pointer-events:none', 'z-index:9999',
      'max-width:300px', 'min-width:200px',
    ].join(';');
    el.innerHTML = [
      '<div style="display:flex;align-items:center;gap:10px;margin-bottom:7px">',
        '<svg viewBox="0 0 24 24" fill="none" stroke="#60b8f0" stroke-width="2.2" width="14" height="14" style="flex-shrink:0;animation:_scanSpin .9s linear infinite"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>',
        '<span id="_scanToastLabel">Processando notas...</span>',
      '</div>',
      '<div style="height:4px;background:rgba(255,255,255,.12);border-radius:2px;overflow:hidden">',
        '<div id="_scanToastFill" style="height:100%;background:linear-gradient(90deg,#2e6b8b,#60b8f0);border-radius:2px;transition:width .5s ease;width:0%"></div>',
      '</div>',
      '<div id="_scanToastFile" style="margin-top:6px;font-size:.68rem;color:rgba(255,255,255,.35);white-space:nowrap;overflow:hidden;text-overflow:ellipsis"></div>',
    ].join('');

    var style = document.createElement('style');
    style.textContent = '@keyframes _scanSpin{to{transform:rotate(360deg)}}';
    document.head.appendChild(style);
    document.body.appendChild(el);
  }

  function showScanToast(p) {
    var el = document.getElementById('_scanToast');
    if (!el) return;
    var pct = p.percent || 0;
    var fill = document.getElementById('_scanToastFill');
    if (p.paused) {
      document.getElementById('_scanToastLabel').textContent = 'Leitura pausada (' + pct + '%)';
      if (fill) fill.style.background = 'linear-gradient(90deg,#6b5e2b,#fcd34d)';
    } else {
      document.getElementById('_scanToastLabel').textContent =
        p.total > 0 ? 'Processando ' + p.current + '/' + p.total + ' (' + pct + '%)' : 'Preparando...';
      if (fill) fill.style.background = 'linear-gradient(90deg,#2e6b8b,#60b8f0)';
    }
    if (fill) fill.style.width = pct + '%';
    document.getElementById('_scanToastFile').textContent = p.paused ? '' : (p.message || '');
    el.style.opacity = '1';
    el.style.transform = 'translateY(0)';
  }

  function hideScanToast() {
    var el = document.getElementById('_scanToast');
    if (!el) return;
    el.style.opacity = '0';
    el.style.transform = 'translateY(12px)';
  }

  var _scanPoll = null;
  function startGlobalScanPoll() {
    if (_scanPoll) return;
    _scanPoll = setInterval(function () {
      fetch('api/scan-status', { credentials: 'same-origin' })
        .then(function(r){ return r.json(); })
        .then(function(r) {
          if (r.progress && r.progress.running) {
            injectScanToast();
            showScanToast(r.progress);
            localStorage.setItem('cf_scan_running', '1');
          } else {
            hideScanToast();
            if (localStorage.getItem('cf_scan_running')) {
              localStorage.removeItem('cf_scan_running');
            }
            clearInterval(_scanPoll);
            _scanPoll = null;
          }
        })
        .catch(function(){});
    }, 3000);
  }

  // Inicia polling se outra aba/página registrou scan em andamento
  if (!isConfigPage) {
    if (localStorage.getItem('cf_scan_running')) {
      injectScanToast();
      startGlobalScanPoll();
    }
    // Escuta storage para detectar início do scan em outra aba
    window.addEventListener('storage', function(e) {
      if (e.key === 'cf_scan_running' && e.newValue === '1') {
        injectScanToast();
        startGlobalScanPoll();
      }
    });
  }

  // Fade-in ao carregar
  document.body.classList.add('page-entering');
  document.body.addEventListener('animationend', function() {
    document.body.classList.remove('page-entering');
  }, { once: true });

  // Intercepta navegação por links internos para fazer fade-out
  document.addEventListener('click', function (e) {
    const a = e.target.closest('a[href]');
    if (!a) return;

    const href = a.getAttribute('href');
    // Ignora: links externos, âncoras, javascript:, download, target externo
    if (!href || href.startsWith('http') || href.startsWith('//') ||
        href.startsWith('#') || href.startsWith('javascript') ||
        a.hasAttribute('download') || (a.target && a.target !== '_self')) return;

    e.preventDefault();
    document.body.classList.add('page-leaving');

    setTimeout(function () {
      window.location.href = href;
    }, 180);
  });
})();
