/**
 * routes/pdf-viewer.js
 * GET: retorna um PDF para visualizar
 * Tenta cache primeiro, depois o arquivo em disco — no arquivo permanente
 * (ARQUIVO_PATH) e, em seguida, na pasta monitorada (MONITOR_PATH).
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { requireAuth } = require('./_helpers');
const pdfCache = require('../pdf-cache');

module.exports = async function pdfViewerRoute(req, res) {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Frame-Options', 'SAMEORIGIN');

    if (!requireAuth(req, res)) return;

    if (req.method !== 'GET') {
        return res.status(405).json({ success: false, message: 'Método não permitido.' });
    }

    try {
        const { arquivo, pasta } = req.query;

        if (!arquivo) {
            return res.status(400).json({ success: false, message: 'Nome do arquivo não fornecido.' });
        }

        // 1) Tenta cache primeiro (instantâneo)
        let pdfBuffer = pdfCache.get(arquivo, pasta);
        if (pdfBuffer) {
            console.log(`[pdf-viewer] PDF encontrado em cache: ${arquivo}`);
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('X-Cache', 'HIT');
            return res.send(pdfBuffer);
        }

        // 2) Se não estiver em cache, procura o arquivo no disco.
        //
        // São DUAS raízes, e não uma. MONITOR_PATH é a pasta de trabalho que o
        // scheduler varre e ESVAZIA a cada ciclo; ARQUIVO_PATH é o arquivo permanente,
        // onde o PDF fica depois de arquivado. A conferência de notas lista o arquivo
        // permanente (`comparar-notas` varre `ARQUIVO_PATH || MONITOR_PATH`), então o
        // `pasta` que ela manda — "2026.01.EXTRATOS CONTABILIDADE/B BRASIL/2026.01.09"
        // — não existe sob MONITOR_PATH: procurar só ali dava 404 em todo "Ver nota",
        // e a tela mostrava "Arquivo não disponível".
        //
        // A ordem é arquivo-primeiro porque é de lá que vem quase todo pedido do
        // painel; o monitor continua atendendo o PDF recém-chegado, ainda não arquivado.
        const raizes = [process.env.ARQUIVO_PATH, process.env.MONITOR_PATH].filter(Boolean);
        if (!raizes.length) {
            return res.status(503).json({ success: false, message: 'Serviço indisponível.' });
        }

        // Cada raiz valida o próprio prefixo (previne directory traversal): um `..` que
        // escape de uma delas é descartado ali mesmo, sem chance de cair na outra.
        //
        // O `replace` no fim da base não é enfeite: numa raiz UNC que é a própria raiz do
        // compartilhamento ("\\\\host\\SHARE"), `path.resolve` devolve COM barra no fim.
        // Sem tirá-la, `base + path.sep` vira barra dupla e a comparação reprova todo
        // caminho legítimo do arquivo permanente — que é exatamente o nosso caso.
        let realPath = null;
        for (const raiz of raizes) {
            const alvo = path.resolve(pasta ? path.join(raiz, pasta, arquivo) : path.join(raiz, arquivo));
            const base = path.resolve(raiz).replace(/[\\/]+$/, '');
            if (alvo !== base && !alvo.startsWith(base + path.sep)) continue;
            if (fs.existsSync(alvo)) { realPath = alvo; break; }
        }

        if (!realPath) {
            return res.status(404).json({ success: false, message: 'Arquivo não encontrado.' });
        }

        // Lê o arquivo
        pdfBuffer = fs.readFileSync(realPath);

        // Armazena em cache para próximas requisições
        pdfCache.put(arquivo, pasta, pdfBuffer);

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('X-Cache', 'MISS');
        res.send(pdfBuffer);

    } catch (e) {
        console.error('[pdf-viewer] erro:', e.message);
        return res.status(500).json({ success: false, message: 'Erro ao recuperar arquivo.' });
    }
};
