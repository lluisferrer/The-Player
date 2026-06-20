// Descodificació d'àudio a Rust (symphonia) + resampling lineal, per al render
// natiu de cues pel motor ASIO. Només es compila amb la feature `asio`.
//
// Estratègia (primer pas): descodifiquem el fitxer SENCER a memòria (PCM f32
// planar, un Vec per canal) i el resamplegem de la freqüència del fitxer a la
// del driver. La majoria de cues són curts; el streaming de fitxers molt llargs
// és una optimització posterior (es podria descodificar per blocs i alimentar la
// veu de mica en mica).
//
// Resampling: usem un resampler LINEAL simple propi (sense dependència externa).
// És suficientment bo per a cues i garanteix un build sense sorpreses d'API.
// Millora futura: `rubato` (sinc d'alta qualitat) si es detecten artefactes.

#![cfg(feature = "asio")]

use std::fs::File;
use std::path::Path;

use symphonia::core::audio::{AudioBufferRef, Signal};
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use symphonia::core::sample::Sample;

// PCM descodificat, planar (un Vec<f32> per canal) i ja a la freqüència del
// driver (després de resamplejar). `channels` és la llargada de `data`.
pub struct DecodedAudio {
    pub channels: usize,
    pub frames: usize,        // mostres per canal
    pub data: Vec<Vec<f32>>,  // data[ch][frame]
    // == driver_rate (ja resamplejat). Es guarda per claredat/diagnòstic.
    #[allow(dead_code)]
    pub sample_rate: u32,
}

// Descodifica el fitxer SENCER a PCM f32 planar i el resampleja a `driver_rate`.
pub fn decode_file(path: &str, driver_rate: u32) -> Result<DecodedAudio, String> {
    let file = File::open(Path::new(path)).map_err(|e| format!("obrir '{}': {}", path, e))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());

    // Pista d'extensió perquè el probe encerti el contenidor més de pressa.
    let mut hint = Hint::new();
    if let Some(ext) = Path::new(path).extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }

    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &FormatOptions::default(), &MetadataOptions::default())
        .map_err(|e| format!("probe del format: {}", e))?;
    let mut format = probed.format;

    // Primera pista d'àudio descodificable.
    let track = format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
        .ok_or_else(|| "El fitxer no té cap pista d'àudio descodificable.".to_string())?;
    let track_id = track.id;
    let codec_params = track.codec_params.clone();

    let mut decoder = symphonia::default::get_codecs()
        .make(&codec_params, &DecoderOptions::default())
        .map_err(|e| format!("crear el descodificador: {}", e))?;

    let mut src_rate: u32 = codec_params.sample_rate.unwrap_or(0);
    let mut channels: usize = codec_params
        .channels
        .map(|c| c.count())
        .unwrap_or(0);
    let mut planar: Vec<Vec<f32>> = Vec::new();

    // Bucle de descodificació: acumulem cada paquet al buffer planar.
    loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            // Final del flux (o error d'I/O recuperable que tractem com a fi).
            Err(symphonia::core::errors::Error::IoError(ref e))
                if e.kind() == std::io::ErrorKind::UnexpectedEof =>
            {
                break;
            }
            Err(symphonia::core::errors::Error::ResetRequired) => {
                // Canvi de paràmetres a mig flux: per simplicitat, tallem aquí.
                break;
            }
            Err(e) => return Err(format!("llegir paquet: {}", e)),
        };
        if packet.track_id() != track_id {
            continue;
        }
        match decoder.decode(&packet) {
            Ok(decoded) => {
                // Inicialitza canals/rate a partir del primer buffer si calia.
                if channels == 0 {
                    channels = decoded.spec().channels.count();
                }
                if src_rate == 0 {
                    src_rate = decoded.spec().rate;
                }
                if planar.is_empty() {
                    planar = vec![Vec::new(); channels.max(1)];
                }
                append_planar(&decoded, &mut planar, channels);
            }
            // Errors de descodificació puntuals: els saltem (paquet corromput).
            Err(symphonia::core::errors::Error::DecodeError(_)) => continue,
            Err(e) => return Err(format!("descodificar: {}", e)),
        }
    }

    if channels == 0 || planar.is_empty() {
        return Err("No s'ha pogut descodificar cap mostra del fitxer.".into());
    }
    if src_rate == 0 {
        src_rate = driver_rate; // fallback prudent: evita divisió per zero
    }

    // Resampleja cada canal de src_rate → driver_rate (lineal) si difereixen.
    let data: Vec<Vec<f32>> = if src_rate == driver_rate {
        planar
    } else {
        planar
            .into_iter()
            .map(|ch| resample_linear(&ch, src_rate, driver_rate))
            .collect()
    };

    let frames = data.iter().map(|c| c.len()).max().unwrap_or(0);
    Ok(DecodedAudio {
        channels: data.len(),
        frames,
        data,
        sample_rate: driver_rate,
    })
}

