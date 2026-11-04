"""Typed assistant tools. PRD 9.3 contracts.

Every tool runs tenant-scoped through the service layer. Read tools return
facts. Write tools validate; the orchestrator holds them for confirmation.
"""

from datetime import date, timedelta
from decimal import Decimal, InvalidOperation

from django.db.models import Q
from rest_framework.exceptions import PermissionDenied, ValidationError

from .models import (
    BusinessMembership,
    BusinessRule,
    Customer,
    ProductService,
    Supplier,
)
from .documents import ensure_invoice, receipt_payload
from .services import (
    available_stock,
    commit_sale,
    get_analytics,
    get_report,
    prepare_sale,
    receive_stock,
    record_expense,
)
from .models import Expense, Purchase, Sale


def _require(business, user, permission, message):
    from .permissions import member_has

    membership = BusinessMembership.objects.filter(
        business=business, user=user, status=BusinessMembership.STATUS_ACTIVE
    ).first()
    if membership is None or not member_has(membership, permission):
        raise PermissionDenied(message)


def _manager_only(business, user):
    _require(business, user, 'expenses.write',
             'Only owners and managers can do this.')


def get_business_context(*, business, user):
    rules = [
        {
            'rule_type': rule.rule_type,
            'structured_value': rule.structured_value,
            'source': rule.source,
            'verified': rule.verified,
        }
        for rule in BusinessRule.objects.filter(business=business)
    ]
    return {
        'business': {
            'id': business.pk,
            'name': business.name,
            'business_type': business.business_type,
            'currency': business.currency,
            'timezone': business.timezone,
            'enabled_modules': business.enabled_modules,
        },
        'counts': {
            'products': ProductService.objects.filter(business=business).count(),
            'customers': Customer.objects.filter(business=business).count(),
            'suppliers': Supplier.objects.filter(business=business).count(),
        },
        'rules': rules,
    }


def search_products(*, business, user, query):
    text = (query or '').strip()
    if not text:
        raise ValidationError({'query': 'Required.'})
    words = [w for w in text.lower().split() if len(w) > 1]
    found = ProductService.objects.filter(business=business, active=True).order_by('name')
    scored = []
    for product in found:
        haystack = ' '.join([product.name, *product.aliases]).lower()
        if text.lower() in haystack:
            scored.append((0, product))
        elif words and all(w in haystack for w in words):
            scored.append((1, product))
    scored.sort(key=lambda pair: (pair[0], pair[1].name.lower()))
    return {
        'query': text,
        'matches': [
            {
                'product_id': product.pk,
                'name': product.name,
                'kind': product.kind,
                'selling_price': str(product.selling_price),
                'stock_tracked': product.stock_tracked,
                'on_hand': str(available_stock(business, product))
                if product.stock_tracked
                else None,
            }
            for _, product in scored[:10]
        ],
    }


def check_stock(*, business, user, product_id):
    try:
        product = ProductService.objects.get(pk=product_id, business=business)
    except (ProductService.DoesNotExist, ValueError, TypeError):
        raise ValidationError({'product_id': 'Unknown item.'})
    return {
        'product_id': product.pk,
        'name': product.name,
        'stock_tracked': product.stock_tracked,
        'on_hand': str(available_stock(business, product))
        if product.stock_tracked
        else None,
        'active': product.active,
    }


def _sale_preview(sale):
    return {
        'sale_id': sale.pk,
        'status': sale.status,
        'subtotal': str(sale.subtotal),
        'total': str(sale.total),
        'lines': [
            {
                'product': item.product.name,
                'product_id': item.product_id,
                'quantity': str(item.quantity),
                'unit_price': str(item.unit_price),
                'line_total': str(item.line_total),
            }
            for item in sale.items.select_related('product')
        ],
    }


def prepare_sale_tool(*, business, user, items, customer_id=None, idempotency_key):
    _require(business, user, 'sales.write',
             'Your role cannot record sales. Ask an owner, manager, or sales staff.')
    sale, created = prepare_sale(
        business=business,
        user=user,
        items=items,
        customer_id=customer_id,
        idempotency_key=idempotency_key,
    )
    preview = _sale_preview(sale)
    preview['replayed'] = not created
    return preview


