"""ShopTalk API routes."""

from django.contrib import admin
from django.http import JsonResponse
from django.urls import path
from rest_framework.authtoken.views import obtain_auth_token

from core import views, views_assistant, views_extra, views_knowledge, views_tx

catalogue_list = views.CatalogueViewSet.as_view({'get': 'list', 'post': 'create'})
catalogue_detail = views.CatalogueViewSet.as_view(
    {
        'get': 'retrieve',
        'put': 'update',
        'patch': 'partial_update',
        'delete': 'destroy',
    }
)

def health(_request):
    return JsonResponse({"status": "ok"})


urlpatterns = [
    path('api/health/', health, name='api-health'),
    path('admin/', admin.site.urls),
    path('api/auth/token/', obtain_auth_token, name='api-token'),
    path('api/auth/register/', views_extra.RegisterView.as_view(), name='api-register'),
    path(
        'api/businesses/<int:business_id>/profile',
        views_extra.BusinessProfileView.as_view(), name='business-profile',
    ),
    path(
        'api/businesses/<int:business_id>/team',
        views_extra.TeamListCreateView.as_view(), name='team-list',
    ),
    path(
        'api/businesses/<int:business_id>/team/<int:member_id>',
        views_extra.TeamDetailView.as_view(), name='team-detail',
    ),
    path(
        'api/businesses/<int:business_id>/reports/analytics',
        views_extra.AnalyticsView.as_view(), name='analytics',
    ),
    path(
        'api/businesses/<int:business_id>/sales/<int:sale_id>/receipt',
        views_extra.ReceiptView.as_view(), name='sale-receipt',
    ),
    path(
        'api/businesses/<int:business_id>/sales/<int:sale_id>/receipt.pdf',
        views_extra.ReceiptPdfView.as_view(), name='sale-receipt-pdf',
    ),
    path(
        'api/businesses/<int:business_id>/sales/<int:sale_id>/invoice',
        views_extra.InvoiceView.as_view(), name='sale-invoice',
    ),
    path(
        'api/businesses/<int:business_id>/sales/<int:sale_id>/invoice.pdf',
        views_extra.InvoicePdfView.as_view(), name='sale-invoice-pdf',
    ),
    path(
        'api/businesses/<int:business_id>/assistant/history',
        views_extra.AssistantHistoryView.as_view(), name='assistant-history',
    ),
    path(
        'api/businesses/<int:business_id>/knowledge',
        views_knowledge.KnowledgeDocumentListCreateView.as_view(), name='knowledge-list',
    ),
    path(
        'api/businesses/<int:business_id>/knowledge/<int:document_id>',
        views_knowledge.KnowledgeDocumentDetailView.as_view(), name='knowledge-detail',
    ),
    path('api/businesses', views.BusinessListCreateView.as_view(), name='business-list'),
    path(
        'api/businesses/<int:business_id>/context',
        views.BusinessContextView.as_view(),
        name='business-context',
    ),
    path(
        'api/businesses/<int:business_id>/catalogue',
        catalogue_list,
        name='catalogue-list',
    ),
    path(
        'api/businesses/<int:business_id>/catalogue/<int:pk>',
        catalogue_detail,
        name='catalogue-detail',
    ),
    path(
        'api/businesses/<int:business_id>/catalogue/import',
        views.CatalogueImportView.as_view(),
        name='catalogue-import',
    ),
    path(
        'api/businesses/<int:business_id>/sales',
        views_tx.SaleListView.as_view(),
        name='sale-list',
    ),
    path(
        'api/businesses/<int:business_id>/sales/prepare',
        views_tx.SalePrepareView.as_view(),
        name='sale-prepare',
    ),
    path(
        'api/businesses/<int:business_id>/sales/<int:sale_id>/commit',
        views_tx.SaleCommitView.as_view(),
        name='sale-commit',
    ),
    path(
        'api/businesses/<int:business_id>/stock-receipts',
        views_tx.StockReceiptView.as_view(),
        name='stock-receipt',
    ),
    path(
        'api/businesses/<int:business_id>/expenses',
        views_tx.ExpenseListCreateView.as_view(),
        name='expense-list',
    ),
    path(
        'api/businesses/<int:business_id>/reports',
        views_tx.ReportView.as_view(),
        name='report',
    ),
    path(
        'api/businesses/<int:business_id>/activity',
        views_tx.ActivityView.as_view(),
        name='activity',
    ),
    path(
        'api/businesses/<int:business_id>/assistant/messages',
        views_assistant.AssistantMessageView.as_view(),
        name='assistant-messages',
    ),
    path(
        'api/businesses/<int:business_id>/assistant/actions/<int:action_id>/confirm',
        views_assistant.AssistantActionConfirmView.as_view(),
        name='assistant-action-confirm',
    ),
]
