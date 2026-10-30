"""Seed one realistic business year: team users, catalogue, sales, stock, expenses.

Targets an existing business (default: first business) so the account that
already onboarded sees a full dashboard. Idempotent unless --reset.
Login owner stays as-is; team logins use password demo1234.
"""

import random
from datetime import date, datetime, time, timedelta
from decimal import Decimal

from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from django.utils import timezone

from core.models import (
    ActionLog,
    Business,
    BusinessMembership,
    BusinessRule,
    Customer,
    Expense,
    ProductService,
    Purchase,
    PurchaseItem,
    Sale,
    SaleItem,
    StockBalance,
    StockMovement,
    Supplier,
)

TEAM = [
    ("geodev.manager", BusinessMembership.ROLE_MANAGER),
    ("geodev.sales", BusinessMembership.ROLE_SALES),
    ("geodev.inventory", BusinessMembership.ROLE_INVENTORY),
    ("geodev.finance", BusinessMembership.ROLE_FINANCE),
    ("geodev.viewer", BusinessMembership.ROLE_VIEWER),
]

PRODUCTS = [
    ("Rice 10kg", ["rice"], "9500.00", "7200.00", True),
    ("Garri 5kg", ["white garri", "garri"], "2500.00", "1800.00", True),
    ("Beans 5kg", ["beans", "ewa oloyin"], "6800.00", "5100.00", True),
    ("Palm Oil 1L", ["palm oil"], "3200.00", "2400.00", True),
    ("Groundnut Oil 1L", ["groundnut oil"], "4100.00", "3100.00", True),
    ("Sugar 1kg", ["sugar"], "1200.00", "900.00", True),
    ("Semovita 5kg", ["semo", "semovita"], "5400.00", "4050.00", True),
    ("Bread", ["loaf", "bread"], "800.00", "550.00", True),
    ("Milk Powder 400g", ["milk"], "4600.00", "3500.00", True),
    ("Home Delivery", ["delivery"], "1500.00", None, False),
]

CUSTOMERS = [
    ("Walk-in", "", ""),
    ("Funke Adeyemi", "08031234501", "funke@example.com"),
    ("Tunde Balogun", "08031234502", ""),
    ("Blessing Okafor", "08031234503", "blessing@example.com"),
    ("Ibrahim Musa", "08031234504", ""),
    ("Ngozi Eze", "08031234505", ""),
    ("Segun Ajayi", "08031234506", "segun@example.com"),
]

SUPPLIERS = [
    ("Mile 12 Foods", "08030000001", "Net 7 days"),
    ("Osogbo Grains Depot", "08030000002", "Pay on delivery"),
    ("Lagos Oil Mills", "08030000003", "Net 14 days"),
    ("FreshBake Supplies", "08030000004", "Pay on delivery"),
]

EXPENSES = [
    ("Transport", "Delivery fuel and dispatch", "4500", "9500"),
    ("Rent", "Shop rent share", "85000", "85000"),
    ("Utilities", "Power and water", "6500", "14000"),
    ("Wages", "Staff wages", "45000", "60000"),
    ("Packaging", "Bags and wrapping", "3000", "8000"),
    ("Repairs", "Shelf and scale repairs", "0", "18000"),
]


