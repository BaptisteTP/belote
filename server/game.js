const { rooms } = require("./rooms");
const { shuffle, makeDeck32, cardKey, cardPoints, trickWinner, legalMoves } = require("./beloteRules");

function seatByIndex(i) { return ["N", "E", "S", "W"][i] ?? "?"; }

function nameOf(room, sid) { return room?.names?.[sid] ?? "Joueur"; }

function teamOfFactory(room) {
  return (sid) => {
    const idx = room.order.indexOf(sid);
    return (idx === 0 || idx === 2) ? "NS" : "EW";
  };
}

function initRoomState(io, roomId) {
  const room = rooms[roomId];
  if (!room) return;

  room.started = true;

  room.state = {
    phase: "bidding",
    dealerIndex: 0,
    order: room.order,

    scores: { NS: 0, EW: 0 },

    hands: {},
    trick: [],
    leadSuit: null,
    trickNumber: 0,
    tricksWon: { NS: 0, EW: 0 },
    pointsWon: { NS: 0, EW: 0 },

    lastTrick: null,

    biddingIndex: 1,
    highestBid: null,
    passesInRow: 0,

    contract: null,

    belote: { NS: false, EW: false },
    beloteSeen: { NS: { Q: false, K: false }, EW: { Q: false, K: false } },

    currentPlayerSid: null,
    messages: []
  };

  newDeal(io, roomId);
}

function newDeal(io, roomId) {
  const room = rooms[roomId];
  const st = room.state;

  st.phase = "bidding";
  st.hands = {};
  st.trick = [];
  st.leadSuit = null;
  st.trickNumber = 0;
  st.tricksWon = { NS: 0, EW: 0 };
  st.pointsWon = { NS: 0, EW: 0 };
  st.highestBid = null;
  st.passesInRow = 0;
  st.contract = null;
  st.currentPlayerSid = null;
  st.lastTrick = null;

  st.belote = { NS: false, EW: false };
  st.beloteSeen = { NS: { Q: false, K: false }, EW: { Q: false, K: false } };

  const deck = shuffle(makeDeck32());
  for (const sid of room.order) st.hands[sid] = [];
  for (let r = 0; r < 8; r++) for (const sid of room.order) st.hands[sid].push(deck.pop());

  st.biddingIndex = (st.dealerIndex + 1) % 4;
  st.messages.push(`🃏 Nouvelle donne. Donneur: ${nameOf(room, room.order[st.dealerIndex])}`);

  sendRoomState(io, roomId);
}

function roomStateSnapshot(roomId) {
  const room = rooms[roomId];
  if (!room) return null;
  const st = room.state;

  const players = room.order.map((sid, i) => ({
    sid,
    seat: seatByIndex(i),
    name: nameOf(room, sid),
    team: teamOfFactory(room)(sid),
    isHost: room.host === sid
  }));

  return {
    roomId,
    game: room.game,
    host: room.host,
    started: room.started,
    players,
    state: {
      phase: st.phase,
      dealerIndex: st.dealerIndex,
      order: st.order,
      biddingIndex: st.biddingIndex,
      highestBid: st.highestBid,
      contract: st.contract,
      scores: st.scores,
      trick: st.trick,
      leadSuit: st.leadSuit,
      trickNumber: st.trickNumber,
      tricksWon: st.tricksWon,
      pointsWon: st.pointsWon,
      currentPlayerSid: st.currentPlayerSid,
      belote: st.belote,
      lastTrick: st.lastTrick,
      messages: st.messages.slice(-40)
    }
  };
}

function sendRoomState(io, roomId) {
  const room = rooms[roomId];
  if (!room || !room.state) return;

  io.to(roomId).emit("roomState", roomStateSnapshot(roomId));

  const st = room.state;
  const teamOf = teamOfFactory(room);

  for (const sid of room.order) {
    const hand = st.hands?.[sid] ?? [];
    const yourTurn = st.currentPlayerSid === sid;
    const legalKeys = (st.phase === "playing")
      ? legalMoves({ order: room.order, hands: st.hands, trick: st.trick, leadSuit: st.leadSuit, contract: st.contract, teamOf }, sid).map(cardKey)
      : [];
    io.to(sid).emit("yourHand", { roomId, phase: st.phase, yourTurn, legalKeys, hand });
  }
}

