/**
 * _medir/_efeito-conserto-gabarito.js — o conserto do gabarito move pares?
 *
 * ── O bug ────────────────────────────────────────────────────────────────────
 * `valorDoNome` lê a DATA como valor quando o nome começa pela data:
 *
 *   "001.DOC- 2026.01.02. 17.904,40 -PAGTO FINANC VEIC 3148.pdf"  →  R$ 2.026
 *   "002.DOC- 2025.10.21 - SEGURO PRESTAMISTA.pdf"                →  R$ 2.025
 *
 * A 4ª alternativa (`(\d+)(?=\s*[-.\s])`) casa "2026" porque o lookahead aceita o
 * PONTO da data. O guarda existente (`/^\d{8}$/`) só pega "20260102" colado.
 *
 * 19 nomes no acervo (15.982 PDFs) estão nessa condição.
 *
 * ── Por que é o pior dos dois bugs ───────────────────────────────────────────
 * O gabarito corrompido não só perde o par: ele CONTAMINA a trava da visão. Um
 * documento de R$ 165.903,28 fica com gabarito R$ 2.026, então `conferirValor`
 * compara a leitura boa contra 2.026, marca `diverge` e DESCARTA o valor certo,
 * gravando-o como "não confere com o nome". O mecanismo de
 * [[gabarito-frouxo-inventa-erro]] rodando em produção.
 *
 * ── O que este script mede ───────────────────────────────────────────────────
 * `_pareamento.js` é o motor do comparador, então [[metrica-pareada-nao-ratio]]
 * manda medir por COBERTURA PAREADA, nunca por total. Roda `conferirPeriodo` duas
 * vezes sobre as MESMAS fontes, trocando só a função de valor:
 *
 *   ANTES  = `valorDoNome` como está no fonte hoje
 *   DEPOIS = a versão consertada (definida aqui, idêntica à que vai para o fonte)
 *
 * e reporta pares, órfãos dos dois lados e QUAIS lançamentos mudaram de estado.
 * O conserto só entra se não perder par.
 *
 * SOMENTE LEITURA (não escreve no banco nem no fonte).
 *
 * Uso: node _medir/_efeito-conserto-gabarito.js [periodo]
 */
'use strict';
const h = require('./harness');
const p = require('../routes/_pareamento');
const { indexar } = require('./ocr');

const PERIODO = process.argv[2] || '03.2026';

// ── A versão CONSERTADA, idêntica à que vai para `_pareamento.js` ────────────
// O conserto é uma linha: antes de aceitar o número, rejeitar se ele for o ANO de
// uma data no formato AAAA.MM.DD ou AAAA-MM-DD logo em seguida. Não toco nas 3
// primeiras alternativas: elas exigem centavos ou grupos de milhar e nunca casam
// uma data.
const RE_DATA_COMO_VALOR = /^20\d{2}$/;
function valorDoNomeConsertado(nome) {
    const n = String(nome || '');
    const m = n.match(/\.DOC-?\s*(?:R\$\s*)?(\d{1,3}(?:\.\d{3})+,\d{2})/i)
           || n.match(/\.DOC-?\s*(?:R\$\s*)?(\d+,\d{2})/i)
           || n.match(/\.DOC-?\s*(?:R\$\s*)?(\d{1,3}(?:\.\d{3})+)(?![\d,])/i)
           || n.match(/\.DOC-?\s*(?:R\$\s*)?(\d+)(?=\s*[-.\s])/i);
    if (!m) return null;
    if (/^\d{8}$/.test(m[1])) return null;
    // NOVO: "2026" seguido de ".01.02" (ou "-01-02") é o ANO de uma data, não
    // dinheiro. Só vale para a 4ª alternativa, que é a única sem centavos nem
    // grupo de milhar — as outras não conseguem casar uma data.
    if (RE_DATA_COMO_VALOR.test(m[1])) {
        const resto = n.slice(m.index + m[0].length);
        if (/^[.\-]\s*\d{1,2}[.\-]\s*\d{1,2}/.test(resto)) return null;
    }
    const v = Number(m[1].replace(/\./g, '').replace(',', '.'));
    return isFinite(v) && v > 0 ? v : null;
}

