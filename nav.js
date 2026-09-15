/* Navegação compartilhada da navbar: dropdowns acessíveis + menu mobile.
   Antes este bloco era copiado inline em 6 páginas; agora é um arquivo só.
   Carregar com <script src="nav.js" defer></script>. */
(function () {
  var nav = document.querySelector('.navbar');
  var wraps = document.querySelectorAll('.nav-dropdown-wrap');
  var toggleMobile;

  function closeAll(except) {
    document.querySelectorAll('.nav-dropdown-menu').forEach(function (m) { m.classList.remove('open'); });
    document.querySelectorAll('.nav-dropdown-btn').forEach(function (b) {
      if (b !== except) { b.classList.remove('open'); b.setAttribute('aria-expanded', 'false'); }
    });
  }

  wraps.forEach(function (w, i) {
    var btn = w.querySelector('.nav-dropdown-btn');
    var menu = w.querySelector('.nav-dropdown-menu');
    if (!btn || !menu) return;

    var id = menu.id || ('navMenu' + i);
    menu.id = id;
    menu.setAttribute('role', 'menu');
    btn.setAttribute('aria-haspopup', 'true');
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-controls', id);
    menu.querySelectorAll('a').forEach(function (a) { a.setAttribute('role', 'menuitem'); });

    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      var open = menu.classList.contains('open');
      closeAll(btn);
      if (!open) {
        menu.classList.add('open');
        btn.classList.add('open');
        btn.setAttribute('aria-expanded', 'true');
      }
    });

    btn.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
        if (!menu.classList.contains('open')) { e.preventDefault(); btn.click(); }
        var first = menu.querySelector('a');
        if (first) first.focus();
      }
    });

    menu.addEventListener('keydown', function (e) {
      var items = Array.prototype.slice.call(menu.querySelectorAll('a'));
      var idx = items.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); (items[idx + 1] || items[0]).focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); (items[idx - 1] || items[items.length - 1]).focus(); }
      else if (e.key === 'Escape') { closeAll(); btn.focus(); }
      else if (e.key === 'Tab') { closeAll(); }
    });
  });

  document.addEventListener('click', function () { closeAll(); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      closeAll();
      if (toggleMobile && nav && nav.classList.contains('mobile-open')) toggleMobile(false);
    }
  });

  // Botão hambúrguer para mobile — injetado aqui para não mexer no HTML de cada página.
  if (nav) {
    var actions = nav.querySelector(':scope > div:last-child');
    var burger = document.createElement('button');
    burger.type = 'button';
    burger.className = 'nav-mobile-toggle';
    burger.setAttribute('aria-label', 'Abrir menu de navegação');
    burger.setAttribute('aria-expanded', 'false');
    burger.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>';
    if (actions) nav.insertBefore(burger, actions);

    toggleMobile = function (force) {
      var open = force === undefined ? !nav.classList.contains('mobile-open') : force;
      nav.classList.toggle('mobile-open', open);
      burger.setAttribute('aria-expanded', open ? 'true' : 'false');
      burger.setAttribute('aria-label', open ? 'Fechar menu de navegação' : 'Abrir menu de navegação');
    };
    burger.addEventListener('click', function (e) { e.stopPropagation(); toggleMobile(); });
  }
})();
