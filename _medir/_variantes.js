// LEITURA APENAS: mede variantes do motor nos 6 meses, pelo criterio do projeto
// (cobertura E confirmacao por 2o campo). Nao altera nada em routes/.
const XLSX=require('../node_modules/xlsx');
const fs=require('fs'),path=require('path');
const P=require('../routes/_pareamento.js');
const {getConnection}=require('../config');
function sep(l,ate){const o=[];let c='',d=false;
  for(let i=0;i<l.length;i++){const ch=l[i];
    if(d){if(ch==='"'){if(l[i+1]==='"'){c+='"';i++;}else d=false;}else c+=ch;}
    else if(ch==='"')d=true;
    else if(ch===';'){o.push(c);c='';if(o.length>ate)return o;}
    else c+=ch;}
  o.push(c);return o;}
const norm=s=>String(s||'').trim().toUpperCase().replace(/\s+/g,' ');
const soDig=s=>String(s||'').replace(/\D/g,'');
const ORIG_ESCOPO=new Set(['NF_ENTRADA','LMCP','TAXA']);
const CONTAS=new Set(['VALE REFEICAO','CESTA ALIMENTACAO','VALE TRANSPORTE','BENEFICIOS','SALARIOS','FERIAS + 1/3','13º SALARIO','BOLSA ESTAGIO','FGTS','INSS','INSS A RECUPERAR','ISSQN','INDENIZACOES TRABALHISTAS','RECLAMATORIA TRABALHISTA','DESPESAS BANCARIAS','IOF','JUROS PAGOS','JUROS A PAGAR','DISTRIBUICAO DE LUCROS','CAPITAL SOCIAL','DEPRECIACAO E AMORTIZACAO','RENIMENTO S/ APLIC FINANCEIRAS']);
const ENT_SEM=[/SECRETARIA\s+DA\s+RECEITA\s+FEDERAL|RECEITA\s+FEDERAL\s+DO\s+BRASIL/i,/^DIVISAO\s+DE\s+PROVENTOS/i,/GOVERNO\s+DO\s+(ESTADO|PARANA|MATO\s+GROSSO)|SEC(RETARIA)?\s+DE\s+ESTADO\s+DA\s+FAZENDA/i,/^PREFEITURA(\s+MUNICIPAL)?\b/i];
const dser=s=>(typeof s==='number'&&s>0)?Math.round((s-25569)*86400*1000):null;
const mser=s=>{if(!s||typeof s!=='number')return null;const d=new Date(Math.round((s-25569)*86400*1000));return `${String(d.getUTCMonth()+1).padStart(2,'0')}.${d.getUTCFullYear()}`;};
const RE_DOC=/^\s*\d+\s*\.\s*DOC\b/i;
const PADROES=[/\bGRUPO\s*\d+.*\bCOTA\b/i,/\bPAGTO\s+FINANC\s+VEIC\b|\bCDC\s+(VEICULOS|MAQUINAS)/i,/\bFINANCIAMENTO\b/i,/\bEMPRESTIMO\b|\bDAYCOVAL\b/i,/\bGIRO\s+(CAIXA|PEAC)\b|\bCRED\s+ESP\b|\bPARC\s+FLUTUANTE\b|\bCAPITAL\s+DE\s+GIRO\b|\bPARCELA\s+GIRO\b/i,/\bPIX\s+(ENVIADO|RECEBIDO)\b/i,/\bSISPAG\b/i,/\bpgto\s+VA\b/i,/\bISS\s+RETIDO\b/i,/\bFGTS\b/i,/\bRCB\.?\s*(9039|9049)\d{2}\b/i,/\bDETRAN\b|\bMINISTERIO\s+DA\s+JUSTICA\b/i,/\bSALARIO\b|\bFERIAS\b/i,/\bCHEQUE\b/i,/\bpgto\s+(TRCT|FOLHA|ADTO\s+SALARIAL|PENSAO\s+ALIMENTICIA|MEI|PREMIO|DIARIAS?|REEMBOLSO|BOLETO\s+CIEE|DIF\b)/i,/\bGUIA\s+(ISS|INSS|PIS|COFINS|CSLL|IRPJ|IPTU|IPVA)\b/i,/\bCONTA\s+GARANTIDA\s+PJ\b|\bGIRO\s+PARCELADO\b|\bLIQUIDACAO\s+DE\s+PARCELA\b/i,/\bEVA\s+CARD\b/i,/\bpgto\s+SINDICATO\b/i,/\b(ITAU|BANCO)\.?\s*DOC\.?\s*\d{6,}/i,/\bGOVERNO\b|\bPREFEITURA\b|\bIPVA\b/i];
const PENEIRA=/GRUPO|FINANC|EMPRESTIMO|DAYCOVAL|GIRO|CRED|FLUTUANTE|PIX|SISPAG|\bVA\b|ISS|FGTS|RCB|DETRAN|MINISTERIO|SALARIO|FERIAS|CHEQUE|TRCT|FOLHA|ADTO|PENSAO|MEI|PREMIO|DIARIA|REEMBOLSO|CIEE|DIF|GUIA|CONTA\s+GARANTIDA|LIQUIDACAO|EVA|SINDICATO|ITAU|BANCO|GOVERNO|PREFEITURA|IPVA|CDC|PAGTO/i;
const naoFiscal=n=>PENEIRA.test(n)&&PADROES.some(re=>re.test(n));
function mesPasta(rel){const r=String(rel||'');let a=r.match(/(?:^|[/\\])(20\d{2})\.(\d{2})\.(\d{2})(?:[/\\]|$)/);if(a)return `${a[2]}.${a[1]}`;a=r.match(/(?:^|[/\\])(\d{2})\.(\d{2})\.(20\d{2})(?:[/\\]|$)/);if(a)return `${a[2]}.${a[3]}`;return null;}
function mesNome(n){const s=String(n||'');let a=s.match(/(?<!\d)(20\d{2})\.(\d{2})\.(\d{2})(?!\d)/);if(a)return `${a[2]}.${a[1]}`;a=s.match(/(?<!\d)(\d{2})\.(\d{2})\.(20\d{2})(?!\d)/);if(a)return `${a[2]}.${a[3]}`;return null;}
const MESES=['01.2026','02.2026','03.2026','04.2026','05.2026','06.2026'];

