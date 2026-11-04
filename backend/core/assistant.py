"""Assistant orchestration. Providers plan, tools act, templates explain.

Reads execute at once. Writes prepare a PendingAction and wait. Nothing is
committed without an explicit confirm, and every reply comes from tool output.
"""

import difflib
import re
import uuid
from decimal import Decimal, InvalidOperation

from django.http import Http404
from rest_framework.exceptions import ValidationError

from .ai import LLMProvider, ProviderError, fallback_plan, get_provider
from .models import ActionLog, Conversation, Message, PendingAction, ProductService
from .tools import READ_TOOLS, WRITE_INTENTS, execute_tool


def _log_tool(business, user, name, status, summary, request_id=''):
    return ActionLog.objects.create(
        business=business,
        actor=user,
        action_type=f'tool:{name}',
        status=status,
        summary=summary[:500],
        request_id=request_id,
    )


def _conversation(business, user, conversation_id):
    if conversation_id is None:
        return Conversation.objects.create(business=business, user=user)
    try:
        return Conversation.objects.get(
            pk=conversation_id, business=business, user=user
        )
    except (Conversation.DoesNotExist, ValueError, TypeError):
        raise Http404('Conversation not found.')


def _awaiting(business, conversation):
    return list(
        PendingAction.objects.filter(
            business=business,
            conversation=conversation,
            state=PendingAction.STATE_AWAITING,
        ).order_by('created_at', 'pk')
    )


def _clean_knowledge(raw):
    """Owner-taught business facts from Business.settings['knowledge'].

    Accepts a dict of short facts or one free-text string. Bounded so the
    prompt stays small; never raises on odd shapes.
    """
    if isinstance(raw, str):
        return raw.strip()[:1000]
    if isinstance(raw, dict):
        cleaned = {}
        for key, value in list(raw.items())[:20]:
            if isinstance(value, (str, int, float)):
                cleaned[str(key)[:40]] = str(value).strip()[:300]
            elif isinstance(value, list):
                cleaned[str(key)[:40]] = ', '.join(
                    str(item).strip()[:80] for item in value[:8])
        return cleaned
    return {}


def _context(business, conversation, user=None):
    """Everything the AI partner may know this turn, business-scoped only.

    Layers: identity/profile, today in the business timezone, who is asking,
    owner-taught knowledge + verified rules, live catalogue/stock snapshot.
    This context informs replies; facts in answers still come from tools.
    """
    from datetime import datetime
    from decimal import Decimal
    from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

    from django.db.models import Sum

    from .models import (
        BusinessMembership, BusinessRule, Customer, Expense,
        KnowledgeDocument, ProductService, Supplier,
    )

    awaiting = _awaiting(business, conversation)
    try:
        tz = ZoneInfo(business.timezone or 'UTC')
    except (ZoneInfoNotFoundError, ValueError):
        tz = ZoneInfo('UTC')
    now = datetime.now(tz)

    role = ''
    if user is not None:
        membership = BusinessMembership.objects.filter(
            business=business, user=user,
            status=BusinessMembership.STATUS_ACTIVE,
        ).first()
        role = membership.role if membership else ''

    threshold = Decimal('10')
    threshold_rule = BusinessRule.objects.filter(
        business=business, rule_type='low_stock_threshold').first()
    if threshold_rule is not None:
        try:
            threshold = Decimal(str(threshold_rule.structured_value.get('default', 10)))
        except Exception:
            threshold = Decimal('10')

    products = list(
        ProductService.objects.filter(business=business, active=True)
        .annotate(on_hand_total=Sum('stock_balances__quantity'))
        .order_by('name')[:200]
    )
    # PRD data minimisation: small catalogues ride in the packet; large ones
    # stay behind search_products so the model only sees what it needs.
    if len(products) <= 40:
        catalogue = [
            {
                'name': p.name,
                'aliases': [str(a)[:40] for a in (p.aliases or [])[:4]],
                'price': str(p.selling_price),
                'on_hand': str(p.on_hand_total) if p.stock_tracked and p.on_hand_total is not None else None,
            }
            for p in products
        ]
        catalogue_note = ''
    else:
        catalogue = []
        catalogue_note = 'Large catalogue: use search_products for item facts.'
    low_stock = [
        {'name': p.name, 'on_hand': str(p.on_hand_total or Decimal('0'))}
        for p in products
        if p.stock_tracked and (p.on_hand_total or Decimal('0')) < threshold
    ][:10]

    categories = []
    for category in Expense.objects.filter(business=business).order_by('-date', '-pk') \
            .values_list('category', flat=True)[:100]:
        if category and category not in categories:
            categories.append(category)
        if len(categories) >= 12:
            break

    rules = [
        {'rule_type': rule.rule_type, 'value': rule.structured_value}
        for rule in BusinessRule.objects.filter(business=business, verified=True)[:20]
    ]

    settings = business.settings if isinstance(business.settings, dict) else {}
    return {
        'business': {
            'id': business.pk, 'name': business.name,
            'business_type': business.business_type,
            'currency': business.currency,
            'country': business.country,
            'timezone': business.timezone,
        },
        'today': now.date().isoformat(),
        'weekday': now.strftime('%A'),
        'user_role': role,
        'knowledge': _clean_knowledge(settings.get('knowledge')),
        'rules': rules,
        'counts': {
            'products': len(products),
            'customers': Customer.objects.filter(business=business).count(),
            'suppliers': Supplier.objects.filter(business=business).count(),
            'knowledge_documents': KnowledgeDocument.objects.filter(business=business).count(),
        },
        'knowledge_documents': [
            {'id': doc.pk, 'title': doc.title, 'source_type': doc.source_type}
            for doc in KnowledgeDocument.objects.filter(business=business)[:20]
        ],
        'catalogue_sample': catalogue,
        'catalogue_note': catalogue_note,
        'low_stock': low_stock,
        'expense_categories': categories,
        'awaiting_actions': [
            {'id': action.pk, 'action_type': action.action_type,
             'summary': action.summary}
            for action in awaiting
        ],
        'memory': dict(conversation.memory or {}),
    }


