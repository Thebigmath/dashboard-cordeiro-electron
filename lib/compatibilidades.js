// Compatibilidades com veiculos (02/11/2026, so na Cordeiro), no molde do MT:
//   ler ........ veiculos ja vinculados ao anuncio (Marca/Modelo/Ano/Versao + excecao), o que a categoria permite e os anuncios do mesmo SKU
//   arvore ..... opcoes de Marca > Modelo > Ano > Versao do catalogo de veiculos do ML (MLB-CARS_AND_VANS)
//   buscar ..... veiculos do catalogo para a marca/modelo/anos/versoes escolhidos
//   adicionar .. vincula veiculos a um ou mais anuncios (este, os do mesmo SKU, ou os destinos do "Replicar"); o que ja existe e pulado
//   remover .... tira vinculos do anuncio (guarda os veiculos tirados no historico para desfazer)
//   excecao .... grava a observacao ("Informar Excecao") de um vinculo
// Tudo que grava tem simular:true por padrao e vai para STORAGE/compat_historico.jsonl.
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const P = require('./precificador');

const STORAGE = () => process.env.STORAGE_PATH || path.join(__dirname, '../storage');
const HIST = () => path.join(STORAGE(), 'compat_historico.jsonl');
const CACHE_VEIC = () => path.join(STORAGE(), 'veiculos_cache.json');
const ML = 'https://api.mercadolibre.com';
const DOM = 'MLB-CARS_AND_VANS';
const NIVEIS = ['BRAND', 'MODEL', 'VEHICLE_YEAR', 'TRIM'];
const dormir = (ms) => new Promise(r => setTimeout(r, ms));
const erroML = (e) => { const d = e.response?.data || {}; const causa = (d.cause || []).map(c => c.message || c.code).filter(Boolean).join('; '); return `O ML recusou (${e.response?.status || 'sem resposta'}): ${d.message || d.error || e.message}${causa ? ' — ' + causa : ''}`; };
async function chamar(fn) {
    for (let t = 1; ; t++) {
        try { return await fn(); }
        catch (e) { const s = e.response?.status; if ((s === 429 || s >= 500 || !e.response) && t < 4) { await dormir(1500 * t); continue; } throw e; }
    }
}
function registrar(o) { try { fs.mkdirSync(STORAGE(), { recursive: true }); fs.appendFileSync(HIST(), JSON.stringify({ quando: new Date().toISOString(), ...o }) + '\n', 'utf8'); } catch {} }

// o que cada dominio permite (dump do ML, 1x por dia)
let regras = null;
async function regrasDoDominio(headers, dominio, categoria) {
    if (!regras || Date.now() - regras.em > 24 * 3600 * 1000) {
        const d = (await chamar(() => axios.get(`${ML}/catalog/dumps/domains/MLB/compatibilities`, { headers, timeout: 60000 }))).data;
        regras = { em: Date.now(), m: new Map((d || []).map(x => [x.domain_id, x])) };
    }
    const r = regras.m.get(dominio);
    const c = r && (r.compatibilities || []).find(x => x.compatible_domain_id === DOM);
    const cat = c && ((c.categories || []).find(x => x.id === categoria) || (c.categories || [])[0]);
    return { aceita: !!c, nota: cat ? cat.note_status === 'ENABLED' : false, universal: cat ? cat.universal_status === 'ENABLED' : false };
}

