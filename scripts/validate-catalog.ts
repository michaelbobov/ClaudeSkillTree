// Validates a catalog file against the schema. Exit 1 with errors if invalid.
import * as fs from 'node:fs';
import { validateCatalog } from '../src/shared/catalog';

const file = process.argv[2] ?? 'data/catalog.json';
const result = validateCatalog(JSON.parse(fs.readFileSync(file, 'utf8')));
if (!result.ok) {
  console.log(`CATALOG INVALID ${file}\n  ${result.errors.join('\n  ')}`);
  process.exit(1);
}
console.log(`CATALOG OK ${file}: ${result.catalog.entries.length} entries, schema v${result.catalog.schemaVersion}, source ${result.catalog.source}`);