function lockContract(io, roomId) {
  const room = rooms[roomId];
  const st = room.state;
  if (!st.highestBid) {
    st.messages.push("Tout le monde passe. On redonne.");
    st.dealerIndex = (st.dealerIndex + 1) % 4;
    return newDeal(io, roomId);
  }

  st.contract = {
    value: st.highestBid.value,
    trump: st.highestBid.trump,
    bidderSid: st.highestBid.bidderSid,
    team: st.highestBid.team,
    multiplier: 1
  };

  st.messages.push(`📣 Contrat: ${st.contract.value}${st.contract.trump} (preneur: ${nameOf(room, st.contract.bidderSid)})`);
  startPlaying(io, roomId);
}

function startPlaying(io, roomId) {
  const room = rooms[roomId];
  const st = room.state;

  st.phase = "playing";
  const firstIndex = (st.dealerIndex + 1) % 4;
  st.currentPlayerSid = room.order[firstIndex];
  st.trick = [];
  st.leadSuit = null;
  st.trickNumber = 0;

  sendRoomState(io, roomId);
}

function onBid(io, socket, { roomId, action, value, trump }) {
  const id = String(roomId || "").toUpperCase().trim();
  const room = rooms[id];
  if (!room || !room.state) throw new Error("Room invalid");

  const st = room.state;
  if (st.phase !== "bidding") throw new Error("Not in bidding");

  const currentSid = room.order[st.biddingIndex];
  if (socket.id !== currentSid) throw new Error("Pas ton tour d’annoncer");

  const teamOf = teamOfFactory(room);

  if (action === "pass") {
    st.passesInRow += 1;
    st.messages.push(`🗣️ ${nameOf(room, socket.id)} passe.`);
  } else if (action === "take") {
    const bidVal = Number(value);
    const suit = String(trump);
    const allowedVals = [80, 90, 100, 110, 120, 130, 140, 150, 160];
    if (!allowedVals.includes(bidVal)) throw new Error("Annonce invalide");
    if (!["S","H","D","C"].includes(suit)) throw new Error("Atout invalide");
    if (st.highestBid && bidVal <= st.highestBid.value) throw new Error("Annonce trop faible");

    st.highestBid = { value: bidVal, trump: suit, bidderSid: socket.id, team: teamOf(socket.id) };
    st.passesInRow = 0;
    st.messages.push(`🗣️ ${nameOf(room, socket.id)} annonce ${bidVal}${suit}.`);
  }

  st.biddingIndex = (st.biddingIndex + 1) % 4;

  if (st.highestBid && st.passesInRow >= 3) {
    lockContract(io, id);
    return;
  }

  sendRoomState(io, id);
}

function endHandAndScore(io, roomId) {
  const room = rooms[roomId];
  const st = room.state;
  const c = st.contract;
  if (!c) return;

  const bonusNS = st.belote.NS ? 20 : 0;
  const bonusEW = st.belote.EW ? 20 : 0;

  const bidderTeam = c.team;
  const defTeam = bidderTeam === "NS" ? "EW" : "NS";
  const mult = c.multiplier;

  const bidderPoints = st.pointsWon[bidderTeam] + (bidderTeam === "NS" ? bonusNS : bonusEW);
  const success = bidderPoints >= c.value;

  if (success) st.messages.push(`✅ Contrat réussi par ${bidderTeam}.`);
  else st.messages.push(`❌ Contrat chuté. Défense (${defTeam}) marque.`);

  if (success) {
    if (bidderTeam === "NS") st.scores.NS += c.value * mult + bonusNS;
    else st.scores.EW += c.value * mult + bonusEW;
  } else {
    // version simple: défense prend tout (162 + belote éventuelle)
    const defPts = 162 + (defTeam === "NS" ? bonusNS : bonusEW);
    if (defTeam === "NS") st.scores.NS += defPts;
    else st.scores.EW += defPts;
  }

  st.phase = "done";
  st.messages.push(`📊 Score total: NS ${st.scores.NS} — EW ${st.scores.EW}`);
  sendRoomState(io, roomId);
}

