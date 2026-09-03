/**
 * _medir/numero-extrator.js — o número deve vir do EXTRATOR, não do nome.
 *
 * Observação do usuário: a intenção do projeto sempre foi puxar o número da nota
 * do extrator (o `dados_parser` que o scheduler grava), não do nome do arquivo
 * digitado à mão.
 *
 * Como está hoje (`enriquecerComOcr`): o nome tem PRECEDÊNCIA — o número do OCR só
 * preenche `numeroDig` quando o nome não trouxe nenhum; senão vira `numeroAlt`.
 * Como `numeroBate` testa os DOIS, a precedência não muda quem casa... exceto em
 * um ponto: quando os dois existem e são diferentes, ambos entram como chave, o
 * que pode casar por um número que o extrator contradiz.
 *
 * Mede três coisas:
 *   1. com que frequência nome e extrator discordam do número;
 *   2. quando discordam, qual dos dois é o que casa com a planilha (= quem acerta);
 *   3. inverter a precedência muda o resultado?
 */
'use strict';
const h = require('./harness');
const par = require('../routes/_pareamento');
const v = require('./variantes');
const ocrMod = require('./ocr');

const soDig = s => String(s || '').replace(/\D/g, '');

(async () => {
    const c = h.carregar();
    const rota = h.internasDaRota();
    const { getConnection } = require('../config');
    const pool = await getConnection();
    const rs = await pool.request().input('tipo', 'M')
        .query('SELECT CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO = @tipo');
    const idx = rota.contarNoCsv(rs.recordset.map(r => r.CONTEUDO)).ocrPorArquivo || {};

    // ── 1. Nome × extrator, nos documentos dos 6 períodos ───────────────────
    let comNome = 0, comOcr = 0, ambos = 0, iguais = 0, difer = 0, soOcr = 0, nenhum = 0;
    const vistos = new Set();
    for (const periodo of h.PERIODOS) {
        for (const off of [0, ...par.VIZINHANCA]) {
            const alvo = par.deslocarPeriodo(periodo, off);
            for (const a of (c.pasta.arquivosPorMes[alvo] || [])) {
                if (vistos.has(a.nome)) continue;
                vistos.add(a.nome);
                const nNome = soDig(par.numeroDoNome(a.nome));
                const nOcr = soDig((idx[a.nome] || {}).numero);
                if (nNome) comNome++;
                if (nOcr) comOcr++;
                if (nNome && nOcr) { ambos++; nNome === nOcr ? iguais++ : difer++; }
                else if (!nNome && nOcr) soOcr++;
                else if (!nNome && !nOcr) nenhum++;
            }
        }
    }
    console.log('=== NÚMERO: NOME DO ARQUIVO × EXTRATOR ===\n');
    console.log(`  documentos distintos ......... ${vistos.size}`);
    console.log(`  número no nome ............... ${comNome}`);
    console.log(`  número no extrator ........... ${comOcr}`);
    console.log(`  nos dois ..................... ${ambos}`);
    console.log(`     ...idênticos .............. ${iguais}`);
    console.log(`     ...**diferentes** ......... ${difer}`);
    console.log(`  só no extrator ............... ${soOcr}   <- hoje já são usados`);
    console.log(`  em nenhum dos dois ........... ${nenhum}`);

    // ── 2. Quando discordam, quem acerta? ───────────────────────────────────
    // Para cada par CASADO, ver se o número que bate com a planilha veio do nome
    // ou do extrator.
    let venceuNome = 0, venceuOcr = 0, venceramAmbos = 0;
    const exemplos = [];
    for (const periodo of h.PERIODOS) {
        const lancs = ((c.planilha[periodo] || {}).itens || []).map(par.lancamentoDaPlanilha);
        const documentosPorMes = {};
        for (const off of [0, ...par.VIZINHANCA]) {
            const alvo = par.deslocarPeriodo(periodo, off);
            documentosPorMes[alvo] = (c.pasta.arquivosPorMes[alvo] || []).map(a =>
                par.enriquecerComOcr(par.documentoDoArquivo(a.nome, a.rel), idx[a.nome]));
        }
        const r = par.conferirPeriodo(lancs, documentosPorMes, periodo);
        for (const p of [...r.pares, ...r.paresVizinhos]) {
            const nNome = soDig(par.numeroDoNome(p.documento.arquivo));
            const nOcr = soDig((idx[p.documento.arquivo] || {}).numero);
            if (!nNome || !nOcr || nNome === nOcr) continue;
            const alvo = p.lancamento.nfDig;
            const bateNome = alvo === nNome || alvo === String(Number(nNome || '0'));
            const bateOcr = alvo === nOcr || alvo === String(Number(nOcr || '0'));
            if (bateNome && bateOcr) venceramAmbos++;
            else if (bateNome) {
                venceuNome++;
                if (exemplos.length < 10) exemplos.push(
                    `  NOME acerta:     planilha ${alvo}  nome=${nNome}  extrator=${nOcr}\n` +
                    `     ${p.documento.arquivo.slice(0, 66)}`);
            } else if (bateOcr) {
                venceuOcr++;
                if (exemplos.length < 10) exemplos.push(
                    `  EXTRATOR acerta: planilha ${alvo}  nome=${nNome}  extrator=${nOcr}\n` +
                    `     ${p.documento.arquivo.slice(0, 66)}`);
            }
        }
    }
    console.log('\n=== NOS PARES CASADOS, QUANDO OS DOIS DISCORDAM ===\n');
    console.log(`  o número do NOME é o que bate ...... ${venceuNome}`);
    console.log(`  o número do EXTRATOR é o que bate .. ${venceuOcr}`);
    console.log(`  os dois batem ...................... ${venceramAmbos}`);
    console.log('\n' + exemplos.join('\n'));

    // ── 3. Inverter a precedência muda o total? ─────────────────────────────
    console.log('\n=== INVERTER A PRECEDÊNCIA ===\n');
    const OPT = { ocr: true, minDigitosNum: 1 };
    for (const [nome, opt] of [
        ['nome primeiro (produção)', OPT],
        ['EXTRATOR primeiro',        { ...OPT, ocrPrimeiro: true }],
        ['EXTRATOR primeiro, piso 2',  { ...OPT, ocrPrimeiro: true, minDigitosNum: 2 }],
    ]) {
        const linhas = v.rodar(c, idx, opt);
        const s = v.resumir(linhas), q = v.qualidade(linhas);
        console.log(`${nome.padEnd(28)} pares=${String(s.conferidos).padStart(5)}` +
            `  cob=${(s.cobertura * 100).toFixed(1)}%` +
            `  2ºcampo=${(q.pcConfirmado * 100).toFixed(1)}%`);
    }
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
