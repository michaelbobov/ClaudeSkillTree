// Trimmed catalog for the portfolio page's skill finder (Portfolio: public/side-projects/skilltree/catalog-lite.json):
// installable skills only, short field names, descriptions cut to 260 characters, whole-repository stars.
//   node scripts/demo/lite-catalog.mjs <catalog.json> <out.json>
// Use the hosted catalog (https://michaelbobov.github.io/ClaudeSkillTree/catalog-v1.json) so the page
// searches the same list the extension loads.
import * as fs from 'node:fs';

const [src, out] = process.argv.slice(2);
if (!src || !out) {
  console.error('usage: node scripts/demo/lite-catalog.mjs <catalog.json> <out.json>');
  process.exit(2);
}
const catalog = JSON.parse(fs.readFileSync(src, 'utf8'));
const skills = catalog.entries
  .filter((e) => e.kind === 'skill')
  .map((e) => ({
    id: e.id,
    n: e.name,
    r: `${e.owner}/${e.repo}`,
    p: e.path,
    d: e.description.slice(0, 260),
    c: e.category,
    s: catalog.repositoryStats?.[`${e.owner}/${e.repo}`]?.stars ?? 0,
  }));
const lite = { generatedAt: catalog.generatedAt, repositories: catalog.repositories.length, count: skills.length, skills };
fs.writeFileSync(out, JSON.stringify(lite));
console.log(`LITE OK ${skills.length} skills from ${lite.repositories} repositories (${catalog.generatedAt}) → ${out} (${Math.round(fs.statSync(out).size / 1024)} KB)`);
