/**
 * _medir/_corrigir-valor-por-ld.js — corrige `Valor total` onde a linha digitável
 * validada E o nome do arquivo concordam contra o valor gravado.
 *
 * Contexto (17/09/2026). Este script NÃO é o conserto do código — esse foi medido e
 * recusado três vezes (ver [linha-digitavel-vence-o-valor], [sobrescrita-do-valor-na-630],
 * [dv-nao-sabe-o-que-foi-pago]). É uma correção PONTUAL do dado já gravado.
 *
 * ── O critério, e por que os três itens juntos ──────────────────────────────
 *   1) `Linha digitável` de 47 dígitos com os 3 DVs mod-10 fechando   → prova aritmética
 *   2) o valor decodificado dela BATE `valorDoNomeArquivo`            → 2ª prova, independente
 *   3) o `Valor total` gravado difere desse valor                     → há o que corrigir
 *
 * O item 2 é o que separa esta correção da regra que reprovou. Em
 * [dv-nao-sabe-o-que-foi-pago], a guia do MINISTÉRIO DA JUSTIÇA tem LD = R$ 130,16 e
 * nome = R$ 78,09: a LD diverge do pago legitimamente, e o nome NÃO a confirma — então
 * ela não entra aqui. Só se corrige onde duas fontes independentes dizem o mesmo.
 *
 * ── O que fica de fora, de propósito ────────────────────────────────────────
 * PARCELAS (`arquivo` terminando em `#pN`). Num carnê a linha digitável é de UMA parcela
 * e `enriquecerComBoleto` a replica em todas as linhas; corrigi-las gravaria o mesmo
 * valor em N parcelas diferentes. São 101 dos 154 candidatos brutos — a maioria. Ver
 * [parcelas-pn-sobram-no-upsert] e o bloco de carnê em `process-folder.js`.
 *
 * ── Segurança ───────────────────────────────────────────────────────────────
 * - `--confirmar` é obrigatório para gravar; sem ele é dry-run.
 * - Salva backup do CONTEUDO de cada relatório tocado em `_medir/backup-<stamp>/`
 *   antes do UPDATE. Para desfazer, basta regravar esses arquivos.
 * - Altera SOMENTE a chave `Valor total` do `dados_parser`, e acrescenta
 *   `Origem do valor pago` = 'linha digitável (corrigido)' para a conferência humana
 *   saber de onde veio. Nenhum outro campo é tocado.
 * - Preserva o valor anterior em `Valor total da nota` quando essa chave está vazia —
 *   quem confere precisa poder ver os dois números, mesma disciplina de
 *   `decidirValorPago`.
 *
 * Uso:
 *   node _medir/_corrigir-valor-por-ld.js              (dry-run)
 *   node _medir/_corrigir-valor-por-ld.js --confirmar
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

const { getConnection } = require('../config');
const pf = require('../routes/process-folder');
const { paraNumero } = require('../routes/_valor-do-pagamento');

const valorDoNomeArquivo = (() => {
    const src = fs.readFileSync(path.join(RAIZ, 'routes', 'process-folder.js'), 'utf8');
    const L = src.split(/\r?\n/);
    const i = L.findIndex(x => x.startsWith('function valorDoNomeArquivo'));
    let f = -1;
    for (let j = i + 1; j < L.length; j++) if (L[j] === '}') { f = j; break; }
    const mod = { exports: {} };
    new Function('module', `${L.slice(i, f + 1).join('\n')}\nmodule.exports = valorDoNomeArquivo;`)(mod);
    return mod.exports;
})();
if (valorDoNomeArquivo('008.DOC- 5977,98 - x.pdf') !== 5977.98) throw new Error('régua quebrada');

function mod10(b) {
    let s = 0, p = 2;
    for (let i = b.length - 1; i >= 0; i--) { let x = Number(b[i]) * p; if (x > 9) x -= 9; s += x; p = p === 2 ? 1 : 2; }
    return s % 10 === 0 ? 0 : 10 - (s % 10);
}
function valorDaLinhaValidada(ld) {
    const d = String(ld || '').replace(/\D/g, '');
    if (d.length !== 47) return null;
    if (mod10(d.slice(0, 9)) !== Number(d[9])) return null;
    if (mod10(d.slice(10, 20)) !== Number(d[20])) return null;
    if (mod10(d.slice(21, 31)) !== Number(d[31])) return null;
    const v = Number(d.slice(37, 47)) / 100;
    return v > 0 ? v : null;
}
// Invariantes: casos conferidos à mão, e corrupção em cada bloco verificado.
if (Math.abs(valorDaLinhaValidada('00190000090000000000000000000000000000001320983') - 13209.83) > 0.005) {
    throw new Error('valorDaLinhaValidada erra o caso conhecido');
}
if (valorDaLinhaValidada('00190000190000000000000000000000000000001320983') !== null
    || valorDaLinhaValidada('00190000090000000000100000000000000000001320983') !== null
    || valorDaLinhaValidada('0019000009000000000000000000000000000000132098') !== null) {
    throw new Error('valorDaLinhaValidada aceitou linha inválida');
}

const CONFIRMAR = process.argv.includes('--confirmar');
const BRL = (v) => v == null ? '—' : 'R$ ' + Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2 });
const bate = (a, b) => a != null && b != null && Math.abs(a - b) <= 0.02;
const fmtBR = n => n.toFixed(2).replace('.', ',');

(async () => {
    const pool = await getConnection();
    const rs = await pool.request().query("SELECT PERIODO, TIPO, CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA");

    const mudancas = [];                 // {periodo, tipo, novoConteudo, itens:[...]}
    let examinadas = 0, pulouParcela = 0;
    const docs = new Set();

    for (const rec of rs.recordset) {
        const rows = pf.csvToRows(rec.CONTEUDO);
        const itens = [];
        let mudou = false;

        for (const row of rows) {
            if (!row.arquivo) continue;
            examinadas++;

            // Parcela de carnê fica de fora — ver o cabeçalho.
            if (/#p\d+$/i.test(row.arquivo)) {
                let pdp = {};
                try { pdp = JSON.parse(row.dados_parser || '{}') || {}; } catch (_) {}
                const v = valorDaLinhaValidada(pdp['Linha digitável']);
                if (v != null && bate(v, valorDoNomeArquivo(row.arquivo))
                    && !bate(paraNumero(pdp['Valor total']), v)) pulouParcela++;
                continue;
            }

            let pd = {};
            try { pd = JSON.parse(row.dados_parser || '{}') || {}; } catch (_) { continue; }
            const vLD = valorDaLinhaValidada(pd['Linha digitável']);
            if (vLD == null) continue;
            const vNome = valorDoNomeArquivo(row.arquivo);
            if (!bate(vLD, vNome)) continue;                 // sem a 2ª prova, não mexe
            const vTot = paraNumero(pd['Valor total']);
            if (bate(vTot, vLD)) continue;                   // já está certo

            // O valor anterior não se perde.
            if (vTot != null && paraNumero(pd['Valor total da nota']) == null) {
                pd['Valor total da nota'] = fmtBR(vTot);
            }
            pd['Valor total'] = fmtBR(vLD);
            pd['Origem do valor pago'] = 'linha digitável (corrigido)';
            row.dados_parser = JSON.stringify(pd);
            mudou = true;
            docs.add(row.arquivo);
            itens.push({ arquivo: row.arquivo, de: vTot, para: vLD });
        }

        if (mudou) {
            const depois = pf.rowsToCsv(rows);

            // TRAVA DE IDA-E-VOLTA. `rowsToCsv` é a mesma função que `upsertRelatorio`
            // usa, mas reescrever o CSV inteiro para mudar um campo é arriscado: se
            // alguma coluna não sobrevivesse ao ciclo, eu corromperia o relatório todo
            // em silêncio. Aqui se relê o que foi gerado e se exige que NADA além de
            // `dados_parser` das linhas visadas tenha mudado.
            const relido = pf.csvToRows(depois);
            const orig = pf.csvToRows(rec.CONTEUDO);
            if (relido.length !== orig.length) {
                throw new Error(`ida-e-volta perdeu linhas em ${rec.TIPO}/${rec.PERIODO}: ${orig.length} → ${relido.length}`);
            }
            const visadas = new Set(itens.map(x => x.arquivo));
            for (let i = 0; i < orig.length; i++) {
                for (const col of pf.COLS) {
                    if (col === 'dados_parser' && visadas.has(orig[i].arquivo)) continue;
                    if (String(orig[i][col] ?? '') !== String(relido[i][col] ?? '')) {
                        throw new Error(`ida-e-volta alterou "${col}" em ${rec.TIPO}/${rec.PERIODO}, linha ${i} (${orig[i].arquivo})`);
                    }
                }
            }

            mudancas.push({ periodo: rec.PERIODO, tipo: rec.TIPO, antes: rec.CONTEUDO, depois, itens });
        }
    }

    console.log('══ CORREÇÃO por linha digitável + nome ══════════════════════');
    console.log(`   linhas examinadas        : ${examinadas}`);
    console.log(`   parcelas #pN puladas     : ${pulouParcela}  (de propósito — ver cabeçalho)`);
    console.log(`   DOCUMENTOS a corrigir    : ${docs.size}`);
    console.log(`   relatórios afetados      : ${mudancas.length}`);
    const totLinhas = mudancas.reduce((s, m) => s + m.itens.length, 0);
    console.log(`   linhas a regravar        : ${totLinhas}\n`);

    const vistos = new Set();
    for (const m of mudancas) {
        for (const it of m.itens) {
            if (vistos.has(it.arquivo)) continue;
            vistos.add(it.arquivo);
            console.log(`   ${BRL(it.de).padStart(14)} → ${BRL(it.para).padStart(14)}   ${it.arquivo.slice(0, 54)}`);
        }
    }

    if (!CONFIRMAR) {
        console.log('\nDRY-RUN — nada gravado. Acrescente --confirmar para executar.');
        process.exit(0);
    }
    if (!mudancas.length) { console.log('\nnada a fazer.'); process.exit(0); }

    // Backup antes de qualquer UPDATE.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const dirBk = path.join(__dirname, `backup-${stamp}`);
    fs.mkdirSync(dirBk, { recursive: true });
    for (const m of mudancas) {
        fs.writeFileSync(path.join(dirBk, `${m.tipo}_${m.periodo.replace(/\//g, '-')}.csv`), m.antes, 'utf8');
    }
    console.log(`\nbackup em ${dirBk}`);

    let ok = 0;
    for (const m of mudancas) {
        await pool.request()
            .input('c', m.depois)
            .input('t', m.tipo)
            .input('p', m.periodo)
            .query('UPDATE nfs.RELATORIOS_CONFERENCIA SET CONTEUDO=@c WHERE TIPO=@t AND PERIODO=@p');
        ok++;
    }
    console.log(`\n── GRAVADO ──────────────────────────────────────────────────`);
    console.log(`   relatórios atualizados : ${ok}`);
    console.log(`   documentos corrigidos  : ${docs.size}`);
    console.log(`\n   para desfazer: regrave os CSV de ${path.basename(dirBk)}`);
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
