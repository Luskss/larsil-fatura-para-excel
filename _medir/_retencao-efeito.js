/**
 * _medir/_retencao-efeito.js — o efeito da regra, medido na rota de verdade.
 *
 * Usa `divergenciasDeValor` e `camposOcr` DA PRÓPRIA ROTA (via harness), não uma
 * cópia: medir contra reimplementação foi o erro que a memória do projeto registra
 * em `armadilha-medir-sem-ocr.md`.
 *
 * O `dados_parser` gravado no banco AINDA NÃO tem os campos de retenção (o parser
 * de NFS-e nasceu hoje; só a próxima releitura os grava). Então este medidor
 * reprocessa o PDF na hora com `parseNfse` e injeta os campos, para responder
 * "o que a tela vai mostrar depois que o acervo for relido?".
 */
'use strict';
const fs = require('fs');
const path = require('path');
const h = require('./harness');
const p = require('../routes/_pareamento');
const parsers = require('../routes/_nf-parsers');
const { indexar } = require('./ocr');
const { PDFParse } = require('pdf-parse');

const RAIZ_ARQ = process.env.ARQUIVO_PATH || process.env.MONITOR_PATH;

// As internas da rota, incluindo as novas.
function internas() {
    const src = fs.readFileSync(path.join(h.RAIZ, 'routes', 'comparar-notas.js'), 'utf8');
    const corte = src.indexOf('module.exports = async function compararNotasRoute');
    const corpo = src.slice(0, corte);
    const requireRotas = require('module').createRequire(path.join(h.RAIZ, 'routes', 'x.js'));
    const f = new Function('require', 'module', 'exports', '__dirname', `
        ${corpo}
        return { divergenciasDeValor, retencaoDoParser, camposOcr };
    `);
    return f(requireRotas, { exports: {} }, {}, path.join(h.RAIZ, 'routes'));
}

async function texto(rel) {
    const abs = path.join(RAIZ_ARQ, rel || '');
    if (!rel || !fs.existsSync(abs)) return null;
    let pr;
    try {
        pr = new PDFParse({ data: new Uint8Array(fs.readFileSync(abs)) });
        const r = await pr.getText();
        return (r.text || '').replace(/--\s*\d+\s+of\s+\d+\s*--/gi, ' ');
    } catch (e) { return null; }
    finally { try { if (pr) await pr.destroy(); } catch (_) {} }
}

