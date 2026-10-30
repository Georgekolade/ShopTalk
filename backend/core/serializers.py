"""Serializers for business setup, catalogue, and transactions."""

from decimal import Decimal

from django.db.models import Sum
from rest_framework import serializers

from .models import (
    ActionLog,
    Business,
    Expense,
    ProductService,
    Purchase,
    Sale,
)


class BusinessSerializer(serializers.ModelSerializer):
    class Meta:
        model = Business
        fields = [
            'id',
            'name',
            'business_type',
            'currency',
            'timezone',
            'country',
            'phone',
            'email',
            'address',
            'logo_data',
            'brand_color',
            'enabled_modules',
            'settings',
        ]


class ProductServiceSerializer(serializers.ModelSerializer):
    quantity_on_hand = serializers.SerializerMethodField()

    class Meta:
        model = ProductService
        fields = [
            'id',
            'name',
            'aliases',
            'kind',
            'selling_price',
            'cost_price',
            'stock_tracked',
            'active',
            'quantity_on_hand',
        ]
        read_only_fields = ['quantity_on_hand']

    def get_quantity_on_hand(self, obj):
        if not obj.stock_tracked:
            return None
        balances = getattr(obj, 'stock_balances', None)
        if balances is not None and hasattr(balances, 'all'):
            total = sum((b.quantity for b in balances.all()), Decimal('0'))
        else:
            total = obj.stock_balances.aggregate(total=Sum('quantity'))['total']
            total = total if total is not None else Decimal('0')
        return str(total.quantize(Decimal('0.001')))

    def validate_aliases(self, value):
        if not isinstance(value, list) or any(not isinstance(a, str) for a in value):
            raise serializers.ValidationError('Aliases must be a list of names.')
        return [a.strip() for a in value if a.strip()]

    def validate(self, attrs):
        business = self.context.get('business') or getattr(self.instance, 'business', None)
        name = attrs.get('name', getattr(self.instance, 'name', None))
        if business is not None and name is not None:
            existing = ProductService.objects.filter(business=business, name=name)
            if self.instance is not None:
                existing = existing.exclude(pk=self.instance.pk)
            if existing.exists():
                raise serializers.ValidationError(
                    {'name': 'This business already has an item with this name.'}
                )
        return attrs


class SaleLineSerializer(serializers.Serializer):
    product_id = serializers.IntegerField()
    quantity = serializers.DecimalField(max_digits=12, decimal_places=3)


class SalePrepareSerializer(serializers.Serializer):
    items = SaleLineSerializer(many=True)
    customer_id = serializers.IntegerField(required=False, allow_null=True, default=None)
    idempotency_key = serializers.CharField(required=False, allow_blank=True, default='')

    def validate_items(self, value):
        if not value:
            raise serializers.ValidationError('At least one item is required.')
        return value


class SaleItemReadSerializer(serializers.Serializer):
    product = serializers.CharField(source='product.name')
    product_id = serializers.IntegerField(source='product.pk')
    quantity = serializers.DecimalField(max_digits=12, decimal_places=3)
    unit_price = serializers.DecimalField(max_digits=12, decimal_places=2)
    line_total = serializers.DecimalField(max_digits=12, decimal_places=2)


class SaleReadSerializer(serializers.ModelSerializer):
    items = SaleItemReadSerializer(many=True, read_only=True)
    customer_name = serializers.SerializerMethodField()
    receipt_number = serializers.SerializerMethodField()

    class Meta:
        model = Sale
        fields = [
            'id',
            'customer',
            'customer_name',
            'status',
            'subtotal',
            'total',
            'sold_at',
            'items',
            'receipt_number',
        ]

    def get_customer_name(self, obj):
        return obj.customer.name if obj.customer is not None else None

    def get_receipt_number(self, obj):
        receipt = obj.receipts.first()
        return receipt.receipt_number if receipt is not None else None


class StockReceiptLineSerializer(serializers.Serializer):
    product_id = serializers.IntegerField()
    quantity = serializers.DecimalField(max_digits=12, decimal_places=3)
    unit_cost = serializers.DecimalField(
        max_digits=12, decimal_places=2, required=False, allow_null=True, default=None
    )


class StockReceiptSerializer(serializers.Serializer):
    items = StockReceiptLineSerializer(many=True)
    supplier_id = serializers.IntegerField(required=False, allow_null=True, default=None)
    idempotency_key = serializers.CharField(required=False, allow_blank=True, default='')

    def validate_items(self, value):
        if not value:
            raise serializers.ValidationError('At least one item is required.')
        return value


class PurchaseItemReadSerializer(serializers.Serializer):
    product = serializers.CharField(source='product.name')
    product_id = serializers.IntegerField(source='product.pk')
    quantity = serializers.DecimalField(max_digits=12, decimal_places=3)
    unit_cost = serializers.DecimalField(max_digits=12, decimal_places=2)
    line_total = serializers.DecimalField(max_digits=12, decimal_places=2)


class PurchaseReadSerializer(serializers.ModelSerializer):
    items = PurchaseItemReadSerializer(many=True, read_only=True)
    supplier_name = serializers.SerializerMethodField()

    class Meta:
        model = Purchase
        fields = ['id', 'supplier', 'supplier_name', 'status', 'total', 'items']

    def get_supplier_name(self, obj):
        return obj.supplier.name if obj.supplier is not None else None


class ExpenseSerializer(serializers.ModelSerializer):
    # date optional on write: the service defaults it to today.
    date = serializers.DateField(required=False)

    class Meta:
        model = Expense
        fields = ['id', 'amount', 'category', 'description', 'date']


class ActionLogSerializer(serializers.ModelSerializer):
    actor_name = serializers.SerializerMethodField()

    class Meta:
        model = ActionLog
        fields = [
            'id',
            'actor_name',
            'action_type',
            'request_id',
            'record_type',
            'record_ref',
            'status',
            'summary',
            'created_at',
        ]

    def get_actor_name(self, obj):
        return obj.actor.username if obj.actor is not None else None
