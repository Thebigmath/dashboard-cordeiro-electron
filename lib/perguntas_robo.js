// Perguntas com robo (04/11/2026, pedido do usuario): a aba Perguntas do SEVEN e mediada por um robo, o mesmo motor do Harvey
// (mediacoes-ml-electron/lib/perguntas.js + aprendizado.js), so para a conta deste Dashboard.
//   1) a cada 2 min le as perguntas sem resposta do ML (GET /my/received_questions/search status=UNANSWERED)
//   2) para cada pergunta NOVA o robo le o anuncio (titulo, atributos, descricao, estoque, frete, garantia, variacoes,
//      tipo de venda Classico/Premium e o anuncio irmao do mesmo produto) e as respostas que a equipe ja deu, entende o que o
//      comprador quer (se pede outro carro/lado, procura no NOSSO catalogo) e redige a resposta com o Gemini (lib/gemini_seletor)
//   3) MODO PADRAO = so prepara: a resposta fica para alguem revisar e enviar. O modo automatico existe, mas comeca DESLIGADO
//      (escolha do usuario em 04/11/2026); ligado, so envia sozinho o que passa em todas as guardas do Harvey:
//        confianca "alta" e precisa_humano = false; trecho citado existe de verdade no anuncio; sem telefone/e-mail/link de fora;
//        sem resposta negativa ("nao temos", "sem estoque"); 5 a 2000 caracteres; ainda sem resposta no ML na hora de enviar
// Arquivos (STORAGE): perguntas_robo.json { [id]: registro } · perguntas_robo_itens.json (anuncio, 6 h) ·
//                     perguntas_robo_aprendizado.json (respostas reais da equipe, 1x por dia) · perguntas_robo_config.json { automatico }
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const TokenManager = require('./tokenManager');
const { notificar } = require('./notificar');

const STORAGE = process.env.STORAGE_PATH || path.join(__dirname, '../storage');
const ARQ = path.join(STORAGE, 'perguntas_robo.json');
const ITENS = path.join(STORAGE, 'perguntas_robo_itens.json');
const APRENDE = path.join(STORAGE, 'perguntas_robo_aprendizado.json');
const CONFIG = path.join(STORAGE, 'perguntas_robo_config.json');
const LOG = path.join(STORAGE, 'perguntas_robo_historico.jsonl');
const ML = 'https://api.mercadolibre.com';
const INTERVALO_MS = 2 * 60 * 1000;
const TIPO = { gold_special: 'Clássico', gold_pro: 'Premium', gold_premium: 'Premium', free: 'Grátis' };

const lerJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const gravarJson = (f, v) => { fs.mkdirSync(STORAGE, { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 1), 'utf8'); };
const registrar = (x) => { try { fs.mkdirSync(STORAGE, { recursive: true }); fs.appendFileSync(LOG, JSON.stringify({ quando: new Date().toISOString(), ...x }) + '\n', 'utf8'); } catch {} };
const automatico = () => !!lerJson(CONFIG, {}).automatico;
function setAutomatico(v) { const c = lerJson(CONFIG, {}); c.automatico = !!v; gravarJson(CONFIG, c); registrar({ evento: 'modo', automatico: !!v }); return c.automatico; }

const estado = { rodando: false, verificado_em: null, erro: null };
let timer = null, timerPrimeira = null;

async function auth() { const t = await TokenManager.getToken(); return { headers: { Authorization: `Bearer ${t.access_token}` }, userId: t.user_id }; }
async function get(url, params) {
    const { headers } = await auth();
    for (let t = 0; ; t++) {
        try { return (await axios.get(url, { headers, params, timeout: 30000 })).data; }
        catch (e) { const st = e.response?.status; if ((st === 429 || st >= 500) && t < 3) { await new Promise(r => setTimeout(r, 1500 * (t + 1))); continue; } throw e; }
    }
}

