/**
 * _medir/_julgar-campos.js — a RÉGUA, num só lugar.
 *
 * Os julgadores de campo saíram de `_multicampo-texto-vs-imagem.js` para cá quando
 * o segundo script precisou deles. O motivo é [[gabarito-frouxo-inventa-erro]]: a
 * régua teve DOIS defeitos que inflaram o erro da produção de 4 para 11, e um deles
 * chegou a INVERTER um resultado. Se cada script tiver sua cópia, o próximo conserto
 * vale só para um deles e as medições deixam de ser comparáveis.
 *
 * Regra: nenhum script de medição define julgamento de campo por conta própria.
 */
'use strict';
const parsers = require('../routes/_nf-parsers');
const pare = require('../routes/_pareamento');

const CAMPOS = ['valor', 'numero', 'data', 'emitente'];
const MARCA = { ok: '✓', erro: '✗', parcela: '~', vazio: '·', 's/gab': ' ' };

// ── Gabaritos ────────────────────────────────────────────────────────────────
// Vêm das funções DE PRODUÇÃO: se a régua divergir do que o sistema usa para
// casar, a medição responde outra pergunta.

// `extrairEmitente` é feita para NOMEAR, não para CONFERIR: sem emitente no nome
// ela devolve o resto ("72 - ISS RETIDO", "R$ 166.960,86 - ... - GIRO CAIXA"). Usar
// isso como gabarito reprova quem lê CERTO e premia quem casa com o lixo — foi o
// que fez a via de texto marcar 'ok' por bater com o token CAIXA do próprio ruído.
const RE_LIXO = /R\$|\d{3,}|\b\d+\s*-|\bISS\b|\bRETID|\bSISPAG\b|\bPIX\b|\bATACADO\b|\bGIRO\b|\bPGTO\b|\bPAGTO\b|\bAPOLICE\b|\bVENC\b|\bDEB\b|\bCRED\b|\bPARC\b|\bFINANC/i;
const RE_ROTULO = /^(GRUPO|COTA|DOC|BOL|AUT|NOTA|FISCAL|RECIBO|FATURA|PARCELA|CONTRATO|DEB|AUTOMATICO|EMPRESA|EMPRESAS)$/;

const semAcento = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');

function gabEmitente(nome) {
    const cru = String(parsers.extrairEmitente(nome) || '').trim();
    if (!cru || RE_LIXO.test(cru)) return '';
    const bons = semAcento(cru).toUpperCase().replace(/[^A-Z ]/g, ' ')
        .split(/\s+/).filter(t => t.length >= 4 && !RE_ROTULO.test(t));
    return bons.length ? cru : '';
}

const gabaritos = nome => ({
    valor:    pare.valorDoNome(nome),
    numero:   pare.numeroDoNome(nome),
    data:     pare.dataDoNome(nome),
    emitente: gabEmitente(nome),
});

const temGab = (g, c) => g[c] != null && g[c] !== '';

// ── Normalização de número brasileiro ────────────────────────────────────────
// A forma é decidida pelo ÚLTIMO separador, senão "17.904,40" vira 17,90.
const num = v => {
    if (v == null) return null;
    if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : null;
    let s = String(v).replace(/[^\d.,-]/g, '').trim();
    if (!s) return null;
    const uv = s.lastIndexOf(','), up = s.lastIndexOf('.');
    if (uv > up) s = s.replace(/\./g, '').replace(',', '.');
    else if (up > uv) {
        s = s.replace(/,/g, '');
        const p = s.split('.');
        if (p.length > 2 || (p.length === 2 && p[1].length === 3)) s = p.join('');
    }
    const n = Number(s);
    return Number.isFinite(n) && n > 0 ? n : null;
};

// Os dois prompts usam schemas diferentes (`cnpj`/`numeroDocumento` no de texto,
// `cnpjEmitente`/`numero` no de visão). Normalizar aqui evita comparar campo vazio
// por ter lido a chave errada.
const normaliza = d => ({
    emitente: d.emitente,
    numero:   d.numeroDocumento ?? d.numero,
    data:     d.dataEmissao,
    valor:    num(d.valorTotal) ?? num(d.valorLiquido),
    tipo:     d.tipo,
    origem:   d.ondeAcheiOValor,
});

// ── Os julgadores ────────────────────────────────────────────────────────────
// Cada um devolve 'ok' | 'erro' | 'parcela' | 'vazio' | 's/gab'.

function jValor(lido, gab) {
    if (gab == null) return 's/gab';
    if (lido == null) return 'vazio';
    if (Math.abs(lido - gab) <= 0.02) return 'ok';
    // 'parcela' NÃO é acerto: é o total da nota onde o nome traz o pago. Coluna
    // própria porque era exatamente aqui que o índice antigo cegava.
    const r = lido / gab, n = Math.round(r);
    if (n >= 2 && n <= 60 && Math.abs(r - n) < 0.02) return 'parcela';
    return 'erro';
}

