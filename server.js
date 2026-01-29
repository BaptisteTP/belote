// server.js
// Belote / Coinche (4 joueurs) — Lobby + Partie complète (enchères, coinche/surcoinche, plis, points, redonne)
// Node >= 18
//
// Lancer :
//   npm install
//   npm start
// Ouvrir : http://localhost:3000

const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

// -----------------------------
// ROOMS
// -----------------------------
const rooms = {}; // { [roomId]: { game, hostSid, names, order, started, state } }

function generateRoomCode() {
  return Math.random().toString(36).substring(2, 6).toUpperCase();
}

function publicRooms() {
  return Object.entries(rooms)
    .filter(([_, r]) => !r.finished) // ✅ cache les tables finies
    .map(([id, r]) => ({
      id,
      game: r.game,
      players: Object.keys(r.names).length,
      max: 4,
    }));
}

function roomSafe(roomId) {
  const r = rooms[roomId];
  if (!r) return null;
  return {
    id: roomId,
    game: r.game,
    hostSid: r.hostSid,
    names: r.names,
    started: r.started,
    order: r.order,
  };
}

function ensureRoom(roomId) {
  const room = rooms[roomId];
  if (!room) return null;
  if (!room.state) room.state = createInitialState();
  if (!room.order) room.order = [];
  if (!room.names) room.names = {};
  return room;
}

// -----------------------------
// CARD / BELOTE RULES
// -----------------------------
const SUITS = ["S", "H", "D", "C"]; // ♠ ♥ ♦ ♣
const RANKS = ["7", "8", "9", "J", "Q", "K", "10", "A"]; // 32 cards

function makeDeck() {
  const deck = [];
  for (const s of SUITS) for (const r of RANKS) deck.push({ suit: s, rank: r });
  return deck;
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [a[i], a[j]] = [a[j], a[i]];
  }
}

function cardKey(c) {
  return `${c.rank}${c.suit}`;
}

const TRUMP_STRENGTH = ["J", "9", "A", "10", "K", "Q", "8", "7"];
const PLAIN_STRENGTH = ["A", "10", "K", "Q", "J", "9", "8", "7"];

function strengthIndex(rank, isTrump) {
  const arr = isTrump ? TRUMP_STRENGTH : PLAIN_STRENGTH;
  const idx = arr.indexOf(rank);
  return idx >= 0 ? idx : 999;
}

function compareCards(a, b, leadSuit, trump) {
  // returns 1 if a > b, -1 if a < b, 0 if equal (shouldn't happen)
  const aTrump = a.suit === trump;
  const bTrump = b.suit === trump;

  if (aTrump && !bTrump) return 1;
  if (!aTrump && bTrump) return -1;

  if (a.suit === b.suit) {
    const isT = a.suit === trump;
    const ai = strengthIndex(a.rank, isT);
    const bi = strengthIndex(b.rank, isT);
    return ai < bi ? 1 : ai > bi ? -1 : 0;
  }

  const aLead = a.suit === leadSuit;
  const bLead = b.suit === leadSuit;
  if (aLead && !bLead) return 1;
  if (!aLead && bLead) return -1;

  return 0;
}

function pointsOfCard(card, trump) {
  const t = card.suit === trump;
  if (t) {
    if (card.rank === "J") return 20;
    if (card.rank === "9") return 14;
    if (card.rank === "A") return 11;
    if (card.rank === "10") return 10;
    if (card.rank === "K") return 4;
    if (card.rank === "Q") return 3;
    return 0;
  } else {
    if (card.rank === "A") return 11;
    if (card.rank === "10") return 10;
    if (card.rank === "K") return 4;
    if (card.rank === "Q") return 3;
    if (card.rank === "J") return 2;
    return 0;
  }
}

function suitEmoji(s) {
  if (s === "S") return "♠";
  if (s === "H") return "♥";
  if (s === "D") return "♦";
  return "♣";
}

function teamOf(room, sid) {
  const idx = room.order.indexOf(sid);
  if (idx === -1) return "NS";
  return idx % 2 === 0 ? "NS" : "EW"; // 0/2 vs 1/3
}

function teamNames(room) {
  const a = room.names[room.order[0]] || "—";
  const c = room.names[room.order[2]] || "—";
  const b = room.names[room.order[1]] || "—";
  const d = room.names[room.order[3]] || "—";
  return { AC: `${a} / ${c}`, BD: `${b} / ${d}` };
}