// ---- o anuncio (tudo o que o robo pode usar), cache de 6 h ----------------------------------------------------
async function irmaoMesmoProduto(it) {
    // Classico e Premium sao duas condicoes de venda do MESMO produto (User Product): o robo sabe se existe a outra
    if (!it.user_product_id) return null;
    try {
        const { userId } = await auth();
        const r = await get(`${ML}/users/${userId}/items/search`, { user_product_id: it.user_product_id, limit: 10 });
        const ids = (r.results || []).filter(id => id !== it.id);
        if (!ids.length) return null;
        const m = await get(`${ML}/items`, { ids: ids.slice(0, 5).join(','), attributes: 'id,listing_type_id,price,status,permalink,available_quantity,user_product_id' });
        // confere o User Product de cada um (se o filtro fosse ignorado pelo ML, viria anuncio de outro produto)
        const L = (m || []).map(x => x.body).filter(x => x && x.user_product_id === it.user_product_id && x.status === 'active' && x.listing_type_id !== it.listing_type_id);
        return L.length ? { tipo: TIPO[L[0].listing_type_id] || L[0].listing_type_id, preco: L[0].price, link: L[0].permalink } : null;
    } catch { return null; }
}
async function produto(itemId) {
    const cache = lerJson(ITENS, {});
    const c = cache[itemId];
    if (c && Date.now() - c.t < 6 * 3600 * 1000) return c.d;
    const it = await get(`${ML}/items/${itemId}`, { include_attributes: 'all' });
    let descricao = '';
    try { descricao = (await get(`${ML}/items/${itemId}/description`)).plain_text || ''; } catch {}
    let anteriores = [];
    try {
        const r = await get(`${ML}/questions/search`, { item: itemId, api_version: 4, limit: 30, sort_fields: 'date_created', sort_types: 'DESC' });
        anteriores = (r.questions || []).filter(q => q.answer && q.answer.text).slice(0, 12).map(q => ({ p: q.text, r: q.answer.text }));
    } catch {}
    const d = {
        id: it.id, titulo: it.title, preco: it.price, estoque: it.available_quantity, condicao: it.condition, status: it.status,
        tipo_de_venda: TIPO[it.listing_type_id] || it.listing_type_id, mesmo_produto_em_outro_tipo: await irmaoMesmoProduto(it),
        frete_gratis: !!it.shipping?.free_shipping, full: it.shipping?.logistic_type === 'fulfillment', link: it.permalink, thumbnail: it.thumbnail || '',
        garantia: (it.sale_terms || []).filter(s => /WARRANTY/.test(s.id)).map(s => `${s.name}: ${s.value_name}`).join(' · '),
        atributos: (it.attributes || []).filter(a => a.value_name && !/EMBALAGEM|PACKAGE|GTIN|Origem do dado|Regalavel/i.test(a.name + a.id)).map(a => `${a.name}: ${a.value_name}`).slice(0, 40),
        variacoes: (it.variations || []).map(v => (v.attribute_combinations || []).map(a => `${a.name}: ${a.value_name}`).join(', ') + ` (estoque ${v.available_quantity})`).slice(0, 20),
        descricao: descricao.slice(0, 4000), anteriores,
    };
    cache[itemId] = { t: Date.now(), d };
    gravarJson(ITENS, cache);
    return d;
}

// ---- nosso catalogo: o que o comprador pediu (outro lado, outro carro), so leitura ----------------------------
async function catalogo(busca, itemAtual) {
    const { userId } = await auth();
    const r = await get(`${ML}/users/${userId}/items/search`, { q: busca, status: 'active', limit: 8 });
    const ids = (r.results || []).filter(id => id !== itemAtual).slice(0, 6);
    if (!ids.length) return [];
    const m = await get(`${ML}/items`, { ids: ids.join(','), attributes: 'id,title,available_quantity,permalink,price,listing_type_id' });
    return (m || []).map(x => x.body).filter(Boolean).map(x => ({ titulo: x.title, estoque: x.available_quantity, preco: x.price, tipo: TIPO[x.listing_type_id] || '', link: x.permalink }));
}

