"""Phase 2 maintained tests: tenant isolation, catalogue, CSV import."""

from decimal import Decimal

from django.contrib.auth import get_user_model
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase
from rest_framework.test import APITestCase

from .models import (
    Business,
    BusinessMembership,
    ProductService,
    StockBalance,
    StockMovement,
)

User = get_user_model()


def make_owner(username='owner'):
    return User.objects.create_user(username=username, password='pass12345')


def make_business(owner, name='Test Shop', role=BusinessMembership.ROLE_OWNER):
    business = Business.objects.create(name=name, business_type='retail', currency='NGN')
    BusinessMembership.objects.create(
        business=business, user=owner, role=role, status=BusinessMembership.STATUS_ACTIVE
    )
    return business


class TenantIsolationTests(APITestCase):
    def setUp(self):
        self.alice = make_owner('alice')
        self.bob = make_owner('bob')
        self.shop_a = make_business(self.alice, 'Shop A')
        self.shop_b = make_business(self.bob, 'Shop B')
        self.widget = ProductService.objects.create(
            business=self.shop_a, name='Widget', selling_price='100.00'
        )

    def test_unauthenticated_catalogue_rejected(self):
        response = self.client.get(f'/api/businesses/{self.shop_a.pk}/catalogue')
        self.assertIn(response.status_code, (401, 403))

    def test_cross_tenant_context_is_404(self):
        self.client.force_authenticate(self.bob)
        response = self.client.get(f'/api/businesses/{self.shop_a.pk}/context')
        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.data['error']['code'], 'not_found')

    def test_cross_tenant_catalogue_list_is_404(self):
        self.client.force_authenticate(self.bob)
        response = self.client.get(f'/api/businesses/{self.shop_a.pk}/catalogue')
        self.assertEqual(response.status_code, 404)

    def test_cross_tenant_catalogue_detail_is_404(self):
        self.client.force_authenticate(self.bob)
        response = self.client.get(
            f'/api/businesses/{self.shop_a.pk}/catalogue/{self.widget.pk}'
        )
        self.assertEqual(response.status_code, 404)

    def test_cross_tenant_create_is_404(self):
        self.client.force_authenticate(self.bob)
        response = self.client.post(
            f'/api/businesses/{self.shop_a.pk}/catalogue',
            {'name': 'Sneaky', 'selling_price': '1.00'},
            format='json',
        )
        self.assertEqual(response.status_code, 404)
        self.assertFalse(ProductService.objects.filter(name='Sneaky').exists())

    def test_own_catalogue_visible(self):
        self.client.force_authenticate(self.alice)
        response = self.client.get(f'/api/businesses/{self.shop_a.pk}/catalogue')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.data), 1)


class CatalogueTests(APITestCase):
    def setUp(self):
        self.owner = make_owner('owner')
        self.staff = make_owner('staff')
        self.shop = make_business(self.owner)
        BusinessMembership.objects.create(
            business=self.shop,
            user=self.staff,
            role=BusinessMembership.ROLE_STAFF,
            status=BusinessMembership.STATUS_ACTIVE,
        )
        self.url = f'/api/businesses/{self.shop.pk}/catalogue'

    def test_create_product(self):
        self.client.force_authenticate(self.owner)
        response = self.client.post(
            self.url,
            {'name': 'Garri 5kg', 'selling_price': '2500.00', 'stock_tracked': True},
            format='json',
        )
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.data['name'], 'Garri 5kg')
        self.assertEqual(response.data['quantity_on_hand'], '0.000')

    def test_duplicate_name_rejected(self):
        ProductService.objects.create(
            business=self.shop, name='Garri 5kg', selling_price='2500.00'
        )
        self.client.force_authenticate(self.owner)
        response = self.client.post(
            self.url, {'name': 'Garri 5kg', 'selling_price': '1.00'}, format='json'
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.data['error']['code'], 'validation')

    def test_negative_price_rejected(self):
        self.client.force_authenticate(self.owner)
        response = self.client.post(
            self.url, {'name': 'Bad', 'selling_price': '-5.00'}, format='json'
        )
        self.assertEqual(response.status_code, 400)

    def test_staff_cannot_write_catalogue(self):
        self.client.force_authenticate(self.staff)
        response = self.client.post(
            self.url, {'name': 'Nope', 'selling_price': '1.00'}, format='json'
        )
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.data['error']['code'], 'permission')

    def test_staff_can_read_catalogue(self):
        ProductService.objects.create(
            business=self.shop, name='Visible', selling_price='10.00'
        )
        self.client.force_authenticate(self.staff)
        response = self.client.get(self.url)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.data), 1)

    def test_quantity_on_hand_sums_balances(self):
        product = ProductService.objects.create(
            business=self.shop, name='Rice', selling_price='100.00', stock_tracked=True
        )
        StockBalance.objects.create(business=self.shop, product=product, quantity='7.500')
        self.client.force_authenticate(self.owner)
        response = self.client.get(f'{self.url}/{product.pk}')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data['quantity_on_hand'], '7.500')

    def test_untracked_product_has_no_quantity(self):
        product = ProductService.objects.create(
            business=self.shop, name='Delivery', kind='service', selling_price='100.00'
        )
        self.client.force_authenticate(self.owner)
        response = self.client.get(f'{self.url}/{product.pk}')
        self.assertEqual(response.status_code, 200)
        self.assertIsNone(response.data['quantity_on_hand'])


