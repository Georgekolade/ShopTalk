"""Stage 4 maintained tests: assistant orchestration, tools, confirm flow."""

from decimal import Decimal

from django.contrib.auth import get_user_model
from django.test import override_settings
from rest_framework.test import APITestCase

from .ai import LLMProvider, MockProvider
from .assistant import _context, _history
from .models import (
    ActionLog,
    Business,
    BusinessMembership,
    BusinessRule,
    Conversation,
    Expense,
    Message,
    PendingAction,
    ProductService,
    Receipt,
    Sale,
    StockBalance,
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
class AssistantCase(APITestCase):
    def setUp(self):
        MockProvider.script = {}
        MockProvider.fail_on = set()
        self.owner = make_user('owner')
        self.staff = make_user('staff')
        self.shop = make_business(self.owner)
        BusinessMembership.objects.create(
            business=self.shop, user=self.staff, role=BusinessMembership.ROLE_STAFF,
            status=BusinessMembership.STATUS_ACTIVE,
        )
        self.garri = make_product(self.shop)
        self.client.force_authenticate(self.owner)

    def tearDown(self):
        MockProvider.script = {}
        MockProvider.fail_on = set()

    def ask(self, text, business=None, **kwargs):
        pk = (business or self.shop).pk
        payload = {'text': text}
        payload.update(kwargs)
        return self.client.post(
            f'/api/businesses/{pk}/assistant/messages', payload, format='json'
        )

    def confirm(self, action_id, confirm=True, business=None):
        pk = (business or self.shop).pk
        return self.client.post(
            f'/api/businesses/{pk}/assistant/actions/{action_id}/confirm',
            {'confirm': confirm}, format='json',
        )

    def commit_sale(self, quantity='2'):
        prepare = self.client.post(
            f'/api/businesses/{self.shop.pk}/sales/prepare',
            {'items': [{'product_id': self.garri.pk, 'quantity': quantity}],
             'idempotency_key': f'seed-{quantity}-{Sale.objects.count()}'},
            format='json',
        )
        return self.client.post(
            f"/api/businesses/{self.shop.pk}/sales/{prepare.data['id']}/commit"
        )

    def balance_of(self):
        return StockBalance.objects.get(
            business=self.shop, product=self.garri
        ).quantity


class ReportTests(AssistantCase):
    def test_sales_report_comes_from_rows(self):
        self.commit_sale('2')
        response = self.ask('how much did we sell today')
        self.assertEqual(response.status_code, 200)
        self.assertIn('5,000.00', response.data['reply'])
        self.assertEqual(response.data['tool_calls'][0]['tool'], 'get_business_report')

    def test_profit_report_states_definition(self):
        self.commit_sale('1')
        response = self.ask('what is our profit this week')
        self.assertEqual(response.status_code, 200)
        self.assertIn('700.00', response.data['reply'])
        self.assertIn('cost of goods', response.data['reply'])

    def test_low_stock_report_lists_items(self):
        response = self.ask('what is running low on stock')
        self.assertEqual(response.status_code, 200)
        self.assertNotIn('Garri 5kg', response.data['reply'])
        self.garri.stock_balances.update(quantity=Decimal('2'))
        response = self.ask('show low stock')
        self.assertIn('Garri 5kg', response.data['reply'])

    def test_stock_question_answers_from_rows(self):
        response = self.ask('how many garri in stock')
        self.assertEqual(response.status_code, 200)
        self.assertIn('10', response.data['reply'])

    def test_sale_documents_reply_has_no_raw_urls(self):
        self.commit_sale('1')
        response = self.ask('show me the receipt')
        self.assertEqual(response.status_code, 200)
        self.assertNotIn('/api/', response.data['reply'])
        self.assertNotIn('.pdf', response.data['reply'])
        self.assertIsNotNone(response.data['documents'])
        self.assertIn('.pdf', response.data['documents']['receipt_url'])

    def test_trend_reply_carries_chart_visual(self):
        self.commit_sale('2')
        response = self.ask('show me the sales trend')
        self.assertEqual(response.status_code, 200)
        visual = response.data['visual']
        self.assertIsNotNone(visual)
        self.assertEqual(visual['kind'], 'trend')
        self.assertTrue(len(visual['series']) > 0)
        self.assertIn('period', visual['series'][0])

    def test_low_stock_reply_carries_table_visual(self):
        self.garri.stock_balances.update(quantity=Decimal('2'))
        response = self.ask('show low stock')
        self.assertEqual(response.status_code, 200)
        visual = response.data['visual']
        self.assertIsNotNone(visual)
        self.assertEqual(visual['kind'], 'table')
        self.assertEqual(visual['columns'], ['Product', 'On hand', 'Threshold'])
        self.assertTrue(any('Garri 5kg' in str(row[0]) for row in visual['rows']))

    def test_history_serves_documents_and_visual(self):
        self.commit_sale('1')
        self.ask('show me the receipt')
        response = self.client.get(f'/api/businesses/{self.shop.pk}/assistant/history')
        self.assertEqual(response.status_code, 200)
        assistant_messages = [m for m in response.data['messages'] if m['role'] == 'assistant']
        self.assertTrue(any(m.get('documents') for m in assistant_messages))

    def test_tool_calls_are_logged(self):
        self.ask('how much did we sell today')
        entry = ActionLog.objects.filter(action_type='tool:get_business_report').first()
        self.assertIsNotNone(entry)
        self.assertEqual(entry.status, ActionLog.STATUS_COMPLETED)


class MemoryTests(AssistantCase):
    def test_history_is_chronological_with_outcomes(self):
        first = self.ask('sell 2 garri')
        action_id = first.data['action']['id']
        self.confirm(action_id)
        conversation = Conversation.objects.get(pk=first.data['conversation_id'])
        turns = _history(conversation)
        roles = [t['role'] for t in turns]
        self.assertEqual(roles[0], 'user')
        self.assertIn('sell 2 garri', turns[0]['content'])
        self.assertTrue(any('outcome: recorded sale #' in t['content'] for t in turns))

    def test_memory_accumulates_across_turns(self):
        first = self.ask('sell 2 garri')
        conversation = Conversation.objects.get(pk=first.data['conversation_id'])
        memory = conversation.memory
        self.assertIn('sell 2 garri', memory['summary'])
        self.assertIn('Garri 5kg', memory['facts'].get('products', []))
        self.assertIsNotNone(memory['open_thread'])
        self.confirm(first.data['action']['id'])
        conversation.refresh_from_db()
        memory = conversation.memory
        self.assertIsNone(memory['open_thread'])
        self.assertIn('recorded sale #', memory['summary'])
        self.assertIsNotNone(memory['facts'].get('last_sale_id'))

    def test_clear_chat_wipes_memory_with_history(self):
        first = self.ask('sell 2 garri')
        self.confirm(first.data['action']['id'])
        business_pk = self.shop.pk
        response = self.client.delete(f'/api/businesses/{business_pk}/assistant/history')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            Conversation.objects.filter(business=self.shop, user=self.owner).count(), 0
        )
        self.assertEqual(Message.objects.count(), 0)