def _history(conversation, limit=15):
    """Whole-conversation memory, oldest first, with outcomes attached.

    Every stored turn is kept (nothing trims until Clear Chat deletes the
    conversation). Each turn carries what was said plus what happened, so
    the AI stops re-asking for — or re-doing — settled requests.
    """
    messages = list(conversation.messages.order_by('created_at', 'pk'))
    turns = []
    for m in messages[-limit:]:
        content = m.content
        outcome = _message_outcome(m)
        if outcome:
            content = f'{content} [{outcome}]'
        turns.append({'role': m.role, 'content': content})
    return turns


def _message_outcome(message):
    """Compact what-happened tag from stored message metadata."""
    meta = message.metadata or {}
    docs = meta.get('documents') or {}
    if docs.get('sale_id'):
        total = docs.get('total')
        return f"outcome: recorded sale #{docs['sale_id']}" + (f" total {total}" if total else "")
    state = meta.get('action_state')
    if state == PendingAction.STATE_COMPLETED:
        return 'outcome: user confirmed'
    if state:
        return f'outcome: not completed ({state})'
    if meta.get('pending_action_id'):
        return 'status: awaiting user confirmation'
    return ''


def _memory_event(*, user_text, reply, action, documents):
    """One short line for the rolling summary: what the user said and
    what came of it."""
    user_bit = ' '.join((user_text or '').split())[:120]
    if documents and documents.get('sale_id'):
        return f'user: {user_bit} -> recorded sale #{documents["sale_id"]}'
    if action is not None:
        return f'user: {user_bit} -> awaiting confirmation ({action.action_type})'
    short = ' '.join((reply or '').split())[:160]
    return f'user: {user_bit} -> assistant: {short}'


def _memory_facts(*, tool_runs, documents):
    """Structured facts worth remembering, from tool results — never guessed."""
    facts = {}
    products = []
    for run in tool_runs or []:
        result = run.get('result') or {}
        if run.get('tool') == 'prepare_sale':
            for line in result.get('lines', []) or []:
                product = (line or {}).get('product')
                if product and product not in products:
                    products.append(product)
    if products:
        facts['products'] = products[-8:]
    if documents and documents.get('sale_id'):
        facts['last_sale_id'] = documents['sale_id']
        if documents.get('receipt_number'):
            facts['last_receipt'] = documents['receipt_number']
        if documents.get('total'):
            facts['last_total'] = documents['total']
    return facts


def _record_memory(conversation, business, event='', facts=None):
    """Fold one turn into the conversation memory JSON.

    Memory lives and dies with the conversation: Clear Chat deletes the
    row, otherwise every turn accumulates. Deterministic and offline.
    """
    memory = dict(conversation.memory or {})
    merged = dict(memory.get('facts')) if isinstance(memory.get('facts'), dict) else {}
    for key, value in (facts or {}).items():
        if key == 'products' and isinstance(value, list):
            seen = list(merged.get('products') or [])
            for product in value:
                if product and product not in seen:
                    seen.append(product)
            merged['products'] = seen[-8:]
        elif value is not None:
            merged[key] = value
    summary = memory.get('summary') or ''
    if event:
        summary = f'{summary} | {event}' if summary else event
        summary = summary[-600:]
    awaiting = _awaiting(business, conversation)
    memory['summary'] = summary
    memory['facts'] = merged
    memory['open_thread'] = (
        f"awaiting confirmation: {awaiting[0].summary[:200]}" if awaiting else None
    )
    conversation.memory = memory
    conversation.save(update_fields=['memory', 'updated_at'])


def _mark_action_messages(action):
    """Stamp the preview message(s) with how their action ended, so history
    shows confirmed/declined instead of a forever-open approval."""
    conversation = action.conversation
    if conversation is None:
        return
    for msg in Message.objects.filter(conversation=conversation):
        meta = msg.metadata or {}
        if meta.get('pending_action_id') == action.pk and meta.get('action_state') != action.state:
            meta['action_state'] = action.state
            msg.metadata = meta
            msg.save(update_fields=['metadata'])


