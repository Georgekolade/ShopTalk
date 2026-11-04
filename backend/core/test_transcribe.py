"""Transcription fallback endpoint: auth, validation, upstream mapping."""

from unittest import mock

from django.contrib.auth import get_user_model
from django.core.files.uploadedfile import SimpleUploadedFile
from rest_framework.test import APITestCase

from .ai import ProviderError

User = get_user_model()


def audio_file(name='recording.webm', data=b'fake-audio-bytes'):
    return SimpleUploadedFile(name, data, content_type='audio/webm')


class TranscribeViewTests(APITestCase):
    def setUp(self):
        self.user = User.objects.create_user(
            username='owner', password='pass12345'
        )

    def test_requires_authentication(self):
        response = self.client.post(
            '/api/assistant/transcribe', {'file': audio_file()}, format='multipart'
        )
        self.assertEqual(response.status_code, 401)

    def test_missing_file_is_a_validation_error(self):
        self.client.force_authenticate(self.user)
        response = self.client.post('/api/assistant/transcribe', {}, format='multipart')
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.data['error']['field'], 'file')

    def test_returns_upstream_transcript(self):
        self.client.force_authenticate(self.user)
        env = {
            'SHOP_TALK_AI_API_KEY': 'test-key',
            'SHOP_TALK_AI_BASE_URL': 'https://model.test/v1',
            'SHOP_TALK_AI_TRANSCRIBE_MODEL': '',
        }
        with mock.patch.dict('os.environ', env), mock.patch(
            'core.transcribe._post_transcription',
            return_value={'text': 'sell 2 garri'},
        ) as post:
            response = self.client.post(
                '/api/assistant/transcribe',
                {'file': audio_file()},
                format='multipart',
            )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data, {'text': 'sell 2 garri'})
        self.assertEqual(post.call_args.kwargs['data'], b'fake-audio-bytes')
        self.assertEqual(post.call_args.kwargs['filename'], 'recording.webm')

    def test_meta_base_uses_muse_voice_transcribe(self):
        self.client.force_authenticate(self.user)
        env = {
            'SHOP_TALK_AI_API_KEY': 'meta-key',
            'SHOP_TALK_AI_BASE_URL': 'https://api.meta.ai/v1',
            'SHOP_TALK_AI_TRANSCRIBE_MODEL': '',
        }
        with mock.patch.dict('os.environ', env):
            with mock.patch(
                'core.transcribe._post_meta_transcription',
                return_value={'transcript': 'sell 2 garri'},
            ) as post:
                response = self.client.post(
                    '/api/assistant/transcribe',
                    {'file': audio_file('recording.wav', b'wav-bytes')},
                    format='multipart',
                )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data, {'text': 'sell 2 garri'})
        self.assertEqual(
            post.call_args.kwargs['model'], 'muse-voice-transcribe-1.0'
        )
        self.assertEqual(post.call_args.kwargs['data'], b'wav-bytes')

    def test_unconfigured_transcription_is_503_with_envelope(self):
        self.client.force_authenticate(self.user)
        with mock.patch(
            'core.transcribe._post_transcription',
            side_effect=ProviderError('Transcription is not configured.'),
        ):
            with mock.patch.dict('os.environ', {'SHOP_TALK_AI_API_KEY': 'k'}):
                response = self.client.post(
                    '/api/assistant/transcribe',
                    {'file': audio_file()},
                    format='multipart',
                )
        self.assertEqual(response.status_code, 503)
        self.assertEqual(
            response.data['error']['code'], 'transcription-unavailable'
        )
