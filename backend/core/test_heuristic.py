"""Heuristic planner coverage. Pure parsing, no database needed."""

import json
import os
from unittest import mock

from django.test import SimpleTestCase

from .ai import HeuristicProvider, LLMProvider, ProviderError, _parse_qty_name


def plan(text, awaiting=None):
    return HeuristicProvider().plan(
        text=text,
        context={'business': {'id': 1, 'name': 'Shop', 'currency': 'GHS'},
                 'awaiting_actions': awaiting or []},
        history=[],
    )


class QtyParsingTests(SimpleTestCase):
    def test_digits(self):
        self.assertEqual(_parse_qty_name('2 garri'), ('2', 'garri'))

    def test_number_words_and_articles(self):
        self.assertEqual(_parse_qty_name('two garri'), ('2', 'garri'))
        self.assertEqual(_parse_qty_name('a garri'), ('1', 'garri'))
        self.assertEqual(_parse_qty_name('an oil'), ('1', 'oil'))

    def test_trailing_shop_words_stripped(self):
        self.assertEqual(_parse_qty_name('10 garri to stock'), ('10', 'garri'))
        self.assertEqual(_parse_qty_name('3 rice for the shop'), ('3', 'rice'))

    def test_no_quantity(self):
        self.assertIsNone(_parse_qty_name('garri'))


class IntentTests(SimpleTestCase):
    def test_sale_synonyms(self):
        for text in ('sell 2 garri', 'log a sale of 2 garri', 'new sale 2 garri'):
            with self.subTest(text=text):
                self.assertEqual(plan(text).write_intent, 'prepare_sale')

    def test_stock_synonyms(self):
        for text in ('we received 10 garri', 'added 10 garri to stock',
                     'we stocked 5 rice'):
            with self.subTest(text=text):
                self.assertEqual(plan(text).write_intent, 'receive_stock')

    def test_stock_questions(self):
        for text in ('how many garri left', 'do we have garri',
                     'is garri available', 'how much rice do we have'):
            with self.subTest(text=text):
                p = plan(text)
                self.assertEqual(p.tool_calls[0].name, 'search_products')

    def test_receipt_and_invoice(self):
        p = plan('send me the invoice')
        self.assertEqual(p.tool_calls[0].name, 'get_sale_documents')
        self.assertEqual(p.tool_calls[0].args, {})
        p = plan('receipt for sale 5')
        self.assertEqual(p.tool_calls[0].args, {'sale_id': 5})

    def test_trend(self):
        p = plan('sales trend this month')
        self.assertEqual(p.tool_calls[0].name, 'get_sales_trend')
        self.assertEqual(p.tool_calls[0].args['granularity'], 'month')

    def test_made_means_sales(self):
        p = plan('how much did we make this week')
        self.assertEqual(p.tool_calls[0].name, 'get_business_report')
        self.assertEqual(p.tool_calls[0].args['metric'], 'sales_total')

    def test_make_inside_word_is_not_sales(self):
        p = plan('how much makeup do we have')
        self.assertEqual(p.tool_calls[0].name, 'search_products')

    def test_make_a_sale_records_sale(self):
        p = plan('make a sale of 2 garri')
        self.assertEqual(p.write_intent, 'prepare_sale')

    def test_expense_day(self):
        p = plan('spent 5000 on transport yesterday')
        self.assertEqual(p.write_intent, 'record_expense')
        self.assertIn('day', p.write_args)

    def test_loose_confirm_only_when_waiting(self):
        waiting = [{'id': 7, 'action_type': 'sale', 'summary': 'Sale'}]
        p = plan('yes, confirm it', awaiting=waiting)
        self.assertEqual(p.write_intent, 'confirm_pending')
        self.assertEqual(p.write_args, {'pending_action_id': 7})
        p = plan('no thanks, cancel', awaiting=waiting)
        self.assertEqual(p.write_intent, 'cancel_pending')
        # No awaiting action: "ok ..." questions must not confirm.
        p = plan('ok what did we sell today')
        self.assertNotEqual(p.write_intent, 'confirm_pending')


def llm_reply(*calls):
    body = json.dumps({'choices': [{'message': {'tool_calls': list(calls)}}]}).encode()
    response = mock.Mock()
    response.read.return_value = body
    return response


def llm_call(name, arguments):
    return {'function': {'name': name, 'arguments': arguments}}


class LLMProviderTests(SimpleTestCase):
    def setUp(self):
        self.env = mock.patch.dict(os.environ, {
            'SHOP_TALK_AI_API_KEY': 'test-key',
            'SHOP_TALK_AI_BASE_URL': 'https://model.test/v1',
            'SHOP_TALK_AI_MODEL': 'test-model',
        })
        self.env.start()
        self.addCleanup(self.env.stop)

    def run_plan(self, *calls, **kwargs):
        with mock.patch('urllib.request.urlopen', return_value=llm_reply(*calls)):
            return LLMProvider().plan(
                text=kwargs.get('text', 'hello'),
                context={'business': {'id': 1, 'name': 'S', 'currency': 'GHS'},
                         'awaiting_actions': kwargs.get('awaiting', [])},
                history=[],
            )

    def test_propose_sale_maps_to_prepare(self):
        p = self.run_plan(llm_call('propose_sale', {'lines': [{'name': 'garri', 'quantity': '2'}]}))
        self.assertEqual(p.write_intent, 'prepare_sale')
        self.assertEqual(p.write_args['lines'], [{'name': 'garri', 'quantity': '2'}])

    def test_read_call_maps_through(self):
        p = self.run_plan(llm_call('get_sale_documents', {'sale_id': 5}))
        self.assertEqual(p.tool_calls[0].name, 'get_sale_documents')
        self.assertEqual(p.tool_calls[0].args, {'sale_id': 5})

    def test_ask_maps_to_clarify(self):
        p = self.run_plan(llm_call('ask_question', {'question': 'Which sale?'}))
        self.assertEqual(p.clarify, 'Which sale?')

    def test_missing_key_falls_back(self):
        with mock.patch.dict(os.environ, {'SHOP_TALK_AI_API_KEY': ''}):
            with self.assertRaises(ProviderError):
                self.run_plan()

    def test_unreadable_reply_falls_back(self):
        response = mock.Mock()
        response.read.return_value = b'not json'
        with mock.patch('urllib.request.urlopen', return_value=response):
            with self.assertRaises(ProviderError):
                self.run_plan()
        empty = mock.Mock()
        empty.read.return_value = json.dumps({'choices': [{'message': {}}]}).encode()
        with mock.patch('urllib.request.urlopen', return_value=empty):
            with self.assertRaises(ProviderError):
                self.run_plan()
