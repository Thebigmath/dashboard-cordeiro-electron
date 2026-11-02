// Fotos do anuncio (02/11/2026, so na Cordeiro): ver, reordenar, remover e subir fotos novas pela aba Anuncios.
//   ler ........ fotos na ordem (a 1a e a capa), quais variacoes usam cada uma e o maximo da categoria (settings.max_pictures_per_item)
//   salvar ..... sobe as novas (POST /pictures/items/upload) e grava a lista na ordem nova (PUT /items/{id} { pictures }).
//                Foto usada por uma variacao NAO pode sair (o ML recusa e a variacao ficaria sem foto). simular:true valida e nao grava.
//   desfazer ... volta a lista de fotos de antes da ultima alteracao feita aqui (os ids antigos continuam no ML)
// Cada alteracao vai para STORAGE/fotos_historico.jsonl com os ids de antes e de depois.
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const P = require('./precificador');

const STORAGE = () => process.env.STORAGE_PATH || path.join(__dirname, '../storage');
const HIST = () => path.join(STORAGE(), 'fotos_historico.jsonl');
const ML = 'https://api.mercadolibre.com';
const TIPOS = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const MAX_BYTES = 10 * 1024 * 1024;
const dormir = (ms) => new Promise(r => setTimeout(r, ms));
const erroML = (e) => { const d = e.response?.data || {}; const causa = (d.cause || []).map(c => c.message || c.code).filter(Boolean).join('; '); return `O ML recusou (${e.response?.status || 'sem resposta'}): ${d.message || d.error || e.message}${causa ? ' — ' + causa : ''}`; };
async function chamar(fn) {
    for (let t = 1; ; t++) {
        try { return await fn(); }
        catch (e) { const s = e.response?.status; if ((s === 429 || s >= 500 || !e.response) && t < 4) { await dormir(1500 * t); continue; } throw e; }
    }
}

const maxPorCategoria = new Map();
async function ler(id) {
    const { headers } = await P.auth();
    const it = (await chamar(() => axios.get(`${ML}/items/${id}`, { headers, timeout: 20000 }))).data;
    if (!maxPorCategoria.has(it.category_id)) {
        try { const s = (await axios.get(`${ML}/categories/${it.category_id}`, { timeout: 20000 })).data.settings || {}; maxPorCategoria.set(it.category_id, { item: s.max_pictures_per_item || 12, variacao: s.max_pictures_per_item_var || 10 }); }
        catch { maxPorCategoria.set(it.category_id, { item: 12, variacao: 10 }); }
    }
    const usoVar = {};
    for (const v of it.variations || []) {
        const nome = (v.attribute_combinations || []).map(a => a.value_name).filter(x => x && /[\p{L}\p{N}]/u.test(x)).join(' / ') || String(v.id);
        for (const pid of v.picture_ids || []) (usoVar[pid] ||= []).push(nome);
    }
    // com variacoes o limite da categoria vale POR VARIACAO (MLB6149387602: 14 fotos, 7 por lado, limite 12): aqui so reordena,
    // subir ou tirar foto de variacao e outra operacao (as fotos ficam presas as variacoes)
    const nVar = (it.variations || []).length, lim = maxPorCategoria.get(it.category_id);
    const historico = desfazivel(id);
    return { id: it.id, titulo: it.title, status: it.status, max: nVar ? (it.pictures || []).length : lim.item, so_reordenar: nVar > 0, variacoes: nVar,
        fotos: (it.pictures || []).map(f => ({ id: f.id, url: f.secure_url || f.url, tamanho: f.size, max_tamanho: f.max_size, variacoes: usoVar[f.id] || [] })),
        pode_desfazer: !!historico, desfazer_em: historico && historico.quando };
}

