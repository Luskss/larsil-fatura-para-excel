/**
 * _medir/_tipo-cte-veredito.js — NF→CTE: consertar ou não?
 *
 * TENTATIVA ANTERIOR REPROVADA: `_tipo-cte-ler-o-papel.js` quis reler o texto do
 * PDF pela coluna `conteudo` do banco. Essa coluna guarda só o RÓTULO de
 * procedência ("Texto", "Imagem (OCR)") — 5 caracteres. O texto do PDF não é
 * persistido em lugar nenhum.
 *
 * Mas a prova que eu procurava já existe: a coluna `evidencia` guarda O TRECHO QUE
 * O CLASSIFICADOR CASOU no papel, no momento do processamento. Quando ela diz
 * "DACTE" ou "MDF-E" com origem `conteúdo`, isso é o marcador lido do documento —
 * testemunho direto, não inferência.
 *
 * ── O critério ──────────────────────────────────────────────────────────────
 * origem=conteúdo + evidência é marcador canônico → o papel É um CT-e.
 *   A planilha lança frete como "NOTA FISCAL RFB", e o alerta PROCEDE:
 *   silenciá-lo esconderia divergência real de classificação contábil.
 *
 * origem=IA + evidência é só o nome do emitente → a IA deduziu "transportadora,
 *   logo CT-e" sem marcador no papel. Aí o alerta pode ser falso.
 *
 * SOMENTE LEITURA.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const h = require('./harness');

const pct = (a, b) => b ? `${(100 * a / b).toFixed(0)}%` : '—';
const norm = s => String(s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

// marcador canônico de CT-e: a evidência É o trecho casado no papel
const EV_CANONICA = /^(DACTE|CT-?E|MDF-?E|CONHECIMENTO DE TRANSPORTE|DOCUMENTO AUXILIAR DO CONHECIMENTO|TRANSPORTE RODOVIARIO DE CARGAS)$/;

(async () => {
    const idx = JSON.parse(fs.readFileSync(path.join(h.CACHE, 'tipo-por-arquivo.json'), 'utf8'));
    const ctes = Object.entries(idx).filter(([, i]) => i.tipo === 'CTE');

    let doPapel = 0, daIA = 0;
    const listaPapel = [], listaIA = [];
    for (const [arq, i] of ctes) {
        const ev = String(i.evidencia || '').trim();
        const org = String(i.origem || '').trim();
        const canonica = EV_CANONICA.test(norm(ev));
        if (org === 'conteúdo' && canonica) { doPapel++; listaPapel.push([arq, ev]); }
        else { daIA++; listaIA.push([arq, ev, org]); }
    }

    console.log(`documentos CTE no acervo: ${ctes.length}\n`);
    console.log(`── marcador LIDO DO PAPEL (origem=conteúdo, evidência canônica): ${doPapel}`);
    for (const [arq, ev] of listaPapel)
        console.log(`   "${ev}"  ${arq.slice(0, 58)}`);
    console.log(`\n── deduzido pela IA (sem marcador no papel): ${daIA}`);
    for (const [arq, ev, org] of listaIA)
        console.log(`   [${org}] "${String(ev).slice(0, 38)}"  ${arq.slice(0, 44)}`);

    console.log(`\n${'═'.repeat(70)}`);
    console.log('VEREDITO');
    console.log('═'.repeat(70));
    console.log(`\n  ${doPapel} de ${ctes.length} (${pct(doPapel, ctes.length)}) têm o marcador DACTE/CT-e/MDF-e`);
    console.log('  lido do próprio documento. Nesses, a classificação CTE está CERTA e');
    console.log('  quem diverge é a planilha, que lança o frete como "NOTA FISCAL RFB".');
    console.log('\n  → o alerta NF→CTE PROCEDE nesses casos. NÃO silenciar: é exatamente');
    console.log('    o tipo de divergência que o painel existe para mostrar.');
    console.log('\n  → e a minha régua errou: `tipoDoNome` lê "NF" no nome e conclui que o');
    console.log('    classificador falhou. Mas o arquivista escreve "NF" como sinônimo de');
    console.log('    NOTA, não como tipo fiscal — o transportador emite CT-e. Os 10');
    console.log('    "falsos" NF→CTE não são falsos; são a régua que não sabe ler frete.');
    console.log('\n  CONCLUSÃO: NF→CTE não é defeito a consertar. O pool real de conserto');
    console.log('  nesta rodada é só FATURA→IMPOSTO (3 casos, marcador fraco "GUIA").');
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
