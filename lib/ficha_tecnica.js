// Ficha tecnica do anuncio (02/11/2026, so na Cordeiro), no molde do MT: os atributos que o ML deixa editar, nos mesmos grupos do
// formulario do ML (/categories/{id}/technical_specs/input: "Caracteristicas principais", "Registros de produtos"...).
//   ler ...... grupos e campos editaveis (fora os ocultos e os so de leitura; "fixo" aparece sem edicao), valor atual, opcoes e unidades
//   salvar ... so os atributos mudados (PUT /items/{id} { attributes }). massa:true grava o mesmo nos outros anuncios do MESMO SKU.
//              Atributo de variacao em anuncio com variacoes fica de fora (e por variacao). simular:true valida e nao grava.
// Cada gravacao vai para STORAGE/ficha_historico.jsonl com o valor de antes de cada atributo.
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const P = require('./precificador');

const STORAGE = () => process.env.STORAGE_PATH || path.join(__dirname, '../storage');
const HIST = () => path.join(STORAGE(), 'ficha_historico.jsonl');
const ML = 'https://api.mercadolibre.com';
const dormir = (ms) => new Promise(r => setTimeout(r, ms));
const erroML = (e) => { const d = e.response?.data || {}; const causa = (d.cause || []).map(c => c.message || c.code).filter(Boolean).join('; '); return `O ML recusou (${e.response?.status || 'sem resposta'}): ${d.message || d.error || e.message}${causa ? ' — ' + causa : ''}`; };
async function chamar(fn) {
    for (let t = 1; ; t++) {
        try { return await fn(); }
        catch (e) { const s = e.response?.status; if ((s === 429 || s >= 500 || !e.response) && t < 4) { await dormir(1500 * t); continue; } throw e; }
    }
}
const FORA = ['hidden', 'read_only', 'vip_hidden'];
const NAO_AQUI = new Set(['SELLER_SKU']);   // o SKU muda pela balanca/anuncio, nao pela ficha

const cacheCat = new Map();
async function estrutura(headers, cat) {
    const c = cacheCat.get(cat);
    if (c && Date.now() - c.em < 6 * 3600 * 1000) return c.d;
    const [spec, attrs, info] = await Promise.all([
        chamar(() => axios.get(`${ML}/categories/${cat}/technical_specs/input`, { headers, timeout: 25000 })).then(r => r.data),
        chamar(() => axios.get(`${ML}/categories/${cat}/attributes`, { headers, timeout: 25000 })).then(r => r.data),
        chamar(() => axios.get(`${ML}/categories/${cat}`, { timeout: 25000 })).then(r => r.data).catch(() => ({})),
    ]);
    const d = { spec, attrs: new Map((attrs || []).map(a => [a.id, a])), caminho: (info.path_from_root || []).map(p => p.name).join(' > ') };
    cacheCat.set(cat, { em: Date.now(), d });
    return d;
}

async function lerItem(headers, id) { return (await chamar(() => axios.get(`${ML}/items/${id}`, { headers, params: { include_attributes: 'all' }, timeout: 25000 }))).data; }
const skuDe = (it) => it.seller_custom_field || ((it.attributes || []).find(a => a.id === 'SELLER_SKU') || {}).value_name || '';

function campos(it, est) {
    const comVar = (it.variations || []).length > 0;
    const atual = new Map((it.attributes || []).map(a => [a.id, a]));
    const grupos = [];
    for (const g of est.spec.groups || []) {
        const L = [];
        for (const comp of g.components || []) {
            for (const a of comp.attributes || []) {
                const tags = a.tags || [];
                if (tags.some(t => FORA.includes(t)) || NAO_AQUI.has(a.id)) continue;
                if (comVar && tags.includes('variation_attribute')) continue;
                const meta = est.attrs.get(a.id) || {};
                const v = atual.get(a.id);
                L.push({ id: a.id, nome: comp.label || a.name || meta.name, tipo: a.value_type || meta.value_type, componente: comp.component,
                    obrigatorio: tags.includes('required') || tags.includes('catalog_required'), fixo: tags.includes('fixed'), multivalor: tags.includes('multivalued'),
                    dica: meta.hint || meta.tooltip || '', unidades: (meta.allowed_units || []).map(u => u.id), padrao_unidade: meta.default_unit || null,
                    opcoes: (meta.values || []).map(x => ({ id: x.id, nome: x.name })),
                    valor: v ? { id: v.value_id || null, nome: v.value_name || null, lista: (v.values || []).map(x => x.name).filter(Boolean) } : null });
            }
        }
        if (L.length) grupos.push({ id: g.id, nome: g.label, campos: L });
    }
    return grupos;
}

