// Ids de veu reservats del motor ASIO que NO són cues (els cues fan servir
// l'id del slot, 1..128). Cada espai d'ids ha de ser únic perquè el motor
// (asio_play_voice/stop_voice/telemetria) no els confongui:
//   · Cues:     1 .. 128            (id del slot)
//   · Playlist: 2_000_000 +         (PL_VOICE_BASE, a playlistAsio.js)
//   · Preview:  3_000_000           (un sol preview alhora)

export const PREVIEW_VOICE_ID = 3_000_000;