def _resolve_lines(*, business, user, lines):
    """Match named lines to catalogue ids. Ambiguous or unknown -> clarify."""
    resolved = []
    for line in lines:
        name = (line.get('name') or '').strip()
        quantity = line.get('quantity')
        if not name or quantity is None:
            return None, 'Say each line with a quantity and item, like "2 garri".'
        result = execute_tool(
            business=business, user=user, name='search_products', args={'query': name}
        )
        matches = result['matches']
        if not matches and name.lower().endswith('s') and len(name) > 3:
            retry = execute_tool(
                business=business, user=user,
                name='search_products', args={'query': name[:-1]},
            )
            matches = retry['matches']
        if not matches:
            return None, f'I do not know "{name}". Check the name or add it to the catalogue first.'
        exact = [m for m in matches if m['name'].lower() == name.lower()]
        if len(exact) == 1:
            picked = exact[0]
        elif len(matches) == 1:
            picked = matches[0]
        else:
            lowered = [m['name'].lower() for m in matches]
            close = difflib.get_close_matches(name.lower(), lowered, n=1, cutoff=0.8)
            if close:
                picked = matches[lowered.index(close[0])]
            else:
                options = ', '.join(f'{m["name"]} ({m["selling_price"]})' for m in matches[:5])
                return None, f'"{name}" matches more than one item: {options}. Which one?'
        resolved.append({'product_id': picked['product_id'], 'quantity': str(quantity)})
    return resolved, ''


def _resolve_product(*, business, name):
    """Match one catalogue name to a product. Ambiguous or unknown -> clarify."""
    query = (name or '').strip()
    if not query:
        return None, 'Which item do you mean?'
    result = execute_tool(
        business=business, user=None, name='search_products', args={'query': query}
    )
    matches = result['matches']
    if not matches:
        return None, f'I do not know "{query}". Check the name or add it to the catalogue first.'
    exact = [m for m in matches if m['name'].lower() == query.lower()]
    if len(exact) == 1:
        return exact[0], ''
    if len(matches) == 1 and not exact:
        return matches[0], ''
    lowered = [m['name'].lower() for m in matches]
    close = difflib.get_close_matches(query.lower(), lowered, n=1, cutoff=0.8)
    if close:
        return matches[lowered.index(close[0])], ''
    options = ', '.join(f"{m['name']} ({m['selling_price']})" for m in matches[:5])
    return None, f'"{query}" matches more than one item: {options}. Which one?'


def _preview_action(*, business, user, conversation, action_type, payload, summary,
                   record_type='', record_ref='', key=None):
    action = PendingAction.objects.create(
        business=business,
        conversation=conversation,
        action_type=action_type,
        state=PendingAction.STATE_AWAITING,
        payload=payload,
        summary=summary,
        record_type=record_type,
        record_ref=record_ref,
        idempotency_key=key or uuid.uuid4().hex,
        created_by=user,
    )
    ActionLog.objects.create(
        business=business,
        actor=user,
        action_type=f'assistant_{action_type}_prepared',
        status=ActionLog.STATUS_AWAITING,
        summary=summary[:500],
        record_type='PendingAction',
        record_ref=str(action.pk),
    )
    return action


def _action_payload(action):
    return {
        'id': action.pk,
        'action_type': action.action_type,
        'state': action.state,
        'summary': action.summary,
        'payload': action.payload,
    }


def _attachment_lines(doc_text):
    """Qty+name lines inside an attached document ('10 Garri 5kg')."""
    from .ai import _parse_qty_name

    lines = []
    for segment in re.split(r'[\n,;]+', doc_text or ''):
        parsed = _parse_qty_name(segment.strip())
        if parsed is None:
            continue
        quantity, name = parsed
        if len(name) >= 2:
            lines.append({'quantity': quantity, 'name': name})
        if len(lines) >= 20:
            break
    return lines


def _attachment_plan(*, instruction, doc_text, filename):
    """Work on one attached document, following the attached instruction.

    Writes only propose (confirm flow unchanged). Questions answer from
    the document text itself. Used offline; a live LLM plans instead and
    falls back here on ProviderError. Document text is data, never rules.
    """
    from types import SimpleNamespace

    from .ai import AMOUNT_RE, Plan
    from .knowledge import search_documents

    lowered = ' '.join((instruction or '').lower().split())
    lines = _attachment_lines(doc_text)
    if lines and any(w in lowered for w in ('stock', 'received', 'receive', 'restock', 'add to stock')):
        return Plan(write_intent='receive_stock', write_args={'lines': lines})
    if lines and any(w in lowered for w in ('sell', 'sale')):
        return Plan(write_intent='prepare_sale', write_args={'lines': lines})
    if 'expense' in lowered or 'spent' in lowered:
        amounts = AMOUNT_RE.findall((doc_text or '').replace(',', '')) or AMOUNT_RE.findall(instruction or '')
        match = re.search(r'\b(?:on|for)\b\s+(.+)$', lowered)
        category = (match.group(1).strip(' ?.') if match else '')
        if amounts and category:
            return Plan(write_intent='record_expense', write_args={
                'amount': amounts[0], 'category': category,
                'description': f'From attached document {filename}',
            })
        if amounts:
            return Plan(clarify=(
                f'I found {amounts[0]} in {filename}. '
                'What expense category should I use, e.g. transport or rent?'
            ))
        return Plan(clarify=f'I could not find an amount in {filename}. How much was the expense?')
    doc = SimpleNamespace(pk=0, title=filename, source_type='attachment', content=doc_text)
    result = search_documents([doc], instruction or 'summary')
    if result['matches']:
        excerpts = ' '.join(m['excerpt'] for m in result['matches'][:2])
        return Plan(message=f'From {filename}: {excerpts}')
    first = ' '.join((doc_text or '').split())[:600]
    return Plan(message=(
        f'I read {filename}: {first} '
        'Ask me a specific question about it, or tell me the work to do '
        '(for example: add this stock, sell these items, record this expense).'
    ))