async function ler(id) {
    const { headers } = await P.auth();
    const it = await lerItem(headers, id);
    const est = await estrutura(headers, it.category_id);
    const sku = skuDe(it);
    const { itens } = await require('./anuncios_ad').lista();
    const mesmos = sku ? itens.filter(i => i.sku && i.sku.toLowerCase() === sku.toLowerCase() && i.id !== id && i.aba !== 'finalizados').map(i => ({ id: i.id, titulo: i.titulo })) : [];
    // Tabela de Medidas: so existe nas categorias de moda/calcados (atributo SIZE_GRID_ID); nas de autopecas o ML nao pede
    const grade = (it.attributes || []).find(a => a.id === 'SIZE_GRID_ID');
    return { id: it.id, titulo: it.title, sku, foto: (it.secure_thumbnail || it.thumbnail || '').replace(/^http:/, 'https:'), categoria: it.category_id, caminho: est.caminho,
        variacoes: (it.variations || []).length, status: it.status, grupos: campos(it, est), mesmo_sku: mesmos,
        tabela_medidas: { usa: est.attrs.has('SIZE_GRID_ID'), id: grade ? grade.value_name || grade.value_id : null } };
}

// mudanca: { id, value_name } | { id, value_id } | { id, values:[nomes] } | { id, limpar:true }
function corpoDe(m) {
    if (m.limpar) return { id: m.id, value_id: '-1', value_name: null };
    if (Array.isArray(m.values)) return { id: m.id, values: m.values.map(String).map(s => s.trim()).filter(Boolean).map(name => ({ name })) };
    if (m.value_id) return { id: m.id, value_id: String(m.value_id) };
    return { id: m.id, value_name: m.value_name == null ? null : String(m.value_name).trim() || null };   // vazio = apaga o valor
}
async function salvar({ id, mudancas = [], massa = false, simular = true } = {}) {
    if (!/^MLB\d+$/.test(String(id || ''))) throw new Error('Anúncio inválido.');
    if (!mudancas.length) throw new Error('Nada mudou na ficha técnica.');
    const base = await ler(id);
    const editaveis = new Map(base.grupos.flatMap(g => g.campos).filter(c => !c.fixo).map(c => [c.id, c]));
    for (const m of mudancas) {
        const c = editaveis.get(m.id);
        if (!c) throw new Error(`O atributo ${m.id} não pode ser editado por aqui.`);
        const vazio = m.limpar || (m.value_name != null && !String(m.value_name).trim()) || (Array.isArray(m.values) && !m.values.filter(x => String(x).trim()).length);
        if (c.obrigatorio && vazio) throw new Error(`"${c.nome}" é obrigatório: não dá para deixar vazio.`);
    }
    const alvos = [id, ...(massa ? base.mesmo_sku.map(x => x.id) : [])];
    const { headers } = await P.auth();
    const H = { ...headers, 'Content-Type': 'application/json' };
    const resultado = [];
    for (const alvo of alvos) {
        const r = { item_id: alvo };
        try {
            const it = alvo === id ? null : await lerItem(headers, alvo);
            const est = it ? await estrutura(headers, it.category_id) : null;
            const validos = it ? new Set(campos(it, est).flatMap(g => g.campos).filter(c => !c.fixo).map(c => c.id)) : new Set(editaveis.keys());
            const corpo = mudancas.filter(m => validos.has(m.id)).map(corpoDe);
            r.titulo = it ? it.title : base.titulo;
            r.atributos = corpo.length;
            if (!corpo.length) { r.ok = false; r.erro = 'nenhum dos atributos vale para este anúncio (categoria diferente?)'; resultado.push(r); continue; }
            if (!['active', 'paused'].includes(it ? it.status : base.status)) { r.ok = false; r.erro = `anúncio ${it ? it.status : base.status}: o ML não deixa alterar`; resultado.push(r); continue; }
            if (simular) { r.ok = true; r.simulado = true; resultado.push(r); continue; }
            const antes = new Map(((it || await lerItem(headers, alvo)).attributes || []).map(a => [a.id, { value_id: a.value_id, value_name: a.value_name }]));
            await chamar(() => axios.put(`${ML}/items/${alvo}`, { attributes: corpo }, { headers: H, timeout: 30000 }));
            r.ok = true;
            try { fs.mkdirSync(STORAGE(), { recursive: true }); fs.appendFileSync(HIST(), JSON.stringify({ quando: new Date().toISOString(), item_id: alvo, modelo: id, massa, mudancas: corpo, antes: Object.fromEntries(corpo.map(c => [c.id, antes.get(c.id) || null])) }) + '\n', 'utf8'); } catch {}
        } catch (e) { r.ok = false; r.erro = e.response ? erroML(e) : String(e.message || e); }
        resultado.push(r);
        await dormir(300);
    }
    return { ok: true, simulado: !!simular, resultado };
}

module.exports = { ler, salvar };
