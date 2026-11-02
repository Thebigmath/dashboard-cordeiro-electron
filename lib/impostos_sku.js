// Imposto por SKU (02/11/2026), como o "Atributo do SKU" do Mercado Turbo: STORAGE/impostos_sku.json { sku em minusculo: % }.
// SKU sem % proprio usa o imposto da conta (config.json mt_imposto_pct, padrao 4%). Vale na aba Anuncios e no Resumo Financeiro (MT - Teste).
// Toda mudanca entra no log (impostos_sku_log.jsonl), com o valor de antes e o de depois.
const fs = require('fs');
const path = require('path');

const STORAGE = () => process.env.STORAGE_PATH || path.join(__dirname, '../storage');
const ARQ = () => path.join(STORAGE(), 'impostos_sku.json');
const LOG = () => path.join(STORAGE(), 'impostos_sku_log.jsonl');
const lerJson = (arq, d) => { try { return JSON.parse(fs.readFileSync(arq, 'utf8')); } catch { return d; } };
const r2 = (v) => Math.round(Number(v) * 100) / 100;

const tudo = () => lerJson(ARQ(), {});
function pctDoSku(sku, mapa = tudo()) {
    const v = mapa[String(sku || '').trim().toLowerCase()];
    return v == null ? null : Number(v);
}
// pct null ou '' apaga o % proprio (o SKU volta a usar o imposto da conta)
function salvar(sku, pct, origem = 'tela') {
    const k = String(sku || '').trim().toLowerCase();
    if (!k) throw new Error('SKU vazio.');
    const novo = pct == null || pct === '' ? null : r2(String(pct).replace(',', '.'));
    if (novo != null && (!Number.isFinite(novo) || novo < 0 || novo > 30)) throw new Error('Imposto inválido: use um percentual entre 0 e 30.');
    const M = tudo(), antes = M[k] == null ? null : Number(M[k]);
    if (antes === novo) return { ok: true, alterado: false, imposto: novo };
    if (novo == null) delete M[k]; else M[k] = novo;
    fs.mkdirSync(STORAGE(), { recursive: true });
    fs.writeFileSync(ARQ(), JSON.stringify(M), 'utf8');
    try { fs.appendFileSync(LOG(), JSON.stringify({ em: new Date().toISOString(), origem, sku: k, antes, depois: novo }) + '\n'); } catch {}
    return { ok: true, alterado: true, imposto: novo };
}

module.exports = { tudo, pctDoSku, salvar };