// -----------------------------
// STATE
// -----------------------------
function createInitialState() {
  return {
    phase: "lobby", // lobby -> bidding -> playing
    messages: [],

    dealerIndex: 0,
    biddingIndex: 0,
    leaderIndex: 0,
    currentPlayerSid: null,

    hands: {},

    highestBid: null, // { sid, value, trump }
    contract: null,   // { takerSid, value, trump }
    passCount: 0,

    coinche: 0, // 0 none, 1 coinche, 2 surcoinche
    coincheBy: null,

    trickNo: 0,
    trick: [], // [{sid, card}]
    lastTrick: null,

    pointsWon: { NS: 0, EW: 0 },
    tricksWon: { NS: 0, EW: 0 },

    scores: { NS: 0, EW: 0 },

    belote: {}, // sid -> {hasQ,hasK,saidBelote,saidRebelote}
  };
}

// -----------------------------
// SNAPSHOTS / EMITS
// -----------------------------
function publicSnapshot(roomId) {
  const room = rooms[roomId];
  const st = room.state;

  const players = room.order.map((sid, seatIndex) => ({
    sid,
    name: room.names[sid] || "—",
    seatIndex,
  }));

  return {
    roomId,
    game: room.game,
    players,
    state: {
      phase: st.phase === "lobby" ? "bidding" : st.phase,
      bidTurnSid: room.order[st.biddingIndex],

      messages: st.messages.slice(-80),

      dealerIndex: st.dealerIndex,
      biddingIndex: st.biddingIndex,
      leaderIndex: st.leaderIndex,
      currentPlayerSid: st.currentPlayerSid,

      highestBid: st.highestBid,
      contract: st.contract,

      coinche: st.coinche,
      coincheBy: st.coincheBy,

      trickNo: st.trickNo,
      trick: st.trick,
      lastTrick: st.lastTrick,

      pointsWon: st.pointsWon,
      scores: st.scores,
    },
  };
}

function emitRoomUpdate(roomId) {
  io.to(roomId).emit("roomUpdate", roomSafe(roomId));
  io.emit("roomsList", publicRooms());
}

function emitGameState(roomId) {
  io.to(roomId).emit("gameState", publicSnapshot(roomId));
}

function emitRoomsListOnly() {
  io.emit("roomsList", publicRooms());
}

function emitGameOver(roomId, payload) {
  io.to(roomId).emit("gameOver", payload);
}


function sendYourHand(roomId, sid) {
  const room = rooms[roomId];
  if (!room) return;
  const st = room.state;
  const hand = st.hands[sid] || [];

  let legalKeys = [];
  let yourTurn = false;
  let phase = st.phase;

  if (st.phase === "playing") {
    yourTurn = st.currentPlayerSid === sid;
    legalKeys = yourTurn ? computeLegalKeys(roomId, sid) : [];
  } else {
    yourTurn = false;
    legalKeys = [];
  }

  io.to(sid).emit("yourHand", {
    roomId,
    hand,
    legalKeys,
    yourTurn,
    phase,
  });
}

// -----------------------------
// GAME FLOW
// -----------------------------
function startGame(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  const st = room.state;

  room.started = true;

  st.phase = "bidding";
  st.messages.push(`🟢 Partie lancée !`);

  if (typeof st.dealerIndex !== "number") st.dealerIndex = 0;

  startNewHand(roomId, true);
}

function startNewHand(roomId, first = false) {
  const room = rooms[roomId];
  const st = room.state;

  st.phase = "bidding";
  st.trickNo = 0;
  st.trick = [];
  st.lastTrick = null;

  st.pointsWon = { NS: 0, EW: 0 };
  st.tricksWon = { NS: 0, EW: 0 };

  st.highestBid = null;
  st.contract = null;
  st.passCount = 0;

  st.coinche = 0;
  st.coincheBy = null;

  st.belote = {};
  for (const sid of room.order) {
    st.belote[sid] = { hasQ: false, hasK: false, saidBelote: false, saidRebelote: false };
  }

  if (!first) st.dealerIndex = (st.dealerIndex + 1) % 4;

  st.biddingIndex = (st.dealerIndex + 1) % 4;
  st.leaderIndex = (st.dealerIndex + 1) % 4;

  const deck = makeDeck();
  shuffle(deck);

  st.hands = {};
  for (const sid of room.order) st.hands[sid] = [];

  // Deal 8 each
  for (let round = 0; round < 8; round++) {
    for (let i = 0; i < 4; i++) {
      const sid = room.order[(st.dealerIndex + 1 + i) % 4];
      st.hands[sid].push(deck.pop());
    }
  }

  const dealerName = room.names[room.order[st.dealerIndex]] || "—";
  st.messages.push(`🃏 Nouvelle donne. Donneur : ${dealerName}`);

  st.currentPlayerSid = room.order[st.biddingIndex];

  emitGameState(roomId);
  for (const sid of room.order) sendYourHand(roomId, sid);
}