def confirm_and_record_sale(*, business, user, sale_id, confirmation):
    try:
        sale = Sale.objects.get(pk=sale_id, business=business)
    except (Sale.DoesNotExist, ValueError, TypeError):
        raise ValidationError({'sale_id': 'Unknown sale.'})
    if not confirmation:
        if sale.status == Sale.STATUS_PREPARED:
            sale.status = Sale.STATUS_CANCELLED
            sale.save(update_fields=['status', 'updated_at'])
        return {'sale_id': sale.pk, 'status': sale.status, 'cancelled': True}
    _require(business, user, 'sales.write',
             'Your role cannot record sales. Ask an owner, manager, or sales staff.')
    sale = commit_sale(business=business, user=user, sale=sale)
    receipt = sale.receipts.order_by('-pk').first()
    return {
        'sale_id': sale.pk,
        'status': sale.status,
        'total': str(sale.total),
        'receipt_number': receipt.receipt_number if receipt else None,
        'receipt': receipt.document if receipt else None,
    }


def receive_stock_tool(*, business, user, items, supplier_id=None, idempotency_key):
    _require(business, user, 'stock.write',
             'Your role cannot receive stock. Ask an owner, manager, or inventory staff.')
    purchase, created, warnings = receive_stock(
        business=business,
        user=user,
        items=items,
        supplier_id=supplier_id,
        idempotency_key=idempotency_key,
    )
    return {
        'purchase_id': purchase.pk,
        'status': purchase.status,
        'total': str(purchase.total),
        'replayed': not created,
        'warnings': warnings,
        'lines': [
            {
                'product': item.product.name,
                'quantity': str(item.quantity),
                'unit_cost': str(item.unit_cost),
                'line_total': str(item.line_total),
            }
            for item in purchase.items.select_related('product')
        ],
    }


def record_expense_tool(*, business, user, amount, category, description='', day=None):
    _manager_only(business, user)
    if isinstance(day, str):
        try:
            day = date.fromisoformat(day)
        except ValueError:
            raise ValidationError({'date': 'Use YYYY-MM-DD.'})
    expense = record_expense(
        business=business, user=user, amount=amount, category=category,
        description=description, day=day,
    )
    return {
        'expense_id': expense.pk,
        'amount': str(expense.amount),
        'category': expense.category,
        'description': expense.description,
        'date': str(expense.date),
    }


def add_catalogue_item_tool(*, business, user, name, selling_price, kind='product',
                            cost_price=None, stock_tracked=False, aliases=None):
    """Create one catalogue item. Owner, manager, or inventory staff."""
    _require(business, user, 'catalogue.write',
             'Your role cannot manage the catalogue. Ask an owner, manager, or inventory staff.')
    name = (name or '').strip()
    if not name:
        raise ValidationError({'name': 'Give the item a name.'})
    kind = (kind or 'product').strip().lower()
    if kind not in ('product', 'service'):
        raise ValidationError({'kind': 'Must be product or service.'})
    try:
        price = Decimal(str(selling_price))
    except (InvalidOperation, ValueError, TypeError):
        raise ValidationError({'selling_price': 'Must be a number.'})
    if price < 0:
        raise ValidationError({'selling_price': 'Must be zero or more.'})
    cost = None
    if cost_price is not None and str(cost_price).strip() != '':
        try:
            cost = Decimal(str(cost_price))
        except (InvalidOperation, ValueError, TypeError):
            raise ValidationError({'cost_price': 'Must be a number.'})
        if cost < 0:
            raise ValidationError({'cost_price': 'Must be zero or more.'})
    if ProductService.objects.filter(business=business, name__iexact=name).exists():
        raise ValidationError({'name': f'"{name}" is already in the catalogue.'})
    clean_aliases = []
    for alias in aliases or []:
        alias = str(alias).strip()
        if alias and alias.lower() != name.lower() and alias not in clean_aliases:
            clean_aliases.append(alias)
    product = ProductService.objects.create(
        business=business, name=name, aliases=clean_aliases, kind=kind,
        selling_price=price, cost_price=cost,
        stock_tracked=bool(stock_tracked), active=True,
    )
    return {
        'product_id': product.pk,
        'name': product.name,
        'kind': product.kind,
        'selling_price': str(product.selling_price),
        'cost_price': str(product.cost_price) if product.cost_price is not None else None,
        'stock_tracked': product.stock_tracked,
    }


