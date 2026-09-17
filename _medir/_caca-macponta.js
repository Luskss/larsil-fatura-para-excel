/**
 * _medir/_caca-macponta.js — o lançamento de R$ 660.000,00 da MACPONTA (03.2026)
 * não achou documento. Existe papel para ele em algum lugar do acervo?
 *
 * Procura em TRÊS eixos independentes, porque cada um falha de um jeito diferente:
 *   1. NOME do arquivo   — pega o que a equipe nomeou com a entidade
 *   2. VALOR             — no nome e no que o banco extraiu (exato e parcelas plausíveis)
 *   3. CNPJ / entidade   — no que o banco gravou em dados_parser
 *
 * O universo é o acervo INTEIRO (todos os meses), não a vizinhança de março: se o
 * documento existe mas está arquivado longe, é isso que queremos descobrir.
 *
 * Uso: node _medir/_caca-macponta.js ["TRECHO"] [--valor 660000]
 */
'use strict';
const h = require('./harness');
const par = require('../routes/_pareamento');

const args = process.argv.slice(2);
const TRECHO = (args.find(a => !a.startsWith('--') && !/^\d+$/.test(a)) || 'MACPONTA').toUpperCase();
const iv = args.indexOf('--valor');
const VALOR = iv >= 0 ? parseFloat(args[iv + 1]) : 660000;

const BRL = (v) => 'R$ ' + (v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const norm = (s) => String(s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const cent = (v) => Math.round((v || 0) * 100);

(async () => {
    const c = h.carregar();
    const rota = h.internasDaRota();
    const { getConnection } = require('../config');
    const pool = await getConnection();
    const rs = await pool.request().input('tipo', 'M')
        .query('SELECT CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO = @tipo');
    const csvs = rs.recordset.map(r => r.CONTEUDO);
    const idx = rota.contarNoCsv(csvs).ocrPorArquivo || {};

    // ── o lançamento na planilha ─────────────────────────────────────────────
    console.log(`=== o LANÇAMENTO procurado ===`);
    for (const [mes, pl] of Object.entries(c.planilha)) {
        for (const it of (pl.itens || [])) {
            const l = par.lancamentoDaPlanilha(it);
            if (norm(l.entidade).includes(TRECHO) || cent(l.valor) === cent(VALOR)) {
                console.log(`  ${mes}  ${BRL(l.valor).padStart(15)}  nf=${String(l.nf || '—').padEnd(10)} cnpj=${l.cnpj || '—'}  ${String(l.entidade).slice(0, 48)}`);
            }
        }
    }

    // ── 1. por NOME do arquivo, no acervo inteiro ────────────────────────────
    console.log(`\n=== 1. arquivos cujo NOME contém "${TRECHO}" (acervo inteiro) ===`);
    let achouNome = 0;
    for (const [mes, arqs] of Object.entries(c.pasta.arquivosPorMes)) {
        for (const a of arqs) {
            if (!norm(a.nome).includes(TRECHO)) continue;
            achouNome++;
            const d = par.enriquecerComOcr(par.documentoDoArquivo(a.nome, a.rel), idx[a.nome]);
            console.log(`  [${mes}] ${a.nome.slice(0, 72)}`);
            console.log(`         valorNome=${d.valorDoNome != null ? BRL(d.valorDoNome) : '—'}  valorOcr=${d.valor != null ? BRL(d.valor) : '—'}  nf=${d.numero || '—'}`);
        }
    }
    if (!achouNome) console.log('  NENHUM arquivo no acervo tem esse nome.');

    // ── 2. por VALOR (exato, e metades/parcelas plausíveis) ──────────────────
    console.log(`\n=== 2. documentos com valor ${BRL(VALOR)} (ou fração redonda) ===`);
    const alvos = new Map([[cent(VALOR), 'exato']]);
    for (const n of [2, 3, 4, 5, 6, 10, 12]) alvos.set(cent(VALOR / n), `1/${n}`);
    let achouValor = 0;
    for (const [mes, arqs] of Object.entries(c.pasta.arquivosPorMes)) {
        for (const a of arqs) {
            const d = par.enriquecerComOcr(par.documentoDoArquivo(a.nome, a.rel), idx[a.nome]);
            for (const v of [d.valor, d.valorDoNome]) {
                if (v == null) continue;
                const tag = alvos.get(cent(v));
                if (!tag) continue;
                achouValor++;
                console.log(`  [${mes}] (${tag}) ${BRL(v).padStart(15)}  ${a.nome.slice(0, 60)}`);
                break;
            }
        }
    }
    if (!achouValor) console.log('  NENHUM documento no acervo tem esse valor nem fração redonda dele.');

    // ── 3. no que o BANCO gravou (entidade/CNPJ dentro de dados_parser) ──────
    console.log(`\n=== 3. linhas do BANCO que mencionam "${TRECHO}" ===`);
    const pf = require('../routes/process-folder');
    let achouBanco = 0;
    for (const csv of csvs) {
        for (const row of pf.csvToRows(csv)) {
            if (!row.arquivo) continue;
            const alvo = norm(`${row.arquivo} ${row.dados_parser || ''} ${row.cnpj || ''}`);
            if (!alvo.includes(TRECHO)) continue;
            achouBanco++;
            if (achouBanco <= 12) {
                let dp = {};
                try { dp = JSON.parse(row.dados_parser || '{}') || {}; } catch (_) {}
                const emit = dp['Emitente'] || dp['Razão Social'] || '—';
                const val = dp['Valor total'] || dp['Valor total da nota'] || dp['Valor do boleto'] || '—';
                console.log(`  ${row.arquivo.slice(0, 56)}`);
                console.log(`     emitente=${String(emit).slice(0, 44)}  valor=${val}  tipo=${row.tipo}`);
            }
        }
    }
    if (!achouBanco) console.log('  NENHUMA linha do banco menciona essa entidade.');
    else if (achouBanco > 12) console.log(`  ... e mais ${achouBanco - 12}`);

    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
