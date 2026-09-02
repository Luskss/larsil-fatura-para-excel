/**
 * _medir/variantes.js — mede o motor com sinais ADICIONAIS do OCR.
 *
 * Reimplementa o mínimo do _pareamento.js necessário para variar a regra, usando
 * as MESMAS constantes e helpers do módulo real (importados, não copiados), para
 * a comparação ser contra o motor de produção e não contra uma reescrita.
 */
'use strict';
const par = require('../routes/_pareamento');
const h = require('./harness');
const ocr = require('./ocr');

const DIA_MS = 86400000;
const TOL_VALOR = 0.005;
const MIN_DIGITOS_NUM = 3;

// ── Documento enriquecido: nome do arquivo + o que o OCR extraiu do miolo ────
function enriquecer(doc, o) {
    if (!o) return doc;
    const d = { ...doc };
    d.ocr = true;
    // O nome tem prioridade (foi digitado por quem arquivou e é o que o motor
    // atual usa); o OCR só PREENCHE o que falta.
    if (!d.numeroDig && o.numero && o.numero.length >= MIN_DIGITOS_NUM) {
        d.numeroDig = o.numero;
        d.numeroDeOcr = true;
    }
    if (d.valor == null && o.valor != null) { d.valor = o.valor; d.valorDeOcr = true; }
    if (d.data == null && o.dtEmissao != null) { d.data = o.dtEmissao; }
    // Tokens do emitente entram JUNTO com os do nome — fornecedor escrito de
    // forma diferente no papel e na planilha é uma das causas de não casar.
    // Emitente "LARSIL" é o próprio pagador (recibo, consórcio): não identifica
    // fornecedor nenhum e casaria com qualquer lançamento nosso.
    if (o.emitente && !/LARSIL/i.test(o.emitente)) {
        d.tokens = new Set([...d.tokens, ...par.tokens(o.emitente)]);
        d.tokensDeOcr = true;
    }
    // Segundo número do OCR, para o caso do nome trazer um número DIFERENTE
    // (o nome às vezes traz o "nosso número" do boleto, não a NF).
    if (o.numero && o.numero !== d.numeroDig) d.numeroAlt = o.numero;
    if (o.cnpj) d.cnpj = o.cnpj;
    if (o.emitente) d.emitenteOcr = o.emitente;
    return d;
}

// ── Os sinais ────────────────────────────────────────────────────────────────
const valorBate = (l, d) =>
    d.valor != null && l.valor > 0 && Math.abs(l.valor - d.valor) < TOL_VALOR;

// `minDigitos` parametrizável para medir o piso. O piso existe porque um número
// de 1-2 dígitos casaria com muita coisa — mas isso vale para o número SOZINHO, e
// aqui ele é sempre exigido JUNTO com o fornecedor.
function fazNumeroBate(minDigitos) {
    return function numeroBate(l, d) {
        if (l.nfDig.length < minDigitos) return false;
        const cands = [d.numeroDig, d.numeroAlt].filter(x => x && x.length >= minDigitos);
        for (const c of cands)
            if (l.nfDig === c || l.nfDig === String(Number(c))) return true;
        return false;
    };
}
let numeroBate = fazNumeroBate(MIN_DIGITOS_NUM);

const entidadeBate = (l, d) => {
    for (const t of l.tokens) if (d.tokens.has(t)) return true;
    return false;
};

// O CNPJ que o OCR extrai NÃO é confiável como identidade do fornecedor. Medido:
// 530 documentos saem com 08420245000180 (PORTOBENS), e em boa parte deles o
// próprio campo "Emitente" do OCR diz LARSIL — ou seja, num recibo, consórcio ou
// boleto o CNPJ impresso é o do PAGADOR ou o da administradora, não o do
// fornecedor do lançamento. Usar isso como veto rejeitava 718 pares bons (37%).
//
// Por isso o CNPJ do documento só vale quando o EMITENTE que o OCR leu corrobora
// o fornecedor do lançamento — aí os dois campos contam a mesma história, e a
// divergência de CNPJ passa a ser evidência de verdade.
const RAIZ_NOSSA = new Set(['08420245']);
const ehNossa = t => /LARSIL/i.test(String(t || ''));

