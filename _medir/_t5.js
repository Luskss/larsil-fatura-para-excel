// Pareamento de um periodo com os MESMOS filtros de escopo da rota.
//
// ⚠ NAO REPRODUZ A ROTA POR INTEIRO: este script NAO enriquece o documento com o
// OCR (`enriquecerComOcr`), entao os documentos chegam SEM a data de emissao que o
// extrator preenche. Como o veto de janela depende dessa data, um par pode aparecer
// aqui e nao aparecer no painel — foi exatamente o que aconteceu com a MACPONTA em
// 08/09/2026, e me levou a afirmar que o par funcionava quando nao funcionava.
//
// Para conferir um caso como o painel o ve, use `_rota.js` (chama o handler real) ou
// `_variantes.js` (pipeline completo, 6 meses). Este aqui serve so para inspecionar
// escopo e filtros.
const fs = require('fs');
const path = require('path');
const P = require('../routes/_pareamento.js');
const XLSX = require('../node_modules/xlsx');

const RAIZ = path.join(__dirname, '..');
for (const ln of fs.readFileSync(path.join(RAIZ, '.env'), 'utf8').split(String.fromCharCode(10))) {
  const m = ln.match(/^[ \t]*([A-Z_]+)[ \t]*=[ \t]*(.*)$/);
  if (m) process.env[m[1]] = m[2].trim().replace(/^"|"$/g, '');
}

const PERIODO = process.argv[2] || '02.2026';

// ── lado PASTA (copia fiel de contarNaPasta) ──
const RE_DOC = /^\s*\d+\s*\.\s*DOC\b/i;
const PADROES_NAO_FISCAL = [
  [/\bGRUPO\s*\d+.*\bCOTA\b/i, 'Consorcio'],
  [/\bPAGTO\s+FINANC\s+VEIC\b|\bCDC\s+(VEICULOS|MAQUINAS)/i, 'Financ veic'],
  [/\bFINANCIAMENTO\b/i, 'Financiamento'], [/\bEMPRESTIMO\b|\bDAYCOVAL\b/i, 'Emprestimo'],
  [/\bGIRO\s+(CAIXA|PEAC)\b|\bCRED\s+ESP\b|\bPARC\s+FLUTUANTE\b|\bCAPITAL\s+DE\s+GIRO\b|\bPARCELA\s+GIRO\b/i, 'Giro'],
  [/\bPIX\s+(ENVIADO|RECEBIDO)\b/i, 'PIX'], [/\bSISPAG\b/i, 'SISPAG'], [/\bpgto\s+VA\b/i, 'VA'],
  [/\bISS\s+RETIDO\b/i, 'ISS retido'], [/\bFGTS\b/i, 'FGTS'],
  [/\bRCB\.?\s*(9039|9049)\d{2}\b/i, 'Guia gov'],
  [/\bDETRAN\b|\bMINISTERIO\s+DA\s+JUSTICA\b/i, 'DETRAN'],
  [/\bSALARIO\b|\bFERIAS\b/i, 'Folha'], [/\bCHEQUE\b/i, 'Cheque'],
  [/\bpgto\s+(TRCT|FOLHA|ADTO\s+SALARIAL|PENSAO\s+ALIMENTICIA|MEI|PREMIO|DIARIAS?|REEMBOLSO|BOLETO\s+CIEE|DIF\b)/i, 'Folha/RH'],
  [/\bGUIA\s+(ISS|INSS|PIS|COFINS|CSLL|IRPJ|IPTU|IPVA)\b/i, 'Guia trib'],
  [/\bCONTA\s+GARANTIDA\s+PJ\b|\bGIRO\s+PARCELADO\b|\bLIQUIDACAO\s+DE\s+PARCELA\b/i, 'Giro var'],
  [/\bEVA\s+CARD\b/i, 'EVA Card'], [/\bpgto\s+SINDICATO\b/i, 'Sindicato'],
  [/\b(ITAU|BANCO)\.?\s*DOC\.?\s*\d{6,}/i, 'TED/DOC'],
  [/\bGOVERNO\b|\bPREFEITURA\b|\bIPVA\b/i, 'Guia gov (nome)'],
];
const PENEIRA = /GRUPO|FINANC|EMPRESTIMO|DAYCOVAL|GIRO|CRED|FLUTUANTE|PIX|SISPAG|\bVA\b|ISS|FGTS|RCB|DETRAN|MINISTERIO|SALARIO|FERIAS|CHEQUE|TRCT|FOLHA|ADTO|PENSAO|MEI|PREMIO|DIARIA|REEMBOLSO|CIEE|DIF|GUIA|CONTA\s+GARANTIDA|LIQUIDACAO|EVA|SINDICATO|ITAU|BANCO|GOVERNO|PREFEITURA|IPVA|CDC|PAGTO/i;
function catNaoFiscal(n) {
  if (!PENEIRA.test(n)) return '';
  for (const [re, r] of PADROES_NAO_FISCAL) if (re.test(n)) return r;
  return '';
}
function mesDaPasta(rel) {
  const r = String(rel || '');
  let a = r.match(/(?:^|[/\\])(20\d{2})\.(\d{2})\.(\d{2})(?:[/\\]|$)/);
  if (a) return `${a[2]}.${a[1]}`;
  a = r.match(/(?:^|[/\\])(\d{2})\.(\d{2})\.(20\d{2})(?:[/\\]|$)/);
  if (a) return `${a[2]}.${a[3]}`;
  return null;
}
function mesDoNome(n) {
  const s = String(n || '');
  let a = s.match(/(?<!\d)(20\d{2})\.(\d{2})\.(\d{2})(?!\d)/);
  if (a) return `${a[2]}.${a[1]}`;
  a = s.match(/(?<!\d)(\d{2})\.(\d{2})\.(20\d{2})(?!\d)/);
  if (a) return `${a[2]}.${a[3]}`;
  return null;
}

