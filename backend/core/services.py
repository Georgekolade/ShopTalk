"""Deterministic transaction services. All money and stock math lives here.

The AI layer and the views may only call these functions. They validate,
calculate server-side, write atomically, and log every outcome.
"""

from datetime import date, timedelta
from decimal import Decimal, InvalidOperation

from django.db import IntegrityError, transaction
from django.db.models import Sum
from django.utils import timezone
from rest_framework.exceptions import ValidationError

from .errors import ConflictError
from .models import (
    ActionLog,
    BusinessRule,
    Customer,
    Expense,
    ProductService,
    Purchase,
    PurchaseItem,
    Receipt,
    Sale,
    SaleItem,
    StockBalance,
    StockMovement,
    Supplier,
)


def _money(value):
    return Decimal(value).quantize(Decimal('0.01'))


def _qty(value):
    return Decimal(value).quantize(Decimal('0.001'))


def _to_decimal(raw, field):
    try:
        return Decimal(str(raw))
    except (InvalidOperation, TypeError, ValueError):
        raise ValidationError({field: f'Not a number: {raw!r}.'})


def available_stock(business, product):
    total = StockBalance.objects.filter(business=business, product=product).aggregate(
        total=Sum('quantity')
    )['total']
    return total or Decimal('0')


def _get_product(business, product_id):
    try:
        return ProductService.objects.get(pk=product_id, business=business)
    except (ProductService.DoesNotExist, ValueError, TypeError):
        raise ValidationError({'items': f'Unknown item: {product_id}.'})


def _log(business, user, action_type, status, summary='', record=None, request_id=''):
    return ActionLog.objects.create(
        business=business,
        actor=user,
        action_type=action_type,
        status=status,
        summary=summary,
        record_type=record.__class__.__name__ if record is not None else '',
        record_ref=str(record.pk) if record is not None else '',
        request_id=request_id or '',
    )


def prepare_sale(*, business, user, items, customer_id=None, idempotency_key):
    """Validate a sale and save it as prepared. Replay returns the original."""
    if not idempotency_key:
        raise ValidationError({'idempotency_key': 'Required.'})
    existing = Sale.objects.filter(
        business=business, idempotency_key=idempotency_key
    ).first()
    if existing is not None:
        return existing, False
    if not items:
        raise ValidationError({'items': 'At least one item is required.'})
    customer = None
    if customer_id is not None:
        try:
            customer = Customer.objects.get(pk=customer_id, business=business)
        except (Customer.DoesNotExist, ValueError, TypeError):
            raise ValidationError({'customer_id': 'Unknown customer.'})
    lines = []
    subtotal = Decimal('0')
    for index, raw in enumerate(items):
        quantity = _to_decimal(raw.get('quantity'), 'items')
        if quantity <= 0:
            raise ValidationError({'items': f'Row {index}: quantity must be above zero.'})
        product = _get_product(business, raw.get('product_id'))
        if not product.active:
            raise ValidationError({'items': f'{product.name} is not on sale.'})
        if product.stock_tracked:
            on_hand = available_stock(business, product)
            if on_hand < quantity:
                raise ValidationError(
                    {
                        'items': (
                            f'Only {on_hand} of {product.name} in stock. '
                            'Reduce the quantity or receive stock first.'
                        )
                    }
                )
        line_total = _money(product.selling_price * quantity)
        subtotal += line_total
        lines.append((product, _qty(quantity), product.selling_price, line_total))
    subtotal = _money(subtotal)
    with transaction.atomic():
        try:
            sale = Sale.objects.create(
                business=business,
                customer=customer,
                status=Sale.STATUS_PREPARED,
                subtotal=subtotal,
                total=subtotal,
                idempotency_key=idempotency_key,
                sold_by=user,
            )
        except IntegrityError:
            sale = Sale.objects.get(business=business, idempotency_key=idempotency_key)
            return sale, False
        SaleItem.objects.bulk_create(
            [
                SaleItem(
                    sale=sale,
                    product=product,
                    quantity=quantity,
                    unit_price=unit_price,
                    line_total=line_total,
                )
                for product, quantity, unit_price, line_total in lines
            ]
        )
        _log(business, user, 'sale_prepare', ActionLog.STATUS_DRAFT,
             f'Prepared sale of {subtotal}.', record=sale, request_id=idempotency_key)
    return sale, True


def _revalidate_sale_items(sale):
    problems = []
    for item in sale.items.select_related('product'):
        product = item.product
        if not product.active:
            problems.append(f'{product.name} is not on sale.')
        elif product.stock_tracked:
            on_hand = available_stock(sale.business, product)
            if on_hand < item.quantity:
                problems.append(f'Only {on_hand} of {product.name} in stock.')
    return problems


