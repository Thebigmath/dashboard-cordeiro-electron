// AD HEALTH > Anuncios (02/11/2026, so na Cordeiro): a tela de Anuncios do Mercado Turbo dentro do SEVEN. Etapa 1 = so leitura.
//   lista ...... todos os anuncios (scan + multiget de 20), com a aba de cada um. O filtro status=under_review da busca do ML
//                devolve 0, mas os anuncios vem com status under_review (5 na Cordeiro em 02/11, igual ao MT): as abas contam pelo status do anuncio.
//   detalhes ... so dos anuncios da pagina aberta (2 chamadas por anuncio): tarifa (listing_prices) e frete que o vendedor paga
//                (shipping_options/free -> list_cost). Margem = preco - custo - imposto - tarifa - frete, a mesma conta do Resumo Financeiro.
//   visitas .... da conta, 150 dias por dia (items_visits/time_window). Media por mes = total / meses de calendario da janela,
//                como o MT (67.251 / 5 = 13.450 em 31/10; 68.577 / 6 = 11.430 em 02/11).
const axios = require('axios');
const P = require('./precificador');
const { mapaLimitado } = require('./paralelo');

const ML = 'https://api.mercadolibre.com';
const r2 = (v) => Math.round(Number(v || 0) * 100) / 100;
const ABA = { active: 'ativos', paused: 'pausados', closed: 'finalizados', under_review: 'revisao', inactive: 'revisao' };
const TIPO = { gold_pro: 'Premium', gold_special: 'Clássico', gold_premium: 'Premium', free: 'Grátis' };
const LOGISTICA = { fulfillment: 'Full', self_service: 'Flex', cross_docking: 'Places', xd_drop_off: 'Places', drop_off: 'Places' };
const MOTIVO = { out_of_stock: 'Sem estoque', paused_by_seller: 'Pausado por você', waiting_for_patch: 'Aguardando correção', forbidden: 'Bloqueado pelo ML',
    held: 'Retido', deleted: 'Excluído', expired: 'Vencido', suspended: 'Suspenso', freezed: 'Congelado' };

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

const skuDe = (o) => o.seller_custom_field || ((o.attributes || []).find(a => a.id === 'SELLER_SKU') || {}).value_name || '';

let cacheLista = null;   // { em, dados }: 5 min; o botao Atualizar rele
async function lista({ forcar = false } = {}) {
    if (!forcar && cacheLista && Date.now() - cacheLista.em < 5 * 60 * 1000) return cacheLista.dados;
    const { headers, userId } = await P.auth();
    const varrer = async (status) => {
        const ids = []; let scroll = null;
        do {
            const d = await get(`${ML}/users/${userId}/items/search`, headers, { search_type: 'scan', limit: 100, ...(status ? { status } : {}), ...(scroll ? { scroll_id: scroll } : {}) });
            if (!(d.results || []).length) break;
            ids.push(...d.results); scroll = d.scroll_id;
        } while (scroll);
        return ids;
    };
    const ids = [...new Set((await Promise.all([varrer(''), varrer('closed')])).flat())];
    const lotes = []; for (let i = 0; i < ids.length; i += 20) lotes.push(ids.slice(i, i + 20));
    const campos = 'id,title,family_name,user_product_id,price,original_price,available_quantity,sold_quantity,status,sub_status,secure_thumbnail,thumbnail,pictures,permalink,listing_type_id,category_id,shipping,seller_custom_field,attributes,variations,date_created,last_updated,catalog_listing,tags,inventory_id';
    const itens = [];
    await mapaLimitado(lotes, 4, async (lote) => {
        const r = await get(`${ML}/items`, headers, { ids: lote.join(','), attributes: campos });
        for (const x of r || []) {
            const b = x.body; if (!b || !b.id) continue;
            const vars = b.variations || [];
            const sku = skuDe(b) || (vars.map(skuDe).find(Boolean) || '');
            const custo = P.custoDoSku(sku);
            const log = b.shipping?.logistic_type || '';
            itens.push({ id: b.id, titulo: b.title || '', familia: b.family_name || '', up: b.user_product_id || '',
                preco: b.price, preco_original: b.original_price || null, disponivel: b.available_quantity, vendidos: b.sold_quantity,
                status: b.status, aba: ABA[b.status] || 'revisao', motivos: (b.sub_status || []).map(s => MOTIVO[s] || s),
                full: log === 'fulfillment', logistica: LOGISTICA[log] || (b.shipping?.mode === 'me1' ? 'ME1' : 'Outros'), frete_gratis: !!b.shipping?.free_shipping,
                foto: (b.secure_thumbnail || b.thumbnail || '').replace(/^http:/, 'https:'), fotos: (b.pictures || []).length, link: b.permalink,
                tipo: b.listing_type_id, tipo_nome: TIPO[b.listing_type_id] || b.listing_type_id, categoria: b.category_id,
                sku, variacoes: vars.length, catalogo: !!b.catalog_listing, criado: b.date_created, alterado: b.last_updated,
                custo: custo ? custo.valor : null, inventory_id: b.inventory_id || '',
                gtin: !!((b.attributes || []).find(a => a.id === 'GTIN') || {}).value_name,
                ficha_incompleta: (b.tags || []).includes('incomplete_technical_specs') });
        }
    });
    const contagem = { ativos: 0, pausados: 0, finalizados: 0, revisao: 0, full: 0 };
    for (const i of itens) { contagem[i.aba]++; if (i.full && i.aba !== 'finalizados') contagem.full++; }
    const dados = { atualizado_em: new Date().toISOString(), total: itens.length, contagem, itens };
    cacheLista = { em: Date.now(), dados };
    return dados;
}

