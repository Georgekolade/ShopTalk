"""Step 5 tests: knowledge documents (A) + attached-document work (C)."""

import io

from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import override_settings
from rest_framework.test import APITestCase

from .assistant import _context
from .models import BusinessMembership, Conversation, KnowledgeDocument, Sale
from .test_assistant import make_business, make_product, make_user


def make_pdf(text):
    from reportlab.pdfgen import canvas

    buffer = io.BytesIO()
    pdf = canvas.Canvas(buffer)
    pdf.drawString(72, 720, text)
    pdf.showPage()
    pdf.save()
    return buffer.getvalue()


@override_settings(SHOP_TALK_AI_PROVIDER='heuristic')
class KnowledgeDocumentTests(APITestCase):
    def setUp(self):
        self.owner = make_user('k-owner')
        self.staff = make_user('k-staff')
        self.shop = make_business(self.owner)
        BusinessMembership.objects.create(
            business=self.shop, user=self.staff, role=BusinessMembership.ROLE_STAFF,
            status=BusinessMembership.STATUS_ACTIVE)
        self.garri = make_product(self.shop)
        self.client.force_authenticate(self.owner)
        self.url = f'/api/businesses/{self.shop.pk}/knowledge'

    def add_doc(self, title='Delivery policy', content='We deliver within Ikeja for orders above NGN 50000. Delivery fee is 2000.'):
        return self.client.post(self.url, {'title': title, 'content': content}, format='json')

    def ask(self, text, business=None, **kwargs):
        payload = {'text': text}
        payload.update(kwargs)
        return self.client.post(
            f'/api/businesses/{(business or self.shop).pk}/assistant/messages',
            payload, format='json')

    def test_paste_create_list_delete(self):
        created = self.add_doc()
        self.assertEqual(created.status_code, 201)
        self.assertEqual(created.data['source_type'], 'paste')
        self.assertNotIn('content', created.data)
        listed = self.client.get(self.url)
        self.assertEqual(len(listed.data), 1)
        self.assertIn('Ikeja', listed.data[0]['excerpt'])
        detail = self.client.get(f"{self.url}/{created.data['id']}")
        self.assertIn('Ikeja', detail.data['content'])
        deleted = self.client.delete(f"{self.url}/{created.data['id']}")
        self.assertEqual(deleted.status_code, 200)
        self.assertEqual(KnowledgeDocument.objects.count(), 0)

    def test_empty_paste_rejected(self):
        response = self.client.post(self.url, {'title': 'x', 'content': '  '}, format='json')
        self.assertEqual(response.status_code, 400)

    def test_non_owner_cannot_manage_documents(self):
        self.add_doc()
        self.client.force_authenticate(self.staff)
        self.assertIn(self.client.get(self.url).status_code, (403, 404))
        self.assertIn(self.client.post(
            self.url, {'title': 'x', 'content': 'y'}, format='json').status_code, (403, 404))

    def test_cross_business_document_hidden(self):
        created = self.add_doc()
        other = make_business(make_user('k-other'), name='Other')
        response = self.client.get(f'/api/businesses/{other.pk}/knowledge/{created.data["id"]}')
        self.assertIn(response.status_code, (403, 404))

    def test_text_and_pdf_upload_extract_text(self):
        txt = SimpleUploadedFile('notes.txt', b'Wholesale price for garri is 2000 per bag.', content_type='text/plain')
        r1 = self.client.post(self.url, {'file': txt}, format='multipart')
        self.assertEqual(r1.status_code, 201)
        self.assertEqual(r1.data['source_type'], 'text')
        pdf = SimpleUploadedFile('policy.pdf', make_pdf('Returns within 3 days with receipt'), content_type='application/pdf')
        r2 = self.client.post(self.url, {'file': pdf}, format='multipart')
        self.assertEqual(r2.status_code, 201, r2.data)
        self.assertEqual(r2.data['source_type'], 'pdf')
        detail = self.client.get(f"{self.url}/{r2.data['id']}")
        self.assertIn('Returns', detail.data['content'])

    def test_bad_file_type_rejected(self):
        bad = SimpleUploadedFile('evil.exe', b'MZ', content_type='application/octet-stream')
        response = self.client.post(self.url, {'file': bad}, format='multipart')
        self.assertEqual(response.status_code, 400)

    def test_assistant_answers_policy_from_documents(self):
        self.add_doc()
        response = self.ask('what is our delivery policy')
        self.assertEqual(response.status_code, 200)
        self.assertIn('Ikeja', response.data['reply'])
        self.assertEqual(response.data['tool_calls'][0]['tool'], 'search_knowledge')

    def test_search_never_crosses_business(self):
        self.add_doc()
        other = make_business(make_user('k-other2'), name='Other2')
        make_product(other)
        self.client.force_authenticate(other.memberships.first().user)
        response = self.ask('what is our delivery policy', business=other)
        self.assertNotIn('Ikeja', response.data['reply'])

    def test_context_lists_document_titles_not_content(self):
        self.add_doc()
        conversation = Conversation.objects.create(business=self.shop, user=self.owner)
        context = _context(self.shop, conversation, user=self.owner)
        self.assertEqual(context['counts']['knowledge_documents'], 1)
        self.assertEqual(context['knowledge_documents'][0]['title'], 'Delivery policy')
        self.assertNotIn('content', context['knowledge_documents'][0])

    # --- C: one-off attached document + instruction ---

    def ask_with_pdf(self, instruction, pdf_text):
        upload = SimpleUploadedFile('doc.pdf', make_pdf(pdf_text), content_type='application/pdf')
        return self.client.post(
            f'/api/businesses/{self.shop.pk}/assistant/messages',
            {'text': instruction, 'file': upload}, format='multipart')

    def test_attached_pdf_question_answers_from_pdf(self):
        response = self.ask_with_pdf('what is the delivery fee', 'Delivery fee is 2000 within Ikeja')
        self.assertEqual(response.status_code, 200, response.data)
        self.assertIn('2000', response.data['reply'])
        self.assertEqual(KnowledgeDocument.objects.count(), 0)  # one-off, not saved as knowledge

    def test_attached_pdf_stock_instruction_proposes_not_saves(self):
        response = self.ask_with_pdf('add this stock', '10 Garri 5kg')
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data['state'], 'awaiting_confirmation')

    def test_attached_pdf_sale_instruction_proposes_not_saves(self):
        response = self.ask_with_pdf('sell these items', '2 Garri 5kg')
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data['state'], 'awaiting_confirmation')
        self.assertEqual(Sale.objects.filter(status=Sale.STATUS_COMMITTED).count(), 0)
