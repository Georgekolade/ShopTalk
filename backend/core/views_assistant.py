"""Assistant endpoints: chat turns and prepared-action confirmation."""

from rest_framework.exceptions import ValidationError
from rest_framework.parsers import FormParser, MultiPartParser
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .ai import ProviderError
from .assistant import confirm_action, handle_message
from .permissions import HasBusinessPermission, IsBusinessMember
from .transcribe import MAX_AUDIO_BYTES, transcribe_audio


class AssistantMessageView(APIView):
    permission_classes = [IsAuthenticated, HasBusinessPermission]
    required_permission = 'assistant.use'

    def post(self, request, business_id):
        attachment_text, attachment_name = '', ''
        uploaded = request.FILES.get('file')
        if uploaded is not None:
            from .knowledge import extract_upload

            attachment_name, _source, attachment_text = extract_upload(uploaded)
        result = handle_message(
            business=request.business,
            user=request.user,
            text=request.data.get('text', ''),
            input_mode=request.data.get('input_mode', 'text'),
            conversation_id=request.data.get('conversation_id'),
            attachment_text=attachment_text,
            attachment_name=attachment_name,
        )
        return Response(result)


class AssistantTranscribeView(APIView):
    """Transcribe a mic recording the browser's own speech service
    failed to handle. Authenticated users only; no business scope is
    needed because nothing is read or written, the text just returns."""

    permission_classes = [IsAuthenticated]
    parser_classes = [MultiPartParser, FormParser]

    def post(self, request):
        uploaded = request.FILES.get('file')
        if uploaded is None:
            raise ValidationError({'file': 'An audio recording is required.'})
        if uploaded.size and uploaded.size > MAX_AUDIO_BYTES:
            raise ValidationError({'file': 'Recording is too large.'})
        try:
            text = transcribe_audio(uploaded)
        except ProviderError as exc:
            return Response(
                {
                    'error': {
                        'code': 'transcription-unavailable',
                        'message': str(exc),
                        'field': None,
                        'next_step': (
                            'Voice transcription is not available right '
                            'now. Type your request instead.'
                        ),
                    }
                },
                status=503,
            )
        return Response({'text': text})


class AssistantActionConfirmView(APIView):
    permission_classes = [IsAuthenticated, HasBusinessPermission]
    required_permission = 'assistant.use'

    def post(self, request, business_id, action_id):
        raw = request.data.get('confirm', request.data.get('confirmation', True))
        confirm = str(raw).lower() not in ('false', '0', 'no', 'n')
        result = confirm_action(
            business=request.business,
            user=request.user,
            action_id=action_id,
            confirm=confirm,
        )
        return Response(result)
