// LEITURA APENAS: chama o handler da rota direto (sem HTTP/sessão) e imprime o
// bloco `conferencia`, para conferir os campos novos como a tela os recebe.
const fs=require('fs'),path=require('path');
for(const ln of fs.readFileSync(path.join(__dirname,'..','.env'),'utf8').split(String.fromCharCode(10))){
  const m=ln.match(/^[ \t]*([A-Z_]+)[ \t]*=[ \t]*(.*)$/);if(m&&!process.env[m[1]])process.env[m[1]]=m[2].trim().replace(/^"|"$/g,'');}
const rota=require('../routes/comparar-notas.js');
const mes=Number(process.argv[2]||2), ano=Number(process.argv[3]||2026);
// Sessão simulada: a rota só exige `cf_loggedIn` (requireAuth em _helpers.js).
// Isto roda localmente, fora do servidor — não altera nem contorna a autenticação real.
const req={method:'POST',query:{},body:{mes,ano},headers:{},session:{cf_loggedIn:true}};
const res={
  statusCode:200,
  setHeader(){}, set(){}, status(c){this.statusCode=c;return this;},
  json(o){
    const c=o.conferencia||{};
    console.log(`=== ${o.periodo} (HTTP ${this.statusCode}) ===`);
    console.log('planilha.total      :',o.planilha&&o.planilha.total);
    console.log('pasta.total         :',o.pasta&&o.pasta.total);
    console.log('conferidos          :',c.conferidos,`(mes ${c.noMes}, vizinhas ${c.emPastaVizinha})`);
    console.log('lancSemDocumento    :',c.lancamentosSemDocumento);
    console.log('docsSemLanc LIQUIDO :',c.documentosSemLancamento);
    console.log('docsSemLanc BRUTO   :',c.documentosSemLancamentoBruto);
    console.log('irmaosAgrupados     :',c.irmaosAgrupados);
    console.log('fracos              :',c.fracos);
    console.log('empatados           :',c.empatados);
    console.log('divergentes         :',c.divergentes);
    const L=c.listaEmpatados||[];
    console.log('\ntop empates por valor:');
    for(const e of L.slice(0,6)){
      console.log(`  R$ ${e.valor}  NF ${e.nf}  ${String(e.entidade).slice(0,30)}  forca ${e.forca}`);
      console.log(`     escolhido: ${e.escolhido.slice(0,70)}`);
      console.log(`     candidatos(${e.outros}): ${e.candidatos.map(x=>x.arquivo.slice(0,52)).join(' | ')}`);
    }
    process.exit(0);
  },
};
rota(req,res).catch(e=>{console.error('ERRO:',e.message,e.stack);process.exit(1);});
