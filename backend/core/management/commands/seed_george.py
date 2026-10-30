"""Seed George's workspace: one owner, two businesses, two years of data.

GeoPure (NGN, retail provisions, Lagos-style) carries ~100 catalogue items
(Nigerian staples plus Ghanaian, Indian, Italian, UK, US, and Chinese
imports). GeoDevHub (USD, dev-studio hybrid) carries services plus hardware
resale. Profiles stay name-only so George completes onboarding himself;
settings/knowledge/documents are left blank for him to teach.

Destructive only with --wipe (deletes every business and non-superuser
account) or scoped with --reset (deletes just the two seeded shops).
Idempotent: reruns find the shops and stop.
"""

import random
from datetime import datetime, time, timedelta
from decimal import Decimal

from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand
from django.db import models as dj_models
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

USERNAME = "george"
PASSWORD = "secure1234"

# (name, aliases, selling, cost, tracked)
GEOPURE_PRODUCTS = [
    ("Garri 5kg", ["white garri", "garri"], "2800.00", "2000.00", True),
    ("Garri 10kg", ["garri big bag"], "5400.00", "3900.00", True),
    ("Yellow Garri 5kg", ["yellow garri"], "3000.00", "2200.00", True),
    ("Rice 10kg", ["rice"], "11500.00", "8700.00", True),
    ("Rice 25kg", ["rice bag"], "27000.00", "20500.00", True),
    ("Rice 50kg", ["rice full bag"], "52000.00", "40000.00", True),
    ("Ofada Rice 5kg", ["ofada", "local rice"], "9500.00", "7000.00", True),
    ("Basmati Rice 5kg", ["basmati", "indian rice"], "14500.00", "11000.00", True),
    ("Beans Oloyin 5kg", ["ewa oloyin", "honey beans"], "8200.00", "6100.00", True),
    ("Beans Brown 5kg", ["brown beans"], "7600.00", "5700.00", True),
    ("Black-eyed Beans 5kg", ["white beans"], "7000.00", "5200.00", True),
    ("Soya Beans 2kg", ["soya"], "3800.00", "2800.00", True),
    ("Semovita 5kg", ["semo", "semovita"], "6200.00", "4650.00", True),
    ("Semolina 5kg", ["semolina"], "5900.00", "4400.00", True),
    ("Wheat Flour 2kg", ["wheat"], "3400.00", "2500.00", True),
    ("Maize Flour 5kg", ["pap flour", "corn flour"], "4800.00", "3500.00", True),
    ("Guinea Corn 5kg", ["guinea corn"], "5200.00", "3800.00", True),
    ("Millet 5kg", ["millet"], "5000.00", "3600.00", True),
    ("Oats 500g", ["oats"], "2800.00", "2000.00", True),
    ("Cornflakes 725g", ["cornflakes", "kelloggs"], "6500.00", "4800.00", True),
    ("Fufu Powder 1kg", ["fufu"], "2600.00", "1900.00", True),
    ("Poundo Yam 5kg", ["poundo", "poundo yam"], "12500.00", "9500.00", True),
    ("Akpu Pack", ["akpu"], "1500.00", "1000.00", True),
    ("Ogbono 500g", ["ogbono"], "4500.00", "3200.00", True),
    ("Egusi 1kg", ["egusi", "melon"], "6800.00", "5000.00", True),
    ("Melon Seeds 500g", ["melon seeds"], "3500.00", "2500.00", True),
    ("Stockfish Head", ["stockfish", "okporoko"], "3200.00", "2200.00", True),
    ("Stockfish Bits 500g", ["stockfish bits"], "5600.00", "4000.00", True),
    ("Crayfish 1kg", ["crayfish"], "9500.00", "7000.00", True),
    ("Dry Catfish Pack", ["dry fish", "catfish"], "4800.00", "3400.00", True),
    ("Palm Oil 1L", ["palm oil", "red oil"], "3600.00", "2700.00", True),
    ("Palm Oil 5L", ["palm oil keg"], "17000.00", "12800.00", True),
    ("Groundnut Oil 1L", ["groundnut oil"], "4600.00", "3450.00", True),
    ("Groundnut Oil 5L", ["kings oil"], "22000.00", "16500.00", True),
    ("Vegetable Oil 1L", ["veg oil"], "4200.00", "3100.00", True),
    ("Olive Oil 500ml", ["olive oil", "italian oil"], "8900.00", "6600.00", True),
    ("Coconut Oil 500ml", ["coconut oil"], "5200.00", "3800.00", True),
    ("Suya Spice Pack", ["suya spice", "yaji"], "1200.00", "800.00", True),
    ("Pepper Soup Spice", ["pepper soup spice"], "1100.00", "750.00", True),
    ("Banga Spice", ["banga"], "1000.00", "650.00", True),
    ("Curry Powder", ["curry"], "950.00", "600.00", True),
    ("Thyme Pack", ["thyme"], "850.00", "550.00", True),
    ("Ginger Powder", ["ginger"], "1300.00", "900.00", True),
    ("Garlic Powder", ["garlic"], "1400.00", "950.00", True),
    ("Seasoning Cubes Carton", ["knorr", "maggi"], "6800.00", "5100.00", True),
    ("Titus Fish Carton", ["titus", "mackerel carton"], "45000.00", "34000.00", True),
    ("Mackerel 1kg", ["mackerel"], "5200.00", "3900.00", True),
    ("Frozen Chicken 1kg", ["chicken", "frozen chicken"], "4800.00", "3600.00", True),
    ("Frozen Turkey 1kg", ["turkey"], "6500.00", "4900.00", True),
    ("Beef Pack 1kg", ["beef", "cow meat"], "6000.00", "4500.00", True),
    ("Goat Meat Pack", ["goat meat"], "7200.00", "5400.00", True),
    ("Shaki Pack", ["shaki"], "3500.00", "2500.00", True),
    ("Kpomo Pack", ["kpomo", "ponmo"], "2800.00", "2000.00", True),
    ("Snails Pack", ["snails"], "5500.00", "4000.00", True),
    ("Smoked Fish Pack", ["smoked fish"], "4200.00", "3000.00", True),
    ("Agege Bread", ["agege bread"], "900.00", "600.00", True),
    ("Sliced Bread Family", ["sliced bread"], "1500.00", "1050.00", True),
    ("Gala Sausage Roll", ["gala"], "500.00", "320.00", True),
    ("Meat Pie", ["meat pie"], "800.00", "520.00", True),
    ("Chin-Chin Pack", ["chin chin"], "1200.00", "800.00", True),
    ("Puff-Puff Mix", ["puff puff"], "1100.00", "750.00", True),
    ("Plantain Chips", ["plantain chips"], "1000.00", "650.00", True),
    ("Banana Chips", ["banana chips"], "900.00", "600.00", True),
    ("Coconut Chips", ["coconut chips"], "1300.00", "900.00", True),
    ("Groundnuts Pack", ["groundnuts", "peanuts"], "1500.00", "1000.00", True),
    ("Cashew Nuts 500g", ["cashew"], "4800.00", "3500.00", True),
    ("Tiger Nut Drink 1L", ["kunu aya", "tiger nut"], "2200.00", "1500.00", True),
    ("Coca-Cola 50cl", ["coke"], "500.00", "350.00", True),
    ("Fanta 50cl", ["fanta"], "500.00", "350.00", True),
    ("Sprite 50cl", ["sprite"], "500.00", "350.00", True),
    ("Malt Drink", ["malt", "guinness malt"], "800.00", "560.00", True),
    ("Hollandia Yoghurt 1L", ["hollandia"], "3200.00", "2400.00", True),
    ("Chivita Orange 1L", ["chivita"], "2800.00", "2000.00", True),
    ("Nestle Water 75cl", ["nestle water"], "400.00", "260.00", True),
    ("Eva Water 75cl", ["eva"], "400.00", "260.00", True),
    ("Zobo Drink 1L", ["zobo"], "1500.00", "1000.00", True),
    ("Kunu Drink 1L", ["kunu"], "1400.00", "950.00", True),
    ("Milo Sachet Roll", ["milo"], "4500.00", "3300.00", True),
    ("Peak Milk Sachet Roll", ["peak milk"], "5200.00", "3900.00", True),
    ("Omo Detergent 1kg", ["omo"], "3400.00", "2500.00", True),
    ("Ariel Detergent 1kg", ["ariel"], "4200.00", "3100.00", True),
    ("Morning Fresh", ["morning fresh"], "1800.00", "1300.00", True),
    ("Lux Soap", ["lux"], "900.00", "620.00", True),
    ("Dettol Soap", ["dettol soap"], "1200.00", "850.00", True),
    ("Dettol Antiseptic 500ml", ["dettol"], "3800.00", "2800.00", True),
    ("Tissue Roll Pack", ["tissue", "toilet roll"], "2600.00", "1900.00", True),
    ("Close-Up Toothpaste", ["close up"], "1600.00", "1150.00", True),
    ("Oral-B Brush", ["oral b"], "1400.00", "1000.00", True),
    ("Air Freshener", ["air freshener"], "2200.00", "1600.00", True),
    ("Insecticide Spray", ["raid", "insecticide"], "3500.00", "2600.00", True),
    ("Candles Pack", ["candles"], "800.00", "500.00", True),
    ("Pampers Jumbo", ["pampers", "diapers"], "12500.00", "9400.00", True),
    ("Johnson's Baby Lotion", ["johnsons"], "4800.00", "3500.00", True),
    ("Baby Wipes Pack", ["baby wipes"], "2900.00", "2100.00", True),
    ("Sanitary Pads Pack", ["sanitary pads"], "1800.00", "1250.00", True),
    ("Hair Relaxer Kit", ["relaxer"], "3600.00", "2600.00", True),
    ("Braiding Hair Pack", ["braiding hair", "attachment"], "2500.00", "1750.00", True),
    ("Body Lotion 400ml", ["body lotion", "nivea"], "5200.00", "3800.00", True),
    ("Petroleum Jelly", ["vaseline"], "1500.00", "1050.00", True),
    ("Shaving Stick Pack", ["shaving stick", "bic"], "1200.00", "850.00", True),
]

