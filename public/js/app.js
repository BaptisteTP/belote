// public/js/app.js
(() => {
  const socket = io();
  window.socket = socket;

  // ===== DOM (IDs EXACTS de ton index.html) =====
  const lobby = document.getElementById("lobby");
  const roomDiv = document.getElementById("room");

  const nameInput = document.getElementById("nameInput");
  const gameSelect = document.getElementById("gameSelect");

  const roomsDiv = document.getElementById("rooms");
  const createBtn = document.getElementById("createBtn");

  const roomTitle = document.getElementById("roomTitle");
  const roomSubtitle = document.getElementById("roomSubtitle");
  const leaveBtn = document.getElementById("leaveBtn");

  const preGameLobby = document.getElementById("preGameLobby");
  const inGameUI = document.getElementById("inGameUI");

  const playersList = document.getElementById("playersList");
  const waitingHint = document.getElementById("waitingHint");
  const startBtn = document.getElementById("startBtn");

  const roomError = document.getElementById("roomError");
  const lobbyError = document.getElementById("lobbyError");

  let currentRoomId = null;

  function getName() {
    return (nameInput?.value || "").trim() || "Joueur";
  }

  function showLobby() {
    lobby.style.display = "block";
    roomDiv.style.display = "none";
    currentRoomId = null;
    window.currentRoomId = null;
  }
  window.showLobby = showLobby;

  function showRoom(roomId) {
    currentRoomId = roomId;
    window.currentRoomId = roomId;
    lobby.style.display = "none";
    roomDiv.style.display = "block";

    // par défaut on montre l'attente (tant que gameState n'a pas été reçu)
    if (preGameLobby) preGameLobby.style.display = "block";
    if (inGameUI) inGameUI.style.display = "none";
  }

  // ===== ACTIONS =====
  createBtn.addEventListener("click", () => {
    lobbyError.textContent = "";
    socket.emit("createRoom", {
      name: getName(),
      game: gameSelect?.value || "coinche",
    });
  });

  leaveBtn.addEventListener("click", () => {
    if (currentRoomId) socket.emit("leaveRoom", { roomId: currentRoomId });
    currentRoomId = null;
    showLobby();
  });

  startBtn.addEventListener("click", () => {
    if (!currentRoomId) return;
    roomError.textContent = "";
    socket.emit("startGame", { roomId: currentRoomId });
  });

  // ===== SOCKET EVENTS =====

  socket.on("roomsList", (list) => {
    roomsDiv.innerHTML = (list || [])
      .map(
        (r) => `
        <button ${r.players >= 4 ? "disabled" : ""} onclick="joinRoom('${r.id}')">
          ${r.id} — ${r.game} (${r.players}/4)
        </button>
      `
      )
      .join("<br>");
  });

  // joinRoom accessible depuis HTML (onclick)
  window.joinRoom = (roomId) => {
    lobbyError.textContent = "";
    socket.emit("joinRoom", { roomId, name: getName() });
  };

  socket.on("roomJoined", (roomId) => {
    showRoom(roomId);
  });

  socket.on("gameOver", (payload) => {
    // affiche popup (render.js)
    window.showGameOverModal?.(payload);
  });

  socket.on("roomUpdate", (room) => {
    // room = { id, game, hostSid, names, started, order }
    if (!room) return;

    // si on n'a pas encore currentRoomId, on ignore
    if (!currentRoomId) return;

    // n'affiche que la room actuelle
    if (room.id !== currentRoomId) return;

    roomTitle.textContent = `Table ${room.id}`;
    roomSubtitle.textContent = `Mode : ${room.game}`;

    const players = (room.order || []).map((sid) => ({
      sid,
      name: room.names?.[sid] || "—",
      isHost: sid === room.hostSid,
    }));

    // joueurs + 👑 host
    playersList.innerHTML = players
      .map((p) => `<div>• ${p.name} ${p.isHost ? "👑" : ""}</div>`)
      .join("");

    // attente texte
    if (players.length < 4) {
      waitingHint.textContent = `En attente de 4 joueurs… (${players.length}/4)`;
    } else {
      waitingHint.textContent = `4 joueurs prêts ✅`;
    }

    // bouton lancer (host + 4 joueurs + pas déjà started)
    const isHostMe = room.hostSid === socket.id;
    startBtn.style.display =
      isHostMe && players.length === 4 && !room.started ? "inline-block" : "none";

    // IMPORTANT : si la partie n'est PAS lancée, on reste sur le lobby d'attente
    if (!room.started) {
      if (preGameLobby) preGameLobby.style.display = "block";
      if (inGameUI) inGameUI.style.display = "none";
    }
  });

  socket.on("gameState", (snap) => {
    if (!snap) return;

    // la partie vient d'être lancée -> on bascule en jeu
    showRoom(snap.roomId);

    if (preGameLobby) preGameLobby.style.display = "none";
    if (inGameUI) inGameUI.style.display = "block";

    window.renderGameState?.(snap);
  });

  socket.on("yourHand", (payload) => {
    window.updateYourHandUI?.(payload);
  });

  showLobby();
})();
