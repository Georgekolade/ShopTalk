"""Receipt / invoice documents + PDF rendering.

Documents are built only from saved records (Receipt.document / Invoice),
never from model text. PDF uses reportlab; business branding is the
white-label face, with a small "Powered by ShopTalk AI" footer watermark.
"""

import io
from decimal import Decimal, InvalidOperation

from django.db import transaction

from .models import ActionLog, Invoice, Receipt


def build_receipt_document(business, sale):
    number = f'R-{sale.pk:06d}'
    return {
        'receipt_number': number,
        'business': business.name,
        'currency': business.currency,
        'customer': sale.customer.name if sale.customer else '',
        'sold_at': sale.sold_at.isoformat() if sale.sold_at else '',
        'lines': [
            {'product': item.product.name, 'quantity': str(item.quantity),
             'unit_price': str(item.unit_price), 'line_total': str(item.line_total)}
            for item in sale.items.select_related('product')
        ],
        'subtotal': str(sale.subtotal), 'total': str(sale.total),
    }


def ensure_receipt(*, business, sale, user=None):
    """Backfill a receipt for an old committed sale that predates receipts."""
    receipt = Receipt.objects.filter(business=business, sale=sale).order_by('-pk').first()
    if receipt is not None:
        return receipt, False
    if sale.status != sale.STATUS_COMMITTED:
        return None, False
    with transaction.atomic():
        number = f'R-{sale.pk:06d}'
        receipt = Receipt.objects.create(
            business=business, sale=sale, receipt_number=number,
            document=build_receipt_document(business, sale), issued_by=user,
        )
    return receipt, True


def receipt_payload(business, sale):
    receipt = Receipt.objects.filter(business=business, sale=sale).order_by('-pk').first()
    if receipt is None:
        return None
    return {
        'receipt_number': receipt.receipt_number,
        'issued_at': receipt.issued_at.isoformat(),
        'business': _business_card(business),
        'document': receipt.document,
    }


def _business_card(business):
    return {
        'name': business.name, 'currency': business.currency,
        'phone': business.phone, 'email': business.email,
        'address': business.address, 'brand_color': business.brand_color,
    }


def ensure_invoice(*, business, user, sale):
    if sale.status != sale.STATUS_COMMITTED:
        from rest_framework.exceptions import ValidationError
        raise ValidationError({'sale': 'Only committed sales can be invoiced.'})
    existing = Invoice.objects.filter(business=business, sale=sale).first()
    if existing is not None:
        return existing, False
    with transaction.atomic():
        number = f'INV-{sale.pk:06d}'
        document = {
            'invoice_number': number,
            'business': business.name,
            'currency': business.currency,
            'customer': sale.customer.name if sale.customer else '',
            'sold_at': sale.sold_at.isoformat() if sale.sold_at else '',
            'lines': [
                {'product': item.product.name, 'quantity': str(item.quantity),
                 'unit_price': str(item.unit_price), 'line_total': str(item.line_total)}
                for item in sale.items.select_related('product')
            ],
            'subtotal': str(sale.subtotal), 'total': str(sale.total),
        }
        invoice = Invoice.objects.create(
            business=business, sale=sale, invoice_number=number,
            document=document, issued_by=user,
        )
        ActionLog.objects.create(
            business=business, actor=user, action_type='invoice_create',
            status=ActionLog.STATUS_COMPLETED,
            summary=f'Invoice {number} for sale {sale.pk}.',
            record_type='Invoice', record_ref=str(invoice.pk),
        )
    return invoice, True


def invoice_payload(business, invoice):
    return {
        'invoice_number': invoice.invoice_number,
        'issued_at': invoice.issued_at.isoformat(),
        'business': _business_card(business),
        'document': invoice.document,
    }


def _money(value):
    """Humanize money for PDFs: 9500 -> 9,500.00. Never crash on bad input."""
    try:
        return f"{Decimal(str(value)) :,.2f}"
    except (InvalidOperation, ValueError, TypeError, AttributeError):
        return str(value)


