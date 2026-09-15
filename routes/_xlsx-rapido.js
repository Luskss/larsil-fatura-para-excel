/**
 * routes/_xlsx-rapido.js
 * Leitor de XLSX enxuto, para planilhas grandes onde só interessam os VALORES.
 *
 * POR QUE EXISTE
 * A planilha Delsoft tem 23,5 MB e 118 mil linhas. `XLSX.readFile` levava 23–55 s
 * para abri-la, porque monta o modelo completo da pasta de trabalho (estilos, formatos,
 * fórmulas, um objeto por célula — são 4,1 milhões delas). Nada disso é usado aqui:
 * a conferência lê texto e número de uma dúzia de colunas.
 *
 * Este leitor descompacta só o `sharedStrings.xml` e a worksheet alvo, varre o XML e
 * devolve `linhas[i][coluna]` — o mesmo formato de `sheet_to_json(..., { header: 1 })`.
 * Medido na planilha real: 2,5 s contra 55 s, com resultado IDÊNTICO nos 60 meses
 * (conferido lançamento a lançamento contra o caminho XLSX antes de entrar em uso).
 *
 * ESCOPO / LIMITES — é um atalho deliberado, não um substituto do xlsx:
 *   • lê apenas .xlsx (ZIP+XML). .xls antigo e .xlsb NÃO são suportados;
 *   • devolve datas como SERIAL do Excel (número), que é o que o chamador já esperava;
 *   • ignora estilos, fórmulas (lê o valor calculado) e células de erro;
 *   • carrega o arquivo inteiro na memória, como o xlsx já fazia.
 * Quem chama deve manter o `xlsx` como reserva — ver `lerLinhas` em comparar-notas.js.
 */
'use strict';

const fs   = require('fs');
const zlib = require('zlib');

// ── ZIP ──────────────────────────────────────────────────────────────────────
// Um .xlsx é um ZIP. Lemos o "central directory" (o índice no fim do arquivo) para
// achar onde cada entrada começa, em vez de descompactar tudo.
const ASSINATURA_EOCD = 0x06054b50;   // End Of Central Directory
const ASSINATURA_CD   = 0x02014b50;   // Central Directory header
const TAM_MAX_COMENTARIO = 65535 + 22; // o EOCD fica nos últimos 64 KB, após o comentário

