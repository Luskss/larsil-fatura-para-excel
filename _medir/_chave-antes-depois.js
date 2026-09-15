/**
 * _medir/_chave-antes-depois.js — a validação por DV que acabou de entrar em
 * `chaveValida` rejeita chave corrompida. Falta provar que ela NÃO rejeita chave boa:
 * uma correção que zera o lixo mas também derruba a extração legítima seria piora.
 *
 * Relê o TEXTO dos PDFs no disco e compara, por documento:
 *   · regra antiga (44 díg + UF + modelo, sem DV) — quantas chaves aceitava;
 *   · regra nova   (idem + DV mod-11)            — quantas aceita;
 *   · quantas a nova rejeitou, e se alguma delas parecia legítima.
 *
 * Não grava nada. Uso: node _medir/_chave-antes-depois.js [quantos-pdfs]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const RAIZ = path.join(__dirname, '..');

for (const linha of fs.readFileSync(path.join(RAIZ, '.env'), 'utf8').split(/\r?\n/)) {
    const m = linha.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(m[1] in process.env)) process.env[m[1]] = v;
}

const UFS = new Set([11,12,13,14,15,16,17,21,22,23,24,25,26,27,28,29,31,32,33,35,41,42,43,50,51,52,53]);
const MODELOS = new Set(['55', '57', '65']);
const RE = /(?<!\d)((?:\d[\s]*){44})(?!\d)/g;

const validaAntiga = d => d.length === 44 && UFS.has(Number(d.slice(0, 2))) && MODELOS.has(d.slice(20, 22));
function dvOk(d) {
    let peso = 2, soma = 0;
    for (let i = 42; i >= 0; i--) { soma += Number(d[i]) * peso; peso = peso === 9 ? 2 : peso + 1; }
    const resto = soma % 11;
    return (resto < 2 ? 0 : 11 - resto) === Number(d[43]);
}
const validaNova = d => validaAntiga(d) && dvOk(d);

// a regex frouxa que estava em parseDanfe/parseCte, para medir o que ELA produzia
const REGEX_FROUXA = /\b(\d[\d ]{42,52}\d)\b/;

// Varre em largura, com fila explícita: a versão recursiva parava no primeiro
// diretório porque o `return` do limite abortava o nível inteiro antes de descer.
function pdfsDe(raiz, limite) {
    const fila = [raiz], achados = [];
    while (fila.length && achados.length < limite) {
        const dir = fila.shift();
        let entradas;
        try { entradas = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { continue; }
        for (const e of entradas) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) fila.push(p);
            else if (/\.pdf$/i.test(e.name) && achados.length < limite) achados.push(p);
        }
    }
    return achados;
}

(async () => {
    const limite = Number(process.argv[2] || 150);
    const raiz = process.env.ARQUIVO_PATH;
    if (!raiz) { console.error('ARQUIVO_PATH não configurado'); process.exit(1); }

    // Mesma extração que process-folder.js usa (pdf-parse 2.x é classe, não função).
    const { PDFParse } = require('pdf-parse');
    const extrair = async buffer => {
        const parser = new PDFParse({ data: new Uint8Array(buffer) });
        try {
            const r = await parser.getText();
            return (r.text || '').replace(/--\s*\d+\s+of\s+\d+\s*--/gi, ' ');
        } finally { try { await parser.destroy(); } catch (_) {} }
    };

    let lidos = 0, comSeq = 0, antiga = 0, nova = 0, frouxa = 0;
    let rejeitadasPeloDv = 0, frouxaLixo = 0;
    const exemplosRejeitados = [];

    for (const p of pdfsDe(raiz, limite)) {
        let texto = '';
        try { texto = await extrair(fs.readFileSync(p)); } catch (_) { continue; }
        lidos++;

        // o que a regex frouxa dos parsers pegava
        const mf = texto.replace(/\s+/g, ' ').match(REGEX_FROUXA);
        if (mf) {
            frouxa++;
            const d = mf[1].replace(/\D/g, '');
            if (!validaNova(d)) frouxaLixo++;
        }

        // sequências de 44 dígitos, avaliadas pelas duas regras
        RE.lastIndex = 0;
        let m, achouAntiga = null, achouNova = null;
        while ((m = RE.exec(texto)) !== null) {
            const d = m[1].replace(/\D/g, '');
            if (!achouAntiga && validaAntiga(d)) achouAntiga = d;
            if (!achouNova && validaNova(d)) achouNova = d;
        }
        if (achouAntiga || achouNova) comSeq++;
        if (achouAntiga) antiga++;
        if (achouNova) nova++;
        if (achouAntiga && !achouNova) {
            rejeitadasPeloDv++;
            if (exemplosRejeitados.length < 5)
                exemplosRejeitados.push(`${path.basename(p)}\n        ${achouAntiga}  (UF ${achouAntiga.slice(0,2)}, modelo ${achouAntiga.slice(20,22)}, DV lido ${achouAntiga[43]})`);
        }
    }

    console.log(`PDFs lidos: ${lidos}   (raiz: ${raiz})\n`);
    console.log(`── extração da chave, regra antiga × nova ──`);
    console.log(`documentos com alguma chave aceita`);
    console.log(`   regra ANTIGA (sem DV)   ${antiga}`);
    console.log(`   regra NOVA   (com DV)   ${nova}`);
    console.log(`   perdidas pela nova      ${rejeitadasPeloDv}   ← se >0, conferir se eram legítimas`);
    console.log(`\n── a regex frouxa que estava em parseDanfe/parseCte ──`);
    console.log(`   documentos em que ela casava   ${frouxa}`);
    console.log(`   ...e produzia chave INVÁLIDA   ${frouxaLixo}`);
    if (exemplosRejeitados.length) {
        console.log(`\nchaves que a regra antiga aceitava e a nova rejeita:`);
        for (const e of exemplosRejeitados) console.log(`   · ${e}`);
    }
})().catch(e => { console.error(e); process.exit(1); });