def _brand_rgb(brand_color):
    """Parse #rrggbb brand colour; fall back to deep ShopTalk green."""
    fallback = (0x14, 0x53, 0x2D)
    try:
        raw = (brand_color or '').strip().lstrip('#')
        if len(raw) == 3:
            raw = ''.join(c * 2 for c in raw)
        if len(raw) != 6:
            return fallback
        return tuple(int(raw[i:i + 2], 16) for i in (0, 2, 4))
    except (ValueError, TypeError):
        return fallback


def _qty(value):
    """Quantities without trailing zeros: 2.00 -> 2, 1.50 -> 1.5."""
    try:
        normalized = Decimal(str(value)).normalize()
        return format(normalized, 'f')
    except (InvalidOperation, ValueError, TypeError, AttributeError):
        return str(value)


POS_WIDTH = 80 * 2.83465  # 80mm thermal roll in points.
POS_MARGIN = 8.0
POS_COLS = 38


def _pos_center(text):
    text = str(text or '').strip()
    if len(text) >= POS_COLS:
        return [text[:POS_COLS]]
    pad = (POS_COLS - len(text)) // 2
    return [' ' * pad + text]


def _pos_row(left, right):
    left, right = str(left or ''), str(right or '')
    gap = POS_COLS - len(left) - len(right)
    if gap < 1:
        return [left[:POS_COLS], right.rjust(POS_COLS)[:POS_COLS]]
    return [left + ' ' * gap + right]


def _pos_wrap(text):
    words, lines, current = str(text or '').split(), [], ''
    for word in words:
        if len((current + ' ' + word).strip()) > POS_COLS:
            if current:
                lines.append(current)
            while len(word) > POS_COLS:
                lines.append(word[:POS_COLS])
                word = word[POS_COLS:]
            current = word
        else:
            current = (current + ' ' + word).strip()
    if current:
        lines.append(current)
    return lines or ['']


def render_receipt_pos(business_card, document):
    """80mm thermal-printer receipt: narrow, monospace, compact.

    Invoices stay A4 (`render_pdf`) for sending as PDF; receipts print on
    POS rolls. Any thermal printer that takes PDFs cuts at the feed lines.
    """
    from reportlab.pdfgen import canvas

    business_name = business_card.get('name') or document.get('business') or 'Business'
    currency = business_card.get('currency') or document.get('currency') or ''
    number = document.get('receipt_number') or ''
    dated = (document.get('sold_at') or '')[:16].replace('T', ' ')
    customer = document.get('customer') or 'Walk-in'
    contact_bits = [str(x) for x in [
        business_card.get('phone', ''), business_card.get('address', ''),
    ] if x]

    rows = []
    rows += _pos_center(business_name.upper())
    for bit in contact_bits[:2]:
        rows += _pos_center(bit)
    rows.append('-' * POS_COLS)
    rows += _pos_center('SALES RECEIPT')
    if number:
        rows += _pos_center(number)
    if dated:
        rows += _pos_center(dated)
    rows += _pos_row('Customer:', customer[:24])
    rows.append('-' * POS_COLS)
    text_lines = 0
    item_rows = []
    for line in document.get('lines', []) or []:
        name_rows = _pos_wrap(line.get('product', ''))
        item_rows += name_rows
        text_lines += len(name_rows)
        detail = _pos_row(
            f"{_qty(line.get('quantity', ''))} x {_money(line.get('unit_price', ''))}",
            f"{currency} {_money(line.get('line_total', ''))}".strip(),
        )
        item_rows += detail
        text_lines += len(detail)
    rows += item_rows
    rows.append('-' * POS_COLS)
    rows += _pos_row('TOTAL:', f"{currency} {_money(document.get('total', ''))}".strip())
    rows.append('=' * POS_COLS)
    rows += _pos_center('Thank you for your business.')
    rows += _pos_center('Powered by ShopTalk AI')
    rows += ['', '', '']

    height = 40 + len(rows) * 11.5
    buffer = io.BytesIO()
    pdf = canvas.Canvas(buffer, pagesize=(POS_WIDTH, height))
    pdf.setFont('Courier-Bold', 10)
    y = height - 20
    pdf.drawCentredString(POS_WIDTH / 2, y, rows[0][:POS_COLS])
    pdf.setFont('Courier', 9)
    for row in rows[1:]:
        y -= 11.5
        pdf.drawString(POS_MARGIN, y, row[:POS_COLS])
    pdf.showPage()
    pdf.save()
    return buffer.getvalue()