def search_knowledge_tool(*, business, user, query):
    """Search owner-taught documents for this business only."""
    from .knowledge import search_documents
    from .models import KnowledgeDocument

    text = (query or '').strip()
    if not text:
        raise ValidationError({'query': 'Required.'})
    docs = KnowledgeDocument.objects.filter(business=business).order_by('-created_at', '-pk')
    return search_documents(docs, text)


def get_business_report_tool(*, business, user, metric, start=None, end=None):
    _require(business, user, 'reports.view',
             'Your role cannot view reports. Ask an owner or manager.')
    end = end or date.today()
    start = start or (end - timedelta(days=29))
    if isinstance(start, str):
        try:
            start = date.fromisoformat(start)
        except ValueError:
            raise ValidationError({'from': 'Use YYYY-MM-DD.'})
    if isinstance(end, str):
        try:
            end = date.fromisoformat(end)
        except ValueError:
            raise ValidationError({'to': 'Use YYYY-MM-DD.'})
    return get_report(business=business, metric=metric, start=start, end=end)


def get_sale_documents_tool(*, business, user, sale_id=None):
    """Receipt + invoice numbers and PDF links for one sale.

    Defaults to the latest committed sale so "send me the invoice"
    works right after a sale. Business-scoped; never another business.
    """
    sales = Sale.objects.filter(business=business, status=Sale.STATUS_COMMITTED)
    if sale_id is not None:
        try:
            sale = sales.get(pk=int(sale_id))
        except (Sale.DoesNotExist, ValueError, TypeError):
            raise ValidationError({'sale_id': 'Unknown sale.'})
    else:
        sale = sales.order_by('-sold_at', '-pk').first()
        if sale is None:
            raise ValidationError({'sale': 'No committed sales yet.'})
    payload = receipt_payload(business, sale)
    invoice, _ = ensure_invoice(business=business, user=user, sale=sale)
    document = (payload or {}).get('document', {}) if payload else {}
    return {
        'sale_id': sale.pk,
        'receipt_number': payload['receipt_number'] if payload else None,
        'invoice_number': invoice.invoice_number,
        'total': str(sale.total),
        'lines': [
            {'product': line.get('product', ''), 'quantity': line.get('quantity', ''),
             'line_total': line.get('line_total', '')}
            for line in document.get('lines', [])
        ],
        'receipt_url': f'/api/businesses/{business.pk}/sales/{sale.pk}/receipt.pdf',
        'invoice_url': f'/api/businesses/{business.pk}/sales/{sale.pk}/invoice.pdf',
    }


def get_sales_trend_tool(*, business, user, start=None, end=None, granularity='week'):
    """Period-by-period sales vs expenses plus totals and prior-period deltas."""
    _require(business, user, 'reports.view',
             'Your role cannot view reports. Ask an owner or manager.')
    end = end or date.today()
    start = start or (end - timedelta(days=29))
    if isinstance(start, str):
        try:
            start = date.fromisoformat(start)
        except ValueError:
            raise ValidationError({'from': 'Use YYYY-MM-DD.'})
    if isinstance(end, str):
        try:
            end = date.fromisoformat(end)
        except ValueError:
            raise ValidationError({'to': 'Use YYYY-MM-DD.'})
    if granularity not in ('day', 'week', 'month'):
        raise ValidationError({'granularity': 'Must be day, week, or month.'})
    data = get_analytics(business=business, start=start, end=end,
                         granularity=granularity)
    return {
        'from': data['from'], 'to': data['to'],
        'granularity': data['granularity'],
        'series': data['series'],
        'totals': data['totals'],
        'previous': {k: data['previous'][k] for k in ('sales', 'expenses', 'profit')},
        'comparison': data['comparison'],
        'top_products': data['top_products'],
        'caveats': data['caveats'],
    }


