"""Tenant scoping. Every business URL resolves through an active membership."""

from django.http import Http404
from rest_framework import permissions

from .models import BusinessMembership


def get_membership_or_404(user, business_id):
    """Active membership for user+business. 404 when missing, never 403 with detail."""
    if not user or not user.is_authenticated:
        raise Http404('Business not found.')
    try:
        return BusinessMembership.objects.select_related('business').get(
            business_id=business_id,
            user=user,
            status=BusinessMembership.STATUS_ACTIVE,
        )
    except (BusinessMembership.DoesNotExist, ValueError):
        raise Http404('Business not found.')


class IsBusinessMember(permissions.BasePermission):
    """Allows only active members of the URL business. Stashes membership on request."""

    def has_permission(self, request, view):
        membership = get_membership_or_404(request.user, view.kwargs.get('business_id'))
        request.business_membership = membership
        request.business = membership.business
        return True


class IsBusinessManager(permissions.BasePermission):
    """Allows only owner/manager roles of the URL business."""

    def has_permission(self, request, view):
        membership = get_membership_or_404(request.user, view.kwargs.get('business_id'))
        request.business_membership = membership
        request.business = membership.business
        return membership.role in BusinessMembership.MANAGER_ROLES


class IsBusinessOwner(permissions.BasePermission):
    """Owner-only admin surface: team, business profile, setup."""

    def has_permission(self, request, view):
        membership = get_membership_or_404(request.user, view.kwargs.get('business_id'))
        request.business_membership = membership
        request.business = membership.business
        return membership.role == BusinessMembership.ROLE_OWNER


# Permission matrix. Owner/manager keep full access; granular roles get a
# bounded set. Legacy 'staff' behaves as sales so old rows keep working.
ROLE_PERMISSIONS = {
    'owner': {'*'},
    'manager': {'*'},
    'sales': {'sales.write', 'catalogue.view', 'assistant.use'},
    'staff': {'sales.write', 'catalogue.view', 'assistant.use'},
    'inventory': {'stock.write', 'catalogue.write', 'catalogue.view', 'reports.view', 'activity.view', 'assistant.use'},
    'finance': {'expenses.write', 'reports.view', 'catalogue.view', 'activity.view', 'assistant.use'},
    'viewer': {'reports.view', 'catalogue.view', 'activity.view'},
}


def role_has(role, permission):
    allowed = ROLE_PERMISSIONS.get(role, set())
    return '*' in allowed or permission in allowed


# Permissions an owner can bolt onto one user beyond their role defaults.
GRANTABLE_PERMISSIONS = (
    'sales.write',
    'stock.write',
    'expenses.write',
    'catalogue.write',
    'catalogue.view',
    'reports.view',
    'activity.view',
    'assistant.use',
)

# Roles offered for a small shop. Legacy values (finance, viewer, staff)
# stay readable for old rows but are never assigned to new members.
CORE_ASSIGNABLE_ROLES = {'manager', 'sales', 'inventory'}


def extra_grants(membership):
    raw = (membership.permissions or {}).get('extra', [])
    if not isinstance(raw, list):
        return set()
    return {p for p in raw if p in GRANTABLE_PERMISSIONS}


def effective_permissions(role, extra):
    allowed = set(ROLE_PERMISSIONS.get(role, ()))
    if '*' in allowed:
        return {'*'}
    grants = {p for p in (extra or []) if p in GRANTABLE_PERMISSIONS}
    return allowed | grants


def member_has(member, permission):
    if member is None:
        return False
    allowed = ROLE_PERMISSIONS.get(member.role, set())
    if '*' in allowed or permission in allowed:
        return True
    return permission in extra_grants(member)


def membership_has(user, business, permission):
    membership = BusinessMembership.objects.filter(
        business=business, user=user, status=BusinessMembership.STATUS_ACTIVE
    ).first()
    return membership is not None and member_has(membership, permission)


class HasBusinessPermission(permissions.BasePermission):
    """Factory-style permission: set `required_permission` on the view."""

    def has_permission(self, request, view):
        membership = get_membership_or_404(request.user, view.kwargs.get('business_id'))
        request.business_membership = membership
        request.business = membership.business
        needed = getattr(view, 'required_permission', None)
        if needed is None:
            return True
        return member_has(membership, needed)
