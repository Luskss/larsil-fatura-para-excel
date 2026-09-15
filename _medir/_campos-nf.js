/**
 * _medir/_campos-nf.js — mede a extração dos 9 campos pedidos em 09/09/2026
 * (nome, nome social, CNPJ, chave, CFOP, itens, unidade, valor unitário, total)
 * sobre DANFEs reais do arquivo, ANTES de ligar o extrator no pipeline.
 *
 * Não há gabarito por campo, então cada campo é medido pelo que dá para verificar
 * sozinho:
 *   - chave  → validada por UF+modelo (determinística)
 *   - CNPJ   → confere com o CNPJ embutido na chave
 *   - total  → confere com a soma dos itens
 *   - itens  → conta e fração com unidade / com CFOP / com aritmética fechando
 *
 * Uso: node _medir/_campos-nf.js [quantosPDFs]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { PDFParse } = require('../node_modules/pdf-parse');
const { classify, cnpjDaChaveAcesso } = require('../routes/_nf-parsers');
const { extrairNotaFiscal } = require('../routes/_nf-itens');

const env = {};
for (const linha of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
    const m = linha.match(/^\s*([A-Z_]+)\s*=\s*"?(.*?)"?\s*$/);
    if (m) env[m[1]] = m[2];
}
const RAIZ = env.ARQUIVO_PATH || env.MONITOR_PATH;

function varrer(dir, saida, prof = 0) {
    if (prof > 4) return;
    let ent;
    try { ent = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ent) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) varrer(p, saida, prof + 1);
        else if (/\.pdf$/i.test(e.name)) saida.push(p);
    }
}

const pct = (n, d) => (d ? `${(100 * n / d).toFixed(1)}%` : '—');

(async () => {
    const limite = Number(process.argv[2] || 250);
    const todos = [];
    varrer(RAIZ, todos);
    console.log(`${todos.length} PDFs no arquivo; lendo até achar ${limite} DANFEs.\n`);

    const c = {
        danfes: 0, nome: 0, cnpj: 0, cnpjBateChave: 0, cnpjTinhaChave: 0,
        chave: 0, cfop: 0, comItens: 0, totalNota: 0, fecha: 0, temTotalEItens: 0,
        itens: 0, itensUnid: 0, itensCfop: 0, itensAlta: 0, itensDesc: 0,
    };
    const exemplos = [];

    for (const p of todos) {
        if (c.danfes >= limite) break;
        let text = '';
        try {
            text = (await new PDFParse({ data: fs.readFileSync(p) }).getText()).text || '';
        } catch (_) { continue; }
        if (classify(text, path.basename(p)).tipo !== 'NF') continue;
        c.danfes++;

        const nf = extrairNotaFiscal(text);
        if (nf.nome) c.nome++;
        if (nf.cnpj) c.cnpj++;
        if (nf.chaveAcesso) c.chave++;
        if (nf.cfop) c.cfop++;
        if (nf.valorTotal != null) c.totalNota++;
        if (nf.itens.length) c.comItens++;

        const daChave = cnpjDaChaveAcesso(nf.chaveAcesso);
        if (daChave) { c.cnpjTinhaChave++; if (daChave === nf.cnpj) c.cnpjBateChave++; }
        if (nf.valorTotal != null && nf.itens.length) {
            c.temTotalEItens++;
            if (nf.conferencia.fechaComTotal) c.fecha++;
        }
        for (const it of nf.itens) {
            c.itens++;
            if (it.unidade) c.itensUnid++;
            if (it.cfop) c.itensCfop++;
            if (it.confianca === 'alta') c.itensAlta++;
            if (it.descricao) c.itensDesc++;
        }
        if (exemplos.length < 6) exemplos.push({ arq: path.basename(p), nf });
    }

    console.log(`DANFEs analisados: ${c.danfes}\n`);
    console.log('── campos da nota ──');
    for (const [rot, n] of [
        ['nome do emitente', c.nome], ['CNPJ', c.cnpj], ['chave de acesso', c.chave],
        ['CFOP', c.cfop], ['valor total', c.totalNota], ['ao menos 1 item', c.comItens],
    ]) console.log(`  ${rot.padEnd(20)} ${String(n).padStart(4)}  ${pct(n, c.danfes)}`);

    console.log('\n── conferências ──');
    console.log(`  CNPJ == o da chave   ${c.cnpjBateChave}/${c.cnpjTinhaChave}  ${pct(c.cnpjBateChave, c.cnpjTinhaChave)}`);
    console.log(`  soma itens == total  ${c.fecha}/${c.temTotalEItens}  ${pct(c.fecha, c.temTotalEItens)}`);

    console.log(`\n── itens (${c.itens} no total, ${(c.itens / (c.comItens || 1)).toFixed(1)}/nota) ──`);
    for (const [rot, n] of [
        ['com descrição', c.itensDesc], ['com unidade', c.itensUnid],
        ['com CFOP', c.itensCfop], ['valor confirmado (q×u=t)', c.itensAlta],
    ]) console.log(`  ${rot.padEnd(24)} ${String(n).padStart(5)}  ${pct(n, c.itens)}`);

    console.log('\n── amostra ──');
    for (const { arq, nf } of exemplos) {
        console.log(`\n${arq}`);
        console.log(`  nome=${nf.nome || '∅'} | cnpj=${nf.cnpj || '∅'} | cfop=${nf.cfop || '∅'} | total=${nf.valorTotal ?? '∅'} | fecha=${nf.conferencia.fechaComTotal}`);
        for (const it of nf.itens.slice(0, 4)) {
            console.log(`   · ${(it.descricao || '∅').slice(0, 40).padEnd(40)} ${(it.unidade || '—').padEnd(4)} q=${it.quantidade ?? '?'} u=${it.valorUnitario ?? '?'} t=${it.valorTotal} [${it.confianca}]`);
        }
        if (nf.itens.length > 4) console.log(`   … +${nf.itens.length - 4} itens`);
    }
})();
