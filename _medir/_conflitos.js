/**
 * _medir/_conflitos.js — o que faz DUAS entradas conflitarem, e quantas dessas
 * "conflitam" de mentira.
 *
 * A pergunta que originou este medidor: "o que acontece para conflitar entradas".
 * Medindo, a lista de empates tinha duas coisas diferentes dentro:
 *   - CARNÊ: os arquivos SOMAM o lançamento — são as parcelas do mesmo pagamento,
 *     não papéis concorrentes. Listá-los manda conferir o que está certo.
 *   - COLISÃO: papéis distintos com o mesmo valor. Esse é o conflito de verdade,
 *     e medido não tem desempate automático disponível (ver abaixo).
 *
 * Roda a ROTA REAL (`routes/comparar-notas.js`) em vez de reimplementar — medir uma
 * cópia mede a cópia, não o que a tela recebe.
 *
 * O PORQUÊ DE NÃO TENTAR DESEMPATAR (medido jan–jun/2026, 207 colisões reais):
 *   - a NF do lançamento aparece em UM só arquivo:  6 de 207 (e em 4 já é o escolhido)
 *   - a NF não aparece em arquivo NENHUM:         165 de 207 (80%)
 * Os 165 são recibos e avulsos cujo "nf" na planilha é número interno (903418…) que
 * nunca esteve no papel. Não há sinal a extrair. Isso confirma a medição de
 * 08/09/2026, que já reprovou desempate automático em 61 casos.
 *
 * INVARIANTES — se uma quebrar, a mudança deixou de ser classificação e virou
 * mudança de pareamento, que precisa de medição própria.
 *
 * Uso: node _medir/_conflitos.js [mesInicial] [mesFinal] [ano]
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

const brl = v => `R$ ${(Math.abs(v) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pc = (n, d) => d ? `${(n / d * 100).toFixed(1)}%` : '—';

(async () => {
    const mi = Number(process.argv[2] || 1);
    const mf = Number(process.argv[3] || 6);
    const ano = Number(process.argv[4] || 2026);

    const tot = { emp: 0, parc: 0, motivos: {}, comMotivo: 0 };
    const falhas = [];
    const carnes = [];

    for (let mes = mi; mes <= mf; mes++) {
        let o;
        try { o = await conferir(mes, ano); }
        catch (e) { console.log(`${String(mes).padStart(2, '0')}.${ano}: ERRO ${e.message}`); continue; }
        const c = o.conferencia || {};
        const enc = c.encontradas || [];
        const emp = c.empatados || 0;
        const parc = c.empatadosParcela || 0;

        // ── INVARIANTE A: o flag da linha conta o mesmo que a lista ──────────────
        // Se `ehParcelamento` valesse só num dos dois lados, a tabela mostraria mais
        // linhas ambíguas do que a lista de empates diz existir — dois números
        // discordando na mesma tela. É a armadilha principal desta mudança.
        const naLinha = enc.filter(l => l.empatado).length;
        if (naLinha !== emp)
            falhas.push(`${o.periodo} A: empatado na linha ${naLinha} != c.empatados ${emp}`);

        // ── INVARIANTE B: nenhum empate evaporou ────────────────────────────────
        // Reclassificar move o empate de coluna; não pode fazê-lo sumir.
        //
        // `empatadosBruto` é soma das duas colunas, então comparar com ele seria
        // circular. A referência independente é `pareamento.empatados`, contado por
        // `parear()` em _pareamento.js, que não conhece `ehParcelamento`: se os dois
        // discordarem, um par empatado deixou de ser visto pela classificação.
        const bruto = c.empatadosBruto;
        const doMotor = o.pareamento && o.pareamento.empatados;
        if (bruto != null && emp + parc !== bruto)
            falhas.push(`${o.periodo} B: ${emp}+${parc} != bruto ${bruto} — empate sumiu`);
        if (doMotor != null && bruto != null && doMotor !== bruto)
            falhas.push(`${o.periodo} B2: motor contou ${doMotor}, classificação viu ${bruto}`);
        if (doMotor == null && mes === mi)
            console.log('  (aviso: a rota não expõe pareamento.empatados — B2 não roda)');

        // ── INVARIANTE C: todo carnê classificado realmente SOMA o lançamento ────
        // Verifica a definição em cima da lista publicada: nenhum item que ficou na
        // lista pode ter soma fechando (senão devia ter saído como parcela).
        for (const l of c.listaEmpatados || []) {
            if (!l.motivo) continue;
            tot.comMotivo++;
            const k = l.motivo.codigo || l.motivo;
            tot.motivos[k] = (tot.motivos[k] || 0) + 1;
        }

        tot.emp += emp; tot.parc += parc;
        console.log(`${o.periodo}: ${String(emp).padStart(3)} conflitos   ${String(parc).padStart(3)} parcelas fora da lista` +
                    (bruto != null ? `   (bruto ${bruto})` : ''));
    }

    console.log(`\n${'='.repeat(72)}`);
    console.log(`LINHA-BASE  ${String(mi).padStart(2, '0')}–${String(mf).padStart(2, '0')}/${ano}`);
    console.log('='.repeat(72));
    console.log(`\nconflitos listados : ${tot.emp}`);
    console.log(`parcelas descontadas: ${tot.parc}`);
    console.log(`total bruto de empates: ${tot.emp + tot.parc}`);

    if (tot.comMotivo) {
        console.log('\n── por que empatou ──');
        for (const [k, v] of Object.entries(tot.motivos).sort((a, b) => b[1] - a[1]))
            console.log(`  ${String(v).padStart(4)}  ${pc(v, tot.comMotivo).padStart(6)}  ${k}`);
    } else {
        console.log('\n(as linhas ainda não trazem `motivo` — peça 4 do plano)');
    }

    console.log(`\n${falhas.length ? `*** ${falhas.length} INVARIANTE(S) FALHOU ***` : 'todas as invariantes fecharam'}`);
    for (const f of falhas) console.log(`  FALHOU ${f}`);
    process.exit(falhas.length ? 1 : 0);
})();
