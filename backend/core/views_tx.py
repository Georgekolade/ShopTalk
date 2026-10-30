"""Transaction endpoints: sales, stock receipts, expenses, reports, activity."""

import uuid
from datetime import date, timedelta

from django.shortcuts import get_object_or_404
from rest_framework import status
from rest_framework.exceptions import ValidationError
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import ActionLog, Expense, Purchase, Sale
from .permissions import HasBusinessPermission, IsBusinessManager, IsBusinessMember
from .serializers import (
    ActionLogSerializer,
    ExpenseSerializer,
    PurchaseReadSerializer,
    SalePrepareSerializer,
    SaleReadSerializer,
    StockReceiptSerializer,
)
from .services import commit_sale, get_report, prepare_sale, receive_stock, record_expense


def _parse_date(raw, field):
    if not raw:
        return None
    try:
        return date.fromisoformat(raw)
    except ValueError:
        raise ValidationError({field: 'Use YYYY-MM-DD.'})


class SaleListView(APIView):
    permission_classes = [IsAuthenticated, IsBusinessMember]

    def get(self, request, business_id):
        sales = Sale.objects.filter(business=request.business).order_by('-created_at')
        wanted = request.query_params.get('status')
        if wanted:
            sales = sales.filter(status=wanted)
        start = _parse_date(request.query_params.get('from'), 'from')
        end = _parse_date(request.query_params.get('to'), 'to')
        if start:
            sales = sales.filter(sold_at__date__gte=start)
        if end:
            sales = sales.filter(sold_at__date__lte=end)
        return Response(SaleReadSerializer(sales[:200], many=True).data)


class SalePrepareView(APIView):
    permission_classes = [IsAuthenticated, HasBusinessPermission]
    required_permission = 'sales.write'

    def post(self, request, business_id):
        serializer = SalePrepareSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        key = data.get('idempotency_key') or uuid.uuid4().hex
        sale, created = prepare_sale(
            business=request.business,
            user=request.user,
            items=[
                {'product_id': line['product_id'], 'quantity': line['quantity']}
                for line in data['items']
            ],
            customer_id=data.get('customer_id'),
            idempotency_key=key,
        )
        return Response(
            SaleReadSerializer(sale).data,
            status=status.HTTP_201_CREATED if created else status.HTTP_200_OK,
        )


class SaleCommitView(APIView):
    permission_classes = [IsAuthenticated, HasBusinessPermission]
    required_permission = 'sales.write'

    def post(self, request, business_id, sale_id):
        sale = get_object_or_404(Sale, pk=sale_id, business=request.business)
        sale = commit_sale(business=request.business, user=request.user, sale=sale)
        return Response(SaleReadSerializer(sale).data)


class StockReceiptView(APIView):
    permission_classes = [IsAuthenticated, HasBusinessPermission]
    required_permission = 'stock.write'

    def post(self, request, business_id):
        serializer = StockReceiptSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        key = data.get('idempotency_key') or uuid.uuid4().hex
        purchase, created, warnings = receive_stock(
            business=request.business,
            user=request.user,
            items=[
                {
                    'product_id': line['product_id'],
                    'quantity': line['quantity'],
                    'unit_cost': line.get('unit_cost'),
                }
                for line in data['items']
            ],
            supplier_id=data.get('supplier_id'),
            idempotency_key=key,
        )
        payload = PurchaseReadSerializer(purchase).data
        payload['warnings'] = warnings
        return Response(
            payload, status=status.HTTP_201_CREATED if created else status.HTTP_200_OK
        )


class ExpenseListCreateView(APIView):
    def get_permissions(self):
        if self.request.method in ('GET', 'HEAD', 'OPTIONS'):
            return [IsAuthenticated(), IsBusinessMember()]
        self.required_permission = 'expenses.write'
        return [IsAuthenticated(), HasBusinessPermission()]

    def get(self, request, business_id):
        expenses = Expense.objects.filter(business=request.business).order_by('-date', '-pk')
        return Response(ExpenseSerializer(expenses[:200], many=True).data)

    def post(self, request, business_id):
        serializer = ExpenseSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        expense = record_expense(
            business=request.business,
            user=request.user,
            amount=data['amount'],
            category=data['category'],
            description=data.get('description', ''),
            day=data.get('date'),
        )
        return Response(ExpenseSerializer(expense).data, status=status.HTTP_201_CREATED)


class ReportView(APIView):
    permission_classes = [IsAuthenticated, IsBusinessMember]

    def get(self, request, business_id):
        metric = request.query_params.get('metric')
        if not metric:
            raise ValidationError({'metric': 'Required.'})
        end = _parse_date(request.query_params.get('to'), 'to') or date.today()
        start = _parse_date(request.query_params.get('from'), 'from') or (
            end - timedelta(days=29)
        )
        return Response(
            get_report(business=request.business, metric=metric, start=start, end=end)
        )


class ActivityView(APIView):
    permission_classes = [IsAuthenticated, IsBusinessMember]

    def get(self, request, business_id):
        events = ActionLog.objects.filter(business=request.business).order_by(
            '-created_at', '-pk'
        )
        wanted_status = request.query_params.get('status')
        if wanted_status:
            events = events.filter(status=wanted_status)
        wanted_action = request.query_params.get('action_type')
        if wanted_action:
            events = events.filter(action_type=wanted_action)
        try:
            limit = min(max(int(request.query_params.get('limit', 50)), 1), 200)
        except ValueError:
            raise ValidationError({'limit': 'Must be a number from 1 to 200.'})
        return Response(ActionLogSerializer(events[:limit], many=True).data)
