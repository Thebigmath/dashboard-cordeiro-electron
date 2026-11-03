// Gerar Premium (pedido do usuario, 03/11/2026): Classico e Premium sao so duas condicoes de venda do MESMO produto.
// O motor NAO recria o anuncio: so ACRESCENTA a condicao de venda Premium ao User Product que ja existe, pela rota oficial
// POST /user-products/{UP}/items (preco por variacao). Estoque, ficha tecnica, fotos, family_name e titulo vem do produto.
//   candidatos() .. produtos (User Product) com Classico e sem Premium (lista do AD HEALTH > Anuncios)
//   fila .......... storage/premium_gerar.json; entra pela tela (marcando) ou por planilha com a coluna SKU (PRECO opcional)
//   preco ......... sugerido para a margem do Premium ficar 1 ponto acima da do Classico (regra de premium.js); editavel
//   validar() ..... CONFERENCIA do SEVEN (a rota do ML nao tem "validar sem criar"): produto existe, sem Premium,
//                   Classico ativo/pausado, preco e margem; nada e gravado no ML
//   aprovar() ..... so depois de conferido: cria a condicao Premium; se o item novo vier sem descricao/compatibilidades,
//                   copia as do Classico; registro em premium_gerar_historico.jsonl
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const P = require('./precificador');

const STORAGE = process.env.STORAGE_PATH || path.join(__dirname, '../storage');
const ARQ = path.join(STORAGE, 'premium_gerar.json');
const LOG = path.join(STORAGE, 'premium_gerar_historico.jsonl');
const ML = 'https://api.mercadolibre.com';
const PREMIUM = new Set(['gold_pro', 'gold_premium']);
const r2 = (v) => Math.round(v * 100) / 100;
const lerJson = (arq, d) => { try { return JSON.parse(fs.readFileSync(arq, 'utf8')); } catch { return d; } };
const ler = () => lerJson(ARQ, { fila: [] });
const gravar = (d) => { fs.mkdirSync(STORAGE, { recursive: true }); fs.writeFileSync(ARQ, JSON.stringify(d, null, 1), 'utf8'); };
const registrar = (x) => { try { fs.appendFileSync(LOG, JSON.stringify({ quando: new Date().toISOString(), ...x }) + '\n', 'utf8'); } catch {} };
const AD = () => require('./anuncios_ad');

// ---- candidatos --------------------------------------------------------------------------------------
// agrupa por User Product; o Classico de origem e o ativo, de preferencia o Full e o que mais vendeu
async function candidatos({ forcar = false } = {}) {
    const { itens } = await AD().lista({ forcar });
    const grupos = {};
    for (const i of itens) { if (i.status === 'closed') continue; const k = i.up || 'id:' + i.id; (grupos[k] ||= []).push(i); }
    const naFila = new Set(ler().fila.filter(x => x.status !== 'criado').map(x => x.id));
    const out = [];
    for (const [k, L] of Object.entries(grupos)) {
        if (L.some(i => PREMIUM.has(i.tipo))) continue;
        const cls = L.filter(i => i.tipo === 'gold_special' && ['active', 'paused'].includes(i.status));
        if (!cls.length) continue;
        const o = cls.sort((a, b) => (b.status === 'active') - (a.status === 'active') || (b.logistica === 'Full') - (a.logistica === 'Full') || (b.vendidos || 0) - (a.vendidos || 0))[0];
        out.push({ id: o.id, up: o.up || null, sku: o.sku || '', titulo: o.titulo, foto: o.foto, preco: o.preco, status: o.status, logistica: o.logistica, vendidos: o.vendidos || 0,
            disponivel: o.disponivel, custo: o.custo ?? null, variacoes: o.variacoes || 0, na_fila: naFila.has(o.id) });
    }
    out.sort((a, b) => (b.status === 'active') - (a.status === 'active') || b.vendidos - a.vendidos);
    return { total: out.length, ativos: out.filter(x => x.status === 'active').length, candidatos: out };
}

