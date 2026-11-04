"""Heal GeoPure and seed 26 months of honey-beans trading history.

GeoPure sells one thing well: carefully picked honey beans (Ewa Oloyin)
in 2.5 kg, 5 kg and 10 kg packs. This command brings an existing GeoPure
business (owned by the existing ``george`` account) back to that truth
and backfills a little over two years of realistic trading:

- Correct profile, hours, delivery, payment and returns policies, taught
  to the assistant as a verified knowledge document and business rules.
- Only the three honey-beans packs stay active in the catalogue. Their
  prices carry the business's real journey: a 2.5 kg pack launched at
  NGN 5,000 and rose in steps to today's NGN 7,000 (5 kg and 10 kg
  always priced at 2x and 4x). Historical sales snapshot the price of
  their era; costs inflate alongside.
- Monthly restock purchases from Nigerian grains suppliers, daily sales
  to households, caterers and resellers, cash/transfer payments,
  receipts, and the running costs of the trade (sorting and cleaning,
  packaging, transport, stall rent, power, wages, data, marketing),
  all growing and inflating month by month.
- Stock movements reconcile exactly: opening + purchases - sales is
  the closing balance left in StockBalance.

Safe by default: it heals the profile/catalogue/policies and seeds the
history only when no ``geopure-`` data exists yet, so rerunning it is
harmless. ``--replace-legacy`` first deletes this business's existing
sales, purchases, expenses, payments, receipts and stock records (the
fictional general-store history from earlier seeds), then seeds fresh.
The account, the business, memberships and customers survive both modes.
"""

import random
from datetime import date, datetime, time, timedelta
from decimal import Decimal

from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from django.db.models import Sum
from django.utils import timezone

