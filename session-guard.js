/**
 * session-guard.js
 * Guard de sessão do front, carregado no <head> de toda página interna.
 *
 * IMPORTANTE: isto é conveniência, não segurança. Quem realmente barra o acesso
 * é o servidor (sessão IAM + permissão `fatura.tela:<rota>` no server.js). Aqui
 * só evitamos mostrar links que a pessoa não pode abrir e reagimos a sessão
 * derrubada pela TI no meio do uso.
 *
 * Expõe `window.CF` com { usuario, permissoes, telas } e dispara o evento
 * `cf:sessao` no document quando os dados chegam.
 */
(function () {
  'use strict';

  // 1) Caminho rápido e síncrono: sem marca de login, nem renderiza a página.
  if (!sessionStorage.getItem('cf_loggedIn')) {
    window.location.replace('index.html');
    return;
  }

  var CF = { usuario: null, permissoes: [], telas: [], pronto: false };
  window.CF = CF;

  /** Só o nome do arquivo de um href ('extrato.html?x=1' → 'extrato.html'). */
  function arquivoDe(href) {
    if (!href) return '';
    var limpo = href.split('#')[0].split('?')[0];
    var partes = limpo.split('/');
    return partes[partes.length - 1];
  }

  function encerrar(destino) {
    sessionStorage.clear();
    window.location.replace(destino || 'index.html');
  }

  /** Esconde os links das telas que esta pessoa não pode abrir. */
  function ajustarNavegacao(dados) {
    var permitidas = {};
    (dados.telas || []).forEach(function (t) { permitidas[t.arquivo] = true; });
    var conhecidas = dados.todas_telas || [];

    Array.prototype.forEach.call(document.querySelectorAll('a[href]'), function (a) {
      var arq = arquivoDe(a.getAttribute('href'));

      // Gestão de usuários virou o console da TI (IAM): só admin vê, e aponta pra lá.
      if (arq === 'gestao-usuarios.html') {
        if (dados.usuario && dados.usuario.admin) {
          a.setAttribute('href', dados.iam_admin_url);
          a.setAttribute('target', '_blank');
          a.setAttribute('rel', 'noopener');
          a.textContent = 'Usuários (Painel ADM)';
        } else {
          a.style.display = 'none';
        }
        return;
      }

      if (conhecidas.indexOf(arq) !== -1 && !permitidas[arq]) {
        a.style.display = 'none';
      }
    });
  }

  /**
   * Guarda a foto de perfil (vinda da IAM) para a tela de login mostrar na
   * próxima visita — como a tela de bloqueio do Windows. Só faz sentido para
   * quem marcou "Lembrar-me": é a mesma escolha de deixar a identidade neste
   * aparelho. Fica como data URL porque o CSP do login já permite `data:`.
   */
  function guardarFoto(dados) {
    var lembrado = String(localStorage.getItem('cf_user') || '').toLowerCase();
    var login = String((dados.usuario && dados.usuario.login) || '').toLowerCase();
    if (!lembrado || lembrado !== login) return;

    localStorage.setItem('cf_nome', dados.usuario.nome || dados.usuario.login);

    fetch('api/foto', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.blob() : null; })
      .then(function (blob) {
        if (!blob) { localStorage.removeItem('cf_foto'); return; }
        var leitor = new FileReader();
        leitor.onload = function () {
          try { localStorage.setItem('cf_foto', String(leitor.result)); }
          catch (_) { /* localStorage cheio: a tela de login cai nas iniciais */ }
        };
        leitor.readAsDataURL(blob);
      })
      .catch(function () { /* sem foto é degradação aceitável */ });
  }

  /** Aviso quando o servidor devolveu ?sem_permissao=<pagina>. */
  function avisoSemPermissao() {
    var m = /[?&]sem_permissao=([^&]+)/.exec(window.location.search);
    if (!m) return;
    var pagina = decodeURIComponent(m[1]);
    var box = document.createElement('div');
    box.setAttribute('role', 'alert');
    box.style.cssText =
      'position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:9999;' +
      'background:rgba(180,60,60,.95);color:#fff;padding:10px 18px;border-radius:8px;' +
      'font:600 .84rem Montserrat,system-ui,sans-serif;box-shadow:0 4px 20px rgba(0,0,0,.35)';
    box.textContent = 'Você não tem permissão para abrir "' + pagina + '". Peça liberação à TI.';
    document.body.appendChild(box);
    setTimeout(function () { box.remove(); }, 7000);
  }

  // 2) Confirma a sessão no servidor e aplica as permissões reais.
  fetch('api/me', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
    .then(function (r) {
      if (r.status === 401) { encerrar('index.html'); return null; }
      return r.json();
    })
    .then(function (dados) {
      if (!dados || !dados.success) return;
      if (dados.onboarding_pendente) { encerrar('index.html?primeiro_acesso=1'); return; }

      CF.usuario = dados.usuario;
      CF.permissoes = dados.permissoes || [];
      CF.telas = dados.telas || [];
      CF.pronto = true;

      sessionStorage.setItem('cf_username', dados.usuario.nome || dados.usuario.login);
      sessionStorage.setItem('cf_admin', dados.usuario.admin ? '1' : '');

      guardarFoto(dados);

      function aplicar() {
        ajustarNavegacao(dados);
        avisoSemPermissao();
        document.dispatchEvent(new CustomEvent('cf:sessao', { detail: dados }));
      }
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', aplicar);
      } else {
        aplicar();
      }
    })
    .catch(function () { /* rede instável: o gate do servidor continua valendo */ });

  // 3) Qualquer chamada de API que volte "sessão morta" derruba a tela na hora.
  var fetchOriginal = window.fetch;
  window.fetch = function (entrada, init) {
    return fetchOriginal.apply(this, arguments).then(function (resp) {
      var url = typeof entrada === 'string' ? entrada : (entrada && entrada.url) || '';
      if (url.indexOf('api/') !== -1 || url.indexOf('/api/') === 0) {
        if (resp.status === 401) { encerrar('index.html'); }
        else if (resp.status === 428) { encerrar('index.html?primeiro_acesso=1'); }
      }
      return resp;
    });
  };

  /** Helper para as telas: window.CF.tem('fatura.tela:/configuracoes') */
  CF.tem = function (codigo) { return CF.permissoes.indexOf(codigo) !== -1; };
})();
