/**
 * _medir/_antes-depois-transcricao.js — o que a transcrição mudou, arquivo a arquivo.
 *
 * As medições por TAXA não respondem a pergunta do usuário, e por dois motivos
 * achados no caminho:
 *   - 93% dos documentos transcritos são filtrados da conferência de propósito
 *     (financiamento/consórcio/crédito), então taxa de pareamento mede o filtro;
 *   - sobram 3 documentos no universo do comparador — amostra pequena demais.
 *
 * A pergunta literal é "ajudou a preencher os campos?". Isso se responde SEM taxa e
 * SEM pareamento: para cada um dos 58 documentos que a transcrição leu em 03.2026,
 * o que havia ali ANTES?
 *
 * O "antes" é conhecido sem backup: são os PDFs-imagem que o OCR não conseguiu ler.
 * `_origem-vazia.js` e `_limiar-imagem.js` já estabeleceram que esses arquivos têm
 * ZERO caractere de texto nativo — não é "pouco texto", é nenhum. Sem transcrição o
 * pipeline só teria o nome do arquivo.
 *
 * Então mede-se: quantos campos a transcrição gravou, quantos conferem com o nome, e
 * — o que importa de verdade — quantos campos vieram do DOCUMENTO e não do nome.
 * Campo que só repete o nome do arquivo não é leitura, é eco ([[ia-le-nome-do-arquivo-sem-ocr]]).
 *
 * SOMENTE LEITURA.
 */
'use strict';
const path = require('path');
const h = require('./harness');
const j = require('./_julgar-campos');
const { getConnection, sql } = require('../config');
const pf = require('../routes/process-folder');

const PERIODO = process.argv[2] || '03.2026';
const VAZIO = v => v == null || String(v).trim() === '' || String(v).trim() === '—'
                || String(v).trim() === 'null' || String(v).trim() === '0';
const ROT = {
    valor:  ['Valor total da nota', 'Valor total', 'Valor do serviço', 'Valor principal',
             'Valor da prestação', 'Valor líquido'],
    numero: ['Nº da NFS-e', 'Nº da NF-e', 'Nº do CT-e', 'Número do documento'],
    data:   ['Data de emissão'],
    emitente: ['Emitente', 'Razão social (nota)', 'Nome social'],
};
const primeiro = (pd, ks) => { for (const k of ks) if (pd && !VAZIO(pd[k])) return pd[k]; return null; };

(async () => {
    const pool = await getConnection();
    const r = await pool.request()
        .input('t', sql.Char(1), 'M').input('pe', sql.VarChar(20), PERIODO)
        .query('SELECT CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO=@t AND PERIODO=@pe');
    const rows = pf.csvToRows(r.recordset[0].CONTEUDO)
        .filter(x => /transcri/i.test(String(x.conteudo || '')));

    console.log(`${PERIODO}: ${rows.length} documentos lidos por transcrição`);
    console.log('(antes do scan estes tinham ZERO caractere de texto e o OCR falhou neles)\n');

    let campos = 0, doDocumento = 0, ecoDoNome = 0;
    const acc = { ok: 0, erro: 0, parcela: 0, vazio: 0, semGab: 0 };
    let comCnpj = 0, comChave = 0, comLinha = 0, comItens = 0;

    for (const x of rows) {
        const base = path.basename(String(x.arquivo).replace(/#p\d+$/, ''));
        let pd = null; try { pd = JSON.parse(x.dados_parser || 'null'); } catch (_) {}
        const g = j.gabaritos(base);
        const lido = {
            valor: j.num(primeiro(pd, ROT.valor)),
            numero: primeiro(pd, ROT.numero),
            data: primeiro(pd, ROT.data),
            emitente: primeiro(pd, ROT.emitente),
        };
        for (const c of j.CAMPOS) if (!VAZIO(lido[c])) campos++;
        const ver = j.julgar(lido, g);
        for (const c of j.CAMPOS) acc[ver[c] === 's/gab' ? 'semGab' : ver[c]]++;

        // Campos que o NOME não tem — só podem ter vindo do papel.
        for (const c of j.CAMPOS) {
            if (VAZIO(lido[c])) continue;
            if (g[c] == null || g[c] === '') doDocumento++; else ecoDoNome++;
        }
        if (pd && !VAZIO(pd['CNPJ emitente'])) comCnpj++;
        if (pd && !VAZIO(pd['Chave de acesso'])) comChave++;
        if (pd && !VAZIO(pd['Linha digitável'])) comLinha++;
        if (pd && !VAZIO(pd['Itens'])) comItens++;
    }

    console.log('CAMPOS GRAVADOS');
    console.log(`   total de campos preenchidos: ${campos}  (${(campos / rows.length).toFixed(2)} por documento, de 4)`);
    console.log(`   ok=${acc.ok}  ERRO=${acc.erro}  ~parcela=${acc.parcela}  vazio=${acc.vazio}  s/gabarito=${acc.semGab}`);
    const julgados = acc.ok + acc.erro + acc.parcela + acc.vazio;
    if (julgados) console.log(`   taxa de acerto entre os conferíveis: ${(100 * acc.ok / julgados).toFixed(0)}%`);

    console.log('\nDE ONDE VEIO O CAMPO');
    console.log(`   o nome do arquivo TAMBÉM tinha: ${ecoDoNome}`);
    console.log(`   só podia vir do PAPEL:          ${doDocumento}`);

    console.log('\nCAMPOS QUE O NOME NUNCA TEM (leitura pura do documento)');
    console.log(`   CNPJ do emitente: ${comCnpj}/${rows.length}`);
    console.log(`   chave de acesso:  ${comChave}/${rows.length}`);
    console.log(`   linha digitável:  ${comLinha}/${rows.length}`);
    console.log(`   itens da nota:    ${comItens}/${rows.length}`);
    process.exit(0);
})();
