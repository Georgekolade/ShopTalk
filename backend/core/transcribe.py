"""Server-side speech transcription for the voice fallback.

The browser's built-in speech recognition streams audio to the browser
vendor's cloud service, which on some browsers and networks detects
speech but returns no transcript (or fails with a `network` error).
When that happens the frontend uploads its own recording here instead,
and this calls an OpenAI-compatible `/audio/transcriptions` endpoint
with the same key/base already configured for the assistant provider.

Configure with SHOP_TALK_AI_API_KEY and SHOP_TALK_AI_BASE_URL, plus
SHOP_TALK_AI_TRANSCRIBE_MODEL naming a model the endpoint offers.
Defaults match the configured base: Meta's API uses Muse Voice
Transcribe (`muse-voice-transcribe-1.0` at `/asr/transcribe`), other
OpenAI-compatible bases use `whisper-1` at `/audio/transcriptions`.
Without a key this raises ProviderError and the view answers 503:
voice falls back to typing, never to silence.
"""

import os
import uuid

from .ai import ProviderError

MAX_AUDIO_BYTES = 25 * 1024 * 1024


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
    key, base, model = _config()
    data = uploaded.read()
    filename = getattr(uploaded, 'name', 'recording.wav') or 'recording.wav'
    if _is_meta(base):
        payload = _post_meta_transcription(
            key=key, base=base, model=model, filename=filename, data=data,
        )
        text = payload.get('transcript', '') if isinstance(payload, dict) else ''
        return str(text).strip()
    payload = _post_transcription(
        key=key,
        base=base,
        model=model,
        filename=filename,
        content_type=getattr(uploaded, 'content_type', '') or '',
        data=data,
    )
    text = payload.get('text', '') if isinstance(payload, dict) else ''
    return str(text).strip()
