// Acoes do anuncio na aba Anuncios (02/11/2026, so na Cordeiro), no molde do menu "Acoes" do Mercado Turbo.
//   status ...... pausar / ativar (pelo anuncios_status, o mesmo do Painel), finalizar e excluir (irreversiveis: excluir exige "EXCLUIR").
//                 simular:true le os anuncios e diz o que aconteceria, sem gravar. Tudo vai para STORAGE/acoes_anuncio_historico.jsonl.
//   modalidade .. tarifa e margem do anuncio em cada tipo que o ML deixa trocar (available_listing_types + available_downgrades);
//                 trocar = POST /items/{id}/listing_type
//   info ........ so leitura: promocoes, logistica, termos mais pesquisados da categoria, avaliacoes, perguntas, visitas (30 dias),
//                 Olist (ex-Tiny) da conta pelo SKU (mostra de qual empresa e o Olist, para nao misturar empresas)
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const P = require('./precificador');

const STORAGE = () => process.env.STORAGE_PATH || path.join(__dirname, '../storage');
const HIST = () => path.join(STORAGE(), 'acoes_anuncio_historico.jsonl');
const ML = 'https://api.mercadolibre.com';
const r2 = (v) => Math.round(Number(v) * 100) / 100;
const dormir = (ms) => new Promise(r => setTimeout(r, ms));
// Diamante (gold_premium) e o Premium para a Cordeiro (o usuario confirmou em 02/11/2026): mesmo nome e mesma tarifa do Premium
const TIPO = { gold_pro: 'Premium', gold_special: 'Clássico', gold_premium: 'Premium', free: 'Grátis' };

async function chamar(fn) {
    for (let t = 1; ; t++) {
        try { return await fn(); }
        catch (e) { const s = e.response?.status; if ((s === 429 || s >= 500 || !e.response) && t < 4) { await dormir(1500 * t); continue; } throw e; }
    }
}
const erroML = (e) => { const d = e.response?.data || {}; const causa = (d.cause || []).map(c => c.message || c.code).filter(Boolean).join('; '); return `O ML recusou (${e.response?.status || 'sem resposta'}): ${d.message || d.error || e.message}${causa ? ' — ' + causa : ''}`; };
const get = async (url, headers, params) => (await chamar(() => axios.get(url, { headers, params, timeout: 25000 }))).data;
const registrar = (o) => { try { fs.mkdirSync(STORAGE(), { recursive: true }); fs.appendFileSync(HIST(), JSON.stringify({ quando: new Date().toISOString(), ...o }) + '\n', 'utf8'); } catch {} };

let rodando = false;
async function status({ ids = [], acao, simular = true, confirmacao = '' } = {}) {
    if (!['pausar', 'ativar', 'finalizar', 'excluir'].includes(acao)) throw new Error('Ação inválida.');
    const lista = [...new Set((ids || []).map(String).filter(x => /^MLB\d+$/.test(x)))];
    if (!lista.length) throw new Error('Nenhum anúncio selecionado.');
    if (lista.length > 50) throw new Error('No máximo 50 anúncios por vez.');
    if (acao === 'excluir' && !simular && String(confirmacao).trim().toUpperCase() !== 'EXCLUIR') throw new Error('Para excluir, digite EXCLUIR na confirmação.');
    if (rodando) throw new Error('Já existe uma ação em andamento. Espere terminar.');
    rodando = true;
    try {
        const { headers } = await P.auth();
        const H = { ...headers, 'Content-Type': 'application/json' };
        // pausar/ativar de verdade: o mesmo caminho do Painel (valida, registra e permite reverter)
        if ((acao === 'pausar' || acao === 'ativar') && !simular) {
            const r = await require('./anuncios_status').alterar(lista, acao === 'pausar' ? 'paused' : 'active', 'anuncios');
            registrar({ acao, ids: lista, resultado: r });
            return { ok: true, simulado: false, acao, resultado: (r.itens || []).map(x => ({ item_id: x.item_id, titulo: x.titulo, ok: x.ok, erro: x.erro, aviso: x.aviso })) };
        }
        const resultado = [];
        for (const id of lista) {
            const r = { item_id: id };
            try {
                const it = await get(`${ML}/items/${id}`, headers, { attributes: 'id,title,status,sub_status' });
                Object.assign(r, { titulo: it.title, de: it.status });
                const pode = acao === 'pausar' ? it.status === 'active' : acao === 'ativar' ? it.status === 'paused'
                    : acao === 'finalizar' ? ['active', 'paused'].includes(it.status) : ['active', 'paused', 'closed'].includes(it.status);
                if (!pode) { r.ok = acao === 'pausar' && it.status === 'paused' || acao === 'ativar' && it.status === 'active' || acao === 'finalizar' && it.status === 'closed';
                    r[r.ok ? 'aviso' : 'erro'] = r.ok ? 'já estava assim' : `anúncio ${it.status}${(it.sub_status || []).length ? ' (' + it.sub_status.join(', ') + ')' : ''}: o ML não deixa`; resultado.push(r); continue; }
                if (simular) { r.ok = true; r.simulado = true; resultado.push(r); continue; }
                if (acao === 'finalizar' || (acao === 'excluir' && it.status !== 'closed')) await chamar(() => axios.put(`${ML}/items/${id}`, { status: 'closed' }, { headers: H, timeout: 30000 }));
                if (acao === 'excluir') await chamar(() => axios.put(`${ML}/items/${id}`, { deleted: 'true' }, { headers: H, timeout: 30000 }));
                r.ok = true;
                registrar({ acao, item_id: id, titulo: it.title, de: it.status });
            } catch (e) { r.ok = false; r.erro = erroML(e); }
            resultado.push(r);
            await dormir(300);
        }
        return { ok: true, simulado: !!simular, acao, resultado };
    } finally { rodando = false; }
}