(async()=>{
for(const ln of fs.readFileSync(path.join(__dirname,'..','.env'),'utf8').split(String.fromCharCode(10))){
  const m=ln.match(/^[ \t]*([A-Z_]+)[ \t]*=[ \t]*(.*)$/);if(m)process.env[m[1]]=m[2].trim().replace(/^"|"$/g,'');}
const arquivosPorMes={};
const andar=(dir,rel)=>{let e;try{e=fs.readdirSync(dir,{withFileTypes:true});}catch(x){return;}
  for(const en of e){const f=path.join(dir,en.name),rf=rel?`${rel}/${en.name}`:en.name;
    if(en.isDirectory()){andar(f,rf);continue;}
    if(!/\.pdf$/i.test(en.name)||!RE_DOC.test(en.name))continue;
    const mes=mesPasta(rel)||mesNome(en.name);if(!mes||naoFiscal(en.name))continue;
    (arquivosPorMes[mes]||(arquivosPorMes[mes]=[])).push({nome:en.name,rel:rf});}};
andar(process.env.ARQUIVO_PATH,'');
const pool=await getConnection();
const rs=await pool.request().input('tipo','M').query('SELECT CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO = @tipo');
const ocr={};
for(const row of rs.recordset){
  const csv=row.CONTEUDO;if(!csv||!csv.trim())continue;
  const ls=csv.replace(/^﻿/,'').split(/\r?\n/).filter(l=>l.trim());if(ls.length<2)continue;
  const cols=ls[0].split(';');const iA=cols.indexOf('arquivo'),iP=cols.indexOf('dados_parser');
  if(iA<0||iP<0)continue;const iU=Math.max(iA,iP);
  for(let i=1;i<ls.length;i++){
    const c=sep(ls[i],iU);const arq=String(c[iA]||'').replace(/#p\d+$/i,'');
    if(!arq||!RE_DOC.test(arq))continue;
    let j=null;try{j=JSON.parse(c[iP]);}catch(e){}
    if(!j)continue;
    const at=ocr[arq]||(ocr[arq]={});
    const put=(k,v)=>{if(at[k]==null&&v!=null&&String(v).trim()!=='')at[k]=v;};
    put('numero',j['Nº da NF-e']??j['Número do documento']);
    put('emitente',j['Emitente']);
    put('valorTxt',j['Valor total']??j['Valor total da nota']);
    put('oc',j['Ordem de Compra']);
    put('chave',j['Chave de acesso']??j['Nº da NF-e (chave)']);
  }
}
// planilha
const wb=XLSX.readFile(process.env.PLANILHA_PATH);
let rows=null,header=null,hr=0;
for(const sn of wb.SheetNames){const r=XLSX.utils.sheet_to_json(wb.Sheets[sn],{header:1,raw:true,defval:null});
  for(let i=0;i<Math.min(200,r.length);i++){const h=(r[i]||[]).map(c=>norm(c));
    if(h.includes('ORIG')&&h.includes('NF')&&h.includes('ENTIDADE')){rows=r;header=h;hr=i;break;}}if(rows)break;}
const ix=n=>header.indexOf(n);
const iOrig=ix('ORIG'),iFil=ix('FILIAL'),iNF=ix('NF'),iEnt=ix('ENTIDADE'),iFant=ix('FANTASIA');
const iVal=header.findIndex(c=>c==='VL_TOTAL(CAB)'||c==='VL_TOTAL_CAB'),iLanc=ix('DT_LANCAMENTO'),iEmis=ix('DT_EMISSAO'),iConta=ix('CONTA_C');
const lancPorMes={};
for(const PER of MESES){
  const itens=[];const vis=new Set();
  for(let i=hr+1;i<rows.length;i++){
    const r=rows[i];if(!r)continue;
    const mes=mser(r[iLanc])||mser(r[iEmis]);if(mes!==PER)continue;
    if(!ORIG_ESCOPO.has(norm(r[iOrig])))continue;
    if(iFil>=0&&norm(r[iFil])!=='LARSIL')continue;
    const ent=norm(r[iEnt]),nf=String(r[iNF]||'').trim(),k=`${mes}|${nf}|${ent}`;
    const conta=iConta>=0?norm(r[iConta]):'';
    if(CONTAS.has(conta)||ent.startsWith('*')||ENT_SEM.some(re=>re.test(ent))){vis.add(k);continue;}
    if(vis.has(k))continue;vis.add(k);
    itens.push({nf,entidade:ent,fantasia:iFant>=0?String(r[iFant]||'').trim():'',
      valor:Number(r[iVal])||0,dtLancamento:dser(r[iLanc]),dtEmissao:dser(r[iEmis])});
  }
  lancPorMes[PER]=itens;
}
const valorOcr=o=>{const v=o&&o.valorTxt;if(v==null)return null;
  const n=Number(String(v).replace(/\./g,'').replace(',','.'));return isFinite(n)&&n>0?n:null;};

// ---- variantes ----
function rodar(nome, ajustar){
  let pares=0,forca1=0,conf=0;
  for(const PER of MESES){
    const docsPorMes={};
    for(const off of [0,...P.VIZINHANCA]){
      const alvo=P.deslocarPeriodo(PER,off);
      docsPorMes[alvo]=(arquivosPorMes[alvo]||[]).map(a=>{
        const o=ocr[a.nome]||null;
        const base=P.documentoDoArquivo(a.nome,a.rel);
        const ocrIn=o?{numero:o.numero,emitente:o.emitente,valor:valorOcr(o),dtEmissao:null}:null;
        return ajustar(base,ocrIn,o,a);
      });
    }
    const L=lancPorMes[PER].map(P.lancamentoDaPlanilha);
    const r=P.conferirPeriodo(L,docsPorMes,PER);
    const todos=[...r.pares,...r.paresVizinhos];
    pares+=todos.length;
    for(const p of todos){if(p.forca===1)forca1++;else conf++;}
  }
  const pct=(100*conf/pares).toFixed(1);
  console.log(`${nome.padEnd(46)} pares ${String(pares).padStart(5)}  2ºcampo ${String(conf).padStart(5)} (${pct}%)  fracos ${forca1}`);
  return {pares,conf};
}
console.log('=== jan-jun/2026, criterio do projeto (cobertura E confirmacao) ===\n');
const base=rodar('A) ATUAL (producao)', (b,o)=>P.enriquecerComOcr(b,o));
rodar('B) ignora numero do OCR igual a OC', (b,o,raw)=>{
  const oo=o?{...o}:null;
  if(oo&&raw&&raw.oc&&oo.numero&&soDig(oo.numero)===soDig(raw.oc)) oo.numero=null;
  return P.enriquecerComOcr(b,oo);
});
rodar('C) B + so se o nome tiver numero rotulado', (b,o,raw)=>{
  const oo=o?{...o}:null;
  if(oo&&raw&&raw.oc&&oo.numero&&soDig(oo.numero)===soDig(raw.oc)&&P.numeroDoNome(b.arquivo)) oo.numero=null;
  return P.enriquecerComOcr(b,oo);
});
process.exit(0);
})().catch(e=>{console.error('ERRO:',e.message,e.stack);process.exit(1);});