def commit_sale(*, business, user, sale):
    """Commit a prepared sale atomically. Writes stock, receipt, audit together."""
    if sale.business_id != business.pk:
        raise ValidationError({'sale': 'Unknown sale.'})
    if sale.status == Sale.STATUS_COMMITTED:
        raise ConflictError('This sale is already committed.')
    if sale.status == Sale.STATUS_CANCELLED:
        raise ConflictError('This sale was cancelled.')
    problems = _revalidate_sale_items(sale)
    if problems:
        _log(business, user, 'sale_commit', ActionLog.STATUS_FAILED,
             '; '.join(problems), record=sale)
        raise ValidationError({'items': problems[0]})
    try:
        with transaction.atomic():
            locked = Sale.objects.select_for_update().get(pk=sale.pk)
            if locked.status != Sale.STATUS_PREPARED:
                raise ConflictError('This sale is no longer prepared.')
            for item in locked.items.select_related('product'):
                product = item.product
                if product.stock_tracked:
                    balance, _ = StockBalance.objects.select_for_update().get_or_create(
                        business=business, product=product, location='',
                        defaults={'quantity': Decimal('0')},
                    )
                    if balance.quantity < item.quantity:
                        raise ValidationError(
                            {'items': f'Only {balance.quantity} of {product.name} in stock.'}
                        )
                    balance.quantity = _qty(balance.quantity - item.quantity)
                    balance.save(update_fields=['quantity'])
                    StockMovement.objects.create(
                        business=business,
                        product=product,
                        movement_type=StockMovement.TYPE_SALE,
                        quantity=item.quantity,
                        reference=f'sale:{locked.pk}',
                        actor=user,
                    )
            locked.status = Sale.STATUS_COMMITTED
            locked.sold_at = timezone.now()
            locked.save(update_fields=['status', 'sold_at', 'updated_at'])
            receipt = Receipt.objects.create(
                business=business,
                sale=locked,
                receipt_number=f'R-{locked.pk:06d}',
                document={
                    'receipt_number': f'R-{locked.pk:06d}',
                    'business': business.name,
                    'sold_at': locked.sold_at.isoformat(),
                    'lines': [
                        {
                            'product': item.product.name,
                            'quantity': str(item.quantity),
                            'unit_price': str(item.unit_price),
                            'line_total': str(item.line_total),
                        }
                        for item in locked.items.select_related('product')
                    ],
                    'subtotal': str(locked.subtotal),
                    'total': str(locked.total),
                },
                issued_by=user,
            )
            _log(business, user, 'sale_commit', ActionLog.STATUS_COMPLETED,
                 f'Committed sale of {locked.total}. Receipt {receipt.receipt_number}.',
                 record=locked)
    except ValidationError as exc:
        _log(business, user, 'sale_commit', ActionLog.STATUS_FAILED,
             str(exc.detail), record=sale)
        raise
    sale.refresh_from_db()
    return sale