def handle_message(*, business, user, text, input_mode='text', conversation_id=None,
                 attachment_text='', attachment_name=''):
    """One assistant turn. Returns the response dict for the message endpoint."""
    text = (text or '').strip()
    if not text and attachment_text:
        text = 'Summarise this document.'
    if not text:
        raise ValidationError({'text': 'Required.'})
    if input_mode not in ('text', 'voice'):
        raise ValidationError({'input_mode': 'Must be text or voice.'})
    conversation = _conversation(business, user, conversation_id)
    user_message = Message.objects.create(
        conversation=conversation, role=Message.ROLE_USER, content=text,
        metadata={'input_mode': input_mode,
                  'attachment': attachment_name or None},
    )
    context = _context(business, conversation, user=user)
    if attachment_text:
        context['attachment'] = {
            'filename': attachment_name,
            'text': attachment_text[:4000],
        }
    provider = get_provider()
    history = _history(conversation)
    if attachment_text and provider.__class__.__name__ in ('HeuristicProvider', 'MockProvider'):
        plan = _attachment_plan(
            instruction=text, doc_text=attachment_text,
            filename=attachment_name or 'attached document')
        used_fallback = False
    elif isinstance(provider, LLMProvider) and not attachment_text:
        # Fast path: clear shop commands (sell/receive/spend/report/stock)
        # are planned locally in milliseconds. Only free-form turns pay
        # for a reasoning-model round trip.
        fast = fallback_plan(text=text, context=context, history=history)
        if fast.tool_calls or fast.write_intent or fast.message:
            plan, used_fallback = fast, False
        else:
            try:
                plan = provider.plan(text=text, context=context, history=history)
                used_fallback = False
            except ProviderError:
                plan, used_fallback = fast, True
    else:
        try:
            plan = provider.plan(text=text, context=context, history=history)
            used_fallback = False
        except ProviderError:
            if attachment_text:
                plan = _attachment_plan(
                    instruction=text, doc_text=attachment_text,
                    filename=attachment_name or 'attached document')
            else:
                plan = fallback_plan(text=text, context=context, history=history)
            used_fallback = True
    tool_runs = []
    reply, action = _run_plan(
        plan, business=business, user=user, conversation=conversation,
        context=context, tool_runs=tool_runs, request_id=f'msg:{user_message.pk}',
    )
    if used_fallback:
        reply = f'{reply} (Answered locally; the AI provider is unavailable.)'
    # No second model call to rephrase read results: _read_reply already
    # renders them from trusted tool output, and skipping the extra
    # round trip keeps read turns inside one reasoning call.
    documents = None
    if tool_runs and tool_runs[-1]['tool'] == 'get_sale_documents':
        result = tool_runs[-1]['result']
        documents = {
            'sale_id': result.get('sale_id'),
            'receipt_number': result.get('receipt_number'),
            'invoice_number': result.get('invoice_number'),
            'total': result.get('total'),
            'lines': result.get('lines', []),
            'receipt_url': result.get('receipt_url'),
            'invoice_url': result.get('invoice_url'),
        }
    visual = None
    for run in tool_runs:
        result = run.get('result') or {}
        if run.get('tool') == 'get_sales_trend' and result.get('series'):
            visual = {
                'kind': 'trend',
                'from': result.get('from'),
                'to': result.get('to'),
                'granularity': result.get('granularity'),
                'totals': result.get('totals', {}),
                'comparison': result.get('comparison', {}),
                'series': [
                    {'period': s.get('period'), 'sales': s.get('sales'),
                     'expenses': s.get('expenses'), 'profit': s.get('profit')}
                    for s in result.get('series', [])
                ],
                'top_products': [
                    {'product': r.get('product'), 'revenue': r.get('revenue')}
                    for r in (result.get('top_products') or [])[:5]
                ],
                'caveats': result.get('caveats', []),
            }
        elif (run.get('tool') == 'get_business_report'
                and result.get('metric') == 'low_stock' and result.get('rows')):
            visual = {
                'kind': 'table',
                'title': 'Low stock',
                'columns': ['Product', 'On hand', 'Threshold'],
                'rows': [[r.get('product'), r.get('quantity'), r.get('threshold')]
                         for r in result.get('rows', [])],
                'caveats': result.get('caveats', []),
            }
    assistant_message = Message.objects.create(
        conversation=conversation, role=Message.ROLE_ASSISTANT, content=reply,
        metadata={'tool_calls': tool_runs,
                  'pending_action_id': action.pk if action else None,
                  'documents': documents,
                  'visual': visual},
    )
    Conversation.objects.filter(pk=conversation.pk).update(title=text[:200])
    _record_memory(
        conversation, business,
        event=_memory_event(user_text=text, reply=reply, action=action, documents=documents),
        facts=_memory_facts(tool_runs=tool_runs, documents=documents),
    )
    return {
        'conversation_id': conversation.pk,
        'message_id': assistant_message.pk,
        'reply': reply,
        'state': action.state if action else 'completed',
        'action': _action_payload(action) if action else None,
        'tool_calls': tool_runs,
        'documents': documents,
        'visual': visual,
    }