const arquivosPorMes = {};
const naoFiscalMac = [];
const andar = (dir, rel) => {
  let e; try { e = fs.readdirSync(dir, { withFileTypes: true }); } catch (x) { return; }
  for (const en of e) {
    const f = path.join(dir, en.name), rf = rel ? `${rel}/${en.name}` : en.name;
    if (en.isDirectory()) { andar(f, rf); continue; }
    if (!/\.pdf$/i.test(en.name)) continue;
    if (!RE_DOC.test(en.name)) continue;
    const mes = mesDaPasta(rel) || mesDoNome(en.name);
    if (!mes) continue;
    const cat = catNaoFiscal(en.name);
    if (cat) { if (/MACPONTA/i.test(en.name)) naoFiscalMac.push([cat, rf]); continue; }
    (arquivosPorMes[mes] || (arquivosPorMes[mes] = [])).push({ nome: en.name, rel: rf });
  }
};
andar(process.env.ARQUIVO_PATH, '');

// ── lado PLANILHA (copia fiel de contarNaPlanilha) ──
const norm = s => String(s || '').trim().toUpperCase().replace(/\s+/g, ' ');
const ORIG_ESCOPO = new Set(['NF_ENTRADA', 'LMCP', 'TAXA']);
const FILIAL_ESCOPO = 'LARSIL';
const CONTAS_SEM_DOCUMENTO = new Set([
  'VALE REFEICAO','CESTA ALIMENTACAO','VALE TRANSPORTE','BENEFICIOS','SALARIOS',
  'FERIAS + 1/3','13º SALARIO','BOLSA ESTAGIO','FGTS','INSS','INSS A RECUPERAR','ISSQN',
  'INDENIZACOES TRABALHISTAS','RECLAMATORIA TRABALHISTA','DESPESAS BANCARIAS','IOF',
  'JUROS PAGOS','JUROS A PAGAR','DISTRIBUICAO DE LUCROS','CAPITAL SOCIAL',
  'DEPRECIACAO E AMORTIZACAO','RENIMENTO S/ APLIC FINANCEIRAS',
]);
const ENTIDADES_SEM_NOTA = [
  [/SECRETARIA\s+DA\s+RECEITA\s+FEDERAL|RECEITA\s+FEDERAL\s+DO\s+BRASIL/i, 'Receita Federal'],
  [/^DIVISAO\s+DE\s+PROVENTOS/i, 'Divisao de proventos'],
  [/GOVERNO\s+DO\s+(ESTADO|PARANA|MATO\s+GROSSO)|SEC(RETARIA)?\s+DE\s+ESTADO\s+DA\s+FAZENDA/i, 'Fazenda estadual'],
  [/^PREFEITURA(\s+MUNICIPAL)?\b/i, 'Prefeitura'],
];
const entidadeSemNota = e => { for (const [re, r] of ENTIDADES_SEM_NOTA) if (re.test(String(e || ''))) return r; return ''; };
const ehInformativo = e => String(e || '').trim().startsWith('*');
function dataDoSerial(s) {
  if (typeof s === 'number' && s > 0) return Math.round((s - 25569) * 86400 * 1000);
  const t = String(s || '').trim();
  let m = t.match(/^(\d{2})\/(\d{2})\/(\d{4})/); if (m) return Date.UTC(+m[3], +m[2]-1, +m[1]);
  m = t.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return Date.UTC(+m[1], +m[2]-1, +m[3]);
  return null;
}
const mesDoSerial = s => {
  if (!s || typeof s !== 'number') return null;
  const d = new Date(Math.round((s - 25569) * 86400 * 1000));
  return `${String(d.getUTCMonth()+1).padStart(2,'0')}.${d.getUTCFullYear()}`;
};