const cacheDet = new Map();   // id|preco -> { em, d }: 30 min (tarifa e frete so mudam com preco, categoria ou peso)
async function detalhes(ids, forcar = false) {
    if (forcar) for (const k of [...cacheDet.keys()]) if (ids.includes(k.split('|')[0])) cacheDet.delete(k);
    const lst = await lista();
    const porId = new Map(lst.itens.map(i => [i.id, i]));
    const pctConta = require('./mt_financeiro').impostoPct(), IS = require('./impostos_sku'), mapaIS = IS.tudo();
    const { headers, userId } = await P.auth();
    const out = {};
    await mapaLimitado([...new Set(ids)].filter(id => porId.has(id)).slice(0, 60), 5, async (id) => {
        const it = porId.get(id), chave = id + '|' + it.preco, c = cacheDet.get(chave);
        let base = c && Date.now() - c.em < 30 * 60 * 1000 ? c.d : null;
        if (!base) {
            const [t, f] = await Promise.all([
                P.tarifa(headers, it.preco, it.tipo, it.categoria),
                get(`${ML}/users/${userId}/shipping_options/free`, headers, { item_id: id }).then(d => d.coverage?.all_country?.list_cost ?? null).catch(() => null),
            ]);
            base = { tarifa: t ? t.valor : null, tarifa_pct: t ? t.pct : null, frete: f };
            cacheDet.set(chave, { em: Date.now(), d: base });
        }
        // custo e imposto lidos agora (nao do cache da lista): o que foi salvo na balanca aparece na hora, aqui e no resto do SEVEN
        const cs = P.custoDoSku(it.sku), impSku = IS.pctDoSku(it.sku, mapaIS), pct = impSku ?? pctConta;
        const custo = cs ? cs.valor : null;
        it.custo = custo;
        const imposto = r2(it.preco * pct / 100);
        const mc = custo != null && base.tarifa != null && base.frete != null ? r2(it.preco - custo - imposto - base.tarifa - base.frete) : null;
        out[id] = { ...base, imposto, imposto_pct: pct, imposto_sku: impSku != null, custo, custo_chave: cs ? cs.chave : null, mc, mc_pct: mc != null && it.preco ? r2(mc / it.preco * 100) : null };
    });
    return out;
}