// ---- aprendizado: perguntas ja respondidas pela equipe nesta conta (1x por dia) -------------------------------
let sincronizando = null;
async function sincronizarAprendizado() {
    if (sincronizando) return sincronizando;
    sincronizando = (async () => {
        const { userId } = await auth();
        const itens = [];
        for (let off = 0; off < 1000; off += 50) {
            let r;
            try { r = await get(`${ML}/questions/search`, { seller_id: userId, status: 'ANSWERED', api_version: 4, limit: 50, offset: off, sort_fields: 'date_created', sort_types: 'DESC' }); } catch { break; }
            for (const q of r.questions || []) if (q.answer && q.answer.text) itens.push({ item_id: q.item_id, p: String(q.text || '').slice(0, 400), r: String(q.answer.text).slice(0, 600), data: q.date_created });
            if (!(r.questions || []).length || off + 50 >= (r.total || 0)) break;
        }
        const ids = [...new Set(itens.map(x => x.item_id))], titulos = {};
        for (let i = 0; i < ids.length; i += 20) {
            try { for (const x of await get(`${ML}/items`, { ids: ids.slice(i, i + 20).join(','), attributes: 'id,title' })) if (x.code === 200) titulos[x.body.id] = x.body.title; } catch {}
        }
        for (const x of itens) x.titulo = titulos[x.item_id] || '';
        if (!itens.length) return lerJson(APRENDE, { em: null, itens: [] });
        const base = { em: new Date().toISOString(), itens };
        gravarJson(APRENDE, base);
        return base;
    })();
    try { return await sincronizando; } finally { sincronizando = null; }
}
function baseAprendizado() {
    const b = lerJson(APRENDE, { em: null, itens: [] });
    if (!b.em || Date.now() - new Date(b.em).getTime() > 24 * 3600 * 1000) sincronizarAprendizado().catch(() => {});
    return b;
}
const PARADAS = new Set('para com sem que uma uns umas por pelo pela pelos pelas mais esse essa este esta isso isto voce voces ele ela tem ter qual quais como quando onde serve servir fica ficar sao nao sim obrigado obrigada bom boa dia tarde noite ola oi produto peca pecas anuncio vcs vc pra pro'.split(' '));
const palavras = (t) => new Set(String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length >= 3 && !PARADAS.has(w)));
function exemplos(pergunta, titulo, itemId, max = 6) {
    const b = baseAprendizado();
    if (!b.itens.length) return [];
    const wp = palavras(pergunta), wt = palavras(titulo), notas = [];
    for (const x of b.itens) {
        let n = 0; const xp = palavras(x.p), xt = palavras(x.titulo);
        for (const w of wp) if (xp.has(w)) n += 3;
        for (const w of wt) if (xt.has(w)) n += 1;
        if (x.item_id === itemId) n += 2;
        if (n >= 4) notas.push([n, x]);
    }
    notas.sort((a, c) => c[0] - a[0] || String(c[1].data).localeCompare(String(a[1].data)));
    const vistos = new Set(), out = [];
    for (const [, x] of notas) { const k = x.r.slice(0, 60); if (vistos.has(k)) continue; vistos.add(k); out.push({ produto: x.titulo.slice(0, 70), pergunta: x.p, resposta: x.r }); if (out.length >= max) break; }
    return out;
}

