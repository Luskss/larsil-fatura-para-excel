/**
 * _medir/_passada-unica.js — a sequência das passadas custa pares?
 *
 * PERGUNTA (15/09/2026). Dois lançamentos de 03.2026 têm valor E entidade batendo com
 * um documento do próprio mês e mesmo assim não casam:
 *
 *   MINISTERIO DA JUSTICA  R$     78,09  × 007.DOC- ... MINISTERIO DA JUSTIÇA  (23 dias)
 *   ERPO TECNOLOGIA        R$ 10.296,20  × 133.DOC- ... ERPO. NFS 77 + BOL     (17 dias)
 *
 * Morrem no veto de 15 dias, que no MÊS CORRENTE não aceita `entidadeDispensa` — ela
 * vale só na passada vizinha.
 *
 * ── Por que NÃO é remedir o que §17 já reprovou ─────────────────────────────
 * A medição de 08/09/2026 testou QUANDO o veto se aplica:
 *
 *   relaxar em TODA passada   2.106 pares   piora 6
 *   relaxar só nas vizinhas   2.104 pares   piora 0   <- aplicada
 *
 * E o diagnóstico registrado em `dentroDaJanela` aponta a causa das 6 pioras, que
 * NÃO é o relaxamento: "a passada vizinha só recebe quem ficou pendente, afrouxar no
 * mês faz o lançamento fechar cedo com o documento pior, e o melhor nunca chega a
 * ser considerado" (LOCALIZA FAT 315637 em +1 × FAT 307515 no mês).
 *
 * Isso é defeito de SEQUÊNCIA, não de limiar. Se todos os documentos — do mês e das
 * vizinhas — entrarem numa passada só, `parear` ordena por FORÇA e o documento de
 * força 3 ganha independentemente da pasta em que está. É o mesmo argumento que
 * `conferirPeriodo` já usa para fundir os offsets vizinhos numa passada só em vez de
 * uma por offset.
 *
 * ── Variantes ───────────────────────────────────────────────────────────────
 *   A produção          duas passadas, dispensa só na vizinha   (baseline)
 *   B relaxar no mês    duas passadas, dispensa em ambas        (o que §17 reprovou)
 *   C passada única     mês + vizinhas juntos, dispensa ligada
 *   D passada única     mês + vizinhas juntos, dispensa DESLIGADA
 *
 * CRITÉRIO (o mesmo de §10, §12, §13 e §17): só passa se a cobertura subir SEM
 * derrubar a confirmação por 2º campo. Cobertura comprada com par errado é rejeitada.
 *
 * ══ VEREDITO (15/09/2026): C REPROVADA. Não reabrir sem ler isto. ══
 *
 * A tabela APROVA a passada única com folga:
 *
 *   variante                      pares   2º campo   fracos
 *   A produção                     2108     91,9%      171
 *   C passada única                2115     93,2%      143     +7 pares, +1,35pp
 *
 * E a inspeção dos 6 ganhos REPROVA:
 *
 *   ✓ ERPO TECNOLOGIA    R$ 10.296,20 × ERPO. NFS 77        força 2
 *   ✓ JESSICA SANTIELLE  R$  1.128,00 × JESSICA SANTIELLE   força 2
 *   ✓ IGUACU MAQUINAS    R$  1.582,30 × IGUACU . NF 89018   força 2
 *   ✗ LUIZ HENRIQUE      R$    100,00 × ADRIANO CIRILO      força 1
 *   ✗ BOA VISTA COMBUST. R$    100,00 × MEGA REDES FAT 902042  força 1
 *   ✗ JOHN LENON         R$    100,00 × MEGA REDES FAT 902042  força 1  (o MESMO doc!)
 *   ✗ HOTEL TENDA        R$    250,00 × PRATAO . NF 145773  força 1
 *
 * 3 bons por 4 falsos — líquido NEGATIVO. Os 4 são fornecedor diferente casado só
 * pelo valor, três deles em R$ 100,00: assinatura de colisão de valor redondo.
 *
 * Por que o índice enganou: "2º campo" é a PROPORÇÃO de pares com dois sinais. A
 * passada única reorganizou pares que já existiam — 28 acharam documento melhor e
 * deixaram de ser fracos —, e essa melhora real mascarou os 4 pares novos ruins. A
 * média subiu enquanto a margem piorava. Ver [[media-agregada-esconde-par-falso]].
 *
 * O script fica aqui para que a variante não seja remedida: rode-o e leia os DELTAS,
 * não a tabela.
 *
 * ── Limite desta medição ────────────────────────────────────────────────────
 * `variantes.js` REIMPLEMENTA o motor e seu `dentroDaJanela` não tem `entidadeDispensa`
 * — ou seja, ele nunca modelou a regra que está em produção. Por isso este script NÃO
 * o usa: chama o `_pareamento.js` REAL, e implementa só a variação de sequência.
 * Um ganho aqui ainda precisa ser reprovado no motor de produção antes de virar código.
 *
 * SOMENTE LEITURA.
 *
 * Uso: node _medir/_passada-unica.js
 */
'use strict';
const h = require('./harness');
const p = require('../routes/_pareamento');
const { indexar } = require('./ocr');

const PERIODOS = h.PERIODOS;