function jNumero(lido, gab) {
    if (!gab) return 's/gab';
    const d = String(lido ?? '').replace(/\D/g, '').replace(/^0+/, '');
    if (!d) return 'vazio';
    const g = String(gab).replace(/\D/g, '').replace(/^0+/, '');
    // `includes` nos dois sentidos: num pacote o nome traz o nº da fatura e a IA
    // pode devolver o da NF anexa, com mais dígitos — é o mesmo documento.
    return (d === g || d.includes(g) || g.includes(d)) ? 'ok' : 'erro';
}

// 60 dias, e o número NÃO é arbitrário: é o `DIAS_DISCORDANCIA_GROSSA` que
// `_pareamento.js` mediu sobre 4.238 documentos. Das 794 discordâncias nome ×
// pasta, 697 são de 0-30 dias e LEGÍTIMAS (data do papel × dia do pagamento);
// erro real só acima de 60, e sempre com o ano trocado. Minha 1ª régua usou 3
// dias e acusou 5 erros que não existiam.
const TOLERANCIA_DATA_MS = 60 * 86400000;
function jData(lido, gabMs) {
    if (gabMs == null) return 's/gab';
    const s = String(lido || '').trim();
    if (!/^\d{2}\/\d{2}\/\d{4}$/.test(s)) return 'vazio';
    const [d, m, a] = s.split('/').map(Number);
    const t = Date.UTC(a, m - 1, d);
    if (!Number.isFinite(t)) return 'vazio';
    return Math.abs(t - gabMs) <= TOLERANCIA_DATA_MS ? 'ok' : 'erro';
}

// Emitente por TOKEN, não por string: o nome traz a forma curta ("SAVANA") e o
// documento a razão social ("SAVANA COMERCIO DE PECAS LTDA"). Igualdade exata
// reprovaria acerto bom.
const STOP = new Set(['LTDA', 'EIRELI', 'SOCIEDADE', 'COMERCIO', 'INDUSTRIA', 'SERVICOS',
    'SERVICO', 'EMPRESA', 'DISTRIBUIDORA', 'TRANSPORTES', 'MATERIAIS', 'PRODUTOS',
    'BRASIL', 'FILIAL', 'MATRIZ', 'PARTICIPACOES', 'EMPREENDIMENTOS', 'ASSOCIACAO']);
const toks = s => semAcento(s).toUpperCase().replace(/[^A-Z0-9 ]/g, ' ')
    .split(/\s+/).filter(t => t.length >= 4 && !STOP.has(t));

function jEmitente(lido, gab) {
    const g = toks(gab);
    if (!g.length) return 's/gab';
    const l = toks(lido);
    if (!l.length) return 'vazio';
    return l.some(t => g.includes(t)) || g.some(t => l.includes(t)) ? 'ok' : 'erro';
}

const julgar = (lido, g) => ({
    valor:    jValor(lido.valor, g.valor),
    numero:   jNumero(lido.numero, g.numero),
    data:     jData(lido.data, g.data),
    emitente: jEmitente(lido.emitente, g.emitente),
});

// ── Classificação de dificuldade (para amostra dirigida) ─────────────────────
const RE_MULTI = /\+\s*(BOL|AUT|UT|DANFE|NF|NFS|CTE|COMPROV)/i;
function dificuldade(nome, texto, temTexto) {
    if (!temTexto) return 'imagem';
    if (pare.valorDoNome(nome) == null) return 'semvalor';
    if (RE_MULTI.test(nome)) return 'multi';
    // Muitos valores com centavos = extrato/evolução/carnê/contrato, o padrão em
    // que todas as vias de imagem erraram.
    const n = (String(texto).match(/\d{1,3}(?:\.\d{3})*,\d{2}/g) || []).length;
    if (n >= 25) return 'poluida';
    return 'normal';
}

// Assinatura de layout, para não encher a amostra com o mesmo fornecedor: a 1ª
// rodada trouxe 20 de 24 do mesmo consórcio e teria dado veredito por um layout só.
function assinatura(nome) {
    const s = String(nome).replace(/\.pdf$/i, '');
    if (/Grupo\s+\d+/i.test(s)) return 'consorcio-rodobens';
    const e = gabEmitente(s);
    return e ? 'emit:' + e.slice(0, 14) : 'outro:' + s.slice(0, 8);
}

module.exports = {
    CAMPOS, MARCA, gabaritos, temGab, gabEmitente, num, normaliza,
    jValor, jNumero, jData, jEmitente, julgar,
    dificuldade, assinatura, TOLERANCIA_DATA_MS,
};