// ---- IA (Gemini pelo seletor do SEVEN) ----------------------------------------------------------------------
const SISTEMA = `Voce responde perguntas de compradores num anuncio do Mercado Livre, em nome do vendedor (autopecas e acessorios).
REGRAS:
- Use SOMENTE os dados do anuncio recebidos (titulo, atributos, descricao, estoque, frete, garantia, variacoes, tipo de venda) e as respostas que o vendedor ja deu no mesmo anuncio. Nunca invente compatibilidade, medida, prazo, estoque ou caracteristica.
- Compatibilidade com veiculo: so confirme se o modelo e o ano estiverem no titulo, na descricao ou nos atributos. Se nao estiver claro, nao confirme.
- Nunca passe telefone, e-mail, redes sociais nem peca para falar fora do Mercado Livre (o ML proibe). Link SO dos nossos anuncios recebidos (catalogo ou o mesmo produto no outro tipo de venda).
- Nao prometa desconto, brinde, troca ou prazo que nao esteja no anuncio. Nao fale de senhas ou credenciais.
- TIPO DE VENDA: "Classico" e "Premium" sao duas condicoes de venda do mesmo produto; no Premium o comprador parcela sem juros. Se perguntarem de parcelamento sem juros num anuncio Classico e existir o mesmo produto no Premium (campo mesmo_produto_em_outro_tipo), indique o link dele. Sem esse campo, nao prometa parcelamento sem juros.
- Portugues do Brasil, cordial e curto (1 a 3 frases). Comece com "Olá!" e termine agradecendo, no tom das respostas anteriores do vendedor.
- Seja DIRETO: responda o que foi perguntado na 1a frase, sem enrolar. Siga o tom das RESPOSTAS REVISADAS PELA EQUIPE (quando vierem).
- ESTOQUE: se o estoque do anuncio (ou da variacao pedida) for 0, diga que esta sem estoque no momento.
- CATALOGO: alem deste anuncio voce recebe OUTROS ANUNCIOS NOSSOS encontrados para o que o comprador pediu (outro lado, outro carro, outra versao).
  * Se o comprador pede algo que NAO e este anuncio e existe um anuncio nosso com estoque > 0 que atende, indique esse anuncio e cole o LINK dele exatamente como veio (so links da lista; nunca invente link).
  * Se o que ele pediu (outro carro/modelo/lado) NAO aparece no catalogo, responda direto que nao temos (ex.: "Olá! Não temos para o Peugeot 208 no momento. Obrigado!").
  * Se o catalogo nao foi pesquisado (lista ausente), nao afirme que nao temos: diga que vai confirmar e marque precisa_humano = true.
- confianca "alta" SO quando a resposta esta claramente nos dados. Se faltar dado, se for reclamacao, negociacao de preco, pedido de produto que nao e do anuncio, ou algo que exija o vendedor: precisa_humano = true.
Responda SOMENTE com o JSON pedido.`;
function json(texto) {
    const t = String(texto || '').replace(/```json|```/g, '').trim();
    try { return JSON.parse(t); } catch {}
    const i = t.indexOf('{'), f = t.lastIndexOf('}');
    if (i >= 0 && f > i) { try { return JSON.parse(t.slice(i, f + 1)); } catch {} }
    return {};
}
const gerar = (sistema, prompt, numPredict, tarefa) => require('./ia').gerarGemini(sistema, prompt, numPredict, null, { json: true, tarefa });