def receive_stock(*, business, user, items, supplier_id=None, idempotency_key):
    """Record a stock receipt. Balances rise only here, with movements to prove it."""
    if not idempotency_key:
        raise ValidationError({'idempotency_key': 'Required.'})
    existing = Purchase.objects.filter(
        business=business, idempotency_key=idempotency_key
    ).first()
    if existing is not None:
        return existing, False, []
    if not items:
        raise ValidationError({'items': 'At least one item is required.'})
    supplier = None
    if supplier_id is not None:
        try:
            supplier = Supplier.objects.get(pk=supplier_id, business=business)
        except (Supplier.DoesNotExist, ValueError, TypeError):
            raise ValidationError({'supplier_id': 'Unknown supplier.'})
    lines = []
    warnings = []
    total = Decimal('0')
    for index, raw in enumerate(items):
        quantity = _to_decimal(raw.get('quantity'), 'items')
        if quantity <= 0:
            raise ValidationError({'items': f'Row {index}: quantity must be above zero.'})
        product = _get_product(business, raw.get('product_id'))
        if not product.active:
            raise ValidationError({'items': f'{product.name} is not active.'})
        unit_cost = None
        if raw.get('unit_cost') not in (None, ''):
            unit_cost = _to_decimal(raw.get('unit_cost'), 'items')
            if unit_cost < 0:
                raise ValidationError({'items': f'Row {index}: cost must be zero or more.'})
        if unit_cost is None:
            warnings.append(f'{product.name}: cost missing, line valued at zero.')
        line_total = _money((unit_cost or Decimal('0')) * quantity)
        total += line_total
        lines.append((product, _qty(quantity), unit_cost or Decimal('0'), line_total))
    with transaction.atomic():
        try:
            purchase = Purchase.objects.create(
                business=business,
                supplier=supplier,
                status=Purchase.STATUS_RECEIVED,
                total=_money(total),
                idempotency_key=idempotency_key,
                received_by=user,
            )
        except IntegrityError:
            purchase = Purchase.objects.get(
                business=business, idempotency_key=idempotency_key
            )
            return purchase, False, []
        PurchaseItem.objects.bulk_create(
            [
                PurchaseItem(
                    purchase=purchase,
                    product=product,
                    quantity=quantity,
                    unit_cost=unit_cost,
                    line_total=line_total,
                    quantity_received=quantity,
                )
                for product, quantity, unit_cost, line_total in lines
            ]
        )
        for product, quantity, _, _ in lines:
            if product.stock_tracked:
                balance, _ = StockBalance.objects.select_for_update().get_or_create(
                    business=business, product=product, location='',
                    defaults={'quantity': Decimal('0')},
                )
                balance.quantity = _qty(balance.quantity + quantity)
                balance.save(update_fields=['quantity'])
                StockMovement.objects.create(
                    business=business,
                    product=product,
                    movement_type=StockMovement.TYPE_PURCHASE,
                    quantity=quantity,
                    reference=f'purchase:{purchase.pk}',
                    actor=user,
                )
        _log(business, user, 'stock_receipt', ActionLog.STATUS_COMPLETED,
             f'Received {len(lines)} lines worth {total}.', record=purchase,
             request_id=idempotency_key)
    return purchase, True, warnings


def record_expense(*, business, user, amount, category, description='', day=None):
    """Save one expense and audit it."""
    amount = _to_decimal(amount, 'amount')
    if amount <= 0:
        raise ValidationError({'amount': 'Amount must be above zero.'})
    if not (category or '').strip():
        raise ValidationError({'category': 'Required.'})
    expense = Expense.objects.create(
        business=business,
        amount=_money(amount),
        category=category.strip(),
        description=(description or '').strip(),
        date=day or date.today(),
        created_by=user,
    )
    _log(business, user, 'expense', ActionLog.STATUS_COMPLETED,
         f'Recorded {expense.amount} for {expense.category}.', record=expense)
    return expense


def _low_stock_threshold(business):
    rule = BusinessRule.objects.filter(
        business=business, rule_type='low_stock_threshold'
    ).first()
    if rule is None:
        return Decimal('10')
    try:
        return Decimal(str(rule.structured_value.get('default', 10)))
    except (InvalidOperation, TypeError, ValueError):
        return Decimal('10')


def get_report(*, business, metric, start, end):
    """Trusted report math. Every figure comes from saved rows, never inference."""
    caveats = []
    if metric == 'sales_total':
        total = Sale.objects.filter(
            business=business, status=Sale.STATUS_COMMITTED,
            sold_at__date__gte=start, sold_at__date__lte=end,
        ).aggregate(total=Sum('total'))['total'] or Decimal('0')
        return {'metric': metric, 'from': str(start), 'to': str(end),
                'value': str(_money(total)), 'caveats': caveats}
    if metric == 'expenses_total':
        total = Expense.objects.filter(
            business=business, date__gte=start, date__lte=end,
        ).aggregate(total=Sum('amount'))['total'] or Decimal('0')
        return {'metric': metric, 'from': str(start), 'to': str(end),
                'value': str(_money(total)), 'caveats': caveats}
    if metric == 'profit':
        items = SaleItem.objects.filter(
            sale__business=business, sale__status=Sale.STATUS_COMMITTED,
            sale__sold_at__date__gte=start, sale__sold_at__date__lte=end,
        ).select_related('product')
        revenue = Decimal('0')
        cogs = Decimal('0')
        skipped = 0
        for item in items:
            revenue += item.line_total
            if item.product.cost_price is None:
                skipped += 1
            else:
                cogs += item.product.cost_price * item.quantity
        if skipped:
            caveats.append(
                f'{skipped} lines lack cost data and are excluded from cost of goods.'
            )
        caveats.append('Profit here means revenue minus cost of goods. Expenses are separate.')
        return {'metric': metric, 'from': str(start), 'to': str(end),
                'value': str(_money(revenue - cogs)),
                'revenue': str(_money(revenue)), 'cogs': str(_money(cogs)),
                'caveats': caveats}
    if metric == 'low_stock':
        threshold = _low_stock_threshold(business)
        rows = []
        tracked = ProductService.objects.filter(
            business=business, stock_tracked=True, active=True
        ).prefetch_related('stock_balances')
        for product in tracked:
            on_hand = sum((b.quantity for b in product.stock_balances.all()), Decimal('0'))
            if on_hand < threshold:
                rows.append({'product': product.name, 'quantity': str(_qty(on_hand)),
                             'threshold': str(threshold)})
        rows.sort(key=lambda row: row['product'])
        caveats.append(f'Threshold {threshold} from business rules (default 10).')
        return {'metric': metric, 'from': str(start), 'to': str(end),
                'rows': rows, 'caveats': caveats}
    raise ValidationError(
        {'metric': 'Must be sales_total, expenses_total, profit, or low_stock.'}
    )


