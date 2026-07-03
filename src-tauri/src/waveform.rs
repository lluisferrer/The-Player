// Càlcul de forma d'ona (pics) i durada a Rust (symphonia), en STREAMING.
//
// Motivació (auditoria A5/B5): generar la forma d'ona d'un cue llarg (2-3 h)
// al WebView implicava descodificar el fitxer SENCER a un AudioBuffer (GB de
// PCM f32) → OOM probable i pics de CPU/RAM en plena sessió. Aquí ho fem en
// una sola passada, paquet a paquet, acumulant NOMÉS els pics per bucket:
// memòria O(buckets), no O(durada). I la durada es llegeix de les metadades
// del format sense descodificar res.
//
// Part del nucli reutilitzable: es compila amb la feature `native`.

#![cfg(feature = "native")]

use std::fs::File;
use std::path::Path;

use symphonia::core::audio::{AudioBufferRef, Signal};
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use symphonia::core::sample::Sample;

// Nombre de pics per bucket = 2 (min i max). El frontend (computePeaks a
// src/lib/waveformPeaks.js) espera un Float32Array de `buckets * 2` valors amb
// parells [min, max] INTERCALATS, calculats sobre el PRIMER canal (getChannelData(0)),
// amb valors a [-1, 1]. Replicem exactament aquest format i ordre.

// Obre el fitxer i retorna (format, track_id, sample_rate, n_frames).
// Reutilitza la mateixa estratègia de probe que asio_decode.rs.
fn open_format(
    path: &str,
) -> Result<
    (
        Box<dyn symphonia::core::formats::FormatReader>,
        u32,
        u32,
        Option<u64>,
    ),
    String,
> {
    let file = File::open(Path::new(path)).map_err(|e| format!("obrir '{}': {}", path, e))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());

    let mut hint = Hint::new();
    if let Some(ext) = Path::new(path).extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }

    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &FormatOptions::default(), &MetadataOptions::default())
        .map_err(|e| format!("probe del format: {}", e))?;
    let format = probed.format;

    let track = format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
        .ok_or_else(|| "El fitxer no té cap pista d'àudio descodificable.".to_string())?;
    let track_id = track.id;
    let sample_rate = track.codec_params.sample_rate.unwrap_or(0);
    let n_frames = track.codec_params.n_frames;

    Ok((format, track_id, sample_rate, n_frames))
}

// Durada en segons SENSE descodificar: n_frames / sample_rate llegits del track.
// Si el contenidor no exposa n_frames, retorna Err perquè el frontend caigui al
// mètode <audio> (símfonia no cobreix tots els contenidors amb metadata fiable).
pub fn probe_duration(path: &str) -> Result<f64, String> {
    let (_format, _track_id, sample_rate, n_frames) = open_format(path)?;
    if sample_rate == 0 {
        return Err("El track no exposa sample_rate.".into());
    }
    match n_frames {
        Some(nf) if nf > 0 => Ok(nf as f64 / sample_rate as f64),
        _ => Err("El format no exposa el nombre de frames.".into()),
    }
}