(async () => {
    const rota = internas();
    const { pasta, planilha } = h.carregar();
    const ocr = await indexar();

    // Enriquecimento extra: para cada arquivo, roda parseNfse e guarda a retenção.
    // Cache em disco — reler ~4 mil PDFs da rede a cada medição seria inviável.
    const cacheRet = path.join(h.CACHE, 'retencao.json');
    let retPorArquivo = fs.existsSync(cacheRet) ? JSON.parse(fs.readFileSync(cacheRet, 'utf8')) : null;

    if (!retPorArquivo) {
        retPorArquivo = {};
        // Só os arquivos que participam de algum par: ler todo o acervo é caro e
        // a pergunta é sobre as divergências.
        const alvos = new Set();
        for (const periodo of h.PERIODOS)
            for (const off of [0, ...p.VIZINHANCA]) {
                const alvo = p.deslocarPeriodo(periodo, off);
                for (const a of (pasta.arquivosPorMes[alvo] || [])) alvos.add(JSON.stringify([a.nome, a.rel]));
            }
        const lista = [...alvos].map(s => JSON.parse(s));
        console.error(`[ret] lendo ${lista.length} PDFs (uma vez; depois fica em cache)...`);
        let i = 0;
        for (const [nome, rel] of lista) {
            if (++i % 400 === 0) console.error(`  ${i}/${lista.length}`);
            const tx = await texto(rel);
            if (!tx) continue;
            let cls;
            try { cls = parsers.classify(tx, nome); } catch (e) { continue; }
            if (cls.tipo !== 'NFS' || !cls.parser) continue;
            let campos;
            try { campos = cls.parser(tx); } catch (e) { continue; }
            const r = rota.retencaoDoParser(campos);
            if (r) retPorArquivo[nome] = r;
        }
        fs.writeFileSync(cacheRet, JSON.stringify(retPorArquivo));
    }
    console.error(`[ret] arquivos com retenção conferida: ${Object.keys(retPorArquivo).length}`);

    const somar = (acc, x) => {
        for (const k of ['divergentes', 'parcelas', 'retencoes']) acc[k] = (acc[k] || 0) + (x[k] || 0);
        for (const k of ['valorDivergencia', 'valorParcelas', 'valorRetencoes'])
            acc[k] = (acc[k] || 0) + (x[k] || 0);
        acc.linhas.push(...(x.todosDivergentes || []));
        return acc;
    };

    const rodar = (comRetencao) => {
        const acc = { linhas: [] };
        for (const periodo of h.PERIODOS) {
            const docsPorMes = {};
            for (const off of [0, ...p.VIZINHANCA]) {
                const alvo = p.deslocarPeriodo(periodo, off);
                docsPorMes[alvo] = (pasta.arquivosPorMes[alvo] || []).map(a => {
                    const base = ocr[a.nome] ? { ...ocr[a.nome] } : {};
                    if (comRetencao && retPorArquivo[a.nome]) base.retencao = retPorArquivo[a.nome];
                    return p.enriquecerComOcr(p.documentoDoArquivo(a.nome, a.rel),
                        Object.keys(base).length ? base : null);
                });
            }
            const lancs = ((planilha[periodo] || {}).itens || []).map(p.lancamentoDaPlanilha);
            const r = p.conferirPeriodo(lancs, docsPorMes, periodo);
            somar(acc, rota.divergenciasDeValor([...r.pares, ...r.paresVizinhos]));
        }
        return acc;
    };

    const antes = rodar(false);
    const depois = rodar(true);

    const brl = v => 'R$ ' + (v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 });
    console.log('\n                        ANTES        DEPOIS');
    console.log(`divergentes na lista  ${String(antes.divergentes).padStart(7)}  ${String(depois.divergentes).padStart(12)}`);
    console.log(`  valor              ${brl(antes.valorDivergencia).padStart(16)} ${brl(depois.valorDivergencia).padStart(16)}`);
    console.log(`parcelas (fora)       ${String(antes.parcelas).padStart(7)}  ${String(depois.parcelas).padStart(12)}`);
    console.log(`retenções (fora)      ${String(antes.retencoes || 0).padStart(7)}  ${String(depois.retencoes).padStart(12)}`);
    // Imposto efetivamente retido, somado dos campos da nota — não é a "diferença"
    // das outras linhas: aqui os dois lados batem, e este é o tributo.
    console.log(`  imposto retido     ${brl(antes.valorRetencoes).padStart(16)} ${brl(depois.valorRetencoes).padStart(16)}`);

    // INVARIANTE: nada some sem ser contado. Uma linha sai da lista porque o par
    // passou a bater (o BRUTO virou o valor do documento) E foi contada em
    // `retencoes`. Se saísse sem ser contada, o rodapé não explicaria o sumiço e a
    // tela mostraria menos divergências sem dizer por quê.
    // `contadas` é MAIOR que `saiu`, e não igual: parte dos pares com retenção já
    // batia por outro caminho (o nome do arquivo trazia o bruto, ou o lançamento
    // era o líquido) e nunca esteve na lista de divergências. Agora eles ficam
    // explicitamente marcados como retenção. Por isso a invariante é `saiu <=
    // contadas`, não igualdade.
    //
    // ARMADILHA (custou uma rodada): este medidor lê as internas da rota fatiando
    // o FONTE de comparar-notas.js. Editar a rota DEPOIS de lançar a medição faz
    // ela rodar contra o código antigo e reportar zero — foi o que aconteceu na
    // primeira execução. Rode de novo depois de mexer na rota.
    const saiu = antes.divergentes - depois.divergentes;
    const ganhou = depois.retencoes - (antes.retencoes || 0);
    console.log(`\nsaíram da lista: ${saiu}   contadas como retenção: ${ganhou}`);
    console.log(saiu <= ganhou
        ? 'OK — toda linha que saiu está contada como retenção.'
        : `*** ATENÇÃO: ${saiu - ganhou} linhas sumiram sem ser classificadas.`);

    // Quem saiu, nominalmente, para conferência humana.
    const chave = x => `${x.entidade}|${x.nf}|${x.valorPlanilha}`;
    const dep = new Set(depois.linhas.map(chave));
    const removidas = antes.linhas.filter(x => !dep.has(chave(x)));
    console.log(`\nAS ${removidas.length} LINHAS QUE SAÍRAM (agora classificadas como retenção):`);
    for (const x of removidas.sort((a, b) => Math.abs(b.diferenca) - Math.abs(a.diferenca)))
        console.log(`  ${String(x.entidade).slice(0, 28).padEnd(28)} NF ${String(x.nf).padEnd(8)} ` +
            `pl ${x.valorPlanilha.toFixed(2).padStart(11)}  doc ${x.valorDocumento.toFixed(2).padStart(11)}  ` +
            `dif ${x.diferenca.toFixed(2).padStart(10)} (${x.percentual.toFixed(1)}%)`);

    // E o que ENTROU (não deveria entrar nada).
    const ant = new Set(antes.linhas.map(chave));
    const novas = depois.linhas.filter(x => !ant.has(chave(x)));
    if (novas.length) {
        console.log(`\n*** ${novas.length} LINHAS NOVAS na lista (inesperado):`);
        for (const x of novas)
            console.log(`  ${x.entidade} NF ${x.nf} pl ${x.valorPlanilha} doc ${x.valorDocumento}`);
    } else console.log('\nnenhuma linha nova entrou na lista.');

    process.exit(0);
})();
