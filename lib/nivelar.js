// Nivelar Anuncios (02/11/2026, so na Cordeiro): iguala os anuncios do MESMO SKU a um anuncio MODELO que a pessoa escolhe (o app nao escolhe).
//   preco ...... cada anuncio recebe o preco que da a MESMA MC% do modelo, com a tarifa do tipo dele (Classico/Premium), o frete dele e o
//                imposto do SKU. Igualar o preco entre Classico e Premium tirava margem do Premium (020TB: 318,40 x 344,42 em 02/11/2026).
//                Grava pelo precificador.aplicar (mesmo historico de preco que o motor e a Analise de vendas leem).
//   estoque .... a quantidade do modelo, so entre anuncios fora do Full (o estoque do Full e do ML)
//   descricao .. o texto do modelo (PUT /items/{id}/description)
//   imagens .... as fotos do modelo, na mesma ordem (PUT /items/{id} com os ids das fotos); anuncio com variacoes fica de fora
//   dimensoes .. medidas e peso do pacote do modelo (atributos SELLER_PACKAGE_HEIGHT/WIDTH/LENGTH/WEIGHT)
// Sempre em dois passos: previa (le tudo de novo no ML e mostra antes -> depois) e aplicar (so os marcados). simular:true faz tudo menos gravar.
// Cada mudanca vai para STORAGE/nivelar_historico.jsonl com o valor de ANTES (descricao inteira, ids das fotos...), para dar para desfazer.
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const P = require('./precificador');

const STORAGE = () => process.env.STORAGE_PATH || path.join(__dirname, '../storage');
const HIST = () => path.join(STORAGE(), 'nivelar_historico.jsonl');
const ML = 'https://api.mercadolibre.com';
const CAMPOS = ['preco', 'estoque', 'descricao', 'imagens', 'dimensoes'];
const DIM = ['SELLER_PACKAGE_HEIGHT', 'SELLER_PACKAGE_WIDTH', 'SELLER_PACKAGE_LENGTH', 'SELLER_PACKAGE_WEIGHT'];
const DIM_NOME = { SELLER_PACKAGE_HEIGHT: 'altura', SELLER_PACKAGE_WIDTH: 'largura', SELLER_PACKAGE_LENGTH: 'comprimento', SELLER_PACKAGE_WEIGHT: 'peso' };
const r2 = (v) => Math.round(Number(v) * 100) / 100;
const dormir = (ms) => new Promise(r => setTimeout(r, ms));

async function chamar(fn) {
    for (let t = 1; ; t++) {
        try { return await fn(); }
        catch (e) { const s = e.response?.status; if ((s === 429 || s >= 500 || !e.response) && t < 4) { await dormir(1500 * t); continue; } throw e; }
    }
}
const erroML = (e) => { const d = e.response?.data || {}; const causa = (d.cause || []).map(c => c.message || c.code).filter(Boolean).join('; '); return `O ML recusou (${e.response?.status || 'sem resposta'}): ${d.message || d.error || e.message}${causa ? ' — ' + causa : ''}`; };

// os SKUs com 2+ anuncios que nao estao finalizados (a lista da aba Anuncios)
async function grupos() {
    const { itens } = await require('./anuncios_ad').lista();
    const g = {};
    for (const i of itens) if (i.sku && i.aba !== 'finalizados') (g[i.sku.toLowerCase()] ||= []).push(i);
    return Object.values(g).filter(L => L.length > 1).map(L => ({
        sku: L[0].sku, preco_diferente: new Set(L.map(i => i.preco)).size > 1, estoque_diferente: new Set(L.map(i => i.disponivel)).size > 1,
        itens: L.map(i => ({ id: i.id, titulo: i.titulo, tipo: i.tipo_nome, preco: i.preco, disponivel: i.disponivel, vendidos: i.vendidos, full: i.full, aba: i.aba, foto: i.foto, fotos: i.fotos, variacoes: i.variacoes })),
    })).sort((a, b) => (b.preco_diferente - a.preco_diferente) || a.sku.localeCompare(b.sku));
}