// Calcula els pics [min, max] en STREAMING sobre el primer canal.
// Retorna un Vec<f32> de `buckets * 2` valors, parells [min, max] intercalats,
// a [-1, 1]: mateix format que computePeaks() al frontend.
// `allow(unused_assignments)`: al camí B, el reset final de la macro flush_bucket
// (step/cur/fill_*/filled) no es torna a llegir després de l'últim flush residual.
#[allow(unused_assignments)]
pub fn compute_peaks(path: &str, buckets: u32) -> Result<Vec<f32>, String> {
    let buckets = buckets.max(1) as usize;

    let (mut format, track_id, sample_rate, n_frames) = open_format(path)?;

    // Codec params de la pista triada per crear el descodificador.
    let codec_params = format
        .tracks()
        .iter()
        .find(|t| t.id == track_id)
        .map(|t| t.codec_params.clone())
        .ok_or_else(|| "No s'ha trobat la pista d'àudio.".to_string())?;

    let mut decoder = symphonia::default::get_codecs()
        .make(&codec_params, &DecoderOptions::default())
        .map_err(|e| format!("crear el descodificador: {}", e))?;

    // Estimació del total de mostres (del primer canal) per repartir en buckets.
    // Si no coneixem n_frames, fem servir una estimació prudent i, si al final
    // ens quedem curts, ampliem l'últim bucket; si ens passem, sobreescriurem.
    // Per robustesa acumulem els pics amb un pas variable calculat sobre el total
    // conegut; sense total, acumulem tot al mateix ritme i re-agrupem al final.
    let total_frames: u64 = n_frames.unwrap_or(0);

    // Sortida: parells [min, max] per bucket.
    let mut out_min = vec![1.0f32; buckets];
    let mut out_max = vec![-1.0f32; buckets];
    let mut seen = vec![false; buckets];

    // Camí A: coneixem total_frames → assignació directa de cada mostra al bucket.
    if total_frames > 0 {
        let mut frame_idx: u64 = 0;
        loop {
            let packet = match format.next_packet() {
                Ok(p) => p,
                Err(symphonia::core::errors::Error::IoError(ref e))
                    if e.kind() == std::io::ErrorKind::UnexpectedEof =>
                {
                    break;
                }
                Err(symphonia::core::errors::Error::ResetRequired) => break,
                Err(e) => return Err(format!("llegir paquet: {}", e)),
            };
            if packet.track_id() != track_id {
                continue;
            }
            match decoder.decode(&packet) {
                Ok(decoded) => {
                    fold_first_channel(&decoded, |v| {
                        // Bucket segons la posició global de la mostra.
                        let bi = ((frame_idx as u128 * buckets as u128)
                            / total_frames as u128) as usize;
                        let bi = bi.min(buckets - 1);
                        if v < out_min[bi] {
                            out_min[bi] = v;
                        }
                        if v > out_max[bi] {
                            out_max[bi] = v;
                        }
                        seen[bi] = true;
                        frame_idx += 1;
                    });
                }
                Err(symphonia::core::errors::Error::DecodeError(_)) => continue,
                Err(e) => return Err(format!("descodificar: {}", e)),
            }
        }
    } else {
        // Camí B: sense total_frames. Acumulem el primer canal sencer NO és
        // acceptable (memòria O(durada)). En lloc d'això, fem servir un mètode de
        // reagrupament progressiu: comencem amb `sample_rate` com a pas provisional
        // i, quan el nombre de mostres supera buckets*factor, dupliquem el pas i
        // fusionem parells de buckets. Manté memòria O(buckets).
        let _ = sample_rate; // usat només com a llavor conceptual
        let mut step: u64 = 1; // mostres per bucket (creix per potències de 2)
        let mut count_in_bucket: u64 = 0;
        let mut cur = 0usize; // bucket d'escriptura actual
        let mut fill_min = 1.0f32;
        let mut fill_max = -1.0f32;
        let mut filled = false;

        macro_rules! flush_bucket {
            () => {{
                if filled {
                    if cur >= buckets {
                        // Hem omplert tots els buckets: dupliquem el pas i fusionem
                        // parells adjacents per fer lloc.
                        merge_pairs(&mut out_min, &mut out_max, &mut seen);
                        step *= 2;
                        cur = buckets / 2;
                    }
                    out_min[cur] = fill_min;
                    out_max[cur] = fill_max;
                    seen[cur] = true;
                    cur += 1;
                    fill_min = 1.0;
                    fill_max = -1.0;
                    filled = false;
                }
            }};
        }

        loop {
            let packet = match format.next_packet() {
                Ok(p) => p,
                Err(symphonia::core::errors::Error::IoError(ref e))
                    if e.kind() == std::io::ErrorKind::UnexpectedEof =>
                {
                    break;
                }
                Err(symphonia::core::errors::Error::ResetRequired) => break,
                Err(e) => return Err(format!("llegir paquet: {}", e)),
            };
            if packet.track_id() != track_id {
                continue;
            }
            match decoder.decode(&packet) {
                Ok(decoded) => {
                    fold_first_channel(&decoded, |v| {
                        if v < fill_min {
                            fill_min = v;
                        }
                        if v > fill_max {
                            fill_max = v;
                        }
                        filled = true;
                        count_in_bucket += 1;
                        if count_in_bucket >= step {
                            count_in_bucket = 0;
                            flush_bucket!();
                        }
                    });
                }
                Err(symphonia::core::errors::Error::DecodeError(_)) => continue,
                Err(e) => return Err(format!("descodificar: {}", e)),
            }
        }
        // Bucket residual pendent.
        flush_bucket!();
    }

    // Buckets buits (silenci o gap d'estimació) → [0, 0], com fa computePeaks
    // quan end <= start.
    let mut out = Vec::with_capacity(buckets * 2);
    for i in 0..buckets {
        if seen[i] {
            out.push(out_min[i]);
            out.push(out_max[i]);
        } else {
            out.push(0.0);
            out.push(0.0);
        }
    }
    Ok(out)
}

