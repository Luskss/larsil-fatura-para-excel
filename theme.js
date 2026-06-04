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