async function lerItem(headers, id) { return (await chamar(() => axios.get(`${ML}/items/${id}`, { headers, params: { include_attributes: 'all' }, timeout: 20000 }))).data; }
async function lerDescricao(headers, id) { try { return (await chamar(() => axios.get(`${ML}/items/${id}/description`, { headers, timeout: 20000 }))).data.plain_text || ''; } catch { return ''; } }
async function freteDe(headers, userId, id) { try { return (await chamar(() => axios.get(`${ML}/users/${userId}/shipping_options/free`, { headers, params: { item_id: id }, timeout: 20000 }))).data.coverage?.all_country?.list_cost ?? null; } catch { return null; } }
const skuDe = (it) => it.seller_custom_field || ((it.attributes || []).find(a => a.id === 'SELLER_SKU') || {}).value_name || '';
const dims = (it) => Object.fromEntries(DIM.map(k => [k, ((it.attributes || []).find(a => a.id === k) || {}).value_name || null]));
const dimTexto = (d) => DIM.map(k => d[k] ? `${DIM_NOME[k]} ${d[k]}` : null).filter(Boolean).join(' · ') || 'sem medidas';

// MC de um anuncio num preco: preco - custo - imposto - tarifa(preco, tipo) - frete
async function mcNoPreco(headers, it, preco, custo, impPct, frete) {
    const t = await P.tarifa(headers, preco, it.listing_type_id, it.category_id);
    if (!t) return null;
    const mc = preco - custo - preco * impPct / 100 - t.valor - frete;
    return { mc: r2(mc), pct: r2(mc / preco * 100), tarifa: t };
}
// preco que da a MC% alvo: p = (custo + frete + parte fixa da tarifa) / (1 - imposto - % da tarifa - MC%), refeito com a tarifa do preco novo
async function precoParaMargem(headers, it, alvoPct, custo, impPct, frete) {
    let p = it.price;
    for (let i = 0; i < 6; i++) {
        const t = await P.tarifa(headers, p, it.listing_type_id, it.category_id);
        if (!t) return null;
        const pct = t.pct != null ? Number(t.pct) : (t.valor / p * 100);
        const fixa = Math.max(0, t.valor - p * pct / 100);
        const div = 1 - impPct / 100 - pct / 100 - alvoPct / 100;
        if (div <= 0.05) return null;
        const novo = r2((custo + frete + fixa) / div);
        if (Math.abs(novo - p) < 0.01) { p = novo; break; }
        p = novo;
    }
    return p;
}

