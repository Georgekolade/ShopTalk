"""ShopTalk API error envelope. PRD 11.2."""

from django.http import Http404
from rest_framework.exceptions import APIException
from rest_framework.response import Response
from rest_framework.views import exception_handler as drf_exception_handler


class ConflictError(APIException):
    status_code = 409
    default_detail = 'Conflict with the current state.'
    default_code = 'conflict'


def _category(status_code):
    if status_code == 400:
        return 'validation'
    if status_code in (401, 403):
        return 'permission'
    if status_code == 404:
        return 'not_found'
    if status_code == 409:
        return 'conflict'
    return 'internal'


def _first_error(detail):
    """Flatten DRF error detail to (message, field)."""
    if isinstance(detail, dict):
        for field, errors in detail.items():
            message, _ = _first_error(errors)
            return message, field
    if isinstance(detail, list) and detail:
        return _first_error(detail[0])
    return str(detail), None


def shoptalk_exception_handler(exc, context):
    if isinstance(exc, Http404):
        return Response(
            {
                'error': {
                    'code': 'not_found',
                    'message': 'Not found.',
                    'field': None,
                    'next_step': 'Check the identifier and that you have access.',
                }
            },
            status=404,
        )
    response = drf_exception_handler(exc, context)
    if response is None:
        return None
    message, field = _first_error(response.data.get('detail', response.data))
    return Response(
        {
            'error': {
                'code': _category(response.status_code),
                'message': message,
                'field': field,
                'next_step': 'Correct the request and retry.',
            }
        },
        status=response.status_code,
    )
