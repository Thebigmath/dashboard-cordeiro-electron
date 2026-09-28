// Ranking ML na Cordeiro: SO LEITURA.
//
// A coleta e feita uma vez por dia pelo app da Flavia Stock, que pesquisa os
// termos das duas contas na mesma rodada e grava um JSON por conta em
// .dotnet\MLScraper\saidas (ranking_issacar_cordeiro.json e lido por lib/seven.js).
// Aqui so mostramos o andamento e o historico dessa coleta, lidos do storage do
// app da Flavia. Assim o Chrome do Issacar faz uma rodada por dia, nao duas.
const fs = require('fs');
const path = require('path');

const STORAGE = process.env.STORAGE_PATH || path.join(__dirname, '../storage');

function lerJson(arquivo, padrao) {
    try { return JSON.parse(fs.readFileSync(arquivo, 'utf8')); } catch { return padrao; }
}

function storageColetor() {
    const c = lerJson(path.join(STORAGE, 'config.json'), {});
    return c.ranking_ml_storage_coletor || path.join(process.env.APPDATA || '', 'dashboard-ml', 'storage');
}

function vivo(pid) {
    if (!pid) return false;
    try { process.kill(pid, 0); return true; } catch { return false; }
}

function historico(n = 20) {
    try {
        return fs.readFileSync(path.join(storageColetor(), 'ranking_ml_historico.jsonl'), 'utf8').trim().split(/\r?\n/).filter(Boolean)
            .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse().slice(0, n);
    } catch { return []; }
}

function estado() {
    const e = lerJson(path.join(storageColetor(), 'ranking_ml_estado.json'), {});
    const rodando = vivo(e.pid);
    let progresso = null;
    try {
        const txt = fs.readFileSync(path.join(storageColetor(), 'ranking_ml.log'), 'utf8');
        const total = (txt.match(/^\[\d+\/(\d+)\]/m) || [])[1];
        if (total) progresso = { feitos: (txt.match(/^\[\d+\/\d+\]/gm) || []).length, total: Number(total) };
    } catch {}
    return {
        rodando, iniciado_em: e.iniciado_em || null, origem: e.origem || null, abas: 3, progresso,
        resumo: rodando ? '' : 'Coleta feita pelo app da Flavia Stock.', ultima: historico(1)[0] || null,
        coletor: false, aviso: 'A coleta do Ranking ML é feita pelo app da Flavia Stock, todo dia a partir das 7h, para as duas contas.',
    };
}

function iniciar() {
    return { ok: false, erro: 'A coleta do Ranking ML é feita pelo app da Flavia Stock (todo dia a partir das 7h, para as duas contas). Abra o app da Flavia para coletar agora.' };
}

function iniciarAgendador() {}
function pararAgendador() {}

module.exports = { estado, iniciar, iniciarAgendador, pararAgendador, historico };