// ---- preco sugerido: margem do Premium = margem do Classico + 1 ponto ------------------------------------
async function sugerir(id, precoClassico) {
    const PONTOS = require('./premium').PONTOS_ACIMA;
    let x = precoClassico, r = null;
    for (let i = 0; i < 5; i++) {
        r = await AD().precificar({ id, classico: precoClassico, premium: x });
        const c = r.classico, p = r.premium;
        if (c.mc_pct == null || p.tarifa == null || r.frete == null || r.custo == null) return { preco: null, motivo: r.custo == null ? 'sem custo na planilha' : 'frete ou tarifa indisponível', classico: c };
        const tp = (p.tarifa_pct || 0) / 100, fixo = p.tarifa - x * tp;
        const novo = Math.ceil((r.frete + r.custo + fixo) / (1 - r.imposto_pct / 100 - tp - (c.mc_pct + PONTOS) / 100) * 100) / 100;
        if (!(novo > 0) || !isFinite(novo)) return { preco: null, motivo: 'a conta não fecha (margem do Clássico alta demais)', classico: c };
        if (Math.abs(novo - x) < 0.02) { x = novo; break; }
        x = novo;
    }
    r = await AD().precificar({ id, classico: precoClassico, premium: x });
    return { preco: r2(x), classico: r.classico, premium: r.premium, aviso_frete: r.premium.aviso_frete || '' };
}

// ---- fila --------------------------------------------------------------------------------------------
function lista() { return ler(); }
async function adicionar({ ids = [], precos = {} } = {}) {
    const { candidatos: cand } = await candidatos();
    const porId = new Map(cand.map(c => [c.id, c]));
    const d = ler(), novos = [], recusados = [];
    for (const id of [...new Set(ids)]) {
        const c = porId.get(id);
        if (!c) { recusados.push({ id, motivo: 'já tem Premium ou não está ativo/pausado' }); continue; }
        if (!c.up) { recusados.push({ id, motivo: 'sem produto (user_product_id) no ML' }); continue; }
        if (c.variacoes) { recusados.push({ id, motivo: 'anúncio com variações: faça pelo ML' }); continue; }
        if (d.fila.some(x => x.id === id && x.status !== 'criado')) continue;
        let s = { preco: null, motivo: '' };
        try { s = await sugerir(id, c.preco); } catch (e) { s = { preco: null, motivo: e.message }; }
        const manual = Number(String(precos[id] ?? '').replace(',', '.')) || null;
        const reg = { id, up: c.up, sku: c.sku, titulo: c.titulo, foto: c.foto, logistica: c.logistica, status_classico: c.status, preco_classico: c.preco,
            margem_classico: s.classico?.mc_pct ?? null, preco_sugerido: s.preco, preco: manual || s.preco, margem_premium: s.premium?.mc_pct ?? null,
            origem_preco: manual ? 'planilha' : s.preco ? 'sugerido' : null, aviso: s.motivo || s.aviso_frete || '', status: 'na_fila', adicionado_em: new Date().toISOString() };
        if (manual) { try { const r = await AD().precificar({ id, classico: c.preco, premium: manual }); reg.margem_premium = r.premium.mc_pct; reg.aviso = r.premium.aviso_frete || ''; } catch {} }
        d.fila.unshift(reg); novos.push(id);
    }
    gravar(d);
    return { adicionados: novos, recusados, ...d };
}
// planilha com a coluna SKU (e PRECO opcional): cada SKU vira os candidatos dele (um por produto)
async function importar(caminho) {
    const XLSX = require('xlsx');
    const wb = XLSX.readFile(caminho, { raw: true });
    const norm = (k) => String(k).trim().toUpperCase();
    let linhas = null, kSku = null, kPreco = null;
    for (const nome of wb.SheetNames) {
        const L = XLSX.utils.sheet_to_json(wb.Sheets[nome], { defval: '', raw: true });
        const cab = Object.keys(L[0] || {});
        const s = cab.find(k => norm(k) === 'SKU') || cab.find(k => norm(k).includes('SKU'));
        if (s) { linhas = L; kSku = s; kPreco = cab.find(k => /PRE[CÇ]O/.test(norm(k)) && /PREMIUM/.test(norm(k))) || cab.find(k => /^PRE[CÇ]O$/.test(norm(k))); break; }
    }
    if (!linhas) throw new Error('A planilha precisa ter a coluna SKU na primeira linha (e, se quiser, PRECO).');
    const { candidatos: cand } = await candidatos();
    const ids = [], precos = {}, semCandidato = [];
    for (const l of linhas) {
        const sku = String(l[kSku] || '').trim(); if (!sku) continue;
        const achou = cand.filter(c => c.sku.toLowerCase() === sku.toLowerCase());
        if (!achou.length) { semCandidato.push(sku); continue; }
        for (const c of achou) { ids.push(c.id); if (kPreco && l[kPreco] !== '') precos[c.id] = l[kPreco]; }
    }
    const r = await adicionar({ ids, precos });
    return { ...r, lidos: linhas.length, sem_candidato: semCandidato.slice(0, 200), sem_candidato_total: semCandidato.length };
}
function editar(id, { preco } = {}) {
    const d = ler(); const r = d.fila.find(x => x.id === id && x.status !== 'criado');
    if (!r) throw new Error('Anúncio não está na fila.');
    const p = r2(Number(String(preco || '').replace(',', '.')));
    if (!(p > 0)) throw new Error('Preço inválido.');
    r.preco = p; r.origem_preco = 'editado'; r.status = 'na_fila'; r.validacao = null;
    gravar(d);
    return r;
}
async function recalcular(id) {
    const d = ler(); const r = d.fila.find(x => x.id === id && x.status !== 'criado');
    if (!r) throw new Error('Anúncio não está na fila.');
    const x = await AD().precificar({ id, classico: r.preco_classico, premium: r.preco });
    r.margem_classico = x.classico.mc_pct; r.margem_premium = x.premium.mc_pct; r.aviso = x.premium.aviso_frete || '';
    gravar(d);
    return r;
}
function remover(id) { const d = ler(); d.fila = d.fila.filter(x => !(x.id === id && x.status !== 'criado')); gravar(d); return d; }