async function entenderPergunta(pergunta, titulo) {
    const { texto } = await gerar('Voce extrai a intencao de perguntas de compradores do Mercado Livre (autopecas). Responda SOMENTE com o JSON pedido.',
        `ANUNCIO ONDE A PERGUNTA FOI FEITA: "${titulo}"
PERGUNTA: "${String(pergunta).slice(0, 600)}"

O comprador pede algo DIFERENTE deste anuncio (outro carro, outro modelo, outro ano, o outro lado, outra cor/versao)?
Responda com este JSON exato:
{"pede_outro": true|false, "busca": "3 a 5 palavras para buscar no catalogo do vendedor: tipo do produto + marca/modelo do carro + lado se houver (ex.: 'tapete peugeot 208', 'lanterna strada esquerdo'); vazio se pede_outro=false", "o_que": "o que ele quer em poucas palavras"}`, 400, 'Perguntas: intenção do comprador');
    const r = json(texto);
    return { pede_outro: !!r.pede_outro, busca: String(r.busca || '').trim().slice(0, 80), o_que: String(r.o_que || '').slice(0, 120) };
}
async function responderPergunta(pergunta, p, extras = {}) {
    const dados = { titulo: p.titulo, preco: p.preco, estoque: p.estoque, condicao: p.condicao, tipo_de_venda: p.tipo_de_venda, mesmo_produto_em_outro_tipo: p.mesmo_produto_em_outro_tipo,
        frete_gratis: p.frete_gratis, enviado_pelo_full: p.full, garantia: p.garantia, atributos: p.atributos, variacoes: p.variacoes, descricao: p.descricao, respostas_anteriores_do_vendedor: p.anteriores };
    const cat = extras.catalogo;
    const blocoCat = !cat ? '\n\nOUTROS ANUNCIOS NOSSOS: (catalogo nao pesquisado)'
        : `\n\nO COMPRADOR PEDE: ${cat.o_que || '-'} | BUSCA FEITA NO NOSSO CATALOGO: "${cat.busca}"\nOUTROS ANUNCIOS NOSSOS ENCONTRADOS: ${cat.itens.length ? JSON.stringify(cat.itens) : 'NENHUM (nao vendemos isso)'}`;
    const blocoEstilo = (extras.estilo || []).length ? `\n\nRESPOSTAS REVISADAS PELA EQUIPE (siga este tom, curto e direto):\n${extras.estilo.map(e => `P: ${e.p}\nR: ${e.r}`).join('\n')}` : '';
    const blocoAprendidas = (extras.aprendidas || []).length
        ? `\n\nCOMO A EQUIPE JA RESPONDEU PERGUNTAS PARECIDAS NO MERCADO LIVRE (respostas reais; aprenda o que se responde, o tom e o tamanho. Sao de OUTROS anuncios: nunca copie medida, ano, compatibilidade ou fato deles — os fatos vem SO dos DADOS DO ANUNCIO acima):\n${extras.aprendidas.map((e, i) => `${i + 1}) [${e.produto}] P: ${e.pergunta}\n   R: ${e.resposta}`).join('\n')}` : '';
    const { texto, modelo } = await gerar(SISTEMA, `DADOS DO ANUNCIO:
${JSON.stringify(dados)}${blocoCat}${blocoEstilo}${blocoAprendidas}

PERGUNTA DO COMPRADOR: "${String(pergunta).slice(0, 1000)}"

Responda com este JSON exato:
{"resposta": "texto pronto para enviar", "confianca": "alta|media|baixa", "precisa_humano": true|false, "motivo": "1 linha: por que tem ou nao tem certeza", "base": "de onde veio a informacao (titulo, descricao, atributo...)", "trecho": "COPIE EXATAMENTE, letra por letra, o trecho dos DADOS DO ANUNCIO que comprova a resposta (vazio se a resposta vem do catalogo ou se nao ha trecho)"}`, 1200, 'Perguntas: resposta do robô');
    const r = json(texto);
    return { resposta: String(r.resposta || '').trim(), confianca: ['alta', 'media', 'baixa'].includes(r.confianca) ? r.confianca : 'baixa',
        precisa_humano: r.precisa_humano !== false, motivo: r.motivo || '', base: r.base || '', trecho: String(r.trecho || '').trim(), modelo };
}