// Chips do anuncio (so leitura), so da pagina aberta: ~7 chamadas por anuncio, guardadas 30 min.
//   descricao (tamanho) · flex (has_flex) · preco atacado (preco com quantidade minima em /prices) · estoque no Full (inventario)
//   compatibilidades (quantas) · promocoes (ativas e disponiveis para entrar) · qualidade do anuncio (/item/{id}/performance)
const cacheExtra = new Map();
// nivel da qualidade (/item/{id}/performance): o "medium" e o que o MT mostra como "Requer atencao" (MLB7701761296, 02/11/2026)
const NIVEL = { bad: 'Básica', basic: 'Básica', medium: 'Requer atenção', standard: 'Requer atenção', good: 'Profissional', professional: 'Profissional', high: 'Profissional' };
async function extras(ids, forcar = false) {
    if (forcar) for (const id of ids) cacheExtra.delete(id);
    const lst = await lista();
    const porId = new Map(lst.itens.map(i => [i.id, i]));
    const { headers } = await P.auth();
    const out = {};
    const tentar = (p) => p.catch(() => undefined);
    await mapaLimitado([...new Set(ids)].filter(id => porId.has(id)).slice(0, 40), 3, async (id) => {
        const c = cacheExtra.get(id);
        if (c && Date.now() - c.em < 30 * 60 * 1000) { out[id] = c.d; return; }
        const it = porId.get(id);
        const [desc, precos, flex, compat, promo, perf, full] = await Promise.all([
            tentar(get(`${ML}/items/${id}/description`, headers)),
            tentar(get(`${ML}/items/${id}/prices`, headers)),
            tentar(get(`${ML}/flex/sites/MLB/items/${id}/v2`, headers)),
            tentar(get(`${ML}/items/${id}/compatibilities`, headers)),
            tentar(get(`${ML}/seller-promotions/items/${id}`, headers, { app_version: 'v2' })),
            tentar(get(`${ML}/item/${id}/performance`, headers)),
            it.inventory_id ? tentar(get(`${ML}/inventories/${it.inventory_id}/stock/fulfillment`, headers)) : Promise.resolve(undefined),
        ]);
        const promos = Array.isArray(promo) ? promo : [];
        const d = {
            descricao: desc === undefined ? null : String(desc.plain_text || '').length,
            atacado: precos === undefined ? null : (precos.prices || []).some(p => p.conditions && (p.conditions.min_purchase_unit > 1 || (p.conditions.context_restrictions || []).some(r => /b2b|wholesale/i.test(r)))),
            flex: flex === undefined ? null : !!flex.has_flex,
            compat: compat === undefined ? null : (compat.products || []).length,
            promocoes: { ativas: promos.filter(p => p.status === 'started').length, disponiveis: promos.filter(p => p.status === 'candidate').length },
            qualidade: perf && perf.level ? { nivel: NIVEL[perf.level] || perf.level, score: perf.score ?? null } : null,
            full: full === undefined ? null : { disponivel: full.available_quantity ?? 0, total: full.total ?? 0 },
        };
        cacheExtra.set(id, { em: Date.now(), d });
        out[id] = d;
    });
    return out;
}

// Movimentacao do estoque Full (chip "Estoque Full"): operacoes do inventario no periodo (/stock/fulfillment/operations/search).
// Endpoint com cota curta no ML (429 "over_quota" em 02/11/2026: precisou de 3 tentativas): espera e tenta de novo, e guarda 10 min.
const MOV_NOME = { TRANSFER_DELIVERY: 'Unidades em transferência', FISCAL_COVERAGE_ADJUSTMENT: 'Ajuste de cobertura tributária', INBOUND_RECEPTION: 'Entrada no Full (envio recebido)',
    SALE_CONFIRMATION: 'Venda', SALE_CANCELATION: 'Venda cancelada', SALE_DELIVERY_CANCELATION: 'Venda cancelada (devolvida ao estoque)', SALE_RETURN: 'Devolução de venda',
    RETURN_RECEPTION: 'Devolução recebida', ADJUSTMENT: 'Ajuste de estoque', IDENTIFICATION_PROBLEM_ADJUSTMENT: 'Ajuste (problema de identificação)', WITHDRAWAL: 'Retirada do Full',
    REMOVAL: 'Retirada do Full', DISPOSAL: 'Descarte', DAMAGED: 'Avariado', LOST: 'Extraviado', FOUND: 'Encontrado', QUARANTINE: 'Quarentena', TRANSFER_RECEPTION: 'Transferência recebida' };