// ---- conferencia e criacao ------------------------------------------------------------------------------
async function origem(id) {
    const { headers, userId } = await P.auth();
    const it = (await axios.get(`${ML}/items/${id}`, { headers, timeout: 30000 })).data;
    return { headers, userId, it };
}
// o produto ja tem Premium? (todas as condicoes de venda do User Product)
async function premiumDoProduto(o) {
    const irmaos = (await axios.get(`${ML}/users/${o.userId}/items/search`, { headers: o.headers, params: { user_product_id: o.it.user_product_id }, timeout: 30000 })).data.results || [];
    for (const mlb of irmaos.filter(x => x !== o.it.id)) {
        const t = (await axios.get(`${ML}/items/${mlb}`, { headers: o.headers, params: { attributes: 'id,listing_type_id,status' }, timeout: 30000 })).data;
        if (PREMIUM.has(t.listing_type_id) && t.status !== 'closed') return mlb;
    }
    return null;
}
// so a condicao de venda: o resto (estoque, ficha, fotos, titulo) o ML herda do User Product
function corpo(it, preco) {
    const b = { price: preco, category_id: it.category_id, currency_id: it.currency_id || 'BRL', buying_mode: it.buying_mode || 'buy_it_now', listing_type_id: 'gold_pro' };
    const garantia = (it.sale_terms || []).filter(t => ['WARRANTY_TYPE', 'WARRANTY_TIME'].includes(t.id))
        .map(t => ({ id: t.id, ...(t.value_id ? { value_id: t.value_id } : {}), ...(t.value_name != null ? { value_name: t.value_name } : {}) }));
    if (garantia.length) b.sale_terms = garantia;
    return b;
}
const erroML = (e) => {
    const d = e.response?.data; if (!d) return e.message;
    const causas = (d.cause || []).filter(c => c.type !== 'warning').map(c => c.message).filter(Boolean);
    return [d.message, ...causas].filter(Boolean).join(' · ') || JSON.stringify(d).slice(0, 400);
};

async function validar(id) {
    const d = ler(); const r = d.fila.find(x => x.id === id && x.status !== 'criado');
    if (!r) throw new Error('Anúncio não está na fila.');
    const problemas = [], avisos = [];
    const o = await origem(id);
    if (!o.it.user_product_id) problemas.push('O anúncio não está no modelo de produto do ML (sem user_product_id).');
    if (!['active', 'paused'].includes(o.it.status)) problemas.push(`O Clássico está ${o.it.status}.`);
    if (o.it.listing_type_id !== 'gold_special') problemas.push('O anúncio de origem não é Clássico.');
    if ((o.it.variations || []).length) problemas.push('Anúncio com variações: faça pelo ML.');
    if (!(r.preco > 0)) problemas.push('Sem preço do Premium: informe o preço.');
    if (o.it.user_product_id && !problemas.length) {
        const ja = await premiumDoProduto(o);
        if (ja) problemas.push(`Este produto já tem Premium: ${ja}.`);
        try { await axios.get(`${ML}/user-products/${o.it.user_product_id}`, { headers: o.headers, timeout: 30000 }); }
        catch (e) { problemas.push(`O ML não encontrou o produto ${o.it.user_product_id}: ${erroML(e)}`); }
    }
    if (r.preco > 0 && r.preco_classico && r.preco <= r.preco_classico) avisos.push('O Premium ficou mais barato ou igual ao Clássico.');
    if (r.margem_premium != null && r.margem_classico != null && r.margem_premium <= r.margem_classico) avisos.push('A margem do Premium não está acima da do Clássico.');
    if (r.margem_premium != null && r.margem_premium < 0) avisos.push('Margem do Premium negativa.');
    const d2 = ler(); const x = d2.fila.find(y => y.id === id && y.status !== 'criado'); if (!x) return r;
    x.up = o.it.user_product_id || x.up;
    x.validacao = { ok: !problemas.length, em: new Date().toISOString(), erro: problemas.join(' '), avisos };
    x.status = problemas.length ? 'com_erro' : 'validado';
    gravar(d2);
    return x;
}