function nextBidder(roomId) {
  const room = rooms[roomId];
  const st = room.state;
  st.biddingIndex = (st.biddingIndex + 1) % 4;
  st.currentPlayerSid = room.order[st.biddingIndex];
}

function endBiddingIfNeeded(roomId) {
  const room = rooms[roomId];
  const st = room.state;

  // 4 passes and no bid -> redeal
  if (!st.highestBid && st.passCount >= 4) {
    st.messages.push(`🔁 Personne n'a annoncé. On redonne.`);
    startNewHand(roomId, false);
    return true;
  }

  // bid exists and 3 consecutive passes after it -> contract fixed
  if (st.highestBid && st.passCount >= 3) {
    st.contract = {
      takerSid: st.highestBid.sid,
      value: st.highestBid.value,     // 80..160 ou 250
      trump: st.highestBid.trump,
      isCapot: !!st.highestBid.isCapot,
      display: st.highestBid.display, // "CAPOT" ou "160"
    };


    // ✅ initialise belote (scan des mains) maintenant qu'on connaît l'atout
    initBeloteForTrump(roomId);

    const takerName = room.names[st.contract.takerSid] || "—";
    const coincheTxt = st.coinche === 2 ? " (surcoinche)" : st.coinche === 1 ? " (coinche)" : "";
    st.messages.push(`📌 Contrat : ${st.contract.display}${suitEmoji(st.contract.trump)} par ${takerName}${coincheTxt}`);

    st.phase = "playing";
    st.trickNo = 0;
    st.trick = [];
    st.lastTrick = null;

    st.leaderIndex = (st.dealerIndex + 1) % 4;
    st.currentPlayerSid = room.order[st.leaderIndex];

    emitGameState(roomId);
    for (const sid of room.order) sendYourHand(roomId, sid);
    return true;
  }

  return false;
}

function nextPlayerInTrick(roomId) {
  const room = rooms[roomId];
  const st = room.state;

  const leaderIdx = st.leaderIndex;
  const playedCount = st.trick.length;
  const nextIdx = (leaderIdx + playedCount) % 4;
  st.currentPlayerSid = room.order[nextIdx];
}

// -----------------------------
// LEGAL MOVES (strict overtrump + must trump if void)
// -----------------------------
function hasSuit(hand, suit) {
  return hand.some((c) => c.suit === suit);
}

function highestTrumpInTrick(trick, trump) {
  const trumps = trick.filter((t) => t.card.suit === trump).map((t) => t.card);
  if (trumps.length === 0) return null;
  let best = trumps[0];
  for (let i = 1; i < trumps.length; i++) {
    if (compareCards(trumps[i], best, trump, trump) > 0) best = trumps[i];
  }
  return best;
}

function sameTeam(room, sidA, sidB) {
  if (!sidA || !sidB) return false;
  return teamOf(room, sidA) === teamOf(room, sidB);
}

function currentWinnerSid(roomId) {
  const room = rooms[roomId];
  const st = room.state;
  const trump = st.contract?.trump;
  if (!trump || !st.trick || st.trick.length === 0) return null;

  const leadSuit = st.trick[0].card.suit;
  let best = st.trick[0];

  for (let i = 1; i < st.trick.length; i++) {
    const cur = st.trick[i];
    if (compareCards(cur.card, best.card, leadSuit, trump) > 0) best = cur;
  }
  return best.sid;
}


