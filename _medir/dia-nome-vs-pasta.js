/**
 * _medir/dia-nome-vs-pasta.js — no GRAVADOR (process-folder.js), quem deve decidir
 * a data: o nome do arquivo ou a subpasta?
 *
 * A leitura (comparar-notas.js §15) já passou a preferir a PASTA, mas lá só o MÊS
 * importa. O gravador precisa do DIA — e aí a resposta pode ser outra: a pasta é
 * um dia só (a data de arquivamento), enquanto o nome traz a data do DOCUMENTO,
 * que é o que a conferência quer.
 *
 * Este script separa as duas perguntas:
 *   1. com que frequência nome e pasta discordam no DIA? e no MÊS?
 *   2. quando discordam no mês, qual dos dois é o implausível?
 *
 * A hipótese do defeito de §15 é que a discordância grande vem de dia/mês trocado
 * na digitação — e nesse caso o mês da PASTA é o certo mas o DIA do NOME também é
 * recuperável (basta desinverter).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const h = require('./harness');

// Cópias exatas das funções do gravador (process-folder.js:87-105).
function folderToDay(folder) {
    const mNew = folder.match(/(?:^|\/)(\d{4})\.(\d{2})\.(\d{2})(?:\/|$)/);
    if (mNew) return `${mNew[3]}.${mNew[2]}.${mNew[1]}`;
    const mOld = folder.match(/(?:^|\/)(\d{2})\.(\d{2})\.(\d{4})(?:\/|$)/);
    if (mOld) return `${mOld[1]}.${mOld[2]}.${mOld[3]}`;
    return null;
}
function filenameToDay(name) {
    const n = String(name || '');
    const mNew = n.match(/(?<!\d)(20\d{2})\.(\d{2})\.(\d{2})(?!\d)/);
    if (mNew) return `${mNew[3]}.${mNew[2]}.${mNew[1]}`;
    const mOld = n.match(/(?<!\d)(\d{2})\.(\d{2})\.(20\d{2})(?!\d)/);
    if (mOld) return `${mOld[1]}.${mOld[2]}.${mOld[3]}`;
    return null;
}
const mesDe = d => d ? d.slice(3) : null;

(async () => {
    const rota = h.internasDaRota();
    const raiz = process.env.ARQUIVO_PATH || process.env.MONITOR_PATH;
    const r = rota.contarNaPasta(raiz);

    let total = 0, soNome = 0, soPasta = 0, nenhum = 0;
    let diaIgual = 0, diaDifMesIgual = 0, mesDif = 0;
    const trocados = [], outros = [];

    for (const arqs of Object.values(r.arquivosPorMes)) {
        for (const a of arqs) {
            total++;
            // O gravador recebe a PASTA (dir), não o caminho com o arquivo.
            const dir = a.rel.replace(/[\/\\][^\/\\]*$/, '').replace(/\\/g, '/');
            const dn = filenameToDay(a.nome);
            const dp = folderToDay(dir);
            if (!dn && !dp) { nenhum++; continue; }
            if (dn && !dp) { soNome++; continue; }
            if (!dn && dp) { soPasta++; continue; }
            if (dn === dp) { diaIgual++; continue; }
            if (mesDe(dn) === mesDe(dp)) { diaDifMesIgual++; continue; }
            mesDif++;
            // dia/mês trocado: desinvertendo o nome, ele bate com a pasta?
            const [d1, m1, y1] = dn.split('.');
            const desinvertido = `${m1}.${d1}.${y1}`;
            (desinvertido === dp ? trocados : outros).push({ nome: a.nome, dir, dn, dp, desinvertido });
        }
    }

    console.log('=== DIA DO NOME × DIA DA PASTA (visão do gravador) ===\n');
    console.log(`  arquivos ........................... ${total}`);
    console.log(`  sem data em nenhum dos dois ........ ${nenhum}`);
    console.log(`  só o nome tem data ................. ${soNome}`);
    console.log(`  só a pasta tem data ................ ${soPasta}`);
    console.log(`  dia IGUAL nos dois ................. ${diaIgual}`);
    console.log(`  dia difere, mês IGUAL .............. ${diaDifMesIgual}   <- pasta perderia o dia certo`);
    console.log(`  **mês DIFERE** ..................... ${mesDif}`);
    console.log(`     ...dia/mês trocado (desinverter bate) . ${trocados.length}`);
    console.log(`     ...outra causa ........................ ${outros.length}`);

    console.log('\n  trocados (desinverter o nome dá exatamente a pasta):');
    for (const t of trocados.slice(0, 15))
        console.log(`    ${t.nome.slice(0, 60)}\n       nome=${t.dn}  pasta=${t.dp}  desinvertido=${t.desinvertido}`);

    console.log('\n  outras divergências de mês:');
    for (const o of outros.slice(0, 15))
        console.log(`    ${o.nome.slice(0, 60)}\n       nome=${o.dn}  pasta=${o.dp}`);

    fs.writeFileSync(path.join(__dirname, 'dia-divergente.txt'),
        [...trocados, ...outros].map(x => `${x.nome}\n   nome=${x.dn} pasta=${x.dp}`).join('\n\n'));
    console.log('\n[lista completa em _medir/dia-divergente.txt]');
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