async function previa({ campo, modelo } = {}) {
    if (!CAMPOS.includes(campo)) throw new Error('Campo inválido.');
    if (!/^MLB\d+$/.test(String(modelo || ''))) throw new Error('Escolha o anúncio modelo.');
    const { headers, userId } = await P.auth();
    const m = await lerItem(headers, modelo);
    const sku = skuDe(m);
    if (!sku) throw new Error('O anúncio modelo não tem SKU.');
    const { itens } = await require('./anuncios_ad').lista();
    const alvosIds = itens.filter(i => i.sku && i.sku.toLowerCase() === sku.toLowerCase() && i.id !== modelo && i.aba !== 'finalizados').map(i => i.id);
    if (!alvosIds.length) throw new Error(`Não há outro anúncio com o SKU ${sku} para nivelar.`);

    const out = { campo, sku, modelo: { id: m.id, titulo: m.title, tipo: ['gold_pro', 'gold_premium'].includes(m.listing_type_id) ? 'Premium' : 'Clássico', full: m.shipping?.logistic_type === 'fulfillment' }, alvos: [] };
    let mDesc = null, mDims = null, mMc = null, custo = null, impPct = null;
    if (campo === 'descricao') { mDesc = await lerDescricao(headers, modelo); if (!mDesc) throw new Error('O modelo não tem descrição.'); out.modelo.valor = `${mDesc.length} caracteres`; out.modelo.texto = mDesc; }
    if (campo === 'imagens') { if (!(m.pictures || []).length) throw new Error('O modelo não tem fotos.'); out.modelo.valor = `${m.pictures.length} fotos`; out.modelo.fotos = m.pictures.map(f => f.secure_url || f.url); }
    if (campo === 'dimensoes') { mDims = dims(m); if (!Object.values(mDims).some(Boolean)) throw new Error('O modelo não tem medidas do pacote cadastradas.'); out.modelo.valor = dimTexto(mDims); }
    if (campo === 'estoque') { if (out.modelo.full) throw new Error('O modelo está no Full: o estoque dele é do Full. Escolha como modelo um anúncio fora do Full.'); out.modelo.valor = `${m.available_quantity} disponíveis`; }
    if (campo === 'preco') {
        const c = P.custoDoSku(sku);
        if (!c) throw new Error(`O SKU ${sku} não tem custo na planilha: cadastre na balança (Atributo do SKU) para calcular a margem.`);
        custo = c.valor;
        impPct = require('./impostos_sku').pctDoSku(sku) ?? require('./mt_financeiro').impostoPct();
        const fm = await freteDe(headers, userId, modelo);
        if (fm == null) throw new Error('Não consegui ler o frete do modelo no ML.');
        mMc = await mcNoPreco(headers, m, m.price, custo, impPct, fm);
        if (!mMc) throw new Error('Não consegui ler a tarifa do modelo no ML.');
        Object.assign(out.modelo, { valor: `R$ ${r2(m.price).toFixed(2).replace('.', ',')} · MC ${String(mMc.pct).replace('.', ',')}%`, preco: m.price, mc_pct: mMc.pct, custo, imposto_pct: impPct });
    }

    for (const id of alvosIds) {
        const a = await lerItem(headers, id);
        const r = { id, titulo: a.title, tipo: ['gold_pro', 'gold_premium'].includes(a.listing_type_id) ? 'Premium' : 'Clássico', full: a.shipping?.logistic_type === 'fulfillment', status: a.status, pode: true, igual: false, aviso: '' };
        if (!['active', 'paused'].includes(a.status)) { r.pode = false; r.motivo = `anúncio ${a.status}: o ML não deixa alterar`; }
        if (campo === 'preco') {
            const fa = await freteDe(headers, userId, id);
            const novo = fa == null ? null : await precoParaMargem(headers, a, mMc.pct, custo, impPct, fa);
            const depoisMc = novo ? await mcNoPreco(headers, a, novo, custo, impPct, fa) : null;
            const antesMc = fa == null ? null : await mcNoPreco(headers, a, a.price, custo, impPct, fa);
            Object.assign(r, { antes: a.price, depois: novo, antes_mc: antesMc && antesMc.pct, depois_mc: depoisMc && depoisMc.pct, frete: fa });
            if (novo == null) { r.pode = false; r.motivo = r.motivo || 'não consegui calcular (frete ou tarifa do ML)'; }
            else if (Math.abs(novo - a.price) < 0.01) r.igual = true;
            if (novo && ((a.price >= 79) !== (novo >= 79))) r.aviso = 'Cruza R$ 79: o frete grátis muda e o frete pode mudar depois da alteração.';
        } else if (campo === 'estoque') {
            Object.assign(r, { antes: a.available_quantity, depois: m.available_quantity });
            if (r.full) { r.pode = false; r.motivo = 'anúncio no Full: o estoque é do Full'; }
            else if ((a.variations || []).length) { r.pode = false; r.motivo = 'tem variações: o estoque é por variação'; }
            r.igual = a.available_quantity === m.available_quantity;
        } else if (campo === 'descricao') {
            const d = await lerDescricao(headers, id);
            Object.assign(r, { antes: `${d.length} caracteres`, depois: `${mDesc.length} caracteres`, antes_texto: d });
            r.igual = d.trim() === mDesc.trim();
        } else if (campo === 'imagens') {
            const ids = (a.pictures || []).map(f => f.id), mids = m.pictures.map(f => f.id);
            Object.assign(r, { antes: `${ids.length} fotos`, depois: `${mids.length} fotos`, antes_fotos: (a.pictures || []).map(f => f.secure_url || f.url), antes_ids: ids });
            if ((a.variations || []).length) { r.pode = false; r.motivo = 'tem variações: as fotos são por variação'; }
            r.igual = ids.join(',') === mids.join(',');
        } else if (campo === 'dimensoes') {
            const d = dims(a);
            Object.assign(r, { antes: dimTexto(d), depois: dimTexto(mDims) });
            r.igual = DIM.every(k => (d[k] || null) === (mDims[k] || null));
        }
        out.alvos.push(r);
    }
    return out;
}

