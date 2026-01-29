const SUITS = ["S", "H", "D", "C"];
const RANKS = ["7", "8", "9", "J", "Q", "K", "10", "A"];

const TRUMP_ORDER = ["J", "9", "A", "10", "K", "Q", "8", "7"];
const PLAIN_ORDER = ["A", "10", "K", "Q", "J", "9", "8", "7"];

const TRUMP_POINTS = { J: 20, "9": 14, A: 11, "10": 10, K: 4, Q: 3, "8": 0, "7": 0 };
const PLAIN_POINTS = { A: 11, "10": 10, K: 4, Q: 3, J: 2, "9": 0, "8": 0, "7": 0 };

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function makeDeck32() {
  const deck = [];
  for (const s of SUITS) for (const r of RANKS) deck.push({ suit: s, rank: r });
  return deck;
}

function cardKey(c) { return `${c.rank}${c.suit}`; }
function isTrump(card, trumpSuit) { return card.suit === trumpSuit; }

function cardPoints(card, trumpSuit) {
  return isTrump(card, trumpSuit) ? (TRUMP_POINTS[card.rank] ?? 0) : (PLAIN_POINTS[card.rank] ?? 0);
}

function beats(a, b, leadSuit, trumpSuit) {
  const aTrump = isTrump(a, trumpSuit);
  const bTrump = isTrump(b, trumpSuit);

  if (aTrump && !bTrump) return true;
  if (!aTrump && bTrump) return false;

  if (aTrump && bTrump) return TRUMP_ORDER.indexOf(a.rank) < TRUMP_ORDER.indexOf(b.rank);

  const aLead = a.suit === leadSuit;
  const bLead = b.suit === leadSuit;
  if (aLead && !bLead) return true;
  if (!aLead && bLead) return false;

  if (a.suit === b.suit) return PLAIN_ORDER.indexOf(a.rank) < PLAIN_ORDER.indexOf(b.rank);
  return false;
}

function trickWinner(trick, leadSuit, trumpSuit) {
  let win = trick[0];
  for (let i = 1; i < trick.length; i++) {
    if (beats(trick[i].card, win.card, leadSuit, trumpSuit)) win = trick[i];
  }
  return win;
}

function bestTrumpOnTable(trick, trumpSuit, leadSuit) {
  const tr = trick.filter(t => t.card.suit === trumpSuit).map(t => t.card);
  if (tr.length === 0) return null;
  let best = tr[0];
  for (let i = 1; i < tr.length; i++) if (beats(tr[i], best, leadSuit, trumpSuit)) best = tr[i];
  return best;
}

function legalMoves({ order, hands, trick, leadSuit, contract, teamOf }, sid) {
  const hand = hands[sid] ?? [];
  if (!contract || !contract.trump) return hand;

  const trumpSuit = contract.trump;

  if (trick.length === 0) return hand;

  const follow = hand.filter(c => c.suit === leadSuit);
  if (follow.length > 0) {
    // Si couleur demandée = atout -> monter si possible
    if (leadSuit === trumpSuit) {
      const best = bestTrumpOnTable(trick, trumpSuit, leadSuit);
      if (!best) return follow;
      const over = follow.filter(c => beats(c, best, leadSuit, trumpSuit));
      return over.length ? over : follow;
    }
    return follow;
  }

  // pas la couleur demandée -> couper si on peut (si adversaire mène)
  const trumps = hand.filter(c => c.suit === trumpSuit);
  if (trumps.length === 0) return hand;

  const win = trickWinner(trick, leadSuit, trumpSuit);
  const myTeam = teamOf(sid);
  const winTeam = teamOf(win.sid);
  if (myTeam === winTeam) return hand; // partenaire mène -> pas obligé de couper

  // couper + monter si possible
  const best = bestTrumpOnTable(trick, trumpSuit, leadSuit);
  if (!best) return trumps;

  const over = trumps.filter(c => beats(c, best, leadSuit, trumpSuit));
  return over.length ? over : trumps;
}

module.exports = {
  SUITS, RANKS,
  shuffle, makeDeck32,
  cardKey, cardPoints,
  beats, trickWinner,
  legalMoves
};