def _run_plan(plan, *, business, user, conversation, context, tool_runs, request_id):
    if plan.clarify:
        return plan.clarify, None
    for call in plan.tool_calls:
        if call.name not in READ_TOOLS:
            return 'That tool is not available in conversation.', None
        if call.name == 'search_products' and not str((call.args or {}).get('query') or '').strip():
            return 'Which item should I check stock for?', None
        try:
            result = execute_tool(business=business, user=user, name=call.name, args=call.args)
        except Exception as exc:
            _log_tool(business, user, call.name, ActionLog.STATUS_FAILED,
                      f'{exc}', request_id)
            return _failure_reply(exc), None
        _log_tool(business, user, call.name, ActionLog.STATUS_COMPLETED,
                  f'{call.name} ok', request_id)
        tool_runs.append({'tool': call.name, 'args': call.args, 'result': result})
    if plan.tool_calls:
        last = tool_runs[-1]
        return _read_reply(last['tool'], last['result'], business), None
    if plan.write_intent == 'confirm_pending':
        return _confirm_from_chat(
            business, user, plan.write_args.get('pending_action_id'), confirm=True
        )
    if plan.write_intent == 'cancel_pending':
        return _confirm_from_chat(
            business, user, plan.write_args.get('pending_action_id'), confirm=False
        )
    if plan.write_intent == 'prepare_sale':
        return _prepare_sale_flow(
            business, user, conversation, plan.write_args, tool_runs, request_id
        )
    if plan.write_intent == 'receive_stock':
        return _prepare_receipt_flow(
            business, user, conversation, plan.write_args, tool_runs, request_id
        )
    if plan.write_intent == 'record_expense':
        return _prepare_expense_flow(
            business, user, conversation, plan.write_args, tool_runs, request_id
        )
    if plan.write_intent == 'add_catalogue_item':
        return _prepare_catalogue_flow(
            business, user, conversation, plan.write_args, tool_runs, request_id
        )
    if plan.write_intent == 'edit_catalogue_item':
        return _prepare_catalogue_edit_flow(
            business, user, conversation, plan.write_args, tool_runs, request_id
        )
    if plan.write_intent == 'deactivate_catalogue_item':
        return _prepare_catalogue_deactivate_flow(
            business, user, conversation, plan.write_args, tool_runs, request_id
        )
    if plan.write_intent:
        return 'I cannot do that yet through chat.', None
    return plan.message or 'Anything else?', None


def _failure_reply(exc):
    detail = getattr(exc, 'detail', None)
    if isinstance(detail, dict):
        first = next(iter(detail.values()), None)
        if isinstance(first, list) and first:
            return str(first[0])
        if first is not None:
            return str(first)
        return str(detail)
    if isinstance(detail, list) and detail:
        return str(detail[0])
    return str(exc) or 'That failed. Correct it and retry.'


def _money(value, currency):
    try:
        return f'{currency} {float(value):,.2f}'
    except (TypeError, ValueError):
        return f'{currency} {value}'


def _read_reply(tool, result, business):
    currency = business.currency
    if tool == 'get_business_report':
        metric = result.get('metric', '')
        if metric == 'low_stock':
            rows = result.get('rows', [])
            if not rows:
                return 'No items are below the low-stock threshold.'
            lines = [f"{r['product']}: {r['quantity']} (threshold {r['threshold']})"
                     for r in rows]
            return 'Low stock: ' + '; '.join(lines) + '.'
        if metric == 'profit':
            text = (
                f"Profit {result.get('from')} to {result.get('to')}: "
                f"{_money(result.get('value'), currency)} "
                f"(revenue {_money(result.get('revenue'), currency)}, "
                f"cost of goods {_money(result.get('cogs'), currency)})."
            )
        elif metric == 'sales_total':
            text = (
                f"Sales {result.get('from')} to {result.get('to')}: "
                f"{_money(result.get('value'), currency)}."
            )
        elif metric == 'expenses_total':
            text = (
                f"Expenses {result.get('from')} to {result.get('to')}: "
                f"{_money(result.get('value'), currency)}."
            )
        else:
            text = f"{metric}: {result.get('value')}."
        for caveat in result.get('caveats', []):
            text += f' Note: {caveat}'
        return text
    if tool == 'search_products':
        matches = result.get('matches', [])
        if not matches:
            return f"Nothing matches \"{result.get('query')}\"."
        if len(matches) == 1:
            match = matches[0]
            text = f"{match['name']}: {match['selling_price']}"
            if match['stock_tracked']:
                text += f', {match["on_hand"]} in stock'
            return text + '.'
        options = ', '.join(f"{m['name']} ({m['selling_price']})" for m in matches[:5])
        return f'Did you mean one of: {options}?'
    if tool == 'check_stock':
        if not result.get('stock_tracked'):
            return f"{result.get('name')} is not stock-tracked."
        return f"{result.get('name')}: {result.get('on_hand')} in stock."
    if tool == 'get_business_context':
        info = result.get('business', {})
        counts = result.get('counts', {})
        return (
            f"{info.get('name')} ({info.get('business_type')}, {info.get('currency')}): "
            f"{counts.get('products', 0)} catalogue items, "
            f"{counts.get('customers', 0)} customers, {counts.get('suppliers', 0)} suppliers."
        )
    if tool == 'get_sale_documents':
        text = (
            f"Sale #{result.get('sale_id')} · {_money(result.get('total'), business.currency)}. "
            f"Receipt {result.get('receipt_number') or 'pending'}, "
            f"invoice {result.get('invoice_number')}. "
            f"Tap below to download the PDFs."
        )
        return text
    if tool == 'search_knowledge':
        matches = result.get('matches', [])
        if not matches:
            return (
                'I could not find that in your saved business documents. '
                'Add it on the Setup page, or ask about sales, stock, or expenses.'
            )
        lines = [f"{m['title']}: {m['excerpt']}" for m in matches]
        return 'From your business documents: ' + ' '.join(lines)
    if tool == 'get_sales_trend':
        totals = result.get('totals', {})
        comp = result.get('comparison', {})
        series = result.get('series', [])
        best = max(series, key=lambda s: float(s.get('sales', 0) or 0), default=None)
        text = (
            f"Sales {result.get('from')} to {result.get('to')}: "
            f"{_money(totals.get('sales'), currency)}, "
            f"expenses {_money(totals.get('expenses'), currency)}."
        )
        if best:
            text += f" Best period {best.get('period')}: {_money(best.get('sales'), currency)}."
        for key in ('sales', 'expenses', 'profit'):
            delta = (comp.get(key) or {}).get('delta_pct')
            if delta is not None:
                text += f" {key.title()} vs prior: {delta}%."
        top = result.get('top_products', [])
        if top:
            text += ' Top: ' + ', '.join(
                f"{r['product']} ({r['revenue']})" for r in top[:3]
            ) + '.'
        for caveat in result.get('caveats', []):
            text += f' Note: {caveat}'
        return text
    return 'Done.'


