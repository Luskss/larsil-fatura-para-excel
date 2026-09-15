/**
 * _medir/_multicampo-texto-vs-imagem.js — o índice que enxerga.
 *
 * ── Por que este script existe ───────────────────────────────────────────────
 * `_visao-em-pdf-texto.js` mediu texto × imagem e deu 0 DIVERGE para a produção em
 * 24 documentos. Esse 0 é CEGUEIRA, não perfeição, por três furos:
 *
 *   1. `conferirValor` aceita QUALQUER múltiplo inteiro de 2 a 60 como 'parcela'.
 *      No IRMAOS SILVA o texto leu 11.960 (= 3 × 3.986,66) e passou como legítimo,
 *      enquanto a imagem leu o valor certo — o índice deu EMPATE onde havia um
 *      acerto e um erro.
 *   2. Só o VALOR era conferido. Emitente, número e data — os campos de que o
 *      pareamento vive — não tinham gabarito nenhum. A imagem preencheu 169 campos
 *      contra 119 do texto e o índice não sabia dizer se eram ganho ou lixo.
 *   3. A amostra era por passo fixo: documentos quaisquer, quase todos fáceis.
 *
 * Este script conserta os três (melhoria A + B da conversa de 11/09/2026):
 *
 *   A. CONFERE 4 CAMPOS contra o nome do arquivo, cada um com seu gabarito:
 *        valor    → `valorDoNome`     (com 'parcela' marcada SEPARADAMENTE, não
 *                                      contada como acerto — é o furo nº 1)
 *        número   → `numeroDoNome`    ("NFS 37228", "FT77721", "RC 902512")
 *        data     → `dataDoNome`      (tolerância de 3 dias: emissão × arquivamento)
 *        emitente → `extrairEmitente` (casamento por tokens, não string exata)
 *
 *   B. AMOSTRA DIRIGIDA aos casos difíceis, em vez de passo fixo. Um documento
 *      entra por ser DIFÍCIL, e o script diz por qual motivo:
 *        · multi   — pacote com vários documentos ("+ BOL", "+ AUT", "NF...+")
 *        · poluida — página com muitos números (extrato, consórcio, evolução)
 *        · semvalor— o nome NÃO tem valor (ficavam fora da medição anterior!)
 *        · imagem  — sem texto nativo (a via de texto não tem o que ler)
 *        · normal  — completa a amostra, para haver base de comparação
 *
 * ── Como ler o resultado ─────────────────────────────────────────────────────
 * O índice é `ERRO` por campo: leu um valor e ele CONTRADIZ o gabarito. Distinto de
 * `vazio` (não leu — lacuna visível) e de `s/gab` (o nome não tem o que conferir).
 * Erro é dano silencioso e é o que decide; vazio é só lacuna.
 *
 * `parcela` aparece como coluna PRÓPRIA: não é acerto nem erro, é a zona cinzenta
 * que o índice antigo escondia. Ver [[total-da-nota-nao-e-valor-lancado]].
 *
 * Uso: node _medir/_multicampo-texto-vs-imagem.js [quantos]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const h = require('./harness');
const { PDFParse } = require('pdf-parse');
const parsers = require('../routes/_nf-parsers');
const pare = require('../routes/_pareamento');
const visao = require('../routes/_nf-visao');
const { callOpenAI } = require('../routes/_helpers');

const RAIZ_ARQ = process.env.ARQUIVO_PATH || process.env.MONITOR_PATH;
const PASTA = '2026.03.EXTRATOS CONTABILIDADE';
const QUANTOS = parseInt(process.argv[2], 10) || 24;
const PRECO = { 'gpt-4o-mini': [0.15, 0.60], 'gpt-4.1-mini': [0.40, 1.60] };

// ── Gabaritos: as funções DA PRODUÇÃO, não cópias ────────────────────────────
// Usar as mesmas de `_pareamento.js`/`_nf-parsers.js` é de propósito: se o gabarito
// divergir do que o sistema usa para casar, a medição responde outra pergunta.
const gabValor    = pare.valorDoNome;
const gabNumero   = pare.numeroDoNome;
const gabData     = pare.dataDoNome;

// `extrairEmitente` é feita para NOMEAR, não para CONFERIR: quando o nome não tem
// emitente ela devolve o resto do nome como se fosse um. Medido ao montar este
// script: "004.DOC- R$ 26,67- Grupo 681- Cota -294.pdf" → "R$ 26,67- GRUPO 681-
// COTA -294". Usar isso como gabarito reprovaria a via que lesse "RODOBENS"
// CORRETAMENTE — erro de medição que inverteria o resultado.
//
// Então o gabarito de emitente só vale quando sobra algo que PARECE nome de
// empresa: ao menos um token alfabético de 4+ letras que não seja rótulo de
// documento nem número. Senão devolve '' e o campo conta como 's/gab'.
// MEDIDO ao auditar a 1\u00aa rodada: o filtro por "tem um token de 4+ letras" era
// frouxo e deixou passar tr\u00eas gabaritos que s\u00e3o LIXO, n\u00e3o emitente \u2014
//   "72 - ISS RETIDO"                              (RETIDO tem 6 letras)
//   "R$ 166.960,86 - 7615-0100 - ATACADO - GIRO CAIXA"  (ATACADO, CAIXA)
//   "03-24-SISPAG FORNECEDORES PIX QR"             (SISPAG, FORNECEDORES)
// e isso n\u00e3o s\u00f3 suja o \u00edndice: INVERTE resultados. No caso da CAIXA a via de
// texto marcou 'ok' por casar com o token CAIXA do pr\u00f3prio lixo \u2014 acerto
// acidental contra um gabarito que n\u00e3o existe.
//
// A trava agora \u00e9 por FORMA do nome inteiro, n\u00e3o por um token isolado. Rejeita o
// gabarito quando ele cont\u00e9m sinal de que \u00e9 descri\u00e7\u00e3o de opera\u00e7\u00e3o e n\u00e3o raz\u00e3o
// social: valor em reais, sequ\u00eancia de d\u00edgitos com h\u00edfen (conta/ag\u00eancia), ou
// termo de opera\u00e7\u00e3o banc\u00e1ria/tribut\u00e1ria.
const RE_LIXO = /R\$|\d{3,}|\b\d+\s*-|\bISS\b|\bRETID|\bSISPAG\b|\bPIX\b|\bATACADO\b|\bGIRO\b|\bPGTO\b|\bPAGTO\b|\bAPOLICE\b|\bVENC\b|\bDEB\b|\bCRED\b|\bPARC\b|\bFINANC/i;
const RE_ROTULO = /^(GRUPO|COTA|DOC|BOL|AUT|NOTA|FISCAL|RECIBO|FATURA|PARCELA|CONTRATO|DEB|AUTOMATICO|EMPRESA|EMPRESAS)$/;
function gabEmitente(nome) {
    const cru = String(parsers.extrairEmitente(nome) || '').trim();
    if (!cru || RE_LIXO.test(cru)) return '';
    const bons = cru
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toUpperCase().replace(/[^A-Z ]/g, ' ')
        .split(/\s+/).filter(t => t.length >= 4 && !RE_ROTULO.test(t));
    return bons.length ? cru : '';
}

function listar(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const q = path.join(dir, e.name);
        if (e.isDirectory()) listar(q, out);
        else if (/\.pdf$/i.test(e.name)) out.push(q);
    }
    return out;
}
const ehAnexo = n => /^\s*\d+\s*[.\-]\s*CPV\b/i.test(n) || /^0+\s*[.\-]/.test(n);

async function lerPdf(buf) {
    const pr = new PDFParse({ data: new Uint8Array(buf) });
    try { const r = await pr.getText(); return { texto: r.text || '', paginas: r.total || 0 }; }
    catch (e) { return { texto: '', paginas: 0 }; }
    finally { try { await pr.destroy(); } catch (_) {} }
}

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

// ── Os 4 veredictos por campo ────────────────────────────────────────────────
// Cada um devolve 'ok' | 'erro' | 'parcela' | 'vazio' | 's/gab'.

function jValor(lido, gab) {
    if (gab == null) return 's/gab';
    if (lido == null) return 'vazio';
    if (Math.abs(lido - gab) <= 0.02) return 'ok';
    // 'parcela' NÃO é acerto: é o total da nota onde o nome traz o pago. Fica em
    // coluna própria porque foi exatamente aqui que o índice antigo cegou.
    const r = lido / gab, n = Math.round(r);
    if (n >= 2 && n <= 60 && Math.abs(r - n) < 0.02) return 'parcela';
    return 'erro';
}

// Número: compara só os dígitos e ignora zeros à esquerda. O gabarito traz o
// número ROTULADO no nome ("NFS 37228"); a IA às vezes devolve com pontuação.
function jNumero(lido, gab) {
    if (!gab) return 's/gab';
    const d = String(lido ?? '').replace(/\D/g, '').replace(/^0+/, '');
    if (!d) return 'vazio';
    const g = String(gab).replace(/\D/g, '').replace(/^0+/, '');
    // `includes` nos dois sentidos: num pacote o nome traz o nº da fatura e a IA
    // pode devolver o da NF anexa com mais dígitos — ainda é o mesmo documento.
    return (d === g || d.includes(g) || g.includes(d)) ? 'ok' : 'erro';
}

// Data: tolerância de 60 dias, e o número NÃO é arbitrário — é o
// `DIAS_DISCORDANCIA_GROSSA` que `_pareamento.js` já mediu sobre os 4.238
// documentos de jan–jun/2026. Lá, das 794 discordâncias nome × pasta:
//
//   0-30 dias   697   diferença LEGÍTIMA (a data do papel × o dia do pagamento)
//   31-90 dias   20
//   91+ dias     77   ERRO DE DIGITAÇÃO, todos com o ANO trocado
//
// Minha 1ª versão usava 3 dias e marcou 5 "erros" de data na produção que são
// justamente a diferença legítima: em UNIDAS e SASCAR a IA leu a emissão da nota
// e o nome traz o dia do pagamento. Índice apertado demais não mede melhor —
// inventa erro onde o projeto já provou que não há. O que interessa pegar é erro
// de MÊS ou de ANO (o "02/03/2028" que a visão produziu em §15.12), e 60 dias
// pega isso sem acusar o prazo de boleto.
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

// Emitente: casamento por TOKEN, não por string. O nome do arquivo traz uma forma
// abreviada ("SAVANA", "IRMAOS SILVA") e o documento a razão social completa
// ("SAVANA COMERCIO DE PECAS LTDA"). Exigir igualdade exata reprovaria acerto bom.
// Basta UM token significativo (≥4 letras) em comum.
const STOP = new Set(['LTDA', 'EIRELI', 'SOCIEDADE', 'COMERCIO', 'INDUSTRIA', 'SERVICOS',
    'SERVICO', 'EMPRESA', 'DISTRIBUIDORA', 'TRANSPORTES', 'MATERIAIS', 'PRODUTOS',
    'BRASIL', 'FILIAL', 'MATRIZ', 'PARTICIPACOES', 'EMPREENDIMENTOS', 'ASSOCIACAO']);
const toks = s => String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toUpperCase().replace(/[^A-Z0-9 ]/g, ' ')
    .split(/\s+/).filter(t => t.length >= 4 && !STOP.has(t));

function jEmitente(lido, gab) {
    const g = toks(gab);
    if (!g.length) return 's/gab';
    const l = toks(lido);
    if (!l.length) return 'vazio';
    return l.some(t => g.includes(t)) || g.some(t => l.includes(t)) ? 'ok' : 'erro';
}

// ── Vias de leitura ──────────────────────────────────────────────────────────
function promptDe(arquivo, constante) {
    const src = fs.readFileSync(path.join(h.RAIZ, 'routes', arquivo), 'utf8');
    const m = src.match(new RegExp(`const ${constante}\\s*=\\s*\`([\\s\\S]*?)\`;`));
    if (!m) throw new Error(`não achei ${constante} em ${arquivo} — fonte mudou?`);
    return m[1];
}

async function viaTexto(prompt, texto, nome, paginas, modelo) {
    const key = String(process.env.OPENAI_API_KEY || '').trim();
    if (!key) return { erro: 'sem OPENAI_API_KEY' };
    let t = String(texto || '');
    if (!t.replace(/\s/g, '').length) return { erro: 'PDF sem texto nativo' };
    if (t.length > 14000) t = t.slice(0, 14000);
    const r = await callOpenAI(key, {
        model: modelo, response_format: { type: 'json_object' }, temperature: 0, max_tokens: 4000,
        messages: [{ role: 'system', content: prompt },
                   { role: 'user', content: `Arquivo: ${nome}\nPáginas: ${paginas}\n\nTexto do documento:\n----------\n${t}\n----------` }],
    });
    return respostaOpenai(r);
}

async function viaImagem(prompt, buf, modelo, maxPg) {
    const key = String(process.env.OPENAI_API_KEY || '').trim();
    if (!key) return { erro: 'sem OPENAI_API_KEY' };
    let imgs;
    try { imgs = await visao.paginasEmPng(buf, maxPg); }
    catch (e) { return { erro: `rasterização falhou: ${e.message}` }; }
    if (!imgs.length) return { erro: 'nenhuma página rasterizada' };
    const content = imgs.map(b64 => ({ type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } }));
    content.push({ type: 'text', text: 'Leia este documento e devolva o JSON.' });
    const r = await callOpenAI(key, {
        model: modelo, response_format: { type: 'json_object' }, temperature: 0, max_tokens: 1500,
        messages: [{ role: 'system', content: prompt }, { role: 'user', content }],
    });
    return respostaOpenai(r);
}

function respostaOpenai(r) {
    if (!r.ok || r.httpCode < 200 || r.httpCode >= 300) return { erro: `HTTP ${r.httpCode} ${r.error || ''}`.trim() };
    let body; try { body = JSON.parse(r.body); } catch (_) { return { erro: 'resposta não-JSON' }; }
    const txt = body?.choices?.[0]?.message?.content ?? '';
    let j = null;
    try { j = JSON.parse(txt); } catch (_) {
        const s = txt.indexOf('{'), e = txt.lastIndexOf('}');
        if (s >= 0 && e > s) { try { j = JSON.parse(txt.slice(s, e + 1)); } catch (_) {} }
    }
    return j ? { dados: j, uso: body.usage || {} } : { erro: 'JSON inválido', uso: body.usage || {} };
}

// Os dois schemas diferem: FULL_PROMPT (texto) usa `cnpj`/`numeroDocumento`;
// o de visão usa `cnpjEmitente`/`numero`. Normalizar aqui evita comparar campo
// vazio por ter lido a chave errada — o erro que já me morderam uma vez.
const normaliza = d => ({
    emitente: d.emitente,
    numero:   d.numeroDocumento ?? d.numero,
    data:     d.dataEmissao,
    valor:    num(d.valorTotal) ?? num(d.valorLiquido),
    tipo:     d.tipo,
    origem:   d.ondeAcheiOValor,
});

// ── Por que este documento é difícil ─────────────────────────────────────────
const RE_MULTI = /\+\s*(BOL|AUT|UT|DANFE|NF|NFS|CTE|COMPROV)/i;
function dificuldade(nome, texto, temTexto) {
    if (!temTexto) return 'imagem';
    if (gabValor(nome) == null) return 'semvalor';
    if (RE_MULTI.test(nome)) return 'multi';
    // Página poluída: muitos números com centavos é extrato/evolução/carnê, o
    // padrão em que TODAS as vias de imagem erraram (consórcio, CAIXA, Daycoval).
    const nNums = (String(texto).match(/\d{1,3}(?:\.\d{3})*,\d{2}/g) || []).length;
    if (nNums >= 25) return 'poluida';
    return 'normal';
}

const CAMPOS = ['valor', 'numero', 'data', 'emitente'];

(async () => {
    const promptTexto = promptDe('_nf-ai-full.js', 'FULL_PROMPT');
    const promptVisao = promptDe('_nf-visao.js', 'PROMPT');

    const VIAS = [
        ['texto-4o',  'texto', 'gpt-4o-mini',   0],   // a produção de hoje
        ['img-cru',   'img',   'gpt-4.1-mini',  2],   // envio direto da página
        ['img-todas', 'img',   'gpt-4.1-mini',  8],   // idem, todas as páginas
    ];

    // ── B: amostra DIRIGIDA, com cota por tipo de dificuldade ────────────────
    // Sem cota, o acervo devolveria quase só 'normal' e 'multi' e a medição
    // repetiria a cegueira anterior. A cota força os casos difíceis a aparecer.
    const COTA = { multi: 6, poluida: 5, semvalor: 5, imagem: 4, normal: 4 };
    const todos = listar(path.join(RAIZ_ARQ, PASTA)).filter(p => !ehAnexo(path.basename(p)));
    const passo = Math.max(1, Math.floor(todos.length / (QUANTOS * 20)));
    const ordem = [];
    for (let i = 0; i < todos.length; i += passo) ordem.push(todos[i]);
    for (const x of todos) if (!ordem.includes(x)) ordem.push(x);

    // Teto por layout, o conserto da amostra da rodada anterior (20 de 24 eram o
    // MESMO consórcio). 2 por assinatura: com cota de dificuldade, 2 já bastam.
    const assinatura = n => {
        const s = String(n).replace(/\.pdf$/i, '');
        if (/Grupo\s+\d+/i.test(s)) return 'consorcio-rodobens';
        const e = gabEmitente(s);
        return e ? 'emit:' + e.slice(0, 14) : 'outro:' + s.slice(0, 8);
    };

    const alvos = [];
    const porDif = {}, porLayout = {};
    console.error('[multicampo] montando amostra dirigida...');
    for (const abs of ordem) {
        if (alvos.length >= QUANTOS) break;
        const nome = path.basename(abs);
        const a = assinatura(nome);
        if ((porLayout[a] || 0) >= 2) continue;
        const buf = fs.readFileSync(abs);
        const { texto, paginas } = await lerPdf(buf);
        const temTexto = texto.replace(/\s/g, '').length >= 15;
        const dif = dificuldade(nome, texto, temTexto);
        if ((porDif[dif] || 0) >= (COTA[dif] || 0)) continue;
        porDif[dif] = (porDif[dif] || 0) + 1;
        porLayout[a] = (porLayout[a] || 0) + 1;
        alvos.push({
            buf, nome, texto, paginas, temTexto, dif,
            g: { valor: gabValor(nome), numero: gabNumero(nome),
                 data: gabData(nome), emitente: gabEmitente(nome) },
        });
    }

    console.log(`amostra DIRIGIDA: ${alvos.length} documentos`);
    console.log('por dificuldade: ' + Object.entries(porDif).map(([k, v]) => `${k}=${v}`).join('  '));
    const comGab = c => alvos.filter(a => a.g[c] != null && a.g[c] !== '').length;
    console.log('gabarito disponível: ' + CAMPOS.map(c => `${c}=${comGab(c)}`).join('  ') + '\n');

    // acc[via][campo] = { ok, erro, parcela, vazio, semGab }
    const acc = {}, uso = {};
    for (const [v] of VIAS) {
        acc[v] = {}; uso[v] = { tokIn: 0, tokOut: 0, falhas: 0 };
        for (const c of CAMPOS) acc[v][c] = { ok: 0, erro: 0, parcela: 0, vazio: 0, semGab: 0 };
    }
    const linhas = [];

    for (const a of alvos) {
        console.error(`  [${a.dif}] ${a.nome.slice(0, 46)}`);
        const reg = { nome: a.nome, dif: a.dif, g: a.g, r: {} };

        for (const [via, tipo, modelo, maxPg] of VIAS) {
            const r = tipo === 'texto'
                ? await viaTexto(promptTexto, a.texto, a.nome, a.paginas, modelo)
                : await viaImagem(promptVisao, a.buf, modelo, maxPg);
            if (r.uso) { uso[via].tokIn += r.uso.prompt_tokens || 0; uso[via].tokOut += r.uso.completion_tokens || 0; }
            if (r.erro) {
                uso[via].falhas++;
                // Falha de via conta como VAZIO em todo campo que tinha gabarito:
                // não leu nada, e isso é lacuna, não acerto. Ignorar inflaria a via
                // que falha muito (era o que escondia o "PDF sem texto" do 4o).
                for (const c of CAMPOS) {
                    const temG = a.g[c] != null && a.g[c] !== '';
                    acc[via][c][temG ? 'vazio' : 'semGab']++;
                }
                reg.r[via] = { erro: r.erro };
                continue;
            }
            const d = normaliza(r.dados);
            if (r.dados.legivel === false) {
                uso[via].falhas++;
                for (const c of CAMPOS) {
                    const temG = a.g[c] != null && a.g[c] !== '';
                    acc[via][c][temG ? 'vazio' : 'semGab']++;
                }
                reg.r[via] = { erro: 'IA marcou ilegível' };
                continue;
            }
            const j = {
                valor:    jValor(d.valor, a.g.valor),
                numero:   jNumero(d.numero, a.g.numero),
                data:     jData(d.data, a.g.data),
                emitente: jEmitente(d.emitente, a.g.emitente),
            };
            for (const c of CAMPOS) {
                const k = j[c] === 's/gab' ? 'semGab' : j[c];
                acc[via][c][k]++;
            }
            reg.r[via] = { j, lido: d };
        }
        linhas.push(reg);
    }

    // ── documento a documento: só o que tem ERRO em alguma via ───────────────
    const MARCA = { ok: '✓', erro: '✗', parcela: '~', vazio: '·', 's/gab': ' ' };
    console.log('┌─ documentos com ERRO em alguma via ────────────────────────');
    let nSujos = 0;
    for (const l of linhas) {
        const temErro = VIAS.some(([v]) => l.r[v] && l.r[v].j && CAMPOS.some(c => l.r[v].j[c] === 'erro'));
        if (!temErro) continue;
        nSujos++;
        console.log(`│ [${l.dif}] ${l.nome.slice(0, 52)}`);
        console.log(`│   gabarito: valor=${l.g.valor ?? '—'}  nº=${l.g.numero ?? '—'}  emit="${(l.g.emitente || '—').slice(0, 22)}"`);
        for (const [v] of VIAS) {
            const r = l.r[v];
            if (!r) continue;
            if (r.erro) { console.log(`│   ${v.padEnd(10)} ERRO: ${String(r.erro).slice(0, 40)}`); continue; }
            console.log(`│   ${v.padEnd(10)} ` + CAMPOS.map(c => `${c[0]}${MARCA[r.j[c]]}`).join(' ') +
                `   valor=${String(r.lido.valor ?? '—').padStart(10)}  nº=${String(r.lido.numero ?? '—').slice(0, 10).padEnd(10)}  "${String(r.lido.emitente || '—').slice(0, 18)}"`);
            for (const c of CAMPOS) if (r.j[c] === 'erro' && c === 'valor' && r.lido.origem)
                console.log(`│              leu valor de: "${String(r.lido.origem).slice(0, 44)}"`);
        }
    }
    if (!nSujos) console.log('│ (nenhum — todas as vias limparam a amostra)');
    console.log('└────────────────────────────────────────────────────────────\n');

    // ── o índice, campo por campo ───────────────────────────────────────────
    console.log(`ÍNDICE MULTICAMPO (n = ${alvos.length}, amostra dirigida)`);
    console.log('Legenda: ok=confere  ERRO=contradiz o nome  ~parc=múltiplo (zona cinzenta)  ·vazio=não leu\n');
    for (const c of CAMPOS) {
        console.log(`── ${c.toUpperCase()}`);
        console.log('   via          ok   ERRO   ~parc   ·vazio   s/gab');
        for (const [v] of VIAS) {
            const x = acc[v][c];
            console.log('   ' + v.padEnd(12) + String(x.ok).padStart(3) + String(x.erro).padStart(7) +
                String(x.parcela).padStart(8) + String(x.vazio).padStart(9) + String(x.semGab).padStart(8));
        }
    }

    console.log('\n── TOTAL de ERROS por via (o índice que decide) ─────────────');
    for (const [v, , modelo] of VIAS) {
        const errs = CAMPOS.map(c => acc[v][c].erro).reduce((s, n) => s + n, 0);
        const parc = CAMPOS.map(c => acc[v][c].parcela).reduce((s, n) => s + n, 0);
        const vaz  = CAMPOS.map(c => acc[v][c].vazio).reduce((s, n) => s + n, 0);
        const [ci, co] = PRECO[modelo];
        const custo = (((uso[v].tokIn / alvos.length) / 1e6) * ci + ((uso[v].tokOut / alvos.length) / 1e6) * co) * 1000;
        console.log(`${v.padEnd(12)} ERROS=${String(errs).padStart(3)}   parcela=${String(parc).padStart(2)}   vazios=${String(vaz).padStart(3)}   falhas=${String(uso[v].falhas).padStart(2)}   US$${custo.toFixed(2)}/1.000`);
    }

    // ── erros por tipo de dificuldade: ONDE cada via quebra ─────────────────
    console.log('\n── ERROS por tipo de dificuldade ────────────────────────────');
    const difs = [...new Set(alvos.map(a => a.dif))];
    console.log('via          ' + difs.map(d => d.padStart(9)).join(''));
    for (const [v] of VIAS) {
        const cels = difs.map(d => {
            const ls = linhas.filter(l => l.dif === d);
            const e = ls.reduce((s, l) => s + (l.r[v] && l.r[v].j ? CAMPOS.filter(c => l.r[v].j[c] === 'erro').length : 0), 0);
            return `${e}/${ls.length * CAMPOS.length}`.padStart(9);
        });
        console.log(v.padEnd(12) + cels.join(''));
    }

    // ── as duas metades, campo a campo, contra a produção ───────────────────
    console.log('\n── contra a PRODUÇÃO (texto-4o), campo a campo ──────────────');
    for (const [v] of VIAS.slice(1)) {
        let g = 0, p = 0;
        const det = [];
        for (const l of linhas) {
            const A = l.r['texto-4o'], B = l.r[v];
            if (!A || !B || !A.j || !B.j) continue;
            for (const c of CAMPOS) {
                const bomA = A.j[c] === 'ok', bomB = B.j[c] === 'ok';
                if (bomB && !bomA) { g++; det.push(`   + ${c} em ${l.nome.slice(0, 44)} (4o: ${A.j[c]})`); }
                if (bomA && !bomB) { p++; det.push(`   − ${c} em ${l.nome.slice(0, 44)} (${v}: ${B.j[c]})`); }
            }
        }
        console.log(`${v.padEnd(11)} GANHA ${String(g).padStart(2)}   PERDE ${String(p).padStart(2)}   líquido ${g - p > 0 ? '+' : ''}${g - p}`);
        for (const d of det) console.log(d);
    }

    console.log('\nERRO é o índice: valor lido que CONTRADIZ o nome do arquivo.');
    console.log('parcela fica de fora do acerto de propósito — era a cegueira do índice antigo.');
    process.exit(0);
})();
