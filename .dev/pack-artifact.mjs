// Packs the Vite build into one self-contained page: the stylesheet, the body
// markup and the whole JS bundle inlined, with the document skeleton stripped
// (the Artifact host supplies <!doctype>/<html>/<head>/<body> itself).
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';

const html = readFileSync('dist/index.html', 'utf8');
const jsName = readdirSync('dist/assets').find((f) => f.endsWith('.js'));
const js = readFileSync(`dist/assets/${jsName}`, 'utf8');

const style = html.match(/<style>([\s\S]*?)<\/style>/)[1];
const body = html.match(/<body>([\s\S]*?)<\/body>/)[1]
  .replace(/<script[\s\S]*?<\/script>/g, '')
  .trim();

// A module script keeps top-level await and strict mode, and is deferred, so
// the DOM is parsed before the game boots.
const out = `<title>霓虹飞车 NEON DRIFT</title>
<style>
${style}
</style>

${body}

<script type="module">
${js}
</script>
`;

writeFileSync(process.argv[2] || 'dist/artifact.html', out);
console.log(`wrote ${(out.length / 1024).toFixed(0)} kB`);
