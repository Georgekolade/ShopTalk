"""Server-side speech transcription for the voice fallback.

The browser's built-in speech recognition streams audio to the browser
vendor's cloud service, which on some browsers and networks detects
speech but returns no transcript (or fails with a `network` error).
When that happens the frontend uploads its own recording here instead,
Runs entirely behind the authenticated ``/api/assistant/transcribe``
endpoint (see ``views_assistant``) -- plain Django REST framework: the
view validates, this module transcribes, the view answers. The browser
posts the mic recording it captured while listening; when that
recording is missing or too large the caller gets ``ValidationError``
so the frontend can say so. Engine failures surface as
``ProviderError`` so the view answers 503
``transcription-unavailable`` instead of leaking details.

ACTIVE ENGINE: local Vosk large model (offline, no API key, no
network round trip). The 16 kHz mono WAV is decoded with the stdlib ``wave`` module
and fed to Vosk's ``KaldiRecognizer``; the reply ``text`` is returned
as-is. Anything else is converted (mono downmix, linear resample).

DISABLED (commented out in ``transcribe_audio`` below, helpers kept):
Meta's ``/asr/transcribe`` and OpenAI-style ``/audio/transcriptions``,
which needed SHOP_TALK_AI_API_KEY and a cloud round trip per request.
To switch back, uncomment the ``META PATH`` block in
``transcribe_audio`` and set SHOP_TALK_AI_API_KEY again.
"""

import io
import json as json_lib
import os
import struct
import uuid
import wave

from rest_framework.exceptions import ValidationError

from .ai import ProviderError

MAX_AUDIO_BYTES = 25 * 1024 * 1024

VOSK_SAMPLE_RATE = 16000


VOSK_DEFAULT_MODEL = 'vosk-model-en-us-0.22'
VOSK_LEGACY_MODEL = 'vosk-model-small-en-us-0.15'
VOSK_MODEL_URL = 'https://alphacephei.com/vosk/models/vosk-model-en-us-0.22.zip'


def _model_dir():
    """Vosk model directory: ``VOSK_MODEL_PATH`` or the bundled default."""
    override = os.environ.get('VOSK_MODEL_PATH', '').strip()
    if override:
        return override
    here = os.path.dirname(os.path.abspath(__file__))
    default = os.path.join(here, 'models', VOSK_DEFAULT_MODEL)
    if os.path.isdir(default):
        return default
    legacy = os.path.join(here, 'models', VOSK_LEGACY_MODEL)
    if os.path.isdir(legacy):
        return legacy
    return default


_VOSK_MODEL = None


def _vosk_model():
    """Lazily load (and cache) the local Vosk model."""
    global _VOSK_MODEL
    if _VOSK_MODEL is None:
        try:
            from vosk import Model
        except ImportError as exc:
            raise ProviderError(
                'Voice transcription engine is not installed.'
            ) from exc
        path = _model_dir()
        if not os.path.isdir(path):
            raise ProviderError('Voice transcription model is missing.')
        _VOSK_MODEL = Model(path)
    return _VOSK_MODEL


def _resample(samples, src, dst=VOSK_SAMPLE_RATE):
    """Linear resample of a mono int16 sample list."""
    if src == dst or not samples:
        return list(samples)
    ratio = src / dst
    out = [0] * int(len(samples) / ratio)
    for i in range(len(out)):
        pos = i * ratio
        lo = int(pos)
        hi = min(lo + 1, len(samples) - 1)
        frac = pos - lo
        out[i] = int(samples[lo] * (1 - frac) + samples[hi] * frac)
    return out


