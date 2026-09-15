/**
 * routes/force-scan.js
 * POST /api/force-scan
 * Dispara imediatamente a varredura do MONITOR_PATH sem esperar o agendamento.
 */
'use strict';

const { setFullSecurityHeaders, requireAuth } = require('./_helpers');
const { runScan } = require('../scheduler');

module.exports = async function forceScanRoute(req, res) {
    setFullSecurityHeaders(res);
    if (!requireAuth(req, res)) return;

    if (req.method !== 'POST') {
        return res.status(405).json({ success: false, message: 'Método não permitido.' });
    }

    const monitorPath = process.env.MONITOR_PATH;
    if (!monitorPath) {
        return res.status(400).json({ success: false, message: 'MONITOR_PATH não configurado.' });
    }

    // Dispara em background — responde imediatamente para não bloquear o front
    res.json({ success: true, message: 'Leitura iniciada. Acompanhe o status em /api/scan-status.' });

    try {
        // Via IA, como o scan automático (`scanAutomaticoUsaIA`) e o force-scan-ai.
        // Até 11/09/2026 esta rota chamava `runScan` sem opção, e era o único caminho
        // que ainda gravava leitura só de parser local — o botão "Ler pasta" produzia
        // resultado diferente do scan agendado sobre os mesmos arquivos.
        //
        // MEDIDO em `_medir/_ia-vs-local-no-valor.js` sobre 220 arquivos lidos pelas
        // DUAS vias (comparação pareada, mesma dificuldade por construção): a IA acerta
        // mais o valor em 121 e erra mais em 9. Nas NFS-e a diferença é categórica —
        // o extrator local exige NCM (`_nf-itens.js:489`), que nota de SERVIÇO não tem,
        // e gravou itens em 0 de 268; a IA leu em 24% delas.
        //
        // Não é um cheque em branco para a IA: `analyzePdf` mantém o extrator
        // determinístico rodando ANTES dela, e a IA só preenche o que ficou vazio —
        // chave de acesso e CNPJ são validados por construção e não se trocam por
        // leitura. O custo é limitado pelo cache: só relê o que ainda não tem origem "IA".
        await runScan(monitorPath, { forceAI: true });
    } catch (e) {
        console.error('[force-scan] erro:', e.message);
    }
};
