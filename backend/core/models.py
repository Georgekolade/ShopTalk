"""ShopTalk AI core data model. Follows PRD section 10.

Multi-tenancy is row-level: every operational record carries a business FK and
every query is scoped through an active BusinessMembership. Cross-tenant access
resolves to 404 so protected records are never exposed.
"""

from django.conf import settings
from django.core.validators import MinValueValidator
from django.db import models


class Business(models.Model):
    RETAIL = 'retail'
    SERVICE = 'service'
    HYBRID = 'hybrid'
    TYPE_CHOICES = [
        (RETAIL, 'Retail / trading'),
        (SERVICE, 'Service'),
        (HYBRID, 'Hybrid'),
    ]

    name = models.CharField(max_length=200)
    business_type = models.CharField(max_length=20, choices=TYPE_CHOICES, default=RETAIL)
    currency = models.CharField(max_length=3)
    timezone = models.CharField(max_length=50, default='UTC')
    country = models.CharField(max_length=2, blank=True, default='')
    phone = models.CharField(max_length=50, blank=True, default='')
    email = models.EmailField(blank=True, default='')
    address = models.CharField(max_length=255, blank=True, default='')
    logo_data = models.TextField(blank=True, default='')
    brand_color = models.CharField(max_length=7, blank=True, default='')
    enabled_modules = models.JSONField(default=list)
    settings = models.JSONField(default=dict)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    def __str__(self):
        return self.name


class BusinessMembership(models.Model):
    ROLE_OWNER = 'owner'
    ROLE_MANAGER = 'manager'
    ROLE_SALES = 'sales'
    ROLE_INVENTORY = 'inventory'
    ROLE_FINANCE = 'finance'
    ROLE_VIEWER = 'viewer'
    ROLE_STAFF = 'staff'  # legacy alias of sales, kept for old rows/tests
    ROLE_CHOICES = [
        (ROLE_OWNER, 'Owner'),
        (ROLE_MANAGER, 'Manager'),
        (ROLE_SALES, 'Sales'),
        (ROLE_INVENTORY, 'Inventory'),
        (ROLE_FINANCE, 'Finance'),
        (ROLE_VIEWER, 'Viewer'),
        (ROLE_STAFF, 'Staff (legacy)'),
    ]
    STATUS_ACTIVE = 'active'
    STATUS_INVITED = 'invited'
    STATUS_DISABLED = 'disabled'
    STATUS_CHOICES = [
        (STATUS_ACTIVE, 'Active'),
        (STATUS_INVITED, 'Invited'),
        (STATUS_DISABLED, 'Disabled'),
    ]
    MANAGER_ROLES = {ROLE_OWNER, ROLE_MANAGER}

    business = models.ForeignKey(Business, on_delete=models.CASCADE, related_name='memberships')
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='business_memberships'
    )
    role = models.CharField(max_length=20, choices=ROLE_CHOICES, default=ROLE_STAFF)
    permissions = models.JSONField(default=dict)
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default=STATUS_ACTIVE)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=['business', 'user'], name='uniq_business_membership'
            )
        ]

    def __str__(self):
        return f'{self.user} / {self.business} ({self.role})'


class BusinessScopedModel(models.Model):
    """Abstract base. Every operational record belongs to exactly one business."""

    business = models.ForeignKey(Business, on_delete=models.CASCADE)

    class Meta:
        abstract = True


class BusinessRule(BusinessScopedModel):
    SOURCE_ONBOARDING = 'onboarding'
    SOURCE_IMPORT = 'import'
    SOURCE_PREFERENCE = 'preference'
    SOURCE_SYSTEM = 'system'
    SOURCE_CHOICES = [
        (SOURCE_ONBOARDING, 'Onboarding'),
        (SOURCE_IMPORT, 'Import'),
        (SOURCE_PREFERENCE, 'Preference'),
        (SOURCE_SYSTEM, 'System'),
    ]

    rule_type = models.CharField(max_length=100)
    structured_value = models.JSONField(default=dict)
    source = models.CharField(max_length=20, choices=SOURCE_CHOICES, default=SOURCE_PREFERENCE)
    verified = models.BooleanField(default=False)
    verified_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL
    )
    verified_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    def __str__(self):
        return f'{self.business}: {self.rule_type}'