@override_settings(SHOP_TALK_AI_PROVIDER='mock')
class MockProviderTests(AssistantCase):
    def test_scripted_plan_runs_expected_tools(self):
        MockProvider.script = {
            'brief me': {
                'tool_calls': [
                    {'name': 'get_business_context', 'args': {}},
                    {'name': 'get_business_report',
                     'args': {'metric': 'sales_total'}},
                ]
            }
        }
        self.commit_sale('1')
        response = self.ask('brief me')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.data['tool_calls']), 2)
        self.assertIn('2,500.00', response.data['reply'])

    def test_provider_failure_falls_back_to_local(self):
        MockProvider.fail_on = {'how much did we sell today'}
        self.commit_sale('1')
        response = self.ask('how much did we sell today')
        self.assertEqual(response.status_code, 200)
        self.assertIn('2,500.00', response.data['reply'])
        self.assertIn('locally', response.data['reply'])


class SaleFlowTests(AssistantCase):
    def test_sale_preview_waits_before_confirm(self):
        response = self.ask('sell 2 garri')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data['state'], 'awaiting_confirmation')
        self.assertIn('5000.00', response.data['reply'])
        self.assertEqual(Sale.objects.get().status, Sale.STATUS_PREPARED)
        self.assertEqual(self.balance_of(), Decimal('10.000'))

    def test_confirm_commits_stock_and_receipt(self):
        first = self.ask('sell 2 garri')
        action_id = first.data['action']['id']
        response = self.confirm(action_id)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data['state'], 'completed')
        self.assertIn('Receipt R-', response.data['reply'])
        self.assertEqual(self.balance_of(), Decimal('8.000'))
        self.assertEqual(Receipt.objects.count(), 1)

    def test_confirm_replay_returns_original(self):
        first = self.ask('sell 1 garri')
        action_id = first.data['action']['id']
        one = self.confirm(action_id)
        two = self.confirm(action_id)
        self.assertEqual(one.data['state'], 'completed')
        self.assertTrue(two.data['replayed'])
        self.assertEqual(Sale.objects.filter(status='committed').count(), 1)
        self.assertEqual(self.balance_of(), Decimal('9.000'))

    def test_decline_cancels_without_writes(self):
        first = self.ask('sell 2 garri')
        response = self.confirm(first.data['action']['id'], confirm=False)
        self.assertEqual(response.status_code, 200)
        self.assertIn('Cancelled', response.data['reply'])
        self.assertEqual(Sale.objects.get().status, Sale.STATUS_CANCELLED)
        self.assertEqual(self.balance_of(), Decimal('10.000'))

    def test_yes_in_chat_confirms_pending(self):
        first = self.ask('sell 1 garri')
        conv = first.data['conversation_id']
        response = self.ask('yes', conversation_id=conv)
        self.assertIn('Receipt R-', response.data['reply'])
        self.assertEqual(self.balance_of(), Decimal('9.000'))

    def test_unknown_item_asks_and_commits_nothing(self):
        response = self.ask('sell 2 moonrock')
        self.assertEqual(response.status_code, 200)
        self.assertIn('do not know', response.data['reply'])
        self.assertIsNone(response.data['action'])
        self.assertEqual(Sale.objects.count(), 0)
        self.assertEqual(PendingAction.objects.count(), 0)

    def test_ambiguous_item_asks_to_choose(self):
        make_product(self.shop, name='Garri 1kg', price='600.00', stock='5')
        response = self.ask('sell 2 garri')
        self.assertEqual(response.status_code, 200)
        self.assertIn('more than one', response.data['reply'])
        self.assertIsNone(response.data['action'])
        self.assertEqual(Sale.objects.count(), 0)

    def test_insufficient_stock_fails_cleanly(self):
        response = self.ask('sell 999 garri')
        self.assertEqual(response.status_code, 200)
        self.assertIn('stock', response.data['reply'])
        self.assertIsNone(response.data['action'])
        self.assertEqual(PendingAction.objects.count(), 0)

    def test_staff_may_sell(self):
        self.client.force_authenticate(self.staff)
        first = self.ask('sell 1 garri')
        response = self.confirm(first.data['action']['id'])
        self.assertEqual(response.data['state'], 'completed')


