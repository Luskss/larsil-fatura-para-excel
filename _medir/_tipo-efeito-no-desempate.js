/**
 * ⚠️ CONCLUSÃO REFUTADA — o argumento analítico daqui está ERRADO.
 *
 * Este script conclui que "o conserto nunca muda o documento escolhido", porque só
 * concede ponto e o empate é resolvido por `>` estrito. O raciocínio ignora a
 * ULTRAPASSAGEM: quando o vencedor antigo tinha score 2 e outro candidato ganha o
 * ponto de tipo, o novo passa com 3. Empate preserva; ultrapassagem não.
 *
 * Medido depois: 64 cenários REALMENTE trocam de vencedor (`_tipo-trocas-importam.js`).
 * Inofensivos — valor nunca piora, todos em grupos 1↔N — mas existem.
 * Ver [[tipobate-mexe-no-desempate-1-para-n]].
 *
 * _medir/_tipo-efeito-no-desempate.js — o conserto muda QUAL documento casa?
 *
 * RISCO (21/09/2026): `_tipo-efeito-do-conserto.js` confirmou o ganho no PAINEL
 * (147 falsos mortos, 1 cegado). Mas `tipoBate` tem um SEGUNDO uso que eu quase
 * deixei passar: em `_baseline.js:959` ele vale 1 ponto no score de desempate
 * entre candidatos —
 *
 *     const score = (vOk ? 2 : 0) + (tOk ? 1 : 0);
 *
 * Afrouxar `tipoBate` faz mais candidatos pontuarem o ponto de tipo. Onde dois
 * candidatos empatavam em valor e eram separados SÓ pelo tipo, o conserto pode
 * inverter a escolha — casar o lançamento com outro documento.
 *
 * Isso não aparece na medição de alertas: lá eu comparo o veredito de tipo par a
 * par, com os pares JÁ formados. Aqui a pergunta é se o conjunto de pares muda.
 *
 * ── O que se mede ───────────────────────────────────────────────────────────
 * Simula o desempate das duas maneiras (tipoBate de HEAD × o de disco) sobre os
 * candidatos reais, e conta em quantos o vencedor MUDA.
 *
 * Um empate de score só se desfaz quando `vOk` é igual entre os candidatos e `tOk`
 * difere — então o alvo são os grupos com 2+ candidatos.
 *
 * SOMENTE LEITURA.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const h = require('./harness');

const norm = s => String(s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

function tipoBateDe(src) {
    const m = src.match(/function tipoBate[\s\S]*?\n\}/);
    const re = src.match(/const ACESSORIO_NO_NOME_RE[\s\S]*?\n\}/);
    return new Function('norm', `${re ? re[0] : ''}\n${m[0]}; return tipoBate;`)(norm);
}

(async () => {
    const antesSrc = execFileSync('git', ['show', 'HEAD:routes/_baseline.js'],
        { cwd: h.RAIZ, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    const depoisSrc = fs.readFileSync(path.join(h.RAIZ, 'routes', '_baseline.js'), 'utf8');
    const A = tipoBateDe(antesSrc), D = tipoBateDe(depoisSrc);

    // ── o universo onde o desempate pode virar ──────────────────────────────
    // Para o vencedor mudar é preciso: 2+ candidatos, mesmo vOk, e tOk DIFERENTE
    // entre as versões em pelo menos um deles. Enumeramos as combinações de tipo
    // possíveis e vemos quais mudam de veredito — isso delimita o risco sem
    // depender de reconstruir o fluxo inteiro de candidatos.
    const TIPOS_BANCO = ['NF', 'NFS', 'FATURA', 'CTE', 'RECIBO', 'IMPOSTO', 'CONSORCIO', 'Não identificado'];
    const TIPOS_PLAN  = ['NF', 'NFS', 'FATURA', 'IMPOSTO', '*', ''];
    const COM = '001.DOC- 100,00 - 2026.01.01. X. NF 1 + BOL.pdf';
    const SEM = '001.DOC- 100,00 - 2026.01.01. X. NF 1.pdf';

    console.log('── combinações em que o veredito de tipo MUDA ────────────────');
    console.log('  (só estas podem alterar o score de desempate)\n');
    console.log('  banco        planilha   nome          antes  depois');
    let n = 0;
    for (const tb of TIPOS_BANCO) {
        for (const tp of TIPOS_PLAN) {
            for (const [rot, arq] of [['com +BOL', COM], ['sem +BOL', SEM]]) {
                const rowB = { arquivo: arq, tipo: tb };
                const nota = { tipoBanco: tp };
                const a = A(tb, nota, rowB), d = D(tb, nota, rowB);
                if (a === d) continue;
                n++;
                console.log(`  ${tb.padEnd(12)} ${(tp || '(vazio)').padEnd(10)} ${rot.padEnd(13)} ${String(a).padStart(5)}  ${String(d).padStart(6)}`);
            }
        }
    }
    console.log(`\n  total de combinações afetadas: ${n}`);
    console.log('  → todas na direção false→true (afrouxa). O conserto NUNCA tira');
    console.log('    um ponto de score, só concede. Não existe candidato que PERCA');
    console.log('    posição; no máximo um que ESTAVA perdendo passa a empatar.');

    // ── o desempate: empate de score resolve pela ORDEM ─────────────────────
    const src = depoisSrc;
    const m = src.match(/let melhor = null;[\s\S]*?if \(!melhor \|\| score > melhor\.score\)[^\n]*\n/);
    console.log('\n── como o empate é resolvido no código ──────────────────────');
    console.log(m ? m[0].split(/\r?\n/).map(l => '  ' + l.trim()).join('\n') : '  (não achei)');
    console.log('  `score > melhor.score` (estrito): em EMPATE o PRIMEIRO da lista vence.');
    console.log('  Logo, conceder 1 ponto a um candidato que já vinha DEPOIS do vencedor');
    console.log('  só o faz ULTRAPASSAR se ele estava 1 ponto atrás — ou seja, se o');
    console.log('  vencedor tinha tipo ok e ele não, com mesmo vOk.');

    console.log('\n── o caso de risco, concretamente ───────────────────────────');
    console.log('  lançamento planilha=NF, dois candidatos com MESMO valor:');
    const c1 = { arquivo: SEM, tipo: 'NF' };       // tipo bate nas duas versões
    const c2 = { arquivo: COM, tipo: 'FATURA' };   // só bate DEPOIS
    for (const [rot, fn] of [['antes ', A], ['depois', D]]) {
        const s1 = 2 + (fn(c1.tipo, { tipoBanco: 'NF' }, c1) ? 1 : 0);
        const s2 = 2 + (fn(c2.tipo, { tipoBanco: 'NF' }, c2) ? 1 : 0);
        const venc = s1 >= s2 ? 'candidato 1 (NF)' : 'candidato 2 (FATURA+BOL)';
        console.log(`    ${rot}: score NF=${s1}  FATURA+BOL=${s2}  → vence ${venc}`);
    }
    console.log('\n  → com valores iguais o candidato NF continua ganhando ou empatando,');
    console.log('    e no empate a ordem preserva o vencedor antigo. A inversão exigiria');
    console.log('    o candidato FATURA vir ANTES na lista E o de NF ter perdido o ponto,');
    console.log('    o que o conserto não faz (nunca tira ponto).');
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
