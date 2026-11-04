"""Transcription endpoint: auth, validation, local Vosk engine mapping."""

import io
import json
import math
import struct
import sys
import types
import wave

from unittest import mock

from django.contrib.auth import get_user_model
from django.core.files.uploadedfile import SimpleUploadedFile
from rest_framework.test import APITestCase

from . import transcribe as transcribe_module

User = get_user_model()


def make_wav(seconds=1, rate=16000, channels=1, freq=440.0):
    """Build a small PCM16 WAV in memory (a plain tone, not speech)."""
    count = int(seconds * rate)
    mono = [
        int(10000 * math.sin(2 * math.pi * freq * i / rate))
        for i in range(count)
    ]
    if channels == 2:
        frames = b''.join(struct.pack('<hh', s, s) for s in mono)
    else:
        frames = struct.pack('<%dh' % count, *mono)
    buf = io.BytesIO()
    with wave.open(buf, 'wb') as wav:
        wav.setnchannels(channels)
        wav.setsampwidth(2)
        wav.setframerate(rate)
        wav.writeframes(frames)
    return buf.getvalue()


class FakeRecognizer:
    """Stand-in for vosk.KaldiRecognizer: records input, replays text."""

    instances = []
    result_text = 'sell 2 garri'

    def __init__(self, model, rate):
        self.model = model
        self.rate = rate
        self.chunks = []
        FakeRecognizer.instances.append(self)

    def AcceptWaveform(self, data):
        self.chunks.append(data)
        return True

    def FinalResult(self):
        return json.dumps({'text': FakeRecognizer.result_text})


def fake_vosk_module():
    fake = types.ModuleType('vosk')
    fake.Model = lambda path: ('fake-model', path)
    fake.KaldiRecognizer = FakeRecognizer
    return fake


class TranscribeViewTests(APITestCase):
    def setUp(self):
        self.user = User.objects.create_user(
            username='owner', password='pass12345'
        )
        FakeRecognizer.instances = []
        FakeRecognizer.result_text = 'sell 2 garri'
        transcribe_module._VOSK_MODEL = None
        patcher = mock.patch.dict(
            sys.modules, {'vosk': fake_vosk_module()}
        )
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_requires_authentication(self):
        response = self.client.post(
            '/api/assistant/transcribe',
            {'file': SimpleUploadedFile(
                'recording.wav', make_wav(), content_type='audio/wav')},
            format='multipart',
        )
        self.assertEqual(response.status_code, 401)

    def test_missing_file_is_a_validation_error(self):
        self.client.force_authenticate(self.user)
        response = self.client.post('/api/assistant/transcribe', {}, format='multipart')
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.data['error']['field'], 'file')

    def test_returns_vosk_transcript(self):
        self.client.force_authenticate(self.user)
        response = self.client.post(
            '/api/assistant/transcribe',
            {'file': SimpleUploadedFile(
                'recording.wav', make_wav(), content_type='audio/wav')},
            format='multipart',
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data, {'text': 'sell 2 garri'})
        self.assertEqual(len(FakeRecognizer.instances), 1)
        recognizer = FakeRecognizer.instances[0]
        self.assertEqual(recognizer.rate, 16000)
        fed = b''.join(recognizer.chunks)
        self.assertEqual(len(fed), 16000 * 2)

    def test_resamples_other_rates_to_16k(self):
        self.client.force_authenticate(self.user)
        response = self.client.post(
            '/api/assistant/transcribe',
            {'file': SimpleUploadedFile(
                'recording.wav', make_wav(rate=8000), content_type='audio/wav')},
            format='multipart',
        )
        self.assertEqual(response.status_code, 200)
        recognizer = FakeRecognizer.instances[0]
        self.assertEqual(recognizer.rate, 16000)
        fed = b''.join(recognizer.chunks)
        self.assertEqual(len(fed), 16000 * 2)

    def test_downmixes_stereo_to_mono(self):
        self.client.force_authenticate(self.user)
        response = self.client.post(
            '/api/assistant/transcribe',
            {'file': SimpleUploadedFile(
                'recording.wav',
                make_wav(channels=2),
                content_type='audio/wav')},
            format='multipart',
        )
        self.assertEqual(response.status_code, 200)
        fed = b''.join(FakeRecognizer.instances[0].chunks)
        self.assertEqual(len(fed), 16000 * 2)

    def test_empty_transcript_returns_empty_text(self):
        FakeRecognizer.result_text = ''
        self.client.force_authenticate(self.user)
        response = self.client.post(
            '/api/assistant/transcribe',
            {'file': SimpleUploadedFile(
                'recording.wav', make_wav(), content_type='audio/wav')},
            format='multipart',
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data, {'text': ''})

    def test_non_wav_upload_is_503_with_envelope(self):
        self.client.force_authenticate(self.user)
        response = self.client.post(
            '/api/assistant/transcribe',
            {'file': SimpleUploadedFile(
                'recording.webm', b'fake-audio-bytes', content_type='audio/webm')},
            format='multipart',
        )
        self.assertEqual(response.status_code, 503)
        self.assertEqual(
            response.data['error']['code'], 'transcription-unavailable'
        )

    def test_missing_model_is_503_with_envelope(self):
        self.client.force_authenticate(self.user)
        with mock.patch.object(
            transcribe_module, '_model_dir', return_value=r'C:\no-such-model'
        ):
            response = self.client.post(
                '/api/assistant/transcribe',
                {'file': SimpleUploadedFile(
                    'recording.wav', make_wav(), content_type='audio/wav')},
                format='multipart',
            )
        self.assertEqual(response.status_code, 503)
        self.assertEqual(
            response.data['error']['code'], 'transcription-unavailable'
        )
