/**
 * Integration test for the deltachat channel's single reach-in: the
 * self-registration import in the `src/channels/index.ts` barrel. Importing the
 * barrel is what causes deltachat.ts to run its top-level
 * `registerChannelAdapter('deltachat', …)`; without the import the channel is
 * silently absent. Delete the `import './deltachat.js';` line and this goes red.
 *
 * Why structural (parse the barrel) rather than behavior (import the barrel and
 * query getRegisteredChannelNames()): deltachat.ts imports
 * `@deltachat/stdio-rpc-server` — a native messaging-core package — at module
 * load, so importing the barrel would pull that native dep (and every other
 * installed channel) into the host test process, breaking hermeticity. The
 * registration call is unconditional at the top level of deltachat.ts, and the
 * build/typecheck leg already proves that import resolves, so asserting the
 * barrel line is present is sufficient to guard the integration point.
 */
import fs from 'fs';
import path from 'path';

import { describe, it, expect } from 'vitest';
import ts from 'typescript';

const BARREL = 'src/channels/index.ts';
const MODULE_SPECIFIER = './deltachat.js';

function barrelImports(): string[] {
  const p = path.resolve(process.cwd(), BARREL);
  const sf = ts.createSourceFile(p, fs.readFileSync(p, 'utf8'), ts.ScriptTarget.Latest, true);
  const specifiers: string[] = [];
  sf.forEachChild((node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text);
    }
  });
  return specifiers;
}

describe('deltachat channel registration', () => {
  it(`barrel imports ${MODULE_SPECIFIER} so the adapter self-registers`, () => {
    expect(barrelImports()).toContain(MODULE_SPECIFIER);
  });
});
