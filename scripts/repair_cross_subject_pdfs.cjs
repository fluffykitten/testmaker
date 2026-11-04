const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

// Read Supabase credentials from .env.local
const envPath = path.resolve(process.cwd(), '.env.local');
if (!fs.existsSync(envPath)) {
  console.error('.env.local file not found at:', envPath);
  process.exit(1);
}

const envContent = fs.readFileSync(envPath, 'utf8');
const supabaseUrl = envContent.match(/VITE_SUPABASE_URL=(.*)/)?.[1]?.trim();
const supabaseKey = envContent.match(/VITE_SUPABASE_ANON_KEY=(.*)/)?.[1]?.trim();

if (!supabaseUrl || !supabaseKey) {
  console.error('Supabase URL or Key missing in .env.local');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function repairCrossSubjectPdfs() {
  console.log('=== Starting Cross-Subject Source PDF Remediation ===');

  // 1. Fetch questions across all syllabuses
  const { data: questions, error } = await supabase
    .from('questions')
    .select('id, syllabus_id, year, series, paper_number, question_number, mark_scheme, syllabuses(subject_code, subject_name)')
    .limit(3000);

  if (error || !questions) {
    console.error('Failed to fetch questions:', error);
    process.exit(1);
  }

  console.log(`Fetched ${questions.length} questions from database.`);

  // 2. Identify questions where PDF belongs to another subject (e.g. 0620 attached to non-0620)
  const contaminated = questions.filter((q) => {
    const pdf = q.mark_scheme?._source_pdf_url;
    if (!pdf) return false;
    const subCode = q.syllabuses?.subject_code || '';
    
    // Check if PDF path has a subject code prefix that doesn't match this syllabus
    const match = pdf.match(/papers\/([A-Za-z0-9_-]+?)_\d{4}/);
    if (match) {
      const pdfSubjectCode = match[1];
      return pdfSubjectCode.toLowerCase() !== subCode.toLowerCase();
    }
    return false;
  });

  console.log(`Identified ${contaminated.length} contaminated questions requiring cleanup.`);

  if (contaminated.length === 0) {
    console.log('No contaminated questions found. Database is clean!');
    return;
  }

  // 3. Clean up each contaminated row
  let successCount = 0;
  let failCount = 0;

  for (const q of contaminated) {
    const subName = q.syllabuses?.subject_name || 'Subject';
    const subCode = q.syllabuses?.subject_code || 'Code';
    const badPdf = q.mark_scheme?._source_pdf_url;

    const updatedMs = typeof q.mark_scheme === 'object' && q.mark_scheme !== null
      ? { ...q.mark_scheme }
      : {};
    
    delete updatedMs._source_pdf_url;

    const payload = { mark_scheme: updatedMs };

    const { error: updateErr } = await supabase
      .from('questions')
      .update(payload)
      .eq('id', q.id);

    if (updateErr) {
      console.error(`Failed to clean question ${q.id} (${subName} ${subCode} ${q.year} P${q.paper_number} Q${q.question_number}):`, updateErr.message);
      failCount += 1;
    } else {
      successCount += 1;
    }
  }

  console.log(`\nCleanup complete: ${successCount} successfully cleaned, ${failCount} failed.`);

  // 4. Verify post-cleanup state
  const { data: verifyQuestions } = await supabase
    .from('questions')
    .select('id, mark_scheme, syllabuses(subject_code)')
    .limit(3000);

  const remainingContaminated = (verifyQuestions || []).filter((q) => {
    const pdf = q.mark_scheme?._source_pdf_url;
    if (!pdf) return false;
    const subCode = q.syllabuses?.subject_code || '';
    const match = pdf.match(/papers\/([A-Za-z0-9_-]+?)_\d{4}/);
    if (match) {
      return match[1].toLowerCase() !== subCode.toLowerCase();
    }
    return false;
  });

  console.log(`Remaining mismatched questions in database: ${remainingContaminated.length}`);
  if (remainingContaminated.length === 0) {
    console.log('SUCCESS: All cross-subject contaminated PDFs have been removed!');
  } else {
    console.warn(`WARNING: ${remainingContaminated.length} questions still have mismatched PDFs.`);
  }
}

repairCrossSubjectPdfs().catch((err) => {
  console.error('Fatal error during repair:', err);
  process.exit(1);
});

