import { createClient } from '@supabase/supabase-js';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';

const execAsync = promisify(exec);

const SUPABASE_URL = 'https://jtxmlmexvfvrkhfavwdr.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp0eG1sbWV4dmZ2cmtoZmF2d2RyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODcwMDgwMDAsImV4cCI6MjEwMjU4NDAwMH0.XYNfas-QeYVGu1REVOm-Ub1jGwPDEQSnU9LFAF8n7gI';
const BUCKET_NAME = 'testmaker-diagrams';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const TEMP_DIR = path.resolve('scratch/migration_temp');

if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

async function uploadFileToR2(localPath, r2Key, mimeType) {
  const cmd = `npx.cmd wrangler r2 object put "${BUCKET_NAME}/${r2Key}" --file "${localPath}" --content-type "${mimeType}" --remote`;
  await execAsync(cmd);
}

async function getMimeType(fileName) {
  if (fileName.endsWith('.webp')) return 'image/webp';
  if (fileName.endsWith('.png')) return 'image/png';
  if (fileName.endsWith('.jpg') || fileName.endsWith('.jpeg')) return 'image/jpeg';
  if (fileName.endsWith('.webm')) return 'audio/webm';
  if (fileName.endsWith('.mp3')) return 'audio/mpeg';
  if (fileName.endsWith('.wav')) return 'audio/wav';
  return 'application/octet-stream';
}

async function run() {
  console.log('🚀 Starting Cloudflare R2 Migration via Wrangler CLI...');

  // 1. Fetch list of diagrams
  const { data: diagrams, error: dErr } = await supabase.storage.from('exam-diagrams').list('diagrams', { limit: 1000 });
  if (dErr) throw dErr;
  console.log(`Found ${diagrams.length} diagrams in Supabase Storage.`);

  // 2. Fetch list of audio
  const { data: audioFiles, error: aErr } = await supabase.storage.from('exam-diagrams').list('audio', { limit: 1000 });
  const audioCount = audioFiles ? audioFiles.length : 0;
  console.log(`Found ${audioCount} audio files in Supabase Storage.`);

  const allItems = [
    ...diagrams.filter(d => d.name && !d.name.startsWith('.')).map(d => ({ folder: 'diagrams', name: d.name })),
    ...(audioFiles || []).filter(a => a.name && !a.name.startsWith('.')).map(a => ({ folder: 'audio', name: a.name }))
  ];

  console.log(`Total files to migrate: ${allItems.length}`);

  let completed = 0;
  let skipped = 0;
  let errors = 0;

  // Process with concurrency limit of 6
  const CONCURRENCY = 6;
  const queue = [...allItems];

  async function worker(workerId) {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) break;

      const r2Key = `${item.folder}/${item.name}`;
      const mime = await getMimeType(item.name);
      const tempPath = path.join(TEMP_DIR, `${item.folder}_${item.name}`);

      try {
        // Check if file is already in backup/diagrams
        const backupPath = path.resolve(`backup/${item.folder}/${item.name}`);
        let sourcePath = tempPath;

        if (fs.existsSync(backupPath)) {
          sourcePath = backupPath;
        } else {
          // Download from Supabase
          const { data, error } = await supabase.storage.from('exam-diagrams').download(`${item.folder}/${item.name}`);
          if (error || !data) {
            throw new Error(`Download failed: ${error?.message}`);
          }
          const buf = Buffer.from(await data.arrayBuffer());
          fs.writeFileSync(tempPath, buf);
        }

        // Upload to Cloudflare R2
        await uploadFileToR2(sourcePath, r2Key, mime);
        completed++;
        process.stdout.write(`\r[${completed}/${allItems.length}] Migrated: ${r2Key} (${Math.round(completed / allItems.length * 100)}%)`);

        // Clean up temp file if downloaded
        if (sourcePath === tempPath && fs.existsSync(tempPath)) {
          fs.unlinkSync(tempPath);
        }
      } catch (err) {
        errors++;
        console.error(`\n❌ Failed ${r2Key}:`, err.message);
      }
    }
  }

  const workers = Array.from({ length: CONCURRENCY }, (_, i) => worker(i + 1));
  await Promise.all(workers);

  console.log(`\n\n🎉 Migration finished!`);
  console.log(`✓ Successfully uploaded: ${completed}`);
  if (errors > 0) console.log(`⚠️ Errors: ${errors}`);
}

run().catch(console.error);
