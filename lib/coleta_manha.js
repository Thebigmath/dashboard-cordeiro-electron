// Coleta da manha automatica (02/11/2026, Proposta A da Analise com IA). A rodada diaria do motor de preco so roda depois
// da coleta do dia (adhealth_abertura.json com a data de hoje), e essa coleta so acontecia quando alguem abria o AD HEALTH:
// no app real o motor ficou parado de 28/10 a 02/11. Agora o proprio app faz a mesma coleta da 1a abertura, a partir das 7h
// (horario de Brasilia), com o app aberto, mesmo sem abrir a tela:
//   POST /api/atualizar (estoque e vendas) -> POST /api/seven/recarregar (pedidos de ontem) -> marca o dia (abertura/feito)
// Chama as MESMAS rotas da tela (nada duplicado). Depois disso a rodada do motor (a cada 15 min) roda sozinha.
// Nao comeca se a coleta ja estiver rodando (tela aberta ou monitor de frete); no maximo 3 tentativas por dia.
const fs = require('fs');
const path = require('path');

const STORAGE = () => process.env.STORAGE_PATH || path.join(__dirname, '../storage');
const ARQ_DIA = () => path.join(STORAGE(), 'adhealth_abertura.json');
const ARQ_EST = () => path.join(STORAGE(), 'coleta_manha.json');
const HORA_INICIO = 7, MAX_TENTATIVAS = 3;
const lerJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const agoraBR = () => new Date(Date.now() - 3 * 3600 * 1000);
const hojeBR = () => agoraBR().toISOString().slice(0, 10);

const estado = { rodando: false, fase: '', iniciado_em: null };
let porta = null, timer = null;

async function coletar(origem = 'agendador') {
    if (estado.rodando) return { ok: false, motivo: 'já está coletando' };
    if (require('./frete').estado.motorOcupado) return { ok: false, motivo: 'a coleta já está rodando (tela aberta)' };
    const base = `http://127.0.0.1:${porta}/api`;
    const reg = lerJson(ARQ_EST(), {}), hoje = hojeBR();
    const tent = reg.dia === hoje ? (reg.tentativas || 0) + 1 : 1;
    Object.assign(estado, { rodando: true, fase: 'estoque e vendas', iniciado_em: new Date().toISOString() });
    let erro = null;
    try {
        const r = await fetch(`${base}/atualizar`, { method: 'POST', signal: AbortSignal.timeout(30 * 60 * 1000) });
        if (!r.ok) throw new Error(`a coleta respondeu ${r.status}`);
        const txt = await r.text();   // a rota manda o andamento em texto; erro vem numa linha "ERRO: ..."
        const linhaErro = txt.split('\n').find(l => l.startsWith('ERRO:'));
        if (linhaErro) throw new Error(linhaErro.slice(5).trim());
        estado.fase = 'pedidos de ontem';
        const r2 = await fetch(`${base}/seven/recarregar`, { method: 'POST', signal: AbortSignal.timeout(10 * 60 * 1000) });
        if (!r2.ok) throw new Error(`pedidos de ontem: ${r2.status}`);
        await fetch(`${base}/seven/abertura/feito`, { method: 'POST' });
    } catch (e) { erro = String(e.message || e); }
    finally { Object.assign(estado, { rodando: false, fase: '' }); }
    const novo = { dia: hoje, tentativas: tent, ultima: { quando: new Date().toISOString(), origem, ok: !erro, erro } };
    try { fs.mkdirSync(STORAGE(), { recursive: true }); fs.writeFileSync(ARQ_EST(), JSON.stringify(novo, null, 2)); } catch {}
    if (!erro) { try { require('./motor_preco').rodadaDiaria().catch(() => {}); } catch {} }   // nao espera os 15 min do motor
    return { ok: !erro, erro };
}

function precisa() {
    const hoje = hojeBR();
    if (lerJson(ARQ_DIA(), {}).dia === hoje) return false;                 // ja coletou hoje (aqui ou pela tela)
    if (agoraBR().getUTCHours() < HORA_INICIO) return false;
    const reg = lerJson(ARQ_EST(), {});
    return !(reg.dia === hoje && (reg.tentativas || 0) >= MAX_TENTATIVAS);
}
function tick() { if (porta && !estado.rodando && precisa()) coletar('agendador').catch(() => {}); }
function iniciarAgendador(p) { porta = p; pararAgendador(); timer = setInterval(tick, 15 * 60 * 1000); setTimeout(tick, 2 * 60 * 1000); }
function pararAgendador() { if (timer) clearInterval(timer); timer = null; }
const situacao = () => ({ ...estado, ...lerJson(ARQ_EST(), {}) });

module.exports = { iniciarAgendador, pararAgendador, coletar, estado, situacao };
