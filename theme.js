/**
 * theme.js — Toggle claro/escuro global
 * Aplica a classe 'light' no <html> o mais cedo possível para evitar flash.
 * Persiste preferência em localStorage sob a chave 'cf-theme'.
 */
(function () {
    const KEY = 'cf-theme';
    let saved = 'dark';
    try { saved = localStorage.getItem(KEY) || 'dark'; } catch (_) {}
    if (saved === 'light') document.documentElement.classList.add('light');

    function updateBtn(isLight) {
        const btn  = document.getElementById('btnThemeToggle');
        const sun  = document.getElementById('iconThemeSun');
        const moon = document.getElementById('iconThemeMoon');
        if (!btn) return;
        btn.title = isLight ? 'Modo escuro' : 'Modo claro';
        if (sun)  sun.style.display  = isLight ? 'block' : 'none';
        if (moon) moon.style.display = isLight ? 'none'  : 'block';
    }

    function toggle() {
        const isLight = document.documentElement.classList.toggle('light');
        try { localStorage.setItem(KEY, isLight ? 'light' : 'dark'); } catch (_) {}
        updateBtn(isLight);
    }

    window.__themeToggle = toggle;

    function init() {
        updateBtn(saved === 'light');
        const btn = document.getElementById('btnThemeToggle');
        if (btn) {
            btn.removeAttribute('onclick');
            btn.addEventListener('click', toggle);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();

/**
 * Sistema global de notificações de varredura automática
 * Funciona em todas as páginas do site
 */
(function () {
    // Cria container global de notificações
    const container = document.createElement('div');
    container.id = '__scan-notifications-container';
    container.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        z-index: 10000;
        pointer-events: none;
    `;
    document.body.appendChild(container);

    // Estilos CSS injetados
    const style = document.createElement('style');
    style.textContent = `
        @keyframes slideInRight {
            from { transform: translateX(400px); opacity: 0; }
            to { transform: translateX(0); opacity: 1; }
        }
        @keyframes slideOutRight {
            from { transform: translateX(0); opacity: 1; }
            to { transform: translateX(400px); opacity: 0; }
        }
        .__scan-notification {
            background: rgba(30,100,50,.95);
            backdrop-filter: blur(16px);
            -webkit-backdrop-filter: blur(16px);
            border: 1px solid rgba(96,184,96,.3);
            color: #fff;
            padding: 16px 20px;
            border-radius: 12px;
            font-size: .85rem;
            font-weight: 600;
            box-shadow: 0 8px 32px rgba(0,0,0,.4);
            animation: slideInRight .3s ease-out;
            margin-bottom: 12px;
            pointer-events: auto;
            line-height: 1.4;
            max-width: 380px;
        }
        .__scan-notification.error {
            background: rgba(180,50,50,.95);
            border-color: rgba(252,165,165,.3);
        }
        .__scan-notification.hide {
            animation: slideOutRight .3s ease-in;
        }
        .__scan-notification strong {
            display: block;
            margin-bottom: 4px;
            font-size: .9rem;
        }
        .__scan-notification .detail {
            opacity: .9;
            font-size: .8rem;
            margin-top: 6px;
        }
        html.light .__scan-notification {
            background: rgba(22,163,74,.95);
            border-color: rgba(34,197,94,.3);
        }
        html.light .__scan-notification.error {
            background: rgba(239,68,68,.95);
            border-color: rgba(248,113,113,.3);
        }
    `;
    document.head.appendChild(style);

    // Função para mostrar notificação
    window.__showScanNotification = function (message, isError = false, details = null) {
        const notification = document.createElement('div');
        notification.className = '__scan-notification' + (isError ? ' error' : '');

        let html = `<strong>${isError ? '✗ Erro na Varredura' : '✓ Varredura Automática'}</strong>`;
        html += message;
        if (details) {
            html += `<div class="detail">${details}</div>`;
        }
        notification.innerHTML = html;

        container.appendChild(notification);

        // Auto-remove após 7 segundos
        setTimeout(() => {
            notification.classList.add('hide');
            setTimeout(() => notification.remove(), 300);
        }, 7000);
    };

    // Função para verificar status da varredura
    async function checkScanStatus() {
        try {
            const r = await fetch('/api/scan-status', { credentials: 'include' });
            if (!r.ok) return;
            const data = await r.json();
            if (data.result) {
                const result = data.result;
                let details = '';
                if (result.processed !== undefined) {
                    details = `Processados: ${result.processed} | Sem alteração: ${result.unchanged}`;
                }
                window.__showScanNotification(result.message, !result.success, details);

                // Marca como lido
                await fetch('/api/scan-status', { method: 'DELETE', credentials: 'include' });
            }
        } catch (e) {
            console.error('Erro ao verificar status da varredura:', e);
        }
    }

    // Verifica ao carregar a página
    function init() {
        checkScanStatus();
        // E depois a cada 30 segundos
        setInterval(checkScanStatus, 30000);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