// Afegeix el contingut d'un AudioBufferRef (qualsevol tipus de mostra) al buffer
// planar f32, normalitzant a [-1, 1]. Cada variant es converteix amb el trait
// Sample de symphonia (i32/u8/etc → f32).
fn append_planar(decoded: &AudioBufferRef, planar: &mut [Vec<f32>], channels: usize) {
    macro_rules! copy_buf {
        ($buf:expr) => {{
            let b = $buf;
            let chs = b.spec().channels.count().min(channels);
            for ch in 0..chs {
                let src = b.chan(ch);
                let dst = &mut planar[ch];
                dst.reserve(src.len());
                for &s in src {
                    dst.push(to_f32_sample(s));
                }
            }
        }};
    }
    match decoded {
        AudioBufferRef::U8(b) => copy_buf!(b),
        AudioBufferRef::U16(b) => copy_buf!(b),
        AudioBufferRef::U24(b) => copy_buf!(b),
        AudioBufferRef::U32(b) => copy_buf!(b),
        AudioBufferRef::S8(b) => copy_buf!(b),
        AudioBufferRef::S16(b) => copy_buf!(b),
        AudioBufferRef::S24(b) => copy_buf!(b),
        AudioBufferRef::S32(b) => copy_buf!(b),
        AudioBufferRef::F32(b) => copy_buf!(b),
        AudioBufferRef::F64(b) => copy_buf!(b),
    }
}

// Converteix qualsevol mostra de symphonia a f32 normalitzat [-1, 1] passant per
// la representació f32 canònica que ofereix el trait Sample.
fn to_f32_sample<S: Sample>(s: S) -> f32
where
    f32: symphonia::core::conv::FromSample<S>,
{
    use symphonia::core::conv::FromSample;
    f32::from_sample(s)
}

// Resampler LINEAL d'un sol canal: interpola entre mostres veïnes. Qualitat
// modesta però sense aliasing greu per a ratios propers (44.1k↔48k). Suficient
// per al primer pas; substituïble per rubato si cal més qualitat.
fn resample_linear(input: &[f32], src_rate: u32, dst_rate: u32) -> Vec<f32> {
    if input.is_empty() || src_rate == 0 || dst_rate == 0 || src_rate == dst_rate {
        return input.to_vec();
    }
    let ratio = dst_rate as f64 / src_rate as f64;
    let out_len = ((input.len() as f64) * ratio).round() as usize;
    let mut out = Vec::with_capacity(out_len);
    let step = src_rate as f64 / dst_rate as f64; // posició al input per cada mostra de sortida
    let n = input.len();
    for i in 0..out_len {
        let pos = i as f64 * step;
        let idx = pos.floor() as usize;
        let frac = (pos - idx as f64) as f32;
        let a = input[idx.min(n - 1)];
        let b = input[(idx + 1).min(n - 1)];
        out.push(a + (b - a) * frac);
    }
    out
}
