// public/js/render.js
(function () {
  const gameRoot = document.getElementById("gameRoot");

  let currentRoomId = null;
  let lastSnap = null;

  let myHand = [];
  let myLegal = new Set();
  let myTurn = false;
  let myPhase = "waiting";

  // ---------- helpers ----------
  const esc = window.escapeHtml || function (str) {
    return String(str)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  };

  const suitSym = window.suitEmoji || ((s) => (s === "S" ? "♠" : s === "H" ? "♥" : s === "D" ? "♦" : "♣"));
  const isRed = window.isRedSuit || ((s) => s === "H" || s === "D");
  const keyOf = window.keyOf || ((c) => `${c.rank}${c.suit}`);

  function myIndex(snap) {
    return (snap?.players || []).findIndex(p => p.sid === window.socket.id);
  }
  function relPos(viewIdx, otherIdx) { return (otherIdx - viewIdx + 4) % 4; }
  function posName(rel) { return rel === 0 ? "bottom" : rel === 1 ? "left" : rel === 2 ? "top" : "right"; }
  function nameOfSid(snap, sid) {
    return (snap?.players || []).find(p => p.sid === sid)?.name || "Joueur";
  }

  function resolveBidderName(snap, bidObj) {
  if (!bidObj) return "—";
  // 1) si le serveur envoie directement un nom
  if (bidObj.name) return bidObj.name;
  if (bidObj.playerName) return bidObj.playerName;

  // 2) si le serveur envoie un sid (recommandé)
  const sid = bidObj.sid || bidObj.takerSid || bidObj.playerSid;
  if (sid) {
    const p = (snap?.players || []).find(x => x.sid === sid);
    if (p?.name) return p.name;
  }

  // 3) fallback propre (au lieu de "Joueur")
  return "—";
  }


  function teamsLabel(snap) {
    // équipes fixes : joueurs index 0/2 vs 1/3
    const ps = snap.players || [];
    const a = ps[0]?.name || "—";
    const c = ps[2]?.name || "—";
    const b = ps[1]?.name || "—";
    const d = ps[3]?.name || "—";
    return { AC: `${a} / ${c}`, BD: `${b} / ${d}` };
  }

  // ---------- tri main (belote) ----------
  // Ordres “force” belote :
  // Atout : J > 9 > A > 10 > K > Q > 8 > 7
  // Non-atout : A > 10 > K > Q > J > 9 > 8 > 7
  const TRUMP_ORDER = ["J","9","A","10","K","Q","8","7"];
  const PLAIN_ORDER = ["A","10","K","Q","J","9","8","7"];

  function rankScore(rank, isTrump) {
    const arr = isTrump ? TRUMP_ORDER : PLAIN_ORDER;
    const idx = arr.indexOf(rank);
    return idx >= 0 ? (100 - idx) : 0;
  }

  // ordre couleurs pour affichage (tu peux changer si tu veux)
  // on met l’atout en premier si connu
  const BASE_SUIT_ORDER = ["H","D","S","C"];

  function suitIndex(suit, trump) {
    if (trump && suit === trump) return -1; // trump en premier
    const idx = BASE_SUIT_ORDER.indexOf(suit);
    return idx >= 0 ? idx : 99;
  }

  function sortHand(hand, trump) {
    const arr = [...hand];
    arr.sort((a, b) => {
      const sa = suitIndex(a.suit, trump);
      const sb = suitIndex(b.suit, trump);
      if (sa !== sb) return sa - sb;

      const ta = (trump && a.suit === trump);
      const tb = (trump && b.suit === trump);
      // même couleur donc ta==tb
      const ra = rankScore(a.rank, ta);
      const rb = rankScore(b.rank, tb);
      return rb - ra; // du plus fort au plus faible
    });
    return arr;
  }

  // ---------- UI ----------
  function cardHtml(rank, suit, small = false, clickable = false, disabled = false, onClick = "") {
    const red = isRed(suit) ? "red" : "";
    const size = small ? "small" : "";
    const cl = disabled ? "disabled" : clickable ? "clickable" : "";
    const sym = suitSym(suit);

    return `
      <div class="cardUI ${red} ${size} ${cl}" ${onClick}>
        <div class="corner tl">
          <div class="rk">${esc(rank)}</div>
          <div class="cs">${sym}</div>
        </div>

        <div class="centerPip">${sym}</div>

        <div class="corner br">
          <div class="rk">${esc(rank)}</div>
          <div class="cs">${sym}</div>
        </div>
      </div>
    `;
  }




  function mountUI() {
    if (!gameRoot) return;
    if (gameRoot.dataset.mounted === "1") return;
    gameRoot.dataset.mounted = "1";

    gameRoot.innerHTML = `
      <style>
        .tableScreen{
          width:100%;
          height: calc(100vh - 160px);
          min-height: 620px;
          display:flex;
          justify-content:center;
          align-items:center;
        }
        .felt{
          position:relative;
          width: min(1200px, 98vw);
          height: min(820px, calc(100vh - 170px));
          background: rgba(0,0,0,0.14);
          border-radius: 22px;
          box-shadow: inset 0 0 0 2px rgba(255,255,255,0.06);
          overflow:hidden;
        }

        /* top bar : points + annonce */
        .topRow{
          position:absolute;
          left:14px; right:14px; top:14px;
          display:flex;
          gap:10px;
          align-items:stretch;
        }
        .box{
          background: rgba(0,0,0,0.16);
          border-radius: 16px;
          padding: 10px 12px;
          min-height: 88px;
        }
        .pointsBox{ flex: 1.2; min-width: 520px; }
        .announceBox{ flex: 0.8; text-align:center; display:flex; flex-direction:column; justify-content:center; }
        .title{ font-weight:900; margin-bottom:6px; }
        .big{ font-weight:900; font-size:18px; }
        .small{ font-size:13px; opacity:0.9; margin-top:2px; }
        .muted{ opacity:0.85; }

        /* belote toast */
        .toast{
          position:absolute;
          top:120px;
          left:50%;
          transform:translateX(-50%);
          padding:10px 14px;
          background: rgba(255,255,255,0.12);
          border-radius: 16px;
          font-weight: 900;
          display:none;
          box-shadow: 0 10px 22px rgba(0,0,0,0.18);
        }

        /* seats */
        .seat{
          position:absolute;
          min-width: 240px;
          padding: 10px 12px;
          border-radius: 16px;
          background: rgba(255,255,255,0.10);
          display:flex;
          justify-content:space-between;
          align-items:center;
          gap:10px;
          user-select:none;
        }
        .seat .name{ font-weight:900; }
        .seat .tag{ opacity:0.85; font-weight:800; }

        .seat.top{ top:140px; left:50%; transform:translateX(-50%); }
        
        .seat.bottom{
          bottom:200px;
          left:50%;
          transform:translateX(-50%);
          z-index:10;
        }
        .seat.left{ left:14px; top:50%; transform:translateY(-50%); }
        .seat.right{ right:14px; top:50%; transform:translateY(-50%); }

        /* center trick: no slots, just positioned cards */
        .center{
          position:absolute;
          left:50%;
          top:54%;
          transform:translate(-50%,-50%);
          width: 560px;
          height: 360px;
        }

        .played{
          position:absolute;
          display:flex;
          flex-direction:column;
          align-items:center;
          gap:6px;
        }
        .played.top{ top:0; left:50%; transform:translateX(-50%); }
        .played.bottom{ bottom:0; left:50%; transform:translateX(-50%); }
        .played.left{ left:0; top:50%; transform:translateY(-50%); }
        .played.right{ right:0; top:50%; transform:translateY(-50%); }

        .who{ font-size:12px; opacity:0.9; font-weight:800; }

        .cardUI{
          width: 104px;
          height: 148px;
          border-radius: 18px;
          background: linear-gradient(180deg, #ffffff, #f4f4f4);
          color:#111;
          position: relative;
          display:flex;
          align-items:center;
          justify-content:center;
          font-weight:900;
          border:2px solid rgba(0,0,0,0.10);
          box-shadow: 0 10px 22px rgba(0,0,0,0.28);
          overflow:hidden;
        }

        .hand .cardUI{ width:112px; height:160px; }

        .cardUI::after{
          content:"";
          position:absolute;
          inset:8px;
          border-radius: 14px;
          box-shadow: inset 0 0 0 1px rgba(0,0,0,0.10);
          pointer-events:none;
          opacity:0.9;
        }

        .cardUI.red{ color:#b00020; }

        .cardUI.small{
          width:58px;
          height:82px;
          border-radius: 12px;
          box-shadow: none;
        }
        .cardUI.small::after{ inset:6px; border-radius:10px; }

        .cardUI.disabled{ opacity:0.35; filter:grayscale(0.6); cursor:not-allowed; }
        .cardUI.clickable{ cursor:pointer; }
        .cardUI.clickable:hover{ transform: translateY(-2px); }
        .cardUI.clickable:active{ transform: translateY(0px); }

        .corner{
          position:absolute;
          display:flex;
          flex-direction:column;
          align-items:center;
          gap:2px;
          font-size:16px;
          line-height:1;
          opacity:0.95;
        }
        .corner .rk{ font-size:16px; font-weight:900; }
        .corner .cs{ font-size:18px; font-weight:900; }
        .corner .cs{ font-size:18px; }
        .corner.tl{ left:10px; top:10px; }
        .corner.br{
          right:10px; bottom:10px;
          transform: rotate(180deg);
        }

        .centerPip{
          font-size:54px;
          opacity:0.95;
        }

        .centerFace{
          display:flex;
          flex-direction:column;
          align-items:center;
          justify-content:center;
          gap:6px;
        }
        .centerFace .faceLetter{
          font-size:44px;
          letter-spacing: 1px;
        }
        .centerFace .faceSuit{
          font-size:44px;
          opacity:0.95;
        }

        /* version small */
        .cardUI.small .corner{ font-size:10px; }
        .cardUI.small .corner .cs{ font-size:11px; }
        .cardUI.small .centerPip{ font-size:28px; }
        .cardUI.small .centerFace .faceLetter{ font-size:22px; }
        .cardUI.small .centerFace .faceSuit{ font-size:22px; }

        /* last trick (top-left small) */
        .lastTrick{
          position:absolute;
          left:14px;
          top:120px;
          width: 360px;
          min-height: 96px;
          padding: 10px 12px;
          border-radius: 16px;
          background: rgba(0,0,0,0.16);
        }
        .ltRow{ display:flex; gap:8px; flex-wrap:wrap; align-items:flex-start; margin-top:6px; }

        /* bidding in middle */
        .biddingMid{
          position:absolute;
          left:50%;
          top:52%;
          transform:translate(-50%,-50%);
          padding:12px 14px;
          border-radius: 18px;
          background: rgba(0,0,0,0.20);
          box-shadow: 0 10px 22px rgba(0,0,0,0.18);
          display:none;
          z-index: 5;
          text-align:center;
          min-width: 420px;
        }
        .bidControls{
          display:flex;
          gap:8px;
          flex-wrap:wrap;
          justify-content:center;
          align-items:center;
          margin-top:8px;
        }
        
        .suitBtn{
          width:52px;
          height:52px;
          border-radius:14px;

          background:#fff;
          border:2px solid rgba(0,0,0,0.15);

          font-size:26px;
          font-weight:900;

          cursor:pointer;
          display:flex;
          align-items:center;
          justify-content:center;

          transition: transform 0.08s ease, box-shadow 0.08s ease;
        }

        .suitBtn:hover{
          transform: translateY(-2px);
          box-shadow: 0 6px 14px rgba(0,0,0,0.25);
        }

        .suitBtn[data-suit="H"],
        .suitBtn[data-suit="D"]{
          color:#b00020;
        }

        .suitBtn[data-suit="S"],
        .suitBtn[data-suit="C"]{
          color:#111;
        }

        .suitBtn:disabled{
          background:#fff;
          opacity:0.45;
          border:2px solid rgba(0,0,0,0.10);
        }

        /* hand bottom */
        .hand{
          position:absolute;
          left:14px;
          right:14px;
          bottom:14px;
          z-index:20;                 /* ✅ au-dessus de tout */
          display:flex;
          flex-direction:column;
          gap:12px;
          padding: 14px 16px 18px;
          border-radius: 20px;
          background: rgba(0,0,0,0.14);
        }

        .handTitle{
          font-weight:900;
          text-align:center;
          font-size:16px;
          line-height:1;

          display:inline-block;
          align-self:center;
          padding:6px 12px;
          border-radius:14px;
          background: rgba(0,0,0,0.25);
        }

        .handRow{
          display:flex;
          gap:12px;
          justify-content:center;
          align-items:flex-end;
          flex-wrap: nowrap;
          overflow-x: auto;
          padding-bottom: 6px;
        }
        .handRow::-webkit-scrollbar{ height:8px; }


      </style>

      <div class="tableScreen">
        <div class="felt">

          <div class="topRow">
            <div class="box pointsBox">
              <div class="title">Points</div>
              <div id="pointsBox" class="muted">—</div>
            </div>

            <div class="box announceBox">
              <div class="title">Annonce</div>
              <div id="announceBox" class="muted">Aucune annonce.</div>
            </div>
          </div>

          <div id="toast" class="toast"></div>

          <div class="lastTrick">
            <div class="title">Dernier pli</div>
            <div id="lastTrickBox" class="muted">Aucun pli terminé.</div>
          </div>

          <div id="seatTop" class="seat top"><span class="name">—</span><span class="tag">—</span></div>
          <div id="seatLeft" class="seat left"><span class="name">—</span><span class="tag">—</span></div>
          <div id="seatRight" class="seat right"><span class="name">—</span><span class="tag">—</span></div>
          <div id="seatBottom" class="seat bottom"><span class="name">—</span><span class="tag">—</span></div>

          <div class="center">
            <div id="playedTop" class="played top"></div>
            <div id="playedLeft" class="played left"></div>
            <div id="playedRight" class="played right"></div>
            <div id="playedBottom" class="played bottom"></div>
          </div>

          <div id="biddingMid" class="biddingMid">
            <div class="big">Enchères</div>
            <div class="small" id="bidHint">—</div>
            <div class="bidControls">
              <button id="passBtn">Passer</button>
              <button id="coincheBtn">Coinche</button>
              <button id="surcoincheBtn">Surcoinche</button>

              <select id="bidValue">
                <option>80</option><option>90</option><option>100</option><option>110</option>
                <option>120</option><option>130</option><option>140</option><option>150</option>
                <option>160</option>
              </select>

              <button id="capotBtn" title="Annonce CAPOT (obligation 8 plis)">Capot</button>

              <button class="suitBtn" data-suit="S">♠</button>
              <button class="suitBtn" data-suit="H">♥</button>
              <button class="suitBtn" data-suit="D">♦</button>
              <button class="suitBtn" data-suit="C">♣</button>
            </div>
            <div class="small">Annonce: choisis une couleur (ou Capot + couleur).</div>
          </div>

          <div class="hand">
            <div id="handRow" class="handRow"></div>
          </div>

        </div>
      </div>
    `;

    document.getElementById("passBtn").addEventListener("click", () => {
      if (!currentRoomId) return;
      window.socket.emit("bid", { roomId: currentRoomId, action: "pass" });
    });

    document.getElementById("coincheBtn").addEventListener("click", () => {
      if (!currentRoomId) return;
      window.socket.emit("bid", { roomId: currentRoomId, action: "coinche" });
    });

    document.getElementById("surcoincheBtn").addEventListener("click", () => {
      if (!currentRoomId) return;
      window.socket.emit("bid", { roomId: currentRoomId, action: "surcoinche" });
    });

    // --- CAPOT flow ---
    // on clique "Capot" => on passe en mode "capot armé", puis on clique une couleur
    let capotArmed = false;

    const capotBtn = document.getElementById("capotBtn");
    capotBtn.addEventListener("click", () => {
      capotArmed = !capotArmed;
      capotBtn.style.opacity = capotArmed ? "1" : "0.75";
      capotBtn.style.outline = capotArmed ? "2px solid rgba(255,255,255,0.6)" : "none";
    });


    document.querySelectorAll(".suitBtn").forEach(btn => {
      btn.addEventListener("click", () => {
        if (!currentRoomId) return;
      
        const trump = btn.dataset.suit;
      
        // Si Capot est armé => on envoie action="capot"
        if (capotArmed) {
          window.socket.emit("bid", { roomId: currentRoomId, action: "capot", trump });
          capotArmed = false;
          capotBtn.style.opacity = "0.75";
          capotBtn.style.outline = "none";
          return;
        }
      
        // sinon annonce normale
        const bidVal = Number(document.getElementById("bidValue").value);
        window.socket.emit("bid", { roomId: currentRoomId, action: "take", value: bidVal, trump });
      });
    });


    window.playCard = (rank, suit) => {
      if (!currentRoomId) return;
      window.socket.emit("playCard", { roomId: currentRoomId, card: { rank, suit } });
    };
  }

  // ---------- render parts ----------
  function renderSeats(snap, st) {
    const ps = snap.players || [];
    const vIdx = myIndex(snap);
    if (vIdx < 0) return;

    const map = {};
    for (let i = 0; i < ps.length; i++) {
      map[posName(relPos(vIdx, i))] = ps[i];
    }

    const t = teamsLabel(snap);
    const teamOfIndex = (i) => (i % 2 === 0 ? t.AC : t.BD);

    function setSeat(id, p) {
      const el = document.getElementById(id);
      if (!el) return;

      const nameEl = el.querySelector(".name");
      const tagEl  = el.querySelector(".tag");

      nameEl.textContent = p ? p.name : "—";

      let badges = [];

      // ▶ joueur qui doit jouer
      if (p && st?.currentPlayerSid && p.sid === st.currentPlayerSid) {
        badges.push("▶");
      }
    
      // preneur + atout
      const takerSid = st?.contract?.takerSid || st?.highestBid?.sid;
      const trump = st?.contract?.trump || st?.highestBid?.trump;
      const val = st?.contract?.value || st?.highestBid?.value;
    
      if (p && takerSid && p.sid === takerSid && trump) {
        badges.push(`Preneur ${val}${suitSym(trump)}`);
      }
    
      // coinche / surcoinche
      if (st?.coinche === 1) badges.push("COINCHE");
      if (st?.coinche === 2) badges.push("SURCOINCHE");
    
      tagEl.textContent = badges.join("  •  ");
    }


    const idxBottom = ps.findIndex(p => p.sid === map.bottom?.sid);
    const idxLeft = ps.findIndex(p => p.sid === map.left?.sid);
    const idxTop = ps.findIndex(p => p.sid === map.top?.sid);
    const idxRight = ps.findIndex(p => p.sid === map.right?.sid);

    setSeat("seatBottom", map.bottom);
    setSeat("seatLeft", map.left);
    setSeat("seatTop", map.top);
    setSeat("seatRight", map.right);
  }

  function renderPoints(st, snap) {
    const pointsBox = document.getElementById("pointsBox");
    if (!pointsBox) return;

    const t = teamsLabel(snap);

    // global score (partie)
    const globalLine = `${t.AC} : ${st.scores.NS}  —  ${t.BD} : ${st.scores.EW}`;
    // score du tour en cours (donne)
    const handLine = `Tour: ${t.AC} ${st.pointsWon.NS} pts  —  ${t.BD} ${st.pointsWon.EW} pts`;

    pointsBox.innerHTML = `
      <div class="big">${esc(globalLine)}</div>
      <div class="small">${esc(handLine)}</div>
    `;
  }

  function renderAnnounce(st, snap) {
    const announceBox = document.getElementById("announceBox");
    if (!announceBox) return;
    
    const coincheTxt =
      st.coinche === 2 ? "SURCOINCHE x4" :
      st.coinche === 1 ? "COINCHE x2" :
      "";
    
    // pendant enchères : highestBid ; après : contract
    if (st.phase === "bidding") {
      if (!st.highestBid) {
        announceBox.innerHTML = `<span class="muted">Personne n’a encore annoncé.</span>`;
        return;
      }
      const who = resolveBidderName(snap, st.highestBid);
      announceBox.innerHTML = `
        <div class="big">${st.highestBid.value}${suitSym(st.highestBid.trump)}</div>
        <div class="small">par <b>${esc(who)}</b></div>
        ${coincheTxt ? `<div class="small" style="margin-top:4px;font-weight:900;">${coincheTxt}</div>` : ""}
      `;
      return;
    }
  
    if (st.contract) {
      const who = resolveBidderName(snap, st.contract);
      announceBox.innerHTML = `
        <div class="big">${st.contract.value}${suitSym(st.contract.trump)}</div>
        <div class="small">preneur : <b>${esc(who)}</b></div>
        ${coincheTxt ? `<div class="small" style="margin-top:4px;font-weight:900;">${coincheTxt}</div>` : ""}
      `;
      return;
    }
  
    announceBox.innerHTML = `<span class="muted">Aucune annonce.</span>`;
  }


  function renderBiddingMid(st, snap) {
    const mid = document.getElementById("biddingMid");
    const hint = document.getElementById("bidHint");
    if (!mid) return;

    const isBidding = st.phase === "bidding";
    mid.style.display = isBidding ? "block" : "none";
    if (!isBidding) return;

    // ✅ C’est le serveur qui nous dit à qui est le tour (et pas st.order)
    const currentSid = st.bidTurnSid;
    const canBid = (currentSid === window.socket.id);

    const who = currentSid ? nameOfSid(snap, currentSid) : "—";
    hint.textContent = canBid ? `À toi d’annoncer.` : `Au tour de ${who}.`;

    // ✅ Active/désactive correctement TOUS les boutons
    const passBtn = document.getElementById("passBtn");
    const coincheBtn = document.getElementById("coincheBtn");
    const surcoincheBtn = document.getElementById("surcoincheBtn");

    if (passBtn) passBtn.disabled = !canBid;

    // boutons couleur
    document.querySelectorAll(".suitBtn").forEach(b => b.disabled = !canBid);

    const capotBtn = document.getElementById("capotBtn");
    if (capotBtn) capotBtn.disabled = !canBid;

    // ✅ règles coinche / surcoinche côté UI (le serveur re-valide de toute façon)
    if (!canBid) {
      if (coincheBtn) coincheBtn.disabled = true;
      if (surcoincheBtn) surcoincheBtn.disabled = true;
      return;
    }

    // si c'est ton tour :
    // coinche possible seulement si une annonce existe, pas déjà coinché
    // et si tu es dans l'équipe adverse du preneur (highestBid.sid)
    const highest = st.highestBid;
    const alreadyCoinche = st.coinche !== 0;

    let canCoinche = false;
    let canSurcoinche = false;

    if (highest && !alreadyCoinche) {
      const myIdx = (snap.players || []).findIndex(p => p.sid === window.socket.id);
      const takerIdx = (snap.players || []).findIndex(p => p.sid === highest.sid);

      if (myIdx >= 0 && takerIdx >= 0) {
        const myTeam = (myIdx % 2 === 0) ? "A" : "B";
        const takerTeam = (takerIdx % 2 === 0) ? "A" : "B";
        canCoinche = (myTeam !== takerTeam);
      }
    }

    // surcoinche possible seulement après coinche (=1) et si tu es dans l'équipe du preneur
    if (highest && st.coinche === 1) {
      const myIdx = (snap.players || []).findIndex(p => p.sid === window.socket.id);
      const takerIdx = (snap.players || []).findIndex(p => p.sid === highest.sid);

      if (myIdx >= 0 && takerIdx >= 0) {
        const myTeam = (myIdx % 2 === 0) ? "A" : "B";
        const takerTeam = (takerIdx % 2 === 0) ? "A" : "B";
        canSurcoinche = (myTeam === takerTeam);
      }
    }

    if (coincheBtn) coincheBtn.disabled = !canCoinche;
    if (surcoincheBtn) surcoincheBtn.disabled = !canSurcoinche;
  }


  function renderLastTrick(st, snap) {
    const box = document.getElementById("lastTrickBox");
    if (!box) return;

    const lt = st.lastTrick;
    if (!lt) {
      box.innerHTML = `<span class="muted">Aucun pli terminé.</span>`;
      return;
    }

    box.innerHTML = `
      <div class="small">Gagnant: <b>${esc(nameOfSid(snap, lt.winnerSid))}</b> (+${lt.points})</div>
      <div class="ltRow">
        ${lt.cards.map(t => `
          <div style="text-align:center;">
            ${cardHtml(t.card.rank, t.card.suit, true)}
          </div>
        `).join("")}
      </div>
    `;
  }

  function renderCenterTrick(st, snap) {
    const vIdx = myIndex(snap);
    if (vIdx < 0) return;

    const els = {
      top: document.getElementById("playedTop"),
      left: document.getElementById("playedLeft"),
      right: document.getElementById("playedRight"),
      bottom: document.getElementById("playedBottom"),
    };
    Object.values(els).forEach(el => { if (el) el.innerHTML = ""; });

    const trick = st.trick || [];
    for (const t of trick) {
      const idx = (snap.players || []).findIndex(p => p.sid === t.sid);
      if (idx < 0) continue;

      const pos = posName(relPos(vIdx, idx));
      const el = els[pos];
      if (!el) continue;

      el.innerHTML = `
        ${cardHtml(t.card.rank, t.card.suit, false)}
        <div class="who">${esc(nameOfSid(snap, t.sid))}</div>
      `;
    }

    // highlight tour (outline seat)
    ["seatTop","seatLeft","seatRight","seatBottom"].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.outline = "none";
    });
    if (st.currentPlayerSid) {
      const curIdx = (snap.players || []).findIndex(p => p.sid === st.currentPlayerSid);
      const rel = relPos(vIdx, curIdx);
      const pos = posName(rel);
      const seatId = pos === "top" ? "seatTop" : pos === "left" ? "seatLeft" : pos === "right" ? "seatRight" : "seatBottom";
      const seatEl = document.getElementById(seatId);
      if (seatEl) seatEl.style.outline = "2px solid rgba(255,255,255,0.55)";
    }
  }

  function renderHand(st) {
    const row = document.getElementById("handRow");
    if (!row) return;

    const trump = st.contract?.trump || st.highestBid?.trump || null;
    const sorted = sortHand(myHand || [], trump);

    const canPlay = (myPhase === "playing") && myTurn && st.phase === "playing";

    if (!sorted || sorted.length === 0) {
      row.innerHTML = `<div class="muted">Main non reçue…</div>`;
      return;
    }

    row.innerHTML = sorted.map(c => {
      const k = keyOf(c);
      const legal = canPlay ? myLegal.has(k) : false;

      const onClick = legal ? `onclick="playCard('${c.rank}','${c.suit}')"` : "";
      return cardHtml(c.rank, c.suit, false, legal, !legal, onClick);
    }).join("");
  }

  // ---------- Belote / Rebelote toast ----------
  let toastTimer = null;
  let lastToastMsg = "";
  
  function maybeToastFromMessages(st) {
    const toast = document.getElementById("toast");
    if (!toast) return;
  
    const msgs = st.messages || [];
    if (msgs.length === 0) return;
  
    const last = String(msgs[msgs.length - 1] || "");
    const low = last.toLowerCase();
  
    if (!low.includes("belote") && !low.includes("rebelote")) return;
  
    if (last === lastToastMsg) return; 
    lastToastMsg = last;
  
    toast.textContent = last;
    toast.style.display = "block";
  
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.style.display = "none";
      toast.textContent = "";
    }, 3000); 
  }


  // ---------- API called by app.js ----------
  window.renderGameState = function (snap) {
    if (!snap || !snap.state) return;
    mountUI();

    currentRoomId = snap.roomId;
    lastSnap = snap;

    const st = snap.state;

    renderSeats(snap, st);
    renderPoints(st, snap);
    renderAnnounce(st, snap);
    renderBiddingMid(st, snap);
    renderLastTrick(st, snap);
    renderCenterTrick(st, snap);
    renderHand(st);

    maybeToastFromMessages(st, snap);
  };

  window.updateYourHandUI = function (payload) {
    if (!payload) return;
    if (currentRoomId && payload.roomId !== currentRoomId) return;

    myHand = payload.hand || [];
    myLegal = new Set(payload.legalKeys || []);
    myTurn = !!payload.yourTurn;
    myPhase = payload.phase || "waiting";

    if (lastSnap) window.renderGameState(lastSnap);
  };
    // ---------- GAME OVER MODAL ----------
  function showGameOverModal(payload) {
    // retire si déjà existante
    const old = document.getElementById("gameOverOverlay");
    if (old) old.remove();

    const overlay = document.createElement("div");
    overlay.id = "gameOverOverlay";
    overlay.innerHTML = `
      <style>
        #gameOverOverlay{
          position:fixed;
          inset:0;
          background:rgba(0,0,0,0.70);
          display:flex;
          align-items:center;
          justify-content:center;
          z-index:99999;
        }
        #gameOverModal{
          width:min(720px, 92vw);
          background:rgba(20,20,20,0.96);
          border-radius:22px;
          padding:18px 18px 16px;
          box-shadow:0 18px 60px rgba(0,0,0,0.55);
          color:#fff;
          position:relative;
        }
        #gameOverClose{
          position:absolute;
          top:10px;
          right:14px;
          font-size:22px;
          cursor:pointer;
          opacity:0.95;
          user-select:none;
        }
        #gameOverClose:hover{ opacity:1; }
        .goTitle{ font-size:26px; font-weight:900; margin:8px 0 6px; }
        .goSub{ opacity:0.92; margin-bottom:12px; font-size:15px; }
        .goBox{
          background:rgba(255,255,255,0.08);
          border-radius:16px;
          padding:12px 12px;
          margin-top:10px;
          font-weight:800;
        }
        .goBtn{
          margin-top:14px;
          width:100%;
          border:0;
          border-radius:16px;
          padding:12px 14px;
          font-weight:900;
          cursor:pointer;
          font-size:15px;
        }
      </style>

      <div id="gameOverModal">
        <div id="gameOverClose">✖</div>

        <div class="goTitle">🏆 Victoire !</div>
        <div class="goSub">Équipe gagnante : <b>${esc(payload?.winnerLabel || "—")}</b></div>

        <div class="goBox">
          <div style="margin-bottom:6px;">Score final</div>
          <div>
            ${esc(payload?.teams?.AC || "—")} : <b>${payload?.scores?.NS ?? "—"}</b><br>
            ${esc(payload?.teams?.BD || "—")} : <b>${payload?.scores?.EW ?? "—"}</b>
          </div>
        </div>

        <button id="gameOverRestart" class="goBtn">🔄 Fermer / Relancer</button>
      </div>
    `;

    document.body.appendChild(overlay);

    const close = () => {
      // quitte la room (si encore dedans)
      const rid = window.currentRoomId || currentRoomId;
      if (window.socket && rid) {
        window.socket.emit("leaveRoom", { roomId: rid });
      }
    
      overlay.remove();
    
      // retour menu
      if (window.showLobby) window.showLobby();
    };
    overlay.querySelector("#gameOverClose").addEventListener("click", close);
    overlay.querySelector("#gameOverRestart").addEventListener("click", close);
  }

  window.showGameOverModal = showGameOverModal;

})();
