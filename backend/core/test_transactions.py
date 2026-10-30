"""Phase 3 maintained tests: sales, stock receipts, expenses, reports, audit."""

from datetime import date
from decimal import Decimal

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from .models import (
    ActionLog,
    Business,
    BusinessMembership,
    Customer,
    ProductService,
    Receipt,
    Sale,
    StockBalance,
    StockMovement,
    Supplier,
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
                 tracked=True, stock='10', active=True):
    product = ProductService.objects.create(
        business=business, name=name, selling_price=Decimal(price),
        cost_price=Decimal(cost) if cost is not None else None,
        stock_tracked=tracked, active=active,
    )
    if tracked and stock is not None:
        StockBalance.objects.create(
            business=business, product=product, quantity=Decimal(stock)
        )
    return product


class TxCase(APITestCase):
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

    def urls(self, business=None):
        pk = (business or self.shop).pk
        return {
            'prepare': f'/api/businesses/{pk}/sales/prepare',
            'sales': f'/api/businesses/{pk}/sales',
            'receipts': f'/api/businesses/{pk}/stock-receipts',
            'expenses': f'/api/businesses/{pk}/expenses',
            'reports': f'/api/businesses/{pk}/reports',
            'activity': f'/api/businesses/{pk}/activity',
        }

    def prepare(self, lines, key='k1', **kwargs):
        payload = {'items': lines, 'idempotency_key': key}
        payload.update(kwargs)
        return self.client.post(self.urls()['prepare'], payload, format='json')

    def commit(self, sale_id, business=None):
        pk = (business or self.shop).pk
        return self.client.post(f'/api/businesses/{pk}/sales/{sale_id}/commit')

    def balance_of(self, product):
        return StockBalance.objects.get(business=self.shop, product=product).quantity


class SalePrepareTests(TxCase):
    def test_prepare_computes_server_totals(self):
        response = self.prepare([{'product_id': self.garri.pk, 'quantity': '2'}])
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.data['status'], 'prepared')
        self.assertEqual(Decimal(response.data['total']), Decimal('5000.00'))
        self.assertEqual(Decimal(response.data['items'][0]['unit_price']), Decimal('2500.00'))

    def test_prepare_replay_returns_same_sale(self):
        first = self.prepare([{'product_id': self.garri.pk, 'quantity': '1'}], key='dup')
        second = self.prepare([{'product_id': self.garri.pk, 'quantity': '9'}], key='dup')
        self.assertEqual(first.status_code, 201)
        self.assertEqual(second.status_code, 200)
        self.assertEqual(first.data['id'], second.data['id'])
        self.assertEqual(Sale.objects.count(), 1)

    def test_prepare_unknown_product_rejected(self):
        response = self.prepare([{'product_id': 999999, 'quantity': '1'}])
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.data['error']['code'], 'validation')
        self.assertEqual(Sale.objects.count(), 0)

    def test_prepare_inactive_product_rejected(self):
        self.garri.active = False
        self.garri.save()
        response = self.prepare([{'product_id': self.garri.pk, 'quantity': '1'}])
        self.assertEqual(response.status_code, 400)
        self.assertEqual(Sale.objects.count(), 0)

    def test_prepare_insufficient_stock_rejected(self):
        response = self.prepare([{'product_id': self.garri.pk, 'quantity': '999'}])
        self.assertEqual(response.status_code, 400)
        self.assertIn('stock', response.data['error']['message'])
        self.assertEqual(Sale.objects.count(), 0)

    def test_prepare_other_business_product_rejected(self):
        intruder = make_user('intruder')
        other_shop = make_business(intruder, 'Other')
        foreign = make_product(other_shop, name='Foreign')
        response = self.prepare([{'product_id': foreign.pk, 'quantity': '1'}])
        self.assertEqual(response.status_code, 400)

    def test_prepare_cross_tenant_url_is_404(self):
        response = self.client.post(
            self.urls(make_business(make_user('stranger'), 'Strange'))['prepare'],
            {'items': [{'product_id': self.garri.pk, 'quantity': '1'}]},
            format='json',
        )
        self.assertEqual(response.status_code, 404)

    def test_staff_can_prepare_sale(self):
        self.client.force_authenticate(self.staff)
        response = self.prepare([{'product_id': self.garri.pk, 'quantity': '1'}])
        self.assertEqual(response.status_code, 201)