GEODEV_PRODUCTS = [
    ("Web App MVP", ["mvp", "web app"], "2500.00", None, False),
    ("Landing Page Build", ["landing page"], "450.00", None, False),
    ("API Integration", ["api work"], "800.00", None, False),
    ("Mobile App Module", ["mobile module"], "1500.00", None, False),
    ("UI/UX Audit", ["design audit"], "600.00", None, False),
    ("Brand Identity Pack", ["branding"], "900.00", None, False),
    ("SEO Setup", ["seo"], "350.00", None, False),
    ("Monthly Maintenance", ["maintenance", "retainer"], "300.00", None, False),
    ("Hosting + Deploy Setup", ["hosting"], "200.00", None, False),
    ("Domain + SSL Setup", ["domain"], "120.00", None, False),
    ("Code Review Session", ["code review"], "250.00", None, False),
    ("Team Training Day", ["training"], "700.00", None, False),
    ("Data Dashboard", ["dashboard"], "1100.00", None, False),
    ("Chatbot Integration", ["chatbot"], "950.00", None, False),
    ("Payment Integration", ["stripe", "payments"], "750.00", None, False),
    ("Cloud Backup Setup", ["backup"], "180.00", None, False),
    ("Security Audit", ["security"], "1300.00", None, False),
    ("Workspace Email Setup", ["email setup"], "150.00", None, False),
    ("Analytics Setup", ["analytics"], "220.00", None, False),
    ("Copywriting Page", ["copywriting"], "280.00", None, False),
    ("MacBook Air M3", ["macbook"], "1099.00", "950.00", True),
    ("ThinkPad T14", ["thinkpad"], "899.00", "760.00", True),
    ("Monitor 27in", ["monitor"], "279.00", "220.00", True),
    ("Mechanical Keyboard", ["keyboard"], "129.00", "95.00", True),
    ("Wireless Mouse", ["mouse"], "49.00", "32.00", True),
    ("Webcam 1080p", ["webcam"], "89.00", "62.00", True),
    ("USB-C Dock", ["dock"], "159.00", "118.00", True),
    ("SSD 1TB", ["ssd"], "99.00", "72.00", True),
    ("HDD 2TB", ["hdd"], "74.00", "54.00", True),
    ("RAM 16GB Kit", ["ram"], "69.00", "50.00", True),
    ("HDMI Cable Pack", ["hdmi"], "25.00", "15.00", True),
    ("Power Bank 20000mAh", ["power bank"], "45.00", "30.00", True),
    ("Router WiFi 6", ["router"], "139.00", "105.00", True),
    ("Desk Lamp", ["lamp"], "39.00", "26.00", True),
    ("Office Chair", ["chair"], "249.00", "185.00", True),
    ("Laptop Backpack", ["backpack"], "79.00", "55.00", True),
    ("Laser Printer", ["printer"], "199.00", "150.00", True),
    ("Toner Cartridge", ["toner"], "69.00", "48.00", True),
    ("Standing Desk", ["standing desk"], "399.00", "300.00", True),
    ("Extension Reel", ["extension"], "35.00", "22.00", True),
]