// Marca/Modelo/Ano/Versao de cada veiculo do catalogo (nao mudam: cache em arquivo)
let cacheVeic = null;
function veicCache() { if (!cacheVeic) { try { cacheVeic = JSON.parse(fs.readFileSync(CACHE_VEIC(), 'utf8')); } catch { cacheVeic = {}; } } return cacheVeic; }
const resumoVeic = (attrs, nome) => { const a = Object.fromEntries((attrs || []).map(x => [x.id, x.value_name])); return { marca: a.BRAND || '', modelo: a.MODEL || '', ano: a.VEHICLE_YEAR || '', versao: a.TRIM || '', motor: a.ENGINE || '', combustivel: a.FUEL_TYPE || '', nome: nome || [a.BRAND, a.MODEL, a.VEHICLE_YEAR, a.TRIM].filter(Boolean).join(' ') }; };
async function veiculos(headers, ids) {
    const c = veicCache(), faltam = [...new Set(ids)].filter(id => !c[id]);
    for (let k = 0; k < faltam.length; k += 6) {
        await Promise.all(faltam.slice(k, k + 6).map(async id => {
            try { const p = (await chamar(() => axios.get(`${ML}/products/${id}`, { headers, params: { attributes: 'id,name,attributes' }, timeout: 20000 }))).data; c[id] = resumoVeic(p.attributes, p.name); } catch {}
        }));
    }
    if (faltam.length) { try { fs.mkdirSync(STORAGE(), { recursive: true }); fs.writeFileSync(CACHE_VEIC(), JSON.stringify(c), 'utf8'); } catch {} }
    return c;
}

async function lerItem(headers, id) { return (await chamar(() => axios.get(`${ML}/items/${id}`, { headers, params: { attributes: 'id,title,status,category_id,domain_id,seller_custom_field,attributes,secure_thumbnail' }, timeout: 25000 }))).data; }
async function vinculos(headers, id) { return ((await chamar(() => axios.get(`${ML}/items/${id}/compatibilities`, { headers, timeout: 25000 }))).data.products || []).filter(p => p.domain_id === DOM || !p.domain_id); }
const skuDe = (it) => it.seller_custom_field || ((it.attributes || []).find(a => a.id === 'SELLER_SKU') || {}).value_name || '';

async function ler(id) {
    const { headers } = await P.auth();
    const it = await lerItem(headers, id);
    const [lista, perm] = await Promise.all([vinculos(headers, id), regrasDoDominio(headers, it.domain_id, it.category_id)]);
    const v = await veiculos(headers, lista.map(p => p.catalog_product_id));
    const sku = skuDe(it);
    const { itens } = await require('./anuncios_ad').lista();
    const mesmos = sku ? itens.filter(i => i.sku && i.sku.toLowerCase() === sku.toLowerCase() && i.id !== id && i.aba !== 'finalizados').map(i => ({ id: i.id, titulo: i.titulo })) : [];
    const ordem = (a, b) => (a.marca + a.modelo).localeCompare(b.marca + b.modelo) || String(a.ano).localeCompare(String(b.ano)) || a.versao.localeCompare(b.versao);
    const u = ultima(id);
    return { id: it.id, titulo: it.title, sku, status: it.status, dominio: it.domain_id, categoria: it.category_id, permite: perm, mesmo_sku: mesmos,
        desfazer: u ? `${u.acao === 'remover' ? 'Voltar' : 'Tirar'} ${u.produtos.length} veículo(s) ${u.acao === 'remover' ? 'removido(s)' : 'adicionado(s)'} em ${new Date(u.quando).toLocaleString('pt-BR')}` : null,
        vinculos: lista.map(p => ({ compat_id: p.id, produto: p.catalog_product_id, origem: p.source, nota: p.note || '', restricoes: p.restrictions || null,
            ...(v[p.catalog_product_id] || { marca: '', modelo: '', ano: '', versao: '', nome: p.catalog_product_name }) })).sort(ordem) };
}

// opcoes de um nivel dado o que ja foi escolhido acima (ex.: MODEL com {BRAND:'67781'})
const cacheArv = new Map();
async function arvore({ nivel, conhecidos = {} } = {}) {
    if (!NIVEIS.includes(nivel)) throw new Error('Nível inválido.');
    const known = NIVEIS.slice(0, NIVEIS.indexOf(nivel)).filter(k => conhecidos[k]).map(k => ({ id: k, value_id: String(conhecidos[k]) }));
    const chave = nivel + JSON.stringify(known);
    const c = cacheArv.get(chave); if (c && Date.now() - c.em < 6 * 3600 * 1000) return c.d;
    const { headers } = await P.auth();
    const r = (await chamar(() => axios.post(`${ML}/catalog_domains/${DOM}/attributes/${nivel}/top_values`, { known_attributes: known }, { headers, timeout: 25000 }))).data || [];
    const d = r.map(x => ({ id: x.id, nome: x.name })).sort((a, b) => nivel === 'VEHICLE_YEAR' ? Number(b.nome) - Number(a.nome) : a.nome.localeCompare(b.nome, 'pt-BR'));
    cacheArv.set(chave, { em: Date.now(), d });
    return d;
}

