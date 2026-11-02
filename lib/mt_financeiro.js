// MT - Teste (31/10/2026): o "Resumo Financeiro" do Mercado Turbo dentro do SEVEN. A tela saiu do app em 02/11/2026 (pedido do usuario);
// fica aqui o impostoPct() (imposto da conta, usado pela aba Anuncios) e o vendas(), sem rota, para quando voltar.
// Mesma conta da MC% por venda do vendas_mc.js (AD HEALTH), conferida com o MT da Cordeiro em 31/10/2026:
//   base = valor x qtd - cupom do vendedor (o "Vendas Aprovadas" do MT e a soma das bases)
//   MC = base - custo x qtd - imposto - tarifa - frete do vendedor
//   MC% da linha = MC / (valor x qtd), sem tirar o cupom (4440-4441-par: -11,62 / 133,90 = -8,68%, igual ao MT);
//   MC% do total (na tela) = soma das MC / vendas aprovadas (2,14% no MT de 31/10)
//   faturamento ML = base + frete pago pelo comprador (o frete do comprador so passa pela venda)
// Diferencas para o vendas_mc (que fica como esta, para nao mexer no AD HEALTH):
//   periodo livre (de/ate), canceladas na lista (marcadas; a tela tira dos totais) e a modalidade do envio como o MT.
// Imposto: um % da conta (config.json mt_imposto_pct). Padrao 4%: e o que o MT aplica na Cordeiro (5,30 em 132,40).
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const P = require('./precificador');
const { mapaLimitado } = require('./paralelo');

const STORAGE = () => process.env.STORAGE_PATH || path.join(__dirname, '../storage');
const CACHE_ENVIO = () => path.join(STORAGE(), 'vendas_mc_envios.json');   // o mesmo cache do vendas_mc: envio nao muda depois da venda
const CONFIG = () => path.join(STORAGE(), 'config.json');
const ML = 'https://api.mercadolibre.com';
const IMPOSTO_PADRAO = 4;
const MAX_DIAS = 92;
const r2 = (v) => Math.round(Number(v || 0) * 100) / 100;
const lerJson = (arq, d) => { try { return JSON.parse(fs.readFileSync(arq, 'utf8')); } catch { return d; } };
const diaOk = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const MODALIDADE = { fulfillment: 'Full', self_service: 'Flex', cross_docking: 'Places/Coleta', xd_drop_off: 'Places/Coleta', drop_off: 'Places/Coleta' };

async function get(url, headers, params) {
    for (let t = 0; ; t++) {
        try { return (await axios.get(url, { headers, params, timeout: 30000 })).data; }
        catch (e) {
            const st = e.response?.status;
            if ((st === 429 || (st >= 500 && st < 600)) && t < 5) { await new Promise(r => setTimeout(r, 1500 * (t + 1))); continue; }
            throw e;
        }
    }
}

function impostoPct() {
    const v = Number(lerJson(CONFIG(), {}).mt_imposto_pct);
    return Number.isFinite(v) && v >= 0 ? v : IMPOSTO_PADRAO;
}
function salvarImposto(pct) {
    const v = Number(String(pct).replace(',', '.'));
    if (!Number.isFinite(v) || v < 0 || v > 30) throw new Error('Imposto inválido: use um percentual entre 0 e 30.');
    const c = lerJson(CONFIG(), {});
    c.mt_imposto_pct = r2(v);
    fs.mkdirSync(STORAGE(), { recursive: true });
    fs.writeFileSync(CONFIG(), JSON.stringify(c, null, 2), 'utf8');
    cache.clear();
    return { ok: true, imposto_pct: c.mt_imposto_pct };
}

let conta = null;
const cache = new Map();   // de|ate -> { em, dados }: trocar filtro na tela nao relê o ML; "Buscar" de novo depois de 3 min relê