const cacheMov = new Map();
async function movimentacoes(inventario, de, ate) {
    if (!/^[A-Z0-9]{5,20}$/i.test(String(inventario || ''))) throw new Error('Anúncio sem código de inventário do Full.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(de) || !/^\d{4}-\d{2}-\d{2}$/.test(ate)) throw new Error('Informe Data Inicial e Data Final.');
    const chave = [inventario, de, ate].join('|'), c = cacheMov.get(chave);
    if (c && Date.now() - c.em < 10 * 60 * 1000) return c.d;
    const { headers, userId } = await P.auth();
    const ops = [];
    for (let off = 0; off < 1000; off += 50) {
        let d = null;
        for (let t = 0; t < 5 && !d; t++) {
            try { d = (await axios.get(`${ML}/stock/fulfillment/operations/search`, { headers, params: { seller_id: userId, inventory_id: inventario, date_from: de, date_to: ate, limit: 50, offset: off }, timeout: 30000 })).data; }
            catch (e) { if (e.response?.status === 429 || e.response?.status >= 500) { await new Promise(r => setTimeout(r, 8000 * (t + 1))); continue; } throw e; }
        }
        if (!d) throw new Error('O Mercado Livre está limitando esta consulta agora (cota). Tente de novo em 1 minuto.');
        ops.push(...(d.results || []));
        if (off + 50 >= (d.paging?.total || 0)) break;
    }
    const linhas = ops.map(o => ({ data: o.date_created, tipo: o.type, evento: MOV_NOME[o.type] || String(o.type || '').toLowerCase().replace(/_/g, ' '),
        quantidade: Number(o.detail?.available_quantity) || 0, indisponivel: Number(o.detail?.not_available_quantity) || 0,
        referencia: (o.external_references || []).map(r => r.value).join(', ') })).sort((a, b) => String(b.data).localeCompare(String(a.data)));
    let disponivel = null;
    try { disponivel = (await get(`${ML}/inventories/${inventario}/stock/fulfillment`, headers)).available_quantity ?? null; } catch {}
    const d = { inventario, de, ate, disponivel, linhas };
    cacheMov.set(chave, { em: Date.now(), d });
    return d;
}

async function descricao(id) {
    const { headers } = await P.auth();
    const d = await get(`${ML}/items/${id}/description`, headers);
    return { id, texto: d.plain_text || '' };
}

// Atributo do SKU (a balanca do MT): custo e imposto de um SKU. O custo vai para a planilha de custos (custos.json), que todo o
// SEVEN le na hora (Painel, Precificar, Analise de vendas, Resumo Financeiro...); grava pelo custos_guard: backup antes, log e trava de valor absurdo.
function sku(s) {
    const c = P.custoDoSku(s), IS = require('./impostos_sku');
    return { sku: s, custo: c ? c.valor : null, custo_chave: c ? c.chave : null, imposto_sku: IS.pctDoSku(s), imposto_conta: require('./mt_financeiro').impostoPct() };
}
function salvarSku({ sku: s, custo, imposto, forcar = false } = {}) {
    s = String(s || '').trim();
    if (!s) throw new Error('Anúncio sem SKU: cadastre o SKU no anúncio primeiro.');
    const valor = custo == null || custo === '' ? null : Number(String(custo).replace(',', '.'));
    if (valor != null && !(valor > 0)) throw new Error('Custo inválido: use um valor maior que zero, como 38,90.');
    const G = require('./custos_guard');
    const atual = P.custoDoSku(s);
    if (valor != null && !(atual && Math.abs(atual.valor - valor) < 0.005)) {   // mesmo valor (inclusive herdado do SKU base): nao grava
        const r = G.aplicarAlteracoes({ [s]: valor }, { forcar, origem: 'anuncios' });
        if (!r.ok) return r;
    }
    require('./impostos_sku').salvar(s, imposto, 'anuncios');
    return { ok: true, ...sku(s) };
}

let cacheVis = null;   // 30 min
async function visitas() {
    if (cacheVis && Date.now() - cacheVis.em < 30 * 60 * 1000) return cacheVis.dados;
    const { headers, userId } = await P.auth();
    const d = await get(`${ML}/users/${userId}/items_visits/time_window`, headers, { last: 150, unit: 'day' });
    const dias = (d.results || []).map(r => ({ dia: String(r.date).slice(0, 10), total: Number(r.total) || 0 })).sort((a, b) => a.dia.localeCompare(b.dia));
    const hoje = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10), mesAtual = hoje.slice(0, 7);
    const [a, m] = mesAtual.split('-').map(Number), mesPassado = new Date(Date.UTC(a, m - 2, 1)).toISOString().slice(0, 7);
    const doMes = (mes) => { const L = dias.filter(x => x.dia.startsWith(mes)); return { mes, total: L.reduce((t, x) => t + x.total, 0), dias: L }; };
    const meses = new Set(dias.map(x => x.dia.slice(0, 7))).size || 1;
    const total = Number(d.total_visits) || dias.reduce((t, x) => t + x.total, 0);
    const dados = { total, media_mes: Math.round(total / meses), meses, mes_passado: doMes(mesPassado), mes_atual: doMes(mesAtual), atualizado_em: new Date().toISOString() };
    cacheVis = { em: Date.now(), dados };
    return dados;
}

