"""Business setup and catalogue endpoints. Phase 2."""

import csv
import io
from decimal import Decimal, InvalidOperation

from django.db import transaction
from rest_framework import generics, status, viewsets
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import (
    ActionLog,
    Business,
    BusinessMembership,
    Customer,
    ProductService,
    StockBalance,
    StockMovement,
    Supplier,
)
from .permissions import HasBusinessPermission, IsBusinessManager, IsBusinessMember
from .serializers import BusinessSerializer, ProductServiceSerializer


class BusinessListCreateView(generics.ListCreateAPIView):
    permission_classes = [IsAuthenticated]
    serializer_class = BusinessSerializer

    def get_queryset(self):
        business_ids = BusinessMembership.objects.filter(
            user=self.request.user, status=BusinessMembership.STATUS_ACTIVE
        ).values_list('business_id', flat=True)
        return Business.objects.filter(pk__in=business_ids).order_by('name')

    def perform_create(self, serializer):
        with transaction.atomic():
            business = serializer.save()
            BusinessMembership.objects.create(
                business=business,
                user=self.request.user,
                role=BusinessMembership.ROLE_OWNER,
                status=BusinessMembership.STATUS_ACTIVE,
            )

    def list(self, request, *args, **kwargs):
        response = super().list(request, *args, **kwargs)
        roles = dict(
            BusinessMembership.objects.filter(
                user=request.user, status=BusinessMembership.STATUS_ACTIVE
            ).values_list('business_id', 'role')
        )
        for item in response.data:
            item['role'] = roles.get(item['id'])
        return response


class BusinessContextView(APIView):
    permission_classes = [IsAuthenticated, IsBusinessMember]

    def get(self, request, business_id):
        from .permissions import effective_permissions, extra_grants

        business = request.business
        membership = request.business_membership
        rules = [
            {
                'rule_type': rule.rule_type,
                'structured_value': rule.structured_value,
                'source': rule.source,
                'verified': rule.verified,
            }
            for rule in business.businessrule_set.all()
        ]
        return Response(
            {
                'business': BusinessSerializer(business).data,
                'role': membership.role,
                'permissions': sorted(effective_permissions(membership.role, extra_grants(membership))),
                'extra_permissions': sorted(extra_grants(membership)),
                'counts': {
                    'products': ProductService.objects.filter(business=business).count(),
                    'customers': Customer.objects.filter(business=business).count(),
                    'suppliers': Supplier.objects.filter(business=business).count(),
                },
                'rules': rules,
            }
        )


class CatalogueViewSet(viewsets.ModelViewSet):
    serializer_class = ProductServiceSerializer

    def get_permissions(self):
        if self.request.method in ('GET', 'HEAD', 'OPTIONS'):
            return [IsAuthenticated(), IsBusinessMember()]
        self.required_permission = 'catalogue.write'
        return [IsAuthenticated(), HasBusinessPermission()]

    def get_queryset(self):
        return (
            ProductService.objects.filter(business_id=self.kwargs['business_id'])
            .prefetch_related('stock_balances')
            .order_by('name')
        )

    def get_serializer_context(self):
        context = super().get_serializer_context()
        context['business'] = getattr(self.request, 'business', None)
        return context

    def perform_create(self, serializer):
        serializer.save(business=self.request.business)


TRUE_VALUES = {'true', '1', 'yes', 'y'}
FALSE_VALUES = {'false', '0', 'no', 'n', ''}


def _parse_bool(raw, field, row_number, errors):
    text = (raw or '').strip().lower()
    if text in TRUE_VALUES:
        return True
    if text in FALSE_VALUES:
        return False
    errors.append({'row': row_number, 'field': field, 'message': f'Not true/false: {raw!r}.'})
    return None


def _parse_decimal(raw, field, row_number, errors, required):
    text = (raw or '').strip()
    if not text:
        if required:
            errors.append({'row': row_number, 'field': field, 'message': 'Required.'})
        return None
    try:
        value = Decimal(text)
    except InvalidOperation:
        errors.append({'row': row_number, 'field': field, 'message': f'Not a number: {raw!r}.'})
        return None
    if value < 0:
        errors.append({'row': row_number, 'field': field, 'message': 'Must be zero or more.'})
        return None
    return value


def _cell_text(value):
    if value is None:
        return ''
    if isinstance(value, bool):
        return 'true' if value else 'false'
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value).strip()


def _read_import_rows(upload):
    """Rows as dicts from CSV, TSV, XLSX/XLSM, or legacy XLS uploads."""
    name = (getattr(upload, 'name', '') or '').lower()
    if name.endswith(('.xlsx', '.xlsm', '.xltx', '.xltm')):
        from openpyxl import load_workbook

        workbook = load_workbook(io.BytesIO(upload.read()), read_only=True, data_only=True)
        sheet = workbook.active
        rows_iter = sheet.iter_rows(values_only=True)
        headers = [_cell_text(cell).lower() for cell in next(rows_iter, [])]
        return [
            {headers[i]: _cell_text(cell) for i, cell in enumerate(row) if i < len(headers)}
            for row in rows_iter
        ]
    if name.endswith('.xls'):
        import xlrd

        book = xlrd.open_workbook(file_contents=upload.read())
        sheet = book.sheet_by_index(0)
        if sheet.nrows == 0:
            return []
        headers = [_cell_text(sheet.cell_value(0, col)).lower() for col in range(sheet.ncols)]
        return [
            {
                headers[col]: _cell_text(sheet.cell_value(row_idx, col))
                for col in range(sheet.ncols)
            }
            for row_idx in range(1, sheet.nrows)
        ]
    text = io.TextIOWrapper(upload.file, encoding='utf-8-sig').read()
    delimiter = '\t' if name.endswith('.tsv') else ','
    return list(csv.DictReader(io.StringIO(text), delimiter=delimiter))