async function vendas({ de, ate, forcar = false } = {}) {
    if (!diaOk(de) || !diaOk(ate)) throw new Error('Informe Data início e Data fim.');
    if (de > ate) [de, ate] = [ate, de];
    const dias = (Date.parse(ate) - Date.parse(de)) / 86400000 + 1;
    if (dias > MAX_DIAS) throw new Error(`Período grande demais (${dias} dias). Use até ${MAX_DIAS} dias por busca.`);
    const chave = de + '|' + ate, c = cache.get(chave);
    if (!forcar && c && Date.now() - c.em < 3 * 60 * 1000) return c.dados;

    const { headers, userId } = await P.auth();
    if (!conta) conta = (await get(`${ML}/users/${userId}`, headers).catch(() => ({}))).nickname || String(userId);
    const pct = impostoPct();

    const pedidos = [];
    for (let off = 0; off < 10000; off += 50) {
        const d = await get(`${ML}/orders/search`, headers, { seller: userId, limit: 50, offset: off, sort: 'date_desc',
            'order.date_created.from': `${de}T00:00:00.000-03:00`, 'order.date_created.to': `${ate}T23:59:59.999-03:00` });
        pedidos.push(...(d.results || []));
        if (off + 50 >= (d.paging?.total || 0)) break;
    }

    const env = lerJson(CACHE_ENVIO(), {});
    const faltam = [...new Set(pedidos.map(o => o.shipping?.id).filter(Boolean))].filter(id => !env[id]);
    await mapaLimitado(faltam, 5, async (id) => {
        try {
            const [s, k] = await Promise.all([get(`${ML}/shipments/${id}`, headers), get(`${ML}/shipments/${id}/costs`, headers)]);
            env[id] = { ...(env[id] || {}), uf: String(s.receiver_address?.state?.id || '').replace(/^BR-/, '') || null, logistica: s.logistic_type || '', modo: s.mode || '',
                comprador: Number(k.receiver?.cost) || 0,
                vendedor: (k.senders || []).filter(x => !x.user_id || String(x.user_id) === String(userId)).reduce((t, x) => t + (Number(x.cost) || 0), 0) };
        } catch { /* sem o custo do envio: a linha fica sem MC e o envio e tentado na proxima busca */ }
    });
    if (faltam.length) { fs.mkdirSync(STORAGE(), { recursive: true }); fs.writeFileSync(CACHE_ENVIO(), JSON.stringify(env), 'utf8'); }

    // um envio pode levar varios pedidos do mesmo carrinho: o custo dele e repartido pelo valor dos itens de TODOS esses
    // pedidos (sem isso o frete do carrinho entrava inteiro em cada pedido; conferido com o MT da Cordeiro em 31/10/2026)
    const valorDoEnvio = {};
    for (const o of pedidos) for (const i of (o.order_items || [])) if (o.shipping?.id) valorDoEnvio[o.shipping.id] = (valorDoEnvio[o.shipping.id] || 0) + Number(i.unit_price) * Number(i.quantity);

    const IS = require('./impostos_sku'), mapaIS = IS.tudo();   // imposto por SKU (Atributo do SKU da aba Anuncios); sem ele, o da conta
    const linhas = [];
    for (const o of pedidos) {
        const itens = o.order_items || [];
        const totalItens = itens.reduce((t, i) => t + Number(i.unit_price) * Number(i.quantity), 0) || 1;
        const e = env[o.shipping?.id] || null, totalEnvio = valorDoEnvio[o.shipping?.id] || totalItens;
        const cupom = Number(o.coupon?.amount) || 0;
        const modalidade = !e ? '—' : e.modo === 'me1' ? 'ME1' : (MODALIDADE[e.logistica] || 'Outros');
        for (const i of itens) {
            const qtd = Number(i.quantity) || 1, valor = Number(i.unit_price) || 0, parte = (valor * qtd) / totalItens, parteEnvio = (valor * qtd) / totalEnvio;
            const sku = i.item?.seller_sku || i.item?.seller_custom_field || '';
            const custoUn = P.custoDoSku(sku);
            const bruto = r2(valor * qtd), base = r2(bruto - cupom * parte);
            const freteC = e ? r2(e.comprador * parteEnvio) : null, freteV = e ? r2(e.vendedor * parteEnvio) : null;
            const tarifa = r2((Number(i.sale_fee) || 0) * qtd);
            const impostoSku = IS.pctDoSku(sku, mapaIS);
            const imposto = r2(base * (impostoSku ?? pct) / 100);
            const custo = custoUn ? r2(custoUn.valor * qtd) : null;
            const mc = custo != null && freteV != null ? r2(base - custo - imposto - tarifa - freteV) : null;
            linhas.push({ pedido: String(o.id), carrinho: o.pack_id ? String(o.pack_id) : '', data: o.date_created, status: o.status, cancelada: o.status === 'cancelled',
                item_id: i.item?.id || '', titulo: i.item?.title || '', sku, conta, modalidade, frete_gratis: freteC === 0,
                valor, qtd, bruto, cupom: r2(cupom * parte), base, faturamento: freteC != null ? r2(base + freteC) : base,
                custo, imposto, imposto_sku: impostoSku, tarifa, frete_comprador: freteC, frete_vendedor: freteV,
                mc, mc_pct: mc != null && bruto ? r2(mc / bruto * 100) : null,
                custo_suspeito: !!(custoUn && valor && custoUn.valor > valor * 1.5) });
        }
    }
    linhas.sort((a, b) => String(b.data).localeCompare(String(a.data)));
    const dados = { de, ate, conta, imposto_pct: pct, atualizado_em: new Date().toISOString(), linhas };
    cache.set(chave, { em: Date.now(), dados });
    return dados;
}

module.exports = { vendas, impostoPct, salvarImposto, IMPOSTO_PADRAO, MAX_DIAS };