TOOL_SPECS = [
    {
        'name': 'get_business_context',
        'description': 'Business profile, counts, and verified rules. No arguments.',
        'params': {},
    },
    {
        'name': 'search_products',
        'description': 'Find catalogue items by name or alias.',
        'params': {'query': 'text to match against names and aliases'},
    },
    {
        'name': 'check_stock',
        'description': 'Current stock for one product.',
        'params': {'product_id': 'catalogue item id'},
    },
    {
        'name': 'prepare_sale',
        'description': 'Validate items and compute server-side totals. Nothing final.',
        'params': {
            'items': 'list of {product_id, quantity}',
            'customer_id': 'optional customer id',
            'idempotency_key': 'client key, replay-safe',
        },
    },
    {
        'name': 'confirm_and_record_sale',
        'description': 'Commit or cancel a prepared sale.',
        'params': {'sale_id': 'prepared sale id', 'confirmation': 'true commits'},
    },
    {
        'name': 'receive_stock',
        'description': 'Record a stock receipt. Owner, manager, or inventory.',
        'params': {
            'items': 'list of {product_id, quantity, unit_cost?}',
            'supplier_id': 'optional supplier id',
            'idempotency_key': 'client key, replay-safe',
        },
    },
    {
        'name': 'record_expense',
        'description': 'Record one expense. Owner or manager.',
        'params': {
            'amount': 'decimal above zero',
            'category': 'required label',
            'description': 'optional note',
            'day': 'optional YYYY-MM-DD, default today',
        },
    },
    {
        'name': 'get_business_report',
        'description': 'Trusted metric for a date range.',
        'params': {
            'metric': 'sales_total | expenses_total | profit | low_stock',
            'start': 'optional YYYY-MM-DD',
            'end': 'optional YYYY-MM-DD',
        },
    },
    {
        'name': 'get_sale_documents',
        'description': 'Receipt and invoice numbers plus PDF links for one sale. Defaults to the latest committed sale.',
        'params': {'sale_id': 'optional sale id'},
    },
    {
        'name': 'search_knowledge',
        'description': 'Search owner-taught business documents (policies, price lists, supplier notes) by keywords. Returns grounded excerpts with document titles.',
        'params': {'query': 'keywords or question to search the documents for'},
    },
    {
        'name': 'get_sales_trend',
        'description': 'Period-by-period sales vs expenses, totals, prior-period deltas, top products.',
        'params': {
            'start': 'optional YYYY-MM-DD',
            'end': 'optional YYYY-MM-DD',
            'granularity': 'day | week | month, default week',
        },
    },
]

_TOOLS = {
    'get_business_context': get_business_context,
    'search_products': search_products,
    'check_stock': check_stock,
    'prepare_sale': prepare_sale_tool,
    'confirm_and_record_sale': confirm_and_record_sale,
    'receive_stock': receive_stock_tool,
    'record_expense': record_expense_tool,
    'add_catalogue_item': add_catalogue_item_tool,
    'get_business_report': get_business_report_tool,
    'get_sale_documents': get_sale_documents_tool,
    'get_sales_trend': get_sales_trend_tool,
    'search_knowledge': search_knowledge_tool,
}

READ_TOOLS = frozenset(
    {'get_business_context', 'search_products', 'check_stock', 'get_business_report',
     'get_sale_documents', 'get_sales_trend', 'search_knowledge'}
)
WRITE_INTENTS = frozenset({'prepare_sale', 'receive_stock', 'record_expense', 'add_catalogue_item'})


def execute_tool(*, business, user, name, args):
    """Run one typed tool. Unknown names and Q objects never reach the DB raw."""
    func = _TOOLS.get(name)
    if func is None:
        raise ValidationError({'tool': f'Unknown tool: {name}.'})
    if not isinstance(args, dict):
        raise ValidationError({'tool': 'Tool arguments must be an object.'})
    for value in args.values():
        if isinstance(value, Q):
            raise ValidationError({'tool': 'Bad tool argument.'})
    return func(business=business, user=user, **args)
