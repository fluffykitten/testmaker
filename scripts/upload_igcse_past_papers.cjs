const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

// 1. Read Supabase credentials from .env.local
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

// 2. Filename parser for Cambridge past papers
function parsePaperFilename(filename) {
  // Pattern: "0620 Chemistry June 2026 Question Paper  42.pdf" or "Mark Scheme"
  const m = filename.match(/(\d{4})\s+([A-Za-z]+)\s+([A-Za-z]+)\s+(\d{4})\s+(Question\s*Paper|Mark\s*Scheme)\s+(\d+)/i);
  if (m) {
    const code = m[1];
    const subject = m[2];
    const month = m[3].toLowerCase();
    const year = parseInt(m[4], 10);
    const typeStr = m[5].toLowerCase().includes('question') ? 'qp' : 'ms';
    const paper = m[6];

    let seriesVariants = [];
    let canonicalSeries = '';
    if (month === 'june' || month === 'may') {
      seriesVariants = ['May/June', 'June', 'May'];
      canonicalSeries = 'May_June';
    } else if (month === 'november' || month === 'nov' || month === 'october' || month === 'oct') {
      seriesVariants = ['October/November', 'Oct/Nov', 'November', 'Oct'];
      canonicalSeries = 'Oct_Nov';
    } else if (month === 'march' || month === 'february') {
      seriesVariants = ['February/March', 'Feb/March', 'March'];
      canonicalSeries = 'Feb_March';
    } else {
      seriesVariants = [m[3]];
      canonicalSeries = m[3];
    }

    return {
      code,
      subject,
      year,
      type: typeStr,
      seriesVariants,
      canonicalSeries,
      paper,
      filename,
    };
  }

  // Fallback: standard Cambridge short code (e.g. 0620_s23_qp_11.pdf)
  const m2 = filename.match(/(\d{4})_([mws])(\d{2})_(qp|ms)_(\d+)/i);
  if (m2) {
    const code = m2[1];
    const seasonCode = m2[2].toLowerCase();
    const yr = 2000 + parseInt(m2[3], 10);
    const typeStr = m2[4].toLowerCase();
    const p = m2[5];

    let seriesVariants = [];
    let canonicalSeries = '';
    if (seasonCode === 's') {
      seriesVariants = ['May/June', 'June', 'May'];
      canonicalSeries = 'May_June';
    } else if (seasonCode === 'w') {
      seriesVariants = ['October/November', 'Oct/Nov', 'November', 'Oct'];
      canonicalSeries = 'Oct_Nov';
    } else if (seasonCode === 'm') {
      seriesVariants = ['February/March', 'Feb/March', 'March'];
      canonicalSeries = 'Feb_March';
    }

    return {
      code,
      subject: 'Subject',
      year: yr,
      type: typeStr,
      seriesVariants,
      canonicalSeries,
      paper: p,
      filename,
    };
  }

  return null;
}

// 3. Scan directory strictly for IGCSE
function scanIgcsePdfs(dirPath, list = []) {
  if (!fs.existsSync(dirPath)) {
    console.error('Directory does not exist:', dirPath);
    return list;
  }

  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dirPath, entry.name);
    const upperFull = full.toUpperCase();

    // STRICT FILTER: Only look at IGCSE level; skip AS LEVEL / A LEVEL
    if (upperFull.includes('AS LEVEL') || upperFull.includes('A LEVEL')) {
      continue;
    }

    if (entry.isDirectory()) {
      scanIgcsePdfs(full, list);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.pdf')) {
      if (upperFull.includes('IGCSE')) {
        const parsed = parsePaperFilename(entry.name);
        if (parsed) {
          list.push({ fullPath: full, ...parsed });
        }
      }
    }
  }
  return list;
}