// cria de verdade: so conferido, com o preco conferido; confere de novo o "ja tem Premium" na hora
async function aprovar(id) {
    const d = ler(); const r = d.fila.find(x => x.id === id && x.status !== 'criado');
    if (!r) throw new Error('Anúncio não está na fila.');
    if (r.status !== 'validado') throw new Error('Confira antes de aprovar.');
    const o = await origem(id);
    if (!o.it.user_product_id) throw new Error('O anúncio não está no modelo de produto do ML.');
    const ja = await premiumDoProduto(o);
    if (ja) throw new Error(`Este produto já tem Premium: ${ja}. Nada foi criado.`);
    let novo;
    try { novo = (await axios.post(`${ML}/user-products/${o.it.user_product_id}/items`, corpo(o.it, r.preco), { headers: o.headers, timeout: 60000 })).data; }
    catch (e) {
        if (!e.response) throw e;
        const d2 = ler(); const x = d2.fila.find(y => y.id === id && y.status !== 'criado');
        if (x) { x.status = 'com_erro'; x.validacao = { ok: false, em: new Date().toISOString(), erro: 'O ML recusou: ' + erroML(e) }; gravar(d2); }
        registrar({ acao: 'erro', id, up: o.it.user_product_id, preco: r.preco, erro: erroML(e) });
        return x || r;
    }
    // descricao e compatibilidades sao do anuncio (nao do produto): so completa se o Premium nasceu sem
    const passos = [];
    try {
        const dn = await axios.get(`${ML}/items/${novo.id}/description`, { headers: o.headers, timeout: 30000 }).then(x => x.data.plain_text || '').catch(() => '');
        if (dn) passos.push('descrição herdada');
        else {
            const dc = await axios.get(`${ML}/items/${id}/description`, { headers: o.headers, timeout: 30000 }).then(x => x.data.plain_text || '').catch(() => '');
            if (dc) { await axios.post(`${ML}/items/${novo.id}/description`, { plain_text: dc }, { headers: o.headers, timeout: 30000 }); passos.push('descrição copiada do Clássico'); }
        }
    } catch (e) { passos.push('descrição falhou: ' + erroML(e)); }
    try {
        const cn = await axios.get(`${ML}/items/${novo.id}/compatibilities`, { headers: o.headers, timeout: 30000 }).then(x => x.data.products || []).catch(() => []);
        const cc = cn.length ? [] : await axios.get(`${ML}/items/${id}/compatibilities`, { headers: o.headers, timeout: 30000 }).then(x => x.data.products || []).catch(() => []);
        if (cn.length) passos.push(`${cn.length} compatibilidade(s) herdadas`);
        else if (cc.length) {
            for (let i = 0; i < cc.length; i += 200)
                await axios.post(`${ML}/items/${novo.id}/compatibilities`, { products: cc.slice(i, i + 200).map(c => ({ id: c.catalog_product_id || c.id, creation_source: 'DEFAULT' })) }, { headers: o.headers, timeout: 60000 });
            passos.push(`${cc.length} compatibilidade(s) copiadas do Clássico`);
        }
    } catch (e) { passos.push('compatibilidades falharam: ' + erroML(e)); }
    const mesmo = (novo.user_product_id || null) === o.it.user_product_id;
    const d3 = ler(); const x = d3.fila.find(y => y.id === id && y.status !== 'criado') || r;
    x.status = 'criado';
    x.criado = { id: novo.id, permalink: novo.permalink, status: novo.status, up: novo.user_product_id || null, mesmo_produto: mesmo, em: new Date().toISOString(), passos,
        aviso: mesmo ? '' : 'O ML devolveu outro produto para o Premium: confira no ML.' };
    gravar(d3);
    registrar({ acao: 'criado', id, premium: novo.id, preco: r.preco, up: o.it.user_product_id, up_novo: novo.user_product_id || null });
    return x;
}

module.exports = { candidatos, lista, adicionar, importar, editar, recalcular, remover, validar, aprovar, sugerir, corpo };