class ExpenseFlowTests(AssistantCase):
    def test_expense_preview_then_confirm(self):
        first = self.ask('spent 5000 on transport')
        self.assertEqual(first.data['state'], 'awaiting_confirmation')
        self.assertEqual(Expense.objects.count(), 0)
        response = self.confirm(first.data['action']['id'])
        self.assertEqual(response.data['state'], 'completed')
        self.assertEqual(Expense.objects.get().category, 'transport')

    def test_staff_expense_denied_at_confirm(self):
        self.client.force_authenticate(self.staff)
        first = self.ask('spent 5000 on transport')
        response = self.confirm(first.data['action']['id'])
        self.assertEqual(response.data['state'], 'failed')
        self.assertIn('owners and managers', response.data['reply'])
        self.assertEqual(Expense.objects.count(), 0)

    def test_missing_amount_asks(self):
        response = self.ask('record an expense on transport')
        self.assertIn('How much', response.data['reply'])
        self.assertIsNone(response.data['action'])


class StockReceiptFlowTests(AssistantCase):
    def test_receipt_preview_then_confirm(self):
        first = self.ask('we received 5 garri')
        self.assertEqual(first.data['state'], 'awaiting_confirmation')
        self.assertEqual(self.balance_of(), Decimal('10.000'))
        response = self.confirm(first.data['action']['id'])
        self.assertEqual(response.data['state'], 'completed')
        self.assertEqual(self.balance_of(), Decimal('15.000'))

    def test_staff_receipt_denied_at_confirm(self):
        self.client.force_authenticate(self.staff)
        first = self.ask('we received 5 garri')
        response = self.confirm(first.data['action']['id'])
        self.assertEqual(response.data['state'], 'failed')
        self.assertEqual(self.balance_of(), Decimal('10.000'))