// ── Carregar o módulo com a função TROCADA no fonte ──────────────────────────
// Monkey-patch no export NÃO funciona aqui, e isso é medido: `documentoDoArquivo`
// chama `valorDoNome(nome)` na linha 285 — a função LOCAL, não `exports.valorDoNome`.
// Trocar o export deixaria o pareamento usando a versão velha e a medição diria
// "0 mudanças", parecendo aprovação. É a mesma armadilha de
// [[modelo-visao-medido-nao-suposto]] (o require congela a referência).
//
// A forma que funciona: reescrever o CORPO da função no fonte e avaliar o módulo
// num require isolado. Assim a chamada interna da linha 285 passa a ver a versão
// nova, que é exatamente o que vai acontecer quando eu editar o arquivo.
const fs = require('fs');
const path = require('path');
const Module = require('module');

function carregarPareamentoCom(corpoNovo) {
    const arq = path.join(h.RAIZ, 'routes', '_pareamento.js');
    const src = fs.readFileSync(arq, 'utf8');
    const i = src.indexOf('function valorDoNome(nome) {');
    if (i < 0) throw new Error('não achei valorDoNome em _pareamento.js — fonte mudou?');
    // fim da função: o primeiro "\n}" na coluna 0 depois do início
    const fim = src.indexOf('\n}', i);
    if (fim < 0) throw new Error('não achei o fim de valorDoNome');
    const novo = src.slice(0, i) + corpoNovo.trim() + src.slice(fim + 2);

    const m = new Module(arq, null);
    m.filename = arq;
    m.paths = Module._nodeModulePaths(path.dirname(arq));
    m._compile(novo, arq);
    return m.exports;
}

// A 1ª versão deste conserto devolvia `null` quando detectava a data — e a trava de
// sanidade deste script pegou: em "001.DOC- 2026.01.02. 17.904,40 -PAGTO..." o
// certo não é desistir, é PULAR a data e achar os 17.904,40 que vêm depois.
// Descartar seria trocar um gabarito errado por gabarito nenhum, perdendo o par.
//
// Forma do conserto: remover do nome o trecho da DATA (logo após o ".DOC-") antes
// de rodar as alternativas. Assim "…DOC- 2026.01.02. 17.904,40…" vira
// "…DOC-  17.904,40…" e a 1ª alternativa (milhar com centavos) casa naturalmente.
const CORPO_CONSERTADO = `function valorDoNome(nome) {
    let n = String(nome || '');
    // Data imediatamente após ".DOC-" é PREFIXO de nome, não dinheiro: quem
    // arquiva escreve "001.DOC- 2026.01.02. 17.904,40 - PAGTO...". Sem remover,
    // a 4ª alternativa casa "2026" (o lookahead aceita o ponto da data) e o
    // gabarito do documento passa a ser R$ 2.026 — 19 nomes no acervo.
    // O que vem DEPOIS da data varia: "." ("2026.01.02. 17.904,40"), "-"
    // ("2026.01.26- R$ 165.903,28") ou " - " ("2026.02.02 - 8.099,99"). O sufixo
    // [.\\-\\s]* cobre os três; sem ele o "R\\$" e o milhar não eram alcançados e o
    // conserto devolvia null (2 dos 8 casos de sanidade falharam assim).
    n = n.replace(/(\\.DOC-?\\s*)(?:R\\$\\s*)?20\\d{2}[.\\-]\\s*\\d{1,2}[.\\-]\\s*\\d{1,2}[.\\-\\s]*/i, '$1 ');
    const m = n.match(/\\.DOC-?\\s*(?:R\\$\\s*)?(\\d{1,3}(?:\\.\\d{3})+,\\d{2})/i)
           || n.match(/\\.DOC-?\\s*(?:R\\$\\s*)?(\\d+,\\d{2})/i)
           || n.match(/\\.DOC-?\\s*(?:R\\$\\s*)?(\\d{1,3}(?:\\.\\d{3})+)(?![\\d,])/i)
           || n.match(/\\.DOC-?\\s*(?:R\\$\\s*)?(\\d+)(?=\\s*[-.\\s])/i);
    if (!m) return null;
    if (/^\\d{8}$/.test(m[1])) return null;
    const v = Number(m[1].replace(/\\./g, '').replace(',', '.'));
    return isFinite(v) && v > 0 ? v : null;
}`;