class CatalogueImportTests(APITestCase):
    def setUp(self):
        self.owner = make_owner('owner')
        self.shop = make_business(self.owner)
        self.url = f'/api/businesses/{self.shop.pk}/catalogue/import'

    def _upload(self, csv_text, preview=False):
        path = f'{self.url}?preview=true' if preview else self.url
        upload = SimpleUploadedFile('cat.csv', csv_text.encode('utf-8'), content_type='text/csv')
        self.client.force_authenticate(self.owner)
        return self.client.post(path, {'file': upload}, format='multipart')

    def test_preview_writes_nothing(self):
        csv_text = 'name,selling_price,stock_tracked,opening_stock\nGarri,2500,true,10\n'
        response = self._upload(csv_text, preview=True)
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.data['preview'])
        self.assertEqual(response.data['valid_count'], 1)
        self.assertEqual(ProductService.objects.count(), 0)

    def test_commit_creates_and_reports_errors(self):
        csv_text = (
            'name,selling_price,stock_tracked,opening_stock\n'
            'Garri,2500,true,10\n'
            'Bad,,true,\n'
        )
        response = self._upload(csv_text)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data['created'], 1)
        self.assertEqual(response.data['rejected'], 1)
        product = ProductService.objects.get(name='Garri')
        self.assertEqual(
            StockBalance.objects.get(product=product).quantity, Decimal('10')
        )
        self.assertTrue(
            StockMovement.objects.filter(
                product=product, movement_type=StockMovement.TYPE_OPENING
            ).exists()
        )

    def test_duplicate_name_in_file_rejected(self):
        csv_text = 'name,selling_price\nGarri,2500\nGarri,2600\n'
        response = self._upload(csv_text)
        self.assertEqual(response.data['created'], 1)
        self.assertEqual(response.data['rejected'], 1)

    def test_missing_file_rejected(self):
        self.client.force_authenticate(self.owner)
        response = self.client.post(self.url, {}, format='multipart')
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.data['error']['code'], 'validation')


class BusinessTests(APITestCase):
    def test_create_assigns_owner(self):
        user = make_owner('founder')
        self.client.force_authenticate(user)
        response = self.client.post(
            '/api/businesses',
            {'name': 'New Shop', 'business_type': 'retail', 'currency': 'NGN'},
            format='json',
        )
        self.assertEqual(response.status_code, 201)
        membership = BusinessMembership.objects.get(
            business_id=response.data['id'], user=user
        )
        self.assertEqual(membership.role, BusinessMembership.ROLE_OWNER)

    def test_list_scoped_to_member(self):
        alice = make_owner('alice')
        bob = make_owner('bob')
        make_business(alice, 'Shop A')
        make_business(bob, 'Shop B')
        self.client.force_authenticate(alice)
        response = self.client.get('/api/businesses')
        self.assertEqual(response.status_code, 200)
        self.assertEqual([b['name'] for b in response.data], ['Shop A'])

    def test_context_returns_role_and_counts(self):
        alice = make_owner('alice')
        shop = make_business(alice, 'Shop A')
        ProductService.objects.create(business=shop, name='Widget', selling_price='5.00')
        self.client.force_authenticate(alice)
        response = self.client.get(f'/api/businesses/{shop.pk}/context')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data['role'], 'owner')
        self.assertEqual(response.data['counts']['products'], 1)


class ModelTests(TestCase):
    def test_balance_unique_per_product_location(self):
        owner = make_owner('owner')
        shop = make_business(owner)
        product = ProductService.objects.create(
            business=shop, name='Rice', selling_price='1.00', stock_tracked=True
        )
        StockBalance.objects.create(business=shop, product=product, quantity='1')
        with self.assertRaises(Exception):
            StockBalance.objects.create(business=shop, product=product, quantity='2')