// ---- guardas do envio automatico (as mesmas do Harvey) ------------------------------------------------------
const NEGATIVA = /(n[ãa]o\s+(temos|tem|consta|serve|[ée]\s+compat|possu|acompanha|vem|trabalhamos|vendemos|encontr|dispon)|infelizmente|indispon[ií]vel|sem\s+estoque|esgotad)/i;
const CONTATO = /(\b\d{2}\s?9?\d{4}[-\s]?\d{4}\b)|(@[a-z0-9-]+\.)|(https?:\/\/)|(www\.)|(whats\s?app|zap\b|instagram|telefone|e-?mail)/i;
function podeEnviarSozinho(a) {
    const t = String(a.resposta || '').trim();
    if (a.confianca !== 'alta' || a.precisa_humano) return { ok: false, motivo: a.motivo || 'o robô não tem certeza' };
    if (a.confirmado_no_anuncio === false) return { ok: false, motivo: 'não está explícito no anúncio: o trecho citado pelo robô não foi encontrado' };
    if (t.length < 5 || t.length > 2000) return { ok: false, motivo: 'tamanho da resposta fora do permitido' };
    const semNossos = (a.links_nossos || []).reduce((s, l) => s.split(l).join(''), t);
    if (CONTATO.test(semNossos)) return { ok: false, motivo: 'a resposta cita contato ou link de fora, que o ML proíbe' };
    if (semNossos !== t) return { ok: false, motivo: 'indica outro anúncio nosso (com link): confira se é o certo antes de enviar' };
    if (NEGATIVA.test(t)) return { ok: false, motivo: 'resposta negativa (não temos, sem estoque, não serve): confira antes de enviar' };
    return { ok: true };
}

function estiloRevisado(max = 6) {
    return Object.values(lerJson(ARQ, {})).filter(r => r.status === 'enviada' && !r.automatica && r.resposta_enviada)
        .sort((a, b) => String(b.enviada_em).localeCompare(String(a.enviada_em))).slice(0, max)
        .map(r => ({ p: String(r.texto).slice(0, 200), r: String(r.resposta_enviada).slice(0, 300) }));
}

async function analisar(reg) {
    const p = await produto(reg.item_id);
    let cat = null;
    try {
        const e = await entenderPergunta(reg.texto, p.titulo);
        if (e.pede_outro && e.busca) cat = { ...e, itens: await catalogo(e.busca, reg.item_id) };
    } catch (e) { if (/cota|Chave do Gemini|Gemini indispon/i.test(e.message)) throw e; }
    let aprendidas = [];
    try { aprendidas = exemplos(reg.texto, p.titulo, reg.item_id); } catch {}
    const a = await responderPergunta(reg.texto, p, { catalogo: cat, estilo: estiloRevisado(), aprendidas });
    a.exemplos_usados = aprendidas.length;
    // a resposta tem de estar EXPLICITA no anuncio: o trecho citado pelo robo precisa existir de verdade
    const norm = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
    const fonte = norm([p.titulo, p.descricao, ...(p.atributos || []), ...(p.variacoes || []), p.garantia, p.tipo_de_venda, ...(p.anteriores || []).map(x => x.r)].join(' \n '));
    const trecho = norm(a.trecho);
    const usouCatalogo = !!(cat && (cat.itens.length || /n[aã]o temos/i.test(a.resposta)));
    a.confirmado_no_anuncio = usouCatalogo || (trecho.length >= 4 && fonte.includes(trecho));
    const links = [...(cat ? cat.itens.map(i => i.link) : []), ...(p.mesmo_produto_em_outro_tipo ? [p.mesmo_produto_em_outro_tipo.link] : [])];
    return { ...a, produto_titulo: p.titulo, produto_link: p.link, produto_foto: p.thumbnail, tipo_de_venda: p.tipo_de_venda, estoque: p.estoque, catalogo: cat, links_nossos: links };
}

// le o arquivo NA HORA, muda so a pergunta indicada e grava (o que a pessoa fez na tela enquanto o robo pensava nao se perde)
function mudar(id, fn) { const db = lerJson(ARQ, {}); const r = fn(id == null ? null : db[id], db); gravarJson(ARQ, db); return r; }
const aindaAnalisando = (id) => (lerJson(ARQ, {})[id] || {}).status === 'analisando';

