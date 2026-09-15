/**
 * _medir/_confianca-tela.js — em que cada par ENCONTRADO se apoia, e quanto isso
 * vale em reais.
 *
 * A pergunta que originou este medidor: "é certeza que o documento da pasta 04 foi
 * lançado como mês 3?". A resposta depende do par: com os três sinais (número,
 * fornecedor e valor) é certeza; só com o valor, não é. O painel mostrava os dois
 * casos idênticos, e este script é o número que justifica passar a distingui-los.
 *
 * Roda a ROTA REAL (`routes/comparar-notas.js`) em vez de reimplementar o
 * pareamento — medir uma cópia mede a cópia, não o que a tela recebe.
 *
 * Serve a três coisas:
 *   1. TESTE DE REGRESSÃO — as invariantes abaixo têm de fechar antes e depois de
 *      qualquer mudança de apresentação. Se uma quebrar, a mudança deixou de ser
 *      de apresentação e precisa de medição própria.
 *   2. LINHA-BASE — a distribuição por força fica registrada aqui. Se ela mudar sem
 *      que alguém tenha mexido de propósito em `casa()`/`forcaDoPar()`, é regressão.
 *   3. EVIDÊNCIA — a amostra final lista os pares frágeis com nome de arquivo, que é
 *      o material de conferência humana.
 *
 * Uso: node _medir/_confianca-tela.js [mesInicial] [mesFinal] [ano]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const RAIZ = path.join(__dirname, '..');

// .env sem dotenv (não está instalado) — mesmo loader do harness.
for (const linha of fs.readFileSync(path.join(RAIZ, '.env'), 'utf8').split(/\r?\n/)) {
    const m = linha.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(m[1] in process.env)) process.env[m[1]] = v;
}

const rota = require(path.join(RAIZ, 'routes', 'comparar-notas.js'));

function conferir(mes, ano) {
    return new Promise((resolve, reject) => {
        const req = { method: 'POST', query: {}, body: { mes, ano }, headers: {}, session: { cf_loggedIn: true } };
        const res = {
            statusCode: 200, setHeader() {}, set() {},
            status(c) { this.statusCode = c; return this; },
            json(o) { this.statusCode === 200 ? resolve(o) : reject(new Error(`HTTP ${this.statusCode}`)); },
        };
        rota(req, res).catch(reject);
    });
}

const brl = v => `R$ ${(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pc = (n, d) => d ? `${(n / d * 100).toFixed(1)}%` : '—';

// ── As invariantes ───────────────────────────────────────────────────────────
// Toda mudança de EXIBIÇÃO tem de manter as sete. A 6 é a mais útil: se a via e a
// força discordarem, ou `casa()` mudou ou o transporte perdeu um campo pelo caminho.
function invariantes(o) {
    const c = o.conferencia || {};
    const enc = c.encontradas || [];
    const soma = obj => Object.values(obj || {}).reduce((a, b) => a + b, 0);
    const falhas = [];
    const conf = (nome, ok, detalhe) => { if (!ok) falhas.push(`${nome}: ${detalhe}`); };

    conf('1 noMes+vizinhas===conferidos',
        (c.noMes || 0) + (c.emPastaVizinha || 0) === c.conferidos,
        `${c.noMes}+${c.emPastaVizinha} != ${c.conferidos}`);
    conf('2 encontradas===conferidos',
        enc.length === c.conferidos, `${enc.length} != ${c.conferidos}`);
    conf('3 forca===1 conta o mesmo que c.fracos',
        enc.filter(l => l.forca === 1).length === c.fracos,
        `${enc.filter(l => l.forca === 1).length} != ${c.fracos}`);
    // 4 só passa a valer quando `empatado` existir na linha (peça 2 do plano).
    if (enc.some(l => l.empatado !== undefined))
        conf('4 empatado na linha === c.empatados',
            enc.filter(l => l.empatado).length === c.empatados,
            `${enc.filter(l => l.empatado).length} != ${c.empatados}`);
    conf('5 soma(porVia)===soma(porSituacao)===conferidos',
        soma(c.porVia) === c.conferidos && soma(c.porSituacao) === c.conferidos,
        `via ${soma(c.porVia)} / sit ${soma(c.porSituacao)} != ${c.conferidos}`);
    const viaForca = enc.filter(l =>
        (l.via === 'numero+entidade+valor') !== (l.forca === 3)
        || (l.via === 'valor' && l.forca !== 1));
    conf('6 via coerente com forca', viaForca.length === 0,
        `${viaForca.length} linhas incoerentes (ex: via=${viaForca[0]?.via} forca=${viaForca[0]?.forca})`);
    conf('7 toda linha com forca definida',
        enc.every(l => l.forca !== undefined),
        `${enc.filter(l => l.forca === undefined).length} sem forca`);
    return falhas;
}

(async () => {
    const mi = Number(process.argv[2] || 1);
    const mf = Number(process.argv[3] || 6);
    const ano = Number(process.argv[4] || 2026);

    const tot = { enc: 0, valor: 0, forca: { 1: 0, 2: 0, 3: 0 }, valorForca: { 1: 0, 2: 0, 3: 0 },
                  via: {}, cruz: {}, empCru: 0, empLinha: 0, empLista: 0, conferir: 0, valorConferir: 0 };
    const amostra = [];
    let falhasTotais = 0;

    for (let mes = mi; mes <= mf; mes++) {
        let o;
        try { o = await conferir(mes, ano); }
        catch (e) { console.log(`${String(mes).padStart(2, '0')}.${ano}: ERRO ${e.message}`); continue; }
        const c = o.conferencia || {};
        const enc = c.encontradas || [];

        const falhas = invariantes(o);
        falhasTotais += falhas.length;
        console.log(`\n${o.periodo}: ${enc.length} encontradas` +
                    (falhas.length ? `   ${falhas.length} INVARIANTE(S) FALHOU` : '   invariantes OK'));
        for (const f of falhas) console.log(`     FALHOU ${f}`);

        for (const l of enc) {
            const f = l.forca || 0;
            tot.enc++; tot.valor += (l.valor || 0);
            if (tot.forca[f] !== undefined) { tot.forca[f]++; tot.valorForca[f] += (l.valor || 0); }
            tot.via[l.via || '?'] = (tot.via[l.via || '?'] || 0) + 1;

            const desl = l.deslocamento ? `vizinha ${l.deslocamento > 0 ? '+' : ''}${l.deslocamento}` : 'no mês';
            const k = `${desl} × ${f} ${f > 1 ? 'sinais' : 'sinal'}`;
            tot.cruz[k] = (tot.cruz[k] || 0) + 1;

            if (l.empatado) tot.empLinha++;
            // "Merece conferência" = apoiado num sinal só, OU disputado por outro
            // documento de força igual. É a definição que o filtro da tela usa.
            if (f === 1 || l.empatado) {
                tot.conferir++; tot.valorConferir += (l.valor || 0);
                amostra.push({ mes, l });
            }
        }
        tot.empLista += (c.empatados || 0);
    }

    console.log(`\n${'='.repeat(74)}`);
    console.log(`LINHA-BASE  ${String(mi).padStart(2, '0')}–${String(mf).padStart(2, '0')}/${ano}`);
    console.log('='.repeat(74));
    console.log(`\nencontradas: ${tot.enc}   valor: ${brl(tot.valor)}`);

    console.log('\n── em que o par se apoia ──');
    for (const f of [3, 2, 1]) {
        const rot = { 3: '3 sinais (nº+fornecedor+valor)', 2: '2 sinais', 1: 'SÓ VALOR' }[f];
        console.log(`  ${rot.padEnd(32)} ${String(tot.forca[f]).padStart(5)}  ${pc(tot.forca[f], tot.enc).padStart(6)}   ` +
                    `${brl(tot.valorForca[f]).padStart(20)}  ${pc(tot.valorForca[f], tot.valor).padStart(6)} do valor`);
    }

    console.log('\n── por via ──');
    for (const [k, v] of Object.entries(tot.via).sort((a, b) => b[1] - a[1]))
        console.log(`  ${k.padEnd(32)} ${String(v).padStart(5)}  ${pc(v, tot.enc).padStart(6)}`);

    console.log('\n── origem × força ──');
    for (const [k, v] of Object.entries(tot.cruz).sort((a, b) => b[1] - a[1]))
        console.log(`  ${k.padEnd(32)} ${String(v).padStart(5)}  ${pc(v, tot.enc).padStart(6)}`);

    console.log('\n── empate ──');
    console.log(`  marcados na LINHA (já sem carnê) ${String(tot.empLinha).padStart(5)}`);
    console.log(`  somados da lista c.empatados     ${String(tot.empLista).padStart(5)}`);
    if (tot.empLinha === 0)
        console.log('  (a linha ainda não carrega `empatado` — peça 2 do plano)');
    else if (tot.empLinha !== tot.empLista)
        console.log('  DIVERGEM: `ehParcela` provavelmente foi aplicado num lado só.');

    console.log('\n── merecem conferência (forca===1 OU empatado) ──');
    console.log(`  ${tot.conferir} pares  ${pc(tot.conferir, tot.enc)} dos achados   ` +
                `${brl(tot.valorConferir)}  ${pc(tot.valorConferir, tot.valor)} do valor`);

    console.log('\n── os 15 maiores, para conferir no olho ──');
    amostra.sort((a, b) => Math.abs(b.l.valor || 0) - Math.abs(a.l.valor || 0));
    for (const { mes, l } of amostra.slice(0, 15)) {
        const desl = l.deslocamento ? `${l.deslocamento > 0 ? '+' : ''}${l.deslocamento}` : ' 0';
        console.log(`  ${String(mes).padStart(2, '0')}/${ano} ${brl(l.valor).padStart(18)}  ${desl}  ` +
                    `${String(l.forca) + ' sinal'}  ${String(l.via || '').padEnd(22)}${l.empatado ? ' [empatado]' : ''}`);
        console.log(`         planilha: ${String(l.fornecedor || '').slice(0, 46)}`);
        console.log(`         arquivo : ${String(l.arquivo || '').slice(0, 66)}`);
    }

    console.log(`\n${falhasTotais ? `*** ${falhasTotais} INVARIANTE(S) FALHOU ***` : 'todas as invariantes fecharam'}`);
    process.exit(falhasTotais ? 1 : 0);
})();
