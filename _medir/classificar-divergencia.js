/**
 * _medir/classificar-divergencia.js — as 144 divergências de mês, por CAUSA.
 *
 * A medição anterior mostrou que a escolha "nome ou pasta" é grosseira demais para
 * o gravador: 644 arquivos têm o DIA certo só no nome (mês concordando), então
 * preferir a pasta cegamente perderia precisão de dia.
 *
 * A correção certa é cirúrgica: consertar só o que está comprovadamente errado.
 * Este script separa as 144 em causas, para saber qual regra aplicar a cada uma.
 */
'use strict';
const h = require('./harness');

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
const parse = d => { const [dd, mm, yy] = d.split('.').map(Number); return { dd, mm, yy }; };
const distMeses = (a, b) => (a.yy * 12 + a.mm) - (b.yy * 12 + b.mm);

(async () => {
    const rota = h.internasDaRota();
    const r = rota.contarNaPasta(process.env.ARQUIVO_PATH || process.env.MONITOR_PATH);

    const cls = { trocado: [], anoErrado: [], anoEDia: [], plausivel: [], resto: [] };
    for (const arqs of Object.values(r.arquivosPorMes)) {
        for (const a of arqs) {
            const dir = a.rel.replace(/[\/\\][^\/\\]*$/, '').replace(/\\/g, '/');
            const dn = filenameToDay(a.nome), dp = folderToDay(dir);
            if (!dn || !dp || dn === dp) continue;
            const n = parse(dn), p = parse(dp);
            if (n.mm === p.mm && n.yy === p.yy) continue;   // só o dia difere

            const item = { nome: a.nome, dn, dp, dist: distMeses(n, p) };
            // (1) dia/mês trocado na digitação
            if (n.dd === p.mm && n.mm === p.dd && n.yy === p.yy) { cls.trocado.push(item); continue; }
            // (2) ano errado, dia e mês idênticos
            if (n.dd === p.dd && n.mm === p.mm && n.yy !== p.yy) { cls.anoErrado.push(item); continue; }
            // (3) ano errado E dia diferente, mesmo mês
            if (n.mm === p.mm && n.yy !== p.yy) { cls.anoEDia.push(item); continue; }
            // (4) documento genuinamente de outro mês (conta antiga paga agora)
            if (item.dist < 0 && item.dist >= -3) { cls.plausivel.push(item); continue; }
            cls.resto.push(item);
        }
    }

    const tot = Object.values(cls).reduce((n, a) => n + a.length, 0);
    console.log('=== AS DIVERGÊNCIAS DE MÊS, POR CAUSA ===\n');
    console.log(`  total ................................... ${tot}`);
    console.log(`  (1) dia/mês TROCADO ..................... ${cls.trocado.length}  -> corrigir: usar a pasta`);
    console.log(`  (2) ANO errado, dia+mês iguais .......... ${cls.anoErrado.length}  -> corrigir: usar o ano da pasta`);
    console.log(`  (3) ano errado, mesmo mês, dia difere ... ${cls.anoEDia.length}`);
    console.log(`  (4) doc de mês anterior, ≤3 meses ....... ${cls.plausivel.length}  -> LEGÍTIMO, não mexer`);
    console.log(`  (5) resto ............................... ${cls.resto.length}`);

    for (const [k, titulo] of [['anoErrado', '(2) ANO errado'], ['plausivel', '(4) legítimo'], ['resto', '(5) resto']]) {
        console.log(`\n  ${titulo}:`);
        for (const x of cls[k].slice(0, 12))
            console.log(`    ${x.nome.slice(0, 58).padEnd(58)} nome=${x.dn} pasta=${x.dp} (${x.dist >= 0 ? '+' : ''}${x.dist}m)`);
        if (cls[k].length > 12) console.log(`    ... +${cls[k].length - 12}`);
    }
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
