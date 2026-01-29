function escapeHtml(str) {
  return String(str)
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

function suitEmoji(s) {
  return s === "S" ? "♠" : s === "H" ? "♥" : s === "D" ? "♦" : "♣";
}
function isRedSuit(s) { return s === "H" || s === "D"; }
function keyOf(card) { return `${card.rank}${card.suit}`; }

function formatLogLine(lineEscaped) {
  return String(lineEscaped).replace(/\b(10|[7-9JQKA])([HDCS])\b/g, (m, r, s) => {
    const sym = suitEmoji(s);
    const red = (s === "H" || s === "D");
    return `<span style="font-weight:800; color:${red ? "#ff6b6b" : "#111"}">${r}${sym}</span>`;
  });
}
