"""Production-upgrade coverage: register, team roles, analytics, invoices."""

from datetime import date, timedelta
from decimal import Decimal

from django.contrib.auth import get_user_model
from django.test import TestCase
from rest_framework.authtoken.models import Token
from rest_framework.test import APIClient

from .models import Business, BusinessMembership, ProductService
from .services import commit_sale, prepare_sale

User = get_user_model()


class ProductionUpgradeTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.owner = User.objects.create_user(username='owner2', password='pass12345x')
        self.token = Token.objects.create(user=self.owner)
        self.client.credentials(HTTP_AUTHORIZATION=f'Token {self.token.key}')
        self.business = Business.objects.create(
            name='Test Shop', currency='USD', country='US', timezone='America/New_York'
        )
        BusinessMembership.objects.create(
            business=self.business, user=self.owner, role='owner', status='active'
        )
        self.product = ProductService.objects.create(
            business=self.business, name='Rice 1kg', selling_price=Decimal('10.00'),
            cost_price=Decimal('6.00'), stock_tracked=False, active=True,
        )
        self.base = f'/api/businesses/{self.business.pk}'

    def test_register_creates_user_and_token(self):
        client = APIClient()
        res = client.post('/api/auth/register/', {'username': 'newuser', 'password': 'pass12345x'}, format='json')
        self.assertEqual(res.status_code, 201)
        self.assertTrue(res.data['token'])
        res2 = client.post('/api/auth/register/', {'username': 'newuser', 'password': 'pass12345x'}, format='json')
        self.assertEqual(res2.status_code, 400)

    def test_team_roles_bound_permissions(self):
        res = self.client.post(
            f'{self.base}/team',
            {'username': 'sales1', 'password': 'pass12345x', 'role': 'sales'}, format='json',
        )
        self.assertEqual(res.status_code, 201)
        sales = User.objects.get(username='sales1')
        sales_client = APIClient()
        token = Token.objects.create(user=sales)
        sales_client.credentials(HTTP_AUTHORIZATION=f'Token {token.key}')
        # Sales can sell, cannot record expenses.
        ok = sales_client.post(
            f'{self.base}/sales/prepare',
            {'items': [{'product_id': self.product.pk, 'quantity': '1'}], 'idempotency_key': 'k1'},
            format='json',
        )
        self.assertIn(ok.status_code, (200, 201))
        denied = sales_client.post(
            f'{self.base}/expenses',
            {'amount': '5', 'category': 'misc', 'date': str(date.today())}, format='json',
        )
        self.assertEqual(denied.status_code, 403)
        # Removed roles stay removed: viewer assignment is rejected.
        rejected = self.client.post(
            f'{self.base}/team',
            {'username': 'view1', 'password': 'pass12345x', 'role': 'viewer'},
            format='json',
        )
        self.assertEqual(rejected.status_code, 400)
        # A login tied to no business cannot use the assistant endpoint.
        outsider = User.objects.create_user(username='outsider', password='pass12345x')
        vtoken = Token.objects.create(user=outsider)
        vclient = APIClient()
        vclient.credentials(HTTP_AUTHORIZATION=f'Token {vtoken.key}')
        blocked = vclient.post(f'{self.base}/assistant/messages', {'text': 'hello'}, format='json')
        self.assertEqual(blocked.status_code, 404)

    def test_analytics_comparison_and_invoice_pdf(self):
        sale, _ = prepare_sale(
            business=self.business, user=self.owner,
            items=[{'product_id': self.product.pk, 'quantity': '2'}],
            idempotency_key='sale-1',
        )
        commit_sale(business=self.business, user=self.owner, sale=sale)
        today = date.today()
        res = self.client.get(
            f'{self.base}/reports/analytics?from={today - timedelta(days=6)}&to={today}&granularity=day'
        )
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.data['totals']['sales'], '20.00')
        self.assertIn('comparison', res.data)
        receipt = self.client.get(f'{self.base}/sales/{sale.pk}/receipt')
        self.assertEqual(receipt.status_code, 200)
        invoice = self.client.post(f'{self.base}/sales/{sale.pk}/invoice')
        self.assertEqual(invoice.status_code, 201)
        self.assertEqual(invoice.data['document']['total'], '20.00')
        pdf = self.client.get(f'{self.base}/sales/{sale.pk}/invoice.pdf')
        self.assertEqual(pdf.status_code, 200)
        self.assertEqual(pdf['Content-Type'], 'application/pdf')
        self.assertTrue(pdf.content.startswith(b'%PDF'))

    def test_receipt_pdf_is_80mm_pos_format(self):
        import io

        from pypdf import PdfReader

        sale, _ = prepare_sale(
            business=self.business, user=self.owner,
            items=[{'product_id': self.product.pk, 'quantity': '2'}],
            idempotency_key='sale-pos-1',
        )
        commit_sale(business=self.business, user=self.owner, sale=sale)
        res = self.client.get(f'{self.base}/sales/{sale.pk}/receipt.pdf')
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res['Content-Type'], 'application/pdf')
        self.assertTrue(res.content.startswith(b'%PDF'))
        page = PdfReader(io.BytesIO(res.content)).pages[0]
        width = float(page.mediabox.width)
        self.assertAlmostEqual(width, 80 * 2.83465, delta=1.0)