class ProductService(BusinessScopedModel):
    KIND_PRODUCT = 'product'
    KIND_SERVICE = 'service'
    KIND_CHOICES = [
        (KIND_PRODUCT, 'Product'),
        (KIND_SERVICE, 'Service'),
    ]

    name = models.CharField(max_length=200)
    aliases = models.JSONField(default=list)
    kind = models.CharField(max_length=20, choices=KIND_CHOICES, default=KIND_PRODUCT)
    selling_price = models.DecimalField(
        max_digits=12, decimal_places=2, validators=[MinValueValidator(0)]
    )
    cost_price = models.DecimalField(
        max_digits=12, decimal_places=2, null=True, blank=True, validators=[MinValueValidator(0)]
    )
    stock_tracked = models.BooleanField(default=False)
    active = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=['business', 'name'], name='uniq_product_name_per_business'
            )
        ]
        ordering = ['name']

    def __str__(self):
        return f'{self.business}: {self.name}'


class StockBalance(BusinessScopedModel):
    product = models.ForeignKey(
        ProductService, on_delete=models.CASCADE, related_name='stock_balances'
    )
    location = models.CharField(max_length=100, blank=True, default='')
    quantity = models.DecimalField(max_digits=12, decimal_places=3, default=0)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=['business', 'product', 'location'], name='uniq_stock_balance'
            )
        ]

    def __str__(self):
        return f'{self.product.name}: {self.quantity}'


class StockMovement(BusinessScopedModel):
    TYPE_OPENING = 'opening'
    TYPE_SALE = 'sale'
    TYPE_PURCHASE = 'purchase'
    TYPE_ADJUSTMENT = 'adjustment'
    TYPE_CHOICES = [
        (TYPE_OPENING, 'Opening'),
        (TYPE_SALE, 'Sale'),
        (TYPE_PURCHASE, 'Purchase'),
        (TYPE_ADJUSTMENT, 'Adjustment'),
    ]

    product = models.ForeignKey(
        ProductService, on_delete=models.CASCADE, related_name='stock_movements'
    )
    movement_type = models.CharField(max_length=20, choices=TYPE_CHOICES)
    quantity = models.DecimalField(max_digits=12, decimal_places=3)
    reference = models.CharField(max_length=100, blank=True, default='')
    actor = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL
    )
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self):
        return f'{self.product.name} {self.movement_type} {self.quantity}'


class Customer(BusinessScopedModel):
    name = models.CharField(max_length=200)
    phone = models.CharField(max_length=50, blank=True, default='')
    email = models.EmailField(blank=True, default='')
    address = models.CharField(max_length=255, blank=True, default='')
    notes = models.TextField(blank=True, default='')
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['name']

    def __str__(self):
        return f'{self.business}: {self.name}'


class Supplier(BusinessScopedModel):
    name = models.CharField(max_length=200)
    phone = models.CharField(max_length=50, blank=True, default='')
    email = models.EmailField(blank=True, default='')
    address = models.CharField(max_length=255, blank=True, default='')
    terms = models.CharField(max_length=255, blank=True, default='')
    notes = models.TextField(blank=True, default='')
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['name']

    def __str__(self):
        return f'{self.business}: {self.name}'


class Sale(BusinessScopedModel):
    STATUS_PREPARED = 'prepared'
    STATUS_COMMITTED = 'committed'
    STATUS_CANCELLED = 'cancelled'
    STATUS_CHOICES = [
        (STATUS_PREPARED, 'Prepared'),
        (STATUS_COMMITTED, 'Committed'),
        (STATUS_CANCELLED, 'Cancelled'),
    ]

    customer = models.ForeignKey(
        Customer, null=True, blank=True, on_delete=models.SET_NULL, related_name='sales'
    )
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default=STATUS_PREPARED)
    subtotal = models.DecimalField(max_digits=12, decimal_places=2, default=0)
    total = models.DecimalField(max_digits=12, decimal_places=2, default=0)
    idempotency_key = models.CharField(max_length=100)
    sold_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL
    )
    sold_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=['business', 'idempotency_key'], name='uniq_sale_idempotency_key'
            )
        ]

    def __str__(self):
        return f'sale {self.pk} ({self.status})'


class SaleItem(models.Model):
    sale = models.ForeignKey(Sale, on_delete=models.CASCADE, related_name='items')
    product = models.ForeignKey(ProductService, on_delete=models.PROTECT, related_name='sale_items')
    quantity = models.DecimalField(
        max_digits=12, decimal_places=3, validators=[MinValueValidator(0)]
    )
    unit_price = models.DecimalField(
        max_digits=12, decimal_places=2, validators=[MinValueValidator(0)]
    )
    line_total = models.DecimalField(
        max_digits=12, decimal_places=2, validators=[MinValueValidator(0)]
    )

    def __str__(self):
        return f'{self.product.name} x {self.quantity}'