GEOPURE_CUSTOMERS = [
    ("Walk-in", "", ""), ("Funke Adeyemi", "08031234501", "funke@example.com"),
    ("Tunde Balogun", "08031234502", ""), ("Blessing Okafor", "08031234503", "blessing@example.com"),
    ("Ibrahim Musa", "08031234504", ""), ("Ngozi Eze", "08031234505", ""),
    ("Segun Ajayi", "08031234506", "segun@example.com"), ("Aisha Bello", "08031234507", ""),
    ("Chiamaka Nwosu", "08031234508", "chiamaka@example.com"), ("Emeka Obi", "08031234509", ""),
    ("Kemi Lawal", "08031234510", ""), ("Yusuf Abdullahi", "08031234511", ""),
    ("Adaeze Okonkwo", "08031234512", "adaeze@example.com"), ("Olumide Fashola", "08031234513", ""),
    ("Fatima Sule", "08031234514", ""),
]

GEOPURE_SUPPLIERS = [
    ("Mile 12 Foods", "08030000001", "Net 7 days"),
    ("Idumota Provisions Depot", "08030000002", "Pay on delivery"),
    ("Makola Cross-Border (Ghana)", "+233241234567", "Net 14 days"),
    ("Onitsha Main Market Sourcing", "08030000003", "Pay on delivery"),
    ("UK Imports Consolidator", "+447700900111", "Prepay 50%"),
    ("Dubai Electronics & Goods", "+971501234567", "Prepay 50%"),
]