async function subir(headers, n) {
    const tipo = String(n.tipo || '').toLowerCase();
    if (!TIPOS[tipo]) throw new Error(`"${n.nome}": formato não aceito (use JPG, PNG ou WEBP).`);
    const buf = Buffer.from(String(n.base64 || '').replace(/^data:[^,]+,/, ''), 'base64');
    if (!buf.length) throw new Error(`"${n.nome}": arquivo vazio.`);
    if (buf.length > MAX_BYTES) throw new Error(`"${n.nome}": maior que 10 MB.`);
    const form = new FormData();
    form.append('file', new Blob([buf], { type: tipo }), `foto.${TIPOS[tipo]}`);
    const r = await fetch(`${ML}/pictures/items/upload`, { method: 'POST', headers: { Authorization: headers.Authorization }, body: form, signal: AbortSignal.timeout(90000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.id) throw new Error(`"${n.nome}": o ML recusou a foto (${r.status}): ${j.message || j.error || 'sem detalhe'}`);
    return j.id;
}

// ordem: [{ id: 'id-de-foto-existente' } | { nova: indice em novas }]
async function salvar({ id, ordem = [], novas = [], simular = true } = {}) {
    if (!/^MLB\d+$/.test(String(id || ''))) throw new Error('Anúncio inválido.');
    const atual = await ler(id);
    if (!['active', 'paused'].includes(atual.status)) throw new Error(`Anúncio ${atual.status}: o ML não deixa alterar as fotos.`);
    if (!ordem.length) throw new Error('O anúncio precisa de pelo menos uma foto.');
    if (atual.so_reordenar && ordem.some(o => o.nova != null)) throw new Error('Anúncio com variações: aqui só dá para reordenar. As fotos novas vão em cada variação, no Mercado Livre.');
    if (ordem.length > atual.max) throw new Error(`São ${ordem.length} fotos: o máximo desta categoria é ${atual.max}.`);
    for (const n of novas) {   // formato e tamanho validados ja na simulacao (antes so na hora de subir)
        if (!TIPOS[String(n.tipo || '').toLowerCase()]) throw new Error(`"${n.nome}": formato não aceito (use JPG, PNG ou WEBP).`);
        if (Buffer.byteLength(String(n.base64 || '').replace(/^data:[^,]+,/, ''), 'base64') > MAX_BYTES) throw new Error(`"${n.nome}": maior que 10 MB.`);
    }
    const existentes = new Map(atual.fotos.map(f => [f.id, f]));
    for (const o of ordem) {
        if (o.id != null && !existentes.has(o.id)) throw new Error('Uma das fotos não existe mais no anúncio: recarregue a galeria.');
        if (o.nova != null && !novas[o.nova]) throw new Error('Foto nova sem arquivo.');
    }
    const ficam = new Set(ordem.filter(o => o.id).map(o => o.id));
    const presas = atual.fotos.filter(f => !ficam.has(f.id) && f.variacoes.length);
    if (presas.length) throw new Error(`Não dá para remover foto usada por variação: ${presas.map(f => `foto ${atual.fotos.indexOf(f) + 1} (${f.variacoes.join(', ')})`).join('; ')}.`);
    const antes = atual.fotos.map(f => f.id);
    const resumo = { removidas: atual.fotos.length - ficam.size, novas: ordem.filter(o => o.nova != null).length, total: ordem.length, capa_mudou: (ordem[0].id || 'nova') !== antes[0] };
    if (simular) return { ok: true, simulado: true, ...resumo };
    const { headers } = await P.auth();
    const idsNovas = [];
    for (const n of novas) { idsNovas.push(await subir(headers, n)); await dormir(300); }
    const depois = ordem.map(o => o.id != null ? o.id : idsNovas[o.nova]);
    try {
        await chamar(() => axios.put(`${ML}/items/${id}`, { pictures: depois.map(x => ({ id: x })) }, { headers: { ...headers, 'Content-Type': 'application/json' }, timeout: 60000 }));
    } catch (e) { return { ok: false, erro: erroML(e) }; }
    try { fs.mkdirSync(STORAGE(), { recursive: true }); fs.appendFileSync(HIST(), JSON.stringify({ quando: new Date().toISOString(), item_id: id, titulo: atual.titulo, antes, depois }) + '\n', 'utf8'); } catch {}
    return { ok: true, ...resumo, galeria: await ler(id) };
}

function desfazivel(id) {
    try {
        const L = fs.readFileSync(HIST(), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(l => l.item_id === id);
        const u = L[L.length - 1];
        return u && !u.desfeito ? u : null;
    } catch { return null; }
}
async function desfazer(id) {
    const u = desfazivel(id);
    if (!u) throw new Error('Não há alteração de fotos feita pelo SEVEN para desfazer neste anúncio.');
    const { headers } = await P.auth();
    const atual = await ler(id);
    try {
        await chamar(() => axios.put(`${ML}/items/${id}`, { pictures: u.antes.map(x => ({ id: x })) }, { headers: { ...headers, 'Content-Type': 'application/json' }, timeout: 60000 }));
    } catch (e) { return { ok: false, erro: erroML(e) }; }
    fs.appendFileSync(HIST(), JSON.stringify({ quando: new Date().toISOString(), item_id: id, titulo: atual.titulo, antes: atual.fotos.map(f => f.id), depois: u.antes, desfeito: true }) + '\n', 'utf8');
    return { ok: true, galeria: await ler(id) };
}

module.exports = { ler, salvar, desfazer };
