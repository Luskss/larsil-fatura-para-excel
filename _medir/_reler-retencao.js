/**
 * _medir/_reler-retencao.js — relê as NFS-e cuja RETENÇÃO não foi gravada.
 *
 * GRAVA NO BANCO (com --confirmar). Dry-run por padrão.
 *
 * ── Por que existe ──────────────────────────────────────────────────────────
 * Até 15/09/2026 o caminho da IA em `analyzePdf` NÃO chamava o parser de tipo
 * (§17.1), então nenhuma NFS-e lida por IA tem campo de retenção: 485 de 525 no
 * acervo. Sem `Valor do serviço` (o BRUTO), o documento só tem o líquido, e o
 * lançamento — que a planilha registra pelo bruto — não acha par.
 *
 * Não falta código: `parseNfse` extrai os campos e `retencaoDoParser` já os usa
 * como valor de casamento. Falta REGRAVAR as linhas antigas.
 *
 * ── Escopo: os 15 pares medidos, não o acervo ───────────────────────────────
 * Medido em 18/09/2026 (§17.11 e §17.12): dos 485 documentos sem retenção, só 15
 * têm um lançamento sem documento cujo valor é o bruto E cujo NÚMERO bate. Reler o
 * acervo inteiro custaria 485 chamadas de IA para os mesmos 15 pares.
 *
 * O número é obrigatório no critério: a faixa "valor a menos de uma retenção"
 * sozinha casa fornecedor qualquer (MAQNELSON × AGRIPONTA), e inflou a conta de
 * 15 para 177 antes de eu exigir o 2º sinal.
 *
 * ── Verificado ANTES de escrever este script ────────────────────────────────
 *   ensaio com `analyzePdf` nos 15, sem gravar:
 *     · 15/15 passam a ter `Valor do serviço` e o ISS retido
 *     · 15/15 mantêm `Valor total` = LÍQUIDO (nenhum vira bruto)  ← não perde par
 *     ·  0 erros
 *   `camposOcr` (a função que o pareamento usa) sobre o resultado:
 *     · 13/15 a conta FECHA (bruto − retido = líquido) e o bruto bate EXATAMENTE
 *       com o lançamento alvo
 *     ·  2/15 não fecham — JOAO PAULO GOMES NF 1 e MARANHAO NF 327 imprimem
 *       líquido = bruto, a nota não declara retenção. A trava recusa com razão
 *       ([[retencao-na-fonte-nao-e-divergencia]]: adivinhar alíquota reprovou).
 *
 * Ou seja: o ganho esperado é 13 pares, não 15. Os 2 são gravados do mesmo jeito
 * (o campo novo não faz mal), mas não viram par — e isso é o certo.
 *
 * ── Segurança ───────────────────────────────────────────────────────────────
 *  · relê ANTES de tocar no banco: leitura falhou, banco preservado;
 *  · salva backup do CSV de cada período em `_medir/backup-retencao-<ts>/`;
 *  · `upsertRelatorio` já remove as linhas antigas do mesmo PDF antes de gravar
 *    ([[parcelas-pn-sobram-no-upsert]]), e cada alvo fica num período só — não é
 *    o caso do carnê espalhado que exigiu limpeza manual;
 *  · invariante: aborta se a releitura não trouxer `Valor do serviço`, ou se o
 *    `Valor total` deixar de ser o líquido (seria trocar ganho por perda).
 *
 * CUSTA API (15 documentos).
 *
 * Uso:
 *   node _medir/_reler-retencao.js              (dry-run)
 *   node _medir/_reler-retencao.js --confirmar
 */
'use strict';
const fs = require('fs');
const path = require('path');
const RAIZ = path.join(__dirname, '..');

for (const l of fs.readFileSync(path.join(RAIZ, '.env'), 'utf8').split(/\r?\n/)) {
    const m = l.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(m[1] in process.env)) process.env[m[1]] = v;
}