function computeLegalKeys(roomId, sid) {
  const room = rooms[roomId];
  const st = room.state;

  const hand = st.hands[sid] || [];
  if (hand.length === 0) return [];

  // 1) Premier à jouer du pli : tout est autorisé
  if (st.trick.length === 0) return hand.map(cardKey);

  const trump = st.contract?.trump;
  const leadSuit = st.trick[0].card.suit;

  const hasLead = hasSuit(hand, leadSuit);
  const hasTrump = trump ? hasSuit(hand, trump) : false;

  // 2) Si tu as la couleur demandée : tu dois fournir
  if (hasLead) {
    // Si la couleur demandée = atout : obligation de monter à l'atout si possible
    if (trump && leadSuit === trump) {
      const bestTrump = highestTrumpInTrick(st.trick, trump);
      if (bestTrump) {
        const higherTrumps = hand.filter(
          c => c.suit === trump && compareCards(c, bestTrump, trump, trump) > 0
        );
        if (higherTrumps.length > 0) return higherTrumps.map(cardKey);
      }
      return hand.filter(c => c.suit === trump).map(cardKey);
    }

    // Couleur normale : juste fournir (pas obligé de "monter" hors atout)
    return hand.filter(c => c.suit === leadSuit).map(cardKey);
  }

  // 3) Tu n'as pas la couleur demandée
  // -> partenaire maître => pas obligé de couper, sauf si un adversaire a coupé
  if (trump && hasTrump) {
    const bestTrump = highestTrumpInTrick(st.trick, trump);

    // 3a) Si quelqu'un a déjà coupé (il y a de l'atout dans le pli)
    if (bestTrump) {
      // retrouver le sid qui a posé le meilleur atout actuel
      const leadSuit2 = st.trick[0].card.suit;
      let bestEntry = st.trick[0];
      for (let i = 1; i < st.trick.length; i++) {
        const cur = st.trick[i];
        if (compareCards(cur.card, bestEntry.card, leadSuit2, trump) > 0) bestEntry = cur;
      }
      const bestSid = bestEntry.sid;

      // Si l'adversaire maîtrise (a coupé / surcoupé), tu dois SURCOUPER si possible, sinon couper
      if (bestSid && !sameTeam(room, sid, bestSid)) {
        const higherTrumps = hand.filter(
          c => c.suit === trump && compareCards(c, bestTrump, trump, trump) > 0
        );
        if (higherTrumps.length > 0) return higherTrumps.map(cardKey);

        return hand.filter(c => c.suit === trump).map(cardKey);
      }

      // Si ton partenaire maîtrise déjà (meilleure carte actuelle), tu peux pisser
      return hand.map(cardKey);
    }

    // 3b) Personne n'a encore coupé : si ton partenaire est maître à la couleur -> tu peux pisser
    const winSid = currentWinnerSid(roomId);
    if (winSid && sameTeam(room, sid, winSid)) {
      return hand.map(cardKey);
    }

    // Sinon tu dois couper (mettre atout)
    return hand.filter(c => c.suit === trump).map(cardKey);
  }

  // 4) Pas de couleur demandée et pas d'atout : tu peux jouer ce que tu veux
  return hand.map(cardKey);
}


// -----------------------------
// BELOTE / REBELOTE (scan mains + messages + bonus)
// -----------------------------
function initBeloteForTrump(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  const st = room.state;
  const trump = st.contract?.trump;
  if (!trump) return;

  for (const sid of room.order) {
    const hand = st.hands[sid] || [];
    const hasQ = hand.some((c) => c.suit === trump && c.rank === "Q");
    const hasK = hand.some((c) => c.suit === trump && c.rank === "K");
    if (!st.belote[sid]) st.belote[sid] = { hasQ: false, hasK: false, saidBelote: false, saidRebelote: false };
    st.belote[sid].hasQ = hasQ;
    st.belote[sid].hasK = hasK;
  }
}

function checkBeloteRebelote(roomId, sid, card) {
  const room = rooms[roomId];
  const st = room.state;
  const trump = st.contract?.trump;
  if (!trump) return;
  if (card.suit !== trump) return;
  if (card.rank !== "Q" && card.rank !== "K") return;

  const b = st.belote[sid];
  if (!b) return;

  if (!(b.hasQ && b.hasK)) return;

  const n = room.names[sid] || "—";
  const team = teamOf(room, sid);

  if (!b.saidBelote) {
    b.saidBelote = true;
    st.messages.push(`✨ BELOTE ! (${n})`);
    return;
  }

  if (!b.saidRebelote) {
    b.saidRebelote = true;
    st.messages.push(`🔥 REBELOTE ! (${n})`);
    st.pointsWon[team] += 20; // ✅ bonus immédiat dans les points du tour
  }
}

