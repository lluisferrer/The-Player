// Mapa de tecles del teclat als 32 slots, seguint la disposició física QWERTY.
// Fila 1 (slots 1-8):   1 2 3 4 5 6 7 8
// Fila 2 (slots 9-16):  Q W E R T Y U I
// Fila 3 (slots 17-24): A S D F G H J K
// Fila 4 (slots 25-32): Z X C V B N M ,
export const KEY_ROWS = [
  ['1', '2', '3', '4', '5', '6', '7', '8'],
  ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i'],
  ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k'],
  ['z', 'x', 'c', 'v', 'b', 'n', 'm', ','],
];

// Tecla assignada a un slot (1-32) → string (en minúscula), o '' si fora de rang
export function keyForSlot(slotId) {
  const i = slotId - 1;
  const row = Math.floor(i / 8);
  const col = i % 8;
  return (KEY_ROWS[row] && KEY_ROWS[row][col]) || '';
}

// Slot (1-32) associat a una tecla, o null si no n'hi ha cap
export function slotForKey(key) {
  const k = (key || '').toLowerCase();
  for (let r = 0; r < KEY_ROWS.length; r++) {
    const c = KEY_ROWS[r].indexOf(k);
    if (c >= 0) return r * 8 + c + 1;
  }
  return null;
}
