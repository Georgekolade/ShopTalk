from core.models import Business

n = Business.objects.filter(name="Ada's Provisions").update(
    country='NG',
    phone='08030000000',
    email='ada@adasprovisions.example',
    address='12 Market Road, Lagos',
    brand_color='#14532d',
)
print('updated', n)