def _prepare_sale_flow(business, user, conversation, args, tool_runs, request_id):
    resolved, problem = _resolve_lines(
        business=business, user=user, lines=args.get('lines', [])
    )
    if resolved is None:
        return problem, None
    key = uuid.uuid4().hex
    try:
        preview = execute_tool(
            business=business, user=user, name='prepare_sale',
            args={'items': resolved, 'customer_id': args.get('customer_id'),
                  'idempotency_key': key},
        )
    except Exception as exc:
        _log_tool(business, user, 'prepare_sale', ActionLog.STATUS_FAILED,
                  f'{exc}', request_id)
        return _failure_reply(exc), None
    _log_tool(business, user, 'prepare_sale', ActionLog.STATUS_COMPLETED,
              f"sale {preview['sale_id']} prepared", request_id)
    tool_runs.append({'tool': 'prepare_sale',
                      'args': {'items': resolved}, 'result': preview})
    lines = '; '.join(
        f"{item['product']} x {item['quantity']} = {item['line_total']}"
        for item in preview['lines']
    )
    summary = f"Sale of {business.currency} {preview['total']}: {lines}."
    action = _preview_action(
        business=business, user=user, conversation=conversation,
        action_type=PendingAction.TYPE_SALE, payload=preview, summary=summary,
        record_type='Sale', record_ref=str(preview['sale_id']), key=key,
    )
    return f'{summary} Confirm to record it, or say no to cancel.', action


def _prepare_receipt_flow(business, user, conversation, args, tool_runs, request_id):
    resolved, problem = _resolve_lines(
        business=business, user=user, lines=args.get('lines', [])
    )
    if resolved is None:
        return problem, None
    lines = '; '.join(
        f"product {item['product_id']} x {item['quantity']}" for item in resolved
    )
    summary = f'Stock receipt: {lines}.'
    action = _preview_action(
        business=business, user=user, conversation=conversation,
        action_type=PendingAction.TYPE_STOCK_RECEIPT,
        payload={'items': resolved, 'supplier_id': args.get('supplier_id')},
        summary=summary, key=uuid.uuid4().hex,
    )
    return f'{summary} Confirm to record it, or say no to cancel.', action


def _prepare_expense_flow(business, user, conversation, args, tool_runs, request_id):
    amount = args.get('amount')
    category = (args.get('category') or '').strip()
    if amount is None or not category:
        return 'How much, and on what? Say "spent 5000 on transport".', None
    summary = f'Expense of {business.currency} {amount} on {category}.'
    action = _preview_action(
        business=business, user=user, conversation=conversation,
        action_type=PendingAction.TYPE_EXPENSE,
        payload={'amount': str(amount), 'category': category,
                 'description': args.get('description', '')},
        summary=summary, key=uuid.uuid4().hex,
    )
    return f'{summary} Confirm to record it, or say no to cancel.', action


def _prepare_catalogue_flow(business, user, conversation, args, tool_runs, request_id):
    name = (args.get('name') or '').strip()
    if not name:
        return 'What should the new item be called, and what price should it sell for?', None
    try:
        price = Decimal(str(args.get('selling_price', '')))
    except (InvalidOperation, ValueError, TypeError):
        return f'What price should "{name}" sell for?', None
    if price < 0:
        return 'The selling price cannot be negative.', None
    kind = (args.get('kind') or 'product').strip().lower()
    if kind not in ('product', 'service'):
        kind = 'product'
    if ProductService.objects.filter(business=business, name__iexact=name).exists():
        return f'"{name}" is already in the catalogue.', None
    summary = f'New catalogue item: {name} at {business.currency} {price}.'
    action = _preview_action(
        business=business, user=user, conversation=conversation,
        action_type=PendingAction.TYPE_CATALOGUE_ITEM,
        payload={'name': name, 'kind': kind, 'selling_price': str(price),
                 'cost_price': args.get('cost_price') or None,
                 'stock_tracked': bool(args.get('stock_tracked', False)),
                 'aliases': args.get('aliases') or []},
        summary=summary, key=uuid.uuid4().hex,
    )
    return f'{summary} Confirm to add it, or say no to cancel.', action


