"""Seed the retail demo business. Idempotent. Demo login: demo / demo1234."""

from decimal import Decimal

from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand
from django.db import transaction

from core.models import (
    Business,
    BusinessMembership,
    BusinessRule,
    Customer,
    ProductService,
    StockBalance,
    StockMovement,
    Supplier,
)

SHOP_NAME = "Ada's Provisions"

PRODUCTS = [
    {
        'name': 'Garri 5kg',
        'aliases': ['white garri'],
        'selling_price': '2500.00',
        'cost_price': '1800.00',
        'opening': '40',
    },
    {
        'name': 'Rice 10kg',
        'aliases': [],
        'selling_price': '9500.00',
        'cost_price': '7200.00',
        'opening': '25',
    },
    {
        'name': 'Palm Oil 1L',
        'aliases': ['palm oil'],
        'selling_price': '3200.00',
        'cost_price': '2400.00',
        'opening': '30',
    },
    {
        'name': 'Bread',
        'aliases': ['loaf'],
        'selling_price': '800.00',
        'cost_price': '550.00',
        'opening': '50',
    },
    {
        'name': 'Sugar 1kg',
        'aliases': [],
        'selling_price': '1200.00',
        'cost_price': '900.00',
        'opening': '8',
    },
]


class Command(BaseCommand):
    help = 'Seed the retail demo business with catalogue and opening stock.'

    def add_arguments(self, parser):
        parser.add_argument(
            '--reset', action='store_true',
            help='Delete the demo business first, then seed fresh.',
        )

    def handle(self, *args, **options):
        if options['reset']:
            deleted, _ = Business.objects.filter(name=SHOP_NAME).delete()
            self.stdout.write(f'Reset {SHOP_NAME} ({deleted} rows removed).')
        if Business.objects.filter(name=SHOP_NAME).exists():
            self.stdout.write(f'{SHOP_NAME} already seeded. Nothing to do.')
            return
        user_model = get_user_model()
        with transaction.atomic():
            user, created = user_model.objects.get_or_create(username='demo')
            if created:
                user.set_password('demo1234')
                user.save()
            business = Business.objects.create(
                name=SHOP_NAME,
                business_type=Business.RETAIL,
                currency='NGN',
                timezone='Africa/Lagos',
                country='NG',
                phone='08030000000',
                email='ada@adasprovisions.example',
                address='12 Market Road, Lagos',
                brand_color='#14532d',
                enabled_modules=['sales', 'inventory', 'expenses'],
                settings={},
            )
            BusinessMembership.objects.create(
                business=business,
                user=user,
                role=BusinessMembership.ROLE_OWNER,
                status=BusinessMembership.STATUS_ACTIVE,
            )
            Supplier.objects.create(
                business=business, name='Mile 12 Foods', phone='08030000001'
            )
            Customer.objects.create(business=business, name='Walk-in')
            for item in PRODUCTS:
                product = ProductService.objects.create(
                    business=business,
                    name=item['name'],
                    aliases=item['aliases'],
                    kind=ProductService.KIND_PRODUCT,
                    selling_price=Decimal(item['selling_price']),
                    cost_price=Decimal(item['cost_price']),
                    stock_tracked=True,
                    active=True,
                )
                StockBalance.objects.create(
                    business=business, product=product, quantity=Decimal(item['opening'])
                )
                StockMovement.objects.create(
                    business=business,
                    product=product,
                    movement_type=StockMovement.TYPE_OPENING,
                    quantity=Decimal(item['opening']),
                    reference='seed',
                    actor=user,
                )
            ProductService.objects.create(
                business=business,
                name='Home Delivery',
                aliases=['delivery'],
                kind=ProductService.KIND_SERVICE,
                selling_price=Decimal('1500.00'),
                stock_tracked=False,
                active=True,
            )
            BusinessRule.objects.create(
                business=business,
                rule_type='confirm_policy',
                structured_value={'all_money_moves': True},
                source=BusinessRule.SOURCE_PREFERENCE,
            )
            BusinessRule.objects.create(
                business=business,
                rule_type='low_stock_threshold',
                structured_value={'default': 10},
                source=BusinessRule.SOURCE_PREFERENCE,
            )
        self.stdout.write(self.style.SUCCESS(f'Seeded {SHOP_NAME}. Login: demo / demo1234.'))