async function buscar({ marca, modelo, anos = [], versoes = [] } = {}) {
    if (!marca || !modelo) throw new Error('Escolha a marca e o modelo.');
    const known = [{ id: 'BRAND', value_ids: [String(marca)] }, { id: 'MODEL', value_ids: [String(modelo)] }];
    if (anos.length) known.push({ id: 'VEHICLE_YEAR', value_ids: anos.map(String) });
    if (versoes.length) known.push({ id: 'TRIM', value_ids: versoes.map(String) });
    const { headers } = await P.auth();
    // o ML devolve 50 por vez (Fiat Uno sem ano = 161 veiculos): pagina ate o total, no maximo 3000
    const c = veicCache(), L = [];
    let total = 0;
    do {
        const r = (await chamar(() => axios.post(`${ML}/catalog_compatibilities/products_search/chunks`, { domain_id: DOM, site_id: 'MLB', known_attributes: known }, { headers, params: { offset: L.length, limit: 50 }, timeout: 40000 }))).data || {};
        total = r.total || 0;
        const pag = r.results || [];
        if (!pag.length) break;
        for (const p of pag) { const v = resumoVeic(p.attributes); c[p.id] ||= v; L.push({ produto: p.id, ...v }); }
    } while (L.length < total && L.length < 3000);
    return { total, veiculos: L.sort((a, b) => String(b.ano).localeCompare(String(a.ano)) || a.versao.localeCompare(b.versao)) };
}

// alvos: anuncios que recebem os veiculos; produtos: ids de catalogo dos veiculos
async function adicionar({ alvos = [], produtos = [], simular = true, origem = 'cadastrar' } = {}) {
    alvos = [...new Set(alvos)].filter(a => /^MLB\d+$/.test(a));
    produtos = [...new Set(produtos.map(String))];
    if (!alvos.length) throw new Error('Nenhum anúncio escolhido.');
    if (!produtos.length) throw new Error('Nenhum veículo escolhido.');
    if (produtos.length > 3000) throw new Error('Mais de 3000 veículos de uma vez: divida em partes.');
    const { headers } = await P.auth();
    const H = { ...headers, 'Content-Type': 'application/json' };
    const resultado = [];
    for (const alvo of alvos) {
        const r = { item_id: alvo };
        try {
            const it = await lerItem(headers, alvo);
            r.titulo = it.title;
            const perm = await regrasDoDominio(headers, it.domain_id, it.category_id);
            if (!perm.aceita) { r.ok = false; r.erro = 'a categoria deste anúncio não aceita compatibilidade com veículos'; resultado.push(r); continue; }
            if (!['active', 'paused'].includes(it.status)) { r.ok = false; r.erro = `anúncio ${it.status}: o ML não deixa alterar`; resultado.push(r); continue; }
            const ja = new Set((await vinculos(headers, alvo)).map(p => p.catalog_product_id));
            const novos = produtos.filter(p => !ja.has(p));
            r.novos = novos.length; r.ja_tinha = produtos.length - novos.length;
            if (!novos.length) { r.ok = true; r.aviso = 'já tinha todos esses veículos'; resultado.push(r); continue; }
            if (simular) { r.ok = true; r.simulado = true; resultado.push(r); continue; }
            for (let k = 0; k < novos.length; k += 200) {
                await chamar(() => axios.post(`${ML}/items/${alvo}/compatibilities`, { products: novos.slice(k, k + 200).map(id => ({ id, creation_source: 'DEFAULT' })) }, { headers: H, timeout: 60000 }));
                await dormir(300);
            }
            r.ok = true;
            registrar({ acao: 'adicionar', origem, item_id: alvo, produtos: novos });
        } catch (e) { r.ok = false; r.erro = e.response ? erroML(e) : String(e.message || e); }
        resultado.push(r);
    }
    return { ok: true, simulado: !!simular, resultado };
}