class Purchase(BusinessScopedModel):
    STATUS_ORDERED = 'ordered'
    STATUS_PARTIAL = 'partial'
    STATUS_RECEIVED = 'received'
    STATUS_CANCELLED = 'cancelled'
    STATUS_CHOICES = [
        (STATUS_ORDERED, 'Ordered'),
        (STATUS_PARTIAL, 'Partially received'),
        (STATUS_RECEIVED, 'Received'),
        (STATUS_CANCELLED, 'Cancelled'),
    ]

    supplier = models.ForeignKey(
        Supplier, null=True, blank=True, on_delete=models.SET_NULL, related_name='purchases'
    )
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default=STATUS_ORDERED)
    total = models.DecimalField(max_digits=12, decimal_places=2, default=0)
    idempotency_key = models.CharField(max_length=100)
    received_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=['business', 'idempotency_key'], name='uniq_purchase_idempotency_key'
            )
        ]

    def __str__(self):
        return f'purchase {self.pk} ({self.status})'


class PurchaseItem(models.Model):
    purchase = models.ForeignKey(Purchase, on_delete=models.CASCADE, related_name='items')
    product = models.ForeignKey(
        ProductService, on_delete=models.PROTECT, related_name='purchase_items'
    )
    quantity = models.DecimalField(
        max_digits=12, decimal_places=3, validators=[MinValueValidator(0)]
    )
    unit_cost = models.DecimalField(
        max_digits=12, decimal_places=2, validators=[MinValueValidator(0)]
    )
    line_total = models.DecimalField(
        max_digits=12, decimal_places=2, validators=[MinValueValidator(0)]
    )
    quantity_received = models.DecimalField(max_digits=12, decimal_places=3, default=0)

    def __str__(self):
        return f'{self.product.name} x {self.quantity}'


class Expense(BusinessScopedModel):
    amount = models.DecimalField(
        max_digits=12, decimal_places=2, validators=[MinValueValidator(0)]
    )
    category = models.CharField(max_length=100)
    description = models.CharField(max_length=255, blank=True, default='')
    date = models.DateField()
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-date', '-pk']

    def __str__(self):
        return f'{self.category}: {self.amount}'


class Payment(BusinessScopedModel):
    DIRECTION_IN = 'in'
    DIRECTION_OUT = 'out'
    DIRECTION_CHOICES = [
        (DIRECTION_IN, 'In'),
        (DIRECTION_OUT, 'Out'),
    ]

    amount = models.DecimalField(
        max_digits=12, decimal_places=2, validators=[MinValueValidator(0)]
    )
    direction = models.CharField(max_length=10, choices=DIRECTION_CHOICES)
    method = models.CharField(max_length=50, blank=True, default='')
    date = models.DateField()
    sale = models.ForeignKey(
        Sale, null=True, blank=True, on_delete=models.SET_NULL, related_name='payments'
    )
    purchase = models.ForeignKey(
        Purchase, null=True, blank=True, on_delete=models.SET_NULL, related_name='payments'
    )
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL
    )
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self):
        return f'{self.direction} {self.amount}'


class Conversation(BusinessScopedModel):
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='conversations'
    )
    title = models.CharField(max_length=200, blank=True, default='')
    # Rolling memory JSON: summary, facts, open thread. Lives and dies
    # with the conversation — Clear Chat deletes the row, otherwise every
    # turn accumulates so the AI remembers requests and outcomes.
    memory = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-updated_at']

    def __str__(self):
        return self.title or f'conversation {self.pk}'


class Message(models.Model):
    ROLE_USER = 'user'
    ROLE_ASSISTANT = 'assistant'
    ROLE_SYSTEM = 'system'
    ROLE_TOOL = 'tool'
    ROLE_CHOICES = [
        (ROLE_USER, 'User'),
        (ROLE_ASSISTANT, 'Assistant'),
        (ROLE_SYSTEM, 'System'),
        (ROLE_TOOL, 'Tool'),
    ]

    conversation = models.ForeignKey(
        Conversation, on_delete=models.CASCADE, related_name='messages'
    )
    role = models.CharField(max_length=20, choices=ROLE_CHOICES)
    content = models.TextField()
    metadata = models.JSONField(default=dict)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['created_at', 'pk']

    def __str__(self):
        return f'{self.role}: {self.content[:50]}'