def _period_totals(business, start, end):
    sales = Sale.objects.filter(
        business=business, status=Sale.STATUS_COMMITTED,
        sold_at__date__gte=start, sold_at__date__lte=end,
    ).aggregate(total=Sum('total'))['total'] or Decimal('0')
    expenses = Expense.objects.filter(
        business=business, date__gte=start, date__lte=end,
    ).aggregate(total=Sum('amount'))['total'] or Decimal('0')
    report = get_report(business=business, metric='profit', start=start, end=end)
    return {
        'sales': str(_money(sales)), 'expenses': str(_money(expenses)),
        'profit': report['value'], 'revenue': report['revenue'], 'cogs': report['cogs'],
    }


def _delta(current, previous):
    cur, prev = Decimal(str(current)), Decimal(str(previous))
    if prev == 0:
        return None if cur == 0 else 100.0
    return round(float((cur - prev) / abs(prev) * Decimal('100')), 1)


def get_analytics(*, business, start, end, granularity='day'):
    """Timeseries + previous-period comparison. Deterministic, DB-only."""
    if granularity not in ('day', 'week', 'month'):
        raise ValidationError({'granularity': 'Must be day, week, or month.'})
    if end < start:
        raise ValidationError({'to': 'End date is before start date.'})
    sales_rows = {}
    for sale in Sale.objects.filter(
        business=business, status=Sale.STATUS_COMMITTED,
        sold_at__date__gte=start, sold_at__date__lte=end,
    ).order_by('sold_at'):
        day = sale.sold_at.date()
        sales_rows[day] = sales_rows.get(day, Decimal('0')) + sale.total
    expense_rows = {}
    for expense in Expense.objects.filter(business=business, date__gte=start, date__lte=end):
        expense_rows[expense.date] = expense_rows.get(expense.date, Decimal('0')) + expense.amount

    def bucket(day):
        if granularity == 'day':
            return day
        if granularity == 'week':
            return day - timedelta(days=day.weekday())
        return day.replace(day=1)

    buckets = {}
    cursor = start
    while cursor <= end:
        buckets.setdefault(bucket(cursor), {'sales': Decimal('0'), 'expenses': Decimal('0')})
        cursor += timedelta(days=1)
    for day, total in sales_rows.items():
        buckets[bucket(day)]['sales'] += total
    for day, total in expense_rows.items():
        buckets[bucket(day)]['expenses'] += total
    series = [
        {'period': str(key), 'sales': str(_money(v['sales'])),
         'expenses': str(_money(v['expenses'])),
         'profit': str(_money(v['sales'] - v['expenses']))}
        for key, v in sorted(buckets.items())
    ]
    span = (end - start).days + 1
    prev_end = start - timedelta(days=1)
    prev_start = prev_end - timedelta(days=span - 1)
    current, previous = _period_totals(business, start, end), _period_totals(business, prev_start, prev_end)
    comparison = {
        key: {'current': current[key], 'previous': previous[key],
              'delta_pct': _delta(current[key], previous[key])}
        for key in ('sales', 'expenses', 'profit')
    }
    top = (
        SaleItem.objects.filter(
            sale__business=business, sale__status=Sale.STATUS_COMMITTED,
            sale__sold_at__date__gte=start, sale__sold_at__date__lte=end,
        ).values('product__name')
        .annotate(revenue=Sum('line_total'), qty=Sum('quantity'))
        .order_by('-revenue')[:5]
    )
    return {
        'from': str(start), 'to': str(end), 'granularity': granularity,
        'series': series, 'totals': current,
        'previous': {'from': str(prev_start), 'to': str(prev_end), **previous},
        'comparison': comparison,
        'top_products': [
            {'product': row['product__name'], 'revenue': str(_money(row['revenue'])),
             'quantity': str(_qty(row['qty']))}
            for row in top
        ],
        'caveats': ['Profit in totals is revenue minus cost of goods; chart profit is sales minus expenses per period.'],
    }
