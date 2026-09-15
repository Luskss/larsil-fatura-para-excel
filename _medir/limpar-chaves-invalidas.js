/**
 * _medir/limpar-chaves-invalidas.js — trata as 388 chaves de acesso inválidas que
 * sobraram no banco (a correção em `_nf-parsers.js` impede novas, não limpa antigas).
 *
 * Classificadas por `_medir/_chave-ruim-origem.js`, e cada classe tem destino próprio:
 *
 *   · 95 RECUPERÁVEIS — a chave válida está DENTRO da sequência, com dígito grudado
 *     na frente ("1" + os 44 certos, típico de OCR juntando o número da coluna ao
 *     lado). Aqui não se apaga: recorta-se a janela de 44 dígitos que passa no DV.
 *     Como o DV valida, o recorte é verificável, não palpite.
 *
 *   · 293 INSALVÁVEIS — 226 curtas (dígitos perdidos NO MEIO: testei recompor as de
 *     42 díg com todos os 100 sufixos possíveis e nenhuma fecha o DV), 42 com 44
 *     dígitos e DV errado, 9 linhas digitáveis de boleto, 16 outras. Estas viram "—",
 *     o mesmo placeholder que o parser usa para "procurei e não achei".
 *
 * Por que apagar em vez de deixar: uma chave inválida não é dado fraco, é dado FALSO.
 * `nfDaChaveAcesso` e `cnpjDaChaveAcesso` extraem número da nota e CNPJ dela — com a
 * validação corrigida elas já devolvem vazio, mas o campo continua exibido na tela
 * como se fosse a chave do documento. "—" diz a verdade; 42 dígitos aleatórios, não.
 *
 * SEM `--gravar` não toca o banco. Uso: node _medir/limpar-chaves-invalidas.js [periodo] [--gravar]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const RAIZ = path.join(__dirname, '..');
const { getConnection, sql } = require('../config');
const { chaveValida } = require('../routes/_nf-parsers');

for (const linha of fs.readFileSync(path.join(RAIZ, '.env'), 'utf8').split(/\r?\n/)) {
    const m = linha.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(m[1] in process.env)) process.env[m[1]] = v;
}

function parseCsv(txt) {
    txt = String(txt || '').replace(/^﻿/, '');
    const linhas = [];
    let campo = '', linha = [], dentro = false;
    for (let i = 0; i < txt.length; i++) {
        const c = txt[i];
        if (dentro) {
            if (c === '"') { if (txt[i + 1] === '"') { campo += '"'; i++; } else dentro = false; }
            else campo += c;
        } else if (c === '"') dentro = true;
        else if (c === ';') { linha.push(campo); campo = ''; }
        else if (c === '\n') { linha.push(campo); linhas.push(linha); linha = []; campo = ''; }
        else if (c !== '\r') campo += c;
    }
    if (campo || linha.length) { linha.push(campo); linhas.push(linha); }
    return linhas;
}
function csvEscape(val) {
    const s = String(val ?? '');
    return (s.includes(';') || s.includes('"') || s.includes('\n') || s.includes('\r'))
        ? '"' + s.replace(/"/g, '""') + '"' : s;
}
const toCsv = rows => '﻿' + rows.map(r => r.map(csvEscape).join(';')).join('\r\n');

function janelaValida(d) {
    if (d.length < 44) return '';
    for (let i = 0; i + 44 <= d.length; i++) {
        const j = d.slice(i, i + 44);
        if (chaveValida(j)) return j;
    }
    return '';
}

(async () => {
    const args = process.argv.slice(2);
    const gravar = args.includes('--gravar');
    const periodoArg = args.find(a => !a.startsWith('--')) || null;

    const pool = await getConnection();
    const req = pool.request();
    let q = "SELECT PERIODO, CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO='M'";
    if (periodoArg) { q += ' AND PERIODO=@p'; req.input('p', sql.VarChar(20), periodoArg); }
    const r = await req.query(q);

    console.log(`escopo: ${periodoArg || 'todos os meses'}`);
    console.log(`modo  : ${gravar ? '*** GRAVANDO NO BANCO ***' : 'simulação (use --gravar para valer)'}\n`);

    let recuperadas = 0, apagadas = 0, camposDerivados = 0;
    const exemplos = [], porPeriodo = [];

    for (const rec of r.recordset) {
        const rows = parseCsv(rec.CONTEUDO);
        if (rows.length < 2) continue;
        const h = rows[0];
        const i = n => h.indexOf(n);
        const corpo = rows.slice(1).filter(x => x[i('arquivo')]);
        let mudou = 0;

        for (const row of corpo) {
            let d = null;
            try { d = JSON.parse(row[i('dados_parser')] || '{}'); } catch (_) { continue; }
            if (!d || typeof d !== 'object') continue;
            const ch = d['Chave de acesso'];
            if (!ch || String(ch).trim() === '' || String(ch).trim() === '—') continue;
            const dig = String(ch).replace(/\D/g, '');
            if (chaveValida(dig)) continue;

            const boa = janelaValida(dig);
            if (boa) {
                d['Chave de acesso'] = boa;
                recuperadas++;
                if (exemplos.length < 6)
                    exemplos.push(`RECUPERADA ${rec.PERIODO} · ${String(row[i('arquivo')]).slice(0, 50)}\n        ${dig}\n        → ${boa}`);
            } else {
                d['Chave de acesso'] = '—';
                apagadas++;
                // Os campos DERIVADOS da chave saem junto: foram calculados a partir
                // dela, então se ela era falsa, eles também são.
                for (const k of ['Nº da NF-e (chave)', 'CNPJ (chave)']) {
                    if (d[k] != null && String(d[k]).trim() !== '' && String(d[k]).trim() !== '—') {
                        d[k] = '—';
                        camposDerivados++;
                    }
                }
            }
            row[i('dados_parser')] = JSON.stringify(d);
            mudou++;
        }

        if (!mudou) continue;
        porPeriodo.push({ periodo: rec.PERIODO, n: mudou });
        if (gravar) {
            const dir = path.join(__dirname, '_backup-chaves');
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, `${rec.PERIODO}.csv`), rec.CONTEUDO, 'utf8');
            await pool.request()
                .input('p', sql.VarChar(20), rec.PERIODO)
                .input('c', sql.NVarChar(sql.MAX), toCsv([h, ...corpo]))
                .query("UPDATE nfs.RELATORIOS_CONFERENCIA SET CONTEUDO=@c, ATUALIZADO_EM=GETDATE() WHERE TIPO='M' AND PERIODO=@p");
        }
    }

    console.log(`chaves recuperadas pelo recorte  ${recuperadas}   ← a válida estava dentro; DV confirma`);
    console.log(`chaves apagadas (viram "—")      ${apagadas}`);
    console.log(`campos derivados zerados junto   ${camposDerivados}`);
    if (porPeriodo.length) {
        console.log(`\npor período:`);
        for (const p of porPeriodo.sort((a, b) => b.n - a.n).slice(0, 12))
            console.log(`   ${String(p.n).padStart(5)}  ${p.periodo}`);
    }
    if (exemplos.length) {
        console.log(`\nexemplos:`);
        for (const e of exemplos) console.log(`   · ${e}`);
    }
    console.log(gravar ? '\ngravado. backup em _medir/_backup-chaves/'
                       : '\nnada foi gravado. rode com --gravar para aplicar.');
})().catch(e => { console.error(e); process.exit(1); });
