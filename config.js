/**
 * config.js
 * Espelha config.php: carrega variáveis do .env e abre conexão (pool) com o
 * SQL Server (Azure SQL) via mssql.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const sql = require('mssql');

/**
 * Carrega um arquivo .env no estilo ini, tratando BOM UTF-8/UTF-16, sem
 * sobrescrever variáveis já definidas no ambiente (mesmo comportamento do
 * loadEnv() do config.php).
 */
function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  let buf = fs.readFileSync(filePath);

  // UTF-16 LE / BE → UTF-8
  if (buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))) {
    const enc = buf[0] === 0xff ? 'utf16le' : 'utf16le'; // Node só tem utf16le; BE é raro aqui
    let content = buf.toString(enc);
    parseEnvContent(content);
    return;
  }

  let content = buf.toString('utf8');
  // Remove BOM UTF-8
  if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
  parseEnvContent(content);
}

function parseEnvContent(content) {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  for (let line of lines) {
    line = line.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const k = line.slice(0, eq).trim();
    const v = line.slice(eq + 1).trim();
    if (process.env[k] === undefined || process.env[k] === '') process.env[k] = v;
  }
}

loadEnv(path.join(__dirname, '.ENV'));
loadEnv(path.join(__dirname, '.env'));

const DB_SERVER = process.env.DB_SERVER || '';
const DB_NAME = process.env.DB_DATABASE || '';
const DB_USER = process.env.DB_USERNAME || '';
const DB_PASSWORD = process.env.DB_PASSWORD || '';
const DB_ENCRYPT = process.env.DB_ENCRYPT || 'yes';
const DB_TRUST_CERT = process.env.DB_TRUST_SERVER_CERTIFICATE || 'no';

let _poolPromise = null;

/**
 * Retorna um pool de conexão mssql conectado (Azure SQL).
 * Equivalente a getConnection() do config.php.
 */
function getConnection() {
  if (_poolPromise) return _poolPromise;

  const config = {
    server: DB_SERVER,
    port: 1433,
    database: DB_NAME,
    user: DB_USER,
    password: DB_PASSWORD,
    options: {
      encrypt: String(DB_ENCRYPT).toLowerCase() === 'yes',
      trustServerCertificate: String(DB_TRUST_CERT).toLowerCase() === 'yes',
    },
    pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
    requestTimeout: 30000,
    connectionTimeout: 30000,
  };

  _poolPromise = new sql.ConnectionPool(config)
    .connect()
    .then((pool) => {
      pool.on('error', (err) => {
        console.error('[config] pool error:', err.message);
        _poolPromise = null; // permite reconectar na próxima chamada
      });
      return pool;
    })
    .catch((err) => {
      _poolPromise = null; // não cacheia falha
      throw err;
    });

  return _poolPromise;
}

module.exports = { getConnection, sql, loadEnv };