const { getConnection, sql } = require('../config');
const pf = require('../routes/process-folder');
const { paraNumero } = require('../routes/_valor-do-pagamento');

const CONFIRMAR = process.argv.includes('--confirmar');
const LISTA = path.join(__dirname, '.cache', 'alvos-retencao.json');

const BRL = (v) => v == null ? '—' : 'R$ ' + Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2 });
const bate = (a, b) => a != null && b != null && Math.abs(a - b) <= 0.02;
const campos = (row) => { try { return JSON.parse(row.dados_parser || '{}') || {}; } catch (_) { return {}; } };

if (!fs.existsSync(LISTA)) {
    console.error(`lista de alvos não encontrada: ${LISTA}`);
    console.error('Gere-a antes — ela sai da medição de §17.12 (pares recuperáveis por número).');
    process.exit(1);
}
const ALVOS = JSON.parse(fs.readFileSync(LISTA, 'utf8'));

(async () => {
    const pool = await getConnection();

    console.log(`=== RELEITURA DIRIGIDA — retenção não gravada ===`);
    console.log(`alvos: ${ALVOS.length} documentos\n`);

    // ── 1. onde cada alvo está gravado hoje ─────────────────────────────────
    const rs = await pool.request().query('SELECT TIPO, PERIODO, CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA');
    const ondeEsta = new Map();   // nome -> [{tipo, periodo}]
    for (const rec of rs.recordset) {
        for (const row of pf.csvToRows(rec.CONTEUDO)) {
            if (!row.arquivo) continue;
            const base = String(row.arquivo).replace(/#p\d+$/i, '').trim();
            const alvo = ALVOS.find(a => a.nome === base || a.nome === row.arquivo);
            if (!alvo) continue;
            if (!ondeEsta.has(alvo.nome)) ondeEsta.set(alvo.nome, []);
            ondeEsta.get(alvo.nome).push({ tipo: rec.TIPO, periodo: rec.PERIODO });
        }
    }
    let espalhados = 0;
    for (const [nome, locs] of ondeEsta) {
        const mesesM = [...new Set(locs.filter(l => l.tipo === 'M').map(l => l.periodo))];
        if (mesesM.length > 1) { espalhados++; console.log(`   ⚠ ${nome.slice(0,44)} está em ${mesesM.length} períodos M: ${mesesM.join(', ')}`); }
    }
    console.log(`   localizados no banco: ${ondeEsta.size}/${ALVOS.length}` +
                (espalhados ? `   (${espalhados} em mais de um período)` : '   (nenhum espalhado)'));

    if (!CONFIRMAR) {
        console.log(`\nO QUE SERIA FEITO:`);
        console.log(`  1. reler os ${ALVOS.length} PDFs com forceAI (custa API)`);
        console.log(`  2. conferir: cada um tem 'Valor do serviço' e mantém o líquido em 'Valor total'`);
        console.log(`  3. backup do CSV dos períodos tocados`);
        console.log(`  4. upsertRelatorio por período (M e D)`);
        console.log(`\nGanho esperado: 13 pares (2 dos 15 não fecham a conta e seguirão sem par).`);
        console.log(`\nDRY-RUN — nada gravado. Acrescente --confirmar.`);
        process.exit(0);
    }

    // ── 2. relê TUDO antes de tocar no banco ────────────────────────────────
    console.log(`\n── RELENDO (forceAI) ──────────────────────────────────────`);
    const novas = [];
    for (let i = 0; i < ALVOS.length; i++) {
        const a = ALVOS[i];
        const pdf = { name: a.nome, path: a.caminho, folder: path.dirname(a.rel), rel: a.rel };
        let rows = null;
        try { rows = await pf.analyzePdf(pdf, { forceAI: true }); }
        catch (e) { console.error(`   ✗ ${a.nome.slice(0,44)}: ${e.message}`); continue; }
        const r = (rows || []).find(x => !/#p\d+$/i.test(x.arquivo)) || (rows || [])[0];
        if (!r) { console.error(`   ✗ ${a.nome.slice(0,44)}: sem linha`); continue; }

        const pd = campos(r);
        const serv = paraNumero(pd['Valor do serviço']);
        const vTot = paraNumero(pd['Valor total']);

        // INVARIANTES — qualquer uma falhando aborta tudo, banco intacto.
        if (serv == null) {
            console.error(`\n✗ ABORTADO: ${a.nome} voltou SEM 'Valor do serviço'.`);
            console.error(`  Gravar assim não resolveria nada. Banco preservado.`);
            process.exit(1);
        }
        if (!bate(vTot, a.valorDoc)) {
            console.error(`\n✗ ABORTADO: ${a.nome} mudou o 'Valor total'.`);
            console.error(`  antes ${BRL(a.valorDoc)} · agora ${BRL(vTot)} — trocaria ganho por perda de par.`);
            process.exit(1);
        }
        console.log(`   [${String(i+1).padStart(2)}] ✓ serv=${BRL(serv).padStart(13)} total=${BRL(vTot).padStart(13)}  ${a.nome.slice(0,40)}`);
        novas.push({ alvo: a, rows });
    }
    if (novas.length !== ALVOS.length) {
        console.error(`\n✗ ABORTADO: ${novas.length}/${ALVOS.length} leituras boas. Banco preservado.`);
        process.exit(1);
    }

    // ── 3. backup dos períodos que serão tocados ────────────────────────────
    const tocados = new Set();
    for (const { alvo } of novas) for (const l of (ondeEsta.get(alvo.nome) || [])) tocados.add(`${l.tipo}|${l.periodo}`);
    const dirBackup = path.join(__dirname, `backup-retencao-${new Date().toISOString().slice(0,19).replace(/[:T]/g,'-')}`);
    fs.mkdirSync(dirBackup, { recursive: true });
    for (const chave of tocados) {
        const [tipo, periodo] = chave.split('|');
        const atual = await pool.request()
            .input('t', sql.Char(1), tipo).input('p', sql.VarChar(20), periodo)
            .query('SELECT CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO=@t AND PERIODO=@p');
        if (!atual.recordset.length) continue;
        fs.writeFileSync(path.join(dirBackup, `${tipo}-${periodo}.csv`), atual.recordset[0].CONTEUDO, 'utf8');
    }
    console.log(`\n   backup de ${tocados.size} período(s) em ${dirBackup}`);

    // ── 4. grava, cada documento no seu período ─────────────────────────────
    const diaDaPasta = (f) => {
        const m = String(f || '').match(/(?:^|[\/\\])(\d{4})\.(\d{2})\.(\d{2})(?:[\/\\]|$)/);
        return m ? `${m[3]}.${m[2]}.${m[1]}` : null;
    };
    const porMes = new Map(), porDia = new Map();
    for (const { alvo, rows } of novas) {
        const mes = alvo.periodoPasta;
        const dia = diaDaPasta(alvo.rel);
        if (!porMes.has(mes)) porMes.set(mes, []);
        for (const r of rows) porMes.get(mes).push(r);
        if (dia) { if (!porDia.has(dia)) porDia.set(dia, []); for (const r of rows) porDia.get(dia).push(r); }
    }

    console.log(`\n── GRAVANDO ───────────────────────────────────────────────`);
    for (const [mes, rows] of porMes) { await pf.upsertRelatorio(pool, 'M', mes, rows); console.log(`   M ${mes}: ${rows.length} row(s)`); }
    for (const [dia, rows] of porDia) await pf.upsertRelatorio(pool, 'D', dia, rows);
    console.log(`   D: ${porDia.size} dia(s)`);
    console.log(`\n✓ ${novas.length} documentos regravados com a retenção.`);
    console.log(`  Confira o efeito: node _medir/_conferir-planilha.js`);
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