// -----------------------------
// TRICK RESOLUTION + SCORING + REDEAL
// -----------------------------
function computeTrickWinnerIndex(roomId) {
  const room = rooms[roomId];
  const st = room.state;

  const trump = st.contract.trump;
  const leadSuit = st.trick[0].card.suit;

  let best = st.trick[0];
  for (let i = 1; i < st.trick.length; i++) {
    const cur = st.trick[i];
    if (compareCards(cur.card, best.card, leadSuit, trump) > 0) best = cur;
  }
  return room.order.indexOf(best.sid);
}

function resolveTrick(roomId) {
  const room = rooms[roomId];
  const st = room.state;

  const trump = st.contract.trump;
  const winnerIdx = computeTrickWinnerIndex(roomId);
  const winnerSid = room.order[winnerIdx];
  const winnerTeam = teamOf(room, winnerSid);

  let pts = 0;
  for (const t of st.trick) pts += pointsOfCard(t.card, trump);

  if (st.trickNo === 7) pts += 10; // last trick bonus

  st.pointsWon[winnerTeam] += pts;
  st.tricksWon[winnerTeam] += 1;

  st.lastTrick = {
    trickNo: st.trickNo + 1,
    winnerSid,
    points: pts,
    cards: st.trick.map((x) => ({ sid: x.sid, card: x.card })),
  };

  st.leaderIndex = winnerIdx;
  st.trick = [];
  st.trickNo += 1;

  if (st.trickNo >= 8) {
    finishHandAndRedeal(roomId);
    return;
  }

  st.currentPlayerSid = room.order[st.leaderIndex];

  emitGameState(roomId);
  for (const sid of room.order) sendYourHand(roomId, sid);
}

function finishHandAndRedeal(roomId) {
  const room = rooms[roomId];
  const st = room.state;

  const takerSid = st.contract.takerSid;
  const takerTeam = teamOf(room, takerSid);
  const defendersTeam = takerTeam === "NS" ? "EW" : "NS";

  // points de plis (inclut belote bonus déjà ajouté en direct +20)
  let nsTrickPts = st.pointsWon.NS;
  let ewTrickPts = st.pointsWon.EW;

  // ✅ CAPOT : 8 plis -> 252
  const nsCapot = st.tricksWon.NS === 8;
  const ewCapot = st.tricksWon.EW === 8;
  if (nsCapot) { nsTrickPts = 252; ewTrickPts = 0; }
  if (ewCapot) { ewTrickPts = 252; nsTrickPts = 0; }

  // multiplicateur coinche / surcoinche
  const multiplier = st.coinche === 2 ? 4 : st.coinche === 1 ? 2 : 1;

  // réussite contrat ?
  const contractValue = st.contract.value; // 80..160 ou 250
  const isCapotContract = !!st.contract.isCapot;

  const takerPts = (takerTeam === "NS") ? nsTrickPts : ewTrickPts;

  // réussite
  const made = isCapotContract
    ? (takerTeam === "NS" ? st.tricksWon.NS === 8 : st.tricksWon.EW === 8)
    : (takerPts >= contractValue);


  const tNames = teamNames(room);
  const takerName = room.names[takerSid] || "—";
  const coincheTxt = st.coinche === 2 ? " (surcoinche)" : st.coinche === 1 ? " (coinche)" : "";

  st.messages.push("—");
  st.messages.push("🧾 Fin de manche");
  const contractLabel = st.contract.isCapot ? "CAPOT" : String(contractValue);
  st.messages.push(`Annonce: ${contractLabel}${suitEmoji(st.contract.trump)} par ${takerName}${coincheTxt}`);
  st.messages.push(`Plis (pts): ${tNames.AC} ${nsTrickPts} — ${tNames.BD} ${ewTrickPts}`);
  if (isCapotContract && made) st.messages.push(`🎯 CAPOT RÉUSSI !`);
  if (isCapotContract && !made) st.messages.push(`❌ CAPOT CHUTÉ !`);

  // ✅ TON SCORING DEMANDÉ :
  // Si contrat réussi :
  //   preneur = plis + annonce
  //   défense = ses plis
  // Si chuté :
  //   défense = (162 ou 252) + annonce ; preneur = 0
  const baseTotal = isCapotContract ? 252 : 162;

  if (made) {
    if (takerTeam === "NS") {
      st.scores.NS += (nsTrickPts + contractValue) * multiplier;
      st.scores.EW += (ewTrickPts) * multiplier;
    } else {
      st.scores.EW += (ewTrickPts + contractValue) * multiplier;
      st.scores.NS += (nsTrickPts) * multiplier;
    }
    st.messages.push(`✅ Contrat réussi → (+annonce) x${multiplier}`);
  } else {
    const defenseGain = (baseTotal + contractValue) * multiplier;
    if (defendersTeam === "NS") st.scores.NS += defenseGain;
    else st.scores.EW += defenseGain;
    st.messages.push(`❌ Contrat chuté → défense ${baseTotal}+annonce x${multiplier}`);
  }

  st.messages.push(`Total: ${tNames.AC} ${st.scores.NS} — ${tNames.BD} ${st.scores.EW}`);

  const WIN = 1501;
  const winner =
    st.scores.NS >= WIN ? "NS" :
    st.scores.EW >= WIN ? "EW" :
    null;

  if (winner) {
    const winLabel = winner === "NS" ? tNames.AC : tNames.BD;

    st.phase = "finished";
    room.finished = true;

    // ⚠️ IMPORTANT : ne pas faire room.started = false ici
    // sinon l’UI te renvoie au menu avant d’afficher le popup

    st.messages.push("—");
    st.messages.push(`🏆 Félicitations ! Victoire de l’équipe ${winLabel} 🎉`);
    st.messages.push(`Score final : ${tNames.AC} ${st.scores.NS} — ${tNames.BD} ${st.scores.EW}`);

    emitGameOver(roomId, {
      winnerTeam: winner,
      winnerLabel: winLabel,
      teams: tNames,
      scores: { NS: st.scores.NS, EW: st.scores.EW },
    });

    emitGameState(roomId);

    // ✅ la table disparaît du lobby
    io.emit("roomsList", publicRooms());

    return;
  }

  startNewHand(roomId, false);
}

