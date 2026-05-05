const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { createDeck, shuffle } = require('./deck');
const Hand = require('pokersolver').Hand;
const db = require('./database');
require('dotenv').config();

const path = require('path');
const app = express();
app.use(cors());

// Rota básica para checagem do Render
app.get('/', (req, res) => {
  res.send('Poker Backend Online!');
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", // Em produção, liberamos para o domínio do site
    methods: ["GET", "POST"]
  }
});

let gameState = {
  pot: 0,
  currentBet: 0,
  currentTurnIndex: -1,
  dealerIndex: 0, // Índice do Dealer
  sbValue: 5,     // Valor do Small Blind
  bbValue: 10,    // Valor do Big Blind
  phase: 'waiting', // waiting, preflop, flop, turn, river
  communityCards: [],
  deck: [],
  players: [],
  winnerInfo: null,
  turnEndTime: null, // Timer do turno
  logs: [] // Histórico de auditoria da sessão
};

let turnTimer = null;
const TURN_TIME_MS = 20000;

function formatCard(c) {
  if (c.hidden) return '';
  let val = c.value;
  if (val === '10') val = 'T';
  let suit = c.suit[0]; // pega 'h', 'd', 'c', 's'
  return val + suit;
}

io.on('connection', (socket) => {
  console.log(`[+] Novo jogador conectado: ${socket.id}`);

  const broadcastChat = (msg) => {
    io.emit('receive_chat', { id: Date.now() + Math.random(), name: 'Sistema', text: msg, time: new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) });
  };

  // Função para enviar o estado para um socket específico
  const sendIndividualState = (s) => {
    let customState = JSON.parse(JSON.stringify(gameState));
    customState.players.forEach(p => {
      if (p.id !== s.id && p.cards && !gameState.winnerInfo) {
        p.cards = p.cards.map(() => ({ hidden: true }));
      }
    });
    customState.deck = [];
    s.emit('game_state_update', customState);
  };

  // Função para enviar o estado para todos, escondendo cartas dos inimigos
  const broadcastState = () => {
    io.sockets.sockets.forEach((s) => {
      sendIndividualState(s);
    });
  };

  // Autenticação
  socket.on('register', async (data, callback) => {
    console.log(`[AUTH] Tentativa de registro: ${data.username}`);
    const res = await db.registerUser(data.username, data.password);
    console.log(`[AUTH] Resultado registro: ${res.success}`);
    if (callback) callback(res);
  });

  socket.on('login', async (data, callback) => {
    console.log(`[AUTH] Tentativa de login: ${data.username}`);
    const res = await db.authenticateUser(data.username, data.password);
    console.log(`[AUTH] Resultado login: ${res.success}`);
    if (res.success) {
      // Se tiver sucesso, já joga ele na mesa
      joinTableInternal(socket.id, res.username);
      // Envia o estado inicial de forma segura para o jogador que acabou de logar
      sendIndividualState(socket);
    }
    if (callback) callback(res);
  });

  // Função interna para colocar na mesa após login
  const joinTableInternal = (sockId, playerName) => {
    // Evitar duplicação
    if (gameState.players.find(p => p.id === sockId)) return;

    const newPlayer = {
      id: sockId,
      name: playerName,
      chips: 0,
      totalInvestido: 0,
      cards: [],
      status: 'waiting', 
      currentBet: 0,
      acted: false
    };
    gameState.players.push(newPlayer);
    broadcastState();
  };

  socket.on('disconnect', () => {
    console.log(`[-] Jogador desconectado: ${socket.id}`);
    gameState.players = gameState.players.filter(p => p.id !== socket.id);
    broadcastState();
  });

  // Evento para distribuir as cartas (iniciar rodada)
  socket.on('start_game', () => {
    let activeList = gameState.players.filter(p => p.chips > 0);
    if (activeList.length < 2) {
      broadcastChat("Erro: Pelo menos 2 jogadores com fichas são necessários.");
      return;
    }

    let newDeck = shuffle(createDeck());
    gameState.pot = 0;
    gameState.currentBet = gameState.bbValue;
    gameState.winnerInfo = null;
    gameState.phase = 'preflop';
    gameState.communityCards = [];
    gameState.deck = newDeck;
    
    // Avançar o Dealer
    gameState.dealerIndex = (gameState.dealerIndex + 1) % gameState.players.length;
    while (gameState.players[gameState.dealerIndex].chips <= 0) {
      gameState.dealerIndex = (gameState.dealerIndex + 1) % gameState.players.length;
    }

    // Identificar SB e BB (próximos jogadores ativos após o dealer)
    let sbIdx = (gameState.dealerIndex + 1) % gameState.players.length;
    while (gameState.players[sbIdx].chips <= 0) sbIdx = (sbIdx + 1) % gameState.players.length;
    
    let bbIdx = (sbIdx + 1) % gameState.players.length;
    while (gameState.players[bbIdx].chips <= 0) bbIdx = (bbIdx + 1) % gameState.players.length;

    // Resetar status dos jogadores e distribuir 2 cartas
    gameState.players.forEach((p, idx) => {
      if (p.chips > 0) {
        p.status = 'active';
        p.currentBet = 0;
        p.acted = false;
        p.cards = [newDeck.pop(), newDeck.pop()];

        // Cobrar Blinds
        if (idx === sbIdx) {
          const amount = Math.min(p.chips, gameState.sbValue);
          p.chips -= amount;
          p.currentBet = amount;
          gameState.pot += amount;
          broadcastChat(`${p.name} postou Small Blind ($${amount})`);
        } else if (idx === bbIdx) {
          const amount = Math.min(p.chips, gameState.bbValue);
          p.chips -= amount;
          p.currentBet = amount;
          gameState.pot += amount;
          broadcastChat(`${p.name} postou Big Blind ($${amount})`);
        }
      } else {
        p.status = 'waiting';
        p.cards = [];
      }
    });
    
    // O turno começa no jogador APÓS o Big Blind
    let firstTurn = (bbIdx + 1) % gameState.players.length;
    while (gameState.players[firstTurn].status !== 'active') {
      firstTurn = (firstTurn + 1) % gameState.players.length;
    }
    gameState.currentTurnIndex = firstTurn;

    broadcastChat(`Nova rodada iniciada! Dealer: ${gameState.players[gameState.dealerIndex].name}`);
    startTurnTimer();
    broadcastState();
  });

  // Função auxiliar para avançar de fase
  const advancePhase = () => {
    if (gameState.phase === 'preflop') {
      gameState.communityCards.push(gameState.deck.pop(), gameState.deck.pop(), gameState.deck.pop());
      gameState.phase = 'flop';
    } else if (gameState.phase === 'flop') {
      gameState.communityCards.push(gameState.deck.pop());
      gameState.phase = 'turn';
    } else if (gameState.phase === 'turn') {
      gameState.communityCards.push(gameState.deck.pop());
      gameState.phase = 'river';
    }
    // Reseta as apostas do turno
    gameState.currentBet = 0;
    gameState.players.forEach(p => {
      p.currentBet = 0;
      p.acted = false;
    });
    // Voltar o turno para o primeiro jogador ativo
    let firstActive = gameState.players.findIndex(p => p.status === 'active');
    gameState.currentTurnIndex = firstActive !== -1 ? firstActive : 0;
  };

  // Evento para virar as próximas cartas da mesa manualmente (fallback)
  socket.on('next_phase', () => {
    advancePhase();
    broadcastState();
  });

  // Timer Control
  const stopTurnTimer = () => {
    clearTimeout(turnTimer);
    gameState.turnEndTime = null;
  };

  const startTurnTimer = () => {
    stopTurnTimer();
    if (gameState.currentTurnIndex === -1) return;
    
    gameState.turnEndTime = Date.now() + TURN_TIME_MS;
    turnTimer = setTimeout(() => {
      let currentPlayer = gameState.players[gameState.currentTurnIndex];
      if (currentPlayer && currentPlayer.status === 'active') {
        broadcastChat(`Tempo esgotado para ${currentPlayer.name}. (Auto-Fold)`);
        handlePlayerAction(currentPlayer.id, {action: 'fold'});
      }
    }, TURN_TIME_MS);
  };

  const handlePlayerAction = (socketId, data) => {
    const playerIndex = gameState.players.findIndex(p => p.id === socketId);
    if (playerIndex === -1 || playerIndex !== gameState.currentTurnIndex) return;

    const player = gameState.players[playerIndex];
    player.acted = true;
    let actionName = '';

    if (data.action === 'fold') {
      player.status = 'folded';
      actionName = 'deu Fold';
    } else if (data.action === 'call') {
      const callAmount = gameState.currentBet - player.currentBet;
      const actualCall = Math.min(player.chips, callAmount);
      
      player.chips -= actualCall;
      player.currentBet += actualCall;
      gameState.pot += actualCall;
      
      if (player.chips === 0 && callAmount > 0) {
        actionName = `deu ALL-IN ($${actualCall})`;
      } else {
        actionName = actualCall > 0 ? `pagou $${actualCall} (Call)` : 'deu Check';
      }
    } else if (data.action === 'raise') {
      const raiseAmount = data.amount || 50; 
      const callPart = gameState.currentBet - player.currentBet;
      const totalCost = callPart + raiseAmount;
      
      if (player.chips > 0) {
        const actualInvest = Math.min(player.chips, totalCost);
        player.chips -= actualInvest;
        player.currentBet += actualInvest;
        
        // Se ele não conseguiu cobrir o raise total, é um All-in mas não aumenta a aposta da mesa tanto assim
        if (actualInvest > callPart) {
          gameState.currentBet += (actualInvest - callPart);
        }
        
        gameState.pot += actualInvest;
        actionName = player.chips === 0 ? `deu ALL-IN de $${actualInvest}` : `Aumentou $${raiseAmount} (Raise)`;
        
        // Resetar 'acted' dos outros apenas se houve um aumento real na aposta da mesa
        if (actualInvest > callPart) {
          gameState.players.forEach(p => {
            if (p.id !== player.id && p.status === 'active') p.acted = false;
          });
        }
      }
    }

    broadcastChat(`${player.name} ${actionName}`);
    
    // Adicionar aos logs de auditoria
    gameState.logs.unshift({
      time: new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit', second: '2-digit'}),
      text: `${player.name}: ${actionName}`
    });
    if (gameState.logs.length > 50) gameState.logs.pop();

    let activePlayers = gameState.players.filter(p => p.status === 'active');
    
    // CORREÇÃO DO BUG DE FOLD: Se só sobrou 1 ativo, a rodada DEVE acabar por WO imediatamente.
    const roundOver = activePlayers.length === 1 || activePlayers.every(p => p.acted && p.currentBet === gameState.currentBet);

    if (roundOver) {
      stopTurnTimer();
      if (activePlayers.length === 1) {
        // Vitória por W.O.
        const winner = activePlayers[0];
        gameState.winnerInfo = {
          ids: [winner.id],
          names: [winner.name],
          description: "Venceu por W.O. (Todos desistiram)"
        };
        winner.chips += gameState.pot;
        gameState.pot = 0;
        gameState.currentTurnIndex = -1;
      } else if (gameState.phase !== 'river') {
        advancePhase();
        startTurnTimer();
      } else {
        evaluateShowdown();
      }
    } else {
      if (activePlayers.length > 1) {
        let nextTurn = gameState.currentTurnIndex;
        do {
          nextTurn = (nextTurn + 1) % gameState.players.length;
        } while (gameState.players[nextTurn].status === 'folded');
        gameState.currentTurnIndex = nextTurn;
        startTurnTimer();
      }
    }

    broadcastState();
  };

  // Ações do Jogador via Socket
  socket.on('player_action', (data) => {
    handlePlayerAction(socket.id, data);
  });

  const evaluateShowdown = () => {
    let hands = [];
    let board = gameState.communityCards.map(formatCard);

    gameState.players.forEach(p => {
      if (p.status !== 'folded' && p.cards && p.cards.length === 2) {
        let playerHand = p.cards.map(formatCard).concat(board);
        let solvedHand = Hand.solve(playerHand);
        solvedHand.playerId = p.id;
        hands.push(solvedHand);
      }
    });

    if (hands.length > 0) {
      let winners = Hand.winners(hands);
      let winnerIds = winners.map(w => w.playerId);
      let winnerNames = winnerIds.map(id => gameState.players.find(p => p.id === id).name);
      
      gameState.winnerInfo = {
        ids: winnerIds,
        names: winnerNames,
        description: winners[0].descr
      };
      
      let splitPot = gameState.pot / winnerIds.length;
      gameState.players.forEach(p => {
        if (winnerIds.includes(p.id)) {
          p.chips += splitPot;
        }
      });
      gameState.pot = 0;
      gameState.currentTurnIndex = -1; // Acabou o turno
    }
  };

  // Avaliar quem ganhou (Showdown manual via botão)
  socket.on('showdown', () => {
    evaluateShowdown();
    broadcastState();
  });

  // Chat
  socket.on('send_chat', (msg) => {
    const player = gameState.players.find(p => p.id === socket.id);
    const name = player ? player.name : 'Espectador';
    io.emit('receive_chat', { id: Date.now(), name, text: msg, time: new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) });
  });

  // Admin / Controles Extras
  socket.on('kick_player', (playerId) => {
    gameState.players = gameState.players.filter(p => p.id !== playerId);
    broadcastChat(`Um jogador foi expulso da mesa.`);
    broadcastState();
  });

  socket.on('reset_database', async () => {
    await db.resetDatabase();
    gameState.logs = []; // Limpa logs locais também
    broadcastChat(`O Histórico Geral foi resetado.`);
    const ranking = await db.getLeaderboard(gameState.players);
    io.emit('leaderboard_updated', ranking);
  });

  // --- BANKROLL INTEGRATION ---
  socket.on('buy_in', async (amount) => {
    const player = gameState.players.find(p => p.id === socket.id);
    let inv = parseFloat(amount);
    if (player && inv > 0) {
      player.totalInvestido += inv;
      player.chips += (inv * 10); // R$ 1.00 = 10 fichas (valor 0.10)
      broadcastState();
      const ranking = await db.getLeaderboard(gameState.players);
      io.emit('leaderboard_updated', ranking);
    }
  });

  socket.on('get_leaderboard', async (callback) => {
    // Retorna o ranking do database
    const ranking = await db.getLeaderboard(gameState.players);
    if (callback) callback(ranking);
  });

  socket.on('end_session', async () => {
    // Registra os dados finais de todos os jogadores
    for (const p of gameState.players) {
      let totalInvest = parseFloat(p.totalInvestido) || 0;
      let fichasFin = parseInt(p.chips) || 0;
      
      if (totalInvest > 0 || fichasFin > 0) {
        let retorno = fichasFin * 0.10;
        let saldo = retorno - totalInvest;
        
        await db.addTransaction({
          name: p.name,
          investimento: totalInvest,
          fichasFinais: fichasFin,
          valorFicha: 0.10,
          retorno: parseFloat(retorno.toFixed(2)),
          saldo: parseFloat(saldo.toFixed(2)),
          status: 'Finalizada'
        });
      }
      // Reseta para a próxima
      p.chips = 0;
      p.totalInvestido = 0;
    }
    
    // Atualiza todos com o novo estado vazio e o ranking
    broadcastState();
    const ranking = await db.getLeaderboard(gameState.players);
    io.emit('leaderboard_updated', ranking);
  });

});



const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Servidor de Poker rodando na porta ${PORT}`);
});
