"""Stage 6: the 12 PRD section 13 acceptance tests, end to end."""

import re
from decimal import Decimal

from django.contrib.auth import get_user_model
from django.db.models import Sum
from django.test import override_settings
from rest_framework.test import APITestCase

from .models import (
    Expense,
    Payment,
    PendingAction,
    ProductService,
    Purchase,
    Receipt,
    Sale,
    StockBalance,
    StockMovement,
    Business,
    BusinessMembership,
)

User = get_user_model()


def make_user(username):
    return User.objects.create_user(username=username, password='pass12345')


def make_business(owner, name='Shop'):
    business = Business.objects.create(name=name, business_type='retail', currency='NGN')
    BusinessMembership.objects.create(
        business=business, user=owner, role=BusinessMembership.ROLE_OWNER,
        status=BusinessMembership.STATUS_ACTIVE,
    )
    return business


def make_product(business, name='Garri 5kg', price='2500.00', cost='1800.00',
                 tracked=True, stock='10'):
    product = ProductService.objects.create(
        business=business, name=name, selling_price=Decimal(price),
        cost_price=Decimal(cost) if cost is not None else None,
        stock_tracked=tracked, active=True,
    )
    if tracked:
        StockBalance.objects.create(
            business=business, product=product, quantity=Decimal(stock)
        )
    return product


@override_settings(SHOP_TALK_AI_PROVIDER='heuristic')
class AcceptanceCase(APITestCase):
    def setUp(self):
        self.owner = make_user('owner')
        self.staff = make_user('staff')
        self.shop = make_business(self.owner)
        BusinessMembership.objects.create(
            business=self.shop, user=self.staff, role=BusinessMembership.ROLE_STAFF,
            status=BusinessMembership.STATUS_ACTIVE,
        )
        self.garri = make_product(self.shop)
        self.client.force_authenticate(self.owner)

    def biz(self, path, business=None):
        return f'/api/businesses/{(business or self.shop).pk}{path}'

    def ask(self, text, **kwargs):
        payload = {'text': text}
        payload.update(kwargs)
        return self.client.post(self.biz('/assistant/messages'), payload, format='json')

    def confirm(self, action_id, confirm=True):
        return self.client.post(
            self.biz(f'/assistant/actions/{action_id}/confirm'),
            {'confirm': confirm}, format='json',
        )

    def balance_of(self, product=None):
        return StockBalance.objects.get(
            business=self.shop, product=product or self.garri
        ).quantity


