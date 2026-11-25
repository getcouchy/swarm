#!/usr/bin/env node
// Writes the protocol's documents (PROTOCOL.md, TICK.md, ARCHITECT.md) from
// their templates in templates/ and the settings (lib/config.mjs, lib/render.mjs).
//
//   node render.mjs                write each document at the root of this repository
//   node render.mjs --check        exit 1 if a document isn't what its template renders to
//   node render.mjs --print TICK.md   print one, rendered with the settings in use
//
// An agent reads the documents as they are in this repository, so render and
// commit them whenever a template, a note or the settings change (`npm run
// docs`); the tests fail while they differ. `--print` is for a deployment
// that points SWARM_CONFIG at settings of its own, whose documents are not
// the ones committed here.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config, toolsRoot } from './lib/config.mjs';
import { DOCUMENTS, renderDocument } from './lib/render.mjs';

const [flag, name] = process.argv.slice(2);
if (flag === '--print') {
  if (!DOCUMENTS.includes(name)) {
    console.error(`render.mjs --print <${DOCUMENTS.join(' | ')}>`);
    process.exit(2);
  }
  process.stdout.write(renderDocument(name, config));
} else if (flag === '--check') {
  const stale = DOCUMENTS.filter((doc) => {
    try {
      return readFileSync(join(toolsRoot, doc), 'utf8') !== renderDocument(doc, config);
    } catch {
      return true; // not written yet
    }
  });
  if (stale.length) {
    console.error(`${stale.join(', ')}: not what templates/ renders to with ${config.file ?? 'the default settings'}. Run: npm run docs`);
    process.exit(1);
  }
} else if (!flag) {
  for (const doc of DOCUMENTS) {
    writeFileSync(join(toolsRoot, doc), renderDocument(doc, config));
    console.log(`wrote ${doc}`);
  }
} else {
  console.error('render.mjs [--check | --print <document>]');
  process.exit(2);
}
