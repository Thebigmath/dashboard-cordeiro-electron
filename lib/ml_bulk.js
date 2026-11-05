// 05/11/2026: o Mercado Livre esta desligando o multiget GET /items?ids= (prazo de migracao: 25/10/2026). Em alguns momentos ele
// ja responde 403 "ResourceDeprecated - client no longer allowed to consume this resource" (o erro que aparecia na aba Anuncios).
// A rota nova e GET /items/bulk?ids=, com os campos de attributes prefixados com "body." e a resposta [{ id, status_code, body }].
// Este modulo troca TODAS as chamadas do app de uma vez (interceptor do axios), e devolve a resposta no formato antigo
// [{ code, body }], para nenhuma tela ou motor precisar mudar. So mexe em GET https://api.mercadolibre.com/items com ids.
const axios = require('axios');

const MULTIGET = /^https:\/\/api\.mercadolibre\.com\/items\/?(\?|$)/;

function paraBulk(config) {
    if (String(config.method || 'get').toLowerCase() !== 'get' || !MULTIGET.test(config.url || '')) return config;
    const u = new URL(config.url);
    const params = { ...Object.fromEntries(u.searchParams), ...(config.params || {}) };
    if (!params.ids) return config;
    if (params.attributes) {
        const campos = String(params.attributes).split(',').map(s => s.trim()).filter(Boolean).map(s => s.startsWith('body.') ? s : 'body.' + s);
        if (!campos.includes('body.id')) campos.unshift('body.id');
        params.attributes = campos.join(',');
    }
    return { ...config, url: 'https://api.mercadolibre.com/items/bulk', params, _mlBulk: true };
}

function respostaAntiga(res) {
    if (!res.config || !res.config._mlBulk || !Array.isArray(res.data)) return res;
    res.data = res.data.map(x => {
        const body = x && x.body !== undefined ? x.body : null;
        const code = x && (x.status_code ?? x.code) != null ? (x.status_code ?? x.code) : (body && body.id ? 200 : 404);
        return { code, body };
    });
    return res;
}

if (!axios.__mlBulk) {
    axios.__mlBulk = true;
    axios.interceptors.request.use(paraBulk);
    axios.interceptors.response.use(respostaAntiga);
}

module.exports = { paraBulk, respostaAntiga };