async function contexto(id) {
    const { headers, userId } = await P.auth();
    const it = await get(`${ML}/items/${id}`, headers, { include_attributes: 'all' });
    const sku = it.seller_custom_field || ((it.attributes || []).find(a => a.id === 'SELLER_SKU') || {}).value_name || '';
    return { headers, userId, it, sku };
}

async function modalidade(id) {
    const { headers, userId, it, sku } = await contexto(id);
    const [sobe, desce] = await Promise.all([
        get(`${ML}/items/${id}/available_listing_types`, headers).catch(() => []),
        get(`${ML}/items/${id}/available_downgrades`, headers).catch(() => []),
    ]);
    let tipos = [...new Set([it.listing_type_id, ...(sobe || []).map(x => x.id), ...(desce || []).map(x => x.id)])].filter(t => TIPO[t] && t !== 'free');
    // Diamante = Premium: so aparece se o anuncio JA for Diamante; senao a opcao Premium (gold_pro) basta
    if (it.listing_type_id !== 'gold_premium') tipos = tipos.filter(t => t !== 'gold_premium');
    else tipos = tipos.filter(t => t !== 'gold_pro');
    const c = P.custoDoSku(sku), imp = require('./impostos_sku').pctDoSku(sku) ?? require('./mt_financeiro').impostoPct();
    let frete = null; try { frete = (await get(`${ML}/users/${userId}/shipping_options/free`, headers, { item_id: id })).coverage?.all_country?.list_cost ?? null; } catch {}
    const opcoes = [];
    for (const t of tipos) {
        // tarifa 0 num tipo pago (o Diamante voltou 0 em 02/11/2026) = o ML nao informou: sem tarifa e sem margem, em vez de uma margem falsa
        const tf0 = await P.tarifa(headers, it.price, t, it.category_id), tf = tf0 && tf0.valor > 0 ? tf0 : null;
        const mc = tf && c && frete != null ? r2(it.price - c.valor - it.price * imp / 100 - tf.valor - frete) : null;
        opcoes.push({ tipo: t, nome: TIPO[t], atual: t === it.listing_type_id, tarifa: tf && tf.valor, tarifa_pct: tf && tf.pct, mc, mc_pct: mc != null ? r2(mc / it.price * 100) : null });
    }
    return { id, titulo: it.title, preco: it.price, sku, custo: c ? c.valor : null, frete, imposto_pct: imp, opcoes };
}
async function alterarModalidade({ id, tipo, simular = true } = {}) {
    if (!/^MLB\d+$/.test(String(id || '')) || !TIPO[tipo]) throw new Error('Anúncio ou tipo inválido.');
    const m = await modalidade(id);
    const op = m.opcoes.find(o => o.tipo === tipo);
    if (!op) throw new Error(`O ML não deixa este anúncio virar ${TIPO[tipo]}.`);
    if (op.atual) return { ok: true, aviso: `Já é ${TIPO[tipo]}.` };
    if (simular) return { ok: true, simulado: true, de: m.opcoes.find(o => o.atual)?.nome, para: op.nome };
    const { headers } = await P.auth();
    try {
        await chamar(() => axios.post(`${ML}/items/${id}/listing_type`, { id: tipo }, { headers: { ...headers, 'Content-Type': 'application/json' }, timeout: 30000 }));
    } catch (e) { return { ok: false, erro: erroML(e) }; }
    registrar({ acao: 'modalidade', item_id: id, titulo: m.titulo, de: m.opcoes.find(o => o.atual)?.tipo, para: tipo });
    return { ok: true, de: m.opcoes.find(o => o.atual)?.nome, para: op.nome };
}

