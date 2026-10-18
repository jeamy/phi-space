// Reject obsolete project names in tracked text, local environment keys and generated output.
// Does not inspect Git history, dependencies or runtime databases.
import { execFileSync } from 'node:child_process';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, relative } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
// The old name with any separator (-, _, ., space) or none, singular or plural, any case; not inside a word.
const obsolete = /(?<![a-z])pi[-_. ]?spaces?(?![a-z])/gi;
const files = new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {cwd:root,encoding:'utf8'}).split('\0').filter(Boolean));
async function generated(dir) {
  let entries;
  try { entries = await readdir(resolve(root,dir), {withFileTypes:true}); }
  catch (error) { if(error.code==='ENOENT')return; throw error; }
  for(const entry of entries) {
    if(['node_modules','.git','cache'].includes(entry.name))continue;
    const path = dir+'/'+entry.name;
    if(entry.isDirectory())await generated(path);
    else if(entry.isFile())files.add(path);
  }
}
for(const dir of ['dist','help-site/dist','help-site/public','help-site/.next'])await generated(dir);
const failures=[];
let checked=0;
for(const file of files) {
  const absolute=resolve(root,file);
  const stat=await lstat(absolute).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
  if(!stat?.isFile())continue;
  obsolete.lastIndex=0;
  if(obsolete.test(file))failures.push(`${file}: obsolete filename`);
  const bytes=await readFile(absolute);
  if(bytes.includes(0))continue;
  const text=bytes.toString('utf8');
  if(!Buffer.from(text).equals(bytes))continue;
  checked++;
  for(const [index,line]of text.split('\n').entries()) {
    obsolete.lastIndex=0;
    if(obsolete.test(line))failures.push(`${relative(root,absolute)}:${index+1}: obsolete name`);
  }
}
// Report keys only, never credentials or environment values. Inspect only explicitly
// project-identifying values in private testbed settings, not passwords/tokens.
for(const file of ['.env','help-site/.env','test/testbed/testbed.env']) {
  let text;try{text=await readFile(resolve(root,file),'utf8');}catch(error){if(error.code==='ENOENT')continue;throw error;}
  for(const line of text.split('\n')) {
    const key=/^\s*([A-Z_][A-Z0-9_]*)\s*=/.exec(line)?.[1];
    obsolete.lastIndex=0;
    if(key&&obsolete.test(key))failures.push(`${file}: obsolete environment key ${key}`);
    if(key&&['TESTBED_PROJECT','TESTBED_REMOTE_DIR'].includes(key)) {
      obsolete.lastIndex=0;
      if(obsolete.test(line.slice(line.indexOf('=')+1)))failures.push(`${file}: obsolete project setting ${key}`);
    }
  }
}
if(failures.length){console.error(failures.join('\n'));process.exitCode=1;}
else console.log(`Branding check passed (${checked} text files, generated output and local environment keys).`);
