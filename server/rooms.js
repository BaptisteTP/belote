const rooms = {};

function sanitizeName(raw) {
  const name = String(raw ?? "").trim();
  return name.length ? name.slice(0, 20) : "Joueur";
}

function ensureRoomId() {
  let code;
  do code = Math.random().toString(36).substring(2, 6).toUpperCase();
  while (rooms[code]);
  return code;
}

function publicRooms() {
  return Object.entries(rooms).map(([id, r]) => ({
    id,
    game: r.game,
    players: Object.keys(r.names).length,
    max: 4,
    started: r.started,
  }));
}

function roomMetaSnapshot(roomId) {
  const room = rooms[roomId];
  if (!room) return null;

  const players = Object.entries(room.names).map(([sid, name]) => ({
    sid,
    name,
    isHost: room.host === sid,
  }));

  return { roomId, game: room.game, host: room.host, started: room.started, players };
}

module.exports = { rooms, sanitizeName, ensureRoomId, publicRooms, roomMetaSnapshot };
