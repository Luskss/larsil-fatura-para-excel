/**
 * ⚠️ REPROVADO — a premissa está ERRADA. Mantido como registro.
 *
 * Este script assume que a coluna `conteudo` do banco guarda o TEXTO do PDF. Não
 * guarda: ela tem só o RÓTULO de procedência — "Texto", "Imagem (OCR)",
 * "Imagem (visão)" (process-folder.js:579 e :1026). São 5 caracteres, e o script
 * concluiu alegremente "nenhum marcador no papel" para os 10 documentos, inclusive
 * os que têm evidência gravada "DACTE" e "MDF-E".
 *
 * O texto extraído do PDF NÃO é persistido — só os campos derivados
 * (`dados_parser`, `tipo`, `evidencia`). Para reler o papel é preciso reprocessar
 * o PDF, não consultar o banco. Ver [[sucesso-silencioso-engana-vigilancia]], que
 * já avisava o que essa coluna é.
 *
 * O veredito correto veio de `_tipo-cte-veredito.js`, pela evidência gravada.
 *
 * _medir/_tipo-cte-ler-o-papel.js — o que o PAPEL diz nos 10 alertas NF→CTE?
 *
 * O limiar automático de `_tipo-cte-quem-erra.js` não decidiu (47% forte / 53%
 * fraca). Agregado não resolve: vamos ao texto gravado (coluna `conteudo` do
 * banco) e procuramos os marcadores canônicos DIRETAMENTE.
 *
 * A pergunta é binária por documento: o papel contém "DACTE" / "CT-e" /
 * "CONHECIMENTO DE TRANSPORTE"? Se contém, é conhecimento de transporte e a
 * classificação CTE está certa — o alerta contra a planilha PROCEDE. Se não
 * contém, a IA inventou o tipo e o alerta é falso.
 *
 * Isto é ler o papel em vez de discutir a régua — o que resolveu
 * [[carne-dentro-do-comprovante]] e [[classificar-por-valor-inventa-classe]].
 *
 * SOMENTE LEITURA.
 */
'use strict';
const path = require('path');
const h = require('./harness');

const norm = s => String(s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

// os 10 documentos que o painel acusa como NF→CTE (de _tipo-residuo-anatomia.js)
const ALVOS = [
    'GOMES E SAVACINSK', 'EXPRESSO', 'RODONAVES', 'JB PRESTACAO', 'CADORE',
    'PRINCESA DOS CAMPOS',
];

const MARCADORES = [
    ['DACTE',                        /\bDACTE\b/],
    ['CT-e',                         /\bCT-?E\b/],
    ['MDF-e',                        /\bMDF-?E\b/],
    ['CONHECIMENTO DE TRANSPORTE',   /CONHECIMENTO DE TRANSPORTE/],
    ['DOC. AUX. DO CONHECIMENTO',    /DOCUMENTO AUXILIAR DO CONHECIMENTO/],
    ['TRANSPORTE RODOVIARIO CARGAS', /TRANSPORTE RODOVIARIO DE CARGAS/],
    ['— DANFE (nota de produto)',    /\bDANFE\b/],
    ['— NFS-e (nota de serviço)',    /\bNFS-?E\b/],
];

(async () => {
    const { getConnection } = require('../config');
    const pool = await getConnection();
    const rs = await pool.request().input('tipo', 'M')
        .query('SELECT CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO = @tipo');

    const separar = (linha) => {
        const out = []; let atual = '', aspas = false;
        for (let i = 0; i < linha.length; i++) {
            const ch = linha[i];
            if (aspas) {
                if (ch === '"') { if (linha[i + 1] === '"') { atual += '"'; i++; } else aspas = false; }
                else atual += ch;
            } else if (ch === '"') aspas = true;
            else if (ch === ';') { out.push(atual); atual = ''; }
            else atual += ch;
        }
        out.push(atual); return out;
    };

    let achados = 0, comCte = 0, semCte = 0;
    for (const row of rs.recordset) {
        const csv = row.CONTEUDO;
        if (!csv) continue;
        const ls = csv.replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim());
        if (ls.length < 2) continue;
        const cols = ls[0].replace(/^﻿/, '').split(';');
        const iA = cols.indexOf('arquivo'), iT = cols.indexOf('tipo'),
              iC = cols.indexOf('conteudo'), iE = cols.indexOf('evidencia');
        if (iA < 0 || iC < 0) continue;
        for (let i = 1; i < ls.length; i++) {
            const f = separar(ls[i]);
            const arq = String(f[iA] || '').trim();
            const tipo = String(f[iT] || '').trim();
            if (tipo !== 'CTE') continue;
            if (!ALVOS.some(a => norm(arq).includes(norm(a)))) continue;
            achados++;
            const texto = norm(f[iC] || '');
            console.log(`\n${'─'.repeat(72)}`);
            console.log(arq.slice(0, 70));
            console.log(`  evidência gravada: "${String(f[iE] || '—').slice(0, 44)}"`);
            if (!texto) { console.log('  ⚠ SEM TEXTO gravado (PDF-imagem?) — indecidível'); continue; }
            console.log(`  texto: ${texto.length} caracteres`);
            const hits = [];
            for (const [nome, re] of MARCADORES) if (re.test(texto)) hits.push(nome);
            console.log(`  marcadores no papel: ${hits.length ? hits.join(', ') : '(nenhum)'}`);
            const ehCte = hits.some(x => !x.startsWith('—'));
            if (ehCte) { comCte++; console.log('  → o papel É conhecimento de transporte: classificação CERTA'); }
            else { semCte++; console.log('  → o papel NÃO tem marcador de CT-e: classificação suspeita'); }
            // mostra o trecho ao redor do primeiro marcador, para conferência visual
            const m = texto.match(/\bDACTE\b|\bCT-?E\b|\bMDF-?E\b|CONHECIMENTO DE TRANSPORTE/);
            if (m) console.log(`  trecho: ...${texto.slice(Math.max(0, m.index - 60), m.index + 70)}...`);
        }
    }

    console.log(`\n${'═'.repeat(72)}`);
    console.log(`documentos examinados: ${achados}`);
    console.log(`  papel confirma CT-e:       ${comCte}`);
    console.log(`  papel NÃO confirma:        ${semCte}`);
    console.log('\nLEITURA: onde o papel confirma, a classificação está certa e o alerta');
    console.log('PROCEDE — a planilha é que lança frete como "NOTA FISCAL RFB". Silenciar');
    console.log('esses alertas esconderia divergência real.');
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