class AssistantGuardTests(AssistantCase):
    def test_cross_tenant_message_denied(self):
        other_owner = make_user('other')
        other = make_business(other_owner, name='Other')
        response = self.ask('how much did we sell today', business=other)
        self.assertEqual(response.status_code, 404)

    def test_cross_tenant_confirm_denied(self):
        other_owner = make_user('other')
        other = make_business(other_owner, name='Other')
        first = self.ask('sell 1 garri')
        response = self.confirm(first.data['action']['id'], business=other)
        self.assertEqual(response.status_code, 404)
        self.assertEqual(Sale.objects.get().status, Sale.STATUS_PREPARED)

    def test_foreign_conversation_rejected(self):
        other_owner = make_user('rival')
        other = make_business(other_owner, name='Rival')
        conv = Conversation.objects.create(business=other, user=other_owner)
        response = self.ask('hello', conversation_id=conv.pk)
        self.assertEqual(response.status_code, 404)

    def test_empty_text_rejected(self):
        response = self.ask('   ')
        self.assertEqual(response.status_code, 400)

    def test_unknown_action_404(self):
        response = self.confirm(999999)
        self.assertEqual(response.status_code, 404)

    def test_voice_and_text_take_same_path(self):
        text = self.ask('sell 1 garri')
        self.client.force_authenticate(self.owner)
        voice = self.ask('sell 1 garri', input_mode='voice')
        self.assertEqual(
            text.data['action']['payload']['total'],
            voice.data['action']['payload']['total'],
        )
        self.assertEqual(
            Message.objects.filter(metadata__input_mode='voice').count(), 1
        )

    def test_unknown_tool_plan_refused(self):
        with override_settings(SHOP_TALK_AI_PROVIDER='mock'):
            MockProvider.script = {
                'hack': {'tool_calls': [{'name': 'drop_tables', 'args': {}}]}
            }
            response = self.ask('hack')
        self.assertIn('not available', response.data['reply'])

    def test_context_carries_knowledge_rules_and_stock(self):
        self.shop.settings = {'knowledge': {'opening_hours': '8am-8pm Mon-Sat',
                                             'payment': 'transfer or cash'}}
        self.shop.save(update_fields=['settings'])
        BusinessRule.objects.create(
            business=self.shop, rule_type='delivery',
            structured_value={'areas': ['Ikeja']}, verified=True)
        BusinessRule.objects.create(
            business=self.shop, rule_type='draft_note',
            structured_value={'x': 1}, verified=False)
        Expense.objects.create(
            business=self.shop, amount=Decimal('500'), category='Transport',
            description='', date='2026-10-01')
        conversation = Conversation.objects.create(
            business=self.shop, user=self.owner)
        context = _context(self.shop, conversation, user=self.owner)
        self.assertEqual(context['business']['name'], 'Shop')
        self.assertEqual(context['business']['currency'], 'NGN')
        self.assertEqual(context['user_role'], 'owner')
        self.assertTrue(context['today'])
        self.assertEqual(context['knowledge']['opening_hours'], '8am-8pm Mon-Sat')
        self.assertEqual([r['rule_type'] for r in context['rules']], ['delivery'])
        self.assertEqual(context['expense_categories'], ['Transport'])
        self.assertEqual(context['catalogue_sample'][0]['name'], 'Garri 5kg')
        make_product(self.shop, name='Rice 1kg', stock='3')
        context = _context(self.shop, conversation, user=self.owner)
        names = [row['name'] for row in context['low_stock']]
        self.assertIn('Rice 1kg', names)
        self.assertNotIn('Garri 5kg', names)

    def test_profile_patch_cleans_taught_knowledge(self):
        long_fact = 'x' * 500
        response = self.client.patch(
            f'/api/businesses/{self.shop.pk}/profile',
            {'settings': {'knowledge': {'opening_hours': long_fact, 'bad': {'n': 1}}}},
            format='json')
        self.assertEqual(response.status_code, 200)
        self.shop.refresh_from_db()
        knowledge = self.shop.settings['knowledge']
        self.assertEqual(len(knowledge['opening_hours']), 300)
        self.assertNotIn('bad', knowledge)

    def test_system_prompt_defines_role_objectives_constraints_format(self):
        for tag in ('<role>', '<objectives>', '<constraints>', '<output_format>'):
            self.assertIn(tag, LLMProvider.SYSTEM)
            self.assertIn(tag, LLMProvider.REPLY_SYSTEM)
        self.assertIn('ask_question', LLMProvider.SYSTEM)
        self.assertIn('confirm', LLMProvider.SYSTEM)
