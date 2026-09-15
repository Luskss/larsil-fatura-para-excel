/**
 * _medir/_ia-vs-local-no-valor.js — "só IA" melhora ou piora o VALOR?
 *
 * Pedido do usuário (11/09/2026): "de agora em diante só vamos usar via ia".
 *
 * Antes de mudar o padrão do sistema, a pergunta tem que ser medida nas DUAS metades,
 * e há um sinal de alerta: em 01.2026 as linhas de origem IA acertam o valor em 78%
 * (633 ok / 132 ERRO / 46 parcela). Se as de origem "conteúdo" acertarem MAIS, então
 * "só IA" troca um extrator melhor por um pior no campo que decide o pareamento.
 *
 * O viés a evitar: as duas populações não são iguais — a IA foi usada justamente onde
 * o parser local falhou. Comparar as médias direto compararia dificuldade, não motor.
 * Por isso a comparação principal é PAREADA: documentos que têm leitura das DUAS
 * origens em relatórios diferentes (o mesmo arquivo aparece no diário e no mensal, e
 * em meses vizinhos), onde a dificuldade é a mesma por construção.
 *
 * SOMENTE LEITURA.
 */
'use strict';
const path = require('path');
const h = require('./harness');
const j = require('./_julgar-campos');
const { getConnection, sql } = require('../config');
const pf = require('../routes/process-folder');

const VAZIO = v => v == null || String(v).trim() === '' || String(v).trim() === '—';
const ROT_VALOR = ['Valor total da nota', 'Valor total', 'Valor do serviço',
                   'Valor principal', 'Valor da prestação', 'Valor líquido'];
const primeiro = (pd, ks) => { for (const k of ks) if (pd && !VAZIO(pd[k])) return pd[k]; return null; };

(async () => {
    const pool = await getConnection();
    const rr = await pool.request()
        .query('SELECT TIPO, PERIODO, CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA');
    console.log(`relatórios: ${rr.recordset.length}\n`);

    // nome -> { IA: [cls...], local: [cls...] }
    const porArquivo = new Map();
    const globais = { IA: {}, local: {} };
    for (const k of ['IA', 'local'])
        globais[k] = { ok: 0, erro: 0, parcela: 0, vazio: 0, semGab: 0, n: 0, itens: 0 };

    for (const reg of rr.recordset)
        for (const x of pf.csvToRows(reg.CONTEUDO)) {
            const arq = String(x.arquivo);
            const base = path.basename(arq.replace(/#p\d+$/, ''));
            const g = j.gabaritos(base);
            if (g.valor == null) continue;
            let pd = null; try { pd = JSON.parse(x.dados_parser || 'null'); } catch (_) {}
            const v = j.num(primeiro(pd, ROT_VALOR));
            const cls = j.jValor(v, g.valor);
            const via = /\bIA\b/i.test(String(x.origem || '')) ? 'IA' : 'local';

            globais[via].n++;
            globais[via][cls === 's/gab' ? 'semGab' : cls]++;
            if (pd && Array.isArray(pd['Itens']) && pd['Itens'].length) globais[via].itens++;

            // Chave inclui a parcela: `#p2` é outro lançamento, não a mesma leitura.
            const chave = arq;
            const e = porArquivo.get(chave) || { IA: [], local: [] };
            e[via].push(cls);
            porArquivo.set(chave, e);
        }

    const linha = (nome, a) => {
        const jul = a.ok + a.erro + a.parcela + a.vazio;
        return '   ' + nome.padEnd(10) + String(a.n).padStart(7) + String(a.ok).padStart(8) +
            String(a.erro).padStart(8) + String(a.parcela).padStart(9) + String(a.vazio).padStart(8) +
            String(a.itens).padStart(8) + (jul ? (100 * a.ok / jul).toFixed(0) + '%' : '—').padStart(8);
    };
    console.log('1) TODAS AS LINHAS COM GABARITO (populações diferentes — só panorama)');
    console.log('   origem       n      ok    ERRO  ~parcela   vazio  c/itens   taxa');
    console.log(linha('IA', globais.IA));
    console.log(linha('local', globais.local));

    // ── 2. PAREADO: o mesmo arquivo lido pelas duas vias ────────────────────
    const melhor = { IA: 0, local: 0, igual: 0 };
    const exemplos = [];
    const rank = { ok: 3, parcela: 2, erro: 1, vazio: 0, 's/gab': 0 };
    for (const [arq, e] of porArquivo) {
        if (!e.IA.length || !e.local.length) continue;
        const bIA = Math.max(...e.IA.map(c => rank[c]));
        const bLo = Math.max(...e.local.map(c => rank[c]));
        if (bIA > bLo) { melhor.IA++; if (exemplos.length < 10) exemplos.push({ arq, ia: e.IA[0], lo: e.local[0], q: 'IA' }); }
        else if (bLo > bIA) { melhor.local++; if (exemplos.length < 10) exemplos.push({ arq, ia: e.IA[0], lo: e.local[0], q: 'local' }); }
        else melhor.igual++;
    }
    const tot = melhor.IA + melhor.local + melhor.igual;
    console.log(`\n2) PAREADO — mesmo arquivo lido pelas DUAS vias (${tot} arquivos)`);
    console.log(`   IA melhor:    ${melhor.IA}`);
    console.log(`   local melhor: ${melhor.local}`);
    console.log(`   empate:       ${melhor.igual}`);
    if (tot) console.log(`   líquido a favor da IA: ${melhor.IA - melhor.local > 0 ? '+' : ''}${melhor.IA - melhor.local}`);
    if (exemplos.length) {
        console.log('\n   exemplos:');
        for (const e of exemplos)
            console.log(`      ${e.q === 'IA' ? 'IA vence   ' : 'local vence'}  ia=${e.ia.padEnd(8)} local=${e.lo.padEnd(8)} ${e.arq.slice(0, 40)}`);
    }
    process.exit(0);
})();