const wb = XLSX.readFile(process.env.PLANILHA_PATH);
let rows = null, header = null, hr = 0;
for (const sn of wb.SheetNames) {
  const r = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, raw: true, defval: null });
  for (let i = 0; i < Math.min(200, r.length); i++) {
    const h = (r[i] || []).map(c => norm(c));
    if (h.includes('ORIG') && h.includes('NF') && h.includes('ENTIDADE') &&
        (h.includes('VL_TOTAL_CAB') || h.includes('VL_TOTAL(CAB)'))) { rows = r; header = h; hr = i; break; }
  }
  if (rows) break;
}
const iOrig=header.indexOf('ORIG'), iNF=header.indexOf('NF'), iEnt=header.indexOf('ENTIDADE');
const iVal=header.findIndex(c=>c==='VL_TOTAL(CAB)'||c==='VL_TOTAL_CAB');
const iLanc=header.indexOf('DT_LANCAMENTO'), iEmis=header.indexOf('DT_EMISSAO');
const iConta=header.indexOf('CONTA_C'), iFilial=header.indexOf('FILIAL'), iFant=header.indexOf('FANTASIA');

const itens = [];
const vistos = new Set();
for (let i = hr + 1; i < rows.length; i++) {
  const row = rows[i]; if (!row || !row.length) continue;
  const mes = mesDoSerial(row[iLanc]) || mesDoSerial(row[iEmis]);
  if (mes !== PERIODO) continue;
  if (!ORIG_ESCOPO.has(norm(row[iOrig]))) continue;
  if (iFilial >= 0 && norm(row[iFilial]) !== FILIAL_ESCOPO) continue;
  const ent = norm(row[iEnt]);
  const nf = String(row[iNF] || '').trim();
  const chave = `${mes}|${nf}|${ent}`;
  const conta = iConta >= 0 ? norm(row[iConta]) : '';
  if (CONTAS_SEM_DOCUMENTO.has(conta)) { vistos.add(chave); continue; }
  if (ehInformativo(ent)) { vistos.add(chave); continue; }
  if (entidadeSemNota(ent)) { vistos.add(chave); continue; }
  if (vistos.has(chave)) continue;
  vistos.add(chave);
  itens.push({ nf, entidade: ent, fantasia: iFant>=0?String(row[iFant]||'').trim():'',
    valor: Number(row[iVal])||0, dtLancamento: dataDoSerial(row[iLanc]), dtEmissao: dataDoSerial(row[iEmis]) });
}

const docsPorMes = {};
for (const off of [0, ...P.VIZINHANCA]) {
  const alvo = P.deslocarPeriodo(PERIODO, off);
  docsPorMes[alvo] = (arquivosPorMes[alvo] || []).map(a => P.documentoDoArquivo(a.nome, a.rel));
}
const L = itens.map(P.lancamentoDaPlanilha);
const r = P.conferirPeriodo(L, docsPorMes, PERIODO);

console.log(`=== ${PERIODO} ===`);
console.log('lancamentos (escopo real):', L.length);
console.log('conferidos:', r.pares.length + r.paresVizinhos.length,
  `(no mes ${r.pares.length}, vizinhas ${r.paresVizinhos.length})`);
console.log('sem documento:', r.lancamentosSemDocumento);

const alvo = L.find(l => /MACPONTA/i.test(l.entidade) && Math.abs(l.valor - 1320000) < 0.01);
console.log('\n--- MACPONTA 1.320.000 ---');
if (!alvo) { console.log('NAO esta no escopo da planilha para', PERIODO); }
else {
  console.log('lancamento: NF', alvo.nf, '|', alvo.entidade, '| R$', alvo.valor,
    '| lanc', new Date(alvo.dtLancamento).toISOString().slice(0,10));
  const todos = [...r.pares, ...r.paresVizinhos];
  const par = todos.find(p => p.lancamento === alvo);
  console.log('resultado:', par
    ? `PAREADO com "${par.documento.arquivo}" via ${par.via} forca ${par.forca} (pasta ${par.periodoDocumento||PERIODO})`
    : 'SEM DOCUMENTO  <-- reproduz o painel');
  console.log('esta na lista semDocumento?', r.semDocumento.includes(alvo));
}

const cands = (docsPorMes['01.2026'] || []).filter(d => /MACPONTA/i.test(d.arquivo) && /1320000/.test(d.arquivo));
console.log('\ndocumentos 1320000 visiveis em 01.2026:', cands.length);
for (const c of cands) console.log('   -', c.arquivo, '| valor', c.valor, '| tokens', [...c.tokens].join(','));
if (naoFiscalMac.length) { console.log('\nMACPONTA barrados como nao-fiscal:'); for (const [c, f] of naoFiscalMac) console.log('   [', c, ']', f); }
