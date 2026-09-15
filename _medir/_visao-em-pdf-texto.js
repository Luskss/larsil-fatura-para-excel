/**
 * _medir/_visao-em-pdf-texto.js — e nos PDFs COM texto, a visão ganharia?
 *
 * Pergunta do usuário (11/09/2026): a medição de 10/09 só olhou PDF-imagem, onde a
 * visão ganhou de lavada (0 campos → 37). Para PDF com texto nativo o código
 * AFIRMA, em três comentários, que "trocar por reconhecimento visual seria trocar
 * exato por inferido" — mas isso nunca foi MEDIDO. É raciocínio, e raciocínio
 * plausível já foi reprovado três vezes neste projeto (ver
 * [[inspecao-anima-medicao-decide]]).
 *
 * Há dois motivos concretos para duvidar do raciocínio:
 *
 *   1. `pdf-parse` entrega texto PLANO — o layout morre. É a causa dos bugs de
 *      §15.1/§15.2 (ISSQN 179,43 × COFINS 179,43, indistinguíveis em texto puro) e
 *      da reprovação do `getTable`. A visão VÊ a tabela. O "exato" do texto é
 *      exato em CARACTERES, não em ATRIBUIÇÃO de campo.
 *   2. O caminho de texto usa `gpt-4o-mini` FIXO (_nf-ai-full.js:323) — o mesmo
 *      modelo reprovado na imagem por DEFORMAR números. Se ele deforma lendo
 *      imagem, é preciso saber se deforma lendo texto.
 *
 * Por isso a medição tem QUATRO vias sobre os MESMOS PDFs com texto nativo:
 *
 *   (a) PARSER    — determinístico puro (classify + parser do tipo + chave + boleto)
 *   (b) TEXTO-4o  — o que a PRODUÇÃO faz hoje: extrairNotaAI, gpt-4o-mini
 *   (c) TEXTO-4.1 — mesmo texto, mesmo prompt, gpt-4.1-mini (isola o MODELO)
 *   (d) VISÃO     — a página rasterizada + gpt-4.1-mini (isola a ENTRADA)
 *
 * (c) existe para não confundir as duas variáveis. Se (d) ganhar de (b), pode ser a
 * imagem OU pode ser só o modelo melhor — e trocar o modelo é de graça, enquanto
 * rasterizar 6.000 documentos não é. (c) separa as duas coisas.
 *
 * GABARITO: o mesmo das medições anteriores — o valor no NOME DO ARQUIVO, digitado
 * à mão pela equipe a partir do papel. Leitura independente da IA.
 *
 * O que decide é **DIVERGE**, não campos preenchidos: campo vazio é lacuna
 * visível, valor errado é dano silencioso. E medimos as DUAS metades — o que cada
 * via ganha E o que ela perde em relação à produção (ver [[inspecao-anima-medicao-decide]]:
 * só o ganho é meia-medição).
 *
 * Uso: node _medir/_visao-em-pdf-texto.js [quantos]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const h = require('./harness');
const { PDFParse } = require('pdf-parse');
const parsers = require('../routes/_nf-parsers');
const visao = require('../routes/_nf-visao');
const { callOpenAI } = require('../routes/_helpers');

const RAIZ_ARQ = process.env.ARQUIVO_PATH || process.env.MONITOR_PATH;
const PASTA = '2026.03.EXTRATOS CONTABILIDADE';
const QUANTOS = parseInt(process.argv[2], 10) || 20;

// Preços em US$/MTok (entrada, saída), consultados em 10/09/2026.
const PRECO = { 'gpt-4o-mini': [0.15, 0.60], 'gpt-4.1-mini': [0.40, 1.60] };

// ── O gabarito ───────────────────────────────────────────────────────────────
// Mesma função das medições anteriores, copiada de propósito: se ela mudar lá, a
// comparação entre medições de dias diferentes deixa de ser comparável.
function valorDoNomeArquivo(nome) {
    const n = String(nome || '');
    const m = n.match(/\.DOC-?\s*(?:R\$\s*)?(\d{1,3}(?:\.\d{3})+,\d{2})/i)
           || n.match(/\.DOC-?\s*(?:R\$\s*)?(\d+,\d{2})/i)
           || n.match(/\.DOC-?\s*(?:R\$\s*)?(\d{1,3}(?:\.\d{3})+)(?![\d,])/i);
    if (!m) return null;
    if (/^\d{8}$/.test(m[1])) return null;
    const v = Number(m[1].replace(/\./g, '').replace(',', '.'));
    return Number.isFinite(v) && v > 0 ? v : null;
}

function listar(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const q = path.join(dir, e.name);
        if (e.isDirectory()) listar(q, out);
        else if (/\.pdf$/i.test(e.name)) out.push(q);
    }
    return out;
}
const ehAnexo = n => /^\s*\d+\s*[.\-]\s*CPV\b/i.test(n) || /^0+\s*[.\-]/.test(n);

async function textoDoPdf(buf) {
    const pr = new PDFParse({ data: new Uint8Array(buf) });
    try { const r = await pr.getText(); return { texto: r.text || '', paginas: r.total || 0 }; }
    catch (e) { return { texto: '', paginas: 0 }; }
    finally { try { await pr.destroy(); } catch (_) {} }
}

// Número no formato brasileiro → float. MESMA lógica de `_nf-visao.num`: a forma é
// decidida pelo ÚLTIMO separador, senão "17.904,40" vira 17,90.
const num = v => {
    if (v == null) return null;
    if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : null;
    let s = String(v).replace(/[^\d.,-]/g, '').trim();
    if (!s) return null;
    const uv = s.lastIndexOf(','), up = s.lastIndexOf('.');
    if (uv > up) s = s.replace(/\./g, '').replace(',', '.');
    else if (up > uv) {
        s = s.replace(/,/g, '');
        const p = s.split('.');
        if (p.length > 2 || (p.length === 2 && p[1].length === 3)) s = p.join('');
    }
    const n = Number(s);
    return Number.isFinite(n) && n > 0 ? n : null;
};

// ── O prompt de TEXTO da produção, recortado do módulo ───────────────────────
// `_nf-ai-full.js` não exporta FULL_PROMPT nem aceita modelo por parâmetro. Em vez
// de editar a produção para medir (ou de fazer monkey-patch em
// `getActiveAiProvider`, que o módulo congela no require — a armadilha de
// [[modelo-visao-medido-nao-suposto]]), lemos a constante do fonte. Assim (b) e (c)
// usam exatamente o prompt que roda hoje, e a produção fica intocada.
function promptDeTexto() {
    const src = fs.readFileSync(path.join(h.RAIZ, 'routes', '_nf-ai-full.js'), 'utf8');
    const m = src.match(/const FULL_PROMPT\s*=\s*`([\s\S]*?)`;/);
    if (!m) throw new Error('não achei FULL_PROMPT em _nf-ai-full.js — fonte mudou?');
    return m[1];
}

// ── ENVIO CRU DA IMAGEM ──────────────────────────────────────────────────────
// A pergunta do usuário é sobre mandar a PÁGINA direto para o modelo, e não sobre
// o pipeline de visão. `lerPorVisao` faz duas coisas DEPOIS da resposta que na
// medição de OCR eram inofensivas e aqui não são:
//
//   1. sobrescreve o valor pela LINHA DIGITÁVEL quando acha 47 dígitos. Em
//      PDF-imagem isso CORRIGIA a leitura (boleto Itaú torto, §15.12); num pacote
//      "recibo + boleto anexo" ela pega o boleto, que não é o documento principal.
//      Foi o que errou o caso PREFEITURA (1.413,09 no lugar de 45,62).
//   2. manda só MAX_PAGINAS=2. Num pacote fatura+NF+boleto o documento principal
//      pode estar na 3ª página e o modelo nunca o vê.
//
// Estas vias tiram as duas coisas: PNG das páginas → modelo → JSON, nada entre.
// Mesmo prompt de visão (o que a produção usa), para a variável ser só a ENTRADA.
function promptDeVisao() {
    const src = fs.readFileSync(path.join(h.RAIZ, 'routes', '_nf-visao.js'), 'utf8');
    const m = src.match(/const PROMPT\s*=\s*`([\s\S]*?)`;/);
    if (!m) throw new Error('não achei PROMPT em _nf-visao.js — fonte mudou?');
    return m[1];
}

async function lerPorImagemCru(prompt, buf, modelo, maxPaginas) {
    const key = String(process.env.OPENAI_API_KEY || '').trim();
    if (!key) return { erro: 'sem OPENAI_API_KEY' };
    let imagens;
    try { imagens = await visao.paginasEmPng(buf, maxPaginas); }
    catch (e) { return { erro: `rasterização falhou: ${e.message}` }; }
    if (!imagens.length) return { erro: 'nenhuma página rasterizada' };
    const content = imagens.map(b64 => ({ type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } }));
    content.push({ type: 'text', text: 'Leia este documento e devolva o JSON.' });
    const r = await callOpenAI(key, {
        model: modelo, response_format: { type: 'json_object' },
        temperature: 0, max_tokens: 1500,
        messages: [{ role: 'system', content: prompt }, { role: 'user', content }],
    });
    if (!r.ok || r.httpCode < 200 || r.httpCode >= 300) return { erro: `HTTP ${r.httpCode} ${r.error || ''}`.trim() };
    let body; try { body = JSON.parse(r.body); } catch (_) { return { erro: 'resposta não-JSON' }; }
    const txt = body?.choices?.[0]?.message?.content ?? '';
    let j = null;
    try { j = JSON.parse(txt); } catch (_) {
        const s = txt.indexOf('{'), e = txt.lastIndexOf('}');
        if (s >= 0 && e > s) { try { j = JSON.parse(txt.slice(s, e + 1)); } catch (_) {} }
    }
    return j ? { dados: j, uso: body.usage || {}, nPaginas: imagens.length } : { erro: 'JSON inválido', uso: body.usage || {} };
}

async function lerPorTexto(prompt, texto, nome, paginas, modelo) {
    const key = String(process.env.OPENAI_API_KEY || '').trim();
    if (!key) return { erro: 'sem OPENAI_API_KEY' };
    let t = String(texto || '');
    if (t.length > 14000) t = t.slice(0, 14000);   // MAX_CHARS da produção
    const r = await callOpenAI(key, {
        model: modelo,
        response_format: { type: 'json_object' },
        temperature: 0, max_tokens: 4000,
        messages: [
            { role: 'system', content: prompt },
            { role: 'user', content: `Arquivo: ${nome}\nPáginas: ${paginas}\n\nTexto do documento:\n----------\n${t}\n----------` },
        ],
    });
    if (!r.ok || r.httpCode < 200 || r.httpCode >= 300) return { erro: `HTTP ${r.httpCode} ${r.error || ''}`.trim() };
    let body; try { body = JSON.parse(r.body); } catch (_) { return { erro: 'resposta não-JSON' }; }
    const txt = body?.choices?.[0]?.message?.content ?? '';
    let j = null;
    try { j = JSON.parse(txt); } catch (_) {
        const s = txt.indexOf('{'), e = txt.lastIndexOf('}');
        if (s >= 0 && e > s) { try { j = JSON.parse(txt.slice(s, e + 1)); } catch (_) {} }
    }
    return j ? { dados: j, uso: body.usage || {} } : { erro: 'JSON inválido', uso: body.usage || {} };
}

// O valor do documento segundo o JSON da IA de TEXTO. O schema do FULL_PROMPT é
// camelCase (`valorTotal`), diferente do parser determinístico, que usa
// snake_case (`valor_total`) — conferido no fonte, não suposto: ler a chave errada
// daria "sem valor" em 100% dos documentos e a comparação seria lixo.
const valorDoTexto = d => num(d.valorTotal);

const preencheu = v => v != null && String(v).trim() !== '' && String(v).trim() !== '—' && String(v).trim() !== '0';

(async () => {
    const prompt = promptDeTexto();
    console.log(`amostra alvo: ${QUANTOS} PDFs COM texto nativo   pasta: ${PASTA}\n`);

    // Mesma seleção por passo fixo das medições anteriores: a ordem da pasta agrupa
    // por subpasta/banco, então os N primeiros seriam uma amostra enviesada. Passo
    // fixo espalha pela pasta inteira e é reproduzível (sorteio não seria).
    const todos = listar(path.join(RAIZ_ARQ, PASTA)).filter(p => !ehAnexo(path.basename(p)));
    const passo = Math.max(1, Math.floor(todos.length / (QUANTOS * 8)));
    const ordem = [];
    for (let i = 0; i < todos.length; i += passo) ordem.push(todos[i]);
    for (const x of todos) if (!ordem.includes(x)) ordem.push(x);

    // Só PDF COM texto nativo E com gabarito no nome: sem gabarito não há como
    // dizer quem acertou, e o documento só gastaria chamada de API.
    //
    // ── TETO POR LAYOUT (o conserto de uma primeira amostra ruim) ────────────
    // A primeira rodada (24 docs) trouxe 20 extratos de consórcio Rodobens, todos
    // do MESMO layout: o passo fixo caiu dentro de um bloco homogêneo da pasta.
    // Isso é amostra de tamanho 1 com aparência de 24 — exatamente o erro que
    // [[inspecao-anima-medicao-decide]] registra. A assinatura do layout aqui é o
    // trecho do nome depois do valor (". EMITENTE. TIPO" ou "Grupo NNN Cota"),
    // que a equipe digita por fornecedor. No máximo 3 por assinatura: o resultado
    // passa a falar do ACERVO, não de um fornecedor.
    const assinatura = n => {
        const s = String(n).replace(/\.pdf$/i, '');
        if (/Grupo\s+\d+/i.test(s)) return 'consorcio-rodobens';
        const m = s.match(/\d{4}\.\d{2}\.\d{2}\.?\s*([A-Za-zÀ-ú ]{3,})/);
        if (m) return 'emit:' + m[1].trim().toUpperCase().slice(0, 14);
        const m2 = s.match(/-\s*([A-Za-zÀ-ú][A-Za-zÀ-ú ]{2,})/);
        return m2 ? 'txt:' + m2[1].trim().toUpperCase().slice(0, 14) : 'outro:' + s.slice(0, 8);
    };
    const MAX_POR_LAYOUT = 3;

    const alvos = [];
    const porLayout = {};
    console.error('[texto] selecionando PDFs com texto nativo e gabarito (máx. 3 por layout)...');
    for (const abs of ordem) {
        if (alvos.length >= QUANTOS) break;
        const nome = path.basename(abs);
        const gab = valorDoNomeArquivo(nome);
        if (!gab) continue;
        const a = assinatura(nome);
        if ((porLayout[a] || 0) >= MAX_POR_LAYOUT) continue;
        const buf = fs.readFileSync(abs);
        const { texto, paginas } = await textoDoPdf(buf);
        if (texto.replace(/\s/g, '').length < 15) continue;   // é imagem, já medido
        porLayout[a] = (porLayout[a] || 0) + 1;
        alvos.push({ buf, nome, texto, paginas, gab, layout: a });
    }
    console.log(`selecionados: ${alvos.length} em ${Object.keys(porLayout).length} layouts distintos`);
    console.log(Object.entries(porLayout).map(([k, v]) => `${k}:${v}`).join('  ') + '\n');

    const promptV = promptDeVisao();
    // `img-cru`   = página → modelo, sem trava de linha digitável, teto de 2 páginas
    //               (isola o pós-processamento de `lerPorVisao`)
    // `img-todas` = o mesmo, mas com TODAS as páginas do PDF (até 8)
    //               (isola o teto de páginas, para pacote fatura+NF+boleto)
    const VIAS = ['parser', 'texto-4o', 'texto-4.1', 'visao', 'img-cru', 'img-todas'];
    const acc = {};
    for (const v of VIAS) acc[v] = { bate: 0, parcela: 0, diverge: 0, semValor: 0, erro: 0, campos: 0, tokIn: 0, tokOut: 0 };
    const linhas = [];

    for (const a of alvos) {
        console.error(`  ${a.nome.slice(0, 52)}`);
        const reg = { nome: a.nome, gab: a.gab, r: {} };

        // (a) PARSER determinístico — o mesmo encadeamento de process-folder.js:584
        {
            const c = parsers.classify(a.texto, a.nome);
            const d = parsers.enriquecerComBoleto(
                parsers.enriquecerComChaveAcesso(c.parser ? c.parser(a.texto) : null, a.texto), a.texto) || {};
            const v = num(d.valor_total) ?? num(d.valorTotal) ?? num(d.valor) ?? null;
            const ver = visao.conferirValor(v, a.gab);
            acc.parser.campos += Object.values(d).filter(preencheu).length;
            acc.parser[ver === 'bate' ? 'bate' : ver === 'parcela' ? 'parcela'
                : ver === 'diverge' ? 'diverge' : 'semValor']++;
            reg.r['parser'] = { veredito: ver, valor: v, nCampos: Object.values(d).filter(preencheu).length, tipo: c.tipo };
        }

        // (b) e (c) TEXTO — mesma entrada e mesmo prompt, modelos diferentes
        for (const [via, modelo] of [['texto-4o', 'gpt-4o-mini'], ['texto-4.1', 'gpt-4.1-mini']]) {
            const r = await lerPorTexto(prompt, a.texto, a.nome, a.paginas, modelo);
            const ac = acc[via];
            if (r.uso) { ac.tokIn += r.uso.prompt_tokens || 0; ac.tokOut += r.uso.completion_tokens || 0; }
            if (r.erro) { ac.erro++; reg.r[via] = { erro: r.erro }; continue; }
            const v = valorDoTexto(r.dados);
            const ver = visao.conferirValor(v, a.gab);
            // Os 5 campos do schema camelCase do FULL_PROMPT, para contar campos na
            // mesma base que as outras vias (emitente, doc, número, data, valor).
            const n = ['emitente', 'cnpj', 'numeroDocumento', 'dataEmissao', 'valorTotal']
                .filter(k => preencheu(r.dados[k])).length;
            ac.campos += n;
            ac[ver === 'bate' ? 'bate' : ver === 'parcela' ? 'parcela' : ver === 'diverge' ? 'diverge' : 'semValor']++;
            reg.r[via] = { veredito: ver, valor: v, nCampos: n, tipo: r.dados.tipo };
        }

        // (d) VISÃO — a MESMA página, como imagem. `lerPorVisao` já aplica a trava
        // do gabarito; pedimos o veredito cru para comparar em igualdade.
        {
            let r;
            try { r = await visao.lerPorVisao(a.buf, a.nome, a.gab, 'openai', 'gpt-4.1-mini'); }
            catch (e) { r = { erro: e.message }; }
            const ac = acc.visao;
            if (r.uso) { ac.tokIn += r.uso.prompt_tokens || 0; ac.tokOut += r.uso.completion_tokens || 0; }
            if (r.erro) { ac.erro++; reg.r['visao'] = { erro: r.erro }; }
            else {
                const v = num(r.campos['Valor total']) ?? num(r.campos['Valor lido (não confere com o nome)']);
                ac.campos += Object.keys(r.campos).length;
                ac[r.veredito === 'bate' ? 'bate' : r.veredito === 'parcela' ? 'parcela'
                   : r.veredito === 'diverge' ? 'diverge' : 'semValor']++;
                reg.r['visao'] = { veredito: r.veredito, valor: v, nCampos: Object.keys(r.campos).length,
                                   tipo: r.tipo, origem: r.campos['Origem do valor (visão)'] };
            }
        }

        // (e) e (f) IMAGEM CRUA — a página direto para o modelo. Sem parser antes,
        // sem trava de linha digitável depois, sem nada entre o PNG e o JSON. É a
        // pergunta do usuário na forma mais literal.
        for (const [via, maxPg] of [['img-cru', 2], ['img-todas', 8]]) {
            const r = await lerPorImagemCru(promptV, a.buf, 'gpt-4.1-mini', maxPg);
            const ac = acc[via];
            if (r.uso) { ac.tokIn += r.uso.prompt_tokens || 0; ac.tokOut += r.uso.completion_tokens || 0; }
            if (r.erro) { ac.erro++; reg.r[via] = { erro: r.erro }; continue; }
            const d = r.dados;
            // Ilegível declarado é resposta válida, não acerto nem erro.
            if (d.legivel === false) { ac.erro++; reg.r[via] = { erro: 'IA marcou ilegível' }; continue; }
            const v = num(d.valorTotal) ?? num(d.valorLiquido);
            const ver = visao.conferirValor(v, a.gab);
            const n = ['emitente', 'cnpjEmitente', 'numero', 'dataEmissao', 'valorTotal']
                .filter(k => preencheu(d[k])).length;
            ac.campos += n;
            ac[ver === 'bate' ? 'bate' : ver === 'parcela' ? 'parcela' : ver === 'diverge' ? 'diverge' : 'semValor']++;
            reg.r[via] = { veredito: ver, valor: v, nCampos: n, tipo: d.tipo,
                           origem: d.ondeAcheiOValor, nPg: r.nPaginas };
        }

        linhas.push(reg);
    }

    // ── documento a documento ────────────────────────────────────────────────
    console.log('┌─ documento a documento ────────────────────────────────────');
    for (const l of linhas) {
        console.log(`│ ${l.nome.slice(0, 58)}   gabarito=${l.gab}`);
        for (const v of VIAS) {
            const r = l.r[v];
            if (!r) continue;
            if (r.erro) { console.log(`│   ${v.padEnd(10)} ERRO: ${String(r.erro).slice(0, 42)}`); continue; }
            const marca = r.veredito === 'bate' ? '✓' : r.veredito === 'diverge' ? '✗' : '·';
            console.log(`│   ${v.padEnd(10)} ${marca} ${String(r.veredito).padEnd(13)} valor=${String(r.valor ?? '—').padStart(11)}  campos=${r.nCampos}  ${String(r.tipo || '').slice(0, 12)}`);
            if (/^(visao|img-)/.test(v) && r.veredito === 'diverge' && r.origem)
                console.log(`│                leu de: "${String(r.origem).slice(0, 46)}"`);
        }
    }
    console.log('└────────────────────────────────────────────────────────────\n');

    // ── resumo ───────────────────────────────────────────────────────────────
    console.log(`RESUMO (n = ${alvos.length}, todos COM texto nativo e com gabarito)`);
    console.log('via         bate  parc  DIVERGE  s/valor  erro  campos   custo/1.000 docs');
    for (const v of VIAS) {
        const a = acc[v];
        const modelo = v === 'parser' ? null : v === 'texto-4o' ? 'gpt-4o-mini' : 'gpt-4.1-mini';
        let custo = '—';
        if (modelo && alvos.length) {
            const [ci, co] = PRECO[modelo];
            custo = 'US$' + ((((a.tokIn / alvos.length) / 1e6) * ci + ((a.tokOut / alvos.length) / 1e6) * co) * 1000).toFixed(2);
        }
        console.log(v.padEnd(12) + String(a.bate).padStart(4) + String(a.parcela).padStart(6) +
            String(a.diverge).padStart(9) + String(a.semValor).padStart(9) + String(a.erro).padStart(6) +
            String(a.campos).padStart(8) + custo.padStart(19));
    }

    // ── as DUAS metades: onde cada via GANHA e onde PERDE contra a produção ──
    // Só o ganho é meia-medição. Foi na coluna de PERDAS que as três alternativas
    // de 10/09 foram reprovadas.
    const bom = x => x === 'bate' || x === 'parcela';
    console.log('\n── contra a PRODUÇÃO de hoje (texto-4o) ─────────────────────');
    for (const v of ['texto-4.1', 'visao', 'img-cru', 'img-todas', 'parser']) {
        const ganhou = linhas.filter(l => l.r[v] && l.r['texto-4o'] && bom(l.r[v].veredito) && !bom(l.r['texto-4o'].veredito));
        const perdeu = linhas.filter(l => l.r[v] && l.r['texto-4o'] && !bom(l.r[v].veredito) && bom(l.r['texto-4o'].veredito));
        console.log(`${v.padEnd(11)} GANHA ${String(ganhou.length).padStart(2)}   PERDE ${String(perdeu.length).padStart(2)}   líquido ${ganhou.length - perdeu.length > 0 ? '+' : ''}${ganhou.length - perdeu.length}`);
        for (const l of ganhou) console.log(`   + ${l.nome.slice(0, 54)}  (4o: ${l.r['texto-4o'].veredito} ${l.r['texto-4o'].valor ?? '—'} → ${l.r[v].valor ?? '—'})`);
        for (const l of perdeu) console.log(`   − ${l.nome.slice(0, 54)}  (4o: ${l.r['texto-4o'].valor ?? '—'} → ${l.r[v].veredito} ${l.r[v].valor ?? '—'})`);
    }

    // Deformação de número: o erro que o gabarito NÃO pega quando cai perto. É o
    // motivo pelo qual o 4o-mini foi descartado na imagem — medir se acontece no texto.
    console.log('\n── truncamento de milhar (erro de ESCALA, não de campo) ─────');
    for (const v of VIAS) {
        const t = linhas.filter(l => l.r[v] && l.r[v].valor && visao.pareceTruncamentoDeMilhar(l.r[v].valor, l.gab));
        console.log(`${v.padEnd(11)} ${t.length}` + (t.length ? '   ' + t.map(l => `${l.r[v].valor}←${l.gab}`).join(', ') : ''));
    }

    console.log('\nDIVERGE é o número que decide. Campo vazio é lacuna visível;');
    console.log('valor errado é dano silencioso. Custo só desempata empate de qualidade.');
    process.exit(0);
})();