class ActionLog(BusinessScopedModel):
    STATUS_DRAFT = 'draft'
    STATUS_AWAITING = 'awaiting_confirmation'
    STATUS_CONFIRMED = 'confirmed'
    STATUS_COMPLETED = 'completed'
    STATUS_FAILED = 'failed'
    STATUS_CHOICES = [
        (STATUS_DRAFT, 'Draft'),
        (STATUS_AWAITING, 'Awaiting confirmation'),
        (STATUS_CONFIRMED, 'Confirmed'),
        (STATUS_COMPLETED, 'Completed'),
        (STATUS_FAILED, 'Failed'),
    ]

    actor = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL
    )
    action_type = models.CharField(max_length=100)
    request_id = models.CharField(max_length=100, blank=True, default='')
    record_type = models.CharField(max_length=100, blank=True, default='')
    record_ref = models.CharField(max_length=100, blank=True, default='')
    status = models.CharField(max_length=25, choices=STATUS_CHOICES)
    summary = models.TextField(blank=True, default='')
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        indexes = [models.Index(fields=['business', 'created_at'], name='ix_actionlog_biz_time')]
        ordering = ['-created_at', '-pk']

    def __str__(self):
        return f'{self.action_type} {self.status}'


class PendingAction(BusinessScopedModel):
    """Assistant prepared action. Moves draft -> awaiting -> confirmed -> done."""

    TYPE_SALE = 'sale'
    TYPE_EXPENSE = 'expense'
    TYPE_STOCK_RECEIPT = 'stock_receipt'
    TYPE_CATALOGUE_ITEM = 'catalogue_item'
    TYPE_CHOICES = [
        (TYPE_SALE, 'Sale'),
        (TYPE_EXPENSE, 'Expense'),
        (TYPE_STOCK_RECEIPT, 'Stock receipt'),
        (TYPE_CATALOGUE_ITEM, 'Catalogue item'),
    ]
    STATE_DRAFT = 'draft'
    STATE_AWAITING = 'awaiting_confirmation'
    STATE_CONFIRMED = 'confirmed'
    STATE_COMPLETED = 'completed'
    STATE_FAILED = 'failed'
    STATE_CHOICES = [
        (STATE_DRAFT, 'Draft'),
        (STATE_AWAITING, 'Awaiting confirmation'),
        (STATE_CONFIRMED, 'Confirmed'),
        (STATE_COMPLETED, 'Completed'),
        (STATE_FAILED, 'Failed'),
    ]
    TERMINAL_STATES = {STATE_COMPLETED, STATE_FAILED}

    conversation = models.ForeignKey(
        Conversation, null=True, blank=True, on_delete=models.SET_NULL,
        related_name='pending_actions',
    )
    action_type = models.CharField(max_length=20, choices=TYPE_CHOICES)
    state = models.CharField(max_length=25, choices=STATE_CHOICES, default=STATE_DRAFT)
    payload = models.JSONField(default=dict)
    record_type = models.CharField(max_length=100, blank=True, default='')
    record_ref = models.CharField(max_length=100, blank=True, default='')
    idempotency_key = models.CharField(max_length=100)
    summary = models.TextField(blank=True, default='')
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=['business', 'idempotency_key'], name='uniq_pending_action_key'
            )
        ]
        ordering = ['-created_at', '-pk']

    def __str__(self):
        return f'{self.action_type} {self.state}'


class Invoice(BusinessScopedModel):
    sale = models.OneToOneField(Sale, on_delete=models.CASCADE, related_name='invoice')
    invoice_number = models.CharField(max_length=50)
    document = models.JSONField(default=dict)
    issued_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL
    )
    issued_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=['business', 'invoice_number'], name='uniq_invoice_number'
            )
        ]

    def __str__(self):
        return self.invoice_number


class KnowledgeDocument(BusinessScopedModel):
    """Owner-taught business document. Step 5 knowledge base.

    Stores extracted text only (never the raw file). The assistant reads it
    through the business-scoped `search_knowledge` tool, so content stays
    data, never instructions, and never leaks across businesses.
    """

    SOURCE_PASTE = 'paste'
    SOURCE_TEXT = 'text'
    SOURCE_PDF = 'pdf'
    SOURCE_CHOICES = [
        (SOURCE_PASTE, 'Pasted text'),
        (SOURCE_TEXT, 'Text file'),
        (SOURCE_PDF, 'PDF'),
    ]

    title = models.CharField(max_length=200)
    source_type = models.CharField(max_length=20, choices=SOURCE_CHOICES, default=SOURCE_PASTE)
    original_filename = models.CharField(max_length=255, blank=True, default='')
    content = models.TextField()
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL,
        related_name='knowledge_documents',
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-created_at', '-pk']
        indexes = [models.Index(fields=['business', '-created_at'], name='knowledge_business_idx')]

    def __str__(self):
        return f'{self.business}: {self.title}'


class Receipt(BusinessScopedModel):
    sale = models.ForeignKey(Sale, on_delete=models.CASCADE, related_name='receipts')
    receipt_number = models.CharField(max_length=50)
    document = models.JSONField(default=dict)
    issued_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL
    )
    issued_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=['business', 'receipt_number'], name='uniq_receipt_number'
            )
        ]

    def __str__(self):
        return self.receipt_number