// 4. Main batch upload & link execution
async function main() {
  const rootDir = 'H:\\My Drive\\References\\PAST PAPER (2023 -2025)';
  console.log(`Scanning IGCSE past papers in: "${rootDir}"...`);

  const allPdfs = scanIgcsePdfs(rootDir);
  const qpPdfs = allPdfs.filter((p) => p.type === 'qp');
  const msPdfs = allPdfs.filter((p) => p.type === 'ms');

  console.log(`Discovered IGCSE PDFs: ${allPdfs.length} total (${qpPdfs.length} Question Papers, ${msPdfs.length} Mark Schemes)`);

  if (qpPdfs.length === 0) {
    console.log('No Question Paper PDFs found.');
    return;
  }

  // Pre-fetch all questions from DB
  console.log('Loading existing questions from Supabase...');
  const { data: dbQuestions, error: fetchErr } = await supabase
    .from('questions')
    .select('id, year, series, paper_number, mark_scheme, syllabuses ( subject_code )');

  if (fetchErr || !dbQuestions) {
    console.error('Failed to fetch questions from database:', fetchErr);
    return;
  }

  console.log(`Loaded ${dbQuestions.length} questions from database.`);

  const bucketName = 'exam-diagrams';
  let uploadedQpCount = 0;
  let totalQuestionsLinked = 0;
  const papersSummary = [];

  for (let i = 0; i < qpPdfs.length; i++) {
    const qp = qpPdfs[i];
    const prefix = `[${i + 1}/${qpPdfs.length}]`;

    // Storage path: papers/{code}_{year}_{series}_qp_{paper}.pdf
    const storagePath = `papers/${qp.code}_${qp.year}_${qp.canonicalSeries}_qp_${qp.paper}.pdf`;

    try {
      const fileBuffer = fs.readFileSync(qp.fullPath);

      // Upload to Supabase Storage
      const { error: uploadErr } = await supabase.storage
        .from(bucketName)
        .upload(storagePath, fileBuffer, {
          contentType: 'application/pdf',
          upsert: true,
        });

      if (uploadErr) {
        console.warn(`${prefix} Upload error for ${qp.filename}:`, uploadErr.message);
        continue;
      }

      uploadedQpCount += 1;
      const { data: urlData } = supabase.storage.from(bucketName).getPublicUrl(storagePath);
      const publicUrl = urlData?.publicUrl;

      // Find matching questions in DB
      const matchingQuestions = dbQuestions.filter((q) => {
        const qCode = q.syllabuses?.subject_code;
        const qYr = Number(q.year);
        const qSer = String(q.series || '').trim();
        const qP = String(q.paper_number || '').trim();

        return (
          qCode === qp.code &&
          qYr === qp.year &&
          qp.seriesVariants.some((v) => v.toLowerCase() === qSer.toLowerCase()) &&
          (qP === qp.paper || Number(qP) === Number(qp.paper))
        );
      });

      if (matchingQuestions.length > 0) {
        let linkedForThisPaper = 0;

        for (const row of matchingQuestions) {
          const ms =
            typeof row.mark_scheme === 'object' && row.mark_scheme !== null
              ? { ...row.mark_scheme }
              : { marking_points: ['See mark scheme'] };

          ms._source_pdf_url = publicUrl;

          const { error: updateErr } = await supabase
            .from('questions')
            .update({ mark_scheme: ms })
            .eq('id', row.id);

          if (!updateErr) {
            linkedForThisPaper += 1;
          }
        }

        totalQuestionsLinked += linkedForThisPaper;
        console.log(
          `${prefix} ${qp.code} ${qp.year} ${qp.canonicalSeries} P${qp.paper} -> Uploaded & linked ${linkedForThisPaper} questions.`
        );
        papersSummary.push({
          paper: `${qp.code} ${qp.year} ${qp.canonicalSeries} P${qp.paper}`,
          linkedQuestions: linkedForThisPaper,
          url: publicUrl,
        });
      } else {
        console.log(`${prefix} ${qp.code} ${qp.year} ${qp.canonicalSeries} P${qp.paper} -> Uploaded (0 DB questions currently matched).`);
      }
    } catch (err) {
      console.error(`${prefix} Error processing ${qp.filename}:`, err.message);
    }
  }

  console.log('\n======================================================');
  console.log('BATCH UPLOAD & CITATION LINKING COMPLETE');
  console.log('======================================================');
  console.log(`Total Question Paper PDFs Uploaded: ${uploadedQpCount}`);
  console.log(`Total Bank Questions Linked to Source PDFs: ${totalQuestionsLinked}`);
  console.log('Linked Papers Breakdown:');
  papersSummary.forEach((s) => console.log(` - ${s.paper}: ${s.linkedQuestions} questions linked`));
}

main().catch((err) => {
  console.error('Fatal error in batch upload script:', err);
});

