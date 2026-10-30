"""Step 5 knowledge base: extraction, chunking, keyword search.

Owner documents (paste, .txt/.md, .pdf) become plain text on the server.
Search is deterministic keyword scoring over chunks, with no embeddings
and no network, so it works with the offline heuristic provider too.
Document text is always data about the shop, never instructions.
"""

import io
import re

from rest_framework.exceptions import ValidationError

MAX_DOCUMENTS_PER_BUSINESS = 20
MAX_CONTENT_CHARS = 50_000
MAX_UPLOAD_BYTES = 2 * 1024 * 1024
CHUNK_CHARS = 700

_WORD_RE = re.compile(r"[a-z0-9']+")
_STOPWORDS = {
    'the', 'and', 'for', 'our', 'your', 'what', 'does', 'did', 'how', 'much',
    'many', 'are', 'was', 'were', 'have', 'has', 'this', 'that', 'with',
    'from', 'about', 'tell', 'show', 'give', 'please', 'shop', 'business',
}


def chunk_text(content):
    """Split text into search-sized chunks on paragraph/sentence edges."""
    text = ' '.join((content or '').split())
    if not text:
        return []
    chunks, start = [], 0
    while start < len(text):
        end = min(start + CHUNK_CHARS, len(text))
        if end < len(text):
            cut = max(text.rfind('. ', start, end), text.rfind(' ', start, end))
            if cut > start:
                end = cut + 1
        chunk = text[start:end].strip()
        if chunk:
            chunks.append(chunk)
        start = end
    return chunks


def _words(text):
    return [w for w in _WORD_RE.findall((text or '').lower())
            if len(w) > 2 and w not in _STOPWORDS]


def search_documents(documents, query, limit=3):
    """Rank document chunks against a query. Returns grounded excerpts."""
    query_words = _words(query)
    if not query_words:
        return {'query': (query or '').strip(), 'matches': []}
    scored = []
    for doc in documents:
        title_words = set(_words(doc.title))
        for chunk in chunk_text(doc.content):
            chunk_words = _words(chunk)
            if not chunk_words:
                continue
            hits = sum(chunk_words.count(w) for w in set(query_words))
            title_hits = sum(1 for w in set(query_words) if w in title_words)
            score = hits + 2 * title_hits
            if score:
                scored.append((score, doc, chunk))
    scored.sort(key=lambda row: -row[0])
    return {
        'query': (query or '').strip(),
        'matches': [
            {
                'document_id': doc.pk,
                'title': doc.title,
                'source_type': doc.source_type,
                'excerpt': chunk[:600],
                'score': score,
            }
            for score, doc, chunk in scored[:limit]
        ],
    }


def clean_title(raw, fallback='Business note'):
    title = ' '.join(str(raw or '').split()).strip()
    return title[:200] or fallback


def clean_content(raw):
    content = str(raw or '').replace('\x00', ' ').strip()
    if not content:
        raise ValidationError({'content': 'Add some text first.'})
    if len(content) > MAX_CONTENT_CHARS:
        raise ValidationError({
            'content': f'Too long. Keep one document under {MAX_CONTENT_CHARS:,} characters.'
        })
    return content


def extract_upload(uploaded):
    """Return (title, source_type, content) for an uploaded file."""
    name = (getattr(uploaded, 'name', '') or 'document').strip()
    if uploaded.size > MAX_UPLOAD_BYTES:
        raise ValidationError({'file': 'File is too large. Keep it under 2 MB.'})
    raw = uploaded.read()
    lower = name.lower()
    if lower.endswith('.pdf'):
        return name, 'pdf', _pdf_text(raw)
    if lower.endswith(('.txt', '.md', '.text')):
        try:
            return name, 'text', clean_content(raw.decode('utf-8', errors='strict'))
        except UnicodeDecodeError:
            raise ValidationError({'file': 'That text file is not readable as UTF-8 text.'})
    raise ValidationError({'file': 'Upload a .pdf, .txt, or .md file, or paste the text instead.'})


def _pdf_text(raw):
    try:
        from pypdf import PdfReader
    except ImportError:
        raise ValidationError({'file': 'PDF reading is not available on this server. Paste the text instead.'})
    try:
        reader = PdfReader(io.BytesIO(raw))
        pages = [(page.extract_text() or '') for page in reader.pages]
    except Exception:
        raise ValidationError({'file': 'That PDF could not be read. Paste the text instead.'})
    text = clean_content('\n'.join(pages)) if '\n'.join(pages).strip() else ''
    if not text:
        raise ValidationError({
            'file': 'No readable text was found in that PDF (it may be scanned images). Paste the text instead.'
        })
    return text