// Precificador do anuncio (calculadora ao lado do preco, 02/11/2026, como no MT): Classico e Premium cada um no seu preco,
// custo e imposto editaveis so para a conta (gravar o custo/imposto e pela balanca). Imposto = o do SKU ou o da conta (4%),
// o mesmo do resto da aba Anuncios (o motor de preco do AD HEALTH ainda usa o config.imposto_pct).
const cacheFrete = new Map();   // id -> { em, v }: 30 min
async function precificar({ id, classico, premium, custo, imposto } = {}) {
    const lst = await lista();
    const it = lst.itens.find(i => i.id === id);
    if (!it) throw new Error('Anúncio não encontrado na lista: clique em Atualizar.');
    const { headers, userId } = await P.auth();
    let fr = cacheFrete.get(id);
    if (!fr || Date.now() - fr.em > 30 * 60 * 1000) {
        const v = await get(`${ML}/users/${userId}/shipping_options/free`, headers, { item_id: id }).then(d => d.coverage?.all_country?.list_cost ?? null).catch(() => null);
        fr = { em: Date.now(), v }; cacheFrete.set(id, fr);
    }
    const IS = require('./impostos_sku'), pctConta = require('./mt_financeiro').impostoPct();
    const cs = P.custoDoSku(it.sku), impSku = IS.pctDoSku(it.sku, IS.tudo());
    const num = (v) => v == null || v === '' ? null : Number(String(v).replace(',', '.'));
    const custoV = num(custo) ?? (cs ? cs.valor : null), pct = num(imposto) ?? impSku ?? pctConta;
    const col = async (tipo, preco) => {
        preco = r2(num(preco) || it.preco);
        const t = await P.tarifa(headers, preco, tipo, it.categoria);
        const imp = r2(preco * pct / 100);
        const mc = custoV != null && t && fr.v != null ? r2(preco - fr.v - custoV - imp - t.valor) : null;
        return { tipo, preco, tarifa: t ? t.valor : null, tarifa_pct: t ? t.pct : null, imposto: imp, mc, mc_pct: mc != null ? r2(mc / preco * 100) : null,
            aviso_frete: it.preco >= 79 && preco < 79 ? 'Abaixo de R$ 79 o frete grátis deixa de ser obrigatório: o frete pode mudar.' : it.preco < 79 && preco >= 79 ? 'A partir de R$ 79 o frete grátis é obrigatório: o frete pode passar a ser seu.' : '' };
    };
    const [cl, pr] = await Promise.all([col('gold_special', classico), col('gold_pro', premium)]);
    return { id, titulo: it.titulo, sku: it.sku, foto: it.foto, preco_atual: it.preco, tipo_atual: it.tipo === 'gold_premium' ? 'gold_pro' : it.tipo, diamante: it.tipo === 'gold_premium',
        frete: fr.v, custo: custoV, custo_planilha: cs ? cs.valor : null, imposto_pct: pct, imposto_sku: impSku, imposto_conta: pctConta, classico: cl, premium: pr };
}
// grava o preco no ML pelo mesmo caminho do Precificar do SEVEN (trava de 20%, historico precos_historico.jsonl); simular:true so valida
async function aplicarPreco({ id, preco, simular = true, confirmarGrande = false } = {}) {
    const p = r2(Number(String(preco || '').replace(',', '.')));
    if (!/^MLB\d+$/.test(String(id || ''))) throw new Error('Anúncio inválido.');
    if (!(p > 0)) throw new Error('Preço inválido.');
    const it = (await lista()).itens.find(i => i.id === id);
    if (!it) throw new Error('Anúncio não encontrado na lista: clique em Atualizar.');
    if (!['active', 'paused'].includes(it.status)) throw new Error(`Anúncio ${it.status}: o ML não deixa alterar o preço.`);
    const dif = it.preco ? Math.abs(p - it.preco) / it.preco * 100 : 100;
    if (dif > 20 && !confirmarGrande) return { ok: false, precisa_confirmar: true, erro: `A mudança é de ${dif.toFixed(1)}% (acima de 20%). Confirme de novo para aplicar.` };
    if (simular) return { ok: true, simulado: true, antes: it.preco, depois: p };
    const r = await P.aplicar(id, p, { confirmarGrande, origem: 'anuncios', motivo: 'precificador do anúncio' });
    if (r.ok) { it.preco = p; for (const k of [...cacheDet.keys()]) if (k.startsWith(id + '|')) cacheDet.delete(k); }
    return r;
}

module.exports = { lista, detalhes, extras, descricao, movimentacoes, visitas, sku, salvarSku, precificar, aplicarPreco };
