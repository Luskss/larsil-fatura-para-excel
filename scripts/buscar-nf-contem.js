'use strict';
const fs = require('fs');
try { for (const line of fs.readFileSync('.env','utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/i);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g,'');
}} catch(_){}
const XLSX = require('xlsx');
const wb = XLSX.readFile(process.env.PLANILHA_PATH, { cellDates:false });
const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header:1 });
const h = rows[1] || [];
const I = {
    ORIG:h.indexOf('ORIG'), NF:h.indexOf('NF'), ENT:h.indexOf('ENTIDADE'),
    VAL:h.indexOf('VL_TOTAL_CAB'), DTL:h.indexOf('DT_LANCAMENTO'),
    DTE:h.indexOf('DT_EMISSAO'), TIPO:h.indexOf('TIPO'),
    CDE:h.indexOf('CD_ENTID')
};
const alvo = process.argv[2] || '113462';

function nfClean(nf){ return String(nf||'').replace(/^[A-Za-z]+/,'').replace(/^0+/,'') || String(nf||'').replace(/^0+/,''); }
function dt(s){ if(typeof s!=='number') return s||''; const d=new Date(Math.round((s-25569)*86400000)); return `${String(d.getUTCDate()).padStart(2,'0')}/${String(d.getUTCMonth()+1).padStart(2,'0')}/${d.getUTCFullYear()}`; }

console.log(`Buscando NF cujo nfClean === "${alvo}" OU CD_ENTID === "${alvo}" OU ENTIDADE contém "JOHN LENON"\n`);

let porNF=0, porCdEnt=0, porEnt=0;
for (let i=2;i<rows.length;i++){
    const r=rows[i]; if(!r) continue;
    const nfRaw = String(r[I.NF]||'').trim();
    const nfC = nfClean(nfRaw);
    const cdEnt = String(r[I.CDE]||'').trim();
    const ent = String(r[I.ENT]||'').trim().toUpperCase();
    let motivo=null;
    if (nfC === alvo) motivo='nfClean';
    else if (cdEnt === alvo) motivo='cd_entid';
    else if (ent.includes('JOHN LENON') || ent.includes('JOHN LENNON')) motivo='entidade';
    if (!motivo) continue;
    if (motivo==='nfClean') porNF++;
    if (motivo==='cd_entid') porCdEnt++;
    if (motivo==='entidade') porEnt++;
    console.log(`[${motivo}] L${i+1}: ORIG=${r[I.ORIG]} NF=${nfRaw} (clean=${nfC}) CD_ENTID=${cdEnt} ENT="${r[I.ENT]}" TIPO=${r[I.TIPO]} VAL=${r[I.VAL]} DT_LANC=${dt(r[I.DTL])} DT_EMIS=${dt(r[I.DTE])}`);
}
console.log(`\nporNFclean=${porNF} porCdEntid=${porCdEnt} porEntidade=${porEnt}`);
