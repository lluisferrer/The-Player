// Ids de veu reservats del motor ASIO que NO són cues (els cues fan servir
// l'id del slot, 1..128). Cada espai d'ids ha de ser únic perquè el motor
// (asio_play_voice/stop_voice/telemetria) no els confongui:
//   · Cues:     1 .. 128            (id del slot)
//   · Playlist: 2_000_000 +         (PL_VOICE_BASE, a playlistAsio.js i playlistNative.js)
//   · Preview:  3_000_000 .. 3_099_999  (PREVIEW_VOICE_ID + seq rotatiu)
//
// IMPORTANT: la playlist (2M) i el preview (3M) NO es poden solapar. El preview
// suma un seq rotatiu (0..99999) a PREVIEW_VOICE_ID, així que ocupa fins a
// 3_099_999; per això la playlist es manté a la banda 2M (vegeu playlistNative.js).

export const PREVIEW_VOICE_ID = 3_000_000;
