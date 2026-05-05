const mongoose = require('mongoose');
require('dotenv').config();

const uri = process.env.MONGODB_URI;

mongoose.connect(uri)
  .then(() => console.log('✅ Conectado ao MongoDB Atlas'))
  .catch(err => console.error('❌ Erro ao conectar ao MongoDB:', err));

// Schemas
const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true }
});

const transactionSchema = new mongoose.Schema({
  id: { type: String, default: () => Date.now().toString() },
  date: { type: Date, default: Date.now },
  name: String,
  investimento: Number,
  fichasFinais: Number,
  valorFicha: Number,
  retorno: Number,
  saldo: Number,
  status: { type: String, enum: ['Ativa', 'Finalizada', 'Arquivada'] }
});

const User = mongoose.model('User', userSchema);
const Transaction = mongoose.model('Transaction', transactionSchema);

// --- AUTHENTICATION ---
async function registerUser(username, password) {
  try {
    const exists = await User.findOne({ username: new RegExp(`^${username}$`, 'i') });
    if (exists) return { success: false, message: 'Usuário já existe' };
    
    const newUser = new User({ username, password });
    await newUser.save();
    return { success: true };
  } catch (error) {
    return { success: false, message: 'Erro ao registrar usuário' };
  }
}

async function authenticateUser(username, password) {
  try {
    const user = await User.findOne({ username: new RegExp(`^${username}$`, 'i'), password });
    return user ? { success: true, username: user.username } : { success: false, message: 'Senha ou Usuário incorretos' };
  } catch (error) {
    return { success: false, message: 'Erro na autenticação' };
  }
}

// --- TRANSACTIONS ---
async function addTransaction(tx) {
  try {
    const newTx = new Transaction(tx);
    await newTx.save();
  } catch (error) {
    console.error('Erro ao adicionar transação:', error);
  }
}

async function endSession() {
  try {
    await Transaction.updateMany({ status: 'Ativa' }, { status: 'Finalizada' });
  } catch (error) {
    console.error('Erro ao encerrar sessão:', error);
  }
}

async function resetSeason() {
  try {
    await Transaction.updateMany({ status: { $in: ['Ativa', 'Finalizada'] } }, { status: 'Arquivada' });
  } catch (error) {
    console.error('Erro ao arquivar temporada:', error);
  }
}

async function resetDatabase() {
  try {
    await Transaction.deleteMany({});
  } catch (error) {
    console.error('Erro ao resetar banco:', error);
  }
}

async function getLeaderboard(activePlayers = []) {
  try {
    const transactions = await Transaction.find({ status: { $ne: 'Arquivada' } });
    const data = [...transactions];

    // Injetar jogadores ativos da memória do servidor
    activePlayers.forEach(p => {
      let invest = parseFloat(p.totalInvestido) || 0;
      let fichas = parseInt(p.chips) || 0;
      if (invest > 0 || fichas > 0) {
        let retorno = fichas * 0.10;
        let saldo = retorno - invest;
        data.push({
          name: p.name,
          investimento: invest,
          fichasFinais: fichas,
          valorFicha: 0.10,
          retorno: retorno,
          saldo: saldo,
          status: 'Ativa',
          date: new Date()
        });
      }
    });

    let statsSessao = {};
    let statsGlobal = {};
    let poteSessao = 0;
    let lancamentosAtivos = [];

    for (let i = 0; i < data.length; i++) {
      let t = data[i];
      let nome = t.name;
      let invest = parseFloat(t.investimento) || 0;
      let saldo = parseFloat(t.saldo) || 0;
      let status = t.status;

      if (!statsGlobal[nome]) {
        statsGlobal[nome] = { saldo: 0, invest: 0, historico: [], vitorias: 0, sessoes: 0, maxWin: 0, maxLose: 0 };
      }
      statsGlobal[nome].saldo += saldo;
      statsGlobal[nome].invest += invest;
      statsGlobal[nome].historico.push(saldo);
      statsGlobal[nome].sessoes++;
      if (saldo > 0) statsGlobal[nome].vitorias++;
      if (saldo > statsGlobal[nome].maxWin) statsGlobal[nome].maxWin = saldo;
      if (saldo < statsGlobal[nome].maxLose) statsGlobal[nome].maxLose = saldo;

      if (status === "Ativa") {
        if (!statsSessao[nome]) statsSessao[nome] = { saldo: 0, invest: 0 };
        statsSessao[nome].saldo += saldo;
        statsSessao[nome].invest += invest;
        poteSessao += invest;

        let horaFormatada = new Date(t.date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        lancamentosAtivos.push({ hora: horaFormatada, nome: nome, invest: invest, saldo: saldo });
      }
    }

    let arrSessao = Object.keys(statsSessao).map(n => ({ nome: n, saldo: statsSessao[n].saldo, invest: statsSessao[n].invest, badges: [] }));
    let arrGlobal = Object.keys(statsGlobal).map(n => ({
      nome: n, saldo: statsGlobal[n].saldo, invest: statsGlobal[n].invest, badges: [],
      historico: statsGlobal[n].historico.slice(-10), sessoes: statsGlobal[n].sessoes,
      vitorias: statsGlobal[n].vitorias, maxWin: statsGlobal[n].maxWin, maxLose: statsGlobal[n].maxLose
    }));

    // Lógica de Badges (mesma anterior)
    if (arrSessao.length > 0) {
      let maxLucroSessao = Math.max(...arrSessao.map(p => p.saldo));
      let minLucroSessao = Math.min(...arrSessao.map(p => p.saldo));
      let maxInvestSessao = Math.max(...arrSessao.map(p => p.invest));
      arrSessao.forEach(p => {
        if (p.saldo === maxLucroSessao && p.saldo > 0) p.badges.push('🏆');
        if (p.saldo === minLucroSessao && p.saldo < 0) p.badges.push('🐟');
        if (p.invest === maxInvestSessao && p.invest > 1.00) p.badges.push('🏦');
        if (p.saldo === 0) p.badges.push('⚖️');
        if (p.invest <= 1.00 && p.saldo > 0) p.badges.push('🔒');
        if (p.invest > 0 && (p.saldo + p.invest) / p.invest >= 3) p.badges.push('🚀');
      });
    }

    if (arrGlobal.length > 0) {
      let maxLucroGlobal = Math.max(...arrGlobal.map(p => p.saldo));
      let minLucroGlobal = Math.min(...arrGlobal.map(p => p.saldo));
      arrGlobal.forEach(p => {
        if (p.saldo === maxLucroGlobal && p.saldo > 0) p.badges.push('🦈');
        if (p.saldo === minLucroGlobal && p.saldo < 0) p.badges.push('💸');
      });
    }

    arrSessao.sort((a, b) => b.saldo - a.saldo);
    arrGlobal.sort((a, b) => b.saldo - a.saldo);
    lancamentosAtivos = lancamentosAtivos.reverse();

    return {
      session: { winners: arrSessao.filter(p => p.saldo > 0), losers: arrSessao.filter(p => p.saldo <= 0) },
      global: arrGlobal,
      poteTotal: poteSessao,
      lancamentos: lancamentosAtivos
    };
  } catch (error) {
    console.error('Erro ao buscar leaderboard:', error);
    return { session: { winners: [], losers: [] }, global: [], poteTotal: 0, lancamentos: [] };
  }
}

module.exports = {
  registerUser,
  authenticateUser,
  addTransaction,
  endSession,
  resetSeason,
  resetDatabase,
  getLeaderboard
};