function rodar(mod, pasta, planilha, ocr) {
    const docsPorMes = {};
    for (const off of [0, ...mod.VIZINHANCA]) {
        const alvo = mod.deslocarPeriodo(PERIODO, off);
        docsPorMes[alvo] = (pasta.arquivosPorMes[alvo] || []).map(a =>
            mod.enriquecerComOcr(mod.documentoDoArquivo(a.nome, a.rel), ocr[a.nome]));
    }
    const lancs = ((planilha[PERIODO] || {}).itens || []).map(mod.lancamentoDaPlanilha);
    return mod.conferirPeriodo(lancs, docsPorMes, PERIODO);
}

const chave = l => `${l.entidade}|${l.nf}|${l.valor}`;

(async () => {
    const { pasta, planilha } = h.carregar();
    console.error('[gabarito] indexando OCR do banco...');
    const ocr = await indexar();

    // Quantos nomes o conserto muda, no acervo do período + vizinhança?
    const modNomes = carregarPareamentoCom(CORPO_CONSERTADO);
    let mudados = 0;
    const exemplos = [];
    for (const off of [0, ...p.VIZINHANCA]) {
        const alvo = p.deslocarPeriodo(PERIODO, off);
        for (const a of (pasta.arquivosPorMes[alvo] || [])) {
            const antes = p.valorDoNome(a.nome), depois = modNomes.valorDoNome(a.nome);
            const igual = (antes == null && depois == null) || (antes != null && depois != null && Math.abs(antes - depois) < 0.005);
            if (!igual) { mudados++; if (exemplos.length < 12) exemplos.push({ n: a.nome, antes, depois }); }
        }
    }
    console.log(`nomes cujo VALOR muda com o conserto: ${mudados}`);
    for (const e of exemplos) console.log(`   ${String(e.antes).padStart(10)} → ${String(e.depois).padStart(10)}   ${e.n.slice(0, 56)}`);

    // ANTES = o módulo como está no disco; DEPOIS = o módulo com a função trocada
    // no FONTE (única forma de a chamada interna da linha 285 ver a versão nova).
    const modDepois = carregarPareamentoCom(CORPO_CONSERTADO);
    // ── sanidade do patch, com casos dos DOIS lados ──────────────────────────
    // Não basta o caso que motivou o conserto: preciso provar que os nomes NORMAIS
    // continuam iguais. A 1ª versão do conserto passava no caso-alvo devolvendo
    // null e teria "funcionado" sem esta bateria.
    const CASOS = [
        // [nome, esperado DEPOIS, esperado ANTES (o bug), rótulo]
        ['001.DOC- 2026.01.02. 17.904,40 -PAGTO FINANC VEIC 3148.pdf', 17904.40, 2026, 'data+valor'],
        ['001.DOC- 2026.01.26- R$ 165.903,28. GIRO PEAC - FGI.pdf',   165903.28, 2026, 'data+R$'],
        ['006.DOC- 2026.02.02 - 8.099,99. CONTA GARANTIDA PJ.pdf',       8099.99, 2026, 'data+milhar'],
        // sem valor nenhum depois da data: continua null nas duas versões
        ['002.DOC- 2025.10.21 - SEGURO PRESTAMISTA.pdf',                    null, 2025, 'data sem valor'],
        // nomes NORMAIS: o conserto não pode mexer
        ['094.DOC- 383,70 - 2026.02.28. SAVANA. NFS 37228 + BOL.pdf',     383.70, 383.70, 'normal'],
        ['001.DOC- R$ 166.960,86 - 7615-0100 - ATACADO - GIRO.pdf',    166960.86, 166960.86, 'normal R$'],
        ['004.DOC- R$ 26,67-   Grupo  681-    Cota  -294.pdf',             26.67, 26.67, 'normal centavos'],
        ['049.DOC- 23053,79.MARCOS CONSORCIOS CAIXA.pdf',               23053.79, 23053.79, 'sem data'],
    ];
    let falhas = 0;
    for (const [nome, espDepois, espAntes, rot] of CASOS) {
        const vA = p.valorDoNome(nome), vB = modDepois.valorDoNome(nome);
        const bate = (x, y) => (x == null && y == null) || (x != null && y != null && Math.abs(x - y) < 0.005);
        const okB = bate(vB, espDepois);
        if (!okB) { falhas++; console.error(`  ✗ ${rot}: DEPOIS=${vB}, esperado ${espDepois}  "${nome.slice(0, 46)}"`); }
        else console.error(`  ✓ ${rot.padEnd(16)} antes=${String(vA).padStart(10)} depois=${String(vB).padStart(10)}`);
    }
    if (falhas) throw new Error(`${falhas} caso(s) de sanidade falharam — o conserto está errado`);
    console.error('[gabarito] patch conferido nos 8 casos (alvo + normais)\n');

    const A = rodar(p, pasta, planilha, ocr);
    const B = rodar(modDepois, pasta, planilha, ocr);

    // A forma do retorno de `conferirPeriodo` foi conferida no fonte (linha 766),
    // não suposta: `pares` + `paresVizinhos` são os pares, e `lancamentosSemDocumento`
    // é a contagem. Minha 1ª versão leu `r.lancamentos`, que não existe — e o
    // resultado foi "0 lançamentos / APROVADO", um falso positivo que só não passou
    // porque o total zerado é absurdo à vista. Ver [[chave-do-parser-e-em-portugues]]:
    // ler a chave errada devolve zero, e zero parece resultado.
    const resumo = (rot, r) => {
        const nPares = (r.pares || []).length, nViz = (r.paresVizinhos || []).length;
        const semDoc = r.lancamentosSemDocumento ?? '?';
        console.log(`${rot.padEnd(8)} pares=${String(nPares).padStart(4)}  vizinhos=${String(nViz).padStart(4)}` +
            `  TOTAL=${String(nPares + nViz).padStart(4)}  semDocumento=${String(semDoc).padStart(4)}` +
            `  fracos=${String(r.fracos ?? '?').padStart(3)}`);
        return { total: nPares + nViz, semDoc };
    };
    console.log(`\n── COBERTURA PAREADA (${PERIODO}) ──────────────────────────`);
    const ra = resumo('ANTES', A), rb = resumo('DEPOIS', B);
    const d = rb.total - ra.total;
    console.log(`\nvariação de PARES: ${d > 0 ? '+' : ''}${d}`);
    if (typeof ra.semDoc === 'number' && typeof rb.semDoc === 'number')
        console.log(`variação de lançamentos SEM documento: ${rb.semDoc - ra.semDoc > 0 ? '+' : ''}${rb.semDoc - ra.semDoc}`);

    // QUAIS mudaram de estado — é o que [[metrica-pareada-nao-ratio]] exige:
    // reportar os pares que entram E os que saem, não só o saldo.
    const estado = r => {
        const m = new Map();
        for (const par of [...(r.pares || []), ...(r.paresVizinhos || [])])
            m.set(chave(par.lancamento), par.documento && par.documento.caminho);
        return m;
    };
    const ea = estado(A), eb = estado(B);
    const ganhou = [], perdeu = [], trocou = [];
    for (const [k, docA] of ea) {
        const docB = eb.get(k);
        if (!docB) perdeu.push(k);
        else if (docA !== docB) trocou.push({ k, docA, docB });
    }
    for (const [k] of eb) if (!ea.has(k)) ganhou.push(k);
    console.log(`\nlançamentos que GANHARAM documento: ${ganhou.length}`);
    for (const k of ganhou.slice(0, 10)) console.log(`   + ${k.slice(0, 66)}`);
    console.log(`lançamentos que PERDERAM documento: ${perdeu.length}`);
    for (const k of perdeu.slice(0, 10)) console.log(`   − ${k.slice(0, 66)}`);
    console.log(`pares que TROCARAM de documento:    ${trocou.length}`);
    for (const t of trocou.slice(0, 8)) {
        console.log(`   ~ ${t.k.slice(0, 60)}`);
        console.log(`       de:  ${String(t.docA).slice(-52)}`);
        console.log(`       pra: ${String(t.docB).slice(-52)}`);
    }

    console.log(`\n${'─'.repeat(58)}`);
    // Trava contra falso positivo: se o comparador não rodou (0 pares nas duas
    // versões), não há o que aprovar. Foi o que aconteceu quando eu lia a chave
    // errada e o script disse "APROVADO" com lançamentos=0.
    if (ra.total === 0 && rb.total === 0)
        console.log('INCONCLUSIVO: 0 pares nas duas versões — o comparador não rodou.');
    else if (perdeu.length === 0 && mudados > 0)
        console.log(`APROVADO: corrige ${mudados} gabarito(s) no período, ganha ${ganhou.length} par(es), perde 0.`);
    else if (perdeu.length)
        console.log(`REPROVADO: perde ${perdeu.length} par(es) — investigar antes de aplicar.`);
    else
        console.log('NEUTRO neste período: nenhum nome afetado aqui (ver outros meses).');
    process.exit(0);
})();
