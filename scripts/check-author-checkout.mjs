#!/usr/bin/env node
import {checkAuthorCheckout} from './lib/author-checkout-preconditions.mjs';
import {isMainModule, parseArgv} from './lib/argv.mjs';

if (isMainModule(import.meta.url)) {
  try {
    const {values, helpRequested} = parseArgv(process.argv.slice(2), {
      root: {type: 'string'}, head: {type: 'string'}, upstream: {type: 'string'},
      bundle: {type: 'string'}, 'bundle-head': {type: 'string'},
    }, {allowPositionals: false, helpText: 'check-author-checkout.mjs --head <sha> --upstream https://github.com/craigoley/remudero.git [--root <path>] [--bundle <path> --bundle-head <sha>]: read-only setup diagnostic, NOT author assurance or execution authority'});
    if (!helpRequested) {
      if (Boolean(values.bundle) !== Boolean(values['bundle-head'])) throw new Error('both bundle path and bundle head are required');
      const report = checkAuthorCheckout(values.root ?? process.cwd(), {head: values.head, upstream: values.upstream,
        bundles: values.bundle ? [{path: values.bundle, head: values['bundle-head']}] : []});
      console.log(JSON.stringify(report, null, 2));
      process.exitCode = report.state === 'ready' ? 0 : report.state === 'blocked' ? 3 : 2;
    }
  } catch {
    console.error(JSON.stringify({state: 'unknown', executionAllowed: false, authorPass: false, error: 'checkout diagnostic unavailable'}));
    process.exitCode = 2;
  }
}
