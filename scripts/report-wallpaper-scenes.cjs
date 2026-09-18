const fs = require('node:fs');
const path = require('node:path');

const input = process.argv[2];
if (!input) throw new Error('Usage: node scripts/report-wallpaper-scenes.cjs <results.json> [report.md]');
const report = JSON.parse(fs.readFileSync(input, 'utf8'));
const output = process.argv[3] || path.join(path.dirname(input), 'report.md');
const escape = value => String(value || '').replace(/\|/g, '\\|').replace(/[\r\n\0]+/g, ' ');
const counts = report.results.reduce((out, r) => { out[r.status] = (out[r.status] || 0) + 1; return out; }, {});
const lines = [
  '# Scene Wallpaper Load Report', '',
  `- Started: ${report.startedAt}`,
  `- Finished: ${report.finishedAt || 'Incomplete'}`,
  `- URL: ${report.base}`,
  `- Tested: ${report.results.length}/${report.sceneCount}`,
  `- Passed: ${counts.passed || 0}; partial: ${counts.partial || 0}; failed: ${counts.failed || 0}; visual warnings: ${counts['visual-warning'] || 0}`,
  '- Scope: sequential browser loads, asset requests, WebGL shader errors, sampled pixels and 2.5 seconds of playback.',
  '- A pass does not establish visual equivalence with Wallpaper Engine. A failure records the first blocking error, not every unsupported feature.',
  '', '| # | Workshop ID | Wallpaper | Status | First Error |', '| ---: | --- | --- | --- | --- |',
  ...report.results.map((r, i) => `| ${i + 1} | ${escape(r.workshopId)} | ${escape(r.title)} | ${r.status} | ${escape(r.error || r.warning || r.compatibilityWarnings?.join('; '))} |`), '',
];
fs.writeFileSync(output, lines.join('\n'));
console.log(output);
