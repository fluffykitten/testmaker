# Supabase Storage Bucket Setup

Follow these steps in your **Supabase Dashboard** (Dashboard → Storage):

---

## 1. Create `exam-diagrams` Bucket (Public)

1. Click **"New Bucket"**
2. Name: `exam-diagrams`
3. Check **"Public bucket"** ✅
4. Click **"Create bucket"**

This bucket stores cropped diagram images from exam questions. Public access allows the frontend to load images directly via URL.

## 2. Create `raw-pdfs` Bucket (Private)

1. Click **"New Bucket"**
2. Name: `raw-pdfs`
3. Leave **"Public bucket"** unchecked ❌
4. Click **"Create bucket"**

This bucket stores uploaded original PDF past papers. Access is restricted to authenticated backend operations.

---

## 3. Storage RLS Policies

Run the following SQL in the **SQL Editor** to configure access:

```sql
-- Allow public read access to exam diagrams
CREATE POLICY "Public read access for exam diagrams"
ON storage.objects FOR SELECT
USING (bucket_id = 'exam-diagrams');

-- Allow service role to upload diagrams (used by the extraction pipeline)
CREATE POLICY "Service role upload for exam diagrams"
ON storage.objects FOR INSERT
WITH CHECK (bucket_id = 'exam-diagrams');

-- Allow authenticated users to upload PDFs
CREATE POLICY "Authenticated users can upload PDFs"
ON storage.objects FOR INSERT
WITH CHECK (
    bucket_id = 'raw-pdfs'
    AND auth.role() = 'authenticated'
);

-- Allow authenticated users to read their uploaded PDFs
CREATE POLICY "Authenticated users can read PDFs"
ON storage.objects FOR SELECT
USING (
    bucket_id = 'raw-pdfs'
    AND auth.role() = 'authenticated'
);
```

---

## Verification

After running the above:
- Navigate to **Storage → exam-diagrams** — should show empty bucket with "Public" badge
- Navigate to **Storage → raw-pdfs** — should show empty bucket (private)
- Test public URL access: any file uploaded to `exam-diagrams` should be accessible via `https://<project>.supabase.co/storage/v1/object/public/exam-diagrams/<path>`
