import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { analyzeProjectContext } from './openrouter.js';

const execFileAsync = promisify(execFile);
const ignoredDirs = new Set(['.git','node_modules','.next','dist','build','coverage','.cache','.turbo','vendor','venv','.venv','__pycache__']);
const ignoredNames = /(^\.env($|\.)|secret|credential|\.pem$|\.key$|id_rsa|token|password|package-lock\.json|yarn\.lock|pnpm-lock)/i;
const useful = /(^|\/)(readme|agents|project_notes|roadmap|todo|changelog|package\.json|pyproject\.toml|cargo\.toml|go\.mod|dockerfile|compose|.*\.(md|txt|json|ya?ml|toml|js|jsx|ts|tsx|py|rs|go|java|cs|php|rb|swift|sql|html|css))$/i;

// Filename-based exclusion (above) misses a secret sitting in an innocuously-named file, e.g. a
// hardcoded key in config.js. This scans file *content* for common credential shapes and redacts
// them before the excerpt ever leaves the machine. It errs toward over-redacting: a false-positive
// match just costs the analyzer a little context, while a missed one leaks a credential.
const secretPatterns = [
  /sk-or-v1-[a-z0-9]{20,}/gi,                                      // OpenRouter
  /sk-(live|test|proj)?-?[A-Za-z0-9]{20,}/g,                       // OpenAI-style / Stripe secret-ish
  /gh[pousr]_[A-Za-z0-9]{30,}/g,                                    // GitHub tokens
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,                                              // AWS access key id
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,                                   // Slack tokens
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,  // JWT
  /(api[_-]?key|secret|token|password|passwd|client[_-]?secret)\s*[:=]\s*['"]?[A-Za-z0-9_\-/+=]{12,}['"]?/gi
];

function redactSecrets(text) {
  let redacted = text;
  let hits = 0;
  for (const pattern of secretPatterns) {
    redacted = redacted.replace(pattern, match => {
      hits += 1;
      const splitAt = match.search(/[:=]/);
      const label = splitAt === -1 ? '' : match.slice(0, splitAt + 1);
      return `${label}[REDACTED]`;
    });
  }
  return { redacted, hits };
}

async function git(root, args) {
  try { return (await execFileAsync('git', ['-C', root, ...args], { timeout: 10000, maxBuffer: 1024 * 1024 })).stdout.trim(); }
  catch { return ''; }
}

function walk(root, dir = root, found = []) {
  if (found.length >= 180) return found;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || ignoredNames.test(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (!ignoredDirs.has(entry.name)) walk(root, full, found); }
    else { const relative = path.relative(root, full).replaceAll('\\','/'); if (useful.test(relative)) found.push({ full, relative, stat: fs.statSync(full) }); }
    if (found.length >= 180) break;
  }
  return found;
}

export async function collectProject(rootPath) {
  if (!rootPath || !path.isAbsolute(rootPath)) throw new Error('Enter the full absolute project folder path before analysis.');
  const root = fs.realpathSync(rootPath);
  if (!fs.statSync(root).isDirectory()) throw new Error('Project path is not a directory.');
  const files = walk(root).sort((a,b) => /readme|agents|roadmap|todo|package\.json/i.test(b.relative) - /readme|agents|roadmap|todo|package\.json/i.test(a.relative));
  let budget = 120000;
  const excerpts = [];
  let redactedCount = 0;
  for (const file of files) {
    if (budget <= 0 || file.stat.size > 250000) continue;
    let text; try { text = fs.readFileSync(file.full, 'utf8'); } catch { continue; }
    if (text.includes('\0')) continue;
    const raw = text.slice(0, Math.min(9000, budget));
    const { redacted, hits } = redactSecrets(raw);
    redactedCount += hits;
    budget -= redacted.length;
    excerpts.push({ path: file.relative, excerpt: redacted });
  }
  if (redactedCount) console.log(`Project analysis redacted ${redactedCount} likely secret(s) from ${path.basename(root)} before sending context to OpenRouter.`);
  const [head, status, log] = await Promise.all([
    git(root, ['rev-parse','HEAD']), git(root, ['status','--short']), git(root, ['log','-8','--pretty=format:%h %ad %s','--date=short'])
  ]);
  const fingerprint = crypto.createHash('sha256').update(`${head}\n${status}\n${files.map(f=>`${f.relative}:${f.stat.mtimeMs}:${f.stat.size}`).join('\n')}`).digest('hex');
  return { root, fingerprint, tree: files.map(f=>f.relative), git: { head, status, recentCommits: log }, files: excerpts };
}

export async function inspectProject(project) {
  const context = await collectProject(project.root_path);
  const plan = await analyzeProjectContext({ project: { name: project.name, description: project.description }, ...context });
  return { context, plan };
}