def _prepare_catalogue_edit_flow(business, user, conversation, args, tool_runs, request_id):
    product, problem = _resolve_product(business=business, name=args.get('name'))
    if product is None:
        return problem, None
    updates = {}
    changes = []
    if args.get('new_name'):
        new_name = str(args['new_name']).strip()
        if new_name and new_name.lower() != product['name'].lower():
            if ProductService.objects.filter(business=business, name__iexact=new_name).exists():
                return f'"{new_name}" is already in the catalogue.', None
            updates['name'] = new_name
            changes.append({'label': 'Name', 'from': product['name'], 'to': new_name})
    for field, label in (('selling_price', 'Selling price'), ('cost_price', 'Cost price')):
        raw = args.get(field)
        if raw is not None and str(raw).strip() != '':
            try:
                value = Decimal(str(raw))
            except (InvalidOperation, ValueError, TypeError):
                return f'What price should "{product["name"]}" sell for?', None
            if value < 0:
                return 'Prices cannot be negative.', None
            if str(value) != str(product.get(field) or ''):
                updates[field] = str(value)
                changes.append({'label': label, 'from': str(product.get(field) or '—'), 'to': str(value)})
    if not updates:
        return f'What should change on "{product["name"]}"? Say "change the price of garri to 6000".', None
    summary = f"Update {product['name']}: " + '; '.join(f"{c['label']} {c['from']} → {c['to']}" for c in changes) + '.'
    action = _preview_action(
        business=business, user=user, conversation=conversation,
        action_type=PendingAction.TYPE_CATALOGUE_EDIT,
        payload={'product_id': product['product_id'], 'name': product['name'],
                 'updates': updates, 'changes': changes},
        summary=summary, key=uuid.uuid4().hex,
    )
    return f'{summary} Confirm to save it, or say no to cancel.', action


def _prepare_catalogue_deactivate_flow(business, user, conversation, args, tool_runs, request_id):
    product, problem = _resolve_product(business=business, name=args.get('name'))
    if product is None:
        return problem, None
    summary = f'Deactivate {product["name"]}: it stays in history but can no longer be sold.'
    action = _preview_action(
        business=business, user=user, conversation=conversation,
        action_type=PendingAction.TYPE_CATALOGUE_DEACTIVATE,
        payload={'product_id': product['product_id'], 'name': product['name'],
                 'changes': [{'label': 'Status', 'from': 'active', 'to': 'inactive'}]},
        summary=summary, key=uuid.uuid4().hex,
    )
    return f'{summary} Confirm to deactivate it, or say no to cancel.', action


def _confirm_from_chat(business, user, action_id, confirm):
    result = confirm_action(business=business, user=user, action_id=action_id,
                            confirm=confirm)
    state = result['state']
    if state == PendingAction.STATE_COMPLETED:
        return result['reply'], None
    if state == PendingAction.STATE_FAILED and confirm:
        return result['reply'], None
    return result['reply'], None


def confirm_action(*, business, user, action_id, confirm):
    """Confirm or decline a prepared action. Replay-safe on terminal states."""
    try:
        action = PendingAction.objects.get(pk=action_id, business=business)
    except (PendingAction.DoesNotExist, ValueError, TypeError):
        raise Http404('Action not found.')
    if action.state in PendingAction.TERMINAL_STATES:
        return {'id': action.pk, 'action_type': action.action_type,
                'state': action.state, 'reply': action.summary,
                'replayed': True}
    if not confirm:
        action.state = PendingAction.STATE_FAILED
        action.summary = f'Declined by user. Was: {action.summary}'
        action.save(update_fields=['state', 'summary', 'updated_at'])
        if action.action_type == PendingAction.TYPE_SALE and action.record_ref:
            try:
                execute_tool(business=business, user=user,
                             name='confirm_and_record_sale',
                             args={'sale_id': int(action.record_ref),
                                   'confirmation': False})
            except Exception:
                pass
        ActionLog.objects.create(
            business=business, actor=user,
            action_type=f"assistant_{action.action_type}_declined",
            status=ActionLog.STATUS_FAILED, summary=action.summary[:500],
            record_type='PendingAction', record_ref=str(action.pk),
        )
        reply = 'Cancelled. Nothing was recorded.'
        _mark_action_messages(action)
        if action.conversation is not None:
            Message.objects.create(
                conversation=action.conversation,
                role=Message.ROLE_ASSISTANT, content=reply,
                metadata={'confirmed_action_id': action.pk, 'documents': None},
            )
            _record_memory(
                action.conversation, business,
                event=f'user declined ({action.action_type})',
            )
        return {'id': action.pk, 'action_type': action.action_type,
                'state': action.state, 'reply': reply,
                'replayed': False}
    action.state = PendingAction.STATE_CONFIRMED
    action.save(update_fields=['state', 'updated_at'])
    try:
        reply, documents = _execute_confirmed(business=business, user=user, action=action)
    except Exception as exc:
        action.state = PendingAction.STATE_FAILED
        action.summary = _failure_reply(exc)
        action.save(update_fields=['state', 'summary', 'updated_at'])
        _mark_action_messages(action)
        ActionLog.objects.create(
            business=business, actor=user,
            action_type=f'assistant_{action.action_type}_failed',
            status=ActionLog.STATUS_FAILED, summary=action.summary[:500],
            record_type='PendingAction', record_ref=str(action.pk),
        )
        return {'id': action.pk, 'action_type': action.action_type,
                'state': action.state, 'reply': action.summary, 'replayed': False}
    action.state = PendingAction.STATE_COMPLETED
    action.summary = reply
    action.save(update_fields=['state', 'summary', 'updated_at'])
    _mark_action_messages(action)
    if action.conversation is not None:
        Message.objects.create(
            conversation=action.conversation,
            role=Message.ROLE_ASSISTANT, content=reply,
            metadata={'confirmed_action_id': action.pk, 'documents': documents},
        )
        event = f'user confirmed ({action.action_type})'
        if documents and documents.get('sale_id'):
            event += f" -> recorded sale #{documents['sale_id']}"
        _record_memory(
            action.conversation, business, event=event,
            facts=_memory_facts(tool_runs=[], documents=documents),
        )
    _log_tool(business, user, f'confirm_{action.action_type}',
              ActionLog.STATUS_COMPLETED, reply, f'action:{action.pk}')
    return {'id': action.pk, 'action_type': action.action_type,
            'state': action.state, 'reply': reply, 'replayed': False,
            'documents': documents}