GEOPURE_EXPENSES = [
    ("Transport", "Delivery fuel and dispatch", "4500", "12000"),
    ("Rent", "Shop rent share", "120000", "120000"),
    ("Utilities", "Power and water", "8000", "22000"),
    ("Wages", "Staff wages", "60000", "90000"),
    ("Packaging", "Bags and wrapping", "4000", "11000"),
    ("Market Levy", "Local government market levy", "2500", "5000"),
    ("Repairs", "Shelf and scale repairs", "0", "25000"),
    ("Security", "Night guard contribution", "15000", "15000"),
]

GEODEV_CUSTOMERS = [
    ("Walk-in", "", ""), ("Brightline Studio", "+14155550101", "ops@brightline.example"),
    ("Northbeam SaaS", "+14155550102", "finance@northbeam.example"),
    ("Copperfield Legal", "+17135550103", "office@copperfield.example"),
    ("Juniper Health", "+12125550104", "it@juniper.example"),
    ("Atlas Logistics", "+13125550105", "tech@atlas.example"),
    ("Foundry Coffee Co", "+15125550106", "hello@foundry.example"),
    ("Lakeside Realty", "+16125550107", "marketing@lakeside.example"),
    ("Pioneer Academy", "+18185550108", "admin@pioneer.example"),
]

GEODEV_SUPPLIERS = [
    ("US Tech Distributor", "+18005550101", "Net 30 days"),
    ("Cloud Services Reseller", "+18005550102", "Monthly billing"),
    ("Office Supply Co", "+18005550103", "Net 15 days"),
]