class CatalogueImportView(APIView):
    """CSV/Excel catalogue import. ?preview=true validates without writing."""

    permission_classes = [IsAuthenticated, HasBusinessPermission]
    required_permission = 'catalogue.write'

    def post(self, request, business_id):
        upload = request.FILES.get('file')
        if upload is None:
            return Response(
                {
                    'error': {
                        'code': 'validation',
                        'message': 'Attach a CSV or Excel file as multipart field "file".',
                        'field': 'file',
                        'next_step': 'Upload the catalogue file and retry.',
                    }
                },
                status=status.HTTP_400_BAD_REQUEST,
            )
        try:
            rows = _read_import_rows(upload)
        except Exception:
            return Response(
                {
                    'error': {
                        'code': 'validation',
                        'message': 'File could not be read as CSV or Excel.',
                        'field': 'file',
                        'next_step': 'Save the file as CSV, XLSX, or XLS and retry.',
                    }
                },
                status=status.HTTP_400_BAD_REQUEST,
            )
        preview = str(request.query_params.get('preview', '')).lower() in TRUE_VALUES
        return Response(self._run(request, rows, preview))

    def _run(self, request, rows, preview):
        business = request.business
        valid, errors = [], []
        seen_names = set()
        for index, raw in enumerate(rows, start=2):
            row = {(k or '').strip().lower(): (v or '').strip() for k, v in raw.items()}
            name = row.get('name', '')
            if not name:
                errors.append({'row': index, 'field': 'name', 'message': 'Required.'})
                continue
            key = name.lower()
            if key in seen_names:
                errors.append(
                    {'row': index, 'field': 'name', 'message': 'Duplicate name in file.'}
                )
                continue
            kind = row.get('kind', 'product').lower() or 'product'
            if kind not in ('product', 'service'):
                errors.append(
                    {'row': index, 'field': 'kind', 'message': 'Must be product or service.'}
                )
                continue
            row_errors = []
            selling_price = _parse_decimal(
                row.get('selling_price'), 'selling_price', index, row_errors, True
            )
            cost_price = _parse_decimal(row.get('cost_price'), 'cost_price', index, row_errors, False)
            stock_tracked = _parse_bool(
                row.get('stock_tracked', ''), 'stock_tracked', index, row_errors
            )
            active = _parse_bool(row.get('active', 'true'), 'active', index, row_errors)
            opening_stock = _parse_decimal(
                row.get('opening_stock'), 'opening_stock', index, row_errors, False
            )
            if stock_tracked is None or active is None:
                errors.extend(row_errors)
                continue
            if row_errors:
                errors.extend(row_errors)
                continue
            if ProductService.objects.filter(business=business, name=name).exists():
                errors.append(
                    {
                        'row': index,
                        'field': 'name',
                        'message': 'This business already has an item with this name.',
                    }
                )
                continue
            seen_names.add(key)
            aliases = [a.strip() for a in row.get('aliases', '').split('|') if a.strip()]
            valid.append(
                {
                    'row': index,
                    'name': name,
                    'aliases': aliases,
                    'kind': kind,
                    'selling_price': selling_price,
                    'cost_price': cost_price,
                    'stock_tracked': stock_tracked,
                    'active': active,
                    'opening_stock': opening_stock or Decimal('0'),
                }
            )
        if preview:
            return {
                'preview': True,
                'valid_count': len(valid),
                'invalid_count': len(errors),
                'rows': [
                    {**item, 'selling_price': str(item['selling_price'])} for item in valid
                ],
                'errors': errors,
            }
        created = 0
        with transaction.atomic():
            for item in valid:
                product = ProductService.objects.create(
                    business=business,
                    name=item['name'],
                    aliases=item['aliases'],
                    kind=item['kind'],
                    selling_price=item['selling_price'],
                    cost_price=item['cost_price'],
                    stock_tracked=item['stock_tracked'],
                    active=item['active'],
                )
                if item['stock_tracked'] and item['opening_stock'] > 0:
                    StockBalance.objects.create(
                        business=business, product=product, quantity=item['opening_stock']
                    )
                    StockMovement.objects.create(
                        business=business,
                        product=product,
                        movement_type=StockMovement.TYPE_OPENING,
                        quantity=item['opening_stock'],
                        reference='csv-import',
                        actor=request.user,
                    )
                created += 1
            ActionLog.objects.create(
                business=business,
                actor=request.user,
                action_type='catalogue_import',
                status=ActionLog.STATUS_COMPLETED,
                summary=f'Imported {created} items, {len(errors)} rows rejected.',
            )
        return {'preview': False, 'created': created, 'rejected': len(errors), 'errors': errors}