def _sale_documents(business, sale_id):
    from .documents import ensure_invoice, receipt_payload
    from .models import Sale

    try:
        sale = Sale.objects.get(pk=int(sale_id), business=business)
    except (Sale.DoesNotExist, ValueError, TypeError):
        return None
    if sale.status != Sale.STATUS_COMMITTED:
        return None
    payload = receipt_payload(business, sale)
    invoice, _ = ensure_invoice(business=business, user=None, sale=sale)
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


def _execute_confirmed(*, business, user, action):
    if action.action_type == PendingAction.TYPE_SALE:
        result = execute_tool(
            business=business, user=user, name='confirm_and_record_sale',
            args={'sale_id': int(action.record_ref), 'confirmation': True},
        )
        action.record_type = 'Sale'
        action.record_ref = str(result['sale_id'])
        action.save(update_fields=['record_type', 'record_ref'])
        reply = (
            f"Sale recorded: {_money(result['total'], business.currency)}. "
            f"Receipt {result['receipt_number']}. "
            f"Tap below to print the receipt or send the invoice."
        )
        return reply, _sale_documents(business, result['sale_id'])
    if action.action_type == PendingAction.TYPE_EXPENSE:
        payload = action.payload
        result = execute_tool(
            business=business, user=user, name='record_expense', args={
                'amount': payload['amount'], 'category': payload['category'],
                'description': payload.get('description', ''),
            },
        )
        action.record_type = 'Expense'
        action.record_ref = str(result['expense_id'])
        action.save(update_fields=['record_type', 'record_ref'])
        reply = (
            f"Expense recorded: {_money(result['amount'], business.currency)} "
            f"on {result['category']}."
        )
        return reply, None
    if action.action_type == PendingAction.TYPE_STOCK_RECEIPT:
        payload = action.payload
        result = execute_tool(
            business=business, user=user, name='receive_stock', args={
                'items': payload['items'], 'supplier_id': payload.get('supplier_id'),
                'idempotency_key': action.idempotency_key,
            },
        )
        action.record_type = 'Purchase'
        action.record_ref = str(result['purchase_id'])
        action.save(update_fields=['record_type', 'record_ref'])
        reply = f"Stock receipt recorded: {len(result['lines'])} lines."
        for warning in result.get('warnings', []):
            reply += f' Warning: {warning}'
        return reply, None
    if action.action_type == PendingAction.TYPE_CATALOGUE_ITEM:
        payload = action.payload
        result = execute_tool(
            business=business, user=user, name='add_catalogue_item', args={
                'name': payload['name'], 'kind': payload.get('kind', 'product'),
                'selling_price': payload['selling_price'],
                'cost_price': payload.get('cost_price'),
                'stock_tracked': payload.get('stock_tracked', False),
                'aliases': payload.get('aliases', []),
            },
        )
        action.record_type = 'ProductService'
        action.record_ref = str(result['product_id'])
        action.save(update_fields=['record_type', 'record_ref'])
        reply = (
            f"Added to the catalogue: {result['name']} "
            f"at {_money(result['selling_price'], business.currency)}."
        )
        return reply, None
    if action.action_type == PendingAction.TYPE_CATALOGUE_EDIT:
        payload = action.payload
        result = execute_tool(
            business=business, user=user, name='edit_catalogue_item', args={
                'product_id': payload['product_id'], 'name': payload.get('updates', {}).get('name'),
                'selling_price': payload.get('updates', {}).get('selling_price'),
                'cost_price': payload.get('updates', {}).get('cost_price'),
            },
        )
        action.record_type = 'ProductService'
        action.record_ref = str(result['product_id'])
        action.save(update_fields=['record_type', 'record_ref'])
        reply = f"Updated {result['name']}: " + '; '.join(
            f"{c['label']} is now {c['to']}" for c in payload.get('changes', [])
        ) + '.'
        return reply, None
    if action.action_type == PendingAction.TYPE_CATALOGUE_DEACTIVATE:
        payload = action.payload
        result = execute_tool(
            business=business, user=user, name='deactivate_catalogue_item',
            args={'product_id': payload['product_id']},
        )
        action.record_type = 'ProductService'
        action.record_ref = str(result['product_id'])
        action.save(update_fields=['record_type', 'record_ref'])
        reply = f"{result['name']} is now inactive. It stays in history but can no longer be sold."
        return reply, None
    raise ValidationError({'action_type': 'Unknown prepared action.'})
