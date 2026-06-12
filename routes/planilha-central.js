/**
 * routes/planilha-central.js
 * GET  /api/planilha-central?mes=MM&ano=YYYY  → lê o XLSX e retorna notas do mês
 * POST /api/planilha-central                  → configura o caminho da planilha
 */
'use strict';

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { setFullSecurityHeaders, requireAuth, trimStr } = require('./_helpers');

const ENV_FILE = path.join(__dirname, '..', '.env');

// Converte serial de data do Excel para DD/MM/YYYY
function excelDateToStr(serial) {
    if (!serial || typeof serial !== 'number') return '—';
    const date = new Date(Math.round((serial - 25569) * 86400 * 1000));
    const d = String(date.getUTCDate()).padStart(2, '0');
    const m = String(date.getUTCMonth() + 1).padStart(2, '0');
    const y = date.getUTCFullYear();
    return `${d}/${m}/${y}`;
}

function excelDateToMonthYear(serial) {
    if (!serial || typeof serial !== 'number') return null;
    const date = new Date(Math.round((serial - 25569) * 86400 * 1000));
    return {
        mes: date.getUTCMonth() + 1,
        ano: date.getUTCFullYear(),
    };
}

// Normaliza string para comparação (remove espaços extras, caixa alta)
function norm(s) {
    return String(s || '').trim().toUpperCase().replace(/\s+/g, ' ');
}

// Normaliza valor para comparação (2 casas decimais)
function normVal(v) {
    return parseFloat(parseFloat(v || 0).toFixed(2));
}

module.exports = async function planilhaCentralRoute(req, res) {
    setFullSecurityHeaders(res);
    if (!requireAuth(req, res)) return;

    try {
        /* ── POST: salva caminho da planilha ──────────────────────────────── */
        if (req.method === 'POST') {
            const body = req.body || {};
            const planilhaPath = trimStr(body.planilhaPath);

            if (!planilhaPath) {
                return res.status(400).json({ success: false, message: 'Caminho não pode estar vazio.' });
            }

            if (!fs.existsSync(planilhaPath)) {
                return res.status(400).json({ success: false, message: `Arquivo não encontrado: ${planilhaPath}` });
            }

            if (!/\.xlsx$/i.test(planilhaPath)) {
                return res.status(400).json({ success: false, message: 'Somente arquivos .xlsx são suportados.' });
            }

            // Salva no .env
            let envContent = '';
            try { envContent = fs.readFileSync(ENV_FILE, 'utf8'); } catch (_) {}
            const lines = envContent.split('\n');
            let found = false;
            const newLines = lines.map(line => {
                if (line.trim().startsWith('PLANILHA_PATH=')) { found = true; return `PLANILHA_PATH=${planilhaPath}`; }
                return line;
            });
            if (!found) newLines.push(`PLANILHA_PATH=${planilhaPath}`);
            fs.writeFileSync(ENV_FILE, newLines.join('\n').trim() + '\n', 'utf8');
            process.env.PLANILHA_PATH = planilhaPath;

            return res.json({ success: true, message: 'Planilha configurada.', planilhaPath });
        }

        /* ── GET: retorna notas do mês ────────────────────────────────────── */
        if (req.method === 'GET') {
            const planilhaPath = process.env.PLANILHA_PATH;

            // GET sem parâmetros: retorna apenas o caminho configurado
            if (!req.query.mes && !req.query.ano) {
                return res.json({ success: true, planilhaPath: planilhaPath || '' });
            }

            if (!planilhaPath || !fs.existsSync(planilhaPath)) {
                return res.status(400).json({ success: false, message: 'Planilha não configurada ou não encontrada.' });
            }

            const mes = parseInt(req.query.mes, 10);
            const ano = parseInt(req.query.ano, 10);

            if (!mes || !ano) {
                return res.status(400).json({ success: false, message: 'Parâmetros mes e ano obrigatórios.' });
            }

            // Lê a planilha
            const wb = XLSX.readFile(planilhaPath);
            const ws = wb.Sheets[wb.SheetNames[0]];
            const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });

            // Linha 1 é o cabeçalho (linha 0 é vazia)
            const header = rows[1] || [];
            const idxNF       = header.indexOf('NF');
            const idxEntidade = header.indexOf('ENTIDADE');
            const idxValor    = header.indexOf('VL_TOTAL_CAB');
            const idxEmissao  = header.indexOf('DT_EMISSAO');
            const idxFilial   = header.indexOf('FILIAL');
            const idxTipo     = header.indexOf('TIPO');
            const idxOrig     = header.indexOf('ORIG');

            // Filtra linhas do mês/ano
            const notas = [];
            const seen = new Set(); // evita duplicatas por NF+Entidade

            for (let i = 2; i < rows.length; i++) {
                const row = rows[i];
                if (!row || !row.length) continue;

                const emissao = row[idxEmissao];
                const dt = excelDateToMonthYear(emissao);
                if (!dt || dt.mes !== mes || dt.ano !== ano) continue;

                const nf      = String(row[idxNF] || '').trim();
                const entidade = norm(row[idxEntidade]);
                const valor   = normVal(row[idxValor]);
                const key     = `${nf}|${entidade}`;

                // VL_TOTAL_CAB é o total do cabeçalho, repetido em cada linha de
                // item — NÃO somamos. Linhas duplicadas da mesma nota são ignoradas.
                if (seen.has(key)) continue;
                seen.add(key);

                notas.push({
                    nf,
                    entidade:     norm(row[idxEntidade]),
                    valor,
                    emissao:      excelDateToStr(emissao),
                    filial:       norm(row[idxFilial]),
                    tipo:         norm(row[idxTipo]),
                    orig:         norm(row[idxOrig]),
                });
            }

            return res.json({ success: true, mes, ano, total: notas.length, notas });
        }

        return res.status(405).json({ success: false, message: 'Método não permitido.' });
    } catch (e) {
        console.error('[planilha-central] erro:', e.message);
        return res.status(500).json({ success: false, message: e.message });
    }
};
