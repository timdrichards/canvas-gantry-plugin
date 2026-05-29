import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';
import juice from 'juice';

const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_CSS = resolve(PLUGIN_DIR, 'lib', 'canvas-default.css');

const die  = (msg) => { console.error(`error: ${msg}`); process.exit(1); };
const info = (msg) => console.log(`  → ${msg}`);

async function dieWithCanvasError(res, action) {
  let detail = '';
  try {
    const json = await res.json();
    const msgs = json.errors?.map(e => e.message ?? JSON.stringify(e)).join('; ');
    if (msgs) detail = `: ${msgs}`;
  } catch { /* non-JSON body */ }
  die(`Failed to ${action} page (HTTP ${res.status})${detail}`);
}

// ----------------------------------------------------------------
// Canvas API helpers
// ----------------------------------------------------------------

function canvasDomain() {
  return (process.env.CANVAS_DOMAIN ?? '').replace(/^https?:\/\//, '').replace(/\/$/, '');
}

async function canvasApi(path, options = {}) {
  const domain = canvasDomain();
  if (!domain) die('CANVAS_DOMAIN is not set. Export it or add it to your .env file.');
  const token = process.env.CANVAS_API_TOKEN ?? '';
  if (!token)  die('CANVAS_API_TOKEN is not set. Export it or add it to your .env file.');

  const headers = { Authorization: `Bearer ${token}` };
  if (options.body) headers['Content-Type'] = 'application/json';

  return fetch(`https://${domain}/api/v1/${path}`, {
    ...options,
    headers: { ...headers, ...options.headers },
  });
}

// ----------------------------------------------------------------
// Markdown / HTML helpers
// ----------------------------------------------------------------

function markdownToHtml(filePath, cssPath) {
  const html = marked.parse(readFileSync(filePath, 'utf8'));
  if (!cssPath || !existsSync(cssPath)) return html;

  const css = readFileSync(cssPath, 'utf8');
  const inlined = juice.inlineContent(html, css);
  // juice may wrap in a full document — extract the body content
  return inlined.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1]?.trim() ?? inlined;
}

function canvasSlug(title) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function extractTitle(filePath) {
  const match = readFileSync(filePath, 'utf8').match(/^# (.+)$/m);
  return match?.[1]?.trim() ?? null;
}

// ----------------------------------------------------------------
// Subcommands
// ----------------------------------------------------------------

async function cmdCourses(args) {
  let role = '', state = 'available';

  for (let i = 0; i < args.length; i++) {
    if      (args[i] === '--role')  role  = args[++i] ?? die('--role requires a value');
    else if (args[i] === '--state') state = args[++i] ?? die('--state requires a value');
    else die(`Unknown option: ${args[i]}`);
  }

  let query = `enrollment_state=${state}&per_page=100`;
  if (role) query += `&enrollment_type[]=${role}`;

  info(`Fetching courses from ${canvasDomain()}...`);
  console.log('');

  const res = await canvasApi(`courses?${query}`);
  if (!res.ok) die(`API request failed (HTTP ${res.status}). Check your CANVAS_DOMAIN and CANVAS_API_TOKEN.`);

  const courses = await res.json();
  if (!Array.isArray(courses) || courses.length === 0) {
    info('No courses found.');
    return;
  }

  const rows = courses.map(c => [String(c.id), c.course_code ?? '—', c.name ?? '']);
  const widths = rows.reduce(
    (acc, row) => row.map((cell, i) => Math.max(acc[i] ?? 0, cell.length)),
    [0, 0, 0],
  );
  for (const row of rows) {
    console.log('  ' + row.map((cell, i) => cell.padEnd(widths[i])).join('  '));
  }
  console.log('');
}

async function cmdPage(args) {
  let courseId = '', filePath = '', title = '';
  let published = false;
  let cssPath = existsSync(DEFAULT_CSS) ? DEFAULT_CSS : '';

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if      (arg === '--title')     title     = args[++i] ?? die('--title requires a value');
    else if (arg === '--published') published = true;
    else if (arg === '--draft')     published = false;
    else if (arg === '--css')       cssPath   = resolve(args[++i] ?? die('--css requires a value'));
    else if (arg === '--no-css')    cssPath   = '';
    else if (arg.startsWith('-'))   die(`Unknown option: ${arg}`);
    else if (!courseId)             courseId  = arg;
    else if (!filePath)             filePath  = arg;
    else die(`Unexpected argument: ${arg}`);
  }

  if (!courseId || !filePath) {
    die('Usage: canvas page <course_id> <markdown_file> [--title <title>] [--published|--draft] [--css <file>|--no-css]');
  }
  if (!existsSync(filePath)) die(`File not found: ${filePath}`);

  info(`Course ID: ${courseId}`);

  if (!title) {
    title = extractTitle(filePath) ?? die(`No title found in '${filePath}'. Add a # heading or use --title.`);
  }

  const slug = canvasSlug(title);
  const statusLabel = published ? 'published' : 'draft';

  info(`Converting '${filePath}' to HTML${cssPath ? ' with inline styles' : ''}...`);
  const html = markdownToHtml(filePath, cssPath);

  // GET the page to determine create vs. update
  info(`Checking for existing page '${title}'...`);
  const checkRes = await canvasApi(`courses/${courseId}/pages/${slug}`);
  const pageExists = checkRes.ok && typeof (await checkRes.json()).url === 'string';

  const body = JSON.stringify({ wiki_page: { title, body: html, published } });
  let action;

  if (pageExists) {
    info('Page exists — updating...');
    const res = await canvasApi(`courses/${courseId}/pages/${slug}`, { method: 'PUT', body });
    if (!res.ok) await dieWithCanvasError(res, 'update');
    action = 'updated';
  } else {
    info('Page not found — creating...');
    const res = await canvasApi(`courses/${courseId}/pages`, { method: 'POST', body });
    if (!res.ok) await dieWithCanvasError(res, 'create');
    action = 'created';
  }

  console.log('');
  info(`Page '${title}' ${action} (${statusLabel})`);
  info(`View: https://${canvasDomain()}/courses/${courseId}/pages/${slug}`);
  console.log('');
}