async function enviarResposta(id, texto) {
    const q = await get(`${ML}/questions/${id}`, { api_version: 4 });
    if (q.status !== 'UNANSWERED') return { ok: false, ja_respondida: true, erro: `A pergunta já está ${q.status === 'ANSWERED' ? 'respondida' : q.status} no ML.` };
    const { headers } = await auth();
    await axios.post(`${ML}/answers`, { question_id: Number(id), text: String(texto).trim() }, { headers: { ...headers, 'Content-Type': 'application/json' }, timeout: 30000 });
    return { ok: true };
}

async function verificar({ origem = 'agendador' } = {}) {
    if (estado.rodando) return { ok: false, erro: 'já está verificando' };
    estado.rodando = true;
    let novas = 0, enviadas = 0, revisar = 0;
    try {
        const abertas = (await get(`${ML}/my/received_questions/search`, { api_version: 4, status: 'UNANSWERED', limit: 50, sort_fields: 'date_created', sort_types: 'ASC' })).questions || [];
        const ids = new Set(abertas.map(q => String(q.id)));
        mudar(null, (_, db) => {
            // estava aberta aqui e saiu da lista: foi respondida por fora (site, celular, Harvey)
            for (const r of Object.values(db)) if (['revisar', 'analisando'].includes(r.status) && !ids.has(r.id)) r.status = 'respondida_fora';
            for (const q of abertas) { const id = String(q.id); if (db[id]) continue; db[id] = { id, item_id: q.item_id, texto: q.text || '', criado: q.date_created, status: 'analisando' }; novas++; }
        });
        for (const q of abertas) {
            const id = String(q.id);
            const r0 = lerJson(ARQ, {})[id];
            // analise que falhou antes (cota, sem internet): tenta de novo nesta rodada
            if (r0 && r0.status === 'revisar' && !r0.ia && r0.falhou_em) mudar(id, (cur) => { if (cur && cur.status === 'revisar' && !cur.ia) cur.status = 'analisando'; });
            const r = lerJson(ARQ, {})[id];
            if (!r || r.status !== 'analisando') continue;
            let ia;
            try { ia = await analisar(r); }
            catch (e) {
                mudar(id, (cur) => { if (cur && cur.status === 'analisando') { cur.status = 'revisar'; cur.motivo = `o robô não conseguiu analisar (${e.message}); tento de novo em 2 min`; cur.falhou_em = new Date().toISOString(); } });
                revisar++;
                if (e.codigo === 'cota' || /Chave do Gemini/.test(e.message)) break;   // sem IA agora: nao gasta chamada nas outras
                continue;
            }
            const analise = { ia, analisado_em: new Date().toISOString() };
            const ok = podeEnviarSozinho(ia);
            if (!aindaAnalisando(id)) continue;   // a pessoa tratou na tela enquanto o robo pensava: a acao dela vale
            if (automatico() && ok.ok) {
                const env = await enviarResposta(id, ia.resposta).catch(e => ({ ok: false, erro: e.message }));
                mudar(id, (cur) => {
                    if (!cur) return;
                    Object.assign(cur, analise);
                    if (env.ok) { Object.assign(cur, { status: 'enviada', resposta_enviada: ia.resposta, enviada_em: new Date().toISOString(), automatica: true }); enviadas++; }
                    else if (cur.status === 'analisando') { cur.status = env.ja_respondida ? 'respondida_fora' : 'revisar'; cur.motivo = env.erro; }
                });
                if (env.ok) registrar({ evento: 'enviada_robo', id, pergunta: r.texto, resposta: ia.resposta });
            } else {
                const motivo = automatico() ? ok.motivo : (ok.ok ? 'pronta: o robô tem certeza (modo automático desligado)' : ok.motivo);
                mudar(id, (cur) => { if (cur && cur.status === 'analisando') Object.assign(cur, analise, { status: 'revisar', motivo, pronta: ok.ok }); });
                revisar++;
            }
        }
        estado.erro = null;
    } catch (e) {
        estado.erro = String(e.response?.data?.message || e.message || e).slice(0, 200);
    } finally {
        estado.rodando = false; estado.verificado_em = new Date().toISOString();
    }
    if (enviadas) notificar(enviadas === 1 ? 'O robô respondeu 1 pergunta' : `O robô respondeu ${enviadas} perguntas`, 'Respondidas com os dados do anúncio.', '/perguntas');
    if (novas) notificar(novas === 1 ? 'Pergunta nova no Mercado Livre' : `${novas} perguntas novas no Mercado Livre`, 'O robô preparou a resposta: confira na aba Perguntas.', '/perguntas');
    return { ok: !estado.erro, origem, novas, enviadas, revisar, erro: estado.erro };
}

