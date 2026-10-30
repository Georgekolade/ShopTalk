"""Registration, reference data, team, analytics, documents, history."""

from datetime import date, timedelta

from django.contrib.auth import get_user_model
from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import transaction
from django.http import HttpResponse
from django.shortcuts import get_object_or_404
from rest_framework import status
from rest_framework.authtoken.models import Token
from rest_framework.exceptions import ValidationError
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .documents import (
    ensure_invoice, ensure_receipt, invoice_payload, receipt_payload,
    render_pdf, render_receipt_pos,
)
from .models import ActionLog, BusinessMembership, Conversation, Invoice, PendingAction, Sale
from .permissions import (
    CORE_ASSIGNABLE_ROLES,
    GRANTABLE_PERMISSIONS,
    HasBusinessPermission,
    IsBusinessMember,
    IsBusinessOwner,
    effective_permissions,
)
from .services import get_analytics


def _parse_date(raw, field):
    if not raw:
        return None
    try:
        return date.fromisoformat(raw)
    except ValueError:
        raise ValidationError({field: 'Use YYYY-MM-DD.'})


class RegisterView(APIView):
    permission_classes = [AllowAny]

    def post(self, request):
        username = (request.data.get('username') or '').strip()
        password = request.data.get('password') or ''
        if not username:
            raise ValidationError({'username': 'Required.'})
        User = get_user_model()
        if User.objects.filter(username__iexact=username).exists():
            raise ValidationError({'username': 'That username is taken.'})
        try:
            validate_password(password)
        except DjangoValidationError as exc:
            raise ValidationError({'password': list(exc.messages)})
        with transaction.atomic():
            user = User.objects.create_user(username=username, password=password)
            token, _ = Token.objects.get_or_create(user=user)
        return Response(
            {'token': token.key, 'username': user.username},
            status=status.HTTP_201_CREATED,
        )


def _member_card(member):
    extras = sorted(
        (member.permissions or {}).get('extra', [])
        if isinstance((member.permissions or {}).get('extra', []), list) else []
    )
    return {
        'id': member.pk, 'username': member.user.username,
        'role': member.role, 'status': member.status,
        'extra_permissions': extras,
        'permissions': sorted(effective_permissions(member.role, extras)),
    }


def _clean_extras(raw):
    extras = raw or []
    if not isinstance(extras, list) or any(p not in GRANTABLE_PERMISSIONS for p in extras):
        raise ValidationError({'extra_permissions': 'Pick from the grantable permission list.'})
    return sorted(set(extras))