function cmdHelp() {
  console.log(`
  canvas — Canvas LMS course management tools

  SETUP

    Two environment variables are required:

      CANVAS_DOMAIN      Your institution's Canvas hostname.
                         Accepts either form:
                           school.instructure.com
                           https://school.instructure.com

      CANVAS_API_TOKEN   Personal access token.
                         Canvas → Account → Settings → New Access Token

    Add them to your shell profile or /gantry/.bashrc.user so they are
    available in every container session.

  SUBCOMMANDS

    courses [options]
        List courses for the authenticated user.

        --role <role>      Filter by enrollment role:
                           teacher | student | ta | observer | designer
        --state <state>    Filter by enrollment state (default: available):
                           available | completed | unpublished | all

    page <course_id> <markdown_file> [options]
        Create or update a Canvas wiki page from a Markdown file.
        If a page with the same title already exists it is updated in place;
        otherwise a new page is created. Pages are left as drafts by default.

        The page title is taken from the first top-level heading (# Title)
        in the file; use --title to override it.

        By default, styles from lib/canvas-default.css are inlined into
        each element as style="" attributes (Canvas strips <style> tags).
        Provide --css to use your own stylesheet or --no-css for plain HTML.

        --title <title>    Override the page title
        --published        Publish the page immediately
        --draft            Leave the page unpublished (default)
        --css <file>       CSS file to inline into the HTML output
        --no-css           Skip style inlining entirely

    help
        Show this help text.

  EXAMPLES

    canvas courses
    canvas courses --role teacher
    canvas courses --role teacher --state all

    canvas page 12345 week1.md
    canvas page 12345 week1.md --published
    canvas page 12345 week1.md --title "Week 1 — Introduction" --published
    canvas page 12345 week1.md --css my-styles.css --published
    canvas page 12345 week1.md --no-css --published
  `);
}

// ----------------------------------------------------------------
// Entry point
// ----------------------------------------------------------------

async function main() {
  const [cmd = 'help', ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'courses':        await cmdCourses(rest); break;
    case 'page':           await cmdPage(rest);    break;
    case 'help':
    case '--help':
    case '-h':             cmdHelp(); break;
    default: die(`Unknown command '${cmd}'. Run 'canvas help' for usage.`);
  }
}

main().catch(err => die(err.message));
