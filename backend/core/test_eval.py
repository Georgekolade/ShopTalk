"""Unit 6 eval gate: golden conversations through the real assistant API.

Deterministic (offline heuristic provider). Each case pins intent, grounding,
clarification, and safety behaviour from PRD sections 3.3, 7, and 13. A
regression in any case fails the suite before a prompt change ships.
"""

from django.contrib.auth import get_user_model
from django.test import override_settings
from rest_framework.test import APITestCase

from .models import BusinessMembership, Sale
from .test_assistant import make_business, make_product, make_user

User = get_user_model()


@override_settings(SHOP_TALK_AI_PROVIDER='heuristic')
class GoldenConversationTests(APITestCase):
    def setUp(self):
        self.owner = make_user('eval-owner')
        self.shop = make_business(self.owner)
        self.garri = make_product(self.shop)  # Garri 5kg, NGN 2500, stock 10
        self.client.force_authenticate(self.owner)

    def ask(self, text, business=None, **kwargs):
        payload = {'text': text}
        payload.update(kwargs)
        return self.client.post(
            f'/api/businesses/{(business or self.shop).pk}/assistant/messages',
            payload, format='json')

    def test_sale_is_proposed_never_saved_before_confirm(self):
        response = self.ask('sell 2 garri')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data['state'], 'awaiting_confirmation')
        self.assertEqual(response.data['action']['payload']['total'], '5000.00')
        self.assertEqual(
            Sale.objects.filter(business=self.shop, status=Sale.STATUS_COMMITTED).count(), 0)

    def test_confirm_in_same_conversation_commits(self):
        first = self.ask('sell 2 garri')
        conv = first.data['conversation_id']
        second = self.ask('yes, confirm it', conversation_id=conv)
        self.assertEqual(second.data['state'], 'completed')
        self.assertEqual(
            Sale.objects.filter(business=self.shop, status=Sale.STATUS_COMMITTED).count(), 1)

    def test_unknown_item_clarifies_and_records_nothing(self):
        response = self.ask('sell 2 unobtanium')
        self.assertIsNone(response.data['action'])
        self.assertIn('do not know', response.data['reply'].lower())
        self.assertEqual(Sale.objects.filter(business=self.shop).count(), 0)

    def test_ambiguous_item_asks_which_one(self):
        make_product(self.shop, name='Garri 10kg', price='4500.00', stock='4')
        response = self.ask('sell 1 garri')
        self.assertIsNone(response.data['action'])
        self.assertIn('more than one', response.data['reply'].lower())

    def test_expense_is_proposed_with_category(self):
        response = self.ask('spent 5000 on transport yesterday')
        self.assertEqual(response.data['state'], 'awaiting_confirmation')
        self.assertEqual(response.data['action']['action_type'], 'expense')

    def test_stock_answer_comes_from_records(self):
        response = self.ask('how much garri do we have')
        self.assertIsNone(response.data['action'])
        self.assertIn('10', response.data['reply'])

    def test_voice_and_text_parity(self):
        text = self.ask('sell 1 garri')
        voice = self.ask('sell 1 garri', input_mode='voice')
        self.assertEqual(text.data['action']['payload']['total'],
                         voice.data['action']['payload']['total'])

    def test_cross_business_access_denied(self):
        other = make_business(make_user('eval-other'), name='Other Shop')
        response = self.ask('sell 1 garri', business=other)
        self.assertIn(response.status_code, (403, 404))

    def test_off_topic_no_action_no_crash(self):
        response = self.ask('what is the weather today')
        self.assertEqual(response.status_code, 200)
        self.assertIsNone(response.data['action'])
        self.assertTrue(response.data['reply'])

    def test_sales_question_uses_business_currency(self):
        first = self.ask('sell 2 garri')
        self.ask('yes, confirm it', conversation_id=first.data['conversation_id'])
        response = self.ask('how much did we make today')
        self.assertIsNone(response.data['action'])
        self.assertIn('5,000', response.data['reply'])
