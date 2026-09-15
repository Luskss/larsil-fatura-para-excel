/**
 * _medir/_reprocessar-03.js — relê 03.2026 pelo caminho LOCAL (com visão).
 *
 * ── Por que forceLocal e não forceAI ─────────────────────────────────────────
 * O alvo são as 87 linhas de 03.2026 com origem vazia, que `_origem-vazia.js`
 * diagnosticou: PDF-imagem de 0 caracteres, gravados ANTES de a visão existir
 * (10/09/2026), com tipo "Não identificado" e nenhum campo do pareamento.
 *
 * `forceAI` NÃO serve, e a leitura do código diz por quê: em `analyzePdf`, no bloco
 * `if (forceAI)`, o PDF-imagem vai para o OCR e, se o OCR estiver indisponível,
 * lança `ErroOcrIndisponivel` na linha ~496 — ANTES do `return` da 502, e o gate da
 * visão só aparece na 519. Com o OCR fora (é o caso agora, conferido), forceAI
 * falharia nos 87.
 *
 * `forceLocal` passa pelo caminho normal, onde a ordem é VISÃO → OCR (reserva), e
 * onde o OCR fora do ar explicitamente NÃO impede a gravação se a visão leu
 * (linhas 563-565). É o caminho seguro com o OCR caído.
 *
 * ── A trava que este script respeita ─────────────────────────────────────────
 * [[ocr-cai-com-medicoes-em-paralelo]]: falha de OCR grava vazio POR CIMA do dado
 * bom, e em 10/09 isso atingiu 45 documentos, incluindo notas de R$ 100.000. A
 * proteção está no código (recusa quando `isImage && !visaoUsada`), mas ela só vale
 * se NADA MAIS estiver rodando contra a mesma pasta. Por isso:
 *   · roda uma pasta só, em série, sem paralelismo;
 *   · imprime progresso para dar para abortar;
 *   · conta erros e os separa de "processados".
 *
 * Custo: a visão é paga (~US$ 0,0012/doc no gpt-4.1-mini). Só os PDF-imagem a
 * acionam; o resto do mês vem do cache.
 *
 * Uso: node _medir/_reprocessar-03.js [--confirmar]
 *      Sem --confirmar só mostra o que faria (dry-run).
 */
'use strict';
const path = require('path');
const h = require('./harness');
const { processFolderAuto } = require('../routes/process-folder');

const RAIZ_ARQ = process.env.ARQUIVO_PATH || process.env.MONITOR_PATH;
const PASTA = '2026.03.EXTRATOS CONTABILIDADE';
const CONFIRMAR = process.argv.includes('--confirmar');

(async () => {
    const dir = path.join(RAIZ_ARQ, PASTA);
    console.log(`pasta:   ${dir}`);
    console.log(`modo:    forceLocal (visão roda; OCR é reserva)`);
    console.log(`VISAO:   ${String(process.env.VISAO_PDF ?? '1') !== '0' ? 'ATIVA' : 'DESLIGADA'}`);
    console.log(`OPENAI:  ${process.env.OPENAI_API_KEY ? 'chave presente' : 'AUSENTE'}\n`);

    if (!CONFIRMAR) {
        console.log('DRY-RUN — nada foi gravado.');
        console.log('Para executar de verdade: node _medir/_reprocessar-03.js --confirmar');
        process.exit(0);
    }

    const t0 = Date.now();
    let ultimo = '';
    const r = await processFolderAuto(
        dir,
        (p) => {
            // onProgress: imprime só quando muda de arquivo, para o log ser legível.
            const s = typeof p === 'string' ? p : (p && (p.message || p.file || JSON.stringify(p))) || '';
            if (s && s !== ultimo) { ultimo = s; console.error(`  ${String(s).slice(0, 100)}`); }
        },
        () => false,   // isPaused
        () => false,   // isStopped
        { forceLocal: true },
    );

    const seg = ((Date.now() - t0) / 1000).toFixed(0);
    console.log(`\n── RESULTADO (${seg}s) ──────────────────────────────────────`);
    console.log(JSON.stringify(r, null, 2));
    if (r.errors) {
        console.log(`\n⚠  ${r.errors} erro(s). Se forem ErroOcrIndisponivel em PDF-imagem,`);
        console.log('   a recusa é PROPOSITAL: o código preferiu manter o dado antigo a');
        console.log('   gravar vazio por cima. Subir o OCR e repetir alcança esses.');
    }
    process.exit(0);
})();