let rodando = false;
async function aplicar({ campo, modelo, alvos = [], simular = true, confirmarGrande = false } = {}) {
    if (rodando) throw new Error('Já existe um nivelamento em andamento. Espere terminar.');
    const marcados = new Set((alvos || []).map(String));
    if (!marcados.size) throw new Error('Marque pelo menos um anúncio.');
    rodando = true;
    try {
        const pv = await previa({ campo, modelo });   // le tudo de novo: aplica sobre o estado de AGORA, nao o da tela
        const { headers } = await P.auth();
        const H = { ...headers, 'Content-Type': 'application/json' };
        const resultado = [];
        let mFotos = null, mDims = null, mDesc = pv.modelo.texto || null;
        if (campo === 'imagens') mFotos = (await lerItem(headers, modelo)).pictures.map(f => ({ id: f.id }));
        if (campo === 'dimensoes') mDims = dims(await lerItem(headers, modelo));
        for (const a of pv.alvos.filter(x => marcados.has(x.id))) {
            const r = { item_id: a.id, titulo: a.titulo, antes: a.antes, depois: a.depois };
            if (!a.pode) { resultado.push({ ...r, ok: false, erro: a.motivo }); continue; }
            if (a.igual) { resultado.push({ ...r, ok: true, aviso: 'já estava igual ao modelo' }); continue; }
            if (simular) { resultado.push({ ...r, ok: true, simulado: true }); continue; }
            try {
                if (campo === 'preco') {
                    const x = await P.aplicar(a.id, a.depois, { confirmarGrande, origem: 'nivelar', motivo: `nivelar margem pelo modelo ${modelo} (${pv.modelo.mc_pct}%)` });
                    if (!x.ok) { resultado.push({ ...r, ok: false, erro: x.erro, precisa_confirmar: !!x.precisa_confirmar }); continue; }
                } else if (campo === 'estoque') {
                    await chamar(() => axios.put(`${ML}/items/${a.id}`, { available_quantity: a.depois }, { headers: H, timeout: 30000 }));
                } else if (campo === 'descricao') {
                    await chamar(() => axios.put(`${ML}/items/${a.id}/description`, { plain_text: mDesc }, { headers: H, timeout: 30000 }));
                } else if (campo === 'imagens') {
                    await chamar(() => axios.put(`${ML}/items/${a.id}`, { pictures: mFotos }, { headers: H, timeout: 60000 }));
                } else if (campo === 'dimensoes') {
                    await chamar(() => axios.put(`${ML}/items/${a.id}`, { attributes: DIM.filter(k => mDims[k]).map(k => ({ id: k, value_name: mDims[k] })) }, { headers: H, timeout: 30000 }));
                }
                resultado.push({ ...r, ok: true });
                try {
                    fs.mkdirSync(STORAGE(), { recursive: true });
                    fs.appendFileSync(HIST(), JSON.stringify({ quando: new Date().toISOString(), campo, modelo, sku: pv.sku, item_id: a.id, antes: a.antes, depois: a.depois,
                        antes_texto: a.antes_texto, antes_ids: a.antes_ids }) + '\n', 'utf8');
                } catch {}
            } catch (e) { resultado.push({ ...r, ok: false, erro: erroML(e) }); }
            await dormir(400);
        }
        return { ok: true, simulado: !!simular, campo, sku: pv.sku, resultado };
    } finally { rodando = false; }
}

module.exports = { grupos, previa, aplicar, CAMPOS };