def _wav_to_pcm16(data):
    """Decode a WAV upload to 16 kHz mono int16 bytes for Vosk.

    The frontend records exactly this shape (16 kHz WAV); anything
    else is downmixed/resampled, and non-WAV uploads raise
    ``ProviderError`` so the view answers 503.
    """
    try:
        with wave.open(io.BytesIO(data), 'rb') as wav:
            channels = wav.getnchannels()
            width = wav.getsampwidth()
            rate = wav.getframerate()
            frames = wav.readframes(wav.getnframes())
    except (wave.Error, EOFError) as exc:
        raise ProviderError('Recording format not supported.') from exc
    if width != 2 or not frames:
        raise ProviderError('Recording format not supported.')
    samples = list(struct.unpack('<%dh' % (len(frames) // 2), frames))
    if channels > 1:
        samples = [
            sum(samples[i:i + channels]) // channels
            for i in range(0, len(samples), channels)
        ]
    resampled = _resample(samples, rate)
    return struct.pack(
        '<%dh' % len(resampled), *resampled
    )


def _is_meta(base):
    return 'api.meta.ai' in base


def _config():
    key = os.environ.get('SHOP_TALK_AI_API_KEY', '')
    base = os.environ.get(
        'SHOP_TALK_AI_BASE_URL', 'https://api.openai.com/v1'
    ).rstrip('/')
    model = os.environ.get('SHOP_TALK_AI_TRANSCRIBE_MODEL', '')
    if not model:
        model = (
            'muse-voice-transcribe-1.0' if _is_meta(base) else 'whisper-1'
        )
    if not key:
        raise ProviderError(
            'Transcription is not configured (missing API key).'
        )
    return key, base, model


def _post_transcription(*, key, base, model, filename, content_type, data):
    """One multipart POST to the transcription endpoint. Patched in tests."""
    import json as json_lib
    import urllib.error
    import urllib.request

    boundary = f'shoptalk-{uuid.uuid4().hex}'
    body = b''.join([
        f'--{boundary}\r\n'.encode(),
        b'Content-Disposition: form-data; name="model"\r\n\r\n',
        f'{model}\r\n'.encode(),
        f'--{boundary}\r\n'.encode(),
        (
            f'Content-Disposition: form-data; name="file"; '
            f'filename="{filename}"\r\n'
        ).encode(),
        f'Content-Type: {content_type or "application/octet-stream"}\r\n\r\n'.encode(),
        data,
        b'\r\n',
        f'--{boundary}--\r\n'.encode(),
    ])
    request = urllib.request.Request(
        f'{base}/audio/transcriptions',
        data=body,
        headers={
            'Authorization': f'Bearer {key}',
            'Content-Type': f'multipart/form-data; boundary={boundary}',
        },
    )
    try:
        response = urllib.request.urlopen(request, timeout=60)
        return json_lib.loads(response.read().decode())
    except urllib.error.HTTPError as exc:
        try:
            detail = exc.read().decode()[:200]
        except Exception:
            detail = ''
        raise ProviderError(
            f'Transcription service error: HTTP {exc.code} {detail}'.strip()
        ) from exc
    except Exception as exc:
        raise ProviderError(
            f'Transcription service unreachable: {str(exc)[:200]}'
        ) from exc


def _post_meta_transcription(*, key, base, model, filename, data):
    """Meta Model API shape: POST /asr/transcribe with a `request` JSON
    part (WAV only, mono PCM 16/24 kHz) and an `audio` part. The buffered
    JSON reply carries the whole transcript in `transcript`."""
    import json as json_lib
    import urllib.error
    import urllib.request

    boundary = f'shoptalk-{uuid.uuid4().hex}'
    settings = json_lib.dumps({
        'model': model,
        'audioEncoding': 'WAV',
        'mode': 'PUSH_TO_TALK',
    })
    body = b''.join([
        f'--{boundary}\r\n'.encode(),
        b'Content-Disposition: form-data; name="request"\r\n',
        b'Content-Type: application/json\r\n\r\n',
        f'{settings}\r\n'.encode(),
        f'--{boundary}\r\n'.encode(),
        (
            f'Content-Disposition: form-data; name="audio"; '
            f'filename="{filename}"\r\n'
        ).encode(),
        b'Content-Type: audio/wav\r\n\r\n',
        data,
        b'\r\n',
        f'--{boundary}--\r\n'.encode(),
    ])
    request = urllib.request.Request(
        f'{base}/asr/transcribe',
        data=body,
        headers={
            'Authorization': f'Bearer {key}',
            'Accept': 'application/json',
            'Content-Type': f'multipart/form-data; boundary={boundary}',
        },
    )
    try:
        response = urllib.request.urlopen(request, timeout=60)
        return json_lib.loads(response.read().decode())
    except urllib.error.HTTPError as exc:
        try:
            detail = exc.read().decode()[:200]
        except Exception:
            detail = ''
        raise ProviderError(
            f'Transcription service error: HTTP {exc.code} {detail}'.strip()
        ) from exc
    except Exception as exc:
        raise ProviderError(
            f'Transcription service unreachable: {str(exc)[:200]}'
        ) from exc


def transcribe_audio(uploaded) -> str:
    """Return the transcript for an uploaded audio file (may be empty)."""
    if uploaded.size and uploaded.size > MAX_AUDIO_BYTES:
        raise ProviderError('Recording is too large to transcribe.')
    from vosk import KaldiRecognizer

    data = uploaded.read()
    pcm = _wav_to_pcm16(data)
    recognizer = KaldiRecognizer(_vosk_model(), VOSK_SAMPLE_RATE)
    for offset in range(0, len(pcm), 8000):
        recognizer.AcceptWaveform(pcm[offset:offset + 8000])
    result = json_lib.loads(recognizer.FinalResult() or '{}')
    text = result.get('text', '') if isinstance(result, dict) else ''
    return str(text).strip()
    # ---- META PATH (disabled: local Vosk is the active engine) ----
    # key, base, model = _config()
    # filename = getattr(uploaded, 'name', 'recording.wav') or 'recording.wav'
    # if _is_meta(base):
    #     payload = _post_meta_transcription(
    #         key=key, base=base, model=model, filename=filename, data=data,
    #     )
    #     text = payload.get('transcript', '') if isinstance(payload, dict) else ''
    #     return str(text).strip()
    # payload = _post_transcription(
    #     key=key,
    #     base=base,
    #     model=model,
    #     filename=filename,
    #     content_type=getattr(uploaded, 'content_type', '') or '',
    #     data=data,
    # )
    # text = payload.get('text', '') if isinstance(payload, dict) else ''
    # return str(text).strip()