// Fusiona parells de buckets adjacents (0&1, 2&3, …) a la meitat inferior,
// deixant lliure la meitat superior per continuar omplint. S'usa al camí B quan
// no coneixem la durada i cal reduir la resolució a mig vol.
fn merge_pairs(out_min: &mut [f32], out_max: &mut [f32], seen: &mut [bool]) {
    let n = out_min.len();
    let half = n / 2;
    for i in 0..half {
        let a = 2 * i;
        let b = 2 * i + 1;
        let mn = out_min[a].min(out_min[b]);
        let mx = out_max[a].max(out_max[b]);
        let sn = seen[a] || seen[b];
        out_min[i] = mn;
        out_max[i] = mx;
        seen[i] = sn;
    }
    // Neteja la meitat superior perquè es torni a omplir.
    for i in half..n {
        out_min[i] = 1.0;
        out_max[i] = -1.0;
        seen[i] = false;
    }
}

// Recorre NOMÉS el primer canal d'un AudioBufferRef (qualsevol tipus de mostra),
// convertint cada mostra a f32 [-1, 1] i cridant `f` per cada valor. Coincideix
// amb computePeaks(), que llegeix únicament getChannelData(0).
fn fold_first_channel<F: FnMut(f32)>(decoded: &AudioBufferRef, mut f: F) {
    macro_rules! do_ch0 {
        ($buf:expr) => {{
            let b = $buf;
            if b.spec().channels.count() > 0 {
                for &s in b.chan(0) {
                    f(to_f32_sample(s));
                }
            }
        }};
    }
    match decoded {
        AudioBufferRef::U8(b) => do_ch0!(b),
        AudioBufferRef::U16(b) => do_ch0!(b),
        AudioBufferRef::U24(b) => do_ch0!(b),
        AudioBufferRef::U32(b) => do_ch0!(b),
        AudioBufferRef::S8(b) => do_ch0!(b),
        AudioBufferRef::S16(b) => do_ch0!(b),
        AudioBufferRef::S24(b) => do_ch0!(b),
        AudioBufferRef::S32(b) => do_ch0!(b),
        AudioBufferRef::F32(b) => do_ch0!(b),
        AudioBufferRef::F64(b) => do_ch0!(b),
    }
}

// Converteix qualsevol mostra de symphonia a f32 [-1, 1] (mateixa conversió que
// asio_decode.rs).
fn to_f32_sample<S: Sample>(s: S) -> f32
where
    f32: symphonia::core::conv::FromSample<S>,
{
    use symphonia::core::conv::FromSample;
    f32::from_sample(s)
}