from core.models import (
    ActionLog,
    Business,
    BusinessMembership,
    BusinessRule,
    Customer,
    Expense,
    KnowledgeDocument,
    Payment,
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

TAG = "geopure"
DEFAULT_MONTHS = 26
SEED = 20260214

# (name, aliases, price multiple of the 2.5 kg pack)
PACKS = [
    (
        "GeoPure Honey Beans 2.5kg",
        ["honey beans", "ewa oloyin", "oloyin", "honey beans 2.5kg",
         "beans 2.5", "GeoPure Oloyin"],
        Decimal("1"),
    ),
    (
        "GeoPure Honey Beans 5kg",
        ["honey beans 5kg", "ewa oloyin 5kg", "beans 5", "honey beans big"],
        Decimal("2"),
    ),
    (
        "GeoPure Honey Beans 10kg",
        ["honey beans 10kg", "ewa oloyin 10kg", "beans 10", "honey beans bulk"],
        Decimal("4"),
    ),
]

# Earlier seed names that are really the 5 kg pack in disguise.
LEGACY_PACK_NAMES = {"Beans Oloyin 5kg", "Honey Beans 5kg", "Beans 5kg"}

# (first month index, 2.5 kg price). 5 kg = 2x, 10 kg = 4x.
PRICE_ERAS = [
    (0, Decimal("5000")),
    (6, Decimal("5500")),
    (11, Decimal("6000")),
    (16, Decimal("6500")),
    (21, Decimal("7000")),
]

CUSTOMERS = [
    ("Walk-in", "", ""),
    ("Funke Adeyemi", "08031234501", "funke@example.com"),
    ("Tunde Balogun", "08031234502", ""),
    ("Blessing Okafor", "08031234503", "blessing@example.com"),
    ("Ibrahim Musa", "08031234504", ""),
    ("Ngozi Eze", "08031234505", ""),
    ("Segun Ajayi", "08031234506", "segun@example.com"),
    ("Aisha Bello", "08031234507", ""),
    ("Chiamaka Nwosu", "08031234508", "chiamaka@example.com"),
    ("Emeka Obi", "08031234509", ""),
    ("Kemi Lawal", "08031234510", ""),
    ("Yusuf Abdullahi", "08031234511", ""),
    ("Mama Nkechi Catering", "08031234512", ""),
    ("Chef Tola Events", "08031234513", "chef.tola@example.com"),
    ("Ajoke Provisions (Reseller)", "08031234514", ""),
    ("GreenBowl Kitchen", "08031234515", "orders@greenbowl.example"),
]

SUPPLIERS = [
    ("Dawanau Grains Supplier, Kano", "08030000101", "Pay on delivery"),
    ("Oyingbo Grains Market, Lagos", "08030000102", "Pay on delivery"),
    ("Bodija Grains Depot, Ibadan", "08030000103", "Net 7 days"),
    ("Mile 12 Beans Wholesaler, Lagos", "08030000104", "Pay on delivery"),
]

KNOWLEDGE_TITLE = "GeoPure — Business Profile, Products and Policies"

KNOWLEDGE = """# GeoPure — Pure Honey Beans, Carefully Picked

GeoPure sells one thing, and sells it properly: purely, carefully picked
honey beans — Ewa Oloyin, also sold as GeoPure Oloyin or Honey Beans.
Every pack is sorted to remove stones, chaff and spoilt grains, so what
reaches your pot is clean, sweet beans that cook soft and taste the way
Ewa Oloyin should.

Why cooks choose GeoPure:
- Carefully hand-picked and cleaned: no stones, no guesswork, no waste.
- Naturally sweet honey beans, the true Ewa Oloyin — never mixed with
  cheaper beans to cut cost.
- Honest weights: a 2.5 kg pack is 2.5 kg, every time.
- Packed to order in strong, sealed bags that keep the beans fresh.

## Our packs and prices

| Pack | Price |
| --- | --- |
| GeoPure Honey Beans 2.5kg | ₦7,000 |
| GeoPure Honey Beans 5kg | ₦14,000 |
| GeoPure Honey Beans 10kg | ₦28,000 |

Households start with the 2.5 kg pack; families and caterers save time
with the 5 kg and 10 kg packs. The 10 kg pack serves resellers, caterers
and heavy beans households best.

## Opening hours

Open 8:00am – 8:00pm, Monday to Sunday, every day of the week.

## Delivery and pickup

We deliver to you, or we meet in a public place where you can pick up
your pack — whichever suits you. Tell us your location when ordering
and we will agree the delivery or meeting point before payment.

## Payment

Cash and bank transfer accepted.

## Returns

No return policy: we cannot accept returns on food items. Please check
your pack at delivery or pickup; if anything about the pack itself is
wrong, tell us on the spot and we will sort it out there and then.

## How to order

Message or call during opening hours with the pack size and quantity
you want, your delivery or pickup preference, and your payment method.
We confirm availability and the total before you pay."""

RULES = [
    ("operating_hours", {
        "days": "Monday-Sunday", "opens": "08:00", "closes": "20:00",
    }),
    ("delivery_policy", {
        "delivery": True, "pickup": True,
        "detail": "We deliver, or meet in a public place for pickup.",
    }),
    ("payment_methods", {"methods": ["Cash", "Bank transfer"]}),
    ("returns_policy", {
        "returns_accepted": False,
        "detail": (
            "No return policy. Customers check the pack at delivery or "
            "pickup; problems with the pack are sorted out on the spot."
        ),
    }),
    ("low_stock_threshold", {"default": 10}),
]


def month_start(day: date, offset: int) -> date:
    total = (day.year * 12 + day.month - 1) + offset
    return date(total // 12, total % 12 + 1, 1)


def aware(day: date, hour: int, minute: int):
    return timezone.make_aware(datetime.combine(day, time(hour, minute)))


def price_2_5kg(month_index: int) -> Decimal:
    price = PRICE_ERAS[0][1]
    for first, value in PRICE_ERAS:
        if month_index >= first:
            price = value
    return price


def cost_for(price: Decimal, month_index: int) -> Decimal:
    """Wholesale cost per pack: margin tightens gently as prices rise."""
    ratio = Decimal("0.72") + Decimal(month_index) * Decimal("0.0012")
    return (price * ratio / Decimal("50")).quantize(Decimal("1")) * Decimal("50")


class Command(BaseCommand):
    help = "Heal GeoPure (honey beans) and seed 26 months of realistic history."

    def add_arguments(self, parser):
        parser.add_argument("--username", default="george")
        parser.add_argument("--business-name", default="GeoPure")
        parser.add_argument("--months", type=int, default=DEFAULT_MONTHS)
        parser.add_argument(
            "--replace-legacy", action="store_true",
            help="Delete this business's existing transactions and stock first.",
        )

    # -- healing ------------------------------------------------------

    def _heal_business(self, user, name):
        membership = (
            BusinessMembership.objects.filter(
                user=user, business__name=name,
                status=BusinessMembership.STATUS_ACTIVE,
            ).select_related("business").order_by("business__pk").first()
        )
        business = membership.business if membership else (
            Business.objects.filter(name=name).order_by("pk").first()
        )
        if business is None:
            business = Business.objects.create(
                name=name, business_type=Business.RETAIL, currency="NGN",
                timezone="Africa/Lagos", country="NG",
                enabled_modules=["inventory", "expenses", "invoicing", "reports"],
            )
        business.name = name
        business.business_type = Business.RETAIL
        business.currency = "NGN"
        business.timezone = "Africa/Lagos"
        if not business.country:
            business.country = "NG"
        modules = list(business.enabled_modules or [])
        for module in ("inventory", "expenses", "invoicing", "reports"):
            if module not in modules:
                modules.append(module)
        business.enabled_modules = modules
        business.save()
        BusinessMembership.objects.update_or_create(
            business=business, user=user,
            defaults={
                "role": BusinessMembership.ROLE_OWNER,
                "status": BusinessMembership.STATUS_ACTIVE,
            },
        )
        return business

    def _heal_catalogue(self, business):
        """Three canonical packs active; every other product retired."""
        packs = {}
        for pname, aliases, multiple in PACKS:
            product = ProductService.objects.filter(
                business=business, name=pname,
            ).first()
            if product is None and pname.endswith("5kg"):
                legacy = ProductService.objects.filter(
                    business=business, name__in=LEGACY_PACK_NAMES,
                ).exclude(name=pname).first()
                if legacy is not None:
                    legacy.name = pname
                    legacy.save(update_fields=["name"])
                    product = legacy
            current = price_2_5kg(10 ** 6) * multiple
            if product is None:
                product = ProductService.objects.create(
                    business=business, name=pname, aliases=list(aliases),
                    kind=ProductService.KIND_PRODUCT,
                    selling_price=current,
                    cost_price=cost_for(current, DEFAULT_MONTHS - 1),
                    stock_tracked=True, active=True,
                )
            else:
                product.aliases = list(aliases)
                product.kind = ProductService.KIND_PRODUCT
                product.selling_price = current
                product.cost_price = cost_for(current, DEFAULT_MONTHS - 1)
                product.stock_tracked = True
                product.active = True
                product.save()
            packs[pname] = product
        retired = (
            ProductService.objects.filter(business=business, active=True)
            .exclude(pk__in=[p.pk for p in packs.values()])
            .update(active=False)
        )
        return packs, retired

    def _heal_policies(self, business, user):
        for rule_type, value in RULES:
            BusinessRule.objects.update_or_create(
                business=business, rule_type=rule_type,
                defaults={
                    "structured_value": value,
                    "source": BusinessRule.SOURCE_ONBOARDING,
                    "verified": True, "verified_by": user,
                    "verified_at": timezone.now(),
                },
            )
        doc, _ = KnowledgeDocument.objects.update_or_create(
            business=business, title=KNOWLEDGE_TITLE,
            defaults={
                "source_type": KnowledgeDocument.SOURCE_PASTE,
                "content": KNOWLEDGE, "created_by": user,
            },
        )
        return doc

    # -- legacy replacement -------------------------------------------

    def _replace_legacy(self, business):
        Sale.objects.filter(business=business).delete()
        Purchase.objects.filter(business=business).delete()
        Expense.objects.filter(business=business).delete()
        Payment.objects.filter(business=business).delete()
        StockMovement.objects.filter(business=business).delete()
        StockBalance.objects.filter(business=business).delete()
        ActionLog.objects.filter(business=business).delete()

    # -- history --------------------------------------------------------

    def _plan_sales(self, rng, packs_list, months, first_month, today):
        """Deterministic sale specs per month, with seasonal shape."""
        plan = []
        for m in range(months):
            first = month_start(first_month, m)
            last = month_start(first, 1) - timedelta(days=1)
            last = min(last, today)
            growth = 0.72 + m * 0.036                      # steady word of mouth
            seasonal = 1.32 if first.month == 12 else 0.86 if first.month == 1 else 1.0
            count = max(8, int(rng.randint(16, 22) * growth * seasonal))
            if last == today and last.day < 28:            # current, partial month
                month_days = (month_start(first, 1) - first).days
                count = max(2, int(count * last.day / month_days))
            base_price = price_2_5kg(m)
            specs = []
            for _ in range(count):
                day = first + timedelta(days=rng.randrange((last - first).days + 1))
                lines = []
                roll = rng.random()
                chosen = (
                    [packs_list[0]] if roll < 0.52 else
                    [packs_list[1]] if roll < 0.82 else [packs_list[2]]
                )
                if rng.random() < 0.14:                    # mixed family order
                    chosen = [packs_list[0], packs_list[1]]
                for product in chosen:
                    qty = (
                        Decimal(rng.choice([1, 1, 1, 2, 2, 3]))
                        if product is packs_list[0] else
                        Decimal(rng.choice([1, 1, 2]))
                        if product is packs_list[1] else Decimal(1)
                    )
                    lines.append((product, qty))
                specs.append((day, lines, base_price))
            plan.append(specs)
        return plan

    def _write_history(self, *, business, owner, packs, months):
        rng = random.Random(SEED)
        today = timezone.localdate()
        first_month = month_start(today, -(months - 1))
        packs_list = [packs[name] for name, _, _ in PACKS]
        customers = [
            Customer.objects.get_or_create(
                business=business, name=n,
                defaults={"phone": p, "email": e},
            )[0]
            for n, p, e in CUSTOMERS
        ]
        suppliers = [
            Supplier.objects.get_or_create(
                business=business, name=n,
                defaults={"phone": p, "terms": t},
            )[0]
            for n, p, t in SUPPLIERS
        ]
        plan = self._plan_sales(rng, packs_list, months, first_month, today)
        demand = []
        for specs in plan:
            per_pack = {p.pk: Decimal("0") for p in packs_list}
            for _, lines, _ in specs:
                for product, qty in lines:
                    per_pack[product.pk] += qty
            demand.append(per_pack)

        opening = {packs_list[0].pk: Decimal("60"),
                   packs_list[1].pk: Decimal("35"),
                   packs_list[2].pk: Decimal("18")}
        for product in packs_list:
            movement = StockMovement.objects.create(
                business=business, product=product,
                movement_type=StockMovement.TYPE_OPENING,
                quantity=opening[product.pk], reference=f"{TAG}:opening",
                actor=owner,
            )
            StockMovement.objects.filter(pk=movement.pk).update(
                created_at=aware(first_month, 7, 30),
            )
        on_hand = dict(opening)
        stats = {"sales": 0, "purchases": 0, "expenses": 0, "revenue": Decimal("0")}

        for m in range(months):
            first = month_start(first_month, m)
            base_price = price_2_5kg(m)
            multiple_of = {p.pk: mult for p, (_, _, mult) in
                           zip(packs_list, PACKS)}

            # Restock at the start of the month to cover planned demand.
            purchase = Purchase.objects.create(
                business=business, supplier=suppliers[m % len(suppliers)],
                status=Purchase.STATUS_RECEIVED,
                idempotency_key=f"{TAG}-purchase-{first:%Y-%m}",
                received_by=owner,
            )
            total = Decimal("0")
            for product in packs_list:
                want = demand[m][product.pk]
                need = max(Decimal("0"), want + Decimal("12") - on_hand[product.pk])
                qty = (need / Decimal("5")).quantize(Decimal("1")) * Decimal("5")
                if qty <= 0:
                    continue
                unit_cost = cost_for(base_price * multiple_of[product.pk], m)
                line = unit_cost * qty
                total += line
                PurchaseItem.objects.create(
                    purchase=purchase, product=product, quantity=qty,
                    unit_cost=unit_cost, line_total=line, quantity_received=qty,
                )
                movement = StockMovement.objects.create(
                    business=business, product=product,
                    movement_type=StockMovement.TYPE_PURCHASE,
                    quantity=qty, reference=f"{TAG}:purchase:{purchase.pk}",
                    actor=owner,
                )
                StockMovement.objects.filter(pk=movement.pk).update(
                    created_at=aware(first + timedelta(days=1), 8, 0),
                )
                on_hand[product.pk] += qty
            Purchase.objects.filter(pk=purchase.pk).update(
                total=total, created_at=aware(first + timedelta(days=1), 8, 5),
            )
            stats["purchases"] += 1

            # Sales through the month.
            for n, (day, lines, _) in enumerate(plan[m]):
                seq = stats["sales"] + 1
                sale = Sale.objects.create(
                    business=business,
                    customer=rng.choices(
                        customers, weights=[46] + [4] * (len(customers) - 1),
                    )[0],
                    status=Sale.STATUS_COMMITTED,
                    idempotency_key=f"{TAG}-sale-{first:%Y-%m}-{n:03d}",
                    sold_by=owner,
                    sold_at=aware(day, rng.randint(8, 19), rng.randint(0, 59)),
                )
                total = Decimal("0")
                for product, qty in lines:
                    unit = base_price * multiple_of[product.pk]
                    line = unit * qty
                    total += line
                    SaleItem.objects.create(
                        sale=sale, product=product, quantity=qty,
                        unit_price=unit, line_total=line,
                    )
                    movement = StockMovement.objects.create(
                        business=business, product=product,
                        movement_type=StockMovement.TYPE_SALE,
                        quantity=qty, reference=f"{TAG}:sale:{sale.pk}",
                        actor=owner,
                    )
                    StockMovement.objects.filter(pk=movement.pk).update(
                        created_at=sale.sold_at,
                    )
                    on_hand[product.pk] -= qty
                Sale.objects.filter(pk=sale.pk).update(
                    subtotal=total, total=total,
                    created_at=sale.sold_at, updated_at=sale.sold_at,
                )
                sale.refresh_from_db()
                Payment.objects.create(
                    business=business,
                    amount=total, direction=Payment.DIRECTION_IN,
                    method=rng.choice(["Transfer", "Transfer", "Cash"]),
                    date=day, sale=sale, created_by=owner,
                )
                receipt = Receipt.objects.create(
                    business=business, sale=sale,
                    receipt_number=f"GP-{first:%Y%m}-{seq:04d}",
                    document={
                        "receipt_number": f"GP-{first:%Y%m}-{seq:04d}",
                        "business": business.name,
                        "sold_at": sale.sold_at.isoformat(),
                        "lines": [
                            {"product": p.name, "quantity": str(q),
                             "unit_price": str(base_price * multiple_of[p.pk]),
                             "line_total": str(base_price * multiple_of[p.pk] * q)}
                            for p, q in lines
                        ],
                        "subtotal": str(total), "total": str(total),
                    },
                    issued_by=owner,
                )
                Receipt.objects.filter(pk=receipt.pk).update(issued_at=sale.sold_at)
                stats["sales"] += 1
                stats["revenue"] += total

            # Running costs, inflating with the business.
            inflation = Decimal("0.80") + Decimal(m) * Decimal("0.017")
            rent = (
                Decimal("45000") if m < 12 else
                Decimal("55000") if m < 20 else Decimal("65000")
            )
            wages = (
                Decimal("60000") if m < 12 else
                Decimal("80000") if m < 20 else Decimal("100000")
            )
            monthly = [
                ("Rent", "Market stall rent", rent),
                ("Wages", "Sales assistant wages", wages),
                ("Sorting & Cleaning", "Picking stones and chaff from new stock",
                 Decimal(rng.randint(9000, 18000)) * inflation),
                ("Packaging", "Branded bags, nylon and labels",
                 Decimal(rng.randint(7000, 16000)) * inflation),
                ("Transport", "Supplier runs and customer deliveries (fuel)",
                 Decimal(rng.randint(20000, 46000)) * inflation),
                ("Utilities", "Generator fuel, power and water",
                 Decimal(rng.randint(11000, 26000)) * inflation),
                ("Phone & Data", "Phone, data and WhatsApp business line",
                 Decimal(rng.randint(5000, 10000)) * inflation),
                ("Bank Charges", "Transfer and account charges",
                 Decimal(rng.randint(2000, 5000)) * inflation),
            ]
            if m >= 6:
                monthly.append((
                    "Marketing", "WhatsApp broadcasts and Instagram adverts",
                    Decimal(rng.randint(10000, 30000)) * inflation,
                ))
            if m % 5 == 4:
                monthly.append((
                    "Repairs", "Scale, shelf and sealing machine repairs",
                    Decimal(rng.randint(15000, 55000)) * inflation,
                ))
            for category, description, amount in monthly:
                day = first + timedelta(days=rng.randrange(1, 26))
                if day > today:
                    day = today
                expense = Expense.objects.create(
                    business=business, amount=amount.quantize(Decimal("1")),
                    category=category,
                    description=f"[{TAG}] {description}",
                    date=min(day, today), created_by=owner,
                )
                Expense.objects.filter(pk=expense.pk).update(
                    created_at=aware(min(day, today), 12, 0),
                )
                stats["expenses"] += 1

        for product in packs_list:
            StockBalance.objects.update_or_create(
                business=business, product=product, location="",
                defaults={"quantity": on_hand[product.pk]},
            )
        ActionLog.objects.create(
            business=business, actor=owner, action_type="seed",
            status=ActionLog.STATUS_COMPLETED, request_id=f"{TAG}-seed",
            record_type="Business", record_ref=str(business.pk),
            summary=(
                f"[{TAG}] Healed GeoPure and seeded {stats['sales']} sales, "
                f"{stats['purchases']} restocks and {stats['expenses']} "
                f"expenses over {months} months. Revenue {stats['revenue']}."
            ),
        )
        return stats

    # -- entry point ----------------------------------------------------

    def handle(self, *args, **options):
        user_model = get_user_model()
        user = user_model.objects.filter(username=options["username"]).first()
        if user is None:
            raise CommandError(
                f"No user named {options['username']!r}. Create the account "
                "first; this seeder never invents logins or passwords."
            )
        months = max(1, int(options["months"]))
        with transaction.atomic():
            business = self._heal_business(user, options["business_name"])
            if options["replace_legacy"]:
                self._replace_legacy(business)
                self.stdout.write(
                    "Cleared existing GeoPure transactions for a clean reseed."
                )
            packs, retired = self._heal_catalogue(business)
            self._heal_policies(business, user)
            already = Sale.objects.filter(
                business=business, idempotency_key__startswith=f"{TAG}-sale-",
            ).exists()
            stats = None
            if already and not options["replace_legacy"]:
                # Rerun after seeding: reconcile balances from movements.
                for product in packs.values():
                    bought = StockMovement.objects.filter(
                        business=business, product=product,
                        movement_type__in=[
                            StockMovement.TYPE_OPENING,
                            StockMovement.TYPE_PURCHASE,
                        ],
                    ).aggregate(t=Sum("quantity"))["t"] or Decimal("0")
                    sold = StockMovement.objects.filter(
                        business=business, product=product,
                        movement_type=StockMovement.TYPE_SALE,
                    ).aggregate(t=Sum("quantity"))["t"] or Decimal("0")
                    StockBalance.objects.update_or_create(
                        business=business, product=product, location="",
                        defaults={"quantity": bought - sold},
                    )
            else:
                stats = self._write_history(
                    business=business, owner=user, packs=packs, months=months,
                )
        if stats is None:
            self.stdout.write(self.style.SUCCESS(
                f"GeoPure healed for {user.username}: 3 packs active "
                f"({retired} other products retired), policies and knowledge "
                "refreshed. History already seeded; balances reconciled. "
                "Use --replace-legacy to rebuild history from scratch."
            ))
        else:
            self.stdout.write(self.style.SUCCESS(
                f"GeoPure healed and seeded for {user.username}: "
                f"{stats['sales']} sales, {stats['purchases']} restocks, "
                f"{stats['expenses']} expenses over {months} months, "
                f"revenue NGN {stats['revenue']}. {retired} other "
                "products retired. Prices: 2.5kg NGN 5,000 at launch, "
                "NGN 7,000 today."
            ))