def render_pdf(title, business_card, document):
    """Branded receipt/invoice PDF: business identity leads, ShopTalk marks the footer."""
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.units import mm
    from reportlab.pdfgen import canvas

    brand = _brand_rgb(business_card.get('brand_color'))
    brand_light = tuple((c + 255 * 4) / 5 / 255 for c in brand)
    brand_dark = tuple(c / 255 for c in brand)
    business_name = business_card.get('name') or document.get('business') or 'Business'
    currency = business_card.get('currency') or document.get('currency') or ''
    number = document.get('receipt_number') or document.get('invoice_number') or ''
    kind = 'RECEIPT' if document.get('receipt_number') else 'INVOICE'
    contact_bits = [str(x) for x in [
        business_card.get('phone', ''), business_card.get('email', ''),
        business_card.get('address', ''),
    ] if x]
    dated = (document.get('sold_at') or '')[:16].replace('T', ' ')
    customer = document.get('customer') or 'Walk-in'
    total_label = 'Total received' if kind == 'RECEIPT' else 'Total due'

    buffer = io.BytesIO()
    pdf = canvas.Canvas(buffer, pagesize=A4)
    width, height = A4
    left, right = 15 * mm, width - 15 * mm
    ink = (0.10, 0.10, 0.10)
    grey = (0.38, 0.38, 0.38)

    def footer(page_num):
        pdf.setFillColorRGB(*grey)
        pdf.setFont('Helvetica', 7)
        pdf.drawString(left, 13 * mm, 'Powered by ShopTalk AI')
        pdf.drawCentredString(width / 2, 8.5 * mm, f'{business_name} · Generated from saved records.'[:110])
        pdf.drawRightString(right, 13 * mm, f'Page {page_num}')

    def header_bar():
        pdf.setFillColorRGB(*brand_dark)
        pdf.rect(0, height - 10 * mm, width, 10 * mm, stroke=0, fill=1)
        pdf.setFillColorRGB(1, 1, 1)
        pdf.setFont('Helvetica-Bold', 8)
        pdf.drawString(left, height - 6.8 * mm, f'{kind} · {business_name}'[:90])
        pdf.setFont('Helvetica', 8)
        pdf.drawRightString(right, height - 6.8 * mm, 'Powered by ShopTalk AI')

    def table_head(pos):
        pdf.setFillColorRGB(*brand_dark)
        pdf.roundRect(left, pos - 2.5 * mm, right - left, 8 * mm, 1.5 * mm, stroke=0, fill=1)
        pdf.setFillColorRGB(1, 1, 1)
        pdf.setFont('Helvetica-Bold', 9)
        pdf.drawString(left + 4 * mm, pos, '#')
        pdf.drawString(left + 12 * mm, pos, 'Item')
        pdf.drawRightString(right - 64 * mm, pos, 'Qty')
        pdf.drawRightString(right - 34 * mm, pos, 'Unit price')
        pdf.drawRightString(right - 4 * mm, pos, 'Amount')
        return pos - 9 * mm

    page = 1
    header_bar()

    # Business identity block.
    y = height - 22 * mm
    pdf.setFillColorRGB(*ink)
    pdf.setFont('Helvetica-Bold', 20)
    pdf.drawString(left, y, business_name[:44])
    y -= 7 * mm
    pdf.setFillColorRGB(*grey)
    pdf.setFont('Helvetica', 9)
    for bit in contact_bits[:3]:
        pdf.drawString(left, y, bit[:95])
        y -= 4.5 * mm
    y -= 2 * mm
    # Brand rule.
    pdf.setStrokeColorRGB(*brand_dark)
    pdf.setLineWidth(0.8)
    pdf.line(left, y, right, y)
    y -= 7 * mm

    # Document title left, total card right.
    pdf.setFillColorRGB(*brand_dark)
    pdf.setFont('Helvetica-Bold', 16)
    pdf.drawString(left, y, title[:60])
    y -= 5 * mm
    pdf.setFillColorRGB(*grey)
    pdf.setFont('Helvetica', 9)
    pdf.drawString(left, y, f'{number[:32]}' if number else kind.title())
    y -= 4.5 * mm
    pdf.drawString(left, y, f'Date: {dated}' if dated else f'Currency: {currency}')
    card_top = y + 13 * mm
    pdf.setFillColorRGB(*brand_light)
    pdf.roundRect(right - 68 * mm, card_top - 15 * mm, 68 * mm, 17 * mm, 2.5 * mm, stroke=0, fill=1)
    pdf.setFillColorRGB(*grey)
    pdf.setFont('Helvetica-Bold', 8)
    pdf.drawRightString(right - 4 * mm, card_top - 4 * mm, total_label.upper())
    pdf.setFillColorRGB(*brand_dark)
    pdf.setFont('Helvetica-Bold', 14)
    pdf.drawRightString(right - 4 * mm, card_top - 11 * mm, f'{currency} {_money(document.get("total", ""))}'.strip()[:34])
    y -= 8 * mm

    # Customer row.
    pdf.setFillColorRGB(*grey)
    pdf.setFont('Helvetica', 9)
    pdf.drawString(left, y, f'Billed to: {customer}'[:72])
    if currency:
        pdf.drawRightString(right, y, f'Currency: {currency}')
    y -= 8 * mm

    # Line items.
    y = table_head(y)
    pdf.setFillColorRGB(*ink)
    pdf.setFont('Helvetica', 9.5)
    lines = document.get('lines', []) or []
    if not lines:
        pdf.drawString(left + 12 * mm, y, 'No lines.')
        y -= 7 * mm
    for index, line in enumerate(lines):
        if y < 36 * mm:
            footer(page)
            pdf.showPage()
            page += 1
            header_bar()
            y = height - 22 * mm
            y = table_head(y)
            pdf.setFillColorRGB(*ink)
            pdf.setFont('Helvetica', 9.5)
        if index % 2 == 1:
            pdf.setFillColorRGB(0.96, 0.96, 0.95)
            pdf.rect(left, y - 2.5 * mm, right - left, 7 * mm, stroke=0, fill=1)
            pdf.setFillColorRGB(*ink)
        pdf.drawString(left + 4 * mm, y, str(index + 1))
        pdf.drawString(left + 12 * mm, y, str(line.get('product', ''))[:40])
        pdf.drawRightString(right - 64 * mm, y, _qty(line.get('quantity', '')))
        pdf.drawRightString(right - 34 * mm, y, _money(line.get('unit_price', '')))
        pdf.drawRightString(right - 4 * mm, y, _money(line.get('line_total', '')))
        y -= 7 * mm

    # Totals block.
    y -= 1 * mm
    totals_right = right - 4 * mm
    if document.get('subtotal') and document.get('subtotal') != document.get('total'):
        pdf.setFillColorRGB(*grey)
        pdf.setFont('Helvetica', 10)
        pdf.drawRightString(totals_right, y, f"Subtotal: {currency} {_money(document.get('subtotal'))}".strip())
        y -= 6 * mm
    pdf.setStrokeColorRGB(*brand_dark)
    pdf.setLineWidth(0.6)
    pdf.line(right - 68 * mm, y + 3 * mm, right, y + 3 * mm)
    pdf.setFillColorRGB(*brand_dark)
    pdf.setFont('Helvetica-Bold', 13)
    pdf.drawRightString(totals_right, y - 2 * mm, f"Total: {currency} {_money(document.get('total', ''))}".strip())
    y -= 10 * mm

    pdf.setFillColorRGB(*grey)
    pdf.setFont('Helvetica-Oblique', 8.5)
    pdf.drawString(left, max(y, 24 * mm), 'Thank you for your business.')
    footer(page)
    pdf.showPage()
    pdf.save()
    return buffer.getvalue()
