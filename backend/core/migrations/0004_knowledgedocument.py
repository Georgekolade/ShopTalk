# Step 5: owner-taught knowledge documents.

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0003_business_address_business_brand_color_and_more'),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name='KnowledgeDocument',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('title', models.CharField(max_length=200)),
                ('source_type', models.CharField(choices=[('paste', 'Pasted text'), ('text', 'Text file'), ('pdf', 'PDF')], default='paste', max_length=20)),
                ('original_filename', models.CharField(blank=True, default='', max_length=255)),
                ('content', models.TextField()),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('business', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, to='core.business')),
                ('created_by', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='knowledge_documents', to=settings.AUTH_USER_MODEL)),
            ],
            options={
                'ordering': ['-created_at', '-pk'],
                'indexes': [models.Index(fields=['business', '-created_at'], name='knowledge_business_idx')],
            },
        ),
    ]
