/**
 * _medir/_conferir-data-hdi.js — o "31/12/1970" está MESMO impresso no papel?
 *
 * Eu afirmei ao usuário que o `31/12/1970` da apólice HDI é lixo do EMISSOR,
 * transcrito corretamente pela IA. A base dessa afirmação foi fraca: vi a data na
 * lista de datas da TRANSCRIÇÃO, que é produto da própria IA. Se a IA alucinou a
 * data, ela apareceria na transcrição do mesmo jeito — e eu teria confundido
 * alucinação com defeito do papel, exatamente o erro que
 * [[gabarito-frouxo-inventa-erro]] descreve: a régua era o próprio suspeito.
 *
 * Este script confere a hipótese por vias INDEPENDENTES da transcrição:
 *
 *   1. onde a data aparece NO TEXTO transcrito — que rótulo a precede? Se vier
 *      logo depois de "Data de Emissão", é campo do papel; se aparecer solta, é
 *      suspeita de invenção.
 *   2. transcreve a MESMA página DUAS vezes. Alucinação a temperatura 0 tende a
 *      não repetir o mesmo valor exato; defeito do papel repete sempre.
 *   3. transcreve com OUTRO modelo (haiku). Dois modelos diferentes produzindo o
 *      MESMO "31/12/1970" é evidência forte de que está impresso.
 *   4. pede à IA uma pergunta FECHADA sobre aquela região ("que data está escrita
 *      ao lado do rótulo X?"), que é menos sujeita a preenchimento criativo.
 *
 * Se as 4 vias convergirem, minha afirmação se sustenta. Se divergirem, eu disse
 * ao usuário uma coisa errada e preciso corrigir.
 *
 * SOMENTE LEITURA.
 *
 * Uso: node _medir/_conferir-data-hdi.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const h = require('./harness');
const trans = require('../routes/_nf-transcricao');
const { callOpenAI, callAnthropic } = require('../routes/_helpers');

const RAIZ_ARQ = process.env.ARQUIVO_PATH || process.env.MONITOR_PATH;
const ALVOS = [
    '003.DOC- 20817,18-2026.01.26 HDI Apólice HDI Frota',
    '065.DOC- 4675,17-2025.10.28 HDI SEGUROS.',
];

function achar(prefixo) {
    const out = [];
    (function anda(d) {
        let e; try { e = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
        for (const x of e) {
            const q = path.join(d, x.name);
            if (x.isDirectory()) anda(q);
            else if (x.name.startsWith(prefixo.slice(0, 36)) && /\.pdf$/i.test(x.name)) out.push(q);
        }
    })(RAIZ_ARQ);
    return out;
}

// Pergunta FECHADA sobre a imagem: menos espaço para preencher criativamente que
// "transcreva tudo". Se a IA disser que NÃO há data de emissão, então o
// "31/12/1970" da transcrição foi invenção dela.
const PROMPT_FECHADO = `Você está olhando a imagem de uma apólice de seguro.

Responda APENAS este JSON, sem texto em volta:
{
  "temRotuloDataEmissao": true/false,
  "textoDoRotulo": "o rótulo exato que você vê, ex.: 'Data de Emissão' — ou \\"\\" se não houver",
  "dataAoLadoDoRotulo": "a data escrita ao lado desse rótulo, EXATAMENTE como impressa — ou \\"\\" se não houver",
  "aparece31121970": true/false,
  "ondeAparece31121970": "se aparecer '31/12/1970' em qualquer lugar da página, diga ao lado de QUE rótulo — senão \\"\\"",
  "todasAsDatasVisiveis": ["lista de TODAS as datas que você vê impressas, como impressas"]
}

Não invente. Se não houver, devolva "" ou false. É melhor dizer que não há do que supor.`;

async function perguntarFechado(b64) {
    const key = String(process.env.OPENAI_API_KEY || '').trim();
    const r = await callOpenAI(key, {
        model: 'gpt-4.1-mini', response_format: { type: 'json_object' },
        temperature: 0, max_tokens: 1500,
        messages: [{ role: 'system', content: PROMPT_FECHADO },
                   { role: 'user', content: [
                       { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } },
                       { type: 'text', text: 'Responda o JSON sobre esta página.' }] }],
    });
    if (!r.ok || r.httpCode < 200 || r.httpCode >= 300) return { erro: `HTTP ${r.httpCode}` };
    let body; try { body = JSON.parse(r.body); } catch (_) { return { erro: 'não-JSON' }; }
    const t = body?.choices?.[0]?.message?.content ?? '';
    try { return { d: JSON.parse(t) }; } catch (_) {
        const s = t.indexOf('{'), e = t.lastIndexOf('}');
        if (s >= 0 && e > s) { try { return { d: JSON.parse(t.slice(s, e + 1)) }; } catch (_) {} }
    }
    return { erro: 'JSON inválido' };
}

const RE_DATA = /\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4}/g;

// O contexto em volta da data no texto: é o que diz se ela tem rótulo de campo.
function contextos(texto, alvo) {
    const out = [];
    let i = 0;
    const t = String(texto);
    while ((i = t.indexOf(alvo, i)) >= 0) {
        out.push(t.slice(Math.max(0, i - 90), i + alvo.length + 30).replace(/\s+/g, ' ').trim());
        i += alvo.length;
    }
    return out;
}

(async () => {
    for (const prefixo of ALVOS) {
        const achados = achar(prefixo);
        if (!achados.length) { console.log(`\n✗ não achei: ${prefixo}\n`); continue; }
        const abs = achados[0];
        const nome = path.basename(abs);
        const buf = fs.readFileSync(abs);

        console.log(`\n${'═'.repeat(72)}`);
        console.log(nome.slice(0, 70));
        console.log(`pasta: ${path.relative(RAIZ_ARQ, abs).split(path.sep)[0]}`);

        // ── via 1 e 2: transcrever DUAS vezes, ver se "31/12/1970" repete ─────
        const t1 = await trans.transcrever(buf);
        const t2 = await trans.transcrever(buf);
        for (const [rot, t] of [['1ª', t1], ['2ª', t2]]) {
            if (t.erro) { console.log(`\n${rot} transcrição: ERRO ${t.erro}`); continue; }
            const tem = String(t.texto).includes('31/12/1970');
            const datas = [...new Set(String(t.texto).match(RE_DATA) || [])];
            console.log(`\n${rot} transcrição (${String(t.texto).replace(/\s/g, '').length} chars): ` +
                `31/12/1970 ${tem ? 'PRESENTE' : 'ausente'}   (${datas.length} datas distintas)`);
            if (tem) for (const c of contextos(t.texto, '31/12/1970').slice(0, 3))
                console.log(`     contexto: ...${c}...`);
        }

        // ── via 3: OUTRO modelo ──────────────────────────────────────────────
        const t3 = await trans.transcrever(buf, { provider: 'anthropic' });
        if (t3.erro) console.log(`\nhaiku: ERRO ${t3.erro}`);
        else {
            const tem = String(t3.texto).includes('31/12/1970');
            console.log(`\nhaiku (outro modelo): 31/12/1970 ${tem ? 'PRESENTE' : 'AUSENTE'}`);
            if (tem) for (const c of contextos(t3.texto, '31/12/1970').slice(0, 2))
                console.log(`     contexto: ...${c}...`);
        }

        // ── via 4: pergunta fechada sobre a imagem ───────────────────────────
        let imgs;
        try { imgs = await trans.paginasEmPng(buf, 1); } catch (_) { imgs = []; }
        if (imgs.length) {
            const q = await perguntarFechado(imgs[0]);
            if (q.erro) console.log(`\npergunta fechada: ERRO ${q.erro}`);
            else {
                console.log('\npergunta FECHADA sobre a página 1:');
                console.log(`   tem rótulo de data de emissão: ${q.d.temRotuloDataEmissao}`);
                console.log(`   rótulo: "${q.d.textoDoRotulo || '—'}"`);
                console.log(`   data ao lado: "${q.d.dataAoLadoDoRotulo || '—'}"`);
                console.log(`   aparece 31/12/1970: ${q.d.aparece31121970}`);
                console.log(`   onde: "${q.d.ondeAparece31121970 || '—'}"`);
                console.log(`   todas as datas vistas: ${(q.d.todasAsDatasVisiveis || []).join('  ') || '—'}`);
            }
        }
    }

    console.log(`\n${'═'.repeat(72)}`);
    console.log('CONVERGÊNCIA = a data está impressa (defeito do emissor).');
    console.log('DIVERGÊNCIA  = a IA inventou, e eu afirmei o contrário ao usuário.');
    process.exit(0);
})();