def month_start(day: date, offset: int) -> date:
    total = (day.year * 12 + day.month - 1) + offset
    return date(total // 12, total % 12 + 1, 1)


def aware(day: date, hour: int, minute: int):
    return timezone.make_aware(datetime.combine(day, time(hour, minute)))


class Command(BaseCommand):
    help = "Seed a realistic year of data into one existing business."

    def add_arguments(self, parser):
        parser.add_argument("--business-id", type=int, default=None)
        parser.add_argument("--reset", action="store_true", help="Delete prior seed_realistic data first.")

    def handle(self, *args, **options):
        business = (
            Business.objects.filter(pk=options["business_id"]).first()
            if options["business_id"]
            else Business.objects.order_by("pk").first()
        )
        if business is None:
            raise CommandError("No business exists yet. Register, finish onboarding, then rerun.")

        if options["reset"]:
            Sale.objects.filter(business=business, idempotency_key__startswith="seed-year-").delete()
            Purchase.objects.filter(business=business, idempotency_key__startswith="seed-year-").delete()
            Expense.objects.filter(business=business, description__startswith="[seed-year]").delete()
            ActionLog.objects.filter(business=business, request_id__startswith="seed-year-").delete()
            StockMovement.objects.filter(business=business, reference__startswith="seed-year").delete()
            ProductService.objects.filter(business=business, aliases__contains=["seed-year"]).delete()
            self.stdout.write("Reset prior seed-year data.")

        if Sale.objects.filter(business=business, idempotency_key__startswith="seed-year-").exists():
            self.stdout.write("Seed-year data already present. Use --reset to rebuild.")
            return

        rng = random.Random(42)
        today = timezone.localdate()
        start_month = month_start(today, -11)
        user_model = get_user_model()

        with transaction.atomic():
            owner_membership = (
                BusinessMembership.objects.filter(business=business, role=BusinessMembership.ROLE_OWNER)
                .select_related("user")
                .first()
            )
            actors = [owner_membership.user] if owner_membership else []
            team_users = {}
            for username, role in TEAM:
                user, created = user_model.objects.get_or_create(username=username)
                if created:
                    user.set_password("demo1234")
                    user.save()
                BusinessMembership.objects.update_or_create(
                    business=business,
                    user=user,
                    defaults={"role": role, "status": BusinessMembership.STATUS_ACTIVE},
                )
                team_users[role] = user
                actors.append(user)

            products = {}
            for name, aliases, price, cost, tracked in PRODUCTS:
                product, _ = ProductService.objects.get_or_create(
                    business=business,
                    name=name,
                    defaults={
                        "aliases": aliases + ["seed-year"],
                        "kind": ProductService.KIND_SERVICE if not tracked else ProductService.KIND_PRODUCT,
                        "selling_price": Decimal(price),
                        "cost_price": Decimal(cost) if cost else None,
                        "stock_tracked": tracked,
                        "active": True,
                    },
                )
                products[name] = product

            customers = [
                Customer.objects.get_or_create(business=business, name=name, defaults={"phone": phone, "email": email})[0]
                for name, phone, email in CUSTOMERS
            ]
            suppliers = [
                Supplier.objects.get_or_create(business=business, name=name, defaults={"phone": phone, "terms": terms})[0]
                for name, phone, terms in SUPPLIERS
            ]

            BusinessRule.objects.get_or_create(
                business=business,
                rule_type="low_stock_threshold",
                defaults={"structured_value": {"default": 10}, "source": BusinessRule.SOURCE_PREFERENCE},
            )

            sales_makers = [u for u in [team_users.get("sales"), team_users.get("manager")] + actors[:1] if u]
            sold_qty = {p.pk: Decimal("0") for p in products.values() if p.stock_tracked}
            sale_count = 0
            log_rows = []

            for month_index in range(12):
                first = month_start(start_month, month_index)
                next_first = month_start(first, 1)
                days_in_month = (next_first - first).days
                growth = Decimal("0.78") + Decimal(month_index) * Decimal("0.045")
                sales_this_month = int(rng.randint(20, 30) * float(growth))
                for n in range(sales_this_month):
                    day = first + timedelta(days=rng.randrange(days_in_month))
                    if day > today:
                        day = today
                    maker = rng.choice(sales_makers)
                    chosen = rng.sample(
                        [p for p in products.values()],
                        k=rng.choice([1, 1, 2, 2, 3]),
                    )
                    sale = Sale.objects.create(
                        business=business,
                        customer=rng.choice(customers),
                        status=Sale.STATUS_COMMITTED,
                        idempotency_key=f"seed-year-sale-{month_index}-{n}",
                        sold_by=maker,
                        sold_at=aware(day, rng.randint(8, 19), rng.randint(0, 59)),
                    )
                    total = Decimal("0")
                    for product in chosen:
                        qty = Decimal(rng.choice([1, 1, 2, 2, 3, 4, 5]))
                        line_total = product.selling_price * qty
                        total += line_total
                        SaleItem.objects.create(
                            sale=sale, product=product, quantity=qty,
                            unit_price=product.selling_price, line_total=line_total,
                        )
                        if product.stock_tracked:
                            sold_qty[product.pk] += qty
                    sale.subtotal = total
                    sale.total = total
                    sale.save(update_fields=["subtotal", "total"])
                    Sale.objects.filter(pk=sale.pk).update(
                        created_at=sale.sold_at, updated_at=sale.sold_at
                    )
                    sale_count += 1
                    log_rows.append((maker, "sale_commit", sale.sold_at, f"Sale #{sale.pk} total {total}"))

                for category, description, low, high in EXPENSES:
                    if Decimal(high) == 0 or rng.random() < 0.25:
                        continue
                    amount = Decimal(rng.randint(int(Decimal(low)), int(Decimal(high))))
                    if category in ("Rent", "Wages"):
                        amount = Decimal(high)
                    day = first + timedelta(days=rng.randrange(min(days_in_month, 26)))
                    if day > today:
                        day = today
                    expense = Expense.objects.create(
                        business=business,
                        amount=amount,
                        category=category,
                        description=f"[seed-year] {description}",
                        date=day,
                        created_by=team_users.get("finance") or maker,
                    )
                    Expense.objects.filter(pk=expense.pk).update(created_at=aware(day, 12, 0))
                    log_rows.append((expense.created_by, "expense_record", aware(day, 12, 0), f"{category} expense {amount}"))

            purchase_count = 0
            for quarter in range(4):
                first = month_start(start_month, quarter * 3)
                supplier = rng.choice(suppliers)
                purchase = Purchase.objects.create(
                    business=business,
                    supplier=supplier,
                    status=Purchase.STATUS_RECEIVED,
                    idempotency_key=f"seed-year-purchase-{quarter}",
                    received_by=team_users.get("inventory"),
                )
                total = Decimal("0")
                for product in [p for p in products.values() if p.stock_tracked]:
                    qty = Decimal(rng.randint(80, 220))
                    line_total = (product.cost_price or Decimal("0")) * qty
                    total += line_total
                    PurchaseItem.objects.create(
                        purchase=purchase, product=product, quantity=qty,
                        unit_cost=product.cost_price or Decimal("0"),
                        line_total=line_total, quantity_received=qty,
                    )
                    StockMovement.objects.create(
                        business=business, product=product,
                        movement_type=StockMovement.TYPE_PURCHASE,
                        quantity=qty, reference=f"seed-year:purchase:{purchase.pk}",
                        actor=team_users.get("inventory"),
                    )
                purchase.total = total
                purchase.save(update_fields=["total"])
                Purchase.objects.filter(pk=purchase.pk).update(created_at=aware(first, 9, 0))
                purchase_count += 1

            # Opening stock is purchases plus a buffer, less what sold.
            for product in [p for p in products.values() if p.stock_tracked]:
                purchased = PurchaseItem.objects.filter(purchase__business=business, product=product).aggregate(
                    total=models_sum("quantity")
                )["total"] or Decimal("0")
                balance_qty = max(Decimal("6"), purchased - sold_qty[product.pk] + Decimal("25"))
                StockBalance.objects.update_or_create(
                    business=business, product=product, location="",
                    defaults={"quantity": balance_qty},
                )
                StockMovement.objects.get_or_create(
                    business=business, product=product,
                    movement_type=StockMovement.TYPE_OPENING,
                    reference="seed-year:opening",
                    defaults={"quantity": balance_qty + sold_qty[product.pk], "actor": actors[0] if actors else None},
                )

            for actor, action_type, when, summary in log_rows:
                log = ActionLog.objects.create(
                    business=business, actor=actor, action_type=action_type,
                    request_id=f"seed-year-{action_type}-{when.date()}-{rng.randrange(10**8)}",
                    record_type="sale" if action_type == "sale_commit" else "expense",
                    status=ActionLog.STATUS_COMPLETED, summary=summary,
                )
                ActionLog.objects.filter(pk=log.pk).update(created_at=when)

        self.stdout.write(self.style.SUCCESS(
            f"Seeded {business.name}: {sale_count} sales over 12 months, "
            f"{purchase_count} stock purchases, team users {[u for u, _ in TEAM]} (password demo1234)."
        ))


def models_sum(field):
    from django.db.models import Sum

    return Sum(field)
