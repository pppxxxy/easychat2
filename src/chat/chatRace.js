export function isStaleReply(currentCharacterId, sendCharacterId) {
  return currentCharacterId !== sendCharacterId;
}