function lerCentralDirectory(buf) {
    let eocd = -1;
    const limite = Math.max(0, buf.length - TAM_MAX_COMENTARIO);
    for (let i = buf.length - 22; i >= limite; i--) {
        if (buf.readUInt32LE(i) === ASSINATURA_EOCD) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('não é um .xlsx válido (fim do ZIP não encontrado)');

    const nEntradas = buf.readUInt16LE(eocd + 10);
    let off = buf.readUInt32LE(eocd + 16);
    const entradas = Object.create(null);
    for (let i = 0; i < nEntradas; i++) {
        if (off + 46 > buf.length || buf.readUInt32LE(off) !== ASSINATURA_CD) break;
        const metodo   = buf.readUInt16LE(off + 10);
        const tamComp  = buf.readUInt32LE(off + 20);
        const tamNome  = buf.readUInt16LE(off + 28);
        const tamExtra = buf.readUInt16LE(off + 30);
        const tamComm  = buf.readUInt16LE(off + 32);
        const offLocal = buf.readUInt32LE(off + 42);
        const nome = buf.toString('utf8', off + 46, off + 46 + tamNome);
        entradas[nome] = { metodo, tamComp, offLocal };
        off += 46 + tamNome + tamExtra + tamComm;
    }
    return entradas;
}

// O cabeçalho local repete nome e extra com tamanhos próprios: é dele que sai o
// deslocamento real dos bytes comprimidos.
const LIMITE_INFLATE = 1 << 30;   // 1 GB: a worksheet descomprimida passa de 160 MB
function extrair(buf, entrada) {
    if (!entrada) return null;
    const tamNome  = buf.readUInt16LE(entrada.offLocal + 26);
    const tamExtra = buf.readUInt16LE(entrada.offLocal + 28);
    const inicio = entrada.offLocal + 30 + tamNome + tamExtra;
    const bytes = buf.subarray(inicio, inicio + entrada.tamComp);
    if (entrada.metodo === 0) return bytes;                       // store
    if (entrada.metodo === 8) return zlib.inflateRawSync(bytes, { maxOutputLength: LIMITE_INFLATE });
    throw new Error(`compressão ZIP não suportada (método ${entrada.metodo})`);
}

// ── XML ──────────────────────────────────────────────────────────────────────
const RE_ENTIDADE = /&(?:lt|gt|amp|quot|apos|#x?[0-9A-Fa-f]+);/g;
// O Excel grava caracteres de controle literais como _x000D_ (CR), _x000A_ (LF) etc.
// dentro do texto. `sheet_to_json` os devolve decodificados, e aqui fazemos o mesmo.
const RE_ESCAPE_EXCEL = /_x([0-9A-Fa-f]{4})_/g;

function desescapar(s) {
    if (s.indexOf('_x') >= 0) {
        s = s.replace(RE_ESCAPE_EXCEL, (m, hex) => {
            const cod = parseInt(hex, 16);
            return Number.isFinite(cod) ? String.fromCharCode(cod) : m;
        });
    }
    if (s.indexOf('&') < 0) return s;   // caminho rápido: a esmagadora maioria não tem
    return s.replace(RE_ENTIDADE, e => {
        switch (e) {
            case '&lt;': return '<';
            case '&gt;': return '>';
            case '&amp;': return '&';
            case '&quot;': return '"';
            case '&apos;': return "'";
            default:
                const corpo = e.slice(2, -1);
                const cod = corpo[0] === 'x' || corpo[0] === 'X'
                    ? parseInt(corpo.slice(1), 16)
                    : parseInt(corpo, 10);
                return Number.isFinite(cod) ? String.fromCodePoint(cod) : e;
        }
    });
}

// "BC" → 54. A referência da célula ("BC12") começa com as letras da coluna.
function colunaParaIndice(ref) {
    let n = 0;
    for (let i = 0; i < ref.length; i++) {
        const c = ref.charCodeAt(i);
        if (c < 65 || c > 90) break;    // parou nas letras, o resto é a linha
        n = n * 26 + (c - 64);
    }
    return n - 1;
}

// A tabela de strings compartilhadas: todo texto repetido da planilha vive aqui, e as
// células só guardam o índice. Um <si> pode vir partido em vários <t> (texto com
// formatação mista), e nesse caso os pedaços se concatenam.
function lerSharedStrings(xml) {
    const strings = [];
    if (!xml) return strings;
    const reSi = /<si>([\s\S]*?)<\/si>/g;
    const reT  = /<t[^>]*>([\s\S]*?)<\/t>/g;
    let mSi;
    while ((mSi = reSi.exec(xml))) {
        const interno = mSi[1];
        let texto = '', mT;
        reT.lastIndex = 0;
        while ((mT = reT.exec(interno))) texto += mT[1];
        strings.push(desescapar(texto));
    }
    return strings;
}

// ── Leitura ──────────────────────────────────────────────────────────────────
const RE_SHEET = /<sheet[^>]*?name="([^"]*)"[^>]*?r:id="([^"]*)"/g;
const RE_REL   = /<Relationship[^>]*?Id="([^"]*)"[^>]*?Target="([^"]*)"/g;

function localizarWorksheet(buf, zip, nomeAba) {
    const wbXml = extrair(buf, zip['xl/workbook.xml']);
    if (!wbXml) throw new Error('xl/workbook.xml ausente — arquivo não é .xlsx');
    const relsXml = extrair(buf, zip['xl/_rels/workbook.xml.rels']);

    const rels = Object.create(null);
    if (relsXml) {
        const s = relsXml.toString('utf8');
        RE_REL.lastIndex = 0;
        let m;
        while ((m = RE_REL.exec(s))) rels[m[1]] = m[2];
    }

    const abas = [];
    const s = wbXml.toString('utf8');
    RE_SHEET.lastIndex = 0;
    let m;
    while ((m = RE_SHEET.exec(s))) abas.push({ nome: desescapar(m[1]), rid: m[2] });
    if (!abas.length) throw new Error('nenhuma aba declarada em workbook.xml');

    const escolhidas = nomeAba ? abas.filter(a => a.nome === nomeAba) : abas;
    return escolhidas.map(aba => {
        let alvo = rels[aba.rid];
        if (!alvo) return null;
        alvo = alvo.replace(/^\//, '');
        if (!alvo.startsWith('xl/')) alvo = 'xl/' + alvo;
        return { nome: aba.nome, caminho: alvo };
    }).filter(Boolean);
}

// Só as tags que carregam valor. Cada <c> pode ser vazia (<c ... />) ou ter <v>/<is>.
const RE_ROW  = /<row([^>]*)>([\s\S]*?)<\/row>/g;
// Captura a referência INTEIRA ("BC23"): a coluna e a LINHA saem dela. A linha da
// célula é a fonte da posição — ver o comentário em lerLinhasDaWorksheet.
const RE_CELL = /<c r="([A-Z]+)(\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
// <dimension ref="A2:DK29"> — a linha inicial da área usada da aba.
const RE_DIMENSION = /<dimension[^>]*\bref="[A-Z]+(\d+)/;
const RE_ATTR_T = /\bt="([^"]*)"/;
const RE_V   = /<v>([\s\S]*?)<\/v>/;
const RE_T_G = /<t[^>]*>([\s\S]*?)<\/t>/g;

function lerLinhasDaWorksheet(xml, shared) {
    const linhas = [];
    let maxIdx = -1;
    // Uma aba pode começar abaixo da primeira linha (<dimension ref="A2:DK29">, típico de
    // tabela dinâmica). `sheet_to_json` normaliza isso para a origem, e este leitor faz o
    // mesmo — senão as linhas sairiam deslocadas em relação ao que o chamador espera.
    // A tag vive no cabeçalho da worksheet; olhar só o começo evita varrer 160 MB.
    const mDim = RE_DIMENSION.exec(xml.slice(0, 2048));
    const linhaBase = mDim ? (parseInt(mDim[1], 10) - 1) : 0;

    RE_ROW.lastIndex = 0;
    let mRow;
    while ((mRow = RE_ROW.exec(xml))) {
        // Cada célula é posicionada pela PRÓPRIA referência ("C23" → linha 23, coluna C),
        // nunca pela contagem de linhas (as vazias são omitidas do XML) nem pelo atributo
        // r= da <row>. Os dois podem discordar: esta planilha tem uma <row r="22"> cujas
        // células são A23/B23/C23, e vale a 23 — é onde o Excel e o xlsx mostram o dado.
        RE_CELL.lastIndex = 0;
        let mCell;
        while ((mCell = RE_CELL.exec(mRow[2]))) {
            const interno = mCell[4];
            if (interno === undefined) continue;     // <c ... /> sem conteúdo

            const col = colunaParaIndice(mCell[1]);
            const idx = (+mCell[2] - 1) - linhaBase;
            if (idx < 0 || col < 0) continue;        // fora da dimensão declarada

            let valor;
            const mT = RE_ATTR_T.exec(mCell[3]);
            const tipo = mT ? mT[1] : 'n';

            if (tipo === 'inlineStr') {              // texto embutido, sem sharedStrings
                let texto = '', m;
                RE_T_G.lastIndex = 0;
                while ((m = RE_T_G.exec(interno))) texto += m[1];
                valor = desescapar(texto);
            } else {
                const mV = RE_V.exec(interno);
                if (!mV) continue;
                const bruto = mV[1];
                if (tipo === 's') {                  // índice na tabela compartilhada
                    valor = shared[+bruto];
                } else if (tipo === 'str' || tipo === 'e') {
                    valor = desescapar(bruto);       // fórmula em texto / erro (#N/A)
                } else if (tipo === 'b') {
                    valor = bruto === '1';
                } else {
                    // Numérico — inclui datas, que ficam como SERIAL do Excel. É o que o
                    // chamador já recebia com `cellDates: false`.
                    const n = +bruto;
                    valor = Number.isNaN(n) ? bruto : n;
                }
            }

            let linha = linhas[idx];
            if (!linha) linha = linhas[idx] = [];
            linha[col] = valor;
            if (idx > maxIdx) maxIdx = idx;
        }
    }

    // Buracos viram [] para o chamador poder iterar sem checar null.
    for (let i = 0; i <= maxIdx; i++) if (!linhas[i]) linhas[i] = [];
    return linhas;
}

/**
 * Lê um .xlsx e devolve as linhas de cada aba, como sheet_to_json(..., {header:1}).
 * @param {string} caminho  arquivo .xlsx
 * @param {string} [nomeAba]  se dado, lê só essa aba
 * @returns {Array<{ nome: string, linhas: Array<Array<any>> }>}
 */
function lerAbas(caminho, nomeAba) {
    const buf = fs.readFileSync(caminho);
    const zip = lerCentralDirectory(buf);

    const ss = extrair(buf, zip['xl/sharedStrings.xml']);
    const shared = lerSharedStrings(ss ? ss.toString('utf8') : '');

    const alvos = localizarWorksheet(buf, zip, nomeAba);
    const saida = [];
    for (const alvo of alvos) {
        const ws = extrair(buf, zip[alvo.caminho]);
        if (!ws) continue;
        saida.push({ nome: alvo.nome, linhas: lerLinhasDaWorksheet(ws.toString('utf8'), shared) });
    }
    return saida;
}

module.exports = { lerAbas };
