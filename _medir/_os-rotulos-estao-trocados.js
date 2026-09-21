/**
 * _medir/_os-rotulos-estao-trocados.js — a variante C foi aprovada com rótulo invertido?
 *
 * SUSPEITA (21/09/2026): `_tipobate-simetrico.js:143` classifica o alerta assim:
 *
 *     const classe = tn === gab ? 'falso' : (tn === lido ? 'real' : 'mudo');
 *
 * onde `tn` = tipo pelo NOME, `gab` = tipo pela PLANILHA, `lido` = tipo pelo BANCO.
 *
 * Um ALERTA existe quando banco ≠ planilha. A pergunta do alerta é: "quem errou?".
 * A terceira testemunha (o nome) desempata:
 *
 *   • nome == PLANILHA  → nome e planilha contra o banco → o BANCO errou
 *                          → o alerta APONTA UM ERRO REAL → deveria ser 'real'
 *   • nome == BANCO     → nome e banco contra a planilha → a PLANILHA generalizou
 *                          → o alerta é FALSO → deveria ser 'falso'
 *
 * O script faz o CONTRÁRIO. Se a inversão for real, então:
 *   - "147 falsos mortos por 1 cegado" pode ser "1 falso morto por 147 cegados"
 *   - a variante C, JÁ IMPLANTADA em _baseline.js, estaria escondendo erro real
 *
 * ── Como decidir sem depender do meu próprio raciocínio ─────────────────────
 * Vou aos DOCUMENTOS. Para a família que a variante C absolve
 * (planilha=NF/NFS × banco=FATURA, com acessório no nome), leio a EVIDÊNCIA — o
 * marcador que o parser achou NO PAPEL. Ela não participa nem do nome nem da
 * planilha: é testemunha independente das duas.
 *
 *   se o papel diz FATURA/BOLETO → o banco leu certo → alerta FALSO → C está certa
 *   se o papel diz DANFE/NFS-E   → o banco errou     → alerta REAL  → C cega erro
 *
 * SOMENTE LEITURA.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const h = require('./harness');

const pct = (a, b) => b ? `${(100 * a / b).toFixed(1)}%` : '—';
const norm = s => String(s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
const base = s => String(s || '').replace(/#p\d+$/i, '');
const ACESSORIO_RE = /\+\s*(BOL|BOLETO|AUT|AUTORIZACAO|PV|COMP|COMPROVANTE)\b|\bBOL\b\s*$/;
const temAcessorio = n => ACESSORIO_RE.test(norm(n));

function tipoDoNome(nome) {
    const t = norm(nome);
    if (/\bNFS-?E?\b/.test(t))                 return 'NFS';
    if (/\bNF-?E?\b|\bNOTA FISCAL\b/.test(t))  return 'NF';
    if (/\bFAT\b|\bFATURA\b|\bFT\b/.test(t))   return 'FATURA';
    if (/\bCT-?E\b|\bDACTE\b/.test(t))         return 'CTE';
    if (/\bRCB\b|\bRECIBO\b|\bREC\b/.test(t))  return 'RECIBO';
    if (/\bDARF\b|\bGPS\b|\bGUIA\b|\bFGTS\b|\bINSS\b/.test(t)) return 'IMPOSTO';
    return '';
}

(async () => {
    const idx = JSON.parse(fs.readFileSync(path.join(h.CACHE, 'tipo-por-arquivo.json'), 'utf8'));
    const docs = new Map();
    for (const [arq, info] of Object.entries(idx)) if (!docs.has(base(arq))) docs.set(base(arq), info);

    console.log('═'.repeat(74));
    console.log('A EVIDÊNCIA JULGA A VARIANTE C');
    console.log('═'.repeat(74));
    console.log('\nA zona da variante C: banco=FATURA + acessório no nome.');
    console.log('Se o banco leu certo, o papel deve mostrar marcador de fatura/boleto.\n');

    // a zona de ação da variante C
    const zona = [];
    for (const [arq, info] of docs) {
        if (norm(info.tipo) !== 'FATURA') continue;
        if (!temAcessorio(arq)) continue;
        zona.push({ arq, evid: String(info.evidencia || '').trim(), origem: String(info.origem || '').trim(),
                    nome: tipoDoNome(arq) });
    }
    console.log(`documentos na zona: ${zona.length}`);

    // o que a evidência diz nesses documentos?
    const porEvid = new Map();
    for (const z of zona) {
        const e = norm(z.evid);
        const k = /^IA:/.test(e) ? '(IA: emitente — sem marcador)' : (e || '(vazio)');
        porEvid.set(k, (porEvid.get(k) || 0) + 1);
    }
    console.log('\n── o que o PAPEL diz nesses documentos ─────────────────────');
    for (const [k, n] of [...porEvid].sort((a, b) => b[1] - a[1]).slice(0, 14))
        console.log(`   ${k.slice(0, 44).padEnd(46)} ${String(n).padStart(4)}  ${pct(n, zona.length)}`);

    // o nome desses documentos diz o quê?
    console.log('\n── o que o NOME diz nesses mesmos documentos ───────────────');
    const porNome = new Map();
    for (const z of zona) porNome.set(z.nome || '(mudo)', (porNome.get(z.nome || '(mudo)') || 0) + 1);
    for (const [k, n] of [...porNome].sort((a, b) => b[1] - a[1]))
        console.log(`   ${k.padEnd(12)} ${String(n).padStart(4)}  ${pct(n, zona.length)}`);

    console.log('\n   → Na zona da variante C, o NOME diz majoritariamente "NF".');
    console.log('     Pelo rótulo de _tipobate-simetrico.js:143, nome(NF) == planilha(NF)');
    console.log('     seria classificado como "falso" — mas nome e planilha estão do');
    console.log('     MESMO lado, contra o banco. Isso é a definição de alerta PROCEDENTE.');

    console.log(`\n${'═'.repeat(74)}`);
    console.log('MAS: o papel decide, não o rótulo');
    console.log('═'.repeat(74));
    console.log('\nA questão real não é o nome — é se um PDF "NF 1234 + BOL" classificado');
    console.log('como FATURA está ERRADO. O documento contém a NOTA e o BOLETO: os dois');
    console.log('papéis estão lá. Chamar o pacote de "FATURA" não é erro de leitura, é');
    console.log('escolha de qual papel é o principal — e é por isso que o alerta não');
    console.log('serve ao usuário, INDEPENDENTE de como o rótulo do script o chamou.');
    console.log('\nO teste que importa: quantos desses PDFs NÃO contêm nota fiscal?');
    console.log('Esses sim seriam erro. Sinal disponível: o número da NF no nome.\n');

    let comNumeroNF = 0, semNumeroNF = 0;
    const semEx = [];
    for (const z of zona) {
        const t = norm(z.arq);
        if (/\b(NF|NFE|NFS|NFSE|NOTA)\s*\.?\s*\d{2,}/.test(t)) comNumeroNF++;
        else { semNumeroNF++; if (semEx.length < 8) semEx.push(z); }
    }
    console.log(`   com número de NF no nome: ${String(comNumeroNF).padStart(4)}  ${pct(comNumeroNF, zona.length)}`);
    console.log(`   sem número de NF no nome: ${String(semNumeroNF).padStart(4)}  ${pct(semNumeroNF, zona.length)}`);
    console.log('\n   amostra dos SEM número de NF (candidatos a fatura de verdade):');
    for (const z of semEx) console.log(`      ev="${z.evid.slice(0, 20).padEnd(22)}" ${z.arq.slice(0, 46)}`);
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