// A planilha traz CNPJ como NÚMERO, então o Excel come o zero à esquerda:
// "01616929000102" chega como 1616929000102 (13 dígitos). Sem re-preencher, a
// comparação por prefixo acusa divergência falsa em TODO CNPJ que começa com 0
// — era a causa de 838 "contradições" na primeira medição.
function normCnpj(c) {
    const d = String(c || '').replace(/\D/g, '');
    if (!d) return null;
    if (d.length === 14 || d.length === 11) return d;          // CNPJ / CPF completos
    if (d.length === 13 || d.length === 12) return d.padStart(14, '0');  // zero comido
    if (d.length === 10 || d.length === 9) return d.padStart(11, '0');   // CPF sem zero
    return null;
}
// Raiz: 8 dígitos do CNPJ (filial do mesmo grupo é o mesmo fornecedor). Para CPF
// (11 dígitos) a chave é o CPF inteiro — não tem raiz.
function raiz(c) {
    const n = normCnpj(c);
    if (!n) return null;
    if (n.length === 11) return n;                 // CPF
    const r = n.slice(0, 8);
    return RAIZ_NOSSA.has(r) ? null : r;           // o nosso não identifica fornecedor
}
// CNPJ do DOCUMENTO só conta quando o emitente lido pelo OCR não é a própria
// LARSIL — ver comentário de RAIZ_NOSSA.
function raizDoc(d) {
    if (ehNossa(d.emitenteOcr)) return null;
    return raiz(d.cnpj);
}
function cnpjConhecido(l, d) { return !!(raiz(l.cnpj) && raizDoc(d)); }
function cnpjDiverge(l, d) {
    const a = raiz(l.cnpj), b = raizDoc(d);
    return !!(a && b && a !== b);
}

function distanciaDias(l, d) {
    if (d.data == null) return null;
    const alvos = [l.dtLancamento, l.dtEmissao].filter(x => x != null);
    if (!alvos.length) return null;
    return Math.min(...alvos.map(t => Math.abs(t - d.data) / DIA_MS));
}
function dentroDaJanela(l, d, janela) {
    const dist = distanciaDias(l, d);
    return dist == null || dist <= janela;
}

/**
 * Regra parametrizável.
 * @param {object} opt
 *   janelaDias   — veto de data no caminho fraco (default 15, como produção)
 *   vetoCnpj     — rejeita par cujo CNPJ (raiz) diverge
 *   viaCnpj      — aceita (CNPJ E valor) como caminho novo de casamento
 */
function fazerCasa(opt) {
    const janela = opt.janelaDias == null ? par.JANELA_DIAS : opt.janelaDias;
    return function casa(l, d) {
        if (opt.vetoCnpj && cnpjDiverge(l, d)) return null;
        if (numeroBate(l, d) && entidadeBate(l, d))
            return valorBate(l, d) ? 'numero+entidade+valor' : 'numero+entidade';
        if (opt.viaCnpj && cnpjConhecido(l, d) && !cnpjDiverge(l, d)) {
            if (numeroBate(l, d)) return 'numero+cnpj';
            if (valorBate(l, d) && dentroDaJanela(l, d, janela)) return 'valor+cnpj';
        }
        if (valorBate(l, d) && dentroDaJanela(l, d, janela))
            return entidadeBate(l, d) ? 'valor+entidade' : 'valor';
        return null;
    };
}

const forcaDoPar = (l, d) =>
    (valorBate(l, d) ? 1 : 0) + (numeroBate(l, d) ? 1 : 0) + (entidadeBate(l, d) ? 1 : 0)
    + ((!cnpjDiverge(l, d) && cnpjConhecido(l, d)) ? 1 : 0);

function parear(lancamentos, documentos, casa) {
    const candidatos = [];
    for (let i = 0; i < lancamentos.length; i++)
        for (let j = 0; j < documentos.length; j++) {
            const via = casa(lancamentos[i], documentos[j]);
            if (via) candidatos.push({ i, j, via, forca: forcaDoPar(lancamentos[i], documentos[j]) });
        }
    candidatos.sort((a, b) => {
        if (b.forca !== a.forca) return b.forca - a.forca;
        const da = distanciaDias(lancamentos[a.i], documentos[a.j]);
        const db = distanciaDias(lancamentos[b.i], documentos[b.j]);
        const na = da == null ? Infinity : da, nb = db == null ? Infinity : db;
        if (na !== nb) return na - nb;
        const la = lancamentos[a.i], lb = lancamentos[b.i];
        if (la !== lb) {
            const ka = `${la.nf}|${la.entidade}`, kb = `${lb.nf}|${lb.entidade}`;
            if (ka !== kb) return ka < kb ? -1 : 1;
        }
        const fa = documentos[a.j].arquivo, fb = documentos[b.j].arquivo;
        return fa === fb ? 0 : (fa < fb ? -1 : 1);
    });
    const lu = new Array(lancamentos.length).fill(false);
    const du = new Array(documentos.length).fill(false);
    const pares = [];
    for (const c of candidatos) {
        if (lu[c.i] || du[c.j]) continue;
        lu[c.i] = true; du[c.j] = true;
        pares.push({
            lancamento: lancamentos[c.i], documento: documentos[c.j],
            via: c.via, forca: c.forca,
            distanciaDias: distanciaDias(lancamentos[c.i], documentos[c.j]),
        });
    }
    return {
        pares,
        fracos: pares.filter(p => p.forca === 1).length,
        lancamentosSemDocumento: lu.reduce((n, u) => n + (u ? 0 : 1), 0),
        documentosSemLancamento: du.reduce((n, u) => n + (u ? 0 : 1), 0),
    };
}