class SaleCommitTests(TxCase):
    def test_commit_full_flow(self):
        sale_id = self.prepare(
            [{'product_id': self.garri.pk, 'quantity': '2'}]
        ).data['id']
        response = self.commit(sale_id)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data['status'], 'committed')
        self.assertTrue(response.data['receipt_number'].startswith('R-'))
        self.assertEqual(self.balance_of(self.garri), Decimal('8'))
        self.assertTrue(
            StockMovement.objects.filter(
                product=self.garri, movement_type=StockMovement.TYPE_SALE
            ).exists()
        )
        receipt = Receipt.objects.get(sale_id=sale_id)
        self.assertEqual(Decimal(receipt.document['total']), Decimal('5000.00'))
        self.assertTrue(
            ActionLog.objects.filter(
                action_type='sale_commit', status=ActionLog.STATUS_COMPLETED
            ).exists()
        )

    def test_commit_twice_conflicts(self):
        sale_id = self.prepare(
            [{'product_id': self.garri.pk, 'quantity': '1'}]
        ).data['id']
        self.assertEqual(self.commit(sale_id).status_code, 200)
        response = self.commit(sale_id)
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.data['error']['code'], 'conflict')
        self.assertEqual(self.balance_of(self.garri), Decimal('9'))

    def test_commit_short_stock_fails_clean(self):
        sale_id = self.prepare(
            [{'product_id': self.garri.pk, 'quantity': '10'}]
        ).data['id']
        StockBalance.objects.filter(business=self.shop, product=self.garri).update(
            quantity=Decimal('1')
        )
        response = self.commit(sale_id)
        self.assertEqual(response.status_code, 400)
        self.assertEqual(Sale.objects.get(pk=sale_id).status, Sale.STATUS_PREPARED)
        self.assertFalse(Receipt.objects.filter(sale_id=sale_id).exists())
        self.assertFalse(
            StockMovement.objects.filter(
                product=self.garri, movement_type=StockMovement.TYPE_SALE
            ).exists()
        )
        self.assertTrue(
            ActionLog.objects.filter(
                action_type='sale_commit', status=ActionLog.STATUS_FAILED
            ).exists()
        )

    def test_commit_cross_tenant_is_404(self):
        sale_id = self.prepare(
            [{'product_id': self.garri.pk, 'quantity': '1'}]
        ).data['id']
        other = make_business(make_user('stranger'), 'Strange')
        response = self.commit(sale_id, business=other)
        self.assertEqual(response.status_code, 404)


class StockReceiptTests(TxCase):
    def test_receipt_increments_stock(self):
        supplier = Supplier.objects.create(business=self.shop, name='Mile 12')
        response = self.client.post(
            self.urls()['receipts'],
            {
                'supplier_id': supplier.pk,
                'idempotency_key': 'r1',
                'items': [
                    {'product_id': self.garri.pk, 'quantity': '5', 'unit_cost': '1800.00'}
                ],
            },
            format='json',
        )
        self.assertEqual(response.status_code, 201)
        self.assertEqual(Decimal(response.data['total']), Decimal('9000.00'))
        self.assertEqual(self.balance_of(self.garri), Decimal('15'))
        self.assertTrue(
            StockMovement.objects.filter(
                product=self.garri, movement_type=StockMovement.TYPE_PURCHASE
            ).exists()
        )

    def test_receipt_missing_cost_warns(self):
        response = self.client.post(
            self.urls()['receipts'],
            {
                'idempotency_key': 'r2',
                'items': [{'product_id': self.garri.pk, 'quantity': '5'}],
            },
            format='json',
        )
        self.assertEqual(response.status_code, 201)
        self.assertTrue(response.data['warnings'])
        self.assertEqual(self.balance_of(self.garri), Decimal('15'))

    def test_receipt_replay_idempotent(self):
        payload = {
            'idempotency_key': 'r3',
            'items': [{'product_id': self.garri.pk, 'quantity': '5', 'unit_cost': '1'}],
        }
        first = self.client.post(self.urls()['receipts'], payload, format='json')
        second = self.client.post(self.urls()['receipts'], payload, format='json')
        self.assertEqual(first.status_code, 201)
        self.assertEqual(second.status_code, 200)
        self.assertEqual(self.balance_of(self.garri), Decimal('15'))

    def test_receipt_staff_forbidden(self):
        self.client.force_authenticate(self.staff)
        response = self.client.post(
            self.urls()['receipts'],
            {'items': [{'product_id': self.garri.pk, 'quantity': '1'}]},
            format='json',
        )
        self.assertEqual(response.status_code, 403)