// -----------------------------
// SOCKETS
// -----------------------------
io.on("connection", (socket) => {
  socket.emit("roomsList", publicRooms());

  socket.on("createRoom", ({ name, game }) => {
    const cleanName = (name || "").trim().slice(0, 18) || "Joueur";
    const roomId = generateRoomCode();

    rooms[roomId] = {
      game: game === "coinche" ? "coinche" : "belote",
      hostSid: socket.id,
      names: { [socket.id]: cleanName },
      order: [socket.id],
      started: false,
      state: createInitialState(),
    };

    socket.join(roomId);
    socket.emit("roomJoined", roomId);

    emitRoomUpdate(roomId);
  });

  socket.on("joinRoom", ({ roomId, name }) => {
    const room = ensureRoom(roomId);
    if (!room) return;
    if (room.started) return;
    if (room.order.length >= 4) return;

    const cleanName = (name || "").trim().slice(0, 18) || "Joueur";
    room.names[socket.id] = cleanName;
    room.order.push(socket.id);

    socket.join(roomId);
    socket.emit("roomJoined", roomId);

    emitRoomUpdate(roomId);
  });

  socket.on("leaveRoom", ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;

    socket.leave(roomId);
    delete room.names[socket.id];
    room.order = room.order.filter((sid) => sid !== socket.id);

    if (room.hostSid === socket.id) room.hostSid = room.order[0] || null;

    if (room.order.length === 0) delete rooms[roomId];
    else emitRoomUpdate(roomId);
  });

  socket.on("startGame", ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;
    if (socket.id !== room.hostSid) return;
    if (room.order.length !== 4) return;

    startGame(roomId);
    emitRoomUpdate(roomId);
  });

  // ---------- bidding ----------
  socket.on("bid", ({ roomId, action, value, trump }) => {
    const room = rooms[roomId];
    if (room.finished) return;
    if (!room || !room.started) return;
    const st = room.state;

    if (st.phase !== "bidding") return;

    const currentSid = room.order[st.biddingIndex];
    if (socket.id !== currentSid) return;

    // PASS
    if (action === "pass") {
      st.passCount += 1;
      const n = room.names[socket.id] || "—";
      st.messages.push(`🟦 ${n} passe`);
      nextBidder(roomId);

      if (endBiddingIfNeeded(roomId)) return;

      emitGameState(roomId);
      return;
    }

    // TAKE (annonce) + CAPOT
    if (action === "take" || action === "capot") {
      const bidValue = Number(value);
      const isCapot = (action === "capot");
    
      // capot = annonce 250 (pour le scoring), mais affichage "CAPOT"
      const announceValue = isCapot ? 250 : bidValue;
    
      if (!isCapot) {
        if (![80, 90, 100, 110, 120, 130, 140, 150, 160].includes(announceValue)) return;
      }
    
      if (!["S", "H", "D", "C"].includes(trump)) return;
    
      // comparaison des annonces (capot > 160)
      const currentBest = st.highestBid ? (st.highestBid.value || 0) : 0;
      if (announceValue <= currentBest) return;
    
      st.highestBid = {
        sid: socket.id,
        value: announceValue,          // <-- NUMERIQUE (250 si capot)
        trump,
        isCapot,
        display: isCapot ? "CAPOT" : String(announceValue),
      };
    
      st.passCount = 0;
    
      // reset coinche if someone overbids
      st.coinche = 0;
      st.coincheBy = null;
    
      const n = room.names[socket.id] || "—";
      st.messages.push(`📣 ${n} annonce ${st.highestBid.display}${suitEmoji(trump)}`);
    
      nextBidder(roomId);
      emitGameState(roomId);
      return;
    }


    // COINCHE (must have a highestBid and be opposite team)
    if (action === "coinche") {
      if (!st.highestBid) return;
      if (st.coinche !== 0) return;

      const bidderTeam = teamOf(room, socket.id);
      const takerTeam = teamOf(room, st.highestBid.sid);
      if (bidderTeam === takerTeam) return;

      st.coinche = 1;
      st.coincheBy = socket.id;

      const n = room.names[socket.id] || "—";
      st.messages.push(`📣 COINCHE ! (${n})`);

      nextBidder(roomId);
      emitGameState(roomId);
      return;
    }

    // SURCOINCHE (only taker's team, after coinche)
    if (action === "surcoinche") {
      if (!st.highestBid) return;
      if (st.coinche !== 1) return;

      const bidderTeam = teamOf(room, socket.id);
      const takerTeam = teamOf(room, st.highestBid.sid);
      if (bidderTeam !== takerTeam) return;

      st.coinche = 2;
      const n = room.names[socket.id] || "—";
      st.messages.push(`🔥 SURCOINCHE ! (${n})`);

      // ✅ SURCOINCHE => on clôt les enchères immédiatement
      st.passCount = 3;
      if (endBiddingIfNeeded(roomId)) return;

      emitGameState(roomId);
      return;
    }
  });

  // ---------- play card ----------
  socket.on("playCard", ({ roomId, card }) => {
    const room = rooms[roomId];
    if (room.finished) return;
    if (!room || !room.started) return;
    const st = room.state;

    if (st.phase !== "playing") return;
    if (st.currentPlayerSid !== socket.id) return;

    const hand = st.hands[socket.id] || [];
    const idx = hand.findIndex((c) => c.rank === card.rank && c.suit === card.suit);
    if (idx === -1) return;

    const legal = new Set(computeLegalKeys(roomId, socket.id));
    const k = cardKey(card);
    if (!legal.has(k)) return;

    const played = hand.splice(idx, 1)[0];
    st.hands[socket.id] = hand;

    // ✅ belote/rebelote msg + bonus
    checkBeloteRebelote(roomId, socket.id, played);

    st.trick.push({ sid: socket.id, card: played });

    if (st.trick.length === 4) {
      resolveTrick(roomId);
      return;
    }

    nextPlayerInTrick(roomId);

    emitGameState(roomId);
    for (const sid of room.order) sendYourHand(roomId, sid);
  });

  socket.on("disconnect", () => {
    for (const roomId of Object.keys(rooms)) {
      const room = rooms[roomId];
      if (!room.names[socket.id]) continue;

      delete room.names[socket.id];
      room.order = room.order.filter((sid) => sid !== socket.id);

      if (room.hostSid === socket.id) room.hostSid = room.order[0] || null;

      if (room.order.length === 0) {
        delete rooms[roomId];
      } else {
        if (room.started) {
          room.started = false;
          room.state = createInitialState();
          room.state.messages.push("⛔ Un joueur a quitté. Partie arrêtée.");
        }
        emitRoomUpdate(roomId);
        emitGameState(roomId);
      }
    }

    io.emit("roomsList", publicRooms());
  });
});

// -----------------------------
server.listen(3000, () => {
  console.log("Serveur lancé sur http://localhost:3000");
});