function conferirPeriodo(lancamentos, documentosPorMes, periodo, casa, vizinhanca) {
    const noMes = parear(lancamentos, documentosPorMes[periodo] || [], casa);
    const casados = new Set(noMes.pares.map(p => p.lancamento));
    const pendentes = lancamentos.filter(l => !casados.has(l));
    const docsViz = [];
    for (const off of vizinhanca) {
        const alvo = par.deslocarPeriodo(periodo, off);
        for (const d of (documentosPorMes[alvo] || []))
            docsViz.push({ ...d, periodoDocumento: alvo });
    }
    const rv = parear(pendentes, docsViz, casa);
    const casadosViz = new Set(rv.pares.map(p => p.lancamento));
    return {
        pares: noMes.pares,
        paresVizinhos: rv.pares,
        fracos: noMes.fracos + rv.fracos,
        lancamentosSemDocumento: pendentes.filter(l => !casadosViz.has(l)).length,
        documentosSemLancamento: noMes.documentosSemLancamento,
    };
}

// ── Execução de uma variante sobre os 6 períodos ─────────────────────────────
function rodar(c, idxOcr, opt) {
    // Piso de dígitos do número, parametrizável para medir (default = produção).
    numeroBate = fazNumeroBate(opt.minDigitosNum == null ? MIN_DIGITOS_NUM : opt.minDigitosNum);
    const casa = fazerCasa(opt);
    const vizinhanca = opt.vizinhanca || par.VIZINHANCA;
    const usarOcr = !!opt.ocr;
    const linhas = [];

    for (const periodo of h.PERIODOS) {
        const pl = c.planilha[periodo] || { itens: [] };
        const lancamentos = (pl.itens || []).map(l => {
            const o = par.lancamentoDaPlanilha(l);
            o.cnpj = ocr.soDigitos(l.cnpj || '');
            return o;
        });
        const documentosPorMes = {};
        for (const off of [0, ...vizinhanca]) {
            const alvo = par.deslocarPeriodo(periodo, off);
            documentosPorMes[alvo] = (c.pasta.arquivosPorMes[alvo] || []).map(a => {
                const d = par.documentoDoArquivo(a.nome, a.rel);
                return usarOcr ? enriquecer(d, idxOcr[a.nome]) : d;
            });
        }
        const r = conferirPeriodo(lancamentos, documentosPorMes, periodo, casa, vizinhanca);
        const todos = [...r.pares, ...r.paresVizinhos];
        linhas.push({
            periodo,
            lancamentos: lancamentos.length,
            conferidos: todos.length,
            noMes: r.pares.length,
            vizinhos: r.paresVizinhos.length,
            semDocumento: r.lancamentosSemDocumento,
            docsSemLancamento: r.documentosSemLancamento,
            fracos: r.fracos,
            porVia: todos.reduce((a, p) => { a[p.via] = (a[p.via] || 0) + 1; return a; }, {}),
            pares: todos,
        });
    }
    return linhas;
}

function resumir(linhas) {
    const s = linhas.reduce((a, l) => {
        a.lancamentos += l.lancamentos; a.conferidos += l.conferidos;
        a.semDocumento += l.semDocumento; a.fracos += l.fracos;
        a.docsSemLancamento += l.docsSemLancamento;
        for (const [k, n] of Object.entries(l.porVia)) a.porVia[k] = (a.porVia[k] || 0) + n;
        return a;
    }, { lancamentos: 0, conferidos: 0, semDocumento: 0, fracos: 0, docsSemLancamento: 0, porVia: {} });
    s.cobertura = s.conferidos / s.lancamentos;
    return s;
}

/**
 * Qualidade dos pares: de quantos dá para dizer que estão CERTOS por um campo
 * que não foi o usado para casar. É a métrica que impede "cobertura" de subir
 * às custas de par errado.
 */
function qualidade(linhas) {
    let n = 0, confirmados = 0, contraditos = 0;
    for (const l of linhas) for (const p of l.pares) {
        n++;
        const L = p.lancamento, D = p.documento;
        const sinais = (valorBate(L, D) ? 1 : 0) + (numeroBate(L, D) ? 1 : 0) + (entidadeBate(L, D) ? 1 : 0);
        if (sinais >= 2) confirmados++;
        if (cnpjDiverge(L, D)) contraditos++;
    }
    return { n, confirmados, contraditos,
             pcConfirmado: confirmados / n, pcContradito: contraditos / n };
}

module.exports = { rodar, resumir, qualidade, enriquecer, fazerCasa, cnpjDiverge, cnpjConhecido };