async function info(id, tipo) {
    if (tipo === 'tiny') {
        const { sku } = await contexto(id);
        if (!sku) return { tipo, erro: 'Anúncio sem SKU: não dá para achar no Olist.' };
        const O = require('./olist_estoque');
        const conta = await O.info().catch(() => null);
        const p = await O.chamar('produtos.pesquisa.php', { pesquisa: sku });
        const ex = ((p && p.produtos) || []).map(x => x.produto).find(x => String(x.codigo || '').toLowerCase() === sku.toLowerCase());
        if (!ex) return { tipo, empresa: conta && (conta.razao || conta.fantasia), sku, achado: false };
        const [det, est] = await Promise.all([O.chamar('produto.obter.php', { id: ex.id }).catch(() => null), O.chamar('produto.obter.estoque.php', { id: ex.id }).catch(() => null)]);
        const pr = (det && det.produto) || {}, e = (est && est.produto) || {};
        return { tipo, empresa: conta && (conta.razao || conta.fantasia), sku, achado: true, nome: pr.nome || ex.nome, codigo: pr.codigo || ex.codigo, situacao: pr.situacao, preco: Number(pr.preco) || null,
            preco_custo: Number(pr.preco_custo) || null, ncm: pr.ncm || null, gtin: pr.gtin || null, unidade: pr.unidade || null,
            saldo: e.saldo != null ? Number(e.saldo) : null, depositos: (e.depositos || []).map(x => x.deposito).map(d => ({ nome: d.nome, saldo: Number(d.saldo), desconsiderar: d.desconsiderar === 'S' })) };
    }
    const { headers, userId, it } = await contexto(id);
    if (tipo === 'promocoes') {
        const L = await get(`${ML}/seller-promotions/items/${id}`, headers, { app_version: 'v2' }).catch(() => []);
        return { tipo, preco: it.price, promocoes: (L || []).map(p => ({ tipo: p.type, nome: p.name || '', status: p.status, preco: p.price || null, preco_original: p.original_price || null,
            desconto_pct: p.price && p.original_price ? r2((1 - p.price / p.original_price) * 100) : null, inicio: p.start_date || null, fim: p.finish_date || null, ml_paga: p.meli_percentage ?? null })) };
    }
    if (tipo === 'logistica') {
        let frete = null; try { frete = (await get(`${ML}/users/${userId}/shipping_options/free`, headers, { item_id: id })).coverage?.all_country || null; } catch {}
        const dims = Object.fromEntries(['SELLER_PACKAGE_HEIGHT', 'SELLER_PACKAGE_WIDTH', 'SELLER_PACKAGE_LENGTH', 'SELLER_PACKAGE_WEIGHT'].map(k => [k, ((it.attributes || []).find(a => a.id === k) || {}).value_name || null]));
        return { tipo, modo: it.shipping?.mode, logistica: it.shipping?.logistic_type, frete_gratis: !!it.shipping?.free_shipping, retirada: !!it.shipping?.local_pick_up,
            frete_vendedor: frete && frete.list_cost, peso_cobrado: frete && frete.billable_weight, dims, inventory_id: it.inventory_id || null };
    }
    if (tipo === 'termos') {
        const L = await get(`${ML}/trends/MLB/${it.category_id}`, headers).catch(() => []);
        return { tipo, categoria: it.category_id, termos: (L || []).slice(0, 30).map(t => ({ termo: t.keyword, url: t.url })) };
    }
    if (tipo === 'avaliacoes') {
        const r = await get(`${ML}/reviews/item/${id}`, headers, { limit: 20 }).catch(() => ({}));
        return { tipo, media: r.rating_average ?? null, total: r.paging?.total ?? 0, niveis: r.rating_levels || null,
            avaliacoes: (r.reviews || []).map(v => ({ nota: v.rate, titulo: v.title, texto: v.content, data: v.date_created })) };
    }
    if (tipo === 'perguntas') {
        const r = await get(`${ML}/questions/search`, headers, { item: id, sort_fields: 'date_created', sort_types: 'DESC', limit: 30 }).catch(() => ({}));
        return { tipo, total: r.total ?? 0, perguntas: (r.questions || []).map(q => ({ pergunta: q.text, data: q.date_created, status: q.status, resposta: q.answer && q.answer.text, respondida_em: q.answer && q.answer.date_created })) };
    }
    if (tipo === 'visitas') {
        const r = await get(`${ML}/items/${id}/visits/time_window`, headers, { last: 30, unit: 'day' }).catch(() => ({}));
        return { tipo, total: r.total_visits ?? 0, dias: (r.results || []).map(x => ({ dia: String(x.date).slice(0, 10), total: x.total })).sort((a, b) => a.dia.localeCompare(b.dia)), vendidos: it.sold_quantity };
    }
    throw new Error('Tipo de informação inválido.');
}

module.exports = { status, modalidade, alterarModalidade, info };
