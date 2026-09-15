/**
 * _medir/onde-esta-o-pdf.js — lê a planilha, casa com os PDFs da pasta e diz,
 * para cada lançamento: ONDE o documento está e ONDE deveria estar.
 *
 * ── O que "onde deveria estar" quer dizer (medido antes de escrever a saída) ──
 *
 * A primeira versão marcava como "DESLOCADO" todo par casado em pasta vizinha,
 * usando o mês do LANÇAMENTO como lugar devido. Em 03.2026 isso acusava 186
 * documentos fora do lugar — e a acusação era falsa. `_medir/_por-que-deslocado.js`
 * comparou a data do NOME do arquivo com a pasta em que ele está:
 *
 *   nome e pasta CONCORDAM entre si   181   97,3%   documento bem arquivado
 *   nome cai no mês do lançamento       2    1,1%   arquivado na pasta seguinte
 *   sem data no nome                    3    1,6%
 *
 * Ou seja: o papel está no lugar certo pela data DELE; quem cai noutro mês é o
 * lançamento (nota de abril paga em março, e vice-versa) — o padrão que
 * `VIZINHANCA` existe para cobrir. Por isso a saída distingue os dois casos em vez
 * de chamar tudo de deslocado: só o segundo grupo é candidato a erro de arquivo.
 *
 * Quatro situações; as duas primeiras não exigem ação:
 *
 *   OK           documento na pasta do próprio mês do lançamento
 *   OUTRO MÊS    documento em pasta de outro mês, mas COERENTE com a data do nome
 *                — competência ≠ pagamento; é o normal, não erro
 *   FORA DO LUGAR data do nome diz um mês, a pasta é outra — vale conferir
 *   AUSENTE      nenhum documento casou — o papel não foi encontrado
 *
 * Uso: node _medir/onde-esta-o-pdf.js [MM.AAAA] [--csv arquivo.csv]
 *      sem período, roda todos os meses que a planilha tiver.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const h = require('./harness');
const ocr = require('./ocr');

const P = require('../routes/_pareamento');

const args = process.argv.slice(2);
const iCsv = args.indexOf('--csv');
const saidaCsv = iCsv >= 0 ? args[iCsv + 1] : null;
const periodoArg = args.find(a => /^\d{2}\.\d{4}$/.test(a)) || null;

// "03.2026" → "2026.03", que é como as pastas do arquivo permanente se chamam.
const pastaDoPeriodo = p => {
    const [m, a] = String(p).split('.');
    return `${a}.${m}`;
};

// "AAAA.MM" da data embutida no NOME do arquivo — é a data do DOCUMENTO, e é ela
// que diz em que pasta o papel deveria estar.
function mesNoNome(nome) {
    const n = String(nome || '');
    let m = n.match(/(?<!\d)(20\d{2})\.(\d{2})\.(\d{2})(?!\d)/);
    if (m) return `${m[1]}.${m[2]}`;
    m = n.match(/(?<!\d)(\d{2})\.(\d{2})\.(20\d{2})(?!\d)/);
    if (m) return `${m[3]}.${m[2]}`;
    return null;
}

// A data do nome está MALFORMADA? Rodando 03.2026, dos 9 casos "fora do lugar" a
// maioria era erro de digitação, não papel no lugar errado:
//   "2026.04.414"  dia inválido      "226.04.22"  ano de 3 dígitos
//   "2026.04.1"    dia incompleto
// A ação é oposta — aqui se corrige o NOME, não se move o arquivo —, então os dois
// casos precisam aparecer separados.
// Devolve o trecho malformado, ou '' — os três casos acima retornam null em
// `mesNoNome`, e sem esta checagem o relatório exibia o mês do LANÇAMENTO no campo
// "deveria estar", como se fosse a data lida do nome. Enganoso: mandaria mover um
// arquivo cuja pasta está certa.
function trechoDataMalformada(nome) {
    const n = String(nome || '');
    if (mesNoNome(n)) return '';                     // data bem formada
    const m = n.match(/(?<!\d)(\d{1,4}\.\d{1,2}\.\d{1,4})(?!\d)/);
    return m ? m[1] : '';
}

// "AAAA.MM" da subpasta em que o arquivo está (…/2026.04.01/…)
function mesNaPasta(rel) {
    const s = String(rel || '').replace(/\\/g, '/');
    let m = s.match(/(?:^|\/)(20\d{2})\.(\d{2})\.(\d{2})(?:\/|$)/);
    if (m) return `${m[1]}.${m[2]}`;
    m = s.match(/(?:^|\/)(\d{2})\.(\d{2})\.(20\d{2})(?:\/|$)/);
    if (m) return `${m[3]}.${m[2]}`;
    return null;
}

const fmtBR = v => (v == null ? '' : Number(v).toFixed(2).replace('.', ','));

(async () => {
    const c = h.carregar();
    const idx = await ocr.indexar();

    const periodos = periodoArg ? [periodoArg]
        : Object.keys(c.planilha).filter(p => /^\d{2}\.\d{4}$/.test(p)).sort();

    const linhas = [];
    const resumo = { ok: 0, outroMes: 0, foraDoLugar: 0, nomeInvalido: 0, ausente: 0 };
    const porDeslocamento = new Map();

    for (const periodo of periodos) {
        const itens = (c.planilha[periodo] || {}).itens || [];
        if (!itens.length) continue;

        const lancamentos = itens.map(P.lancamentoDaPlanilha).filter(Boolean);

        // documentos por mês, enriquecidos com o que o extrator gravou (sem isso o
        // documento fica sem data e o veto de janela some — ver memória do projeto)
        const documentosPorMes = {};
        for (const [mes, arquivos] of Object.entries(c.pasta.arquivosPorMes || {})) {
            documentosPorMes[mes] = arquivos.map(a => {
                const doc = P.documentoDoArquivo(a.nome, a.rel);
                // O índice do OCR é chaveado pelo NOME do arquivo (ver _medir/ocr.js).
                // Sem este enriquecimento o documento fica sem data e o veto de janela
                // some — armadilha já registrada na memória do projeto.
                const o = idx ? idx[a.nome] : null;
                return o ? P.enriquecerComOcr(doc, o) : doc;
            });
        }

        const r = P.conferirPeriodo(lancamentos, documentosPorMes, periodo);
        const esperada = pastaDoPeriodo(periodo);

        for (const par of r.pares) {
            // Mesmo no mês certo o papel pode estar na subpasta errada: o nome diz
            // um mês e a pasta é outra. Como o mês da pasta coincide com o do
            // lançamento aqui, essa divergência é do nome — vale sinalizar.
            const mn = mesNoNome(par.documento.arquivo);
            const mp = mesNaPasta(par.documento.caminho);
            const ruim = trechoDataMalformada(par.documento.arquivo);

            let situacao, ondeDeveria;
            if (ruim) { situacao = 'DATA DO NOME INVALIDA'; ondeDeveria = mp || esperada; resumo.nomeInvalido++; }
            else if (mn && mp && mn !== mp) { situacao = 'FORA DO LUGAR'; ondeDeveria = mn; resumo.foraDoLugar++; }
            else { situacao = 'OK'; ondeDeveria = mn || esperada; resumo.ok++; }

            linhas.push({
                periodo, situacao,
                lancamento: descreve(par.lancamento),
                valor: par.lancamento.valor,
                arquivo: par.documento.arquivo,
                ondeEsta: par.documento.caminho,
                ondeDeveria,
                dataRuim: ruim,
                mesDoLancamento: esperada,
                distancia: 0,
                forca: par.forca,
            });
        }

        for (const par of r.paresVizinhos) {
            const off = par.deslocamento;
            porDeslocamento.set(off, (porDeslocamento.get(off) || 0) + 1);

            // O lugar devido do PAPEL é a pasta da data do próprio documento, não a
            // do lançamento: 97,3% dos casos vizinhos têm nome e pasta coerentes, e
            // é o lançamento que cai noutro mês (competência ≠ pagamento).
            const mn = mesNoNome(par.documento.arquivo);
            const mp = mesNaPasta(par.documento.caminho);
            const ruim = trechoDataMalformada(par.documento.arquivo);

            let situacao, ondeDeveria;
            if (ruim) {
                // O nome é que está errado; a pasta pode muito bem estar certa.
                situacao = 'DATA DO NOME INVALIDA';
                ondeDeveria = mp || esperada;
                resumo.nomeInvalido++;
            } else if (mn && mp && mn === mp) {
                situacao = 'OUTRO MES';                 // competência ≠ pagamento
                ondeDeveria = mn;
                resumo.outroMes++;
            } else {
                situacao = 'FORA DO LUGAR';
                ondeDeveria = mn || esperada;
                resumo.foraDoLugar++;
            }

            linhas.push({
                periodo, situacao,
                lancamento: descreve(par.lancamento),
                valor: par.lancamento.valor,
                arquivo: par.documento.arquivo,
                ondeEsta: par.documento.caminho,
                ondeDeveria,
                dataRuim: ruim,
                mesDoLancamento: esperada,
                distancia: off,
                forca: par.forca,
            });
        }

        for (const l of r.semDocumento) {
            resumo.ausente++;
            linhas.push({
                periodo, situacao: 'AUSENTE',
                lancamento: descreve(l),
                valor: l.valor,
                arquivo: '',
                ondeEsta: '',
                ondeDeveria: esperada,
                distancia: '',
                forca: '',
            });
        }
    }

    // ── Relatório ────────────────────────────────────────────────────────────
    const total = resumo.ok + resumo.outroMes + resumo.foraDoLugar + resumo.nomeInvalido + resumo.ausente;
    const pct = n => (total ? `${(100 * n / total).toFixed(1)}%` : '—');

    console.log(`\nperíodos: ${periodos.join(', ')}`);
    console.log(`${total} lançamentos analisados\n`);
    console.log('situação          lanç.            o que significa');
    console.log(`  OK            ${String(resumo.ok).padStart(5)}  ${pct(resumo.ok).padStart(6)}   documento na pasta do mês do lançamento`);
    console.log(`  OUTRO MÊS     ${String(resumo.outroMes).padStart(5)}  ${pct(resumo.outroMes).padStart(6)}   em outra pasta, mas coerente com a data do nome`);
    console.log(`                                     (competência ≠ pagamento — normal, sem ação)`);
    console.log(`  FORA DO LUGAR ${String(resumo.foraDoLugar).padStart(5)}  ${pct(resumo.foraDoLugar).padStart(6)}   a data do nome não bate com a pasta ← MOVER`);
    console.log(`  DATA INVÁLIDA ${String(resumo.nomeInvalido).padStart(5)}  ${pct(resumo.nomeInvalido).padStart(6)}   erro de digitação no nome ← RENOMEAR`);
    console.log(`  AUSENTE       ${String(resumo.ausente).padStart(5)}  ${pct(resumo.ausente).padStart(6)}   nenhum documento encontrado`);

    if (porDeslocamento.size) {
        console.log('\n── distância entre a pasta do documento e o mês do lançamento ──');
        for (const [off, n] of [...porDeslocamento.entries()].sort((a, b) => a[0] - b[0])) {
            const rot = off < 0 ? `${off} (pasta anterior)` : `+${off} (pasta posterior)`;
            console.log(`  ${rot.padEnd(24)} ${String(n).padStart(4)}`);
        }
    }

    const fora = linhas.filter(l => l.situacao === 'FORA DO LUGAR');
    console.log(`\n══ MOVER: ${fora.length} documento(s) em pasta que não bate com a data do nome ══`);
    for (const l of fora.slice(0, 20)) {
        console.log(`\n  ${l.arquivo.slice(0, 72)}`);
        console.log(`     está em  : ${l.ondeEsta}`);
        console.log(`     deveria  : pasta ${l.ondeDeveria}  (data no próprio nome do arquivo)`);
        console.log(`     lançado  : ${l.mesDoLancamento}  ·  R$ ${fmtBR(l.valor)}  ·  ${l.lancamento}`);
    }
    if (fora.length > 20) console.log(`\n  … +${fora.length - 20} (veja o CSV com --csv)`);
    if (!fora.length) console.log('  nenhum — todo documento encontrado está na pasta coerente com sua data');

    const ruins = linhas.filter(l => l.situacao === 'DATA DO NOME INVALIDA');
    if (ruins.length) {
        console.log(`\n══ RENOMEAR: ${ruins.length} nome(s) com data malformada ══`);
        console.log('   (a pasta indica a data certa; o nome é que está errado)\n');
        for (const l of ruins.slice(0, 20)) {
            console.log(`  "${l.dataRuim}"  em  ${l.arquivo.slice(0, 62)}`);
            console.log(`      pasta: ${l.ondeDeveria}  ·  R$ ${fmtBR(l.valor)}  ·  ${l.lancamento}`);
        }
        if (ruins.length > 20) console.log(`\n  … +${ruins.length - 20} (veja o CSV)`);
    }

    if (saidaCsv) {
        const cab = 'periodo;situacao;lancamento;valor;arquivo;onde_esta;onde_deveria;mes_do_lancamento;data_invalida;distancia_meses;forca';
        const esc = s => { const t = String(s ?? ''); return /[;"\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
        const corpo = linhas.map(l => [l.periodo, l.situacao, l.lancamento, fmtBR(l.valor),
            l.arquivo, l.ondeEsta, l.ondeDeveria, l.mesDoLancamento, l.dataRuim, l.distancia, l.forca].map(esc).join(';'));
        fs.writeFileSync(saidaCsv, '﻿' + [cab, ...corpo].join('\r\n'), 'utf8');
        console.log(`\nCSV: ${saidaCsv}  (${linhas.length} linhas)`);
    }
})();

// Um rótulo curto para identificar o lançamento na saída.
function descreve(l) {
    const partes = [];
    if (l.numero) partes.push(`nº ${l.numero}`);
    const tk = [...(l.tokens || [])].slice(0, 3).join(' ');
    if (tk) partes.push(tk);
    return partes.join(' · ') || '(sem identificação)';
}
