"""Assistant endpoints: chat turns and prepared-action confirmation."""

from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .assistant import confirm_action, handle_message
from .permissions import HasBusinessPermission, IsBusinessMember


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
