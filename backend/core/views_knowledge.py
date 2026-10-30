"""Step 5 knowledge documents: owner uploads, assistant searches.

Owner-only, like the Teach card. Only the extracted text is stored,
never the raw file, and every row is scoped to the URL business.
"""

from django.shortcuts import get_object_or_404
from rest_framework import status
from rest_framework.exceptions import ValidationError
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .knowledge import (
    MAX_DOCUMENTS_PER_BUSINESS,
    clean_content,
    clean_title,
    extract_upload,
)
from .models import ActionLog, KnowledgeDocument
from .permissions import IsBusinessOwner


def _card(doc, include_content=False):
    card = {
        'id': doc.pk,
        'title': doc.title,
        'source_type': doc.source_type,
        'original_filename': doc.original_filename,
        'char_count': len(doc.content),
        'excerpt': ' '.join(doc.content.split())[:240],
        'created_by': doc.created_by.username if doc.created_by else None,
        'created_at': doc.created_at.isoformat(),
        'updated_at': doc.updated_at.isoformat(),
    }
    if include_content:
        card['content'] = doc.content
    return card


class KnowledgeDocumentListCreateView(APIView):
    permission_classes = [IsAuthenticated, IsBusinessOwner]

    def get(self, request, business_id):
        docs = KnowledgeDocument.objects.filter(business=request.business).select_related('created_by')
        return Response([_card(doc) for doc in docs])

    def post(self, request, business_id):
        business = request.business
        if KnowledgeDocument.objects.filter(business=business).count() >= MAX_DOCUMENTS_PER_BUSINESS:
            raise ValidationError({
                'file': f'This business already has {MAX_DOCUMENTS_PER_BUSINESS} documents. Delete one first.'
            })
        uploaded = request.FILES.get('file')
        if uploaded is not None:
            filename, source_type, content = extract_upload(uploaded)
            title = clean_title(request.data.get('title'), fallback=filename.rsplit('.', 1)[0])
            original = filename
        else:
            content = clean_content(request.data.get('content'))
            title = clean_title(request.data.get('title'))
            source_type = KnowledgeDocument.SOURCE_PASTE
            original = ''
        doc = KnowledgeDocument.objects.create(
            business=business, title=title, source_type=source_type,
            original_filename=original, content=content, created_by=request.user,
        )
        ActionLog.objects.create(
            business=business, actor=request.user, action_type='knowledge_add',
            status=ActionLog.STATUS_COMPLETED,
            summary=f'Added knowledge document "{title}" ({source_type}, {len(content)} chars).'[:500],
            record_type='KnowledgeDocument', record_ref=str(doc.pk),
        )
        return Response(_card(doc), status=status.HTTP_201_CREATED)


class KnowledgeDocumentDetailView(APIView):
    permission_classes = [IsAuthenticated, IsBusinessOwner]

    def get(self, request, business_id, document_id):
        doc = get_object_or_404(KnowledgeDocument, pk=document_id, business=request.business)
        return Response(_card(doc, include_content=True))

    def delete(self, request, business_id, document_id):
        doc = get_object_or_404(KnowledgeDocument, pk=document_id, business=request.business)
        title = doc.title
        doc.delete()
        ActionLog.objects.create(
            business=request.business, actor=request.user, action_type='knowledge_delete',
            status=ActionLog.STATUS_COMPLETED,
            summary=f'Deleted knowledge document "{title}".'[:500],
            record_type='KnowledgeDocument', record_ref=str(document_id),
        )
        return Response({'deleted': True, 'id': document_id})