class AcceptanceTests(AcceptanceCase):
    def test_01_valid_sale_end_to_end(self):
        first = self.ask('sell 2 garri')
        self.assertEqual(first.data['state'], 'awaiting_confirmation')
        result = self.confirm(first.data['action']['id'])
        self.assertEqual(result.data['state'], 'completed')
        sale = Sale.objects.get()
        self.assertEqual(sale.status, Sale.STATUS_COMMITTED)
        self.assertEqual(sale.total, Decimal('5000.00'))
        self.assertEqual(
            sale.items.get().unit_price, self.garri.selling_price
        )
        self.assertEqual(self.balance_of(), Decimal('8.000'))
        self.assertEqual(
            StockMovement.objects.filter(
                business=self.shop, movement_type=StockMovement.TYPE_SALE
            ).count(), 1,
        )
        self.assertTrue(Receipt.objects.filter(sale=sale).exists())
        self.assertIn(Receipt.objects.get().receipt_number, result.data['reply'])

    def test_02_unknown_item_asks_and_commits_nothing(self):
        response = self.ask('sell 2 moonrock')
        self.assertIn('do not know', response.data['reply'])
        self.assertIsNone(response.data['action'])
        self.assertEqual(Sale.objects.count(), 0)
        self.assertEqual(PendingAction.objects.count(), 0)

    def test_03_ambiguous_match_asks_to_choose(self):
        make_product(self.shop, name='Garri 1kg', price='600.00', stock='5')
        response = self.ask('sell 2 garri')
        self.assertIn('more than one', response.data['reply'])
        self.assertIn('Garri 1kg', response.data['reply'])
        self.assertIn('Garri 5kg', response.data['reply'])
        self.assertEqual(Sale.objects.count(), 0)

    def test_04_missing_price_never_invented(self):
        response = self.ask('sell 2 moonrock')
        self.assertFalse(
            re.search(r'\d', response.data['reply']),
            f'Assistant invented figures: {response.data["reply"]}',
        )
        direct = self.client.post(
            self.biz('/sales/prepare'),
            {'items': [{'product_id': 999999, 'quantity': '1'}],
             'idempotency_key': 'no-price'},
            format='json',
        )
        self.assertEqual(direct.status_code, 400)

    def test_05_insufficient_stock_enforced(self):
        response = self.ask('sell 999 garri')
        self.assertIn('stock', response.data['reply'])
        self.assertIsNone(response.data['action'])
        self.assertEqual(Sale.objects.count(), 0)
        self.assertEqual(self.balance_of(), Decimal('10.000'))

    def test_06_repeated_submission_no_duplicates(self):
        line = [{'product_id': self.garri.pk, 'quantity': '1'}]
        first = self.client.post(
            self.biz('/sales/prepare'),
            {'items': line, 'idempotency_key': 'same-key'}, format='json',
        )
        second = self.client.post(
            self.biz('/sales/prepare'),
            {'items': line, 'idempotency_key': 'same-key'}, format='json',
        )
        self.assertEqual(first.status_code, 201)
        self.assertEqual(second.status_code, 200)
        self.assertEqual(first.data['id'], second.data['id'])
        self.assertEqual(Sale.objects.count(), 1)
        chat = self.ask('sell 1 garri')
        action_id = chat.data['action']['id']
        one = self.confirm(action_id)
        two = self.confirm(action_id)
        self.assertEqual(one.data['state'], 'completed')
        self.assertTrue(two.data['replayed'])
        self.assertEqual(Sale.objects.filter(status='committed').count(), 1)

    def test_07_failed_commit_writes_nothing_partial(self):
        chat = self.ask('sell 2 garri')
        action_id = chat.data['action']['id']
        StockBalance.objects.filter(
            business=self.shop, product=self.garri
        ).update(quantity=Decimal('1'))
        result = self.confirm(action_id)
        self.assertEqual(result.data['state'], 'failed')
        self.assertIn('stock', result.data['reply'])
        sale = Sale.objects.get()
        self.assertEqual(sale.status, Sale.STATUS_PREPARED)
        self.assertEqual(Receipt.objects.count(), 0)
        self.assertFalse(
            StockMovement.objects.filter(
                business=self.shop, movement_type=StockMovement.TYPE_SALE
            ).exists()
        )

    def test_08_unauthorised_user_rejected(self):
        self.client.force_authenticate(self.staff)
        denied = self.client.post(
            self.biz('/expenses'),
            {'amount': '100', 'category': 'airtime'}, format='json',
        )
        self.assertEqual(denied.status_code, 403)
        self.assertEqual(Expense.objects.count(), 0)
        outsider = make_user('outsider')
        self.client.force_authenticate(outsider)
        hidden = self.client.get(self.biz('/sales'))
        self.assertEqual(hidden.status_code, 404)

    def test_09_report_matches_independent_calc(self):
        self.client.post(
            self.biz('/sales/prepare'),
            {'items': [{'product_id': self.garri.pk, 'quantity': '2'}],
             'idempotency_key': 'r1'},
            format='json',
        )
        sale = Sale.objects.get()
        self.client.post(self.biz(f'/sales/{sale.pk}/commit'))
        self.client.post(
            self.biz('/expenses'),
            {'amount': '500.00', 'category': 'transport'}, format='json',
        )
        expected_total = Sale.objects.filter(
            business=self.shop, status='committed'
        ).aggregate(total=Sum('total'))['total']
        expected_exp = Expense.objects.filter(
            business=self.shop
        ).aggregate(total=Sum('amount'))['total']
        sales = self.client.get(self.biz('/reports?metric=sales_total'))
        expenses = self.client.get(self.biz('/reports?metric=expenses_total'))
        self.assertEqual(Decimal(sales.data['value']), expected_total)
        self.assertEqual(Decimal(expenses.data['value']), expected_exp)
        self.assertEqual(sales.data['value'], '5000.00')
        self.assertEqual(expenses.data['value'], '500.00')

    def test_10_voice_text_parity(self):
        text = self.ask('sell 1 garri')
        voice = self.ask('sell 1 garri', input_mode='voice')
        self.assertEqual(
            text.data['action']['payload']['total'],
            voice.data['action']['payload']['total'],
        )
        self.assertEqual(text.data['state'], voice.data['state'])
        self.assertEqual(
            text.data['tool_calls'][0]['tool'], voice.data['tool_calls'][0]['tool']
        )

    def test_11_cross_tenant_denied(self):
        rival_owner = make_user('rival')
        rival = make_business(rival_owner, name='Rival')
        rival_item = make_product(rival, name='Rival Rice', price='100.00', stock='5')
        peek = self.client.get(self.biz('/sales', business=rival))
        self.assertEqual(peek.status_code, 404)
        steal = self.client.post(
            self.biz('/sales/prepare'),
            {'items': [{'product_id': rival_item.pk, 'quantity': '1'}],
             'idempotency_key': 'steal'},
            format='json',
        )
        self.assertEqual(steal.status_code, 400)
        self.assertEqual(Sale.objects.count(), 0)

    def test_12_supplier_balance_needs_payment_data(self):
        from .models import Supplier

        supplier = Supplier.objects.create(business=self.shop, name='Mile 12')
        before = Supplier.objects.get(pk=supplier.pk)
        response = self.client.post(
            self.biz('/stock-receipts'),
            {'items': [{'product_id': self.garri.pk, 'quantity': '5'}],
             'supplier_id': supplier.pk, 'idempotency_key': 'sup1'},
            format='json',
        )
        self.assertEqual(response.status_code, 201)
        self.assertEqual(Purchase.objects.get().supplier_id, supplier.pk)
        self.assertEqual(self.balance_of(), Decimal('15.000'))
        self.assertEqual(Payment.objects.count(), 0)
        after = Supplier.objects.get(pk=supplier.pk)
        self.assertEqual((before.name, before.terms), (after.name, after.terms))
