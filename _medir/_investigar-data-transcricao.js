/**
 * _medir/_investigar-data-transcricao.js — por que a data erra na transcrição?
 *
 * `_transcrever-pdf-imagem.js` aprovou a transcrição nos PDF-imagem (valor: 14/16
 * certos contra 0 hoje) mas deixou **4 erros de DATA em 4 casos com gabarito**.
 * Antes de integrar é preciso saber QUAL das duas causas:
 *
 *   (A) a IA transcreveu a data errada da página  → problema de LEITURA
 *   (B) a página não tem data de emissão e o `FULL_PROMPT` manda deduzir do NOME
 *       DO ARQUIVO (a instrução da linha 95: "ou a data do nome do arquivo")
 *       → problema de PROMPT, o defeito de [[ia-le-nome-do-arquivo-sem-ocr]]
 *
 * A distinção decide o conserto. Se for (B), a data não deveria vir da IA de jeito
 * nenhum: [[data-do-documento-vem-da-pasta]] diz que a data do documento vem da
 * SUBPASTA, que é criada pelo processo de arquivamento e não digitada.
 *
 * Para cada um dos 4 documentos, imprime:
 *   · o gabarito de data (do nome do arquivo)
 *   · TODAS as datas presentes na transcrição
 *   · a data que a extração devolveu
 *   · se essa data aparece na transcrição (leu da página) ou não (inventou/deduziu)
 *
 * SOMENTE LEITURA.
 *
 * Uso: node _medir/_investigar-data-transcricao.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const h = require('./harness');
const j = require('./_julgar-campos');
const visao = require('../routes/_nf-visao');
const { callOpenAI } = require('../routes/_helpers');

const RAIZ_ARQ = process.env.ARQUIVO_PATH || process.env.MONITOR_PATH;
const MODELO_TRANS = 'gpt-4.1-mini';
const MAX_PG = 3;

// Os 4 documentos com d✗ na medição de PDF-imagem.
const ALVOS = [
    '135.DOC- 13209,83-2026.03.02.ITAU. DOC.240123112520 13',
    '002.DOC- 52610,67-2026.03.04.FN.SANTANDER.FT7900 52610',
    '003.DOC- 20817,18-2026.01.26 HDI Apólice HDI Frota',
    '065.DOC- 4675,17-2025.10.28 HDI SEGUROS.',
];

const PROMPT_TRANSCRICAO = `Você é um OCR. Transcreva LITERALMENTE todo o texto visível nesta página.

REGRAS ABSOLUTAS:
· Copie cada caractere como está impresso. NÃO resuma, NÃO interprete, NÃO reordene.
· NÃO explique, NÃO comente, NÃO adicione cabeçalhos seus. Só o texto do papel.
· Preserve NÚMEROS exatamente: "17.904,40" se transcreve "17.904,40" — não
  17904.40, não 17,90. O ponto de milhar e a vírgula decimal ficam como estão.
· Preserve a ORDEM de leitura e a separação em linhas. Em tabela, mantenha cada
  linha da tabela numa linha do texto, com os campos separados por espaços.
· Preserve RÓTULOS junto de seus valores ("Valor Total da Nota  R$ 1.234,56").
  O rótulo é o que permite identificar o campo depois — nunca o omita.
· Transcreva TODOS os números da página, inclusive os que parecem irrelevantes.
· Códigos de barras / linha digitável: copie a sequência de dígitos como impressa.
· Se algo estiver ilegível, escreva [ilegível] naquele ponto e siga.

Devolva APENAS o texto transcrito, em texto puro, sem markdown e sem JSON.`;

async function umaPagina(b64, i, total) {
    const key = String(process.env.OPENAI_API_KEY || '').trim();
    const r = await callOpenAI(key, {
        model: MODELO_TRANS, temperature: 0, max_tokens: 8000,
        messages: [
            { role: 'system', content: PROMPT_TRANSCRICAO },
            { role: 'user', content: [
                { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } },
                { type: 'text', text: `Transcreva o texto desta página (página ${i} de ${total}).` },
            ] },
        ],
    });
    if (!r.ok || r.httpCode < 200 || r.httpCode >= 300) return { erro: `HTTP ${r.httpCode}` };
    let body; try { body = JSON.parse(r.body); } catch (_) { return { erro: 'não-JSON' }; }
    return { texto: body?.choices?.[0]?.message?.content ?? '' };
}

async function transcrever(buf, maxPg) {
    let imgs;
    try { imgs = await visao.paginasEmPng(buf, maxPg); } catch (e) { return { erro: e.message }; }
    if (!imgs.length) return { erro: 'não rasterizou' };
    const partes = [];
    for (let i = 0; i < imgs.length; i++) {
        const r = await umaPagina(imgs[i], i + 1, imgs.length);
        if (!r.erro) partes.push(`=== página ${i + 1} ===\n${r.texto}`);
    }
    return partes.length ? { texto: partes.join('\n\n') } : { erro: 'todas falharam' };
}

function promptExtracao() {
    const src = fs.readFileSync(path.join(h.RAIZ, 'routes', '_nf-ai-full.js'), 'utf8');
    const m = src.match(/const FULL_PROMPT\s*=\s*`([\s\S]*?)`;/);
    return m[1];
}

// Extrai com o prompt REAL e, para comparar, com o prompt SEM a cláusula do nome
// do arquivo — é o teste que separa a causa (A) da (B).
async function extrair(prompt, texto, nome, paginas) {
    const key = String(process.env.OPENAI_API_KEY || '').trim();
    let t = String(texto || '');
    if (t.length > 14000) t = t.slice(0, 14000);
    const r = await callOpenAI(key, {
        model: 'gpt-4o-mini', response_format: { type: 'json_object' }, temperature: 0, max_tokens: 4000,
        messages: [{ role: 'system', content: prompt },
                   { role: 'user', content: `Arquivo: ${nome}\nPáginas: ${paginas}\n\nTexto do documento:\n----------\n${t}\n----------` }],
    });
    if (!r.ok) return { erro: `HTTP ${r.httpCode}` };
    let body; try { body = JSON.parse(r.body); } catch (_) { return { erro: 'não-JSON' }; }
    const txt = body?.choices?.[0]?.message?.content ?? '';
    let d = null;
    try { d = JSON.parse(txt); } catch (_) {
        const s = txt.indexOf('{'), e = txt.lastIndexOf('}');
        if (s >= 0 && e > s) { try { d = JSON.parse(txt.slice(s, e + 1)); } catch (_) {} }
    }
    return d ? { lido: j.normaliza(d) } : { erro: 'JSON inválido' };
}

const RE_DATA = /\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4}/g;

(async () => {
    const promptReal = promptExtracao();
    // Variante SEM a cláusula "(ou a data do nome do arquivo)": se a data mudar,
    // a causa era o PROMPT deduzindo do nome (B), não a leitura da página (A).
    const promptSemNome = promptReal
        .replace('• dataEmissao   → data de emissão do documento "DD/MM/AAAA" (ou a data do nome do arquivo).',
                 '• dataEmissao   → data de emissão do documento "DD/MM/AAAA", COPIADA DO TEXTO.\n' +
                 '                  Se o texto não traz data de emissão, devolva "" — NUNCA deduza do nome do arquivo.');
    if (promptSemNome === promptReal) throw new Error('não achei a cláusula da data no FULL_PROMPT — fonte mudou?');

    // acha os arquivos
    const idx = new Map();
    (function anda(d) {
        let e; try { e = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
        for (const x of e) { const q = path.join(d, x.name);
            if (x.isDirectory()) anda(q); else if (/\.pdf$/i.test(x.name) && !idx.has(x.name)) idx.set(x.name, q); }
    })(RAIZ_ARQ);

    for (const alvo of ALVOS) {
        const achado = [...idx.entries()].find(([n]) => n.startsWith(alvo.slice(0, 40)));
        if (!achado) { console.log(`\n✗ não achei: ${alvo}\n`); continue; }
        const [nome, abs] = achado;
        const buf = fs.readFileSync(abs);
        const g = j.gabaritos(nome);

        console.log(`\n${'═'.repeat(70)}`);
        console.log(nome.slice(0, 68));
        console.log(`pasta: ${path.relative(RAIZ_ARQ, abs).split(path.sep)[0]}`);
        console.log(`gabarito de data (do nome): ${g.data ? new Date(g.data).toISOString().slice(0, 10) : '—'}`);

        const t = await transcrever(buf, MAX_PG);
        if (t.erro) { console.log(`transcrição falhou: ${t.erro}`); continue; }

        const datasNaTranscricao = [...new Set(String(t.texto).match(RE_DATA) || [])];
        console.log(`\ndatas PRESENTES na transcrição (${datasNaTranscricao.length}):`);
        console.log('   ' + (datasNaTranscricao.slice(0, 14).join('   ') || '(NENHUMA)'));

        // Há rótulo de emissão na transcrição?
        const up = String(t.texto).toUpperCase();
        const temRotulo = ['EMISS', 'DATA DE EMISS', 'EMITID'].some(r => up.includes(r));
        console.log(`rótulo de EMISSÃO na transcrição: ${temRotulo ? 'SIM' : 'NÃO'}`);

        const eA = await extrair(promptReal, t.texto, nome, MAX_PG);
        const eB = await extrair(promptSemNome, t.texto, nome, MAX_PG);
        const dA = eA.lido && eA.lido.data, dB = eB.lido && eB.lido.data;
        const veredito = d => j.jData(d, g.data);

        console.log(`\nextração com o prompt REAL      : data=${String(dA || '—').padEnd(12)} → ${veredito(dA)}`);
        console.log(`extração SEM a cláusula do nome : data=${String(dB || '—').padEnd(12)} → ${veredito(dB)}`);

        const estaNaTranscricao = d => !!d && datasNaTranscricao.some(x => x.replace(/[.\-]/g, '/') === String(d).replace(/[.\-]/g, '/'));
        console.log(`\nA data devolvida está na transcrição? ${estaNaTranscricao(dA) ? 'SIM → leu da página (causa A)' : 'NÃO → deduziu/inventou (causa B)'}`);
        if (dA !== dB) console.log(`⚠  a data MUDOU sem a cláusula do nome → o PROMPT era a causa`);
    }

    console.log(`\n${'═'.repeat(70)}`);
    console.log('Causa A (leu errado da página) pede prompt de transcrição melhor.');
    console.log('Causa B (deduziu do nome) pede TIRAR a data da IA — ela vem da pasta,');
    console.log('ver [[data-do-documento-vem-da-pasta]].');
    process.exit(0);
})();