// Reproduz `conferirPeriodo` da produção, com a sequência parametrizável.
function conferir(lancamentos, docsPorMes, periodo, modo) {
    const doMes = docsPorMes[periodo] || [];
    const docsViz = [];
    for (const off of p.VIZINHANCA) {
        const alvo = p.deslocarPeriodo(periodo, off);
        for (const d of (docsPorMes[alvo] || []))
            docsViz.push({ ...d, periodoDocumento: alvo, deslocamento: off });
    }

    if (modo.passadaUnica) {
        // TODOS os documentos numa passada só; a força decide, não a pasta.
        const todos = [...doMes.map(d => ({ ...d, periodoDocumento: periodo, deslocamento: 0 })), ...docsViz];
        const r = p.parear(lancamentos, todos, modo.dispensa);
        const noMes = r.pares.filter(x => x.documento.deslocamento === 0);
        const viz   = r.pares.filter(x => x.documento.deslocamento !== 0);
        const casados = new Set(r.pares.map(x => x.lancamento));
        return {
            pares: noMes, paresVizinhos: viz,
            semDocumento: lancamentos.filter(l => !casados.has(l)).length,
            todos: r.pares,
        };
    }

    // Duas passadas, como a produção.
    const noMes = p.parear(lancamentos, doMes, modo.dispensaNoMes);
    const casados = new Set(noMes.pares.map(x => x.lancamento));
    const pendentes = lancamentos.filter(l => !casados.has(l));
    const rv = p.parear(pendentes, docsViz, true);
    const casadosViz = new Set(rv.pares.map(x => x.lancamento));
    return {
        pares: noMes.pares, paresVizinhos: rv.pares,
        semDocumento: pendentes.filter(l => !casadosViz.has(l)).length,
        todos: [...noMes.pares, ...rv.pares],
    };
}

// 2º campo: quantos pares têm ao menos DOIS sinais concordando. É a métrica que
// impede cobertura de subir às custas de par errado.
function qualidade(pares) {
    let conf = 0;
    for (const x of pares) if ((x.forca || 0) >= 2) conf++;
    return { n: pares.length, conf, pc: pares.length ? conf / pares.length : 0 };
}

const VARIANTES = [
    ['A produção (2 passadas, dispensa só vizinha)', { passadaUnica: false, dispensaNoMes: false }],
    ['B 2 passadas, dispensa em AMBAS  (§17 reprovou)', { passadaUnica: false, dispensaNoMes: true }],
    ['C passada ÚNICA, dispensa ligada', { passadaUnica: true, dispensa: true }],
    ['D passada ÚNICA, dispensa desligada', { passadaUnica: true, dispensa: false }],
];

(async () => {
    const c = h.carregar();
    console.error('[passada-unica] reindexando...');
    const idx = await indexar();

    const res = [];
    for (const [nome, modo] of VARIANTES) {
        let conferidos = 0, lancs = 0, semDoc = 0, fracos = 0;
        const todosPares = [];
        const porPeriodo = [];
        for (const periodo of PERIODOS) {
            const lista = ((c.planilha[periodo] || {}).itens || []).map(p.lancamentoDaPlanilha);
            const docsPorMes = {};
            for (const off of [0, ...p.VIZINHANCA]) {
                const alvo = p.deslocarPeriodo(periodo, off);
                docsPorMes[alvo] = (c.pasta.arquivosPorMes[alvo] || []).map(a =>
                    p.enriquecerComOcr(p.documentoDoArquivo(a.nome, a.rel), idx[a.nome]));
            }
            const r = conferir(lista, docsPorMes, periodo, modo);
            lancs += lista.length;
            conferidos += r.todos.length;
            semDoc += r.semDocumento;
            fracos += r.todos.filter(x => (x.forca || 0) === 1).length;
            todosPares.push(...r.todos);
            porPeriodo.push({ periodo, conferidos: r.todos.length, semDoc: r.semDocumento });
        }
        const q = qualidade(todosPares);
        res.push({ nome, lancs, conferidos, semDoc, fracos, q, porPeriodo, todosPares });
    }

    const base = res[0];
    console.log('\nCritério: cobertura sobe E 2º campo não cai.\n');
    console.log('variante                                          pares  cob%   semDoc  2ºcampo  fracos      Δ');
    for (const r of res) {
        const d = r.conferidos - base.conferidos;
        const dq = (r.q.pc - base.q.pc) * 100;
        console.log(
            `${r.nome.padEnd(48)} ${String(r.conferidos).padStart(5)}` +
            ` ${(100 * r.conferidos / r.lancs).toFixed(1).padStart(6)}` +
            ` ${String(r.semDoc).padStart(7)}` +
            ` ${(100 * r.q.pc).toFixed(1).padStart(7)}%` +
            ` ${String(r.fracos).padStart(6)}` +
            `  ${d >= 0 ? '+' : ''}${d} pares, 2ºcampo ${dq >= 0 ? '+' : ''}${dq.toFixed(2)}pp`);
    }

    // quem ganhou e quem perdeu, par a par, contra a produção
    const chave = x => `${x.lancamento.entidade}|${x.lancamento.nf}|${x.lancamento.valor}`;
    const baseSet = new Map(base.todosPares.map(x => [chave(x), x]));
    for (const r of res.slice(1)) {
        const set = new Map(r.todosPares.map(x => [chave(x), x]));
        const ganhou = [...set.keys()].filter(k => !baseSet.has(k));
        const perdeu = [...baseSet.keys()].filter(k => !set.has(k));
        console.log(`\n── ${r.nome}`);
        console.log(`   GANHOU ${ganhou.length}   PERDEU ${perdeu.length}`);
        for (const k of ganhou.slice(0, 8)) {
            const x = set.get(k);
            console.log(`      + ${k.slice(0, 54)}  força=${x.forca} via=${x.via}`);
        }
        for (const k of perdeu.slice(0, 8)) {
            const x = baseSet.get(k);
            console.log(`      - ${k.slice(0, 54)}  força=${x.forca} via=${x.via}`);
        }
    }
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