async function responder(id, texto) {
    const r = lerJson(ARQ, {})[id];
    if (!r) throw new Error('Pergunta não encontrada.');
    const t = String(texto || '').trim();
    if (t.length < 2) throw new Error('Resposta vazia.');
    if (t.length > 2000) throw new Error('A resposta passa de 2000 caracteres.');
    const env = await enviarResposta(id, t);
    if (!env.ok) { if (env.ja_respondida) mudar(id, (cur) => { if (cur) cur.status = 'respondida_fora'; }); throw new Error(env.erro); }
    registrar({ evento: 'enviada_revisada', id, pergunta: r.texto, resposta: t, sugerida: r.ia?.resposta || '' });
    return mudar(id, (cur) => { if (cur) Object.assign(cur, { status: 'enviada', resposta_enviada: t, enviada_em: new Date().toISOString(), automatica: false }); return cur; });
}
async function gerarDeNovo(id) {
    const r = lerJson(ARQ, {})[id];
    if (!r) throw new Error('Pergunta não encontrada.');
    const cache = lerJson(ITENS, {}); delete cache[r.item_id]; gravarJson(ITENS, cache);   // rele o anuncio
    const ia = await analisar(r);
    const ok = podeEnviarSozinho(ia);
    return mudar(id, (cur) => { if (cur) Object.assign(cur, { ia, analisado_em: new Date().toISOString(), motivo: ok.ok ? 'pronta: o robô tem certeza' : ok.motivo, pronta: ok.ok, falhou_em: undefined }); return cur; });
}
function ignorar(id) { mudar(id, (cur) => { if (cur) cur.status = 'ignorada'; }); return { ok: true }; }

function listar() {
    const L = Object.values(lerJson(ARQ, {})).sort((a, b) => String(b.criado).localeCompare(String(a.criado)));
    const ap = lerJson(APRENDE, { em: null, itens: [] });
    return { automatico: automatico(), estado, aprendizado: { atualizado_em: ap.em, total: ap.itens.length },
        abertas: L.filter(r => ['revisar', 'analisando'].includes(r.status)),
        respondidas: L.filter(r => r.status === 'enviada').slice(0, 40), outras: L.filter(r => ['respondida_fora', 'ignorada'].includes(r.status)).slice(0, 20) };
}
function resumo() { const L = Object.values(lerJson(ARQ, {})); return { abertas: L.filter(r => ['revisar', 'analisando'].includes(r.status)).length, verificado_em: estado.verificado_em, erro: estado.erro }; }

function iniciarAgendador() {
    pararAgendador();
    timerPrimeira = setTimeout(() => { sincronizarAprendizado().catch(() => {}); setTimeout(() => verificar({ origem: 'abertura' }).catch(() => {}), 20 * 1000); }, 30 * 1000);
    timer = setInterval(() => verificar().catch(() => {}), INTERVALO_MS);
}
function pararAgendador() { if (timer) clearInterval(timer); if (timerPrimeira) clearTimeout(timerPrimeira); timer = timerPrimeira = null; }

module.exports = { verificar, responder, gerarDeNovo, ignorar, listar, resumo, setAutomatico, automatico, analisar, podeEnviarSozinho, sincronizarAprendizado, iniciarAgendador, pararAgendador, estado };
