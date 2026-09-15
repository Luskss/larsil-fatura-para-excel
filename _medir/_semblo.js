'use strict';
const fs=require('fs'),path=require('path');
const {PDFParse}=require('../node_modules/pdf-parse');
const env={};
for(const l of fs.readFileSync(path.join(__dirname,'..','.env'),'utf8').split(/\r?\n/)){
  const m=l.match(/^\s*([A-Z_]+)\s*=\s*"?(.*?)"?\s*$/); if(m) env[m[1]]=m[2];
}
const RAIZ=env.ARQUIVO_PATH||env.MONITOR_PATH;
function varrer(d,s,p=0){if(p>4)return;let e;try{e=fs.readdirSync(d,{withFileTypes:true})}catch(_){return}
for(const x of e){const q=path.join(d,x.name); if(x.isDirectory())varrer(q,s,p+1); else if(/\.pdf$/i.test(x.name))s.push(q)}}
const norm=s=>(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase();
(async()=>{
 const todos=[];varrer(RAIZ,todos);
 for(let i=todos.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[todos[i],todos[j]]=[todos[j],todos[i]]}
 let danfe=0; const cats={curto:0,semAncora:0,temNcmFora:0,imagem:0};
 for(const p of todos){
  if(danfe>=120)break;
  let text='',pages=1;
  try{const pr=new PDFParse({data:new Uint8Array(fs.readFileSync(p))});const r=await pr.getText();
   text=(r.text||'').replace(/--\s*\d+\s+of\s+\d+\s*--/gi,' ');pages=r.total||1;await pr.destroy()}catch(_){continue}
  const T=norm(text);
  if(!/DANFE|DOCUMENTO AUXILIAR DA NOTA FISCAL/.test(T))continue;
  danfe++;
  if(T.search(/DADOS DO PRODUTO\s*\/?\s*SERVI/)>=0)continue;
  if(text.replace(/\s/g,'').length<800)cats.imagem++;
  // tem NCM+valor em alguma linha, mesmo sem o cabecalho do bloco?
  const temLinha=text.split('\n').some(l=>/(?<![\d.,])(\d{8})(?![\d.,])/.test(l)&&/\d+,\d{2}/.test(l));
  if(temLinha)cats.temNcmFora++; else cats.semAncora++;
 }
 console.log(`DANFEs: ${danfe}`);
 console.log(`sem bloco mas COM linha NCM+valor: ${cats.temNcmFora}`);
 console.log(`sem bloco e SEM âncora nenhuma:    ${cats.semAncora}`);
 console.log(`texto muito curto (escaneado):     ${cats.imagem}`);
})();