async function remover({ id, compat_ids = [], simular = true } = {}) {
    if (!/^MLB\d+$/.test(String(id || ''))) throw new Error('Anúncio inválido.');
    if (!compat_ids.length) throw new Error('Nenhum veículo marcado.');
    const { headers } = await P.auth();
    const atuais = new Map((await vinculos(headers, id)).map(p => [String(p.id), p]));
    const alvo = compat_ids.map(String).filter(c => atuais.has(c));
    if (!alvo.length) throw new Error('Esses vínculos não existem mais no anúncio: recarregue.');
    if (simular) return { ok: true, simulado: true, removidos: alvo.length };
    const feitos = [], erros = [];
    for (const c of alvo) {
        try { await chamar(() => axios.delete(`${ML}/items/${id}/compatibilities/${c}`, { headers, timeout: 30000 })); feitos.push(atuais.get(c).catalog_product_id); }
        catch (e) { erros.push(erroML(e)); }
        await dormir(150);
    }
    if (feitos.length) registrar({ acao: 'remover', item_id: id, produtos: feitos });
    return { ok: !erros.length || !!feitos.length, removidos: feitos.length, erro: erros[0] || null, erros: erros.length };
}

async function excecao({ id, compat_id, nota = '', simular = true } = {}) {
    if (!/^MLB\d+$/.test(String(id || ''))) throw new Error('Anúncio inválido.');
    nota = String(nota || '').trim();
    if (nota.length > 500) throw new Error('A observação passa de 500 caracteres.');
    const { headers } = await P.auth();
    const it = await lerItem(headers, id);
    if (!(await regrasDoDominio(headers, it.domain_id, it.category_id)).nota) throw new Error('O ML não aceita observação de compatibilidade nesta categoria.');
    const atual = (await vinculos(headers, id)).find(p => String(p.id) === String(compat_id));
    if (!atual) throw new Error('Esse vínculo não existe mais no anúncio: recarregue.');
    if (simular) return { ok: true, simulado: true };
    try { await chamar(() => axios.put(`${ML}/items/${id}/compatibilities/${compat_id}`, { note: nota }, { headers: { ...headers, 'Content-Type': 'application/json' }, timeout: 30000 })); }
    catch (e) { return { ok: false, erro: erroML(e) }; }
    registrar({ acao: 'excecao', item_id: id, compat_id, produto: atual.catalog_product_id, antes: atual.note || '', depois: nota });
    return { ok: true };
}

// desfaz a ultima acao de adicionar/remover feita aqui neste anuncio
function ultima(id) {
    try {
        const L = fs.readFileSync(HIST(), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(l => l.item_id === id && ['adicionar', 'remover', 'desfeito'].includes(l.acao));
        const u = L[L.length - 1]; return u && u.acao !== 'desfeito' && u.origem !== 'desfazer' ? u : null;   // desfazer so a ultima, uma vez
    } catch { return null; }
}
async function desfazer({ id, simular = true } = {}) {
    const u = ultima(id);
    if (!u) throw new Error('Não há alteração de compatibilidade feita pelo SEVEN para desfazer neste anúncio.');
    if (u.acao === 'remover') {
        const r = await adicionar({ alvos: [id], produtos: u.produtos, simular, origem: 'desfazer' });
        if (!simular) registrar({ acao: 'desfeito', item_id: id, de: u.quando, desfeito: true });
        return { ...r, desfazendo: `volta ${u.produtos.length} veículo(s) removido(s) em ${new Date(u.quando).toLocaleString('pt-BR')}` };
    }
    const { headers } = await P.auth();
    const ids = new Set(u.produtos);
    const tirar = (await vinculos(headers, id)).filter(p => ids.has(p.catalog_product_id)).map(p => String(p.id));
    const r = await remover({ id, compat_ids: tirar, simular });
    if (!simular) registrar({ acao: 'desfeito', item_id: id, de: u.quando, desfeito: true });
    return { ...r, desfazendo: `tira ${tirar.length} veículo(s) adicionado(s) em ${new Date(u.quando).toLocaleString('pt-BR')}` };
}

module.exports = { ler, arvore, buscar, adicionar, remover, excecao, desfazer, ultima };