GEODEV_EXPENSES = [
    ("Rent", "Coworking desk rent", "600", "600"),
    ("Software", "SaaS tools and licences", "80", "220"),
    ("Contractors", "Subcontracted dev work", "0", "1500"),
    ("Marketing", "Ads and listings", "50", "400"),
    ("Utilities", "Power and internet share", "60", "140"),
    ("Equipment", "Hardware refresh", "0", "900"),
]


def _aware(day, hour, minute):
    from datetime import datetime, time

    return timezone.make_aware(datetime.combine(day, time(hour, minute)))


def _month_start(day, offset):
    total = (day.year * 12 + day.month - 1) + offset
    return datetime(total // 12, total % 12 + 1, 1).date()


def _seed_business(*, owner, name, currency, business_type, products,
                   customers, suppliers, expenses, tag,
                   sales_per_month, months=24, seed=7):
    rng = random.Random(seed)
    today = timezone.localdate()
    first_month = _month_start(today, -(months - 1))
    business = Business.objects.create(
        name=name, business_type=business_type, currency=currency,
        timezone="Africa/Lagos" if currency == "NGN" else "America/New_York",
        enabled_modules=["inventory", "expenses", "invoicing", "reports"],
        settings={},
    )
    BusinessMembership.objects.create(
        business=business, user=owner, role=BusinessMembership.ROLE_OWNER,
        status=BusinessMembership.STATUS_ACTIVE,
    )
    catalogue = {}
    for pname, aliases, price, cost, tracked in products:
        catalogue[pname] = ProductService.objects.create(
            business=business, name=pname, aliases=list(aliases),
            kind=ProductService.KIND_SERVICE if not tracked else ProductService.KIND_PRODUCT,
            selling_price=Decimal(price),
            cost_price=Decimal(cost) if cost else None,
            stock_tracked=tracked, active=True,
        )
    customer_rows = [
        Customer.objects.create(business=business, name=n, phone=p, email=e)
        for n, p, e in customers
    ]
    supplier_rows = [
        Supplier.objects.create(business=business, name=n, phone=p, terms=t)
        for n, p, t in suppliers
    ]
    tracked = [p for p in catalogue.values() if p.stock_tracked]
    sold_qty = {p.pk: Decimal("0") for p in tracked}
    sales = 0
    for m in range(months):
        first = _month_start(first_month, m)
        last = _month_start(first, 1) - timedelta(days=1)
        growth = Decimal("0.80") + Decimal(m) * Decimal("0.017")
        for n in range(max(1, int(rng.randint(*sales_per_month) * float(growth)))):
            day = first + timedelta(days=rng.randrange((min(last, today) - first).days + 1))
            picks = rng.sample(list(catalogue.values()), k=rng.choice([1, 1, 2, 2, 3]))
            sale = Sale.objects.create(
                business=business, customer=rng.choice(customer_rows),
                status=Sale.STATUS_COMMITTED, idempotency_key=f"{tag}-sale-{m}-{n}",
                sold_by=owner, sold_at=_aware(day, rng.randint(8, 19), rng.randint(0, 59)),
            )
            total = Decimal("0")
            for product in picks:
                qty = Decimal(rng.choice([1, 1, 2, 2, 3, 4, 6]))
                line = product.selling_price * qty
                total += line
                SaleItem.objects.create(
                    sale=sale, product=product, quantity=qty,
                    unit_price=product.selling_price, line_total=line,
                )
                if product.stock_tracked:
                    sold_qty[product.pk] += qty
            Sale.objects.filter(pk=sale.pk).update(
                subtotal=total, total=total, created_at=sale.sold_at, updated_at=sale.sold_at,
            )
            sales += 1
        for category, description, low, high in expenses:
            if Decimal(high) == 0 or (low == "0" and rng.random() < 0.3):
                continue
            amount = Decimal(rng.randint(int(Decimal(low)), int(Decimal(high))))
            day = first + timedelta(days=rng.randrange(1, min(26, (min(last, today) - first).days + 1)))
            exp = Expense.objects.create(
                business=business, amount=amount, category=category,
                description=f"[{tag}] {description}", date=day, created_by=owner,
            )
            Expense.objects.filter(pk=exp.pk).update(created_at=_aware(day, 12, 0))
    purchases = 0
    for q in range((months + 2) // 3):
        first = _month_start(first_month, q * 3)
        purchase = Purchase.objects.create(
            business=business, supplier=rng.choice(supplier_rows),
            status=Purchase.STATUS_RECEIVED, idempotency_key=f"{tag}-purchase-{q}",
            received_by=owner,
        )
        total = Decimal("0")
        for product in tracked:
            qty = Decimal(rng.randint(60, 200))
            line = (product.cost_price or Decimal("0")) * qty
            total += line
            PurchaseItem.objects.create(
                purchase=purchase, product=product, quantity=qty,
                unit_cost=product.cost_price or Decimal("0"),
                line_total=line, quantity_received=qty,
            )
        Purchase.objects.filter(pk=purchase.pk).update(
            total=total, created_at=_aware(first, 9, 0),
        )
        purchases += 1
    for product in tracked:
        bought = PurchaseItem.objects.filter(
            purchase__business=business, product=product
        ).aggregate(total=dj_models.Sum("quantity"))["total"] or Decimal("0")
        balance = max(Decimal("6"), bought - sold_qty[product.pk] + Decimal("25"))
        StockBalance.objects.create(
            business=business, product=product, quantity=balance,
        )
    ActionLog.objects.create(
        business=business, actor=owner, action_type="seed",
        status=ActionLog.STATUS_COMPLETED,
        summary=f"[{tag}] seeded {sales} sales and {purchases} stock purchases over {months} months.",
        record_type="Business", record_ref=str(business.pk),
        request_id=f"{tag}-seed",
    )
    return business, sales, purchases


class Command(BaseCommand):
    help = "Seed george's two businesses with two years of realistic data."

    def add_arguments(self, parser):
        parser.add_argument("--wipe", action="store_true",
                            help="Delete every business and non-superuser account first.")
        parser.add_argument("--reset", action="store_true",
                            help="Delete just GeoPure and GeoDevHub first, then reseed.")

    def handle(self, *args, **options):
        user_model = get_user_model()
        if options["wipe"]:
            Business.objects.all().delete()
            removed, _ = user_model.objects.filter(is_superuser=False).delete()
            self.stdout.write(f"Wiped all businesses and {removed} non-superuser rows.")
        elif options["reset"]:
            Business.objects.filter(name__in=["GeoPure", "GeoDevHub"]).delete()
            self.stdout.write("Reset GeoPure and GeoDevHub.")
        if Business.objects.filter(name__in=["GeoPure", "GeoDevHub"]).exists():
            self.stdout.write("GeoPure/GeoDevHub already seeded. Use --reset to rebuild.")
            return
        with transaction.atomic():
            owner = user_model.objects.create_user(username=USERNAME, password=PASSWORD)
            pure, pure_sales, pure_buys = _seed_business(
                owner=owner, name="GeoPure", currency="NGN",
                business_type=Business.RETAIL, products=GEOPURE_PRODUCTS,
                customers=GEOPURE_CUSTOMERS, suppliers=GEOPURE_SUPPLIERS,
                expenses=GEOPURE_EXPENSES, tag="george-pure",
                sales_per_month=(14, 24), seed=7,
            )
            hub, hub_sales, hub_buys = _seed_business(
                owner=owner, name="GeoDevHub", currency="USD",
                business_type=Business.HYBRID, products=GEODEV_PRODUCTS,
                customers=GEODEV_CUSTOMERS, suppliers=GEODEV_SUPPLIERS,
                expenses=GEODEV_EXPENSES, tag="george-hub",
                sales_per_month=(6, 12), seed=21,
            )
            BusinessRule.objects.create(
                business=pure, rule_type="low_stock_threshold",
                structured_value={"default": 10},
                source=BusinessRule.SOURCE_PREFERENCE,
            )
            BusinessRule.objects.create(
                business=hub, rule_type="low_stock_threshold",
                structured_value={"default": 3},
                source=BusinessRule.SOURCE_PREFERENCE,
            )
        self.stdout.write(self.style.SUCCESS(
            f"Seeded {USERNAME}: GeoPure ({pure_sales} sales, {pure_buys} purchases), "
            f"GeoDevHub ({hub_sales} sales, {hub_buys} purchases). "
            "Profiles left name-only for onboarding."
        ))
