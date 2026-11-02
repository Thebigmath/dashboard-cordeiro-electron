// Imposto por SKU (02/11/2026), como o "Atributo do SKU" do Mercado Turbo: STORAGE/impostos_sku.json { sku em minusculo: % }.
// SKU sem % proprio usa o imposto da conta (conta(), abaixo: config.json mt_imposto_pct, padrao 4%). Vale na aba Anuncios (o Resumo Financeiro do MT - Teste saiu em 02/11/2026).
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

// Imposto da CONTA (02/11/2026): um % so para o SEVEN inteiro. Fica em config.json com as duas chaves que o app le:
//   mt_imposto_pct .. aba Anuncios, Precificador do anuncio e motor de preco (Analise com IA), junto com o % por SKU
//   imposto_pct ..... o resto do SEVEN (Precificar, Promocoes, Premium, Analise de vendas, Defesa, DRE sem Planilha avancada do mes)
// Antes de alguem salvar aqui, a aba Anuncios usava 4% e o resto 7% (padroes antigos).
const CONFIG = () => path.join(STORAGE(), 'config.json');
const PADRAO_CONTA = 4;
function conta() {
    const c = lerJson(CONFIG(), {});
    const v = Number(c.mt_imposto_pct);
    return Number.isFinite(v) && v >= 0 && c.mt_imposto_pct != null ? v : PADRAO_CONTA;
}
function contaInfo() {
    const c = lerJson(CONFIG(), {}), M = tudo();
    const resto = Number(c.imposto_pct ?? 7);
    return { conta: conta(), resto, unificado: c.mt_imposto_pct != null && c.imposto_pct != null && Number(c.mt_imposto_pct) === Number(c.imposto_pct),
        skus_proprios: Object.keys(M).length, lista: Object.entries(M).slice(0, 30).map(([sku, pct]) => ({ sku, pct })) };
}
// limparSkus: os SKUs com % proprio voltam a usar o da conta (cada um entra no log com o valor de antes)
function salvarConta(pct, { limparSkus = false } = {}) {
    const v = r2(String(pct).replace(',', '.'));
    if (!Number.isFinite(v) || v < 0 || v > 30) throw new Error('Imposto inválido: use um percentual entre 0 e 30.');
    const c = lerJson(CONFIG(), {}), antes = { conta: conta(), resto: Number(c.imposto_pct ?? 7) };
    c.mt_imposto_pct = v; c.imposto_pct = v;
    fs.mkdirSync(STORAGE(), { recursive: true });
    fs.writeFileSync(CONFIG(), JSON.stringify(c, null, 2), 'utf8');
    let limpos = 0;
    if (limparSkus) {
        const M = tudo();
        for (const [k, p] of Object.entries(M)) { try { fs.appendFileSync(LOG(), JSON.stringify({ em: new Date().toISOString(), origem: 'imposto-da-conta', sku: k, antes: Number(p), depois: null }) + '\n'); } catch {} limpos++; }
        fs.writeFileSync(ARQ(), JSON.stringify({}), 'utf8');
    }
    try { fs.appendFileSync(LOG(), JSON.stringify({ em: new Date().toISOString(), origem: 'imposto-da-conta', sku: '*conta*', antes, depois: v, skus_limpos: limpos }) + '\n'); } catch {}
    return { ok: true, antes, ...contaInfo(), skus_limpos: limpos };
}

module.exports = { tudo, pctDoSku, salvar, conta, contaInfo, salvarConta };