class BusinessProfileView(APIView):
    permission_classes = [IsAuthenticated, IsBusinessOwner]

    def patch(self, request, business_id):
        from .serializers import BusinessSerializer

        if isinstance(request.data.get('settings'), dict) and 'knowledge' in request.data['settings']:
            from .assistant import _clean_knowledge

            request.data['settings'] = {
                **request.data['settings'],
                'knowledge': _clean_knowledge(request.data['settings'].get('knowledge')),
            }
        serializer = BusinessSerializer(request.business, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        serializer.save()
        ActionLog.objects.create(
            business=request.business, actor=request.user, action_type='business_update',
            status=ActionLog.STATUS_COMPLETED, summary='Business profile updated.',
            record_type='Business', record_ref=str(request.business.pk),
        )
        return Response(serializer.data)


class TeamListCreateView(APIView):
    permission_classes = [IsAuthenticated, IsBusinessOwner]

    def get(self, request, business_id):
        members = (
            BusinessMembership.objects.filter(business=request.business)
            .select_related('user').order_by('user__username')
        )
        return Response([_member_card(m) for m in members])

    def post(self, request, business_id):
        username = (request.data.get('username') or '').strip()
        password = request.data.get('password') or ''
        role = request.data.get('role') or 'sales'
        if role not in CORE_ASSIGNABLE_ROLES:
            raise ValidationError({'role': 'Pick manager, sales, or inventory. Ownership cannot be granted here.'})
        if not username:
            raise ValidationError({'username': 'Required.'})
        extras = _clean_extras(request.data.get('extra_permissions'))
        User = get_user_model()
        created = False
        with transaction.atomic():
            user = User.objects.filter(username__iexact=username).first()
            if user is None:
                if not password:
                    raise ValidationError({'password': 'Required for a new user.'})
                try:
                    validate_password(password)
                except DjangoValidationError as exc:
                    raise ValidationError({'password': list(exc.messages)})
                user = User.objects.create_user(username=username, password=password)
                created = True
            if not created and BusinessMembership.objects.filter(
                user=user, status=BusinessMembership.STATUS_ACTIVE,
            ).exclude(business=request.business).exists():
                raise ValidationError({
                    'username': f'{user.username} already belongs to another business. Team logins are tied to one business only. Create a separate username here.',
                })
            member, _ = BusinessMembership.objects.update_or_create(
                business=request.business, user=user,
                defaults={'role': role, 'status': BusinessMembership.STATUS_ACTIVE,
                          'permissions': {'extra': extras}},
            )
            ActionLog.objects.create(
                business=request.business, actor=request.user, action_type='team_add',
                status=ActionLog.STATUS_COMPLETED,
                summary=f'{"Created and added" if created else "Added"} {username} as {role}.',
                record_type='BusinessMembership', record_ref=str(member.pk),
            )
        card = _member_card(member)
        card['user_created'] = created
        return Response(card, status=status.HTTP_201_CREATED)


class TeamDetailView(APIView):
    permission_classes = [IsAuthenticated, IsBusinessOwner]

    def patch(self, request, business_id, member_id):
        member = get_object_or_404(
            BusinessMembership, pk=member_id, business=request.business
        )
        if member.role == BusinessMembership.ROLE_OWNER:
            raise ValidationError({'role': 'The owner record cannot be changed here.'})
        if 'role' in request.data:
            role = request.data.get('role')
            if role not in CORE_ASSIGNABLE_ROLES:
                raise ValidationError({'role': 'Pick manager, sales, or inventory.'})
            member.role = role
        if 'status' in request.data:
            new_status = request.data.get('status')
            if new_status not in {c[0] for c in BusinessMembership.STATUS_CHOICES}:
                raise ValidationError({'status': 'Pick a valid status.'})
            member.status = new_status
        if 'extra_permissions' in request.data:
            perms = dict(member.permissions or {})
            perms['extra'] = _clean_extras(request.data.get('extra_permissions'))
            member.permissions = perms
        member.save()
        ActionLog.objects.create(
            business=request.business, actor=request.user, action_type='team_update',
            status=ActionLog.STATUS_COMPLETED,
            summary=f'{member.user.username} is now {member.role} ({member.status}).',
            record_type='BusinessMembership', record_ref=str(member.pk),
        )
        return Response(_member_card(member))


class AnalyticsView(APIView):
    permission_classes = [IsAuthenticated, IsBusinessMember]

    def get(self, request, business_id):
        end = _parse_date(request.query_params.get('to'), 'to') or date.today()
        start = _parse_date(request.query_params.get('from'), 'from') or (end - timedelta(days=29))
        return Response(get_analytics(
            business=request.business, start=start, end=end,
            granularity=request.query_params.get('granularity', 'day'),
        ))


class ReceiptView(APIView):
    permission_classes = [IsAuthenticated, IsBusinessMember]

    def get(self, request, business_id, sale_id):
        sale = get_object_or_404(Sale, pk=sale_id, business=request.business)
        ensure_receipt(business=request.business, sale=sale, user=request.user)
        payload = receipt_payload(request.business, sale)
        if payload is None:
            raise ValidationError({'receipt': 'This sale is not committed yet.'})
        return Response(payload)


class ReceiptPdfView(APIView):
    """80mm POS thermal receipt. Invoices stay A4 for sending as PDF."""

    permission_classes = [IsAuthenticated, IsBusinessMember]

    def get(self, request, business_id, sale_id):
        sale = get_object_or_404(Sale, pk=sale_id, business=request.business)
        ensure_receipt(business=request.business, sale=sale, user=request.user)
        payload = receipt_payload(request.business, sale)
        if payload is None:
            raise ValidationError({'receipt': 'This sale is not committed yet.'})
        pdf = render_receipt_pos(payload['business'], payload['document'])
        response = HttpResponse(pdf, content_type='application/pdf')
        response['Content-Disposition'] = f'inline; filename="receipt-{payload["receipt_number"]}-80mm.pdf"'
        return response


class InvoiceView(APIView):
    permission_classes = [IsAuthenticated, IsBusinessMember]

    def get(self, request, business_id, sale_id):
        sale = get_object_or_404(Sale, pk=sale_id, business=request.business)
        invoice = Invoice.objects.filter(business=request.business, sale=sale).first()
        if invoice is None:
            raise ValidationError({'invoice': 'No invoice yet. Create one first.'})
        return Response(invoice_payload(request.business, invoice))

    def post(self, request, business_id, sale_id):
        sale = get_object_or_404(Sale, pk=sale_id, business=request.business)
        invoice, created = ensure_invoice(business=request.business, user=request.user, sale=sale)
        return Response(invoice_payload(request.business, invoice),
                        status=status.HTTP_201_CREATED if created else status.HTTP_200_OK)


class InvoicePdfView(APIView):
    permission_classes = [IsAuthenticated, IsBusinessMember]

    def get(self, request, business_id, sale_id):
        sale = get_object_or_404(Sale, pk=sale_id, business=request.business)
        invoice, _ = ensure_invoice(business=request.business, user=request.user, sale=sale)
        payload = invoice_payload(request.business, invoice)
        pdf = render_pdf(f"Invoice {payload['invoice_number']}", payload['business'], payload['document'])
        response = HttpResponse(pdf, content_type='application/pdf')
        response['Content-Disposition'] = f'inline; filename="invoice-{payload["invoice_number"]}.pdf"'
        return response


class AssistantHistoryView(APIView):
    permission_classes = [IsAuthenticated, IsBusinessMember]
    required_permission = 'assistant.use'

    def get(self, request, business_id):
        conversation = (
            Conversation.objects.filter(business=request.business, user=request.user)
            .order_by('-updated_at').first()
        )
        if conversation is None:
            return Response({'conversation_id': None, 'messages': []})
        return Response({
            'conversation_id': conversation.pk,
            'messages': [
                {'role': m.role, 'content': m.content,
                 'documents': (m.metadata or {}).get('documents'),
                 'visual': (m.metadata or {}).get('visual'),
                 'created_at': m.created_at.isoformat()}
                for m in conversation.messages.order_by('created_at', 'pk')[:100]
            ],
        })

    def delete(self, request, business_id):
        conversation = (
            Conversation.objects.filter(business=request.business, user=request.user)
            .order_by('-updated_at').first()
        )
        cleared = 0
        if conversation is not None:
            cleared = conversation.messages.count()
            conversation.delete()
        PendingAction.objects.filter(
            business=request.business, created_by=request.user,
            state__in=[PendingAction.STATE_DRAFT, PendingAction.STATE_AWAITING],
        ).delete()
        return Response({'cleared': True, 'messages': cleared})