function onPlayCard(io, socket, { roomId, card }) {
  const id = String(roomId || "").toUpperCase().trim();
  const room = rooms[id];
  if (!room || !room.state) throw new Error("Room invalid");

  const st = room.state;
  if (st.phase !== "playing") throw new Error("Pas en phase jeu");
  if (st.currentPlayerSid !== socket.id) throw new Error("Pas ton tour");

  const hand = st.hands[socket.id] ?? [];
  const idx = hand.findIndex((c) => c.rank === card.rank && c.suit === card.suit);
  if (idx < 0) throw new Error("Carte pas dans ta main");

  const teamOf = teamOfFactory(room);

  const legal = legalMoves(
    { order: room.order, hands: st.hands, trick: st.trick, leadSuit: st.leadSuit, contract: st.contract, teamOf },
    socket.id
  );
  const ok = legal.some((c) => c.rank === card.rank && c.suit === card.suit);
  if (!ok) throw new Error("Carte illégale (fournir/couper/monter)");

  const played = hand.splice(idx, 1)[0];

  if (st.trick.length === 0) st.leadSuit = played.suit;

  // Belote / Rebelote
  const trumpSuit = st.contract.trump;
  const team = teamOf(socket.id);
  if (played.suit === trumpSuit && (played.rank === "Q" || played.rank === "K")) {
    st.beloteSeen[team][played.rank] = true;
    if (st.beloteSeen[team].Q && st.beloteSeen[team].K && !st.belote[team]) {
      st.belote[team] = true;
      st.messages.push(`✨ Belote/Rebelote pour ${team} !`);
    }
  }

  st.messages.push(`🂠 ${nameOf(room, socket.id)} joue ${played.rank}${played.suit}.`);
  st.trick.push({ sid: socket.id, card: played });

  if (st.trick.length < 4) {
    const curIndex = room.order.indexOf(socket.id);
    st.currentPlayerSid = room.order[(curIndex + 1) % 4];
    return sendRoomState(io, id);
  }

  // Pli terminé
  const win = trickWinner(st.trick, st.leadSuit, trumpSuit);
  const winTeam = teamOf(win.sid);

  let pts = 0;
  for (const p of st.trick) pts += cardPoints(p.card, trumpSuit);
  if (st.trickNumber === 7) pts += 10;

  st.pointsWon[winTeam] += pts;
  st.tricksWon[winTeam] += 1;

  st.lastTrick = {
    trickNo: st.trickNumber + 1,
    cards: st.trick.map(t => ({ sid: t.sid, card: t.card })),
    winnerSid: win.sid,
    winnerTeam: winTeam,
    points: pts
  };

  st.messages.push(`🏁 Pli gagné par ${nameOf(room, win.sid)} (${winTeam}) +${pts} pts`);

  st.trick = [];
  st.leadSuit = null;
  st.trickNumber += 1;
  st.currentPlayerSid = win.sid;

  const cardsLeft = room.order.reduce((sum, sid) => sum + (st.hands[sid]?.length ?? 0), 0);
  if (cardsLeft === 0) return endHandAndScore(io, id);

  sendRoomState(io, id);
}

function onNewDeal(io, socket, { roomId }) {
  const id = String(roomId || "").toUpperCase().trim();
  const room = rooms[id];
  if (!room || !room.state) throw new Error("Room invalid");
  if (room.host !== socket.id) throw new Error("Seul l’hôte peut relancer");

  room.state.dealerIndex = (room.state.dealerIndex + 1) % 4;
  newDeal(io, id);
}

module.exports = {
  initRoomState,
  roomStateSnapshot,
  sendRoomState,
  onBid,
  onPlayCard,
  onNewDeal
};