class ExpenseTests(TxCase):
    def test_create_and_list_expense(self):
        response = self.client.post(
            self.urls()['expenses'],
            {'amount': '1500.00', 'category': 'transport', 'date': str(date.today())},
            format='json',
        )
        self.assertEqual(response.status_code, 201)
        listed = self.client.get(self.urls()['expenses'])
        self.assertEqual(len(listed.data), 1)
        self.assertTrue(
            ActionLog.objects.filter(
                action_type='expense', status=ActionLog.STATUS_COMPLETED
            ).exists()
        )

    def test_zero_amount_rejected(self):
        response = self.client.post(
            self.urls()['expenses'],
            {'amount': '0', 'category': 'x', 'date': str(date.today())},
            format='json',
        )
        self.assertEqual(response.status_code, 400)

    def test_staff_cannot_record_expense(self):
        self.client.force_authenticate(self.staff)
        response = self.client.post(
            self.urls()['expenses'],
            {'amount': '5', 'category': 'x', 'date': str(date.today())},
            format='json',
        )
        self.assertEqual(response.status_code, 403)


class ReportTests(TxCase):
    def test_sales_total_matches_commits(self):
        sale_id = self.prepare(
            [{'product_id': self.garri.pk, 'quantity': '2'}]
        ).data['id']
        self.commit(sale_id)
        self.prepare([{'product_id': self.garri.pk, 'quantity': '1'}], key='draft')
        response = self.client.get(self.urls()['reports'], {'metric': 'sales_total'})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(Decimal(response.data['value']), Decimal('5000.00'))

    def test_profit_math_with_cost_caveat(self):
        delivery = make_product(
            self.shop, name='Delivery', price='1500.00', cost=None, tracked=False
        )
        sale_id = self.prepare(
            [
                {'product_id': self.garri.pk, 'quantity': '2'},
                {'product_id': delivery.pk, 'quantity': '1'},
            ]
        ).data['id']
        self.commit(sale_id)
        response = self.client.get(self.urls()['reports'], {'metric': 'profit'})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(Decimal(response.data['revenue']), Decimal('6500.00'))
        self.assertEqual(Decimal(response.data['cogs']), Decimal('3600.00'))
        self.assertEqual(Decimal(response.data['value']), Decimal('2900.00'))
        self.assertTrue(any('cost' in note for note in response.data['caveats']))

    def test_low_stock_lists_thin_items(self):
        make_product(self.shop, name='Sugar', price='100.00', cost='50.00', stock='8')
        response = self.client.get(self.urls()['reports'], {'metric': 'low_stock'})
        names = [row['product'] for row in response.data['rows']]
        self.assertIn('Sugar', names)
        self.assertNotIn('Garri 5kg', names)

    def test_expenses_total(self):
        self.client.post(
            self.urls()['expenses'],
            {'amount': '1500.00', 'category': 'transport', 'date': str(date.today())},
            format='json',
        )
        response = self.client.get(self.urls()['reports'], {'metric': 'expenses_total'})
        self.assertEqual(Decimal(response.data['value']), Decimal('1500.00'))

    def test_unknown_metric_rejected(self):
        response = self.client.get(self.urls()['reports'], {'metric': 'vibes'})
        self.assertEqual(response.status_code, 400)


class ActivityTests(TxCase):
    def test_activity_lists_commits(self):
        sale_id = self.prepare(
            [{'product_id': self.garri.pk, 'quantity': '1'}]
        ).data['id']
        self.commit(sale_id)
        response = self.client.get(self.urls()['activity'])
        self.assertEqual(response.status_code, 200)
        actions = {(row['action_type'], row['status']) for row in response.data}
        self.assertIn(('sale_commit', 'completed'), actions)

    def test_activity_filter_by_status(self):
        customer = Customer.objects.create(business=self.shop, name='Ada')
        sale_id = self.prepare(
            [{'product_id': self.garri.pk, 'quantity': '1'}],
            key='c1',
        ).data['id']
        self.assertTrue(customer is not None and sale_id)
        response = self.client.get(self.urls()['activity'], {'status': 'completed'})
        self.assertEqual(response.status_code, 200)
        self.assertTrue(all(row['status'] == 'completed' for row in response.data))
